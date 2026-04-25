/*
 * bench/int16_poc/accuracy_v1_6_vs_lcms.js
 * ========================================
 *
 * v1.3 ACCURACY GATE — u16 in/out, jsColorEngine vs lcms-wasm.
 * (Filename retains the development-iteration prefix as a dev artifact.)
 *
 * The v1.3 int16 kernels use fractional weights on a scale-65535 CLUT
 * (vs an unshipped prototype's u8 weights on a scale-65280 CLUT — see
 * bench/int16_identity.js for the proof of that prototype's banding).
 *
 * v1.3 settled at Q0.13 weights after a brief internal Q0.12 iteration
 * during development. Q0.13 means we keep 13 bits of input fraction per
 * cell, dropping the bottom 3 bits of the u16 input. Picked because
 * that's the i32 ceiling with a u16 CLUT compatible with JS Math.imul
 * AND WASM i32.mul (both must agree for bit-exact JS↔WASM): delta×rx
 * max = 65535×8191 ≈ 2^29.0, sum of 3 axes ≈ 2^30.6 — fits i32 with
 * ~1.4 bits headroom. u14/u15 weights overflow on adversarial CLUTs
 * and would break JS↔WASM bit-exactness.
 *
 * THIS BENCH ANSWERS: do those dropped 3 bits actually matter in
 * practice, against a true u16 reference (lcms with HIGHRESPRECALC)?
 *
 * Method:
 *   1. Build a dense systematic grid of u16 input pixels for each
 *      workflow (RGB→Lab, RGB→CMYK, CMYK→RGB, CMYK→CMYK).
 *   2. Transform with jsCE v1.3 (lutMode='int16', dataFormat='int16').
 *   3. Transform the SAME bytes with lcms-wasm TYPE_*_16 +
 *      cmsFLAGS_HIGHRESPRECALC (the most accurate lcms u16 path).
 *   4. Diff the two u16 outputs and report distribution at:
 *        Δ = 0           (exact match)
 *        Δ ≤ 1   LSB     (kernel rounding floor)
 *        Δ ≤ 8   LSB     (the u13 weight cap — within 3 LSB at u16,
 *                          undetectable in any 8/10/12-bit display path)
 *        Δ ≤ 64  LSB     (within 0.25 LSB at u8 — invisible on any
 *                          standard monitor)
 *        Δ ≤ 256 LSB     (within 1 LSB at u8 — bit-equivalent to u8 path)
 *
 *   The threshold to BEAT is 256 LSB: if v1.3 stays inside ≤256 for
 *   ~all pixels, we're already as accurate as the existing u8 path;
 *   if it stays inside ≤8 for most pixels, the dropped 3 bits of
 *   u13 weight are below the precision floor of any practical u16
 *   consumer (most workflows quantize back to u8/u10/u12 anyway).
 *
 *   Notes on what "exact match" against lcms means here:
 *   lcms-wasm builds its own internal precalc grid from a different
 *   formula (more samples, different rounding, different gamut-clip
 *   conventions) so even FLOAT-exact engines disagree with lcms at
 *   ~1-LSB level on most pixels — see bench/lcms-comparison/accuracy.js
 *   for the u8 baseline (jsCE float vs lcms shows ~95-99% within 1 LSB,
 *   not 100%). Δ=0 against lcms-wasm is therefore an *aspirational*
 *   bucket; the actionable thresholds are ≤16 (precision floor) and
 *   ≤256 (u8 equivalence).
 *
 * ⚠ THIS BENCH IS NOT A TRUE PRECISION REFERENCE for the v1.3 kernel.
 *   The base float LUTs jsColorEngine and lcms build from the same ICC
 *   source profile differ (different curve sampling, different gamut-
 *   clip conventions, different 2D inversion grid for B2A) — the worst-
 *   case deltas reported here (max 4667 LSB on CMYK→RGB) are gamut-clip
 *   disagreements, NOT v1.3 kernel quantization noise. Use this bench
 *   for "are we in the same league as a known-good engine?" only.
 *   For a true v1.3 kernel-precision test, run accuracy_v1_7_self.js
 *   (filename retained as a development artifact; jsCE float LUT vs jsCE
 *   int16 LUT — same input float LUT, the only difference is the Q0.13
 *   weight quantization, so the delta IS the kernel error).
 *
 * v1.3 KERNEL DESIGN (one-line):
 *   Q0.13 fractional weights (u13) on a u16 CLUT — the i32 ceiling for
 *   bit-exact JS↔WASM (Math.imul + i32.mul both defined, no overflow on
 *   adversarial CLUTs, no fallback paths needed). Self-test delta vs
 *   the float LUT path is < 0.001 % of u16 range on every workflow
 *   (max 4 LSB u16 = 1/64 LSB at u8, mean ≤ 0.48 LSB u16; see
 *   accuracy_v1_7_self.js for the isolated kernel measurement).
 *
 * Run:  cd bench/int16_poc && node accuracy_v1_6_vs_lcms.js
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

// ---- input grid generators -----------------------------------------

// 3D: 33 evenly-spaced steps per axis -> 35,937 samples (covers every
// CLUT cell at g1=33 plus interior points) — fast enough to run in a
// few seconds while exhaustive enough to catch precision floors.
const STEPS_3D = (() => {
    const arr = [];
    for (let i = 0; i < 33; i++) arr.push(Math.round(i / 32 * 65535));
    return arr;
})();

// 4D: 17 steps per axis -> 83,521 samples. Same coverage logic but
// with the smaller per-axis count to keep grid size manageable.
const STEPS_4D = (() => {
    const arr = [];
    for (let i = 0; i < 17; i++) arr.push(Math.round(i / 16 * 65535));
    return arr;
})();

// A few in-between u16 values that DON'T align to the 33/17-step grid,
// so we exercise the most rounding-sensitive interior of each cell.
// These are deliberately "ugly" numbers — far from any grid stop, and
// far from the bottom 4 LSB of any standard u8 ladder.
const NUDGE = [13, 4097, 9999, 23223, 49152, 56789];

function buildGrid3DU16() {
    const out = [];
    for (const r of STEPS_3D) for (const g of STEPS_3D) for (const b of STEPS_3D) {
        out.push(r, g, b);
    }
    // Add the nudge cube — N^3 extra sub-cell-aligned samples
    for (const r of NUDGE) for (const g of NUDGE) for (const b of NUDGE) {
        out.push(r, g, b);
    }
    return new Uint16Array(out);
}

function buildGrid4DU16() {
    const out = [];
    for (const c of STEPS_4D) for (const m of STEPS_4D) for (const y of STEPS_4D) for (const k of STEPS_4D) {
        out.push(c, m, y, k);
    }
    for (const c of NUDGE) for (const m of NUDGE) for (const y of NUDGE) for (const k of NUDGE) {
        out.push(c, m, y, k);
    }
    return new Uint16Array(out);
}

// ---- bucketed delta reporter ---------------------------------------

function reportDeltas(label, jsOut, lcmsOut, outCh) {
    if (jsOut.length !== lcmsOut.length) {
        throw new Error(label + ': output length mismatch ' +
            jsOut.length + ' vs ' + lcmsOut.length);
    }
    const total = jsOut.length;
    let max = 0, sum = 0;
    let cnt0 = 0, cnt1 = 0, cnt16 = 0, cnt64 = 0, cnt256 = 0;
    let worst = { d: -1, idx: -1, js: 0, lcms: 0 };
    for (let i = 0; i < total; i++) {
        const d = Math.abs(jsOut[i] - lcmsOut[i]);
        if (d > max) { max = d; }
        if (d > worst.d) {
            worst = { d, idx: i, js: jsOut[i], lcms: lcmsOut[i] };
        }
        sum += d;
        if (d === 0) cnt0++;
        if (d <= 1) cnt1++;
        if (d <= 16) cnt16++;
        if (d <= 64) cnt64++;
        if (d <= 256) cnt256++;
    }
    const mean = sum / total;
    const pct = n => ((n / total) * 100).toFixed(2).padStart(6);
    const u8eq = lsb => (lsb / 256).toFixed(3);

    // Per-pixel worst — show neighbours so it's easy to see whether the
    // diff is on a structural feature (paper white, primary saturation)
    // or just interior rounding.
    const worstPx = (worst.idx / outCh) | 0;
    const pxBase  = worstPx * outCh;

    console.log('\n  ' + label);
    console.log('  ' + '-'.repeat(label.length));
    console.log('    samples (per channel)         : ' + total.toLocaleString());
    console.log('    Δ = 0       (exact match)     : ' + pct(cnt0)   + '%');
    console.log('    Δ ≤ 1   LSB (kernel floor)    : ' + pct(cnt1)   + '%');
    console.log('    Δ ≤ 16  LSB (=' + u8eq(16)  + ' LSB u8) : ' + pct(cnt16)  + '%   ← Q0.12 baseline; Q0.13 (v1.3) should be ≥ this');
    console.log('    Δ ≤ 64  LSB (=' + u8eq(64)  + ' LSB u8) : ' + pct(cnt64)  + '%   ← visually invisible on any monitor');
    console.log('    Δ ≤ 256 LSB (=' + u8eq(256) + ' LSB u8) : ' + pct(cnt256) + '%   ← bit-equivalent to u8 path');
    console.log('    max |Δ|                       : ' + max + ' LSB u16  (=' + u8eq(max) + ' LSB u8)');
    console.log('    mean |Δ|                      : ' + mean.toFixed(2) + ' LSB u16  (=' + u8eq(mean) + ' LSB u8)');
    console.log('    worst single channel          : px[' + worstPx + '] ch' + (worst.idx % outCh) +
                '  js=' + worst.js + ' lcms=' + worst.lcms + '  Δ=' + worst.d);
    return { label, total, cnt0, cnt1, cnt16, cnt64, cnt256, max, mean };
}

// ---- main -----------------------------------------------------------

const lcms = await instantiate();

const gracolBytes = await readFile(GRACOL_PATH);
const lcmsGRACoL  = lcms.cmsOpenProfileFromMem(new Uint8Array(gracolBytes), gracolBytes.byteLength);
const lcmsSRGB    = lcms.cmsCreate_sRGBProfile();
const lcmsLab     = lcms.cmsCreateLab4Profile(null);
if (!lcmsGRACoL || !lcmsSRGB || !lcmsLab) {
    throw new Error('lcms-wasm: failed to open one of the profiles');
}

const jsGRACoL = new Profile();
await jsGRACoL.loadPromise('file:' + GRACOL_PATH);
if (!jsGRACoL.loaded) throw new Error('jsColorEngine: failed to load GRACoL');

// One pinned heap pair, big enough for the largest workflow we run.
const grid3D = buildGrid3DU16();
const grid4D = buildGrid4DU16();
const maxBytes = Math.max(grid3D.byteLength, grid4D.byteLength) * 2; // *2 for 4-ch outputs
const inPtr   = lcms._malloc(maxBytes);
const outPtr  = lcms._malloc(maxBytes);

function runLcmsU16(pIn, fIn, pOut, fOut, inputU16, nPixels, outCh) {
    const heapIn = new Uint16Array(lcms.HEAPU8.buffer, inPtr, inputU16.length);
    heapIn.set(inputU16);
    const xf = lcms.cmsCreateTransform(pIn, fIn, pOut, fOut,
        INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_HIGHRESPRECALC);
    if (!xf) throw new Error('lcms-wasm: cmsCreateTransform failed');
    lcms._cmsDoTransform(xf, inPtr, outPtr, nPixels);
    const out = new Uint16Array(lcms.HEAPU8.buffer, outPtr, nPixels * outCh).slice();
    lcms.cmsDeleteTransform(xf);
    return out;
}

function runJsU16(src, dst, inputU16) {
    // dataFormat 'int16' = Uint16Array I/O. lutMode 'int16' = pin the
    // JS u16 kernel explicitly so this bench measures the JS Q0.13 path
    // even on hosts where auto-resolution would pick a WASM sibling.
    const t = new Transform({
        dataFormat: 'int16',
        buildLut:   true,
        lutMode:    'int16',
    });
    t.create(src, dst, eIntent.relative);
    return t.transformArray(inputU16);
}

// Sanity assert — make sure we are actually running the v1.3 (Q0.13)
// JS u16 kernel (not silently demoted to lutMode='float' or the old u8
// path).
function assertV16Kernel(src, dst, inCh, outCh) {
    const t = new Transform({
        dataFormat: 'int16',
        buildLut:   true,
        lutMode:    'int16',
    });
    t.create(src, dst, eIntent.relative);
    if (t.lutMode !== 'int16') {
        throw new Error('lutMode demoted to ' + t.lutMode + ' — this bench requires int16');
    }
    if (!t.lut || !t.lut.intLut) {
        throw new Error('intLut not built — int16 kernel cannot run');
    }
    const il = t.lut.intLut;
    if (il.scale !== 65535 || il.gpsPrecisionBits !== 13) {
        throw new Error('intLut not built at v1.3 (Q0.13) contract (scale=' + il.scale +
            ', gps=' + il.gpsPrecisionBits + ')');
    }
    if (t._lutKernelBigKey !== 'i16_' + inCh + '_' + outCh) {
        throw new Error('expected dispatcher key i16_' + inCh + '_' + outCh +
            ', got ' + t._lutKernelBigKey + ' (WASM gate may have flipped back on?)');
    }
}

console.log('================================================================');
console.log(' v1.3 u16 ACCURACY — jsCE int16 vs lcms-wasm TYPE_*_16');
console.log(' (lcms flag: cmsFLAGS_HIGHRESPRECALC — most accurate u16 path)');
console.log('================================================================');
console.log(' jsCE kernels : v1.3 Q0.13 (CLUT scale 65535, JS scalar)');
console.log(' WASM int16   : pinned OFF in this bench (lutMode forced "int16") — JS only');
console.log(' Profile      : GRACoL2006_Coated1v2.icc (relative colorimetric)');
console.log(' 3D grid      : 33^3 + 6^3 nudge = ' + (grid3D.length / 3).toLocaleString() + ' pixels');
console.log(' 4D grid      : 17^4 + 6^4 nudge = ' + (grid4D.length / 4).toLocaleString() + ' pixels');

const WORKFLOWS = [
    {
        name: 'RGB → Lab    (sRGB → LabD50)',
        inCh: 3, outCh: 3, input: grid3D,
        lcms: { pIn: lcmsSRGB,   fIn: TYPE_RGB_16,  pOut: lcmsLab,    fOut: TYPE_Lab_16 },
        js:   { src: '*srgb',    dst: '*labd50' },
    },
    {
        name: 'RGB → CMYK   (sRGB → GRACoL)',
        inCh: 3, outCh: 4, input: grid3D,
        lcms: { pIn: lcmsSRGB,   fIn: TYPE_RGB_16,  pOut: lcmsGRACoL, fOut: TYPE_CMYK_16 },
        js:   { src: '*srgb',    dst: jsGRACoL },
    },
    {
        name: 'CMYK → RGB   (GRACoL → sRGB)',
        inCh: 4, outCh: 3, input: grid4D,
        lcms: { pIn: lcmsGRACoL, fIn: TYPE_CMYK_16, pOut: lcmsSRGB,   fOut: TYPE_RGB_16 },
        js:   { src: jsGRACoL,   dst: '*srgb' },
    },
    {
        name: 'CMYK → CMYK  (GRACoL → GRACoL)',
        inCh: 4, outCh: 4, input: grid4D,
        lcms: { pIn: lcmsGRACoL, fIn: TYPE_CMYK_16, pOut: lcmsGRACoL, fOut: TYPE_CMYK_16 },
        js:   { src: jsGRACoL,   dst: jsGRACoL },
    },
];

const summary = [];
for (const wf of WORKFLOWS) {
    console.log('\n--------------------------------------------------------------');
    console.log(' ' + wf.name);
    console.log('--------------------------------------------------------------');

    assertV16Kernel(wf.js.src, wf.js.dst, wf.inCh, wf.outCh);

    const nPx     = wf.input.length / wf.inCh;
    const lcmsOut = runLcmsU16(wf.lcms.pIn, wf.lcms.fIn, wf.lcms.pOut, wf.lcms.fOut,
                               wf.input, nPx, wf.outCh);
    const jsOut   = runJsU16(wf.js.src, wf.js.dst, wf.input);

    const r = reportDeltas('jsCE v1.3 (u16, Q0.13) vs lcms-wasm (u16, HIGHRESPRECALC)',
                           jsOut, lcmsOut, wf.outCh);
    summary.push({ name: wf.name, ...r });
}

lcms._free(inPtr);
lcms._free(outPtr);
lcms.cmsCloseProfile(lcmsGRACoL);
lcms.cmsCloseProfile(lcmsSRGB);
lcms.cmsCloseProfile(lcmsLab);

// ---- summary table -------------------------------------------------

console.log('\n================================================================');
console.log(' SUMMARY  (each row = % of channel-deltas inside the bucket)');
console.log('================================================================');
console.log('  workflow                         Δ=0    ≤1     ≤16    ≤64    ≤256   max   mean');
console.log('  -----------------------------    -----  -----  -----  -----  -----  ----  -----');
for (const r of summary) {
    const pct = n => ((n / r.total) * 100).toFixed(1).padStart(5);
    console.log(
        '  ' + r.name.padEnd(31) +
        '  '   + pct(r.cnt0) +
        '  '   + pct(r.cnt1) +
        '  '   + pct(r.cnt16) +
        '  '   + pct(r.cnt64) +
        '  '   + pct(r.cnt256) +
        '  '   + String(r.max).padStart(4) +
        '  '   + r.mean.toFixed(1).padStart(5)
    );
}

console.log('\n  Verdict guide:');
console.log('  • ≤16 ≈ 100%  → the dropped 3 LSB of u13 weight precision are below');
console.log('                 the lcms reference noise floor; v1.3 (Q0.13) is "true u16"');
console.log('                 in every practical sense.');
console.log('  • ≤256 ≈ 100% → v1.3 is at least as accurate as the shipping u8 path');
console.log('                 (on which we already trust millions of pixels).');
console.log('  • Q0.13 vs Q0.12 → mean delta should HALVE (Q0.13 buys 1 LSB of weight).');
console.log('  • Δ=0 row     → aspirational only — even FLOAT-exact engines disagree');
console.log('                 with lcms HIGHRESPRECALC at LSB level due to different');
console.log('                 internal precalc grid sizes and gamut clipping.');
