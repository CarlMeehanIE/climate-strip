'use strict';
/**
 * Builds the Heat Test app (apps/mystrip_heattest) from tools/heattest/src,
 * the Heat Watch apps' iface.js and Signal Finder's catalog.js and package
 * files: mgu-app.json, src/, icon.png and the package tree <id>@<version>
 * (manifest.json naming the Climate, ClimateMaster and SteeringWheelClimate
 * interfaces, rhmiData/ with one iDrive 8 screen: the status line, the
 * buttons, the log). Ids and uuids are derived from the app id, so a rebuild
 * writes the same files.
 *
 *   node tools/make_heattest.js
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const FINDER = path.join(REPO, 'apps', 'mystrip_finder');
const FINDER_TREE = path.join(FINDER, JSON.parse(fs.readFileSync(path.join(FINDER, 'mgu-app.json'), 'utf8')).tree);
const ID = 'mystrip_heattest';
const VERSION = '0.1.0';
const PREFIX = 'HeatTest';
const TITLE = 'Heat Test';
const DESCRIPTION = 'Buttons that each send one seat or steering wheel heating command by one route, with the car\'s answer and the live levels';
const IFACES = ['de.bmw.infotainment.climate.Climate', 'de.bmw.infotainment.climate.climatemaster.ClimateMaster',
    'de.bmw.body.steeringwheelcomfort.SteeringWheelClimate'];

function uuid(seed) {
    const h = crypto.createHash('sha1').update(seed).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function write(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
}

const json = (v) => JSON.stringify(v, null, 2) + '\n';
const sid = (w) => `SID_MYSTRIPHEATTEST_${w.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
const words = (w) => (w ? { value: sid(w), type: 'StringId' } : { value: '', type: 'Text' });
const media = () => ({ PrimaryText: words(''), FrequencyText: words(''), FrequencyVisible: { value: true, type: 'Bool' },
    IconVisible: { value: false, type: 'Bool' }, ProgressVisible: { value: false, type: 'Bool' }, IsPlaying: { value: false, type: 'Bool' } });

function rhmiFiles() {
    const comps = [
        { id: 20, name: `${PREFIX}Status`, type: 'label', widget: 'LT_ScrollLabel', focusable: 0, rows: [{ Text: words('Starting') }] },
        { id: 24, name: `${PREFIX}Actions`, type: 'button', widget: 'LT_Button_MediaEntry_1Row', focusable: 3, rows: [media()] },
        { id: 25, name: `${PREFIX}Log`, type: 'button', widget: 'LT_Button_MediaEntry_1Row', focusable: 3, rows: [media()] }
    ];
    const state = 'ST_OnlineApps_MyStripHeatTest';
    const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>',
        '    <container id="1" type="state" widget="LT_State_Wide_List">',
        '        <layoutGroup id="102" name="Titlebar">', '            <component id="10" type="title">',
        '                <property id="2" value="1"/>', '            </component>', '        </layoutGroup>',
        '        <layoutGroup id="103" name="List">', '            <property id="3" value="1"/>']
        .concat([].concat.apply([], comps.map((c) => [`            <component id="${c.id}" type="${c.type}" widget="${c.widget}">`,
            '                <property id="2" value="1"/>', `                <property id="3" value="${c.focusable}"/>`, '            </component>'])))
        .concat(['        </layoutGroup>', '    </container>', '</application>', '']).join('\n');
    const components = { 10: { type: 'title', name: `${state}_Title`, properties: { Visible: { value: 1, type: 'UInt' } },
        rows: [{ Text: words(TITLE) }] } };
    comps.forEach((c) => {
        components[c.id] = { type: c.type, name: c.name,
            properties: { Visible: { value: 1, type: 'UInt' }, Focusable: { value: c.focusable, type: 'UInt' } }, rows: c.rows };
    });
    const texts = { SID_TEMP_EMPTY: '' };
    [TITLE, 'Starting'].forEach((w) => { texts[sid(w)] = w; });
    const icon = `${ID}_icon.png`;
    const app = { schemaVersion: '1.3.0', application: {
        uuid: uuid(ID + ':application'), type: 'OnlineApp', name: ID, vendor: 'owner', version: VERSION, defaultLanguage: 'en_GB',
        uiDescriptions: [{ applicationFilePath: './uiDescriptions/ID8/application.xml',
            uiDescriptionFilePath: './uiDescriptions/ID8/uiDescription.json', hmi: ['ID8'] }],
        stringBundleUuid: uuid(ID + ':strings'), resourceBundleUuid: uuid(ID + ':resources'),
        variantGroups: [{ stringsPath: './variantGroups/Common/texts', resourcesPath: './variantGroups/Common/images',
            hmi: ['ID8'], brands: ['BMW'] }],
        entryPoints: [{ name: ID, uuid: uuid(ID + ':entry'), textId: sid(TITLE), icon,
            insertionStateId: 20974, insertionFocusId: 2, insertionMode: 'INSERT_BELOW', insertionOrder: 0, insertionPriority: 0,
            previewType: 'NONE', bookmarkable: true, private: null, appearance: 'DEFAULT', isGroupHeader: false, insertionGroup: 0 }]
    } };
    return { xml, ui: { schemaVersion: '1.3.0', containers: { 1: { type: 'state', name: state, components } } }, texts, app, icon };
}

function build() {
    const dir = path.join(REPO, 'apps', ID);
    const tree = path.join(dir, `${ID}@${VERSION}`);
    write(path.join(dir, 'mgu-app.json'), json({ schema: 1, id: ID, version: VERSION, tree: `${ID}@${VERSION}`,
        modules: ['src/heattest.js', 'src/types.js', 'src/iface.js', 'src/catalog.js'],
        sdk: ['oap-sdk/src/core/OnlineApp.js', 'oap-sdk/src/logging/logging', 'oap-sdk/src/someip/someipBuilders'] }));
    write(path.join(dir, 'src', 'heattest.js'), fs.readFileSync(path.join(__dirname, 'heattest', 'src', 'heattest.js')));
    write(path.join(dir, 'src', 'types.js'), fs.readFileSync(path.join(__dirname, 'heattest', 'src', 'types.js')));
    write(path.join(dir, 'src', 'iface.js'), fs.readFileSync(path.join(__dirname, 'watch', 'src', 'iface.js')));
    write(path.join(dir, 'src', 'catalog.js'), fs.readFileSync(path.join(FINDER, 'src', 'catalog.js')));
    const icon = fs.readFileSync(path.join(FINDER, 'icon.png'));
    write(path.join(dir, 'icon.png'), icon);
    const pkg = JSON.parse(fs.readFileSync(path.join(FINDER_TREE, 'package.json'), 'utf8'));
    Object.assign(pkg, { name: ID, version: VERSION, description: DESCRIPTION });
    pkg.oapAppSettings = Object.assign({}, pkg.oapAppSettings, { loggingId: 'MSHT' });
    write(path.join(tree, 'package.json'), json(pkg));
    write(path.join(tree, 'npm-shrinkwrap.json'), json({ name: ID, version: VERSION, lockfileVersion: 1, requires: true, dependencies: {} }));
    const manifest = JSON.parse(fs.readFileSync(path.join(FINDER_TREE, 'manifest.json'), 'utf8'));
    IFACES.forEach((i) => { manifest.proxies[i] = '*'; });
    write(path.join(tree, 'manifest.json'), json(manifest));
    write(path.join(tree, 'permissions.json'), fs.readFileSync(path.join(FINDER_TREE, 'permissions.json')));
    write(path.join(tree, 'config', 'base.json'), '{}\n');
    const r = rhmiFiles();
    write(path.join(tree, 'rhmiData', 'application.json'), json(r.app));
    write(path.join(tree, 'rhmiData', 'uiDescriptions', 'ID8', 'application.xml'), r.xml);
    write(path.join(tree, 'rhmiData', 'uiDescriptions', 'ID8', 'uiDescription.json'), json(r.ui));
    ['en_GB', 'en_US'].forEach((n) => write(path.join(tree, 'rhmiData', 'variantGroups', 'Common', 'texts', `${n}.json`), json(r.texts)));
    write(path.join(tree, 'rhmiData', 'variantGroups', 'Common', 'images', r.icon), icon);

    const file = path.join(REPO, 'mgu-repo.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    m.components = m.components.filter((c) => c.id !== ID);
    m.components.push({ id: ID, kind: 'app', path: `apps/${ID}`, build: 'unit', mguHmi: ['ID8'], title: TITLE, description: DESCRIPTION });
    fs.writeFileSync(file, json(m));
    return dir;
}

if (require.main === module) {
    console.log(`wrote ${path.relative(REPO, build())}; mgu-repo.json lists ${ID}`);
}

module.exports = { ID, VERSION };
