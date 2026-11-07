'use strict';
/**
 * Offline check of the Signal Finder against stand-ins: the oap-sdk
 * (OnlineApp, logging), the RHMI (components from the generated
 * uiDescription.json) and a made-up head unit folder holding a small JSON
 * catalogue, a large one (streamed) and unrelated files. Checks the scan,
 * the screens it fills, a row press, Save report to USB, and that nothing
 * outside the data folder and the stick is written.
 *
 *   node tools/gen_rhmi.js && node tools/test_finder.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { ID8 } = require('./gen_rhmi.js');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'finder-test-'));
const APPDIR = path.join(ROOT, 'app', 'javascript');
const ETC = path.join(ROOT, 'etc');
const USB = path.join(ROOT, 'media');
fs.mkdirSync(path.join(ROOT, 'app'));
fs.mkdirSync(APPDIR);
['finder.js', 'scan.js', 'usb.js'].forEach((n) => fs.copyFileSync(path.join(__dirname, '..', 'src', n), path.join(APPDIR, n)));

/* The made-up head unit. */
fs.mkdirSync(path.join(ETC, 'oap', 'someip'), { recursive: true });
fs.mkdirSync(path.join(ETC, 'other'), { recursive: true });
const catalogue = {
    interfaces: {
        'de.bmw.infotainment.climate.Climate': {
            fields: {
                statusSeatHeatingDR: { getter: 101, notifier: 102, setter: 0, type: 'SeatHeatingStatus' },
                statusSeatHeatingPS: { getter: 103, notifier: 104, setter: 0, type: 'SeatHeatingStatus' },
                statusFanSpeed: { getter: 105 }
            },
            methods: [{ name: 'setSeatHeatingLevel', id: 7, in: [{ name: 'seat' }, { name: 'level' }] },
                { name: 'setTemperature', id: 8 }]
        },
        'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate': {
            fields: { heatingState: { getter: 1, setter: 2 } }
        },
        'de.bmw.infotainment.vehicle.Vehicle2': { fields: { statusCarSpeed2: { getter: 1 } } }
    }
};
fs.writeFileSync(path.join(ETC, 'oap', 'someip', 'someip-interfaces.json'), JSON.stringify(catalogue));
fs.writeFileSync(path.join(ETC, 'other', 'unrelated.json'), JSON.stringify({ hello: 'world' }));
fs.writeFileSync(path.join(ETC, 'other', 'binary.bin'), 'SeatHeating in a file type that is not read');
// a big catalogue: streamed, with a match deep inside and one across a chunk boundary
const pad = 'x'.repeat(1024 * 1024);
const big = [];
for (let i = 0; i < 8; i++) {
    big.push(pad);
}
big.splice(4, 0, ' de.bmw.infotainment.climate.Climate2 requestSteeringWheelHeating(level) ');
fs.writeFileSync(path.join(ETC, 'other', 'big-catalogue.fidl'), big.join(''));
// a symlink loop is not followed
fs.symlinkSync(ETC, path.join(ETC, 'other', 'loop'));
// the stick: a mounted folder under media
fs.mkdirSync(path.join(USB, 'usb0'), { recursive: true });

const writes = [];
const states = [];
class Comp extends EventEmitter {
    constructor(name, id) {
        super();
        this.name = name;
        this.id = id;
    }
    getId() { return this.id; }
    setValue(r, c, v) { writes.push(`${this.name}.${r}.${c}=${v}`); return Promise.resolve(); }
    setProperty(p, v) { writes.push(`${this.name}.${p}=${v}`); return Promise.resolve(); }
    setRowCount(n) { writes.push(`${this.name}.rows=${n}`); return Promise.resolve(); }
    updateResources() { return Promise.resolve(); }
}
const ui = JSON.parse(fs.readFileSync(path.join(ID8, 'uiDescription.json'), 'utf8'));
const byName = {};
Object.keys(ui.containers).forEach((cid) => {
    const c = ui.containers[cid];
    byName[c.name] = new Comp(c.name, cid);
    Object.keys(c.components).forEach((id) => { byName[c.components[id].name] = new Comp(c.components[id].name, id); });
});
class Rhmi extends EventEmitter {
    getByName(n) { return byName[n]; }
    openState(n) { states.push(`open ${n}`); return Promise.resolve(); }
    mapEntryState(uuid, st) { states.push(`map ${st.name}`); return Promise.resolve(); }
    openEntryState() { states.push('open entry'); return Promise.resolve(); }
}
const ENTRY = { uuid: 'e1', name: 'mystrip_finder' };
let app = null;
class OnlineApp extends EventEmitter {
    constructor() {
        super();
        app = this;
        this.rhmiApplication = new Rhmi();
        this.packageJson = { version: '0.1.0' };
        this.appDescription = { application: { entryPoints: [ENTRY] } };
        this.startReason = 'ENTRY_POINT';
    }
    getAppId() { return 'mystrip_finder'; }
    start() { return Promise.resolve(); }
    getEntryPoints() { return [{ getDescription: () => ENTRY, init: () => Promise.resolve(), setAvailability: () => Promise.resolve() }]; }
    registerActive() { return Promise.resolve(); }
    initialized() { this._initialized = true; return Promise.resolve(); }
}
const logged = [];
const quiet = { info(l) { logged.push(String(l)); }, warn(l) { logged.push(String(l)); }, error(l) { logged.push(String(l)); } };

/* scan.js and usb.js look in the made-up folders. */
const realScan = require(path.join(APPDIR, 'scan.js'));
const realUsb = require(path.join(APPDIR, 'usb.js'));
realUsb.MOUNT_ROOTS.splice(0, realUsb.MOUNT_ROOTS.length, USB);
const stubs = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => quiet },
    './scan.js': { scan: (o) => realScan.scan(Object.assign({}, o, { roots: [ETC] })), report: realScan.report },
    './usb.js': realUsb
};
const load = Module._load;
Module._load = function (req) {
    return stubs[req] || load.apply(this, arguments);
};
require(path.join(APPDIR, 'finder.js'));
Module._load = load;

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const last = (prefix) => writes.filter((w) => w.indexOf(prefix) === 0).pop();
async function until(pred, what) {
    for (let i = 0; i < 400; i++) {
        if (pred()) {
            return;
        }
        await tick(10);
    }
    throw new Error(`timed out waiting for ${what}\n${logged.join('\n')}`);
}

(async () => {
    app.emit('initialized');
    await until(() => logged.some((l) => /scan done/.test(l)), 'the scan');
    await tick(50);
    console.log(logged.filter((l) => /scan done/.test(l))[0]);

    // the matches: the catalogue's fields and method, the wheel, the streamed one; nothing from the unrelated files
    assert.ok(states.indexOf('map ST_OnlineApps_MyStripFinder') >= 0, 'entry state mapped');
    // the files: the catalogue first, each with its count
    const fileRows = writes.filter((w) => /^finderFileList\.\d+\.PrimaryText=/.test(w)).map((w) => w.split('=')[1]);
    console.log('files:', fileRows.join(' | '));
    assert.ok(/^4 · .*someip-interfaces\.json$/.test(fileRows[0]), 'catalogue first with its count');
    assert.ok(/^1 · .*big-catalogue\.fidl$/.test(fileRows[1]), 'the streamed file second');
    assert.strictEqual(fileRows.length, 2, 'two files');
    byName.finderFileList.emit('action', { row: 0 });
    await tick(20);
    assert.ok(states.indexOf('open ST_OnlineApps_MyStripFinderFile') >= 0, 'file page opened');
    assert.ok(/someip-interfaces\.json · 4 entries/.test(last('finderFilePath.0.Text')), 'file page heading');
    byName.finderFileList.emit('action', { row: 1 });
    await tick(20);
    const rows = writes.filter((w) => /^finder(Entry)List\.\d+\.PrimaryText=/.test(w)).map((w) => w.split('=')[1]);
    console.log('rows:', rows.join(' | '));
    ['statusSeatHeatingDR', 'statusSeatHeatingPS', 'setSeatHeatingLevel', 'SteeringWheelClimate', 'requestSteeringWheelHeating']
        .forEach((n) => assert.ok(rows.some((r) => r.indexOf(n) >= 0), `row for ${n}`));
    assert.strictEqual(new Set(rows).size, rows.length, 'no row twice');
    assert.ok(!rows.some((r) => /setTemperature|statusFanSpeed|hello/.test(r)), 'no unrelated rows');
    assert.ok(!writes.some((w) => /binary\.bin/.test(w)), 'unread file type left out');
    assert.ok(/5 heating entries in 2 files \(3 read\)/.test(last('finderStatus.0.Text')), 'status line: ' + last('finderStatus.0.Text'));
    assert.ok(!writes.some((w) => /FrequencyText/.test(w)), 'nothing in the second column');

    // interfaces by name
    const ifaces = writes.filter((w) => /^finderIfaceList\.\d+\.PrimaryText=/.test(w)).map((w) => w.split('=')[1]);
    assert.ok(/Interfaces found \(3\)/.test(last('finderIfaces.0.PrimaryText')), 'interface count');
    console.log('interfaces:', ifaces.join(' | '));
    ['de.bmw.infotainment.climate.Climate', 'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate',
        'de.bmw.infotainment.climate.Climate2'].forEach((i) => assert.ok(ifaces.indexOf(i) >= 0, `interface ${i}`));
    assert.ok(ifaces.indexOf('de.bmw.infotainment.vehicle.Vehicle2') < 0, 'vehicle interface left out');

    // back on the catalogue's page, a row press opens the entry in full
    byName.finderFileList.emit('action', { row: 0 });
    await tick(450);
    byName.finderFileList.emit('action', { row: 0 });
    await tick(20);
    const methodRow = ['statusSeatHeatingDR', 'statusSeatHeatingPS', 'setSeatHeatingLevel', 'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate']
        .indexOf('setSeatHeatingLevel');
    assert.strictEqual(last('finderEntryList.2.PrimaryText'), 'finderEntryList.2.PrimaryText=setSeatHeatingLevel');
    byName.finderEntryList.emit('action', { row: methodRow });
    await tick(20);
    assert.ok(states.indexOf('open ST_OnlineApps_MyStripFinderDetail') >= 0, 'detail opened');
    assert.ok(/"name":"setSeatHeatingLevel"/.test(last('finderDetailText.0.Text')), 'detail shows the entry');
    assert.ok(/someip-interfaces\.json/.test(last('finderDetailWhere.0.Text')), 'detail shows the file');

    // the raw userEvent path for the same press within 400 ms counts once
    const before = logged.filter((l) => /BUTTON ACTION finderEntryList/.test(l)).length;
    app.rhmiApplication.emit('userEvent', { eventType: 'ACTION', sourceId: byName.finderEntryList.id, parameterMap: { 2: methodRow } });
    assert.strictEqual(logged.filter((l) => /BUTTON ACTION finderEntryList/.test(l)).length, before, 'press counted once');

    // Save report to USB
    byName.finderSave.emit('action', {});
    await until(() => /Saved to/.test(last('finderStatus.0.Text') || ''), 'the save');
    const onStick = path.join(USB, 'usb0', 'signal-finder-report.txt');
    const text = fs.readFileSync(onStick, 'utf8');
    assert.ok(/== Heating entries ==/.test(text) && /setSeatHeatingLevel/.test(text) && /SteeringWheelClimate/.test(text), 'report content');
    assert.ok(fs.existsSync(path.join(ROOT, 'data', 'signal-finder-report.txt')), 'local copy in the data folder');

    // nothing else written: the made-up system folder is as it was
    const etcFiles = [];
    (function walk(d) {
        fs.readdirSync(d).forEach((n) => {
            const f = path.join(d, n);
            const st = fs.lstatSync(f);
            if (st.isDirectory()) { walk(f); } else { etcFiles.push(path.relative(ETC, f)); }
        });
    })(ETC);
    assert.deepStrictEqual(etcFiles.sort(), ['oap/someip/someip-interfaces.json', 'other/big-catalogue.fidl', 'other/binary.bin',
        'other/loop', 'other/unrelated.json'].sort(), 'system folder untouched');

    // no stick
    fs.rmSync(path.join(USB, 'usb0'), { recursive: true });
    await tick(450);                    // past the double-press guard
    byName.finderSave.emit('action', {});
    await until(() => /No USB stick found/.test(last('finderStatus.0.Text') || ''), 'no stick');

    // Scan again
    const scans = logged.filter((l) => /scan started/.test(l)).length;
    byName.finderScan.emit('action', {});
    await until(() => logged.filter((l) => /scan done/.test(l)).length === 2, 'the second scan');
    assert.strictEqual(logged.filter((l) => /scan started/.test(l)).length, scans + 1);

    const warns = logged.filter((l) => /fail|MISS/i.test(l) && !/save to USB: failed/.test(l));
    assert.deepStrictEqual(warns, [], 'no warnings');
    console.log('Signal Finder checks passed');
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
