// src/kernels/3d/Kernel3D.js
//
// RGB/Lab (3-channel input) kernel — tetrahedral interpolation with
// WASM SIMD / WASM scalar / JS int8 / JS int16 / float variants.
//
// MIGRATION NOTE (v1.7 phase A): the fine-tuned unrolled loops stay on
// Transform.prototype and the WASM load/demotion logic stays in
// Transform.createMultiStage() — it settles lutMode for the 3D and 4D WASM
// states jointly. Variant selection is resolved once at create() time by
// _resolveLutKernels() (src/lutKernelTable.js) and this kernel dispatches
// through the cached BIG/SMALL refs. Moving the WASM lifecycle and the loop
// bodies in here is the next step — see docs/deepdive/KernelModules.md.
'use strict';

var kernelUtils = require('../kernelUtils.js');
var wasmLifecycle = require('../wasmLifecycle.js');
var interp = require('../../interp.js');
var encoding = require('../../def.js').encoding;

module.exports = {
    name: 'kernel3D',
    dimensions: 3,

    supports: {
        float: true,
        int8_js: true,
        int8_scalar: true,
        int8_simd: true,
        int16_js: true,
        int16_scalar: true,
        int16_simd: true,
    },

    /**
     * The single-colour stage function for a 3-D LUT, and the stage name.
     *
     * THIS KERNEL DECIDES, THE CALLER HINTS. Everything below used to live in
     * a switch in Transform.addStageLUT. It is dimensional knowledge: the
     * PCS-input trilinear rule exists ONLY for 3-channel input - the 4-D case
     * has no equivalent - which is the clearest single sign it was living in
     * the wrong file.
     *
     * Hints are advisory and this kernel resolves them, but an unrecognised
     * one is an ERROR rather than a silent default. `interpolation3D` is a
     * public option; a typo in it must not quietly select tetrahedral.
     *
     * MUST NOT precompute from `lut` - this runs while the pipeline is being
     * built, and optimisePipeline() folds codec scales into lut.inputScale /
     * lut.outputScale afterwards. Read them at call time.
     */
    floatFor: function(lut, hints){
        hints = hints || {};

        // Trilinear for PCS-indexed input. Little CMS 2.0 switched to
        // tetrahedral and found it disagreed with 1.19, SampleICC and
        // Photoshop on LUTs indexed by Lab: L sits on one axis, so the space
        // is uncentred and tetrahedral splits it badly. Applies to PCS INPUT;
        // the output side does not matter.
        var method = (hints.useTrilinearFor3ChInput
                      && (hints.inputEncoding === encoding.PCSv4
                          || hints.inputEncoding === encoding.PCSv2))
            ? 'trilinear'
            : hints.interpolation3D;

        switch(method){
            case 'tetrahedral':
                if(hints.fast === false){
                    // The readable reference implementation. Numerically
                    // identical to the unrolled variants - the LCMS suite
                    // verifies that - just slower.
                    return { funct: interp.tetrahedralInterp3D_3or4Ch,
                             stageName: 'tetrahedralInterp3D' };
                }
                switch(lut.outputChannels){
                    case 3:  // RGB -> RGB / Lab
                        return { funct: interp.tetrahedralInterp3D_3Ch,
                                 stageName: 'tetrahedralInterp3D' };
                    case 4:  // RGB -> CMYK
                        return { funct: interp.tetrahedralInterp3D_4Ch,
                                 stageName: 'tetrahedralInterp3D' };
                    default: // RGB -> n-colour
                        return { funct: interp.tetrahedralInterp3D_NCh,
                                 stageName: 'tetrahedralInterp3D' };
                }

            case 'trilinear':
                return { funct: interp.trilinearInterp3D_NCh,
                         stageName: 'trilinearInterp3D' };

            default:
                throw 'Unknown 3D interpolation method "' + method + '"';
        }
    },

    /**
     * The image path, bound once. See kernelUtils.boundRuns.
     *
     * Returns {big, small, threshold, bigName, smallName}. A caller holding
     * both picks with one compare, or none at all when the threshold is 0.
     */
    arrayFor: function(lut, hints){
        kernelUtils.resolveTableRuns(this);
        return kernelUtils.boundRuns(this);
    },

    create: function(lutMode){
        // Load the WASM kernels (3D + 4D families — see wasmLifecycle.js for
        // why both) and demote lutMode if the host can't run the request.
        this._variant = null;
        return wasmLifecycle.settleWasmStates(this.transform);
    },

    // Resolve BIG/SMALL run refs onto this instance (v1.7 phase C) —
    // called at create() time and again whenever dispatch inputs change
    // (releaseWasmMemory, setLut). See kernelUtils.resolveTableRuns.
    resolveRuns: function(){
        kernelUtils.resolveTableRuns(this);
    },

    array: function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
        outputArray = kernelUtils.ensureOutputArray(this.transform, lut, pixelCount, outAlpha, outputArray);
        kernelUtils.runTableKernel(this, inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve);
        return outputArray;
    },

    release: function(){
        wasmLifecycle.releaseWasmStates(this.transform);
    },

    provideLut: function(lutMode){ return null; },
};
