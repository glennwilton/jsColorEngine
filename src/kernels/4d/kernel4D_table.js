// src/kernels/4d/kernel4D_table.js
//
// The 4-D rows of the LUT dispatch table: which implementation runs for a
// given (lutMode, inputChannels, outputChannels), what has to be true for it to
// be eligible, and what it falls back to when it is not.
//
// MOVED HERE in v1.6 phase 4d (docs/deepdive/KernelContract.md). These rows
// lived in src/lutKernelTable.js alongside the 3-D ones. They belong to this
// kernel: every fallback chain in the table stays inside one input dimension --
// i8wsi_4_4 degrades to i8ws_4_4 to i_4_4 to fl_4_4, and never leaves 4-D -- so
// the table was two independent ladders sharing a file.
//
// What did NOT move: the resolver that walks a chain, the key format, and the
// lutMode-to-prefix map. Those are generic and stay in src/lutKernelTable.js,
// which assembles the merged view the dispatcher and the tests still read.
//
// STILL PARAMETERISED ON THE TRANSFORM. The WASM runs and gates take `t` for
// `t.outputChannels` and `t.wasmTetra*`. That is phase 4c's problem -- when the
// WASM state moves onto the kernel instance, these take the kernel instead and
// the last of the coupling goes with it.
'use strict';

var loops = require('./kernel4D_loops.js');
var WASM_DISPATCH_MIN_PIXELS = require('../dispatchThreshold.js');
var sharedGates = require('../gates.js');
var alwaysOk = sharedGates.alwaysOk, alwaysFalse = sharedGates.alwaysFalse,
    needsIntLut = sharedGates.needsIntLut;

function needsWasm4D(t, lut){
    return t.wasmTetra4D !== null && !!(lut && lut.intLut);
}
function needsWasm4DSimd(t, lut){
    return t.wasmTetra4DSimd !== null && !!(lut && lut.intLut);
}
function needsWasm4DInt16(t, lut){
    // v1.3 (Q0.13). tetra4d_nch_int16.wat ships true 16-bit precision
    // (Q0.13 weights, CLUT at scale 65535) using the TWO-ROUNDING
    // design (XYZ→u16 at K0, XYZ→u16 at K1, then K-LERP →u16) —
    // bit-exact with the JS u16 4D kernel
    // tetrahedralInterp4DArray_{3,4}Ch_intLut16_loop. See the WAT header
    // for the bit-budget walkthrough and i32-safety analysis.
    return t.wasmTetra4DInt16 !== null && !!(lut && lut.intLut);
}
function needsWasm4DInt16Simd(t, lut){
    // v1.3 SIMD u16 4D (tetra4d_simd_int16.wat). Bit-exact with the
    // scalar u16 4D kernel (Q0.13 + two-rounding K-LERP). Same cMax ∈
    // {3, 4} guard as the 3D SIMD sibling. Crucially the SIMD kernel
    // keeps the K0 intermediate in a v128 local register and ignores
    // $scratchPtr — no scratch round-trip through linear memory like
    // the scalar 4D u16 kernel needs.
    return t.wasmTetra4DInt16Simd !== null && !!(lut && lut.intLut);
}

function run_fl_4_3(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_3Ch_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_fl_4_4(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_4Ch_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_fl_4_n(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_NCh_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}

// ---- u8 JS integer ----------------------------------------------------------

function run_i_4_3(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_3Ch_intLut_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i_4_4(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_4Ch_intLut_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
// no _i_3_n / _i_4_n: integer NCh has no intLut variant — falls to fl

// ---- u16 JS integer ---------------------------------------------------------

function run_i16_4_3(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_3Ch_intLut16_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i16_4_4(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_4Ch_intLut16_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
// no _i16_3_n / _i16_4_n: u16 NCh has no intLut16 variant — falls to i_*_n → fl

// ---- u8 WASM scalar (rolled n-channel kernel — supports any cMax) -----------

function run_i8ws_4(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = ia ? 5 : 4;
    var outBPP = oa ? cMax + 1 : cMax;
    t.wasmTetra4D.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra4D.runTetra4D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

// ---- u8 WASM SIMD (cMax ∈ {3, 4} only — same call shape as scalar) ----------

function run_i8wsi_4(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = ia ? 5 : 4;
    var outBPP = oa ? cMax + 1 : cMax;
    t.wasmTetra4DSimd.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra4DSimd.runTetra4D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

// ---- u16 WASM scalar (rolled n-channel kernel — supports any cMax) ----------

function run_i16ws_4(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = (ia ? 5 : 4) * 2;
    var outBPP = (oa ? cMax + 1 : cMax) * 2;
    t.wasmTetra4DInt16.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra4DInt16.runTetra4D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

// ---- u16 WASM SIMD (cMax ∈ {3, 4} only — same call shape as scalar u16) -----

function run_i16wsi_4(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = (ia ? 5 : 4) * 2;
    var outBPP = (oa ? cMax + 1 : cMax) * 2;
    t.wasmTetra4DInt16Simd.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra4DInt16Simd.runTetra4D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

// ============================================================================
// THE TABLE — every cell is the ONE place to look for "what runs when?"
// ============================================================================

// ---- the rows ---------------------------------------------------------------

module.exports = {
    'i16wsi_4_3': { run: run_i16wsi_4, gate: needsWasm4DInt16Simd, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16ws_4_3' },
    'i16wsi_4_4': { run: run_i16wsi_4, gate: needsWasm4DInt16Simd, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16ws_4_4' },
    'i16wsi_4_n': { run: null,         gate: alwaysFalse,          minPx: 0,                       fallback: 'i16ws_4_n' },
    'i16ws_4_3':  { run: run_i16ws_4, gate: needsWasm4DInt16, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16_4_3' },
    'i16ws_4_4':  { run: run_i16ws_4, gate: needsWasm4DInt16, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16_4_4' },
    'i16ws_4_n':  { run: run_i16ws_4, gate: needsWasm4DInt16, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16_4_n' },
    'i8wsi_4_3':  { run: run_i8wsi_4, gate: needsWasm4DSimd,  minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i8ws_4_3' },
    'i8wsi_4_4':  { run: run_i8wsi_4, gate: needsWasm4DSimd,  minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i8ws_4_4' },
    'i8wsi_4_n':  { run: null,        gate: alwaysFalse,      minPx: 0,                       fallback: 'i8ws_4_n' },
    'i8ws_4_3':   { run: run_i8ws_4,  gate: needsWasm4D,      minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i_4_3' },
    'i8ws_4_4':   { run: run_i8ws_4,  gate: needsWasm4D,      minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i_4_4' },
    'i8ws_4_n':   { run: run_i8ws_4,  gate: needsWasm4D,      minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i_4_n' },
    'i16_4_3':    { run: run_i16_4_3, gate: needsIntLut,      minPx: 0, fallback: null },
    'i16_4_4':    { run: run_i16_4_4, gate: needsIntLut,      minPx: 0, fallback: null },
    'i16_4_n':    { run: null,        gate: alwaysFalse,      minPx: 0, fallback: null },
    'i_4_3':      { run: run_i_4_3,   gate: needsIntLut,      minPx: 0, fallback: 'fl_4_3' },
    'i_4_4':      { run: run_i_4_4,   gate: needsIntLut,      minPx: 0, fallback: 'fl_4_4' },
    'i_4_n':      { run: null,        gate: alwaysFalse,      minPx: 0, fallback: 'fl_4_n' },
    'fl_4_3':     { run: run_fl_4_3,  gate: alwaysOk,         minPx: 0, fallback: null },
    'fl_4_4':     { run: run_fl_4_4,  gate: alwaysOk,         minPx: 0, fallback: null },
    'fl_4_n':     { run: run_fl_4_n,  gate: alwaysOk,         minPx: 0, fallback: null },
};
