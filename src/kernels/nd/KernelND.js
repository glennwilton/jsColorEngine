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
        // PRESERVE ALPHA IS A PREFERENCE, NOT A RULE. Asking to carry alpha
        // through a batch where some images have none is a reasonable thing to
        // say once and mean for all of them, so it clamps to what the input
        // can actually supply rather than refusing the call.
        preserve = (preserve === undefined ? outAlpha : preserve) && inAlpha;

        if (!outputArray) outputArray = new Uint8ClampedArray(pixelCount * outBPP);

        // THE LUT DOES ITS OWN SCALING, at both ends. lut.inputScale converts
        // whatever the caller hands over into 0..1 grid space, and
        // lut.outputScale converts the CLUT cell back out -- both folded by
        // optimisePipeline() and read at call time.
        //
        // This loop used to divide the input by 255 and multiply the result by
        // 255 on top of that, which is only correct when both scales are 1.
        // Against a normal LUT (1/255 in, 255 out) every colour landed near
        // grid cell 0 and came back saturated: 187 LSB from the single-colour
        // path on the same table. Nothing had reached it -- provideLut()
        // declines, so Transform walks the pipeline instead and this surface is
        // only entered through a LUT attached out of band.
        //
        // Scheme-aware for the same reason floatFor() is: past
        // SIMPLEX_FROM channels the two surfaces would otherwise run different
        // interpolators over the same table.
        var interpFn = (this.interpolatorFor(inCh) === 'simplex')
            ? interp.simplexInterpND_NCh
            : interp.tetrahedralInterpND_NCh;

        var inputPos = 0, outputPos = 0;
        for (var i = 0; i < pixelCount; i++) {
            var pixel = new Array(inCh);
            for (var c = 0; c < inCh; c++) pixel[c] = inputArray[inputPos++];
            var result = interpFn.call(transform, pixel, lut);
            for (var o = 0; o < outCh; o++) outputArray[outputPos++] = Math.round(result[o]);
            if (preserve)     { outputArray[outputPos++] = inputArray[inputPos++]; }
            else { if (inAlpha) inputPos++; if (outAlpha) outputArray[outputPos++] = 255; }
        }
        return outputArray;
    },

    release: function() {
        wasmLifecycle.releaseWasmStates(this.transform);
    },

    /**
     * No CLUT for n-channel input. Returns false, and here is the reasoning,
     * because it is a decision rather than a gap.
     *
     * An A2B-shaped bake is gridPoints^N cells. At 5 channels a 9-point grid
     * is 59k cells; at 8 a 4-point grid is 65k; at 11 and up only 2 points per
     * axis fit, which is a table with no interior at all. So the density that
     * would make a CLUT worth having is exactly the density that stops being
     * encodable.
     *
     * MEASURED, so it is not an assumption. A LUT-backed KernelND.array()
     * against the per-pixel pipeline walk it would replace:
     *
     *     in  grid   pipeline   array()   gain   build   table
     *      5     9      3.23      4.18    1.3x    20ms   1.4MB
     *      6     7      2.22      2.63    1.2x    60ms   3.8MB
     *      8     4      0.71      0.77    1.1x    97ms   1.6MB
     *
     * 1.1x to 1.3x, because BOTH PATHS CALL THE SAME INTERPOLATOR per pixel.
     * A CLUT only removes the other seven pipeline stages, about 0.2us/px.
     * Paying grid^N memory and a 20-97ms build for that is the wrong trade,
     * so Transform.create() clears buildLut and walks the pipeline instead --
     * correct, just not image-rate.
     *
     * (N-channel OUTPUT does not come through here. A Lab->7CLR transform has
     * 3-channel input, so it is Kernel3D on its wide-output runs, and it does
     * build a CLUT.)
     *
     * WHAT WOULD CHANGE THIS. Multi-profile chains. The measurement above is
     * a single hop, where the pipeline is eight stages. A proofing chain --
     * device to PCS to device to PCS -- stacks those, and the per-pixel walk
     * grows with the chain while a baked CLUT stays one interpolation whatever
     * the chain length. The trade that fails at 1.2x for one hop can look very
     * different across four, and this is the hook to revisit when that
     * workflow lands.
     */
    provideLut: function(lutMode) {
        // Not silent — the caller asked for buildLut:true and is getting the
        // (correct, slower) per-pixel pipeline instead.
        console.warn('jsColorEngine: buildLut ignored for ' + this.transform.inputChannels
            + '-channel input — an N-D CLUT bake is impractical (grid^N cells) and the '
            + 'profile\'s own A2B grid is authoritative. Using the per-pixel pipeline.');
        return false;
    },
};
