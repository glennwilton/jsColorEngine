# Pixel cache bench

Measures what the accuracy-path pixel cache is worth, per content type.

```bash
node bench/pixel_cache/cache_bench.js
```

Options: `--pixels <n>` (default 250000), `--iters <n>` (default 3).

## Correctness first

```bash
node bench/pixel_cache/verify_cache.js
```

Proves the cache is output-identical to no cache, byte for byte, across
every content type, four transform shapes (3- and 4-channel output, int8
and int16) and all cache modes — 108 whole-image comparisons plus an
FNV-1a hash of each buffer. Exits non-zero on any mismatch, so it can
gate a release.

This exists because colour-level unit tests cannot produce what a cache
bug needs to surface: evictions, hash collisions and long hit/miss
interleavings only appear at image scale. A reduced version (one
photograph, 60k pixels) runs as part of `__tests__/pixelcache.tests.js`
so the guarantee is checked on every test run.

## What it reports

For each content type, throughput with the cache off, then hit rate and
speed-up at `pixelCache` = 1, 16 and 32 slots.

**Hit rate is the number that transfers.** It describes the *data*, so it
also answers whether a cache is worth adding to the image kernels. The
MPx/s columns describe the accuracy path only — register pressure and
branch misprediction dominate in the kernels and are near-free here, so
these timings say nothing about that port.

## Content

| pattern | why it is here |
|---|---|
| `noise` | worst case, every pixel unique — mirrors `BENCH_INPUT=noise` in `bench/lcms_c/` |
| `gradient` | short flat runs — mirrors `BENCH_INPUT=gradient` |
| `checkerboard` | strict alternation: the case a single entry cannot catch and a table can. The cleanest separator between the two designs |
| `palette8` | flat art with no spatial coherence — 8 colours in random order |
| `solid` | best case, one colour — mirrors `BENCH_INPUT=solid` |
| `samples/images/*.png` | real photographs |

The synthetic generators deliberately match the native lcms harness so
results line up with the LittleCMS content-sensitivity measurements in
[docs/LcmsComparison.md](../../docs/LcmsComparison.md).

## Two ways to get a wrong answer

Both of these produced convincing but false results before being caught,
so the harness now guards against them:

**Do not trust `samples/images/`.** Those three PNGs are AI-generated
and adjusted, with unnaturally smooth gradients and large flat
backgrounds. They read 59–83 % hit rate; real camera output over the
same transform reads 3–41 %. Point `--images <dir>` at genuine
photographs.

**Do not cap the pixel count on large images.** `--pixels` takes the
first *n* pixels, which on a 19 MP frame is the top 1–3 % — normally
sky or background. One test photo measured 27.8 % resized, 7.5 % as a
250k top crop, and 3.2 % over the full frame. The bench now prints a
warning when it crops. Striding would sample evenly but destroy
adjacency, which is exactly what the `slots=1` column measures, so the
fix is to raise `--pixels`, not to stride.

## Results

Recorded in
[docs/deepdive/PixelCache.md](../../docs/deepdive/PixelCache.md).
Short version: photographs 3–41 % (0.84–1.05×), flat graphic content
67 % (1.22×), synthetic solid/checkerboard up to 3.2×, pure noise the
floor at 0.82×.

Five images is still not a corpus — screenshots, halftones and
print-origin scans are the classes most likely to favour the cache and
none are represented.
