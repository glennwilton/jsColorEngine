# `bench/` — Node and C harness inventory

This folder is the **Node / native-C** side of measurement. The
**in-browser** bench lives in [`samples/bench/`](../samples/bench/) and
is documented in [`docs/Bench.md`](../docs/Bench.md). Current numbers
live in [`docs/BenchResults.md`](../docs/BenchResults.md). LittleCMS
comparison write-up: [`docs/LcmsComparison.md`](../docs/LcmsComparison.md).
Measurement retrospective: [`docs/deepdive/Performance.md`](../docs/deepdive/Performance.md).
Plans stay in [`docs/Roadmap.md`](../docs/Roadmap.md).

Do not quote a one-off in this folder as a published figure. Gate
throughput against the pin in [`baseline/`](./baseline/), not against
"the last run."

**Labels.** **Gate** — commit / reproduce / pin. **Manual probe** —
still useful, not a gate. **History** — kept for the record; do not
quote.

---

## Headline / gate

- [`reproduce.js`](./reproduce.js) — **Gate.** One command that
  regenerates the LcmsComparison session: corpus, image-path accuracy,
  optional native CFLAGS sweep, native content matrix, JS + lcms-wasm
  matrix, matrix-shaper, pool, pixel-cache, 1-/2-channel, solo.
  `node bench/reproduce.js` (add `--quick`, `--only js,solo`,
  `--skip-native`, or `--with-flags`). Writes
  `bench/results/<timestamp>/`. On Windows, start WSL first if you want
  the native phase.

- [`mpx_summary.js`](./mpx_summary.js) — **Gate.** jsColorEngine
  alone: non-LUT / `float` / `int` on GRACoL, photo with 5 % noise
  added via
  [`lib/benchContent.cjs`](./lib/benchContent.cjs). The CLAUDE.md
  throughput-parity check. `node bench/mpx_summary.js`.

- [`baseline/`](./baseline/) — **Gate (the pin).** Fixed measured run
  for `scripts/bench_compare.js`. Not "vs last run." See
  [`baseline/README.md`](./baseline/README.md).

- [`solo_photo/`](./solo_photo/) — **Gate** (reproduce `solo` phase).
  One photograph, one engine, one process — the control that the
  release matrix is not distorting its own figures. See
  [`solo_photo/README.md`](./solo_photo/README.md).
  `node bench/solo_photo/solo.js`.

- [`history/`](./history/) — **History.** Per-release snapshots written
  by `npm run release-snapshot`. The folder may be empty until the next
  snapshot. See [`history/README.md`](./history/README.md).

---

## Accuracy / oracle vs LittleCMS

Native C in this repo is the **throughput** goalpost (and the content
matrix). It is **not** an IT8 writer. The image-path oracle CI actually
runs is **lcms-wasm**. A native-C colour oracle is the longer-term
target; it is not implemented here. The float-pipeline oracle is
[`lcms_compat/`](./lcms_compat/) against locally generated CGATS
references.

- [`lcms-comparison/`](./lcms-comparison/) — **Manual probe**
  (accuracy.js is a reproduce phase). Self-contained `lcms-wasm`
  package: speed (`bench.js`) and 8-bit image-path accuracy
  (`accuracy.js`) on RGB/CMYK. See
  [`lcms-comparison/README.md`](./lcms-comparison/README.md).
  `cd bench/lcms-comparison && npm install && node accuracy.js`.

- [`lcms-comparison/accuracy_gray.js`](./lcms-comparison/accuracy_gray.js)
  — **Manual probe.** First LittleCMS oracle for Kernel1D, using
  committed synthetic gray profiles from
  `node scripts/make_test_profiles.js`.
  `cd bench/lcms-comparison && node accuracy_gray.js`.

- [`lcms-comparison/accuracy_nchannel.js`](./lcms-comparison/accuracy_nchannel.js)
  — **Manual probe.** First LittleCMS oracle for Kernel2D / KernelND
  (2 and 5–15 channels) on the same synthetic ICC set. Smooth CLUTs
  on purpose — noise tables measure scheme difference, not bugs.
  `cd bench/lcms-comparison && node accuracy_nchannel.js`.

- [`lcms-comparison/accuracy_b2a.js`](./lcms-comparison/accuracy_b2a.js)
  — **Manual probe.** PCS→device (B2A): 3-D in, wide n-channel out
  (Kernel3D `*_3_n` runs), sRGB in so Lab encoding stays inside each
  engine. `cd bench/lcms-comparison && node accuracy_b2a.js`.

- [`lcms-comparison/smoke.js`](./lcms-comparison/smoke.js) — **Manual
  probe.** Loads lcms-wasm + GRACoL and prints a few pixels. Run
  before spinning up `bench.js`.

- [`lcms_c/`](./lcms_c/) — **Gate** for the content-matrix binary
  (reproduce `native` / `flags`); the rest is **manual probe**.
  Native lcms2 throughput only. See [`lcms_c/README.md`](./lcms_c/README.md).
  Fetch once (`./fetch-lcms2.sh` or `.\fetch-lcms2.ps1`), then
  `make` / `make steelman` / `make fastfloat`.

  - [`bench_content_matrix.c`](./lcms_c/bench_content_matrix.c) —
    the release comparison: content × cache × size, six workflows.
    What `reproduce.js` builds and runs (`taskset -c 0`).
  - [`bench_lcms.c`](./lcms_c/bench_lcms.c) — original four-workflow
    harness (`make` default `./bench_lcms`). Still useful; not the
    LcmsComparison driver.
  - [`flag_sweep.sh`](./lcms_c/flag_sweep.sh) — pick CFLAGS on this
    machine before quoting native numbers. Opt-in via
    `node bench/reproduce.js --with-flags`.
  - [`bench_marti.c`](./lcms_c/bench_marti.c) — **History.** A
    four-workflow variant whose input is 16×16 colour blocks (Marti's
    generator). Not a Makefile target and not called by `reproduce.js`.
    The file header still says `bench_lcms.c`.

- [`lcms_compat/`](./lcms_compat/) — **Manual probe** (float-pipeline
  oracle). Endpoint-diff against CGATS `.it8` references; per-pixel
  stage triage. Needs local licensed profiles and a locally generated
  `reference/` tree — neither is committed. The regenerator /
  `lcms_patch/` is still a placeholder. See
  [`lcms_compat/README.md`](./lcms_compat/README.md).
  `node bench/lcms_compat/run.js` ·
  `node bench/lcms_compat/probe-pixel.js --src "*sRGB" --dst …`.

- [`int16_identity.js`](./int16_identity.js) — **Gate** (accuracy).
  Synthetic identity CLUT through all four JS u16 kernels; exits
  non-zero if scale or Q0.13 weights regress.
  `node bench/int16_identity.js`.

---

## Content / release matrix

- [`release_matrix/`](./release_matrix/) — **Gate** (reproduce `corpus`,
  `js`, `pixelcache`). Three engines on the same bytes: jsCE, lcms-wasm,
  native C (via `lcms_c/bench_content_matrix.c`). See
  [`release_matrix/README.md`](./release_matrix/README.md).
  `node bench/release_matrix/make_corpus.cjs` then
  `cd bench/release_matrix && npm install && node run.js --isolate --sizes 1048576`.

- [`release_matrix/plot_noise_curve.cjs`](./release_matrix/plot_noise_curve.cjs)
  / [`plot_noise_bases.cjs`](./release_matrix/plot_noise_bases.cjs) —
  **Manual probe.** Turn `noisy:<base>:<n>` sweeps into the SVGs under
  `docs/deepdive/images/`.

- [`lib/benchContent.cjs`](./lib/benchContent.cjs) — Node copy of
  `samples/bench/content.js` (same kinds, same strawberries JPEG).
  Keep the two in lockstep.

- [`lib/emit.cjs`](./lib/emit.cjs) — benches write structured JSON when
  `JSCE_BENCH_JSON` is set; `scripts/build_bench_results.js` renders
  it. Silent no-op otherwise.

---

## Pixel cache

- [`release_matrix/run.js --pixelcache`](./release_matrix/run.js) —
  **Gate** (reproduce `pixelcache`). Accuracy-path 0 / 1 / 32 **and**
  in-kernel WASM `0` vs `'auto'` (`int-wasm-simd` `array()`). Emits
  `pixelCache.accuracyPath.*` and `pixelCache.inKernel.*`.
  `node bench/release_matrix/run.js --pixelcache --sizes 262144`
  or `--pixelcache-inkernel` for the image path only.

- [`pixel_cache/`](./pixel_cache/) — **Manual probe** (`verify_cache.js`
  can gate a release). Accuracy-path cache worth, plus n-channel
  break-even, plus byte-identical verify. See
  [`pixel_cache/README.md`](./pixel_cache/README.md).
  `node bench/pixel_cache/cache_bench.js` ·
  `node bench/pixel_cache/nchannel_bench.js` ·
  `node bench/pixel_cache/verify_cache.js`.

- [`pixel_cache_kernel_poc/`](./pixel_cache_kernel_poc/) — **History.**
  Does a cache pay *inside* a JS unrolled kernel (DeviceLink CMYK→CMYK)?
  See [`pixel_cache_kernel_poc/README.md`](./pixel_cache_kernel_poc/README.md).
  `node bench/pixel_cache_kernel_poc/poc.js`.

- [`pixel_cache_wasm/`](./pixel_cache_wasm/) — **Manual probe.**
  Hash-table variants of the in-kernel WASM cache (POC only).
  Shipped tetra `*.wasm.js` already export `interp_*` plus a
  single-entry `interp_*_cached`; `create()` binds `_cached` when
  `pixelCache !== 0` (including `'auto'`). Compile path:
  `scripts/compile_kernel_wat.js` (injects the single-entry twin).
  `bench/wasm_poc/compile_wasm.js` is superseded. Write-up:
  [`docs/deepdive/PixelCache.md`](../docs/deepdive/PixelCache.md).

  - `hitrate.js` — hit rate only (property of the image).
    `node bench/pixel_cache_wasm/hitrate.js`.
  - `build.js` / `build_simd.js` — inject a runtime-mode cache into
    tetra3d scalar / SIMD `.wat`.
  - `run.js` — throughput after `build.js` (toggle tax vs win).
  - `build_paired.js` — one module, uncached + cached exports, no
    runtime mode. `node bench/pixel_cache_wasm/build_paired.js`.
  - `run_paired.js` — early 3-D paired control (shipped / paired /
    cached must tie on the control).
  - `run_paired_3d.js` / `run_paired_4d.js` / `run_paired_56.js` —
    shipped vs paired vs single-entry vs table-N for 3-D, 4-D, and
    5/6-D. `node bench/pixel_cache_wasm/run_paired_3d.js`.
  - `uniform.js` — would a "four pixels in the SIMD batch are the
    same" test replace a cache on flat content?
  - `vector_repeat.js` — single-entry cache keyed on the SIMD
    register, not the pixel.

---

## N-channel / small-dimension / matrix map

Synthetic ICC files (`__tests__/profiles/synthetic_*ch.icc`) come from
`node scripts/make_test_profiles.js`. See
[`docs/deepdive/SyntheticProfiles.md`](../docs/deepdive/SyntheticProfiles.md)
and [`docs/NChannel.md`](../docs/NChannel.md).

- [`channel_matrix/run.js`](./channel_matrix/run.js) — **Manual probe.**
  Throughput map: every input width 1–15 into every output width. Not a
  gate; it shows where the cliffs are (CLUT / 5–6 WASM / KernelND walk).
  `node bench/channel_matrix/run.js`. Writes
  `bench/channel_matrix/channel-matrix.json`.

- [`nch_56/run.js`](./nch_56/run.js) — **Manual probe.** 5CLR / 6CLR
  int8 JS vs int8 WASM scalar (photo RGB + extras + 5 % grain). Answers
  whether those kernels are worth an int16 clone.
  `node bench/nch_56/run.js`.

- [`small_dim/run.js`](./small_dim/run.js) — **Gate** (reproduce
  `smalldim`). Kernel1D / Kernel2D on synthetic LUTs — no gray/duotone
  ICC in-tree. `node bench/small_dim/run.js`.

---

## Matrix-shaper

- [`matrix_shaper_kernel/`](./matrix_shaper_kernel/) — **Gate** for
  `throughput.js` / `accuracy.js` / `multicore.js` (reproduce `matrix`
  and part of `pool`). Shipped fused kernel vs CLUT and vs the exact
  pipeline.

  - `throughput.js` — SIMD / scalar / CLUT / raw pipeline × solid /
    noise / photo. `node --max-old-space-size=8192 bench/matrix_shaper_kernel/throughput.js`.
  - `accuracy.js` — kernel and CLUT against the stage pipeline, int8
    or int16. `node --max-old-space-size=6144 bench/matrix_shaper_kernel/accuracy.js 8`.
  - `multicore.js` — does the faster kernel scale worse in the pool?
    `node bench/matrix_shaper_kernel/multicore.js`.
  - `multicore_js.js` — **Manual probe.** WASM SIMD vs plain JS in
    the pool. `node --max-old-space-size=8192 bench/matrix_shaper_kernel/multicore_js.js`.
  - `overhead.js` — **Manual probe.** Fragment-size sweep and serial
    fraction. `node --max-old-space-size=8192 bench/matrix_shaper_kernel/overhead.js`.

- [`js_matrix_shaper/run.js`](./js_matrix_shaper/run.js) — **Manual
  probe.** Which pure-JS matrix-shaper shape wins, sitting between the
  WASM kernel and the generic pipeline.
  `node bench/js_matrix_shaper/run.js`.

- [`matrix_shaper_poc/`](./matrix_shaper_poc/) — **History.** Pre-ship
  dynamic WASM kernel (scalar + SIMD). The shipped kernel replaced it.
  `node bench/matrix_shaper_poc/bench_matrix_shaper.js`. Browser page:
  `node bench/matrix_shaper_poc/prebuild.js` then open
  `bench_browser.html` via `node samples/serve.js`.

---

## Pool / multicore

- [`multicore_matrix/run.js`](./multicore_matrix/run.js) — **Gate**
  (reproduce `pool`). Content × workers × kernel; sequential
  `transformArray()` is the baseline; every cell is byte-checked.
  `node bench/multicore_matrix/run.js --isolate`.

- [`multicore_poc/`](./multicore_poc/) — **History.** Transfer-model
  experiment that decided the pool shape (public API only). See
  [`multicore_poc/README.md`](./multicore_poc/README.md).
  `node bench/multicore_poc/run.js`. Companions:
  `batch_barrier.js` (per-image join vs merged queue),
  `task_overhead.js` (cost of one task),
  `autotune.js` (one-second slice-size calibration).

- [`sab_spike/`](./sab_spike/) — **History.** SharedArrayBuffer vs
  transfer copies on the real matrix-shaper kernel. Measured, not
  shipped. `node --max-old-space-size=8192 bench/sab_spike/run.js`.
  Write-up: [`docs/deepdive/multicore.md`](../docs/deepdive/multicore.md).

---

## WASM / int16 POCs

- [`wasm_poc/`](./wasm_poc/) — **History.** The 1-D LERP POC that
  decided WASM scalar vs SIMD-with-gather, plus later tetrahedral
  wiring benches. See [`wasm_poc/README.md`](./wasm_poc/README.md).
  Shipping kernels now live under `src/kernels/`; compile with
  `node scripts/compile_kernel_wat.js`, not the old
  `compile_wasm.js` (that script still points at `src/wasm/`).

  - `run.js` — 1-D LERP: JS vs WASM scalar vs SIMD gather vs no-LUT
    SIMD. `node bench/wasm_poc/run.js`.
  - `tetra3d_run.js` / `tetra3d_simd_run.js` /
    `tetra4d_nch_run.js` / `tetra4d_simd_run.js` — JS vs WASM
    scalar vs SIMD, bit-exact required.
  - `tetra3d_int16_run.js` / `tetra4d_int16_run.js` — u16 I/O
    scalar WASM vs JS, bit-exact + speed.
  - `dispatch_smoke.js` — early `lutMode: 'int-wasm-scalar'`
    dispatcher check on a synthetic LUT.

- [`int16_poc/`](./int16_poc/) — **History** for speed rows;
  **manual probe** for the two accuracy scripts (still cited as
  release checks). Own `package.json` + `lcms-wasm`.
  [`RESULTS.md`](./int16_poc/RESULTS.md) is a POC-era page (legacy
  HIGHRESPRECALC oracle). `cd bench/int16_poc && npm install`.

  - `bench_int16_vs_lcmswasm.js` — standalone u16 kernel vs
    lcms-wasm TYPE_*_16.
  - `bench_engine_int16.js` — same shape through the real
    `Transform` (`dataFormat: 'int16'`).
  - `bench_int16_simd_vs_scalar.js` — JS / WASM scalar / WASM SIMD
    u16 + lcms-wasm. `npm run bench:simd`.
  - `accuracy_v1_6_vs_lcms.js` — u16 jsCE vs lcms-wasm.
  - `accuracy_v1_7_self.js` — float LUT vs int16 LUT, same
    profile (kernel quantisation only).

---

## Compile POC

[`compile_poc/`](./compile_poc/) — **History / manual probe** for
`Transform.compile()` (v1.7 story). Write-up:
[`docs/deepdive/CompiledPipeline.md`](../docs/deepdive/CompiledPipeline.md).

- `probe_rgb_to_cmyk.js` — dump stages for one RGB→CMYK pixel
  (`pipelineDebug`).
- `bench_compiled.js` / `bench_compiled_cmyk2cmyk.js` — compiled
  body vs the runtime walker (RGB→CMYK and CMYK→CMYK).
- `bench_variants.js` — five wrappers around the same body
  (`bind` / closure / class / module).
- `bench_body_variants.js` — rewrite the body (temps vs fused
  trilinear).
- `bench_gammalut_hotloop.js` — `useGammaLUT` and `hotLoop`
  options.
- `bench_instrumented.js` / `bench_profilable.js` /
  `profile_run.js` — where the time goes (hrtime taps vs
  `node --prof`).

---

## JIT inspection

**Manual probe.** How to run: [`docs/deepdive/JitInspection.md`](../docs/deepdive/JitInspection.md).

- [`jit_inspection.js`](./jit_inspection.js) —
  `node --allow-natives-syntax bench/jit_inspection.js`. Dump:
  `node --allow-natives-syntax --print-opt-code --code-comments bench/jit_inspection.js`.
- [`jit_asm_core_line.js`](./jit_asm_core_line.js) — one core
  tetrahedral expression, float vs int, so the dump is readable.
- [`jit_asm_boundscheck.ps1`](./jit_asm_boundscheck.ps1) /
  [`jit_asm_spillcheck.ps1`](./jit_asm_spillcheck.ps1) — classify
  a saved `bench/jit_asm_dump.txt`.

---

## Historical / do-not-quote one-offs

- [`int_vs_float.js`](./int_vs_float.js) / [`int_vs_float_4d.js`](./int_vs_float_4d.js)
  — **History.** The 3-D / 4-D integer-kernel POCs that became
  `lutMode: 'int'`. Findings live in the file headers.

- [`fastLUT_real_world.js`](./fastLUT_real_world.js) — **History.**
  Early `int` vs `float` on all four GRACoL directions through the
  real `Transform`. Superseded as a headline by `mpx_summary.js` and
  the release matrix.

- [`diag_cmyk_to_rgb.js`](./diag_cmyk_to_rgb.js) — **Manual probe.**
  Directional-bias smoke for `buildIntLut()` / u16 scale. Run after
  touching those. `node bench/diag_cmyk_to_rgb.js`.

- [`wasm_shrink_ratio_bench.js`](./wasm_shrink_ratio_bench.js) —
  **Manual probe.** Cost of `wasmShrinkRatio` when alternating a
  large and a small image.
  `node bench/wasm_shrink_ratio_bench.js`.

- [`transformArray_reuse_output_bench.js`](./transformArray_reuse_output_bench.js)
  — **Manual probe.** Default allocation vs a reusable output
  buffer on the LUT path.
  `node bench/transformArray_reuse_output_bench.js`.

`bench/dispatcher_compare_bench.js` is already gone (retired; see
[`docs/deepdive/Performance.md`](../docs/deepdive/Performance.md)).

---

## Captured output (not harnesses)

- [`results/`](./results/) — timestamped `reproduce.js` runs (mostly
  gitignored) plus a few committed browser-bench captures
  (`v.1.5.5 - photo 5%.md` and siblings). Those belong to
  [`docs/Bench.md`](../docs/Bench.md), not this inventory.

- `.wat` / `.wasm` next to the pixel-cache and wasm_poc scripts are
  build products of those POCs, not separate benches.
