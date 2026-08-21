// src/kernels/4d/Kernel4D.js
//
// CMYK (4-channel input) kernel — tetrahedral interpolation with
// WASM SIMD / WASM scalar / JS int8 / JS int16 / float variants.
//
// MIGRATION NOTE (v1.7 phase A): identical shape to Kernel3D — the tuned
// unrolled loops stay on Transform.prototype and WASM load/demotion stays in
// Transform.createMultiStage(). The lutKernelTable resolution (cached as
// kernel._runBig/_runSmall at create() time) already keys on the LUT's
// input/output channels, so this kernel and Kernel3D share the dispatch
// helper. They diverge when WASM lifecycle ownership moves in here — see
// docs/deepdive/KernelModules.md.
'use strict';

var kernelUtils = require('../kernelUtils.js');
var wasmLifecycle = require('../wasmLifecycle.js');
var interp = require('../../interp.js');

module.exports = {
    name: 'kernel4D',

    dimensions: 4,

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
     * The single-colour stage function for a 4-D LUT, and the stage name.
     *
     * Moved here from the switch in Transform.addStageLUT. Note what is NOT
     * here: the PCS-input trilinear override. That rule belongs to 3-channel
     * input alone, and its absence from this kernel is the point - each
     * dimension now carries its own rules instead of one function carrying
     * the rules of every dimension at once.
     *
     * A 4-D interpolation is two 3-D ones at the bracketing K planes, lerped
     * together; the reference variants reach into the 3-D interpolators to do
     * exactly that. That is the maths, not a leak.
     *
     * MUST NOT precompute from `lut` - optimisePipeline() folds codec scales
     * into lut.inputScale / lut.outputScale after the stage is built.
     */
    floatFor: function(lut, hints){
        hints = hints || {};

        switch(hints.interpolation4D){
            case 'tetrahedral':
                if(hints.fast === false){
                    return { funct: interp.tetrahedralInterp4D_3or4Ch,
                             stageName: 'tetrahedralInterp4D' };
                }
                switch(lut.outputChannels){
                    case 3:  // CMYK -> RGB / Lab
                        return { funct: interp.tetrahedralInterp4D_3Ch,
                                 stageName: 'tetrahedralInterp4D' };
                    case 4:  // CMYK -> CMYK
                        return { funct: interp.tetrahedralInterp4D_4Ch,
                                 stageName: 'tetrahedralInterp4D' };
                    default:
                        return { funct: interp.tetrahedralInterp4D_NCh,
                                 stageName: 'tetrahedralInterp4D' };
                }

            case 'trilinear':
                return { funct: interp.trilinearInterp4D_3or4Ch,
                         stageName: 'trilinearInterp4D' };

            default:
                throw 'Unknown 4D interpolation method "' + hints.interpolation4D + '"';
        }
    },

    /**
     * The image path, bound once. See kernelUtils.resolveArrayRuns.
     *
     * Returns {big, small, threshold, bigName, smallName}. A caller holding
     * both picks with one compare, or none at all when the threshold is 0.
     */
    arrayFor: function(lut, hints){
        return kernelUtils.resolveArrayRuns(this);
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
