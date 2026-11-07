'use strict';
/**
 * Offline check of a built Heat Watch app (default apps/mystrip_watchseat)
 * against stand-ins: the oap-sdk (OnlineApp, logging, someipBuilders with a
 * typed proxy whose fields the test changes), the RHMI from the app's
 * uiDescription.json, and a made-up catalogue. Checks the start rows, a
 * change becoming the newest row, an unchanged value adding nothing, a field
 * that cannot be subscribed, Clear log, and an interface missing from the
 * catalogue.
 *
 *   node tools/make_watch.js && node tools/watch/test_watch.js [app id]
 */
const assert = require('assert');
const EventEmitter = require('events');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const ID = process.argv[2] || 'mystrip_watchseat';
const APP = path.join(__dirname, '..', '..', 'apps', ID);
const META = JSON.parse(fs.readFileSync(path.join(APP, 'mgu-app.json'), 'utf8'));
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-test-'));
const APPDIR = path.join(ROOT, 'javascript');
fs.mkdirSync(APPDIR);
['watch.js', 'iface.js', 'catalog.js', 'target.js'].forEach((n) => fs.copyFileSync(path.join(APP, 'src', n), path.join(APPDIR, n)));
const { IFACE, PREFIX } = require(path.join(APPDIR, 'target.js'));

const CAT = {
    interfaces: {
        [IFACE]: { serviceId: 1, fields: {
            statusSeatHeatingDR: { getter: { id: 1 }, notifier: { eventId: 2 }, dataRef: 'X' },
            statusSeatHeatingPS: { getter: { id: 3 }, notifier: { eventId: 4 }, dataRef: 'X' },
            statusBroken: { getter: { id: 5 }, notifier: { eventId: 6 }, dataRef: 'X' },
            statusNoProxy: { notifier: { eventId: 7 }, dataRef: 'X' },
            statusSilent: { getter: { id: 0 }, dataRef: 'X' }
        }, events: {
            seatHeatingOperated: { eventId: 1, outputs: [] },
            wheelHeatingOperated: { eventId: 2, outputs: [] }
        } }
    },
    datatypes: {},
    instanceIDs: { [IFACE]: [{ name: 'Climate', instanceId: 7 }] }
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
    openState() { return Promise.resolve(); }
    mapEntryState() { return Promise.resolve(); }
    openEntryState() { return Promise.resolve(); }
}
const ENTRY = { uuid: 'e1', name: ID };
let app = null;
class OnlineApp extends EventEmitter {
    constructor() {
        super();
        app = this;
        this.rhmiApplication = new Rhmi();
        this.appDescription = { application: { entryPoints: [ENTRY] } };
        this.startReason = 'ENTRY_POINT';
    }
    getAppId() { return ID; }
    start() { return Promise.resolve(); }
    getEntryPoints() { return [{ getDescription: () => ENTRY, init: () => Promise.resolve(), setAvailability: () => Promise.resolve() }]; }
    registerActive() { return Promise.resolve(); }
    initialized() { this._initialized = true; return Promise.resolve(); }
}
/* The car's service: fields the test sets; statusBroken refuses subscribing; statusNoProxy has no attribute. */
const subs = {};
const values = { statusSeatHeatingDR: { level: 0 }, statusSeatHeatingPS: { level: 0 }, statusBroken: 1 };
let built = null;
const tried = [];
const someipBuilders = {
    buildTypedProxy: (iface, instance) => {
        built = `${iface} ${instance}`;
        tried.push(instance);
        // the SDK refuses every instance but 7, as the car did for "[object Object]"
        const proxy = { init: () => (instance === '7' ? Promise.resolve() :
            Promise.reject(new Error("Instance not available in 'instances' section of interface configuration"))),
        waitUntilAvailable: () => Promise.resolve() };
        // one event through its own attribute, the other through the proxy's subscribe({ name, onReceive })
        proxy.seatHeatingOperated = { subscribe: (cb) => { subs.seatHeatingOperated = cb; return Promise.resolve(); } };
        proxy.subscribe = (o) => { subs[o.name] = o.onReceive; return Promise.resolve(); };
        ['statusSeatHeatingDR', 'statusSeatHeatingPS', 'statusBroken', 'statusSilent'].forEach((f) => {
            proxy[f] = {
                subscribe: (cb) => (f === 'statusBroken' ? Promise.reject(new Error('access denied')) : (subs[f] = cb, Promise.resolve())),
                getValue: () => Promise.resolve(values[f])
            };
        });
        return Promise.resolve(proxy);
    }
};
const logged = [];
const quiet = { info(l) { logged.push(String(l)); }, warn(l) { logged.push(String(l)); }, error(l) { logged.push(String(l)); } };
let catFile = CAT_FILE;
const realIface = require(path.join(APPDIR, 'iface.js'));
const stubs = {
    'oap-sdk/src/core/OnlineApp.js': OnlineApp,
    'oap-sdk/src/logging/logging': { getSDKLogger: () => quiet },
    'oap-sdk/src/someip/someipBuilders': someipBuilders,
    './iface.js': { readInterface: (o) => realIface.readInterface(Object.assign({}, o, { file: catFile })) }
};
const load = Module._load;
Module._load = function (req) { return stubs[req] || load.apply(this, arguments); };
require(path.join(APPDIR, 'watch.js'));
Module._load = load;

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
const L = `${PREFIX}Log`;
const S = `${PREFIX}Status`;
const last = (prefix) => {
    const w = writes.filter((x) => x.indexOf(prefix + '=') === 0).pop();
    return w ? w.slice(prefix.length + 1) : undefined;
};
const row = (i) => last(`${L}.${i}.PrimaryText`);
async function until(pred, what) {
    for (let i = 0; i < 300; i++) {
        if (pred()) { return; }
        await tick(10);
    }
    throw new Error(`timed out waiting for ${what}\n${logged.join('\n')}\n${writes.slice(-10).join('\n')}`);
}

(async () => {
    app.emit('initialized');
    await until(() => /watching \d+ fields/.test(last(`${S}.0.Text`) || ''), 'watching');
    await tick(400);
    assert.strictEqual(built, `${IFACE} 7`, 'instance from the catalogue record');
    assert.deepStrictEqual(tried, ['7'], 'the id-like key tried first');
    const short = IFACE.split('.').pop();
    console.log('status:', last(`${S}.0.Text`));
    assert.strictEqual(last(`${S}.0.Text`), `${short} (instance 7): watching 2 fields and 2 events, 0 changes, 2 not watchable ` +
        '(first: statusBroken: access denied). Press the car\'s heating buttons now.');
    assert.strictEqual(last(`${L}.rows`), '3', 'three start rows (getter id 0 not read)');
    assert.ok(/^\d\d:\d\d:\d\d start · statusSeatHeatingDR = \{"level":0\}$/.test(row(2) || row(1) || row(0)), 'start row');

    // the driver's seat goes to level 2: newest row first
    subs.statusSeatHeatingDR({ level: 2 });
    await until(() => last(`${L}.rows`) === '4', 'the change row');
    await tick(50);
    console.log('newest:', row(0));
    assert.ok(/^\d\d:\d\d:\d\d statusSeatHeatingDR = \{"level":2\}$/.test(row(0)), 'change row: ' + row(0));
    assert.ok(/1 changes/.test(last(`${S}.0.Text`)), 'change counted');

    // the same value again adds nothing
    subs.statusSeatHeatingDR({ level: 2 });
    await tick(400);
    assert.strictEqual(last(`${L}.rows`), '4', 'repeat ignored');

    // the passenger's seat
    subs.statusSeatHeatingPS({ level: 1 });
    await until(() => last(`${L}.rows`) === '5', 'passenger row');
    await tick(50);
    assert.ok(/statusSeatHeatingPS = \{"level":1\}$/.test(row(0)));

    // events: always a row, with what they carry
    subs.seatHeatingOperated({ clientGroupId: 4, operationZone: 1, configuredIntensityLevel: 2 });
    await until(() => last(`${L}.rows`) === '6', 'event row');
    await tick(50);
    assert.ok(/^\d\d:\d\d:\d\d EVENT seatHeatingOperated = \{"clientGroupId":4,"operationZone":1,"configuredIntensityLevel":2\}$/.test(row(0)), row(0));
    subs.wheelHeatingOperated({ clientGroupId: 4 });
    await until(() => last(`${L}.rows`) === '7', 'second event row');
    subs.wheelHeatingOperated({ clientGroupId: 4 });
    await until(() => last(`${L}.rows`) === '8', 'repeated event still a row');

    // Clear log
    byName[`${PREFIX}Clear`].emit('action', {});
    await until(() => last(`${L}.rows`) === '0', 'cleared');
    assert.ok(/0 changes/.test(last(`${S}.0.Text`)));
    subs.statusSeatHeatingDR({ level: 0 });
    await until(() => last(`${L}.rows`) === '1', 'row after clearing');

    assert.ok(!logged.some((l) => /MISS|failed:/.test(l)), 'no warnings:\n' + logged.join('\n'));
    console.log(`${ID}: Heat Watch checks passed`);

    // the candidates: a record's id-like keys first, then its other values, then '1'
    const { candidates } = realIface;
    assert.deepStrictEqual(candidates([{ name: 'Climate', instanceId: 7 }]), ['7', 'Climate', '1']);
    assert.deepStrictEqual(candidates(['3']), ['3', '1']);
    assert.deepStrictEqual(candidates(undefined), ['1']);
    assert.deepStrictEqual(candidates({ instances: [{ id: 'Inst2' }] }), ['Inst2', '1']);

    // an interface missing from the catalogue: a second run
    fs.writeFileSync(CAT_FILE, JSON.stringify({ interfaces: {}, datatypes: {} }));
    const r = await realIface.readInterface({ name: IFACE, file: CAT_FILE });
    assert.deepStrictEqual([r.found, r.error], [false, 'not in the catalogue']);
    console.log('missing interface reported');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
