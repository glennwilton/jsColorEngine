
jsColorEngine is a colour-management engine that uses ICC profiles to convert
colours, written in 100% JavaScript with no dependencies.

A lot of the core concepts and design ideas are based on LittleCMS, but this
is not a direct port — the implementation is independent and tuned for the
JavaScript runtime.

---

## Two ways to use it

The engine is built around two very different use cases. Picking the right
one matters more than any other choice you'll make:

| Use case | API | Speed | Accuracy | When to use |
|---|---|---|---|---|
| **Single colour / colour picker** | `transform.transform(colorObj)` | µs per call, slow per pixel | Full 64-bit precision, all stages run | UI colour pickers, swatch libraries, Lab/RGB/CMYK display, ΔE calculations, prepress maths |
| **Image / array processing** | `transform.transformArray(typedArray, ...)` | 20–40 Mpx/s on a desktop CPU | Slightly less accurate (LUT is finite resolution) | Soft-proofing, image conversion, video, anything pixel-bulk |

Both use the same `Transform` object — you choose which by calling either
`transform()` (single colour) or `transformArray()` (image bytes), and by
passing `{buildLut: true}` to the constructor when you want the fast path.

The library is deliberately split this way so you don't pay accuracy costs
for image work, and you don't pay speed-optimization tax (unrolled loops,
no bounds checks, typed arrays only) for one-off conversions.

---

## Install

Node:

```bash
npm i jscolorengine
```

```js
const { Profile, Transform, eIntent, color } = require('jscolorengine');

(async () => {
    // ACCURACY PATH — single colour, full precision
    // Build a Lab→sRGB pipeline once, then convert as many colours as you like.
    const lab2rgb = new Transform();
    lab2rgb.create('*lab', '*sRGB', eIntent.relative);

    const rgb = lab2rgb.transform(color.Lab(70, 30, 30));
    console.log(rgb);   // { R: 233, G: 149, B: 118, type: 5 }
})();
```

Browser — use the prebuilt bundle in [`browser/jsColorEngineWeb.js`](./browser/jsColorEngineWeb.js):

```html
<script src="jsColorEngineWeb.js"></script>
<script>
    // jsColorEngine is now a global object
    const lab2rgb = new jsColorEngine.Transform();
    lab2rgb.create('*lab', '*sRGB', jsColorEngine.eIntent.relative);

    const rgb = lab2rgb.transform(jsColorEngine.color.Lab(70, 30, 30));
    console.log(rgb);
</script>
```

### Environments

The engine ships with backends for three environments:

- **Node.js** — `fs.readFileSync` for local files, `http.get` for URLs
- **Browser** — `XMLHttpRequest` for URLs, base64 / `Uint8Array` for in-memory
- **Adobe CEP** (Photoshop / Illustrator panels) — uses `window.cep.fs` for
  local file reads

The right backend is selected automatically based on the runtime — no
configuration needed.

### Bundlers (Webpack, Vite, Angular, Next, etc.)

The package's `main` field points at the raw CommonJS source
(`src/main.js`), so any modern bundler can tree-shake and re-bundle it
normally:

```js
import { Profile, Transform, eIntent, color } from 'jscolorengine';
```

The `browser` field stubs out the Node-only modules (`fs`, `path`,
`util`, `child_process`) for browser builds. You should not need any
custom Webpack / Vite / Angular config.

If you previously had to fall back to `import 'jscolorengine/build/jsColorEngine.js'`
to dodge a `ReferenceError: self is not defined` in Node / SSR, that's
fixed in 1.0.5 (see [issues #2](https://github.com/glennwilton/jsColorEngine/issues/2)
and [#3](https://github.com/glennwilton/jsColorEngine/issues/3)).

### Compatibility note for old installs

If you see `jsColorEngine.color is undefined` on the line:

```js
const rgb = jsColorEngine.color.Lab(70, 30, 30);   // ← TypeError on <1.0.4
```

…you're on `jscolorengine` 1.0.0–1.0.3, which predates the `color` alias.
Either upgrade (`npm i jscolorengine@latest`) or use the original name:

```js
const rgb = jsColorEngine.convert.Lab(70, 30, 30);   // works in every version
```

`color` and `convert` are the same module — `color` was added in 1.0.4 as a
more semantically natural name (`color.Lab(...)` reads better than
`convert.Lab(...)`). See [issues #4](https://github.com/glennwilton/jsColorEngine/issues/4)
and [#5](https://github.com/glennwilton/jsColorEngine/issues/5).

---

## Virtual vs ICC profiles — which should you use?

You can describe a colour space two ways:

1. **Virtual** — a built-in name like `'*sRGB'`, `'*AdobeRGB'`, `'*ProPhotoRGB'`,
   `'*Lab'`. Built in memory from primaries + gamma, no file I/O, no decode.
2. **ICC file** — a real `.icc` / `.icm` profile, loaded from disk, URL,
   base64, or already-in-memory `Uint8Array`.

For the common working spaces — sRGB, Adobe RGB (1998), Apple RGB,
ColorMatch RGB, ProPhoto RGB — **virtual profiles are the right default.**
Most RGB ICC profiles in the wild are matrix + TRC profiles (no LUT), and
the maths is exactly the same as what the virtual constructor builds. Once
loaded, the engine cannot tell the two apart at runtime — they hit the
identical inlined matrix-and-gamma kernel. The only difference is startup
cost: a virtual profile is essentially free, an ICC file costs you a fetch
plus a decode.

So:

```js
// These two profiles are functionally identical.
// Prefer the virtual one — same maths, no I/O, no decode time.
const fast = new Profile('*sRGB');                   // ~0 ms
const slow = new Profile();                          // a few ms + network/disk
await slow.loadPromise('./profiles/sRGB_v4_ICC_preference.icc');
```

**Use a real ICC profile when you actually need one:**

- It's a CMYK or 3CLR/4CLR device profile (LUT-based — no virtual equivalent).
- It's a printer or scanner ICC with measurement-derived AtoB LUTs (the
  gamut mapping is real measured data, not a formula).
- It's a custom monitor profile from a calibrator (the primaries and TRC
  will not match a virtual sRGB).
- You need to faithfully reproduce another CMM's interpretation of a
  specific embedded profile (e.g. matching Photoshop's output exactly).

For everything else — UI colour pickers, web-image conversion, soft-proofing
against a CMYK profile — virtual on the working-space side is fine.

As an internal optimization, when the engine decodes an RGB ICC profile
that has no AtoB / BtoA LUT, it auto-promotes it to the same fast path
that virtual profiles use. So even if you do load `sRGB.icc`, you only
pay the startup cost — runtime conversion speed is identical.

---

## Engine features

### ICC profile support

- ICC v2 and v4 profiles (see [Limitations](#limitations) for the small
  edge-cases — most v4 profiles in the wild use the v2-compatible tag set
  and work without caveats)
- LUT-based and matrix-shaper profiles
- Parametric curves (function types 0–4, including sRGB)
- Lab and XYZ PCS

### Transform features

- Trilinear and tetrahedral interpolation
- Black point compensation
- Multi-step transforms (`profile → profile → profile → ...`)
- Pre-built transforms compiled to a 1D / 3D / 4D LUT for high-speed image work
- Custom pipeline stages — drop a function into the pipeline (e.g. desaturate
  at PCS) and it bakes into the precomputed LUT
- Chromatic adaptation for abstract Lab profiles
- Full debug mode showing values at every stage of the pipeline

### Modes of operation

- **Object pipeline** — accuracy path, takes typed colour objects like
  `{L, a, b}` or `{R, G, B}`, returns the same. Floats, 8-bit and 16-bit
  outputs all available.
- **Device pipeline** — takes flat float / int8 / int16 arrays like
  `[0, 255, 0]`, returns same — useful when you have raw channel data.
- **Image pipeline** — pre-builds a LUT and uses optimised n-dimensional
  interpolation over `Uint8ClampedArray` data. The fastest path; the
  small accuracy cost (LUT resolution) is invisible for display purposes.

### Input / output colour spaces

| Channels | Supported as input | Supported as output |
|---|---|---|
| Grey (1ch) | ✓ | ✓ |
| Duo (2 / 2CLR) | ✓ | ✓ |
| RGB (LUT and matrix) | ✓ | ✓ |
| CMY / 3CLR | ✓ | ✓ |
| CMYK / 4CLR | ✓ | ✓ |
| n-channel (>4) | — | ✓ (output only) |

### Built-in virtual profiles

`*Lab` / `*LabD50`, `*LabD65`, `*sRGB`, `*AdobeRGB`, `*AppleRGB`,
`*ColorMatchRGB`, `*ProPhotoRGB`. Names are case-insensitive and the leading
`*` is the marker that tells the loader "build this in memory, don't fetch
a file".

### Colour conversion helpers (no profiles needed)

`convert.*` (also exported as `color.*` — same module, more readable name)
provides direct maths between common spaces, useful when you don't want a
full pipeline:

- `RGB2Hex`
- `XYZ2xyY` ↔ `xyY2XYZ`
- `XYZ2Lab` ↔ `Lab2XYZ`
- `Lab2LCH` ↔ `LCH2Lab`
- `Lab2Lab` (with chromatic adaptation between whitepoints)
- `RGB2Lab` ↔ `Lab2RGB` via matrix transforms
- `XYZ2RGB` ↔ `RGB2XYZ` via matrix transforms
- `Lab2sRGB` ↔ `sRGB2Lab` (hard-coded sRGB matrices, fast path for UI)
- ΔE: `deltaE2000`, `deltaE94`, `deltaE76`, `deltaECMC`

### Spectral & measurement

For anyone working with a spectrophotometer (an i1Pro, Eye-One, ColorMunki,
GATCS reader, etc.) the engine includes a small spectral subsystem:

- Standard illuminants: A, C, D50, D55, D65 (and a few CIE F-series)
- Standard observers: CIE 1931 2°, CIE 1964 10°
- Convert spectral reflectance / transmittance to CIE XYZ under a chosen
  illuminant + observer
- `wavelength2RGB` — single-wavelength to displayable sRGB

This is what you use to take a raw spectro reading (a vector of
reflectance values across the visible spectrum) and turn it into XYZ /
Lab so you can compare it, store it, or run ΔE against a reference.
Useful for QC workflows, paint matching, metamerism analysis.

---

## How it works

The `Transform` class is the core of the engine. You give it a source
profile and a destination profile (and optionally a rendering intent and
some custom stages), and it builds an optimised pipeline between them.

The pipeline is a sequence of stages — each stage is a small function that
takes the previous stage's output and applies one well-defined transformation
(decode TRC, matrix multiply, interpolate LUT, encode TRC, etc.). After the
pipeline is built, redundant stages are removed (e.g. matched
encode/decode pairs that cancel out).

Building the pipeline is comparatively expensive but only happens **once**.
Converting a colour or an image then walks the pre-built pipeline — that
loop is what's been heavily tuned.

For image work (millions of pixels), the engine can pre-bake the entire
pipeline into a 1D / 3D / 4D LUT at construction time. After that,
conversion is a single n-dimensional interpolation per pixel — typically
20–40× faster than walking the full pipeline.

---

## Accuracy

As a baseline, the output has been compared to LittleCMS. Results are very
close but not bit-identical — the differences come from JavaScript using
64-bit floats throughout the pipeline, while LittleCMS switches between
double floats and 16-bit integers. For practical purposes the differences
are well below visible threshold.

There are larger differences in extreme cases (e.g. `Lab(0, 100, -100)` →
RGB) but these are well outside any real gamut and can be ignored.

---

## Speed

Single-colour `transform()` is in the microseconds — fine for UI work,
prepress calculations, and anything where you're converting tens or hundreds
of colours at a time.

For image work, build a LUT (`new Transform({buildLut: true})`) and use
`transformArray()`. On a Ryzen 3700X this runs at roughly **20–40 million
pixels per second**, fast enough for live web image conversion or moderate
video.

The two paths exist because the optimisations needed for the hot path
(unrolled loops, skipped bounds checks, typed-array-only IO, monomorphic
JIT shapes) actively hurt single-colour readability and correctness. So
the engine keeps them apart cleanly — accuracy on the object pipeline,
speed on the LUT path.

> **A note on JS engine optimisation, in case you ever go editing the
> hot loops:** several of the choices in there are deliberately
> counter-intuitive. Assigning intermediate computations to a temp `var`
> can tank performance vs. inlining the same expression — the V8 JIT
> tracks register lifetime through the inlined form and elides the
> read/write entirely, but a named temp can force a memory round-trip
> that defeats it. Similarly, walking a `Uint8ClampedArray` is faster
> than a regular `Array` because the JIT can specialise on the known
> element type, but only if the call site stays monomorphic (don't pass
> in mixed array types from different call sites — that triggers
> deoptimisation).
>
> Lesson: **always benchmark before and after.** What looks like a clear
> win on paper can lose 3× on a real engine, and what looks ugly can be
> the fastest thing the JIT will let you write.

---

## Examples

All of the snippets below are real, runnable code (assuming you have the
relevant ICC profile to hand).

### Convert a single Lab colour to CMYK (accuracy path)

```js
const { Profile, Transform, eIntent, color } = require('jscolorengine');

(async () => {
    // Load a real CMYK profile (no virtual equivalent for press CMYK)
    const cmykProfile = new Profile();
    await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');

    // Build a one-shot pipeline. No buildLUT — this is the accuracy path.
    const lab2cmyk = new Transform();
    lab2cmyk.create('*lab', cmykProfile, eIntent.perceptual);

    // Convert a single colour. Returns a typed object {C, M, Y, K, type}.
    const cmyk = lab2cmyk.transform(color.Lab(80.1, -22.3, 35.1));
    console.log(`CMYK: ${cmyk.C}, ${cmyk.M}, ${cmyk.Y}, ${cmyk.K}`);
})();
```

### Convert an RGB image to CMYK bytes (hot path)

```js
const { Profile, Transform, eIntent } = require('jscolorengine');

(async () => {
    const cmykProfile = new Profile();
    await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');

    // SPEED PATH — pre-build a LUT, choose an int8 IO format, enable BPC.
    // The constructor options here are what unlock the fast interpolator.
    const rgb2cmyk = new Transform({
        buildLut: true,
        dataFormat: 'int8',
        BPC: true
    });
    rgb2cmyk.create('*sRGB', cmykProfile, eIntent.relative);

    // imageData.data is a Uint8ClampedArray of [R, G, B, A, R, G, B, A, ...]
    // The 2nd / 3rd args say "input has alpha, output does not" — the alpha
    // channel is dropped from the output.
    const cmykBytes = rgb2cmyk.transformArray(imageData.data, true, false);

    // cmykBytes is now [C, M, Y, K, C, M, Y, K, ...] for use elsewhere.
})();
```

### Round-trip an image through CMYK and back to a `<canvas>`

Because `transformArray` returns a raw typed array (not an `ImageData`
object), you can't pass its result straight to `ctx.putImageData`. You need
`ctx.createImageData()` to allocate a fresh `ImageData`, then copy the
transformed bytes into its `.data` buffer. This is the bit that trips
people up — see [issue #1](https://github.com/glennwilton/jsColorEngine/issues/1).

```html
<script src="jsColorEngineWeb.js"></script>
<script>
(async () => {
    const { Profile, Transform, eIntent } = jsColorEngine;

    // Load the destination CMYK profile from a URL.
    const cmyk = new Profile();
    await cmyk.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');

    // Build a single soft-proof transform: sRGB -> CMYK -> sRGB.
    // BPC is per-stage: on for the perceptual leg, off for the relative leg.
    // dataFormat:'int8' guarantees a Uint8ClampedArray output that can drop
    // straight into ImageData. buildLut speeds up the per-pixel loop.
    const proof = new Transform({
        buildLut: true,
        dataFormat: 'int8',
        BPC: [true, false]
    });
    proof.createMultiStage([
        '*sRGB',  eIntent.perceptual,
        cmyk,     eIntent.relative,
        '*sRGB'
    ]);

    // Standard canvas read-modify-write pattern.
    const img = document.getElementById('source');         // an <img> already loaded
    const canvas = document.getElementById('preview');     // a <canvas> in the DOM
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const src = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Input has alpha (RGBA), output also has alpha — preserveAlpha copies
    // it through. The result is a Uint8ClampedArray of the same length.
    const proofedBytes = proof.transformArray(src.data, true, true);

    // You MUST allocate a fresh ImageData; you cannot pass a raw typed
    // array to putImageData.
    const out = ctx.createImageData(canvas.width, canvas.height);
    out.data.set(proofedBytes);
    ctx.putImageData(out, 0, 0);
})();
</script>
```

### Soft-proof an RGB image through CMYK back to RGB

This is the classic prepress preview: simulate what an RGB image will look
like after being printed on a CMYK device, by routing the pixels through
both profiles.

```js
const { Profile, Transform, eIntent } = require('jscolorengine');

(async () => {
    const cmykProfile = new Profile();
    await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');

    // Multi-stage transform: sRGB -> CMYK -> sRGB.
    // BPC is per-stage: enable on the perceptual leg, disable on the
    // relative leg (a common soft-proofing recipe).
    const proof = new Transform({
        buildLut: true,
        dataFormat: 'int8',
        BPC: [true, false]
    });
    proof.createMultiStage([
        '*sRGB',  eIntent.perceptual,
        cmykProfile, eIntent.relative,
        '*sRGB'
    ]);

    // Pass plain RGB triplets (no alpha). For canvas RGBA data, copy the
    // RGB channels into a 3-channel buffer first, run the transform, then
    // splice the alpha back in when writing to ImageData.
    const rgbIn  = new Uint8ClampedArray([255, 0, 0,  0, 255, 0,  0, 0, 255]);
    const rgbOut = proof.transformArray(rgbIn, false, false);

    console.log('soft-proofed sRGB:', Array.from(rgbOut));
})();
```

### Insert a custom pipeline stage

Custom stages let you intercept the pipeline at a known location (here, at
the PCS — Profile Connection Space, between the input and output profiles)
and modify the values. Useful for desaturation previews, channel swaps,
gamut warnings, etc. The stage runs inside the LUT build so you only pay
the cost once.

```js
const { Profile, Transform, eIntent, encoding } = require('jscolorengine');

(async () => {
    const cmykProfile = new Profile();
    await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');

    // A stage that converts whatever's at the PCS to grey.
    const desaturateAtPCS = {
        description: 'Convert to Grey',
        location: 'PCS',
        stageData: null,
        stageFn: function (input, data, stage) {
            if (stage.inputEncoding === encoding.PCSXYZ) {
                // XYZ at PCS — set X and Z to Y (rough greyscale approximation)
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

    const greyToCMYK = new Transform();
    greyToCMYK.create('*lab', cmykProfile, eIntent.perceptual, [desaturateAtPCS]);
})();
```

---

## Testing

```bash
npm test
```

Runs the Jest suite. Covers the transform pipeline (object IO, device IO,
LUT IO, multi-stage), and the lower-level `decodeICC` (parametric curves,
sampled `curv` curves, unsupported LUT sentinel behaviour).

---

## Limitations

The engine is deliberately scoped to the cases that matter for everyday
colour management. Things outside that scope:

- **Named Color profiles** (`ncl2`) and **Device Link profiles** are not
  supported.
- **DeviceN > 4 channels** as INPUT is not supported. n-channel >4 as
  output is supported.
- **MultiProcessElement** (`mpet`) profiles fall back gracefully — the ICC
  spec mandates that the standard `AtoB`/`BtoA` LUT tags are always
  present and valid in any conforming profile, so MPE-bearing profiles
  load fine and use the standard tags. MPE-only film/scientific workflows
  are not the target.
- **V2 `desc` tag**: only the ASCII portion is decoded. The Unicode and
  Macintosh ScriptCode portions that follow it are ignored. V4 profiles
  use `mluc` instead, which is fully decoded with all language records.
- **`inverseCurve`** (numerical inverse of a sampled curve) assumes
  overall monotonicity — locally non-monotonic curves degrade gracefully
  but are not reliably inverted. This is fine for ICC TRCs in practice.

---

## Documentation

- In-source JSDoc — every public class and method has up-to-date JSDoc with
  parameter docs, return types, and (where relevant) usage notes about the
  accuracy vs hot path. The source files are the most authoritative
  reference:
    - [`src/Profile.js`](./src/Profile.js) — load + decode + virtual profiles
    - [`src/Transform.js`](./src/Transform.js) — pipeline building + execution
    - [`src/Loader.js`](./src/Loader.js) — optional batch profile loader
    - [`src/convert.js`](./src/convert.js) — colour-space helper maths
    - [`src/decodeICC.js`](./src/decodeICC.js) — low-level ICC binary decoders
    - [`src/Spectral.js`](./src/Spectral.js) — spectral / illuminant maths
- Older API reference docs:
  [`docs/Profile.md`](./docs/Profile.md),
  [`docs/Transform.md`](./docs/Transform.md),
  [`docs/Loader.md`](./docs/Loader.md). These cover the public method
  signatures but predate the recent in-source JSDoc additions.
- Recent changes: [CHANGELOG.md](./CHANGELOG.md).

---

## License

GPLv3.

jsColorEngine is free software: you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option)
any later version.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
more details.

You should have received a copy of the GNU General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.

Portions of this software are conceptually based on the work of:

- [LittleCMS](https://www.littlecms.com) (color management architecture)
- Bruce Lindbloom (RGB / XYZ / Lab math, ΔE formulas)
- BabelColor (RGB working-space primaries reference)
