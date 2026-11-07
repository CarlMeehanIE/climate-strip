/**
 * finder - Signal Finder: shows which seat-heating and steering-wheel-heating
 * entries this head unit's SOME/IP interface catalogue has, so a climate
 * strip app can be written against the real names.
 *
 * On open it scans the read-only system folders (src/scan.js) and lists
 * the files with matches, each with its count (the interface catalogue
 * first): tap a file for its matches, a match for the full entry. Interfaces found lists the
 * climate, seat and steering-wheel interfaces by name. Save report to USB
 * writes everything to signal-finder-report.txt on a USB stick
 * (src/usb.js); a copy is kept in the app's own data folder.
 *
 * Read-only towards the car: it reads files and sends no vehicle commands.
 *
 * The app's structure (OnlineApp, the RHMI states, presses, entry point,
 * visibility) follows the MGU Store's src/store.js
 * (robertnisipeanu/mgu-store, GPL-3.0). Node 8 compatible.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const logging = require('oap-sdk/src/logging/logging');
const { scan, report } = require('./scan.js');
const { saveToUsb } = require('./usb.js');

const logger = logging.getSDKLogger();

const REPORT_NAME = 'signal-finder-report.txt';
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const PRESS_DEDUPE_MS = 400;
const HIDE_SETTLE_MS = 800;
const PROGRESS_MS = 700;
const ROW_KEY = 2;                      // a press's row in a raw userEvent's parameterMap

const S = {
    main: 'ST_OnlineApps_MyStripFinder',
    file: 'ST_OnlineApps_MyStripFinderFile',
    detail: 'ST_OnlineApps_MyStripFinderDetail',
    ifaces: 'ST_OnlineApps_MyStripFinderIfaces'
};
const C = {
    status: 'finderStatus',
    scan: 'finderScan',
    save: 'finderSave',
    ifaces: 'finderIfaces',
    fileList: 'finderFileList',
    filePath: 'finderFilePath',
    entryList: 'finderEntryList',
    detailName: 'finderDetailName',
    detailWhere: 'finderDetailWhere',
    detailText: 'finderDetailText',
    ifaceList: 'finderIfaceList'
};
/* LT_ScrollLabel's cell; LT_Button_MediaEntry_1Row's two. */
const LABELS = new Set([C.status, C.filePath, C.detailName, C.detailWhere, C.detailText]);

function isTrue(v) {
    return v === true || v === 1 || v === 'true' || v === '1';
}

function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
}

/* The matches by file: [{ file, matches }], files in a someip folder first,
 * then by how many matches they have. */
function byFile(matches) {
    const groups = {};
    const order = [];
    matches.forEach((m) => {
        if (!groups[m.file]) {
            groups[m.file] = { file: m.file, matches: [] };
            order.push(groups[m.file]);
        }
        groups[m.file].matches.push(m);
    });
    return order.sort((a, b) => (Number(/someip/i.test(b.file)) - Number(/someip/i.test(a.file))) ||
        (b.matches.length - a.matches.length) || (a.file < b.file ? -1 : 1));
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
        this._result = null;            // the last scan's result
        this._scanning = null;          // the running scan's promise
        this._progress = null;          // { phase, files, scanned, matches }
        this._lastProgress = 0;
        this._note = '';                // the outcome of Save report to USB
        this._files = [];               // the last scan's matches by file (byFile)
        this._file = null;              // the file shown on the File screen
        this._detail = null;            // the match shown on the Entry screen

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
        this._bind(C.scan, () => this._startScan());
        this._bind(C.save, () => this._save());
        this._bind(C.ifaces, () => this._openState(S.ifaces));
        this._bind(C.fileList, (row) => this._openFile(row));
        this._bind(C.entryList, (row) => this._openDetail(row));
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

    _startScan() {
        if (this._scanning) {
            return this._scanning;
        }
        this._note = '';
        this._progress = { phase: 'listing', files: 0 };
        this._render();
        logger.info('scan started');
        this._scanning = scan({ onProgress: (p) => this._onProgress(p) })
            .then((result) => {
                this._result = result;
                this._files = byFile(result.matches);
                logger.info(`scan done: ${result.scanned} files read, ${result.matches.length} matches, ` +
                    `${result.interfaces.length} interfaces, ${result.ms} ms`);
                return this._writeLocal();
            })
            .catch((err) => {
                logger.warn(`scan failed: ${err && err.message}`);
                this._result = { files: 0, scanned: 0, matches: [], interfaces: [], ms: 0, error: String(err && err.message) };
                this._files = [];
            })
            .then(() => {
                this._scanning = null;
                this._progress = null;
                this._render();
            });
        return this._scanning;
    }

    _onProgress(p) {
        this._progress = p;
        const now = Date.now();
        if (now - this._lastProgress >= PROGRESS_MS) {
            this._lastProgress = now;
            this._render();
        }
    }

    _reportText() {
        const pkg = this.packageJson || this._packageJson || {};
        return report(this._result, { App: `${this.getAppId()} ${pkg.version || ''}`.trim() });
    }

    /* A copy in the app's own data folder. */
    _writeLocal() {
        return new Promise((resolve) => {
            fs.mkdir(DATA_DIR, () => fs.writeFile(path.join(DATA_DIR, REPORT_NAME), this._reportText(), 'utf8', (err) => {
                if (err) {
                    logger.warn(`report not written to ${DATA_DIR}: ${err.message}`);
                }
                resolve();
            }));
        });
    }

    _save() {
        if (!this._result || this._scanning) {
            this._note = 'Wait for the scan to finish';
            this._render();
            return Promise.resolve();
        }
        this._note = 'Saving…';
        this._render();
        return saveToUsb(REPORT_NAME, this._reportText()).then((r) => {
            this._note = r.ok ? `Saved to ${r.where}` :
                (r.tried.length ? 'Could not write to the USB stick' : 'No USB stick found');
            logger.info(`save to USB: ${r.ok ? r.where : 'failed'} (tried ${r.tried.join(', ') || 'none'})`);
            this._render();
        });
    }

    _openFile(row) {
        const f = this._files[row];
        if (!f) {
            return;
        }
        this._file = f;
        this._render();
        this._openState(S.file);
    }

    _openDetail(row) {
        const m = this._file && this._file.matches[row];
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
        const p = this._progress;
        if (p) {
            return p.phase === 'listing' ? `Looking for files… ${p.files} found` :
                `Reading files… ${p.scanned} of ${p.files}, ${plural(p.matches || 0, 'match', 'matches')}`;
        }
        const r = this._result;
        if (!r) {
            return 'Starting';
        }
        if (r.error) {
            return `Scan failed: ${r.error}`;
        }
        const head = r.matches.length ?
            `${plural(r.matches.length, 'heating entry', 'heating entries')} in ${plural(this._files.length, 'file', 'files')}` +
                ` (${r.scanned} read)${r.full ? ', limit reached' : ''}` :
            `No heating entries found in ${plural(r.scanned, 'file', 'files')}`;
        return this._note ? `${head}. ${this._note}` : head;
    }

    _render() {
        if (!this._visible || this._shutdownPromise) {
            return;
        }
        const r = this._result;
        const busy = !!this._scanning;
        this._label(C.status, this._statusLine());
        this._show(C.scan, !busy);
        this._show(C.save, !busy && !!r);
        const ifaces = (r && r.interfaces) || [];
        this._show(C.ifaces, ifaces.length > 0);
        if (ifaces.length) {
            this._set(C.ifaces, 'PrimaryText', `Interfaces found (${ifaces.length})`);
        }
        this._list(C.fileList, busy || !r ? [] : this._files.map((f) => `${f.matches.length} · ${f.file}`));
        this._list(C.ifaceList, ifaces);
        const f = this._file;
        this._label(C.filePath, f ? `${f.file} · ${plural(f.matches.length, 'entry', 'entries')}` : '');
        this._list(C.entryList, f ? f.matches.map((m) => m.name) : []);
        const d = this._detail;
        this._label(C.detailName, d ? d.name : '');
        this._label(C.detailWhere, d ? `${d.file} · ${d.path}` : '');
        this._label(C.detailText, d ? d.text : '');
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
            if (!this._result && !this._scanning) {
                this._startScan();
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
