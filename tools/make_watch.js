'use strict';
/**
 * Builds the Heat Watch apps (apps/mystrip_watchseat, apps/mystrip_watchwheel,
 * apps/mystrip_watchmaster)
 * from tools/watch/src and Signal Finder's package files, one per
 * interface, so a missing interface on a head unit costs only its own app:
 * the head unit refuses an app whose manifest names an interface its
 * catalogue does not hold.
 *
 * Each app: mgu-app.json, src/ (watch.js, iface.js, Signal Finder's
 * catalog.js, target.js naming the interface), icon.png and the package
 * tree <id>@<version> (package.json, npm-shrinkwrap.json, manifest.json
 * with the interface added, permissions.json, config/, rhmiData/ with one
 * iDrive 8 screen: status, Clear log, the log). Ids and uuids are derived
 * from the app id, so a rebuild writes the same files.
 *
 *   node tools/make_watch.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'watch', 'src');
const FINDER = path.join(REPO, 'apps', 'mystrip_finder');
const FINDER_META = JSON.parse(fs.readFileSync(path.join(FINDER, 'mgu-app.json'), 'utf8'));
const FINDER_TREE = path.join(FINDER, FINDER_META.tree);
const VERSION = '0.1.1';

const TARGETS = [
    { id: 'mystrip_watchseat', prefix: 'MyStripWatchSeat', title: 'Heat Watch Seats', loggingId: 'MSWS',
        iface: 'de.bmw.infotainment.climate.Climate',
        description: 'Live log of the climate interface\'s values while the car\'s seat heating buttons are pressed; read-only' },
    { id: 'mystrip_watchwheel', prefix: 'MyStripWatchWheel', title: 'Heat Watch Wheel', loggingId: 'MSWW',
        iface: 'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate',
        description: 'Live log of the steering wheel climate interface\'s values while its heating button is pressed; read-only' },
    { id: 'mystrip_watchmaster', prefix: 'MyStripWatchMaster', title: 'Heat Watch Master', loggingId: 'MSWM',
        iface: 'de.bmw.infotainment.climate.climatemaster.ClimateMaster',
        description: 'Live log of the climate master interface\'s values (seat and steering wheel heating) while the heating buttons are pressed; read-only' }
];

function uuid(seed) {
    const h = crypto.createHash('sha1').update(seed).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

const json = (v) => JSON.stringify(v, null, 2) + '\n';

function rhmi(t) {
    const sid = (w) => `SID_${t.prefix.toUpperCase()}_${w.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
    const words = (w) => (w ? { value: sid(w), type: 'StringId' } : { value: '', type: 'Text' });
    const media = (primary, freq) => ({ PrimaryText: words(primary), FrequencyText: words(freq || ''),
        FrequencyVisible: { value: freq !== null, type: 'Bool' }, IconVisible: { value: false, type: 'Bool' },
        ProgressVisible: { value: false, type: 'Bool' }, IsPlaying: { value: false, type: 'Bool' } });
    const comps = [
        { id: 20, name: `${t.prefix}Status`, type: 'label', widget: 'LT_ScrollLabel', focusable: 0, rows: [{ Text: words('Starting') }] },
        { id: 21, name: `${t.prefix}Clear`, type: 'button', widget: 'LT_Button_MediaEntry_1Row', focusable: 3, rows: [media('Clear log', null)] },
        { id: 24, name: `${t.prefix}Log`, type: 'button', widget: 'LT_Button_MediaEntry_1Row', focusable: 3, rows: [media('', '')] }
    ];
    const state = `ST_OnlineApps_${t.prefix}`;
    const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>',
        '    <container id="1" type="state" widget="LT_State_Wide_List">',
        '        <layoutGroup id="102" name="Titlebar">', '            <component id="10" type="title">',
        '                <property id="2" value="1"/>', '            </component>', '        </layoutGroup>',
        '        <layoutGroup id="103" name="List">', '            <property id="3" value="1"/>']
        .concat([].concat.apply([], comps.map((c) => [`            <component id="${c.id}" type="${c.type}" widget="${c.widget}">`,
            '                <property id="2" value="1"/>', `                <property id="3" value="${c.focusable}"/>`, '            </component>'])))
        .concat(['        </layoutGroup>', '    </container>', '</application>', '']).join('\n');
    const components = { 10: { type: 'title', name: `${state}_Title`, properties: { Visible: { value: 1, type: 'UInt' } },
        rows: [{ Text: words(t.title) }] } };
    comps.forEach((c) => {
        components[c.id] = { type: c.type, name: c.name,
            properties: { Visible: { value: 1, type: 'UInt' }, Focusable: { value: c.focusable, type: 'UInt' } }, rows: c.rows };
    });
    const ui = { schemaVersion: '1.3.0', containers: { 1: { type: 'state', name: state, components } } };
    const texts = { SID_TEMP_EMPTY: '' };
    [t.title, 'Starting', 'Clear log'].forEach((w) => { texts[sid(w)] = w; });
    const icon = `${t.id}_icon.png`;
    const app = { schemaVersion: '1.3.0', application: {
        uuid: uuid(t.id + ':application'), type: 'OnlineApp', name: t.id, vendor: 'owner', version: VERSION,
        defaultLanguage: 'en_GB',
        uiDescriptions: [{ applicationFilePath: './uiDescriptions/ID8/application.xml',
            uiDescriptionFilePath: './uiDescriptions/ID8/uiDescription.json', hmi: ['ID8'] }],
        stringBundleUuid: uuid(t.id + ':strings'), resourceBundleUuid: uuid(t.id + ':resources'),
        variantGroups: [{ stringsPath: './variantGroups/Common/texts', resourcesPath: './variantGroups/Common/images',
            hmi: ['ID8'], brands: ['BMW'] }],
        entryPoints: [{ name: t.id, uuid: uuid(t.id + ':entry'), textId: sid(t.title), icon,
            insertionStateId: 20974, insertionFocusId: 2, insertionMode: 'INSERT_BELOW', insertionOrder: 0, insertionPriority: 0,
            previewType: 'NONE', bookmarkable: true, private: null, appearance: 'DEFAULT', isGroupHeader: false, insertionGroup: 0 }]
    } };
    return { xml, ui, texts, app, icon };
}

function build(t) {
    const dir = path.join(REPO, 'apps', t.id);
    const tree = path.join(dir, `${t.id}@${VERSION}`);
    write(path.join(dir, 'mgu-app.json'), json({ schema: 1, id: t.id, version: VERSION, tree: `${t.id}@${VERSION}`,
        modules: ['src/watch.js', 'src/iface.js', 'src/catalog.js', 'src/target.js'],
        sdk: ['oap-sdk/src/core/OnlineApp.js', 'oap-sdk/src/logging/logging', 'oap-sdk/src/someip/someipBuilders'] }));
    write(path.join(dir, 'src', 'watch.js'), fs.readFileSync(path.join(SRC, 'watch.js')));
    write(path.join(dir, 'src', 'iface.js'), fs.readFileSync(path.join(SRC, 'iface.js')));
    write(path.join(dir, 'src', 'catalog.js'), fs.readFileSync(path.join(FINDER, 'src', 'catalog.js')));
    write(path.join(dir, 'src', 'target.js'), `'use strict';\n/* The interface this Heat Watch app watches (tools/make_watch.js). */\n` +
        `module.exports = { IFACE: '${t.iface}', PREFIX: '${t.prefix}' };\n`);
    const icon = fs.readFileSync(path.join(FINDER, 'icon.png'));
    write(path.join(dir, 'icon.png'), icon);

    const pkg = JSON.parse(fs.readFileSync(path.join(FINDER_TREE, 'package.json'), 'utf8'));
    Object.assign(pkg, { name: t.id, version: VERSION, description: t.description });
    pkg.oapAppSettings = Object.assign({}, pkg.oapAppSettings, { loggingId: t.loggingId });
    write(path.join(tree, 'package.json'), json(pkg));
    write(path.join(tree, 'npm-shrinkwrap.json'), json({ name: t.id, version: VERSION, lockfileVersion: 1, requires: true, dependencies: {} }));
    const manifest = JSON.parse(fs.readFileSync(path.join(FINDER_TREE, 'manifest.json'), 'utf8'));
    manifest.proxies[t.iface] = '*';
    write(path.join(tree, 'manifest.json'), json(manifest));
    write(path.join(tree, 'permissions.json'), fs.readFileSync(path.join(FINDER_TREE, 'permissions.json')));
    write(path.join(tree, 'config', 'base.json'), '{}\n');
    const r = rhmi(t);
    write(path.join(tree, 'rhmiData', 'application.json'), json(r.app));
    write(path.join(tree, 'rhmiData', 'uiDescriptions', 'ID8', 'application.xml'), r.xml);
    write(path.join(tree, 'rhmiData', 'uiDescriptions', 'ID8', 'uiDescription.json'), json(r.ui));
    ['en_GB', 'en_US'].forEach((n) => write(path.join(tree, 'rhmiData', 'variantGroups', 'Common', 'texts', `${n}.json`), json(r.texts)));
    write(path.join(tree, 'rhmiData', 'variantGroups', 'Common', 'images', r.icon), icon);
    return dir;
}

function repoManifest() {
    const file = path.join(REPO, 'mgu-repo.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    m.components = m.components.filter((c) => !TARGETS.some((t) => t.id === c.id));
    TARGETS.forEach((t) => m.components.push({ id: t.id, kind: 'app', path: `apps/${t.id}`, build: 'unit', mguHmi: ['ID8'],
        title: t.title, description: t.description }));
    fs.writeFileSync(file, json(m));
}

if (require.main === module) {
    TARGETS.forEach((t) => console.log(`wrote ${path.relative(REPO, build(t))}`));
    repoManifest();
    console.log('mgu-repo.json lists ' + TARGETS.map((t) => t.id).join(', '));
}

module.exports = { TARGETS, VERSION };
