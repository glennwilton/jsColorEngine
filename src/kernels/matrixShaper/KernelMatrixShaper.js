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
 * KernelMatrixShaper.js — the matrix-shaper kernel, as a registered module.
 *
 * A CLAIMING KERNEL, NOT A DIMENSIONAL ONE. The other kernel modules are
 * selected by input channel count: 3 channels in, you get Kernel3D, decided
 * before the pipeline exists. This one cannot be chosen that way, because
 * "3-channel" is not the question. The question is whether the OPTIMISER
 * FOLDED THIS PARTICULAR PAIR into a curve, a 3x3 and another curve — and that
 * is only knowable once the pipeline has been built.
 *
 * So it registers a `claims(transform)` predicate instead, and Transform runs
 * the claim pass after `pipelineCreated`. sRGB -> AdobeRGB is claimed;
 * sRGB -> GRACoL is not; sRGB -> sRGB with identity detection on is not,
 * because it collapsed to three stages and there is nothing left to accelerate.
 * None of those distinctions survive a channel count.
 *
 * IT BREAKS THE "KERNELS ARE LUT-ONLY" RULE, DELIBERATELY. KernelModules.md
 * said kernels are LUT batch processors and the no-LUT array path stays in
 * Transform.js. That held while every kernel WAS a table walker. This one has
 * no CLUT at all — two 1-D tables and nine coefficients — and it is the fast
 * path precisely when there is no LUT. Keeping it out of the kernel registry
 * to preserve the rule would have meant Transform.js importing one specific
 * kernel and branching on it in `transformArray`, which is what it did before
 * this file existed.
 *
 * LAZY, AND THAT MATTERS. `claims()` is cheap — it walks five stage names and
 * samples the two curves. `build()` fills a 64 KB or 256 KB table and costs
 * 3-8 ms, so it is deferred to the first array call. A Transform that only ever
 * converts single colours never pays it, and the gamut helpers build several of
 * those per LUT.
 */
'use strict';

var matrixShaper = require('./matrixShaperKernel.js');

module.exports = {
    name: 'matrix-shaper',

    // Informational: this kernel handles 3-channel input. It is NOT registered
    // in the dimensional slot — Kernel3D keeps that, and is what a LUT-based
    // RGB pair still gets.
    dimensions: 3,

    supports: {
        int8_simd:    true,
        int8_scalar:  true,
        int16_simd:   true,
        int16_scalar: true,
        // No float variant and no LUT variants: this kernel is the alternative
        // to a table, not a way of walking one.
        float:        false
    },

    /**
     * Does this Transform's FINAL pipeline suit this kernel?
     *
     * Called once per create(), after the pipeline exists. Cheap by contract —
     * the expensive table build waits for the first array call.
     *
     * Returns the same {ok, why} shape as matrixShaperKernel.inspect(), so a
     * caller can report why a transform was not claimed rather than guessing.
     */
    claims: function(pipeline, opts){
        if(opts.wasmMatrixShaper === 'off'){
            return {ok: false, why: 'wasmMatrixShaper is off'};
        }
        // A pixel cache makes the batch path memoised, which is a different
        // execution model — see the cache discussion in Transform.transformArray.
        if(opts.pixelCacheActive){
            return {ok: false, why: 'a pixel cache is active'};
        }
        // inspect() walks the stages, so it still needs the Transform. What it
        // no longer does is reach for transform._pixelCacheData — a kernel
        // reading a private field of the thing it is meant to be decoupled from
        // was the boundary leaking, and opts carries that answer now.
        return matrixShaper.inspect(opts.transform);
    },

    /**
     * Should the CLUT build be skipped so this kernel can take the transform?
     *
     * Called DURING create(), against the temporary device-to-device pipeline
     * the LUT builder makes before walking the grid — earlier than claims(),
     * and on a different pipeline. Opt-in via `wasmMatrixShaper: 'prefer'`;
     * refuses whenever something depends on the LUT existing (hooks, gamut
     * mapping). See matrixShaperKernel.wantsInsteadOfLut.
     */
    displacesLut: function(transform){
        return matrixShaper.wantsInsteadOfLut(transform);
    },

    /** Nothing to compile per Transform — the module is cached globally. */
    create: function(lutMode){
        this._impl = undefined;         // undefined = not built, null = declined
        return lutMode;
    },

    /** No dispatch table to walk: one entry point per alpha shape, chosen per call. */
    resolveRuns: function(){ },

    /**
     * The batch path. `lut` is always null here — that is the point of this
     * kernel — and the signature keeps the shape of every other kernel module
     * so the dispatcher does not need to know which one it is holding.
     *
     * Returns null if the build declined after all, so the caller can fall
     * through to the generic loops rather than being stranded. That should not
     * happen — claims() ran the same inspection — but "should not" is not a
     * reason to leave a caller without an answer.
     */
    array: function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
        if(this._impl === undefined){
            try {
                this._impl = matrixShaper.build(this.transform);
            } catch(e){
                this._impl = null;
            }
        }
        if(!this._impl) return null;

        var need = pixelCount * (outAlpha ? 4 : 3);
        var out  = outputArray;
        if(!out || out.length < need){
            out = (this.transform.dataFormat === 'int16')
                ? new Uint16Array(need)
                : new Uint8ClampedArray(need);
        }
        return this._impl.run(inputArray, out, pixelCount, inAlpha, outAlpha, preserve);
    },

    release: function(){
        this._impl = undefined;
    },

    /**
     * Never reached — provideLut() is asked of the dimensional kernel, before
     * the pipeline exists and therefore before this kernel can claim anything.
     * Present so the module satisfies the same contract as its siblings.
     */
    provideLut: function(lutMode){ return null; }
};
