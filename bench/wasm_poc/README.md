# WASM Proof of Concept — 1D LERP

This folder contains a small, self-contained WebAssembly proof of
concept comparing four implementations of the **same** 1D LERP-through-
u16-LUT kernel:

1. **JS plain** — idiomatic JavaScript reference
2. **JS Math.imul** — JavaScript with explicit integer multiply
3. **WASM scalar** — hand-written `.wat`, scalar code path
4. **WASM SIMD (gather)** — `.wat` using `v128.i32x4`, lane-by-lane LUT gather
5. **WASM SIMD (no LUT, pure math)** — control kernel showing the SIMD ceiling

Plus a separate "no LUT" SIMD kernel (`vectorMul`) as a control, to
show what WASM SIMD can do when there's no gather.

## Why this kernel?

The kernel is the same math jsColorEngine's v1.1 `lutMode: 'int'` does on
each axis, simplified to 1D:

```
val = input[i]
fp  = val * 32                     ; Q0.8 grid position
idx = fp >> 8                      ; integer grid index [0..31]
w   = fp & 0xFF                    ; Q0.8 fractional weight [0..255]
lo  = lut[idx]                     ; u16
hi  = lut[idx + 1]                 ; u16
u16 = lo + (((hi - lo) * w + 0x80) >> 8)
u8  = (u16 + 0x80) >> 8
```

Plus a boundary patch when `val == 255` (same trick as the production
fastLUT — see FINDING #4 in `bench/int_vs_float.js`).

If WASM scalar can beat JS *here*, it should also beat JS for the full
3D tetrahedral kernel. If WASM SIMD can't help *here* (because of the
LUT gather), it won't help the 3D kernel either (which needs 8
gathers per pixel instead of 2).

## How to run

```bash
node bench/wasm_poc/run.js
```

Requires the `wabt` dev dependency (added at the project root). It
compiles the `.wat` files to `.wasm` at startup using a pure-JS
WebAssembly Binary Toolkit, so there's no C/Rust toolchain required.

## Results (Node 20, 1 Mi pixels per pass)

```
Kernel                     Batch ms     MPx/s     vs JS plain
-------------------------- ----------  --------  ------------
JS plain                     282.03 ms    371.8     1.00×
JS Math.imul                 279.07 ms    375.7     1.01×
WASM scalar                  153.35 ms    683.8     1.84×
WASM SIMD (gather)           172.95 ms    606.3     1.63×
WASM SIMD (no LUT)             4.16 ms  25180.1    67.72×
```

All four kernels are **bit-exact** against each other (max diff = 0
across 1 Mi pixels). So the comparison is fair.

## Findings

### 1. WASM scalar IS faster than JS for this kernel — 1.84×

This was the biggest surprise. V8 already does an excellent job
JIT-compiling tight integer loops with `Math.imul`, so we expected
maybe 1.0–1.2×. Instead WASM scalar nearly doubled JS throughput.

Why? Some plausible reasons:

- **No bounds checks on typed array access.** V8 has to either
  prove statically that an index is in-bounds (rare in real code) or
  emit a runtime check. WASM linear memory has zero bounds checks
  on individual loads — the entire memory page is one contiguous
  region.
- **Stable register allocation across the loop.** WASM has explicit
  locals; V8 has to do escape analysis to keep JS variables in
  registers, which is harder when the loop body is non-trivial.
- **No deoptimisation triggers.** JS code can de-opt if a hidden
  class changes; WASM can't de-opt at all.
- **Tighter machine code.** wabt + V8's WASM backend (Liftoff →
  TurboFan) seems to produce denser code than V8's JIT for the same
  algorithm.

`Math.imul` did **not** help in JS — V8 figures out the integer
multiply on its own. The plain JS version is within 1% of the
`Math.imul` version.

### 2. WASM SIMD with LUT gather is *slower* than WASM scalar (0.89×)

This was the second surprise. SIMD processes 4 pixels per iteration
in parallel, but the 8 lane-by-lane gathers (4 lanes × `lo` + `hi`)
plus the lane-extract / lane-replace overhead exceeds the
parallelism win.

WASM SIMD has no native gather instruction. Each lane's LUT load is:

1. `i32x4.extract_lane <i>` — pull the index out of the SIMD register
2. `i32.shl` — convert to byte offset
3. `i32.load16_u` — scalar load
4. `i32x4.replace_lane <i>` — put result back into SIMD register

For a 4-lane LUT lookup, that's 4× steps 1-4, twice (for `lo` and
`hi`). All those lane-extract / lane-replace ops cross the
SIMD↔scalar register boundary, which is expensive.

**This is the key finding for color management on WASM SIMD:**
LUT-heavy kernels don't vectorise well in pure WASM SIMD. The
fastest 4-pixel kernel in the standard SIMD spec is to just *not*
use SIMD for the gather-heavy bits.

### 3. WASM SIMD pure math is genuinely 67× faster

The `vectorMul_simd` control kernel (multiply 16 u8 bytes by a
scalar, shift down) shows what WASM SIMD does when the algorithm
fits its strengths:

- 16 bytes loaded per iteration with `v128.load`
- 8 lanes processed in parallel via `i16x8.mul`
- 16 bytes stored per iteration with `v128.store` + saturating narrow

No gather, no scatter, no per-lane juggling. 67× over JS.

This is the upper bound on what WASM SIMD can do for color math
kernels that *don't* need LUT lookups (e.g. matrix multiply, gamma
power-function approximation, channel reordering, RGB↔YUV).

### 4. Implications for jsColorEngine

Concrete decisions falling out of this POC:

| Question | Answer |
|---|---|
| Should we port the fastLUT 1D shaper curves to WASM scalar? | **Yes — 1.84× is real win.** Low complexity, separate small kernel. |
| Should we port the 3D tetrahedral kernel to WASM SIMD? | **No** — needs 8 gathers per pixel; pure WASM SIMD can't help. |
| Should we port the 3D tetrahedral kernel to WASM scalar? | **Maybe.** Likely 1.5–2× win like the 1D case, but the kernel is large (~300 lines of `.wat`). Trade-off: maintenance burden vs. performance. |
| Should we use WASM SIMD for matrix-shaper RGB transforms? | **Yes — could approach the 67× ceiling.** No gather, just matrix multiplies and gamma curves. |
| Should we ship Web Workers first or WASM first? | **Web Workers first.** Linear scaling with core count, much smaller code change, and works alongside WASM in v1.4+. |

### 5. Hidden-cost note: WASM compile time and module size

- `linear_lerp.wat` (227 lines of source) compiles to **227 bytes** of `.wasm`.
- `linear_lerp_simd.wat` (~200 lines of source) compiles to **761 bytes**.
- wabt compile time is ~5 ms each.
- `WebAssembly.instantiate` is < 1 ms.

The runtime overhead of using WASM is essentially zero. The cost is
in **author time** (writing `.wat` is slow) and **build complexity**
(toolchain, separate bundle, etc).

### 6. The "Math.imul vs plain `*`" question, settled

For tight integer loops in V8 (Node 20+, modern Chrome), `Math.imul`
gives **no measurable benefit** over plain `*`. V8's optimiser
recognises 32-bit integer multiplies and emits the same machine code.

The historical guidance "use `Math.imul` for guaranteed 32-bit math"
is still correct as **insurance** against accidental float promotion,
but it's not a performance optimisation in modern V8.

## Future POC extensions

If you want to push this further, in roughly increasing complexity:

1. **WASM scalar 3D tetrahedral kernel** — ~300 lines of hand-written
   `.wat`, mirrors `tetrahedralInterp3DArray_3Ch_fastLUT_loop`.
   Expected: 1.5–2× over the JS fastLUT path.

2. **AssemblyScript port** — same algorithm, but in TypeScript-
   flavoured source. Easier to maintain than `.wat`. Adds ~10 KB
   runtime. Recommended path for any kernel > ~50 lines of `.wat`.

3. **WASM SIMD matrix-shaper kernel** — for matrix RGB → matrix RGB
   transforms (sRGB → AdobeRGB, etc). No LUT; pure math. Should
   approach the 67× SIMD ceiling.

4. **Web Worker pool around the WASM kernel** — multi-core SIMD on
   matrix-shaper transforms could realistically be 200–400× faster
   than current single-threaded JS.

5. **Relaxed-SIMD `i8x16.swizzle`** for very small LUTs (≤16 entries).
   Some color operations (saturation curves, posterise) fit this.

## Files

- `linear_lerp.wat` — scalar WASM kernel (227 B compiled)
- `linear_lerp_simd.wat` — SIMD WASM kernels — `applyCurve_simd` (gather) and `vectorMul_simd` (no gather, control) (761 B compiled)
- `run.js` — bench harness; compiles `.wat` at startup, runs all kernels, reports speedup + bit-exactness
- `README.md` — this file
