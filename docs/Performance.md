# Performance — where we are, what we learned, where we're going

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Bench](./Bench.md) ·
[Roadmap](./Roadmap.md) ·
[Deep dive](./deepdive/) ·
[Examples](./Examples.md) ·
[API: Profile](./Profile.md) ·
[Transform](./Transform.md) ·
[Loader](./Loader.md)

---

This document captures the performance findings from the v1.1 work
(`lutMode: 'int'` integer hot path), the v1.2 WASM LUT kernel
additions (`'int-wasm-scalar'` + `'int-wasm-simd'`, 3D **and** 4D
both shipped and bit-exact across the 12-config matrix, plus
`lutMode: 'auto'` as the new default), the v1.3 16-bit kernel ladder
(`'int16'` JS + `'int16-wasm-scalar'` + `'int16-wasm-simd'`, all
bit-exact siblings on the same Q0.13 contract), how jsColorEngine
compares to the industry-standard C implementations (LittleCMS,
babl), and the planned v1.4 / v1.5 / v2 future work.

It's intentionally a "lab notebook" — the numbers are real, the
explanations are blunt, and the conclusions feed directly into the
roadmap at the bottom.

> **Technical deep-dive lives in [`docs/deepdive/`](./deepdive/).**
> This page is the journey — headline numbers, compare-to-lcms, the
> surprises, the roadmap. The deep-dive has the V8 asm walkthroughs,
> op-count tables, `.wat` design discussions, and reproduction
> recipes. §2 and §3 below summarise each deep-dive page and link to
> it, so you can stay at journey-level or drop into the evidence
> when something looks suspicious.

---

## Table of contents

- [1. Where we are — current numbers](#1-where-we-are--current-numbers)
    - [Headline throughput table (v1.2, V8 / Node 20)](#headline-throughput-table-v12-v8--node-20)
    - [⚠ Caution — benchmark context matters (a lot)](#-caution--benchmark-context-matters-a-lot)
    - [Where the 10–15% comes from in production](#where-the-1015-comes-from-in-production)
- [2. What we learned](#2-what-we-learned)
    - [2.1 The JS hot path is already close to the x64 ceiling](#21-the-js-hot-path-is-already-close-to-the-x64-ceiling)
    - [2.2 Named temps at microbench scale — we tested, then declined to refactor](#22-named-temps-at-microbench-scale--we-tested-then-declined-to-refactor)
    - [2.3 WASM scalar — the predicted 1.4× landed](#23-wasm-scalar--the-predicted-14-landed)
    - [2.4 WASM SIMD 3D — channel-parallel was the right axis](#24-wasm-simd-3d--channel-parallel-was-the-right-axis)
    - [2.5 WASM 4D — hoisted prologue + flag-gated K-plane loop](#25-wasm-4d--hoisted-prologue--flag-gated-k-plane-loop)
    - [Reproducing every number on this page](#reproducing-every-number-on-this-page)
- [3. Discoveries in the journey](#3-discoveries-in-the-journey)
    - [3.1 lcms-wasm RGB→RGB is a no-op — a benchmarking trap](#31-lcms-wasm-rgbrgb-is-a-no-op--a-benchmarking-trap)
    - [3.2 First WASM 4D ran 25 % slower than JS — V8's inliner refused the helper](#32-first-wasm-4d-ran-25-slower-than-js--v8s-inliner-refused-the-helper)
    - [3.3 The 1D POC ruled out SIMD for LUTs — POC was vectorising the wrong axis](#33-the-1d-poc-ruled-out-simd-for-luts--poc-was-vectorising-the-wrong-axis)
    - [3.4 WASM SIMD detection false-negative in browsers](#34-wasm-simd-detection-false-negative-in-browsers)
    - [3.5 u16 CLUT scaled by 65535 vs 65280](#35-u16-clut-scaled-by-65535-vs-65280)
- [4. How does this compare to LittleCMS in C?](#4-how-does-this-compare-to-littlecms-in-c)
    - [Measured — vs `lcms-wasm` (direct, same-machine)](#measured--vs-lcms-wasm-direct-same-machine)
    - [Why pure-JS can beat an Emscripten-wasm32 port](#why-pure-js-can-beat-an-emscripten-wasm32-port)
    - [Measured — vs native LittleCMS (same hardware, same run)](#measured--vs-native-littlecms-same-hardware-same-run)
    - [What the gap actually is](#what-the-gap-actually-is)
    - [What is `fast-float`?](#what-is-fast-float)
    - [Lessons we picked up from reading `lcms2/src/cmsintrp.c`](#lessons-we-picked-up-from-reading-lcms2srccmsintrpc)
- [5. What shipped in v1.1 and v1.2](#5-what-shipped-in-v11-and-v12)
    - [v1.1 — 4D integer kernels (CMYK input) + u20 refactor  ✅ SHIPPED](#v11--4d-integer-kernels-cmyk-input--u20-refactor---shipped)
    - [Design constraint — float OR u16 only](#design-constraint--float-or-u16-only)
    - [v1.2 — WASM LUT kernels (3D + 4D, scalar + SIMD) and `lutMode: 'auto'`](#v12--wasm-lut-kernels-3d--4d-scalar--simd-and-lutmode-auto)
    - [v1.3 — 16-bit kernel ladder ✅ SHIPPED](#v13--16-bit-kernel-ladder--shipped)
    - [v1.4+ — see Roadmap.md](#v14-and-beyond--see-roadmapmd)
    - [Historical record: original v1.3 / v1.5 analysis (1D WASM POC)](#historical-record-original-v13--v15-analysis-1d-wasm-poc)
- [6. What's not on the roadmap](#6-whats-not-on-the-roadmap)
- [7. Choosing a configuration](#7-choosing-a-configuration)
    - [The four tiers — accuracy vs speed](#the-four-tiers--accuracy-vs-speed)
    - [Quick reference — when to enable what](#quick-reference--when-to-enable-what)

---

## 1. Where we are — current numbers

### Headline throughput table (v1.2, V8 / Node 20)

JS-side numbers measured with `bench/mpx_summary.js` against the
GRACoL2006 ICC profile (65 K pixels per iter, 5 batches × 100 iters
median, 500 iter warmup). WASM scalar and SIMD numbers come from the
shipped kernel matrix (`bench/wasm_poc/tetra3d_simd_run.js` +
`tetra4d_simd_run.js`, 33-grid configs which are the closest match
to a real ICC LUT shape — full per-grid matrix in
[deep-dive / WASM kernels](./deepdive/WasmKernels.md)). All four
directions × all four `lutMode` values are now shipped and bit-exact
against the JS `'int'` reference.

| Direction | No LUT (accuracy) | `'float'` (f64) | `'int'` (u16) | `'int-wasm-scalar'` | **`'int-wasm-simd'`** | SIMD vs `'int'` | Accuracy (u8) |
|---|---|---|---|---|---|---|---|
| RGB → RGB  (3D 3Ch) | 5.0 MPx/s | 69.0 MPx/s | 72.1 MPx/s | ~99 MPx/s | **~216 MPx/s** | **3.0×** | **0 LSB (100 % exact)** |
| RGB → CMYK (3D 4Ch) | 4.1 MPx/s | 56.1 MPx/s | 62.1 MPx/s | ~84 MPx/s | **~210 MPx/s** | **3.5×** | ≤ 1 LSB |
| CMYK → RGB (4D 3Ch) | 4.5 MPx/s | 50.8 MPx/s | 59.1 MPx/s | ~70 MPx/s | **~128 MPx/s** | **2.1×** | ≤ 1 LSB |
| CMYK → CMYK (4D 4Ch) | 3.8 MPx/s | 44.7 MPx/s | 48.8 MPx/s | ~60 MPx/s | **~128 MPx/s** | **2.6×** | ≤ 1 LSB |

Full 6-config × 2-axis matrix (g1 ∈ {17, 33, 65}, cMax ∈ {3, 4}),
bit-exact verification against both the JS `'int'` reference and the
shipping WASM scalar kernel, plus alpha-mode handling and dispatcher
design, are documented in [deep-dive / WASM kernels](./deepdive/WasmKernels.md):

- [WASM scalar — 3D](./deepdive/WasmKernels.md#wasm-scalar-3d--the-first-kernel)
  (avg **1.40×** over `'int'`, range 1.37-1.45×)
- [WASM SIMD — 3D](./deepdive/WasmKernels.md#wasm-simd-3d--channel-parallel-was-the-wrong-axis-once)
  (avg **3.25×** over `'int'`, range 2.94-3.50×)
- [WASM scalar — 4D](./deepdive/WasmKernels.md#wasm-scalar-4d--and-the-function-call-lesson)
  (avg **1.22×** over `'int'`, range 1.13-1.49×)
- [WASM SIMD — 4D](./deepdive/WasmKernels.md#wasm-simd-4d--the-k-plane-loop-in-one-v128)
  (avg **2.39×** over `'int'`, range 2.04-2.57× — flat ~125 MPx/s
  across LUT sizes from 38 KB to 9 MB)

> **v1.2 status:** `lutMode: 'auto'` shipped as the default — `int8`
> + `buildLut: true` transparently picks `'int-wasm-simd'` with the
> full demotion chain; everything else resolves to `'float'`. The
> native-lcms2 head-to-head [has now been measured](#measured--vs-native-littlecms-same-hardware-same-run)
> via [`bench/lcms_c/`](../bench/lcms_c) — jsColorEngine `'int'` beats
> native vanilla lcms2 on 3 of 4 workflows in pure JS, and the WASM
> SIMD default wins on all four by 2–5×. v1.2 is feature-complete.

**MPx/s = millions of pixels per second.** A 4K image is ~8.3 MPx, so
72 MPx/s converts a 4K RGB→RGB frame in ~115 ms single-threaded; the
slowest JS workflow (CMYK→CMYK) still finishes a 4K frame in ~170 ms.
With `'int-wasm-scalar'` the 4K RGB→RGB frame drops to ~84 ms; with
`'int-wasm-simd'` both 4K RGB→RGB **and** 4K RGB→CMYK drop to ~**39 ms**,
and 4K CMYK→CMYK to ~**65 ms** — still single-threaded. (CMYK output
runs at the same wall-clock as RGB output under SIMD because the 4th
channel was in a lane that was already present; see §2.4 and
[deep-dive / WASM kernels — SIMD 3D](./deepdive/WasmKernels.md#wasm-simd-3d--channel-parallel-was-the-wrong-axis-once).)

The 4D directions beat 3D on speedup because the float K-LERP does
more redundant rounding work per pixel, and the 4D integer kernels
use a **u20 Q16.4 single-rounding design** that folds what used to be
four stacked rounding steps (K0 plane, K1 plane, K-LERP, final u8)
into a single final `>> 20`.

Three fixes landed in v1.1 that together got accuracy to **≤ 1 LSB
across every direction** (previously CMYK → RGB hit 3 LSB on ~1 % of
channels with 100 % of errors going `int > float`):

1. **u16 CLUT scaled by 255 × 256 = 65280** (not 65535) — so the
   kernel's `u16 / 256` gives u8 exactly and not +0.4 % high.
2. **`gridPointsScale_fixed` carried at Q0.16** (not Q0.8) — so the
   true `(g1-1)/255` ratio is preserved through `rx`/`ry`/`rz`/`rk`.
3. **u20 single-rounding for 4D kernels** — as above.

The residual 1 LSB on CMYK directions is just `Uint8ClampedArray`
banker's-rounding disagreeing with the kernel's round-half-up at
exact `X.5` half-ties. It's not accumulated math error.

### ⚠ Caution — benchmark context matters (a lot)

**Don't trust a speedup number from a micro-bench that runs the kernel
differently than production code runs it.** You will get false
positives, and they will be "proofs of concept" that don't survive
integration. We hit this during v1.1 development: a standalone-
function POC reported a 1.5× speedup that collapsed to 1.15× once the
kernel moved into a class method. Both numbers were "correct" — they
just measured different things.

The mechanics, because it's worth understanding and not just trusting:

1. **V8 (and other modern engines) optimise class methods on hot
   objects much more aggressively than free-standing functions.**
   TurboFan / Ignition track hidden-class shape, call-site
   monomorphism, inline caches, and escape analysis across method
   invocations on a stable receiver. A free-standing function doesn't
   get the same treatment — it's compiled once, more conservatively,
   without as much inlining context.

2. **This affects the two kernels asymmetrically.** The float kernel
   benefits *enormously* from class-method optimisation — it has lots
   of small operations the JIT can inline and specialise. The integer
   kernel benefits less because it's already close to its ceiling
   (Math.imul + bit shifts + Smi-tagged integers are all cheap
   regardless of call context). So when you move *both* kernels into
   a class, the float kernel speeds up ~30 %, the integer kernel barely
   moves, and **the relative speedup compresses**.

3. **Result**: a POC comparing `intKernel()` vs `floatKernel()` as
   free-standing functions will overstate the integer kernel's win.
   A real-world bench comparing `transform.transformArrayInt(...)`
   vs `transform.transformArrayFloat(...)` — both methods on the same
   class shape — tells you what users will actually see.

**Rules of thumb for future micro-benches in this codebase:**

- ✅ Put the "before" and "after" kernels in the **same container**
  (both class methods, or both free-standing) before comparing.
- ✅ Prefer benching through the production entry point (e.g.
  `Transform.transformArray()`) once the candidate kernel is wired
  in, not in isolation.
- ✅ Warm up 1000+ iterations before measuring — the JIT takes a
  while to stabilise class-method call sites.
- ✅ Report both the *ratio* and the *absolute* ns/op. A ratio-only
  report hides the case where both kernels got faster but your new
  one got less faster.
- ❌ Don't compare a free-standing candidate against a class-method
  baseline. This is the trap that bit us. Either lift the baseline
  out of the class, or tuck the candidate into it — just make them
  match.
- ❌ Don't trust speedups from single-shot runs. Use median of N
  batches and report the spread.

The `bench/fastLUT_real_world.js` numbers are the "honest" ones:
class-method-to-class-method, warm-up + 5 batch median, same LUT
shapes and dispatch paths users hit. The `bench/int_vs_float*.js` POC
numbers are useful as **"what is this kernel's intrinsic ceiling if
you bypass the engine's tricks"** — handy for evaluating WASM or
SIMD headroom — but they are **not** a prediction of production
throughput.

Keep this section. If you're reading it three years from now
wondering why your new optimisation ran at 2× in a bench and 1.1× in
production, the answer is very probably here.

### Where the 10–15% comes from in production

1. **u16 LUT (4× smaller than Float64) → better L1/L2 cache hit rate.**
   At 33×33×33×4 channels, the float LUT is 1.13 MB; the u16 LUT is
   287 KB. Modern CPUs have ~256 KB L2 per core, so the integer LUT
   *just* fits where the float LUT spills.
2. **`Math.imul` + bit shifts → no heap allocations.** V8 stores small
   integers (Smi) inline in pointers; floats produce HeapNumber boxes
   when they escape registers. Tight integer loops keep everything in
   Smi-land.
3. **Fewer rounding paths.** Float → u8 has to clamp + round; the
   Q0.8 path produces u8 directly via `(acc + 0x80) >> 8`.

---

## 2. What we learned

These are the headline findings from the v1.1 / v1.2 work. The full
walkthroughs — V8 asm dumps, op-count tables, spill classifications,
`.wat` design discussions, bit-exact matrices, reproduction recipes —
live in the [deep-dive](./deepdive/) folder. This section is the
30-second version of each finding, with the key number and a link to
the evidence.

### 2.1 The JS hot path is already close to the x64 ceiling

**What we did.** Verified with V8's `--print-opt-code` that each hot
kernel is actually promoted to TurboFan (not stuck in Ignition /
Sparkplug), emits pure int32 arithmetic (or pure f64 for the float
kernels — never both), and doesn't deopt during real
`transformArray` runs. Then classified the emitted instruction mix
to price every opcode.

**What we found.** All eight hot kernels — four integer, four float —
tier to TurboFan after warmup, stay there, and commit to a numerical
domain at compile time (zero `cvt*` conversion ops in any kernel).
Kernel sizes 4.5–10.8 KB, every one sits inside L1i even on 2008-era
x64. The surprise was how close to the hardware this is:

- The float core-line hot body is **13 XMM double ops** with no
  spills, no boxing, no allocations.
- The int core-line hot body is **14 GPR ops** (`imull` + `leal` +
  `sarl` + one `jo` overflow guard).

Where the remaining cost goes, from instruction-mix analysis:

| Class of instruction | Share | Can we delete it? |
|---|---|---|
| Compute (`imul`, `add`, `sub`, shifts, `mulsd`, `addsd`, ...) | 22–47 % | No — this is the work |
| Data moves — spills to/from `[rbp±N]` stack slots | 36–53 % of moves | Partly (WASM; see §2.3) |
| Bounds checks (`cmp` + `jae` pairs) | 6–8 % | Yes, WASM deletes these |
| Overflow guards (`jo` after speculative int32 math) | 8–9 % | Yes, WASM deletes these (`i32.add` wraps by spec) |

Deletable-by-WASM-on-today's-JS = **~15 %** of every kernel. That's
the "40 %" ceiling the WASM port aimed for (§2.3), and landed.

**→ See [deep-dive / JIT inspection](./deepdive/JitInspection.md)** for
the op-count tables, the core-line x64 walkthrough (both float and int),
the spill classification, and the ARM64 headroom projection.

### 2.2 Named temps at microbench scale — we tested, then declined to refactor

**What we did.** The `PERFORMANCE LESSONS` comment at the top of
`src/Transform.js` has said for years: "don't extract intermediate
locals in hot expressions, we measured a 15-25 % regression". That
comment was written against 2019-era V8. We re-measured on today's
TurboFan with the production core line.

**What we found.** At ~11-live-value microbench scale, named-temps
are actually **+2 % to +6 % *faster*** than the in-place form —
V8's allocator picks a cleaner SSA colouring from the explicit names.
But this is a low-register-pressure scenario. The real kernel
operates at ~14 live values across a 6× tetrahedral × 3-channel × 2
K-plane unroll, right on top of the 11-GPR knee. At full-kernel scale
the 2019 finding almost certainly still holds — the microbench result
is a low-pressure *floor*, not a universal win.

**Decision.** Production source stays in-line-expression. Comment in
`src/Transform.js` stays. If someone wants to re-open the question,
the experimental recipe is in the deep-dive.

**→ See [deep-dive / JIT inspection — "Does 'named temps hurt'?"](./deepdive/JitInspection.md#does-named-temps-hurt--a-micro-test-that-is-not-the-final-word)**
for the side-by-side asm, four-way bench, and the reasoning.

### 2.3 WASM scalar — the predicted 1.4× landed

**What we did.** Hand-wrote a `.wat` port of the 3D tetrahedral
integer kernel (`src/wasm/tetra3d_nch.wat`). Same Q0.16 gps, same u16
CLUT, same `(x + 0x80) >> 8` rounding — line-by-line translation of
the JS. Then benched a 6-config matrix (g1 ∈ {17, 33, 65} × cMax ∈
{3, 4}) against the shipping JS `'int'` kernel, 1 Mi pixels × 500
iters per config. Same exercise for 4D (`tetra4d_nch.wat`).

**What we found.**

| Kernel | Avg vs JS `'int'` | Range | Bit-exact |
|---|---|---|---|
| 3D tetrahedral scalar | **1.40×** | 1.29–1.45× across 6 configs | ✓ 314 M bytes verified |
| 4D tetrahedral scalar | **1.22×** | 1.13–1.49× across 6 configs | ✓ all 6 configs |

The 3D 1.40× lands right at the bottom of the predicted 1.4–1.6×
band from §2.1 — bounds-check + overflow-guard deletion accounts for
almost all of it. The 4D 1.22× is smaller because the JS 4D kernel
was already very tight (v1.1 u20 single-rounding design) and because
a rolled n-channel WASM loop has to stash intermediate channel values
to scratch memory (WASM locals aren't runtime-indexable). That
scratch round-trip is *the* 4D scalar cost; it disappears in 4D SIMD
(§2.5).

Both kernels collapse the JS side's 20+ specialised `*_loop`
functions (one per dimensionality × channel count × int/float ×
alpha-on/off tuple) into **two 1.8–2.5 KB `.wasm` files**. Single
kernel handles cMax ∈ {3, 4, 5, 6, ...} at the same relative speed.

**→ See [deep-dive / WASM kernels — scalar 3D](./deepdive/WasmKernels.md#wasm-scalar-3d--the-first-kernel)**
for the 6-config matrix, alpha-mode handling, and the
dispatch-counter test pattern.
**→ See [deep-dive / WASM kernels — scalar 4D](./deepdive/WasmKernels.md#wasm-scalar-4d--and-the-function-call-lesson)**
for the scratch-region design and the function-call-cost lesson
(see also §3.2 below).

### 2.4 WASM SIMD 3D — channel-parallel was the right axis

**What we did.** The original v1.3 1D POC (preserved in the
"Historical record" under §5) had ruled SIMD out for LUT kernels —
vectorising across pixels needed a per-lane LUT gather, which on x64
pre-AVX2 is four scalar loads in disguise. The POC measured **0.89×**
(slower than scalar). Plan at the time: keep SIMD for matrix-shaper
work only.

Then we noticed the n channels at each CLUT grid corner are stored
**contiguously** in memory — layout `[X][Y][Z][ch]` has `ch` as the
fastest-moving axis. So the 4 tetrahedral anchor reads can each be a
single 64-bit contiguous load (`v128.load64_zero` +
`i32x4.extend_low_i16x8_u`), unpacking directly into 4 i32 lanes. No
gather. Vectorise across *channels*, not across pixels.

**What we found.**

| Kernel | Avg vs JS `'int'` | Range | vs WASM scalar |
|---|---|---|---|
| 3D tetrahedral SIMD | **3.25×** | 2.94–3.50× across 6 configs | 2.37× avg |
| 4D tetrahedral SIMD | **2.39×** | 2.04–2.57× across 6 configs | 1.98× avg |

cMax = 4 lands at a flat 3.50× regardless of LUT size (28.8 KB fits
L1d; 2.1 MB is way past L3). We're at an algorithmic ceiling, not a
cache one. cMax = 3 pays a 14 % lane-waste tax for the unused 4th
lane (one lane of junk interpolation, next pixel's `R` overwrites
it), but still delivers 3.00× flat — dilute by the scalar per-pixel
prologue that doesn't SIMDify.

Post-scalar gap is 2.4×, not the 4× theoretical. Amdahl's law: the
per-pixel grid-index math (boundary patch, X0/Y0/Z0, rx/ry/rz, case
dispatch) stays scalar. If that's ~20 % of the kernel, best SIMD is
1 / (0.2 + 0.8/4) = 2.5× — measured 2.37× agrees within noise.

**→ See [deep-dive / WASM kernels — SIMD 3D](./deepdive/WasmKernels.md#wasm-simd-3d--channel-parallel-was-the-wrong-axis-once)**
for the inverted-axis design, lane-3-don't-care trick, and the
rolling-shutter non-decision (why 3Ch → 3.0× is acceptable).

### 2.5 WASM 4D — hoisted prologue + flag-gated K-plane loop

**What we did.** 4D (CMYK input) kernel needs two 3D interpolations
per pixel, one at each K grid plane, then a K-LERP between them.
Naive design: inline the 3D body twice. That's ~50-60 % more `.wasm`
bytes and duplicates all the C/M/Y-only setup (boundary patch,
X0/Y0/Z0, rx/ry/rz, case dispatch, base offsets) which are identical
across both K planes. Better design: **hoist everything C/M/Y-only
into the outer pixel loop, and run the 3D interp body inside a
flag-gated WASM `loop` so it's emitted exactly once but executes
twice per pixel**.

For SIMD, the additional win is that the K0 u20 intermediate lives in
a single v128 local across the K-plane loop back-edge — all 3-4
channels travel together in one v128 register. No scratch memory
round-trip (which cost 4D scalar half its potential headroom).

**What we found.**

```
  g1  cMax  CLUT         JS    scalar  SIMD    SIMD/JS  SIMD/scalar
  --  ----  --------   -----  -------  -----   -------  -----------
   9    3    38.4 KB    61.3    69.1   124.8   2.04×    1.81×
   9    4    51.3 KB    50.6    59.7   124.5   2.46×    2.08×
  17    3   489.4 KB    48.6    70.5   125.0   2.57×    1.77×
  17    4   652.5 KB    50.2    57.8   128.1   2.55×    2.22×
  33    3  6948.8 KB    59.9    69.4   128.2   2.14×    1.85×
  33    4  9265.0 KB    50.0    59.5   128.0   2.56×    2.15×
```

4D SIMD runs at essentially flat **~125 MPx/s** across LUT sizes
from 38 KB to 9 MB. The L1d → L2 → L3 transitions that hurt the
scalar kernels (9–45 % slowdown past L2) barely register here — SIMD
is doing so much less work per pixel that memory latency is the
bottleneck, and the prefetcher + compact 4-corners-per-pixel access
pattern keep it fed.

The `rk=0` short-circuit (pixel lies on a K grid plane — common for
CMYK regions with K=0 or K=255, solid whites and rich blacks)
survives the SIMD port, exiting the K-plane loop after one iteration
and rounding `(vU20 + 0x800) >> 12` directly to u8.

A u16-output path falls out for free — the final narrow is the only
width-specific step, so skipping it and storing `vU20` gives a u16
output mode. That's the v1.3 hook (§5).

**→ See [deep-dive / WASM kernels — SIMD 4D](./deepdive/WasmKernels.md#wasm-simd-4d--the-k-plane-loop-in-one-v128)**
for the flag-gated loop structure, the i32x4 K-LERP derivation, and
the three design wins that made 4D SIMD actually beat scalar.

### Reproducing every number on this page

All the benches are shipped. Node 20 and a standard install, no extra
deps:

```bash
# Op-count and instruction-mix tables (§2.1)
node --allow-natives-syntax bench/jit_inspection.js

# Full emitted x64 asm dump (~15 MB) + classifier scripts (§2.1)
node --allow-natives-syntax --print-opt-code --code-comments \
     bench/jit_inspection.js 2>&1 > bench/jit_asm_dump.txt
pwsh bench/jit_asm_boundscheck.ps1   # compute / moves / safety mix
pwsh bench/jit_asm_spillcheck.ps1    # spills vs real memory traffic

# Just the core line (§2.1) — fastest path to the asm snippets
node --allow-natives-syntax --print-opt-code --code-comments \
     bench/jit_asm_core_line.js 2>&1 > bench/jit_asm_core_dump.txt

# Throughput through the shipped dispatcher, all four lutModes (§1)
node bench/mpx_summary.js

# WASM 3D scalar matrix — 6 configs × bit-exact vs JS int (§2.3)
node bench/wasm_poc/tetra3d_run.js

# WASM 3D SIMD matrix — 6 configs × bit-exact vs JS + WASM scalar (§2.4)
node bench/wasm_poc/tetra3d_simd_run.js

# WASM 4D scalar matrix — 6 configs × bit-exact (§2.3)
node bench/wasm_poc/tetra4d_nch_run.js

# WASM 4D SIMD matrix — 6 configs × bit-exact (§2.5)
node bench/wasm_poc/tetra4d_simd_run.js

# In-browser comparison vs lcms-wasm (§4) — opens a UI at localhost:8080
node bench/browser/serve.js
```

If your numbers differ meaningfully from the tables above, we want to
know — open an issue with your CPU, OS, Node version, and the raw
bench output attached. The ratios (1.40× scalar, 3.25× SIMD 3D, 2.39×
SIMD 4D) should be stable across x64 microarchitectures; absolute
MPx/s moves with the CPU.

---

## 3. Discoveries in the journey

The things that didn't fit in a planned milestone — the accidents,
false positives, and "wait, that can't be right" moments that shaped
the design and are worth remembering so we don't re-learn them
badly.

### 3.1 lcms-wasm RGB→RGB is a no-op — a benchmarking trap

The first time we wired `lcms-wasm` into the browser bench, sRGB →
sRGB ran at ~**165 MPx/s** on Firefox — more than 2× the CMYK
directions. It looked like lcms was astonishingly fast on
matrix-shaper workloads, comfortably beating our scalar WASM.

It wasn't. lcms2 detects identity transforms at `cmsCreateTransform`
time (same source and destination profile, or profile pair that
cancels) and short-circuits `cmsDoTransform` to `memcpy`. We were
timing `memcpy`.

Swapping the target to AdobeRGB forced a real matrix-shaper
conversion and the number fell to ~**91 MPx/s** in Firefox — right
in line with our own scalar WASM number. Documented in the browser
bench "About" panel, and the fair number (sRGB → AdobeRGB) is what's
in §1's table.

**Lesson for anyone benchmarking a colour engine:** always pair your
RGB-input test with a *different* RGB output profile than the input.
Identity short-circuiting is standard in production CMS
implementations (lcms, macOS ColorSync, Photoshop, Firefox's gfx
stack) — you will hit this in any fair bench. If the speedup looks
suspiciously uniform across directions, that's the shape of the tell.

### 3.2 First WASM 4D ran 25 % slower than JS — V8's inliner refused the helper

Our first 4D scalar build ran at **0.77× JS** — a 25 % regression,
despite being bit-exact and having a tighter per-pixel op count. The
kernel had a 7-site tail-dispatch pattern (cases 0–5 + alpha tail),
each site calling an `$emit_tail` helper function that did the 3-way
split (direct u8 store on `!interpK`, scratch store on K0, K-LERP +
store on K1). We assumed V8 would inline it.

It didn't. The helper had an early `return` inside one of its
conditional arms, and V8's WASM TurboFan inliner is conservative
about multi-exit functions in a branch-stack-inside-a-rolled-loop
caller. Every per-channel iteration paid a full call-frame setup +
teardown: ~5 cycles × 8 calls × pixel count = ~13 ns of pure call
overhead, against a ~60 ns pixel budget.

Inlining the `$emit_tail` body at every call site — 7 copies, ~30 WAT
instructions each — flipped the kernel to **1.22× JS**. The `.wasm`
grew from 1.9 KB to 2.5 KB; peak perf jumped 60 %.

**Lesson that transfers to all WASM work:**
- Never put a `return` inside a helper function you want inlined.
  Rewrite as a conditional expression with a single exit point.
- For hot-loop helpers, inline by hand first, measure, then de-inline
  if size matters. WASM function-call cost is real and much higher
  than the equivalent native C — V8's inliner decisions aren't always
  the ones you'd make.
- V8's WASM module-level compilation still feels like `-O0` relative
  to the JS TurboFan baseline. WASM can't promote runtime-indexed
  data to registers; JS TurboFan can (after enough feedback samples).
  The SIMD path (§2.5) wins most of that gap back by keeping the K0
  intermediate in a single v128 local rather than a scratch region.

**→ See [deep-dive / WASM kernels — function-call cost lesson](./deepdive/WasmKernels.md#the-function-call-cost-lesson-v8-wasm-inliner-was-the-hidden-tax).**

### 3.3 The 1D POC ruled out SIMD for LUTs — POC was vectorising the wrong axis

The v1.3 roadmap originally had WASM SIMD for matrix-shaper
pipelines only and declared LUT kernels scalar-only under WASM. That
decision came from a 1D POC
([`bench/wasm_poc/`](../bench/wasm_poc/), still preserved) that
vectorised *across pixels*: four pixels' LUT lookups packed into one
v128 per lane. The POC measured **0.89×** — slower than scalar —
because each lane needed its own LUT gather, and x64 pre-AVX2 has
no native gather (four scalar loads + `replace_lane` per pixel).
Conclusion at the time: "LUT kernels will run worse under SIMD.
Correct for across-pixel. Wrong for across-channel."

That conclusion was wrong *because the axis was wrong*. The 3D SIMD
win in §2.4 came from vectorising across *channels* instead, using
the contiguous `[ch]` storage at each grid corner to turn four
corner reads into one 64-bit load each. Three months of roadmap
based on "SIMD doesn't work for LUTs" evaporated in one weekend's
POC.

**Lesson:** when a POC says something doesn't work, note *what shape
of working* it ruled out. "SIMD with across-pixel gather is slow" is
the real finding, and it's still true (we verified). "SIMD for LUTs
is slow" is the over-generalisation, and it wasted three months of
planning.

The 1D POC's other three findings (WASM scalar 1.84× on gather-heavy
work, `Math.imul` no longer worth specialising, 67.7× WASM SIMD
ceiling on pure-math non-gather kernels) all still hold and are what
drove the v1.5 pipeline code-generation plan. Full POC findings
preserved in §5's "Historical record: original v1.3 / v1.5 analysis".

**→ See [deep-dive / WASM kernels — SIMD 3D](./deepdive/WasmKernels.md#wasm-simd-3d--channel-parallel-was-the-wrong-axis-once)**
for the detailed inversion story.

### 3.4 WASM SIMD detection false-negative in browsers

An early version of `detectWasmSimd()` in the browser bench returned
`false` in Chrome and Firefox even though both engines fully support
v128. The detection module's bytecode was malformed — it compiled
but didn't actually exercise a SIMD instruction, so V8's "well, it
parses" check passed in Node but the browser's stricter validation
rejected it. Fixed by emitting a minimal but *valid* v128 test
module (load, op, store) that every SIMD-capable host accepts.

Easy fix once spotted, worth flagging for anyone building similar
detection: `WebAssembly.validate()` on a module that *uses no SIMD
opcodes* tells you nothing about SIMD support. The detection module
has to actually contain an `i32x4.add` or equivalent.

### 3.5 u16 CLUT scaled by 65535 vs 65280

The first `lutMode: 'int'` implementation scaled the u16 CLUT to the
full u16 range (0..65535) and divided by 256 in the kernel to
produce u8. That's a systematic +0.4 % high bias at every LUT cell:
`255 / 256 × 65535 / 256 ≠ 255`. On CMYK → RGB specifically, 100 %
of off-by-one errors went the same direction (`int > float`),
producing a consistent ~3 LSB drift on ~1 % of channels where the
float path was already close to a rounding boundary.

Fix was one arithmetic constant: scale by **255 × 256 = 65280** so
`u16 / 256 = u8` exactly. Drift dropped from 3 LSB to ≤ 1 LSB
overnight, and the residual 1 LSB is `Uint8ClampedArray`'s
banker's-rounding (round-half-to-even) disagreeing with the kernel's
round-half-up at `X.5` boundaries — a rounding-mode mismatch at
half-ties, not accumulated math error.

Two more arithmetic constants needed the same "what exactly does
this map to?" check at the same time:
`gridPointsScale_fixed` carried at **Q0.16** (not Q0.8) so the true
`(g1-1)/255` ratio is preserved through the weight extraction, and
the 4D kernels carry intermediates at **u20 Q16.4** so four stacked
rounding steps collapse into one final `>> 20`.

**Lesson:** when an integer math kernel disagrees with its float
reference and the errors are all one-directional, the bug is almost
certainly a rounding-bias or scaling-constant mismatch, not an
algorithmic drift. Check the constants before you check the algorithm.
Took us a release cycle to learn that pattern; write it down.

---

## 4. How does this compare to LittleCMS in C?

### Measured — vs `lcms-wasm` (direct, same-machine)

Before the native-C comparison below, here is a **direct,
measured** head-to-head against the WASM port. The [`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm)
npm package is LittleCMS 2.16 compiled to wasm32 through Emscripten,
maintained by Matt DesLauriers. It is MIT-licensed and we can run it
next to jsColorEngine in the same Node process, same machine, same
profiles, same input bytes, same methodology as `bench/mpx_summary.js`.

Setup for fairness:

- **`cmsFLAGS_HIGHRESPRECALC`** on the lcms side — forces a large
  precalc device-link LUT, matching jsColorEngine's "bake a LUT at
  create time" design. Without this flag lcms2 still auto-precalcs,
  but may pick a smaller grid for some pipelines; with it explicit,
  there's no ambiguity.
- **Pinned WASM heap buffers** — `_malloc` input and output buffers
  once outside the loop and call `_cmsDoTransform` directly, so we
  don't time a `malloc`/`memcpy`/`free` on every iteration. This is
  how an optimised production app would use lcms2.
- Seeded PRNG input bytes (identical on both sides), 65536 pixels
  per iter, warmup 300 iters, median of 5 × 100 iters.

Speed (Node 20.13.1, Win x64, `bench/lcms-comparison/bench.js`):

| Workflow | jsColorEngine `int` | jsColorEngine `float` | lcms-wasm (HIGHRES + pinned) | `int` speedup |
|---|---|---|---|---|
| RGB → Lab    (sRGB → LabD50)   | **65.8 Mpx/s** | 59.9 Mpx/s | 41.9 Mpx/s | **1.57×** |
| RGB → CMYK   (sRGB → GRACoL)   | **55.0 Mpx/s** | 48.3 Mpx/s | 37.2 Mpx/s | **1.48×** |
| CMYK → RGB   (GRACoL → sRGB)   | **51.9 Mpx/s** | 47.9 Mpx/s | 24.5 Mpx/s | **2.12×** |
| CMYK → CMYK  (GRACoL → GRACoL) | **44.3 Mpx/s** | 41.3 Mpx/s | 22.1 Mpx/s | **2.00×** |

Accuracy (9^N grid + named reference colours, `bench/lcms-comparison/accuracy.js`):

| Workflow | exact match | within 1 LSB | within 2 LSB | max Δ | mean Δ |
|---|---|---|---|---|---|
| RGB → Lab   | 98.79 % | **100.00 %** | 100.00 % | 1 LSB  | 0.004 LSB |
| RGB → CMYK  | 93.54 % | **100.00 %** | 100.00 % | 1 LSB  | 0.016 LSB |
| CMYK → RGB  | 83.55 % | 98.51 %      | 99.07 %  | 14 LSB | 0.073 LSB |
| CMYK → CMYK | 59.50 % | 98.83 %      | 99.86 %  | 4 LSB  | 0.141 LSB |

All named reference colours (white, black, primaries, mid-greys, skin
tone, paper white, rich black) match exactly or within 1 LSB on every
workflow.

The **14-LSB max on CMYK → RGB** is an out-of-gamut clipping
disagreement, not a correctness gap. Deep-cyan CMYK values like
`(192,0,64,32)` produce Lab coordinates outside sRGB's gamut and
both engines have to clip — neither answer is "right" since the
target gamut has no representation for the colour.

Our working **hypothesis** for the mechanism (not a source-line diff
of lcms2, just a best-guess architectural model):

- **jsColorEngine** runs the entire pipeline in 64-bit float all the
  way to the final LUT bake. Only **some** intermediate stages clamp
  to their logical domain (e.g. `L` clamped to 0 – 100 in the Lab PCS,
  matrix outputs left un-clipped). Values that swing below 0 in one
  stage and come back positive in the next stay smooth. This is a
  deliberate choice — it preserves information for soft-proofing
  round-trips where the returned value matters more than matching a
  specific reference clipping behaviour.
- **lcms2** appears to clamp more aggressively at several intermediate
  16-bit fixed-point stages inside its precalc LUT builder. Values
  that swing out of range get clamped at that stage and stay clamped.

Tracing lcms's exact clamping points through `cmslut.c`, `cmsintrp.c`,
`cmsopt.c` is future work; the description above is our working model.
A future release may add an opt-in **lcms-compatibility mode** that
clips more aggressively at intermediate stages, for audit workflows
that need bit-exact agreement with a reference lcms pipeline.

The **98.5 %** figure is the meaningful number: 98.5 % of even
extreme-saturated OOG samples still agree to within 1 LSB, all named
reference colours match exactly, and the residual drift is well below
visible threshold for any practical image-processing application.

### Why pure-JS can beat an Emscripten-wasm32 port

At first glance "pure JS beats WASM port of a battle-hardened C library"
sounds wrong, but it follows directly from the JIT inspection data
summarised in §2.1 (full tables in [deep-dive / JIT inspection](./deepdive/JitInspection.md)):

| | lcms-wasm | jsColorEngine |
|---|---|---|
| **Kernel dispatch** | Generic per-pixel format dispatcher (handles every lcms2 pixel layout: interleaved, planar, float, int, 8/16/32-bit, endian, extra channels) | One specialised kernel per LUT shape (3D-3Ch, 3D-4Ch, 4D-3Ch, 4D-4Ch), selected once at array entry |
| **Compile target** | C → Emscripten → wasm32 (general-purpose) | V8 TurboFan, specialised per call-site (int32 pure domain, confirmed by JIT inspection) |
| **SIMD** | None in this build | None (no stable JS SIMD) |
| **Fast Float plugin** | Not included in the WASM build | We are effectively our own Fast Float plugin in JS |
| **FFI boundary** | JS ↔ WASM on every `cmsDoTransform` | None — JS calling JS with typed arrays |
| **Bounds checks** | WASM sandbox bounds-checks every linear-memory load | V8 bounds-checks typed-array loads (~6-8 %, measured in §2.1) |
| **Register pressure** | wasm32 is a register-allocated VM, not true hardware regs | V8 compiles to real x64/ARM64 registers directly; 4D kernels do spill (see [deep-dive / JIT inspection](./deepdive/JitInspection.md)) but stay L1i-resident |

So the comparison is not really "JS vs C" — it is "V8-tuned JS with
one specialised int32 kernel per shape" vs "C-compiled-to-WASM with
runtime format dispatch on every pixel through a sandbox." The first
is essentially custom silicon for the problem; the second is a
general tool running through an extra layer. That framing makes the
measured 1.5–2× gap unsurprising.

**The v1.2 WASM-scalar work was never about catching up** — it was
about **extending the lead** into territory even V8 can't reach
(pointer pinning with no bounds checks, no overflow guards, explicit
register allocation). Measured (§2.3): **1.40×** over today's
`lutMode: 'int'` across the 3D 6-config matrix, right at the bottom
of the predicted 1.4-1.6× band. That puts us past the **measured**
native-scalar lcms2 vanilla numbers in the next subsection (which
have since been confirmed directly rather than estimated). And the
channel-parallel WASM SIMD 3D port — also shipped in v1.2, against
the prediction below that ruled it out — chases the Fast Float +
SIMD band directly: **3.25×** over `'int'` on 3D RGB-input workloads,
landing into lcms2 `fast-float` territory on a single CPU thread.

### Measured — vs native LittleCMS (same hardware, same run)

Native lcms2 measurement, same methodology as the `lcms-wasm`
comparison above (same profiles, same 65k-pixel seeded PRNG input,
same warmup + median-of-5-batches timing loop, same
`INTENT_RELATIVE_COLORIMETRIC`, all `TYPE_*_8`). Harness is
[`bench/lcms_c/`](../bench/lcms_c); any reader can reproduce this
on their own hardware in ~5 minutes from a fresh WSL2 install.

**Reference run** (below) — WSL2 Ubuntu 20.04 on Windows 11,
gcc 10.5.0 with `-O3 -march=native -fno-strict-aliasing -DNDEBUG`,
`taskset -c 0`, Intel x86_64. jsColorEngine / `lcms-wasm` numbers
are from the same host, same session, same 65k pixels —
`node bench/lcms-comparison/bench.js` running against the identical
profile and input generator.

> **Steelmanning lcms2 (measured).** The release flags above match
> lcms2's own autotools build. To verify that wasn't already leaving
> perf on the floor, `bench/lcms_c/Makefile` has a `make steelman`
> target that appends **`-ffast-math -funroll-loops -flto`** on top
> of the release flags — every compiler trick short of PGO. Measured
> on this CPU with the same compiler on both builds, **steelman lifted
> native lcms2 by −2 % to +2 % across the four workflows**. That's
> inside the bench's own run-to-run noise floor. See the
> "Dispatch-bound, not ALU-bound" note after the table for why — the
> steelman row is kept in the comparison as the more conservative
> "best native C" number, so the ratios below credit lcms2 with every
> compiler win it can reach.
>
> To reproduce: `cd bench/lcms_c && make steelman && ./bench_lcms`.
> Flag details: [`bench/lcms_c/README.md`](../bench/lcms_c/README.md#make-steelman--native-lcms2-ceiling).

| Workflow | jsCE `float` | **jsCE `int`** | lcms-wasm (best) | lcms2 native release | **lcms2 native steelman** | jsCE `int` / steelman |
|---|---|---|---|---|---|---|
| RGB → Lab    (sRGB → LabD50)   | 55.4 MPx/s | **64.5 MPx/s** | 39.9 | 62.3 | **61.9** | **1.04× (jsCE wins)** |
| RGB → CMYK   (sRGB → GRACoL)   | 44.2 MPx/s | 54.2 MPx/s     | 40.2 | 59.5 | **58.1** | 0.93× (native +7 %) |
| CMYK → RGB   (GRACoL → sRGB)   | 40.1 MPx/s | **53.2 MPx/s** | 24.6 | 35.6 | **35.7** | **1.49× (jsCE +49 %)** |
| CMYK → CMYK  (GRACoL → GRACoL) | 33.5 MPx/s | **43.6 MPx/s** | 22.0 | 30.5 | **31.2** | **1.40× (jsCE +40 %)** |

_Release = `-O3 -march=native -fno-strict-aliasing -DNDEBUG`; steelman = release + `-ffast-math -funroll-loops -flto`. Both with gcc 10.5.0, same WSL2 session, `taskset -c 0`. Numbers are "best of the two lcms2 flag variants" (`flags=0` vs `HIGHRESPRECALC`)._

**The measurement replaces the earlier "wasm × 1.5–2.5" estimate for
native lcms2.** The estimate was high at the top of the band —
reality is `native ≈ lcms-wasm × 1.4–1.6` on this profile / CPU, not
`× 1.5–2.5`. The most likely reason: modern V8 compiles wasm32 more
tightly than Emscripten's original targets (V8's tier-2 TurboFan
closes more of the native gap than the Emscripten team banked on
when the 1.5-2.5× rule-of-thumb was coined).

**Four things drop out of that table that weren't visible from the
estimate:**

1. **On RGB-input workflows (3D LUT), jsColorEngine `'int'` ≈ native
   lcms2.** RGB → Lab is a near-dead heat (1.04× toward jsCE); RGB
   → CMYK tips 7 % towards native (after steelman). Both engines
   are running specialised 3D tetrahedral kernels and there's not
   much dispatch to shave off. V8 / TurboFan and `gcc -O3
   -march=native` produce comparable machine code for this shape.
2. **On CMYK-input workflows (4D LUT), jsColorEngine `'int'` wins by
   40-49 %.** jsCE's 4D K-LERP runs at u20 Q16.4 with single-step
   rounding inlined into the K-plane computation (see v1.1 changelog
   and § 2.1); lcms2's 4D path uses a general stage-walker that
   dispatches per axis. The specialisation gap opens wider here than
   on 3D because there's more dispatch overhead to skip.
3. **`lcms-wasm` and native lcms2 sit within ~1.5× of each other.**
   A surprising but internally consistent result — lcms2's hot loop
   is dominated by function-pointer dispatch and memory-indirect
   stage walking, not by arithmetic. Neither native x86 nor
   wasm32-compiled-to-x86 gets to vectorise the dispatch. The
   limiting factor for a general-purpose CMS is its own generality,
   not the language it's written in. This has a knock-on for the
   "is JS slow?" question: **JS isn't slow for hot numerical loops
   over typed arrays** — jsColorEngine and native lcms2 differ by
   ~20 % on RGB and by the other sign on CMYK, which is tuning
   variance, not a language-level gap.
4. **Steelman flags give native lcms2 almost nothing.** Measured
   `-ffast-math -funroll-loops -flto` on top of `-O3 -march=native`
   moved the four workflows by −2.4 %, −0.6 %, +0.3 %, +2.3 % —
   inside the bench's run-to-run noise floor. This is the real
   payload of point 3: lcms2's hot loop is **dispatch-bound, not
   ALU-bound**, and compilers only help with the ALU half.
   Reassociation (`-ffast-math`), unrolling (`-funroll-loops`), and
   cross-TU inlining (`-flto`) can't optimise what isn't visible at
   compile time — when the next operation is a `call *%rax`
   resolved from a stage-walker, no flag saves you. Which is why
   **specialising the kernel at LUT-build time** (what jsColorEngine
   does) and **hand-written SIMD for a fixed shape** (what lcms2's
   `fast-float` plugin does) are the only two routes to meaningfully
   faster colour-pipeline throughput, regardless of language. jsCE
   lands on the first route; SIMD via wasm-simd gets us the second
   one for free. `-O3` in a general-purpose CMS is already close to
   the ceiling of what the compiler can find on its own.

**Same hardware, same run, all measured** — full comparison table:

| Engine | MPx/s band (across 4 workflows) | Source |
|---|---|---|
| **jsColorEngine `lutMode: 'int-wasm-simd'`** (v1.2 default) | **~110 – 210 MPx/s** | Measured — § 2.4 / 2.5 |
| **jsColorEngine `lutMode: 'int-wasm-scalar'`** | **~60 – 95 MPx/s** | Measured — § 2.3 |
| **jsColorEngine `lutMode: 'int'`** (pure JS) | **43.6 – 64.5 MPx/s** | Measured — above |
| jsColorEngine `lutMode: 'float'`              | 33.5 – 55.4 MPx/s | Measured — above |
| **lcms2 vanilla (native C, scalar)**           | **31.2 – 61.9 MPx/s** | Measured — above (steelman build; release within ±2 %) |
| lcms-wasm (HIGHRESPRECALC + pinned)           | 22.0 – 40.2 MPx/s | Measured — above |
| lcms2 + `fast-float` plugin (SSE2, **128-bit — same width as ours**) | ≈ 150 – 500 MPx/s | Estimated — vanilla × 3–8 per maintainer (see below) |
| babl (GIMP, AVX2/AVX-512 256/512-bit)         | ≈ 500 – 1500 MPx/s | "up to 10× lcms2" per GIMP release notes — wider SIMD than JS/WASM can reach today |
| lcms2 + multithreaded plugin                  | N × single-thread | Just CPU core scaling, orthogonal |

Ranges are workflow-dependent; all jsCE / lcms-native / lcms-wasm
rows are from the same run, same hardware, same inputs. Re-run on
your hardware via `bench/lcms_c/` + `bench/lcms-comparison/` — the
ratios are stable across CPUs even when the absolute numbers shift.

### What the gap actually is

Three things fall out of the measured table above:

1. **`lutMode: 'int'` wins against native vanilla lcms2 on 3 of 4
   image workflows.** Tied on RGB → Lab (+3 %), behind on
   RGB → CMYK (-10 %), and comfortably ahead on both CMYK-input
   workflows (+41 % / +47 %). On average across the 4 workflows,
   jsCE `int` ≈ native lcms2 × 1.20. **In pure JavaScript, with no
   WebAssembly, on a single CPU thread.** The "old" `lutMode: 'int'`
   path already closes the expected JS-vs-native gap; the newer
   WASM paths open a different kind of gap on top.

2. **`lutMode: 'int-wasm-scalar'` overtakes native vanilla lcms2 on
   every workflow.** Measured 1.40× over `'int'` on the 3D matrix,
   landing at ~85–95 MPx/s on 3D and ~60-70 on 4D — ahead of every
   measured native-lcms2 row. On pure WebAssembly, on a single CPU
   thread, with JavaScript as the outer language.

3. **`lutMode: 'int-wasm-simd'` chases the Fast Float + SIMD
   plugin.** Measured 3.25× over `'int'` on 3D RGB-input workloads,
   landing at ~210 MPx/s — past the vanilla lcms2 band (both
   measured and estimated) and into the lcms2 `fast-float` plugin's
   estimated 150-500 MPx/s range. This was *not* predicted at the
   time the 1D POC was run (see v1.5 Historical record for the
   0.89× across-pixel SIMD result that suggested LUT SIMD wouldn't
   work); it became possible once we inverted the vectorisation
   axis. Importantly, `fast-float` is **SSE2-only (128-bit)**, the
   same SIMD width as wasm v128 — so `int-wasm-simd` vs `fast-float`
   is genuinely apples-to-apples on instruction width. The remaining
   gap to `fast-float`'s upper band is specialisation depth (number
   of hand-rolled kernel variants × tightness of the plugin
   dispatcher) and multi-threading, not SIMD width.

### What is `fast-float`?

`fast-float` is a LittleCMS *plugin* (separate library, MPL2,
[github.com/mm2/Little-CMS/tree/master/plugins/fast_float](https://github.com/mm2/Little-CMS/tree/master/plugins/fast_float))
that replaces the default scalar CLUT interpolation kernels with:

- Hand-written **SSE2 intrinsics (128-bit)** — same SIMD width as
  the `v128` we use in `lutMode: 'int-wasm-simd'`. No AVX2 or
  AVX-512 paths; the plugin targets the widest SIMD that x86_64
  guarantees out-of-the-box, exactly like wasm SIMD targets the
  widest width that's portable across engines.
- Specialised kernels per (input channels, output channels, bit depth)
  combination — dozens of separate optimised functions
- Tighter loop unrolling
- Float math throughout (lcms2 core uses fixed-point Q15.16; the
  plugin name refers to this, not to SIMD width)

It's the same architectural answer we'd reach with WASM SIMD — many
narrowly-specialised hot kernels behind a dispatcher.

### A note on SIMD width ceilings — JS/WASM vs native C

SIMD width questions come up every time we publish these numbers
("but couldn't native C go wider with AVX?"). Honest answer:

| SIMD width | Native C | WASM | JS | Who uses it |
|---|---|---|---|---|
| **128-bit** (SSE2, NEON, wasm v128) | ✅ baseline on x86_64 / arm64 | ✅ shipping in all major engines since ~2021 | ✅ via wasm v128 | lcms2 `fast-float`, ffmpeg fallback, pillow, **jsColorEngine `int-wasm-simd`** |
| **256-bit** (AVX, AVX2) | ✅ gcc `-mavx2`, hardware since ~2013 | ❌ not in wasm SIMD spec | ❌ | `pillow-simd`, `libvips`, some `babl` kernels |
| **512-bit** (AVX-512) | ✅ gcc `-mavx512f`, Intel + Zen4+ | ❌ | ❌ | Intel IPP, hand-tuned HPC kernels |

Three things worth flagging:

1. **SSE2, AVX, AVX2, AVX-512 are all free** — they're CPU
   instruction-set extensions, not licensed products. Any mainline
   gcc/clang supports them for free (`-mavx2`, `-mavx512f`, etc),
   and `-march=native` auto-selects the widest one available on the
   host. The steelman build already enabled whatever your CPU
   supports.
2. **But the *realistic* native-C baseline is also 128-bit.** The
   standard "go faster" option for LittleCMS in the C ecosystem is
   its own `fast-float` plugin — and that's **SSE2 only**. No
   distro-shipped CMS library reaches for AVX2 or AVX-512 by
   default, because targeting a CPU feature that ~15 % of installed
   machines don't have breaks packaging and fallback paths. So when
   we compare `int-wasm-simd` against `fast-float`, both sides are
   running 128-bit SIMD — **genuinely apples-to-apples on
   instruction width**. The performance delta, if any, is about
   kernel specialisation depth and dispatcher overhead, not width.
3. **WASM SIMD is 128-bit by spec.** There's no 256-bit or 512-bit
   SIMD in WebAssembly today. The `flexible-vectors` proposal would
   eventually let wasm code pick wider widths at runtime, but it's
   not implemented in any shipping engine as of this writing.
   When it ships, we'd expect roughly 1.8–2.0× from widening the
   existing SIMD kernels (memory bandwidth and load-ports cap the
   speedup below the theoretical 2× / 4×). That's a **post-v1.5**
   question (waiting on browser engines to ship the proposal) — see
   [Roadmap.md](./Roadmap.md).

So: the "faster than native C lcms2" claim doesn't assume we're
competing against a hypothetical AVX-512-tuned colour library that
no one ships. It's against the versions of lcms2 people actually
install — `-O3 -march=native` vanilla, and `fast-float` with
SSE2 — both of which top out at the same SIMD width we do. Everything
above that (babl, pillow-simd, Intel IPP) is a different library
with a different purpose, **and is also on our honest-comparison
table** as something we don't claim to beat without wasm SIMD
widening first.

### Lessons we picked up from reading `lcms2/src/cmsintrp.c`

After reading the source we confirmed our approach is sound:

| lcms2 technique | Applicable to us? |
|---|---|
| **Q15.16 fixed-point** instead of float | We use Q0.8 → faster but less precise. Their precision matters for u16 output; for u8 we don't need it. |
| **Symmetric subtraction in 6 tetrahedral cases** | We already do this — same code shape. |
| **Pointer pre-advancement** outside the loop body | V8 pointer arithmetic doesn't work the same way; we achieve the equivalent via base-index math, which V8 strength-reduces equivalently. |
| **u16 rounding trick** (`+ 0x8000` before `>> 16`) | We do the equivalent for u8 (`+ 0x80 >> 8`). Same pattern. |
| **Skipping safety checks in the inner loop** | We already do this — the `transformArrayViaLUT` dispatcher validates upstream once, the kernel trusts inputs. |
| **Specialised kernel per shape** | We already do this (3Ch / 4Ch / NCh, float and int variants). |

**The big surprise:** the lcms2 maintainer
([discussion](https://github.com/mm2/Little-CMS/issues)) explicitly
says they **don't** hand-unroll most loops because GCC/Clang inline
and unroll better than humans. That is not true for V8 — V8 does
unroll, but conservatively, and it gives up on functions over a size
threshold. So our manual unrolling **is** load-bearing in JS in a way
it wouldn't be in C.

---

## 5. What shipped in v1.1, v1.2 and v1.3

> Forward-looking plans (v1.4 onward) live in
> [Roadmap.md](./Roadmap.md) — single source of truth for what's
> coming next. This section covers what already landed in v1.1, v1.2
> and v1.3 and the measurement / design notes that go with it.

### v1.1 — 4D integer kernels (CMYK input) + u20 refactor  ✅ SHIPPED

Both 4D integer kernels are now in `src/Transform.js` and routed via the
`lutMode === 'int'` dispatcher branch:

- `tetrahedralInterp4DArray_3Ch_intLut_loop` (CMYK → RGB / Lab)
- `tetrahedralInterp4DArray_4Ch_intLut_loop` (CMYK → CMYK)
- `buildIntLut()` extended to handle 4D LUT shapes (computes `maxK`
  for the K-axis boundary patch)
- Jest tests in `__tests__/transform_lutMode.tests.js`

Both 4D kernels use a **u20 Q16.4 single-rounding design**. Instead of
four stacked `>> 8` rounding steps (K0 plane → K1 plane → K-LERP →
final u8), intermediate interpolated values are carried at u20
precision (u16 × 16 = 4 extra fractional bits) and collapsed to u8 in
a single final `>> 20`. The inner `>> 4` step is negligible (~1/4096
of a u8 LSB).

Why u20 specifically: the K-LERP `Math.imul(K1_u20 - o0_u20, rk)` has
to fit in signed int32. At u20 the worst case is ≈ 2^28, leaving
comfortable headroom below 2^31. Wider (u22+) overflows on the
multiply.

Real-world numbers (table at top of this doc): 1.09–1.19× speedup,
**better than 3D**. The float K-LERP does more redundant rounding
work, so the integer version saves more there; on top of that the u20
refactor trims the kernel's own instruction count as well.

Accuracy impact on the measured GRACoL2006 profile (after u20 refactor
+ the u16 CLUT scale + Q0.16 `gridPointsScale_fixed` fixes that also
landed in v1.1):

- CMYK → CMYK: **99.74 % bit-exact, max 1 LSB** (was ~55 % exact,
  3 LSB pre-refactor)
- CMYK → RGB:  **99.63 % bit-exact, max 1 LSB** (was ~26 % exact,
  3 LSB on ~1 % of channels pre-refactor)

Three bugs squashed at once:

1. The pre-existing degenerate-path rounding-bias bug (`+0x80` where
   `+0x8000` was needed for `>> 16`).
2. u16 CLUT scaled by 65535, giving a systematic +0.4 % high bias
   when divided by 256 in the kernel (100 % of off-by-1 errors went
   `int > float`). Fix: scale by 65280 = 255 × 256.
3. `gridPointsScale_fixed` carried at Q0.8, which truncates the true
   `(g1-1)/255` ratio. On monotonically-decreasing CMY axes this was
   a second source of `int > float` bias. Fix: carry at Q0.16, extract
   `rx` via `(px >>> 8) & 0xFF`.

### Design constraint — float OR u16 only

Going forward, all LUT representations are either `Float64Array`
(float kernels) or `Uint16Array` (integer + future WASM / GPU
backends). We explicitly don't support intermediate widths like u15,
because every new backend would need to understand the same
representation. u16 (scaled at 255 × 256) is the contract.

The integer hot path is exposed through a string-enum option,
`lutMode`, rather than a boolean. The enum was chosen specifically
so future kernels could be added through the same option without
breaking the call signature — v1.1 shipped `'int'`, v1.2 added
`'int-wasm-scalar'`, `'int-wasm-simd'`, and `'auto'` (the new
default), all through the same option. Unknown enum values
auto-resolve (v1.2+) to the best applicable kernel for the
Transform's `(dataFormat, buildLut)` combination, so code written
against a future release can't crash on the current one — it just
runs whichever of today's kernels fits best.

> **Roadmap update, Apr 2026.** The WASM scalar + SIMD 3D work arrived
> earlier and faster than this roadmap originally predicted, so the
> remaining stages have been re-planned. Headline change: v1.2 now
> covers **all** WASM LUT work (was split across v1.2-v1.4), pulling
> `'auto'` mode up. 16-bit (originally v1.4) shipped as v1.3.
>
> **Second reframe, late Apr 2026 (post-v1.3).** With the v1.3 kernel
> ladder banked and a real performance story to show, **v1.4 was
> swapped to ImageHelper + browser samples** (showcase release on
> the back of the v1.3 numbers). The compiled non-LUT pipeline +
> `toModule()` work, plus N-channel float input kernels and the
> `lutGridSize` accuracy lever, are all bundled into v1.5 — the
> larger piece of post-v1.3 work, slotted after the showcase release
> so the project keeps shipping visible progress even if v1.5 takes
> a while. v1.6 is the optional S15.16 internal-pipeline placeholder
> for lcms parity, deferred unless demanded. The v2 package-split
> target is unchanged.
>
> The historical sections below (v1.3 original 1D POC analysis and
> v1.5 original matrix-shaper-only plan) are preserved because their
> findings still drive design — especially the 67.7× SIMD-ceiling
> number that anchors the v1.5 compiled-pipeline targets.

### v1.2 — WASM LUT kernels (3D + 4D, scalar + SIMD) and `lutMode: 'auto'`

One release that consolidates every integer-LUT WASM kernel and
exposes an auto-picker. Status at time of writing:

| Sub-task | Status |
|---|---|
| `src/wasm/tetra3d_nch.wat` — 3D n-channel scalar kernel, cMax ∈ {3, 4, 5+}, 4-mode alpha | ✅ shipped |
| `src/wasm/tetra3d_simd.wat` — 3D channel-parallel SIMD kernel, cMax ∈ {3, 4}, 4-mode alpha | ✅ shipped |
| `lutMode: 'int-wasm-scalar'` dispatcher + `wasmCache` + dispatch-counter tests | ✅ shipped |
| `lutMode: 'int-wasm-simd'` dispatcher + SIMD→scalar→int demotion chain + dispatch-counter tests | ✅ shipped |
| Measured 3D matrix: 6 configs × {JS-int, WASM-scalar, WASM-SIMD}, all bit-exact, 1.40× / 3.25× over int | ✅ shipped |
| `src/wasm/tetra4d_nch.wat` — 4D scalar (CMYK input), cMax ∈ {3, 4, 5+}, same 4-mode alpha, hoisted-prologue + flag-gated K-plane loop, 1.22× over JS `int` (see [deep-dive / WASM kernels — scalar 4D](./deepdive/WasmKernels.md#wasm-scalar-4d--and-the-function-call-lesson)) | ✅ shipped |
| `lutMode: 'int-wasm-scalar'` 4D dispatcher for inputChannels=4 + Jest suite + 4-mode alpha coverage | ✅ shipped |
| `src/wasm/tetra4d_simd.wat` — 4D channel-parallel SIMD kernel, cMax ∈ {3, 4}, hoisted-prologue + flag-gated K-plane loop + u20 K-LERP, K0 in v128 register (no scratch), 2.39× over JS `int` / 1.98× over WASM scalar 4D (see [deep-dive / WASM kernels — SIMD 4D](./deepdive/WasmKernels.md#wasm-simd-4d--the-k-plane-loop-in-one-v128)) | ✅ shipped |
| `lutMode: 'int-wasm-simd'` 4D SIMD dispatcher for inputChannels=4 + Jest suite + 4-mode alpha coverage | ✅ shipped |
| Measured 4D matrix: 6 configs × {JS-int, WASM-scalar, WASM-SIMD}, all bit-exact, 1.22× / 2.39× over int | ✅ shipped |
| `lutMode: 'auto'` — new default, heuristic picks best kernel at construction time | ✅ shipped |
| 4K-target bench run through the final dispatcher, measured vs lcms-wasm + native vanilla | TBC |

**`'auto'` as the new default.** Rather than picking per-LUT-shape
at `create()` time with a big dispatcher, the shipped v1.2 `'auto'`
uses a simpler heuristic at construction time:

```
// new Transform({...}).lutMode resolution
if (dataFormat === 'int8' && buildLut === true):
    lutMode = 'int-wasm-simd'     // demotion chain kicks in at create()
                                  // for hosts without SIMD / WASM
else:
    lutMode = 'float'             // lutMode is ignored for non-int8
                                  // anyway; resolving to 'float' makes
                                  // xform.lutMode self-documenting
```

The demotion chain at `create()` time handles everything else:
`'int-wasm-simd'` → `'int-wasm-scalar'` (no SIMD) → `'int'` (no WASM).
No runtime cost per call. The string-enum API is already
forward-compatible — a user who wrote `lutMode: 'auto'` against
pre-v1.2 would have fallen through to `'float'`; once v1.2 lands the
same call site opts into the best available kernel for their runtime.
The unknown-mode fallback in v1.2+ routes through the same
auto-resolution, so code written against a future version that adds
a new `lutMode` value never crashes — it auto-resolves to the best
applicable existing kernel.

Per-Transform microbenchmarking (a true "measure every kernel once,
pick the fastest" dispatcher) is a v1.5 item — see §5 below. In
practice `'int' > 'int-wasm-scalar'` shows up on weaker CPUs for
small 3D LUTs, and a one-shot microbench at `create()` would let
`'auto'` make that call — but it's not worth the complexity until
we have the profiling data to prove it's worth a ≥ 5 ms cold-start
hit.

**4D SIMD — landed on the projection.** The measured 4D SIMD
kernel lives at `src/wasm/tetra4d_simd.wat` / 1.6 KB `.wasm` and
averages **2.39× over JS `int`** across the 6-config matrix
(2.04–2.57× range), **1.98× over WASM scalar 4D** (1.77–2.22×).
Flat ~125 MPx/s across LUT sizes from 38 KB to 9 MB — the curve
that showed cache-boundary wobble on the scalar kernels is essentially
gone at SIMD speeds. Bit-exact against both the scalar WASM 4D
kernel and the JS 4D int kernels on all configs on first compile.

Design recap (full breakdown with pseudo-code and measurements in
[deep-dive / WASM kernels — SIMD 4D](./deepdive/WasmKernels.md#wasm-simd-4d--the-k-plane-loop-in-one-v128)):

1. **Hoist all C/M/Y-only setup into the outer 4D pixel loop.**
   Compute `X0/Y0/Z0`, `rx/ry/rz`, plus `K0/rk/interpK` once per
   pixel. Splat weights to four v128 locals.
2. **Run the 3D interp body inside a flag-gated WASM `loop`** —
   emitted once in `.wasm`, iterates once (when `rk==0`) or
   twice (when `interpK`) per pixel. Body: recompute base0..4
   from XYZ + K0, four `v128.load64_zero + extend` corner loads,
   the sub-mul-add SIMD ops, then `vU20 = (vC << 4) + ((vSum +
   0x08) >> 4)`. At end of iter 1 with `interpK`: stash
   `vU20_K0 = vU20`, `K0 += goK`, `br` back to loop start.
3. **K-LERP once at u20 precision.** `((vU20_K0 << 8) + (vU20 -
   vU20_K0) * vRk + 0x80000) >> 20` with saturating narrow to u8.
   `(u20_K1 - u20_K0) * rk` fits signed i32 (max ~2²⁸), so the
   entire K-LERP runs in a single `i32x4.mul` — no widening to i64.

The architectural win over scalar 4D is that **the K0 u20
intermediate lives in a single v128 local** across the K-plane
loop back-edge. All 3–4 channels travel together in one register —
no `$scratchPtr` i32.store/i32.load round-trip per channel that
capped the scalar 4D win at 1.22×. The SIMD `.wasm` is 37 %
smaller than scalar 4D (1.6 KB vs 2.5 KB) mostly because there's
no rolled channel loop + 7 per-channel tail-dispatch sites.

The `rk=0` short-circuit (pixel lies on a K grid plane, common
for solid-K CMYK regions) is preserved — when `interpK` is 0
the K-plane loop exits after one pass and the tail rounds
`(vU20 + 0x800) >> 12` directly to u8, matching both the JS and
scalar WASM 4D kernels.

A u16-output path falls out for free — the final narrow is the
only piece that's width-specific; skipping it and storing vU20
gives a u16 output mode. That's the v1.3 hook.

**Remaining work items**

- ~~4D scalar `.wat` port.~~ **Shipped** — measured 1.22× avg
  over JS `int` (1.13× min, 1.49× max), bit-exact across all 6
  configs. See [deep-dive / WASM kernels — scalar 4D](./deepdive/WasmKernels.md#wasm-scalar-4d--and-the-function-call-lesson)
  for the bench run and the function-call-inlining lesson that
  unblocked it (also summarised in §3.2 above).
- ~~4D SIMD `.wat` port.~~ **Shipped** — measured 2.39× avg over
  JS `int` (2.04× min, 2.57× max), 1.98× avg over WASM scalar 4D,
  bit-exact across all 6 configs on first compile. See [deep-dive
  / WASM kernels — SIMD 4D](./deepdive/WasmKernels.md#wasm-simd-4d--the-k-plane-loop-in-one-v128)
  for the bench run; the design note for the K0-in-v128-register
  approach is in the subsection above.
- `lutMode: 'auto'` — dispatcher + tests + docs + "why we recommend
  auto" paragraph.
- Extend the 6-config 3D bench to a 12-config matrix that includes
  the 4D scalar + 4D SIMD runs, published as a single table in
  [deep-dive / WASM kernels](./deepdive/WasmKernels.md).
- ~~Flip the `test.failing` tripwires in both WASM test suites once
  4D routes through WASM~~ — **done** for both `int-wasm-scalar`
  (when the 4D scalar dispatcher shipped) and `int-wasm-simd`
  (when the 4D SIMD dispatcher shipped); both suites now assert
  the 4D WASM path is actually hit.

At the end of v1.2 we should have one table that says: "every LUT
shape jsColorEngine supports runs through a SIMD or scalar WASM
kernel, bit-exact against the JS int sibling, auto-selected per
Transform, with a measured 2-3.5× over JS int across the 12-config
matrix." Of the 12 matrix cells, all 12 are now shipped; the only
remaining work is the `'auto'` dispatcher + bench aggregation.

### v1.3 — 16-bit kernel ladder ✅ SHIPPED

v1.3 closed the 16-bit input/output gap that had quietly
round-tripped through u8 ever since the v1.1 LUT path landed.
Same kernel shape as v1.1 (tetrahedral, channel-parallel for SIMD,
hoisted prologue + flag-gated K-plane loop for 4D), retuned for
u16 I/O and re-derived for an arithmetic envelope that keeps
JS ↔ WASM bit-exact across browsers and operating systems with no
runtime checks.

**The kernel ladder shipped in three siblings, all bit-exact:**

- **`lutMode: 'int16'`** — pure-JS u16 kernel. `Uint16Array` CLUT
  scaled to the full [0..0xFFFF] range with **Q0.13 fractional
  weights**. The 4D path uses two-rounding K-LERP (rounded once at
  K0/K1 and again at the final blend) so every intermediate stays
  inside the i32 envelope without an i64 detour.
- **`lutMode: 'int16-wasm-scalar'`** — same Q0.13 contract compiled
  to hand-written `.wat`. Bit-exact against the JS sibling on the
  whole 6-config matrix (0 LSB, every cell). ~1.3–1.4× over JS
  `int16` on 3D, ~1.0–1.2× on 4D.
- **`lutMode: 'int16-wasm-simd'`** — channel-parallel `v128`,
  Q0.13, two-rounding K-LERP for 4D. The K0 intermediate lives in
  a single `v128` local across the K-plane loop back-edge, so all
  3–4 channels travel together in one register — same architectural
  win the v1.2 SIMD 4D kernel got over scalar 4D, ported to u16.
  Bit-exact against both u16 siblings.

**Headless bench (Node 20 / V8, 65 K pixels/iter, GRACoL2006 +
sRGB, `bench/int16_poc/bench_int16_simd_vs_scalar.js`):**

| Workflow                       | jsCE `int16` | `int16-wasm-scalar` | **`int16-wasm-simd`** | lcms-wasm best | SIMD vs scalar | SIMD vs lcms |
|--------------------------------|-------------:|--------------------:|----------------------:|---------------:|---------------:|-------------:|
| RGB → Lab    (sRGB → LabD50)   | 67 MPx/s     | 124 MPx/s           | **209 MPx/s**         | 53 MPx/s       | 1.68×          | 3.93×        |
| RGB → CMYK   (sRGB → GRACoL)   | 64           | 117                 | **191**               | 47             | 1.63×          | 4.06×        |
| CMYK → RGB   (GRACoL → LabD50) | 50           | 56                  | **129**               | 26             | 2.30×          | 4.89×        |
| CMYK → CMYK  (GRACoL → GRACoL) | 41           | 49                  | **117**               | 24             | 2.40×          | 4.84×        |

The browser numbers (Chrome 147, x86_64, [`bench/browser/`](./Bench.md))
land in the same band — see the roadmap retrospective for the
side-by-side jsCE / lcms-wasm / lcms-wasm-16 table. The point is
the same in either harness: the SIMD u16 kernel wins on every
workflow against every comparison row, with bit-exactness against
its slower siblings, and a ~4× lift over the closest `lcms-wasm`
16-bit configuration.

**Two design choices deserve callouts.**

1. **Q0.13 weights, not Q0.16.** The standard fixed-point precision
   for u16 LUT kernels is Q0.16 (lcms uses this). We picked Q0.13
   because at Q0.16 the inner-loop accumulator
   `delta × weight × 3 axes` exceeds the i32 envelope for an
   adversarial CLUT (max u16 × u16 = 2³², three-axis sum overflows
   signed i32). lcms handles this with i64 (slower) or
   `CMS_NO_SANITIZE` ("trust the profile"); we picked the option
   that runs as i32 throughout with no runtime guards and stays
   defined on every platform's integer wrapping spec. Q0.13 is the
   widest precision that fits — and the
   [accuracy bench](./deepdive/Accuracy.md#16-bit-kernel-accuracy-v13--near-perfect-no-corners-cut)
   confirms the kernel is rounding-bounded long before it's
   weight-bounded, so the lost three bits of weight precision are
   academic. Worst case is **4 LSB at u16** (0.006 % of u16 range),
   mean ≤ 0.0008 %. Round any of these outputs to u8 and the int16
   path is bit-identical to the float path.
2. **Two-rounding for 4D, not single-step.** The 4D K-LERP at full
   u16 precision overflows i32 in a single `(K1 - K0) * rk` step.
   The v1.2 u8 kernel got around this by carrying the intermediate
   at u20 Q16.4 and rounding once at the very end (single-step).
   That trick doesn't work at u16 output because the intermediate
   would have to be u24, which overflows the multiply. Solution:
   round at u16 inside the K0/K1 plane interp, then linear-
   interpolate the two u16 plane outputs along K with a separate
   round. The cost is a fraction of an LSB of accumulated rounding
   noise; the benefit is the entire kernel runs as i32 with no
   widening. The SIMD variant gets this for free because the
   intermediate sits in a `v128` local (no scratch memory round-trip
   that the scalar variant needs).

**Three accuracy gates ship with the kernels** — none is optional;
all three pass at every release of the engine:

- [`bench/int16_identity.js`](../bench/int16_identity.js) — synthetic
  identity-CLUT round-trip. Asserts every kernel rounds at the u16
  LSB and never wider. Exits non-zero on failure; safe to wire into
  CI or a pre-commit hook.
- [`bench/int16_poc/accuracy_v1_7_self.js`](../bench/int16_poc/accuracy_v1_7_self.js)
  — jsCE float-LUT vs jsCE int16-LUT, same source profile, kernel
  is the only variable. **Pure kernel quantisation noise** measured
  in u16 LSB. Headline numbers in
  [Accuracy.md § 16-bit kernel accuracy](./deepdive/Accuracy.md#16-bit-kernel-accuracy-v13--near-perfect-no-corners-cut).
- [`bench/lcms_compat/run.js`](../bench/lcms_compat/run.js) — jsCE
  float pipeline vs lcms2 2.16 float pipeline across a 130-file
  reference oracle. Confirms the math underneath the kernels is
  correct (any int16 quantisation lands on top of an already-correct
  float baseline, not on top of a divergence).

The dispatcher behind all this is
[`src/lutKernelTable.js`](../src/lutKernelTable.js), which resolves
`(lutMode, inCh, outCh)` against a pure-data table with per-entry
gates and an explicit fallback chain. Adding a kernel is a row
in a table, not another `else if` in `transformArrayViaLUT`. The
WASM-state caching that the v1.2 kernels used (single shared
`wasmCache` across Transforms) extends directly to the new u16
states — `wasmTetra3DInt16` / `wasmTetra4DInt16` / their SIMD
siblings, all loaded lazily, all idempotent across Transforms
sharing the same cache.

What v1.3 deliberately *doesn't* ship:

- **N-channel input kernels (5 / 6 / 7 / 8-ch input device profiles).**
  Slated for v1.5 on the float path only — see Roadmap. There's no
  fast-path workload that exercises N-channel inputs.
- **`lutGridSize` option.** Bumped to v1.5 alongside the larger
  compiled-pipeline work. Independent of the kernel ladder, lands
  cleanly on top.
- **`lcms_patch/` extraction.** The patched `transicc.exe` is
  vendored in the repo and the harness works against it; the open
  piece is shipping it as a regen-able diff against stock lcms 2.16.

### v1.4 and beyond — see [Roadmap.md](./Roadmap.md)

Forward-looking plans (v1.4 ImageHelper + browser samples
[showcase release on the back of v1.3], v1.5 N-channel float
inputs + `lutGridSize` + non-LUT code generation + `toModule()`,
v1.6 optional S15.16 lcms parity, v2 package split) are the
single source of truth in [Roadmap.md](./Roadmap.md). This page
stays retrospective — what shipped, what we measured, what we
learned while doing it. The "historical record" subsection below
is the one exception: its numbers still inform current kernel
design, and the 67.7 × ceiling is the baseline for v1.5 code-
generation targets, so it's cross-posted in both places.

### Historical record: original v1.3 / v1.5 analysis (1D WASM POC)

The two analyses below drove the original v1.3 / v1.5 split. Both
have since been superseded — v1.3 (WASM scalar) landed in v1.2,
and v1.5's matrix-shaper-only plan was subsumed by the v1.5 code-
generation target. The numbers and findings are preserved because
they still inform design decisions (especially the SIMD ceiling
number for v1.5 emission, and the "LUT gather ≠ vectorise across
pixels" rule that's easy to forget).

**Where the WASM scalar win actually came from** (1D POC, v1.3
analysis): our JS integer kernels are ~37 % data moves, ~20 %
safety machinery (including ~8 % `jo` overflow guards we don't
need and ~7 % bounds-check pairs), and only 25-47 % arithmetic.
WASM removes both classes of safety machinery for free — `i32`
math wraps by spec (no `jo` needed) and linear memory uses guard
pages for bounds safety (no `cmp`/`jae` pairs needed). Prediction
was 1.4-1.6× over `'int'`; measured 1.40× on the production 3D
tetrahedral kernel (§2.3).

**Original 1D POC results (Node 20, 1 Mi pixels per pass):**

| Kernel | MPx/s | vs JS plain |
|---|---|---|
| JS plain | 372 | 1.00× |
| JS `Math.imul` | 376 | 1.01× |
| **WASM scalar** | **684** | **1.84×** |
| WASM SIMD (with LUT gather) | 606 | 1.63× |
| WASM SIMD (no LUT, pure math) | 25 180 | **67.7×** |

All four kernels were bit-exact against each other across 1 Mi
pixels. See `bench/wasm_poc/README.md` for the full analysis.

**Four findings that still drive the roadmap:**

1. **WASM scalar beats JS by 1.84×** for gather-heavy kernels. V8
   is excellent at integer JS, but WASM wins via no bounds checks,
   no de-opt risk, and tighter machine code. Drove v1.3 → now
   shipped as `'int-wasm-scalar'`.
2. **WASM SIMD with across-pixel LUT gather is *slower* than WASM
   scalar** (0.89×). WASM SIMD has no native gather instruction;
   each lane lookup is a scalar `i32.load16_u` + `replace_lane`
   round-trip. Original conclusion: "3D/4D LUT kernels will
   perform worse under SIMD." **Correct for across-pixel; wrong
   for across-channel** — see §2.4 and [deep-dive / WASM kernels —
   SIMD 3D](./deepdive/WasmKernels.md#wasm-simd-3d--channel-parallel-was-the-wrong-axis-once)
   for the inversion that hit 3.25×. The "we ruled SIMD out for
   LUTs" story is §3.3.
3. **WASM SIMD pure math IS 67.7× faster** on no-gather math.
   This is the ceiling for emitted non-LUT pipelines — drives
   v1.5 code-generation target. Matrix-shaper, gamma polynomial,
   RGB↔YUV, channel reordering all live here.
4. **`Math.imul` is no longer worth using as a perf optimisation**
   in modern V8. Still useful as insurance against accidental
   float promotion, but plain `*` produces identical machine code.

---

## 6. What's not on the roadmap

Full "explicitly not doing" list (GPU shaders, Lab-input integer
kernels, Web Workers, profile-decode optimisation, asm.js /
SharedArrayBuffer-only paths) lives in
[Roadmap.md § What we are explicitly NOT doing](./Roadmap.md#what-we-are-explicitly-not-doing).

---

## 7. Choosing a configuration

Two lenses for picking a mode — the **tier table** (what's each
mode actually for?) and the **scenario quick reference** (I have
workload X, what do I pass?).

### The four tiers — accuracy vs speed

jsColorEngine spans four operating points, each with a distinct
accuracy / speed / memory profile. Pick by use case:

| Tier | Mode (options) | Best for | Numeric precision | LUT grid | Per-pixel cost | Status |
|---|---|---|---|---|---|---|
| **1. Accuracy** | `buildLut: false` | Research, measurement, ΔE validation, single colours | f64 (JS double), full pipeline evaluated per pixel | n/a (no LUT) | Highest — every stage, every pixel | Shipped v1.0 |
| **2. Balanced** | `buildLut: true, lutMode: 'float'` (or `'auto'` on non-int8 inputs) | High-accuracy batch transforms, measurement against target | f64 CLUT, specialised JS kernel per channel count | 17³–65³ (tunable, see below) | Mid — tetrahedral interp + weight eval | Shipped v1.0 (grid override: v1.3) |
| **3. 16-bit image** | `buildLut: true, dataFormat: 'int16'` | Lab workflows, 16-bit TIFF, ICC v4 PCS native, prepress, HDR | Q0.16 fixed-point on the same u16 CLUT cells real ICC profiles store (1 LSB ≈ 1.5e-5 — ~0.007 ΔE76 worst case in Lab) | 17³–33³ | Low — JS/WASM u16 kernel | JS shipped v1.3; WASM u16 SIMD pending |
| **4. 8-bit image** | `buildLut: true, dataFormat: 'int8'` (current default via `'auto'`) | Photo, web, canvas, 8-bit image pipelines | Q0.8 via u16 CLUT (≤ 1 LSB drift @ 8-bit — visually invisible) | 17³–33³ | Lowest — 4-lane WASM SIMD on 8-bit lanes | Shipped v1.2 |

**How to read the table.** Tiers 1–2 are the *accuracy family*
(f64 throughout). Tiers 3–4 are the *image family* (native
bit-depth in, native bit-depth out, LUT grade speed). The default
`'auto'` picks tier 4 when it detects `int8 + buildLut: true`, and
tier 2 otherwise — so naïve users get image-grade speed on image
data and full accuracy on everything else.

**Tunable grid size (v1.3).** Tier 2 and 3 support overriding the
profile's native `clutPoints` (typically 17) at LUT build time
via a `lutGridSize` option. 33³ costs 143 KB at f64, 65³ costs
1.1 MB — both stay in L2 on desktop chips. Pure accuracy win for
anyone willing to pay the memory. 4D LUTs (CMYK input) realistically
cap at 17–25; 33⁴ breaks cache.

**Why four and not five?** An earlier draft had a "float image"
tier 3 (`dataFormat: 'f32'`, `lutMode: 'float-wasm-simd'`) sitting
between the f64 accuracy family and the integer image family.
That tier is **dropped** post v1.3-int16 measurement: every
shipping ICC v2/v4 profile stores its CLUT cells as u16, so an
f32 kernel against u16 cells doesn't unlock a meaningful precision
tier above the int16 path — the cells set the ceiling, not the
math. Workloads that genuinely need above-u16 precision (CAM,
spectral, BPC validation) are served by tier 1 / 2 (f64 throughout)
or by `compile()` (also f64). See
[Roadmap.md § DROPPED — float-WASM tier](./Roadmap.md#dropped--float-wasm-tier-was-float-wasm-scalar--f32-clut--float-wasm-simd)
for the full reasoning.

**Why these four exist.** Each tier covers a workload the others
can't deliver:
- ΔE validators need tier 1 (no LUT quantisation at all)
- Batch colour-chart ops + measurement need tier 2 (LUT speed, f64 accuracy)
- Prepress, 16-bit TIFF, ICC v4 Lab PCS native, HDR int → need tier 3 (no 8-bit round-trip, profile-native cell precision)
- Everyone else (canvas, web, photo, video) needs tier 4

### Quick reference — when to enable what

| Scenario | Recommendation |
|---|---|
| Single colour (picker, swatch) | `transform.transform(color)` — f64 pipeline, `lutMode` doesn't apply. |
| <100 colours (palette) | `buildLut: false`. f64 pipeline, same as above. |
| 100–10k colours (chart, batch convert) | `dataFormat: 'int8', buildLut: true` — default `'auto'` picks `'int-wasm-simd'`. |
| Image processing (any size) | `dataFormat: 'int8', buildLut: true` — default `'auto'` → SIMD with automatic demotion. |
| Image processing, RGB↔RGB or RGB→CMYK | Default `'auto'` — 3.0–3.5× over `'int'` via SIMD (3D kernel). |
| Image processing, CMYK input | Default `'auto'` — 2.1–2.6× over `'int'` via SIMD (4D kernel, new in v1.2). |
| Color-measurement (delta-E vs target) | `buildLut: false` for full f64 pipeline, or pin `lutMode: 'float'` if you need the LUT path. Don't use integer kernels — ≤ 1 LSB drift is visually invisible but non-zero, and in bulk can shift ΔE decisions at the margin. |
| Real-time video / large 4K+ images | Default `'auto'` — dispatcher picks `'int-wasm-simd'` (shipped v1.2) and demotes to scalar WASM / `'int'` on hosts without SIMD / WASM. |
| Pinned benchmarking / CI determinism | Explicit `lutMode: 'int-wasm-simd'` (or any specific kernel name) to fail loudly on hosts that can't run it, instead of silently demoting. |
