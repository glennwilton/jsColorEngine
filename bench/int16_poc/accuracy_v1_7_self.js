/*
 * bench/int16_poc/accuracy_v1_7_self.js
 * =====================================
 *
 * v1.3 SELF-DELTA — jsCE float LUT vs jsCE int16 LUT, same input.
 * (Filename retains the development-iteration prefix as a dev artifact.)
 *
 * The TRUE precision test for the int16 (Q0.13) kernel: hold every
 * variable constant EXCEPT the kernel itself. Both transforms are
 * built from the same source ICC profile via the same float pipeline;
 * the int16 LUT is just the float LUT rounded to u16 with Q0.13 weight
 * quantization. So the per-pixel delta below IS the v1.3 kernel error
 * — no gamut-clip noise, no profile-mismatch noise, no float64 rounding
 * disagreements. (Contrast: the lcms comparison in
 * accuracy_v1_6_vs_lcms.js mixes kernel error with profile-build
 * differences, which is why its worst-case maxes are misleading.)
 *
 * What we are measuring:
 *
 *   reference  =  Transform({dataFormat:'device', buildLut:true, lutMode:'float'})
 *                 — float LUT (Float64Array CLUT) + tetrahedral interp
 *                   in f64. The same LUT data the int16 path is rounded
 *                   from, evaluated at full f64 precision.
 *
 *   test       =  Transform({dataFormat:'int16',  buildLut:true, lutMode:'int16'})
 *                 — u16 LUT (Uint16Array CLUT, scale 65535) + Q0.13
 *                   weight tetrahedral interp in i32 via Math.imul.
 *
 *   delta      =  |round(reference_output * 65535) - test_output|
 *                 — measured per channel, in u16 LSB.
 *
 * v1.3 design recap (Q0.13 weights):
 *   Picked Q0.13 because that's the i32 ceiling for bit-exact JS↔WASM.
 *   - delta×weight max = 65535×8191 ≈ 2^29.0
 *   - sum-of-3 axes ≈ 2^30.6
 *   - fits i32 with ~1.4 bits headroom — `Math.imul` (JS) and `i32.mul`
 *     (WASM) BOTH defined on every input, no overflow paths to fall
 *     back to. Q0.14+ overflows on adversarial CLUTs; Q0.16 (lcms's
 *     choice) requires either i64 arithmetic or "trust the profile
 *     not to be adversarial" (lcms uses CMS_NO_SANITIZE attr).
 *   - Bit-exact across JS and WASM: same input bytes → same output
 *     bytes on every machine. Asserts on synthetic test data don't
 *     drift between Linux/macOS/Windows or between V8/SpiderMonkey/
 *     JavaScriptCore.
 *
 * If you are a future maintainer reading this and wondering "why
 * Q0.13 not Q0.16?": Q0.13 trades ~1 sub-LSB of theoretical precision
 * for guaranteed no-overflow on every conceivable input. We are not an
 * lcms clone — for true Q0.16 weight precision, lutMode='float' is
 * already there and gives you f64 precision (way better than Q0.16).
 *
 * Run:  cd bench/int16_poc && node accuracy_v1_7_self.js
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

const { Transform, eIntent } = require('../../src/main');
const Profile                = require('../../src/Profile');

const GRACOL_PATH = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

// ---- input grid generators -----------------------------------------
//
// Same grids as accuracy_v1_6_vs_lcms.js so the two reports are
// directly comparable (apples-to-apples on the input distribution).

const STEPS_3D = (() => {
    const arr = [];
    for (let i = 0; i < 33; i++) arr.push(Math.round(i / 32 * 65535));
    return arr;
})();

const STEPS_4D = (() => {
    const arr = [];
    for (let i = 0; i < 17; i++) arr.push(Math.round(i / 16 * 65535));
    return arr;
})();

// In-between u16 values that DON'T align to the 33/17-step grid —
// exercises the most rounding-sensitive interior of each cell.
const NUDGE = [13, 4097, 9999, 23223, 49152, 56789];

function buildGrid3DU16() {
    const out = [];
    for (const r of STEPS_3D) for (const g of STEPS_3D) for (const b of STEPS_3D) {
        out.push(r, g, b);
    }
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
//
// Same bucket boundaries as accuracy_v1_6_vs_lcms.js for direct
// readability. Expectation: in the self-delta the buckets shift WAY
// toward zero — ≤1 should be ~100 % because there are no profile-
// mismatch confounders.

function reportDeltas(label, refOutFloat01, testOutU16, outCh) {
    if (refOutFloat01.length !== testOutU16.length) {
        throw new Error(label + ': output length mismatch ' +
            refOutFloat01.length + ' vs ' + testOutU16.length);
    }
    const total = testOutU16.length;
    let max = 0, sum = 0;
    let cnt0 = 0, cnt1 = 0, cnt2 = 0, cnt4 = 0, cnt16 = 0;
    let worst = { d: -1, idx: -1, ref: 0, test: 0 };
    for (let i = 0; i < total; i++) {
        // Reference: Float64 in [0,1] → u16 (× 65535, clamp, round).
        // Same scale buildIntLut uses for the u16 CLUT, so a float of
        // 1.0 maps to u16 65535 EXACTLY (no scale-mismatch noise).
        let ref = refOutFloat01[i] * 65535;
        if (ref < 0)     ref = 0;
        if (ref > 65535) ref = 65535;
        ref = Math.round(ref);

        const d = Math.abs(ref - testOutU16[i]);
        if (d > max) max = d;
        if (d > worst.d) {
            worst = { d, idx: i, ref, test: testOutU16[i] };
        }
        sum += d;
        if (d === 0) cnt0++;
        if (d <= 1) cnt1++;
        if (d <= 2) cnt2++;
        if (d <= 4) cnt4++;
        if (d <= 16) cnt16++;
    }
    const mean = sum / total;
    const pct = n => ((n / total) * 100).toFixed(3).padStart(7);
    const u16pct = lsb => ((lsb / 65535) * 100).toFixed(4);

    const worstPx = (worst.idx / outCh) | 0;

    console.log('\n  ' + label);
    console.log('  ' + '-'.repeat(label.length));
    console.log('    samples (per channel)         : ' + total.toLocaleString());
    console.log('    Δ = 0  (bit-exact vs float)   : ' + pct(cnt0)  + '%');
    console.log('    Δ ≤ 1  (single LSB drift)     : ' + pct(cnt1)  + '%   ← Q0.13 kernel floor');
    console.log('    Δ ≤ 2                         : ' + pct(cnt2)  + '%');
    console.log('    Δ ≤ 4                         : ' + pct(cnt4)  + '%');
    console.log('    Δ ≤ 16                        : ' + pct(cnt16) + '%');
    console.log('    max |Δ|                       : ' + max + ' LSB u16  (' + u16pct(max) + ' % of u16 range)');
    console.log('    mean |Δ|                      : ' + mean.toFixed(3) + ' LSB u16  (' + u16pct(mean) + ' % of u16 range)');
    console.log('    worst single channel          : px[' + worstPx + '] ch' + (worst.idx % outCh) +
                '  ref=' + worst.ref + ' int16=' + worst.test + '  Δ=' + worst.d);
    return { label, total, cnt0, cnt1, cnt2, cnt4, cnt16, max, mean };
}

// ---- transform helpers ---------------------------------------------

function runJsFloat(src, dst, inputU16, outCh) {
    // Reference: float LUT path. Same float CLUT the int16 path was
    // rounded from. Tetrahedral interp in f64. Pre-converts u16 input
    // to Float64 in [0,1] (input/65535 — same scale as buildIntLut's
    // u16 path, so no scale-mismatch).
    const t = new Transform({
        dataFormat: 'device',   // Float64 I/O in [0,1]
        buildLut:   true,
        lutMode:    'float',    // Float64Array CLUT, f64 tetra interp
    });
    t.create(src, dst, eIntent.relative);
    if (t.lutMode !== 'float') {
        throw new Error('reference: lutMode demoted to ' + t.lutMode);
    }
    const nPx = (inputU16.length / t.inputProfile.outputChannels) | 0;
    const inFloat = new Float64Array(inputU16.length);
    for (let i = 0; i < inputU16.length; i++) inFloat[i] = inputU16[i] / 65535;
    return t.transformArray(inFloat);
}

function runJsInt16(src, dst, inputU16) {
    // Test: Q0.13 int16 path. Uint16Array I/O. Same source profiles
    // as the reference, same float pipeline used to BUILD the LUT —
    // the only differing variable is the Q0.13 weight quantization.
    const t = new Transform({
        dataFormat: 'int16',
        buildLut:   true,
        lutMode:    'int16',
    });
    t.create(src, dst, eIntent.relative);
    if (t.lutMode !== 'int16') {
        throw new Error('test: lutMode demoted to ' + t.lutMode);
    }
    const il = t.lut.intLut;
    if (il.scale !== 65535 || il.gpsPrecisionBits !== 13) {
        throw new Error('test: not built at v1.3 (Q0.13) contract (scale=' + il.scale +
            ', gps=' + il.gpsPrecisionBits + ')');
    }
    return t.transformArray(inputU16);
}

// ---- main -----------------------------------------------------------

const gracolBytes = await readFile(GRACOL_PATH);
const jsGRACoL    = new Profile();
await jsGRACoL.loadPromise('file:' + GRACOL_PATH);
if (!jsGRACoL.loaded) throw new Error('jsColorEngine: failed to load GRACoL');

const grid3D = buildGrid3DU16();
const grid4D = buildGrid4DU16();

console.log('================================================================');
console.log(' v1.3 SELF-DELTA — jsCE float LUT vs jsCE int16 LUT (Q0.13)');
console.log(' (same source profile, same float pipeline, ONLY kernel differs)');
console.log('================================================================');
console.log(' reference  : dataFormat=device, buildLut=true, lutMode=float');
console.log('              Float64 CLUT, f64 tetra interp');
console.log(' test       : dataFormat=int16,  buildLut=true, lutMode=int16');
console.log('              Uint16 CLUT (scale 65535), Q0.13 weight tetra');
console.log(' delta      : |round(ref_float01 * 65535) - int16_out| in u16 LSB');
console.log(' Profile    : GRACoL2006_Coated1v2.icc (relative colorimetric)');
console.log(' 3D grid    : 33^3 + 6^3 nudge = ' + (grid3D.length / 3).toLocaleString() + ' pixels');
console.log(' 4D grid    : 17^4 + 6^4 nudge = ' + (grid4D.length / 4).toLocaleString() + ' pixels');

const WORKFLOWS = [
    {
        name: 'RGB → Lab    (sRGB → LabD50)',
        inCh: 3, outCh: 3, input: grid3D,
        src: '*srgb', dst: '*labd50',
    },
    {
        name: 'RGB → CMYK   (sRGB → GRACoL)',
        inCh: 3, outCh: 4, input: grid3D,
        src: '*srgb', dst: jsGRACoL,
    },
    {
        name: 'CMYK → RGB   (GRACoL → sRGB)',
        inCh: 4, outCh: 3, input: grid4D,
        src: jsGRACoL, dst: '*srgb',
    },
    {
        name: 'CMYK → CMYK  (GRACoL → GRACoL)',
        inCh: 4, outCh: 4, input: grid4D,
        src: jsGRACoL, dst: jsGRACoL,
    },
];

const summary = [];
for (const wf of WORKFLOWS) {
    console.log('\n--------------------------------------------------------------');
    console.log(' ' + wf.name);
    console.log('--------------------------------------------------------------');
    const refOut  = runJsFloat(wf.src, wf.dst, wf.input, wf.outCh);
    const testOut = runJsInt16(wf.src, wf.dst, wf.input);
    const r = reportDeltas('jsCE float (f64) vs jsCE int16 (Q0.13)',
        refOut, testOut, wf.outCh);
    r.name = wf.name;
    summary.push(r);
}

console.log('\n================================================================');
console.log(' SUMMARY  (each row = % of channel-deltas inside the bucket)');
console.log('================================================================');
console.log('  workflow                         Δ=0     ≤1      ≤2      ≤4      ≤16     max   mean');
console.log('  -----------------------------    ------  ------  ------  ------  ------  ----  -----');
for (const r of summary) {
    const pct = n => ((n / r.total) * 100).toFixed(2).padStart(6);
    console.log(
        '  ' + r.name.padEnd(31) +
        '  '   + pct(r.cnt0) +
        '  '   + pct(r.cnt1) +
        '  '   + pct(r.cnt2) +
        '  '   + pct(r.cnt4) +
        '  '   + pct(r.cnt16) +
        '  '   + String(r.max).padStart(4) +
        '  '   + r.mean.toFixed(2).padStart(5)
    );
}

console.log('\n  Verdict guide (this is the REAL kernel-precision test):');
console.log('  • ≤1 ≈ 100 %  → Q0.13 weight quantization is at-or-below the');
console.log('                 round-to-u16 floor; the int16 path is bit-exact');
console.log('                 with the float path on essentially every pixel.');
console.log('  • ≤4 ≈ 100 %  → worst-case kernel error is a fraction of a u8 LSB');
console.log('                 (4 LSB u16 = 0.0061 % of u16 range = 1/64 LSB at u8).');
console.log('  • Δ=0 row     → the bit-exact-match rate; depends on profile but');
console.log('                 typically >95 % on RGB→Lab, >80 % on CMYK paths.');
console.log('  • This bench fully isolates kernel error — no profile-mismatch');
console.log('    noise (vs lcms compare), no LUT-vs-no-LUT noise (vs the per-');
console.log('    pixel float pipeline). The numbers here ARE the v1.3 design.');
