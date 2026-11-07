'use strict';
/**
 * Offline check of the built Heat Test app against stand-ins: the oap-sdk
 * (OnlineApp, logging, someipBuilders with typed proxies holding a native
 * proxy that records every setValue and callMethod), the RHMI from the
 * app's uiDescription.json, and a catalogue in the head unit's layout with
 * the routes' fields, methods and data types. Checks that nothing is sent
 * before a press, each button's exact command, the level and client id
 * buttons, the retry with enum numbers when names are refused, an error
 * logged, and the live levels.
 *
 *   node tools/make_heattest.js && node tools/heattest/test_heattest.js
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..', '..', 'apps', 'mystrip_heattest');
const META = JSON.parse(fs.readFileSync(path.join(APP, 'mgu-app.json'), 'utf8'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'heattest-'));
const APPDIR = path.join(ROOT, 'javascript');
fs.mkdirSync(APPDIR);
['heattest.js', 'types.js', 'iface.js', 'catalog.js'].forEach((n) => fs.copyFileSync(path.join(APP, 'src', n), path.join(APPDIR, n)));

const CT = 'de.bmw.infotainment.climatetypes.ClimateTypes.';
const MT = 'de.bmw.infotainment.climate.climatemastertypes.ClimateMasterTypes.';
const STAGE = { KEINE_AKTION: 4, RESERVIERT: 13, RESERVIERT_1: 14, SIGNAL_UNBEFUELLT: 15, STUFE_0: 0, STUFE_1: 1, STUFE_2: 2, STUFE_3: 3 };
const CAT = {
    interfaces: {
        'de.bmw.infotainment.climate.Climate': { serviceId: 46353, fields: {
            seatHeatingLamination: { setter: { id: 90 }, dataRef: CT + 'ControlSeatHeatingLamination2Wrapper' },
            statusSeatHeatingDR: { getter: { id: 19 }, notifier: { id: 32787 }, dataRef: CT + 'StatusSeatHeatingDRWrapper' },
            statusSeatHeatingPS: { getter: { id: 21 }, notifier: { id: 32789 }, dataRef: CT + 'StatusSeatHeatingPSWrapper' }
        } },
        'de.bmw.infotainment.climate.climatemaster.ClimateMaster': { serviceId: 46400, methods: {
            requestSeatClimateSeatHeating: { methodId: 5, inputs: [{ name: 'clientGroupId', dataRef: MT + 'ClientGroupId' },
                { name: 'seatClimateHeating', dataRef: MT + 'SeatClimateHeating' }] },
            requestSteeringWheelHeating: { methodId: 6, inputs: [{ name: 'clientGroupId', dataRef: MT + 'ClientGroupId' },
                { name: 'steeringWheelHeating', dataRef: 'UInt8' }, { name: 'saveLUM', dataRef: 'Bool' }] }
        } },
        'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate': { serviceId: 5200, fields: {
            heatingState: { getter: { id: 1 }, notifier: { id: 32769 }, dataRef: 'de.bmw.body.HeatingState' }
        }, methods: {
            requestHeating: { methodId: 2, inputs: [{ arrayMinLength: 5, arrayMaxLength: 5, dimension: 1, dataRef: 'UInt8', name: 'requestor' },
                { dataRef: 'Bool', name: 'heating' }], outputs: [] }
        } }
    },
    datatypes: {
        [CT + 'ControlSeatHeatingLamination2Wrapper']: { type: 'struct', members: [
            { name: 'operationStratificationSeatHeaterDR', dataRef: 'UInt8' },
            { name: 'operationStratificationSeatHeaterPS', dataRef: 'UInt8' },
            { name: 'operationFunctionStageSeatHeaterDR', dataRef: CT + 'OperationStageSeatHeater' },
            { name: 'operationFunctionStageSeatClimateDR', dataRef: CT + 'OperationStageSeatClimate' },
            { name: 'operationFunctionStageSeatHeaterPS', dataRef: CT + 'OperationStageSeatHeater' },
            { name: 'operationFunctionStageNeckHeaterDR', dataRef: CT + 'OperationFunctionStageNeckHeater' }] },
        [CT + 'OperationStageSeatHeater']: { type: 'enum', items: STAGE },
        [CT + 'OperationStageSeatClimate']: { type: 'enum', items: STAGE },
        [CT + 'OperationFunctionStageNeckHeater']: { type: 'enum', items: { AUS: 1, KEINE_AKTION: 0, NWR_STUFE_1: 2 } },
        [CT + 'StatusSeatHeatingDRWrapper']: { type: 'struct', members: [{ name: 'statusSeatHeaterDR', dataRef: 'UInt8' }] },
        [CT + 'StatusSeatHeatingPSWrapper']: { type: 'struct', members: [{ name: 'statusSeatHeaterPS', dataRef: 'UInt8' }] },
        [MT + 'ClientGroupId']: { type: 'typedef', dataRef: 'UInt8' },
        [MT + 'SeatClimateHeating']: { type: 'struct', members: [{ name: 'configuredIntensityLevel', dataRef: 'UInt8' },
            { name: 'operationZone', dataRef: MT + 'OperationZone' }, { name: 'saveLUM', dataRef: 'Bool' }] },
        [MT + 'OperationZone']: { type: 'enum', items: { ALL_ZONES: 0, DRIVER: 1, PASSENGER: 2 } },
        'de.bmw.body.HeatingState': { type: 'struct', members: [{ name: 'functionalityCoded', dataRef: 'Bool' },
            { name: 'availability', dataRef: 'Bool' }, { name: 'heating', dataRef: 'Bool' }] }
    },
    instanceIDs: { 'de.bmw.infotainment.climate.Climate': { 1: 1 },
        'de.bmw.infotainment.climate.climatemaster.ClimateMaster': { 1: 1 },
        'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate': { 1: 1 } }
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
const ENTRY = { uuid: 'e1', name: 'mystrip_heattest' };
let app = null;
class OnlineApp extends EventEmitter {
    constructor() {
        super();
        app = this;
        this.rhmiApplication = new Rhmi();
        this.appDescription = { application: { entryPoints: [ENTRY] } };
        this.startReason = 'ENTRY_POINT';
    }
    getAppId() { return 'mystrip_heattest'; }
    start() { return Promise.resolve(); }
    getEntryPoints() { return [{ getDescription: () => ENTRY, init: () => Promise.resolve(), setAvailability: () => Promise.resolve() }]; }
    registerActive() { return Promise.resolve(); }
    initialized() { this._initialized = true; return Promise.resolve(); }
}
/* The car: native proxies record what they are sent. Climate refuses enum names
 * (as a binding wanting numbers would); ClimateMaster never answers (as on the car). */
const sent = [];
const subs = {};
const someipBuilders = {
    buildTypedProxy: (iface, instance) => {
        const short = iface.split('.').pop();
        const native = {
            setValue: (field, value) => {
                sent.push({ short, how: 'set', name: field, value });
                if (short === 'Climate' && JSON.stringify(value).indexOf('"STUFE_') >= 0) {
                    return Promise.reject(new Error('type mismatch'));
                }
                return Promise.resolve();
            },
            callMethod: (name, args) => {
                sent.push({ short, how: 'call', name, value: args });
                if (short === 'ClimateMaster') {
                    return new Promise(() => {});
                }
                return Promise.resolve({ accepted: 'IS_ACCEPTED' });
            }
        };
        const p = { _someIpProxy: native, init: () => (instance === '1' ? Promise.resolve() : Promise.reject(new Error('bad instance'))) };
        ['statusSeatHeatingDR', 'statusSeatHeatingPS', 'heatingState'].forEach((f) => {
            p[f] = { subscribe: (cb) => { subs[f] = cb; return Promise.resolve(); },
                getValue: () => Promise.resolve(f === 'heatingState' ? { heating: false } : { [f.replace('statusSeatHeating', 'statusSeatHeater')]: 0 }) };
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
require(path.join(APPDIR, 'heattest.js'));
Module._load = load;

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const last = (prefix) => {
    const w = writes.filter((x) => x.indexOf(prefix + '=') === 0).pop();
    return w ? w.slice(prefix.length + 1) : undefined;
};
const action = (i) => last(`HeatTestActions.${i}.PrimaryText`);
async function until(pred, what, ms) {
    for (let i = 0; i < (ms || 3000) / 10; i++) {
        if (pred()) { return; }
        await tick(10);
    }
    throw new Error(`timed out waiting for ${what}\n${logged.join('\n')}`);
}
let pressAt = 0;
async function press(row) {
    const wait = 450 - (Date.now() - pressAt);
    if (wait > 0) { await tick(wait); }
    pressAt = Date.now();
    byName.HeatTestActions.emit('action', { row });
    await tick(30);
}

(async () => {
    app.emit('initialized');
    await until(() => /driver seat 0 · passenger seat 0 · wheel off/.test(last('HeatTestStatus.0.Text') || ''), 'live levels');
    assert.deepStrictEqual(sent, [], 'nothing sent before a press');
    assert.strictEqual(action(0), 'Level to send: 1 (tap to change)');
    assert.strictEqual(action(2), 'Driver seat → 1 · Climate');

    // level 2
    await press(0);
    assert.strictEqual(action(0), 'Level to send: 2 (tap to change)');
    assert.strictEqual(action(2), 'Driver seat → 2 · Climate');

    // driver seat by Climate: names refused, then numbers; every other member "no action" or 0
    await press(2);
    await until(() => /^\d\d:\d\d:\d\d Driver seat → 2 · Climate: OK/.test(last('HeatTestLog.0.PrimaryText') || ''), 'Climate log row');
    assert.strictEqual(sent.length, 2, 'names then numbers');
    assert.deepStrictEqual(sent[0], { short: 'Climate', how: 'set', name: 'seatHeatingLamination', value: {
        operationStratificationSeatHeaterDR: 0, operationStratificationSeatHeaterPS: 0,
        operationFunctionStageSeatHeaterDR: 'STUFE_2', operationFunctionStageSeatClimateDR: 'KEINE_AKTION',
        operationFunctionStageSeatHeaterPS: 'KEINE_AKTION', operationFunctionStageNeckHeaterDR: 'KEINE_AKTION' } });
    assert.deepStrictEqual(sent[1].value, { operationStratificationSeatHeaterDR: 0, operationStratificationSeatHeaterPS: 0,
        operationFunctionStageSeatHeaterDR: 2, operationFunctionStageSeatClimateDR: 4, operationFunctionStageSeatHeaterPS: 4,
        operationFunctionStageNeckHeaterDR: 0 });
    assert.ok(/\(numbers\)/.test(last('HeatTestLog.0.PrimaryText')), 'log says numbers were used');

    // passenger seat by Climate
    await press(3);
    await until(() => sent.length === 4, 'passenger');
    assert.strictEqual(sent[3].value.operationFunctionStageSeatHeaterPS, 2);
    assert.strictEqual(sent[3].value.operationFunctionStageSeatHeaterDR, 4);

    // client id 2, then the driver's seat by ClimateMaster: it never answers, so the press fails after the timeout
    await press(1);
    assert.strictEqual(action(1), 'Client id: 2 (tap to change)');
    await press(4);
    assert.deepStrictEqual(sent[4], { short: 'ClimateMaster', how: 'call', name: 'requestSeatClimateSeatHeating',
        value: { clientGroupId: 2, seatClimateHeating: { configuredIntensityLevel: 2, operationZone: 'DRIVER', saveLUM: false } } });
    // a second command while one is waiting is refused
    await press(6);
    assert.ok(/Still sending/.test(last('HeatTestStatus.0.Text')), 'busy');
    await until(() => /ClimateMaster: FAILED .*no answer in 6 s.*numbers/.test(last('HeatTestLog.0.PrimaryText') || ''), 'ClimateMaster failure', 15000);
    assert.deepStrictEqual(sent[5].value.seatClimateHeating.operationZone, 1, 'retried with the number');

    // wheel on by SteeringWheelClimate: the client id as the requestor's first byte; the answer logged
    await press(6);
    await until(() => /Wheel on · SteeringWheelClimate: OK .*IS_ACCEPTED/.test(last('HeatTestLog.0.PrimaryText') || ''), 'wheel on');
    assert.deepStrictEqual(sent[6], { short: 'SteeringWheelClimate', how: 'call', name: 'requestHeating',
        value: { requestor: [2, 0, 0, 0, 0], heating: true } });
    await press(7);
    await until(() => sent.length === 8, 'wheel off');
    assert.strictEqual(sent[7].value.heating, false);

    // the live levels follow the car
    subs.statusSeatHeatingDR({ statusSeatHeaterDR: 2 });
    subs.heatingState({ heating: true });
    await until(() => /driver seat 2 · passenger seat 0 · wheel on/.test(last('HeatTestStatus.0.Text') || ''), 'live update');

    // Clear log
    await press(9);
    assert.strictEqual(last('HeatTestLog.rows'), '0');

    assert.ok(!logged.some((l) => /MISS|render .*failed/.test(l)), logged.join('\n'));
    console.log('Heat Test checks passed: commands sent');
    sent.forEach((s) => console.log(`  ${s.short}.${s.name} ${JSON.stringify(s.value)}`));
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
