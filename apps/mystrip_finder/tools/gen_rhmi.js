'use strict';
/**
 * Writes the app's iDrive 8 screens (rhmiData/uiDescriptions/ID8:
 * application.xml and uiDescription.json), rhmiData/application.json and
 * the English text files from the tables below, so ids, names, widgets and
 * cells stay in step. The widgets and the way the files are laid out follow
 * the MGU Store's tools/gen_rhmi.js (robertnisipeanu/mgu-store, GPL-3.0).
 *
 * Screens (LT_State_Wide_List, rows LT_Button_MediaEntry_1Row, labels
 * LT_ScrollLabel):
 *   1  ST_OnlineApps_MyStripFinder        status, Scan again, Save report to
 *                                         USB, Interfaces found, the matches
 *   2  ST_OnlineApps_MyStripFinderDetail  one match in full
 *   3  ST_OnlineApps_MyStripFinderIfaces  the climate / seat / wheel interfaces
 *
 * No state has a parent: iDrive 8 refuses parents of parents, and its own
 * history takes the states back one at a time.
 *
 *   node tools/gen_rhmi.js
 */
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const META = JSON.parse(fs.readFileSync(path.join(APP, 'mgu-app.json'), 'utf8'));
const PKG = path.join(APP, META.tree);
const RHMI = path.join(PKG, 'rhmiData');
const ID8 = path.join(RHMI, 'uiDescriptions', 'ID8');
const TEXTS = path.join(RHMI, 'variantGroups', 'Common', 'texts');

const ICON = 'mystrip_finder_icon.png';
const UUIDS = {
    application: '5d0f3a52-8c1e-4b7a-9e43-2f6b8d9c1a07',
    strings: 'b2e6c7d1-4f3a-4e8b-a1d5-7c9e0f2b3a61',
    resources: 'e8a4b1c3-9d2f-4a6e-b7c5-1f3d5e7a9b20',
    entry: '3c7e9a15-6b2d-4f8a-8e1c-5a9b7d3f2e46'
};

const button = (id, name, text) => ({ id, kind: 'button', name, text, focusable: 3 });
const row = (id, name, text) => ({ id, kind: 'row', name, text, focusable: 3 });
const list = (id, name) => ({ id, kind: 'row', name, text: '', focusable: 3 });
const label = (id, name, text) => ({ id, kind: 'label', name, text: text || '', focusable: 0 });

const media = (primary, freq) => ({ PrimaryText: primary, FrequencyText: freq || '', FrequencyVisible: freq !== null,
    IconVisible: false, ProgressVisible: false, IsPlaying: false });
const WIDGETS = {
    state: 'LT_State_Wide_List',
    button: (c) => ({ type: 'button', widget: 'LT_Button_MediaEntry_1Row', cells: media(c.text, null) }),
    row: (c) => ({ type: 'button', widget: 'LT_Button_MediaEntry_1Row', cells: media(c.text, '') }),
    label: (c) => ({ type: 'label', widget: 'LT_ScrollLabel', cells: { Text: c.text } })
};

const sid = (words) => `SID_MYSTRIP_${words.replace(/\?/g, ' Q').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
const words = (text) => (text ? { value: sid(text), type: 'StringId' } : { value: '', type: 'Text' });

const TITLE = 'Signal Finder';
const STATES = [
    { id: 1, name: 'ST_OnlineApps_MyStripFinder', titleId: 10, title: TITLE, components: [
        label(20, 'finderStatus', 'Starting'),
        button(21, 'finderScan', 'Scan again'),
        button(22, 'finderSave', 'Save report to USB'),
        row(23, 'finderIfaces', 'Interfaces found'),
        list(24, 'finderList')
    ] },
    { id: 2, name: 'ST_OnlineApps_MyStripFinderDetail', titleId: 11, title: 'Entry', components: [
        label(30, 'finderDetailName'),
        label(31, 'finderDetailWhere'),
        label(32, 'finderDetailText')
    ] },
    { id: 3, name: 'ST_OnlineApps_MyStripFinderIfaces', titleId: 12, title: 'Interfaces found', components: [
        list(40, 'finderIfaceList')
    ] }
];

function xml() {
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<application>'];
    STATES.forEach((s) => {
        lines.push(`    <container id="${s.id}" type="state" widget="${WIDGETS.state}">`,
            `        <layoutGroup id="${100 + 2 * s.id}" name="Titlebar">`,
            `            <component id="${s.titleId}" type="title">`,
            '                <property id="2" value="1"/>',
            '            </component>',
            '        </layoutGroup>',
            `        <layoutGroup id="${101 + 2 * s.id}" name="List">`,
            '            <property id="3" value="1"/>');
        s.components.forEach((c) => {
            const w = WIDGETS[c.kind](c);
            lines.push(`            <component id="${c.id}" type="${w.type}" widget="${w.widget}">`,
                '                <property id="2" value="1"/>',
                `                <property id="3" value="${c.focusable}"/>`,
                '            </component>');
        });
        lines.push('        </layoutGroup>', '    </container>');
    });
    lines.push('</application>', '');
    return lines.join('\n');
}

function uiDescription() {
    const containers = {};
    STATES.forEach((s) => {
        const components = {
            [s.titleId]: { type: 'title', name: `${s.name}_Title`, properties: { Visible: { value: 1, type: 'UInt' } },
                rows: [{ Text: words(s.title) }] }
        };
        s.components.forEach((c) => {
            const w = WIDGETS[c.kind](c);
            const cells = {};
            Object.keys(w.cells).forEach((k) => {
                const v = w.cells[k];
                cells[k] = typeof v === 'boolean' ? { value: v, type: 'Bool' } : words(v);
            });
            components[c.id] = { type: w.type, name: c.name,
                properties: { Visible: { value: 1, type: 'UInt' }, Focusable: { value: c.focusable, type: 'UInt' } },
                rows: [cells] };
        });
        containers[s.id] = { type: 'state', name: s.name, components };
    });
    return { schemaVersion: '1.3.0', containers };
}

function applicationJson() {
    return {
        schemaVersion: '1.3.0',
        application: {
            uuid: UUIDS.application, type: 'OnlineApp', name: META.id, vendor: 'owner', version: META.version,
            defaultLanguage: 'en_GB',
            uiDescriptions: [{ applicationFilePath: './uiDescriptions/ID8/application.xml',
                uiDescriptionFilePath: './uiDescriptions/ID8/uiDescription.json', hmi: ['ID8'] }],
            stringBundleUuid: UUIDS.strings,
            resourceBundleUuid: UUIDS.resources,
            variantGroups: [{ stringsPath: './variantGroups/Common/texts', resourcesPath: './variantGroups/Common/images',
                hmi: ['ID8'], brands: ['BMW'] }],
            entryPoints: [{
                name: META.id, uuid: UUIDS.entry, textId: sid(TITLE), icon: ICON,
                insertionStateId: 20974, insertionFocusId: 2, insertionMode: 'INSERT_BELOW', insertionOrder: 0,
                insertionPriority: 0, previewType: 'NONE', bookmarkable: true, private: null, appearance: 'DEFAULT',
                isGroupHeader: false, insertionGroup: 0
            }]
        }
    };
}

function english() {
    const out = { SID_TEMP_EMPTY: '' };
    STATES.forEach((s) => [s.title].concat(s.components.map((c) => c.text)).filter(Boolean)
        .forEach((t) => { out[sid(t)] = t; }));
    return out;
}

function write() {
    fs.mkdirSync(ID8, { recursive: true });
    fs.mkdirSync(TEXTS, { recursive: true });
    fs.writeFileSync(path.join(ID8, 'application.xml'), xml());
    fs.writeFileSync(path.join(ID8, 'uiDescription.json'), JSON.stringify(uiDescription(), null, 2) + '\n');
    fs.writeFileSync(path.join(RHMI, 'application.json'), JSON.stringify(applicationJson(), null, 2) + '\n');
    ['en_GB', 'en_US'].forEach((n) => fs.writeFileSync(path.join(TEXTS, `${n}.json`), JSON.stringify(english(), null, 2) + '\n'));
}

if (require.main === module) {
    write();
    console.log(`wrote ${path.relative(process.cwd(), RHMI)}: ${STATES.length} states`);
}

module.exports = { write, STATES, ID8, ICON, sid };
