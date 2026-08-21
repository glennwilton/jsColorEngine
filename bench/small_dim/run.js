/**
 * bench/small_dim/run.js — throughput for the 1-channel (gray) and 2-channel
 * (duotone) kernels.
 *
 * WHY THIS EXISTS. Every other bench in this repo measures 3- and 4-channel
 * input. Kernel1D and Kernel2D shipped with no throughput coverage at all,
 * which left a hole in exactly the place the v1.6 kernel work starts
 * (docs/deepdive/KernelContract.md phase 2) and made the TODO(B3) fix
 * unmeasurable.
 *
 * NO PROFILES. Gray and duotone ICC profiles in this project are vendor
 * artefacts (RISO) that cannot be committed, and there is no virtual gray
 * profile in createVirtualProfile(). So the LUTs here are SYNTHETIC — built in
 * a few lines, identical on every machine, no licensing, no external files.
 * That is not a compromise for this measurement: the kernels are LUT walkers
 * and what is being timed is the walk, not where the table came from. The
 * existing gray test in transform_lutKernelTable.tests.js takes the same
 * approach for the same reason.
 *
 * WHAT TO WATCH. Both loops currently call their single-colour interpolator
 * once per pixel — `this.linearInterp1D_NCh([input[p]], lut)` — allocating a
 * one-element wrapper array AND an output array for every pixel, roughly 2M
 * allocations per megapixel. That is TODO(B3), open since the v1.5 kernel
 * migration, and it is why these numbers sit where they do. 3D and 4D have had
 * fully inlined array loops all along.
 *
 * Usage:
 *   node bench/small_dim/run.js
 *   node bench/small_dim/run.js --px 2097152 --reps 7
 */
'use strict';

const { Transform } = require('../../src/main.js');
const emit = require('../lib/emit.cjs');

const argv = process.argv.slice(2);
function arg(name, fallback){
    const i = argv.indexOf('--' + name);
    return (i !== -1 && argv[i + 1]) ? Number(argv[i + 1]) : fallback;
}
const PX   = arg('px', 1048576);
const REPS = arg('reps', 5);
const G1   = arg('grid', 256);

emit.meta({ tool: 'bench/small_dim/run.js' });

// ---- synthetic LUTs -----------------------------------------------------
//
// Shaped like the ones createLut() bakes: values in 0..1 scaled out by
// outputScale, input pre-scaled by inputScale so raw u8 indexes straight in.
// `go0`/`go1` are the grid strides the interpolators walk.

function grayLut(outCh, g1){
    const CLUT = new Float64Array(g1 * outCh);
    for(let i = 0; i < g1; i++){
        const v = i / (g1 - 1);
        for(let c = 0; c < outCh; c++){
            // Slightly different response per channel so the compiler cannot
            // collapse the channels and every output is genuinely computed.
            CLUT[i * outCh + c] = Math.min(1, v * (1 + c * 0.07));
        }
    }
    return { inputChannels: 1, outputChannels: outCh, g1, gridPoints: [g1],
             CLUT, inputScale: 1 / 255, outputScale: 255, go0: outCh, intLut: null };
}

function duoLut(outCh, g1){
    const CLUT = new Float64Array(g1 * g1 * outCh);
    let n = 0;
    for(let y = 0; y < g1; y++){
        for(let x = 0; x < g1; x++){
            const a = x / (g1 - 1), b = y / (g1 - 1);
            for(let c = 0; c < outCh; c++){
                CLUT[n++] = Math.min(1, (a * (1 + c * 0.05) + b * (1 - c * 0.03)) * 0.5);
            }
        }
    }
    return { inputChannels: 2, outputChannels: outCh, g1, gridPoints: [g1, g1],
             CLUT, inputScale: 1 / 255, outputScale: 255,
             go0: outCh, go1: g1 * outCh, intLut: null };
}

// ---- harness ------------------------------------------------------------

function build(lut){
    const t = new Transform({ buildLut: true, lutMode: 'float', dataFormat: 'int8' });
    t.lut = lut;
    t.inputChannels  = lut.inputChannels;
    t.outputChannels = lut.outputChannels;
    t.setKernel(lut.inputChannels);
    t._resolveLutKernels();
    return t;
}

function measure(t, inp, out, px){
    // Warm, then best-of-REPS. Best rather than mean: the floor is the
    // measurement, everything above it is interference.
    for(let i = 0; i < 2; i++) t.transformArrayViaLUT(inp, false, false, false, px, undefined, out);
    let best = Infinity;
    for(let r = 0; r < REPS; r++){
        const s = process.hrtime.bigint();
        t.transformArrayViaLUT(inp, false, false, false, px, undefined, out);
        best = Math.min(best, Number(process.hrtime.bigint() - s) / 1e6);
    }
    return (px / 1e6) / (best / 1000);
}

const CASES = [
    { name: 'gray -> RGB',     dims: 1, outCh: 3 },
    { name: 'gray -> CMYK',    dims: 1, outCh: 4 },
    { name: 'gray -> 6CLR',    dims: 1, outCh: 6 },
    { name: 'duotone -> RGB',  dims: 2, outCh: 3 },
    { name: 'duotone -> CMYK', dims: 2, outCh: 4 },
    { name: 'duotone -> 6CLR', dims: 2, outCh: 6 },
];

console.log('');
console.log('====================================================================');
console.log(' Gray and duotone kernels — synthetic LUTs, no profiles required');
console.log('====================================================================');
console.log(' pixels    : ' + PX.toLocaleString());
console.log(' grid      : ' + G1 + (G1 === 256 ? ' (1:1 with u8 input)' : ''));
console.log(' reps      : best of ' + REPS + ' after 2 warm-ups');
console.log(' node      : ' + process.version + '   platform: ' + process.platform + ' ' + process.arch);
console.log('');
console.log(' case              kernel      out ch     MPx/s');
console.log(' ----------------  ----------  ------  --------');

const rows = [];
for(const c of CASES){
    const lut = c.dims === 1 ? grayLut(c.outCh, G1) : duoLut(c.outCh, G1);
    const t   = build(lut);
    const inp = new Uint8ClampedArray(PX * c.dims);
    for(let i = 0; i < inp.length; i++) inp[i] = (i * 7) & 255;
    const out = new Uint8ClampedArray(PX * c.outCh);

    const mpxs = measure(t, inp, out, PX);
    const kernelName = t.kernelInfo().name;

    console.log(' ' + c.name.padEnd(17) + ' ' + kernelName.padEnd(11)
        + ' ' + String(c.outCh).padStart(5) + '   ' + mpxs.toFixed(1).padStart(7));

    rows.push({ workflow: c.name, kernel: kernelName, outputChannels: c.outCh,
                mpxs: Number(mpxs.toFixed(1)) });
}

console.log('');
console.log(' Both loops still delegate to their single-colour interpolator once');
console.log(' per pixel (TODO B3), allocating a wrapper array and an output array');
console.log(' each iteration. 3D and 4D use fully inlined array loops.');
console.log('');

emit.table({
    id: 'smallDim.throughput',
    title: 'Gray and duotone kernel throughput (synthetic LUTs)',
    units: 'MPx/s',
    meta: { pixels: PX, grid: G1, reps: REPS, lutMode: 'float', dataFormat: 'int8' },
    columns: ['workflow', 'kernel', 'outputChannels', 'mpxs'],
    rows,
});
emit.save();
