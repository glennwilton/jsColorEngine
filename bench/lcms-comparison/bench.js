/*
 * bench/lcms-comparison/bench.js
 * ==============================
 *
 * Direct, same-machine, same-input MPx/s comparison between:
 *
 *   1. jsColorEngine  lutMode = 'float'   (f64 CLUT, tetrahedral)
 *   2. jsColorEngine  lutMode = 'int'     (u16 CLUT, Q0.16, int32-specialised)
 *   3. lcms-wasm      (flags = 0, default)          — pinned heap buffers
 *   4. lcms-wasm      (cmsFLAGS_HIGHRESPRECALC)     — pinned heap buffers
 *
 * All lcms-wasm variants use pinned WASM heap buffers (pre-_malloc'd once
 * and reused between calls) — the fair, production-realistic path.
 *
 *   - flags = 0              : lcms2 auto-decides whether to build a
 *                              device-link precalc LUT (its default
 *                              behaviour — typically yes for multi-
 *                              stage pipelines, maybe not for pure
 *                              matrix-shaper chains).
 *   - HIGHRESPRECALC (0x0400): forces a large-grid precalc LUT for
 *                              every transform — matches jsColorEngine's
 *                              "pre-baked LUT" design exactly.
 *
 * Same on both sides:
 *   - profile (GRACoL2006_Coated1v2.icc), same sRGB virtual, same LabD50
 *   - 65536 pixels (256x256) per iter
 *   - INTENT_RELATIVE_COLORIMETRIC
 *   - TYPE_*_8 everywhere (matches jsColorEngine dataFormat:'int8')
 *   - seeded PRNG input (identical bytes)
 *   - same warmup + median-of-5 batches, same batch size
 *
 * Run:  cd bench/lcms-comparison && node bench.js
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
    instantiate,
    TYPE_RGB_8,
    TYPE_CMYK_8,
    TYPE_Lab_8,
    INTENT_RELATIVE_COLORIMETRIC,
    cmsFLAGS_HIGHRESPRECALC,
    cmsFLAGS_LOWRESPRECALC,
} from 'lcms-wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require    = createRequire(import.meta.url);

// jsColorEngine is CommonJS — pull it in via createRequire
const { Transform, eIntent } = require('../../src/main');
const Profile                = require('../../src/Profile');

const GRACOL_PATH = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

// ---- configuration (mirrors bench/mpx_summary.js) -----------------------

const PIXEL_COUNT       = 65536;
const TIMED_BATCHES     = 5;
const BATCH_ITERS       = 100;   // ~1-2s per batch at 40-200 Mpx/s
const WARMUP_ITERS      = 300;   // ~3-5s warmup (TurboFan tier-up)


// ---- helpers ------------------------------------------------------------

function buildInput(channels){
    // Same PRNG as bench/mpx_summary.js — identical bytes both sides
    const arr = new Uint8ClampedArray(PIXEL_COUNT * channels);
    let seed = 0x13579bdf;
    for(let i = 0; i < arr.length; i++){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        arr[i] = seed & 0xff;
    }
    return arr;
}

function timeIters(fn){
    for(let w = 0; w < WARMUP_ITERS; w++){ fn(); }
    const samples = [];
    for(let r = 0; r < TIMED_BATCHES; r++){
        const t0 = process.hrtime.bigint();
        for(let i = 0; i < BATCH_ITERS; i++){ fn(); }
        const t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6 / BATCH_ITERS);
    }
    samples.sort((a,b) => a - b);
    return samples[(TIMED_BATCHES / 2) | 0];
}

function mpxPerSec(msPerIter){
    return (PIXEL_COUNT / 1e6) / (msPerIter / 1000);
}

function fmtMpx(mpx){ return mpx.toFixed(1).padStart(6) + ' MPx/s'; }


// ---- main ---------------------------------------------------------------

const lcms = await instantiate();

// --- Load profiles for lcms-wasm --------------------------------------

const gracolBytes = await readFile(GRACOL_PATH);
const lcmsGRACoL  = lcms.cmsOpenProfileFromMem(new Uint8Array(gracolBytes), gracolBytes.byteLength);
const lcmsSRGB    = lcms.cmsCreate_sRGBProfile();
const lcmsLab     = lcms.cmsCreateLab4Profile(null);     // D50 by default
if(!lcmsGRACoL || !lcmsSRGB || !lcmsLab){
    throw new Error('lcms-wasm: failed to open one of the profiles');
}

// --- Load profiles for jsColorEngine ----------------------------------

const jsGRACoL = new Profile();
await jsGRACoL.loadPromise('file:' + GRACOL_PATH);
if(!jsGRACoL.loaded) throw new Error('jsColorEngine: failed to load GRACoL');


// --- Workflow definitions --------------------------------------------
//
// For each workflow we set:
//   lcmsIn / lcmsOut : lcms-wasm profile handles + format flags
//   jsIn  / jsOut    : jsColorEngine profile / '*srgb' / '*labd50'
//   inCh  / outCh    : channel counts (for sizing + PRNG)

const WORKFLOWS = [
    {
        name: 'RGB -> Lab    (sRGB -> LabD50)',
        inCh: 3, outCh: 3,
        lcms: { pIn: lcmsSRGB,   fIn: TYPE_RGB_8,  pOut: lcmsLab,     fOut: TYPE_Lab_8  },
        js:   { src: '*srgb',    dst: '*labd50' },
    },
    {
        name: 'RGB -> CMYK   (sRGB -> GRACoL)',
        inCh: 3, outCh: 4,
        lcms: { pIn: lcmsSRGB,   fIn: TYPE_RGB_8,  pOut: lcmsGRACoL,  fOut: TYPE_CMYK_8 },
        js:   { src: '*srgb',    dst: jsGRACoL },
    },
    {
        name: 'CMYK -> RGB   (GRACoL -> sRGB)',
        inCh: 4, outCh: 3,
        lcms: { pIn: lcmsGRACoL, fIn: TYPE_CMYK_8, pOut: lcmsSRGB,    fOut: TYPE_RGB_8  },
        js:   { src: jsGRACoL,   dst: '*srgb' },
    },
    {
        name: 'CMYK -> CMYK  (GRACoL -> GRACoL)',
        inCh: 4, outCh: 4,
        lcms: { pIn: lcmsGRACoL, fIn: TYPE_CMYK_8, pOut: lcmsGRACoL,  fOut: TYPE_CMYK_8 },
        js:   { src: jsGRACoL,   dst: jsGRACoL },
    },
];

// ---- run one workflow -----------------------------------------------

function runOne(wf){
    console.log('\n--------------------------------------------------------------');
    console.log(' ' + wf.name);
    console.log('--------------------------------------------------------------');

    const input = buildInput(wf.inCh);

    // ---- 1 & 2: jsColorEngine (float + int) -------------------------

    const jsFloat = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
    jsFloat.create(wf.js.src, wf.js.dst, eIntent.relative);
    const msJsFloat = timeIters(() => { jsFloat.transformArray(input); });

    const jsInt = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    jsInt.create(wf.js.src, wf.js.dst, eIntent.relative);
    const msJsInt = timeIters(() => { jsInt.transformArray(input); });

    // ---- 3 & 4: lcms-wasm with pinned WASM heap buffers -------------
    //
    // Pre-_malloc input / output buffers once, then call
    // _cmsDoTransform directly. This is what an optimised production
    // app would do (allocate per-frame buffers up front). We measure
    // two flag variants — same profile handles, same pinned memory,
    // only the transform recipe changes:

    const inBytes  = PIXEL_COUNT * wf.inCh;
    const outBytes = PIXEL_COUNT * wf.outCh;
    const inPtr  = lcms._malloc(inBytes);
    const outPtr = lcms._malloc(outBytes);
    lcms.HEAPU8.set(input, inPtr);

    function timeLcmsFlags(flags){
        const xf = lcms.cmsCreateTransform(
            wf.lcms.pIn,  wf.lcms.fIn,
            wf.lcms.pOut, wf.lcms.fOut,
            INTENT_RELATIVE_COLORIMETRIC, flags
        );
        if(!xf) throw new Error('lcms-wasm: cmsCreateTransform failed (flags=0x' + flags.toString(16) + ')');
        const ms = timeIters(() => {
            lcms._cmsDoTransform(xf, inPtr, outPtr, PIXEL_COUNT);
        });
        // grab result for diff-checking before we delete the xf
        const out = new Uint8Array(lcms.HEAPU8.buffer, outPtr, outBytes).slice();
        lcms.cmsDeleteTransform(xf);
        return { ms, out };
    }

    const lcmsDefault  = timeLcmsFlags(0);
    const lcmsHighres  = timeLcmsFlags(cmsFLAGS_HIGHRESPRECALC);

    // Sanity: default vs highres should agree to within a few LSBs
    // (they're both building precalc LUTs, just at different grid
    // sizes). Report worst diff in first 1024 output bytes.
    let maxDiff = 0;
    for(let i = 0; i < Math.min(1024, outBytes); i++){
        const d = Math.abs(lcmsDefault.out[i] - lcmsHighres.out[i]);
        if(d > maxDiff) maxDiff = d;
    }

    lcms._free(inPtr);
    lcms._free(outPtr);

    // ---- report -----------------------------------------------------

    const mpxJsFloat      = mpxPerSec(msJsFloat);
    const mpxJsInt        = mpxPerSec(msJsInt);
    const mpxLcmsDefault  = mpxPerSec(lcmsDefault.ms);
    const mpxLcmsHighres  = mpxPerSec(lcmsHighres.ms);

    console.log('  jsColorEngine float          : ' + fmtMpx(mpxJsFloat)     + '   (' + msJsFloat.toFixed(2)      + ' ms/iter)');
    console.log('  jsColorEngine int            : ' + fmtMpx(mpxJsInt)       + '   (' + msJsInt.toFixed(2)        + ' ms/iter)');
    console.log('  lcms-wasm  flags = 0         : ' + fmtMpx(mpxLcmsDefault) + '   (' + lcmsDefault.ms.toFixed(2) + ' ms/iter)');
    console.log('  lcms-wasm  HIGHRESPRECALC    : ' + fmtMpx(mpxLcmsHighres) + '   (' + lcmsHighres.ms.toFixed(2) + ' ms/iter)   (default vs highres max diff: ' + maxDiff + ' LSB)');
    // Use the faster of the two lcms variants as the comparison baseline.
    const mpxLcmsBest = Math.max(mpxLcmsDefault, mpxLcmsHighres);
    const bestLabel   = mpxLcmsDefault >= mpxLcmsHighres ? 'flags=0' : 'HIGHRES';
    console.log('  ratios (best lcms = ' + bestLabel + '):');
    console.log('    js float   vs lcms-best : ' + (mpxJsFloat / mpxLcmsBest).toFixed(2) + 'x');
    console.log('    js int     vs lcms-best : ' + (mpxJsInt   / mpxLcmsBest).toFixed(2) + 'x');

    return { name: wf.name, mpxJsFloat, mpxJsInt, mpxLcmsDefault, mpxLcmsHighres };
}

// ---- main -------------------------------------------------------------

console.log('==============================================================');
console.log(' jsColorEngine vs lcms-wasm — MPx/s comparison');
console.log('==============================================================');
console.log(' pixels per iter  : ' + PIXEL_COUNT);
console.log(' batches x iters  : ' + TIMED_BATCHES + ' x ' + BATCH_ITERS);
console.log(' warmup           : ' + WARMUP_ITERS + ' iters');
console.log(' profile          : GRACoL2006_Coated1v2.icc');
console.log(' node             : ' + process.version);
console.log(' platform         : ' + process.platform + ' ' + process.arch);
console.log(' lcms-wasm        : 1.0.5 (LCMS ' + /* LCMS_VERSION */ '2.16' + ' compiled to wasm32)');

const results = [];
for(const wf of WORKFLOWS){
    results.push(runOne(wf));
}

// ---- summary table ---------------------------------------------------

console.log('\n==============================================================');
console.log(' SUMMARY — Mpx/s (higher is better)');
console.log('==============================================================');
console.log('  workflow                       js-float  js-int    lcms-def  lcms-hi ');
console.log('  -----------------------------  --------  --------  --------  --------');
for(const r of results){
    const line = '  ' + r.name.padEnd(31) +
                 '  ' + r.mpxJsFloat.toFixed(1).padStart(6)     + ' M' +
                 '  ' + r.mpxJsInt.toFixed(1).padStart(6)       + ' M' +
                 '  ' + r.mpxLcmsDefault.toFixed(1).padStart(6) + ' M' +
                 '  ' + r.mpxLcmsHighres.toFixed(1).padStart(6) + ' M';
    console.log(line);
}

// ---- markdown (copy-paste into CHANGELOG / README) -------------------

console.log('\nMarkdown:');
console.log('| Workflow | jsColorEngine `float` | jsColorEngine `int` | lcms-wasm default | lcms-wasm HIGHRESPRECALC |');
console.log('|---|---|---|---|---|');
for(const r of results){
    const label = r.name.replace(/\s+/g, ' ').trim();
    console.log('| ' + label +
                ' | ' + r.mpxJsFloat.toFixed(1)     + ' Mpx/s' +
                ' | ' + r.mpxJsInt.toFixed(1)       + ' Mpx/s' +
                ' | ' + r.mpxLcmsDefault.toFixed(1) + ' Mpx/s' +
                ' | ' + r.mpxLcmsHighres.toFixed(1) + ' Mpx/s |');
}
console.log('');

// clean up
lcms.cmsCloseProfile(lcmsGRACoL);
lcms.cmsCloseProfile(lcmsSRGB);
lcms.cmsCloseProfile(lcmsLab);
