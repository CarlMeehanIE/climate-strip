'use strict';
/**
 * Writes the Climate Bar's icons into the service
 * (services/mystrip_bar/mystrip-bar, between its ICONS markers) as
 * 128x128 coverage masks, deflated and base64, from the owner's icon
 * drawings in services/mystrip_bar/icons: an SVG (seat.svg, wheel.svg) drawn
 * straight at 128 px, its fill taken as covered, else the PNG (dark lines on
 * white) scaled up smoothly with its edges sharpened again. The service colours them at its
 * start (white off, red on, dim while unknown).
 *
 * Needs Playwright with Chromium (on the computer, never the car):
 *   node tools/make_bar_icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { chromium } = require('playwright');

const SIZE = 128;
const DIR = path.join(__dirname, '..', 'services', 'mystrip_bar');
const FILE = path.join(DIR, 'mystrip-bar');
const ICONS = ['seat', 'wheel'];

async function masks() {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    const out = {};
    for (const name of ICONS) {
        const svg = path.join(DIR, 'icons', `${name}.svg`);
        const vector = fs.existsSync(svg);
        const url = vector ? `data:image/svg+xml;base64,${fs.readFileSync(svg).toString('base64')}` :
            `data:image/png;base64,${fs.readFileSync(path.join(DIR, 'icons', `${name}.png`)).toString('base64')}`;
        const alpha = await page.evaluate(async ([src, size, vector]) => {
            const img = new Image();
            img.src = src;
            await img.decode();
            if (vector) {
                // its viewBox fitted into the square, centred: the fill's coverage
                const f = document.createElement('canvas');
                f.width = f.height = size;
                const x = f.getContext('2d');
                const fit = Math.min(size / img.width, size / img.height);
                const dw = img.width * fit, dh = img.height * fit;
                x.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
                const d = x.getImageData(0, 0, size, size).data;
                const a = [];
                for (let i = 3; i < d.length; i += 4) a.push(d[i]);
                return a;
            }
            // scaled up in steps of at most 2x, which keeps the curves smooth
            let c = document.createElement('canvas');
            c.width = img.width; c.height = img.height;
            let ctx = c.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
            ctx.drawImage(img, 0, 0);
            const fit = Math.min(size / img.width, size / img.height);
            let w = img.width, h = img.height;
            while (w * 2 <= img.width * fit) {
                const n = document.createElement('canvas');
                n.width = w * 2; n.height = h * 2;
                const x = n.getContext('2d');
                x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
                x.drawImage(c, 0, 0, w * 2, h * 2);
                c = n; w *= 2; h *= 2;
            }
            const f = document.createElement('canvas');
            f.width = f.height = size;
            ctx = f.getContext('2d');
            ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
            ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
            const dw = Math.round(img.width * fit), dh = Math.round(img.height * fit);
            ctx.drawImage(c, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);
            const d = ctx.getImageData(0, 0, size, size).data;
            const a = [];
            for (let i = 0; i < d.length; i += 4) {
                const dark = 1 - (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
                const t = Math.max(0, Math.min(1, (dark - 0.3) / 0.4));     // the blur of scaling taken back to an edge
                a.push(Math.round(t * t * (3 - 2 * t) * 255));
            }
            return a;
        }, [url, SIZE, vector]);
        out[name] = zlib.deflateSync(Buffer.from(alpha), { level: 9 }).toString('base64');
    }
    await browser.close();
    return out;
}

masks().then((m) => {
    const src = fs.readFileSync(FILE, 'utf8');
    const begin = '/* ICONS BEGIN (tools/make_bar_icons.js) */', end = '/* ICONS END */';
    const a = src.indexOf(begin), b = src.indexOf(end);
    if (a < 0 || b < a) {
        throw new Error(`${FILE}: no ICONS markers`);
    }
    const body = `const ICON_SIZE = ${SIZE};\nconst ICON_MASKS = {\n` +
        Object.keys(m).map((k) => `    ${k}: '${m[k]}'`).join(',\n') + '\n};\n';
    fs.writeFileSync(FILE, src.slice(0, a + begin.length) + '\n' + body + src.slice(b));
    console.log(`wrote ${Object.keys(m).length} icon masks into ${path.relative(process.cwd(), FILE)}`);
}).catch((e) => { console.error(e); process.exit(1); });
