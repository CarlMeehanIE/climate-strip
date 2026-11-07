/**
 * strip - Climate Strip, stage one: the seat and steering wheel heating as
 * an ordinary app, to prove the controls before they move into the climate
 * bar.
 *
 * Rows: your seat (the driver's), the passenger's seat, the steering wheel,
 * and a log of what was sent. A seat row steps its heating up one stage per
 * tap and back to off after the highest, like the car's own button; the
 * wheel row turns its heating on or off. Seats are addressed as driver and
 * passenger, never left and right, so the driver's button controls the
 * driver's seat on a right-hand-drive car too.
 *
 * Each row shows the level as the car reports it: BMW's level names from
 * Climate.statusAURAPerso (statusSeatHeaterAUTO…: STUFE_0 off, 1 low,
 * 2 medium, 3 high, 4 very high) and the heater's stage from
 * Climate.statusSeatHeatingDR / PS; the wheel from SteeringWheelClimate
 * heatingState.
 *
 * Commands, proven on the car with Heat Test:
 *   seats: Climate.seatHeatingLamination, the seat's
 *     operationFunctionStageSeatHeater<DR|PS> = STUFE_<stage> (0-3), every
 *     other member "no action" (KEINE_AKTION) or 0
 *   wheel: SteeringWheelClimate.requestHeating { requestor, heating }
 * A command is sent only when a row is tapped. Values are built from the
 * head unit's catalogue (src/types.js).
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
const WHEEL = 'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate';
const STAGES = 4;                       // seatHeatingLamination's stages: STUFE_0 .. STUFE_3
const LEVELS = ['off', 'low', 'medium', 'high', 'very high'];   // statusSeatHeaterAUTO STUFE_0 .. STUFE_4
const REQUESTOR = 1;                    // the wheel request's first requestor byte (Heat Test's default)

const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const ROW_KEY = 2;
const CALL_MS = 6000;
const MAX_LOG = 40;
const STATE = 'ST_OnlineApps_MyStripClimate';
const C = { status: 'ClimateStripStatus', rows: 'ClimateStripRows', log: 'ClimateStripLog' };

function isTrue(v) {
    return v === true || v === 1 || v === 'true' || v === '1';
}

function clock(d) {
    const p = (n) => (n < 10 ? '0' : '') + n;
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function within(p, ms, what) {
    return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`${what}: no answer in ${ms / 1000} s`)), ms);
        Promise.resolve(p).then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
}

/* STUFE_<n> or n -> n; anything else -> null. */
function stufe(v) {
    if (typeof v === 'number') {
        return v;
    }
    const m = /^STUFE_(\d+)$/.exec(String(v));
    return m ? Number(m[1]) : null;
}

/* The driver's and passenger's BMW levels in a statusAURAPerso value: its
 * statusSeatHeaterAUTO… members, the one naming the driver and the other. */
function autoLevels(v) {
    const out = { dr: null, ps: null };
    if (!v || typeof v !== 'object') {
        return out;
    }
    Object.keys(v).filter((k) => /SeatHeaterAUTO/i.test(k)).forEach((k) => {
        if (/Driver|DR$/i.test(k)) {
            out.dr = stufe(v[k]);
        } else if (/Passenger|Codriver|Beifahrer|PS$/i.test(k)) {
            out.ps = stufe(v[k]);
        }
    });
    return out;
}

class ClimateStrip extends OnlineApp {
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
        this._cat = null;
        this._proxies = {};
        this._busy = false;
        /* What the car reports: level (BMW's STUFE 0-4), stage (the heater's), wheel on. */
        this._car = { dr: { level: null, stage: null }, ps: { level: null, stage: null }, wheel: null };
        this._sent = { dr: 0, ps: 0 };  // the last stage sent to each seat
        this._note = '';
        this._log = [];

        this.on('initialized', () => {
            this._appInitialized().catch((err) => logger.error(`strip init failed: ${err && err.message}`));
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

    /* ---- the rows ---- */

    _seatText(label, s) {
        const level = s.level === null ? '?' : (LEVELS[s.level] || `level ${s.level}`);
        const stage = s.stage === null ? '' : `, heater stage ${s.stage}`;
        return `${label}: ${level}${stage}`;
    }

    _rows() {
        const c = this._car;
        return [
            { text: this._seatText('Your seat (driver)', c.dr), tap: () => this._stepSeat('dr') },
            { text: this._seatText('Passenger seat', c.ps), tap: () => this._stepSeat('ps') },
            { text: `Steering wheel: ${c.wheel === null ? '?' : (c.wheel ? 'on' : 'off')}`, tap: () => this._toggleWheel() }
        ];
    }

    _tap(row) {
        const r = this._rows()[row];
        if (!r) {
            return;
        }
        if (this._busy) {
            this._note = 'Still sending the last change.';
            this._render();
            return;
        }
        this._busy = true;
        this._note = '';
        this._render();
        Promise.resolve()
            .then(() => this._ready())
            .then(() => r.tap())
            .then((what) => this._entry(`${what}: OK`), (err) => this._entry(`FAILED ${err && err.message}`))
            .then(() => {
                this._busy = false;
                this._render();
            });
    }

    _entry(text) {
        const line = `${clock(new Date())} ${text}`;
        logger.info(`strip ${line}`);
        this._log.unshift(line.length > 200 ? line.slice(0, 200) + '…' : line);
        if (this._log.length > MAX_LOG) {
            this._log.length = MAX_LOG;
        }
    }

    /* One stage up from the heater's stage as the car reports it (Heat Test:
     * it follows the stage sent), or from the last stage sent while the car
     * has not reported one; off after the highest. */
    _stepSeat(seat) {
        const reported = this._car[seat].stage;
        const from = typeof reported === 'number' && reported >= 0 && reported < STAGES ? reported : this._sent[seat];
        const next = (from + 1) % STAGES;
        return this._setSeat(seat, next).then(() => {
            this._sent[seat] = next;
            return `${seat === 'dr' ? 'Driver' : 'Passenger'} seat → stage ${next}`;
        });
    }

    _setSeat(seat, stage) {
        const field = 'seatHeatingLamination';
        const f = (this._cat.iface(CLIMATE) || {}).fields || {};
        if (!f[field]) {
            return Promise.reject(new Error(`${field} not in the catalogue`));
        }
        const ref = f[field].dataRef;
        const target = `operationFunctionStageSeatHeater${seat === 'dr' ? 'DR' : 'PS'}`;
        const value = this._cat.fill(ref, (path) => (path === target ? `STUFE_${stage}` : undefined));
        return this._proxy(CLIMATE).then((p) => within(this._setField(p, field, value), CALL_MS, field));
    }

    _toggleWheel() {
        const on = !this._car.wheel;
        const m = ((this._cat.iface(WHEEL) || {}).methods || {}).requestHeating;
        if (!m) {
            return Promise.reject(new Error('requestHeating not in the catalogue'));
        }
        const args = {};
        (m.inputs || m.inArgs || []).forEach((a) => {
            if (a.name === 'heating') {
                args.heating = on;
            } else if (a.dimension) {
                args[a.name] = [];
                for (let i = 0; i < Number(a.arrayMinLength || 0); i++) {
                    args[a.name].push(i === 0 ? REQUESTOR : 0);
                }
            } else {
                args[a.name] = this._cat.fill(a.dataRef);
            }
        });
        return this._proxy(WHEEL).then((p) => within(this._callMethod(p, 'requestHeating', args), CALL_MS, 'requestHeating'))
            .then(() => `Steering wheel → ${on ? 'on' : 'off'}`);
    }

    /* The native proxy inside the SDK's typed one, as Heat Test uses it. */
    _callMethod(p, name, args) {
        const n = p && p._someIpProxy;
        if (n && typeof n.callMethod === 'function') {
            return n.callMethod(name, args, CALL_MS);
        }
        if (typeof p[name] === 'function') {
            return p[name](args);
        }
        return Promise.reject(new Error(`no way to call ${name}`));
    }

    _setField(p, field, value) {
        const n = p && p._someIpProxy;
        if (n && typeof n.setValue === 'function') {
            return n.setValue(field, value, CALL_MS);
        }
        if (p[field] && typeof p[field].setValue === 'function') {
            return p[field].setValue(value);
        }
        return Promise.reject(new Error(`no way to set ${field}`));
    }

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

    /* What the car reports, kept up to date. */
    _watchCar() {
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
            .catch((err) => logger.info(`strip ${field}: ${err && err.message}`));
        const num = (v, k) => (v && typeof v === 'object' && typeof v[k] === 'number' ? v[k] : null);
        sub(CLIMATE, 'statusAURAPerso', (v) => {
            const l = autoLevels(v);
            if (l.dr !== null) {
                this._car.dr.level = l.dr;
            }
            if (l.ps !== null) {
                this._car.ps.level = l.ps;
            }
        });
        sub(CLIMATE, 'statusSeatHeatingDR', (v) => { this._car.dr.stage = num(v, 'statusSeatHeaterDR'); });
        sub(CLIMATE, 'statusSeatHeatingPS', (v) => { this._car.ps.stage = num(v, 'statusSeatHeaterPS'); });
        sub(WHEEL, 'heatingState', (v) => { this._car.wheel = v && typeof v === 'object' && 'heating' in v ? !!v.heating : null; });
    }

    /* ---- the app ---- */

    _appInitialized() {
        logger.info(`strip ${this.getAppId()} starting`);
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
        this._bind(C.rows, (row) => this._tap(row));
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
        const status = this._busy ? 'Sending…' : (this._note || 'Tap a seat to step its heating up (off after the highest), the wheel to turn it on or off.');
        this._setCell(C.status, 'Text', status);
        this._list(C.rows, this._rows().map((r) => r.text));
        this._list(C.log, this._log);
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
                this._ready().catch((err) => { this._note = `Catalogue not read: ${err && err.message}`; this._render(); });
                this._watchCar();
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
        logger.info(`strip shutting down (${reason})`);
        clearTimeout(this._hideTimer);
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) => logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new ClimateStrip();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`strip failed to start: ${err && err.message}`);
});
