# Benchmark results — generated

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Performance](./deepdive/Performance.md) ·
[LittleCMS comparison](./LcmsComparison.md) ·
[Parallel pool](./pool.md) ·
[Bench](./Bench.md)

---

> **Generated file — do not edit.** Every table was written by the bench
> that measured it (`harness/lib/emit.cjs`) and rendered by
> `scripts/build_bench_results.js`. To refresh:
>
>     node harness/reproduce.js
>     node scripts/build_bench_results.js
>
> Run `2026-11-28T01-07-39` · measured 2026-11-28 · jsCE 1.7.3 · package now **1.7.3**

Other pages should **link to a table here** rather than restating its
numbers: prose keeps the finding, this page owns the figures. The
[citation index](#citation-index) lists what points where, so a
re-measurement is a finite job rather than a search.

## Conditions

| | |
|---|---|
| Date | 2026-11-28 |
| CPU | AMD Ryzen 7 7700X 8-Core Processor              (16 logical) |
| RAM | 31.1 GB |
| JS host | Node v24.16.0, win32 x64 |
| lcms native host | WSL2 (Ubuntu), gcc (Ubuntu 9.3.0-17ubuntu1~20.04) 9.3.0 |
| lcms-wasm version | 1.0.5 |
| jsColorEngine version | 1.7.3 |
| Photo corpus | 5 images, 3,939,000 px, mean adjacency 17.3% RGB / 17.89% CMYK |
| Content size | 1,048,576 px |
| Size sweep | 16384,65536,1048576,10485760 |
| Mode | full |

`taskset -c 0` pins the native binary to one core. Every JS measurement
runs in its own process with its own warmup.

## Contents

- [RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px](#table-js-content-rgb-rgb-matrix-1024k) — `js.content.rgb-rgb-matrix.1024k`
- [RGB -> Lab — jsCE vs lcms-wasm, 1024K px](#table-js-content-rgb-lab-1024k) — `js.content.rgb-lab.1024k`
- [RGB -> CMYK — jsCE vs lcms-wasm, 1024K px](#table-js-content-rgb-cmyk-1024k) — `js.content.rgb-cmyk.1024k`
- [CMYK -> RGB — jsCE vs lcms-wasm, 1024K px](#table-js-content-cmyk-rgb-1024k) — `js.content.cmyk-rgb.1024k`
- [CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px](#table-js-content-cmyk-cmyk-1024k) — `js.content.cmyk-cmyk.1024k`
- [RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px](#table-js-content-rgb-rgb-softproof-1024k) — `js.content.rgb-rgb-softproof.1024k`
- [RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px, per image](#table-js-perimage-rgb-rgb-matrix-1024k) — `js.perimage.rgb-rgb-matrix.1024k`
- [RGB -> Lab — jsCE vs lcms-wasm, 1024K px, per image](#table-js-perimage-rgb-lab-1024k) — `js.perimage.rgb-lab.1024k`
- [RGB -> CMYK — jsCE vs lcms-wasm, 1024K px, per image](#table-js-perimage-rgb-cmyk-1024k) — `js.perimage.rgb-cmyk.1024k`
- [CMYK -> RGB — jsCE vs lcms-wasm, 1024K px, per image](#table-js-perimage-cmyk-rgb-1024k) — `js.perimage.cmyk-rgb.1024k`
- [CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px, per image](#table-js-perimage-cmyk-cmyk-1024k) — `js.perimage.cmyk-cmyk.1024k`
- [RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px, per image](#table-js-perimage-rgb-rgb-softproof-1024k) — `js.perimage.rgb-rgb-softproof.1024k`
- [RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 16K px, size sweep](#table-js-sweep-rgb-rgb-matrix-16k) — `js.sweep.rgb-rgb-matrix.16k`
- [RGB -> Lab — jsCE vs lcms-wasm, 16K px, size sweep](#table-js-sweep-rgb-lab-16k) — `js.sweep.rgb-lab.16k`
- [RGB -> CMYK — jsCE vs lcms-wasm, 16K px, size sweep](#table-js-sweep-rgb-cmyk-16k) — `js.sweep.rgb-cmyk.16k`
- [CMYK -> RGB — jsCE vs lcms-wasm, 16K px, size sweep](#table-js-sweep-cmyk-rgb-16k) — `js.sweep.cmyk-rgb.16k`
- [CMYK -> CMYK — jsCE vs lcms-wasm, 16K px, size sweep](#table-js-sweep-cmyk-cmyk-16k) — `js.sweep.cmyk-cmyk.16k`
- [RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 16K px, size sweep](#table-js-sweep-rgb-rgb-softproof-16k) — `js.sweep.rgb-rgb-softproof.16k`
- [RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 64K px, size sweep](#table-js-sweep-rgb-rgb-matrix-64k) — `js.sweep.rgb-rgb-matrix.64k`
- [RGB -> Lab — jsCE vs lcms-wasm, 64K px, size sweep](#table-js-sweep-rgb-lab-64k) — `js.sweep.rgb-lab.64k`
- [RGB -> CMYK — jsCE vs lcms-wasm, 64K px, size sweep](#table-js-sweep-rgb-cmyk-64k) — `js.sweep.rgb-cmyk.64k`
- [CMYK -> RGB — jsCE vs lcms-wasm, 64K px, size sweep](#table-js-sweep-cmyk-rgb-64k) — `js.sweep.cmyk-rgb.64k`
- [CMYK -> CMYK — jsCE vs lcms-wasm, 64K px, size sweep](#table-js-sweep-cmyk-cmyk-64k) — `js.sweep.cmyk-cmyk.64k`
- [RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 64K px, size sweep](#table-js-sweep-rgb-rgb-softproof-64k) — `js.sweep.rgb-rgb-softproof.64k`
- [RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px, size sweep](#table-js-sweep-rgb-rgb-matrix-1024k) — `js.sweep.rgb-rgb-matrix.1024k`
- [RGB -> Lab — jsCE vs lcms-wasm, 1024K px, size sweep](#table-js-sweep-rgb-lab-1024k) — `js.sweep.rgb-lab.1024k`
- [RGB -> CMYK — jsCE vs lcms-wasm, 1024K px, size sweep](#table-js-sweep-rgb-cmyk-1024k) — `js.sweep.rgb-cmyk.1024k`
- [CMYK -> RGB — jsCE vs lcms-wasm, 1024K px, size sweep](#table-js-sweep-cmyk-rgb-1024k) — `js.sweep.cmyk-rgb.1024k`
- [CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px, size sweep](#table-js-sweep-cmyk-cmyk-1024k) — `js.sweep.cmyk-cmyk.1024k`
- [RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px, size sweep](#table-js-sweep-rgb-rgb-softproof-1024k) — `js.sweep.rgb-rgb-softproof.1024k`
- [RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 10240K px, size sweep](#table-js-sweep-rgb-rgb-matrix-10240k) — `js.sweep.rgb-rgb-matrix.10240k`
- [RGB -> Lab — jsCE vs lcms-wasm, 10240K px, size sweep](#table-js-sweep-rgb-lab-10240k) — `js.sweep.rgb-lab.10240k`
- [RGB -> CMYK — jsCE vs lcms-wasm, 10240K px, size sweep](#table-js-sweep-rgb-cmyk-10240k) — `js.sweep.rgb-cmyk.10240k`
- [CMYK -> RGB — jsCE vs lcms-wasm, 10240K px, size sweep](#table-js-sweep-cmyk-rgb-10240k) — `js.sweep.cmyk-rgb.10240k`
- [CMYK -> CMYK — jsCE vs lcms-wasm, 10240K px, size sweep](#table-js-sweep-cmyk-cmyk-10240k) — `js.sweep.cmyk-cmyk.10240k`
- [RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 10240K px, size sweep](#table-js-sweep-rgb-rgb-softproof-10240k) — `js.sweep.rgb-rgb-softproof.10240k`
- [Matrix-shaper kernel vs CLUT, accuracy against the exact pipeline, int16](#table-matrixshaper-accuracy-int16) — `matrixShaper.accuracy.int16`
- [Matrix-shaper kernel vs CLUT, accuracy against the exact pipeline, int8](#table-matrixshaper-accuracy-int8) — `matrixShaper.accuracy.int8`
- [Matrix-shaper kernel vs CLUT, int8, *prophoto -> *sRGB](#table-matrixshaper-throughput-int8) — `matrixShaper.throughput.int8`
- [Matrix-shaper kernel ratios, int8](#table-matrixshaper-ratios-int8) — `matrixShaper.ratios.int8`
- [Matrix-shaper kernel vs CLUT, int16, *prophoto -> *sRGB](#table-matrixshaper-throughput-int16) — `matrixShaper.throughput.int16`
- [Matrix-shaper kernel ratios, int16](#table-matrixshaper-ratios-int16) — `matrixShaper.ratios.int16`
- [Pixel cache (BETA), accuracy path — RGB -> RGB  (matrix)](#table-pixelcache-accuracypath-rgb-rgb-matrix) — `pixelCache.accuracyPath.rgb-rgb-matrix`
- [Pixel cache (BETA), accuracy path — RGB -> Lab](#table-pixelcache-accuracypath-rgb-lab) — `pixelCache.accuracyPath.rgb-lab`
- [Pixel cache (BETA), accuracy path — RGB -> CMYK](#table-pixelcache-accuracypath-rgb-cmyk) — `pixelCache.accuracyPath.rgb-cmyk`
- [Pixel cache (BETA), accuracy path — CMYK -> RGB](#table-pixelcache-accuracypath-cmyk-rgb) — `pixelCache.accuracyPath.cmyk-rgb`
- [Pixel cache (BETA), accuracy path — CMYK -> CMYK](#table-pixelcache-accuracypath-cmyk-cmyk) — `pixelCache.accuracyPath.cmyk-cmyk`
- [Pixel cache (BETA), accuracy path — RGB -> RGB  (softproof)](#table-pixelcache-accuracypath-rgb-rgb-softproof) — `pixelCache.accuracyPath.rgb-rgb-softproof`
- [Pixel cache, in-kernel WASM — RGB -> RGB  (matrix)](#table-pixelcache-inkernel-rgb-rgb-matrix) — `pixelCache.inKernel.rgb-rgb-matrix`
- [Pixel cache, in-kernel WASM — RGB -> Lab](#table-pixelcache-inkernel-rgb-lab) — `pixelCache.inKernel.rgb-lab`
- [Pixel cache, in-kernel WASM — RGB -> CMYK](#table-pixelcache-inkernel-rgb-cmyk) — `pixelCache.inKernel.rgb-cmyk`
- [Pixel cache, in-kernel WASM — CMYK -> RGB](#table-pixelcache-inkernel-cmyk-rgb) — `pixelCache.inKernel.cmyk-rgb`
- [Pixel cache, in-kernel WASM — CMYK -> CMYK](#table-pixelcache-inkernel-cmyk-cmyk) — `pixelCache.inKernel.cmyk-cmyk`
- [Pixel cache, in-kernel WASM — RGB -> RGB  (softproof)](#table-pixelcache-inkernel-rgb-rgb-softproof) — `pixelCache.inKernel.rgb-rgb-softproof`
- [Matrix-shaper kernel vs CLUT in the worker pool — noise](#table-pool-matrixshaper-noise) — `pool.matrixShaper.noise`
- [Matrix-shaper kernel vs CLUT in the worker pool — photo](#table-pool-matrixshaper-photo) — `pool.matrixShaper.photo`
- [Worker pool — peak speedup vs sequential, by kernel and content](#table-pool-peak) — `pool.peak`
- [Worker pool — every worker count](#table-pool-scaling) — `pool.scaling`
- [Throughput on synthetic LUTs — narrow input and wide output](#table-smalldim-throughput) — `smallDim.throughput`
- [Solo control bench — one image, one engine, one process (rgb2cmyk)](#table-solo-rgb2cmyk) — `solo.rgb2cmyk`
- [Solo control bench — one image, one engine, one process (rgb2lab)](#table-solo-rgb2lab) — `solo.rgb2lab`

<a id="table-js-content-rgb-rgb-matrix-1024k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.5 | 96.1 | 64.2 | 64.5 | 1.5 |
| gradient | 75 | 256 | 0.01 | 61.8 | 327 | 66.3 | 65.9 | 4.93 |
| blocks16 | 93.8 | 4095 | 0.11 | 60.4 | 427.5 | 66.8 | 68.4 | 6.39 |
| solid | 100 | 1 | 0 | 63.1 | 480.7 | 67.6 | 67.7 | 7.12 |
| photo | 13.2 | 41077 | 1.14 | 53.9 | 113.3 | 66.5 | 66.5 | 1.7 |

<a id="table-js-content-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.4 | 96.2 | 31.2 | 37.5 | 3.08 |
| gradient | 75 | 256 | 0.01 | 61.8 | 327.1 | 64.9 | 48 | 5.04 |
| blocks16 | 93.8 | 4095 | 0.11 | 60.3 | 428.4 | 76 | 48.4 | 5.64 |
| solid | 100 | 1 | 0 | 61.3 | 481.6 | 92.5 | 51 | 5.2 |
| photo | 13.2 | 41077 | 1.14 | 53.2 | 112.6 | 35.3 | 41.4 | 3.19 |

<a id="table-js-content-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 43.3 | 97.9 | 30.9 | 36.1 | 3.16 |
| gradient | 75 | 256 | 0.01 | 53.5 | 320.3 | 64.3 | 48.4 | 4.98 |
| blocks16 | 93.8 | 4095 | 0.11 | 52.5 | 419.5 | 76.1 | 45.9 | 5.51 |
| solid | 100 | 1 | 0 | 54.7 | 469.8 | 83.5 | 46.1 | 5.62 |
| photo | 13.2 | 41077 | 1.14 | 47.6 | 113.5 | 34.7 | 39.4 | 3.27 |

<a id="table-js-content-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px

`js.content.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 30.3 | 67.5 | 21.5 | 21.7 | 3.14 |
| gradient | 75 | 256 | 0 | 38.1 | 229.9 | 49.2 | 25 | 4.67 |
| blocks16 | 93.8 | 4096 | 0.05 | 37.9 | 356.5 | 69.5 | 25.1 | 5.13 |
| solid | 100 | 1 | 0 | 39 | 429.7 | 92.1 | 26.5 | 4.67 |
| photo | 13.3 | 35074 | 0.42 | 44.2 | 81.6 | 25.4 | 24.1 | 3.21 |

<a id="table-js-content-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px

`js.content.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 26.6 | 66.7 | 18.1 | 20.1 | 3.69 |
| gradient | 75 | 256 | 0 | 31.8 | 223.3 | 47.2 | 24.4 | 4.73 |
| blocks16 | 93.8 | 4096 | 0.05 | 32.2 | 340 | 68 | 24 | 5 |
| solid | 100 | 1 | 0 | 32 | 411.2 | 85.5 | 25.1 | 4.81 |
| photo | 13.3 | 35074 | 0.42 | 36.2 | 80 | 22.9 | 23.7 | 3.5 |

<a id="table-js-content-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 47.3 | 96.5 | 32.1 | 36.1 | 3 |
| gradient | 75 | 256 | 0.01 | 61.2 | 329.7 | 59.1 | 47.8 | 5.58 |
| blocks16 | 93.8 | 4095 | 0.11 | 60.3 | 433.8 | 75.4 | 47.3 | 5.75 |
| solid | 100 | 1 | 0 | 61.5 | 484.7 | 89.2 | 48.5 | 5.44 |
| photo | 13.2 | 41077 | 1.14 | 53.5 | 112.3 | 34.1 | 38.9 | 3.3 |

<a id="table-js-perimage-rgb-rgb-matrix-1024k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 51 | 115.8 | 66.2 | 66.1 | 1.75 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 52.2 | 106.5 | 66.3 | 66.7 | 1.61 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 54.9 | 139.6 | 67.3 | 66.8 | 2.08 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 52.5 | 107 | 65 | 65.5 | 1.65 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 50 | 102.3 | 66.3 | 66.2 | 1.54 |

<a id="table-js-perimage-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 54 | 105.2 | 34.1 | 41.7 | 3.08 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 52.3 | 107.9 | 33.5 | 39.9 | 3.22 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 55.3 | 139 | 40.4 | 41.7 | 3.45 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 52.4 | 107 | 34.5 | 40 | 3.1 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 51.4 | 104.6 | 32.7 | 39.7 | 3.2 |

<a id="table-js-perimage-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 48.2 | 117 | 35.8 | 39 | 3.27 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 47 | 109.5 | 33.9 | 38.6 | 3.23 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 49.2 | 141.1 | 40.1 | 41.1 | 3.52 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 46.9 | 110.7 | 33.6 | 38.4 | 3.3 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 46.3 | 106.6 | 32.5 | 38.3 | 3.28 |

<a id="table-js-perimage-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6332 | 0.08 | 35.9 | 79.2 | 25.1 | 24.5 | 3.16 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 17.6 | 103888 | 1.24 | 35.2 | 81.5 | 24 | 24 | 3.39 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42.2 | 67211 | 0.8 | 36.8 | 106.8 | 31.6 | 24.6 | 3.39 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 15.6 | 86185 | 1.03 | 37.4 | 84.5 | 25.4 | 24.4 | 3.33 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 7.1 | 201835 | 2.42 | 34.1 | 80.1 | 24.4 | 24.1 | 3.28 |

<a id="table-js-perimage-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6332 | 0.08 | 30.9 | 82.2 | 23.2 | 24 | 3.55 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 17.6 | 103888 | 1.24 | 31.6 | 82 | 23.1 | 23.3 | 3.55 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42.2 | 67211 | 0.8 | 31.7 | 106.4 | 29.3 | 23.9 | 3.63 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 15.6 | 86185 | 1.03 | 31.4 | 84.1 | 23.3 | 23.8 | 3.61 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 7.1 | 201835 | 2.42 | 30.9 | 79.2 | 22.1 | 19.9 | 3.59 |

<a id="table-js-perimage-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 53.6 | 115.6 | 33.9 | 38.3 | 3.41 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 50.7 | 103.5 | 33.8 | 35.9 | 3.06 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 54.7 | 131 | 40.1 | 40.6 | 3.27 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 49.6 | 105.1 | 33.1 | 35.8 | 3.18 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 50.4 | 103.8 | 32.6 | 36.9 | 3.18 |

<a id="table-js-sweep-rgb-rgb-matrix-16k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-rgb-matrix.16k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 59.8 | 150.2 | 63.9 | 61.7 | 2.35 |

<a id="table-js-sweep-rgb-lab-16k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-lab.16k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 59.3 | 145.7 | 38 | 49.1 | 3.83 |

<a id="table-js-sweep-rgb-cmyk-16k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-cmyk.16k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 49.7 | 139.8 | 33.2 | 42 | 4.21 |

<a id="table-js-sweep-cmyk-rgb-16k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.cmyk-rgb.16k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 16384 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16384 | 0.2 | 31 | 79 | 20.2 | 21.8 | 3.9 |

<a id="table-js-sweep-cmyk-cmyk-16k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.cmyk-cmyk.16k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 16384 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16384 | 0.2 | 26.8 | 74.2 | 18.6 | 20.2 | 3.98 |

<a id="table-js-sweep-rgb-rgb-softproof-16k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-rgb-softproof.16k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 59.9 | 153.4 | 35 | 47.2 | 4.38 |

<a id="table-js-sweep-rgb-rgb-matrix-64k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-rgb-matrix.64k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 55.1 | 93.8 | 64.3 | 64.2 | 1.46 |

<a id="table-js-sweep-rgb-lab-64k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-lab.64k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 56.7 | 93.5 | 32.1 | 37.3 | 2.91 |

<a id="table-js-sweep-rgb-cmyk-64k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-cmyk.64k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 50 | 91.1 | 31.3 | 35.9 | 2.91 |

<a id="table-js-sweep-cmyk-rgb-64k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.cmyk-rgb.64k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 65536 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65536 | 0.78 | 29.4 | 64.2 | 21.4 | 21.7 | 3 |

<a id="table-js-sweep-cmyk-cmyk-64k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.cmyk-cmyk.64k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 65536 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65536 | 0.78 | 26.5 | 64.5 | 18.7 | 20.1 | 3.45 |

<a id="table-js-sweep-rgb-rgb-softproof-64k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-rgb-softproof.64k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 57.1 | 92.3 | 32.4 | 35.9 | 2.85 |

<a id="table-js-sweep-rgb-rgb-matrix-1024k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 49.3 | 92.6 | 63.5 | 64.5 | 1.46 |

<a id="table-js-sweep-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 47.5 | 94.9 | 30.7 | 36.4 | 3.09 |

<a id="table-js-sweep-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 43.5 | 95.5 | 30.9 | 35.9 | 3.09 |

<a id="table-js-sweep-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 31.5 | 66.4 | 21.5 | 21.5 | 3.09 |

<a id="table-js-sweep-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 24.9 | 65 | 18.3 | 20 | 3.54 |

<a id="table-js-sweep-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48 | 96.1 | 33.3 | 36.5 | 2.89 |

<a id="table-js-sweep-rgb-rgb-matrix-10240k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-rgb-matrix.10240k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 48.3 | 96.5 | 64.4 | 63.2 | 1.5 |

<a id="table-js-sweep-rgb-lab-10240k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-lab.10240k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 48.6 | 96.6 | 30.5 | 36.3 | 3.17 |

<a id="table-js-sweep-rgb-cmyk-10240k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-cmyk.10240k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 43.6 | 97 | 31 | 35.4 | 3.12 |

<a id="table-js-sweep-cmyk-rgb-10240k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.cmyk-rgb.10240k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 10485760 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 10485760 | 125.55 | 30.3 | 66.2 | 21.2 | 22 | 3.12 |

<a id="table-js-sweep-cmyk-cmyk-10240k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.cmyk-cmyk.10240k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 10485760 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 10485760 | 125.55 | 26.3 | 65.8 | 18.9 | 20.4 | 3.47 |

<a id="table-js-sweep-rgb-rgb-softproof-10240k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-rgb-softproof.10240k` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 47.7 | 95.9 | 32.2 | 36.6 | 2.98 |

<a id="table-matrixshaper-accuracy-int16"></a>

### Matrix-shaper kernel vs CLUT, accuracy against the exact pipeline, int16

`matrixShaper.accuracy.int16` · LSB · measured by `harness/matrix_shaper_kernel/accuracy.js` · jsCE **1.7.3** · 2026-11-28

**bits** 16 · **coloursPerPair** 113157 · **reference** buildLut:false, wasmMatrixShaper:false

| Pair | Variant | Kernel Max Lsb | Kernel Mean Lsb | Kernel Over1 Pct | Clut Max Lsb | Clut Mean Lsb | Clut Over1 Pct |
|---|---|---:|---:|---:|---:|---:|---:|
| *sRGB -> *AdobeRGB | 16-simd | 1 | 0.1859 | 0 | 1199 | 19.7007 | 41.544 |
| *AdobeRGB -> *sRGB | 16-simd | 1 | 0.1132 | 0 | 3934 | 26.2584 | 61.949 |
| *sRGB -> *prophoto | 16-simd | 1 | 0.176 | 0 | 492 | 9.9191 | 89.242 |
| *prophoto -> *sRGB | 16-simd | 1 | 0.1105 | 0 | 6668 | 54.3403 | 65.499 |
| *sRGB -> *applergb | 16-simd | 1 | 0.158 | 0 | 1505 | 19.4496 | 64.301 |
| *sRGB -> *colormatch | 16-simd | 1 | 0.1586 | 0 | 1836 | 20.1627 | 65.86 |

<a id="table-matrixshaper-accuracy-int8"></a>

### Matrix-shaper kernel vs CLUT, accuracy against the exact pipeline, int8

`matrixShaper.accuracy.int8` · LSB · measured by `harness/matrix_shaper_kernel/accuracy.js` · jsCE **1.7.3** · 2026-11-28

**bits** 8 · **coloursPerPair** 262144 · **reference** buildLut:false, wasmMatrixShaper:false

| Pair | Variant | Kernel Max Lsb | Kernel Mean Lsb | Kernel Over1 Pct | Clut Max Lsb | Clut Mean Lsb | Clut Over1 Pct |
|---|---|---:|---:|---:|---:|---:|---:|
| *sRGB -> *AdobeRGB | 8-simd | 1 | 0.0013 | 0 | 4 | 0.0349 | 0.594 |
| *AdobeRGB -> *sRGB | 8-simd | 1 | 0.001 | 0 | 19 | 0.0942 | 1.27 |
| *sRGB -> *prophoto | 8-simd | 1 | 0.0012 | 0 | 2 | 0.0125 | 0.001 |
| *prophoto -> *sRGB | 8-simd | 1 | 0.0009 | 0 | 25 | 0.1764 | 2.462 |
| *sRGB -> *applergb | 8-simd | 1 | 0.0014 | 0 | 6 | 0.0564 | 1.458 |
| *sRGB -> *colormatch | 8-simd | 1 | 0.0013 | 0 | 7 | 0.0565 | 1.389 |

<a id="table-matrixshaper-throughput-int8"></a>

### Matrix-shaper kernel vs CLUT, int8, *prophoto -> *sRGB

`matrixShaper.throughput.int8` · MPx/s · measured by `harness/matrix_shaper_kernel/throughput.js` · jsCE **1.7.3** · 2026-11-28

**bits** 8 · **pixels** 4194304 · **reps** 5 · **pair** *prophoto → *sRGB · **best** best of 5

| Path | Solid | Noise | Photo |
|---|---:|---:|---:|
| kernel, SIMD | 338.3 | 325.8 | 335.5 |
| kernel, scalar | 224.3 | 69.3 | 185.1 |
| kernel, plain JS | 96.3 | 58.3 | 91.3 |
| CLUT (default lutMode) | 532.3 | 98.8 | 115.9 |
| JS stage pipeline | 10.2 | 8.3 | 8.7 |

<a id="table-matrixshaper-ratios-int8"></a>

### Matrix-shaper kernel ratios, int8

`matrixShaper.ratios.int8` · x · measured by `harness/matrix_shaper_kernel/throughput.js` · jsCE **1.7.3** · 2026-11-28

**bits** 8 · **pair** *prophoto → *sRGB

| Content | SIMD / CLUT | SIMD / scalar | SIMD / plain JS | JS / pipeline |
|---|---:|---:|---:|---:|
| solid | 0.64 | 1.51 | 3.51 | 9.5 |
| noise | 3.3 | 4.7 | 5.59 | 7 |
| photo | 2.89 | 1.81 | 3.68 | 10.5 |

<a id="table-matrixshaper-throughput-int16"></a>

### Matrix-shaper kernel vs CLUT, int16, *prophoto -> *sRGB

`matrixShaper.throughput.int16` · MPx/s · measured by `harness/matrix_shaper_kernel/throughput.js` · jsCE **1.7.3** · 2026-11-28

**bits** 16 · **pixels** 4194304 · **reps** 5 · **pair** *prophoto → *sRGB · **best** best of 5

| Path | Solid | Noise | Photo |
|---|---:|---:|---:|
| kernel, SIMD | 235.9 | 195 | 211.2 |
| kernel, scalar | 99.6 | 62.4 | 99.9 |
| kernel, plain JS | 77.8 | 38.5 | 58.5 |
| CLUT (default lutMode) | 187.7 | 102.6 | 119.8 |
| JS stage pipeline | 10 | 8.2 | 8.7 |

<a id="table-matrixshaper-ratios-int16"></a>

### Matrix-shaper kernel ratios, int16

`matrixShaper.ratios.int16` · x · measured by `harness/matrix_shaper_kernel/throughput.js` · jsCE **1.7.3** · 2026-11-28

**bits** 16 · **pair** *prophoto → *sRGB

| Content | SIMD / CLUT | SIMD / scalar | SIMD / plain JS | JS / pipeline |
|---|---:|---:|---:|---:|
| solid | 1.26 | 2.37 | 3.03 | 7.8 |
| noise | 1.9 | 3.13 | 5.07 | 4.7 |
| photo | 1.76 | 2.11 | 3.61 | 6.7 |

<a id="table-pixelcache-accuracypath-rgb-rgb-matrix"></a>

### Pixel cache (BETA), accuracy path — RGB -> RGB  (matrix)

`pixelCache.accuracyPath.rgb-rgb-matrix` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 256.91 | 250.04 | 255.46 | 0 | -1 |
| gradient | 75 | 250.99 | 268.03 | 253.75 | 0 | 1 |
| blocks16 | 93.8 | 264.96 | 270.71 | 267.46 | 0 | 1 |
| solid | 100 | 270.46 | 272.9 | 271.75 | 0 | 0 |
| photo | 8.6 | 254.88 | 264.87 | 262.89 | 0 | 3 |

<a id="table-pixelcache-accuracypath-rgb-lab"></a>

### Pixel cache (BETA), accuracy path — RGB -> Lab

`pixelCache.accuracyPath.rgb-lab` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7.56 | 6.1 | 5.84 | 0 | -23 |
| gradient | 75 | 8.26 | 16.1 | 15.26 | 75 | 85 |
| blocks16 | 93.8 | 8.49 | 25.65 | 23.96 | 94.4 | 182 |
| solid | 100 | 8.46 | 32.7 | 29.62 | 100 | 250 |
| photo | 8.6 | 8.13 | 7.15 | 8.5 | 32.8 | 5 |

<a id="table-pixelcache-accuracypath-rgb-cmyk"></a>

### Pixel cache (BETA), accuracy path — RGB -> CMYK

`pixelCache.accuracyPath.rgb-cmyk` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 4.65 | 4.1 | 3.94 | 0 | -15 |
| gradient | 75 | 5.19 | 11.94 | 11.4 | 75 | 120 |
| blocks16 | 93.8 | 5.29 | 21.17 | 20.59 | 94.4 | 289 |
| solid | 100 | 5.35 | 29.38 | 27.79 | 100 | 419 |
| photo | 8.6 | 4.85 | 4.46 | 5.45 | 32.8 | 12 |

<a id="table-pixelcache-accuracypath-cmyk-rgb"></a>

### Pixel cache (BETA), accuracy path — CMYK -> RGB

`pixelCache.accuracyPath.cmyk-rgb` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 5.76 | 4.87 | 4.7 | 0 | -18 |
| gradient | 75 | 6.82 | 13.8 | 13.05 | 75 | 91 |
| blocks16 | 93.8 | 6.93 | 22.8 | 21.77 | 94.4 | 214 |
| solid | 100 | 7.14 | 30.54 | 27.41 | 100 | 284 |
| photo | 8.6 | 6.35 | 5.65 | 6.5 | 31.4 | 2 |

<a id="table-pixelcache-accuracypath-cmyk-cmyk"></a>

### Pixel cache (BETA), accuracy path — CMYK -> CMYK

`pixelCache.accuracyPath.cmyk-cmyk` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 5.32 | 4.5 | 4.32 | 0 | -19 |
| gradient | 75 | 6.47 | 13.09 | 12.27 | 75 | 90 |
| blocks16 | 93.8 | 6.6 | 21.41 | 20.68 | 94.4 | 213 |
| solid | 100 | 6.65 | 28.68 | 25.15 | 100 | 278 |
| photo | 8.6 | 6.07 | 5.34 | 6.15 | 31.4 | 1 |

<a id="table-pixelcache-accuracypath-rgb-rgb-softproof"></a>

### Pixel cache (BETA), accuracy path — RGB -> RGB  (softproof)

`pixelCache.accuracyPath.rgb-rgb-softproof` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 2.81 | 2.51 | 2.33 | 0 | -17 |
| gradient | 75 | 3.17 | 8.54 | 8.28 | 75 | 161 |
| blocks16 | 93.8 | 3.28 | 18.02 | 17.09 | 94.4 | 421 |
| solid | 100 | 3.25 | 30.12 | 30.08 | 100 | 826 |
| photo | 8.6 | 3.14 | 2.93 | 3.76 | 32.8 | 20 |

<a id="table-pixelcache-inkernel-rgb-rgb-matrix"></a>

### Pixel cache, in-kernel WASM — RGB -> RGB  (matrix)

`pixelCache.inKernel.rgb-rgb-matrix` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 190.1 | 489.5 | 2.58 | 1 |
| photo | 8.6 | 113.9 | 108.7 | 0.95 | 1 |
| photo with 5% noise added | 0 | 99.9 | 91.3 | 0.91 | 1 |
| noise | 0 | 90.5 | 90.1 | 1 | 1 |

<a id="table-pixelcache-inkernel-rgb-lab"></a>

### Pixel cache, in-kernel WASM — RGB -> Lab

`pixelCache.inKernel.rgb-lab` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 191.6 | 498.2 | 2.6 | 1 |
| photo | 8.6 | 114.2 | 108.1 | 0.95 | 1 |
| photo with 5% noise added | 0 | 90.8 | 91.5 | 1.01 | 1 |
| noise | 0 | 90.1 | 90 | 1 | 1 |

<a id="table-pixelcache-inkernel-rgb-cmyk"></a>

### Pixel cache, in-kernel WASM — RGB -> CMYK

`pixelCache.inKernel.rgb-cmyk` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 177.2 | 425.7 | 2.4 | 1 |
| photo | 8.6 | 119.6 | 114 | 0.95 | 1 |
| photo with 5% noise added | 0 | 102.1 | 99.4 | 0.97 | 1 |
| noise | 0 | 100.3 | 96.5 | 0.96 | 1 |

<a id="table-pixelcache-inkernel-cmyk-rgb"></a>

### Pixel cache, in-kernel WASM — CMYK -> RGB

`pixelCache.inKernel.cmyk-rgb` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 101.8 | 489.1 | 4.8 | 1 |
| photo | 8.6 | 83.7 | 82.9 | 0.99 | 1 |
| photo with 5% noise added | 0 | 72.6 | 71.4 | 0.98 | 1 |
| noise | 0 | 70.2 | 67.9 | 0.97 | 1 |

<a id="table-pixelcache-inkernel-cmyk-cmyk"></a>

### Pixel cache, in-kernel WASM — CMYK -> CMYK

`pixelCache.inKernel.cmyk-cmyk` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 99.4 | 393.3 | 3.95 | 1 |
| photo | 8.6 | 80 | 77.6 | 0.97 | 1 |
| photo with 5% noise added | 0 | 68.2 | 67.7 | 0.99 | 1 |
| noise | 0 | 67.3 | 66.5 | 0.99 | 1 |

<a id="table-pixelcache-inkernel-rgb-rgb-softproof"></a>

### Pixel cache, in-kernel WASM — RGB -> RGB  (softproof)

`pixelCache.inKernel.rgb-rgb-softproof` · MPx/s · measured by `run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 185.9 | 505.3 | 2.72 | 1 |
| photo | 8.6 | 112.4 | 107.3 | 0.95 | 1 |
| photo with 5% noise added | 0 | 88.6 | 89.8 | 1.01 | 1 |
| noise | 0 | 87.2 | 89.2 | 1.02 | 1 |

<a id="table-pool-matrixshaper-noise"></a>

### Matrix-shaper kernel vs CLUT in the worker pool — noise

`pool.matrixShaper.noise` · MPx/s · measured by `harness/matrix_shaper_kernel/multicore.js` · jsCE **1.7.3** · 2026-11-28

**content** noise · **pair** *prophoto → *sRGB · **pixels** 4000000 · **runs** 5 · **sequentialClutMpxs** 99.5 · **sequentialKernelMpxs** 314.5 · **maxKernelVsClutLsb** 28

| Workers | Clut Mpxs | Clut Speedup | Clut Eff Pct | Kernel Mpxs | Kernel Speedup | Kernel Eff Pct | Kernel Over Clut | Exact |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 88.3 | 0.89 | 89 | 252.7 | 0.8 | 80 | 2.86 | yes |
| 2 | 167.2 | 1.68 | 84 | 446.6 | 1.42 | 71 | 2.67 | yes |
| 3 | 249.2 | 2.51 | 84 | 680 | 2.16 | 72 | 2.73 | yes |
| 4 | 333.3 | 3.35 | 84 | 834.1 | 2.65 | 66 | 2.5 | yes |
| 5 | 393.4 | 3.96 | 79 | 994.1 | 3.16 | 63 | 2.53 | yes |
| 6 | 463.6 | 4.66 | 78 | 1149.3 | 3.65 | 61 | 2.48 | yes |
| 7 | 482.9 | 4.86 | 69 | 1076.6 | 3.42 | 49 | 2.23 | yes |
| 8 | 515.5 | 5.18 | 65 | 985.9 | 3.13 | 39 | 1.91 | yes |

<a id="table-pool-matrixshaper-photo"></a>

### Matrix-shaper kernel vs CLUT in the worker pool — photo

`pool.matrixShaper.photo` · MPx/s · measured by `harness/matrix_shaper_kernel/multicore.js` · jsCE **1.7.3** · 2026-11-28

**content** photo · **pair** *prophoto → *sRGB · **pixels** 4000000 · **runs** 5 · **sequentialClutMpxs** 117.4 · **sequentialKernelMpxs** 324 · **maxKernelVsClutLsb** 25

| Workers | Clut Mpxs | Clut Speedup | Clut Eff Pct | Kernel Mpxs | Kernel Speedup | Kernel Eff Pct | Kernel Over Clut | Exact |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 104.3 | 0.89 | 89 | 260.3 | 0.8 | 80 | 2.5 | yes |
| 2 | 206 | 1.76 | 88 | 498 | 1.54 | 77 | 2.42 | yes |
| 3 | 289.5 | 2.47 | 82 | 654.4 | 2.02 | 67 | 2.26 | yes |
| 4 | 371.7 | 3.17 | 79 | 745.6 | 2.3 | 58 | 2.01 | yes |
| 5 | 454.6 | 3.87 | 77 | 951.2 | 2.94 | 59 | 2.09 | yes |
| 6 | 478.1 | 4.07 | 68 | 820.3 | 2.53 | 42 | 1.72 | yes |
| 7 | 519.8 | 4.43 | 63 | 1025.9 | 3.17 | 45 | 1.97 | yes |
| 8 | 558.8 | 4.76 | 60 | 1022.3 | 3.15 | 39 | 1.83 | yes |

<a id="table-pool-peak"></a>

### Worker pool — peak speedup vs sequential, by kernel and content

`pool.peak` · x · measured by `harness/multicore_matrix/run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 4194304 · **maxWorkers** 8

| Kernel | Content | Sequential MPx/s | Peak Speedup | At Workers | Peak MPx/s | Efficiency | Exact |
|---|---|---:|---:|---:|---:|---:|---|
| int | solid | 57.3 | 5.51 | 8 | 315.7 | 69 | yes |
| int | noise | 45 | 6.02 | 7 | 270.6 | 86 | yes |
| int | photo | 48.9 | 6.39 | 8 | 312.7 | 80 | yes |
| int-wasm-scalar | solid | 309.5 | 3.23 | 8 | 999.3 | 40 | yes |
| int-wasm-scalar | noise | 59.5 | 5.22 | 8 | 310.1 | 65 | yes |
| int-wasm-scalar | photo | 70.4 | 5.32 | 8 | 374.6 | 67 | yes |
| int-wasm-simd | solid | 503.9 | 2.35 | 6 | 1184.4 | 39 | yes |
| int-wasm-simd | noise | 99.6 | 4.97 | 8 | 495 | 62 | yes |
| int-wasm-simd | photo | 116.5 | 4.55 | 8 | 530.5 | 57 | yes |

<a id="table-pool-scaling"></a>

### Worker pool — every worker count

`pool.scaling` · MPx/s · measured by `harness/multicore_matrix/run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 4194304

| Kernel | Content | Workers | MPx/s | Speedup | Efficiency | Exact |
|---|---|---:|---:|---:|---:|---|
| int | solid | 1 | 50.7 | 0.89 | 89 | yes |
| int | solid | 2 | 103.3 | 1.8 | 90 | yes |
| int | solid | 3 | 147.1 | 2.57 | 86 | yes |
| int | solid | 4 | 193.4 | 3.38 | 84 | yes |
| int | solid | 5 | 227.9 | 3.98 | 80 | yes |
| int | solid | 6 | 252.2 | 4.4 | 73 | yes |
| int | solid | 7 | 264.9 | 4.63 | 66 | yes |
| int | solid | 8 | 315.7 | 5.51 | 69 | yes |
| int | noise | 1 | 42.9 | 0.95 | 95 | yes |
| int | noise | 2 | 81.9 | 1.82 | 91 | yes |
| int | noise | 3 | 119 | 2.65 | 88 | yes |
| int | noise | 4 | 171.8 | 3.82 | 96 | yes |
| int | noise | 5 | 212.8 | 4.73 | 95 | yes |
| int | noise | 6 | 240.4 | 5.35 | 89 | yes |
| int | noise | 7 | 270.6 | 6.02 | 86 | yes |
| int | noise | 8 | 268.4 | 5.97 | 75 | yes |
| int | photo | 1 | 46.3 | 0.95 | 95 | yes |
| int | photo | 2 | 89.4 | 1.83 | 91 | yes |
| int | photo | 3 | 133.9 | 2.74 | 91 | yes |
| int | photo | 4 | 203.2 | 4.15 | 104 | yes |
| int | photo | 5 | 242.2 | 4.95 | 99 | yes |
| int | photo | 6 | 267 | 5.46 | 91 | yes |
| int | photo | 7 | 295 | 6.03 | 86 | yes |
| int | photo | 8 | 312.7 | 6.39 | 80 | yes |
| int-wasm-scalar | solid | 1 | 246.3 | 0.8 | 80 | yes |
| int-wasm-scalar | solid | 2 | 482.2 | 1.56 | 78 | yes |
| int-wasm-scalar | solid | 3 | 650.8 | 2.1 | 70 | yes |
| int-wasm-scalar | solid | 4 | 789.9 | 2.55 | 64 | yes |
| int-wasm-scalar | solid | 5 | 892.5 | 2.88 | 58 | yes |
| int-wasm-scalar | solid | 6 | 950.5 | 3.07 | 51 | yes |
| int-wasm-scalar | solid | 7 | 728.3 | 2.35 | 34 | yes |
| int-wasm-scalar | solid | 8 | 999.3 | 3.23 | 40 | yes |
| int-wasm-scalar | noise | 1 | 54.6 | 0.92 | 92 | yes |
| int-wasm-scalar | noise | 2 | 107.9 | 1.81 | 91 | yes |
| int-wasm-scalar | noise | 3 | 153.3 | 2.58 | 86 | yes |
| int-wasm-scalar | noise | 4 | 206.2 | 3.47 | 87 | yes |
| int-wasm-scalar | noise | 5 | 239.8 | 4.03 | 81 | yes |
| int-wasm-scalar | noise | 6 | 263.1 | 4.42 | 74 | yes |
| int-wasm-scalar | noise | 7 | 265.8 | 4.47 | 64 | yes |
| int-wasm-scalar | noise | 8 | 310.1 | 5.22 | 65 | yes |
| int-wasm-scalar | photo | 1 | 63 | 0.89 | 89 | yes |
| int-wasm-scalar | photo | 2 | 124.3 | 1.77 | 88 | yes |
| int-wasm-scalar | photo | 3 | 185.2 | 2.63 | 88 | yes |
| int-wasm-scalar | photo | 4 | 239.8 | 3.41 | 85 | yes |
| int-wasm-scalar | photo | 5 | 278.4 | 3.95 | 79 | yes |
| int-wasm-scalar | photo | 6 | 308.6 | 4.38 | 73 | yes |
| int-wasm-scalar | photo | 7 | 356.3 | 5.06 | 72 | yes |
| int-wasm-scalar | photo | 8 | 374.6 | 5.32 | 67 | yes |
| int-wasm-simd | solid | 1 | 359.2 | 0.71 | 71 | yes |
| int-wasm-simd | solid | 2 | 654.6 | 1.3 | 65 | yes |
| int-wasm-simd | solid | 3 | 917.7 | 1.82 | 61 | yes |
| int-wasm-simd | solid | 4 | 1165 | 2.31 | 58 | yes |
| int-wasm-simd | solid | 5 | 1046.7 | 2.08 | 42 | yes |
| int-wasm-simd | solid | 6 | 1184.4 | 2.35 | 39 | yes |
| int-wasm-simd | solid | 7 | 881.4 | 1.75 | 25 | yes |
| int-wasm-simd | solid | 8 | 1019.3 | 2.02 | 25 | yes |
| int-wasm-simd | noise | 1 | 90 | 0.9 | 90 | yes |
| int-wasm-simd | noise | 2 | 175.2 | 1.76 | 88 | yes |
| int-wasm-simd | noise | 3 | 247.4 | 2.48 | 83 | yes |
| int-wasm-simd | noise | 4 | 318.8 | 3.2 | 80 | yes |
| int-wasm-simd | noise | 5 | 396.8 | 3.98 | 80 | yes |
| int-wasm-simd | noise | 6 | 449.5 | 4.51 | 75 | yes |
| int-wasm-simd | noise | 7 | 467.1 | 4.69 | 67 | yes |
| int-wasm-simd | noise | 8 | 495 | 4.97 | 62 | yes |
| int-wasm-simd | photo | 1 | 102.4 | 0.88 | 88 | yes |
| int-wasm-simd | photo | 2 | 197.4 | 1.69 | 85 | yes |
| int-wasm-simd | photo | 3 | 285 | 2.45 | 82 | yes |
| int-wasm-simd | photo | 4 | 366.8 | 3.15 | 79 | yes |
| int-wasm-simd | photo | 5 | 439.1 | 3.77 | 75 | yes |
| int-wasm-simd | photo | 6 | 488.2 | 4.19 | 70 | yes |
| int-wasm-simd | photo | 7 | 509 | 4.37 | 62 | yes |
| int-wasm-simd | photo | 8 | 530.5 | 4.55 | 57 | yes |

<a id="table-smalldim-throughput"></a>

### Throughput on synthetic LUTs — narrow input and wide output

`smallDim.throughput` · MPx/s · measured by `harness/small_dim/run.js` · jsCE **1.7.3** · 2026-11-28

**pixels** 1048576 · **grid** 256 · **reps** 5 · **lutMode** float · **dataFormat** int8

| Workflow | Kernel | Output Channels | Grid | MPx/s |
|---|---|---:|---:|---:|
| gray -> RGB | kernel1D | 3 | 256 | 93 |
| gray -> CMYK | kernel1D | 4 | 256 | 82 |
| gray -> 6CLR | kernel1D | 6 | 256 | 65 |
| duotone -> RGB | kernel2D | 3 | 256 | 61.2 |
| duotone -> CMYK | kernel2D | 4 | 256 | 51.9 |
| duotone -> 6CLR | kernel2D | 6 | 256 | 41.3 |
| RGB -> RGB | kernel3D | 3 | 33 | 76.3 |
| RGB -> CMYK | kernel3D | 4 | 33 | 67.8 |
| RGB -> 6CLR | kernel3D | 6 | 33 | 34.6 |
| RGB -> 8CLR | kernel3D | 8 | 33 | 29.5 |
| CMYK -> RGB | kernel4D | 3 | 17 | 44.1 |
| CMYK -> CMYK | kernel4D | 4 | 17 | 35.7 |
| CMYK -> 6CLR | kernel4D | 6 | 17 | 23.8 |

<a id="table-solo-rgb2cmyk"></a>

### Solo control bench — one image, one engine, one process (rgb2cmyk)

`solo.rgb2cmyk` · MPx/s · measured by `harness/solo_photo/solo.js` · jsCE **1.7.3** · 2026-11-28

**image** jacek-dylag-559115_STRAWBERRIES-unsplash · **workflow** rgb2cmyk · **pixels** 1000000 · **warmupMs** 3000 · **samples** 7

| Engine | Median Mpxs | Spread Pct | Processes |
|---|---:|---:|---:|
| int | 47.3 | 1.8 | 5 |
| scalar | 68 | 0.9 | 5 |
| simd | 109.2 | 2 | 5 |

<a id="table-solo-rgb2lab"></a>

### Solo control bench — one image, one engine, one process (rgb2lab)

`solo.rgb2lab` · MPx/s · measured by `harness/solo_photo/solo.js` · jsCE **1.7.3** · 2026-11-28

**image** jacek-dylag-559115_STRAWBERRIES-unsplash · **workflow** rgb2lab · **pixels** 1000000 · **warmupMs** 3000 · **samples** 7

| Engine | Median Mpxs | Spread Pct | Processes |
|---|---:|---:|---:|
| int | 53.7 | 1.7 | 5 |
| scalar | 76.2 | 0.6 | 5 |
| simd | 110.8 | 1.1 | 5 |

## Citation index

Which documents link to which table. A table with no citations is either
new or quoted only in prose — both worth knowing before a re-measurement.

| Table | Cited by |
|---|---|
| [`js.content.rgb-rgb-matrix.1024k`](#table-js-content-rgb-rgb-matrix-1024k) | *not cited yet* |
| [`js.content.rgb-lab.1024k`](#table-js-content-rgb-lab-1024k) | `docs/deepdive/InterpolationLimits.md` |
| [`js.content.rgb-cmyk.1024k`](#table-js-content-rgb-cmyk-1024k) | `README.md`, `docs/deepdive/InterpolationLimits.md` |
| [`js.content.cmyk-rgb.1024k`](#table-js-content-cmyk-rgb-1024k) | `docs/deepdive/InterpolationLimits.md` |
| [`js.content.cmyk-cmyk.1024k`](#table-js-content-cmyk-cmyk-1024k) | *not cited yet* |
| [`js.content.rgb-rgb-softproof.1024k`](#table-js-content-rgb-rgb-softproof-1024k) | *not cited yet* |
| [`js.perimage.rgb-rgb-matrix.1024k`](#table-js-perimage-rgb-rgb-matrix-1024k) | *not cited yet* |
| [`js.perimage.rgb-lab.1024k`](#table-js-perimage-rgb-lab-1024k) | *not cited yet* |
| [`js.perimage.rgb-cmyk.1024k`](#table-js-perimage-rgb-cmyk-1024k) | *not cited yet* |
| [`js.perimage.cmyk-rgb.1024k`](#table-js-perimage-cmyk-rgb-1024k) | *not cited yet* |
| [`js.perimage.cmyk-cmyk.1024k`](#table-js-perimage-cmyk-cmyk-1024k) | *not cited yet* |
| [`js.perimage.rgb-rgb-softproof.1024k`](#table-js-perimage-rgb-rgb-softproof-1024k) | *not cited yet* |
| [`js.sweep.rgb-rgb-matrix.16k`](#table-js-sweep-rgb-rgb-matrix-16k) | *not cited yet* |
| [`js.sweep.rgb-lab.16k`](#table-js-sweep-rgb-lab-16k) | *not cited yet* |
| [`js.sweep.rgb-cmyk.16k`](#table-js-sweep-rgb-cmyk-16k) | *not cited yet* |
| [`js.sweep.cmyk-rgb.16k`](#table-js-sweep-cmyk-rgb-16k) | *not cited yet* |
| [`js.sweep.cmyk-cmyk.16k`](#table-js-sweep-cmyk-cmyk-16k) | *not cited yet* |
| [`js.sweep.rgb-rgb-softproof.16k`](#table-js-sweep-rgb-rgb-softproof-16k) | *not cited yet* |
| [`js.sweep.rgb-rgb-matrix.64k`](#table-js-sweep-rgb-rgb-matrix-64k) | *not cited yet* |
| [`js.sweep.rgb-lab.64k`](#table-js-sweep-rgb-lab-64k) | *not cited yet* |
| [`js.sweep.rgb-cmyk.64k`](#table-js-sweep-rgb-cmyk-64k) | *not cited yet* |
| [`js.sweep.cmyk-rgb.64k`](#table-js-sweep-cmyk-rgb-64k) | *not cited yet* |
| [`js.sweep.cmyk-cmyk.64k`](#table-js-sweep-cmyk-cmyk-64k) | *not cited yet* |
| [`js.sweep.rgb-rgb-softproof.64k`](#table-js-sweep-rgb-rgb-softproof-64k) | *not cited yet* |
| [`js.sweep.rgb-rgb-matrix.1024k`](#table-js-sweep-rgb-rgb-matrix-1024k) | *not cited yet* |
| [`js.sweep.rgb-lab.1024k`](#table-js-sweep-rgb-lab-1024k) | *not cited yet* |
| [`js.sweep.rgb-cmyk.1024k`](#table-js-sweep-rgb-cmyk-1024k) | *not cited yet* |
| [`js.sweep.cmyk-rgb.1024k`](#table-js-sweep-cmyk-rgb-1024k) | *not cited yet* |
| [`js.sweep.cmyk-cmyk.1024k`](#table-js-sweep-cmyk-cmyk-1024k) | *not cited yet* |
| [`js.sweep.rgb-rgb-softproof.1024k`](#table-js-sweep-rgb-rgb-softproof-1024k) | *not cited yet* |
| [`js.sweep.rgb-rgb-matrix.10240k`](#table-js-sweep-rgb-rgb-matrix-10240k) | *not cited yet* |
| [`js.sweep.rgb-lab.10240k`](#table-js-sweep-rgb-lab-10240k) | *not cited yet* |
| [`js.sweep.rgb-cmyk.10240k`](#table-js-sweep-rgb-cmyk-10240k) | *not cited yet* |
| [`js.sweep.cmyk-rgb.10240k`](#table-js-sweep-cmyk-rgb-10240k) | *not cited yet* |
| [`js.sweep.cmyk-cmyk.10240k`](#table-js-sweep-cmyk-cmyk-10240k) | *not cited yet* |
| [`js.sweep.rgb-rgb-softproof.10240k`](#table-js-sweep-rgb-rgb-softproof-10240k) | *not cited yet* |
| [`matrixShaper.accuracy.int16`](#table-matrixshaper-accuracy-int16) | *not cited yet* |
| [`matrixShaper.accuracy.int8`](#table-matrixshaper-accuracy-int8) | `README.md` |
| [`matrixShaper.throughput.int8`](#table-matrixshaper-throughput-int8) | `README.md`, `docs/deepdive/InterpolationLimits.md`, `docs/deepdive/MatrixShaperKernel.md`, `docs/deepdive/README.md` |
| [`matrixShaper.ratios.int8`](#table-matrixshaper-ratios-int8) | *not cited yet* |
| [`matrixShaper.throughput.int16`](#table-matrixshaper-throughput-int16) | `docs/deepdive/MatrixShaperKernel.md` |
| [`matrixShaper.ratios.int16`](#table-matrixshaper-ratios-int16) | *not cited yet* |
| [`pixelCache.accuracyPath.rgb-rgb-matrix`](#table-pixelcache-accuracypath-rgb-rgb-matrix) | *not cited yet* |
| [`pixelCache.accuracyPath.rgb-lab`](#table-pixelcache-accuracypath-rgb-lab) | *not cited yet* |
| [`pixelCache.accuracyPath.rgb-cmyk`](#table-pixelcache-accuracypath-rgb-cmyk) | *not cited yet* |
| [`pixelCache.accuracyPath.cmyk-rgb`](#table-pixelcache-accuracypath-cmyk-rgb) | *not cited yet* |
| [`pixelCache.accuracyPath.cmyk-cmyk`](#table-pixelcache-accuracypath-cmyk-cmyk) | *not cited yet* |
| [`pixelCache.accuracyPath.rgb-rgb-softproof`](#table-pixelcache-accuracypath-rgb-rgb-softproof) | *not cited yet* |
| [`pixelCache.inKernel.rgb-rgb-matrix`](#table-pixelcache-inkernel-rgb-rgb-matrix) | *not cited yet* |
| [`pixelCache.inKernel.rgb-lab`](#table-pixelcache-inkernel-rgb-lab) | *not cited yet* |
| [`pixelCache.inKernel.rgb-cmyk`](#table-pixelcache-inkernel-rgb-cmyk) | `README.md`, `_wip/gh-release-1.6.0.md`, `docs/Bench.md`, `docs/README.md`, `docs/deepdive/PixelCache.md` |
| [`pixelCache.inKernel.cmyk-rgb`](#table-pixelcache-inkernel-cmyk-rgb) | *not cited yet* |
| [`pixelCache.inKernel.cmyk-cmyk`](#table-pixelcache-inkernel-cmyk-cmyk) | *not cited yet* |
| [`pixelCache.inKernel.rgb-rgb-softproof`](#table-pixelcache-inkernel-rgb-rgb-softproof) | *not cited yet* |
| [`pool.matrixShaper.noise`](#table-pool-matrixshaper-noise) | *not cited yet* |
| [`pool.matrixShaper.photo`](#table-pool-matrixshaper-photo) | `docs/deepdive/InterpolationLimits.md` |
| [`pool.peak`](#table-pool-peak) | `docs/deepdive/InterpolationLimits.md`, `docs/deepdive/multicore.md`, `docs/pool.md` |
| [`pool.scaling`](#table-pool-scaling) | `docs/LcmsComparison.md`, `docs/deepdive/multicore.md`, `docs/pool.md` |
| [`smallDim.throughput`](#table-smalldim-throughput) | *not cited yet* |
| [`solo.rgb2cmyk`](#table-solo-rgb2cmyk) | *not cited yet* |
| [`solo.rgb2lab`](#table-solo-rgb2lab) | *not cited yet* |
