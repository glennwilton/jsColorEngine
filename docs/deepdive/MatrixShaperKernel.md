# Matrix-shaper WASM kernel

**jsColorEngine docs:**
[← Project README](../../README.md) ·
[Bench](../Bench.md) ·
[Performance](../Performance.md) ·
[Roadmap](../Roadmap.md) ·
[Examples](../Examples.md) ·
[API: Profile](../Profile.md) ·
[Transform](../Transform.md) ·
[Loader](../Loader.md)

---

> **Status: shipped.** `src/kernels/matrixShaper/`, four prebuilt binaries with
> five alpha entry points each, registered as a **claiming kernel module**
> (`KernelMatrixShaper.js`) and controlled by the `wasmMatrixShaper` option.
> It is selected by PIPELINE SHAPE rather than channel count — see
> [KernelModules.md](./KernelModules.md#claiming-kernels--selected-by-pipeline-shape-not-channel-count)
> — and `transform.kernelInfo()` reports whether it took a given transform.
> The POC notes further down are kept as the working record; where the
> shipped result differs from what the POC expected, it is marked inline.

---

## What it is

An RGB→RGB matrix-shaper conversion is a curve, a 3×3 matrix and another curve.
This kernel runs exactly that, in WebAssembly, for `dataFormat: 'int8'` and
`'int16'`.

**It is not a new pipeline.** The engine's optimiser already folds an RGB→RGB
matrix-shaper pair into precisely this shape:

```
0. stage_Int_to_Device      (/255 or /65535)
1. stage_Gamma_Inverse      input TRC
2. stage_matrix_rgb         the fused 3x3, already combined across both profiles
3. stage_Gamma              output TRC
4. stage_device_to_int      (*255 or *65535)
```

so the kernel reads the nine coefficients straight off `stage_matrix_rgb`'s
`stageData` and fills both gamma tables by **calling the engine's own stage
functions**. No matrix maths, chromatic adaptation, or TRC curve-type handling
is reimplemented — which is what makes the kernel comparable with the pipeline
byte for byte rather than merely close.

That is also why the option is called `wasmMatrixShaper` and not
`matrixShaper`: the *fold* is the optimiser's and has always been there. What
is new is a WASM SIMD *implementation* of it. The JS float pipeline remains the
reference every accuracy claim below is measured against.

---

## Why not just use the CLUT

The engine's default for `dataFormat: 'int8'` with `buildLut: true` is a 33³
CLUT walked by a tuned WASM SIMD tetrahedral kernel. It is fast. The kernel
beats it on every axis that matters, but the interesting one is accuracy.

**Measured on this machine** — Node 24, 4 MPx of noise, `*prophoto → *sRGB`,
output buffer reused. Regenerated each  run into
[`matrixShaper.throughput.int8`](../BenchResults.md#table-matrixshaper-throughput-int8)
and [`.int16`](../BenchResults.md#table-matrixshaper-throughput-int16); the
figures below are from 2026-08-20 and move a percent or two between runs:

**Content is an axis here, not a detail.** A CLUT's throughput depends on how
much of its 214 KB table the pixels touch; the kernel's tables are 1-D and
small enough not to care. The ratio between the two moves by almost 2× across
this row, so a single number would be a claim about one image.

| int8 path | solid | noise | photo |
|---|---:|---:|---:|
| `wasmMatrixShaper` kernel, SIMD | **335** | **328** | **328** |
| `wasmMatrixShaper` kernel, scalar | 204 | 71 | 187 |
| `wasmMatrixShaper` kernel, plain JS | 97 | 55 | 89 |
| CLUT, `lutMode: 'int-wasm-simd'` (the default) | 191 | 101 | 119 |
| No LUT, JS stage pipeline (`wasmMatrixShaper: false`) | 9.8 | 8.1 | 8.6 |
| **kernel ÷ CLUT** | **1.75×** | **3.26×** | **2.75×** |

| int16 path | solid | noise | photo |
|---|---:|---:|---:|
| kernel, SIMD | **229** | **198** | **212** |
| kernel, scalar | 103 | 64 | 102 |
| kernel, plain JS | 80 | 38 | 60 |
| CLUT, `lutMode: 'int16-wasm-simd'` (the default) | 193 | 104 | 120 |
| JS stage pipeline | 9.7 | 8.1 | 8.5 |
| **kernel ÷ CLUT** | **1.18×** | **1.91×** | **1.76×** |

The other int8 `lutMode`s, on noise, for scale: `int-wasm-scalar` 107,
`float` 73, `int` 64.

Note the **scalar kernel row**: 209 on solid, 72 on noise. The scalar build is
far more content-sensitive than the SIMD one, because its 64 KB output table is
addressed by the encoded value — spread across the whole table on noise, one
cache line on solid — and a scalar loop has nothing to overlap the load
latency with. SIMD has twelve independent gathers in flight and barely
notices.

> **How this number moved — three measurements, three baselines.**
>
> The **first** read 2.2×, 229 against 105 MPx/s. The 105 is
> `int-wasm-scalar` rather than the default, so it put the SIMD kernel
> against the *scalar* CLUT — a comparison between two different things.
>
> The **second** fixed the baseline and moved the problem to the input:
> 1.66× at int8 and level at int16, on noise generated with `s % 256` from
> an LCG. An LCG's low bits have a period of 256, so that image carried a
> few hundred distinct colours — a solid wearing a noise costume, which is
> the CLUT's best case and neutral for the kernel. The multicore bench,
> already using a different generator, disagreed, which is what surfaced it.
>
> The **third** — the table above — uses bits 23–30 of the LCG and adds a
> real photo corpus, and the answer turns out to be a range rather than a
> number: **1.8–3.3× at int8, 1.2–1.9× at int16**, and on photographs 2.8×
> and 1.8×.
>
> The spread is the finding. With a 214 KB table on one side and 1-D tables
> on the other, the input picks the ratio, so a single figure here is a
> claim about one image.

Beyond throughput:

- **No 214 KB CLUT** and no 35,937-cell grid walk at `create()`.
- **No interpolation error.** This is the big one — see below.

---

## Scaling in the worker pool — the faster kernel scales *worse*

`bench/matrix_shaper_kernel/multicore.js`, int8, `*prophoto → *sRGB`, 4 MPx,
1–8 workers, medians of 5, CLUT and kernel interleaved so drift hits both.
Output checked byte-identical against each path's own sequential result.

**Photographic content:**

| workers | CLUT MPx/s | speedup | eff | kernel MPx/s | speedup | eff | kernel ÷ CLUT |
|---:|---:|---:|---:|---:|---:|---:|---:|
| *sequential* | 123 | — | — | 336 | — | — | 2.72× |
| 1 | 109 | 0.88× | 88% | 276 | 0.82× | 82% | 2.53× |
| 2 | 217 | 1.76× | 88% | 525 | 1.57× | 78% | 2.43× |
| 4 | 379 | 3.07× | 77% | 864 | 2.58× | 64% | 2.28× |
| 6 | 494 | 4.01× | 67% | 1094 | 3.26× | 54% | 2.21× |
| 8 | 611 | 4.96× | **62%** | 1060 | 3.16× | **39%** | 1.73× |

**Noise** tells the same story with the gap wider at the start and narrower at
the end: sequential 3.08×, 8 workers 5.34× / 67% against 3.31× / 41%, ratio
1.91×. Peak kernel throughput is ~1.1–1.2 GPx/s, reached at 6–7 workers.

### Why, and why it was predictable

The pool's per-fragment cost — copy into the worker, post, copy the result
back — is **fixed per pixel and does not parallelise**. Amdahl's serial
fraction is

```
overhead / (overhead + kernel time)
```

and the kernel shrinks the denominator by 2.7× without touching the numerator.
The same absolute overhead therefore becomes a much larger share of a much
smaller total, and efficiency has to fall. **A faster kernel makes the pool
look worse, necessarily.** Efficiency is a ratio against a moving baseline; it
is not a measure of how good the pool is.

### What that means in practice

- **The kernel still wins at every worker count** — 1.73× at 8 workers on a
  photo. It just wins by less than it does single-threaded (2.72×), because
  the pool is subsidising the CLUT more than it subsidises the kernel.
- **The kernel needs fewer workers to reach a given throughput.** 864 MPx/s
  takes the kernel 4 workers; the CLUT does not reach it at 8. If the budget is
  cores rather than time, that is the number that matters.
- **The kernel plateaus earlier.** It is at 1094 MPx/s by 6 workers and does
  not improve after that; the CLUT is still climbing at 8. Past ~6 workers the
  kernel is bound by main-thread orchestration, not by the conversion — the
  serial part is now the whole job.
- **`1 worker` is below sequential for both** (0.82–0.88×), which is the pool
  being honest: one worker pays copies and messages for no parallelism. That is
  why the baseline here is sequential `transformArray()` and not the 1-worker
  column.

None of this is an argument against either path. It is an argument against
reading efficiency percentages as a quality score: the row with the worst
efficiency in this table is also the row that finishes first.

### The JS implementation across cores — the slower kernel scales better

`bench/matrix_shaper_kernel/multicore_js.js`, int8 photo, 4 MPx. Workers are
pinned by `JSCE_MATRIX_SHAPER_VARIANT` because `useVariant()` sets a
module-level value and a worker is a separate module instance in a separate
thread. Byte-identical to sequential at every count, both arms.

| workers | WASM SIMD | eff | plain JS | eff | WASM advantage |
|---:|---:|---:|---:|---:|---:|
| *sequential* | 339.2 | — | 89.2 | — | **3.80×** |
| 1 | 268.5 | 79% | 82.8 | 93% | 3.24× |
| 4 | 918.4 | 68% | 294.8 | 83% | 3.12× |
| 6 | **1135.8** | 56% | 404.6 | 76% | 2.81× |
| 8 | 1073.0 | **40%** | 481.9 | **68%** | **2.23×** |

The same mechanism as the section above, one level down: the pool's fixed
per-fragment cost is a much smaller share of a 3.7× larger job, so **the slower
kernel keeps 68% efficiency where the faster one keeps 40%**, and is still
climbing at 8 workers where the faster one peaked at 6.

**The pool closes 40% of the WASM advantage** — 3.80× sequential to 2.23× on
eight cores. It does not close it: JS would need roughly 19 workers to reach
what SIMD does with 6, so there is no realistic crossover, and WASM stays the
right default wherever it is available.

Also visible here: **SIMD peaks at 6 and then wobbles** (987.5 at 7, 1073.0 at
8), which is the ±25% parallel variance recorded in
[multicore.md](./multicore.md). JS is monotonic through 8 because it is less
overhead-sensitive. The fast kernel is the one whose high-worker-count numbers
deserve the least trust.

### Would a different fragment size help? Measured: no

The obvious first thought is that the kernel wants larger fragments, since each
one now carries less work. `bench/matrix_shaper_kernel/overhead.js` sweeps it —
8 workers, 4 MPx photo, `tasksPerWorker` moved with `bufferPx` / `minSlicePx`
to reach the extremes:

| tasks | slice | kernel MPx/s | CLUT MPx/s |
|---:|---:|---:|---:|
| 8 | 524k px | 892 | 536 |
| 16 | 262k px | 1069 | 545 |
| 32 | 131k px | 1216 | 653 |
| **80** | **52k px** *(default)* | **1246** | 611 |
| 128 | 33k px | 1142 | 619 |
| 256 | 16k px | 926 | 538 |
| 512 | 8k px | 480 | 391 |
| 1024 | 4k px | 321 | 283 |

**The default is already at the kernel's peak.** The curve is sharper than the
CLUT's — cheaper work per fragment means per-task cost bites sooner at the
small end, and coarse load balance bites sooner at the large end — but the
optimum did not move. The CLUT nominally prefers 32 tasks (653 against 611),
which is inside what this bench moves between runs and not worth a per-kernel
knob.

The interesting part of that table is the bottom: below ~16k px per fragment
both paths fall off a cliff. That is `minSlicePx` earning its default.

### What the overhead actually is

Least squares of `T = S + P·(1/w)` over w = 2…7, per format. `S` is a small
difference of two large numbers, so it inherits nearly all the run-to-run
noise — an earlier two-point fit here reported S varying 3.6× across formats,
which was the estimator talking and not the pool. R² is printed so a bad fit is
visible rather than averaged into a number that reads as authoritative.

| | B/px | sequential | P | **S** | S ms/MB | R² |
|---|---:|---:|---:|---:|---:|---:|
| int8 RGB→RGB kernel | 6 | 2.977 | 3.267 | **0.308** | 0.051 | 0.994 |
| int8 RGB→RGB CLUT | 6 | 8.166 | 8.160 | **0.558** | 0.093 | 0.995 |
| int8 RGB→CMYK | 7 | 8.131 | 8.732 | **0.408** | 0.058 | 0.997 |
| int8 CMYK→RGB | 7 | 11.833 | 12.510 | **0.530** | 0.076 | 0.995 |
| int16 RGB→RGB kernel | 12 | 4.372 | 4.011 | **0.429** | 0.036 | 0.991 |

All ms/MPx. Ceilings at infinite workers: 3243 / 1792 / 2452 / 1887 / 2333
MPx/s respectively.

**MPx/s is the wrong unit for this.** Pixels are the right unit for work done —
that is what an image costs — but the pool's serial term is *bytes moved*, and
bytes per pixel is not a constant: 6 for int8 RGB→RGB, 7 for RGB→CMYK, 12 for
int16. Quoting "the pool tops out around 3 GPx/s" without naming the format is
meaningless; int16 tops out at about two thirds of that on the same hardware.

Measured directly, with no fitting at all — main-thread `memcpy` in and out,
no colour work:

| bytes/px | ms/MPx | ms/MB | GB/s |
|---|---:|---:|---:|
| 6 — int8 RGB→RGB | 0.213 | 0.0355 | 27.5 |
| 7 — int8 RGB→CMYK | 0.293 | 0.0418 | 23.4 |
| 12 — int16 RGB→RGB | 0.646 | 0.0538 | 18.1 |

Note that it is *worse* than proportional: 6 → 12 bytes costs 3.0×, not 2×,
because the working set doubles to 48 MB per pass and falls further out of
cache. Bytes is the right unit, but bytes are not a flat rate either.

**What S is not: purely the copies.** For int16 the copy floor (0.646) is
*larger* than the fitted S (0.429), which cannot be true of a serial cost — so
part of the copying overlaps worker execution, and S is the non-overlapped
remainder plus per-task cost. Two other caveats keep S honest: it is fitted on
an 8-core machine where the main thread competes for a core at w = 7, so it
absorbs some contention; and the per-task component (~8 µs × 80 tasks per
4 MPx ≈ 0.16 ms/MPx) is per *fragment*, not per byte. Treat S as an upper
bound on true serial work, and the copy floor as an upper bound on what
`SharedArrayBuffer` could remove from it.

### So: tune the scheduler, or delete the copies?

**Delete the copies.** Fragment size is already at its optimum, and the two
components of S respond to different things:

- Removing the main-thread copies — `SharedArrayBuffer`, so a worker reads its
  slice in place and writes the result in place — *looks* like it should take S
  down towards the ~0.16 ms/MPx per-task floor, which would be +33% at int8 and
  +50% at int16.

  **It was spiked, and it is worth 5–13% at int8 and nothing at int16.** The
  copies are largely interleaved with worker execution, so removing them frees
  time that was already hidden; `S` is contention and per-task cost, not memcpy.
  The clue was in this very table — the int16 copy floor (0.646) exceeds the
  int16 `S` (0.429), which cannot be true of a genuinely serial cost. Measured
  numbers, and why it was not built, are in
  [multicore.md](./multicore.md#measured-and-not-built-sharedarraybuffer-is-worth-513-not-30).
- Fewer, larger tasks would cut the per-task half, but the sweep above shows
  that trade is already at its optimum: what is gained in messages is lost in
  balance. It is also the smaller half — worth revisiting only once the copies
  are gone.

There is a second, smaller copy pair *inside* the worker: the kernel copies the
fragment into WASM linear memory and the result back out. Timed separately,
that is **7% of the int8 kernel call and 9% of int16** — real, but parallel, so
it divides by the worker count and is worth about a tenth of what the
main-thread copies are worth. The same shared-memory work removes both, which
is the argument for doing it once and properly: an imported shared
`WebAssembly.Memory` rather than each module defining its own, plus COOP/COEP
headers in a browser. Scoped in
[multicore.md](./multicore.md#where-sharedarraybuffer-would-and-would-not-help).

At 8 workers the int8 kernel's serial and parallel terms are 0.31 and 0.41
ms/MPx — near enough equal. It sits on the crossover, which is why more cores
stop helping around 6 and why the copies are the thing left worth attacking.

---

## Accuracy

Every figure is against **the exact JS stage pipeline**, not against a previous
release and not against a LUT. The pipeline is the arithmetic both the CLUT and
the kernel are approximations of.

### int8 — 262,144 colours per pair (64³ sweep)

| pair | kernel max | kernel > 1 LSB | CLUT max | CLUT > 1 LSB |
|---|---:|---:|---:|---:|
| sRGB → AdobeRGB | **1** | 0.000% | 4 | 0.594% |
| AdobeRGB → sRGB | **1** | 0.000% | 19 | 1.270% |
| sRGB → ProPhoto | **1** | 0.000% | 2 | 0.001% |
| ProPhoto → sRGB | **1** | 0.000% | **25** | 2.462% |
| sRGB → AppleRGB | **1** | 0.000% | 11 | 1.782% |
| sRGB → ColorMatch | **1** | 0.000% | 7 | 1.389% |

`lutMode: 'float'` was measured too and is no better — 26 LSB on ProPhoto →
sRGB. The error is not integer-LUT quantisation; it is tetrahedral
interpolation across the gamut-clip boundary, where the function the grid is
sampling has a crease in it. A finer grid moves the number, it does not remove
the mechanism.

**So the headline is a comparison of two approximations, not a regression.**
The kernel sits within 1 LSB of the maths. The CLUT it replaces is up to 25 LSB
from the same maths. Switching to the kernel is worth **up to 24 LSB of
improvement on the worst pair**, and it is faster — there is no trade being
made here.

### int16 — 113,157 colours per pair

The sample set is a 48³ sweep plus a dense near-black ramp, because the dark end
is where a 16-bit output table is hardest (see below).

| pair | kernel max | kernel > 1 LSB | CLUT max | CLUT > 1 LSB |
|---|---:|---:|---:|---:|
| sRGB → AdobeRGB | **1** | 0.000% | 1199 | 41.5% |
| AdobeRGB → sRGB | **1** | 0.000% | 3934 | 62.0% |
| sRGB → ProPhoto | **1** | 0.000% | 492 | 89.2% |
| ProPhoto → sRGB | **1** | 0.000% | 6668 | 65.5% |
| sRGB → AppleRGB | **1** | 0.000% | 2770 | 29.3% |
| sRGB → ColorMatch | **1** | 0.000% | 1836 | 65.9% |

The CLUT numbers are not a bug: a 33³ grid carries the same *relative* error
whatever the container is, so at 16 bits the same interpolation error is 257×
more codes. If you ask for `dataFormat: 'int16'` because you want 16 bits of
precision, a 33³ CLUT is not delivering it and this kernel is.

---

## Four binaries

`{int8, int16} × {SIMD, scalar}`, all generated by
`scripts/build_matrix_shaper_wasm.js` and shipped base64-encoded.

| binary | .wasm | tables |
|---|---:|---|
| `matrix_shaper_int8_simd` | 1131 B | 1 KB in, 64 KB out |
| `matrix_shaper_int8_scalar` | 409 B | 1 KB in, 64 KB out |
| `matrix_shaper_int16_simd` | 1215 B | 256 KB in, 256 KB out |
| `matrix_shaper_int16_scalar` | 427 B | 256 KB in, 256 KB out |

One `WebAssembly.Module` per variant for the whole process; one `Instance` per
Transform, because the tables and the matrix live in that instance's linear
memory. **The matrix is loaded from linear memory, not baked into the code** —
which is what lets a single prebuilt binary serve every profile pair, and
retires the sentinel-patching scheme described in the POC notes below.

### The input table is exact

One f32 entry per possible input code — 256 at int8, 65536 at int16. The input
code *is* the table index (`code << 2` is the address), so there is no
interpolation and no rounding on the way in.

### The output table, and why int16 indexes by a fourth root

The output table maps a linear-light value to an encoded output code, by
rounded lookup — **one load, no interpolation, at both depths**.

At int8 the index is linear in the light value, with 65536 entries for 256
possible answers: 256× oversampled, and measured at ≤ 1 LSB.

At int16 a linear index **does not work**. A power TRC's encode curve has
unbounded slope at zero, so the first table interval alone carries ~260 LSB of
error at 16 bits. That error exists at 8 bits too — it just hides under 1/257th
of a code.

The fix is to index by `v^(1/4)` instead of `v`. Substituting `v = t⁴` turns
`v^(1/g)` into `t^(4/g)`, and `4/g > 1` for every TRC in practice, so the curve
has bounded slope and no singularity at the origin. The worst case moves from
black to white, where the error is `(4/g)/4` LSB — with 2¹⁷ entries that is
0.42 LSB at gamma 2.4, 0.56 at gamma 1.8, and 1.0 for a linear TRC.

The fourth root is two `f32.sqrt` instructions.

> **An interpolated table was built and measured first**, and rejected: 65537
> f32 entries indexed by `sqrt(v)`, accurate to 0.1 LSB, and **40 MPx/s** —
> five times slower than the int16 CLUT it is meant to replace, and *slower in
> SIMD than in scalar*, because twelve `extract_lane → load → lerp` chains per
> iteration are pure latency. A solid-colour image ran at 49 MPx/s against 41
> for noise, so it was never the cache; it was the ops. One rounded lookup is
> the whole point of having a table.

### Hoisting the encode into SIMD

The single largest win in the whole kernel, and it was the last one found.

The obvious way to write the output stage is to extract each lane and do the
clamp, root, scale and round in scalar — twelve times per iteration. Doing all
of it on the vector first, and extracting only the finished integer index, is
worth:

| noise, MPx/s | before | after |
|---|---:|---:|
| int8 SIMD | 210 | **333** |
| int16 SIMD | 131 | **209** |

That is `f32x4.min` / `max` / `sqrt` / `mul` / `add` and one
`i32x4.trunc_sat_f32x4_u` per channel vector, then twelve
`i32x4.extract_lane`. The gather and the store stay per-lane — WASM SIMD has no
gather instruction — but nothing else needs to.

The POC's "open questions" predicted `i32x4.trunc_sat_f32x4_u` would be worth
about 8%. It was worth 62%.

### Alpha — five entry points, one module

Alpha used to disqualify the kernel outright, and that was the single worst
number in the library:

| int8 `*prophoto → *sRGB`, 4 MPx RGBA | MPx/s |
|---|---:|
| generic JS loops — where RGBA landed | 8.0 |
| CLUT | 101.6 |
| **kernel, 4→4 alpha copied** | **321.7** |
| kernel, 3→3 for comparison | 331.5 |

`buildLut` defaults to `false` and canvas `ImageData` is RGBA, so the commonest
input in a browser was taking a **40× penalty** against the identical
conversion without alpha. Not a slope to shave — a cliff.

**Alpha costs 3%** (331.5 → 321.7), because it is one load and one store per
pixel against roughly fifteen instructions for the colour, and the scheduler
hides most of it behind work that has nothing to do with it.

#### The four shapes

| export | in | out | alpha |
|---|---:|---:|---|
| `run` | 3 | 3 | none |
| `run_a_in` | 4 | 3 | source alpha dropped |
| `run_a_out` | 3 | 4 | written opaque |
| `run_a_copy` | 4 | 4 | copied through |
| `run_a_fill` | 4 | 4 | written opaque (`preserveAlpha: false`) |

Four shapes × two bit depths × SIMD/scalar would have been **sixteen binaries**
to ship, compile and keep in step. Instead each `{depth, SIMD}` module gains
five entry points: ~4 KB of extra code, one compile, and the gamma tables and
matrix — the expensive part, and identical across shapes — shared between them.
Picking an export costs nothing at call time.

**The strides are baked in per function**, so the 3→3 path keeps its constant
`offset=` operands and pays nothing for the other shapes existing. That was the
argument for doing it this way; the section below measures it and finds the
argument does not hold up — a runtime parameter would have been just as fast.
The design survives on legibility, not on speed.

**Alpha is never colour-managed.** It is opacity, not a colorant; running it
through a TRC and a 3×3 would be a bug that looks like a haze. So it sits
outside the maths entirely as a plain load and store — and the tests assert it
comes through **exactly**, not within 1 LSB, because 1 LSB of drift on an
opacity channel is a defect rather than a rounding.

The alpha stores are emitted *before* `inPos` advances, so the copy variant can
still read the source byte; they are independent of the colour chain, which is
what lets the scheduler overlap them.

#### Specialised exports or a runtime branch? Measured: it does not matter

The alternative shape is one entry point taking alpha parameters and branching
at the top — which is exactly what the 3-D CLUT kernel already does:

```wat
(param $inAlphaSkip  i32)   ;; 0 or 1
(param $outAlphaMode i32)   ;; 0 = none, 1 = fill 255, 2 = preserve-copy
```

`tetra3d_simd.wat` guards it with a single `i32.or` per pixel so the no-alpha
path collapses to one predictable test. So the library now contains both
designs, and they can be compared directly — same noise, same pixel count,
same profile pair:

| | 3→3 | 4→4 copy | cost | per pixel |
|---|---:|---:|---:|---:|
| tetra3d CLUT — runtime params, branch per pixel | 101.7 | 100.4 | 1.3% | +0.13 ns |
| matrix-shaper — specialised export, no branch | 331.9 | 320.7 | 3.4% | **+0.11 ns** |

**The absolute cost is the same** — about 0.12 ns per pixel, or well under a
cycle. That is the extra load, the extra store and the wider stride; the branch
in the CLUT kernel costs less than this bench can resolve. The percentages
differ only because the matrix-shaper's per-pixel budget is three times
smaller, so the same fixed cost is a larger share of it.

So the choice is not a throughput one, and the runtime-parameter design would
have been equally fast. Separate exports were kept for two other reasons: each
shape is independently addressable from a test, and the emitted `.wat` reads as
five plain loops instead of one loop with branches in it — which matters more
than usual for generated code nobody edits by hand. Neither reason is
performance, and the file should not pretend otherwise.

#### Premultiplied alpha is NOT handled, and the error is large

The engine assumes **straight (unassociated) alpha** — colour channels that
mean what they say, with opacity carried alongside. Canvas `getImageData`
returns exactly that, which is the common case.

If the data is **premultiplied** (associated), the stored colour is `a·C`, and
running that through the transform gives `T(a·C)` where the correct answer is
`a·T(C)`. Those are not the same thing, because the transform is not linear —
there is a TRC at each end. Measured on `*prophoto → *sRGB` over a 32³ sweep:

| alpha | max error | mean |
|---:|---:|---:|
| 1.00 | 0 LSB | 0.0 |
| 0.75 | 64 LSB | 7.0 |
| 0.50 | **69 LSB** | 9.2 |
| 0.25 | 47 LSB | 7.8 |
| 0.10 | 23 LSB | 3.5 |

**Up to 69 LSB** against a kernel that is otherwise inside 1. Nothing about the
kernel causes this — the CLUT and the JS pipeline are equally wrong on
premultiplied input, and always have been. It is worth stating here only
because this is the file that made alpha fast, and speed on a wrong answer is
not an improvement.

There is no way to detect it: premultiplied and straight buffers are the same
bytes. So the caller has to know — which is why this is **not** a Transform
option. A `premultipliedAlpha: true` flag would be something the Transform
cannot verify, threaded through the pipeline, the LUT path, the pool and the
workers, to control what is really one pass over an array.

`src/alpha.js` provides that pass instead, as three helpers on the public
export:

```js
const { alpha } = require('jscolorengine');

// premultiplied source, transparency preserved
const straight = alpha.unpremultiply(rgba, n);
const converted = transform.transformArray(straight, true, true, true, n);
const result = alpha.premultiply(converted, n);

// or, when the destination has no alpha at all
const opaque = alpha.flatten(rgba, n, {background: [255, 255, 255],
                                       premultiplied: true});
```

Measured on the same sweep, `*prophoto → *sRGB` at `a = 0.5`:

| route | max | mean |
|---|---:|---:|
| `T(a·C)` — convert premultiplied data directly | 63 LSB | 8.80 |
| unpremultiply → convert → premultiply | **8 LSB** | **0.21** |

**42× closer on the mean, and not zero** — at `a = 128/255` the premultiply
quantised the colour to half its codes, so dividing back out cannot recover
what was thrown away, and ProPhoto → sRGB then amplifies the residue in the
shadows where its curve is steep. The helpers do not make premultiplied storage
lossless; nothing can. They stop the transform adding a much larger error on
top of it.

**`flatten()` is a different job from `unpremultiply()`**, and the two get
confused: unpremultiply recovers the colour and *keeps* the alpha channel so
the image stays transparent; flatten composites against a background and
*discards* it, which is what a destination without alpha needs. Flattening must
happen in the SOURCE space, before the conversion — the same two colours
blended in sRGB and in AdobeRGB give different answers — so the background is
specified in source encoding, and is required rather than defaulted.

#### Buffers

`reserve()` sizes linear memory for **four** channels whatever the current
shape. One Transform can be handed RGB on one image and RGBA on the next, and
sizing to the call in hand would mean a `memory.grow()` — and a detached
buffer — on the first RGBA image. A third of headroom on a transient buffer is
the cheaper mistake.

### The scalar builds are f32, and bit-identical

They exist for hosts without WASM SIMD, and the one thing that matters about a
fallback is that it gives the **same answer**, not a similar one — otherwise
output depends on the browser.

Every lane of the SIMD kernel performs IEEE-754 f32 multiply and add in a fixed
order. The scalar build performs the same operations in the same order, so the
two are bit-identical, and the tests assert **exact equality** rather than a
tolerance. A 32-bit fixed-point variant was considered and rejected: it would
have been a second, differently-rounded implementation to validate, for no
speed, since f32 arithmetic is native on every target that runs WASM at all.

Because every machine that runs the suite has SIMD, the fallback is unreachable
without help — so `matrixShaper.useVariant('scalar' | 'simd' | null)` pins it.
Unreachable code is untested code.

On photographic content:

| | int8 | int16 |
|---|---:|---:|
| SIMD | 331 MPx/s | 225 MPx/s |
| scalar | 191 MPx/s | 103 MPx/s |
| the CLUT, for scale | 123 MPx/s | 125 MPx/s |

So even the scalar fallback beats the CLUT on a photo. On noise it does not
(72 against 104) — see the content note above.

---

## Using it — the `wasmMatrixShaper` mode

```js
new Transform({ dataFormat: 'int8', wasmMatrixShaper: 'auto' })   // default
```

| mode | `buildLut: false` | `buildLut: true` |
|---|---|---|
| `'auto'` *(default)* | kernel | CLUT — nothing the caller asked for changes |
| `'prefer'` | kernel | **kernel, and no CLUT is built** |
| `false` / `'off'` | JS stage pipeline | CLUT |

`matrixShaper` and `preferMatrixShaperOverLUT: true` are accepted spellings of
the same thing, in the same spirit as `buildLut` / `builtLut`.

**"Prefer" and not "force":** the kernel declines for a list of ordinary
reasons, and a mode named `force` would either have to throw on all of them or
quietly not force.

`'prefer'` is opt-in rather than the default because **a LUT is also an
object** — callers export it with `toJSON()`, clone and diverge it, and manage
its WASM memory. Replacing it silently would break all of that, even though the
replacement is faster and more accurate.

### When it declines

Declining is normal, not a failure. `matrixShaper.inspect(transform)` returns
`{ok, why}` so a caller can find out which of these applied:

- `dataFormat` is not `int8` or `int16`
- not 3-channel in and out
- a LUT was built (in `'auto'`; the CLUT path owns that transform)
- the pipeline is not those five stages in that order — an identity pair
  collapses to three, a Lab source produces different ones, an abstract profile
  in the chain adds some
- a LUT-**based** RGB profile: `RGB` in the header does not mean matrix-shaper,
  and these produce interpolation stages
- the input or output TRC differs per channel — one table per direction cannot
  serve three different curves, and applying red's curve to green would be
  silently wrong rather than merely slow
- a pixel cache is active
- WebAssembly is missing entirely

A host without SIMD is **not** on that list: it gets the scalar build.

In `'prefer'` mode there are three more refusals, all of the same kind —
*something depends on the LUT existing*:

- `lutInputHook` / `lutOutputHook` — these run **inside the grid walk**. Skip
  the walk and they never execute, silently, with the caller believing their
  hook was applied.
- `lutGamutMode` other than `'none'` — gamut mapping is baked at build time.
- a non-RGB destination.

The `'prefer'` decision is taken during `create()`, against the **temporary
device-to-device pipeline the LUT builder makes before it walks the grid** — a
pipeline that exists, rather than a guess from profile types. That matters:
`sRGB → sRGB` with identity detection on collapses to three stages and must
keep the ordinary path, which no amount of inspecting `inputProfile.type` would
have revealed. Saying yes means no CLUT is built, so a later refusal by
`inspect()` would strand the caller on the generic loops at 8 MPx/s — worse
than the CLUT that was skipped. Both checks therefore test the same conditions.

### `toJSON()` on a transform the kernel took

There is nothing to export — the kernel is a pair of 1-D tables and a 3×3, not
a CLUT — so `toJSON()` throws. In `'prefer'` mode the caller *did* pass
`buildLut: true`, so the generic "construct it with `buildLut: true`" message
would be advice they had already followed; the error names
`wasmMatrixShaper: 'prefer'` as the cause and points at `'auto'` as the way
back. The kernel still runs under `'auto'` wherever there is no LUT to
displace, so nothing is lost but the CLUT-displacing case.

### Cost of building it

Resolved **lazily**, on the first `transformArray` call, not at `create()`.
Filling the tables costs 3–4 ms at int8 and roughly twice that at int16 —
worth paying for an image, wasted on a Transform that only ever converts single
colours, and the gamut helpers build several of those per LUT.

Per-instance linear memory is ~128 KB at int8 and ~576 KB at int16 before pixel
buffers, which are grown on demand to hold one input and one output copy.

---

## Regenerating the binaries

```
node scripts/build_matrix_shaper_wasm.js
```

Writes four `.wat` files and four base64 `.wasm.js` files into
`src/kernels/matrixShaper/`. The generator holds the memory layout in one
place, so the two bit depths cannot drift apart, and the emitted `LAYOUT` is
what the kernel reads — there is no second copy to keep in step.

---
---

# Appendix — POC history

Everything below is the original proof-of-concept record, kept because the
measurements in it are real and the reasoning is worth having. It describes an
earlier design and is superseded in several places, most notably: the output
table size, the sentinel-patching scheme, the `kernel3D` variant integration,
and the async `create()`. Read the sections above for what shipped.

## Design

### Fused matrix

The standard pipeline is `source_RGB → XYZ(D50) → dest_RGB`. Two 3×3 matrix
multiplies per pixel. Fusing them collapses this to one:

```js
const fused = mulMat(dstProfile.RGBMatrix.XYZMatrixInv,
                     srcProfile.RGBMatrix.XYZMatrix);
```

Both `XYZMatrix` (RGB→XYZ) and `XYZMatrixInv` (XYZ→RGB) are already computed
and stored on the Profile object when the virtual or ICC profile is loaded.
`mulMat` is nine dot products.

White preservation check: `fused × [1,1,1]` should return `[1,1,1]` (both
profiles are D50-adapted; white maps to white). The POC verifies this at
startup — it's a useful sanity check before compiling the WASM.

### Dynamic WASM emission

The kernel is a short WAT module (~2 KB compiled) with the 9 matrix
coefficients embedded as `f32.const` literals. Because the coefficients vary
per profile pair, the module is emitted at `create()` time, not shipped as a
static binary. Two approaches, one for each phase:

**POC / development:** use `wabt` (already a devDependency) to parse a WAT
template string at runtime — fill `{{m00}}..{{m22}}` placeholders via
`String.replace()`, then `wabt.parseWat()` → `mod.toBinary()` →
`WebAssembly.compile()`. Flexible, readable.

**Production (planned):** compile the WAT template once at build time into a
static binary with sentinel `f32.const` values standing in for each
coefficient. At `create()` time, scan the binary for the sentinel byte
sequences, replace them with the actual f32 bytes, then compile. No runtime
dependency on `wabt`. Full design in the
[production path section](#production-binary-patching) below.

### Gamma — 256-entry LUTs in WASM linear memory

WASM has no `f32.pow` instruction and no way to call `Math.pow` without
importing it from the host (an extra call per channel). Instead, build a
256-entry lookup table in JS at `create()` time — one entry per possible input
u8 byte value — and write it into WASM linear memory.

```
WASM linear memory layout (v2):
  Bytes    0.. 1023   gamma_inv_256: 256 × f32  (1 KB) — indexed by input byte
  Bytes 1024.. 1279   gamma_fwd_256: 256 × u8   (256 B) — indexed by rounded output
  Bytes 1280+         pixel input / output buffers
```

**Total gamma data: 1.25 KB.** Both tables fit in a single L1 cache line
region. The lookup per channel:

```wat
;; Input decode: load input byte → shift left 2 (×4 bytes per f32) → load f32
(f32.load (i32.shl (i32.load8_u (local.get $inPos)) (i32.const 2)))

;; Output encode: clamp → scale 255 → round → look up 256-byte gamma table
(i32.load8_u (i32.add (i32.const 1024) rounded_int))
```

**Two ops per channel**, no function call, no branch, no clamp loop.

This handles any curve — sRGB piecewise, simple power law, ICC parametric
type 3/4 — because the table is built in JS using the profile's own TRC
evaluator. The POC uses `x^2.2` / `x^(1/2.2)` for simplicity; production
uses `srcProfile.applyInverseTRC(v)` and `dstProfile.applyTRC(v)`.

### SIMD: byte-as-index directly into f32x4 lanes

The SIMD variant (v4 — the canonical kernel) processes 4 pixels per iteration.

**Input loading:** Each RGB byte value is already a valid index into the 256-entry
gamma table. The byte IS the table index — no shuffle, no gather, no intermediate
representation needed. Read each byte with a constant offset from one base pointer,
shift left 2 (× 4 bytes per f32), load the f32 directly into an f32x4 lane:

```wat
;; 12 byte loads with immediate offsets — one base register ($inPos), no pointer arithmetic
;; Each f32.load(byte * 4) IS the gamma-decoded lane value — loaded directly into the f32x4
(local.set $vR
  (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
    (f32x4.splat
      (f32.load (i32.shl (i32.load8_u           (local.get $inPos)) (i32.const 2))))
    (f32.load  (i32.shl (i32.load8_u offset=3  (local.get $inPos)) (i32.const 2))))
    (f32.load  (i32.shl (i32.load8_u offset=6  (local.get $inPos)) (i32.const 2))))
    (f32.load  (i32.shl (i32.load8_u offset=9  (local.get $inPos)) (i32.const 2)))))
;; Repeat for vG (offsets 1,4,7,10) and vB (offsets 2,5,8,11)
```

An earlier v2 variant used `v128.load` + `i8x16.shuffle` to gather the bytes,
then `i8x16.extract_lane_u` to recover the scalar index for the gamma table lookup.
That added 3 shuffles + 12 extract-lane ops for no benefit: the bytes are needed as
scalars anyway (for the LUT index), so the wide load creates work rather than saving
it. Direct individual loads with immediate offsets are 4 ops fewer and simpler.

**Matrix multiply:** The 9 coefficients are loaded into v128 locals **once before
the loop** — `(local.set $cm00 (v128.const f32x4 m00 m00 m00 m00))` etc. — and
referenced inside the loop via `local.get`. This guarantees the JIT keeps them in
XMM registers rather than re-materialising from the constant pool each iteration.
Measured 3% gain over trusting the JIT to hoist (`v128.const` inline in the loop).

The 3×3 multiply across all 4 pixels simultaneously: 9 `f32x4.mul` + 6 `f32x4.add`.

```wat
(local.set $vRo (f32x4.add (f32x4.add
  (f32x4.mul (local.get $vR) (local.get $cm00))
  (f32x4.mul (local.get $vG) (local.get $cm01)))
  (f32x4.mul (local.get $vB) (local.get $cm02))))
;; Repeat for vGo (cm10/cm11/cm12) and vBo (cm20/cm21/cm22)
```

**Output encoding:** Per-lane `f32x4.extract_lane` + clamp + scale + round +
256-byte u8 LUT lookup. This is 12 sequential lookups (R/G/B × 4 pixels). No
WASM gather instruction exists for the LUT step — this is the remaining bottleneck.
Vectorising it via `i32x4.trunc_sat_f32x4_u` for the clamp + scale step is a
future optimisation.

---

## POC: what we learned measuring it

Runnable: `node bench/matrix_shaper_poc/bench_matrix_shaper.js`

The bench compiles several WASM modules at startup and measures 1 M pixels ×
20 timed runs on Node. Four SIMD variants were explored in sequence; each round
exposed a different bottleneck.

### V1 — function call bottleneck

The first implementation used a `$gamma_lut` helper function called 6× per
pixel (3 for input decode, 3 for output encode). Each call included a clamp
(`f32.min` + `f32.max`), a multiply, `i32.trunc_f32_u`, a `select`, `i32.shl`,
and `f32.load` — roughly 8 WASM instructions plus call overhead.

The SIMD kernel was only 12% faster than scalar. The f32x4 matrix multiply was
fast; the 24 function calls per 4-pixel batch swamped it. The 4096-entry LUT
(64 KB) also spilled out of L1 cache.

Key insight: the function was doing clamping work that wasn't needed. The input
is a `u8` byte (0..255) — it's already clamped. The clamping existed only
because the function accepted a general f32.

### V2 — inline 256-entry LUTs (+3.2× over v1 scalar)

Replacing the function call with direct byte-value indexing changed the
per-channel input decode from 8 ops + call overhead to:

```
i32.load8_u → i32.shl → f32.load    (3 ops, no call, no branch)
```

The 4096-entry f32 table (64 KB, prone to L1 miss) became a 256-entry f32 table
(1 KB, always in L1 cache). The output encode became an inline clamp + scale +
round + 256-byte u8 lookup.

The scalar variant jumped from 52 → 164 MPx/s. The SIMD variant (using
`v128.load` + `i8x16.shuffle` to gather R/G/B bytes) reached 177 MPx/s — only
8% over scalar because the shuffle+extract overhead was disproportionate.

### V3 — bytes as direct indices, no shuffle (+23% over v2 SIMD)

The `v128.load` + shuffle approach was reconsidered. The bytes are needed as
scalar indices for the gamma table lookup anyway — the wide load just creates
extra work (shuffle to gather, then `extract_lane_u` to recover the scalar).
Direct individual `i32.load8_u` calls with immediate offsets are simpler and
faster: one base register, 12 constant offsets, no shuffle, no extract.

The decoded gamma f32 value goes directly into the f32x4 lane via
`f32x4.splat` / `f32x4.replace_lane`:

```wat
(local.set $vR
  (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
    (f32x4.splat (f32.load (i32.shl (i32.load8_u           (local.get $inPos)) (i32.const 2))))
    (f32.load    (i32.shl (i32.load8_u offset=3  (local.get $inPos)) (i32.const 2))))
    (f32.load    (i32.shl (i32.load8_u offset=6  (local.get $inPos)) (i32.const 2))))
    (f32.load    (i32.shl (i32.load8_u offset=9  (local.get $inPos)) (i32.const 2)))))
```

Saves 3 shuffles + 12 `extract_lane_u` = 15 ops per 4-pixel batch. Result:
177 → 202 MPx/s.

### V4 — matrix constants pre-loaded into v128 locals (+3% over v3)

With `v128.const` inline in the loop body, V8's JIT *should* perform
loop-invariant code motion (LICM) and hoist them. But with 9 matrix constants
+ 6 working registers = 15 XMM registers required simultaneously (the x86_64
limit is 16), register pressure prevents full hoisting — some constants were
being re-materialised from the constant pool each iteration.

Explicitly loading the 9 constants into `v128` locals **once before the loop**
guarantees hoisting regardless of JIT heuristics:

```wat
;; Before the loop — loaded once, kept in XMM registers
(local.set $cm00 (v128.const f32x4 M00 M00 M00 M00))
;; ... through cm22 ...

;; Inside the loop — local.get, not v128.const
(f32x4.mul (local.get $vR) (local.get $cm00))
```

Measured 3% gain: 202 → 208 MPx/s. A small but consistent improvement, and
the explicit hoisting is the correct design for any tight loop over large data.

### V5 — 4096-entry output gamma table (zero throughput cost, 4× accuracy)

The output gamma table quantises the continuous float matrix result into an
integer index before the u8 LUT lookup. With 256 entries the maximum error at
the sRGB knee (slope ≈ 12.92) is ±6.5 LSB — which matches the 8 LSB diff
measured in the POC. With 4096 entries the error drops to ±0.4 LSB.

**Table sizing rationale:**

| Table | Entries | Size | Direction | Why this size |
|---|---|---|---|---|
| `gamma_inv` (f32) | 256 | 1 KB | u8 byte → linear f32 | One entry per possible input value — exact by definition |
| `gamma_fwd` (u8) | 4096 | 4 KB | linear float → encoded u8 | Float has sub-1/255 resolution; 256 entries loses precision at high-slope knee |

Both fit in the first 5 KB of WASM linear memory — well within L1 cache. The
WASM memory layout is fixed: gamma_inv at byte 0, gamma_fwd at byte 1024,
pixel data at byte 5120.

Measured result: 202 MPx/s vs 208 MPx/s for v4 — effectively zero cost. The
4096-entry output table is therefore always the correct choice for u8 output.

For **u16 output** (future): `gamma_inv` becomes 65536 × f32 = 256 KB, and
`gamma_fwd` becomes 65536 × u16 = 128 KB. Both still fit in L2 cache. The
pattern is identical — only the table sizes and index scale change.

### Final benchmark (Node, 1 M pixels)

| Variant | MPx/s | vs v1 scalar | what changed |
|---|---|---|---|
| V1 scalar (4096-entry LUT + function call) | 52 | 1.0× | baseline |
| V1 SIMD (f32x4 + per-lane function calls) | 60 | 1.2× | f32x4 matrix |
| jsCE int-wasm-simd (3D CLUT reference) | ~88 | 1.7× | baked CLUT, no per-px gamma |
| V2 scalar (256-entry inline, no call) | 164 | 3.2× | inline gamma LUTs |
| V2 SIMD (v128.load + shuffle) | 176 | 3.4× | + wide load + shuffle |
| V3 SIMD (byte→index→lane directly) | 202 | 3.9× | eliminated shuffle+extract |
| V4 SIMD (v3 + pre-loaded constants) | 208 | 4.0× | explicit constant hoisting |
| **V5 SIMD (v4 + 4096-entry output table)** | **202** | **3.9×** | 4× accuracy, zero extra cost |

**~200 MPx/s** is the stable ceiling for the Node JIT. V5 is the production
design: same speed as v4, 4× better output precision.

**Browser numbers (Chrome/V8 TurboFan WASM SIMD, `bench/matrix_shaper_poc/bench_browser.html`):**

| Variant | 65K px/call | 4M px/call |
|---|---|---|
| **V5 SIMD — matrix-shaper WASM (u8)** | **257** | **250** |
| jsCE int16-wasm-simd (3D CLUT, pre-alloc out) | 112 | — |
| jsCE int8-wasm-simd  (3D CLUT, pre-alloc out) | 96 | 99 |
| jsCE int JS (3D CLUT, pre-alloc out) | 54 | 52 |

**V5 is stable at 250–257 MPx/s** regardless of run size. The ratio vs the
best jsCE path is **2.3–2.7×** depending on measurement conditions:

- **2.7× vs int8-wasm-simd** at 65K px/call (standard bench run size)
- **2.3× vs int16-wasm-simd** at 65K px/call (int16 beats int8 here; reversed
  in the standard bench which shows int8 at 174, int16 at 160 MPx/s)
- **2.5× vs int8-wasm-simd** at 4M px/call (large-image, cache-cold CLUT)

**Why jsCE numbers here are lower than the standard bench's 174 MPx/s:**
The standard bench runs a full multi-direction suite before the RGB→RGB
measurement — WASM state, CPU branch predictors, and L2/L3 cache are all
maximally warm from prior measurements. Our isolated single-transform bench
starts cold. Pre-allocating the output buffer (`outArray` 7th arg to
`transformArray`) helped ~5% but the warmup context difference remains.

**V5's advantage grows with image size** — the gamma tables (9KB total) stay
L1-resident regardless of how many pixels flow through. The CLUT (214KB) is
evicted from L2 as large images exceed L3 capacity, dropping jsCE from
174 to ~99 MPx/s while V5 stays at 250+ MPx/s.

V8 TurboFan gives ~26% over Node on this loop shape (202 → 257 MPx/s), consistent
with the 20–40% prediction.

To reproduce: `node bench/matrix_shaper_poc/prebuild.js` then open
`bench/matrix_shaper_poc/bench_browser.html` via the dev server (`node samples/serve.js`).

---

## The output table has to be 16-bit, not 4096-entry

The V5 design above expects a 4096-entry output table to pull the error "from
±6.5 LSB to ±0.4 LSB". **Measured, it lands at up to 4 LSB** — outside what
this engine ships anywhere else.

The kernel's numerics were modelled in JS against the engine's own exact
pipeline (`buildLut: false`), using the engine's own TRC stages and fused
matrix, exhaustively over a 64³ grid of 262,144 colours per profile pair:

| output table | max LSB | mean LSB | samples > 1 LSB |
|---|---:|---:|---:|
| 12-bit nearest (V5 as designed) | **4** | 0.038 | 0.070% |
| 12-bit + linear interpolation | 2 | 0.001 | 0.016% |
| **16-bit nearest** | **1** | **0.001** | **0.000%** |

Worst pairs are sRGB→AdobeRGB and sRGB→AppleRGB. The cause is not table
resolution in general but the **slope of the encode curve near black**: a pure
gamma curve has unbounded derivative at zero, so no uniform table is exact
there, and 4096 entries leaves several LSB of headroom unresolved.

**16-bit nearest is both more accurate and cheaper than 12-bit interpolated** —
better than 2 LSB against 1, and a plain lookup instead of interpolation
arithmetic in the SIMD inner loop. It is the design to build.

### The memory objection does not survive measurement

64 KB per output curve, and up to 192 KB if a profile carries distinct R/G/B
TRCs — the same order as the 214 KB CLUT this kernel is meant to beat, which
undercuts the "9 KB stays L1-resident" argument made above for large images.

Measured anyway, by rebuilding the V5 kernel with a 65536-entry table:

```
V5 SIMD, 4096-entry  (4 KB)   239.4 MPx/s
V5 SIMD, 65536-entry (64 KB)  237.8 MPx/s      -0.7%, inside noise
```

No cost. A 1-D table indexed by a scalar has locality a 3-D CLUT does not:
neighbouring pixels land on neighbouring entries, so the working set stays
small however large the table is. The L1-residency argument was right about the
mechanism and wrong about the size that matters.

### What this does not change

The fused matrix, the 256-entry f32 input table (one entry per possible input
byte, therefore exact), the sentinel-patching scheme and the `wasmCache` keying
are all unaffected. Only the output table's size and the accuracy claim change.

Also worth recording: **the engine already computes the fused matrix.** For an
RGB→RGB matrix-shaper pair with `buildLut: false`, the optimiser emits exactly
this pipeline —

```
0. stage_Int_to_Device      (/255)
1. stage_Gamma_Inverse      input TRC
2. stage_matrix_rgb         <- the fused 3x3, already combined across both profiles
3. stage_Gamma              output TRC
4. stage_device_to_int      (*255)
```

— so the nine coefficients the kernel needs can be read straight off
`stage_matrix_rgb`'s `stageData`, and the gamma tables can be populated by
calling the engine's own stage functions. No matrix maths, chromatic adaptation
or curve-type handling needs reimplementing in the kernel path.

## Production path

### Integration with kernel3D (v1.7)

The matrix-shaper kernel is not a separate kernel module — it is a variant
inside `kernel3D.js`, selected when `_isMatrixShaperPair()` is true at
`create()` time:

```js
// kernel3D.create() — detect matrix-shaper pair
if (this.transform._isMatrixShaperPair()) {
    this._variant = 'matrix_shaper_js';   // sync fallback until WASM is ready
    this._buildMatrixShaperWasm(useSimd).then(k => {
        this._wasmMatrixShaper = k;
        this._variant = useSimd ? 'matrix_shaper_simd' : 'matrix_shaper_scalar';
    });
    return lutMode;  // return the demoted sync mode for now
}
```

`provideLut()` returns `false` for matrix-shaper pairs — no CLUT is built.
`array()` dispatches on `this._variant` and calls the WASM function directly.

```js
_isMatrixShaperPair() {
    const t = this.transform;
    return t.inputProfile  && t.inputProfile.type  === eProfileType.RGBMatrix &&
           t.outputProfile && t.outputProfile.type === eProfileType.RGBMatrix;
}
```

### Async `create()` and the JS fallback

`create()` is synchronous. `_buildMatrixShaperWasm` is async (`WebAssembly.compile`).
The first few `transformArray()` calls before the Promise resolves fall through
to `_variant = 'matrix_shaper_js'` — the existing JS matrix pipeline — then
WASM takes over transparently once the compiled module is ready.

No locking, no deferred queue. The JS fallback gives correct results; it's just
slower (approximately 15 MPx/s). For typical use patterns (create once, call many
times) the async compile cost is paid only once per profile pair.

### Production binary patching

The production build avoids shipping `wabt` at runtime. The WAT template is
compiled once at build time with sentinel `f32.const` values standing in for
each coefficient:

| Coefficient | Sentinel | IEEE 754 LE bytes |
|---|---|---|
| m00 | 1001.0f | `00 40 7A 44` |
| m01 | 1002.0f | `00 80 7A 44` |
| m02 | 1003.0f | `00 C0 7A 44` |
| m10 | 2001.0f | `00 08 FA 44` |
| m11 | 2002.0f | `00 10 FA 44` |
| m12 | 2003.0f | `00 18 FA 44` |
| m20 | 3001.0f | `00 08 BB 45` |
| m21 | 3002.0f | `00 10 BB 45` |
| m22 | 3003.0f | `00 18 BB 45` |

At `create()` time: copy the pre-compiled binary, scan for `0x43 <sentinel bytes>`
(WASM `f32.const` opcode + 4 LE bytes), verify all 9 are found (sanity check —
if any is missing the binary is stale), replace with the actual coefficient bytes,
then `WebAssembly.compile()`. No WAT compiler at runtime.

The sentinel values (1001–3003) are clearly outside the range of ICC matrix
coefficients (typically [-2, 2]), so false positives in the scan are impossible.

### `wasmCache` keying

Same profile pair across multiple `Transform` instances pays the compile cost
only once:

```js
const cacheKey = [m00,m01,m02,m10,m11,m12,m20,m21,m22]
    .map(v => v.toFixed(8)).join(',');
if (this.transform.wasmCache[cacheKey]) return this.transform.wasmCache[cacheKey];
```

### Gamma LUT population

After `WebAssembly.instantiate()`, write the gamma tables into WASM linear
memory before the first pixel run:

```js
const mem    = instance.exports.memory;
// gamma_inv: 256 entries × f32 at byte 0 — one per possible input u8 byte, exact
const invLut = new Float32Array(mem.buffer, 0,    256);
// gamma_fwd: 4096 entries × u8 at byte 1024 — 4× resolution, ≤ 0.4 LSB error at knee
const fwdLut = new Uint8Array(  mem.buffer, 1024, 4096);

for (let i = 0; i < 256; i++) {
    invLut[i] = srcProfile.applyInverseTRC(i / 255);             // linearise
}
for (let i = 0; i < 4096; i++) {
    fwdLut[i] = Math.round(dstProfile.applyTRC(i / 4095) * 255); // encode → u8
}
```

Any TRC curve type is handled here in JS — sRGB piecewise, simple gamma,
ICC parametric type 0/3/4. The WASM kernel sees only flat arrays of f32/u8
values and never needs to know the curve type.

---

## WAT reference (v4 canonical SIMD kernel)

The three-phase structure of the canonical v4 kernel. The scalar variant
(`run_scalar_v2`) follows the same three phases but processes 1 pixel per
iteration with plain f32 locals instead of f32x4.

```wat
;; === BEFORE THE LOOP — load matrix constants once into v128 locals ===
(local.set $cm00 (v128.const f32x4 M00 M00 M00 M00))
(local.set $cm01 (v128.const f32x4 M01 M01 M01 M01))
;; ... through cm22 (9 locals total) ...

;; === LOOP BODY ===

;; Phase 1 — Decode 4 pixels: byte → shl(2) → f32.load → f32x4 lane
;; No wide load, no shuffle, no extract. The decoded f32 IS the lane value.
(local.set $vR
  (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
    (f32x4.splat (f32.load (i32.shl (i32.load8_u           (local.get $inPos)) (i32.const 2))))
    (f32.load    (i32.shl (i32.load8_u offset=3  (local.get $inPos)) (i32.const 2))))
    (f32.load    (i32.shl (i32.load8_u offset=6  (local.get $inPos)) (i32.const 2))))
    (f32.load    (i32.shl (i32.load8_u offset=9  (local.get $inPos)) (i32.const 2)))))
;; vG: offsets 1/4/7/10   vB: offsets 2/5/8/11

;; Phase 2 — Fused 3×3 matrix across all 4 pixels simultaneously
;; local.get reads from pre-loaded XMM registers — no constant pool re-materialisation
(local.set $vRo (f32x4.add (f32x4.add
  (f32x4.mul (local.get $vR) (local.get $cm00))
  (f32x4.mul (local.get $vG) (local.get $cm01)))
  (f32x4.mul (local.get $vB) (local.get $cm02))))
;; vGo: cm10/cm11/cm12   vBo: cm20/cm21/cm22

;; Phase 3 — Per-lane output encode: clamp → scale → round → 256-byte gamma LUT
;; Repeated for all 12 channel/pixel combinations (R0,G0,B0 ... R3,G3,B3)
(local.set $ti
  (i32.trunc_f32_u (f32.add
    (f32.mul (f32.min (f32.max (f32x4.extract_lane 0 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0))
             (f32.const 255.0))
    (f32.const 0.5))))
(local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
(i32.store8 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
;; ... repeated for G0/B0, then lane 1 (R1/G1/B1) ... lane 3 (R3/G3/B3) ...
```

---

## What does NOT need changing

| Area | Reason |
|---|---|
| `Profile.js` / `decodeFile` | Matrix profiles already decoded; `RGBMatrix.XYZMatrix` and `XYZMatrixInv` are populated |
| `createPipeline_Device_to_PCS_via_RGBMatrix` | Retained for the single-pixel accuracy path (`transform(color)`) |
| Existing WASM kernels (`tetra3d_*`) | Untouched — different profile type, different dispatch |
| `transformArray` | Calls `this.kernel.array(...)` — kernel handles the variant internally |
| LUT bake path | `provideLut()` returns `false` — no CLUT built for matrix-shaper pairs |
| Smoke test / validate | Runs on the JS fallback pipeline before WASM is ready; still correct |

---

## Open questions and next steps

**Vectorised output encoding.** `i32x4.trunc_sat_f32x4_u` (f32x4 → i32x4 with
saturation) would handle all 4 lanes' clamp + scale in one SIMD op, reducing
the output section from 12 sequential extractions to 3 vector ops + 12 u8
lookups. Expected to close the 8% gap between v2 scalar and v2 SIMD.

**Browser numbers.** The 164/177 MPx/s figures are Node. Browser V8 WASM
numbers are typically 20–40% higher on tight arithmetic loops. Measure with the
bench page before publishing a headline number.

**Accuracy vs. the 3D CLUT path.** The matrix kernel is exact (f32
arithmetic, no interpolation error). Against the current CLUT path (≤ 1 LSB
u8), the matrix kernel should be strictly more accurate. Verify against the
`lcms_compat` harness.

**`applyInverseTRC` / `applyTRC` exposure.** The gamma LUT population in
`_buildMatrixShaperWasm` calls these per-sample. Confirm they are accessible
from the kernel file (they live on `Transform.prototype` currently) or move
them to a shared utility.
