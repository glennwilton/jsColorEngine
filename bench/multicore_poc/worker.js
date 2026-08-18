/**
 * bench/multicore_poc/worker.js
 * =============================
 *
 * One conversion worker for the Model A (transfer) multicore experiment.
 *
 * Receives the baked LUT once as portable JSON — no profiles, no LUT rebuild,
 * no ICC parsing in the worker. `Transform.fromJSON()` reconstitutes a ready
 * Transform straight from it, which is the whole reason the portable-LUT work
 * pays off here.
 *
 * Then, per slice: take ownership of a transferred ArrayBuffer, convert it,
 * and transfer the result back. Nothing is shared, so there is no
 * SharedArrayBuffer, no cross-origin isolation requirement, and no locking.
 */
'use strict';

const { parentPort, workerData } = require('worker_threads');
const { Transform } = require('../../src/main');

// Rebuild from the LUT alone. Costs one parse + one CLUT decode, once per
// worker for the life of the pool.
const transform = Transform.fromJSON(workerData.lutJson, {
    dataFormat: 'int8',
    lutMode: workerData.lutMode,
});

// Warm the kernel so the first timed slice isn't paying for tier-up. Uses a
// throwaway buffer of the same shape as a real slice.
if (workerData.warmupPixels > 0) {
    const warm = new Uint8ClampedArray(workerData.warmupPixels * workerData.inChannels);
    transform.transformArray(warm, false, false, false, workerData.warmupPixels);
}

parentPort.postMessage({ type: 'ready' });

parentPort.on('message', (msg) => {
    if (msg.type === 'exit') {
        process.exit(0);
    }

    // msg.buffer arrived by transfer — this worker now owns it outright.
    const input = new Uint8ClampedArray(msg.buffer);
    const pixelCount = msg.pixelCount;

    // Time the KERNEL ONLY, not the round trip. An adaptive dispatcher that
    // feeds wall-time-per-task back into its own slice sizing builds a
    // feedback loop: smaller slices measure slower (overhead is a bigger
    // share), which raises the floor, which enlarges slices, which measure
    // faster... Reporting pure compute time breaks that loop, because it is
    // a property of the kernel and the content, not of how the work was cut.
    const computeStart = process.hrtime.bigint();
    const out = transform.transformArray(input, false, false, false, pixelCount);
    let computeMs = Number(process.hrtime.bigint() - computeStart) / 1e6;

    // Simulate a slower core (Intel E-core, ARM LITTLE) on homogeneous test
    // hardware: busy-wait so this worker takes `slowFactor` times as long.
    // Busy-wait rather than sleep because a real weak core is *executing*, not
    // idle -- a sleep would let the OS schedule someone else onto it.
    if (workerData.slowFactor > 1) {
        const target = computeMs * (workerData.slowFactor - 1);
        const until = process.hrtime.bigint() + BigInt(Math.round(target * 1e6));
        while (process.hrtime.bigint() < until) { /* spin */ }
        computeMs *= workerData.slowFactor;
    }

    // transformArray may hand back a Uint8ClampedArray whose buffer is exactly
    // the right size; if not, copy into one so the transfer is clean.
    let outBuffer;
    if (out.byteOffset === 0 && out.byteLength === out.buffer.byteLength) {
        outBuffer = out.buffer;
    } else {
        const exact = new Uint8ClampedArray(out.length);
        exact.set(out);
        outBuffer = exact.buffer;
    }

    parentPort.postMessage(
        { type: 'done', index: msg.index, buffer: outBuffer, pixelCount: pixelCount, computeMs: computeMs },
        [outBuffer]
    );
});
