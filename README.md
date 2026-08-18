# jsColorEngine

**The fastest ICC colour engine in JavaScript — and accurate to within
1 LSB of LittleCMS.** 100 % native JS, zero dependencies, optional WASM
for the hot path.

<sub>*Fastest*: measured single-threaded against
[`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm) — the only
comparable full ICC implementation available to JavaScript — where it
runs 3.2–3.6× faster on every LUT workflow. *Accurate*: 100 % of samples
within 1 LSB of the LittleCMS oracle on all four tested workflows, the
large majority bit-identical. Both claims, with conditions and the
harness that produced them:
[docs/LcmsComparison.md](./docs/LcmsComparison.md).</sub>

Live benchmark and demo of samples here **<https://www.o2creative.co.nz/jscolorengine/samples/>**

- **Fast.** Against [LittleCMS](https://littlecms.com/), the 25-year
  reference implementation — single-threaded, one core against one core,
  on real photographic content:
  - **3.2–3.6× faster than `lcms-wasm`** — the engine a JS project
    would otherwise install.
  - **Pure JavaScript lands within 0.78–1.08× of optimised native C**,
    and is *ahead* on both 4D CMYK workflows. No WASM involved.
  - **~2× native C with the WASM SIMD tier** on LUT-based workflows.

  "Native C" here means stock open-source lcms2, built by gcc at its
  best flags — not the fastest colour transform that can be written in
  C. Closed-source commercial CMMs are faster and can use AVX-512 and
  GPUs, which WebAssembly cannot reach; the
  [comparison page](./docs/LcmsComparison.md) says so explicitly rather
  than leaving it implied.

  In absolute terms that is **~80–120 MPx/s on photographs**
  (Ryzen 7700X, one thread, WASM SIMD) — roughly **10–15 4K images per
  second**. Throughput depends heavily on content, so the ratios above
  are the more portable number; the
  [full comparison](./docs/LcmsComparison.md) gives every workflow with
  its conditions.

  🚧 **Multicore is in progress for the next release** — a
  worker-parallel image path, already measured at **5.46× on 16 threads**
  in a proof of concept, byte-identical to the single-threaded result.
  One call takes 1..n images and the planner decides whether to split
  each one or run it whole; where workers are unavailable it falls back
  to the ordinary sequential path, so it stays an optimisation rather
  than a capability. Design and measurements:
  [deepdive/multicore.md](./docs/deepdive/multicore.md).

  The point isn't a scoreboard against LittleCMS — it's
  that heavy, real-world colour workloads are completely feasible in
  JavaScript on a single thread.

- **Accurate.** **LUT-free mode** (`buildLut: false`) — every pixel
  walks the full f64 pipeline, no LUT quantisation, no rounding
  short-cuts. For colour-critical / prepress / proof / measurement
  work where ΔE matters more than MPx/s. Available on both APIs.
  See [Accuracy](#accuracy).

- **Fully-featured CMS.** Everything you'd expect from a mature
  colour-management library: RGB, CMYK, Lab, XYZ, 3CLR/4CLR **and
  N-channel (5CLR–15CLR)** device spaces; **DeviceLink profiles**;
  ICC v2 and v4 profile loading (LUT-based **and** matrix-shaper);
  built-in virtual profiles (sRGB, AdobeRGB, Lab, XYZ); all four
  rendering intents; black-point compensation; trilinear /
  tetrahedral interpolation; multi-step transforms; custom pipeline
  stages spliced in at PCS; ΔE76 / ΔE2000 helpers; and spectral /
  illuminant maths for measurement workflows. See
  [Features at a glance](#features-at-a-glance).

- **Portable — runs everywhere JavaScript does, no GPU required.**
  Node.js (rack servers, headless RIPs, CI workers, AWS Lambda),
  browsers, Electron, web workers, React Native (with a Buffer
  polyfill). LUT video / image work in JS-land typically reaches for
  WebGL / WebGPU fragment shaders for performance — fast and proven,
  but those need a GPU, driver setup, and (often) a window context.
  Non-starters on a headless prepress server, a containerised
  colour-management worker, an SSH'd build box, or a CI step.
  **WASM SIMD is the portable acceleration path:** same kernel,
  same speed ceiling, anywhere the V8 / SpiderMonkey / JSC
  WebAssembly engine runs (which is everywhere, including headless
  containers with no display hardware). No native bindings, no
  compile step, no platform-specific binaries.

- **Portable LUTs — build once, ship anywhere.** Bake a transform
  to JSON at deploy time; `Transform.fromJSON(json)` reconstructs
  it at runtime with no profiles, no lcms, no pipeline build cost.
  Supports LittleCMS emulation mode — sample lcms colour math into
  the grid once, then drop lcms entirely; jsCE kernels take it from
  there at full WASM-SIMD speed. LUTs carry a chain and a content
  fingerprint so you always know what profile, intent, and version
  produced the file. See [Portable LUTs](#portable-luts--lutbuilder) ·
  [`LutBuilder`](./samples/LutBuilder/lutbuilder.md) ·
  [`docs/deepdive/Luts.md`](./docs/deepdive/Luts.md).

- **Two APIs, one `Transform`.** `transform(colorObj)` for single
  colours (µs/call, always LUT-free). `transformArray(typedArray)`
  for bulk — pre-baked LUT at **~80–120 MPx/s on photographic content**
  (x86_64, one thread, WASM SIMD), or LUT-free f64 when you need
  accuracy over throughput.
  See [Two paths, one Transform](#two-paths-one-transform).

---

## Table of contents

- [Benchmark it yourself](#benchmark-it-yourself)
- [Why compare to LittleCMS for accuracy and speed?](#why-compare-to-littlecms-for-accuracy-and-speed)
- [Two paths, one Transform](#two-paths-one-transform)
- [Portable LUTs / LutBuilder](#portable-luts--lutbuilder)
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

### Benchmark it yourself

> ### ⚠ These figures are being re-measured (Aug 2026)
>
> The v1.5 release comparison found that the synthetic "random noise"
> input used by every bench in this repo was **degenerate**: taking the
> low 8 bits of an LCG gives a buffer containing only **256 distinct
> colours**, which fits a CLUT working set entirely in L1 while still
> reporting 0.0 % adjacency. The row we treated as the hardest case was
> the easiest one.
>
> Corrected, throughput on a properly-distributed input is roughly
> **half** the numbers quoted below, and on real photographs it lands
> around 110–130 MPx/s rather than 210. The *ratios* against
> `lcms-wasm` largely survive — both engines were flattered — but the
> absolute MPx/s figures in this README and in
> [docs/Performance.md](./docs/Performance.md) should be treated as
> **provisional until the browser bench is rebuilt on a real-image
> corpus** ([Roadmap](./docs/Roadmap.md#browser-sample-bench--retune-on-real-image-content)).
>
> The Node-side comparison **has** been redone on corrected inputs, with
> one process per measurement and CLUT coverage reported alongside every
> row: **[docs/LcmsComparison.md](./docs/LcmsComparison.md)**. Trust that
> page over this section where they disagree.

Every MPx/s number in this README and in
[docs/Performance.md](./docs/Performance.md) was measured with
the in-browser bench at [`samples/bench/`](./samples/bench/)
([live sample demos including real time video soft proofing demo no one asked for](https://www.o2creative.co.nz/jscolorengine/samples/bench/)).
It runs every `lutMode` against the real `lcms-wasm` library, on *your*
hardware, in *your* browser — zero upload, zero telemetry, everything
runs locally.

```bash
npm run browser   # build the UMD bundle (once)
npm run serve     # samples + browser bench on :8080 — see /samples/ and /samples/bench/
```

The bench has five tabs: Full comparison (every direction × every
mode), Accuracy sweep (Lab round-trip ΔE76), JIT warmup curve,
pixel-count / cache-tier sweep, and an in-page methodology essay.
A "Copy markdown" button serialises your results for pasting into an
issue.

See **[docs/Bench.md](./docs/Bench.md)** for the full guide, the
methodology notes, and the submission template if your numbers
disagree with ours.

> Benchmarks quoted here were measured on **two reference machines**:
> a developer Windows box (Node 20, V8, x86_64) and an Apple M4 Mac
> mini in Chrome 147. Ratios (1.5× over lcms-wasm in pure JS, 3.25×
> for WASM SIMD over plain JS on x86_64, ~1.4–1.6× ARM lift on top of
> that for the WASM tiers) should be stable across like CPUs;
> absolute MPx/s will move with your hardware. The per-architecture
> comparison is in
> [Performance § 2.6](./docs/Performance.md#26-arm64--apple-silicon--the-register-pressure-prediction-landed).
> User-submitted results on other OSes / CPUs / browsers are welcome
> — **and methodology critiques are equally welcome**; if we're
> measuring wrong we'd rather hear about it.

A lot of the core concepts are lifted from LittleCMS. This is **not**
a port — the implementation is independent, written for how a JIT
compiler sees numeric typed-array loops. If you want to see how that
changes the code, [the deep dive](./docs/deepdive/) has the V8
assembly walkthroughs.

---

### Why compare to LittleCMS for accuracy and speed?

[**LittleCMS**](https://www.littlecms.com/) is the reference
open-source ICC engine — comparing against it keeps us honest on both
axes. Everything is measured **single-threaded, one core vs one core**,
same hardware, same profiles, same input bytes:

- **Faster than `lcms-wasm`** — the engine a JS project would
  otherwise install. Don't assume "WASM = faster": jsCE's pure-JS
  kernels beat it on every LUT workflow before any WASM is involved,
  and the SIMD tier runs **3.2–3.6×** it on photographic content.
- **Native-C-class speed on a single thread** — and this one is
  literal rather than aspirational: on photographs, **pure JavaScript
  lands within 0.78–1.08× of lcms compiled by gcc at its best flags**,
  ahead on both 4D CMYK workflows. With WASM SIMD it is roughly 2×
  native on LUT work. Native C keeps matrix-shaper RGB→RGB, where it
  is ~1.4× ahead.
- **Accurate against the same reference** — matches lcms's f64
  pipeline to ≤ 0.06 ΔE76 across 130 reference files, and the
  image-path LUT agrees **within 1 LSB on 100 % of samples** vs
  lcms-wasm's default pipeline. See [Accuracy](#accuracy).
- **~1.9× smaller over the wire** — ~68 KB gzip in one file with the
  WASM inlined (no fetch, sync init), vs lcms-wasm's ~129 KB across
  two fetches.

Where LittleCMS wins, the page says so: its one-pixel memo cache makes
it substantially faster on flat graphic content, and its fused
matrix-shaper path beats ours on RGB→RGB. Four corrections to our own
published numbers are recorded there too — three of which had been
flattering us.

The full comparison — methodology, tables, caveats, and the upstream
discussion with LittleCMS's author — lives on the
**[LittleCMS comparison page](./docs/LcmsComparison.md)**.
Reproduce all of it with `node bench/reproduce.js`.

---

## Two paths, one Transform

The engine is built around two very different use cases. Picking the
right one matters more than any other choice you'll make.

| Use case | API | Speed | Accuracy | When to use |
|---|---|---|---|---|
| **Single colour / colour picker** | `transform.transform(colorObj)` | µs per call, slow per pixel | Full 64-bit precision, all stages run | UI colour pickers, swatch libraries, Lab/RGB/CMYK display, ΔE calculations, prepress maths |
| **Image / array processing** | `transform.transformArray(typedArray, ...)` | ~80–120 MPx/s on photographs (x86_64, one thread, WASM SIMD) | Slightly less accurate (LUT is finite resolution) | Soft-proofing, image conversion, video, anything pixel-bulk |

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

## Portable LUTs / LutBuilder

Bake a colour transform to a self-describing JSON file at deploy time — no ICC profiles, no lcms, no pipeline build cost at the consumer.

```js
// Producer (build time — has profiles)
const t = new Transform({ dataFormat: 'int8', buildLut: true });
t.create(cmykProfile, '*srgb', eIntent.relative);
fs.writeFileSync('lut.json', JSON.stringify(t));

// Consumer (runtime — profiles not needed)
const t = Transform.fromJSON(fs.readFileSync('lut.json'), { dataFormat: 'int8' });
t.transformArray(cmykPixels);
```

Key features:

| | |
|---|---|
| **Build sources** | Engine ICC pipeline, custom callback, or lcms-wasm bridge |
| **lcms emulation** | Sample LittleCMS into the grid once — jsCE kernels at runtime, lcms colour math baked in (jsCE ↔ lcms agree to < 0.1 ΔP per channel) |
| **Auditable** | Every LUT is content-signed (`"FNV1A:xxxxxxxx"` over chain + grid + pixel data); `Transform.fromJSON(json, { verify: true })` throws on tamper |
| **Size** | ~650 KB JSON for a 4D CMYK LUT (17-pt); parses + dispatches in ~6 ms |
| **Speed** | ~6× faster per frame than the f64 live pipeline on typical images; < 1 ΔP mean error |
| **Editable** | `editLut()` for per-cell mutations (TAC limits, ink substitution), `clone()` for variants, `toJSON()` to re-export |

### TIFF visual editing — capture any CMS as a reusable LUT

Export an identity LUT as a TIFF image, edit it in Photoshop (or any ICC-aware editor), reimport. The editor's colour engine becomes your LUT — captured at the grid's resolution, dispatched at WASM-SIMD speed.

```
--create  →  open in Photoshop  →  apply conversion/grade  →  --import  →  LUT JSON
```

**Captured so far:** sRGB → SWOP CMYK (Adobe CMM) at N=33 gives **mean ΔP 0.76** vs Photoshop ground truth — sub-LSB at 8-bit output. Any conversion Photoshop (or GIMP, Affinity, ColorSync) can perform can be captured: profile conversions, TAC-limited device links, creative grades, grayscale tone curves.

```bash
# Create a TIFF identity, open in Photoshop, convert to CMYK, save, reimport:
node samples/LutBuilder/lut-tiff-cli.js --create --channels 3 --size 33 --out srgb.tiff
node samples/LutBuilder/lut-tiff-cli.js --import --in edited_cmyk.tiff --out my_lut.json
node samples/LutBuilder/lut-tiff-cli.js --validate --original srgb.tiff --edited edited_cmyk.tiff --lut my_lut.json
# → Grade: EXCELLENT (mean ΔP 0.756 / threshold 1)
```

**Metadata survives Photoshop.** Grid parameters are stored in both a private TIFF tag (tag 32768) and XMP (`jsce:LutMeta`) — Photoshop strips the private tag but always preserves unknown XMP namespaces. The embedded ICC profile (tag 34675, written by Photoshop) is extracted on import and placed in the LUT chain as the output descriptor. The text strip in the image is a human-readable last-resort fallback.

**Validate and compare.** `builder.analyze()` and `LutBuilder.comparePixels()` produce ΔP reports (mean, max, RMSE, p95/p99, per-channel, grade) and optional amplified delta TIFF images for visual diagnosis. Use `--compare` to benchmark jsCE vs lcms vs Photoshop conversions of the same source.

The [`LutBuilder`](./samples/LutBuilder/lutbuilder.md) guide covers the full lifecycle, CLI reference, and error handling.
Format spec, emulation architecture, and the reasoning behind the design are in [`docs/deepdive/Luts.md`](./docs/deepdive/Luts.md).
The [`samples/lut-cmyk-to-rgb.html`](./samples/lut-cmyk-to-rgb.html) demo shows the build-once / ship-anywhere workflow end-to-end with measured numbers.

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
    // Wrap profile loading in try/catch — profiles can be corrupt or missing.
    const cmykProfile = new Profile();
    try {
        await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');
    } catch (err) {
        console.error('Failed to load profile:', err.message);
        return;
    }
    // Always check .loaded — false if the file existed but wasn't valid ICC.
    if (!cmykProfile.loaded) {
        console.error('Profile did not load correctly:', cmykProfile.lastError);
        return;
    }

    // No buildLut — this is the accuracy path.
    const lab2cmyk = new Transform();
    try {
        lab2cmyk.create('*lab', cmykProfile, eIntent.perceptual);
    } catch (err) {
        console.error('Transform create failed:', err.message);
        return;
    }

    const cmyk = lab2cmyk.transform(color.Lab(80.1, -22.3, 35.1));
    console.log(`CMYK: ${cmyk.C}, ${cmyk.M}, ${cmyk.Y}, ${cmyk.K}`);
})();
```

### Image bytes — RGB to CMYK (hot path)

```js
const { Profile, Transform, eIntent } = require('jscolorengine');

(async () => {
    const cmykProfile = new Profile();
    try {
        await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');
    } catch (err) {
        console.error('Profile load failed:', err.message);
        return;
    }
    if (!cmykProfile.loaded) {
        console.error('Profile invalid or unsupported:', cmykProfile.lastError);
        return;
    }

    // SPEED PATH — pre-bake a LUT, pick int8 IO, enable BPC.
    // lutMode defaults to 'auto' which resolves to the fastest
    // WASM SIMD kernel available on the host (with automatic
    // demotion to scalar WASM / JS int on older runtimes).
    const rgb2cmyk = new Transform({
        buildLut:   true,
        dataFormat: 'int8',
        BPC:        true
    });
    try {
        rgb2cmyk.create('*sRGB', cmykProfile, eIntent.relative);
    } catch (err) {
        console.error('Transform create failed:', err.message);
        return;
    }

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
    try {
        await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');
    } catch (err) {
        console.error('Profile load failed:', err.message);
        return;
    }
    if (!cmykProfile.loaded) {
        console.error('Profile invalid or unsupported:', cmykProfile.lastError);
        return;
    }

    // BPC is per-stage: enable on the perceptual leg, disable on the
    // relative leg — a common soft-proofing recipe. lutMode defaults
    // to 'auto' → best available SIMD/WASM/JS kernel.
    const proof = new Transform({
        buildLut:   true,
        dataFormat: 'int8',
        BPC:        [true, false]
    });
    try {
        proof.createMultiStage([
            '*sRGB',     eIntent.perceptual,
            cmykProfile, eIntent.relative,
            '*sRGB'
        ]);
    } catch (err) {
        console.error('Transform create failed:', err.message);
        return;
    }

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
- Grey / Duo / RGB / CMY / CMYK / 3CLR / 4CLR device spaces
- **N-channel (5CLR–15CLR)** press profiles — both directions: n-ink →
  PCS via a generic N-D simplex interpolator, and PCS/RGB → n-ink
  including the baked-LUT image path
  ([implementation notes](./docs/NChannel.md))
- **DeviceLink profiles** (`pClass: 'link'`) — device→device with no PCS,
  `t.create(deviceLink)`, including curves-only linearization links,
  ink-limit links, and asymmetric conversions (CMYK→RGB, RGB→CMYK)
  ([implementation notes](./docs/DeviceLink.md))

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

// If you must load from disk, always wrap + check:
const slow = new Profile();
try {
    await slow.loadPromise('./profiles/sRGB_v4_ICC_preference.icc');
} catch (err) {
    console.error('Profile load failed:', err.message);
}
if (!slow.loaded) {
    console.error('Profile invalid:', slow.lastError);
}
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
> to **within 1 LSB on 100 % of samples (max 1 LSB)** vs lcms-wasm's
> default pipeline. All named
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
with lcms's **default optimisation** (`flags = 0`) as the oracle.

| Workflow | within 1 LSB | max Δ | mean Δ |
|---|---|---|---|
| RGB → Lab   | **100.00 %** | 1 LSB | 0.004 LSB |
| RGB → CMYK  | **100.00 %** | 1 LSB | 0.006 LSB |
| CMYK → RGB  | **100.00 %** | 1 LSB | 0.002 LSB |
| CMYK → CMYK | **100.00 %** | 1 LSB | 0.008 LSB |

`node bench/lcms-comparison/accuracy.js` reproduces this on your
hardware.

<small>Earlier published runs of this harness used
`cmsFLAGS_HIGHRESPRECALC` as the oracle and showed a small
out-of-gamut tail (98.5–98.8 % within 1 LSB, max 14 LSB on
deep-cyan CMYK → RGB inputs). Marti Maria pointed out
([#6](https://github.com/glennwilton/jsColorEngine/issues/6)) that
HIGHRESPRECALC is a legacy lcms 1.x emulation flag, not the
reference behaviour — re-run against lcms's default pipeline, the
divergences disappear entirely. `--highres` reproduces the old
oracle for comparison.</small>

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
use `transformArray()`.

### Current figures — real photographs, corrected inputs

Ryzen 7700X, one thread, Node 24, 1 M px, GRACoL2006 + AdobeRGB1998,
each measurement in its own process. Full conditions and every content
class: **[docs/LcmsComparison.md](./docs/LcmsComparison.md)**.

| Workflow | `'int'` (pure JS) | `'int-wasm-simd'` | vs `lcms-wasm` | vs native C |
|---|---:|---:|---:|---:|
| RGB → Lab | 53.7 | **119.6** | 3.3× | 1.8× |
| RGB → CMYK | 48.2 | **121.5** | 3.5× | 2.0× |
| CMYK → RGB | 43.1 | **82.0** | 3.2× | 2.1× |
| CMYK → CMYK | 36.8 | **81.3** | 3.6× | 2.3× |
| RGB → RGB (soft-proof) | 53.8 | **118.9** | 3.5× | 2.1× |
| RGB → RGB (matrix) | 53.5 | 118.8 | 1.8× | 0.72× |

Matrix-shaper RGB→RGB is the one workflow where native C leads — it
uses a fused matrix path where jsCE interpolates a baked CLUT. A
dedicated kernel for it is measured and queued
([Roadmap](./docs/Roadmap.md)).

### Historical table (superseded — see the warning above)

> These figures used 65 K pixels of the degenerate noise generator
> described earlier: only 256 distinct colours, which leaves the CLUT
> L1-resident, and 65 K px additionally under-samples a 4D CMYK CLUT
> (83,521 cells) at ~0.8× coverage. Both effects inflate the result.
> Kept on the record rather than deleted, because the correction is part
> of the story — but **quote the table above, not this one.** The
> Apple Silicon column has not yet been re-measured at all.

Headline throughput, GRACoL2006 + AdobeRGB1998,
65 K pixels per iter, hot-median across 5 batches — **measured on two
reference machines** (Node 20 / V8 / x86_64 *and* Apple M4 Mac mini /
Chrome 147):

**8-bit I/O** (`dataFormat: 'int8'`) — `'int-wasm-simd'` per architecture

| Workflow | `'int'` (u16, JS, x86_64) | `'int-wasm-scalar'` (x86_64) | `'int-wasm-simd'` **x86_64** | `'int-wasm-simd'` **Apple M4** |
|---|---|---|---|---|
| RGB → RGB   (sRGB → AdobeRGB, matrix)     | 72 MPx/s | ~101 MPx/s | **~216 MPx/s** | **269 MPx/s** |
| RGB → CMYK  (sRGB → GRACoL)               | 62 MPx/s | ~87 MPx/s  | **~210 MPx/s** | **258 MPx/s** |
| CMYK → RGB  (GRACoL → sRGB)               | 59 MPx/s | ~72 MPx/s  | **~128 MPx/s** | **211 MPx/s** |
| CMYK → CMYK (GRACoL → GRACoL)             | 49 MPx/s | ~60 MPx/s  | **~128 MPx/s** | **210 MPx/s** |
| RGB → RGB   (sRGB→GRACoL→sRGB, soft-proof)| ~72 MPx/s¹ | ~101 MPx/s | **~210 MPx/s** | **~258 MPx/s** |

¹ Soft-proof uses the same 3D LUT kernel as any other RGB-input transform — the CMYK intermediate is baked into the LUT grid at create time, not evaluated per-pixel. Throughput is equivalent to other RGB-input workflows. Native lcms2 measures ~51 MPx/s for this path (`make fastfloat` in `bench/lcms_c/`); `fast-float` gives it nothing.

The 3D paths gain ~25 % going from x86_64 to ARM64; the **4D CMYK
paths gain ~65 %**. That asymmetry is the register-pressure
prediction in [JIT inspection](./docs/deepdive/JitInspection.md#implications-for-future-work)
landing exactly where it was filed: 4D was GPR-saturated on x86, ARM64
(31 GPRs vs 11 allocatable) frees the spill traffic. Full per-mode
table — including the same lift on JS `int` and WASM scalar — in
[Performance § 2.6](./docs/Performance.md#26-arm64--apple-silicon--the-register-pressure-prediction-landed).

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

<small>† **Image-work mental model.** A 1080p frame is 1920×1080 ≈
2.07 MPx; a 4K still is 8.3 MPx. So 269 MPx/s on M4 RGB → RGB is
~130 fps at 1080p, or a 4K still in ~31 ms single-thread. 210 MPx/s
on x86_64 RGB → CMYK is ~101 fps at 1080p. Nobody's recommending
CMYK video, and "frames per second" is a silly unit for a
colour-management library, but it gives a usable mental model of how
much headroom the engine has for everyday image work. ([Update: we
actually built a live demo of real-time soft-proofing of HD video in
your browser](https://www.o2creative.co.nz/jscolorengine/samples/live-video-softproof.html)).

### vs native C LittleCMS

The single-threaded native-C comparison has
[its own page → docs/LcmsComparison.md](./docs/LcmsComparison.md) —
the original "steelman" harness and its tables, the `fast-float`
plugin measurements, and the re-measurement now underway after
generous upstream feedback from LittleCMS's author
([#6](https://github.com/glennwilton/jsColorEngine/issues/6)).

The short version: on our original harness, single-threaded pure
JavaScript matched or beat aggressively-compiled stock lcms2 on 4 of
5 LUT image workflows — an existence proof that **a JIT-compiled JS
kernel runs in the same performance class as single-threaded native
C**, which is the claim we actually care about. Those native numbers
are being re-measured with corrected lcms API calls before we quote
them further; the lcms-wasm comparisons above are unaffected.

### Key takeaways

- **Building a LUT makes image transforms ~11–15× faster** than the
  per-pixel accuracy path. There's no reason not to use one for any
  workflow that touches more than a few hundred pixels.
- **The pure-JS `'int'` hot path already beats `lcms-wasm` by
  1.48–2.12×** across these four directions — no WASM required.
- **It's in native-C territory on a single thread** — the full
  native comparison, its caveats, and the re-measurement in progress
  are on the [LittleCMS comparison page](./docs/LcmsComparison.md).
- **Enabling WASM SIMD triples the 3D throughput over JS `'int'`**
  (range 2.94–3.50×), bit-exact. 4D kernels (CMYK input) land 2.04–
  2.57× over JS `'int'` on x86_64 — limited by per-pixel scalar
  prologue, not the SIMD body. On hosts without v128, the dispatcher
  demotes to WASM scalar, then to JS `'int'`, then to `'float'`;
  code doesn't change.
- **Apple Silicon (M4) runs ~1.4–1.6× faster than x86_64 at every
  tier** — pure JS `'int'`, WASM scalar, *and* WASM SIMD — because
  ARM64's 31 GPRs (vs ~11 allocatable on x86-64) erase the spill
  traffic that dominates the kernels on x86. The biggest lift lands
  on the **4D CMYK paths** (+65 %), which is exactly the prediction
  the [JIT-inspection deep-dive](./docs/deepdive/JitInspection.md#implications-for-future-work)
  was filed against — see [Performance § 2.6](./docs/Performance.md#26-arm64--apple-silicon--the-register-pressure-prediction-landed)
  for the full table.
- **Ratios are stable across like CPUs; absolute numbers aren't.**
  JS engines (V8, SpiderMonkey, JSC) schedule the hot loops
  differently and their optimisers evolve between releases. Treat
  the numbers above as a guide, not a contract. Run the in-browser
  bench (`npm run serve`) on your own machine.

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

Self-contained HTML demos ship in `samples/`. The site entry is
**<https://www.o2creative.co.nz/jscolorengine/samples/>** (project landing);
the demo index and setup notes are on
**[samples.html](https://www.o2creative.co.nz/jscolorengine/samples/samples.html)**.

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

Run locally with `npm run serve` — see
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

- **Named Color profiles** (`ncl2`) are not supported.
  → [Why named colour profiles are not supported](./docs/deepdive/namedColorProfiles.md)
- **N-channel (5CLR–15CLR) input runs on the accuracy pipeline only** —
  `buildLut` is declined for n-ink *input* (a `grid^N` bake is
  impractical; the profile's own A2B grid is authoritative) and the
  per-pixel pipeline is used instead. N-channel as *output* gets the
  full baked-LUT image path. → [notes](./docs/NChannel.md)
- **MultiProcessElement** (`mpet`) profiles load via the fallback path
  — the ICC spec mandates the standard `AtoB` / `BtoA` LUT tags are
  always present in a conforming profile, so MPE-bearing profiles
  work through the standard tags. MPE-only film / scientific
  workflows are not the target.
  → [Why MPE is not supported](./docs/deepdive/multiProcessElements.md)
- **Abstract profiles** (`pClass: 'abst'`) and ColorSpace profiles (`pClass: 'spac'`) are
    not currently supported. Both are extremely rare in practice. Abstract profiles
    perform PCS→PCS transforms (colour effects, viewing condition adjustments) and
    require a pipeline branch that skips device I/O entirely. ColorSpace profiles are
    structurally identical to device profiles and would be trivial to enable — raise
    an issue if you need either.
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
| **[Bench](./docs/Bench.md)** | Run the numbers on your own hardware — in-browser, zero-upload, full methodology & submission guide ([live](https://www.o2creative.co.nz/jscolorengine/samples/bench/)) |
| **[Deep dive](./docs/deepdive/)** | How it works, why it's fast — pipeline model, lutMode internals, JIT inspection, WASM kernel design |
| **[Performance](./docs/Performance.md)** | Benchmark numbers, discoveries in the journey, lcms comparison |
| **[Samples](./docs/Samples.md)** | Live demos — video soft-proof, image soft-proof, jsCE vs lcms-wasm comparison ([live](https://www.o2creative.co.nz/jscolorengine/samples/)) |
| **[vs LittleCMS](./docs/LcmsComparison.md)** | The full comparison — lcms-wasm results, the native-C harness and its re-measurement, the specialisation story |
| **[Roadmap](./docs/Roadmap.md)** | What's coming next — single source of truth for future plans (compiled pipeline / `toModule()`, profile oracle QC, kernel emit) |
| **[Examples](./docs/Examples.md)** | Canvas round-trip, custom pipeline stages, and other recipes beyond Quick start |
| [API — Profile](./docs/Profile.md) | `Profile` class: loading, virtual profiles, tag access |
| [API — Transform](./docs/Transform.md) | `Transform` class: constructor options, `create`, `createMultiStage`, `transform`, `transformArray` |
| [API — Loader](./docs/Loader.md) | Optional batch profile loader |
| [Plugins](./docs/Plugin.md) | Registering custom LUT kernels (`lutMode: 'custom…'`) — signature contract, resolution order, isolation |
| [DeviceLink](./docs/DeviceLink.md) | How DeviceLink (`pClass: 'link'`) profiles are supported — element structure, asymmetric links, test fixtures |
| [N-channel](./docs/NChannel.md) | How 5CLR–15CLR press profiles are supported — both directions, LUT policy, memory trade-offs |
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
npm run serve

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
