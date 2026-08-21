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
