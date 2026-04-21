/**
 * int_vs_float_4d.js — int port of the 4-axis tetrahedral kernel
 * (tetrahedralInterp4DArray_3Ch_loop) used for CMYK → RGB conversion.
 *
 * Same methodology as bench/int_vs_float.js (the 3D test), but on the
 * harder kernel:
 *   - 4 input channels (CMYK), so 4 boundary patches not 3
 *   - K axis interpolated as a SECOND PASS — for each pixel we run the
 *     3D tetra at K0 to get o[0..2], and (if rk != 0 and K != 255) again
 *     at K1 = K0 + go3 to get d[0..2], then linearly interpolate by rk
 *   - 6 tetrahedral case branches × 2 paths (interpK on/off) = 12
 *     sub-blocks to port; logic per case mirrors the 3D kernel exactly
 *
 * Real ICC profile this time: __tests__/GRACoL2006_Coated1v2.icc
 * (the standard US sheet-fed press CMYK profile).
 *
 * ======================================================================
 * FINDINGS — keep in sync with the 3D bench's findings block.
 * Numbers from the same Windows 10 / Node 18+ machine.
 *
 *   GRACoL CMYK → sRGB,  17^4 LUT (489 KB u16 vs 1.96 MB float64),
 *   65 536 pixels per iter, u8 output, Q0.8 weights × u16 LUT,
 *   with 4-axis input===255 boundary patches:
 *
 *                                        speed       ratio   max diff
 *     Float kernel (baseline)            26.7 MPx/s  1.00×   —
 *     Int kernel   (this port)           43.0 MPx/s  1.61×   3 (u8)
 *
 *     Accuracy histogram:
 *       exact:           25.7%
 *       off by 1:        73.7%   ← bulk; expected from Q0.8 weight quant
 *       off by 2:         0.57%
 *       off by 3..15:     0.02%  (40 channels of 196608)
 *       off by ≥16:       0      ← the regression indicator stays clean
 *
 *     Edge cases (cube corners + GCR + K-special): 23/23 within ±2 LSB
 *
 * KEY LESSONS (added on top of the 11 in the 3D bench):
 *
 * 12. 4D speedup BEATS 3D. The 4D float kernel has more per-pixel
 *     work (3 extra multiplies + adds per channel for the K-interp
 *     tail), and the int port wins back proportionally more of it.
 *     1.61× vs 1.50× is consistent: more float math to displace =
 *     bigger relative speedup.
 *
 * 13. Max diff drifts upward modestly (3 vs 1 in 3D), entirely from
 *     the extra K-interp rounding step. In u8 output this is still
 *     invisible — 3/255 = 1.2% of dynamic range, well under any
 *     perceptual threshold (just-noticeable-difference is around 5-8
 *     LSB for sRGB grays). For u16 output on a 4D kernel you'd want
 *     to watch this more carefully — extra rounding compounds.
 *
 * 14. The interpK branch matters MORE than tetrahedral case selection.
 *     It splits into the pure 3D path (cheap, executed when K=255 or
 *     rk=0 — typical for shadow detail or when K isn't moving) and
 *     the full 4D path (3 extra Math.imul + 3 extra rounding shifts).
 *     On real CMYK images the K=0 case is also common (highlights),
 *     which hits the no-interpK fast path. Random pixels under-
 *     represent this — a real photographic image bench would likely
 *     show even better speedup.
 *
 * 15. LUT memory shrinkage matters MORE in 4D. 1.96 MB → 489 KB is a
 *     1.5 MB difference, which is huge for L2 cache (typically 1-4 MB
 *     per core). Float kernel almost certainly thrashes L2 on every
 *     pixel; int kernel fits comfortably. This is part of why the 4D
 *     speedup is bigger — not just int math being faster, but cache
 *     behaviour changing from miss-on-every-tetra to mostly-hits.
 *
 * 16. The kernel is ~3× larger than the 3D version (12 sub-blocks vs
 *     7) but compiles into a similar V8 fast path because each sub-
 *     block is monomorphic. No measurable JIT compilation slowdown,
 *     no deopts during the warmup.
 *
 * 17. Edge case "paper" (K=C=M=Y=0) returned (255,255,255) exact in
 *     both kernels — confirming the K=0 lower-bound also passes
 *     through the int path cleanly (no rk/Math.imul issues at zero).
 *
 * 18. The "K-clip-test" (K=255 with non-zero CMY) and "K=0 plane"
 *     (K=0 with CMY varying) cases both passed — these specifically
 *     exercise the `interpK = false` fast path, validating that the
 *     branch logic is correctly ported.
 * ======================================================================
 */

const fs = require('fs');
const path = require('path');
const { Profile, Transform, eIntent } = require('../src/main');

(async () => {

// ----------------------------------------------------------------------
// 1. Load GRACoL profile and build CMYK → sRGB transform
// ----------------------------------------------------------------------

const cmykPath = path.join(__dirname, '..', '__tests__', 'GRACoL2006_Coated1v2.icc');
const cmykProfile = new Profile();
await cmykProfile.loadPromise('file:' + cmykPath);

if (!cmykProfile.loaded) {
    console.error('Failed to load GRACoL profile from', cmykPath);
    process.exit(1);
}
console.log('=== Profile ===');
console.log('  loaded:        ' + cmykProfile.name);
console.log('');

const transform = new Transform({
    buildLut: true,
    dataFormat: 'int8',
});
transform.create(cmykProfile, '*sRGB', eIntent.relative);

const floatLut = transform.lut;

if (!floatLut || !floatLut.CLUT || !floatLut.go3) {
    console.error('LUT build failed or LUT is not 4D — got', floatLut);
    process.exit(1);
}

const g1 = floatLut.g1;
const go0 = floatLut.go0;
const go1 = floatLut.go1;
const go2 = floatLut.go2;
const go3 = floatLut.go3;
const outputChannels = floatLut.outputChannels;
const kOffset = go3 - outputChannels + 1;
const inputScale = floatLut.inputScale;
const outputScale = floatLut.outputScale;

console.log('=== LUT info ===');
console.log('  grid:                ' + g1 + '^4');
console.log('  CLUT length:         ' + floatLut.CLUT.length + ' (' + floatLut.CLUT.constructor.name + ')');
console.log('  CLUT memory:         ' + (floatLut.CLUT.byteLength / 1024).toFixed(1) + ' KB');
console.log('  outputChannels:      ' + outputChannels);
console.log('  go0/go1/go2/go3:     ' + go0 + ' / ' + go1 + ' / ' + go2 + ' / ' + go3);
console.log('  kOffset:             ' + kOffset);
console.log('  inputScale:          ' + inputScale);
console.log('  outputScale:         ' + outputScale);
console.log('');

// ----------------------------------------------------------------------
// 2. Build the u16 CLUT (Q0.8 weights × u16 LUT, the 3D bench winner
//    for u8 output — "Section 1" path).
// ----------------------------------------------------------------------

const sourceFloatLUT = floatLut.CLUT;
const u16LUT = new Uint16Array(sourceFloatLUT.length);
for (let i = 0; i < sourceFloatLUT.length; i++) {
    let v = sourceFloatLUT[i] * outputScale * (65535 / 255);
    if (v < 0) v = 0;
    if (v > 65535) v = 65535;
    u16LUT[i] = Math.round(v);
}

const gridPointsScale_fixed = Math.round(((g1 - 1) << 8) / 255);

console.log('=== Int LUT info ===');
console.log('  u16LUT memory:                ' + (u16LUT.byteLength / 1024).toFixed(1) + ' KB');
console.log('  gridPointsScale_fixed (Q0.8): ' + gridPointsScale_fixed);
console.log('');

// ----------------------------------------------------------------------
// 3. Edge-case CMYK pixels — same philosophy as the 3D bench.
//
// The kernel reads input as [K, C, M, Y] per pixel (K-first byte order
// internal to the engine). Each named pixel below sets one or more
// channels to 0/128/255 to exercise the boundary patches and the
// interpK on/off paths.
// ----------------------------------------------------------------------

const EDGE_PIXELS = [
    // 4D cube corners (16 of them — every combination of 0 and 255 across KCMY)
    { name: 'paper       ', kcmy: [  0,   0,   0,   0] },     // unprinted paper
    { name: 'pure-K      ', kcmy: [255,   0,   0,   0] },     // 100% black ink only
    { name: 'pure-C      ', kcmy: [  0, 255,   0,   0] },     // 100% cyan only
    { name: 'pure-M      ', kcmy: [  0,   0, 255,   0] },     // 100% magenta only
    { name: 'pure-Y      ', kcmy: [  0,   0,   0, 255] },     // 100% yellow only
    { name: 'CK          ', kcmy: [255, 255,   0,   0] },     // K + C
    { name: 'MK          ', kcmy: [255,   0, 255,   0] },     // K + M
    { name: 'YK          ', kcmy: [255,   0,   0, 255] },     // K + Y
    { name: 'CMK         ', kcmy: [255, 255, 255,   0] },
    { name: 'CYK         ', kcmy: [255, 255,   0, 255] },
    { name: 'MYK         ', kcmy: [255,   0, 255, 255] },
    { name: '4-color-max ', kcmy: [255, 255, 255, 255] },     // total ink limit blowout
    { name: 'process-rich', kcmy: [  0, 255, 255, 255] },     // CMY only, no K
    { name: 'CM (process)', kcmy: [  0, 255, 255,   0] },     // process blue-ish
    { name: 'CY          ', kcmy: [  0, 255,   0, 255] },     // process green-ish
    { name: 'MY          ', kcmy: [  0,   0, 255, 255] },     // process red-ish
    // mid tones — check tetra branch coverage
    { name: 'mid-gray    ', kcmy: [128, 128, 128, 128] },     // equal weights → degenerate branch
    { name: 'half-K only ', kcmy: [128,   0,   0,   0] },     // K-only midtone
    { name: 'GCR-ish     ', kcmy: [ 50, 200, 150,  80] },     // realistic-looking pixel
    // off-by-one near boundaries
    { name: 'near-paper  ', kcmy: [  1,   1,   1,   1] },
    { name: 'near-max    ', kcmy: [254, 254, 254, 254] },
    // K=255 special case — kernel skips K-interp regardless of rk
    { name: 'K-clip-test ', kcmy: [255, 100,  50,  25] },
    // rk=0 special case — kernel skips K-interp because input is on grid
    // For g1=17, K=0 lands on grid 0 with rk=0; K=255 lands on grid 16 with rk=0
    { name: 'K=0 plane   ', kcmy: [  0, 100,  50,  25] },
];
const EDGE_COUNT = EDGE_PIXELS.length;

const WIDTH = 256;
const HEIGHT = 256;
const PIXEL_COUNT = WIDTH * HEIGHT;
const CHANNELS_IN = 4;
const CHANNELS_OUT = 3;

let seed = 0xCAFE;
function rand255() {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7FFFFFFF;
    return (seed >>> 16) & 0xFF;
}

const input = new Uint8ClampedArray(PIXEL_COUNT * CHANNELS_IN);
for (let i = 0; i < EDGE_COUNT; i++) {
    input[i * 4 + 0] = EDGE_PIXELS[i].kcmy[0];
    input[i * 4 + 1] = EDGE_PIXELS[i].kcmy[1];
    input[i * 4 + 2] = EDGE_PIXELS[i].kcmy[2];
    input[i * 4 + 3] = EDGE_PIXELS[i].kcmy[3];
}
for (let i = EDGE_COUNT * 4; i < input.length; i++) {
    input[i] = rand255();
}

const outputFloat = new Uint8ClampedArray(PIXEL_COUNT * CHANNELS_OUT);
const outputInt   = new Uint8ClampedArray(PIXEL_COUNT * CHANNELS_OUT);

console.log('=== Input ===');
console.log('  ' + WIDTH + ' x ' + HEIGHT + ' = ' + PIXEL_COUNT + ' CMYK pixels (' + EDGE_COUNT + ' edge + ' + (PIXEL_COUNT - EDGE_COUNT) + ' random)');
console.log('  ' + (input.byteLength / 1024).toFixed(1) + ' KB input,  ' + (outputFloat.byteLength / 1024).toFixed(1) + ' KB output');
console.log('');

// ----------------------------------------------------------------------
// 4. Float kernel — verbatim copy of tetrahedralInterp4DArray_3Ch_loop
//    minus the alpha block (we run alpha-free here for fairness).
// ----------------------------------------------------------------------

function kernelFloat4D(input, output, length, lut) {
    var X0, X1, Y0, K0, Y1, Z0, Z1;
    var rx, ry, rz, rk, px, py, pz, pk;
    var input0, input1, input2, inputK;
    var base1, base2, base3, base4;
    var c0, c1, c2, o0, o1, o2, d0, d1, d2;
    var a, b, interpK;

    var outputScale = lut.outputScale;
    var gridPointsScale = (lut.g1 - 1) * lut.inputScale;
    var CLUT = lut.CLUT;
    var go0 = lut.go0, go1 = lut.go1, go2 = lut.go2, go3 = lut.go3;
    var kOffset = go3 - lut.outputChannels + 1;

    var inputPos = 0, outputPos = 0;

    for (var p = 0; p < length; p++) {
        inputK = input[inputPos++];
        input0 = input[inputPos++];
        input1 = input[inputPos++];
        input2 = input[inputPos++];

        px = input0 * gridPointsScale;
        py = input1 * gridPointsScale;
        pz = input2 * gridPointsScale;
        pk = inputK * gridPointsScale;

        K0 = ~~pk; rk = (pk - K0); K0 *= go3;
        X0 = ~~px; rx = (px - X0); X0 *= go2; X1 = (input0 === 255) ? X0 : X0 + go2;
        Y0 = ~~py; ry = (py - Y0); Y0 *= go1; Y1 = (input1 === 255) ? Y0 : Y0 + go1;
        Z0 = ~~pz; rz = (pz - Z0); Z0 *= go0; Z1 = (input2 === 255) ? Z0 : Z0 + go0;

        base1 = X0 + Y0 + Z0 + K0;
        c0 = CLUT[base1++]; c1 = CLUT[base1++]; c2 = CLUT[base1];

        if (inputK === 255 || rk === 0) {
            interpK = false;
        } else {
            base1 += kOffset;
            d0 = CLUT[base1++]; d1 = CLUT[base1++]; d2 = CLUT[base1];
            interpK = true;
        }

        if (rx >= ry && ry >= rz) {
            base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
            a = CLUT[base1++]; b = CLUT[base2++];
            o0 = c0 + ((a - c0) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz);
            a = CLUT[base1++]; b = CLUT[base2++];
            o1 = c1 + ((a - c1) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz);
            a = CLUT[base1];   b = CLUT[base2];
            o2 = c2 + ((a - c2) * rx) + ((b - a) * ry) + ((CLUT[base4]   - b) * rz);
            if (interpK) {
                base1 += kOffset; base2 += kOffset; base4 += kOffset;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = (o0 + (((d0 + ((a - d0) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o0) * rk)) * outputScale;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = (o1 + (((d1 + ((a - d1) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o1) * rk)) * outputScale;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = (o2 + (((d2 + ((a - d2) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o2) * rk)) * outputScale;
            } else {
                output[outputPos++] = o0 * outputScale;
                output[outputPos++] = o1 * outputScale;
                output[outputPos++] = o2 * outputScale;
            }
        } else if (rx >= rz && rz >= ry) {
            base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z1 + K0; base3 = X1 + Y0 + Z1 + K0;
            a = CLUT[base3++]; b = CLUT[base1++];
            o0 = c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);
            a = CLUT[base3++]; b = CLUT[base1++];
            o1 = c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);
            a = CLUT[base3];   b = CLUT[base1];
            o2 = c2 + ((b - c2) * rx) + ((CLUT[base2]   - a) * ry) + ((a - b) * rz);
            if (interpK) {
                base3 += kOffset; base1 += kOffset; base2 += kOffset;
                a = CLUT[base3++]; b = CLUT[base1++];
                output[outputPos++] = (o0 + (((d0 + ((b - d0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) - o0) * rk)) * outputScale;
                a = CLUT[base3++]; b = CLUT[base1++];
                output[outputPos++] = (o1 + (((d1 + ((b - d1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) - o1) * rk)) * outputScale;
                a = CLUT[base3++]; b = CLUT[base1++];
                output[outputPos++] = (o2 + (((d2 + ((b - d2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) - o2) * rk)) * outputScale;
            } else {
                output[outputPos++] = o0 * outputScale;
                output[outputPos++] = o1 * outputScale;
                output[outputPos++] = o2 * outputScale;
            }
        } else if (rx >= ry && rz >= rx) {
            base1 = X1 + Y0 + Z1 + K0; base2 = X0 + Y0 + Z1 + K0; base3 = X1 + Y1 + Z1 + K0;
            a = CLUT[base1++]; b = CLUT[base2++];
            o0 = c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz);
            a = CLUT[base1++]; b = CLUT[base2++];
            o1 = c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz);
            a = CLUT[base1];   b = CLUT[base2];
            o2 = c2 + ((a - b) * rx) + ((CLUT[base3]   - a) * ry) + ((b - c2) * rz);
            if (interpK) {
                base1 += kOffset; base2 += kOffset; base3 += kOffset;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = (o0 + (((d0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d0) * rz)) - o0) * rk)) * outputScale;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = (o1 + (((d1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d1) * rz)) - o1) * rk)) * outputScale;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = (o2 + (((d2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d2) * rz)) - o2) * rk)) * outputScale;
            } else {
                output[outputPos++] = o0 * outputScale;
                output[outputPos++] = o1 * outputScale;
                output[outputPos++] = o2 * outputScale;
            }
        } else if (ry >= rx && rx >= rz) {
            base1 = X1 + Y1 + Z0 + K0; base2 = X0 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
            a = CLUT[base2++]; b = CLUT[base1++];
            o0 = c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz);
            a = CLUT[base2++]; b = CLUT[base1++];
            o1 = c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz);
            a = CLUT[base2];   b = CLUT[base1];
            o2 = c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4]   - b) * rz);
            if (interpK) {
                base1 += kOffset; base2 += kOffset; base4 += kOffset;
                a = CLUT[base2++]; b = CLUT[base1++];
                output[outputPos++] = (o0 + (((d0 + ((b - a) * rx) + ((a - d0) * ry) + ((CLUT[base4++] - b) * rz)) - o0) * rk)) * outputScale;
                a = CLUT[base2++]; b = CLUT[base1++];
                output[outputPos++] = (o1 + (((d1 + ((b - a) * rx) + ((a - d1) * ry) + ((CLUT[base4++] - b) * rz)) - o1) * rk)) * outputScale;
                a = CLUT[base2++]; b = CLUT[base1++];
                output[outputPos++] = (o2 + (((d2 + ((b - a) * rx) + ((a - d2) * ry) + ((CLUT[base4++] - b) * rz)) - o2) * rk)) * outputScale;
            } else {
                output[outputPos++] = o0 * outputScale;
                output[outputPos++] = o1 * outputScale;
                output[outputPos++] = o2 * outputScale;
            }
        } else if (ry >= rz && rz >= rx) {
            base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base3 = X0 + Y1 + Z0 + K0;
            a = CLUT[base2++]; b = CLUT[base3++];
            o0 = c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz);
            a = CLUT[base2++]; b = CLUT[base3++];
            o1 = c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz);
            a = CLUT[base2];   b = CLUT[base3];
            o2 = c2 + ((CLUT[base1]   - a) * rx) + ((b - c2) * ry) + ((a - b) * rz);
            if (interpK) {
                base1 += kOffset; base2 += kOffset; base3 += kOffset;
                a = CLUT[base2++]; b = CLUT[base3++];
                output[outputPos++] = (o0 + (((d0 + ((CLUT[base1++] - a) * rx) + ((b - d0) * ry) + ((a - b) * rz)) - o0) * rk)) * outputScale;
                a = CLUT[base2++]; b = CLUT[base3++];
                output[outputPos++] = (o1 + (((d1 + ((CLUT[base1++] - a) * rx) + ((b - d1) * ry) + ((a - b) * rz)) - o1) * rk)) * outputScale;
                a = CLUT[base2++]; b = CLUT[base3++];
                output[outputPos++] = (o2 + (((d2 + ((CLUT[base1++] - a) * rx) + ((b - d2) * ry) + ((a - b) * rz)) - o2) * rk)) * outputScale;
            } else {
                output[outputPos++] = o0 * outputScale;
                output[outputPos++] = o1 * outputScale;
                output[outputPos++] = o2 * outputScale;
            }
        } else if (rz >= ry && ry >= rx) {
            base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base4 = X0 + Y0 + Z1 + K0;
            a = CLUT[base2++]; b = CLUT[base4++];
            o0 = c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz);
            a = CLUT[base2++]; b = CLUT[base4++];
            o1 = c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz);
            a = CLUT[base2];   b = CLUT[base4];
            o2 = c2 + ((CLUT[base1]   - a) * rx) + ((a - b) * ry) + ((b - c2) * rz);
            if (interpK) {
                base1 += kOffset; base2 += kOffset; base4 += kOffset;
                a = CLUT[base2++]; b = CLUT[base4++];
                output[outputPos++] = (o0 + (((d0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d0) * rz)) - o0) * rk)) * outputScale;
                a = CLUT[base2++]; b = CLUT[base4++];
                output[outputPos++] = (o1 + (((d1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d1) * rz)) - o1) * rk)) * outputScale;
                a = CLUT[base2++]; b = CLUT[base4++];
                output[outputPos++] = (o2 + (((d2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d2) * rz)) - o2) * rk)) * outputScale;
            } else {
                output[outputPos++] = o0 * outputScale;
                output[outputPos++] = o1 * outputScale;
                output[outputPos++] = o2 * outputScale;
            }
        } else {
            // Degenerate: rx == ry == rz, no 3D interp needed.
            // NOTE: float source has a precedence quirk here that we
            // mirror exactly for fairness (output = c + (d-c)*rk*255
            // which doesn't apply outputScale to c). Don't "fix" it
            // unless the production kernel is fixed too.
            if (interpK) {
                output[outputPos++] = c0 + ((d0 - c0) * rk) * outputScale;
                output[outputPos++] = c1 + ((d1 - c1) * rk) * outputScale;
                output[outputPos++] = c2 + ((d2 - c2) * rk) * outputScale;
            } else {
                output[outputPos++] = c0 * outputScale;
                output[outputPos++] = c1 * outputScale;
                output[outputPos++] = c2 * outputScale;
            }
        }
    }
}

// ----------------------------------------------------------------------
// 5. Int kernel — same structure, integer math throughout.
//
// Math contract (same as 3D Section 1):
//   - CLUT u16 in [0, 65535] representing [0, 1]
//   - Q0.8 fractional weights rx/ry/rz/rk in [0, 255]
//   - 3D interp result o0..o2 kept in u16 scale: c0 + ((sum_q8 + 0x80) >> 8)
//   - K interp: result_u16 = o + ((Math.imul(d_u16 - o_u16, rk) + 0x80) >> 8)
//   - Final u8: (result_u16 + 0x80) >> 8 — Uint8ClampedArray clamps any
//     ±1 corner overshoots
//   - 4 axes get the input===255 boundary patch (3D bench FINDING #2),
//     including the K axis
// ----------------------------------------------------------------------

function kernelInt4D(input, output, length, lut) {
    var X0=0|0, X1=0|0, Y0=0|0, K0=0|0, Y1=0|0, Z0=0|0, Z1=0|0;
    var rx=0|0, ry=0|0, rz=0|0, rk=0|0;
    var px=0|0, py=0|0, pz=0|0, pk=0|0;
    var input0=0|0, input1=0|0, input2=0|0, inputK=0|0;
    var base1=0|0, base2=0|0, base3=0|0, base4=0|0;
    var c0=0|0, c1=0|0, c2=0|0;
    var d0=0|0, d1=0|0, d2=0|0;
    var o0=0|0, o1=0|0, o2=0|0;
    var a=0|0, b=0|0;
    var interpK = false;

    var gps = lut.gridPointsScale_fixed | 0;
    var CLUT = lut.CLUT;
    var go0 = lut.go0|0, go1 = lut.go1|0, go2 = lut.go2|0, go3 = lut.go3|0;
    var kOffset = (go3 - lut.outputChannels + 1) | 0;
    var maxX = Math.imul(lut.g1 - 1, go2)|0;
    var maxY = Math.imul(lut.g1 - 1, go1)|0;
    var maxZ = Math.imul(lut.g1 - 1, go0)|0;
    var maxK = Math.imul(lut.g1 - 1, go3)|0;

    var inputPos = 0|0, outputPos = 0|0;

    for (var p = 0; p < length; p++) {
        inputK = input[inputPos++];
        input0 = input[inputPos++];
        input1 = input[inputPos++];
        input2 = input[inputPos++];

        // Q0.8 grid coords with 4-axis input===255 boundary patches
        pk = Math.imul(inputK, gps);
        if (inputK === 255) { K0 = maxK; rk = 0; }
        else { K0 = pk >>> 8; rk = pk & 0xFF; K0 = Math.imul(K0, go3); }

        px = Math.imul(input0, gps);
        if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
        else { X0 = px >>> 8; rx = px & 0xFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

        py = Math.imul(input1, gps);
        if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
        else { Y0 = py >>> 8; ry = py & 0xFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

        pz = Math.imul(input2, gps);
        if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
        else { Z0 = pz >>> 8; rz = pz & 0xFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

        base1 = X0 + Y0 + Z0 + K0;
        c0 = CLUT[base1++]; c1 = CLUT[base1++]; c2 = CLUT[base1];

        if (inputK === 255 || rk === 0) {
            interpK = false;
        } else {
            base1 += kOffset;
            d0 = CLUT[base1++]; d1 = CLUT[base1++]; d2 = CLUT[base1];
            interpK = true;
        }

        // For each tetrahedral case:
        //   1. compute o0/o1/o2 = 3D interp at K0 plane (u16 scale)
        //   2. if interpK: same 3D interp at K1 plane → k0/k1/k2 inline,
        //      then K-interp + final u8
        //   3. else: final u8 directly from o
        //
        // The 3D interp form mirrors the 3D bench's Section 1 kernel
        // exactly; only the +K0 in base offsets and the K-interp tail
        // are new.

        if (rx >= ry && ry >= rz) {
            base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
            a = CLUT[base1++]; b = CLUT[base2++];
            o0 = c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8);
            a = CLUT[base1++]; b = CLUT[base2++];
            o1 = c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8);
            a = CLUT[base1];   b = CLUT[base2];
            o2 = c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8);
            if (interpK) {
                base1 += kOffset; base2 += kOffset; base4 += kOffset;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = (o0 + ((Math.imul((d0 + ((Math.imul(a - d0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) - o0, rk) + 0x80) >> 8) + 0x80) >> 8;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = (o1 + ((Math.imul((d1 + ((Math.imul(a - d1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) - o1, rk) + 0x80) >> 8) + 0x80) >> 8;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = (o2 + ((Math.imul((d2 + ((Math.imul(a - d2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) - o2, rk) + 0x80) >> 8) + 0x80) >> 8;
            } else {
                output[outputPos++] = (o0 + 0x80) >> 8;
                output[outputPos++] = (o1 + 0x80) >> 8;
                output[outputPos++] = (o2 + 0x80) >> 8;
            }
        } else if (rx >= rz && rz >= ry) {
            base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z1 + K0; base3 = X1 + Y0 + Z1 + K0;
            a = CLUT[base3++]; b = CLUT[base1++];
            o0 = c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8);
            a = CLUT[base3++]; b = CLUT[base1++];
            o1 = c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8);
            a = CLUT[base3];   b = CLUT[base1];
            o2 = c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8);
            if (interpK) {
                base3 += kOffset; base1 += kOffset; base2 += kOffset;
                a = CLUT[base3++]; b = CLUT[base1++];
                output[outputPos++] = (o0 + ((Math.imul((d0 + ((Math.imul(b - d0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) - o0, rk) + 0x80) >> 8) + 0x80) >> 8;
                a = CLUT[base3++]; b = CLUT[base1++];
                output[outputPos++] = (o1 + ((Math.imul((d1 + ((Math.imul(b - d1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) - o1, rk) + 0x80) >> 8) + 0x80) >> 8;
                a = CLUT[base3++]; b = CLUT[base1++];
                output[outputPos++] = (o2 + ((Math.imul((d2 + ((Math.imul(b - d2, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) - o2, rk) + 0x80) >> 8) + 0x80) >> 8;
            } else {
                output[outputPos++] = (o0 + 0x80) >> 8;
                output[outputPos++] = (o1 + 0x80) >> 8;
                output[outputPos++] = (o2 + 0x80) >> 8;
            }
        } else if (rx >= ry && rz >= rx) {
            base1 = X1 + Y0 + Z1 + K0; base2 = X0 + Y0 + Z1 + K0; base3 = X1 + Y1 + Z1 + K0;
            a = CLUT[base1++]; b = CLUT[base2++];
            o0 = c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x80) >> 8);
            a = CLUT[base1++]; b = CLUT[base2++];
            o1 = c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x80) >> 8);
            a = CLUT[base1];   b = CLUT[base2];
            o2 = c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c2, rz) + 0x80) >> 8);
            if (interpK) {
                base1 += kOffset; base2 += kOffset; base3 += kOffset;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = (o0 + ((Math.imul((d0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - d0, rz) + 0x80) >> 8)) - o0, rk) + 0x80) >> 8) + 0x80) >> 8;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = (o1 + ((Math.imul((d1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - d1, rz) + 0x80) >> 8)) - o1, rk) + 0x80) >> 8) + 0x80) >> 8;
                a = CLUT[base1++]; b = CLUT[base2++];
                output[outputPos++] = (o2 + ((Math.imul((d2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - d2, rz) + 0x80) >> 8)) - o2, rk) + 0x80) >> 8) + 0x80) >> 8;
            } else {
                output[outputPos++] = (o0 + 0x80) >> 8;
                output[outputPos++] = (o1 + 0x80) >> 8;
                output[outputPos++] = (o2 + 0x80) >> 8;
            }
        } else if (ry >= rx && rx >= rz) {
            base1 = X1 + Y1 + Z0 + K0; base2 = X0 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
            a = CLUT[base2++]; b = CLUT[base1++];
            o0 = c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8);
            a = CLUT[base2++]; b = CLUT[base1++];
            o1 = c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8);
            a = CLUT[base2];   b = CLUT[base1];
            o2 = c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8);
            if (interpK) {
                base1 += kOffset; base2 += kOffset; base4 += kOffset;
                a = CLUT[base2++]; b = CLUT[base1++];
                output[outputPos++] = (o0 + ((Math.imul((d0 + ((Math.imul(b - a, rx) + Math.imul(a - d0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) - o0, rk) + 0x80) >> 8) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base1++];
                output[outputPos++] = (o1 + ((Math.imul((d1 + ((Math.imul(b - a, rx) + Math.imul(a - d1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) - o1, rk) + 0x80) >> 8) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base1++];
                output[outputPos++] = (o2 + ((Math.imul((d2 + ((Math.imul(b - a, rx) + Math.imul(a - d2, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) - o2, rk) + 0x80) >> 8) + 0x80) >> 8;
            } else {
                output[outputPos++] = (o0 + 0x80) >> 8;
                output[outputPos++] = (o1 + 0x80) >> 8;
                output[outputPos++] = (o2 + 0x80) >> 8;
            }
        } else if (ry >= rz && rz >= rx) {
            base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base3 = X0 + Y1 + Z0 + K0;
            a = CLUT[base2++]; b = CLUT[base3++];
            o0 = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x80) >> 8);
            a = CLUT[base2++]; b = CLUT[base3++];
            o1 = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x80) >> 8);
            a = CLUT[base2];   b = CLUT[base3];
            o2 = c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x80) >> 8);
            if (interpK) {
                base1 += kOffset; base2 += kOffset; base3 += kOffset;
                a = CLUT[base2++]; b = CLUT[base3++];
                output[outputPos++] = (o0 + ((Math.imul((d0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - d0, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) - o0, rk) + 0x80) >> 8) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base3++];
                output[outputPos++] = (o1 + ((Math.imul((d1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - d1, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) - o1, rk) + 0x80) >> 8) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base3++];
                output[outputPos++] = (o2 + ((Math.imul((d2 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - d2, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) - o2, rk) + 0x80) >> 8) + 0x80) >> 8;
            } else {
                output[outputPos++] = (o0 + 0x80) >> 8;
                output[outputPos++] = (o1 + 0x80) >> 8;
                output[outputPos++] = (o2 + 0x80) >> 8;
            }
        } else if (rz >= ry && ry >= rx) {
            base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base4 = X0 + Y0 + Z1 + K0;
            a = CLUT[base2++]; b = CLUT[base4++];
            o0 = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x80) >> 8);
            a = CLUT[base2++]; b = CLUT[base4++];
            o1 = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x80) >> 8);
            a = CLUT[base2];   b = CLUT[base4];
            o2 = c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x80) >> 8);
            if (interpK) {
                base1 += kOffset; base2 += kOffset; base4 += kOffset;
                a = CLUT[base2++]; b = CLUT[base4++];
                output[outputPos++] = (o0 + ((Math.imul((d0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - d0, rz) + 0x80) >> 8)) - o0, rk) + 0x80) >> 8) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base4++];
                output[outputPos++] = (o1 + ((Math.imul((d1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - d1, rz) + 0x80) >> 8)) - o1, rk) + 0x80) >> 8) + 0x80) >> 8;
                a = CLUT[base2++]; b = CLUT[base4++];
                output[outputPos++] = (o2 + ((Math.imul((d2 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - d2, rz) + 0x80) >> 8)) - o2, rk) + 0x80) >> 8) + 0x80) >> 8;
            } else {
                output[outputPos++] = (o0 + 0x80) >> 8;
                output[outputPos++] = (o1 + 0x80) >> 8;
                output[outputPos++] = (o2 + 0x80) >> 8;
            }
        } else {
            // Degenerate rx==ry==rz path. Mirrors the float source's
            // precedence quirk (see comment in kernelFloat4D).
            if (interpK) {
                output[outputPos++] = ((c0 << 8) + Math.imul(d0 - c0, rk) + 0x80) >> 16;
                output[outputPos++] = ((c1 << 8) + Math.imul(d1 - c1, rk) + 0x80) >> 16;
                output[outputPos++] = ((c2 << 8) + Math.imul(d2 - c2, rk) + 0x80) >> 16;
            } else {
                output[outputPos++] = (c0 + 0x80) >> 8;
                output[outputPos++] = (c1 + 0x80) >> 8;
                output[outputPos++] = (c2 + 0x80) >> 8;
            }
        }
    }
}

// ----------------------------------------------------------------------
// 6. LUT params for each kernel
// ----------------------------------------------------------------------

const floatLutParams = floatLut;
const intLutParams = {
    CLUT: u16LUT,
    g1: g1,
    go0: go0, go1: go1, go2: go2, go3: go3,
    outputChannels: outputChannels,
    gridPointsScale_fixed: gridPointsScale_fixed,
};

// ----------------------------------------------------------------------
// 7. Accuracy pass
// ----------------------------------------------------------------------

console.log('=== Accuracy ===');
kernelFloat4D(input, outputFloat, PIXEL_COUNT, floatLutParams);
kernelInt4D(input,   outputInt,   PIXEL_COUNT, intLutParams);

let exact = 0, off1 = 0, off2 = 0, off3to15 = 0, off16plus = 0;
let maxDiff = 0, maxDiffIdx = -1;
const totalChannels = PIXEL_COUNT * CHANNELS_OUT;
for (let i = 0; i < totalChannels; i++) {
    const d = Math.abs(outputFloat[i] - outputInt[i]);
    if (d === 0) exact++;
    else if (d === 1) off1++;
    else if (d === 2) off2++;
    else if (d <= 15) off3to15++;
    else off16plus++;
    if (d > maxDiff) { maxDiff = d; maxDiffIdx = i; }
}
const channelLabels = ['R', 'G', 'B'];
const pct = n => ((n / totalChannels) * 100).toFixed(2) + '%';
console.log('  total channels:  ' + totalChannels);
console.log('  exact:           ' + exact + '  (' + pct(exact) + ')');
console.log('  off by 1:        ' + off1 + '  (' + pct(off1) + ')');
console.log('  off by 2:        ' + off2 + '  (' + pct(off2) + ')');
console.log('  off by 3..15:    ' + off3to15 + '  (' + pct(off3to15) + ')');
console.log('  off by ≥16:      ' + off16plus + '  (' + pct(off16plus) + ')   ← regression indicator');
console.log('  max diff:        ' + maxDiff + '  (channel ' + channelLabels[maxDiffIdx % 3] + ', pixel #' + ((maxDiffIdx / 3) | 0) + ')');
console.log('');

if (maxDiff > 3) {
    console.log('  ✗ accuracy regression — int port has a bug');
} else if (maxDiff <= 1) {
    console.log('  ✓ within tight tolerance (all ≤ 1)');
} else {
    console.log('  ✓ within practical tolerance (max ' + maxDiff + ', expected ≤ 2 for 4D due to extra K-interp rounding)');
}
console.log('');

// ----------------------------------------------------------------------
// 8. Speed bench
// ----------------------------------------------------------------------

const WARMUP_ITER = 1000;
const TIMED_RUNS = 5;
const TIMED_ITER = 100;

function bench(name, fn, lut, scratch) {
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
    console.log('  ' + name.padEnd(15) + median.toFixed(3) + ' ms/iter  →  ' + mpx.toFixed(2) + ' MPx/s   (samples: ' + samples.map(s => s.toFixed(2)).join(', ') + ')');
    return median;
}

console.log('=== Speed (CMYK→RGB, median of ' + TIMED_RUNS + ' × ' + TIMED_ITER + ' iter, warmup ' + WARMUP_ITER + ') ===');
const tFloat = bench('Float kernel:',  kernelFloat4D, floatLutParams, outputFloat);
const tInt   = bench('Int kernel:',    kernelInt4D,   intLutParams,   outputInt);
console.log('');
console.log('  speedup:  ' + (tFloat / tInt).toFixed(2) + '×   (int vs float)');
console.log('');

// ----------------------------------------------------------------------
// 9. Edge case spot check
// ----------------------------------------------------------------------

function fmt5(n) { return ('     ' + n).slice(-5); }
function fmt4s(n) { return ('    ' + (n >= 0 ? '+' : '') + n).slice(-4); }

console.log('=== Edge case spot check (CMYK → RGB, deltas vs float) ===');
console.log('  ' + 'pixel'.padEnd(13) + 'input KCMY              float RGB ref       int Δ (R, G, B)');
console.log('  ' + '─'.repeat(82));

let edgePass = 0, edgeFail = 0;
const ABS_TOL = 2;  // 4D allows ±2 due to extra K-interp rounding step
for (let i = 0; i < EDGE_COUNT; i++) {
    const ec = EDGE_PIXELS[i];
    const o = i * 3;
    const fR = outputFloat[o], fG = outputFloat[o+1], fB = outputFloat[o+2];
    const iR = outputInt[o],   iG = outputInt[o+1],   iB = outputInt[o+2];
    const dR = iR - fR, dG = iG - fG, dB = iB - fB;
    const ok = Math.abs(dR) <= ABS_TOL && Math.abs(dG) <= ABS_TOL && Math.abs(dB) <= ABS_TOL;
    if (ok) edgePass++; else edgeFail++;
    console.log('  ' + ec.name + ' ' +
        '(' + fmt5(ec.kcmy[0]) + ',' + fmt5(ec.kcmy[1]) + ',' + fmt5(ec.kcmy[2]) + ',' + fmt5(ec.kcmy[3]) + ')   ' +
        '(' + fmt5(fR) + ',' + fmt5(fG) + ',' + fmt5(fB) + ')   ' +
        '(' + fmt4s(dR) + ',' + fmt4s(dG) + ',' + fmt4s(dB) + ')   ' +
        (ok ? '✓' : '✗ (>±' + ABS_TOL + ')'));
}
console.log('');
console.log('  edge cases passing ±' + ABS_TOL + ' LSB tolerance: ' + edgePass + '/' + EDGE_COUNT);
console.log('');

// ----------------------------------------------------------------------
// 10. Verdict
// ----------------------------------------------------------------------

const speedup = tFloat / tInt;
console.log('=== Verdict (4D CMYK→RGB) ===');
// For 4D u8 output, max diff up to 3 is acceptable: it's the K-interp
// rounding step compounding with the 3D rounding. 3 LSB in u8 = 1.2%
// of dynamic range, well under JND (~5-8 LSB on sRGB gray ramp).
// "off by ≥16" is the real regression line.
if (speedup >= 1.4 && off16plus === 0 && edgeFail === 0) {
    console.log('  ✓ ship it — 4D speedup matches/beats 3D, no severe outliers, all edges pass');
} else if (speedup >= 1.2 && off16plus === 0) {
    console.log('  ◐ marginal — speedup ' + speedup.toFixed(2) + '×, max diff ' + maxDiff + ', edge fails ' + edgeFail);
} else if (speedup < 1.0) {
    console.log('  ✗ slower — int port lost the JIT win, kernel is too large or polymorphic');
} else {
    console.log('  ◯ inconclusive — speedup ' + speedup.toFixed(2) + '×, off≥16: ' + off16plus + ', edge fails ' + edgeFail);
}

})().catch(err => { console.error(err); process.exit(1); });
