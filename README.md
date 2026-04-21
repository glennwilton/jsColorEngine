 
jsColorEngine is a colour-management engine that uses ICC profiles to convert
colours — **the fastest and smallest CMS library for JavaScript**\*,
written in **100% native JavaScript** with **no dependencies**.

- **Hand-tuned for JIT compilers — faster than compiled `lcms-wasm`\*.**
  The hot-path image kernels are written specifically for how V8 / SpiderMonkey
  / JSC optimise (unrolled, monomorphic, typed-array IO, `Math.imul`
  fixed-point) and verified TurboFan-optimised via
  [`bench/jit_inspection.js`](./bench/jit_inspection.js).   Measured **1.48–2.12× faster than `lcms-wasm` (v1.0.5)** on the same
  machine, same profiles, and identical inputs. See [How it compares to lcms-wasm](#how-it-compares-to-lcms-wasm)
  and [docs/Performance.md](./docs/Performance.md) for full methodology and accuracy data.
- **No WASM required, no bindings, no compilation step** — not a rebuild of
  LittleCMS or any other C/C++ engine. Drops straight into Node, browsers,
  web workers, Electron, React Native (with a JS-compatible Buffer polyfill),
  and any other modern JS runtime. Future opt-in `lutMode: 'wasm-scalar'` /
  `'wasm-simd'` kernels will fall back to the pure-JS hot path anywhere
  WASM isn't available.
- **Small:** the bundle is **~192 KB raw, ~52 KB gzip, ~41 KB brotli**,
  in a single JS file — and that includes virtual profiles, spectral
  data, and the full ICC v2/v4 decoder. For comparison, `lcms-wasm`
  ships a ~41 KB minified JS shim **plus** a separate ~309 KB `.wasm`
  payload (~129 KB gzip combined — **~2.5× larger over the wire**,
  two HTTP fetches, async WASM instantiation).
- **Simple API:** two methods, `transform()` for single colours and
  `transformArray()` for image bytes. Both live on the same `Transform`
  object. See [Two ways to use it](#two-ways-to-use-it) below.

> \* "Fastest and smallest" and "faster than compiled `lcms-wasm`" are
> measured on one developer machine (Node 20, V8, x64) against
> [`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm) v1.0.5, the
> only actively-maintained general-purpose JS CMS on npm we're aware of.
> **Benchmark numbers vary by CPU, JS engine, and profile.** We welcome
> user-submitted results on other OSes / CPUs / browsers / JS runtimes,
> as well as critique of the methodology in
> [`bench/lcms-comparison/`](./bench/lcms-comparison). Please open an
> issue or PR with your `node bench.js` output and machine details. If
> we've missed a faster or smaller pure-JS CMS, please tell us.

A lot of the core concepts and design ideas are based on LittleCMS, but this
is not a port — the implementation is independent and tuned for the
JavaScript runtime (V8, SpiderMonkey, JSC).

---

## Two ways to use it

The engine is built around two very different use cases. Picking the right
one matters more than any other choice you'll make:

| Use case | API | Speed | Accuracy | When to use |
|---|---|---|---|---|
| **Single colour / colour picker** | `transform.transform(colorObj)` | µs per call, slow per pixel | Full 64-bit precision, all stages run | UI colour pickers, swatch libraries, Lab/RGB/CMYK display, ΔE calculations, prepress maths |
| **Image / array processing** | `transform.transformArray(typedArray, ...)` | 45–70 Mpx/s on a desktop CPU | Slightly less accurate (LUT is finite resolution) | Soft-proofing, image conversion, video, anything pixel-bulk |

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
- **~1.5–2× faster than [`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm)**
  on the same machine, same profiles, same inputs — measured head-to-head
  on image transforms (see [How it compares to lcms-wasm](#how-it-compares-to-lcms-wasm))

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

> **A note on the interpolator code.** The image transform path uses
> heavily unrolled and inlined interpolators. On first read they look
> counter-intuitive — long arithmetic expressions, duplicated code paths,
> very few helper functions or named temporaries. That is deliberate:
> the JIT compilers inline aggressively and reuse registers across the
> folded expression, but introducing a helper call or a named temp can
> force a memory round-trip that measurably slows the loop down. See
> the **PERFORMANCE LESSONS** block at the top of `src/Transform.js`
> for the measured trade-offs; don't "tidy" the hot loops without
> re-benchmarking.

---

## Accuracy

> **TL;DR:** output matches LittleCMS to **≤ 1 LSB on 98.5 – 100 % of
> samples** across all four standard image workflows, with all named
> reference colours (white, black, primaries, mid-greys, skin tone,
> paper white, rich black, etc.) matching exactly or within 1 LSB.
> **The residual drift is well below visible threshold** and is
> suitable for soft-proofing, preview, image conversion, and virtually
> any practical application that isn't bit-exact audit reproduction
> against a specific reference CMS.

As a baseline, the output has been compared to LittleCMS (via the
`lcms-wasm` npm package — a WASM port of LittleCMS 2.16) on a
systematic 9^N grid through the input cube plus a set of named
reference colours, using `cmsFLAGS_HIGHRESPRECALC` on the lcms side
so both engines are comparing like-for-like precalc LUTs.

| Workflow | within 1 LSB | max Δ | mean Δ |
|---|---|---|---|
| RGB → Lab   | **100.00 %** | 1 LSB  | 0.004 LSB |
| RGB → CMYK  | **100.00 %** | 1 LSB  | 0.016 LSB |
| CMYK → RGB  | 98.51 %      | 14 LSB\* | 0.073 LSB |
| CMYK → CMYK | 98.83 %      | 4 LSB  | 0.141 LSB |

Run `bench/lcms-comparison/accuracy.js` to reproduce on your own
machine.

### \* Where the 14-LSB CMYK → RGB outlier comes from (hypothesis)

The one number that stands out is the 14-LSB max on CMYK → RGB. It
is confined to **deep-cyan-saturated out-of-gamut** inputs (e.g.
`(192,0,64,32)`) whose Lab coordinate falls outside sRGB's gamut —
both engines compute R < 0 internally and have to clip. We clip R to
0, lcms happens to produce R = 9 – 14 for the same inputs. 98.5 %
of pixels still agree to within 1 LSB; the outlier is bounded to
this one OOG regime.

We *hypothesise* the mechanism is a design difference in where and
how aggressively values are clamped along the pipeline:

- **jsColorEngine runs the entire pipeline in 64-bit float** all
  the way to the final LUT bake. Only **some** intermediate stages
  clamp to their logical domain (e.g. `L` clipped to 0 – 100 in the
  Lab PCS, matrix outputs left un-clipped); most stages let
  negative and >1.0 values pass through. If a value swings negative
  in one stage and comes back positive in the next, you get the
  smooth "came back positive" result.
- **LittleCMS** appears to clamp more aggressively at several
  intermediate 16-bit fixed-point stages inside its precalc LUT
  builder; values that swing out of range get clamped at that
  stage and stay clamped.

**We have not yet traced lcms's clamping points source-line by
source-line** — the description above is a best-guess architectural
model, not a verified diff. If it turns out to be more nuanced (and
with clipping behaviour in a ~8,000-line C file spread across
`cmslut.c`, `cmsintrp.c`, `cmsopt.c` etc. it almost certainly is),
we will update this section.

Neither approach is "correct" — the target gamut has no
representation for the colour, so both engines produce a bounded
guess. They just produce different bounded guesses. A future release
may add an opt-in **lcms-compatibility mode** that clips more
aggressively at intermediate stages to reproduce lcms's OOG
behaviour bit-for-bit, for audit workflows. Until then, if you need
*bit-exact* reproduction of a reference lcms pipeline, use
`lutMode: 'float'` and expect occasional OOG drift like the above.

Key takeaway: This only affects strongly saturated colours that 
cannot be represented in the target gamut — the difference is
invisible in real images

### Extreme synthetic cases

For inputs well outside any real gamut (e.g. `Lab(0, 100, -100)` →
RGB), the differences can be larger — but these are mathematical
edge cases and can be ignored.

### User-submitted comparisons welcome

Benchmark numbers and accuracy results are all from one developer
machine. We welcome:

- **Your run of the benchmark** on other CPUs, operating systems,
  Node versions, or browser engines
- **Critique of the test methodology** — grid density, sample
  selection, rendering intent, precalc settings, anything
- **Additional CMS engines to compare against** — Oyranos,
  ArgyllCMS, pure LittleCMS via native binding, etc.
- **Counter-examples** — inputs where we disagree with reference
  CMS engines in a way that matters for practical workflows

Open an issue or PR with your results and we will fold them in. If
the methodology is broken, we would rather hear about it than
brag on borrowed numbers.

---

## Speed

Single-colour `transform()` is in the microseconds — fine for UI work,
prepress calculations, and anything where you're converting tens or hundreds
of colours at a time.

For image work, build a LUT (`new Transform({buildLut: true})`) and use
`transformArray()`. The table below shows measured throughput for the
four most common 8-bit image workflows, across the three working modes
of the engine:

| Workflow | No LUT (accuracy path) | `lutMode: 'float'` (f64 LUT) | `lutMode: 'int'` (u16 LUT, v1.1 default for new code) |
|---|---|---|---|
| RGB → RGB  (sRGB → AdobeRGB)   | 5.0 Mpx/s | 69.0 Mpx/s | **72.1 Mpx/s** |
| RGB → CMYK (sRGB → GRACoL)     | 4.1 Mpx/s | 56.1 Mpx/s | **62.1 Mpx/s** |
| CMYK → RGB (GRACoL → sRGB)     | 4.5 Mpx/s | 50.8 Mpx/s | **59.1 Mpx/s** |
| CMYK → CMYK (GRACoL → GRACoL)  | 3.8 Mpx/s | 44.7 Mpx/s | **48.8 Mpx/s** |

Measured on Node 20 (V8) on an x64 desktop CPU using the GRACoL2006
CMYK profile and the built-in sRGB / AdobeRGB virtual profiles, 65 536
pixels per batch, median of 5 × 100 iterations. Run
`bench/mpx_summary.js` to reproduce on your own hardware.

Key takeaways:

- **Building a LUT makes image transforms ~11–15× faster** vs. the
  per-pixel accuracy path. There's no reason NOT to use one for any
  workflow that touches more than a few hundred pixels.
- **`lutMode: 'int'` adds another ~4–16 %** on top of the float LUT,
  and uses 4× less memory (u16 vs f64 CLUT). 4D directions (CMYK input)
  see the biggest gain because the float kernel's K-LERP does extra
  rounding work that the integer kernel collapses.
- Even a 4K image (8.3 Mpx) finishes in ~115 ms on the slowest
  workflow (CMYK→CMYK, `lutMode: 'int'`), or ~34 ms on RGB→RGB.

> **The exact numbers are engine- and hardware-specific.** Because
> the hot loops are tuned for JIT behaviour (inlining, monomorphic
> typed-array input, minimal temporaries, `Math.imul` for integer
> math), throughput can vary noticeably between V8 (Chrome / Edge /
> Node), SpiderMonkey (Firefox), and JavaScriptCore (Safari) — and
> even between different releases of the same engine as their
> optimisation passes evolve. Treat the numbers above as a guide,
> not a spec.

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

### How it compares to lcms-wasm

Direct, same-machine, same-profile, same-input head-to-head against
[`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm) 1.0.5 (LittleCMS
2.16 compiled to wasm32 via Emscripten), measured with `cmsFLAGS_HIGHRESPRECALC`
and pinned WASM heap buffers (i.e. lcms pre-builds a precalc device-link
LUT and reuses its I/O buffers — the fastest, fairest setup we can give
it). Identical PRNG input bytes on both sides.

| Workflow | jsColorEngine `lutMode: 'int'` | lcms-wasm (HIGHRESPRECALC, pinned) | Speedup |
|---|---|---|---|
| RGB → Lab    (sRGB → LabD50)   | **65.8 Mpx/s** | 41.9 Mpx/s | **1.57×** |
| RGB → CMYK   (sRGB → GRACoL)   | **55.0 Mpx/s** | 37.2 Mpx/s | **1.48×** |
| CMYK → RGB   (GRACoL → sRGB)   | **51.9 Mpx/s** | 24.5 Mpx/s | **2.12×** |
| CMYK → CMYK  (GRACoL → GRACoL) | **44.3 Mpx/s** | 22.1 Mpx/s | **2.00×** |

Even `lutMode: 'float'` outruns lcms-wasm on all four workflows
(1.28×–1.96×). Run `bench/lcms-comparison/` to reproduce.

**Accuracy vs lcms-wasm** (measured over a systematic 9^N grid through
the input cube plus named reference colours — 743 samples for 3D,
6571 samples for 4D):

| Workflow | exact match | within 1 LSB | within 2 LSB | max Δ | mean Δ |
|---|---|---|---|---|---|
| RGB → Lab   | 98.79 % | **100.00 %** | 100.00 % | 1 LSB | 0.004 LSB |
| RGB → CMYK  | 93.54 % | **100.00 %** | 100.00 % | 1 LSB | 0.016 LSB |
| CMYK → RGB  | 83.55 % | 98.51 %      | 99.07 %  | 14 LSB*| 0.073 LSB |
| CMYK → CMYK | 59.50 % | 98.83 %      | 99.86 %  | 4 LSB  | 0.141 LSB |

All named reference colours (white, black, primaries, mid-greys, skin
tone, paper white, rich black, etc.) match exactly or within 1 LSB on
every workflow.

*The max 14 LSB on CMYK → RGB is an **out-of-gamut clipping
disagreement**, not a correctness bug. Deep cyan CMYK values like
`(192,0,64,32)` map to Lab coordinates outside sRGB's gamut; both
engines clip out-of-range R, just at different stages of their
internal pipeline — neither answer is "right" since the target
gamut has no representation for the colour. 98.5 % of pixels still
agree to within 1 LSB and all named reference colours match
exactly; residual drift is well below visible threshold. See the
[Accuracy](#accuracy) section for the hypothesis on where the
mechanism comes from and the planned lcms-compatibility mode.

#### Why pure-JS can beat Emscripten-wasm32

At first glance "pure JS beats WASM port of a battle-hardened C library"
sounds wrong — but it makes sense once you decompose it:

- **lcms-wasm is a generic native C codebase compiled to wasm32.**
  It carries all of lcms2's generality cost (per-pixel formatter
  dispatch, handling of 16 pixel layouts, planar/interleaved, float/int,
  endian, extra channels), no SIMD in this Emscripten build, and no
  Fast Float plugin (the hand-tuned kernels that make native lcms2 fast
  aren't in the WASM build). It also pays a JS ↔ WASM FFI boundary
  on every `cmsDoTransform` call.
- **jsColorEngine is written *for* V8.** The `lutMode: 'int'` hot
  loop is a single specialised kernel per LUT shape (3D-3Ch, 3D-4Ch,
  4D-3Ch, 4D-4Ch), fully unrolled, int32-specialised with `Math.imul`,
  no bounds checks in the inner loop, no FFI boundary — and the JIT
  inspection in `bench/jit_inspection.js` confirms all 8 hot kernels
  TurboFan-optimise with zero deopts and stay L1i-cache-resident.

So the comparison isn't really "JS vs C" — it's "V8-tuned JS with one
specialised kernel per shape" vs "C-compiled-to-WASM with runtime
dispatch over every pixel format lcms2 supports." The first is
essentially custom silicon for the job; the second is a general
tool being run through a sandbox.

#### But that's lcms-wasm, not native lcms2

This benchmark is against the **WASM** port, not native LittleCMS
compiled with a C compiler. Native lcms2 with the Fast Float plugin
and a modern compiler's auto-vectoriser would likely still be ahead
of us — we just can't run it from Node.js to measure. A reasonable
expectation is something like:

```
native lcms2 (Fast Float + SSE/AVX)  >  native lcms2 (default)  ~1.5–2× faster than
jsColorEngine (this repo)  >  lcms-wasm (Emscripten, no SIMD, no Fast Float plugin)
```

The v1.3 roadmap includes a `lutMode: 'wasm-scalar'` pass to close
on native lcms2; the v1.4 pass adds `lutMode: 'wasm-simd'`. The JIT
inspection suggests a hand-written tight-loop WASM kernel (pointer-
pinned, no bounds checks, no overflow guards) could recover another
~1.4–1.6× on top of today's numbers.

See **[docs/Performance.md](./docs/Performance.md)** for the full
analysis: instruction-level JIT inspection, register-pressure
breakdown, where the remaining cycles go, and the roadmap to close
on native lcms2.

### Faster still: `lutMode: 'int'` integer hot path (1.1+, opt-in)

Add `lutMode: 'int'` to the constructor for an additional ~10–25 %
throughput on image transforms, with 4× less LUT memory:

```js
const t = new Transform({
    dataFormat: 'int8',
    buildLut:   true,
    lutMode:    'int'    // integer kernel + u16 LUT  ('float' is the default)
});
t.create('*srgb', cmykProfile, eIntent.relative);
const out = t.transformArray(rgbBuf);
```

What it does: rebuilds the float CLUT as a `Uint16Array` (scaled by
`255 × 256 = 65280` so `u16 / 256 = u8` exactly), runs the inner loop
with `Math.imul` and Q0.8 fractional weights (derived from a Q0.16
`gridPointsScale_fixed` so the true `(g1-1)/255` ratio is preserved),
and folds the final `>> 8` / `>> 20` to convert u16 back to u8 output.

| When `lutMode: 'int'` helps         | `'int'` throughput | `'float'` baseline | Speedup | Accuracy vs float |
|--------------------------------------|--------------------|--------------------|---------|-------------------|
| RGB → RGB / Lab (3D 3Ch)             | 72.1 MPx/s         | 69.0 MPx/s         | 1.04×   | **100 % exact**   |
| RGB → CMYK     (3D 4Ch)              | 62.1 MPx/s         | 56.1 MPx/s         | 1.11×   | ≤ 1 LSB on u8     |
| CMYK → RGB / Lab (4D 3Ch)            | 59.1 MPx/s         | 50.8 MPx/s         | 1.16×   | ≤ 1 LSB on u8     |
| CMYK → CMYK     (4D 4Ch)             | 48.8 MPx/s         | 44.7 MPx/s         | 1.09×   | ≤ 1 LSB on u8     |

The residual ≤ 1 LSB drift on the non-RGB→RGB directions is
`Uint8ClampedArray` banker's rounding (ties to even) disagreeing with
the integer kernel's round-half-up at exact `X.5` boundaries. It's
not accumulated math error — the u16 interp is otherwise bit-exact.

Numbers from `bench/mpx_summary.js` on Node 20 / V8 / x64 using the
GRACoL2006 ICC profile. **All four 3-/4-channel directions are
accelerated** as of v1.1 — CMYK input is no longer left out. The 4D
directions actually beat 3D on speedup because the float K-LERP does
more redundant rounding work. The 4D kernels carry intermediate values
at Q16.4 precision (u20) to collapse three stacked rounding steps into
one — see the CHANGELOG for the derivation. As above, expect the
absolute numbers to shift on other engines / machines.

`lutMode` defaults to `'float'`, so existing code is unaffected. It's
safe to set globally: any LUT shape the integer kernel can't service
(1D / 2D / 5+ output channels) just falls through to the float kernel.
Don't use it when you need bit-exact reference output (e.g. comparing
transformed pixels against measured patches for delta-E reporting) —
use the float path for that.

The `lutMode` option is a string enum on purpose. v1.2+ will add
`'wasm-scalar'`, `'wasm-simd'`, and `'auto'` (best kernel per shape)
through the same constructor option, with no API break — unknown
values today fall through to `'float'` so code written for tomorrow's
release won't crash on today's.

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

- [LittleCMS](https://www.littlecms.com) — color management architecture,
  ICC profile handling, CLUT interpolation approach. A genuine debt: much
  of the thinking in this engine was shaped by studying Marti Maria's
  25-year solo maintenance of lcms. No code is derived — this is a
  clean-room JavaScript implementation with different optimisation
  constraints (V8 JIT vs C compiler) — but the intellectual lineage is
  acknowledged here rather than claimed independently. If this project
  ever produces commercial revenue, a meaningful share is intended to
  flow back to LittleCMS.
- Bruce Lindbloom — RGB / XYZ / Lab math, ΔE formulas.
- BabelColor — RGB working-space primaries reference.
