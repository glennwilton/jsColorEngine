/*
 * bench/int16_poc/bench_engine_int16.js
 * =====================================
 *
 * v1.3 — integrated 16-bit hot path validation.
 *
 * What this measures
 * ------------------
 * Same shape as bench_int16_vs_lcmswasm.js (the standalone POC), but
 * exercises the kernel via the FULL `Transform` class — i.e. the
 * production code path:
 *
 *   new Transform({ dataFormat: 'int16', buildLut: true })
 *     .create(src, dst, intent)
 *     .transformArray(uint16Pixels)
 *
 * Auto-resolves to `lutMode: 'int16'` and routes through
 * `transformArrayViaLUT()` → the new `tetrahedralInterp{3,4}DArray_{3,4}Ch_intLut16_loop`
 * methods. Output is `Uint16Array`.
 *
 * Workflows
 * ---------
 *   1. RGB→Lab    (sRGB → *labd50)  — validates u16 Lab encoding
 *      against ICC v4 PCSLab via lcms TYPE_Lab_16 (lcms's canonical
 *      v4 16-bit Lab encoding: L:[0..0xFFFF]→[0..100],
 *      a/b:[0..0xFFFF]→[-128..+128]).
 *   2. RGB→CMYK   (sRGB → GRACoL)
 *   3. CMYK→Lab   (GRACoL → *labd50)  — validates 4D INPUT u16 path
 *      AND the v2/v4 PCSLab 16-bit encoding contract end-to-end.
 *      jsCE pipeline output → lcms TYPE_Lab_16 reference.
 *   4. CMYK→CMYK  (GRACoL → GRACoL)
 *
 * Channel ordering
 * ----------------
 *   - jsCE 4D LUT input AND output are **profile-native** order, i.e.
 *     **C, M, Y, K** for a CMYK profile (per ICC convention: first
 *     colorant varies slowest = outermost CLUT axis = first input
 *     byte). Verified by single-pixel probes:
 *         [255,0,0,0] → cyan,    [0,255,0,0] → magenta,
 *         [0,0,255,0] → yellow,  [0,0,0,255] → black.
 *   - lcms TYPE_CMYK_* is also **C, M, Y, K** for both directions.
 *
 * Net: no reorder needed in either direction. NOTE the variable
 * named `inputK` inside the 4D `*_intLut*_loop` kernels (and the
 * "Input byte order: inputK, input0 (C)..." comment in
 * src/wasm/tetra4d_nch.wat) refer to the K=outer-AXIS dimension,
 * not the K=black ink colorant — the wat comment is misleading and
 * should be cleaned up separately.
 *
 * Run:  cd bench/int16_poc && npm install && npm run bench:engine
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
    instantiate,
    TYPE_RGB_16,
    TYPE_CMYK_16,
    TYPE_Lab_16,
    INTENT_RELATIVE_COLORIMETRIC,
    cmsFLAGS_HIGHRESPRECALC,
} from 'lcms-wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

const { Transform, eIntent } = require('../../src/main');
const Profile                = require('../../src/Profile');

const GRACOL_PATH = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

// ---- bench config -----------------------------------------------------
const PIXEL_COUNT   = 65536;
const TIMED_BATCHES = 5;
const BATCH_ITERS   = 100;
const WARMUP_ITERS  = 300;

// ---- helpers ----------------------------------------------------------

function buildInputU16(channels, seed = 0x13579bdf){
    // Same PRNG shape as the standalone POC, but lifted directly to u16
    // so we cover the full [0, 65535] range (not just u8-expanded values).
    const arr = new Uint16Array(PIXEL_COUNT * channels);
    let s = seed;
    for(let i = 0; i < arr.length; i++){
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        arr[i] = s & 0xffff;
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
    samples.sort((a, b) => a - b);
    return samples[(TIMED_BATCHES / 2) | 0];
}

const mpxPerSec = ms => (PIXEL_COUNT / 1e6) / (ms / 1000);
const fmtMpx    = mpx => mpx.toFixed(1).padStart(6) + ' MPx/s';
const fmtMs     = ms  => ms.toFixed(2).padStart(5) + ' ms';

// =======================================================================
//  Setup
// =======================================================================

const lcms = await instantiate();

const gracolBytes = await readFile(GRACOL_PATH);
const lcmsGRACoL  = lcms.cmsOpenProfileFromMem(new Uint8Array(gracolBytes), gracolBytes.byteLength);
const lcmsSRGB    = lcms.cmsCreate_sRGBProfile();
const lcmsLab     = lcms.cmsCreateLab4Profile(null);
if(!lcmsGRACoL || !lcmsSRGB || !lcmsLab){
    throw new Error('lcms-wasm: failed to open one of the profiles');
}

const jsGRACoL = new Profile();
await jsGRACoL.loadPromise('file:' + GRACOL_PATH);
if(!jsGRACoL.loaded) throw new Error('jsColorEngine: failed to load GRACoL');

const WORKFLOWS = [
    {
        name: 'RGB  -> Lab    (sRGB -> *labd50)',
        inCh: 3, outCh: 3,
        lcms: { pIn: lcmsSRGB,   fIn: TYPE_RGB_16,  pOut: lcmsLab,    fOut: TYPE_Lab_16  },
        js:   { src: '*srgb',    dst: '*labd50' },
        cmykIn: false,
    },
    {
        name: 'RGB  -> CMYK   (sRGB -> GRACoL)',
        inCh: 3, outCh: 4,
        lcms: { pIn: lcmsSRGB,   fIn: TYPE_RGB_16,  pOut: lcmsGRACoL, fOut: TYPE_CMYK_16 },
        js:   { src: '*srgb',    dst: jsGRACoL },
        cmykIn: false,
    },
    {
        name: 'CMYK -> Lab    (GRACoL -> *labd50)',
        inCh: 4, outCh: 3,
        lcms: { pIn: lcmsGRACoL, fIn: TYPE_CMYK_16, pOut: lcmsLab,    fOut: TYPE_Lab_16  },
        js:   { src: jsGRACoL,   dst: '*labd50' },
        cmykIn: true,
    },
    {
        name: 'CMYK -> CMYK   (GRACoL -> GRACoL)',
        inCh: 4, outCh: 4,
        lcms: { pIn: lcmsGRACoL, fIn: TYPE_CMYK_16, pOut: lcmsGRACoL, fOut: TYPE_CMYK_16 },
        js:   { src: jsGRACoL,   dst: jsGRACoL },
        cmykIn: true,
    },
];

function runOne(wf){
    console.log('\n--------------------------------------------------------------');
    console.log(' ' + wf.name);
    console.log('--------------------------------------------------------------');

    // 1. Build one shared u16 input (CMYK / RGB, profile-native order).
    //    Both jsCE and lcms read it the same way.
    const inputLcms = buildInputU16(wf.inCh);
    const inputJs   = inputLcms;

    // 2. jsCE int16 (auto -> lutMode in {int16, int16-wasm-scalar}) -------
    // dataFormat:'int16' + buildLut:true is enough — the auto-resolver
    // upgrades to int16-wasm-scalar when the WASM kernel is available
    // and falls back through the table to the JS u16 kernel otherwise.
    // We accept any of the int16-family modes here; the kernel actually
    // invoked is whichever one survived the resolveLutKernel chain walk.
    // (v1.3: this bench was originally written before the WASM int16
    //  kernels landed; it keeps the explicit-construction path so we
    //  can still measure the JS-only Q0.13 sibling against lcms-wasm.)
    const tInt16 = new Transform({ dataFormat: 'int16', buildLut: true });
    tInt16.create(wf.js.src, wf.js.dst, eIntent.relative);

    if(!tInt16.lutMode || !tInt16.lutMode.startsWith('int16')){
        throw new Error('Expected lutMode to start with "int16" after auto resolution, got "' + tInt16.lutMode + '"');
    }

    let outJs = tInt16.transformArray(inputJs);
    if(!(outJs instanceof Uint16Array)){
        throw new Error('Expected Uint16Array output from int16 path, got ' + outJs.constructor.name);
    }
    const msJsInt16 = timeIters(() => { tInt16.transformArray(inputJs); });

    // 3. jsCE int8 baseline (same workflow, u8 I/O) — speed reference
    const inputJsU8  = new Uint8ClampedArray(inputJs.length);
    for(let i = 0; i < inputJs.length; i++){ inputJsU8[i] = inputJs[i] >>> 8; }
    const tInt8 = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int' });
    tInt8.create(wf.js.src, wf.js.dst, eIntent.relative);
    const msJsInt8 = timeIters(() => { tInt8.transformArray(inputJsU8); });

    // 4. lcms-wasm TYPE_*_16 — pinned heap ----------------------------
    const inBytes  = PIXEL_COUNT * wf.inCh  * 2;
    const outBytes = PIXEL_COUNT * wf.outCh * 2;
    const inPtr  = lcms._malloc(inBytes);
    const outPtr = lcms._malloc(outBytes);
    new Uint16Array(lcms.HEAPU8.buffer, inPtr, PIXEL_COUNT * wf.inCh).set(inputLcms);

    function timeLcmsFlags(flags){
        const xf = lcms.cmsCreateTransform(
            wf.lcms.pIn,  wf.lcms.fIn,
            wf.lcms.pOut, wf.lcms.fOut,
            INTENT_RELATIVE_COLORIMETRIC, flags
        );
        if(!xf) throw new Error('lcms-wasm: cmsCreateTransform failed');
        const ms = timeIters(() => {
            lcms._cmsDoTransform(xf, inPtr, outPtr, PIXEL_COUNT);
        });
        const out = new Uint16Array(lcms.HEAPU8.buffer, outPtr, PIXEL_COUNT * wf.outCh).slice();
        lcms.cmsDeleteTransform(xf);
        return { ms, out };
    }

    const lcmsDefault = timeLcmsFlags(0);
    const lcmsHighres = timeLcmsFlags(cmsFLAGS_HIGHRESPRECALC);

    lcms._free(inPtr);
    lcms._free(outPtr);

    // 5. Accuracy diff (jsCE int16 vs lcms HIGHRESPRECALC u16) -------
    // No output reorder needed: jsCE writes profile-native CMYK (C,M,Y,K)
    // which matches lcms TYPE_CMYK_16. KCMY is an *input*-only convention.
    const ref = lcmsHighres.out;
    const got = outJs;
    let maxAbs = 0, sumAbs = 0;
    let cnt0 = 0, cnt1 = 0, cnt8 = 0, cnt64 = 0, cnt256 = 0;
    let maxIdx = -1;
    for(let i = 0; i < ref.length; i++){
        const d = Math.abs(got[i] - ref[i]);
        if(d > maxAbs){ maxAbs = d; maxIdx = i; }
        sumAbs += d;
        if(d === 0) cnt0++;
        if(d <= 1) cnt1++;
        if(d <= 8) cnt8++;
        if(d <= 64) cnt64++;
        if(d <= 256) cnt256++;
    }
    const meanAbs = sumAbs / ref.length;
    const total = ref.length;
    const pct = n => ((n / total) * 100).toFixed(2);

    // 6. Throughput report -------------------------------------------
    const mpxJsInt16     = mpxPerSec(msJsInt16);
    const mpxJsInt8      = mpxPerSec(msJsInt8);
    const mpxLcmsDefault = mpxPerSec(lcmsDefault.ms);
    const mpxLcmsHighres = mpxPerSec(lcmsHighres.ms);
    const mpxLcmsBest    = Math.max(mpxLcmsDefault, mpxLcmsHighres);

    console.log('  jsCE int8  (u8 in/out)        : ' + fmtMpx(mpxJsInt8)      + '   (' + fmtMs(msJsInt8)      + '/iter)   [reference]');
    console.log('  jsCE int16 (u16 in/out, ' + tInt16.lutMode.padEnd(7) + '): ' + fmtMpx(mpxJsInt16)     + '   (' + fmtMs(msJsInt16)     + '/iter)   [v1.3 Q0.13]');
    console.log('  lcms-wasm  flags=0   (u16)    : ' + fmtMpx(mpxLcmsDefault) + '   (' + fmtMs(lcmsDefault.ms)+ '/iter)');
    console.log('  lcms-wasm  HIGHRESPRECALC     : ' + fmtMpx(mpxLcmsHighres) + '   (' + fmtMs(lcmsHighres.ms)+ '/iter)');
    console.log('');
    console.log('  jsCE int16 vs lcms-wasm best  : ' + (mpxJsInt16 / mpxLcmsBest).toFixed(2) + '×');
    console.log('  jsCE int16 vs jsCE int8 (u8)  : ' + (mpxJsInt16 / mpxJsInt8).toFixed(2) + '×');
    console.log('');
    console.log('  ACCURACY (jsCE int16 vs lcms HIGHRESPRECALC u16, ' + total.toLocaleString() + ' samples):');
    console.log('    max |Δ|            : ' + maxAbs + ' LSB at u16  (= ' + (maxAbs / 256).toFixed(3) + ' LSB at u8 equivalent)');
    console.log('    mean |Δ|           : ' + meanAbs.toFixed(3) + ' LSB at u16');
    console.log('    Δ = 0              : ' + pct(cnt0)   + ' %');
    console.log('    Δ ≤ 1              : ' + pct(cnt1)   + ' %');
    console.log('    Δ ≤ 8              : ' + pct(cnt8)   + ' %');
    console.log('    Δ ≤ 64  (0.25 LSB u8): ' + pct(cnt64) + ' %');
    console.log('    Δ ≤ 256 (1.0 LSB u8) : ' + pct(cnt256)+ ' %');

    return { wf: wf.name, mpxJsInt8, mpxJsInt16, mpxLcmsDefault, mpxLcmsHighres, maxAbs, meanAbs };
}

console.log('==============================================================');
console.log(' int16 INTEGRATED — Transform.dataFormat=int16 vs lcms-wasm');
console.log('==============================================================');
console.log(' Pixel count   : ' + PIXEL_COUNT.toLocaleString() + ' (' + Math.sqrt(PIXEL_COUNT) + 'x' + Math.sqrt(PIXEL_COUNT) + ')');
console.log(' Warmup iters  : ' + WARMUP_ITERS);
console.log(' Timed batches : ' + TIMED_BATCHES + ' x ' + BATCH_ITERS + ' iters');
console.log(' Profile       : GRACoL2006_Coated1v2.icc');
console.log(' Intent        : Relative colorimetric');

const results = [];
for(const wf of WORKFLOWS){
    results.push(runOne(wf));
}

console.log('\n==============================================================');
console.log(' SUMMARY');
console.log('==============================================================');
console.log(' Workflow                              jsInt8   jsInt16  lcms16   int16/lcms   max|Δ|u16');
for(const r of results){
    const name = r.wf.padEnd(36);
    const lcmsBest = Math.max(r.mpxLcmsDefault, r.mpxLcmsHighres);
    console.log(' ' + name + ' ' +
        r.mpxJsInt8.toFixed(1).padStart(6)   + '   ' +
        r.mpxJsInt16.toFixed(1).padStart(6)  + '   ' +
        lcmsBest.toFixed(1).padStart(6)      + '   ' +
        (r.mpxJsInt16 / lcmsBest).toFixed(2).padStart(5) + '×    ' +
        r.maxAbs.toString().padStart(5) + '  (' + (r.maxAbs / 256).toFixed(2) + ' LSB u8)');
}
console.log('');
