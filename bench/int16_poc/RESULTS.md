# int16 POC — first numbers

**Status: POC validated.** New u16 in / u16 out JS hot kernel sits at
**1.80–1.97× faster than lcms-wasm's u16 path** on the two tested
workflows, with **100 % of samples within 1 LSB at u8-equivalent
precision** vs the lcms-wasm `cmsFLAGS_HIGHRESPRECALC` u16 oracle.
Bit-parity with the existing `'int'` u8 kernel confirmed (max 1 LSB
diff after `int16 >> 8` shift). Ready to land in `Transform.js` as
`lutMode: 'int16'` + `dataFormat: 'int16'`.

## Bench config

- Hardware: same Node 20 / V8 / x64 dev box used for the existing
  `bench/lcms-comparison/` numbers
- Pixel count: 65,536 (256×256) per iter
- Warmup: 300 iters → median of 5 × 100 timed iters
- Profile: `GRACoL2006_Coated1v2.icc`
- Intent: Relative colorimetric
- Both engines: u16 in / u16 out

## Speed

| Workflow             | jsCE `int` u8 baseline | jsCE int16 POC    | lcms-wasm u16 best   | jsCE int16 / lcms |
|---|---:|---:|---:|---:|
| RGB → Lab (sRGB → LabD50)    | 64.0 MPx/s | **74.6 MPx/s** | 37.8 MPx/s | **1.97×** |
| RGB → CMYK (sRGB → GRACoL)   | 53.3 MPx/s | **65.6 MPx/s** | 36.5 MPx/s | **1.80×** |

The int16 kernel is also **1.16–1.23× faster than the existing int8
kernel**, which is unexpected at first glance — the int16 POC bypasses
the `transformArray()` wrapper (alpha handling, format detection,
bounds-checked `Uint8ClampedArray` writes) and dispatches the kernel
directly, while the int8 row above goes through the full v1.2 dispatch
path. When int16 lands in `Transform.js` it'll pay the same wrapper
tax and converge with the int8 numbers — call it ~60–65 MPx/s once
integrated. Still 1.65–1.80× over lcms-wasm u16.

## Accuracy

vs lcms-wasm `cmsFLAGS_HIGHRESPRECALC` u16, full 65,536-pixel sample.

| Workflow             | max \|Δ\| u16 | =LSB at u8 | mean u16 | within 1 LSB u16 | within 1 LSB u8 (256 LSB u16) |
|---|---:|---:|---:|---:|---:|
| RGB → Lab    | 14   | 0.055 | 0.86 | 85.19 % | **100.00 %** |
| RGB → CMYK   | 254  | 0.992 | 5.53 | 46.82 % | **100.00 %** |

Both worst cases are **under 1 LSB at u8-equivalent precision** — i.e.
no worse than the existing `int` u8 path's accuracy vs lcms-wasm. The
int16 kernel adds 8 bits of dynamic range without losing any precision
the engine had at u8.

The 254 LSB max on RGB → CMYK is the same kind of grid-quantisation
boundary case the existing u8 path produces, just expressed at u16
precision. CMYK destination LUTs have steeper gradients than Lab
destinations, so they consistently produce wider per-channel deltas
in any LUT-based engine.

## Kernel parity sanity

```
SANITY: int8 output vs (int16 >> 8) max diff: 1 LSB at u8  ✓ kernel parity confirmed
```

The int16 kernel is the existing int8 kernel's i32 ALU verbatim, with:

- **Input**: `Uint16Array` (0..65535) instead of `Uint8ClampedArray`
- **gps**: `round((g1 - 1) << 16 / 65535)` instead of `round((g1-1) << 16 / 255)`.
  For `g1=33` this is `32` (was `8224` for u8). `Math.imul(input_u16, gps_u16)`
  produces a value with the grid index in the upper 16 bits and Q0.8 frac
  in bits 8..15 — same shape as the u8 kernel's `px`.
- **Output**: bit-trick `v + (v >>> 8)` for the canonical [0, 65280] → [0, 65535]
  expansion, exploiting `255 × 257 = 65535`. Bit-exact for our cell scale
  (CLUT cells are u16 in [0, 65280]).
- **Everything else identical**: same i32 cell math, same Q0.8 frac weights,
  same input==max boundary patch, same six-tetra cascade.

This is why it stays within 1 LSB of the u8 path under shift-down
testing: same arithmetic, wider boundary handling.

## Accuracy ceiling — where this POC stops

The POC keeps the u8 path's **Q0.8 frac** (only 8 of the 16 bits of
the input fractional weight actually weight the interpolation). That's
enough for u16-faithful round-tripping (no loss vs u8 in *or* out)
but does NOT improve precision *between* grid points beyond what the
u8 kernel achieves.

True Q0.16 frac would need wider arithmetic — `Math.imul(cell_delta,
rx_full)` overflows i32 because `±65280 × 65535 ≈ 4.3 × 10⁹`. Two
candidate paths for v1.3.x:

1. **Split-imul**: compute the i17 × i16 multiply in two i32 parts,
   `dt * (rx >> 8) << 8 + dt * (rx & 0xFF)`, recombine. Adds 1 imul +
   1 shift + 1 add per channel per cube edge. Probably ~10 % slower
   than the POC, gains ~0.5 LSB u16 mean accuracy on grid-frac-heavy
   inputs.
2. **Float intermediate**: drop into f64 just for the mul-accumulate,
   convert back to int. ~25 % slower in our prior testing (see
   `bench/int_vs_float.js`), but no correctness footwork.

We'll bench both and pick the winner once `lutMode: 'int16'` is in
the engine and the lcms_compat harness can validate accuracy at u16
precision against the float oracle.

## Coverage in this POC

- ✅ 3D LUT, 3-ch in → 3-ch out (RGB → Lab, RGB → RGB)
- ✅ 3D LUT, 3-ch in → 4-ch out (RGB → CMYK)
- ⏸ 4D LUT (CMYK input) — kernel throws "not implemented" today.
  Adds in the v1.3.x merge into `Transform.js` (same shape as the
  3D kernels, plus the K-axis interp).
- ⏸ Alpha handling — POC kernel does input/output channels only.
  The Transform.js merge will pick up the existing alpha shape from
  the int8 kernel (`preserveAlpha`, `inputHasAlpha`, `outputHasAlpha`).

## Reproduction

```bash
cd bench/int16_poc
npm install       # fetches lcms-wasm
node bench_int16_vs_lcmswasm.js
```

`lcms-wasm` is gitignored / installed on demand exactly as in
`bench/lcms-comparison/`. The POC kernel is inlined in
`bench_int16_vs_lcmswasm.js` so this folder is fully self-contained
until v1.3.x lands the kernel inside `src/Transform.js`.

## Next steps (v1.3.x)

1. Port `tetra3D_3ch_u16_loop` and `tetra3D_4ch_u16_loop` into
   `src/Transform.js` as `tetrahedralInterp3DArray_3Ch_intLut16_loop`
   / `_4Ch_intLut16_loop`.
2. Add the 4D analogues (`tetrahedralInterp4DArray_3Ch_intLut16_loop` /
   `_4Ch_intLut16_loop`) — same shape, plus K-axis interp from the
   existing 4D u8 kernel.
3. Wire `lutMode: 'int16'` into the constructor parser and
   `transformArrayViaLUT()` dispatch. `dataFormat: 'int16'` already
   has the enum slot — just needs to actually allocate `Uint16Array`
   on the input/output paths.
4. Add an `'auto'` heuristic: if `dataFormat: 'int16'` AND `buildLut:
   true`, resolve `lutMode` to `'int16'` (mirrors the existing
   `int8` → `int-wasm-simd` resolution).
5. Re-run `bench/lcms_compat/run.js` against the new path with
   `dataFormat: 'objectFloat'` outputs cross-checked against u16
   integer outputs to confirm the integer kernel matches the float
   path within the ceiling determined here.
6. v1.3.x WASM scalar + SIMD u16 kernels — the existing
   `src/wasm/tetra3d.wat` is u8 in / u8 out; u16 versions are mostly
   load/store changes (i32.load16_u + i32.store16) on top of the
   existing math.
