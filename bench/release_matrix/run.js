/**
 * bench/release_matrix/run.js
 * ===========================
 *
 * The JavaScript half of the release comparison in docs/LcmsComparison.md.
 * Its native counterpart is bench/lcms_c/bench_content_matrix.c, and the two
 * are deliberately kept in lockstep: same six workflows, same five content
 * generators, same PRNG constants, same profiles, same photo corpus bytes.
 *
 * Axes
 * ----
 *   ENGINE   jsCE int (pure JS)  ·  jsCE WASM SIMD  ·  lcms-wasm  ·
 *            lcms-wasm NOCACHE
 *   CONTENT  noise / gradient / blocks16 / solid / photo corpus
 *   SIZE     pixels per iteration (--sizes)
 *
 * WHY THE NOCACHE COLUMN IS NOT PADDING
 * -------------------------------------
 * lcms memoises the previous pixel inside cmsDoTransform. Without a NOCACHE
 * column, a change in the *input image* reads as a difference between the
 * *libraries* — which is how a 3x speedup appears from nowhere. Where cached
 * and NOCACHE agree, the figure is the transform's real throughput; where they
 * diverge, the gap is the memo cache and nothing else.
 *
 * jsCE's own kernels are content-neutral by construction — no memo — so its
 * columns should sit flat across the content rows. That flatness is a result,
 * not an assumption: if a jsCE column moves with content, something is wrong.
 *
 * The pixel cache is measured separately (--pixelcache), because it lives on
 * the accuracy path (buildLut:false) rather than the LUT kernels, so putting
 * it in the main table would compare two different baselines in one row.
 *
 * Run:
 *   node bench/release_matrix/make_corpus.js      # once, decodes the photos
 *   node bench/release_matrix/run.js
 *   node bench/release_matrix/run.js --sizes 16384,65536,1048576,10485760
 *   node bench/release_matrix/run.js --pixelcache
 */

import { readFile } from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
    instantiate,
    TYPE_RGB_8, TYPE_CMYK_8, TYPE_Lab_8,
    INTENT_RELATIVE_COLORIMETRIC,
    cmsFLAGS_NOCACHE, cmsFLAGS_SOFTPROOFING,
} from 'lcms-wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

const { Transform, eIntent } = require('../../src/main');
const Profile                = require('../../src/Profile');

const GRACOL_PATH = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');
const ADOBE_PATH  = path.join(__dirname, '..', '..', 'samples', 'profiles', 'AdobeRGB1998.icc');
const CORPUS_DIR  = path.join(__dirname, 'corpus');

// ---- arguments ---------------------------------------------------------

function argString(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : fallback;
}

const SIZES        = argString('sizes', '65536').split(',').map(s => parseInt(s.trim(), 10));
const CONTENTS     = argString('content', 'noise,gradient,blocks16,solid,photo').split(',').map(s => s.trim());
const PIXEL_CACHE  = process.argv.indexOf('--pixelcache') !== -1;

// --cell <wfIndex>:<content>:<engine>:<npx> measures exactly one number and
// prints it. --isolate makes the parent spawn one child process per cell.
//
// WHY THIS EXISTS. Measuring several content rows through one long-lived
// process gave 59.5 MPx/s where an isolated run of the identical workflow,
// content and buffer size gave 75.4 — a 27% swing produced by nothing but
// which rows had already gone through the same call site. V8 specialises a
// call site to what it has seen; feed it five buffers and it optimises for
// none of them, and no amount of warmup inside that process undoes it. Every
// cell therefore gets a fresh process, a fresh heap and its own warmup. That
// is slower to run and it is the only version whose rows can be compared.
const CELL         = argString('cell', null);
const ISOLATE      = process.argv.indexOf('--isolate') !== -1;
const TIMED_BATCHES = 5;
const TARGET_BATCH_MS = 400;
const WARMUP_MS       = 800;   // TurboFan tier-up; longer than the C harness needs

// ---- content generators — byte-identical to bench_content_matrix.c ------

// TWO CORRECTIONS LIVE IN THESE FOUR LINES, both of which silently made the
// "hardest case" row easy:
//
// 1. Math.imul, not `*`. The C harness wraps in uint32; plain JS
//    multiplication runs in f64, blows past 2^53, loses the low bits and
//    collapses into short cycles. Measured adjacency of the naive version:
//    21.6% — so the row meant to give lcms's memo cache nothing was handing it
//    a fifth of the pixels.
//
// 2. HIGH bits, not low. An LCG's low bits have a tiny period: bit 0 alternates,
//    and `seed & 0xff` cycles with period 256. Adjacency still reads 0.0%
//    (consecutive pixels do differ), so the defect is invisible in the metric
//    the harness reports — but the buffer only ever contains **256 distinct
//    colours**, which fits the CLUT working set entirely in L1. The row
//    presented as "no cache hits, hardest case" was in fact the *easiest* case
//    for interpolation: measured 164 MPx/s at 256 colours against 96 MPx/s for
//    the same pixel count spread over 41,077 colours.
//
// `seed >>> 23` takes bits 23-30 and yields ~1,016,892 distinct colours per
// megapixel at the same 0.0% adjacency. Any generator added here must be
// checked for BOTH properties — adjacency alone does not detect this.
function genNoise(buf) {
    let seed = 0x13579bdf;
    for (let i = 0; i < buf.length; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        buf[i] = (seed >>> 23) & 0xff;
    }
}

function genGradient(buf, npx, channels) {
    const width = 1024;
    for (let p = 0; p < npx; p++) {
        const x = p % width, y = (p / width) | 0;
        for (let c = 0; c < channels; c++) buf[p * channels + c] = ((x >> 2) + (y >> 3) + c * 40) & 0xff;
    }
}

function genBlocks16(buf, npx, channels) {
    const width = 1024, bw = 16, bh = 16;
    const height = Math.ceil(npx / width);
    let seed = 0x13579bdf;
    const colour = new Uint8Array(4);
    for (let y = 0; y < height; y += bh) {
        for (let x = 0; x < width; x += bw) {
            for (let c = 0; c < channels; c++) {
                seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
                colour[c] = (seed >>> 23) & 0xff;
            }
            for (let dy = 0; dy < bh && y + dy < height; dy++) {
                for (let dx = 0; dx < bw && x + dx < width; dx++) {
                    const p = (y + dy) * width + (x + dx);
                    if (p >= npx) continue;
                    for (let c = 0; c < channels; c++) buf[p * channels + c] = colour[c];
                }
            }
        }
    }
}

function genSolid(buf, npx, channels) {
    let seed = 0x13579bdf;
    const px = new Uint8Array(4);
    for (let c = 0; c < channels; c++) { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; px[c] = (seed >>> 23) & 0xff; }
    for (let p = 0; p < npx; p++) for (let c = 0; c < channels; c++) buf[p * channels + c] = px[c];
}

// The photo planes are pre-decoded by make_corpus.js and tiled to fill the
// buffer. One seam per wrap is negligible against millions of pixels, and it
// keeps the size axis usable for a corpus smaller than the largest buffer.
const photoPlane = {};
function loadPhotoPlanes() {
    for (const channels of [3, 4]) {
        const suffix = channels === 3 ? '.rgb.bin' : '.cmyk.bin';
        let files;
        try { files = fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith(suffix)).sort(); }
        catch { return false; }
        if (!files.length) return false;
        const parts = files.map(f => fs.readFileSync(path.join(CORPUS_DIR, f)));
        photoPlane[channels] = Buffer.concat(parts);
    }
    return true;
}

function genPhoto(buf, npx, channels) {
    const src = photoPlane[channels];
    const have = (src.length / channels) | 0;
    for (let p = 0; p < npx; p++) {
        const s = (p % have) * channels;
        for (let c = 0; c < channels; c++) buf[p * channels + c] = src[s + c];
    }
}

// `image:<stem>` measures one corpus photograph on its own, rather than the
// tiled concatenation. Real frames traverse colour space in regions — sky,
// then grass — so the CLUT working set is both small and *sliding*, which no
// synthetic generator reproduces. Per-image rows are what test whether a
// colourful frame really does cost more than a harmonious one.
function loadSingleImage(stem, channels) {
    const suffix = channels === 3 ? '.rgb.bin' : '.cmyk.bin';
    const file = fs.readdirSync(CORPUS_DIR)
        .find(f => f.endsWith(suffix) && f.slice(0, -suffix.length) === stem);
    if (!file) throw new Error('no corpus plane for ' + stem + suffix);
    return fs.readFileSync(path.join(CORPUS_DIR, file));
}

function buildContent(kind, npx, channels) {
    if (kind.startsWith('image:')) {
        const src = loadSingleImage(kind.slice(6), channels);
        const have = (src.length / channels) | 0;
        const buf = new Uint8ClampedArray(npx * channels);
        for (let p = 0; p < npx; p++) {
            const s = (p % have) * channels;
            for (let c = 0; c < channels; c++) buf[p * channels + c] = src[s + c];
        }
        return buf;
    }
    const buf = new Uint8ClampedArray(npx * channels);
    switch (kind) {
        case 'noise':    genNoise(buf); break;
        case 'gradient': genGradient(buf, npx, channels); break;
        case 'blocks16': genBlocks16(buf, npx, channels); break;
        case 'photo':    genPhoto(buf, npx, channels); break;
        default:         genSolid(buf, npx, channels); break;
    }
    return buf;
}

function adjacency(buf, npx, channels) {
    let hits = 0;
    for (let p = 1; p < npx; p++) {
        let same = true;
        for (let c = 0; c < channels; c++) {
            if (buf[p * channels + c] !== buf[(p - 1) * channels + c]) { same = false; break; }
        }
        if (same) hits++;
    }
    return npx > 1 ? (hits / (npx - 1)) * 100 : 0;
}

// ---- timing ------------------------------------------------------------
//
// Auto-scaled to ~TARGET_BATCH_MS per batch, median of TIMED_BATCHES, matching
// the C harness so the two sets of figures are directly comparable.

function timeFn(fn) {
    let t0 = process.hrtime.bigint();
    fn();
    let oneMs = Number(process.hrtime.bigint() - t0) / 1e6;
    if (oneMs <= 0) oneMs = 0.001;

    const warmIters = Math.max(3, Math.min(20000, Math.round(WARMUP_MS / oneMs)));
    for (let i = 0; i < warmIters; i++) fn();

    const iters = Math.max(3, Math.min(20000, Math.round(TARGET_BATCH_MS / oneMs)));
    const samples = [];
    for (let r = 0; r < TIMED_BATCHES; r++) {
        t0 = process.hrtime.bigint();
        for (let i = 0; i < iters; i++) fn();
        samples.push(Number(process.hrtime.bigint() - t0) / 1e6 / iters);
    }
    samples.sort((a, b) => a - b);
    return samples[TIMED_BATCHES >> 1];
}

const mpx = (npx, ms) => (npx / 1e6) / (ms / 1000);

// ---- setup -------------------------------------------------------------

const lcms = await instantiate();

const gracolBytes = await readFile(GRACOL_PATH);
const adobeBytes  = await readFile(ADOBE_PATH);
const lcmsGRACoL  = lcms.cmsOpenProfileFromMem(new Uint8Array(gracolBytes), gracolBytes.byteLength);
const lcmsAdobe   = lcms.cmsOpenProfileFromMem(new Uint8Array(adobeBytes),  adobeBytes.byteLength);
const lcmsSRGB    = lcms.cmsCreate_sRGBProfile();
const lcmsLab     = lcms.cmsCreateLab4Profile(null);
if (!lcmsGRACoL || !lcmsAdobe || !lcmsSRGB || !lcmsLab) throw new Error('lcms-wasm: profile open failed');

const jsGRACoL = new Profile();
await jsGRACoL.loadPromise('file:' + GRACOL_PATH);
const jsAdobe = new Profile();
await jsAdobe.loadPromise('file:' + ADOBE_PATH);
if (!jsGRACoL.loaded || !jsAdobe.loaded) throw new Error('jsColorEngine: profile load failed');

const havePhoto = loadPhotoPlanes();
const contents  = CONTENTS.filter(c => c !== 'photo' || havePhoto);
if (!havePhoto && CONTENTS.includes('photo')) {
    console.error('NOTE: no photo corpus in ' + CORPUS_DIR + ' — photo rows skipped.\n' +
                  '      Generate with: node bench/release_matrix/make_corpus.js\n');
}

// ---- workflows ---------------------------------------------------------
//
// RGB->RGB is sRGB->AdobeRGB, never sRGB->sRGB: both engines detect the
// identity and collapse it, which measures nothing. Soft-proof is the other
// RGB-in/RGB-out workflow, and it DOES go through a 3D LUT — the pair
// separates "matrix-shaper fast path" from "interpolation" at identical
// pixel formats.

const WORKFLOWS = [
    {
        name: 'RGB -> RGB  (matrix)', inCh: 3, outCh: 3,
        lcms: { pIn: lcmsSRGB, fIn: TYPE_RGB_8, pOut: lcmsAdobe, fOut: TYPE_RGB_8 },
        js:   { chain: ['*sRGB', eIntent.relative, jsAdobe] },
    },
    {
        name: 'RGB -> Lab', inCh: 3, outCh: 3,
        lcms: { pIn: lcmsSRGB, fIn: TYPE_RGB_8, pOut: lcmsLab, fOut: TYPE_Lab_8 },
        js:   { chain: ['*sRGB', eIntent.relative, '*labd50'] },
    },
    {
        name: 'RGB -> CMYK', inCh: 3, outCh: 4,
        lcms: { pIn: lcmsSRGB, fIn: TYPE_RGB_8, pOut: lcmsGRACoL, fOut: TYPE_CMYK_8 },
        js:   { chain: ['*sRGB', eIntent.relative, jsGRACoL] },
    },
    {
        name: 'CMYK -> RGB', inCh: 4, outCh: 3,
        lcms: { pIn: lcmsGRACoL, fIn: TYPE_CMYK_8, pOut: lcmsSRGB, fOut: TYPE_RGB_8 },
        js:   { chain: [jsGRACoL, eIntent.relative, '*sRGB'] },
    },
    {
        name: 'CMYK -> CMYK', inCh: 4, outCh: 4,
        lcms: { pIn: lcmsGRACoL, fIn: TYPE_CMYK_8, pOut: lcmsGRACoL, fOut: TYPE_CMYK_8 },
        js:   { chain: [jsGRACoL, eIntent.relative, jsGRACoL] },
    },
    {
        name: 'RGB -> RGB  (softproof)', inCh: 3, outCh: 3, softproof: true,
        lcms: { pIn: lcmsSRGB, fIn: TYPE_RGB_8, pOut: lcmsSRGB, fOut: TYPE_RGB_8 },
        js:   { chain: ['*sRGB', eIntent.relative, jsGRACoL, eIntent.relative, '*sRGB'] },
    },
];

function makeJsTransform(wf, options) {
    const transform = new Transform(options);
    transform.createMultiStage(wf.js.chain);
    return transform;
}

function timeLcms(wf, input, npx, flags) {
    const inPtr  = lcms._malloc(npx * wf.inCh);
    const outPtr = lcms._malloc(npx * wf.outCh);
    lcms.HEAPU8.set(input, inPtr);
    const xf = wf.softproof
        ? lcms.cmsCreateProofingTransform(lcmsSRGB, wf.lcms.fIn, lcmsSRGB, wf.lcms.fOut, lcmsGRACoL,
              INTENT_RELATIVE_COLORIMETRIC, INTENT_RELATIVE_COLORIMETRIC, flags | cmsFLAGS_SOFTPROOFING)
        : lcms.cmsCreateTransform(wf.lcms.pIn, wf.lcms.fIn, wf.lcms.pOut, wf.lcms.fOut,
              INTENT_RELATIVE_COLORIMETRIC, flags);
    if (!xf) throw new Error('lcms-wasm: cmsCreateTransform failed');
    const ms = timeFn(() => { lcms._cmsDoTransform(xf, inPtr, outPtr, npx); });
    lcms.cmsDeleteTransform(xf);
    lcms._free(inPtr); lcms._free(outPtr);
    return ms;
}

// ---- one isolated cell -------------------------------------------------
//
// Measures a single (workflow, content, engine, size) and prints one number.
// Invoked as a child process by runIsolated(); also runnable by hand when a
// single figure looks wrong and you want it without the rest of the matrix.

function runCell(spec) {
    // '|' not ':' — a content key can itself be 'image:<stem>'
    const [wfIndex, kind, engine, npxRaw] = spec.split('|');
    const wf  = WORKFLOWS[Number(wfIndex)];
    const npx = Number(npxRaw);
    const input = buildContent(kind, npx, wf.inCh);

    let ms;
    if (engine === 'int' || engine === 'simd') {
        const transform = makeJsTransform(wf, {
            dataFormat: 'int8', buildLut: true,
            lutMode: engine === 'int' ? 'int' : 'int-wasm-simd',
        });
        ms = timeFn(() => { transform.transformArray(input, false, false, false, npx); });
    } else {
        ms = timeLcms(wf, input, npx, engine === 'lcmsnc' ? cmsFLAGS_NOCACHE : 0);
    }
    // adjacency and distinct-colour count travel with the cell so the parent
    // never has to rebuild the content just to describe it
    console.log(mpx(npx, ms).toFixed(2) + ' ' + adjacency(input, npx, wf.inCh).toFixed(2) +
                ' ' + distinctColours(input, npx, wf.inCh));
}

// How many different colours the buffer actually contains. Reported next to
// every row because it is the number that says whether the CLUT was sampled at
// all: a 33^3 grid has 35,937 cells and a 17^4 grid has 83,521, so an input
// carrying fewer distinct colours than that leaves most of the table untouched
// and measures interpolation out of L1. This is not hypothetical — the noise
// generator used to emit 256 distinct colours (see genNoise).
function distinctColours(buf, npx, channels) {
    const seen = new Set();
    for (let p = 0; p < npx; p++) {
        const o = p * channels;
        seen.add(channels === 4
            ? (buf[o] * 16777216) + (buf[o + 1] << 16) + (buf[o + 2] << 8) + buf[o + 3]
            : (buf[o] << 16) | (buf[o + 1] << 8) | buf[o + 2]);
    }
    return seen.size;
}

// Grid cells in the baked CLUT, for the coverage line above each table.
function clutCells(wf) {
    const transform = makeJsTransform(wf, { dataFormat: 'int8', buildLut: true, lutMode: 'int' });
    const lut = transform.lut;
    if (!lut || !lut.gridPoints) return null;
    const grid = Array.isArray(lut.gridPoints) ? lut.gridPoints : [lut.gridPoints];
    return { grid, cells: grid.reduce((a, g) => a * g, 1) };
}

function runIsolated() {
    const { execFileSync } = require('child_process');
    const self = fileURLToPath(import.meta.url);

    for (const npx of SIZES) {
        console.log('\n' + '='.repeat(104));
        console.log(` ${(npx / 1024).toFixed(0)}K px per iteration — MPx/s, median of ${TIMED_BATCHES}, ONE PROCESS PER CELL`);
        console.log('='.repeat(104));

        for (let w = 0; w < WORKFLOWS.length; w++) {
            const shape = clutCells(WORKFLOWS[w]);
            console.log('\n ' + WORKFLOWS[w].name +
                (shape ? '   CLUT ' + shape.grid.join('x') + ' = ' + shape.cells.toLocaleString() + ' cells' : ''));
            console.log('   content    adj%    distinct   cover     jsCE int   jsCE simd   lcms-wasm   lcms-wasm NOCACHE   jsCE-simd/lcms');
            console.log('   --------  ------  ---------  ------    ---------  ----------  ----------  ------------------  --------------');

            for (const kind of contents) {
                const values = {};
                let adj = 0, distinct = 0;
                for (const engine of ['int', 'simd', 'lcms', 'lcmsnc']) {
                    const out = execFileSync(process.execPath,
                        [self, '--cell', `${w}|${kind}|${engine}|${npx}`], { encoding: 'utf8' });
                    const [value, cellAdj, cellDistinct] = out.trim().split(/\s+/).map(Number);
                    values[engine] = value;
                    adj = cellAdj; distinct = cellDistinct;
                }
                // cover < 1 means the input carries fewer colours than the CLUT
                // has cells, so most of the table is never touched
                const cover = shape ? distinct / shape.cells : 0;
                console.log('   ' + kind.padEnd(9) + adj.toFixed(1).padStart(6) + '  ' +
                    distinct.toLocaleString().padStart(9) + '  ' +
                    (cover >= 1 ? cover.toFixed(1) + 'x' : cover.toFixed(2) + 'x').padStart(6) + '    ' +
                    values.int.toFixed(1).padStart(9) + '  ' + values.simd.toFixed(1).padStart(10) + '  ' +
                    values.lcms.toFixed(1).padStart(10) + '  ' + values.lcmsnc.toFixed(1).padStart(18) + '  ' +
                    (values.simd / values.lcms).toFixed(2).padStart(13) + 'x');
            }
        }
    }
}

// ---- main table --------------------------------------------------------

function runMainTable() {
    for (const npx of SIZES) {
        console.log('\n' + '='.repeat(104));
        console.log(` ${(npx / 1024).toFixed(0)}K px per iteration — MPx/s, median of ${TIMED_BATCHES}`);
        console.log('='.repeat(104));

        for (const wf of WORKFLOWS) {
            console.log('\n ' + wf.name);
            console.log('   content    adj%     jsCE int   jsCE simd   lcms-wasm   lcms-wasm NOCACHE   jsCE-simd/lcms');
            console.log('   --------  ------   ---------  ----------  ----------  ------------------  --------------');

            for (const kind of contents) {
                // A FRESH TRANSFORM PER ROW, deliberately.
                //
                // Sharing one Transform across the content rows measured 59.5
                // MPx/s where an isolated run of the identical workflow, content
                // and buffer size measured 75.4 — a 27% swing caused by nothing
                // but which other rows the harness had already run through the
                // same call site. That is Schrodinger's Bench
                // (docs/deepdive/benchmark.md): a shared harness changes what it
                // measures. Rebuilding costs a LUT bake per row, entirely
                // outside the timed section, and buys rows that can be compared
                // to each other and to a standalone run.
                const jsInt  = makeJsTransform(wf, { dataFormat: 'int8', buildLut: true, lutMode: 'int' });
                const jsSimd = makeJsTransform(wf, { dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd' });

                const input = buildContent(kind, npx, wf.inCh);
                const adj   = adjacency(input, npx, wf.inCh);

                const msInt  = timeFn(() => { jsInt.transformArray(input, false, false, false, npx); });
                const msSimd = timeFn(() => { jsSimd.transformArray(input, false, false, false, npx); });
                const msLcms = timeLcms(wf, input, npx, 0);
                const msLcmsNc = timeLcms(wf, input, npx, cmsFLAGS_NOCACHE);

                const mInt = mpx(npx, msInt), mSimd = mpx(npx, msSimd);
                const mL = mpx(npx, msLcms),  mLn = mpx(npx, msLcmsNc);
                console.log('   ' + kind.padEnd(9) + adj.toFixed(1).padStart(6) + '   ' +
                    mInt.toFixed(1).padStart(9) + '  ' + mSimd.toFixed(1).padStart(10) + '  ' +
                    mL.toFixed(1).padStart(10) + '  ' + mLn.toFixed(1).padStart(18) + '  ' +
                    (mSimd / mL).toFixed(2).padStart(13) + 'x');

                jsInt.destroy?.(); jsSimd.destroy?.();
            }
        }
    }
}

// ---- pixel cache table -------------------------------------------------
//
// Accuracy path only (buildLut:false). Reported against its OWN uncached
// baseline, because the accuracy path is an order of magnitude slower than the
// LUT kernels and mixing the two in one table would invite the wrong ratio.

function runPixelCacheTable() {
    const npx = SIZES[0];
    console.log('\n' + '='.repeat(104));
    console.log(` Pixel cache (BETA) — accuracy path, buildLut:false, ${(npx / 1024).toFixed(0)}K px`);
    console.log('='.repeat(104));
    console.log(' Its own uncached baseline, NOT the LUT kernels above. hit% is a property');
    console.log(' of the content; the speed column is what that hit rate is worth here.\n');

    for (const wf of WORKFLOWS) {
        console.log(' ' + wf.name);
        console.log('   content    adj%    no cache   1 slot   32 slots   hit%(32)   32-slot gain');
        console.log('   --------  ------  ---------  -------  ---------  ---------  ------------');

        for (const kind of contents) {
            const input = buildContent(kind, npx, wf.inCh);
            const adj   = adjacency(input, npx, wf.inCh);
            const speeds = [];
            let hitPct = 0;

            for (const slots of [0, 1, 32]) {
                const transform = makeJsTransform(wf, { dataFormat: 'int8', buildLut: false, pixelCache: slots });
                const ms = timeFn(() => { transform.transformArray(input, false, false, false, npx); });
                speeds.push(mpx(npx, ms));
                if (slots === 32) {
                    // Cold cache, single pass. The timed loop above ran the same
                    // buffer many times over, which leaves the table fully warm —
                    // reading the hit rate from that would measure the benchmark
                    // repeating itself, not the image.
                    transform.clearPixelCache();
                    transform.resetPixelCacheStats();
                    transform.transformArray(input, false, false, false, npx);
                    hitPct = transform.getPixelCacheStats().hitRate * 100;
                }
            }
            console.log('   ' + kind.padEnd(9) + adj.toFixed(1).padStart(6) + '  ' +
                speeds[0].toFixed(2).padStart(9) + '  ' + speeds[1].toFixed(2).padStart(7) + '  ' +
                speeds[2].toFixed(2).padStart(9) + '  ' + hitPct.toFixed(1).padStart(8) + '%  ' +
                ((speeds[2] / speeds[0] - 1) * 100).toFixed(0).padStart(10) + '%');
        }
        console.log('');
    }
}

// ---- go ----------------------------------------------------------------

// A --cell child must print its measurement and nothing else — the parent
// parses stdout.
if (!CELL) {
    console.log('='.repeat(104));
    console.log(' jsColorEngine release matrix — jsCE vs lcms-wasm, content x engine x size');
    console.log('='.repeat(104));
    console.log(' node          : ' + process.version);
    console.log(' platform      : ' + process.platform + ' ' + process.arch);
    console.log(' lcms-wasm     : ' + require('lcms-wasm/package.json').version + ' (LittleCMS 2.16 -> wasm32)');
    console.log(' jsCE          : ' + require('../../package.json').version);
    console.log(' profiles      : GRACoL2006_Coated1v2.icc, AdobeRGB1998.icc, *sRGB, *LabD50');
    console.log(' intent        : relative colorimetric');
    if (havePhoto) {
        const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS_DIR, 'corpus.json'), 'utf8'));
        console.log(' photo corpus  : ' + manifest.images.length + ' images, ' +
            manifest.images.reduce((a, e) => a + e.pixels, 0).toLocaleString() + ' px, ' +
            'mean adjacency ' + manifest.meanAdjRgb + '% RGB / ' + manifest.meanAdjCmyk + '% CMYK');
    }
}

if (CELL) runCell(CELL);
else if (PIXEL_CACHE) runPixelCacheTable();
else if (ISOLATE) runIsolated();
else runMainTable();

lcms.cmsCloseProfile(lcmsGRACoL);
lcms.cmsCloseProfile(lcmsAdobe);
lcms.cmsCloseProfile(lcmsSRGB);
lcms.cmsCloseProfile(lcmsLab);
console.log('');
