'use strict';
/**
 * catalog - reads the head unit's SOME/IP interface catalogue
 * (/etc/oap/someip/someip-interfaces.json) and reports the interfaces that
 * have seat-heating or steering-wheel-heating parts: for each, its fields
 * (with getter / setter / notifier), methods (with their arguments) and
 * events, each value's data type spelled out from the catalogue's
 * datatypes.
 *
 * The catalogue can be tens of MB, so it is not parsed whole: one pass
 * indexes where each top-level entry, each interface and each data type
 * sits in the text, and only those needed are parsed, one at a time.
 *
 * Read-only. Node 8 compatible.
 *
 *   readCatalog({ file }) -> Promise<{ file, bytes, ms, interfaces: [Iface], total, error? }>
 *   Iface: { name, serviceId, instance, whole (every member listed, the
 *            interface's own name being about heating), members: [Member] }
 *   Member: { kind: 'field' | 'method' | 'event', name, flags ('get set notify'
 *            for a field), type (text), raw (the catalogue entry, compact) }
 */
const fs = require('fs');

const FILE = '/etc/oap/someip/someip-interfaces.json';
const HEAT = /seat[\s_-]?heat|seatheat|steering[\s_-]?wheel[\s_-]?(heat|clim)|wheel[\s_-]?heat|heatingstate/i;
const TYPE_TEXT_MAX = 900;
const RAW_MAX = 1200;
const ENUM_ITEMS = 16;

/* ---- the index: where each child of a JSON object or array sits ---- */

/* The end (exclusive) of the string starting at text[i] === '"'. */
function stringEnd(text, i) {
    for (let j = i + 1; j < text.length; j++) {
        const c = text.charCodeAt(j);
        if (c === 92) {                 // backslash: skip the escaped character
            j++;
        } else if (c === 34) {
            return j + 1;
        }
    }
    throw new Error('unterminated string');
}

/* The end (exclusive) of the value starting at text[i]. */
function valueEnd(text, i) {
    const c = text.charCodeAt(i);
    if (c === 34) {
        return stringEnd(text, i);
    }
    if (c === 123 || c === 91) {        // { or [
        let depth = 0;
        for (let j = i; j < text.length; j++) {
            const d = text.charCodeAt(j);
            if (d === 34) {
                j = stringEnd(text, j) - 1;
            } else if (d === 123 || d === 91) {
                depth++;
            } else if (d === 125 || d === 93) {
                depth--;
                if (depth === 0) {
                    return j + 1;
                }
            }
        }
        throw new Error('unterminated object');
    }
    let j = i;
    while (j < text.length && ',}] \t\r\n'.indexOf(text[j]) < 0) {
        j++;
    }
    return j;
}

function skipSpace(text, i) {
    while (i < text.length && ' \t\r\n'.indexOf(text[i]) >= 0) {
        i++;
    }
    return i;
}

/* The members of the object starting at text[open] === '{': { key: [start, end] }. */
function indexObject(text, open) {
    const out = {};
    let i = skipSpace(text, open + 1);
    while (i < text.length && text[i] !== '}') {
        if (text[i] !== '"') {
            throw new Error('expected a key at ' + i);
        }
        const keyEnd = stringEnd(text, i);
        const key = JSON.parse(text.slice(i, keyEnd));
        i = skipSpace(text, keyEnd);
        if (text[i] !== ':') {
            throw new Error('expected : at ' + i);
        }
        i = skipSpace(text, i + 1);
        const end = valueEnd(text, i);
        out[key] = [i, end];
        i = skipSpace(text, end);
        if (text[i] === ',') {
            i = skipSpace(text, i + 1);
        }
    }
    return out;
}

/* ---- types ---- */

function makeTypes(text, index) {
    const cache = {};
    function get(ref) {
        if (typeof ref !== 'string' || !index[ref]) {
            return null;
        }
        if (!(ref in cache)) {
            try {
                cache[ref] = JSON.parse(text.slice(index[ref][0], index[ref][1]));
            } catch (e) {
                cache[ref] = null;
            }
        }
        return cache[ref];
    }
    /* A data type as text: structs with their members, enums with their items. */
    function describe(ref, depth, seen) {
        depth = depth || 0;
        seen = seen || [];
        const d = get(ref);
        if (!d) {
            return String(ref);
        }
        const short = String(ref).split('.').pop();
        if (seen.indexOf(ref) >= 0 || depth > 3) {
            return short;
        }
        const next = seen.concat([ref]);
        switch (d.type) {
            case 'struct': {
                let members = [];
                let dd = d;
                let hops = 0;
                while (dd && hops++ < 8) {
                    members = (dd.members || []).concat(members);
                    dd = dd.extends ? get(dd.extends) : null;
                }
                return short + ' {' + members.map((m) => m.name + ': ' + describe(m.dataRef || m.type, depth + 1, next)).join(', ') + '}';
            }
            case 'enum': {
                const items = d.items || {};
                const keys = Object.keys(items);
                return short + ' enum(' + keys.slice(0, ENUM_ITEMS).map((k) => k + '=' + items[k]).join(', ') +
                    (keys.length > ENUM_ITEMS ? ', …' : '') + ')';
            }
            case 'typedef':
                return describe(d.dataRef || d.baseType, depth, next);
            case 'array':
                return '[' + describe(d.elementDataRef || d.dataRef, depth + 1, next) + ']';
            default:
                return d.type ? short + ' (' + d.type + ')' : short;
        }
    }
    return { get, describe: (ref) => cut(describe(ref), TYPE_TEXT_MAX) };
}

function cut(s, max) {
    return s.length > max ? s.slice(0, max) + ' …' : s;
}

function compact(v) {
    try {
        return cut(JSON.stringify(v), RAW_MAX);
    } catch (e) {
        return String(v);
    }
}

/* A method's or event's arguments, wherever the entry keeps them: each
 * array of { name, dataRef } under the entry, as 'key: name: type, ...'. */
function args(entry, types) {
    const parts = [];
    Object.keys(entry || {}).forEach((k) => {
        const v = entry[k];
        if (Array.isArray(v) && v.length && v.every((a) => a && typeof a === 'object' && (a.dataRef || a.type))) {
            parts.push(k + ': ' + v.map((a) => (a.name || '?') + ': ' + types.describe(a.dataRef || a.type)).join(', '));
        }
    });
    if (entry && entry.dataRef) {
        parts.push(types.describe(entry.dataRef));
    }
    return parts.join(' | ') || '(no arguments)';
}

/* A field's flags: what the catalogue gives it. A getter or setter with id 0 counts as missing. */
function hasPart(p) {
    if (!p) {
        return false;
    }
    if (typeof p === 'object' && 'id' in p) {
        return !!p.id;
    }
    return true;
}

function fieldFlags(fd) {
    return ['getter', 'setter', 'notifier'].filter((k) => hasPart(fd && fd[k]))
        .map((k) => ({ getter: 'get', setter: 'set', notifier: 'notify' })[k]).join(' ') || 'none';
}

function members(iface, whole, types) {
    const out = [];
    // a member about heating by its name, or by its types (a request taking a seat-heating value)
    const take = (name, entry) => whole || HEAT.test(name) || HEAT.test(JSON.stringify(entry || ''));
    const fields = iface.fields || {};
    Object.keys(fields).forEach((n) => {
        if (take(n, fields[n])) {
            out.push({ kind: 'field', name: n, flags: fieldFlags(fields[n]), type: types.describe(fields[n].dataRef), raw: compact(fields[n]) });
        }
    });
    const methods = iface.methods || {};
    Object.keys(methods).forEach((n) => {
        if (take(n, methods[n])) {
            out.push({ kind: 'method', name: n, flags: 'call', type: args(methods[n], types), raw: compact(methods[n]) });
        }
    });
    const events = iface.events || iface.broadcasts || {};
    Object.keys(events).forEach((n) => {
        if (take(n, events[n])) {
            out.push({ kind: 'event', name: n, flags: 'event', type: args(events[n], types), raw: compact(events[n]) });
        }
    });
    return out;
}

function readCatalog(opts) {
    opts = opts || {};
    const file = opts.file || FILE;
    const started = Date.now();
    return new Promise((resolve) => fs.readFile(file, 'utf8', (err, text) => {
        if (err) {
            resolve({ file, bytes: 0, ms: 0, interfaces: [], total: 0, error: err.code === 'ENOENT' ? 'catalogue not found' : err.message });
            return;
        }
        try {
            const start = skipSpace(text, text.charCodeAt(0) === 0xfeff ? 1 : 0);
            const top = indexObject(text, start);
            if (!top.interfaces) {
                throw new Error('no "interfaces" in the catalogue');
            }
            const ifIndex = indexObject(text, top.interfaces[0]);
            const types = makeTypes(text, top.datatypes ? indexObject(text, top.datatypes[0]) : {});
            const instances = top.instanceIDs ? JSON.parse(text.slice(top.instanceIDs[0], top.instanceIDs[1])) : {};
            const names = Object.keys(ifIndex);
            const found = [];
            names.forEach((name) => {
                const r = ifIndex[name];
                const slice = text.slice(r[0], r[1]);
                if (!HEAT.test(slice) && !HEAT.test(name)) {
                    return;             // nothing about heating in it: not parsed
                }
                let iface;
                try {
                    iface = JSON.parse(slice);
                } catch (e) {
                    return;
                }
                const whole = HEAT.test(name);
                const ms = members(iface, whole, types);
                if (ms.length) {
                    found.push({ name, serviceId: iface.serviceId, instance: instances[name], whole, members: ms });
                }
            });
            resolve({ file, bytes: text.length, ms: Date.now() - started, interfaces: found, total: names.length });
        } catch (e) {
            resolve({ file, bytes: text.length, ms: Date.now() - started, interfaces: [], total: 0, error: e.message });
        }
    }));
}

/* Everything as text, one interface after another. */
function catalogText(result) {
    const lines = ['Catalogue: ' + result.file + ' (' + Math.round(result.bytes / 1024) + ' KB, ' + result.total + ' interfaces)'];
    result.interfaces.forEach((i) => {
        lines.push('', i.name + '  service ' + i.serviceId + '  instance ' + JSON.stringify(i.instance));
        i.members.forEach((m) => lines.push('  ' + m.kind + ' ' + m.name + ' [' + m.flags + '] = ' + m.type));
    });
    return lines.join('\n');
}

module.exports = { readCatalog, catalogText, indexObject, HEAT, FILE };
