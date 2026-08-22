# Benchmark results — generated

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Performance](./deepdive/Performance.md) ·
[LittleCMS comparison](./LcmsComparison.md) ·
[Parallel pool](./pool.md) ·
[Bench](./Bench.md)

---

> **Generated file — do not edit.** Every table was written by the bench
> that measured it (`bench/lib/emit.cjs`) and rendered by
> `scripts/build_bench_results.js`. To refresh:
>
>     node bench/reproduce.js
>     node scripts/build_bench_results.js
>
> Run `2026-08-22T23-09-46` · measured 2026-08-22 · jsCE 1.6.0 · package now **1.6.0**

Other pages should **link to a table here** rather than restating its
numbers: prose keeps the finding, this page owns the figures. The
[citation index](#citation-index) lists what points where, so a
re-measurement is a finite job rather than a search.

## Conditions

| | |
|---|---|
| Date | 2026-08-22 |
| CPU | AMD Ryzen 7 7700X 8-Core Processor              (16 logical) |
| RAM | 31.1 GB |
| JS host | Node v24.16.0, win32 x64 |
| lcms native host | WSL2 (Ubuntu), gcc (Ubuntu 9.3.0-17ubuntu1~20.04) 9.3.0 |
| lcms-wasm version | 1.0.5 |
| jsColorEngine version | 1.6.0 |
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

`js.content.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.3 | 96.6 | 65 | 64.5 | 1.49 |
| gradient | 75 | 256 | 0.01 | 61.9 | 317.6 | 66.6 | 66.2 | 4.77 |
| blocks16 | 93.8 | 4095 | 0.11 | 59.2 | 399.8 | 67.1 | 67.5 | 5.96 |
| solid | 100 | 1 | 0 | 63.4 | 448.9 | 67.7 | 68.2 | 6.63 |
| photo | 13.2 | 41077 | 1.14 | 53.7 | 111.5 | 67.1 | 66.8 | 1.66 |

<a id="table-js-content-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48 | 96.1 | 31 | 37.9 | 3.1 |
| gradient | 75 | 256 | 0.01 | 61.8 | 312.1 | 64.1 | 49.6 | 4.87 |
| blocks16 | 93.8 | 4095 | 0.11 | 60.7 | 403.4 | 75.6 | 48.6 | 5.34 |
| solid | 100 | 1 | 0 | 63.8 | 449.6 | 89.5 | 51.1 | 5.02 |
| photo | 13.2 | 41077 | 1.14 | 53.2 | 112.2 | 35 | 41.2 | 3.2 |

<a id="table-js-content-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 42.9 | 97.6 | 31.7 | 35.8 | 3.08 |
| gradient | 75 | 256 | 0.01 | 54.2 | 299.7 | 64 | 48.6 | 4.68 |
| blocks16 | 93.8 | 4095 | 0.11 | 50.1 | 379.6 | 77.1 | 46.8 | 4.92 |
| solid | 100 | 1 | 0 | 55.3 | 419.7 | 83 | 49 | 5.05 |
| photo | 13.2 | 41077 | 1.14 | 48.5 | 113 | 35 | 39.1 | 3.23 |

<a id="table-js-content-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px

`js.content.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 30.8 | 67.1 | 21.6 | 21.9 | 3.11 |
| gradient | 75 | 256 | 0 | 36.5 | 224.7 | 50.5 | 25.2 | 4.45 |
| blocks16 | 93.8 | 4096 | 0.05 | 35.8 | 323.3 | 69.2 | 25.1 | 4.67 |
| solid | 100 | 1 | 0 | 38.5 | 443.4 | 93 | 26.3 | 4.77 |
| photo | 13.3 | 35074 | 0.42 | 44.5 | 81.2 | 25 | 21.1 | 3.25 |

<a id="table-js-content-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px

`js.content.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 25.8 | 63.9 | 18.4 | 20.5 | 3.48 |
| gradient | 75 | 256 | 0 | 31.2 | 221.3 | 46.9 | 23.3 | 4.72 |
| blocks16 | 93.8 | 4096 | 0.05 | 31.7 | 325.8 | 65.5 | 23.2 | 4.97 |
| solid | 100 | 1 | 0 | 32.4 | 402.5 | 84.1 | 24.1 | 4.79 |
| photo | 13.3 | 35074 | 0.42 | 36.6 | 81 | 23.2 | 23.9 | 3.49 |

<a id="table-js-content-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 47.5 | 97 | 32.8 | 36.5 | 2.96 |
| gradient | 75 | 256 | 0.01 | 62 | 329.4 | 62.9 | 47.6 | 5.24 |
| blocks16 | 93.8 | 4095 | 0.11 | 60.8 | 410.4 | 75.5 | 48.9 | 5.43 |
| solid | 100 | 1 | 0 | 63.6 | 474 | 92.3 | 49.5 | 5.14 |
| photo | 13.2 | 41077 | 1.14 | 53.6 | 110.6 | 35 | 39.2 | 3.16 |

<a id="table-js-perimage-rgb-rgb-matrix-1024k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 55.6 | 115.7 | 67.3 | 67.3 | 1.72 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 52.6 | 106.3 | 67.9 | 67 | 1.57 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 53.5 | 139.2 | 68.1 | 62.9 | 2.04 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 51.8 | 108.8 | 64.2 | 67.4 | 1.7 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 51.3 | 105.2 | 62.5 | 64.9 | 1.68 |

<a id="table-js-perimage-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 54.1 | 115.1 | 34 | 41.9 | 3.39 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 51.9 | 108.6 | 34.8 | 40.7 | 3.12 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 55.4 | 140.1 | 40.7 | 43.2 | 3.44 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 51.7 | 107.8 | 33.3 | 41.1 | 3.24 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 51.1 | 105.7 | 31.5 | 39.8 | 3.36 |

<a id="table-js-perimage-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 48.9 | 115.6 | 35.8 | 39.5 | 3.23 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 46.6 | 109.5 | 33.9 | 37.7 | 3.23 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 49 | 140.8 | 40.3 | 41.4 | 3.5 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 46.6 | 110.3 | 34.8 | 38.7 | 3.17 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 46.3 | 107.5 | 32 | 38 | 3.36 |

<a id="table-js-perimage-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6332 | 0.08 | 35.7 | 81.9 | 25.2 | 24.9 | 3.25 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 17.6 | 103888 | 1.24 | 36.8 | 82.8 | 25.6 | 24 | 3.24 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42.2 | 67211 | 0.8 | 37.3 | 107.7 | 31.8 | 24.6 | 3.39 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 15.6 | 86185 | 1.03 | 36 | 84.9 | 25.8 | 24.6 | 3.3 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 7.1 | 201835 | 2.42 | 36.2 | 80.1 | 24.5 | 24 | 3.27 |

<a id="table-js-perimage-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6332 | 0.08 | 31.2 | 82.4 | 23.2 | 23.8 | 3.54 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 17.6 | 103888 | 1.24 | 31.5 | 82 | 22.8 | 23.3 | 3.6 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42.2 | 67211 | 0.8 | 31.3 | 105.3 | 29.4 | 24 | 3.58 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 15.6 | 86185 | 1.03 | 31.8 | 82.9 | 23.4 | 23.8 | 3.54 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 7.1 | 201835 | 2.42 | 31.1 | 79.5 | 22.4 | 23.6 | 3.55 |

<a id="table-js-perimage-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 54.4 | 116.1 | 34.6 | 38.7 | 3.36 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 52.7 | 105.5 | 34.4 | 37.9 | 3.06 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 55.3 | 139.4 | 41.5 | 42.2 | 3.36 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 52.7 | 108.6 | 35.5 | 36.7 | 3.05 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 51.6 | 105.4 | 32.8 | 37.6 | 3.21 |

<a id="table-js-sweep-rgb-rgb-matrix-16k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-rgb-matrix.16k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 59.8 | 154.2 | 64.1 | 65.2 | 2.4 |

<a id="table-js-sweep-rgb-lab-16k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-lab.16k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 58.6 | 154.3 | 37.4 | 47.8 | 4.12 |

<a id="table-js-sweep-rgb-cmyk-16k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-cmyk.16k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 48.7 | 141.3 | 36.1 | 42.1 | 3.92 |

<a id="table-js-sweep-cmyk-rgb-16k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.cmyk-rgb.16k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 16384 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16384 | 0.2 | 31.8 | 83.6 | 22 | 22 | 3.79 |

<a id="table-js-sweep-cmyk-cmyk-16k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.cmyk-cmyk.16k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 16384 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16384 | 0.2 | 26.6 | 79 | 19.1 | 20.1 | 4.12 |

<a id="table-js-sweep-rgb-rgb-softproof-16k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-rgb-softproof.16k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 59.5 | 154.8 | 35.3 | 46.5 | 4.39 |

<a id="table-js-sweep-rgb-rgb-matrix-64k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-rgb-matrix.64k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 56.2 | 93.9 | 65.1 | 61.6 | 1.44 |

<a id="table-js-sweep-rgb-lab-64k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-lab.64k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 57.4 | 93.7 | 31.4 | 37.3 | 2.98 |

<a id="table-js-sweep-rgb-cmyk-64k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-cmyk.64k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 48.9 | 94.1 | 30.2 | 36 | 3.11 |

<a id="table-js-sweep-cmyk-rgb-64k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.cmyk-rgb.64k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 65536 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65536 | 0.78 | 31 | 64.9 | 21.3 | 21.9 | 3.05 |

<a id="table-js-sweep-cmyk-cmyk-64k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.cmyk-cmyk.64k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 65536 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65536 | 0.78 | 24.5 | 65.1 | 19.1 | 20 | 3.41 |

<a id="table-js-sweep-rgb-rgb-softproof-64k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-rgb-softproof.64k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 55.8 | 91.2 | 32.4 | 36.9 | 2.82 |

<a id="table-js-sweep-rgb-rgb-matrix-1024k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 47.2 | 95 | 68.9 | 63.5 | 1.38 |

<a id="table-js-sweep-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 47.5 | 96.4 | 32.2 | 36.8 | 3 |

<a id="table-js-sweep-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 43.1 | 97.3 | 31.4 | 36.2 | 3.1 |

<a id="table-js-sweep-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 30.8 | 67.5 | 21.8 | 23.3 | 3.1 |

<a id="table-js-sweep-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 25.9 | 67.5 | 19.2 | 20.4 | 3.51 |

<a id="table-js-sweep-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.7 | 96.5 | 32.7 | 36.9 | 2.95 |

<a id="table-js-sweep-rgb-rgb-matrix-10240k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-rgb-matrix.10240k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 49 | 96.7 | 65 | 64.9 | 1.49 |

<a id="table-js-sweep-rgb-lab-10240k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-lab.10240k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 48 | 88.4 | 31.2 | 37.6 | 2.83 |

<a id="table-js-sweep-rgb-cmyk-10240k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-cmyk.10240k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 44.5 | 98.6 | 31.7 | 36.7 | 3.11 |

<a id="table-js-sweep-cmyk-rgb-10240k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.cmyk-rgb.10240k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 10485760 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 10485760 | 125.55 | 31.6 | 68 | 21.9 | 22.1 | 3.1 |

<a id="table-js-sweep-cmyk-cmyk-10240k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.cmyk-cmyk.10240k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 10485760 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 10485760 | 125.55 | 26.6 | 67.6 | 13.7 | 20.7 | 4.93 |

<a id="table-js-sweep-rgb-rgb-softproof-10240k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-rgb-softproof.10240k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 48.3 | 97.3 | 32.8 | 37.3 | 2.97 |

<a id="table-matrixshaper-accuracy-int16"></a>

### Matrix-shaper kernel vs CLUT, accuracy against the exact pipeline, int16

`matrixShaper.accuracy.int16` · LSB · measured by `bench/matrix_shaper_kernel/accuracy.js` · jsCE **1.6.0** · 2026-08-22

**bits** 16 · **coloursPerPair** 113157 · **reference** buildLut:false, wasmMatrixShaper:false

| Pair | Variant | Kernel Max Lsb | Kernel Mean Lsb | Kernel Over1 Pct | Clut Max Lsb | Clut Mean Lsb | Clut Over1 Pct |
|---|---|---:|---:|---:|---:|---:|---:|
| *sRGB -> *AdobeRGB | 16-simd | 1 | 0.1859 | 0 | 1199 | 19.7007 | 41.544 |
| *AdobeRGB -> *sRGB | 16-simd | 1 | 0.1132 | 0 | 3934 | 26.2584 | 61.949 |
| *sRGB -> *prophoto | 16-simd | 1 | 0.176 | 0 | 492 | 9.9191 | 89.242 |
| *prophoto -> *sRGB | 16-simd | 1 | 0.1105 | 0 | 6668 | 54.3403 | 65.499 |
| *sRGB -> *applergb | 16-simd | 1 | 0.1465 | 0 | 2770 | 33.2346 | 29.278 |
| *sRGB -> *colormatch | 16-simd | 1 | 0.1586 | 0 | 1836 | 20.1627 | 65.86 |

<a id="table-matrixshaper-accuracy-int8"></a>

### Matrix-shaper kernel vs CLUT, accuracy against the exact pipeline, int8

`matrixShaper.accuracy.int8` · LSB · measured by `bench/matrix_shaper_kernel/accuracy.js` · jsCE **1.6.0** · 2026-08-22

**bits** 8 · **coloursPerPair** 262144 · **reference** buildLut:false, wasmMatrixShaper:false

| Pair | Variant | Kernel Max Lsb | Kernel Mean Lsb | Kernel Over1 Pct | Clut Max Lsb | Clut Mean Lsb | Clut Over1 Pct |
|---|---|---:|---:|---:|---:|---:|---:|
| *sRGB -> *AdobeRGB | 8-simd | 1 | 0.0013 | 0 | 4 | 0.0349 | 0.594 |
| *AdobeRGB -> *sRGB | 8-simd | 1 | 0.001 | 0 | 19 | 0.0942 | 1.27 |
| *sRGB -> *prophoto | 8-simd | 1 | 0.0012 | 0 | 2 | 0.0125 | 0.001 |
| *prophoto -> *sRGB | 8-simd | 1 | 0.0009 | 0 | 25 | 0.1764 | 2.462 |
| *sRGB -> *applergb | 8-simd | 1 | 0.002 | 0 | 11 | 0.0828 | 1.782 |
| *sRGB -> *colormatch | 8-simd | 1 | 0.0013 | 0 | 7 | 0.0565 | 1.389 |

<a id="table-matrixshaper-throughput-int8"></a>

### Matrix-shaper kernel vs CLUT, int8, *prophoto -> *sRGB

`matrixShaper.throughput.int8` · MPx/s · measured by `bench/matrix_shaper_kernel/throughput.js` · jsCE **1.6.0** · 2026-08-22

**bits** 8 · **pixels** 4194304 · **reps** 5 · **pair** *prophoto → *sRGB · **best** best of 5

| Path | Solid | Noise | Photo |
|---|---:|---:|---:|
| kernel, SIMD | 332.2 | 331.9 | 341.8 |
| kernel, scalar | 205.9 | 71.4 | 187.3 |
| kernel, plain JS | 96.4 | 59 | 92.6 |
| CLUT (default lutMode) | 510.3 | 91.6 | 107 |
| JS stage pipeline | 10.3 | 8.4 | 8.9 |

<a id="table-matrixshaper-ratios-int8"></a>

### Matrix-shaper kernel ratios, int8

`matrixShaper.ratios.int8` · x · measured by `bench/matrix_shaper_kernel/throughput.js` · jsCE **1.6.0** · 2026-08-22

**bits** 8 · **pair** *prophoto → *sRGB

| Content | SIMD / CLUT | SIMD / scalar | SIMD / plain JS | JS / pipeline |
|---|---:|---:|---:|---:|
| solid | 0.65 | 1.61 | 3.44 | 9.4 |
| noise | 3.62 | 4.65 | 5.63 | 7.1 |
| photo | 3.2 | 1.82 | 3.69 | 10.4 |

<a id="table-matrixshaper-throughput-int16"></a>

### Matrix-shaper kernel vs CLUT, int16, *prophoto -> *sRGB

`matrixShaper.throughput.int16` · MPx/s · measured by `bench/matrix_shaper_kernel/throughput.js` · jsCE **1.6.0** · 2026-08-22

**bits** 16 · **pixels** 4194304 · **reps** 5 · **pair** *prophoto → *sRGB · **best** best of 5

| Path | Solid | Noise | Photo |
|---|---:|---:|---:|
| kernel, SIMD | 240.5 | 207.8 | 215.4 |
| kernel, scalar | 105.3 | 64.3 | 102.3 |
| kernel, plain JS | 80.6 | 39.6 | 60.5 |
| CLUT (default lutMode) | 194.3 | 104.8 | 121.8 |
| JS stage pipeline | 10.1 | 8.3 | 8.8 |

<a id="table-matrixshaper-ratios-int16"></a>

### Matrix-shaper kernel ratios, int16

`matrixShaper.ratios.int16` · x · measured by `bench/matrix_shaper_kernel/throughput.js` · jsCE **1.6.0** · 2026-08-22

**bits** 16 · **pair** *prophoto → *sRGB

| Content | SIMD / CLUT | SIMD / scalar | SIMD / plain JS | JS / pipeline |
|---|---:|---:|---:|---:|
| solid | 1.24 | 2.28 | 2.98 | 8 |
| noise | 1.98 | 3.23 | 5.25 | 4.8 |
| photo | 1.77 | 2.11 | 3.56 | 6.8 |

<a id="table-pixelcache-accuracypath-rgb-rgb-matrix"></a>

### Pixel cache (BETA), accuracy path — RGB -> RGB  (matrix)

`pixelCache.accuracyPath.rgb-rgb-matrix` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 258.78 | 260.29 | 255.83 | 0 | -1 |
| gradient | 75 | 259.1 | 269.16 | 262.69 | 0 | 1 |
| blocks16 | 93.8 | 275.96 | 273.18 | 277.73 | 0 | 1 |
| solid | 100 | 279.25 | 277.8 | 278.75 | 0 | 0 |
| photo | 8.6 | 272.96 | 199.68 | 225 | 0 | -18 |

<a id="table-pixelcache-accuracypath-rgb-lab"></a>

### Pixel cache (BETA), accuracy path — RGB -> Lab

`pixelCache.accuracyPath.rgb-lab` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7.77 | 6.3 | 5.93 | 0 | -24 |
| gradient | 75 | 8.19 | 16.11 | 15.45 | 75 | 89 |
| blocks16 | 93.8 | 8.49 | 25.35 | 24.32 | 94.4 | 187 |
| solid | 100 | 8.47 | 32.69 | 29.85 | 100 | 252 |
| photo | 8.6 | 7.98 | 7.11 | 8.46 | 32.8 | 6 |

<a id="table-pixelcache-accuracypath-rgb-cmyk"></a>

### Pixel cache (BETA), accuracy path — RGB -> CMYK

`pixelCache.accuracyPath.rgb-cmyk` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 4.68 | 4.1 | 3.82 | 0 | -18 |
| gradient | 75 | 5.17 | 11.95 | 11.5 | 75 | 123 |
| blocks16 | 93.8 | 5.42 | 20.99 | 19.65 | 94.4 | 263 |
| solid | 100 | 5.29 | 29.32 | 27.61 | 100 | 422 |
| photo | 8.6 | 4.99 | 4.57 | 5.37 | 32.8 | 8 |

<a id="table-pixelcache-accuracypath-cmyk-rgb"></a>

### Pixel cache (BETA), accuracy path — CMYK -> RGB

`pixelCache.accuracyPath.cmyk-rgb` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 5.85 | 4.68 | 4.36 | 0 | -25 |
| gradient | 75 | 6.93 | 13.7 | 13.1 | 75 | 89 |
| blocks16 | 93.8 | 6.94 | 23.08 | 20.81 | 94.4 | 200 |
| solid | 100 | 7.16 | 30.55 | 27.8 | 100 | 288 |
| photo | 8.6 | 6.45 | 5.69 | 6.54 | 31.4 | 1 |

<a id="table-pixelcache-accuracypath-cmyk-cmyk"></a>

### Pixel cache (BETA), accuracy path — CMYK -> CMYK

`pixelCache.accuracyPath.cmyk-cmyk` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 5.24 | 4.39 | 4.23 | 0 | -19 |
| gradient | 75 | 6.61 | 13.35 | 12.29 | 75 | 86 |
| blocks16 | 93.8 | 6.59 | 21.22 | 19.8 | 94.4 | 200 |
| solid | 100 | 7 | 29.29 | 25.89 | 100 | 270 |
| photo | 8.6 | 6.15 | 5.27 | 6.13 | 31.4 | 0 |

<a id="table-pixelcache-accuracypath-rgb-rgb-softproof"></a>

### Pixel cache (BETA), accuracy path — RGB -> RGB  (softproof)

`pixelCache.accuracyPath.rgb-rgb-softproof` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 2.84 | 2.44 | 2.43 | 0 | -14 |
| gradient | 75 | 3.23 | 8.82 | 8.24 | 75 | 155 |
| blocks16 | 93.8 | 3.28 | 17.91 | 17.8 | 94.4 | 443 |
| solid | 100 | 3.29 | 32.76 | 30.08 | 100 | 814 |
| photo | 8.6 | 3.04 | 2.87 | 3.64 | 32.8 | 20 |

<a id="table-pixelcache-inkernel-rgb-rgb-matrix"></a>

### Pixel cache, in-kernel WASM — RGB -> RGB  (matrix)

`pixelCache.inKernel.rgb-rgb-matrix` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 185.9 | 482 | 2.59 | 1 |
| photo | 8.6 | 114.7 | 108.5 | 0.95 | 1 |
| photo with 5% noise added | 0 | 98.6 | 90.7 | 0.92 | 1 |
| noise | 0 | 89 | 89.2 | 1 | 1 |

<a id="table-pixelcache-inkernel-rgb-lab"></a>

### Pixel cache, in-kernel WASM — RGB -> Lab

`pixelCache.inKernel.rgb-lab` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 191.4 | 516.1 | 2.7 | 1 |
| photo | 8.6 | 114.7 | 105.7 | 0.92 | 1 |
| photo with 5% noise added | 0 | 90.6 | 90.9 | 1 | 1 |
| noise | 0 | 90.8 | 90.1 | 0.99 | 1 |

<a id="table-pixelcache-inkernel-rgb-cmyk"></a>

### Pixel cache, in-kernel WASM — RGB -> CMYK

`pixelCache.inKernel.rgb-cmyk` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 178.7 | 437 | 2.44 | 1 |
| photo | 8.6 | 118.2 | 114 | 0.96 | 1 |
| photo with 5% noise added | 0 | 101.7 | 97.5 | 0.96 | 1 |
| noise | 0 | 100.7 | 97.2 | 0.97 | 1 |

<a id="table-pixelcache-inkernel-cmyk-rgb"></a>

### Pixel cache, in-kernel WASM — CMYK -> RGB

`pixelCache.inKernel.cmyk-rgb` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 106.3 | 476.3 | 4.48 | 1 |
| photo | 8.6 | 82.8 | 82.5 | 1 | 1 |
| photo with 5% noise added | 0 | 72.9 | 71.8 | 0.98 | 1 |
| noise | 0 | 70.7 | 67.9 | 0.96 | 1 |

<a id="table-pixelcache-inkernel-cmyk-cmyk"></a>

### Pixel cache, in-kernel WASM — CMYK -> CMYK

`pixelCache.inKernel.cmyk-cmyk` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 101.3 | 409.3 | 4.04 | 1 |
| photo | 8.6 | 79.8 | 79.9 | 1 | 1 |
| photo with 5% noise added | 0 | 70.5 | 69.4 | 0.99 | 1 |
| noise | 0 | 66.3 | 65.1 | 0.98 | 1 |

<a id="table-pixelcache-inkernel-rgb-rgb-softproof"></a>

### Pixel cache, in-kernel WASM — RGB -> RGB  (softproof)

`pixelCache.inKernel.rgb-rgb-softproof` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **lutMode** int-wasm-simd · **hints** 0 vs auto · **baseline** its own uncached image path

| Content | adj % | Off (0) | Auto | Auto / off | cache |
|---|---:|---:|---:|---:|---:|
| solid | 100 | 189.3 | 509 | 2.69 | 1 |
| photo | 8.6 | 114.5 | 106.9 | 0.93 | 1 |
| photo with 5% noise added | 0 | 91.4 | 89.9 | 0.98 | 1 |
| noise | 0 | 89.6 | 98.5 | 1.1 | 1 |

<a id="table-pool-matrixshaper-noise"></a>

### Matrix-shaper kernel vs CLUT in the worker pool — noise

`pool.matrixShaper.noise` · MPx/s · measured by `bench/matrix_shaper_kernel/multicore.js` · jsCE **1.6.0** · 2026-08-22

**content** noise · **pair** *prophoto → *sRGB · **pixels** 4000000 · **runs** 5 · **sequentialClutMpxs** 100.2 · **sequentialKernelMpxs** 316.3 · **maxKernelVsClutLsb** 28

| Workers | Clut Mpxs | Clut Speedup | Clut Eff Pct | Kernel Mpxs | Kernel Speedup | Kernel Eff Pct | Kernel Over Clut | Exact |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 89.2 | 0.89 | 89 | 255.4 | 0.81 | 81 | 2.86 | yes |
| 2 | 177.3 | 1.77 | 88 | 489.2 | 1.55 | 77 | 2.76 | yes |
| 3 | 259.7 | 2.59 | 86 | 683.9 | 2.16 | 72 | 2.63 | yes |
| 4 | 326.1 | 3.25 | 81 | 864.3 | 2.73 | 68 | 2.65 | yes |
| 5 | 395.7 | 3.95 | 79 | 946.4 | 2.99 | 60 | 2.39 | yes |
| 6 | 441.3 | 4.4 | 73 | 1161.3 | 3.67 | 61 | 2.63 | yes |
| 7 | 496.9 | 4.96 | 71 | 1130.5 | 3.57 | 51 | 2.28 | yes |
| 8 | 552.1 | 5.51 | 69 | 1116.7 | 3.53 | 44 | 2.02 | yes |

<a id="table-pool-matrixshaper-photo"></a>

### Matrix-shaper kernel vs CLUT in the worker pool — photo

`pool.matrixShaper.photo` · MPx/s · measured by `bench/matrix_shaper_kernel/multicore.js` · jsCE **1.6.0** · 2026-08-22

**content** photo · **pair** *prophoto → *sRGB · **pixels** 4000000 · **runs** 5 · **sequentialClutMpxs** 118.1 · **sequentialKernelMpxs** 327.5 · **maxKernelVsClutLsb** 25

| Workers | Clut Mpxs | Clut Speedup | Clut Eff Pct | Kernel Mpxs | Kernel Speedup | Kernel Eff Pct | Kernel Over Clut | Exact |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 105.6 | 0.89 | 89 | 258.2 | 0.79 | 79 | 2.45 | yes |
| 2 | 204.8 | 1.73 | 87 | 501.7 | 1.53 | 77 | 2.45 | yes |
| 3 | 295 | 2.5 | 83 | 702.3 | 2.14 | 71 | 2.38 | yes |
| 4 | 381.7 | 3.23 | 81 | 871.6 | 2.66 | 67 | 2.28 | yes |
| 5 | 445.4 | 3.77 | 75 | 1050 | 3.21 | 64 | 2.36 | yes |
| 6 | 498.6 | 4.22 | 70 | 1062.8 | 3.25 | 54 | 2.13 | yes |
| 7 | 563 | 4.77 | 68 | 1013.6 | 3.1 | 44 | 1.8 | yes |
| 8 | 611.7 | 5.18 | 65 | 1064 | 3.25 | 41 | 1.74 | yes |

<a id="table-pool-peak"></a>

### Worker pool — peak speedup vs sequential, by kernel and content

`pool.peak` · x · measured by `bench/multicore_matrix/run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 4194304 · **maxWorkers** 8

| Kernel | Content | Sequential MPx/s | Peak Speedup | At Workers | Peak MPx/s | Efficiency | Exact |
|---|---|---:|---:|---:|---:|---:|---|
| int | solid | 57.8 | 5.89 | 8 | 340.3 | 74 | yes |
| int | noise | 45.5 | 6.27 | 8 | 285 | 78 | yes |
| int | photo | 49.8 | 5.83 | 7 | 290.3 | 83 | yes |
| int-wasm-scalar | solid | 310.2 | 3.49 | 8 | 1082.3 | 44 | yes |
| int-wasm-scalar | noise | 60.3 | 5.25 | 8 | 316.4 | 66 | yes |
| int-wasm-scalar | photo | 71.5 | 5.59 | 8 | 399.7 | 70 | yes |
| int-wasm-simd | solid | 510.6 | 2.33 | 6 | 1188.6 | 39 | yes |
| int-wasm-simd | noise | 100.3 | 5.35 | 8 | 536.1 | 67 | yes |
| int-wasm-simd | photo | 117.2 | 5.18 | 8 | 606.6 | 65 | yes |

<a id="table-pool-scaling"></a>

### Worker pool — every worker count

`pool.scaling` · MPx/s · measured by `bench/multicore_matrix/run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 4194304

| Kernel | Content | Workers | MPx/s | Speedup | Efficiency | Exact |
|---|---|---:|---:|---:|---:|---|
| int | solid | 1 | 52.4 | 0.91 | 91 | yes |
| int | solid | 2 | 103 | 1.78 | 89 | yes |
| int | solid | 3 | 142.3 | 2.46 | 82 | yes |
| int | solid | 4 | 189.9 | 3.29 | 82 | yes |
| int | solid | 5 | 230.5 | 3.99 | 80 | yes |
| int | solid | 6 | 267.9 | 4.64 | 77 | yes |
| int | solid | 7 | 305.3 | 5.28 | 75 | yes |
| int | solid | 8 | 340.3 | 5.89 | 74 | yes |
| int | noise | 1 | 44 | 0.97 | 97 | yes |
| int | noise | 2 | 82.8 | 1.82 | 91 | yes |
| int | noise | 3 | 117.2 | 2.58 | 86 | yes |
| int | noise | 4 | 182.2 | 4.01 | 100 | yes |
| int | noise | 5 | 216.6 | 4.76 | 95 | yes |
| int | noise | 6 | 233.2 | 5.13 | 85 | yes |
| int | noise | 7 | 259.8 | 5.71 | 82 | yes |
| int | noise | 8 | 285 | 6.27 | 78 | yes |
| int | photo | 1 | 46.7 | 0.94 | 94 | yes |
| int | photo | 2 | 89.9 | 1.8 | 90 | yes |
| int | photo | 3 | 130.7 | 2.62 | 87 | yes |
| int | photo | 4 | 177.6 | 3.56 | 89 | yes |
| int | photo | 5 | 222.9 | 4.47 | 89 | yes |
| int | photo | 6 | 273.5 | 5.49 | 91 | yes |
| int | photo | 7 | 290.3 | 5.83 | 83 | yes |
| int | photo | 8 | 282.3 | 5.67 | 71 | yes |
| int-wasm-scalar | solid | 1 | 251.5 | 0.81 | 81 | yes |
| int-wasm-scalar | solid | 2 | 473.6 | 1.53 | 76 | yes |
| int-wasm-scalar | solid | 3 | 655.3 | 2.11 | 70 | yes |
| int-wasm-scalar | solid | 4 | 816.2 | 2.63 | 66 | yes |
| int-wasm-scalar | solid | 5 | 853.3 | 2.75 | 55 | yes |
| int-wasm-scalar | solid | 6 | 1070.6 | 3.45 | 58 | yes |
| int-wasm-scalar | solid | 7 | 984.1 | 3.17 | 45 | yes |
| int-wasm-scalar | solid | 8 | 1082.3 | 3.49 | 44 | yes |
| int-wasm-scalar | noise | 1 | 55.2 | 0.92 | 92 | yes |
| int-wasm-scalar | noise | 2 | 108.8 | 1.8 | 90 | yes |
| int-wasm-scalar | noise | 3 | 159.2 | 2.64 | 88 | yes |
| int-wasm-scalar | noise | 4 | 194.8 | 3.23 | 81 | yes |
| int-wasm-scalar | noise | 5 | 231.4 | 3.84 | 77 | yes |
| int-wasm-scalar | noise | 6 | 195.6 | 3.24 | 54 | yes |
| int-wasm-scalar | noise | 7 | 306.7 | 5.09 | 73 | yes |
| int-wasm-scalar | noise | 8 | 316.4 | 5.25 | 66 | yes |
| int-wasm-scalar | photo | 1 | 65.4 | 0.91 | 91 | yes |
| int-wasm-scalar | photo | 2 | 126.9 | 1.77 | 89 | yes |
| int-wasm-scalar | photo | 3 | 188.3 | 2.63 | 88 | yes |
| int-wasm-scalar | photo | 4 | 243 | 3.4 | 85 | yes |
| int-wasm-scalar | photo | 5 | 276 | 3.86 | 77 | yes |
| int-wasm-scalar | photo | 6 | 332.7 | 4.65 | 77 | yes |
| int-wasm-scalar | photo | 7 | 328.3 | 4.59 | 66 | yes |
| int-wasm-scalar | photo | 8 | 399.7 | 5.59 | 70 | yes |
| int-wasm-simd | solid | 1 | 381.3 | 0.75 | 75 | yes |
| int-wasm-simd | solid | 2 | 666.4 | 1.31 | 65 | yes |
| int-wasm-simd | solid | 3 | 952.9 | 1.87 | 62 | yes |
| int-wasm-simd | solid | 4 | 1184.7 | 2.32 | 58 | yes |
| int-wasm-simd | solid | 5 | 1031.8 | 2.02 | 40 | yes |
| int-wasm-simd | solid | 6 | 1188.6 | 2.33 | 39 | yes |
| int-wasm-simd | solid | 7 | 1038.3 | 2.03 | 29 | yes |
| int-wasm-simd | solid | 8 | 1147.5 | 2.25 | 28 | yes |
| int-wasm-simd | noise | 1 | 91.9 | 0.92 | 92 | yes |
| int-wasm-simd | noise | 2 | 180.1 | 1.8 | 90 | yes |
| int-wasm-simd | noise | 3 | 256.7 | 2.56 | 85 | yes |
| int-wasm-simd | noise | 4 | 339.1 | 3.38 | 85 | yes |
| int-wasm-simd | noise | 5 | 394.6 | 3.93 | 79 | yes |
| int-wasm-simd | noise | 6 | 462.3 | 4.61 | 77 | yes |
| int-wasm-simd | noise | 7 | 514.7 | 5.13 | 73 | yes |
| int-wasm-simd | noise | 8 | 536.1 | 5.35 | 67 | yes |
| int-wasm-simd | photo | 1 | 104.3 | 0.89 | 89 | yes |
| int-wasm-simd | photo | 2 | 203.7 | 1.74 | 87 | yes |
| int-wasm-simd | photo | 3 | 295.4 | 2.52 | 84 | yes |
| int-wasm-simd | photo | 4 | 375.7 | 3.21 | 80 | yes |
| int-wasm-simd | photo | 5 | 462.8 | 3.95 | 79 | yes |
| int-wasm-simd | photo | 6 | 519.2 | 4.43 | 74 | yes |
| int-wasm-simd | photo | 7 | 582.3 | 4.97 | 71 | yes |
| int-wasm-simd | photo | 8 | 606.6 | 5.18 | 65 | yes |

<a id="table-smalldim-throughput"></a>

### Throughput on synthetic LUTs — narrow input and wide output

`smallDim.throughput` · MPx/s · measured by `bench/small_dim/run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **grid** 256 · **reps** 5 · **lutMode** float · **dataFormat** int8

| Workflow | Kernel | Output Channels | Grid | MPx/s |
|---|---|---:|---:|---:|
| gray -> RGB | kernel1D | 3 | 256 | 93.2 |
| gray -> CMYK | kernel1D | 4 | 256 | 82.7 |
| gray -> 6CLR | kernel1D | 6 | 256 | 65.4 |
| duotone -> RGB | kernel2D | 3 | 256 | 61.7 |
| duotone -> CMYK | kernel2D | 4 | 256 | 52.6 |
| duotone -> 6CLR | kernel2D | 6 | 256 | 41.4 |
| RGB -> RGB | kernel3D | 3 | 33 | 77.9 |
| RGB -> CMYK | kernel3D | 4 | 33 | 68.2 |
| RGB -> 6CLR | kernel3D | 6 | 33 | 35.3 |
| RGB -> 8CLR | kernel3D | 8 | 33 | 29.8 |
| CMYK -> RGB | kernel4D | 3 | 17 | 44.6 |
| CMYK -> CMYK | kernel4D | 4 | 17 | 36.4 |
| CMYK -> 6CLR | kernel4D | 6 | 17 | 23.8 |

<a id="table-solo-rgb2cmyk"></a>

### Solo control bench — one image, one engine, one process (rgb2cmyk)

`solo.rgb2cmyk` · MPx/s · measured by `bench/solo_photo/solo.js` · jsCE **1.6.0** · 2026-08-22

**image** jacek-dylag-559115_STRAWBERRIES-unsplash · **workflow** rgb2cmyk · **pixels** 1000000 · **warmupMs** 3000 · **samples** 7

| Engine | Median Mpxs | Spread Pct | Processes |
|---|---:|---:|---:|
| int | 48 | 2.1 | 5 |
| scalar | 68.3 | 0.8 | 5 |
| simd | 109.9 | 0.6 | 5 |

<a id="table-solo-rgb2lab"></a>

### Solo control bench — one image, one engine, one process (rgb2lab)

`solo.rgb2lab` · MPx/s · measured by `bench/solo_photo/solo.js` · jsCE **1.6.0** · 2026-08-22

**image** jacek-dylag-559115_STRAWBERRIES-unsplash · **workflow** rgb2lab · **pixels** 1000000 · **warmupMs** 3000 · **samples** 7

| Engine | Median Mpxs | Spread Pct | Processes |
|---|---:|---:|---:|
| int | 53.4 | 2.7 | 5 |
| scalar | 76.9 | 0.5 | 5 |
| simd | 112 | 0.5 | 5 |

## Citation index

Which documents link to which table. A table with no citations is either
new or quoted only in prose — both worth knowing before a re-measurement.

| Table | Cited by |
|---|---|
| [`js.content.rgb-rgb-matrix.1024k`](#table-js-content-rgb-rgb-matrix-1024k) | *not cited yet* |
| [`js.content.rgb-lab.1024k`](#table-js-content-rgb-lab-1024k) | *not cited yet* |
| [`js.content.rgb-cmyk.1024k`](#table-js-content-rgb-cmyk-1024k) | `README.md` |
| [`js.content.cmyk-rgb.1024k`](#table-js-content-cmyk-rgb-1024k) | *not cited yet* |
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
| [`matrixShaper.throughput.int8`](#table-matrixshaper-throughput-int8) | `README.md`, `docs/deepdive/MatrixShaperKernel.md`, `docs/deepdive/README.md` |
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
| [`pixelCache.inKernel.rgb-cmyk`](#table-pixelcache-inkernel-rgb-cmyk) | `README.md`, `docs/Bench.md`, `docs/README.md`, `docs/deepdive/PixelCache.md` |
| [`pixelCache.inKernel.cmyk-rgb`](#table-pixelcache-inkernel-cmyk-rgb) | *not cited yet* |
| [`pixelCache.inKernel.cmyk-cmyk`](#table-pixelcache-inkernel-cmyk-cmyk) | *not cited yet* |
| [`pixelCache.inKernel.rgb-rgb-softproof`](#table-pixelcache-inkernel-rgb-rgb-softproof) | *not cited yet* |
| [`pool.matrixShaper.noise`](#table-pool-matrixshaper-noise) | *not cited yet* |
| [`pool.matrixShaper.photo`](#table-pool-matrixshaper-photo) | *not cited yet* |
| [`pool.peak`](#table-pool-peak) | `docs/deepdive/multicore.md`, `docs/pool.md` |
| [`pool.scaling`](#table-pool-scaling) | `docs/LcmsComparison.md`, `docs/deepdive/multicore.md`, `docs/pool.md` |
| [`smallDim.throughput`](#table-smalldim-throughput) | *not cited yet* |
| [`solo.rgb2cmyk`](#table-solo-rgb2cmyk) | *not cited yet* |
| [`solo.rgb2lab`](#table-solo-rgb2lab) | *not cited yet* |
