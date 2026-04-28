'use strict';

const path = require('path');
const {Transform, eIntent} = require('../src/main');
const Profile = require('../src/Profile');

/**
 * bench/dispatcher_compare_bench.js
 *
 * Compares the v1.3 table-driven dispatcher (transformArrayViaLUT)
 * against the legacy cascade dispatcher (transformArrayViaLUT_legacy)
 * across three lutModes: int, int-wasm-scalar, int-wasm-simd.
 *
 * Both dispatchers are on the same Transform instance, so the kernel
 * that runs is identical — the only variable is the dispatcher
 * preamble overhead (string comparisons, guards, routing).
 *
 * Run:  node bench/dispatcher_compare_bench.js
 */

var PIXEL_COUNT     = 65536;
var WARMUP_ITERS    = 500;
var TIMED_BATCHES   = 5;
var BATCH_ITERS     = 100;

var CMYK_PROFILE_PATH = path.join(__dirname, '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

function buildInput(channels, pixelCount){
    var arr = new Uint8ClampedArray(pixelCount * channels);
    var seed = 0x13579bdf;
    for(var i = 0; i < arr.length; i++){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
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
    return { label: label, msPerIter: med, mpxPerSec: (PIXEL_COUNT / 1e6) / (med / 1000) };
}

function fmt(n){ return n.toFixed(2); }
function fmtMpx(n){ return n.toFixed(1).padStart(6); }

function mbPerSec(mpx, bytesPerPixel){
    return mpx * bytesPerPixel;
}

function fmtMB(n){ return n.toFixed(1).padStart(6); }

function runConfig(label, transform, input, inputChannels, outputChannels){
    var pixelCount = PIXEL_COUNT;
    var totalBpp = inputChannels + outputChannels;

    var checksumNew = 0;
    var newDisp = timeMode('table-driven', function(){
        var out = transform.transformArrayViaLUT(input, false, false, false, pixelCount);
        checksumNew = (checksumNew + out[0] + out[out.length - 1]) >>> 0;
    });

    var checksumLeg = 0;
    var legDisp = timeMode('legacy-cascade', function(){
        var out = transform.transformArrayViaLUT_legacy(input, false, false, false, pixelCount);
        checksumLeg = (checksumLeg + out[0] + out[out.length - 1]) >>> 0;
    });

    var ratio = legDisp.msPerIter / newDisp.msPerIter;
    var deltaPct = ((legDisp.msPerIter - newDisp.msPerIter) / legDisp.msPerIter) * 100;

    var newMB = mbPerSec(newDisp.mpxPerSec, totalBpp);
    var legMB = mbPerSec(legDisp.mpxPerSec, totalBpp);

    console.log('\n  ' + label + '  (' + inputChannels + 'ch→' + outputChannels + 'ch, ' + totalBpp + ' bytes/px)');
    console.log('    table-driven  : ' + fmt(newDisp.msPerIter) + ' ms   (' + fmtMpx(newDisp.mpxPerSec) + ' MPx/s,' + fmtMB(newMB) + ' MB/s)');
    console.log('    legacy-cascade: ' + fmt(legDisp.msPerIter) + ' ms   (' + fmtMpx(legDisp.mpxPerSec) + ' MPx/s,' + fmtMB(legMB) + ' MB/s)');
    console.log('    ratio (table/legacy): ' + ratio.toFixed(3) + 'x   delta: ' +
        (deltaPct >= 0 ? '+' : '') + deltaPct.toFixed(2) + '%');
    if(checksumNew !== checksumLeg){
        console.log('    *** CHECKSUM MISMATCH: new=' + checksumNew + ' legacy=' + checksumLeg + ' ***');
    }
    return { label: label, newMpx: newDisp.mpxPerSec, legMpx: legDisp.mpxPerSec, newMB: newMB, legMB: legMB, ratio: ratio, delta: deltaPct };
}

(async function main(){
    console.log('================================================================');
    console.log(' Dispatcher comparison: table-driven (v1.3) vs legacy cascade');
    console.log('================================================================');
    console.log(' pixels/iter  : ' + PIXEL_COUNT);
    console.log(' warmup       : ' + WARMUP_ITERS);
    console.log(' batches      : ' + TIMED_BATCHES + ' x ' + BATCH_ITERS + ' iters');
    console.log(' node         : ' + process.version);
    console.log(' platform     : ' + process.platform + ' ' + process.arch);

    var cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + CMYK_PROFILE_PATH);
    if(!cmykProfile.loaded){
        throw new Error('Failed to load CMYK profile: ' + CMYK_PROFILE_PATH);
    }

    var rgb3  = buildInput(3, PIXEL_COUNT);
    var cmyk4 = buildInput(4, PIXEL_COUNT);

    var modes = ['int', 'int-wasm-scalar', 'int-wasm-simd'];
    var directions = [
        { name: 'RGB->RGB',   src: '*srgb',     dst: '*adobergb', input: rgb3,  inCh: 3, outCh: 3 },
        { name: 'RGB->CMYK',  src: '*srgb',     dst: cmykProfile, input: rgb3,  inCh: 3, outCh: 4 },
        { name: 'CMYK->RGB',  src: cmykProfile, dst: '*srgb',     input: cmyk4, inCh: 4, outCh: 3 },
    ];

    var results = [];

    for(var m = 0; m < modes.length; m++){
        var mode = modes[m];
        console.log('\n--------------------------------------------------------------');
        console.log(' lutMode: \'' + mode + '\'');
        console.log('--------------------------------------------------------------');

        for(var d = 0; d < directions.length; d++){
            var dir = directions[d];
            var transform = new Transform({
                dataFormat: 'int8',
                buildLut: true,
                lutMode: mode
            });
            transform.create(dir.src, dir.dst, eIntent.relative);

            var effectiveMode = transform.lutMode;
            var label = dir.name + ' [' + effectiveMode + ']';
            results.push(runConfig(label, transform, dir.input, dir.inCh, dir.outCh));
        }
    }

    console.log('\n================================================================');
    console.log(' SUMMARY  (MPx/s = megapixels/sec, MB/s = total input+output bytes/sec)');
    console.log('================================================================');
    console.log('  config                              table     legacy    ratio   table MB/s  legacy MB/s');
    console.log('  ----------------------------------  ------    ------    -----   ----------  -----------');
    for(var i = 0; i < results.length; i++){
        var r = results[i];
        console.log('  ' + r.label.padEnd(34) +
            '  ' + fmtMpx(r.newMpx) + '   ' + fmtMpx(r.legMpx) +
            '    ' + r.ratio.toFixed(3) + 'x' +
            '   ' + fmtMB(r.newMB) + '     ' + fmtMB(r.legMB));
    }
    console.log('');
})();
