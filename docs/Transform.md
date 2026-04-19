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
| **Image / array processing** | `transform.transformArray(typedArray, ...)` with `{ buildLut: true, dataFormat: 'int8' }` | 20–40 Mpx/s | Slightly less accurate (LUT is finite resolution) | Soft-proofing, image conversion, video, any pixel-bulk |

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
