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
 * A second seat command, to try: BMW's own level (off, low … very high), the
 * one the car's climate bar indicator follows. Its field is looked up in the
 * catalogue: a settable Climate field, not seatHeatingLamination, with a
 * member for that seat whose values run to STUFE_4 (BMW's five levels). The
 * route row picks which one the seat rows and the bar's taps send.
 *
 * The screen shows the three heating rows and Settings; Settings holds the
 * seat command and the bar's rows (on / off, line up), with Back.
 *
 * A command is sent only when a row, or a button of the Climate Bar, is
 * tapped. Values are built from the head unit's catalogue (src/types.js).
 *
 * The Climate Bar (services/mystrip_bar) draws the same three buttons in the
 * climate bar. It sends nothing to the car itself: this app keeps it told
 * what the car reports and sends what its buttons ask for (src/bar_link.js),
 * from the head unit's start, whether or not this screen is open. The rows
 * below the heating turn the bar on or off and line its buttons up over
 * BMW's own indicators.
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
const { BarLink } = require('./bar_link.js');

const logger = logging.getSDKLogger();

const CLIMATE = 'de.bmw.infotainment.climate.Climate';
const WHEEL = 'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate';
const STAGES = 4;                       // seatHeatingLamination's stages: STUFE_0 .. STUFE_3
const LEVELS = ['off', 'low', 'medium', 'high', 'very high'];   // statusSeatHeaterAUTO STUFE_0 .. STUFE_4
const NAMES = { dr: 'your seat', ps: 'the passenger seat', wheel: 'the steering wheel' };
const SHADE_COUNT = 4;
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
        this._link = null;
        this._bar = null;               // the Climate Bar's status; null while it is not connected
        this._carKey = '';
        this._view = 'main';            // the heating rows, or 'settings': the seat command and the bar's rows
        this._route = 'stage';          // the seats' command: 'stage' (seatHeatingLamination) or 'level' (BMW's level)

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
        if (this._view === 'settings') {
            return [{ text: '‹ Back', view: 'main' }, { text: this._routeText(), route: true }].concat(this._barRows());
        }
        return [
            { text: this._seatText('Your seat (driver)', c.dr), heat: 'dr' },
            { text: this._seatText('Passenger seat', c.ps), heat: 'ps' },
            { text: `Steering wheel: ${c.wheel === null ? '?' : (c.wheel ? 'on' : 'off')}`, heat: 'wheel' },
            { text: 'Settings ›', view: 'settings' }
        ];
    }

    /* The Climate Bar's rows: on / off, and while lining up, the moves. */
    _barRows() {
        const b = this._bar;
        if (!b) {
            return [{ text: 'Climate bar: not running (install Climate Bar from the Store)' }];
        }
        const send = (m) => () => this._link.send(m);
        const on = b.enabled && !b.safe;
        const rows = [
            { text: b.safe ? 'Climate bar: off after quick restarts (safe mode), tap to turn it on' :
                `Climate bar: ${on ? 'on' : 'off'}`, bar: send({ cmd: 'enable', on: !on }) },
            { text: `Line up the bar's buttons: ${b.lineup ? 'on' : 'off'}`, bar: send({ cmd: 'lineup', on: !b.lineup }) }
        ];
        if (!b.lineup) {
            return rows;
        }
        const s = b.settings || {};
        return rows.concat([
            { text: this._positions(s), bar: null },
            { text: `Moving ${NAMES[b.selected] || b.selected} (tap for the next, or tap it on the bar)`, bar: send({ cmd: 'select' }) },
            { text: `Left ${b.step} px`, bar: send({ cmd: 'move', dx: -1 }) },
            { text: `Right ${b.step} px`, bar: send({ cmd: 'move', dx: 1 }) },
            { text: `Up ${b.step} px`, bar: send({ cmd: 'move', dy: -1 }) },
            { text: `Down ${b.step} px`, bar: send({ cmd: 'move', dy: 1 }) },
            { text: `Step: ${b.step} px (tap to change)`, bar: send({ cmd: 'step' }) },
            { text: `Bigger (size ${s.size})`, bar: send({ cmd: 'size', d: 1 }) },
            { text: `Smaller (size ${s.size})`, bar: send({ cmd: 'size', d: -1 }) },
            { text: { drawn: 'Seat icons: always drawn (tap for never)', invisible: 'Seat icons: never drawn, BMW\'s only (tap for auto)' }[s.seats] ||
                'Seat icons: auto, BMW\'s own at very high (tap for always)', bar: send({ cmd: 'seats' }) }
        ]).concat(s.seats !== 'drawn' ? [] : [
            { text: `Patch behind the seat buttons: ${s.cover ? 'on' : 'off'}`, bar: send({ cmd: 'cover' }) },
            { text: `Patch colour: ${(s.shade || 0) + 1} of ${SHADE_COUNT} (tap for the next)`, bar: send({ cmd: 'shade' }) }
        ]).concat([
            { text: 'Put the buttons back where they started', bar: send({ cmd: 'reset' }) }
        ]);
    }

    /* The buttons' places as numbers, to note down: x across the screen
     * (0-2880), y down it (the climate bar is 840-960), the icons' size. */
    _positions(s) {
        const it = s.items || {}, at = (k) => (it[k] ? `${it[k].x}, ${it[k].y}` : '?');
        return `Numbers: passenger ${at('ps')} · yours ${at('dr')} · wheel ${at('wheel')} · size ${s.size}`;
    }

    _tap(row) {
        const r = this._rows()[row];
        if (!r) {
            return;
        }
        if (r.bar) {
            r.bar();
            return;
        }
        if (r.bar === null) {
            return;
        }
        if (r.view) {
            this._view = r.view;
            this._render();
            return;
        }
        if (r.route) {
            this._route = this._route === 'stage' ? 'level' : 'stage';
            this._entry(`Seat command: ${this._routeText().replace(/^Seat command: /, '')}`);
            this._render();
            return;
        }
        if (r.heat) {
            this._heat(r.heat, 'row');
        }
    }

    /* A seat stepped up or the wheel turned on / off, from a row or the bar. */
    _heat(item, from) {
        const job = { dr: () => this._stepSeat('dr'), ps: () => this._stepSeat('ps'), wheel: () => this._toggleWheel() }[item];
        if (!job) {
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
            .then(() => job())
            .then((what) => this._entry(`${what}${from === 'bar' ? ' (climate bar)' : ''}: OK`),
                (err) => this._entry(`FAILED ${err && err.message}`))
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
    _routeText() {
        if (this._route === 'stage') {
            return 'Seat command: heater stage (tap to try BMW\'s level)';
        }
        const r = this._cat && this._levelRoute('dr');
        return r ? `Seat command: BMW's level, ${r.field} (tap for heater stage)` :
            'Seat command: BMW\'s level, none found in the catalogue (tap for heater stage)';
    }

    /* The Climate field that sets BMW's level for a seat: settable, not
     * seatHeatingLamination, with a member for that seat whose values run to
     * STUFE_4. { field, member, ref } or null. */
    _levelRoute(seat) {
        const f = (this._cat.iface(CLIMATE) || {}).fields || {};
        const side = seat === 'dr' ? /(DR|Driver|Fahrer)$/i : /(PS|Passenger|Codriver|Beifahrer|BF)$/i;
        const toFour = (ref) => {
            const d = this._cat.resolveRef(ref).d;
            return !!(d && d.type === 'enum' && d.items && Object.prototype.hasOwnProperty.call(d.items, 'STUFE_4'));
        };
        const names = Object.keys(f).sort();
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            if (name === 'seatHeatingLamination' || !f[name].setter) {
                continue;
            }
            const m = this._cat.members(f[name].dataRef).filter((x) => /Seat/i.test(x.name) && side.test(x.name) && toFour(x.dataRef))[0];
            if (m) {
                return { field: name, member: m.name, ref: f[name].dataRef };
            }
        }
        return null;
    }

    _stepSeat(seat) {
        if (this._route === 'level') {
            return this._stepLevel(seat);
        }
        const reported = this._car[seat].stage;
        const from = typeof reported === 'number' && reported >= 0 && reported < STAGES ? reported : this._sent[seat];
        const next = (from + 1) % STAGES;
        return this._setSeat(seat, next).then(() => {
            this._sent[seat] = next;
            return `${seat === 'dr' ? 'Driver' : 'Passenger'} seat → stage ${next}`;
        });
    }

    /* BMW's level one up from the level the car reports, off after very high. */
    _stepLevel(seat) {
        const r = this._levelRoute(seat);
        if (!r) {
            return Promise.reject(new Error('no BMW level field in the catalogue'));
        }
        const now = this._car[seat].level;
        const next = ((typeof now === 'number' ? now : 0) + 1) % LEVELS.length;
        const value = this._cat.fill(r.ref, (path) => (path === r.member ? `STUFE_${next}` : undefined));
        return this._proxy(CLIMATE).then((p) => within(this._setField(p, r.field, value), CALL_MS, r.field))
            .then(() => `${seat === 'dr' ? 'Driver' : 'Passenger'} seat → ${LEVELS[next]} (${r.field}.${r.member})`);
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
                    pr.push(a.subscribe((v) => { fn(v); this._changed(); }));
                }
                if (typeof a.getValue === 'function') {
                    pr.push(Promise.resolve(a.getValue()).then((v) => { fn(v); this._changed(); }));
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

    /* The car's state changed: the rows and the bar. */
    _changed() {
        const c = this._car;
        const car = { dr: { level: c.dr.level, stage: c.dr.stage }, ps: { level: c.ps.level, stage: c.ps.stage }, wheel: c.wheel };
        const key = JSON.stringify(car);
        if (this._link && key !== this._carKey) {
            this._carKey = key;
            this._link.send({ car });
        }
        this._render();
    }

    /* Watching the car and the bar's link, from the app's start. */
    _start() {
        if (this._started) {
            return;
        }
        this._started = true;
        this._ready().catch((err) => { this._note = `Catalogue not read: ${err && err.message}`; this._render(); });
        this._watchCar();
        this._link = new BarLink(logger);
        this._link.on('tap', (item) => {
            logger.info(`strip climate bar: ${item}`);
            this._heat(item, 'bar');
        });
        this._link.on('status', (s) => {
            this._bar = s;
            this._render();
        });
        this._link.start();
    }

    /* The bar's setting up, when it needs saying. */
    _barNote() {
        const b = this._bar;
        if (!b) {
            return '';
        }
        if (b.overlay === 'no renderer' || b.renderer === 'not running') {
            return 'Climate bar: the Store\'s Renderer is not running; install it from the Store.';
        }
        if (b.renderer === 'not mgu-render') {
            return 'Climate bar: another renderer is in charge; it needs the Store\'s Renderer.';
        }
        if (b.overlay === 'restart') {
            return 'Climate bar: restart the head unit once to finish setting it up.';
        }
        if (/^error/.test(b.overlay || '')) {
            return `Climate bar: could not set up the renderer (${b.overlay.slice(7)}).`;
        }
        if (b.touchRouting === false) {
            return 'Climate bar: the Renderer has touch turned off, so its buttons cannot be tapped.';
        }
        return '';
    }

    /* ---- the app ---- */

    _appInitialized() {
        logger.info(`strip ${this.getAppId()} starting`);
        this._start();
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
        const status = this._busy ? 'Sending…' : (this._note || this._barNote() ||
            'Tap a seat to step its heating up (off after the highest), the wheel to turn it on or off.');
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
            this._start();
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
        if (this._link) {
            this._link.stop();
        }
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
