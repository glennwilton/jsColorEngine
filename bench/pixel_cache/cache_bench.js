/**
 * bench/pixel_cache/cache_bench.js
 * ================================
 *
 * What is a pixel cache actually worth?
 *
 * The cache memoises the accuracy path: if a colour has been seen before, the
 * maths is skipped and the cached result reused. Whether that pays depends
 * entirely on the CONTENT — so this measures hit rate and throughput across
 * synthetic patterns and real photographs.
 *
 * HIT RATE is the number to take away. It is a property of the data, not of
 * the implementation, so it also answers whether a cache is worth adding to
 * the image kernels. The TIMINGS here do NOT transfer to that question:
 * register pressure and branch misprediction dominate in the kernels and are
 * near-free on this path (see docs/deepdive/PixelCache.md).
 *
 * Content:
 *   noise         worst case — every pixel unique
 *   gradient      short flat runs, the lcms harness's BENCH_INPUT=gradient
 *   checkerboard  strict alternation — the case a single-entry cache cannot
 *                 catch and a keyed table can
 *   solid         best case — one colour
 *   palette8      synthetic flat art: 8 colours, no spatial coherence
 *   *.png         real photographs from samples/images/
 *
 * Run:  node bench/pixel_cache/cache_bench.js
 *       node bench/pixel_cache/cache_bench.js --pixels 400000 --iters 5
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { Transform, eIntent } = require('../../src/main');

// ----------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------

function argValue(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return (i !== -1 && process.argv[i + 1]) ? Number(process.argv[i + 1]) : fallback;
}

function argString(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : fallback;
}

const MAX_PIXELS  = argValue('pixels', 250000);
const TIMED_ITERS = argValue('iters', 3);
const WARMUP      = 1;
// --slots 0,1,16,32,64 to sweep table sizes. 0 is the uncached baseline and
// should always be first. Noise is the useful row for reading the miss-path
// cost of each size, because it never hits.
const CACHE_MODES = argString('slots', '0,1,16,32')
    .split(',').map(s => Number(s.trim()));
const SKIP_SYNTHETIC = process.argv.indexOf('--images-only') !== -1;

// --images <dir> to point at a different corpus. The bundled
// samples/images/ set is small and was authored/adjusted rather than shot,
// so it is a starting point, not a corpus.
const IMAGE_DIR = argString('images', path.join(__dirname, '..', '..', 'samples', 'images'));

// ----------------------------------------------------------------------
// Content generators — all return Uint8ClampedArray of RGB triplets
// ----------------------------------------------------------------------

function makeNoise(pixelCount) {
    const out = new Uint8ClampedArray(pixelCount * 3);
    let seed = 0x13579bdf;                       // same LCG as bench/lcms_c
    for (let i = 0; i < out.length; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) | 0;
        out[i] = (seed >>> 16) & 0xFF;
    }
    return out;
}

function makeGradient(pixelCount, width = 1024) {
    const out = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const x = i % width;
        const y = (i / width) | 0;
        for (let c = 0; c < 3; c++) {
            out[i * 3 + c] = ((x >> 2) + (y >> 3) + c * 40) & 0xFF;   // 4-px flat runs
        }
    }
    return out;
}

function makeCheckerboard(pixelCount, width = 1024) {
    const out = new Uint8ClampedArray(pixelCount * 3);
    const a = [30, 60, 200];
    const b = [220, 180, 40];
    for (let i = 0; i < pixelCount; i++) {
        const x = i % width;
        const y = (i / width) | 0;
        const colour = ((x + y) & 1) ? a : b;    // alternates every pixel
        out[i * 3] = colour[0]; out[i * 3 + 1] = colour[1]; out[i * 3 + 2] = colour[2];
    }
    return out;
}

function makeSolid(pixelCount) {
    const out = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        out[i * 3] = 137; out[i * 3 + 1] = 42; out[i * 3 + 2] = 199;
    }
    return out;
}

function makePalette8(pixelCount) {
    const palette = [
        [255, 255, 255], [0, 0, 0], [237, 28, 36], [0, 166, 81],
        [46, 49, 146], [255, 242, 0], [140, 98, 57], [190, 190, 190],
    ];
    const out = new Uint8ClampedArray(pixelCount * 3);
    let seed = 0x2468ace0;
    for (let i = 0; i < pixelCount; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) | 0;
        const colour = palette[(seed >>> 16) % palette.length];
        out[i * 3] = colour[0]; out[i * 3 + 1] = colour[1]; out[i * 3 + 2] = colour[2];
    }
    return out;
}

/** Real image → RGB triplets, alpha dropped. Uses `canvas` (already a dep). */
async function loadImageRGB(file, maxPixels) {
    const { createCanvas, loadImage } = require('canvas');
    const image = await loadImage(file);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, image.width, image.height).data;

    // NOTE: this takes the first n pixels, i.e. a top strip. That is fine for
    // a whole image and misleading for a crop — see the warning at the call
    // site. Striding would sample the frame evenly but destroy adjacency,
    // which is exactly what the slots=1 column measures, so cropping is the
    // lesser evil; the answer is to raise --pixels, not to stride.
    const pixelCount = Math.min(image.width * image.height, maxPixels);
    const out = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        out[i * 3]     = rgba[i * 4];
        out[i * 3 + 1] = rgba[i * 4 + 1];
        out[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return { pixels: out, pixelCount, width: image.width, height: image.height };
}

// ----------------------------------------------------------------------
// Measurement
// ----------------------------------------------------------------------

function measure(pixels, pixelCount, cacheSlots) {
    const transform = new Transform({
        dataFormat: 'int8', buildLut: false, pixelCache: cacheSlots
    });
    transform.create('*sRGB', '*AdobeRGB', eIntent.relative);

    for (let w = 0; w < WARMUP; w++) {
        transform.transformArray(pixels, false, false, false, pixelCount);
    }

    transform.resetPixelCacheStats();
    const times = [];
    for (let it = 0; it < TIMED_ITERS; it++) {
        const t0 = process.hrtime.bigint();
        transform.transformArray(pixels, false, false, false, pixelCount);
        const t1 = process.hrtime.bigint();
        times.push(Number(t1 - t0) / 1e6);
    }
    times.sort((a, b) => a - b);
    const medianMs = times[times.length >> 1];

    return {
        mpx: pixelCount / (medianMs * 1000),
        stats: transform.getPixelCacheStats()
    };
}

function reportRow(label, pixelCount, results) {
    const baseline = results[0].mpx;
    const cells = results.map((r, i) => {
        const speed = r.mpx.toFixed(2).padStart(6);
        if (i === 0) return `${speed}       -      -`;
        const rate = (r.stats.hitRate * 100).toFixed(1).padStart(5);
        const gain = (r.mpx / baseline).toFixed(2).padStart(5);
        return `${speed}   ${rate}%  ${gain}x`;
    });
    console.log('  ' + label.padEnd(16) + String(pixelCount).padStart(8) + '   ' + cells.join('  '));
}

function header() {
    console.log('');
    console.log('  content            pixels   ' +
        CACHE_MODES.map(m => (m === 0 ? 'cache off' : `slots=${m}`).padEnd(m === 0 ? 20 : 21)).join(''));
    console.log('  ' + '-'.repeat(16) + ' ' + '-'.repeat(8) + '   ' +
        CACHE_MODES.map(() => '-'.repeat(19)).join('  '));
}

// ----------------------------------------------------------------------

async function main() {
    console.log('='.repeat(100));
    console.log(' Pixel cache — hit rate and throughput by content type');
    console.log(' sRGB -> AdobeRGB, accuracy path (buildLut: false), median of ' + TIMED_ITERS);
    console.log('='.repeat(100));
    console.log('');
    console.log(' HIT RATE is the transferable number — it describes the DATA. The MPx/s');
    console.log(' figures describe this path only and must NOT be used to argue about the');
    console.log(' image kernels; see docs/deepdive/PixelCache.md.');
    header();

    if (!SKIP_SYNTHETIC) {
        const synthetic = [
            ['noise',        makeNoise(MAX_PIXELS)],
            ['gradient',     makeGradient(MAX_PIXELS)],
            ['checkerboard', makeCheckerboard(MAX_PIXELS)],
            ['palette8',     makePalette8(MAX_PIXELS)],
            ['solid',        makeSolid(MAX_PIXELS)],
        ];

        for (const [label, pixels] of synthetic) {
            const results = CACHE_MODES.map(m => measure(pixels, MAX_PIXELS, m));
            reportRow(label, MAX_PIXELS, results);
        }
    }

    // Real photographs
    let files = [];
    try {
        files = fs.readdirSync(IMAGE_DIR).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
    } catch (e) {
        console.log('\n  (no samples/images directory — skipping real images)');
    }

    if (files.length) {
        console.log('');
        for (const file of files) {
            let image;
            try {
                image = await loadImageRGB(path.join(IMAGE_DIR, file), MAX_PIXELS);
            } catch (error) {
                console.log('  ' + file.padEnd(16) + '  skipped: ' + error.message);
                continue;
            }
            const fullPixels = image.width * image.height;
            if (image.pixelCount < fullPixels) {
                // --pixels takes the FIRST n pixels, which is a top strip, not
                // a sample. On a large frame that is usually sky or background
                // and reads nothing like the whole image: one test photo
                // measured 3.2% over the full frame and 7.5% over the top 250k.
                const pct = ((image.pixelCount / fullPixels) * 100).toFixed(1);
                console.log(`  ! ${file.slice(0, 24)} cropped to top ${pct}% ` +
                    `(${image.pixelCount} of ${fullPixels}) — raise --pixels for a real figure`);
            }
            const results = CACHE_MODES.map(m => measure(image.pixels, image.pixelCount, m));
            reportRow(file.slice(0, 24), image.pixelCount, results);
        }
    }

    console.log('');
    console.log(' Reading it: a single entry (slots=1) only catches a colour repeated');
    console.log(' immediately; the tables also catch colours that recur later. Checkerboard');
    console.log(' separates the two — strict alternation defeats slots=1 entirely.');
    console.log('');
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
