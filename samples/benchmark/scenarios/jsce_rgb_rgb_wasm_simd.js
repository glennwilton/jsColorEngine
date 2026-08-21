// scenarios/jsce_rgb_rgb_wasm_simd.js
//
// Self-contained scenario: jsColorEngine RGB→RGB int-wasm-simd at 65,536 px.
//
// Why a scenario file is structurally different from a registered benchmark:
//   - Setup, warmup, hot loop, and timing ALL live inside one function
//   - No bench-engine dispatcher above the hot loop
//   - The call site `xform.transformArray(...)` sits directly inside this
//     function's body — V8 sees it as one monomorphic call site for the
//     lifetime of this function, not shared with any other scenario
//   - Closing the megamorphic-call-site gap that the registered-benchmark
//     framework cannot avoid by construction
//
// This is the "production code shape" — what a real app actually looks like.
// One transform path, compiled once, hot loop visible to V8 at compile time.
//
// Compare the throughput from this scenario against `jsce-rgb-rgb-wasm-simd`
// in the registered framework. The delta IS the framework overhead.

function yieldRAF() {
    if (typeof requestAnimationFrame === 'function') {
        return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    return new Promise((r) => setTimeout(r, 50));
}

export async function measure_jsce_rgb_rgb_wasm_simd(jsce, pixelCount) {
    pixelCount = pixelCount ?? 65536;

    // Build the Transform — same options as the registered framework variant
    // (buildLut + int-wasm-simd + int8). Uses jsce built-in virtual profiles
    // ('*srgb' → '*adobergb'), exactly matching samples/bench/main.js.
    const xform = new jsce.Transform({
        buildLut:   true,
        dataFormat: 'int8',
        lutMode:    'int-wasm-simd',
    });
    const setupT0 = performance.now();
    xform.create('*srgb', '*adobergb', jsce.eIntent.relative);
    const setupMs = performance.now() - setupT0;

    // Deterministic input — same LCG as samples/bench/main.js buildInput()
    const input = new Uint8ClampedArray(pixelCount * 3);
    let seed = 0x13579bdf;
    for (let i = 0; i < input.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        input[i] = seed & 0xff;
    }
    // Pre-wrap output once — same as the framework's "reuse" mode.
    const output = new Uint8ClampedArray(pixelCount * 3);

    // ---- cold start ----
    const coldT0 = performance.now();
    xform.transformArray(input, false, false, false, pixelCount, undefined, output);
    const coldMs = performance.now() - coldT0;

    // ---- warmup ----
    // 200 iters in chunks of 50, yielding rAF between chunks so V8's background
    // TurboFan compilation finishes before we start timing.
    for (let w = 0; w < 200; w += 50) {
        for (let i = 0; i < 50; i++) {
            xform.transformArray(input, false, false, false, pixelCount, undefined, output);
        }
        await yieldRAF();
    }
    await yieldRAF();    // final drain

    // ---- hot (5 batches of 50, median reported) ----
    const samples = [];
    for (let b = 0; b < 5; b++) {
        const t0 = performance.now();
        for (let i = 0; i < 50; i++) {
            xform.transformArray(input, false, false, false, pixelCount, undefined, output);
        }
        samples.push((performance.now() - t0) / 50);
        await yieldRAF();
    }

    samples.sort((a, b) => a - b);
    const medianMs = samples[2];
    const MPxPerSec = pixelCount / medianMs / 1000;
    const MBps      = MPxPerSec * 6;   // RGB→RGB = 3 in + 3 out bytes per pixel

    return {
        name: 'jsce RGB → AdobeRGB (wasm-simd) [self-contained scenario]',
        pixelCount, setupMs, coldMs, samples,
        medianMs, MPxPerSec, MBps,
    };
}
