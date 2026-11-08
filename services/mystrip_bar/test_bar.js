'use strict';
/**
 * Offline check of the Climate Bar service (mystrip-bar) against a stand-in
 * mgu-render (the native dialect on a socket), a stand-in Climate Strip on
 * its link socket, and its files in a scratch folder: overlay_apps added to
 * the renderer's local settings with every other line kept (once), the
 * placement over the climate bar, the claims, the buttons' colours following
 * the car, a tap on a button sent to Climate Strip, line-up (a tap selects,
 * moves are saved), turning the bar off (no claims, hidden), frames at least
 * every second, and safe mode on the third quick start.
 *
 *   node services/mystrip_bar/test_bar.js [preview.json]
 *
 * With a file name, the frames drawn (car off, car on, line-up) are written
 * there as JSON for tools/preview_bar.js.
 */
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'bar-'));
const env = {
    MYSTRIP_BAR_DIR: path.join(T, 'state'), MYSTRIP_BAR_RENDER: path.join(T, 'render.sock'),
    MYSTRIP_BAR_LOCAL_CONF: path.join(T, 'mgu-render', 'mgu-render.local.conf'), MYSTRIP_BAR_LINK: path.join(T, 'bar.sock'),
    MYSTRIP_BAR_PROC: path.join(T, 'proc'), MYSTRIP_BAR_GROUP: path.join(T, 'group'), MYSTRIP_BAR_HEALTHY_MS: '400'
};
Object.assign(process.env, env);
['state', 'mgu-render', 'proc/1', 'proc/77'].forEach((d) => fs.mkdirSync(path.join(T, d), { recursive: true }));
fs.writeFileSync(path.join(T, 'proc/1/comm'), 'systemd\n');
fs.writeFileSync(path.join(T, 'proc/77/comm'), 'mgu-render\n');
const old = new Date(Date.now() - 3600e3);
fs.utimesSync(path.join(T, 'proc/77'), old, old);
fs.writeFileSync(env.MYSTRIP_BAR_LOCAL_CONF, '# mine\nfps = 30\noverlay_apps = other_app\n');
fs.writeFileSync(env.MYSTRIP_BAR_GROUP, 'root:x:0:\ntm_oap_app:x:12202:\n');

const BAR = require('./mystrip-bar');

/* ---- a stand-in renderer ---- */
const R = { msgs: [], peer: null };
const server = net.createServer((c) => {
    R.peer = c;
    let buf = Buffer.alloc(0);
    c.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 8) {
            const type = buf.readUInt32LE(0), len = buf.readUInt32LE(4);
            if (buf.length < 8 + len) { break; }
            const p = buf.slice(8, 8 + len);
            buf = buf.slice(8 + len);
            R.msgs.push({ type, p, at: Date.now() });
            if (type === 1) {
                const x = Buffer.alloc(52); x.writeUInt32LE(1, 0); x.writeUInt32LE(1, 4);
                c.write(frame(0x4d520101, x));
                const r = Buffer.alloc(16); [4, 2880, 960, 1].forEach((v, i) => r.writeUInt32LE(v, i * 4));
                c.write(frame(101, r));
            }
        }
    });
    c.on('error', () => {});
});
function frame(type, p) { const h = Buffer.alloc(8); h.writeUInt32LE(type, 0); h.writeUInt32LE(p.length, 4); return Buffer.concat([h, p]); }
function touch(phase, x, y) {
    const p = Buffer.alloc(12); p.writeUInt32LE(phase, 0); p.writeFloatLE(x, 4); p.writeFloatLE(y, 8);
    R.peer.write(frame(105, p));
}
const lastOf = (type) => R.msgs.filter((m) => m.type === type).pop();
const claims = () => {
    const m = lastOf(9);
    const n = m.p.readUInt32LE(0), out = [];
    for (let i = 0; i < n; i++) { out.push([0, 1, 2, 3].map((k) => m.p.readFloatLE(4 + i * 16 + k * 4))); }
    return out;
};
/* The colours a frame's ops draw with (RRECT, RSTROKE, LINE, ARC), and the ops themselves for the preview. */
function decode(p) {
    const ops = [];
    let i = 0;
    const u = () => { const v = p.readUInt32LE(i); i += 4; return v; };
    const f = () => { const v = p.readFloatLE(i); i += 4; return v; };
    while (i < p.length) {
        const op = u();
        if (op === 1) { ops.push({ op: 'clear', c: u() }); } else if (op === 4) { ops.push({ op: 'rrect', a: [f(), f(), f(), f(), f()], c: u() }); } else if (op === 5) { ops.push({ op: 'rstroke', a: [f(), f(), f(), f(), f(), f()], c: u() }); } else if (op === 9) { ops.push({ op: 'line', a: [f(), f(), f(), f(), f()], c: u() }); } else if (op === 8) {
            const a = [f(), f(), f(), f(), f(), f()]; const c = u(); u(); u(); f(); f(); ops.push({ op: 'ring', a, c });
        } else if (op === 18) { ops.push({ op: 'image', a: [f(), f(), f(), f(), f()], id: u() }); } else { throw new Error(`op ${op} at ${i - 4}`); }
    }
    return ops;
}
const icons = (ops) => ops.filter((o) => o.op === 'image').map((o) => o.id);
const patches = (ops) => ops.filter((o) => o.op === 'rrect' && o.c !== 0xe5322dff && o.c !== 0x5f6268ff);
const I = BAR.IMG;

/* ---- a stand-in Climate Strip ---- */
function strip() {
    const s = { got: [], c: net.createConnection(env.MYSTRIP_BAR_LINK) };
    let buf = '';
    s.c.setEncoding('utf8');
    s.c.on('data', (d) => {
        buf += d;
        let at;
        while ((at = buf.indexOf('\n')) >= 0) { s.got.push(JSON.parse(buf.slice(0, at))); buf = buf.slice(at + 1); }
    });
    s.send = (m) => s.c.write(JSON.stringify(m) + '\n');
    s.status = () => s.got.filter((m) => m.status).pop().status;
    return s;
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
async function until(pred, what) {
    for (let i = 0; i < 300; i++) { if (pred()) { return; } await tick(10); }
    throw new Error(`timed out waiting for ${what}`);
}

(async () => {
    await new Promise((r) => server.listen(env.MYSTRIP_BAR_RENDER, r));
    const preview = {};
    let bar = new BAR.Bar();
    bar.start();

    // overlay_apps: ours added beside the other app's, the other lines kept; the renderer must restart
    assert.strictEqual(fs.readFileSync(env.MYSTRIP_BAR_LOCAL_CONF, 'utf8'), '# mine\nfps = 30\noverlay_apps = other_app, mystrip-bar\n');
    assert.strictEqual(bar.overlay, 'restart');

    // placed over the climate bar, three claims, shown
    await until(() => lastOf(7), 'a frame');
    const hello = R.msgs[0].p.toString();
    assert.strictEqual(hello.split('\0')[0], 'mystrip-bar');
    assert.ok(/proto=mgu-render\/1/.test(hello));
    assert.strictEqual(lastOf(0x4d520001).p.readUInt32LE(0), 1, 'layer mode');
    const pl = lastOf(2).p;
    assert.deepStrictEqual([0, 1, 2, 3].map((k) => pl.readInt32LE(k * 4)), [0, 840, 2880, 120]);
    assert.deepStrictEqual(claims(), [[919.5, 0, 101, 120], [2494.5, 0, 101, 120], [2669.5, 0, 101, 120]]);
    assert.strictEqual(lastOf(3).p.readUInt32LE(0), 1, 'shown');
    const uploads = R.msgs.filter((m) => m.type === 10);
    assert.deepStrictEqual(uploads.map((m) => m.p.readUInt32LE(0)).sort(), [1, 2, 3, 4, 5, 6, 7, 8], 'the icons uploaded');
    uploads.forEach((m) => assert.strictEqual(m.p.length, 12 + 128 * 128 * 4));
    const lit = (id) => { const p = BAR.iconPictures()[id]; let red = 0; for (let i = 0; i < p.length; i += 4) { if (p[i] > 150 && p[i + 1] < 80) { red++; } } return red; };
    assert.strictEqual(lit(I.seat[0]), 0, 'an off seat has no red');
    assert.ok(lit(I.seat[3]) > 500, 'a seat that is on is red');
    assert.ok(lit(I.wheelOn) > 0 && lit(I.wheelOff) === 0);

    // Climate Strip: told the status; car unknown is dim, off grey, on red
    const s = strip();
    await until(() => s.got.some((m) => m.status && m.status.renderer === 'connected'), 'status');
    assert.strictEqual(s.status().overlay, 'restart');
    // auto: the seats drawn except at BMW's very high, where BMW's own indicator shows; no patch; the wheel always
    assert.deepStrictEqual(icons(decode(lastOf(7).p)), [I.seatUnknown, I.seatUnknown, I.wheelUnknown], 'unknown: dim');
    assert.deepStrictEqual(patches(decode(lastOf(7).p)), [], 'no patch');
    s.send({ car: { dr: { level: 4, stage: 3 }, ps: { level: 2, stage: 2 }, wheel: false } });
    await until(() => icons(decode(lastOf(7).p)).join() === [I.seat[3], I.wheelOff].join(), 'very high: BMW\'s own, ours left out');
    const meter = (ops) => ops.filter((o) => o.op === 'rrect' && (o.c === 0xe5322dff || o.c === 0x5f6268ff)).map((o) => (o.c === 0xe5322dff ? 1 : 0));
    assert.deepStrictEqual(meter(decode(lastOf(7).p)), [1, 1, 0, 0, 1, 1, 1, 1, 0], 'medium: two of four segments; very high: all four, under BMW\'s icon; the wheel off: grey');
    assert.strictEqual(claims().length, 3, 'still tappable at very high');
    s.send({ cmd: 'seats' });
    await until(() => s.status().settings.seats === 'drawn', 'seats always drawn');
    await until(() => icons(decode(lastOf(7).p)).join() === [I.seat[3], I.seat[3], I.wheelOff].join(), 'drawn at very high too');
    assert.deepStrictEqual(meter(decode(lastOf(7).p)), [1, 1, 0, 0, 1, 1, 1, 1, 0], 'very high: all four bars');
    s.send({ cmd: 'seats' });
    await until(() => icons(decode(lastOf(7).p)).join() === [I.wheelOff].join(), 'invisible: never drawn');
    s.send({ cmd: 'seats' });
    s.send({ cmd: 'seats' });
    await until(() => s.status().settings.seats === 'drawn', 'round to drawn');
    s.send({ car: { dr: null, ps: null, wheel: null } });
    await until(() => icons(decode(lastOf(7).p)).join() === [I.seatUnknown, I.seatUnknown, I.wheelUnknown].join(), 'unknown again');
    const img = decode(lastOf(7).p).filter((o) => o.op === 'image')[0].a;
    assert.deepStrictEqual(img, [970 - 36, 24, 72, 72, 0], 'the passenger seat centred on its spot, its level bar under it');
    const bars = decode(lastOf(7).p).filter((o) => o.op === 'rrect');
    assert.ok(bars.every((o) => o.a[4] === 0), 'square corners');
    const wheelBar = bars[bars.length - 1].a;
    assert.ok(Math.abs(wheelBar[2] - 72 * 0.9) < 0.01, 'the wheel: one solid bar, the full width');
    const segs = bars.slice(0, 4).map((o) => o.a);
    assert.ok(segs.every((a, i) => a[1] > 60 + 36 && a[1] + a[3] <= 120 && (i === 0 || a[0] > segs[i - 1][0] + segs[i - 1][2])), 'four segments under the icon, in the bar, with gaps');
    s.send({ cmd: 'cover' });
    await until(() => patches(decode(lastOf(7).p)).length === 2, 'a patch behind each drawn seat, none behind the wheel');
    s.send({ cmd: 'cover' });
    s.send({ car: { dr: { level: 0, stage: 0 }, ps: { level: 0, stage: 0 }, wheel: false } });
    await until(() => icons(decode(lastOf(7).p)).join() === [I.seat[0], I.seat[0], I.wheelOff].join(), 'off');
    assert.deepStrictEqual(meter(decode(lastOf(7).p)), [0, 0, 0, 0, 0, 0, 0, 0, 0], 'off: no bars lit');
    preview.off = decode(lastOf(7).p);
    s.send({ car: { dr: { level: 4, stage: 3 }, ps: { level: 1, stage: 1 }, wheel: true } });
    await until(() => icons(decode(lastOf(7).p)).join() === [I.seat[3], I.seat[3], I.wheelOn].join(), 'on');
    assert.deepStrictEqual(meter(decode(lastOf(7).p)), [1, 0, 0, 0, 1, 1, 1, 1, 1], 'low and very high; the wheel on: its one bar');
    s.send({ car: { dr: { level: 4, stage: 0 }, ps: { level: null, stage: null }, wheel: null } });
    await until(() => icons(decode(lastOf(7).p)).join() === [I.seatUnknown, I.seat[3], I.wheelUnknown].join(), 'BMW\'s level when the stage says 0');
    s.send({ car: { dr: { level: null, stage: 2 }, ps: { level: 3, stage: 0 }, wheel: false } });
    await until(() => meter(decode(lastOf(7).p)).join() === '1,1,1,0,1,1,0,0,0', 'the stage when BMW\'s level is unknown');
    s.send({ car: { dr: { level: 4, stage: 3 }, ps: { level: 1, stage: 1 }, wheel: true } });
    await until(() => icons(decode(lastOf(7).p)).join() === [I.seat[3], I.seat[3], I.wheelOn].join(), 'on again');
    preview.on = decode(lastOf(7).p);

    // a tap on the passenger's button goes to Climate Strip; one that slides off does not
    touch(1, 970, 60); touch(3, 975, 62);
    await until(() => s.got.some((m) => m.tap), 'a tap');
    assert.deepStrictEqual(s.got.filter((m) => m.tap), [{ tap: 'ps' }]);
    touch(1, 2545, 60); touch(3, 2720, 60);
    await tick(50);
    assert.strictEqual(s.got.filter((m) => m.tap).length, 1, 'a slide between buttons is no tap');
    touch(1, 2720, 60); touch(3, 2720, 60);
    await until(() => s.got.filter((m) => m.tap).length === 2, 'the wheel');
    assert.deepStrictEqual(s.got.filter((m) => m.tap).pop(), { tap: 'wheel' });

    // line-up: a tap selects, a move is saved and claims follow
    s.send({ cmd: 'lineup', on: true });
    await until(() => s.status().lineup, 'line-up on');
    touch(1, 2545, 60); touch(3, 2545, 60);
    await until(() => s.status().selected === 'dr', 'a tap selects in line-up');
    assert.strictEqual(s.got.filter((m) => m.tap).length, 2, 'no tap sent while lining up');
    preview.lineup = decode(lastOf(7).p);
    s.send({ cmd: 'move', dx: -1 });
    s.send({ cmd: 'step' });
    s.send({ cmd: 'move', dy: 1 });
    await until(() => s.status().settings.items.dr.y === 902, 'moved');
    assert.deepStrictEqual(s.status().settings.items.dr, { x: 2535, y: 902 });
    assert.deepStrictEqual(claims()[1], [2484.5, 0, 101, 120]);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(env.MYSTRIP_BAR_DIR, 'settings.json'), 'utf8')).items.dr, { x: 2535, y: 902 });
    s.send({ cmd: 'move', dx: 99999 });
    await until(() => s.status().settings.items.dr.x === 2537, 'a move is one step whatever it asks');

    // frames keep coming
    const n = R.msgs.filter((m) => m.type === 7).length;
    await tick(1100);
    assert.ok(R.msgs.filter((m) => m.type === 7).length >= n + 2, 'a frame at least every 500 ms');

    // off: hidden, no claims, taps ignored
    s.send({ cmd: 'enable', on: false });
    await until(() => claims().length === 0 && lastOf(3).p.readUInt32LE(0) === 0, 'off');
    touch(1, 970, 60); touch(3, 970, 60);
    await tick(50);
    assert.strictEqual(s.got.filter((m) => m.tap).length, 2);
    s.send({ cmd: 'enable', on: true });
    await until(() => claims().length === 3, 'on again');
    s.send({ cmd: 'reset' });
    await until(() => s.status().settings.items.dr.x === 2545, 'reset');
    assert.strictEqual(s.status().settings.seats, 'drawn', 'reset keeps how the seats show');

    // ran long enough: strikes cleared; the second start leaves overlay_apps alone and is set
    await tick(500);
    assert.strictEqual(fs.readFileSync(path.join(env.MYSTRIP_BAR_DIR, 'strikes'), 'utf8'), '0\n');
    bar.stop();
    s.c.destroy();

    // three quick starts: safe mode, nothing shown or claimed, until turned on
    const confBefore = fs.readFileSync(env.MYSTRIP_BAR_LOCAL_CONF, 'utf8');
    fs.utimesSync(env.MYSTRIP_BAR_LOCAL_CONF, old, old);
    for (let i = 0; i < 2; i++) { const b = new BAR.Bar(); b.start(); assert.strictEqual(b.safe, false); assert.strictEqual(b.overlay, 'set'); b.stop(); }
    assert.strictEqual(fs.readFileSync(env.MYSTRIP_BAR_LOCAL_CONF, 'utf8'), confBefore, 'overlay_apps added once');
    R.msgs = [];
    bar = new BAR.Bar();
    bar.start();
    assert.strictEqual(bar.safe, true, 'third quick start: safe');
    await until(() => lastOf(3), 'show sent');
    assert.strictEqual(lastOf(3).p.readUInt32LE(0), 0, 'hidden in safe mode');
    assert.deepStrictEqual(claims(), []);
    const s2 = strip();
    await until(() => s2.got.some((m) => m.status && m.status.safe), 'safe reported');
    s2.send({ cmd: 'enable', on: true });
    await until(() => claims().length === 3 && lastOf(3).p.readUInt32LE(0) === 1, 'on again after safe mode');
    assert.strictEqual(fs.readFileSync(path.join(env.MYSTRIP_BAR_DIR, 'strikes'), 'utf8'), '0\n');
    bar.stop();
    s2.c.destroy();

    // no renderer folder: said so, nothing written
    fs.rmSync(path.join(T, 'mgu-render'), { recursive: true });
    assert.strictEqual(BAR.ensureOverlay(env.MYSTRIP_BAR_LOCAL_CONF, 'mystrip-bar'), 'no renderer');
    assert.ok(!fs.existsSync(path.join(T, 'mgu-render')));

    if (process.argv[2]) { fs.writeFileSync(process.argv[2], JSON.stringify(preview)); }
    server.close();
    console.log('Climate Bar checks passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
