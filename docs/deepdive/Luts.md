# LUTs — design, format, and architecture

**jsColorEngine docs:**
[← Project README](../../README.md) ·
[Bench](../Bench.md) ·
[Performance](../Performance.md) ·
[Roadmap](../Roadmap.md) ·
[Examples](../Examples.md) ·
[API: Profile](../Profile.md) ·
[Transform](../Transform.md) ·
[Loader](../Loader.md)

**Deep Dive:**
[← Index](./README.md) ·
[Architecture](./Architecture.md) ·
[LUT modes](./LutModes.md) ·
[JIT inspection](./JitInspection.md) ·
[WASM kernels](./WasmKernels.md) ·
[Compiled pipeline](./CompiledPipeline.md) ·
[Accuracy](./Accuracy.md)

**Companion guide:** [`samples/lutbuilder.md`](../../samples/lutbuilder.md) — the practical how-to with code samples, written for developers using the LutBuilder helper. This document is the *deep dive*: design rationale, format spec, the lcms bridge, the TIFF roadmap, and why the architecture looks the way it does.

---

> **Status: shipped — v1.4.4.** All three stages are implemented. This document
> is the architecture reference and rationale; the practical how-to and CLI guide
> is in [`samples/lutbuilder.md`](../../samples/lutbuilder.md).

## Table of contents

- [TL;DR — one paragraph](#tldr--one-paragraph)
- [1. The three problems that turned out to be one](#1-the-three-problems-that-turned-out-to-be-one)
    - [1.1 CMS compatibility — the lcms gap](#11-cms-compatibility--the-lcms-gap)
    - [1.2 Redistributable LUTs — zero-profile runtime](#12-redistributable-luts--zero-profile-runtime)
    - [1.3 Custom LUTs — creative and production workflows](#13-custom-luts--creative-and-production-workflows)
    - [1.4 The unifying insight](#14-the-unifying-insight)
- [2. Architecture — separation of concerns](#2-architecture--separation-of-concerns)
    - [2.1 What the core engine does today](#21-what-the-core-engine-does-today)
    - [2.2 What the LUT Builder adds](#22-what-the-lut-builder-adds)
    - [2.3 Boundary: Builder vs Engine](#23-boundary-builder-vs-engine)
- [3. The three tiers](#3-the-three-tiers)
    - [Tier 1 — jsColorEngine native](#tier-1--jscolorengine-native)
    - [Tier 2 — Custom callback](#tier-2--custom-callback)
    - [Tier 3 — lcms-wasm bridge](#tier-3--lcms-wasm-bridge)
- [3b. Grid size modes — automatic resolution selection](#3b-grid-size-modes--automatic-resolution-selection)
- [4. The TIFF workflow — visual LUT editing](#4-the-tiff-workflow--visual-lut-editing)
    - [4.1 Why TIFF](#41-why-tiff)
    - [4.2 Export: LUT → TIFF](#42-export-lut--tiff)
    - [4.2b The three-stage build process](#42b-the-three-stage-build-process)
    - [4.3 Edit: Photoshop (or any editor) as LUT transformer](#43-edit-photoshop-or-any-editor-as-lut-transformer)
    - [4.4 Import: TIFF → LUT](#44-import-tiff--lut)
    - [4.5 What this unlocks](#45-what-this-unlocks)
- [5. LUT serialisation — the portable format](#5-lut-serialisation--the-portable-format)
    - [5.1 Realisation — the existing LUT object IS the format](#51-realisation--the-existing-lut-object-is-the-format)
    - [5.2 Format](#52-format)
    - [5.3 Design goals](#53-design-goals)
    - [5.4 Compatibility tags](#54-compatibility-tags)
    - [5.5 Verification — proving a LUT matches a workflow](#55-verification--proving-a-lut-matches-a-workflow)
- [6. The lcms bridge — bit-exact CMS capture](#6-the-lcms-bridge--bit-exact-cms-capture)
    - [6.1 Why not just emulate lcms directly?](#61-why-not-just-emulate-lcms-directly)
    - [6.2 How the bridge works](#62-how-the-bridge-works)
    - [6.3 Two usage patterns](#63-two-usage-patterns)
- [7. API surface](#7-api-surface)
    - [7.1 Design principles](#71-design-principles)
    - [7.2 `virtualProfile()` — synthetic chain descriptors](#72-virtualprofile--synthetic-chain-descriptors)
    - [7.2b LUTs and whitepoints — data in, data out](#72b-luts-and-whitepoints--data-in-data-out)
    - [7.3 `LutBuilder` — the primary API](#73-lutbuilder--the-primary-api)
    - [7.4 Why no separate serialiser](#74-why-no-separate-serialiser)
- [8. Workflows](#8-workflows)
    - [8.1 Fully synthetic LUT (callback)](#81-fully-synthetic-lut-callback)
    - [8.2 Loaded from Transform → redistribute](#82-loaded-from-transform--redistribute)
    - [8.3 lcms bridge → bake and discard](#83-lcms-bridge--bake-and-discard)
    - [8.4 Load → mutate → save](#84-load--mutate--save)
    - [8.5 TIFF round-trip (Stage 3)](#85-tiff-round-trip-stage-3)
    - [8.6 Pre-baked LUT library](#86-pre-baked-lut-library)
- [9. Open questions](#9-open-questions)
- [10. Release plan](#10-release-plan)
    - [Stage 1 — LutBuilder core + lcms bridge](#stage-1--lutbuilder-core--lcms-bridge-first-release)
    - [Stage 2 — Serialisation + metadata](#stage-2--serialisation--metadata-json--b64)
    - [Stage 3 — TIFF workflow + analyze](#stage-3--tiff-workflow--analyze)

---

## TL;DR — one paragraph

The LUT Builder is a separation-of-concerns layer that sits outside the
core jsColorEngine transform pipeline. It creates, loads, saves,
modifies, and exports LUTs — then hands them to the engine via the
existing `Transform.setLut()` contract. The key insight: three
apparently separate problems (CMS compatibility, redistributable LUTs,
custom colour effects) all collapse into a single architecture once you
treat LUTs as *portable, editable artefacts* rather than internal engine
state. The killer feature is visual editing via TIFF: export a LUT as
an image, edit it in Photoshop (or any colour-managed editor), reimport
it — the editor's CMS becomes your LUT's colour math, for free.

---

## 1. The three problems that turned out to be one

### 1.1 CMS compatibility — the lcms gap

jsColorEngine and LittleCMS are not bit-identical. The
[Accuracy deep-dive](./Accuracy.md) documents this in detail — 130 of
150 ICC profiles agree within sub-LSB tolerance, but the engines make
independent architectural choices (f64 pipeline vs S15.16 fixed-point,
different intermediate clamping, independent gamut-mapping). Attempting
to emulate lcms instruction-by-instruction inside jsCE would be:

- **A huge amount of work.** lcms2 is ~50 KLOC of mature C. Matching
  its fixed-point pipeline, stage walker, and per-intent clamping
  points at the bit level would mean reimplementing a substantial
  fraction of it in JS — and maintaining it as lcms evolves.
- **An ever-moving target.** lcms releases land several times a year.
  Each release may shift intermediate clamping or precision. A
  reimplementation would need to pin to a specific lcms version and
  re-validate on every bump.
- **The wrong framing.** jsCE is an independent engine, not a port.
  Bit-identical emulation would tie our architecture to lcms's
  internal design decisions forever.

But the requirement is real: some workflows *need* to match a
reference CMS exactly — audit trails, regulatory compliance, workflow
handoff between tools that use lcms internally (Scribus, GIMP,
darktable, Krita).

### 1.2 Redistributable LUTs — zero-profile runtime

Today, creating a transform requires loading ICC profiles at runtime.
For many real deployments this is wasteful:

- A web colour picker needs exactly 4 transforms (sRGB ↔ CMYK × 2
  intents). Shipping 2 ICC profiles + a profile parser + a pipeline
  builder just to get 4 lookup tables is overengineered.
- A mobile app with a fixed CMYK press target could pre-bake the LUT
  at build time and ship it as a static asset — ~400 KB of JSON
  instead of the engine's full profile-to-pipeline machinery.
- A SaaS platform maintaining 50+ paper-stock profiles could serve
  LUTs as API responses, selectable by the user without ever loading
  an ICC file on the client.

The existing `Transform.setLut()` already accepts an externally
provided LUT. What's missing is a clean serialisation format and a
builder that produces LUTs independently of the engine's internal
pipeline.

### 1.3 Custom LUTs — creative and production workflows

Beyond ICC-to-ICC colour transforms, LUTs are the natural vehicle for:

- **Creative effects** — Instagram-style filters, vintage looks,
  S-curve contrast, saturation boost, cross-processing.
- **Device links** — CMYK → CMYK TAC limits, ink substitution,
  grey-component replacement.
- **Gamut mapping overrides** — custom perceptual mappings that
  differ from the profile's built-in BToA tables.

All of these are just "colour in → colour out" functions sampled
onto a grid. The engine's interpolation kernels don't care *where*
the grid values came from — they interpolate identically whether the
data was computed from ICC profiles, hand-typed, or painted in
Photoshop.

### 1.4 The unifying insight

These three problems share a common shape:

```
  [colour math of some kind]  →  sampled onto a grid  →  stored as a LUT  →  used by the engine
```

The differences are only in what populates the grid:

| Problem | Grid source |
|---|---|
| CMS compat | lcms-wasm (or any reference CMS) running in 16-bit mode |
| Redistributable | jsCE's own pipeline, sampled at build time |
| Custom effects | User callback, or an edited TIFF image |
| CMS capture | Any editor's colour conversion, captured via TIFF round-trip |

Once you build a system that can populate a grid from *any* of these
sources, serialize the result, and load it back into the engine — all
three problems are solved by the same code. That system is the LUT
Builder.

---

## 2. Architecture — separation of concerns

### 2.1 What the core engine does today

```
  ICC profiles  →  pipeline builder  →  LUT (Float64Array / Uint16Array)  →  interpolation kernels
```

The engine owns: profile parsing, pipeline stage assembly, LUT
sampling, kernel dispatch. The LUT is an *internal* artefact —
created during `Transform.create()`, consumed by `transformArray()`,
never exposed as a first-class portable object.

### 2.2 What the LUT Builder adds

```
  ┌──────────────────────────────────────────────────────────────────┐
  │                        LUT Builder                               │
  │                                                                  │
  │   Sources:                        Operations:                    │
  │   ├── .create(opts, callback)    ├── .exportTIFF()               │
  │   ├── .createFromLCMS(lcms, ..)  ├── .importTIFF()               │
  │   ├── .createIdentity(ch, size)  ├── .toJSON() / fromJSON()      │
  │   ├── .importTIFF(buffer)        ├── .editLut(callback)          │
  │   └── LutBuilder.fromJSON(json)  └── .analyze(ref, expected)    │
  │                                                                  │
  │   Output:                                                        │
  │   ├── .toTransform(opts) → ready Transform                      │
  │   ├── .toLut()           → raw LUT object                       │
  │   └── .toJSON()          → portable JSON                        │
  └──────────────────────────────────────────────────────────────────┘
                              │
                              ▼
  ┌──────────────────────────────────────────────────────────────────┐
  │                    jsColorEngine (unchanged)                     │
  │                                                                  │
  │   Transform.setLut(lut) → interpolation kernels → pixels         │
  └──────────────────────────────────────────────────────────────────┘
```

The Builder is a *consumer* of the engine's `setLut()` contract. It
doesn't modify the engine. It doesn't need access to internals. It
produces LUT objects that the engine already knows how to consume.

> **`setLut()` is the LUT authority.** When `setLut(lut)` is called,
> the engine:
>
> 1. **Auto-decodes** any of the supported full-scale CLUT forms —
>    `Float64Array` `[0..1]`, `Uint16Array` `[0..65535]`,
>    `Uint8Array` `[0..255]`, or base64 (with `precision: 16` or `8`).
>    All are normalised to f64 internally.
> 2. **Regenerates strides** (`g1, g2, g3, go0–3`) from `gridPoints`
>    and `outputChannels` — strides are derived, not part of the
>    portable format.
> 3. **Re-resolves `lutMode`** — picks the int/int16 kernel matching
>    `dataFormat`, sets `builtLut = true`, builds `intLut` if needed.
>
> The caller doesn't need to pass `buildLut: true` to the constructor
> when handing in a LUT via `setLut()` (or `Transform.fromJSON`). The
> LUT object — and the constructor's `dataFormat` — is everything the
> engine needs.

### 2.3 Boundary: Builder vs Engine

| Concern | Owner |
|---|---|
| ICC profile parsing | Engine |
| Pipeline assembly (stages, intents, BPC, CAT) | Engine |
| LUT interpolation (tetrahedral, all kernel tiers) | Engine |
| `Transform.setLut()` contract | Engine |
| LUT grid generation (nested loops, grid math) | **Builder** |
| Callback invocation (sampling the colour function) | **Builder** |
| TIFF export / import (image ↔ grid conversion) | **Builder** |
| Serialisation (LUT ↔ JSON/b64) | **Builder** |
| lcms-wasm bridge (optional) | **Builder** |
| Metadata / compatibility tagging | **Builder** |

The engine does not depend on the Builder. The Builder depends on the
engine only through `Transform.setLut()` — a stable, documented
public API.

### 2.4 Internal storage — always u16

The Builder's canonical internal representation is a **Uint16Array**
with values in [0, 65535] — full-scale u16. Every source converges
to this format:

```
  callback [0..1]      ──→ round(v × 65535)  ──┐
  TIFF import u16      ──→ (already u16)   ────┤
  lcms bridge u16      ──→ (already u16)   ────┼──→ Uint16Array (canonical)
  Transform f64 CLUT   ──→ round(v × 65535) ──┤   (full-scale u16 [0..65535])
  fromJSON u16         ──→ (already u16)   ────┘
```

This aligns with the ICC spec (u16 is the standard LUT precision)
and with the 16-bit TIFF workflow (export → Photoshop → import →
store, no loss at any step). The serialisation format (§5) stores
the internal representation directly — no conversion on save or load.

> **Rule of thumb — LUTs are full-scale at the boundary.**
> Every LUT that crosses an API boundary (toLut, toJSON, getLut,
> setLut) is full-scale for its type:
>
> - `Float64Array` → `[0..1]`     — engine canonical
> - `Uint16Array`  → `[0..65535]`
> - `Uint8Array`   → `[0..255]`
>
> The Transform's internal `intLut` (with its 65280 scale and
> Q0.16/Q0.13 weight encoding for the WASM kernels) is a kernel-
> dispatch artifact and never crosses any boundary. Only Transform
> cares about kernel scaling.

`toTransform({ dataFormat })` builds an f64 CLUT from the u16
canonical (`v / 65535`, lossless — Float64's 52-bit mantissa
preserves all 16 bits) and hands it to `setLut()`. The Transform
then builds whatever kernel-specific intLut its dispatch needs.

**Why not dual-format (u16 or float, convert on demand)?** It
avoids one float→u16 quantisation step on the callback path, but
we proved that step is lossless for all downstream uses (§6.2b).
Two internal formats means branching on every operation
(`editLut()`, `clone()`, `toJSON()`, `exportTIFF()`), doubled test
surface, and "which format am I in?" bookkeeping — all for zero
practical gain.

**Why not always f64?** f64 internal storage is 4× larger, wastes
precision the kernels can't use, and forces a quantisation step
on every TIFF import and lcms bridge call. u16 matches the
precision ceiling of every downstream consumer.

---

## 3. The three tiers

The Builder supports three tiers of LUT creation, matching three
levels of user involvement in the colour math.

### Tier 1 — jsColorEngine native

```
  new Transform({ buildLut: true, dataFormat: 'int16' })
      .create(srgbProfile, gracolProfile, eIntent.relative)
```

The existing engine pipeline. Full ICC support (BPC, chromatic
adaptation, v2/v4, all intents), all kernel tiers, multi-stage
proofing chains. The Builder can capture a Tier 1 result via
`Transform.getLut()` → `LutSerializer.serialize()` for later
redistribution without profiles.

**Tied to ICC profiles you have loaded. Tied to jsCE's colour
math.** This is the default for users who trust the engine's
pipeline and want to pre-bake for performance.

### Tier 2 — Custom callback

```
  const builder = new LutBuilder();
  builder.create(
      { inChannels: 3, outChannels: 3, size: 33 },
      ([r, g, b]) => boostSaturation(r, g, b)
  );
  const transform = builder.toTransform({ dataFormat: 'int16' });
```

User provides any colour function that receives and returns
normalised [0..1] values. The Builder handles grid generation,
indexing, and CLUT population. At `toTransform()` time,
`buildIntLut()` encodes the f64 CLUT into the integer kernel's
internal scale (65280 for u8 modes, 65535 for u16 modes) — the
callback never sees those constants. Same WASM/SIMD fast path as
native transforms.

**You own the colour math correctness.** This is the creative
tier — filters, effects, device links, custom gamut maps.

### Tier 3 — lcms-wasm bridge

```
  const builder = new LutBuilder();
  builder.createFromLCMS(lcms, lcmsTransformId, {
      inChannels: 3, outChannels: 4, size: 33
  });
  const transform = builder.toTransform({ dataFormat: 'int16' });
```

Wraps an already-initialised `lcms-wasm` transform. The bridge
samples the lcms **transform output** — device-space colour values
(0–65535 CMYK, RGB, etc.) — at every grid point, normalises the
results to [0..1], and stores them in the f64 CLUT. We are sampling
the transform's output, not reading lcms's internal LUT data.

The resulting LUT is near-exact to what lcms would produce (bounded
only by grid resolution), running through jsCE's WASM-SIMD kernels
at runtime. See [§6.2b](#62b-why-u16-internal-storage-is-lossless)
for the precision proof.

**100% lcms colour accuracy. jsCE dispatch speed.** This is the
compatibility tier — drop-in where lcms agreement is a hard
requirement, but you want jsCE's 2–6× throughput advantage on
the pixel loop.

### Tier summary

```
  ┌─────────────────────────────────────────────────────────────┐
  │  TIER 1: jsCE native       — you trust the engine          │
  │  TIER 2: Custom callback   — you own the math              │
  │  TIER 3: lcms-wasm bridge  — you need external CMS parity  │
  └─────────────────────────────────────────────────────────────┘
                          │
                  all produce the same
                  LUT object shape
                          │
                          ▼
              Transform.setLut(lut)
              transformArray()  ← same WASM-SIMD kernels
```

---

## 3b. Grid size modes — automatic resolution selection

### The problem: how many grid points?

The `size` parameter (grid points per axis) is the fundamental
accuracy-vs-memory tradeoff for any LUT. Too few points and the
interpolation misses colour detail. Too many and you're wasting
memory on precision that the profiles themselves can't contribute —
the LUT is smoother than the data it was built from.

Today, the user picks a number: 17, 33, 49, 65. The defaults are
sensible (33 for 3D, 17 for 4D), but they're blind to the actual
profiles in the chain.

### Why the profiles' own LUT sizes matter

ICC profiles that use LUT-based tables (B2A, A2B) store their
colour math as sampled grids. A CMYK output profile with a
17×17×17×17 B2A table has exactly 17 steps per axis of colour
detail. Building a 65-point engine LUT from that profile just
interpolates between 17-point data — you get a smoother curve but
no new information.

Conversely, a matrix-based RGB profile (sRGB, AdobeRGB) has no
internal LUT. Its colour math is continuous (matrix + TRC curves
evaluated analytically), so any grid resolution captures real
detail.

The chain's effective resolution is bounded by its coarsest
LUT-based member. A 65-point engine LUT through a 17-point B2A
table is 65³ × 4 ≈ 1.1M values storing information that could be
captured in 17³ × 4 ≈ 20K values. That's 55× the memory for zero
accuracy gain.

### The modes

The `gridSize` option accepts either a number or a mode string.
Mode strings are only available in contexts where real profiles
exist to inspect: `LutBuilder.fromTransform()` (§7.3) and the
Transform constructor's `lutGridPoints3D` / `lutGridPoints4D`
options. For `LutBuilder.create()` (callback) and
`createFromLCMS()`, `size` is always a number — there are no
profiles to query.

| Mode | Resolution source | Use case |
|---|---|---|
| `33` (number) | Explicit — user chooses | Full control. Current behaviour. |
| `'auto'` | Last profile in chain | Default for most workflows. Match the output profile's native resolution — the final arbiter of colour detail. |
| `'high'` | Highest LUT size across all profiles in chain | Maximum detail preservation. |
| `'low'` | Lowest LUT size across all profiles in chain | Minimum viable resolution. The chain is only as detailed as its coarsest LUT member — going higher wastes memory. |

#### `'auto'` — match the output profile

Inspects the **last** profile in the chain (the output profile) and
reads its native grid size from the B2A table for the active intent.
If the output profile is LUT-based (CMYK profiles almost always
are), use that grid size. If it's a matrix profile (no internal
LUT), fall back to the default (33 for 3D, 17 for 4D).

**Rationale:** For the common RGB → CMYK case, the RGB input
profile is matrix-based (continuous math, no LUT) and the CMYK
output profile has a finite-resolution B2A table. The engine LUT
only needs to match the output profile's resolution — that's the
bottleneck. There's no point building a 33³ LUT when the output
profile's own B2A is a 17-point grid; the extra 16 steps per axis
are just re-interpolation of the same 17 underlying samples.

```js
// CMYK profile has B2A with 17 grid points → auto picks 17
new Transform({ buildLut: true, lutGridPoints3D: 'auto' })
    .create(srgbProfile, cmykProfile, eIntent.perceptual);
// → builds a 17×17×17 LUT instead of the default 33×33×33
// → 4× less memory, same effective accuracy
```

For multi-stage chains (proofing: sRGB → CMYK → sRGB), `'auto'`
reads the last profile — the sRGB output. Since sRGB is matrix-
based, it falls back to the default 33. This is correct: the
chain's output is smooth RGB, and 33 points captures the round-
trip well.

#### `'high'` — preserve maximum detail

Scans **all** profiles in the chain, collects the grid size from
every LUT-based table encountered (A2B for input profiles, B2A for
output profiles), and picks the **highest** value.

**Use case:** Multi-stage chains where one profile has unusually
high resolution and you want the engine LUT to capture all of it.
A proofing chain (sRGB → high-res CMYK → sRGB) where the CMYK
profile has 33-point tables would pick 33 even if the other
profiles contribute no constraint.

#### `'low'` — don't overdo it

Same scan as `'high'`, but picks the **lowest** LUT grid size
found. If any profile in the chain has a 9-point table, there's no
point building a 33-point engine LUT — the 9-point member is the
accuracy bottleneck.

**Use case:** Memory-constrained environments, 4D chains where N⁴
memory growth makes every grid point expensive, or workflows where
you know the profiles are low-resolution and want the LUT to
reflect that honestly.

### Resolution for matrix-only chains

When all profiles in the chain are matrix-based (e.g.,
sRGB → AdobeRGB), none have internal LUTs to inspect. All three
modes fall back to the default grid size (33 for 3D, 17 for 4D).
The user can always override with an explicit number.

### Profile inspection: which table to read

The grid size is read from the profile's **relevant** table for its
role in the transform chain:

| Profile role | Table inspected | Why |
|---|---|---|
| Input (device → PCS) | A2B[intent] | A2B is the table the engine reads for device-to-PCS conversion |
| Output (PCS → device) | B2A[intent] | B2A is the table the engine reads for PCS-to-device conversion |

If the relevant table doesn't exist (matrix profile, or missing
intent fallback), the profile is skipped — it contributes no grid-
size constraint.

### `'test'` mode — automatic optimal resolution

---

> **Status: future work — not yet implemented.** The API and format support it today
> (gridSize is just a number by the time the LUT is built), but the
> test harness and diagnostic reporting are not yet designed.

---

A future `'test'` mode that finds the minimum grid size for a given
accuracy target:

1. Build a reference LUT at high resolution (65 or 97 points)
2. Build candidate LUTs at decreasing grid sizes (49, 33, 17, 9)
3. Transform a diagnostic test target through each
4. Compare each candidate against the reference — compute max ΔE
   and 95th-percentile ΔE
5. Return the smallest grid size where error is below threshold
   (e.g., < 0.5 ΔE76)
6. Include the accuracy report alongside the LUT

This is genuinely useful for 4D LUTs where memory grows as N⁴ —
the difference between 17⁴ (83K cells) and 33⁴ (1.2M cells) is
14× in memory. If 17 points gives sub-visual error, there's no
reason to pay for 33.

```js
// Future API sketch
const result = buildLutWithTest({
    inChannels: 4, outChannels: 3,
    gridSize: 'test',
    testOptions: {
        candidates: [9, 11, 17, 25, 33],
        maxDeltaE: 0.5,
        percentile: 95,
    }
}, callback);

// result.lut       — the optimal LUT
// result.gridSize  — the grid size chosen (e.g. 17)
// result.report    — { candidates: [{size, maxDE, p95DE, p99DE, meanDE}, ...] }
```

The test mode could also serve as a diagnostic tool — run it once
on a profile pair to discover the optimal grid size, then hard-code
that number in production. No runtime overhead, informed choice.

---

## 4. The TIFF workflow — visual LUT editing

This is the conceptual breakthrough that makes the LUT Builder
more than a serialisation utility. The idea: **export a LUT as a
TIFF image, edit the image in any colour-managed application, and
reimport the pixel data as modified LUT values.**

> **Historical flashback.** The "image as LUT transport" idea
> predates jsColorEngine by over 15 years. Around 2010, there was
> no way to do CMYK conversion in a browser — no WASM, no typed
> arrays, IE9 was the target. The solution: manually build a
> 33×33-step RGB identity grid in Photoshop using gradients and
> blend modes, convert to CMYK in Photoshop, and save as a
> headerless raw file. The raw CMYK values were then packed into a
> fake PNG image — RGBA doubled up so R=C, G=M, B=Y, A=K (yes,
> the alpha channel stored K), with the low byte in one pixel and
> the high byte in the next, giving u16 precision per CMYK channel.
> PNG is lossless, so the values survived compression intact. At
> runtime the PNG loaded into an `<img>` tag, the browser extracted
> RGBA via canvas, and the pixel data became a CMYK lookup table.
> The browser cached it as a normal image — free compressed binary
> LUT caching, no special infrastructure. It worked, and it shipped
> to production.
>
> The LUT Builder is the modern version of that same insight: **an
> image IS a LUT, the format handles compression and transport, and
> the editor handles colour math.** The difference is that today we
> have WASM-SIMD interpolation kernels, 16-bit TIFF support, custom
> tags for metadata, and a proper serialisation format — instead of
> packing u16 CMYK values into PNG alpha channels and hoping IE9
> wouldn't mangle them.

### 4.1 Why TIFF

TIFF supports every colour space and bit depth the Builder needs:

| Property | TIFF support |
|---|---|
| Greyscale, 8-bit | ✓ |
| Greyscale, 16-bit | ✓ |
| RGB, 8-bit | ✓ |
| RGB, 16-bit | ✓ |
| CMYK, 8-bit | ✓ |
| CMYK, 16-bit | ✓ |
| ICC profile embedding | ✓ |
| Lossless (LZW / ZIP compression) | ✓ |
| Private / custom tags (IDs 32768–65535) | ✓ |
| Universally supported by professional editors | ✓ |

**Hald CLUT — the existing standard for RGB.** The "identity grid as image" idea is already established as [Hald CLUT](https://www.quelsolaar.com/technology/clut.html), used in darktable, RawTherapee, and Affinity Photo. A Hald CLUT is a square PNG or TIFF containing a 3D RGB LUT as a tiled colour patch — the user opens it in any editor, applies their grade, and reimports it. The LUT Builder TIFF workflow is the same concept extended to the full colour space. Hald CLUT's limitations explain why it cannot be adopted directly: it is **RGB-only** (no CMYK, no greyscale, no duotone or N-channel), it has no metadata standard for embedding grid dimensions or channel mapping, and its primary use case is 3D RGB→RGB creative grading, not the CMYK↔RGB and CMYK↔CMYK workflows that are the LUT Builder's primary purpose. For RGB-to-RGB LUTs, a Hald CLUT-compatible export mode is a reasonable future addition — the pixel layouts are different but the idea is identical. For everything else (CMYK input, 4D, greyscale, duotone), the Builder's own TIFF layout is required.

No other format covers the full matrix. PNG lacks CMYK. JPEG is
lossy and 8-bit only. EXR is float but poorly supported outside
VFX tooling. TIFF is the lingua franca of colour-managed imaging.

**Custom TIFF tags and XMP — three-layer metadata resilience.** The implementation
writes LUT metadata into two machine-readable locations and one human-readable one:

1. **Private tag 32768** — a null-terminated JSON string (`jsce` namespace) written
   directly into the TIFF IFD. Fast to read; unfortunately Photoshop strips this tag
   on open/edit/save.

2. **XMP tag 700** — the same JSON is also embedded as `<jsce:LutMeta>` inside an
   XMP packet using a custom namespace (`xmlns:jsce="http://jscolorengine.io/lut/1.0/"`).
   Photoshop preserves unknown XMP namespaces through round-trips (empirically confirmed).
   This is the primary metadata path for Photoshop-edited TIFFs.

3. **Text strip** — the canvas text at the bottom of the TIFF includes the key
   parameters (`inCh=3 outCh=4 size=33 scale=3 bps=16`) in human-readable form.
   This is the last-resort fallback: if both tags are stripped by an obscure editor,
   a human can read the parameters from the image itself and supply them to
   `LutBuilder.fromTIFF(data, { size: 33, inCh: 3, outCh: 4 })`.

On export: all three layers are always written. On import: XMP is checked first,
tag 32768 as fallback. Photoshop also writes an embedded ICC profile (tag 34675)
which the importer reads and places as the chain output descriptor.

**TIFF as the transport format itself.** This opens an interesting
possibility: instead of JSON+b64, the LUT's native portable format
*could be* TIFF. The pixel data is the LUT. The custom tags are
the metadata. TIFF supports lossless compression (LZW, ZIP) which
the JSON format doesn't get for free. The file is both
human-viewable (open it in any image viewer) and machine-readable
(parse the tags + pixel data). A TIFF library is needed for
decompression, but the format itself is simpler than a custom
binary format — every platform has TIFF support.

### 4.2 Export: LUT → TIFF

A 3D LUT with grid size `N` and `C` output channels contains
`N³ × C` values. The Builder exports this as a TIFF image where:

- **Width** = `N²` (or `N × N`), **Height** = `N`
- Each row of `N²` pixels represents one "slice" of the 3D grid
  along the outermost axis
- Pixel values are the LUT output values in device space
- The TIFF is tagged with the output profile (if known) so editors
  display it correctly

**Implemented layout.** The LUT grid is packed as a 2D atlas of N×N slices arranged
in rows. For a 3D LUT with grid size N:

- `numSlices = N` (one 2D slice per outermost-axis value)
- `slicesPerRow = ceil(sqrt(N))` (roughly square packing)
- `slicesPerCol = ceil(N / slicesPerRow)`
- `lutW = slicesPerRow × N × scale`
- `lutH = slicesPerCol × N × scale`

For N=33, scale=3: `slicesPerRow=6`, `lutW = lutH = 594 px`. Each grid cell occupies
a `scale×scale` solid pixel block — the same value repeated across all `scale²` pixels.
This over-sampling means minor JPEG noise or Photoshop anti-aliasing is averaged out on
import (see §4.4). The default scale=3 gives a 9× sample count per cell.

For 4D CMYK (inCh=4): `numSlices = N²`, producing a perfect `N²×N²` square at scale=1.
At N=17: `289×289` pixels = exactly `17⁴ = 83,521` cells. Default scale=2.

For 1D tone curves (inCh=1): strip width = `N×scale`; height = `max(6×33×scale, N×scale)`
so large N (e.g. N=255) doesn't blow up the canvas beyond what preview images need.

**Canvas layout (actual implementation):**
```
┌──────────────────┬──────────────────┬──────────────┐
│ LUT grid         │ Preview images   │ Channel      │
│ (top-left, 0,0)  │ (right of LUT,   │ gradient     │
│ scale×scale      │  same height,    │ bars         │
│ solid blocks)    │  sRGB converted  │ (native ch   │
│                  │  to output CS)   │  values)     │
├──────────────────┴──────────────────┴──────────────┤
│ Text strip: ISO date, inCh/outCh/size/scale/bps    │
└────────────────────────────────────────────────────┘
```

The LUT region always starts at pixel (0, 0). Everything to the right and below is ignored
on import. The preview images (optional) are converted to the output colour space before the
LUT region is overwritten with the actual grid data.

For a 33-point 3D RGB LUT at scale=3:
- Export image: 594 × 594 px canvas + preview column, RGB, 16-bit
- After ZIP compression (Node.js default): **~409 KB**. Uncompressed would be ~3.6 MB
- Human-viewable: the 6×6 grid of colour patches is visually recognisable as a colour atlas

**Compression.** The exporter writes ZIP-compressed (DEFLATE, tag 259=8) TIFFs in Node.js
using the built-in `zlib` module — 4–9× smaller than uncompressed. The browser path writes
uncompressed (Canvas API, no zlib dependency). The importer uses `utif` (which bundles `pako`
for DEFLATE) and handles ZIP, LZW, and uncompressed transparently in both Node and browser.

**Sample TIFFs and preview images.** Three ready-to-use identity TIFFs are provided in
`samples/tiff_samples/` (generated by `npm run tiff-samples`). The preview images used in
those samples are AI-generated reference images — see
[`samples/images/readme.md`](../../samples/images/readme.md) for specifications, license,
and recommended use cases.

For a 4D CMYK → RGB LUT (17⁴ × 3 channels):
- Export image: 4913 × 17 pixels per K-slice (17 slices), or a single
  4913 × 289 image, 16-bit RGB

**Preview region — visual feedback during editing.** The exported
TIFF can optionally include reference images *above* the LUT data
region: skin tones, a landscape, a product shot, a colour checker —
whatever helps the user judge their adjustments visually. A
separator line (or metadata tag) marks the boundary between the
preview region and the LUT region below it.

```
  ┌──────────────────────────────────────────────────────┐
  │ LUT grid (0,0)  │ Preview images  │ Channel bars     │
  │ scale×scale     │ (right, colour- │ (native values)  │
  │ solid blocks    │  managed)       │                  │
  ├─────────────────┴─────────────────┴──────────────────┤
  │ Text strip (creation params, chain, copyright)       │
  └──────────────────────────────────────────────────────┘
```

When the user applies a Curves adjustment, a Hue/Saturation layer,
or a colour conversion in Photoshop, *both* regions are affected
identically. The preview region shows them what the adjustment
looks like on real content. The LUT region captures the same
adjustment as grid data. On import, the Builder reads only the LUT
region (it knows the pixel rows from the grid dimensions stored in
the TIFF's custom tags) and ignores the preview.

> **Resolved — tag preservation.** Empirical testing confirmed that Photoshop strips
> private tag 32768 on save. The solution is XMP (tag 700) with a custom namespace —
> Photoshop preserves unknown XMP namespaces. See §4.1 for the three-layer metadata
> design. The LUT region always starts at (0,0); the layout parameters in the tags
> define where it ends. If both tags are absent, the user can supply the parameters
> manually or read them from the text strip. See §9 open question #3 (resolved).

A companion web tool could generate these TIFFs — the user picks
grid size, preview images, and downloads a ready-to-edit TIFF.
After editing in Photoshop, they upload the result and the tool
validates + converts to a LUT file. This removes the "what am I
looking at?" friction entirely.

### 4.2b The three-stage build process

The TIFF export is implemented in three sequential stages. Understanding the ordering
explains why the result is always correct.

---

**Step 1 — Canvas drawing (visual decoration)**

The HTML5 Canvas API (`document.createElement('canvas')` in browsers, `node-canvas` in
Node) is used as the drawing foundation because it provides text rendering, image blitting,
and scaling with no custom layout engine needed. The canvas is always sRGB per the HTML
Canvas specification.

1. Fill background white (`#ffffff`).
2. Draw optional preview images into the right-hand column. Images are loaded async, each
   scaled to fill `lutH / numImages` height via `ctx.drawImage()`.
3. Write the text strip at the bottom: ISO timestamp, chain info, parameters, copyright.
4. Extract `Uint8ClampedArray` RGBA pixels from the canvas.

The canvas is never the final output — it exists only to position preview images and text.
The LUT grid data is never drawn on the canvas.

---

**Step 2 — Colour space conversion (build the output pixel buffer)**

The RGBA canvas pixels (sRGB) are converted to the LUT's output colour space and packed
into a flat `outPx` buffer (`Uint8Array` or `Uint16Array`, `outCh` values per pixel):

| Output type | `outputProfile` required? | Conversion |
|---|---|---|
| **sRGB** (`outCh=3`, profile name contains `srgb` / `iec61966`) | No | Copy R, G, B directly. Canvas IS sRGB — sRGB→sRGB is a no-op and is skipped. |
| **Other RGB** (`outCh=3`, e.g. AdobeRGB) | Optional | Strip alpha, then `Transform('*sRGB', outputProfile, perceptual)`. |
| **CMYK** (`outCh=4`) | Required when preview images are present | Strip alpha → 3ch RGB, then `Transform('*sRGB', cmykProfile, perceptual)` → 4ch CMYK. Without a profile: preview images are silently skipped (warning issued); LUT region and bars are still written correctly — the "untagged CMYK" path. |
| **Gray** (`outCh=1`) | No | BT.601 luminance: `L = 0.299R + 0.587G + 0.114B`. Pure arithmetic, no `Transform` call. |
| **Duo** (`outCh=2`) | No | Copy first two channels from RGBA directly. |

After this stage, `outPx` contains the entire canvas — preview images, text, and the
to-be-overwritten LUT region — all in the output colour space. The preview images are
now colour-accurate references: the user can see what their source images look like in
the target space before they apply any further adjustments.

---

**Step 3 — Native-space overwrite (LUT data + gradient bars)**

The LUT grid cells and gradient bars are written DIRECTLY into `outPx` as native
output-channel values, bypassing all colour conversion:

**LUT cells:**
Each cell `ci` maps to a `(px, py)` pixel position via `_cellPixelPos()`. A
`scale×scale` solid block is written from the LUT's stored `u16` value (scaled to
the target bit depth). This overwrites whatever stage 2 placed in the LUT region —
the conversion result there is intentionally discarded.

For 1D LUTs the block spans the full `lutH` height (each cell is a column, not a
square) so the tone curve renders as a visible gradient strip rather than a single
pixel row.

**Gradient bars:**
Bars are also written as native values, never drawn on the canvas:
- **CMYK (`inkMode = true`)**: ink ramps — `ci=val`, other channels=0. Bottom of gradient: `[0,0,0,0]` = no ink = white paper. ✓
- **RGB (`inkMode = false`, `outCh>1`)**: tint ramps — `ci=maxVal` (constant), non-ci channels fade 0→maxVal. Bottom: `[max,max,max]` = white. ✓
- **Gray (`outCh=1`)**: standard ramp, maxVal→0 (white → black). ✓

Writing bars as native values means they are always perceptually correct for the
output space. A 100% Cyan bar in a CMYK TIFF is `C=255,M=0,Y=0,K=0` — accurate,
regardless of the sRGB canvas it overlays.

**Why this order matters:**
If the stages were reversed (LUT first, then colour conversion), the carefully-placed
grid values would be corrupted by the colour transform. Doing stage 3 last guarantees:
1. Preview images are colour-accurate in the output space.
2. LUT cells are exactly in native output space — no double conversion.
3. Gradient bars are visually correct for the output colour space.

---

### 4.3 Edit: Photoshop (or any editor) as LUT transformer

Once the LUT is a TIFF, *any* image editing operation becomes a LUT
modification:

| Edit operation | LUT effect |
|---|---|
| Curves adjustment | Tone-response modification across the LUT |
| Hue/Saturation | Selective colour shift baked into the LUT |
| Convert to CMYK profile | **Captures Adobe CMM's RGB→CMYK conversion** |
| Convert to Greyscale | Creates an RGB→Grey LUT (3D→1ch) |
| Apply a Photoshop Action | Any automated pipeline becomes a LUT |
| Colour Balance / Photo Filter | Creative colour grading |
| Selective Color | Per-primary ink adjustments |

The profound implication: **you don't need to reverse-engineer
Adobe's CMM.** You just:

1. Export an identity RGB LUT as a 16-bit TIFF
2. Open it in Photoshop
3. Convert → CMYK using Adobe's engine (with any profile, any intent)
4. Save the CMYK TIFF
5. Import it back into the LUT Builder

The resulting LUT is a 3D RGB→CMYK table that *exactly* reproduces
what Adobe's CMM would do — sampled at the LUT's grid resolution.
You've captured their CMS without writing a single line of
colour-math code. And this works for *any* editor, *any* CMS:
Capture One, Affinity, GIMP (lcms-backed), even macOS ColorSync
via Preview.app.

**3D vs 4D editing — visual process vs workflow process.** For 3D
RGB-input LUTs the TIFF workflow is intuitive — the exported image
looks like smooth colour gradients and the user can see what their
adjustments do. For 4D CMYK-input LUTs the image is an abstract
grid atlas that doesn't look like anything meaningful to the human
eye. That's fine — **4D editing is a workflow process, not a visual
one.** The user builds their adjustment layers, curves, and colour
corrections on real images in a separate document, records them as
a Photoshop Action, then batch-applies the Action to the 4D TIFF
atlas. The preview region (§4.2) helps here: the reference images
above the line show the effect, the LUT data below the line
captures it.

Once this workflow clicks, it's powerful — the same Action that
applies a CMYK TAC limit to production images also applies it to
the LUT TIFF, and the result is a device-link LUT that runs at
WASM-SIMD speed. But the documentation and any companion web tool
should be clear: 4D TIFF editing is a batch-process workflow, not
a "look at the image and tweak" workflow.

### 4.4 Import: TIFF → LUT

The Builder reads the TIFF pixel data, maps pixel coordinates back
to grid positions using the inverse of the export layout, and
populates a new LUT object. The import respects bit depth — 16-bit
TIFF → u16 grid values → the `intLut` is built directly, no f64
round-trip.

**Implemented import features:**

- **Channel count auto-detection.** The importer reads `SamplesPerPixel` (tag 277) from the
  TIFF header. If it differs from the metadata's `outCh` (e.g. the user converted from RGB
  to CMYK in Photoshop), the importer updates `outCh` to match the actual TIFF. The input
  channel count (`inCh`) is always preserved from the metadata.

- **Bit depth.** 8-bit and 16-bit TIFFs are both supported. 16-bit values are read as
  little-endian pairs; 8-bit values are stretched to u16 (`v * 257`) to preserve the full
  range. The internal `_u16` storage is always Uint16Array.

- **Cell validation (spread check).** Each `scale×scale` pixel block must have low LSB
  spread across its samples. Threshold: 514 u16 for 8-bit input (2 u8 LSB × 257), 512 u16
  for 16-bit. Exceeding the threshold throws with a clear error — indicating JPEG compression,
  a painted-over cell, or wrong scale. This prevents silently importing corrupted data.

- **Planar format rejection.** PlanarConfiguration=2 (RRRGGGBBB instead of RGBRGBRGB) throws
  immediately with a message directing the user to re-save as interleaved (Photoshop default).

- **Embedded ICC profile extraction.** If the TIFF carries an embedded ICC profile (tag 34675,
  written automatically by Photoshop on colour-space conversion), it is loaded as a `Profile`
  object and the resulting descriptor is placed as `chain[2]` (the output descriptor). This
  means a TIFF converted by Photoshop from sRGB to GRACoL CMYK automatically gets the correct
  chain output descriptor — no user intervention needed.

- **Compression.** `utif` (with bundled `pako`) handles ZIP (tag 8), LZW (tag 5), and
  uncompressed (tag 1) transparently on both Node and browser.

### 4.5 What this unlocks

The TIFF workflow makes the LUT Builder a universal CMS bridge:

```
  ANY colour-managed editor
         │
         │  (open TIFF, apply colour conversion or effect, save)
         │
         ▼
  Modified TIFF  →  LUT Builder import  →  LUT  →  jsCE WASM-SIMD
```

This is not about mimicking LittleCMS. It's about the **ability to
capture the output of any CMS or colour workflow** as a reusable,
high-performance LUT:

- **Adobe CMM** — open in Photoshop, convert, save.
  RGB→CMYK, RGB→Grey, CMYK→CMYK TAC limits, device links.
- **LittleCMS** — open in GIMP/Scribus/darktable, convert, save.
  Or use the Tier 3 lcms-wasm bridge for programmatic capture.
- **macOS ColorSync** — open in Preview, assign/convert profile, save.
- **Custom pipeline** — any Photoshop Action, any batch script, any
  tool that can open a TIFF, transform its colours, and save.

The LUT captures the *result* of the conversion, not the *method*.
The engine doesn't need to know or care how the colours were
transformed — it interpolates the grid the same way regardless.

---

## 5. LUT serialisation — the portable format

### 5.1 Realisation — the existing LUT object IS the format

The engine's `createLut()` already produces a self-describing object
with chain, grid shape, strides, encoding, and CLUT data. And
`setLut()` already handles base64-encoded CLUTs with a `precision`
flag. So the serialisation format isn't a new schema — it's the
**existing LUT object** with the CLUT as base64, plus metadata
fields on top for provenance and discoverability.

No separate `LutSerializer` class is needed. A `serialize()` /
`deserialize()` helper pair is enough — one encodes the CLUT to
base64 and stamps metadata, the other decodes and regenerates
strides.

> **Two APIs, one format — what shipped.**
> The serialisation lives on **Transform** as the format authority,
> with **LutBuilder** wrappers for builder-side workflows:
>
> | Method | Use when |
> |---|---|
> | `transform.toJSON(opts)` | You have a built `Transform` and want a JSON payload. Auto-called by `JSON.stringify(transform)` (JS protocol). |
> | `Transform.fromJSON(input, opts)` | Static. Parses string-or-object, returns a ready-to-use `Transform`. The runtime path — no profiles, no LutBuilder needed. |
> | `Transform.lutToJSON(lut, opts)` | Static. The format authority — encodes any LUT object. Both LutBuilder.toJSON and transform.toJSON delegate here. |
> | `Transform.jsonToLut(input)` | Static. Decodes JSON → f64 LUT object. |
> | `builder.toJSON(opts)` | Builder-side; delegates to `Transform.lutToJSON`. Identical CLUT bytes to `transform.toJSON()`. |
> | `LutBuilder.fromJSON(input)` | Builder-side; returns a builder you can edit/clone/re-export. |
>
> **Identical wire format.** `JSON.stringify(transform)` and
> `JSON.stringify(builder.toJSON())` produce byte-identical CLUT
> data — they call the same `Transform.lutToJSON` helper.
>
> **No auto-build on serialise.** `transform.toJSON()` throws if
> the Transform has no LUT (i.e. it was constructed without
> `buildLut: true` and no LUT was set via `setLut()`). Auto-building
> on demand would silently swap the f64 pipeline (lossless) for a
> grid-sampled LUT path (~0.06 ΔE76 grid error at 33 points) — that
> kind of hidden precision loss is exactly the bug class JSON
> portability is meant to avoid. The error message hints at
> `buildLut: true` for callers who do want a LUT-backed JSON.

### 5.2 Format

The existing LUT fields from `createLut()` form the core. Metadata
wraps around them:

```js
{
  // ── Traceability metadata (ignored by engine, for humans / tooling) ──

  "created":   "2026-04-29T12:00:00.000Z",         // optional — build timestamp
  "generator": "jsColorEngine LUT Builder",         // optional — what produced this file

  "description": "sRGB → GRACoL2006 perceptual (BPC)", // optional — auto-generated from chain
  "source":      "lcms-wasm 2.16 + jsColorEngine 1.4", // optional — colour math source
  "link":        "https://github.com/.../jsce-luts",    // optional — provenance URL

  "compatibility": {                                // optional — build provenance
    "engine":     "jsColorEngine",
    "version":    ">=1.4",
    "cms":        "lcms-wasm",
    "cmsVersion": "2.16",
    "method":     "tier3-lcms-bridge"
  },

  "meta": {                                         // optional — user-defined metadata
    "author":  "Glenn Wilton",
    "license": "CC-BY-4.0",
    "tags":    ["prepress", "offset", "coated"],
    "notes":   "Built from vendor-supplied GRACoL2006 profile, BPC enabled",
    "adjustments": [                                // optional — document post-build edits applied to the LUT
      "Saturation +20%",
      "Contrast -10",
      "Curves: lift shadows R+5 G+3 B+0",
      "Selective Color: Cyans → Cyan -15%"
    ]
  },

  // ── Engine LUT data (same shape as createLut() output) ──

  // Profile chain — routing metadata + provenance. Each profile entry is the
  // `profile2Obj()` shape (cut-down profile info, NOT a full Profile instance):
  // no A2B/B2A tables, no TRCs, no matrices — just the fields the pipeline
  // needs (header, name, type, version) plus provenance (description,
  // whitePoint, mediaWhitePoint, PCSEncode/Decode, viewingConditions).
  //
  // The minimal-viable chain entry below is what `virtualProfile()` produces;
  // engine-built LUTs (real ICC profiles or `*sRGB` virtuals) carry the full
  // profile2Obj output, which has more fields but the same shape.
  "chain": [
    { "header": {"colorSpace":"RGB"}, "name": "sRGB IEC61966-2.1", "type": 1, "version": 4 },
    0,                                              // intent (raw number)
    { "header": {"colorSpace":"CMYK"}, "name": "GRACoL2006_Coated1v2", "type": 3, "version": 4 }
  ],

  "version":        1,                              // LUT format version
  "inputChannels":  3,                              // number of input channels (3=RGB, 4=CMYK)
  "outputChannels": 4,                              // number of output channels
  "gridPoints":     [33, 33, 33],                   // grid size per input axis (array supports asymmetric, e.g. [33, 48, 99])
  "dataType":       "u16",                           // serialised CLUT precision: 'u16' (default), 'f32', or 'f64'
  "encoding":       "base64",                       // serialisation: 'base64' or 'number'

  // Content fingerprint — FNV-1a 32-bit (Math.imul-based, ~1ms for typical LUTs).
  // Algorithm-prefixed for upgradability ("FNV1A:..." today; "SHA256:..." in future).
  // Hash input: inCh + outCh + gridPoints + chain (name|type|version per entry)
  // + u16 full-scale CLUT bytes.
  //
  // Computed lazily — engine create() does NOT stamp (hot path stays clean).
  // toJSON() lazy-computes on export. LutBuilder.fromTransform / createFromLCMS
  // stamp at extraction time (audit/edit workflow). Survives editLut(), which
  // records the edit in meta.adjustments[] instead — comparing this signature
  // to a recompute on the current data tells you whether the LUT was edited.
  // Not cryptographic — for adversarial tamper-evidence, sign externally.
  "originalSignature": "FNV1A:26c2efad",           // optional

  "outputScale":    1,                              // CLUT output pre-scale (e.g. 255 for 8-bit output from floats)
  "inputScale":     1,                              // CLUT input pre-scale (e.g. 1/255 to normalise u8 input to 0–1)

  "gamutMode":      "none",                          // optional — gamut handling baked into the LUT:
                                                    //   'none'     — no gamut check (default, all cells are real conversions)
                                                    //   'color'    — out-of-gamut cells replaced with a false colour (e.g. pink)
                                                    //   'map'      — cells contain scaled ΔE (greyscale gamut map)
                                                    //   'colorMap' — cells blend from white to false colour by ΔE
  "gamutLimit":     0,                              // optional — ΔE76 threshold for 'color' mode
  "gamutMapScale":  0,                              // optional — ΔE scale factor for 'map'/'colorMap' modes
  "inLab":          null,                           // optional — Lab encoding info if input is Lab
  "outLab":         null,                           // optional — Lab encoding info if output is Lab

  "CLUT": "base64-encoded Uint16Array..."            // the LUT data (type matches dataType)
}
```

The `description` field can be auto-generated from the chain —
walk the descriptors and intents to produce "sRGB → perceptual →
GRACoL2006 (BPC)".

Strides (`g1`, `g2`, `g3`, `go0`, `go1`, `go2`, `go3`) are
regenerated on deserialise from `gridPoints` and channel counts
rather than stored. This avoids stale stride data if anything is
edited.

**Asymmetric grids.** `gridPoints` is an array — one value per
input axis — so the data layout supports asymmetric grids like
`[33, 48, 99]`. The stride computation in `createLut()` already
handles this correctly (`g2 = g1 * gridPoints[1]`, not `g1 * g1`).
However, the current interpolation kernels assume symmetric grids
(they read `gridPoints[0]` for all axes and compute strides as
powers of that single value). Asymmetric interpolation would need
per-axis grid sizes threaded through the kernel — straightforward
but not yet implemented. For now, Builder LUTs should use symmetric
grids. The format is ready for asymmetric when the kernels are.

#### Real numbers — size and timing

For a typical 33-pt 3D `sRGB → GRACoL2006` LUT (33³ × 4 = 143,748 u16 values):

| Property | Value | Notes |
|---|---|---|
| Raw u16 CLUT | 281 KB | what the wire payload covers |
| u16 base64 | ~374 KB | default `dataType: 'u16'` |
| u8 base64 | ~187 KB | opt-in `dataType: 'u8'`, lossy ~1 LSB |
| Gzipped over HTTP (u16) | ~220 KB | content-encoding: gzip |
| JSON metadata overhead | ~1.7 KB | chain, gridPoints, scales — negligible |
| **Build LUT (engine + buildLut)** | **~17 ms** | one-time, build-time |
| **Sign LUT (FNV-1a 32-bit)** | **~1.3 ms** | only on toJSON / fromTransform |
| **`Transform.fromJSON` (parse + setLut)** | **~5 ms** | runtime startup vs. ~50 ms for full ICC pipeline build |
| **`transformArray` per-pixel** | unchanged | LUT path = same kernels as engine-built |

Numbers measured on Node 20, x64, no WASM SIMD (pure JS path). Build cost is paid once at deploy time; runtime cost is just `fromJSON` startup. Per-pixel transform speed is the same kernel path as a Transform built from profiles directly — the LUT origin doesn't matter once it's loaded.

The shape of the trade-off: **paying ~17 ms once at deploy lets the runtime skip ~50 ms of profile parsing + pipeline build, ship 280 KB instead of 2.7 MB of ICC profiles, and execute zero code paths through ICC tag tables.** For a web app that wants RGB → CMYK soft-proofing on ten thousand pixels per frame, this is the difference between "ship lcms+profiles+engine" (~2 MB JS+WASM, ~150 ms cold start) and "ship one engine + one JSON" (~700 KB total, ~5 ms cold start).

#### What this looks like in the demo

The companion sample [`samples/lut-cmyk-to-rgb.html`](../../samples/lut-cmyk-to-rgb.html) builds a 17⁴ 4D `GRACoL2006 → sRGB` LUT two ways — once via the engine pipeline (`buildLut: true`), once via `LutBuilder.createFromLCMS(lcms, xform, …)` sampled from lcms-wasm. Then it serialises both to JSON, rebuilds Transforms from those JSONs, and converts a 240 K-pixel CMYK image three ways: live full-pipeline (no LUT), jsCE-built LUT, and lcms-built LUT. Representative measurements from a current Chrome on x86_64:

| Operation | jsCE LUT | lcms LUT |
|---|---|---|
| Build | 28 ms | 80 ms |
| JSON size (u16 b64) | 654 KB | 653 KB |
| Signature | `FNV1A:ac1b727e` | `FNV1A:d9dda652` |
| `Transform.fromJSON` cold start (parse + setLut + intLut) | 6 ms | 6 ms |
| Per-frame `transformArray` (240 K px) | 6.7 ms | 4.1 ms |

| Pixel-output comparison (240 K px) | mean ΔP | p95 ΔP | max ΔP |
|---|---|---|---|
| live (no LUT) → jsCE LUT | 0.90 | 4.0 | 20.0 |
| live (no LUT) → lcms LUT | 1.01 | 4.0 | 18.0 |
| jsCE LUT → lcms LUT | 0.50 | 3.0 | 11.0 |

| Cross-engine LUT raw data (u16 bytes) | jsCE vs lcms |
|---|---|
| Mean per-channel ΔP | **0.10** |

**The headline number is `0.10 ΔP` mean per-channel agreement between jsCE-built and lcms-built grids.** Both engines land on essentially the same colour math for `GRACoL2006 → sRGB relative+BPC` — the LUTs are interchangeable runtime artefacts.

The mean pixel ΔP of ~1 between live (f64 pipeline) and either LUT is **grid-interpolation noise**: 17 sample points per CMYK axis means ~6.25% of device range between samples; smooth ICC profiles interpolate cleanly through that, while rough ones (K-generation transitions, gamut boundaries, TAC clamps) can deviate at one or two pixels — which is where the max ΔP of ~20 comes from. p95 ΔP of 4 says 95% of pixels are within 4 code values, which is invisible at 8-bit display.

For most production CMYK→RGB work, **a 17⁴ LUT at 654 KB is the right budget**. A 33⁴ grid would cut max ΔP roughly 4× at the cost of ~10 MB JSON — overkill unless the workflow has hard sub-LSB requirements at every pixel.

#### Serialisation precision — why u16 is the default

The f64 CLUT stores [0..1] floats at 64-bit precision, but this
is overkill for serialisation. The downstream integer kernels
never use more than 16 bits of precision from the f64 source
(`buildIntLut()` scales by 65535 or 65280 and rounds to u16).
The float kernel also gains nothing meaningful from f64 vs u16
storage — the interpolation error from grid spacing (~0.06 ΔE76
at 33 points) dwarfs the quantisation noise of u16 (1/65535 ≈
0.0015% per channel).

| `dataType` | Bytes/value | 33pt 3D RGB→CMYK | Precision | Use case |
|---|---|---|---|---|
| `'u16'` | 2 | ~281 KB | 65535 levels | **Default.** Bit-exact for u16 intLut path. ±0.5 LSB on u8 rescale — identical to f64→u8. |
| `'f32'` | 4 | ~562 KB | 23-bit mantissa (~7 digits) | Overkill for integer paths. Useful if the LUT will be consumed by a float-only pipeline elsewhere. |
| `'f64'` | 8 | ~1.1 MB | 52-bit mantissa (~15 digits) | Full internal precision. Only needed for debug/audit or if the CLUT will be mutated with sub-u16 precision math. |

The `'u16'` format is lossless for both runtime paths:

- **u16 intLut** (scale 65535): deserialise u16 → divide by
  65535 → f64 CLUT → `buildIntLut()` multiplies by 65535 → same
  u16 value. Bit-exact round-trip (see §6.2b).
- **u8 intLut** (scale 65280): deserialise u16 → f64 → multiply
  by 65280 → round. The result is at most ±0.5 LSB from what
  you'd get starting from f64 — indistinguishable.
- **Float kernel**: interpolates from the f64 CLUT, which was
  reconstructed from u16. The quantisation noise (1/65535) is
  ~0.004 ΔE76 worst case — well below the grid interpolation
  error.

On deserialise, the u16 values are expanded back to f64 (÷ 65535)
to reconstruct the universal f64 CLUT. From there, `toTransform()`
builds whichever intLut the `dataFormat` requires — exactly the
same path as a freshly-created LUT.

The `intLut` is **not serialised**. It is a derived, mode-specific
artefact that `buildIntLut()` rebuilds at `toTransform()` time
from the f64 CLUT. Serialising it would lock the LUT to a specific
output bit depth and double the payload size for no gain — the
rebuild cost is negligible (< 1 ms for a 33-point 3D LUT).

### 5.3 Design goals

| Goal | How the format achieves it |
|---|---|
| **Human-readable** | `description`, `chain`, and `meta` are plain text/objects. `jq .description` tells you what the LUT does; `jq .chain` shows the full colour journey. |
| **Small** | CLUT as base64 u16. A 33-point 3D RGB→CMYK LUT is ~281 KB as JSON (was ~1.1 MB as f64). |
| **Self-describing** | `chain`, `inputChannels`, `outputChannels`, `gridPoints`, `dataType` tell you everything about the LUT's shape without parsing the binary data. |
| **Universal** | Serialises the f64 CLUT (as u16 by default). `toTransform()` builds the mode-specific intLut at runtime from the universal data — same LUT file works for u8, u16, and float pipelines. |
| **Same shape as engine** | The core fields match `createLut()` output exactly. `setLut()` already handles base64 decoding. No adapter layer needed. |
| **Tagged** | `compatibility` block records how the LUT was made — which engine, which CMS, which method. |
| **Extensible** | `meta` is a free-form object. Build LUT managers, selectors, search indexes from metadata without touching the heavy data. |

### 5.4 Compatibility tags

When sharing LUTs, the `compatibility` block answers three questions:

1. **What engine can consume this?** — `engine` + `version` fields.
   LUTs tagged `jsColorEngine >=1.4` will work with any future
   version that honours the `setLut()` contract.
2. **What CMS produced the colour math?** — `cms` + `cmsVersion`.
   A LUT built via the lcms bridge records `lcms-wasm 2.16`; one
   built via TIFF round-trip through Photoshop records
   `Adobe CMM (Photoshop CC 2026)`.
3. **How was it built?** — `method` field. Values like
   `tier1-jsce-native`, `tier2-custom-callback`,
   `tier3-lcms-bridge`, `tiff-roundtrip-photoshop` describe the
   provenance without ambiguity.

These tags are informational — the engine doesn't enforce them.
They exist so that LUT library maintainers and downstream tools can
filter, search, and validate compatibility without loading the
binary data.

### 5.5 Verification — proving a LUT matches a workflow

Tags are self-reported. For casual sharing that's fine, but for
regulated prepress or audit workflows, a tag alone doesn't prove
the LUT faithfully captures the claimed CMS. The Builder should
support an optional verification system:

1. **Reference test target.** Ship a standard small test image with
   the Builder (a compact colour checker or synthetic gradient —
   small enough to embed, diverse enough to exercise the gamut).
2. **Hash on build.** When the LUT is created, the Builder runs the
   reference target through the LUT (via `transformArray`) and
   stores a hash of the output alongside the LUT metadata.
3. **Verify on demand.** A third party can take the same reference
   target, run it through their own CMS pipeline (Photoshop, lcms,
   whatever the LUT claims to match), and compare the output
   against the stored hash. If the hash matches (within grid-
   interpolation tolerance), the LUT is verified to reproduce that
   workflow.

This doesn't require trust in the LUT author — the verification is
independently reproducible. The reference target, the LUT, and
the hash are all the verifier needs.

For the TIFF round-trip workflow specifically, the verification
path is even simpler: supply the source identity TIFF, the LUT
file, and the edited TIFF from Photoshop. The Builder converts
the reference target using the LUT and compares against the
Photoshop output pixel-by-pixel, reporting max delta. If the
delta is within the grid's interpolation tolerance, the LUT is a
faithful capture of that Photoshop conversion.

---

## 6. The lcms bridge — bit-exact CMS capture

### 6.1 Why not just emulate lcms directly?

As discussed in §1.1, direct emulation is impractical. But the LUT
Builder reframes the question: **you don't need to emulate lcms if
you can capture its output.**

A 33-point 3D LUT samples the colour function at 33³ = 35,937
grid points. If you run lcms's `cmsDoTransform` at each of those
grid points and record the output, you have a perfect (to grid
resolution) snapshot of lcms's colour math — including all of its
internal pipeline stages, clamping behaviour, S15.16 fixed-point
precision, gamut mapping, and intent-specific handling.

At runtime, jsCE interpolates between those grid points using its
own tetrahedral kernels. The interpolation error is bounded by the
grid spacing — for a 33-point grid, worst case is ~0.06 ΔE76 on
smooth transforms (measured in
[Accuracy.md](./Accuracy.md#lut-grid-size-and-interpolation-error)).
That's below visual threshold for any practical application.

### 6.2 How the bridge works

```
  BUILD TIME (once)                     RUNTIME (per image)
  ────────────────────────────          ────────────────────────────
  ICC profiles                          lut.json  (~400 KB for 33pt)
      ↓                                    ↓
  lcms-wasm cmsCreateTransform()        LutBuilder.fromJSON(json)
      ↓                                    ↓
  builder.createFromLCMS()              builder.toTransform()
      ↓                                    ↓
  builder.toJSON()                      transformArray()  ← WASM-SIMD
      ↓                                    ↓
  lut.json                              pixels ✓ lcms-accurate
                                            ✓ no profiles loaded
                                            ✓ no lcms at runtime
                                            ✓ no buildIntLut()
```

The bridge function is intentionally thin — ~20 lines. It:

1. Takes an already-initialised `lcms-wasm` instance and transform
   handle (the user manages lcms lifecycle).
2. For each grid point, computes the u16 input coordinate
   (`Math.round(index / sizeMax * 65535)`) and passes it to
   `lcms.doTransformU16()`.
3. lcms returns device-space u16 colour values (0–65535). The bridge
   stores them directly in the canonical Uint16Array (§2.4) — no
   normalisation step, no precision loss. This is the zero-copy path:
   lcms u16 → internal u16, bit-exact.
4. At `toTransform()` time, the u16 data is expanded to f64 for the
   float CLUT and encoded into the mode-specific intLut — exactly
   the same path as any other LUT.

The bridge is **not core functionality**. It's an optional helper
that lives in the Builder, not in the engine. The engine has zero
dependency on lcms-wasm.

### 6.2b Why u16 internal storage is lossless

The Builder stores all LUT data as u16 internally (§2.4).
At `toTransform()` time, the u16 values are expanded to f64 for
the float CLUT and re-encoded for the mode-specific intLut. Does
this lose precision?

**No — for any downstream path.**

**Callback [0..1] → u16 → f64 → intLut:**

```
callback returns 0.500007629  (any float in [0..1])
    × 65535 + round  →  u16    (32768)              ← quantised to u16
    ÷ 65535           →  f64    (0.500007629...)     ← exact in f64
    × 65535 + round   →  u16    (32768)             ← bit-exact
```

The quantisation step (float → u16) discards sub-u16 precision,
but that precision is below the noise floor of every downstream
consumer. The u16 → f64 expansion is exact (Float64's 52-bit
mantissa preserves all 16 bits), and the f64 → intLut encoding
recovers the original u16 value bit-exactly.

**lcms u16 → internal u16 → intLut:** Zero-copy for the u16
intLut path (scale 65535 — the internal value IS the intLut value).
For the u8 intLut path (scale 65280): `V * 65280 / 65535` is a
rescale, not a round-trip error.

**u16 → f64 for float kernel:** The quantisation noise of u16
(1/65535 ≈ 0.0015% per channel) produces ~0.004 ΔE76 worst case —
well below grid interpolation error (~0.06 ΔE76 at 33 points).

**TIFF round-trip:** 16-bit TIFF pixel values are u16. Import
stores directly in the internal Uint16Array. Export reads directly
from it. No conversion, no loss.

**This is why all sources converge to u16 internally.** It matches
the precision ceiling of ICC profiles, TIFF workflows, lcms, and
the engine's integer kernels. The float kernel's quantisation noise
from u16 storage is invisible.

### 6.2c What we are sampling (and what we are not)

An important distinction: the lcms bridge samples the **transform
output**, not lcms's internal LUT data. `lcms.doTransformU16()`
runs the full lcms pipeline — input linearisation, A2B/B2A table
interpolation, gamut mapping, chromatic adaptation, output
re-encoding — and returns device-space colour values. These are
the same values you would get by calling `cmsDoTransform()` on a
single pixel.

This matters because lcms internally uses its own LUT encoding
tricks (S15.16 fixed-point, per-stage clamping, etc.) that are
not exposed through the transform API. We don't need to know about
those internals. We treat lcms as a black-box colour function:
input coordinates in → colour values out → normalise → store.

The grid resolution determines accuracy: at 33 points per axis,
interpolation error on smooth transforms is ~0.06 ΔE76 (see
[Accuracy.md](./Accuracy.md#lut-grid-size-and-interpolation-error)).
For steep or discontinuous transforms, a larger grid (49, 65) can
be used — the Builder's `size` option controls this directly.

### 6.3 Two usage patterns

**Proactive — "I want 100% lcms-identical output."**

Use case: regulatory workflow where the reference implementation
is lcms (Scribus, GIMP, PDF/X validation). Build the LUT once
at startup from lcms, serialize it, ship it as a static asset.
Runtime never touches lcms.

**Reactive — "My normal jsCE pipeline failed, fall back to lcms."**

Use case: exotic ICC profiles that jsCE can't parse (rare vendor
extensions, damaged tag tables). Detect the failure at `create()`
time, fall back to `builder.createFromLCMS()` using lcms
as the colour math backend. Same kernel speed, different math
source. Transparent to the calling code.

---

## 7. API surface

### 7.1 Design principles

1. **`LutBuilder` is the primary API.** One class, fluent methods,
   every workflow. No standalone functions to remember.
2. **Fluent chaining.** Every method except the output methods
   (`toTransform()`, `toJSON()`, `toLut()`, `exportTIFF()`)
   returns `this`, enabling clean one-liners:

   ```js
   const transform = new LutBuilder()
       .create({ inChannels: 3, outChannels: 4, size: 33 }, callback)
       .setChain([input, eIntent.perceptual, output])
       .addMeta({ author: 'Glenn' })
       .toTransform({ dataFormat: 'int16' });
   ```

3. **Errors throw.** The builder is a helper tool — if something
   is wrong (bad channel count, missing callback, invalid chain),
   it throws immediately with a clear message. No error-return
   pattern, no silent failures. Callers who need graceful handling
   wrap in try/catch.
4. **No separate serialiser.** `.toJSON()` and
   `LutBuilder.fromJSON()` live on the builder itself. The LUT
   object shape from `createLut()` IS the format (§5) — serialisation
   is just base64-encoding the CLUT and stamping metadata.
5. **Virtual profiles solve the chain problem.** Callback-created
   LUTs need chain descriptors for `setLut()` routing (§8b). Instead
   of making the user build raw descriptor objects, convenience
   helpers produce them from colour-space names.
6. **Callbacks always work in [0..1].** No u16 callback mode.
   The builder owns all integer encoding — `buildIntLut()` at
   `toTransform()` time handles the 65280/65535 scale, so the
   callback never sees internal LUT constants. See §6.2b for the
   precision proof.
7. **`.toTransform()` replaces wordy wrappers.** Getting a
   ready-to-use Transform is always `builder.toTransform(options)` —
   no `buildCustomLutTransformU16`.

### 7.2 `virtualProfile()` — synthetic chain descriptors

Every LUT needs a `chain` for `setLut()` pipeline routing (§8b).
When you build a LUT from ICC profiles, the chain comes from the
profiles themselves. When you build from a callback, lcms, or TIFF
round-trip, there are no profiles — but the chain still needs
minimal descriptors with `header`, `name`, `type`, and `version`.

**What the chain is actually used for.** Only the **first** and
**last** entries in the chain are read by the pipeline — they tell
`createPipeline()` the input/output channel count and encoding
(device vs PCS). The intent entries between them are purely
**documentation** — they record what rendering intent the LUT was
built with, but the engine doesn't use them at runtime (the LUT
already has the intent baked into its grid values). If you don't
know or care about the intent, use `eIntent.perceptual` as a
sensible default.

`virtualProfile()` creates these descriptors from a colour-space
spec and an optional options object:

```js
import { virtualProfile } from 'jsColorEngine/LutBuilder';

const input  = virtualProfile({ colorSpace: 'RGB',  name: 'Web input' });
const output = virtualProfile({ colorSpace: 'CMYK', name: 'Press output' });

// With optional reference metadata
const output = virtualProfile(
    { colorSpace: 'CMYK', name: 'GRACoL press' },
    { whitePoint: illuminant.d50, mediaWhitePoint: illuminant.d50 }
);
```

The second parameter is an options object for reference metadata.
The whitepoint fields are **not used by the pipeline** (LUTs are
data-in/data-out — see §7.2b below), but they're valuable as
provenance: they document what whitepoint the LUT was built for,
which helps downstream tools and humans understand the LUT's
intended context.

**Convenience wrappers** for common types:

```js
virtualRGB('sRGB-like input')     // → { header: {colorSpace:'RGB'},  type: eProfileType.RGBMatrix, ... }
virtualCMYK('GRACoL press')       // → { header: {colorSpace:'CMYK'}, type: eProfileType.CMYK, ... }
virtualGray('Mono output')        // → { header: {colorSpace:'GRAY'}, type: eProfileType.Gray, ... }
virtualLab('Lab working space')   // → { header: {colorSpace:'Lab'},  type: eProfileType.Lab, version: 4, ... }
```

**`*`-prefixed names → full virtual profiles.** If the name
starts with `*`, the wrapper delegates to `Profile.createVirtualProfile()`
and runs the result through `profile2Obj()` — producing a
**full** descriptor with real primaries, whitepoint, matrix,
gamma, and all the metadata that a real ICC profile would carry:

```js
virtualRGB('*sRGB')       // → full sRGB descriptor via createVirtualProfile('sRGB')
virtualRGB('*AdobeRGB')   // → full AdobeRGB descriptor
virtualLab('*lab')        // → full Lab D50 descriptor
virtualLab('*labD65')     // → full Lab D65 descriptor
```

This is useful when the chain needs to carry accurate profile
metadata for provenance or compatibility tagging — e.g. when
serialising a LUT that was built from a known standard colour
space and you want the chain to document the exact primaries and
whitepoint.

All wrappers produce objects matching the `profile2Obj()` shape
(§8b) — the minimum contract that `createPipeline()` reads when
`useCachedLut = true`. The `type` field is derived from the colour
space; `version` defaults to 4.

These descriptors go into the chain either manually or via
`builder.setChain()`:

```js
builder.setChain([input, eIntent.perceptual, output]);
```

For the common case where you just need "3ch in, 4ch out", the
builder can auto-generate a chain from `inChannels` /
`outChannels` — the virtual profile names default to
`'LUT input (3ch)'` / `'LUT output (4ch)'`. Explicit chain is
only needed when you want meaningful names or non-default profile
types (e.g. Lab).

### 7.2b LUTs and whitepoints — data in, data out

A LUT is a pure lookup table: input values go in, output values
come out. The grid cells contain pre-computed colour values — the
LUT doesn't know or care *how* those values were derived, what
colour space they're in, or what whitepoint was used during
construction.

**This means whitepoint adaptation is the LUT creator's
responsibility, not the LUT's.** When you build a LUT from a
callback or lcms bridge, you must ensure the callback handles any
necessary chromatic adaptation (D65 → D50, Bradford, etc.)
internally. The engine's pipeline, when running in `useCachedLut`
mode, does not apply additional whitepoint corrections — it
interpolates the grid values as-is.

For engine-built LUTs (Tier 1, via `buildLut: true`), this is
handled automatically — the pipeline's chromatic adaptation stages
are baked into the grid values during `createNDDeviceLUT()`. For
Tier 2/3 LUTs, the caller owns the colour math and must account
for whitepoint if their conversion requires it.

The `whitePoint` field on virtual profile descriptors is purely
**reference metadata** — it documents what whitepoint the LUT was
designed for, so humans and tools can verify assumptions. It does
not cause any runtime conversion.

### 7.3 `LutBuilder` — the primary API

`LutBuilder` is a stateful class. It holds a LUT in memory and
provides lifecycle operations: create, load, mutate, annotate,
export.

#### Entry points

```js
// Empty — then call a create method
const builder = new LutBuilder();

// From an existing LUT object (e.g. from transform.getLut())
const builder = new LutBuilder(lut);

// From serialised JSON (reverses .toJSON())
// Accepts a JSON string OR an already-parsed object:
const builder = LutBuilder.fromJSON(jsonString);
const builder = LutBuilder.fromJSON(parsedObject);
// Internally: typeof input === 'string' ? JSON.parse(input) : input

// From an existing Transform
const builder = LutBuilder.fromTransform(existingTransform);
// Two paths:
//   - Transform has a LUT (buildLut: true was used) → copies the existing LUT
//   - Transform has no LUT → builds one, grid size modes apply (see below)
```

#### Creation methods

All creation methods replace any existing LUT in the builder
(the builder holds one LUT at a time). They all return `this`
for chaining.

**`builder.create(options, callback)`** — fully synthetic LUT.
Loops over every grid cell (1D / 2D / 3D / 4D based on
`inChannels`), calls the callback for each cell, quantises the
returned [0..1] values to u16 (`round(v * 65535)`), and stores
in the canonical Uint16Array (see §2.4).

```js
builder.create({
    inChannels: 3,
    outChannels: 4,
    size: 33,                // number — explicit grid points per axis
    chain: [input, eIntent.perceptual, output],  // optional — auto-generated from channels if omitted
}, (normalised, cell) => myRgbToCmyk(normalised[0], normalised[1], normalised[2]));
```

#### Callback signature

```
callback(normalised, cell) → outputValues
```

| Argument | Type | Description |
|---|---|---|
| `normalised` | `number[]` | Input coordinates, [0..1] per channel. Length = `inChannels`. |
| `cell.indices` | `number[]` | Raw grid indices, integers [0..`size-1`]. Length = `inChannels`. |
| `cell.size` | `number` | Grid points per axis (same as `options.size`). |
| `cell.sizeMax` | `number` | `size - 1` — convenience for `index / sizeMax` normalisation. |
| **return** | `number[]` | Output values, normalised [0..1]. Length = `outChannels`. |

The `normalised` values are pre-computed as
`cell.indices[i] / cell.sizeMax` — they are the canonical
representation and what most callbacks should use. The `cell`
object is there for callbacks that want raw grid positions (e.g.
table-driven lookups, lcms-style u16 math where the callback
computes `Math.round(normalised[i] * 65535)` internally).

**Return values are always [0..1].** The builder quantises them
to u16 immediately (`round(v * 65535)`) and stores in the canonical
Uint16Array (§2.4). At `toTransform()` time, the u16 data is
expanded to f64 for the float CLUT and encoded into the
mode-specific intLut by `buildIntLut()`. The callback never needs
to know about internal LUT scales — see
[§6.2b](#62b-why-u16-internal-storage-is-lossless) for the
precision proof that the u16 quantisation is lossless for all
downstream paths.

#### Why the f64 CLUT is universal — intLut is not

The f64 CLUT stores [0..1] floats — encoding-agnostic,
bit-depth-agnostic. It is the single source of truth for the LUT's
colour data.

The `intLut` (Uint16Array mirror used by the integer kernels) is
**not** universal. It is built for a specific output bit depth and
has a different encoding for each:

| | u8 intLut (`dataFormat: 'int8'`) | u16 intLut (`dataFormat: 'int16'`) |
|---|---|---|
| CLUT scale | 65280 (= 255 × 256) | 65535 (full range) |
| Weight precision | Q0.16 (u8 fractional weight) | Q0.13 (u13 fractional weight) |
| Grid-points scale | `((g1-1) << 16) / 255` | `((g1-1) << 13) / 65535` |
| Kernel rounding | `(v + 0x80) >> 8` → u8 | `(v + 0x1000) >> 13` → u16 |

A u8-scaled intLut cannot be used for u16 output — the 65280
scale caps precision at u8-equivalent and produces visible banding
(this was the v1.3 identity error, see `bench/int16_identity.js`).
A u16-scaled intLut cannot be used for u8 output — the `>> 8`
rounding path expects the 65280 scale and would produce a +0.4%
high bias (up to 75% of channels off-by-1 on CMYK→RGB profiles).

**This is why `toTransform()` takes `dataFormat` — it determines
which intLut encoding gets built.** The builder stores only the
f64 CLUT. The intLut is a derived artefact, created at
`toTransform()` time from the universal f64 data. The same builder
can produce transforms for different output bit depths:

```js
const builder = new LutBuilder()
    .create({ inChannels: 3, outChannels: 3, size: 33 }, myCallback);

// Same f64 CLUT → two different intLut encodings
const xform8  = builder.toTransform({ dataFormat: 'int8' });   // scale 65280, Q0.16
const xform16 = builder.toTransform({ dataFormat: 'int16' });  // scale 65535, Q0.13
```

The callback never participates in this decision. It returned
[0..1] floats once; `buildIntLut()` derives each encoding from
those floats as needed.

#### Rounding precision — why ±1 LSB in the CLUT doesn't matter

A natural concern with u16 internal storage: when the u8 intLut
is derived from the u16 canonical data via rescaling
(`v * 65280 / 65535`), the result can differ by ±1 LSB from what
you'd get scaling directly from f64. Does this matter?

**No — at either bit depth, the kernel's own quantisation is the
precision floor, not the CLUT storage.**

**u8 path — lower 8 bits are discarded.** The kernel's final step
is `(v + 0x80) >> 8`, which divides by 256 and rounds. Any error
below 128 in the u16-scaled accumulator is absorbed by the
rounding constant. A ±1 LSB error in the 65280-scaled CLUT value
is 1 part in 65280 — it literally cannot change the u8 output.
The entire lower byte is quantisation noise that gets thrown away.

**u16 path — Q0.13 interpolation loses 3 bits.** The kernel uses
13-bit fractional weights (`>> 13` quantisation). The CLUT corner
value `c` enters the accumulator at full u16 precision, but the
interpolated delta contribution (`delta × weight >> 13`) has only
13 bits of precision — 3 bits below u16. This means the u16
output already has ~3 bits of quantisation noise from the
interpolation math itself. A ±1 LSB error in the CLUT (1 part in
65535) is well below this noise floor.

**In practical terms:** the u16 integer kernel matches the float
kernel to within ~1–2 LSB across the full u16 range on real-world
ICC profiles (measured in `bench/int16_identity.js` and
`diag_cmyk_to_rgb.js`). The Q0.13 design was chosen as the best
i32-safe precision — Q0.14 overflows on adversarial CLUTs, Q0.12
doubles the quantisation noise for no safety gain. At Q0.13 the
kernel is near-perfect for practical use: the ~3-bit interpolation
noise is invisible in any real colour workflow (it's ~0.002 ΔE76,
well below visual threshold).

**Float kernel with u16 storage — never below true u16.** A
natural concern: does storing the CLUT as u16 internally degrade
the float kernel? The quantisation noise from u16 (1/65535 ≈
0.0015% per channel) translates to ~0.004 ΔE76 worst case —
orders of magnitude below visual threshold (~1.0 ΔE76) and well
below the grid interpolation error (~0.06 ΔE76 at 33 points).
The float kernel's interpolation math is f64-exact; only the CLUT
*input* values carry u16 quantisation. The result is always more
precise than the u16 integer kernel (which adds ~3 bits of Q0.13
noise on top of the same CLUT data). The precision hierarchy:

```
  float kernel from f64 CLUT:   exact interpolation, exact CLUT
  float kernel from u16 CLUT:   exact interpolation, ±0.004 ΔE   ← u16 storage
  u16 integer kernel:           Q0.13 interpolation, ±0.002 ΔE   ← 3 bits lost
  u8 integer kernel:            Q0.16 interpolation, >> 8 output  ← 8 bits lost
                                    ▲
                         all below visual threshold
```

The takeaway: **LUTs are for speed, not for exceeding float
precision.** The integer kernels deliver 1.6–6× throughput over
the float kernel. The price is ~3 bits of interpolation noise on
the u16 path (invisible) and 8 bits on the u8 path (by design).
u16 internal storage adds negligible noise to the float path
(~0.004 ΔE) and zero measurable impact to the integer paths.
Worrying about ±1 LSB in CLUT rescaling is looking at noise below
the noise floor.

The `size` option is always a number for `create()` — grid size
modes (`'auto'`, `'high'`, `'low'`) are only meaningful on
`fromTransform()` where real profiles are available to inspect
(see below).

**`builder.createIdentity(channels, size)`** — identity LUT where
output equals input. Always `inChannels === outChannels`. The
"blank canvas" for TIFF workflows.

```js
builder.createIdentity(3, 33);   // 3D identity: (r,g,b) → (r,g,b), 33 grid points
builder.createIdentity(4, 17);   // 4D identity: (c,m,y,k) → (c,m,y,k), 17 grid points
builder.createIdentity(1, 256);  // 1D identity: (gray) → (gray), 256 grid points
```

**`builder.createFromLCMS(lcms, xformId, options)`** — Tier 3
lcms-wasm bridge. Wraps an already-initialised lcms transform.
Internally calls `lcms.doTransformU16()` at each grid point and
stores the u16 output directly in the canonical Uint16Array
(§2.4) — no normalisation step, no precision loss.

```js
const lcms = await initLcmsWasm();
const xform = lcms.createTransformU16(src, TYPE_RGB_16, dst, TYPE_CMYK_16, INTENT_PERCEPTUAL, 0);

builder.createFromLCMS(lcms, xform, {
    inChannels: 3, outChannels: 4, size: 33
});
// builder now holds an lcms-accurate LUT
```

**Performance and async.** The bridge calls `lcms.doTransformU16()` once per grid point — 35,937 calls for a 33-point 3D LUT, ~1.2M for a 33-point 4D LUT. At jsCE's throughput (see [Performance.md](../Performance.md)), this is fast in absolute terms, and LUTs are built once and serialised — not rebuilt per request. For 4D LUTs where the fill loop is non-trivial, the caller can offload to a Worker. No async variant is planned because the build-time use case is the norm; if runtime build is needed in a UI context, a Worker is the right tool.

#### `fromTransform()` and grid size modes

`LutBuilder.fromTransform(transform, options)` has two behaviours
depending on whether the Transform already has a built LUT:

**Transform has a LUT** (`buildLut: true` was used) — extracts the
LUT data into the builder's canonical u16 Uint16Array (§2.4). The
`options` parameter is ignored because the LUT is already built at
whatever grid size the Transform used. This is the common path for
§8.2 (extract → redistribute).

The extraction reads the Transform's canonical f64 CLUT
(`transform.lut.CLUT`, values in [0..1]) and quantises to u16
[0..65535]. **It never reads `intLut`.**

> **Rule of thumb — LUTs are full-scale at the boundary.**
> The `intLut` (with its 65280 scale and Q0.16/Q0.13 weight encoding)
> is a WASM-kernel artifact, internal to Transform. LUTs that cross
> any API boundary (extract, serialise, share) are full-scale for
> their type:
>
> - `Float64Array` → values in `[0..1]`     — engine canonical (`getLut()`)
> - `Uint16Array`  → values in `[0..65535]` — `getLut16()`
> - `Uint8Array`   → values in `[0..255]`   — `getLut8()`
>
> LutBuilder accepts any of these on import (auto-detected by typed
> array type) and stores u16 internally. Only the Transform cares
> about kernel-specific scaling.

**Transform has no LUT** — the builder triggers a LUT build from
the Transform's pipeline. This is where grid size modes (§3b)
apply, because the Transform holds full profile objects with
inspectable A2B/B2A tables:

```js
// Transform was created without buildLut — builder builds it
const transform = new Transform({ dataFormat: 'int16' })
    .create(srgbProfile, cmykProfile, eIntent.perceptual);

// 'auto' inspects the output profile's B2A grid size
const builder = LutBuilder.fromTransform(transform, { gridSize: 'auto' });

// 'low' picks the smallest LUT grid size in the chain
const builder = LutBuilder.fromTransform(transform, { gridSize: 'low' });

// Explicit number works too
const builder = LutBuilder.fromTransform(transform, { gridSize: 33 });
```

Grid size modes are **only** available on `fromTransform()` —
the only context where real profiles exist to inspect. For
`create()` (callback) and `createFromLCMS()`, `size` is always
a number because there are no profiles to query.

#### Clone

**`builder.clone()`** — returns a new LutBuilder with a deep copy
of the LUT data, chain, and metadata. Useful for creating variants
from a common base:

```js
const base = LutBuilder.fromTransform(transform);

const standard = base.clone()
    .addAdjustment('Standard — no modifications')
    .toJSON();

const tacLimited = base.clone()
    .editLut((output) => { /* TAC clamp */ return output; })
    .addAdjustment('TAC limited to 300%')
    .toJSON();
```

#### Mutation

**`builder.editLut(callback)`** — iterate every cell in the LUT,
callback receives the current output values and the grid-cell
context, returns mutated output values. This is the programmatic
equivalent of editing the TIFF in Photoshop.

```js
builder.editLut((output, cell) => {
    // boost saturation: scale chroma, leave lightness alone
    output[1] *= 1.2;  // green channel
    output[2] *= 0.9;  // blue channel
    return output;
});
```

The callback shape is `(outputValues, cell) => outputValues`.
`outputValues` is an array of length `outChannels`, normalised
[0..1] (expanded from the internal u16 via `v / 65535`). `cell`
has the same shape as in `create()`: `{ indices, size, sizeMax }`
plus `cell.normalised` (the input coordinates for this grid
point, [0..1]). Returns are quantised back to u16 and stored.
Returns `this` for chaining.

LutBuilder holds only the canonical u16 storage — no `intLut` is
cached on the builder. The Transform's kernel-specific intLut is
built fresh inside the Transform every time `toTransform()` runs,
so `editLut()` is just a u16 in-place edit with no invalidation
bookkeeping needed.

#### Metadata

```js
builder.addMeta({ author: 'Glenn', tags: ['prepress', 'offset'] });
builder.addCopyright('CC-BY-4.0');
builder.addAdjustment('Saturation +20%, Curves: lift shadows R+5');
builder.setChain([input, eIntent.perceptual, output]);
```

- **`addMeta(obj)`** — merge key/value pairs into
  `lut.meta`. Additive — call multiple times to accumulate.
- **`addCopyright(string)`** — sets `lut.meta.copyright`.
- **`addAdjustment(string)`** — appends to
  `lut.meta.adjustments[]`. Documents post-build edits — each call
  adds an entry so the history is preserved.
- **`setChain(chain)`** — sets or overrides `lut.chain`. Accepts
  the standard `[descriptor, intent, descriptor, ...]` format.
  Also accepts full Profile objects — these are converted to
  lightweight descriptors via `profile2Obj()` immediately, so the
  builder never holds references to full profile internals.

#### Output

**`builder.toTransform(options)`** — returns a ready-to-use
Transform with the LUT loaded via `setLut()`. Handles `lutMode`
wiring so the result dispatches to WASM-SIMD if available.

```js
const transform = builder.toTransform({ lutMode: 'auto', dataFormat: 'int16' });
transform.transformArray(pixels);
```

**`builder.toJSON(options)`** — serialise to the portable JSON
format (§5). Base64-encodes the CLUT, stamps metadata, includes
the chain. The inverse of `LutBuilder.fromJSON()`.

If the chain contains full Profile objects (e.g. when the builder
was loaded from a Transform that used real ICC profiles),
`toJSON()` runs them through `profile2Obj()` automatically —
stripping them down to the lightweight descriptor shape (`header`,
`name`, `type`, `version`, `whitePoint`, etc.). The serialised
JSON never contains full profile data, just the routing and
provenance metadata.

```js
const json = builder.toJSON({ source: 'jsColorEngine 1.4' });
fs.writeFileSync('lut.json', JSON.stringify(json));
```

**`builder.toLut()`** — returns the raw LUT object (same shape as
`transform.getLut()`). For callers who want to call
`transform.setLut()` manually.

**`builder.exportTIFF(options)`** — Stage 3 (§4). Export the LUT
as a TIFF image for visual editing.

**`builder.importTIFF(buffer)`** — Stage 3 (§4). Import an edited
TIFF back into the builder. The TIFF's channel count determines
the LUT's `outputChannels` — it does **not** need to match the
original export. This is how channel-count conversions work:
export a 3-channel RGB identity, convert to CMYK in Photoshop,
import the 4-channel TIFF — the builder detects the channel
change from the TIFF header and updates `outputChannels`
accordingly. The `inputChannels` (grid dimensions) stay the same
— the grid is the same size, only the values stored at each grid
point change.

#### Analyze

> **Status: design sketch — not fully specified.** The concept is
> sound but the report shape and pass/fail criteria need work
> during implementation.

**`builder.analyze(sourcePixels, expectedPixels, options)`** —
accuracy analysis. Takes source pixel data, transforms it through
the builder's LUT, and compares the result against expected output
pixel-by-pixel. Returns a report object.

The name is `analyze` rather than `verify` because the tool is
broader than pass/fail checking — it's a general-purpose
comparison that answers "how different are these two results?"
across multiple metrics.

The operation is simple: run `sourcePixels` through the LUT,
diff the result against `expectedPixels`, report statistics.
What makes it powerful is the range of things you can compare:

**1. TIFF round-trip validation (§4).** Source is the identity
TIFF, expected is the Photoshop-edited TIFF. Confirms the LUT
faithfully captures the edit at grid resolution.

**2. Cross-CMS comparison.** Convert an RGB photo to CMYK via
jsCE (using the builder's LUT), then convert the same photo in
Photoshop via Adobe CMM. Feed both results into analyze — the
report tells you how well jsCE matches Adobe's conversion for
*real image content*, not just grid points.

```js
// jsCE built LUT: sRGB → SWOP CMYK
const builder = LutBuilder.fromTransform(jsceTransform);

// expectedPixels = same photo converted in Photoshop (Adobe CMM)
const report = builder.analyze(rgbPhoto, adobeCmykOutput, {
    threshold: 1.0,
});
// report.meanDeltaE tells you how close jsCE is to Adobe on this image
```

**3. Grid size quality sweep.** Build a high-resolution reference
LUT (e.g. 65-point), transform a test image through it, then
build lower-resolution LUTs and analyze each against the reference
output. Finds the minimum grid size that meets your accuracy
target — the manual version of the future `'test'` mode (§3b).

```js
const ref = LutBuilder.fromTransform(transform, { gridSize: 65 });
const refOutput = ref.toTransform({ dataFormat: 'int16' }).transformArray(testImage);

for (const size of [33, 17, 9]) {
    const candidate = LutBuilder.fromTransform(transform, { gridSize: size });
    const report = candidate.analyze(testImage, refOutput);
    console.log(`${size}-point: maxΔP ${report.maxDeltaP.toFixed(1)}, meanΔP ${report.meanDeltaP.toFixed(2)}`);
}
```

**4. Photo-based validation.** Take a real photo through the
same processing steps in two different tools (e.g. jsCE LUT vs
Photoshop Action) and compare — analyze works on any pixel data,
not just LUT grids or TIFFs.

**Metrics — ΔE and ΔP.** The report includes two families of
difference metrics:

- **ΔE** (delta-E) — perceptual colour difference in Lab space.
  CIE76 by default, optionally CIE2000 or CMC. Requires a
  conversion to Lab, which the builder can do if the LUT's output
  colour space is known. The standard metric for colour accuracy.
- **ΔP** (delta-pixel) — per-channel Euclidean distance directly
  on the output values in **8-bit scale (0–255)**:
  `√((a₀-b₀)² + (a₁-b₁)² + ... )` where all values are mapped
  to the 0–255 range before differencing (u16 values are divided
  by 256, f64 [0–1] values are multiplied by 255). No Lab
  conversion needed. Fast, works on any channel count (CMYK,
  greyscale, N-channel), and eliminates confusion with
  Lab-based ΔE.

  The 8-bit scale gives ΔP intuitive meaning regardless of the
  pipeline's internal precision: **ΔP < 1.0 means the two
  results are indistinguishable at 8-bit output** — the
  difference is sub-LSB, invisible in any practical display or
  print workflow. ΔP = 1.0 is exactly 1 code value apart on one
  channel. ΔP = 3.0 is a visible difference on a calibrated
  monitor. This is more linear and more directly actionable than
  ΔE for device-space comparisons, because RGB and CMYK are not
  perceptually uniform — a ΔE of 1.0 in Lab has a specific
  visual meaning, but the corresponding device-space difference
  varies wildly depending on where in the gamut you are. ΔP
  sidesteps that entirely: it tells you how many code values
  apart the pixels are, full stop.

```js
const report = builder.analyze(sourcePixels, expectedPixels, {
    threshold:    1.0,       // max acceptable mean ΔP for pass/fail (default 1.0)
    returnDelta:  true,      // attach delta pixel arrays to the report
    deltaAmplify: 10,        // amplify delta values for visualisation
});
// See samples/lutbuilder.md API reference for the full report shape.
```

> **ΔE metrics — not implemented (deferred, no current need).** The original spec
> planned Lab-based ΔE76/ΔE2000/CMC metrics alongside ΔP. In practice, **ΔP is
> sufficient for LUT validation**: it tells you exactly how many output code values
> differ between the LUT prediction and the ground truth, which is directly
> actionable regardless of colour space. ΔE adds a Lab round-trip (profile-dependent,
> slower) and answers a slightly different question (perceptual uniformity) that
> matters more for display profiling than for device-link accuracy. If a future use
> case requires ΔE, the `comparePixels` function can be extended with a
> `deltaEFn` option — the engine's `convert.deltaE76` helpers are available. Until
> then, ΔP alone ships and covers the validated workflow.

### 7.4 Why no separate serialiser

The earlier design (§5) proposed standalone `serializeLut()` /
`deserializeLut()` helpers. These are now folded into the builder:

| Old API | New API |
|---|---|
| `serializeLut(lut, options)` | `builder.toJSON(options)` |
| `deserializeLut(json)` | `LutBuilder.fromJSON(json)` |
| `transform.getLut()` → manual `setLut()` | `LutBuilder.fromTransform(t)` → `builder.toTransform()` |

The serialisation format (§5) is unchanged — `toJSON()` produces
the same JSON shape. The change is organisational: serialisation
lives on the builder, not as free functions. This means every LUT
operation — create, load, mutate, annotate, serialise, export —
goes through one object with discoverable methods.

`setLut()` on the engine still works directly for callers who want
to bypass the builder. The builder is the recommended path, not the
only path.

---

## 8. Workflows

Five concrete patterns that cover every way a LUT enters and
leaves the builder. Each shows the full API call sequence.

### 8.1 Fully synthetic LUT (callback)

No profiles, no engine — just a colour function sampled onto a
grid. The purest Tier 2 path.

```js
// Fluent — create, annotate, use in one chain
const transform = new LutBuilder()
    .create({ inChannels: 3, outChannels: 3, size: 33 }, ([r, g, b]) => {
        return [r * 1.05, g * 0.95, b * 0.85];  // vintage warmth
    })
    .setChain([virtualRGB('sRGB input'), eIntent.perceptual, virtualRGB('Warm filter output')])
    .addMeta({ author: 'Glenn', tags: ['creative', 'warmth'] })
    .addCopyright('CC-BY-4.0')
    .addAdjustment('Vintage warmth: R+5% G-5% B-15%')
    .toTransform({ dataFormat: 'int16' });

transform.transformArray(pixels);

// Or save instead of using immediately
const json = new LutBuilder()
    .create({ inChannels: 3, outChannels: 3, size: 33 }, warmthCallback)
    .addMeta({ author: 'Glenn' })
    .toJSON();
fs.writeFileSync('warmth.json', JSON.stringify(json));
```

Using grid-cell context for a lookup-table-driven callback:

```js
const transform = new LutBuilder()
    .create({ inChannels: 4, outChannels: 3, size: 17 },
        (normalised, cell) => {
            // cell.indices = [c, m, y, k] as integers 0..16
            // cell.sizeMax = 16
            // normalised = [c/16, m/16, y/16, k/16] as 0..1
            return cmykToRgb(normalised[0], normalised[1],
                             normalised[2], normalised[3]);
        })
    .toTransform({ dataFormat: 'int16' });
// buildIntLut() encodes f64 CLUT → u16 at toTransform() time
```

### 8.2 Loaded from Transform → redistribute

Extract a LUT from an existing jsCE transform, annotate it,
ship it as a static asset. Zero-profile runtime.

```js
// Build time — full engine pipeline
const transform = new Transform({ buildLut: true, dataFormat: 'int16' })
    .create(srgbProfile, gracolProfile, eIntent.perceptual);

// Extract into builder
const builder = LutBuilder.fromTransform(transform);
builder.addMeta({ pressCondition: 'GRACoL2006 Coated #1' });
builder.addCopyright('Internal use only');

const json = builder.toJSON({ source: 'jsColorEngine 1.4' });
fs.writeFileSync('srgb_to_gracol_perceptual.json', JSON.stringify(json));

// Runtime — no profiles, no pipeline build, no lcms
const builder2 = LutBuilder.fromJSON(fs.readFileSync('srgb_to_gracol_perceptual.json'));
const transform2 = builder2.toTransform({ dataFormat: 'int16' });
transform2.transformArray(pixels);
// Startup: ~5 ms (JSON parse + setLut) vs ~50 ms (profile + pipeline + LUT)
```

### 8.3 lcms bridge → bake and discard

Capture lcms colour math, then drop the lcms runtime dependency.

```js
const lcms = await initLcmsWasm();
const src = lcms.openProfileFromMem(srgbBytes);
const dst = lcms.openProfileFromMem(gracolBytes);
const xform = lcms.createTransformU16(src, TYPE_RGB_16, dst, TYPE_CMYK_16, INTENT_PERCEPTUAL, 0);

const builder = new LutBuilder();
builder.createFromLCMS(lcms, xform, {
    inChannels: 3, outChannels: 4, size: 33
});

// lcms is done — dispose it
lcms.closeTransform(xform);
lcms.closeProfile(src);
lcms.closeProfile(dst);

// Transform runs at full WASM-SIMD speed, lcms-accurate data
const transform = builder.toTransform({ dataFormat: 'int16' });
transform.transformArray(pixels);

// Or serialize — drop lcms-wasm from the runtime bundle entirely
const json = builder.toJSON({ source: 'lcms-wasm 2.16 + jsColorEngine 1.4' });
```

**Hybrid try/catch** — fall back to lcms for exotic profiles:

```js
let transform;
try {
    transform = new Transform({ buildLut: true, dataFormat: 'int16' })
        .create(srcProfile, dstProfile, intent);
} catch (e) {
    const xform = lcms.createTransformU16(src, TYPE_RGB_16, dst, TYPE_CMYK_16, intent, 0);
    const builder = new LutBuilder();
    builder.createFromLCMS(lcms, xform, { inChannels: 3, outChannels: 4, size: 33 });
    transform = builder.toTransform({ dataFormat: 'int16' });
}
// Either path: same API, same speed
transform.transformArray(pixels);
```

### 8.4 Load → mutate → save

Load an existing LUT (from a Transform, from JSON, or from a
previous builder), apply programmatic edits, save the result.

```js
const json = LutBuilder.fromJSON(fs.readFileSync('base_lut.json'))
    .editLut((output, cell) => {
        // TAC limit: clamp total ink to 300%
        const total = output[0] + output[1] + output[2] + output[3];
        if (total > 3.0) {
            const scale = 3.0 / total;
            output[0] *= scale;
            output[1] *= scale;
            output[2] *= scale;
            output[3] *= scale;
        }
        return output;
    })
    .addAdjustment('TAC limit: total ink clamped to 300%')
    .toJSON();

fs.writeFileSync('tac_limited.json', JSON.stringify(json));
```

Creating variants from a common base with `clone()`:

```js
const base = LutBuilder.fromJSON(fs.readFileSync('base_lut.json'));

const tac300 = base.clone()
    .editLut(tacLimit(3.0))
    .addAdjustment('TAC 300%')
    .toJSON();

const tac280 = base.clone()
    .editLut(tacLimit(2.8))
    .addAdjustment('TAC 280%')
    .toJSON();
```

### 8.5 TIFF round-trip (Stage 3)

Visual LUT editing via any colour-managed editor. See §4 for the
full rationale.

```js
// Create identity and export
const builder = new LutBuilder()
    .createIdentity(3, 33);

const tiff = builder.exportTIFF({ bitDepth: 16, preview: referenceImages });
fs.writeFileSync('identity_rgb.tiff', tiff);

// ... user opens in Photoshop, applies adjustments, saves ...

// Import edited TIFF → the edits are now baked into the LUT
const json = builder
    .importTIFF(fs.readFileSync('edited_rgb.tiff'))
    .addAdjustment('Photoshop: Convert to GRACoL2006, Perceptual')
    .toJSON();

// Or get a live transform
const transform = builder.toTransform({ dataFormat: 'int16' });
```

### 8.6 Pre-baked LUT library

A prepress vendor maintains 50+ paper stock profiles. Build all
LUTs once, serialize with rich metadata. End users browse and
select LUTs via a custom UI — no ICC profiles reach the client.

```js
for (const stock of paperStocks) {
    const transform = new Transform({ buildLut: true, dataFormat: 'int16' })
        .create(srgbProfile, stock.profile, eIntent.perceptual);

    const builder = LutBuilder.fromTransform(transform);
    builder.addMeta({
        paperName: stock.name,
        inkSet: stock.inkSet,
        pressType: stock.pressType,
        certification: stock.cert,
    });
    builder.addCopyright(stock.license);

    fs.writeFileSync(
        `luts/${stock.slug}.json`,
        JSON.stringify(builder.toJSON())
    );
}
```

### Workflow summary

```
  ┌──────────────────────────────────────────────────────────────┐
  │                     Entry points                              │
  │                                                              │
  │   new LutBuilder()          — empty, then .create()          │
  │   new LutBuilder(lut)       — from getLut() object           │
  │   LutBuilder.fromJSON(json) — from serialised file           │
  │   LutBuilder.fromTransform(t) — from existing Transform      │
  └──────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                    Build / Load                               │
  │                                                              │
  │   .create(opts, callback)    — synthetic (u16 canonical)      │
  │   .createIdentity(ch, size)  — blank canvas for TIFF         │
  │   .createFromLCMS(lcms, ...) — lcms-wasm bridge              │
  │   .importTIFF(buffer)        — from edited TIFF (Stage 3)    │
  └──────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                    Mutate / Annotate                           │
  │                                                              │
  │   .editLut(callback)         — programmatic per-cell edits   │
  │   .clone()                   — deep copy for variants        │
  │   .addMeta({...})            — merge metadata                │
  │   .addCopyright(str)         — set copyright                 │
  │   .addAdjustment(str)        — append to edit history        │
  │   .setChain([...])           — set/override profile chain    │
  └──────────────────────┬───────────────────────────────────────┘
                         │
                         ▼
  ┌──────────────────────────────────────────────────────────────┐
  │                    Output                                     │
  │                                                              │
  │   .toTransform(opts)         — ready-to-use Transform        │
  │   .toJSON(opts)              — portable JSON (§5 format)     │
  │   .toLut()                   — raw LUT object                │
  │   .exportTIFF(opts)          — TIFF for visual editing       │
  │   .analyze(src, expected)    — accuracy report               │
  └──────────────────────────────────────────────────────────────┘

  All methods except output return `this` — fluent chaining throughout.
  Errors throw immediately with clear messages.
```

---

## 9. Open questions

These are genuine design decisions that need to be resolved during
implementation. They're listed here as discussion starters, not
blockers.

| # | Question | Notes |
|---|---|---|
| 1 | ✅ **TIFF codec — resolved.** `utif` (MIT, pure JS, pako bundled) handles decode; the exporter writes raw TIFF bytes directly for full control over custom tags. Zero new peer dependencies beyond `utif` (already in `package.json`). | |
| 2 | **TIFF-as-transport vs JSON+b64.** Should the LUT's native portable format be TIFF (pixel data = LUT, custom tags = metadata, built-in lossless compression) or JSON+b64 (human-editable metadata, but no built-in compression)? Or support both? | Both have merits. JSON is better for web APIs and programmatic inspection. TIFF is better for file exchange, Photoshop workflow integration, and compression. Supporting both (serialize to either) may be the pragmatic answer. |
| 3 | ✅ **Custom TIFF tag preservation — resolved.** Photoshop strips tag 32768 on save. XMP (tag 700) with a custom `jsce:` namespace survives Photoshop round-trips. Both are written on export; XMP is checked first on import. See §4.1 for the three-layer design. | |
| 4 | ✅ **4D TIFF layout — resolved.** numSlices = N² (one per combination of two outermost axes), slicesPerRow = ceil(sqrt(N²)) = N (exact), giving a perfect N²×N² square for any N. At N=17: 289×289 = exactly 17⁴ cells. | |
| 5 | **Should 5+ input channels be supported?** The current design caps at 4. N-channel inputs (5–8ch device profiles) are rare but exist (Hexachrome, RISO MZ770). Grid explosion is the concern: 17⁵ = 1.4M cells, 17⁶ = 24M. | Defer to v2. The callback API supports it; the TIFF workflow doesn't have a natural visual representation beyond 4D. |
| 6 | **Grid size guidance for creative effects.** A 33-point grid samples colour space at 33 steps per axis. Smooth ICC transforms interpolate well at this resolution (~0.06 ΔE worst case). But steep creative effects (hard thresholds, posterisation, per-hue selective colour with sharp boundaries) will be visibly smoothed by the grid. The grid size modes (§3b) solve the ICC case — `'auto'`/`'high'`/`'low'` inspect profile LUT tables to pick appropriate resolution. But for Tier 2 callbacks with steep gradients, the modes don't help because there's no profile to inspect. The future `'test'` mode (§3b) would address this by empirically measuring interpolation error across grid sizes. | Documentation should recommend 49 or 65-point grids for effects with steep gradients. The `'test'` mode (§3b, future) could auto-discover the optimal size for any callback by building multiple candidate LUTs and measuring interpolation error against a high-resolution reference. |
| 7 | ✅ **CLI tool — shipped.** `samples/lut-tiff-cli.js` provides `--create`, `--import`, `--validate`, `--compare`, `--apply`, `--make-samples` modes. See `samples/lutbuilder.md` CLI quick reference. | |
| 8 | **LUT composition.** Should the Builder support chaining two LUTs (A→B, B→C → A→C by re-sampling through both)? This is a natural operation but adds complexity — grid resolution compounds, and the inner LUT needs interpolation during the outer LUT's build pass. | Useful but not v1. The callback API already supports this manually (`builder.create()` where the callback calls `transform.transform()` on a previously built LUT). |
| 9 | **Identity LUT optimisation.** An identity RGB LUT at 33³ is 35,937 cells of `(r,g,b) = input`. Should the Builder detect identity and skip the grid fill? Or is the explicit grid useful (e.g. for TIFF export where you want to see the identity gradient)? | Always fill the grid. The identity gradient is the TIFF export's whole point — it's the "blank canvas" that the user edits. |
| 10 | **Versioning the LUT format.** The serialisation format is versioned (`_version: 2`). What's the compatibility contract? Can a v3 engine read a v2 LUT? Must it? | Forward-compatible reads, backward-compatible writes. A v3 engine MUST be able to read v2 LUTs. A v2 LUT written by a v3 engine must be readable by any v2-capable engine (new fields are additive, never removing existing ones). |
| 11 | **Web companion tool.** A simple webpage that generates identity TIFFs (with preview region and custom tags) for download, and accepts edited TIFFs for upload → validation → LUT conversion. Removes the "what do I do with this file?" friction from the TIFF workflow. | Natural first deliverable after the core Builder ships. Could be a sample page in `samples/` alongside the existing demos. |
| 12 | **`setLut()` pipeline bootstrap strategy (§8b).** Four options: (1) require real profiles — rejected, defeats zero-profile goal; (2) full pseudo-profiles — rejected, too much surface area; (3) short-circuit `setLut()` to build the pipeline directly — viable but loses the chain metadata; (4) lightweight descriptors matching `profile2Obj()` shape, stamped at LUT build time with the full chain — chosen approach, zero engine changes, provenance metadata for free. | Start with option 4 (ships with Stage 1, zero engine changes). Option 3 remains a fallback if the descriptor approach proves fragile — could be offered as `createPipelineFromLut()` that bypasses chain validation entirely, deriving encoding from `lut.inputChannels`/`lut.outputChannels`. |

---

## 10. Release plan

Three stages, each independently shippable and useful on its own.

### ✅ Stage 1 — LutBuilder core + lcms bridge (shipped v1.4.x)

**What ships:** The `LutBuilder` class with `create()`,
`createFromLCMS()`, `createIdentity()`, `LutBuilder.fromTransform()`,
`editLut()`, `clone()`, `toLut()`, `toTransform()`. The `virtualProfile()`
helpers. Grid size modes (§3b). No serialisation, no TIFF.

**Why this is a no-brainer.** All the pieces are already in place:
the concept code is written, `Transform.setLut()` is a stable
contract, lcms-wasm is a published npm package. The work is
integration + tests + docs, not design.

**What it unlocks immediately:**

- **Hybrid mode** — bit-exact lcms compatibility at jsCE WASM-SIMD
  speed. Build the LUT once from lcms, dispose lcms, run at full
  speed forever after.
- **Fallback mode** — `try/catch` around jsCE's `create()`, fall
  back to lcms-built LUT for exotic profiles that jsCE can't parse.
- **Custom LUTs** — any user-supplied colour function sampled onto
  a grid and running through the engine's fast path.
- **LUT mutation** — `editLut()` for programmatic post-processing
  (TAC limits, saturation tweaks, ink substitution).

**Example — hybrid try/catch:**

```js
let transform;
try {
    transform = new Transform({ dataFormat: 'int16', buildLut: true })
        .create(srcProfile, dstProfile, intent);
} catch (e) {
    const xform = lcms.createTransformU16(
        src, TYPE_RGB_16, dst, TYPE_CMYK_16, intent, 0
    );
    const builder = new LutBuilder();
    builder.createFromLCMS(lcms, xform, {
        inChannels: 3, outChannels: 4, size: 33
    });
    transform = builder.toTransform({ dataFormat: 'int16' });
}
// Either path: same API, same WASM-SIMD speed
transform.transformArray(pixels);
```

**Example — bake once, dispose lcms:**

```js
const xform = lcms.createTransformU16(src, TYPE_RGB_16, dst, TYPE_CMYK_16, intent, 0);
const builder = new LutBuilder();
builder.createFromLCMS(lcms, xform, { inChannels: 3, outChannels: 4, size: 33 });
const transform = builder.toTransform({ dataFormat: 'int16' });

// lcms is no longer needed — transform is self-contained
lcms.closeTransform(xform);
lcms.closeProfile(src);
lcms.closeProfile(dst);
// lcms-wasm can be GC'd
```

**Jest test strategy:** Build the same transform via both paths
(jsCE native int16 and lcms-wasm bridge int16), run a reference
image through both, compare output pixel-by-pixel. This validates:
(a) the Builder produces valid LUT objects, (b) the engine
accepts and dispatches them correctly through all kernel tiers,
(c) the lcms bridge captures lcms's output faithfully at grid
resolution. The 16-bit vs 16-bit comparison is the meaningful
accuracy gate — both sides are u16 native, no bit-depth mismatch.

### ✅ Stage 2 — Serialisation + metadata (shipped v1.4.3)

**What ships:** `toJSON()`, `LutBuilder.fromJSON()`,
`LutBuilder.fromTransform()`, metadata methods (`addMeta()`,
`addCopyright()`, `addAdjustment()`, `setChain()`). The format
described in §5 — the existing LUT object shape with
base64-encoded CLUT plus metadata fields. Compatibility tags,
stride regeneration on deserialise.

**What it unlocks:** Redistributable LUTs. Pre-bake at build time,
ship as static JSON, load at runtime with zero profiles and zero
lcms. The "minimal colour picker" and "pre-baked LUT library"
workflows from §8.

**Depends on Stage 1** — serialisation operates on LUT objects that
the Builder produces.

### ✅ Stage 3 — TIFF workflow + analyze (shipped v1.4.4)

**Shipped:** `exportTIFF()`, `fromTIFF()` (static), `analyze()`, `comparePixels()` (static), `pixelsToTIFF()` (static). XMP metadata survival confirmed (Photoshop round-trip validated). ZIP compression in Node, LZW decode via utif. CLI tool with all six modes. 32-test suite. Three sample TIFFs generated by `npm run tiff-samples`. Web companion tool deferred — the CLI covers the Node workflow.

**What it unlocks:** Visual LUT editing, CMS capture via editor
round-trip, the full "any editor is a LUT authoring tool" story
from §4.

**Depends on Stage 2** and requires a TIFF codec dependency
decision (open question #1).

### Positioning risk — "just a fast LUT engine"

There's a risk that the lcms bridge positions jsCE as a dumb
dispatch layer — "use lcms for the colour math, jsCE for the
speed." That undersells the engine significantly. The bridge is
an on-ramp, not the destination.

The case for using jsCE as your *only* engine is already strong:

- **Accuracy.** 130 of 150 ICC profiles agree with lcms within
  sub-LSB tolerance. The residual divergence is architectural
  (f64 vs S15.16, clamping philosophy), not a correctness gap.
  For the vast majority of workflows, jsCE's answers are
  indistinguishable from lcms's.
- **API.** Clean JS-first API, no Emscripten FFI, no WASM heap
  management, no `_malloc`/`_free` lifecycle, no `TYPE_RGB_8`
  format constants. Just `new Transform().create(src, dst, intent)`.
- **No WASM required for correctness.** The f64 pipeline and the
  pure-JS `'int'`/`'int16'` kernels run on any JS host with zero
  WASM dependency. WASM-SIMD is a speed tier, not a requirement.
- **Full ICC v2/v4 pipeline.** BPC, chromatic adaptation, all
  four rendering intents, multi-stage proofing chains, virtual
  profiles, custom stages baked into LUTs.
- **Single dependency.** No native binaries, no Emscripten glue,
  no C toolchain. `npm install` and go.

The lcms bridge exists for the subset of users who *need*
bit-exact parity with a specific CMS — regulatory, audit, or
workflow-handoff contexts where "close enough" isn't enough. For
everyone else, jsCE alone is the cleaner, faster, simpler choice.
The hope is that users who arrive via the bridge discover they
don't need two engines — jsCE is accurate enough, fast enough,
and JS-native enough to stand on its own.

### Why this order

Stage 1 is the highest-value/lowest-cost item. It delivers a
real feature (lcms-compatible transforms at WASM-SIMD speed) with
minimal new code, no new dependencies, and a clear test strategy.
It also validates the `setLut()` contract under real custom-LUT
workloads, which de-risks Stages 2 and 3.

Stage 2 is the natural follow-on — once people are building LUTs
programmatically, they'll want to save and redistribute them.

Stage 3 is the creative/workflow unlock — powerful but higher
effort and dependent on external tooling (TIFF codec, Photoshop
behaviour validation). It can take its time.

---

## Related

- [Architecture](./Architecture.md) — how the engine's pipeline model
  works and why `setLut()` is a stable contract
- [Accuracy](./Accuracy.md) — the measured jsCE vs lcms gap that
  motivates the Tier 3 bridge
- [WASM kernels](./WasmKernels.md) — the SIMD interpolation kernels
  that make all three Builder tiers fast at runtime
- [Performance](../Performance.md) — throughput numbers across kernel
  tiers
- [Roadmap](../Roadmap.md) — implementation timeline

---

## Appendix A — The `setLut()` pipeline bootstrap

> **Implementation reference.** This section is for engine/Builder implementors. It documents how the `setLut()` call sequence works internally, what profile fields the pipeline actually reads, and why the synthetic descriptor approach works. It is not needed to *use* the LUT Builder.

### How it works

`Transform.setLut(lut)` is the entry point for loading an
externally-supplied LUT into the engine. The method sets the LUT,
extracts profile info and intent from `lut.chain`, and calls
`this.create()`. The pipeline-building machinery then runs in the
`useCachedLut = true` path, which needs profile-like objects in the
chain — but **only for routing metadata, not for ICC tag data.**

The existing `createLut()` method already solves this: it serialises
the profile chain via `profile2Obj()`, which strips profiles down to
a plain object with just the fields the pipeline actually reads.
The Builder simply needs to produce objects in the same shape.

The full call sequence for reference:

```
setLut(lut)
  → extract inputProfile, outputProfile, intent from lut.chain
  → this.create(inputProfile, outputProfile, intent)
    → createMultiStage(profileChain)
      → this.getProfileChannels(inputProfile)      ← needs profile.type
      → this.getProfileChannels(outputProfile)      ← needs profile.type
      → createPipeline(profileChain, ..., useCachedLut=true)
        → validates lut.chain[0] has 'header' + 'name'
        → validates lut.chain[last] has 'header' + 'name'
        → getInput2DevicePCSInfo(inputProfile)      ← switches on profile.type
        → getDevice2OutputPCSInfo(outputProfile)     ← switches on profile.type (+version)
        → createPipeline_Device_to_Device_via_LUT(pcsInfo, inputProfile, outputProfile)
          → getInput2DevicePCSInfo(inputProfile)    ← switches on profile.type
          → getDevice2OutputPCSInfo(outputProfile)   ← switches on profile.type (+version)
```

`createLut()` already serialises the profile chain via
`profile2Obj()`, stripping full Profile instances down to plain
objects with just `header`, `name`, `type`, `version`, `intent`,
`whitePoint`, `description`, `viewingConditions`, `mediaWhitePoint`,
`PCSEncode`, `PCSDecode`, `PCS8BitScale`. The `useCachedLut` path
in `createPipeline()` then reads these simplified objects — it
never touches A2B/B2A tables, TRCs, or matrices. **The design
already separates "pipeline routing metadata" from "full ICC
profile data".**

For Builder-created LUTs (callbacks, lcms-wasm, TIFF round-trips),
there are no ICC profiles to run through `profile2Obj()`. But the
Builder knows the input/output channel counts and colour spaces, so
it can produce objects in the same shape directly. No new mechanism
needed — just match the existing contract.

### What the pipeline actually needs from the profiles

Tracing every code path that `createPipeline()` touches when
`useCachedLut = true`, the profile objects are used for exactly
three things:

| Usage | Property | Where |
|---|---|---|
| Validation | `header`, `name` | `createPipeline()` line 3685–3690 |
| Channel count | `type` | `getProfileChannels()` — maps type → 1/2/3/4 |
| Encoding routing | `type` (+ `version` for Lab) | `getInput2DevicePCSInfo()`, `getDevice2OutputPCSInfo()` |

Nothing else. The pipeline doesn't read A2B/B2A tables, doesn't
look at TRCs, doesn't inspect whitepoints. When `useCachedLut` is
true, the only pipeline stage added is the single LUT interpolation
stage (`addStageLUT`). The profile objects are just routing metadata
to tell the pipeline what encoding the LUT's input and output values
are in (device vs PCS) and how many channels to expect.

### The existing solution: `profile2Obj()` shape

The design is already in place. `createLut()` calls `profile2Obj()`
to serialise the chain, and `createPipeline()` with `useCachedLut`
reads those serialised objects. The Builder just needs to produce
objects in the same shape.

For engine-built LUTs, `profile2Obj()` produces rich descriptors
because the source profiles have all the data:

```js
{
    header:      { colorSpace: 'RGB', pcs: 'XYZ', profileClass: 'mntr' },
    name:        'sRGB IEC61966-2.1',
    description: 'sRGB IEC61966-2.1',
    type:        eProfileType.RGBMatrix,
    version:     4,
    intent:      eIntent.perceptual,
    whitePoint:  illuminant.d50,
    mediaWhitePoint: illuminant.d65,
    PCSEncode:   ...,
    PCSDecode:   ...,
    PCS8BitScale: ...,
    viewingConditions: ...,
}
```

For Builder-created LUTs where there's no ICC profile, the
descriptor carries what the Builder knows — same shape, sparser
data:

```js
{
    header:      { colorSpace: 'CMYK' },
    name:        'LUT: custom callback (4ch output)',
    description: 'Custom CMYK output via LutBuilder.create()',
    type:        eProfileType.CMYK,
    version:     4,
    intent:      eIntent.perceptual,
}
```

The full chain with intents is the provenance record for the LUT.
A multi-stage chain looks like:

```js
lut.chain = [
    { header: { colorSpace: 'RGB'  }, name: 'sRGB',       type: eProfileType.RGBMatrix, ... },
    eIntent.perceptual,
    { header: { colorSpace: 'CMYK' }, name: 'GRACoL2006', type: eProfileType.CMYK, ... },
    eIntent.relative,
    { header: { colorSpace: 'RGB'  }, name: 'sRGB',       type: eProfileType.RGBMatrix, ... },
]
```

This tells you: "sRGB → perceptual → GRACoL2006 → relative → sRGB"
— a CMYK soft-proof round-trip. When serialised (§5), this is
human-readable metadata sitting right next to the binary LUT data.
You can `JSON.parse` a LUT file, read `lut.chain`, and know exactly
what the LUT does without loading the CLUT data.

### What `profile2Obj()` captures vs what a profile has

A full Profile object carries far more data than `profile2Obj()`
extracts. The question is: what's worth preserving in the LUT
chain descriptor for documentation/provenance, and what's
academic overhead that nobody will use? The guiding principle:
**if you need the full profile data, use profiles, not a LUT.**

| Profile property | In `profile2Obj()`? | Pipeline needs it? | Provenance value |
|---|---|---|---|
| `header` (colorSpace, pcs, pClass, cmmType, platform, flags, attributes, PCSilluminant) | **Yes** | colorSpace: yes (validation). Rest: no. | **High** — `pClass` (mntr/prtr/scnr) tells you what kind of device the profile describes. `colorSpace` + `pcs` are essential context. The rest (`cmmType`, `platform`, `flags`, `attributes`) is academic — rarely consulted even with real profiles. |
| `name` | **Yes** | Yes (validation) | **High** — the single most useful provenance field. "GRACoL2006_Coated1v2" tells you everything. |
| `description` | **Yes** | No | **High** — longer human-readable text, often includes gamut coverage or press condition notes. |
| `type` | **Yes** | **Yes** — drives channel count and encoding routing | N/A — functional, not documentation. |
| `version` | **Yes** | Only for Lab (PCSv2 vs PCSv4) | **Medium** — v2 vs v4 matters for understanding PCS encoding choices that affected the LUT build. |
| `intent` | **Yes** | No (documentation only — intent is baked into the LUT) | **High** — knowing the LUT was built with perceptual vs relative is critical for understanding what it does. |
| `whitePoint` | **Yes** | No | **High** — D50 vs D65 explains adaptation behaviour baked into the LUT. See §7.2b. |
| `mediaWhitePoint` | **Yes** | No | **High** — the profile's native illuminant. Differs from `whitePoint` when chromatic adaptation was applied. |
| `viewingConditions` | **Yes** | No | **Low** — rarely populated in real ICC files. Present for completeness. |
| `PCSEncode`, `PCSDecode`, `PCS8BitScale` | **Yes** | No (not in `useCachedLut` path) | **Low** — internal engine encoding flags. Present because `profile2Obj()` captures them, but never consulted for LUT-based transforms. |
| `copyright` | **No** | No | **Medium** — useful for redistributed LUTs. The builder captures this via `addCopyright()` on `lut.meta` instead of the chain descriptor, which is the better home for it (copyright applies to the LUT, not to each profile in the chain). |
| `technology` | **No** | No | **Low** — ICC technology signature (CRT, LCD, inkjet, etc.). Niche — if you need it, you have the original profile. |
| `characterizationTarget` | **No** | No | **Low** — the CGATS reference data set (e.g. "FOGRA39L"). Intellectually interesting for prepress auditing, but in practice: if you care about characterization data, you're working with profiles, not redistributing LUTs. |
| `chromaticAdaptation` | **No** | No | **Low** — the 3×3 adaptation matrix baked into the profile. Already reflected in the LUT's grid values. |
| `luminance` | **No** | No | **Low** — absolute luminance of the display. Relevant for absolute colorimetric intent, but that's baked into the LUT. |
| `blackPoint` | **No** | No | **Low** — rarely populated, and BPC handling is already baked into the LUT during build. |

**Verdict:** `profile2Obj()` already captures everything that
matters for LUT provenance. The fields it skips (`copyright`,
`technology`, `characterizationTarget`, `chromaticAdaptation`,
`luminance`, `blackPoint`) are either academic, already baked
into the LUT's grid values, or better served by the builder's
own metadata (`lut.meta`).

The one field worth noting is `copyright` — but it belongs on the
LUT itself (`builder.addCopyright()`), not duplicated per chain
entry. A CMYK profile's copyright applies to the profile; the
LUT's copyright is about the LUT as a redistributable artefact,
which may differ (e.g. a LUT built from a proprietary profile but
released under CC-BY).

The `header` object from `profile2Obj()` carries the full decoded
ICC header (all fields from the 128-byte ICC header block). Most
of these are academic for LUT purposes — `colorSpace` and `pcs`
are the only ones that matter. But they're lightweight (a few
strings and numbers) and cost nothing to preserve, so
`profile2Obj()` passes the whole `header` through rather than
cherry-picking. If a downstream tool ever wants to inspect
`header.platform` or `header.cmmType` on a serialised LUT, it's
there.

### Why the chain matters beyond pipeline routing

The chain serves three purposes:

1. **Pipeline routing** — `type` and `version` fields drive
   `getInput2DevicePCSInfo()` and `getDevice2OutputPCSInfo()`.
2. **Provenance** — the full chain records *what colour journey*
   produced this LUT, with profile names and intents. Invaluable for
   debugging ("why does this LUT produce odd blues?" → inspect the
   chain, see it was built with saturation intent from a Fogra39
   profile).
3. **Compatibility** — the serialised chain (§5 `compatibility` block)
   lets downstream tools verify that a LUT matches their expected
   workflow without loading the binary CLUT data.

### Alternative approaches (considered and rejected)

For completeness, three other options were evaluated:

1. **Require real ICC profiles at `setLut()` time** — defeats the
   zero-profile runtime goal.
2. **Build full pseudo-Profile instances** — the Profile class has too
   much internal structure (tag tables, TRCs, matrices); maintaining
   convincing fakes is fragile.
3. **Short-circuit `setLut()` to build the pipeline directly** — call
   `createPipeline_Device_to_Device_via_LUT()` directly, bypass
   `createMultiStage()`. Clean and minimal, but loses the chain
   metadata. Viable as a fallback if the descriptor pattern ever
   proves too fragile.

### Builder implementor reference — synthetic descriptor spec

When the Builder creates a LUT from scratch (Tier 2 callback, Tier 3
lcms bridge, TIFF import), it must generate synthetic descriptors for
the chain. This is the minimum viable contract — the fields that
`createMultiStage()` and `createPipeline()` actually read when
`useCachedLut = true`.

**Required fields:**

| Field | Used by | Notes |
|---|---|---|
| `header` | `createPipeline()` validation | Must exist. Needs `colorSpace` for metadata; rest is informational. |
| `name` | `createPipeline()` validation | Must exist. Human-readable label — shown in debug output. |
| `type` | `getProfileChannels()`, `getInput2DevicePCSInfo()`, `getDevice2OutputPCSInfo()` | **Critical.** Drives channel count and encoding routing. |
| `version` | `getDevice2OutputPCSInfo()` | Only matters when `type` is `eProfileType.Lab` (picks `PCSv2` vs `PCSv4`). Default to `4` for all non-Lab types. |

**Optional but valuable fields (from `profile2Obj()` shape):**

| Field | Purpose |
|---|---|
| `description` | Human-readable — shows up in serialised LUT metadata |
| `intent` | Records the original profile intent (informational) |
| `whitePoint` | Provenance — useful for debugging adaptation issues |
| `mediaWhitePoint` | Provenance |
| `viewingConditions` | Provenance |
| `PCSEncode`, `PCSDecode`, `PCS8BitScale` | Not read in `useCachedLut` path, but present on engine-built descriptors for completeness |

**Profile type derivation from channel count:**

| Channels | `type` | Encoding path |
|---|---|---|
| 1 | `eProfileType.Gray` | `encoding.device` |
| 2 | `eProfileType.Duo` | `encoding.device` |
| 3 | `eProfileType.RGBMatrix` | `encoding.device` |
| 4 | `eProfileType.CMYK` | `encoding.device` |

For 3-channel Lab input/output, the caller can override to
`eProfileType.Lab` — this switches the encoding to PCS rather than
device, which matters for `createPipeline_Input_to_Device()` and
`createPipeline_Device_to_Output()`.

**Concrete example — `virtualProfile()` and chain generation
inside `LutBuilder.create()`:**

```js
// virtualProfile() uses this internally:
function channelsToProfileType(ch, isLab) {
    if (isLab) return eProfileType.Lab;
    return [, eProfileType.Gray, eProfileType.Duo,
              eProfileType.RGBMatrix, eProfileType.CMYK][ch];
}

// When the user calls builder.create() without an explicit chain,
// the builder auto-generates one from inChannels / outChannels:
lut.chain = [
    virtualProfile({ colorSpace: inSpace,  name: opts.inputName  || 'LUT input (' + opts.inChannels + 'ch)' }),
    opts.intent || eIntent.perceptual,
    virtualProfile({ colorSpace: outSpace, name: opts.outputName || 'LUT output (' + opts.outChannels + 'ch)' }),
];

// virtualProfile() returns:
// {
//     header:  { colorSpace: space },
//     name:    name,
//     type:    channelsToProfileType(ch, isLab),
//     version: 4,
// }
```

**What `createMultiStage()` reads from these descriptors at runtime:**

- `this.inputProfile = profileChain[0]` — the input descriptor
- `this.inputChannels = getProfileChannels(inputProfile)` — switches
  on `type` → 1/2/3/4
- `this.outputProfile = profileChain[last]` — the output descriptor
- `this.outputChannels = getProfileChannels(outputProfile)` — switches
  on `type` → 1/2/3/4
- `this.outputProfile.type` — checked during the device-to-output
  conversion stage in `createPipeline_Device_to_Output()`

All of these read `type`, which the synthetic descriptor provides.
`getProfileChannels()` handles every `eProfileType` value, so the
descriptor routes correctly through every code path.

### `setLut()` validation — normalise the chain on entry

`setLut()` was written for an older chain format (`{profile:...}`,
`{intent: N}`) that no longer matches what `createLut()` produces
(`profile2Obj()` descriptors, raw intent numbers). Rather than
scattering format checks through the code, `setLut()` now
normalises the chain up front — mapping every slot to the canonical
format and throwing on anything that doesn't fit:

```js
// Normalise chain to: [profileDescriptor, intentNumber, profileDescriptor, ...]
for (var i = 0; i < lut.chain.length; i++) {
    if (i % 2 === 0) {
        // Profile slot — accept header (profile2Obj/Builder) or profile (legacy)
        if (!(slot.hasOwnProperty('header') || slot.hasOwnProperty('profile')))
            throw 'Invalid LUT - chain[' + i + '] is not a profile descriptor';
    } else {
        // Intent slot — accept raw number or legacy {intent: N}, normalise to number
        if (typeof slot === 'number') { chain.push(slot); }
        else if (slot.hasOwnProperty('intent')) { chain.push(slot.intent); }
        else throw 'Invalid LUT - chain[' + i + '] is not an intent';
    }
}
```

After normalisation, the rest of `setLut()` and `createPipeline()`
see a clean `[descriptor, number, descriptor, ...]` chain regardless
of which format the caller supplied. The odd/even structure is
validated (chain length must be odd and >= 3), legacy formats are
accepted and converted, and bad input fails immediately with a
clear error pointing to the offending slot index.
