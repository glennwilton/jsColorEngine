# Browser bench — run jsColorEngine on your own machine

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Performance](./Performance.md) ·
[Roadmap](./Roadmap.md) ·
[Deep dive](./deepdive/) ·
[Examples](./Examples.md) ·
[API: Profile](./Profile.md) ·
[Transform](./Transform.md) ·
[Loader](./Loader.md)

---

**Don't trust our numbers — run them yourself.**

[`bench/browser/`](../bench/browser/) is a fully self-contained, zero-
upload, in-browser benchmark. Clone the repo, start a tiny local
static server, open `http://localhost:8080/`, and the page runs every
`lutMode` × every direction × the real lcms-wasm library right there
on your hardware. All the MPx/s numbers in
[`docs/Performance.md`](./Performance.md) and the headline table in
the [README](../README.md) were measured this way — and you can
reproduce them (or disagree with them) on your own CPU / browser in
about a minute.

No telemetry, no upload — everything runs locally. Your browser is
the only thing measured.

## Quickstart

From the repo root:

```sh
# 1. Build the browser (UMD) bundle. Re-run after any src/ change.
npm run browser

# 2. Install lcms-wasm (one-time; lives in a sub-package so the main
#    install stays light). Skip to omit the lcms comparison rows.
cd bench/lcms-comparison && npm install && cd ../..

# 3. Start the static server. Zero deps, just Node's built-in http.
npm run bench:browser
#   or:  node bench/browser/serve.js
#   or:  node bench/browser/serve.js --port=9000
```

Open <http://localhost:8080/> in your browser. The page boots, fetches
the GRACoL2006 ICC profile, loads lcms-wasm, and lights up the run
buttons.

Stop the server with `Ctrl+C` in the terminal.

---

## The five tabs, at a glance

| Tab | What it tells you | When to reach for it |
|---|---|---|
| **Full comparison** | Steady-state MPx/s for every mode × every direction, with summary cards for the Accuracy and Image use-cases | The headline test — this is the tab that produces the numbers quoted in [Performance.md](./Performance.md) |
| **Accuracy sweep** | ΔE76 round-trip (Lab → device → Lab) through the full-float jsce pipeline, for both matrix (RGB) and 4D-tetra (CMYK) kernels | When you want to see *how accurate* the accuracy path really is, independent of speed |
| **JIT warmup curve** | Per-iter ms plotted across N iterations, showing the V8 Ignition → Sparkplug → TurboFan tier-up ramp | When you suspect your results are polluted by warmup, or just want to see the tier-up visually |
| **Pixel-count sweep** | Same direction × mode swept from 4 K to 4 M pixels per batch — shows throughput as the working set outgrows L1 / L2 / L3 | When the "headline MPx/s" feels suspiciously good and you want to see memory-bandwidth effects |
| **About this bench** | Methodology essay — modes, directions, LUT-column derivation, reproducibility notes | First stop if you want to understand *why* a number is what it is |

---

## Tab 1: Full comparison

The headline test. Runs every direction × every mode and writes a row
per cell.

### Directions

| Direction | Profiles | Why this pair |
|---|---|---|
| **RGB → RGB**  | `sRGB` → `AdobeRGB1998` | Matrix + 1D curves on both sides; pure linear algebra. **Must not be `sRGB → sRGB`** — see [the identity gotcha](#the-identity-gotcha-why-rgb-rgb-is-srgb-adobergb-not-srgb-srgb) below |
| **RGB → CMYK** | `sRGB` → `GRACoL2006_Coated1v2` | Matrix-shaper on input, 3D tetrahedral LUT on output. A real print-production workload |
| **CMYK → RGB** | `GRACoL` → `sRGB`       | 4D tetrahedral on input, matrix-shaper on output |
| **CMYK → CMYK** | `GRACoL` → `GRACoL`     | Same profile both sides, but **not** an identity — AToB and BToA tags aren't mathematical inverses (intent, BPC, quantisation break the symmetry). Measured ~25 MPx/s on lcms-wasm vs ~165 MPx/s on an sRGB→sRGB passthrough, so we know it's real work |

### Modes

Eight cells per direction:

| Mode | What it is |
|---|---|
| **`jsce no-LUT` (f64)** | `buildLut: false`. Every pixel walks the full per-stage pipeline in 64-bit float. The accuracy configuration — slowest by design, most faithful math jsColorEngine can produce. Roughly comparable to `lcms NOOPTIMIZE` |
| **`jsce float`** | `buildLut: true` + `lutMode: 'float'`. Float64 CLUT, tetrahedral interp in f64. Same interp math as no-LUT but the pipeline pre-collapses to a LUT so it's much faster |
| **`jsce int`** | u16 CLUT (Q0.16 weights), int32-specialised tetrahedral kernel via `Math.imul`. v1.1 default. Bit-exact vs the float path on 8-bit I/O |
| **`jsce int-wasm-scalar`** | Same int math compiled to WebAssembly. ~1.4× over `int` on 3D, ~1.2× on 4D |
| **`jsce int-wasm-simd`** | Channel-parallel WASM SIMD. ~3.0–3.5× over `int` on 3D, ~2.1–2.6× on 4D. Falls back to scalar if your browser lacks WASM SIMD |
| **`lcms default`** | LittleCMS 2.16 compiled to wasm32, `flags = 0`. What every real-world lcms app uses — lcms picks the precalc LUT grid from the input channel count. Pinned heap buffers |
| **`lcms HIGHRES`** | Same, with `cmsFLAGS_HIGHRESPRECALC` — 49-grid for RGB, 23-grid for CMYK. The accuracy ceiling of the LUT path |
| **`lcms NOOPT`** | Same, with `cmsFLAGS_NOOPTIMIZE` so each call walks the full per-pixel pipeline. The lcms equivalent of jsce `no-LUT` and the fair accuracy-vs-accuracy comparison |

### Per-cell metrics

Each row captures five numbers:

1. **LUT build** — wall-clock of `new Transform(...).create(...)`.
   Includes pipeline build, integer-mirror LUT bake (for `int*`
   modes), and WASM compile / instantiate (for `int-wasm-*` modes).
   One-shot, paid once per Transform. For lcms it's
   `cmsCreateTransform(...)`.
2. **Cold 1st** — the very first `transformArray()` (or
   `_cmsDoTransform`) call. Captures Ignition → Sparkplug →
   TurboFan tier-up cost on the JS path, and first-touch page
   faults / cache misses on the WASM linear-memory path. Always
   slower than steady-state hot; the gap is "JIT warmup tax", not
   "the kernel is slow".
3. **Hot ms** — 200+ warmup iters (V8 stabilised), median of 5 timed
   batches. The number to report when quoting MPx/s.
4. **MPx/s** — `pixelCount / 1e6 / (hotMs / 1000)`.
5. **vs `int`** — speedup vs jsColorEngine `int` for the same
   direction. Apples-to-apples "what does the WASM / SIMD port buy
   us" number; matches the figures in
   [Performance.md](./Performance.md).

The rightmost column in each row is a bar normalised per direction so
the fastest mode for that direction fills the bar — easy at-a-glance
ranking.

### Summary cards (top of panel)

Four cards call out the best-of-direction numbers for the two
canonical use-cases:

- **Accuracy · jsColorEngine** — best `no-LUT` MPx/s across the
  four directions
- **Accuracy · lcms-wasm** — best `NOOPTIMIZE` MPx/s
- **Image · jsColorEngine** — best LUT mode (`float` / `int` /
  `int-wasm-*`) per direction
- **Image · lcms-wasm** — best LUT flag (`default` or `HIGHRES`)

The cards pair up for direct use-case comparison: if you're doing
colour-critical work, compare the two Accuracy cards; if you're
processing pixels for display / export / conversion, compare the two
Image cards. Raw speed is half the story — the use-case match
determines whether you should care.

### Copy markdown

The "Copy markdown" button at the top right copies the full result
table to the clipboard — pre-formatted for pasting into a GitHub
issue, release note, or forum post. The markdown includes your
browser / UA / core count / page-secure state, so the numbers are
self-documenting when shared.

---

## Tab 2: Accuracy sweep

**jsColorEngine only.** Sweeps the full Lab colour space (L = 0…100,
a = −120…120, b = −120…120), converts every Lab point to a target
profile's native device space as a **float object** (no 8-bit / 16-bit
quantisation), then converts back and measures residual ΔE76. This is
the most accurate path the engine ships — full f64 pipeline, no LUT,
no `dataFormat` rounding.

Two round-trips run per click, one per math kernel:

- **RGB** — matrix + per-channel curves. Pure linear algebra
- **CMYK** — 4-input tetrahedral interpolation against the profile's
  BToA / AToB pipeline

In this path the per-object overhead (object allocation, whitepoint
carry-over, Lab staging) dominates over the math, so both kernels
typically land in the same 1–4 M round-trip/s ballpark. The raw
math-kernel gap shows up much more starkly in the Full comparison
tab's LUT-accelerated 8-bit image path, where per-pixel work drops
low enough for the actual kernel cost to matter.

**lcms-wasm is not included here.** Its high-level binding exposes
8-bit and 16-bit buffer APIs but no per-object float path, so the
comparison wouldn't be like-for-like. For a pure-float lcms round-
trip you'd need `cmsDoTransform` with `TYPE_Lab_DBL` /
`TYPE_CMYK_DBL` buffers, not currently wired up.

Step granularity is user-selectable from 10 (~6 875 points) to 1
(~5.9 M points, slow). An "in-gamut subset only (ΔE < 2)" checkbox
narrows the stats to the points that actually round-tripped cleanly,
so gamut-clipping outliers don't drown the median.

---

## Tab 3: JIT warmup curve

One direction × one mode, run N times in a row, plot per-iter ms.

For JS modes you'll see the classic V8 ramp:

```
ms/iter
   3 |  ▒▒▒▒                                  Ignition (slow)
   2 |       ▒▒▒                              Sparkplug
   1 |           ▒▒▒▒▒▒                       TurboFan tier-up
 0.5 |                  ───────────────       steady state
     +-----------------------------------> iter
```

For WASM modes the curve is much flatter — compile happens once at
`create()` time, so by iter 1 you're already in steady state.

Useful for:

- Verifying the Cold / Hot gap reported in tab 1 is real (not noise)
- Spotting GC pauses (vertical spikes)
- Tuning warmup-iter counts for your own workload

---

## Tab 4: Pixel-count sweep

Same direction × mode swept across pixel counts from 4 K to 4 M per
batch.

The headline MPx/s in tab 1 uses 65 K (256×256) by default, which
fits comfortably in L2 — that's flattering. This tab shows what
happens as the buffer outgrows L2 and L3 and memory bandwidth becomes
the bottleneck instead of compute. Throughput should be:

- **Roughly flat** for the WASM SIMD modes — memory-bandwidth-bound
  from the start
- **Falls off gradually** for the JS modes as cache misses dominate

If your numbers don't match this shape (e.g. SIMD mode falling off a
cliff past 1 M), you've probably got a thermal or contention issue.
Close other tabs, re-run.

---

## The identity gotcha — why RGB→RGB is sRGB → AdobeRGB, not sRGB → sRGB

This is the single most important methodology detail, and the one
place a naïve setup lets one engine silently cheat.

When source and destination are the same profile (or any profile pair
that mathematically cancels), lcms's `_cmsOptimizePipeline` detects
the identity at `cmsCreateTransform()` time and collapses the hot
path to a byte copy. Measured impact: **~+80 %** on lcms-wasm
RGB → RGB throughput, purely from the bogus passthrough. In Firefox
we saw 165 → 91 MPx/s moving from `sRGB → sRGB` to `sRGB → AdobeRGB`,
same machine, same session. That is the size of the cheat.

jsColorEngine doesn't have an equivalent identity-elision pass (it
would win nothing for how people actually use it), so it was never
affected by the wrong setup. But the matrix-shaper collapse is a
legitimate optimisation — we just have to exercise it against a
**different** RGB profile so the work is real.

`__tests__/AdobeRGB1998.icc` is the 560-byte reference Adobe RGB
(1998) profile. lcms-wasm doesn't export `cmsCreateRGBProfile` or
`cmsBuildGamma`, so the bench loads the ICC bytes directly rather
than synthesising the profile in memory.

The full journey on this one discovery — how we tripped over it,
what the wrong number looked like, how we fixed it — lives in
[Performance.md § 3.1](./Performance.md#31-lcms-wasm-rgbrgb-is-a-no-op--a-benchmarking-trap).

---

## How the LUT column is derived

The LUT column in the results table is ground truth, not a guess.

For jsColorEngine we read it straight from the Transform
(`xform.lut.g1` / `xform.lut.inputChannels` /
`xform.lut.intLut.CLUT`).

For lcms-wasm, which doesn't expose the precalc-LUT shape via its
public API, we mirror the exact rule from
`lcms2-2.18/src/cmspcs.c :: _cmsReasonableGridpointsByColorspace`:

| Input channels   | default | `HIGHRESPRECALC` | `LOWRESPRECALC` |
|------------------|---------|------------------|-----------------|
| 1 (mono)         | 33      | 49               | 33              |
| 3 (RGB, Lab)     | 33      | 49               | 17              |
| 4 (CMYK)         | 17      | 23               | 17              |
| > 4 (HiFi)       | 7       | 7                | 6               |

So the RGB → CMYK row with `lcms default` shows `33×33×33 u16` (grid
indexed by the 3-channel RGB input, default branch), and the
CMYK → RGB row with `lcms HIGHRES` shows `23×23×23×23 u16` (4-channel
CMYK input, HIGHRES branch). jsColorEngine's own grid picks happen
to line up with lcms's defaults — `33³` for RGB input, `17⁴` for
CMYK — which is convergent-evolution, not coordinated. Both engines
arrive at the same size / fidelity trade-off.

---

## Is lcms-wasm actually running at full speed?

**Yes.** Verified by construction:

- Input and output buffers are `_malloc`'d once at `create()` time
  and reused across every call (*pinned heap buffers*).
- The hot path calls `_cmsDoTransform(xf, inPtr, outPtr, pixelCount)`
  **directly** — the raw C export. We deliberately skip
  `lcms.cmsDoTransform(...)` (no underscore) because that high-level
  wrapper does `_malloc` + `new Uint8Array(HEAPU8, …).set()` +
  `ccall` + `.slice()` + `_free ×2` *per call* — an order-of-
  magnitude slowdown. We give lcms the same pinned-heap path a
  production app would use.
- Three flag variants are tested: `flags=0`, `HIGHRESPRECALC`, and
  `NOOPTIMIZE`. The best of the three is "lcms at its best".
- Same seeded-PRNG input bytes as jsColorEngine, same
  `INTENT_RELATIVE_COLORIMETRIC`, same `TYPE_*_8` formats, same
  profiles, same pixel count.

**Where does the speed gap come from, then?** lcms-wasm is a stock
Emscripten build of LittleCMS 2.16 **without** `-msimd128`, so every
lcms kernel runs scalar regardless of host SIMD support.
jsColorEngine's `int-wasm-simd` path ships hand-tuned channel-
parallel v128 kernels for 3D and 4D tetrahedral interpolation.
That's a real capability gap, not a benchmark bias — the "lcms-wasm"
line in the engine-info panel says `scalar build (no -msimd128)`
precisely to flag this.

A SIMD-compiled lcms-wasm (same source, built with
`-msimd128 -O3`) would close a lot of the gap. We'd welcome that
comparison if anyone wants to rebuild lcms with SIMD on and ship it
back to `bench/lcms-comparison/node_modules/lcms-wasm/dist/lcms.wasm`
— open a PR.

---

## How this stays honest

- **Same input bytes both sides.** Seeded PRNG (seed =
  `0x13579bdf`, LCG with the same constants as
  [`bench/mpx_summary.js`](../bench/mpx_summary.js) and
  [`bench/lcms-comparison/bench.js`](../bench/lcms-comparison/bench.js))
  produces identical pixel buffers for jsColorEngine and lcms-wasm.
  Cache effects are the same on both sides.
- **Same intent, same depth.** `INTENT_RELATIVE_COLORIMETRIC`,
  `dataFormat: 'int8'` for jsColorEngine, `TYPE_*_8` for lcms.
- **Pinned WASM heap buffers for lcms.** Pre-`_malloc`'d once, reused
  between calls — the production-realistic path (matches the design
  assumption that an app would allocate per-frame buffers up front).
- **Median of 5 timed batches after a 200-iter warmup.** One GC pause
  in one batch doesn't poison the steady-state number.
- **`requestAnimationFrame` yielding between configs only**, not
  inside the timed loops — keeps the browser responsive without
  breaking V8's hot-path optimisations.
- **No DOM mutation inside the timed regions.** Progress and result
  updates happen between configs, after the timed batch closes.

---

## Caveats & reproducibility tips

- **Run with the browser tab focused.** Background tabs throttle
  `setTimeout` and (in some browsers) reduce `performance.now()`
  precision. Both scramble the numbers.
- **Close other heavy tabs / apps.** CPU contention shows up
  directly in MPx/s.
- **First run after page load includes WASM compile + profile decode.**
  Hit "Run benchmark" twice for stable numbers — the second run hits
  warm caches everywhere.
- **Numbers are highly reproducible (±5 %) within one browser, but
  can swing 30 %+ across browsers.** Chrome, Firefox, and Safari
  each have very different V8 / SpiderMonkey / JavaScriptCore
  tier-up curves. Use a single browser when comparing modes.
- **Mobile CPUs throttle aggressively under sustained load.** The
  "Hot iters" setting is conservative by default; bumping it on
  mobile can show throttling kick in (MPx/s sliding down across
  batches in the warmup-curve tab).
- **WASM SIMD missing?** The page detects via `WebAssembly.validate()`
  of a minimal v128-using module. If your browser lacks SIMD, the
  engine-info panel shows `WASM SIMD: NOT AVAILABLE` and
  `int-wasm-simd` rows will run the scalar fallback (tagged with
  `[int-wasm-scalar]` in the Mode cell).
- **lcms-wasm not loaded?** The bench still runs; only the lcms rows
  are skipped. `cd bench/lcms-comparison && npm install` enables
  them.

---

## Submitting your results

If your numbers are meaningfully different from the headline table
in [Performance.md](./Performance.md) or the README — faster, slower,
or the ratios don't match — we want to see it.

1. Run the Full comparison tab to completion on your machine.
2. Click **Copy markdown**. The clipboard now has the full result
   table, pre-formatted with your browser / CPU cores / user-agent
   header.
3. Open an [issue on GitHub](https://github.com/glennwilton/jsColorEngine/issues/new)
   with a title like `bench: <OS> / <browser> / <CPU> — <headline number>`
   and paste the markdown into the body. If you've spotted a
   methodology issue rather than a perf one, note that in the title
   instead (`bench-methodology: <what you noticed>`).

We'll fold the numbers into [Performance.md's § 1 caveats](./Performance.md#1-where-we-are--current-numbers)
or open a follow-up issue to investigate. **Critique of the
methodology is equally welcome** — if the test is broken we'd rather
hear about it than keep quoting biased numbers.

---

## Related

- [Performance.md](./Performance.md) — the numbers this bench
  produces, explained, with the journey + lessons around them
- [Deep dive / WASM kernels](./deepdive/WasmKernels.md) — why the
  SIMD rows land where they do
- [Deep dive / LUT modes](./deepdive/LutModes.md) — what each
  `lutMode` actually does inside
- [`bench/browser/`](../bench/browser/) — the bench source; each
  file's role is documented in its header comment
- Other benches shipping in the repo:
  [`bench/mpx_summary.js`](../bench/mpx_summary.js) (Node headline
  throughput),
  [`bench/jit_inspection.js`](../bench/jit_inspection.js) (V8 op-count
  and deopt analysis),
  [`bench/wasm_poc/`](../bench/wasm_poc/) (WASM kernel matrix),
  [`bench/lcms-comparison/`](../bench/lcms-comparison/) (Node
  head-to-head vs lcms-wasm),
  [`bench/lcms_c/`](../bench/lcms_c/) (native-C lcms2 baseline —
  requires gcc / clang via WSL2 or MinGW-w64)
