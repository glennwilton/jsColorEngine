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
> Run `2026-11-27T05-31-29` · measured 2026-11-27 · jsCE 1.7.2 · package now **1.7.2**

Other pages should **link to a table here** rather than restating its
numbers: prose keeps the finding, this page owns the figures. The
[citation index](#citation-index) lists what points where, so a
re-measurement is a finite job rather than a search.

## Conditions

| | |
|---|---|
| Date | 2026-11-27 |
| CPU | AMD Ryzen 7 7700X 8-Core Processor              (16 logical) |
| RAM | 31.1 GB |
| JS host | Node v24.16.0, win32 x64 |
| lcms native host | WSL2 (Ubuntu), gcc (Ubuntu 9.3.0-17ubuntu1~20.04) 9.3.0 |
| lcms-wasm version | 1.0.5 |
| jsColorEngine version | 1.7.2 |
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

`js.content.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.6 | 97.3 | 65.2 | 65.3 | 1.49 |
| gradient | 75 | 256 | 0.01 | 62.2 | 328.8 | 66.2 | 66.7 | 4.97 |
| blocks16 | 93.8 | 4095 | 0.11 | 60.9 | 417.3 | 67.3 | 68.2 | 6.2 |
| solid | 100 | 1 | 0 | 64.1 | 488.7 | 68.6 | 68.5 | 7.13 |
| photo | 13.2 | 41077 | 1.14 | 53.1 | 114.1 | 67.1 | 65.6 | 1.7 |

<a id="table-js-content-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.4 | 96.7 | 32.2 | 37.8 | 3 |
| gradient | 75 | 256 | 0.01 | 62.3 | 329.4 | 65.6 | 49.2 | 5.02 |
| blocks16 | 93.8 | 4095 | 0.11 | 60.6 | 419.4 | 76.2 | 49.2 | 5.51 |
| solid | 100 | 1 | 0 | 62.1 | 494.2 | 92.7 | 45.5 | 5.33 |
| photo | 13.2 | 41077 | 1.14 | 54 | 113.9 | 36.3 | 41.8 | 3.14 |

<a id="table-js-content-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 43.7 | 96.3 | 31.3 | 35.7 | 3.08 |
| gradient | 75 | 256 | 0.01 | 54 | 320.9 | 65.2 | 48.9 | 4.93 |
| blocks16 | 93.8 | 4095 | 0.11 | 53.1 | 428 | 77.3 | 47.2 | 5.54 |
| solid | 100 | 1 | 0 | 55.1 | 475.9 | 85.7 | 49.1 | 5.55 |
| photo | 13.2 | 41077 | 1.14 | 48.2 | 115.1 | 35.7 | 40 | 3.22 |

<a id="table-js-content-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px

`js.content.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 30.9 | 67.5 | 21.4 | 22 | 3.15 |
| gradient | 75 | 256 | 0 | 38.4 | 230.6 | 49.8 | 25.4 | 4.63 |
| blocks16 | 93.8 | 4096 | 0.05 | 38.3 | 360.5 | 70.3 | 25.3 | 5.13 |
| solid | 100 | 1 | 0 | 39 | 457.1 | 93 | 26.6 | 4.91 |
| photo | 13.3 | 35074 | 0.42 | 44.3 | 82.7 | 25.6 | 24.4 | 3.23 |

<a id="table-js-content-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px

`js.content.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 26.5 | 67.6 | 19 | 20.7 | 3.56 |
| gradient | 75 | 256 | 0 | 31.8 | 226.8 | 47.4 | 24.5 | 4.78 |
| blocks16 | 93.8 | 4096 | 0.05 | 32.4 | 350.7 | 68.6 | 24.2 | 5.11 |
| solid | 100 | 1 | 0 | 32.5 | 438.7 | 85.1 | 25.5 | 5.16 |
| photo | 13.3 | 35074 | 0.42 | 37.1 | 82.2 | 23.4 | 23.8 | 3.52 |

<a id="table-js-content-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.8 | 97.3 | 32.8 | 37.1 | 2.97 |
| gradient | 75 | 256 | 0.01 | 61.1 | 332.9 | 60 | 47.6 | 5.54 |
| blocks16 | 93.8 | 4095 | 0.11 | 61 | 425.3 | 76.4 | 49.3 | 5.57 |
| solid | 100 | 1 | 0 | 63.6 | 496.6 | 92.8 | 49 | 5.35 |
| photo | 13.2 | 41077 | 1.14 | 54.1 | 114.5 | 35.2 | 39.6 | 3.25 |

<a id="table-js-perimage-rgb-rgb-matrix-1024k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 53.3 | 116.5 | 67 | 67.5 | 1.74 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 52.9 | 107.6 | 67.5 | 67 | 1.59 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 55.7 | 140 | 67.3 | 67.7 | 2.08 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 52.3 | 97.3 | 67.4 | 67.5 | 1.44 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 51.8 | 106.4 | 67.5 | 67 | 1.58 |

<a id="table-js-perimage-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 54.5 | 117.6 | 36.8 | 42.2 | 3.2 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 52.8 | 108.9 | 35.7 | 41.1 | 3.05 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 55.6 | 140.2 | 41.4 | 43.5 | 3.38 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 52.7 | 110 | 35.7 | 41 | 3.08 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 51.5 | 106.5 | 32.9 | 40.5 | 3.24 |

<a id="table-js-perimage-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 48.7 | 118.1 | 35.2 | 39.7 | 3.36 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 47.3 | 110.6 | 32.9 | 37.2 | 3.36 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 49.6 | 141.2 | 41.4 | 41.3 | 3.41 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 47.3 | 111.5 | 33.8 | 39 | 3.3 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 46.8 | 108.3 | 32.5 | 37.7 | 3.33 |

<a id="table-js-perimage-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6332 | 0.08 | 36.3 | 83.6 | 25.4 | 24.5 | 3.29 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 17.6 | 103888 | 1.24 | 37.3 | 83.6 | 25.6 | 24.9 | 3.26 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42.2 | 67211 | 0.8 | 37.5 | 108.7 | 32 | 26.2 | 3.39 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 15.6 | 86185 | 1.03 | 36.3 | 85.6 | 25.9 | 24.6 | 3.3 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 7.1 | 201835 | 2.42 | 34.5 | 80.5 | 24.5 | 24.4 | 3.28 |

<a id="table-js-perimage-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6332 | 0.08 | 31.4 | 83 | 23.5 | 24.1 | 3.54 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 17.6 | 103888 | 1.24 | 31.6 | 83 | 23.4 | 23.6 | 3.55 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42.2 | 67211 | 0.8 | 30.8 | 107.8 | 29.6 | 24.2 | 3.64 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 15.6 | 86185 | 1.03 | 31.9 | 84.6 | 23.5 | 24.1 | 3.6 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 7.1 | 201835 | 2.42 | 30.3 | 79.1 | 22.5 | 23.8 | 3.52 |

<a id="table-js-perimage-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 55 | 116.9 | 34.7 | 39.4 | 3.37 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 52.9 | 108.7 | 35.3 | 38.1 | 3.08 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 54.4 | 140.9 | 42.2 | 42.4 | 3.34 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 53 | 110.7 | 34.2 | 37 | 3.24 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 51.4 | 106.8 | 32.9 | 36.9 | 3.25 |

<a id="table-js-sweep-rgb-rgb-matrix-16k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-rgb-matrix.16k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 60.2 | 140.8 | 66.1 | 65 | 2.13 |

<a id="table-js-sweep-rgb-lab-16k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-lab.16k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 59.5 | 153.6 | 38.9 | 50 | 3.95 |

<a id="table-js-sweep-rgb-cmyk-16k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-cmyk.16k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 51 | 149 | 36.8 | 42.9 | 4.05 |

<a id="table-js-sweep-cmyk-rgb-16k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.cmyk-rgb.16k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 16384 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16384 | 0.2 | 31.5 | 81.9 | 21.8 | 22.3 | 3.76 |

<a id="table-js-sweep-cmyk-cmyk-16k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.cmyk-cmyk.16k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 16384 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16384 | 0.2 | 31 | 77.7 | 19.1 | 20.5 | 4.06 |

<a id="table-js-sweep-rgb-rgb-softproof-16k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-rgb-softproof.16k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 50.2 | 156.6 | 34.9 | 49 | 4.49 |

<a id="table-js-sweep-rgb-rgb-matrix-64k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-rgb-matrix.64k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 56.6 | 95.1 | 65.2 | 64.1 | 1.46 |

<a id="table-js-sweep-rgb-lab-64k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-lab.64k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 57.5 | 94.6 | 31.8 | 38.4 | 2.98 |

<a id="table-js-sweep-rgb-cmyk-64k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-cmyk.64k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 51 | 95.2 | 32 | 36.1 | 2.97 |

<a id="table-js-sweep-cmyk-rgb-64k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.cmyk-rgb.64k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 65536 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65536 | 0.78 | 31.5 | 67.5 | 22 | 22.1 | 3.07 |

<a id="table-js-sweep-cmyk-cmyk-64k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.cmyk-cmyk.64k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 65536 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65536 | 0.78 | 26.6 | 65.1 | 19.2 | 20.4 | 3.38 |

<a id="table-js-sweep-rgb-rgb-softproof-64k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-rgb-softproof.64k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 46 | 93.8 | 33.2 | 37.3 | 2.82 |

<a id="table-js-sweep-rgb-rgb-matrix-1024k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.4 | 97.7 | 65.1 | 65.1 | 1.5 |

<a id="table-js-sweep-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.9 | 97.5 | 31.6 | 38.3 | 3.09 |

<a id="table-js-sweep-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 43.4 | 98.5 | 31.7 | 37.3 | 3.11 |

<a id="table-js-sweep-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 32.1 | 68.5 | 21.7 | 22 | 3.15 |

<a id="table-js-sweep-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 27 | 67.7 | 19.2 | 19.9 | 3.53 |

<a id="table-js-sweep-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.6 | 97.5 | 33.1 | 35.6 | 2.95 |

<a id="table-js-sweep-rgb-rgb-matrix-10240k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-rgb-matrix.10240k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 49.2 | 97.4 | 65.1 | 65.2 | 1.5 |

<a id="table-js-sweep-rgb-lab-10240k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-lab.10240k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 49.1 | 97.5 | 32.2 | 38.5 | 3.03 |

<a id="table-js-sweep-rgb-cmyk-10240k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-cmyk.10240k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 44.6 | 98 | 31.9 | 36.4 | 3.07 |

<a id="table-js-sweep-cmyk-rgb-10240k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.cmyk-rgb.10240k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 10485760 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 10485760 | 125.55 | 30.9 | 68.2 | 21.8 | 22.1 | 3.13 |

<a id="table-js-sweep-cmyk-cmyk-10240k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.cmyk-cmyk.10240k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 10485760 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 10485760 | 125.55 | 26.8 | 67.5 | 19.1 | 19.7 | 3.54 |

<a id="table-js-sweep-rgb-rgb-softproof-10240k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-rgb-softproof.10240k` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 48.7 | 97.8 | 32.8 | 36.6 | 2.98 |

<a id="table-matrixshaper-accuracy-int16"></a>

### Matrix-shaper kernel vs CLUT, accuracy against the exact pipeline, int16

`matrixShaper.accuracy.int16` · LSB · measured by `harness/matrix_shaper_kernel/accuracy.js` · jsCE **1.7.2** · 2026-11-27

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

`matrixShaper.accuracy.int8` · LSB · measured by `harness/matrix_shaper_kernel/accuracy.js` · jsCE **1.7.2** · 2026-11-27

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

`matrixShaper.throughput.int8` · MPx/s · measured by `harness/matrix_shaper_kernel/throughput.js` · jsCE **1.7.2** · 2026-11-27

**bits** 8 · **pixels** 4194304 · **reps** 5 · **pair** *prophoto → *sRGB · **best** best of 5

| Path | Solid | Noise | Photo |
|---|---:|---:|---:|
| kernel, SIMD | 346.7 | 330.5 | 343.4 |
| kernel, scalar | 218.2 | 71.7 | 188.5 |
| kernel, plain JS | 98 | 59.6 | 92.7 |
| CLUT (default lutMode) | 539.5 | 100.2 | 118 |
| JS stage pipeline | 10.2 | 8.4 | 9 |

<a id="table-matrixshaper-ratios-int8"></a>

### Matrix-shaper kernel ratios, int8

`matrixShaper.ratios.int8` · x · measured by `harness/matrix_shaper_kernel/throughput.js` · jsCE **1.7.2** · 2026-11-27

**bits** 8 · **pair** *prophoto → *sRGB

| Content | SIMD / CLUT | SIMD / scalar | SIMD / plain JS | JS / pipeline |
|---|---:|---:|---:|---:|
| solid | 0.64 | 1.59 | 3.54 | 9.6 |
| noise | 3.3 | 4.61 | 5.54 | 7.1 |
| photo | 2.91 | 1.82 | 3.7 | 10.3 |

<a id="table-matrixshaper-throughput-int16"></a>

### Matrix-shaper kernel vs CLUT, int16, *prophoto -> *sRGB

`matrixShaper.throughput.int16` · MPx/s · measured by `harness/matrix_shaper_kernel/throughput.js` · jsCE **1.7.2** · 2026-11-27

**bits** 16 · **pixels** 4194304 · **reps** 5 · **pair** *prophoto → *sRGB · **best** best of 5

| Path | Solid | Noise | Photo |
|---|---:|---:|---:|
| kernel, SIMD | 244.9 | 208.2 | 224.5 |
| kernel, scalar | 106.7 | 65 | 102.1 |
| kernel, plain JS | 80.5 | 39.4 | 60.2 |
| CLUT (default lutMode) | 197.7 | 104.3 | 123 |
| JS stage pipeline | 10 | 8.3 | 8.9 |

<a id="table-matrixshaper-ratios-int16"></a>

### Matrix-shaper kernel ratios, int16

`matrixShaper.ratios.int16` · x · measured by `harness/matrix_shaper_kernel/throughput.js` · jsCE **1.7.2** · 2026-11-27

**bits** 16 · **pair** *prophoto → *sRGB

| Content | SIMD / CLUT | SIMD / scalar | SIMD / plain JS | JS / pipeline |
|---|---:|---:|---:|---:|
| solid | 1.24 | 2.29 | 3.04 | 8 |
| noise | 2 | 3.2 | 5.29 | 4.7 |
| photo | 1.82 | 2.2 | 3.73 | 6.8 |

<a id="table-pixelcache-accuracypath-rgb-rgb-matrix"></a>

### Pixel cache (BETA), accuracy path — RGB -> RGB  (matrix)

`pixelCache.accuracyPath.rgb-rgb-matrix` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 259.87 | 268.07 | 264.39 | 0 | 2 |
| gradient | 75 | 270.56 | 273.2 | 268.65 | 0 | -1 |
| blocks16 | 93.8 | 280.03 | 278.32 | 279.73 | 0 | 0 |
| solid | 100 | 285.57 | 279.62 | 284.48 | 0 | 0 |
| photo | 8.6 | 278.45 | 279.41 | 271.65 | 0 | -2 |

<a id="table-pixelcache-accuracypath-rgb-lab"></a>

### Pixel cache (BETA), accuracy path — RGB -> Lab

`pixelCache.accuracyPath.rgb-lab` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7.94 | 6.63 | 6.34 | 0 | -20 |
| gradient | 75 | 8.63 | 16.76 | 16.08 | 75 | 86 |
| blocks16 | 93.8 | 8.66 | 25.85 | 24.89 | 94.4 | 187 |
| solid | 100 | 8.68 | 33.67 | 30.51 | 100 | 251 |
| photo | 8.6 | 8.24 | 7.38 | 8.6 | 32.8 | 4 |

<a id="table-pixelcache-accuracypath-rgb-cmyk"></a>

### Pixel cache (BETA), accuracy path — RGB -> CMYK

`pixelCache.accuracyPath.rgb-cmyk` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 4.8 | 4.08 | 4.08 | 0 | -15 |
| gradient | 75 | 5.41 | 12.5 | 12.05 | 75 | 123 |
| blocks16 | 93.8 | 5.49 | 21.96 | 21.21 | 94.4 | 287 |
| solid | 100 | 5.48 | 30.83 | 28.43 | 100 | 419 |
| photo | 8.6 | 5.11 | 4.66 | 5.75 | 32.8 | 13 |

<a id="table-pixelcache-accuracypath-cmyk-rgb"></a>

### Pixel cache (BETA), accuracy path — CMYK -> RGB

`pixelCache.accuracyPath.cmyk-rgb` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 5.98 | 4.98 | 4.73 | 0 | -21 |
| gradient | 75 | 7.13 | 14.44 | 13.56 | 75 | 90 |
| blocks16 | 93.8 | 7.18 | 23.41 | 22.21 | 94.4 | 209 |
| solid | 100 | 7.27 | 31.27 | 28.53 | 100 | 293 |
| photo | 8.6 | 6.58 | 5.66 | 6.54 | 31.4 | -1 |

<a id="table-pixelcache-accuracypath-cmyk-cmyk"></a>

### Pixel cache (BETA), accuracy path — CMYK -> CMYK

`pixelCache.accuracyPath.cmyk-cmyk` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 5.36 | 4.46 | 4.29 | 0 | -20 |
| gradient | 75 | 6.72 | 13.44 | 12.61 | 75 | 87 |
| blocks16 | 93.8 | 6.77 | 21.68 | 20.77 | 94.4 | 207 |
| solid | 100 | 6.88 | 29.35 | 26.88 | 100 | 291 |
| photo | 8.6 | 6.32 | 5.33 | 6.16 | 31.4 | -2 |

<a id="table-pixelcache-accuracypath-rgb-rgb-softproof"></a>

### Pixel cache (BETA), accuracy path — RGB -> RGB  (softproof)

`pixelCache.accuracyPath.rgb-rgb-softproof` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 2.94 | 2.61 | 2.52 | 0 | -14 |
| gradient | 75 | 3.36 | 9.09 | 8.7 | 75 | 159 |
| blocks16 | 93.8 | 3.28 | 18.96 | 18.69 | 94.4 | 471 |
| solid | 100 | 3.46 | 33.09 | 29.66 | 100 | 757 |
| photo | 8.6 | 3.16 | 2.97 | 3.76 | 32.8 | 19 |

<a id="table-pixelcache-inkernel-rgb-rgb-matrix"></a>

### Pixel cache, in-kernel WASM — RGB -> RGB  (matrix)

`pixelCache.inKernel.rgb-rgb-matrix` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 190.2 | 496.8 | 2.61 | 1 |
| photo | 8.6 | 115.2 | 108.7 | 0.94 | 1 |
| photo with 5% noise added | 0 | 101.1 | 92 | 0.91 | 1 |
| noise | 0 | 91.3 | 89.4 | 0.98 | 1 |

<a id="table-pixelcache-inkernel-rgb-lab"></a>

### Pixel cache, in-kernel WASM — RGB -> Lab

`pixelCache.inKernel.rgb-lab` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 192.5 | 510.3 | 2.65 | 1 |
| photo | 8.6 | 114.9 | 109.1 | 0.95 | 1 |
| photo with 5% noise added | 0 | 101.7 | 91.7 | 0.9 | 1 |
| noise | 0 | 91.5 | 90.7 | 0.99 | 1 |

<a id="table-pixelcache-inkernel-rgb-cmyk"></a>

### Pixel cache, in-kernel WASM — RGB -> CMYK

`pixelCache.inKernel.rgb-cmyk` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 177.8 | 445.1 | 2.5 | 1 |
| photo | 8.6 | 120.6 | 116 | 0.96 | 1 |
| photo with 5% noise added | 0 | 103 | 99.2 | 0.96 | 1 |
| noise | 0 | 100.7 | 97.4 | 0.97 | 1 |

<a id="table-pixelcache-inkernel-cmyk-rgb"></a>

### Pixel cache, in-kernel WASM — CMYK -> RGB

`pixelCache.inKernel.cmyk-rgb` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 106.3 | 484.1 | 4.55 | 1 |
| photo | 8.6 | 84.6 | 83.4 | 0.99 | 1 |
| photo with 5% noise added | 0 | 73.5 | 72.3 | 0.98 | 1 |
| noise | 0 | 71.2 | 69.7 | 0.98 | 1 |

<a id="table-pixelcache-inkernel-cmyk-cmyk"></a>

### Pixel cache, in-kernel WASM — CMYK -> CMYK

`pixelCache.inKernel.cmyk-cmyk` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 104 | 410.1 | 3.94 | 1 |
| photo | 8.6 | 81.5 | 80.3 | 0.99 | 1 |
| photo with 5% noise added | 0 | 71.4 | 70.1 | 0.98 | 1 |
| noise | 0 | 67.5 | 67.3 | 1 | 1 |

<a id="table-pixelcache-inkernel-rgb-rgb-softproof"></a>

### Pixel cache, in-kernel WASM — RGB -> RGB  (softproof)

`pixelCache.inKernel.rgb-rgb-softproof` · MPx/s · measured by `run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 193.3 | 514.6 | 2.66 | 1 |
| photo | 8.6 | 115.5 | 109.1 | 0.94 | 1 |
| photo with 5% noise added | 0 | 91.4 | 102.1 | 1.12 | 1 |
| noise | 0 | 91.3 | 90.6 | 0.99 | 1 |

<a id="table-pool-matrixshaper-noise"></a>

### Matrix-shaper kernel vs CLUT in the worker pool — noise

`pool.matrixShaper.noise` · MPx/s · measured by `harness/matrix_shaper_kernel/multicore.js` · jsCE **1.7.2** · 2026-11-27

**content** noise · **pair** *prophoto → *sRGB · **pixels** 4000000 · **runs** 5 · **sequentialClutMpxs** 101.6 · **sequentialKernelMpxs** 322.9 · **maxKernelVsClutLsb** 28

| Workers | Clut Mpxs | Clut Speedup | Clut Eff Pct | Kernel Mpxs | Kernel Speedup | Kernel Eff Pct | Kernel Over Clut | Exact |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 91 | 0.9 | 90 | 260.3 | 0.81 | 81 | 2.86 | yes |
| 2 | 179.9 | 1.77 | 89 | 503.2 | 1.56 | 78 | 2.8 | yes |
| 3 | 265.7 | 2.62 | 87 | 646.1 | 2 | 67 | 2.43 | yes |
| 4 | 344.6 | 3.39 | 85 | 886.5 | 2.75 | 69 | 2.57 | yes |
| 5 | 402.5 | 3.96 | 79 | 1039 | 3.22 | 64 | 2.58 | yes |
| 6 | 492.8 | 4.85 | 81 | 1164.1 | 3.61 | 60 | 2.36 | yes |
| 7 | 507.4 | 5 | 71 | 1275.2 | 3.95 | 56 | 2.51 | yes |
| 8 | 529.6 | 5.21 | 65 | 1104.7 | 3.42 | 43 | 2.09 | yes |

<a id="table-pool-matrixshaper-photo"></a>

### Matrix-shaper kernel vs CLUT in the worker pool — photo

`pool.matrixShaper.photo` · MPx/s · measured by `harness/matrix_shaper_kernel/multicore.js` · jsCE **1.7.2** · 2026-11-27

**content** photo · **pair** *prophoto → *sRGB · **pixels** 4000000 · **runs** 5 · **sequentialClutMpxs** 113.3 · **sequentialKernelMpxs** 322.5 · **maxKernelVsClutLsb** 25

| Workers | Clut Mpxs | Clut Speedup | Clut Eff Pct | Kernel Mpxs | Kernel Speedup | Kernel Eff Pct | Kernel Over Clut | Exact |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 106.5 | 0.94 | 94 | 266.5 | 0.83 | 83 | 2.5 | yes |
| 2 | 208.9 | 1.84 | 92 | 521 | 1.62 | 81 | 2.49 | yes |
| 3 | 302.3 | 2.67 | 89 | 716.1 | 2.22 | 74 | 2.37 | yes |
| 4 | 383.4 | 3.39 | 85 | 902.9 | 2.8 | 70 | 2.36 | yes |
| 5 | 459 | 4.05 | 81 | 1004.3 | 3.11 | 62 | 2.19 | yes |
| 6 | 538.5 | 4.75 | 79 | 1187.4 | 3.68 | 61 | 2.21 | yes |
| 7 | 588.2 | 5.19 | 74 | 1050.8 | 3.26 | 47 | 1.79 | yes |
| 8 | 636.5 | 5.62 | 70 | 1269.6 | 3.94 | 49 | 1.99 | yes |

<a id="table-pool-peak"></a>

### Worker pool — peak speedup vs sequential, by kernel and content

`pool.peak` · x · measured by `harness/multicore_matrix/run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 4194304 · **maxWorkers** 8

| Kernel | Content | Sequential MPx/s | Peak Speedup | At Workers | Peak MPx/s | Efficiency | Exact |
|---|---|---:|---:|---:|---:|---:|---|
| int | solid | 58.1 | 6.38 | 8 | 371 | 80 | yes |
| int | noise | 46.1 | 5.91 | 8 | 272.7 | 74 | yes |
| int | photo | 50.4 | 6.13 | 8 | 308.5 | 77 | yes |
| int-wasm-scalar | solid | 311.7 | 3.59 | 6 | 1120.1 | 60 | yes |
| int-wasm-scalar | noise | 59.1 | 5.63 | 8 | 332.9 | 70 | yes |
| int-wasm-scalar | photo | 71.6 | 6.02 | 8 | 431 | 75 | yes |
| int-wasm-simd | solid | 517.7 | 2.45 | 6 | 1265.7 | 41 | yes |
| int-wasm-simd | noise | 101.5 | 5.51 | 8 | 559 | 69 | yes |
| int-wasm-simd | photo | 118.9 | 4.91 | 8 | 583.7 | 61 | yes |

<a id="table-pool-scaling"></a>

### Worker pool — every worker count

`pool.scaling` · MPx/s · measured by `harness/multicore_matrix/run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 4194304

| Kernel | Content | Workers | MPx/s | Speedup | Efficiency | Exact |
|---|---|---:|---:|---:|---:|---|
| int | solid | 1 | 52.6 | 0.9 | 90 | yes |
| int | solid | 2 | 103.7 | 1.78 | 89 | yes |
| int | solid | 3 | 153.8 | 2.64 | 88 | yes |
| int | solid | 4 | 201.4 | 3.46 | 87 | yes |
| int | solid | 5 | 235.8 | 4.06 | 81 | yes |
| int | solid | 6 | 270.9 | 4.66 | 78 | yes |
| int | solid | 7 | 329 | 5.66 | 81 | yes |
| int | solid | 8 | 371 | 6.38 | 80 | yes |
| int | noise | 1 | 44.3 | 0.96 | 96 | yes |
| int | noise | 2 | 84 | 1.82 | 91 | yes |
| int | noise | 3 | 123.8 | 2.69 | 90 | yes |
| int | noise | 4 | 182.9 | 3.97 | 99 | yes |
| int | noise | 5 | 222.1 | 4.82 | 96 | yes |
| int | noise | 6 | 238.6 | 5.17 | 86 | yes |
| int | noise | 7 | 246 | 5.34 | 76 | yes |
| int | noise | 8 | 272.7 | 5.91 | 74 | yes |
| int | photo | 1 | 47.2 | 0.94 | 94 | yes |
| int | photo | 2 | 91.3 | 1.81 | 91 | yes |
| int | photo | 3 | 136.7 | 2.72 | 91 | yes |
| int | photo | 4 | 206.4 | 4.1 | 102 | yes |
| int | photo | 5 | 243.7 | 4.84 | 97 | yes |
| int | photo | 6 | 282.2 | 5.6 | 93 | yes |
| int | photo | 7 | 277.6 | 5.51 | 79 | yes |
| int | photo | 8 | 308.5 | 6.13 | 77 | yes |
| int-wasm-scalar | solid | 1 | 252.3 | 0.81 | 81 | yes |
| int-wasm-scalar | solid | 2 | 478.8 | 1.54 | 77 | yes |
| int-wasm-scalar | solid | 3 | 667.1 | 2.14 | 71 | yes |
| int-wasm-scalar | solid | 4 | 828.6 | 2.66 | 66 | yes |
| int-wasm-scalar | solid | 5 | 976.5 | 3.13 | 63 | yes |
| int-wasm-scalar | solid | 6 | 1120.1 | 3.59 | 60 | yes |
| int-wasm-scalar | solid | 7 | 972.6 | 3.12 | 45 | yes |
| int-wasm-scalar | solid | 8 | 878 | 2.82 | 35 | yes |
| int-wasm-scalar | noise | 1 | 55.8 | 0.94 | 94 | yes |
| int-wasm-scalar | noise | 2 | 110.7 | 1.87 | 94 | yes |
| int-wasm-scalar | noise | 3 | 161.4 | 2.73 | 91 | yes |
| int-wasm-scalar | noise | 4 | 213.7 | 3.61 | 90 | yes |
| int-wasm-scalar | noise | 5 | 254 | 4.29 | 86 | yes |
| int-wasm-scalar | noise | 6 | 304 | 5.14 | 86 | yes |
| int-wasm-scalar | noise | 7 | 325.9 | 5.51 | 79 | yes |
| int-wasm-scalar | noise | 8 | 332.9 | 5.63 | 70 | yes |
| int-wasm-scalar | photo | 1 | 65.7 | 0.92 | 92 | yes |
| int-wasm-scalar | photo | 2 | 130.3 | 1.82 | 91 | yes |
| int-wasm-scalar | photo | 3 | 192.7 | 2.69 | 90 | yes |
| int-wasm-scalar | photo | 4 | 248.1 | 3.47 | 87 | yes |
| int-wasm-scalar | photo | 5 | 284.6 | 3.98 | 80 | yes |
| int-wasm-scalar | photo | 6 | 355.7 | 4.97 | 83 | yes |
| int-wasm-scalar | photo | 7 | 357.4 | 4.99 | 71 | yes |
| int-wasm-scalar | photo | 8 | 431 | 6.02 | 75 | yes |
| int-wasm-simd | solid | 1 | 384.3 | 0.74 | 74 | yes |
| int-wasm-simd | solid | 2 | 691.4 | 1.34 | 67 | yes |
| int-wasm-simd | solid | 3 | 975.7 | 1.88 | 63 | yes |
| int-wasm-simd | solid | 4 | 1206.1 | 2.33 | 58 | yes |
| int-wasm-simd | solid | 5 | 1159.5 | 2.24 | 45 | yes |
| int-wasm-simd | solid | 6 | 1265.7 | 2.45 | 41 | yes |
| int-wasm-simd | solid | 7 | 1027.5 | 1.98 | 28 | yes |
| int-wasm-simd | solid | 8 | 1132.7 | 2.19 | 27 | yes |
| int-wasm-simd | noise | 1 | 92 | 0.91 | 91 | yes |
| int-wasm-simd | noise | 2 | 180.9 | 1.78 | 89 | yes |
| int-wasm-simd | noise | 3 | 262.6 | 2.59 | 86 | yes |
| int-wasm-simd | noise | 4 | 343.1 | 3.38 | 84 | yes |
| int-wasm-simd | noise | 5 | 403.5 | 3.97 | 79 | yes |
| int-wasm-simd | noise | 6 | 476.9 | 4.7 | 78 | yes |
| int-wasm-simd | noise | 7 | 512.2 | 5.04 | 72 | yes |
| int-wasm-simd | noise | 8 | 559 | 5.51 | 69 | yes |
| int-wasm-simd | photo | 1 | 106.6 | 0.9 | 90 | yes |
| int-wasm-simd | photo | 2 | 206.7 | 1.74 | 87 | yes |
| int-wasm-simd | photo | 3 | 290.7 | 2.45 | 82 | yes |
| int-wasm-simd | photo | 4 | 386.9 | 3.25 | 81 | yes |
| int-wasm-simd | photo | 5 | 446.9 | 3.76 | 75 | yes |
| int-wasm-simd | photo | 6 | 536.9 | 4.52 | 75 | yes |
| int-wasm-simd | photo | 7 | 577.2 | 4.86 | 69 | yes |
| int-wasm-simd | photo | 8 | 583.7 | 4.91 | 61 | yes |

<a id="table-smalldim-throughput"></a>

### Throughput on synthetic LUTs — narrow input and wide output

`smallDim.throughput` · MPx/s · measured by `harness/small_dim/run.js` · jsCE **1.7.2** · 2026-11-27

**pixels** 1048576 · **grid** 256 · **reps** 5 · **lutMode** float · **dataFormat** int8

| Workflow | Kernel | Output Channels | Grid | MPx/s |
|---|---|---:|---:|---:|
| gray -> RGB | kernel1D | 3 | 256 | 93 |
| gray -> CMYK | kernel1D | 4 | 256 | 83.1 |
| gray -> 6CLR | kernel1D | 6 | 256 | 65.8 |
| duotone -> RGB | kernel2D | 3 | 256 | 61.3 |
| duotone -> CMYK | kernel2D | 4 | 256 | 52.7 |
| duotone -> 6CLR | kernel2D | 6 | 256 | 41.6 |
| RGB -> RGB | kernel3D | 3 | 33 | 76.6 |
| RGB -> CMYK | kernel3D | 4 | 33 | 68 |
| RGB -> 6CLR | kernel3D | 6 | 33 | 34.9 |
| RGB -> 8CLR | kernel3D | 8 | 33 | 29.7 |
| CMYK -> RGB | kernel4D | 3 | 17 | 44.2 |
| CMYK -> CMYK | kernel4D | 4 | 17 | 36.5 |
| CMYK -> 6CLR | kernel4D | 6 | 17 | 24 |

<a id="table-solo-rgb2cmyk"></a>

### Solo control bench — one image, one engine, one process (rgb2cmyk)

`solo.rgb2cmyk` · MPx/s · measured by `harness/solo_photo/solo.js` · jsCE **1.7.2** · 2026-11-27

**image** jacek-dylag-559115_STRAWBERRIES-unsplash · **workflow** rgb2cmyk · **pixels** 1000000 · **warmupMs** 3000 · **samples** 7

| Engine | Median Mpxs | Spread Pct | Processes |
|---|---:|---:|---:|
| int | 48.2 | 1.7 | 5 |
| scalar | 68.9 | 0.7 | 5 |
| simd | 111.4 | 0.6 | 5 |

<a id="table-solo-rgb2lab"></a>

### Solo control bench — one image, one engine, one process (rgb2lab)

`solo.rgb2lab` · MPx/s · measured by `harness/solo_photo/solo.js` · jsCE **1.7.2** · 2026-11-27

**image** jacek-dylag-559115_STRAWBERRIES-unsplash · **workflow** rgb2lab · **pixels** 1000000 · **warmupMs** 3000 · **samples** 7

| Engine | Median Mpxs | Spread Pct | Processes |
|---|---:|---:|---:|
| int | 53.6 | 2.2 | 5 |
| scalar | 77.2 | 0.6 | 5 |
| simd | 112.6 | 4.5 | 5 |

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
