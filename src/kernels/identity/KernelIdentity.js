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
// See docs/deepdive/KernelContract.md and docs/deepdive/Identity.md §6.
'use strict';

var encoding = require('../../def.js').encoding;

module.exports = {
    name: 'kernelIdentity',

    dimensions: 0,

    /**
     * Build the copy pipeline.
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
     * THE IMAGE PATH. A copy, with whatever alpha handling was asked for.
     *
     * Was Transform._kernelCopy(). It moved here rather than to a
     * kernelIdentity_loops.js because there is nothing to share it with: the
     * other kernels keep their loops in a separate file so the single-colour
     * and array families cannot end up calling the same body and poisoning the
     * JIT, and identity has no single-colour family to collide with.
     *
     * `lut` is ignored, and there will never be one. It stays in the signature
     * because every kernel presents the same one — the matrix shaper ignores it
     * too, for the same reason: its work is in the pipeline, not a table.
     */
    array: function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
        var transform = this.transform;
        var channels  = transform.inputChannels;
        var inputBPP  = channels + (inAlpha  ? 1 : 0);
        var outputBPP = channels + (outAlpha ? 1 : 0);
        var isU16     = (transform.dataFormat === 'int16');

        if(pixelCount === undefined){
            pixelCount = Math.floor(inputArray.length / inputBPP);
        }
        if(preserve === undefined){
            preserve = outAlpha && inAlpha;
        }

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
    },

    /** Nothing held: no WASM modules, no LUT, no scratch buffers. */
    release: function(){},

    info: function(){
        return { name: 'kernelIdentity', dimensions: 0, variant: 'copy', claimed: false };
    },
};
