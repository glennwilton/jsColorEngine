// src/kernels/2d/Kernel2D.js
//
// Duotone (2-channel input) kernel. JS only — no WASM variants exist for
// this dimensionality; the generic bilinear interp loop handles every
// dataFormat (the LUT's inputScale/outputScale drive the numeric range).
'use strict';

var kernelUtils = require('../kernelUtils.js');
var wasmLifecycle = require('../wasmLifecycle.js');

module.exports = {
    dimensions: 2,

    supports: {
        float: true,
        int8_js: true,
        int16_js: true,
        // No WASM variants for 2D
    },

    create: function(lutMode){
        // No 2D WASM kernels exist, but the WASM settle still runs so a
        // 'int-wasm-*' lutMode demotes exactly as it did in v1.5 (the init
        // block ran for every input dimension).
        this._variant = 'float';
        return wasmLifecycle.settleWasmStates(this.transform);
    },

    // 2D never uses the lutKernelTable — the shared resolver no-ops for
    // non-3/4-channel LUTs, leaving the run slots null by design.
    resolveRuns: function(){
        kernelUtils.resolveTableRuns(this);
    },

    array: function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
        var transform = this.transform;
        outputArray = kernelUtils.ensureOutputArray(transform, lut, pixelCount, outAlpha, outputArray);
        transform.bilinearInterp2DArray_NCh_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inAlpha, outAlpha, preserve);
        return outputArray;
    },

    release: function(){
        wasmLifecycle.releaseWasmStates(this.transform);
    },

    provideLut: function(lutMode){ return null; },
};
