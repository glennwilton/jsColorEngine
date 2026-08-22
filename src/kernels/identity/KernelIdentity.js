// src/kernels/identity/KernelIdentity.js
//
// The identity kernel — registered at Transform.kernels[0].
//
// WHY DIMENSION 0. The registry is indexed by INPUT DIMENSION, which is not
// the same thing as input channel count. An identity RGB→RGB conversion still
// has three input channels; it just does not need a 3-D kernel, because there
// is nothing to interpolate. Conflating the two is what kept identity outside
// the registry as an `isIdentity` branch in Transform, with its own pipeline
// builder, its own copy loop, its own bound closure, and its own early return
// from create().
//
// All of it lives here now. Transform detects the collapse — that is a
// profile-chain fact and stays where the chain is — sets inputDimension to 0,
// and hands over.
//
// IT STILL CALLS BACK INTO TRANSFORM, AND THAT IS THE POINT. addStage(),
// createPipeline_Input_to_Device() and createPipeline_Device_to_Output() are
// shared by every conversion in the engine and are not identity's to own. What
// belongs here is the DECISION that an identity transform gets a
// device-to-device copy between them — same shape as Kernel3D reaching for the
// matrix shaper. Register a different kernel at index 0 and that decision
// changes, with nothing in Transform.js to edit.
//
// WHAT THAT BUYS BEYOND SYMMETRY. init() receives the pipeline like every
// other kernel, so an identity transform can rewrite its own: an alpha-only
// pass, a copy with a stride change, a clamp, a watermark. And index 0 is
// somewhere to hang a probe that counts identity conversions, which there was
// previously nowhere to hook.
//
// THE IMAGE PATH IS A BOUND FN. Transform calls kernel.array() every batch;
// there is no Transform-level kernelArrayFn. array() is the trampoline.
// init() caches this.arrayFn from dataFormat so the per-call body does not
// switch on format, and so object / device batches get a real copy instead
// of a typed-buffer memcpy they cannot survive.
//
// See docs/deepdive/KernelContract.md and docs/deepdive/Identity.md §6.
'use strict';

var encoding = require('../../def.js').encoding;

/**
 * Cache the format-specific copy on the instance.
 *
 * Called from init() once the pipeline is built, and again from array() if
 * a stranger's init() skipped the bind. arrayFnBig / arrayFnSml stay null:
 * those are LUT dispatch slots, and identity never resolves a table run.
 *
 * @param {object} kernel  per-Transform instance (has .transform)
 */
function bindArrayFn(kernel){
    var format = kernel.transform.dataFormat;
    if(format === 'object' || format === 'objectFloat'){
        kernel.arrayFn = copyObjects;
    } else if(format === 'device'){
        kernel.arrayFn = copyDevice;
    } else {
        // int8 / int16 — the original memcpy. Unknown formats take this
        // path too; copyTyped still reads dataFormat for the container.
        kernel.arrayFn = copyTyped;
    }
}

/**
 * Flat int8 / int16 copy. Was Transform._kernelCopy(), then the body of
 * array(). The loop stays here rather than in a kernelIdentity_loops.js
 * because there is nothing to share it with: the other kernels keep their
 * loops in a separate file so the single-colour and array families cannot
 * end up calling the same body and poisoning the JIT, and identity has no
 * single-colour family to collide with.
 */
function copyTyped(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
    var transform = this.transform;
    var channels  = transform.inputChannels;
    var inputBPP  = channels + (inAlpha  ? 1 : 0);
    var outputBPP = channels + (outAlpha ? 1 : 0);
    var isU16     = (transform.dataFormat === 'int16');

    if(pixelCount === undefined){
        pixelCount = Math.floor(inputArray.length / inputBPP);
    }
    // PRESERVE ALPHA IS A PREFERENCE, NOT A RULE. Asking to carry alpha
    // through a batch where some images have none is a reasonable thing to
    // say once and mean for all of them, so it clamps to what the input
    // can actually supply rather than refusing the call.
    preserve = (preserve === undefined ? outAlpha : preserve) && inAlpha;

    var outputLength = pixelCount * outputBPP;
    if(!outputArray){
        outputArray = isU16 ? new Uint16Array(outputLength)
                            : new Uint8ClampedArray(outputLength);
    }

    // No alpha on either side: the whole thing is one memcpy.
    if(!inAlpha && !outAlpha){
        outputArray.set(inputArray.subarray(0, outputLength));
        return outputArray;
    }

    var opaque = isU16 ? 65535 : 255;
    for(var pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++){
        var inputOffset  = pixelIndex * inputBPP;
        var outputOffset = pixelIndex * outputBPP;
        for(var channelIndex = 0; channelIndex < channels; channelIndex++){
            outputArray[outputOffset + channelIndex] = inputArray[inputOffset + channelIndex];
        }
        if(outAlpha){
            outputArray[outputOffset + channels] = (preserve && inAlpha)
                ? inputArray[inputOffset + channels]
                : opaque;
        }
    }
    return outputArray;
}

/**
 * Flat 0..1 device copy into a plain Array.
 *
 * The typed memcpy would allocate a Uint8ClampedArray and clamp every
 * channel to 0 or 1. Arrays have no .subarray / .set, so this is an
 * element copy. Fill-alpha is 1.0, not 255.
 */
function copyDevice(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
    var channels  = this.transform.inputChannels;
    var inputBPP  = channels + (inAlpha  ? 1 : 0);
    var outputBPP = channels + (outAlpha ? 1 : 0);

    if(pixelCount === undefined){
        pixelCount = Math.floor(inputArray.length / inputBPP);
    }
    preserve = (preserve === undefined ? outAlpha : preserve) && inAlpha;

    var outputLength = pixelCount * outputBPP;
    if(!outputArray){
        outputArray = new Array(outputLength);
    }

    if(!inAlpha && !outAlpha){
        for(var i = 0; i < outputLength; i++){
            outputArray[i] = inputArray[i];
        }
        return outputArray;
    }

    for(var pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++){
        var inputOffset  = pixelIndex * inputBPP;
        var outputOffset = pixelIndex * outputBPP;
        for(var channelIndex = 0; channelIndex < channels; channelIndex++){
            outputArray[outputOffset + channelIndex] = inputArray[inputOffset + channelIndex];
        }
        if(outAlpha){
            outputArray[outputOffset + channels] = (preserve && inAlpha)
                ? inputArray[inputOffset + channels]
                : 1;
        }
    }
    return outputArray;
}

/**
 * Clone each colour object into a new Array.
 *
 * Shallow: channel values are primitives, and shared refs (whitePoint)
 * are not mutated by callers of identity. Mutating an output field must
 * not write through to the input — that is the whole reason this is a
 * clone and not the input array handed back.
 *
 * Alpha flags are ignored. Object format carries alpha as a property
 * when it has one; the pipeline walk never applied the int-style
 * strip / fill / preserve either.
 */
function copyObjects(inputArray, outputArray, pixelCount){
    if(pixelCount === undefined){
        pixelCount = inputArray.length;
    }
    if(!outputArray){
        outputArray = new Array(pixelCount);
    }
    for(var i = 0; i < pixelCount; i++){
        var src = inputArray[i];
        var dst = {};
        for(var key in src){
            dst[key] = src[key];
        }
        outputArray[i] = dst;
    }
    return outputArray;
}

module.exports = {
    name: 'kernelIdentity',

    dimensions: 0,

    /**
     * Build the copy pipeline, then bind the image path for this format.
     *
     * Was Transform._buildIdentityPipeline(). The input and output halves are
     * the same ones every other conversion gets; the middle is a
     * device-to-device stage instead of an interpolation, which is the only
     * part that is an identity decision.
     *
     * The builders push onto transform.pipeline, so the returned pipeline is
     * the same object Transform already holds. _initKernel() therefore skips
     * its re-optimise/re-validate branch, and the optimise below is the only
     * one that runs — which is what the old code did too.
     *
     * @param {Array}  pipeline  the (empty) pipeline Transform built so far
     * @param {object} opts      see Transform._kernelOpts()
     * @returns {{pipeline: Array, kernel: null, meta: object}}
     */
    init: function(pipeline, opts){
        var transform = opts.transform;
        var wrapEnds  = transform.convertInputOutput && transform.dataFormat !== 'device';
        var pcsInfo   = { pcsEncoding: null };

        transform.pipeline = [];

        if(wrapEnds){
            transform.createPipeline_Input_to_Device(pcsInfo, transform.inputProfile);
        } else {
            pcsInfo.pcsEncoding = encoding.device;
        }

        // The identity itself. Object formats carry their colour through the
        // pipeline unchanged and need no stage to say so.
        if(transform.dataFormat !== 'object' && transform.dataFormat !== 'objectFloat'){
            transform.addStage(encoding.device, 'stage_device2device', transform.stage_device2device,
                               null, encoding.device, '  [identity copy]');
        }

        if(wrapEnds){
            transform.createPipeline_Device_to_Output(pcsInfo, transform.outputProfile);
        }

        if(transform.optimise){
            transform.optimisePipeline();
        }

        bindArrayFn(this);

        return {
            pipeline: transform.pipeline,
            kernel: null,
            meta: { name: 'kernelIdentity', dimensions: 0, claimed: false,
                    why: 'the profile chain collapsed to nothing' },
        };
    },

    /**
     * No LUT, so nothing to settle and no lutMode to demote.
     *
     * An identity conversion never builds a CLUT — there is nothing to sample —
     * so none of the WASM interpolation kernels can apply. Returning the
     * requested mode unchanged keeps transform.lutMode reporting what was asked
     * for rather than inventing an answer.
     */
    create: function(lutMode){
        return lutMode;
    },

    /**
     * THE IMAGE PATH. A trampoline onto the format-specific copy bound in
     * init(). Transform calls this every batch; the bound fn is this.arrayFn,
     * not a Transform-level kernelArrayFn.
     *
     * `lut` is ignored, and there will never be one. It stays in the signature
     * because every kernel presents the same one — the matrix shaper ignores it
     * too, for the same reason: its work is in the pipeline, not a table.
     *
     * Returning null is a late decline — array() falls through to the walk.
     */
    array: function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
        if(this.arrayFn === null){
            bindArrayFn(this);
            if(this.arrayFn === null){
                return null;
            }
        }
        return this.arrayFn(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve);
    },

    /** Nothing held: no WASM modules, no LUT, no scratch buffers. */
    release: function(){},

    info: function(){
        return { name: 'kernelIdentity', dimensions: 0, variant: 'copy',
                 claimed: false, cache: 'not-supported' };
    },
};
