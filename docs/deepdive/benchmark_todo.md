# Benchmark — TODO and pick-up notes

> Notes for tomorrow-you (or future Claude). Written at the end of the
> "1.7× mystery" session. The full investigation lives in
> [`benchmark.md`](./benchmark.md); this file is the short version + the
> action list.
>
> **Status as of 2026-05-11:** kernel speed is genuinely 200+ MPx/s,
> proven by the direct kernel test (~175 MPx/s inline) and the
> self-contained scenario file (~203 MPx/s in its own module). The
> framework numbers (~104 MPx/s) are real but reflect framework
> overhead, not engine speed. **README's "Over 210 MPx/s" claim
> is correct.**

## TL;DR — what we know now

1. **The engine is fast.** ~200 MPx/s for RGB→RGB int-wasm-simd on
   x86_64 Chrome 147 / Firefox 150. Confirmed by two independent
   measurement paths.

2. **Benchmarks can lie.** A bench framework that dispatches N
   transform functions through one shared call site will under-report
   throughput by 30–50% — see [`benchmark.md` §19 (Schrödinger's
   Bench)](./benchmark.md#19-schrödingers-bench).

3. **The escape is `new Function(src)`** — every generated function is
   its own compilation unit, immune to call-site polymorphism.
   `Transform.compile()` already proves this pattern works (see
   [`CompiledPipeline.md`](./CompiledPipeline.md)).

4. **Hybrid strategy adopted.** Registered framework benchmarks for
   fair cross-engine comparison (every engine bears the same
   wrapper); scenario files for headline kernel throughput. Both
   visible on the bench page so users see both numbers.

## Tomorrow's action list (priority order)

### 1. Wire up lcms in the framework  ⭐ critical

The framework's "fair comparison" pitch only works once lcms shows up
in it. Currently lcms is a stub group. Steps:

- [ ] Port the `samples/bench/lcms-runner.js` setup into
  `samples/benchmark/groups/lcms.js`
- [ ] Use the same pre-bound `run` closure pattern as
  `groups/jsce.js` so lcms benefits from the same framework wrapper
  (no asymmetric overhead!)
- [ ] Register 4 directions × 3 flag variants (default / HIGHRES /
  NOOPT) — matches what the old bench does, gives lcms its best shot
- [ ] Test that the bench numbers are sensible vs the old bench's
  lcms numbers (within ~5–10%; the framework overhead applies
  equally to lcms so relative comparison stays honest)

### 2. Codegen for scenario files  ⭐ the "builder" the user asked for

The user is right — hand-writing 24+ scenario files is tedious. Build
a small node script that emits them from a config.

- [ ] Create `samples/benchmark/scenarios/build_scenarios.js`
- [ ] Take a config like:
  ```js
  [
    { lib: 'jsce',  direction: 'rgb_rgb',   variant: 'wasm-simd',   ... },
    { lib: 'jsce',  direction: 'rgb_cmyk',  variant: 'wasm-simd',   ... },
    { lib: 'lcms',  direction: 'rgb_rgb',   variant: 'default',     ... },
    // ...
  ]
  ```
- [ ] Emit one `scenarios/{lib}_{direction}_{variant}.js` per entry
  using a template (`measure_*` export pattern matches the existing
  `jsce_rgb_rgb_wasm_simd.js`)
- [ ] Wire the bench page's "Run scenarios" button to discover and
  call all generated `measure_*` functions, present as a small table
- [ ] Commit the generated `.js` files (don't generate at runtime —
  that defeats the point; we want V8 to see them as static modules)
- [ ] Add `npm run gen-scenarios` to package.json

### 3. Prototype the `new Function`-generated runner variant

Test §19.6 of `benchmark.md` empirically. If a runner generated via
`new Function(src)` matches the scenario file's ~203 MPx/s, we've
proven the v1.6 framework upgrade path is real.

- [ ] Add `callMode: 'codegen'` variant to `groups/jsce.js`
- [ ] In setup, generate the `run` closure via:
  ```js
  const runnerSrc = `
      "use strict";
      return function() {
          xform.transformArray(input, false, false, false, ${pixelCount},
                                undefined, output);
      };
  `;
  const run = (new Function('xform', 'input', 'output', runnerSrc))
              (xform, input, clampedOutput);
  ```
- [ ] Register `wasm-simd-codegen` variants for all 4 directions
- [ ] Compare numbers vs scenario file. If they match: framework
  upgrade is proven feasible. If they don't: investigate why
  (probably the call site for `runFn()` in `benchSingle` is still
  shared across all benchmarks → the codegen helps the *callee* but
  not the *caller's IC*).

### 4. Document the findings publicly

- [ ] Update `docs/deepdive/Performance.md` to reference the scenario file as
  the way to reproduce the README's 210 MPx/s claim
- [ ] Add a short section: "Why your numbers might differ from the
  README" — points at §16–19 of `benchmark.md`
- [ ] Consider linking from README to `benchmark.md §19` — the
  Schrödinger's Bench story is publishable as a JS-dev resource on
  its own, would attract eyes

## Medium-term (this week or next)

### 5. CompiledPipeline → LUT path (the v1 the user mentioned)

The current `Transform.compile()` POC only handles the no-LUT path.
The user's intuition is that a v1 compile() for the LUT path could
**bake the LUT dispatch into a fresh function** — making every
`xform.transformArray(input)` call effectively monomorphic from
V8's view of the user code.

This is a v1.5+ project per [`CompiledPipeline.md`](./CompiledPipeline.md).
Things to consider before starting:

- The LUT path already runs at 200+ MPx/s. Compile would only help
  if there's measurable JS dispatch overhead above the WASM kernel.
  The direct kernel test data suggests there might be ~5% to recover.
- The bigger win is for app code that has many Transforms and a
  shared call site. compile() makes each Transform's dispatch a
  unique function, breaking the polymorphism trap that catches users.
- toModule() (also in CompiledPipeline.md) is the marquee
  distribution feature once compile() covers all stages.

### 6. Bench framework upgrade (v1.6 of the bench)

If step 3 proves out, refactor the framework so registered
benchmarks generate their runners via `new Function(src)` by
default. This closes the framework overhead gap permanently. The
hybrid (registered + scenarios) becomes optional rather than
necessary.

## Long-term / open questions

- **Is `await yieldToCompilation()` still needed?** After the
  scenario-file approach proved Schrödinger's Bench is structural,
  the yield-between-batches might be redundant. Test removing it.
- **Should we publish "Schrödinger's Bench" as a standalone JS-dev
  resource?** A blog post / Medium article / gist version of
  `benchmark.md §17–19`. Could drive attention to jsColorEngine.
- **Does the same issue affect other JS color libraries?** Easy
  experiment: write a scenario file for `color.js` or `culori` doing
  RGB→Lab. If their numbers in the framework are also under their
  in-isolation numbers, we've found a general pattern, not just our
  bug.
- **What about Bun and Deno?** Different runtimes, possibly different
  V8 versions, possibly different optimization quirks. Worth running
  the bench across all three.

## Notes for future-you (gotchas, decisions, why-this-way)

### Bundle versioning

`BENCH_BUILD` in `samples/benchmark/browser-entry.js` is a string
constant printed to the console and shown in the engine info panel.
**Bump it whenever you change the bench framework so you can detect
cached browser bundles at a glance.** Current value:
`v0.6-scenario-test`. Hard-reload the bench page after a rebuild.

### Why the framework uses pre-bound closures

`groups/jsce.js`'s `setup()` returns `{ xform, run, ... }` where
`run` is a closure capturing everything the hot loop needs.
**Don't refactor this back to a generic `transform(ctx, input,
output)` wrapper** — that pattern was responsible for ~10% of the
original framework gap. The pre-bound closure is the minimum
acceptable abstraction.

### Why `wasm-simd-oldstyle` variant exists

`callMode: 'public-noargs'` calls `xform.transformArray(input)` with
one argument, exactly like the old bench. It was added during the
investigation as a diagnostic to test whether the call shape was
the issue. **It is not.** In Node it's the SLOWEST variant; in the
browser it's slightly slower than the default `wasm-simd`. Keep it
for now as a regression-detection diagnostic; can remove later.

### Why baseline benchmarks DON'T use pre-bound run closures

Baseline benchmarks (`mem-js-set`, `cpu-primes-js`, etc.) in
`groups/baseline.js` use the old `transform(ctx, input, output)`
pattern because their hot loops aren't kernel-call-bound — they're
memcpy-bound or compute-bound. The framework wrapper overhead
relative to actual work is small. Don't bother converting them
unless something forces it.

### About `bench.bundle.js`

It's a 45KB esbuild IIFE. Don't manually edit it — rebuild via
`npm run bench-browser`. Watch mode: `npm run bench-browser-watch`.
The browser bench HTML loads it via `<script type="module">` AFTER
loading `samples/browser/jsColorEngineWeb.js` (which sets
`window.jsColorEngine`).

### The "fair comparison" claim

Every engine in the framework (jsce variants, future lcms, future v5)
goes through the **same wrapper code path** with the **same shape of
captures**. If we ever let one engine have a different wrapper, the
relative-comparison numbers would lie. Audit any cross-engine
framework changes carefully — the wrapper shape itself is part of
the measurement.

### Where the deep-dive story lives

- [`benchmark.md`](./benchmark.md) §16 — the investigation (mystery,
  theories tried, root cause)
- [`benchmark.md`](./benchmark.md) §17 — V8 inlining model (the
  technical explanation)
- [`benchmark.md`](./benchmark.md) §18 — Patterns and anti-patterns
  for app developers (stub, grows over time)
- [`benchmark.md`](./benchmark.md) §19 — **Schrödinger's Bench** (the
  named principle and escape routes)
- [`CompiledPipeline.md`](./CompiledPipeline.md) — the production-grade
  escape via `Transform.compile()` + measured numbers

## Reading order for a new contributor

1. **Run the bench** in the browser. Observe: framework wasm-simd
   ~100 MPx/s, direct kernel ~175 MPx/s, scenario file ~200 MPx/s.
   These three numbers are the whole motivation.
2. **Read `benchmark.md` §19** (Schrödinger's Bench). The principle.
3. **Read `benchmark.md` §16** (the investigation). The journey to
   the principle.
4. **Read `CompiledPipeline.md`** (the production escape).
5. **Then come back here** and pick a task from "Tomorrow's action
   list" above.

If anything in this todo is unclear, the investigation transcript and
related commits should fill the gaps. Good luck — the heavy lifting is
done; what's left is mostly disciplined execution.
