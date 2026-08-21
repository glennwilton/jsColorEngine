// src/kernels/1d/Kernel1D.js
//
// Gray (1-channel input) kernel. JS only — no WASM variants exist for this
// dimensionality; the generic linear interp handles every dataFormat (the
// LUT's inputScale/outputScale drive the numeric range).
//
// THIS KERNEL OWNS BOTH SURFACES (v1.6 phase 2 — docs/deepdive/KernelContract.md):
//
//   floatFor(lut, hints)  the single-colour evaluator the pipeline walker runs,
//                         one colour at a time, via stage.funct.call(...)
//   array(...)            the image batch path
//
// TWO IMPLEMENTATIONS OF THE SAME MATHS, DELIBERATELY. They must never be
// consolidated. Sharing inner code between the single-colour path and the array
// loop poisons the JIT: the same function reached from two call sites with
// different ABIs and array shapes makes V8 deoptimise, and the array path slows
// 2-3x. See the PERFORMANCE LESSONS block in src/Transform.js.
//
// Until v1.6 this kernel was the one place that got that wrong — the array loop
// called linearInterp1D_NCh once per pixel, allocating a one-element wrapper
// array AND an output array for every pixel, roughly 2M allocations per
// megapixel. That was TODO(B3), open since the v1.5 kernel migration. The loop
// below is inlined the way the 3D and 4D loops always were.
'use strict';

var kernelUtils = require('../kernelUtils.js');
var loops = require('./kernel1D_loops.js');
var wasmLifecycle = require('../wasmLifecycle.js');

/**
 * ACCURACY PATH — one colour at a time.
 *
 * Moved verbatim from src/interp.js in v1.6. Pure: reads only its arguments,
 * so the `this` it is called with (the Transform, via stage.funct.call) is
 * irrelevant and unused.
 *
 * @param {number[]|TypedArray} input  1 channel
 * @param {object} lut
 * @returns {number[]} new array of length lut.outputChannels
 */
function linearInterp1D_NCh(input, lut){
    var rx,px,X0,X1,
        c0,c1,o
    var outputScale = lut.outputScale;
    var outputChannels = lut.outputChannels;
    var gridEnd = (lut.g1 - 1);
    var gridPointsScale = gridEnd * lut.inputScale;
    var CLUT = lut.CLUT;
    var go0 = lut.go0;

    // Scale FIRST, then clamp in grid space. Input may be raw u8/u16
    // (baked LUT after codec folding: inputScale = 1/255 or 1/65535)
    // or device/PCS 0..1 (ICC LUT: inputScale = 1). Clamping the raw
    // input to [0,1] before scaling broke the baked-integer case.
    px = Math.min(Math.max(input[0] * gridPointsScale, 0), gridEnd);

    X0 = ~~px;
    rx = (px - X0);
    if(X0 === gridEnd){
        X1 = X0 *= go0;
    } else {
        X0 *= go0;
        X1 = X0 + go0;
    }

    var output = new Array(outputChannels);
    for(o = 0; o < outputChannels; o++){
        c0 = CLUT[X0++];
        c1 = CLUT[X1++];
        output[o] = (c0 + ((c1 - c0) * rx)) * outputScale;
    }
    return output;
}

module.exports = {
    name: 'kernel1D',

    dimensions: 1,

    _variant: null,

    supports: {
        float: true,
        int8_js: true,
        int16_js: true,
        // No WASM variants for 1D
    },

    /**
     * The single-colour stage function for a 1-D LUT, plus the stage name to
     * file it under.
     *
     * The name is a coupling surface, not a label: compile() resolves emitters
     * as `emit_js_<stageName>` and optimisePipeline() matches its fusion
     * patterns against a fixed list of these strings. Changing it stops fusion
     * firing silently, so it is returned from here rather than written at the
     * call site where the two could drift apart.
     *
     * `hints` carries the caller's interpolation preferences. Gray has exactly
     * one implementation, so there is nothing here to choose between — the
     * argument exists so every kernel presents the same signature.
     *
     * MUST NOT precompute anything from `lut`: this runs while the pipeline is
     * being built, and optimisePipeline() folds codec scales into
     * lut.inputScale / lut.outputScale afterwards. Read them at call time.
     */
    floatFor: function(lut, hints){
        return { funct: linearInterp1D_NCh, stageName: 'linearInterp1D' };
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
        loops.linearInterp1DArray_NCh_loop(inputArray, 0, outputArray, 0, pixelCount, lut, inAlpha, outAlpha, preserve);
        return outputArray;
    },

    release: function(){
        wasmLifecycle.releaseWasmStates(this.transform);
    },

    provideLut: function(lutMode){ return null; },
};
