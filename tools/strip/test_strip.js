'use strict';
/**
 * Offline check of the built Climate Strip against stand-ins:
 * the oap-sdk (OnlineApp, logging, someipBuilders with typed proxies whose
 * native proxy records commands and answers like the car: a seat's heater
 * stage follows the stage sent, the wheel follows requestHeating), the RHMI
 * from the app's uiDescription.json, and a catalogue in the head unit's
 * layout. Checks the rows' levels (BMW's names from statusAURAPerso, the
 * heater stage), nothing sent before a tap, stepping a seat up from the
 * stage the car reports and back to off, the driver's row addressing the
 * driver's seat, the wheel on and off, the log, and a failed command; then,
 * with a stand-in Climate Bar service on a socket: the car's state sent to
 * it, a tap on the bar sending the command, the bar's rows (on / off, line
 * up and its moves) sending the bar's commands, and its notes.
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
['strip.js', 'bar_link.js', 'types.js', 'iface.js', 'catalog.js'].forEach((n) => fs.copyFileSync(path.join(APP, 'src', n), path.join(APPDIR, n)));

const CT = 'de.bmw.infotainment.climatetypes.ClimateTypes.';
const STAGE = { KEINE_AKTION: 4, RESERVIERT: 13, RESERVIERT_1: 14, SIGNAL_UNBEFUELLT: 15, STUFE_0: 0, STUFE_1: 1, STUFE_2: 2, STUFE_3: 3 };
const CAT = {
    interfaces: {
        'de.bmw.infotainment.climate.Climate': { serviceId: 46353, fields: {
            seatHeatingLamination: { setter: { id: 90 }, dataRef: CT + 'Lamination' },
            statusSeatHeatingDR: { getter: { id: 19 }, notifier: { id: 1 }, dataRef: CT + 'DR' },
            statusSeatHeatingPS: { getter: { id: 21 }, notifier: { id: 2 }, dataRef: CT + 'PS' },
            statusAURAPerso: { getter: { id: 30 }, notifier: { id: 3 }, dataRef: CT + 'Aura' },
            operationAURAPerso: { setter: { id: 91 }, dataRef: CT + 'AuraSet' }
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
        [CT + 'AuraSet']: { type: 'struct', members: [{ name: 'operationSeatHeaterAUTODriver', dataRef: CT + 'Level' },
            { name: 'operationSeatHeaterAUTOPassenger', dataRef: CT + 'Level' }] },
        [CT + 'Level']: { type: 'enum', items: { KEINE_AKTION: 7, STUFE_0: 0, STUFE_1: 1, STUFE_2: 2, STUFE_3: 3, STUFE_4: 4 } },
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
const car = { dr: 0, ps: 2, autoDr: 'STUFE_0', autoPs: 'STUFE_3', wheel: false, fail: false, silent: false };
const sent = [];
const subs = {};
/* As the car's proxy hands it over: an object whose members (and enum
 * values) only show their names when written out as JSON. */
const wrapped = (o) => { const w = { _m: o }; Object.defineProperty(w, 'toJSON', { value: () => o }); return w; };
const en = (name) => ({ _v: Number(name.replace('STUFE_', '')), toJSON: () => name });
const aura = () => wrapped({ statusSeatHeaterAUTODriver: en(car.autoDr), statusSeatHeaterAUTOPassenger: en(car.autoPs), other: 7 });
function notify() {
    if (car.silent) { return; }       // as on the car: the change not sent to an app started with the head unit
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
                const st = (v) => (v === 'KEINE_AKTION' || v === undefined ? null : Number(String(v).replace('STUFE_', '')));
                if (field === 'operationAURAPerso') {
                    const a = st(value.operationSeatHeaterAUTODriver), b = st(value.operationSeatHeaterAUTOPassenger);
                    if (a !== null) { car.autoDr = `STUFE_${a}`; }
                    if (b !== null) { car.autoPs = `STUFE_${b}`; }
                    setTimeout(notify, 5);
                    return Promise.resolve();
                }
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
const realLink = require(path.join(APPDIR, 'bar_link.js'));
const BAR_SOCKET = path.join(ROOT, 'bar.sock');
class TestLink extends realLink.BarLink { constructor(log) { super(log, BAR_SOCKET); } }
const stubs = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => quiet },
    'oap-sdk/src/someip/someipBuilders': someipBuilders,
    './iface.js': { readInterface: (o) => realIface.readInterface(Object.assign({}, o, { file: CAT_FILE })) },
    './types.js': { loadCatalog: () => realTypes.loadCatalog({ file: CAT_FILE }) },
    './bar_link.js': { BarLink: TestLink }
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
async function until(pred, what, ms) {
    for (let i = 0; i < (ms || 3000) / 10; i++) {
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

    car.fail = false;
    // Settings: the seat command and the bar's rows, with Back
    assert.strictEqual(row(3), 'Settings ›');
    await tap(3);
    await until(() => row(0) === '‹ Back', 'settings open');
    assert.strictEqual(row(2), 'Climate bar: not running (install Climate Bar from the Store)');

    // the second seat command: BMW's level, found in the catalogue, stepped from the level the car reports
    assert.strictEqual(row(1), 'Seat command: heater stage (tap to try BMW\'s level)');
    await tap(1);
    await until(() => row(1) === 'Seat command: BMW\'s level, operationAURAPerso (tap for heater stage)', 'level route');
    await tap(0);
    await until(() => row(3) === 'Settings ›', 'back to the heating rows');
    const at = sent.length;
    await tap(0);
    await until(() => /^Your seat \(driver\): low/.test(row(0) || ''), 'driver to low by BMW\'s level');
    assert.deepStrictEqual(sent[at], { short: 'Climate', name: 'operationAURAPerso',
        value: { operationSeatHeaterAUTODriver: 'STUFE_1', operationSeatHeaterAUTOPassenger: 'KEINE_AKTION' } });
    assert.ok(/Driver seat → low \(operationAURAPerso.operationSeatHeaterAUTODriver\): OK/.test(last('ClimateStripLog.0.PrimaryText')));
    await tap(1);
    await until(() => /^Passenger seat: very high/.test(row(1) || ''), 'passenger from high to very high');
    assert.strictEqual(sent[sent.length - 1].value.operationSeatHeaterAUTOPassenger, 'STUFE_4');
    await tap(1);
    await until(() => /^Passenger seat: off/.test(row(1) || ''), 'passenger off after very high');
    await tap(3);
    await until(() => row(0) === '‹ Back', 'settings again');
    await tap(1);
    await until(() => row(1) === 'Seat command: heater stage (tap to try BMW\'s level)', 'back to the heater stage');
    await tap(0);
    await until(() => row(3) === 'Settings ›', 'the heating rows again');

    // the Climate Bar service: told the car's state, its taps sent as commands, its rows send its commands
    const got = [];
    let peer = null;
    const status = { renderer: 'connected', overlay: 'restart', touchRouting: true, safe: false, enabled: true, lineup: false,
        selected: 'ps', step: 10, settings: { size: 72, cover: true, shade: 0,
        items: { ps: { x: 970, y: 900 }, dr: { x: 2545, y: 902 }, wheel: { x: 2720, y: 900 } } } };
    const server = require('net').createServer((c) => {
        peer = c;
        let buf = '';
        c.setEncoding('utf8');
        c.on('data', (d) => {
            buf += d;
            let at;
            while ((at = buf.indexOf('\n')) >= 0) { got.push(JSON.parse(buf.slice(0, at))); buf = buf.slice(at + 1); }
        });
        c.write(JSON.stringify({ status }) + '\n');
    });
    await new Promise((r) => server.listen(BAR_SOCKET, r));
    await until(() => got.some((m) => m.car), 'the car state sent on connecting', 8000);   // the link tries every 5 s
    assert.deepStrictEqual(got.filter((m) => m.car).pop().car, { dr: { level: 1, stage: 0 }, ps: { level: 0, stage: 3 }, wheel: false });
    await tap(3);
    await until(() => row(2) === 'Climate bar: on' && row(3) === 'Line up the bar\'s buttons: off', 'the bar rows');
    await tap(0);
    assert.strictEqual(last('ClimateStripStatus.0.Text'), 'Climate bar: restart the head unit once to finish setting it up.');

    const before = sent.length;
    peer.write(JSON.stringify({ tap: 'ps' }) + '\n');
    await until(() => row(1) === 'Passenger seat: off, heater stage 0', 'the bar\'s tap stepped the passenger seat');
    assert.strictEqual(sent.length, before + 1);
    assert.strictEqual(sent[before].value.operationFunctionStageSeatHeaterPS, 'STUFE_0');
    assert.ok(/Passenger seat → stage 0 \(climate bar\): OK/.test(last('ClimateStripLog.0.PrimaryText')));
    await until(() => got.filter((m) => m.car).pop().car.ps.stage === 0, 'the new state sent to the bar');
    peer.write(JSON.stringify({ tap: 'wheel' }) + '\n');
    await until(() => row(2) === 'Steering wheel: on', 'the bar\'s tap turned the wheel on');

    await tap(3);
    await until(() => row(0) === '‹ Back', 'settings for lining up');
    await tap(3);
    await until(() => got.some((m) => m.cmd === 'lineup' && m.on === true), 'line up asked');
    peer.write(JSON.stringify({ status: Object.assign({}, status, { overlay: 'set', lineup: true }) }) + '\n');
    await until(() => row(4) === 'Numbers: passenger 970, 900 · yours 2545, 902 · wheel 2720, 900 · size 72' && row(5) === 'Moving the passenger seat (tap for the next, or tap it on the bar)' && row(6) === 'Left 10 px', 'the line-up rows');
    assert.strictEqual(row(13), 'Seat icons: auto, BMW\'s own at very high (tap for always)');
    assert.strictEqual(row(14), 'Put the buttons back where they started', 'no patch rows while BMW\'s indicator shows');
    assert.strictEqual(last('ClimateStripStatus.0.Text'), 'Tap a seat to step its heating up (off after the highest), the wheel to turn it on or off.');
    await tap(4);
    await tap(7);
    await tap(12);
    await tap(13);
    await tap(2);
    await until(() => got.filter((m) => m.cmd).length === 5, 'the commands');
    assert.deepStrictEqual(got.filter((m) => m.cmd), [{ cmd: 'lineup', on: true }, { cmd: 'move', dx: 1 }, { cmd: 'size', d: -1 },
        { cmd: 'seats' }, { cmd: 'enable', on: false }]);
    assert.strictEqual(sent.length, before + 2, 'the bar\'s rows send nothing to the car');
    peer.write(JSON.stringify({ status: Object.assign({}, status, { overlay: 'set', safe: true }) }) + '\n');
    await until(() => row(2) === 'Climate bar: off after quick restarts (safe mode), tap to turn it on', 'safe mode row');
    await tap(2);
    await until(() => got.filter((m) => m.cmd).length === 6, 'turned on again');
    assert.deepStrictEqual(got.filter((m) => m.cmd).pop(), { cmd: 'enable', on: true });

    // the service gone: the row says so
    peer.destroy();
    server.close();
    await until(() => row(2) === 'Climate bar: not running (install Climate Bar from the Store)', 'the bar gone');
    await tap(0);
    await until(() => row(3) === 'Settings ›', 'back');

    // no changes sent by the car: what was sent is kept, and the car is read again every 2 s
    car.silent = true;
    car.autoDr = 'STUFE_0';
    await until(() => /^Your seat \(driver\): off/.test(row(0) || ''), 'driver off, read again', 4000);
    await tap(3);
    await until(() => row(0) === '‹ Back', 'settings');
    await tap(1);
    await until(() => /BMW's level/.test(row(1) || ''), 'BMW\'s level');
    await tap(0);
    await until(() => row(3) === 'Settings ›', 'back');
    const steps = [];
    for (let i = 0; i < 5; i++) {
        await tap(0);
        await until(() => /→/.test(last('ClimateStripLog.0.PrimaryText') || '') && steps.length === i && sent.length, 'sent');
        await tick(30);
        steps.push(sent[sent.length - 1].value.operationSeatHeaterAUTODriver);
    }
    assert.deepStrictEqual(steps, ['STUFE_1', 'STUFE_2', 'STUFE_3', 'STUFE_4', 'STUFE_0'], 'low, medium, high, very high, off');
    car.autoDr = 'STUFE_2';            // BMW's own button, no change sent
    await until(() => /^Your seat \(driver\): medium/.test(row(0) || ''), 'BMW\'s own change read within 2 s', 4000);
    car.silent = false;

    assert.ok(!logged.some((l) => /MISS|render .*failed/.test(l)), logged.join('\n'));
    console.log('Climate Strip checks passed');
    console.log(`  rows: ${row(0)} | ${row(1)} | ${row(2)}`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
