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
- [v1.3 — 16-bit input/output across int + WASM LUT kernels](#v13--16-bit-inputoutput-across-int--wasm-lut-kernels)
    - [Tunable LUT grid size — `lutGridSize` option](#tunable-lut-grid-size--lutgridsize-option)
    - [Compat harness — `bench/lcms_compat/`](#compat-harness--benchlcms_compat)
- [v1.4 — Code generation for non-LUT pipelines + smarter `'auto'`](#v14--code-generation-for-non-lut-pipelines--smarter-auto)
    - [Non-LUT pipeline code generation (`new Function` + emitted WASM)](#non-lut-pipeline-code-generation-new-function--emitted-wasm)
    - [Per-Transform microbench for `'auto'`](#per-transform-microbench-for-auto)
    - [Candidate micro-optimisations — float-wasm-scalar / f32 CLUT / float-wasm-simd](#candidate-micro-optimisations)
- [v1.5 — Image helper + browser samples](#v15--image-helper--browser-samples)
    - [Browser samples](#browser-samples)
- [v1.6 (optional) — `lutMode: 'int-pipeline'` — S15.16 for lcms parity](#v16-optional--lutmode-int-pipeline--s1516-for-lcms-parity)
- [v2 — Separation of concerns: split Transform + Pipeline + Interpolator](#v2--separation-of-concerns-split-transform--pipeline--interpolator)
- [What we are explicitly NOT doing](#what-we-are-explicitly-not-doing)
- [Historical record — original v1.3 / v1.4 analysis (1D WASM POC)](#historical-record--original-v13--v14-analysis-1d-wasm-poc)

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

---

## v1.3 — 16-bit input/output across int + WASM LUT kernels

**Primary v1.3 focus.** Native Lab 16-bit I/O (`dataFormat: 'int16'`)
end-to-end — this is the biggest practical gap for print/prepress
users and closes the ICC v4 PCS story (Lab is encoded as u16 in ICC
v4, so a 16-bit-in, 16-bit-out path avoids the round-trip through
u8 we quietly do today). The 16-bit compat tests also become the
regression harness for the lcms2 `.it8` oracle work (see next
section).

Once the WASM LUT infrastructure is in place (v1.2, ✅ done), 16-bit
is a fanout task rather than a net-new one — the same kernel gets a
u16 input load, u16 store, and Q0.16 → final-shift retuning.

**Who wants it:**

- Print prepress is 16-bit end-to-end.
- Photo editors hold images in u16 to avoid posterisation in heavy
  edits.
- ICC v4 itself encodes Lab as u16.
- The 4D SIMD design from v1.2 (hoisted C/M/Y setup + two K-plane
  SIMD interp bodies kept at u16 → SIMD K-LERP at u20 → final narrow)
  already exposes a u16-output path as a cheap side-effect — skip
  the tail narrow, store `vOut` as u16 directly.

**Plan:**

1. **u16 input → u8 output** (free; we already have the high-precision
   u16 LUT, just feed u8-bucketed indices from the high byte). One-line
   variant per kernel.
2. **u16 input → u16 output** (the prize). Math stays Q0.16, final
   shift becomes `(acc + 0x8000) >> 16` instead of `+0x80 >> 8`.
   Single-step rounding (Q0.15 weights) gave best accuracy in the POC
   bench — see `bench/int_vs_float.js` FINDING #5. For WASM kernels
   this is a different **narrow width at the tail** — everything
   upstream is the same u16 CLUT, same gps, same i32/SIMD math.
3. **u8 input → u16 output** (cheap). Useful for "convert once,
   downstream tools handle 16-bit" pipelines.
4. **WASM SIMD u16 output.** Skip the final
   `i8x16.narrow_i16x8_u` narrow in the 3D SIMD kernel, store
   `v128.store` directly. Lane count halves per pixel (4 u16 lanes
   instead of up to 4 u8 lanes), but 4 u16 lanes is exactly what we
   want for RGB/CMYK output — no lane waste. Expected to be within
   the same 3.0-3.5× band as u8 SIMD.
5. **Look for WASM SIMD improvements that u16 lane width unlocks.**
   Candidates to POC:
   - `i16x8` math uses 16-bit mul which is half the latency of 32-bit
     mul on most x64 microarchitectures — the math stage itself may
     run faster at u16 than u8 did.
   - u16 output avoids the double-narrow (`i32x4 → i16x8 → i8x16`)
     at pixel tail, which was ~3 instructions per pixel in the u8
     kernel. Small but additive.

**Open question:** do we keep the u16 LUT as the canonical int LUT and
use it for both u8 and u16 output, or build a separate u15 LUT for
"safe 32-bit accumulator" math? POC concluded u16 + Q0.8 has zero
overflow problems for u8 output; u16 output needs careful accumulator
sizing. **Working assumption:** u16 LUT, Q0.16 accumulator (32-bit,
fits in `Math.imul` output and in i32 SIMD lanes), single-step
round-and-shift.

**Descriptor shape.** `dataFormat` already has `'int16'` reserved;
the kernel dispatch adds an `outputPrecision: 'u8' | 'u16'` flag to
the `LutDescriptor` (which the v2 package split formalises anyway —
see below). No new `lutMode` value needed; the existing `'int'` /
`'int-wasm-*'` values all get `outputPrecision` branches.

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

### Compat harness — `bench/lcms_compat/`

Binds to the 16-bit work because 16-bit quantisation is where
per-stage ΔE tails become visible — 8-bit masks a lot of them.
Building the compat harness alongside v1.3 gives the 16-bit kernel
work a trustworthy correctness oracle from day one.

**Scaffold already landed in v1.2 prep** (see
[`bench/lcms_compat/`](../bench/lcms_compat)):

- **29 ICC profiles** moved into `bench/lcms_compat/profiles/`
  (gitignored — see *Licensing split* below). Covers RGB matrix-
  shaper (sRGB v1/v2/v4, AdobeRGB, AppleRGB, ColorMatch, ProPhoto,
  WideGamut), XYZ working spaces (D50, D65), CMYK press profiles
  (USSheetfed, USWebCoated, Euroscale, ISOcoated, FOGRA28/29, SNAP,
  GRACoL, WebCoatedSWOP), 1C grey, 1C/2C/3C RISO MZ770 spot-colour,
  and a NamedColor profile. The 2C RedGreen and 3C RedYellowBlue /
  YellowBlueTeal variants are a rare N-channel coverage most CMS
  test suites lack.
- **150 reference `.it8` files** committed at
  `bench/lcms_compat/reference/` — 6 profiles × 3 directions
  (`profile→Lab`, `*srgb→profile`, `profile→*srgb`) × 5
  intent-×-BPC variants × 9261 samples per file (21³ grid sweep).
  ~1.4 M reference (input → output) pairs generated by an
  instrumented lcms2 2.16 fork. Frozen oracle.
- **6 stimulus `.it8` files** committed at
  `bench/lcms_compat/stimuli/` — RGB / CMYK / Lab / Gray / 2C /
  XYZ grid sweeps; public numerical data, no IP.
- **CGATS.17 reader** (`bench/lcms_compat/parse-cgats.js`) —
  salvaged from the 2023-era `speed_tests/GATCS.js` prototype,
  tidied, with `parseCGATS()` + `rowToInput()` + `rowToOutput()`
  helpers that know how to map lcms's CGATS field conventions
  (`IN_RGB_R`, `OUT_LAB_L`, `IN_CH1`, etc.) to jsColorEngine's
  `convert.RGB()` / `convert.Lab()` / `convert.Duo()` factory calls.
- **Stage-level instrumentation** in the lcms2 2.16 tree at
  `bench/lcms_exposed/lcms2-2.16/src/cmslut.c` and `cmsio1.c`
  (untracked, gitignored) — per-stage `EvaluateCurves` /
  `EvaluateMatrix` / `EvaluateCLUT` / `EvaluateXYZ2Lab` printfs at
  15-digit precision, plus per-pixel `IN (...)` / `Stage N: ...` /
  `OUTPUT = (...)` wrapping. To be extracted as a `.patch` file
  against stock 2.16 in v1.3 so the full vendored tree doesn't need
  to stay on disk.
- **jsColorEngine already has the mirror instrumentation.**
  `new Transform({pipelineDebug: true})` threads a `stage_debug`
  wrapper around every stage; `historyInfo()` emits a
  column-aligned `stageName . . . . : In → Out` trace in the
  same shape as lcms's `-v3` output. `debugInfo()` combines
  chain history + optimiser decisions + stage names + runtime
  trace into a single diffable string. See
  [`src/Transform.js:2247-2292`](../src/Transform.js).

**What v1.3 actually builds:**

1. **Extract the lcms patch.** Distil the instrumented 2.16 tree
   at `bench/lcms_exposed/` into
   `bench/lcms_compat/lcms_patch/01-stage-prints.patch` against
   stock lcms2 2.16, plus a `02-transicc4batch.patch` for the
   batch-mode `.it8` I/O variant of `transicc`. Add
   `fetch-lcms2-instrumented.sh` / `.ps1` that downloads stock
   lcms from the GitHub release and applies the patches (same
   pattern as `bench/lcms_c/`). Delete the `bench/lcms_exposed/`
   tree once the patch round-trips byte-identically.
2. **Endpoint-diff harness (`run.js`).** For each reference `.it8`:
   parse filename → `{profile, direction, intent, bpc}`; load
   stimulus + reference; build matching jsCE Transform
   (`lutMode: 'float'` for ground-truth comparison; LUT modes
   separately); run stimulus rows; per-row ΔE76 (Lab output) or
   RMSE (device output); report `{max, mean, p95, p99, count>1dE,
   count>2dE}` per file. Aggregate into a per-profile × per-direction
   table. Missing profiles → `skipped`, not `failed`. ~200 lines of
   JS, driven by the already-salvaged `parse-cgats.js`.
3. **Stage-diff harness (`diff-stages.js`).** Optional, higher-value.
   Parse lcms's `-v3` stage-trace output into a canonical
   `{stageName, in[], out[]}` list; call `debugInfo()` on the
   matching jsCE Transform; canonicalise both into the same JSON
   shape; diff stage-by-stage with the known invariants noted
   (e.g. lcms PCS XYZ is on 0..2 scale and jsCE is on 0..1, so
   `lcms.matrixOut ≈ jsCE.matrixOut × 2`). Tolerances per stage
   type (matrix: bit-exact ± ULPs; curves: bit-exact; CLUT: ΔE 0.1
   because tetrahedral vs trilinear may legitimately differ;
   XYZ2Lab: bit-exact). ~300 lines total including the canonicaliser.
4. **Profile-version hash-verification.** Ship a
   `profile-hashes.json` alongside `reference/` recording
   `{filename: sha256}` for every profile the oracle was generated
   against. The harness warns loudly on mismatch rather than
   silently computing against a different profile revision.
5. **CI integration.** `npm run compat` runs the endpoint harness
   across all available reference files and fails on any sample
   >1 ΔE (per-file tolerance, weighted by mode — looser for
   N-channel spot workflows). The stage-diff harness is a
   diagnostic tool, not a CI gate — run it when a compat failure
   needs debugging.
6. **Regeneration path.** `fetch-lcms2-instrumented.sh` +
   `make oracle` regenerates `reference/` from scratch given the
   patched lcms + user-supplied profiles. Pinned to lcms2 2.16
   explicitly; bumping to a later lcms is a deliberate action that
   should be reviewed as an oracle-rebaselining commit, not a
   drive-by.

### Licensing split — public data, private profiles

Most ICC profiles that matter in real prepress are licensed
artefacts (Adobe's matrix-shaper RGB, Adobe's Photoshop press
profiles, IDEAlliance's GRACoL / SWOP, ECI's FOGRA, RISO's spot
profiles). **We cannot redistribute them on a public GitHub repo.**

**But the `.it8` reference data generated from them is derived
measurement data** — rows of `(input coords → Lab output)` in the
industry-standard CGATS tabular format. It's not the profile. It's
a numerical fact about what lcms2 computes given a particular
(profile, intent, bpc) combination. That's publishable, and the
compat suite hinges on it.

The resulting layout (see
[`bench/lcms_compat/README.md`](../bench/lcms_compat/README.md)):

- `bench/lcms_compat/reference/` — **committed**, the public
  versioned oracle (150 files, ~1.4 M samples)
- `bench/lcms_compat/stimuli/` — **committed**, public input grids
- `bench/lcms_compat/profiles/` — **gitignored**, user supplies
  licensed copies; the harness reads whatever's present and
  reports `skipped` for what's missing
- `bench/lcms_compat/profiles/README.md` — **committed**, canonical
  sources for each profile (Adobe, ICC.org, IDEAlliance, ECI, RISO)

This is actually a *stronger* compat story than shipping profiles
would be, because it forces profile-version identity to matter. A
silent profile swap (e.g. user updated their Adobe Color Suite and
the AdobeRGB1998.icc bytes changed) surfaces as a ΔE spike in the
diff, not as silent data drift.

### Open design question — math truth vs ground truth

The compat harness *measures* divergence, it doesn't choose sides.
The choice lives in a future release:

- **Math truth** (current default, `lutMode: 'float'`): keep the
  full f64 pipeline. Our numbers are legitimately better by ΔE; the
  divergence against lcms is small and documented per-stage. People
  doing colour measurement / ΔE-critical work want this; it's
  objectively closer to the ICC specification's intent.
- **Ground truth** (future `lutMode: 'int-pipeline'`, see
  [v1.5](#v15-optional--lutmode-int-pipeline--s1516-for-lcms-parity)):
  opt-in mode that matches lcms bit-for-bit by adopting their
  Q15.16 fixed-point, their PCS XYZ 0..2 scaling, their rounding.
  People with 25 years of press-conditioned workflows calibrated
  against lcms outputs want this; to them "mathematically better"
  reads as "silently different" and breaks their audit trail.

**The decision is not part of v1.3.** v1.3 builds the measurement
apparatus, ships the endpoint report, and documents the delta. v1.5
adds the parity mode if the numbers and the user feedback justify
the complexity. We don't commit to either direction pre-measurement.

**Other v1.3 open questions:**

- Per-file tolerance vs pooled aggregate? Leaning per-file with a
  mode-weighted aggregate summary — CMYK→CMYK and N-channel spot
  workflows legitimately have looser tolerances than RGB→Lab
  because the CLUT interpolation strategy diverges more.
- NamedColor profile compat — will almost certainly fail on first
  run (named-colour handling is a mostly-unfinished area in
  jsColorEngine). Scope call: fix in v1.3, document as unsupported,
  or punt to v2?

### Why this is valuable beyond "do we match lcms"

- Every stage-level divergence that exists becomes *documented*
  rather than silent. That documentation is the difference between
  "might work" and "will work" when a prepress bureau evaluates us
  against their calibration targets.
- The 2C / 3C RISO MZ770 profiles exercise codepaths that probably
  haven't been run in earnest since the original N-channel work
  in 2023. Finding a bug there is a feature, not a failure.
- `debugInfo()` + `pipelineDebug: true` — the jsCE-side
  instrumentation — was written for the author's own debugging
  during the original 2022-23 development, not as compat
  infrastructure. It happens to be exactly the right shape.
  v1.3 promotes a quiet diagnostic tool into a CI-visible
  correctness anchor; the only new code is the
  canonicalise-and-diff glue.

---

## v1.4 — Code generation for non-LUT pipelines + smarter `'auto'`

> **Scope note.** v1.4 was originally "WASM SIMD for matrix-shaper
> transforms". `'auto'` moved up to v1.2. Matrix-shaper alone is a
> smaller target than the original 1D POC findings suggest — a
> general **Transform-time code generator** for the non-LUT pipeline
> is a strictly larger win that subsumes it. The 1D POC result
> (67.7× WASM SIMD ceiling on no-gather math, see Historical record
> below) is the evidence that emitted code of this shape has a very
> high ceiling in both JS-through-TurboFan and WASM-SIMD lowerings.
> What was "one kernel" becomes "one codegen family".

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
   `lutMode: 'fast-jit'` (or similar) and call it a v1.4 preview.
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

### Candidate micro-optimisations

These are small opt-in items that may slot into v1.3 or v1.4 depending
on priorities.

**Float-LUT WASM tier — the missing half of the speed pyramid.**
Important correction to an earlier draft of this doc: the JS float
LUT path **already exists and is already specialised** per output
channel count. `tetrahedralInterp3DArray_3Ch_loop`,
`_4Ch_loop`, `_NCh_loop` (and their 4D siblings) are hand-unrolled
hot kernels that have shipped since ~v1.0. Only `_NCh` is a
generic fallback (5+ output channels). What's **missing** is the
WASM tier for float — the int path has JS → WASM scalar → WASM
SIMD, the float path has only JS. Two orthogonal items close the
gap; neither requires the other, and they stack cleanly.

### `float-wasm-scalar` — the low-complexity win

This is the sweet spot. Copy the `int-wasm-scalar` kernel
(`src/wasm/tetra{3,4}d_nch.wat`), replace `i32.mul` + Q-shift with
`f32.mul` / `f32.add`, drop the rounding bias and narrow tails.
**The float kernel is actually *simpler* than the int one**:

- No Q-format bookkeeping (weights are just floats in `[0, 1]`)
- No `+ 0x80 >> 8` round-half-up bias
- No `i8x16.narrow_i16x8_u` at the tail
- `f32.mul` + `f32.add` map 1:1 to hardware FMA (when available)

Expected speedup: ~1.2–1.5× over JS float LUT (same band
`int-wasm-scalar` gave over JS `int` — float kernels hit the same
JS function-call + typed-array-bounds-check overhead). No SIMD
complexity, no lane-narrowing games — single rolled n-channel
kernel covers every output channel count.

`lutMode: 'float-wasm-scalar'` enters the demotion chain below
`int-wasm-scalar` for callers who explicitly want float accuracy
at LUT-grade speed.

### `f32 CLUT` (`dataType: 'f32'`) — the cache-footprint win

Orthogonal to the kernel change above. Today the float CLUT is
`Float64Array`; switching to `Float32Array` halves the bytes:

- 3D profile (17³×4 = 19.6 KB @ f64 → 9.8 KB @ f32): fully
  L1-resident either way — no cache win.
- 4D CMYK profile (17⁴×4 = 334 KB @ f64 → 167 KB @ f32): crosses
  the typical L2 boundary. Measurable win on 4D workflows on
  desktop-class CPUs.

Risks to measure:
1. **JS f32 load = implicit f32→f64 widen** (`cvtss2sd`) on every
   CLUT read in the JS kernel. On tetrahedral loops with 4–8 CLUT
   reads per output channel, those widens can eat the cache win.
   The WASM float kernel has no such widening — `f32.load` is
   native-width.
2. V8 deopts + re-specialises on first `Float32Array` after
   `Float64Array`. Bench must warm separately, not swap mid-run.
3. Accuracy: f32 mantissa is 24 bits, so CLUT cells in `[0, 1]`
   land ~6e-8 off. Negligible for ΔE; worth documenting.

### `float-wasm-simd` — the ambitious follow-on

If `float-wasm-scalar` + `f32 CLUT` ship, the SIMD variant is the
natural continuation: `f32x4` channel-parallel in a v128 register,
copying the `int-wasm-simd` design directly. Same axis choice
(channel-parallel, not gather — see the SIMD width note in
[Performance.md](./Performance.md)). The f32 data footprint win
compounds with the `f32x4` SIMD win here — two-for-one.

### Priority ordering

1. **`float-wasm-scalar`** — cheapest, largest pool of users
   (anyone using default float accuracy today), most predictable
   win, simplest kernel of the three.
2. **`f32 CLUT`** — orthogonal to (1), measurement-dependent. Do
   the measurement before committing. Stacks with (1) and (3).
3. **`float-wasm-simd`** — ambitious; depends on (1) and (2) to
   avoid duplicated effort.

**Non-goal**: none of this before 16-bit is done. 16-bit serves a
larger audience (print, photo, ICC v4 PCS) and its kernel
skeleton is what the WASM float work copies.

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

## v1.5 — Image helper + browser samples

A small, single-purpose helper class that owns the "I have an image,
I want to display / proof / inspect it" workflow. **Not a general
image library** — no resize, no filter, no composite, no format
encode/decode. Strictly "move bytes around the colour transform,
visualise what's there."

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

**v1.5**, after the perf ceiling work of v1.4 is banked. The helper
is a features-and-samples release, not a performance one — slotting
it after v1.4 means it rides on top of every speed win by default.

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

Each ~100-200 lines of vanilla JS, no framework, no build step.
Hosted on GitHub Pages so the README can link to live demos ("Try
it in your browser →"). Adoption impact per hour of effort is
higher than almost any feature work.

Samples also double as **the runnable backing for the `docs/Guide.md`
tuning guide** (when it lands) — each one is the "working copy" of
a code block in the guide, checked for drift by a tiny sync script.

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
already sets it up cleanly and the v1.4 code-generation work
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
- **`@jscolorengine/pipeline-emitter`** *(new, if v1.4 ends up big
  enough)* — the code-generator from v1.4. Takes a pipeline spec,
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
   interpolator package directly. Our 1.4× scalar + SIMD wins become
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
4. **v1.4 complete:** non-LUT pipeline code generation lands. The
   split isn't just "LUT interpolator vs the rest" anymore — it's
   "LUT interpolator vs emitted pipelines vs color-science front-
   end". That three-way split is the target package shape.
5. **v2 split:** extract `@jscolorengine/interpolator` (and maybe
   `@jscolorengine/pipeline-emitter` if v1.4 ends up big enough) to
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
  added on top of any kernel later. Will revisit post-v1.4 once
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

## Historical record — original v1.3 / v1.4 analysis (1D WASM POC)

The two analyses below drove the original v1.3 / v1.4 split. Both
have since been superseded — v1.3 (WASM scalar) landed in v1.2, and
v1.4's matrix-shaper-only plan was subsumed by the v1.4 code-
generation target above. The numbers and findings are preserved
because they still inform design decisions (especially the SIMD
ceiling number for v1.4 emission, and the "LUT gather ≠ vectorise
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
   v1.4 code-generation target. Matrix-shaper, gamma polynomial,
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
