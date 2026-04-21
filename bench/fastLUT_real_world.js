/**
 * lutMode='int' real-world bench   (was: fastLUT real-world bench)
 * ================================================================
 *
 * Measures the integer-math hot path (lutMode: 'int') against the float
 * reference (lutMode: 'float') using the GRACoL2006 ICC profile. Covers
 * all four 3-/4-channel directions, all of which are now active in v1.1:
 *
 *   1. RGB->RGB    sRGB -> AdobeRGB         (3D 3Ch, int kernel active)
 *   2. RGB->CMYK   sRGB -> GRACoL CMYK      (3D 4Ch, int kernel active)
 *   3. CMYK->RGB   GRACoL -> sRGB           (4D 3Ch, int kernel active — NEW v1.1)
 *   4. CMYK->CMYK  GRACoL -> GRACoL         (4D 4Ch, int kernel active — NEW v1.1)
 *
 * For each: build lutMode='int' and lutMode='float' transforms, run them
 * over the same input buffer, report median ms/iter, MPx/s, speedup,
 * accuracy histogram, and an edge-case spot check.
 *
 * Run:   node bench/fastLUT_real_world.js
 *
 * --------------------------------------------------------------------
 * INTERPRETING THE RESULTS
 * --------------------------------------------------------------------
 *
 * Expect on 3D directions:
 *   - speedup:     1.05x .. 1.15x   (real engine speedup)
 *   - max diff:    0 LSB (RGB→RGB) / 1 LSB (RGB→CMYK) on u8
 *   - LUT memory:  4x smaller (Uint16Array vs Float64Array)
 *
 * Expect on 4D directions:
 *   - speedup:     1.05x .. 1.20x   (slightly larger than 3D — the
 *                   integer K-LERP saves more vs the float K-LERP)
 *   - max diff:    1 LSB on u8 (after the v1.1 fixes to the u16 CLUT
 *                   scale factor — 65280 not 65535 — and the Q0.16
 *                   gridPointsScale_fixed; residual 1 LSB is just
 *                   banker's-rounding-vs-half-up at exact half-ties)
 *
 * "off by >=16" must be 0 — that's the regression indicator. Any non-
 * zero value means a boundary patch (any of the C/M/Y/K === 255 paths)
 * is broken.
 *
 * --------------------------------------------------------------------
 * KEY FINDING vs the POC bench (bench/int_vs_float.js)
 * --------------------------------------------------------------------
 *
 * The POC bench reported a 1.5x speedup, but it called the float kernel
 * as a STANDALONE function. V8 specializes class methods on stable
 * hidden classes more aggressively than standalone functions, so the
 * SAME float math runs ~2x faster as a Transform method (75 MPx/s) than
 * as a standalone (41 MPx/s). The integer kernel's relative gain shrinks
 * accordingly — 1.5x in the POC drops to ~1.1x in the engine.
 *
 * This is NOT a regression. The integer kernel is genuinely faster; the
 * float kernel just got faster too (for free, by being a class method)
 * which compresses the ratio. Net wins:
 *   - ~10% throughput improvement on 3D image transforms
 *   - 4x less LUT memory (helpful when many transforms are cached)
 *   - lower GC pressure (no float allocations in the hot loop)
 *
 * If you want the headline POC numbers: they remain valid as a "what's
 * possible if you bypass the engine" comparison. They just don't
 * translate to the real engine because the engine's float path is
 * already very well optimized.
 *
 * --------------------------------------------------------------------
 * NOT A MICROBENCH — uses the full Transform.transformArray pipeline,
 * so dispatch + alpha branches are included. That's the point: it
 * measures what users actually see, not the kernel in a vacuum.
 * --------------------------------------------------------------------
 */
'use strict';

const path = require('path');
const {Transform, eIntent} = require('../src/main');
const Profile = require('../src/Profile');

// ====================================================================
// Configuration
// ====================================================================

const PIXEL_COUNT = 65536;       // 256x256 — small enough to stay L2-resident
const TIMED_BATCHES = 5;         // 5 batches, take median (robust to GC noise)
const BATCH_ITERS   = 100;       // 100 iters per batch (amortise process.hrtime cost)
const WARMUP_ITERS  = 1000;      // let TurboFan fully optimize both kernels
const CMYK_PROFILE_PATH = path.join(__dirname, '..', '__tests__', 'GRACoL2006_Coated1v2.icc');


// ====================================================================
// Helpers
// ====================================================================

function buildRgbInput(pixelCount){
    // Deterministic LCG spread across the cube. Avoid Math.random() so
    // accuracy numbers are reproducible across runs.
    var arr = new Uint8ClampedArray(pixelCount * 3);
    var seed = 0x13579bdf;
    for(var i = 0; i < arr.length; i++){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        arr[i] = seed & 0xff;
    }
    return arr;
}

function buildCmykInput(pixelCount){
    var arr = new Uint8ClampedArray(pixelCount * 4);
    var seed = 0x2468ace0;
    for(var i = 0; i < arr.length; i++){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        arr[i] = seed & 0xff;
    }
    return arr;
}

function timeIters(fn){
    // Warmup — long enough for TurboFan tier-up. ~1000 iters on a 65k
    // input array is what the proof-of-concept bench (int_vs_float.js)
    // settled on after observing JIT timing ramp.
    for(var w = 0; w < WARMUP_ITERS; w++){ fn(); }
    // Timed: median of TIMED_BATCHES batches of BATCH_ITERS each. The
    // batching amortises process.hrtime.bigint() conversion overhead and
    // averages out single-iter scheduling jitter.
    var samples = [];
    for(var r = 0; r < TIMED_BATCHES; r++){
        var t0 = process.hrtime.bigint();
        for(var i = 0; i < BATCH_ITERS; i++){ fn(); }
        var t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6 / BATCH_ITERS);
    }
    samples.sort(function(a, b){ return a - b; });
    return samples[(TIMED_BATCHES / 2) | 0];
}

function diffStats(a, b, channelsPerPixel){
    var hist = {exact: 0, off1: 0, off2: 0, off3to15: 0, off16plus: 0};
    var max = 0, maxIdx = -1;
    for(var i = 0; i < a.length; i++){
        var d = Math.abs(a[i] - b[i]);
        if(d === 0) hist.exact++;
        else if(d === 1) hist.off1++;
        else if(d === 2) hist.off2++;
        else if(d < 16) hist.off3to15++;
        else hist.off16plus++;
        if(d > max){ max = d; maxIdx = i; }
    }
    return {hist: hist, max: max, maxIdx: maxIdx, total: a.length};
}

function pct(n, total){
    return ((n / total) * 100).toFixed(2) + '%';
}

function runDirection(name, inputChannels, outputChannels, srcProfile, dstProfile, edgePixels){
    console.log('\n--------------------------------------------------------------');
    console.log(' ' + name);
    console.log('  ' + inputChannels + 'Ch -> ' + outputChannels + 'Ch  (LUT shape: ' +
                (inputChannels === 3 ? '3D' : '4D') + ' ' + outputChannels + 'Ch)');
    console.log('--------------------------------------------------------------');

    var input = inputChannels === 3 ? buildRgbInput(PIXEL_COUNT) : buildCmykInput(PIXEL_COUNT);

    var floatT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
    floatT.create(srcProfile, dstProfile, eIntent.relative);

    var fastT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    fastT.create(srcProfile, dstProfile, eIntent.relative);

    var fastActive = !!fastT.lut.intLut;
    console.log('  int kernel active:   ' + fastActive +
                (fastActive ? '' : '   (unsupported shape — fell through to float)'));

    if(fastActive){
        var bytesU16 = fastT.lut.intLut.CLUT.byteLength;
        var bytesF64 = floatT.lut.CLUT.byteLength;
        console.log('  LUT memory: u16 ' + (bytesU16 / 1024).toFixed(1) +
                    ' KB  vs  float64 ' + (bytesF64 / 1024).toFixed(1) +
                    ' KB  (' + (bytesF64 / bytesU16).toFixed(1) + 'x smaller)');
    }

    // Accuracy first (one shot, full input).
    var oFloat = floatT.transformArray(input);
    var oFast  = fastT.transformArray(input);
    var stats  = diffStats(oFloat, oFast, outputChannels);

    console.log('  Accuracy (' + stats.total + ' channels):');
    console.log('    exact:           ' + stats.hist.exact      + '  (' + pct(stats.hist.exact, stats.total) + ')');
    console.log('    off by 1:        ' + stats.hist.off1       + '  (' + pct(stats.hist.off1, stats.total) + ')');
    console.log('    off by 2:        ' + stats.hist.off2       + '  (' + pct(stats.hist.off2, stats.total) + ')');
    console.log('    off by 3..15:    ' + stats.hist.off3to15   + '  (' + pct(stats.hist.off3to15, stats.total) + ')');
    console.log('    off by >=16:     ' + stats.hist.off16plus  + '  (' + pct(stats.hist.off16plus, stats.total) + ')');
    console.log('    max diff:        ' + stats.max + ' LSB');

    // Speed pass.
    var msFloat = timeIters(function(){ floatT.transformArray(input); });
    var msFast  = timeIters(function(){ fastT.transformArray(input);  });
    var mpxFloat = (PIXEL_COUNT / 1e6) / (msFloat / 1000);
    var mpxFast  = (PIXEL_COUNT / 1e6) / (msFast  / 1000);
    var speedup  = msFloat / msFast;

    console.log('  Speed (median of ' + TIMED_BATCHES + ' batches x ' + BATCH_ITERS +
                ' iters, warmup ' + WARMUP_ITERS + ', ' + PIXEL_COUNT + ' px/iter):');
    console.log('    Float kernel:    ' + msFloat.toFixed(2) + ' ms/iter   (' + mpxFloat.toFixed(1) + ' MPx/s)');
    console.log('    Fast kernel:     ' + msFast.toFixed(2)  + ' ms/iter   (' + mpxFast.toFixed(1)  + ' MPx/s)');
    console.log('    Speedup:         ' + speedup.toFixed(2) + 'x');

    // Edge case spot check.
    if(edgePixels && edgePixels.length){
        var nIn = edgePixels[0].length;
        var flat = [];
        for(var p = 0; p < edgePixels.length; p++){
            for(var c = 0; c < nIn; c++){ flat.push(edgePixels[p][c]); }
        }
        var eOFloat = floatT.transformArray(flat);
        var eOFast  = fastT.transformArray(flat);
        console.log('  Edge cases (' + edgePixels.length + ' inputs, max LSB delta vs float):');
        var fail = 0;
        for(var p = 0; p < edgePixels.length; p++){
            var perPx = 0;
            for(var c = 0; c < outputChannels; c++){
                var d = Math.abs(eOFloat[p * outputChannels + c] - eOFast[p * outputChannels + c]);
                if(d > perPx) perPx = d;
            }
            if(perPx > 2){ fail++; }
            // Print only the worst few — keep output readable.
        }
        var maxEdge = 0;
        for(var i = 0; i < eOFloat.length; i++){
            var d = Math.abs(eOFloat[i] - eOFast[i]);
            if(d > maxEdge) maxEdge = d;
        }
        console.log('    max edge delta:  ' + maxEdge + ' LSB');
        console.log('    edges over 2 LSB: ' + fail + ' / ' + edgePixels.length);
    }

    // Verdict.
    // Accuracy budgets (per output channel, u8) after the v1.1 CLUT-
    // scale + Q0.16 gps fixes:
    //   3D 3Ch   → 1 LSB   (measured 0 LSB max on sRGB→AdobeRGB)
    //   3D 4Ch   → 1 LSB
    //   4D 3Ch   → 1 LSB   (was 3 LSB pre-fix — see buildIntLut JSDoc)
    //   4D 4Ch   → 1 LSB   (was 3 LSB pre-fix)
    // If any direction starts exceeding 1 LSB something regressed.
    var accuracyBudget = 1;

    var verdict;
    if(!fastActive){
        verdict = stats.max === 0
            ? 'PASS  (fellthrough — bit-exact)'
            : 'FAIL  (fellthrough should be bit-exact but max diff = ' + stats.max + ')';
    } else if(stats.hist.off16plus > 0){
        verdict = 'REGRESSION  (off by >=16 — boundary patch likely broken)';
    } else if(speedup >= 1.05 && stats.max <= accuracyBudget){
        verdict = 'SHIP IT  (speedup ' + speedup.toFixed(2) + 'x, max diff ' + stats.max + ' LSB)';
    } else if(speedup >= 0.95 && stats.max <= accuracyBudget){
        // Within noise floor — V8 sometimes gives float kernel its best
        // optimizations on certain runs. Re-running often shifts within
        // ±5%. Not a regression as long as accuracy is on target.
        verdict = 'NEUTRAL  (speedup ' + speedup.toFixed(2) + 'x within noise floor; accuracy fine)';
    } else {
        verdict = 'INVESTIGATE  (speedup=' + speedup.toFixed(2) + 'x, max=' + stats.max + ' LSB)';
    }
    console.log('  Verdict: ' + verdict);

    return {name: name, fastActive: fastActive, speedup: speedup, max: stats.max,
            off16: stats.hist.off16plus, msFloat: msFloat, msFast: msFast};
}


// ====================================================================
// Main
// ====================================================================

(async function main(){
    console.log('==============================================================');
    console.log(' lutMode=\'int\' real-world bench');
    console.log('   pixels per iter:   ' + PIXEL_COUNT);
    console.log('   batches x iters:   ' + TIMED_BATCHES + ' x ' + BATCH_ITERS + '  (median)');
    console.log('   warmup:            ' + WARMUP_ITERS + ' iters');
    console.log('   profile:           GRACoL2006_Coated1v2.icc');
    console.log('==============================================================');

    var cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + CMYK_PROFILE_PATH);
    if(!cmykProfile.loaded){
        throw new Error('Failed to load CMYK profile: ' + CMYK_PROFILE_PATH);
    }

    // Edge cases that exercise the boundary patch and known sore spots.
    var rgbEdges = [
        [0,0,0], [255,255,255],
        [255,0,0], [0,255,0], [0,0,255],
        [255,255,0], [255,0,255], [0,255,255],
        [128,128,128], [127,127,127], [129,129,129],
        [254,254,254], [1,1,1]
    ];
    var cmykEdges = [
        [0,0,0,0],          // paper white
        [0,0,0,255],        // pure K
        [255,0,0,0], [0,255,0,0], [0,0,255,0], // pure C/M/Y
        [255,255,0,0], [0,255,255,0], [255,0,255,0], // overprints
        [255,255,255,255],  // 400% TAC corner (extreme)
        [128,128,128,0], [128,128,128,128]   // K-interp probes
    ];

    var results = [];
    results.push(runDirection('RGB -> RGB    (sRGB -> AdobeRGB)',
                3, 3, '*srgb', '*adobergb', rgbEdges));
    results.push(runDirection('RGB -> CMYK   (sRGB -> GRACoL)',
                3, 4, '*srgb', cmykProfile, rgbEdges));
    results.push(runDirection('CMYK -> RGB   (GRACoL -> sRGB)',
                4, 3, cmykProfile, '*srgb', cmykEdges));
    results.push(runDirection('CMYK -> CMYK  (GRACoL -> GRACoL)',
                4, 4, cmykProfile, cmykProfile, cmykEdges));

    console.log('\n==============================================================');
    console.log(' SUMMARY');
    console.log('==============================================================');
    console.log('  direction                              speedup    max diff   off>=16');
    console.log('  ------------------------------------   -------   --------   -------');
    for(var i = 0; i < results.length; i++){
        var r = results[i];
        var line = '  ' + r.name.padEnd(38) + '   ' +
                   r.speedup.toFixed(2).padStart(5) + 'x   ' +
                   String(r.max).padStart(5) + ' LSB' +
                   '   ' + String(r.off16).padStart(7);
        if(!r.fastActive) line += '   (4D fallthrough)';
        console.log(line);
    }
    console.log('');
    console.log('  Notes:');
    console.log('    * All 4 directions use the integer kernel in v1.1 (3D and 4D).');
    console.log('    * 3D: ~1.05-1.15x speedup, 4x smaller LUT, max diff 0-1 LSB.');
    console.log('    * 4D: ~1.05-1.20x speedup, 4x smaller LUT, max diff 1 LSB');
    console.log('      (after v1.1 CLUT-scale & Q0.16 gps fixes — was up to 3 LSB).');
    console.log('    * "off>=16" must be 0 — any non-zero is a boundary regression.');
    console.log('    * See file header for why these numbers are lower than the');
    console.log('      bench/int_vs_float*.js POC headlines (1.5x / 1.6x).');
    console.log('');
})();
