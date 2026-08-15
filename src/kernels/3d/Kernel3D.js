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

module.exports = {
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
