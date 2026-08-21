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

// ---------------------------------------------------------------------------
// WHICH N-CHANNEL INTERPOLATOR RUNS, and where the line is.
//
// Two schemes, opposite shapes:
//
//   'tetrahedral'  the Little CMS scheme -- tetrahedral on the last three
//                  axes, linear on every extra one. 2^(n-3) tetrahedral
//                  evaluations, so the cost DOUBLES with every channel.
//   'simplex'      one Kuhn simplex across all n axes. O(n), so the cost is
//                  FLAT: 0.98 MPx/s at 5 channels, 0.53 at 15.
//
// Measured, mean MPx/s by input width (bench/channel_matrix/run.js), against
// LSB from lcms (bench/lcms-comparison/accuracy_nchannel.js):
//
//    ch   tetrahedral      simplex          who wins
//     5   2.50  m 0.197    0.98  m 0.177    tetrahedral, 2.6x faster
//     7   1.11              0.86            tetrahedral, 1.3x faster
//     8   0.68  m 0.021    0.85  m 0.479    crossover
//    10   0.20  m 0.008    0.69  m 1.130    simplex 3.4x, tetrahedral 140x closer
//    12   0.055             0.65            simplex 12x
//    15   0.007             0.53            simplex 75x
//
// SPLIT AT 11, NOT AT THE CROSSOVER. The speed crossover is 8, but between 8
// and 10 the accuracy difference is still real -- mean 0.02 against 0.48-1.13
// LSB -- and paying 1.2x to 3.4x to stay close to the reference CMS is worth
// it there.
//
// At 11 and up the A2B grid is 2 POINTS PER AXIS. That is not a density
// choice, it is the ceiling: the table is grid^n cells, so 3^11 is already 1.6
// million and 3^15 is 43 million. A 2-point table has no interior at all --
// every point is a corner, there is nothing between them to describe, and the
// Lab gamut is a lobed solid that a box of 2^n corners cannot express in any
// case. Accuracy there is not something either scheme can deliver, so 6x to
// 75x is bought with nothing.
//
// The other way round -- PCS to device, a 3-D grid with an n-channel output --
// has none of this problem and runs on Kernel3D at full speed. That is what
// real 12- and 15-colour profiles are built around, and why this path being
// slow matters less than it looks.
//
// 'auto' is the default. 'tetrahedral' and 'simplex' force one everywhere,
// which is how the table above was measured.
var ND_INTERPOLATOR = 'auto';

// Above this many input channels, 'auto' takes the simplex.
var SIMPLEX_FROM = 11;

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
    // Readable so a bench or a report can record WHICH interpolator produced
    // its numbers. A results file that does not name the scheme it measured is
    // a trap: the two differ by up to 75x at 15 channels, and the difference
    // looks exactly like a regression to anyone comparing runs.
    ndInterpolator: ND_INTERPOLATOR,
    simplexFrom: SIMPLEX_FROM,

    /** Which scheme this many input channels gets. See the note at the top. */
    interpolatorFor: function(channels){
        if(ND_INTERPOLATOR === 'simplex') return 'simplex';
        if(ND_INTERPOLATOR === 'tetrahedral') return 'tetrahedral';
        return (channels >= SIMPLEX_FROM) ? 'simplex' : 'tetrahedral';
    },

    floatFor: function(lut, hints) {
        // The stage name does not change with the scheme: it is what
        // optimisePipeline() and the compiler match on, and both
        // implementations occupy the same slot in the pipeline.
        const scheme = this.interpolatorFor(lut.inputChannels);
        return {
            funct: (scheme === 'simplex')
                ? interp.simplexInterpND_NCh
                : interp.tetrahedralInterpND_NCh,
            stageName: 'tetrahedralInterpND',
        };
    },

    create: function(lutMode) {
        // No ND WASM kernels exist, but the WASM settle still runs so a
        // 'int-wasm-*' lutMode demotes exactly as it did in v1.5 (the init
        // block ran for every input dimension). The design-doc "always
        // return 'float'" demotion lands with the NChannel LUT work.
        this._variant = 'float';
        return wasmLifecycle.settleWasmStates(this.transform, this, this.wasmLadder);
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
