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
> Run `2026-08-22T22-31-22` · measured 2026-08-22 · jsCE 1.6.0 · package now **1.6.0**

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
| noise | 0 | 1016892 | 28.3 | 47.7 | 96.7 | 64.7 | 64.2 | 1.5 |
| gradient | 75 | 256 | 0.01 | 62.3 | 326.4 | 66.7 | 65 | 4.9 |
| blocks16 | 93.8 | 4095 | 0.11 | 60.4 | 432.6 | 59 | 66.7 | 7.33 |
| solid | 100 | 1 | 0 | 62.5 | 480.7 | 68.5 | 71.7 | 7.01 |
| photo | 13.2 | 41077 | 1.14 | 54.4 | 113 | 66.1 | 66.4 | 1.71 |

<a id="table-js-content-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 47 | 95.3 | 31.5 | 37 | 3.03 |
| gradient | 75 | 256 | 0.01 | 60.8 | 313.9 | 64.6 | 48.3 | 4.86 |
| blocks16 | 93.8 | 4095 | 0.11 | 60.9 | 428.3 | 76.5 | 49.5 | 5.59 |
| solid | 100 | 1 | 0 | 62.7 | 484.5 | 93.1 | 51.4 | 5.21 |
| photo | 13.2 | 41077 | 1.14 | 53.9 | 112.9 | 34.6 | 41.9 | 3.26 |

<a id="table-js-content-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 43.8 | 98 | 31.9 | 36.1 | 3.08 |
| gradient | 75 | 256 | 0.01 | 53.9 | 318.6 | 63.9 | 48.4 | 4.99 |
| blocks16 | 93.8 | 4095 | 0.11 | 51.9 | 407.7 | 77.3 | 45.9 | 5.27 |
| solid | 100 | 1 | 0 | 54.1 | 455.9 | 84.3 | 48.5 | 5.41 |
| photo | 13.2 | 41077 | 1.14 | 47.3 | 114.3 | 35.3 | 39.3 | 3.24 |

<a id="table-js-content-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px

`js.content.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 32.2 | 67.4 | 21.6 | 22.1 | 3.12 |
| gradient | 75 | 256 | 0 | 38.4 | 224.8 | 50.4 | 25.7 | 4.46 |
| blocks16 | 93.8 | 4096 | 0.05 | 38.3 | 354.6 | 69.3 | 25.3 | 5.12 |
| solid | 100 | 1 | 0 | 38.9 | 451.5 | 93.8 | 26.2 | 4.82 |
| photo | 13.3 | 35074 | 0.42 | 44.4 | 80.7 | 25.6 | 24.1 | 3.15 |

<a id="table-js-content-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px

`js.content.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 26.7 | 67.5 | 19.3 | 20.5 | 3.49 |
| gradient | 75 | 256 | 0 | 32.4 | 222 | 47.7 | 24.4 | 4.65 |
| blocks16 | 93.8 | 4096 | 0.05 | 32.1 | 343.3 | 68.5 | 24.2 | 5.01 |
| solid | 100 | 1 | 0 | 32.4 | 426.3 | 85 | 25.1 | 5.02 |
| photo | 13.3 | 35074 | 0.42 | 37.1 | 81.2 | 23.3 | 23.9 | 3.49 |

<a id="table-js-content-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.9 | 97 | 33.1 | 37.3 | 2.92 |
| gradient | 75 | 256 | 0.01 | 62.5 | 329.2 | 58.6 | 47.8 | 5.62 |
| blocks16 | 93.8 | 4095 | 0.11 | 57.2 | 428.2 | 75.7 | 45.6 | 5.66 |
| solid | 100 | 1 | 0 | 58.5 | 471.8 | 92.6 | 48.4 | 5.1 |
| photo | 13.2 | 41077 | 1.14 | 54 | 113.6 | 34.6 | 39.9 | 3.28 |

<a id="table-js-perimage-rgb-rgb-matrix-1024k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 53.5 | 117.7 | 66.1 | 67.5 | 1.78 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 52.5 | 109.5 | 67.1 | 65.2 | 1.63 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 55.6 | 140.2 | 62.6 | 67.3 | 2.24 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 53.3 | 109.7 | 67 | 67.1 | 1.64 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 52.2 | 106 | 67.4 | 63.6 | 1.57 |

<a id="table-js-perimage-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 53.8 | 116 | 37.1 | 42.5 | 3.12 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 51 | 104.1 | 33.6 | 40.9 | 3.1 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 55.3 | 128.3 | 40.9 | 43.5 | 3.13 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 51.9 | 109.5 | 34.5 | 41 | 3.18 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 52.1 | 102.4 | 34.9 | 40.3 | 2.93 |

<a id="table-js-perimage-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 49 | 118 | 35.5 | 39.9 | 3.32 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 47.3 | 108.2 | 34.3 | 38.7 | 3.16 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 49.7 | 141.2 | 40.4 | 41.4 | 3.5 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 45.6 | 111.8 | 33.7 | 38.9 | 3.32 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 46.8 | 108.5 | 32.4 | 38.1 | 3.35 |

<a id="table-js-perimage-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6332 | 0.08 | 37.1 | 83 | 25.5 | 24.9 | 3.26 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 17.6 | 103888 | 1.24 | 36.7 | 83.4 | 25.6 | 23.7 | 3.26 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42.2 | 67211 | 0.8 | 37.4 | 109.1 | 32.2 | 24.5 | 3.38 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 15.6 | 86185 | 1.03 | 37.8 | 85.5 | 25.7 | 24 | 3.33 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 7.1 | 201835 | 2.42 | 35.7 | 78.2 | 23.8 | 23.6 | 3.29 |

<a id="table-js-perimage-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6332 | 0.08 | 30.2 | 79.1 | 22.9 | 23.4 | 3.46 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 17.6 | 103888 | 1.24 | 31.7 | 81 | 23.2 | 23.5 | 3.49 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42.2 | 67211 | 0.8 | 31.5 | 104.8 | 29.6 | 25 | 3.54 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 15.6 | 86185 | 1.03 | 30.5 | 82.3 | 23.3 | 24.2 | 3.54 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 7.1 | 201835 | 2.42 | 31.2 | 78.6 | 21.8 | 23.8 | 3.61 |

<a id="table-js-perimage-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 54 | 102.4 | 34.8 | 38.7 | 2.94 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 52.1 | 107.4 | 35 | 38 | 3.07 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 55.4 | 137.3 | 41.5 | 42.4 | 3.31 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 52.8 | 108.7 | 32.8 | 35.3 | 3.32 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 49.9 | 101 | 32.5 | 36.6 | 3.11 |

<a id="table-js-sweep-rgb-rgb-matrix-16k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-rgb-matrix.16k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 57.8 | 149.6 | 64.9 | 63.7 | 2.3 |

<a id="table-js-sweep-rgb-lab-16k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-lab.16k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 60.7 | 149.5 | 40 | 50.2 | 3.74 |

<a id="table-js-sweep-rgb-cmyk-16k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-cmyk.16k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 50.8 | 143.6 | 32.4 | 29.6 | 4.43 |

<a id="table-js-sweep-cmyk-rgb-16k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.cmyk-rgb.16k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 16384 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16384 | 0.2 | 32 | 80.7 | 22.1 | 22.2 | 3.65 |

<a id="table-js-sweep-cmyk-cmyk-16k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.cmyk-cmyk.16k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 16384 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16384 | 0.2 | 26.9 | 75.6 | 19.5 | 20.6 | 3.88 |

<a id="table-js-sweep-rgb-rgb-softproof-16k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-rgb-softproof.16k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 60.9 | 145.8 | 35.1 | 48.4 | 4.15 |

<a id="table-js-sweep-rgb-rgb-matrix-64k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-rgb-matrix.64k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 57 | 94.8 | 55.4 | 65.7 | 1.71 |

<a id="table-js-sweep-rgb-lab-64k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-lab.64k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 57.9 | 88.2 | 31.5 | 38.8 | 2.8 |

<a id="table-js-sweep-rgb-cmyk-64k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-cmyk.64k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 50.8 | 95.4 | 32.1 | 37 | 2.97 |

<a id="table-js-sweep-cmyk-rgb-64k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.cmyk-rgb.64k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 65536 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65536 | 0.78 | 31.5 | 65.5 | 21.8 | 22.2 | 3 |

<a id="table-js-sweep-cmyk-cmyk-64k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.cmyk-cmyk.64k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 65536 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65536 | 0.78 | 26.5 | 65.4 | 18.9 | 20.7 | 3.45 |

<a id="table-js-sweep-rgb-rgb-softproof-64k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-rgb-softproof.64k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 57.6 | 95.5 | 28.6 | 37.2 | 3.34 |

<a id="table-js-sweep-rgb-rgb-matrix-1024k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 47.8 | 97.4 | 65.5 | 65 | 1.49 |

<a id="table-js-sweep-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.1 | 97.8 | 31.6 | 38.1 | 3.1 |

<a id="table-js-sweep-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 43.9 | 98.5 | 32.2 | 36.7 | 3.06 |

<a id="table-js-sweep-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 32.1 | 68.3 | 22 | 22.2 | 3.11 |

<a id="table-js-sweep-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 27.2 | 66.8 | 19.4 | 20.8 | 3.44 |

<a id="table-js-sweep-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 49 | 97.1 | 33.6 | 37.4 | 2.89 |

<a id="table-js-sweep-rgb-rgb-matrix-10240k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-rgb-matrix.10240k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 48.9 | 97.2 | 65 | 65.5 | 1.5 |

<a id="table-js-sweep-rgb-lab-10240k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-lab.10240k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 48.4 | 97.4 | 31.6 | 38.3 | 3.08 |

<a id="table-js-sweep-rgb-cmyk-10240k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-cmyk.10240k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 44.2 | 99.2 | 31.8 | 36.2 | 3.12 |

<a id="table-js-sweep-cmyk-rgb-10240k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.cmyk-rgb.10240k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 10485760 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 10485760 | 125.55 | 31.8 | 68.7 | 22 | 21.9 | 3.12 |

<a id="table-js-sweep-cmyk-cmyk-10240k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.cmyk-cmyk.10240k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 10485760 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 10485760 | 125.55 | 27 | 66.7 | 18.5 | 20.5 | 3.6 |

<a id="table-js-sweep-rgb-rgb-softproof-10240k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-rgb-softproof.10240k` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 48.3 | 97.9 | 33.6 | 37.3 | 2.91 |

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
| kernel, SIMD | 334 | 330.6 | 335.1 |
| kernel, scalar | 203.7 | 69.3 | 185.6 |
| kernel, plain JS | 94.2 | 58.5 | 90 |
| CLUT (default lutMode) | 529.9 | 99.1 | 116.7 |
| JS stage pipeline | 10.2 | 8.3 | 8.9 |

<a id="table-matrixshaper-ratios-int8"></a>

### Matrix-shaper kernel ratios, int8

`matrixShaper.ratios.int8` · x · measured by `bench/matrix_shaper_kernel/throughput.js` · jsCE **1.6.0** · 2026-08-22

**bits** 8 · **pair** *prophoto → *sRGB

| Content | SIMD / CLUT | SIMD / scalar | SIMD / plain JS | JS / pipeline |
|---|---:|---:|---:|---:|
| solid | 0.63 | 1.64 | 3.55 | 9.3 |
| noise | 3.33 | 4.77 | 5.65 | 7.1 |
| photo | 2.87 | 1.81 | 3.72 | 10.1 |

<a id="table-matrixshaper-throughput-int16"></a>

### Matrix-shaper kernel vs CLUT, int16, *prophoto -> *sRGB

`matrixShaper.throughput.int16` · MPx/s · measured by `bench/matrix_shaper_kernel/throughput.js` · jsCE **1.6.0** · 2026-08-22

**bits** 16 · **pixels** 4194304 · **reps** 5 · **pair** *prophoto → *sRGB · **best** best of 5

| Path | Solid | Noise | Photo |
|---|---:|---:|---:|
| kernel, SIMD | 231.4 | 205.9 | 220.5 |
| kernel, scalar | 102.7 | 63.5 | 99.9 |
| kernel, plain JS | 79.6 | 38.9 | 59.1 |
| CLUT (default lutMode) | 195.9 | 103.1 | 121.6 |
| JS stage pipeline | 10 | 8.3 | 8.7 |

<a id="table-matrixshaper-ratios-int16"></a>

### Matrix-shaper kernel ratios, int16

`matrixShaper.ratios.int16` · x · measured by `bench/matrix_shaper_kernel/throughput.js` · jsCE **1.6.0** · 2026-08-22

**bits** 16 · **pair** *prophoto → *sRGB

| Content | SIMD / CLUT | SIMD / scalar | SIMD / plain JS | JS / pipeline |
|---|---:|---:|---:|---:|
| solid | 1.18 | 2.25 | 2.91 | 7.9 |
| noise | 2 | 3.24 | 5.29 | 4.7 |
| photo | 1.81 | 2.21 | 3.73 | 6.8 |

<a id="table-pixelcache-accuracypath-rgb-rgb-matrix"></a>

### Pixel cache (BETA), accuracy path — RGB -> RGB  (matrix)

`pixelCache.accuracyPath.rgb-rgb-matrix` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 253.88 | 6.68 | 6.34 | 0 | -98 |
| gradient | 75 | 266.6 | 16.52 | 15.68 | 75 | -94 |
| blocks16 | 93.8 | 268.28 | 25.31 | 23.91 | 94.4 | -91 |
| solid | 100 | 274.08 | 32.28 | 29.72 | 100 | -89 |
| photo | 8.6 | 267.71 | 7.49 | 8.48 | 32.8 | -97 |

<a id="table-pixelcache-accuracypath-rgb-lab"></a>

### Pixel cache (BETA), accuracy path — RGB -> Lab

`pixelCache.accuracyPath.rgb-lab` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7.75 | 6.53 | 6.25 | 0 | -19 |
| gradient | 75 | 8.31 | 16.58 | 15.42 | 75 | 86 |
| blocks16 | 93.8 | 8.48 | 25.42 | 23.98 | 94.4 | 183 |
| solid | 100 | 8.31 | 31.69 | 28.97 | 100 | 249 |
| photo | 8.6 | 7.95 | 7.23 | 8.24 | 32.8 | 4 |

<a id="table-pixelcache-accuracypath-rgb-cmyk"></a>

### Pixel cache (BETA), accuracy path — RGB -> CMYK

`pixelCache.accuracyPath.rgb-cmyk` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 4.51 | 4.03 | 3.8 | 0 | -16 |
| gradient | 75 | 5.28 | 11.26 | 11.3 | 75 | 114 |
| blocks16 | 93.8 | 5.33 | 21.25 | 20.17 | 94.4 | 279 |
| solid | 100 | 5.3 | 28.76 | 27.5 | 100 | 419 |
| photo | 8.6 | 4.77 | 4.61 | 5.64 | 32.8 | 18 |

<a id="table-pixelcache-accuracypath-cmyk-rgb"></a>

### Pixel cache (BETA), accuracy path — CMYK -> RGB

`pixelCache.accuracyPath.cmyk-rgb` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 5.83 | 4.83 | 4.61 | 0 | -21 |
| gradient | 75 | 6.81 | 13.91 | 12.86 | 75 | 89 |
| blocks16 | 93.8 | 6.9 | 22.45 | 21.21 | 94.4 | 207 |
| solid | 100 | 7.17 | 30.49 | 28.16 | 100 | 293 |
| photo | 8.6 | 6.17 | 5.46 | 6.07 | 31.4 | -2 |

<a id="table-pixelcache-accuracypath-cmyk-cmyk"></a>

### Pixel cache (BETA), accuracy path — CMYK -> CMYK

`pixelCache.accuracyPath.cmyk-cmyk` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 5.29 | 4.46 | 4.12 | 0 | -22 |
| gradient | 75 | 6.54 | 12.52 | 11.93 | 75 | 83 |
| blocks16 | 93.8 | 6.59 | 20.68 | 19.74 | 94.4 | 200 |
| solid | 100 | 6.85 | 29 | 25.79 | 100 | 277 |
| photo | 8.6 | 5.21 | 4.52 | 5.63 | 31.4 | 8 |

<a id="table-pixelcache-accuracypath-rgb-rgb-softproof"></a>

### Pixel cache (BETA), accuracy path — RGB -> RGB  (softproof)

`pixelCache.accuracyPath.rgb-rgb-softproof` · MPx/s · measured by `run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 2.43 | 2.47 | 2.36 | 0 | -3 |
| gradient | 75 | 3.09 | 8.32 | 8.22 | 75 | 166 |
| blocks16 | 93.8 | 3.2 | 17.61 | 17.76 | 94.4 | 455 |
| solid | 100 | 3.25 | 31.19 | 28.22 | 100 | 767 |
| photo | 8.6 | 2.99 | 2.91 | 3.54 | 32.8 | 19 |

<a id="table-pool-matrixshaper-noise"></a>

### Matrix-shaper kernel vs CLUT in the worker pool — noise

`pool.matrixShaper.noise` · MPx/s · measured by `bench/matrix_shaper_kernel/multicore.js` · jsCE **1.6.0** · 2026-08-22

**content** noise · **pair** *prophoto → *sRGB · **pixels** 4000000 · **runs** 5 · **sequentialClutMpxs** 100.5 · **sequentialKernelMpxs** 317.7 · **maxKernelVsClutLsb** 28

| Workers | Clut Mpxs | Clut Speedup | Clut Eff Pct | Kernel Mpxs | Kernel Speedup | Kernel Eff Pct | Kernel Over Clut | Exact |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 90.3 | 0.9 | 90 | 253.8 | 0.8 | 80 | 2.81 | yes |
| 2 | 176.8 | 1.76 | 88 | 468.2 | 1.47 | 74 | 2.65 | yes |
| 3 | 258.1 | 2.57 | 86 | 633.5 | 1.99 | 66 | 2.45 | yes |
| 4 | 334.5 | 3.33 | 83 | 807.8 | 2.54 | 64 | 2.41 | yes |
| 5 | 356.1 | 3.54 | 71 | 900.9 | 2.84 | 57 | 2.53 | yes |
| 6 | 434.3 | 4.32 | 72 | 925.6 | 2.91 | 49 | 2.13 | yes |
| 7 | 471.8 | 4.69 | 67 | 1029.7 | 3.24 | 46 | 2.18 | yes |
| 8 | 509.5 | 5.07 | 63 | 934.2 | 2.94 | 37 | 1.83 | yes |

<a id="table-pool-matrixshaper-photo"></a>

### Matrix-shaper kernel vs CLUT in the worker pool — photo

`pool.matrixShaper.photo` · MPx/s · measured by `bench/matrix_shaper_kernel/multicore.js` · jsCE **1.6.0** · 2026-08-22

**content** photo · **pair** *prophoto → *sRGB · **pixels** 4000000 · **runs** 5 · **sequentialClutMpxs** 118.4 · **sequentialKernelMpxs** 321.5 · **maxKernelVsClutLsb** 25

| Workers | Clut Mpxs | Clut Speedup | Clut Eff Pct | Kernel Mpxs | Kernel Speedup | Kernel Eff Pct | Kernel Over Clut | Exact |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 101.5 | 0.86 | 86 | 245.6 | 0.76 | 76 | 2.42 | yes |
| 2 | 201.8 | 1.7 | 85 | 491 | 1.53 | 76 | 2.43 | yes |
| 3 | 282 | 2.38 | 79 | 655.5 | 2.04 | 68 | 2.32 | yes |
| 4 | 367.8 | 3.11 | 78 | 694.5 | 2.16 | 54 | 1.89 | yes |
| 5 | 423.5 | 3.58 | 72 | 797.3 | 2.48 | 50 | 1.88 | yes |
| 6 | 452.8 | 3.82 | 64 | 947.4 | 2.95 | 49 | 2.09 | yes |
| 7 | 539.5 | 4.55 | 65 | 952.3 | 2.96 | 42 | 1.77 | yes |
| 8 | 567.2 | 4.79 | 60 | 965.6 | 3 | 38 | 1.7 | yes |

<a id="table-pool-peak"></a>

### Worker pool — peak speedup vs sequential, by kernel and content

`pool.peak` · x · measured by `bench/multicore_matrix/run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 4194304 · **maxWorkers** 8

| Kernel | Content | Sequential MPx/s | Peak Speedup | At Workers | Peak MPx/s | Efficiency | Exact |
|---|---|---:|---:|---:|---:|---:|---|
| int | solid | 57.6 | 4.68 | 8 | 269.9 | 59 | yes |
| int | noise | 45.8 | 5.85 | 8 | 267.5 | 73 | yes |
| int | photo | 49.5 | 5.52 | 6 | 272.8 | 92 | yes |
| int-wasm-scalar | solid | 307.8 | 2.88 | 7 | 887.6 | 41 | yes |
| int-wasm-scalar | noise | 59.6 | 5.1 | 8 | 304.2 | 64 | yes |
| int-wasm-scalar | photo | 71 | 4.97 | 8 | 352.8 | 62 | yes |
| int-wasm-simd | solid | 514.3 | 1.91 | 4 | 980 | 48 | yes |
| int-wasm-simd | noise | 99.9 | 4.93 | 8 | 492.4 | 62 | yes |
| int-wasm-simd | photo | 117.1 | 4.53 | 8 | 530.1 | 57 | yes |

<a id="table-pool-scaling"></a>

### Worker pool — every worker count

`pool.scaling` · MPx/s · measured by `bench/multicore_matrix/run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 4194304

| Kernel | Content | Workers | MPx/s | Speedup | Efficiency | Exact |
|---|---|---:|---:|---:|---:|---|
| int | solid | 1 | 52.6 | 0.91 | 91 | yes |
| int | solid | 2 | 101.8 | 1.77 | 88 | yes |
| int | solid | 3 | 147.7 | 2.56 | 85 | yes |
| int | solid | 4 | 191.3 | 3.32 | 83 | yes |
| int | solid | 5 | 208.8 | 3.62 | 72 | yes |
| int | solid | 6 | 230.5 | 4 | 67 | yes |
| int | solid | 7 | 266.1 | 4.62 | 66 | yes |
| int | solid | 8 | 269.9 | 4.68 | 59 | yes |
| int | noise | 1 | 43.5 | 0.95 | 95 | yes |
| int | noise | 2 | 81.5 | 1.78 | 89 | yes |
| int | noise | 3 | 122.8 | 2.68 | 89 | yes |
| int | noise | 4 | 166.1 | 3.63 | 91 | yes |
| int | noise | 5 | 208.8 | 4.56 | 91 | yes |
| int | noise | 6 | 249.2 | 5.45 | 91 | yes |
| int | noise | 7 | 246.4 | 5.38 | 77 | yes |
| int | noise | 8 | 267.5 | 5.85 | 73 | yes |
| int | photo | 1 | 47.3 | 0.96 | 96 | yes |
| int | photo | 2 | 91.5 | 1.85 | 92 | yes |
| int | photo | 3 | 129.2 | 2.61 | 87 | yes |
| int | photo | 4 | 188.6 | 3.81 | 95 | yes |
| int | photo | 5 | 224.7 | 4.54 | 91 | yes |
| int | photo | 6 | 272.8 | 5.52 | 92 | yes |
| int | photo | 7 | 266.5 | 5.39 | 77 | yes |
| int | photo | 8 | 260.4 | 5.26 | 66 | yes |
| int-wasm-scalar | solid | 1 | 240.5 | 0.78 | 78 | yes |
| int-wasm-scalar | solid | 2 | 438.8 | 1.43 | 71 | yes |
| int-wasm-scalar | solid | 3 | 546.2 | 1.77 | 59 | yes |
| int-wasm-scalar | solid | 4 | 805.7 | 2.62 | 65 | yes |
| int-wasm-scalar | solid | 5 | 835.4 | 2.71 | 54 | yes |
| int-wasm-scalar | solid | 6 | 871.3 | 2.83 | 47 | yes |
| int-wasm-scalar | solid | 7 | 887.6 | 2.88 | 41 | yes |
| int-wasm-scalar | solid | 8 | 737.1 | 2.39 | 30 | yes |
| int-wasm-scalar | noise | 1 | 56.1 | 0.94 | 94 | yes |
| int-wasm-scalar | noise | 2 | 108.9 | 1.83 | 91 | yes |
| int-wasm-scalar | noise | 3 | 159.5 | 2.68 | 89 | yes |
| int-wasm-scalar | noise | 4 | 205.4 | 3.45 | 86 | yes |
| int-wasm-scalar | noise | 5 | 235.7 | 3.96 | 79 | yes |
| int-wasm-scalar | noise | 6 | 279.8 | 4.69 | 78 | yes |
| int-wasm-scalar | noise | 7 | 298.1 | 5 | 71 | yes |
| int-wasm-scalar | noise | 8 | 304.2 | 5.1 | 64 | yes |
| int-wasm-scalar | photo | 1 | 66.1 | 0.93 | 93 | yes |
| int-wasm-scalar | photo | 2 | 129.5 | 1.82 | 91 | yes |
| int-wasm-scalar | photo | 3 | 181.8 | 2.56 | 85 | yes |
| int-wasm-scalar | photo | 4 | 238.5 | 3.36 | 84 | yes |
| int-wasm-scalar | photo | 5 | 285.9 | 4.02 | 80 | yes |
| int-wasm-scalar | photo | 6 | 323.1 | 4.55 | 76 | yes |
| int-wasm-scalar | photo | 7 | 343 | 4.83 | 69 | yes |
| int-wasm-scalar | photo | 8 | 352.8 | 4.97 | 62 | yes |
| int-wasm-simd | solid | 1 | 349.3 | 0.68 | 68 | yes |
| int-wasm-simd | solid | 2 | 630.3 | 1.23 | 61 | yes |
| int-wasm-simd | solid | 3 | 968.3 | 1.88 | 63 | yes |
| int-wasm-simd | solid | 4 | 980 | 1.91 | 48 | yes |
| int-wasm-simd | solid | 5 | 958.9 | 1.86 | 37 | yes |
| int-wasm-simd | solid | 6 | 901.2 | 1.75 | 29 | yes |
| int-wasm-simd | solid | 7 | 927.2 | 1.8 | 26 | yes |
| int-wasm-simd | solid | 8 | 855.1 | 1.66 | 21 | yes |
| int-wasm-simd | noise | 1 | 91.4 | 0.91 | 91 | yes |
| int-wasm-simd | noise | 2 | 176.7 | 1.77 | 88 | yes |
| int-wasm-simd | noise | 3 | 254.3 | 2.55 | 85 | yes |
| int-wasm-simd | noise | 4 | 330 | 3.3 | 83 | yes |
| int-wasm-simd | noise | 5 | 395.7 | 3.96 | 79 | yes |
| int-wasm-simd | noise | 6 | 434.8 | 4.35 | 73 | yes |
| int-wasm-simd | noise | 7 | 444.7 | 4.45 | 64 | yes |
| int-wasm-simd | noise | 8 | 492.4 | 4.93 | 62 | yes |
| int-wasm-simd | photo | 1 | 106.5 | 0.91 | 91 | yes |
| int-wasm-simd | photo | 2 | 204.4 | 1.75 | 87 | yes |
| int-wasm-simd | photo | 3 | 294.8 | 2.52 | 84 | yes |
| int-wasm-simd | photo | 4 | 339.6 | 2.9 | 73 | yes |
| int-wasm-simd | photo | 5 | 403.8 | 3.45 | 69 | yes |
| int-wasm-simd | photo | 6 | 494.7 | 4.22 | 70 | yes |
| int-wasm-simd | photo | 7 | 526.4 | 4.5 | 64 | yes |
| int-wasm-simd | photo | 8 | 530.1 | 4.53 | 57 | yes |

<a id="table-smalldim-throughput"></a>

### Throughput on synthetic LUTs — narrow input and wide output

`smallDim.throughput` · MPx/s · measured by `bench/small_dim/run.js` · jsCE **1.6.0** · 2026-08-22

**pixels** 1048576 · **grid** 256 · **reps** 5 · **lutMode** float · **dataFormat** int8

| Workflow | Kernel | Output Channels | Grid | MPx/s |
|---|---|---:|---:|---:|
| gray -> RGB | kernel1D | 3 | 256 | 91.5 |
| gray -> CMYK | kernel1D | 4 | 256 | 81.5 |
| gray -> 6CLR | kernel1D | 6 | 256 | 64.7 |
| duotone -> RGB | kernel2D | 3 | 256 | 60.8 |
| duotone -> CMYK | kernel2D | 4 | 256 | 51.1 |
| duotone -> 6CLR | kernel2D | 6 | 256 | 41.1 |
| RGB -> RGB | kernel3D | 3 | 33 | 76.9 |
| RGB -> CMYK | kernel3D | 4 | 33 | 67.4 |
| RGB -> 6CLR | kernel3D | 6 | 33 | 34.5 |
| RGB -> 8CLR | kernel3D | 8 | 33 | 29.2 |
| CMYK -> RGB | kernel4D | 3 | 17 | 42.7 |
| CMYK -> CMYK | kernel4D | 4 | 17 | 36.1 |
| CMYK -> 6CLR | kernel4D | 6 | 17 | 22.8 |

<a id="table-solo-rgb2cmyk"></a>

### Solo control bench — one image, one engine, one process (rgb2cmyk)

`solo.rgb2cmyk` · MPx/s · measured by `bench/solo_photo/solo.js` · jsCE **1.6.0** · 2026-08-22

**image** jacek-dylag-559115_STRAWBERRIES-unsplash · **workflow** rgb2cmyk · **pixels** 1000000 · **warmupMs** 3000 · **samples** 7

| Engine | Median Mpxs | Spread Pct | Processes |
|---|---:|---:|---:|
| int | 46.8 | 1.7 | 5 |
| scalar | 66 | 3.9 | 5 |
| simd | 105.9 | 3.5 | 5 |

<a id="table-solo-rgb2lab"></a>

### Solo control bench — one image, one engine, one process (rgb2lab)

`solo.rgb2lab` · MPx/s · measured by `bench/solo_photo/solo.js` · jsCE **1.6.0** · 2026-08-22

**image** jacek-dylag-559115_STRAWBERRIES-unsplash · **workflow** rgb2lab · **pixels** 1000000 · **warmupMs** 3000 · **samples** 7

| Engine | Median Mpxs | Spread Pct | Processes |
|---|---:|---:|---:|
| int | 52.5 | 0.8 | 5 |
| scalar | 75.8 | 2 | 5 |
| simd | 107.8 | 3.9 | 5 |

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
| [`pool.matrixShaper.noise`](#table-pool-matrixshaper-noise) | *not cited yet* |
| [`pool.matrixShaper.photo`](#table-pool-matrixshaper-photo) | *not cited yet* |
| [`pool.peak`](#table-pool-peak) | `docs/deepdive/multicore.md`, `docs/pool.md` |
| [`pool.scaling`](#table-pool-scaling) | `docs/LcmsComparison.md`, `docs/deepdive/multicore.md`, `docs/pool.md` |
| [`smallDim.throughput`](#table-smalldim-throughput) | *not cited yet* |
| [`solo.rgb2cmyk`](#table-solo-rgb2cmyk) | *not cited yet* |
| [`solo.rgb2lab`](#table-solo-rgb2lab) | *not cited yet* |
