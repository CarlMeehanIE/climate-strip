'use strict';
/**
 * scan - looks through the head unit's read-only system folders for the
 * SOME/IP interface catalogue and reports every entry about seat heating
 * and steering-wheel heating, plus the names of the climate and
 * steering-wheel interfaces it finds.
 *
 * Read-only: files are only opened for reading. Nothing is sent to the car.
 * Node 8 compatible (the head unit runs Node 8.16).
 *
 *   scan({ roots, onProgress }) -> Promise<{ files, scanned, matches, interfaces, errors, ms }>
 *
 * matches: [{ name, kind, file, path, text }]
 *   name  the field / method / key that matched
 *   kind  'entry' (a JSON key or object), 'line' (text around a match in a
 *         file too big to parse)
 *   text  the entry itself, as compact JSON or raw text (cut at TEXT_MAX)
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOTS = ['/etc/oap', '/etc/someip', '/etc', '/opt', '/usr/share'];
const SKIP_DIRS = new Set(['/proc', '/sys', '/dev', '/run', '/tmp', '/var', '/home', '/root', '/media', '/mnt']);
const EXTS = new Set(['.json', '.fidl', '.fdepl', '.xml', '.arxml', '.conf', '.txt', '.yaml', '.yml']);
const MAX_DEPTH = 7;
const MAX_FILES = 40000;                // files looked at (by name)
const PARSE_MAX = 6 * 1024 * 1024;      // JSON files up to this size are parsed whole
const FILE_MAX = 200 * 1024 * 1024;     // bigger files are skipped
const CHUNK = 256 * 1024;
const WINDOW = 700;                     // characters kept either side of a match in a streamed file
const TEXT_MAX = 2500;
const MAX_MATCHES = 600;
const MAX_INTERFACES = 300;

/* What counts as seat or steering-wheel heating (BMW names: statusSeatHeatingDR,
 * SteeringWheelClimate, heatingState, ...). */
const HEAT = /seat[\s_-]?heat|seatheat|seat[\s_-]?clim|seat[\s_-]?vent|steering[\s_-]?wheel[\s_-]?(heat|clim|comfort)|wheel[\s_-]?heat/i;
/* Interface ids worth listing by name. */
const IFACE = /^(de\.bmw|com\.harman|com\.bmw)[\w.]*(climate|clima|steeringwheel|seat|comfort)[\w.]*$/i;

function stat(p) {
    return new Promise((resolve) => fs.lstat(p, (err, st) => resolve(err ? null : st)));
}

function readdir(p) {
    return new Promise((resolve) => fs.readdir(p, (err, names) => resolve(err ? null : names)));
}

function readFile(p) {
    return new Promise((resolve, reject) => fs.readFile(p, 'utf8', (err, s) => (err ? reject(err) : resolve(s))));
}

function cut(s) {
    return s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) + ' …' : s;
}

function compact(v) {
    try {
        return cut(JSON.stringify(v));
    } catch (e) {
        return String(v);
    }
}

/* A short label for an object that matched through one of its strings. */
function nameOf(obj) {
    const keys = ['name', 'Name', 'shortName', 'ShortName', 'id', 'attribute', 'method', 'field', 'event'];
    for (let i = 0; i < keys.length; i++) {
        if (typeof obj[keys[i]] === 'string') {
            return obj[keys[i]];
        }
    }
    return null;
}

class Collector {
    constructor() {
        this.matches = [];
        this.seen = new Set();
        this.interfaces = new Set();
        this.full = false;
    }

    add(m) {
        const key = m.file + '\u0000' + m.path + '\u0000' + m.name;
        if (this.seen.has(key)) {
            return;
        }
        if (this.matches.length >= MAX_MATCHES) {
            this.full = true;
            return;
        }
        this.seen.add(key);
        this.matches.push(m);
    }

    iface(name) {
        if (this.interfaces.size < MAX_INTERFACES && IFACE.test(name)) {
            this.interfaces.add(name);
        }
    }

    /* Walks parsed JSON: a matching key reports that key's entry; an object
     * with a matching string value of its own reports the object, unless
     * its key already reported it. */
    walkJson(node, file, where, depth, reported) {
        if (this.full || depth > 40 || node === null || typeof node !== 'object') {
            return;
        }
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) {
                this.walkJson(node[i], file, where + '[' + i + ']', depth + 1);
            }
            return;
        }
        const keys = Object.keys(node);
        let own = null;
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const v = node[k];
            this.iface(k);
            if (typeof v === 'string') {
                this.iface(v);
                if (!own && HEAT.test(v)) {
                    own = v;
                }
            }
        }
        if (own && !reported) {
            this.add({ name: nameOf(node) || own, kind: 'entry', file, path: where, text: compact(node) });
        }
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const v = node[k];
            const keyHit = HEAT.test(k);
            if (keyHit) {
                this.add({ name: k, kind: 'entry', file, path: where + '.' + k, text: compact(v) });
            }
            if (v && typeof v === 'object') {
                // an entry already reported by its key is not reported again through its own strings
                this.walkJson(v, file, where + '.' + k, depth + 1, keyHit);
            }
        }
    }

    /* Plain text: each match with the text around it. */
    scanText(text, file, offset) {
        const re = new RegExp(HEAT.source, 'gi');
        let m;
        let last = -WINDOW * 2;
        while ((m = re.exec(text)) !== null && !this.full) {
            if (m.index - last < WINDOW) {
                continue;               // already inside the previous window
            }
            last = m.index;
            const from = Math.max(0, m.index - WINDOW);
            const to = Math.min(text.length, m.index + WINDOW);
            const word = /[\w.]*$/.exec(text.slice(Math.max(0, m.index - 60), m.index))[0] +
                /^[\w.]*/.exec(text.slice(m.index, m.index + 80))[0];
            this.add({ name: word || m[0], kind: 'line', file, path: '@' + (offset + m.index),
                text: cut(text.slice(from, to).replace(/\s+/g, ' ')) });
        }
        const ids = text.match(/(de\.bmw|com\.harman|com\.bmw)[\w.]+/g) || [];
        ids.forEach((id) => this.iface(id));
    }
}

/* A file too big to parse: read in chunks, overlapping by WINDOW. */
function streamFile(file, col) {
    return new Promise((resolve) => {
        let tail = '';
        let offset = 0;
        const rs = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: CHUNK });
        rs.on('data', (chunk) => {
            const text = tail + chunk;
            if (HEAT.test(text) || /(de\.bmw|com\.harman)/.test(text)) {
                col.scanText(text, file, offset - tail.length);
            }
            offset += chunk.length;
            tail = text.slice(-WINDOW);
            if (col.full) {
                rs.destroy();
                resolve();
            }
        });
        rs.on('error', () => resolve());
        rs.on('close', () => resolve());
        rs.on('end', () => resolve());
    });
}

function scanFile(file, size, col) {
    if (size <= PARSE_MAX) {
        return readFile(file).then((text) => {
            if (!HEAT.test(text) && !/(de\.bmw|com\.harman)/.test(text)) {
                return;
            }
            if (path.extname(file) === '.json') {
                try {
                    col.walkJson(JSON.parse(text), file, '$', 0);
                    return;
                } catch (e) {
                    /* not valid JSON: read it as text */
                }
            }
            col.scanText(text, file, 0);
        }, () => undefined);
    }
    return streamFile(file, col);
}

/* Lists the candidate files under the roots, breadth first, symlinks not followed. */
function listFiles(roots, out, onProgress) {
    const queue = roots.map((r) => ({ dir: r, depth: 0 }));
    const visited = new Set();
    let looked = 0;
    function next() {
        if (!queue.length || looked >= MAX_FILES) {
            return Promise.resolve();
        }
        const item = queue.shift();
        if (visited.has(item.dir) || (item.depth > 0 && SKIP_DIRS.has(item.dir)) || /iteriodev/i.test(item.dir)) {
            return next();
        }
        visited.add(item.dir);
        return readdir(item.dir).then((names) => {
            if (!names) {
                return next();
            }
            return names.reduce((p, n) => p.then(() => {
                const full = path.join(item.dir, n);
                return stat(full).then((st) => {
                    if (!st || st.isSymbolicLink()) {
                        return;
                    }
                    looked++;
                    if (st.isDirectory() && item.depth < MAX_DEPTH) {
                        queue.push({ dir: full, depth: item.depth + 1 });
                    } else if (st.isFile() && EXTS.has(path.extname(n).toLowerCase()) && st.size > 0 && st.size <= FILE_MAX) {
                        out.push({ file: full, size: st.size });
                    }
                });
            }), Promise.resolve()).then(() => {
                if (onProgress) {
                    onProgress({ phase: 'listing', files: out.length });
                }
                return next();
            });
        });
    }
    return next();
}

function scan(opts) {
    opts = opts || {};
    const roots = opts.roots || DEFAULT_ROOTS;
    const onProgress = opts.onProgress;
    const started = Date.now();
    const col = new Collector();
    const files = [];
    let scanned = 0;
    return listFiles(roots, files, onProgress).then(() => {
        // a dedicated someip folder first: the catalogue is usually there
        files.sort((a, b) => Number(/someip/i.test(b.file)) - Number(/someip/i.test(a.file)));
        const seenFiles = new Set();
        return files.reduce((p, f) => p.then(() => {
            if (col.full || seenFiles.has(f.file)) {
                return;
            }
            seenFiles.add(f.file);
            return scanFile(f.file, f.size, col).then(() => {
                scanned++;
                if (onProgress && scanned % 50 === 0) {
                    onProgress({ phase: 'reading', files: files.length, scanned, matches: col.matches.length });
                }
            });
        }), Promise.resolve());
    }).then(() => ({
        files: files.length,
        scanned,
        matches: col.matches,
        full: col.full,
        interfaces: Array.from(col.interfaces).sort(),
        ms: Date.now() - started
    }));
}

/* The plain-text report written to the data folder and the USB stick. */
function report(result, info) {
    const lines = [];
    lines.push('Signal Finder report');
    lines.push('Written: ' + new Date().toISOString());
    Object.keys(info || {}).forEach((k) => lines.push(k + ': ' + info[k]));
    lines.push('Files found: ' + result.files + ', read: ' + result.scanned + ', time: ' + Math.round(result.ms / 1000) + ' s');
    lines.push('Matches: ' + result.matches.length + (result.full ? ' (limit reached)' : ''));
    lines.push('');
    lines.push('== Climate / seat / steering-wheel interfaces seen ==');
    result.interfaces.forEach((i) => lines.push(i));
    lines.push('');
    lines.push('== Heating entries ==');
    result.matches.forEach((m, i) => {
        lines.push('');
        lines.push('#' + (i + 1) + ' ' + m.name);
        lines.push('file: ' + m.file + '  at: ' + m.path);
        lines.push(m.text);
    });
    lines.push('');
    return lines.join('\n');
}

module.exports = { scan, report, HEAT, IFACE, DEFAULT_ROOTS };
