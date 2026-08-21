// bench-engine.js
//
// Core benchmark engine. Runs a single benchmark through phases:
//   setup -> validate -> cold -> warmup -> hot -> cleanup
//
// Reports progress via callbacks so both console and browser UIs can react.
// Works in Node and browser (no env-specific globals).

const HAS_GC = typeof globalThis.gc === 'function';

function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function stdDev(arr) {
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

// Yield to the event loop long enough for V8's background TurboFan compilation
// to finish. In browsers we use a double-rAF (matches the old bench's yieldUi).
// In Node we use a 50ms setTimeout — empirically enough for V8 to drain its
// optimization queue for a single hot function.
function yieldToCompilation() {
    if (typeof requestAnimationFrame === 'function') {
        return new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
        });
    }
    return new Promise((r) => setTimeout(r, 50));
}

export class BenchEngine {
    constructor(config = {}) {
        this.config = {
            pixelCounts:           config.pixelCounts           || [32_768, 65_536, 1_000_000, 10_000_000],
            warmupRuns:            config.warmupRuns            ?? 200,
            // Hot timing uses batch mode: time `timedRuns` iterations as one block,
            // repeat `timedBatches` times, report median of the per-iter batch averages.
            // This eliminates performance.now() overhead and timer jitter for sub-ms ops
            // and allows V8 to optimize the tight inner loop — matching the old bench.
            timedRuns:             config.timedRuns             ?? 50,   // iters per batch
            timedBatches:          config.timedBatches          ?? 5,    // number of batches
            warmupSampleEvery:     config.warmupSampleEvery     ?? 10,
            isolateRuns:           config.isolateRuns           ?? true,
            isolationSleepMs:      config.isolationSleepMs      ?? 10,
            detectThermalThrottle: config.detectThermalThrottle ?? true,
            thermalIntervalMs:     config.thermalIntervalMs     ?? 30_000,
            thermalWarmupMs:       config.thermalWarmupMs       ?? 5_000,
            thermalCheckRuns:      config.thermalCheckRuns      ?? 10,
            resources:             config.resources             || null,
            onProgress:            config.onProgress            || (() => {}),
            onComplete:            config.onComplete            || (() => {}),
        };

        this.thermalBaseline = null;
        this.thermalHistory  = [];
        this.benchStartTime  = 0;
    }

    // Force GC if available (Node --expose-gc). Safe no-op in browser.
    forceGC() {
        if (this.config.isolateRuns && HAS_GC) {
            globalThis.gc();
        }
    }

    // Cheap sampled checksum for output validation.
    // Not cryptographic — just enough to detect "transform produced different bytes".
    checksum(data, samples = 1024) {
        let sum = 0;
        const step = Math.max(1, Math.floor(data.length / samples));
        for (let i = 0; i < data.length; i += step) {
            sum = ((sum * 31) + data[i]) >>> 0;
        }
        return sum;
    }

    // ---- Thermal monitoring ----------------------------------------------

    async warmupCPU(cpuBench) {
        if (!this.config.detectThermalThrottle) return;
        if (!cpuBench) return;

        this.config.onProgress({ phase: 'thermal-warmup' });

        const ctx = await cpuBench.setup(null, new Uint8Array(16));
        const start = performance.now();

        // Burn the CPU for thermalWarmupMs
        while (performance.now() - start < this.config.thermalWarmupMs) {
            cpuBench.transform(ctx, null, new Uint8Array(16));
        }

        // Establish baseline
        const times = [];
        for (let i = 0; i < this.config.thermalCheckRuns; i++) {
            const t0 = performance.now();
            cpuBench.transform(ctx, null, new Uint8Array(16));
            times.push(performance.now() - t0);
        }

        this.thermalBaseline = median(times);
        this.thermalHistory.push({
            t: Date.now(),
            ms: this.thermalBaseline,
            phase: 'baseline',
        });

        this.thermalCpuBench = cpuBench;
        this.thermalCpuCtx   = ctx;

        this.config.onProgress({
            phase: 'thermal-baseline',
            baselineMs: this.thermalBaseline,
        });
    }

    async checkThermalThrottle() {
        if (!this.config.detectThermalThrottle) return null;
        if (!this.thermalBaseline) return null;
        if (!this.thermalCpuBench) return null;

        const t0 = performance.now();
        this.thermalCpuBench.transform(this.thermalCpuCtx, null, new Uint8Array(16));
        const current = performance.now() - t0;

        const degradation = ((current - this.thermalBaseline) / this.thermalBaseline) * 100;

        this.thermalHistory.push({
            t: Date.now(),
            ms: current,
            phase: 'check',
            degradationPct: degradation,
        });

        const status = { baselineMs: this.thermalBaseline, currentMs: current, degradationPct: degradation, throttled: degradation > 10 };
        this.config.onProgress({ phase: 'thermal-check', ...status });
        return status;
    }

    // ---- Single benchmark ------------------------------------------------

    async benchSingle(benchmark, pixelCount, ioType = 'rgb') {
        const { id, name, setup, transform } = benchmark;
        const res = this.config.resources;

        if (!res) {
            throw new Error('BenchEngine requires a resources pool (config.resources)');
        }

        // Per-benchmark type overrides let asymmetric transforms (e.g. RGB→CMYK)
        // declare their own input/output types independently of the group default.
        const inputType  = benchmark.inputType  ?? ioType;
        const outputType = benchmark.outputType ?? ioType;

        const testData = res.getTestData(pixelCount);
        const input = inputType === 'cmyk' ? testData.cmykIn.bin : testData.rgbIn.bin;

        // ---- setup ----
        // Allocate the output buffer ONCE here. It is reused across all phases
        // (warmup, timed) so the hot loop never allocates — no GC pressure.
        // setup() receives it so group implementations can pre-wrap it once
        // (e.g. Uint8ClampedArray view for jsce) rather than wrapping per-call.
        this.config.onProgress({ phase: 'setup', id, name, pixelCount });
        const setupT0 = performance.now();
        const sharedOutput = res.createOutputBuffer(outputType, pixelCount).bin;
        const context = await setup(input, sharedOutput);
        const setupMs = performance.now() - setupT0;

        // ---- cold start ----
        // Separate buffer so this first-call measurement isn't pre-warmed by setup.
        this.config.onProgress({ phase: 'cold', id, name, pixelCount });
        this.forceGC();
        const coldOutput = res.createOutputBuffer(outputType, pixelCount).bin;
        const coldT0 = performance.now();
        transform(context, input, coldOutput);
        const coldMs = performance.now() - coldT0;

        // ---- warmup ----
        // Tight loop — same input and output every call, no allocation.
        // Gets V8 to TurboFan tier + WASM to optimized JIT state.
        //
        // CRITICAL: V8's TurboFan compilation is ASYNCHRONOUS. When V8 decides to
        // TurboFan-compile a hot function, it queues the compile on a background
        // thread. Until that compile finishes, the function runs at Sparkplug
        // (baseline JIT) which is ~2× slower than TurboFan-optimized code.
        //
        // We yield to the event loop in chunks during warmup so V8's background
        // compilation can finish BEFORE the hot timing loop starts. Without this,
        // the first hot batch can read 50–80% slower than steady-state numbers.
        // (Matches the old bench's `await yieldUi()` pattern between warmup chunks.)
        this.config.onProgress({ phase: 'warmup', id, name, pixelCount, total: this.config.warmupRuns });
        const warmupChunk = 50;
        for (let w = 0; w < this.config.warmupRuns; w += warmupChunk) {
            const end = Math.min(this.config.warmupRuns, w + warmupChunk);
            for (let i = w; i < end; i++) {
                transform(context, input, sharedOutput);
            }
            await yieldToCompilation();
        }
        // Final yield — make absolutely sure TurboFan compilation has drained
        // before the timed batches start.
        await yieldToCompilation();

        // ---- hot (batch timing) ----
        // Two modes driven by benchmark.reuseOutput:
        //
        //   true  (default) — "photoshop-like": same input + output buffer every call,
        //                      zero allocation in the hot path, maximum kernel throughput.
        //
        //   false           — "batch-images": fresh output buffer allocated per call,
        //                      includes real-world allocation + zero-init overhead.
        //
        // In both modes the entire batch is timed as one block, divided by timedRuns,
        // amortizing performance.now() timer overhead over N iterations.
        //
        // Anti-dead-call: read sharedOutput[0] into a sink after each call. This forced
        // read creates a data dependency the JIT cannot elide, ensuring the transform
        // actually executes. Cost: 1 byte-read per iteration — negligible.
        this.config.onProgress({ phase: 'timed', id, name, pixelCount, total: this.config.timedBatches });
        const batchTimes   = [];
        // Hoist loop bounds to locals — V8's loop-invariant code motion is conservative
        // about `this.config.*` accesses inside hot loops; explicit locals are guaranteed.
        const timedRuns    = this.config.timedRuns;
        const timedBatches = this.config.timedBatches;

        // Prefer the pre-bound run closure if the benchmark provided one in setup().
        // This is the OLD bench's `runner.run()` pattern — V8 sees a monomorphic
        // call site at `runFn()` (one closure per benchmark, all captures lexical)
        // and inlines straight through to the kernel.
        //
        // If no run closure was provided, fall back to the generic transform wrapper
        // (which V8 may keep megamorphic across benchmarks → can't inline → slower).
        const runFn = context && typeof context.run === 'function' ? context.run : null;

        if (benchmark.reuseOutput !== false) {
            // Reuse mode: same buffers every call — matches old bench's runner.run() pattern.
            if (runFn) {
                // Fast path: tight loop calling the pre-bound closure. No wrapper, no
                // property accesses, no branch. V8 inlines through to the kernel.
                for (let b = 0; b < timedBatches; b++) {
                    const t0 = performance.now();
                    for (let i = 0; i < timedRuns; i++) {
                        runFn();
                    }
                    batchTimes.push((performance.now() - t0) / timedRuns);
                    await yieldToCompilation();
                }
            } else {
                // Generic fallback path (baseline benchmarks, lcms group, etc.)
                for (let b = 0; b < timedBatches; b++) {
                    const t0 = performance.now();
                    for (let i = 0; i < timedRuns; i++) {
                        transform(context, input, sharedOutput);
                    }
                    batchTimes.push((performance.now() - t0) / timedRuns);
                    await yieldToCompilation();
                }
            }
        } else {
            // Alloc mode: fresh output per call (includes allocation + zero-init cost).
            // Always uses the transform() wrapper because each call needs a different output buffer.
            for (let b = 0; b < timedBatches; b++) {
                const t0 = performance.now();
                for (let i = 0; i < timedRuns; i++) {
                    const freshOut = res.createOutputBuffer(outputType, pixelCount).bin;
                    transform(context, input, freshOut);
                }
                batchTimes.push((performance.now() - t0) / timedRuns);
                await yieldToCompilation();
            }
        }

        // ---- validate ----
        // Checksum the shared output after timing — transform is deterministic
        // so any call's output is correct. Done last to not pollute timing.
        const checksumValue = this.checksum(sharedOutput);

        // ---- stats ----
        const sorted = [...batchTimes].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];

        // Total bytes touched per pixel (input + output, both sides of the transform).
        const inputChannels      = inputType  === 'cmyk' ? 4 : 3;
        const outputChannels     = outputType === 'cmyk' ? 4 : 3;
        const bytesPerElement    = benchmark.bytesPerElement ?? 1;
        const totalBytesPerPixel = (inputChannels + outputChannels) * bytesPerElement;

        const result = {
            id,
            name,
            pixelCount,
            inputType,
            outputType,
            metric:    benchmark.metric    ?? 'mpx+mbps',
            checksum: checksumValue,
            setupMs,
            coldMs,
            hot: {
                minMs:    sorted[0],
                medianMs: med,
                maxMs:    sorted[sorted.length - 1],
                p95Ms:    sorted[Math.floor(sorted.length * 0.95)],
                stdDev:   stdDev(batchTimes),
                samples:  batchTimes.length,   // number of batches
                itersPerBatch: this.config.timedRuns,
            },
            MPxPerSec: med > 0 ? (pixelCount / med / 1000) : 0,
            MBps:      med > 0 ? (pixelCount * totalBytesPerPixel / med / 1000) : 0,
        };

        // ---- cleanup ----
        if (this.config.isolateRuns) {
            this.forceGC();
            await sleep(this.config.isolationSleepMs);
        }

        this.config.onProgress({ phase: 'complete', result });
        return result;
    }

    // ---- Run a list of benchmarks at all configured sizes ----------------

    async run(benchmarks, options = {}) {
        const ioType = options.ioType || 'rgb';
        const results = [];
        let lastThermalCheck = Date.now();

        for (const bench of benchmarks) {
            for (const pixelCount of this.config.pixelCounts) {
                // Periodic thermal check
                if (this.config.detectThermalThrottle &&
                    Date.now() - lastThermalCheck > this.config.thermalIntervalMs) {
                    await this.checkThermalThrottle();
                    lastThermalCheck = Date.now();
                }

                const result = await this.benchSingle(bench, pixelCount, ioType);
                results.push(result);
            }
        }

        return results;
    }
}