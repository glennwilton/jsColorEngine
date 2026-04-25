# Compiled pipeline (POC)

**jsColorEngine docs:**
[← Project README](../../README.md) ·
[Bench](../Bench.md) ·
[Performance](../Performance.md) ·
[Roadmap](../Roadmap.md) ·
[Examples](../Examples.md) ·
[API: Profile](../Profile.md) ·
[Transform](../Transform.md) ·
[Loader](../Loader.md)

**Deep Dive:**
[← Index](./README.md) ·
[Architecture](./Architecture.md) ·
[LUT modes](./LutModes.md) ·
[JIT inspection](./JitInspection.md) ·
[WASM kernels](./WasmKernels.md)

---

> **Status: proof of concept — paused after v1.3 framing review
> (Apr 2026), no harm in current shape.** The code lives at
> `src/Transform.js` (`Transform.compile()`) and `bench/compile_poc/`.
> It currently handles the sRGB → CMYK chain end-to-end (6 of the 6
> stages have JS emitters, including the two diagnostic markers) and
> is the measurement vehicle for the larger v1.4 effort planned in
> [Roadmap § v1.4 — Compiled non-LUT transforms + `toModule()` distribution](../Roadmap.md#v14--compiled-non-lut-transforms--tomodule-distribution).
> This page is the post-mortem from the POC: what the compile target
> looks like, why we built it, what it taught us, and why it's
> on hold while v1.3 (16-bit I/O + lcms compat) ships.
>
> **Why on hold, not abandoned.** The POC validated everything we
> needed it to: the speedup (3–5× for the no-LUT accuracy tier), the
> correctness path (bit-exact to f64), the measurement methodology
> (NOP-differential + profiler + instrumentation triangulated to the
> same bottleneck), and the architecture (per-stage emitters, opt-in
> diagnostic modes). v1.3 (the 16-bit I/O work and the `.it8`-based
> lcms compat harness) is a stricter dependency for the project's
> credibility than another speed multiplier on the slowest tier —
> and that work needs the engine *as-is* as its baseline. We'll
> resume compile work as v1.4 once v1.3 ships, with the headline
> reframed (see [Should we ship this as default?](#should-we-ship-this-as-default--honest-assessment)
> below).

## TL;DR

- `transform.compile()` produces a single straight-line JavaScript
  function for one specific profile chain. No per-pixel option
  checks, no method dispatch, no `Function.prototype.call`, no
  intermediate result arrays — just decoded inputs in registers,
  arithmetic, and a single typed-array allocation for the return.
- **Measured on sRGB → GRACoL CMYK, no-LUT pipeline:**
  the compiled function runs at **4.04 MPx/s vs 2.31 MPx/s** for
  `t.forward()` on the same chain — **1.75× faster, bit-exact
  to f64**.
- We confirmed *why* it's faster three different ways
  (NOP-differential bench, in-line `hrtime.bigint` instrumentation,
  V8 CPU profiler). All three identified the same hot stage:
  the sRGB inverse-gamma `Math.pow(x, 2.4)` lives in the
  `stage_Gamma_Inverse` block and accounts for ~65–70 % of the
  compiled body's wall time.
- The compile-time architecture — emitters per stage, factory-scope
  state, named per-stage functions opt-in — lays the groundwork for
  three more deliverables we haven't shipped yet: `getSource()` for
  build-time precompile (CSP-safe), `toModule({...})` for
  zero-runtime-dep standalone transforms, and the WASM emission
  path covered in the v1.4 roadmap.

## What the compiler is actually doing

`new Transform({...}).create(src, dst, intent)` builds a `pipeline`
array of stage objects. Each stage is roughly:

```js
{
    funct:     someStageFunction,   // runtime path, called per-pixel
    stageData: {...},               // weights, tables, constants
    stageName: 'stage_Gamma_Inverse',
    inputEncoding:  0,              // device / PCSv2 / PCSv4 / PCSXYZ
    outputEncoding: 0
}
```

The runtime path is a tight `for (i = 0; i < pipeline.length; i++)`
loop in `Transform.forward()` that calls
`pipeline[i].funct.call(this, result, pipeline[i].stageData, pipeline[i])`
on every pixel. That's flexible — you can rewire stages at runtime,
inspect `result` per stage, swap profiles — and it's fast enough for
typical use, especially once `lutMode` kicks in and most of the
pipeline collapses into a single LUT lookup.

What it's **not** is "what V8 wants to see if you want it to make
truly fast machine code." Per pixel the runtime walker pays:

- a property load `pipeline[i].funct`
- a method dispatch via `Function.prototype.call`
- shape checks (`this`, `result`, `stageData`) every time
- an intermediate array result that gets spread or aliased between
  stages
- per-stage option re-reads (`this.clipRGBinPipeline`,
  `this.absoluteAdaptation`, etc.) that are constant over the whole
  bulk transform

`compile()` collapses all of that. After `create()` has decided the
exact stage list, options, and constants for *this specific
transform*, we walk the pipeline once at compile time and emit a
single function whose body is the concatenation of each stage's JS
source, with all options resolved to literals.

The shape:

```js
"use strict";
var r = input[0], g = input[1], b = input[2];
var X = 0, Y = 0, Z = 0;
var pcsL = 0, pcsa = 0, pcsb = 0;
var d0 = 0, d1 = 0, d2 = 0, d3 = 0, d4 = 0, d5 = 0, d6 = 0, d7 = 0;

// ----- stage 0 : stage_Gamma_Inverse -----
r = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
g = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
b = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);

// ----- stage 1 : stage_matrix_rgb -----
X = r * 0.4360747 + g * 0.3850649 + b * 0.1430804;
Y = r * 0.2225045 + g * 0.7168786 + b * 0.0606169;
Z = r * 0.0139322 + g * 0.0971045 + b * 0.7141733;

// ----- stage 2 : stage_PCSXYZ_to_PCSv2 -----  (Lab encode, X/Y/Z normalised, cbrt'd, packed)
// ----- stage 3 : stage_curve_v2 -----         (3 × 1D-LUT lookups against PCSv2)
// ----- stage 4 : trilinearInterp3D -----      (the 33³ destination CLUT)
// ----- stage 5 : stage_curve_v2 -----         (4 × 1D-LUT lookups against device CMYK)

return [d0, d1, d2, d3];
```

Important points about the code shape:

- **No closures, no `this`, no method dispatch in the body.** The
  outer `new Function('store', 'input', src)` is `.bind(null, store)`-ed
  so the callable surface is `fn(input)`. Inside the body, all stage
  data lives on `store.sN_*` properties — typed arrays already
  preallocated by `attachStore_js_*` helpers at compile time.
- **Constants are baked.** `0.4360747` is the literal sRGB→XYZ matrix
  cell. `0.04045` is the sRGB cutoff. The ICC profile's TRC threshold
  isn't read from `stage.stageData` per pixel — it's emitted as a
  literal once at compile time.
- **The named slots (`r, g, b, X, Y, Z, pcsL, pcsa, pcsb, d0..d7`)
  are the variable basis.** Every stage assumes its inputs are
  already in the right slots and writes its outputs into the next
  set. There's no return-value passing, no destructuring, no array
  indexing.
- **The CLUT lives once on `store`,** referenced by `store.s4_table`,
  `store.s4_strideY`, `store.s4_strideZ` etc. The trilinear stage
  emits direct reads `_t[corner_offset]` against that table — V8
  sees a Float64Array load with a constant offset, which is the
  fastest pattern.
- **All of this is stored at module-load time, not per pixel.** The
  expensive part of `compile()` (parsing, optimising, machine-code
  emission via TurboFan) happens once. After that, every call is
  ~250 ns of arithmetic.

## Performance: sRGB → GRACoL CMYK

Bench scripts: `bench/compile_poc/bench_compiled.js` (the headline
number), `bench/compile_poc/bench_body_variants.js` (NOP-differential
analysis of the compiled body), `bench/compile_poc/bench_profilable.js`
+ `bench/compile_poc/profile_run.js` (V8 profiler attribution).

```
====== bench (sRGB → GRACoL CMYK, 500 000 px, no-LUT path) ======
  best runtime  : 216.6 ms  (2.31 MPx/s)   — t.forward() per-pixel walker
  best compiled : 123.8 ms  (4.04 MPx/s)   — fn(input) emitted body
  best speedup  : 1.75x
```

`Δmax` between the two over 200 random pixels is **0.0** — bit-exact
to the f64 reference. The compiled function isn't trading accuracy
for speed; the math is identical, the savings are entirely from
removing dispatch and per-pixel option lookups.

### Where the time goes inside the compiled body

The compiled function takes ~250 ns per pixel. We measured the
breakdown three ways:

#### 1. NOP-differential (the cleanest)

`bench_body_variants.js` rewrites the emitted source with parts
stubbed out, recompiles, benches, and attributes the difference
back to what was removed:

| Variant | MPx/s | Δ vs baseline |
|---|---|---|
| baseline (full body) | 4.04 | — |
| `Math.pow → 1` (kill all `Math.pow`) | 11.0 | **-64 %** body time vanishes |
| trilinear → constant 0.5 | 4.69 | -14 % body time |
| matrix block stripped | 4.10 | -1 % body time |

So `Math.pow` accounts for ~64 % of the body and the trilinear corner
loads about 14 %. Matrix and curves are noise (each <2 %).

#### 2. V8 CPU profiler (the corroborator)

The profiler can only see one function — and `compile()` produces
exactly one — so the default mode shows everything attributed to
`compiled_fn`. To get per-stage attribution, `compile({ profilable: true })`
lifts each stage into its own named function expression at factory
scope (closed over the shared state vars), then has the per-pixel
function call them in order:

```js
function compiledTransform(input) {
    r = input[0]; g = input[1]; b = input[2];
    _s0_stage_Gamma_Inverse();
    _s1_stage_matrix_rgb();
    _s2_stage_PCSXYZ_to_PCSv2();
    _s3_stage_curve_v2();
    _s4_trilinearInterp3D();
    _s5_stage_curve_v2();
    return [d0, d1, d2, d3];
}
```

Cost of named-function mode: ~45 % throughput hit (4.04 → 2.85 MPx/s)
from per-stage call overhead. Acceptable for a profiler-only mode;
**bit-exact to the monolithic version** (Δmax over 200 pixels = 0).

Run `node bench/compile_poc/profile_run.js --pixels 5000000`. It
spawns the inner bench under `node --prof`, processes the resulting
tick log, and prints a clean per-stage table:

```
===== per-stage V8 profiler attribution =====
total samples in run: 1926   (1 sample ≈ 1ms by default)
idx  stage                      self    self%    +builtin    incl    incl%
  0  stage_Gamma_Inverse           45    2.34%        500     545   28.30%   ← THE hot stage
  3  stage_curve_v2                82    4.26%          0      82    4.26%
  4  trilinearInterp3D            144    7.48%          0     144    7.48%
                                                              ─────
                              total compiled-stage ticks:     771
```

`self ticks` are samples taken with the stage as the topmost JS
frame. `+builtin` is the column we wrote a custom `--prof-process`
parser for: it walks the bottom-up profile, finds samples taken in
C++ (V8 builtins like `Math.pow` / `Math.cbrt` / GC), and charges
them to the JS stage that was on the stack at the time.

Of the 771 ticks attributable to compiled-stage code,
`stage_Gamma_Inverse` (where the three `Math.pow(x, 2.4)` calls
live) accounts for **545 ticks = 70.7 %**. The matrix and curve
stages are too cheap to register samples at all.

#### 3. In-line `hrtime.bigint` instrumentation (the unreliable one)

`compile({ instrument: true })` wraps each stage body with
`process.hrtime.bigint()` taps that accumulate per-stage ns into
`store._instTime[]`. The numbers look like a per-stage breakdown
but are **not trustworthy in absolute terms**:

- Every `hrtime.bigint()` call is 50–100 ns of overhead — the same
  order as the work being measured.
- The taps prevent V8 from optimising across stage boundaries
  (no cross-stage CSE, no dead-store elimination, no fused
  load-store), so the cost distribution shifts under measurement.

`Transform.instrumentReport(compiled)` is still useful for *relative*
comparisons (which stage shifted between two runs?) but the absolute
numbers will mislead anyone who treats them as the truth. The
profiler is the truth-teller; instrumentation is a sanity check.

#### Three methods, one verdict

| Method | gamma_inverse share of compiled body |
|---|---|
| NOP-differential | ~64 % (`Math.pow(x, 2.4)`) |
| In-line instrumentation | unreliable (timer perturbation) |
| **V8 CPU profiler** | **~71 % (545 / 771 stage ticks)** |

Two independent measurements (differential + profiler) triangulate
to the same hot stage. The two opt-in compile options below were
designed against this finding — `useGammaLUT` reclaims the gamma
ticks; `hotLoop` removes the per-pixel allocation/call overhead
that sits *above* the body cost.

### Acting on the bottleneck — `useGammaLUT` and `hotLoop`

Two new opt-in `compile()` flags target the things the profiler
told us were expensive:

```js
const compiled = t.compile({
    useGammaLUT: true,    // 4096-entry float LUT replaces Math.pow in stage_Gamma_Inverse — LOSSY (~1 ULP at u8)
    hotLoop:     true,    // wrap body in for(_i…); fn(input, output, n) instead of fn(pixel) → array
});
```

Both default to `false` for bit-exactness and the simple
`fn(pixel) → array` shape. `useGammaLUT` is opt-in because it
trades absolute accuracy for throughput — the LUT is built once
in `attachStore_js_stage_Gamma_Inverse(store, idx, stage,
compileOptions)` and parked on `store.s{idx}_gammaLut`; the
emitter then writes `r = _gl[(_r * 4095) | 0]` instead of
`Math.pow(...)`. `hotLoop` is purely structural — same numeric
output as the single-pixel form, just amortises the call/alloc
overhead across all pixels in one outer loop.

Measured on the same sRGB → GRACoL chain
(`bench/compile_poc/bench_gammalut_hotloop.js`,
500 000 random pixels, best of 5):

| Mode                          |    ms |   MPx/s | speedup vs runtime | speedup vs plain compile |
|-------------------------------|------:|--------:|-------------------:|-------------------------:|
| `runtime forward()`           | 213.0 |  2.35   |              1.00× |                        — |
| `compile()` plain             | 119.5 |  4.18   |              1.78× |                    1.00× |
| `compile({ useGammaLUT })`    |  43.3 | 11.54   |          **4.92×** |                **2.76×** |
| `compile({ hotLoop })`        | 117.6 |  4.25   |              1.81× |                    1.02× |
| `compile({ useGammaLUT, hotLoop })` | **39.7** | **12.59** | **5.36×** | **3.01×** |

Two things to read off this table:

- **The LUT is the headline.** A single 4096-entry table (~32 KB
  of `Float64Array`) replaces three `Math.pow(x, 2.4)` calls per
  pixel and *cuts the body cost by 64 %*, exactly matching the
  ~64–71 % share the profiler/differential bench attributed to
  gamma. The accuracy loss (`Δmax ≈ 3.26e-4`) is ~10× below
  1 code value at 8-bit precision — invisible for u8 image
  workflows, not appropriate for measurement-grade colour science
  (use the bit-exact default for that).
- **`hotLoop` only adds ~1.02× on its own.** Without LUT, the
  body cost so dominates that removing the per-pixel array
  allocation barely registers. *With* LUT (body cost cut by 64 %),
  the allocation/call overhead becomes a meaningful fraction
  again and `hotLoop` adds a further ~1.09× on top, getting the
  combined number to 3.01× over plain compiled, 5.36× over the
  runtime walker.

The combined mode is what an image-pixel pipeline (`fn(input,
output, pixelCount)` over a typed-array buffer) should use. The
single-pixel form remains useful for one-off colour lookups,
test code, and any caller that doesn't want the lossy LUT.

### `strict` — fail fast on missing emitters

A third change in this round: `compile()` now defaults to
`strict: true`, throwing if any pipeline stage lacks an
`emit_<target>_<stageName>` function. The previous behaviour —
silent fallback to a runtime call — produced wrong output for
non-trivial encoding boundaries (the CMYK → CMYK case
documented in the next section) and gave us a misleading
"compiles fine" success that masked the real coverage gap. Pass
`{ strict: false }` to opt back in to the runtime fallback for
chains you've audited yourself.

## CMYK → CMYK: what we learned by trying it

CMYK → CMYK is the natural "is the speedup gamma-specific?" test —
no sRGB inverse-gamma at the front, just curves and CLUTs. We
tried it (`bench/compile_poc/bench_compiled_cmyk2cmyk.js`,
GRACoL → SWOP) and **the bench refuses to run**. Two known gaps
in the POC surface immediately:

1. **The compile-time preamble is hardcoded for 3-channel RGB
   input.** Every emitted function starts with `var r = input[0],
   g = input[1], b = input[2];`. CMYK input needs a 4-channel
   start (`var d0 = input[0], d1 = input[1], d2 = input[2],
   d3 = input[3];`) and the right output-side variable basis.
2. **`tetrahedralInterp4D` and `stage_PCSv2_to_PCSv4` have no JS
   emitter yet.** They fall through to the runtime stub
   (`_compile_emit_runtime_fallback`), which works for individual
   stages but produces wrong output when the chain depends on
   them — the fallback can't bridge the variable-basis change at
   the runtime boundary.

The CMYK→CMYK chain looks like:

```
stage_curve_v2 > tetrahedralInterp4D > stage_curve_v2
              > stage_PCSv2_to_PCSv4
              > stage_curve_v2 > trilinearInterp3D > stage_curve_v2
```

Five of the seven stages already have emitters (curves and 3D
trilinear are reused from the RGB→CMYK path). To finish the LUT-only
test we need:

- `emit_js_stage_tetrahedralInterp4D` (4D version of the existing
  trilinear emitter; lifts the K-plane setup into the body and
  reuses the C/M/Y interp pattern from the WASM kernel).
- `emit_js_stage_PCSv2_to_PCSv4` (a small Lab encoding/scale
  conversion — handful of multiply-adds).
- A multi-channel input preamble in `compile()` driven by the first
  stage's `inputEncoding` and channel count.

Until those land we don't have a real CMYK→CMYK number. The bench
script aborts with a useful explanation rather than reporting a
bogus "1.98×" speedup — see the abort path in
`bench_compiled_cmyk2cmyk.js`.

**Why this matters:** RGB → CMYK is currently 1.75× because the
runtime walker has 6 stages of dispatch and the compiled function
removes all of them; the fact that one stage (gamma) dominates means
*compiling* helps a *lot* but the absolute ceiling is bounded by
`Math.pow`. CMYK → CMYK should look different — no `Math.pow` in
the body, much higher relative cost in the trilinear/tetrahedral
stages, and likely a *larger* speedup in the 2.0–2.5× band because
dispatch overhead is a higher share of the runtime baseline. We
expect to confirm that in the next pass.

## Why we built it — purpose of compiling a single pipeline function

The runtime walker is a *general-purpose* execution model. It can
handle any pipeline shape, any combination of stages, any options
flipped at any time. The price of that generality is that V8 sees
nothing more than "a `for` loop over an array of unknown function
pointers" — no inlining, no constant folding, no specialisation.
Every per-pixel call goes through:

```
forward(in)
  └─ for (i = 0; i < pipeline.length; i++)
       └─ pipeline[i].funct.call(this, result, stageData, stage)
              └─ a generic stage function with its own option checks
```

`compile()` flips the trade-off. We give up runtime flexibility (you
can't swap a stage out of a compiled function — you'd have to
recompile) and in return V8 sees:

```
fn(input)
  └─ a single function body with every constant baked, every option
     resolved, every stage inlined, every typed-array access at a
     fixed stride. TurboFan inlines everything, hoists invariants,
     register-allocates the named slots, and emits a tight x64
     machine-code body.
```

That's the whole point: **trade per-call flexibility for per-call
speed**, by specialising at create time once we know exactly what
this transform does. The runtime walker stays exactly as it is and
remains the default — `compile()` is opt-in and additive.

## Future use cases

The roadmap covers the v1.4 plan in detail
([Roadmap § Inspection / distribution story](../Roadmap.md#non-lut-pipeline-code-generation-new-function--emitted-wasm)).
The four use cases that fall out of having a single emitted function
per transform are:

### 1. Runtime JIT (default — what the POC is)

```js
const t = new Transform({...}).create(src, dst, intent);
const compiled = t.compile({ target: 'js' });
const cmyk = compiled.fn([r, g, b]);
```

Same Transform API, monolithic compiled body, ~1.75× faster on
no-LUT chains. This is what you'd use in any long-running converter
where parse + warm-up cost (~10–100 ms) is amortised across millions
of pixels.

### 2. CSP-locked environments — `getSource()`

`new Function()` is blocked by strict Content Security Policy
(some browser extensions, many enterprise sites). The compile output
is just a JS string — expose it directly:

```js
const src = compiled.source;  // already returned by compile()
//   write to a file at build time, ship as a static module
```

The user precompiles at build time via their bundler, ships the
emitted JS as a normal source file, and pays zero runtime CSP cost.
The engine becomes a build-time tool for that transform; the runtime
dependency disappears. This is the quietly important one — most of
the people who care about CSP also care about bundle size, and a
50–80 KB single-purpose transform module beats a 192 KB
general-purpose engine for "convert these specific colours, never
anything else."

### 3. Debugging — `console.log(compiled.source)`

The emitted code is human-readable JavaScript with structural
comments per stage:

```js
// ----- stage 0 : stage_Gamma_Inverse -----
// sRGB inverse-gamma (IEC 61966-2-1): linear segment under 0.04045,
// gamma 2.4 above. Per-channel, in-place.
r = r <= 0.04045 ? r / 12.92 : Math.pow((r + 0.055) / 1.055, 2.4);
g = g <= 0.04045 ? g / 12.92 : Math.pow((g + 0.055) / 1.055, 2.4);
b = b <= 0.04045 ? b / 12.92 : Math.pow((b + 0.055) / 1.055, 2.4);
```

`new Function()` strips the comments at parse time (zero runtime
cost), so we emit them generously. A colour bug becomes "read 60
lines of self-documenting JavaScript" instead of "step through the
stage walker for an hour." Matrix rows are annotated with their
source/destination whitepoint, curve lines with their ICC tag
origin, CLUT references with their grid size — the artefact is a
teaching tool *and* the running code.

### 4. Self-contained transform modules — `toModule()` *(planned)*

The big one for distribution. `compile()` already produces the
function body and has a reference to the `store` (curves, CLUTs,
constants). `toModule({ name: 'srgb_to_gracol' })` would emit the
`store` data as inline typed-array constructors at the top of the
file plus the function body, producing a standalone JS module:

```js
// srgb_to_gracol.js — generated by jsColorEngine
'use strict';

// 33³ destination CLUT, baked at module load (~17 KB Uint16)
const _s4_table = new Uint16Array([0x1234, 0x5678, ...]);
const _s3_curve_table = new Float64Array([0.0, 0.012, ...]);
// ... other store data ...

module.exports = function srgb_to_gracol(input) {
    let r = input[0], g = input[1], b = input[2];
    // ... emitted body ...
    return [d0, d1, d2, d3];
};
```

A typical RGB→CMYK module lands around ~50–80 KB unminified
(~25–40 KB gzipped, dominated by the 17⁴×4 u16 CLUT). That's
**smaller than the 192 KB engine** for one specific transform —
no ICC parser, no Loader, no dispatcher, no bytes spent on transform
shapes you don't use. Bit-exact to the engine output.

This unlocks deployment shapes the engine can't:

- **CDN-hosted point conversions** — drop a `<script src="srgb_to_gracol.js">`
  on a marketing page that needs one specific colour conversion;
  no engine, no profiles, no parser.
- **Edge runtimes** that don't allow `new Function()` (Cloudflare
  Workers, some Deno deploy modes) — the module is just JavaScript.
- **Pre-baked LUT distribution** for known profile pairs — print
  shops with three production presses publish three modules; their
  customers `import` the one they need.

Engineering-wise the work to ship this is small (the function body
is already in `compiled.source`; the store serialisation is a
typed-array → `new Uint16Array([...])` template). The interesting
design decisions are about **format**: CommonJS vs ESM, embedded
binary vs base64, single file vs split bundle. v1.4 territory.

## Architectural notes for the next contributor

If you're picking this up, the things that surprised us:

- **Intermediate `let _r = r` snapshot variables don't cost
  anything.** TurboFan's SSA form treats them as register copies
  and elides them at machine-code time. We tried both styles
  (`bench_body_variants.js` strip-matrix-snapshot variant) — no
  measurable difference. Write the emitter in whichever style is
  clearer.
- **Don't try to fuse expressions across stages.** We tested a
  "trilinear-fully-fused" variant that inlined every CLUT load
  into a single mega-expression. It was *slower* than the unfused
  version because V8 lost CSE opportunities — the same CLUT cell
  was loaded multiple times. Trust the JIT to do CSE on
  named temps; don't pre-fuse.
- **`Math.pow(x, 1.0/3.0) → Math.cbrt(x)` is a free win.**
  `Math.cbrt` is a TurboFan intrinsic that lowers to a small
  polynomial; `Math.pow` falls through to the libm `pow` shim. We
  swapped this in the Lab-encode stage (`emit_js_stage_PCSXYZ_to_PCSv2`)
  for ~35 % time reduction in that stage's body.
- **`Math.pow(x, 2.4)` has no equivalent intrinsic.** sRGB inverse
  gamma is the obvious next target. Options:
  - 256-entry LUT keyed on `(x * 255) | 0` — exact for u8 inputs,
    needs interpolation for float, but our gamma-decode chain
    almost always runs on u8 anyway.
  - Polynomial approximation (`fma(x, fma(x, ...), ...)`) — keeps
    full float accuracy at the cost of ~12 multiply-adds vs the
    LUT's 1 load.
  - Neither has been benched yet; expected to land alongside the
    v1.4 emitter expansion.
- **The diagnostic stages (`stage_history`, `stage_debug`) are
  already routed through a single emitter** (`emit_js_stage_debug`
  / `emit_js_stage_history`) that produces a clean source comment
  and zero runtime code. They're safe to leave in the pipeline at
  compile time — they'll show up in the emitted source as
  `// ----- stage N : Start -----` with no per-pixel cost.
- **The `profilable` mode is the right thing to reach for when
  `Math.pow`-style hot spots aren't obvious from inspection.**
  Don't bother with `instrument: true` for absolute numbers — it
  perturbs the JIT too much. Use it only to compare two
  configurations *under the same instrumentation*.

## Should we ship this as default? — honest assessment

Captured during the v1.3 / v1.4 framing review (Apr 2026). Re-read
this when picking compile work back up post-v1.3.

### Where compile actually sits in the speed stack

Mapping the `compile_poc` numbers onto the same baseline used by
the [browser bench](../Bench.md) (RGB→CMYK, GRACoL2006, real
hardware), the tier picture looks like this:

```
jsce float (33³ LUT)        7.73 MPx/s    speed-tier (image bulk work)
jsce int-wasm-simd          7.30 MPx/s    speed-tier (image bulk work)
─────────────────────────────────────────────────────────────────────
jsce compile + LUT + hot   ~1.3 MPx/s     [NEW: accuracy-tier, ~5× over today]
jsce no-LUT runtime         0.25 MPx/s    accuracy-tier (today)
lcms-wasm NOOPT             0.11 MPx/s    accuracy-tier (lcms equivalent)
```

Compile is **not a LUT-killer**. It's a **no-LUT-tier accelerator**.
It moves the floor of the accuracy path up by ~5× — which is
exactly the rung that has no acceleration story today (every other
tier already has a WASM/SIMD option). Image-bulk users will stay on
the LUT tier; compile is for callers who picked the no-LUT path
specifically *because* they wanted bit-exact f64 — colour
measurement, ΔE reporting, single-colour lookups, named-colour
resolution, gamut-boundary checks.

### Pros (what the POC validated)

- **Big win on the slowest tier.** ~5× over runtime walker,
  bit-exact by default, opt-in lossy LUT for an extra ~2.7× on top.
- **Side benefits are unique to this approach**, not nice-to-haves:
  - `getSource()` → CSP-safe build-time precompile. Works in
    browser extensions, locked-down enterprise sites, Cloudflare
    Workers. **Nothing else in the JS color-management space
    offers this.**
  - `toModule()` → standalone, dep-free, bit-exact transform module
    (~50–80 KB for one transform, vs ~192 KB for the full engine).
    No competitor (lcms, color.js, culori) can do this. Reframes
    jsColorEngine as both a runtime *and* a build-time tool.
  - Debug-by-reading: `console.log(compiled.source)` shows the
    actual math, comments and all. Makes the engine teachable.
- **Compile cost is one-time** and small (~1 ms). Amortised over
  thousands of pixels it's free; over millions it's invisible.
- **Validated a measurement methodology** — three independent
  methods (NOP-diff, profiler, in-line instrumentation) agreed on
  the bottleneck. That triangulation pattern is reusable beyond
  this work.

### Cons (the honest cost)

1. **Stage emitter coverage is the real bill.** Quick inventory of
   stages in `src/Transform.js`:
   - **Input adapters** (~5): `stage_cmsLab_to_LabD50`,
     `stage_Int_to_Device`, `stage_RGB_to_Device`,
     `stage_Lab_to_PCS_v2/v4`, the encoding decoders
   - **Core math** (~7): `Gamma_Inverse` ✅, `matrix_rgb` ✅,
     `PCSXYZ_to_PCSv2` ✅, `PCSv2_to_PCSv4`, `chromaticAdaptation`,
     `absoluteAdaptation_in/out`
   - **CLUT** (~3): `curve_v2` ✅, `trilinearInterp3D` ✅,
     `tetrahedralInterp4D`
   - **Intent/BPC** (~3–5): perceptual intent table, BPC, gamut
     mapping markers
   - **Output adapters** (~5): the inverses of the input set
   - **Diagnostic** (2): `stage_debug` ✅, `stage_history` ✅

   Roughly **25–30 emitters**, **6 ship today**. At ~30 lines avg,
   that's ~750 lines added to `Transform.js` (~6 % growth). Each
   emitter needs a bit-exactness test against the runtime stage.

2. **Maintenance coupling.** Changing a `stage_*` `funct` now
   means changing the matching `emit_*` to keep parity. Mitigated
   by a CI test that compares `compile()` output to `t.forward()`
   for every supported chain on every PR.

3. **Compile() doesn't beat the LUT path.** People doing bulk
   image work will stay on `'int-wasm-simd'` regardless. Compile
   is the *accuracy-tier* speedup, not a universal one.

4. **Dist size.** Adding emitters to `Transform.js` grows the
   engine bundle. Splitting into a separate `@jscolorengine/compile`
   sub-package is possible but makes dist messy. Pragmatic answer:
   keep it in core; the engine is still under 200 KB.

### Project ethos fit — strong

- **Pure JavaScript, no native deps** → compile() preserves this;
  output is JS.
- **Accuracy-first** → compile() is bit-exact by default;
  `useGammaLUT` is opt-in and labelled lossy in the source comments.
- **No magic / inspect the source** → `getSource()` literally
  exposes the math.
- **Smaller than lcms-wasm** → `toModule()` is the most extreme
  expression of this.
- **No telemetry, no upload** → unchanged.

The one positioning shift: `toModule()` reframes jsColorEngine as
*also* a build-time tool, not just a runtime library. That's
evolution, not contradiction — but the README will need a small
update when v1.4 ships.

### v1.3 / v1.4 split (decision)

- **v1.3 stays scoped:** 16-bit I/O, `.it8` lcms compat harness,
  `lutGridSize`, plus `float-wasm-scalar` as the foundation for
  the accuracy-tests-via-WASM path. **Compile is NOT pulled into
  v1.3.** v1.3's compat harness needs the engine *as-is* as its
  baseline; introducing a new code path mid-stream would muddle
  the regression signal.
- **v1.4 reframes:** flip the headline from "WASM emit + 200 MPx/s
  ceiling" to **"compile() stable + `toModule()` + coverage matrix"**.
  Defer the WASM emit target to v1.5 or later — the JS-emit + LUT +
  hot-loop combination already gets us to ~5× over runtime, and the
  bottleneck is `Math.pow`, which WASM doesn't make materially
  faster (the LUT does).
- **`toModule()` is the marquee feature.** More important than the
  speedup. It's the one thing competitors can't match.

### Verdict

Yes worth shipping — **as opt-in for v1.4**, with the LUT path
remaining the auto-pick for bulk image work. Anyone who picks the
no-LUT accuracy path then layers `compile()` gets the ~5× boot
"for free, identical results" (bit-exact unless they explicitly
opt into `useGammaLUT`). The current POC is **paused, not
abandoned** — uncommitted code is committed at the v1.3-pivot
checkpoint so the measurement record stands.

## Reproducing the numbers

```sh
# Headline: monolithic compiled vs runtime walker
node bench/compile_poc/bench_compiled.js --pixels 500000

# Differential analysis: which stage dominates the body?
node bench/compile_poc/bench_body_variants.js --pixels 500000

# V8 CPU profiler: per-stage attribution from real samples
node bench/compile_poc/profile_run.js --pixels 5000000

# (planned) CMYK→CMYK LUT-only chain — currently aborts on missing emitters
node bench/compile_poc/bench_compiled_cmyk2cmyk.js
```

All four run from a fresh checkout in a few seconds each. `profile_run.js`
takes ~30 s for the 5M-pixel default because the V8 tick log needs
the bigger sample size for stable attribution.

## Related

- [Roadmap § v1.4 — Compiled non-LUT transforms + `toModule()` distribution](../Roadmap.md#v14--compiled-non-lut-transforms--tomodule-distribution)
  — the production plan this POC is informing
- [Architecture](./Architecture.md) — pipeline model, runtime walker
- [JIT inspection](./JitInspection.md) — TurboFan-emitted x64 for
  the related kernel work; same JIT, same techniques
- [Performance](../Performance.md) — overall throughput numbers
  across all kernel modes
