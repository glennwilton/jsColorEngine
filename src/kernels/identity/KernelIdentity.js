// src/kernels/identity/KernelIdentity.js
//
// The identity kernel — registered at Transform.kernels[0].
//
// WHY DIMENSION 0. The registry is indexed by INPUT DIMENSION, which is not
// the same thing as input channel count. An identity RGB→RGB conversion still
// has three input channels; it just does not need a 3-D kernel, because there
// is no interpolation to do. Conflating the two is what kept identity outside
// the registry as an `isIdentity` branch in Transform, with its own pipeline
// builder call, its own bound closure, and its own path through create().
//
// Now it is a kernel like any other. Transform detects the collapse — that is
// a profile-chain fact and stays where the chain is — sets inputDimension to
// 0, and hands over. Everything after that is this file's business.
//
// WHAT THAT BUYS BEYOND SYMMETRY. init() receives the pipeline like every
// other kernel, so an identity transform can now REWRITE ITS OWN PIPELINE: an
// alpha-only pass, a copy with a stride change, a clamp, a watermark. None of
// it becomes Transform's business. And index 0 is somewhere to hang a test
// kernel that counts identity conversions, which there was previously nowhere
// to hook.
//
// See docs/deepdive/KernelContract.md and docs/deepdive/Identity.md.
'use strict';

module.exports = {
    name: 'kernelIdentity',

    dimensions: 0,

    /**
     * Build the copy pipeline.
     *
     * THE DECISION MOVED, THE BUILDERS DID NOT. createPipeline_Input_to_Device
     * and its siblings are shared with every other conversion and stay on
     * Transform; what moved here is the CHOICE that an identity transform gets
     * a device-to-device copy between them. Register a different kernel at
     * index 0 and that choice changes, with nothing in Transform.js to edit —
     * which is the whole point, and is the same shape as Kernel3D yielding to
     * the matrix shaper.
     *
     * Returning the pipeline rather than assigning it means _initKernel()
     * re-optimises and re-validates it, exactly as it would for any other
     * kernel that rewrites what it was handed.
     *
     * @param {Array}  pipeline  the (empty) pipeline Transform built so far
     * @param {object} opts      see Transform._kernelOpts()
     * @returns {{pipeline: Array, kernel: null, meta: object}}
     */
    init: function(pipeline, opts){
        var transform = opts.transform;
        transform._buildIdentityPipeline();
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
     * so none of the WASM interpolation kernels can apply to it. Returning the
     * requested mode unchanged keeps transform.lutMode reporting what was
     * asked for rather than inventing an answer.
     */
    create: function(lutMode){
        return lutMode;
    },

    /**
     * THE IMAGE PATH. A copy, with whatever alpha handling was asked for.
     *
     * _kernelCopy stays on Transform.prototype alongside the other tuned
     * loops, for the same reason the 3-D and 4-D loops do: it is hot, and the
     * prototype is where V8 has been given every chance to specialise it.
     * The argument reorder is the whole of this function.
     *
     * `lut` is ignored, and there will never be one. It stays in the signature
     * because every kernel presents the same one — the matrix shaper ignores
     * it too, for the same reason: its work is in the pipeline, not a table.
     */
    array: function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
        return this.transform._kernelCopy(inputArray, inAlpha, outAlpha, preserve,
                                          pixelCount, outputArray);
    },

    /** Nothing held: no WASM modules, no LUT, no scratch buffers. */
    release: function(){},

    info: function(){
        return { name: 'kernelIdentity', dimensions: 0, variant: 'copy', claimed: false };
    },
};
