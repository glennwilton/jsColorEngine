# Roadmap

[README](../README.md) ·
[Deep dive](./deepdive/) ·
[Performance](./deepdive/Performance.md) ·
[Bench](./Bench.md) ·
[Examples](./Examples.md) ·
**Roadmap** ·
[Profile](./Profile.md) ·
[Transform](./Transform.md) ·
[Loader](./Loader.md)

---

Single source of truth for what's coming next in jsColorEngine.
Retrospective material (what shipped, what we measured, what we
learned) lives in [Performance.md](./deepdive/Performance.md). Versioned
release notes live in [CHANGELOG.md](../CHANGELOG.md). This page is
future-facing only.

> **Planning philosophy.** This is a solo-maintained codebase, so the
> roadmap is ordered by "what unlocks the most for the least work"
> rather than calendar dates. Items are specified to the point where
> the next person reading (human or AI) can pick one up without
> re-deriving the design. Numbers and trade-offs come from measurement,
> not speculation — see Performance.md for the evidence behind each
> projection.
>
> **Convention: plan here, thinking elsewhere.** The roadmap is the
> *what* and *when* — keep sections short and actionable. Detailed
> analysis, trade-off reasoning, benchmark results, and design
> rationale live in [Performance.md](./deepdive/Performance.md),
> [deep-dive docs](./deepdive/), or inline code comments. Roadmap
> sections should reference those docs rather than duplicating the
> long-tail thinking, so ideas don't get lost across copy/paste and
> the roadmap stays scannable.

---

## Table of contents

- [Shipped so far](#shipped-so-far)
- [v1.4 — Image helper + browser samples (shipped)](#v14--image-helper--browser-samples)
    - [Browser samples](#browser-samples)
- [v1.4.2 — Polishing pass (shipped)](#v142--polishing-pass-shipped)
- [v1.4.3 — Portable LUTs + LutBuilder (shipped)](#v143--portable-luts--lutbuilder-shipped)
- [v1.4.4 — LutBuilder TIFF workflow + CLI tool (shipped)](#v144--lutbuilder-tiff-workflow--cli-tool-shipped-2026-05-02)
- [v1.5 — Polish, validation, and fast paths — shipped in v1.5.0](#v15--polish-validation-and-fast-paths--shipped-in-v150)
    - [Dependency hygiene — Dependabot triage + devDependency bumps (shipped)](#dependency-hygiene--dependabot-triage--devdependency-bumps-shipped)
    - [Pipeline validation — `validateOnCreate` option (shipped)](#pipeline-validation--validateoncreate-option-shipped)
    - [Transform identity / NOP detection (shipped)](#transform-identity--nop-detection-shipped)
    - [Fully-bound `transformArrayFn` dispatch optimisation — (shipped)](#fully-bound-transformarrayfn-dispatch-optimisation--shipped)
    - [Kernel modules by dimension — (shipped)](#kernel-modules-by-dimension---shipped-in-v150-2026-08-15)
    - [DeviceLink profile support — (shipped)](#devicelink-profile-support---shipped-in-v150-2026-08-15)
    - [N-channel LUT support (5CLR–15CLR) — (shipped)](#n-channel-lut-support-5clr15clr---shipped-in-v150-2026-08-15)
- [v1.5.5 — RGB matrix-shaper fast path + one-pixel cache](#v155--rgb-matrix-shaper-fast-path--one-pixel-cache)
    - [RGB matrix-shaper fast path — fused gamma + matrix + curves](#rgb-matrix-shaper-fast-path--fused-gamma--matrix--curves)
    - [One-pixel memo cache — performance experiment](#one-pixel-memo-cache-for-the-lut-kernels--performance-experiment)
    - [Browser sample bench — retune on real-image content](#4-browser-sample-bench--retune-on-real-image-content)
- [v1.6 — QC infrastructure + automated bench history](#v16--qc-infrastructure--automated-bench-history)
    - [Automated bench recording — `npm run benchRecord`](#automated-bench-recording--npm-run-benchrecord)
    - [One home for the numbers — `docs/BenchResults.md`, generated](#one-home-for-the-numbers--docsbenchresultsmd-generated)
    - [Browser bundle archive — `bench/results/bundles/`](#browser-bundle-archive--benchresultsbundles)
    - [`lcms_patch/` extraction (v1.3 follow-up)](#lcms_patch-extraction-v13-follow-up)
    - [Automated profile oracle — bulk ICC compatibility testing](#automated-profile-oracle--bulk-icc-compatibility-testing)
    - [Accuracy-path `pixelCache: 'auto'` — shipped](#accuracy-path-pixelcache-auto--shipped)
    - [In-kernel pixel cache — shipped in 1.6](#in-kernel-pixel-cache--beta-off-by-default)
- [v1.7 — Compiled non-LUT pipeline + `toModule()`](#v17--compiled-non-lut-pipeline--tomodule)
    - [Per-Transform microbench for `'auto'`](#per-transform-microbench-for-auto)
    - [Non-LUT pipeline code generation (`new Function` + emitted WASM)](#non-lut-pipeline-code-generation-new-function--emitted-wasm)
    - [POC `compile()` options](#poc-compile-options)
- [v1.8 (optional) — Hardened profile decode](#v18-optional--hardened-profile-decode)
- [v2 — Separation of concerns: split Transform + Pipeline + Interpolator](#v2--separation-of-concerns-split-transform--pipeline--interpolator)
- [What we are explicitly NOT doing](#what-we-are-explicitly-not-doing)
- [Research and analysis](#research-and-analysis)
    - [Non-uniform LUT grid (√ and cubic) for RGB-input workflows](#non-uniform-lut-grid--and-cubic-for-rgb-input-workflows)
    - [LUT grid size sweep — `lutGridSize` analysis](#lut-grid-size-sweep--lutgridsize-analysis)
- [Historical record — original v1.3 / v1.5 analysis (1D WASM POC)](#historical-record--original-v13--v15-analysis-1d-wasm-poc)
- [Dropped](#dropped)

---

## Shipped so far

**v1.0** — full ICC v2/v4 ingest, virtual profiles, four rendering
intents, BPC, tetrahedral interp, Lab / XYZ / RGB / CMYK /
n-channel device spaces, spectral + illuminant maths.

**v1.1** — `lutMode: 'int'` integer hot path. u16 mirror LUTs,
`Math.imul`-based tetrahedral kernels for all four 3-/4-channel
directions. ≤ 1 LSB on u8 output, 10–25 % faster than the float
kernel, 4× less LUT memory. See
[Performance.md § v1.1 shipped](./deepdive/Performance.md#v11--4d-integer-kernels-cmyk-input--u20-refactor--shipped).

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
  internals, Bench / BenchResults → current numbers,
  deepdive/Performance.md → measurement retrospectives, Roadmap.md
  → future plans (this page).

Full numbers and the journey: [Performance.md](./deepdive/Performance.md).
Release notes: [CHANGELOG.md](../CHANGELOG.md).

**v1.2 is feature-complete.** The last open item — a measured
head-to-head against native (non-wasm) lcms2 — landed via
[`bench/lcms_c/`](../bench/lcms_c) and is documented in
[Performance.md § Measured — vs native LittleCMS](./deepdive/Performance.md#measured--vs-native-littlecms-same-hardware-same-run).
The headline at the time (pure JS beating vanilla native lcms2 on
most measured workflows) has since been revised: the native
comparison proved strongly input-content-dependent and is under
re-measurement after upstream review — current status in
[docs/LcmsComparison.md](./LcmsComparison.md).

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

- **`ICCImage` helper** (`samples/ICCImage/iccimage.js`) — small immutable
  image wrapper (MIT-licensed) that owns the "I have an image, I
  want to proof / inspect it" workflow. Immutable, always
  profile-tagged, lazy + cached transforms. Full API reference:
  [`samples/ICCImage/ICCImage.md`](../samples/ICCImage/ICCImage.md).
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
  `samples/styles/styles.css`, bundled CMYK ICC profiles.
- **Docs** — [`docs/Samples.md`](./Samples.md) live demo index,
  [`samples/ICCImage/ICCImage.md`](../samples/ICCImage/ICCImage.md) API reference.
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
[Performance.md § v1.3 — 16-bit kernel ladder](./deepdive/Performance.md#v13--16-bit-kernel-ladder-shipped)
for the headless-bench numbers, the design constraints
(why Q0.13 specifically, why two-rounding for 4D), and
[Accuracy.md § 16-bit kernel accuracy](./deepdive/Accuracy.md#16-bit-kernel-accuracy-v13--near-perfect-no-corners-cut)
for the per-workflow precision tables.


**v1.4.2** — polishing pass: WASM memory management (`wasmMaxMemory`, `wasmShrinkRatio`, `compactWasmMemory`), reusable output buffers, relative sample links, Lab ↔ int16 helpers (`convert.lab2Int16` / `int162Lab`), LUT build hooks (`lutInputHook` / `lutOutputHook`). See [CHANGELOG.md](../CHANGELOG.md#1.4.2).

**v1.4.3** — portable LUT JSON format + LutBuilder. `Transform.toJSON()` / `Transform.fromJSON()` / `lutToJSON` / `jsonToLut` as the wire format authority; `Transform.setLut()` rewritten as the LUT authority (normalises CLUT, re-resolves kernel, regenerates strides); FNV-1a content signatures for audit / tamper-detection; `LutBuilder` (MIT, `samples/`) covering the full LUT lifecycle including lcms-wasm bridge with auto-detected Emscripten batched path; bugfix for `create4DDeviceLUT` pipeline-chaining (inverted CMYK→RGB LUT output); ICC header `date` → ISO string and `version` → `"M.m.b"` string; `CMYK → RGB via LUT` demo showing the build-once / ship-anywhere workflow with ~0.1 ΔP cross-engine agreement. See [CHANGELOG.md](../CHANGELOG.md#1.4.3).

**v1.4.4** — LutBuilder TIFF visual editing workflow + CLI tool. See [CHANGELOG.md](../CHANGELOG.md#1.4.4).

**v1.5.0 (2026-08-15, this release)** — the polish arc plus the three
big features. Dependency hygiene (webpack → esbuild);
`validatePipeline()` + `validateOnCreate`; identity / NOP detection
(`detectIdentity:true` with chain collapse — note the semantic
change for same-profile round-trips); fully-bound `transformArrayFn`;
LUT kernel plugins ([docs/Plugin.md](./Plugin.md)); **kernel modules
by dimension** (`src/kernels/`, Transform.js 15.9 k → ~11 k lines,
bench parity — then [deepdive/KernelContract.md](./deepdive/KernelContract.md));
**DeviceLink profiles** ([docs/DeviceLink.md](./DeviceLink.md));
**N-channel 5CLR–15CLR profiles** ([docs/NChannel.md](./NChannel.md));
lcms comparison corrections after upstream review
([docs/LcmsComparison.md](./LcmsComparison.md) — accuracy oracle now
lcms default flags, 100 % within 1 LSB on all four image workflows).
488 tests. Full notes: [CHANGELOG.md](../CHANGELOG.md).

**v1.6.0 (2026-08-23)** — Kernel5D / Kernel6D int8 WASM; in-kernel
pixel cache in `create()`; on-demand WASM compile; browser worker
pool. Native C IT8 oracle is next. Full notes:
[CHANGELOG.md](../CHANGELOG.md#160--2026-08-23).

----

## v1.3 — see [Shipped so far](#shipped-so-far)

The v1.3 plan above shipped as scoped (modulo the deliberate
deferrals noted in the bullet list). The original "v1.3 plan"
prose that lived here has been folded into the shipped retrospective
and into [Accuracy.md](./deepdive/Accuracy.md). The `lcms_patch/`
extraction follow-up is now tracked in v1.4.2 as a polish-pass item,
`lutGridSize` moved to [Research and analysis](#research-and-analysis),
and the larger compiled-pipeline work remains in v1.7.

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

Lives in [`samples/ICCImage/iccimage.js`](../samples/ICCImage/iccimage.js), exported
as `ICCImage`. Lives in `samples/` (not `src/`) deliberately — it's
**helper-grade**, MIT-licensed (separate from the engine's MPL-2.0
— see [`samples/LICENSE`](../samples/LICENSE)), and double-billed
as living documentation of how to drive the core engine on real
image data. Full API reference: [`samples/ICCImage/ICCImage.md`](../samples/ICCImage/ICCImage.md).

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
import { ICCImage } from './samples/ICCImage/iccimage.js';
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

**Shipped (v1.4.0).** `samples/ICCImage/iccimage.js`, the gamut-mapping LUT,
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
  `docs/deepdive/Performance.md` — plenty of slack even after `drawImage`
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
## v1.4.2 — Polishing pass (shipped)

Small, high-impact cleanup release focused on allocation hygiene and
sample portability while v1.5 centrepiece work is in flight.

- **DONE — WASM memory management.** `wasmMaxMemory` (default 128 MB)
  and `wasmShrinkRatio` post-run guards, plus `compactWasmMemory()`,
  `releaseWasmMemory()`, `wasmMemoryBytes()`.
- **DONE — reuse output buffers.** `transformArrayViaLUT()` and
  LUT-routed `transformArray()` now accept an optional destination
  array so tight loops can avoid per-call allocations and reduce GC
  churn.
- **DONE — Update benchmarks to reuse buffers.** Bench scripts
  normalized; hot-loop measurements no longer include avoidable
  output allocations. MB/s metric added alongside MPx/s.
- **DONE — Make sample links/lib references relative.** All sample
  pages now use fully relative paths for scripts/assets/profiles.
- **DONE — Lab ↔ int16 helpers (`convert.lab2Int16` / `convert.int162Lab`).**
  Convenience/API polish for u16 Lab encode/decode workflows.
  Shipped with `lut.inLab`/`lut.outLab` encoding metadata and four
  Transform wrappers (`inputLab2Int16`, etc.).
- **DONE — Custom LUT callbacks (`lutInputHook` / `lutOutputHook`).**
  Build-time-only LUT shaping hooks with zero per-pixel cost.
  Composable via `addLutInputHook()` / `addLutOutputHook()` with
  `before`/`after` ordering; `clearLutHooks()` to reset.
  Output hooks also receive the original input as a second argument
  for debugging/logging.

Design notes for the LUT hooks are kept in the section below.

### Custom LUT callbacks — `lutInputHook` / `lutOutputHook` ✓ shipped

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
---
#### Plugin style, allow multiple hooks, but keep them build-time only and turn the gamut mapping feature into a plugin that uses them

Noting that the hooks are a plugin-style extension point, we can design them to be
composable (multiple hooks run in sequence, each receiving the previous hook's output) 
without caring about the specific use cases. 

Also noting the similarity between the existing gamut-mapping LUT feature 
(baking a ΔE warning into the LUT) and the hook use cases, 
we can implement the gamut mapping as a plugin that uses the hooks.
This way, we keep the core engine clean and focused on profile transforms,
while allowing for flexible extensions like gamut mapping without hardcoding
them into the engine.

So the gamut-maping is both a feature and an example of a plugin book for the lut hooks.

----

#### Why build-time only

The hooks run during `buildLut()`, not during `transformArray()`.
That's the whole point — the warp is **baked into the LUT cells** so
the per-pixel kernel stays fast. If you need a per-pixel hook
(dynamic colour grading that changes every frame, say), that's a
different feature (and a much more expensive one — the kernel would
have to call out to JS on every pixel, breaking the WASM hot path).
Build-time hooks keep the fast path fast.

----

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
runs in PCS space between the two profile legs?). If `lutGridSize`
graduates from [Research and analysis](#research-and-analysis) to a
feature, both can ship together with a unified "LUT build options"
section in the Transform docs.

-----

-----

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

What about float versions?

-  `inputLab2Float` initally sounds like a good idea but then 
  we already have a full object based pipeline for that (the 
  profile transform itself) — and the helper's would just
  add another API surface to maintain, with no real win over just calling
  `transform.transform(dataFormat: object)`. The u16 helpers are a
  special case because the caller is already working with u16 buffers and
  needs the encoding constants; the float helpers would be a thin wrapper over
  the existing transform path that doesn't save much and adds API surface.
- Skipped because unnecessary.

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

---

## v1.4.3 — Portable LUTs + LutBuilder (shipped)

Build a colour transform once; ship a JSON file; reconstruct at runtime with no profiles and no lcms.

- **DONE — Portable LUT JSON format.** `transform.toJSON()` (instance, auto-called by `JSON.stringify`), `Transform.fromJSON(input, opts)` (static factory), `Transform.lutToJSON(lut, opts)` / `Transform.jsonToLut(input)` (static encode/decode helpers). Default `dataType: 'u16'` (lossless ~650 KB for a 4D LUT); `dataType: 'u8'` halves the size. `opts.verify: true` on `setLut`/`fromJSON` checks the content signature.
- **DONE — `Transform.setLut()` as LUT authority.** Re-resolves `lutMode`, normalises any CLUT type (Uint16Array, Uint8Array, Float64Array, base64) to canonical f64 [0..1], regenerates strides from `gridPoints + outputChannels`. No longer requires `buildLut: true` in the constructor.
- **DONE — Content signatures.** FNV-1a 32-bit (`Math.imul`-based, ~1.3 ms for a 33-pt 3D LUT) over chain + grid + u16 pixel data. Format `"FNV1A:<8 hex>"` — algorithm-prefixed for future upgradability. Lazy-stamped at `toJSON()` time; hot-path unchanged. `Transform.signLut` / `verifyLut` static + instance methods.
- **DONE — `LutBuilder` helper** (`samples/LutBuilder/LutBuilder.js`, MIT). Full lifecycle — `create()` (callback), `createIdentity()`, `createFromLCMS()` (auto-detects Emscripten batch API: one `_cmsDoTransform` call over the whole grid, ~80× faster than per-cell), `editLut()` (per-cell mutation, auto-appends timestamped breadcrumb), `clone()`, `toJSON()`, `fromJSON()`. Dual CJS/browser-global export. Deep-dive: [`docs/deepdive/Luts.md`](./deepdive/Luts.md). User guide: [`samples/LutBuilder/lutbuilder.md`](../samples/LutBuilder/lutbuilder.md).
- **DONE — Bugfix: `create4DDeviceLUT` pipeline chaining.** Each pipeline stage was fed the original `src` instead of the previous stage's output — caused CMYK white paper to render as black RGB (inverted output) for any real ICC CMYK profile. Fixed by replacing the broken inline loop with `this.forward(src)` (matches `create3DDeviceLUT`). Regression test added.
- **DONE — ICC header `date` / `version` parsing.** `header.date` now parses ICC 12-byte date to a JS `Date` (JSON → ISO string). `header.version` now parses to `"M.m.b"` string (e.g. `"2.1.0"`) with `header.versionMajor` integer for engine routing.
- **DONE — JSON wire format cleanup.** Strides removed from serialised form (derived, regenerated on decode). `inputScale`/`outputScale` forced to canonical 1/1 (were leaking kernel-internal u8 scaling values into the wire).
- **DONE — `samples/lut-cmyk-to-rgb.html` demo.** Builds jsCE and lcms LUTs, serialises to JSON, shows 3-up comparison (live vs jsCE LUT vs lcms LUT) with ΔP table and JSON inspector. Headline: jsCE ↔ lcms grids agree to 0.10 ΔP per channel; LUT path is ~6× faster than live per frame.

---

## v1.4.4 — LutBuilder TIFF workflow + CLI tool (shipped 2026-05-02)

- **LutBuilder Stage 3 — TIFF visual editing workflow.** Export an identity LUT as a TIFF image (ZIP-compressed, embedded ICC, XMP metadata), edit in any colour-managed application (Photoshop, Affinity, GIMP, macOS Preview), reimport the edited pixels as a modified LUT. The editor's CMS becomes your LUT's colour math, captured at grid resolution and dispatched at WASM-SIMD speed. Mean ΔP < 1 u8 unit vs Photoshop ground truth on a real sRGB→CMYK conversion. See [`docs/deepdive/Luts.md` §4](./deepdive/Luts.md#4-the-tiff-workflow--visual-lut-editing).
- **`lut-tiff-cli.js`** — CLI tool (`--create`, `--import`, `--validate`, `--compare`, `--apply`, `--make-samples`). Builds and imports LUT TIFFs, runs accuracy validation with ΔP reporting and delta image output, applies LUTs to arbitrary images. See [`samples/LutBuilder/lutbuilder.md`](../samples/LutBuilder/lutbuilder.md) CLI quick reference.
- **`builder.analyze()` / `LutBuilder.comparePixels()`** — pixel-level accuracy analysis. ΔP report (mean, max, RMSE, p95, p99, per-channel, grade), optional amplified delta TIFF images and plain-text report file.
- **`LutBuilder.pixelsToTIFF()`** — static helper to write raw pixel buffers as TIFF files.
- **Three sample TIFFs** (`npm run tiff-samples`): sRGB N=33, GRACoL CMYK N=17, Gray tone curve N=255. All with embedded ICC profiles and Photoshop-compatible XMP metadata.
- **32-test TIFF suite** (`__tests__/lutbuilder_tiff.tests.js`): LZW/ZIP/uncompressed decode, CMYK/RGB output-channel auto-detection, embedded ICC extraction, planar-format rejection, damaged-cell spread detection, dot-gain tone curve import, CLI pipeline tests.
- **Dependency hygiene (deferred to v1.5).** Webpack bumps moved to v1.5 to keep this release focused on the TIFF workflow.

---

## v1.5 — Polish, validation, and fast paths — shipped in v1.5.0

> Everything below shipped in **v1.5.0 (2026-08-15)** — including the
> kernel-module architecture, DeviceLink, and N-channel features that
> were originally filed under v1.6/v1.7, now consolidated here. The
> RGB matrix-shaper fast path moved to its own
> [v1.5.5 section](#v155--rgb-matrix-shaper-fast-path--one-pixel-cache).

> **Theme.** Quick wins that improve developer experience, close
> security alerts, harden the pipeline, and add targeted fast paths
> — all shippable independently, no big architectural changes. The
> larger compiled-pipeline + `toModule()` work moves to v1.7; QC
> infrastructure moves to v1.6; N-channel float inputs move to v2.

### Dependency hygiene — Dependabot triage + devDependency bumps (shipped)

- **DONE — All devDependencies updated, 0 vulnerabilities.** Bumped
  `adm-zip` 0.5.10 → 0.5.17, `webpack` 5.89 → 5.106.2,
  `webpack-cli` 4 → 5, `webpack-dev-server` 4 → 5 (closed the
  entire `body-parser` / `express` / `cookie` HIGH alert cascade).
  Remaining transitive alerts resolved with `npm audit fix`.
- **DONE — Replaced webpack with esbuild.** webpack, webpack-cli,
  webpack-dev-server, and webpack-merge removed entirely. esbuild
  added as the sole bundler. Same script names (`build`, `browser`,
  `dev`, `watch`, `browser-watch`), same output paths, identical
  bundle output — verified by smoke-testing both builds against the
  same transform and getting bit-identical results. Build time: 3 s
  → 24 ms. `webpack.config.js` deleted. Dead `speedtests` script
  (referenced a git-ignored directory) removed.
- **DONE — Sample pages smoke-tested** via `npm run serve`. All
  demos ran correctly against the esbuild browser bundle.
- **No runtime surface changes.** The engine's `src/` tree picks up
  no new direct dependencies.
- **Re-checked 2026-08-16:** `esbuild` 0.28.0 → 0.28.2; `js-yaml`
  quadratic-CPU advisories cleared via `npm audit fix`; unused
  `adm-zip` devDependency removed entirely (no consumer left in the
  repo — it served the retired webpack-era archive script). Result:
  **`npm audit` clean, 0 vulnerabilities.** `jest` 29.7 → 30.x is a
  major bump, deferred until there's a reason to take it.

### Pipeline validation — `validateOnCreate` option (shipped)

- **DONE — `validatePipeline()` method.** Runs a single mid-grey
  test pixel through the full pipeline in a `try/catch`. Catches
  silent `NaN` propagation (e.g. corrupt matrix element), wrong
  output type, and any stage that throws at transform time. Returns
  `true` / `false`. Can be called manually at any time after
  `create()`.
- **DONE — `validateOnCreate` constructor option, default `true`.**
  `create()` / `createMultiStage()` automatically calls
  `validatePipeline()` and throws with a clear message if validation
  fails. When `buildLut:true`, validation runs on the device-to-device
  temp pipeline *before* the LUT is built — so a broken profile is
  caught before the expensive LUT step. Skipped entirely when a
  cached LUT is loaded via `setLut()` / `fromJSON()`.
- **DONE — 17 tests** in `__tests__/transform_validate_pipeline.tests.js`:
  healthy baselines (all formats + CMYK↔RGB), NaN propagation through
  `XYZMatrix` and `gamma`, thrown-stage injection, `validateOnCreate`
  auto-throw, and setLut skip.
- **DONE — Transform.md updated** with `validateOnCreate` in the
  constructor options table, a `validatePipeline()` method section,
  and the "why `try/catch` `create()` but not `transform()`" pattern.

**What `validatePipeline` catches vs. misses.** It tests one mid-grey
pixel — enough to catch matrix NaN, gamma NaN, and throwing stages.
It does not catch corruption that only affects extreme values (e.g.
top few entries of a 1D gamma LUT). The v1.8 full Profile deep scan
(NaN/undefined walk of every numeric field) would close that gap.

### Transform identity / NOP detection (shipped)

- **DONE — `detectIdentity` option (default: `true`) + `isIdentity` flag.**
  Adjacent equal-profile pairs are collapsed out of the chain before the
  pipeline is built. If the chain reduces to a single endpoint, identity
  is detected and `create()` builds a copy pipeline instead — no LUT,
  no colour math. `transform.chain` after collapse is `[profile]` which
  self-documents the identity space.
- **DONE — Profile equality: `areSameType` pre-check + three content
  strategies.** `areSameType` (type / channels / PCS / version) gates
  all three: `areSameVirtual` (virtual name), `areSameHash` (FNV-1a
  over the declared ICC byte range — trailing null padding ignored via
  the self-reported size in bytes 0–3), `areSameMatrix` (RGBMatrix
  XYZMatrix + gamma comparison).
- **DONE — `profile.binaryHash` and `profile.virtualName`** set during
  load; `profile.sizeBytes` surfaced from the ICC header for all loaded
  profiles.
- **DONE — `_buildIdentityPipeline()`** builds the codec-only pipeline
  directly (bypasses `createPipeline`); `stage_device2device` shallow-
  copies the device array for mutation safety.
- **DONE — `_kernelCopy()`** handles the full alpha contract (add /
  preserve / strip) and int8 / int16 output types for `transformArray`.
- **DONE — `hasLut()` getter.**
- **DONE — 28 tests** in `__tests__/transform_identity.tests.js`:
  detection via all three strategies, multi-stage collapse, object
  correctness (RGB / CMYK / Lab), int8 / int16 array copy, all alpha
  combinations, pre-allocated buffer, padded-binary hash stability,
  `detectIdentity:false` bypass.
- **Breaking change (as documented).** Same-profile transforms now
  produce exact pass-through instead of a round-trip with rounding
  error. Existing tests that relied on same-profile pairs for LUT /
  kernel testing updated to use `detectIdentity:false`.

**Full design** in [deepdive/Identity.md](./deepdive/Identity.md).

### Fully-bound `transformArrayFn` (dispatch optimisation) — shipped v1.5, **removed v1.6**

> **Removed in v1.6.** The measurement below is the reason: it was never
> faster, and it shipped defaulted off. Once the kernels owned dispatch its
> LUT branch became a wrapper around `kernel.array()`, and identity — the half
> that was doing real work — became `Transform.kernels[0]` with an `array()`
> of its own. `transformArray()` reaches the kernel directly now.
> `bindTransformArrayFn` is accepted and ignored. See
> [deepdive/Identity.md](./deepdive/Identity.md) §6.

`this.transformArrayFn` is set once at the end of `_resolveLutKernels()`
after every `create()` / `setLut()` call.  `transformArray()` checks it
first (before the `pipelineCreated` guard, so the hot path has zero
branches for identity, gray, duotone, and 3D/4D LUT transforms in
`int8`/`int16` format).

- **Identity** → closure delegates to `_kernelCopy`
- **1-channel gray** → closure delegates to `linearInterp1DArray_NCh_loop`
- **2-channel duotone** → closure delegates to `bilinearInterp2DArray_NCh_loop`
- **3D/4D LUT, no WASM split** (`_lutKernelThreshold === 0`) → single direct kernel call
- **3D/4D LUT, WASM split** → one `pixelCount >= threshold` branch then call
- **plugin kernels** → same binding via `_bindLutTransformArrayFn`
- `transformArrayFn = null` for `float` / `device` / `object` formats → falls
  through to the existing full-pipeline loop

`transformArrayViaLUT_legacy()` (the pre-v1.3 if/else cascade kept for one
ship cycle) removed in the same pass after confirmed bit-exact equivalence
across two release cycles.

**Initialised to `_transformArrayNotReady` sentinel** in the constructor so
any code path that sets `pipelineCreated:true` without calling
`_resolveLutKernels()` produces a clear diagnostic message rather than a
silent `TypeError`.

**Future work** — see [Kernel modules by dimension](#kernel-modules-by-dimension)
for the plan to extend `transformArrayFn` to cover all formats and remove
the full-pipeline-loop fallback entirely.

### Kernel modules by dimension — ✅ SHIPPED in v1.5.0 (2026-08-15)

Per-dimension kernel modules live in `src/kernels/{1d,2d,3d,4d,nd}/`.
Each dimension registers a **descriptor** via
`Transform.registerKernel()`; `setKernel()` creates a per-Transform
instance with `Object.create(descriptor)` (one hidden class per
dimension — call sites stay bounded-polymorphic, never megamorphic).
The instance owns the tuned array loops (moved verbatim from
Transform.js), the WASM lifecycle (`create()` settle + demotion,
`release()`), output allocation, and per-call dispatch: BIG/SMALL run
refs are resolved once at create time onto `kernel._runBig` /
`_runSmall` / `_threshold`, so a `transformArray()` call costs one
threshold compare + one indirect call. Transform.js shrank from
15,878 to ~11,000 lines with bench parity held throughout
(~212 MPx/s Node wasm-simd).

Differences from the original plan: descriptor instances with
run-slot resolution replaced the "`getKernel() → always-bound
closure`" shape (binding a full `transformArrayFn` closure measured
no faster for images and slower for tiny batches, so it's opt-in via
`bindTransformArrayFn`), and the planned `BIND_MIN_PIXELS` gate was
dropped for the same reason. Custom kernels plug in via
`Transform.registerKernel()` / `registerLutKernelPlugin()` rather
than `setKernelModule()`.

**As-built documentation:**
[deepdive/KernelContract.md](./deepdive/KernelContract.md)
(`emitKernel()` still reserved for `compile()`; `kernelInfo()` and
per-dimension WASM loading have shipped). The v1.5 modules snapshot
is git history; [KernelModules.md](./deepdive/KernelModules.md) is a stub.

### DeviceLink profile support — ✅ SHIPPED in v1.5.0 (2026-08-15)

DeviceLink (`pClass: 'link'`) profiles load and transform:
`t.create(deviceLink)` runs the single `A2B` tag device→device with no
PCS, handling the full element structure (v2 curves→CLUT→curves; v4
aCurves→CLUT→mCurves→matrix→bCurves, including curves-only linearization
links), asymmetric channel counts (CMYK→RGB, RGB→CMYK), and
`buildLut: true`. Validated against lcms-testbed links (gamma-3
linearization = in³ exactly; 150% ink-limit = lcms's algorithm
reproduced) and the Serendipity null/simple sample links.

Implementation notes: [`docs/DeviceLink.md`](./DeviceLink.md) ·
Tests: `__tests__/transform_devicelink.tests.js`. Real-world DeviceLink
profiles now flow through the bulk ICC oracle (v1.6, below) like every
other profile type.

### N-channel LUT support (5CLR–15CLR) — ✅ SHIPPED in v1.5.0 (2026-08-15)

Hexachrome / 7-ink / spot-colour profiles (5CLR–FCLR) load and transform
in both directions: N-channel→PCS via tetrahedral-on-last-three / linear
peel (Little CMS scheme), and PCS/RGB→N-channel including the fast
baked-LUT image path (3D grid, N output channels, existing `3D→NCh`
array loop).

**5CLR / 6CLR input now has int8 WASM scalar** (`Kernel5D` / `Kernel6D`):
`buildLut` bakes at the profile's own A2B density (9^5, 7^6 — do not
up-res) and `lutMode: 'int-wasm-scalar'` runs `tetra5d_nch` /
`tetra6d_nch`. JS int8 is the bit-exact fallback. **7+ input stays on
`KernelND`**: `provideLut` still returns false, no WASM. Real 7CLR A2B
is typically 5 pts/axis (the press profile on disk); 2–3 pts is only
our 9–15 *fixture* cap — see
[SyntheticProfiles.md § real grids](./deepdive/SyntheticProfiles.md#what-real-profiles-actually-use).
**No int16 / SIMD twins for 5/6.** int8 WASM is 1.6× JS and enough
for proofing; another pair of binaries would ship to everyone for a
HiFi-16-bit input almost nobody uses. `int16` dataFormat lands on
float. Coverage matrix:
[KernelContract.md § Coverage](./deepdive/KernelContract.md#coverage--what-exists-per-kernel).

Implementation notes: [`docs/NChannel.md`](./NChannel.md) ·
Tests: `__tests__/transform_nchannel.tests.js` (7CLR press profile;
physical-sanity assertions until lcms oracle numbers arrive — hexachrome
and 7-ink profiles now produce oracle rows for the ΔE-vs-lcms pipeline).

---

## v1.5.5 — matrix-shaper kernel + pixel cache in the image kernels

> **Status (2026-08-22): items 1, 3 and 4 shipped.** Item 2 stays in v1.6.
>
> | item | status |
> |---|---|
> | 1. Matrix-shaper WASM kernel | **shipped** |
> | 2. Pixel cache in the image kernels | **moved to v1.6** — prototyped, measured, see below |
> | 3. Multicore | **shipped** |
> | 4. Browser sample bench on real-image content | **shipped** — photo with 5 % noise added headline; see below |
>
> **1. Matrix-shaper kernel — shipped, and larger than scoped.** The
> POC was to be "packaged as a kernel descriptor and wired into
> `create()`". What shipped is that plus int16, a bit-identical scalar
> fallback, five alpha entry points, and a new **claiming kernel**
> registration path — because selection by input channel count cannot
> express "is this pair a matrix shaper", and only the built pipeline
> can. 331 MPx/s at int8 on photographic content against ~123 for the
> CLUT, and within 1 LSB of the exact pipeline where that CLUT reaches
> 25. Alpha turned out to matter more than speed: canvas `ImageData` is
> RGBA and was falling to 8 MPx/s, a 40× cliff.
> [deepdive/MatrixShaperKernel.md](./deepdive/MatrixShaperKernel.md)
>
> **3. Multicore — shipped.** 6.2× peak, 787 MPx/s, byte-identical to
> single-threaded in every measured cell, with cancellation,
> backpressure and interrupt.
> [deepdive/multicore.md](./deepdive/multicore.md)
>
> **Measured and dropped: `SharedArrayBuffer` delivery.** Projected
> +30%, spiked at +5–13% at int8 and nil at int16, with the plain-array
> caller case measuring *slower* than today. Not worth two delivery
> paths and a COOP/COEP blocker. `bench/sab_spike/` is kept so the
> question can be re-asked on higher core counts rather than re-argued.

### 2. ~~Pixel cache in the image kernels~~ — MOVED TO v1.6

Prototyped and measured during 1.5.5, and moved out rather than rushed in: it
wants a dispatcher change and eight regenerated binaries, which is 1.6 work.
See [v1.6](#v16--qc-infrastructure--automated-bench-history).

The measurement changed the design twice, so the POC is worth keeping:

- **It goes in the SIMD kernels after all.** The original scoping said "scalar
  only, never SIMD — a scalar check serialises what f32x4 vectorises". That is
  true of a pixel-parallel kernel and `tetra3d_simd` is not one: its lanes are
  the four channels at a CLUT corner, one iteration is one pixel. Ruling out
  the default path was ruling out everybody.
- **The winner is a single entry, not a hash table.** "Did the same bits arrive
  as last time" — one i32 compare, the previous output kept in the v128 the
  kernel was about to store. A 4096-entry hash needs 32 KB to beat it, and only
  on photographs, which is the content this is not for.

### 4. Browser sample bench — retune on real-image content

**Why.** The v1.5 release measurement campaign found that synthetic
content had been quietly deciding our numbers, and the browser bench
(`samples/bench/`, `samples/benchmark/`) still runs the old synthetic
generators. Three findings force a rethink of what it feeds the kernels:

- **Random noise is the worst case, not the representative one.** It
  covers the whole CLUT with no locality at all, which no photograph
  does. Marti Maria's point that our noise input was unrepresentative
  was correct — but his `blocks16` generator is the opposite extreme,
  and neither bracket is a real image.
- **Throughput tracks CLUT locality, not adjacency.** A frame moves
  through colour space in regions — sky, then grass — so the working set
  is small *and sliding*. Reordering the identical 41,077-colour pixel
  multiset moved jsCE SIMD between 96 and 176 MPx/s with nothing else
  changed. A colourful frame should therefore cost more than a
  harmonious landscape, and the bench should be able to show that.
- **Buffer size only matters until the input covers the CLUT.** With a
  properly-distributed input, native lcms RGB→Lab runs 72.6 MPx/s at
  16 K px and 55.9 at 64 K+ — the small buffer simply cannot fill a
  35,937-cell table. Under the old degenerate generator this looked flat.

**Pick content by the question being asked.** The measurement work
settled a taxonomy — three tiers, each answering something different,
and choosing by accident is how the old figures went wrong:

| content | good for | cannot tell you |
|---|---|---|
| **solid / minimal palette**, cache off | testing the *algorithm* — cache pressure eliminated, so a real code improvement shows cleanly rather than buried in memory stalls | anything about real-world throughput |
| **gradients / sweeps** | largely redundant with solid; useful for exercising a pixel cache, though an illustration with a known distinct-colour count is a better controlled test | anything about memory pressure — they prefetch perfectly |
| **anything + 5 % noise** | real-world throughput, and the only figure comparable across machines, because the variable that made results incomparable is deliberately destroyed | the *range* real content spans — that still needs a corpus |

**Shipped (2026-08-22).** `samples/bench/` and `bench/mpx_summary.js`
default to **photo with 5 % noise added** — the strawberries frame
tiled, then 5 % high-bit grain. Past ~3 % every starting content
collapses onto the same plateau; 5 % sits on it without walking as far
into noise.
Chooser also has solid, photo, photo with 15 % noise added (deep
plateau), noise, and
**legacy** (256-colour LCG — do not quote). CMYK workflows use a GRACoL
**separation** of the same frame, not RGB stuffed into four channels.
Photos live in `samples/bench/images/` (copies; release-matrix originals
untouched).

Also on that page:

- **Speed vs Noise** tab — this computer's L1/L2 vs 0–100 % grain; jsCE vs
  lcms vs lcms `NOCACHE`. A Mac will draw a different knee.
- Optional identity rows (sRGB→sRGB / GRACoL→GRACoL) — memcpy ceiling,
  kept out of summary cards.
- `await browserFocus()` — tab blur pauses and discards the poisoned
  hot batch. Primitive: `samples/bench/browserFocus.js`.
- **Pool demo** tab — 15-image queue through `transformImages()`.

Run [`samples/bench/`](../samples/bench/) — the **Speed vs Noise**
tab is why headline content is photo with 5 % noise added. Photo
with 15 % noise added is the same plateau; legacy is ~1.8× faster
because the LCG is L1-resident. Guide: [Bench.md](./Bench.md).

**Still open (does not block quoting photo with 5 % noise added):**

- Adjacency / CLUT coverage next to browser rows (Node
  `bench/release_matrix/` already reports this).
- A stacked multi-photo composite — three separate frames + tiling is
  enough for the headline; a single tall asset would only help the
  corpus-range question.

The Good / Bad / Ugly call-shape page is **archived** to
[`docs/deepdive/good-bad-ugly/`](./deepdive/good-bad-ugly/) — off the
samples index. Lesson in [benchmark.md §20](./deepdive/benchmark.md);
its pixels are the old LCG.

### RGB matrix-shaper fast path — fused gamma + matrix + curves

**Progress so far (shipped in v1.5.0):**

- **Matrix fuse** — already shipped in v1.3 `optimisePipeline()`.  Adjacent
  `stage_matrix_rgb + stage_matrix_rgb` pairs are collapsed into one combined
  3×3 multiply automatically for any profile chain of any length.
- **`useCurveLut` option** — shipped v1.5.  Replaces `Math.pow` / `sRGBGamma`
  calls with a 4096-entry `Float64Array` lookup (matching lcms2's
  `PRELINEARIZATION_POINTS 4096`).  ~14% faster on the no-LUT accuracy path.
  Default `false` (opt-in); error is ≤ 0.03 LSB at u8 output — imperceptible.
  Build: `stage_gammaTable` + `_buildGammaInvLut` / `_buildGammaFwdLut`.
- After `optimisePipeline()` with `useCurveLut:true` the composed pipeline is:
  `stage_gammaTable → stage_matrix_rgb (fused) → stage_gammaTable` (3 stages).

**Remaining gap:** The no-LUT path still sits at ~15 MPx/s JS.
lcms2 `fast-float` reaches ~455 MPx/s via a SIMD-compiled fused loop.
Closing that gap requires a WASM SIMD kernel — see below.

**Context.** Benchmarking against the lcms2 `fast-float` plugin (see
[Performance.md — Steelmanning the steelman](./deepdive/Performance.md#steelmanning-the-steelman--fast-float-measured-directly))
found the one workflow class where jsCE currently loses: RGB→RGB
matrix-shaper transforms (sRGB↔AdobeRGB etc.), where fast_float runs
a fused 3×3 matrix multiply at ~455 MPx/s while jsCE's general-purpose
LUT pipeline reaches ~216 MPx/s WASM SIMD and ~72 MPx/s pure JS.
jsCE routes all transforms through the CLUT pipeline regardless of
profile type. A fused matrix path would close — and potentially
reverse — that gap.

**What "fused" means.** A matrix-shaper ICC profile is three stages:
`input curves (gamma/sRGB) → 3×3 matrix → output curves`. When both
src and dst are matrix-shaper, the composed transform is:
```
dst_curves_inverse( dst_matrix × src_matrix_inverse × src_curves(x) )
```
That collapses to nine multiply-adds per pixel plus two curve
evaluations — no LUT grid traversal, no tetrahedral interpolation.

**Identity passthrough.** The fused path must include an identity
checker at `create()` time:
- Compose `dst.matrix × src.matrix⁻¹` into a single 3×3
- If the result is ≈ I₃ (within floating-point tolerance) AND the
  curves cancel (both linear, or src curves = inverse of dst curves)
  → route `transformArray` to a typed-array copy. lcms2 has a similar
  bypass and triggers it for sRGB→sRGB; failing to match this is a
  known source of benchmark surprises (measuring memcpy throughput
  instead of CMS work).

**Starting point — existing emitters in `Transform.js`.**
The compile framework already has what's needed:
- `emit_js_stage_Gamma_Inverse` — emits a compiled gamma/sRGB
  inverse with optional 4096-entry LUT substitution for `Math.pow`
  (controlled by `useGammaLUT` option, partially implemented).
- `emit_js_stage_matrix_rgb` — emits a 3×3 matrix multiply with all
  coefficients baked as numeric literals for V8 optimisation.
Both are active emitters wired through the `compile()` dispatch loop.
The fused path is stitching them together in a single emitted function
(no pipeline overhead between stages) and wiring it into the LUT-mode
dispatch when both profiles are detected as matrix-shaper at `create()`.

**Adaptive gamma strategy — benchmark the actual curve at create time.**
`useGammaLUT` is currently hardcoded `true`. It should be decided per
transform, per host, using the actual profile curve — a one-shot
microbench at `create()` on the real curve data:

```js
function benchGammaCurve(curve, sampleSize = 1000) {
    const input = new Float64Array(sampleSize)
        .map((_, i) => i / sampleSize);
    const t0 = performance.now();
    for (let i = 0; i < sampleSize; i++) evalCurvePow(curve, input[i]);
    const powTime = performance.now() - t0;
    const t1 = performance.now();
    for (let i = 0; i < sampleSize; i++) evalCurveLUT(curve, input[i]);
    const lutTime = performance.now() - t1;
    return lutTime < powTime ? 'lut' : 'pow';
}
```

Run once per curve at `create()` time (~0.1 ms), bake the winner into
the emitted function as a literal. Rationale:
- `Math.pow` speed varies by engine and CPU — on some hosts it's a
  native instruction; on others it's a software fallback that the LUT
  easily beats.
- The 4096-entry LUT is ~32 KB; whether it's L1-resident or not
  depends on the host's cache configuration and what's already hot.
- The curve type matters: sRGB piecewise is structurally different
  from a plain power-law; the right winner differs per curve and
  per host.
- The benchmark uses real profile input values (uniform [0, 1]), not
  synthetic data, so the winner is the winner for this specific
  transform on this specific machine.

This replaces the current static `useGammaLUT: true` default with a
correct-by-measurement answer. The emitted source string is identical
either way — only the inline expression changes (`lutTable[i]` vs
`Math.pow(x, g)`). Zero runtime cost after `create()`.

**Full gamma decision tree — selected once at `create()`, baked into
the emitted function.**

| Curve type | Emitted path | Cost per pixel |
|---|---|---|
| `γ = 1.0` (linear) | **Stage skipped entirely** — emit nothing | 0 |
| sRGB piecewise | Inline piecewise formula (literal constants) | ~4 ops |
| Power law `γ ≠ 1.0` | `benchGammaCurve()` → LUT or `Math.pow` | LUT: 1 load; pow: host-dependent |

The linear case (`γ = 1.0`) is the most important bypass: if both
src and dst have linear gamma, the entire gamma stage pair disappears
from the emitted function — only the 3×3 matrix multiply remains.
Combined with the identity check:
- Linear gamma + identity matrix → **memcpy** (full passthrough)
- Linear gamma + non-identity matrix → **matrix-only** (no curve ops)
- Non-linear gamma → **matrix + curves** (full fused path, strategy
  selected by curve type and microbench)

**Micro-bench needed first.** Before integrating into the main
dispatch, add a micro-bench in `bench/` measuring:
- jsCE fused-matrix emitted JS (`new Function`, existing compile path)
- jsCE fused-matrix WASM kernel (new, see below)
- lcms2 vanilla C (~157 MPx/s, `bench/lcms_c/`)
- lcms2 + fast_float (~455 MPx/s, `bench/lcms_c/ make fastfloat`)

If the emitted JS gets within striking distance of fast_float (or
beats it), the WASM kernel is still worth building; if pure JS
already wins, WASM is a tighter-loop refinement rather than a
prerequisite.

**WASM SIMD kernel — matrix-shaper kernel module.**

The SIMD matrix-shaper path is the natural first use-case for the
kernel-module architecture that shipped in v1.5.0 (as-built now
[deepdive/KernelContract.md](./deepdive/KernelContract.md)):

- A `kernel3D_matrix_shaper` descriptor is registered via `Transform.registerKernel()`
- Its `buildLut(lutMode)` checks `inputProfile.isRGBMatrix && outputProfile.isRGBMatrix`
  and chain length — if both are matrix-shaper it returns a **stub LUT** containing
  `{ gammaDecLut, matrix3x3, gammaEncLut }` instead of a CLUT.  Returning `null`
  falls through to the normal CLUT build; returning `false` uses the no-LUT pipeline.
- The kernel's run method (`int8_simd` variant) does:
  - 3 × 1D gamma LUT lookups (decode input)
  - 3×3 matrix multiply with baked numeric coefficients (9 `f32x4.mul` + 6 `f32x4.add`)
  - 3 × 1D gamma LUT lookups (encode output)
  - Processes 4 pixels at a time with v128 SIMD
- Same channel-parallel SIMD approach as the existing CLUT kernels (~216 MPx/s)
- `int8_scalar` and `int8_js` fallback variants follow the same shape without SIMD
- Demotes gracefully: if host has no SIMD, `create(lutMode)` returns `'int8_js'`

No changes to `transformArray()` or Transform.js dispatch — the kernel module
architecture handles everything. Non-matrix profiles (`GRACoL`, etc.) still route
to the existing CLUT kernels unchanged via `buildLut()` returning `null`.

**Acceptance criteria.**
- Identity check: `sRGB → sRGB` routes to memcpy (verify with bench,
  no CMS arithmetic in the hot loop).
- Matrix-shaper detect: `sRGB → AdobeRGB`, `sRGB → ProPhoto`,
  `AdobeRGB → sRGB` all use the fused path.
- Non-matrix profiles (GRACoL, etc.) still route to the existing CLUT
  kernels unchanged.
- Bit-exact against the current float pipeline within the same ΔE
  tolerance used by the u8 CLUT path (≤ 1 LSB at u8).
- Measured throughput beats vanilla native lcms2 (~157 MPx/s) in
  pure JS; WASM variant targets parity with or beyond fast_float
  (~455 MPx/s).

### One-pixel memo cache for the LUT kernels — performance experiment

lcms2 memoizes the last-seen input pixel inside `cmsDoTransform` and
it's worth 2–3× on photo-like content with flat runs, up to ~5× on
solid fills where every workflow converges to a ~160–170 MPx/s
cache-hit ceiling (measured 2026-08 — see
[LcmsComparison.md § First re-measurement data](./LcmsComparison.md#first-re-measurement-data--input-content-matters-23-aug-2026)).
jsCE's kernels are content-neutral: every pixel pays full
interpolation.

**The experiment:** add a one-entry cache to the 4D paths (compare 4
input bytes vs the previous pixel, copy the previous output on hit)
and bench it across the three content generators (noise / gradient /
solid) **plus a real-image corpus** — the open question is how often
real photographic content produces *byte-identical* adjacent pixels
(sensor noise and JPEG artifacts break exact equality; flat synthetic
content — UI, logos, vector fills, page backgrounds — is where runs
actually live). On pure noise the cost is one compare+branch per
pixel (lcms pays the same and still posts its noise numbers, so the
downside is bounded). Ship only if the real-image numbers justify
it; per-kernel opt-in via the descriptor fits the kernel-module
architecture.

✅ **SHIPPED IN v1.5.0 (beta), not v1.5.5** — `src/cache.js`,
opt-in via `pixelCache: 0|1|16|32`, `getPixelCacheStats()` for hit
counting, tests in `__tests__/pixelcache.tests.js`, bench and
output-verification in `bench/pixel_cache/`.

**Measured, and the original hypothesis held.** On whole
full-resolution photographs the cache hits 3–41 % and runs between
0.84× and 1.05× — break-even at best. The clear win is graphic
content: a flat-colour poster hit 67 % at 1.22×, and synthetic solid
/ checkerboard content reaches 3.2×. Pure noise is the floor at 0.82×.
(An earlier reading of 59–83 % on photographs came from two properties
of the test set rather than of photographs: the bundled samples are
AI-adjusted rather than shot, and capping the pixel count crops the top
of the frame instead of sampling it. Both are written up in
[deepdive/PixelCache.md](./deepdive/PixelCache.md).)

**Where the cost goes.** Decomposing the ~18 % miss tax: ~6.5 points is
bare pipeline-stage dispatch, ~8 points bookkeeping, and only ~3 points
the hash. Table size is free — 4096 slots costs no more than 32 — so
the tuning question is on/off and content, not size. Break-even is
~38–40 % hit rate.

**The kernel port stays open, and 4D/CMYK is the best target.** An
unrolled kernel has no stage dispatch, so the dominant cost here
disappears; modelling puts kernel break-even in much the same range,
with the 4D kernel most attractive because heavier per-pixel work
dilutes the check. That is a model, not a measurement — a POC on one
kernel would settle it. Unmodelled risk: register pressure across the
interpolation cascade, where JitInspection already found pressure
binding.

**Recommendation for users today:** enable on CMYK destinations with
graphic or flat content, leave off for RGB→RGB photographic work, and
check `getPixelCacheStats()` on your own data rather than trusting
ours.

**Design space captured in
[deepdive/PixelCache.md](./deepdive/PixelCache.md)** (2026-08-16,
predating the measurements above): three shapes — single-value memo, two-entry rotating memo
for dither, and a 32/64-slot direct-mapped table — with the JS
mechanics (u32 key packing fused into existing loads, interleaved
`Int32Array`, golden-ratio hashing), the honest cost table, and the
working hypothesis that **the accuracy path is a better target than
the tuned kernels** (payoff scales with the work a hit skips). Also
raises `new Function()` codegen for the cache-config matrix, so
variants bake their config as literals instead of being all-or-none.
First step is a hit-rate counter over a real corpus — no kernel work
required.

---

## v1.6 — QC infrastructure + automated bench history

> **Theme.** Distill the lcms patches into a regen-able form, then
> use them to bulk-generate oracle `.it8` targets and run automated
> pass/fail QC across every ICC profile in a corpus.  Add automated
> bench recording so every version bump captures a Node throughput
> snapshot — regressions become visible before they reach users.
> (DeviceLink and N-channel support, originally filed here, shipped
> early — see [v1.5](#v15--polish-validation-and-fast-paths--shipped-in-v150).)
>
> **Also carried in from 1.5.5: the in-kernel pixel cache**, now in
> `create()` — `compile_kernel_wat.js` injects `interp_*_cached`;
> the loader binds it when `pixelCache !== 0`. The **accuracy-path**
> knob (`pixelCache: 'auto'`) is a different implementation of the
> same hint. Findings:
> [PixelCache.md](./deepdive/PixelCache.md#as-built-2026-08-23--in-kernel-export-in-create).
> Native C IT8 matrix testing is next, not a 1.6 gate.

### One home for the numbers — `docs/BenchResults.md`, generated ✅ built

Throughput figures used to be quoted in the README, `Performance.md`,
`LcmsComparison.md`, `pool.md`, the CHANGELOG and four deepdives. Nothing linked
them, so a re-measurement meant finding every copy by hand — which is how a
page ends up carrying two vintages of the same number at once.

The shape to build, alongside the bench-recording work above:

1. **The benches emit data, not prose.** Each writes JSON to
   `bench/results/`, which several already do (`multicore_matrix.json`).
2. **One generated page** — `docs/BenchResults.md` — renders those into tables,
   each with a stable id, the machine, the date and the harness that produced
   it. Generated, never hand-edited, regenerated by one command.
3. **Every other page links to a table rather than restating it.** Prose keeps
   the *finding* ("the kernel scales worse than the CLUT, necessarily"); the
   page owns the *figures*.
4. **A reference index at the foot of the generated page** listing which
   documents cite which table, built by scanning for the ids. That is what
   makes a re-measurement finite: regenerate, then walk the index for the
   handful of places carrying a headline number in prose.

Images (SVG/PNG) were considered for this and rejected: a reader cannot copy a
number out of a picture, and a diff cannot show what moved.

**Built on 2026-08-20**, ahead of the rebuild for exactly that reason: the
rebuild is the event that invalidates every quoted figure at once. `emit.cjs`
is wired into the release matrix, the pixel cache, the matrix-shaper benches,
the pool matrix and the solo control; `bench/reproduce.js` runs all of them and
each writes its own JSON. Still to wire: the native C harness (its numbers are
parsed from text) and the one-off POC benches, which are history rather than
published figures.

### Web Worker pool for browsers — landed

`transformImages()` uses `worker_threads` under Node and `Worker` in a
browser. The fragment queue, out-of-order reassembly, cancellation and
`interrupt()` were always platform-neutral; what shipped is the packaging:

1. **`browser/jsColorEngineWorker.js`** — engine plus the `poolWorker`
   protocol (`npm run browser` builds it).
2. **A URL the app supplies** — `Transform.enablePool({workerUrl})` or
   `globalThis.JSCE_WORKER_URL`. A library cannot know its own URL.
3. **`Pool.start()`** picks `new Worker(url)` when `worker_threads` is
   stubbed.
4. **CSP / missing URL** falls back to sequential, same as every other
   failure path.

The bench **Pool demo** tab is the first in-browser exercise. Worth
measuring separately: a tab's memory ceiling is lower than a server's,
and per-worker LUT copies are the pool's dominant cost.

### Accuracy-path `pixelCache: 'auto'` — shipped

`src/cache.js` is no longer caller-only. Default is `'auto'`.
Transform ignores that string; `init()` may change it to `1`.
Kernel4D / 5D / 6D do; Kernel3D and everyone else leave it.
After init, `_applyPixelCache()` injects if the value is then a
number > 0. `pixelCacheUsed` is what ran.

`array()` still uses the kernel when one is bound — auto must not
steal the WASM image path. A 2+ slot table is **not** what auto
picks; pass `256` yourself when you know the work is a palette.
Why: [PixelCache.md § Why auto is 1, not a 2+ table](./deepdive/PixelCache.md#why-auto-is-1-not-a-2-table).

The in-kernel export is the next section — same hint, image path.

### In-kernel pixel cache — shipped (same `pixelCache` hint)

A single-entry cache inside the CLUT kernels: *"did the same bits arrive as
last time, so the same bits can leave"*. Not "have I seen this colour" — it
never interprets the pixel, which is why one insertion covers int8, int16, RGB
and RGBA, and why the scalar and SIMD versions are the same twenty lines.

**Measured** on `tetra3d_simd`, paired exports, all outputs byte-identical to
the shipped kernel:

| content | cached ÷ shipped |
|---|---:|
| solid | **3.07×** |
| logo, 5% mark on white | **2.40×** |
| logo, 30% mark on white | **2.57×** |
| ILLUSTRAT | 1.04× |
| photographs | 0.93–0.96× |
| noise | 0.99× |

**On with `'auto'`.** Chrome 151, this machine: a clean photograph
is a ~10 % boost; a photograph with 5 % noise added is the worst
case (~4 % tax); solids **up to 3.94×**. 5D photo is the outlier
(0.84×) — leave `pixelCache: 0` on that cell. `0` is the uncached
export; there is no separate kernel flag.

**Shipping shape — compile-inject, not a runtime mode, not eight
hand-copied binaries.** Behind a `$cacheMode` parameter the *uncached*
path measured 15–22% slower, and got worse when a third mode was
added: the cost is the code behind the guard, not the guard. A single
mode compare was worth ~10% on its own.

So the `.wat` stays the single source of truth.
`scripts/compile_kernel_wat.js` copies the function verbatim, then
injects a cache snippet at the four `;;Inject:*` comments (same
names on every shape) and compiles with wabt. The POC builder still
emits table variants for benches:

```
interp_tetra3d_simd          the shipped kernel, byte for byte
interp_tetra3d_simd_cached   the same, plus two locals
```

The uncached export measures 0.985–1.008× against the shipped binary —
a tie, because there is no cache code in it to pay for. Enabling the
cache is swapping a function reference; the signature does not change.

**Single-entry is the kernel product.** A hash table (2…4096) was
measured beside it: slower than single on flats, and a worse miss tax
on photo/noise (~8–15% vs ~2%). It would only win on an illustration
with a small palette of *non-adjacent* repeats — an edge case you
cannot auto-tune. Keep the table snippet in the POC builder; do not
wire it into `create()`. `'auto'` binds the single-entry export on
every WASM 3–6 kernel that has one. The accuracy-path `'auto'`
above is a different *implementation* of the same hint.

The accuracy-path table (`pixelCache: 16|32|4096` in `src/cache.js`)
is a different feature — it skips a stage walk, not a tetrahedral
gather. Same option name; `pixelCacheUsed` vs `kernelInfo().cache`.

If a table variant is ever wanted, it is a **second snippet** on the
same anchors (`_cached_table`), compiled as a third export — not a
parameter. Same rule as `$cacheMode`: do not put the unused path in
the binary the hot loop sees.

**Work remaining:**

1. ~~Fold the generator into the real WASM build.~~ **Shipped.**
   `scripts/compile_kernel_wat.js` injects single-entry only.
   Table exports stay in `bench/pixel_cache_wasm/build_paired.js`.
2. ~~Dispatcher.~~ **Shipped.** `pixelCache !== 0` (including
   `'auto'`) binds `_cached` when the export exists. Missing export
   is a silent decline. `kernelInfo().cache` is `'not-supported'` |
   `'off'` | `1` | `N`.
3. ~~Load one WASM family instead of both.~~ **Shipped.**
   `src/wasm/instantiate.js` is the only compile path and must not
   `require` any kernel `.wasm.js`. `wasmLadder` is functions; SIMD
   scalar `alsoLoad` only when `outputChannels ∉ {3,4}`. Transform
   yields, then the winning kernel `create(lutMode)` — a matrix-shaper
   pair never compiles tetrahedral WASM.
4. ~~Name.~~ **Superseded.** One hint, two implementations
   (pipeline vs `interp_*_cached`). A second option would have been
   worse than sharing `pixelCache`.
5. **TODO later — two-register double, not a 2-slot table.** Last
   two keys as locals, two compares. Never written. Do not treat the
   hashed-array arms (8…4096) as a test of it. Design note:
   [PixelCache.md § two-register double](./deepdive/PixelCache.md#2-two-register-double--last-two-pixels-todo-never-built).

POC: `bench/pixel_cache_wasm/` (`hitrate.js`, `build_paired.js`,
`run_paired.js`). Design notes, and how the "never in SIMD" exclusion
came apart:
[deepdive/PixelCache.md](./deepdive/PixelCache.md#simd-here-is-parallel-interpolation-not-parallel-pixels).

### Automated profile oracle — build on synthetics

The TOC item was written when the gap was "no second CMS for 1 / 2 /
5–15 channels." That hole is closed.
[SyntheticProfiles.md](./deepdive/SyntheticProfiles.md) already ships
fifteen dual-table profiles, every input width into every output
width, both depths, compared to LittleCMS.

v1.6 oracle work **starts there**, not with a licensed RGB/CMYK
corpus or a regenerated `lcms_patch`:

1. Promote `accuracy_nchannel.js` (and the gray / nCLR writer) from
   a bench you run by hand into a gate — same shape as
   `bench/reproduce.js` phases.
2. Keep the RGB/CMYK LittleCMS comparison as the *real-profile*
   oracle it already is ([LcmsComparison.md](./LcmsComparison.md)).
3. A bulk `.it8` dump of every file in a private corpus is a later
   widening. It needs `lcms_patch/` regen and profiles we cannot
   commit. Synthetics do not.

Do not wait for (3) to call the width-coverage oracle done.

### Matrix shaper — per-channel TRCs, and a hot JS path

Two separate items that got conflated once and should not be again.

#### 1. Per-channel TRCs in the WASM kernel

The kernel keeps ONE input table and ONE output table, shared across R/G/B, so
it declines a profile whose `rTRC`, `gTRC` and `bTRC` genuinely differ. Note
this is a NO-LUT problem only: `createLut()` walks the grid through the gamma
stages, so a CLUT has per-channel curves baked into its samples and needs no
guard — which is exactly why the WASM LUT kernels can be pure interpolators.
Confirmed by the built pipeline, which for `buildLut: true` is two stages,
`tetrahedralInterp3D` then `stage_device3_to_int`, with no curve stage at all.

**Nearly free at runtime.** The generator already emits R, G and B as separate
code, so a per-channel table is a change to a compile-time constant offset —
no branch, no extra instruction. The cost is memory and build time.

**At int8, just always carry three.** One binary, one code path, no `inspect()`
branch to get wrong, and one fewer reason to decline:

| | today | with 3 curves | where it lives |
|---|---:|---:|---|
| int8 | 1 KB + 64 KB = 65 KB | 3 KB + 192 KB = **195 KB** | L2 either way |
| int16 | 256 KB + 256 KB = 512 KB | 768 KB + 768 KB = **1.5 MB** | L2 → past it |

65 KB already overflows L1, so both int8 sizes sit in L2 and the marginal cost
should be small. **At int16 it is not "light on memory"** — 1.5 MB is past L2
on many parts, and it triples a table build that already costs ~8 ms. Measure
that one before committing; two binaries remain the fallback if it bites.

The path that would feel a bigger table is the SCALAR one, not SIMD: the int8
scalar kernel measures 209 MPx/s on solid against **72 on noise**, a 66% swing
caused entirely by random access into the 64 KB output table. SIMD moves 4%
(346 vs 333) because twelve independent gathers hide the latency.

**But no profile in the testbed trips it.** Probing every RGB profile in
`testbed/profiles/rgb/`, the guard fired zero times. Three declined for an
unrelated and already-documented reason — `sRGB2014.icc`, `sRGB Color Space
Profile.icm` and `sRGB_v4_ICC_preference.icc` are LUT-BASED profiles, so the
pipeline is not a matrix shaper at all. The remaining five were all claimed.

So this is coverage insurance, not a measured win. The workload that would
justify it is a **calibrated display profile**, where distinct R/G/B curves are
plausible — and there is not one in the testbed. **Get one and measure before
building**; if real monitor profiles do carry differing curves, this stops a
soft-proof at default settings falling to ~9 MPx/s, which would make it the
same shape of cliff as RGBA was.

#### 2. ~~A hot JS matrix-shaper path~~ — SHIPPED in 1.5.5

Same fused 3×3 and the same curves off `stage_matrix_rgb.stageData`, in plain
JS — and unlike the WASM kernel it can carry three curves without thinking
about it, because JS has no table-size pressure.

`bench/js_matrix_shaper/run.js`, 1 MPx noise, `*prophoto → *sRGB`:

| variant | int8 | int16 | max LSB (8 / 16) |
|---|---:|---:|---:|
| stage pipeline | 8.2 | 8.1 | — |
| exact, linear output index | 61.3 | 58.5 | 1 / **7** ✗ |
| **exact, quartic output index** | **62.3** | **56.3** | **1 / 1** ✓ |
| flat multiply, device-indexed curve | 47.2 | 46.6 | 2 / **360** ✗ |
| WASM kernel, for scale | 329.3 | 219.8 | 1 / 1 |

**7.5× the pipeline, ≤ 1 LSB, one function for both depths.** The shape:

- **Input: a table indexed by the raw code.** Exact — one entry per possible
  input — and already generic, because `iT[px[p]]` is the same source at both
  depths; only the table length changes (256 vs 65536), which is data.
- **Output: the quartic index**, same as the WASM kernel. A linear index gives
  7 LSB at int16 with 70,625 samples over 1, for the reason set out in
  `build_matrix_shaper_wasm.js`. Two `Math.sqrt` per channel cost nothing —
  at int8 the quartic variant is the FASTEST of the lot, because the loop is
  bound on table-lookup latency and `sqrtsd` disappears into its shadow.
- **Rejected: normalising with a flat `1/255` or `1/65535` multiply** and
  indexing a 4096-entry device-indexed curve. It buys the same genericity the
  code-indexed table already gives, and costs 22% and the accuracy budget.

**Three V8 lessons that did NOT transfer from the tetrahedral kernels:**

- *"No intermediate variables"* does not apply. Adding three more locals for
  the output values measured 61.1 against 61.3 — free. The documented spill
  problem is a GPR problem, and these are doubles: nine coefficients plus six
  values sit in the 16-register XMM file and never compete with the pointers.
  The 4D kernel spills because it wants 13-15 GPR values; this wants three.
  Taken literally the rule is a 7% LOSS — recomputing to avoid naming means
  nine input lookups per pixel instead of three.
- *Manual unrolling* is worth 3% here (60.5 vs 58.7 rolled), not the
  load-bearing lever it is in the tetrahedral kernels. V8's threshold is about
  large functions; a three-iteration channel loop over a small body is not one.
- *Address arithmetic does not matter either.* `p, p+1, p+2` against
  `p++, p++, p` against a running pointer with no multiply: 62.3 / 63.0 / 62.5
  at int8, 56.6 / 57.5 / 57.6 at int16. All within noise.

**Why every micro-choice measured flat.** The loop is bound on a dependent
load chain — `px[p]` → `iT[…]` → arithmetic → `qT[idxQ(…)]` — two dependent
table lookups per channel, the second a scattered access into 128 KB. The
multiplies, the extra locals, the square roots and the address maths all hide
underneath it. If this ever needs to be faster, the lookups are the target,
not the code shape around them.

- *Not a small-batch arm.* The CLUT paths have
  `WASM_DISPATCH_MIN_PIXELS = 256` because a 214 KB upload cannot pay on a
  short call. The WASM matrix shaper's fixed cost is ~0.15 µs and it beats the
  pipeline **from four pixels up** — 2.3× at 4, 10× at 16, 35× at 64 K. It
  loses only at one pixel, which is the accuracy path's job.

**Shipped** as `src/kernels/matrixShaper/matrixShaperJS.js`, chosen by
`build()` whenever there is no WASM variant to use — which is exactly the two
cases above. `useVariant('js')` pins it for tests and benchmarks.

## v1.7 — Compiled non-LUT pipeline + `toModule()`

> **Scope.** This is **the largest single piece of post-v1.4 work**.
> Code-generation for non-LUT transforms, the `getSource()` /
> `toModule()` distribution story, and the POC `compile()` options
> that already exist as a measurement vehicle. Moved here from the
> original v1.5 to give the v1.5 polish items and v1.6 QC work room
> to ship first.
>
> **Scope reframe (Apr 2026, post-POC).** Originally "WASM SIMD for
> matrix-shaper transforms", then broadened to "code generation for
> non-LUT pipelines + smarter `'auto'`". The
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
> - The **WASM emit target is deferred to v1.7+**. Worth keeping on
>   the radar (the 1D POC ceiling stands), but the dev complexity
>   no longer pays back for the workload that actually benefits.
>
> Headline order is now: (1) finish stage-emitter coverage,
> (2) ship `getSource()` / `toModule()`, (3) document the
> coverage matrix, (4) stay opt-in (do NOT auto-route in
> `'auto'` yet — LUT modes remain the default for bulk image
> work). *(The kernel-modules groundwork this depends on shipped
> early, in **v1.5.0** — see
> [v1.5](#v15--polish-validation-and-fast-paths--shipped-in-v150).)* See
> [deepdive/CompiledPipeline.md § Should we ship this](./deepdive/CompiledPipeline.md#should-we-ship-this-as-default--honest-assessment)
> for the full reasoning.

### Per-Transform microbench for `'auto'`

The `'auto'` heuristic is currently static: the `create(lutMode)` demotion chain
in each kernel module resolves SIMD → scalar → JS based on capability flags.
In practice on weaker CPUs the JS `'int'` kernel can edge out `'int-wasm-scalar'`
for small (17³) LUTs — WASM JIT warm-up and call overhead eat the scalar win.

**Why defer to v1.7.** With kernel modules, `'auto'` selection moves into
`kernel3D_create(lutMode)` — the kernel module owns capability detection.
A microbench written for the v1.5 static demotion chain would be discarded
entirely when the kernel module architecture lands.  The right place for
this is inside each kernel descriptor's `create()` method, measuring the
actual loaded WASM state against the JS fallback on the real host.

**Idea.** At the end of `kernel3D_create()`, run a 200-pixel timing trial
on each available variant and compare.  Return the winner instead of the
statically-demoted mode.  `'auto'` would then pick the right answer for
this combination of host + LUT shape + kernel availability.

**Cost.** ≤ 5 ms added to `create()` in exchange for a guaranteed best kernel.

**When to ship.** Kernel modules have landed (2026-08-15), so this is
now unblocked — the natural home is each kernel descriptor's
`create()` method (`src/kernels/{3d,4d}/KernelXD.js`), which already
owns WASM settle/demotion and returns the settled mode.

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
   `lutMode: 'fast-jit'` (or similar) and call it a preview.
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
measurement vehicle for the larger v1.7 effort:

```js
t.compile({
    target:      'js',     // emit target — only 'js' for now (WASM is the v1.7 backend)
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

These are POC-shipped, not the final v1.7 contract. The v1.7 work
generalises this to:
- multi-channel input preambles (CMYK input, not just RGB),
- emitters for the remaining stages (`tetrahedralInterp4D`,
  `stage_PCSv2_to_PCSv4`, adaptation, absolute-intent),
- `getSource()` / `toModule()` (above),
- a WASM emit target sharing the same stage-emitter shape.

---

## v1.8 (optional) — Hardened profile decode

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
2. **New features are more visible.** v1.7's `toModule()`, v2's
   N-channel inputs, and LUT hooks all have immediate user value; hardening
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

Until then, v1.8 is a skippable release slot — documented here so
the scope is clear when the time comes.

---

## v2 — Separation of concerns: split Transform + Pipeline + Interpolator

Deferred; direction is worth capturing because the v1.2 architecture
already sets it up cleanly and the v1.7 code-generation work
sharpens the split further (by turning "pipeline" from a Transform
method into a family of emitted functions).

### N-channel float inputs (5 / 6 / 7 / 8-channel input profiles)

> **Largely superseded (2026-08-15).** N-channel (5CLR–15CLR)
> support shipped in v1.6 — see
> [the shipped entry above](#n-channel-lut-support-5clr15clr---shipped-in-v150-2026-08-15)
> and [docs/NChannel.md](./NChannel.md). Both directions work today:
> n-ink input runs the per-pixel pipeline via the generic N-D
> simplex interpolator (`buildLut` is declined for n-ink *input* by
> design), and n-ink output gets the full baked-LUT image path.
> What remains of this v2 item is only the optional fast path it
> proposed: a **float N-D LUT bake for N-channel input** — still
> deliberately unshipped for the reasons below (grid^N memory, no
> high-throughput use case), and now measured against a working
> pipeline instead of a gap.

**Original analysis (kept for the trade-off record):**

**Today.** jsColorEngine's float (`lutMode: 'float'` /
`buildLut: false`) and `'int'` paths handle 3- and 4-channel input
device profiles at speed. For inputs with 5 or more channels (the
2C / 3C RISO MZ770 spot profiles in the lcms-compat suite, plus
real-world multi-spot CMYKOG / Hexachrome / 7-colour press profiles),
the engine produces correct output through the per-pixel pipeline,
which has no input-channel limit. What it doesn't do is build a fast
LUT for them.

**v2 adds:** `tetrahedralInterpNDArray_*Ch_loop` (the float
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
- **`@jscolorengine/pipeline-emitter`** *(new, if v1.7 ends up big
  enough)* — the code-generator from v1.7. Takes a pipeline spec,
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
4. **v1.7 complete:** non-LUT pipeline code generation lands. The
   split isn't just "LUT interpolator vs the rest" anymore — it's
   "LUT interpolator vs emitted pipelines vs color-science front-
   end". That three-way split is the target package shape.
5. **v2 split:** extract `@jscolorengine/interpolator` (and maybe
   `@jscolorengine/pipeline-emitter` if v1.7 ends up big enough) to
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
  added on top of any kernel later. Will revisit post-v1.7 once
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

The 1D WASM POC drove the original v1.3 / v1.5 split. Both plans have since
been overtaken — v1.3 (WASM scalar) landed in v1.2, and v1.5's
matrix-shaper-only plan was subsumed by the code-generation target above —
but four of its findings still shape decisions here:

1. **WASM scalar beat JS by 1.84×** on a gather-heavy kernel, from removing
   bounds checks and overflow guards rather than from better arithmetic.
   Shipped as `'int-wasm-scalar'`.
2. **SIMD gathering across *pixels* was slower than scalar** (0.89×), because
   WASM has no gather instruction. That ruled SIMD out for LUT kernels until
   the axis was flipped to channels, which measured 3.25×.
3. **SIMD on no-gather maths ran 67.7× JS**, which is the ceiling any emitted
   non-LUT pipeline is aiming at.
4. **`Math.imul` is no longer a speed optimisation** in modern V8 — plain `*`
   emits the same code. Still useful against accidental float promotion.

The full analysis, with the POC table and the instruction-mix breakdown, is in
[Performance § 5](./deepdive/Performance.md#historical-record-original-v13--v15-analysis-1d-wasm-poc);
raw results in `bench/wasm_poc/README.md`. It is not repeated here.

---

## Research and analysis

Not tied to a release version — these are investigations, benchmarks,
and infrastructure that can land at any time and inform future
feature work. Useful to do, not gated on shipping a version number.

### LUT grid size sweep — `lutGridSize` analysis

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

**Bench work needed before shipping as a feature:**

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
4. Document the sweet spots in Performance.md — likely 33³ for
   3D and 21⁴ or 25⁴ for 4D, but let the numbers decide.

**If the analysis justifies a feature:** expose as
`lutGridSize: 17 | 25 | 33 | 49 | 65` at `Transform.create()` time.
Default `undefined` = use the profile's native `clutPoints`. Upper
bound enforced (refuse 65⁴ — 143 MB breaks everything).

**Expected win:** at 33³ vs 17³ on a GRACoL profile, ΔE₀₀ max
should drop from ~0.4 to ~0.1 in the saturation corners, for zero
per-pixel cost — the LUT is built once, evaluated the same way.

### Non-uniform LUT grid (√ and cubic) for RGB-input workflows

Non-uniform grid spacing that concentrates grid points in
perceptually-critical zones (shadow / highlight regions where
standard uniform grids waste resolution). Two candidate spacing
functions: √-spaced (dense near black, sparse near white) and
cubic-spaced (dense at both extremes). Requires changes to the LUT
builder and the tetrahedral interpolation kernel (non-uniform stride
lookup). Under investigation — details will be published when
analysis is complete.

---

## Dropped

Items that were considered and explicitly rejected, with reasoning
preserved for the record. Not the same as "Not Doing" (which covers
things we never intended) — these were planned at one point and
then dropped based on evidence.

### DROPPED — float-WASM tier (was: float-wasm-scalar / f32 CLUT / float-wasm-simd)

> **Decision (Apr 2026, post v1.3-int16):** the float-WASM kernel
> family — `float-wasm-scalar`, `f32 CLUT` (`Float32Array` cells),
> `float-wasm-simd` — is **dropped from the roadmap** and moved to
> a v2-maybe bucket. The case for it collapsed once the v1.3 int16
> kernel landed and was measured. Original analysis preserved below
> for the paper trail.

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
breath.

**Where the float-WASM tier would re-enter the conversation.** A
real customer demand for one of:
- `mpet` MultiProcessElement profile support (which would put f32
  CLUT cells on the table for the first time)
- spectral pipeline batch processing (where f32 is the natural
  storage format and u16 quantisation noise compounds across many
  wavelength bins)
- explicit HDR scene-linear workflows where f32 is the buffer
  format users want to feed in directly

### DROPPED — `lutMode: 'int-pipeline'` (was: S15.16 for lcms parity)

**Reason dropped:** `LutBuilder.createFromLCMS()` in v1.4.3 solves
the problem more cleanly. Instead of reimplementing lcms's S15.16
fixed-point pipeline inside jsCE, you sample the lcms transform
into a LUT once and dispatch it through jsCE's WASM-SIMD kernels —
lcms colour math at jsCE speed, with zero ongoing lcms dependency
at runtime. The v1.4.3 demo shows jsCE and lcms agree to < 0.1 ΔP
per channel on real profiles. There is no use case left that
requires bit-exact S15.16 emulation inside the engine itself.

**Why we don't see a need:** no user request. Everyone asking today
wants "fastest valid u8 output" or "float for measurement"; nobody
has asked for "exactly what lcms does, down to the LSB". The v2
package-split work already exposes the `LutDescriptor` `variant`
field that would let someone run an lcms-variant LUT kernel on an
lcms-baked descriptor without this work. The complexity is
non-trivial — S15.16 semantics differ from Q0.16 in rounding,
saturation, and sign handling. Every stage would need parity tests;
every kernel needs two variants.

If a real user pulls this forward, the plan is documented here so
the implementation doesn't start from scratch.

---

## Related

- [Performance.md](./deepdive/Performance.md) — where we are (measured),
  what we learned, the journey
- [CHANGELOG.md](../CHANGELOG.md) — versioned release notes
- [Deep dive](./deepdive/) — how the current kernels work
- [Bench.md](./Bench.md) — run the benchmarks yourself
