/**
 * bench/mpx_summary.js
 * ====================
 *
 * Measures throughput (MPx/s) across the three working modes of the
 * engine, so the README can quote realistic numbers for each:
 *
 *   1. Accuracy / non-LUT path
 *      - Transform({ buildLut: false })
 *      - transformArray() walks the full per-pixel pipeline:
 *        input -> device space -> PCS (XYZ/Lab) -> output device
 *      - No caching, no interpolation. Slower but bit-for-bit what
 *        the generic color conversions produce.
 *
 *   2. lutMode='float' (f64 LUT)
 *      - Transform({ buildLut: true, dataFormat: 'int8', lutMode: 'float' })
 *      - Baked Float64Array CLUT, tetrahedral interpolation in f64.
 *
 *   3. lutMode='int' (u16 LUT, v1.1 default)
 *      - Transform({ buildLut: true, dataFormat: 'int8', lutMode: 'int' })
 *      - Baked Uint16Array CLUT scaled by 65280, Q0.16 weights,
 *        fully int32-specialised tetrahedral kernel.
 *
 * Uses the real-world GRACoL2006 CMYK profile from __tests__/.
 *
 * Run:  node bench/mpx_summary.js
 */
'use strict';

const path = require('path');
const {Transform, eIntent} = require('../src/main');
const Profile = require('../src/Profile');

// ----------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------

// LUT paths run at ~40 Mpx/s; non-LUT runs at ~0.5-3 Mpx/s. Keep the
// input buffer size the same for cache comparability, but adjust the
// iteration counts so all three paths spend similar wall-clock per
// batch (1-2 seconds). Warmup > 100ms lets TurboFan tier up.

const PIXEL_COUNT       = 65536;     // 256 x 256 — stays L2-resident
const TIMED_BATCHES     = 5;         // median of 5 (robust to GC noise)
const BATCH_ITERS_LUT   = 100;       // ~2s per batch for LUT paths
const BATCH_ITERS_NOLUT = 3;         // ~1-2s per batch for non-LUT
const WARMUP_ITERS_LUT  = 500;       // ~5s warmup
const WARMUP_ITERS_NOLUT = 5;        // ~5s warmup (non-LUT iter is ~300-1500ms)

const CMYK_PROFILE_PATH = path.join(__dirname, '..', '__tests__', 'GRACoL2006_Coated1v2.icc');


// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function buildInput(channels, pixelCount){
    var arr = new Uint8ClampedArray(pixelCount * channels);
    var seed = 0x13579bdf;
    for(var i = 0; i < arr.length; i++){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        arr[i] = seed & 0xff;
    }
    return arr;
}

function timeIters(fn, warmupIters, batchIters){
    for(var w = 0; w < warmupIters; w++){ fn(); }
    var samples = [];
    for(var r = 0; r < TIMED_BATCHES; r++){
        var t0 = process.hrtime.bigint();
        for(var i = 0; i < batchIters; i++){ fn(); }
        var t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6 / batchIters);
    }
    samples.sort(function(a, b){ return a - b; });
    return samples[(TIMED_BATCHES / 2) | 0];
}

function mpxPerSec(msPerIter){
    return (PIXEL_COUNT / 1e6) / (msPerIter / 1000);
}

function fmtMpx(mpx){ return mpx.toFixed(1).padStart(6) + ' MPx/s'; }


// ----------------------------------------------------------------------
// Run one direction
// ----------------------------------------------------------------------

function runDirection(name, inputChannels, srcProfile, dstProfile){
    console.log('\n--------------------------------------------------------------');
    console.log(' ' + name);
    console.log('--------------------------------------------------------------');

    var input = buildInput(inputChannels, PIXEL_COUNT);

    // --- 1. Accuracy / non-LUT path ---
    var noLut = new Transform({dataFormat: 'int8', buildLut: false});
    noLut.create(srcProfile, dstProfile, eIntent.relative);
    var msNoLut = timeIters(function(){ noLut.transformArray(input, false, false); },
                            WARMUP_ITERS_NOLUT, BATCH_ITERS_NOLUT);

    // --- 2. lutMode='float' path ---
    var floatT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
    floatT.create(srcProfile, dstProfile, eIntent.relative);
    var msFloat = timeIters(function(){ floatT.transformArray(input); },
                            WARMUP_ITERS_LUT, BATCH_ITERS_LUT);

    // --- 3. lutMode='int' path (v1.1 default) ---
    var intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    intT.create(srcProfile, dstProfile, eIntent.relative);
    var msInt = timeIters(function(){ intT.transformArray(input); },
                          WARMUP_ITERS_LUT, BATCH_ITERS_LUT);

    var mpxNoLut = mpxPerSec(msNoLut);
    var mpxFloat = mpxPerSec(msFloat);
    var mpxInt   = mpxPerSec(msInt);

    console.log('  no LUT (accuracy path)  : ' + fmtMpx(mpxNoLut) +
                '   (' + msNoLut.toFixed(2) + ' ms/iter)');
    console.log('  lutMode = \'float\'     : ' + fmtMpx(mpxFloat) +
                '   (' + msFloat.toFixed(2) + ' ms/iter)   ' +
                (mpxFloat / mpxNoLut).toFixed(0) + 'x vs no LUT');
    console.log('  lutMode = \'int\'       : ' + fmtMpx(mpxInt) +
                '   (' + msInt.toFixed(2) + ' ms/iter)   ' +
                (mpxInt / mpxNoLut).toFixed(0) + 'x vs no LUT, ' +
                (mpxInt / mpxFloat).toFixed(2) + 'x vs float');

    return {name: name, mpxNoLut: mpxNoLut, mpxFloat: mpxFloat, mpxInt: mpxInt};
}


// ----------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------

(async function main(){
    console.log('==============================================================');
    console.log(' MPx/s summary bench — all three working modes');
    console.log('==============================================================');
    console.log(' pixels per iter    : ' + PIXEL_COUNT);
    console.log(' batches x iters    : ' + TIMED_BATCHES + ' x ' +
                BATCH_ITERS_LUT + ' (LUT)  /  ' +
                TIMED_BATCHES + ' x ' + BATCH_ITERS_NOLUT + ' (non-LUT)');
    console.log(' warmup             : ' + WARMUP_ITERS_LUT + ' / ' +
                WARMUP_ITERS_NOLUT + ' iters');
    console.log(' CMYK profile       : GRACoL2006_Coated1v2.icc');
    console.log(' node               : ' + process.version);
    console.log(' platform           : ' + process.platform + ' ' + process.arch);

    var cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + CMYK_PROFILE_PATH);
    if(!cmykProfile.loaded){
        throw new Error('Failed to load CMYK profile: ' + CMYK_PROFILE_PATH);
    }

    var results = [];
    results.push(runDirection('RGB -> RGB    (sRGB -> AdobeRGB)',    3, '*srgb',     '*adobergb'));
    results.push(runDirection('RGB -> CMYK   (sRGB -> GRACoL)',      3, '*srgb',     cmykProfile));
    results.push(runDirection('CMYK -> RGB   (GRACoL -> sRGB)',      4, cmykProfile, '*srgb'));
    results.push(runDirection('CMYK -> CMYK  (GRACoL -> GRACoL)',    4, cmykProfile, cmykProfile));

    // --- Summary table — ready to drop into README.md ---
    console.log('\n==============================================================');
    console.log(' SUMMARY — Mpx/s across all three working modes');
    console.log('==============================================================');
    console.log('  direction                         no-LUT     float      int');
    console.log('  -------------------------------  -------   -------   -------');
    for(var i = 0; i < results.length; i++){
        var r = results[i];
        var line = '  ' + r.name.padEnd(32) +
                   '  ' + r.mpxNoLut.toFixed(1).padStart(5) + ' M' +
                   '   ' + r.mpxFloat.toFixed(1).padStart(5) + ' M' +
                   '   ' + r.mpxInt.toFixed(1).padStart(5) + ' M';
        console.log(line);
    }

    // --- Plain markdown table (copy-paste for docs/README) ---
    console.log('\nMarkdown (copy for README):');
    console.log('| Workflow | No LUT (accuracy) | `lutMode: \'float\'` | `lutMode: \'int\'` |');
    console.log('|---|---|---|---|');
    for(var i = 0; i < results.length; i++){
        var r = results[i];
        // Collapse runs of spaces to a single space for the markdown table.
        var label = r.name.replace(/\s+/g, ' ').trim();
        console.log('| ' + label + ' | ' +
                    r.mpxNoLut.toFixed(2) + ' Mpx/s | ' +
                    r.mpxFloat.toFixed(1)  + ' Mpx/s | ' +
                    r.mpxInt.toFixed(1)    + ' Mpx/s |');
    }
    console.log('');
})();
