// src/kernels/6d/Kernel6D.js
//
// 6-channel input (Hexachrome / 6CLR) — tetrahedral on the last three axes,
// linear peel on the first three. int8 JS + WASM scalar. 7+ stays on KernelND.
'use strict';

var kernelUtils = require('../kernelUtils.js');
var table = require('./kernel6D_table.js');
var wasmLifecycle = require('../wasmLifecycle.js');
var wasmLoader = require('../../wasm/wasm_loader.js');
var interp = require('../../interp.js');

function noSimd6D(){ return null; }

module.exports = {
    name: 'kernel6D',
    table: table,
    dimensions: 6,

    supports: {
        float: true,
        int8_js: true,
        int8_scalar: true,
    },

    floatFor: function(lut, hints){
        return { funct: interp.tetrahedralInterpND_NCh, stageName: 'tetrahedralInterpND' };
    },

    init: function(pipeline, opts){
        var slots = kernelUtils.autoPixelCacheSlots(opts);
        if(slots === undefined) return;
        return { pixelCache: slots };
    },

    wasmLadder: {
        'int-wasm-simd':     { load: noSimd6D, slot: 'wasmTetra6D',
                               demoteTo: 'int-wasm-scalar' },
        'int-wasm-scalar':   { load: wasmLoader.createTetra6DState, slot: 'wasmTetra6D',
                               demoteTo: 'int' },
    },

    create: function(lutMode){
        this._variant = null;
        var settled = wasmLifecycle.settleWasmStates(this.transform, this, this.wasmLadder);
        kernelUtils.bindArrayRuns(this);
        return settled;
    },

    array: function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
        var transform = this.transform;
        if(pixelCount === undefined){
            pixelCount = Math.floor(inputArray.length / (lut.inputChannels + (inAlpha ? 1 : 0)));
        }
        preserve = (preserve === undefined ? outAlpha : preserve) && inAlpha;
        outputArray = kernelUtils.ensureOutputArray(transform, lut, pixelCount, outAlpha, outputArray);

        if(this.arrayFnBig === null){
            kernelUtils.bindArrayRuns(this);
            if(this.arrayFnBig === null){
                throw 'kernel6D: failed to resolve the image path for inputChannels=' + lut.inputChannels
                    + ', outputChannels=' + lut.outputChannels + ', lutMode=' + transform.lutMode;
            }
        }

        var run = (pixelCount >= this.threshold) ? this.arrayFnBig : this.arrayFnSml;
        run(transform, inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve);
        wasmLifecycle.compactIfNeeded(this, transform._wasmMaxMemory, transform._wasmShrinkRatio);
        return outputArray;
    },

    release: function(){
        wasmLifecycle.releaseWasmStates(this.transform);
    },

    provideLut: function(lutMode){ return null; },
};
