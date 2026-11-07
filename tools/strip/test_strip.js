'use strict';
/**
 * Offline check of the built Climate Strip (stage one) against stand-ins:
 * the oap-sdk (OnlineApp, logging, someipBuilders with typed proxies whose
 * native proxy records commands and answers like the car: a seat's heater
 * stage follows the stage sent, the wheel follows requestHeating), the RHMI
 * from the app's uiDescription.json, and a catalogue in the head unit's
 * layout. Checks the rows' levels (BMW's names from statusAURAPerso, the
 * heater stage), nothing sent before a tap, stepping a seat up from the
 * stage the car reports and back to off, the driver's row addressing the
 * driver's seat, the wheel on and off, the log, and a failed command.
 *
 *   node tools/make_strip.js && node tools/strip/test_strip.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..', '..', 'apps', 'mystrip_climate');
const META = JSON.parse(fs.readFileSync(path.join(APP, 'mgu-app.json'), 'utf8'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-'));
const APPDIR = path.join(ROOT, 'javascript');
fs.mkdirSync(APPDIR);
['strip.js', 'types.js', 'iface.js', 'catalog.js'].forEach((n) => fs.copyFileSync(path.join(APP, 'src', n), path.join(APPDIR, n)));

const CT = 'de.bmw.infotainment.climatetypes.ClimateTypes.';
const STAGE = { KEINE_AKTION: 4, RESERVIERT: 13, RESERVIERT_1: 14, SIGNAL_UNBEFUELLT: 15, STUFE_0: 0, STUFE_1: 1, STUFE_2: 2, STUFE_3: 3 };
const CAT = {
    interfaces: {
        'de.bmw.infotainment.climate.Climate': { serviceId: 46353, fields: {
            seatHeatingLamination: { setter: { id: 90 }, dataRef: CT + 'Lamination' },
            statusSeatHeatingDR: { getter: { id: 19 }, notifier: { id: 1 }, dataRef: CT + 'DR' },
            statusSeatHeatingPS: { getter: { id: 21 }, notifier: { id: 2 }, dataRef: CT + 'PS' },
            statusAURAPerso: { getter: { id: 30 }, notifier: { id: 3 }, dataRef: CT + 'Aura' }
        } },
        'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate': { serviceId: 5200, fields: {
            heatingState: { getter: { id: 1 }, notifier: { id: 32769 }, dataRef: 'de.bmw.body.HeatingState' }
        }, methods: {
            requestHeating: { methodId: 2, inputs: [{ arrayMinLength: 5, arrayMaxLength: 5, dimension: 1, dataRef: 'UInt8', name: 'requestor' },
                { dataRef: 'Bool', name: 'heating' }], outputs: [] }
        } }
    },
    datatypes: {
        [CT + 'Lamination']: { type: 'struct', members: [
            { name: 'operationStratificationSeatHeaterDR', dataRef: 'UInt8' },
            { name: 'operationStratificationSeatHeaterPS', dataRef: 'UInt8' },
            { name: 'operationFunctionStageSeatHeaterDR', dataRef: CT + 'Stage' },
            { name: 'operationFunctionStageSeatHeaterPS', dataRef: CT + 'Stage' },
            { name: 'operationFunctionStageNeckHeaterDR', dataRef: CT + 'Neck' }] },
        [CT + 'Stage']: { type: 'enum', items: STAGE },
        [CT + 'Neck']: { type: 'enum', items: { AUS: 1, KEINE_AKTION: 0, NWR_STUFE_1: 2 } },
        [CT + 'DR']: { type: 'struct', members: [{ name: 'statusSeatHeaterDR', dataRef: 'UInt8' }] },
        [CT + 'PS']: { type: 'struct', members: [{ name: 'statusSeatHeaterPS', dataRef: 'UInt8' }] },
        'de.bmw.body.HeatingState': { type: 'struct', members: [{ name: 'functionalityCoded', dataRef: 'Bool' },
            { name: 'availability', dataRef: 'Bool' }, { name: 'heating', dataRef: 'Bool' }] }
    },
    instanceIDs: { 'de.bmw.infotainment.climate.Climate': { 1: 1 }, 'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate': { 1: 1 } }
};
const CAT_FILE = path.join(ROOT, 'cat.json');
fs.writeFileSync(CAT_FILE, JSON.stringify(CAT));

const writes = [];
class Comp extends EventEmitter {
    constructor(name, id) { super(); this.name = name; this.id = id; }
    getId() { return this.id; }
    setValue(r, c, v) { writes.push(`${this.name}.${r}.${c}=${v}`); return Promise.resolve(); }
    setProperty(p, v) { writes.push(`${this.name}.${p}=${v}`); return Promise.resolve(); }
    setRowCount(n) { writes.push(`${this.name}.rows=${n}`); return Promise.resolve(); }
    updateResources() { return Promise.resolve(); }
}
const ui = JSON.parse(fs.readFileSync(path.join(APP, META.tree, 'rhmiData', 'uiDescriptions', 'ID8', 'uiDescription.json'), 'utf8'));
const byName = {};
Object.keys(ui.containers).forEach((cid) => {
    const c = ui.containers[cid];
    byName[c.name] = new Comp(c.name, cid);
    Object.keys(c.components).forEach((id) => { byName[c.components[id].name] = new Comp(c.components[id].name, id); });
});
class Rhmi extends EventEmitter {
    getByName(n) { return byName[n]; }
    mapEntryState() { return Promise.resolve(); }
    openEntryState() { return Promise.resolve(); }
}
const ENTRY = { uuid: 'e1', name: 'mystrip_climate' };
let app = null;
class OnlineApp extends EventEmitter {
    constructor() {
        super();
        app = this;
        this.rhmiApplication = new Rhmi();
        this.appDescription = { application: { entryPoints: [ENTRY] } };
        this.startReason = 'ENTRY_POINT';
    }
    getAppId() { return 'mystrip_climate'; }
    start() { return Promise.resolve(); }
    getEntryPoints() { return [{ getDescription: () => ENTRY, init: () => Promise.resolve(), setAvailability: () => Promise.resolve() }]; }
    registerActive() { return Promise.resolve(); }
    initialized() { this._initialized = true; return Promise.resolve(); }
}
/* The car. */
const car = { dr: 0, ps: 2, autoDr: 'STUFE_0', autoPs: 'STUFE_3', wheel: false, fail: false };
const sent = [];
const subs = {};
const aura = () => ({ statusSeatHeaterAUTODriver: car.autoDr, statusSeatHeaterAUTOPassenger: car.autoPs, other: 7 });
function notify() {
    if (subs.statusSeatHeatingDR) { subs.statusSeatHeatingDR({ statusSeatHeaterDR: car.dr }); }
    if (subs.statusSeatHeatingPS) { subs.statusSeatHeatingPS({ statusSeatHeaterPS: car.ps }); }
    if (subs.statusAURAPerso) { subs.statusAURAPerso(aura()); }
    if (subs.heatingState) { subs.heatingState({ functionalityCoded: true, availability: false, heating: car.wheel }); }
}
const someipBuilders = {
    buildTypedProxy: (iface) => {
        const short = iface.split('.').pop();
        const native = {
            setValue: (field, value) => {
                sent.push({ short, name: field, value });
                if (car.fail) { return Promise.reject(new Error('refused')); }
                const st = (v) => (v === 'KEINE_AKTION' ? null : Number(String(v).replace('STUFE_', '')));
                const dr = st(value.operationFunctionStageSeatHeaterDR);
                const ps = st(value.operationFunctionStageSeatHeaterPS);
                if (dr !== null) { car.dr = dr; car.autoDr = `STUFE_${dr}`; }
                if (ps !== null) { car.ps = ps; car.autoPs = `STUFE_${ps}`; }
                setTimeout(notify, 5);
                return Promise.resolve();
            },
            callMethod: (name, args) => {
                sent.push({ short, name, value: args });
                car.wheel = args.heating;
                setTimeout(notify, 5);
                return Promise.resolve({});
            }
        };
        const p = { _someIpProxy: native, init: () => Promise.resolve() };
        ['statusSeatHeatingDR', 'statusSeatHeatingPS', 'statusAURAPerso', 'heatingState'].forEach((f) => {
            p[f] = { subscribe: (cb) => { subs[f] = cb; return Promise.resolve(); },
                getValue: () => Promise.resolve({ statusSeatHeatingDR: { statusSeatHeaterDR: car.dr }, statusSeatHeatingPS: { statusSeatHeaterPS: car.ps },
                    statusAURAPerso: aura(), heatingState: { heating: car.wheel } }[f]) };
        });
        return Promise.resolve(p);
    }
};
const logged = [];
const quiet = { info(l) { logged.push(String(l)); }, warn(l) { logged.push(String(l)); }, error(l) { logged.push(String(l)); } };
const realIface = require(path.join(APPDIR, 'iface.js'));
const realTypes = require(path.join(APPDIR, 'types.js'));
const stubs = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => quiet },
    'oap-sdk/src/someip/someipBuilders': someipBuilders,
    './iface.js': { readInterface: (o) => realIface.readInterface(Object.assign({}, o, { file: CAT_FILE })) },
    './types.js': { loadCatalog: () => realTypes.loadCatalog({ file: CAT_FILE }) }
};
const load = Module._load;
Module._load = function (req) { return stubs[req] || load.apply(this, arguments); };
require(path.join(APPDIR, 'strip.js'));
Module._load = load;

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const last = (prefix) => {
    const w = writes.filter((x) => x.indexOf(prefix + '=') === 0).pop();
    return w ? w.slice(prefix.length + 1) : undefined;
};
const row = (i) => last(`ClimateStripRows.${i}.PrimaryText`);
async function until(pred, what) {
    for (let i = 0; i < 300; i++) {
        if (pred()) { return; }
        await tick(10);
    }
    throw new Error(`timed out waiting for ${what}\n${logged.join('\n')}\nrows: ${row(0)} | ${row(1)} | ${row(2)}`);
}
let pressAt = 0;
async function tap(i) {
    const wait = 450 - (Date.now() - pressAt);
    if (wait > 0) { await tick(wait); }
    pressAt = Date.now();
    byName.ClimateStripRows.emit('action', { row: i });
    await tick(30);
}

(async () => {
    app.emit('initialized');
    await until(() => row(0) === 'Your seat (driver): off, heater stage 0' && row(1) === 'Passenger seat: high, heater stage 2' &&
        row(2) === 'Steering wheel: off', 'the start rows');
    assert.deepStrictEqual(sent, [], 'nothing sent before a tap');

    // the driver's seat: stage 1, the driver's member set and the passenger's left alone
    await tap(0);
    await until(() => row(0) === 'Your seat (driver): low, heater stage 1', 'driver stage 1');
    assert.deepStrictEqual(sent[0], { short: 'Climate', name: 'seatHeatingLamination', value: {
        operationStratificationSeatHeaterDR: 0, operationStratificationSeatHeaterPS: 0, operationFunctionStageSeatHeaterDR: 'STUFE_1',
        operationFunctionStageSeatHeaterPS: 'KEINE_AKTION', operationFunctionStageNeckHeaterDR: 'KEINE_AKTION' } });
    assert.ok(/Driver seat → stage 1: OK/.test(last('ClimateStripLog.0.PrimaryText')), 'logged');
    await tap(0);
    await tap(0);
    await until(() => row(0) === 'Your seat (driver): high, heater stage 3', 'driver stage 3');
    // after the highest, off
    await tap(0);
    await until(() => row(0) === 'Your seat (driver): off, heater stage 0', 'driver off');

    // the car's own button moved the passenger's seat to stage 2: a tap steps on from there, to 3
    await tap(1);
    await until(() => /Passenger seat: high, heater stage 3/.test(row(1) || ''), 'passenger from the reported stage');
    assert.strictEqual(sent[sent.length - 1].value.operationFunctionStageSeatHeaterPS, 'STUFE_3');
    assert.strictEqual(sent[sent.length - 1].value.operationFunctionStageSeatHeaterDR, 'KEINE_AKTION');

    // the wheel on, then off
    await tap(2);
    await until(() => row(2) === 'Steering wheel: on', 'wheel on');
    assert.deepStrictEqual(sent[sent.length - 1], { short: 'SteeringWheelClimate', name: 'requestHeating',
        value: { requestor: [1, 0, 0, 0, 0], heating: true } });
    await tap(2);
    await until(() => row(2) === 'Steering wheel: off', 'wheel off');

    // a refused command is logged and changes nothing
    car.fail = true;
    await tap(0);
    await until(() => /FAILED .*refused/.test(last('ClimateStripLog.0.PrimaryText') || ''), 'failure logged');
    assert.strictEqual(row(0), 'Your seat (driver): off, heater stage 0');

    assert.ok(!logged.some((l) => /MISS|render .*failed/.test(l)), logged.join('\n'));
    console.log('Climate Strip checks passed');
    console.log(`  rows: ${row(0)} | ${row(1)} | ${row(2)}`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
