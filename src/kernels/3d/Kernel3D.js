// src/kernels/3d/Kernel3D.js
//
// RGB/Lab (3-channel input) kernel — tetrahedral interpolation with
// WASM SIMD / WASM scalar / JS int8 / JS int16 / float variants.
//
// EVERYTHING 3-CHANNEL INPUT IS IN HERE OR NEXT TO IT. The loops are in
// kernel3D_loops.js, the WASM lifecycle in wasmLifecycle.js, the variant
// ladder in kernel3D_table.js, and the other implementation this kernel can
// yield to in matrixShaper/. Transform selects this kernel by input channel
// count, calls init(), and then hands it colours or arrays -- it holds no
// dispatch state and learns nothing about which variant ran.
//
// See docs/deepdive/KernelContract.md.
'use strict';

var kernelUtils = require('../kernelUtils.js');
var table = require('./kernel3D_table.js');
var wasmLifecycle = require('../wasmLifecycle.js');
var wasmLoader = require('../../wasm/wasm_loader.js');
var interp = require('../../interp.js');
var matrixShaper = require('./matrixShaper/matrixShaperKernel.js');
var MatrixShaperKernel = require('./matrixShaper/KernelMatrixShaper.js');
var encoding = require('../../def.js').encoding;

module.exports = {
    name: 'kernel3D',

    // This kernel's own dispatch. kernelUtils walks it; nobody else
    // needs to know it exists.
    table: table,

    dimensions: 3,

    /**
     * What LUT does this kernel want, if any?
     *
     * Asked once during create(), against the TEMPORARY device-to-device
     * pipeline the LUT builder makes before it walks the grid — so the answer
     * is taken on a pipeline that exists rather than predicted from profile
     * types. That matters: an identity pair collapses to three stages and this
     * kernel rightly declines it, which no amount of inspecting
     * inputProfile.type would have revealed.
     *
     *   null    build the CLUT as normal — the answer almost always
     *   false   build none; the matrix shaper runs the folded pipeline instead
     *   {lut}   a LUT this kernel made itself (nothing built-in does, but a
     *           kernel is free to call createNDDeviceLUT and hand back a house
     *           look, an f32-celled table, or a small preview grid)
     *
     * Deliberately conservative about `false`. Saying it means NO CLUT IS
     * BUILT, so a later refusal by inspect() would strand the caller on the
     * generic loops at ~8 MPx/s — far worse than the CLUT it replaced. Every
     * condition inspect() checks is checked there too, against the equivalent
     * stages. Opt-in via `wasmMatrixShaper: 'prefer'`.
     *
     * REPLACED displacesLut() in v1.6 — the same question asked through a
     * narrower hook that could only ever answer "no LUT" or "carry on", and
     * asked of the shared DESCRIPTOR rather than this instance.
     */
    provideLut: function(lutMode){
        try {
            return matrixShaper.wantsInsteadOfLut(this.transform) ? false : null;
        } catch(e){ return null; }
    },

    /**
     * Settle this dimension once the pipeline exists.
     *
     * Kernel3D has two implementations. The table walk is the default; the
     * matrix shaper is the other one, and it applies when the optimiser has
     * folded the pipeline into a curve, a 3x3 and another curve. That is not
     * knowable at setKernel() time -- `*sRGB -> *AdobeRGB` and
     * `*sRGB -> GRACoL` are both 3-channel input and only one of them folds --
     * which is why the decision lives here rather than in the channel count.
     *
     * IT RETURNS THE OTHER KERNEL, not a flag. The matrix shaper keeps the full
     * kernel interface, so Kernel3D hands back an instance and Transform runs
     * it without knowing what it is. Transform has no registry of these and no
     * `claims` protocol; the kernel that owns the dimension decides.
     *
     * Cheap by contract: walks five stage names and samples the two curves. The
     * 3-8 ms table build stays deferred to the first array call, so a Transform
     * that only ever converts single colours never pays it.
     */
    init: function(pipeline, opts){
        // `kernel: null` means NO YIELD — this kernel keeps the transform and
        // runs its own table path. It is not a refusal: Kernel3D always has an
        // answer for 3-channel input, and the only question is which of its two
        // implementations runs. (An earlier draft called this `decline`, left
        // over from the claim registry where declining meant passing to the
        // next claimant. There is no next claimant, and a real decline would
        // fail the transform outright.)
        //
        // Keeping is also the moment to resolve the image path: everything it
        // depends on is final by now (pipeline built and optimised, LUT
        // present, lutMode already demoted by create() to what this host can
        // run). The decision itself is the resolve() switch in
        // kernel3D_table.js next to this file.
        var keep = function(why){
            // Bind happens in create(), after this kernel's WASM is loaded.
            // Yielding first is what stops a matrix-shaper pair compiling
            // tetrahedral modules it will throw away.
            return { pipeline: pipeline, kernel: null,
                     meta: { name: 'kernel3D', dimensions: 3, claimed: false, why: why } };
        };

        if(opts.wasmMatrixShaper === 'off')  return keep('wasmMatrixShaper is off');
        // A forced table (1 / N) is a different execution model — keep the
        // tetra path. 'auto' is not a decision; this kernel leaves it so
        // Transform injects nothing. 4/5/6 promote auto to 1 from their init.
        if(opts.pixelCacheActive)            return keep('a pixel cache is active');

        var verdict;
        try { verdict = matrixShaper.inspect(opts.transform); }
        catch(e){ return keep('inspect threw: ' + e); }

        if(!verdict || verdict.ok !== true) return keep(verdict ? verdict.why : null);

        var instance = Object.create(MatrixShaperKernel);
        instance.transform = opts.transform;
        instance.claimed   = true;
        instance._impl     = undefined;
        instance._variant  = null;
        return { pipeline: pipeline, kernel: instance, meta: instance.info() };
    },

    /**
     * The single-colour stage function for a 3-D LUT, and the stage name.
     *
     * THIS KERNEL DECIDES, THE CALLER HINTS. Everything below used to live in
     * a switch in Transform.addStageLUT. It is dimensional knowledge: the
     * PCS-input trilinear rule exists ONLY for 3-channel input - the 4-D case
     * has no equivalent - which is the clearest single sign it was living in
     * the wrong file.
     *
     * Hints are advisory and this kernel resolves them, but an unrecognised
     * one is an ERROR rather than a silent default. `interpolation3D` is a
     * public option; a typo in it must not quietly select tetrahedral.
     *
     * MUST NOT precompute from `lut` - this runs while the pipeline is being
     * built, and optimisePipeline() folds codec scales into lut.inputScale /
     * lut.outputScale afterwards. Read them at call time.
     */
    floatFor: function(lut, hints){
        hints = hints || {};

        // Trilinear for PCS-indexed input. Little CMS 2.0 switched to
        // tetrahedral and found it disagreed with 1.19, SampleICC and
        // Photoshop on LUTs indexed by Lab: L sits on one axis, so the space
        // is uncentred and tetrahedral splits it badly. Applies to PCS INPUT;
        // the output side does not matter.
        var method = (hints.useTrilinearFor3ChInput
                      && (hints.inputEncoding === encoding.PCSv4
                          || hints.inputEncoding === encoding.PCSv2))
            ? 'trilinear'
            : hints.interpolation3D;

        switch(method){
            case 'tetrahedral':
                if(hints.fast === false){
                    // The readable reference implementation. Numerically
                    // identical to the unrolled variants - the LCMS suite
                    // verifies that - just slower.
                    return { funct: interp.tetrahedralInterp3D_3or4Ch,
                             stageName: 'tetrahedralInterp3D' };
                }
                switch(lut.outputChannels){
                    case 3:  // RGB -> RGB / Lab
                        return { funct: interp.tetrahedralInterp3D_3Ch,
                                 stageName: 'tetrahedralInterp3D' };
                    case 4:  // RGB -> CMYK
                        return { funct: interp.tetrahedralInterp3D_4Ch,
                                 stageName: 'tetrahedralInterp3D' };
                    default: // RGB -> n-colour
                        return { funct: interp.tetrahedralInterp3D_NCh,
                                 stageName: 'tetrahedralInterp3D' };
                }

            case 'trilinear':
                return { funct: interp.trilinearInterp3D_NCh,
                         stageName: 'trilinearInterp3D' };

            default:
                throw 'Unknown 3D interpolation method "' + method + '"';
        }
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
     * a wasmTetra4D* slot, so those compiles were pure cost.
     */
    wasmLadder: {
        'int-wasm-simd':     { load: wasmLoader.createTetra3DSimdState,      slot: 'wasmTetra3DSimd',
                               alsoLoad: wasmLoader.createTetra3DState,      alsoSlot: 'wasmTetra3D',
                               demoteTo: 'int-wasm-scalar' },
        'int-wasm-scalar':   { load: wasmLoader.createTetra3DState,          slot: 'wasmTetra3D',
                               demoteTo: 'int' },
        'int16-wasm-simd':   { load: wasmLoader.createTetra3DInt16SimdState, slot: 'wasmTetra3DInt16Simd',
                               alsoLoad: wasmLoader.createTetra3DInt16State, alsoSlot: 'wasmTetra3DInt16',
                               demoteTo: 'int16-wasm-scalar' },
        'int16-wasm-scalar': { load: wasmLoader.createTetra3DInt16State,     slot: 'wasmTetra3DInt16',
                               demoteTo: 'int16' },
    },

    create: function(lutMode){
        // Load THIS kernel's modules, then bind the image path. init() has
        // already decided we kept the transform (a yield never reaches here).
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
                throw 'kernel3D: failed to resolve the image path for inputChannels=' + lut.inputChannels
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

};
