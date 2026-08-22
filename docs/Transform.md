# Transform

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Bench](./Bench.md) ·
[Performance](./deepdive/Performance.md) ·
[Roadmap](./Roadmap.md) ·
[Deep dive](./deepdive/) ·
[Examples](./Examples.md) ·
[API: Profile](./Profile.md) ·
[Loader](./Loader.md)

---

> **Figures on this page are from the date in the status/header.** Performance at the time of writing — re-run on your machine: browser [`samples/bench/`](../samples/bench/) (live: https://www.o2creative.co.nz/jscolorengine/samples/bench/) or Node `node bench/mpx_summary.js`. Methodology: [Bench.md](./Bench.md). Canonical tables: [BenchResults.md](./BenchResults.md).

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
* [DeviceLink and N-channel profiles](#devicelink-and-n-channel-profiles)
* [Custom pipeline stages](#custom-pipeline-stages)
* [Constructor options](#constructor-options)
* [Gamut warning modes](#gamut-warning-modes)
* [Methods](#methods)
  * [`array` / `transformArray` / `transformArrayViaLUT`](#transformarrayinputarray-inputhasalpha-outputhasalpha-preservealpha-pixelcount-outputarray)
  * [Pipeline validation — `validatePipeline`](#transformvalidatepipelineformatoverride)
  * [Batches and the worker pool — `transformImages`](#transformtransformimagesimages-options)
  * [Pool control — `enablePool` / `disablePool` / `restartPool`](#pool-control--enablepool--disablepool--restartpool)
  * [Which kernel took it — `kernelInfo`](#transformkernelinfo)
* [Pinning older defaults — `Transform.compatibility()`](#pinning-older-defaults--transformcompatibility)
* [Properties](#properties)
* [LUT build hooks](#lut-build-hooks)
* [Portable LUT JSON — `toJSON` / `fromJSON` / signatures](#portable-lut-json--tojson--fromjson--signatures)
* [Notes about prebuilt LUT size](#notes-about-prebuilt-lut-size)
* [Misread-prone option names](#misread-prone-option-names)

---

## Two ways to use it

`Transform` is built around two distinct workflows. Picking the right
one matters more than any other choice you'll make:

| Use case | Method | Speed | Accuracy | When to use |
|---|---|---|---|---|
| **Single colour / colour picker** | `transform.transform(colorObj)` | µs per call, slow per pixel | Full 64-bit precision, all stages run | UI colour pickers, swatch libraries, Lab/RGB/CMYK display, ΔE calcs, prepress maths |
| **Image / array processing** | `transform.array(...)` — container matches `dataFormat`. Fast path: `{ buildLut: true, dataFormat: 'int8' }` (or `'int16'`) | ~120 MPx/s on photographs (WASM SIMD, one core); ~330 where the matrix-shaper kernel takes over | Slightly less accurate (LUT is finite resolution) — except on the matrix-shaper kernel, which has no interpolation error | Soft-proofing, image conversion, video, any pixel-bulk |
| **Batches of images** | `await transform.transformImages(images, {multicore: true, onImage})` | 6.2× peak, 787 MPx/s across 8 workers | Byte-identical to the sequential path | Whole folders, servers, RIPs — see [docs/pool.md](./pool.md) |

The library is deliberately split this way so single-colour conversion
is exact and image conversion is fast — the optimisations needed for
the hot path (unrolled loops, skipped bounds checks, monomorphic JIT
shapes) actively hurt single-colour readability and correctness.

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
    const cmykBytes = rgb2cmyk.array(imageData.data, true, false);

    // cmykBytes is now [C, M, Y, K, C, M, Y, K, ...]
})();
```

`transform.array()` is the batch entry (native units). `transformArray()`
is the same call plus an optional `outputFormat` applied afterwards via
`Transform.reformat`. After either, `transform.lastUsedKernel` is the
kernel name that ran, or `'pipeline'` / `'cache'`.

`transformArrayViaLUT()` is the loud cousin: same work, but throws
`'No LUT loaded'` instead of walking the pipeline. Use it when a missing
table must be a hard error.

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

const proofedRGB = proof.array(rgbBytes, false, false);
```

`BPC` accepts either a boolean (applies to all stages) or an array of
booleans indexed by stage number — useful for the classic
"perceptual into CMYK with BPC, relative back out without" recipe.

---

## DeviceLink and N-channel profiles

*(Shipped 2026-08. Full implementation notes:
[docs/DeviceLink.md](./DeviceLink.md) · [docs/NChannel.md](./NChannel.md).)*

### DeviceLink (`pClass: 'link'`)

A DeviceLink is a complete device→device conversion with no PCS —
pass it to `create()` **alone**:

```js
const dl = new Profile();
await dl.loadPromise('MyDeviceLink.icc');

const t = new Transform({ dataFormat: 'int8', buildLut: true });
t.create(dl);                       // just the link — no second profile
const out = t.array(cmykPixels, false, false);
```

- The **rendering intent comes from the profile header** (per spec the
  single A2B tag serves the declared intent); any intent argument is
  ignored.
- Passing additional profiles alongside a DeviceLink **throws** —
  there is no PCS to link through.
- Asymmetric links work (CMYK→RGB, RGB→CMYK); input/output channel
  counts come from the link's header fields. `buildLut: true` bakes
  the image path as usual, and identity detection never collapses a
  link.
- Detect one after loading via `profile.header.pClass === 'link'`.

### N-channel (5CLR–15CLR press profiles)

N-channel profiles load as `eProfileType.NChannel` and work in both
directions:

- **PCS/RGB → n-ink (output side)** — full support including the
  baked-LUT image path: a 3D/4D grid with N output channels runs on
  the existing array kernels at normal image speed.
- **n-ink → PCS (input side)** — supported on the **per-pixel
  accuracy pipeline** via a generic N-D simplex interpolator. Device
  values are accepted as an array/TypedArray of N values in 0..1 or
  as an object `{c0, c1, …, cN}`. `buildLut: true` is **declined
  with a console warning** for n-ink input (a `grid^N` bake is
  impractical — a 17-point 7-channel grid would be ~410 M cells) and
  the transform falls back to the pipeline; `transform.lut === false`
  after create tells you this happened.

```js
const t = new Transform();          // accuracy path
t.create(sevenClrProfile, '*lab', eIntent.relative);
const lab = t.transform([0, 0, 0, 1, 0, 0, 0]);   // 7 ink fractions
```

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
| `lutMode` | String | `'auto'` | **Image hot-path kernel selector.** Five values in v1.2: `'auto'` (default — picks the fastest kernel for the current `(dataFormat, buildLut)` combination), `'float'`, `'int'`, `'int-wasm-scalar'`, `'int-wasm-simd'`. `'auto'` resolves at construction time: `dataFormat: 'int8'` + `buildLut: true` → `'int-wasm-simd'` (with the automatic **SIMD → scalar WASM → JS `'int'`** demotion chain running at `create()` time for hosts that lack WASM or SIMD); anything else → `'float'`. Inspect `xform.lutMode` after construction to see the resolved value. Pin an explicit mode when you want determinism: `'float'` for bit-stable f64 LUT interp across releases, `'int'` for JS-only (no WASM), or `'int-wasm-*'` to fail loudly on hosts that can't run that specific kernel. Unknown values (typos, forward-written code referencing modes added in later versions) auto-resolve the same way `'auto'` does, so code never crashes on upgrade. Don't pin `'int'` / `'int-wasm-*'` for color-measurement workflows that need bit-exact reference output against a float path — pin `'float'` or set `buildLut: false`. See the "lutMode" section below and [deep dive / LUT modes](./deepdive/LutModes.md) for full kernel details. |
| `dataFormat` | String | `'object'` | `'object'`, `'objectFloat'`, `'int8'`, `'int16'`, `'device'`. Determines the input/output shape of `transform()` / `array()`. The fast LUT path is `'int8'` or `'int16'`. |
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
| `validateOnCreate` | Boolean | `true` | Run a single-pixel smoke test through the pipeline at the end of `create()`. If the test colour produces `NaN`, `undefined`, or the wrong output type the call throws immediately with a clear message. Adds ~1 µs to `create()` time — negligible. Set `false` to disable (e.g. when loading a pre-validated profile that you already trust). Has no effect when a cached LUT is loaded via `setLut()` / `fromJSON()` — validation is skipped for pre-built LUTs. |
| `pixelCache` | Number \| `'auto'` | `'auto'` | **BETA — semantics may change.** One hint, two implementations. **Accuracy path:** `'auto'` is ignored by Transform — the kernel may change it to `1` from `init()` (4/5/6 do; 3D and everything else leave it). `0`/`false` off, `1` a single entry, or a table size (rounded down to a power of two). `pixelCacheUsed` is what the pipeline ran. **Image path:** WASM 3–6 kernels bind `interp_*_cached` (single-entry) when the hint is not `0`; `kernelInfo().cache` is `1` when that export ran. Matrix-shaper / JS fallback decline. Use `getPixelCacheStats()` on `transform()` content to decide a table size. Declines silently when `pipelineDebug` is on or custom stages are present. See [deepdive/PixelCache.md](./deepdive/PixelCache.md). |
| `wasmMatrixShaper` | Boolean \| String | `true` | Use the fused WASM matrix-shaper kernel when the built pipeline is a matrix-shaper pair (curve → 3×3 → curve). `true` takes it only when there is no LUT to displace; `'prefer'` also displaces a CLUT that would otherwise be built, which is both faster and more accurate; `false` disables it. Declines silently — and correctly — for per-channel TRCs, non-RGB spaces, and `dataFormat` values other than `'int8'` / `'int16'`. Ask `transform.kernelInfo()` what actually happened. See [deepdive/MatrixShaperKernel.md](./deepdive/MatrixShaperKernel.md). |
| `multicore` | Boolean \| Object | `false` | Default for `transformImages()` when the call does not pass its own. `true` uses the pool as configured; an object carries pool options for this transform. Ignored by `transform()` and `array()`, which are always single-threaded. |
| `verbose` | Boolean | `false` | Log pipeline construction info to console. |
| `verboseTiming` | Boolean | `false` | Log build timings to console. |
| `lutGamutMode` | String | `'none'` | Baked gamut check during LUT build. See [Gamut warning modes](#gamut-warning-modes) below. |
| `lutGamutLimit` | Number | `5` | ΔE threshold for `'color'` mode. |
| `lutGamutMapScale` | Number | `25.5` | ΔE that maps to 1.0 in `'map'` and `'colorMap'` modes. |
| `lutGamutColor` | Object | `Lab(0,127,127)` | Warning colour (Lab) for `'color'` and `'colorMap'` modes. |
| `gamutDeFn` | Function | `convert.deltaE1976` | Colour-difference function `(labA, labB) => number`. Swap in `deltaE2000`, `deltaCMC`, etc. |
| `bakeLutGamut` | Boolean | `false` | Legacy shorthand. `true` = `lutGamutMode:'color'`. |

---

## Gamut warning modes

When building a LUT (`buildLut: true`), you can bake a gamut check
into the LUT itself — **zero cost at transform time**. The check
compares source and destination Lab at each LUT grid point and acts
on the ΔE.

```js
new Transform({
    buildLut: true,
    dataFormat: 'int8',
    lutGamutMode: 'colorMap',    // visual heatmap
    lutGamutMapScale: 25.5,      // ΔE 25.5 = full warning colour
}).create('*srgb', cmykProfile, eIntent.perceptual);
```

| Mode | Output | Use case |
|---|---|---|
| `'none'` | Normal conversion | Default — no gamut check |
| `'color'` | Hard replace above `lutGamutLimit` ΔE with `lutGamutColor` | Binary in/out flag overlay |
| `'colorMap'` | Lerp from paper white → `lutGamutColor` by ΔE | Visual heatmap on white background |
| `'map'` | Raw `min(ΔE/lutGamutMapScale, 1.0)` in every output channel | Analysis — extract via `renderChannelAs` |

The gamut colour and paper white are converted to the output device
space once at LUT-build time. The gamut check transforms (src→Lab,
dest→Lab) are disposed after the LUT is built.

LUT tags `gamutMode`, `gamutLimit`, `gamutMapScale` are stamped on
both the float LUT and the int LUT mirror so downstream code can
inspect what was baked in.

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

### `transform.validatePipeline(formatOverride?)`

Run a single-pixel smoke test through the current pipeline. Returns
`true` if the pipeline looks healthy, `false` if `transform()` threw
or the output contained `NaN` / `undefined` / wrong colour type.

This is the same check that `validateOnCreate` runs automatically at
`create()` time. You would call it manually if you disabled
`validateOnCreate` and want to verify the pipeline later, or if you
have programmatically modified the pipeline after creation.

**What it catches and what it misses.** The test uses one mid-grey
input pixel (50 % on every channel). It catches:

- `NaN` in any matrix element that the mid-grey value exercises (the
  full pipeline runs, so all stages are exercised).
- Any stage that throws an exception at transform time.
- A wrong output type (e.g. an RGB object where a CMYK object is
  expected).

It **does not** catch corruption that only affects extreme values —
for example, a corrupt entry at the very top of a 1D gamma LUT would
not be caught because the mid-grey test value never reaches it. A full
NaN/undefined deep scan of the `Profile` object (planned for v1.8)
would close that gap.

**Error handling — why you `try/catch` `create()` but not `transform()`.**

With `validateOnCreate: true` (the default), `create()` is the one
place where a broken profile surfaces as an exception:

```js
// Recommended pattern — guard at create() time, not at transform() time.
try {
    const xf = new Transform();
    xf.create(inputProfile, outputProfile, eIntent.relative);
    // If we get here, xf.transform() and xf.array() are safe to
    // call without a try/catch on every pixel / every array.
} catch (err) {
    console.error('Pipeline failed to build:', err.message);
}
```

Once `create()` succeeds, `transform()` and `array()` will
not throw on well-formed input. The only remaining failure mode is
a caller error (wrong array length, wrong channel count), which the
existing guards already report with a clear message. Wrapping every
`transform()` call in a `try/catch` is therefore unnecessary overhead
and obscures real bugs.

### `transform.transform(inputColor)`

**Accuracy path.** Convert a single colour. `inputColor` is a typed
colour object (e.g. `{ L, a, b }`, `{ R, G, B }`, `{ C, M, Y, K }`).
Returns a typed colour object in the destination space. Every stage of
the pipeline runs at full 64-bit precision.

### `transform.array(inputArray, inputHasAlpha?, outputHasAlpha?, preserveAlpha?, pixelCount?, outputArray?)`

The batch entry. Native units; the container matches `dataFormat`.
Hands the kernel the batch when `kernel.enableForArrays` is set
(identity in any `dataFormat`, a claimed kernel, or an int8/int16
CLUT). Otherwise walks the pipeline. Sets `transform.lastUsedKernel`
to the kernel `name`, or `'pipeline'` / `'cache'`.

### `transform.transformArray(inputArray, inputHasAlpha?, outputHasAlpha?, preserveAlpha?, pixelCount?, outputFormat?, outputArray?)`

Same as `array()`, plus `outputFormat`. If that differs from
`dataFormat`, the native result is passed through `Transform.reformat`.
Sixth argument is the format; seventh is the reformat destination.

| Configuration | `lastUsedKernel` |
|---|---|
| Identity (same file twice, any `dataFormat`) | `'kernelIdentity'` |
| `dataFormat: 'int8'`/`'int16'` and LUT built | `'kernel3D'` / `'kernel4D'` / … |
| Matrix-shaper pair, no LUT | `'matrix-shaper'` |
| Object formats on a colour conversion, or int/device with no LUT and no claim | `'pipeline'` |
| `pixelCache` live | `'cache'` |

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
* `outputFormat` — rescaled via `Transform.reformat` when it differs
  from `dataFormat`. `'int8'` / `'int16'` / `'float32'` / `'float64'` /
  `'device'`.
* `outputArray` — optional destination for the remapped result.

### `transform.transformArrayViaLUT(inputArray, inputHasAlpha?, outputHasAlpha?, preserveAlpha?, pixelCount?, outputArray?)`

Same work as `array()`, but throws `'No LUT loaded'` instead of walking
the pipeline. Requires `buildLut: true` and a table. Cost is one `if`.

* `outputArray` — optional pre-allocated buffer matching `dataFormat`.
  Must be at least `pixelCount × outputBPP` long. When provided, the
  same instance is returned — no allocation, no GC pressure. Ideal for
  real-time loops (video soft-proofing, animation).

Returns the same container `array()` would: `Uint8ClampedArray` for
`int8`, `Uint16Array` for `int16`, a plain `Array` for `device` /
object formats.

**WASM memory retention:** when `lutMode` is a WASM variant, each call
may grow WASM linear memory to fit the current image. This memory
persists and only grows (WASM spec limitation). Fixed-size workflows
(video, batches) stabilise after the first call. Mixed-size workflows
retain the high-water mark of the largest image unless explicitly
reclaimed — see [WASM memory management](#wasm-memory-management)
below.

### `transform.transformImages(images, options)`

Convert **1..n images**, using a worker pool when it is worth it. Returns a
promise. Full reference — the images array, per-image alpha overrides,
cancellation, backpressure, deployment and what the pool costs — is in
**[docs/pool.md](./pool.md)**.

```js
await Transform.enablePool();                  // Node: no argument needed
const { images, workersUsed } = await t.transformImages([
    { data: rgba1, pixelCount: 1920 * 1080, id: 'hero.tif' },
    { data: rgba2, pixelCount: 4000 * 3000, id: 'back.tif' },
], {
    multicore: true,
    inputHasAlpha: true, outputHasAlpha: true, preserveAlpha: true,
    onImage: (index, data, info) => save(data, info.id),
});
```

- **Always callable.** With no `worker_threads`, a restrictive CSP, `cores: 1`,
  or too little work to be worth splitting, it runs the images sequentially
  through `array()` and returns the identical bytes. `onImage` fires
  either way, so a caller never feature-detects. `workersUsed` is what was
  actually used — `0` means it ran on the calling thread.
- **Images finish out of order.** Slices are dispatched longest-first and
  pulled by whichever worker frees up, so `id` is the stable handle, not the
  index. One is generated from the position if you omit it.
- **`info`** carries `{id, index, pixelCount, outputChannels, ms, computeMs,
  cancelled, source}`. `ms` is wall time from the start of the call — what a
  progress bar wants; `computeMs` is summed worker time for that image and can
  legitimately exceed `ms`, because several workers were busy at once. `source`
  is your own descriptor, so metadata rides along.

### Pool control — `enablePool` / `disablePool` / `restartPool`

Static, process-wide, and separate from any one transform.

| Method | Notes |
|---|---|
| `await Transform.enablePool(options?)` | Start the pool. Under Node no argument is needed; a browser needs the worker bundle's URL. Calling it again with the same options is a no-op ("already enabled"); with *different* options it warns rather than silently leaving two pools alive. |
| `await Transform.restartPool(options?)` | Reconfigure a running pool — sugar for `enablePool({restart: true})`. Add `cancelQueue: true` to drop queued work instead of draining it. The reliable choice in tests, where pool state would otherwise leak between blocks. |
| `Transform.disablePool()` | Tear the pool down. Subsequent batches run sequentially. |

Sizing can also come from the environment — `JSCE_POOL_CORES`,
`JSCE_POOL_MAX_THREADS`, `JSCE_POOL_IDLE_MS`, `JSCE_POOL_DISABLE` and friends,
readable from `globalThis` in a browser or `process.env` under Node. Explicit
options always win. The motivating case is a cgroup-limited container, where
`os.availableParallelism()` reports the host's cores rather than your quota.
**Nothing there can change a pixel** — see [docs/pool.md](./pool.md#deployment).

### `transform.kernelInfo()`

What actually took this transform, after `create()` has resolved everything:

```js
t.kernelInfo();
// { name: 'matrix-shaper', variant: '8-simd', bits: 8, cache: 'not-supported', … }
```

`cache` is the pixel-cache **hint** result, not a contract:

| Value | Meaning |
|---|---|
| `'not-supported'` | This kernel has no cached export (matrix-shaper, identity, 1D/2D, ND). The fast path ran as-is. |
| `'off'` | 3D/4D CLUT kernel can take a cache; the hint was off or nothing was bound. |
| `1` | Single-entry array cache bound — same bits as last pixel skip the gather. |
| `N` | Array table bound, `N` slots (power of two). |

Worth calling when a `wasmMatrixShaper` transform is slower than expected — the
kernel declines silently by design, and this is the only place that says so.

### LUT access and loading

| Method | Returns | Notes |
|---|---|---|
| `transform.getLut()` | LUT object | The pre-built f64 CLUT. Strides, gamut mode, chain, and Lab encoding metadata included. Throws if no LUT. |
| `transform.getLut16()` | LUT object | Same shape, CLUT as base64 Uint16Array (u16 full-scale `[0..65535]`). `precision: 16`, `outputScale: 1/65535`. |
| `transform.getLut8()` | LUT object | CLUT as base64 Uint8Array (u8 full-scale `[0..255]`). `precision: 8`, `outputScale: 1/255`. |
| `transform.setLut(lut, opts?)` | — | Install an externally-built LUT (from `LutBuilder.toLut()`, `Transform.jsonToLut()`, or a previous `getLut()`). LUT is the authority: `setLut()` re-resolves `dataFormat`, `lutMode`, `_expectsU16`, and `buildIntLut` automatically. `opts.verify: true` checks the `originalSignature` and throws on mismatch. |

> **Prefer `transform.toJSON()` / `Transform.fromJSON()` for persistence.** The raw `getLut` / `setLut` primitives are in-memory transfers (typed arrays). For file/wire portability use the [JSON API](#portable-lut-json--tojson--fromjson--signatures) which also handles base64 encoding, stride regeneration, and scale normalisation.

### WASM memory management

When using WASM `lutMode` variants (`'int-wasm-scalar'`,
`'int-wasm-simd'`, `'int16-wasm-scalar'`, `'int16-wasm-simd'`), WASM
linear memory is allocated per-Transform and can only grow — it cannot
be returned to the OS by the WASM specification.

For fixed-size workflows (video frames, same-size image batches),
memory stabilises after the first call. For mixed-size workflows, a
one-off large image permanently inflates the buffer unless reclaimed.

#### Reclaiming WASM memory

| Method | Effect |
|---|---|
| `transform.compactWasmMemory()` | Re-instantiate all WASM states with fresh 1-page (64 KB) memory. ~0.1 ms cost + one LUT re-copy on next call. Transform stays fully functional. |
| `transform.setWasmShrinkRatio(N)` | Auto-compact after each transform when memory exceeds `N ×` what the just-processed image needed. E.g. `4` = compact when buffer is >4× oversized. Set `0` to disable (default). Also available as constructor option `{ wasmShrinkRatio: 4 }`. |
| `transform.setWasmMaxMemory(bytes)` | Absolute memory ceiling. Checked immediately after each transform — if WASM memory exceeds this, compacts right away. Default **128 MB**. Set `0` to disable. Also available as constructor option `{ wasmMaxMemory: N }`. |
| `transform.releaseWasmMemory()` | Drop all WASM states; the kernel falls back to pure-JS `'int'` kernels. Call `create()` to reload WASM. |
| `transform.wasmMemoryBytes()` | Returns total bytes held across all WASM states (diagnostic). |
| `transform = null` | Let GC collect everything — WASM, LUT, the lot. |

`wasmShrinkRatio` keeps memory proportional to the current workload
(prevents hovering at a high-water mark). `wasmMaxMemory` is a safety
net — an absolute cap that protects against runaway growth. Both checks
fire post-run, so the last image in a batch always cleans up.

**Typical patterns:**

```js
// Video / real-time: fixed frame size, no compaction needed.
// Memory stabilises after frame 1.
const t = new Transform({ dataFormat: 'int8', buildLut: true });
t.create(src, dst, intent);
for (const frame of frames) {
    t.transformArrayViaLUT(frame, ...);
}

// Batch with occasional large image: auto-compact.
const t = new Transform({
    dataFormat: 'int8', buildLut: true,
    wasmShrinkRatio: 4   // compact when memory > 4× needed
});
t.create(src, dst, intent);
for (const img of images) {
    t.transformArrayViaLUT(img, ...);  // auto-compacts after outliers
}

// Explicit cleanup after a known-large image:
t.transformArrayViaLUT(hugeImage, ...);
t.compactWasmMemory();   // reclaim immediately
```

For benchmarks and implementation details, see
[WASM memory management](./deepdive/WasmKernels.md#wasm-memory-management-v142)
in the deep dive.

### Lab ↔ int16 encoding helpers

When working with `dataFormat: 'int16'` transforms that involve a Lab
profile, the LUT carries encoding metadata so you can convert between
float Lab and the ICC u16 representation without knowing the profile
version:

```js
// Build a transform with a Lab output
const t = new Transform({ dataFormat: 'int16', buildLut: true });
t.create('*srgb', '*Lab', eIntent.relative);

// Encode float Lab → u16 (uses the output profile's ICC encoding)
const u16 = t.outputLab2Int16(50, 20, -30);  // [uL, ua, ub]

// Decode u16 → float Lab
const lab = t.outputInt162Lab(u16[0], u16[1], u16[2]);
// { type, L: 50, a: 20, b: -30, whitePoint: d50 }
```

**Transform methods** (read encoding from the LUT automatically):

| Method | Side | Direction |
|---|---|---|
| `inputLab2Int16(L, a, b)` | input profile | Lab → u16 |
| `outputLab2Int16(L, a, b)` | output profile | Lab → u16 |
| `inputInt162Lab(uL, ua, ub)` | input profile | u16 → Lab |
| `outputInt162Lab(uL, ua, ub)` | output profile | u16 → Lab |

Throws if the corresponding profile is not a Lab profile.

**Low-level** (`convert.*`) — portable, works without a Transform:

```js
const u16 = convert.lab2Int16(50, 20, -30, 'v4');
const lab = convert.int162Lab(u16[0], u16[1], u16[2], 'v4');
// Also accepts encoding objects: convert.labEncoding.v2, .v4
```

**LUT metadata** — `lut.inLab` / `lut.outLab` are auto-populated at
`create()` time. They are plain frozen objects (no functions), so they
survive `JSON.stringify`, `structuredClone`, and `postMessage` to
workers.

### LUT build hooks

Hooks let you warp the colour space during LUT construction — once per
grid cell, not per pixel at runtime. The warped values are baked into
the LUT cells so the per-pixel kernel stays fast (zero overhead).

```js
const xf = new Transform({
    dataFormat: 'int8',
    buildLut:   true,
    // Simple form — single hook via constructor
    lutOutputHook: (cmyk) => {
        cmyk[3] = Math.min(cmyk[3], 0.80);   // clamp K to 80%
        return cmyk;
    },
});
xf.create(sRGB, graCoL, eIntent.relative);
```

For composable / ordered hooks, use the method API:

| Method | Description |
|---|---|
| `addLutInputHook(fn, where?)` | Add a pre-transform hook. `where` = `'before'` (prepend) or `'after'` (append, default). |
| `addLutOutputHook(fn, where?)` | Add a post-transform hook. Same ordering. |
| `clearLutHooks()` | Remove all hooks. |

Hooks are called in array order. Each receives a plain `[c0, c1, …]`
array in device space [0–1] and must return an array of the same
length. `addLutInputHook(fn, 'before')` prepends so it runs first;
`addLutOutputHook(fn)` (default `'after'`) appends so it runs last.

**Output hooks** receive a second read-only argument — the original
grid-cell input — useful for logging and debugging:

```js
xf.addLutOutputHook((deviceOut, deviceIn) => {
    console.log('IN', deviceIn, '→ OUT', deviceOut);
    return deviceOut;
});
```

```js
xf.addLutOutputHook(clampK, 'after');
xf.addLutInputHook(boostSat, 'before');
xf.create(sRGB, graCoL, eIntent.relative);
```

A 33³ grid calls each hook 35 937 times; a 17⁴ grid 83 521 times.
Build cost increases by the hook's complexity; transform cost is
unchanged.

### Portable LUT JSON — `toJSON` / `fromJSON` / signatures

Bake a transform to a self-describing JSON file at deploy time; reconstruct it at runtime with no profiles.

```js
// Producer (build time)
const t = new Transform({ dataFormat: 'int8', buildLut: true });
t.create(cmykProfile, '*srgb', eIntent.relative);
fs.writeFileSync('lut.json', JSON.stringify(t));   // calls t.toJSON() automatically

// Consumer (runtime — no profiles, no lcms)
const t = Transform.fromJSON(fs.readFileSync('lut.json'), { dataFormat: 'int8' });
t.array(pixels);
```

**Instance method**

| Method | Returns | Notes |
|---|---|---|
| `transform.toJSON(opts?)` | plain object | Auto-called by `JSON.stringify(transform)` (JS protocol). `opts.dataType: 'u16'` (default, lossless) or `'u8'` (half size, lossy). Throws if no LUT — construct with `buildLut: true`. |

**Static methods**

| Method | Returns | Notes |
|---|---|---|
| `Transform.fromJSON(input, opts?)` | Transform | Accepts JSON string or parsed object. `opts` = constructor options (`dataFormat`, `lutMode`); `opts.verify: true` throws on signature mismatch. |
| `Transform.lutToJSON(lut, opts?)` | plain object | Format authority — encodes any LUT object. Strips strides (regenerated on decode) and forces canonical `inputScale`/`outputScale` to 1. |
| `Transform.jsonToLut(input)` | LUT object | Decodes JSON → normalised f64 CLUT in `[0..1]`. |

**Signature / verification**

Every LUT produced by `buildLut: true` carries `lut.originalSignature` (`"FNV1A:<8 hex>"`) over chain + grid + u16 pixel data, stamped lazily at `toJSON()` time (the hot transform path pays nothing).

| Method | Returns | Notes |
|---|---|---|
| `transform.signLut()` | string \| null | Current data signature. |
| `transform.verifyLut()` | boolean \| null | `true` = data matches stamped signature; `false` = mutated; `null` = no signature. |
| `Transform.signLut(lut)` | string | Static — compute signature for any LUT object. |
| `Transform.verifyLut(input)` | boolean \| null | Static — accepts LUT object, JSON string, or parsed object. |
| `transform.setLut(lut, opts?)` | — | `opts.verify: true` throws on signature mismatch at load time. |

> **`false` after `editLut()` is expected and correct.** `originalSignature` is a *source-of-trust marker* — it intentionally survives edits so recipients know what produced the original grid. `false` means the grid was modified after stamping, which is the normal outcome of an intentional edit (TAC limit, saturation tweak, etc.). Check `lut.meta.adjustments[]` to see what was applied. Only treat `false` as an error if the LUT is meant to be unmodified — for example, validating a received file against a known-good published signature.

---

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
| `pipelineCreated` | Boolean | True after a successful `create*` call. `transform()` / `array()` will throw `'No Pipeline'` if this is false. |
| `builtLut` | Boolean | True if a LUT has been prebuilt. |
| `lut` | Object \| `false` | The prebuilt CLUT, or `false` if none. |
| `lastUsedKernel` | String \| `null` | What `array()` actually ran last: the kernel `name`, or `'pipeline'` / `'cache'`. Null until the first batch. `transformArrayViaLUT` throws before `array()`, so a missing table leaves this unchanged. |

---

## Pinning older defaults — `Transform.compatibility()`

Defaults that move pixels are pinned **in code**, visibly, rather than through
the environment — ambient state that changes output is how a bug report becomes
unreproducible.

```js
Transform.compatibility('1.5');   // 1.5.0 output: no WASM matrix-shaper kernel
Transform.compatibility(null);    // back to current defaults
Transform.compatibility();        // returns the active pin
```

Call it once at startup, before constructing transforms. It applies to
transforms built afterwards; existing ones keep whatever they resolved at
`create()`. Use it when upgrading a pipeline whose output is regression-tested
byte-for-byte, then remove the pin once the new baseline is accepted.

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
// Default — 'auto' is implicit. Picks int-wasm-simd on int8+LUT
// transforms, falls back through the demotion chain on older hosts.
new Transform({ dataFormat: 'int8', buildLut: true });

// Same thing, explicit:
new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'auto' });

// Pin a specific kernel when you want determinism:
new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd' });
```

`lutMode` selects the inner-loop kernel for the **LUT image fast path**.
It only matters when `dataFormat: 'int8'` AND `buildLut: true` — the
single-pixel accuracy path is unaffected and always uses float.

| Value               | Since | Behaviour |
|---------------------|-------|-----------|
| `'auto'`            | v1.2 — **default** | Picks the fastest kernel for this `(dataFormat, buildLut)` combination. `int8` + `buildLut: true` → `'int-wasm-simd'` (with automatic SIMD → scalar WASM → JS `'int'` demotion on older hosts). Anything else → `'float'`. Inspect `xform.lutMode` post-construction to see the resolved value. |
| `'float'`           | v1.0 | Original float kernels. Bit-stable across releases. Pin for color-measurement / delta-E workflows. |
| `'int'`             | v1.1 | Integer kernels (Math.imul + Q0.8 weights + u16 mirror LUT). 1.10–1.25× over float, 4× less LUT memory. Pin for JS-only runtimes where you don't want to depend on WASM. |
| `'int-wasm-scalar'` | v1.2 | Same integer math as `'int'`, executed by a hand-written WASM kernel. 1.22–1.45× over `'int'`. Auto-demotes to `'int'` if WebAssembly isn't available. 4D falls through to the scalar 4D WASM kernel. |
| `'int-wasm-simd'`   | v1.2 | Channel-parallel WASM SIMD kernel. **2.04–3.50× over `'int'`**. Auto-demotes to `'int-wasm-scalar'` (and then `'int'`) if WASM SIMD / WASM isn't available. This is what `'auto'` picks for int8+LUT transforms. |
| (anything else)     | forward-compat | Auto-resolves the same way `'auto'` does. A typo or forward-written code referencing a future mode gets the best-available kernel instead of crashing. Verbose mode logs a warning. |

The string-enum API was chosen specifically so future kernels can be
added without changing the constructor signature. `'auto'` is the
default from v1.2+; pre-v1.2 the default was `'float'`, so existing
code that didn't set `lutMode` gets a transparent speedup on
int8+LUT transforms after upgrading, with no API change.

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
- ❌ Color-measurement / proofing accuracy testing where you need bit-exact reproduction of the float reference. Pin `lutMode: 'float'` (or set `buildLut: false` for the f64 pipeline) for that — `'int'` introduces ≤ 1 LSB drift (see accuracy table below), which is visually identical but not bit-identical. The default `'auto'` will use `'int-wasm-simd'` on int8+LUT transforms, which shares that ≤ 1 LSB budget.
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
thumb in `docs/deepdive/Performance.md` under "Caution — benchmark context
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
  adding the kernel loop, adding its row to that dimension's table
  (`src/kernels/3d/kernel3D_table.js` or
  `src/kernels/4d/kernel4D_table.js`), and extending `buildIntLut`'s
  `supported3D` / `supported4D` test. The kernel binds its own image
  path in `init()` — see [deepdive/KernelContract.md](./deepdive/KernelContract.md).
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
