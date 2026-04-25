# `lcms_compat` — jsColorEngine ↔ LittleCMS compatibility harness

**Status:** **runner shipped, oracle regenerator in v1.3.** The
endpoint-diff runner (`run.js`) is live and passes 130/150 reference
files in ~1.3 s on a current laptop. The lcms instrumentation patch
(`lcms_patch/`) and the matching `transicc4batch` regenerator land
in v1.3 — see
[docs/Roadmap.md § v1.3 Compat harness](../../docs/Roadmap.md#compat-harness--benchlcms_compat).

This directory is jsColorEngine's long-term **compatibility and
accuracy regression suite**, measured against LittleCMS 2.16 as the
de-facto reference implementation.

## Conclusion — jsColorEngine is a faithful float-precision peer of lcms

jsColorEngine's float pipeline matches Little CMS's float pipeline
within visual-noise levels across the full 130-file ICC oracle
suite. On Lab outputs the worst case is **0.06 ΔE76** — sixteen
times below the ΔE 1.0 visibility threshold and well inside lcms's
own per-stage rounding tolerance. On 8-bit RGB the worst case is
**1.24 LSB** (invisible at u8 display precision) and on CMYK the
worst case is **0.04 % ink** (well below dot-gain measurement
noise). The only structural divergence is lcms's Perceptual
rendering on 1-channel grey output profiles without BPC, which
bakes in a black-point lift jsCE doesn't reproduce (~17 LSB) — a
real algorithmic difference, not a numerical one, that resolves to
<0.01 LSB the moment BPC is enabled or the intent switches to
Relative. **Conclusion: jsCE is a faithful float-precision peer of
lcms**, with the remaining drift small enough that v1.3's 16-bit
kernels can land directly against this oracle without ambiguity
about whose math is "right."

## TL;DR — first-pass numbers (v1.2.0 vs lcms2 2.16 float oracle)

Both engines on full f64 (`TYPE_*_DBL` in lcms, `dataFormat: 'objectFloat'`
in jsCE), 130 reference files, ~580k in-gamut row evaluations, 1.3 s
wall-clock total. See `last-run.md` for the per-file detail.

| Output type | Best | Worst | Unit | Verdict |
|---|---|---|---|---|
| Lab          | 1.22e-5 | 6.22e-2 | ΔE76 | **way below visibility** (ΔE 1.0 threshold) |
| RGB → RGB    | 0.18    | 1.24    | LSB at u8 | **invisible at 8-bit display precision** (max < 1.5 LSB) |
| CMYK ink     | 0.013   | 0.039   | % ink | **well below dot-gain measurement precision** |
| 2C spot      | 8.85e-5 | 2.88e-4 | fraction (0..1) | **noise floor — basically zero** |

Two real algorithmic divergences worth flagging:

- `* → ISOcoated_v2_grey1c_bas.ICC Perceptual` (no BPC) shows ~17–19
  LSB drift on ~75 % of samples. Goes back to <0.01 LSB the moment
  BPC is enabled, or with the Relative intent. So lcms's Perceptual
  rendering on a 1C grey output without BPC bakes in something jsCE
  doesn't (probably a BPC-ish black-point lift baked into lcms's
  perceptual table for grey). v1.3 follow-up to investigate.
- `srgb → AdobeRGB1998.icc` (matrix→matrix) shows max 1.24 LSB on
  125/8820 samples. Tiny matrix-multiplication-order or
  whitepoint-adaptation residual. Below visibility but worth a stage
  trace once `lcms_patch/` lands.

**Skipped:** 20 reference files for `D50_XYZ.icc` / `D65_XYZ.icc`.
These are lcms-generated XYZ-identity working-space profiles
(`cmsCreateXYZProfile()` output) — header parses but `colorSpace`
comes back undefined because there's no device-side LUT or matrix
to attach to. jsCE has no equivalent virtual XYZ profile yet; see
v1.3 roadmap.

---

## What's in here

```
bench/lcms_compat/
├── profiles/          29 ICC profiles — gitignored (see profiles/README.md)
├── stimuli/           6 CGATS input files (grid sweeps, public data)
├── reference/         150 CGATS reference files from instrumented lcms2 2.16
├── lcms_patch/        (v1.3) lcms2 stage-instrumentation patch + build scripts
├── parse-cgats.js     CGATS.17 reader + row→color helpers
└── README.md          this file
```

## The licensing split — public data, private profiles

**ICC profiles are licensed artefacts.** Adobe's matrix-shaper RGB
profiles, IDEAlliance's press profiles, RISO's spot-colour profiles,
ECI's FOGRA press profiles — most of what prepress shops run against
— come with redistribution terms that prevent committing them to a
public GitHub repository.

**CGATS reference data is derived measurement data.** The `.it8`
files in `reference/` contain rows of `(input_coords → Lab_output)`
measurements. They're numerical facts about what lcms2 computes given
a particular (profile, intent, bpc) combination, stored in the
industry-standard tabular format. They're not the profile. They're
what anyone with the same profile + the same lcms version would
compute.

**The design:**

- `reference/` is **committed to git** — it's the public, versioned
  oracle. 150 files, ~1.4 M reference samples, pinned to lcms2 2.16
  with the stage-level instrumentation documented in
  `lcms_patch/README.md`.
- `profiles/` is **gitignored**. You supply your own licensed copies
  of each profile. `profiles/README.md` lists the canonical sources
  (Adobe, ICC.org, IDEAlliance, ECI, RISO) for each file.
- `stimuli/` is **committed** — the input grids (21³ RGB sweep, 17⁴
  CMYK sweep, Lab sweep, grey sweep, 2C sweep, XYZ sweep) are just
  numerical grids, no IP.
- The harness reports per-profile pass/fail. Profiles you don't have
  are **skipped** (logged, not failed), so CI still runs against
  whatever subset is available.

This is stronger than shipping profiles because it forces each
profile's *version identity* to matter. An accidental swap of one
Adobe RGB revision for another shows up as a ΔE spike in the
comparison, not as silent data churn.

### Trade-off this doesn't resolve: math truth vs ground truth

Open design question (future v1.5 work): **do we preserve
jsColorEngine's full f64 pipeline and accept the small ΔE deltas
against lcms, or add an opt-in `lutMode: 'int-pipeline'` that matches
lcms bit-for-bit by adopting their Q15.16 rounding and 0..2 PCS
scaling?**

- **Math truth** (current default): keep the float pipeline. Our
  numbers are *better* by ΔE; the divergence is legitimate.
  Published reference data matches lcms within a small tolerance
  band, documented per-stage.
- **Ground truth** (optional future mode): match lcms bit-for-bit in
  a dedicated mode. People who calibrate against lcms have 25 years
  of press-conditioned workflows that assume lcms's rounding; for
  them, "mathematically better" is "silently different". A
  `'int-pipeline'` mode that reproduces lcms rounding exactly is
  the audit-trail answer for that audience.

The compat harness naturally supports both: run the endpoint-diff
with the float pipeline to measure "are we close enough?", and (in
v1.5) run a separate suite against `'int-pipeline'` to assert
"bit-exact where it matters." See
[Roadmap § v1.5](../../docs/Roadmap.md#v15-optional--lutmode-int-pipeline--s1516-for-lcms-parity).

## Reference-set coverage

**6 profiles** × **3 directions** × **5 intent/BPC variants** ×
**9261 samples per file** ≈ **1.4 M reference (input, output)
pairs** in 150 `.it8` files.

| Direction | File naming convention | Count |
|---|---|---|
| `profile → Lab`     | `<profile>.icc_to_lab_<intent>[_BPC].it8`     | 50 |
| `profile → sRGB`    | `<profile>.icc_to_srgb_<intent>[_BPC].it8`    | 50 |
| `Lab → profile`     | `lab_to_<profile>.icc_<intent>[_BPC].it8`     | 25 |
| `sRGB → profile`    | `srgb_to_<profile>.icc_<intent>[_BPC].it8`    | 25 |

Intent variants: `Absolute`, `Perceptual`, `Perceptual_BPC`,
`Relative`, `Relative_BPC`. (BPC is only valid for perceptual and
relative colorimetric; Absolute doesn't combine with BPC.)

Profiles covered in the reference set: `AdobeRGB1998`,
`ISOcoated_v2_grey1c_bas`, `RISO_MZ770_Black`, `RISO_MZ770_RedGreen`,
`sRGB_v4_ICC_preference`, `USSheetfedCoated`. This includes both
matrix-shaper RGB (AdobeRGB, sRGB), LUT-based CMYK
(USSheetfedCoated), 1C grey (ISOcoated_v2_grey1c_bas), 1C spot
(RISO_MZ770_Black), and — crucially — **2C spot colour**
(RISO_MZ770_RedGreen). The 2C case is the one that shook out most
bugs during jsColorEngine's original development, because n-channel
profiles below 3 channels are a code-path most CMS implementations
underserve.

Extending the reference set to cover the rest of `profiles/` (22
more profiles at the same coverage matrix) is a v1.3 "regenerate
from lcms fork" task — deterministic from the patch in
`lcms_patch/`.

## Stimuli

Six grid-sweep input files, committed. All use `SAMPLE_ID` as the
first column and the canonical `IN_*` field names that the reference
files pair with.

| File | Shape | Rows | Notes |
|---|---|---|---|
| `rgb_input.it8`  | 21³ RGB sweep             | 9261 | `0..255` integer grid, step 12.75 |
| `cmyk_input.it8` | 17⁴ CMYK sweep            | ~83k | 4D grid, step 16 |
| `lab_input.it8`  | L×a×b sweep               | —    | L 0..100, a/b −128..127 |
| `gray_input.it8` | 1D grey sweep             | —    | 0..255 step 1 |
| `2col_input.it8` | 2C sweep for 2CLR profiles | —   | CH1×CH2 grid |
| `xyz_input.it8`  | XYZ PCS sweep             | —    | for `*xyz` working-space profiles |

## How it works

```bash
# 1. Drop your licensed copies of the profiles into profiles/
#    (see profiles/README.md for where to get each one).

# 2. Run the endpoint-diff harness:
node bench/lcms_compat/run.js
node bench/lcms_compat/run.js --quiet            # summary only
node bench/lcms_compat/run.js --filter Relative  # subset by filename
node bench/lcms_compat/run.js --no-md            # skip last-run.md write

# → reads every reference/*.it8
# → loads matching profile(s) + builds matching Transform
# → runs each stimulus row through jsColorEngine's t.forward()
# → per-row error in destination native units
#     (ΔE76 for Lab outputs, max-abs-channel-delta otherwise)
# → per-file { max, mean, p50, p95, p99, count > tight threshold }
# → in-gamut only — OOG rows are bucketed separately (see below)
# → aggregated rollup by (src → dst) direction
# → writes last-run.md with the full per-file table
```

### Why bit-tight to lcms's float pipeline (NOT u16)

The very first sample in `srgb_virt_to_lab_Relative.it8` reads
`(0,0,0) → (0.0, 0.00000757, 0.00000757)`. A `7.57e-6` Lab a/b residual
is **three orders of magnitude smaller than the smallest non-zero
value representable in `TYPE_Lab_16`** (255/65535 ≈ 4e-3). So the
references were generated by `transicc` with `lIsFloat` — i.e. lcms
running its full f64 pipeline (`cmsCreateTransform(... TYPE_RGB_DBL ...
TYPE_Lab_DBL ...)`). That makes this a **like-for-like full-f64
jsCE-vs-lcms oracle** — any drift we see is a real algorithmic
disagreement, not a quantisation artefact on lcms's side.

### Why OOG samples need a separate bucket

lcms's float pipeline doesn't clamp on output, so for out-of-gamut
conversions it emits unclamped channel values — `Lab(0,−100,−100) →
sRGB` produces `(−602, +50, +149)` in 0..255 RGB units. jsCE's
accuracy path clamps to [0,1] before scaling, so comparing them on
those rows produces meaningless "delta = 602 LSB" noise that would
swamp the in-gamut headline. The harness drops any row where any
reference channel falls outside the device's native range and reports
the OOG count alongside the in-gamut numbers. Lab is conceptually
unbounded so it's never filtered.

### Stage-level diff (planned, v1.3)

```bash
# (Diagnostic, v1.3) Stage-level trace diff for a divergent (profile, intent, sample):
node bench/lcms_compat/diff-stages.js \
     --profile USSheetfedCoated.icc --intent Relative --sample 1234

# → runs the same input through both engines with stage-debug on
# → aligns lcms's -v3 stage trace (from lcms_patch tool) with
#   jsColorEngine's debugInfo() output
# → pinpoints which stage diverged, by how much
```

## Regenerating the oracle (v1.3)

The reference set is pinned to lcms2 2.16 with a known patch. To
regenerate after (say) an lcms bump:

```bash
cd bench/lcms_compat
./fetch-lcms2-instrumented.sh   # downloads lcms2 stable, applies patch
make oracle                      # rebuilds transicc4batch, regenerates reference/
```

This is a deliberate action, not a drive-by — bumping the reference
set is equivalent to rebaselining CI, and should be reviewed.

## Provenance

- Reference `.it8` files originally generated by [@user]'s
  instrumented fork of LittleCMS 2.16, used during jsColorEngine's
  original 2022-2023 development as a manual stage-comparison oracle.
  The 2C spot-colour test cases in particular found several real
  bugs during that phase.
- Relocated into `bench/` in v1.2 prep (from the older
  `speed_tests/testData/`) so the harness is a first-class part of
  the test infrastructure, not a side-folder of old debugging work.
- Stage-level instrumentation in lcms2's `src/cmslut.c` and
  `src/cmsio1.c` is the source-side half of this harness. jsColorEngine
  has its mirror in `new Transform({pipelineDebug: true})` +
  `debugInfo()` — both emit `stageName . . . . : in → out` traces at
  15-digit precision, making stage-by-stage comparison a
  text-diff operation rather than an instrumentation task.
