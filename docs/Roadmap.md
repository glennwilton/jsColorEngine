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
- [v1.4 — Image helper + browser samples](#v14--image-helper--browser-samples)
    - [Browser samples](#browser-samples)
- [v1.5 — N-channel float inputs + compiled non-LUT pipeline + `toModule()`](#v15--n-channel-float-inputs--compiled-non-lut-pipeline--tomodule)
    - [N-channel float inputs (5 / 6 / 7 / 8-channel input profiles)](#n-channel-float-inputs-5--6--7--8-channel-input-profiles)
    - [Tunable LUT grid size — `lutGridSize` option](#tunable-lut-grid-size--lutgridsize-option)
    - [`lcms_patch/` extraction (v1.3 follow-up)](#lcms_patch-extraction-v13-follow-up)
    - [Compiled non-LUT pipeline + `toModule()` (v1.5 centrepiece)](#compiled-non-lut-pipeline--tomodule-v15-centrepiece)
    - [Non-LUT pipeline code generation (`new Function` + emitted WASM)](#non-lut-pipeline-code-generation-new-function--emitted-wasm)
    - [Per-Transform microbench for `'auto'`](#per-transform-microbench-for-auto)
    - [DROPPED — float-WASM tier (was: float-wasm-scalar / f32 CLUT / float-wasm-simd)](#dropped--float-wasm-tier-was-float-wasm-scalar--f32-clut--float-wasm-simd)
- [v1.6 (optional) — `lutMode: 'int-pipeline'` — S15.16 for lcms parity](#v16-optional--lutmode-int-pipeline--s1516-for-lcms-parity)
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
- Browser benchmark (`bench/browser/` + [docs/Bench.md](./Bench.md))
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

## v1.4 — Image helper + browser samples

A small, single-purpose helper class that owns the "I have an image,
I want to display / proof / inspect it" workflow. **Not a general
image library** — no resize, no filter, no composite, no format
encode/decode. Strictly "move bytes around the colour transform,
visualise what's there."

> **Why this is v1.4 and not v1.5.** The v1.3 kernel ladder banked
> a real performance story (158 MPx/s `int16-wasm-simd`, 4-5× over
> lcms-wasm 16-bit). The fastest way to convert that into adoption
> is concrete, runnable samples — not another perf release. v1.4 is
> the **showcase release**: a small helper class + half a dozen
> browser samples that put the v1.3 numbers in front of users on
> their own machines. The larger v1.5 compiled-pipeline + N-channel
> work below is high-value but high-effort and could delay; landing
> the sample suite first means even if v1.5 slips, the project keeps
> growing visible surface area on the back of v1.3's perf story.

Lives as a separate class (probably `src/ImageHelper.js`, exported
as `new ImageHelper({...})`). Used by the browser samples below as
both a demo vehicle *and* as living documentation of how to drive
the core engine on real image data.

### API shape

```js
var img = new ImageHelper({
    width: 1024,
    height: 768,
    data: pixels,              // Uint8Array | Uint16Array | Float32Array
    deviceProfile: cmykProfile, // what this image IS
    proofProfile: null,         // optional: what to simulate through
                                // (e.g. for softproof: source is sRGB,
                                // proofProfile is the press profile,
                                // rendered as sRGB → press → sRGB)
    alpha: false                // or 'straight' | 'premultiplied'
});
```

The helper **assumes the display is sRGB** (safe default, overridable
via a `displayProfile` option if someone cares). It builds its own
`Transform` objects on construction based on what the image is and
what the user asks to see:

```js
img.toScreenRGBA()             // device → sRGB, returns ImageData
img.toSoftproofRGBA()           // device → proof → device → sRGB
                                //   (if proofProfile is set)
img.getChannel('C')             // single-channel Greyscale ImageHelper
                                //   (in device space)
img.renderChannelAs('C', '#00AEEF')  // channel greyscale tinted for display,
                                     //   returns ImageData
img.pixel(x, y)                 // single-pixel colour object in device space
                                //   (uses f64 pipeline — accurate)
```

### Why this shape

- **Transforms are hidden inside.** User says "I want to see this on
  screen" / "I want to softproof this", the helper wires up the
  correct `Transform` internally. Beginners don't need to know what a
  PCS is.
- **deviceProfile + proofProfile covers 80% of real image workflows.**
  Image editing, softproofing, ink-channel inspection, press preview
  — all of it.
- **Channel extraction is where the helper earns its keep.** Canvas
  alone cannot give you "the C channel of this CMYK image as a
  coloured greyscale". It needs the full CMYK → single-channel
  projection + RGB remapping that the engine already does.
- **Immutable operations.** `getChannel()` returns a new helper. No
  "wait which image am I looking at" bugs in demos.

### Design decisions pinned

1. **Buffer ownership:** retain by reference on construction, copy on
   any op that changes dimensions / format. Keeps the fast path fast.
2. **No re-transforms:** once built, the internal `Transform` objects
   stick. Changing `proofProfile` after construction throws; users
   build a new helper. Demo code reads cleaner that way.
3. **Rendering target always RGBA Uint8Clamped for `toXxxRGBA()`.**
   Canvas-ready. Float output is a different method
   (`.toFloat32(colourSpace)`) if someone wants raw data.

### Non-goals

- Resize, filter, blur, composite, blend modes → use a real image
  library (ImagiK, libvips, pillow via wasm, etc) *before* jsCE.
- Format encode/decode (PNG, JPEG, TIFF) → out of scope. Accept
  ImageData / typed arrays in, emit ImageData / typed arrays out.
- Video. Not a streaming API.

### When it ships

**v1.4**, immediately after the v1.3 int16 ladder. This is a
features-and-samples release, not a performance one — slotting it
in before v1.5 means we can show off the current feature set and
the performance gains banked in v1.2 / v1.3 in the browser samples,
on real images, on the user's own machine. v1.5 is a much larger
piece of work (compiled non-LUT pipelines + N-channel float input
kernels) and could be a long delay; landing the sample suite first
gives a more immediate payoff for anyone who's been following along
for the journey so far, and means even if v1.5 slips the project
keeps growing visible surface area.

### Browser samples

Dev-adoption angle: most colour libraries are judged in 30 seconds by
whether there's a working demo someone can click. jsColorEngine has
the [browser benchmark](./Bench.md) shipped in v1.2 but needs product
samples as well. The ImageHelper above is the glue that makes the
image-centric demos short enough to read as documentation.

Target samples (all zero-build, reference `browser/jsColorEngineWeb.js`
via `<script>`, work from `file://` so devs can just download + open):

- **`rgb-to-cmyk-separations.html`** — image input (drag-drop or file
  picker) → five side-by-side canvases: composite CMYK→RGB preview +
  individual C, M, Y, K separations rendered as greyscale with the
  channel colour as a tint overlay. Demonstrates the image hot path
  at glance-able speed. Add an FPS counter for the "yes this really
  is 60+ MPx/s" moment. Primary ImageHelper showcase.
- **`colour-calculator.html`** — interactive converter between
  RGB / Lab / XYZ / LCH / CMYK with live round-trip display. Shows
  the accuracy path (`transform()` on single colours), the helper
  functions in `convert.js`, and how virtual profiles work without
  the user needing an ICC file. UI: a row of sliders per colour
  space, ΔE readout between source and round-tripped destination.
- **`soft-proof-image.html`** — upload image, pick a press profile
  from a dropdown of virtual profiles (or drop in your own ICC),
  side-by-side "on screen" vs "what it'll print". Classic use case,
  covers the full pipeline, looks impressive. `img.toSoftproofRGBA()`
  is literally one call.
- **`softproof-vs-lcms.html`** — **the proof-of-accuracy demo.**
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

  ImageHelper shines here: the jsCE side is literally
  `new ImageHelper({...}).toSoftproofRGBA()` — the whole sample is
  mostly the lcms-wasm wiring + diff calculation + UI, which
  highlights how much glue the helper saves. ~250 lines total.
- **`profile-inspector.html`** — load any ICC file, dump tag table,
  show TRC curves, render the gamut shell in 3D. Genuinely useful
  tool on its own; doubles as a demo of the `Profile` class API
  surface.
- **`gamut-viewer.html`** — relicensed + simplified version of the
  existing `profileViewer.js` (O2 Creative). Three.js-based,
  vertex-coloured gamut mesh, side-by-side profile comparison with
  ∆E³ volume readout, add/remove profiles, opacity sliders,
  wire/solid/trans view modes, mouse-drag rotation + wheel zoom.
  Already has `addLabPoints` / `addCMYKPoints` / `addRGBPoints`
  helpers — can plug an image → point-cloud demo on top (drop an
  image, see the image's pixel distribution as a coloured cloud
  inside the gamut shell). Before shipping: relicense to match
  engine, drop jQuery dependency, swap `require` for UMD /
  `<script>` usage, Three.js via CDN.
- **`live-video-softproof.html`** — *(late-night brain-dump, capture
  for later.)* Side-by-side `<video>` elements, HD (720p probably —
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
  hidden 2D canvas, `getImageData()` for the pixel buffer, feed to
  `ImageHelper.toSoftproofRGBA()`, `putImageData()` to the visible
  canvas. Modern browsers also expose `VideoFrame` (WebCodecs) +
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
> queue, and the ImageHelper + samples work was promoted to v1.4
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
> - **`lcms_patch/` extraction** — janitorial follow-up from the v1.3
>   compat harness (see Accuracy.md).
>
> The compiled non-LUT pipeline + `toModule()` work is still the
> centrepiece of v1.5 — those land after the warm-up items above.
> This is **the largest single piece of post-v1.3 work** and could
> meaningfully delay the release; v1.4's sample suite was reordered
> ahead of it precisely so the project keeps shipping visible
> progress on top of the v1.3 perf story even if v1.5 takes a while.

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
  anything under ~10 MPx, (b) WebGPU isn't universally available yet,
  (c) the API surface is huge. Maybe v2.x; not on the near roadmap.
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
