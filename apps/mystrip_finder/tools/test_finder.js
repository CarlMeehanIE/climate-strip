'use strict';
/**
 * Offline check of the Signal Finder against stand-ins: the oap-sdk
 * (OnlineApp, logging), the RHMI (components from the generated
 * uiDescription.json) and made-up catalogues in the head unit's layout
 * (interfaces with fields / methods / events, datatypes, instanceIDs).
 * Checks which interfaces and parts are listed, what each allows, the types
 * spelled out, the screens and presses, a missing catalogue, and that a
 * catalogue of tens of MB is read quickly without parsing it whole.
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
fs.mkdirSync(path.join(ROOT, 'app'));
fs.mkdirSync(APPDIR);
['finder.js', 'catalog.js'].forEach((n) => fs.copyFileSync(path.join(__dirname, '..', 'src', n), path.join(APPDIR, n)));
const catalog = require(path.join(APPDIR, 'catalog.js'));

/* A made-up catalogue in the head unit's layout. */
const CAT = {
    version: '1',
    interfaces: {
        'de.bmw.infotainment.climate.Climate': {
            serviceId: 4100,
            fields: {
                statusSeatHeatingDR: { getter: { id: 1 }, notifier: { eventId: 2 }, dataRef: 'de.bmw.infotainment.climate.SeatHeatingStatus' },
                statusSeatHeatingPS: { getter: { id: 3 }, notifier: { eventId: 4 }, setter: { id: 0 }, dataRef: 'de.bmw.infotainment.climate.SeatHeatingStatus' },
                statusFanSpeed: { getter: { id: 5 }, dataRef: 'UInt8' }
            },
            methods: {
                setSeatHeating: { id: 7, inArgs: [{ name: 'seat', dataRef: 'de.bmw.infotainment.climate.Seat' },
                    { name: 'level', dataRef: 'de.bmw.infotainment.climate.SeatHeatingLevel' }] },
                setTemperature: { id: 8, inArgs: [{ name: 't', dataRef: 'UInt8' }] }
            }
        },
        'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate': {
            serviceId: 5200,
            fields: {
                heatingState: { getter: { id: 1 }, setter: { id: 2 }, notifier: { eventId: 3 }, dataRef: 'de.bmw.body.OnOff' },
                vibration: { getter: { id: 4 }, dataRef: 'UInt8' }
            }
        },
        'de.bmw.body.seatcomfort.SeatComfort': {
            serviceId: 6300,
            methods: { requestClimate: { id: 1, inArgs: [{ name: 'req', dataRef: 'de.bmw.body.seatcomfort.SeatHeatRequest' }] } },
            events: { massageDone: { id: 2 } }
        },
        'de.bmw.infotainment.vehicle.Vehicle2': {
            serviceId: 100,
            fields: { statusCarSpeed2: { getter: { id: 1 }, dataRef: 'UInt16' } }
        }
    },
    datatypes: {
        'de.bmw.infotainment.climate.SeatHeatingStatus': { type: 'struct', extends: 'de.bmw.infotainment.climate.Base',
            members: [{ name: 'level', dataRef: 'de.bmw.infotainment.climate.SeatHeatingLevel' }] },
        'de.bmw.infotainment.climate.Base': { type: 'struct', members: [{ name: 'valid', dataRef: 'Boolean' }] },
        'de.bmw.infotainment.climate.SeatHeatingLevel': { type: 'enum', items: { OFF: 0, LEVEL_1: 1, LEVEL_2: 2, LEVEL_3: 3 } },
        'de.bmw.infotainment.climate.Seat': { type: 'enum', items: { DRIVER: 0, PASSENGER: 1 } },
        'de.bmw.body.OnOff': { type: 'typedef', dataRef: 'de.bmw.body.OnOffEnum' },
        'de.bmw.body.OnOffEnum': { type: 'enum', items: { OFF: 0, ON: 1 } },
        'de.bmw.body.seatcomfort.SeatHeatRequest': { type: 'struct', members: [{ name: 'seat', dataRef: 'de.bmw.infotainment.climate.Seat' },
            { name: 'levels', dataRef: 'de.bmw.body.seatcomfort.Levels' }] },
        'de.bmw.body.seatcomfort.Levels': { type: 'array', elementDataRef: 'de.bmw.infotainment.climate.SeatHeatingLevel' }
    },
    instanceIDs: { 'de.bmw.infotainment.climate.Climate': ['1'], 'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate': ['1'] }
};
const CAT_FILE = path.join(ROOT, 'someip-interfaces.json');
fs.writeFileSync(CAT_FILE, JSON.stringify(CAT, null, 2));

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
        this.packageJson = { version: 'test' };
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
let catFile = CAT_FILE;
const stubs = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => quiet },
    './catalog.js': { readCatalog: () => catalog.readCatalog({ file: catFile }) }
};
const load = Module._load;
Module._load = function (req) {
    return stubs[req] || load.apply(this, arguments);
};
require(path.join(APPDIR, 'finder.js'));
Module._load = load;

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const last = (prefix) => {
    const w = writes.filter((x) => x.indexOf(prefix + '=') === 0).pop();
    return w ? w.slice(prefix.length + 1) : undefined;
};
const rowsOf = (list) => writes.filter((w) => new RegExp(`^${list}\\.\\d+\\.PrimaryText=`).test(w)).map((w) => w.split('=').slice(1).join('='));
async function until(pred, what) {
    for (let i = 0; i < 500; i++) {
        if (pred()) {
            return;
        }
        await tick(10);
    }
    throw new Error(`timed out waiting for ${what}\n${logged.join('\n')}`);
}

(async () => {
    app.emit('initialized');
    await until(() => logged.some((l) => /catalogue read:/.test(l)), 'the read');
    await tick(50);
    console.log(logged.filter((l) => /catalogue read:/.test(l))[0]);
    assert.ok(states.indexOf('map ST_OnlineApps_MyStripFinder') >= 0, 'entry state mapped');

    // the interfaces with heating parts; the vehicle one left out
    const ifaces = rowsOf('finderIfaceList');
    console.log('interfaces:', ifaces.join(' | '));
    assert.deepStrictEqual(ifaces, ['3 parts · de.bmw.infotainment.climate.Climate',
        '2 parts · de.bmw.body.steeringwheelcomfort.SteeringWheelClimate', '1 part · de.bmw.body.seatcomfort.SeatComfort']);
    assert.strictEqual(last('finderStatus.0.Text'), '3 interfaces with heating parts (6 parts), of 4 in the catalogue');
    assert.ok(!writes.some((w) => /FrequencyText/.test(w)), 'nothing in the second column');

    // Climate: the seat fields and the seat method, not the fan or temperature; setter id 0 is no setter
    byName.finderIfaceList.emit('action', { row: 0 });
    await tick(20);
    assert.ok(states.indexOf('open ST_OnlineApps_MyStripFinderIface') >= 0, 'interface page opened');
    assert.strictEqual(last('finderIfaceHead.0.Text'), 'de.bmw.infotainment.climate.Climate · service 4100 · instance ["1"]');
    let members = rowsOf('finderMemberList');
    console.log('Climate parts:', members.join(' | '));
    assert.deepStrictEqual(members, ['GET+NOTIFY · statusSeatHeatingDR', 'GET+NOTIFY · statusSeatHeatingPS', 'CALL · setSeatHeating']);

    // a part in full: its arguments and their types spelled out
    byName.finderMemberList.emit('action', { row: 2 });
    await tick(20);
    assert.ok(states.indexOf('open ST_OnlineApps_MyStripFinderDetail') >= 0, 'part page opened');
    assert.strictEqual(last('finderDetailName.0.Text'), 'setSeatHeating');
    assert.strictEqual(last('finderDetailKind.0.Text'), 'method · CALL');
    assert.strictEqual(last('finderDetailType.0.Text'),
        'inArgs: seat: Seat enum(DRIVER=0, PASSENGER=1), level: SeatHeatingLevel enum(OFF=0, LEVEL_1=1, LEVEL_2=2, LEVEL_3=3)');
    assert.ok(/"id":7/.test(last('finderDetailRaw.0.Text')), 'raw entry');

    // a struct with its parent's members
    byName.finderMemberList.emit('action', { row: 0 });
    await tick(20);
    assert.strictEqual(last('finderDetailType.0.Text'),
        'SeatHeatingStatus {valid: Boolean, level: SeatHeatingLevel enum(OFF=0, LEVEL_1=1, LEVEL_2=2, LEVEL_3=3)}');

    // the steering wheel interface is about heating by its name: every part listed, the typedef followed
    byName.finderIfaceList.emit('action', { row: 1 });
    await tick(20);
    members = rowsOf('finderMemberList').slice(-2);
    assert.deepStrictEqual(members, ['GET+SET+NOTIFY · heatingState', 'GET · vibration']);
    await tick(450);                    // past the double-press guard for row 0
    byName.finderMemberList.emit('action', { row: 0 });
    await tick(20);
    assert.strictEqual(last('finderDetailType.0.Text'), 'OnOffEnum enum(OFF=0, ON=1)');

    // a request that is about heating only through its types; the unrelated event left out
    byName.finderIfaceList.emit('action', { row: 2 });
    await tick(20);
    assert.deepStrictEqual(rowsOf('finderMemberList').slice(-1), ['CALL · requestClimate']);
    await tick(450);
    byName.finderMemberList.emit('action', { row: 0 });
    await tick(20);
    assert.ok(/levels: \[SeatHeatingLevel enum/.test(last('finderDetailType.0.Text')), 'array of an enum');

    // the raw userEvent path for a press already counted within 400 ms counts once
    const before = logged.filter((l) => /BUTTON ACTION finderMemberList/.test(l)).length;
    app.rhmiApplication.emit('userEvent', { eventType: 'ACTION', sourceId: byName.finderMemberList.id, parameterMap: { 2: 0 } });
    assert.strictEqual(logged.filter((l) => /BUTTON ACTION finderMemberList/.test(l)).length, before, 'press counted once');

    // no catalogue
    catFile = path.join(ROOT, 'missing.json');
    byName.finderRead.emit('action', {});
    await until(() => /Could not read the catalogue: catalogue not found/.test(last('finderStatus.0.Text') || ''), 'missing catalogue');
    assert.strictEqual(last('finderIfaceList.rows'), '0', 'list emptied');

    // a catalogue of tens of MB: thousands of interfaces and types, a few about heating
    const big = { interfaces: {}, datatypes: Object.assign({}, CAT.datatypes), instanceIDs: {} };
    for (let i = 0; i < 6000; i++) {
        big.interfaces[`de.bmw.filler.Interface${i}`] = { serviceId: i, fields: {}, methods: {} };
        for (let f = 0; f < 20; f++) {
            big.interfaces[`de.bmw.filler.Interface${i}`].fields[`statusValue${f}`] = { getter: { id: f }, dataRef: `de.bmw.filler.T${i % 500}` };
        }
        big.interfaces[`de.bmw.filler.Interface${i}`].methods.doThing = { id: 1, inArgs: [{ name: 'a "quoted" \\ value', dataRef: 'UInt8' }] };
    }
    for (let t = 0; t < 4000; t++) {
        big.datatypes[`de.bmw.filler.T${t}`] = { type: 'struct', members: [{ name: 'x', dataRef: 'UInt8' }, { name: 'y', dataRef: 'UInt8' }] };
    }
    Object.assign(big.interfaces, CAT.interfaces);
    const BIG_FILE = path.join(ROOT, 'big.json');
    fs.writeFileSync(BIG_FILE, JSON.stringify(big, null, 1));
    const bytes = fs.statSync(BIG_FILE).size;
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = Date.now();
    const r = await catalog.readCatalog({ file: BIG_FILE });
    const took = Date.now() - t0;
    const heapGrew = Math.round((process.memoryUsage().heapUsed - heapBefore) / 1e6);
    console.log(`big catalogue: ${Math.round(bytes / 1e6)} MB, ${r.total} interfaces, ${r.interfaces.length} with heating, ${took} ms, heap +${heapGrew} MB`);
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.total, 6004);
    assert.deepStrictEqual(r.interfaces.map((i) => i.name), Object.keys(CAT.interfaces).slice(0, 3));
    assert.ok(took < 10000, 'read in under 10 s here');

    const warns = logged.filter((l) => /fail|MISS/i.test(l));
    assert.deepStrictEqual(warns, [], 'no warnings');
    console.log('Signal Finder checks passed');
    process.exit(0);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
