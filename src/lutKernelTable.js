/*************************************************************************
 *  @license
 *
 *  Copyright © 2019, 2026 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 */

// ============================================================================
// lutKernelTable.js — flat lookup table for the LUT kernel dispatcher
// ============================================================================
//
// One config object per supported (lutMode, inputChannels, outputChannels)
// triple. Drives `Transform.transformArrayViaLUT` v2 (the table-driven
// dispatcher). Each entry self-describes:
//
//   run       — kernel invocation closure (inline so Cmd+Click on the
//               method name jumps to its definition; profiler shows the
//               wrapper function name; per-kernel arg-shape adaptation
//               happens here, not in the dispatcher)
//   gate      — `(t, lut) => boolean`; checked at create() time and cached
//               in `entry.cachedGatePass` per Transform. Includes both
//               WASM-state availability AND lut.intLut presence (every
//               integer kernel needs a built intLut).
//   minPx     — minimum pixelCount for this entry to be eligible. Non-zero
//               only for WASM entries (memcpy break-even). Checked per call.
//   fallback  — sibling key the resolver walks to if `gate` fails OR
//               `pixelCount < minPx`. Encoded as data — no separate
//               per-mode fallback config to keep in sync.
//
// Key naming: "<modeShort>_<inCh>_<outCh>" where outCh='n' covers every
// outputChannels not explicitly listed (so cMax ∈ {3, 4} are explicit
// entries, cMax ∈ {1, 5, 6, ...} resolves to '_n').
//
//   modeShort:  fl     float (last resort, always works)
//               i      u8  JS  (intLut required)
//               i16    u16 JS  (intLut required)
//               i8ws   u8  WASM scalar  (3D + 4D, all cMax)
//               i8wsi  u8  WASM SIMD    (3D + 4D, cMax ∈ {3, 4} only)
//               i16ws  u16 WASM scalar  (3D + 4D, all cMax)
//               i16wsi u16 WASM SIMD    (3D + 4D, cMax ∈ {3, 4} only — v1.3 / Q0.13)
//
// Fallback graph (degradation order — strict feature loss, never gain).
//
// BIT-DEPTH INVARIANT: a chain MUST NOT cross between u8 and u16
// kernels. The dispatcher pre-allocates the output buffer based on
// lutMode (Uint16Array for int16-* modes, Uint8ClampedArray
// otherwise — see transformArrayViaLUT). If a u16 chain fell through
// to a u8 kernel, that kernel would write 0..255 values into a
// Uint16Array — the data would silently divide by ~257 and look
// "almost right" until someone printed a proof.
//
//   u16 chains  →  terminate at the JS u16 kernel (or earlier).
//                  fallback: null past the JS rung means a misuse
//                  (e.g. lutMode='int16' without buildIntLut, or
//                  cMax outside {3, 4} on a non-WASM host) throws
//                  loudly rather than silently corrupting.
//   u8  chains  →  degrade all the way to the float kernel, which
//                  also writes 0..255 (matches Uint8ClampedArray).
//
//   i16wsi → i16ws → i16 → null                    (u16 — chain ends at JS u16)
//   i16ws  → i16   → null
//   i16    → null                                  (no u8 cross-over)
//
//   i8wsi  → i8ws  → i  → fl                       (u8 — full degradation to float)
//   i8ws   → i     → fl
//   i      → fl
//   fl     → null                                  (chain end — alwaysOk)
//
// Sparse cells (kernel doesn't cover this shape) use `run: null` and
// `gate: alwaysFalse` — the resolver treats them as transparent
// passthrough to `fallback`. We keep the cell present (rather than
// deleting it) so the table stays exhaustive: every (mode, inCh, outB)
// triple is documented in one place, even when the answer is "skip me".
//
// "n" entries cover the multichannel case (cMax not in {3, 4}, e.g.
// CMYKOG 6-color or hexachrome inks). Coverage by mode:
//
//   • SCALAR WASM (i8ws_*_n, i16ws_*_n) → ✓ DOES run. The scalar
//     kernels are rolled-NCh (loop `o < cMax` over output channels)
//     so they handle any output width. Big win vs legacy, which
//     hard-coded `outputChannels === 3 || === 4` and dropped n-color
//     pipelines onto a per-pixel allocating JS path.
//
//   • SIMD WASM (i8wsi_*_n, i16wsi_*_n) → ✗ CANNOT run. The SIMD
//     kernels store one full output pixel per `i32x4` lane write
//     (4 bytes / pixel). Letting them run on cMax=5+ would corrupt
//     memory past the output stride — gated out as a hard
//     correctness requirement, not a perf trade-off. Falls through
//     transparently to the scalar WASM sibling above.
//
//   • JS INTEGER (i_*_n, i16_*_n) → ✗ NOT IMPLEMENTED. The JS NCh
//     kernels (`tetrahedralInterp3DArray_NCh_loop` and 4D sibling)
//     don't have `intLut` variants because 6+ channel CLUTs are
//     comparatively rare and the WASM scalar path already covers
//     them well. Falls through to `fl_*_n` (per-pixel JS NCh loop).
//
// ============================================================================

'use strict';

// Kept in sync with Transform.WASM_DISPATCH_MIN_PIXELS. Hard-coded here
// to break the require cycle (Transform.js requires this module at
// load time, before `Transform.WASM_DISPATCH_MIN_PIXELS = 256` runs).
// If you change one, change both.
var WASM_DISPATCH_MIN_PIXELS = 256;

// ---- gate predicates (cached at create() time per-Transform) ----------------

function alwaysOk()   { return true; }
function alwaysFalse(){ return false; }
function needsIntLut(t, lut)  { return !!(lut && lut.intLut); }

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
function needsWasm3DInt16Simd(t, lut){
    // v1.3 SIMD u16 3D (tetra3d_simd_int16.wat). Bit-exact with the
    // scalar u16 3D kernel (Q0.13). Bound to cMax ∈ {3, 4} only — the
    // v128.store64_lane sliding store can't service cMax ∉ {3, 4} (it
    // writes 4 u16 lanes / 8 bytes per pixel; widths outside that are
    // routed to the scalar u16 sibling via the fallback chain).
    return t.wasmTetra3DInt16Simd !== null && !!(lut && lut.intLut);
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

// ---- run closures -----------------------------------------------------------
//
// Signature: (t, input, output, px, lut, ia, oa, pa)
//   t      — Transform instance (provides cMax via t.outputChannels and
//            owns WASM state objects)
//   input  — typed array (Uint8ClampedArray | Uint16Array | Float64Array
//            | plain Array depending on dataFormat)
//   output — pre-allocated typed array (the dispatcher decides type)
//   px     — pixelCount
//   lut    — the lut object (run paths that need integer LUT read
//            `lut.intLut`; float paths read `lut` directly)
//   ia, oa, pa — inputHasAlpha, outputHasAlpha, preserveAlpha booleans
//
// The method names in these closures are clickable in any IDE that
// resolves `t.foo()` to its prototype definition — that's the whole
// point of inline closures vs a string-keyed indirect dispatch.
//
// ---- float (last resort) ----------------------------------------------------

function run_fl_3_3(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp3DArray_3Ch_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_fl_3_4(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp3DArray_4Ch_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_fl_3_n(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp3DArray_NCh_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_fl_4_3(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp4DArray_3Ch_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_fl_4_4(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp4DArray_4Ch_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_fl_4_n(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp4DArray_NCh_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}

// ---- u8 JS integer ----------------------------------------------------------

function run_i_3_3(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp3DArray_3Ch_intLut_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i_3_4(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp3DArray_4Ch_intLut_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i_4_3(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp4DArray_3Ch_intLut_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i_4_4(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp4DArray_4Ch_intLut_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
// no _i_3_n / _i_4_n: integer NCh has no intLut variant — falls to fl

// ---- u16 JS integer ---------------------------------------------------------

function run_i16_3_3(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp3DArray_3Ch_intLut16_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i16_3_4(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp3DArray_4Ch_intLut16_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i16_4_3(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp4DArray_3Ch_intLut16_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i16_4_4(t, input, output, px, lut, ia, oa, pa){
    t.tetrahedralInterp4DArray_4Ch_intLut16_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
// no _i16_3_n / _i16_4_n: u16 NCh has no intLut16 variant — falls to i_*_n → fl

// ---- u8 WASM scalar (rolled n-channel kernel — supports any cMax) -----------

function run_i8ws_3(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = ia ? 4 : 3;
    var outBPP = oa ? cMax + 1 : cMax;
    t.wasmTetra3D.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra3D.runTetra3D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}
function run_i8ws_4(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = ia ? 5 : 4;
    var outBPP = oa ? cMax + 1 : cMax;
    t.wasmTetra4D.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra4D.runTetra4D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

// ---- u8 WASM SIMD (cMax ∈ {3, 4} only — same call shape as scalar) ----------

function run_i8wsi_3(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = ia ? 4 : 3;
    var outBPP = oa ? cMax + 1 : cMax;
    t.wasmTetra3DSimd.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra3DSimd.runTetra3D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}
function run_i8wsi_4(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = ia ? 5 : 4;
    var outBPP = oa ? cMax + 1 : cMax;
    t.wasmTetra4DSimd.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra4DSimd.runTetra4D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

// ---- u16 WASM scalar (rolled n-channel kernel — supports any cMax) ----------

function run_i16ws_3(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = (ia ? 4 : 3) * 2;
    var outBPP = (oa ? cMax + 1 : cMax) * 2;
    t.wasmTetra3DInt16.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra3DInt16.runTetra3D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}
function run_i16ws_4(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = (ia ? 5 : 4) * 2;
    var outBPP = (oa ? cMax + 1 : cMax) * 2;
    t.wasmTetra4DInt16.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra4DInt16.runTetra4D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

// ---- u16 WASM SIMD (cMax ∈ {3, 4} only — same call shape as scalar u16) -----

function run_i16wsi_3(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = (ia ? 4 : 3) * 2;
    var outBPP = (oa ? cMax + 1 : cMax) * 2;
    t.wasmTetra3DInt16Simd.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra3DInt16Simd.runTetra3D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}
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

var KERNEL = {
    // ---- u16 WASM SIMD (cMax ∈ {3, 4} only — _n falls through to scalar) ------
    'i16wsi_3_3': { run: run_i16wsi_3, gate: needsWasm3DInt16Simd, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16ws_3_3' },
    'i16wsi_3_4': { run: run_i16wsi_3, gate: needsWasm3DInt16Simd, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16ws_3_4' },
    'i16wsi_3_n': { run: null,         gate: alwaysFalse,          minPx: 0,                       fallback: 'i16ws_3_n' },
    'i16wsi_4_3': { run: run_i16wsi_4, gate: needsWasm4DInt16Simd, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16ws_4_3' },
    'i16wsi_4_4': { run: run_i16wsi_4, gate: needsWasm4DInt16Simd, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16ws_4_4' },
    'i16wsi_4_n': { run: null,         gate: alwaysFalse,          minPx: 0,                       fallback: 'i16ws_4_n' },

    // ---- u16 WASM scalar (rolled n-channel — covers all cMax) -----------------
    'i16ws_3_3':  { run: run_i16ws_3, gate: needsWasm3DInt16, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16_3_3' },
    'i16ws_3_4':  { run: run_i16ws_3, gate: needsWasm3DInt16, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16_3_4' },
    'i16ws_3_n':  { run: run_i16ws_3, gate: needsWasm3DInt16, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16_3_n' },
    'i16ws_4_3':  { run: run_i16ws_4, gate: needsWasm4DInt16, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16_4_3' },
    'i16ws_4_4':  { run: run_i16ws_4, gate: needsWasm4DInt16, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16_4_4' },
    'i16ws_4_n':  { run: run_i16ws_4, gate: needsWasm4DInt16, minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i16_4_n' },

    // ---- u8 WASM SIMD (cMax ∈ {3, 4} only) ------------------------------------
    'i8wsi_3_3':  { run: run_i8wsi_3, gate: needsWasm3DSimd,  minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i8ws_3_3' },
    'i8wsi_3_4':  { run: run_i8wsi_3, gate: needsWasm3DSimd,  minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i8ws_3_4' },
    'i8wsi_3_n':  { run: null,        gate: alwaysFalse,      minPx: 0,                       fallback: 'i8ws_3_n' },
    'i8wsi_4_3':  { run: run_i8wsi_4, gate: needsWasm4DSimd,  minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i8ws_4_3' },
    'i8wsi_4_4':  { run: run_i8wsi_4, gate: needsWasm4DSimd,  minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i8ws_4_4' },
    'i8wsi_4_n':  { run: null,        gate: alwaysFalse,      minPx: 0,                       fallback: 'i8ws_4_n' },

    // ---- u8 WASM scalar (rolled n-channel — covers all cMax) ------------------
    'i8ws_3_3':   { run: run_i8ws_3,  gate: needsWasm3D,      minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i_3_3' },
    'i8ws_3_4':   { run: run_i8ws_3,  gate: needsWasm3D,      minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i_3_4' },
    'i8ws_3_n':   { run: run_i8ws_3,  gate: needsWasm3D,      minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i_3_n' },
    'i8ws_4_3':   { run: run_i8ws_4,  gate: needsWasm4D,      minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i_4_3' },
    'i8ws_4_4':   { run: run_i8ws_4,  gate: needsWasm4D,      minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i_4_4' },
    'i8ws_4_n':   { run: run_i8ws_4,  gate: needsWasm4D,      minPx: WASM_DISPATCH_MIN_PIXELS, fallback: 'i_4_n' },

    // ---- u16 JS (cMax ∈ {3, 4} only — NCh has no intLut16 variant) ------------
    // BIT-DEPTH TERMINUS: u16 chain ends here. NO fallback to u8 (would
    // silently scale outputs by ~1/257 into a Uint16Array). If gate fails
    // (no intLut) or no u16 kernel exists for this shape (cMax='n'), the
    // resolver throws "fallback chain exhausted" — fix the call site, not
    // the table. See BIT-DEPTH INVARIANT in the file header.
    'i16_3_3':    { run: run_i16_3_3, gate: needsIntLut,      minPx: 0, fallback: null },
    'i16_3_4':    { run: run_i16_3_4, gate: needsIntLut,      minPx: 0, fallback: null },
    'i16_3_n':    { run: null,        gate: alwaysFalse,      minPx: 0, fallback: null },
    'i16_4_3':    { run: run_i16_4_3, gate: needsIntLut,      minPx: 0, fallback: null },
    'i16_4_4':    { run: run_i16_4_4, gate: needsIntLut,      minPx: 0, fallback: null },
    'i16_4_n':    { run: null,        gate: alwaysFalse,      minPx: 0, fallback: null },

    // ---- u8 JS (cMax ∈ {3, 4} only — NCh has no intLut variant) ---------------
    'i_3_3':      { run: run_i_3_3,   gate: needsIntLut,      minPx: 0, fallback: 'fl_3_3' },
    'i_3_4':      { run: run_i_3_4,   gate: needsIntLut,      minPx: 0, fallback: 'fl_3_4' },
    'i_3_n':      { run: null,        gate: alwaysFalse,      minPx: 0, fallback: 'fl_3_n' },
    'i_4_3':      { run: run_i_4_3,   gate: needsIntLut,      minPx: 0, fallback: 'fl_4_3' },
    'i_4_4':      { run: run_i_4_4,   gate: needsIntLut,      minPx: 0, fallback: 'fl_4_4' },
    'i_4_n':      { run: null,        gate: alwaysFalse,      minPx: 0, fallback: 'fl_4_n' },

    // ---- float (last resort — chain end) --------------------------------------
    'fl_3_3':     { run: run_fl_3_3,  gate: alwaysOk,         minPx: 0, fallback: null },
    'fl_3_4':     { run: run_fl_3_4,  gate: alwaysOk,         minPx: 0, fallback: null },
    'fl_3_n':     { run: run_fl_3_n,  gate: alwaysOk,         minPx: 0, fallback: null },
    'fl_4_3':     { run: run_fl_4_3,  gate: alwaysOk,         minPx: 0, fallback: null },
    'fl_4_4':     { run: run_fl_4_4,  gate: alwaysOk,         minPx: 0, fallback: null },
    'fl_4_n':     { run: run_fl_4_n,  gate: alwaysOk,         minPx: 0, fallback: null },
};

// ---- modeShort mapping ------------------------------------------------------

var LUT_MODE_SHORT = {
    'float':              'fl',
    'int':                'i',
    'int16':              'i16',
    'int-wasm-scalar':    'i8ws',
    'int-wasm-simd':      'i8wsi',
    'int16-wasm-scalar':  'i16ws',
    'int16-wasm-simd':    'i16wsi',
};

// ---- key builder ------------------------------------------------------------

function makeKey(modeShort, inCh, outCh){
    // Collapse all "other" output channel counts to the catch-all 'n' bucket.
    var outBucket = (outCh === 3 || outCh === 4) ? String(outCh) : 'n';
    return modeShort + '_' + inCh + '_' + outBucket;
}

// ---- resolver ---------------------------------------------------------------
//
// Walk the fallback linked list starting at `startKey`, returning the
// first entry whose gate passes AND whose minPx is satisfied at the
// supplied `pixelCount` floor. Used at create() time for two passes:
//
//   resolveLutKernel(t, lut, startKey, Infinity)  → 'big batch' kernel
//   resolveLutKernel(t, lut, startKey, 0)         → 'small batch' kernel
//
// Both refs are then cached on the Transform; per-call dispatch is one
// threshold compare + one indirect call.
//
// Throws if the chain runs off the end:
//   - For u8 chains this means a config bug (the fl_*_* tier has
//     gate=alwaysOk and should always catch).
//   - For u16 chains this is the BIT-DEPTH INVARIANT firing: u16 modes
//     with no eligible u16 kernel (e.g. lutMode='int16' without
//     buildIntLut, or cMax='n' on a non-WASM host). Loud throw is
//     intentional — see the chain graph in the file header.
//
// ─────────────────────────────────────────────────────────────────
// FUTURE: auto-bench kernel selection (v1.5)
// ─────────────────────────────────────────────────────────────────
// Because every entry's `run` is a uniform-signature closure with
// the SAME args (t, in, out, px, lut, ia, oa, pa), the resolver can
// be extended with a `mode='bench'` that walks the WHOLE chain (not
// just first match), runs each survivor through a 16k-pixel timed
// probe, and picks the MEASURED winner instead of the assumed one.
// The default fallback graph (SIMD > scalar > JS > float) will still
// win 99% of the time — but on hosts where intuition is wrong (SIMD
// bridge cost on Bun, L1-fit pathology, etc.) the bencher quietly
// picks the better path. See the matching TODO in
// Transform._resolveLutKernels for the full sketch.
//
// This function is the natural injection point — bench mode would
// collect candidates from the same chain walk that already powers
// the gate-and-minPx resolution today.

function resolveLutKernel(t, lut, startKey, pixelCountFloor){
    var key = startKey;
    var hops = 0;
    while (key !== null) {
        if (hops++ > 16) {
            throw new Error('lutKernelTable: fallback chain too deep starting at "' + startKey + '" — likely a cycle');
        }
        var entry = KERNEL[key];
        if (entry === undefined) {
            throw new Error('lutKernelTable: missing entry "' + key + '" (chain from "' + startKey + '")');
        }
        if (entry.run !== null && entry.gate(t, lut) && pixelCountFloor >= entry.minPx) {
            return { entry: entry, key: key };
        }
        key = entry.fallback;
    }
    throw new Error('lutKernelTable: fallback chain exhausted from "' + startKey + '" (no float fallback?)');
}

// ---- exports ---------------------------------------------------------------

module.exports = {
    KERNEL: KERNEL,
    LUT_MODE_SHORT: LUT_MODE_SHORT,
    WASM_DISPATCH_MIN_PIXELS: WASM_DISPATCH_MIN_PIXELS,
    makeKey: makeKey,
    resolveLutKernel: resolveLutKernel,
};
