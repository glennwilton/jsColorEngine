// The ugly path deliberately lives in its own module.
// It owns setup, warmup, timing, and the hot loop so V8 sees one isolated call site.

function yieldRAF() {
    if (typeof requestAnimationFrame === 'function') {
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    return new Promise((resolve) => setTimeout(resolve, 16));
}

function median5(samples) {
    const sorted = samples.slice().sort((a, b) => a - b);
    return sorted[2];
}

export async function runUglyBenchmark(jsce, input, output, config) {
    var pc = config.pixelCount;
    var xf = new jsce.Transform({
        buildLut: true,
        dataFormat: 'int8',
        lutMode: 'int-wasm-simd',
    });

    var setupStart = performance.now();
    xf.create('*srgb', '*adobergb', jsce.eIntent.relative);
    var setupMs = performance.now() - setupStart;

    var w;
    var i;
    for (w = 0; w < config.warmupRuns; w = w + config.warmupChunk) {
        for (i = 0; i < config.warmupChunk; i = i + 1) {
            xf.transformArray(input, false, false, false, 65536, undefined, output);
        }
        await yieldRAF();
    }
    await yieldRAF();

    var samples = [];
    var b;
    for (b = 0; b < config.timedBatches; b = b + 1) {
        var t0 = performance.now();
        for (i = 0; i < config.timedRuns; i = i + 1) {
            xf.transformArray(input, false, false, false, 65536, undefined, output);
        }
        samples.push((performance.now() - t0) / config.timedRuns);
        await yieldRAF();
    }

    var medianMs = median5(samples);
    return {
        id: 'ugly',
        setupMs,
        samples,
        medianMs,
        MPxPerSec: pc / medianMs / 1000,
        MBps: pc / medianMs / 1000 * 6,
    };
}
