'use strict';
/**
 * usb - writes a text file to the first USB stick that accepts it.
 *
 * Looks in the folders where a head unit mounts sticks (/media, /run/media,
 * /mnt and one level below each) and tries each mounted folder in turn.
 * Only the report file is written; nothing else on the stick is touched.
 *
 *   saveToUsb(fileName, text) -> Promise<{ ok, where, tried }>
 */
const fs = require('fs');
const path = require('path');

const MOUNT_ROOTS = ['/media', '/run/media', '/mnt'];

function list(dir) {
    return new Promise((resolve) => fs.readdir(dir, (err, names) => resolve(err ? [] : names.map((n) => path.join(dir, n)))));
}

function isDir(p) {
    return new Promise((resolve) => fs.stat(p, (err, st) => resolve(!err && st.isDirectory())));
}

function write(file, text) {
    return new Promise((resolve) => fs.writeFile(file, text, 'utf8', (err) => resolve(!err)));
}

/* Candidate folders: each mount root's subfolders and theirs. */
function candidates() {
    return MOUNT_ROOTS.reduce((p, root) => p.then((acc) => list(root).then((subs) =>
        subs.reduce((q, s) => q.then((a) => isDir(s).then((d) => {
            if (!d) {
                return a;
            }
            return list(s).then((inner) => {
                a.push(s);
                return inner.reduce((r, i) => r.then((b) => isDir(i).then((di) => {
                    if (di) {
                        b.push(i);
                    }
                    return b;
                })), Promise.resolve(a));
            });
        })), Promise.resolve(acc)))), Promise.resolve([]));
}

function saveToUsb(fileName, text) {
    return candidates().then((dirs) => {
        const tried = [];
        return dirs.reduce((p, d) => p.then((done) => {
            if (done) {
                return done;
            }
            tried.push(d);
            const target = path.join(d, fileName);
            return write(target, text).then((ok) => (ok ? target : null));
        }), Promise.resolve(null)).then((where) => ({ ok: !!where, where, tried }));
    });
}

module.exports = { saveToUsb, MOUNT_ROOTS };
