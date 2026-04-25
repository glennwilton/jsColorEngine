/*
 * bench/int16_poc/bench_int16_simd_vs_scalar.js
 * =============================================
 *
 * v1.3 — direct comparison of the three u16 hot paths plus lcms-wasm:
 *
 *   1. jsCE int16              — JS u16 kernel (Q0.13)
 *   2. jsCE int16-wasm-scalar  — WASM scalar u16 kernel (Q0.13)
 *   3. jsCE int16-wasm-simd    — WASM SIMD u16 kernel  (Q0.13, NEW)
 *   4. lcms-wasm TYPE_*_16     — reference / sanity floor
 *
 * Every row uses the same Transform shape and the same input — only
 * `lutMode` changes. All three jsCE rows are bit-exact siblings (Q0.13
 * weights, scale-65535 u16 CLUT, two-rounding K-LERP for 4D), so we
 * read the speed delta as pure SIMD lift over scalar / scalar lift over
 * JS, with zero precision trade-off vs the slowest sibling.
 *
 * Workflows match bench_engine_int16.js (3D RGB→Lab/CMYK + 4D CMYK→Lab/CMYK)
 * so the numbers compose with the v1.3 scalar bench numbers in
 * docs/Performance.md.
 *
 * Run:  cd bench/int16_poc && npm install && npm run bench:simd
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

// ---- bench config ------------------------------------------------------
const PIXEL_COUNT   = 65536;
const TIMED_BATCHES = 5;
const BATCH_ITERS   = 100;
const WARMUP_ITERS  = 300;

// ---- helpers -----------------------------------------------------------

function buildInputU16(channels, seed = 0x13579bdf){
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

function maxAbsDiff(a, b){
    if(a.length !== b.length) throw new Error('length mismatch');
    let max = 0;
    for(let i = 0; i < a.length; i++){
        const d = Math.abs(a[i] - b[i]);
        if(d > max) max = d;
    }
    return max;
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
    },
    {
        name: 'RGB  -> CMYK   (sRGB -> GRACoL)',
        inCh: 3, outCh: 4,
        lcms: { pIn: lcmsSRGB,   fIn: TYPE_RGB_16,  pOut: lcmsGRACoL, fOut: TYPE_CMYK_16 },
        js:   { src: '*srgb',    dst: jsGRACoL },
    },
    {
        name: 'CMYK -> Lab    (GRACoL -> *labd50)',
        inCh: 4, outCh: 3,
        lcms: { pIn: lcmsGRACoL, fIn: TYPE_CMYK_16, pOut: lcmsLab,    fOut: TYPE_Lab_16  },
        js:   { src: jsGRACoL,   dst: '*labd50' },
    },
    {
        name: 'CMYK -> CMYK   (GRACoL -> GRACoL)',
        inCh: 4, outCh: 4,
        lcms: { pIn: lcmsGRACoL, fIn: TYPE_CMYK_16, pOut: lcmsGRACoL, fOut: TYPE_CMYK_16 },
        js:   { src: jsGRACoL,   dst: jsGRACoL },
    },
];

function makeJsTransform(wf, lutMode){
    const t = new Transform({ dataFormat: 'int16', buildLut: true, lutMode });
    t.create(wf.js.src, wf.js.dst, eIntent.relative);
    if(t.lutMode !== lutMode){
        throw new Error(wf.name + ': requested lutMode=' + lutMode + ', got=' + t.lutMode +
            ' — host capability check failed (no SIMD?)');
    }
    return t;
}

function runOne(wf){
    console.log('\n--------------------------------------------------------------');
    console.log(' ' + wf.name);
    console.log('--------------------------------------------------------------');

    const input = buildInputU16(wf.inCh);

    // 1. jsCE int16 — JS u16 kernel
    const tJs = makeJsTransform(wf, 'int16');
    const outJs = tJs.transformArray(input);
    const msJs  = timeIters(() => { tJs.transformArray(input); });

    // 2. jsCE int16-wasm-scalar
    const tScalar = makeJsTransform(wf, 'int16-wasm-scalar');
    const outScalar = tScalar.transformArray(input);
    const msScalar  = timeIters(() => { tScalar.transformArray(input); });

    // 3. jsCE int16-wasm-simd
    const tSimd = makeJsTransform(wf, 'int16-wasm-simd');
    const outSimd = tSimd.transformArray(input);
    const msSimd  = timeIters(() => { tSimd.transformArray(input); });

    // Bit-exactness gate — all three jsCE outputs MUST agree to the byte.
    const dJsScalar  = maxAbsDiff(outJs, outScalar);
    const dJsSimd    = maxAbsDiff(outJs, outSimd);
    const dScSimd    = maxAbsDiff(outScalar, outSimd);
    const bitExact   = (dJsScalar === 0 && dJsSimd === 0 && dScSimd === 0);

    // 4. lcms-wasm
    const inBytes  = PIXEL_COUNT * wf.inCh  * 2;
    const outBytes = PIXEL_COUNT * wf.outCh * 2;
    const inPtr  = lcms._malloc(inBytes);
    const outPtr = lcms._malloc(outBytes);
    new Uint16Array(lcms.HEAPU8.buffer, inPtr, PIXEL_COUNT * wf.inCh).set(input);

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
        lcms.cmsDeleteTransform(xf);
        return ms;
    }

    const msLcmsDefault = timeLcmsFlags(0);
    const msLcmsHighres = timeLcmsFlags(cmsFLAGS_HIGHRESPRECALC);

    lcms._free(inPtr);
    lcms._free(outPtr);

    // ---- Throughput report ----------------------------------------
    const mpxJs       = mpxPerSec(msJs);
    const mpxScalar   = mpxPerSec(msScalar);
    const mpxSimd     = mpxPerSec(msSimd);
    const mpxLcmsDef  = mpxPerSec(msLcmsDefault);
    const mpxLcmsHi   = mpxPerSec(msLcmsHighres);
    const mpxLcmsBest = Math.max(mpxLcmsDef, mpxLcmsHi);

    console.log('  jsCE int16              : ' + fmtMpx(mpxJs)      + '   (' + fmtMs(msJs)      + '/iter)   [JS u16]');
    console.log('  jsCE int16-wasm-scalar  : ' + fmtMpx(mpxScalar)  + '   (' + fmtMs(msScalar)  + '/iter)   [WASM scalar u16]');
    console.log('  jsCE int16-wasm-simd    : ' + fmtMpx(mpxSimd)    + '   (' + fmtMs(msSimd)    + '/iter)   [WASM SIMD u16]');
    console.log('  lcms-wasm flags=0       : ' + fmtMpx(mpxLcmsDef) + '   (' + fmtMs(msLcmsDefault) + '/iter)');
    console.log('  lcms-wasm HIGHRESPRECALC: ' + fmtMpx(mpxLcmsHi)  + '   (' + fmtMs(msLcmsHighres) + '/iter)');
    console.log('');
    console.log('  SIMD vs scalar          : ' + (mpxSimd / mpxScalar).toFixed(2) + '×');
    console.log('  SIMD vs JS u16          : ' + (mpxSimd / mpxJs).toFixed(2) + '×');
    console.log('  SIMD vs lcms best       : ' + (mpxSimd / mpxLcmsBest).toFixed(2) + '×');
    console.log('  scalar vs JS u16        : ' + (mpxScalar / mpxJs).toFixed(2) + '×');
    console.log('');
    console.log('  BIT-EXACTNESS:  JS ↔ scalar: ' + (dJsScalar === 0 ? '✓ 0 LSB' : '✗ ' + dJsScalar + ' LSB') +
                '   |   JS ↔ SIMD: ' + (dJsSimd === 0 ? '✓ 0 LSB' : '✗ ' + dJsSimd + ' LSB') +
                '   |   scalar ↔ SIMD: ' + (dScSimd === 0 ? '✓ 0 LSB' : '✗ ' + dScSimd + ' LSB'));
    if(!bitExact){
        throw new Error(wf.name + ': bit-exactness FAIL — see deltas above');
    }

    return {
        wf: wf.name,
        mpxJs, mpxScalar, mpxSimd, mpxLcmsBest,
    };
}

console.log('==============================================================');
console.log(' int16 SIMD — JS u16 vs WASM scalar vs WASM SIMD vs lcms-wasm');
console.log('==============================================================');
console.log(' Pixel count   : ' + PIXEL_COUNT.toLocaleString());
console.log(' Warmup iters  : ' + WARMUP_ITERS);
console.log(' Timed batches : ' + TIMED_BATCHES + ' x ' + BATCH_ITERS + ' iters');
console.log(' Profile       : GRACoL2006_Coated1v2.icc');
console.log(' Intent        : Relative colorimetric');

const results = [];
for(const wf of WORKFLOWS){
    results.push(runOne(wf));
}

console.log('\n==============================================================');
console.log(' SUMMARY (MPx/s)');
console.log('==============================================================');
console.log(' Workflow                                jsJS    jsScalar   jsSIMD    lcms    SIMD/scalar  SIMD/JS  SIMD/lcms');
for(const r of results){
    const name = r.wf.padEnd(36);
    console.log(' ' + name + ' ' +
        r.mpxJs.toFixed(1).padStart(6)        + '   ' +
        r.mpxScalar.toFixed(1).padStart(7)    + '   ' +
        r.mpxSimd.toFixed(1).padStart(6)      + '   ' +
        r.mpxLcmsBest.toFixed(1).padStart(6)  + '   ' +
        (r.mpxSimd / r.mpxScalar).toFixed(2).padStart(8) + '×   ' +
        (r.mpxSimd / r.mpxJs).toFixed(2).padStart(5)     + '×   ' +
        (r.mpxSimd / r.mpxLcmsBest).toFixed(2).padStart(5) + '×');
}
console.log('');
