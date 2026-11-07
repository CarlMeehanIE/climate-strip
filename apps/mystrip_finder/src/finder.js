/**
 * finder - Signal Finder: shows the seat-heating and steering-wheel-heating
 * parts of this head unit's SOME/IP interface catalogue, so a climate strip
 * app can be written against the real names.
 *
 * On open it reads /etc/oap/someip/someip-interfaces.json (src/catalog.js)
 * and lists the interfaces that have heating parts. Tap one for its parts
 * (each marked with what it allows: GET, SET, NOTIFY for a field, CALL for
 * a method, EVENT), and a part for its data type spelled out and its raw
 * catalogue entry.
 *
 * Read-only towards the car: it reads one file and sends no vehicle commands.
 *
 * The app's structure (OnlineApp, the RHMI states, presses, entry point,
 * visibility) follows the MGU Store's src/store.js
 * (robertnisipeanu/mgu-store, GPL-3.0). Node 8 compatible.
 */
'use strict';
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { readCatalog } = require('./catalog.js');

const logger = logging.getSDKLogger();

const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const ROW_KEY = 2;                      // a press's row in a raw userEvent's parameterMap

const S = {
    main: 'ST_OnlineApps_MyStripFinder',
    iface: 'ST_OnlineApps_MyStripFinderIface',
    detail: 'ST_OnlineApps_MyStripFinderDetail'
};
const C = {
    status: 'finderStatus',
    read: 'finderRead',
    ifaceList: 'finderIfaceList',
    ifaceHead: 'finderIfaceHead',
    memberList: 'finderMemberList',
    detailName: 'finderDetailName',
    detailKind: 'finderDetailKind',
    detailType: 'finderDetailType',
    detailRaw: 'finderDetailRaw'
};
/* LT_ScrollLabel's cell is Text; LT_Button_MediaEntry_1Row's first line PrimaryText. */
const LABELS = new Set([C.status, C.ifaceHead, C.detailName, C.detailKind, C.detailType, C.detailRaw]);

function isTrue(v) {
    return v === true || v === 1 || v === 'true' || v === '1';
}

function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
}

/* What a part allows, in capitals, ahead of its name in the lists. */
function tag(m) {
    return m.flags.toUpperCase().replace(/ /g, '+');
}

class Finder extends OnlineApp {
    constructor() {
        super();
        this._states = {};
        this._components = {};
        this._actionById = {};
        this._lastPress = {};
        this._written = {};
        this._sizing = {};
        this._visibleStates = new Set();
        this._visible = false;
        this._hideTimer = null;
        this._shutdownPromise = null;
        this._result = null;            // the last read's result (readCatalog)
        this._reading = null;           // the running read's promise
        this._iface = null;             // the interface shown on the Interface screen
        this._detail = null;            // the part shown on the Part screen

        this.on('initialized', () => {
            this._appInitialized().catch((err) => logger.error(`finder init failed: ${err && err.message}`));
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
        logger.info(`finder ${this.getAppId()} starting`);
        if (!this.rhmiApplication) {
            return this.initialized();
        }
        const foreground = this._startedForeground();
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

    _startedForeground() {
        const REASONS = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'START_WIDGET', 'TRIGGER_HMI', 'SPEECH_COMMAND'];
        const data = this.getVisibilityData && this.getVisibilityData();
        const reason = (data && data.reason) || this.startReason;
        return REASONS.indexOf(reason) >= 0;
    }

    _setupRhmi() {
        const rhmi = this.rhmiApplication;
        const stateNames = Object.keys(S).map((k) => S[k]);
        for (let i = 0; i < stateNames.length; i++) {
            this._states[stateNames[i]] = rhmi.getByName(stateNames[i]);
            if (!this._states[stateNames[i]]) {
                return Promise.reject(new Error(`uiDescription has no ${stateNames[i]}`));
            }
        }
        Object.keys(C).forEach((k) => {
            this._components[C[k]] = rhmi.getByName(C[k]);
            if (!this._components[C[k]]) {
                logger.warn(`BIND MISS: ${C[k]} not found in uiDescription`);
            }
        });
        this._bind(C.read, () => this._startRead());
        this._bind(C.ifaceList, (row) => this._openIface(row));
        this._bind(C.memberList, (row) => this._openDetail(row));
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
        stateNames.forEach((name) => this._states[name].on('visible', (event) => {
            if (isTrue(event && event.visible)) {
                this._visibleStates.add(name);
                this._setVisible(true);
                this._render();
            } else {
                this._visibleStates.delete(name);
                clearTimeout(this._hideTimer);
                this._hideTimer = setTimeout(() => {
                    if (this._visibleStates.size === 0) {
                        this._setVisible(false);
                    }
                }, HIDE_SETTLE_MS);
            }
        }));
        return Promise.all(stateNames.map((name) => this._states[name].updateResources()));
    }

    _registerEntryPoints() {
        const descriptions = (this.appDescription && this.appDescription.application.entryPoints) || [];
        const ours = this.getEntryPoints().find((ep) => descriptions.some((d) => d.uuid === ep.getDescription().uuid));
        if (!ours) {
            return Promise.reject(new Error('no entry point handed over by the manager'));
        }
        const description = ours.getDescription();
        return ours.init()
            .then(() => this.rhmiApplication.mapEntryState(description.uuid, this._states[S.main]))
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

    /* ---- actions ---- */

    _startRead() {
        if (this._reading) {
            return this._reading;
        }
        this._render();
        logger.info('catalogue read started');
        this._reading = readCatalog()
            .then((result) => {
                this._result = result;
                logger.info(`catalogue read: ${result.bytes} bytes, ${result.total} interfaces, ` +
                    `${result.interfaces.length} with heating parts, ${result.ms} ms${result.error ? ', error ' + result.error : ''}`);
            })
            .catch((err) => {
                this._result = { interfaces: [], total: 0, bytes: 0, ms: 0, error: String(err && err.message) };
            })
            .then(() => {
                this._reading = null;
                this._render();
            });
        return this._reading;
    }

    _openIface(row) {
        const i = this._result && this._result.interfaces[row];
        if (!i) {
            return;
        }
        this._iface = i;
        this._render();
        this._openState(S.iface);
    }

    _openDetail(row) {
        const m = this._iface && this._iface.members[row];
        if (!m) {
            return;
        }
        this._detail = m;
        this._render();
        this._openState(S.detail);
    }

    _openState(name) {
        if (this._shutdownPromise) {
            return;
        }
        Promise.resolve(this.rhmiApplication.openState(name))
            .catch((err) => logger.warn(`openState ${name} failed: ${err && err.message}`));
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
        comp.on('action', (ev) => this._press(name, handler, Number(ev && ev.row) || 0));
    }

    /* Presses arrive both as the component's action and the raw userEvent: one counts. */
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

    /* ---- rendering ---- */

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

    _label(name, text) {
        if (text) {
            this._set(name, LABELS.has(name) ? 'Text' : 'PrimaryText', text);
        }
        this._show(name, !!text);
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
        if (this._reading) {
            return 'Reading the catalogue…';
        }
        const r = this._result;
        if (!r) {
            return 'Starting';
        }
        if (r.error) {
            return `Could not read the catalogue: ${r.error}`;
        }
        const parts = r.interfaces.reduce((n, i) => n + i.members.length, 0);
        return r.interfaces.length ?
            `${plural(r.interfaces.length, 'interface', 'interfaces')} with heating parts (${parts} parts), ` +
                `of ${r.total} in the catalogue` :
            `No heating parts among the ${r.total} interfaces in the catalogue`;
    }

    _render() {
        if (!this._visible || this._shutdownPromise) {
            return;
        }
        const r = this._result;
        this._label(C.status, this._statusLine());
        this._show(C.read, !this._reading);
        this._list(C.ifaceList, this._reading || !r ? [] :
            r.interfaces.map((i) => `${plural(i.members.length, 'part', 'parts')} · ${i.name}`));
        const i = this._iface;
        this._label(C.ifaceHead, i ? `${i.name} · service ${i.serviceId} · instance ${JSON.stringify(i.instance)}` : '');
        this._list(C.memberList, i ? i.members.map((m) => `${tag(m)} · ${m.name}`) : []);
        const d = this._detail;
        this._label(C.detailName, d ? d.name : '');
        this._label(C.detailKind, d ? `${d.kind} · ${tag(d)}` : '');
        this._label(C.detailType, d ? d.type : '');
        this._label(C.detailRaw, d ? d.raw : '');
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
            if (!this._result && !this._reading) {
                this._startRead();
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
        logger.info(`finder shutting down (${reason})`);
        clearTimeout(this._hideTimer);
        this._shutdownPromise = Promise.resolve()
            .then(() => this.destroyBundles().catch((err) => logger.info(`destroyBundles: ${err && err.message}`)))
            .then(() => process.exit(0));
        return this._shutdownPromise;
    }
}

const app = new Finder();
app.start().catch((err) => {
    /* Stays resident so the manager can stop or restart it. */
    logger.error(`finder failed to start: ${err && err.message}`);
});
