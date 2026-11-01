# Limits of interpolation speed

**jsColorEngine docs:**
[← Project README](../../README.md) ·
[Bench](../Bench.md) ·
[Performance](./Performance.md) ·
[Roadmap](../Roadmap.md) ·
[LcmsComparison](../LcmsComparison.md) ·
[WASM kernels](./WasmKernels.md)

---

> **If you are back here in six months asking “could we pack the LUT
> and go faster?” — you already had this conversation (August 2026).**
> The interpolator ladder is climbed. Speed is not the issue unless
> you are willing to give up 33³ quality, which we are not. Read the
> history, then the graveyard if you want the receipts.

## Conclusion

This engine is **mature on speed**. The big chunks are shipped: a
real ICC pipeline, a LUT image path, integer then WASM then SIMD
kernels, a matrix-shaper for RGB pairs that should never have been
a cube, and a worker pool for large buffers. What is left is bugs,
API polish, and (if anyone insists) cheaper pool copies — not
another interpolator.

The integer WASM SIMD tetrahedral kernels are no longer the slow
part of a JavaScript colour-management job. On photographs the 3D
LUT path sits around **100–120 MPx/s** single-threaded — **about
8 ms per megapixel**. A 1 MPx preview is done before the browser
has finished a layout pass. Decode, canvas, and the rest of the
page are usually larger. `transformImages()` already multiplies
that when the buffer is huge. We will not buy the next percent by
thinning the cube.

Figures in the ladder cite [BenchResults.md](../BenchResults.md)
(jsCE 1.6.0, Ryzen 7700X, photographs where the table says so).
Re-measure before quoting them as current. Historical rows are
labelled.

---

## The ladder — where we were, where we are

Every step was a **real** gain, not a micro-opt. The first useful
engine was a **float64 stage walker**: every pixel ran the full ICC
pipeline (`buildLut: false`). That was about **2 MPx/s** at the
start of the project, and the shipped accuracy path is still only
**~4–9 MPx/s** depending on the chain — [JS stage pipeline, photo
8.9](../BenchResults.md#table-matrixshaper-throughput-int8) on a
matrix pair; the v1.2 no-LUT column in
[Performance.md](./Performance.md) is ~3.8–5.0. Fine for a colour
picker. Unusable as an image converter.

Baking a LUT and **unrolling tetrahedral interpolation in float64**
was the first order-of-magnitude jump (~10×): one table walk instead
of curves + matrix + curves + CLUT per pixel. Then the same unrolled
shape in **integer JS** (`lutMode: 'int'`, Q0.8 weights on a 65280
table, `imul`) so V8 emits integer x64 and the later WASM kernels
can be bit-exact with JS. Integer is not “the JIT secretly turned
the floats into ints”; the loops were rewritten.

**WASM scalar** is that integer pipeline with no bounds checks on
every load and a tighter loop (~1.2–1.4× over JS `'int'`). **WASM
SIMD** is not a gather and not four pixels at once: it is
**channel-parallel, one pixel**, `v128.load64_zero` of a corner.
RGB wastes a lane; CMYK fills four; they land in the same speed
class. That is the last portable kernel trick JavaScript has.
128-bit `v128` is the ceiling; four-pixel SIMD wants gathers we
declined.

Two more rows on the table are **not** interpolator tricks. The
**matrix-shaper** kernel is for RGB pairs that lcms already runs as
curves + 3×3 + curves with **no CLUT** (~330 MPx/s on photos,
single thread). The **pool** is for large images: same kernels,
more cores. A 1 MPx preview should stay on one thread (~8 ms). Pool
spin-up is tens of milliseconds.

| Step | What it is | Ballpark (photos, 3D LUT unless noted) | vs walker |
|---|---|---|---|
| f64 stage pipeline | Full ICC chain, no LUT | ~2 early; **~4–9** shipped | 1× |
| f64 unrolled LUT | Tetra in JS doubles | ~50–70 *(v1.2 table; synthetic-era)* | ~10× |
| Integer JS unrolled | `'int'`, Q0.8 / 65280 | **~50** RGB→Lab/CMYK | ~10× |
| WASM scalar | Same math, no JS checks | **~70** | ~15× |
| WASM SIMD LUT | Channel-parallel `v128` | **~110–120** 3D; **~80** 4D | ~20–25× |
| Pool, SIMD LUT | `transformImages()`, 8 workers | **~600** | ~100× on *large* buffers |
| Matrix-shaper SIMD | No CLUT, RGB matrix pairs | **~330** 1 thread; **~1000** pooled | different algorithm |

Citations: integer / SIMD photo
[RGB→Lab](../BenchResults.md#table-js-content-rgb-lab-1024k)
53 / 112,
[RGB→CMYK](../BenchResults.md#table-js-content-rgb-cmyk-1024k)
49 / 113,
[CMYK→RGB](../BenchResults.md#table-js-content-cmyk-rgb-1024k)
45 / 81.
WASM scalar sequential photo
[pool.peak](../BenchResults.md#table-pool-peak) 71.5; SIMD LUT pool
peak 607. Matrix-shaper photo
[throughput](../BenchResults.md#table-matrixshaper-throughput-int8)
342 SIMD / 107 CLUT / 8.9 pipeline;
[pool 8 workers](../BenchResults.md#table-pool-matrixshaper-photo)
1064. From ~2 MPx/s to hundreds on a LUT photograph, and a
**thousand** on a pooled matrix-shaper RGB job, is the whole
performance arc. The remaining kernel ideas on this page do not
add another step like that.

**Where we could go** is not another interpolator. Pool copies and
v1.8 `toModule()` still help delivery.
Quality stays at 33³ (3D) / 17⁴ (4D) and u16 nodes. If a future
trick needs 9³ to look fast, it is not a trick we want.

---

## What we already have (and should keep)

- **Default 3D grid is 33³.** Smaller uniform cubes (9 / 17) are
  **not faster** on photographic + noisy content in the integer WASM
  path — the table is already in L2 (~211 KB of 3×u16 for 33³ vs
  32 KB L1d / ~1 MB L2). Bigger (65) is free on this class of
  machine and still not a quality substitute for a proper bake.
  Adaptive “HD zones” on a 9- or 17-point cube do not match a uniform
  17 or 33. Bake the size you need; do not invent a second grid
  format to save cache.
- **8-bit images already use a 16-bit table.** `buildIntLut` stores
  nodes on a **65280** scale (`255×256`) so `(v + 0x80) >> 8` is an
  unbiased u8. Weights are Q0.8 — enough, because 8-bit input into
  32 cells only has a handful of codes per cell. The extra bits are
  in the **corners**, plus the rounding bias in the accumulator.
- **Channels are already innermost.** That is why SIMD can
  `v128.load64_zero` one corner. Transport JSON / ICC nested
  `[X][Y][Z][ch]` is the same layout lcms and OCIO-CPU ship. That
  part is already the good packing.
- **Photo vs solid is mostly not “the LUT is too big.”** Solid ~
  180 MPx/s; real photos cluster ~109–132; +5 % noise ~98. **1 %
  noise with 36 distinct colours** already drops ~182 → ~109. Thirty-six
  cells fit in L1 under any layout. That cliff is tetrahedron
  selection / branches, not capacity. Layout tricks do not fix it.
  Methodology: [benchmark.md §20–21](./benchmark.md).

---

## Why “make the LUT smaller / denser” is a trap

**Accuracy needs 33³ (3D) in the regimes we care about.** A 17³ cube
is a preview. A 9³ cube is a toy. Fitting L1 (a 9³ 3ch u16 table is
a few KB) buys cache and spends tetra error. We already measured
that grid size on photo+noise is **flat for speed** and **not flat
for quality**.

**4D does not save you by going smaller on one axis.** A 17⁴ CMYK
table has fewer *points per axis* than 33³, but 17⁴ nodes and a long
K stride — you have packed *more* values, and the far corners are
still far. Shrinking 4D to 9⁴ to “fit cache” is the same quality
hole as shrinking 3D. Default 4D at 17 is already the size/quality
compromise; it is not a packing win waiting to be micro-laid-out.

**The working set of a photograph is a sliding handful of cells**,
not the whole cube. Sky is already L1. Noise walks the cube and
misses L1 regardless of 10-bit packing, because **33³ is ~3300 cache
lines and L1d is 512**. Packing 6 bytes to 4 (211 KB → 140 KB) does
not put 33³ in L1 — both numbers are L2. Expect **~0–5 %** from
density, often eaten by unpack, not 40 %. See [10-10-10](#pack-101010).

---

## Idea graveyard (with the research)

### 8-bit nodes for 8-bit pixels

**Do not replace the kernel table with u8 nodes.**

ICC files *may* store an 8-bit CLUT. lcms still interpolates in
**16-bit** (8-bit nodes expanded, `Lerp16`). Cheap GPU `RGBA8` 3D
textures *are* 8-bit nodes; colour pipelines moved those LUTs to
16-bit or half float for a reason.

Math: tetra of 8-bit corners with Q0.8 weights fits in ~18 bits of
product; a 32-bit `imul` is fine. The `+ 0x80` rounding bit is
required. Node quantisation vs a 16-bit bake, then round to u8, is
about **≤ 1 LSB** in the convex-combination bound — **plus banding**
wherever two true corners rounded to the same u8 and the slope died.
An early “u8 table + Q0.8 weights” port to **16-bit I/O** banded a
smooth ramp (identity error up to **17 LSB** at `g1=17`). That is
why int16 uses scale 65535 and Q0.13 weights. Do not relearn it.

JSON `dataType: 'u8'` is **wire** compression. Expand to u16 at
`fromJSON`. That is the only 8-bit packing that does not fight
rounding.

<a id="pack-101010"></a>

### 10-10-10 (or “bit-pack the texel”)

On paper you halve the cube. On this class of desktop you do not
change **cache level**, so you do not climb the knee.

A 33³ RGB cell is 3×u16 today (**211 KB**). Pack 10-10-10 into a
`u32` and it is **140 KB**. Ryzen-class L1d is **32 KB**; L2 is about
**1 MB**. Both sizes are comfortable in L2 and **hopelessly outside
L1**. The L1→L2 transition is still there. You paid an unpack
(`shift`/`and` into `i32x4`) to make L2 a little less busy.

| grid | 3×u16 | 10-10-10 in `u32` | 32 KB L1d? | Quality we will ship |
|---|---:|---:|---|---|
| 9³ | 4 KB | 3 KB | both yes | no — preview toy |
| 17³ | 29 KB | 19 KB | tight / maybe | preview, not 33 |
| **33³** | **211 KB** | **140 KB** | **neither** | **yes** |
| 65³ | 1.6 MB | 1.1 MB | L2 / L3 | free, not a substitute |

There is **no pack × grid** that is both in L1 and good enough.
Nine fits L1 and fails the colour. Thirty-three is the accuracy
floor and stays in L2 even packed. Seventeen is the only “maybe,”
and u16 is already tight against the image buffer; we already
declined 17 as a quality default.

The win you are hoping for is a sliver on the **knee**: solid,
smooth gradient, almost no variation — working set already a few
cells, already L1. Packing might shave a little there. A
photograph, or the same solid with **1 % noise (36 colours)**, is
already on the plateau. That cliff is tetra branches plus
non-streaming corners, not “211 KB vs 140 KB.” Slight variation
bottoms out like the full 16-bit table.

**A fatter cloud box does not flip this.** That is CPU cache, not
a GPU. DigitalOcean droplets, EPYC, Xeon, even V-Cache: **L1d
stays ~32–48 KB per core** (Apple P-cores ~128 KB — still not
211 KB). What servers add is cores and **L2/L3**. 33³ u16 already
lives in the 7700X’s 1 MB L2; more L3 makes packing *less* useful,
not more. No CPU you can rent puts a quality 33³ in L1. Packing
there is still 16-bit nodes plus an unpack tax.

Solid-colour throughput is the **branch / one-tetra** ceiling, not
“the cube fitted.” Extra cache will not turn photo+noise into
solid. A noisy shared vCPU is as likely to be *slower* than the
desktop as faster. If you ever provision a dedicated many-core
box, keep the u16 table and spend the money on **workers**, not a
packed kernel. **Do not build.** JSON u8 remains fine as **wire**,
expanded to u16 at `fromJSON`.

### Morton / tiled layout, same RAM

This is the interesting one, and it still is not a product change.

Tetra always interpolates from the cell’s **low corner** toward
`+x/+y/+z`. You never lerp “backwards.” You also cannot store each
node once **and** keep every overlapping 2×2×2 neighbourhood in one
cache line: those neighbourhoods overlap, so contiguous 8-corners
for every cell **is** the expanded brick (extra RAM). Volume
rendering states it as a recipe — non-overlapping bricks need a
one-voxel **ghost** for interpolation
([SGI Volumizer](https://techpubs.jurassic.nl/library/manuals/3000/007-3720-002/pdf/007-3720-002.pdf);
same overlap rule in the bricking literature). Kasson’s tetrahedral
work notes that storing each tetra together makes the tables much
longer.

Same-size tiles **phase** the problem: aligned (even-even-even)
cells are local; straddling cells are not. A 2×2×2 unique-vertex
tile makes **one eighth** of cells perfect and **one eighth** (all
odd origin) one vertex per tile — worse than today’s innermost
`+go0`. Larger tiles (4×4×4 / 8×8×8) plus GPU-style swizzle
([ryg on tiling](https://fgiesen.wordpress.com/2011/01/17/texture-tiling-and-swizzling/))
are what graphics actually uses. Space-filling curve papers quote
tens of percent when the **volume does not fit in cache**. Ours
does (L2). WASM address math (bit interleave vs `imul` of `go2`)
can eat a single-digit gain.

**POC if you must:** 4×4×4 or 8×8×8 tiles, channels still innermost,
photo+5 % noise, counters for L1. Do not expect a headline. Do not
ship on a hunch.

### 8-corner bricks (duplicate vertices)

One 64-byte line per cube if 8 corners × 8 bytes. Memory ~7×, not
+30 %. 33³ bricks ~1.5 MB, out of a 1 MB L2. Try 17³ first if you
ever try. Still may not move the 36-colour **branch** cliff.

### GPU 3D textures (RGBA = CMYK on the way out)

Hardware already swizzles the volume. A 3D **RGBA** texture is
**3-in / 4-out**: RGB→CMYK with `A = K` is the normal pack.
Hardware `LINEAR` is **trilinear, not tetra**. CMS-accurate GPU
paths (OCIO v2) sample nearest four times in the shader.

**4D** is not a 3D texture. Store **33 slices of 33³**, sample `k0`
and `k1`, lerp K in the shader. Two volume fetches. Do not
hardware-filter K inside a packed `depth = 33×33` volume — slice
joins bleed. You do not want 33 bind points; you want an array or
atlas.

**Latency:** a 1 MPx SIMD convert is ~8 ms. Browser GPU round-trip
(`readPixels` / `mapAsync`) is often **5–15 ms** before the shader
is interesting. [Roadmap — not doing GPU](../Roadmap.md#what-we-are-explicitly-not-doing)
already parked this: under ~10 MPx the bus wins; no GPU on Lambda /
headless RIP / CI. GPU wins when pixels **stay** on the GPU
(preview, video, compositor). Chase & Vondran (SPIE 2011) 3× GPU vs
CPU is throughput with the table resident, not `array()` returning a
`Uint8Array`.

### Dynamic / extract addressing

A related 2026 thread (not packing): one-load extract addressing
instead of `gps`. Elegant, **not** a replacement for baking 33.
Notes and a POC live under `_wip/dynamicLUT/`. Keep adapters for odd
foreign LUTs; do not swap the default cube.

---

## What to do instead when something is “slow”

Profile **their** page or job.

| If you see… | The lever is… |
|---|---|
| 8 ms kernel, 40 ms decode/draw | Not the interpolator |
| 50 MPx CMYK in one main-thread `array()` | Chunk + `transformImages()` |
| Preview of a 512² canvas | Already noise; stop |
| Commercial RIP / imposed 300 dpi sheet | I/O, flatten, screening; GPU only if pixels never come back to JS |

Having fun thinking about Morton cubes is how the kernels got this
fast. Shipping the next percent of LUT swizzle is past the point of
diminishing returns. The mill is turning; the interpolator is not
the stone.
