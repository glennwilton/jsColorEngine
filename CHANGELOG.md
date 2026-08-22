# Changelog

All notable changes to jsColorEngine are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.6.0] — 2026-08-23

### UMD size

`browser/jsColorEngineWeb.js` is **~115 KB gzip** (~435 KB
minified) with the 5/6 kernels and single-entry cached WASM
twins inlined. The optional worker is **~100 KB gzip**. The
README no longer quotes the old ~68 KB / vs-lcms-wasm size
line — the engine is small on its own.

### In-kernel WASM pixel cache

Shipped tetra modules carry a paired `interp_*_cached` export
(single-entry, last pixel). `create()` binds it when `pixelCache`
is `'auto'` or any number > 0; `0` keeps the verbatim kernel.
Hash tables stay in the POC builder. Chrome 151, this machine:
a clean photograph is a ~10 % boost; a photograph with 5 % noise
added is the worst case (~4 % tax); solids **up to 3.94×**
(CMYK→RGB 104→407). 5D photo is 0.84× — use `0` there if that
cell matters. `kernelInfo().cache` is `1` when the cached export
ran. Native C IT8 matrix testing is next, not a 1.6 gate.

### pixelCache `'auto'` — kernels decide

`pixelCache` defaults to `'auto'`. Transform ignores that string;
`init()` may change it to `1`. Kernel4D / 5D / 6D do; Kernel3D and
everyone else leave it, so nothing is injected. After init,
`_applyPixelCache()` injects the accuracy-path stages if the value
is then a number > 0. `pixelCacheUsed` is what ran. `array()` still
uses the kernel when one is bound — auto must not steal the WASM
image path.

### 5D / 6D int8 WASM scalar (n-channel proofing)

`Kernel5D` and `Kernel6D` own slots 5 and 6. `buildLut` now bakes a
device LUT at the profile's A2B density (typically 9^5 / 7^6); int8
WASM scalar (`tetra5d_nch` / `tetra6d_nch`) is bit-exact with the new
JS int8 peel+tetra loops. KernelND stays on 7–15 and still declines a
CLUT. Throughput probe (`bench/nch_56/run.js`, photo with 5 % noise
added, this machine): 5CLR **16.4 / 9.71 MPx/s** (WASM / JS, 1.69×), 6CLR
**7.66 / 4.84** (1.58×). No int16 / SIMD 5/6 — package size vs a
rare HiFi-16-bit input. Coverage matrix:
[KernelContract.md § Coverage](docs/deepdive/KernelContract.md#coverage--what-exists-per-kernel).
Real-world A2B grid sizes (vs our fixture budget) are in
[SyntheticProfiles.md § real grids](docs/deepdive/SyntheticProfiles.md#what-real-profiles-actually-use).

### Browser bench — photo with 5 % noise added is the headline

`samples/bench/` and `bench/mpx_summary.js` no longer feed the old
256-colour LCG. Default content is the strawberries frame plus 5 %
grain — on the locality plateau, shy of walking into noise. The
chooser also has solid, photo, photo with 15 % noise added, noise, and **legacy**
(do not quote). CMYK workflows use a GRACoL separation of the same
frame.

New **Speed vs Noise** tab graphs how *this* computer's caches treat
0–100 % grain (jsCE vs lcms vs lcms `NOCACHE`). Optional identity
rows (sRGB→sRGB / GRACoL→GRACoL) are the memcpy ceiling and stay out
of the summary cards. `await browserFocus()` pauses if the tab blurs
and discards a hot batch that lost focus.

Headline (Chrome 151, DevTools closed, photo with 5 % noise added)
— SIMD **94 / 97 / 69 / 67 MPx/s** (RGB→RGB / RGB→CMYK / CMYK→RGB /
CMYK→CMYK). Same-machine photo with 15 % noise added is the same
plateau; legacy is ~1.8× faster because that LCG is L1-resident.
The **Speed vs Noise** tab on `samples/bench/` is the demo.

The Good / Bad / Ugly call-shape page moved to
[`docs/deepdive/good-bad-ugly/`](docs/deepdive/good-bad-ugly/) and
is off the samples index. Its pixels are that old LCG.

### WASM modules compile on demand

`src/wasm/instantiate.js` is the only compile / instantiate path and
does not `require` any kernel `.wasm.js`. The winning kernel loads
its own binary after `create()`; a matrix-shaper pair never compiles
the tetrahedral modules. SIMD scalar fallthrough loads only when
output is not 3 or 4 channels.

### Web Worker pool in the browser

`transformImages()` now starts a real `Worker` pool when the app passes
`workerUrl` (or `JSCE_WORKER_URL`) to `enablePool()`. `npm run browser`
emits `browser/jsColorEngineWorker.js`. Without the URL the batch still
runs sequentially — same bytes, same callbacks. The bench **Pool demo**
tab loads three photographs at different sizes and reports wall time,
per-image compute, fragment counts and finish order.

### Documented — the pixel cache is a different proposition above 4 channels

`pixelCache` was measured on RGB and CMYK, because those were the only
profiles that existed. With the synthetic set it can be measured on wide
input, and the recommendation does not scale across — it inverts.

Above 4 input channels `KernelND` declines the CLUT, so every pixel walks
the pipeline and a miss costs roughly fifty times what it costs in RGB.
Both halves of the trade move together: the lookup added to a miss is a
6 % tax at 8 channels against 31 % at 4, while a hit skips 29× the work
instead of 5×. **Break-even hit rate falls from ~29 % at 4 channels to
~6 % at 8.**

`docs/Transform.md` said break-even was around 40 %, "which flat graphic
content clears easily and photographs generally do not" — photographs
measured 3–41 %. Against a 6 % bar most of that range clears, so the
option row now states the bar per width. Pure noise still never pays at
any width; this cache rewards reuse and cannot manufacture it.

New harness `bench/pixel_cache/nchannel_bench.js`, which prints the
break-even per width rather than only the headline speed-up. It also
carries the three ways this measurement goes wrong, one of which produced
a published number that had to be withdrawn: timing N passes over one
buffer through one `Transform` lets pass 2 find pass 1's entries
resident, so unique content arrives with a full table's head start. It
read as 17 % reuse on data that has none. Fresh `Transform` per timed
pass, JIT warmed on a throwaway one.

Also `__tests__/pixelcache.tests.js` now covers 35 input×output width
combinations from 1 to 15 channels in both depths — cached output
byte-identical to uncached, the cache verified to actually engage at
those widths, and the declining case verified still correct.

### Changed — every kernel now chooses its own interpolator

Phase 3 of [the kernel contract](docs/deepdive/KernelContract.md).
`addStageLUT` was a 133-line switch that picked the single-colour
interpolator itself; it is now 34 lines, one registry lookup and a hints
object. `Kernel3D`, `Kernel4D` and `KernelND` gained `floatFor(lut, hints)`
and own the decisions that used to be made for them.

The clearest sign the boundary was in the wrong place: the PCS-input
trilinear rule existed only in the 3-channel branch — lcms 2.0 found
tetrahedral disagreed with 1.19, SampleICC and Photoshop on Lab-indexed
LUTs — while the 4-D branch had no equivalent. One function was carrying
one dimension's rule on behalf of all of them.

`src/interp.js` is now the built-in float implementations rather than the
policy; a third-party kernel can ignore it.

No behaviour change, and that was checked rather than assumed: the previous
commit was extracted to a scratch tree and the same 15-case probe run
against both copies, comparing stage names **and** accuracy-path colour
output across every interpolation option. Byte-identical throughout.
Throughput median +0.21% across 132 cells; accuracy identical.

### Changed — gray and duotone kernels own their maths, and got faster

Phase 2 of [the kernel contract](docs/deepdive/KernelContract.md).
`addStageLUT` no longer picks the single-colour interpolator itself for 1-
and 2-channel LUTs; it asks the kernel registered for that dimension via
`floatFor(lut, hints)`, which returns both the function and the stage name.
`linearInterp1D_NCh` and `bilinearInterp2D_NCh` moved from `src/interp.js`
into `Kernel1D` and `Kernel2D`.

This closes a real hole: `registerKernel()` replaced the batch path only, so
a third-party Kernel1D changed `transformArray()` while `transform(colour)`
kept running Transform's own code. One object now owns both surfaces.

Both array loops are also inlined now, which was `TODO (B3)`, open since the
v1.5 kernel migration. They had been calling their single-colour
interpolator once per pixel — roughly 2M allocations per megapixel, and one
function serving two very different call patterns.

| workflow | before | after |
|---|---:|---:|
| gray → RGB | 72.6 | **93.8 MPx/s** |
| gray → CMYK | 63.6 | **81.4** |
| gray → 6CLR | 49.7 | **64.9** |
| duotone → RGB | 50.7 | **61.5** |
| duotone → CMYK | 44.7 | **51.3** |
| duotone → 6CLR | 35.7 | **41.0** |

Verified bit-identical to the single-colour reference across 159,744 values
and 9 LUT shapes per dimension. 3D and 4D were untouched and the isolated
bench confirms it: at most +0.30% across six cells.

### Added — throughput coverage for 1- and 2-channel kernels

`bench/small_dim/` and the `smalldim` phase of `bench/reproduce.js`. Every
other bench measured 3- and 4-channel input, so these two kernels had no
coverage at all. Synthetic LUTs, so no gray or duotone profile is needed —
those are vendor artefacts that cannot be committed.

### Changed — the kernel registry is a dense 1..15 array

Phase 1 of [the kernel contract](docs/deepdive/KernelContract.md).
`Transform.kernels` was an object keyed `'1d'..'4d','nd'`; it is now an
array indexed by input channel count across the full ICC range, 1 to 15
(`FCLR` is 15 channels). `setKernel()` is one array index — no key string
built per `create()`, and no `inputChannels > 4` special case.

`KernelND` registers `[5, 15]`: one descriptor object in eleven
independently replaceable slots. Sharing the object keeps it free — a
single hidden class across the span — while making it possible to drop a
tuned `Kernel7D` into slot 7, or a probe into slot 9, without forking the
other ten. That is what makes the rest of the contract testable.

- `descriptor.dimensions` accepts a channel count or an inclusive
  `[from, to]` range. Legacy `'ND'` still works and means `[5, 15]`.
- `Transform.MAX_KERNEL_DIMENSIONS` (15) is the registration ceiling.
- Built-in descriptors gained a `name` (`kernel1D`..`kernel4D`,
  `kernelND`), so `kernelInfo().name` no longer depends on a fallback.
- New suite `__tests__/kernel_registry.tests.js` — 17 tests covering
  shape, the `dimensions` forms, slot isolation, and `setKernel` routing.

Create-time and load-time only; no pixel path was touched. Full suite
green (811 passing) and throughput unchanged.

**Migration.** `Transform.kernels['3d']` becomes `Transform.kernels[3]`.
Kernels registered with `dimensions: 'ND'` keep working unchanged.

### Added — pinned baselines and per-release measurement history

Benchmark JSON lived only in gitignored `bench/results/<timestamp>/`, so
the numbers behind a published figure could not be re-derived once the
folder was gone, and each change was implicitly gated against whatever ran
last — a ratchet that turns one way, where seven refactor phases at 1.5%
each is 11% slower with every step passing its gate.

Two tracked trees now, both per machine, because throughput is a property
of the box as much as of the code:

- **`bench/baseline/<machine>/`** — the pinned reference refactors are
  gated against. `node scripts/bench_compare.js` compares the newest run
  to it, picking the pin that matches the current machine and refusing
  rather than reporting a different CPU as a regression. Moving a pin
  needs `node scripts/pin_baseline.js <run> --why "..."`, and `--why` is
  mandatory.
- **`bench/history/<version>/<machine>/`** — frozen at release by
  `npm run release-snapshot`: the generated page, the conditions, the raw
  rows, and whether the suite passed. ~120 KB each.

`npm run publish` now *checks* a snapshot exists for the version rather
than running a 30-minute bench itself — a slow publish is a publish people
bypass. `--allow-missing` overrides, visibly.

`bench_compare` reads three kinds of column: jsCE throughput **gates**,
third-party `lcmsWasm`/`native` are the **control** that sets the noise
floor from the same run, and accuracy (`*MaxLsb`, `*MeanLsb`) is gated at
**zero** — a refactor that quietly changes rounding never shows up as a
throughput number.

### Fixed

- Matrix-shaper figures in the 1.5.5 entry below were carried from an
  earlier run than the pool figures beside them; both now come from
  `bench/results/2026-08-20T10-37-19` (see
  [BenchResults](docs/BenchResults.md)).

---

## [1.5.5] — 2026-08-20

The two gaps the v1.5 LittleCMS comparison identified, both closed:
a fused matrix-shaper WASM kernel, and a multicore image path.

### Added — matrix-shaper WASM kernel (`wasmMatrixShaper`)

An RGB→RGB matrix-shaper conversion is a curve, a 3×3 and another curve.
The optimiser has always folded it into exactly that shape; this release
adds a WASM implementation of it, so the same arithmetic runs at **328
MPx/s at int8 and 212 at int16** on photographic content against ~119
for the 33³ CLUT — and, more importantly, **within 1 LSB of the exact
pipeline where that CLUT reaches 25 LSB at int8 and thousands of codes
at int16**. It is not a speed-for-accuracy trade; it is better at both.

Named for the WASM part because the *fold* is the optimiser's and was
already there. `matrixShaper` and `preferMatrixShaperOverLUT: true` are
accepted spellings.

| mode | `buildLut: false` | `buildLut: true` |
|---|---|---|
| `'auto'` *(default)* | kernel | CLUT — nothing the caller asked for changes |
| `'prefer'` | kernel | kernel, and no CLUT is built |
| `false` / `'off'` | JS stage pipeline | CLUT |

Four prebuilt binaries — `{int8, int16} × {SIMD, scalar}` — each with
**five entry points, one per alpha shape**. The scalar build performs
the same f32 operations in the same order as one SIMD lane, so it is
**bit-identical**, not merely close: a host without WASM SIMD gets the
same pixels, slower. Tests assert exact equality rather than a
tolerance.

`'prefer'` refuses whenever something depends on the LUT existing —
`lutInputHook`, `lutOutputHook` and gamut mapping all run *inside* the
grid walk, so skipping it would silently stop them firing.

Docs: [deepdive/MatrixShaperKernel.md](./docs/deepdive/MatrixShaperKernel.md)

### Added — alpha in the matrix-shaper kernel (RGBA was a 40× cliff)

`buildLut` defaults to `false` and canvas `ImageData` is RGBA, so the
commonest input in a browser was falling all the way to the generic
loops: **8.0 MPx/s against 331** for the identical conversion without
alpha. Not a slope — a cliff.

The module now exports one entry point per shape (3→3, 4→3, 3→4, and
4→4 copying or filling) with the strides baked in, so **alpha costs 3%**
and the RGB path pays nothing for the others existing. Alpha is never
colour-managed — it is opacity, not a colorant — and the tests assert it
comes through **exactly**, not within 1 LSB.

### Changed — `pixelCount` is now optional in `transformImages()`

Once the alpha flags are resolved the stride is known, so the count follows
from `data.length` — `{data}` alone is a valid image. Pass it explicitly when
the buffer is bigger than the image (a pooled array, or a slab of frames),
because inference would convert the padding.

Both are now **validated**: an array length that is not a whole number of
pixels, and a `pixelCount` that would overrun the buffer, are refused with the
image's id in the message rather than converting something plausible-looking.
Validation **rejects** rather than throwing synchronously, so `.catch()` sees
it as well as `try/await`.

### Added — per-image alpha in `transformImages()`

Any image may override `inputHasAlpha` / `outputHasAlpha` / `preserveAlpha`,
with the batch options as the default — so a folder of mixed PNG and JPEG is
one call instead of two, or padding every JPEG with an alpha channel nobody
wanted. Unstated `preserveAlpha` means "preserve if both sides have one", the
same rule `transformArray()` uses.

Alpha is the only per-image variable, deliberately: it is a stride and a copy,
never colour, so this cannot become "different conversions in one batch". The
sequential path resolves the overrides identically, so a mixed batch converts
the same whether or not workers were available.

### Added — `Transform.enablePool()`, and multicore you can confirm

```js
await Transform.enablePool({ workers: 4 });   // then every batch is parallel
```

Starts the workers, **rejects with the reason if it cannot**, and makes the
pool the default for later batches so no call site repeats itself.
`Transform.disablePool()` tears it down. Accepts either vocabulary —
`workers` / `maxWorkers` or `cores` / `maxThreads` — and a `url` for the Web
Worker backend, which is carried but not yet used (browser pool is 1.6).

Precedence is explicit-beats-ambient: the call, then the Transform, then the
enabled pool. `{multicore: false}` still opts one batch out.

**Fixed along the way:** `new Transform({multicore: true})` silently did
nothing. `_multicoreHandoff()` had always read `this.multicore` as the
per-call fallback, but nothing ever assigned it, so the constructor option was
dead.

**And multicore no longer fails silently.** When workers are asked for and
unavailable, jsCE warns **once** with the reason and the fix, then runs
sequentially — identical bytes, callbacks still firing, because multicore
remains an optimisation and never a capability. `requireWorkers: true` turns
that into a rejection for callers who would rather fail than quietly run on one
thread.

### Added — `Transform.compatibility()` and pool environment overrides

`Transform.compatibility('1.5')` pins construction defaults to an earlier
release, for callers who need byte-for-byte reproducibility across an upgrade.
A named snapshot rather than a settings bag: one call, self-documenting, and
the version table *is* the changelog of defaults that move output. An explicit
option always beats the pin. Deliberately **not** an environment variable —
this changes pixels, and `process.env` does not exist in a browser.

Pool sizing, by contrast, **is** environment-configurable — `JSCE_POOL_CORES`,
`JSCE_POOL_MAX_THREADS`, `JSCE_POOL_MIN_THREADS`, `JSCE_POOL_IDLE_MS`,
`JSCE_POOL_TRANSFORMS_PER_WORKER`, `JSCE_POOL_DISABLE` — because the pool is a
Node-only subsystem, worker counts are a property of the machine rather than
the conversion, and nothing there can change a pixel. Explicit options win over
the environment. The motivating case: `cores: 'auto'` asks
`os.availableParallelism()`, which in a cgroup-limited container reports the
host's cores rather than the quota.

### Added — matrix shaper in plain JS, for what WASM cannot do

`matrixShaperJS.js` runs the same fused 3×3 and the same curves with no LUT and
no WebAssembly: **62 MPx/s at int8, 57 at int16, ≤ 1 LSB**, against 8 for the
stage pipeline it replaces.

Not a speed feature — WASM is 5× faster. It covers two cases WASM cannot:
a profile whose `rTRC`/`gTRC`/`bTRC` genuinely differ (one table per direction
cannot serve three curves, so those transforms previously dropped to ~8 MPx/s),
and hosts with no WebAssembly at all. Where the curves agree, all three table
references point at one table, so the common case allocates once.

Three V8 lessons that hold for the tetrahedral kernels did **not** transfer,
and the measurements are in `bench/js_matrix_shaper/`: naming intermediates is
free here (doubles live in the XMM file, not the GPRs that spill); avoiding
them literally costs 7%; unrolling is worth 3% rather than being load-bearing;
and address arithmetic does not register. The loop is bound on a dependent load
chain, so the arithmetic around it hides underneath.

### Added — claiming kernels (`Transform.claimKernels`, `kernelInfo()`)

Kernel modules were selected by input channel count, before the pipeline
existed. That cannot express "is this pair a matrix shaper" —
`*sRGB → *AdobeRGB`, `*sRGB → GRACoL` and `*sRGB → *sRGB` are all
3-channel input, and only the built pipeline separates them.

A descriptor may now declare `claims(transform)` and is offered the
transform **after** `pipelineCreated`. `registerKernel()` routes on the
presence of `claims`; a claiming kernel never occupies a dimensional
slot, so anything it declines still gets Kernel3D. `displacesLut()` is
the earlier, separate hook that can skip the CLUT grid walk entirely.

`transform.kernelInfo()` reports which kernel holds the batch path,
whether it claimed or was selected dimensionally, and once built, the
variant.

This revises a stated invariant: kernels were "LUT-only batch
processors". That held while every kernel was a table walker. Docs:
[deepdive/KernelModules.md](./docs/deepdive/KernelModules.md)

### Added — `alpha` helpers (`unpremultiply` / `premultiply` / `flatten`)

Nothing in a buffer says whether it is premultiplied — straight and
associated RGBA are the same bytes — so this is deliberately **not** a
Transform option. Converting premultiplied data directly is wrong by up
to **69 LSB at a = 0.5**, because the transform is not linear:
`T(a·C) ≠ a·T(C)`. Going through `unpremultiply → convert → premultiply`
is 42× closer on the mean.

`flatten()` is a different job and the two get confused: unpremultiply
keeps the alpha channel, flatten composites against a background and
discards it. The background is required rather than defaulted — white
and black differ everywhere the image is not opaque.

### Added — multicore image path (`transformImages`)

A worker pool with priority, out-of-order completion and per-image
callbacks: **6.2× peak and 787 MPx/s** on the SIMD kernel, output
byte-identical to single-threaded in all 72 measured cells. Images are
fragmented, pulled from a queue and reassembled, rather than one image
split evenly across N threads.

Also: `cancel(id)` / `cancelAll()` (cancelled images fire their
callbacks rather than leaving handlers waiting), `onQueueFree()` /
`onQueueBelow()` backpressure, `interrupt(fn)` to borrow the cores,
`memoryReport()`, `workerStats()` and `forgetWorkers()`.

Docs: [deepdive/multicore.md](./docs/deepdive/multicore.md)

### Added — `stage_Int_to_cmsLab`

Lab sources reached the array path with no int→Lab decode, so a flat
array in was NaN out. Arrays are PCS-encoded by convention; this is the
stage that says so.

### Fixed — `clear()` did not release the kernel

A Transform kept its kernel instance across `clear()`, holding its WASM
memory — up to 512 KB of tables at int16 plus pixel buffers — and
offering the next `create()` a kernel chosen for a conversion it no
longer performed. Found by the claiming-kernel refactor.

### Fixed — `toJSON()` error message sent callers in a circle

On a `wasmMatrixShaper: 'prefer'` transform it said "construct with
`buildLut: true`" — advice the caller had already followed. It now names
the actual cause.

### Docs — three measurements restated

Kept as a trail rather than overwritten, because how each number moved is
more instructive than the number:

- **The CLUT comparator.** "2.2× the CLUT" compared the SIMD kernel
  against `int-wasm-scalar`, which is not the default.
- **The noise generator.** The next pass used `s % 256` from an LCG,
  whose low bits have a period of 256 — a solid-colour test wearing a
  noise costume, and the CLUT's best case. It understated the kernel by
  ~2×, and the multicore bench disagreeing is what surfaced it.
- **The serial-fraction fit.** A two-point fit for Amdahl's `S` handed
  nearly all run-to-run noise to the result; replaced with least squares
  over w = 2…7, reporting R².

### Measured and NOT built — `SharedArrayBuffer` delivery

Projected at +30%; spiked at **+5–13% at int8 and nil at int16**, with
the naive design (bulk copy-in for a plain-array caller) measuring
**0.83–0.91×**, i.e. slower than today. The pool's main-thread copies
are largely *interleaved* with worker execution, so removing them frees
time that was already hidden. Not worth two delivery paths and a
COOP/COEP deployment blocker. Spike kept at `bench/sab_spike/` so the
question can be re-asked on higher core counts.

---

## [1.5.0] — 2026-08-19

Everything since 1.4.4 in one release: the v1.5 polish arc, the
kernel-module architecture, DeviceLink + N-channel support, the
`Transform.js` source split, and an opt-in pixel cache (beta).

### Added — DeviceLink profile support (`pClass: 'link'`)

`t.create(deviceLink)` runs the single `A2B` tag device→device with no
PCS: full element structure (v2 `inputCurve→CLUT→outputCurve`; v4
`aCurves→CLUT→mCurves→matrix→bCurves`, including curves-only
linearization links), asymmetric channel counts (CMYK→RGB, RGB→CMYK),
header-declared intent, `buildLut: true`. Fixes exposed along the way:
curves-only `mAB` tags no longer crash the LUT decoder; pure-gamma
parametric curves (`para` type 0) now evaluate; the mft matrix is
correctly skipped for non-PCSXYZ input. Docs:
[docs/DeviceLink.md](./docs/DeviceLink.md) · Tests:
`__tests__/transform_devicelink.tests.js` (self-validating fixtures —
gamma-3 link = in³ exact, lcms 150 % ink-limit algorithm reproduced).

### Added — N-channel profiles (5CLR–15CLR, `eProfileType.NChannel`)

Hexachrome / 7-ink / spot press profiles load and transform in both
directions: n-ink → PCS via a generic N-D simplex interpolator on the
accuracy pipeline (input accepted as array or `{c0…cN}` object), and
PCS/RGB → n-ink including the baked-LUT image path. `buildLut` with
n-ink *input* is declined with a warning (a `grid^N` bake is
impractical) and falls back to the per-pixel pipeline. A latent
clamp-before-scale bug in the four `*_NCh` interpolators (unreachable
before N-channel) was found and fixed. Docs:
[docs/NChannel.md](./docs/NChannel.md).

### Added — pixel cache (`pixelCache`) — **BETA**

Opt-in memoisation of the accuracy path: `pixelCache: 0 | 1 | 16 | 32 | …`
(off by default; `1` is a single entry, anything else a direct-mapped
table rounded down to a power of two). `getPixelCacheStats()` reports
`{hits, misses, lookups, hitRate}`, and `setPixelCacheProfiling(true)`
measures hit rate on real content without doing the colour maths, so you
can decide whether it pays for *your* images before enabling it.

**Whether it pays depends entirely on content**, which is why it is off
by default: break-even is around a 40 % hit rate on this path. Flat and
graphic content clears that comfortably; photographs generally do not.
Pipeline weight matters too — the same content gives +269 % on
sRGB→GRACoL against +191 % on RGB→RGB, so CMYK destinations are the
better case. Measured numbers, method and the assumptions they overturned
are in [deepdive/PixelCache.md](./docs/deepdive/PixelCache.md);
`bench/pixel_cache/` reproduces them.

Marked **beta**: the accuracy-path implementation is complete, verified
byte-identical to uncached output over whole images
(`bench/pixel_cache/verify_cache.js`, 108 full-image comparisons) and
covered by tests. What is *not* done is the port into the image kernels —
a POC on the 4D CMYK kernel measured break-even at ~10 % and up to +169 %
on real content, but it is not wired to the dispatcher and not shipped.
The option name and semantics may change as that work lands.

Declines rather than misbehaves when it cannot guarantee correctness:
`pipelineDebug` on, or custom stages present. No effect on the LUT image
path.

### Changed — `Transform.js` split into `stages.js` + `interp.js`

`Transform.js` was 12,690 lines; it is now ~8,000 and is the pipeline
builder plus the public API. Moved verbatim, no behaviour change:

- `src/stages.js` — the ~100 `stage_*` pipeline functions, their
  `compile()` emitters, and the colour/matrix helpers they call.
- `src/interp.js` — the single-colour ACCURACY PATH interpolators
  (trilinear/tetrahedral 1D–ND).

Both are re-attached as non-enumerable `Transform.prototype` methods by
the same mechanism as the kernel loops, so `this`, every call site, and
function-identity checks are unchanged. Verified with the full suite plus
`bench/mpx_summary.js` throughput parity and LUT bake timings.

### Fixed — `pipelineDebug` (regression, same release)

`pipelineDebug: true` threw `ReferenceError: data2String is not defined`.
The stages split moved `addDebugHistory` into `stages.js` while the
module-scope `data2String` helper it calls stayed behind in
`Transform.js`. Every one of the 488 tests still passed, because none of
them switched debug on. Helper moved; `__tests__/pipeline_debug.tests.js`
now covers that path so it cannot go unnoticed again.

### Changed — kernel-module architecture

The per-dimension hot-path kernels moved out of Transform.js into
`src/kernels/{1d,2d,3d,4d,nd}/` as registered descriptors with
per-Transform instances; WASM assets moved beside their kernels; the
tuned loops moved verbatim (bench parity held, ~212 MPx/s Node
wasm-simd). Dispatch resolves once at `create()` onto the kernel
instance (`_runBig`/`_runSmall`/`_threshold`) — per call: one
threshold compare + one indirect call. Transform.js: 15,878 → ~11,000
lines. As-built doc:
[docs/deepdive/KernelModules.md](./docs/deepdive/KernelModules.md).

### Added — v1.5 polish arc

- **Identity / NOP detection** (`detectIdentity`, default `true`) —
  same-profile pairs collapse to a stride copy; multi-stage chains
  collapse pairwise. **Semantic change:** same-profile transforms are
  now exact pass-throughs; code relying on round-trip rounding must
  pass `detectIdentity: false`. See
  [docs/deepdive/Identity.md](./docs/deepdive/Identity.md).
- **Pipeline validation** — `validateOnCreate` /
  `transform.validatePipeline()`.
- **Fully-bound `transformArrayFn`** dispatch (identity always;
  LUT-path closures opt-in via `bindTransformArrayFn`).
- **LUT kernel plugins** — register custom kernels under a custom
  `lutMode`. See [docs/Plugin.md](./docs/Plugin.md).

### Changed — LittleCMS comparison framing + corrected accuracy oracle

After generous upstream review by Marti Maria
([#6](https://github.com/glennwilton/jsColorEngine/issues/6)):

- `cmsFLAGS_HIGHRESPRECALC` retired as an oracle/steelman
  configuration (it's a legacy lcms 1.x emulation flag).
  `bench/lcms-comparison/accuracy.js` now defaults to lcms's default
  optimisation (`flags = 0`; `--highres` reproduces the old oracle) —
  and against the modern path the image-LUT agreement **improved to
  100 % within 1 LSB on all four workflows** (the old 14-LSB
  out-of-gamut tail was a legacy-oracle artifact).
- Native-C throughput claims marked historical pending re-measurement
  with corrected lcms API calls; comparisons re-scoped as explicitly
  single-threaded. The detail moved to a dedicated page:
  [docs/LcmsComparison.md](./docs/LcmsComparison.md).

### Fixed — benchmark methodology (two defects that inflated our own numbers)

Found while producing the v1.5 release comparison. Both affected
**benchmarks only** — no engine code, no output, no accuracy — but both
had been quietly deciding published figures.

- **The "random noise" generator was not random.** Taking the low 8 bits
  of a linear congruential generator yields a buffer of only **256
  distinct colours** (those bits have period 256), while still reporting
  0.0 % adjacency — so the defect was invisible in the metric the
  harnesses printed. Against a 33³ CLUT (35,937 cells) that leaves the
  interpolation table L1-resident: the row advertised as the hardest
  case was the easiest. Separately, transcribing the C generator's
  `seed * 1103515245` into JavaScript overflowed f64 and collapsed the
  sequence to **21.6 % adjacency**, handing lcms's memo cache a fifth of
  the pixels in the row meant to give it none. Fixed with `Math.imul`
  and bits 23–30 (~1,016,892 distinct colours/Mpx at 0.0 % adjacency)
  across `bench/mpx_summary.js`, `bench/lcms-comparison/bench.js`,
  `bench/lcms_c/bench_content_matrix.c` and the new release harness.
  **Corrected throughput is roughly half the previously published
  figures for both engines**; README and Performance.md numbers are
  flagged provisional pending a browser-bench rebuild.
- **A shared benchmark process measured the wrong thing.** Running
  several content rows through one long-lived Node process gave 59.5
  MPx/s where an isolated run of the identical workflow, content and
  buffer size gave 75.4 — a 27 % swing from call-site specialisation
  alone. Every cell is now measured in its own process (`--isolate`).

### Added — `bench/release_matrix/` release comparison harness

Drives both halves of [docs/LcmsComparison.md](./docs/LcmsComparison.md)
from one photo corpus so jsCE, `lcms-wasm` and native lcms are measured
on identical bytes. Six workflows × five content classes × cache on/off
× buffer size, one process per cell, with **CLUT coverage** (distinct
input colours ÷ grid cells) reported next to adjacency on every row —
the metric that would have caught the generator defect above. Documents
the six methodology rules it enforces, including giving lcms its best
compiler flags per workflow.

### Fixed — npm tarball was shipping 37 MB of benchmark data

`.npmignore` takes precedence over `.gitignore` when it exists, so
directories excluded only from git were still being published. The
tarball carried `_wip/` (13 MB of full-size benchmark photographs) and
`testbed/` (188 files of ICC profiles and IT8 reference data): **37.1 MB
packed / 80.8 MB unpacked / 252 files**, for a library whose runtime is
~40 source files. Both are now listed explicitly, along with `scripts/`
and editor directories.

**Now 2.3 MB packed and unpacked, 48 files** — `src/`, `build/`,
`browser/`, README, LICENSE, CHANGELOG. Verified by extracting the
tarball and running a transform from it. No consumer-visible change
beyond a dramatically smaller install.

### Added — committed photo corpus for the release comparison

The five photographs behind the LcmsComparison figures now live in
`bench/release_matrix/images/` (~1.1 MB, Unsplash licence, attributed in
`images/CREDITS.md`) instead of a gitignored scratch directory. A
benchmark whose input cannot be obtained is not reproducible, and
`bench/` is excluded from the npm tarball, so this costs consumers
nothing. The decoded `corpus/` planes stay gitignored as derived data.

### Docs — what the measurement work established (no code change)

Chasing the generator defect turned into a study of what a colour
benchmark is actually measuring. None of it changed the engine; all of
it changes how the engine should be measured, so it is recorded in
[deepdive/benchmark.md](./docs/deepdive/benchmark.md) §§20–21 as the
brief for the browser-bench rebuild.

- **CLUT coverage is necessary but not sufficient — ordering costs
  more.** The `sweep` generator produces the same ~1 M distinct colours
  and the same 0.0 % adjacency as `noise`, and runs **2.1× faster**
  (190.3 vs 89.0 MPx/s) purely because the accesses are predictable.
  A rainbow ramp is a weaker test than the bug that was just removed,
  while looking more rigorous.
- **Noise is the great equaliser.** Blending any content 2–5 % toward
  noise collapses every content class onto the same figure: solid,
  gradient and photo start at 182 / 183 / 119 MPx/s and all land at
  ~98. The clean synthetic rows were the outliers, not the photo row.
- **Where the old 210 MPx/s came from.** It was never fake — it is a
  real figure for flat graphic content with a small palette (UI, vector
  art, logos), not for photographs (109–121) and not even for a scanned
  illustration (132).
- **lcms's memo cache is a cliff, not a curve.** From solid colour,
  1 % noise takes adjacency from 100 % to 4.2 % and `lcms-wasm` from
  92.0 to 33.7 MPx/s. The `NOCACHE` column shows no cliff, confirming
  the attribution.
- **A shared defect is not a neutral one.** The bad input reached every
  engine equally but did not affect them equally — jsCE's SIMD tier
  lost 39–54 % on a corrected input where `lcms-wasm` lost 3–26 %, so
  the old *ratios* were overstated by 24–52 %, not just the MPx/s.

Two charts are committed as SVG and regenerate from harness output via
`plot_noise_curve.cjs` / `plot_noise_bases.cjs`.

### Added — `bench/reproduce.js` — one command for the whole comparison

Runs all seven phases behind
[docs/LcmsComparison.md](./docs/LcmsComparison.md) — corpus, accuracy,
native lcms at both builds, JS content matrix, size sweep, per-image
rows, pixel cache, control bench — and writes each phase's raw output to
`bench/results/<timestamp>/` next to a `conditions.md` that captures CPU,
compiler, versions and corpus automatically. Detects WSL on Windows,
`--skip-native` where no Linux toolchain exists, `--only <phases>` for
subsets, `--quick` for a reduced pass. The page asks that the comparison
be produced in one controlled session rather than assembled from runs
made months apart; this is what makes that repeatable instead of
aspirational.

### Added — `bench/solo_photo/` control bench

A deliberately minimal cross-check for the above: one photograph, one
engine, one process, no `lcms-wasm` loaded, five independent processes
per engine with a 3 s warmup each. It exists because correcting the
input generator roughly halved published throughput, and a harness that
measures 120 cells could plausibly have caused that itself. It agrees
with the release matrix to within a few per cent on the same image and
workflow, with **0.4–2.0 % spread** across processes — two harnesses
sharing no measurement code, so the halving was the input rather than
the harness. It also fills in the WASM **scalar** tier (76.6 / 66.5
MPx/s), which sits between plain JS and SIMD about where four-lane
vectorisation predicts.

### Docs

- New: [docs/LcmsComparison.md](./docs/LcmsComparison.md),
  [docs/DeviceLink.md](./docs/DeviceLink.md),
  [docs/NChannel.md](./docs/NChannel.md),
  [docs/Plugin.md](./docs/Plugin.md),
  [docs/deepdive/Identity.md](./docs/deepdive/Identity.md),
  [docs/deepdive/KernelModules.md](./docs/deepdive/KernelModules.md)
  (as-built), plus deep dives on benchmarking methodology
  ("Schrödinger's Bench"), the matrix-shaper WASM POC, and why
  MPE / Named Color profiles are out of scope.
- README repositioned: single-threaded framing throughout — faster
  than `lcms-wasm` on every workflow; native-C-class performance on
  one thread; not a scoreboard against LittleCMS.
- Samples reorganised into per-tool folders
  (`samples/ICCImage/`, `samples/LutBuilder/`, …); new browser
  benchmark framework under `samples/benchmark/`.

---

## [1.4.4] — 2026-05-02

### Added — TIFF visual editing workflow (`LutBuilder` Stage 3)

Any ICC-aware image editor (Photoshop, Affinity, GIMP, ColorSync) can now act as a LUT authoring tool. Export an identity LUT as a TIFF image, apply any colour conversion or grade in the editor, reimport. The editor's CMS is captured at grid resolution and dispatched at WASM-SIMD speed.

**TIFF export (`builder.exportTIFF(opts)`)** — writes a self-documenting TIFF:
- LUT grid packed as `scale×scale` solid pixel blocks (default scale=3; scale=2 for 4D)
- Preview images (optional, drawn right of the LUT region, colour-space-converted when outputProfile is supplied)
- Per-channel gradient bars (native output-space values — CMYK bars are true single-channel ink ramps)
- Text strip with creation metadata (human-readable parameter fallback if all tags are stripped)
- ZIP compression (Node.js via zlib) — 4–9× size reduction vs uncompressed; utif decodes transparently
- Metadata in three layers: private tag 32768 (direct), XMP `jsce:LutMeta` (survives Photoshop round-trip), text strip (human fallback)
- Optional ICC profile embedding (tag 34675) via `iccProfileBytes`

**TIFF import (`LutBuilder.fromTIFF(data, opts)`)** — robust parser:
- Reads XMP `jsce:LutMeta` first (survives Photoshop), tag 32768 as fallback
- Auto-detects output channel changes from TIFF `SamplesPerPixel` (e.g. RGB→CMYK conversion)
- Extracts embedded ICC profile and sets it as the LUT chain output descriptor
- Validates `scale×scale` block spread — rejects JPEG-compressed or painted-over cells
- Rejects planar TIFFs (PlanarConfiguration=2) with a clear fix message
- Handles LZW, ZIP, and uncompressed; 8-bit and 16-bit; 1–4 channels

**Supported channel types:** 1D tone curves (Gray, N=255), 3D RGB, 4D CMYK, 2D Duo

**TIFF layout for 1D:** strip width = `N × scale`, height = `max(6×33×scale, N×scale)` — gives room for preview images regardless of N

**`LutBuilder.pixelsToTIFF(pixels, w, h, spp, bps, opts)`** — static helper to write raw pixel data as a TIFF (used by `--apply` and delta output)

### Added — CLI tool (`samples/LutBuilder/lut-tiff-cli.js`)

A command-line interface for the full TIFF LUT workflow:

| Mode | Command | Description |
|---|---|---|
| `--create` | `--channels 3 --size 33 --out lut.tiff` | Build identity TIFF (alias `--identity`) |
| `--import` | `--in edited.tiff --out lut.json` | TIFF → LUT JSON; auto-detects all parameters |
| `--validate` | `--original x.tiff --edited y.tiff --lut z.json` | LUT accuracy vs ground truth |
| `--compare` | `--base a.tiff --test b.tiff` | Direct pixel diff, no LUT |
| `--apply` | `--source x.tiff --lut z.json --out out.tiff` | Apply LUT to any image |
| `--make-samples` | | Generate built-in RGB/CMYK/Gray sample TIFFs |

### Added — Analysis and comparison (`builder.analyze` / `LutBuilder.comparePixels`)

- **`builder.analyze(inputPixels, expectedPixels, opts)`** — applies the LUT to `inputPixels`, diffs against `expectedPixels` (ground truth). Returns ΔP report: mean, max, RMSE, p95, p99, per-channel breakdown, grade (SUB-LSB / EXCELLENT / GOOD / ACCEPTABLE / REVIEW), pass/fail vs threshold. Optional delta pixel arrays (`returnDelta: true`) for writing visualisation TIFFs
- **`LutBuilder.comparePixels(a, b, channels, opts)`** — pure pixel comparison (no transform). Same report shape. Use to benchmark multiple CMS tools against a baseline
- Both report `reportText` — a formatted text summary suitable for writing to a `.txt` file alongside delta images
- `--delta-out` in CLI saves `_magnitude_amp{N}x.tiff` (1ch grayscale hotspot map) + `_channels_amp{N}x.tiff` (per-channel diff) + `_report.txt`

### Added — Sample LUT TIFFs (`npm run tiff-samples`)

Three ready-to-use TIFF identity grids in `samples/tiff_samples/`:

| File | Size | Contents |
|---|---|---|
| `rgb_srgb_identity_n33.tiff` | 409 KB | 3D N=33 scale=3 16-bit, sRGB2014 ICC embedded |
| `cmyk_gracol_identity_n17.tiff` | 1.2 MB | 4D N=17 scale=2 16-bit, CoatedGRACoL ICC embedded |
| `gray_identity_tonecurve_n255.tiff` | 225 KB | 1D N=255 scale=3 16-bit, 255-step tone curve |

### Added — TIFF test suite (`__tests__/lutbuilder_tiff.tests.js`)

32 tests covering: LZW/ZIP/uncompressed decode, CMYK→RGB and RGB→CMYK output-channel detection, embedded ICC extraction, damaged-cell rejection, planar-format rejection, 1D dot-gain curve import, CLI pipeline tests that generate sample JSONs and delta TIFFs in `cli_output/`

### Changed

- `LutBuilder` internal `_readTiffCell` threshold for 8-bit: raised from 2 to 514 (2 u8 LSB × 257) to accommodate Photoshop-saved 8-bit TIFF quantisation without false-positive corruption errors
- 1D LUT TIFF layout: height = `max(6×33×scale, N×scale)` — decoupled from N so N=255 at scale=3 gives a 765×765 LUT area instead of 12,240×12,240
- Generic CMYK export (no `outputProfile`): now warns and silently skips preview images instead of throwing — enables "untagged CMYK" workflow
- sRGB output detection: skips canvas→sRGB pixel conversion (canvas is already sRGB) when output profile is detected as sRGB by name

---

## [1.4.3] — 2026-05-01

### Added — Portable LUT JSON format (`Transform.toJSON` / `fromJSON`)

A complete handshake format for LUTs that travels between processes,
machines, and runtimes. The producer builds once with ICC profiles;
the consumer rebuilds a ready-to-use Transform from a JSON file with
no profiles loaded.

- **`transform.toJSON(opts)`** — instance method. Auto-called by
  `JSON.stringify(transform)` (JS protocol). Defaults to u16 base64
  (lossless for the f64 ↔ u16 boundary); `opts.dataType: 'u8'` halves
  the size with ~1 LSB of u8 quantisation noise.
- **`Transform.fromJSON(input, opts)`** — static factory. Accepts a
  JSON string or already-parsed object; returns a Transform with the
  LUT loaded and the right kernel resolved for the given `dataFormat`.
- **`Transform.lutToJSON(lut, opts)`** / **`Transform.jsonToLut(input)`**
  — static helpers; the format authority. Both `Transform.toJSON` and
  `LutBuilder.toJSON` delegate here, so the wire format has a single
  source of truth.
- **`opts.verify: true`** on `setLut`/`fromJSON` — opt-in signature
  check; throws on mismatch.

For a 33-pt 3D RGB→CMYK LUT the JSON is ~370 KB (u16 b64) or ~190 KB
(u8 b64), parses + dispatches in ~5 ms, and ships without ICC profiles
or the lcms-wasm runtime. See the
[`samples/lut-cmyk-to-rgb.html`](./samples/lut-cmyk-to-rgb.html) demo.

### Added — `Transform.setLut()` is now LUT-authoritative

Previously, `setLut(lut)` required the constructor to also be called
with `buildLut: true`, otherwise the `lutMode` resolution stayed at
`'float'` and the int8/int16 kernels were never selected. Now,
`setLut(lut)` itself:

- Sets `builtLut = true` (a LUT is present).
- Re-resolves `lutMode` if the user requested `'auto'` — picks the
  int8/int16 kernel matching `dataFormat`.
- Decodes base64 (if present) and **normalises any CLUT type to
  Float64Array `[0..1]`** — accepts `Uint16Array` (`[0..65535]`),
  `Uint8Array` (`[0..255]`), or `Float64Array` directly. Previous
  behaviour decoded base64 but left the CLUT as integer typed arrays,
  giving wrong runtime output for the float kernel.
- Regenerates strides (`g1, g2, g3, go0, go1, go2, go3`) from
  `gridPoints + outputChannels` — strides are no longer serialised.

A new `opts` argument accepts `{ verify: true }` to validate the LUT
signature (see below) at load time.

### Added — content signatures (`FNV1A:<hex>`)

Lightweight content fingerprints for LUTs — detect mutation, validate
data integrity over the wire, audit-trail the source of a LUT.

- **`Transform.signLut(lut)`** / **`Transform.verifyLut(lutOrJson)`**
  — static helpers. FNV-1a 32-bit (`Math.imul`-based, ~1.3 ms for
  a 33-pt 3D LUT) over (`inCh`, `outCh`, `gridPoints`, chain
  `name|type|version` per entry, full-scale u16 CLUT bytes).
- **`transform.signLut()`** / **`transform.verifyLut()`** — instance
  methods.
- Algorithm-prefixed format (`"FNV1A:<8 hex>"`) so a stronger hash can
  be added later (`"SHA256:..."`) without breaking the wire.
- **Computed lazily** — engine `createLut()` does NOT stamp during
  pipeline build; the hot path stays clean. `toJSON()` lazy-stamps on
  export. `LutBuilder.fromTransform/createFromLCMS` stamp at extraction
  time when source-marker semantics are wanted.

Not cryptographic — for adversarial tamper-evidence, sign the JSON
externally with crypto + a key.

### Added — `LutBuilder` (samples)

A small MIT-licensed helper at `samples/LutBuilder/LutBuilder.js` for creating,
mutating, and serialising LUTs on top of the engine. Stage 1 ships
the core API:

- `new LutBuilder()` / `LutBuilder.fromTransform(t)` /
  `LutBuilder.fromJSON(json)` — builder entry points.
- `.create(opts, callback)` — synthetic LUT from a colour function.
- `.createIdentity(channels, size)` — blank canvas.
- `.createFromLCMS(lcms, xform, opts)` — Tier 3 lcms-wasm bridge.
  **Auto-detects** Emscripten lcms-wasm (`_malloc`, `_free`,
  `_cmsDoTransform`, `HEAPU8`) and uses one batched `_cmsDoTransform`
  call across the whole grid — ~80× faster than per-cell. Falls back
  to `lcms.doTransformU16(xform, in, out)` for generic JS lcms wrappers.
- `.editLut(callback)` — per-cell mutation. Auto-appends a
  timestamped breadcrumb to `meta.adjustments[]`; preserves
  `originalSignature` (the source-marker).
- `.clone()` — deep copy.
- `.addMeta()` / `.addCopyright()` / `.addAdjustment()` /
  `.setChain()` — metadata.
- `.toLut()` / `.toTransform(opts)` / `.toJSON(opts)` — output.
- `virtualProfile()` / `virtualRGB/CMYK/Gray/Lab(name)` — chain
  descriptor helpers. The `*` prefix (`virtualRGB('*sRGB')`) delegates
  to the engine's built-in virtual profile builder for full
  whitepoint/PCS metadata.

LutBuilder.js is dual-mode (CJS for Node tests, browser globals for
demos via `<script src="LutBuilder.js"></script>`).

Storage is **u16 canonical** (`Uint16Array` in `[0..65535]`) — matches
the ICC LUT precision ceiling, the 16-bit TIFF workflow, lcms-wasm u16
output, and the engine's u16 kernel. Conversion to f64 happens at
`toLut()` time (lossless).

See [`samples/LutBuilder/lutbuilder.md`](./samples/LutBuilder/lutbuilder.md) for the user
guide and [`docs/deepdive/Luts.md`](./docs/deepdive/Luts.md) for the
deep dive.

### Fixed — `create4DDeviceLUT` pipeline chaining (engine)

`Transform.create4DDeviceLUT` was passing the original device-space
input `src` to every pipeline stage instead of chaining each stage's
output to the next stage's input. Concretely:

```js
// before
for(i = 0; i < len; i++){
    device = pipeline[i].funct.call(this, src, ...);   // ← `src`, never updated
}

// after — matches create3DDeviceLUT
device = this.forward(src);   // properly chains stages
```

Symptom: for any CMYK-input LUT chain longer than one stage (i.e. all
real ICC CMYK profiles), the LUT contained inverted output. CMYK
white paper rendered as black RGB; max-ink CMYK rendered as white.
The bug existed because no test compared live (no LUT) vs LUT-built
output for 4D — only LUT-vs-LUT bit-exactness across kernels. Both
LUTs were equally wrong, so the comparison passed.

A new test in `__tests__/lutbuilder.tests.js` regression-checks live
vs LUT-built CMYK→RGB pixel agreement, with explicit CMYK (0,0,0,0) →
near-white sRGB sanity assertion.

### Fixed — ICC header `date` parsing (Profile)

`Profile.decodeHeader` previously stored the 12-byte ICC date field as
a raw byte array (`[7, 217, 0, 6, ...]`), which serialised to JSON as
unreadable noise. Now parses to a JavaScript `Date` (UTC) — JSON
becomes `"2009-06-26T00:22:19.000Z"`. Mixed with virtual profiles
(which already had ISO-string dates) the chain output is now uniform.

### Fixed — ICC header `version` parsing (Profile)

`header.version` previously stored the 4 raw bytes (`[2, 16, 0, 0]`).
Now parses per ICC v4 §7.2.4: byte 0 = major, byte 1 = minor (high
nibble) + bug fix (low nibble). Result is a `"M.m.b"` string
(`"2.1.0"`). The integer major version (used for v2/v4 PCS routing
throughout `Transform.js`) is preserved as `header.versionMajor` and
`profile.version`.

### Fixed — JSON wire format cleanup

- **Strides removed** from JSON output (`g1, g2, g3, go0, go1, go2,
  go3`) — derivable from `gridPoints + outputChannels`, regenerated
  on decode by `_decodeLutCLUT`.
- **`inputScale` / `outputScale` forced to canonical 1/1** in JSON
  output. The engine modifies these to non-1 values internally during
  u8 dispatch (`outputScale: 255`, `inputScale: 1/255`) — those are
  kernel-internal scaling parameters and don't belong in the wire
  format. Encoded CLUT is canonical full-scale u16 [0..65535] = device
  [0..1], so portable scales are always 1.

### Added — demo `samples/lut-cmyk-to-rgb.html`

End-to-end CMYK → RGB workflow demo:

- Builds two LUTs at page load: jsCE engine pipeline and lcms-wasm
  (via `LutBuilder.createFromLCMS`).
- Serialises both to JSON, rebuilds Transforms via `Transform.fromJSON`.
- Three-up canvas: live (no LUT) vs jsCE LUT vs lcms LUT, plus ΔP
  comparison table and JSON inspector (CLUT bytes elided).
- Warmup pass before the timed comparisons primes V8 JIT, the WASM
  module's icache, and the `intLut` data — the inline timings reflect
  steady-state kernel speed.

Representative numbers (Chrome on x86_64, 17⁴ 4D LUT, GRACoL2006 →
sRGB relative+BPC):

- Build: jsCE ~28 ms, lcms ~80 ms (one-time, page load).
- JSON: ~654 KB each (u16 base64 over 250K values).
- `Transform.fromJSON` cold start: ~6 ms.
- Per-frame transform on 240K pixels: live ~41 ms, LUT ~5 ms (~6×).
- jsCE LUT vs lcms LUT raw u16 grid agreement: **0.10 ΔP per channel**
  — the engines produce essentially the same colour math.
- Mean ΔP between live (f64 pipeline) and either LUT: < 1 — sub-LSB
  at 8-bit, indistinguishable on screen.

### Tests

- New **`__tests__/lutbuilder.tests.js`** — 98 tests covering
  `LutBuilder` API, `virtualProfile()` helpers (incl. `*` prefix to
  engine built-ins), `create()` / `createIdentity()` / `createFromLCMS`,
  `editLut()` audit trail, `clone()`, metadata, `toLut()` / `toJSON()`,
  `fromJSON()`, the W1–W5 workflow tests (live vs LUT, edit + restore,
  clone-and-diverge, custom callback, JSON portability), 4D
  CMYK→RGB live-vs-LUT regression, and signature audit-trail (sign
  on extract / preserve through edit / verify after restore).

### Docs

- New [`docs/deepdive/Luts.md`](./docs/deepdive/Luts.md) (renamed
  from `LUTBuilder.md`) — deep-dive: design rationale, format spec,
  lcms architecture, signature design, demo numbers.
- New [`samples/LutBuilder/lutbuilder.md`](./samples/LutBuilder/lutbuilder.md) — practical
  user guide with code examples for every API, common workflows
  (TAC limit, pre-baked library, hybrid lcms fallback, JSON
  portability), and the audit-trail story.
- Updated `docs/deepdive/README.md` index entry.

### Changed

- `transform.lut.originalSignature` no longer eagerly stamped during
  `createLut()`. The hot path (build + transformArray) pays nothing
  for signatures; `toJSON()` lazy-stamps on export.
- `LutBuilder.editLut()` auto-appends `"editLut() at <ISO timestamp>"`
  to `meta.adjustments[]` — gives an audit breadcrumb without the
  caller having to remember to call `addAdjustment()`.

---

## [1.4.2] — 2026-04-28

### Added — WASM memory management

WASM linear memory can only grow by spec — a transient large image
permanently inflates the buffer. Two automatic post-run guards and
manual controls reclaim it:

- **`wasmMaxMemory`** (default **128 MB**) — absolute ceiling. After
  each transform, any state exceeding this compacts immediately.
  Large images still process fine; memory is freed before the method
  returns. Prevents runaway memory with zero configuration.
  `setWasmMaxMemory(bytes)` / `{ wasmMaxMemory: N }`. Set 0 to disable.
- **`wasmShrinkRatio`** — relative guard. After each transform,
  compacts when memory exceeds `ratio ×` what the image just needed.
  Keeps memory proportional to the current workload. Default 0 (off).
  `setWasmShrinkRatio(N)` / `{ wasmShrinkRatio: N }`.
- **`compactWasmMemory()`** — explicit re-instantiation (~0.1 ms).
- **`releaseWasmMemory()`** — drops all WASM states; falls back to
  pure-JS `'int'` kernels.
- **`wasmMemoryBytes()`** — diagnostic: total bytes across all states.

See [WASM memory management deep dive](./docs/deepdive/WasmKernels.md#wasm-memory-management-v142)
for benchmarks and design rationale.

### Added — reusable output buffer for `transformArrayViaLUT`

Pass a pre-allocated `Uint8ClampedArray` (or `Uint16Array` for int16
modes) as the `outputArray` parameter to eliminate per-call allocation
and reduce GC pressure. Especially beneficial for real-time workflows
(video soft-proofing, animation loops) where allocation churn can
trigger GC pauses.

### Added — Lab ↔ int16 encoding helpers

- **`convert.lab2Int16(L, a, b, encoding)`** — encode float Lab to
  ICC u16 values (v2 or v4 encoding).
- **`convert.int162Lab(uL, ua, ub, encoding)`** — decode ICC u16 Lab
  back to float Lab object (D50 white point).
- **`convert.labEncoding.v2` / `.v4`** — frozen preset objects with
  pre-computed multipliers for zero-branch hot-loop encoding.
- **`lut.inLab` / `lut.outLab`** — encoding metadata auto-populated
  on the LUT at `create()` time when the corresponding profile is a
  Lab profile. Survives `JSON.stringify` / `structuredClone` /
  `postMessage` (pure data, no functions).
- Four **Transform wrappers**: `inputLab2Int16`, `outputLab2Int16`,
  `inputInt162Lab`, `outputInt162Lab` — read the encoding from the
  LUT automatically, throw clearly if the profile side isn't Lab.

### Added — LUT build hooks (`lutInputHook` / `lutOutputHook`)

Per-grid-cell hooks that run during LUT construction, baking warps
into the LUT with zero per-pixel runtime cost.

- **Constructor shorthand**: `{ lutInputHook: fn, lutOutputHook: fn }`.
- **Composable API**: `addLutInputHook(fn, 'before'|'after')`,
  `addLutOutputHook(fn, 'before'|'after')`, `clearLutHooks()`.
  Multiple hooks chain in array order.
- Output hooks receive a second read-only argument (`deviceIn`) —
  the original grid-cell input, useful for logging/debugging.
- Injected into all four LUT builders (1D/2D/3D/4D).

### Changed — hot-path optimisations

- `_expectsU16` and `_isIntegerMode` cached at `create()` time,
  removing 9 string comparisons per `transformArrayViaLUT` call.
- `isIntLutCompatible` check moved from per-call to `create()` time.

### Fixed — sample link portability

All absolute paths in `samples/` converted to relative, making the
demo tree deployable to any web server path without URL rewriting.

### Docs — sample code comments

Added inline documentation to `samples/live-video-softproof.html` and
`samples/softproof.html` explaining ICCImage usage, the colour pipeline,
Transform API calls, output buffer reuse, WASM memory management,
channel plate rendering, and the accuracy-path colour picker. Samples
now serve as learning material as much as demos.

### Tests

- New **`__tests__/transform_wasm_memory.tests.js`** — 14 tests
  covering compact, release, auto-shrink, `wasmMemoryBytes`,
  `wasmMaxMemory` default/ceiling/runtime, and post-run compaction.
- New **`__tests__/convert_lab_int16.tests.js`** — 32 tests covering
  `convert.lab2Int16` / `convert.int162Lab` (v2 + v4 round-trips,
  boundary values, clamping, error cases) and the four Transform
  wrappers (`lut.inLab`/`outLab` population, encode/decode, throws
  on non-Lab profiles).
- New **`__tests__/transform_lut_hooks.tests.js`** — 16 tests covering
  constructor hooks, `addLut*Hook` methods, `before`/`after` ordering,
  `clearLutHooks`, hook composability, channel counts, call counts,
  and output hook `deviceIn` second argument.
- New **`__tests__/transform_guards.tests.js`** — 18 tests covering
  input/output validation: wrong outputArray type, outputArray too
  small, no pipeline, preserveAlpha without alpha, CMYK channel counts,
  and guard forwarding through `transformArray`.
- Removed 7 format-tag guardrail tests that were testing internal
  tampering (mutating `intLut.version` on a live Transform), not
  public API behaviour.

---

## [1.4.1] — 2026-04-27

Patch release: sample and helper fixes for soft-proof pipelines.

### Fixed — Soft-proof “reverse” leg (CMYK → preview sRGB)

This is what happens when you are so excited about your video demo you forget to check your homework. The CMYK → sRGB pass that drives on-screen preview must use **relative
colorimetric** intent only. Applying the user-selected proof intent
(perceptual, saturation, etc.) on both RGB → CMYK and CMYK → sRGB
**double-applies** gamut handling and is not how separation preview
is meant to behave.

- **`samples/ICCImage/iccimage.js` — `ICCImage.toProof()`** — When `intent` or
  `BPC` is passed as a single value, the second leg now defaults to
  **relative colorimetric** and **no black-point compensation**;
  the first leg still receives the caller’s intent and BPC. Explicit
  two-element arrays still override per leg. **`toCanvas()`** was
  already relative-only for non-sRGB profiles; unchanged.

### Fixed — Sample demos aligned with the above

- **`samples/softproof-vs-lcms.html`** — lcms-wasm: second transform
  uses `INTENT_RELATIVE_COLORIMETRIC` and high-res precalc only (no
  BPC on the preview transform). jsCE path uses `toProof()` defaults.
- **`samples/softproof.html`** — `toProof()` uses the same intent /
  BPC defaults as the helper (explicit per-leg arrays removed as
  redundant).
- **`samples/live-video-softproof.html`** — `createMultiStage` chain
  already ended with `eIntent.relative` before sRGB; unchanged, now
  documented as the reference pattern alongside the other demos.

### Changed — Interactive bench moved under `samples/`

- Moved the browser interactive bench from `bench/browser` to
  `samples/bench` so sample pages are self-contained in one tree.
- Updated sample/bench references and navigation links accordingly,
  including the samples landing flow.

### Fixed — Bench engine-info panel: lcms scalar build wrongly shown as a warning

- **`samples/bench/main.js`** — when lcms-wasm loads, the `info-lcms`
  cell now stays **green** regardless of whether the shipped lcms.wasm
  is a SIMD or scalar build. Previously a stock (scalar) build painted
  the cell amber, which read like a host SIMD problem when in fact
  jsCE's own SIMD kernels were running fine on the same host.
- The build tag changed from `scalar build (no -msimd128)` to
  `stock scalar build` — informational, not a deficiency. About-this-
  bench copy in `samples/bench/index.html` and `docs/Bench.md` reworded
  to match.

### Added — ARM64 / Apple Silicon (M4) measurement

- **`docs/deepdive/Performance.md` § 2.6** — new section with measured M4
  Mac mini numbers (Chrome 147, browser bench): SIMD 3D paths
  +25 % over x86_64, **SIMD 4D paths +65 %**. The `int-wasm-scalar`
  and pure-JS `int` tiers gain the same ~1.4–1.6×, confirming the
  global register-pressure win predicted in the JIT-inspection
  deep-dive months earlier (31 ARM64 GPRs vs ~11 allocatable on
  x86-64).
- **`docs/deepdive/JitInspection.md`** — “Implications for future
  work” updated: the “measure on M1/M4” experiment is now a
  measured result, with the spill-vanishes-on-ARM hypothesis
  confirmed and cross-linked back to Performance § 2.6.
- **`docs/Bench.md`** — caveats list calls out the ~1.4–1.6× ARM
  lift so M-series users aren’t surprised when their numbers run
  ahead of the x86 headline table.
- **`README.md`** — headline “Fast” bullet, lcms-wasm comparison
  bullet, “Two paths” summary, bench caveat, **and the 8-bit Speed
  table** all now show x86_64 + Apple M4 side-by-side. New “Apple
  Silicon (M4) runs ~1.4–1.6× faster” bullet in the Speed key
  takeaways.

### Release note — GitHub-only update

- This `1.4.1` release is for the GitHub source/docs/samples path.
  npm packages do not ship `samples/`, so these demo updates are not
  distributed via npm.

---

## [1.4.0] — 2026-04-26

The showcase release. v1.3 banked the performance story (158 MPx/s
WASM SIMD, 4–5× over lcms-wasm 16-bit); v1.4 puts it in front of
users with runnable browser demos, a small image helper that makes
those demos trivial to write, baked gamut-mapping in the LUT, and a
license change from GPL-3.0 to MPL-2.0.

### Changed — License: GPL-3.0 → MPL-2.0

The engine license has been changed from
[GPL-3.0](https://www.gnu.org/licenses/gpl-3.0.html) to
[MPL-2.0](https://mozilla.org/MPL/2.0/). MPL-2.0 is file-level
copyleft: modifications to engine source files must remain open, but
the library can be freely combined with proprietary code in a Larger
Work without license infection. This makes jsColorEngine practical
to embed in commercial web apps, Electron tools, and SaaS pipelines
— the main adoption blocker GPL posed. The `samples/` directory
remains MIT-licensed.

### Added — `ICCImage` helper (`samples/ICCImage/iccimage.js`)

Small immutable image wrapper that owns the "I have an image, I want
to display / proof / inspect it" workflow on top of jsColorEngine.
Not a general image library — strictly "move bytes around the colour
transform, visualise what's there". Lives in `samples/` (not `src/`)
deliberately: it's **helper-grade**, MIT-licensed, and doubles as
living documentation of how to drive the core engine on real image
data.

- **Immutable.** Every `toSRGB` / `toProof` / `toSeparation` /
  `toBitDepth` / `resizeTo` returns a *new* `ICCImage`. The source
  is never mutated.
- **Always profile-tagged.** The internal `ICCImageData` carries the
  `Profile` and the full lineage chain.
- **Lazy + cached.** `Transform`s are built on first use and stored
  in a `TransformCache` keyed by chain + BPC + dataFormat + buildLut.
  Derived images share their parent's cache.
- **Two paths.** Bulk image work uses `dataFormat: 'int8'` + LUT
  (fast path). Single-pixel `pixel(x, y)` uses `dataFormat: 'object'`
  with no LUT (accuracy path).

Key methods: `ICCImage.fromHTMLImage()`, `toProof()`,
`toSeparation()`, `renderChannelAs()`, `toCanvas()`, `pixel(x, y)`,
`toBitDepth()`, `resizeTo()`. Full API reference:
[`samples/ICCImage/ICCImage.md`](./samples/ICCImage/ICCImage.md).

### Added — baked gamut-mapping LUT (`lutGamutMode`)

New `Transform` constructor options for baking gamut visualisation
directly into the LUT at build time — zero per-pixel cost at
transform time:

- **`lutGamutMode`** — `'none'` (default), `'color'` (hard replace
  out-of-gamut cells), `'map'` (write scaled ΔE into every output
  channel), or `'colorMap'` (blend original → gamut colour
  proportional to ΔE).
- **`lutGamutLimit`** — ΔE76 threshold for `'color'` mode (default 5).
- **`lutGamutMapScale`** — ΔE that maps to 1.0 in `'map'` mode
  (default 25.5).
- **`lutGamutColor`** — Lab colour for out-of-gamut replacement
  (default bright pink).
- **`gamutDeFn`** — colour-difference function (default `deltaE1976`;
  swap in `deltaE2000`, `deltaCMC`, or a custom function).
- **`bakeLutGamut`** — legacy shorthand; `true` ≡
  `lutGamutMode: 'color'`.

The gamut check runs once during `buildLut` (the per-grid-point Lab
round-trip ΔE is computed and cells are tagged/replaced/blended
according to the mode). The resulting LUT feeds through the same
WASM SIMD kernel as any other — the gamut overlay is free at
runtime. Used by the live-video soft-proof demo to render real-time
gamut warnings at 30+ fps with zero hot-path cost.

### Added — browser samples

Runnable HTML demos of jsColorEngine, hosted at
<https://www.o2creative.co.nz/jscolorengine/samples/>.

- **[`live-video-softproof.html`](./samples/live-video-softproof.html)**
  — real-time video colour management. Every frame decoded and
  soft-proofed through a full ICC sRGB → CMYK → sRGB pipeline via a
  pre-built 3D CLUT. Pure JS, no WebGL, no workers. 40+ fps on 720p.
  The headline demo for the v1.3 WASM SIMD performance story.
- **[`softproof.html`](./samples/softproof.html)** — sRGB → CMYK
  soft proof + C/M/Y/K plate previews with floating colour picker
  (Lab, sRGB, CMYK, ΔE 2000, ΔE 76). Showcases `toProof`,
  `toSeparation`, `renderChannelAs`, `pixel()`, intent + BPC
  controls.
- **[`softproof-vs-lcms.html`](./samples/softproof-vs-lcms.html)**
  — side-by-side jsColorEngine vs lcms-wasm pixel-by-pixel accuracy
  comparison with amplified diff slider (up to 128×), signed RGB
  mode, CMYK + RGB stats, speed ratio. The proof-of-accuracy demo.
- **[`index.html`](./samples/index.html)** — landing page with demo
  index and setup instructions.

Still planned: `colour-calculator.html` (interactive colour space
converter) and `profile-inspector.html` (ICC tag/TRC/gamut viewer).

### Added — sample infrastructure

- **`samples/serve.js`** — zero-dependency static HTTP server for
  local development (`npm run samples:browser` → `:8080`).
- **`samples/styles/styles.css`** — shared stylesheet across all demos.
- **`samples/profiles/`** — bundled CMYK ICC profiles for the demos
  (CoatedGRACoL2006, ISOcoated_v2_eci, eciCMYK_v2).

### Documentation

- New **[docs/Samples.md](./docs/Samples.md)** — live demo index,
  setup instructions, helper overview.
- New **[samples/ICCImage/ICCImage.md](./samples/ICCImage/ICCImage.md)** — full API
  reference for the `ICCImage` helper.

### Tests

- New **`__tests__/transform_lut_gamut.tests.js`** — gamut-mapping
  LUT tests covering `lutGamutMode` `'none'` / `'color'` / `'map'`
  / `'colorMap'`, threshold behaviour, custom ΔE functions, and the
  `bakeLutGamut` legacy shorthand.

---

## [1.3.0] — 2026-04-25

### Added — 16-bit kernel ladder (`dataFormat: 'int16'`)

Three new `lutMode` values flesh out the u16 I/O path so it has
the same JS / WASM scalar / WASM SIMD ladder the v1.2 u8 path
ships. All three siblings are **bit-exact against each other**
across the full `(mode × inCh × outCh)` matrix; the headline
gain over `lcms-wasm` 16-bit is **3.9–4.9× on every workflow**.

- **`'int16'`** (JS) — `Uint16Array` CLUT scaled to the full
  `[0..0xFFFF]` range with **Q0.13 fractional weights**. Q0.13 was
  chosen as the precision sweet-spot that keeps every intermediate
  inside the i32 envelope `Math.imul` and `i32.mul` share — so
  JS ↔ WASM is bit-exact across browsers and OSes without runtime
  checks. 4D paths use a two-rounding K-LERP for i32 safety with no
  measurable accuracy cost.
- **`'int16-wasm-scalar'`** — same Q0.13 contract compiled to
  hand-written `.wat` (`src/wasm/tetra{3,4}d_nch_int16.wat`).
  Bit-exact against the JS sibling, **0 LSB across the 6-config
  matrix.** ~1.3–1.4× over JS `'int16'` on 3D, ~1.0–1.2× on 4D.
- **`'int16-wasm-simd'`** — channel-parallel `v128`, Q0.13,
  two-rounding K-LERP for 4D with the K0 intermediate carried in a
  `v128` local across the K-plane loop back-edge (no scratch
  memory). Bit-exact against both u16 siblings.
  **~1.7–2.4× over `'int16-wasm-scalar'`, ~2.0–2.6× over JS
  `'int16'`, ~3.9–4.9× over `lcms-wasm` 16-bit at every workflow.**

Browser bench headline (Chrome 147, x86_64, GRACoL2006 + sRGB,
65 K pixels/iter):

| Direction      | jsce `int16` (JS u16) | `int16-wasm-scalar` | **`int16-wasm-simd`** | lcms 16-bit best |
|----------------|------------------------|----------------------|-----------------------|------------------|
| RGB → RGB      | 66 MPx/s               | 93 MPx/s             | **158 MPx/s**         | 46 MPx/s |
| RGB → CMYK     | 56                     | 78                   | **149**               | 44 |
| CMYK → RGB     | 42                     | 43                   | **90**                | 24 |
| CMYK → CMYK    | 35                     | 37                   | **86**                | 21 |

`'auto'` resolution for `dataFormat: 'int16'` follows the same
demotion chain as the v1.2 u8 path: `'int16-wasm-simd'` →
`'int16-wasm-scalar'` → `'int16'`.

### Added — three accuracy gates for the u16 ladder

- **[`bench/int16_identity.js`](./bench/int16_identity.js)** — synthetic
  identity-CLUT round-trip. Kernels MUST round at the u16 LSB on
  every release; this is a CI-grade hard gate.
- **[`bench/int16_poc/accuracy_v1_7_self.js`](./bench/int16_poc/accuracy_v1_7_self.js)**
  (filename retained as a development artifact) — jsCE float-LUT vs
  jsCE int16-LUT. Pure kernel quantisation noise: **max 4 LSB u16
  on every workflow, mean ≤ 0.48 LSB**.
- **[`bench/lcms_compat/run.js`](./bench/lcms_compat/run.js)** —
  jsCE float pipeline vs lcms2 2.16 float pipeline (`TYPE_*_DBL`)
  across 150 CGATS `.it8` reference files / ~580 k samples.
  130 pass, 20 SKIP, 0 ERROR. Worst-case ≤ 0.06 ΔE76 on Lab,
  ≤ 1.24 LSB on RGB, ≤ 0.04 % ink on CMYK.

### Changed — table-driven LUT kernel dispatcher

[`src/lutKernelTable.js`](./src/lutKernelTable.js) now resolves
`(lutMode, inCh, outCh)` against a pure-data table with per-entry
gates and an explicit fallback chain. The runtime cost is a single
table lookup at `create()` time and **one threshold compare + one
indirect call per `transformArrayViaLUT()`** invocation; the
maintainability win is "every new kernel is a row in a table",
not "another `else if` in the dispatcher".

The pre-v1.3 if/else cascade is preserved as
`transformArrayViaLUT_legacy()` for one release as an escape
hatch, gated by `__tests__/transform_lutKernelTable.tests.js`
which asserts byte-identical output between the two dispatchers
across the full coverage matrix.

### Changed — browser benchmark wired up for the u16 ladder

`bench/browser/` (and [`docs/Bench.md`](./docs/Bench.md)) now
covers **8 jsColorEngine modes vs 6 lcms-wasm flag/width
combinations across 4 directions (56 cells)**, with the new
`'int16'`, `'int16-wasm-scalar'` and `'int16-wasm-simd'` modes
wired into the dropdowns and the in-page essay. The UMD bundle
(`browser/jsColorEngineWeb.js`) was rebuilt to include the new
WASM module references.

### What's deliberately NOT in v1.3

Documented inline in [`docs/Roadmap.md`](./docs/Roadmap.md);
short version:

- **N-channel input kernels.** 3 / 4-channel CLUT inputs cover
  every device class jsColorEngine targets at speed. 5 / 6 / 7 /
  8-channel inputs (RISO MZ770, multi-spot press profiles) work
  through the f64 pipeline today and don't have a real-world use
  case for a fast int / WASM path. v1.5 adds them on the float
  side only.
- **`lutGridSize` option** and **`lcms_patch/` extraction** —
  bumped to v1.5 alongside the larger compiled-pipeline work.

### Documentation

- New [Performance.md § v1.3 — 16-bit kernel ladder](./docs/deepdive/Performance.md#v13--16-bit-kernel-ladder--shipped)
  with the headless-bench numbers, design constraints (why Q0.13
  specifically, why two-rounding for 4D), and the per-workflow
  precision tables.
- New [Accuracy.md § 16-bit kernel accuracy](./docs/deepdive/Accuracy.md#16-bit-kernel-accuracy-v13--near-perfect-no-corners-cut)
  covering the three accuracy gates and the float-vs-int16
  precision deltas.
- README updated with the 16-bit kernel modes table, the v1.3
  Speed table, and a new Accuracy subsection covering int16.
- [Roadmap.md](./docs/Roadmap.md) restructured: v1.3 moved to
  Shipped so far; v1.4 = `ICCImage` helper + browser samples
  (showcase release on the back of the v1.3 perf story);
  v1.5 = N-channel float inputs + compiled non-LUT pipeline +
  `toModule()` (the larger piece of post-v1.3 work).

---

## [1.2.0] — 2026-04-24

### Added — `lutMode: 'int-wasm-scalar'` and `'int-wasm-simd'`

Hand-written WebAssembly LUT kernels for the image hot path, both 3D
and 4D (`src/wasm/tetra{3,4}d_{nch,simd}.wat` / `.wasm.js`,
base64-inlined so they load synchronously in any JS environment —
no XHR, no fetch, no bundler config).

- **`'int-wasm-scalar'`** — bit-exact against the JS `'int'` kernel
  across the 12-config matrix. 1.22–1.45× over `'int'` on x64;
  demotes to `'int'` if WebAssembly is unavailable.
- **`'int-wasm-simd'`** — channel-parallel v128 kernel for 3D and 4D
  tetrahedral LUTs. 2.04–3.50× over `'int'` on x64; bit-exact against
  both `'int'` and `'int-wasm-scalar'`. Demotes through
  `'int-wasm-scalar'` → `'int'` on hosts without SIMD / WASM.

Kernel cache (`wasmCache`) compiles each `.wasm` module exactly once
per process, shared across all Transforms.

### Changed — `lutMode: 'auto'` is the new default

Previously `lutMode` defaulted to `'float'`. v1.2 introduces
`'auto'` as the default, which resolves at construction time based
on `(dataFormat, buildLut)`:

- `dataFormat: 'int8'` + `buildLut: true` → `'int-wasm-simd'` (with
  the standard SIMD → scalar WASM → JS `'int'` demotion chain
  running at `create()` time for older hosts)
- anything else → `'float'` (lutMode is ignored for non-int8
  dataFormats anyway — resolving to `'float'` makes
  `xform.lutMode` self-documenting about what actually runs)

**Migration:** existing code that didn't set `lutMode` keeps working
unchanged and transparently gets the SIMD kernel on int8+LUT
transforms. Code that needs bit-stable `'float'` behaviour (colour
measurement, CI benchmarks, regression suites) should pin
`lutMode: 'float'` explicitly. Inspect `xform.lutMode` after
construction to see the resolved kernel, and `xform.lutModeRequested`
to see what the caller asked for (`'auto'` for the default,
otherwise the pinned value).

Unknown / future `lutMode` values (typos, code written against a
later release) now auto-resolve the same way `'auto'` does, giving
forward-written code the best-available kernel for its
`(dataFormat, buildLut)` combination instead of silently falling
through to `'float'`. Verbose mode logs a warning on unknown
values.

### Added — native lcms2 benchmark harness (`bench/lcms_c/`)

Companion to `bench/lcms-comparison/bench.js` that measures **native**
(non-wasm) lcms2 using the same methodology — same profiles, same
65k-pixel seeded PRNG input, same 300-iter warmup + median-of-5
timing loop. A one-shot `make` compiles all ~27 lcms2 source files
directly into the benchmark binary (no autotools, no `liblcms2-dev`,
no `configure`). Tested under WSL2 (gcc 10.5) and MinGW-w64.

**Headline measurement** (WSL2 Ubuntu 20.04 on Windows 11, gcc 10.5
with `-O3 -march=native`, `taskset -c 0`, Intel x86_64):

| Workflow | jsCE `int` (pure JS) | lcms2 native | jsCE / native |
|---|---|---|---|
| RGB → Lab    | 64.5 MPx/s | 62.7 MPx/s | 1.03× (tied) |
| RGB → CMYK   | 54.2 MPx/s | 60.3 MPx/s | 0.90× (native +11 %) |
| CMYK → RGB   | 53.2 MPx/s | 36.1 MPx/s | **1.47× (jsCE +47 %)** |
| CMYK → CMYK  | 43.6 MPx/s | 31.0 MPx/s | **1.41× (jsCE +41 %)** |

`lutMode: 'int'` beats native vanilla lcms2 on 3 of 4 workflows in
pure JavaScript. With the v1.2 default (`'int-wasm-simd'`) added in
the row above: all 4 workflows, 2–5× faster than native lcms2.

The measurement also **replaces the earlier `wasm × 1.5–2.5`
estimate** in `docs/deepdive/Performance.md § 4` — reality is `native ≈
lcms-wasm × 1.4–1.6` on this profile/CPU. The estimate was
optimistic at the top of the band; modern V8 compiles wasm32 more
tightly than the original Emscripten rule-of-thumb assumed.

Reproduce on any machine with a C toolchain in ~5 minutes from a
fresh WSL2 install; see `bench/lcms_c/README.md` for the full
walkthrough.

### Added — browser benchmark (`bench/browser/`, `docs/Bench.md`)

Zero-dependency in-browser benchmark for every `lutMode`, measured
against `lcms-wasm` (LUT and no-LUT) on RGB→RGB / RGB→CMYK /
CMYK→RGB / CMYK→CMYK and a Lab→device→Lab accuracy-sweep on
jsColorEngine's f64 pipeline. `node bench/browser/serve.js` and
open the printed URL. Summary cards, per-direction charts, ΔE76
statistics, markdown-copyable results. See `docs/Bench.md` for the
full guide.

### Documentation

- New [Deep dive](./docs/deepdive/) section with subpages for
  architecture, JIT inspection, LUT modes, and WASM kernel design.
- `docs/deepdive/Performance.md` restructured around "where we are / what we
  learned / where we're going".
- `docs/Bench.md` consolidates the browser-bench user guide.
- Top-level nav bar added to every docs page.
- README refocused as an overview + getting-started guide; heavy
  technical content moved to Deep dive / Performance.

---

## [Unreleased] — Roadmap

See [docs/Roadmap.md](./docs/Roadmap.md) — single source of truth
for forward-looking plans:

- **v1.4 remaining samples** — `colour-calculator.html` (interactive
  colour space converter) and `profile-inspector.html` (ICC tag/TRC/
  gamut viewer) are still WIP. They'll land iteratively; none blocks
  v1.5 work.
- **v1.5 — N-channel float inputs + compiled non-LUT pipeline +
  `toModule()`.** The larger piece of post-v1.4 work. Also rolls in
  the `lutGridSize` accuracy lever and the `lcms_patch/` extraction.
- **v1.6 (optional)** — `lutMode: 'int-pipeline'` / S15.16 for
  lcms bit-for-bit parity, deferred unless demanded.
- **v2** — package split (`@jscolorengine/interpolator`,
  optional `@jscolorengine/pipeline-emitter`).

This section stays short on purpose. Anything measured, specified,
and scoped lives in Roadmap.md. When a version ships, its entry
lands above this section with a dated heading; the corresponding
roadmap item gets marked shipped and cross-linked here.

---

## [1.1.0] — 2026-04

The headline change in v1.1 is the new **`lutMode` option** — an opt-in
integer-math hot path for image LUT transforms. All four 3-/4-channel
image directions (RGB→RGB, RGB→CMYK, CMYK→RGB, CMYK→CMYK) are
accelerated with u16 mirror LUTs and `Math.imul`-based kernels,
typically 10–25% faster than the float kernels and using 4× less LUT
memory, with **≤ 1 LSB drift** on u8 output (well below JND, and
effectively bit-exact on RGB→RGB at 100 % match).

**Fully backwards-compatible with `1.0.5`** — `lutMode` defaults to
`'float'` (the existing kernels, bit-stable across releases). Existing
code keeps working with no changes; opt in per-Transform when you want
the speedup.

### Added — direct comparison with `lcms-wasm`

v1.1 also adds a full head-to-head benchmark harness against
[`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm) v1.0.5 (a WASM
port of LittleCMS 2.16), living in
[`bench/lcms-comparison/`](./bench/lcms-comparison) as an isolated
side-project with its own `package.json`. It measures both
**throughput** (same-machine Mpx/s) and **8-bit output accuracy**
(systematic 9^N grid + named reference colours) across all four
standard image workflows.

- **Speed.** `lutMode: 'int'` measures **1.48–2.12× faster than
  `lcms-wasm`** (HIGHRESPRECALC, with pinned heap buffers for lcms —
  the fastest fair setup) on Node 20 / V8 / x64. Even `lutMode:
  'float'` beats `lcms-wasm` on every workflow (1.28–1.96×).
- **Accuracy.** ≤ 1 LSB agreement on 98.51 – 100 % of samples across
  all four workflows against `lcms-wasm`. Max outlier is a 14 LSB
  CMYK → RGB gamut-clipping disagreement on 0.93 % of samples (out-
  of-gamut inputs where both CMS engines are "inventing" a legal RGB
  answer from an illegal CMYK request) — documented as a hypothesis
  in `README.md` and `docs/deepdive/Performance.md`.
- **Why pure-JS can beat a WASM-wasm32 port.** Detailed in
  `docs/deepdive/Performance.md` under "Why pure-JS can beat an Emscripten-
  wasm32 port": hand-tuned V8 kernels (TurboFan, monomorphic, L1i-
  resident), no JS↔WASM FFI per call, no WASM-sandbox bounds checks,
  and a bundle that's **~2.5× smaller over the wire** (~52 KB gzip
  for one file vs `lcms-wasm`'s ~129 KB gzip across a JS shim + a
  separate `.wasm` payload).
- **Roadmap implication.** The v1.3 WASM-scalar work is now framed as
  "overtake native vanilla lcms2", not "catch up to lcms-wasm".

### Added — `lutMode` option

```js
const t = new Transform({
    dataFormat: 'int8',     // image hot path (Uint8ClampedArray in/out)
    buildLut:   true,       // pre-build the LUT
    lutMode:    'int'       // 'float' (default) | 'int'
});                          // future: 'wasm-scalar' | 'wasm-simd' | 'auto'
t.create('*srgb', cmykProfile, eIntent.relative);
const out = t.transformArray(rgbBuf);
```

The string-enum API was chosen specifically so v1.2+ can add WASM
kernels without changing the constructor signature. Unknown values
(e.g. `lutMode: 'wasm-scalar'` against this version) fall through to
`'float'` rather than crashing — write the code now, get the speedup
when you upgrade.

### Added — `lutMode: 'int'` kernels (all four 3-/4-channel directions)

| Direction        | LUT shape | Kernel        | Speedup    | Max diff vs float |
|------------------|-----------|---------------|------------|-------------------|
| RGB → RGB / Lab  | 3D 3Ch    | integer       | ~1.05-1.15×| **0 LSB** (100 % exact) |
| RGB → CMYK       | 3D 4Ch    | integer       | ~1.04-1.1× | ≤ 1 LSB (u8)      |
| CMYK → RGB / Lab | 4D 3Ch    | integer (u20) | ~1.15-1.25×| ≤ 1 LSB (u8)      |
| CMYK → CMYK      | 4D 4Ch    | integer (u20) | ~1.05-1.15×| ≤ 1 LSB (u8)      |

The residual 1 LSB on the CMYK / non-identity directions is
banker's-rounding-vs-half-up disagreement at exact half-ties
(`Uint8ClampedArray` rounds 0.5 to even; the integer kernel rounds
half up). It is not accumulated interpolation error — the math is
otherwise match-to-u16-CLUT-exact.

4D directions beat 3D on speedup — the float K-LERP does more
redundant rounding work, so the integer kernel wins more there. Real
numbers from `bench/mpx_summary.js` (Node 20 / V8 / x64, GRACoL2006
ICC profile): RGB→RGB **72 MPx/s** (vs 69 float), RGB→CMYK **62
MPx/s** (vs 56 float), CMYK→RGB **59 MPx/s** (vs 51 float),
CMYK→CMYK **49 MPx/s** (vs 45 float). Exact throughput is engine-
and hardware-specific — see the "Speed" section in the README for
why these numbers drift between V8 / SpiderMonkey / JSC releases.

The "off by ≥16" regression indicator is 0 across all four directions
on 65k random pixels.

### Fixed — u16 CLUT scale (systematic +0.4 % high bias, CMYK→RGB)

`buildIntLut` was scaling the mirror CLUT by **65535** (`float × 65535`).
The kernels divide u16 back to u8 via `(u20 + 0x800) >> 12`, which is
effectively `u16 / 256` — but `65535 / 255 = 257`, not 256. So every
path through the integer kernel produced values ~0.4 % higher than
the float reference. On profiles where output lands on fractional u8
boundaries (most real CMYK→RGB conversions via GRACoL→sRGB) this
showed up as up to **75 % of channels off-by-1 with 100 % of errors
going `int > float`**.

**Fix**: scale by `65280 = 255 × 256` instead. Now `u16 / 256` gives
`u8` exactly for any value in the CLUT. No kernel changes, no perf
hit. Intermediate CLUT precision drops from 16.00 bits to 15.994 bits
— a 0.006-bit loss that's invisible at u8 output. See
`bench/diag_cmyk_to_rgb.js` for the diagnostic trail that tracked
this down.

### Fixed — Q0.16 `gridPointsScale_fixed` (remaining CMYK→RGB bias)

`gridPointsScale_fixed` was stored in Q0.8 (e.g. `32` for a 33-point
grid), but the *true* ratio is `32/255 × 256 = 32.125`. The 0.125
truncation meant every per-axis fractional weight (rx / ry / rz / rk)
was slightly *lower* than the float kernel's. On CMYK→RGB LUTs —
which are monotonically **decreasing** along CMY axes — a smaller rx
means less of the negative `(a - c0)` delta gets applied, so the int
output stays systematically higher than float. That accounted for the
*second* 99.9 % directional-bias wave after the 65280 fix.

**Fix**: promote `gridPointsScale_fixed` to **Q0.16** (e.g. `8224` for
a 33-point grid). Kernels extract `X0 = px >>> 16` and
`rx = (px >>> 8) & 0xFF` instead of `>>> 8` / `& 0xFF`. Overflow-safe:
`u8 × ~8224 ≈ 2 M`, well under i32. Combined with the CLUT-scale
fix this took CMYK→RGB from 26 % exact / 3 LSB max to **97.6 % exact
/ 1 LSB max** on real profiles.

### Added — LUT format tags (`dataType`) + `isIntLutCompatible()` helper

Both LUT variants now carry explicit format metadata under a common
field name so `console.log(transform.lut)` reveals exactly what kind
of bytes the CLUT holds:

```js
// Outer float LUT (produced by createLut)
lut = {
    dataType: 'f64',         // Float64Array CLUT, values in [0, 1]
    encoding: 'number',      // serialisation format (pre-existing — 'number' | 'base64')
    version: 1,              // pre-existing — outer LUT format version
    /* ...existing CLUT, chain, grid, precision, outputScale, etc. */
};

// Integer mirror LUT (produced by buildIntLut when lutMode: 'int')
lut.intLut = {
    version: 1,              // bump when ANY field below changes
    dataType: 'u16',         // Uint16Array CLUT (aligns with outer lut.dataType)
    scale: 65280,            // u16 value representing 1.0 (= 255 * 256)
    gpsPrecisionBits: 16,    // Q0.N precision of gridPointsScale_fixed
    accWidth: 16 | 20,       // accumulator width (20 for 4D single-rounding)
    /* ...existing CLUT, maxX/Y/Z/K, channel counts, etc. */
};
```

Note: the outer LUT's `encoding` field is **not** the data type — it's
a pre-existing serialisation-format flag (`'number' | 'base64'`) used
by `setLut()` when rehydrating a JSON-saved LUT. We deliberately did
not overload it. New LUT types (f32, f16, bf16, custom fixed-point)
should add themselves under `dataType`, not `encoding`.

Plus a new `Transform#isIntLutCompatible(intLut)` method that validates
the integer LUT tag against the current release's kernel contract.
The outer float LUT is not checked because the contract ("`Float64Array`
with values in [0, 1]") cannot drift without other code changes
catching it first.

**Why this exists today** (when nothing serialises `intLut` yet):

* `buildIntLut()` is the only producer in v1.1, so the tag is a
  no-op for the in-process path.
* BUT v1.2 will land WASM kernels that expect a **different** CLUT
  encoding (likely pre-biased for `+ 0x80` elimination — see
  "Candidate optimisation" above) and/or Q15.16 for SIMD.
* If any future code — custom cache, persisted pipeline, cross-version
  upgrade path, test fixture, user-supplied precomputed LUT — hands
  a foreign `intLut` to the kernels without checking, a silent wrong-
  pixel failure is both easy to cause and hideous to diagnose.
* Stamping the tag now (and writing tests that assert it) makes the
  contract explicit and means future-us pays ~zero cost to add a
  compatibility check at any deserialization boundary.

The array dispatcher (`transformArrayViaLUT`) calls
`isIntLutCompatible()` **once per array call** (not per pixel) and
**throws** on mismatch. The cost is amortised to zero against the hot
loop. Silent fallback was explicitly rejected: if the integer kernel
runs against a CLUT whose scale or gps-precision disagrees with its
hardcoded shift/bias constants, the output looks plausible but carries
an elevated LSB error rate that is almost impossible to spot without a
pixel-level diff against the float path — the worst possible failure
mode in a colour pipeline. Loud throw beats silent drift.

This guardrail is also the safety net for anyone calling
`transformArrayViaLUT` directly with a hand-built or cached `intLut`.

### Design policy — float OR u16 only (never u15 / u24 / etc)

Going forward, the LUT representation is either **Float64Array**
(full precision, `lutMode: 'float'`) or **Uint16Array** (integer hot
path, `lutMode: 'int'`). We deliberately won't add intermediate
widths like u15 (which was briefly considered to avoid u16 overflow
in interp). Reasons:

* WASM (v1.2+), Web Workers, and any future GPU path can all consume
  float64 or u16 directly — no data rewrite at the backend boundary.
* We always need a JS fallback. If the fallback stores a u15 LUT
  that no other backend understands natively, every transition costs
  a conversion pass.
* u15 buys ~1 bit of kernel headroom but costs API clarity forever.

The u16 scale is `255 × 256 = 65280` (see "Fixed — u16 CLUT scale"
above) specifically so the u8-output round-trip is exact with no
extra math in the kernel. For v1.2's u16 **output** we'll revisit —
either widen the CLUT build to full 65535 for that path or accept
the 0.4 % range loss. Decision deferred to v1.2.

### Added — 4D u20 single-rounding kernels (CMYK input, accuracy refactor)

The original 4D integer kernels had four stacked `>> 8` rounding steps
(K0 plane, K1 plane, K-LERP, final u8) and were drifting up to 3 LSB
vs the float reference on CMYK→CMYK.

The 4D kernels now carry intermediate interpolated values at **u20
(Q16.4) precision** — 4 extra fractional bits above the u16 CLUT —
which collapses the three inner rounding steps into one final `>>20`
operation. The math is inlined (no `sum` temp) to keep the JIT from
spilling intermediates:

```js
// u20 intermediate, inner rounding is negligible (1/4096 LSB of u8):
o0 = (c0 << 4) + ((imul(a - c0, rx) + imul(b - a, ry) + imul(d - b, rz) + 0x08) >> 4);
// Final: K1 plane interp inlined into K-LERP, one meaningful rounding:
output = ((o0 << 8) + imul(((k0 << 4) + ((inner_K1 + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
```

Why u20 and not u22/u24: the K-LERP `imul(K1 - o0, rk)` would overflow
signed int32 at those widths. u20 leaves ~2 bits of headroom below
2^31 while still giving 16× the inner-rounding resolution of the old
`>> 8` path.

**Accuracy impact** (measured on GRACoL2006, 65k random pixels;
numbers are after the u20 refactor AND the u16-CLUT-scale / Q0.16 gps
fixes above — the three together are what got us to bit-near-exact):

- CMYK → CMYK: was 55 % exact / 3 LSB max → now **99.74 % exact / 1
  LSB max** (zero channels off by ≥2).
- CMYK → RGB: was 26 % exact / 3 LSB max → now **99.63 % exact / 1
  LSB max** (zero channels off by ≥2).

**Bonus**: also fixed a pre-existing rounding-bias bug in the
degenerate `rx==ry==rz` K-LERP branch (`+0x80` was wrong for `>> 16`;
correct bias is `+0x8000`). Contributed a ≤1 LSB drift on pixels that
landed on the diagonal.

3D kernels are untouched — they already had a single inner rounding
step and ≤2 LSB accuracy budget.

The integer path also uses **4× less LUT memory** (Uint16Array instead
of Float64Array), which matters more for 4D LUTs (a typical CMYK→CMYK
LUT drops from 2.6 MB to 650 KB).

NOT recommended for color-measurement workflows (delta-E vs reference
patches). For that, use `lutMode: 'float'` (the default).

### Added — implementation pieces

- `Transform.buildIntLut(lut)` — builder method called automatically
  from `create()` when `lutMode: 'int'` AND `dataFormat: 'int8'`.
  Mirrors the float CLUT into a `Uint16Array`, computes Q0.8 grid
  scale and per-axis maxima (including `maxK` for the K-axis boundary
  patch). No-ops silently on unsupported shapes (1D / 2D / 5+ output
  channels), so enabling `lutMode: 'int'` globally is always safe.
- `tetrahedralInterp3DArray_3Ch_intLut_loop` — integer sibling of the
  float 3D 3Ch kernel. RGB→RGB / RGB→Lab. Reads from u16 LUT, uses
  `Math.imul` + Q0.8 weights. u8 in, u8 out.
- `tetrahedralInterp3DArray_4Ch_intLut_loop` — same for RGB→CMYK.
- `tetrahedralInterp4DArray_3Ch_intLut_loop` — 4D variant for CMYK→RGB
  and CMYK→Lab. Uses u20 Q16.4 intermediate with single-step final
  rounding (see "4D u20 single-rounding kernels" above). Includes
  K-axis early-out (`rk === 0` or `inputK === 255`) and full C/M/Y/K
  boundary patches.
- `tetrahedralInterp4DArray_4Ch_intLut_loop` — same u20 design for
  CMYK→CMYK.
- `__tests__/transform_lutMode.tests.js` — 8 tests covering all four
  directions, `lutMode` option parsing, and alpha preservation in both
  3D and 4D kernels.
- `bench/fastLUT_real_world.js` — real-world bench asserting the
  integer kernel as active for all four directions with the GRACoL2006
  ICC profile.

### Internal — dispatcher

`transformArrayViaLUT` now has `lutMode === 'int' && lut.intLut`
branches for **both** the 3D (3Ch input) and 4D (4Ch input) switches.
Each branch falls through to the existing float kernel for unsupported
output channel counts (5+) so the API surface is forgiving — adding
new profile types won't crash, they just use the float path.

### Documentation

- `docs/deepdive/Performance.md` — full performance findings, lcms2/babl
  comparison, WASM POC results, roadmap rationale. Explains JIT-driven
  engine variance (V8 vs SpiderMonkey vs JSC) and why the hot loops
  are deliberately unrolled and inlined despite looking counter-intuitive.
- `bench/wasm_poc/` — runnable proof-of-concept comparing JS vs WASM
  scalar vs WASM SIMD for a 1D linear interpolation kernel. Drives the
  v1.3/v1.4 roadmap.
- README: new "How it works" note on the unrolled-and-inlined
  interpolator design + JIT-variance caveat on the speed numbers.

---

## [1.0.5] — 2026-04

A documentation + correctness pass across the codebase, plus packaging
fixes that resolve every open issue on the GitHub tracker. No public API
changes; all fixes are backwards compatible.

### GitHub issues addressed

- **Closes [#1](https://github.com/glennwilton/jsColorEngine/issues/1)** —
  documented `buildLut` (was silently dropped due to a `builtLut` typo,
  now aliased — see "`{ buildLut: true }` was silently dropped" below)
  and added a runnable canvas round-trip example in the README that
  shows the missing `ctx.createImageData()` + `data.set()` step that
  tripped the original reporter.
- **Closes [#2](https://github.com/glennwilton/jsColorEngine/issues/2)** —
  `ReferenceError: self is not defined` when `require('jscolorengine')`
  in Node. Two fixes layered for safety:
    1. The package's `main` field now points at the raw CommonJS source
       (`src/main.js`) instead of the webpacked UMD bundle, so Node
       consumers skip the bundle entirely.
    2. The webpack UMD wrapper itself is now Node-safe via
       `output.globalObject: "typeof self !== 'undefined' ? self : this"`
       (Webpack 5's default of `'self'` was the original cause).
  Anyone who was previously deep-importing `'jscolorengine/build/jsColorEngine.js'`
  to dodge this can stop doing that — both paths work.
- **Closes [#3](https://github.com/glennwilton/jsColorEngine/issues/3)** —
  "How do I use it in Angular?" Same root cause as #2 (Angular's SSR /
  zone.js builds were hitting the bundle's `self` reference). With #2
  fixed, the package now imports cleanly under Angular, Next.js, Vite,
  Webpack, and any other modern bundler. Added a "Bundlers" section to
  the README confirming this and explaining why the `browser` field's
  `fs`/`path`/`util` stubs are still needed.
- **Closes [#4](https://github.com/glennwilton/jsColorEngine/issues/4)
  and [#5](https://github.com/glennwilton/jsColorEngine/issues/5)** —
  `jsColorEngine.color is undefined`. The `color` alias for the
  `convert` module was added to source on 2024-01-13, but only made it
  into the published `1.0.4` bundle (the day after) — versions
  `1.0.0`–`1.0.3` shipped without it, so any user who installed during
  the first week saw the README example fail. Added a "Compatibility
  note for old installs" section to the README pointing affected users
  at either `npm i jscolorengine@latest` or the original
  `jsColorEngine.convert.Lab(...)` spelling.

### Fixed

#### Packaging

- **`main` repointed from `build/jsColorEngine.js` to `src/main.js`.**
  The bundle existed primarily for browser drop-in via `<script>`; using
  it as the Node entry was the source of issue #2. Tests, docs, and
  internal `require()`s already used `src/`, so this is a no-op for
  every internal call site.
- **Webpack UMD wrapper made Node-safe** with `output.globalObject:
  "typeof self !== 'undefined' ? self : this"`. The bundle in `build/`
  is now usable from Node, web workers, classic browser globals, and
  AMD loaders (the bundle previously crashed in any non-`self` host).
  See [issue #2](https://github.com/glennwilton/jsColorEngine/issues/2).

#### `src/Transform.js`

#### `src/Transform.js`

- **`preserveAlpha` was broken in RGB→RGB / RGB→Lab LUT image transforms.**
  In the inlined `tetrahedralInterp3DArray_3Ch_loop` kernel (3D LUT,
  3-channel input → 3-channel output — used for sRGB→sRGB soft-proof
  chains, abstract Lab transforms, gamut mapping, etc.), the
  `if (preserveAlpha) { ... }` block sat *outside* the per-pixel `for`
  loop instead of inside it. Result: alpha was handled exactly **once**
  at the end of the run. For any input with more than one pixel, alpha
  was never preserved and the output channel writes drifted by one byte
  per pixel. All other inlined kernels (1Ch, 2Ch, 3Ch→4Ch, 4Ch→3Ch,
  4Ch→4Ch, NCh variants) had the block correctly inside the loop and
  were unaffected. Fix: move the block inside the `for`.
- **`{ buildLut: true }` was silently dropped.** The constructor JSDoc
  documents `buildLut` as the option name (with `builtLut` as a "legacy
  spelling"), but the constructor only ever read `options.builtLut`.
  Anyone copy-pasting from the JSDoc got no LUT and silently fell back
  to the slow per-pixel path. The constructor now accepts both spellings
  and normalises to `this.builtLut` internally.

### Changed

#### `src/Transform.js`

- **`precision` is now the canonical Transform constructor option name**,
  with the long-standing typo `precession` kept as a backwards-compatible
  alias. The constructor accepts either spelling (with `precision`
  winning if both are passed), and both `transform.precision` and
  `transform.precession` are populated for read so existing code keeps
  working unchanged. Internal call sites (`getLut(precision)`, the
  `stage_device_to_*_round(device, precision)` helpers, and
  `convert.cmsColor2String(color, precision)`) have all been renamed to
  use `precision` for clarity. The `precession` JSDoc is now marked
  `@deprecated`.

#### `src/Loader.js`

- **`Loader.get(key)` was completely broken on the lazy path.** The
  function called `this.loadProfileIndex(key)` — passing the string
  `key` to a method that expects a numeric **index** into
  `this.profiles`. Result: every `get()` of a profile registered with
  `preload: false` threw `TypeError: Cannot read properties of undefined
  (reading 'profile')`. The `get()` flow now finds the registry index
  by key first, then calls `loadProfileIndex(index)` correctly.
- **`Loader.get(key)` of an unregistered key crashed.** It called
  `findByKey(key)`, which returns `false` on miss, then read `.loaded`
  on `false` — `TypeError: Cannot read properties of false`. Now throws
  an explicit `Loader.get: no profile registered under key 'X'` error.

#### `src/Profile.js`

- **XHR error & timeout handlers were never invoked.** `XHRLoadBinary` was
  assigning to `xhr.timeout` and `xhr.error` instead of `xhr.ontimeout` and
  `xhr.onerror`. Network failures and timeouts were silently swallowed,
  and the `onComplete` callback never fired — callers hung indefinitely.
  As a side effect, assigning a function to `xhr.timeout` (which is the
  numeric timeout duration) coerced it to `NaN` and disabled timeouts
  entirely.
- **`readBinaryFile` threw on success in Adobe CEP.** The CEP branch
  decoded the file successfully but then fell through to the
  "unsupported environment" check at the end of the function and threw.
  CEP file reads now return the decoded `Uint8Array` immediately on
  success.
- **Property name typos** (`unsuportedTags`, `virutalProfileUsesD50AdaptedPrimaries`)
  are now dual-aliased to correctly-spelled siblings (`unsupportedTags`,
  `virtualProfileUsesD50AdaptedPrimaries`). Existing code keeps working;
  new code can use the correct names. The typo'd names are marked
  `@deprecated` in JSDoc so IDEs surface a warning.

#### `src/decodeICC.js`

- **Parametric curve type 3 returned NaN.** The `para` tag handler for
  function type 3 (the IEC 61966-2.1 / sRGB curve, 5 parameters) was
  reading `params[5]` and `params[6]`, which don't exist for this type.
  Output was `NaN`. Logic now follows the ICC spec for type 3 and uses
  only `params[0..4]`. This was the cause of bad sRGB ICC decode in
  certain profile flavours.
- **`curv` midpoint gamma estimate could be NaN.** The midpoint sample
  was indexed as `curve.data[curve.count / 2]`. For odd `count` (most
  in-the-wild curves, e.g. 257 entries) this is a fractional index and
  returned `undefined`, producing `NaN`. Now `Math.floor(curve.count / 2)`.
- **Unsupported LUT types silently produced unusable LUTs.** The `lut`
  function's default branch fell through to stride-multiplier code that
  read from an empty `gridPoints` array, producing `NaN` strides. Now
  returns a structurally valid 2×2×2 zero sentinel LUT with
  `lut.invalid = true` and `lut.errorReason` set, plus a `console.warn`.
  Downstream code no longer crashes on bad input; it sees a black 2×2×2
  CLUT and an explicit "this LUT failed to decode" flag.
- **Diagnostic messages upgraded** from `console.log` to `console.warn`
  for unknown text types, parametric curve types, LUT types, and MPE
  elements — these messages signal degraded behaviour and belong in the
  warn channel.

#### `src/convert.js`

- **`Lab2RGB` returned greyscale.** Copy-paste error: all three output
  channels were sourcing from `RGBDevice[0]` instead of `[0]`, `[1]`, `[2]`.
- **`RGB2Lab` chromatically adapted twice.** The function called
  `RGBf2XYZ` (which already applies chromatic adaptation to the requested
  Lab whitepoint internally) and then ran an extra adaptation step on the
  result. The second adaptation has been removed.

### Changed

#### `src/convert.js`

- **`Y = 1.0` whitepoint convention is now an enforced invariant.** All
  bundled illuminants in `def.illuminant.*` use `Y = 1.0` by design.
  Several functions had `* whitePoint.Y` or `/ whitePoint.Y` operations
  that were no-ops under this invariant. They've been removed (in
  `XYZ2Lab`, `Lab2XYZ`, `RGBDevice2LabD50`, `adaptation`) with inline
  comments explaining why, so future edits don't "fix" the optimisation.
- **`BradfordMtxAdapt` and `BradfordMtxAdaptInv` are now `Object.freeze`-d**
  to prevent accidental mutation of the shared chromatic-adaptation
  matrices. New zero-cost getters `getBradfordMtxAdapt()` and
  `getBradfordMtxAdaptInv()` return references to the same frozen arrays
  for ergonomic call-sites that prefer functions over property access.
- **`Lab2sRGB` documented as display-only.** Its existing behaviour is
  unchanged — it deliberately skips chromatic adaptation and ICC profile
  consultation in favour of speed for screen approximation. JSDoc now
  makes this clear so it doesn't get "fixed" with a slow accurate path.

### Documentation

- **`/docs/*.md` revised** to match the in-source JSDoc and current API.
  `Profile.md` now leads with the virtual-vs-ICC framing, includes a
  runnable example, and flags the deprecated typo'd property names.
  `Transform.md` now leads with the two-tier accuracy/hot mental model,
  documents both `buildLut` / `builtLut` spellings, fixes the missing
  `BPC` per-stage array form, and includes runnable accuracy + hot
  examples. `Loader.md` clarifies that the loader is optional.
- **Misread-prone name cluster.** Several "typo'd vs correct" property
  and option names exist in the codebase, all aliased for backwards
  compatibility — easy to skim and miss. Documented all four in one
  place in `Transform.md` / `Profile.md`:
    - `builtLut` (legacy) ↔ `buildLut` (canonical) — Transform option
    - `precession` (legacy) ↔ `precision` (canonical) — Transform option
    - `unsuportedTags` (legacy) ↔ `unsupportedTags` (canonical) — Profile property
    - `virutalProfileUsesD50AdaptedPrimaries` (legacy) ↔
      `virtualProfileUsesD50AdaptedPrimaries` (canonical) — Profile property
- **File-top primers** added or rewritten for `Transform.js`, `Spectral.js`,
  `convert.js`, `decodeICC.js`, `Loader.js`, `Profile.js`. Each explains
  purpose, scope, conventions, known limitations, and (where relevant)
  the accuracy-vs-speed positioning of the module.
- **Section dividers and per-function JSDoc** filled in across the
  affected files. All public methods now document parameters, returns,
  whitepoint conventions, and any non-obvious behaviour.
- **`Profile.js` virtual-vs-ICC explanation** added in the file primer:
  for matrix-shaper RGB profiles there's no functional difference between
  loading the ICC and using the virtual equivalent; the engine
  auto-promotes matrix RGB ICCs to the same fast path.
- **`decodeICC.js` ICC v4 coverage notes** clarified — most v4 profiles
  in practice use the same v2-compatible tag set, so v4 support is good
  in real-world use even though `mpet` is not implemented.

### Tests

- New regression tests in `__tests__/decodeICC.smoke.js` covering the
  parametric type 3 fix, the `curv` odd-count fix, and the unsupported
  LUT sentinel behaviour.
- New regression tests in `__tests__/transform_lut_3ch_alpha.tests.js`
  covering: per-pixel alpha preservation in multi-pixel sRGB→CMYK→sRGB
  soft-proof chains, sRGB→Lab via LUT, the `outputHasAlpha` (no input
  alpha) write-255 case, and both `buildLut` / `builtLut` constructor
  spellings.
- New regression tests in `__tests__/loader.tests.js` covering the
  Loader L1 (lazy `get()` index/key bug) and L2 (unregistered key
  crash) fixes, plus basic `add` / `findByKey` / `loadAll` behaviour.
- New tests in `__tests__/transform_virtual.tests.js` locking in the
  `precision` / `precession` option-name aliasing — both spellings
  produce identical output, both `transform.precision` and
  `transform.precession` are populated, and `precision` wins if both
  are passed.

---

## [1.0.4] — Previous release

Baseline release on npm. See git history for details.
