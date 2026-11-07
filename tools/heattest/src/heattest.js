/**
 * heattest - Heat Test: buttons that each send one seat-heating or
 * steering-wheel-heating command by one route, so the route the car
 * accepts can be found before the climate strip is built on it.
 *
 * Routes (names from the head unit's catalogue, src/types.js builds the
 * values from its data types):
 *   Climate.seatHeatingLamination (field set): the driver's or passenger's
 *     seat stage STUFE_<level>; every other member "no action" (KEINE_AKTION)
 *     or 0
 *   ClimateMaster.requestSeatClimateSeatHeating (method): level and
 *     operationZone DRIVER / PASSENGER, with the client id
 *   ClimateMaster.requestSteeringWheelHeating (method): level, client id
 *   SteeringWheelClimate.requestHeating (method): heating on / off, the
 *     client id as the requestor's first byte
 *
 * A command is sent only when its button is pressed. Each is tried with enum
 * names, and again with their numbers if the car refuses the names; the log
 * shows what was sent, how, and the car's answer or error. The status line
 * shows the seats' and wheel's live levels (Climate statusSeatHeatingDR / PS,
 * SteeringWheelClimate heatingState).
 *
 * The app's structure (OnlineApp, the RHMI state, presses, entry point,
 * visibility, typed proxies) follows the MGU Store's src/store.js
 * (robertnisipeanu/mgu-store, GPL-3.0). Node 8 compatible.
 */
'use strict';
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const { readInterface } = require('./iface.js');
const { loadCatalog } = require('./types.js');

const logger = logging.getSDKLogger();

const CLIMATE = 'de.bmw.infotainment.climate.Climate';
const MASTER = 'de.bmw.infotainment.climate.climatemaster.ClimateMaster';
const WHEEL = 'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate';

const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const ROW_KEY = 2;
const CALL_MS = 6000;                   // a command's answer is waited for this long
const MAX_ROWS = 60;
const TEXT_MAX = 220;
const STATE = 'ST_OnlineApps_MyStripHeatTest';
const C = { status: 'HeatTestStatus', actions: 'HeatTestActions', log: 'HeatTestLog' };

function isTrue(v) {
    return v === true || v === 1 || v === 'true' || v === '1';
}

function clock(d) {
    const p = (n) => (n < 10 ? '0' : '') + n;
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function show(v) {
    let s;
    try {
        s = v === undefined ? 'no answer value' : (typeof v === 'string' ? v : JSON.stringify(v));
    } catch (e) {
        s = String(v);
    }
    return s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) + '…' : s;
}

function within(p, ms, what) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms);
        Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}

class HeatTest extends OnlineApp {
    constructor() {
        super();
        this._state = null;
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._sizing = {};
        this._visibleStates = new Set();
        this._visible = false;
        this._hideTimer = null;
        this._shutdownPromise = null;
        this._started = false;
        this._cat = null;               // the catalogue (src/types.js)
        this._proxies = {};             // iface -> Promise<typed proxy>
        this._level = 1;                // the level the buttons send
        this._client = 1;               // the client id the ClimateMaster / wheel requests carry
        this._busy = false;             // a command is being sent
        this._live = { dr: '?', ps: '?', wheel: '?' };
        this._last = 'Press a button to send one command.';
        this._rows = [];

        this.on('initialized', () => {
            this._appInitialized().catch((err) => logger.error(`heattest init failed: ${err && err.message}`));
        });
        this.on('shutdown', (reason) => this._handleShutdown(reason));
        this.on('error', (err) => logger.warn(`OnlineApp error: ${err && err.message}`));
        this.on('entryPointExecute', (uuid) => this._onEntryPointExecute(uuid));
        this.on('changeVisibility', (data) => {
            if (data && data.visible === false) {
                this._visibleStates.clear();
                this._setVisible(false);
            }
        });
    }

    /* ---- the buttons ---- */

    _actions() {
        const lvl = this._level;
        return [
            { text: `Level to send: ${lvl} (tap to change)`, run: () => { this._level = (this._level + 1) % 4; } },
            { text: `Client id: ${this._client} (tap to change)`, run: () => { this._client = (this._client + 1) % 10; } },
            { text: `Driver seat → ${lvl} · Climate`, send: () => this._lamination('DR', lvl) },
            { text: `Passenger seat → ${lvl} · Climate`, send: () => this._lamination('PS', lvl) },
            { text: `Driver seat → ${lvl} · ClimateMaster`, send: () => this._masterSeat('DRIVER', lvl) },
            { text: `Passenger seat → ${lvl} · ClimateMaster`, send: () => this._masterSeat('PASSENGER', lvl) },
            { text: 'Wheel on · SteeringWheelClimate', send: () => this._wheelRequest(true) },
            { text: 'Wheel off · SteeringWheelClimate', send: () => this._wheelRequest(false) },
            { text: `Wheel → ${lvl} · ClimateMaster`, send: () => this._masterWheel(lvl) },
            { text: 'Clear log', run: () => { this._rows = []; } }
        ];
    }

    _press(row) {
        const a = this._actions()[row];
        if (!a) {
            return;
        }
        if (a.run) {
            a.run();
            this._render();
            return;
        }
        if (this._busy) {
            this._last = 'Still sending the last command: wait for its answer.';
            this._render();
            return;
        }
        this._busy = true;
        this._last = `Sending: ${a.text}…`;
        this._render();
        Promise.resolve()
            .then(() => this._ready())
            .then(() => a.send())
            .then((r) => this._log(a.text, `OK ${r}`), (err) => this._log(a.text, `FAILED ${err && err.message}`))
            .then(() => {
                this._busy = false;
                this._render();
            });
    }

    _log(what, result) {
        const line = `${clock(new Date())} ${what}: ${result}`;
        logger.info(`heattest ${line}`);
        this._last = line;
        this._rows.unshift(line.length > TEXT_MAX ? line.slice(0, TEXT_MAX) + '…' : line);
        if (this._rows.length > MAX_ROWS) {
            this._rows.length = MAX_ROWS;
        }
    }

    /* ---- the routes ---- */

    _lamination(seat, level) {
        const field = 'seatHeatingLamination';
        const f = (this._cat.iface(CLIMATE) || {}).fields || {};
        if (!f[field]) {
            return Promise.reject(new Error(`${field} not in the catalogue`));
        }
        const ref = f[field].dataRef;
        const target = `operationFunctionStageSeatHeater${seat}`;
        const value = this._cat.fill(ref, (path) => (path === target ? `STUFE_${level}` : undefined));
        return this._send(CLIMATE, 'set', field, value, this._cat.numeric(value, ref));
    }

    _masterSeat(zone, level) {
        const pick = (path) => ({
            clientGroupId: this._client,
            'seatClimateHeating.configuredIntensityLevel': level,
            'seatClimateHeating.operationZone': zone,
            saveLUM: false
        })[path];
        return this._method(MASTER, 'requestSeatClimateSeatHeating', pick);
    }

    _masterWheel(level) {
        const pick = (path) => ({ clientGroupId: this._client, steeringWheelHeating: level, saveLUM: false })[path];
        return this._method(MASTER, 'requestSteeringWheelHeating', pick);
    }

    _wheelRequest(on) {
        const pick = (path) => (path === 'heating' ? on : (path === 'requestor[0]' ? this._client : undefined));
        return this._method(WHEEL, 'requestHeating', pick);
    }

    /* A method's arguments from its inputs in the catalogue: an input with a
     * dimension is an array of its minimum length. */
    _method(iface, name, pick) {
        const m = ((this._cat.iface(iface) || {}).methods || {})[name];
        if (!m) {
            return Promise.reject(new Error(`${name} not in the catalogue`));
        }
        const inputs = m.inputs || m.inArgs || [];
        const named = {};
        const numbered = {};
        inputs.forEach((arg) => {
            let v;
            if (arg.dimension) {
                v = [];
                for (let i = 0; i < Number(arg.arrayMinLength || 0); i++) {
                    v.push(this._cat.fill(arg.dataRef, (p) => pick(`${arg.name}[${i}]${p ? '.' + p : ''}`)));
                }
                numbered[arg.name] = v.map((x) => this._cat.numeric(x, arg.dataRef));
            } else {
                v = this._cat.fill(arg.dataRef, (p) => pick(p ? `${arg.name}.${p}` : arg.name));
                numbered[arg.name] = this._cat.numeric(v, arg.dataRef);
            }
            named[arg.name] = v;
        });
        return this._send(iface, 'call', name, named, numbered);
    }

    /* Sends with enum names, then with their numbers if the names are refused. */
    _send(iface, how, name, value, numbers) {
        const short = iface.split('.').pop();
        const once = (v) => this._proxy(iface).then((p) => within(how === 'set' ? this._set(p, name, v) : this._call(p, name, v),
            CALL_MS, `${short}.${name}`));
        logger.info(`heattest send ${short}.${name} ${show(value)}`);
        return once(value).then((r) => `${short}.${name} ${show(value)} → ${show(r)}`, (err) => {
            if (JSON.stringify(numbers) === JSON.stringify(value)) {
                throw err;
            }
            logger.info(`heattest names refused (${err && err.message}); with numbers`);
            return once(numbers).then((r) => `${short}.${name} (numbers) ${show(numbers)} → ${show(r)}`,
                (err2) => { throw new Error(`${short}.${name}: names: ${err && err.message}; numbers: ${err2 && err2.message}`); });
        });
    }

    /* The native proxy inside the SDK's typed one does both, as the open kits use it. */
    _call(p, name, args) {
        const n = p && p._someIpProxy;
        if (n && typeof n.callMethod === 'function') {
            return n.callMethod(name, args, CALL_MS);
        }
        if (typeof p[name] === 'function') {
            return p[name](args);
        }
        return Promise.reject(new Error(`no way to call ${name}`));
    }

    _set(p, field, value) {
        const n = p && p._someIpProxy;
        if (n && typeof n.setValue === 'function') {
            return n.setValue(field, value, CALL_MS);
        }
        if (p[field] && typeof p[field].setValue === 'function') {
            return p[field].setValue(value);
        }
        return Promise.reject(new Error(`no way to set ${field}`));
    }

    /* A typed proxy for iface: the first instance from the catalogue the SDK accepts. */
    _proxy(iface) {
        if (!this._proxies[iface]) {
            this._proxies[iface] = readInterface({ name: iface }).then((r) => {
                if (!r.found) {
                    throw new Error(`${iface}: ${r.error}`);
                }
                const tried = [];
                const next = (i) => {
                    if (i >= r.instances.length) {
                        throw new Error(`${iface.split('.').pop()}: no instance accepted (${tried.join('; ')})`);
                    }
                    let p = null;
                    return Promise.resolve(someipBuilders.buildTypedProxy(iface, r.instances[i]))
                        .then((b) => { p = b; return p.init(); })
                        .then(() => p, (err) => { tried.push(`${r.instances[i]}: ${err && err.message}`); return next(i + 1); });
                };
                return next(0);
            });
            this._proxies[iface].catch(() => { delete this._proxies[iface]; });
        }
        return this._proxies[iface];
    }

    _ready() {
        if (this._cat) {
            return Promise.resolve();
        }
        return loadCatalog().then((cat) => { this._cat = cat; });
    }

    /* The live levels in the status line. */
    _watchLive() {
        const sub = (iface, field, fn) => this._proxy(iface)
            .then((p) => {
                const a = p[field];
                if (!a) {
                    throw new Error('not in the app\'s interface');
                }
                const pr = [];
                if (typeof a.subscribe === 'function') {
                    pr.push(a.subscribe((v) => { fn(v); this._render(); }));
                }
                if (typeof a.getValue === 'function') {
                    pr.push(Promise.resolve(a.getValue()).then((v) => { fn(v); this._render(); }));
                }
                return Promise.all(pr);
            })
            .catch((err) => logger.info(`heattest live ${field}: ${err && err.message}`));
        const level = (v, k) => (v && typeof v === 'object' && k in v ? v[k] : show(v));
        sub(CLIMATE, 'statusSeatHeatingDR', (v) => { this._live.dr = level(v, 'statusSeatHeaterDR'); });
        sub(CLIMATE, 'statusSeatHeatingPS', (v) => { this._live.ps = level(v, 'statusSeatHeaterPS'); });
        sub(WHEEL, 'heatingState', (v) => { this._live.wheel = v && typeof v === 'object' && 'heating' in v ? (v.heating ? 'on' : 'off') : show(v); });
    }

    /* ---- the app ---- */

    _appInitialized() {
        logger.info(`heattest ${this.getAppId()} starting`);
        if (!this.rhmiApplication) {
            return this.initialized();
        }
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        const foreground = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'].indexOf(reason) >= 0;
        return this._setupRhmi()
            .then(() => this._registerEntryPoints())
            .then(() => {
                if (foreground) {
                    this.registerActive();
                }
                return this.initialized();
            })
            .then(() => {
                if (foreground) {
                    this._setVisible(true);
                }
                const lastUuid = this.getLastExecutedEntryPointUuid && this.getLastExecutedEntryPointUuid();
                return lastUuid ? this._onEntryPointExecute(lastUuid) : undefined;
            });
    }

    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        this._state = rhmi.getByName(STATE);
        if (!this._state) {
            return Promise.reject(new Error(`uiDescription has no ${STATE}`));
        }
        Object.keys(C).forEach((k) => {
            this._components[C[k]] = rhmi.getByName(C[k]);
            if (!this._components[C[k]]) {
                logger.warn(`BIND MISS: ${C[k]} not found in uiDescription`);
            }
        });
        this._bind(C.actions, (row) => this._press(row));
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) {
                this._pressed(entry.name, entry.handler, Number((ev.parameterMap || {})[ROW_KEY]) || 0);
            }
        });
        rhmi.on('restoreHmi', () => {
            this._written = {};
            this._render();
        });
        this._state.on('visible', (event) => {
            if (isTrue(event && event.visible)) {
                this._visibleStates.add(STATE);
                this._setVisible(true);
            } else {
                this._visibleStates.delete(STATE);
                clearTimeout(this._hideTimer);
                this._hideTimer = setTimeout(() => {
                    if (this._visibleStates.size === 0) {
                        this._setVisible(false);
                    }
                }, HIDE_SETTLE_MS);
            }
        });
        return Promise.resolve(this._state.updateResources());
    }

    _registerEntryPoints() {
        const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find((ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._state))
            .then(() => ours.setAvailability('ENABLED'))
            .then(() => logger.info(`entry point ${description.name} ENABLED`));
    }

    _onEntryPointExecute(uuid) {
        if (this._shutdownPromise || !this.rhmiApplication || !uuid) {
            return Promise.resolve();
        }
        this._setVisible(true);
        return Promise.resolve(this.rhmiApplication.openEntryState(uuid))
            .catch((err) => logger.warn(`openEntryState failed: ${err && err.message}`));
    }

    _bind(name, handler) {
        const comp = this._components[name];
        if (!comp) {
            return;
        }
        let id = null;
        try {
            id = comp.getId();
        } catch (e) {
            id = null;
        }
        if (id !== null && id !== undefined) {
            this._actionById[Number(id)] = { name, handler };
        }
        comp.on('action', (ev) => this._pressed(name, handler, Number(ev && ev.row) || 0));
    }

    /* Presses arrive both as the component's action and the raw userEvent: one counts. */
    _pressed(name, handler, row) {
        const now = Date.now();
        const key = `${name}.${row}`;
        if (now - (this._lastPress[key] || 0) < PRESS_DEDUPE_MS) {
            return;
        }
        this._lastPress[key] = now;
        logger.info(`BUTTON ACTION ${name} row ${row}`);
        try {
            handler(row);
        } catch (err) {
            logger.warn(`${name} failed: ${err && err.message}`);
        }
    }

    _setCell(name, cell, value, row) {
        row = row || 0;
        const comp = this._components[name];
        const key = `${name}.${row}.${cell}`;
        if (!comp || this._written[key] === value) {
            return;
        }
        this._written[key] = value;
        Promise.resolve(comp.setValue(row, cell, value, 'Text'))
            .catch((err) => logger.warn(`render ${key} failed: ${err && err.message}`));
    }

    _show(name, visible) {
        const comp = this._components[name];
        const key = `${name}.visible`;
        if (!comp || this._written[key] === visible) {
            return;
        }
        this._written[key] = visible;
        Promise.resolve(comp.setProperty('Visible', visible ? 1 : 0, 'UInt'))
            .catch((err) => logger.warn(`visibility ${name} failed: ${err && err.message}`));
    }

    _list(name, rows) {
        const comp = this._components[name];
        this._show(name, rows.length > 0);
        if (!comp || this._sizing[name]) {
            return;
        }
        const countKey = `${name}.rows`;
        if (this._written[countKey] !== rows.length) {
            Object.keys(this._written).filter((k) => k.indexOf(`${name}.`) === 0).forEach((k) => delete this._written[k]);
            this._written[countKey] = rows.length;
            this._sizing[name] = true;
            Promise.resolve(comp.setRowCount(rows.length))
                .catch((err) => logger.warn(`row count ${name} failed: ${err && err.message}`))
                .then(() => {
                    this._sizing[name] = false;
                    this._render();
                });
            return;
        }
        rows.forEach((text, i) => this._setCell(name, 'PrimaryText', text, i));
    }

    _render() {
        if (!this._visible || this._shutdownPromise) {
            return;
        }
        const l = this._live;
        this._setCell(C.status, 'Text', `Now: driver seat ${l.dr} · passenger seat ${l.ps} · wheel ${l.wheel}. ${this._last}`);
        this._list(C.actions, this._actions().map((a) => a.text));
        this._list(C.log, this._rows);
    }

    _setVisible(visible) {
        if (this._shutdownPromise || this._visible === visible) {
            return;
        }
        this._visible = visible;
        clearTimeout(this._hideTimer);
        logger.info(`screen ${visible ? 'visible' : 'hidden'}`);
        if (visible) {
            this._written = {};
            this._render();
            if (!this._started) {
                this._started = true;
                this._ready().catch((err) => { this._last = `Catalogue not read: ${err && err.message}`; this._render(); });
                this._watchLive();
            }
        }
        if (!this._initialized || !this._appStatusService) {
            return;
        }
        const reports = visible ? [this.registerActive(), this.registerHmiVisible()] :
            [this.unregisterHmiVisible(), this.registerInactive()];
        reports.forEach((rep) => Promise.resolve(rep).catch((err) => logger.warn(`app status report failed: ${err && err.message}`)));
    }

    _handleShutdown(reason) {
        if (this._shutdownPromise) {
            return this._shutdownPromise;
        }
        logger.info(`heattest shutting down (${reason})`);
        clearTimeout(this._hideTimer);
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) => logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new HeatTest();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`heattest failed to start: ${err && err.message}`);
});
