'use strict';

const {Transform, eIntent} = require('../src/main');

/**
 * bench/wasm_shrink_ratio_bench.js
 *
 * Measures the cost of wasmShrinkRatio auto-compact when alternating
 * between a large and small image. Simulates a real workflow where a
 * one-off large image inflates WASM memory and subsequent small images
 * trigger (or don't trigger) a compact.
 *
 * Two configs:
 *   A. shrinkRatio = 0       (disabled — memory stays bloated)
 *   B. shrinkRatio = 2       (auto-compact when memory > 2× needed)
 *
 * The loop alternates: big → small → big → small → ...
 * This is the worst case for auto-compact (every other call triggers it).
 *
 * Run:  node bench/wasm_shrink_ratio_bench.js
 */

var WARMUP_ITERS = 20;
var TIMED_BATCHES = 8;
var BATCH_ITERS  = 20;

function buildRgbInput(pixelCount) {
    var arr = new Uint8ClampedArray(pixelCount * 3);
    var seed = 0x12345678;
    for (var i = 0; i < arr.length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        arr[i] = seed & 0xff;
    }
    return arr;
}

function median(values) {
    var copy = values.slice().sort(function (a, b) { return a - b; });
    return copy[(copy.length / 2) | 0];
}

function fmt(n) { return n.toFixed(3); }
function fmtKB(n) { return (n / 1024).toFixed(0); }

function runConfig(modeName) {
    var scenarios = [
        { name: '64K ↔ 16K',   big: 64 * 1024,    small: 16 * 1024 },
        { name: '1M  ↔ 16K',   big: 1024 * 1024,   small: 16 * 1024 },
        { name: '4M  ↔ 16K',   big: 4096 * 1024,   small: 16 * 1024 },
    ];

    console.log('\n=== lutMode: ' + modeName + ' ===');

    scenarios.forEach(function (sc) {
        console.log('\n  --- ' + sc.name + ' px alternation ---');
        console.log('  ' + BATCH_ITERS + ' pairs/batch × ' + TIMED_BATCHES + ' batches\n');

        var bigInput   = buildRgbInput(sc.big);
        var smallInput = buildRgbInput(sc.small);
        var totalPixels = sc.big + sc.small;

        var results = [];

        [0, 2].forEach(function (ratio) {
            var label = ratio === 0 ? 'ratio=0 (disabled)' : 'ratio=' + ratio;

            var transform = new Transform({
                dataFormat: 'int8',
                buildLut: true,
                lutMode: modeName,
                wasmShrinkRatio: ratio
            });
            transform.create('*srgb', '*adobe1998', eIntent.relative);

            var fn = function () {
                transform.transformArrayViaLUT(bigInput, false, false, false);
                transform.transformArrayViaLUT(smallInput, false, false, false);
            };

            for (var w = 0; w < WARMUP_ITERS; w++) fn();

            var samples = [];
            for (var b = 0; b < TIMED_BATCHES; b++) {
                var t0 = process.hrtime.bigint();
                for (var i = 0; i < BATCH_ITERS; i++) fn();
                var t1 = process.hrtime.bigint();
                samples.push(Number(t1 - t0) / 1e6 / BATCH_ITERS);
            }

            var med = median(samples);
            var memAfter = transform.wasmMemoryBytes();

            results.push({
                label: label,
                msPerPair: med,
                mpxPerSec: (totalPixels / 1e6) / (med / 1000),
                memKB: memAfter
            });

            console.log('    ' + label);
            console.log('      ms/pair: ' + fmt(med) + '    MPx/s: ' + fmt((totalPixels / 1e6) / (med / 1000)) + '    mem: ' + fmtKB(memAfter) + ' KB');
        });

        if (results.length === 2) {
            var base = results[0].msPerPair;
            var test = results[1].msPerPair;
            var overhead = ((test - base) / base * 100);
            console.log('    → overhead: ' + (overhead > 0 ? '+' : '') + fmt(overhead) + '%'
                + '    memory saved: ' + fmtKB(results[0].memKB - results[1].memKB) + ' KB');
        }
    });
}

console.log('WASM shrinkRatio benchmark');
console.log('=========================================');

['int-wasm-scalar', 'int-wasm-simd'].forEach(runConfig);

console.log('\n=========================================');
console.log('Done.');
