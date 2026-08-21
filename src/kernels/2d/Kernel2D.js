// src/kernels/2d/Kernel2D.js
//
// Duotone (2-channel input) kernel. JS only — no WASM variants exist for
// this dimensionality; the generic bilinear interp loop handles every
// dataFormat (the LUT's inputScale/outputScale drive the numeric range).
'use strict';

var kernelUtils = require('../kernelUtils.js');
var loops = require('./kernel2D_loops.js');
var wasmLifecycle = require('../wasmLifecycle.js');

/**
 * ACCURACY PATH — one colour at a time.
 *
 * Moved verbatim from src/interp.js in v1.6. Pure: reads only its arguments,
 * so the `this` it is called with (the Transform, via stage.funct.call) is
 * irrelevant and unused.
 *
 * @param {number[]|TypedArray} input  2 channels
 * @param {object} lut
 * @returns {number[]} new array of length lut.outputChannels
 */
function bilinearInterp2D_NCh(input, lut){
    var rx,ry;
    var X0,X1,Y0,Y1,px,py;
    var base0, base1,base2,base3,
        c0,c1,c2,c3,
        c02, o

    var outputScale = lut.outputScale;
    var outputChannels = lut.outputChannels;
    var gridEnd = (lut.g1 - 1);
    var gridPointsScale = gridEnd * lut.inputScale;
    var CLUT = lut.CLUT;
    var go0 = lut.go0;
    var go1 = lut.go1;

    // Scale FIRST, then clamp in grid space (raw u8/u16 vs device 0..1
    // input contracts).
    px = Math.min(Math.max(input[0] * gridPointsScale, 0), gridEnd);
    py = Math.min(Math.max(input[1] * gridPointsScale, 0), gridEnd);

    X0 = ~~px;
    rx = (px - X0);
    if(X0 === gridEnd){
        X1 = X0 *= go1;
    } else {
        X0 *= go1;
        X1 = X0 + go1;
    }

    Y0 = ~~py;
    ry = (py - Y0);
    if(Y0 === gridEnd){
        Y1 = Y0 *= go0;
    } else {
        Y0 *= go0;
        Y1 = Y0 + go0;
    }

    var output = new Array(outputChannels);

    base0 = X0 + Y0;
    base1 = X0 + Y1;
    base2 = X1 + Y0;
    base3 = X1 + Y1;
    for(o = 0; o < outputChannels; o++){
        c0 = CLUT[base0++];
        c1 = CLUT[base1++];
        c2 = CLUT[base2++];
        c3 = CLUT[base3++];
        c02 = (c0 + ((c2 - c0) * rx))
        output[o] = (c02 + ((  (c1 + ((c3 - c1) * rx))  - c02) * ry)) * outputScale;
    }
    return output;
}

module.exports = {
    name: 'kernel2D',

    dimensions: 2,

    supports: {
        float: true,
        int8_js: true,
        int16_js: true,
        // No WASM variants for 2D
    },

    /**
     * The single-colour stage function for a 2-D LUT, plus its stage name.
     *
     * The name is a coupling surface: compile() resolves emitters as
     * `emit_js_<stageName>` and optimisePipeline() matches fusion patterns
     * against a fixed list of these strings, so it is returned from here
     * rather than written at the call site where the two could drift.
     *
     * MUST NOT precompute from `lut` — optimisePipeline() folds codec scales
     * into lut.inputScale / lut.outputScale after the stage is built.
     */
    floatFor: function(lut, hints){
        return { funct: bilinearInterp2D_NCh, stageName: 'bilinearInterp2D' };
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
        loops.bilinearInterp2DArray_NCh_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inAlpha, outAlpha, preserve);
        return outputArray;
    },

    release: function(){
        wasmLifecycle.releaseWasmStates(this.transform);
    },

    provideLut: function(lutMode){ return null; },
};
