# Transform

The `Transform` class is the colour-conversion engine. You give it a
source [`Profile`](./Profile.md) and a destination `Profile` (and
optionally a rendering intent and some custom stages), and it builds an
optimised pipeline between them. After that, you can convert as many
colours / pixels as you like.

> [!TIP]
> The most authoritative reference for `Transform` is the in-source
> JSDoc in [`src/Transform.js`](../src/Transform.js) — every public
> method documents its parameters, returns, and edge-cases. This page is
> the high-level overview.

## Contents

* [Two ways to use it](#two-ways-to-use-it)
* [Quick start — accuracy path](#quick-start--accuracy-path)
* [Quick start — hot path (image data)](#quick-start--hot-path-image-data)
* [Multi-stage transforms](#multi-stage-transforms)
* [Custom pipeline stages](#custom-pipeline-stages)
* [Constructor options](#constructor-options)
* [Methods](#methods)
* [Properties](#properties)
* [Notes about prebuilt LUT size](#notes-about-prebuilt-lut-size)
* [Misread-prone option names](#misread-prone-option-names)

---

## Two ways to use it

`Transform` is built around two distinct workflows. Picking the right
one matters more than any other choice you'll make:

| Use case | Method | Speed | Accuracy | When to use |
|---|---|---|---|---|
| **Single colour / colour picker** | `transform.transform(colorObj)` | µs per call, slow per pixel | Full 64-bit precision, all stages run | UI colour pickers, swatch libraries, Lab/RGB/CMYK display, ΔE calcs, prepress maths |
| **Image / array processing** | `transform.transformArray(typedArray, ...)` with `{ buildLut: true, dataFormat: 'int8' }` | 45–70 Mpx/s | Slightly less accurate (LUT is finite resolution) | Soft-proofing, image conversion, video, any pixel-bulk |

The library is deliberately split this way so single-colour conversion
is exact and image conversion is fast — the optimisations needed for
the hot path (unrolled loops, skipped bounds checks, typed-array-only IO,
monomorphic JIT shapes) actively hurt single-colour readability and
correctness.

---

## Quick start — accuracy path

For converting one colour at a time. No LUT is built; the full pipeline
runs per call.

```js
const { Profile, Transform, eIntent, color } = require('jscolorengine');

(async () => {
    const cmyk = new Profile();
    await cmyk.loadPromise('file:./profiles/GRACoL2006_Coated1v2.icc');

    const lab2cmyk = new Transform();        // no buildLut
    lab2cmyk.create('*lab', cmyk, eIntent.perceptual);

    const out = lab2cmyk.transform(color.Lab(80.1, -22.3, 35.1));
    console.log(`CMYK: ${out.C}, ${out.M}, ${out.Y}, ${out.K}`);
})();
```

The colour helpers (`color.Lab`, `color.RGB`, `color.CMYK`, …) build
typed colour objects with the right whitepoint defaults. `transform()`
returns the same shape but for the destination space.

---

## Quick start — hot path (image data)

For pixel-bulk work. Build a LUT once, run an n-dimensional
interpolation per pixel.

```js
const { Profile, Transform, eIntent } = require('jscolorengine');

(async () => {
    const cmyk = new Profile();
    await cmyk.loadPromise('file:./profiles/GRACoL2006_Coated1v2.icc');

    const rgb2cmyk = new Transform({
        buildLut: true,        // pre-bake the pipeline into a 3D LUT
        dataFormat: 'int8',    // input/output as Uint8ClampedArray
        BPC: true              // black point compensation on
    });
    rgb2cmyk.create('*sRGB', cmyk, eIntent.relative);

    // imageData.data is a Uint8ClampedArray of [R, G, B, A, R, G, B, A, ...]
    // hasInputAlpha=true, hasOutputAlpha=false → alpha is dropped on the way out.
    const cmykBytes = rgb2cmyk.transformArray(imageData.data, true, false);

    // cmykBytes is now [C, M, Y, K, C, M, Y, K, ...]
})();
```

`transformArray()` automatically routes to the fast `transformArrayViaLUT()`
path when `dataFormat === 'int8'` and a LUT is built. You can also call
`transformArrayViaLUT()` directly when you want to be explicit.

---

## Multi-stage transforms

For chains of three or more profiles (e.g. RGB → CMYK → RGB
soft-proofing) use `createMultiStage()` instead of `create()`. The
profile chain alternates `profile, intent, profile, intent, …, profile`:

```js
const proof = new Transform({
    buildLut: true,
    dataFormat: 'int8',
    BPC: [true, false]   // per-stage: BPC on for stage 0, off for stage 1
});
proof.createMultiStage([
    '*sRGB', eIntent.perceptual,
    cmykProfile, eIntent.relative,
    '*sRGB'
]);

const proofedRGB = proof.transformArray(rgbBytes, false, false);
```

`BPC` accepts either a boolean (applies to all stages) or an array of
booleans indexed by stage number — useful for the classic
"perceptual into CMYK with BPC, relative back out without" recipe.

---

## Custom pipeline stages

You can inject your own function into the pipeline at a known location
(e.g. PCS — between the input and output profiles). Useful for
desaturation previews, gamut warnings, channel swaps, etc. Custom stages
get baked into the LUT, so you only pay the cost once.

```js
const { Transform, eIntent, encoding } = require('jscolorengine');

const desaturateAtPCS = {
    description: 'Desaturate at PCS',
    location: 'PCS',
    stageData: null,
    stageFn: function (input, data, stage) {
        if (stage.inputEncoding === encoding.PCSXYZ) {
            // XYZ at PCS — set X and Z to Y (rough greyscale)
            input[0] = input[1];
            input[2] = input[1];
        } else {
            // Lab at PCS — zero the chroma (a, b → 0.5 in normalised PCS)
            input[1] = 0.5;
            input[2] = 0.5;
        }
        return input;
    }
};

const t = new Transform();
t.create('*lab', cmykProfile, eIntent.perceptual, [desaturateAtPCS]);
```

---

## Constructor options

```js
new Transform(options)
```

| Option | Type | Default | Description |
|---|---|---|---|
| `buildLut` | Boolean | `false` | Pre-bake the pipeline into a CLUT. Required for the fast image path. Slight accuracy loss vs. running the full pipeline (LUT quantisation), but typically invisible to the eye and 20–40× faster. *(Legacy spelling `builtLut` is also accepted.)* |
| `lutMode` | String | `'float'` | **Image hot-path kernel selector.** `'float'` (default) keeps the original float kernels — bit-stable across releases. `'int'` opts into the integer-math kernels (Math.imul + Q0.8 weights + u16 mirror LUT scaled at `255 × 256`; Q0.16 `gridPointsScale_fixed`; 4D kernels use a u20 Q16.4 single-rounding intermediate) for `dataFormat: 'int8'` LUT transforms — adds ~5–25 % throughput across all four 3-/4-channel directions (3D and 4D), uses 4× less LUT memory, and stays within **≤ 1 LSB** of the float kernel on u8 output (RGB→RGB is 100 % bit-exact; other directions hit ≤ 1 LSB, which is just banker's-rounding-vs-half-up disagreement at exact X.5 ties — well under the JND). Falls through to `'float'` for any LUT shape the integer kernel can't service (1D / 2D / 5+ output channels) — always safe to enable. v1.2+ will add `'wasm-scalar'`, `'wasm-simd'`, and `'auto'` through the same option; unknown values fall through to `'float'` so forward-written code won't crash. Don't use `'int'` for color-measurement workflows that need bit-exact reference output against a float path. See the "lutMode" section below. |
| `dataFormat` | String | `'object'` | `'object'`, `'objectFloat'`, `'int8'`, `'int16'`, `'device'`. Determines the input/output shape of `transform()` / `transformArray()`. The fast LUT path requires `'int8'`. |
| `BPC` | Boolean \| Boolean[] | `false` | Black Point Compensation. Boolean enables for all stages; array enables per-stage by stage index (0, 1, 2…). |
| `roundOutput` | Boolean | `true` | Round numeric output. Set `false` to keep raw floats (e.g. `243.20100198…`). |
| `precision` | Number | `0` | Decimal places to round to when `roundOutput=true`. *(Legacy spelling `precession` is also accepted.)* |
| `interpolation3D` | String | `'tetrahedral'` | `'trilinear'` or `'tetrahedral'`. Tetrahedral is **both faster and more accurate** for device→device LUTs — stay on it unless you have a measured reason. |
| `interpolation4D` | String | `'tetrahedral'` | Same, for 4D (CMYK) LUTs. |
| `LUTinterpolation3D` | String | (= `interpolation3D`) | Override the interpolation used inside the prebuilt LUT. |
| `LUTinterpolation4D` | String | (= `interpolation4D`) | Same, for 4D. |
| `lutGridPoints3D` | Number | `33` | Grid points per axis for 3D LUTs. 17 / 33 / 65 are typical; above 65 you hit memory cost without measurable accuracy gain. |
| `lutGridPoints4D` | Number | `17` | Grid points per axis for 4D (CMYK) LUTs. 11 / 17 / 33 typical. 4D grows as N⁴ in memory — be cautious above 33. |
| `labAdaptation` | Boolean | `false` | If `true`, object-based Lab input is adapted to D50 before entering the pipeline (e.g. LabD65 → LabD50). |
| `labInputAdaptation` | Boolean | `true` | If `false`, suppresses Lab→Lab whitepoint adaptation on input. |
| `displayChromaticAdaptation` | Boolean | `false` | Apply chromatic adaptation across the PCS when source/destination profiles have different whitepoints. For abstract Lab profiles. |
| `pipelineDebug` | Boolean | `false` | Capture per-stage values into `pipelineHistory` and `debugHistory`. Adds overhead — only enable for diagnostics. Only meaningful on the accuracy path. |
| `optimise` | Boolean | `true` | Run the pipeline optimiser to remove redundant conversions (e.g. matched encode/decode pairs). |
| `clipRGBinPipeline` | Boolean | `false` | Clip RGB values to 0..1 inside the pipeline (useful for extreme abstract profiles). |
| `verbose` | Boolean | `false` | Log pipeline construction info to console. |
| `verboseTiming` | Boolean | `false` | Log build timings to console. |

---

## Methods

### `transform.create(inputProfile, outputProfile, intent, customStages?)`

Build a single-step pipeline.

* `inputProfile`, `outputProfile` — `Profile` instance, or virtual name
  string like `'*sRGB'`.
* `intent` — `eIntent.perceptual` / `relative` / `saturation` / `absolute`.
* `customStages` — optional array of custom stage objects (see above).
* Throws if the pipeline can't be built (incompatible profiles,
  unsupported combination, etc.).

### `transform.createMultiStage(profileChain, customStages?)`

Build a multi-step pipeline. `profileChain` alternates
`[profile, intent, profile, intent, …, profile]`.

### `transform.transform(inputColor)`

**Accuracy path.** Convert a single colour. `inputColor` is a typed
colour object (e.g. `{ L, a, b }`, `{ R, G, B }`, `{ C, M, Y, K }`).
Returns a typed colour object in the destination space. Every stage of
the pipeline runs at full 64-bit precision.

### `transform.transformArray(inputArray, inputHasAlpha?, outputHasAlpha?, preserveAlpha?, pixelCount?, outputFormat?)`

The recommended array entry point. Routes to the fastest legitimate
path based on `dataFormat` and whether a LUT was prebuilt:

| Configuration | Path used |
|---|---|
| `dataFormat: 'int8'` and LUT built | `transformArrayViaLUT()` — image fast path |
| `dataFormat: 'object'` / `'objectFloat'` | Per-pixel accuracy path, walking the full pipeline |
| `dataFormat: 'int8'` / `'int16'` / `'device'` and no LUT | Per-pixel accuracy path over a flat numeric array |

Parameters:

* `inputArray` — flat numeric array (`Array`, `Uint8ClampedArray`, `Uint16Array`, `Float32Array`, `Float64Array`) of channel data.
* `inputHasAlpha` — when `true`, every `(channels+1)`th value of the
  input is alpha (it's read from input, not converted). Ignored for
  `'object'` / `'objectFloat'` formats.
* `outputHasAlpha` — when `true`, the output gets an alpha slot per
  pixel. Filled with `255` unless `preserveAlpha=true`.
* `preserveAlpha` — copy alpha from input to output verbatim. Requires
  `inputHasAlpha=true`. Defaults to `(inputHasAlpha && outputHasAlpha)`.
* `pixelCount` — if not specified, derived from `inputArray.length`.
* `outputFormat` — output container type. `'int8'` →
  `Uint8ClampedArray`, `'int16'` → `Uint16Array`, `'float32'` →
  `Float32Array`, `'float64'` → `Float64Array`. Defaults to a plain
  `Array`. Ignored on the LUT path (which always returns
  `Uint8ClampedArray`).

### `transform.transformArrayViaLUT(inputArray, inputHasAlpha?, outputHasAlpha?, preserveAlpha?, pixelCount?)`

The fast image path explicitly. Requires `buildLut: true,
dataFormat: 'int8'` at construction time and a `Uint8ClampedArray` (or
plain `Array` of bytes) as input. Always returns a `Uint8ClampedArray`.

### Diagnostics

* `transform.getStageNames()` — array of stage names in the built
  pipeline.
* `transform.debugInfo()` — formatted multi-section debug dump (chain,
  history, optimiser).
* `transform.chainInfo()` — formatted dump of how the pipeline was
  created.
* `transform.historyInfo()` — formatted per-stage value history (only
  populated when `pipelineDebug: true` was set).
* `transform.optimiseInfo()` — formatted dump of what the pipeline
  optimiser collapsed.

---

## Properties

| Property | Type | Description |
|---|---|---|
| `inputProfile` | `Profile` | The first input profile in the pipeline. |
| `outputProfile` | `Profile` | The last output profile in the pipeline. |
| `inputChannels` | Number | Channel count of the input profile. |
| `outputChannels` | Number | Channel count of the output profile. |
| `usesBPC` | Boolean | True if any stage applies Black Point Compensation. |
| `usesAdaptation` | Boolean | True if chromatic adaptation runs across the PCS. |
| `chain` | Array | Profile chain — describes how the pipeline was constructed. |
| `pipelineCreated` | Boolean | True after a successful `create*` call. `transform()` / `transformArray()` will throw `'No Pipeline'` if this is false. |
| `builtLut` | Boolean | True if a LUT has been prebuilt. |
| `lut` | Object \| `false` | The prebuilt CLUT, or `false` if none. |

---

## Notes about prebuilt LUT size

Default grid sizes are 33×33×33 for 3D (RGB / Lab inputs) and
17×17×17×17 for 4D (CMYK inputs). LUT size grows as gridPoints^channels,
so 4D grids stay smaller than you might expect from the per-axis number:

| Grid | Entries |
|---|---|
| 3D 17×17×17 | 4,913 |
| 3D 33×33×33 | 35,937 |
| 4D 17×17×17×17 | 83,521 |
| 4D 33×33×33×33 | 1,185,921 |

For the vast majority of work the defaults are fine — going higher gives
diminishing accuracy returns and burns memory and build time. Drop to
17 for 3D or 11 for 4D if you're memory-constrained.

---

## lutMode — image hot-path kernel selector (1.1+)

```js
new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int' });
```

`lutMode` selects the inner-loop kernel for the **LUT image fast path**.
It only matters when `dataFormat: 'int8'` AND `buildLut: true` — the
single-pixel accuracy path is unaffected and always uses float.

| Value         | Status                | Behaviour |
|---------------|-----------------------|-----------|
| `'float'`     | Default               | Original float kernels. Bit-stable across releases. Use for color-measurement / delta-E workflows. |
| `'int'`       | New in v1.1           | Integer kernels (Math.imul + Q0.8 weights + u16 mirror LUT). 1.10–1.25× speedup, 4× less LUT memory. |
| `'wasm-scalar'` | Planned v1.3        | Falls through to `'float'` today — the option name is reserved so code written for v1.3 doesn't crash on v1.1. |
| `'wasm-simd'` | Planned v1.4          | Same — reserved name, falls through to `'float'`. |
| `'auto'`      | Planned v1.4          | Picks the best kernel per LUT shape. Will become the default in v2.0. |
| (anything else) | Forward-compat fallback | Falls through to `'float'` with a `console.warn` if `verbose: true`. |

The string-enum API was chosen specifically so future kernels can be
added without changing the constructor signature.

### What `lutMode: 'int'` does

- Builds a `Uint16Array` mirror of the float CLUT once at `create()` time.
- Replaces the inner loop's `*` with `Math.imul`, the float `[0..1]` weights with Q0.8 fixed-point integers in `[0..255]`, and the `* outputScale` final step with two rounded shift operations.
- Keeps the alpha-handling, dispatch, and method signatures of the float kernel — so it's a drop-in replacement, not a parallel API.

### Coverage matrix

| Direction        | LUT shape | Behaviour with `lutMode: 'int'` |
|------------------|-----------|---------------------------------|
| RGB → RGB / Lab  | 3D 3Ch    | **Integer kernel**, ~1.05–1.15× speedup, **100 % exact** vs float |
| RGB → CMYK       | 3D 4Ch    | **Integer kernel**, ~1.04–1.1× speedup, ≤ 1 LSB diff |
| CMYK → RGB / Lab | 4D 3Ch    | **Integer kernel (u20)**, ~1.15–1.25× speedup, ≤ 1 LSB diff |
| CMYK → CMYK      | 4D 4Ch    | **Integer kernel (u20)**, ~1.05–1.15× speedup, ≤ 1 LSB diff |
| Gray → N         | 1D        | Falls through to float (1D not in scope; existing path is already fast) |
| Duo → N          | 2D        | Falls through to float (2D not in scope; specialised hot loop pending) |
| 5+ output ch     | any       | Falls through to float (uncommon profile shape) |

Anything not in the supported set silently uses the existing float
kernel, so it's safe to enable globally — the worst case is "no
speedup".

### When to use it

- ✅ Image processing: web canvas conversion, ImageData round-trips, video preview, soft-proofing.
- ✅ Multi-transform apps where LUT memory adds up — the u16 mirror is 4× smaller than the float CLUT, which matters when caching dozens of profile pairs (a typical CMYK→CMYK 4D LUT drops from 2.6 MB to 650 KB).
- ❌ Color-measurement / proofing accuracy testing where you need bit-exact reproduction of the float reference. Use `lutMode: 'float'` (the default) for that — `'int'` introduces ≤ 1 LSB drift (see accuracy table below), which is visually identical but not bit-identical.
- ❌ Single-pixel `transform()` calls. `lutMode` only affects the LUT array path; the accuracy path is unchanged.

### Accuracy budget

| Shape  | Max diff vs float (u8) | Why |
|--------|------------------------|-----|
| 3D 3Ch | **0 LSB (100 % exact)** | Cleanest case — corners exact via boundary patch, interior rounding absorbed by u8 quantisation. |
| 3D 4Ch | ≤ 1 LSB | Residual is half-tie rounding disagreement between `Uint8ClampedArray` (banker's) and the kernel (round-half-up). |
| 4D 3Ch | ≤ 1 LSB | K-axis LERP runs on top of 3D interp; u20 Q16.4 + single final rounding + Q0.16 `gridPointsScale_fixed` + u16 scale of 255×256 eliminate all systematic bias. |
| 4D 4Ch | ≤ 1 LSB | Same design as 4D 3Ch; u20 single-rounding keeps the extra output channel under control. |

All directions measured at 99.6–100 % exact vs the float reference
on 65k random pixels (GRACoL2006). The residual ≤ 1 LSB cases are
exact `X.5` half-ties where banker's rounding (ties to even) differs
from the kernel's round-half-up. This is not interpolation error —
the u16 interp is otherwise match-to-CLUT-exact.

For context, the sRGB perceptual gradient steps about 5–8 LSB per JND
(just-noticeable difference) in the midtones, so a 1 LSB drift is
invisible on screen.

The benchmark `bench/fastLUT_real_world.js` reports an "off by ≥ 16"
column — that's the regression indicator. It's `0` for all four
directions across 65k pixels in the test suite. Any non-zero value
there means a boundary patch (any of C/M/Y/K === 255) is broken.

### A note on benchmark numbers (and a warning for future benchmarks)

The two bench suites in this repo report different speedups for the
same integer kernel:

- **`bench/fastLUT_real_world.js`** — ~1.05–1.25× speedup. Class
  methods on a stable `Transform` instance; warmed up; same dispatch
  path users hit. **These are the numbers users will see.**
- **`bench/int_vs_float*.js`** — ~1.5–1.6× speedup. Free-standing
  functions comparing the raw kernel math. **Useful as "what's the
  kernel's intrinsic ceiling" but not a production prediction.**

Both are correct. They measure different things. The short version is
that V8 (and other modern engines) specialise class methods on hot
objects far more aggressively than free-standing functions, so a float
kernel lifted into a class gets ~30 % faster on its own — which
compresses the integer kernel's relative win even though its absolute
throughput is unchanged.

**⚠ If you write a new micro-bench, put the "before" and "after"
kernels in the same container (both methods or both free-standing)
before comparing.** This is easy to get wrong and produces very
confident-looking false positives. Full discussion and rules of
thumb in `docs/Performance.md` under "Caution — benchmark context
matters".

The ~1.05–1.25× engine speedup plus the 4× LUT memory reduction is
still a worthwhile win for a single constructor flag. 4D CMYK input
directions see the biggest wins because the float K-LERP does more
redundant rounding work, and the u20 refactor (see below) trimmed
both its rounding error AND its instruction count.

### Implementation notes for contributors

- The integer kernels live next to their float siblings in
  `src/Transform.js` — search for `_intLut_loop`. They are
  intentionally verbose and unrolled; do **not** refactor without
  re-running the bench. Innocent-looking changes (extracting
  sub-expressions to temps, hoisting CLUT lookups) routinely lose
  10–30 % perf because they break V8's register lifetime tracking.
- The **3D kernels** use Q0.8 fractional weights (extracted from a
  Q0.16 `gridPointsScale_fixed` via `(px >>> 8) & 0xFF`) and a single
  `>> 8` inner rounding to reach u16, then `>> 8` again to u8 — two
  light rounding steps, ≤ 1 LSB worst-case drift.
- The **u16 CLUT is scaled by `255 × 256 = 65280`, not 65535** — so
  the `>> 8` final shift gives u8 exactly. Scaling by 65535 (which
  looks more natural) introduced a systematic +0.4 % high bias that
  caused 75 % off-by-1 with 100 % of errors going `int > float` on
  CMYK→RGB. See `buildIntLut()` JSDoc for the full trail.
- **`gridPointsScale_fixed` is Q0.16, not Q0.8.** Carrying `(g1-1)/255`
  at Q0.8 (e.g. `32` for a 33-grid) truncates the true 32.125 value,
  making `rx`/`ry`/`rz`/`rk` systematically smaller. On monotonically-
  decreasing axes (CMYK→RGB along CMY) this was a second source of
  `int > float` bias. Q0.16 (e.g. `8224`) preserves the ratio; the
  kernel extracts Q0.8 `rx` via `(px >>> 8) & 0xFF`.
- The **4D kernels** are different: they carry intermediate
  interpolated values at **u20 (Q16.4) precision** — four extra
  fractional bits above the u16 CLUT — and fold the three stacked
  rounding steps of a naive implementation (K0 plane, K1 plane,
  K-LERP) into one meaningful final `>> 20`. u20 is specifically
  chosen so the K-LERP `Math.imul(K1_u20 - o0_u20, rk)` stays under
  the signed int32 ceiling — going wider overflows. See the JSDoc
  on `tetrahedralInterp4DArray_3Ch_intLut_loop` for the full
  derivation and int32 constraint math.
- The mirror LUT is built in `Transform.buildIntLut(lut)`, called from
  `create()` after the optimiser has finalised the float pipeline.
  Shape gating happens in there — adding a new supported shape means
  adding the kernel, extending the dispatcher in `transformArrayViaLUT`,
  and extending `buildIntLut`'s `supported3D` / `supported4D` test.
- The `input === 255` boundary patches (one per axis) are **non-optional**.
  Without them, pure-channel inputs land one grid below the top with
  weight ~0.875 instead of on the top with weight 0, producing a `max
  diff = 8` regression at corners. See FINDING #2 in
  `bench/int_vs_float.js` for the deep dive. The 4D kernels apply this
  to all four axes (C, M, Y, K).

---

## Misread-prone option names

A handful of option / property names in the codebase are easy to skim
and misread. All of them are aliased for backwards compatibility, so
both spellings work — but the canonical one is preferred in new code:

| Legacy (still works) | Canonical | Where |
|---|---|---|
| `builtLut` | `buildLut` | Transform constructor option |
| `precession` | `precision` | Transform constructor option |
| `unsuportedTags` | `unsupportedTags` | `Profile` property |
| `virutalProfileUsesD50AdaptedPrimaries` | `virtualProfileUsesD50AdaptedPrimaries` | `Profile` property |

All four legacy names are kept as `@deprecated` aliases for backwards
compatibility — both spellings work, both option/property names point
at the same underlying value. Prefer the canonical names in new code.

These look correct at a glance and silently routed to a different path
(or nowhere) before they were aliased — be alert when reviewing PRs or
copy-pasting from older code or docs.
