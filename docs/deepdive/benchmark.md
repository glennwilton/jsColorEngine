# Benchmark Deep Dive

**Status:** Draft v0.1
**Date:** 2026-05-11
**Purpose:** Design and specification for a universal, trustworthy benchmark framework

---

## 1. The Problem

The performance numbers have **inconsistent** , leading me down
rabbit holes trying to find regressions in the code, different test harnesses were 
producing different numbers for the same code. 

My original kernel code was running at over 200MPx/s, but then the benchmark is running at 175MPx/s, 
then the new benchmark is running at 104MPx/s. Which one is right? Is the engine getting slower,
or are we just measuring it differently? I started to lose sleep worrying about regressions, and that
im making bold claims about performance but then can't trust the numbers when I run the bench.

**Without a stable framework we can't tell whether a new implementation is actually
faster, or whether the benchmark itself is lying.**

This document specifies a dedicated, stable benchmark framework that addresses
the issues we've hit: function call overhead, JIT warmup, thermal throttling,
inconsistent input data, cache pollution between runs, and no portable way to
compare results across hardware.

**Spoiler:** the most important factor in that list, by a wide margin,
turned out to be one we didn't anticipate when writing this section —
the SHAPE of the calling code itself!!!

---
## 🔎 TLDR:  Mystery solved (2026-05-11)

> **TL;DR:** the engine is genuinely fast (200+ MPx/s on RGB→RGB
> int-wasm-simd), the README's "Over 210 MPx/s" claim is correct, and
> a weeks of "why did my numbers drop?" worry turned out to be a
> bench-methodology artifact, not a regression.

Direct kernel measurement on the bench page (no framework wrapper):

| Test pattern                                         | MPx/s    |
|------------------------------------------------------|----------|
| Self-contained scenario file (own module)            | **~203** |
| Direct inline test (in bundle, no framework)         | ~175     |
| Registered framework benchmark (`wasm-simd`)         | ~104     |
| Same kernel, same engine, same machine, all measured |          |

The variation is **not** caused by the kernel running at different
speeds or code regression. The kernel is identical in all three. 
The variation comes from how V8 sees the call site that wraps the kernel:

- **One function, one module, one call site → V8 inlines everything** →
  full 200+ MPx/s
- **Same function, but inside a bigger bundle with neighbours** → V8 is
  more conservative → 175 MPx/s
- **Framework that dispatches N transform functions through a shared
  call site → V8 demotes to megamorphic → 104 MPx/s**

This phenomenon — that the act of comparing two implementations
side-by-side makes both of them slower than either alone — is named
**[Schrödinger's Bench](#19-schrödingers-bench)** in this document, because I thought
that was a funny name for the counterintuitive principle we uncovered.

The full investigation is in [§16](#16-the-17-mystery--lessons-in-bench-methodology),
the V8 inlining model is in [§17](#17-how-v8-actually-optimises-bench-loops-the-inlining-model),
patterns and anti-patterns for app developers are in [§18](#18-patterns-and-anti-patterns-for-app-developers),
the named principle and escape routes (including `compile()` /
`new Function(src)`) are in [§19](#19-schrödingers-bench),
and [§20](#20-schrödingers-bench-bites-back--the-failed-reproduction)
documents our failed attempt to reproduce the split in a standalone
demo page — and what that failure means for production code.

Pick-up notes for the next session live in
[`benchmark_todo.md`](./benchmark_todo.md). Tomorrow's data will add a
fair head-to-head with lcms-wasm through the same framework, scenario
files for all 4 directions, and a prototype `new Function`-generated
runner variant for the framework itself.


Follow my journey below.....

---


## 2. Design Goals - create a benchmark framework that we can trust

1. **Portable baselines** — express performance as `% of theoretical max` so a result on a high-end desktop is comparable to a result on a mid-range laptop.
2. **Isolation** — fresh data each run, optional GC between tests, deterministic input.
3. **Complete metrics** — cold, warmup curve, hot (min/median/max/stdDev), validation checksum.
4. **Thermal awareness** — preheat, baseline, periodic checks, final re-test. Warn if degradation > 10%.
5. **Single codebase** — same engine in Node and browser.
6. **Simple, auditable code** — no clever tricks. Each module readable on its own.

---

## 3. Factors to Isolate

| Factor                   | Problem                                              | Mitigation                                                            |
|--------------------------|------------------------------------------------------|-----------------------------------------------------------------------|
| Thermal throttling       | CPU slows 10–20% after sustained load                | Preheat + periodic checks + final re-test                             |
| Function overhead        | `fn()` wrapper costs ~5–10% on <1ms ops              | Measure noop, batch where needed                                      |
| **Timer quantization**   | `performance.now()` resolution is 0.1ms in browsers  | Batch N iterations, time as one block, divide by N                    |
| JIT compilation          | First runs slower until optimized                    | Track cold separately, run 200 warmup iterations                      |
| **Async tier-up drain**  | V8 TurboFan compiles in background — Sparkplug until it finishes | Yield event loop (rAF) between warmup chunks so compile drains |
| **Megamorphic call site**| Same call site dispatched to N different functions → V8 can't inline | Each scenario its own function/closure (see §16)               |
| Memory bandwidth         | Can't tell if slow code or slow RAM                  | Compare against `WASM memory.copy` baseline                           |
| Cache effects            | Previous test warms/pollutes cache                   | Fresh allocations, optional GC + sleep between tests                  |
| Input variance           | Different random data per run                        | Seeded RNG (deterministic)                                            |
| Output pre-alloc         | Reusing buffers hides allocation costs               | Two modes: reuse (steady-state throughput) + alloc (real-world)       |

---

## 4. Baselines & Peak Performance

Before running any real benchmark, establish what the machine can actually do.

### 4.1 Overhead Baselines
- `overhead-noop` — empty function. Measures minimum observable time.
- `overhead-function-wrap` — `() => fn()` cost.

### 4.2 Memory Baselines (3 bytes/pixel RGB)
- `mem-js-set` — `TypedArray.set()`. JS peak.
- `mem-js-loop` — for-loop byte copy. Typical JS iteration cost.
- `mem-js-uint32` — `Uint32Array` bulk copy (4 bytes/iter).
- `mem-wasm-bulk` — WASM `memory.copy` instruction. **Theoretical max.**
- `mem-wasm-simd` — WASM `v128.load`/`v128.store` (16 bytes/iter).
- `mem-wasm-scalar` — WASM byte-by-byte loop.

### 4.3 CPU Baselines (compute-bound, minimal memory)
- `cpu-primes-js` — Sieve of Eratosthenes (1M primes).
- `cpu-primes-wasm` — same algorithm in WASM.
- `cpu-matmul-js` — 256×256 matrix multiply (FP).

### 4.4 Performance Categories

Results are categorized by **% of `mem-wasm-bulk` peak** at each size. The
category names reflect what the test is bottlenecked on (i.e. what we are
actually benchmarking when we run that workload):

| % of peak | Category                          | What it means                                  |
|-----------|-----------------------------------|------------------------------------------------|
| > 50%     | **Memory Bench**                  | Limited by RAM speed, not algorithm            |
| 20–50%    | **Balanced Memory + CPU Bench**   | Mix of memory and compute                      |
| 5–20%     | **CPU Bench**                     | Algorithm doing real work, memory not the wall |
| < 5%      | **Needs Optimization**            | Something is wrong                             |

### 4.5 Size Scaling

Every benchmark runs at multiple sizes to show **how an algorithm scales**:

| Size      | Approx. bytes (RGB) | Cache level (typical) | What it shows                  |
|-----------|---------------------|-----------------------|--------------------------------|
| 32 K px   | 96 KB               | Fits in L1/L2         | Algorithm speed, cache-resident |
| 64 K px   | 192 KB              | L2                    | Standard reference size         |
| 1 M px    | 3 MB                | L3 → main memory      | Real-world throughput           |
| 10 M px   | 30 MB               | Main memory           | Sustained streaming             |

A transform that's `CPU Bench` at 32 K but `Memory Bench` at 10 M is being
fed faster than memory can keep up at the larger size — that's a useful
insight, not a bug.

---

## 5. CPU Preheat vs Cold Start

Two run modes, selectable per benchmark session.

### Cold Start

```
skipWarmup: true
warmupRuns: 0
timedRuns:  1
```

Measures real-world first-transform cost (module load, WASM compile, first
JIT pass, cold cache). Useful for startup performance.

### Preheated (default)

```
skipWarmup: false      // 5s CPU warmup using prime sieve
warmupRuns: 200        // JIT optimization
timedRuns:  50         // Statistical sample
```

Measures sustained performance after JIT and CPU thermal stabilization.

---

## 6. Test Execution Order

**Phase 0: Initialization**
- Load shared resources (profiles, test data)
- Compile WASM modules

**Phase 1: Hardware Baselines**
- Overhead tests
- Memory tests
- CPU tests
- → produces hardware profile

**Phase 2: CPU Preheat (optional)**
- 5s prime sieve loop
- Measure thermal baseline

**Phase 3: Reference Implementations**
- lcms-wasm variants

**Phase 4: Experimental Implementations**
- jsce variants
- v5 experimental
- Thermal check every 30s

**Phase 5: Thermal Validation**
- Re-run `cpu-primes-js` + `mem-wasm-bulk`
- Compare to Phase 1
- Warn if > 10% degradation

---

## 7. Shared Resources

All benchmarks read from a single resource pool to guarantee identical input
data and identical profiles across implementations.

### Data Structure

```js
{
    label: 'RGB input (65536 pixels)',
    bin:   Uint8Array      // raw bytes, engines read this directly
}
```

Four standard buffers per pixel-count:
- `rgbIn`   — 3 bytes/pixel input
- `rgbOut`  — 3 bytes/pixel output (fresh per run)
- `cmykIn`  — 4 bytes/pixel input
- `cmykOut` — 4 bytes/pixel output (fresh per run)

Both jsce and lcms can read a `Uint8Array` (`.bin`) directly.

### Profiles

ICC profiles are loaded **once** into the pool and shared. Built-in profiles
(`*sRGB`, `*AdobeRGB`) are marked as built-in; external `.icc` files are
loaded as `Uint8Array`.

See `shared-resources.js`.

---

## 8. Data Isolation

- **Input data** is shared (same `Uint8Array` for all engines testing the same direction).
- **Output buffers** are freshly allocated for each cold/warmup/timed run. Never reused.
- **Optional GC** between benchmarks (Node only, requires `--expose-gc`).
- **10ms sleep** between benchmarks to let caches settle.

---

## 9. What We Measure

Per benchmark run:

1. **LUT creation speed** — one-shot. Time of `setup()`.
2. **Cold start** — one untimed warmup, then one timed run. No JIT, cold cache.
3. **Warmup curve** — 200 runs, sampled every 10. Shows JIT progression.
4. **Hot runs** — 50 timed runs after warmup. Report min/median/max/stdDev.
5. **Validation checksum** — sampled output bytes. Verify correctness alongside speed.

---

## 10. Benchmark Groups

Benchmarks are organized into **groups**. Each group has its own optional
async `loader()` for fetching engines/profiles. Groups declare dependencies.

Default groups:
- `baseline`           — overhead, memory, CPU baselines. **Required.**
- `lcms`               — LCMS WASM reference implementations.
- `jsce`               — jsColorEngine variants.
- `v5-experimental`    — V5 matrix-shaper POC.

Baseline runs **first** (establish hardware capability) and **last** (thermal validation).

See `benchmark-groups.js` and `groups/*.js`.

---

## 11. Console UI

A console-based progress reporter for both Node CLI and browser DevTools.
The existing browser HTML UI will be updated separately to consume the same
engine events.

See `console-ui.js`.

---

## 12. File Structure

```
benchmark/
├── benchmark-deepdive.md       # this doc
├── main.js                     # entry point (Node + browser)
├── bench-engine.js             # core engine
├── shared-resources.js         # resource pool
├── benchmark-groups.js         # group system
├── group-runner.js             # orchestrator
├── console-ui.js               # console reporter
└── groups/
    ├── baseline.js             # baseline benchmarks (built-in)
    ├── lcms.js                 # LCMS reference (stub w/ TODOs)
    ├── jsce.js                 # jsColorEngine (stub w/ TODOs)
    └── v5-experimental.js      # V5 POC (stub w/ TODOs)
```

---

## 13. Example Console Output

```
=== Benchmark Suite v0.1 ===

[Phase 0] Initialization
✓ Resources loaded (3 profiles, 4 sizes)

[Phase 1] Hardware Baselines
overhead-noop             0.001 ms
mem-js-set                0.019 ms   3,500 MPx/s    Memory Bench
mem-wasm-bulk             0.013 ms   5,000 MPx/s    Memory Bench    ← peak
cpu-primes-js            12.40 ms

Hardware profile:
  JS peak:    650 MB/s
  WASM peak:  920 MB/s
  CPU score:  80,645 ops/sec

[Phase 2] CPU Preheat
Warming for 5s... done
Thermal baseline: 12.40 ms

[Phase 3] Reference (lcms)
lcms-wasm-default         0.75 ms    88 MPx/s    CPU Bench  (1.8% of peak)

[Phase 4] Experimental
🌡  Thermal check: 12.42 ms (+0.2%) ok
jsce-int-wasm-simd        0.38 ms   174 MPx/s    CPU Bench  (3.5% of peak)
v5-matrix-shaper          0.26 ms   252 MPx/s    CPU Bench  (5.0% of peak)  ★

[Phase 5] Thermal Validation
cpu-primes-js   12.68 ms  (+2.3%)  ok
mem-wasm-bulk    0.013 ms  (+0.0%)  ok

✓ No thermal throttling detected
```

---

## 14. Implementation Plan

1. `bench-engine.js` — get a single benchmark running correctly
2. `shared-resources.js` — pool with deterministic data
3. `benchmark-groups.js` + `group-runner.js` — group orchestration
4. `groups/baseline.js` — overhead, memory, CPU baselines
5. `console-ui.js` — pretty progress
6. `main.js` — wire it all up
7. Stub `groups/lcms.js`, `groups/jsce.js`, `groups/v5-experimental.js` for future work
8. Run end-to-end, validate baseline numbers look sane
9. Then port real implementations into the stub groups

---

## 15. Open Questions

- Batch size for sub-1ms operations: fixed 10× or adaptive?
- Thermal check interval: 30s fixed or based on degradation rate?
- Outlier handling: drop > 2σ from median, or keep all samples?
- Test order within a group: sequential, randomized, or grouped by type?
- Default pixel sizes: `[32K, 64K, 1M, 10M]` confirmed?

---

## 16. The 1.7× Mystery — The Journey and Lessons in Bench Methodology

This section is **the most important one in the document**. It documents a
real investigation where we built a framework that reported 104 MPx/s on the
same machine that the older bench reported 176 MPx/s on — same engine, same
profiles, same WASM kernel. We spent a day chasing the discrepancy. The root
cause was subtle, surprising, and applies to any micro-benchmark of fast inner
loops in V8. **Read this before writing or modifying any benchmark.**

> The punchline, if you only have a minute: see §19, **Schrödinger's Bench**.
> The act of comparing two implementations makes both of them slower than
> either of them is alone. Everything in this section is the investigation
> that led to naming that principle.

### 16.1 The symptom - we made the problem worse, not better

Same machine, same Chrome version, same `jsColorEngine` build, same input data,
same pixel count (65,536), same warmup count (200), same hot-iter pattern
(5 batches × 50 iters, median):

| Bench framework               | RGB→RGB int-wasm-simd | CMYK→CMYK int-wasm-simd |
|-------------------------------|-----------------------|--------------------------|
| `samples/bench/` (old, flat)  | **176 MPx/s**         | **118 MPx/s**            |
| `samples/benchmark/` (new)    | **104 MPx/s**         |  **63 MPx/s**            |
| Ratio (old / new)             | 1.69×                 | 1.87×                    |

Both benches use the same `pixelCount / hotMs / 1000` formula. Both call into
the same compiled `jsColorEngine` (`window.jsColorEngine` v1.5.0-dev). The
math is provably identical. So the gap must be in **measurement methodology**,
not arithmetic.

This was initially a bit embarrassing and a shock — we had a new 'perfect' benchmark that was supposed 
to be better, but it reported a much worse number. We had to ask ourselves: is the engine
actually slower, or is the new benchmark lying? We had to go back to the drawing board 
and figure out what was going on.


### 16.2 Theories we tried and discarded

In order of attempt, with what we ruled each out:

1. **Math error in old or new bench.** Verified both compute
   `pixelCount / hotMs / 1000`. Verified `pixelCount` plumbing in both
   (input.length is 65,536 × 3 = 196,608 bytes; inferred or passed-in
   pixelCount resolves to 65,536). **No bug.**

2. **MB/s double-counting.** Old bench `totalBpp = (inCh + outCh)`, new bench
   `(inputChannels + outputChannels)`. Both count input + output. **No
   double-count.**

3. **Different output buffer types (`Uint8ClampedArray` vs `Uint8Array`).**
   `transformArrayViaLUT` requires `Uint8ClampedArray` output regardless;
   when the input is read by the WASM kernel it copies bytes via
   `memU8.set(input.subarray(...))` — same memcpy regardless of source
   TypedArray flavour. **No effect.**

4. **Old bench discards output → V8 dead-store eliminates the output copy.**
   Tested via a `wasm-simd-oldstyle` variant that mimics the old bench
   exactly (`xform.transformArray(input)` with one arg, output discarded).
   In Node this was the SLOWEST of three variants (76.8 MPx/s vs 91.9 for
   the pre-output-arg path). V8 isn't eliding anything. **No effect.**

5. **Warmup count too low.** Tested with `warmupRuns: 200` matching old
   bench. New bench still ~104 MPx/s. **No effect.**

6. **Anti-dead-call sink overhead** (`sink += output[0]` inside the timed
   loop). Removed it. No measurable change in Node. **Marginal at best.**

7. **`this.config.X` property accesses in the hot loop.** Hoisted
   `timedRuns` and `timedBatches` to local variables. **No measurable
   change.**

8. **Async tier-up drain — V8 finishes TurboFan compilation in the
   background.** Added `await yieldToCompilation()` (double-rAF in browser,
   setTimeout in Node) between warmup chunks AND between hot batches.
   Matches old bench's `await yieldUi()` pattern exactly. Helped slightly
   but didn't close the gap. **Partial effect.**

9. **The call site is megamorphic.** This was the answer — see next section.

### 16.3 The direct kernel reference - the smoking gun

When every test failed to show improvment or a reason for the gap, we 
decided to strip everything away and measure the kernel in isolation. 
No bench framework, no wrapper functions, no class methods — just a tight loop on the page:

```js
const xform = new jsColorEngine.Transform({
    buildLut: true, dataFormat: 'int8', lutMode: 'int-wasm-simd'
});
xform.create('*srgb', '*adobergb', eIntent.relative);
const input = new Uint8ClampedArray(65536 * 3);
// fill with deterministic noise...

// Warmup with rAF yields so V8 finishes background compilation
for (let w = 0; w < 200; w += 50) {
    for (let i = 0; i < 50; i++) xform.transformArray(input);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); // Let V8 do background compilation
}

// Time 5 batches of 50, median
const samples = [];
for (let b = 0; b < 5; b++) {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) xform.transformArray(input);
    samples.push((performance.now() - t0) / 50);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}
```

Result on Chrome: **0.376 ms/iter → 174 MPx/s**, samples (0.377, 0.374, 0.376,
0.369, 0.380 ms) — extraordinarily tight, σ < 1%.

**This matches the old bench within 1%.** The kernel really does run at 174
MPx/s. The old bench's numbers are real. The new bench's framework was
**adding 0.33 ms of overhead per call**.

The takeaway: **always have a direct-kernel reference test on the bench page**.
Without it we'd never have known whether the gap was the framework or
something deeper in the engine. This test is now built into `bench.html` as
the "Direct kernel reference" panel — click the button, no DevTools needed.

### 16.4 The root cause: megamorphic call site

The new bench had this structure:

```js
// bench-engine.js — one method, called for every benchmark
async benchSingle(benchmark, pixelCount, ioType) {
    const { setup, transform } = benchmark;     // ← different function per benchmark
    const context = await setup(input, sharedOutput);
    // ...
    for (let i = 0; i < timedRuns; i++) {
        transform(context, input, sharedOutput);  // ← THE PROBLEM IS HERE
    }
}
```

That `transform(context, input, sharedOutput)` call site sits in the same
compiled bytecode location for every benchmark. We have **24 benchmarks**
(4 directions × 3 variants × 2 alloc-modes), each with its own `transform`
function (a closure created in `makeBenchmark`). V8 sees the call site
dispatched to 24 different function references over the course of the run.

After enough distinct callees, **V8 marks the call site as megamorphic and
gives up on monomorphic inlining**. It emits a generic call sequence that:
- Looks up the function dynamically
- Cannot inline through to `xform.transformArray(input)`
- Cannot inline through to `transformArrayViaLUT`
- Cannot inline through to the kernel dispatcher
- Therefore cannot pipeline the WASM call setup with neighboring work

The old bench had `runner.run()` — but a fresh `measureRunner(runner, ...)`
function frame is established per benchmark, so V8 sees `runner.run()`
within ONE invocation of `measureRunner` as ONE callee. Monomorphic. V8
inlines. Result: **170% faster code** for the same kernel call.

This is the lesson:

> **A single benchmark engine that dispatches to many different transform
> functions through a shared call site is fundamentally limited by V8's
> ability to inline through that call site.** If you have N distinct
> benchmark functions and one shared `for` loop calling them, after the
> first few benchmarks V8 will stop inlining and ALL your measurements
> will read 1.5×–2× slower than the real kernel speed.

### 16.5 The fix: pre-bound `run()` closures

Each benchmark's `setup()` returns a `run` closure that captures EVERYTHING
it needs lexically. The hot loop calls `context.run()` directly — no
arguments, no property accesses, no branches:

```js
// groups/jsce.js — setup returns a pre-bound closure
setup(input, output) {
    const xform = new Transform({...});
    xform.create(src, dst, intent);
    const clampedOutput = new Uint8ClampedArray(output.buffer, ...);
    // Capture xform, input, clampedOutput lexically — no per-call lookups
    const run = () => xform.transformArray(input, false, false, false,
                                            pixelCount, undefined, clampedOutput);
    return { xform, run };
}

// bench-engine.js — hot loop calls the pre-bound closure
const runFn = context.run;
for (let i = 0; i < timedRuns; i++) {
    runFn();    // ← one indirect call, monomorphic per benchmark
}
```

Per benchmark, `runFn` is bound to one closure. The call site at `runFn()`
is monomorphic within `benchSingle`'s function invocation (one closure
per benchmark = one IC entry per invocation). V8 inlines through to the
kernel.

### 16.6 Generalising: how to write bench code that won't lie

These are the rules we now follow. **Any new benchmark in `groups/*.js`
should obey them or it will under-report performance:**

1. **Setup builds a pre-bound `run` closure.** Capture every value the hot
   path needs (transform object, input buffer, output buffer, pixel count,
   any indices) via lexical capture. The hot loop must contain no property
   accesses, no destructuring, no method-name resolution.

2. **No conditionals in the hot path.** If you need branching between
   `oldstyle` and `output-arg` paths, decide it in `setup()` and produce
   TWO different `run` closures — one with the branch baked in.

3. **No type-mixing on the hot path.** The closures used as `run` should
   all have the same shape (no args, no return). The bench engine's call
   site is shared across many benchmarks, but if every `run` is a
   no-arg/no-return function, V8 sees a stable IC entry shape.

4. **Time batches, not individual iterations.** `performance.now()` has
   0.1ms quantization in browsers (Spectre mitigation). 50 iters in a
   tight inner loop, then `(t1 - t0) / 50` per iter average. Repeat 5
   times for a median.

5. **Yield between warmup chunks and between batches.** `await` a
   double-`requestAnimationFrame` so V8's background TurboFan compilation
   finishes before timing starts, and so a single GC pause can't poison
   every batch.

6. **Have a direct-kernel reference test on the page itself**, exercising
   the same kernel with no framework. If your framework's number is much
   lower than the direct test, the framework is lying.

7. **In real-world production code, this gotcha doesn't exist.** An app
   has *one* compiled transform that it runs on its image data. The call
   site is monomorphic by construction. The 174 MPx/s number we measure
   is what real apps will achieve. The 104 MPx/s number was a benchmark
   artifact — never a production reality.

### 16.7 What changed in the framework as a result

- `bench-engine.js` — hot loop now prefers `context.run()` if the benchmark
  provided one, falling back to the generic `transform(ctx, input, output)`
  wrapper only when needed (alloc mode, baseline benchmarks).
- `groups/jsce.js` — `setup()` returns a pre-bound `run` closure. The
  closure captures `xform`, `input`, `clampedOutput`, `pixelCount`
  lexically. No `ctx.X` property access in the hot path.
- `bench.html` — added a "Direct kernel reference" panel that runs the
  minimal-overhead loop. **Use this to sanity-check the framework before
  trusting framework numbers.**
- `BENCH_BUILD` constant in `browser-entry.js` — bumped on every
  framework change. Printed to console and shown in the engine info panel
  so cached browser bundles can be detected at a glance.

### 16.8 The scenario-file pattern (proven 200+ MPx/s)

After the framework refactor we built one test scenario in its own module
file — `samples/benchmark/scenarios/jsce_rgb_rgb_wasm_simd.js` — that
does its own setup, warmup, hot loop and timing as a single
self-contained `measure_jsce_rgb_rgb_wasm_simd()` function. No bench
engine wrapping the hot path, no shared dispatcher, no class method
indirection. Imported as an ES module from `browser-entry.js` and called
from a button handler.

**The numbers on the same machine / same browser / same engine:**

| Pattern                              | Hot ms/iter | MPx/s    |
|--------------------------------------|-------------|----------|
| Registered framework `wasm-simd`     | 0.640       | 104      |
| Direct inline test (in main bundle)  | 0.375       | 175      |
| **Scenario file (own module)**       | **0.323**   | **203**  |

That last row is the **true kernel speed** — within 4% of the README's
historic 210 MPx/s claim, restoring confidence in the engine's published
numbers. The 175 number from the inline direct test was itself depressed
by 15% just from living in the same compilation unit (`browser-entry.js`)
as many other functions.

Two compounding effects:

1. **Megamorphic call site:** the bench engine's `runFn()` call site sees
   many different closures across benchmarks. V8 emits generic dispatch.
   This costs ~70% of throughput.

2. **Compilation-unit interference:** even a function in the same JS file
   as many other functions can have its optimisation profile degraded by
   V8's compilation heuristics. V8 weighs trade-offs about which
   functions to TurboFan-compile, what to inline, and how to share
   compiled code. A function that lives alone in its own module file
   gets cleaner treatment. This costs an additional ~15%.

The lesson: **a benchmark framework that registers N transform functions
and dispatches them through a shared loop will under-report kernel
performance by 50–80%, no matter how careful the timing methodology is.**

### 16.9 Recommended architecture going forward

For accurate performance numbers that match real-world production:

1. **One module file per scenario.** Path:
   `samples/benchmark/scenarios/{lib}_{direction}_{variant}.js`. Exports
   one `measure_*()` function that owns setup + warmup + hot + timing.

2. **Static ES module imports** from a thin runner. The runner enumerates
   scenarios, calls each one as `await scenario.measure()`, collects
   results. No shared call site, no dispatcher in the hot path.

3. **Each scenario has its own hot loop body**, written out longhand.
   No `transform(ctx, input, output)` wrapper — the kernel call is
   directly inside the scenario's `for` loop. This is what V8 wants
   to see and what production code already does.

4. **Generate scenarios with code, ship them as files.** A small build
   step can read a config like `[directions × variants]` and emit one
   `.js` file per combination. The files are then committed and bundled
   normally. We get the V8 isolation benefit without writing 24 files
   by hand.

5. **Keep the registered-benchmark framework for baseline and reference
   benchmarks** (memory bandwidth, CPU primes, lcms). The polymorphic
   dispatch penalty is small for memory benchmarks (where the work is
   bandwidth-bound, not kernel-call-overhead-bound) and acceptable for
   reference benchmarks that don't need apples-to-apples comparison
   with the headline jsColorEngine numbers.

### 16.10 What this means for the docs

The `docs/Performance.md` headline numbers ("Over 210 MPx/s on x86_64")
were correct all along. The 175 MPx/s figures from the older browser bench
are real, but they're already 15% under the true kernel speed because of
how the old bench's `samples/bench/main.js` is laid out. To reproduce the
headline numbers, use the scenario-file pattern — that's what real apps
will achieve.

### 16.11 The strategy we adopted: hybrid framework

For the comparison view (jsce vs lcms-wasm vs future v5 etc), **every test
runs through the same registered-benchmark framework.** This means all
engines bear identical wrapper overhead, so the relative numbers between
engines are honest — no one can claim the framework cheats in jsce's
favour because lcms calls go through the same dispatch path.

For headline throughput numbers, use the scenario-file references in
`samples/benchmark/scenarios/`. These are the "what a production app will
achieve" numbers, and they are self-evidently honest because their code
is the same shape a user's app would have.

**Reading the bench page:**

- The framework's results table is for **like-for-like comparison** between
  engines and modes. All numbers are 50–80% of the true kernel speed
  because the framework's polymorphic dispatch caps everyone equally.
- The direct kernel reference + scenario reference panels are for
  **headline throughput**. These match what users will see in their own
  apps if they write tight transform loops.

---

## 17. How V8 actually optimises bench loops (the inlining model)

When V8 sees a hot function, it doesn't just compile that one function —
it tries to **fold the entire call chain into one block of optimised
machine code at each call site.** The 174 → 203 MPx/s jump we observed
isn't because V8 made `Transform.transformArray` faster — that function's
compiled code is shared across all callers. The jump comes from V8
**inlining `transformArray` directly into the bench loop's compiled
code** at one specific call site.

### 17.1 What "inlining the chain" actually means

Source-level call chain for a single `xform.transformArray(input, ...)`:

```
xform.transformArray(input, ...)
  → Transform.prototype.transformArray
    → dispatch on dataFormat + lut
      → this.transformArrayViaLUT(...)
        → kernel selection (this._lutKernelBig)
          → run_i8wsi_3(this, input, output, px, lut, ...)
            → t.wasmTetra3DSimd.bind(intLut, px, cMax, ...)
            → t.wasmTetra3DSimd.runTetra3D(input, 0, output, 0, px, ...)
              → memU8.set(input.subarray(...), inputPtr)   // JS → WASM
              → this.kernel(inputPtr, outputPtr, lutPtr, ...) // WASM
              → output.set(outView, outputPos)             // WASM → JS
```

When the call site is **monomorphic** (V8 sees one specific
`xform.transformArray` shape), TurboFan can collapse most of this chain
into directly-emitted machine code. The boundaries between functions
disappear. What was 8 function calls becomes ~3 inlined blocks plus the
WASM call.

When the call site is **polymorphic / megamorphic** (V8 sees many
different transform functions over the bench's lifetime), TurboFan can't
inline. It emits generic dispatch:

1. Look up the function reference
2. Set up an argument list on the stack
3. Push a stack frame, call the function
4. Inside, load the receiver's properties, branch on dataFormat
5. Set up another argument list, call transformArrayViaLUT
6. Inside, more property loads, more branches, call the kernel function
7. Inside, set up the WASM call
8. ... and so on

Each step costs cycles. With a 0.38 ms kernel call and ~8 nested
function calls each taking ~5–10 ns of dispatch overhead, that's 50–80 ns
per call. **Across 50 iterations at 50 ns overhead per iter, that's 2.5 μs
of pure dispatch latency** — peanuts compared to 19 ms of kernel work.

So why is the framework's number 100 vs the scenario's 200? It's not the
dispatch overhead per se. It's that **V8 cannot pipeline the WASM call's
setup with the surrounding loop work** when the call site isn't inlined.
The CPU's branch predictor and out-of-order execution have to wait for
each function call to resolve before scheduling the next iteration's work.

### 17.2 Practical implication

V8 doesn't optimise "the Transform class". V8 optimises **the call site
that calls the Transform class.** Two apps using identical Transform
code can see 2× difference in throughput purely because of how their
calling code is structured. The Transform class's TurboFan compilation
is identical in both cases; only the inlining differs.

This is why pre-warming the Transform class before timing won't help —
the Transform is already as compiled as it can be. The optimisation
that matters happens **at the bench loop's call site**, and that's
controlled by the SHAPE of the calling function.

---

## 18. Patterns and Anti-Patterns (for app developers)


> **UPDATE:** the good, the bad and the ugly conclusion - it probably doesn't matter 
> in real apps, we TRIED to make a demo showing a slowdown but failed to do so. 
> For small single case images V* can optimise your code to be fast, it might only
> be an atrifact of the bech framework that the anti-pattern is slow. 

> **Status:** Stub. Will expand with measured numbers as we encounter more
> cases. The patterns below are the ones we've already proven through this
> investigation. **All numbers are RGB→RGB at 65,536 px, Chrome 147 on
> x86_64.** 

### 18.1 ✅ DO: Tight loop, one call site, one Transform

```js
// Production-shape code — V8 inlines the whole transform into the loop.
const xform = new jsce.Transform({ buildLut: true, dataFormat: 'int8', lutMode: 'int-wasm-simd' });
xform.create(srcProfile, dstProfile, jsce.eIntent.relative);

const output = new Uint8ClampedArray(input.length);
for (let i = 0; i < input.length / chunk; i++) {
    xform.transformArray(input, false, false, false, chunkPixels, undefined, output);
}
```

**Throughput: 203 MPx/s** (4× faster than the anti-pattern below).

### 18.2 ❌ DON'T: Generic dispatcher through a config

```js
// Anti-pattern: dispatch through a "processor" abstraction.
const processors = new Map();
processors.set('rgb-rgb', { run: (input, out) => xformA.transformArray(input, ...) });
processors.set('rgb-cmyk', { run: (input, out) => xformB.transformArray(input, ...) });
// ... 20 more entries ...

// In your hot loop:
const proc = processors.get(direction);
for (let i = 0; i < N; i++) {
    proc.run(input, output);   // ← V8 can't inline through `proc.run`
}
```

**Throughput: ~100 MPx/s** (50% loss). The `proc.run` call site goes
megamorphic after seeing too many processor types and V8 falls back to
generic dispatch.

**If you need this kind of abstraction**, split the hot loops into
separate functions per direction so each call site stays monomorphic:

```js
function processRgbToRgb(input, output, n) {
    for (let i = 0; i < n; i++) xformA.transformArray(input, false, false, false, ..., output);
}
function processRgbToCmyk(input, output, n) {
    for (let i = 0; i < n; i++) xformB.transformArray(input, false, false, false, ..., output);
}
// Dispatch ONCE to choose the function, then run a monomorphic loop inside it.
```

### 18.3 ✅ DO: Reuse Transform objects across many images

```js
// Create the Transform once at app startup or when the user opens a file.
const xform = makeMyAppTransform();   // ~5–25ms one-shot cost

// Then process every page / tile / frame through that one Transform:
for (const page of document.pages) {
    xform.transformArray(page.rgbBytes, ...);
}
```

**Per-page setup cost: ~0 ms** (Transform built once, amortised).

### 18.4 ❌ DON'T: Build a fresh Transform per image

```js
function convertPage(pageRgbBytes, srcProfile, dstProfile) {
    const xform = new jsce.Transform({ ... });   // ← 5–25ms PER CALL
    xform.create(srcProfile, dstProfile, intent);
    return xform.transformArray(pageRgbBytes, ...);
}
```

**Per-page overhead: 5–25 ms** of LUT build that you'll pay on every
single page even if you're processing 1000 pages with the same profiles.
This dominates the per-page cost for any image smaller than ~5 megapixels.

### 18.5 ✅ DO: Pre-allocate output for steady-state workloads

```js
// Photoshop-like app: one image, many adjustments → pre-allocate the canvas.
const output = new Uint8ClampedArray(width * height * 3);
function applyAdjustment() {
    xform.transformArray(currentLayer.rgb, false, false, false, pixelCount, undefined, output);
    drawToCanvas(output);
}
```

**Throughput: ~203 MPx/s** (the kernel's true speed).

### 18.6 ⚖ Both fine: Fresh output per call for batch workloads

```js
// Batch image conversion app: every image gets a fresh output.
for (const file of files) {
    const input  = await loadImage(file);
    const output = xform.transformArray(input.rgbBytes);   // jsce allocates
    await writeImage(output);
}
```

**Throughput: ~180–195 MPx/s** for typical image sizes (allocation cost
amortised over the kernel work). Don't optimise this away unless you're
processing very small images or your profiler tells you allocation is hot.

### 18.7 ❌ DON'T: Use `Uint8ClampedArray` for INPUT

```js
// Anti-pattern (subtle): input array as Uint8ClampedArray
const input = new Uint8ClampedArray(N);   // ← reads through V8's clamping path
xform.transformArray(input, ...);
```

Reading from `Uint8ClampedArray` (or copying FROM one via `.set`) can take
the slow path in V8. Use `Uint8Array` for input data and `Uint8ClampedArray`
ONLY for output (which is required by `transformArrayViaLUT`).

[More patterns to come — TODO: WASM SIMD vs scalar selection, int16
workflows, identity detection, multi-stage proofing chains, ...]

---

## 19. Schrödinger's Bench - A new law of benchmarking in V8

> **Schrödinger's Bench:** the act of comparing two implementations
> makes both of them slower than either of them is alone.

This is the cursed law that fell out of §16 and §17, and it deserves its
own section because once you internalise it, the bench landscape suddenly
makes sense.

### 19.1 The principle

You cannot accurately measure two implementations side-by-side at their
real, production speed. The moment you put them in the same harness —
the same loop, the same dispatcher, the same wrapper function — V8 sees
two callees at one call site, demotes the call site from monomorphic to
polymorphic, stops inlining, and now you are measuring **neither
implementation as it would actually run in production**. You're measuring
a third thing: each kernel called through a generic dispatcher.

The cursed corollary:

- To know **A's real speed**: measure A in isolation, in its own function,
  in its own module file, with no other transform callers anywhere nearby.
- To know **B's real speed**: same, but for B.
- To know **A vs B**: you have to either (a) put them in the same
  harness and accept that both numbers are 30–50% under their real speed,
  or (b) measure them separately in isolation and accept that you
  cannot directly compare on the same axis without some manual reasoning
  about whether each was given equal isolation.

### 19.2 Why this is the observer effect for benchmarks

In quantum mechanics, the observer effect says you cannot measure a
particle without disturbing it. In V8 benchmarks, the analogue is:

> You cannot share a call site between N implementations without
> degrading the optimisation V8 applies to that call site, and therefore
> changing the throughput you measure.

A benchmark engine that registers N transform functions and dispatches
them through one shared `runFn()` call site is, by construction, making
every measurement worse than the underlying kernel can do. Even using
"pre-bound closures", "monomorphic IC", and other careful patterns —
once the same call site has been dispatched to N different functions over
the lifetime of the V8 instance, the IC is poisoned and stays that way.

You can chase this down to closer-and-closer approximations: extract the
function to a local variable before the loop, hoist common values, use
arrow functions, structure as classes vs free functions — none of it
fully recovers the in-isolation throughput. The only escape is **not
sharing the call site in the first place.**

### 19.3 Practical consequences

1. **A "fair side-by-side comparison" framework is, by physics, an
   under-statement of every kernel it measures.** Useful for relative
   comparison (X is 1.7× faster than Y *through the framework's
   overhead*), but not for headline throughput.

2. **Headline throughput claims need scenario-shape measurement.**
   "jsColorEngine does 210 MPx/s on RGB→RGB" can only be reproduced by
   writing your transform call in a place where V8 sees it as the only
   callee at that call site. The bench page now ships both:
   - a registered-framework view (for fair X-vs-Y comparison)
   - scenario reference panels (for headline throughput verification)

3. **Production apps are naturally on the fast side of the bench.** Most
   apps have one transform call in one tight loop in one place — exactly
   the shape V8 inlines fully. The slow path is mostly a bench artifact.
   The fast path is the real production reality.

4. **If you're profiling a benchmark and the numbers feel low**: check
   whether your hot loop's call site sees more than one callee. If so,
   you've Schrödinger-ed yourself. Extract the case you care about into
   its own function/module and re-measure.

### 19.4 A related observation: bench-mode tax is uneven

A subtler form of the same problem: if you bench mode A *with* a sink
operation but mode B *without*, V8 might inline B's path more
aggressively than A's because A's path has more observed side effects.
Two implementations that are equally fast on their own can show a 5–10%
gap purely from differences in the framework wrapper around them.

This is why our bench's `wasm-simd`, `wasm-scalar`, and `js` variants all
go through the **same wrapper code path** in `groups/jsce.js` — exactly
the same closure shape, same arguments, same property accesses. The only
thing that varies is the `lutMode` option passed to `Transform.create()`.
If we let them have different wrappers, the wrapper shape would
contribute to the measurement and we'd be misattributing kernel speed.

Schrödinger's Bench, but in a different costume.

### 19.5 The formal escape hatch: `new Function(src)` and `compile()`

There is one way to genuinely beat Schrödinger's Bench in production
code — not just dodge it — and that's to **generate a fresh function
object per transform via `new Function(src)`.** Each generated function
is a unique compilation unit from V8's perspective. Even if your app has
100 different transforms, each one's call site is monomorphic by
construction because the function literally didn't exist until you
created it.

This is exactly what
[`Transform.compile()`](./CompiledPipeline.md) does. Given a
pre-built pipeline (curves, matrix, CLUT, intent, all options resolved),
the compile step emits one straight-line JavaScript function whose body
is the concatenation of every stage's source with every constant baked
in as a literal. It then calls `new Function('input', src)` to materialise
that source as a callable. V8 sees:

- One function that didn't exist before this Transform was created
- A body with no method dispatch, no `this.xxx` reads, no option checks
- Constant operands everywhere (matrix cells, gamma cutoffs, grid strides)
- The hot loop right inside the function body itself

TurboFan compiles this in one pass and inlines aggressively because
there's nothing to dispatch to — every operation in the body is either a
local arithmetic op or a direct array read against a captured store
object. The compiled machine code is essentially "the WASM-equivalent
of this transform, but in V8's native instruction set."

**Measured speedups** (from the
[Compiled Pipeline POC](./CompiledPipeline.md)):

- ~1.7× over the runtime walker, **bit-exact** to f64 `Math.pow`
- ~5× with the default `useGammaLUT: true` (lcms-equivalent precision)
- ~5.4× with `hotLoop: true` (call/alloc amortised over many pixels)

For the no-LUT accuracy path this is significant. For the LUT-baked
fast paths (`int-wasm-simd` etc.) the WASM kernel is already the
dominant cost and compile() is less material — but the same technique
could be applied to *the bench loop itself*: generate a per-scenario
runner function via `new Function(src)`, hand it to the bench engine, and
the framework instantly behaves like the scenario-file pattern from §16.8
without 24 hand-written files.

**Production implications.** The `compile()` path, once it ships
broadly, means an app's transform-calling code can ignore Schrödinger's
Bench almost entirely:

```js
// User app — no thought required about V8 inlining heuristics:
const xform = profile.compile({ ... });
for (const pixel of image) xform(pixel);   // a freshly generated
                                           // function, monomorphic
                                           // by construction
```

The cost is that compile() is a per-Transform one-shot operation (a few
ms). For a long-running app processing thousands of images that's
absorbed instantly; for a benchmark harness measuring micro-batches it's
the same shape as ICC parse + create.

See [`docs/deepdive/CompiledPipeline.md`](./CompiledPipeline.md) for the
POC's measurement methodology, prior art comparison with lcms's curve
optimisation, and the v1.5 roadmap for `toModule()` (which goes one
step further: emit a standalone .js file with the function and its data
baked in, no runtime engine dependency at all).

This is the connection worth remembering:

> **`new Function(src)` is the lawful exception to Schrödinger's Bench.**
> Every generated function is its own compilation unit. V8 cannot make a
> call site polymorphic across functions that didn't exist when the call
> site was first compiled.

### 19.6 Applying `new Function` to the bench framework itself

The scenario-file pattern (§16.8/16.9 — one `.js` file per benchmark
combo) and the `new Function(src)` pattern (§19.5 — per-Transform
compiled body) are two expressions of the same underlying idea: **give
V8 a unique callee per call site**. Twenty-four hand-written scenario
files achieve it via 24 distinct module boundaries. `new Function(src)`
achieves it via 24 dynamically-generated function objects.

For the bench framework specifically, the codegen path is much easier
to maintain. At each benchmark's `register()` time, we can emit a
**per-benchmark runner function** as a string and instantiate it with
`new Function`:

```js
// Sketch — at benchmark registration time:
const runnerSrc = `
    "use strict";
    var xform = store.xform;
    var input = store.input;
    var output = store.output;
    var pixelCount = ${pixelCount};   // baked literal
    return function run() {
        xform.transformArray(input, false, false, false, pixelCount, undefined, output);
    };
`;
const run = (new Function('store', runnerSrc))(store);
```

Each `run` so produced is a **freshly-compiled function** V8 has never
seen before. The framework's hot loop calls `runFn()` at one fixed
bytecode location — and the IC there sees one specific function per
benchmark invocation, with no carry-over IC pollution from previous
benchmarks. After the benchmark, V8 collects the runner; the next
benchmark generates and compiles a fresh one. **No shared call site
state to poison.**

This is the architecturally-honest answer to "how do we get
framework-comparison fairness AND headline-throughput numbers from the
same harness." It's been added to the v1.6+ planning shortlist for the
bench framework. The current registered-benchmark framework remains
honest for relative comparison; `new Function`-generated runners are the
upgrade path when we want both relative comparison and absolute headline
numbers from the same run.

The full hierarchy of escape routes from Schrödinger's Bench:

| Approach                              | Recovers what?       | Cost                                |
|---------------------------------------|----------------------|-------------------------------------|
| Pre-bound `run` closures in `setup()` | ~10–20% of the gap   | None — pattern change only          |
| Hand-written scenario files           | All of the gap       | One `.js` file per benchmark        |
| `new Function`-generated runners      | All of the gap       | Codegen step at registration        |
| `Transform.compile()`                 | All of the gap, plus eliminates internal Transform dispatch | One-time per Transform (~1–25 ms) |
| `Transform.compile().toModule()`      | All of the gap, plus removes the engine dependency entirely | Build-time codegen + small dist |

The last two row are not bench-specific — they are production
techniques that any app can use to get the bench-page-headline numbers
in its own code, with no help from the framework.

---

## 20. Schrödinger's Bench bites back — the failed reproduction

**Status:** Field notes, 2026-05-12
**Demo:** [`samples/the-good-the-bad-and-the-ugly.html`](../../samples/the-good-the-bad-and-the-ugly.html)

After documenting Schrödinger's Bench (§19) we tried to build a small,
runnable, side-by-side demo that would show the 100 / 175 / 200 MPx/s
split in one HTML page. **We failed.** That failure is itself a useful
data point, so it gets its own section.

### 20.1 What we tried

The plan was three buttons on one page, sharing the same timing
methodology used elsewhere (200 warmup, 5 × 50 hot, median):

| Button     | Intended shape                                            | Target MPx/s |
|------------|-----------------------------------------------------------|--------------|
| The Good   | Polluted strategy IC — plugin pipeline with many callees  | ~100         |
| The Bad    | Direct wrapper around one Transform in the page module    | ~175         |
| The Ugly   | Bare hot loop in its own ES module, flags hard-wired      | ~200         |

We iterated through several Good shapes — a nice `Converter.convert(options)`
class, a registered-route framework with 24 named transform functions,
a `ColorConverter` with mixed job objects, and finally a `FilterPipeline`
with 8 deliberately diverse plugin classes whose IC at
`this.current.run(input, output)` was force-polluted (cycled through
every plugin) before timing **and re-polluted before every batch**.

### 20.2 What we observed

Each iteration came back with all three within ~5% of each other,
sometimes with Good winning:

```
g = 211.8 MPx/s
b = 201.0 MPx/s
u = 204.3 MPx/s
```

```
g = 206.7 MPx/s
b = 201.8 MPx/s
u = 202.3 MPx/s
```

The page refuses to reproduce the split. Meanwhile in the actual
framework at `samples/benchmark/bench.html`, the original split
(framework ≈100, direct ≈175, scenario ≈200) is rock solid and
reproduces every run.

### 20.3 Why the demo can't reproduce it

Three compounding reasons:

1. **The page is too small.** Compilation-unit interference (the
   175 → 200 gap from §16.8) is about V8's compile-budget heuristics
   across many neighbouring functions. The standalone page has maybe a
   dozen functions total; V8 has plenty of budget for all of them.
   Inflating the page with hundreds of distractor functions would
   reproduce the effect, but it would be theatre, not realism.

2. **Modern V8 speculatively re-monomorphizes.** Even after polluting
   the strategy IC with 8 distinct plugin classes, once the hot loop
   settles on one (`jsce-wasm-simd`) and runs it 200+ times, V8
   notices the stable callee, emits an optimistic inline path with a
   deopt guard, and recovers most of the inlining win. Re-polluting
   before every batch helps a little but doesn't stop V8 from
   re-tiering inside a batch.

3. **The framework's pattern is unusual.** The original 100 MPx/s
   collapse needs N transform functions to be observed at one shared
   bytecode location across **separate top-level invocations of
   `benchSingle()`** — not within a single tight loop. That cross-call
   accumulation is exactly what a registered-benchmark harness does
   and exactly what hand-rolled production code does not.

### 20.4 What this means

This is the inverted lesson:

> **Production code is mostly safe from Schrödinger's Bench.**
> A plugin pipeline, a strategy class, a route registry, even a polluted
> IC — V8 can rescue all of them in normal app code. The pathology is
> specific to *measurement machinery*: harnesses that compare many
> implementations through one shared dispatcher over many invocations.

The framework at `samples/benchmark/bench.html` remains the canonical
reproduction. The standalone demo at
`samples/the-good-the-bad-and-the-ugly.html` is now framed as the
failed experiment that demonstrates the inverse: in realistic code,
V8 is harder to fool than the bench-harness pathology suggests.

### 20.5 When a large app *might* still hit this

"Mostly safe" is not "always safe". A long-lived app can drift into the
pathology when **all three** of these line up at once:

1. **One shared dispatch point** — a `pipeline.run()`, `effect.apply()`,
   `strategy.execute()`, or similar method that every operation flows
   through.
2. **Genuinely diverse callees behind it** — many different `Transform`
   instances, filter classes, or plug-in functions whose `run()` bodies
   have different shapes.
3. **A tight outer loop where dispatch overhead matters** — per-pixel
   transforms, per-frame video filters, per-tile batch processing.

Plausible real-world examples:

- A photo editor with 30+ adjustment effects all going through one
  `effect.apply(layer)` call site.
- A server-side image conversion service that loads many ICC recipes
  per request and dispatches them through one generic `convert(job)`
  wrapper.
- A live video pipeline that registers per-track filter chains and
  calls them through a central engine per frame.
- A print preview / soft-proof app that switches between dozens of
  destination profiles in one session through one shared call site.

**How to spot it.** Profile the hot loop. If samples land inside the
dispatch wrapper (`apply`, `run`, `dispatch`, `convert`) rather than
inside the kernel (`transformArray`, `transformArrayViaLUT`, the WASM
boundary), the IC at the dispatcher has likely gone megamorphic. The
giveaway is a fast direct kernel test from the same page reading much
higher MPx/s than the same kernel through the wrapper.

**How to fix it.** Same techniques as the bench framework:

- Bind one `Transform` per route object, capture it lexically in a
  narrow `run` closure created at setup time.
- Have one tight loop per route, not one shared loop that dispatches
  across routes.
- For ultimate isolation, use `Transform.compile()` (see §19.5) so
  each route's hot body is a freshly-generated function V8 has never
  seen before — monomorphic by construction.

The good news is that none of these mitigations require giving up the
nice abstraction. The wrapper class can stay; only the hot path needs
to be narrow.

### 20.6 Could we still reproduce it cleanly?

Possibly, with more aggressive setup. Things we did not try:

- **Web workers / iframes.** Each gets its own V8 isolate; cross-frame
  state cannot leak. A demo page that runs each case in its own
  worker would isolate compilation-unit effects. But it changes the
  threading model, which muddies the comparison.

- **Hundreds of distractor functions per case.** Bloat the
  compilation unit until V8 starts making the trade-offs that depress
  the 175 case. Reproducible but inauthentic.

- **A real registered-benchmark mini-framework on the page.** A page
  that registers 20+ jsce variants through a shared `benchSingle`-style
  dispatcher and only reports one row. Closest to the original
  pathology, but at that point we have rebuilt
  `samples/benchmark/` in miniature — not a useful separate demo.

For now the conclusion stands: **Schrödinger's Bench is real, but it
mostly bites benchmarks, not apps.**

### 20.7 The accidental headline

There is a nice irony to land on. The whole point of the demo was to
make `jsColorEngine` look slow under abstraction — to show a clean
wrapper getting bullied by V8 into 100 MPx/s. Instead, three
deliberately different call shapes (polluted plugin pipeline, tidy
class wrapper, bare isolated module) all clear 200+ MPx/s on the same
hardware in the same browser.

That accidentally became the strongest performance claim on the page:

> **The wrapper shape barely matters at this throughput.**
> A polluted strategy IC, a registered route class, and a hard-wired
> module all land within ~5% of each other at the kernel ceiling. The
> 100 MPx/s framework number is a measurement artifact specific to
> registered-benchmark harnesses; the 200 MPx/s number is what real
> code can see.

Sometimes the failed experiment publishes the best result.

---

## 20. Two more ways the input lied (2026-08-19)

The v1.5 release comparison found that §19's lesson generalises beyond
call sites: **the harness can distort what it measures through the
input, not just through the code shape.** Two defects, both invisible in
the metrics the harnesses were printing.

### The generator that produced 256 colours

Our synthetic "random noise" took the low 8 bits of a linear
congruential generator. Those bits have period 256, so the buffer
contained **256 distinct colours** — while still reporting **0.0 %
adjacency**, because consecutive pixels genuinely differ. Adjacency was
the only content metric the harnesses tracked, so the defect was
undetectable from the output.

It matters because a 33³ CLUT has 35,937 cells and a 17⁴ CLUT has
83,521. An input carrying 256 colours touches a corner of the table and
leaves it L1-resident, so the row we had labelled "no cache hits, the
hardest case" was in fact **the easiest case for interpolation**.
Corrected to the high bits (~1 M distinct colours per megapixel, same
0.0 % adjacency), measured throughput roughly **halved for both
engines** — jsCE's SIMD tier by ~45 %, native lcms by 10–27 %.

**The lesson to carry:** adjacency describes what a memo cache can hit;
it says nothing about whether the interpolation table was exercised.
Any harness touching a CLUT should report **coverage** — distinct input
colours ÷ grid cells — next to it. Below 1× the measurement describes a
working set no real image produces.

### "Buffer size doesn't matter" was an artifact of the same bug

The old conclusion was that throughput was flat from 16 K to 10 M px.
It was — because the degenerate input carried 256 colours at *every*
size, so coverage never changed. With a proper generator the real shape
appears, and the variable is coverage rather than size:

| RGB → Lab, noise | 16 K px (0.46× cover) | 64 K (1.8×) | 1 M (28×) | 10 M (217×) |
|---|---:|---:|---:|---:|
| jsCE WASM SIMD | **172.0** | 95.2 | 96.7 | 97.8 |
| lcms native NOCACHE | 72.6 | 55.9 | 55.5 | 55.7 |

There is a cliff at coverage ≈ 1× and nothing after it: a 160× range of
buffer sizes past that point moves nothing. Both engines show the same
shape, so it is a property of CLUT interpolation, not of either
implementation. **A benchmark quoting only a small buffer is quoting the
L1 case.**

### The control that confirms the diagnosis: the matrix path never moved

The generator fix is only *the* explanation if it moved the paths that
interpolate a CLUT and left everything else alone. It did, and the proof
was already in the data: **RGB→RGB matrix-shaper is unaffected.**

lcms's matrix path is curves → 3×3 matrix → curves. Pure arithmetic, no
interpolation table, therefore no working set that can fall out of L1 —
so if the "256 distinct colours" theory is right, that row must not
budge. Native lcms, identical before/after the generator change:

| content | defective generator | corrected | Δ |
|---|---:|---:|---:|
| noise | 156.3 | 156.0 | −0.2 % |
| gradient | 163.5 | 164.5 | +0.6 % |
| blocks16 | 166.8 | 165.8 | −0.6 % |
| photo | 165.7 | 165.4 | −0.2 % |

Flat, while RGB→Lab NOCACHE fell 83.6 → 63.3 (−24 %) on exactly the same
input change. That rules out the alternative explanations — the fix was
not a general slowdown, not a thermal artifact, not something that
changed both engines' timing uniformly. **It moved CLUT interpolation
and nothing else**, which is what a working-set explanation predicts and
what a confounded one would not.

Two practical consequences:

- **Non-CLUT figures measured on the old generator remain valid.** The
  matrix-shaper WASM kernel POC (250–257 MPx/s) is fused arithmetic with
  no CLUT, so it does not need re-measuring for this reason.
- **Any future "the benchmark changed" claim can be checked the same
  way.** If a harness change moves the matrix row, it is not a
  content-locality effect and something else is going on.

### Open question — how much of the drop was which?

The corrected figures fold together *two* changes made at the same time:
the generator fix and a move to one-process-per-measurement. A minimal
control bench (`bench/solo_photo/` — one image, one engine, one process,
no `lcms-wasm` loaded) agrees with the full matrix to within a few per
cent and shows 0.4–2.0 % spread across independent processes, which says
the harness is not the culprit and the input was. That is good evidence
but not a decomposition: nobody has yet run the *old* generator through
the *new* isolated harness to attribute the change precisely. Worth
doing when this document is next revised, because the answer determines
how much of the historical record needs re-stating rather than merely
flagging.

A related loose end: an earlier ~10 % run-to-run swing was attributed to
machine noise and later traced to an 800 ms warmup being too short. With
a 3 s warmup the same measurement is stable to ~1 %. **Warmup length is
a measurement parameter, not a formality** — and an under-warmed run
looks exactly like a noisy one.
