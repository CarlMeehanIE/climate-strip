'use strict';
/* Offline check of mystrip-cleanup: only Climate Bar's names and comment go, everything else stays. */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const { cleaned } = require('./mystrip-cleanup');
assert.strictEqual(cleaned('fps = 30\n# Climate Bar (mystrip-bar) draws in the climate bar\noverlay_apps = mystrip-bar\n'), 'fps = 30\n');
assert.strictEqual(cleaned('# mine\noverlay_apps = iterio_overlays, mystrip-bar\nfps = 30\n'), '# mine\noverlay_apps = iterio_overlays\nfps = 30\n');
assert.strictEqual(cleaned('overlay_apps = a, mystrip_bar, b\n'), 'overlay_apps = a, b\n');
assert.strictEqual(cleaned('overlay_apps = iterio_overlays\nfps = 30\n'), null, 'nothing of ours: untouched');
assert.strictEqual(cleaned('overlay_apps = mystrip-barx\n'), null, 'only the exact names');
// the whole run, on a scratch file
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-'));
process.env.MYSTRIP_CLEANUP_CONF = path.join(T, 'local.conf');
process.env.MYSTRIP_CLEANUP_RESULT = path.join(T, 'result.txt');
fs.writeFileSync(process.env.MYSTRIP_CLEANUP_CONF, 'overlay_apps = other, mystrip-bar\n');
const { execFileSync } = require('child_process');   // the program itself, run as the car would (its shebang needs node at /usr/bin/node)
delete require.cache[require.resolve('./mystrip-cleanup')];
let ran = '';
try { ran = execFileSync('timeout', ['2', path.join(__dirname, 'mystrip-cleanup')], { env: process.env }).toString(); } catch (e) { ran = String(e.stdout); }
assert.ok(/removed Climate Bar/.test(ran), ran);
assert.strictEqual(fs.readFileSync(process.env.MYSTRIP_CLEANUP_CONF, 'utf8'), 'overlay_apps = other\n');
assert.ok(/removed Climate Bar/.test(fs.readFileSync(process.env.MYSTRIP_CLEANUP_RESULT, 'utf8')));
try { ran = execFileSync('timeout', ['2', path.join(__dirname, 'mystrip-cleanup')], { env: process.env }).toString(); } catch (e) { ran = String(e.stdout); }
assert.ok(/nothing to do/.test(ran), 'a second start changes nothing');
console.log('cleanup checks passed');
