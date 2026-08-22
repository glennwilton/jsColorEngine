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
// wasm_loader.js — WebAssembly kernel loader for jsColorEngine
// ============================================================================
//
// Public API:
//
//   const { createTetra3DState, createTetra3DSimdState,
//           createTetra4DState, createTetra4DSimdState,
//           hasWebAssembly }
//       = require('./wasm/wasm_loader');
//
//   if (!hasWebAssembly()) {
//       // Host has no WebAssembly — caller should demote lutMode to 'int'.
//   }
//
//   const state = createTetra3DState({ wasmCache: sharedCache });
//   // state === null on any instantiation failure — caller should demote.
//
//   const simd = createTetra3DSimdState({ wasmCache: sharedCache });
//   // simd === null on any failure (host lacks SIMD, instantiate throws, ...).
//   // Caller should demote lutMode to 'int-wasm-scalar' and try that.
//
//   const fourD = createTetra4DState({ wasmCache: sharedCache });
//   // fourD === null on any instantiation failure — caller should leave
//   // 4D inputs routed through the JS 'int' kernel.
//
//   state.bind(intLut, pixelCount, cMax);
//   state.runTetra3D(input, 0, output, 0, pixelCount, intLut, cMax);
//
//   fourD.bind(intLut, pixelCount, cMax);
//   fourD.runTetra4D(input, 0, output, 0, pixelCount, intLut, cMax);
//
//   const fourDSimd = createTetra4DSimdState({ wasmCache: sharedCache });
//   // fourDSimd === null when SIMD isn't available (same detect path as
//   // createTetra3DSimdState — module compile throws on hosts without SIMD).
//   // Caller should demote lutMode to 'int-wasm-scalar' and try
//   // createTetra4DState instead.
//   fourDSimd.bind(intLut, pixelCount, cMax);
//   fourDSimd.runTetra4D(input, 0, output, 0, pixelCount, intLut, cMax);
//
// The scalar and SIMD 3D states have identical interfaces. Both are valid
// simultaneously — loading one does not prevent loading the other. The
// two are functionally equivalent (bit-exact outputs across the 6-config
// matrix in bench/wasm_poc/tetra3d_simd_run.js); SIMD is 2.0-2.5× faster
// on cMax ∈ {3, 4}, which is what it supports. Other cMax (1, 2, 5+)
// must route through the scalar state.
//
// The 4D scalar state is a sibling for CMYK-input (inputChannels=4)
// Transforms. Same bind()+run() pattern but its linear-memory layout
// carries a small scratch region (64 B) the kernel uses to pass u20
// intermediates from the K0 plane pass to the K1 plane pass. Bit-exact
// against the JS `_intLut_loop` 4D kernels; measured ~1.22× faster. See
// bench/wasm_poc/tetra4d_nch_run.js and docs/deepdive/Performance.md §1b
// "4D scalar — measured".
//
// The 4D SIMD state is the vectorized companion to 4D scalar. Same
// bind()+run() interface, same kernel signature (scratchPtr is ignored
// — the K0 u20 lives in a v128 register, not in memory). Supports
// cMax ∈ {3, 4}; other cMax must use the scalar 4D state. Bit-exact
// against the scalar 4D kernel; measured avg 2.39× faster than JS int
// and 1.98× faster than 4D scalar WASM. See tetra4d_simd_run.js and
// docs/deepdive/Performance.md §1b "4D SIMD — measured".
//
// Design:
//
// 1. The compiled WebAssembly.Module is expensive (~5 ms first time) and
//    stateless — it's safe to share across any number of Transforms. It is
//    cached in the caller-supplied `wasmCache` bag under a namespaced key.
//    Without a cache bag, each Transform compiles its own copy; V8 has an
//    internal byte-level cache so the cost is low but non-zero.
//
// 2. Each WebAssembly.Instance has its own linear memory. That's what we
//    want — Transforms don't share memory. A Transform with a 1.6 MB LUT
//    bound can't accidentally step on another Transform's output region.
//    It also means `memory.grow` is a per-Transform decision.
//
// 3. Memory layout within one instance:
//
//        [ LUT (u16 CLUT) | input (u8 RGB) | output (u8 nCh) ]
//         ^lutPtr          ^inputPtr        ^outputPtr
//
//    LUT is placed first because it's usually the biggest and the most
//    "sticky" — it gets copied in once at bind() and never again for the
//    lifetime of the (intLut, Transform) binding. Input / output regions
//    grow as pixelCount grows but their contents are rewritten every call.
//
// 4. bind() identity-checks the intLut by reference. If the same intLut
//    object is passed again, we skip the LUT copy. Transforms in typical
//    use bind one LUT for life, so this is the common case.
//
// 5. runTetra3D() assumes bind() has been called with matching
//    (intLut, pixelCount, cMax). The Transform.js dispatcher enforces this.
//
// ============================================================================

'use strict';

// Compiled WASM bytes live beside the kernel that owns them. Compile and
// instantiate go through src/wasm/instantiate.js — the same helper the
// matrix-shaper uses. This file is the tetra State classes plus eight
// thin factories (bytes + export + State).
var instantiateMod          = require('./instantiate.js');
var instantiate             = instantiateMod.instantiate;
var hasWebAssembly          = instantiateMod.hasWebAssembly;
var tetra3dNchBytes         = require('../kernels/3d/tetra3d_nch.wasm.js');
var tetra3dNchInt16Bytes    = require('../kernels/3d/tetra3d_nch_int16.wasm.js');
var tetra3dSimdBytes        = require('../kernels/3d/tetra3d_simd.wasm.js');
var tetra3dSimdInt16Bytes   = require('../kernels/3d/tetra3d_simd_int16.wasm.js');
var tetra4dNchBytes         = require('../kernels/4d/tetra4d_nch.wasm.js');
var tetra4dNchInt16Bytes    = require('../kernels/4d/tetra4d_nch_int16.wasm.js');
var tetra4dSimdBytes        = require('../kernels/4d/tetra4d_simd.wasm.js');
var tetra4dSimdInt16Bytes   = require('../kernels/4d/tetra4d_simd_int16.wasm.js');
var tetra5dNchBytes         = require('../kernels/5d/tetra5d_nch.wasm.js');
var tetra6dNchBytes         = require('../kernels/6d/tetra6d_nch.wasm.js');

var SCALAR_CACHE_KEY         = '__jsColorEngine_tetra3d_nch_module__';
var SCALAR_INT16_CACHE_KEY   = '__jsColorEngine_tetra3d_nch_int16_module__';
var SIMD_CACHE_KEY           = '__jsColorEngine_tetra3d_simd_module__';
var SIMD_INT16_CACHE_KEY     = '__jsColorEngine_tetra3d_simd_int16_module__';
var SCALAR4D_CACHE_KEY       = '__jsColorEngine_tetra4d_nch_module__';
var SCALAR4D_INT16_CACHE_KEY = '__jsColorEngine_tetra4d_nch_int16_module__';
var SIMD4D_CACHE_KEY         = '__jsColorEngine_tetra4d_simd_module__';
var SIMD4D_INT16_CACHE_KEY   = '__jsColorEngine_tetra4d_simd_int16_module__';
var SCALAR5D_CACHE_KEY       = '__jsColorEngine_tetra5d_nch_module__';
var SCALAR6D_CACHE_KEY       = '__jsColorEngine_tetra6d_nch_module__';

function bindKernelExports(state, exports, exportName){
    state.kernelPlain  = (exports && typeof exports[exportName] === 'function')
        ? exports[exportName] : state.kernel;
    state.kernelCached = (exports && typeof exports[exportName + '_cached'] === 'function')
        ? exports[exportName + '_cached'] : null;
    state.kernel = (state.pixelCacheOn && state.kernelCached)
        ? state.kernelCached
        : state.kernelPlain;
}

function setPixelCache(on){
    if(!this.kernelCached){
        this.pixelCacheOn = false;
        if(this.kernelPlain) this.kernel = this.kernelPlain;
        return false;
    }
    this.pixelCacheOn = !!on;
    this.kernel = this.pixelCacheOn ? this.kernelCached : this.kernelPlain;
    return this.pixelCacheOn;
}

function loadState(bytes, cacheKey, exportName, State, isSimd, options){
    var loaded = instantiate(bytes, {
        cache: options && options.wasmCache,
        cacheKey: cacheKey,
        exportName: exportName,
    });
    if(!loaded) return null;
    var state = new State(loaded.exports, loaded.kernel, !!isSimd, loaded.module, exportName);
    state.pixelCacheOn = false;
    bindKernelExports(state, loaded.exports, exportName);
    return state;
}

/**
 * Create per-Transform scalar WASM state. Returns null if WebAssembly
 * isn't available or instantiation fails — callers should then demote
 * lutMode to 'int' and proceed.
 *
 * @param {Object} [options]
 * @param {Object} [options.wasmCache]  Optional shared cache bag for the
 *          compiled WebAssembly.Module. Any plain object works. Module is
 *          stored under a private key; other keys the caller may use on
 *          the bag are untouched.
 *
 * @returns {Tetra3DState|null}
 */
function createTetra3DState(options) {
    return loadState(tetra3dNchBytes, SCALAR_CACHE_KEY, 'interp_tetra3d_nCh',
        Tetra3DState, false, options);
}

/**
 * Create per-Transform scalar WASM state for the **u16 I/O** 3D
 * tetrahedral kernel (`tetra3d_nch_int16.wat`). Returns null on
 * unsupported / failed instantiation — callers should then demote
 * to the JS `int16` kernel.
 *
 * The kernel reads u16 input + writes u16 output, but uses the same
 * intLut.CLUT (u16 store at scale=65280) as the u8 kernel — only
 * `intLut.gridPointsScale_fixed_u16` is passed for the input scale.
 *
 * Identical interface as Tetra3DState — `bind()` + `runTetra3D()`.
 * The state class (Tetra3DInt16State) parameterises bytes-per-
 * channel = 2 throughout, including the alpha tail.
 *
 * Sibling of createTetra3DState (u8 I/O); both can coexist and share
 * a single `wasmCache` bag — distinct cache keys.
 *
 * @param {Object} [options]
 * @param {Object} [options.wasmCache]  Optional shared cache bag.
 * @returns {Tetra3DInt16State|null}
 */
function createTetra3DInt16State(options) {
    return loadState(tetra3dNchInt16Bytes, SCALAR_INT16_CACHE_KEY, 'interp_tetra3d_nCh_int16',
        Tetra3DInt16State, false, options);
}

/**
 * Create per-Transform SIMD WASM state for the **u16 I/O** 3D
 * tetrahedral kernel (`tetra3d_simd_int16.wat`). Returns null when
 * WebAssembly SIMD isn't supported by the host (module compile throws —
 * same detect path as createTetra3DSimdState) or instantiation
 * otherwise fails. Callers should then demote lutMode from
 * 'int16-wasm-simd' to 'int16-wasm-scalar' and try
 * createTetra3DInt16State() instead.
 *
 * Only supports cMax ∈ {3, 4}. Callers with cMax outside that range
 * should route through the scalar u16 state; see
 * createTetra3DInt16State().
 *
 * Bit-exact with the scalar u16 3D kernel (Q0.13, no precision
 * trade-off vs scalar — SIMD is a pure speed lift). Same wrapper
 * class as scalar (Tetra3DInt16State) parameterised by isSimd=true,
 * which adds 4 bytes of output-tail slack in bind() to absorb the
 * v128.store64_lane overrun on cMax=3.
 *
 * @param {Object} [options]
 * @param {Object} [options.wasmCache]  Optional shared cache bag.
 *          Uses a different key from the scalar u16 kernel so all
 *          eight modules (3D scalar/SIMD u8/u16, 4D scalar/SIMD
 *          u8/u16) coexist in the same bag.
 *
 * @returns {Tetra3DInt16State|null}
 */
function createTetra3DInt16SimdState(options) {
    return loadState(tetra3dSimdInt16Bytes, SIMD_INT16_CACHE_KEY, 'interp_tetra3d_simd_int16',
        Tetra3DInt16State, true, options);
}

/**
 * Create per-Transform SIMD WASM state. Returns null if WebAssembly
 * SIMD isn't supported by the host (module compile throws), or if
 * instantiation otherwise fails. Callers should then demote lutMode
 * from 'int-wasm-simd' to 'int-wasm-scalar' and try that factory.
 *
 * Only supports cMax ∈ {3, 4}. Callers with cMax outside that range
 * should route through a scalar state; see createTetra3DState().
 *
 * @param {Object} [options]
 * @param {Object} [options.wasmCache]  Optional shared cache bag, as
 *          for createTetra3DState(). Uses a different cache key so the
 *          two modules coexist in the same bag.
 *
 * @returns {Tetra3DState|null}
 */
function createTetra3DSimdState(options) {
    return loadState(tetra3dSimdBytes, SIMD_CACHE_KEY, 'interp_tetra3d_simd',
        Tetra3DState, true, options);
}

/**
 * Create per-Transform scalar WASM state for the 4D (CMYK input)
 * tetrahedral kernel. Returns null if WebAssembly isn't available or
 * instantiation fails — callers should then keep 4D inputs on the JS
 * 'int' path (no functional difference, just loses the ~1.22× WASM
 * speedup).
 *
 * Supports any cMax >= 1; same rolled n-channel kernel as tetra3d_nch
 * with the K-axis setup hoisted and a flag-gated K-plane loop. See
 * docs/deepdive/Performance.md §1b "4D scalar — measured" for design notes.
 *
 * @param {Object} [options]
 * @param {Object} [options.wasmCache]  Optional shared cache bag, as
 *          for createTetra3DState(). Uses a different cache key so the
 *          three modules (3D scalar, 3D SIMD, 4D scalar) coexist in
 *          the same bag.
 *
 * @returns {Tetra4DState|null}
 */
function createTetra4DState(options) {
    return loadState(tetra4dNchBytes, SCALAR4D_CACHE_KEY, 'interp_tetra4d_nCh',
        Tetra4DState, false, options);
}

/**
 * Create per-Transform scalar WASM state for the **u16 I/O** 4D
 * (CMYK input) tetrahedral kernel (`tetra4d_nch_int16.wat`). Returns
 * null on unsupported / failed instantiation — callers should then
 * demote to the JS `int16` kernel for 4D inputs.
 *
 * Sibling of createTetra4DState (u8 I/O) and createTetra3DInt16State
 * (3D u16). All three coexist in the same wasmCache bag — distinct
 * cache keys.
 *
 * Same intLut.CLUT (u16 store at scale=65280) as the u8 4D kernel —
 * only `intLut.gridPointsScale_fixed_u16` is passed for the input
 * scale. The state class (Tetra4DInt16State) parameterises bytes-
 * per-channel = 2 throughout, including the alpha tail.
 *
 * @param {Object} [options]
 * @param {Object} [options.wasmCache]  Optional shared cache bag.
 * @returns {Tetra4DInt16State|null}
 */
function createTetra4DInt16State(options) {
    return loadState(tetra4dNchInt16Bytes, SCALAR4D_INT16_CACHE_KEY, 'interp_tetra4d_nCh_int16',
        Tetra4DInt16State, false, options);
}

/**
 * Create per-Transform SIMD WASM state for the **u16 I/O** 4D
 * (CMYK input) tetrahedral kernel (`tetra4d_simd_int16.wat`).
 * Returns null when WebAssembly SIMD isn't supported by the host
 * (module compile throws — same detect path as createTetra4DSimdState)
 * or instantiation otherwise fails. Callers should then demote
 * lutMode from 'int16-wasm-simd' to 'int16-wasm-scalar' and try
 * createTetra4DInt16State() instead.
 *
 * Only supports cMax ∈ {3, 4}. Same isSimd=true wrapper as the 3D
 * sibling — bind() adds 4 bytes output-tail slack to absorb the
 * v128.store64_lane overrun on cMax=3.
 *
 * Bit-exact with the scalar u16 4D kernel (Q0.13 + two-rounding K-LERP).
 * Crucially, the SIMD kernel keeps the K0 intermediate in a v128
 * local register and ignores $scratchPtr — no scratch round-trip
 * through linear memory like the scalar 4D u16 kernel needs.
 *
 * @param {Object} [options]
 * @param {Object} [options.wasmCache]  Optional shared cache bag.
 *          Uses a different key from the other seven kernel modules
 *          so all eight (3D scalar/SIMD u8/u16, 4D scalar/SIMD u8/u16)
 *          coexist in the same bag.
 *
 * @returns {Tetra4DInt16State|null}
 */
function createTetra4DInt16SimdState(options) {
    return loadState(tetra4dSimdInt16Bytes, SIMD4D_INT16_CACHE_KEY, 'interp_tetra4d_simd_int16',
        Tetra4DInt16State, true, options);
}

/**
 * Create per-Transform SIMD WASM state for the 4D (CMYK input)
 * tetrahedral kernel. Returns null when WebAssembly SIMD isn't
 * available on the host (module compile throws — same detect path as
 * createTetra3DSimdState) or instantiation otherwise fails. Callers
 * should then demote lutMode to 'int-wasm-scalar' and try
 * createTetra4DState() instead.
 *
 * Only supports cMax ∈ {3, 4}. Callers with cMax outside that range
 * (rare for 4D LUTs in real ICC pipelines) should fall back to the
 * scalar 4D state.
 *
 * @param {Object} [options]
 * @param {Object} [options.wasmCache]  Optional shared cache bag.
 *          Uses a different key from the other three kernels so all
 *          four modules coexist in the same bag.
 *
 * @returns {Tetra4DState|null}
 */
function createTetra4DSimdState(options) {
    return loadState(tetra4dSimdBytes, SIMD4D_CACHE_KEY, 'interp_tetra4d_simd',
        Tetra4DState, true, options);
}

// ---------------------------------------------------------------------------
// Tetra3DState — per-instance memory layout + kernel call wrapper
// ---------------------------------------------------------------------------

function Tetra3DState(exports, kernel, isSimd, module, kernelName) {
    this.exports      = exports;
    this.memory       = exports.memory;
    this.kernel       = kernel;
    this.isSimd       = !!isSimd;
    this.module       = module || null;
    this.kernelName   = kernelName || '';
    this.shrinkRatio  = 0;    // 0 = disabled; e.g. 4 = compact when memory > 4× needed
    this.maxMemory    = 0;    // 0 = disabled; bytes — compact when buffer exceeds this
    this.lutPtr       = 0;
    this.inputPtr     = 0;
    this.outputPtr    = 0;
    this.lutBytes     = 0;
    this.boundIntLut  = null;
    this.reservedCap  = 0;

    // Monotonically increasing count of runTetra3D() calls. Intended for
    // tests (to prove the WASM kernel actually ran, not just that outputs
    // happen to match the 'int' JS kernel bit-exactly) and diagnostics.
    // Zero cost in production code — one i32 increment per dispatch.
    //
    // Tests assert with the pattern:
    //   const before = t.wasmTetra3D.dispatchCount;
    //   t.transformArray(...);
    //   expect(t.wasmTetra3D.dispatchCount).toBeGreaterThan(before);
    //
    // Without this counter, a silent demotion (WASM compile failure at
    // create() time falling back to 'int' JS) would leave every
    // bit-exact-vs-'int' test passing while the WASM path was never
    // exercised in CI.
    this.dispatchCount = 0;
}

/**
 * Post-run check: compact if memory exceeds maxMemory or shrinkRatio
 * relative to what was last bound. Called by Transform after each
 * transformArrayViaLUT. Cost: one byteLength read + two comparisons.
 */
Tetra3DState.prototype.compactIfNeeded = function () {
    var bytes = this.memory.buffer.byteLength;
    if (this.maxMemory > 0 && bytes > this.maxMemory) {
        this.compact();
    } else if (this.shrinkRatio > 0) {
        var pagesHave   = (bytes / 65536) | 0;
        var pagesNeeded = Math.ceil((this.lutBytes + this.reservedCap) / 65536);
        if (pagesHave > pagesNeeded * this.shrinkRatio) {
            this.compact();
        }
    }
};

/**
 * Re-instantiate from the stored Module, releasing old linear memory.
 * The old Instance (and its potentially-large memory) becomes eligible
 * for GC. The new Instance starts with 1 page (64 KB); next bind()
 * grows it to exactly what's needed. Cost: ~0.1 ms (instantiation
 * from a compiled Module is near-free).
 */
Tetra3DState.prototype.compact = function () {
    if (!this.module) return;
    var instance = new WebAssembly.Instance(this.module, {});
    this.exports     = instance.exports;
    this.memory      = instance.exports.memory;
    bindKernelExports(this, instance.exports, this.kernelName);
    this.boundIntLut = null;
    this.lutBytes    = 0;
    this.reservedCap = 0;
    this.lutPtr      = 0;
    this.inputPtr    = 0;
    this.outputPtr   = 0;
};

Tetra3DState.prototype.setPixelCache = setPixelCache;

/**
 * Ensure linear memory is big enough for this (intLut, pixelCount, cMax,
 * inBPP, outBPP) shape and that the LUT is copied in. Fast re-entry
 * when called with the same binding (common case: same LUT, same pixel
 * count, same alpha shape).
 *
 * inBPP / outBPP default to (3, cMax) — i.e. no alpha. Pass 4 / cMax+1
 * when alpha is present on either side.
 */
Tetra3DState.prototype.bind = function (intLut, pixelCount, cMax, inBPP, outBPP) {
    if (inBPP  === undefined) inBPP  = 3;
    if (outBPP === undefined) outBPP = cMax;
    var lutBytes    = intLut.CLUT.byteLength;
    var inputBytes  = pixelCount * inBPP;
    var outputBytes = pixelCount * outBPP;

    var outputTail = this.isSimd ? 4 : 0;

    var lutPtr      = 0;
    var lutAligned  = (lutBytes + 7) & ~7;
    var inputPtr    = lutPtr + lutAligned;
    var inputEnd    = inputPtr + ((inputBytes + 7) & ~7);
    var outputPtr   = inputEnd;
    var totalBytes  = outputPtr + outputBytes + outputTail;

    var pagesNeeded = Math.ceil(totalBytes / 65536);
    var pagesHave   = (this.memory.buffer.byteLength / 65536) | 0;

    if (pagesHave < pagesNeeded) {
        this.memory.grow(pagesNeeded - pagesHave);
    }

    // LUT identity check — skip the u16 copy when the same LUT is rebound.
    // This is the whole point of bind() being separate from runTetra3D().
    if (this.boundIntLut !== intLut || this.lutBytes !== lutBytes) {
        var memU16 = new Uint16Array(this.memory.buffer);
        memU16.set(intLut.CLUT, lutPtr >> 1);
        this.boundIntLut = intLut;
        this.lutBytes    = lutBytes;
    }

    this.lutPtr      = lutPtr;
    this.inputPtr    = inputPtr;
    this.outputPtr   = outputPtr;
    this.reservedCap = inputBytes + outputBytes;
};

/**
 * Run the 3D tetrahedral kernel. bind() must have been called first with
 * matching (intLut, pixelCount, cMax, inBPP, outBPP). Input is copied
 * into WASM memory at this.inputPtr; output is copied out from
 * this.outputPtr.
 *
 * Alpha handling mirrors the JS 'int' kernel exactly:
 *
 *   if (preserveAlpha)     { output-alpha = input-alpha; }
 *   else if (outputAlpha)  { if (inputAlpha) skip;  output-alpha = 255; }
 *   else if (inputAlpha)   { skip; }
 *
 * preserveAlpha requires inputHasAlpha && outputHasAlpha — validation
 * happens in the Transform dispatcher; we just do what we're told.
 */
Tetra3DState.prototype.runTetra3D = function (
    input, inputPos, output, outputPos, pixelCount, intLut, cMax,
    inputHasAlpha, outputHasAlpha, preserveAlpha
) {
    // Map JS booleans → the WASM kernel's two numeric args.
    //
    //   inAlphaSkip   : bytes to advance input past RGB per pixel (0 or 1)
    //   outAlphaMode  : 0 none, 1 fill-255, 2 preserve-copy
    var inAlphaSkip  = inputHasAlpha ? 1 : 0;
    var outAlphaMode = 0;
    if (preserveAlpha) {
        // The preserve-copy branch inside the kernel reads input[inputPos]
        // and advances both pointers, so inAlphaSkip is irrelevant in that
        // path — the kernel's (else) leg is what consumes it.
        outAlphaMode = 2;
    } else if (outputHasAlpha) {
        outAlphaMode = 1;
    }

    var inBPP       = inputHasAlpha  ? 4 : 3;
    var outBPP      = outputHasAlpha ? cMax + 1 : cMax;
    var inputBytes  = pixelCount * inBPP;
    var outputBytes = pixelCount * outBPP;
    var buf         = this.memory.buffer;

    // -- Copy input into WASM linear memory ---------------------------------
    // Uint8Array / Uint8ClampedArray → use .set() which memcpy's underneath.
    // Any other array-like → scalar loop (correctness first; this path is
    // rare for the LUT hot-path and can be optimised later if profiled).
    var memU8 = new Uint8Array(buf);
    if (input instanceof Uint8Array || input instanceof Uint8ClampedArray) {
        memU8.set(input.subarray(inputPos, inputPos + inputBytes), this.inputPtr);
    } else {
        for (var i = 0; i < inputBytes; i++) {
            memU8[this.inputPtr + i] = input[inputPos + i] & 0xFF;
        }
    }

    // -- Call kernel --------------------------------------------------------
    this.kernel(
        this.inputPtr, this.outputPtr, this.lutPtr,
        pixelCount, cMax,
        intLut.go0, intLut.go1, intLut.go2,
        intLut.gridPointsScale_fixed,
        intLut.maxX, intLut.maxY, intLut.maxZ,
        inAlphaSkip, outAlphaMode
    );
    this.dispatchCount++;

    // -- Copy output out of WASM linear memory ------------------------------
    // The WASM memory.buffer reference above may have been detached by a
    // memory.grow inside the kernel (the kernel doesn't grow, but be safe).
    // Re-grab the byte view after the call.
    var outView = new Uint8Array(this.memory.buffer, this.outputPtr, outputBytes);
    if (output instanceof Uint8Array || output instanceof Uint8ClampedArray) {
        output.set(outView, outputPos);
    } else {
        for (var j = 0; j < outputBytes; j++) {
            output[outputPos + j] = outView[j];
        }
    }
};

// ---------------------------------------------------------------------------
// Tetra3DInt16State — per-instance state for the u16-I/O 3D scalar kernel
// ---------------------------------------------------------------------------
//
// Identical layout / lifecycle to Tetra3DState; differences are only at
// the I/O width:
//
//   - bytes per channel = 2 (u16) on BOTH input and output, including
//     the alpha tail
//   - input  copy uses Uint16Array view of memory.buffer
//   - output copy uses Uint16Array view of memory.buffer
//   - kernel takes intLut.gridPointsScale_fixed_u16 (NOT *_fixed) — the
//     dispatcher is responsible for passing the right field
//
// The state class is a separate clone (not a parameterised Tetra3DState)
// to keep the u8 hot path completely unchanged — zero risk of perf
// regression on the v1.2 default kernel from this v1.3 work.

function Tetra3DInt16State(exports, kernel, isSimd, module, kernelName) {
    this.exports       = exports;
    this.memory        = exports.memory;
    this.kernel        = kernel;
    this.isSimd        = !!isSimd;
    this.module        = module || null;
    this.kernelName    = kernelName || '';
    this.shrinkRatio   = 0;
    this.maxMemory     = 0;
    this.lutPtr        = 0;
    this.inputPtr      = 0;
    this.outputPtr     = 0;
    this.lutBytes      = 0;
    this.boundIntLut   = null;
    this.reservedCap   = 0;
    this.dispatchCount = 0;
}

Tetra3DInt16State.prototype.compact = Tetra3DState.prototype.compact;
Tetra3DInt16State.prototype.compactIfNeeded = Tetra3DState.prototype.compactIfNeeded;

/**
 * inBPP / outBPP defaults assume no alpha — 6 bytes (3 × u16) input
 * and `cMax * 2` bytes output. Pass 8 / (cMax+1)*2 when alpha is
 * present on either side.
 */
Tetra3DInt16State.prototype.bind = function (intLut, pixelCount, cMax, inBPP, outBPP) {
    if (inBPP  === undefined) inBPP  = 6;
    if (outBPP === undefined) outBPP = cMax * 2;
    var lutBytes    = intLut.CLUT.byteLength;
    var inputBytes  = pixelCount * inBPP;
    var outputBytes = pixelCount * outBPP;

    var outputTail = this.isSimd ? 4 : 0;

    var lutPtr      = 0;
    var lutAligned  = (lutBytes + 7) & ~7;
    var inputPtr    = lutPtr + lutAligned;
    var inputEnd    = inputPtr + ((inputBytes + 7) & ~7);
    var outputPtr   = inputEnd;
    var totalBytes  = outputPtr + outputBytes + outputTail;

    var pagesNeeded = Math.ceil(totalBytes / 65536);
    var pagesHave   = (this.memory.buffer.byteLength / 65536) | 0;

    if (pagesHave < pagesNeeded) {
        this.memory.grow(pagesNeeded - pagesHave);
    }

    if (this.boundIntLut !== intLut || this.lutBytes !== lutBytes) {
        var memU16 = new Uint16Array(this.memory.buffer);
        memU16.set(intLut.CLUT, lutPtr >> 1);
        this.boundIntLut = intLut;
        this.lutBytes    = lutBytes;
    }

    this.lutPtr      = lutPtr;
    this.inputPtr    = inputPtr;
    this.outputPtr   = outputPtr;
    this.reservedCap = inputBytes + outputBytes;
};

/**
 * Run the 3D u16 tetrahedral kernel. bind() must have been called
 * first with matching (intLut, pixelCount, cMax, inBPP, outBPP).
 *
 * Alpha handling matches the u8 state exactly (three modes), with
 * one difference: alpha samples are u16 (2 bytes), so $inAlphaSkip
 * is 0 or 1 *samples* and the kernel internally shifts by 1 to get
 * bytes.
 */
Tetra3DInt16State.prototype.runTetra3D = function (
    input, inputPos, output, outputPos, pixelCount, intLut, cMax,
    inputHasAlpha, outputHasAlpha, preserveAlpha
) {
    var inAlphaSkip  = inputHasAlpha ? 1 : 0;
    var outAlphaMode = 0;
    if (preserveAlpha) {
        outAlphaMode = 2;
    } else if (outputHasAlpha) {
        outAlphaMode = 1;
    }

    var inSamples   = inputHasAlpha  ? 4 : 3;
    var outSamples  = outputHasAlpha ? cMax + 1 : cMax;
    var inputBytes  = pixelCount * inSamples  * 2;
    var outputBytes = pixelCount * outSamples * 2;
    var buf         = this.memory.buffer;

    // -- Copy input into WASM linear memory (u16 view) ---------------------
    if (input instanceof Uint16Array) {
        var memU16In = new Uint16Array(buf);
        memU16In.set(input.subarray(inputPos, inputPos + pixelCount * inSamples), this.inputPtr >> 1);
    } else {
        // Fallback: arbitrary array-like → scalar u16 store loop.
        var memU8 = new Uint8Array(buf);
        for (var i = 0; i < pixelCount * inSamples; i++) {
            var v = input[inputPos + i] & 0xFFFF;
            memU8[this.inputPtr + i * 2    ] =  v        & 0xFF;
            memU8[this.inputPtr + i * 2 + 1] = (v >>> 8) & 0xFF;
        }
    }

    // -- Call kernel -------------------------------------------------------
    this.kernel(
        this.inputPtr, this.outputPtr, this.lutPtr,
        pixelCount, cMax,
        intLut.go0, intLut.go1, intLut.go2,
        intLut.gridPointsScale_fixed_u16,
        intLut.maxX, intLut.maxY, intLut.maxZ,
        inAlphaSkip, outAlphaMode
    );
    this.dispatchCount++;

    // -- Copy output out of WASM linear memory (u16 view) ------------------
    var outView = new Uint16Array(this.memory.buffer, this.outputPtr, pixelCount * outSamples);
    if (output instanceof Uint16Array) {
        output.set(outView, outputPos);
    } else {
        for (var j = 0; j < pixelCount * outSamples; j++) {
            output[outputPos + j] = outView[j];
        }
    }
};

// ---------------------------------------------------------------------------
// Tetra4DState — per-instance memory layout + kernel call wrapper (4D)
// ---------------------------------------------------------------------------
//
// Differences vs Tetra3DState:
//   - Input stride is 4 bytes per pixel (KCMY) vs 3 (RGB); alpha adds 1.
//   - Memory layout carries a trailing 4-byte-aligned scratch region:
//       [ LUT | input | output | scratch ]
//     The kernel uses scratch to pass u20 intermediates from the K0-plane
//     pass to the K1-plane pass (per pixel; overwritten each iteration;
//     see tetra4d_nch.wat). 64 bytes is the floor (aligns cleanly and
//     covers cMax ≤ 16 which already bounds every realistic ICC LUT).
//   - Kernel takes 3 extra args: go3 (K-axis stride in u16 LUT units),
//     maxK (K grid upper bound), scratchPtr.
//
// Everything else (dispatch counter, LUT identity-check re-bind fast path,
// memory.buffer detach-safety on the output copy-out) is the same as 3D.
// Common scaffolding isn't factored out — the two states have enough
// 4D-specific surface area (extra kernel args, scratch region, input
// stride) that a shared parent would end up mostly conditionals.

function Tetra4DState(exports, kernel, isSimd, module, kernelName) {
    this.exports       = exports;
    this.memory        = exports.memory;
    this.kernel        = kernel;
    this.isSimd        = !!isSimd;
    this.module        = module || null;
    this.kernelName    = kernelName || '';
    this.shrinkRatio   = 0;
    this.maxMemory     = 0;
    this.lutPtr        = 0;
    this.inputPtr      = 0;
    this.outputPtr     = 0;
    this.scratchPtr    = 0;
    this.lutBytes      = 0;
    this.boundIntLut   = null;
    this.reservedCap   = 0;
    this.dispatchCount = 0;
}

Tetra4DState.prototype.compact = function () {
    if (!this.module) return;
    var instance = new WebAssembly.Instance(this.module, {});
    this.exports     = instance.exports;
    this.memory      = instance.exports.memory;
    bindKernelExports(this, instance.exports, this.kernelName);
    this.boundIntLut = null;
    this.lutBytes    = 0;
    this.reservedCap = 0;
    this.lutPtr      = 0;
    this.inputPtr    = 0;
    this.outputPtr   = 0;
    this.scratchPtr  = 0;
};

Tetra4DState.prototype.setPixelCache = setPixelCache;

Tetra4DState.prototype.compactIfNeeded = Tetra3DState.prototype.compactIfNeeded;
Tetra4DState.SCRATCH_BYTES = 64;

/**
 * Ensure linear memory is big enough for this (intLut, pixelCount, cMax,
 * inBPP, outBPP) shape and that the LUT is copied in.
 *
 * inBPP  defaults to 4 (KCMY, no alpha). Pass 5 for KCMYA.
 * outBPP defaults to cMax (no output alpha). Pass cMax+1 for alpha.
 */
Tetra4DState.prototype.bind = function (intLut, pixelCount, cMax, inBPP, outBPP) {
    if (inBPP  === undefined) inBPP  = 4;
    if (outBPP === undefined) outBPP = cMax;
    var lutBytes    = intLut.CLUT.byteLength;
    var inputBytes  = pixelCount * inBPP;
    var outputBytes = pixelCount * outBPP;
    var scratchBytes = Tetra4DState.SCRATCH_BYTES;

    var outputTail = this.isSimd ? 4 : 0;

    var lutPtr      = 0;
    var lutAligned  = (lutBytes + 7) & ~7;
    var inputPtr    = lutPtr + lutAligned;
    var inputEnd    = inputPtr + ((inputBytes + 7) & ~7);
    var outputPtr   = inputEnd;
    var outputEnd   = outputPtr + ((outputBytes + outputTail + 3) & ~3);
    var scratchPtr  = outputEnd;
    var totalBytes  = scratchPtr + scratchBytes;

    var pagesNeeded = Math.ceil(totalBytes / 65536);
    var pagesHave   = (this.memory.buffer.byteLength / 65536) | 0;

    if (pagesHave < pagesNeeded) {
        this.memory.grow(pagesNeeded - pagesHave);
    }

    if (this.boundIntLut !== intLut || this.lutBytes !== lutBytes) {
        var memU16 = new Uint16Array(this.memory.buffer);
        memU16.set(intLut.CLUT, lutPtr >> 1);
        this.boundIntLut = intLut;
        this.lutBytes    = lutBytes;
    }

    this.lutPtr      = lutPtr;
    this.inputPtr    = inputPtr;
    this.outputPtr   = outputPtr;
    this.scratchPtr  = scratchPtr;
    this.reservedCap = inputBytes + outputBytes;
};

/**
 * Run the 4D tetrahedral kernel. bind() must have been called first
 * with matching (intLut, pixelCount, cMax, inBPP, outBPP). Input is
 * copied into WASM memory at this.inputPtr; output is copied out from
 * this.outputPtr.
 *
 * Alpha handling mirrors the 3D state exactly (same three modes).
 * inputHasAlpha makes input stride 5 (KCMYA); outputHasAlpha makes
 * output stride cMax+1.
 */
Tetra4DState.prototype.runTetra4D = function (
    input, inputPos, output, outputPos, pixelCount, intLut, cMax,
    inputHasAlpha, outputHasAlpha, preserveAlpha
) {
    var inAlphaSkip  = inputHasAlpha ? 1 : 0;
    var outAlphaMode = 0;
    if (preserveAlpha) {
        outAlphaMode = 2;
    } else if (outputHasAlpha) {
        outAlphaMode = 1;
    }

    var inBPP       = inputHasAlpha  ? 5 : 4;
    var outBPP      = outputHasAlpha ? cMax + 1 : cMax;
    var inputBytes  = pixelCount * inBPP;
    var outputBytes = pixelCount * outBPP;
    var buf         = this.memory.buffer;

    var memU8 = new Uint8Array(buf);
    if (input instanceof Uint8Array || input instanceof Uint8ClampedArray) {
        memU8.set(input.subarray(inputPos, inputPos + inputBytes), this.inputPtr);
    } else {
        for (var i = 0; i < inputBytes; i++) {
            memU8[this.inputPtr + i] = input[inputPos + i] & 0xFF;
        }
    }

    this.kernel(
        this.inputPtr, this.outputPtr, this.lutPtr,
        pixelCount, cMax,
        intLut.go0, intLut.go1, intLut.go2, intLut.go3,
        intLut.gridPointsScale_fixed,
        intLut.maxX, intLut.maxY, intLut.maxZ, intLut.maxK,
        this.scratchPtr,
        inAlphaSkip, outAlphaMode
    );
    this.dispatchCount++;

    var outView = new Uint8Array(this.memory.buffer, this.outputPtr, outputBytes);
    if (output instanceof Uint8Array || output instanceof Uint8ClampedArray) {
        output.set(outView, outputPos);
    } else {
        for (var j = 0; j < outputBytes; j++) {
            output[outputPos + j] = outView[j];
        }
    }
};

// ---------------------------------------------------------------------------
// Tetra4DInt16State — per-instance state for the u16-I/O 4D scalar kernel
// ---------------------------------------------------------------------------
//
// Hybrid of Tetra4DState (4D-ness: scratchPtr, go3, maxK) and
// Tetra3DInt16State (u16 I/O: 2-byte channels, Uint16Array memcpy,
// gridPointsScale_fixed_u16). Same lifecycle (bind() then runTetra4D())
// and same alpha contract.
//
// The state class is a separate clone (not a parameterised Tetra4DState)
// to keep the u8 4D hot path completely unchanged.

function Tetra4DInt16State(exports, kernel, isSimd, module, kernelName) {
    this.exports       = exports;
    this.memory        = exports.memory;
    this.kernel        = kernel;
    this.isSimd        = !!isSimd;
    this.module        = module || null;
    this.kernelName    = kernelName || '';
    this.shrinkRatio   = 0;
    this.maxMemory     = 0;
    this.lutPtr        = 0;
    this.inputPtr      = 0;
    this.outputPtr     = 0;
    this.scratchPtr    = 0;
    this.lutBytes      = 0;
    this.boundIntLut   = null;
    this.reservedCap   = 0;
    this.dispatchCount = 0;
}

Tetra4DInt16State.prototype.compact = Tetra4DState.prototype.compact;
Tetra4DInt16State.prototype.compactIfNeeded = Tetra3DState.prototype.compactIfNeeded;

// Scratch region size in bytes (scalar 4D u16 K0-plane intermediate
// buffer, see tetra4d_nch_int16.wat). The SIMD 4D u16 kernel keeps
// the K0 intermediate in a v128 local register and ignores
// $scratchPtr — but we still allocate the region so the same bind()
// layout works for both scalar and SIMD without a branch on isSimd
// here.
Tetra4DInt16State.SCRATCH_BYTES = 64;

/**
 * inBPP / outBPP defaults assume no alpha — 8 bytes (4 × u16) input
 * and `cMax * 2` bytes output. Pass 10 / (cMax+1)*2 when alpha is
 * present on either side.
 */
Tetra4DInt16State.prototype.bind = function (intLut, pixelCount, cMax, inBPP, outBPP) {
    if (inBPP  === undefined) inBPP  = 8;
    if (outBPP === undefined) outBPP = cMax * 2;
    var lutBytes     = intLut.CLUT.byteLength;
    var inputBytes   = pixelCount * inBPP;
    var outputBytes  = pixelCount * outBPP;
    var scratchBytes = Tetra4DInt16State.SCRATCH_BYTES;

    var outputTail   = this.isSimd ? 4 : 0;

    var lutPtr      = 0;
    var lutAligned  = (lutBytes + 7) & ~7;
    var inputPtr    = lutPtr + lutAligned;
    var inputEnd    = inputPtr + ((inputBytes + 7) & ~7);
    var outputPtr   = inputEnd;
    var outputEnd   = outputPtr + ((outputBytes + outputTail + 3) & ~3);
    var scratchPtr  = outputEnd;
    var totalBytes  = scratchPtr + scratchBytes;

    var pagesNeeded = Math.ceil(totalBytes / 65536);
    var pagesHave   = (this.memory.buffer.byteLength / 65536) | 0;

    if (pagesHave < pagesNeeded) {
        this.memory.grow(pagesNeeded - pagesHave);
    }

    if (this.boundIntLut !== intLut || this.lutBytes !== lutBytes) {
        var memU16 = new Uint16Array(this.memory.buffer);
        memU16.set(intLut.CLUT, lutPtr >> 1);
        this.boundIntLut = intLut;
        this.lutBytes    = lutBytes;
    }

    this.lutPtr      = lutPtr;
    this.inputPtr    = inputPtr;
    this.outputPtr   = outputPtr;
    this.scratchPtr  = scratchPtr;
    this.reservedCap = inputBytes + outputBytes;
};

/**
 * Run the 4D u16 tetrahedral kernel. bind() must have been called
 * first with matching (intLut, pixelCount, cMax, inBPP, outBPP).
 *
 * Alpha handling matches the u8 4D state exactly (three modes), with
 * one difference: alpha samples are u16 (2 bytes), so $inAlphaSkip
 * is 0 or 1 *samples* and the kernel internally shifts by 1 to get
 * bytes.
 */
Tetra4DInt16State.prototype.runTetra4D = function (
    input, inputPos, output, outputPos, pixelCount, intLut, cMax,
    inputHasAlpha, outputHasAlpha, preserveAlpha
) {
    var inAlphaSkip  = inputHasAlpha ? 1 : 0;
    var outAlphaMode = 0;
    if (preserveAlpha) {
        outAlphaMode = 2;
    } else if (outputHasAlpha) {
        outAlphaMode = 1;
    }

    var inSamples   = inputHasAlpha  ? 5 : 4;     // KCMY [+A]
    var outSamples  = outputHasAlpha ? cMax + 1 : cMax;
    var inputBytes  = pixelCount * inSamples  * 2;
    var outputBytes = pixelCount * outSamples * 2;
    var buf         = this.memory.buffer;

    if (input instanceof Uint16Array) {
        var memU16In = new Uint16Array(buf);
        memU16In.set(input.subarray(inputPos, inputPos + pixelCount * inSamples), this.inputPtr >> 1);
    } else {
        var memU8 = new Uint8Array(buf);
        for (var i = 0; i < pixelCount * inSamples; i++) {
            var v = input[inputPos + i] & 0xFFFF;
            memU8[this.inputPtr + i * 2    ] =  v        & 0xFF;
            memU8[this.inputPtr + i * 2 + 1] = (v >>> 8) & 0xFF;
        }
    }

    this.kernel(
        this.inputPtr, this.outputPtr, this.lutPtr,
        pixelCount, cMax,
        intLut.go0, intLut.go1, intLut.go2, intLut.go3,
        intLut.gridPointsScale_fixed_u16,
        intLut.maxX, intLut.maxY, intLut.maxZ, intLut.maxK,
        this.scratchPtr,
        inAlphaSkip, outAlphaMode
    );
    this.dispatchCount++;

    var outView = new Uint16Array(this.memory.buffer, this.outputPtr, pixelCount * outSamples);
    if (output instanceof Uint16Array) {
        output.set(outView, outputPos);
    } else {
        for (var j = 0; j < pixelCount * outSamples; j++) {
            output[outputPos + j] = outView[j];
        }
    }
};

// ---------------------------------------------------------------------------
// Tetra5DState / Tetra6DState — extra peel planes, same bind/run as 4D scalar
// ---------------------------------------------------------------------------

function Tetra5DState(exports, kernel, isSimd, module, kernelName) {
    Tetra4DState.call(this, exports, kernel, isSimd, module, kernelName);
}
Tetra5DState.prototype = Object.create(Tetra4DState.prototype);
Tetra5DState.prototype.constructor = Tetra5DState;
Tetra5DState.SCRATCH_BYTES = 64;

Tetra5DState.prototype.bind = function (intLut, pixelCount, cMax, inBPP, outBPP) {
    if (inBPP  === undefined) inBPP  = 5;
    if (outBPP === undefined) outBPP = cMax;
    var scratchBytes = Math.max(Tetra5DState.SCRATCH_BYTES, cMax * 8);
    return bindNd(this, intLut, pixelCount, cMax, inBPP, outBPP, scratchBytes);
};

Tetra5DState.prototype.runTetra5D = function (
    input, inputPos, output, outputPos, pixelCount, intLut, cMax,
    inputHasAlpha, outputHasAlpha, preserveAlpha
) {
    runNd(this, input, inputPos, output, outputPos, pixelCount, intLut, cMax,
        inputHasAlpha, outputHasAlpha, preserveAlpha, 5, function (self, inAlphaSkip, outAlphaMode) {
            self.kernel(
                self.inputPtr, self.outputPtr, self.lutPtr,
                pixelCount, cMax,
                intLut.go0, intLut.go1, intLut.go2, intLut.go3,
                intLut.gridPointsScale_fixed,
                intLut.maxX, intLut.maxY, intLut.maxZ, intLut.maxK,
                intLut.go4, intLut.maxE,
                self.scratchPtr,
                inAlphaSkip, outAlphaMode
            );
        });
};

function Tetra6DState(exports, kernel, isSimd, module, kernelName) {
    Tetra4DState.call(this, exports, kernel, isSimd, module, kernelName);
}
Tetra6DState.prototype = Object.create(Tetra4DState.prototype);
Tetra6DState.prototype.constructor = Tetra6DState;
Tetra6DState.SCRATCH_BYTES = 64;

Tetra6DState.prototype.bind = function (intLut, pixelCount, cMax, inBPP, outBPP) {
    if (inBPP  === undefined) inBPP  = 6;
    if (outBPP === undefined) outBPP = cMax;
    var scratchBytes = Math.max(Tetra6DState.SCRATCH_BYTES, cMax * 12);
    return bindNd(this, intLut, pixelCount, cMax, inBPP, outBPP, scratchBytes);
};

Tetra6DState.prototype.runTetra6D = function (
    input, inputPos, output, outputPos, pixelCount, intLut, cMax,
    inputHasAlpha, outputHasAlpha, preserveAlpha
) {
    runNd(this, input, inputPos, output, outputPos, pixelCount, intLut, cMax,
        inputHasAlpha, outputHasAlpha, preserveAlpha, 6, function (self, inAlphaSkip, outAlphaMode) {
            self.kernel(
                self.inputPtr, self.outputPtr, self.lutPtr,
                pixelCount, cMax,
                intLut.go0, intLut.go1, intLut.go2, intLut.go3,
                intLut.gridPointsScale_fixed,
                intLut.maxX, intLut.maxY, intLut.maxZ, intLut.maxK,
                intLut.go4, intLut.maxE,
                intLut.go5, intLut.maxF,
                self.scratchPtr,
                inAlphaSkip, outAlphaMode
            );
        });
};

function bindNd(state, intLut, pixelCount, cMax, inBPP, outBPP, scratchBytes) {
    var lutBytes    = intLut.CLUT.byteLength;
    var inputBytes  = pixelCount * inBPP;
    var outputBytes = pixelCount * outBPP;

    var lutPtr      = 0;
    var lutAligned  = (lutBytes + 7) & ~7;
    var inputPtr    = lutPtr + lutAligned;
    var inputEnd    = inputPtr + ((inputBytes + 7) & ~7);
    var outputPtr   = inputEnd;
    var outputEnd   = outputPtr + ((outputBytes + 3) & ~3);
    var scratchPtr  = outputEnd;
    var totalBytes  = scratchPtr + scratchBytes;

    var pagesNeeded = Math.ceil(totalBytes / 65536);
    var pagesHave   = (state.memory.buffer.byteLength / 65536) | 0;
    if (pagesHave < pagesNeeded) {
        state.memory.grow(pagesNeeded - pagesHave);
    }
    if (state.boundIntLut !== intLut || state.lutBytes !== lutBytes) {
        var memU16 = new Uint16Array(state.memory.buffer);
        memU16.set(intLut.CLUT, lutPtr >> 1);
        state.boundIntLut = intLut;
        state.lutBytes    = lutBytes;
    }
    state.lutPtr      = lutPtr;
    state.inputPtr    = inputPtr;
    state.outputPtr   = outputPtr;
    state.scratchPtr  = scratchPtr;
    state.reservedCap = inputBytes + outputBytes;
};

function runNd(state, input, inputPos, output, outputPos, pixelCount, intLut, cMax,
    inputHasAlpha, outputHasAlpha, preserveAlpha, inCh, callKernel
) {
    var inAlphaSkip  = inputHasAlpha ? 1 : 0;
    var outAlphaMode = 0;
    if (preserveAlpha) outAlphaMode = 2;
    else if (outputHasAlpha) outAlphaMode = 1;

    var inBPP       = inputHasAlpha  ? inCh + 1 : inCh;
    var outBPP      = outputHasAlpha ? cMax + 1 : cMax;
    var inputBytes  = pixelCount * inBPP;
    var outputBytes = pixelCount * outBPP;
    var buf         = state.memory.buffer;

    var memU8 = new Uint8Array(buf);
    if (input instanceof Uint8Array || input instanceof Uint8ClampedArray) {
        memU8.set(input.subarray(inputPos, inputPos + inputBytes), state.inputPtr);
    } else {
        for (var i = 0; i < inputBytes; i++) {
            memU8[state.inputPtr + i] = input[inputPos + i] & 0xFF;
        }
    }

    callKernel(state, inAlphaSkip, outAlphaMode);
    state.dispatchCount++;

    var outView = new Uint8Array(state.memory.buffer, state.outputPtr, outputBytes);
    if (output instanceof Uint8Array || output instanceof Uint8ClampedArray) {
        output.set(outView, outputPos);
    } else {
        for (var j = 0; j < outputBytes; j++) {
            output[outputPos + j] = outView[j];
        }
    }
}

function createTetra5DState(options) {
    return loadState(tetra5dNchBytes, SCALAR5D_CACHE_KEY, 'interp_tetra5d_nCh',
        Tetra5DState, false, options);
}

function createTetra6DState(options) {
    return loadState(tetra6dNchBytes, SCALAR6D_CACHE_KEY, 'interp_tetra6d_nCh',
        Tetra6DState, false, options);
}

module.exports = {
    hasWebAssembly: hasWebAssembly,
    instantiate: instantiateMod.instantiate,
    compile: instantiateMod.compile,
    createTetra3DState: createTetra3DState,
    createTetra3DInt16State: createTetra3DInt16State,
    createTetra3DSimdState: createTetra3DSimdState,
    createTetra3DInt16SimdState: createTetra3DInt16SimdState,
    createTetra4DState: createTetra4DState,
    createTetra4DInt16State: createTetra4DInt16State,
    createTetra4DSimdState: createTetra4DSimdState,
    createTetra4DInt16SimdState: createTetra4DInt16SimdState,
    createTetra5DState: createTetra5DState,
    createTetra6DState: createTetra6DState,
};
