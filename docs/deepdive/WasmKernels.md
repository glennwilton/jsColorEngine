# WASM kernels

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
[JIT inspection](./JitInspection.md)

---

This page is the engineering notebook for the hand-written WebAssembly
kernels that ship under [`src/wasm/`](../../src/wasm/). It covers what each
kernel does, how it was measured, what the design-decision trail looks
like, and the surprises we hit along the way. Read
[JIT inspection](./JitInspection.md) first — the predictions that drove
this work all come from there.

The WASM kernels come in two pairs:

| Kernel | Source | `lutMode` that uses it |
|---|---|---|
| 3D tetrahedral, n-channel scalar | [`src/wasm/tetra3d_nch.wat`](../../src/wasm/tetra3d_nch.wat) | `'int-wasm-scalar'` (3-channel-in LUTs) |
| 4D tetrahedral, n-channel scalar | [`src/wasm/tetra4d_nch.wat`](../../src/wasm/tetra4d_nch.wat) | `'int-wasm-scalar'` (4-channel-in LUTs) |
| 3D tetrahedral, channel-parallel SIMD | [`src/wasm/tetra3d_simd.wat`](../../src/wasm/tetra3d_simd.wat) | `'int-wasm-simd'` (3-channel-in LUTs) |
| 4D tetrahedral, channel-parallel SIMD | [`src/wasm/tetra4d_simd.wat`](../../src/wasm/tetra4d_simd.wat) | `'int-wasm-simd'` (4-channel-in LUTs) |

Each `.wat` has a corresponding `*.wasm.js` file with the compiled bytes
inlined as a base64 string — no xhr, no fetch, no bundler configuration
required. Runtime loading, module caching, and dispatch live in
[`src/wasm/wasm_loader.js`](../../src/wasm/wasm_loader.js).

All four kernels are bit-exact against both each other and the JS `'int'`
reference across a 12-config matrix (3 grid sizes × 2 output channel
counts × 2 dimensionality), verified pixel-by-pixel across ~ 300 M bytes
per config.

## WASM scalar 3D — the first kernel

The v1.2 WASM plan (`lutMode: 'int-wasm-scalar'`; originally on the v1.3
roadmap, pulled forward once the 1D POC justified it) predicted **1.4-1.6×**
over the production `'int'` kernels based on the [JIT inspection](./JitInspection.md)
instruction-mix analysis (~15 % of instructions deletable via guard-page
bounds and i32-wrap arithmetic). That prediction was the roadmap's blocker:
if WASM couldn't clear that bar, the port wouldn't justify its complexity.

### The experiment

[`bench/wasm_poc/tetra3d_nch.wat`](../../bench/wasm_poc/tetra3d_nch.wat) +
[`bench/wasm_poc/tetra3d_run.js`](../../bench/wasm_poc/tetra3d_run.js)
(Apr 2026):

A hand-written `.wat` port of `tetrahedralInterp3DArray_3Ch_intLut_loop`,
same int Q0.16 gps + u16 CLUT + `(x + 0x80) >> 8`-twice rounding, but with
the channel axis **rolled** into a `for(o = 0; o < cMax; o++)` loop
(n-channel form from `tetrahedralInterp3D_NCh`, rather than the production
kernel's fully-unrolled 3× body). Plus a sibling
[`tetra3d_3ch_preload.wat`](../../bench/wasm_poc/tetra3d_3ch_preload.wat)
that replicates the JS kernel's "pre-load `c0, c1, c2` before case dispatch"
pattern, to test whether that pattern matters on WASM.

Benched as a matrix: grid size `g1 ∈ {17, 33, 65}` × output channels
`cMax ∈ {3, 4}`, each config run against its production JS sibling
(`_3Ch_intLut_loop` or `_4Ch_intLut_loop`), 1 Mi pixels × 500 iters,
Node 20.13.1 / V8 11.3 / Windows x64.

| g1 | cMax | CLUT | JS MPx/s | WASM nCh rolled | vs JS | WASM 3Ch preload | vs JS |
|---|---|---|---|---|---|---|---|
| 17 | 3 | 28.8 KB  (90 % L1d)   |  71.9 |  98.8 | **1.37×** | 102.5 | **1.43×** |
| 17 | 4 | 38.4 KB  (120 % L1d)  |  59.2 |  83.6 | **1.41×** | — | — |
| 33 | 3 | 210.6 KB (658 % L1d)  |  70.5 | 101.2 | **1.44×** | 101.9 | **1.45×** |
| 33 | 4 | 280.8 KB (877 % L1d)  |  59.7 |  83.6 | **1.40×** | — | — |
| 65 | 3 | 1609.1 KB (5029 % L1d)|  71.4 | 101.2 | **1.42×** | 102.2 | **1.43×** |
| 65 | 4 | 2145.5 KB (6705 % L1d)|  60.1 |  82.5 | **1.37×** | — | — |

**All six configs bit-exact** — 100 % of 3.1-4.2 M output bytes match the
production kernel at every grid size and channel count, max diff = 0
across 314 M verified bytes. (The int math is pinned down precisely
enough in the JS kernel that line-by-line translation to `.wat` just
works. This was not a given.)

### Four findings worth internalising

1. **The 1.4× prediction landed, near the low end of the range.**
   1.29-1.45× across six configs (three LUT sizes, two channel counts)
   across repeat runs isn't bench variance — it's a structural 30-45 %
   gap between WASM and JS for this algorithm on this CPU. That matches
   the "delete bounds checks + delete overflow guards + delete Smi
   tagging" theory almost exactly. The biggest CLUT (cMax=4, 2.1 MB, 67×
   L1d) sits closest to 1.29× because the JS kernel's longer hot loop
   has more opportunity to overlap load latency across pixels; WASM's
   tighter loop has less overlap headroom. Still a clear win at every
   config.

2. **LUT size is a non-issue.** 28.8 KB CLUT (fits L1d) vs 2.1 MB CLUT
   (way past L2 into L3) produce the same 1.37-1.44× ratio. The
   algorithm has enough arithmetic per gather that cache latency is
   fully hidden at every realistic LUT size. No need for cache-tiling
   strategies in v1.2.

3. **Rolled channel loop matches fully-unrolled + preloaded within 2 %.**
   `tetra3d_nch` (channel loop, `c` reloaded per iter) vs
   `tetra3d_3ch_preload` (unrolled 3 ×, `c0/c1/c2` preloaded): avg +2 %,
   range +1-4 %. This is inside bench noise. V8's WASM backend is
   already CSE-ing the anchor-corner reads, or the loop overhead is
   small enough that preload's reduction in `base0++` arithmetic doesn't
   show up. **Practical implication: one n-channel kernel handles 3Ch,
   4Ch, 5Ch, 6Ch at the same relative speed.** No codegen, no
   specialisation, no per-channel-count variants. The entire 20-kernel
   JS specialisation surface collapses to a single `.wat` file.

4. **Linear scaling from 3Ch to 4Ch.** WASM: 99 → 83 MPx/s = 84 % of 3Ch
   speed, exactly the 3/4 ratio of work-per-pixel. JS drops faster
   (72 → 60 = 83 %, but from a lower base). WASM's register allocator
   handles the extra channel with no pain; the JS 4Ch kernel has to
   absorb more register pressure relative to what V8 can colour.

### What the 1.40× really is

It's *exactly* what V8 pays for being safe-by-default at runtime. The
[JIT inspection](./JitInspection.md) spill and bounds analyses priced
the `jae → deopt` bounds-check pairs, the `jo` overflow guards, the Smi
tagging round-trips, and the HeapNumber box plumbing at somewhere around
15-20 % of instructions in the hot body. Removing them, as WASM does by
specification, recovers that ~15-20 % — plus some from better register
coloring now that the safety machinery no longer consumes GPRs — and you
land at 40 %. This isn't WASM being magic. It's JavaScript paying for
being JavaScript.

### Architectural wins beyond the speedup

Even at "only" 40 %, the WASM port is the right call because:

- **Kernel count 20+ → ~2** (one 3D n-channel, one 4D n-channel). Same
  kernel handles `RGB→RGB`, `RGB→CMYK`, `RGB→6Ch spot-colour`,
  `Lab→RGB`, etc — whatever `outputChannels` the LUT has. The JS side
  has to specialise one kernel per (dimensionality, channel count,
  float/int, alpha-on/alpha-off) tuple.
- **1.8 KB `.wasm`** per kernel (vs 2.3-10 KB emitted x64 per specialised
  JS kernel). An order of magnitude less L1i pressure.
- **Graceful fallback** — `lutMode: 'int-wasm-scalar'` demotes to `'int'`
  at `Transform.create()` time if `WebAssembly` is undefined or the
  module fails to compile. No runtime branching in the hot path;
  selection happens once.
- **Maintenance story improves.** The JS kernels are tuned against V8's
  2019-2024 cost model (register pressure, shape stability, Smi range).
  WASM is tuned against the CPU's cost model, which is stable for
  decades. Future V8 improvements neither help nor hurt the WASM path
  beyond normal compile-time gains.

### Alpha handling — ~10 extra instructions, zero hot-path cost

Alpha (input `RGBA`, output `RGBA` or `CMYKA`, optional pass-through) is
handled by two extra kernel params: `inAlphaSkip` (0 or 1 bytes) and
`outAlphaMode` (0=none, 1=fill-255, 2=preserve-copy). The interpolation
math doesn't change — alpha is a stride widening, not an algorithm
change. The kernel's end-of-pixel tail gained ~10 WAT instructions
(`.wasm` grew from 1835 → 1900 bytes, +3.5 %). V8's WASM backend hoists
the `outAlphaMode == 0` branch out of the pixel loop, so the no-alpha
bench speed is identical to before the alpha tail existed (1.39× avg,
within noise of the pre-alpha runs).

Bit-exact against the JS `_3Ch_intLut_loop` / `_4Ch_intLut_loop` across
all four alpha modes (none, input-only-skip, output-fill-255,
preserve-copy) in the Jest dispatcher suite
(`__tests__/transform_lutMode_wasm.tests.js`, 13 tests, all bit-exact).

### How we prove WASM actually ran (not a silent `'int'` fallback)

Bit-exactness-vs-`'int'` is a necessary but not sufficient test. If
`WebAssembly` is unavailable at `Transform.create()` time — corrupted
bundle, missing global, sandbox — the dispatcher demotes `lutMode` to
`'int'` and runs the JS kernel. Every bit-exact-against-`'int'` test
then passes *because it's now comparing `'int'` against `'int'`*, not
because WASM works.

The `Tetra3DState` exposed by `wasm_loader.js` carries a `dispatchCount`
(one i32 increment per `runTetra3D()` call). Tests assert:

```js
expect(t.lutMode).toBe('int-wasm-scalar');     // no demotion at create()
expect(t.wasmTetra3D).not.toBeNull();           // instance present
const before = t.wasmTetra3D.dispatchCount;
t.transformArray(input, ...);
expect(t.wasmTetra3D.dispatchCount - before).toBe(1);  // WASM actually ran
```

Applied to every routing-sensitive test: the main 3Ch/4Ch bit-exact
tests, each alpha mode, the shared-cache test, and the format-tag
guardrail. The dispatch counter also flips the sign on the sub-threshold
test ("dispatchCount MUST NOT advance for 9-pixel input"), which proves
the `WASM_DISPATCH_MIN_PIXELS` gate is actually firing rather than being
a no-op.

### What we chose not to do, and why

- **WAT codegen.** The preload experiment said no (+2 %, inside noise).
  If we ever need it — e.g. a hypothetical SIMD variant where preload +
  4-wide vector ops interact differently — it's half a day's work to add
  a small JS script that emits case-specialised `.wat`.

- **cMax < 3.** The kernel handles `cMax ∈ {3, 4, 5, 6, ...}` the same
  way. `cMax = 1` (grayscale output through a 3D LUT) or `cMax = 2` (not
  a common shape) would cost one branch to handle the degenerate case;
  we can add it if a profile demands it. Until then, out of scope.

- **Re-measuring the full kernel with named `const` temps** (the
  "named temps hurt?" follow-up in [JIT inspection](./JitInspection.md)).
  WASM doesn't care about named temps — register pressure is the
  allocator's problem, not the source author's. The JS-side question is
  still open; the WASM port sidesteps it.

## WASM SIMD 3D — channel-parallel was the wrong axis, once

The original 1D POC (preserved in the "Historical record" section of
[Performance.md](../Performance.md)) predicted **no SIMD win** for 3D/4D
LUT kernels because it vectorised *across pixels* and each lane needed
its own LUT gather — the lane juggling exceeded the parallelism win
(0.89×, POC finding #2). The resulting plan kept SIMD for matrix-shaper
work only and declared LUT kernels scalar-only under WASM.

**That conclusion was wrong, because the axis was wrong.**

The breakthrough (Apr 2026): the n channels at any given CLUT grid
corner are stored **contiguously** in memory — layout `[X][Y][Z][ch]`
has `ch` as the fastest-moving axis. So the four tetrahedral anchor
corner reads (3D needs 4 reads per output pixel: `base0`, and three
more per case) can each be a single 64-bit contiguous load, unpacking
directly into 4 i32 lanes:

```
v128.load64_zero  + i32x4.extend_low_i16x8_u
```

That's 4 u16 CLUT values with 16 bits of arithmetic headroom per lane,
from one aligned load per corner, **no gather at all**. The cost of the
old SIMD-LUT POC evaporates. The interpolation math then runs once per
pixel across v128 vectors rather than cMax times in a channel loop. The
4th lane is "free" for cMax=3 (the 4th u16 is the next grid corner's R,
which we compute a junk interpolation for and never store) and is the
entire *point* for cMax=4.

### Measured results

[`bench/wasm_poc/tetra3d_simd.wat`](../../bench/wasm_poc/tetra3d_simd.wat) +
[`bench/wasm_poc/tetra3d_simd_run.js`](../../bench/wasm_poc/tetra3d_simd_run.js).

All six configs bit-exact against both the JS `_3Ch_intLut_loop` /
`_4Ch_intLut_loop` production kernels **and** the shipping WASM scalar
kernel (`src/wasm/tetra3d_nch.wat`), 1 Mi pixels × 500 iters, Node
20.13.1 / V8 11.3 / Windows x64:

| g1 | cMax | CLUT | JS `'int'` | WASM scalar | **WASM SIMD** | SIMD vs JS | SIMD vs scalar |
|---|---|---|---|---|---|---|---|
| 17 | 3 | 28.8 KB   |  72.6 |  97.4 | **213.1** | **2.94×** | 2.19× |
| 17 | 4 | 38.4 KB   |  61.4 |  82.7 | **215.1** | **3.50×** | 2.60× |
| 33 | 3 | 210.6 KB  |  70.2 |  98.6 | **216.0** | **3.07×** | 2.19× |
| 33 | 4 | 280.8 KB  |  60.3 |  84.0 | **210.1** | **3.49×** | 2.50× |
| 65 | 3 | 1609.1 KB |  70.5 |  98.7 | **211.3** | **3.00×** | 2.14× |
| 65 | 4 | 2145.5 KB |  60.0 |  80.9 | **210.0** | **3.50×** | 2.60× |

**Averages: SIMD vs JS 3.25× (range 2.94-3.50×). SIMD vs WASM scalar
2.37× (range 2.14-2.60×).** All MPx/s figures.

### Four findings worth internalising

1. **cMax=4 lands at exactly 3.50× every time.** Full 4-lane use, one
   `v128.store32_lane` per pixel, no advance-stride gymnastics. The
   ratio is flat across all three LUT sizes (17³=28.8 KB fits L1d;
   65³=2.1 MB is way past L3). We're at an algorithmic ceiling, not a
   cache one.

2. **cMax=3 still hits 3.00×** with the "lane-3 don't-care + overalloc
   by 1 byte + advance by 3" trick. The 4th lane does unused arithmetic
   (25 % of compute wasted) but the 3-byte advance means the next
   pixel's `R` write overwrites the junk lane-3 byte — so there's no
   conditional store. 3.5× → 3.0× is a 14 % degrade, not 25 %, because
   the fixed per-pixel grid-index cost (boundary patch, X0/X1/rx, case
   dispatch) dilutes the waste. A "rolling-shutter" scheme (process 4
   pixels in parallel by packing their R/G/B across lanes) could in
   principle recover the lane — but it reintroduces gathers (the LUT
   bases are per-pixel) and the implementation complexity explodes. Not
   worth chasing.

3. **Emitted kernel is SMALLER than scalar** — 1.3 KB vs 1.9 KB `.wasm`.
   The channel loop collapsed into zero iterations, so the net code
   size is lower despite SIMD ops being ~1 byte longer each. Running at
   30 % of the scalar's L1i footprint (≈0.5 KB emitted x64 per case).
   "Fancier = bigger" intuition is violated here; the abstraction that
   won was one that also happened to be terser.

4. **Post-scalar gap is ~2.4×, not the 4× theoretical.** Where does the
   missing 1.6× go? Two places:
   - Per-pixel grid-index math (boundary patch + X0/Y0/Z0/rx/ry/rz +
     case dispatch) stays scalar and costs the same per pixel whether
     the interp is scalar or SIMD. Amdahl's law: if scalar-pre-SIMD is
     ~20 % of the kernel, best-possible SIMD is 1 / (0.2 + 0.8/4) =
     2.5× — we measured 2.37×, agreeing within noise.
   - `i32x4.mul` on x64 lowers to `VPMULLD` which is 3-cycle
     throughput vs 1-cycle for scalar `imull`; the lane width wins but
     per-op throughput doesn't. Not a bug, just a cost.

### What this means relative to native C / lcms2

The [Performance page](../Performance.md) estimates native vanilla lcms2
at 33-100 MPx/s on this kind of workflow (wasm × 1.5-2.5). Measured WASM
SIMD at 210-215 MPx/s puts 3D jsColorEngine **past** the native vanilla
band on the fast directions, and **into** the lcms2 `fast-float`
plugin's SSE2/AVX territory (estimate 150-500 MPx/s). On pure WASM, on
a single CPU thread, with JavaScript as the outer language. This is the
"matter of pride" milestone the v1.x arc was aimed at.

The 3D work covers ~99 % of LUT workflows (RGB→RGB, RGB→CMYK, RGB→Lab,
RGB→Nch spot). Channel counts of 1, 2 or ≥5 fall back to the scalar
WASM kernel; 4D (CMYK input) is a separate design, covered below.

### Rolling shutter — why we're not doing 3Ch "properly"

The 14 % gap between cMax=3 (3.0×) and cMax=4 (3.5×) could in principle
be recovered by processing 4 pixels in parallel, packing
`(R0,G0,B0,R1)(G1,B1,R2,G2)(B2,R3,G3,B3)` across v128 lanes so all 12
output bytes are computed on every cycle. Reasons it's not worth
shipping:

- Four different LUT base pointers → gather territory reopens for the
  CLUT reads (the whole problem we just dodged).
- Three different rx/ry/rz splats per cycle → 3× the weight setup.
- Case-dispatch has to become per-pixel-per-lane with select-masks, or
  devolve into 6³=216 case combinations. Either way the dispatcher is
  6-10× larger than the current kernel.
- Store has to de-interleave, which is another set of shuffles.

For a 14 % win on the 3Ch path, the maintenance and bit-exactness
surface grows enormously. Filed under "counter-productive", next to
"hand-rolled AVX512 intrinsics". If someone profiles real workflows and
finds the 3Ch gap dominates a real-world use case, it's worth
re-opening; until then, the simple lane-3-don't-care form is the right
engineering call.

## WASM scalar 4D — and the function-call lesson

We built the 4D scalar kernel first (SIMD follows in the same v1.2
milestone) to validate the hoisted-prologue + flag-gated K-plane loop
shape end-to-end before porting it to v128. Source is
[`bench/wasm_poc/tetra4d_nch.wat`](../../bench/wasm_poc/tetra4d_nch.wat)
(one rolled n-channel kernel; the JS sibling has fully unrolled `_3Ch`
/ `_4Ch` variants).

[`bench/wasm_poc/tetra4d_nch_run.js`](../../bench/wasm_poc/tetra4d_nch_run.js),
Node 20.13, 2^20 pixels/pass, 1.25 B pixels over 5×50 batches per config:

```
  g1  cMax  CLUT        JS MPx/s  WASM MPx/s   WASM vs JS
  --  ----  --------    --------  ----------   ----------
   9    3    38.4 KB        60.7        68.8      1.13×
   9    4    51.3 KB        50.3        59.9      1.19×
  17    3   489.4 KB        46.8        69.5      1.49×
  17    4   652.5 KB        51.3        59.2      1.15×
  33    3  6948.8 KB        61.1        70.2      1.15×
  33    4  9265.0 KB        50.6        59.6      1.18×
```

Verdict: **avg 1.22× over JS `int`** (min 1.13×, max 1.49×), all configs
**bit-exact**. Kernel size 2.5 KB — about 600 bytes heavier than the 3D
scalar (1.9 KB) but still single-loader, single-cache entry.

The ratio is noticeably smaller than the 3D scalar's 1.40×. Two reasons
we understood only after the bench shipped:

1. **The JS 4D kernel was already very tight.** It's the v1.1
   u20-refactored int path — same moving-base pointer tricks, same
   single-rounding design, fully `Math.imul`-d. V8 gives it ~50–60 MPx/s
   on L2-spilling LUTs, and the 4D tetrahedral work is about 1.7× the
   3D work per pixel, so the _absolute_ headroom is smaller.
2. **Rolled n-channel loop costs a register.** The JS kernel unrolls the
   inner channel loop and keeps each output u20 in a named local across
   the K0/K1 passes. A rolled WASM kernel can't — WASM locals aren't
   indexable by runtime values — so the K0-pass u20 values have to land
   somewhere addressable. We used a caller-managed 4-byte-aligned scratch
   region (32 bytes for cMax ≤ 8, passed in as `$scratchPtr`), which
   adds one i32.store on the K0 pass and one i32.load on the K1 pass
   per output channel. That's a ~2–3 ns overhead per pixel at cMax=4 —
   half the 4D scalar win.

   **Why not keep the u20s on the WASM operand stack?** Stack depth in
   WASM has to be statically known at every instruction and balanced
   across `loop` back-edges. "Push cMax values on iter 0, pop cMax
   values on iter 1" where cMax is a runtime arg is inexpressible; the
   validator rejects it. The fix lands in 4D SIMD, which holds all 3–4
   channels in a single v128 local and crosses the K-plane loop as one
   register — no scratch memory at all.

### The function-call cost lesson (V8 WASM inliner was the hidden tax)

Our _first_ 4D scalar build ran at **0.77× JS** — a 25 % regression,
despite being bit-exact and having a tighter per-pixel op count than the
JS kernel. The 7 (cases 0–5 + alpha tail) tail-dispatch sites were
calling an `$emit_tail` helper function that did the 3-way split
(direct u8 store on `!interpK`, scratch store on K0, K-LERP + store on
K1). We assumed V8 would inline it. It didn't.

Inlining the `$emit_tail` body at every call site — 7 copies, ~30 WAT
instructions each — flipped it to **1.22× JS**. The `.wasm` grew from
1.9 KB to 2.5 KB, and peak perf jumped ~60 %.

**Why V8's inliner passed on it:** the helper function had a `return`
statement inside one of its three conditional arms (the `!interpK`
direct-store path). V8's WASM TurboFan inliner is conservative about
early-return / multi-exit functions — it can do it, but only when the
caller structure is friendly. A function-inside-a-rolled-loop-inside-a-
branch-stack wasn't. So every per-channel iteration paid a full
call-frame setup + teardown: ~5 cycles × 8 calls × pixel count = ~13 ns
of call overhead alone, against a ~60 ns pixel budget.

The takeaway that transfers to all future WASM work:

- **Never put a `return` inside a helper function you want inlined.**
  Rewrite as a conditional expression or a block with a single exit
  point.
- **For hot-loop helpers, inline by hand first, measure, then de-inline
  if the size matters.** WASM function-call cost is real (much higher
  than native C), and V8's inliner decisions aren't always the ones
  you'd make. A 600-byte `.wasm` increase bought us 60 % perf on a
  rolled kernel. Not a trade to skip.
- **V8's WASM module-level compilation still feels like `-O0` relative
  to its JS baseline.** Our scalar 4D WASM runs 1.22× JS; a naive
  expectation would be 1.6–2.0× since the JS path has bounds checks,
  `Math.imul` calls, and tag-check branches that WASM doesn't. The gap
  is largely: WASM can't promote runtime-indexed data to registers,
  JS's TurboFan can (after enough feedback samples). We win back most
  of that in the SIMD path, which is coming next.

Alpha-tail handling in the 4D scalar matches the 3D scalar exactly
(same three modes: input-skip, fill-255, preserve-copy). Not
bit-exact-tested in the .wat bench (bench runs `inAlphaSkip=0,
outAlphaMode=0`); alpha paths are covered in the shipped Jest suite for
the 4D `int-wasm-scalar` dispatcher, same as the 3D suite.

## WASM SIMD 4D — the K-plane loop in one v128

4D is a separate design. It can't copy the 3D SIMD pattern as a literal
"call the 3D kernel twice" because (a) the K-LERP
`Math.imul(K1_u20 - o0_u20, rk)` reaches signed i32 boundaries even in
scalar form, and (b) calling the 3D kernel twice would double every
scalar per-pixel op — boundary patch, X0/Y0/Z0, rx/ry/rz, case dispatch,
base1/2/4 — which depend on C/M/Y only and are identical across the
two K planes. Doing the same work twice is ~25 % of the naive cost.

The better design is to **hoist everything that depends only on (C, M, Y)
into the outer 4D pixel loop, and run the 3D interp body itself inside a
flag-gated WASM `loop` so it's emitted exactly once but executes twice
per pixel** (K0 pass, then K1 pass). A flat "inline the 3D body twice"
decomposition works but emits ~50-60 % more `.wasm` bytes than it needs
to — the entire 6-case tetra dispatch, the four CLUT loads, and the
SIMD/scalar interp math are all K-independent (depend only on `rx/ry/rz`
and the precomputed XYZ bases, which are the same for both K planes).
The only thing that changes between passes is the set of four base
offsets, all of which shift by a single compile-time constant (`goK`,
or equivalently `goK - cMax` if the scalar inner channel loop runs a
moving base pointer).

### Per-pixel structure

```
-- per pixel, hoisted prologue -----------------------------------
  load C, M, Y, K
  compute X0, Y0, Z0, rx_q8, ry_q8, rz_q8    (C/M/Y only)
  select tetra case                          (depends on rx/ry/rz ordering)
  compute base0, base1, base2, base4         (XYZ-only LUT offsets)
  compute K0, K1, rk                         (K-axis setup)
  initialise base{0,1,2,4}_k = base{0,1,2,4} + K0 * goK
  set $flag = 0

-- K-plane loop (WASM `loop $kloop` — body emitted once, iterates 2x)
  load vC = CLUT[base0_k]   (v128.load64_zero + extend to i32x4)
  load vA = CLUT[base1_k]
  load vB = CLUT[base2_k]
  load vD = CLUT[base4_k]
  vSum = (vA - vC)*rx + (vB - vA)*ry + (vD - vB)*rz
  vU16 = vC + (vSum + 0x80) >> 8             -- keep at u16, don't narrow
  if $flag == 0:
    save vU16_K0 = vU16                      -- stash K0 result
    $flag = 1
    base{0,1,2,4}_k += goK                   -- one const add per base
    br $kloop                                -- second iter for K1 plane

-- K-LERP + narrow, once ------------------------------------------
  vU16_K1  = vU16                            -- K1 result lives in $vU16
  vDiff    = vU16_K1 - vU16_K0               (i32x4.sub)
  vKlerp   = vDiff * rk                      (i32x4.mul, fits in i32 lanes)
  vOut_u20 = (vU16_K0 << 4) + vKlerp         (u20 Q16.4, matches scalar 4D)
  vOut_u8  = ((vOut_u20 + 0x80000) >> 20) narrow   (single final rounding)
  v128.store32_lane → outputPos
```

WASM doesn't have a raw `JP` — the `br $kloop` is the idiomatic way to
express the same "jump to start of 3D interp" shape you'd write in
native assembly. Structured control flow, no label lookup cost, V8's
WASM backend lowers it to a single conditional branch per pixel
(predicted-taken on iter 1, predicted-not-taken on iter 2; ~0-1 cycle
amortised against the ~70-cycle per-pixel 4D budget).

### Measured results

[`bench/wasm_poc/tetra4d_simd.wat`](../../bench/wasm_poc/tetra4d_simd.wat) +
[`bench/wasm_poc/tetra4d_simd_run.js`](../../bench/wasm_poc/tetra4d_simd_run.js),
Node 20.13, 2^20 pixels/pass, 1.25 B pixels over 5×50 batches per config:

```
  g1  cMax  CLUT         JS     scalar  scalar/JS    SIMD   SIMD/JS   SIMD/scalar
  --  ----  --------   -----   -------  ---------   -----   -------   -----------
   9    3    38.4 KB    61.3     69.1       1.13×   124.8     2.04×         1.81×
   9    4    51.3 KB    50.6     59.7       1.18×   124.5     2.46×         2.08×
  17    3   489.4 KB    48.6     70.5       1.45×   125.0     2.57×         1.77×
  17    4   652.5 KB    50.2     57.8       1.15×   128.1     2.55×         2.22×
  33    3  6948.8 KB    59.9     69.4       1.16×   128.2     2.14×         1.85×
  33    4  9265.0 KB    50.0     59.5       1.19×   128.0     2.56×         2.15×
```

Verdict: **avg 2.39× over JS `int`** (min 2.04×, max 2.57×), and **avg
1.98× over WASM scalar 4D** (min 1.77×, max 2.22×). All six configs
bit-exact against both the scalar WASM kernel and the JS `_intLut_loop`
reference. Kernel size **1.6 KB** — about **37 % smaller than the
scalar 4D** (2.5 KB) thanks to replacing the rolled n-channel inner loop
+ 7 tail-dispatch sites with one pass over all channels in v128
registers.

The measured ~2.4× average vs JS slightly beats the original projection
("2.2–2.7×, roughly 130 MPx/s on RGB output") — we landed on the high
end of the range with essentially flat throughput (~125 MPx/s) across
every LUT size from 38 KB to 9 MB. The L1d → L2 → L3 transitions that
hurt the scalar 3D and scalar 4D kernels (9–45 % slowdown past L2)
barely register here: SIMD is doing so much less work per pixel that
memory latency is the bottleneck, and V8's prefetcher + the compact
4-corners-per-pixel access pattern keep it fed.

### Three specific wins worth calling out

1. **The `rk=0` short-circuit survives the SIMD port.** When the pixel
   lies exactly on a K grid plane (typical for CMYK regions with K=0 or
   K=255 — solid whites, rich blacks), the K-plane loop exits after one
   iteration and the tail rounds `(vU20 + 0x800) >> 12` directly to u8.
   Same cheap branch as the JS and scalar WASM kernels. On uniform-K
   workloads this pays out as roughly a 1.6× further speedup on top of
   the 2.4× base (paper-ish estimate — no synthetic "solid K" bench was
   run; the random input in the bench matrix mixes `rk=0` and `rk≠0`
   pixels).
2. **The K-LERP math stays in i32x4.** `(u20_K1 - u20_K0) * rk` where
   u20 ∈ [0, 2²⁰) and rk ∈ [0, 255] maxes out at ~2²⁸ signed — fits
   comfortably in `i32x4.mul` with no sign-extension to i64 needed.
   Same observation as 3D SIMD's `.sub`→`.mul`→`.add` triple: no
   widening, no narrowing, single-rounding design holds all the way
   through.
3. **One fewer register than scalar.** The SIMD kernel has no
   `$scratchPtr` parameter to carry and no i32.store/i32.load
   round-trip per channel per K-pass. The K0 u20 vector simply stays in
   `$vU20_K0`. That frees up both a GPR slot on the JIT side and ~2–3
   ns of L1 round-trip per pixel.

The flag-gated loop is identical to the scalar: `$kpass` starts at 0,
first iteration runs with `$tailMode` bound to the u20 stash (if
`interpK`) or direct u8 narrow (if not), the `br $k_loop` fires only
once, and the second pass falls through to the K-LERP + narrow + store.
~5 extra WAT instructions vs. "inline the 3D body twice", about 40 %
less `.wasm` for the same runtime behaviour.

A u16-output path falls out for free — the final narrow is the only
piece that's width-specific; skipping it and storing `vU20` gives a u16
output mode. That's the v1.3 hook — same SIMD plumbing, different tail.

## If you want to verify yourself

Every number in this page is reproducible with shipped tooling in
[`bench/wasm_poc/`](../../bench/wasm_poc/):

```bash
# WASM 3D tetrahedral matrix — 6 configs (g1 x cMax), bit-exact verification
# + speed vs the production JS int kernel. This is where the 1.40x number
# comes from:
node bench/wasm_poc/tetra3d_run.js

# WASM SIMD 3D tetrahedral matrix — same 6 configs, JS + WASM scalar + WASM
# SIMD side by side. This is where the 3.25x average number comes from.
# Bit-exact vs BOTH JS production and the shipping WASM scalar kernel:
node bench/wasm_poc/tetra3d_simd_run.js

# WASM scalar 4D — the function-call-cost lesson bench (1.22x avg):
node bench/wasm_poc/tetra4d_nch_run.js

# WASM SIMD 4D — the flag-gated loop + K0-in-v128 design (2.39x avg):
node bench/wasm_poc/tetra4d_simd_run.js

# End-to-end throughput (MPx/s) through the shipped dispatcher across
# all four lutModes, routed through Transform.transformArray():
node bench/mpx_summary.js
```

If your numbers differ meaningfully from the tables above, we want to
know — open an issue with your CPU, OS, Node version, and the raw bench
output attached. The 2.94-3.50× SIMD range is a direct read of your
CPU's `VPMULLD` + `v128.load64_zero` throughput; it will shift somewhat
on different microarchitectures but not so much that the relative
ordering of the kernels flips.

## Related

- [Architecture](./Architecture.md) — where the WASM kernels plug into
  the pipeline
- [LUT modes](./LutModes.md) — the user-facing `lutMode` surface these
  kernels implement
- [JIT inspection](./JitInspection.md) — the op-count and spill analyses
  that predicted the 1.4× scalar gain before we wrote a line of `.wat`
- [Performance](../Performance.md) — measured throughput in context, plus
  the lcms comparison
