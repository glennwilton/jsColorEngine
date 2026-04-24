# LUT modes

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
[Architecture](./Architecture.md) ·
[JIT inspection](./JitInspection.md) ·
[WASM kernels](./WasmKernels.md)

---

When the image hot-path is active (`buildLut: true, dataFormat: 'int8'`),
the `lutMode` constructor option picks which inner-loop kernel runs. Five
values ship, four kernels plus the dispatcher:

```
   'auto'  ──►  int-wasm-simd  ──►  int-wasm-scalar  ──►  int  ──►  float
   (v1.2         (channel-SIMD)      (hand-written wasm)  (JS int32)   (JS f64)
   default)            │                    │                │           │
                       │   demotes if no    │  demotes if no │           └── default for
                       │   v128 support     │  WebAssembly   │               non-int8 / no-LUT
                       └────────────────────┴────────────────┴────── one hot kernel always picked
```

All four runtime kernels produce bit-identical output for 8-bit input
within their respective kernel families. The SIMD and scalar WASM kernels
are verified bit-exact against the JS `'int'` reference across a 12-config
matrix in [`bench/wasm_poc/`](../../bench/wasm_poc).

## How `lutMode` is chosen

`lutMode` is set at `new Transform({...})` time. Since v1.2 the default is
`'auto'`, which resolves at construction time to the best applicable
kernel:

- `dataFormat: 'int8'` + `buildLut: true` → `'int-wasm-simd'`
- anything else → `'float'` (lutMode is ignored for non-int8 dataFormats
  anyway; resolving to `'float'` makes `xform.lutMode` self-documenting)

After construction, `create()` validates the resolved kernel against the
specific LUT shape this profile chain ends up with, and **silently demotes**
down the chain if the requested kernel can't service that shape. You can
inspect `transform.lutMode` after `create()` to see which kernel was
actually picked.

Demotion rules:

| From | To | When |
|---|---|---|
| `'int-wasm-simd'` | `'int-wasm-scalar'` | Host has WASM but not v128 (very old Safari, Node < 16.4, restricted sandboxes) |
| `'int-wasm-simd'` | `'int-wasm-scalar'` | LUT has output channel count outside `{3, 4}` |
| `'int-wasm-scalar'` | `'int'` | Host has no WebAssembly at all |
| `'int-wasm-scalar'` | `'int'` | 4D LUT, v1.2 early snapshot — *(4D WASM is now shipped, so this path no longer triggers)* |
| `'int'` | `'float'` | LUT has 1 input channel (1D), 2 output channels, or 5+ output channels |
| any | `'float'` | `dataFormat ≠ 'int8'` — integer kernels require u8 input |

The intent is "ask for the fastest and let the engine demote if it can't
deliver". `'auto'` codifies this as the out-of-the-box default — pre-v1.2
users had to write `lutMode: 'int-wasm-simd'` explicitly; since v1.2 just
doing `new Transform({ buildLut: true, dataFormat: 'int8' })` gets you the
same behaviour.

## `'float'` — the baseline

The original floating-point kernels. Bit-stable across releases, always
available. Was the default pre-v1.2; since v1.2 the default is `'auto'`
(which resolves to `'float'` when no integer kernel is applicable, so
this is still what runs for non-int8 transforms).

- **CLUT storage:** `Float64Array`, 8 bytes per entry
- **Per-pixel math:** f64 tetrahedral interpolation, no quantisation beyond
  the grid
- **Where the code lives:** the `*_loop` family in
  [`src/Transform.js`](../../src/Transform.js) — fully unrolled per channel
  count (3Ch, 4Ch, NCh)
- **Output:** matches running the full f64 pipeline directly to within LUT
  grid quantisation (typically ≪ 1 dE)

Pick `'float'` when:

- You need bit-stable output that doesn't move across releases
- Your LUT shape is unusual (1D/2D/5+ channel) — you'd get demoted here
  anyway
- You're comparing transformed pixels to measured reference targets
  (colour-measurement workflows) and can't accept the ≤ 1 LSB rounding
  drift of the integer kernels at half-way-to-even ties

## `'int'` — the integer hot path

Added in v1.1. Rebuilds the CLUT as a `Uint16Array`, runs the inner loop
with `Math.imul` and integer shifts.

```js
const t = new Transform({
    dataFormat: 'int8',
    buildLut:   true,
    lutMode:    'int'
});
t.create('*srgb', cmykProfile, eIntent.relative);
const out = t.transformArray(rgbBuf);
```

### What it actually does

1. **Rebuilds the float CLUT as a `Uint16Array`**, scaled by
   `255 × 256 = 65280` (not 65535). That scaling is deliberate:
   `u16 / 256 = u8` exactly, so the final shift from accumulator back to
   output byte is a plain `>> 8` with no off-by-one drift.
2. **Uses Q0.16 `gridPointsScale_fixed`** to preserve the true
   `(g1-1)/255` ratio through `rx` / `ry` / `rz` / `rk` — carrying at
   Q0.8 introduces 0.3 – 0.5 LSB drift, Q0.16 is clean.
3. **Runs the inner loop with `Math.imul` and bit shifts** throughout.
   All intermediates stay in V8's Smi (small-integer) representation — no
   HeapNumber boxing, no allocations in the hot loop.
4. **Folds the final `>> 8` or `>> 20`** to convert the internal Q0.16 or
   Q16.4 accumulator back to u8 output.

### Why u20 Q16.4 for the 4D kernels

The 4D (CMYK input) kernels interpolate in two stages: first across X/Y/Z
for a fixed K-plane, then across K. Naive integer implementation rounds
three times (K0 plane, K1 plane, K-LERP), accumulating ~0.7 LSB of drift.
The 4D kernels carry intermediate values at **u20 Q16.4 precision** so all
three rounding steps collapse into one final `>> 20`. That's what drops
the residual error to ≤ 1 LSB and is also what makes the 4D directions
*beat* the 3D directions on `int`-vs-`float` speedup — the float kernel
does all that redundant rounding work every pixel.

### Measured throughput (Node 20 / V8 / x64, GRACoL2006)

| Direction | `'int'` | `'float'` baseline | Speedup | Accuracy vs float |
|---|---|---|---|---|
| RGB → RGB / Lab (3D 3Ch) | 72.1 MPx/s | 69.0 MPx/s | 1.04× | **100 % exact** |
| RGB → CMYK (3D 4Ch) | 62.1 MPx/s | 56.1 MPx/s | 1.11× | ≤ 1 LSB on u8 |
| CMYK → RGB / Lab (4D 3Ch) | 59.1 MPx/s | 50.8 MPx/s | 1.16× | ≤ 1 LSB on u8 |
| CMYK → CMYK (4D 4Ch) | 48.8 MPx/s | 44.7 MPx/s | 1.09× | ≤ 1 LSB on u8 |

From `bench/mpx_summary.js` on Node 20 / V8 / x64 using the GRACoL2006 ICC
profile. Expect absolute numbers to shift on other engines/machines — the
[browser bench](../../bench/browser/) measures in-browser and reports live
numbers with a copy-to-markdown export.

### Where the 10–15 % comes from in production

1. **u16 LUT is 4× smaller than `Float64Array`.** At 33×33×33×4 channels
   the float LUT is 1.13 MB; the u16 LUT is 287 KB. Modern CPUs have
   ~256 KB L2 per core, so the integer LUT *just* fits where the float
   LUT spills to L3.
2. **`Math.imul` + bit shifts stay Smi-tagged.** V8 stores small integers
   inline in pointers; floats produce HeapNumber boxes when they escape
   registers. Tight integer loops keep everything in Smi-land and avoid
   per-pixel heap traffic.
3. **Fewer rounding paths.** Float → u8 has to clamp + round at the store;
   the Q0.8 path produces u8 directly via `(acc + 0x80) >> 8`.

### Accuracy: why ≤ 1 LSB and not 0

The u16 interpolation is mathematically exact. The residual 1 LSB drift
on the non-RGB→RGB directions is `Uint8ClampedArray`'s banker's-rounding
(round-half-to-even) disagreeing with the integer kernel's round-half-up
at exact `X.5` boundaries. It's not accumulated math error — it's a
rounding-mode mismatch at half-ties. You'd see the same drift wiring a
native integer kernel's output through `Uint8ClampedArray`.

If you need bit-exact reference output for delta-E measurement against
measured patches, use `'float'` explicitly. For all other u8 image work,
the drift is well below the perceptual threshold (LCh space typically
~0.3 dE at 1 LSB, well under the ~1.5 dE "just noticeable" threshold).

## `'int-wasm-scalar'` — the same math, in WASM

Added in v1.2. Runs the same integer kernel as `'int'` but compiled to
WebAssembly. Avg 1.40× over `'int'` on 3D tetrahedral workloads (range
1.37–1.45×); 1.22× on 4D.

- **`.wat` source:** [`src/wasm/tetra3d_nch.wat`](../../src/wasm/tetra3d_nch.wat)
  (3D), [`src/wasm/tetra4d_nch.wat`](../../src/wasm/tetra4d_nch.wat) (4D)
- **Inlined bytes:** [`src/wasm/tetra3d_nch.wasm.js`](../../src/wasm/tetra3d_nch.wasm.js),
  [`src/wasm/tetra4d_nch.wasm.js`](../../src/wasm/tetra4d_nch.wasm.js) —
  base64-inlined so there's no xhr/fetch, no bundler configuration
- **Loader:** [`src/wasm/wasm_loader.js`](../../src/wasm/wasm_loader.js) —
  synchronous `WebAssembly.Module(bytes)` + `Instance`, optional shared
  compiled-module cache via `wasmCache`

### Why WASM beats JS for this loop

The JS `'int'` kernel is already near the TurboFan ceiling for
integer-heavy code (see [JIT inspection](./JitInspection.md) for the
emitted x64 walkthrough). The 1.40× headroom over it comes from two
sources that are free in WASM and unavoidable in JS:

1. **Wrapping `i32` math is the spec default.** No `jo` (jump-on-overflow)
   guards around `Math.imul` results; no deoptimisation risk if an
   intermediate would have overflowed a Smi. JIT inspection showed
   `jo`-class instructions were ~8 % of the JS hot loop.
2. **Linear memory uses guard pages for bounds safety.** No `cmp` / `jae`
   pairs around typed-array accesses. JIT inspection showed bounds-check
   pairs were ~7 % of the JS hot loop.

That's ~15 % of pure overhead going away before any algorithmic
difference. The rest comes from tighter codegen on WASM — V8's WASM
baseline tier produces very clean register-pinned x64 from a straight-
line `.wat` function.

See [WASM kernels](./WasmKernels.md) for the kernel layout, the pointer-
math discipline that keeps the hot loop at zero-allocation, and the
function-call lesson (inlining is harder to trust in WASM than JS — the
scalar 4D needed to be written as a single flat function, not split into
"setup + interp" helpers).

## `'int-wasm-simd'` — channel-parallel SIMD

Added in v1.2. Channel-parallel WebAssembly SIMD kernel. Avg 3.25×
over `'int'` (range 2.94–3.50×) on 3D; 2.39× on 4D.

- **`.wat` source:** [`src/wasm/tetra3d_simd.wat`](../../src/wasm/tetra3d_simd.wat)
  (3D), [`src/wasm/tetra4d_simd.wat`](../../src/wasm/tetra4d_simd.wat) (4D)
- **Channel layout:** one v128 lane per output channel, with 4 unused
  lanes for 3-channel output (the tetrahedral math is cheap enough that
  leaving a lane idle still wins on wall-clock)
- **Supported output channel counts:** 3 and 4 only. Other cMax values
  demote to `'int-wasm-scalar'`.

### The channel-parallel design in one paragraph

SIMD across *pixels* doesn't help LUT interpolation — each pixel's
tetrahedron corners are at different grid coordinates, so the LUT gather
degenerates to four scalar loads with the results packed into a v128
(sequential dependency chain, lots of lane-shuffling). The
[Performance page](../Performance.md) has the original 1D POC that showed
this ceiling (**SIMD with LUT gather: 0.89× — actually slower than
scalar**). What *does* work is SIMD across *channels*: the four output
channels of one pixel can be computed as four lanes of one v128, because
they all share the same tetrahedron corners and weights — the lookup
tables that differ per channel are simply the four consecutive u16 values
at each corner. See [WASM kernels](./WasmKernels.md) for the detailed
walkthrough and `.wat` layout.

### Why the 4D SIMD win is smaller than 3D

3D SIMD is 3.25× avg; 4D SIMD is 2.39× avg. The difference is
single-pixel work:

- In 3D, the tetrahedron has 4 corners × 3 ops each ≈ 12 arithmetic ops
  per pixel. SIMD collapses the 3- or 4-channel output math into ~3
  v128 ops.
- In 4D, the per-pixel work is ~24 ops (two 3D interps + K-LERP). SIMD
  collapses the same 3- or 4-channel output math into ~6 v128 ops.

In both cases SIMD lanes parallelise the 3–4 output channels, but more of
4D's wall-clock goes to serial setup (K-plane base offset, interpK flag
check, K-LERP combine) that doesn't vectorise. Hoisting the C/M/Y-only
setup out to the pixel loop and keeping the K0 intermediate in a single
v128 register across the K-plane back-edge were the two design choices
that lifted 4D SIMD from break-even to 2.39×.

## When to pick which

| Scenario | Recommendation |
|---|---|
| Single colour (picker, swatch) | `buildLut: false`, float accuracy path. `lutMode` doesn't apply. |
| < 100 colours (palette) | Same — f64 pipeline with `buildLut: false`. |
| 100 – 10 k colours (chart, batch) | `buildLut: true, dataFormat: 'int8'`. Default `'auto'` will pick the WASM SIMD kernel. |
| Image work (any size) | Default `'auto'` — picks `'int-wasm-simd'` and the dispatcher demotes on hosts that can't run it. |
| Real-time video / 4K+ frames | Default — `'int-wasm-simd'` via `'auto'`, 3.0–3.5× over `'int'` on 3D, 2.1–2.6× on 4D. |
| Colour measurement (dE vs target) | Pin `lutMode: 'float'` or set `buildLut: false`. The integer kernels' ≤ 1 LSB drift can shift dE decisions at margins. |

Since v1.2, `lutMode` defaults to `'auto'` — `dataFormat: 'int8'` +
`buildLut: true` transparently gets the SIMD kernel, everything else
stays on `'float'`. Pre-v1.2 the default was `'float'`; upgrading gives
int8+LUT transforms a free speedup with no API change. Pin an explicit
value (`'float'`, `'int'`, `'int-wasm-scalar'`, `'int-wasm-simd'`) when
you want determinism — e.g. CI benchmarks that need a fixed kernel, or
colour-measurement code that must run the float path.

## Related

- [Architecture](./Architecture.md) — how the LUT and kernel slot into the
  pipeline
- [JIT inspection](./JitInspection.md) — why the JS `'int'` kernel is
  already near the TurboFan ceiling
- [WASM kernels](./WasmKernels.md) — the hand-written `.wat` design
  for scalar and SIMD
- [Performance](../Performance.md) — full numbers across kernels and
  configurations
