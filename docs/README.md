# jsColorEngine — Project Summary & Docs Index

> **Purpose:** the jumping-off point for anyone — human or AI — landing
> in this repo cold. Read this, then follow the links you need.
> Regenerate per [`summary-generator.md`](./summary-generator.md).
> Last regenerated: **2026-08-16** (v1.5.0, unreleased).

## Project Overview

jsColorEngine is a zero-dependency ICC colour-management engine in
pure JavaScript (optional inline WASM SIMD for the image hot path).
`Profile` loads/decodes ICC v2+v4 profiles (or synthesises virtual
ones); `Transform` builds a stage pipeline between profiles, optionally
bakes it into a LUT, and dispatches per-dimension tuned kernels —
`transform()` for single colours (full f64 accuracy), `transformArray()`
for images (45–270 MPx/s, single-threaded). Positioning: the fastest
single-threaded colour transforms available in JavaScript — faster than
`lcms-wasm` on every workflow, C-class on one thread — validated for
accuracy against LittleCMS oracles (100 % within 1 LSB on the image
path). The repo is deliberately document-heavy: deep dives record the
journey, including wrong turns, as a resource for like-minded readers.

## Source map (`src/`)

`Transform.js` (~11 k lines — pipeline build, stages, LUT bake) ·
`Profile.js` · `decodeICC.js` · `convert.js` (colour maths) ·
`Spectral.js` · `lutKernelTable.js` (kernel run table) ·
`kernels/{1d,2d,3d,4d,nd}/` (per-dimension kernel descriptors, tuned
loops, `.wat`/WASM) · `main.js` (exports + kernel registration).
**Do not "clean up" the unrolled hot loops** — read the PERFORMANCE
LESSONS block atop Transform.js first.

## Document Index

**Entry points:** [`../README.md`](../README.md) (positioning, features,
speed/accuracy headline) · [`../CHANGELOG.md`](../CHANGELOG.md) ·
[`Roadmap.md`](./Roadmap.md) (future work — the single source of truth
for what's next).

**API reference:** [`Transform.md`](./Transform.md) ·
[`Profile.md`](./Profile.md) · [`Loader.md`](./Loader.md) ·
[`Plugin.md`](./Plugin.md) (custom LUT kernels) ·
[`Examples.md`](./Examples.md).

**Feature notes (as-built):** [`DeviceLink.md`](./DeviceLink.md) ·
[`NChannel.md`](./NChannel.md) (5CLR–15CLR) ·
[`LcmsComparison.md`](./LcmsComparison.md) (the full LittleCMS
comparison — scope, tables, upstream corrections).

**Performance & quality:** [`Performance.md`](./Performance.md)
(measurement retrospective) · [`Bench.md`](./Bench.md) (run it
yourself) · [`deepdive/`](./deepdive/README.md) — its own index covers
Architecture, LutModes, JitInspection, WasmKernels, KernelModules
(kernel architecture as-built), Identity, Accuracy (lcms oracle
methodology), Luts (portable LUT format), CompiledPipeline,
MatrixShaperKernel (POC), benchmark.md ("Schrödinger's Bench") with
[`benchmark_todo.md`](./deepdive/benchmark_todo.md) as the live
worklist, and the MPE / Named-Colour scope decisions.

**Samples:** [`Samples.md`](./Samples.md) ·
[`../samples/README.md`](../samples/README.md) (per-tool folders:
ICCImage, LutBuilder, bench, benchmark).

## Current state (2026-08-16)

- **v1.5.0 committed, not yet released to npm/GitHub.** Ships: kernel
  modules by dimension, DeviceLink, N-channel, v1.5 polish arc
  (identity detection — note the same-profile semantic change —
  validation, plugins), 488 tests green, `npm audit` clean.
- **Upstream review (issue #6, Marti Maria):** our lcms calls and the
  HIGHRESPRECALC oracle were corrected — accuracy *improved* to 100 %
  within 1 LSB; native-C throughput tables are historical pending
  re-run with his corrected harness (link currently dead; re-requested).
  lcms's one-pixel cache measured at 2–5× content sensitivity.
- **In flight:** v1.5.5 (matrix-shaper fast path — WASM POC done at
  250–257 MPx/s — and the one-pixel-cache experiment); the browser
  benchmark framework rewrite (uncommitted, see benchmark_todo.md).

## Global notes

- **Measurement-first:** no perf/accuracy claim without a runnable
  bench or oracle; comparisons are single-threaded, one core vs one
  core; corrections go into the record, not quietly patched.
- **Gates:** full jest suite green + `bench/mpx_summary.js` parity
  before committing kernel-adjacent changes.
- Roadmap holds all future plans; Performance.md holds retrospectives;
  CHANGELOG holds release notes — don't duplicate across them.
