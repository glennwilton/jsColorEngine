/*
 * bench/int16_poc/bench_int16_vs_lcmswasm.js
 * ==========================================
 *
 * v1.3 POC — 16-bit JS hot kernel for jsColorEngine.
 *
 * What this measures
 * ------------------
 * Mirrors bench/lcms-comparison/bench.js exactly, but with u16 I/O
 * everywhere instead of u8. Three rows per workflow:
 *
 *   1. jsColorEngine     int8 'int'        (existing u8 path, baseline)
 *   2. jsColorEngine     int16 POC         (NEW kernel, this file)
 *   3. lcms-wasm         TYPE_*_16         (lcms u16 path, pinned heap)
 *
 * Both jsCE rows reuse the SAME float CLUT and the SAME `intLut` mirror
 * (built once via the engine's existing buildIntLut). The int16 POC
 * kernel only differs from the u8 'int' kernel in three places:
 *
 *   - input width: Uint16Array (0..65535) instead of Uint8ClampedArray
 *   - input grid index: gps_u16 = round((g1-1) << 16 / 65535)
 *     For g1=33 this is 32 — i.e. when input is u16, idx = (in*32)>>16
 *     and frac (rx) lives in bits 8..15 of the product, matching the
 *     u8 kernel's Q0.8 frac exactly.
 *   - output width: Uint16Array via the canonical [0,255]→[0,65535]
 *     bit-trick `v + (v >>> 8)`. For our cell scale 65280 = 255*256
 *     this maps the u8-kernel's intermediate range [0, 65280] to the
 *     full u16 range [0, 65535] EXACTLY, since 255*257 = 65535.
 *
 * Net effect: the int16 kernel is the u8 'int' kernel with wider load /
 * store, identical i32 ALU between. So same speed, no u8-quantisation
 * loss at either boundary, and the existing u16 intLut works as-is.
 *
 * Note on accuracy ceiling
 * ------------------------
 * This POC keeps the u8 kernel's Q0.8 frac (only 8 bits of the 16-bit
 * input frac actually weight the interpolation). That matches the
 * existing 'int' kernel's bit-exactness contract and is enough for a
 * faithful u16 image round-trip, but it does NOT improve precision
 * inside the LUT cells beyond what 'int' already does. Lifting frac to
 * Q0.16 (better mid-grid accuracy) needs a wider math path — split-imul
 * or an i32 accumulator that re-merges hi/lo halves. That is the v1.3.x
 * follow-up; this POC validates the wide-I/O path first so we know the
 * accuracy is at least u16-faithful before adding split arithmetic.
 *
 * Run:  cd bench/int16_poc && npm install && npm run bench
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

// ---- bench config (mirrors bench/lcms-comparison/bench.js) -------------

const PIXEL_COUNT   = 65536;
const TIMED_BATCHES = 5;
const BATCH_ITERS   = 100;
const WARMUP_ITERS  = 300;

// ---- helpers -----------------------------------------------------------

function buildInputU8(channels){
    const arr = new Uint8ClampedArray(PIXEL_COUNT * channels);
    let seed = 0x13579bdf;
    for(let i = 0; i < arr.length; i++){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        arr[i] = seed & 0xff;
    }
    return arr;
}

// Build the u16 input from the same byte stream, using the canonical
// [0,255] → [0,65535] expansion (v << 8 | v). That way the int8 and
// int16 paths see EXACTLY the same colours — any output difference is
// width-only, not data-dependent — and we still match lcms's u16
// expectation on input.
function buildInputU16FromU8(u8){
    const u16 = new Uint16Array(u8.length);
    for(let i = 0; i < u8.length; i++){
        const v = u8[i];
        u16[i] = (v << 8) | v;
    }
    return u16;
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

const mpxPerSec = ms => (PIXEL_COUNT / 1e6) / (ms / 1000);
const fmtMpx    = mpx => mpx.toFixed(1).padStart(6) + ' MPx/s';
const fmtMs     = ms  => ms.toFixed(2).padStart(5) + ' ms';

// =======================================================================
//  THE POC: u16 in, u16 out tetrahedral kernels
//  Reuses an intLut built by Transform.buildIntLut (lutMode='int').
// =======================================================================

/**
 * 3D LUT, 3-ch in → 3-ch out, u16/u16.
 * Equivalent to `tetrahedralInterp3DArray_3Ch_intLut_loop` in
 * src/Transform.js, but with u16 I/O. ALU between is bit-identical.
 */
function tetra3D_3ch_u16_loop(input, output, length, intLut){
    var rx = 0|0, ry = 0|0, rz = 0|0;
    var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0;
    var px = 0|0, py = 0|0, pz = 0|0;
    var in0 = 0|0, in1 = 0|0, in2 = 0|0;
    var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
    var c0 = 0|0, c1 = 0|0, c2 = 0|0, a = 0|0, b = 0|0;
    var v = 0|0;

    var CLUT = intLut.CLUT;
    var go0  = intLut.go0 | 0;
    var go1  = intLut.go1 | 0;
    var go2  = intLut.go2 | 0;
    var maxX = intLut.maxX | 0;
    var maxY = intLut.maxY | 0;
    var maxZ = intLut.maxZ | 0;

    // gps_u16 in Q0.16 of (g1-1)/65535. For g1=33 this is 32 (basically
    // (g1-1) when input is u16). px = imul(in_u16, gps_u16) gives a
    // value whose upper 16 bits are the grid index and bits 8..15 are
    // the Q0.8 frac — same shape as the u8 kernel's px.
    var gps_u16 = Math.round(((intLut.g1 - 1) << 16) / 65535);

    var inPos  = 0;
    var outPos = 0;
    for(var p = 0; p < length; p++){
        in0 = input[inPos++];
        in1 = input[inPos++];
        in2 = input[inPos++];

        px = Math.imul(in0, gps_u16);
        py = Math.imul(in1, gps_u16);
        pz = Math.imul(in2, gps_u16);

        if (in0 === 65535) { X0 = maxX; X1 = maxX; rx = 0; }
        else { X0 = px >>> 16; rx = (px >>> 8) & 0xFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

        if (in1 === 65535) { Y0 = maxY; Y1 = maxY; ry = 0; }
        else { Y0 = py >>> 16; ry = (py >>> 8) & 0xFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

        if (in2 === 65535) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
        else { Z0 = pz >>> 16; rz = (pz >>> 8) & 0xFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

        base1 = X0 + Y0 + Z0;
        c0 = CLUT[base1++];
        c1 = CLUT[base1++];
        c2 = CLUT[base1];

        if (rx >= ry && ry >= rz) {
            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z0;
            base4 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            v = c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
            a = CLUT[base1++]; b = CLUT[base2++];
            v = c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
            a = CLUT[base1];   b = CLUT[base2];
            v = c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
        } else if (rx >= rz && rz >= ry) {
            base1 = X1 + Y0 + Z0;
            base2 = X1 + Y1 + Z1;
            base3 = X1 + Y0 + Z1;
            a = CLUT[base3++]; b = CLUT[base1++];
            v = c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
            a = CLUT[base3++]; b = CLUT[base1++];
            v = c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
            a = CLUT[base3];   b = CLUT[base1];
            v = c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
        } else if (rx >= ry && rz >= rx) {
            base1 = X1 + Y0 + Z1;
            base2 = X0 + Y0 + Z1;
            base3 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            v = c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
            a = CLUT[base1++]; b = CLUT[base2++];
            v = c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
            a = CLUT[base1];   b = CLUT[base2];
            v = c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c2, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
        } else if (ry >= rx && rx >= rz) {
            base1 = X1 + Y1 + Z0;
            base2 = X0 + Y1 + Z0;
            base4 = X1 + Y1 + Z1;
            a = CLUT[base2++]; b = CLUT[base1++];
            v = c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
            a = CLUT[base2++]; b = CLUT[base1++];
            v = c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
            a = CLUT[base2];   b = CLUT[base1];
            v = c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
        } else if (ry >= rz && rz >= rx) {
            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            base3 = X0 + Y1 + Z0;
            a = CLUT[base2++]; b = CLUT[base3++];
            v = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
            a = CLUT[base2++]; b = CLUT[base3++];
            v = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
            a = CLUT[base2];   b = CLUT[base3];
            v = c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
        } else if (rz >= ry && ry >= rx) {
            base1 = X1 + Y1 + Z1;
            base2 = X0 + Y1 + Z1;
            base4 = X0 + Y0 + Z1;
            a = CLUT[base2++]; b = CLUT[base4++];
            v = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
            a = CLUT[base2++]; b = CLUT[base4++];
            v = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
            a = CLUT[base2];   b = CLUT[base4];
            v = c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x80) >> 8);
            output[outPos++] = v + (v >>> 8);
        } else {
            output[outPos++] = c0 + (c0 >>> 8);
            output[outPos++] = c1 + (c1 >>> 8);
            output[outPos++] = c2 + (c2 >>> 8);
        }
    }
}

/**
 * 3D LUT, 3-ch in → 4-ch out, u16/u16. Same as 3Ch but writes 4 cells.
 */
function tetra3D_4ch_u16_loop(input, output, length, intLut){
    var rx, ry, rz, X0, X1, Y0, Y1, Z0, Z1, px, py, pz;
    var in0, in1, in2;
    var base1, base2, base3, base4;
    var c0, c1, c2, c3, a, b, v;

    var CLUT = intLut.CLUT;
    var go0  = intLut.go0 | 0;
    var go1  = intLut.go1 | 0;
    var go2  = intLut.go2 | 0;
    var maxX = intLut.maxX | 0;
    var maxY = intLut.maxY | 0;
    var maxZ = intLut.maxZ | 0;
    var gps_u16 = Math.round(((intLut.g1 - 1) << 16) / 65535);

    var inPos = 0, outPos = 0;
    for(var p = 0; p < length; p++){
        in0 = input[inPos++];
        in1 = input[inPos++];
        in2 = input[inPos++];

        px = Math.imul(in0, gps_u16);
        py = Math.imul(in1, gps_u16);
        pz = Math.imul(in2, gps_u16);

        if (in0 === 65535) { X0 = maxX; X1 = maxX; rx = 0; }
        else { X0 = px >>> 16; rx = (px >>> 8) & 0xFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }
        if (in1 === 65535) { Y0 = maxY; Y1 = maxY; ry = 0; }
        else { Y0 = py >>> 16; ry = (py >>> 8) & 0xFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }
        if (in2 === 65535) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
        else { Z0 = pz >>> 16; rz = (pz >>> 8) & 0xFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

        base1 = X0 + Y0 + Z0;
        c0 = CLUT[base1++]; c1 = CLUT[base1++]; c2 = CLUT[base1++]; c3 = CLUT[base1];

        if (rx >= ry && ry >= rz) {
            base1 = X1 + Y0 + Z0; base2 = X1 + Y1 + Z0; base4 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            v = c0 + ((Math.imul(a-c0, rx) + Math.imul(b-a, ry) + Math.imul(CLUT[base4++]-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base1++]; b = CLUT[base2++];
            v = c1 + ((Math.imul(a-c1, rx) + Math.imul(b-a, ry) + Math.imul(CLUT[base4++]-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base1++]; b = CLUT[base2++];
            v = c2 + ((Math.imul(a-c2, rx) + Math.imul(b-a, ry) + Math.imul(CLUT[base4++]-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base1];   b = CLUT[base2];
            v = c3 + ((Math.imul(a-c3, rx) + Math.imul(b-a, ry) + Math.imul(CLUT[base4]-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
        } else if (rx >= rz && rz >= ry) {
            base1 = X1 + Y0 + Z0; base2 = X1 + Y1 + Z1; base3 = X1 + Y0 + Z1;
            a = CLUT[base3++]; b = CLUT[base1++];
            v = c0 + ((Math.imul(b-c0, rx) + Math.imul(CLUT[base2++]-a, ry) + Math.imul(a-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base3++]; b = CLUT[base1++];
            v = c1 + ((Math.imul(b-c1, rx) + Math.imul(CLUT[base2++]-a, ry) + Math.imul(a-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base3++]; b = CLUT[base1++];
            v = c2 + ((Math.imul(b-c2, rx) + Math.imul(CLUT[base2++]-a, ry) + Math.imul(a-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base3];   b = CLUT[base1];
            v = c3 + ((Math.imul(b-c3, rx) + Math.imul(CLUT[base2]-a, ry) + Math.imul(a-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
        } else if (rx >= ry && rz >= rx) {
            base1 = X1 + Y0 + Z1; base2 = X0 + Y0 + Z1; base3 = X1 + Y1 + Z1;
            a = CLUT[base1++]; b = CLUT[base2++];
            v = c0 + ((Math.imul(a-b, rx) + Math.imul(CLUT[base3++]-a, ry) + Math.imul(b-c0, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base1++]; b = CLUT[base2++];
            v = c1 + ((Math.imul(a-b, rx) + Math.imul(CLUT[base3++]-a, ry) + Math.imul(b-c1, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base1++]; b = CLUT[base2++];
            v = c2 + ((Math.imul(a-b, rx) + Math.imul(CLUT[base3++]-a, ry) + Math.imul(b-c2, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base1];   b = CLUT[base2];
            v = c3 + ((Math.imul(a-b, rx) + Math.imul(CLUT[base3]-a, ry) + Math.imul(b-c3, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
        } else if (ry >= rx && rx >= rz) {
            base1 = X1 + Y1 + Z0; base2 = X0 + Y1 + Z0; base4 = X1 + Y1 + Z1;
            a = CLUT[base2++]; b = CLUT[base1++];
            v = c0 + ((Math.imul(b-a, rx) + Math.imul(a-c0, ry) + Math.imul(CLUT[base4++]-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base2++]; b = CLUT[base1++];
            v = c1 + ((Math.imul(b-a, rx) + Math.imul(a-c1, ry) + Math.imul(CLUT[base4++]-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base2++]; b = CLUT[base1++];
            v = c2 + ((Math.imul(b-a, rx) + Math.imul(a-c2, ry) + Math.imul(CLUT[base4++]-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base2];   b = CLUT[base1];
            v = c3 + ((Math.imul(b-a, rx) + Math.imul(a-c3, ry) + Math.imul(CLUT[base4]-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
        } else if (ry >= rz && rz >= rx) {
            base1 = X1 + Y1 + Z1; base2 = X0 + Y1 + Z1; base3 = X0 + Y1 + Z0;
            a = CLUT[base2++]; b = CLUT[base3++];
            v = c0 + ((Math.imul(CLUT[base1++]-a, rx) + Math.imul(b-c0, ry) + Math.imul(a-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base2++]; b = CLUT[base3++];
            v = c1 + ((Math.imul(CLUT[base1++]-a, rx) + Math.imul(b-c1, ry) + Math.imul(a-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base2++]; b = CLUT[base3++];
            v = c2 + ((Math.imul(CLUT[base1++]-a, rx) + Math.imul(b-c2, ry) + Math.imul(a-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base2];   b = CLUT[base3];
            v = c3 + ((Math.imul(CLUT[base1]-a, rx) + Math.imul(b-c3, ry) + Math.imul(a-b, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
        } else if (rz >= ry && ry >= rx) {
            base1 = X1 + Y1 + Z1; base2 = X0 + Y1 + Z1; base4 = X0 + Y0 + Z1;
            a = CLUT[base2++]; b = CLUT[base4++];
            v = c0 + ((Math.imul(CLUT[base1++]-a, rx) + Math.imul(a-b, ry) + Math.imul(b-c0, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base2++]; b = CLUT[base4++];
            v = c1 + ((Math.imul(CLUT[base1++]-a, rx) + Math.imul(a-b, ry) + Math.imul(b-c1, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base2++]; b = CLUT[base4++];
            v = c2 + ((Math.imul(CLUT[base1++]-a, rx) + Math.imul(a-b, ry) + Math.imul(b-c2, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
            a = CLUT[base2];   b = CLUT[base4];
            v = c3 + ((Math.imul(CLUT[base1]-a, rx) + Math.imul(a-b, ry) + Math.imul(b-c3, rz) + 0x80) >> 8); output[outPos++] = v + (v >>> 8);
        } else {
            output[outPos++] = c0 + (c0 >>> 8);
            output[outPos++] = c1 + (c1 >>> 8);
            output[outPos++] = c2 + (c2 >>> 8);
            output[outPos++] = c3 + (c3 >>> 8);
        }
    }
}

// Generic dispatch
function tetra_u16(input, output, length, intLut){
    if(intLut.inputChannels === 3 && intLut.outputChannels === 3) return tetra3D_3ch_u16_loop(input, output, length, intLut);
    if(intLut.inputChannels === 3 && intLut.outputChannels === 4) return tetra3D_4ch_u16_loop(input, output, length, intLut);
    throw new Error('int16 POC: only 3D-3ch and 3D-4ch implemented in this POC. Got ' + intLut.inputChannels + 'D-' + intLut.outputChannels + 'ch (4D CMYK input is the v1.3.x follow-up).');
}

// =======================================================================
//  Main bench
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
        name: 'RGB -> Lab    (sRGB -> LabD50)',
        inCh: 3, outCh: 3,
        lcms: { pIn: lcmsSRGB,   fIn: TYPE_RGB_16,  pOut: lcmsLab,    fOut: TYPE_Lab_16 },
        js:   { src: '*srgb',    dst: '*labd50' },
    },
    {
        name: 'RGB -> CMYK   (sRGB -> GRACoL)',
        inCh: 3, outCh: 4,
        lcms: { pIn: lcmsSRGB,   fIn: TYPE_RGB_16,  pOut: lcmsGRACoL, fOut: TYPE_CMYK_16 },
        js:   { src: '*srgb',    dst: jsGRACoL },
    },
    // 4D CMYK input not implemented in this POC — see kernel dispatch
    // throw above. Will land alongside the v1.3.x merge into Transform.js.
];

function runOne(wf){
    console.log('\n--------------------------------------------------------------');
    console.log(' ' + wf.name);
    console.log('--------------------------------------------------------------');

    const inputU8  = buildInputU8(wf.inCh);
    const inputU16 = buildInputU16FromU8(inputU8);

    // 1. jsCE 'int' (existing u8 hot path) — baseline
    const jsInt = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    jsInt.create(wf.js.src, wf.js.dst, eIntent.relative);
    const msJsInt   = timeIters(() => { jsInt.transformArray(inputU8); });
    const outJsIntU8 = jsInt.transformArray(inputU8);

    // 2. jsCE int16 POC — REUSE jsInt.lut.intLut, drive new u16 kernel
    const intLut = jsInt.lut.intLut;
    if(!intLut) throw new Error('intLut not built — POC requires the existing int path to support this shape');
    const outJsInt16 = new Uint16Array(PIXEL_COUNT * wf.outCh);
    const msJsInt16  = timeIters(() => { tetra_u16(inputU16, outJsInt16, PIXEL_COUNT, intLut); });

    // 3. lcms-wasm TYPE_*_16 — pinned heap
    const inBytes  = PIXEL_COUNT * wf.inCh  * 2; // u16 = 2 bytes
    const outBytes = PIXEL_COUNT * wf.outCh * 2;
    const inPtr  = lcms._malloc(inBytes);
    const outPtr = lcms._malloc(outBytes);
    // Copy u16 input to heap. lcms-wasm reads HEAPU16 in native byte order.
    const heapInU16 = new Uint16Array(lcms.HEAPU8.buffer, inPtr, PIXEL_COUNT * wf.inCh);
    heapInU16.set(inputU16);

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
        const out = new Uint16Array(lcms.HEAPU8.buffer, outPtr, PIXEL_COUNT * wf.outCh).slice();
        lcms.cmsDeleteTransform(xf);
        return { ms, out };
    }

    const lcmsDefault = timeLcmsFlags(0);
    const lcmsHighres = timeLcmsFlags(cmsFLAGS_HIGHRESPRECALC);

    lcms._free(inPtr);
    lcms._free(outPtr);

    // ---- Accuracy diff: jsCE int16 vs lcms HIGHRESPRECALC u16 -----
    // Use HIGHRESPRECALC because that's the like-for-like comparison
    // (large precalc grid both sides). Default flags=0 lets lcms pick
    // its own grid which can be smaller and biases the comparison.
    const ref = lcmsHighres.out;
    const got = outJsInt16;
    let maxAbs = 0, sumAbs = 0;
    let cnt0 = 0, cnt1 = 0, cnt8 = 0, cnt64 = 0, cnt256 = 0;
    for(let i = 0; i < ref.length; i++){
        const d = Math.abs(got[i] - ref[i]);
        if(d > maxAbs) maxAbs = d;
        sumAbs += d;
        if(d === 0) cnt0++;
        if(d <= 1) cnt1++;
        if(d <= 8) cnt8++;          // 1 LSB at u8 = 256 LSB at u16, so 8 LSB u16 ≈ 0.03 LSB u8
        if(d <= 64) cnt64++;        // 0.25 LSB at u8
        if(d <= 256) cnt256++;      // 1 LSB at u8
    }
    const meanAbs = sumAbs / ref.length;
    const total = ref.length;
    const pct = n => ((n / total) * 100).toFixed(2);

    // ---- Sanity diff: jsCE int8 vs jsCE int16 (should round-trip
    // bit-exact when int16 output is shifted >> 8 down to u8) ------
    let int8VsInt16Max = 0;
    for(let i = 0; i < outJsIntU8.length; i++){
        const u8FromInt16 = (outJsInt16[i] + 0x80) >>> 8;
        const d = Math.abs(outJsIntU8[i] - u8FromInt16);
        if(d > int8VsInt16Max) int8VsInt16Max = d;
    }

    // ---- Throughput report -----------------------------------------
    const mpxJsInt        = mpxPerSec(msJsInt);
    const mpxJsInt16      = mpxPerSec(msJsInt16);
    const mpxLcmsDefault  = mpxPerSec(lcmsDefault.ms);
    const mpxLcmsHighres  = mpxPerSec(lcmsHighres.ms);
    const mpxLcmsBest     = Math.max(mpxLcmsDefault, mpxLcmsHighres);

    console.log('  jsCE int  (u8 in/out)        : ' + fmtMpx(mpxJsInt)       + '   (' + fmtMs(msJsInt)       + '/iter)   [baseline]');
    console.log('  jsCE int16 POC (u16 in/out)  : ' + fmtMpx(mpxJsInt16)     + '   (' + fmtMs(msJsInt16)     + '/iter)   [NEW]');
    console.log('  lcms-wasm  flags=0   (u16)   : ' + fmtMpx(mpxLcmsDefault) + '   (' + fmtMs(lcmsDefault.ms) + '/iter)');
    console.log('  lcms-wasm  HIGHRESPRECALC    : ' + fmtMpx(mpxLcmsHighres) + '   (' + fmtMs(lcmsHighres.ms) + '/iter)');
    console.log('');
    console.log('  jsCE int16 vs lcms-wasm best : ' + (mpxJsInt16 / mpxLcmsBest).toFixed(2) + '×');
    console.log('  jsCE int16 vs jsCE int (u8)  : ' + (mpxJsInt16 / mpxJsInt).toFixed(2) + '×  (width-only diff: same kernel, wider load/store)');
    console.log('');
    console.log('  ACCURACY (jsCE int16 vs lcms HIGHRESPRECALC u16, ' + total.toLocaleString() + ' samples):');
    console.log('    max |Δ|     : ' + maxAbs + ' LSB at u16  (=' + (maxAbs / 256).toFixed(3) + ' LSB at u8 equivalent)');
    console.log('    mean |Δ|    : ' + meanAbs.toFixed(3) + ' LSB at u16');
    console.log('    Δ = 0       : ' + pct(cnt0)  + ' %');
    console.log('    Δ ≤ 1       : ' + pct(cnt1)  + ' %');
    console.log('    Δ ≤ 64  (0.25 LSB u8) : ' + pct(cnt64) + ' %');
    console.log('    Δ ≤ 256 (1.0 LSB u8)  : ' + pct(cnt256) + ' %');
    console.log('');
    console.log('  SANITY: int8 output vs (int16 >> 8) max diff: ' + int8VsInt16Max + ' LSB at u8' +
                (int8VsInt16Max <= 1 ? '  ✓ kernel parity confirmed' : '  ✗ KERNEL DIVERGENCE'));

    return { wf: wf.name, mpxJsInt, mpxJsInt16, mpxLcmsDefault, mpxLcmsHighres, maxAbs, meanAbs, int8VsInt16Max };
}

console.log('==============================================================');
console.log(' int16 POC — jsColorEngine 16-bit JS hot kernel vs lcms-wasm');
console.log('==============================================================');
console.log(' Pixel count   : ' + PIXEL_COUNT.toLocaleString() + ' (' + Math.sqrt(PIXEL_COUNT) + 'x' + Math.sqrt(PIXEL_COUNT) + ')');
console.log(' Warmup iters  : ' + WARMUP_ITERS);
console.log(' Timed batches : ' + TIMED_BATCHES + ' x ' + BATCH_ITERS + ' iters');
console.log(' Profile       : GRACoL2006_Coated1v2.icc');
console.log(' Intent        : Relative colorimetric');
console.log(' Sample LUT    : g1=' + (new Transform({dataFormat:'int8',buildLut:true,lutMode:'int'}).create('*srgb', jsGRACoL, eIntent.relative), '(see per-workflow output)'));

const results = [];
for(const wf of WORKFLOWS){
    results.push(runOne(wf));
}

console.log('\n==============================================================');
console.log(' SUMMARY');
console.log('==============================================================');
console.log(' Workflow                            jsInt    jsInt16   lcms16   int16/lcms   max|Δ|u16');
for(const r of results){
    const name = r.wf.padEnd(35);
    const lcmsBest = Math.max(r.mpxLcmsDefault, r.mpxLcmsHighres);
    console.log(' ' + name + ' ' + r.mpxJsInt.toFixed(1).padStart(6) + '   ' + r.mpxJsInt16.toFixed(1).padStart(6) + '   ' + lcmsBest.toFixed(1).padStart(6) + '   ' + (r.mpxJsInt16/lcmsBest).toFixed(2).padStart(5) + '×    ' + r.maxAbs.toString().padStart(5) + '   (' + (r.maxAbs/256).toFixed(2) + ' LSB u8)');
}
console.log('');
