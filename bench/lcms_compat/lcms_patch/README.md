# `lcms_patch/` — stage-level instrumentation for lcms2

**Status: placeholder — populated in v1.3.**

This directory will hold the stage-level instrumentation patch for
LittleCMS 2.16 that produced the reference `.it8` files in
`../reference/`. The patch adds per-stage `printf` calls to lcms's
pipeline evaluator so that an `-v3`-level run emits a
`IN / Stage / Stage / OUTPUT` trace at 15-digit precision — the
source-side half of jsColorEngine's compatibility harness.

## What the patch instruments

Touches two files in stock lcms2 2.16:

### `src/cmslut.c` — pipeline stage evaluators

Adds `printf` instrumentation to each per-pixel stage:

- `EvaluateCurves(In[], Out[], mpe)` — prints `(in) -> (out)` for
  the tone-curve stage
- `EvaluateMatrix(In[], Out[], mpe)` — prints the 3×3 (or 3×4)
  matrix, each input, and each output-row-dot-product line by line
- `EvaluateCLUTfloatIn16(In[], Out[], mpe)` — prints the
  float→u16 / interp / u16→float phases of the CLUT
- `EvaluateLab2XYZ(In[], Out[], mpe)` — prints Lab and XYZ
- `EvaluateXYZ2Lab(In[], Out[], mpe)` — prints XYZ and Lab

Plus pipeline-driver wrapping (around `cmsPipelineEval`):

```c
printf("IN (");
for (i = 0; i < nChannels; i++) printf("%f ", In[i]);
printf(")\n");
// ... stages run, each emits its own trace ...
printf("  Last Stage was %d\n\n", stageCount);
printf("OUTPUT = (");
for (i = 0; i < nOutChannels; i++) printf("%f, ", Out[i]);
printf(")\n");
```

### `src/cmsio1.c` — profile-time matrix construction

Adds `printf` calls to `BuildRGBInputMatrixShaper` and the output
variant, which print the RGB→XYZ matrix **both unscaled (textbook
values) and scaled (lcms's internal `/2` convention for PCS XYZ 0..2
domain).** The unscaled/scaled pair is what surfaces the
*PCS-XYZ-scaling convention mismatch* between lcms (0..2) and
jsColorEngine (0..1) — a subtle-but-critical difference that's
invisible without this dump.

## Why we're shipping the patch, not the full lcms tree

The original instrumented tree lived at
`bench/lcms_exposed/lcms2-2.16/` — the full vendored lcms source.
That tree is ~30 MB and has its own upstream; committing it to git
would bloat the repo and create a stale fork the moment lcms2.17 /
2.18 / etc. ships.

Instead (pattern lifted from `bench/lcms_c/`):

1. `fetch-lcms2-instrumented.sh` / `.ps1` downloads stock lcms2
   from the GitHub release tarball
2. Applies `01-stage-prints.patch` against the stock tree
3. Builds `transicc4batch` (a batch-mode fork of lcms's `transicc`
   that reads/writes CGATS `.it8` files — necessary because stock
   `transicc` is interactive-only)
4. Runs the whole 6-profile × 3-direction × 5-intent matrix to
   regenerate `../reference/` deterministically

This keeps the repo lean, makes the patch auditable as a diff
rather than a hidden fork, and pins the oracle to a specific lcms
version explicitly.

## Planned contents (v1.3)

```
lcms_patch/
├── 01-stage-prints.patch       # diff against stock lcms2-2.16
├── 02-transicc4batch.patch     # batch-mode .it8 I/O for transicc
├── fetch-lcms2-instrumented.sh # download + apply + build (POSIX)
├── fetch-lcms2-instrumented.ps1# same, Windows / MinGW-w64
├── regenerate-oracle.sh        # wrapper that drives transicc4batch
│                                 over profiles/ + stimuli/
├── regenerate-oracle.ps1
├── profile-hashes.json         # sha256 per profile at oracle-build time
└── README.md                   # this file
```

The existing instrumented tree at `bench/lcms_exposed/lcms2-2.16/`
stays in place (untracked) until v1.3 kick-off; at that point the
patch gets extracted from it and the tree gets deleted.

## Extraction command (when v1.3 starts)

Rough plan:

```bash
# In v1.3 kick-off:
cd bench/lcms_compat/lcms_patch

# Download clean reference:
curl -L https://github.com/mm2/Little-CMS/archive/refs/tags/lcms2.16.tar.gz \
     -o lcms2-clean.tar.gz
tar xf lcms2-clean.tar.gz

# Diff against the instrumented tree:
diff -ruN Little-CMS-lcms2.16/src \
          ../../lcms_exposed/lcms2-2.16/src \
          > 01-stage-prints.patch

# Verify it's minimal (only printf adds, no accidental behaviour changes):
grep -cE '^\+' 01-stage-prints.patch   # expect ~50 lines of +
grep -cE '^-[^-]' 01-stage-prints.patch # expect very few - lines

# Test round-trip:
tar xf lcms2-clean.tar.gz -C /tmp/
cd /tmp/Little-CMS-lcms2.16
patch -p1 < /path/to/01-stage-prints.patch
# Build + diff transicc output against existing reference/ — should
# be byte-identical (if not, the patch has acquired drift).
```

Once that verification round-trip succeeds, the instrumented tree in
`bench/lcms_exposed/` can be deleted.
