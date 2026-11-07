'use strict';
/**
 * iface - one interface's fields, read from the head unit's SOME/IP
 * catalogue (/etc/oap/someip/someip-interfaces.json) without parsing it
 * whole (src/catalog.js indexObject).
 *
 *   readInterface({ name, file }) -> Promise<{ found, instance, fields: [{ name, get, notify }], error? }>
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
            resolve({ found: true, instance: Array.isArray(inst) ? String(inst[0]) : (inst ? String(inst) : '1'), fields });
        } catch (e) {
            resolve({ found: false, fields: [], error: e.message });
        }
    }));
}

module.exports = { readInterface };
