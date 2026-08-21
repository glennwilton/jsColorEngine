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

/**
 * matrixShaperKernel.js — RGB->RGB matrix-shaper fast path.
 *
 * WHY THIS EXISTS. An RGB matrix-shaper conversion is a curve, a 3x3 matrix and
 * another curve. Routing it through a 3-D CLUT costs interpolation the maths
 * does not need, and a 214 KB table that falls out of cache on large images.
 * Doing it directly measures 331 MPx/s at int8 on photographic content against
 * 123 for the CLUT, and 225 against 125 at int16 — and it carries no
 * interpolation error, which is the larger point. The ratio is
 * content-dependent because a CLUT's is: 1.8x on a solid, 3.2x on noise. See
 * docs/deepdive/MatrixShaperKernel.md, where the same number has been reported
 * wrongly twice and both mistakes are written up.
 *
 * WHAT IT DOES NOT DO. It is not a new pipeline. The engine's optimiser already
 * folds an RGB matrix-shaper pair into exactly this shape:
 *
 *     stage_Int_to_Device -> stage_Gamma_Inverse -> stage_matrix_rgb
 *                         -> stage_Gamma -> stage_device_to_int
 *
 * so the fused 3x3 is read straight off `stage_matrix_rgb.stageData`, and both
 * gamma tables are filled by CALLING THE ENGINE'S OWN STAGE FUNCTIONS. No
 * matrix maths, chromatic adaptation or TRC curve-type handling is
 * reimplemented here, which is what keeps this byte-comparable with the
 * pipeline it replaces rather than merely close. The option is named
 * `wasmMatrixShaper` for the same reason: the matrix-shaper FOLD belongs to the
 * optimiser, and what this file adds is a WASM implementation of it.
 *
 * FOUR BINARIES: {int8, int16} x {SIMD, scalar}, each exporting FIVE ENTRY
 * POINTS — one per alpha shape (3->3, 4->3, 3->4, and 4->4 copying or filling)
 * with the strides baked in. Sixteen binaries would have been the alternative;
 * five exports cost ~4 KB of code and share the tables, which are the
 * expensive part. Alpha is a plain load and store outside the colour maths: it
 * is opacity, not a colorant, and must come through exactly rather than within
 * 1 LSB.
 *
 *   STRAIGHT ALPHA ONLY. Premultiplied (associated) input is silently wrong —
 *   transforming a*C is not a*T(C) when there is a TRC at each end, and it
 *   measures up to 69 LSB out at a=0.5. That is true of every path in the
 *   engine, not just this one, and it cannot be detected: the bytes are
 *   identical either way. The caller has to un-premultiply first.
 *
 *   Bit depth comes from `dataFormat` — the tables differ in size and, for
 *   int16, in how they are indexed (see scripts/build_matrix_shaper_wasm.js).
 *
 *   SIMD or scalar is decided by asking the host: an engine without SIMD throws
 *   while COMPILING the SIMD module, so compiling it is the feature test. The
 *   scalar build performs the same f32 operations in the same order as one SIMD
 *   lane, so it is bit-identical rather than merely close — a host without SIMD
 *   gets the same pixels, slower.
 *
 * ACCURACY. The input table has one entry per possible input code, so it is
 * exact. Measured against the exact pipeline over 262,144 colours per profile
 * pair: max 1 LSB, with 0.000% of samples beyond 1 LSB. The 33^3 CLUT this can
 * replace reaches 25 LSB on prophoto -> sRGB with 2.5% beyond 1 LSB, so
 * choosing the kernel is not a speed-for-accuracy trade — it is better at both.
 * See docs/deepdive/MatrixShaperKernel.md.
 */
'use strict';

var matrixShaperJS = require('./matrixShaperJS.js');

var VARIANTS = {
    '8-simd':    require('./matrix_shaper_int8_simd.wasm.js'),
    '8-scalar':  require('./matrix_shaper_int8_scalar.wasm.js'),
    '16-simd':   require('./matrix_shaper_int16_simd.wasm.js'),
    '16-scalar': require('./matrix_shaper_int16_scalar.wasm.js')
};

var PAGE = 65536;
var compiled = {};                  // variant name -> Module | null (tried, unavailable)

/**
 * Compile — once per variant, for the life of the process.
 *
 * The matrix lives in linear memory rather than baked into the code, so a
 * single compiled Module serves every profile pair; only the Instance is per
 * Transform.
 */
function moduleFor(name){
    if(compiled.hasOwnProperty(name)) return compiled[name];
    var mod = null;
    if(typeof WebAssembly !== 'undefined' && typeof WebAssembly.Module === 'function'){
        try {
            mod = new WebAssembly.Module(VARIANTS[name]);
        } catch(e){
            mod = null;             // host without SIMD, or a stale binary
        }
    }
    compiled[name] = mod;
    return mod;
}

/**
 * 'simd' | 'scalar' | 'js' | null (auto).
 *
 * Seeded from JSCE_MATRIX_SHAPER_VARIANT — an environment variable in Node, or
 * a value on `globalThis` in a browser. Two reasons it is not only
 * useVariant(): worker threads are separate module instances, so a call on the
 * main thread does not reach them (they inherit process.env, which does); and
 * in a browser there is no shell, so a global is the only way to pin one
 * without a rebuild.
 *
 * Diagnostic, not API — for benchmarking the implementations against each
 * other, and for ruling a WASM problem in or out in the field without a code
 * change. The supported way to turn the kernel off entirely is
 * `wasmMatrixShaper: false` on the Transform.
 */
var pinned = require('../../../settings.js')
    .readEnum('JSCE_MATRIX_SHAPER_VARIANT', ['simd', 'scalar', 'js']) || null;

/**
 * The best available variant for a bit depth: SIMD if the host will compile it,
 * scalar otherwise. Returns null only when WebAssembly itself is missing.
 */
function pickVariant(bits){
    // 'js' pins to no WASM variant at all, which build() reads as "use the JS
    // implementation" — the same route a host without WebAssembly takes.
    if(pinned === 'js') return null;
    if(pinned) return moduleFor(bits + '-' + pinned) ? bits + '-' + pinned : null;
    if(moduleFor(bits + '-simd'))   return bits + '-simd';
    if(moduleFor(bits + '-scalar')) return bits + '-scalar';
    return null;
}

/**
 * Pin the implementation to 'simd', 'scalar' or 'js', or null to auto-select.
 *
 * Exists because "the scalar build is bit-identical" and "the JS path is within
 * 1 LSB" are claims that have to be TESTED, and every machine that runs the
 * tests has WASM with SIMD — there is no other way to reach either fallback.
 * Unreachable code is untested code. Also useful for benchmarking the three
 * against each other. Affects Transforms built after the call, not existing
 * ones.
 */
function useVariant(kind){
    pinned = (kind === 'simd' || kind === 'scalar' || kind === 'js') ? kind : null;
}

/** dataFormat -> bit depth, or 0 for formats this kernel does not handle. */
function bitsFor(dataFormat){
    if(dataFormat === 'int8')  return 8;
    if(dataFormat === 'int16') return 16;
    return 0;
}

/** Find a stage by name in a built pipeline. */
function stageNamed(transform, name){
    if(!transform || !transform.pipeline) return null;
    for(var i = 0; i < transform.pipeline.length; i++){
        if(transform.pipeline[i].stageName === name) return transform.pipeline[i];
    }
    return null;
}

/**
 * Run a curve stage on one value, returning all three channels.
 * Using the engine's own stage keeps every TRC form — sRGB piecewise, simple
 * gamma, ICC parametric — handled in exactly one place.
 */
function curveAt(transform, stage, v){
    return stage.funct.call(transform, [v, v, v], stage.stageData, stage);
}

/**
 * ONE TABLE PER DIRECTION, so the three channels must share a curve. A profile
 * may carry a different TRC per channel, and applying red's curve to green
 * would be silently wrong rather than merely slow. Sampled rather than
 * introspected, because the curve form varies.
 *
 * Returns 'input' / 'output' naming the offending direction, or null if both
 * curves are grey.
 */
function perChannelCurve(transform, sInv, sFwd){
    for(var s = 0; s <= 32; s++){
        var v = s / 32;
        var a = curveAt(transform, sInv, v);
        var b = curveAt(transform, sFwd, v);
        if(Math.abs(a[0] - a[1]) > 1e-12 || Math.abs(a[0] - a[2]) > 1e-12) return 'input';
        if(Math.abs(b[0] - b[1]) > 1e-12 || Math.abs(b[0] - b[2]) > 1e-12) return 'output';
    }
    return null;
}

/**
 * Can this Transform use the kernel?
 *
 * Returns a reason string when it cannot, so callers can report WHY rather than
 * silently running slower — the failure modes here are all legitimate
 * configurations, not errors.
 */
function inspect(transform){
    if(!transform || !transform.pipelineCreated) return {ok: false, why: 'no pipeline'};

    var bits = bitsFor(transform.dataFormat);
    if(!bits) return {ok: false, why: 'dataFormat is not int8 or int16'};

    if(transform.inputChannels !== 3 || transform.outputChannels !== 3){
        return {ok: false, why: 'not 3-channel in and out'};
    }
    if(transform.lut) return {ok: false, why: 'a LUT was built; the CLUT path owns this'};

    var sIn  = stageNamed(transform, 'stage_Int_to_Device');
    var sInv = stageNamed(transform, 'stage_Gamma_Inverse');
    var sMat = stageNamed(transform, 'stage_matrix_rgb');
    var sFwd = stageNamed(transform, 'stage_Gamma');
    var sOut = stageNamed(transform, 'stage_device_to_int');
    if(!sIn || !sInv || !sMat || !sFwd || !sOut) return {ok: false, why: 'not a matrix-shaper pipeline'};

    // Exactly those five stages, in that order. Anything else — a custom stage,
    // a gamut hook, an abstract profile in the chain — means the pipeline is
    // doing something this kernel does not model.
    var want = ['stage_Int_to_Device', 'stage_Gamma_Inverse', 'stage_matrix_rgb',
                'stage_Gamma', 'stage_device_to_int'];
    if(transform.pipeline.length !== want.length) return {ok: false, why: 'extra pipeline stages'};
    for(var i = 0; i < want.length; i++){
        if(transform.pipeline[i].stageName !== want[i]) return {ok: false, why: 'unexpected stage order'};
    }

    // PER-CHANNEL CURVES ARE NO LONGER A DECLINE — they are a JS case. The
    // WASM kernel keeps one table per direction and cannot serve three
    // different curves; the JS implementation has no table-size pressure, so
    // it takes them instead of dropping the transform to the stage pipeline at
    // ~8 MPx/s. Reported here rather than decided here, so build() picks.
    var perChannel = perChannelCurve(transform, sInv, sFwd);

    var variant = perChannel ? null : pickVariant(bits);
    if(!variant && typeof WebAssembly === 'undefined'){
        // No WASM at all is also a JS case, not a failure.
        variant = null;
    }

    return {ok: true, why: null, bits: bits, variant: variant,
            perChannel: perChannel,
            stages: {inv: sInv, mat: sMat, fwd: sFwd}};
}

/**
 * Should the CLUT build be skipped in favour of this kernel?
 *
 * Called during create(), against the TEMPORARY device-to-device pipeline the
 * LUT builder makes before it walks the grid — so the decision is taken on a
 * pipeline that exists rather than predicted from profile types. That matters:
 * an identity pair (sRGB->sRGB with detectIdentity on) collapses to three
 * stages and this kernel rightly declines it, which no amount of inspecting
 * `inputProfile.type` would have revealed.
 *
 * Deliberately conservative. Saying yes here means NO CLUT IS BUILT, so a
 * later refusal by inspect() would strand the caller on the generic loops at
 * ~8 MPx/s — far worse than the CLUT it replaced. Every condition inspect()
 * checks is therefore checked here too, against the equivalent stages.
 */
function wantsInsteadOfLut(transform){
    if(!transform) return false;

    var bits = bitsFor(transform.dataFormat);
    if(!bits) return false;

    // OPT-IN. `buildLut: true` is a request, not a hint — callers export LUTs
    // with toJSON(), clone and diverge them, and manage their WASM memory. This
    // kernel is faster and more accurate, but it is not a LUT, so replacing one
    // silently would break all of that. See wasmMatrixShaper: 'prefer'.
    if(transform.preferMatrixShaperOverLUT !== true) return false;

    // HOOKS AND GAMUT MAPPING ONLY EXIST DURING THE LUT BUILD. lutInputHook,
    // lutOutputHook and gamutDeFn run inside the grid walk; skip the walk and
    // they never execute — silently, with the caller believing their hook is
    // applied. Refuse rather than quietly ignore them.
    if(transform._lutInputHooks && transform._lutInputHooks.length) return false;
    if(transform._lutOutputHooks && transform._lutOutputHooks.length) return false;
    if(transform.lutGamutMode && transform.lutGamutMode !== 'none') return false;

    if(transform.inputChannels !== 3 || transform.outputChannels !== 3) return false;
    // The final pipeline needs its int<->device stages for inspect() to match;
    // without them this kernel is not what ends up running.
    if(transform.convertInputOutput !== true) return false;
    if(!pickVariant(bits)) return false;

    // The temporary LUT-build pipeline is device in, device out: the same
    // three stages as the real one, minus the int conversions.
    var want = ['stage_Gamma_Inverse', 'stage_matrix_rgb', 'stage_Gamma'];
    var pipe = transform.pipeline;
    if(!pipe || pipe.length !== want.length) return false;
    for(var i = 0; i < want.length; i++){
        if(pipe[i].stageName !== want[i]) return false;
    }

    return !perChannelCurve(transform, pipe[0], pipe[2]);
}

/**
 * Build a ready kernel for this Transform, or null if it is not applicable.
 *
 * Each Transform gets its own instance: the tables and matrix live in that
 * instance's linear memory, so they cannot be shared. The compiled Module is
 * shared, which is where the expensive part is.
 */
function build(transform){
    var check = inspect(transform);
    if(!check.ok) return null;

    // NO WASM VARIANT MEANS JS, NOT NOTHING. Two ways to get here: the curves
    // differ per channel (one table per direction cannot serve three), or the
    // host has no WebAssembly. Both are cases the JS implementation covers at
    // ~62 MPx/s against ~8 for the stage pipeline that would otherwise run.
    if(!check.variant){
        try { return matrixShaperJS.build(transform, check); }
        catch(e){ return null; }
    }

    var instance;
    try {
        instance = new WebAssembly.Instance(moduleFor(check.variant), {});
    } catch(e){ return null; }

    var exports = instance.exports;
    var memory = exports.memory;
    if(typeof exports.run !== 'function' || !memory) return null;

    var L = VARIANTS[check.variant].LAYOUT;
    var bytesPerChannel = L.bits === 8 ? 1 : 2;
    var maxCode = L.inEntries - 1;
    var i, e;

    // ---- input gamma: one entry per possible input code, so exact ---------
    var gIn = new Float32Array(memory.buffer, L.gammaInByte, L.inEntries);
    for(i = 0; i < L.inEntries; i++){
        gIn[i] = curveAt(transform, check.stages.inv, i / maxCode)[0];
    }

    // ---- output gamma: index -> encoded output code ------------------------
    // One rounded lookup, no interpolation, at both depths. Entry i is the
    // encoded value of the linear light that index i stands for, which is
    // (i/outIndexMax)^indexRoot — a linear index at int8, a fourth-power one at
    // int16, because a power TRC's encode curve has unbounded slope at zero and
    // a linear index cannot resolve the dark end at 16 bits. See the layout
    // notes in scripts/build_matrix_shaper_wasm.js.
    var OutTable = L.outEntryBytes === 1 ? Uint8Array : Uint16Array;
    var gOut = new OutTable(memory.buffer, L.gammaOutByte, L.outIndexMax + 1);
    for(i = 0; i <= L.outIndexMax; i++){
        var lin = i / L.outIndexMax;
        if(L.indexRoot === 4){ lin = lin * lin; lin = lin * lin; }
        e = Math.round(curveAt(transform, check.stages.fwd, lin)[0] * L.outValueMax);
        gOut[i] = e < 0 ? 0 : (e > L.outValueMax ? L.outValueMax : e);
    }

    // ---- the fused 3x3, straight from the optimiser ------------------------
    var m = check.stages.mat.stageData;
    var mat = new Float32Array(memory.buffer, L.matrixByte, 9);
    mat[0] = m.m00; mat[1] = m.m01; mat[2] = m.m02;
    mat[3] = m.m10; mat[4] = m.m11; mat[5] = m.m12;
    mat[6] = m.m20; mat[7] = m.m21; mat[8] = m.m22;

    var View = L.bits === 8 ? Uint8Array : Uint16Array;

    var kernel = {
        instance: instance,
        memory: memory,
        variant: check.variant,
        bits: L.bits,
        simd: check.variant.indexOf('simd') !== -1,
        capacityPx: 0,
        inPtr: L.pixelByte,
        outPtr: 0,

        /**
         * Grow linear memory so `pixelCount` pixels fit in and out.
         *
         * Sized for FOUR channels regardless of the shape actually in use. A
         * Transform can be called with alpha on one image and without it on
         * the next, and sizing to the current call would mean a grow (and a
         * detached buffer) on the first RGBA image. Four channels of headroom
         * is 33% of a buffer that is transient anyway.
         */
        reserve: function(pixelCount){
            if(pixelCount <= this.capacityPx) return;
            var bytes  = pixelCount * 4 * bytesPerChannel;
            var outPtr = L.pixelByte + ((bytes + 63) & ~63);
            var need   = outPtr + bytes;
            var have   = this.memory.buffer.byteLength;
            if(need > have){
                this.memory.grow(Math.ceil((need - have) / PAGE));
            }
            this.outPtr = outPtr;
            this.capacityPx = pixelCount;
        },

        /**
         * Convert `pixelCount` pixels. `output` is written in place and
         * returned. Copies in and out of linear memory, which is what WASM
         * requires — see the copy discussion in docs/deepdive/multicore.md.
         *
         * ALPHA IS A SHAPE, NOT A FLAG. The module exports one entry point per
         * combination, with the strides baked in, so this picks a function
         * rather than passing a stride nobody else needs. Alpha never goes
         * through the TRC or the matrix — it is opacity, not a colorant.
         */
        run: function(input, output, pixelCount, inHasAlpha, outHasAlpha, preserveAlpha){
            this.reserve(pixelCount);
            var inCh  = inHasAlpha  ? 4 : 3;
            var outCh = outHasAlpha ? 4 : 3;
            var fn = exports.run;
            if(inCh === 4 && outCh === 3)      fn = exports.run_a_in;
            else if(inCh === 3 && outCh === 4) fn = exports.run_a_out;
            else if(inCh === 4 && outCh === 4) fn = preserveAlpha ? exports.run_a_copy
                                                                 : exports.run_a_fill;
            // Re-view every call: memory.grow() detaches the old buffer.
            var nIn = pixelCount * inCh, nOut = pixelCount * outCh;
            new View(this.memory.buffer, this.inPtr, nIn).set(input.subarray(0, nIn));
            fn(this.inPtr, this.outPtr, pixelCount);
            output.set(new View(this.memory.buffer, this.outPtr, nOut), 0);
            return output;
        }
    };

    return kernel;
}

module.exports = {
    build: build,
    inspect: inspect,
    wantsInsteadOfLut: wantsInsteadOfLut,
    /** Which binary the host can actually compile, for a bit depth. */
    variantFor: pickVariant,
    useVariant: useVariant,
    LAYOUT: VARIANTS['8-simd'].LAYOUT,
    LAYOUTS: {
        8:  VARIANTS['8-simd'].LAYOUT,
        16: VARIANTS['16-simd'].LAYOUT
    }
};
