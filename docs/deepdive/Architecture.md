# Architecture

**jsColorEngine docs:**
[← Project README](../../README.md) ·
[Bench](../Bench.md) ·
[Performance](../Performance.md) ·
[Roadmap](../Roadmap.md) ·
[Examples](../Examples.md) ·
[API: Profile](../Profile.md) ·
[Transform](../Transform.md) ·
[Loader](../Loader.md)

**Deep Dive:**
[← Index](./README.md) ·
[LUT modes](./LutModes.md) ·
[JIT inspection](./JitInspection.md) ·
[WASM kernels](./WasmKernels.md)

---

## The `Transform` is the engine

Everything jsColorEngine does is built around one class:
[`Transform`](../../src/Transform.js). You give it a source profile and a
destination profile (plus a rendering intent, optional custom stages, and some
flags) and it assembles an optimised pipeline between them. Once built, the
pipeline converts one colour at a time — or a whole image — as fast as the
host JavaScript engine will let us.

```
   srcProfile ──┐
                │   new Transform({...}).create(src, dst, intent)
   dstProfile ──┤   ──────────────────────────────────────────────►  [pipeline]
                │                                                    ~μs/call accuracy
   intent ──────┘                                                    ~MPx/s image
```

There are two very different execution paths a `Transform` can take once it's
built — `transform()` for one colour at a time, and `transformArray()` for
bulk pixel data — and picking the right one is the single biggest performance
lever in the library. We'll walk through both.

## The pipeline model

A pipeline is an ordered list of **stages**. Each stage is a small function
that takes the previous stage's output and applies one well-defined
transformation: decode a tone-reproduction curve, multiply by a 3×3 matrix,
interpolate a LUT, encode back out to a device space, and so on. For a
typical RGB → CMYK conversion the pipeline might look like:

```
  input: int8 RGB       (raw bytes, 0..255 per channel)
   └─► decode TRC          ← sRGB curves, RGB to linear light
   └─► matrix + CAT        ← 3x3 to PCS XYZ, chromatic adaptation if needed
   └─► XYZ → Lab           ← PCS normalisation
   └─► Lab → CMYK (LUT)    ← BToA tag, 4-input tetrahedral interp
   └─► encode output       ← u8 clamp + pack
  output: int8 CMYK
```

Stages are stored as small tagged records — input encoding, function,
output encoding, state bag — and the pipeline carries them in order. The
build-time [pipeline optimiser](../../src/Transform.js) inspects adjacent
stage pairs and collapses redundancy: encode-then-decode of the same curve
becomes a no-op and is deleted, PCS-version conversions that cancel out
are dropped, matrix + matrix pairs could be premultiplied (future work).

### Two principles that drive the design

1. **Building is offline. Execution is hot.** Pipeline construction runs
   once per `create()` call — its speed doesn't matter. Pipeline execution
   runs per pixel. Its speed is everything. The implementation aggressively
   trades build-time cost for per-pixel speed: baking LUTs, unrolling
   interpolators, compiling WASM modules, pre-computing constants.

2. **Accuracy path and image path are different code.** A 32×32 colour-picker
   swatch has hundreds of pixels, each rendered exactly once, and wants the
   last 0.05 dE of accuracy. A 4 K image has 8 million pixels, all rendered
   the same way, and wants every extra fixed-point saturation instruction
   the JIT can give us. Jamming those two workloads through the same hot
   loop would either cripple the fast path (allocations per pixel, dispatch
   per stage) or wreck the accuracy path (LUT quantisation when you don't
   want it). So we split them.

## Two paths, two APIs

| | Accuracy path | Image path |
|---|---|---|
| **API** | `transform.transform(obj)` / `transformArray(objs)` with `dataFormat: 'object'` or `'objectFloat'` | `transform.transformArray(typedArray, ...)` with `dataFormat: 'int8'` and `buildLut: true` |
| **Per pixel** | Walks the *entire* pipeline, stage by stage, in f64 | Single n-D LUT interpolation |
| **Typical cost** | ~µs/pixel (micro seconds) | ~ns/pixel (nano seconds) |
| **Allocations** | One small object per pixel, fine for thousands | Zero in the hot loop (typed arrays, pre-baked LUT) |
| **Accuracy** | Full f64, bit-for-bit deterministic | LUT-quantised (typically ≪ 1 dE from the float path on u8 output) |
| **When to use** | Colour pickers, dE calculators, swatch libraries, prepress analysis | Images, video frames, canvas, batch ICC conversion |

These are selected at construction time via `dataFormat` and `buildLut`. You
do not switch between them at run time — pick at `create()` and stick with it.

### Anti-pattern: the accuracy path on image data

```js
// DON'T do this.
for (let i = 0; i < pixelCount; i++) {
    out[i] = transform.transform(pixels[i]);
}
```

That call bypasses the LUT entirely, allocates ~6 arrays per pixel, and
dispatches every stage via `.call(this, ...)`. On a 4 MP image you're
roughly 30× slower than `transformArrayViaLUT` and you will GC-thrash
the host. The accuracy path is correct; it is not a fast loop. If you
have > ~10 k pixels, always set `{ buildLut: true, dataFormat: 'int8' }`
and call `transformArray`.

## LUT pre-baking — what it is, what it costs

For the image path, `{ buildLut: true }` asks the engine to collapse the
entire pipeline into a single lookup table at `create()` time. The LUT is
an N-dimensional grid:

- **1D** (for 1-channel inputs — greyscale) — 256-point typical
- **3D** (for RGB input) — 33×33×33 typical, 49³ possible at
  `lutGridPoints3D: 49`
- **4D** (for CMYK input) — 17⁴ typical, 33⁴ possible at
  `lutGridPoints4D: 33`

Each grid cell stores the output of the full pipeline at that input
coordinate. At run time we find the enclosing tetrahedron, fetch its
corners, and do a barycentric blend. This is ~10-100 ops depending on
input dimensionality, versus 100-1000+ for walking the full pipeline.

The cost of pre-baking is paid once in `create()` — typically 2-20 ms for
3D, 10-30 ms for 4D, depending on grid size and host. That's a fair
trade on any workload bigger than a few thousand pixels.

### Interpolation — tetrahedral, always

The image path uses tetrahedral interpolation regardless of input
channel count. For 3 channels it splits the enclosing cube into 6
tetrahedra based on the input weights; for 4 channels it splits the
hypercube into 24. The tetrahedral scheme is both *faster* and *more
accurate* than trilinear for device-space LUTs — fewer grid fetches,
no "stripe" artefacts at the cube boundaries. LittleCMS uses the same
scheme for the same reasons; see the
[lessons from reading lcms2's `cmsintrp.c`](../Performance.md) section
in the Performance doc.

(The one exception: for 3-channel PCS-to-device LUTs, `addStageLUT()`
automatically falls back to trilinear. That matches LittleCMS,
Photoshop, and SampleICC behaviour for compatibility with profile
manufacturers' expectations on those specific tags. Set
`interpolation3D: 'tetrahedral'` in the constructor to override.)

## Kernel dispatch — `lutMode`

When the image path is active, the inner loop is selected by `lutMode`.
Each mode trades safety, accuracy, and speed differently. All four
produce bit-identical output for 8-bit input within their respective
kernel families (verified across a 6-configuration matrix in
[`bench/wasm_poc/`](../../bench/wasm_poc)).

| `lutMode` | CLUT storage | Math | Where the code lives |
|---|---|---|---|
| `'float'` (default) | `Float64Array` | f64 tetrahedral interp | [`src/Transform.js`](../../src/Transform.js) `*_loop` functions |
| `'int'` | `Uint16Array` (Q0.16) | int32 via `Math.imul` | [`src/Transform.js`](../../src/Transform.js), same unrolled shape as float |
| `'int-wasm-scalar'` | `Uint16Array` | int32 in WASM | [`src/wasm/tetra3d_nch.wat`](../../src/wasm/tetra3d_nch.wat), [`tetra4d_nch.wat`](../../src/wasm/tetra4d_nch.wat) |
| `'int-wasm-simd'` | `Uint16Array` | v128 SIMD in WASM | [`src/wasm/tetra3d_simd.wat`](../../src/wasm/tetra3d_simd.wat), [`tetra4d_simd.wat`](../../src/wasm/tetra4d_simd.wat) |

Each mode silently falls back to the previous one if it can't service the
LUT shape (e.g. SIMD kernels only support 3- and 4-channel output) or if
the host lacks the required capability (no WASM → demote to `'int'`, no
v128 → demote to `'int-wasm-scalar'`). The selected kernel is reported in
`transform.lutMode` after `create()`.

For the *why* of each mode's performance characteristic, see the separate
[LUT modes](./LutModes.md) page.

## The comment block in Transform.js you should actually read

Near the top of [`src/Transform.js`](../../src/Transform.js) there's a 200-line
header block with the authoritative usage guide, dataformat reference, and
performance caveats — written for the person who's about to modify the hot
loop. It's the closest thing this library has to a design doc. If you're
here because you're considering a PR against the kernel, read that before
you touch anything.

Key callouts from that header that matter architecturally:

- **Pipeline construction runs once per `create()` — its speed is
  irrelevant. Pipeline EXECUTION is per pixel — its speed is critical.**
- **The hot-path interpolators look weird on purpose.** Long inline
  arithmetic, duplicated code paths, very few helpers or named temps.
  The JIT compilers inline aggressively and reuse registers across folded
  expressions; introducing a helper call or a named temp can force a
  memory round-trip that measurably slows the loop. Don't "tidy" them
  without re-benchmarking. The [JIT inspection](./JitInspection.md) page
  walks you through the V8 assembly that justifies this.
- **Bounds checks are deliberately omitted** in the inner loops. Passing
  out-of-range or wrong-length input is undefined behaviour (garbage out,
  no exception). Validation belongs at the API boundary, not the hot
  loop.
- **Custom stages** are baked *into* the LUT when `buildLut: true`, so
  per-pixel custom effects cost zero at run time. That's the recommended
  way to apply per-image effects (ink limiting, saturation tweaks,
  greyscale conversion) without sacrificing LUT-path speed.

## Related

- [LUT modes](./LutModes.md) — what each `lutMode` actually does at the
  instruction level
- [JIT inspection](./JitInspection.md) — why the scalar JS kernel hits the
  speeds it does
- [WASM kernels](./WasmKernels.md) — how the `.wat` files are laid out
  and the SIMD channel-parallel design
- [Performance](../Performance.md) — measured numbers across modes
- [API: Transform](../Transform.md) — the constructor options reference
