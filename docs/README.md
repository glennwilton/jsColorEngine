# jsColorEngine — Project Summary & Documentation Index

> **Purpose:** the jumping-off point for anyone — human or AI — landing
> in this repo cold: what the project is, and a per-document summary of
> where every piece of context and reasoning lives. Regenerate per
> [`summary-generator.md`](./summary-generator.md).
> Last regenerated: **2026-08-20** (v1.5.5).

## Project Overview

jsColorEngine is a zero-dependency ICC colour-management engine in pure
JavaScript with optional inline WASM SIMD for the image hot path.
`Profile` loads/decodes ICC v2+v4 profiles (or synthesises virtual
ones); `Transform` builds a stage pipeline between profiles, optionally
bakes it into a LUT, and dispatches per-dimension tuned kernels
(`src/kernels/{1d,2d,3d,4d,nd}/`) — `transform()` for single colours at
full f64 accuracy, `transformArray()` for images at ~80–120 MPx/s on
photographs through a LUT and ~330 where the fused matrix-shaper kernel
takes over, one thread; `transformImages()` spreads a batch across a
worker pool (6.2× peak, 787 MPx/s). Positioning: the fastest ICC colour
engine in JavaScript — 3.2–3.6× `lcms-wasm` on every LUT workflow, with
pure JS landing within 0.78–1.08× of single-threaded native C —
accuracy-validated against LittleCMS oracles (100 % within 1 LSB on the
image path). The repo is deliberately
document-heavy: the docs record the journey — measurements, design
reasoning, and wrong turns — not just the API.

**Current state (2026-08-20):** v1.5.5 — the **matrix-shaper WASM
kernel** (four binaries, int8 + int16, five alpha entry points,
registered as a *claiming* kernel selected by pipeline shape rather than
channel count) and **multicore** (`transformImages()`, a fragment queue
across a persistent worker pool, with per-image callbacks, cancellation
and backpressure). Both shipped. Also: `Transform.compatibility()` for
pinning older defaults, `src/settings.js` for host-level configuration,
`src/alpha.js` for premultiply/flatten. 794 tests, audit clean.

Carried into v1.6: the **in-kernel pixel cache** (prototyped, measured,
paired exports built — needs a dispatcher change and regenerated
binaries), a **Web Worker pool for browsers** (the blocker is packaging,
not threading), and a **full benchmark rebuild** — at which point every
throughput figure in these docs is re-measured together.

The LittleCMS comparison has been **fully re-measured** and is complete
in `docs/LcmsComparison.md`: corrected inputs, one process per
measurement, lcms given its best compiler flags per workflow, and CLUT
coverage reported beside adjacency on every row. Reproduce the whole
thing with `node bench/reproduce.js`. Four measurement problems that moved
figures on that page are documented there, three of which had been
running in our favour.

The measurement work also produced findings that change how the engine
should be *measured* rather than anything about the engine itself —
coverage vs access ordering, and noise as the great equaliser. Those are
`deepdive/benchmark.md` §§20–21, and they are the brief for the browser
bench rebuild.

**Measured and deliberately not built:** `SharedArrayBuffer` delivery to
the workers. Projected at +30 %, a spike measured 5–13 % — the pool's
copies are largely interleaved with worker execution, so removing them
frees time that was already hidden. Written up in
`deepdive/multicore.md` rather than shipped.

## Documentation index — `docs/`

### Bench.md
Guide to the in-browser benchmark (`samples/bench/`): the five tabs,
methodology notes, DevTools warnings, LUT-shape inspection, and the
submission template for reporting your own numbers. The canonical way
to reproduce the README's MPx/s claims.

### DeviceLink.md
As-built implementation notes for DeviceLink (`pClass:'link'`) support:
usage (`t.create(dl)` alone, header intent), how loading resolves
input/output spaces, the full v2/v4 element-structure pipeline walk,
two ICC spec subtleties (curves-only mAB, mft matrix gating), and the
self-validating test fixtures.

### Examples.md
Working recipes beyond the README quick start: canvas
read-modify-write, custom pipeline stages at PCS, multi-stage chains,
and other integration patterns.

### LcmsComparison.md
Accuracy and speed against LittleCMS as the goalpost, across three
engines: jsColorEngine, `lcms-wasm`, and native C. Carries the v1.5
position (100 % within 1 LSB; ~2× native C on LUT workflows, 0.72× on
matrix-shaper), the content/coverage analysis that shows throughput
tracks CLUT locality rather than adjacency, and four documented
corrections to our own measurements. Read this before touching any
performance claim.

### Loader.md
API for the optional batch profile loader — loading several profiles
with one callback.

### NChannel.md
As-built implementation notes for N-channel (5CLR–15CLR) profiles: both
directions, the input-side LUT-decline policy (`grid^N` memory table),
accepted input formats, the latent interpolator clamp bug it exposed,
and validation status (physical-sanity tests pending lcms oracle
numbers).

### Performance.md
The measurement retrospective — version by version: kernel evolution
(float → int → WASM → SIMD → 16-bit), lcms comparisons, ARM64/Apple
Silicon results, the discoveries and dead ends. Historical record;
current comparison status lives in LcmsComparison.md.

### Plugin.md
Registering custom LUT kernels under a custom `lutMode`: the exact run
signature contract, resolution order vs built-ins, and isolation
guarantees between Transforms.

### Profile.md
`Profile` class API: loading from file/URL/base64/binary, virtual
profiles vs real ICC (and when each is right), properties, deprecated
names, environment backends.

### Roadmap.md
Single source of truth for future work, ordered by leverage: v1.5.5
(shipped — matrix-shaper kernel + multicore), v1.6 (QC/profile oracle,
browser worker pool, in-kernel pixel cache, and a generated home for
benchmark numbers), v1.7 (compiled pipeline / `toModule()`), v2
(package split);
plus shipped-so-far summaries and explicitly-dropped ideas with
reasons.

### Samples.md
Live demo index (video soft-proof, image soft-proof, lcms comparison)
and local setup instructions.

### summary-generator.md
Instructions for regenerating this index file — output path, structure,
and the per-repo adaptations.

### Transform.md
`Transform` class API: constructor options (including `wasmMatrixShaper`
and `multicore`), `create` / `createMultiStage`, DeviceLink + N-channel
usage, custom stages, gamut warning modes, `lutMode` kernel selector,
`transformImages()` and pool control, `kernelInfo()`,
`Transform.compatibility()`, WASM memory management, portable LUT JSON,
and contributor notes for the hot loops.

### BenchResults.md
**Generated, never hand-edited.** Every benchmark table the project quotes,
written by the bench that measured it and rendered by
`scripts/build_bench_results.js`: conditions, the engine version each table was
measured against (so a stale one says so), and a citation index of which
document links to which table. Refresh with `node bench/reproduce.js` then
`node scripts/build_bench_results.js`.

### pool.md
The batch and worker-pool reference for `transformImages()`: the images
array and what may be hung on it, the `onImage` callback shape, alpha
handling (including per-image overrides), cancellation, byte-based
backpressure, environment-driven sizing, the sequential-fallback
contract, and what the pool costs. Useful without a pool at all — the
same API is the batch converter.

## Deep dives — `docs/deepdive/`

### deepdive/README.md
Index of this folder with a "shallow dive" TL;DR of the four
counter-intuitive findings, plus external learning links (lcms, ICC
specs, CIE, WASM SIMD).

### deepdive/Accuracy.md
Float-pipeline validation against an lcms2 f64 oracle: methodology (150
CGATS reference files), headline numbers, the one diagnosed outlier
(grey-1c Perceptual), and where jsCE deliberately diverges from lcms.
The image-path oracle methodology lives in
`bench/lcms-comparison/README.md`.

### deepdive/Architecture.md
The pipeline model: how a profile becomes stages, stages become a LUT,
and a LUT becomes a kernel; the accuracy-path vs image-path split and
the anti-patterns that mix them.

### deepdive/benchmark.md
How to measure a colour engine without fooling yourself — the longest
running thread in the repo. The "1.7× mystery" and **Schrödinger's
Bench** (a shared harness changes what it measures); then §20, the two
ways a degenerate input lied (256 distinct colours at 0 % adjacency) and
why CLUT coverage must be reported beside it; then §21, **noise as the
great equaliser** — 2–5 % noise collapses every content class onto the
same figure, which is where the old 210 MPx/s claim came from and why it
was real but narrow. Read before designing any new bench.

### deepdive/benchmark_todo.md
Live worklist for the new browser benchmark framework
(`samples/benchmark/`): lcms group wiring, scenario codegen,
`new Function` runner experiment. Written as pick-up notes for a future
session.

### deepdive/CompiledPipeline.md
The `compile()` POC: emitting the no-LUT pipeline as straight-line JS
(~5× over the runtime stage walker), measurement methods, and the
`getSource()` / `toModule()` distribution story targeted at v1.7.

### deepdive/Identity.md
Identity / NOP detection: profile-equality strategies (binary hash,
virtual name, matrix compare), chain collapse, the `_kernelCopy` path,
and the as-built `transformArrayFn` binding.

### deepdive/JitInspection.md
V8 emitted-assembly walkthroughs of the hot kernels: instruction mix,
working-set size, the "named temps" micro-test, why the counter-intuitive
code is the fast code, and the register-pressure prediction that ARM64
later confirmed.

### deepdive/KernelModules.md
The kernel-module architecture as built (shipped v1.5.0): descriptor
registration, per-Transform instances, create-time run resolution
(`_runBig`/`_runSmall`), `provideLut()` contract, plugin coexistence,
V8 dispatch analysis, migration history.

### deepdive/LutModes.md
The `lutMode` ladder explained: what `float` / `int` /
`int-wasm-scalar` / `int-wasm-simd` each are, when `'auto'` picks what,
and how bit-exactness across the ladder is maintained.

### deepdive/Luts.md
Portable LUT deep dive: the JSON wire format spec, FNV-1a content
signatures, lcms-emulation bakes, the TIFF visual-editing architecture,
and the design reasoning behind CMS-agnostic LUT capture.

### deepdive/MatrixShaperKernel.md
The matrix-shaper WASM kernel, shipped in v1.5.5: what the optimiser
already folds and why the kernel only has to run it, four binaries with
five alpha entry points each, the quartic output-table index that makes
int16 viable, and the accuracy case — 331 MPx/s on photographs against
~123 for the CLUT, *and* within 1 LSB where that CLUT reaches 25. Also
how it scales in the pool, where the faster kernel necessarily scales
worse.

### deepdive/SyntheticProfiles.md
Testing what you cannot buy. Real ICC profiles are licensed, so this repo
ships two — which left `Kernel1D`, `Kernel2D` and `KernelND` with no
oracle at all, checkable only against themselves. A profile the engine
WRITES has no licensing question, so `src/encodeICC.js` makes them: gray
and 2CLR-10CLR, committed, handed to Little CMS. `Kernel2D` agrees bit
for bit; gray lands 100% within 1 LSB. Records the three bugs the oracle
found on its first runs (`transformArray()` returning `undefined` for
every input above 4 channels, silently), the noise-versus-smooth mistake
that reported max 144 LSB on a working engine, why `toICC()` REFUSES to
write RGB, and why the n-channel interpolator changed to match lcms while
the old one is kept behind a toggle with the numbers that retired it.

### deepdive/PixelCache.md
The pixel cache: design space, as-built notes for the accuracy-path
implementation (`src/cache.js`, opt-in via `pixelCache`), and measured
hit rates by content class — photographs 3–41 % (break-even at best),
flat graphic content 67 %+ (1.2–3.2×). Records the three things building
it changed about the design (boundary detection, hash scaling,
`transformArray`), why the SIMD exclusion did not survive measurement —
the lanes are channels, not pixels — and two properties of a test set
that briefly reversed the conclusion: the bundled samples are
AI-adjusted rather than shot, and capping pixel count crops the top of a
frame instead of sampling it. The in-kernel version is built and
measured behind paired exports, carried to v1.6.

### deepdive/multicore.md
The worker pool, in the order the work happened: the two candidate
models, the POC that ruled out `SharedArrayBuffer` before any of it was
built, what shipped in v1.5.5 (a fragment queue a persistent pool pulls
from, out of order, across many images), and the shipped pool measured
across content, workers and kernels — 6.2× peak, 787 MPx/s,
byte-identical in all 72 cells. Also what it costs: per-worker LUT
copies, and efficiency that falls as the kernel gets faster.

### deepdive/multiProcessElements.md
Why `mpet` / `DToB`/`BToD` tags are not decoded: spec-mandated fallback
to AToB/BToA, near-zero real-world prevalence, iccMAX context.

### deepdive/namedColorProfiles.md
Why `ncl2` (Named Colour) profiles are out of transform scope: they're
lookup tables without a pipeline, and real spot-colour workflows live
elsewhere (RIP databases, PANTONE libraries, CxF/X-4).

### deepdive/WasmKernels.md
The hand-written `.wat` kernels: SIMD channel-parallel layout,
`v128.load64_zero` gather trick, the V8 inliner lesson, memory
management, and reproduction recipes.

## Beyond `docs/`

[`../README.md`](../README.md) — positioning, features, headline
numbers · [`../CHANGELOG.md`](../CHANGELOG.md) — release notes
(`[1.5.0]` latest) · [`../CLAUDE.md`](../CLAUDE.md) — AI session entry
rules · [`../samples/README.md`](../samples/README.md) — samples index
(per-tool folders) · `samples/LutBuilder/lutbuilder.md` — LutBuilder
user guide · `samples/ICCImage/ICCImage.md` — ICCImage API ·
`bench/lcms-comparison/README.md` — lcms-wasm speed+accuracy harness
(image-path oracle methodology) · `bench/lcms_c/README.md` — native
lcms2 harness (build, runtime knobs, content generators).

## Global notes

- **Measurement-first:** no perf/accuracy claim without a runnable
  bench or oracle; comparisons are single-threaded, one core vs one
  core; corrections go into the record, not quietly patched.
- **Never "clean up" the unrolled kernel loops** — read the
  PERFORMANCE LESSONS block atop `src/Transform.js` first, and
  benchmark before/after.
- **Gates:** full jest suite green + `bench/mpx_summary.js` parity
  before committing kernel-adjacent changes.
- Doc ownership: future plans → Roadmap.md; measurement retrospectives
  → Performance.md; release notes → CHANGELOG.md. Don't duplicate.
