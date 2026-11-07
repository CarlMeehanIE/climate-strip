'use strict';
/**
 * types - the catalogue's data types and interface entries, read on demand
 * from /etc/oap/someip/someip-interfaces.json (src/catalog.js indexObject),
 * and the values Heat Test sends built from them.
 *
 *   loadCatalog({ file }) -> Promise<Cat>
 *   Cat.type(ref)          the datatype entry, or null
 *   Cat.iface(name)        the interface entry, or null
 *   Cat.members(ref)       a struct's members, its parents' first: [{ name, dataRef }]
 *   Cat.fill(ref, pick)    a value of type ref: pick(path, type, ref) may return a
 *                          value for a member; otherwise enums take KEINE_AKTION
 *                          (no action) when they have it, else their item 0;
 *                          numbers 0, Bool false, structs their members, arrays
 *                          their minimum length
 *   Cat.numeric(value, ref) the same value with enum names turned into numbers
 *
 * Read-only. Node 8 compatible.
 */
const fs = require('fs');
const { indexObject, FILE } = require('./catalog.js');

function loadCatalog(opts) {
    const file = (opts && opts.file) || FILE;
    return new Promise((resolve, reject) => fs.readFile(file, 'utf8', (err, text) => {
        if (err) {
            reject(err);
            return;
        }
        try {
            let start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
            while (' \t\r\n'.indexOf(text[start]) >= 0) {
                start++;
            }
            const top = indexObject(text, start);
            const ifIndex = top.interfaces ? indexObject(text, top.interfaces[0]) : {};
            const tIndex = top.datatypes ? indexObject(text, top.datatypes[0]) : {};
            const cache = {};
            const parse = (index, key) => {
                const k = (index === ifIndex ? 'i:' : 't:') + key;
                if (!(k in cache)) {
                    try {
                        cache[k] = index[key] ? JSON.parse(text.slice(index[key][0], index[key][1])) : null;
                    } catch (e) {
                        cache[k] = null;
                    }
                }
                return cache[k];
            };
            resolve(makeCat((ref) => parse(tIndex, ref), (name) => parse(ifIndex, name)));
        } catch (e) {
            reject(e);
        }
    }));
}

function makeCat(type, iface) {
    /* A typedef's target, followed to the end. */
    function resolveRef(ref) {
        let d = type(ref);
        let hops = 0;
        while (d && d.type === 'typedef' && hops++ < 8) {
            ref = d.dataRef || d.baseType;
            d = type(ref);
        }
        return { ref, d };
    }

    function members(ref) {
        let out = [];
        let d = resolveRef(ref).d;
        let hops = 0;
        while (d && hops++ < 8) {
            out = (d.members || []).concat(out);
            d = d.extends ? type(d.extends) : null;
        }
        return out;
    }

    function fill(ref, pick, path) {
        path = path || '';
        const r = resolveRef(ref);
        const d = r.d;
        const chosen = pick ? pick(path, d, r.ref) : undefined;
        if (chosen !== undefined) {
            return chosen;
        }
        if (!d) {
            return /bool/i.test(String(r.ref)) ? false : 0;     // a base type: UInt8, Bool, ...
        }
        if (d.type === 'struct') {
            const v = {};
            members(r.ref).forEach((m) => { v[m.name] = fill(m.dataRef || m.type, pick, path ? `${path}.${m.name}` : m.name); });
            return v;
        }
        if (d.type === 'enum') {
            const items = d.items || {};
            if ('KEINE_AKTION' in items) {
                return 'KEINE_AKTION';
            }
            const zero = Object.keys(items).find((k) => Number(items[k]) === 0);
            return zero || Object.keys(items)[0];
        }
        if (d.type === 'array') {
            const n = Number(d.arrayMinLength || 0);
            const out = [];
            for (let i = 0; i < n; i++) {
                out.push(fill(d.elementDataRef || d.dataRef, pick, `${path}[${i}]`));
            }
            return out;
        }
        return 0;
    }

    /* Enum names as their numbers, everywhere in value (typed by ref). */
    function numeric(value, ref) {
        const r = resolveRef(ref);
        const d = r.d;
        if (!d) {
            return value;
        }
        if (d.type === 'enum') {
            const items = d.items || {};
            return typeof value === 'string' && value in items ? Number(items[value]) : value;
        }
        if (d.type === 'struct' && value && typeof value === 'object') {
            const out = {};
            const ms = members(r.ref);
            Object.keys(value).forEach((k) => {
                const m = ms.find((x) => x.name === k);
                out[k] = m ? numeric(value[k], m.dataRef || m.type) : value[k];
            });
            return out;
        }
        if (d.type === 'array' && Array.isArray(value)) {
            return value.map((x) => numeric(x, d.elementDataRef || d.dataRef));
        }
        return value;
    }

    return { type, iface, members, fill, numeric, resolveRef };
}

module.exports = { loadCatalog, makeCat };
