'use strict';

const {Transform, eIntent} = require('../src/main');

/**
 * bench/transformArray_reuse_output_bench.js
 *
 * Micro-bench: compare transformArray() default allocation vs optional
 * reusable output buffer on the LUT-routed fast path, across all three
 * lutMode tiers (int, int-wasm-scalar, int-wasm-simd).
 *
 * Run:  node bench/transformArray_reuse_output_bench.js
 */

var PIXEL_COUNT = 1024 * 1024;
var WARMUP_ITERS = 40;
var TIMED_BATCHES = 6;
var BATCH_ITERS = 12;

function buildRgbInput(pixelCount){
    var arr = new Uint8ClampedArray(pixelCount * 3);
    var seed = 0x12345678;
    for(var i = 0; i < arr.length; i++){
        seed = (seed * 1664525 + 1013904223) >>> 0;
        arr[i] = seed & 0xff;
    }
    return arr;
}

function median(values){
    var copy = values.slice().sort(function(a, b){ return a - b; });
    return copy[(copy.length / 2) | 0];
}

function timeMode(label, fn){
    for(var w = 0; w < WARMUP_ITERS; w++){ fn(); }
    var samples = [];
    for(var b = 0; b < TIMED_BATCHES; b++){
        var t0 = process.hrtime.bigint();
        for(var i = 0; i < BATCH_ITERS; i++){ fn(); }
        var t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6 / BATCH_ITERS);
    }
    var med = median(samples);
    return {
        label: label,
        msPerIter: med,
        mpxPerSec: (PIXEL_COUNT / 1e6) / (med / 1000)
    };
}

function fmt(n){ return n.toFixed(2); }

// RGB→RGB: 3 in + 3 out = 6 bytes per pixel
var TOTAL_BPP = 6;

function runMode(modeName){
    var transform = new Transform({
        dataFormat: 'int8',
        buildLut: true,
        lutMode: modeName
    });
    transform.create('*srgb', '*adobe1998', eIntent.relative);
    var effectiveMode = transform.lutMode;

    var input = buildRgbInput(PIXEL_COUNT);
    var outReusable = new Uint8ClampedArray(PIXEL_COUNT * 3);

    var checksumAlloc = 0;
    var alloc = timeMode('alloc-each-call', function(){
        var out = transform.transformArray(input, false, false, false, PIXEL_COUNT);
        checksumAlloc = (checksumAlloc + out[0] + out[out.length - 1]) >>> 0;
    });

    var checksumReuse = 0;
    var reuse = timeMode('reuse-output-buffer', function(){
        var out = transform.transformArray(input, false, false, false, PIXEL_COUNT, undefined, outReusable);
        checksumReuse = (checksumReuse + out[0] + out[out.length - 1]) >>> 0;
    });

    var speedup = alloc.msPerIter / reuse.msPerIter;
    var deltaPct = ((alloc.msPerIter - reuse.msPerIter) / alloc.msPerIter) * 100;

    var allocMB = alloc.mpxPerSec * TOTAL_BPP;
    var reuseMB = reuse.mpxPerSec * TOTAL_BPP;

    console.log('\n  lutMode: \'' + effectiveMode + '\'' +
        (effectiveMode !== modeName ? ' (requested \'' + modeName + '\')' : ''));
    console.log('    alloc-each-call   : ' + fmt(alloc.msPerIter) + ' ms   (' + fmt(alloc.mpxPerSec) + ' MPx/s, ' + fmt(allocMB) + ' MB/s)');
    console.log('    reuse-output-buf  : ' + fmt(reuse.msPerIter) + ' ms   (' + fmt(reuse.mpxPerSec) + ' MPx/s, ' + fmt(reuseMB) + ' MB/s)');
    console.log('    speedup(reuse/alloc): ' + speedup.toFixed(3) + 'x   delta: ' +
        (deltaPct >= 0 ? '+' : '') + deltaPct.toFixed(2) + '%');
    if(checksumAlloc !== checksumReuse){
        console.log('    *** CHECKSUM MISMATCH ***');
    }
    return { mode: effectiveMode, allocMpx: alloc.mpxPerSec, reuseMpx: reuse.mpxPerSec, allocMB: allocMB, reuseMB: reuseMB, speedup: speedup, delta: deltaPct };
}

function main(){
    console.log('================================================================');
    console.log(' Output-buffer reuse bench: *srgb -> *adobe1998  (RGB->RGB)');
    console.log('================================================================');
    console.log(' pixels/iter : ' + PIXEL_COUNT);
    console.log(' warmup      : ' + WARMUP_ITERS);
    console.log(' batches     : ' + TIMED_BATCHES + ' x ' + BATCH_ITERS + ' iters');
    console.log(' node        : ' + process.version);
    console.log(' platform    : ' + process.platform + ' ' + process.arch);

    var modes = ['int', 'int-wasm-scalar', 'int-wasm-simd'];
    var results = [];
    for(var i = 0; i < modes.length; i++){
        results.push(runMode(modes[i]));
    }

    console.log('\n================================================================');
    console.log(' SUMMARY  (RGB→RGB 3ch+3ch = 6 bytes/px, MB/s = total input+output)');
    console.log('================================================================');
    console.log('  mode                   alloc MPx/s  reuse MPx/s  speedup   alloc MB/s  reuse MB/s');
    console.log('  ---------------------  -----------  -----------  -------   ----------  ----------');
    for(var i = 0; i < results.length; i++){
        var r = results[i];
        console.log('  ' + r.mode.padEnd(23) +
            '  ' + r.allocMpx.toFixed(1).padStart(9) +
            '  ' + r.reuseMpx.toFixed(1).padStart(11) +
            '  ' + r.speedup.toFixed(3) + 'x' +
            '   ' + r.allocMB.toFixed(1).padStart(9) +
            '  ' + r.reuseMB.toFixed(1).padStart(9));
    }
    console.log('');
}

main();
