# Roadmap

[README](../README.md) ·
[Deep dive](./deepdive/) ·
[Performance](./Performance.md) ·
[Bench](./Bench.md) ·
[Examples](./Examples.md) ·
**Roadmap** ·
[Profile](./Profile.md) ·
[Transform](./Transform.md) ·
[Loader](./Loader.md)

---

Single source of truth for what's coming next in jsColorEngine.
Retrospective material (what shipped, what we measured, what we
learned) lives in [Performance.md](./Performance.md). Versioned
release notes live in [CHANGELOG.md](../CHANGELOG.md). This page is
future-facing only.

> **Planning philosophy.** This is a solo-maintained codebase, so the
> roadmap is ordered by "what unlocks the most for the least work"
> rather than calendar dates. Items are specified to the point where
> the next person reading (human or AI) can pick one up without
> re-deriving the design. Numbers and trade-offs come from measurement,
> not speculation — see Performance.md for the evidence behind each
> projection.

---

## Table of contents

- [Shipped so far](#shipped-so-far)
- [v1.4 — Image helper + browser samples (shipped)](#v14--image-helper--browser-samples)
    - [Browser samples](#browser-samples)
- [v1.5 — N-channel float inputs + compiled non-LUT pipeline + `toModule()`](#v15--n-channel-float-inputs--compiled-non-lut-pipeline--tomodule)
    - [N-channel float inputs (5 / 6 / 7 / 8-channel input profiles)](#n-channel-float-inputs-5--6--7--8-channel-input-profiles)
    - [Tunable LUT grid size — `lutGridSize` option](#tunable-lut-grid-size--lutgridsize-option)
    - [Custom LUT callbacks — `lutInputHook` / `lutOutputHook`](#custom-lut-callbacks--lutinputhook--lutoutputhook)
    - [Lab ↔ int16 helpers (`convert.lab2Int16` / `convert.int162Lab`)](#lab--int16-helpers-convertlab2int16--convertint162lab)
    - [`lcms_patch/` extraction (v1.3 follow-up)](#lcms_patch-extraction-v13-follow-up)
    - [Dependency hygiene — Dependabot triage + devDependency bumps](#dependency-hygiene--dependabot-triage--devdependency-bumps)
    - [Pipeline validation — `validateOnCreate` option](#pipeline-validation--validateoncreate-option)
    - [Compiled non-LUT pipeline + `toModule()` (v1.5 centrepiece)](#compiled-non-lut-pipeline--tomodule-v15-centrepiece)
    - [Non-LUT pipeline code generation (`new Function` + emitted WASM)](#non-lut-pipeline-code-generation-new-function--emitted-wasm)
    - [Per-Transform microbench for `'auto'`](#per-transform-microbench-for-auto)
    - [DROPPED — float-WASM tier (was: float-wasm-scalar / f32 CLUT / float-wasm-simd)](#dropped--float-wasm-tier-was-float-wasm-scalar--f32-clut--float-wasm-simd)
- [v1.6 (optional) — `lutMode: 'int-pipeline'` — S15.16 for lcms parity](#v16-optional--lutmode-int-pipeline--s1516-for-lcms-parity)
- [v1.7 (optional) — Hardened profile decode](#v17-optional--hardened-profile-decode)
- [v2 — Separation of concerns: split Transform + Pipeline + Interpolator](#v2--separation-of-concerns-split-transform--pipeline--interpolator)
- [What we are explicitly NOT doing](#what-we-are-explicitly-not-doing)
- [Historical record — original v1.3 / v1.5 analysis (1D WASM POC)](#historical-record--original-v13--v15-analysis-1d-wasm-poc)

---

## Shipped so far

**v1.0** — full ICC v2/v4 ingest, virtual profiles, four rendering
intents, BPC, tetrahedral interp, Lab / XYZ / RGB / CMYK /
n-channel device spaces, spectral + illuminant maths.

**v1.1** — `lutMode: 'int'` integer hot path. u16 mirror LUTs,
`Math.imul`-based tetrahedral kernels for all four 3-/4-channel
directions. ≤ 1 LSB on u8 output, 10–25 % faster than the float
kernel, 4× less LUT memory. See
[Performance.md § v1.1 shipped](./Performance.md#v11--4d-integer-kernels-cmyk-input--u20-refactor--shipped).

**v1.2** — WASM LUT kernels + `lutMode: 'auto'` default +
browser benchmark + documentation restructure.

- Hand-written WebAssembly kernels: `'int-wasm-scalar'` (1.22–1.45×
  over `'int'`) and `'int-wasm-simd'` (2.04–3.50× over `'int'`),
  both 3D and 4D, bit-exact against the JS `'int'` reference across
  a 12-config matrix. 4D uses u20 Q16.4 single-rounding + SIMD
  K-plane loop for a flat ~125 MPx/s regardless of LUT size.
- `lutMode: 'auto'` as the new default, with `int8 + buildLut: true`
  resolving to `'int-wasm-simd'` and automatic demotion chain (SIMD
  → scalar WASM → JS `'int'`) at `create()` time.
- Browser benchmark (`samples/bench/` + [docs/Bench.md](./Bench.md))
  — zero-dependency, runs every kernel against `lcms-wasm`.
- Full documentation restructure: README → overview, Deep dive →
  internals, Performance.md → measurements, Roadmap.md → future
  plans (this page).

Full numbers and the journey: [Performance.md](./Performance.md).
Release notes: [CHANGELOG.md](../CHANGELOG.md).

**v1.2 is feature-complete.** The last open item — a measured
head-to-head against native (non-wasm) lcms2 — landed via
[`bench/lcms_c/`](../bench/lcms_c) and is documented in
[Performance.md § Measured — vs native LittleCMS](./Performance.md#measured--vs-native-littlecms-same-hardware-same-run).
Headline: `lutMode: 'int'` (pure JS) beats native vanilla lcms2 on
3 of 4 image workflows on the same hardware, and the v1.2 default
(`'int-wasm-simd'`) wins on all four by 2–5×.

**v1.3** — 16-bit input/output (`dataFormat: 'int16'`) across the
JS LUT kernel + WASM scalar + WASM SIMD u16 kernels, with
bit-exactness across all three siblings. Kernels are
**feature-complete** for the workloads jsColorEngine is targeted
at (3-channel and 4-channel input device profiles, 3- and 4-channel
output, both u8 and u16 I/O).

**v1.4** — showcase release + license change. Puts the v1.3 perf
story in front of users with runnable browser demos, a small
`ICCImage` helper that makes image workflows trivial, and baked
gamut-mapping in the LUT. License changed from GPL-3.0 to MPL-2.0
(file-level copyleft — the library can now be combined with
proprietary code in a Larger Work). Two planned samples
(`colour-calculator.html`, `profile-inspector.html`) are still WIP
and will land iteratively.

- **`ICCImage` helper** (`samples/iccimage.js`) — small immutable
  image wrapper (MIT-licensed) that owns the "I have an image, I
  want to proof / inspect it" workflow. Immutable, always
  profile-tagged, lazy + cached transforms. Full API reference:
  [`samples/ICCImage.md`](../samples/ICCImage.md).
- **Baked gamut-mapping LUT** — new `lutGamutMode` option
  (`'none'` / `'color'` / `'map'` / `'colorMap'`) bakes gamut
  visualisation into the LUT at build time. Zero per-pixel cost.
  Powers the live-video demo's real-time gamut warnings.
- **Browser samples** — three shipped demos plus a landing page:
  [`live-video-softproof.html`](../samples/live-video-softproof.html)
  (real-time video soft-proofing at 40+ fps, the headline demo),
  [`softproof.html`](../samples/softproof.html) (image soft-proof +
  plate previews + colour picker),
  [`softproof-vs-lcms.html`](../samples/softproof-vs-lcms.html)
  (pixel-level accuracy comparison with lcms-wasm),
  [`index.html`](../samples/index.html) (project landing) and
  [`samples.html`](../samples/samples.html) (demo index).
- **License: GPL-3.0 → MPL-2.0.** File-level copyleft removes the
  main adoption blocker GPL posed for commercial embedders.
- **Sample infrastructure** — `samples/serve.js` dev server,
  `samples/styles.css`, bundled CMYK ICC profiles.
- **Docs** — [`docs/Samples.md`](./Samples.md) live demo index,
  [`samples/ICCImage.md`](../samples/ICCImage.md) API reference.
- **Tests** — `__tests__/transform_lut_gamut.tests.js` covering
  all four gamut modes, threshold behaviour, and custom ΔE
  functions.

- **JS u16 kernel** (`lutMode: 'int16'`) — `Uint16Array` CLUT
  scaled to the full [0..0xFFFF] range with **Q0.13 fractional
  weights** (chosen as the precision sweet-spot that keeps every
  intermediate inside the i32 envelope `Math.imul` and `i32.mul`
  share, so JS ↔ WASM is bit-exact across browsers and OSes
  without runtime checks). 4D paths use a two-rounding K-LERP for
  i32 safety with no measurable accuracy cost.
- **WASM scalar u16** (`lutMode: 'int16-wasm-scalar'`) — same
  Q0.13 contract compiled to hand-written `.wat`. Bit-exact
  against the JS sibling (0 LSB across the whole 6-config matrix).
  ~1.3–1.4× over JS `int16` on 3D, ~1.0–1.2× on 4D.
- **WASM SIMD u16** (`lutMode: 'int16-wasm-simd'`) — channel-
  parallel `v128`, Q0.13, two-rounding K-LERP for 4D with the K0
  intermediate carried in a `v128` local across the K-plane loop
  back-edge (no scratch memory). Bit-exact against both u16
  siblings. **~1.7–2.4× over `int16-wasm-scalar`, ~2.0–2.6× over
  JS `int16`, ~3.9–4.9× over `lcms-wasm` 16-bit at every workflow.**
- **`'auto'` resolution** for `dataFormat: 'int16'` — picks the
  best available u16 kernel at `create()` time with the same
  demotion chain as the v1.2 u8 path:
  `int16-wasm-simd` → `int16-wasm-scalar` → `int16`.
- **Three accuracy gates** ship alongside the kernels:
  [`bench/int16_identity.js`](../bench/int16_identity.js) (synthetic
  identity-CLUT round-trip — kernels MUST round at the u16 LSB),
  [`bench/int16_poc/accuracy_v1_7_self.js`](../bench/int16_poc/accuracy_v1_7_self.js)
  (jsCE float-LUT vs jsCE int16-LUT — pure kernel quantisation
  noise, max **4 LSB u16** on every workflow, mean ≤ 0.48 LSB),
  and [`bench/lcms_compat/run.js`](../bench/lcms_compat/run.js)
  (jsCE float pipeline vs lcms2 2.16 float pipeline — confirms
  the math underneath is correct, see Accuracy doc).
- **Browser benchmark updated** — 8 jsColorEngine modes vs
  6 lcms-wasm flag/width combinations across 4 directions
  (56 cells), with the new `int16-wasm-scalar` and
  `int16-wasm-simd` modes wired into the dropdowns and the
  in-page essay. See [Bench.md](./Bench.md).
- **Dispatcher refactor** —
  [`src/lutKernelTable.js`](../src/lutKernelTable.js) now resolves
  `(lutMode, inCh, outCh)` against a pure-data table with
  per-entry gates and an explicit fallback chain. The runtime
  cost is a single table lookup at `create()` time; the
  maintainability win is "every new kernel is a row in a table",
  not "another `else if` in the dispatcher".

Browser bench headline (Chrome 147, x86_64, 65 K pixels/iter,
GRACoL2006 + sRGB), `int16-wasm-simd` row vs lcms 16-bit best:

| Direction      | jsce `int16` (JS u16) | `int16-wasm-scalar` | **`int16-wasm-simd`** | lcms 16-bit best |
|----------------|------------------------|----------------------|-----------------------|------------------|
| RGB → RGB      | 66 MPx/s               | 93 MPx/s             | **158 MPx/s**         | 46 MPx/s |
| RGB → CMYK     | 56                     | 78                   | **149**               | 44 |
| CMYK → RGB     | 42                     | 43                   | **90**                | 24 |
| CMYK → CMYK    | 35                     | 37                   | **86**                | 21 |

Bit-exact across all three jsCE u16 implementations on every
cell of the test matrix. See
[Performance.md § v1.3 — 16-bit kernel ladder](./Performance.md#v13--16-bit-kernel-ladder-shipped)
for the headless-bench numbers, the design constraints
(why Q0.13 specifically, why two-rounding for 4D), and
[Accuracy.md § 16-bit kernel accuracy](./deepdive/Accuracy.md#16-bit-kernel-accuracy-v13--near-perfect-no-corners-cut)
for the per-workflow precision tables.

What's deliberately **not** in v1.3:

- **N-channel input kernels.** 3 / 4-channel CLUT inputs cover
  every device class jsColorEngine targets at speed. 5 / 6 / 7 /
  8-channel inputs (RISO MZ770, multi-spot press profiles) work
  through the f64 pipeline today and don't have a real-world
  use case for a fast int / WASM path. v1.5 adds them on the
  **float side only** (see below).
- **`lutGridSize` option.** Bumped to v1.5 — the int16 kernel
  ladder was the higher-value v1.3 pull, and the sample suite
  in v1.4 is the higher-value next step before we go back to
  more accuracy levers.
- **`lcms_patch/` regen-able diff** for the patched `transicc`
  binary. The endpoint-diff and per-pixel triage harnesses both
  shipped (see [Accuracy.md](./deepdive/Accuracy.md)) — the open
  piece is extracting the lcms instrumentation as a `.patch`
  against stock 2.16 so future contributors don't need the
  vendored tree on disk.

---

## v1.3 — see [Shipped so far](#shipped-so-far)

The v1.3 plan above shipped as scoped (modulo the deliberate
deferrals noted in the bullet list). The original "v1.3 plan"
prose that lived here has been folded into the shipped retrospective
and into [Accuracy.md](./deepdive/Accuracy.md). Two follow-up items
that were originally drafted under v1.3 — `lutGridSize` and the
`lcms_patch/` extraction — moved to v1.5 alongside the bigger
compiled-pipeline work (next-but-one section).

---

## v1.4 — Image helper + browser samples — shipped 2026-04-26

A small, single-purpose helper class that owns the "I have an image,
I want to display / proof / inspect it" workflow. **Not a general
image library** — no filters, no composite, no format encode/decode.
Strictly "move bytes around the colour transform, visualise what's
there", with two amenities — bilinear downscale and bit-depth
conversion — that earn their place as defensive guards against huge
browser uploads and dtype mismatches.

> **Why this is v1.4 and not v1.5.** The v1.3 kernel ladder banked
> a real performance story (158 MPx/s `int16-wasm-simd`, 4-5× over
> lcms-wasm 16-bit). The fastest way to convert that into adoption
> is concrete, runnable samples — not another perf release. v1.4 is
> the **showcase release**: a small helper class + a handful of
> browser samples that put the v1.3 numbers in front of users on
> their own machines. The larger v1.5 compiled-pipeline + N-channel
> work below is high-value but high-effort and could delay; landing
> the sample suite first means even if v1.5 slips, the project keeps
> growing visible surface area on the back of v1.3's perf story.

Lives in [`samples/iccimage.js`](../samples/iccimage.js), exported
as `ICCImage`. Lives in `samples/` (not `src/`) deliberately — it's
**helper-grade**, MIT-licensed (separate from the engine's MPL-2.0
— see [`samples/LICENSE`](../samples/LICENSE)), and double-billed
as living documentation of how to drive the core engine on real
image data. Full API reference: [`samples/ICCImage.md`](../samples/ICCImage.md).

### Status

**Shipped (v1.4.0).** Helper, gamut-mapping LUT, three demos, and
the license change all landed. Two planned samples
(`colour-calculator.html`, `profile-inspector.html`) are still WIP
— see *Browser samples* below.

### Design tenets

| Tenet | What it means |
|---|---|
| **Immutable** | Every `toSRGB` / `toProof` / `toSeparation` / `toBitDepth` / `resizeTo` returns a *new* `ICCImage`. The source is never mutated. No "wait, which image am I looking at" bugs in demos. |
| **Always profile-tagged** | The internal `ICCImageData` carries the `Profile` AND the full lineage chain (`[Profile, intent, Profile, intent, ...]`, same shape as `Transform.chain`). There is no such thing as an untagged `ICCImage`. |
| **Lazy + cached** | `Transform`s are built on first use and stored in a `TransformCache` keyed by `chain + BPC + dataFormat + buildLut`. Derived images share their parent's cache, so chained ops compound the cache hit rate. |
| **Two paths** | Bulk image work uses `dataFormat: 'int8'` + `buildLut: true` (the engine's fast LUT path). Single-pixel `pixel(x, y)` work uses `dataFormat: 'object'` with no LUT (the accuracy path). |

### API shape

```js
import { ICCImage } from './samples/iccimage.js';
const { Profile, eIntent } = window.jsColorEngine;  // UMD bundle global

const cmyk = new Profile();
await cmyk.loadPromise('GRACoL2006_Coated1v2.icc');

// Construct from an HTMLImageElement / HTMLCanvasElement / ImageBitmap.
// `maxPixels` is a defensive bilinear-downscale cap — drop a 30 MP image
// in the browser and it'll arrive as ~4 MP, no special-casing required.
const src = await ICCImage.fromHTMLImage(myImg, { maxPixels: 4_000_000 });

// Each conversion returns a new ICCImage. Source is never touched.
const proof = await src.toProof(cmyk, { intent: eIntent.perceptual, BPC: true });
const sep   = await src.toSeparation(cmyk);

await src.toCanvas(canvas1);                       // sRGB blit
await proof.toCanvas(canvas2);                     // soft-proofed sRGB blit
await sep.renderChannelAs('C').toCanvas(canvas3);  // tinted cyan plate

const px = src.pixel(120, 200);
// → { lab: {L,a,b}, srgb: {R,G,B,hex}, device: [0..1, ...], space: 'RGB' }
```

### What it does

| Method | What it returns | Notes |
|---|---|---|
| `ICCImage.fromHTMLImage(src, { profile?, maxPixels? })` | new `ICCImage` | Always 8-bit RGBA (canvas API ceiling). |
| `ICCImage.fromImageData(imageData, profile?, { maxPixels? })` | new `ICCImage` | Wrap existing `ImageData`. |
| `new ICCImage({ width, height, data, profile, ... })` | new `ICCImage` | Direct construction from a typed array. For decoded 16-bit sources etc. |
| `await img.toSRGB({ intent?, BPC? })` | new `ICCImage` (sRGB) | No-op fast path if already sRGB. |
| `await img.toProof(proofProfile, { intent?, BPC? })` | new `ICCImage` (sRGB) | Soft-proof: src → proof → \*sRGB. `intent` / `BPC` accept arrays for per-leg control. |
| `await img.toSeparation(proofProfile, { intent?, BPC? })` | new `ICCImage` (proof space) | The actual ink separation. `toCanvas()` on this builds an on-the-fly display transform. |
| `img.toBitDepth(8 \| 16 \| 'float32')` | new `ICCImage` | Element-wise dtype conversion; profile + chain unchanged. |
| `img.resizeTo({ maxPixels? \| width? \| height? })` | new `ICCImage` | Bilinear downscale (all dtypes). Up-sampling is rejected. |
| `await img.toCanvas(canvas)` | the canvas | Auto-resizes the canvas. Direct blit if the terminal profile is sRGB; otherwise builds + caches `[terminal, *sRGB]`. |
| `img.renderChannelAs(ref, tint?)` | new `ICCImage` (sRGB tinted) | Single-channel preview as a tinted RGBA image. |
| `img.pixel(x, y)` | `{ lab, srgb, device, space }` | Accuracy path (no LUT). Lazily builds `src→*Lab` and `src→*sRGB` no-LUT transforms cached on the instance. |
| `img.info` | summary object | Includes the human-readable lineage chain. |
| `img.disposeRaw() / dispose()` | — | Drop raw buffer / drop everything. |

### Why this shape

- **Immutable + chain on `ICCImageData`.** The lineage chain reads
  left-to-right as the data's history. The terminal profile alone
  tells you how the data is currently encoded. No "did `proofProfile`
  get pinned at construction or not?" — every transform is in the
  chain or it isn't.
- **Two cache surfaces, one design rule.** The shared `TransformCache`
  is tuned for `buildLut: true` bulk pipelines (where derived images
  reuse the same LUTs as their parent). The per-instance `pixel()`
  cache holds the no-LUT accuracy-path Transforms separately, because
  mixing keying conventions across the two would muddy both.
- **`pixel()` returns three answers at once.** Lab + sRGB + device-space
  is what every UI colour-picker actually wants. Single Lab transform
  cached on first call, single sRGB transform cached on first call,
  device readout is a buffer slice. Subsequent picks are near-instant.
- **`renderChannelAs` returns an `ICCImage`, not a buffer.** Same
  drawing API as everything else (`.toCanvas()`), composes with
  immutable ops, no special "channel buffer" type to learn.

### Pinned design decisions

1. **`getChannel('C')` deliberately omitted.** A 1D extracted channel
   has no valid profile to tag it with — it would violate the "always
   profile-tagged" tenet. Use `renderChannelAs` for previews; if you
   want raw channel pixels, read them out of the `ICCImageData` buffer
   directly via `img.raw`.
2. **`fromBuffer(arrayBuffer, mimeType)` deferred.** Format decode
   (JPEG / TIFF / PNG) belongs in a pluggable layer that doesn't ship
   yet. For now, demos construct `ICCImage`s from `HTMLImageElement`s
   (canvas-decoded, 8-bit RGBA) or from typed arrays directly.
3. **`resizeTo` rejects upscaling.** KISS — the helper exists to be
   defensive against huge uploads, not to grow images. Real
   resampling belongs in a real image library.
4. **`toCanvas` doesn't take a colour space option.** Canvas is sRGB
   by spec; offering anything else would be lying.
5. **Engine wiring is lazy.** `ICCImage` reads `globalThis.jsColorEngine`
   on first use (the UMD bundle global). For ESM environments,
   `ICCImage.init({ engine })` injects the engine explicitly.

### Non-goals

- Filters, blur, sharpen, composite, blend modes → use a real image
  library (ImageMagick, libvips, pillow via wasm, etc) *before* jsCE.
- Format encode/decode (PNG, JPEG, TIFF) → out of scope for now.
  Accept `ImageData` / typed arrays in, emit `ImageData` / typed
  arrays out. Pluggable decoders may land later.
- Upscaling. `resizeTo` rejects it.
- Video. Not a streaming API.

### When it ships

**Shipped (v1.4.0).** `samples/iccimage.js`, the gamut-mapping LUT,
and three demos (`softproof.html`, `softproof-vs-lcms.html`,
`live-video-softproof.html`) all landed. The remaining two demos
(`colour-calculator.html`, `profile-inspector.html`) land
iteratively — none of them blocks v1.5 work.

### Browser samples

Dev-adoption angle: most colour libraries are judged in 30 seconds by
whether there's a working demo someone can click. jsColorEngine has
the [browser benchmark](./Bench.md) shipped in v1.2 but needs product
samples as well. The `ICCImage` helper above is the glue that makes
the image-centric demos short enough to read as documentation. See
[Samples.md](./Samples.md) for the live index; the entries below are
the design notes / briefs.

Target samples (all zero-build, reference `browser/jsColorEngineWeb.js`
via `<script>`, work from `file://` so devs can just download + open):

- **`softproof.html`** ✅ *shipped v1.4* — combined showcase: soft-proof
  through a CMYK profile (`toProof`) plus the four C/M/Y/K plate
  previews driven off the actual `toSeparation` output via
  `renderChannelAs`. One `ICCImage` source feeds three derived images
  through the shared `TransformCache`, so changing the profile back
  to one we've used before is ~0 ms on the second look. Replaces the
  originally-separate `rgb-to-cmyk-separations.html` and
  `soft-proof-image.html` briefs — they were splitting one workflow
  in half. Live: [`samples/softproof.html`](../samples/softproof.html).
- **`colour-calculator.html`** 🔧 *WIP* — interactive converter between
  RGB / Lab / XYZ / LCH / CMYK with live round-trip display. Primary
  showcase for `ICCImage.pixel(x, y)` (the no-LUT accuracy path) plus
  the `convert.js` helpers and virtual-profile shortcuts. UI: a row
  of sliders per colour space, ΔE readout between source and
  round-tripped destination, optional "load image, pick a pixel" mode
  that pipes the image through `pixel()` directly.
- **`softproof-vs-lcms.html`** ✅ *shipped v1.4* — **the proof-of-accuracy demo.**
  Load an image, pick a press profile, run the same softproof
  through both `jsColorEngine` and `lcms-wasm`, show three panels:

    1. **Left** — jsCE softproof result + transform time (ms) + MPx/s
    2. **Middle** — pixel-by-pixel diff visualisation with
       amplification slider (1× to 32×, logarithmic). At 1× identical
       outputs look black; at 32× a 1-LSB drift is clearly visible.
       Greyscale by default = absolute per-channel magnitude; toggle
       to signed-RGB mode (red tint = R channel differs, green = G,
       blue = B) for directional info.
    3. **Right** — lcms-wasm softproof result + transform time (ms)
        + MPx/s

  Stats strip under the diff panel:

    - Max abs diff (0–255 units, per channel)
    - Mean abs diff
    - % of pixels that match exactly
    - % within 1 LSB, % within 2 LSB
    - Speed ratio (jsCE / lcms)

  Double-value demo: lets users **see for themselves** that the two
  engines produce visually-indistinguishable output at different
  speeds (marketing) AND gives **us** a regression surface during
  v1.3 compat harness work — if the diff panel ever shows structured
  red blobs where there should be noise, something's drifted.

  **Sales pitch compressed into one screen.** Three conclusions in
  ~15 seconds with no reading required:
    - *"Same images"* → visually identical → **accuracy**
    - *"47 ms vs 182 ms"* → inline timing → **speed**
    - *"JS only"* vs *"+ 340 KB WASM"* in the stats strip →
      **simplicity of integration** (the quiet killer for anyone
      who's fought a corporate CSP or a Webpack bundle size review)

  **Design details that matter:**
    - **Logarithmic diff slider** (1, 2, 4, 8, 16, 32×) — linear would
      waste range on the middle. `gain = Math.pow(2, sliderPct * 5)`.
    - **Swap-sides button** — humans have LTR scan bias; letting users
      put either engine on either side removes "is it just a
      perception artefact?" doubt. Tiny feature, disproportionate
      credibility payoff.
    - **Signed-RGB diff toggle** — magnitude view tells you *where*
      engines disagree; signed-RGB (red tint = R channel differs, etc)
      tells you *how*. The debugging-speedrun mode for v1.3 regression
      triage: uniform red = R-channel quantisation drift, blue-in-
      shadows = BPC interaction, structured pattern along gamut
      boundary = clip-vs-compress disagreement.
    - **Honesty by construction.** User runs it live on their own
      machine with their own image — we can't fudge the numbers, and
      any future regression (a v1.5 compiled-pipeline change that
      trades 2% accuracy for 5% speed, say) surfaces immediately
      and publicly. Same
      forcing function as the `.it8` harness gives us internally,
      just in public.

  `ICCImage` shines here: the jsCE side is literally
  `await (await ICCImage.fromHTMLImage(img)).toProof(cmyk).toCanvas(cv)`
  — the whole sample is mostly the lcms-wasm wiring + diff
  calculation + UI, which highlights how much glue the helper saves.
  ~250 lines total.
- **`profile-inspector.html`** 🔧 *WIP* — load any ICC file, dump tag table,
  show TRC curves, render the gamut shell in 3D. Genuinely useful
  tool on its own; doubles as a demo of the `Profile` class API
  surface.
- **`live-video-softproof.html`** ✅ *shipped v1.4* — Side-by-side `<video>` elements, HD (720p probably —
  lots of other overhead on the page, and 30 fps is already the
  "oh wow" threshold; don't need 60). Left = original sRGB, right =
  live CMYK softproof with gamut warnings, profile swappable from a
  dropdown mid-playback.

  The trick that makes this cheap: **bake the gamut warning into
  the LUT at build time.** For each grid point in the RGB→CMYK→RGB
  softproof LUT, also compute ΔE₀₀ between the input RGB (converted
  to Lab) and the round-tripped RGB (converted to Lab). If ΔE
  exceeds a threshold, stamp the output cell as either:

    1. **Clobber mode** — overwrite the RGB with pure RED (simple,
       one demo-line change, produces pink smears along gamut
       boundaries due to tetra interp between "clean" and "warning"
       cells — which actually reads as a nice soft warning gradient
       rather than a bug).
    2. **Alpha-channel mode** *(preferred)* — keep the real
       softproof RGB in the first 3 output channels, store
       `clamp(ΔE / threshold, 0, 1)` in a 4th alpha channel. The
       existing `outputChannels = 4` LUT path (`src/Transform.js`
       around `create3DDeviceLUT` / the CMYK output branch) already
       carries 4-ch output cells, so the LUT layout doesn't change
       — the interpolator just writes RGBA instead of RGB. Final
       compositing is a single `mix(rgb, warning_tint, a)` in the
       canvas draw, so the warning colour / zebra stripes / desat
       stays UI-tuneable without rebuilding the LUT.

  The headline is **zero hot-path cost.** The WASM SIMD tetra
  kernel doesn't know or care whether a cell carries a softproof
  RGB or a warning-stamped one — it just blends 8 corners. All the
  ΔE work amortises into the ~50-100 ms LUT bake. Profile change
  on the fly = rebuild LUT on a worker, atomic pointer swap between
  frames (ping-pong two LUT buffers so a change mid-frame doesn't
  tear).

  Video → canvas pipeline: `ctx.drawImage(videoElement, ...)` on a
  hidden 2D canvas, `getImageData()` → `ICCImage.fromImageData()` →
  `await img.toProof(cmyk).toCanvas(visibleCanvas)` per frame
  (the per-frame `TransformCache` hit means the proof transform is
  built exactly once across the whole playback). Modern browsers also expose `VideoFrame` (WebCodecs) +
  `OffscreenCanvas` + `requestVideoFrameCallback()` which skips a
  CPU copy and lines up with the decoder cadence — worth using if
  available, fallback to the `drawImage` path otherwise.

  Budget check: 1280 × 720 @ 30 fps = **27.6 MPx/s**, vs the SIMD
  3D path already sitting at hundreds of MPx/s per
  `docs/Performance.md` — plenty of slack even after `drawImage`
  round-trip overhead, and a generous buffer for a side-by-side
  "original vs softproof" layout (double the pixel count). 1080p30
  = 62 MPx/s, also reachable; 4K30 = 249 MPx/s sits at the edge of
  what the kernel can sustain and probably wants OffscreenCanvas +
  worker threading. Start at 720p, see where it lands.

  Demo value: *"here's your video on a press, right now, with the
  out-of-gamut areas glowing."* Profile-swap dropdown makes the
  difference between FOGRA39 and SWOP visible in real-time — which
  is a thing colour-managed workflows normally can only show on
  stills, and only after a render-wait. Fits naturally after
  `soft-proof-image.html` as the "same idea but moving" follow-up.

  **Pitch voice (lean all the way in).** The page leads with a
  single oversized headline — something like:

  > **"Ever wondered how your holiday video would look printed on
  > a newspaper? No? Well now you can find out anyway."**

  Other lines in rotation, pick the funniest on the day:

    - *"Logo - The video PRINTER" in the theme of old world hand panted photo cars*
    - *"The world's first — and, frankly, most unnecessary — real-time
      video softproofing engine."*
    - *"Because somewhere, someone needs to know whether their cat
      video is CMYK-safe for FOGRA39. That person is probably not
      you. But the button is right there."*
    - *"Live video, live press simulation, live gamut warnings. Three
      things nobody asked for, bundled into one web page."*
    - *"Print your videos! (Figuratively. Please do not actually do
      this.)"*
    - *"Watch your wedding footage go out of gamut in real time. It's
      fine. The highlights were always going to clip on coated
      stock anyway."*

  A small "Why?" link under the headline opens a modal that, with
  a completely straight face, explains the engineering: baked
  gamut-warning LUT, zero hot-path cost, profile ping-pong,
  tetrahedral interpolation of warning cells as a feature not a
  bug. Joke on the tin, receipts in the footnote. The contrast is
  the whole gag — and it quietly demonstrates that the engine is
  fast enough to do a genuinely silly thing at 30 fps, which is the
  actual sales pitch dressed up as a punchline.

Each ~100-200 lines of vanilla JS, no framework, no build step.
Hosted on GitHub Pages so the README can link to live demos ("Try
it in your browser →"). Adoption impact per hour of effort is
higher than almost any feature work.

Samples also double as **the runnable backing for the `docs/Guide.md`
tuning guide** (when it lands) — each one is the "working copy" of
a code block in the guide, checked for drift by a tiny sync script.

---
## v1.5 — N-channel float inputs + compiled non-LUT pipeline + `toModule()`

> **Scope reframe (Apr 2026).** v1.5 was originally "compiled
> non-LUT transforms + `toModule()` distribution". After the v1.3
> close-out two smaller items got slotted in at the front of its
> queue, and the ICCImage helper + samples work was promoted to v1.4
> (its own showcase release on the back of the v1.3 perf story).
> v1.5 now bundles:
>
> - **N-channel float inputs** — quick, low-risk extension of the
>   existing float pipeline to cover 5/6/7/8-channel input device
>   profiles (RISO MZ770, multi-spot press profiles). Float pipeline
>   only — see the section below for why we don't need a fast int /
>   WASM path for these.
> - **`lutGridSize` option** — accuracy lever rolled forward from the
>   v1.3 plan. Independent of any kernel change, lands cleanly on top
>   of the v1.3 kernel ladder.
> - **Custom LUT callbacks** (`lutInputHook` / `lutOutputHook`) —
>   intercept the input and/or output of every cell during LUT build.
>   Use cases: saturation boost (+15 % chroma on every sample before
>   the profile transform), channel swap (build a LUT that maps R↔B),
>   debug logging (dump every (input, output) pair to a file),
>   synthetic LUTs built from scratch (identity + user-defined warp,
>   no profile involved). Pure build-time hook — zero per-pixel cost
>   at transform time.
> - **`convert.lab2Int16` / `convert.int162Lab` helpers** — small
>   convenience wrappers over the v1.3 16-bit ladder for callers
>   feeding u16 Lab buffers directly. Two-layer API:
>   `convert.lab2Int16` / `convert.int162Lab` as the portable
>   lower-level primitive (takes an encoding sub-object — typically
>   `lut.inLab` or `lut.outLab` — or an explicit numeric tuple;
>   survives JSON / `structuredClone` / worker post-message), and
>   four explicit Transform wrappers
>   (`xform.inputLab2Int16` / `xform.outputLab2Int16` /
>   `xform.inputInt162Lab` / `xform.outputInt162Lab`) as the
>   ergonomic top for callers who already have a Transform in hand
>   and want to read or write either side without ambiguity.
>   Preferred storage: numeric scaling values **as data** on the
>   LUT (`pcsVersion` for human-readable JSON, `labNumerator` /
>   `abDenominator` for math, pre-computed multipliers for the
>   hot loop) so any future encoding is a numeric-tuple change
>   rather than a code change. Bulk array helpers are intentionally
>   *not* shipped — the math is straight-line and developers can
>   inline a tight loop tuned for their use case (and use the
>   scalar `transform.outputInt162Lab` as a ground-truth check).
>   See the section below.
> - **`lcms_patch/` extraction** — janitorial follow-up from the v1.3
>   compat harness (see Accuracy.md).
> - **Dependency hygiene** — `webpack` 5.89 → current 5.x,
>   `webpack-cli` 4 → 5, `webpack-dev-server` 4 → 5, `webpack-merge`
>   5 → current. Clears the 32 open Dependabot alerts (all transitive
>   `devDependencies` — `node-forge`, `serialize-javascript`,
>   `body-parser`, `express`, `ws`, `minimatch`, `braces`, etc.); the
>   runtime engine has zero direct vulnerable deps and ships nothing
>   from `node_modules` in the npm tarball, so the security exposure
>   today is contributor-machine only. Acceptance: full `npm test`
>   210/210, `npm run build` still produces browser bundles, all
>   sample pages and the bench load/run, all alerts closed or
>   explicitly dismissed-as-not-applicable.
> - **Pipeline validation** (`validateOnCreate` option) — after
>   `create()` / `createMultiStage()` builds the pipeline, run a
>   single-pixel transform in a `try/catch` to validate the pipeline
>   actually works. If it throws (NaN in a matrix, malformed curve,
>   etc.), `create()` throws instead of returning a Transform that
>   will fail on first use. Simple guard that guarantees both
>   `transform()` and `transformArray()` will succeed if `create()`
>   succeeded. Cheap (~1 µs), opt-in, zero cost if disabled.
> - **Same-profile passthrough (intent-gated)** — when the input and
>   output ICC profiles are the same, detect a **passthrough** path that
>   still respects **rendering intent**: take a fast no-op or single-leg
>   shortcut only where intent and BPC make that correct; otherwise keep
>   the full transform (same profile both sides is *not* automatically
>   identity — AToB/BToA asymmetry and table choice still matter). Bench
>   and lcms parity for the intent matrix (perceptual, relative
>   colorimetric, saturation, absolute), including same-CMYK-profile rows
>   such as GRACoL → GRACoL.
>
> The compiled non-LUT pipeline + `toModule()` work is still the
> centrepiece of v1.5 — those land after the warm-up items above.
> This is **the largest single piece of post-v1.4 work** and could
> meaningfully delay the release; v1.4's sample suite shipped ahead
> of it precisely so the project kept shipping visible progress on
> top of the v1.3 perf story.

### N-channel float inputs (5 / 6 / 7 / 8-channel input profiles)

**Today.** jsColorEngine's float (`lutMode: 'float'` /
`buildLut: false`) and `'int'` paths handle 3- and 4-channel input
device profiles at speed. For inputs with 5 or more channels (the
2C / 3C RISO MZ770 spot profiles in the lcms-compat suite, plus
real-world multi-spot CMYKOG / Hexachrome / 7-colour press profiles),
the engine **already produces correct output** through the f64
non-LUT pipeline (`buildLut: false`), which has no input-channel
limit. What it doesn't do is build a fast LUT for them.

**v1.5 adds:** `tetrahedralInterpNDArray_*Ch_loop` (the float
N-channel kernel, the natural extension of the existing 3D and
4D float kernels) and the build path in `createNDDeviceLUT()` that
emits an N-D `Float64Array` CLUT. This means an N-channel input
profile picks up the same float-LUT interpolation speedup the 3-
and 4-channel inputs get today (~10× over the per-pixel pipeline
walker), without changing the int / WASM kernel surface.

**Deliberately NOT shipping**: `int` / `int-wasm-scalar` /
`int-wasm-simd` for N>4 input. The use case isn't there. Three
reasons:

1. **No real-world high-throughput user.** N-channel input profiles
   exist for press separation jobs (proofing one spot CMYKOG file)
   and measurement workflows (instrument-derived n-channel scans),
   not for image batch processing. The image throughput where the
   int / WASM ladder pays off is a 3- or 4-channel input world
   (RGB, CMYK).
2. **The dimensional explosion.** A 17⁵ N-channel CLUT is 1.4 M
   cells; 17⁶ is 24 M; 17⁷ is 410 M. Even at u16 (2 bytes/cell),
   17⁷ × 4-output is 3.3 GB. Float (8 bytes) is 13 GB. Whatever
   speed an N-channel int kernel could deliver, the LUT bake is the
   bottleneck — and most interesting N-channel profiles use a
   smaller grid (9 or 11 per axis) precisely because of this.
3. **The float kernel is the right shape.** Float doesn't multiply
   the per-axis weight precision constraint that drove the
   Q0.13 / two-rounding choice on int 4D — `f64.mul` has 53 bits of
   mantissa to spend, so an N-axis interp at f64 is a straight
   tetrahedral walk with no intermediate rounding. The kernel is
   shorter, simpler, and well-suited to the workflows that actually
   want N-channel inputs (single-pixel inspection, slow batch
   measurement passes, gamut shell generation).

**Effort:** small. The 3D and 4D float kernels in
[`src/Transform.js`](../src/Transform.js) are the template — N-channel
unrolls the same simplex walk over an N-D index. Plumbed through
the existing `lutKernelTable.js` dispatcher as a new
`(lutMode='float', inCh=N)` row. Existing N-channel test profiles
in [`bench/lcms_compat/profiles/`](../bench/lcms_compat/profiles/)
become the regression surface.

**Result:** v1.5 closes the input-side coverage matrix on the float
path. The fast (int / WASM) ladder stays at 3- and 4-channel input
where the throughput case lives. v1.3's kernel feature-completeness
claim is *for the workloads jsColorEngine targets at speed*; v1.5
extends the *correctness-and-convenience* surface to cover the long
tail of input shapes without adding a fast path that no one would
exercise.

### Tunable LUT grid size — `lutGridSize` option

Second v1.3 accuracy lever, independent of the 16-bit work above.
ICC profiles typically ship with `clutPoints = 17` (so a 3D LUT is
17³ = 4913 cells). Doubling the grid size quadruples accuracy in
hot-gamut regions at predictable memory cost:

| Grid | 3D f64 | 3D f32 | 4D f64 (CMYK) | 4D f32 (CMYK) |
|---|---|---|---|---|
| 17 | 19.6 KB | 9.8 KB | 334 KB | 167 KB |
| 25 | 62.5 KB | 31 KB  | 1.6 MB  | 781 KB |
| 33 | 143 KB  | 72 KB  | 9.5 MB  | 4.7 MB |
| 49 | 470 KB  | 235 KB | 24 MB   | 12 MB  |
| 65 | 1.1 MB  | 550 KB | 143 MB  | 71 MB  |

**TODO — bench work before shipping:** measure the actual accuracy
/ speed curve so we can recommend sensible upper bounds:

1. Add a `bench/lutGridSweep.js` that builds the same profile at
   grid sizes {17, 25, 33, 49, 65, 97, 129} for 3D, {17, 21, 25,
   33} for 4D, and measures:
   - ΔE₀₀ RMS and max against the f64 non-LUT pipeline as ground
     truth, across a gamut sweep (IT8.7/4 target + L*a*b* stratified
     grid)
   - MPx/s throughput for each kernel family (JS int, JS float,
     WASM scalar, WASM SIMD)
   - L1 / L2 / L3 cache pressure — at what grid size does the
     tetrahedral loop start missing L2?
2. Find the **accuracy knee** (grid at which doubling size halves
   ΔE by less than a round-off) for 3D and 4D separately.
3. Find the **cache knee** (grid at which throughput drops ≥ 15 %
   as LUT spills L2) for each kernel. Different for CMYK (3D per
   K-plane) vs RGB.
4. Document the sweet spots in Performance.md §7 — likely 33³ for
   3D and 21⁴ or 25⁴ for 4D, but let the numbers decide.

**API shape:** just `lutGridSize: 17 | 25 | 33 | 49 | 65` at
`Transform.create()` time. Default `undefined` = use the profile's
native `clutPoints`. Upper bound enforced (we refuse 65⁴ because
it's 143 MB and breaks everything), with a clear error.

**Expected win:** at 33³ vs 17³ on a GRACoL profile we should see
ΔE₀₀ max drop from ~0.4 to ~0.1 in the saturation corners, for
zero per-pixel cost — the LUT is built once, evaluated the same
way. Free accuracy for anyone willing to pay 123 extra KB.

### Custom LUT callbacks — `lutInputHook` / `lutOutputHook`

Sometimes you don't want a vanilla profile-to-profile transform —
you want to **warp** the colour space on the way in, on the way out,
or both. Examples:

- **Saturation boost.** Before each sample hits the profile
  transform, bump chroma by 15 %. The resulting LUT bakes that boost
  into every cell; at runtime the kernel just does its usual
  tetrahedral interp — zero per-pixel cost for the boost.
- **Channel swap / rotation.** Build a LUT that maps R↔B, or rotates
  hue by 30°. Useful for split-toning, creative colour grading, or
  testing channel-order bugs.
- **Synthetic LUTs from scratch.** Start with an identity grid (each
  cell's output = its input), then warp it with a user-defined
  function — no ICC profile involved at all. The kernel doesn't care
  where the LUT came from; it just interpolates.
- **Debug logging.** Dump every `(inputRGB, outputCMYK)` pair to a
  file during build so you can visualise the gamut mapping or diff
  against an external reference.

#### API shape

Two optional callbacks on `Transform.create()`:

```js
const xf = Transform.create({
    inputProfile:  sRGB,
    outputProfile: GRACoL,
    buildLut:      true,

    // Called for every grid sample BEFORE the profile transform.
    // Receives device-space input [0–1]; returns (possibly modified)
    // device-space input [0–1]. Return the same array to pass through.
    lutInputHook: (rgb) => {
        // Example: boost saturation in Lab before the transform
        const lab = convert.rgb2lab(rgb, sRGB);
        lab[1] *= 1.15;  // +15% a*
        lab[2] *= 1.15;  // +15% b*
        return convert.lab2rgb(lab, sRGB);
    },

    // Called for every grid sample AFTER the profile transform.
    // Receives device-space output [0–1]; returns (possibly modified)
    // device-space output [0–1].
    lutOutputHook: (cmyk) => {
        // Example: clamp black channel to 80% max
        cmyk[3] = Math.min(cmyk[3], 0.80);
        return cmyk;
    },
});
```

Either hook can be omitted. Both receive and return plain `[c0, c1,
c2, ...]` arrays in device-space [0–1] (not bytes, not Lab unless
you convert yourself). The hooks run **only during LUT build** —
once per grid cell, not once per pixel at transform time. A 17³
grid calls each hook 4913 times; a 33³ grid calls each 35 937 times.
Build cost goes up by the hook's complexity; transform cost is
unchanged.

#### Use cases in more detail

| Use case | Hook | What it does |
|----------|------|--------------|
| Saturation boost | `lutInputHook` | Convert input RGB → Lab, scale a\*/b\*, convert back. |
| Black-limit | `lutOutputHook` | Clamp K channel to a max (e.g. 80 %). |
| Channel swap | `lutOutputHook` | `[c,m,y,k] => [c,y,m,k]` — swap M and Y. |
| Hue rotation | `lutInputHook` | Convert to LCh, add 30° to h, convert back. |
| Identity + warp | both | `inputProfile = outputProfile = sRGB`, hooks do all the work. |
| Debug dump | either | `console.log(input, output)` or write to a file; return unchanged. |
| Synthetic LUT | both | No profile at all — caller supplies `lutInputHook` that *is* the transform function, `lutOutputHook` returns identity. |

For the "synthetic LUT from scratch" case, we may also want a
`Transform.createFromHook({ inputChannels, outputChannels, hook })`
factory that skips profiles entirely and just builds a LUT from the
hook. That's a follow-on convenience; the core hooks above are the
building block.

#### Why build-time only

The hooks run during `buildLut()`, not during `transformArray()`.
That's the whole point — the warp is **baked into the LUT cells** so
the per-pixel kernel stays fast. If you need a per-pixel hook
(dynamic colour grading that changes every frame, say), that's a
different feature (and a much more expensive one — the kernel would
have to call out to JS on every pixel, breaking the WASM hot path).
Build-time hooks keep the fast path fast.

#### Effort and rationale

**Effort.** Small. The LUT build loop already iterates over every
grid cell and calls the profile transform; the hooks are two
optional function calls bracketing that existing call. The only
subtlety is ensuring the hooks receive / return the right colour
space (device [0–1], not Lab, not bytes) so they compose cleanly
with both RGB-input and CMYK-input profiles.

**Why on the roadmap rather than shipped now.** The feature is
simple but the API shape wants a bit of thought (should hooks
receive Lab instead of device? should there be a `lutPcsHook` that
runs in PCS space between the two profile legs?). Parking it in v1.5
alongside `lutGridSize` keeps LUT-build options grouped; both can
ship together with a unified "LUT build options" section in the
Transform docs.

### Lab ↔ int16 helpers (`convert.lab2Int16` / `convert.int162Lab`)

The v1.3 16-bit kernel ladder (`int16` / `int16-wasm-scalar` /
`int16-wasm-simd`) shipped with fast u16 LUT paths for the common
RGB / CMYK workflows, but the **Lab side** of those paths still
expects the caller to know the ICC PCS encoding to round-trip a u16
buffer through `*Lab` / `*LabD50` / a Lab-PCS profile.

#### Why the encoding question is non-trivial

ICC v2 and ICC v4 use *different* u16 Lab encodings, and the engine
already distinguishes them internally via `stage_LabD50_to_PCSv2` /
`stage_LabD50_to_PCSv4` (and their inverses) in
[`src/Transform.js`](../src/Transform.js):

| Encoding         | L → u16                | a → u16                  | Notes |
|------------------|------------------------|--------------------------|-------|
| **v2 (legacy)**  | `L * 65280 / 100`      | `(a + 128) * 65280 / 256` | `L=100` ⇒ `0xFF00`, `a=0` ⇒ `0x8080` |
| **v4**           | `L * 65535 / 100`      | `(a + 128) * 65535 / 257` | `L=100` ⇒ `0xFFFF`, `a=0` ⇒ `0x8080` |

Round-tripping a u16 buffer through the *wrong* encoding gives a
silent ~0.4 % drift, not a hard error — so whatever API ships has
to make the encoding choice unambiguous on every call.

#### Preferred design — store the scaling constants as data on the LUT

Three approaches considered, in increasing order of preference:

**1. Re-normalise the LUT to one canonical encoding.** Rejected.
v1.3's u16 LUTs are scaled for the kernel's Q0.13 weight contract,
not the ICC PCS spec — re-baking them to a single "canonical" Lab
encoding would either lose precision or duplicate the LUT, and is
asymmetric between input and output sides anyway.

**2. Attach the encoder/decoder as a method on the LUT.**
Considered: `xform.lut.toLab(device)` and `xform.lut.fromLab(lab)`
are ergonomic and the LUT carries the truth. **Rejected because
of portability and serialisation costs**:

- `JSON.stringify(xform.lut)` silently drops methods. A LUT
  serialised for cache / IndexedDB / disk loses its encoder, and
  the deserialised LUT looks fine but `toLab()` is undefined.
- `structuredClone()` and the worker-postMessage boundary refuse
  functions outright (`DataCloneError`). A LUT can't cross from
  the main thread to a worker as data, which is exactly what the
  v1.3 throughput story wants enabled.
- Mixing data and behaviour on the same object means every
  consumer (samples, downstream tools, custom pipelines) needs a
  live `Transform` instance to access the encoders. Pure-data
  consumers can't.

**3. Store the scaling values numerically on the LUT.** Preferred.
The helpers read **plain numbers** off the LUT and do the math
inline — no function dispatch, no version branch in the hot loop,
fully JSON-serialisable, fully `structuredClone`-able, fully
worker-portable.

```js
// At Transform.create() / buildLut() time, populate from the profiles.
// Both sides recorded independently so soft-proof / device-link
// transforms (where the input and output Lab encoding can legally
// differ) Just Work.
//
// pcsVersion     = ICC profile version (2 | 4) — kept alongside the
//                  numeric constants so a serialised LUT JSON is
//                  human-readable on the file. Encoders/decoders
//                  still use the numeric fields below; pcsVersion
//                  is metadata for humans and tools, not the hot loop.
// labNumerator   = u16 raw at L=100  (v4: 65535, v2: 65280)
// abDenominator  = (a+128)-divisor   (v4:   255, v2:   256)
// L denominator is implicit (100); aOffset is implicit (128).

xform.lut.inLab  = inputProfile.pcs  === 'LAB'
    ? { pcsVersion:    inputProfile.version,
        labNumerator:  inputProfile.version  === 4 ? 65535 : 65280,
        abDenominator: inputProfile.version  === 4 ?   255 :   256 }
    : null;

xform.lut.outLab = outputProfile.pcs === 'LAB'
    ? { pcsVersion:    outputProfile.version,
        labNumerator:  outputProfile.version === 4 ? 65535 : 65280,
        abDenominator: outputProfile.version === 4 ?   255 :   256 }
    : null;
```

A serialised LUT then carries a self-describing block that's
obvious at a glance:

```json
"inLab":  { "pcsVersion": 4, "labNumerator": 65535, "abDenominator": 255 },
"outLab": { "pcsVersion": 2, "labNumerator": 65280, "abDenominator": 256 }
```

You can read a cached LUT off disk and immediately tell which
profile encoding it was built against, without having to back-
solve from the numerator/denominator pair.

The helpers then read the numbers and do the math directly — no
`switch (version)`, no method-table indirection. They take the
**encoding sub-object** (typically `lut.inLab` or `lut.outLab`)
rather than the full LUT, so there's no in / out ambiguity at the
lower layer — the caller picks the side and passes the
corresponding tuple:

```js
// Single colour — caller passes the encoding it wants, helper does the multiply.
function lab2Int16(L, a, b, encoding) {
    const N = encoding.labNumerator;
    const D = encoding.abDenominator;
    return [
        Math.round(L * N / 100),
        Math.round((a + 128) * N / D),
        Math.round((b + 128) * N / D)
    ];
}

// Caller picks the side — same helper, different sub-object:
const u16In  = convert.lab2Int16(L, a, b, xform.lut.inLab);   // input-side encode
const u16Out = convert.lab2Int16(L, a, b, xform.lut.outLab);  // output-side encode
```

`N / 100` and `N / D` can be pre-computed once at LUT-build time
and stored as `lMul` / `abMul` (and their reciprocals as
`lInvMul` / `abInvMul` for the decode side) so the inner loop
becomes a single multiply per channel — no division in the hot
path. That's where the "faster and no lookup" win lands.

**Bulk array helpers are intentionally not shipped.** A tight
typed-array loop over the same scalar arithmetic is straight-line
code and pays back more when *the developer* writes it for their
exact buffer layout (interleaved vs planar, RGBA vs Lab-only, in-
place vs new-allocation). Shipping `labArray2Int16Array` /
`int16Array2LabArray` plus their input / output variants would be
four more methods on the public surface for a use case where the
caller already knows their best loop shape. The four scalar
`transform.*` methods below are still useful as a ground-truth
oracle — call `transform.outputInt162Lab(u[0], u[1], u[2])` once
on a known sample to verify the inline loop produces the same
floats.

The same shape extends to **any encoding we'd ever care about**,
not just v2 / v4: native u16 with a clamped L axis, custom
high-precision device-link encodings, the eventual `int20` /
`int24` paths if those land, even XYZ PCS — every encoding is
just a different `(labNumerator, abDenominator, lOffset, aOffset)`
tuple parked on the LUT. The helper code never branches; the
numbers do all the work.

For low-level callers who genuinely don't have a LUT in scope
(custom pipelines, off-engine tooling, tests), keep an
explicit-numbers overload as an escape hatch:

```js
const u16 = convert.lab2Int16(L, a, b, { labNumerator: 65535, abDenominator: 255 });
const u16 = convert.lab2Int16(L, a, b, 'v4');   // shorthand → resolves to the tuple above
const u16 = convert.lab2Int16(L, a, b, 'v2');   // shorthand → 65280 / 256
```

#### Transform-level wrappers — the ergonomic top of the API

`convert.*` is the load-bearing primitive (portable, low-level,
takes an encoding sub-object or explicit tuple). For the common
case where the caller already has a `Transform` and wants to
encode / decode against either side without thinking about it,
ship four explicit wrappers on the Transform class — one per
direction × side:

```js
// Wrappers — pure forwarders, no defaults, no inferred sides.
// Each method names its side explicitly, so the call site reads
// like a sentence: "encode Lab to int16 for the *input* side".
xform.inputLab2Int16   = function(L, a, b)    { return convert.lab2Int16(L, a, b,    this.lut.inLab);  };
xform.outputLab2Int16  = function(L, a, b)    { return convert.lab2Int16(L, a, b,    this.lut.outLab); };
xform.inputInt162Lab   = function(uL, ua, ub) { return convert.int162Lab(uL, ua, ub, this.lut.inLab);  };
xform.outputInt162Lab  = function(uL, ua, ub) { return convert.int162Lab(uL, ua, ub, this.lut.outLab); };
```

Why four explicit methods rather than a defaulting pair:

- **Soft-proof and device-link transforms can have different Lab
  encodings on each side.** A v2-input → v4-output device-link is
  perfectly legal; an unprefixed `xform.lab2Int16` would have to
  pick a "default" side and silently do the wrong thing on the
  other one. Four explicit methods make the side a property of the
  call, not of the library's defaulting policy.
- **The IDE tells the story.** Typing `xform.` in a modern editor
  surfaces all four methods grouped together; the prefixes
  (`input` / `output`) read out loud, so the caller doesn't have
  to remember which way the unprefixed default went.
- **No defaulting policy to document.** The previous design had a
  "encode reads `inLab`, decode reads `outLab`" rule that you'd
  have to look up every time you used it. Four explicit methods
  remove that lookup entirely.

Why both layers ship:

- **`convert.*` is what survives serialisation.** A LUT (or just
  its `inLab` / `outLab` sub-object) cached to IndexedDB / disk /
  a worker still works, because the helper just reads numeric
  properties off the (re-hydrated) data.
- **`Transform.*` is what's discoverable.** A user who's already
  written `xform.transform(...)` will type `xform.` in their IDE
  and see `inputLab2Int16` / `outputLab2Int16` /
  `inputInt162Lab` / `outputInt162Lab` right alongside the
  transform methods. They never need to learn about `convert.*` or
  `xform.lut.inLab` shapes unless they hit the portable case.
- **Hot path is the same on both.** Method dispatch on a
  monomorphic call site lowers to the same machine code as a
  direct `convert.*` call; the wrapper has zero runtime cost.

Why this shape, summarised:

- **Pure data, no functions.** `JSON.stringify`, `structuredClone`,
  `postMessage` to a worker all work without losing the encoder.
  A LUT cached to IndexedDB and re-loaded a session later still
  knows how to decode itself.
- **Faster than a version switch.** The helper compiles to a
  straight-line multiply — V8 sees stable numeric properties on
  a LUT object that doesn't change shape, and inlines the loads.
  No `if (v2) ... else ...` branch in the inner loop.
- **Caller can't pass the wrong encoding.** The LUT carries the
  truth; the helper just reads numbers off it. Wiring a Lab
  buffer into a v2-profile transform produces v2-encoded u16,
  and the same call against a v4 profile produces v4-encoded
  u16, with no code change at the call site.
- **Symmetric for input vs output sides, no defaulting.** The
  Transform layer ships all four explicit methods
  (`inputLab2Int16`, `outputLab2Int16`, `inputInt162Lab`,
  `outputInt162Lab`); the convert layer takes the encoding
  sub-object directly. Soft-proof and device-link transforms —
  where the source and destination Lab encoding can legally
  differ — do the right thing because the caller (or wrapper)
  names which side it means at the call site, not via a default
  buried in the docs.
- **Future-extensible.** Adding a new encoding (whether a
  hypothetical ICC v5, a custom internal one, or a non-Lab PCS)
  is a numeric-tuple change, not a code change.
- **Cheap to implement.** The encoding constants already live in
  `stage_LabD50_to_PCSv4` / `stage_LabD50_to_PCSv2` (and
  inverses); the helpers lift those constants into `convert.*`,
  read them off the encoding sub-object, and the four `Transform`
  wrappers are five-line forwarders. Two scalar `convert.*`
  functions, four scalar `Transform.*` wrappers, no bulk-array
  surface — the whole feature is a couple of hundred lines plus
  tests.

#### Open API questions (decide before shipping)

1. **Property names on the LUT.** Working names above are
   `lut.inLab.{ pcsVersion, labNumerator, abDenominator }` (and
   `lut.outLab.*` for the inverse). Variations worth bikeshedding:
   - `lut.inLab` vs `lut.labEncodeIn` vs `lut.labIn` — short or
     verb-y or symmetric-with-`outLab`?
   - Pre-computed multipliers (`lMul`, `abMul`, `lInvMul`,
     `abInvMul`) vs raw numerator/denominator pairs vs both? Both
     is cheap (4 extra Number slots), keeps `pcsVersion` as the
     human-readable label, the numerator/denominator as the
     mathematical truth, and the multipliers as the hot-loop
     fast path. Consumers that only care about one (humans,
     readers, hot-loop kernels) read what they need.
2. **What does `convert.*` accept?** Working answer: an encoding
   sub-object (`lut.inLab` / `lut.outLab` shape — `{ pcsVersion,
   labNumerator, abDenominator, lMul?, abMul?, lInvMul?,
   abInvMul? }`) or a string shorthand (`'v2'` / `'v4'`) or an
   explicit numeric tuple. *Not* the full LUT — keeping the side
   selection out of `convert.*` is what makes the four explicit
   `Transform.*` wrappers feel right (each one passes its specific
   sub-object). A `Profile`-aware overload is a straight follow-on
   if it turns out callers want to skip the Transform entirely; one
   `typeof` check at the helper entry covers it.
3. **What happens when the metadata is missing?** A Transform
   built from a non-Lab profile pair has `lut.inLab = null` /
   `lut.outLab = null`. Calling
   `xform.inputLab2Int16(...)` (or the equivalent `convert.*`
   call with a `null` encoding) against one of those should throw
   with a clear "this Transform's input PCS isn't Lab — call this
   on a Lab-PCS Transform, or use `convert.lab2Int16` with an
   explicit encoding tuple" error, not silently default to v4.
4. **Bulk array helpers — explicitly out of scope.** No
   `labArray2Int16Array` / `int16Array2LabArray` (and no
   per-side variants). The math is straight-line; developers who
   want bulk performance can write a tight typed-array loop
   tuned for their buffer layout, and use
   `transform.outputInt162Lab` (etc.) as a scalar oracle to
   validate it. Four scalar Transform methods + two `convert.*`
   primitives is the entire surface.
5. **Where they live** — `src/convert.js` (engine-level, exported
   on the public `convert` namespace). Engine-level is the right
   home — these are encoding primitives, not sample plumbing. The
   four Transform wrappers live on the existing `Transform` class
   prototype.

#### Effort and rationale

**Effort.** Small. The encoding constants already live in
`stage_LabD50_to_PCSv4` / `stage_LabD50_to_PCSv2` /
`stage_PCSv4_to_LabD50` / `stage_PCSv2_to_LabD50`; the helpers lift
those constants into `convert.*` (two scalar functions —
`lab2Int16` and `int162Lab`), add four scalar wrappers on the
`Transform` prototype, and ship tests against the existing oracle
(Lab round-trip through both encodings, bit-exact within
rounding). The `lut.inLab` / `lut.outLab` numeric tuples
(`pcsVersion`, `labNumerator`, `abDenominator`, plus pre-computed
multipliers) are a one-step addition at Transform-build time,
populated from `inputProfile.version` / `outputProfile.version`.
No bulk-array surface to test, document, or maintain.

**Why on the roadmap rather than shipped now.** The 16-bit LUT path
itself is fully usable through profile transforms (Lab profiles
just-work via the staged pipeline); these helpers are a
convenience for callers who want to *bypass* the Transform and
hand-feed u16 Lab buffers. That's a v1.5-class polish item, not a
correctness gap. The LUT-bound design above is what we'd ship if
this becomes a real-world need; the standalone-version overload is
the escape hatch for the few callers who legitimately don't have a
LUT in scope.

### `lcms_patch/` extraction (v1.3 follow-up)

The lcms-compat harness shipped as part of v1.3 (see
[Accuracy.md](./deepdive/Accuracy.md) — `bench/lcms_compat/run.js`
+ `probe-pixel.js`, both live and frozen against a 150-file
reference oracle). The one piece left open is **distilling the
instrumented lcms 2.16 tree** at `bench/lcms_exposed/` into a
regen-able patch:

1. `bench/lcms_compat/lcms_patch/01-stage-prints.patch` against
   stock lcms 2.16 (the per-stage `EvaluateCurves` /
   `EvaluateMatrix` / `EvaluateCLUT` / `EvaluateXYZ2Lab` printfs
   that `probe-pixel.js` consumes).
2. `bench/lcms_compat/lcms_patch/02-transicc4batch.patch` for the
   batch-mode `.it8` I/O variant of `transicc` used to regenerate
   the reference oracle.
3. `fetch-lcms2-instrumented.sh` / `.ps1` that downloads stock
   lcms from the GitHub release and applies the patches (same
   pattern as `bench/lcms_c/`).
4. Delete the `bench/lcms_exposed/` vendored tree once the patches
   round-trip byte-identically.

Pure janitorial work — the harness already passes against the
patched binary that's vendored in the repo. The patch extraction
just removes the "you need our vendored lcms tree on disk" step
for contributors who want to regenerate the oracle from scratch
against a future lcms release.

### Dependency hygiene — Dependabot triage + devDependency bumps

After the v1.4.1 push, GitHub Dependabot reports **32 open alerts**
(10 high, 14 medium, 8 low) on the default branch. Worth knowing
upfront:

- **All 32 are in `devDependencies`.** Zero alerts in the runtime
  surface. The npm tarball excludes `node_modules/`, the engine
  itself ships only `src/` + the built `dist/` browser bundles, and
  none of the engine's own production code touches any of the
  flagged transitive packages.
- **Most cluster around the webpack 5.89 / webpack-dev-server 4.15 /
  webpack-cli 4.10 toolchain.** That single chain pulls in
  `node-forge` (4 high), `serialize-javascript` (1 high + 2 med),
  `body-parser`, `express`, `send`, `serve-static`, `cookie`,
  `on-headers`, `http-proxy-middleware`, `ws`, `qs`,
  `follow-redirects`, `webpack-dev-middleware` — all flagged via
  the dev-server / build-time path.
- **A second smaller cluster comes from jest's `micromatch` chain**
  — `minimatch` (1 high ReDoS), `braces` (1 high), `picomatch` (1
  med). Resolves with a `package-lock.json` regeneration in most
  cases without bumping jest itself.
- **Risk profile is contributor-machine only.** A clone-and-build
  on an untrusted network could in theory expose a contributor to
  the dev-server SSRF / path-traversal / template-injection alerts;
  end users running the published browser bundle from
  o2creative.co.nz, a CDN, or `npm install jscolorengine` are not
  exposed.

#### Bump plan

| Package              | Current  | Target   | Why                                           |
|----------------------|----------|----------|-----------------------------------------------|
| `webpack`            | ^5.89.0  | ^5.x current | Clears `AutoPublicPathRuntimeModule` XSS, `buildHttp` SSRF (×2), `serialize-javascript` chain |
| `webpack-cli`        | ^4.10.0  | ^5.x     | Required pairing for `webpack` 5 latest; v4 is unmaintained |
| `webpack-dev-server` | ^4.15.1  | ^5.x     | Single biggest alert clearer — closes the entire `node-forge` / `express` / `body-parser` / `cookie` / `on-headers` / `http-proxy-middleware` / `ws` cascade |
| `webpack-merge`      | ^5.10.0  | ^6.x     | Housekeeping; no breaking change for our two configs |
| `jest`               | ^29.7.0  | ^29.7 (lockfile refresh) or ^30.x | `package-lock.json` regen typically lifts `minimatch` / `braces` / `picomatch` to fixed versions without a major bump |
| `adm-zip`            | ^0.5.10  | ^0.5 latest | Used only by the bench / sample tooling; no alerts but worth refreshing alongside |
| `wabt`               | ^1.0.39  | unchanged | No alerts; pinned for WASM-emit reproducibility |

`webpack-cli` 4 → 5 is the only bump with a real chance of CLI
flag changes — the 5 line aligns with `webpack` 5 latest and the
current `webpack-dev-server` 5 line. The two webpack configs in
this repo (`webpack.config.js` + `speed_tests/tests.webpack.config.js`)
use the standard `mode` / `entry` / `output` / `module.rules`
shape so the bump should be cosmetic.

#### Acceptance criteria

1. **`npm test` — 210 / 210 across 19 suites.** Same suite that's
   passing on `1.4.1`. Any test failure blocks the bump.
2. **`npm run build`** produces the browser bundles. Webpack 5
   latest may reshuffle module IDs (precedent: commit `ea2fb3e`,
   *"Rebuild browser bundles (webpack module-id reshuffle from
   npm publish)"*); a one-off "Rebuild browser bundles" commit
   is acceptable, but the bundle output must round-trip the
   existing transform tests.
3. **Smoke-test the sample pages** end-to-end via
   `node samples/serve.js`:
   - `samples/index.html` — landing page navigation works.
   - `samples/softproof.html` — image proof + plate previews
     render, colour picker reads pixel values.
   - `samples/softproof-vs-lcms.html` — both engines load, diff
     panel updates with the slider, speed stats populate.
   - `samples/live-video-softproof.html` — video sample plays,
     soft-proof overlay updates frame-by-frame at 40+ fps.
   - `samples/bench/index.html` — engine-info panel green for
     both jsCE and lcms-wasm, all kernels post a result, charts
     render, no console errors.
4. **All Dependabot alerts close** (or are explicitly dismissed
   with a documented reason — *"transitive dev-only, no fix
   upstream, mitigated by [X]"*). Target: zero open alerts on
   the v1.5 release branch.
5. **No runtime surface changes.** The engine's `src/` tree must
   not pick up any new direct dependencies; the bumps are
   `devDependencies`-only.

#### Effort and rationale

**Effort.** Half a day. Bump the `package.json` numbers, run
`npm install` to regenerate `package-lock.json`, run the full
test suite, run the build, smoke the samples, push, watch
Dependabot reconcile. The webpack-cli 4 → 5 bump is the only
substantive change — the rest is lockfile churn.

**Why on the roadmap rather than shipped now.** v1.4.1 was
expressly a soft-proof correctness fix; bundling a toolchain bump
into the same release would have widened the diff and the test
matrix at exactly the moment we wanted a tight, reviewable
patch. v1.5 is the natural home — the alert count is high but
the *exposure* is low (dev-machine only, dev-only deps, nothing
in the published tarball or the browser bundle), so it doesn't
warrant a 1.4.2 patch ahead of the v1.5 work that's already
queued.

**Why we're not pinning to specific minor versions.** The
`package.json` already uses `^` ranges for everything; the bump
plan above is "set the floor at the current latest 5.x and let
npm resolve from there". Re-pinning would just make the next
Dependabot wave noisier.

### Pipeline validation — `validateOnCreate` option

A simple guard that catches "profile loaded OK but pipeline is
broken" scenarios before the caller's first `transform()` or
`transformArray()` call.

**The problem.** A profile can load successfully (`.loaded = true`,
no exception) but still produce a Transform that fails on first use:

- A matrix with a `NaN` element (corrupt profile, decoder bug).
- A curve that returns `undefined` for some inputs.
- A CLUT with missing entries.
- A custom pipeline stage that throws on certain PCS values.

Today the failure surfaces inside `transform()` or `transformArray()`
— possibly deep in production, possibly on the millionth pixel. The
caller has to wrap every transform call in `try/catch`, which is
tedious and doesn't help with debugging ("which profile? which
stage?").

**The fix.** After `create()` / `createMultiStage()` finishes
building the pipeline, run a **single-pixel smoke test** through the
full pipeline in a `try/catch`. If it throws, `create()` throws with
a clear message ("pipeline validation failed: NaN in matrix stage")
instead of returning a Transform that will fail later.

```js
const xf = new Transform({ validateOnCreate: true });
try {
    xf.create(inputProfile, outputProfile, intent);
} catch (err) {
    // err.message includes which stage failed
    console.error('Pipeline broken:', err.message);
}
// If we get here, transform() and transformArray() are safe.
```

**Implementation.** At the end of `create()` / `createMultiStage()`:

1. Pick a neutral test colour (mid-grey in device space, or D50 in
   PCS — something unlikely to hit edge cases).
2. Call `this.transform(testColour)` inside a `try/catch`.
3. Check the result for `NaN` / `undefined` / out-of-range values.
4. If anything is wrong, throw with context ("stage 2 (matrix)
   returned NaN for input [0.5, 0.5, 0.5]").

Cost is ~1 µs per `create()` — negligible compared to the LUT build
(50–100 ms) or even the profile decode (~5 ms). Opt-in via
`validateOnCreate: true` so existing code isn't affected; could
become the default in a future major version once battle-tested.

**Why this is valuable.** Once `create()` succeeds with validation
enabled, the caller **knows** that `transform()` and
`transformArray()` will not throw on well-formed input. The only
remaining failure mode is caller error (wrong array length, wrong
channel count) — and those are caught by existing guards. This
closes the "profile loaded but pipeline broken" gap that v1.7's
full profile hardening would also address, but with a fraction of
the effort.

**Effort.** Small — a few hours. The test-colour call is one line;
the result check is a dozen lines; the error formatting is another
dozen. Most of the work is deciding what "neutral test colour"
means for each colour-space type (RGB, CMYK, Lab, XYZ, n-channel).

### Compiled non-LUT pipeline + `toModule()` (v1.5 centrepiece)

The N-channel float and `lutGridSize` items above are the smaller
v1.5 wins. The remainder of v1.5 is the larger compiled-pipeline +
`toModule()` work — originally scoped as the only v1.5 item before
the v1.3 close-out reshuffled the queue. Same plan as before, same
acceptance criteria.

> **Scope reframe (Apr 2026, post-POC).** v1.5 was originally "WASM
> SIMD for matrix-shaper transforms", then broadened to "code
> generation for non-LUT pipelines + smarter `'auto'`". The
> [POC results](./deepdive/CompiledPipeline.md) flipped the
> priority order:
>
> - The **JS-emit path is already enough** for the accuracy tier:
>   ~5× over the runtime walker on sRGB→CMYK, bit-exact, no WASM
>   needed. The bottleneck is `Math.pow`, which WASM doesn't make
>   materially faster (the LUT does).
> - The **`toModule()` distribution story** turned out to be the
>   marquee feature — a unique capability nothing else in the JS
>   colour-management space offers. ~50–80 KB standalone, dep-free,
>   bit-exact transform modules from any source/dest profile pair.
> - The **WASM emit target is deferred to v1.5+**. Worth keeping on
>   the radar (the 1D POC ceiling stands), but the dev complexity
>   no longer pays back for the workload that actually benefits.
>
> Headline order is now: (1) finish stage-emitter coverage,
> (2) ship `getSource()` / `toModule()`, (3) document the
> coverage matrix, (4) stay opt-in (do NOT auto-route in
> `'auto'` yet — LUT modes remain the default for bulk image
> work). See
> [deepdive/CompiledPipeline.md § Should we ship this](./deepdive/CompiledPipeline.md#should-we-ship-this-as-default--honest-assessment)
> for the full reasoning.

### Non-LUT pipeline code generation (`new Function` + emitted WASM)

**The target.** jsColorEngine's non-LUT accuracy path is a pipeline
of stages — tone curve, matrix, white-point adaptation, gamma, RGB-
to-XYZ, XYZ-to-Lab, perceptual intent table, etc. — glued together
by `createPipeline()`. Today each stage is a general-purpose
function called per-pixel, with runtime option checks for
`clipRGBinPipeline`, BPC on/off, adaptation mode, etc. The pipeline
is specialised to a specific profile chain at `create()` time but
its implementation is not. Every per-pixel option check, every
method dispatch, every array wrapper stays in the hot loop.

**The idea.** At `create()` time, after the optimiser has folded
the stage list for this specific profile chain, emit a single
hot-loop function — either as JS string `new Function(src)` (TurboFan
path) or as `.wat` assembled with `WebAssembly.Module` (WASM path) —
that contains exactly the instructions this profile chain needs, no
more. Option checks resolve to constants at emit time; stage
dispatch resolves to inlined straight-line code; typed-array access
resolves to contiguous reads. The whole per-pixel body becomes what
the optimiser would have produced if it had all the information we
do — which, spoiler, it doesn't, because most of the relevant bits
live on `this`.

**Why now.** Three things changed.

1. **We have the WASM pipeline end-to-end.** v1.2 gives us `.wat`
   authoring, a loader, a dispatcher, a benchmark rig, a test pattern
   (dispatch-counter-gated bit-exactness). Adding "emit `.wat` from
   a stage list instead of reading it from disk" is incremental.
2. **The 1D POC gave us the ceiling.** 67.7× over JS plain for
   SIMD-friendly math without LUT gather. Matrix-shaper sits under
   that ceiling. Our best un-specialised pipeline today is ~5 MPx/s
   on the no-LUT path; the theoretical ceiling suggests
   200-300 MPx/s is on the table.
3. **TurboFan is excellent at emitted JS** if the emitter doesn't
   do anything stupid. `new Function('...source...')` output with
   monomorphic types, no closure captures, no `this` reads inside
   the loop — TurboFan-tier-1 will inline everything. This is the
   escape hatch for hosts without WASM SIMD: emit JS and let
   TurboFan do the work.

**Strategy, in order.**

1. **Characterise the target.** Bench the current non-LUT pipeline
   for 3-4 representative shapes (sRGB→AdobeRGB matrix-shaper,
   sRGB→Lab via XYZ, Lab→Lab with adaptation). Find where the
   time goes — stage-call overhead, math, array access, option
   checks. This tells us the emission target.
2. **Emit JS first.** `new Function()` with straight-line
   per-pixel body. No WASM yet. Measure against the current
   non-LUT pipeline. If TurboFan tier-1 hits the expected 2-5×
   just from inlining + dead-option-check elimination, publish
   `lutMode: 'fast-jit'` (or similar) and call it a v1.5 preview.
3. **Emit WASM for the same stage list.** Same shape, same
   contract, different backend. SIMD where the stage allows
   (matrix ops, gamma polynomial approximations). Measure against
   the JS emission. Expected 2-3× further on top of the JS
   emission for SIMD-friendly chains.
4. **Route through `'auto'`.** Non-LUT Transforms auto-pick
   emitted-WASM > emitted-JS > current-no-LUT-path. LUT
   Transforms keep the v1.2 auto path (WASM-SIMD > WASM-scalar
   > int > float). One Transform, one best kernel, automatically.

**Architecture details** — each pipeline stage adds an `.emit(ctx)`
companion to its existing `.funct`. Stages emit **statement lists,
not expressions** — they assume their input variables are already
set and write into their output variables. No returns, no composition,
no threading — just sequential assignment into well-known names.

```js
pipeline[s] = {
    funct:     existingRuntimeFn,   // unchanged — fallback / CSP-safe path
    stageData: {...},               // unchanged
    inputs:    ['L', 'a', 'b'],     // NEW — names this stage reads
    outputs:   ['X', 'Y', 'Z'],     // NEW — names this stage writes
    emit:      function(ctx) { ... }// NEW — returns a block of JS statements
};
```

**Variable naming** — semantic, not numeric. Lab → `L, a, b`;
XYZ → `X, Y, Z`; PCS Lab → `pcsL, pcsa, pcsb`; device channels →
`d0 .. dN`. A **single top `var` block** declares every possible
channel name up front, so V8 sees full scope at once and dead-stores
unused slots. In-place stages (Bradford adapt, Lab→Lab) emit
stage-internal temps (`tX, tY, tZ`) so assignment order doesn't
corrupt the transform — stage-author concern, not orchestrator.

```js
function transform_srgb_to_gracol(r_in, g_in, b_in) {
    var r, g, b;               // decoded device RGB
    var X, Y, Z;               // PCS XYZ
    var pcsL, pcsa, pcsb;      // PCS Lab
    var d0, d1, d2, d3;        // output CMYK
    var tX, tY, tZ;            // transient temps for in-place ops
    // ... stage blocks ...
    return [d0, d1, d2, d3];   // final stage emits the return shape
}
```

**Pipeline validation** — at codegen time the orchestrator walks the
stages and verifies `pipeline[N].outputs === pipeline[N+1].inputs`
(by name, not just by count). Wiring Lab into an XYZ-consuming
stage throws a useful error at pipeline-build time instead of
producing silent garbage colour at runtime. This is the "cross-
boundary detection" we've been circling — it falls out naturally
once every stage declares its shape.

**Dead-code elimination at emit time** — only possible when you can
see the whole pipeline at once:

- identity curves (`Math.pow(x, 1.0)`): `.emit()` returns `""` and
  maps its output name straight to its input → zero instructions
- adjacent matrix + inverse (constant in RGB→PCS→RGB round-trips):
  detect at codegen time, collapse to identity, emit nothing
- absolute-intent matrix scales that simplify to 1.0 after adaptation
- single-axis clamps adjacent to curves that bottom at 0 anyway

The runtime pipeline can't do any of this — it just runs every
stage. Codegen sees the graph, so it can prune.

**Don't do peephole optimisation on the emitted source.** Tempting
to regex patterns like `X = f; r = X + 3` → `r = f + 3`, but V8's
TurboFan already does copy propagation / forwarding at the IR level
before emitting machine code. Source-level peephole would be doing
work V8 throws away, and regex on JS source is a minefield (string
literals, ASI, re-assignment, nested scopes). **The trust boundary**:
we own "what code gets emitted" (no arrays, no dispatch, literals
baked, DCE across stages). V8 owns "how that code gets compiled"
(register allocation, CSE, copy prop, instruction selection). Each
side does what it's best at.

**Inspection / distribution story** — exposing the generated source
as a first-class API unlocks a genuinely novel shipping mode:

```js
transform.compile();                // new Function() + cache
transform.getSource();              // returns the JS string
transform.toModule({ name: '...' }) // wraps as an ES module
```

Four use-cases fall out:
1. **Runtime JIT** (default): `compile()` + cached `new Function()`.
2. **CSP-locked environments**: `getSource()` → paste into bundler →
   import as a static file. Engine becomes a **build-time tool**,
   zero runtime dependency.
3. **Debugging**: `console.log(transform.getSource())` → read 60 lines
   of self-documenting JS → point at the colour bug. Comments are
   parser-stripped (zero runtime cost), so emit them liberally —
   matrix rows annotated with source/dest whitepoint, curve lines
   annotated with their ICC tag origin. The artefact becomes a
   teaching tool, not a black box.
4. **Self-contained precompiled transform modules** via
   `toModule({name: '...'})` — emit the generated source PLUS the
   store's large data (curves / CLUTs as typed-array constructors)
   inlined at the top of the file, producing a standalone JS module
   that has **zero runtime dependency on jsColorEngine**. A typical
   RGB→CMYK module lands around ~50-80 KB unminified / ~25-40 KB
   gzipped (dominated by the 17⁴×4 u16 CLUT). This is smaller than
   the ~192 KB engine — for one specific transform, bit-exact, no
   ICC parser, no Loader, no dispatcher.

**Real costs to weigh:**

1. `new Function` is blocked by strict CSP (some browser extensions,
   some enterprise sites). Mitigation: expose `transform.getSource()`
   that returns the string, so users in locked-down environments can
   precompile at build time via their bundler.
2. Parse + TurboFan warm-up is ~10-100 ms per first-call per transform.
   Fine for long-running converters, painful for one-shot. Mitigation:
   lazy (codegen only on first `transform()` call, not at `create()`).
3. Stack traces become `eval:anonymous:line N` — ugly to debug.
   Mitigation: use `//# sourceURL=transform_srgb_to_gracol.js` in
   the generated source so DevTools gives it a stable filename.
4. Per-Transform native code blob (~5-10 KB compiled). Negligible
   for most users; slight concern for apps that cache dozens of
   Transforms.

**What we'll steal from the literature:**

- `lcms2` has partial code-specialisation for its "optimisation"
  pass (`cmsOptimizationPluginChunkType`) — worth reading for the
  "what stages can be fused" list.
- TinyGlTF-style emitters, WebGPU-shader generators — the
  dispatch-table → emitted-function pattern is well-trodden for
  shader pipelines; color pipelines are structurally similar.
- `jit.ts` / `qjit` in the asm.js era proved `new Function()`
  emission beats general JS for tight numerical loops by ~3-5×
  when TurboFan can prove the types monomorphic.

**Risks** (for the record):

- Emission correctness is bit-for-bit regression territory. We need
  emission + reference-pipeline diffing in the test suite before
  any production use.
- Emitted WASM is harder to debug than hand-authored `.wat`. Good
  disassembly tooling + a "dump the emitted source" flag help.
- `new Function()` has CSP implications in some environments. We
  gate behind a feature flag and keep the non-emitted path working.

**Prototype path.** Start with RGB→RGB accuracy (simplest: decode
curve → matrix → adapt → inverse matrix → encode curve). Measure
MPx/s delta vs the current pipeline dispatch. If the win is 5× or
more, expand to CMYK. If it's less than 2×, shelve — `lutMode: 'int'`
and `lutMode: 'wasm-*'` cover the speed-sensitive use cases, and the
accuracy path staying at 5 MPx/s is tolerable for its use cases
(single colours, UI pickers, ΔE reporting).

### POC `compile()` options — what's shipped now

The proof-of-concept `Transform.compile()` (sRGB → CMYK chain,
covered in detail in
[deepdive/CompiledPipeline.md](./deepdive/CompiledPipeline.md))
ships with four opt-in flags that make the emitter a useful
measurement vehicle for the larger v1.5 effort:

```js
t.compile({
    target:      'js',     // emit target — only 'js' for now (WASM is the v1.5 backend)
    instrument:  false,    // wrap each stage in hrtime() for relative timing
    profilable:  false,    // lift each stage into its own NAMED fn for V8 --prof attribution
    useGammaLUT: false,    // 4096-entry LUT replaces Math.pow(x, 2.4) — LOSSY, ~3× speedup
    hotLoop:     false,    // wrap body in for(_i…); fn(input, output, n) instead of fn(pixel)
    strict:      true,     // throw if any stage lacks emit_<target>_<stageName>
});
```

`useGammaLUT` and `hotLoop` are the two perf-meaningful flags;
`useGammaLUT` alone reaches **2.76× over plain compile, 4.92×
over `t.forward()`** on sRGB→CMYK, both stacked reach **3.01× /
5.36×**. `instrument` and `profilable` are diagnostic — they
exist so we can keep measuring as new emitters land.

These are POC-shipped, not the v1.5 contract. The v1.5 work
generalises this to:
- multi-channel input preambles (CMYK input, not just RGB),
- emitters for the remaining stages (`tetrahedralInterp4D`,
  `stage_PCSv2_to_PCSv4`, adaptation, absolute-intent),
- `getSource()` / `toModule()` (above),
- a WASM emit target sharing the same stage-emitter shape.

### Per-Transform microbench for `'auto'`

The v1.2 `'auto'` heuristic is static: `int8 + buildLut: true` →
`'int-wasm-simd'` (with demotion chain), else `'float'`. In
practice on older / weaker CPUs the JS `'int'` kernel can edge out
`'int-wasm-scalar'` for small (17³) 3D LUTs — call overhead and
WASM JIT warm-up eat the scalar win.

**Idea.** A one-shot microbench at `Transform.create()` — run 100-1000
pixels through each available kernel once, keep the winner.
`'auto'` would pick the right answer for this combination of host
+ LUT shape + kernel availability, instead of "SIMD if available,
else demote".

**Cost.** ≤ 5 ms added to `create()` in exchange for a guaranteed
best kernel.

**When to ship.** Once we have concrete "wrong answer" evidence from
the browser bench ([docs/Bench.md](./Bench.md)) across a range of real
devices. Without that data we're optimising on vibes.

### DROPPED — float-WASM tier (was: float-wasm-scalar / f32 CLUT / float-wasm-simd)

> **Decision (Apr 2026, post v1.3-int16):** the float-WASM kernel
> family — `float-wasm-scalar`, `f32 CLUT` (`Float32Array` cells),
> `float-wasm-simd` — is **dropped from the v1.5 roadmap** and
> moved to a v2-maybe bucket. The case for it collapsed once the
> v1.3 int16 kernel landed and was measured. Original analysis
> preserved below for the paper trail.

**Why we're scrapping it.** The float-WASM tier was originally
specced as the "high-precision LUT path" — float math in the
kernel, float CLUT cells, SIMD throughput. Three things measured
in v1.3 made it redundant:

1. **u16 IS the profile source of truth.** Every real ICC v2/v4
   profile stores its CLUT cells as u16 (`mft2`, `mAB`, `mBA` u16
   variant — > 99 % of in-the-wild profiles). f32 CLUT cells only
   exist in `mpet` MultiProcessElement profiles, which we do not
   currently support and almost no shipping profile actually uses.
   So an f32 kernel against u16 cells upcasts → interpolates in
   f32 → downcasts; the **accuracy ceiling is set by the cells,
   not the math**. The f32 interp buys you a fraction-of-an-LSB in
   barycentric weighting (~0.001 ΔE) and nothing else.
2. **16-bit Lab is sub-0.01 ΔE vs float.** L step = `100/65535` ≈
   0.0015, a/b step = `256/65535` ≈ 0.004. Worst-case ΔE76 ≈ 0.007
   — two orders of magnitude under the just-noticeable threshold,
   one order under typical "measurement-grade" claims. **u16 Lab
   IS float Lab** for any practical accuracy claim. The v1.3
   `int16` kernel delivers this end-to-end at 37–76 MPx/s on
   Firefox today (no SIMD), 1.46–1.73× faster than `lcms-wasm`
   u16. See [v1.3 16-bit measured baseline](#v13-16-bit-measured-baseline-firefox-150-apr-2026).
3. **The accuracy tier above u16 is the no-LUT pipeline, and
   compile() handles it.** For workflows that genuinely need f64
   precision (CAM02/16, BPC math, instrument data, very small
   gamut moves), the answer is the no-LUT pipeline. The compiled
   variant of that pipeline (POC at ~5 MPx/s, projected
   25-35 MPx/s after generalisation) is the right hammer — same
   accuracy as f64 today, an order of magnitude faster, and free
   of LUT quantisation entirely. f32 wasm would slot **between**
   u16 LUT and f64 no-LUT, but at the same accuracy as u16 LUT
   (cells dominate) — so it doesn't unlock anything the existing
   tiers don't already cover.

**Three-tier picture that emerged** (post v1.3 int16):

| Tier | Accuracy | Speed (FF150) | Use case | Status |
|---|---|---|---|---|
| **u8 LUT** (`int` / `int-wasm-simd`) | ~0.3-0.5 ΔE (8-bit quantisation) | 87-198 MPx/s | image batch, web display, JPEG/PNG | shipped v1.1/v1.2 |
| **u16 LUT** (`int16`) | ~0.01 ΔE (profile-native) | 37-76 MPx/s | HDR, 16-bit TIFF, measurement, prepress | shipped v1.3 |
| **f64 no-LUT** (raw / `compile()`) | ~0.0001 ΔE | 5 / projected ~25-35 MPx/s | CAM, BPC math, instrument data | raw shipped; compile() POC |

There's no shelf-space for a fourth f32 SIMD tier between u16 LUT
and f64 no-LUT — the cells set the accuracy, the workload doesn't
exist that needs f32 precision and image throughput in the same
breath. f32 SIMD remains theoretically attractive (the wasm POC
hit 67.7× over JS plain on no-gather math — see
[Historical record](#historical-record--original-v13--v14-analysis-1d-wasm-poc)),
but the workloads that actually benefit (spectral / CAM batch
pipelines, HDR scene-linear with explicit f32 buffers) are not on
the v1.x critical path.

**Where the float-WASM tier would re-enter the conversation.** A
real customer demand for one of:
- `mpet` MultiProcessElement profile support (which would put f32
  CLUT cells on the table for the first time)
- spectral pipeline batch processing (where f32 is the natural
  storage format and u16 quantisation noise compounds across many
  wavelength bins)
- explicit HDR scene-linear workflows where f32 is the buffer
  format users want to feed in directly

If any of those land as v2 features, this section gets resurrected
verbatim. The kernel design is sound; the value-per-LOC is just
not there for v1.x.

**WASM SIMD u16 is still on the v1.3 roadmap** (above) and remains
the natural "lift the int16 ceiling" item. That work is unrelated
to the float tier — it's the same int kernel family extended from
u8 → u16 I/O, which is a fanout task on a proven design.

---

#### Historical analysis (preserved — original case for the float-WASM tier)

> What follows is the pre-v1.3-int16 reasoning. Kept intact in case
> a future "do f32 wasm" decision needs the design rationale.

**Float-LUT WASM tier — the missing half of the speed pyramid.**
The JS float LUT path **already exists and is already specialised**
per output channel count. `tetrahedralInterp3DArray_3Ch_loop`,
`_4Ch_loop`, `_NCh_loop` (and their 4D siblings) are hand-unrolled
hot kernels that have shipped since ~v1.0. Only `_NCh` is a
generic fallback (5+ output channels). What was **missing** at the
time of writing was the WASM tier for float — the int path has JS
→ WASM scalar → WASM SIMD, the float path has only JS. Two
orthogonal items would have closed the gap; neither required the
other, and they stack cleanly.

**`float-wasm-scalar` — the low-complexity win (was the entry
point).** Copy the `int-wasm-scalar` kernel
(`src/wasm/tetra{3,4}d_nch.wat`), replace `i32.mul` + Q-shift with
`f32.mul` / `f32.add`, drop the rounding bias and narrow tails.
The float kernel is actually *simpler* than the int one — no
Q-format bookkeeping (weights are floats in `[0, 1]`), no
`+ 0x80 >> 8` round-half-up bias, no `i8x16.narrow_i16x8_u` at the
tail, `f32.mul` + `f32.add` map 1:1 to hardware FMA (when
available). Expected speedup: ~1.2–1.5× over JS float LUT (same
band `int-wasm-scalar` gave over JS `int` — float kernels hit the
same JS function-call + typed-array-bounds-check overhead). No SIMD
complexity, no lane-narrowing games — single rolled n-channel
kernel covers every output channel count.

**`f32 CLUT` (`dataType: 'f32'`) — the cache-footprint win
(orthogonal to the kernel change).** Today the float CLUT is
`Float64Array`; switching to `Float32Array` halves the bytes — 3D
profile (17³×4 = 19.6 KB → 9.8 KB) is L1-resident either way (no
cache win), 4D CMYK profile (17⁴×4 = 334 KB → 167 KB) crosses the
typical L2 boundary (measurable win on desktop-class CPUs). Risks:
JS f32 load = implicit f32→f64 widen (`cvtss2sd`) on every CLUT
read in the JS kernel — on tetrahedral loops with 4-8 CLUT reads
per output channel, those widens can eat the cache win; V8 deopts
+ re-specialises on first `Float32Array` after `Float64Array`
(bench must warm separately); accuracy: f32 mantissa is 24 bits
so CLUT cells in `[0, 1]` land ~6e-8 off (negligible for ΔE,
worth documenting).

**`float-wasm-simd` — the ambitious follow-on.** If
`float-wasm-scalar` + `f32 CLUT` had shipped, the SIMD variant was
the natural continuation: `f32x4` channel-parallel in a v128
register, copying the `int-wasm-simd` design directly. Same axis
choice (channel-parallel, not gather). The f32 data footprint
compounds with the `f32x4` SIMD width — two-for-one.

**Priority ordering would have been:** (1) `float-wasm-scalar`
cheapest + simplest, (2) `f32 CLUT` orthogonal + measurement-
dependent, (3) `float-wasm-simd` ambitious + depends on (1) and
(2). The whole tier is now superseded by the v1.3 int16 result —
see the *Why we're scrapping it* block above.

**Pre-biased u16 CLUT (3D only).** Independently rediscovered during
the v1.1 cycle: ICC v2 PCS Lab encodes `L* = 100` at 0xFF00 (= 255
× 256) for exactly the same reason we scale our u16 CLUT by 255 ×
256 — it makes `u16 / 256 = u8` exact under a cheap `>> 8`. We can
push this further by **baking the round-half-up bias into the
stored CLUT value** at build time:

```js
// buildIntLut — store u16 pre-biased by +0x80:
u16[i] = Math.min(65535, Math.round(float * 65280) + 0x80);

// 3D kernel — biases cancel in (a - c0) deltas; only c0's bias
// survives and it IS the round-up bias we wanted:
output[i] = (c0 + ((Math.imul(a-c0, rx) + Math.imul(b-a, ry) + Math.imul(d-b, rz)) >> 8)) >> 8;
```

Saves 2 additions per output channel in the 3D path. Estimated 2–4 %
speedup on 3D kernels, zero accuracy impact.

**Caveat**: does NOT apply to the 4D u20 kernels — the equivalent
pre-bias for a `>> 20` shift is `0x8000`, which would overflow u16
(32768 + 32640 > 65535). 4D kernels stay as-is. So this is a pure 3D
optimisation and needs a separate `buildIntLut` code path (or a flag
on the LUT indicating "3D-pre-biased" vs "4D-raw").

---


## v1.6 (optional) — `lutMode: 'int-pipeline'` — S15.16 for lcms parity

Status: **captured for record, no current commitment.** Included
because the question will come up ("can jsColorEngine be a drop-in
replacement for lcms with byte-for-byte parity?") and we want the
answer documented.

**The question.** lcms2 uses an S15.16 fixed-point internal
pipeline for its integer paths (see `cmsFixed1415` and friends in
`lcms2/src/cmsxform.c`). If a workflow requires byte-for-byte
lcms output — regulatory / audit / existing-reference-set
compatibility — our current `lutMode: 'int'` (u16 + Q0.16 + our
own rounding bias) is close but not identical. Closing that gap
means adopting the S15.16 internal format for at least one code
path.

**What this would involve:**

- An `'int-pipeline'` lutMode that routes the entire pipeline
  (stages + LUT + shapers) through S15.16 fixed-point, not just
  the LUT kernel.
- Kernel variants for the LUT path that read S15.16 weights
  instead of Q0.16 — essentially the `lcms2-tetra-6case` variant
  mentioned in the v2 descriptor section below.
- A separate test matrix asserting bit-exactness against
  `lcms-wasm` for representative profile chains.

**Why we don't see a need yet:**

- No user request. Everyone asking today wants "fastest valid u8
  output" or "float for measurement"; nobody has asked for "exactly
  what lcms does, down to the LSB".
- The v2 package-split work already exposes the `LutDescriptor`
  `variant` field that would let someone run an lcms-variant LUT
  kernel on an lcms-baked descriptor without this work. That may
  be enough to satisfy the lcms-parity use case without a full
  internal-pipeline rewrite.
- The complexity is non-trivial — S15.16 semantics differ from
  Q0.16 in rounding, saturation, and sign handling. Every stage
  would need parity tests; every kernel needs two variants.

If a real user pulls this forward, the plan is documented here so
the implementation doesn't start from scratch. Until then, v1.6 is
a skippable release slot.

---

## v1.7 (optional) — Hardened profile decode

Status: **acknowledged Achilles' heel, parked until a production
incident or external audit forces the issue.** Boring but important;
new features are cooler, but this is worth doing eventually.

### The problem

The profile decoder in `src/decodeICC.js` currently **trusts the
input**. If a profile is corrupted, truncated, or maliciously
crafted, the decoder may:

- Throw an unhandled exception that crashes a Node.js server loading
  an embedded profile from a user-uploaded image.
- Read past the end of a buffer (JS will return `undefined`, not
  segfault, but the downstream math produces garbage or `NaN`).
- Allocate a huge array if a tag claims an absurd element count
  (DoS vector on a shared server).
- Silently produce a malformed `Profile` object that blows up later
  in `Transform.create()` with an unhelpful stack trace.

None of these are security vulnerabilities in the "arbitrary code
execution" sense — JavaScript's memory model protects against that —
but they're **reliability vulnerabilities** for any deployment that
handles untrusted profiles (print shops, web services, CI pipelines,
anything that ingests user-supplied images with embedded ICC).

### Minimum bar — `try / catch` around the hot spots

The cheapest fix that makes the decoder "server-safe":

1. Wrap the top-level `decodeICC()` entry point in a `try / catch`
   that returns a well-formed error object (`{ ok: false, error:
   'reason' }`) instead of throwing.
2. Do the same for `Profile.load()` and `Loader.loadAll()` so the
   caller can distinguish "profile didn't load" from "something
   exploded".
3. Document the error-return shape in the API docs.

This doesn't *validate* the profile — garbage in still produces
garbage out — but it guarantees **the server doesn't crash** and the
caller gets a usable error message. Effort: a few hours.

### Better — tag-level validation and sanity checks

A proper hardening pass that treats the profile as untrusted input:

1. **Header validation.** Check magic bytes (`acsp`), file size vs
   declared size, profile class, colour space, PCS, version. Reject
   early with a clear error if any are out of spec.
2. **Tag-table bounds checks.** Every tag offset + size must fall
   within the declared profile size. Reject overlapping tags,
   tags that point past EOF, tags with zero size.
3. **Per-tag type validation.** Each tag type (`curv`, `para`, `mft1`,
   `mft2`, `mAB `, `mBA `, `XYZ `, `text`, etc.) has a defined
   structure. Validate element counts, grid dimensions, curve point
   counts against sane upper bounds before allocating arrays.
4. **CLUT sanity.** Grid dimensions × channel count × bytes-per-
   sample must match the declared tag size. Reject LUTs that claim
   65³ × 4 × 2 = 2.2 GB.
5. **Curve sanity.** Parametric curves (`para`) have 1–7 parameters
   depending on function type; reject if the count doesn't match.
   `curv` tables must have at least 1 entry (or 0 for identity).
6. **Matrix sanity.** 3×3 + offset matrices should have finite,
   non-NaN elements. Reject if determinant is zero (singular) or
   if any element is outside a sane range (±1e6).
7. **Graceful fallback.** If a tag fails validation, the decoder can
   either (a) reject the whole profile, or (b) mark that tag as
   "unsupported" and continue with a best-effort profile. Option (b)
   is friendlier for embedded profiles where only the rendering
   intent you're not using is corrupt.
8. **NaN / undefined deep scan.** After decode, walk every numeric
   value in the profile object (matrices, curves, CLUT entries,
   whitepoint, primaries) and reject if any are `NaN`, `Infinity`,
   or `undefined`. This is a cheap generic guard that catches
   corruption the per-tag validators might miss — a truncated read
   that returned `undefined`, a division by zero during decode, a
   malformed float that parsed as `NaN`. Easy to implement as a
   recursive sweep; runs once at load time, negligible cost.

Effort: a week or two of careful, tedious work for the full
tag-level validation. The NaN/undefined deep scan alone is a few
hours and catches a surprising amount — worth doing as a quick
first pass even before the detailed per-tag work. Every tag type needs
its own validation function; the test suite needs a corpus of
malformed profiles (truncated, oversized, wrong type, etc.) to
exercise every guard.

### Why optional / parked

1. **No production incident yet.** The decoder has handled thousands
   of real-world profiles without issue; the failure modes above are
   theoretical until someone hits them.
2. **New features are more visible.** v1.5's `toModule()`, N-channel
   inputs, and LUT hooks all have immediate user value; hardening
   the decoder doesn't add features, it just prevents rare failures.
3. **It's boring.** Tag-by-tag validation is grunt work — important,
   but not intellectually interesting. Easy to defer when shinier
   things are on the list.
4. **The risk is bounded.** JS can't segfault; the worst case is a
   crashed server process or garbage output, both of which are
   recoverable. This isn't a CVE-grade vulnerability.
5. **Developers can already wrap the call site.** A `try / catch`
   around `Profile.load()` or `Loader.loadAll()` today catches any
   exception the decoder throws. The hardening work would make that
   unnecessary and give better error messages, but it's not blocking
   anyone from shipping a robust integration right now.

### When this gets promoted

- A user reports a crash on a real-world corrupt profile.
- Someone wants to deploy jsColorEngine in a security-sensitive
  context (SaaS image pipeline, print-shop portal) and asks for an
  audit.
- We decide to pursue "production-grade" branding and want to back
  it up with a hardening pass.

Until then, v1.7 is a skippable release slot — documented here so
the scope is clear when the time comes.

---

## v2 — Separation of concerns: split Transform + Pipeline + Interpolator

Deferred; direction is worth capturing because the v1.2 architecture
already sets it up cleanly and the v1.5 code-generation work
sharpens the split further (by turning "pipeline" from a Transform
method into a family of emitted functions).

**The observation.** The WASM kernel we just shipped knows nothing
about ICC profiles, chromatic adaptation, rendering intents, or color
science. It knows `(LUT bytes, input bytes) → output bytes`. It's a
numerical primitive — 3D tetrahedral interpolation over a u16 CLUT —
that happens to live inside a color engine. It's the same relationship
as BLAS vs LAPACK, zlib vs every compressor that uses zlib, or
`libavcodec` vs `ffmpeg-cli`: the numeric hot loop is its own library;
the product is what wraps it.

**The split that falls out:**

- **`@jscolorengine/core`** *(the current package)* — ICC v2/v4 parser,
  profile math, chromatic adaptation, perceptual intent tables, BPC,
  gamut mapping, LUT baker, `Transform` class, the whole color-science
  surface. Produces a `LutDescriptor` (see below) + drives the
  interpolator.
- **`@jscolorengine/interpolator`** *(new)* — the `.wat` kernels, the
  WASM loader, the JS `'int'` fallback, the `LutDescriptor` contract,
  and that's it. ~1.9 KB `.wasm` + a few KB of JS glue. **No ICC. No
  profile class. No color math.** Ingests a descriptor, outputs pixel
  bytes. Testable in isolation against synthetic identity LUTs — no
  ICC profile fixture required.
- **`@jscolorengine/pipeline-emitter`** *(new, if v1.5 ends up big
  enough)* — the code-generator from v1.5. Takes a pipeline spec,
  emits JS source or `.wat`. Depends on `interpolator` for the LUT
  stages.

**The `LutDescriptor` is the contract between them:**

```
{
  clut:    Uint16Array,   // u16 grid values, layout [X][Y][Z][ch]
  cMax:    number,        // output channels (3, 4, 5, 6, ...)
  go0/1/2: number,        // strides in u16 element units
  gps:     number,        // gridPointsScale_fixed, Q0.16
  maxX/Y/Z: number,       // (g1-1)*goN boundary anchors
  scaling: 'q0.16_x255x256'   // our convention: 255*256=65280, round via >>8
         | 'q0.16_x65535',    // lcms convention: 0..65535, round via /257
  variant: 'jsce-tetra-6case'      // the kernel we shipped in v1.2
         | 'lcms2-tetra-6case',    // the lcms2 2.16 tetra variant
  identity: any,          // optional; loader uses for skip-recopy cache
  outputPrecision: 'u8' | 'u16',   // added in v1.3
}
```

The v1.2 code already satisfies this contract informally — our `intLut`
has every field listed. The v2 work is *formalising* it (rename
`wasm_loader.js` → `wasm_interpolator.js`, document the shape, add
`scaling`/`variant` fields, write kernel-level unit tests that build
descriptors from scratch without touching `Profile`).

**What shipping separately unlocks:**

1. **Multi-variant kernels, swappable via the descriptor.** A separate
   `.wat` file per `variant` value. Today we'd ship two:
   - `jsce-tetra-6case-q016-x255x256` — current `'int-wasm-scalar'`,
     bit-exact with our `lutMode: 'int'` JS kernel.
   - `lcms2-tetra-6case-q016-x65535` — bit-exact with lcms2 2.16's
     `cmsStageCLutFloat` / `cmsStageCLutU16` output. Ported from
     `lcms2/src/cmsintrp.c` (Marti Maria Saguer's implementation —
     MIT-licensed, explicitly creditable).

   Feeding lcms's baked device-link LUT through the `lcms2` variant
   gives byte-for-byte lcms parity at 2.5× the speed of `lcms-wasm`'s
   own kernel. Addresses the "my audit pipeline requires lcms
   bit-reproducibility" use case without compromising our own kernel's
   u8-exact design for default users.

2. **Minimal-bundle deployments.** Someone in a print shop, a CGI
   pipeline, or a regulated workflow bakes their LUTs once (using our
   baker, lcms, OpenColorIO, a Photoshop device-link export — doesn't
   matter), saves them as serialised descriptors (`JSON.stringify` on
   a typed-array-encoded wrapper, or an ArrayBuffer blob), and at
   runtime ships only the ~10 KB interpolator + the LUT blobs. The
   200 KB full engine is dev-time only. For "convert these 6 known
   profile pairs, never anything else" deployments this is a huge win.

3. **Ecosystem reach.** `lcms-wasm`, `OpenColorIO.js` (if it ever
   exists), `babl-wasm`, any future JS color library can adopt the
   interpolator package directly. Our 1.5× scalar + SIMD wins become
   portable across the whole JS color-management layer, not locked
   inside our product. The "kind-hearted" read of this decision: we
   believe the interpolator is better-off as infrastructure than as
   a moat. The author-credit sits in the `.wat` header comment where
   it belongs, not behind an API boundary designed to keep people
   captive.

**What it doesn't unlock:**

- *Not* a speedup. Same kernel, same numbers. This is a packaging +
  surface-area refactor, not an algorithmic one.
- *Not* a "replaces lcms" story. lcms's value is the color science in
  Layer 1 (baking) — we'd interoperate with their bakes, not replace
  them.
- *Not* free. Splitting a package means two versioning lanes, two
  release cadences, a semver-stable descriptor contract, and users
  assembling two deps instead of one (though the `@jscolorengine/core`
  package would of course just depend on `@jscolorengine/interpolator`
  internally, so most users wouldn't see it).

**Prerequisites (in order):**

1. **v1.2 complete:** 4D WASM (scalar + SIMD) + `'auto'` land. ✅
   The descriptor contract covers both 3D and 4D from day one.
2. **v1.2 cleanup:** formalise the `LutDescriptor` contract in
   `wasm_loader.js`, rename to `wasm_interpolator.js`, add the
   kernel-isolation unit tests. Scope is JSDoc + renames + ~50 lines
   of new test code; the underlying shape is unchanged.
3. **v1.3 complete:** 16-bit kernels land. The descriptor
   `outputPrecision: 'u8' | 'u16'` field gets a second legal value.
4. **v1.5 complete:** non-LUT pipeline code generation lands. The
   split isn't just "LUT interpolator vs the rest" anymore — it's
   "LUT interpolator vs emitted pipelines vs color-science front-
   end". That three-way split is the target package shape.
5. **v2 split:** extract `@jscolorengine/interpolator` (and maybe
   `@jscolorengine/pipeline-emitter` if v1.5 ends up big enough) to
   its own package directory with its own `package.json`. Wire
   `core` to depend on them. Ship from a monorepo for at least one
   release before encouraging external adoption.

**Why this goes under v2, not later v1.x.** The v1.x line is a
performance arc: get measured speed to where the math says it can
go. v2 is an architectural arc: once the speed is banked, decompose
so the fast parts can live where they're most useful. Different
axis, separate release train, worth being explicit about which one
we're on.

---

## What we are explicitly NOT doing

- **GPU (WebGL / WebGPU shaders).** Tempting because GPUs eat 3D LUTs
  for breakfast, but: (a) upload+download latency dominates for
  anything under ~10 MPx — the round-trip alone costs more than our
  WASM SIMD kernel takes to do the work; (b) WebGPU isn't universally
  available yet (Safari / iOS WebKit are still partial), and WebGL2
  has its own quirks (no integer textures on a lot of mobile, sketchy
  lookup precision); (c) the API surface is huge — shader compilation,
  framebuffer management, texture upload, pipeline state, all of which
  have to be testable headlessly; (d) **the strongest reason —
  portability.** A lot of colour-management deployments don't have a
  GPU at all: a headless Node.js process on a rack server doing
  soft-proof for a print queue, a containerised RIP frontend, a CI
  step that renders proof bytes for visual regression, an AWS Lambda
  batch job, an SSH'd CLI on a build box. WebGL / WebGPU shaders need
  a GPU, driver setup, and (often) a window context — non-starters in
  those environments. WASM SIMD is the *portable* acceleration target:
  same kernel, same speed ceiling, anywhere the V8 / SpiderMonkey /
  JSC WASM engine runs (which is everywhere, including headless
  containers with no display hardware). The Performance.md throughput
  numbers are measured in browser benchmarks because that's where the
  bench UI lives, but the engine's *value proposition* is "fast on
  every JS host", not "fast on a host with a GPU". Maybe v2.x as an
  opt-in browser-only kernel for callers who already have a GPU
  pipeline up and want to fuse colour-management into it; not on
  the near roadmap.
- **Lab whitepoint awareness in the integer kernels.** Lab a/b are
  signed; our integer kernels assume unsigned u8/u16 inputs. We
  sidestep this by always going through device color (RGB or CMYK)
  when the integer / WASM kernels are used. If you need Lab→Lab, pin
  `lutMode: 'float'` or set `buildLut: false` for the f64 pipeline.
- **Web Workers / parallel transformArray.** Was on the v1.3 roadmap
  but bumped — the WASM POC numbers (1.84× scalar, 3.25× SIMD in the
  event) made WASM the far better next step, and Web Workers can be
  added on top of any kernel later. Will revisit post-v1.5 once
  `'auto'` and the emitted-pipeline path both exist; by then the
  per-worker compile cost is amortised across multiple Transforms
  via `wasmCache`, which is the shape that makes workers cheap.
- **Profile decode optimisation.** Profile parsing is a one-time cost;
  the engine spends 99.9 % of its life inside `transformArray`. Not
  worth the code complexity.
- **Asm.js / SharedArrayBuffer-only paths.** asm.js was superseded by
  WASM; SharedArrayBuffer requires CORS headers most users don't
  control. We'll use them where available but won't *require* them.

---

## Historical record — original v1.3 / v1.5 analysis (1D WASM POC)

The two analyses below drove the original v1.3 / v1.5 split. Both
have since been superseded — v1.3 (WASM scalar) landed in v1.2, and
v1.5's matrix-shaper-only plan was subsumed by the v1.5 code-
generation target above. The numbers and findings are preserved
because they still inform design decisions (especially the SIMD
ceiling number for v1.5 emission, and the "LUT gather ≠ vectorise
across pixels" rule that's easy to forget).

**Where the WASM scalar win actually came from** (1D POC, v1.3
analysis): our JS integer kernels are ~37 % data moves, ~20 %
safety machinery (including ~8 % `jo` overflow guards we don't
need and ~7 % bounds-check pairs), and only 25-47 % arithmetic.
WASM removes both classes of safety machinery for free — `i32`
math wraps by spec (no `jo` needed) and linear memory uses guard
pages for bounds safety (no `cmp`/`jae` pairs needed). Prediction
was 1.4-1.6× over `'int'`; measured 1.40× on the production 3D
tetrahedral kernel (Performance.md § 2.3).

**Original 1D POC results (Node 20, 1 Mi pixels per pass):**

| Kernel | MPx/s | vs JS plain |
|---|---|---|
| JS plain | 372 | 1.00× |
| JS `Math.imul` | 376 | 1.01× |
| **WASM scalar** | **684** | **1.84×** |
| WASM SIMD (with LUT gather) | 606 | 1.63× |
| WASM SIMD (no LUT, pure math) | 25 180 | **67.7×** |

All four kernels were bit-exact against each other across 1 Mi
pixels. See `bench/wasm_poc/README.md` for the full analysis.

**Four findings that still drive the roadmap:**

1. **WASM scalar beats JS by 1.84×** for gather-heavy kernels. V8
   is excellent at integer JS, but WASM wins via no bounds checks,
   no de-opt risk, and tighter machine code. Drove v1.3 → now
   shipped as `'int-wasm-scalar'`.
2. **WASM SIMD with across-pixel LUT gather is *slower* than WASM
   scalar** (0.89×). WASM SIMD has no native gather instruction;
   each lane lookup is a scalar `i32.load16_u` + `replace_lane`
   round-trip. Original conclusion: "3D/4D LUT kernels will
   perform worse under SIMD." **Correct for across-pixel; wrong
   for across-channel** — see Performance.md § 2.4 for the
   inversion that hit 3.25×. The "we ruled SIMD out for LUTs"
   story is § 3.3.
3. **WASM SIMD pure math IS 67.7× faster** on no-gather math.
   This is the ceiling for emitted non-LUT pipelines — drives
   v1.5 code-generation target. Matrix-shaper, gamma polynomial,
   RGB↔YUV, channel reordering all live here.
4. **`Math.imul` is no longer worth using as a perf optimisation**
   in modern V8. Still useful as insurance against accidental
   float promotion, but plain `*` produces identical machine code.

---

## Related

- [Performance.md](./Performance.md) — where we are (measured),
  what we learned, the journey
- [CHANGELOG.md](../CHANGELOG.md) — versioned release notes
- [Deep dive](./deepdive/) — how the current kernels work
- [Bench.md](./Bench.md) — run the benchmarks yourself
