/**
 * bench/release_matrix/make_corpus.js
 * ===================================
 *
 * Decodes the photo corpus once and writes it out as raw interleaved 8-bit
 * planes, so that BOTH the Node harness and the native C harness measure the
 * same bytes. A comparison where each side generates its own "photo-like"
 * content is not a comparison.
 *
 * Writes, per image, into ./corpus/:
 *    <name>.rgb.bin    width*height*3   sRGB, straight from the decoder
 *    <name>.cmyk.bin   width*height*4   the same frame separated to GRACoL
 *    corpus.json       dimensions + adjacency for every plane
 *
 * The CMYK plane exists because the CMYK-source workflows need real CMYK
 * input. Generating random CMYK would misrepresent the content axis entirely:
 * a separated photograph has different adjacency from its RGB original (the
 * black channel flattens shadow detail), and that difference is exactly what
 * the content column is measuring.
 *
 * Run:  node bench/release_matrix/make_corpus.js [--src <dir>]
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Transform, eIntent } = require('../../src/main');
const Profile = require('../../src/Profile');

// The corpus images live in ./images/ and are committed, so the published
// comparison is reproducible by anyone who clones the repo — a benchmark whose
// input cannot be obtained is not a benchmark. They are excluded from the npm
// tarball along with the rest of bench/ (see .npmignore). Sources and licence:
// ./images/CREDITS.md
const SRC_DIR = (() => {
    const i = process.argv.indexOf('--src');
    return i !== -1 && process.argv[i + 1]
        ? process.argv[i + 1]
        : path.join(__dirname, 'images');
})();

const OUT_DIR     = path.join(__dirname, 'corpus');
const GRACOL_PATH = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

function adjacency(pixels, count, channels) {
    let hits = 0;
    for (let p = 1; p < count; p++) {
        let same = true;
        for (let c = 0; c < channels; c++) {
            if (pixels[p * channels + c] !== pixels[(p - 1) * channels + c]) { same = false; break; }
        }
        if (same) hits++;
    }
    return count > 1 ? hits / (count - 1) : 0;
}

async function main() {
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    const { createCanvas, loadImage } = require('canvas');

    const gracol = new Profile();
    await gracol.loadPromise('file:' + GRACOL_PATH);
    if (!gracol.loaded) throw new Error('failed to load GRACoL');

    const toCmyk = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int' });
    toCmyk.create('*sRGB', gracol, eIntent.relative);

    const files = fs.readdirSync(SRC_DIR).filter(f => /\.(png|jpe?g)$/i.test(f)).sort();
    if (!files.length) throw new Error('no images in ' + SRC_DIR);

    const manifest = [];
    for (const file of files) {
        const image  = await loadImage(path.join(SRC_DIR, file));
        const canvas = createCanvas(image.width, image.height);
        canvas.getContext('2d').drawImage(image, 0, 0);
        const rgba = canvas.getContext('2d').getImageData(0, 0, image.width, image.height).data;

        const count = image.width * image.height;
        const rgb = new Uint8ClampedArray(count * 3);
        for (let i = 0; i < count; i++) {
            rgb[i * 3]     = rgba[i * 4];
            rgb[i * 3 + 1] = rgba[i * 4 + 1];
            rgb[i * 3 + 2] = rgba[i * 4 + 2];
        }
        const cmyk = toCmyk.transformArray(rgb, false, false, false, count);

        const stem = file.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40);
        fs.writeFileSync(path.join(OUT_DIR, stem + '.rgb.bin'),  Buffer.from(rgb.buffer, rgb.byteOffset, count * 3));
        fs.writeFileSync(path.join(OUT_DIR, stem + '.cmyk.bin'), Buffer.from(cmyk.buffer, cmyk.byteOffset, count * 4));

        const entry = {
            file, stem, width: image.width, height: image.height, pixels: count,
            adjRgb:  +(adjacency(rgb,  count, 3) * 100).toFixed(2),
            adjCmyk: +(adjacency(cmyk, count, 4) * 100).toFixed(2),
        };
        manifest.push(entry);
        console.log(`${stem.padEnd(42)} ${image.width}x${image.height}  ${String(count).padStart(9)} px` +
                    `  adj rgb ${entry.adjRgb.toFixed(2).padStart(6)}%  cmyk ${entry.adjCmyk.toFixed(2).padStart(6)}%`);
    }

    const meanRgb  = manifest.reduce((a, e) => a + e.adjRgb,  0) / manifest.length;
    const meanCmyk = manifest.reduce((a, e) => a + e.adjCmyk, 0) / manifest.length;
    console.log(`${'MEAN'.padEnd(42)} ${' '.repeat(23)}  adj rgb ${meanRgb.toFixed(2).padStart(6)}%  cmyk ${meanCmyk.toFixed(2).padStart(6)}%`);

    fs.writeFileSync(path.join(OUT_DIR, 'corpus.json'),
        JSON.stringify({ source: SRC_DIR, generated: new Date().toISOString(), images: manifest,
                         meanAdjRgb: +meanRgb.toFixed(2), meanAdjCmyk: +meanCmyk.toFixed(2) }, null, 2));
    console.log('\nwrote ' + manifest.length * 2 + ' planes + corpus.json to ' + OUT_DIR);
}

main().catch(e => { console.error(e); process.exit(1); });
