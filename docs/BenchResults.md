# Benchmark results — generated

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Performance](./Performance.md) ·
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
> Run `2026-08-20T10-37-19` · measured 2026-08-20 · jsCE 1.5.5 · package now **1.5.5**

Other pages should **link to a table here** rather than restating its
numbers: prose keeps the finding, this page owns the figures. The
[citation index](#citation-index) lists what points where, so a
re-measurement is a finite job rather than a search.

## Conditions

| | |
|---|---|
| Date | 2026-08-20 |
| CPU | AMD Ryzen 7 7700X 8-Core Processor              (16 logical) |
| RAM | 31.1 GB |
| JS host | Node v24.16.0, win32 x64 |
| lcms native host | WSL2 (Ubuntu), gcc (Ubuntu 9.3.0-17ubuntu1~20.04) 9.3.0 |
| lcms-wasm version | 1.0.5 |
| jsColorEngine version | 1.5.5 |
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
- [Solo control bench — one image, one engine, one process (rgb2cmyk)](#table-solo-rgb2cmyk) — `solo.rgb2cmyk`
- [Solo control bench — one image, one engine, one process (rgb2lab)](#table-solo-rgb2lab) — `solo.rgb2lab`

<a id="table-js-content-rgb-rgb-matrix-1024k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 47.7 | 96.1 | 64.4 | 63.9 | 1.49 |
| gradient | 75 | 256 | 0.01 | 61.2 | 177.3 | 64.8 | 65.5 | 2.73 |
| blocks16 | 93.8 | 4095 | 0.11 | 59.8 | 183.1 | 66.1 | 66.3 | 2.77 |
| solid | 100 | 1 | 0 | 62.2 | 180.3 | 66.8 | 67 | 2.7 |
| photo | 13.2 | 41077 | 1.14 | 53.4 | 117.6 | 66.1 | 66.1 | 1.78 |

<a id="table-js-content-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.2 | 95.5 | 31 | 37.9 | 3.08 |
| gradient | 75 | 256 | 0.01 | 59.8 | 181.9 | 63 | 48.3 | 2.89 |
| blocks16 | 93.8 | 4095 | 0.11 | 60 | 188.3 | 74.5 | 48.8 | 2.53 |
| solid | 100 | 1 | 0 | 62.9 | 175.5 | 92.5 | 51.4 | 1.9 |
| photo | 13.2 | 41077 | 1.14 | 53.9 | 120.3 | 33.5 | 41.3 | 3.59 |

<a id="table-js-content-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 44 | 100 | 31.5 | 35.8 | 3.17 |
| gradient | 75 | 256 | 0.01 | 54.2 | 166.5 | 63.8 | 48.6 | 2.61 |
| blocks16 | 93.8 | 4095 | 0.11 | 53.6 | 179.8 | 77.2 | 46.8 | 2.33 |
| solid | 100 | 1 | 0 | 54.3 | 176.3 | 84.2 | 48.8 | 2.09 |
| photo | 13.2 | 41077 | 1.14 | 48.4 | 119.3 | 35.1 | 38.6 | 3.4 |

<a id="table-js-content-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px

`js.content.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 30.7 | 65.5 | 21.5 | 21.8 | 3.04 |
| gradient | 75 | 256 | 0 | 37.2 | 96.8 | 49.9 | 26.4 | 1.94 |
| blocks16 | 93.8 | 4096 | 0.05 | 37.6 | 96 | 67.5 | 24.7 | 1.42 |
| solid | 100 | 1 | 0 | 38.6 | 103 | 92.6 | 25.8 | 1.11 |
| photo | 13.3 | 35074 | 0.42 | 44 | 78.6 | 25.3 | 24 | 3.11 |

<a id="table-js-content-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px

`js.content.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 26.4 | 61.4 | 18.2 | 20.6 | 3.38 |
| gradient | 75 | 256 | 0 | 30.3 | 95.1 | 47.2 | 24.1 | 2.01 |
| blocks16 | 93.8 | 4096 | 0.05 | 32.3 | 95.1 | 66.1 | 24 | 1.44 |
| solid | 100 | 1 | 0 | 32 | 102.6 | 83.5 | 25.2 | 1.23 |
| photo | 13.3 | 35074 | 0.42 | 37.2 | 80.8 | 23 | 24.4 | 3.51 |

<a id="table-js-content-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px

`js.content.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.3 | 96.6 | 33.7 | 36.6 | 2.87 |
| gradient | 75 | 256 | 0.01 | 60.5 | 173.3 | 61 | 47.9 | 2.84 |
| blocks16 | 93.8 | 4095 | 0.11 | 60.2 | 169.1 | 74.6 | 46.4 | 2.27 |
| solid | 100 | 1 | 0 | 62.2 | 173.4 | 91.6 | 48.7 | 1.89 |
| photo | 13.2 | 41077 | 1.14 | 53.8 | 115.9 | 34 | 38.7 | 3.41 |

<a id="table-js-perimage-rgb-rgb-matrix-1024k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 53.1 | 116 | 64.7 | 69.2 | 1.79 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 52 | 110 | 65.2 | 63 | 1.69 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 54.9 | 131.7 | 66.5 | 66.4 | 1.98 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 52.1 | 112.5 | 66.3 | 65.4 | 1.7 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 51.2 | 107.9 | 66.5 | 65.2 | 1.62 |

<a id="table-js-perimage-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 52.8 | 120.5 | 34.1 | 42 | 3.53 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 52.3 | 110.6 | 33 | 40.5 | 3.36 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 54.8 | 131.4 | 41.1 | 42.4 | 3.2 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 51.4 | 111.3 | 34.3 | 40.1 | 3.24 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 51.6 | 108.8 | 33.8 | 39.7 | 3.22 |

<a id="table-js-perimage-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 47.7 | 120.9 | 35.5 | 40.2 | 3.4 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 46.9 | 112.8 | 33.5 | 37.9 | 3.37 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 49.4 | 134.1 | 41.5 | 41.4 | 3.23 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 46.9 | 115.1 | 33.2 | 38.1 | 3.47 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 46.3 | 112.5 | 31.9 | 38 | 3.52 |

<a id="table-js-perimage-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6332 | 0.08 | 35.9 | 83.3 | 24.9 | 24.6 | 3.35 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 17.6 | 103888 | 1.24 | 36.1 | 79.7 | 25.2 | 25.5 | 3.16 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42.2 | 67211 | 0.8 | 35 | 86.9 | 30.2 | 24.3 | 2.88 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 15.6 | 86185 | 1.03 | 36.9 | 81.9 | 25.7 | 24.5 | 3.18 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 7.1 | 201835 | 2.42 | 34.9 | 81.7 | 23.9 | 23.7 | 3.41 |

<a id="table-js-perimage-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6332 | 0.08 | 29.8 | 82.6 | 23 | 23.8 | 3.59 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 17.6 | 103888 | 1.24 | 28.8 | 79.5 | 23.2 | 23.2 | 3.43 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42.2 | 67211 | 0.8 | 31.7 | 85.4 | 29.1 | 23.9 | 2.94 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 15.6 | 86185 | 1.03 | 31.5 | 83.8 | 23 | 23.6 | 3.64 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 7.1 | 201835 | 2.42 | 29.5 | 81 | 22 | 23.4 | 3.69 |

<a id="table-js-perimage-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px, per image

`js.perimage.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| image:annie-spratt-askpr0s66Rg-unsplash-PHOTO_ | 10.3 | 6429 | 0.18 | 53 | 120.5 | 34.5 | 38.5 | 3.5 |
| image:jacek-dylag-559115_STRAWBERRIES-unsplash | 16.1 | 152752 | 4.25 | 52.5 | 109.3 | 33.3 | 37.4 | 3.28 |
| image:library-of-congress-tqpsi_BPfC_ILLUSTRAT | 42 | 71661 | 1.99 | 55.3 | 131.8 | 40.3 | 41.2 | 3.27 |
| image:melanie-kreutz-hMMc7mvb34A-unsplash_SUNF | 14.6 | 116552 | 3.24 | 52.7 | 112.4 | 34.2 | 36.6 | 3.29 |
| image:rod-long-4dcsLxQxSHY-unsplash_BEACH | 6.9 | 229716 | 6.39 | 51.5 | 108.1 | 32.5 | 37.4 | 3.33 |

<a id="table-js-sweep-rgb-rgb-matrix-16k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-rgb-matrix.16k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 59.6 | 162.9 | 64.2 | 60.6 | 2.54 |

<a id="table-js-sweep-rgb-lab-16k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-lab.16k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 57.4 | 161.5 | 39.3 | 47.8 | 4.11 |

<a id="table-js-sweep-rgb-cmyk-16k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-cmyk.16k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 50 | 160.2 | 35.7 | 42.5 | 4.48 |

<a id="table-js-sweep-cmyk-rgb-16k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.cmyk-rgb.16k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 16384 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16384 | 0.2 | 30.3 | 74.7 | 21.1 | 22.2 | 3.54 |

<a id="table-js-sweep-cmyk-cmyk-16k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.cmyk-cmyk.16k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 16384 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16384 | 0.2 | 25.6 | 79.3 | 19 | 17.4 | 4.18 |

<a id="table-js-sweep-rgb-rgb-softproof-16k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 16K px, size sweep

`js.sweep.rgb-rgb-softproof.16k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 16384 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 16379 | 0.46 | 56.4 | 126.8 | 33.7 | 45.5 | 3.76 |

<a id="table-js-sweep-rgb-rgb-matrix-64k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-rgb-matrix.64k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 53.9 | 94 | 64 | 64.2 | 1.47 |

<a id="table-js-sweep-rgb-lab-64k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-lab.64k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 57.1 | 93.9 | 32.4 | 37.9 | 2.9 |

<a id="table-js-sweep-rgb-cmyk-64k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-cmyk.64k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 49.7 | 94.5 | 31.6 | 36.4 | 2.99 |

<a id="table-js-sweep-cmyk-rgb-64k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.cmyk-rgb.64k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 65536 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65536 | 0.78 | 30.4 | 66.9 | 21.3 | 22 | 3.14 |

<a id="table-js-sweep-cmyk-cmyk-64k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.cmyk-cmyk.64k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 65536 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65536 | 0.78 | 25.4 | 61.1 | 18.6 | 19.8 | 3.29 |

<a id="table-js-sweep-rgb-rgb-softproof-64k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 64K px, size sweep

`js.sweep.rgb-rgb-softproof.64k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 65536 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 65394 | 1.82 | 48 | 95.2 | 32.8 | 37 | 2.9 |

<a id="table-js-sweep-rgb-rgb-matrix-1024k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-rgb-matrix.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.4 | 87.3 | 61.6 | 64.3 | 1.42 |

<a id="table-js-sweep-rgb-lab-1024k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-lab.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.3 | 97.1 | 30.8 | 37.4 | 3.15 |

<a id="table-js-sweep-rgb-cmyk-1024k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 43.7 | 100.5 | 31.7 | 35.8 | 3.17 |

<a id="table-js-sweep-cmyk-rgb-1024k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.cmyk-rgb.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 31.6 | 68.1 | 21.7 | 21.9 | 3.14 |

<a id="table-js-sweep-cmyk-cmyk-1024k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.cmyk-cmyk.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1048576 | 12.55 | 26.6 | 68.7 | 18.9 | 19.6 | 3.63 |

<a id="table-js-sweep-rgb-rgb-softproof-1024k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 1024K px, size sweep

`js.sweep.rgb-rgb-softproof.1024k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 1048576 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 1016892 | 28.3 | 48.6 | 97.7 | 32.6 | 37 | 2.99 |

<a id="table-js-sweep-rgb-rgb-matrix-10240k"></a>

### RGB -> RGB  (matrix) — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-rgb-matrix.10240k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 48.6 | 98.3 | 64.8 | 64.9 | 1.52 |

<a id="table-js-sweep-rgb-lab-10240k"></a>

### RGB -> Lab — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-lab.10240k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 47.4 | 97.9 | 30.9 | 36 | 3.17 |

<a id="table-js-sweep-rgb-cmyk-10240k"></a>

### RGB -> CMYK — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-cmyk.10240k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 44.1 | 100.1 | 31.4 | 35.7 | 3.19 |

<a id="table-js-sweep-cmyk-rgb-10240k"></a>

### CMYK -> RGB — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.cmyk-rgb.10240k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 10485760 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 10485760 | 125.55 | 30.9 | 68.2 | 21.2 | 21.9 | 3.22 |

<a id="table-js-sweep-cmyk-cmyk-10240k"></a>

### CMYK -> CMYK — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.cmyk-cmyk.10240k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 10485760 · **medianOf** 5 · **clut** 17x17x17x17 · **clutCells** 83521

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 10485760 | 125.55 | 26.2 | 67.3 | 18.9 | 20.5 | 3.55 |

<a id="table-js-sweep-rgb-rgb-softproof-10240k"></a>

### RGB -> RGB  (softproof) — jsCE vs lcms-wasm, 10240K px, size sweep

`js.sweep.rgb-rgb-softproof.10240k` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 10485760 · **medianOf** 5 · **clut** 33x33x33 · **clutCells** 35937

| Content | adj % | Distinct | cover | jsCE int | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | jsCE SIMD / lcms-wasm |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7810586 | 217.34 | 48.9 | 97.5 | 33.1 | 36.7 | 2.95 |

<a id="table-matrixshaper-accuracy-int16"></a>

### Matrix-shaper kernel vs CLUT, accuracy against the exact pipeline, int16

`matrixShaper.accuracy.int16` · LSB · measured by `bench/matrix_shaper_kernel/accuracy.js` · jsCE **1.5.5** · 2026-08-20

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

`matrixShaper.accuracy.int8` · LSB · measured by `bench/matrix_shaper_kernel/accuracy.js` · jsCE **1.5.5** · 2026-08-20

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

`matrixShaper.throughput.int8` · MPx/s · measured by `bench/matrix_shaper_kernel/throughput.js` · jsCE **1.5.5** · 2026-08-20

**bits** 8 · **pixels** 4194304 · **reps** 5 · **pair** *prophoto → *sRGB · **best** best of 5

| Path | Solid | Noise | Photo |
|---|---:|---:|---:|
| kernel, SIMD | 335 | 327.8 | 328.4 |
| kernel, scalar | 204 | 71 | 186.5 |
| kernel, plain JS | 97.1 | 55 | 88.9 |
| CLUT (default lutMode) | 191.4 | 100.5 | 119.4 |
| JS stage pipeline | 9.8 | 8.1 | 8.6 |

<a id="table-matrixshaper-ratios-int8"></a>

### Matrix-shaper kernel ratios, int8

`matrixShaper.ratios.int8` · x · measured by `bench/matrix_shaper_kernel/throughput.js` · jsCE **1.5.5** · 2026-08-20

**bits** 8 · **pair** *prophoto → *sRGB

| Content | SIMD / CLUT | SIMD / scalar | SIMD / plain JS | JS / pipeline |
|---|---:|---:|---:|---:|
| solid | 1.75 | 1.64 | 3.45 | 9.9 |
| noise | 3.26 | 4.62 | 5.96 | 6.8 |
| photo | 2.75 | 1.76 | 3.7 | 10.3 |

<a id="table-matrixshaper-throughput-int16"></a>

### Matrix-shaper kernel vs CLUT, int16, *prophoto -> *sRGB

`matrixShaper.throughput.int16` · MPx/s · measured by `bench/matrix_shaper_kernel/throughput.js` · jsCE **1.5.5** · 2026-08-20

**bits** 16 · **pixels** 4194304 · **reps** 5 · **pair** *prophoto → *sRGB · **best** best of 5

| Path | Solid | Noise | Photo |
|---|---:|---:|---:|
| kernel, SIMD | 228.7 | 197.8 | 211.8 |
| kernel, scalar | 103.3 | 64.2 | 101.6 |
| kernel, plain JS | 79.7 | 38.3 | 59.6 |
| CLUT (default lutMode) | 193.1 | 103.5 | 120.3 |
| JS stage pipeline | 9.7 | 8.1 | 8.5 |

<a id="table-matrixshaper-ratios-int16"></a>

### Matrix-shaper kernel ratios, int16

`matrixShaper.ratios.int16` · x · measured by `bench/matrix_shaper_kernel/throughput.js` · jsCE **1.5.5** · 2026-08-20

**bits** 16 · **pair** *prophoto → *sRGB

| Content | SIMD / CLUT | SIMD / scalar | SIMD / plain JS | JS / pipeline |
|---|---:|---:|---:|---:|
| solid | 1.18 | 2.21 | 2.87 | 8.2 |
| noise | 1.91 | 3.08 | 5.16 | 4.8 |
| photo | 1.76 | 2.08 | 3.55 | 7 |

<a id="table-pixelcache-accuracypath-rgb-rgb-matrix"></a>

### Pixel cache (BETA), accuracy path — RGB -> RGB  (matrix)

`pixelCache.accuracyPath.rgb-rgb-matrix` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 256.54 | 6.43 | 6.19 | 0 | -98 |
| gradient | 75 | 263.92 | 15.25 | 14.51 | 75 | -95 |
| blocks16 | 93.8 | 275.1 | 23.21 | 22.3 | 94.4 | -92 |
| solid | 100 | 267.65 | 29.18 | 26.39 | 100 | -90 |
| photo | 8.6 | 269.69 | 7.08 | 7.8 | 32.8 | -97 |

<a id="table-pixelcache-accuracypath-rgb-lab"></a>

### Pixel cache (BETA), accuracy path — RGB -> Lab

`pixelCache.accuracyPath.rgb-lab` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 7.14 | 6.28 | 5.98 | 0 | -16 |
| gradient | 75 | 7.77 | 15.07 | 14.18 | 75 | 82 |
| blocks16 | 93.8 | 7.75 | 22.46 | 21.14 | 94.4 | 173 |
| solid | 100 | 7.61 | 27.29 | 25.27 | 100 | 232 |
| photo | 8.6 | 7.55 | 6.68 | 7.76 | 32.8 | 3 |

<a id="table-pixelcache-accuracypath-rgb-cmyk"></a>

### Pixel cache (BETA), accuracy path — RGB -> CMYK

`pixelCache.accuracyPath.rgb-cmyk` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 4.4 | 3.77 | 3.75 | 0 | -15 |
| gradient | 75 | 4.96 | 10.89 | 9.87 | 75 | 99 |
| blocks16 | 93.8 | 5.01 | 18.52 | 17.72 | 94.4 | 254 |
| solid | 100 | 5.03 | 24.16 | 23.1 | 100 | 360 |
| photo | 8.6 | 4.67 | 4.45 | 5.11 | 32.8 | 9 |

<a id="table-pixelcache-accuracypath-cmyk-rgb"></a>

### Pixel cache (BETA), accuracy path — CMYK -> RGB

`pixelCache.accuracyPath.cmyk-rgb` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 5.46 | 4.54 | 4.34 | 0 | -20 |
| gradient | 75 | 6.64 | 12.86 | 11.53 | 75 | 74 |
| blocks16 | 93.8 | 6.56 | 19.41 | 18.46 | 94.4 | 181 |
| solid | 100 | 6.82 | 25.67 | 23.24 | 100 | 241 |
| photo | 8.6 | 5.89 | 5.43 | 6.08 | 31.4 | 3 |

<a id="table-pixelcache-accuracypath-cmyk-cmyk"></a>

### Pixel cache (BETA), accuracy path — CMYK -> CMYK

`pixelCache.accuracyPath.cmyk-cmyk` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 4.97 | 4.27 | 4.18 | 0 | -16 |
| gradient | 75 | 6.14 | 11.89 | 10.93 | 75 | 78 |
| blocks16 | 93.8 | 6.25 | 17.74 | 16.86 | 94.4 | 170 |
| solid | 100 | 6.61 | 23.86 | 22.14 | 100 | 235 |
| photo | 8.6 | 5.82 | 5.12 | 5.92 | 31.4 | 2 |

<a id="table-pixelcache-accuracypath-rgb-rgb-softproof"></a>

### Pixel cache (BETA), accuracy path — RGB -> RGB  (softproof)

`pixelCache.accuracyPath.rgb-rgb-softproof` · MPx/s · measured by `run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 262144 · **buildLut** false · **baseline** its own uncached run

| Content | adj % | No Cache Mpxs | One Slot Mpxs | Slots32 Mpxs | Hit Pct32 | Gain32 Pct |
|---|---:|---:|---:|---:|---:|---:|
| noise | 0 | 2.77 | 2.46 | 2.37 | 0 | -14 |
| gradient | 75 | 3.05 | 8.2 | 7.85 | 75 | 158 |
| blocks16 | 93.8 | 3.15 | 16.09 | 15.88 | 94.4 | 405 |
| solid | 100 | 3.24 | 26.83 | 25.61 | 100 | 689 |
| photo | 8.6 | 2.77 | 2.77 | 3.59 | 32.8 | 30 |

<a id="table-pool-matrixshaper-noise"></a>

### Matrix-shaper kernel vs CLUT in the worker pool — noise

`pool.matrixShaper.noise` · MPx/s · measured by `bench/matrix_shaper_kernel/multicore.js` · jsCE **1.5.5** · 2026-08-20

**content** noise · **pair** *prophoto → *sRGB · **pixels** 4000000 · **runs** 5 · **sequentialClutMpxs** 103.4 · **sequentialKernelMpxs** 318.1 · **maxKernelVsClutLsb** 28

| Workers | Clut Mpxs | Clut Speedup | Clut Eff Pct | Kernel Mpxs | Kernel Speedup | Kernel Eff Pct | Kernel Over Clut | Exact |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 89.7 | 0.87 | 87 | 255.8 | 0.8 | 80 | 2.85 | yes |
| 2 | 163.8 | 1.58 | 79 | 385.1 | 1.21 | 61 | 2.35 | yes |
| 3 | 261.1 | 2.53 | 84 | 618.2 | 1.94 | 65 | 2.37 | yes |
| 4 | 339.5 | 3.28 | 82 | 814.2 | 2.56 | 64 | 2.4 | yes |
| 5 | 385.4 | 3.73 | 75 | 856.2 | 2.69 | 54 | 2.22 | yes |
| 6 | 473.7 | 4.58 | 76 | 1018.6 | 3.2 | 53 | 2.15 | yes |
| 7 | 521.2 | 5.04 | 72 | 1130 | 3.55 | 51 | 2.17 | yes |
| 8 | 498.8 | 4.83 | 60 | 1123.5 | 3.53 | 44 | 2.25 | yes |

<a id="table-pool-matrixshaper-photo"></a>

### Matrix-shaper kernel vs CLUT in the worker pool — photo

`pool.matrixShaper.photo` · MPx/s · measured by `bench/matrix_shaper_kernel/multicore.js` · jsCE **1.5.5** · 2026-08-20

**content** photo · **pair** *prophoto → *sRGB · **pixels** 4000000 · **runs** 5 · **sequentialClutMpxs** 120.7 · **sequentialKernelMpxs** 325.6 · **maxKernelVsClutLsb** 25

| Workers | Clut Mpxs | Clut Speedup | Clut Eff Pct | Kernel Mpxs | Kernel Speedup | Kernel Eff Pct | Kernel Over Clut | Exact |
|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 1 | 106 | 0.88 | 88 | 265.6 | 0.82 | 82 | 2.51 | yes |
| 2 | 212.8 | 1.76 | 88 | 503.9 | 1.55 | 77 | 2.37 | yes |
| 3 | 309.7 | 2.57 | 86 | 668.4 | 2.05 | 68 | 2.16 | yes |
| 4 | 385.4 | 3.19 | 80 | 846.2 | 2.6 | 65 | 2.2 | yes |
| 5 | 446.3 | 3.7 | 74 | 878.3 | 2.7 | 54 | 1.97 | yes |
| 6 | 548.5 | 4.54 | 76 | 1060.2 | 3.26 | 54 | 1.93 | yes |
| 7 | 529.3 | 4.38 | 63 | 1083.7 | 3.33 | 48 | 2.05 | yes |
| 8 | 547.4 | 4.53 | 57 | 984.5 | 3.02 | 38 | 1.8 | yes |

<a id="table-pool-peak"></a>

### Worker pool — peak speedup vs sequential, by kernel and content

`pool.peak` · x · measured by `bench/multicore_matrix/run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 4194304 · **maxWorkers** 8

| Kernel | Content | Sequential MPx/s | Peak Speedup | At Workers | Peak MPx/s | Efficiency | Exact |
|---|---|---:|---:|---:|---:|---:|---|
| int | solid | 57.5 | 5.64 | 8 | 324.3 | 71 | yes |
| int | noise | 45.6 | 6.16 | 7 | 281 | 88 | yes |
| int | photo | 49.2 | 6.08 | 8 | 298.9 | 76 | yes |
| int-wasm-scalar | solid | 84.6 | 4.62 | 8 | 390.8 | 58 | yes |
| int-wasm-scalar | noise | 60.9 | 5.04 | 8 | 306.9 | 63 | yes |
| int-wasm-scalar | photo | 68.7 | 5.52 | 8 | 379 | 69 | yes |
| int-wasm-simd | solid | 187.2 | 4.2 | 8 | 786.9 | 53 | yes |
| int-wasm-simd | noise | 99.2 | 5.49 | 8 | 544.6 | 69 | yes |
| int-wasm-simd | photo | 121.4 | 5.02 | 8 | 609.4 | 63 | yes |

<a id="table-pool-scaling"></a>

### Worker pool — every worker count

`pool.scaling` · MPx/s · measured by `bench/multicore_matrix/run.js` · jsCE **1.5.5** · 2026-08-20

**pixels** 4194304

| Kernel | Content | Workers | MPx/s | Speedup | Efficiency | Exact |
|---|---|---:|---:|---:|---:|---|
| int | solid | 1 | 50.5 | 0.88 | 88 | yes |
| int | solid | 2 | 102.7 | 1.79 | 89 | yes |
| int | solid | 3 | 134.4 | 2.34 | 78 | yes |
| int | solid | 4 | 182.8 | 3.18 | 80 | yes |
| int | solid | 5 | 230.8 | 4.01 | 80 | yes |
| int | solid | 6 | 266.2 | 4.63 | 77 | yes |
| int | solid | 7 | 189.6 | 3.3 | 47 | yes |
| int | solid | 8 | 324.3 | 5.64 | 71 | yes |
| int | noise | 1 | 43.2 | 0.95 | 95 | yes |
| int | noise | 2 | 80.8 | 1.77 | 89 | yes |
| int | noise | 3 | 120.3 | 2.64 | 88 | yes |
| int | noise | 4 | 169 | 3.7 | 93 | yes |
| int | noise | 5 | 205.3 | 4.5 | 90 | yes |
| int | noise | 6 | 249.8 | 5.47 | 91 | yes |
| int | noise | 7 | 281 | 6.16 | 88 | yes |
| int | noise | 8 | 246.6 | 5.4 | 68 | yes |
| int | photo | 1 | 47 | 0.96 | 96 | yes |
| int | photo | 2 | 88.9 | 1.81 | 90 | yes |
| int | photo | 3 | 129.5 | 2.63 | 88 | yes |
| int | photo | 4 | 200 | 4.07 | 102 | yes |
| int | photo | 5 | 242.1 | 4.92 | 98 | yes |
| int | photo | 6 | 238 | 4.84 | 81 | yes |
| int | photo | 7 | 297.3 | 6.05 | 86 | yes |
| int | photo | 8 | 298.9 | 6.08 | 76 | yes |
| int-wasm-scalar | solid | 1 | 77.2 | 0.91 | 91 | yes |
| int-wasm-scalar | solid | 2 | 148.6 | 1.76 | 88 | yes |
| int-wasm-scalar | solid | 3 | 178.5 | 2.11 | 70 | yes |
| int-wasm-scalar | solid | 4 | 281.4 | 3.33 | 83 | yes |
| int-wasm-scalar | solid | 5 | 324.9 | 3.84 | 77 | yes |
| int-wasm-scalar | solid | 6 | 374 | 4.42 | 74 | yes |
| int-wasm-scalar | solid | 7 | 382.7 | 4.53 | 65 | yes |
| int-wasm-scalar | solid | 8 | 390.8 | 4.62 | 58 | yes |
| int-wasm-scalar | noise | 1 | 56.3 | 0.92 | 92 | yes |
| int-wasm-scalar | noise | 2 | 110 | 1.81 | 90 | yes |
| int-wasm-scalar | noise | 3 | 157.7 | 2.59 | 86 | yes |
| int-wasm-scalar | noise | 4 | 207.6 | 3.41 | 85 | yes |
| int-wasm-scalar | noise | 5 | 239.8 | 3.94 | 79 | yes |
| int-wasm-scalar | noise | 6 | 277.9 | 4.57 | 76 | yes |
| int-wasm-scalar | noise | 7 | 233.8 | 3.84 | 55 | yes |
| int-wasm-scalar | noise | 8 | 306.9 | 5.04 | 63 | yes |
| int-wasm-scalar | photo | 1 | 62.8 | 0.91 | 91 | yes |
| int-wasm-scalar | photo | 2 | 122.9 | 1.79 | 89 | yes |
| int-wasm-scalar | photo | 3 | 177.4 | 2.58 | 86 | yes |
| int-wasm-scalar | photo | 4 | 229.7 | 3.34 | 84 | yes |
| int-wasm-scalar | photo | 5 | 275.7 | 4.01 | 80 | yes |
| int-wasm-scalar | photo | 6 | 322 | 4.69 | 78 | yes |
| int-wasm-scalar | photo | 7 | 368.1 | 5.36 | 77 | yes |
| int-wasm-scalar | photo | 8 | 379 | 5.52 | 69 | yes |
| int-wasm-simd | solid | 1 | 161.8 | 0.86 | 86 | yes |
| int-wasm-simd | solid | 2 | 303.2 | 1.62 | 81 | yes |
| int-wasm-simd | solid | 3 | 437.9 | 2.34 | 78 | yes |
| int-wasm-simd | solid | 4 | 548.3 | 2.93 | 73 | yes |
| int-wasm-simd | solid | 5 | 665.1 | 3.55 | 71 | yes |
| int-wasm-simd | solid | 6 | 735.1 | 3.93 | 65 | yes |
| int-wasm-simd | solid | 7 | 763.2 | 4.08 | 58 | yes |
| int-wasm-simd | solid | 8 | 786.9 | 4.2 | 53 | yes |
| int-wasm-simd | noise | 1 | 93.7 | 0.94 | 94 | yes |
| int-wasm-simd | noise | 2 | 184.3 | 1.86 | 93 | yes |
| int-wasm-simd | noise | 3 | 262.2 | 2.64 | 88 | yes |
| int-wasm-simd | noise | 4 | 342.9 | 3.46 | 86 | yes |
| int-wasm-simd | noise | 5 | 391 | 3.94 | 79 | yes |
| int-wasm-simd | noise | 6 | 446.9 | 4.5 | 75 | yes |
| int-wasm-simd | noise | 7 | 518.3 | 5.22 | 75 | yes |
| int-wasm-simd | noise | 8 | 544.6 | 5.49 | 69 | yes |
| int-wasm-simd | photo | 1 | 108.3 | 0.89 | 89 | yes |
| int-wasm-simd | photo | 2 | 210.3 | 1.73 | 87 | yes |
| int-wasm-simd | photo | 3 | 300.5 | 2.48 | 83 | yes |
| int-wasm-simd | photo | 4 | 372.7 | 3.07 | 77 | yes |
| int-wasm-simd | photo | 5 | 468.8 | 3.86 | 77 | yes |
| int-wasm-simd | photo | 6 | 497.5 | 4.1 | 68 | yes |
| int-wasm-simd | photo | 7 | 595.8 | 4.91 | 70 | yes |
| int-wasm-simd | photo | 8 | 609.4 | 5.02 | 63 | yes |

<a id="table-solo-rgb2cmyk"></a>

### Solo control bench — one image, one engine, one process (rgb2cmyk)

`solo.rgb2cmyk` · MPx/s · measured by `bench/solo_photo/solo.js` · jsCE **1.5.5** · 2026-08-20

**image** jacek-dylag-559115_STRAWBERRIES-unsplash · **workflow** rgb2cmyk · **pixels** 1000000 · **warmupMs** 3000 · **samples** 7

| Engine | Median Mpxs | Spread Pct | Processes |
|---|---:|---:|---:|
| int | 47.7 | 1.1 | 5 |
| scalar | 65.9 | 1.4 | 5 |
| simd | 113.3 | 1.1 | 5 |

<a id="table-solo-rgb2lab"></a>

### Solo control bench — one image, one engine, one process (rgb2lab)

`solo.rgb2lab` · MPx/s · measured by `bench/solo_photo/solo.js` · jsCE **1.5.5** · 2026-08-20

**image** jacek-dylag-559115_STRAWBERRIES-unsplash · **workflow** rgb2lab · **pixels** 1000000 · **warmupMs** 3000 · **samples** 7

| Engine | Median Mpxs | Spread Pct | Processes |
|---|---:|---:|---:|
| int | 53.5 | 0.8 | 5 |
| scalar | 76 | 0.6 | 5 |
| simd | 114.9 | 0.9 | 5 |

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
| [`matrixShaper.throughput.int8`](#table-matrixshaper-throughput-int8) | `README.md`, `docs/deepdive/MatrixShaperKernel.md` |
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
| [`solo.rgb2cmyk`](#table-solo-rgb2cmyk) | *not cited yet* |
| [`solo.rgb2lab`](#table-solo-rgb2lab) | *not cited yet* |
