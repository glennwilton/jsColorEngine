# jsColorEngine — Project Summary & Documentation Index

> **Purpose:** the jumping-off point for anyone — human or AI — landing
> in this repo cold: what the project is, and a per-document summary of
> where every piece of context and reasoning lives. Regenerate per
> [`summary-generator.md`](./summary-generator.md).
> Last regenerated: **2026-08-16** (v1.5.0, unreleased).

## Project Overview

jsColorEngine is a zero-dependency ICC colour-management engine in pure
JavaScript with optional inline WASM SIMD for the image hot path.
`Profile` loads/decodes ICC v2+v4 profiles (or synthesises virtual
ones); `Transform` builds a stage pipeline between profiles, optionally
bakes it into a LUT, and dispatches per-dimension tuned kernels
(`src/kernels/{1d,2d,3d,4d,nd}/`) — `transform()` for single colours at
full f64 accuracy, `transformArray()` for images at 45–270 MPx/s on one
thread. Positioning: the fastest single-threaded colour transforms in
JavaScript — faster than `lcms-wasm` on every workflow, native-C-class
on one thread — accuracy-validated against LittleCMS oracles (100 %
within 1 LSB on the image path). The repo is deliberately
document-heavy: the docs record the journey — measurements, design
reasoning, and wrong turns — not just the API.

**Current state (2026-08-16):** v1.5.0 committed but not yet released
(kernel modules, DeviceLink, N-channel, v1.5 polish arc; 488 tests,
audit clean). Native-lcms throughput tables are historical pending a
re-run with upstream-corrected calls (issue #6, Marti Maria). v1.5.5
groundwork landed: Transform.js split — `stage_*` functions now in
`src/stages.js`, single-colour interpolators in `src/interp.js`, both
still `Transform.prototype` methods (verbatim move, parity-benched).
In flight: v1.5.5 (matrix-shaper kernel, one-pixel-cache experiment)
and the browser benchmark framework rewrite (uncommitted).

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
The full LittleCMS comparison and its history: single-threaded scope,
lcms-wasm results (the headline claim), the native-C harness marked
historical after upstream review, measured input-content sensitivity
(lcms's one-pixel cache: 2–5×), and the specialisation story. Read this
before touching any performance claim.

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
(matrix-shaper fast path + pixel-cache experiment), v1.6 (QC/profile
oracle), v1.7 (compiled pipeline / `toModule()`), v2 (package split);
plus shipped-so-far summaries and explicitly-dropped ideas with
reasons.

### Samples.md
Live demo index (video soft-proof, image soft-proof, lcms comparison)
and local setup instructions.

### summary-generator.md
Instructions for regenerating this index file — output path, structure,
and the per-repo adaptations.

### Transform.md
`Transform` class API: constructor options, `create` /
`createMultiStage`, DeviceLink + N-channel usage, custom stages, gamut
warning modes, `lutMode` kernel selector, WASM memory management,
portable LUT JSON, and contributor notes for the hot loops.

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
The "1.7× mystery" investigation: why the same kernel measured 100 vs
200 MPx/s — V8 call-site polymorphism, inlining, and the named
principle **Schrödinger's Bench** (a shared benchmark harness changes
what it measures). Patterns/anti-patterns for app developers.

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
The matrix-shaper WASM kernel POC: five design generations from 52 to
257 MPx/s, the final bytes-as-indices f32x4 design, and why it beats
the CLUT kernel on RGB→RGB. Integration pending (v1.5.5).

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
