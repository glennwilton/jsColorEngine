// src/kernels/1d/Kernel1D.js
//
// Gray (1-channel input) kernel. JS only — no WASM variants exist for this
// dimensionality; the generic linear interp loop handles every dataFormat
// (the LUT's inputScale/outputScale drive the numeric range).
'use strict';

var kernelUtils = require('../kernelUtils.js');
var wasmLifecycle = require('../wasmLifecycle.js');

module.exports = {
    dimensions: 1,

    _variant: null,

    supports: {
        float: true,
        int8_js: true,
        int16_js: true,
        // No WASM variants for 1D
    },

    create: function(lutMode){
        // No 1D WASM kernels exist, but the WASM settle still runs so a
        // 'int-wasm-*' lutMode demotes exactly as it did in v1.5 (the init
        // block ran for every input dimension).
        this._variant = 'float';
        return wasmLifecycle.settleWasmStates(this.transform);
    },

    // 1D never uses the lutKernelTable — the shared resolver no-ops for
    // non-3/4-channel LUTs, leaving the run slots null by design.
    resolveRuns: function(){
        kernelUtils.resolveTableRuns(this);
    },

    array: function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
        var transform = this.transform;
        outputArray = kernelUtils.ensureOutputArray(transform, lut, pixelCount, outAlpha, outputArray);
        transform.linearInterp1DArray_NCh_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inAlpha, outAlpha, preserve);
        return outputArray;
    },

    release: function(){
        wasmLifecycle.releaseWasmStates(this.transform);
    },

    provideLut: function(lutMode){ return null; },
};
