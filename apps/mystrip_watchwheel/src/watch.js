/**
 * watch - Heat Watch: shows a live log of every value that changes on one
 * SOME/IP interface (src/target.js: the seat-heating or steering-wheel
 * interface) while the car's own buttons are pressed, so a climate strip
 * app can be written against what those buttons really change.
 *
 * On open it reads the interface's fields and events from the catalogue
 * (src/iface.js), reads each field once ("start" rows) and subscribes to
 * every field that notifies and every event; each change or event becomes
 * a row, newest first (events marked EVENT, with everything they carry, such
 * as the id of the client that pressed a button). Clear log empties it.
 *
 * Read-only towards the car: it reads and subscribes, and sends no
 * commands.
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
const { IFACE, PREFIX } = require('./target.js');

const logger = logging.getSDKLogger();

const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const ROW_KEY = 2;
const MAX_ROWS = 150;                   // log rows kept, newest first
const MAX_FIELDS = 120;
const VALUE_MAX = 160;
const WAIT_NOTE_MS = 15000;             // after this the status says the service has not answered
const RENDER_MS = 300;                  // changes are drawn at most this often

const STATE = `ST_OnlineApps_${PREFIX}`;
const C = { status: `${PREFIX}Status`, clear: `${PREFIX}Clear`, log: `${PREFIX}Log` };

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
        s = typeof v === 'string' ? v : JSON.stringify(v);
    } catch (e) {
        s = String(v);
    }
    if (s === undefined) {
        s = String(v);
    }
    return s.length > VALUE_MAX ? s.slice(0, VALUE_MAX) + '…' : s;
}

class Watch extends OnlineApp {
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
        this._renderTimer = null;
        this._shutdownPromise = null;
        this._started = false;
        this._phase = 'Starting';       // what the status line says while not watching
        this._instance = null;          // the instance in use
        this._watching = 0;             // fields subscribed
        this._watchedEvents = 0;               // events subscribed
        this._failed = [];              // fields that could not be subscribed: 'name: why'
        this._changes = 0;
        this._rows = [];                // log rows, newest first
        this._last = {};                // each field's last value as shown

        this.on('initialized', () => {
            this._appInitialized().catch((err) => logger.error(`watch init failed: ${err && err.message}`));
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

    _appInitialized() {
        logger.info(`watch ${this.getAppId()} starting for ${IFACE}`);
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
        this._bind(C.clear, () => {
            this._rows = [];
            this._changes = 0;
            this._render();
        });
        rhmi.on('userEvent', (ev) => {
            const entry = ev && ev.eventType === 'ACTION' && this._actionById[Number(ev.sourceId)];
            if (entry) {
                this._press(entry.name, entry.handler, Number((ev.parameterMap || {})[ROW_KEY]) || 0);
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

    /* ---- watching ---- */

    _start() {
        if (this._started) {
            return Promise.resolve();
        }
        this._started = true;
        this._phase = 'Reading the catalogue…';
        this._render();
        let fields = [];
        let events = [];
        let proxy = null;
        let info = null;
        return readInterface({ name: IFACE })
            .then((r) => {
                if (!r.found) {
                    throw new Error(`${IFACE}: ${r.error}`);
                }
                info = r;
                fields = r.fields.filter((f) => f.notify || f.get).slice(0, MAX_FIELDS);
                events = (r.events || []).slice(0, MAX_FIELDS);
                logger.info(`${IFACE}: ${fields.length} fields, instances to try ${r.instances.join(', ')} (catalogue: ${r.raw})`);
                return this._connect(r.instances, r.raw);
            })
            .then((p) => {
                proxy = p;
            })
            .then(() => {
                this._phase = 'Waiting for the service…';
                this._render();
                const note = setTimeout(() => {
                    this._phase = 'The service has not answered yet: still waiting';
                    this._render();
                }, WAIT_NOTE_MS);
                return Promise.resolve(proxy.waitUntilAvailable()).then(() => clearTimeout(note));
            })
            .then(() => fields.reduce((p, f) => p.then(() => this._watchField(proxy, f)), Promise.resolve()))
            .then(() => events.reduce((p, e) => p.then(() => this._watchEvent(proxy, e)), Promise.resolve()))
            .then(() => {
                this._phase = null;
                logger.info(`watching ${this._watching} fields and ${this._watchedEvents} events, ${this._failed.length} failed`);
                this._render();
            })
            .catch((err) => {
                this._phase = `Could not watch: ${err && err.message}`;
                logger.warn(this._phase);
                this._render();
            });
    }

    /* The first instance the SDK accepts: each is built and initialised in
     * turn; one refused ("Instance not available") moves on to the next. */
    _connect(instances, raw) {
        const tried = [];
        const next = (i) => {
            if (i >= instances.length) {
                return Promise.reject(new Error(`no instance accepted (tried ${tried.join('; ')}; catalogue entry ${raw})`));
            }
            const inst = instances[i];
            this._instance = inst;
            this._phase = `Connecting to the service (instance ${inst})…`;
            this._render();
            let p = null;
            return Promise.resolve(someipBuilders.buildTypedProxy(IFACE, inst))
                .then((built) => {
                    p = built;
                    return p.init();
                })
                .then(() => p, (err) => {
                    tried.push(`${inst}: ${err && err.message}`.slice(0, 120));
                    logger.info(`instance ${inst} refused: ${err && err.message}`);
                    return next(i + 1);
                });
        };
        return next(0);
    }

    _watchField(proxy, f) {
        const attr = proxy[f.name];
        if (!attr) {
            this._failed.push(`${f.name}: not in the app's interface`);
            return Promise.resolve();
        }
        const steps = [];
        if (f.notify && typeof attr.subscribe === 'function') {
            steps.push(Promise.resolve(attr.subscribe((v) => this._value(f.name, v, false)))
                .then(() => { this._watching++; }));
        }
        if (f.get && typeof attr.getValue === 'function') {
            steps.push(Promise.resolve(attr.getValue()).then((v) => this._value(f.name, v, true)));
        }
        return Promise.all(steps).catch((err) => {
            this._failed.push(`${f.name}: ${err && err.message}`);
        });
    }

    /* An event: through its own attribute (proxy[name].subscribe), else the
     * proxy's subscribe({ name, onReceive }) as the native binding has it. */
    _watchEvent(proxy, name) {
        const cb = (v) => this._event(name, v);
        let sub = null;
        try {
            if (proxy[name] && typeof proxy[name].subscribe === 'function') {
                sub = proxy[name].subscribe(cb);
            } else if (typeof proxy.subscribe === 'function') {
                sub = proxy.subscribe({ name, onReceive: cb });
            } else {
                this._failed.push(`${name}: no way to subscribe to the event`);
                return Promise.resolve();
            }
        } catch (err) {
            this._failed.push(`${name}: ${err && err.message}`);
            return Promise.resolve();
        }
        return Promise.resolve(sub).then(() => { this._watchedEvents++; }, (err) => {
            this._failed.push(`${name}: ${err && err.message}`);
        });
    }

    /* An event: always a row, it is something that happened. */
    _event(name, v) {
        const s = show(v);
        this._changes++;
        logger.info(`event ${name} = ${s}`);
        this._rows.unshift(`${clock(new Date())} EVENT ${name} = ${s}`);
        if (this._rows.length > MAX_ROWS) {
            this._rows.length = MAX_ROWS;
        }
        this._scheduleRender();
    }

    /* A value read or notified: a row when it differs from the field's last one. */
    _value(name, v, initial) {
        const s = show(v);
        if (this._last[name] === s) {
            return;
        }
        const had = name in this._last;
        this._last[name] = s;
        const t = clock(new Date());
        const row = initial && !had ? `${t} start · ${name} = ${s}` : `${t} ${name} = ${s}`;
        if (!initial || had) {
            this._changes++;
            logger.info(`change ${name} = ${s}`);
        }
        this._rows.unshift(row);
        if (this._rows.length > MAX_ROWS) {
            this._rows.length = MAX_ROWS;
        }
        this._scheduleRender();
    }

    /* ---- presses and rendering ---- */

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
        comp.on('action', (ev) => this._press(name, handler, Number(ev && ev.row) || 0));
    }

    _press(name, handler, row) {
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

    _scheduleRender() {
        if (this._renderTimer) {
            return;
        }
        this._renderTimer = setTimeout(() => {
            this._renderTimer = null;
            this._render();
        }, RENDER_MS);
    }

    _set(name, cell, value, row) {
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
        rows.forEach((text, i) => this._set(name, 'PrimaryText', text, i));
    }

    _statusLine() {
        const short = IFACE.split('.').pop();
        if (this._phase) {
            return `${short}: ${this._phase}`;
        }
        const failed = this._failed.length ? `, ${this._failed.length} not watchable (first: ${this._failed[0]})` : '';
        const evs = this._watchedEvents ? ` and ${this._watchedEvents} events` : '';
        return `${short} (instance ${this._instance}): watching ${this._watching} fields${evs}, ${this._changes} changes${failed}. ` +
            'Press the car\'s heating buttons now.';
    }

    _render() {
        if (!this._visible || this._shutdownPromise) {
            return;
        }
        this._set(C.status, 'Text', this._statusLine());
        this._show(C.clear, this._rows.length > 0);
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
        logger.info(`watch shutting down (${reason})`);
        clearTimeout(this._hideTimer);
        clearTimeout(this._renderTimer);
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) => logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new Watch();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`watch failed to start: ${err && err.message}`);
});
