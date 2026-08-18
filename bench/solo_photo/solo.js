/**
 * bench/solo_photo/solo.js
 * ========================
 *
 * THE CONTROL BENCH. One photograph, one engine, one process, nothing else.
 *
 * Why this exists
 * ---------------
 * Every other harness in this repo measures several things in sequence, and we
 * have now been burned twice by that:
 *
 *   - The old browser/Node benches reported ~210 MPx/s, which turned out to be
 *     measured on an input containing 256 distinct colours.
 *   - The release matrix reported ~97 MPx/s on corrected noise — but that
 *     harness also measures five content classes and four engines, and a
 *     shared process was independently shown to cost 27% on an identical
 *     workload (docs/deepdive/benchmark.md, "Schrodinger's Bench").
 *
 * So the corrected numbers are themselves suspect in the *other* direction:
 * we cannot tell how much of the drop was the input and how much was our own
 * harness until something measures a single workload with no neighbours at
 * all. That is this file.
 *
 * What it deliberately does NOT do
 * --------------------------------
 *   - No second engine in the process. `--engine` picks exactly one; the
 *     others are never constructed, so no call site ever sees two shapes.
 *   - No second content type. One image buffer, built once.
 *   - No second buffer size.
 *   - No lcms-wasm import. Loading a 300 KB wasm module and its heap next to
 *     the thing being timed is exactly the sort of neighbour we are trying to
 *     rule out.
 *
 * Each run reports the FULL distribution, not a median, because the question
 * being asked is "how stable is this number", and a median hides that.
 *
 * Run:
 *   node bench/solo_photo/solo.js                      # all engines, 5 procs each
 *   node bench/solo_photo/solo.js --repeat 9
 *   node bench/solo_photo/solo.js --image <stem> --workflow rgb2cmyk
 *   node bench/solo_photo/solo.js --engine simd --child # one measurement, raw
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Transform, eIntent } = require('../../src/main');
const Profile = require('../../src/Profile');

const CORPUS_DIR  = path.join(__dirname, '..', 'release_matrix', 'corpus');
const GRACOL_PATH = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');
const ADOBE_PATH  = path.join(__dirname, '..', '..', 'samples', 'profiles', 'AdobeRGB1998.icc');

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : fallback;
}

const IS_CHILD  = process.argv.includes('--child');
const ENGINE    = arg('engine', 'int');
const REPEAT    = Number(arg('repeat', 5));
const IMAGE     = arg('image', 'jacek-dylag-559115_STRAWBERRIES-unsplash');
const WORKFLOW  = arg('workflow', 'rgb2lab');

// Long warmup on purpose: the point is to give TurboFan every chance to reach
// its final tier before a single timed sample is taken, so that what remains
// is the kernel and not the compiler catching up.
const WARMUP_MS  = 3000;
const SAMPLE_MS  = 500;
const SAMPLES    = 7;

const ENGINES = {
    'int':    { dataFormat: 'int8', buildLut: true, lutMode: 'int' },
    'scalar': { dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar' },
    'simd':   { dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd' },
};

const WORKFLOWS = {
    rgb2lab:  { channels: 3, chain: g => ['*sRGB', eIntent.relative, '*labd50'] },
    rgb2rgb:  { channels: 3, chain: (g, a) => ['*sRGB', eIntent.relative, a] },
    rgb2cmyk: { channels: 3, chain: g => ['*sRGB', eIntent.relative, g] },
    cmyk2rgb: { channels: 4, chain: g => [g, eIntent.relative, '*sRGB'] },
};

function loadImage(stem, channels) {
    const suffix = channels === 3 ? '.rgb.bin' : '.cmyk.bin';
    const file = fs.readdirSync(CORPUS_DIR).find(f => f.endsWith(suffix) && f.startsWith(stem));
    if (!file) throw new Error('no corpus plane for ' + stem + suffix +
        ' — run: node bench/release_matrix/make_corpus.cjs');
    const raw = fs.readFileSync(path.join(CORPUS_DIR, file));
    const pixels = new Uint8ClampedArray(raw.length);
    pixels.set(raw);
    return { pixels, count: (raw.length / channels) | 0 };
}

async function runChild() {
    const workflow = WORKFLOWS[WORKFLOW];
    const options  = ENGINES[ENGINE];
    if (!workflow) throw new Error('unknown workflow ' + WORKFLOW);
    if (!options)  throw new Error('unknown engine ' + ENGINE);

    const gracol = new Profile();
    await gracol.loadPromise('file:' + GRACOL_PATH);
    const adobe = new Profile();
    await adobe.loadPromise('file:' + ADOBE_PATH);

    const image = loadImage(IMAGE, workflow.channels);
    const transform = new Transform(options);
    transform.createMultiStage(workflow.chain(gracol, adobe));

    // Reuse one output buffer so allocation is not inside the timed region.
    const run = () => transform.transformArray(image.pixels, false, false, false, image.count);

    let t0 = process.hrtime.bigint();
    run();
    let oneMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (oneMs <= 0) oneMs = 0.001;

    for (let i = 0, n = Math.max(3, Math.round(WARMUP_MS / oneMs)); i < n; i++) run();

    const iters = Math.max(1, Math.round(SAMPLE_MS / oneMs));
    const mpx = [];
    for (let s = 0; s < SAMPLES; s++) {
        t0 = process.hrtime.bigint();
        for (let i = 0; i < iters; i++) run();
        const ms = Number(process.hrtime.bigint() - t0) / 1e6 / iters;
        mpx.push((image.count / 1e6) / (ms / 1000));
    }
    // BEST of the samples, not the median: within one warm process the fastest
    // sample is the one least disturbed by the OS, and this file's job is to
    // find the ceiling. Spread across processes is reported by the parent.
    console.log(Math.max(...mpx).toFixed(2) + ' ' + image.count);
}

function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[(sorted.length / 2) | 0];
    const spread = ((sorted[sorted.length - 1] - sorted[0]) / sorted[0]) * 100;
    return { min: sorted[0], median, max: sorted[sorted.length - 1], spread };
}

function runParent() {
    console.log('='.repeat(92));
    console.log(' Solo photo bench — ONE image, ONE engine, ONE process per measurement');
    console.log('='.repeat(92));
    console.log(' image     : ' + IMAGE);
    console.log(' workflow  : ' + WORKFLOW);
    console.log(' processes : ' + REPEAT + ' per engine, each warmed ' + (WARMUP_MS / 1000) + 's then ' + SAMPLES + ' samples');
    console.log(' node      : ' + process.version + '   platform: ' + process.platform + ' ' + process.arch);
    console.log('');
    console.log(' engine    best of each process (MPx/s)                              median    spread');
    console.log(' --------  ------------------------------------------------------  --------  --------');

    for (const engine of Object.keys(ENGINES)) {
        const runs = [];
        let pixels = 0;
        for (let r = 0; r < REPEAT; r++) {
            const out = execFileSync(process.execPath, [
                __filename, '--child', '--engine', engine,
                '--image', IMAGE, '--workflow', WORKFLOW,
            ], { encoding: 'utf8' }).trim().split(/\s+/);
            runs.push(Number(out[0]));
            pixels = Number(out[1]);
        }
        const s = stats(runs);
        console.log(' ' + engine.padEnd(9) +
            runs.map(v => v.toFixed(1).padStart(7)).join('').padEnd(56) +
            s.median.toFixed(1).padStart(8) + '  ' + s.spread.toFixed(1).padStart(6) + '%');
    }

    console.log('');
    console.log(' Spread is max-min across processes. If it is small, the number is real;');
    console.log(' if it is large, no single-run figure from any harness should be trusted.');
    console.log('');
}

if (IS_CHILD) runChild().catch(e => { console.error(e); process.exit(1); });
else runParent();
