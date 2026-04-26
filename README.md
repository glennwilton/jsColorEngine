# jsColorEngine

**A fast, accurate ICC colour-management engine for JavaScript — 100 %
native JS, zero dependencies, optional WASM for the hot path.**

- **Fast.** Over **200 million pixels per second** — roughly **25
  4K images per second** on a single CPU thread with WASM SIMD
  enabled. Hot-path kernels hand-tuned for V8 / SpiderMonkey / JSC;
  optional WebAssembly (scalar + SIMD) kernels for the image path.
  **Faster than steelmanned native C LittleCMS on 3 of 4 image
  workflows in pure JavaScript** (same hardware, same profile,
  same compiler, lcms2 built with every optimisation flag short of
  PGO — see [Speed](#speed)).
- **Accurate.** **LUT-free mode** (`buildLut: false`) — every pixel
  walks the full f64 pipeline, no LUT quantisation, no rounding
  short-cuts. For colour-critical / prepress / proof / measurement
  work where ΔE matters more than MPx/s. Available on both APIs.
  See [Accuracy](#accuracy).
- **Fully-featured CMS.** Everything you'd expect from a mature
  colour-management library: RGB, CMYK, Lab, XYZ, and 3CLR/4CLR
  device spaces; ICC v2 and v4 profile loading (LUT-based **and**
  matrix-shaper); built-in virtual profiles (sRGB, AdobeRGB, Lab,
  XYZ); all four rendering intents; black-point compensation;
  trilinear / tetrahedral interpolation; multi-step transforms;
  custom pipeline stages spliced in at PCS; ΔE76 / ΔE2000 helpers;
  and spectral / illuminant maths for measurement workflows. See
  [Features at a glance](#features-at-a-glance).
- **Runs everywhere JavaScript does.** Node, browsers, Electron,
  web workers, React Native (with a Buffer polyfill). No native
  bindings, no compile step, no platform-specific binaries.
- **Two APIs, one `Transform`.** `transform(colorObj)` for single
  colours (µs/call, always LUT-free). `transformArray(typedArray)`
  for bulk — pre-baked LUT at 45–210 MPx/s, or LUT-free f64 when
  you need accuracy over throughput. See
  [Two paths, one Transform](#two-paths-one-transform).

### Why compare against LittleCMS?

[**LittleCMS**](https://www.littlecms.com/) is the de-facto standard
open-source ICC colour-management engine — 25 years of Marti Maria's
work, shipped in GIMP, darktable, CUPS, Krita, and most professional
RIPs. We benchmark against it in two flavours, because both are
reasonable baselines for different audiences:

- [`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm) — the
  Emscripten port that the rest of the JS ecosystem reaches for when
  they need ICC colour today. This is the engine most users would
  realistically compare against.
- **Native C lcms2** (gcc `-O3 -march=native`, plus the **steelman
  build** with `-ffast-math -funroll-loops -flto` — see
  `bench/lcms_c/README.md`) — what you'd get by calling `liblcms2`
  via a Node addon, a Python C extension, or a native binary. This
  is the ceiling of what the C ecosystem offers with compiler
  optimisation alone, before you reach for the `fast-float` SIMD
  plugin or babl.

We compare against both because one of them (WASM) is what a JS
developer would actually install, and the other (native) is what
they'd reach for to escape to C if they didn't believe pure-JS could
be fast enough. The numbers below are all measured on the same
hardware, in the same session, with the same input bytes.

- **~1.5–2.1× faster than `lcms-wasm`** on pure JS,
  **~4.5–6.5× with WASM SIMD** enabled.
- **Beats steelmanned native C LittleCMS on 3 of 4 image workflows
  in pure JavaScript** on the same hardware (1.04×, 0.93×, 1.49×,
  1.40× for RGB→Lab, RGB→CMYK, CMYK→RGB, CMYK→CMYK respectively).
  Native C is compiled with `-O3 -march=native -ffast-math
  -funroll-loops -flto` — every compiler trick short of PGO — so the
  comparison isn't a strawman. Enable the WASM SIMD default and we
  win all four by **2–5×**. Full measured table in
  [docs/Performance.md §4](./docs/Performance.md#measured--vs-native-littlecms-same-hardware-same-run).
- **Faithful float-precision peer of LittleCMS.** jsCE's float
  pipeline matches lcms2 native f64 to **≤ 0.06 ΔE76 (Lab) / ≤ 1.24
  LSB (RGB) / ≤ 0.04 % ink (CMYK)** across 130 reference files and
  ~580 k samples. The image-path LUT quantises that math to **≤ 1 LSB
  on 98.5–100 % of samples** vs `lcms-wasm`. Both validation harnesses
  ship in the repo. Methodology and the one documented outlier are
  in [`docs/deepdive/Accuracy.md`](./docs/deepdive/Accuracy.md). See
  [Accuracy](#accuracy).
- **No WASM required, no native bindings, no compile step.** The
  pure-JS kernels already beat `lcms-wasm` on every direction; WASM
  scalar and WASM SIMD modes are opt-in toppings that demote cleanly
  on hosts that don't support them.
- **~1.9× smaller over the wire.** ~267 KB raw / ~68 KB gzip / ~53
  KB brotli in a single JS file, including virtual profiles,
  spectral data, the full ICC v2/v4 decoder, **and 8 inline base64
  WASM modules (3D + 4D × scalar/SIMD × u8/u16) that load
  synchronously with no fetch**. `lcms-wasm` ships a 41 KB JS shim
  plus a separate ~309 KB `.wasm` payload (~129 KB gzip combined,
  two fetches, async init).

> The "pure JS beats native C" finding surprised us too. It's a
> **specialisation story, not a language-speed story** — jsCE runs
> hand-unrolled kernels for each specific LUT shape; lcms2 runs a
> general-purpose stage-walker that handles any profile. V8 /
> TurboFan and `gcc -O3` produce comparable machine code for tight
> integer loops; the performance gap is what each engine is
> *executing*, not the language it's written in. Deep dive:
> [docs/deepdive/JitInspection.md](./docs/deepdive/JitInspection.md).

### Don't believe us — run it yourself

Every MPx/s number in this README and in
[docs/Performance.md](./docs/Performance.md) was measured with
the in-browser bench at [`bench/browser/`](./bench/browser/)
([live](https://www.o2creative.co.nz/jscolorengine/bench/browser/)).
It runs every `lutMode` against the real `lcms-wasm` library, on *your*
hardware, in *your* browser — zero upload, zero telemetry, everything
runs locally.

```bash
npm run browser                                       # build the UMD bundle (once)
cd bench/lcms-comparison && npm install && cd ../..   # one-time, enables lcms rows
npm run bench:browser                                 # open http://localhost:8080/
```

The bench has five tabs: Full comparison (every direction × every
mode), Accuracy sweep (Lab round-trip ΔE76), JIT warmup curve,
pixel-count / cache-tier sweep, and an in-page methodology essay.
A "Copy markdown" button serialises your results for pasting into an
issue.

See **[docs/Bench.md](./docs/Bench.md)** for the full guide, the
methodology notes, and the submission template if your numbers
disagree with ours.

> Benchmarks quoted here were measured on one developer machine
> (Node 20, V8, x64). Ratios (1.5× over lcms-wasm, 3.25× for WASM SIMD
> over plain JS) should be stable across x64; absolute MPx/s will move
> with your CPU. User-submitted results on other OSes / CPUs /
> browsers are welcome — **and methodology critiques are equally
> welcome**; if we're measuring wrong we'd rather hear about it.

A lot of the core concepts are lifted from LittleCMS. This is **not**
a port — the implementation is independent, written for how a JIT
compiler sees numeric typed-array loops. If you want to see how that
changes the code, [the deep dive](./docs/deepdive/) has the V8
assembly walkthroughs.

---

## Table of contents

- [Why compare against LittleCMS?](#why-compare-against-littlecms)
- [Don't believe us — run it yourself](#dont-believe-us--run-it-yourself)
- [Two paths, one Transform](#two-paths-one-transform)
- [Install](#install)
- [Quick start](#quick-start)
- [Features at a glance](#features-at-a-glance)
- [Virtual vs ICC profiles — which should you use?](#virtual-vs-icc-profiles--which-should-you-use)
- [Accuracy](#accuracy)
- [Speed](#speed)
- [Examples](#examples)
- [Testing](#testing)
- [Limitations](#limitations)
- [Documentation](#documentation)
- [License](#license)

---

## Two paths, one Transform

The engine is built around two very different use cases. Picking the
right one matters more than any other choice you'll make.

| Use case | API | Speed | Accuracy | When to use |
|---|---|---|---|---|
| **Single colour / colour picker** | `transform.transform(colorObj)` | µs per call, slow per pixel | Full 64-bit precision, all stages run | UI colour pickers, swatch libraries, Lab/RGB/CMYK display, ΔE calculations, prepress maths |
| **Image / array processing** | `transform.transformArray(typedArray, ...)` | 45–210 MPx/s on a desktop CPU | Slightly less accurate (LUT is finite resolution) | Soft-proofing, image conversion, video, anything pixel-bulk |

Both live on the same `Transform` object — you pick which by calling
`transform()` or `transformArray()`, and by passing `{buildLut: true}`
to the constructor when you want the image path.

The library is deliberately split this way so you don't pay accuracy
costs for image work, and you don't pay speed-optimisation tax
(unrolled loops, skipped bounds checks, typed arrays only) for
one-off conversions.

Architectural detail and the "don't do this" anti-pattern warning
live in [deep dive / Architecture](./docs/deepdive/Architecture.md).

---

## Install

```bash
npm i jscolorengine
```

### Node

```js
const { Profile, Transform, eIntent, color } = require('jscolorengine');

(async () => {
    // ACCURACY PATH — single colour, full precision.
    // Build a Lab→sRGB pipeline once, then convert as many colours as you like.
    const lab2rgb = new Transform();
    lab2rgb.create('*lab', '*sRGB', eIntent.relative);

    const rgb = lab2rgb.transform(color.Lab(70, 30, 30));
    console.log(rgb);   // { R: 233, G: 149, B: 118, type: 5 }
})();
```

### Browser — UMD bundle

The prebuilt UMD bundle at
[`browser/jsColorEngineWeb.js`](./browser/jsColorEngineWeb.js) exposes
everything on a global `jsColorEngine`:

```html
<script src="jsColorEngineWeb.js"></script>
<script>
    const lab2rgb = new jsColorEngine.Transform();
    lab2rgb.create('*lab', '*sRGB', jsColorEngine.eIntent.relative);

    const rgb = lab2rgb.transform(jsColorEngine.color.Lab(70, 30, 30));
    console.log(rgb);
</script>
```

### Bundlers (Webpack, Vite, Next, Angular, …)

The package's `main` field points at the raw CommonJS source
(`src/main.js`), so any modern bundler can tree-shake and re-bundle
it normally:

```js
import { Profile, Transform, eIntent, color } from 'jscolorengine';
```

The `browser` field stubs out the Node-only modules (`fs`, `path`,
`util`, `child_process`) for browser builds. No extra bundler config
should be needed.

### Environments

The engine ships with backends for three environments and picks the
right one automatically:

- **Node.js** — `fs.readFileSync` for local files, `http.get` for URLs
- **Browser** — `XMLHttpRequest` for URLs, base64 / `Uint8Array` for in-memory
- **Adobe CEP** (Photoshop / Illustrator panels) — `window.cep.fs` for local reads

### On old installs (1.0.0 – 1.0.3)

If `jsColorEngine.color` is undefined, you're on pre-1.0.4. Either
upgrade (`npm i jscolorengine@latest`) or use the original export
name `jsColorEngine.convert.Lab(…)` — `color` and `convert` are the
same module. See
[#4](https://github.com/glennwilton/jsColorEngine/issues/4),
[#5](https://github.com/glennwilton/jsColorEngine/issues/5).

The 1.0.5 release also fixed a `ReferenceError: self is not defined`
that required falling back to `jsColorengine/build/…` in some SSR
setups —
[#2](https://github.com/glennwilton/jsColorEngine/issues/2),
[#3](https://github.com/glennwilton/jsColorEngine/issues/3).

---

## Quick start

### Single colour — Lab to CMYK (accuracy path)

```js
const { Profile, Transform, eIntent, color } = require('jscolorengine');

(async () => {
    const cmykProfile = new Profile();
    await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');

    // No buildLut — this is the accuracy path.
    const lab2cmyk = new Transform();
    lab2cmyk.create('*lab', cmykProfile, eIntent.perceptual);

    const cmyk = lab2cmyk.transform(color.Lab(80.1, -22.3, 35.1));
    console.log(`CMYK: ${cmyk.C}, ${cmyk.M}, ${cmyk.Y}, ${cmyk.K}`);
})();
```

### Image bytes — RGB to CMYK (hot path)

```js
const { Profile, Transform, eIntent } = require('jscolorengine');

(async () => {
    const cmykProfile = new Profile();
    await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');

    // SPEED PATH — pre-bake a LUT, pick int8 IO, enable BPC.
    // lutMode defaults to 'auto' which resolves to the fastest
    // WASM SIMD kernel available on the host (with automatic
    // demotion to scalar WASM / JS int on older runtimes).
    const rgb2cmyk = new Transform({
        buildLut:   true,
        dataFormat: 'int8',
        BPC:        true
    });
    rgb2cmyk.create('*sRGB', cmykProfile, eIntent.relative);

    // imageData.data is [R, G, B, A, R, G, B, A, ...].
    // 2nd / 3rd args say "input has alpha, output does not" — alpha dropped.
    const cmykBytes = rgb2cmyk.transformArray(imageData.data, true, false);
    // cmykBytes is now [C, M, Y, K, C, M, Y, K, ...].
})();
```

### Soft-proof an RGB image through CMYK back to RGB

The classic prepress preview — simulate what an RGB image will look
like printed on a CMYK device by routing pixels through both profiles
in one pre-built transform.

```js
const { Profile, Transform, eIntent } = require('jscolorengine');

(async () => {
    const cmykProfile = new Profile();
    await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');

    // BPC is per-stage: enable on the perceptual leg, disable on the
    // relative leg — a common soft-proofing recipe. lutMode defaults
    // to 'auto' → best available SIMD/WASM/JS kernel.
    const proof = new Transform({
        buildLut:   true,
        dataFormat: 'int8',
        BPC:        [true, false]
    });
    proof.createMultiStage([
        '*sRGB',     eIntent.perceptual,
        cmykProfile, eIntent.relative,
        '*sRGB'
    ]);

    const rgbIn  = new Uint8ClampedArray([255, 0, 0,  0, 255, 0,  0, 0, 255]);
    const rgbOut = proof.transformArray(rgbIn, false, false);

    console.log('soft-proofed sRGB:', Array.from(rgbOut));
})();
```

More examples (canvas round-trip, custom pipeline stages) are in
[docs/Examples.md](./docs/Examples.md).

---

## Features at a glance

### ICC profiles

- v2 and v4 profiles — LUT-based **and** matrix-shaper
- Parametric curves (function types 0–4, including sRGB)
- Lab and XYZ Profile Connection Space
- Grey / Duo / RGB / CMY / CMYK / 3CLR / 4CLR / n-channel output

### Transforms

- Trilinear and tetrahedral interpolation (tetrahedral is the default)
- Rendering intents: perceptual, relative, saturation, absolute
- Black point compensation (global or per-stage)
- Multi-step transforms: `profile → profile → profile → …`
- Custom pipeline stages — drop a function into the chain at PCS (or
  any other named location) and it bakes into the precomputed LUT
- Chromatic adaptation for abstract Lab profiles
- Full debug mode showing values at every stage
- **Baked gamut warnings & maps** — embed out-of-gamut detection
  directly into the LUT at build time (zero per-pixel cost). Four
  modes: hard-threshold colour replace, continuous ΔE heatmap
  (white → warning colour), raw ΔE map for analysis, or off.
  Pluggable ΔE function (`deltaE1976` default, swap in `deltaE2000`
  etc.). See [Transform docs](./docs/Transform.md#gamut-warning-modes).

### Kernel modes (`lutMode`)

Eight values, plus `'auto'` (the default) which picks the best
kernel for your `(dataFormat, buildLut)` combination automatically.
Pin a specific mode when you want determinism, or rely on `'auto'`
and let `create()` resolve to the fastest kernel the host can run.

**8-bit I/O — `dataFormat: 'int8'`** (Uint8 / Uint8Clamped buffers)

| Mode | Kernel | Throughput vs `'int'` | When |
|---|---|---|---|
| `'float'` | f64 CLUT, JS | baseline | pin for bit-stable f64 LUT interp across releases |
| `'int'` | u16 CLUT, JS int32 | baseline | pin when you want JS-only, no WASM |
| `'int-wasm-scalar'` | u16 CLUT, WASM | **1.22–1.45×** | pin for WASM without SIMD (rare — benchmarking) |
| `'int-wasm-simd'` | u16 CLUT, WASM v128 | **2.04–3.50×** | what `'auto'` picks for int8+LUT; pin to fail loudly on non-SIMD hosts |

**16-bit I/O — `dataFormat: 'int16'`** (Uint16 buffers, full
[0..65535] range, Q0.13 fractional weights — shipped in v1.3)

| Mode | Kernel | Throughput vs `'int16'` | When |
|---|---|---|---|
| `'int16'` | u16 CLUT @ 65535, JS int32 | baseline | pin when you want JS-only, no WASM |
| `'int16-wasm-scalar'` | u16 CLUT, WASM | **~1.3–1.4×** (3D) | pin for WASM without SIMD |
| `'int16-wasm-simd'` | u16 CLUT, WASM v128 | **~2.0–2.6×** | what `'auto'` picks for int16+LUT |

The three u16 kernels are **bit-exact against each other** across
the full (mode × inCh × outCh) matrix. Browser-bench headline:
`int16-wasm-simd` lands **3.9–4.9× over `lcms-wasm` 16-bit** on
every workflow (158 MPx/s RGB→RGB, 149 RGB→CMYK, 90 CMYK→RGB,
86 CMYK→CMYK on Chrome 147 / x86_64).

Demotion is automatic in both ladders:

- 8-bit: `'int-wasm-simd'` → `'int-wasm-scalar'` → `'int'`
- 16-bit: `'int16-wasm-simd'` → `'int16-wasm-scalar'` → `'int16'`

You can set the SIMD mode globally and older hosts just fall
through; `'auto'` does the same thing by default for `int8+LUT`
and `int16+LUT` transforms and resolves to `'float'` for anything
else (which is what the engine would have used anyway — `lutMode`
is ignored for non-int dataFormats). Inspect `xform.lutMode` after
construction to see what will actually run.

Details: [deep dive / LUT modes](./docs/deepdive/LutModes.md) ·
[deep dive / WASM kernels](./docs/deepdive/WasmKernels.md) ·
[v1.3 16-bit kernel ladder in Roadmap](./docs/Roadmap.md#shipped-so-far).

### Colour conversion helpers (no profiles needed)

`color.*` (exported as both `color.*` and `convert.*`) provides
direct maths between common spaces — useful when you don't need a
full pipeline:

- `XYZ2xyY` ↔ `xyY2XYZ` · `XYZ2Lab` ↔ `Lab2XYZ` · `Lab2LCH` ↔ `LCH2Lab`
- `Lab2Lab` (chromatic adaptation across whitepoints)
- `RGB2Lab` ↔ `Lab2RGB` · `XYZ2RGB` ↔ `RGB2XYZ` (virtual RGB matrices)
- `Lab2sRGB` ↔ `sRGB2Lab` (hard-coded sRGB, fast path for UI)
- `RGB2Hex`
- ΔE: `deltaE2000`, `deltaE94`, `deltaE76`, `deltaECMC`

### Built-in virtual profiles

`*Lab` / `*LabD50`, `*LabD65`, `*sRGB`, `*AdobeRGB`, `*AppleRGB`,
`*ColorMatchRGB`, `*ProPhotoRGB`. Names are case-insensitive; the
leading `*` tells the loader "build this in memory, don't fetch a
file".

### Spectral & measurement

For anyone working with a spectrophotometer (i1Pro, ColorMunki, etc.):

- Standard illuminants: A, C, D50, D55, D65, CIE F-series
- Standard observers: CIE 1931 2°, CIE 1964 10°
- Convert spectral reflectance / transmittance → CIE XYZ under a
  chosen illuminant + observer
- `wavelength2RGB` — single-wavelength → displayable sRGB

---

## Virtual vs ICC profiles — which should you use?

You can describe a colour space two ways:

1. **Virtual** — a built-in name like `'*sRGB'`, `'*AdobeRGB'`, `'*ProPhotoRGB'`,
   `'*Lab'`. Built in memory from primaries + gamma. No file I/O, no decode.
2. **ICC file** — a real `.icc` / `.icm` profile, loaded from disk, URL,
   base64, or already-in-memory `Uint8Array`.

For the common working spaces — sRGB, Adobe RGB, Apple RGB,
ColorMatch RGB, ProPhoto RGB — **virtual is the right default.** Most
RGB ICC profiles in the wild are matrix + TRC (no LUT), and the
maths is identical to what the virtual constructor builds. Once
loaded, the engine can't tell them apart — they hit the same inlined
kernel. The only difference is startup cost.

```js
// These two profiles are functionally identical.
// Prefer the virtual one — same maths, no I/O, no decode time.
const fast = new Profile('*sRGB');                   // ~0 ms
const slow = new Profile();                          // a few ms + fetch/disk
await slow.loadPromise('./profiles/sRGB_v4_ICC_preference.icc');
```

**Use a real ICC profile when you actually need one:**

- It's a CMYK or 3CLR/4CLR device profile (LUT-based — no virtual equivalent).
- It's a printer or scanner profile with measurement-derived AtoB / BtoA LUTs.
- It's a calibrated monitor profile (primaries/TRC won't match virtual sRGB).
- You need to faithfully reproduce another CMM's interpretation of a
  specific embedded profile (e.g. matching Photoshop's output exactly).

As an internal optimisation, when the engine decodes an RGB ICC
profile that has no AtoB / BtoA LUT, it auto-promotes it to the same
fast path that virtual profiles use. So even a loaded `sRGB.icc`
only pays decode cost — runtime is identical.

---

## Accuracy

> **TL;DR:** the float pipeline matches LittleCMS to **≤ 0.06 ΔE76 on
> Lab outputs, ≤ 1.24 LSB on 8-bit RGB, ≤ 0.04 % ink on CMYK** across
> 130 reference files (~580 k in-gamut samples) measured against an
> lcms2 2.16 full-f64 oracle. The image-path LUT quantises that math
> to **≤ 1 LSB on 98.5 – 100 % of samples** vs lcms-wasm. All named
> reference colours (white, black, primaries, mid-greys, skin tone,
> paper white, rich black) match exactly or within 1 LSB. Residual
> drift is well below visible threshold across both paths and the
> remaining outliers are documented and explained — see
> [`docs/deepdive/Accuracy.md`](./docs/deepdive/Accuracy.md) for the
> full methodology, headline numbers, the one structural divergence
> we found, and the philosophy that keeps jsColorEngine an
> independent engine rather than an lcms reimplementation.

jsColorEngine has **two accuracy paths** and a separate validation
harness for each:

### 1. Float pipeline vs lcms native f64 (`bench/lcms_compat/`)

The "is the underlying math right?" question. Measured against a
committed reference oracle of 150 CGATS `.it8` files generated from
LittleCMS 2.16's full f64 float pipeline (`TYPE_*_DBL`). 130 files
pass, 20 SKIP (lcms-internal XYZ-identity working profiles —
[v1.5 follow-up](./docs/Roadmap.md)), 0 ERROR. Worst-case in-gamut
error per output type:

| Output type   | Worst case | Unit       | Verdict |
|---|---:|---|---|
| Lab           | **0.06**   | ΔE76       | 16× below the ΔE 1.0 visibility threshold |
| RGB → RGB     | **1.24**   | LSB at u8  | invisible at 8-bit display precision |
| CMYK ink      | **0.04 %** | ink        | well below dot-gain measurement noise |
| 2C spot       | **2.88e-4**| fraction   | noise floor — basically zero |

`node bench/lcms_compat/run.js` reproduces this in ~1.3 s on a
current laptop. Per-pixel triage for any divergence is in
`bench/lcms_compat/probe-pixel.js`. Full writeup, including the one
documented outlier (`* → ISOcoated_v2_grey1c_bas.ICC` Perceptual
without BPC — a profile-table-interpretation difference, both
readings spec-permissive) is in
[`docs/deepdive/Accuracy.md`](./docs/deepdive/Accuracy.md).

### 2. Image-path LUT vs lcms-wasm (`bench/lcms-comparison/`)

The "after the LUT quantises everything, do we still agree?"
question. Measured against `lcms-wasm` (LittleCMS 2.16 compiled to
WASM) on a systematic 9^N input grid plus named reference colours,
with `cmsFLAGS_HIGHRESPRECALC` on the lcms side so both engines
precalc LUTs at the same grid density.

| Workflow | within 1 LSB | max Δ | mean Δ |
|---|---|---|---|
| RGB → Lab   | **100.00 %** | 1 LSB   | 0.004 LSB |
| RGB → CMYK  | **100.00 %** | 1 LSB   | 0.016 LSB |
| CMYK → RGB  | 98.51 %      | 14 LSB\* | 0.073 LSB |
| CMYK → CMYK | 98.83 %      | 4 LSB   | 0.141 LSB |

`node bench/lcms-comparison/accuracy.js` reproduces this on your
hardware.

<small>\* The 14-LSB max on CMYK → RGB is confined to
deep-cyan-saturated **out-of-gamut** inputs (e.g. `(192,0,64,32)`)
whose Lab coordinate falls outside sRGB's gamut — both engines clip
but at different stages, producing different bounded guesses. 98.5 %
of even these OOG points still agree within 1 LSB. The two engines
have different OOG-clamping conventions (jsCE clamps to device
range; lcms's float pipeline doesn't); see
[Accuracy deepdive § Where jsColorEngine deliberately diverges](./docs/deepdive/Accuracy.md#where-jscolorengine-deliberately-diverges-from-lcms).</small>

For ΔE-critical work (colour measurement, calibration QA), use
`lutMode: 'float'` and skip the LUT entirely — see
[Quick reference](./docs/Performance.md#7-quick-reference--when-to-enable-what).

### 3. 16-bit kernel ladder (`dataFormat: 'int16'`, v1.3)

For workflows that need extra headroom over the u8 ladder — TIFF
processing, intermediate image stages, anything where 1 LSB at u8
isn't quite tight enough — pass `dataFormat: 'int16'` and the
engine routes through the v1.3 u16 kernel ladder. Pure-kernel
quantisation noise (jsCE float-LUT vs jsCE int16-LUT) is **≤ 4 LSB
u16 max, mean ≤ 0.48 LSB across all four image directions** —
roughly 65× tighter than the u8 path because Q0.13 weights and the
65535-scaled CLUT keep the rounding budget below the u16 LSB.
The JS / WASM scalar / WASM SIMD u16 kernels are **bit-exact
against each other** across the full coverage matrix; the identity
gate at [`bench/int16_identity.js`](./bench/int16_identity.js)
asserts kernels round at the u16 LSB on every release.

---

## Speed

Single-colour `transform()` is microsecond-scale — fine for UI,
prepress calcs, anything converting tens to hundreds of colours at a
time.

For image work: build a LUT (`new Transform({buildLut: true})`) and
use `transformArray()`. Headline throughput on Node 20 / V8 / x64,
GRACoL2006 CMYK profile, 65 K pixels per iter, median of 5 × 100
iters:

**8-bit I/O** (`dataFormat: 'int8'`)

| Workflow | `'int'` (u16, JS) | `'int-wasm-scalar'` | `'int-wasm-simd'` | FPS @ 1080p (SIMD)† |
|---|---|---|---|---|
| RGB → RGB   (sRGB → AdobeRGB) | 72 MPx/s | ~101 MPx/s | **~234 MPx/s** | **113 fps** |
| RGB → CMYK  (sRGB → GRACoL)   | 62 MPx/s | ~87 MPx/s  | **~210 MPx/s** | **101 fps** |
| CMYK → RGB  (GRACoL → sRGB)   | 59 MPx/s | ~72 MPx/s  | **~125 MPx/s** | **60 fps** |
| CMYK → CMYK (GRACoL → GRACoL) | 49 MPx/s | ~60 MPx/s  | **~125 MPx/s** | **60 fps** |

**16-bit I/O** (`dataFormat: 'int16'`, v1.3 — Chrome 147 / x86_64,
65 K pixels/iter, vs `lcms-wasm` 16-bit best for context)

| Workflow | `'int16'` (JS) | `'int16-wasm-scalar'` | `'int16-wasm-simd'` | lcms-wasm 16-bit |
|---|---|---|---|---|
| RGB → RGB   (sRGB → AdobeRGB) | 66 MPx/s | 93 MPx/s  | **158 MPx/s** | 46 MPx/s |
| RGB → CMYK  (sRGB → GRACoL)   | 56 MPx/s | 78 MPx/s  | **149 MPx/s** | 44 MPx/s |
| CMYK → RGB  (GRACoL → sRGB)   | 42 MPx/s | 43 MPx/s  | **90 MPx/s**  | 24 MPx/s |
| CMYK → CMYK (GRACoL → GRACoL) | 35 MPx/s | 37 MPx/s  | **86 MPx/s**  | 21 MPx/s |

The three u16 kernels are bit-exact against each other; SIMD is
~3.9–4.9× faster than `lcms-wasm` 16-bit on every workflow.

<small>† FPS @ 1080p is 1920×1080 = 2.07 MPx/frame, single-threaded.
Nobody's recommending CMYK video, and "frames per second" is a silly
unit for a colour-management library, but it gives a usable mental
model of how much headroom the engine has for everyday image work.
RGB → RGB at 113 fps means a 4K still image (8.3 MPx) finishes in
~35 ms single-thread.</small>

### vs native C LittleCMS — same hardware, same session

Run on a second machine (WSL2 / Ubuntu 20.04, gcc 10.5 `-O3
-march=native -ffast-math -funroll-loops -flto`, `taskset -c 0`)
with everything measured in the same session against identical
profiles and inputs. **Native C is built with full steelman flags**
(`make steelman` in [`bench/lcms_c/`](./bench/lcms_c/)) — every
compiler trick short of PGO, so the comparison gives lcms2 every
advantage we could give it. The **ratios tell the story**:

| Workflow | jsCE `int` (pure JS) | lcms2 native steelman | jsCE / native |
|---|---|---|---|
| RGB → Lab    (sRGB → LabD50)   | 64.5 MPx/s | 61.9 MPx/s | **1.04× (jsCE wins)** |
| RGB → CMYK   (sRGB → GRACoL)   | 54.2 MPx/s | 58.1 MPx/s | 0.93× (native +7 %) |
| CMYK → RGB   (GRACoL → sRGB)   | 53.2 MPx/s | 35.7 MPx/s | **1.49× (jsCE +49 %)** |
| CMYK → CMYK  (GRACoL → GRACoL) | 43.6 MPx/s | 31.2 MPx/s | **1.40× (jsCE +40 %)** |

Pure JavaScript beats native steelmanned lcms2 on **3 of 4** image
workflows on the same hardware. Swap in the v1.2 default
(`'int-wasm-simd'`, third column of the Speed table above) and we
win all four by **2–5×**. Reproduce in ~5 minutes from a fresh WSL2
install: [`bench/lcms_c/README.md`](./bench/lcms_c/README.md).

> **Why steelman?** Because "we beat native C" is a big enough claim
> to deserve stress-testing. `-ffast-math -funroll-loops -flto` lifted
> lcms2 by only **−2 % to +2 %** over `-O3 -march=native` on this
> profile — inside the bench's run-to-run noise floor. The reason is
> documented in [Performance.md §4](./docs/Performance.md#measured--vs-native-littlecms-same-hardware-same-run):
> lcms2's hot loop is **dispatch-bound, not ALU-bound**, so compiler
> flags that improve arithmetic have nothing to optimise. That's
> also the architectural reason jsColorEngine wins: specialising the
> kernel at LUT-build time replaces the dispatcher with straight-line
> code the JIT can crush.
>
> **And when lcms2 reaches for its SIMD plugin** (`fast-float`), that
> plugin is **SSE2-only (128-bit)** — the *same* SIMD width as wasm
> v128 in our `int-wasm-simd` kernels. Wider native SIMD (AVX2
> 256-bit, AVX-512 512-bit) isn't reachable from any JavaScript or
> WebAssembly engine today — wasm SIMD is 128-bit by spec — but it's
> also **not what the C colour-management ecosystem ships by
> default**. No distro-packaged CMS library enables AVX2 or AVX-512
> paths, because targeting those breaks the ~15 % of installed
> machines without them. So on the realistic C baseline vs JS
> baseline, we're on equal SIMD-width ground. Libraries that *do*
> go wider (babl, pillow-simd, Intel IPP) we explicitly don't claim
> to beat — see
> [Performance.md — SIMD width ceilings](./docs/Performance.md#a-note-on-simd-width-ceilings--jswasm-vs-native-c)
> for the full comparison table.

### Key takeaways

- **Building a LUT makes image transforms ~11–15× faster** than the
  per-pixel accuracy path. There's no reason not to use one for any
  workflow that touches more than a few hundred pixels.
- **The pure-JS `'int'` hot path already beats `lcms-wasm` by
  1.48–2.12×** across these four directions — no WASM required.
- **It also beats native C lcms2 on 3 of 4 directions** on the same
  hardware, and trails by 10 % on the fourth (RGB→CMYK). The gap
  favours jsCE most on 4D CMYK-input workloads where jsCE's
  specialised u20 Q16.4 K-LERP runs circles around lcms2's
  general-purpose 4D stage-walker. See
  [Performance.md §4](./docs/Performance.md#measured--vs-native-littlecms-same-hardware-same-run).
- **Enabling WASM SIMD triples the 3D throughput over JS `'int'`**
  (range 2.94–3.50×), bit-exact. 4D kernels (CMYK input) land 2.04–
  2.57× over JS `'int'` — limited by per-pixel scalar prologue,
  not the SIMD body. On hosts without v128, the dispatcher demotes to
  WASM scalar, then to JS `'int'`, then to `'float'`; code doesn't
  change.
- **Ratios are stable across x64 machines; absolute numbers aren't.**
  JS engines (V8, SpiderMonkey, JSC) schedule the hot loops
  differently and their optimisers evolve between releases. Treat
  the numbers above as a guide, not a contract. Run the in-browser
  bench (`node bench/browser/serve.js`) on your own machine.

Full benchmark methodology, the 15 % JIT-deletable-by-WASM analysis,
the lcms-wasm comparison table, the "we measured" vs "we predicted"
gap, and the roadmap live in **[docs/Performance.md](./docs/Performance.md)**.
For *why* these numbers are possible — asm dumps, op-count tables,
`.wat` design notes — see [the deep dive](./docs/deepdive/).

> **If you plan to edit the hot loops**, read the `PERFORMANCE LESSONS`
> comment block at the top of [`src/Transform.js`](./src/Transform.js)
> first, and the deep dive's [JIT inspection](./docs/deepdive/JitInspection.md)
> page. Several things in those loops are deliberately counter-intuitive
> — named temps, helper calls, "cleanup" of duplicated expressions —
> and they measurably slow things down. Always benchmark before and
> after.

---

## Examples

Three working snippets are in [Quick start](#quick-start) above:
single-colour Lab → CMYK, RGB → CMYK image bytes, and a multi-stage
soft-proof chain.

More recipes, including the canvas read-modify-write pattern and
custom pipeline stages at PCS, are in
**[docs/Examples.md](./docs/Examples.md)**.

### Live demos

Self-contained HTML demos ship in `samples/` and are hosted at
**<https://www.o2creative.co.nz/jscolorengine/samples/>**:

- **[Live Video Soft Proof](https://www.o2creative.co.nz/jscolorengine/samples/live-video-softproof.html)**
  — real-time video colour management. Every frame decoded and soft-proofed
  through a pre-built 3D CLUT — pure JS, no WASM, no workers. 40+ fps on
  720p.
- **[Soft Proof](https://www.o2creative.co.nz/jscolorengine/samples/softproof.html)**
  — sRGB → CMYK soft proof + C/M/Y/K plate previews with floating colour
  picker (Lab, sRGB, CMYK, ΔE 2000, ΔE 76).
- **[jsCE vs lcms-wasm](https://www.o2creative.co.nz/jscolorengine/samples/softproof-vs-lcms.html)**
  — pixel-by-pixel accuracy comparison with amplified diff slider (up to
  128×), CMYK + RGB stats, speed ratio.

Run locally with `npm run samples:browser` — see
[docs/Samples.md](./docs/Samples.md) for setup.

---

## Testing

```bash
npm test
```

Runs the Jest suite: transform pipeline (object IO, device IO, LUT
IO, multi-stage), the lower-level `decodeICC` (parametric curves,
sampled `curv` curves, unsupported LUT sentinels), and the WASM
kernel dispatch-counter tests that guard against silent demotion
regressions.

---

## Limitations

The engine is deliberately scoped to the cases that matter for
everyday colour management. Things outside that scope:

- **Named Color profiles** (`ncl2`) and **Device Link profiles** are
  not supported.
- **DeviceN > 4 channels as input** is not supported. n-channel > 4
  as *output* is supported.
- **MultiProcessElement** (`mpet`) profiles load via the fallback path
  — the ICC spec mandates the standard `AtoB` / `BtoA` LUT tags are
  always present in a conforming profile, so MPE-bearing profiles
  work through the standard tags. MPE-only film / scientific
  workflows are not the target.
- **V2 `desc` tag** — only the ASCII portion is decoded; the Unicode
  and Macintosh ScriptCode portions that follow are ignored. V4
  profiles use `mluc` instead, which is fully decoded with all
  language records.
- **`inverseCurve`** (numerical inverse of a sampled curve) assumes
  overall monotonicity — locally non-monotonic curves degrade
  gracefully but are not reliably inverted. Fine for ICC TRCs in
  practice.
- **Lab input to the integer LUT kernels** — Lab `a` / `b` are signed;
  the `'int'` / `'int-wasm-*'` kernels assume unsigned u8 / u16. The
  engine sidesteps this by always routing through device colour
  (RGB or CMYK) under those modes. For Lab → Lab image work, pin
  `lutMode: 'float'` (or set `buildLut: false` for the f64 pipeline).
  The default `'auto'` resolves to `'float'` when no int kernel is
  applicable, so this is handled correctly out of the box for
  non-int8 dataFormats.

---

## Documentation

| Page | What it covers |
|---|---|
| **[Bench](./docs/Bench.md)** | Run the numbers on your own hardware — in-browser, zero-upload, full methodology & submission guide ([live](https://www.o2creative.co.nz/jscolorengine/bench/browser/)) |
| **[Deep dive](./docs/deepdive/)** | How it works, why it's fast — pipeline model, lutMode internals, JIT inspection, WASM kernel design |
| **[Performance](./docs/Performance.md)** | Benchmark numbers, discoveries in the journey, lcms comparison |
| **[Samples](./docs/Samples.md)** | Live demos — video soft-proof, image soft-proof, jsCE vs lcms-wasm comparison ([live](https://www.o2creative.co.nz/jscolorengine/samples/)) |
| **[Roadmap](./docs/Roadmap.md)** | What's coming next — single source of truth for v1.4+ plans (v1.4 `ICCImage` helper + browser samples, v1.5 compiled pipeline) |
| **[Examples](./docs/Examples.md)** | Canvas round-trip, custom pipeline stages, and other recipes beyond Quick start |
| [API — Profile](./docs/Profile.md) | `Profile` class: loading, virtual profiles, tag access |
| [API — Transform](./docs/Transform.md) | `Transform` class: constructor options, `create`, `createMultiStage`, `transform`, `transformArray` |
| [API — Loader](./docs/Loader.md) | Optional batch profile loader |
| [CHANGELOG](./CHANGELOG.md) | Release-by-release changes |

**In-source JSDoc** on every public class and method is the
authoritative reference for method signatures and parameter types:

- [`src/Profile.js`](./src/Profile.js) — load + decode + virtual profiles
- [`src/Transform.js`](./src/Transform.js) — pipeline building + execution (read the `PERFORMANCE LESSONS` block before touching hot loops)
- [`src/Loader.js`](./src/Loader.js) — optional batch profile loader
- [`src/convert.js`](./src/convert.js) — colour-space helper maths
- [`src/decodeICC.js`](./src/decodeICC.js) — low-level ICC binary decoders
- [`src/Spectral.js`](./src/Spectral.js) — spectral / illuminant maths

### Benchmark your own machine

The **in-browser bench is the canonical way** to reproduce the
numbers on this page — see [docs/Bench.md](./docs/Bench.md) for the
full guide. For headless / CI setups, the Node benches in the repo
give the same numbers without opening a browser:

```bash
# In-browser comparison UI vs lcms-wasm — opens localhost:8080
npm run bench:browser

# Headless: headline throughput through the shipped dispatcher, all four lutModes
node bench/mpx_summary.js

# Headless: full WASM kernel matrix — 6 configs × JS vs scalar vs SIMD, bit-exact
node bench/wasm_poc/tetra3d_simd_run.js
node bench/wasm_poc/tetra4d_simd_run.js
```

If your numbers differ meaningfully from the tables above we want to
know — open an issue with CPU, OS, Node/browser version, and the
raw bench output attached. **Critiques of the methodology are
equally welcome.** If the test is broken we'd rather hear about it
than brag on borrowed numbers.

---

## License

[MPL-2.0](https://mozilla.org/MPL/2.0/).

This Source Code Form is subject to the terms of the Mozilla Public
License, v. 2.0. If a copy of the MPL was not distributed with this
file, You can obtain one at <https://mozilla.org/MPL/2.0/>.

### Credits & influences

- **[LittleCMS](https://www.littlecms.com/)** — colour-management
  architecture, ICC profile handling, CLUT interpolation approach. A
  genuine debt: much of the thinking in this engine was shaped by
  studying Marti Maria's 25-year solo maintenance of lcms. No code
  is derived — this is a clean-room JavaScript implementation with
  different optimisation constraints (V8 JIT vs C compiler) — but
  the intellectual lineage is acknowledged here rather than claimed
  independently. If this project ever produces commercial revenue, a
  meaningful share is intended to flow back to LittleCMS.
- **[Bruce Lindbloom](http://www.brucelindbloom.com/)** —
  RGB / XYZ / Lab math, ΔE formulas.
- **[BabelColor](https://www.babelcolor.com/)** — RGB working-space
  primaries reference.
