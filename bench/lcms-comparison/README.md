# jsColorEngine vs lcms-wasm — MPx/s comparison

A **self-contained side-project** that benchmarks
[`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm) (a WASM port of
LittleCMS 2.16 by Matt DesLauriers) against the jsColorEngine, on the
same machine, same profile, same inputs, same methodology as
`../mpx_summary.js`.

Quarantined to its own folder with its own `package.json` and
`node_modules/` so the main project stays dependency-free.

## Run it

```sh
cd bench/lcms-comparison
npm install              # fetches lcms-wasm only
node bench.js            # speed comparison (~25s)
node accuracy.js         # accuracy comparison (~2s)
```

The script uses `__tests__/GRACoL2006_Coated1v2.icc` (already in the repo),
lcms-wasm's built-in virtual sRGB and LabD50, and measures four
typical 8-bit workflows:

| | input | output |
|---|---|---|
| RGB→Lab  | sRGB   | LabD50 |
| RGB→CMYK | sRGB   | GRACoL |
| CMYK→RGB | GRACoL | sRGB   |
| CMYK→CMYK| GRACoL | GRACoL |

It times four paths per workflow, **all lcms-wasm variants using pinned
WASM heap buffers** (preallocated once and reused — the
production-realistic, apples-to-apples setup):

1. jsColorEngine `lutMode: 'float'`   (f64 CLUT, tetrahedral)
2. jsColorEngine `lutMode: 'int'`     (u16 CLUT, Q0.16, int32-specialised)
3. lcms-wasm `flags = 0`              (default — lcms2's auto-precalc
   heuristic decides grid size)
4. lcms-wasm `cmsFLAGS_HIGHRESPRECALC` (force a large precalc device-link
   LUT — matches jsColorEngine's "pre-bake a LUT at create time" design
   exactly)

65536 pixels per iter, warmup 300 iters, median of 5 batches of 100
iters (`~25s` total).

## Measured results (Node 20.13.1, Windows x64)

```
workflow                       js-float  js-int    lcms-def  lcms-hi
-----------------------------  --------  --------  --------  --------
RGB -> Lab    (sRGB -> LabD50)   59.9 M    65.8 M    41.5 M    41.9 M
RGB -> CMYK   (sRGB -> GRACoL)   48.3 M    55.0 M    37.8 M    37.2 M
CMYK -> RGB   (GRACoL -> sRGB)   47.9 M    51.9 M    24.3 M    24.5 M
CMYK -> CMYK  (GRACoL -> GRACoL) 41.3 M    44.3 M    22.0 M    22.1 M
```

**jsColorEngine `int` vs fastest lcms-wasm (best of default/HIGHRES):**

| Workflow | speedup |
|---|---|
| RGB → Lab   | **1.57×** |
| RGB → CMYK  | **1.46×** |
| CMYK → RGB  | **2.12×** |
| CMYK → CMYK | **2.00×** |

Even jsColorEngine's `float` mode outruns lcms-wasm on all four workflows
(1.28–1.96×).

### default vs HIGHRESPRECALC — essentially identical

lcms2's default auto-precalc heuristic already picks "build a device-link
LUT" for all four of these workflows. `cmsFLAGS_HIGHRESPRECALC` merely
widens the grid; the two paths are within ±1 LSB of each other in output
and within ±1.5 % in throughput — in one case (RGB→CMYK) `HIGHRES`
was actually *slower* by ~1.5 %, presumably due to cache pressure from
the larger LUT. So when we say "lcms-wasm with precalc" we really do
mean *both* columns of the table.

## Accuracy (`accuracy.js`)

The speed numbers mean nothing if the outputs disagree. `accuracy.js`
runs the same input pixels through both engines over a systematic
9^N grid through the input cube (729 samples for 3D input, 6561 for
4D) plus a set of named reference colours (white, black, primaries,
mid-greys, skin tone, paper white, rich black, 100 % C/M/Y/K, etc.)
and compares 8-bit output byte-for-byte.

| Workflow | exact match | within 1 LSB | within 2 LSB | max Δ | mean Δ |
|---|---|---|---|---|---|
| RGB → Lab    (sRGB → LabD50)   | 98.79 % | **100.00 %** | 100.00 % | 1 LSB  | 0.004 LSB |
| RGB → CMYK   (sRGB → GRACoL)   | 93.54 % | **100.00 %** | 100.00 % | 1 LSB  | 0.016 LSB |
| CMYK → RGB   (GRACoL → sRGB)   | 83.55 % | 98.51 %      | 99.07 %  | 14 LSB\*| 0.073 LSB |
| CMYK → CMYK  (GRACoL → GRACoL) | 59.50 % | 98.83 %      | 99.86 %  | 4 LSB  | 0.141 LSB |

`lutMode: 'int'` is within 1 LSB of `lutMode: 'float'` on 99 %+ of
samples (self-check) so using the integer kernel doesn't introduce
extra drift vs lcms-wasm.

All **named reference colours** match exactly or within 1 LSB on
every workflow. No disagreement on whites, blacks, primaries, mid-
greys, skin tones, paper white, rich black, 100 % solids, etc.

### \* The 14-LSB max on CMYK → RGB is out-of-gamut clipping, not a bug

Every single worst offender looks like this:

```
in (192,  0, 64, 32)  js ( 0,163,174)  lcms (14,163,174)   Δmax=14
in (192,  0, 64,  0)  js ( 0,181,193)  lcms (13,181,193)   Δmax=13
in (224, 64,224,  0)  js ( 1,139, 84)  lcms (11,139, 84)   Δmax=10
in (192,  0, 32, 64)  js ( 0,146,172)  lcms ( 9,146,172)   Δmax= 9
```

Pattern:

- **Input:** high-Cyan, zero-or-low-Magenta CMYK
- **Disagreement is always in the R channel**; G and B agree
- **Our R is clamped to 0, lcms's R is 9–14**

These CMYK values produce Lab coordinates outside sRGB's gamut, so
both engines compute R<0 internally and clip. Our working
**hypothesis** for why the clipped results differ (not a source-line
diff of lcms2, just an architectural best-guess):

- **jsColorEngine** runs the entire pipeline in 64-bit float all the
  way to the final LUT bake. Only **some** intermediate stages clamp
  to their logical domain (`L` 0-100, etc.) — most stages let
  negative and >1.0 values pass through. A value that swings below 0
  in one stage and comes back positive in the next stays smooth.
- **LittleCMS** appears to clamp more aggressively at several
  intermediate 16-bit fixed-point stages inside its precalc LUT
  builder — values that swing out of range get clamped at that
  stage and stay clamped.

Neither is "correct" — the target gamut has no representation for
the colour. The 14-LSB outlier is bounded; 98.51 % of samples agree
within 1 LSB, 99.07 % within 2 LSB. A future release may add an
opt-in **lcms-compatibility mode** that clamps more aggressively at
intermediate stages for audit workflows that need bit-exact
agreement with a reference lcms pipeline.

If you need *bit-for-bit* agreement with LittleCMS for an audit
workflow today, use `lutMode: 'float'` and expect occasional OOG
drift as above. If you need *visually indistinguishable* output for
a practical application, every workflow clears that bar by a wide
margin.

## How to read these numbers (important caveats)

This is **not** a comparison against native lcms2 — that's a separate
benchmark we can't run in Node.js. A few things to keep in mind:

### 1. lcms-wasm ≠ native lcms2

The reference LittleCMS implementation compiled to wasm32 via Emscripten
loses most of its performance headroom:

* **No SIMD.** The wasm32 target in this build doesn't use the wasm
  SIMD proposal (v128) or any hand-tuned assembly paths. Native lcms2
  built with GCC/Clang gets auto-vectorisation and can use the
  **Fast Float plugin** (hand-tuned tetrahedral kernels with SSE/AVX
  intrinsics) which isn't part of this WASM build.
* **WASM↔JS boundary.** Every `cmsDoTransform` call crosses the JS/WASM
  boundary; the wrapper also `_malloc`s input/output heap buffers and
  `memcpy`s the data in and out. The **pinned** variant eliminates
  the malloc and one of the memcpys and recovers 0.81–0.99× of it, but
  the boundary itself is always there.
* **wasm32 runtime bounds checks.** The WASM sandbox does its own bounds
  checking on linear memory, on top of whatever `memcpy` already costs.

A rough rule of thumb from various benchmarks is that lcms-wasm runs
at roughly **30–60% of native lcms2 speed** depending on the workload.
So the expected ranking is likely:

```
native lcms2 (Fast Float plugin)  >  native lcms2 (default)
    ~2–3× faster than                ~1.5–2× faster than
                        jsColorEngine (this repo)  >  lcms-wasm
```

That is: **native lcms2 with Fast Float is probably still faster than
this engine — we just can't run it here.** What this benchmark shows is
that *for JavaScript/Node/browser deployment*, jsColorEngine currently
outruns the leading WASM-based alternative.

### 2. Why does JS beat WASM here?

Several reasons compound:

* **V8 is extraordinarily good.** The JIT-inspection runs in
  `../jit_inspection.js` confirm that all 8 hot kernels
  (3D/4D × 3Ch/4Ch, int + float) reach TurboFan with zero deopts, pure
  int32 or float64 domain, L1i-cache-resident machine code. That's
  effectively "JS that runs at compiled C speed."
* **No FFI boundary.** `transformArray()` is pure JS calling pure JS.
  No WASM trampoline, no marshalling, no heap `_malloc`.
* **LUT-in-hot-loop design.** v1.1's `lutMode: 'int'` pre-scales the
  CLUT to `Uint16Array` with Q0.16 weights and a fully unrolled
  tetrahedral kernel — zero allocations per pixel, `Math.imul` on
  small ints, single-rounding output. That's arguably the most
  tuned kernel we could write in JS.
* **lcms-wasm carries lcms2's full generality cost.** lcms2 handles
  every possible pixel format (planar, interleaved, endian, swap,
  extra channels, float, 8/16/32-bit) through formatter dispatch
  per pixel. The specialised Fast Float plugin opts out of that
  dispatch — but it isn't in this WASM build.

### 3. Both `flags=0` and `HIGHRESPRECALC` are already precalc paths

With pinned heap buffers and `HIGHRESPRECALC` explicitly requested
(covered above), we're comparing LUT-vs-LUT, not LUT-vs-analytic.
jsColorEngine's lead isn't coming from lcms2 running a slow analytic
pipeline per pixel — lcms2 really is running an interpolated LUT on
every pixel. The delta is genuinely about kernel / FFI / compile-target
efficiency, and specifically about what's *not* in this WASM build
(the Fast Float plugin and SIMD), which is what section 1 is about.

## What this means for the engine

It validates the core v1.1 story (see
[`docs/Performance.md`](../../docs/Performance.md)):

* We are measurably at the JS optimisation ceiling for this problem.
* The path from here is **not** "rewrite hot kernels in WASM to catch
  up with C" — that race is already over. The path is: ship WASM
  scalar eventually (v1.3) to close on native lcms2 with SIMD, and
  offer codegen (`new Function`) for the accuracy path (v1.2).

## License

The benchmark script is part of jsColorEngine (GPL-3.0). lcms-wasm is
MIT-licensed by Matt DesLauriers (wrapping the MIT-licensed Little-CMS).
This folder only invokes lcms-wasm at benchmark time; it is not
redistributed or statically linked. Installing lcms-wasm via `npm install`
pulls it from the npm registry under its original MIT terms.
