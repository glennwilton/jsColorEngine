# jsColorEngine vs LittleCMS — the full comparison

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Bench](./Bench.md) ·
[Performance](./Performance.md) ·
[Roadmap](./Roadmap.md) ·
[Deep dive](./deepdive/) ·
[API: Transform](./Transform.md)

---

The [README](../README.md) carries the headline; this page carries the
detail, the caveats, and the history. If you're deciding whether the
numbers are trustworthy, this is the page to read.

**The claim we stand behind:** if you want the best single-threaded
colour-transform performance available in JavaScript, jsColorEngine is
it — consistently faster than [`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm)
(the LittleCMS WASM port, the engine a JS project would otherwise
install), and delivering compiled-C-class throughput from a JS/WASM
runtime.

**What this page is not:** a contest with LittleCMS. lcms is the
25-year reference implementation this engine learned from, and its
author has been generous with corrections
([#6](https://github.com/glennwilton/jsColorEngine/issues/6)). The
comparisons exist to answer one question honestly: *how fast can
colour management go in JavaScript?*

## Contents

- [Scope: single-threaded, engine vs engine](#scope-single-threaded-engine-vs-engine)
- [vs lcms-wasm — the comparison that matters for JS](#vs-lcms-wasm--the-comparison-that-matters-for-js)
- [vs native single-threaded C — historical, under re-measurement](#vs-native-single-threaded-c--historical-under-re-measurement)
- [The specialisation story](#the-specialisation-story)
- [Accuracy: a faithful peer, not a port](#accuracy-a-faithful-peer-not-a-port)
- [Reproduce everything yourself](#reproduce-everything-yourself)

---

## Scope: single-threaded, engine vs engine

Every number on this page is **one CPU core against one CPU core** —
same hardware, same profiles, same input bytes, same session. We're
measuring kernel quality, not deployment architecture.

That framing matters in both directions:

- A full native lcms2 deployment can go further than any number here —
  the GPL3 performance plugin pack adds SIMD kernels *and*
  multi-threading, and commercial CMMs go further still. We make no
  claim against a multi-core or GPU pipeline.
- A JS host (browser tab, web worker, AWS Lambda, headless Node
  worker) is usually a one-thread-per-worker world, so single-thread
  throughput is the number that actually predicts your frame rate.
  jsCE can also fan out across workers — that scaling is orthogonal
  and also not measured here.

## vs lcms-wasm — the comparison that matters for JS

`lcms-wasm` is LittleCMS 2.16 compiled to wasm32 via Emscripten — the
engine the JS ecosystem reaches for when it needs ICC colour today.
It's also the comparison people get wrong by assumption: **WASM is not
automatically faster than JS.** Measured, jsColorEngine's pure-JS
kernels beat lcms-wasm on every workflow, before jsCE's own WASM
kernels are even enabled:

- **Pure JS (`lutMode: 'int'`): 1.5–2.1× faster** than lcms-wasm's
  best configuration across RGB→Lab, RGB→CMYK, CMYK→RGB, CMYK→CMYK
  (Node, pinned-heap-buffer lcms setup — its production-realistic
  best case).
- **WASM SIMD (`'int-wasm-simd'`, the default for int8 + LUT):
  3.2–5.7× on x86_64, 3.2–6.4× on Apple Silicon** (lcms-wasm has no
  SIMD in its build; the gap is widest on 4D CMYK paths).
- **16-bit ladder: 3.9–4.9×** over lcms-wasm's 16-bit path on every
  workflow (Chrome, x86_64).

Why does plain JS beat a WASM build of C? Because the comparison isn't
"JS vs C" — it's one hand-specialised kernel per LUT shape (tuned for
TurboFan, zero allocations, no FFI) versus a general-purpose
stage-walker carrying lcms2's full format-dispatch generality through
an Emscripten boundary with no SIMD and no fast-float plugin. Detailed
breakdown: [bench/lcms-comparison/README.md](../bench/lcms-comparison/README.md)
§"Why does JS beat WASM here?".

Bundle size is part of the same story: jsCE is ~267 KB raw / ~68 KB
gzip in one file with WASM inlined (no fetch, sync init); lcms-wasm is
a 41 KB shim + ~309 KB `.wasm` (~129 KB gzip combined, two fetches,
async init).

## vs native single-threaded C — historical, under re-measurement

> **Status (Aug 2026): treat the table below as historical.**
> Marti Maria — LittleCMS's author — reviewed our harness in
> [#6](https://github.com/glennwilton/jsColorEngine/issues/6): our
> benchmark wasn't calling the lcms API optimally, and the GPL3
> performance plugin pack (not part of the MIT build we measured)
> lifts native lcms substantially further — he quotes an easy 10×+
> with plugins. He reports far higher figures from a corrected test
> program; we haven't yet reproduced them or confirmed the
> configuration (the plugin pack includes a **multi-threading**
> plugin, so plugin-enabled figures are not necessarily
> single-thread, and lcms's one-pixel transform cache makes results
> sensitive to the input image's pixel repetition). We're re-running
> with his corrections, single-threaded both ways, and will publish
> whatever comes out.

The original harness (WSL2 / Ubuntu, gcc 10.5
`-O3 -march=native -ffast-math -funroll-loops -flto`, `taskset -c 0`,
"steelman" build of stock MIT lcms2, 65 K random-noise pixels/iter)
measured:

| Workflow | jsCE `int` (pure JS) | lcms2 native steelman | jsCE / native |
|---|---|---|---|
| RGB → RGB    (sRGB → AdobeRGB1998, matrix) | 72 MPx/s  | 157 MPx/s | 0.46× (native — matrix-shaper path) |
| RGB → CMYK   (sRGB → GRACoL)               | 54 MPx/s  | 49 MPx/s  | 1.10× |
| CMYK → RGB   (GRACoL → sRGB)               | 53 MPx/s  | 34 MPx/s  | 1.56× |
| CMYK → CMYK  (GRACoL → GRACoL)             | 44 MPx/s  | 29 MPx/s  | 1.52× |
| RGB → RGB    (sRGB→GRACoL→sRGB, soft-proof) | ~72 MPx/s | 51 MPx/s | 1.41× |

> ### ⚠ Second reason the table above is wrong — and this one is our fault
>
> **The build flags handicapped lcms.** Every native figure here was
> produced with `-march=native`. Sweeping compiler flags on a Ryzen
> 7700X (`bench/lcms_c/flag_sweep.sh`, noise content, cache off, 1 M px,
> median of 5) shows `-march=native` at or near the **bottom** on every
> workflow:
>
> | CFLAGS | RGB→Lab | RGB→CMYK | CMYK→RGB | CMYK→CMYK |
> |---|---:|---:|---:|---:|
> | `-O2` | **83.6** | **71.5** | 36.3 | 29.9 |
> | `-O3` | 72.5 | 66.2 | **39.5** | 33.6 |
> | `-O3 -DNDEBUG -fno-strict-aliasing` | 73.0 | 65.1 | 37.9 | **34.7** |
> | `-O3 -march=native` | 69.9 | 61.1 | 35.6 | 32.8 |
> | `-O3 -DNDEBUG -march=native -fno-strict-aliasing` *(old default)* | 67.9 | 62.6 | 37.0 | 30.2 |
> | `-O3 -DNDEBUG -march=native -ffast-math -funroll-loops -flto` *(the "steelman" above)* | 71.1 | 65.4 | 37.2 | 33.3 |
>
> The build we called a *steelman* was one of the slower ones. Plausible
> on Zen 4 — AVX-512 downclocking, or gcc choosing worse vectorisation
> for lcms's interpolation loops — but the cause matters less than the
> effect.
>
> **What this does to the claims above.** lcms's best measured build
> reaches ~71.5 MPx/s on RGB → CMYK, against the 49 quoted. That row
> does not merely narrow, it **reverses**: jsCE's 54 becomes ~0.76× of
> native, not 1.10×. The two CMYK rows survive but shrink materially
> (~1.34× and ~1.27×).
>
> No single flag set wins everything — `-O2` takes the RGB workflows,
> `-O3` variants the CMYK ones — so the replacement table should quote
> **lcms's best build per workflow** and say so. A comparison that gives
> the other engine anything less is not worth publishing.
>
> The Makefile default has been changed to drop `-march=native`, and
> `flag_sweep.sh` should be run on the measuring machine before any
> figure is published. Superseded numbers stay here rather than being
> deleted, so the correction is on the record.

On that harness, pure JS matched or beat the stock build on 4 of 5
workflows, and jsCE WASM SIMD led all five. We also measured lcms2's
`fast-float` SIMD plugin directly (`make fastfloat` in
[`bench/lcms_c/`](../bench/lcms_c/)): it dominated matrix-shaper
RGB→RGB (~455 MPx/s) and changed nothing on the LUT-based workflows —
each engine won exactly where it had specialised. Full flag-by-flag
analysis: [Performance.md — Steelmanning the steelman](./Performance.md#steelmanning-the-steelman--fast-float-measured-directly).

Even at face value the original numbers support one careful claim —
**a JIT-compiled JS kernel runs in the same performance class as
optimised single-threaded native C for LUT-based colour transforms.**
That's the existence proof we care about ("JavaScript isn't the
bottleneck"), and it survives whatever the corrected lcms numbers turn
out to be, because it's about jsCE's absolute throughput, not the
scoreboard.

Known issues the re-run addresses:

1. **API usage** — adopt Marti's corrected calling code once we have
   it (the hosted copy went missing; we've asked for it again).
2. **`cmsFLAGS_HIGHRESPRECALC` retired as a "steelman" variant** — per
   upstream it's a legacy lcms 1.x emulation flag, not a bigger-grid
   switch. `flags = 0` is the representative lcms configuration.
   (This same correction *improved* our accuracy story — see below.)
3. **Input content sensitivity** — lcms memoizes the last-seen pixel;
   pure random noise (our generator) is its worst case, smooth
   gradients its best. Measured below.
4. **Thread accounting** — results must self-document as
   single-threaded.

### First re-measurement data — input content matters 2–3× (Aug 2026)

The harness now takes `BENCH_INPUT=gradient` (photo-like smooth
content with flat 4–8 px runs, approximating real images) alongside
the original per-byte random noise. Same box as the original run
(WSL2 Ubuntu 20.04, `taskset -c 0`, single thread, stock lcms2 **2.18**,
`flags = 0`, 65 K px/iter):

| Workflow | lcms2, noise | lcms2, gradient | lcms2, solid colour | max lift |
|---|---|---|---|---|
| RGB → RGB (matrix)  | 161.5 MPx/s | 161.0 MPx/s | 171.3 MPx/s | — |
| RGB → CMYK          | 49.8 MPx/s  | 105.5 MPx/s | 163.7 MPx/s | **3.3×** |
| CMYK → RGB          | 35.3 MPx/s  | 92.4 MPx/s  | 161.4 MPx/s | **4.6×** |
| CMYK → CMYK         | 30.2 MPx/s  | 86.6 MPx/s  | 157.9 MPx/s | **5.2×** |
| soft-proof (3D LUT) | 53.0 MPx/s  | 108.2 MPx/s | 170.8 MPx/s | **3.2×** |

(The noise column reproduces the original published numbers within
run noise — 49.8/35.3/30.2 vs 49/34/29 — so the old table wasn't
wrong, it was *content-specific*. `BENCH_INPUT=solid` — the whole
image one colour — is the cache's best case: every workflow converges
to the same ~160–170 MPx/s, which is the cache-hit ceiling on this
box: at 100 % hits lcms does no interpolation at all, just a
compare + output copy per pixel.)

jsCE on the same three generators is essentially content-neutral — it
has no memo cache, every pixel pays full interpolation
(`lutMode: 'int'`, same box: RGB→CMYK 69/73/73, CMYK→RGB 64/50/51,
CMYK→CMYK 53/40/42 MPx/s for noise/gradient/solid).

What this means, honestly stated:

- **On noise-like content** (the original benchmark), pure-JS jsCE
  beats stock single-threaded native lcms on the LUT workflows — as
  originally published.
- **On photo-like content**, lcms's one-pixel cache flips the pure-JS
  comparison: stock native lcms (86–108 MPx/s) overtakes jsCE's JS
  `int` kernel (41–73 MPx/s).
- **jsCE's WASM SIMD tier (~128–212 MPx/s on this box) stays ahead of
  stock single-threaded native lcms on every LUT workflow under
  either content type.**
- Real images sit between the two generators (flat regions *and*
  detail), so neither column alone is "the" number — which is exactly
  why the honest headline is jsCE's absolute single-threaded
  throughput, not a beat-native scoreboard.

It also bounds the remaining gap to Marti's reported figures
(1,200–1,600 MPx/s on an older i7): content sensitivity accounts for
~2–3×; the rest is the GPL3 plugin pack (`fast_float` SIMD and/or the
multi-threading plugin) and any further calling-convention gains —
still to be measured when his corrected harness is back online.

*(Engineering note: that memo cache now exists as an opt-in
`pixelCache` on the accuracy path, plus a 4D-kernel POC — see
[deepdive/PixelCache.md](./deepdive/PixelCache.md). Measured on the
kernel it costs ~8 % on noise and pays 1.5–3.6× on repetitive content,
which is the same trade lcms makes.)*

---

## Release comparison — TEMPLATE, NOT YET MEASURED

> **Do not quote anything below until it is filled in.** Empty cells
> mean unmeasured, never zero. This structure exists so the numbers can
> be produced in one controlled session rather than assembled from runs
> made months apart on different machines — which is how the historical
> section above ended up needing corrections.

### Conditions (fill in first — the numbers are meaningless without these)

| | |
|---|---|
| Date | |
| CPU / RAM | |
| OS / kernel | |
| Compiler + **exact CFLAGS** | |
| lcms2 version (native) | |
| lcms-wasm version | |
| Node version / V8 | |
| Browser + version (if browser figures included) | |
| jsColorEngine version | |
| Profiles used | |

**Settle the compile flags before running.** `-march=native` measured
*slower* than plain `-O3` on a Ryzen 7700X (~20–30 % on the RGB
workflows). Sweep with `bench/lcms_c/flag_sweep.sh` and give lcms its
**best** build — a comparison that handicaps the other engine is worth
nothing. State the winning flags in the table above.

### Table 1 — Single-threaded, like-for-like (the only comparable claim)

One block per workflow. `adj%` is the share of pixels byte-identical to
the previous one — what a one-pixel cache can hit — and belongs in the
table because it explains every difference between the content rows.

Repeat this block for: RGB→Lab, RGB→CMYK, CMYK→RGB, CMYK→CMYK,
soft-proof (sRGB→GRACoL→sRGB), RGB→RGB matrix-shaper.

**Workflow: _______**

| content | adj % | jsCE `int` | jsCE WASM SIMD | jsCE + pixelCache | lcms-wasm | lcms-wasm NOCACHE | lcms native | lcms native NOCACHE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0.0 | | | | | | | |
| gradient | 75.0 | | | | | | | |
| blocks16 | 93.8 | | | | | | | |
| solid | 100.0 | | | | | | | |
| photo corpus (mean) | | | | | | | | |

Notes for whoever fills this in:

- **`blocks16` is Marti Maria's generator** (16×16 flat colour blocks).
  Include it: his revised harness uses it, so it is the row that makes
  his figures reproducible rather than contradictory.
- **The NOCACHE columns are not padding.** Where cache and NOCACHE
  agree, the number is the transform's real throughput; where they
  diverge, the gap is the memo cache. Without them a content change
  looks like a library difference.
- The photo-corpus row needs a stated corpus. `samples/images/` is
  **not** suitable — those are AI-adjusted and read far more repetitive
  than camera output (see PixelCache.md).

### Table 2 — Buffer-size sensitivity

Small, and expected to be undramatic — early runs showed 64K and 1024K
within noise of each other. Worth publishing precisely because it
forecloses "you measured on a buffer that fits in cache".

| engine | 16K px | 64K px | 1M px | 10M px |
|---|---:|---:|---:|---:|
| jsCE `int` | | | | |
| jsCE WASM SIMD | | | | |
| lcms-wasm | | | | |
| lcms native | | | | |

### Table 3 — The full picture (NOT comparable — shown for honesty)

These are the configurations jsColorEngine has no equivalent of. They
exist so a reader sees the whole landscape and understands exactly
which claim is being made, instead of discovering the gap elsewhere and
assuming it was hidden.

| configuration | throughput | jsColorEngine equivalent |
|---|---:|---|
| lcms native + `fast_float` plugin (GPL3) | | *none — no SIMD-specialised float path* |
| lcms native + multi-threading plugin (GPL3) | | *none — see note on Web Workers* |
| lcms native, N threads (manual split) | | *not implemented* |
| GPU / other acceleration | | *none* |

**On multi-core.** The single-threaded framing throughout this document
is about making a like-for-like comparison, not a claim that
single-core is the right way to ship. The JavaScript equivalent is Web
Workers over image strips; it works, and it is not currently measured
here. Single-thread throughput matters because it sets the floor for
what each worker achieves. Marti Maria's reported 1,200–1,600 MPx/s
belongs in this table, not against Table 1.

### How to produce it

```bash
# native lcms — content x cache x size, all in one run
cd bench/lcms_c && bash flag_sweep.sh          # pick CFLAGS first
./bench_content_matrix --sizes 16384,65536,1048576,10485760

# lcms-wasm + jsCE, same content axes
cd bench/lcms-comparison && npm install && node bench.js

# jsCE pixel cache, per content class
node bench/pixel_cache/cache_bench.js --images <real corpus>
```

The C harness prints `adj%` per content row, so Table 1's second column
comes straight from it and does not need to be derived by hand.

---

## The specialisation story

The honest explanation for every result above, in both directions:
throughput in this problem domain comes from **specialising the inner
loop**, not from the implementation language.

- jsCE specialises at LUT-build time: one unrolled kernel per
  (dimension × channels × dataFormat), resolved once at `create()`,
  monomorphic at the call site. V8/TurboFan compiles that to machine
  code comparable to `gcc -O3` output — the
  [JIT inspection deep dive](./deepdive/JitInspection.md) has the
  disassembly.
- Stock lcms2 stays general: one stage-walker handling every pixel
  format, profile class, and precision — which is exactly what you
  want from a reference implementation, and exactly what a compiler
  can't specialise away.
- lcms's `fast-float` plugin specialises too — and where it does
  (matrix-shaper), it wins. The plugin pack's threading multiplies
  whatever the kernel does by the core count. Same lesson at every
  turn: the fast path is the specialised path.

## Accuracy: a faithful peer, not a port

Speed claims mean nothing if the outputs differ. Two harnesses:

- **Float pipeline vs lcms native f64 oracle** — worst case 0.06 ΔE76
  (Lab), 1.24 LSB (8-bit RGB), 0.04 % ink (CMYK) across 130 reference
  files / ~580 k samples. [Accuracy deep dive](./deepdive/Accuracy.md).
- **Image-path LUT vs lcms-wasm** — **100 % of samples within 1 LSB
  (max 1 LSB) on all four workflows** against lcms's default
  pipeline. Notably, this result *improved* after Marti's feedback:
  our old oracle used HIGHRESPRECALC and showed a small out-of-gamut
  tail (98.5 % / max 14 LSB on CMYK→RGB) that turned out to be an
  artifact of the legacy emulation path, not a real disagreement.
  [bench/lcms-comparison/README.md](../bench/lcms-comparison/README.md).

## Reproduce everything yourself

```bash
# In-browser bench vs lcms-wasm (the canonical numbers) — localhost:8080
npm run serve

# Node: jsCE throughput summary (JS kernels)
node bench/mpx_summary.js

# Node: speed + accuracy vs lcms-wasm
node bench/lcms-comparison/bench.js
node bench/lcms-comparison/accuracy.js            # lcms default oracle
node bench/lcms-comparison/accuracy.js --highres  # legacy oracle (diagnostic)

# Native C comparison (WSL2/Linux; ~5 min) — historical harness, see above
cd bench/lcms_c && make && ./bench_lcms
```

If your numbers disagree with ours, open an issue with the raw output
— methodology critiques are as welcome as results. This page exists
because one already made the comparison more honest.
