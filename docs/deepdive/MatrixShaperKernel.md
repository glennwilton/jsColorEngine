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

> **Status: POC complete — v1.7 planned.**
> `bench/matrix_shaper_poc/bench_matrix_shaper.js` runs today.
> Production integration follows the kernel module architecture described in
> [Kernel modules](./KernelModules.md).

---

## The problem with routing matrix-shaper through a 3D CLUT

Every RGB matrix-shaper transform (sRGB→AdobeRGB, sRGB→ProPhoto, display
calibration profiles…) currently goes through a 33³ CLUT baked at `create()`
time. That path is correct and fast — 88 MPx/s with WASM SIMD on the dev
machine. But it carries unnecessary cost:

- **Build time.** 35 937 CLUT cells, each requiring a full f64 pipeline walk.
- **Memory.** ~214 KB of u16 CLUT per transform instance.
- **Interpolation error.** Tetrahedral interp on a 33³ grid introduces ≤ 1 LSB
  quantisation, not zero.

A matrix-shaper transform is pure arithmetic: gamma inverse → 3×3 matrix →
gamma forward. No CLUT lookup, no interpolation error, no build cost.
With the two 3×3 matrices fused into one at `create()` time — eliminating the
XYZ intermediate step — the whole transform is 9 f32 multiplications and
2 × 3 LUT reads per pixel. That should be much faster than tetrahedral CLUT
interpolation.

---

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
