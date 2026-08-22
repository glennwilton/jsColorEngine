// src/kernels/4d/Kernel4D.js
//
// CMYK (4-channel input) kernel — tetrahedral interpolation with
// WASM SIMD / WASM scalar / JS int8 / JS int16 / float variants.
//
// The same shape as Kernel3D, one dimension up, minus the matrix shaper --
// that fold is a 3-channel idea and has no 4-channel equivalent. So this
// kernel's init() does nothing but resolve its own image path, through the
// switch in kernel4D_table.js next door.
//
// See docs/deepdive/KernelContract.md.
'use strict';

var kernelUtils = require('../kernelUtils.js');
var table = require('./kernel4D_table.js');
var wasmLifecycle = require('../wasmLifecycle.js');
var wasmLoader = require('../../wasm/wasm_loader.js');
var interp = require('../../interp.js');

module.exports = {
    name: 'kernel4D',

    // This kernel's own dispatch. kernelUtils walks it; nobody else
    // needs to know it exists.
    table: table,

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
     * Everything the image path depends on is final by the time init() runs:
     * the pipeline is built and optimised, the LUT exists, and create() has
     * already demoted lutMode to what this host can actually run. So this is
     * where the decision gets made, and it gets made once.
     *
     * The decision itself is the resolve() switch in kernel4D_table.js, next
     * to this file. Open it and you can see every variant this kernel can
     * land on and the order it degrades in.
     */
    init: function(pipeline, opts){
        // Yield is a 3-D idea. Bind waits for create(), after WASM is loaded.
        // 'auto' → single-entry accuracy-path cache; a number is already a
        // decision. Transform injects after this return — see _applyPixelCache.
        var slots = kernelUtils.autoPixelCacheSlots(opts);
        if(slots === undefined) return;
        return { pixelCache: slots };
    },

    /**
     * THE WASM MODULES THIS KERNEL CAN LOAD, and the order it gives up in.
     *
     * Walked by wasmLifecycle.settleWasmStates() at create() time. `load` is
     * the module whose failure demotes lutMode to `demoteTo`; `alsoLoad` is
     * best-effort, covering the output widths the SIMD kernel does not (it
     * handles 3 and 4 output channels; wider needs the scalar module), and its
     * absence demotes nothing -- resolve() below simply picks a lower rung.
     *
     * NOTHING FROM THE OTHER DIMENSION IS HERE. Before v1.6 every create()
     * loaded both families whatever the input width; resolve() has never named
     * a wasmTetra3D* slot, so those compiles were pure cost.
     */
    wasmLadder: {
        'int-wasm-simd':     { load: wasmLoader.createTetra4DSimdState,      slot: 'wasmTetra4DSimd',
                               alsoLoad: wasmLoader.createTetra4DState,      alsoSlot: 'wasmTetra4D',
                               demoteTo: 'int-wasm-scalar' },
        'int-wasm-scalar':   { load: wasmLoader.createTetra4DState,          slot: 'wasmTetra4D',
                               demoteTo: 'int' },
        'int16-wasm-simd':   { load: wasmLoader.createTetra4DInt16SimdState, slot: 'wasmTetra4DInt16Simd',
                               alsoLoad: wasmLoader.createTetra4DInt16State, alsoSlot: 'wasmTetra4DInt16',
                               demoteTo: 'int16-wasm-scalar' },
        'int16-wasm-scalar': { load: wasmLoader.createTetra4DInt16State,     slot: 'wasmTetra4DInt16',
                               demoteTo: 'int16' },
    },

    create: function(lutMode){
        this._variant = null;
        var settled = wasmLifecycle.settleWasmStates(this.transform, this, this.wasmLadder);
        kernelUtils.bindArrayRuns(this);
        return settled;
    },

    /**
     * THE IMAGE PATH. One entry point, whatever the batch size.
     *
     * The BIG/SMALL split is this kernel's own business and stops here: above
     * `threshold` the WASM variant wins, below it the memcpy into linear
     * memory costs more than the interpolation saves. `threshold` is 0 when
     * both slots hold the same implementation, so a kernel with no WASM
     * variant available pays nothing for the split existing.
     *
     * Resolution happens in init(). The check below is the one case init()
     * cannot cover: a LUT attached out-of-band onto a Transform that never
     * ran create(). Once per image, so ~10ns.
     */
    array: function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
        var transform = this.transform;

        // THE PREAMBLE IS THE KERNEL'S. Both defaults used to be applied by
        // whichever caller happened to be in front -- transformArrayViaLUT did
        // them, the bound closure did them again, and a third caller did not,
        // which is how transformArray(input, false, false) on a matrix-shaper
        // pair once returned [] : pixelCount arrived undefined and sized the
        // output as undefined * 3. One place to get it right.
        if(pixelCount === undefined){
            pixelCount = Math.floor(inputArray.length / (lut.inputChannels + (inAlpha ? 1 : 0)));
        }
        // PRESERVE ALPHA IS A PREFERENCE, NOT A RULE. Asking to carry alpha
        // through a batch where some images have none is a reasonable thing to
        // say once and mean for all of them, so it clamps to what the input
        // can actually supply rather than refusing the call.
        preserve = (preserve === undefined ? outAlpha : preserve) && inAlpha;

        outputArray = kernelUtils.ensureOutputArray(transform, lut, pixelCount, outAlpha, outputArray);

        if(this.arrayFnBig === null){
            kernelUtils.bindArrayRuns(this);
            if(this.arrayFnBig === null){
                throw 'kernel4D: failed to resolve the image path for inputChannels=' + lut.inputChannels
                    + ', outputChannels=' + lut.outputChannels + ', lutMode=' + transform.lutMode;
            }
        }

        var run = (pixelCount >= this.threshold) ? this.arrayFnBig : this.arrayFnSml;
        run(transform, inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve);

        // The kernel compacts its own WASM memory. The POLICY is Transform's
        // (setWasmMaxMemory / setWasmShrinkRatio are public API) but the
        // states being compacted have belonged to the kernel since phase 4c.
        wasmLifecycle.compactIfNeeded(this, transform._wasmMaxMemory, transform._wasmShrinkRatio);
        return outputArray;
    },

    release: function(){
        wasmLifecycle.releaseWasmStates(this.transform);
    },

    provideLut: function(lutMode){ return null; },
};
