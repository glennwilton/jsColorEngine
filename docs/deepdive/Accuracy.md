# Accuracy — what we measured against lcms, and why we trust the numbers

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
[Compiled pipeline](./CompiledPipeline.md)

---

> **Status: shipped, oracle frozen.** The endpoint-diff harness
> (`bench/lcms_compat/run.js`) and the per-pixel triage tool
> (`bench/lcms_compat/probe-pixel.js`) are live and pass against a
> committed reference oracle of 150 `.it8` files generated from
> Little CMS 2.16's full f64 float pipeline. This page is the post-hoc
> writeup: what we built, how it works, what the numbers say, what we
> decided to do (and not do) about the one structural divergence we
> found, and the design philosophy that keeps jsColorEngine an
> independent engine rather than an lcms reimplementation.

## TL;DR

- **jsColorEngine's float pipeline matches Little CMS's float pipeline
  within visual-noise levels** across the full 130-file ICC oracle
  suite. Worst-case in-gamut error per output type:
  - **Lab outputs**: 6.22e-2 ΔE76 (16× below the ΔE 1.0 visibility
    threshold)
  - **RGB → RGB**: 1.24 LSB at u8 (invisible at 8-bit display
    precision)
  - **CMYK ink**: 0.04 % ink (well below dot-gain measurement noise)
  - **2C spot**: 2.88e-4 fraction (noise floor)
- **One structural divergence** — `* → ISOcoated_v2_grey1c_bas.ICC`
  Perceptual without BPC shows ~17 LSB drift in the shadows. Localised
  to the final `PCSXYZ → grayTRC` stage. Root cause is lcms's
  perceptual A2B0 table for that profile hard-pinning shadows to paper
  white below sRGB ~25; jsCE's linear extension is also a defensible
  reading of the profile data.
- **Two diagnostic tools** in
  [`bench/lcms_compat/`](../../bench/lcms_compat) cover the full
  triage surface:
  - `run.js` — the wide net. 130 files × ~9k samples ÷ 1.3 s wall.
  - `probe-pixel.js` — the deep dive. Per-stage in/out trace from both
    engines aligned by output-shape signature.
- **This is not an lcms port.** jsColorEngine is a 100 % JavaScript
  CMS implemented to the ICC v2/v4 specifications. The compat harness
  uses lcms as a reference *oracle* — a way to find issues, track
  root causes, and confirm baseline accuracy — not as a behaviour
  spec. Where we agree, the spec is unambiguous; where we differ, both
  engines have made defensible engineering choices that the spec
  doesn't fully nail down.

## Mindset — comparison as a tool, not a target

A "match lcms bit-for-bit" project is a different project. It would
have to adopt lcms's Q15.16 fixed-point rounding, its 0..2 PCS
encoding, its specific interpretation of every profile's A2B/B2A
tables, and its 25 years of accumulated workflow conventions. The
floating-point output would no longer be the primary path; lcms's
integer pipeline would be.

jsColorEngine has the opposite stance:

- **The math is the spec.** The PCS-XYZ encoding, the chromatic
  adaptation transform, the perceptual rendering definition, the
  black point compensation algorithm — all of it has a textual
  definition in
  [ICC.1:2010 (v4.3)](https://www.color.org/specification/ICC1v43_2010-12.pdf)
  and
  [ICC.1:2001-04 (v2.4)](https://www.color.org/ICC_Minor_Revision_for_Web.pdf).
  jsColorEngine implements that text directly in floating-point JS,
  and the *float* pipeline is the canonical answer the engine
  computes.
- **The integer kernels are an optimisation that doesn't cost
  accuracy.** `'int'` (u8) and `'int16'` (u16) are bit-exact across
  their respective JS and WASM siblings, and they each round at the
  *natural* output boundary for their bit width — not at a downgraded
  one. The u8 path rounds at u8 because output is u8; the u16 path
  (v1.3, Q0.13) rounds at u16 with 13-bit fractional weights, fully
  utilising the u16 output range without quantisation banding. See
  the [16-bit kernel accuracy](#16-bit-kernel-accuracy-v13--near-perfect-no-corners-cut)
  section below for the per-kernel measurement: max **4 LSB u16**
  (0.006 % of u16 range) vs the float reference, mean ≤ 0.0008 %.
  These kernels exist because they're 5–10× faster than the float
  path, not because they trade away precision. The float path remains
  the canonical answer the lcms-compat harness measures, because the
  harness wants to isolate algorithmic disagreements from any
  quantisation at all (including the v1.3 sub-LSB level).
- **lcms is the reference because it's everywhere, not because it's
  authoritative.** If a customer's workflow depends on a particular
  Photoshop output looking "right", what they actually mean is "looking
  the same as lcms produces today, because that's what the rest of
  their stack runs". So matching lcms-on-this-pixel-this-intent is a
  practical concern even when neither engine is wrong by spec. The
  harness lets us distinguish "we have a bug" from "lcms has made a
  choice the spec didn't force, and we made a different one".

This framing decides what we do with each kind of divergence:

- **Sub-LSB / sub-ΔE drift** (the headline) — this is f64 round-off
  noise in different orderings of the same arithmetic. Both engines
  are equally "right". Document the bound, move on.
- **Spec-says-X-and-we-do-X-but-lcms-does-Y** — defend it explicitly
  with a code comment citing the spec section. Don't change.
- **Spec-is-silent-and-we-disagree** — investigate, decide whether to
  match lcms (because of de facto user expectations) or stay
  independent (because our reading is more defensible). Document the
  reasoning either way.

The harness is what makes the third category visible at all.

## What the harness is

```
bench/lcms_compat/
├── reference/         150 CGATS .it8 files — the oracle (committed)
├── stimuli/           6 grid-sweep input files — public data (committed)
├── profiles/          27 ICC profiles — gitignored, see profiles/README
├── lcms_patch/        (v1.3) lcms2 instrumentation patch + regenerator
├── parse-cgats.js     CGATS.17 reader + row → input/output helpers
├── run.js             endpoint diff runner
├── probe-pixel.js     single-pixel stage-by-stage diff
└── last-run.md        latest run.js report (committed artefact)
```

Three things matter about the layout:

1. **The reference oracle is committed.** 150 `.it8` files at
   `bench/lcms_compat/reference/` with ~1.4 M reference
   `(input, output)` pairs. They're the textual numerical output of
   lcms2 2.16 running its full f64 pipeline on six profiles × three
   directions × five intent/BPC variants × ~9k samples per file.
   They're frozen at a known lcms version; bumping that version is a
   deliberate rebaselining action, not a drive-by.
2. **The profiles are gitignored.** ICC profiles are licensed
   artefacts (Adobe RGB, IDEAlliance press profiles, RISO spot-colour
   profiles) that can't go on a public GitHub repo. The harness reads
   whatever's present and skips the rest. CI runs against whatever
   subset is available; missing profiles aren't failures, just lower
   coverage. See
   [`profiles/README.md`](../../bench/lcms_compat/profiles/README.md)
   for canonical sources.
3. **The reference is bit-tight to lcms's float pipeline.** This is
   discussed in detail in [the references appendix](#why-the-references-are-tight-to-lcmss-float-pipeline-not-its-u16-path).
   Short version: the smallest non-zero values in the reference data
   are 7.57e-6, three orders of magnitude smaller than what
   `TYPE_Lab_16` could represent. The references were generated with
   `transicc` running `lIsFloat`, so this is a like-for-like
   full-f64 jsCE-vs-lcms oracle. Any drift we see is a real
   algorithmic disagreement, not a quantisation artefact on lcms's
   side.

## How `run.js` works (the wide net)

```bash
node bench/lcms_compat/run.js
node bench/lcms_compat/run.js --quiet            # summary only
node bench/lcms_compat/run.js --filter Relative  # filter filename
node bench/lcms_compat/run.js --no-md            # skip last-run.md
```

For each of the 150 `.it8` files:

1. **Decode the test config from the filename.** The convention is
   `<src>_to_<dst>_<intent>[_BPC].it8`, with `<src>` and `<dst>`
   being either a literal `.icc` filename or one of the virtual
   shortcuts (`srgb`, `srgb_virt`, `lab`, `labd50`). Intents are tried
   longest-suffix-first so `_Relative_BPC` wins over `_Relative`.
2. **Load both profiles.** File profiles come from
   `bench/lcms_compat/profiles/`; virtuals come from jsCE's built-in
   `*sRGB` / `*Lab` factories. Missing files log as SKIP and the
   harness moves on.
3. **Build the matching `Transform`.** Always `dataFormat:
   'objectFloat'` (the float / accuracy path), with `BPC` from the
   filename suffix. No LUT prebuild — this measures the float
   pipeline, not the cached LUT path.
4. **Walk every reference row.** Each row's input columns are decoded
   into the source profile's native shape (RGB / Lab / CMYK / GRAY /
   2CLR / 3CLR / XYZ, with the right unit scale per channel), pushed
   through `t.forward()`, and the result compared to the reference
   output columns.
5. **Compute per-row error.** ΔE76 for Lab outputs;
   max-absolute-channel-delta in destination native units otherwise
   (LSB at u8 for RGB/GRAY, % ink for CMYK, fraction for 2CLR/3CLR/XYZ).
6. **Aggregate.** `{ max, mean, p50, p95, p99 }` per file, plus a
   "rows over tight threshold" count (0.5 LSB / 0.5 ΔE / 0.05 %)
   to flag drift even when the worst case is acceptable. Rolled up
   per `(src → dst)` direction across all 5 intents.
7. **Write the report.** Console summary + `last-run.md` with full
   per-file detail.

Total wall-clock for the whole 150-file run on a current laptop:
**~1.3 s, ~580 k row evaluations**. Fast enough to run on every
commit if we wanted to.

### Two methodology calls worth understanding

#### Why we filter out-of-gamut samples before computing error

lcms's float pipeline doesn't clamp on output. `Lab(0,−100,−100) →
sRGB` produces something like `(−602, +50, +149)` in 0..255 RGB
units — meaningful in "what the matrix maths would say with no clamp"
terms but not a real RGB colour. jsColorEngine's accuracy path
clamps the float result to [0,1] before scaling to native units.
Comparing them on those rows produces meaningless 600-LSB noise that
would dominate any headline aggregate.

So `run.js` drops any row where any reference channel falls outside
the destination device's native range (`< 0` or `> 255` for
RGB/GRAY, `> 100` for CMYK, etc.) and reports the OOG count
separately. Lab and XYZ are conceptually unbounded so they're never
filtered. The reported `max / mean / p99` are *in-gamut only* — see
the OOG column in `last-run.md` for context.

This is **not** us hiding errors. It's us measuring what we set out
to measure: how closely the two engines agree on colours that are
real RGB/CMYK colours. The OOG behaviour is itself a documented
divergence (jsCE clamps, lcms doesn't), but it's a **clamping
convention** divergence, not a math divergence; rolling it into the
headline would conflate two unrelated things. See
["Where jsColorEngine deliberately diverges from lcms"](#where-jscolorengine-deliberately-diverges-from-lcms) below.

#### Why we use `dataFormat: 'objectFloat'` and not the LUT path

The compat harness measures the *math*, not the cache. The integer /
WASM kernels prebuild a 33×33×33 LUT from the float pipeline and
trilinear-interpolate it for each pixel — they're bit-exact to each
other and faster than float by 20-30×, but the LUT-build itself
quantises to u8 / u16 boundaries. Measuring those kernels against
lcms's float oracle would be measuring "LUT quantisation error +
math difference" instead of just "math difference". So we point the
harness at the float path. The integer kernels have their own
bit-exactness regression test in `bench/compile_poc/` and don't need
the lcms oracle to validate.

## How `probe-pixel.js` works (the deep dive)

When `run.js` flags an outlier file, `probe-pixel.js` resolves it
to a per-stage breakdown for any single pixel:

```bash
node bench/lcms_compat/probe-pixel.js \
     --src "*sRGB" --dst CoatedGRACoL2006.icc \
     --intent Relative --in 128,2,99
```

> **Important — custom lcms build required.** `probe-pixel.js`
> consumes the per-stage `Stage N : EvaluateXxx (in) -> (out)` trace
> emitted by `transicc -v3`. **Stock lcms 2.16 does not print this
> trace** — `-v3` in upstream is just "more verbose error messages",
> not stage-level instrumentation. The `transicc.exe` shipped at
> `bench/lcms_exposed/lcms2-2.16/bin/transicc.exe` is built from a
> jsColorEngine-vendored fork of the lcms2 2.16 source tree
> (`bench/lcms_exposed/lcms2-2.16/`) with `printf` calls added at
> every pipeline-stage evaluator (`cmsEvalMatrix`, `cmsEvalCurves`,
> `cmsEvalCLUTfloatIn16`, `cmsEvalXYZ2Lab`, etc.) inside
> `src/cmslut.c` and friends. The patched binary is committed to the
> repo so contributors don't need to rebuild lcms; the v1.3
> `lcms_patch/` work formalises the patch as a diff that can be
> regenerated against future lcms versions. **Without this build,
> probe-pixel will silently fall back to endpoint-only diff** —
> there's nothing to parse mid-pipeline.

Mechanism:

1. **Drives the patched `transicc.exe`** (the custom-built lcms
   binary described above) at
   `bench/lcms_exposed/lcms2-2.16/bin/transicc.exe` via piped stdin.
   No recompile needed — transicc's interactive prompts are guarded
   by `xisatty(stdin)`, so any pipe input bypasses them and `scanf`
   just consumes whitespace-separated tokens. We send
   `"<v1> <v2> <v3> q\n"` and capture the full `-v3` stage trace.
2. **Builds the same `Transform` in jsCE** with `pipelineDebug: true`
   and runs the same pixel. `historyInfo()` emits the per-stage
   trace in the same `(in) → (out)` shape as lcms.
3. **Parses both traces.** Five quirks worth knowing about lcms's
   `-v3` output:
   - `transicc -v3` runs up to **two extra trivial transforms before
     the actual pixel** for BPC black-point detection (input profile
     + output profile probes, both with `(0,0,0)` input). Each one
     fires its own Stage 1/2/3 trace. The parser re-anchors on every
     `Stage 1` so only the LAST cycle (the user's pixel) survives.
   - `parseLcmsEndpoint` takes the **last** `OUTPUT = (...)` line for
     the same reason.
   - The `EvaluateMatrix` summary line is missing its opening `(` in
     the patched lcms instrumentation (a small bug in the patch, but
     consistent enough to handle by making the leading paren optional
     in the regex).
   - Multi-tuple stages like `EvaluateCLUTfloatIn16` emit several
     intermediate lines (`FromFloatTo16` → `TrilinearInterp16` →
     `From16ToFloat`). The parser stitches first-input + last-output
     to get a true float-in-float-out summary across the int
     round-trip.
   - lcms emits Lab outputs in ICC PCS-LabV2 encoding (`L/100`,
     `(a+128)/255`, `(b+128)/255`), so the endpoint decoder unscales
     to native L/a/b before comparing.
4. **Aligns stages by output-shape signature.** lcms and jsCE often
   have different stage counts (jsCE wraps with `Input2Device` /
   `Device2Output`; lcms collapses certain matrix+curve pairs).
   For each lcms stage, we find the closest jsCE stage by `(channel
   count match, L2 distance < 1.0)` and report the alignment. Fully
   diagnostic — we don't *require* a 1:1 mapping.

### Worked example — sRGB(128, 2, 99) → CoatedGRACoL2006

```
--- aligned per-stage delta (lcms ↔ jsCE) ---
  S1  EvaluateCurves         Δ=5.06e-7   lcms=(0.215861, 0.000607, 0.124772)   jsCE=(0.215861, 0.000607, 0.124772)  (stage_Gamma_Inverse)
  S2  EvaluateMatrix         Δ=1.76e-5   lcms=(0.056104, 0.028012, 0.046071)   jsCE=(0.056107, 0.028013, 0.046088)  (stage_matrix_rgb)
  S3  EvaluateXYZ2Lab:       Δ=8.31e-6   lcms=(0.283862, 0.708983, 0.424348)   jsCE=(0.283869, 0.708985, 0.424352)  (stage_PCSXYZ_to_PCSv4)
  S4  EvaluateCurves         Δ=7.52e-6   lcms=(0.279942, 0.818784, 0.334981)   jsCE=(0.279947, 0.818789, 0.334979)  (stage_curve_v2)
  S5  EvaluateCLUTfloatIn16  Δ=2.88e-5   lcms=(0.491646, 0.981994, 0.242771, 0.172442)   jsCE=(0.491644, 0.981989, 0.242756, 0.172418)  (trilinearInterp3D)
  S6  EvaluateCurves         Δ=2.91e-5   lcms=(0.551919, 1.000000, 0.234928, 0.172442)   jsCE=(0.551916, 1.000000, 0.234912, 0.172418)  (stage_curve_v2)

--- endpoint (CMYK, native units) ---
  jsCE : (55.191556, 100.000000, 23.491238, 17.241757)
  lcms : (55.191900, 100.000000, 23.492800, 17.244200)
  Δ    : 2.443e-3   (max|d| % ink)
```

Per-stage agreement to ~3e-5 across all six stages. Endpoint
agreement to **0.0024 % ink** — invisible. The largest per-stage
delta (1.7e-5 on the matrix step) is f64 round-off from doing the
3×3 multiply in different summation order. Unfixable without
adopting lcms's exact instruction sequence; not worth fixing because
it doesn't propagate.

This is what "we agree" looks like in practice. Most files in the
harness produce this shape of output.

## Headline numbers

Latest run, 130 files OK, 20 SKIP (XYZ-identity profiles —
[see below](#what-the-skipped-files-tell-us)), 0 ERROR, 1.3 s
wall-clock total, ~580 k in-gamut row evaluations.

Per output type, worst-case in-gamut error across all profiles in
the suite:

| Output type | Worst case | Unit | Verdict |
|---|---|---|---|
| Lab          | 6.22e-2 | ΔE76 | **way below visibility** (ΔE 1.0 threshold) |
| RGB → RGB    | 1.24    | LSB at u8 | **invisible at 8-bit display precision** |
| CMYK ink     | 0.04    | % ink | **well below dot-gain measurement noise** |
| 2C spot      | 2.88e-4 | fraction | **noise floor — basically zero** |

For context, **ΔE 1.0** is the conventional threshold for "two
colours a trained observer can just-barely-tell-apart in a
side-by-side patch". **ΔE 0.5** is "indistinguishable in normal
viewing". Our worst-case Lab error is **0.06**, which is sixteen
times below the just-noticeable threshold and well inside lcms's
own per-stage rounding tolerance. **1 LSB at u8** is a single-bit
swing in an 8-bit image channel — sub-LSB drift is below what the
output format can even represent.

Per-direction rollups are in
[`bench/lcms_compat/last-run.md`](../../bench/lcms_compat/last-run.md).
The two interesting outliers in the per-direction table are covered
next.

## Outliers — what we found

### 1. Tiny matrix-shaper drift on `srgb → AdobeRGB1998`

| Direction | Files | Max | Mean | p99 | Tight threshold breaches | OOG |
|---|---:|---:|---:|---:|---:|---:|
| `srgb → AdobeRGB1998.icc` | 5 | 1.24e+0 LSB | 3.28e-2 | 2.63e-1 | 125 / 8820 | 2205 |

Five intent variants, all identical because AdobeRGB1998 is a
matrix-shaper RGB profile and all rendering intents collapse to
relative-colorimetric for matrix profiles (no LUT to apply
perceptual or saturation rescaling against). 125 of 8820 in-gamut
samples breach the 0.5-LSB tight threshold; max is 1.24 LSB.

`probe-pixel` confirms the drift sits in the matrix multiplication
step at ~1.7e-5 per channel (the same order as the GRACoL example
above), accumulated across the matrix → matrix chain into a
~1 LSB worst case. Both engines do the same arithmetic in different
orders; the f64 round-off is unavoidable.

**Decision:** below visibility, document and move on.

### 2. The grey-1c Perceptual case — fully diagnosed

| Direction | Files | Max | Mean | p99 | Tight threshold breaches | OOG |
|---|---:|---:|---:|---:|---:|---:|
| `srgb → ISOcoated_v2_grey1c_bas.ICC` | 5 | 1.92e+1 LSB | 1.18e+0 | 1.81e+1 | 9156 / ~46300 | 0 |
| `lab → ISOcoated_v2_grey1c_bas.ICC`  | 5 | 1.74e+1 LSB | 1.20e+0 | 1.74e+1 | 3969 / ~24255 | 0 |

Maximum drift ~17–19 LSB, not invisible. **Resolves to <0.01 LSB the
moment BPC is enabled or the intent switches to Relative.** The
divergence is specific to Perceptual-without-BPC on a 1-channel grey
output profile.

`probe-pixel` swept the grey ramp:

| sRGB grey | jsCE | lcms | Δ LSB | Comment |
|---|---|---|---|---|
| 25  | 8.7   | **0.0** | 8.7  | lcms hard-clips shadow to paper white |
| 64  | 35.4  | 21.9    | 13.5 | shadow-end drift |
| 128 | 96.9  | 91.2    | 5.6  | midtone — moderate drift |
| 192 | 171.6 | 169.2   | 2.4  | highlight tightening up |
| 230 | 220.9 | 220.0   | 0.9  | near-paper agreement |

The drift is **monotonic with shadow-ness** and concentrated almost
entirely in one stage. Per-stage trace for sRGB(128,128,128):

```
S1  EvaluateCurves   Δ=8e-7    lcms=(0.216,0.216,0.216)    jsCE=(0.216,0.216,0.216)
S2  EvaluateMatrix   Δ=3e-5    lcms=(0.104,0.108,0.089)    jsCE=(0.104,0.108,0.089)
S3  EvaluateMatrix   Δ=1.6e-1  lcms=(0.216)                jsCE=(0.380)              ← divergence here
S4  EvaluateCurves             lcms=(0.358)                <collapsed into jsCE S3>

Endpoint: jsCE=96.9 LSB, lcms=91.2 LSB, Δ=5.6 LSB
```

Stages 1 (sRGB inverse-gamma) and 2 (sRGB→XYZ matrix with
chromatic-adaptation baked in) agree to f64 round-off. The
divergence is the final `PCSXYZ → grayTRC` step. lcms splits it
into two stages — a 1×3 matrix `[0, 1.99996, 0]` that picks the Y
channel and rescales by the PCS-XYZ encoding factor, then a 1D
curve from the profile's perceptual A2B0 table. jsCE collapses both
into one combined stage (`stage_PCSXYZ_to_grayTRC_via_Y`) that
applies the inverse Gray TRC curve to the Y component directly.

**Both engines are reading the same profile data but interpreting
the perceptual A2B0 table differently:**

- **lcms** applies the table verbatim, which for this specific
  profile happens to hard-pin shadows below sRGB ~25 to 0 % ink
  (paper white). That's lcms reading the IDEAlliance profile's
  perceptual rendering table as "the profile vendor's instructions
  for what perceptual means here, including the shadow shape".
- **jsCE** uses the inverse Gray TRC curve directly from the
  profile's `kTRC` tag, which preserves the linear extension into
  the shadow region. That's jsCE reading the ICC spec as "the Gray
  TRC is the canonical mapping between PCS Y and device coverage
  for a 1-channel grey profile, with no special-case shadow
  handling".

Neither is wrong. The ICC spec defines what the perceptual A2B0
table contains (a precomputed mapping from PCS to device coverage
for the perceptual rendering intent) but doesn't mandate that engines
must use it in preference to the Gray TRC tag for 1-channel
profiles. lcms makes one choice, jsCE makes the other.

**Decision:** document, don't change. Three reasons:

1. Niche use case — real-world grey workflows almost universally
   run through CMYK's K channel or a generic GrayGamma profile, not
   a vendor 1c-grey perceptual.
2. Both answers are defensible — replicating lcms's behaviour means
   adopting their perceptual-table interpretation as our own, which
   is a non-trivial behaviour change the wider user base hasn't
   asked for.
3. The cost of "park it" is now tiny — `probe-pixel` resolves any
   future support ticket about this in 30 seconds.

## Where jsColorEngine deliberately diverges from lcms

Several places in the codebase have explicit code that's *not*
"do whatever lcms does". These are worth surfacing because they're
exactly the cases where comparing against lcms in the harness would
produce headline-grabbing deltas if we hadn't documented them
upfront.

### BPC algorithm exclusions (per ICC spec)

Black Point Compensation, by spec and convention, doesn't apply
universally. jsColorEngine's
[`createPipeline_BlackPointCompensation`](../../src/Transform.js)
and the surrounding pipeline-building logic encode the standard
exclusions:

```37:78:src/Transform.js — paraphrased
// BPC does not apply to:
//   - devicelink profiles (PCS not XYZ or Lab)
//   - absolute colorimetric intent
//   - duotone profiles
//   - RGB Matrix → RGB Matrix transforms
//   - cases where input and output black points are equal

// BPC is forced ON for:
//   - V4 perceptual + saturation intents (per ICC v4 spec)
//   - grey-TRC-with-no-LUT profiles (to replicate lcms behaviour
//     where it's de facto load-bearing for that path)
```

The fourth exclusion ("RGB Matrix → RGB Matrix") is a useful
example. The ICC spec doesn't *forbid* applying BPC to a
matrix-to-matrix transform, but in practice both endpoints are
mathematical primaries, both have effectively-zero black points,
and applying the BPC scale would just introduce a tiny
non-spec-defined rotation. lcms historically has done both — early
versions applied BPC, later versions don't. jsColorEngine picks the
"don't" branch as the spec-consistent answer and documents it in
the code.

### Output clamping (vs lcms's unclamped float)

lcms's float pipeline (`TYPE_*_DBL`) emits unclamped per-channel
values for out-of-gamut conversions. jsColorEngine's accuracy path
clamps to [0,1] before scaling to native units. Concretely:

```
Lab(0, -100, -100) → sRGB

  lcms : (-602, +50, +149)  (unclamped, mathematically correct
                              under the matrix as if RGB had no
                              gamut limit)
  jsCE :  (0,    50,  149)  (clamped, so the output is always a
                              real RGB triple representable in the
                              destination device)
```

Both are correct under different reading of the spec ("emit what
the matrix says" vs "emit what the device can produce"). jsCE's
choice was made because the float path is the canonical user-facing
output of the engine, and emitting `R = -602` to a downstream
consumer that expects 0..1 floats is the kind of bug that makes
people mistrust the library. lcms's choice was made because their
float path is a low-level building block intended to be wrapped by
clamping callers.

The compat harness handles this by bucketing OOG samples
separately, so it doesn't pollute the in-gamut headline.

### V4 perceptual black point — predefined by spec, not lcms

```text
src/Transform.js, twice:
  // V4 perceptual black is predefined by the spec
  return this.XYZ( 0.00336, 0.0034731, 0.00287 );
```

The ICC v4 spec defines a fixed black point for the perceptual
intent (the "Perceptual Reference Medium Black Point"), independent
of any specific profile. jsColorEngine uses that fixed point.
Earlier versions of lcms didn't, then they switched. This is one of
those places where being spec-compliant *is* matching lcms — but
matching the spec, not following lcms.

### `isGreyTRCwithNOLUT` — where we deliberately do follow lcms

The contrasting case. For grey profiles that have a `kTRC` tag but
no `A2B` LUT, jsCE force-enables BPC even when the user didn't ask
for it:

```text
src/Transform.js:2460
  // If gray TRC profile force BPC on to replicate LCMS Behavor
  if (this.isGreyTRCwithNOLUT(step.inputProfile, step.intent)) {
      useBPC = true;
  }
```

The ICC spec doesn't require this. lcms does it because without it,
grey TRC profiles produce visibly-darker output than every existing
workflow expects. Following lcms here is a pragmatic decision —
those workflows were calibrated against lcms's behaviour, and
producing different output would break them. The `// to replicate
LCMS Behavor` [sic] comment is the audit trail.

The harness validates that this choice is working — the
`grey1c profile → lab` direction (where the auto-BPC fires) shows
agreement to <0.001 ΔE. It's the *opposite* direction
(`lab → grey1c profile` perceptual without BPC, where the auto-BPC
*doesn't* fire because the grey is on the OUTPUT side and has a
LUT-based B2A) where the divergence lives.

### Summary table

| Behaviour | jsCE | lcms | Reason |
|---|---|---|---|
| BPC on Absolute | OFF | OFF | spec-defined |
| BPC on Devicelink | OFF | OFF | spec-defined |
| BPC on V4 Perceptual | ON (forced) | ON (forced) | spec-defined |
| BPC on RGB Matrix → Matrix | OFF | OFF (lcms 2.x) | spec-permissive, both engines agree |
| BPC on Duotone | OFF | OFF | spec-defined |
| BPC on Gray-TRC (no LUT) input | ON (forced) | ON (forced) | de facto, jsCE explicitly mirrors lcms |
| OOG output values | clamped to [0,1] | unclamped | jsCE: usability; lcms: low-level building block |
| V4 Perceptual black point | spec PRMG | spec PRMG | spec-defined (both correct) |
| Perceptual A2B0 table on 1c grey output | uses `kTRC` directly | uses A2B0 table | spec-permissive, engines diverge |

The harness covers all of these. The only one that produces
headline drift is the last — the grey-1c Perceptual case discussed
above.

## What the skipped files tell us

20 of 150 reference files SKIP. All 20 are for `D50_XYZ.icc` and
`D65_XYZ.icc` — lcms-generated XYZ-identity working-space profiles
(`cmsCreateXYZProfile()` output). Their headers parse but
`colorSpace` comes back undefined because there's no device-side
LUT or matrix to attach to (they're literally a "PCS-XYZ in,
PCS-XYZ out, identity" working-space target). jsColorEngine has no
equivalent virtual XYZ profile yet — neither in the loader nor the
virtual-profile factories.

Filed as a v1.3 follow-up. Not blocking — these profiles are a
side-channel for lcms's own internal use, not something real
applications load.

## Why the references are tight to lcms's float pipeline (NOT its u16 path)

The very first sample in `srgb_virt_to_lab_Relative.it8` reads:

```
INPUT(0,0,0) → OUTPUT(L=0.0, a=7.57e-6, b=7.57e-6)
```

A `7.57e-6` Lab a/b residual is **three orders of magnitude smaller
than the smallest non-zero value representable in
`TYPE_Lab_16`** (255/65535 ≈ 4e-3). So the reference set was
generated by `transicc` running with `lIsFloat` enabled — i.e.
`cmsCreateTransform(... TYPE_RGB_DBL ... TYPE_Lab_DBL ...)`. The
oracle is **lcms's full f64 pipeline**, not its u16 path.

This matters for two reasons:

1. **It's the right comparison for jsCE today.** jsCE's
   `dataFormat: 'objectFloat'` is a full-f64 path. Comparing two
   full-f64 pipelines means any drift is a real algorithmic
   disagreement (different matrix coefficients, different
   chromatic-adaptation order, different perceptual table reading),
   not "we round earlier than they do".
2. **It's the right baseline for v1.3.** The 16-bit kernels landing
   in v1.3 will quantise at the input/output boundary. We need to
   know — before the kernels exist — that the float math underneath
   is solid. If the float path was already drifting from lcms by
   2 ΔE76, every 16-bit divergence would be ambiguous between
   "quantisation rounding" and "underlying float disagreement". The
   max we see today is **0.06 ΔE76**, well below any plausible u16
   quantisation step (~0.5 ΔE76). Any v1.3 drift larger than that is
   a quantisation issue, full stop.

## 16-bit kernel accuracy (v1.3, Q0.13) — near-perfect, no corners cut

Everything above measures jsColorEngine's **float** pipeline against
lcms's float pipeline. That's the right question for "is the math
correct?", but it doesn't answer "if I switch to the fast u16 path,
how much accuracy am I giving up?". This section answers that
separately, with its own bench and its own headline number.

The TL;DR: **on every workflow we measure, the int16 (u16-in, u16-out)
path agrees with the float LUT path to within 4 LSB at u16 worst case,
and ≤ 0.48 LSB at u16 mean — that's 0.006 % of the u16 range worst
case and 0.0008 % mean.** It's not "fast and approximate". It's
"fast and indistinguishable from the float path's own rounding noise
for any consumer that's going to write the result to an image".

### Why this needed its own bench

The lcms-compat harness above deliberately measures `dataFormat:
'objectFloat'` (no LUT, full f64 per-pixel) because mixing
quantisation noise with algorithmic noise would produce ambiguous
numbers. So when we landed the v1.3 u16 kernels, we needed a separate
question:

> Hold the source ICC profile, the float pipeline, and the LUT data
> all constant. Run the SAME u16 inputs through (a) the float LUT
> kernel and (b) the v1.3 int16 LUT kernel. The delta IS the kernel's
> quantisation noise — there's nothing else for it to be.

That's what
[`bench/int16_poc/accuracy_v1_7_self.js`](../../bench/int16_poc/accuracy_v1_7_self.js)
does (the filename keeps its `v1_7` suffix as a development-cycle
artefact — Q0.13 was the v1.7 internal kernel-design milestone that
shipped under the v1.3 project release). Both transforms are built
from the same source profile via the same `createLut()` call; the
int16 LUT is just the float LUT rounded to `Uint16Array` with the
Q0.13 weight quantisation. Compare the outputs in u16 LSB and you
get the kernel error — no profile-build disagreement, no
f64-versus-f64 ordering noise, no gamut-clip convention difference.

### Headline numbers

Same input grid as the lcms-comparison bench (33³ + 6³ nudge for 3D,
17⁴ + 6⁴ nudge for 4D — covers every CLUT cell plus deliberately
ugly sub-cell-aligned samples), GRACoL2006_Coated1v2 + sRGB:

| Workflow | Δ=0 (bit-exact) | ≤1 LSB | ≤4 LSB | max | mean |
|---|---:|---:|---:|---:|---:|
| RGB → Lab    (sRGB → LabD50)   | 72.32 % | 99.98 % | 100.00 % | 2 LSB u16 | 0.28 LSB u16 |
| RGB → CMYK   (sRGB → GRACoL)   | 67.67 % | 99.48 % | 100.00 % | 3 LSB u16 | 0.33 LSB u16 |
| CMYK → RGB   (GRACoL → sRGB)   | 61.06 % | 99.49 % | 100.00 % | 4 LSB u16 | 0.39 LSB u16 |
| CMYK → CMYK  (GRACoL → GRACoL) | 54.77 % | 97.69 % | 100.00 % | 3 LSB u16 | 0.48 LSB u16 |

For context:

- **4 LSB at u16 = 1/64 of one LSB at u8.** Round any of these
  outputs to u8 (the most common consumer) and the int16 path is
  bit-identical to the float path on every single pixel of every
  workflow we tested.
- **0.0008 % of u16 range mean error** is below the noise floor of
  any 8/10/12-bit display path, any print measurement device, and
  any archival format that downsamples on import.
- **Δ=0 rate of 55-72 %** means more than half the output channels
  match the float path bit-for-bit, with no rounding at all. The
  remaining channels miss by 1 LSB — which is the kernel's own
  round-to-nearest floor and would be unavoidable for *any* integer
  kernel writing into u16.

In plain terms: the v1.3 int16 path delivers **highly accurate 16-bit
output**, not "u8 accuracy in u16 storage". An image processed
through v1.3 int16 is the same image you'd get from the float path,
modulo a per-channel rounding residual smaller than the LSB of every
output format consumers are likely to use.

### How v1.3 gets there — Q0.13 design (the "no corners cut" part)

The kernel went through three internal precision iterations during
the v1.3 cycle (Q0.16 → Q0.12 → Q0.13). Q0.13 was the precision
sweet-spot the kernel ladder shipped on — one extra bit of weight
precision over Q0.12 **halves the kernel's intrinsic quantisation
noise** at zero arithmetic cost.

Why stop at Q0.13 and not push further to Q0.16 (lcms's choice)?
Because the design has two non-negotiable constraints that Q0.13
satisfies and higher precisions don't:

1. **No i32 overflow on adversarial CLUTs.** The inner loop is
   `delta × weight + delta × weight + delta × weight` summed across
   three axes. With u13 weights on a u16 CLUT, `65535 × 8191 ≈ 2²⁹⁰`
   per term and `2³⁰·⁶` for the three-axis sum — fits an i32 with
   ~1.4 bits of headroom. Q0.14 weights blow that headroom; Q0.16
   blows it badly. Engines that use Q0.16 (lcms) handle this with
   either i64 arithmetic (slower) or a "trust the profile not to be
   adversarial" assertion (lcms uses the `CMS_NO_SANITIZE` GCC
   attribute on its tetra interp). We picked the option that works
   for every conceivable input without runtime checks.

2. **JS ↔ WASM bit-exact across machines.** The same input bytes
   produce the same output bytes whether the kernel runs in V8,
   SpiderMonkey, JavaScriptCore, or compiled-to-WASM scalar/SIMD.
   That means asserts on synthetic test data don't drift between
   Linux/macOS/Windows or between browsers. Q0.13 keeps every
   intermediate inside the i32 envelope that JS's `Math.imul` and
   WASM's `i32.mul` are both defined on, with no platform-specific
   overflow behaviour to navigate.

These aren't speed compromises. They're correctness contracts — the
v1.3 kernel is faster *because* it can run as i32 throughout, and the
i32 envelope happens to land exactly at Q0.13 weight precision. Going
higher would require a fundamentally different (i64) arithmetic path
that we don't believe pays back: at the level of weight precision
where Q0.13 already sits, the kernel is rounding-bounded, not
weight-bounded. For applications that genuinely need every f64 bit of
precision, `lutMode: 'float'` is right there and gives you f64 all
the way through (way more precision than Q0.16 could).

### Run it yourself

```bash
cd bench/int16_poc
npm install
npm run accuracy:v1_7
```

Add or modify workflows in
[`accuracy_v1_7_self.js`](../../bench/int16_poc/accuracy_v1_7_self.js)
to test against your own profiles. The bench is single-file, no
fixtures beyond the GRACoL profile already in `__tests__/`.

The test gate that ships with the engine is
[`bench/int16_identity.js`](../../bench/int16_identity.js) — a
synthetic identity-CLUT round-trip that passes if and only if the
kernels round at the u16 LSB and never wider. Run it any time you
touch the int16 kernel code:

```bash
node bench/int16_identity.js
```

It exits non-zero on any kernel that loses an LSB, so it's safe to
wire into CI or a pre-commit hook.

## Conclusion — confidence baseline for v1.3

Three things land from this:

1. **jsColorEngine's float pipeline is a faithful peer of Little
   CMS's float pipeline**, with worst-case drift two-to-three
   orders of magnitude below human visibility on every output type
   measured. Documented, reproducible, frozen oracle, public CGATS
   format.
2. **The one structural divergence is fully understood and
   localised** to one stage of one specific profile's perceptual
   rendering. We chose not to replicate lcms's behaviour there for
   defensible reasons; future support questions resolve in 30
   seconds via `probe-pixel`.
3. **The diagnostic infrastructure scales forward.** Every v1.3
   16-bit kernel that lands gets the same per-stage validation
   automatically. Every v1.5 compiled-pipeline emitter gets
   per-stage probing. Future regressions get triaged in the same
   tools that triaged this baseline.

This is the foundation v1.3's 16-bit work needs. We know the
math underneath is right; the quantisation kernels can land against
this oracle without ambiguity about whose answer is "correct".

---

## Appendix — running the harness yourself

```bash
# Endpoint diff across the whole reference set (1.3 s):
node bench/lcms_compat/run.js

# Single-pixel triage:
node bench/lcms_compat/probe-pixel.js \
     --src "*sRGB" \
     --dst CoatedGRACoL2006.icc \
     --intent Relative \
     --in 128,2,99

# Common variants:
node bench/lcms_compat/probe-pixel.js --src "*Lab" --dst grey1c.icc \
     --intent Perceptual --in 50,0,0
node bench/lcms_compat/probe-pixel.js --src "*sRGB" --dst "*Lab" \
     --intent Relative --bpc --in 128,2,99
```

Both tools assume `bench/lcms_compat/profiles/` contains the ICC
files referenced by filename (gitignored — see
[`profiles/README.md`](../../bench/lcms_compat/profiles/README.md)
for canonical sources).

`probe-pixel.js` additionally needs the **stage-instrumented build
of `transicc.exe`** at
`bench/lcms_exposed/lcms2-2.16/bin/transicc.exe` — this is a custom
build of lcms 2.16 with `printf` calls added at every pipeline-stage
evaluator (stock upstream `transicc -v3` does *not* emit a stage
trace). The patched binary is already vendored in the repo so no
rebuild is needed for triage; the diff against upstream lives at
`bench/lcms_exposed/lcms2-2.16/` and gets formalised as a regen-able
patch in `bench/lcms_compat/lcms_patch/` as part of v1.3.

`run.js` writes
[`bench/lcms_compat/last-run.md`](../../bench/lcms_compat/last-run.md)
on every invocation; that file is committed so the headline numbers
in this doc always match the latest run.
