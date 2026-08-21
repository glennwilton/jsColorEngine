// src/kernels/3d/kernel3D_table.js
//
// The 3-D rows of the LUT dispatch table: which implementation runs for a
// given (lutMode, inputChannels, outputChannels), what has to be true for it to
// be eligible, and what it falls back to when it is not.
//
// MOVED HERE in v1.6 phase 4d (docs/deepdive/KernelContract.md). These rows
// lived in src/lutKernelTable.js alongside the 4-D ones. They belong to this
// kernel: every fallback chain in the table stays inside one input dimension --
// i8wsi_3_3 degrades to i8ws_3_3 to i_3_3 to fl_3_3, and never leaves 3-D -- so
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

var loops = require('./kernel3D_loops.js');
var WASM_DISPATCH_MIN_PIXELS = require('../dispatchThreshold.js');
var sharedGates = require('../gates.js');
var alwaysOk = sharedGates.alwaysOk, alwaysFalse = sharedGates.alwaysFalse,
    needsIntLut = sharedGates.needsIntLut;

function needsWasm3D(t, lut){
    return t.wasmTetra3D !== null && !!(lut && lut.intLut);
}
function needsWasm3DSimd(t, lut){
    return t.wasmTetra3DSimd !== null && !!(lut && lut.intLut);
}
function needsWasm3DInt16(t, lut){
    // v1.3 (Q0.13). tetra3d_nch_int16.wat ships true 16-bit precision
    // (Q0.13 weights, CLUT at scale 65535) and is bit-exact against the
    // JS u16 kernel (mirror of tetrahedralInterp3DArray_3Ch_intLut16_loop
    // in src/Transform.js). Identity gate at bench/int16_identity.js
    // passes <=1 LSB at g1=17/33/65; self-vs-float gate at
    // bench/int16_poc/accuracy_v1_7_self.js (filename retained as a
    // dev artifact) shows max 4 LSB u16 (0.006% of u16 range) on every
    // workflow.
    return t.wasmTetra3DInt16 !== null && !!(lut && lut.intLut);
}
function needsWasm3DInt16Simd(t, lut){
    // v1.3 SIMD u16 3D (tetra3d_simd_int16.wat). Bit-exact with the
    // scalar u16 3D kernel (Q0.13). Bound to cMax ∈ {3, 4} only — the
    // v128.store64_lane sliding store can't service cMax ∉ {3, 4} (it
    // writes 4 u16 lanes / 8 bytes per pixel; widths outside that are
    // routed to the scalar u16 sibling via the fallback chain).
    return t.wasmTetra3DInt16Simd !== null && !!(lut && lut.intLut);
}

function run_fl_3_3(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp3DArray_3Ch_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_fl_3_4(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp3DArray_4Ch_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_fl_3_n(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp3DArray_NCh_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_i_3_3(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp3DArray_3Ch_intLut_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i_3_4(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp3DArray_4Ch_intLut_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i16_3_3(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp3DArray_3Ch_intLut16_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i16_3_4(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp3DArray_4Ch_intLut16_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i8ws_3(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = ia ? 4 : 3;
    var outBPP = oa ? cMax + 1 : cMax;
    t.wasmTetra3D.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra3D.runTetra3D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}
function run_i8wsi_3(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = ia ? 4 : 3;
    var outBPP = oa ? cMax + 1 : cMax;
    t.wasmTetra3DSimd.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra3DSimd.runTetra3D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}
function run_i16ws_3(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = (ia ? 4 : 3) * 2;
    var outBPP = (oa ? cMax + 1 : cMax) * 2;
    t.wasmTetra3DInt16.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra3DInt16.runTetra3D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}
function run_i16wsi_3(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = (ia ? 4 : 3) * 2;
    var outBPP = (oa ? cMax + 1 : cMax) * 2;
    t.wasmTetra3DInt16Simd.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra3DInt16Simd.runTetra3D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

// ---- the rows ---------------------------------------------------------------

module.exports = {
    'i16wsi_3_3': { run: run_i16wsi_3, gate: needsWasm3DInt16Simd, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16ws_3_3' },
    'i16wsi_3_4': { run: run_i16wsi_3, gate: needsWasm3DInt16Simd, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16ws_3_4' },
    'i16wsi_3_n': { run: null,         gate: alwaysFalse,          minPx: 0,                       fallback: 'i16ws_3_n' },
    'i16ws_3_3':  { run: run_i16ws_3, gate: needsWasm3DInt16, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16_3_3' },
    'i16ws_3_4':  { run: run_i16ws_3, gate: needsWasm3DInt16, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16_3_4' },
    'i16ws_3_n':  { run: run_i16ws_3, gate: needsWasm3DInt16, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16_3_n' },
    'i8wsi_3_3':  { run: run_i8wsi_3, gate: needsWasm3DSimd,  minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i8ws_3_3' },
    'i8wsi_3_4':  { run: run_i8wsi_3, gate: needsWasm3DSimd,  minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i8ws_3_4' },
    'i8wsi_3_n':  { run: null,        gate: alwaysFalse,      minPx: 0,                       fallback: 'i8ws_3_n' },
    'i8ws_3_3':   { run: run_i8ws_3,  gate: needsWasm3D,      minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i_3_3' },
    'i8ws_3_4':   { run: run_i8ws_3,  gate: needsWasm3D,      minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i_3_4' },
    'i8ws_3_n':   { run: run_i8ws_3,  gate: needsWasm3D,      minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i_3_n' },
    'i16_3_3':    { run: run_i16_3_3, gate: needsIntLut,      minPx: 0, fallback: null },
    'i16_3_4':    { run: run_i16_3_4, gate: needsIntLut,      minPx: 0, fallback: null },
    'i16_3_n':    { run: null,        gate: alwaysFalse,      minPx: 0, fallback: null },
    'i_3_3':      { run: run_i_3_3,   gate: needsIntLut,      minPx: 0, fallback: 'fl_3_3' },
    'i_3_4':      { run: run_i_3_4,   gate: needsIntLut,      minPx: 0, fallback: 'fl_3_4' },
    'i_3_n':      { run: null,        gate: alwaysFalse,      minPx: 0, fallback: 'fl_3_n' },
    'fl_3_3':     { run: run_fl_3_3,  gate: alwaysOk,         minPx: 0, fallback: null },
    'fl_3_4':     { run: run_fl_3_4,  gate: alwaysOk,         minPx: 0, fallback: null },
    'fl_3_n':     { run: run_fl_3_n,  gate: alwaysOk,         minPx: 0, fallback: null },
};
