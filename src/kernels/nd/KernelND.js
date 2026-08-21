// src/kernels/nd/KernelND.js
//
// N-channel catch-all kernel (5CLR-15CLR). Registered across the whole 5..15
// span of the dense kernel registry — one descriptor object in eleven slots,
// so any single dimension can later be replaced with a tuned kernel without
// forking the other ten. See docs/deepdive/KernelContract.md.
// Float-only: N-channel press profiles are a proof/measurement use case, not
// a throughput path, so correctness over speed is the right trade-off.
'use strict';

var kernelUtils = require('../kernelUtils.js');
var wasmLifecycle = require('../wasmLifecycle.js');
var interp = require('../../interp.js');

module.exports = {
    name: 'kernelND',


    // Inclusive [from, to] — registerKernel() fills every slot in the range
    // with this same object. 15 is the ICC ceiling (FCLR).
    dimensions: [5, 15],

    supports: {
        float: true,
        // No int8/int16 or WASM variants — proof/measurement path only
    },

    /**
     * The single-colour stage function for a 5+-channel LUT.
     *
     * One implementation, no choices: N-channel input is a proof and
     * measurement path, so correctness beats speed and there is nothing to
     * select between. `hints` is accepted so every kernel presents the same
     * signature.
     *
     * MUST NOT precompute from `lut` - optimisePipeline() folds codec scales
     * into lut.inputScale / lut.outputScale after the stage is built.
     */
    floatFor: function(lut, hints) {
        return { funct: interp.tetrahedralInterpND_NCh, stageName: 'tetrahedralInterpND' };
    },

    create: function(lutMode) {
        // No ND WASM kernels exist, but the WASM settle still runs so a
        // 'int-wasm-*' lutMode demotes exactly as it did in v1.5 (the init
        // block ran for every input dimension). The design-doc "always
        // return 'float'" demotion lands with the NChannel LUT work.
        this._variant = 'float';
        return wasmLifecycle.settleWasmStates(this.transform);
    },

    // NO DISPATCH. One implementation, called directly by array() below —
    // there is nothing to choose between, so there is nothing to resolve and
    // no init() hook to resolve it in.

    array: function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve) {
        const transform = this.transform;
        const inCh  = transform.inputChannels;
        const outCh = transform.outputChannels;
        const outBPP = outCh + (outAlpha ? 1 : 0);

        // THE PREAMBLE IS THE KERNEL'S. See Kernel3D.array().
        if(pixelCount === undefined){
            pixelCount = Math.floor(inputArray.length / (lut.inputChannels + (inAlpha ? 1 : 0)));
        }
        if(preserve === undefined){
            preserve = outAlpha && inAlpha;
        }

        if (!outputArray) outputArray = new Uint8ClampedArray(pixelCount * outBPP);

        var inputPos = 0, outputPos = 0;
        for (var i = 0; i < pixelCount; i++) {
            var pixel = new Array(inCh);
            for (var c = 0; c < inCh; c++) pixel[c] = inputArray[inputPos++] / 255;
            var result = transform.tetrahedralInterpND_NCh(pixel, lut);
            for (var o = 0; o < outCh; o++) outputArray[outputPos++] = (result[o] * 255) | 0;
            if (preserve)     { outputArray[outputPos++] = inputArray[inputPos++]; }
            else { if (inAlpha) inputPos++; if (outAlpha) outputArray[outputPos++] = 255; }
        }
        return outputArray;
    },

    release: function() {
        wasmLifecycle.releaseWasmStates(this.transform);
    },

    // N-channel INPUT LUT building is not implemented yet — a 5D+ CLUT bake
    // needs the kernel-owned u16 N-D grid walk specified in
    // docs/deepdive/KernelModules.md (memory grows as gridPoints^N, so u16 +
    // reduced grid density is mandatory). Until that lands, decline the LUT:
    // Transform.create() clears buildLut and uses the per-pixel pipeline —
    // correct, just not image-rate. (N-channel OUTPUT profiles don't come
    // through here — a Lab→7CLR transform has a 3-channel input and uses
    // Kernel3D with the generic 3D→NCh loops.)
    provideLut: function(lutMode) {
        // Not silent — the caller asked for buildLut:true and is getting the
        // (correct, slower) per-pixel pipeline instead.
        console.warn('jsColorEngine: buildLut ignored for ' + this.transform.inputChannels
            + '-channel input — an N-D CLUT bake is impractical (grid^N cells) and the '
            + 'profile\'s own A2B grid is authoritative. Using the per-pixel pipeline.');
        return false;
    },
};
