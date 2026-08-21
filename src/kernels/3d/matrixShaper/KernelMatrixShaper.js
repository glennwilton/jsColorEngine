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
 * KERNEL3D'S OTHER IMPLEMENTATION, not a kernel in its own right. It is
 * selected by Kernel3D.init() looking at its own pipeline after the optimiser
 * has run: sRGB -> AdobeRGB folds to a curve, a 3x3 and another curve and gets
 * this; sRGB -> GRACoL does not; sRGB -> sRGB with identity detection on does
 * not, because it collapsed to three stages with nothing left to accelerate.
 * None of those distinctions survive a channel count, which is why the decision
 * cannot be made at setKernel() time.
 *
 * It keeps the full kernel interface — create, array, release — so Kernel3D can
 * hand it back from init() and Transform can run it without knowing what it is.
 * Transform has no registry of these and no `claims` protocol; the kernel that
 * owns the dimension decides.
 *
 * NO CLUT AT ALL — two 1-D tables and nine coefficients — and it is the fast
 * path precisely when there is no LUT. It has no floatFor either: the
 * single-colour path is the stage pipeline, which already walks curve, matrix,
 * curve correctly. Only `array` differs, which is the whole of what it is.
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
     * What this kernel is, for kernelInfo(). The kernel describes itself
     * rather than Transform reaching into _impl to work it out.
     *
     * `built` is false between the decision and the first array call — the
     * tables cost 3-8 ms and are deferred — which is a real state worth being
     * able to see rather than an implementation detail to hide.
     */
    info: function(){
        var out = { name: 'matrix-shaper', dimensions: 3, claimed: true,
                    built: !!this._impl };
        if(this._impl){
            out.variant = this._impl.variant;
            out.bits    = this._impl.bits;
            out.simd    = this._impl.simd;
        }
        return out;
    },

    /** Nothing to compile per Transform — the module is cached globally. */
    create: function(lutMode){
        this._impl = undefined;         // undefined = not built, null = declined
        return lutMode;
    },

    /** No dispatch table to walk: one entry point per alpha shape, chosen per call. */

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

        // Default the pixel count from the buffer, as the table path does.
        // transformArray() lets its `pixelCount` parameter stay undefined when
        // the caller omits it and passes it straight through to here, so before
        // v1.6 a three-argument transformArray() on a matrix-shaper pair
        // computed `undefined * 3`, allocated a zero-length output and returned
        // an empty array. Shipped behaviour, and quiet about it.
        if(pixelCount === undefined || pixelCount === null){
            pixelCount = Math.floor(inputArray.length / (inAlpha ? 4 : 3));
        }
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
