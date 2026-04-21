# Performance — where we are, what we learned, where we're going

This document captures the performance findings from the v1.1 work
(`lutMode: 'int'` integer hot path), how jsColorEngine compares to the
industry-standard C implementations (LittleCMS, babl), and the planned
v1.2 / v1.3 / v1.4 future work.

It's intentionally a "lab notebook" — the numbers are real, the
explanations are blunt, and the conclusions feed directly into the
roadmap at the bottom.

---

## 1. Current numbers (v1.1, single-threaded, V8 / Node 20)

Measured with `bench/mpx_summary.js` against the GRACoL2006 ICC
profile, 65 K pixels per iter, 5 batches × 100 iters median, 500 iter
warmup.

| Direction | No LUT (accuracy) | `lutMode: 'float'` (f64) | `lutMode: 'int'` (u16) | int/float speedup | int/no-LUT speedup | Accuracy (u8) |
|---|---|---|---|---|---|---|
| RGB → RGB  (3D 3Ch) | 5.0 MPx/s | 69.0 MPx/s | **72.1 MPx/s** | 1.04× | 14× | **0 LSB (100 % exact)** |
| RGB → CMYK (3D 4Ch) | 4.1 MPx/s | 56.1 MPx/s | **62.1 MPx/s** | 1.11× | 15× | ≤ 1 LSB |
| CMYK → RGB (4D 3Ch) | 4.5 MPx/s | 50.8 MPx/s | **59.1 MPx/s** | 1.16× | 13× | ≤ 1 LSB |
| CMYK → CMYK (4D 4Ch) | 3.8 MPx/s | 44.7 MPx/s | **48.8 MPx/s** | 1.09× | 13× | ≤ 1 LSB |

**MPx/s = millions of pixels per second.** A 4K image is ~8.3 MPx, so
72 MPx/s converts a 4K RGB→RGB frame in ~115 ms single-threaded; the
slowest workflow (CMYK→CMYK) still finishes a 4K frame in ~170 ms.

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

## 1b. JIT inspection — measured, not assumed

The performance story of `lutMode: 'int'` rests on three assumptions
about V8:

1. The kernels are actually promoted to TurboFan (not stuck in
   the Ignition interpreter or Sparkplug baseline after warmup).
2. V8 emits pure int32 arithmetic — not boxed HeapNumber / float64.
3. Real-world inputs don't cause the JIT to deopt, throwing away
   the specialised code.

If any of these is wrong, the whole design is wrong. So we verified
them directly using V8's native APIs, not by inference. Run the bench
yourself any time with:

```
node --allow-natives-syntax bench/jit_inspection.js
```

**Measured result (Node 20.13 / V8 11.3, Windows x64, 2026-04):**

All eight hot kernels (four `_intLut_loop` integer kernels and four
`*Array_*Ch_loop` float kernels) are confirmed:

- **Tier**: TurboFan (best tier) on all eight, after warmup.
- **Deopts during `transformArray`**: zero on both families.
- **Numerical-domain purity** confirmed from `--print-opt-code`
  disassembly — int kernels use zero float ops, float kernels keep
  their math in XMM registers and never convert to int:

| Kernel | `imul` | `add` | `sub` | shifts | `mulsd` | `addsd` | `subsd` | conv. | runtime |
|---|---|---|---|---|---|---|---|---|---|
| 3D 3Ch INT (RGB→RGB) | 34 | 58 | 27 | 24 | **0** | **0** | **0** | 0 | 0 |
| 3D 4Ch INT (RGB→CMYK) | 181 | 74 | 36 | 30 | **0** | **0** | **0** | 0 | 0 |
| 4D 3Ch INT (CMYK→RGB) | 251 | 125 | 64 | 65 | **0** | **0** | **0** | 0 | 0 |
| 4D 4Ch INT (CMYK→CMYK) | 92 | 158 | 85 | 84 | **0** | **0** | **0** | 0 | 0 |
| 3D 3Ch FLT (RGB→RGB) | 3 | 53 | 1 | 0 | 40 | 27 | 30 | 0 | 0 |
| 3D 4Ch FLT (RGB→CMYK) | 3 | 66 | 1 | 0 | 52 | 36 | 39 | 0 | 0 |
| 4D 3Ch FLT (CMYK→RGB) | 4 | 98 | 2 | 0 | 80 | 63 | 67 | 0 | 0 |
| 4D 4Ch FLT (CMYK→CMYK) | 6 | 122 | 2 | 0 | 106 | 85 | 88 | 0 | 1* |

<small>*The single CallRuntime in 4D 4Ch FLT is a deopt-guard on a
rarely-taken edge; it's not in the per-pixel hot path.</small>

Zero conversion ops (`cvtss2sd`, `cvtsd2si`, etc.) in any kernel
means V8 never bounces a value between the integer and float
domains inside the loop — the domain choice is committed at
compile time. Op counts scale with kernel complexity, confirming
the hand-unrolled tetrahedral branches in the source survive
TurboFan and aren't being collapsed back into a loop.

### Working-set size — does the unroll fit in L1i?

Emitted machine code sizes (from V8's `Instructions (size = ...)` header):

| Kernel | Code size | % of 32 KB L1i |
|---|---|---|
| 3D 3Ch INT | 4.5 KB | 14 % |
| 3D 4Ch INT | 5.4 KB | 17 % |
| 4D 3Ch INT | 7.6 KB | 24 % |
| 4D 4Ch INT | 9.4 KB | 30 % |
| 3D 3Ch FLT | 4.7 KB | 15 % |
| 3D 4Ch FLT | 5.6 KB | 17 % |
| 4D 3Ch FLT | 8.6 KB | 27 % |
| 4D 4Ch FLT | 10.8 KB | **34 %** |

Every kernel sits comfortably in the 32 KB L1 instruction cache that
has been standard since Core 2 Duo (2008). Even the largest — 4D 4Ch
CMYK→CMYK float kernel with all six tetrahedral cases unrolled inline —
uses only 34 % of L1i on a modern chip. Int kernels run 4-13 % smaller
than their float counterparts (integer immediates encode in fewer
bytes than the equivalent float-load sequences). On Apple M-series
with 192 KB L1i the kernels are effectively invisible.

The actual *hot path* through any one pixel is smaller still (one of
six tetrahedral branches is taken, not all six), so the cold-branch
bytes don't compete for L1i during a typical tight row sweep.

**The unroll pays for itself on modern CPUs precisely *because* the
working set fits L1i.** Re-rolling back to a `switch` would save
~5 KB of code but introduce one or two branch mispredicts per pixel
(rx/ry/rz/rk magnitudes vary between neighbours → ~50 % misprediction
rate × ~15–20 cycles per miss). On anything built in the last 15
years the unroll wins. This is the "counter-intuitive unroll"
mentioned in the README `## How it works` callout — documented here
with real numbers so future-us doesn't tidy the source in a way that
trades a 5 KB L1i saving for 5–10 cycles of branch penalty per pixel.

### Instruction-mix breakdown — what is V8 actually spending time on?

From `bench/jit_asm_boundscheck.ps1` against the same dump, isolated
per optimised-code block:

| Kernel | Total inst | Compute¹ | Data moves² | Safety³ | Tight bounds-check pairs⁴ |
|---|---|---|---|---|---|
| 3D 3Ch INT | 668 | **24.7 %** | 39.7 % | 21.6 % | 7.0 % |
| 3D 4Ch INT | 799 | **43.7 %** | 38.7 % | 22.0 % | 7.5 % |
| 4D 3Ch INT | 1,155 | **47.1 %** | 36.4 % | 20.0 % | 7.1 % |
| 4D 4Ch INT | 1,422 | 33.1 % | 36.7 % | 20.2 % | 7.5 % |
| 3D 3Ch FLT | 722 | 21.3 % | 29.5 % | 20.6 % | 6.0 % |
| 3D 4Ch FLT | 860 | 22.9 % | 28.4 % | 21.2 % | 6.5 % |
| 4D 3Ch FLT | 1,299 | 24.2 % | 32.3 % | 19.2 % | 5.9 % |
| 4D 4Ch FLT | 1,611 | 25.4 % | 32.8 % | 19.1 % | 6.3 % |

<small>¹ `imul`+`add`+`sub`+shifts+LEA (int kernels) or `mulsd`+`addsd`+`subsd`+int32 indexing (float kernels).  
² All mov-class instructions: `movl`/`movq`/`movzx` (int) + `movsd`/`movss` (float).  
³ `cmp` + `test` + unsigned jumps — upper bound on safety/bounds machinery.  
⁴ `cmp` immediately followed by `ja`/`jae`/`jnc` — canonical bounds-check signature.</small>

**Five findings that shape the WASM / ARM roadmap:**

1. **Int kernels are 7-12 % smaller and ~1.5-2× more compute-dense
   than their float counterparts.** Matches the ~10-15 % real-world
   speedup we see for `lutMode: 'int'` — the gain comes from needing
   fewer instructions per pixel, not a shorter critical path.

2. **Bounds checks are ~6-8 % of instructions, not "a big penalty".**
   V8's bounds-check elimination is good — it hoists the proof out
   of tight loops and only keeps checks for computed-index reads
   (e.g. `CLUT[base + X*go0 + Y*go1 + Z*go2]`). The branches that
   remain are near-zero runtime cost because they're always-not-taken
   and predicted perfectly after the first pixel. WASM's guard-page
   memory model removes this overhead entirely, but the ceiling win
   from that alone is only ~3-4 % of runtime.

2b. **Overflow checks (`jo`) are 7.9-8.5 % of every kernel — more
   than the bounds checks.** V8 speculatively compiles `a + b` or
   `a * b` as signed int32 arithmetic and emits `jo bailout` after
   each op to deopt if the speculation overflows (JS `Number` is
   float64; int32 is only ever V8 guessing). `Math.imul` is the one
   exception — it *contractually* wraps, so V8 emits it without the
   `jo`. Overflow checks appear in BOTH int AND float kernels
   because the base-pointer/index arithmetic uses plain `+`/`*`.
   **WASM eliminates these entirely** — `i32.add`, `i32.mul`, etc.
   are defined to wrap by spec, no guard needed.

   Combined WASM-eliminatable safety (bounds + overflow):

   | Kernel | Bounds % | Overflow % | Combined |
   |---|---|---|---|
   | 3D 3Ch INT | 7.0 % | 7.9 % | 14.9 % |
   | 4D 4Ch INT | 7.5 % | 8.5 % | **16.0 %** |
   | 3D 3Ch FLT | 6.0 % | 8.3 % | 14.3 % |
   | 4D 4Ch FLT | 6.3 % | 8.2 % | 14.5 % |

   That's ~15 % of instructions WASM would delete just from safety
   elimination alone. Combined with reduced spill pressure (WASM's
   linear-memory aliasing rules let the compiler pin pointers in
   registers), the realistic WASM-scalar-over-`'int'` speedup lands
   around **1.4-1.6×**, not the 1.3× we initially estimated.

3. **Data moves dominate both families** — 30-40 % of every kernel —
   and most of those moves are *spills*, not real memory traffic.
   See the spill analysis below; this is the biggest untapped
   optimisation lever.

4. **Float kernels have measurably LESS GPR pressure than int
   kernels at 3D** (see spill table below), because float values
   live in XMM registers which are a separate file from the GPRs.
   At 4D both families saturate the GPRs anyway, so the advantage
   evaporates.

5. **`subsd` exists in the float kernels** (absent from int, because
   `sub` is used instead). That's expected — float subtraction is
   a distinct x86 instruction, not `addsd` with a negated operand.

### Move classification — spills vs real memory traffic

From `bench/jit_asm_spillcheck.ps1`:

| Kernel | Moves | Spill traffic⁵ | Real heap I/O⁶ | Reg-to-reg |
|---|---|---|---|---|
| 3D 3Ch INT | 265 | **47.5 %** | 25.3 % | 8.3 % |
| 3D 4Ch INT | 309 | **50.2 %** | 24.9 % | 7.1 % |
| 4D 3Ch INT | 420 | **49.5 %** | 24.8 % | 6.0 % |
| 4D 4Ch INT | 522 | **52.3 %** | 23.8 % | 5.7 % |
| 3D 3Ch FLT | 213 | 36.6 % | 34.3 % | 3.3 % |
| 3D 4Ch FLT | 244 | 36.9 % | 35.2 % | 2.9 % |
| 4D 3Ch FLT | 420 | **50.2 %** | 31.2 % | 3.1 % |
| 4D 4Ch FLT | 528 | **52.7 %** | 30.5 % | 2.7 % |

<small>⁵ Moves to/from the `[rbp±N]` / `[rsp±N]` frame slots — register
spills V8 inserted because it ran out of registers.  
⁶ Moves to/from a non-stack address — TypedArray loads/stores, the
work we actually want.</small>

**Two striking findings:**

1. **Between 36 % and 53 % of every mov is a stack spill.** V8 ran out
   of GPRs (x86-64 has 16; V8 reserves ~5, leaving ~11 allocatable;
   the kernel wants ~13-15 live simultaneously: `rx/ry/rz`,
   `c0/c1/c2`, up to four `base` pointers, `outputPos/outputEnd`, two
   TypedArray base pointers, 1-2 temps). Reloads outnumber stores
   ~1.3×, the fingerprint of long-lived values (weights, channel
   shifts) being parked once and pulled back multiple times.

2. **Float kernels at 3D show measurably less GPR pressure** (36-37 %
   spill rate) than int kernels at 3D (47-50 %). Float values live in
   XMM0-XMM15 — a separate 16-register file — so arithmetic
   intermediates don't compete for GPRs with pointers, indices, and
   counters. At 4D this advantage evaporates because the 4-axis grid
   bookkeeping alone (4 weights + 4 bases + 4 index temps) is enough
   to saturate the GPRs regardless of the numerical domain.

**Implications for future work:**

- **ARM64 (Apple M-series, modern Cortex-A) has 31 GPRs.** V8 keeps
  ~26 allocatable, vs ~11 on x86-64. Our 13-15 value working set fits
  with huge headroom — register pressure should largely *vanish* on
  ARM. Measuring on an M1/M4 would quantify how much of our current
  cost is x86-specific, and is the obvious next experiment.
  Expected outcome: spill rate drops from ~50 % to single-digits on
  the 3D kernels, perhaps 10-20 % on the 4D kernels (still more
  live values than allocatable registers, but far less acute).
- **WASM scalar on x86-64** wins here too, and perhaps more than we
  initially credited. WASM's linear memory is a single base pointer
  with no aliasing constraints, so the WASM compiler can pin the
  CLUT/output/input pointers in registers freeing ~2 GPRs. That
  alone probably accounts for more of the 1.84× POC speedup than the
  bounds-check elimination does.
- **Candidate JS-level experiments** (for a future release, measured
  in a branch with a dedicated bench):
  - Load `c0/c1/c2` just-in-time per channel rather than upfront —
    +3 heap loads per pixel, −6 to −9 spill/reload pairs.
  - Re-order the CLUT reads to narrow each value's live range —
    pull loads closer to use *without* introducing named temps
    (named temps *worsen* spills; see PERFORMANCE LESSONS in
    `src/Transform.js`).
  - Probable ceiling is 10-20 % on top of current `'int'`, or zero
    if V8's allocator is already at the local optimum. Worth
    testing, worth being ready for "no effect" as the answer.

3. **Compute is only 9-18 %, so the kernel is memory-move-bound, not ALU-bound.**
   This refines the SIMD expectation: vectorising the *arithmetic* alone gives a max ~`0.14 × 4 = 56 %` theoretical speedup on compute, not the usual "4× SIMD dream". The big SIMD win has to come from vectorising **moves** — loading 4 CLUT cells with one `v128.load`, doing the interpolation chain across 4 cells in parallel, storing 4 outputs with one `v128.store`. Which works great *when the 4 cells are contiguous*, and degrades to 4 scalar loads when they aren't (SIMD gathers on x64 pre-AVX2 are slow, and the POC showed this directly — WASM SIMD with gathers ran *slower* than WASM scalar).

### Runtime-safe languages, bounds checks, and the "unsafe" escape hatch

A tangential but useful framing: every runtime-safe language has this tension. C# has `unsafe` + `fixed`. Rust has `unsafe` + `get_unchecked`. Swift has `withUnsafeBufferPointer`. WASM has guard pages (safety implemented by the OS via `mprotect`, not per-access checks). **JavaScript is unusual in having no opt-out** — every TypedArray access *must* be bounds-checked (or proved safe by the JIT, which it does for well-shaped loops).

For our kernels the "well-shaped loop" proof works ~95 % of the time — we're only paying for the 4-5 % that V8 can't hoist. The remaining bounds checks are the price of not having an unsafe API, and on modern CPUs it's a price the branch predictor pays on our behalf.

If we ever find ourselves wanting `CLUT.getUnchecked(i)` semantics in JS, the practical answer is "ship it as WASM" — same effect, portable, and already on the v1.2/v1.3 roadmap.

### If you want to verify yourself

Three flag combos, increasing in detail:

```bash
# Tier + deopt count (what the bench output asserts):
node --allow-natives-syntax bench/jit_inspection.js

# Every optimize / deopt event logged as it happens:
node --allow-natives-syntax --trace-opt --trace-deopt bench/jit_inspection.js

# Full emitted assembly (big — ~10 MB):
node --allow-natives-syntax --print-opt-code --code-comments bench/jit_inspection.js 2>&1 > bench/jit_asm_dump.txt
#   then run the analysis scripts against the dump:
#     powershell -ExecutionPolicy Bypass -File bench/jit_asm_grep.ps1          # int32 vs float64 op counts
#     powershell -ExecutionPolicy Bypass -File bench/jit_asm_size.ps1          # real .text byte sizes (L1i fit)
#     powershell -ExecutionPolicy Bypass -File bench/jit_asm_boundscheck.ps1   # compute vs moves vs safety mix
#     powershell -ExecutionPolicy Bypass -File bench/jit_asm_spillcheck.ps1    # spills vs real memory traffic
```

---

## 2. How does this compare to LittleCMS in C?

### Measured — vs `lcms-wasm` (direct, same-machine)

Before the estimated native-C comparison below, here is a **direct,
measured** head-to-head. The [`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm)
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
sounds wrong, but it follows directly from the JIT inspection data in
§1b above:

| | lcms-wasm | jsColorEngine |
|---|---|---|
| **Kernel dispatch** | Generic per-pixel format dispatcher (handles every lcms2 pixel layout: interleaved, planar, float, int, 8/16/32-bit, endian, extra channels) | One specialised kernel per LUT shape (3D-3Ch, 3D-4Ch, 4D-3Ch, 4D-4Ch), selected once at array entry |
| **Compile target** | C → Emscripten → wasm32 (general-purpose) | V8 TurboFan, specialised per call-site (int32 pure domain, confirmed by JIT inspection) |
| **SIMD** | None in this build | None (no stable JS SIMD) |
| **Fast Float plugin** | Not included in the WASM build | We are effectively our own Fast Float plugin in JS |
| **FFI boundary** | JS ↔ WASM on every `cmsDoTransform` | None — JS calling JS with typed arrays |
| **Bounds checks** | WASM sandbox bounds-checks every linear-memory load | V8 bounds-checks typed-array loads (~6-8 %, measured in §1b) |
| **Register pressure** | wasm32 is a register-allocated VM, not true hardware regs | V8 compiles to real x64/ARM64 registers directly; 4D kernels do spill (§1b) but stay L1i-resident |

So the comparison is not really "JS vs C" — it is "V8-tuned JS with
one specialised int32 kernel per shape" vs "C-compiled-to-WASM with
runtime format dispatch on every pixel through a sandbox." The first
is essentially custom silicon for the problem; the second is a
general tool running through an extra layer. That framing makes the
measured 1.5–2× gap unsurprising.

**The v1.3 WASM-scalar plan is not about catching up** — it is about
**extending the lead** into territory even V8 can't reach (pointer
pinning with no bounds checks, no overflow guards, explicit register
allocation). Handwritten tight-loop WASM should win another 1.4–1.6×
over today's `lutMode: 'int'`, per the JIT analysis in §1b. That
would put us past the **estimated** native-scalar lcms2 numbers in
the next subsection, though still below Fast Float + SIMD (which
needs v1.4's `wasm-simd` pass).

### Estimated comparison with native LittleCMS

We have measured numbers for jsColorEngine and for lcms-wasm. To
estimate **native** lcms2 throughput we apply a native-vs-wasm factor.
Emscripten-wasm32 typically runs **1.5–2.5× slower** than native on
scalar integer / float loops of this kind (no SIMD, extra bounds
checks, no compiler-specific tail optimisations). So:

    native lcms2 vanilla  ≈  lcms-wasm measured  ×  1.5 to 2.5

Applying that to the measured numbers in §2 above:

| Engine | Approx throughput (by direction) | Source |
|---|---|---|
| **jsColorEngine `lutMode: 'int'`**  | **44 – 66 MPx/s** | **Measured** (§2) |
| jsColorEngine `lutMode: 'float'`    | 41 – 60 MPx/s     | **Measured** (§2) |
| lcms-wasm (HIGHRESPRECALC + pinned) | 22 – 42 MPx/s     | **Measured** (§2) |
| lcms2 vanilla (native C, scalar)    | ≈ 33 – 100 MPx/s  | Estimated — wasm × 1.5–2.5 |
| lcms2 + `fast-float` plugin (SSE/AVX) | ≈ 150 – 500 MPx/s | Estimated — vanilla × 3–8 per maintainer (see §"What is `fast-float`") |
| babl (GIMP)                          | ≈ 500 – 1500 MPx/s | "up to 10× lcms2" per GIMP release notes |
| lcms2 + multithreaded plugin         | N × single-thread  | Just CPU core scaling, orthogonal |

The ranges are wide because throughput depends on profile complexity
(grid size, parametric vs LUT curves) and CPU. But the relative
ordering is right, and now **anchored to measured numbers** rather
than folklore.

### What the gap actually is

Two things fall out of that table:

1. **We are roughly at parity with estimated *vanilla scalar* lcms2.**
   For the fastest native direction (~100 MPx/s) we are ~40 % behind;
   for the slowest native direction (~33 MPx/s) we are actually
   *ahead*. That places jsColorEngine `lutMode: 'int'` somewhere
   between "on par with" and "1.5× behind" native vanilla scalar C
   for typical 8-bit colour-managed image work — a genuinely
   respectable place to be for pure JS.

2. **The remaining gap is almost entirely `fast-float` + SIMD.**
   The ~3–8× ahead of the plugin comes from SSE2/AVX wide-float
   intrinsics plus hand-tuned per-shape kernels. That gap is not
   closable in JavaScript at all — JS has no stable scalar SIMD
   (the `SIMD.js` proposal was abandoned in favour of WebAssembly
   v128). The one remaining lever in the whole stack is **WASM SIMD**
   (see roadmap §3, v1.4).

There is one pragmatic implication: the v1.3 `lutMode: 'wasm-scalar'`
pass is genuinely about **overtaking native vanilla lcms2**, not just
catching up with it. The JIT inspection in §1b shows a tight-loop
WASM kernel (pointer-pinned, no bounds checks, no overflow guards)
should recover another ~1.4–1.6× over today's `lutMode: 'int'`,
which would land us around 65–100 MPx/s — right into the estimated
native lcms2 vanilla band, possibly past it. v1.4's `wasm-simd` is
then the pass that chases the Fast Float plugin.

### What is `fast-float`?

`fast-float` is a LittleCMS *plugin* (separate library, MPL2,
[github.com/mm2/Little-CMS/tree/master/plugins/fast_float](https://github.com/mm2/Little-CMS/tree/master/plugins/fast_float))
that replaces the default scalar CLUT interpolation kernels with:

- Hand-written SSE2 / AVX intrinsics
- Specialised kernels per (input channels, output channels, bit depth)
  combination — dozens of separate optimised functions
- Tighter loop unrolling
- Float math throughout (lcms2 core uses fixed-point Q15.16; the
  plugin uses float because SSE/AVX have wide float SIMD)

It's the same architectural answer we'd reach with WASM SIMD — many
narrowly-specialised hot kernels behind a dispatcher.

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

## 3. Roadmap

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
`lutMode: 'int'`, rather than a boolean. The enum was chosen
specifically so future kernels (WASM scalar / SIMD / auto) can be
added through the same option without breaking the call signature —
unknown enum values fall through to `'float'`, so code written for a
future release won't crash on the current one.

### v1.2 — 16-bit input/output for `lutMode: 'int'`

Currently the integer kernel is u8-only. Real-world workflows often want u16:

- Print prepress workflows are 16-bit end-to-end
- Photo editors hold images in u16 to avoid posterisation in heavy
  edits
- ICC v4 itself encodes Lab as u16

Plan:

1. **u16 input → u8 output** (free; we already have the high-precision
   u16 LUT, just feed u8-bucketed indices from the high byte). One-line
   kernel variant.
2. **u16 input → u16 output** (the real prize). The math stays Q0.16,
   the final shift becomes `(acc + 0x8000) >> 16` instead of `+0x80 >> 8`.
   Single-step rounding (Q0.15 weights) gave best accuracy in the POC
   bench — see `bench/int_vs_float.js` FINDING #5.
3. **u8 input → u16 output** (cheap). Useful for "convert once,
   downstream tools handle 16-bit" pipelines.

Open question: do we keep the u16 LUT as the canonical int LUT and
use it for both u8 and u16 output, or build a separate u15 LUT for
"safe 32-bit accumulator" math? POC concluded u16 + Q0.8 has zero
overflow problems for u8 output; u16 output needs careful accumulator
sizing. **Likely answer:** u16 LUT, Q0.16 accumulator (32-bit, fits
in Math.imul output), single-step round-and-shift.

### v1.3 — `lutMode: 'wasm-scalar'`  (Web Workers deferred)

The WASM POC (1.84× over JS-plain) makes WASM scalar a stronger next
step than Web Workers. Workers can be added on top of any kernel
later; WASM is a one-time port that benefits every subsequent feature.

**Where the WASM scalar win actually comes from** (see §1b instruction
mix): our JS integer kernels are ~37 % data moves, ~20 % safety
machinery (including ~8 % `jo` overflow guards we don't need and ~7 %
bounds-check pairs), and only 25-47 % arithmetic. WASM removes both
classes of safety machinery for free — `i32` math wraps by spec
(no `jo` needed) and linear memory uses guard pages for bounds
safety (no `cmp`/`jae` pairs needed).

**Expected WASM-scalar-over-`'int'` speedup**: with ~15 % of
instructions eliminated from safety alone, plus reduced spill
pressure from pinning the linear-memory base pointer in a register,
we expect **1.4-1.6× over the v1.1 `'int'` kernels** (compared to
the 1.84× POC vs JS-plain, which had additional wins from escaping
Smi/HeapNumber plumbing at call boundaries).

Adds new enum value:

```js
new Transform({ ..., lutMode: 'wasm-scalar' });
```

Falls through to `'int'` if WASM isn't available in the host (e.g.
sandboxed environments without WASM), which falls through to
`'float'` for unsupported LUT shapes. The whole point of the enum is
this fall-through chain.

Work items:
- Hand-written `.wat` (or AssemblyScript) port of the four 3D/4D
  integer kernels — payload <5 KB inlined.
- Compile-at-load via `wabt` dev-time tooling, ship the `.wasm`
  binary inline as base64 in the bundle.
- Three-tier dispatcher in `transformArrayViaLUT`.
- Re-run `bench/jit_asm_boundscheck.ps1`'s equivalent against the
  WASM-emitted x64 to confirm the move/safety reduction actually
  materialises. If it doesn't, the 1.3× prediction is wrong and we
  regroup.

### v1.4 — `lutMode: 'wasm-simd'` and `lutMode: 'auto'`

The proof of concept lives in `bench/wasm_poc/`. It implements the
**same** 1D LERP-through-u16-LUT kernel four ways (JS plain, JS with
`Math.imul`, WASM scalar, WASM SIMD) plus a control kernel
(`vectorMul_simd`) showing the WASM SIMD ceiling without LUT gather.

**Measured results (Node 20, 1 Mi pixels per pass):**

| Kernel | MPx/s | vs JS plain |
|---|---|---|
| JS plain | 372 | 1.00× |
| JS `Math.imul` | 376 | 1.01× |
| **WASM scalar** | **684** | **1.84×** |
| WASM SIMD (with LUT gather) | 606 | 1.63× |
| WASM SIMD (no LUT, pure math) | 25 180 | **67.7×** |

All four LERP kernels are bit-exact against each other across 1 Mi
pixels. See `bench/wasm_poc/README.md` for the full analysis.

**Surprises that drove the v1.3 / v1.4 split:**

1. **WASM scalar beat JS by 1.84×** for this kernel. We expected
   1.0–1.2×. V8 is excellent at integer JS, but WASM still wins
   thanks to no bounds checks, no de-opt risk, and tighter machine
   code. This makes WASM scalar interesting on its own — we don't
   need SIMD to justify the port. **→ v1.3 (`lutMode: 'wasm-scalar'`)**

2. **WASM SIMD with LUT gather is *slower* than WASM scalar** (0.89×).
   WASM SIMD has no native gather instruction; each lane lookup is a
   scalar `i32.load16_u` + `replace_lane` round-trip. For LUT-heavy
   kernels (which color management is), the lane-juggling exceeds
   the parallelism win. **The 3D/4D tetrahedral kernels do 8/16
   gathers per pixel, so SIMD will perform worse there.** → 3D/4D
   LUT kernels stay scalar in WASM.

3. **WASM SIMD pure math IS 67.7× faster** when the algorithm fits.
   This is the ceiling for kernels that don't need LUT lookup —
   matrix-shaper RGB transforms, gamma curves applied with a
   polynomial approximation, RGB↔YUV, channel reordering. **This is
   where WASM SIMD belongs in jsColorEngine.** → v1.4 (`lutMode:
   'wasm-simd'`) targets matrix-shaper, not LUT.

4. **`Math.imul` is no longer worth using as a perf optimisation in
   modern V8.** It's still useful as insurance against accidental
   float promotion, but plain `*` produces identical machine code.

**Per-kernel WASM decisions:**

| Kernel | Decision |
|---|---|
| 3D/4D tetrahedral LUT (the integer kernels we just shipped) | **WASM scalar** — likely 1.5–2× win on top of current `'int'`. ~300–500 lines of `.wat` per kernel. |
| 3D/4D tetrahedral LUT — SIMD | **No** — gather pattern doesn't vectorise (POC #2). |
| Matrix-shaper RGB transforms | **WASM SIMD** — no LUT gather, approaches the 67× ceiling (POC #3). |
| 1D shaper curves (gamma, parametric) | **WASM scalar** — small, easy win, the POC kernel itself. |

**Architectural decision** (still deferred): ship WASM as a separate
`jscolorengine-wasm` package, or as an opt-in bundle inside the core?
The POC numbers (227-byte scalar kernel, 761-byte SIMD kernel)
suggest "inside the core, gated behind a feature flag" is fine —
total inline WASM payload is < 5 KB.

The dispatcher fall-through chain is the entire reason `lutMode` is
a string enum:

```
switch (this.lutMode) {
    case 'auto':         pickBest(); break;          // v1.4
    case 'wasm-simd':    if (canDoWasmSimd) ...      // v1.4 (matrix only)
    case 'wasm-scalar':  if (canDoWasm) ...          // v1.3
    case 'int':          if (lut.intLut) ...         // v1.1 (current)
    case 'float':        // always works               (current)
}
// every level falls through to the next on capability miss.
```

---

## 4. What we are explicitly NOT doing

- **GPU (WebGL / WebGPU shaders).** Tempting because GPUs eat 3D LUTs
  for breakfast, but: (a) upload+download latency dominates for
  anything under ~10 MPx, (b) WebGPU isn't universally available yet,
  (c) the API surface is huge. Maybe v2.x; not on the near roadmap.
- **Lab whitepoint awareness in `lutMode: 'int'`.** Lab a/b are signed;
  our integer kernels assume unsigned u8/u16 inputs. We sidestep this
  by always going through device color (RGB or CMYK) when `lutMode:
  'int'` is on. If you need Lab→Lab, use `lutMode: 'float'`.
- **Web Workers / parallel transformArray.** Was on the v1.3 roadmap
  but bumped — the WASM POC numbers (1.84× scalar) make WASM the
  better next step, and Web Workers can be added on top of any
  kernel later. Will revisit post-v1.4 once `'auto'` exists.
- **Profile decode optimisation.** Profile parsing is a one-time cost;
  the engine spends 99.9% of its life inside `transformArray`. Not
  worth the code complexity.
- **Asm.js / sharedarraybuffer-only paths.** asm.js was superseded by
  WASM; SharedArrayBuffer requires CORS headers most users don't
  control. We'll use them where available but won't *require* them.

---

## 5. Quick reference — when to enable what

| Scenario | Recommendation |
|---|---|
| Single colour (picker, swatch) | Float accuracy path (`transform.transform(color)`). LUT not needed. |
| <100 colours (palette) | Float path with `buildLut: false`. |
| 100–10k colours (chart, batch convert) | `dataFormat: 'int8', buildLut: true`. `lutMode: 'int'` optional (gives ~12%). |
| Image processing (any size) | `dataFormat: 'int8', buildLut: true, lutMode: 'int'`. |
| Image processing, RGB↔RGB or RGB→CMYK | `lutMode: 'int'` gives ~12% (3D 1.12×). |
| Image processing, CMYK input | `lutMode: 'int'` gives ~21% (4D 1.21×, new in v1.1). |
| Color-measurement (delta-E vs target) | Float path. Don't use `lutMode: 'int'` — ≤ 1 LSB drift is visually invisible but non-zero, and in bulk can shift ΔE decisions at the margin. |
| Real-time video / large 4K+ images | `lutMode: 'int'` today; `'wasm-scalar'` when available (v1.3); `'auto'` when available (v1.4). |
