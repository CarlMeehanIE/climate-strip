'use strict';
/**
 * iface - one interface's fields, read from the head unit's SOME/IP
 * catalogue (/etc/oap/someip/someip-interfaces.json) without parsing it
 * whole (src/catalog.js indexObject).
 *
 *   readInterface({ name, file }) -> Promise<{ found, instances, raw, fields: [{ name, get, notify }], events: [name], error? }>
 *
 * instances: the instance ids to try, in order: those the catalogue's
 * instanceIDs entry holds (plain values, or the values inside its records,
 * id-like keys first), then '1'. raw: that entry as compact JSON.
 *
 * Read-only. Node 8 compatible.
 */
const fs = require('fs');
const { indexObject, FILE } = require('./catalog.js');

function has(p) {
    if (!p) {
        return false;
    }
    if (typeof p === 'object' && 'id' in p) {
        return !!p.id;
    }
    return true;
}

/* The instance ids an instanceIDs entry holds, id-like keys first, then '1'. */
function candidates(entry) {
    const out = [];
    const add = (v) => {
        const s = String(v);
        if ((typeof v === 'string' || typeof v === 'number') && s && out.indexOf(s) < 0) {
            out.push(s);
        }
    };
    (function walk(v, depth) {
        if (v === null || v === undefined || depth > 4) {
            return;
        }
        if (Array.isArray(v)) {
            v.forEach((x) => walk(x, depth + 1));
        } else if (typeof v === 'object') {
            const keys = Object.keys(v);
            keys.filter((k) => /inst|^id$/i.test(k)).forEach((k) => walk(v[k], depth + 1));
            keys.filter((k) => !/inst|^id$/i.test(k)).forEach((k) => walk(v[k], depth + 1));
        } else {
            add(v);
        }
    })(entry, 0);
    add('1');
    return out;
}

function readInterface(opts) {
    const file = opts.file || FILE;
    return new Promise((resolve) => fs.readFile(file, 'utf8', (err, text) => {
        if (err) {
            resolve({ found: false, fields: [], error: err.code === 'ENOENT' ? 'catalogue not found' : err.message });
            return;
        }
        try {
            let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
            while (' \t\r\n'.indexOf(text[start]) >= 0) {
                start++;
            }
            const top = indexObject(text, start);
            const ifaces = top.interfaces ? indexObject(text, top.interfaces[0]) : {};
            const r = ifaces[opts.name];
            if (!r) {
                resolve({ found: false, fields: [], error: 'not in the catalogue' });
                return;
            }
            const iface = JSON.parse(text.slice(r[0], r[1]));
            const instances = top.instanceIDs ? JSON.parse(text.slice(top.instanceIDs[0], top.instanceIDs[1])) : {};
            const inst = instances[opts.name];
            const fields = Object.keys(iface.fields || {}).map((n) => ({
                name: n, get: has(iface.fields[n].getter), notify: has(iface.fields[n].notifier)
            }));
            let raw = '';
            try {
                raw = JSON.stringify(inst === undefined ? null : inst).slice(0, 200);
            } catch (e) {
                raw = String(inst);
            }
            const events = Object.keys(iface.events || iface.broadcasts || {});
            resolve({ found: true, instances: candidates(inst), raw, fields, events });
        } catch (e) {
            resolve({ found: false, fields: [], error: e.message });
        }
    }));
}

module.exports = { readInterface, candidates };
