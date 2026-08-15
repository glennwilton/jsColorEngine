/**
 * Bench: transformArrayFn bound closure vs default transformArrayViaLUT dispatch
 *
 * Creates two transforms per suite — one with bindTransformArrayFn:true (closure
 * fast path) and one with the default false (falls through to transformArrayViaLUT).
 *
 * Run: node bench/transformArrayFn_bench.js
 */

'use strict';

const { Transform, eIntent } = require('../src/main');
const Profile                = require('../src/Profile');
const path                   = require('path');
const fs                     = require('fs');

const CMYK_ICC = path.join(__dirname, '../__tests__/GRACoL2006_Coated1v2.icc');

const WARMUP_CALLS  = 500;
const MEASURE_CALLS = 3000;

const PIXEL_COUNTS = [
    { label: 'tiny   (8 px)',     count:       8 },
    { label: 'small  (256 px)',   count:     256 },
    { label: 'medium (4 k px)',   count:    4096 },
    { label: 'large  (256 k px)', count:  262144 },
];

function buildInput(pixelCount, channels) {
    const buffer = new Uint8ClampedArray(pixelCount * channels);
    let seed = 0xDEADBEEF;
    for (let index = 0; index < buffer.length; index++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buffer[index] = seed & 0xff;
    }
    return buffer;
}

function hrMs() {
    const [seconds, nanoseconds] = process.hrtime();
    return seconds * 1000 + nanoseconds / 1e6;
}

function measurePath(transformInstance, inputArray, warmupCalls, measureCalls) {
    for (let iteration = 0; iteration < warmupCalls; iteration++) {
        transformInstance.transformArray(inputArray);
    }
    const startTime = hrMs();
    for (let iteration = 0; iteration < measureCalls; iteration++) {
        transformInstance.transformArray(inputArray);
    }
    return (hrMs() - startTime) / measureCalls * 1000;
}

function runSuite(suiteName, srcProfile, dstProfile, inputChannels) {
    console.log('\n── ' + suiteName + ' ──');
    console.log('  ' + 'pixel count'.padEnd(24) + 'BOUND µs/call'.padStart(16) + 'DEFAULT µs/call'.padStart(17) + 'delta'.padStart(10));
    console.log('  ' + '─'.repeat(67));

    const boundTransform = new Transform({ dataFormat: 'int8', buildLut: true, bindTransformArrayFn: true });
    boundTransform.create(srcProfile, dstProfile, eIntent.relative);

    const defaultTransform = new Transform({ dataFormat: 'int8', buildLut: true });
    defaultTransform.create(srcProfile, dstProfile, eIntent.relative);

    for (const { label, count } of PIXEL_COUNTS) {
        const inputArray = buildInput(count, inputChannels);

        const boundUs   = measurePath(boundTransform,   inputArray, WARMUP_CALLS, MEASURE_CALLS);
        const defaultUs = measurePath(defaultTransform, inputArray, WARMUP_CALLS, MEASURE_CALLS);

        const deltaPercent = ((defaultUs - boundUs) / defaultUs * 100);
        const deltaStr = (deltaPercent >= 0 ? '+' : '') + deltaPercent.toFixed(1) + '%';

        console.log(
            '  ' + label.padEnd(24) +
            boundUs.toFixed(3).padStart(16) +
            defaultUs.toFixed(3).padStart(17) +
            deltaStr.padStart(10)
        );
    }
}

const cmykProfile = new Profile(fs.readFileSync(CMYK_ICC));

console.log('transformArrayFn bound (bindTransformArrayFn:true) vs default dispatch');
console.log('Node ' + process.version + '  |  ' + MEASURE_CALLS + ' calls  |  ' + WARMUP_CALLS + ' warmup');
console.log('(delta = (default - bound) / default — positive = bound is faster)');

runSuite('RGB → AdobeRGB  int8 (3ch, 3D LUT)', '*sRGB', '*adobeRGB', 3);
runSuite('CMYK → sRGB     int8 (4ch, 4D LUT)', cmykProfile, '*sRGB', 4);

console.log('\nDone.\n');
