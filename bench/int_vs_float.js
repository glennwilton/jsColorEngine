/**
 * int_vs_float.js — proof-of-concept benchmark for an integer (Uint16 LUT
 * + Math.imul) port of the tetrahedralInterp3DArray_3Ch_loop hot kernel.
 *
 * Goal: see whether running the per-pixel interpolator on integer math
 * with a Uint16Array CLUT (instead of Float64Array CLUT + double maths)
 * gives a meaningful speedup, and quantify the accuracy loss.
 *
 * Setup:
 *   - Builds a real sRGB → AdobeRGB transform via the engine
 *   - Captures the prebuilt float64 CLUT (33^3 grid in practice)
 *   - Derives a parallel Uint16 CLUT (and a u15 cap version)
 *   - Generates 256x256 seeded-random RGB input pixels, with a
 *     deliberate set of edge-case pixels prepended so cube corners
 *     and the input===255 boundary are *always* exercised, not left
 *     to the LCG seed
 *   - Runs all kernels: warmup 1000 iter, then 5 timed runs of 100 iter
 *   - Reports speed (ms/iter, MPx/sec, speedup ratio)
 *   - Reports accuracy: per-channel diff histogram + spot-check
 *     of each named edge-case pixel printed as a side-by-side table
 *
 * Throwaway / experimental. Lives in bench/, not shipped on npm.
 *
 * SECTION 2 (added later): u16-output variants.
 *   For high-precision pipelines (Lab16 ICC v4 output, 16-bit proofing
 *   chains) we want to write to a Uint16Array, not Uint8ClampedArray.
 *   Q0.8 weights would throw away half the output bits, so we need
 *   Q0.16 weights — but Q0.16 × full u16 LUT overflows Math.imul
 *   (65535*65535 = 4.29B > int32). Three ways out, all benched here:
 *
 *   A) u15 LUT  + Q0.16 weights  → drop 1 bit at LUT build time
 *   B) u16 LUT  + Q0.16 weights + diff>>1 inside Math.imul
 *      → drop 1 bit at op time; base value (c0) keeps full precision
 *   C) u16 LUT  + Q0.15 weights  → drop 1 bit on the weight side
 *      ⚠ has a 1-in-billion overflow risk; bench measures whether it
 *      actually fires on real inputs vs the float reference
 *
 * ======================================================================
 * FINDINGS — for future us, lessons from running this experiment
 * ======================================================================
 *
 * Numbers below are from a Windows 10 / Node 18+ run on the development
 * machine, sRGB → AdobeRGB, relative-colorimetric, 33^3 LUT, 65 536
 * pixels per iter, 100 iter timed × 5 runs (median reported).
 *
 *   u8 OUTPUT  (Section 1)                                speedup    max diff
 *     Float kernel (baseline)                             1.00×      —
 *     Q0.8 weights × u16 LUT                              1.50×      1 (u8)
 *
 *   u16 OUTPUT (Section 2, all three int variants)
 *     Float kernel writing u16                            1.00×      —
 *     C) Q0.15 weights × u16 LUT  ← winner                1.48×      1 (u16)
 *     A) Q0.16 weights × u15 LUT                          1.44×      3 (u16)
 *     B) Q0.16 weights × u16 LUT × (diff>>1)              1.41×      3 (u16)
 *
 * KEY LESSONS:
 *
 * 1. The u8 path is a pure ship-it. 1.5× speed, max diff = 1 LSB, with
 *    a 4× LUT memory shrink (842 KB → 211 KB) that helps cache locality
 *    on chained transforms.
 *
 * 2. The input===255 boundary requires an explicit per-axis branch.
 *    Without it, gridPointsScale rounding (e.g. 32.125 → 32 for g1=33)
 *    leaves saturated channels one grid below where they should be —
 *    max diff jumped from 1 → 8, with 0.49% of channels off by ≥3.
 *    This was the only non-obvious bug that the random-pixel bench
 *    happened to surface; it would *not* have been caught by a smaller
 *    test suite. Always include cube corners (especially the 255 ones)
 *    in any future int-kernel acceptance test.
 *
 * 3. SINGLE ROUNDING STEPS BEAT DOUBLE ROUNDING. This was the biggest
 *    surprise of Section 2:
 *      - C (Q0.15 weights): one rounding step at the final >> 15
 *        → 71.9% exact, max diff 1 (u16)
 *      - B (diff >> 1):      two rounding steps (per-diff truncation +
 *        final shift) → 49.0% exact, max diff 3 (u16)
 *      - A (u15 LUT cap):    rounding embedded in every LUT entry +
 *        final shift → 33.8% exact, max diff 3
 *    Lesson for future fixed-point kernels: keep precision wide as long
 *    as possible, do exactly one round-to-nearest (with a +bias) at the
 *    end. Don't sprinkle truncating shifts into the middle of an
 *    accumulator chain — every arithmetic-shift-right of a signed
 *    value is asymmetric for negatives and bleeds bias.
 *
 * 4. EXTRA SHIFTS DO COST MEASURABLE TIME. The diff>>1 variant added
 *    9 shifts per pixel and ran ~5% slower than Q0.15. Counter to
 *    intuition that "shifts are free" — at hundreds of millions of ops/s
 *    they show up. Math.imul + accumulate is the cheapest possible
 *    kernel; anything you add to it is real cost.
 *
 * 5. Q0.15 weights are SAFE IN PRACTICE for u16 LUTs but THEORETICALLY
 *    TIGHT. The sum of three weighted diffs can in pathological cases
 *    reach exactly 2^31 (= max int32 + 1). Random-pixel tests never
 *    hit it; real ICC profiles don't have the discontinuities required
 *    to trip it (would manifest as visible posterisation). Before
 *    shipping, either:
 *      a) add a synthetic adversarial-LUT stress test, OR
 *      b) guard with sum = Math.min(0x7FFFFFFF, sum) before >> 15, OR
 *      c) drop to Q0.14 weights for unconditional safety (probably
 *         invisible quality loss).
 *
 * 6. Why the int kernels actually win:
 *      - u16 LUT footprint is 4× smaller than f64 (cache-friendly)
 *      - Math.imul keeps V8's int32 fast path active (no HeapNumber)
 *      - No floating-point clamp/round when writing to typed arrays
 *      - The original float kernel's `* outputScale` is replaced by
 *        bit-shifts, which the JIT happily inlines
 *    The cache-footprint argument compounds with chained transforms:
 *    every CLUT in an RGB→Lab→CMYK pipeline shrinks 4×.
 *
 * 7. Output-buffer type matters. Float kernel writing u16 was slightly
 *    *faster* than the same kernel writing u8 (Uint8ClampedArray has
 *    extra clamping logic on assignment). Worth remembering when
 *    designing the high-precision path: writing u16 is not slower than
 *    writing u8.
 *
 * 8. Edge-case pixels to always include in any future kernel test:
 *    the 8 cube corners (any 255 stresses boundary patches), the
 *    255/254 pair (off-by-one near saturation), 0/1 (off-by-one near
 *    black), and a mid-gray (128,128,128) for "is the JIT generating
 *    integer code at all" sanity. See `EDGE_PIXELS` below for the
 *    full list used here.
 *
 * 9. The 1.5× speedup is consistent across both u8 and u16 output
 *    paths. There's no obvious next ~2× gain available without going
 *    to WASM/SIMD or GPU — int math has nearly closed the gap to what
 *    the JIT can produce from this kernel shape.
 *
 * 10. SURPRISE FROM THE EDGE-CASE TABLE: for the (255,255,255) "white"
 *     corner the float reference returns (65534,65535,65534) — i.e.
 *     R and B channels are 1 LSB short of full saturation, G is full.
 *     This is NOT an interpolation bug. It's a build-time rounding
 *     mismatch:
 *       - the float CLUT for AdobeRGB white sits at ≈0.99999 on R/B
 *         (chromatic adaptation residue), and the float kernel writes
 *         it via `value * 65535` then implicit Uint16Array truncation,
 *         giving 65534
 *       - the int kernel's u16 LUT builder uses `Math.round()`, which
 *         rounds 65534.5 up to 65535
 *     Both behaviours are defensible; the int answer is arguably
 *     *more* faithful to the ideal D65 white. Future tests should not
 *     flag this as a regression — use "within 1 LSB" tolerance, not
 *     exact equality, even on the cube corners. The assertion at the
 *     bottom of this file uses ABS_TOL_U16 = 1 for that reason.
 *
 * 11. Section 3 confirmed the u8 int kernel is EXACT on every one of
 *     the 20 edge cases (zero deltas across the board). For the u16
 *     kernels, Q0.15 weights produced the most all-zero rows by a
 *     wide margin — final confirmation it's the right choice.
 * ======================================================================
 */

const { Profile, Transform, eIntent } = require('../src/main');

// ----------------------------------------------------------------------
// 1. Build a real LUT via the engine
// ----------------------------------------------------------------------

const transform = new Transform({
    buildLut: true,
    dataFormat: 'int8',
});
transform.create('*sRGB', '*AdobeRGB', eIntent.relative);

const floatLut = transform.lut;

// Sanity: confirm shape
if (!floatLut || !floatLut.CLUT) {
    console.error('LUT build failed — got', floatLut);
    process.exit(1);
}

const g1 = floatLut.g1;
const go0 = floatLut.go0;
const go1 = floatLut.go1;
const go2 = floatLut.go2;
const inputScale = floatLut.inputScale;
const outputScale = floatLut.outputScale;

console.log('=== LUT info ===');
console.log('  grid:           ' + g1 + '^3');
console.log('  CLUT length:    ' + floatLut.CLUT.length + ' (' + floatLut.CLUT.constructor.name + ')');
console.log('  go0/go1/go2:    ' + go0 + ' / ' + go1 + ' / ' + go2);
console.log('  inputScale:     ' + inputScale);
console.log('  outputScale:    ' + outputScale);
console.log('');

// ----------------------------------------------------------------------
// 2. Build a parallel Uint16 LUT from the float LUT
// ----------------------------------------------------------------------
//
// The float LUT stores normalised values that, when multiplied by the
// pre-baked outputScale, give a u8 in [0, 255]. We reverse that: each
// float entry, taken back to the [0, 1] normalised range, is encoded as
// uint16 in [0, 65535]. The int kernel then converts u16 → u8 at the end
// with `>> 8` (max ±1 LSB error vs the exact /257 division).

const sourceFloatLUT = floatLut.CLUT;
const u16LUT = new Uint16Array(sourceFloatLUT.length);
for (let i = 0; i < sourceFloatLUT.length; i++) {
    // sourceFloatLUT * outputScale ≈ 0..255 (u8)
    // so sourceFloatLUT alone is in 0..(255/outputScale)
    // → normalise to 0..1 by dividing by (255/outputScale) → multiply by outputScale/255
    // → encode u16 by * 65535
    let v = sourceFloatLUT[i] * outputScale * (65535 / 255);
    if (v < 0) v = 0;
    if (v > 65535) v = 65535;
    u16LUT[i] = Math.round(v);
}

// Pre-compute the integer scale that converts u8 input to a Q0.8
// fixed-point grid coordinate in one Math.imul:
//   pxFixed = input * gridPointsScale_fixed
//     X0_idx = pxFixed >>> 8       (grid index 0..g1-1)
//     rx_q8  = pxFixed & 0xFF      (fractional weight, Q0.8)
//
// gridPointsScale_fixed = round(((g1 - 1) << 8) / 255)
//   For g1=17: round(4096/255)  = 16
//   For g1=33: round(8192/255)  = 32
//   For g1=9:  round(2048/255)  =  8
const gridPointsScale_fixed = Math.round(((g1 - 1) << 8) / 255);

console.log('=== Int LUT info ===');
console.log('  u16LUT length:                ' + u16LUT.length);
console.log('  u16LUT memory:                ' + (u16LUT.byteLength / 1024).toFixed(1) + ' KB (vs ' + (sourceFloatLUT.byteLength / 1024).toFixed(1) + ' KB float64)');
console.log('  gridPointsScale_fixed (Q0.8): ' + gridPointsScale_fixed);
console.log('');

// ----------------------------------------------------------------------
// 3. Generate seeded-random RGB test pixels
// ----------------------------------------------------------------------

const WIDTH = 256;
const HEIGHT = 256;
const PIXEL_COUNT = WIDTH * HEIGHT;
const CHANNELS_IN = 3;     // RGB, no alpha (keeps experiment focused)
const CHANNELS_OUT = 3;    // RGB out

// ----------------------------------------------------------------------
// Edge-case pixels — prepended to the input so they're always exercised
// regardless of the LCG seed. These are the ones that historically have
// surfaced bugs in interpolation kernels:
//
//   - cube corners: any pixel containing 255 stresses the input===255
//     boundary patch (see FINDING #2 at top of file)
//   - mid-gray (128,128,128): clean midpoint, "is the JIT actually
//     compiling this as integer math" smoke test
//   - 254 / 1: off-by-one neighbours of the boundary
//   - asymmetric mixed (255,128,0 etc.): exercises tetrahedral case
//     selection branches
// ----------------------------------------------------------------------

const EDGE_PIXELS = [
    // 8 cube corners
    { name: 'black     ', rgb: [  0,   0,   0] },
    { name: 'red       ', rgb: [255,   0,   0] },
    { name: 'green     ', rgb: [  0, 255,   0] },
    { name: 'blue      ', rgb: [  0,   0, 255] },
    { name: 'yellow    ', rgb: [255, 255,   0] },
    { name: 'magenta   ', rgb: [255,   0, 255] },
    { name: 'cyan      ', rgb: [  0, 255, 255] },
    { name: 'white     ', rgb: [255, 255, 255] },
    // mid axes — should land cleanly on grid 16 for g1=33 (128*32/255 ≈ 16.06)
    { name: 'mid-red   ', rgb: [128,   0,   0] },
    { name: 'mid-green ', rgb: [  0, 128,   0] },
    { name: 'mid-blue  ', rgb: [  0,   0, 128] },
    { name: 'mid-gray  ', rgb: [128, 128, 128] },
    // quarter & three-quarter grays
    { name: 'q-gray    ', rgb: [ 64,  64,  64] },
    { name: '3q-gray   ', rgb: [192, 192, 192] },
    // off-by-one near saturation
    { name: 'near-black', rgb: [  1,   1,   1] },
    { name: 'near-white', rgb: [254, 254, 254] },
    // asymmetric mixed boundaries (each picks a different tetrahedral case)
    { name: 'orange    ', rgb: [255, 128,   0] },
    { name: 'sky       ', rgb: [  0, 128, 255] },
    { name: 'pink      ', rgb: [255,   0, 128] },
    { name: 'lime      ', rgb: [128, 255,   0] },
];
const EDGE_COUNT = EDGE_PIXELS.length;

// Tiny LCG, fixed seed → reproducible inputs across runs
let seed = 0xC0FFEE;
function rand255() {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7FFFFFFF;
    return (seed >>> 16) & 0xFF;
}

const input = new Uint8ClampedArray(PIXEL_COUNT * CHANNELS_IN);
// First EDGE_COUNT pixels are deterministic edge cases
for (let i = 0; i < EDGE_COUNT; i++) {
    input[i * 3 + 0] = EDGE_PIXELS[i].rgb[0];
    input[i * 3 + 1] = EDGE_PIXELS[i].rgb[1];
    input[i * 3 + 2] = EDGE_PIXELS[i].rgb[2];
}
// Remainder is seeded random
for (let i = EDGE_COUNT * 3; i < input.length; i++) {
    input[i] = rand255();
}

// Two output buffers — one per kernel, so we can diff them after.
const outputFloat = new Uint8ClampedArray(PIXEL_COUNT * CHANNELS_OUT);
const outputInt   = new Uint8ClampedArray(PIXEL_COUNT * CHANNELS_OUT);

console.log('=== Input ===');
console.log('  ' + WIDTH + ' x ' + HEIGHT + ' = ' + PIXEL_COUNT + ' pixels');
console.log('  ' + (input.byteLength / 1024).toFixed(1) + ' KB input,  ' + (outputFloat.byteLength / 1024).toFixed(1) + ' KB output');
console.log('');

// ----------------------------------------------------------------------
// 4. Float kernel — verbatim copy of tetrahedralInterp3DArray_3Ch_loop
//    minus the alpha block (we run it without alpha here for fairness)
// ----------------------------------------------------------------------

function kernelFloat(input, output, length, lut) {
    var rx, ry, rz,
        X0, X1, Y0, Y1, Z0, Z1,
        px, py, pz,
        input0, input1, input2;
    var base1, base2, base3, base4,
        c0, c1, c2, a, b;

    var outputScale = lut.outputScale;
    var gridPointsScale = (lut.g1 - 1) * lut.inputScale;
    var CLUT = lut.CLUT;
    var go0 = lut.go0;
    var go1 = lut.go1;
    var go2 = lut.go2;

    var inputPos = 0;
    var outputPos = 0;

    for (var p = 0; p < length; p++) {
        input0 = input[inputPos++];
        input1 = input[inputPos++];
        input2 = input[inputPos++];

        px = input0 * gridPointsScale;
        py = input1 * gridPointsScale;
        pz = input2 * gridPointsScale;

        X0 = ~~px;
        rx = (px - X0);
        X0 *= go2;
        X1 = (input0 === 255) ? X0 : X0 + go2;

        Y0 = ~~py;
        ry = (py - Y0);
        Y0 *= go1;
        Y1 = (input1 === 255) ? Y0 : Y0 + go1;

        Z0 = ~~pz;
        rz = (pz - Z0);
        Z0 *= go0;
        Z1 = (input2 === 255) ? Z0 : Z0 + go0;

        base1 = X0 + Y0 + Z0;
        c0 = CLUT[base1++];
        c1 = CLUT[base1++];
        c2 = CLUT[base1];

        if (rx >= ry && ry >= rz) {
            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z0;
            base4 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = (c0 + ((a - c0) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = (c1 + ((a - c1) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;
            a = CLUT[base1];   b = CLUT[base2];
            output[outputPos++] = (c2 + ((a - c2) * rx) + ((b - a) * ry) + ((CLUT[base4]   - b) * rz)) * outputScale;
        } else if (rx >= rz && rz >= ry) {
            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z1;
            base3 = X1 + Y0 + Z1;
            a = CLUT[base3++]; b = CLUT[base1++];
            output[outputPos++] = (c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) * outputScale;
            a = CLUT[base3++]; b = CLUT[base1++];
            output[outputPos++] = (c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) * outputScale;
            a = CLUT[base3];   b = CLUT[base1];
            output[outputPos++] = (c2 + ((b - c2) * rx) + ((CLUT[base2]   - a) * ry) + ((a - b) * rz)) * outputScale;
        } else if (rx >= ry && rz >= rx) {
            base1 = X1 + Y0 + Z1;
            base2 = X0 + Y0 + Z1;
            base3 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = (c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz)) * outputScale;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = (c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz)) * outputScale;
            a = CLUT[base1];   b = CLUT[base2];
            output[outputPos++] = (c2 + ((a - b) * rx) + ((CLUT[base3]   - a) * ry) + ((b - c2) * rz)) * outputScale;
        } else if (ry >= rx && rx >= rz) {
            base1 = X1 + Y1 + Z0;
            base2 = X0 + Y1 + Z0;
            base4 = X1 + Y1 + Z1;
            a = CLUT[base2++]; b = CLUT[base1++];
            output[outputPos++] = (c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;
            a = CLUT[base2++]; b = CLUT[base1++];
            output[outputPos++] = (c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;
            a = CLUT[base2];   b = CLUT[base1];
            output[outputPos++] = (c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4]   - b) * rz)) * outputScale;
        } else if (ry >= rz && rz >= rx) {
            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            base3 = X0 + Y1 + Z0;
            a = CLUT[base2++]; b = CLUT[base3++];
            output[outputPos++] = (c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz)) * outputScale;
            a = CLUT[base2++]; b = CLUT[base3++];
            output[outputPos++] = (c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz)) * outputScale;
            a = CLUT[base2];   b = CLUT[base3];
            output[outputPos++] = (c2 + ((CLUT[base1]   - a) * rx) + ((b - c2) * ry) + ((a - b) * rz)) * outputScale;
        } else if (rz >= ry && ry >= rx) {
            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            base4 = X0 + Y0 + Z1;
            a = CLUT[base2++]; b = CLUT[base4++];
            output[outputPos++] = (c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz)) * outputScale;
            a = CLUT[base2++]; b = CLUT[base4++];
            output[outputPos++] = (c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz)) * outputScale;
            a = CLUT[base2];   b = CLUT[base4];
            output[outputPos++] = (c2 + ((CLUT[base1]   - a) * rx) + ((a - b) * ry) + ((b - c2) * rz)) * outputScale;
        } else {
            output[outputPos++] = c0 * outputScale;
            output[outputPos++] = c1 * outputScale;
            output[outputPos++] = c2 * outputScale;
        }
    }
}

// ----------------------------------------------------------------------
// 5. Int kernel — same logic, integer math throughout
// ----------------------------------------------------------------------
//
// Math contract:
//   - CLUT values are u16 in [0, 65535] representing [0.0, 1.0]
//   - rx, ry, rz are Q0.8 fractional weights in [0, 255] representing [0.0, 1.0]
//   - Diffs (a - c0) etc. are signed int in [-65535, +65535]
//   - Math.imul(diff, weight) max magnitude = 65535*255 = 16_711_425   (fits int32 with huge margin)
//   - Sum of three such terms max magnitude ≈ 50M           (well under 2^31)
//   - + 0x80 bias before >> 8 = round-to-nearest
//   - Final >> 8 converts u16 result to u8 (one LSB max error vs exact /257)
//
// All multiplications go through Math.imul so V8 keeps the int32 fast
// path. No floats anywhere in the loop.

function kernelInt(input, output, length, lut) {
    var rx = 0 | 0, ry = 0 | 0, rz = 0 | 0;
    var X0 = 0 | 0, X1 = 0 | 0, Y0 = 0 | 0, Y1 = 0 | 0, Z0 = 0 | 0, Z1 = 0 | 0;
    var px = 0 | 0, py = 0 | 0, pz = 0 | 0;
    var input0 = 0 | 0, input1 = 0 | 0, input2 = 0 | 0;
    var base1 = 0 | 0, base2 = 0 | 0, base3 = 0 | 0, base4 = 0 | 0;
    var c0 = 0 | 0, c1 = 0 | 0, c2 = 0 | 0, a = 0 | 0, b = 0 | 0;

    var gps = lut.gridPointsScale_fixed | 0;
    var CLUT = lut.CLUT;
    var go0 = lut.go0 | 0;
    var go1 = lut.go1 | 0;
    var go2 = lut.go2 | 0;
    // Precomputed last-grid offsets for the input===255 special case.
    // Float kernel doesn't need this because float (input * (g1-1)/255)
    // equals (g1-1) exactly for input=255; our int approximation rounds
    // gridPointsScale_fixed down (e.g. 32 for g1=33 vs the true 32.125),
    // so the integer multiply lands one grid below the top. Patch it.
    var maxX = Math.imul(lut.g1 - 1, go2) | 0;
    var maxY = Math.imul(lut.g1 - 1, go1) | 0;
    var maxZ = Math.imul(lut.g1 - 1, go0) | 0;

    var inputPos = 0 | 0;
    var outputPos = 0 | 0;

    for (var p = 0; p < length; p++) {
        input0 = input[inputPos++];
        input1 = input[inputPos++];
        input2 = input[inputPos++];

        px = Math.imul(input0, gps);   // Q.8 grid coord
        py = Math.imul(input1, gps);
        pz = Math.imul(input2, gps);

        // Boundary patch: input=255 must land on the last grid point with
        // weight 0; our int scale rounds down so the natural shift gives
        // grid (g1-2) with weight ~0.875 — wrong neighbourhood entirely.
        if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
        else { X0 = px >>> 8; rx = px & 0xFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

        if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
        else { Y0 = py >>> 8; ry = py & 0xFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

        if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
        else { Z0 = pz >>> 8; rz = pz & 0xFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

        base1 = X0 + Y0 + Z0;
        c0 = CLUT[base1++];
        c1 = CLUT[base1++];
        c2 = CLUT[base1];

        // Per-case integer port. The arithmetic mirrors kernelFloat
        // exactly, just substituting Math.imul for *, +0x80 bias before
        // >> 8 for rounding, and a final >> 8 to convert u16 → u8.
        //
        // u8_out = ((c0 + sum_in_Q0.8 + 0x80) >> 8 + 0x80) >> 8
        //        but c0 is in [0..65535] (u16) so we do:
        //          u16_out = c0 + ((sum_in_Q0.8 + 0x80) >> 8)
        //          u8_out  = (u16_out + 0x80) >> 8
        if (rx >= ry && ry >= rz) {
            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z0;
            base4 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = ((c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = ((c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            a = CLUT[base1];   b = CLUT[base2];
            output[outputPos++] = ((c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
        } else if (rx >= rz && rz >= ry) {
            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z1;
            base3 = X1 + Y0 + Z1;
            a = CLUT[base3++]; b = CLUT[base1++];
            output[outputPos++] = ((c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            a = CLUT[base3++]; b = CLUT[base1++];
            output[outputPos++] = ((c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            a = CLUT[base3];   b = CLUT[base1];
            output[outputPos++] = ((c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
        } else if (rx >= ry && rz >= rx) {
            base1 = X1 + Y0 + Z1;
            base2 = X0 + Y0 + Z1;
            base3 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = ((c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x80) >> 8)) + 0x80) >> 8;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = ((c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x80) >> 8)) + 0x80) >> 8;
            a = CLUT[base1];   b = CLUT[base2];
            output[outputPos++] = ((c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c2, rz) + 0x80) >> 8)) + 0x80) >> 8;
        } else if (ry >= rx && rx >= rz) {
            base1 = X1 + Y1 + Z0;
            base2 = X0 + Y1 + Z0;
            base4 = X1 + Y1 + Z1;
            a = CLUT[base2++]; b = CLUT[base1++];
            output[outputPos++] = ((c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            a = CLUT[base2++]; b = CLUT[base1++];
            output[outputPos++] = ((c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            a = CLUT[base2];   b = CLUT[base1];
            output[outputPos++] = ((c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
        } else if (ry >= rz && rz >= rx) {
            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            base3 = X0 + Y1 + Z0;
            a = CLUT[base2++]; b = CLUT[base3++];
            output[outputPos++] = ((c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            a = CLUT[base2++]; b = CLUT[base3++];
            output[outputPos++] = ((c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
            a = CLUT[base2];   b = CLUT[base3];
            output[outputPos++] = ((c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
        } else if (rz >= ry && ry >= rx) {
            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            base4 = X0 + Y0 + Z1;
            a = CLUT[base2++]; b = CLUT[base4++];
            output[outputPos++] = ((c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x80) >> 8)) + 0x80) >> 8;
            a = CLUT[base2++]; b = CLUT[base4++];
            output[outputPos++] = ((c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x80) >> 8)) + 0x80) >> 8;
            a = CLUT[base2];   b = CLUT[base4];
            output[outputPos++] = ((c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x80) >> 8)) + 0x80) >> 8;
        } else {
            // Degenerate (unlikely but mirrors float kernel): rx===ry===rz
            // case where none of the inequalities hold. In float code this
            // emits the c0/c1/c2 base lookup directly. Same here.
            output[outputPos++] = (c0 + 0x80) >> 8;
            output[outputPos++] = (c1 + 0x80) >> 8;
            output[outputPos++] = (c2 + 0x80) >> 8;
        }
    }
}

// ----------------------------------------------------------------------
// 6. Build LUT params each kernel expects
// ----------------------------------------------------------------------

const floatLutParams = floatLut;  // pass through; kernel reads its fields
const intLutParams = {
    CLUT: u16LUT,
    g1: g1,
    go0: go0,
    go1: go1,
    go2: go2,
    gridPointsScale_fixed: gridPointsScale_fixed,
};

// ----------------------------------------------------------------------
// 7. Accuracy pass — run both once, diff outputs
// ----------------------------------------------------------------------

console.log('=== Accuracy ===');
kernelFloat(input, outputFloat, PIXEL_COUNT, floatLutParams);
kernelInt(input,   outputInt,   PIXEL_COUNT, intLutParams);

let exact = 0, off1 = 0, off2 = 0, off3plus = 0;
let maxDiff = 0;
let maxDiffChannel = -1, maxDiffPixel = -1;
const channelLabels = ['R', 'G', 'B'];
const totalChannels = PIXEL_COUNT * CHANNELS_OUT;

for (let i = 0; i < totalChannels; i++) {
    const d = Math.abs(outputFloat[i] - outputInt[i]);
    if (d === 0)      exact++;
    else if (d === 1) off1++;
    else if (d === 2) off2++;
    else              off3plus++;
    if (d > maxDiff) {
        maxDiff = d;
        maxDiffChannel = i % CHANNELS_OUT;
        maxDiffPixel = (i / CHANNELS_OUT) | 0;
    }
}

const pct = n => ((n / totalChannels) * 100).toFixed(2) + '%';
console.log('  total channels: ' + totalChannels);
console.log('  exact:          ' + exact + '  (' + pct(exact) + ')');
console.log('  off by 1:       ' + off1 + '  (' + pct(off1) + ')');
console.log('  off by 2:       ' + off2 + '  (' + pct(off2) + ')');
console.log('  off by ≥3:      ' + off3plus + '  (' + pct(off3plus) + ')');
console.log('  max diff:       ' + maxDiff + '  (channel ' + (maxDiffChannel >= 0 ? channelLabels[maxDiffChannel] : '?') + ', pixel #' + maxDiffPixel + ')');
console.log('');

if (maxDiff > 2) {
    console.log('  ✗ accuracy regression — abort bench, fix int port first');
    process.exit(2);
} else if (maxDiff <= 1) {
    console.log('  ✓ within tolerance (all ≤ 1)');
} else {
    console.log('  ⚠ acceptable but worse than ±1 (max ' + maxDiff + ')');
}
console.log('');

// ----------------------------------------------------------------------
// 8. Speed bench — warmup + timed runs
// ----------------------------------------------------------------------

const WARMUP_ITER = 1000;
const TIMED_RUNS = 5;
const TIMED_ITER = 100;

function bench(name, fn, lut) {
    // Warmup
    for (let i = 0; i < WARMUP_ITER; i++) fn(input, outputFloat, PIXEL_COUNT, lut);
    // Timed runs
    const samples = [];
    for (let r = 0; r < TIMED_RUNS; r++) {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < TIMED_ITER; i++) fn(input, outputFloat, PIXEL_COUNT, lut);
        const t1 = process.hrtime.bigint();
        const ms = Number(t1 - t0) / 1e6;
        samples.push(ms / TIMED_ITER);  // ms per iteration
    }
    samples.sort((a, b) => a - b);
    const median = samples[(samples.length / 2) | 0];
    const mpxPerSec = (PIXEL_COUNT / 1e6) / (median / 1000);
    console.log('  ' + name.padEnd(15) + median.toFixed(3) + ' ms/iter  →  ' + mpxPerSec.toFixed(2) + ' MPx/s   (samples: ' + samples.map(s => s.toFixed(2)).join(', ') + ')');
    return median;
}

console.log('=== Speed (median of ' + TIMED_RUNS + ' runs of ' + TIMED_ITER + ' iter, warmup ' + WARMUP_ITER + ') ===');
const tFloat = bench('Float kernel:',  kernelFloat, floatLutParams);
const tInt   = bench('Int kernel:',    kernelInt,   intLutParams);
console.log('');
console.log('  speedup:      ' + (tFloat / tInt).toFixed(2) + '×   (int vs float, higher = int faster)');
console.log('');

// ----------------------------------------------------------------------
// 9. Verdict
// ----------------------------------------------------------------------

const speedup = tFloat / tInt;
console.log('=== Verdict ===');
if (speedup >= 1.5 && maxDiff <= 1) {
    console.log('  ✓ ship it — meaningful speedup with negligible accuracy loss');
} else if (speedup >= 1.2 && maxDiff <= 2) {
    console.log('  ◐ marginal — worth pursuing if SIMD/WASM is on the roadmap');
} else if (speedup < 1.0) {
    console.log('  ✗ slower — int port lost the JIT optimisation; abandon or rewrite');
} else {
    console.log('  ◯ inconclusive — speedup ' + speedup.toFixed(2) + '×, max diff ' + maxDiff);
}

// ======================================================================
// SECTION 2: u16 output — high-precision path
// ======================================================================
//
// Same input pixels, same float LUT, but now write results to a
// Uint16Array (representing the [0,1] range as [0,65535]). Float kernel
// just reuses kernelFloat with outputScale = 65535. Three int variants
// to test, each with a different way of avoiding Math.imul overflow on
// Q0.16 weights × u16 LUT diffs:
//
//   A) u15 LUT     — half the LUT precision at build time, full Q0.16
//                    weights at runtime. Branch-cleanest int kernel.
//   B) diff>>1     — keep u16 LUT, drop 1 bit on the difference inside
//                    the multiply. c0 stays full-precision so the base
//                    of the interpolation is exact.
//   C) Q0.15 wts   — keep u16 LUT, use 15-bit weights. Sum can hit 2^31
//                    in pathological corners → corruption risk. Bench
//                    will tell us if random data triggers it.

console.log('');
console.log('======================================================================');
console.log('SECTION 2 — u16 output (high-precision pipeline)');
console.log('======================================================================');
console.log('');

// ----------------------------------------------------------------------
// 2a. Build u15 LUT (option A) — keeps memory layout the same
//     as a Uint16Array, just caps every value at 32767.
// ----------------------------------------------------------------------

const u15LUT = new Uint16Array(sourceFloatLUT.length);
for (let i = 0; i < sourceFloatLUT.length; i++) {
    let v = sourceFloatLUT[i] * outputScale * (32767 / 255);
    if (v < 0) v = 0;
    if (v > 32767) v = 32767;
    u15LUT[i] = Math.round(v);
}

// Q0.16 grid-point scale for u8 input. Note: we now want the Q0.16
// fractional weight at the END (after >>> 16), so:
//   pxFixed = input * gridPointsScale_q16
//   X0_idx  = pxFixed >>> 16
//   rx_q16  = pxFixed & 0xFFFF
const gridPointsScale_q16 = Math.round(((g1 - 1) << 16) / 255);

// Q0.15 variant for option C:
//   pxFixed = input * gridPointsScale_q15
//   X0_idx  = pxFixed >>> 15
//   rx_q15  = pxFixed & 0x7FFF
const gridPointsScale_q15 = Math.round(((g1 - 1) << 15) / 255);

console.log('=== u16-output LUTs ===');
console.log('  u15LUT length:                ' + u15LUT.length + ' (' + (u15LUT.byteLength / 1024).toFixed(1) + ' KB)');
console.log('  gridPointsScale_q16 (Q0.16):  ' + gridPointsScale_q16);
console.log('  gridPointsScale_q15 (Q0.15):  ' + gridPointsScale_q15);
console.log('');

// ----------------------------------------------------------------------
// 2b. Output buffers
// ----------------------------------------------------------------------

const outputFloatU16     = new Uint16Array(PIXEL_COUNT * CHANNELS_OUT);
const outputIntU15LUT    = new Uint16Array(PIXEL_COUNT * CHANNELS_OUT);
const outputIntDiffShift = new Uint16Array(PIXEL_COUNT * CHANNELS_OUT);
const outputIntQ15w      = new Uint16Array(PIXEL_COUNT * CHANNELS_OUT);

// ----------------------------------------------------------------------
// 2c. Float reference for u16 output — reuse kernelFloat with a clone
//     of floatLut whose outputScale = 65535 instead of 255.
// ----------------------------------------------------------------------

const floatLutU16 = Object.assign({}, floatLut, {
    outputScale: floatLut.outputScale * (65535 / 255),  // 255 → 65535
});

// ----------------------------------------------------------------------
// 2d. Option A — Q0.16 weights × u15 LUT
//
//     Math.imul max:  32767 * 65535 = 2,147,418,113   (fits, ~65k margin)
//     Sum-of-3 max:   32767 * 65536 = 2,147,483,648   (= 2^31 exactly,
//       but only reached when all 3 diffs hit ±max and weights sum to
//       exactly 1.0 — unreachable in practice for tetrahedral interp,
//       which has weights summing to ≤ 1).
//     Output:        scale u15 result back to u16 by `<< 1`.
// ----------------------------------------------------------------------

function kernelInt_u15LUT(input, output, length, lut) {
    var rx = 0|0, ry = 0|0, rz = 0|0;
    var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0;
    var px = 0|0, py = 0|0, pz = 0|0;
    var input0 = 0|0, input1 = 0|0, input2 = 0|0;
    var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
    var c0 = 0|0, c1 = 0|0, c2 = 0|0, a = 0|0, b = 0|0;

    var gps = lut.gridPointsScale_q16 | 0;
    var CLUT = lut.CLUT;
    var go0 = lut.go0|0, go1 = lut.go1|0, go2 = lut.go2|0;
    var maxX = Math.imul(lut.g1 - 1, go2)|0;
    var maxY = Math.imul(lut.g1 - 1, go1)|0;
    var maxZ = Math.imul(lut.g1 - 1, go0)|0;

    var inputPos = 0|0, outputPos = 0|0;

    for (var p = 0; p < length; p++) {
        input0 = input[inputPos++];
        input1 = input[inputPos++];
        input2 = input[inputPos++];

        // Q0.16 grid coord. Math.imul(255, ~8224) ≈ 2.1M, fits.
        px = Math.imul(input0, gps);
        py = Math.imul(input1, gps);
        pz = Math.imul(input2, gps);

        if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
        else { X0 = px >>> 16; rx = px & 0xFFFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

        if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
        else { Y0 = py >>> 16; ry = py & 0xFFFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

        if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
        else { Z0 = pz >>> 16; rz = pz & 0xFFFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

        base1 = X0 + Y0 + Z0;
        c0 = CLUT[base1++]; c1 = CLUT[base1++]; c2 = CLUT[base1];

        // Each Math.imul: max |diff| × max weight = 32767 × 65535 = 2.147B
        // Sum of 3:       bounded by output_range × 2^16 ≤ 32767 × 65536
        // Final shift:    +0x8000 bias for round-to-nearest, then >> 16
        // Then `<< 1` to expand u15 result back to u16 range.
        if (rx >= ry && ry >= rz) {
            base1 = X1 + Y0 + Z0; base2 = X1 + Y1 + Z0; base4 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = (c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x8000) >> 16)) << 1;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = (c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x8000) >> 16)) << 1;
            a = CLUT[base1];   b = CLUT[base2];
            output[outputPos++] = (c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x8000) >> 16)) << 1;
        } else if (rx >= rz && rz >= ry) {
            base1 = X1 + Y0 + Z0; base2 = X1 + Y1 + Z1; base3 = X1 + Y0 + Z1;
            a = CLUT[base3++]; b = CLUT[base1++];
            output[outputPos++] = (c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x8000) >> 16)) << 1;
            a = CLUT[base3++]; b = CLUT[base1++];
            output[outputPos++] = (c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x8000) >> 16)) << 1;
            a = CLUT[base3];   b = CLUT[base1];
            output[outputPos++] = (c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x8000) >> 16)) << 1;
        } else if (rx >= ry && rz >= rx) {
            base1 = X1 + Y0 + Z1; base2 = X0 + Y0 + Z1; base3 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = (c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x8000) >> 16)) << 1;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = (c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x8000) >> 16)) << 1;
            a = CLUT[base1];   b = CLUT[base2];
            output[outputPos++] = (c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c2, rz) + 0x8000) >> 16)) << 1;
        } else if (ry >= rx && rx >= rz) {
            base1 = X1 + Y1 + Z0; base2 = X0 + Y1 + Z0; base4 = X1 + Y1 + Z1;
            a = CLUT[base2++]; b = CLUT[base1++];
            output[outputPos++] = (c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x8000) >> 16)) << 1;
            a = CLUT[base2++]; b = CLUT[base1++];
            output[outputPos++] = (c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x8000) >> 16)) << 1;
            a = CLUT[base2];   b = CLUT[base1];
            output[outputPos++] = (c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x8000) >> 16)) << 1;
        } else if (ry >= rz && rz >= rx) {
            base1 = X1 + Y1 + Z1; base2 = X0 + Y1 + Z1; base3 = X0 + Y1 + Z0;
            a = CLUT[base2++]; b = CLUT[base3++];
            output[outputPos++] = (c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x8000) >> 16)) << 1;
            a = CLUT[base2++]; b = CLUT[base3++];
            output[outputPos++] = (c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x8000) >> 16)) << 1;
            a = CLUT[base2];   b = CLUT[base3];
            output[outputPos++] = (c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x8000) >> 16)) << 1;
        } else if (rz >= ry && ry >= rx) {
            base1 = X1 + Y1 + Z1; base2 = X0 + Y1 + Z1; base4 = X0 + Y0 + Z1;
            a = CLUT[base2++]; b = CLUT[base4++];
            output[outputPos++] = (c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x8000) >> 16)) << 1;
            a = CLUT[base2++]; b = CLUT[base4++];
            output[outputPos++] = (c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x8000) >> 16)) << 1;
            a = CLUT[base2];   b = CLUT[base4];
            output[outputPos++] = (c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x8000) >> 16)) << 1;
        } else {
            output[outputPos++] = c0 << 1;
            output[outputPos++] = c1 << 1;
            output[outputPos++] = c2 << 1;
        }
    }
}

// ----------------------------------------------------------------------
// 2e. Option B — Q0.16 weights × u16 LUT, with diff>>1 inside Math.imul
//
//     This is the user's "shift down at the mul" idea. Keeps the LUT
//     memory layout identical to the u16 case (no need to ship a
//     separate u15 LUT), and the base value c0 is read at full u16
//     precision — only the interpolation correction loses a bit.
//
//     Math.imul((a - c0) >> 1, rx_q16):
//       max ((a-c0)/2) × max rx_q16  =  32767 × 65535  =  2.147B  ✓
//
//     Sum recovery: because every term is halved before the multiply,
//     the sum is half of the true Q0.16 sum. To compensate, shift right
//     by 15 (not 16) at the end. Bias is 1<<14 = 0x4000.
//
//     Cost: 9 extra `>> 1` ops per pixel (3 channels × 3 multiplies).
//     Branch is predictable, shift is single-cycle on every CPU.
// ----------------------------------------------------------------------

function kernelInt_diffShift(input, output, length, lut) {
    var rx = 0|0, ry = 0|0, rz = 0|0;
    var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0;
    var px = 0|0, py = 0|0, pz = 0|0;
    var input0 = 0|0, input1 = 0|0, input2 = 0|0;
    var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
    var c0 = 0|0, c1 = 0|0, c2 = 0|0, a = 0|0, b = 0|0;

    var gps = lut.gridPointsScale_q16 | 0;
    var CLUT = lut.CLUT;
    var go0 = lut.go0|0, go1 = lut.go1|0, go2 = lut.go2|0;
    var maxX = Math.imul(lut.g1 - 1, go2)|0;
    var maxY = Math.imul(lut.g1 - 1, go1)|0;
    var maxZ = Math.imul(lut.g1 - 1, go0)|0;

    var inputPos = 0|0, outputPos = 0|0;

    for (var p = 0; p < length; p++) {
        input0 = input[inputPos++];
        input1 = input[inputPos++];
        input2 = input[inputPos++];

        px = Math.imul(input0, gps);
        py = Math.imul(input1, gps);
        pz = Math.imul(input2, gps);

        if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
        else { X0 = px >>> 16; rx = px & 0xFFFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

        if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
        else { Y0 = py >>> 16; ry = py & 0xFFFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

        if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
        else { Z0 = pz >>> 16; rz = pz & 0xFFFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

        base1 = X0 + Y0 + Z0;
        c0 = CLUT[base1++]; c1 = CLUT[base1++]; c2 = CLUT[base1];

        // Per-mul: ((diff) >> 1) × Q0.16_weight, sum 3, +bias, >> 15
        // c0 stays full u16; only the interpolation correction is lossy.
        if (rx >= ry && ry >= rz) {
            base1 = X1 + Y0 + Z0; base2 = X1 + Y1 + Z0; base4 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = c0 + ((Math.imul((a - c0) >> 1, rx) + Math.imul((b - a) >> 1, ry) + Math.imul((CLUT[base4++] - b) >> 1, rz) + 0x4000) >> 15);
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = c1 + ((Math.imul((a - c1) >> 1, rx) + Math.imul((b - a) >> 1, ry) + Math.imul((CLUT[base4++] - b) >> 1, rz) + 0x4000) >> 15);
            a = CLUT[base1];   b = CLUT[base2];
            output[outputPos++] = c2 + ((Math.imul((a - c2) >> 1, rx) + Math.imul((b - a) >> 1, ry) + Math.imul((CLUT[base4]   - b) >> 1, rz) + 0x4000) >> 15);
        } else if (rx >= rz && rz >= ry) {
            base1 = X1 + Y0 + Z0; base2 = X1 + Y1 + Z1; base3 = X1 + Y0 + Z1;
            a = CLUT[base3++]; b = CLUT[base1++];
            output[outputPos++] = c0 + ((Math.imul((b - c0) >> 1, rx) + Math.imul((CLUT[base2++] - a) >> 1, ry) + Math.imul((a - b) >> 1, rz) + 0x4000) >> 15);
            a = CLUT[base3++]; b = CLUT[base1++];
            output[outputPos++] = c1 + ((Math.imul((b - c1) >> 1, rx) + Math.imul((CLUT[base2++] - a) >> 1, ry) + Math.imul((a - b) >> 1, rz) + 0x4000) >> 15);
            a = CLUT[base3];   b = CLUT[base1];
            output[outputPos++] = c2 + ((Math.imul((b - c2) >> 1, rx) + Math.imul((CLUT[base2]   - a) >> 1, ry) + Math.imul((a - b) >> 1, rz) + 0x4000) >> 15);
        } else if (rx >= ry && rz >= rx) {
            base1 = X1 + Y0 + Z1; base2 = X0 + Y0 + Z1; base3 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = c0 + ((Math.imul((a - b) >> 1, rx) + Math.imul((CLUT[base3++] - a) >> 1, ry) + Math.imul((b - c0) >> 1, rz) + 0x4000) >> 15);
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = c1 + ((Math.imul((a - b) >> 1, rx) + Math.imul((CLUT[base3++] - a) >> 1, ry) + Math.imul((b - c1) >> 1, rz) + 0x4000) >> 15);
            a = CLUT[base1];   b = CLUT[base2];
            output[outputPos++] = c2 + ((Math.imul((a - b) >> 1, rx) + Math.imul((CLUT[base3]   - a) >> 1, ry) + Math.imul((b - c2) >> 1, rz) + 0x4000) >> 15);
        } else if (ry >= rx && rx >= rz) {
            base1 = X1 + Y1 + Z0; base2 = X0 + Y1 + Z0; base4 = X1 + Y1 + Z1;
            a = CLUT[base2++]; b = CLUT[base1++];
            output[outputPos++] = c0 + ((Math.imul((b - a) >> 1, rx) + Math.imul((a - c0) >> 1, ry) + Math.imul((CLUT[base4++] - b) >> 1, rz) + 0x4000) >> 15);
            a = CLUT[base2++]; b = CLUT[base1++];
            output[outputPos++] = c1 + ((Math.imul((b - a) >> 1, rx) + Math.imul((a - c1) >> 1, ry) + Math.imul((CLUT[base4++] - b) >> 1, rz) + 0x4000) >> 15);
            a = CLUT[base2];   b = CLUT[base1];
            output[outputPos++] = c2 + ((Math.imul((b - a) >> 1, rx) + Math.imul((a - c2) >> 1, ry) + Math.imul((CLUT[base4]   - b) >> 1, rz) + 0x4000) >> 15);
        } else if (ry >= rz && rz >= rx) {
            base1 = X1 + Y1 + Z1; base2 = X0 + Y1 + Z1; base3 = X0 + Y1 + Z0;
            a = CLUT[base2++]; b = CLUT[base3++];
            output[outputPos++] = c0 + ((Math.imul((CLUT[base1++] - a) >> 1, rx) + Math.imul((b - c0) >> 1, ry) + Math.imul((a - b) >> 1, rz) + 0x4000) >> 15);
            a = CLUT[base2++]; b = CLUT[base3++];
            output[outputPos++] = c1 + ((Math.imul((CLUT[base1++] - a) >> 1, rx) + Math.imul((b - c1) >> 1, ry) + Math.imul((a - b) >> 1, rz) + 0x4000) >> 15);
            a = CLUT[base2];   b = CLUT[base3];
            output[outputPos++] = c2 + ((Math.imul((CLUT[base1]   - a) >> 1, rx) + Math.imul((b - c2) >> 1, ry) + Math.imul((a - b) >> 1, rz) + 0x4000) >> 15);
        } else if (rz >= ry && ry >= rx) {
            base1 = X1 + Y1 + Z1; base2 = X0 + Y1 + Z1; base4 = X0 + Y0 + Z1;
            a = CLUT[base2++]; b = CLUT[base4++];
            output[outputPos++] = c0 + ((Math.imul((CLUT[base1++] - a) >> 1, rx) + Math.imul((a - b) >> 1, ry) + Math.imul((b - c0) >> 1, rz) + 0x4000) >> 15);
            a = CLUT[base2++]; b = CLUT[base4++];
            output[outputPos++] = c1 + ((Math.imul((CLUT[base1++] - a) >> 1, rx) + Math.imul((a - b) >> 1, ry) + Math.imul((b - c1) >> 1, rz) + 0x4000) >> 15);
            a = CLUT[base2];   b = CLUT[base4];
            output[outputPos++] = c2 + ((Math.imul((CLUT[base1]   - a) >> 1, rx) + Math.imul((a - b) >> 1, ry) + Math.imul((b - c2) >> 1, rz) + 0x4000) >> 15);
        } else {
            output[outputPos++] = c0;
            output[outputPos++] = c1;
            output[outputPos++] = c2;
        }
    }
}

// ----------------------------------------------------------------------
// 2f. Option C — Q0.15 weights × u16 LUT (the user's "shift up by 7 not 8")
//
//     Math.imul max:  65535 × 32767 = 2,147,418,113  (fits, but TIGHT)
//     Sum-of-3 worst case: 65535 × 32768 = 2^31 exactly.
//       Once the sum exceeds 2^31 - 1 it gets coerced to int32 by the
//       final `>> 15` and the sign bit wraps → wrong pixel value.
//       Probability is extremely low for natural data but NOT zero.
//
//     Bench treats this as exploratory: if the diff histogram against
//     float shows zero outliers, we know random pixels don't trip it,
//     but it would still be unsafe to ship without a synthetic
//     stress-test or a guarded `Math.fround`-style clamp.
// ----------------------------------------------------------------------

function kernelInt_q15weights(input, output, length, lut) {
    var rx = 0|0, ry = 0|0, rz = 0|0;
    var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0;
    var px = 0|0, py = 0|0, pz = 0|0;
    var input0 = 0|0, input1 = 0|0, input2 = 0|0;
    var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
    var c0 = 0|0, c1 = 0|0, c2 = 0|0, a = 0|0, b = 0|0;

    var gps = lut.gridPointsScale_q15 | 0;
    var CLUT = lut.CLUT;
    var go0 = lut.go0|0, go1 = lut.go1|0, go2 = lut.go2|0;
    var maxX = Math.imul(lut.g1 - 1, go2)|0;
    var maxY = Math.imul(lut.g1 - 1, go1)|0;
    var maxZ = Math.imul(lut.g1 - 1, go0)|0;

    var inputPos = 0|0, outputPos = 0|0;

    for (var p = 0; p < length; p++) {
        input0 = input[inputPos++];
        input1 = input[inputPos++];
        input2 = input[inputPos++];

        px = Math.imul(input0, gps);
        py = Math.imul(input1, gps);
        pz = Math.imul(input2, gps);

        if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
        else { X0 = px >>> 15; rx = px & 0x7FFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

        if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
        else { Y0 = py >>> 15; ry = py & 0x7FFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

        if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
        else { Z0 = pz >>> 15; rz = pz & 0x7FFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

        base1 = X0 + Y0 + Z0;
        c0 = CLUT[base1++]; c1 = CLUT[base1++]; c2 = CLUT[base1];

        // Bias 1<<14 = 0x4000 for Q0.15 round-to-nearest.
        if (rx >= ry && ry >= rz) {
            base1 = X1 + Y0 + Z0; base2 = X1 + Y1 + Z0; base4 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x4000) >> 15);
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x4000) >> 15);
            a = CLUT[base1];   b = CLUT[base2];
            output[outputPos++] = c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x4000) >> 15);
        } else if (rx >= rz && rz >= ry) {
            base1 = X1 + Y0 + Z0; base2 = X1 + Y1 + Z1; base3 = X1 + Y0 + Z1;
            a = CLUT[base3++]; b = CLUT[base1++];
            output[outputPos++] = c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x4000) >> 15);
            a = CLUT[base3++]; b = CLUT[base1++];
            output[outputPos++] = c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x4000) >> 15);
            a = CLUT[base3];   b = CLUT[base1];
            output[outputPos++] = c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x4000) >> 15);
        } else if (rx >= ry && rz >= rx) {
            base1 = X1 + Y0 + Z1; base2 = X0 + Y0 + Z1; base3 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x4000) >> 15);
            a = CLUT[base1++]; b = CLUT[base2++];
            output[outputPos++] = c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x4000) >> 15);
            a = CLUT[base1];   b = CLUT[base2];
            output[outputPos++] = c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c2, rz) + 0x4000) >> 15);
        } else if (ry >= rx && rx >= rz) {
            base1 = X1 + Y1 + Z0; base2 = X0 + Y1 + Z0; base4 = X1 + Y1 + Z1;
            a = CLUT[base2++]; b = CLUT[base1++];
            output[outputPos++] = c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x4000) >> 15);
            a = CLUT[base2++]; b = CLUT[base1++];
            output[outputPos++] = c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x4000) >> 15);
            a = CLUT[base2];   b = CLUT[base1];
            output[outputPos++] = c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x4000) >> 15);
        } else if (ry >= rz && rz >= rx) {
            base1 = X1 + Y1 + Z1; base2 = X0 + Y1 + Z1; base3 = X0 + Y1 + Z0;
            a = CLUT[base2++]; b = CLUT[base3++];
            output[outputPos++] = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x4000) >> 15);
            a = CLUT[base2++]; b = CLUT[base3++];
            output[outputPos++] = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x4000) >> 15);
            a = CLUT[base2];   b = CLUT[base3];
            output[outputPos++] = c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x4000) >> 15);
        } else if (rz >= ry && ry >= rx) {
            base1 = X1 + Y1 + Z1; base2 = X0 + Y1 + Z1; base4 = X0 + Y0 + Z1;
            a = CLUT[base2++]; b = CLUT[base4++];
            output[outputPos++] = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x4000) >> 15);
            a = CLUT[base2++]; b = CLUT[base4++];
            output[outputPos++] = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x4000) >> 15);
            a = CLUT[base2];   b = CLUT[base4];
            output[outputPos++] = c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x4000) >> 15);
        } else {
            output[outputPos++] = c0;
            output[outputPos++] = c1;
            output[outputPos++] = c2;
        }
    }
}

// ----------------------------------------------------------------------
// 2g. LUT params for the new kernels
// ----------------------------------------------------------------------

const intLut_u15LUT = {
    CLUT: u15LUT,
    g1: g1, go0: go0, go1: go1, go2: go2,
    gridPointsScale_q16: gridPointsScale_q16,
};
const intLut_u16_q16 = {
    CLUT: u16LUT,
    g1: g1, go0: go0, go1: go1, go2: go2,
    gridPointsScale_q16: gridPointsScale_q16,
};
const intLut_u16_q15 = {
    CLUT: u16LUT,
    g1: g1, go0: go0, go1: go1, go2: go2,
    gridPointsScale_q15: gridPointsScale_q15,
};

// ----------------------------------------------------------------------
// 2h. Accuracy — compare each int variant to the float u16 reference
// ----------------------------------------------------------------------

function diffStats(refBuf, testBuf, label) {
    let exact = 0, off1 = 0, off2 = 0, off3to15 = 0, off16to255 = 0, off256plus = 0;
    let maxDiff = 0, maxIdx = -1;
    let sumAbs = 0;
    for (let i = 0; i < refBuf.length; i++) {
        const d = Math.abs(refBuf[i] - testBuf[i]);
        sumAbs += d;
        if (d === 0) exact++;
        else if (d === 1) off1++;
        else if (d === 2) off2++;
        else if (d <= 15) off3to15++;
        else if (d <= 255) off16to255++;
        else off256plus++;
        if (d > maxDiff) { maxDiff = d; maxIdx = i; }
    }
    const total = refBuf.length;
    const pct = n => ((n / total) * 100).toFixed(2) + '%';
    console.log('  ' + label);
    console.log('    exact:           ' + exact + '  (' + pct(exact) + ')');
    console.log('    off by 1:        ' + off1 + '  (' + pct(off1) + ')');
    console.log('    off by 2:        ' + off2 + '  (' + pct(off2) + ')');
    console.log('    off by 3..15:    ' + off3to15 + '  (' + pct(off3to15) + ')');
    console.log('    off by 16..255:  ' + off16to255 + '  (' + pct(off16to255) + ')');
    console.log('    off by ≥256:     ' + off256plus + '  (' + pct(off256plus) + ')   ← overflow indicator');
    console.log('    max diff (u16):  ' + maxDiff + '  at idx ' + maxIdx + '  (' + (maxDiff / 65535 * 100).toFixed(4) + '% of full range)');
    console.log('    mean abs diff:   ' + (sumAbs / total).toFixed(3) + ' u16 units');
    // What would this look like after final >> 8 to u8?
    let u8maxDiff = 0;
    for (let i = 0; i < refBuf.length; i++) {
        const u8a = (refBuf[i] + 0x80) >> 8;
        const u8b = (testBuf[i] + 0x80) >> 8;
        const d = Math.abs(u8a - u8b);
        if (d > u8maxDiff) u8maxDiff = d;
    }
    console.log('    max diff after u16→u8:  ' + u8maxDiff + ' (this is what the eye sees)');
    return maxDiff;
}

console.log('=== Accuracy (vs float kernel writing u16) ===');
kernelFloat(input, outputFloatU16, PIXEL_COUNT, floatLutU16);
kernelInt_u15LUT(input,    outputIntU15LUT,    PIXEL_COUNT, intLut_u15LUT);
kernelInt_diffShift(input, outputIntDiffShift, PIXEL_COUNT, intLut_u16_q16);
kernelInt_q15weights(input, outputIntQ15w,     PIXEL_COUNT, intLut_u16_q15);

const maxDiff_u15LUT    = diffStats(outputFloatU16, outputIntU15LUT,    'A) u15 LUT  + Q0.16 weights:');
const maxDiff_diffShift = diffStats(outputFloatU16, outputIntDiffShift, 'B) u16 LUT  + Q0.16 + diff>>1:');
const maxDiff_q15w      = diffStats(outputFloatU16, outputIntQ15w,      'C) u16 LUT  + Q0.15 weights:');
console.log('');

// ----------------------------------------------------------------------
// 2i. Speed bench for u16 output
// ----------------------------------------------------------------------

function benchU16(name, fn, lut, scratch) {
    for (let i = 0; i < WARMUP_ITER; i++) fn(input, scratch, PIXEL_COUNT, lut);
    const samples = [];
    for (let r = 0; r < TIMED_RUNS; r++) {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < TIMED_ITER; i++) fn(input, scratch, PIXEL_COUNT, lut);
        const t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6 / TIMED_ITER);
    }
    samples.sort((a, b) => a - b);
    const median = samples[(samples.length / 2) | 0];
    const mpx = (PIXEL_COUNT / 1e6) / (median / 1000);
    console.log('  ' + name.padEnd(32) + median.toFixed(3) + ' ms/iter  →  ' + mpx.toFixed(2) + ' MPx/s   (samples: ' + samples.map(s => s.toFixed(2)).join(', ') + ')');
    return median;
}

console.log('=== Speed (u16 output, median of ' + TIMED_RUNS + ' × ' + TIMED_ITER + ' iter, warmup ' + WARMUP_ITER + ') ===');
const tFloatU16 = benchU16('Float kernel → u16:',           kernelFloat,         floatLutU16,    outputFloatU16);
const tIntA     = benchU16('A) u15 LUT + Q0.16:',           kernelInt_u15LUT,    intLut_u15LUT,  outputIntU15LUT);
const tIntB     = benchU16('B) u16 LUT + Q0.16 + diff>>1:', kernelInt_diffShift, intLut_u16_q16, outputIntDiffShift);
const tIntC     = benchU16('C) u16 LUT + Q0.15:',           kernelInt_q15weights, intLut_u16_q15, outputIntQ15w);
console.log('');

console.log('=== Speedup vs float u16 ===');
console.log('  A) u15 LUT      : ' + (tFloatU16 / tIntA).toFixed(2) + '×');
console.log('  B) diff>>1      : ' + (tFloatU16 / tIntB).toFixed(2) + '×');
console.log('  C) Q0.15 weights: ' + (tFloatU16 / tIntC).toFixed(2) + '×');
console.log('');

console.log('=== Section-2 verdict ===');
const winners = [
    { name: 'A (u15 LUT)',     speedup: tFloatU16/tIntA, maxDiff: maxDiff_u15LUT },
    { name: 'B (diff>>1)',     speedup: tFloatU16/tIntB, maxDiff: maxDiff_diffShift },
    { name: 'C (Q0.15 wgts)',  speedup: tFloatU16/tIntC, maxDiff: maxDiff_q15w },
];
winners.sort((a, b) => b.speedup - a.speedup);
for (const w of winners) {
    const safe = w.maxDiff < 256 ? '✓ safe' : '✗ corruption (overflow fired)';
    console.log('  ' + w.name.padEnd(20) + 'speedup ' + w.speedup.toFixed(2) + '×   max u16 diff ' + w.maxDiff + '   ' + safe);
}

// ======================================================================
// SECTION 3: Edge-case spot check
// ======================================================================
//
// The bulk diff histogram in Sections 1 and 2 averages over 65k pixels —
// a single outlier on a cube corner can hide inside "0.00% off by ≥3".
// This section prints every named edge case from EDGE_PIXELS through
// every kernel side-by-side so we can eyeball boundary behaviour.
//
// Format: input RGB, then float reference (the ground truth), then each
// int kernel as a delta from the float reference. A delta of (0,0,0)
// means the int kernel matched the float kernel exactly on that pixel.
//
// What to look for:
//   - white  (255,255,255) and any 255-containing corner: tests the
//     input===255 boundary patch. Without that patch, deltas here would
//     be in the hundreds or thousands.
//   - black  (0,0,0): tests the lower bound — should always be exact.
//   - mid-gray (128,128,128): tests "did I land on the right grid cell".
//   - asymmetric pixels: tests that each tetrahedral case branch was
//     ported correctly. If one specific case has a bug, only the
//     matching pixel in this set will show a delta.

console.log('');
console.log('======================================================================');
console.log('SECTION 3 — edge-case spot check');
console.log('======================================================================');
console.log('');

function fmt5(n) { return ('     ' + n).slice(-5); }
function fmt4s(n) {
    const s = (n >= 0 ? '+' : '') + n;
    return ('    ' + s).slice(-4);
}

// --- u8 output edge case table ---
console.log('=== u8 output (Section 1 kernel) ===');
console.log('  ' +
    'pixel'.padEnd(13) + 'input RGB        ' +
    'float u8 ref       ' +
    'int Δ (R, G, B)');
console.log('  ' + '─'.repeat(78));
for (let i = 0; i < EDGE_COUNT; i++) {
    const ec = EDGE_PIXELS[i];
    const o = i * 3;
    const fR = outputFloat[o], fG = outputFloat[o+1], fB = outputFloat[o+2];
    const iR = outputInt[o],   iG = outputInt[o+1],   iB = outputInt[o+2];
    console.log('  ' +
        ec.name + '  ' +
        '(' + fmt5(ec.rgb[0]) + ',' + fmt5(ec.rgb[1]) + ',' + fmt5(ec.rgb[2]) + ')   ' +
        '(' + fmt5(fR) + ',' + fmt5(fG) + ',' + fmt5(fB) + ')   ' +
        '(' + fmt4s(iR-fR) + ',' + fmt4s(iG-fG) + ',' + fmt4s(iB-fB) + ')');
}
console.log('');

// --- u16 output edge case table ---
console.log('=== u16 output (Section 2 kernels) — deltas vs float u16 ref ===');
console.log('  ' +
    'pixel'.padEnd(13) + 'input RGB        ' +
    'float u16 ref          ' +
    'A:u15LUT Δ          B:diff>>1 Δ        C:Q0.15 Δ');
console.log('  ' + '─'.repeat(115));
function fmtTriple(arr, o, ref) {
    return '(' + fmt4s(arr[o]-ref[o]) + ',' + fmt4s(arr[o+1]-ref[o+1]) + ',' + fmt4s(arr[o+2]-ref[o+2]) + ')';
}
for (let i = 0; i < EDGE_COUNT; i++) {
    const ec = EDGE_PIXELS[i];
    const o = i * 3;
    const fR = outputFloatU16[o], fG = outputFloatU16[o+1], fB = outputFloatU16[o+2];
    console.log('  ' +
        ec.name + '  ' +
        '(' + fmt5(ec.rgb[0]) + ',' + fmt5(ec.rgb[1]) + ',' + fmt5(ec.rgb[2]) + ')   ' +
        '(' + fmt5(fR) + ',' + fmt5(fG) + ',' + fmt5(fB) + ')      ' +
        fmtTriple(outputIntU15LUT,    o, outputFloatU16) + '    ' +
        fmtTriple(outputIntDiffShift, o, outputFloatU16) + '   ' +
        fmtTriple(outputIntQ15w,      o, outputFloatU16));
}
console.log('');

// --- specific assertions on the known-tricky cases ---
//
// These use a tolerance of ±1 LSB rather than exact equality because of
// FINDING #10 (LUT-build rounding differs between float and int paths
// for corner values that sit within ½ LSB of saturation). On u8 output
// the int kernel typically *does* match exactly, but we don't bake that
// into the assertion in case Q0.8 rounding produces a 1-LSB drift on a
// future profile.
const ABS_TOL_U8  = 1;
const ABS_TOL_U16 = 1;

console.log('=== Boundary assertions (tolerance: ±1 LSB) ===');
function assertEdgeWithin(label, idx, kernelOut, kernelName, refOut, tol) {
    const o = idx * 3;
    const dR = Math.abs(kernelOut[o]   - refOut[o]);
    const dG = Math.abs(kernelOut[o+1] - refOut[o+1]);
    const dB = Math.abs(kernelOut[o+2] - refOut[o+2]);
    const ok = dR <= tol && dG <= tol && dB <= tol;
    const lhs = '(' + kernelOut[o] + ',' + kernelOut[o+1] + ',' + kernelOut[o+2] + ')';
    const rhs = '(' + refOut[o]    + ',' + refOut[o+1]    + ',' + refOut[o+2]    + ')';
    const dlt = '(Δ' + (kernelOut[o]-refOut[o]) + ',' + (kernelOut[o+1]-refOut[o+1]) + ',' + (kernelOut[o+2]-refOut[o+2]) + ')';
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + kernelName.padEnd(18) + label.padEnd(18) + lhs.padEnd(22) + ' vs ref ' + rhs.padEnd(22) + ' ' + dlt);
}

const idxBlack = EDGE_PIXELS.findIndex(p => p.name.startsWith('black'));
const idxWhite = EDGE_PIXELS.findIndex(p => p.name.startsWith('white'));
const idxMidGray = EDGE_PIXELS.findIndex(p => p.name.startsWith('mid-gray'));

// Black (0,0,0): all-zero weights, just reads the (0,0,0) corner. Has
// to be exact (well, within tol) in every kernel — if it isn't, our
// per-axis initialisation or the X0/Y0/Z0 setup is wrong.
console.log('  black (0,0,0) — degenerate case, all weights zero, reads corner directly:');
assertEdgeWithin('black', idxBlack, outputInt,          'u8 int',    outputFloat,    ABS_TOL_U8);
assertEdgeWithin('black', idxBlack, outputIntU15LUT,    'u15LUT',    outputFloatU16, ABS_TOL_U16);
assertEdgeWithin('black', idxBlack, outputIntDiffShift, 'diff>>1',   outputFloatU16, ABS_TOL_U16);
assertEdgeWithin('black', idxBlack, outputIntQ15w,      'Q0.15w',    outputFloatU16, ABS_TOL_U16);

// White (255,255,255): canary for the input===255 boundary patch.
// Before the patch, deltas here were in the THOUSANDS (saturated input
// landed one grid below where it should). After the patch, deltas are
// at most ±1 LSB — and the residual is the build-time rounding noted
// in FINDING #10, not an interpolation problem.
console.log('  white (255,255,255) — input===255 boundary patch + LUT-build rounding:');
assertEdgeWithin('white', idxWhite, outputInt,          'u8 int',    outputFloat,    ABS_TOL_U8);
assertEdgeWithin('white', idxWhite, outputIntU15LUT,    'u15LUT',    outputFloatU16, ABS_TOL_U16);
assertEdgeWithin('white', idxWhite, outputIntDiffShift, 'diff>>1',   outputFloatU16, ABS_TOL_U16);
assertEdgeWithin('white', idxWhite, outputIntQ15w,      'Q0.15w',    outputFloatU16, ABS_TOL_U16);

// Mid-gray (128,128,128): tetrahedral case selection sanity. All 3
// weights equal → falls into the degenerate `else` branch in the
// kernel. If only this pixel is wrong, the degenerate fallback path
// has a bug. If only THIS one is right but everything else is off,
// the case-selection if/else chain is broken.
console.log('  mid-gray (128,128,128) — equal weights, degenerate-tetra branch:');
assertEdgeWithin('mid-gray', idxMidGray, outputInt,          'u8 int',    outputFloat,    ABS_TOL_U8);
assertEdgeWithin('mid-gray', idxMidGray, outputIntU15LUT,    'u15LUT',    outputFloatU16, ABS_TOL_U16);
assertEdgeWithin('mid-gray', idxMidGray, outputIntDiffShift, 'diff>>1',   outputFloatU16, ABS_TOL_U16);
assertEdgeWithin('mid-gray', idxMidGray, outputIntQ15w,      'Q0.15w',    outputFloatU16, ABS_TOL_U16);

console.log('');
console.log('  Diagnostic guide for failures:');
console.log('    ✗ on black                        → init / per-axis setup bug');
console.log('    ✗ on white but other pixels OK    → boundary patch regression');
console.log('    ✗ on white only (Δ ≤ 1)           → expected, see FINDING #10');
console.log('    ✗ on one mid-tone, others fine    → that tetrahedral case-branch is wrong');
console.log('    ✗ across the board                → kernel didn\'t compile / wrong LUT params');
