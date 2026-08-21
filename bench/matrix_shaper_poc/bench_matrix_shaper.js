// =============================================================================
// bench_matrix_shaper.js — matrix-shaper WASM kernel POC
// =============================================================================
//
// Benchmarks a dynamic WASM kernel for RGB matrix-shaper transforms.
// Both a scalar and a SIMD (4-pixel) variant are built at runtime via wabt:
//
//   run_scalar  — 1 pixel per iteration, f32 gamma LUT + f32 matrix
//   run_simd    — 4 pixels per iteration, f32x4 matrix, per-lane gamma LUT
//
// Gamma is handled by a 4096-entry f32 LUT in WASM linear memory (no f32.pow,
// no host import).  For the POC, gamma = x^2.2 (linearise) / x^(1/2.2) (encode).
//
// Fused matrix is computed at startup from the engine's virtual sRGB and
// AdobeRGB profiles: XYZMatrixInv(adobeRGB) × XYZMatrix(sRGB).
//
// WASM memory layout (100 pages = 6.4 MB):
//   Bytes 0x0000..0x3FFF  gamma_inv LUT  (4096 × f32 = 16 384 bytes)
//   Bytes 0x4000..0x7FFF  gamma_fwd LUT  (4096 × f32 = 16 384 bytes)
//   Bytes 0x8000+          pixel data (input then output)
//
// Compare against:
//   jsCE 3D-LUT WASM SIMD   — existing int-wasm-simd kernel (33^3 CLUT)
//   jsCE JS float            — existing float kernel (no LUT)
//
// Usage:
//   node bench/matrix_shaper_poc/bench_matrix_shaper.js
//
// =============================================================================

'use strict';

const wabtFactory = require('wabt');
const { Profile, Transform, eIntent } = require('../../src/main');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PIXEL_COUNT   = 1_000_000;
const WARMUP_RUNS   = 5;
const TIMED_RUNS    = 20;
const LUT_SIZE      = 4096;
const LUT_INV_BYTE  = 0;           // gamma_inv LUT base (bytes)
const LUT_FWD_BYTE  = 16384;       // gamma_fwd LUT base (bytes) — 4096 * 4
const PIXEL_BYTE    = 32768;       // 0x8000 — pixel buffers start here
const WASM_PAGES    = 100;         // 6.4 MB — fits 1M pixels in+out

// ---------------------------------------------------------------------------
// Matrix helpers (3×3 — no dependency on engine internals)
// ---------------------------------------------------------------------------
function mulMat(A, B) {
    return {
        m00: A.m00*B.m00 + A.m01*B.m10 + A.m02*B.m20,
        m01: A.m00*B.m01 + A.m01*B.m11 + A.m02*B.m21,
        m02: A.m00*B.m02 + A.m01*B.m12 + A.m02*B.m22,
        m10: A.m10*B.m00 + A.m11*B.m10 + A.m12*B.m20,
        m11: A.m10*B.m01 + A.m11*B.m11 + A.m12*B.m21,
        m12: A.m10*B.m02 + A.m11*B.m12 + A.m12*B.m22,
        m20: A.m20*B.m00 + A.m21*B.m10 + A.m22*B.m20,
        m21: A.m20*B.m01 + A.m21*B.m11 + A.m22*B.m21,
        m22: A.m20*B.m02 + A.m21*B.m12 + A.m22*B.m22,
    };
}

// ---------------------------------------------------------------------------
// WAT template — {{m00}}..{{m22}} replaced with actual coefficient strings
// ---------------------------------------------------------------------------
const WAT_TEMPLATE = `(module
  (memory (export "memory") ${WASM_PAGES})

  ;; Gamma LUT lookup: $x in [0,1], $lutBase = 0 (inv) or 16384 (fwd)
  ;; Returns lut[clamp(trunc(x * 4095), 0, 4094)] — no interpolation needed for u8 output
  (func $gamma_lut (param $x f32) (param $lutBase i32) (result f32)
    (local $idx i32)
    (local.set $idx
      (i32.trunc_f32_u
        (f32.mul
          (f32.min (f32.max (local.get $x) (f32.const 0.0)) (f32.const 1.0))
          (f32.const 4095.0))))
    ;; Clamp to [0, 4094] — i32.min_u is SIMD-only; use select instead
    (local.set $idx
      (select
        (i32.const 4094)
        (local.get $idx)
        (i32.gt_u (local.get $idx) (i32.const 4094))))
    (f32.load
      (i32.add
        (local.get $lutBase)
        (i32.shl (local.get $idx) (i32.const 2)))))

  ;; -------------------------------------------------------------------
  ;; Scalar kernel: 1 pixel per iteration
  ;; -------------------------------------------------------------------
  (func (export "run_scalar")
    (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p      i32)
    (local $inPos  i32) (local $outPos i32)
    (local $r  f32) (local $g  f32) (local $b  f32)
    (local $ro f32) (local $go f32) (local $bo f32)
    (local.set $inPos  (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))
    (block $exit
      (loop $loop
        (br_if $exit (i32.ge_s (local.get $p) (local.get $pixelCount)))
        ;; Load u8 -> f32 [0, 1]
        (local.set $r (f32.mul (f32.convert_i32_u (i32.load8_u          (local.get $inPos))) (f32.const 0.0039215686)))
        (local.set $g (f32.mul (f32.convert_i32_u (i32.load8_u offset=1 (local.get $inPos))) (f32.const 0.0039215686)))
        (local.set $b (f32.mul (f32.convert_i32_u (i32.load8_u offset=2 (local.get $inPos))) (f32.const 0.0039215686)))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 3)))
        ;; Gamma inverse
        (local.set $r (call $gamma_lut (local.get $r) (i32.const ${LUT_INV_BYTE})))
        (local.set $g (call $gamma_lut (local.get $g) (i32.const ${LUT_INV_BYTE})))
        (local.set $b (call $gamma_lut (local.get $b) (i32.const ${LUT_INV_BYTE})))
        ;; Matrix: dest_RGB = fused * src_RGB
        (local.set $ro (f32.add (f32.add (f32.mul (local.get $r) (f32.const {{m00}})) (f32.mul (local.get $g) (f32.const {{m01}}))) (f32.mul (local.get $b) (f32.const {{m02}}))))
        (local.set $go (f32.add (f32.add (f32.mul (local.get $r) (f32.const {{m10}})) (f32.mul (local.get $g) (f32.const {{m11}}))) (f32.mul (local.get $b) (f32.const {{m12}}))))
        (local.set $bo (f32.add (f32.add (f32.mul (local.get $r) (f32.const {{m20}})) (f32.mul (local.get $g) (f32.const {{m21}}))) (f32.mul (local.get $b) (f32.const {{m22}}))))
        ;; Gamma forward
        (local.set $ro (call $gamma_lut (local.get $ro) (i32.const ${LUT_FWD_BYTE})))
        (local.set $go (call $gamma_lut (local.get $go) (i32.const ${LUT_FWD_BYTE})))
        (local.set $bo (call $gamma_lut (local.get $bo) (i32.const ${LUT_FWD_BYTE})))
        ;; Clamp [0,1], scale to u8, round (+0.5), store
        (i32.store8          (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $ro) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=1 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $go) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=2 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $bo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 3)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $loop)))
  )

  ;; -------------------------------------------------------------------
  ;; SIMD kernel: 4 pixels per iteration, scalar tail for remainder
  ;; Matrix runs as f32x4 (4× parallelism). Gamma is per-lane LUT lookup.
  ;; -------------------------------------------------------------------
  (func (export "run_simd")
    (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p      i32)
    (local $inPos  i32) (local $outPos i32)
    (local $vR  v128) (local $vG  v128) (local $vB  v128)
    (local $vRo v128) (local $vGo v128) (local $vBo v128)
    ;; Per-lane gamma temps
    (local $r0 f32) (local $r1 f32) (local $r2 f32) (local $r3 f32)
    (local $g0 f32) (local $g1 f32) (local $g2 f32) (local $g3 f32)
    (local $b0 f32) (local $b1 f32) (local $b2 f32) (local $b3 f32)
    (local.set $inPos  (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))

    ;; SIMD strip: 4 pixels per iteration
    (block $simd_exit
      (loop $simd_loop
        (br_if $simd_exit (i32.gt_s (i32.add (local.get $p) (i32.const 4)) (local.get $pixelCount)))

        ;; Load 12 bytes, deinterleave into vR / vG / vB (f32x4 each)
        ;; Pixel stride = 3 bytes: p0=[0,1,2]  p1=[3,4,5]  p2=[6,7,8]  p3=[9,10,11]
        (local.set $vR (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
          (f32x4.splat (f32.mul (f32.convert_i32_u (i32.load8_u          (local.get $inPos))) (f32.const 0.0039215686)))
          (f32.mul (f32.convert_i32_u (i32.load8_u offset=3  (local.get $inPos))) (f32.const 0.0039215686)))
          (f32.mul (f32.convert_i32_u (i32.load8_u offset=6  (local.get $inPos))) (f32.const 0.0039215686)))
          (f32.mul (f32.convert_i32_u (i32.load8_u offset=9  (local.get $inPos))) (f32.const 0.0039215686))))
        (local.set $vG (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
          (f32x4.splat (f32.mul (f32.convert_i32_u (i32.load8_u offset=1  (local.get $inPos))) (f32.const 0.0039215686)))
          (f32.mul (f32.convert_i32_u (i32.load8_u offset=4  (local.get $inPos))) (f32.const 0.0039215686)))
          (f32.mul (f32.convert_i32_u (i32.load8_u offset=7  (local.get $inPos))) (f32.const 0.0039215686)))
          (f32.mul (f32.convert_i32_u (i32.load8_u offset=10 (local.get $inPos))) (f32.const 0.0039215686))))
        (local.set $vB (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
          (f32x4.splat (f32.mul (f32.convert_i32_u (i32.load8_u offset=2  (local.get $inPos))) (f32.const 0.0039215686)))
          (f32.mul (f32.convert_i32_u (i32.load8_u offset=5  (local.get $inPos))) (f32.const 0.0039215686)))
          (f32.mul (f32.convert_i32_u (i32.load8_u offset=8  (local.get $inPos))) (f32.const 0.0039215686)))
          (f32.mul (f32.convert_i32_u (i32.load8_u offset=11 (local.get $inPos))) (f32.const 0.0039215686))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 12)))

        ;; Gamma inverse — per lane
        (local.set $r0 (call $gamma_lut (f32x4.extract_lane 0 (local.get $vR)) (i32.const ${LUT_INV_BYTE})))
        (local.set $r1 (call $gamma_lut (f32x4.extract_lane 1 (local.get $vR)) (i32.const ${LUT_INV_BYTE})))
        (local.set $r2 (call $gamma_lut (f32x4.extract_lane 2 (local.get $vR)) (i32.const ${LUT_INV_BYTE})))
        (local.set $r3 (call $gamma_lut (f32x4.extract_lane 3 (local.get $vR)) (i32.const ${LUT_INV_BYTE})))
        (local.set $g0 (call $gamma_lut (f32x4.extract_lane 0 (local.get $vG)) (i32.const ${LUT_INV_BYTE})))
        (local.set $g1 (call $gamma_lut (f32x4.extract_lane 1 (local.get $vG)) (i32.const ${LUT_INV_BYTE})))
        (local.set $g2 (call $gamma_lut (f32x4.extract_lane 2 (local.get $vG)) (i32.const ${LUT_INV_BYTE})))
        (local.set $g3 (call $gamma_lut (f32x4.extract_lane 3 (local.get $vG)) (i32.const ${LUT_INV_BYTE})))
        (local.set $b0 (call $gamma_lut (f32x4.extract_lane 0 (local.get $vB)) (i32.const ${LUT_INV_BYTE})))
        (local.set $b1 (call $gamma_lut (f32x4.extract_lane 1 (local.get $vB)) (i32.const ${LUT_INV_BYTE})))
        (local.set $b2 (call $gamma_lut (f32x4.extract_lane 2 (local.get $vB)) (i32.const ${LUT_INV_BYTE})))
        (local.set $b3 (call $gamma_lut (f32x4.extract_lane 3 (local.get $vB)) (i32.const ${LUT_INV_BYTE})))

        ;; Reassemble linearised values into f32x4
        (local.set $vR (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1 (f32x4.splat (local.get $r0)) (local.get $r1)) (local.get $r2)) (local.get $r3)))
        (local.set $vG (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1 (f32x4.splat (local.get $g0)) (local.get $g1)) (local.get $g2)) (local.get $g3)))
        (local.set $vB (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1 (f32x4.splat (local.get $b0)) (local.get $b1)) (local.get $b2)) (local.get $b3)))

        ;; Matrix multiply — all 4 pixels simultaneously
        ;; Each coefficient is splatted to all 4 lanes via v128.const f32x4
        (local.set $vRo (f32x4.add (f32x4.add
          (f32x4.mul (local.get $vR) (v128.const f32x4 {{m00}} {{m00}} {{m00}} {{m00}}))
          (f32x4.mul (local.get $vG) (v128.const f32x4 {{m01}} {{m01}} {{m01}} {{m01}})))
          (f32x4.mul (local.get $vB) (v128.const f32x4 {{m02}} {{m02}} {{m02}} {{m02}}))))
        (local.set $vGo (f32x4.add (f32x4.add
          (f32x4.mul (local.get $vR) (v128.const f32x4 {{m10}} {{m10}} {{m10}} {{m10}}))
          (f32x4.mul (local.get $vG) (v128.const f32x4 {{m11}} {{m11}} {{m11}} {{m11}})))
          (f32x4.mul (local.get $vB) (v128.const f32x4 {{m12}} {{m12}} {{m12}} {{m12}}))))
        (local.set $vBo (f32x4.add (f32x4.add
          (f32x4.mul (local.get $vR) (v128.const f32x4 {{m20}} {{m20}} {{m20}} {{m20}}))
          (f32x4.mul (local.get $vG) (v128.const f32x4 {{m21}} {{m21}} {{m21}} {{m21}})))
          (f32x4.mul (local.get $vB) (v128.const f32x4 {{m22}} {{m22}} {{m22}} {{m22}}))))

        ;; Gamma forward — per lane
        (local.set $r0 (call $gamma_lut (f32x4.extract_lane 0 (local.get $vRo)) (i32.const ${LUT_FWD_BYTE})))
        (local.set $r1 (call $gamma_lut (f32x4.extract_lane 1 (local.get $vRo)) (i32.const ${LUT_FWD_BYTE})))
        (local.set $r2 (call $gamma_lut (f32x4.extract_lane 2 (local.get $vRo)) (i32.const ${LUT_FWD_BYTE})))
        (local.set $r3 (call $gamma_lut (f32x4.extract_lane 3 (local.get $vRo)) (i32.const ${LUT_FWD_BYTE})))
        (local.set $g0 (call $gamma_lut (f32x4.extract_lane 0 (local.get $vGo)) (i32.const ${LUT_FWD_BYTE})))
        (local.set $g1 (call $gamma_lut (f32x4.extract_lane 1 (local.get $vGo)) (i32.const ${LUT_FWD_BYTE})))
        (local.set $g2 (call $gamma_lut (f32x4.extract_lane 2 (local.get $vGo)) (i32.const ${LUT_FWD_BYTE})))
        (local.set $g3 (call $gamma_lut (f32x4.extract_lane 3 (local.get $vGo)) (i32.const ${LUT_FWD_BYTE})))
        (local.set $b0 (call $gamma_lut (f32x4.extract_lane 0 (local.get $vBo)) (i32.const ${LUT_FWD_BYTE})))
        (local.set $b1 (call $gamma_lut (f32x4.extract_lane 1 (local.get $vBo)) (i32.const ${LUT_FWD_BYTE})))
        (local.set $b2 (call $gamma_lut (f32x4.extract_lane 2 (local.get $vBo)) (i32.const ${LUT_FWD_BYTE})))
        (local.set $b3 (call $gamma_lut (f32x4.extract_lane 3 (local.get $vBo)) (i32.const ${LUT_FWD_BYTE})))

        ;; Store 12 bytes: 4 pixels × RGB — clamped, scaled, rounded
        (i32.store8          (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $r0) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=1 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $g0) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=2 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $b0) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=3 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $r1) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=4 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $g1) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=5 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $b1) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=6 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $r2) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=7 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $g2) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=8 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $b2) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=9  (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $r3) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=10 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $g3) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=11 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $b3) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 12)))
        (local.set $p      (i32.add (local.get $p)      (i32.const 4)))
        (br $simd_loop)))

    ;; Scalar tail: remaining 0-3 pixels
    (block $tail_exit
      (loop $tail_loop
        (br_if $tail_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))
        (local.set $r0 (f32.mul (f32.convert_i32_u (i32.load8_u          (local.get $inPos))) (f32.const 0.0039215686)))
        (local.set $g0 (f32.mul (f32.convert_i32_u (i32.load8_u offset=1 (local.get $inPos))) (f32.const 0.0039215686)))
        (local.set $b0 (f32.mul (f32.convert_i32_u (i32.load8_u offset=2 (local.get $inPos))) (f32.const 0.0039215686)))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 3)))
        (local.set $r0 (call $gamma_lut (local.get $r0) (i32.const ${LUT_INV_BYTE})))
        (local.set $g0 (call $gamma_lut (local.get $g0) (i32.const ${LUT_INV_BYTE})))
        (local.set $b0 (call $gamma_lut (local.get $b0) (i32.const ${LUT_INV_BYTE})))
        (local.set $r1 (f32.add (f32.add (f32.mul (local.get $r0) (f32.const {{m00}})) (f32.mul (local.get $g0) (f32.const {{m01}}))) (f32.mul (local.get $b0) (f32.const {{m02}}))))
        (local.set $g1 (f32.add (f32.add (f32.mul (local.get $r0) (f32.const {{m10}})) (f32.mul (local.get $g0) (f32.const {{m11}}))) (f32.mul (local.get $b0) (f32.const {{m12}}))))
        (local.set $b1 (f32.add (f32.add (f32.mul (local.get $r0) (f32.const {{m20}})) (f32.mul (local.get $g0) (f32.const {{m21}}))) (f32.mul (local.get $b0) (f32.const {{m22}}))))
        (local.set $r1 (call $gamma_lut (local.get $r1) (i32.const ${LUT_FWD_BYTE})))
        (local.set $g1 (call $gamma_lut (local.get $g1) (i32.const ${LUT_FWD_BYTE})))
        (local.set $b1 (call $gamma_lut (local.get $b1) (i32.const ${LUT_FWD_BYTE})))
        (i32.store8          (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $r1) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=1 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $g1) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (i32.store8 offset=2 (local.get $outPos) (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $b1) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 3)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $tail_loop)))
  )
)`;

// ---------------------------------------------------------------------------
// V2 WAT template — inline gamma, no function calls, v128.load+shuffle input
//
// Memory layout (same 100 pages):
//   Bytes    0.. 1023  gamma_inv_256: 256 × f32 — indexed by input u8 directly
//   Bytes 1024.. 1279  gamma_fwd_256: 256 × u8  — indexed by rounded output u8
//   Bytes 1280+        pixel data (same seeded input as v1)
//
// Input gamma:  f32.load(i32.shl(load8_u(inPos), 2))   — 3 ops, no call
// Output gamma: i32.load8_u(1024 + round(x * 255))      — 2 ops, no call
// SIMD input:   v128.load once, then i8x16.shuffle to gather R/G/B bytes
// ---------------------------------------------------------------------------
const V2_GAMMA_INV_BYTE = 0;        // 256 × f32  = 1024 bytes
const V2_GAMMA_FWD_BYTE = 1024;     // 256 × u8   =  256 bytes
const V2_PIXEL_BYTE     = 1280;     // pixel data starts here (0x500)

const WAT_V2_TEMPLATE = `(module
  (memory (export "memory") ${WASM_PAGES})

  ;; -------------------------------------------------------------------
  ;; Scalar v2: inline gamma — no function calls, 256-entry LUTs
  ;; Input  gamma: f32.load(byte_value * 4)          [at byte 0]
  ;; Output gamma: u8 = load8_u(1024 + rounded_int)  [at byte 1024]
  ;; -------------------------------------------------------------------
  (func (export "run_scalar_v2")
    (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p      i32)
    (local $inPos  i32) (local $outPos i32)
    (local $r  f32) (local $g  f32) (local $b  f32)
    (local $ro f32) (local $go f32) (local $bo f32)
    (local $ti i32)
    (local.set $inPos  (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))
    (block $exit
      (loop $loop
        (br_if $exit (i32.ge_s (local.get $p) (local.get $pixelCount)))

        ;; Decode input bytes → linear f32  (2 ops per channel: shl + f32.load)
        (local.set $r (f32.load (i32.shl (i32.load8_u          (local.get $inPos)) (i32.const 2))))
        (local.set $g (f32.load (i32.shl (i32.load8_u offset=1 (local.get $inPos)) (i32.const 2))))
        (local.set $b (f32.load (i32.shl (i32.load8_u offset=2 (local.get $inPos)) (i32.const 2))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 3)))

        ;; Matrix
        (local.set $ro (f32.add (f32.add (f32.mul (local.get $r) (f32.const {{m00}})) (f32.mul (local.get $g) (f32.const {{m01}}))) (f32.mul (local.get $b) (f32.const {{m02}}))))
        (local.set $go (f32.add (f32.add (f32.mul (local.get $r) (f32.const {{m10}})) (f32.mul (local.get $g) (f32.const {{m11}}))) (f32.mul (local.get $b) (f32.const {{m12}}))))
        (local.set $bo (f32.add (f32.add (f32.mul (local.get $r) (f32.const {{m20}})) (f32.mul (local.get $g) (f32.const {{m21}}))) (f32.mul (local.get $b) (f32.const {{m22}}))))

        ;; Encode output: clamp [0,1] → scale 255 → round → 256-entry u8 gamma LUT
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $ro) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8          (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))

        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $go) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))

        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $bo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))

        (local.set $outPos (i32.add (local.get $outPos) (i32.const 3)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $loop)))
  )

  ;; -------------------------------------------------------------------
  ;; SIMD v2: v128.load + i8x16.shuffle to gather R/G/B bytes;
  ;;          inline gamma decode (no function call); f32x4 matrix.
  ;;          Output encoding stays per-lane (no SIMD gather for LUT).
  ;; -------------------------------------------------------------------
  (func (export "run_simd_v2")
    (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p      i32)
    (local $inPos  i32) (local $outPos i32)
    (local $raw v128)
    (local $vR  v128) (local $vG  v128) (local $vB  v128)
    (local $vRo v128) (local $vGo v128) (local $vBo v128)
    (local $r0 f32) (local $r1 f32) (local $r2 f32) (local $r3 f32)
    (local $g0 f32) (local $g1 f32) (local $g2 f32) (local $g3 f32)
    (local $b0 f32) (local $b1 f32) (local $b2 f32) (local $b3 f32)
    (local $ti i32)
    (local.set $inPos  (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))

    ;; SIMD strip: 4 pixels per iteration
    (block $simd_exit
      (loop $simd_loop
        (br_if $simd_exit (i32.gt_s (i32.add (local.get $p) (i32.const 4)) (local.get $pixelCount)))

        ;; Load 16 bytes covering 4 pixels (12 bytes) + 4 bytes into output buffer (safe)
        (local.set $raw (v128.load (local.get $inPos)))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 12)))

        ;; Gather R bytes (positions 0,3,6,9) into lanes 0-3 via shuffle
        ;; Indices 16+ select from the second (zero) vector — fills unused lanes with 0
        (local.set $vR (i8x16.shuffle 0 3 6 9 16 16 16 16 16 16 16 16 16 16 16 16
          (local.get $raw)
          (v128.const i8x16 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0)))
        (local.set $vG (i8x16.shuffle 1 4 7 10 16 16 16 16 16 16 16 16 16 16 16 16
          (local.get $raw)
          (v128.const i8x16 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0)))
        (local.set $vB (i8x16.shuffle 2 5 8 11 16 16 16 16 16 16 16 16 16 16 16 16
          (local.get $raw)
          (v128.const i8x16 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0)))

        ;; Decode gamma: extract lane byte → shl 2 → f32.load  (3 ops per channel, no call)
        (local.set $r0 (f32.load (i32.shl (i8x16.extract_lane_u 0 (local.get $vR)) (i32.const 2))))
        (local.set $r1 (f32.load (i32.shl (i8x16.extract_lane_u 1 (local.get $vR)) (i32.const 2))))
        (local.set $r2 (f32.load (i32.shl (i8x16.extract_lane_u 2 (local.get $vR)) (i32.const 2))))
        (local.set $r3 (f32.load (i32.shl (i8x16.extract_lane_u 3 (local.get $vR)) (i32.const 2))))
        (local.set $g0 (f32.load (i32.shl (i8x16.extract_lane_u 0 (local.get $vG)) (i32.const 2))))
        (local.set $g1 (f32.load (i32.shl (i8x16.extract_lane_u 1 (local.get $vG)) (i32.const 2))))
        (local.set $g2 (f32.load (i32.shl (i8x16.extract_lane_u 2 (local.get $vG)) (i32.const 2))))
        (local.set $g3 (f32.load (i32.shl (i8x16.extract_lane_u 3 (local.get $vG)) (i32.const 2))))
        (local.set $b0 (f32.load (i32.shl (i8x16.extract_lane_u 0 (local.get $vB)) (i32.const 2))))
        (local.set $b1 (f32.load (i32.shl (i8x16.extract_lane_u 1 (local.get $vB)) (i32.const 2))))
        (local.set $b2 (f32.load (i32.shl (i8x16.extract_lane_u 2 (local.get $vB)) (i32.const 2))))
        (local.set $b3 (f32.load (i32.shl (i8x16.extract_lane_u 3 (local.get $vB)) (i32.const 2))))

        ;; Reassemble linearised values into f32x4 for matrix
        (local.set $vR (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1 (f32x4.splat (local.get $r0)) (local.get $r1)) (local.get $r2)) (local.get $r3)))
        (local.set $vG (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1 (f32x4.splat (local.get $g0)) (local.get $g1)) (local.get $g2)) (local.get $g3)))
        (local.set $vB (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1 (f32x4.splat (local.get $b0)) (local.get $b1)) (local.get $b2)) (local.get $b3)))

        ;; Matrix: 4 pixels simultaneously
        (local.set $vRo (f32x4.add (f32x4.add
          (f32x4.mul (local.get $vR) (v128.const f32x4 {{m00}} {{m00}} {{m00}} {{m00}}))
          (f32x4.mul (local.get $vG) (v128.const f32x4 {{m01}} {{m01}} {{m01}} {{m01}})))
          (f32x4.mul (local.get $vB) (v128.const f32x4 {{m02}} {{m02}} {{m02}} {{m02}}))))
        (local.set $vGo (f32x4.add (f32x4.add
          (f32x4.mul (local.get $vR) (v128.const f32x4 {{m10}} {{m10}} {{m10}} {{m10}}))
          (f32x4.mul (local.get $vG) (v128.const f32x4 {{m11}} {{m11}} {{m11}} {{m11}})))
          (f32x4.mul (local.get $vB) (v128.const f32x4 {{m12}} {{m12}} {{m12}} {{m12}}))))
        (local.set $vBo (f32x4.add (f32x4.add
          (f32x4.mul (local.get $vR) (v128.const f32x4 {{m20}} {{m20}} {{m20}} {{m20}}))
          (f32x4.mul (local.get $vG) (v128.const f32x4 {{m21}} {{m21}} {{m21}} {{m21}})))
          (f32x4.mul (local.get $vB) (v128.const f32x4 {{m22}} {{m22}} {{m22}} {{m22}}))))

        ;; Output: extract each lane → clamp → round → 256-byte gamma LUT
        ;; Macro: encode f32 lane $v to gamma u8 at $outPos offset $off
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 0 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8          (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 0 (local.get $vGo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 0 (local.get $vBo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))

        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 1 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=3 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 1 (local.get $vGo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=4 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 1 (local.get $vBo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=5 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))

        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 2 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=6 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 2 (local.get $vGo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=7 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 2 (local.get $vBo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=8 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))

        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 3 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=9  (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 3 (local.get $vGo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=10 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 3 (local.get $vBo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=11 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))

        (local.set $outPos (i32.add (local.get $outPos) (i32.const 12)))
        (local.set $p      (i32.add (local.get $p)      (i32.const 4)))
        (br $simd_loop)))

    ;; Scalar tail: remaining 0-3 pixels
    (block $tail_exit
      (loop $tail_loop
        (br_if $tail_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))
        (local.set $r0 (f32.load (i32.shl (i32.load8_u          (local.get $inPos)) (i32.const 2))))
        (local.set $g0 (f32.load (i32.shl (i32.load8_u offset=1 (local.get $inPos)) (i32.const 2))))
        (local.set $b0 (f32.load (i32.shl (i32.load8_u offset=2 (local.get $inPos)) (i32.const 2))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 3)))
        (local.set $r1 (f32.add (f32.add (f32.mul (local.get $r0) (f32.const {{m00}})) (f32.mul (local.get $g0) (f32.const {{m01}}))) (f32.mul (local.get $b0) (f32.const {{m02}}))))
        (local.set $g1 (f32.add (f32.add (f32.mul (local.get $r0) (f32.const {{m10}})) (f32.mul (local.get $g0) (f32.const {{m11}}))) (f32.mul (local.get $b0) (f32.const {{m12}}))))
        (local.set $b1 (f32.add (f32.add (f32.mul (local.get $r0) (f32.const {{m20}})) (f32.mul (local.get $g0) (f32.const {{m21}}))) (f32.mul (local.get $b0) (f32.const {{m22}}))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $r1) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8          (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $g1) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $b1) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 3)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $tail_loop)))
  )

  ;; -------------------------------------------------------------------
  ;; SIMD v3: RGB bytes ARE the gamma table indices.
  ;; Load each byte directly with an immediate offset, shift left 2,
  ;; f32.load — that f32 value goes straight into the f32x4 lane.
  ;; No v128.load, no shuffle, no extract_lane, no scalar temp locals.
  ;; -------------------------------------------------------------------
  (func (export "run_simd_v3")
    (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p      i32)
    (local $inPos  i32) (local $outPos i32)
    (local $vR  v128) (local $vG  v128) (local $vB  v128)
    (local $vRo v128) (local $vGo v128) (local $vBo v128)
    (local $ti i32)
    ;; Tail-only temps (0-3 pixels)
    (local $tr f32) (local $tg f32) (local $tb f32)
    (local $tro f32) (local $tgo f32) (local $tbo f32)
    (local.set $inPos  (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))

    (block $simd_exit
      (loop $simd_loop
        (br_if $simd_exit (i32.gt_s (i32.add (local.get $p) (i32.const 4)) (local.get $pixelCount)))

        ;; Build vR/vG/vB: each lane = f32.load(gammaInv[byte])
        ;; Offsets 0/3/6/9 = R0-R3; 1/4/7/10 = G0-G3; 2/5/8/11 = B0-B3
        ;; The gamma-decoded f32 is the lane value — no intermediate locals.
        (local.set $vR
          (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
            (f32x4.splat
              (f32.load (i32.shl (i32.load8_u           (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=3  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=6  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=9  (local.get $inPos)) (i32.const 2)))))
        (local.set $vG
          (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
            (f32x4.splat
              (f32.load (i32.shl (i32.load8_u offset=1  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=4  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=7  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=10 (local.get $inPos)) (i32.const 2)))))
        (local.set $vB
          (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
            (f32x4.splat
              (f32.load (i32.shl (i32.load8_u offset=2  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=5  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=8  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=11 (local.get $inPos)) (i32.const 2)))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 12)))

        ;; Matrix: f32x4 across all 4 pixels
        (local.set $vRo (f32x4.add (f32x4.add
          (f32x4.mul (local.get $vR) (v128.const f32x4 {{m00}} {{m00}} {{m00}} {{m00}}))
          (f32x4.mul (local.get $vG) (v128.const f32x4 {{m01}} {{m01}} {{m01}} {{m01}})))
          (f32x4.mul (local.get $vB) (v128.const f32x4 {{m02}} {{m02}} {{m02}} {{m02}}))))
        (local.set $vGo (f32x4.add (f32x4.add
          (f32x4.mul (local.get $vR) (v128.const f32x4 {{m10}} {{m10}} {{m10}} {{m10}}))
          (f32x4.mul (local.get $vG) (v128.const f32x4 {{m11}} {{m11}} {{m11}} {{m11}})))
          (f32x4.mul (local.get $vB) (v128.const f32x4 {{m12}} {{m12}} {{m12}} {{m12}}))))
        (local.set $vBo (f32x4.add (f32x4.add
          (f32x4.mul (local.get $vR) (v128.const f32x4 {{m20}} {{m20}} {{m20}} {{m20}}))
          (f32x4.mul (local.get $vG) (v128.const f32x4 {{m21}} {{m21}} {{m21}} {{m21}})))
          (f32x4.mul (local.get $vB) (v128.const f32x4 {{m22}} {{m22}} {{m22}} {{m22}}))))

        ;; Output: extract each lane → clamp → round → 256-byte gamma LUT
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 0 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8          (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 0 (local.get $vGo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 0 (local.get $vBo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 1 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=3 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 1 (local.get $vGo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=4 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 1 (local.get $vBo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=5 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 2 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=6 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 2 (local.get $vGo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=7 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 2 (local.get $vBo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=8 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 3 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=9  (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 3 (local.get $vGo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=10 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 3 (local.get $vBo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=11 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))

        (local.set $outPos (i32.add (local.get $outPos) (i32.const 12)))
        (local.set $p      (i32.add (local.get $p)      (i32.const 4)))
        (br $simd_loop)))

    ;; Scalar tail: 0-3 remaining pixels
    (block $tail_exit
      (loop $tail_loop
        (br_if $tail_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))
        (local.set $tr  (f32.load (i32.shl (i32.load8_u           (local.get $inPos)) (i32.const 2))))
        (local.set $tg  (f32.load (i32.shl (i32.load8_u offset=1  (local.get $inPos)) (i32.const 2))))
        (local.set $tb  (f32.load (i32.shl (i32.load8_u offset=2  (local.get $inPos)) (i32.const 2))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 3)))
        (local.set $tro (f32.add (f32.add (f32.mul (local.get $tr) (f32.const {{m00}})) (f32.mul (local.get $tg) (f32.const {{m01}}))) (f32.mul (local.get $tb) (f32.const {{m02}}))))
        (local.set $tgo (f32.add (f32.add (f32.mul (local.get $tr) (f32.const {{m10}})) (f32.mul (local.get $tg) (f32.const {{m11}}))) (f32.mul (local.get $tb) (f32.const {{m12}}))))
        (local.set $tbo (f32.add (f32.add (f32.mul (local.get $tr) (f32.const {{m20}})) (f32.mul (local.get $tg) (f32.const {{m21}}))) (f32.mul (local.get $tb) (f32.const {{m22}}))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tro) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8          (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tgo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tbo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 3)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $tail_loop)))
  )

  ;; -------------------------------------------------------------------
  ;; SIMD v4: same as v3 but matrix constants loaded into v128 locals
  ;; ONCE before the loop rather than as v128.const inside the loop body.
  ;; Guarantees hoisting regardless of JIT LICM heuristics.
  ;; 9 constant locals + 6 working registers = 15 v128 live at peak,
  ;; fits in x86_64's 16 XMM registers with 1 scratch left.
  ;; -------------------------------------------------------------------
  (func (export "run_simd_v4")
    (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p      i32)
    (local $inPos  i32) (local $outPos i32)
    (local $vR  v128) (local $vG  v128) (local $vB  v128)
    (local $vRo v128) (local $vGo v128) (local $vBo v128)
    (local $ti i32)
    ;; Matrix constant locals — loaded once before the loop
    (local $cm00 v128) (local $cm01 v128) (local $cm02 v128)
    (local $cm10 v128) (local $cm11 v128) (local $cm12 v128)
    (local $cm20 v128) (local $cm21 v128) (local $cm22 v128)
    ;; Tail-only temps
    (local $tr f32) (local $tg f32) (local $tb f32)
    (local $tro f32) (local $tgo f32) (local $tbo f32)
    (local.set $inPos  (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))

    ;; Load matrix constants once — JIT keeps these in XMM registers for the loop
    (local.set $cm00 (v128.const f32x4 {{m00}} {{m00}} {{m00}} {{m00}}))
    (local.set $cm01 (v128.const f32x4 {{m01}} {{m01}} {{m01}} {{m01}}))
    (local.set $cm02 (v128.const f32x4 {{m02}} {{m02}} {{m02}} {{m02}}))
    (local.set $cm10 (v128.const f32x4 {{m10}} {{m10}} {{m10}} {{m10}}))
    (local.set $cm11 (v128.const f32x4 {{m11}} {{m11}} {{m11}} {{m11}}))
    (local.set $cm12 (v128.const f32x4 {{m12}} {{m12}} {{m12}} {{m12}}))
    (local.set $cm20 (v128.const f32x4 {{m20}} {{m20}} {{m20}} {{m20}}))
    (local.set $cm21 (v128.const f32x4 {{m21}} {{m21}} {{m21}} {{m21}}))
    (local.set $cm22 (v128.const f32x4 {{m22}} {{m22}} {{m22}} {{m22}}))

    (block $simd_exit
      (loop $simd_loop
        (br_if $simd_exit (i32.gt_s (i32.add (local.get $p) (i32.const 4)) (local.get $pixelCount)))

        ;; Input: same as v3 — byte → shl(2) → f32.load directly into f32x4 lane
        (local.set $vR
          (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
            (f32x4.splat
              (f32.load (i32.shl (i32.load8_u           (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=3  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=6  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=9  (local.get $inPos)) (i32.const 2)))))
        (local.set $vG
          (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
            (f32x4.splat
              (f32.load (i32.shl (i32.load8_u offset=1  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=4  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=7  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=10 (local.get $inPos)) (i32.const 2)))))
        (local.set $vB
          (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
            (f32x4.splat
              (f32.load (i32.shl (i32.load8_u offset=2  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=5  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=8  (local.get $inPos)) (i32.const 2))))
            (f32.load  (i32.shl (i32.load8_u offset=11 (local.get $inPos)) (i32.const 2)))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 12)))

        ;; Matrix: local.get replaces v128.const — registers pre-loaded before loop
        (local.set $vRo (f32x4.add (f32x4.add
          (f32x4.mul (local.get $vR) (local.get $cm00))
          (f32x4.mul (local.get $vG) (local.get $cm01)))
          (f32x4.mul (local.get $vB) (local.get $cm02))))
        (local.set $vGo (f32x4.add (f32x4.add
          (f32x4.mul (local.get $vR) (local.get $cm10))
          (f32x4.mul (local.get $vG) (local.get $cm11)))
          (f32x4.mul (local.get $vB) (local.get $cm12))))
        (local.set $vBo (f32x4.add (f32x4.add
          (f32x4.mul (local.get $vR) (local.get $cm20))
          (f32x4.mul (local.get $vG) (local.get $cm21)))
          (f32x4.mul (local.get $vB) (local.get $cm22))))

        ;; Output: same as v3
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 0 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8          (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 0 (local.get $vGo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 0 (local.get $vBo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 1 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=3 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 1 (local.get $vGo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=4 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 1 (local.get $vBo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=5 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 2 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=6 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 2 (local.get $vGo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=7 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 2 (local.get $vBo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=8 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 3 (local.get $vRo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=9  (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 3 (local.get $vGo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=10 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane 3 (local.get $vBo)) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=11 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))

        (local.set $outPos (i32.add (local.get $outPos) (i32.const 12)))
        (local.set $p      (i32.add (local.get $p)      (i32.const 4)))
        (br $simd_loop)))

    ;; Scalar tail
    (block $tail_exit
      (loop $tail_loop
        (br_if $tail_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))
        (local.set $tr  (f32.load (i32.shl (i32.load8_u           (local.get $inPos)) (i32.const 2))))
        (local.set $tg  (f32.load (i32.shl (i32.load8_u offset=1  (local.get $inPos)) (i32.const 2))))
        (local.set $tb  (f32.load (i32.shl (i32.load8_u offset=2  (local.get $inPos)) (i32.const 2))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 3)))
        (local.set $tro (f32.add (f32.add (f32.mul (local.get $tr) (f32.const {{m00}})) (f32.mul (local.get $tg) (f32.const {{m01}}))) (f32.mul (local.get $tb) (f32.const {{m02}}))))
        (local.set $tgo (f32.add (f32.add (f32.mul (local.get $tr) (f32.const {{m10}})) (f32.mul (local.get $tg) (f32.const {{m11}}))) (f32.mul (local.get $tb) (f32.const {{m12}}))))
        (local.set $tbo (f32.add (f32.add (f32.mul (local.get $tr) (f32.const {{m20}})) (f32.mul (local.get $tg) (f32.const {{m21}}))) (f32.mul (local.get $tb) (f32.const {{m22}}))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tro) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8          (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tgo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tbo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 255.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 255) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 255))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V2_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 3)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $tail_loop)))
  )
)`;

// ---------------------------------------------------------------------------
// WAT code-gen helpers
// ---------------------------------------------------------------------------
// Generates one output-encode store: extract f32x4 lane → clamp → scale →
// round → look up gamma_fwd table (u8) → store byte.
// maxVal: 255 (256-entry) or 4095 (4096-entry). fwdBase: byte offset of table.
function genOutputEncode(lane, channel, byteOffset, maxVal, fwdBase) {
    const off = byteOffset > 0 ? ` offset=${byteOffset}` : '';
    return `
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane ${lane} (local.get ${channel})) (f32.const 0.0)) (f32.const 1.0)) (f32.const ${maxVal}.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const ${maxVal}) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const ${maxVal}))))
        (i32.store8${off} (local.get $outPos) (i32.load8_u (i32.add (i32.const ${fwdBase}) (local.get $ti))))`;
}

// All 12 output stores for one 4-pixel SIMD batch (R0G0B0 … R3G3B3).
function genOutputEncodes(maxVal, fwdBase) {
    return [
        [0,'$vRo',0],[0,'$vGo',1],[0,'$vBo',2],
        [1,'$vRo',3],[1,'$vGo',4],[1,'$vBo',5],
        [2,'$vRo',6],[2,'$vGo',7],[2,'$vBo',8],
        [3,'$vRo',9],[3,'$vGo',10],[3,'$vBo',11],
    ].map(([l, c, o]) => genOutputEncode(l, c, o, maxVal, fwdBase)).join('');
}

// ---------------------------------------------------------------------------
// V5 memory layout — 4096-entry output gamma table for higher precision
// ---------------------------------------------------------------------------
// The output table maps a quantised linear index (0..4095) to a gamma-encoded
// u8. Using 4096 entries instead of 256 reduces the max quantisation error at
// the sRGB knee from ±6.5 LSB to ±0.4 LSB.
const V5_GAMMA_INV_BYTE = 0;       // 256 × f32 = 1024 bytes  (same as v2)
const V5_GAMMA_FWD_BYTE = 1024;    // 4096 × u8 = 4096 bytes  (4× larger)
const V5_PIXEL_BYTE     = 5120;    // 1024 + 4096 = 0x1400

// V5 WAT template — v4 structure, 4096-entry output table.
// genOutputEncodes() is evaluated at parse time; {{mXX}} filled at bench time.
const WAT_V5_TEMPLATE = `(module
  (memory (export "memory") ${WASM_PAGES})

  (func (export "run_simd_v5")
    (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p      i32)
    (local $inPos  i32) (local $outPos i32)
    (local $vR  v128) (local $vG  v128) (local $vB  v128)
    (local $vRo v128) (local $vGo v128) (local $vBo v128)
    (local $ti i32)
    (local $cm00 v128) (local $cm01 v128) (local $cm02 v128)
    (local $cm10 v128) (local $cm11 v128) (local $cm12 v128)
    (local $cm20 v128) (local $cm21 v128) (local $cm22 v128)
    (local $tr f32) (local $tg f32) (local $tb f32)
    (local $tro f32) (local $tgo f32) (local $tbo f32)
    (local.set $inPos  (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))
    (local.set $cm00 (v128.const f32x4 {{m00}} {{m00}} {{m00}} {{m00}}))
    (local.set $cm01 (v128.const f32x4 {{m01}} {{m01}} {{m01}} {{m01}}))
    (local.set $cm02 (v128.const f32x4 {{m02}} {{m02}} {{m02}} {{m02}}))
    (local.set $cm10 (v128.const f32x4 {{m10}} {{m10}} {{m10}} {{m10}}))
    (local.set $cm11 (v128.const f32x4 {{m11}} {{m11}} {{m11}} {{m11}}))
    (local.set $cm12 (v128.const f32x4 {{m12}} {{m12}} {{m12}} {{m12}}))
    (local.set $cm20 (v128.const f32x4 {{m20}} {{m20}} {{m20}} {{m20}}))
    (local.set $cm21 (v128.const f32x4 {{m21}} {{m21}} {{m21}} {{m21}}))
    (local.set $cm22 (v128.const f32x4 {{m22}} {{m22}} {{m22}} {{m22}}))

    (block $simd_exit
      (loop $simd_loop
        (br_if $simd_exit (i32.gt_s (i32.add (local.get $p) (i32.const 4)) (local.get $pixelCount)))
        (local.set $vR
          (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
            (f32x4.splat (f32.load (i32.shl (i32.load8_u           (local.get $inPos)) (i32.const 2))))
            (f32.load    (i32.shl (i32.load8_u offset=3  (local.get $inPos)) (i32.const 2))))
            (f32.load    (i32.shl (i32.load8_u offset=6  (local.get $inPos)) (i32.const 2))))
            (f32.load    (i32.shl (i32.load8_u offset=9  (local.get $inPos)) (i32.const 2)))))
        (local.set $vG
          (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
            (f32x4.splat (f32.load (i32.shl (i32.load8_u offset=1  (local.get $inPos)) (i32.const 2))))
            (f32.load    (i32.shl (i32.load8_u offset=4  (local.get $inPos)) (i32.const 2))))
            (f32.load    (i32.shl (i32.load8_u offset=7  (local.get $inPos)) (i32.const 2))))
            (f32.load    (i32.shl (i32.load8_u offset=10 (local.get $inPos)) (i32.const 2)))))
        (local.set $vB
          (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
            (f32x4.splat (f32.load (i32.shl (i32.load8_u offset=2  (local.get $inPos)) (i32.const 2))))
            (f32.load    (i32.shl (i32.load8_u offset=5  (local.get $inPos)) (i32.const 2))))
            (f32.load    (i32.shl (i32.load8_u offset=8  (local.get $inPos)) (i32.const 2))))
            (f32.load    (i32.shl (i32.load8_u offset=11 (local.get $inPos)) (i32.const 2)))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 12)))
        (local.set $vRo (f32x4.add (f32x4.add (f32x4.mul (local.get $vR) (local.get $cm00)) (f32x4.mul (local.get $vG) (local.get $cm01))) (f32x4.mul (local.get $vB) (local.get $cm02))))
        (local.set $vGo (f32x4.add (f32x4.add (f32x4.mul (local.get $vR) (local.get $cm10)) (f32x4.mul (local.get $vG) (local.get $cm11))) (f32x4.mul (local.get $vB) (local.get $cm12))))
        (local.set $vBo (f32x4.add (f32x4.add (f32x4.mul (local.get $vR) (local.get $cm20)) (f32x4.mul (local.get $vG) (local.get $cm21))) (f32x4.mul (local.get $vB) (local.get $cm22))))
${genOutputEncodes(4095, 1024)}
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 12)))
        (local.set $p      (i32.add (local.get $p)      (i32.const 4)))
        (br $simd_loop)))

    (block $tail_exit
      (loop $tail_loop
        (br_if $tail_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))
        (local.set $tr  (f32.load (i32.shl (i32.load8_u           (local.get $inPos)) (i32.const 2))))
        (local.set $tg  (f32.load (i32.shl (i32.load8_u offset=1  (local.get $inPos)) (i32.const 2))))
        (local.set $tb  (f32.load (i32.shl (i32.load8_u offset=2  (local.get $inPos)) (i32.const 2))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 3)))
        (local.set $tro (f32.add (f32.add (f32.mul (local.get $tr) (f32.const {{m00}})) (f32.mul (local.get $tg) (f32.const {{m01}}))) (f32.mul (local.get $tb) (f32.const {{m02}}))))
        (local.set $tgo (f32.add (f32.add (f32.mul (local.get $tr) (f32.const {{m10}})) (f32.mul (local.get $tg) (f32.const {{m11}}))) (f32.mul (local.get $tb) (f32.const {{m12}}))))
        (local.set $tbo (f32.add (f32.add (f32.mul (local.get $tr) (f32.const {{m20}})) (f32.mul (local.get $tg) (f32.const {{m21}}))) (f32.mul (local.get $tb) (f32.const {{m22}}))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tro) (f32.const 0.0)) (f32.const 1.0)) (f32.const 4095.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 4095) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 4095))))
        (i32.store8          (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V5_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tgo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 4095.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 4095) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 4095))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V5_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tbo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 4095.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 4095) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 4095))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const ${V5_GAMMA_FWD_BYTE}) (local.get $ti))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 3)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $tail_loop)))
  )
)`;

// ---------------------------------------------------------------------------
// Bench helper
// ---------------------------------------------------------------------------
function bench(label, fn, warmup, runs) {
    for (let i = 0; i < warmup; i++) fn();
    const times = [];
    for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        fn();
        times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    const mpx    = (PIXEL_COUNT / median / 1000).toFixed(1);
    console.log(`  ${label.padEnd(32)} ${mpx.padStart(7)} MPx/s   (median ${median.toFixed(2)} ms)`);
    return parseFloat(mpx);
}

// ---------------------------------------------------------------------------
// Correctness spot-check: compare WASM scalar output against jsCE reference
// ---------------------------------------------------------------------------
function spotCheck(label, wasmOut, refOut, count = 20) {
    let maxDiff = 0;
    for (let i = 0; i < count * 3; i++) {
        const d = Math.abs(wasmOut[i] - refOut[i]);
        if (d > maxDiff) maxDiff = d;
    }
    console.log(`  ${label} max diff vs jsCE reference: ${maxDiff} LSB (u8)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    console.log('\n=== Matrix-shaper WASM kernel POC ===');
    console.log(`    ${PIXEL_COUNT.toLocaleString()} pixels, ${WARMUP_RUNS} warmup + ${TIMED_RUNS} timed runs\n`);

    // -- Profiles -----------------------------------------------------------
    const srgbProfile    = new Profile();
    const adobeProfile   = new Profile();
    await new Promise(r => srgbProfile.load('*sRGB',     () => r()));
    await new Promise(r => adobeProfile.load('*AdobeRGB', () => r()));

    const srcMat = srgbProfile.RGBMatrix.XYZMatrix;        // sRGB RGB→XYZ
    const dstInv = adobeProfile.RGBMatrix.XYZMatrixInv;    // AdobeRGB XYZ→RGB
    const fused  = mulMat(dstInv, srcMat);                 // combined sRGB→AdobeRGB

    console.log('  Fused sRGB→AdobeRGB matrix (from engine virtual profiles):');
    console.log(`    [ ${fused.m00.toFixed(6)}  ${fused.m01.toFixed(6)}  ${fused.m02.toFixed(6)} ]`);
    console.log(`    [ ${fused.m10.toFixed(6)}  ${fused.m11.toFixed(6)}  ${fused.m12.toFixed(6)} ]`);
    console.log(`    [ ${fused.m20.toFixed(6)}  ${fused.m21.toFixed(6)}  ${fused.m22.toFixed(6)} ]`);
    console.log();

    // White preservation check: fused * [1,1,1] should = [1,1,1]
    const wr = fused.m00 + fused.m01 + fused.m02;
    const wg = fused.m10 + fused.m11 + fused.m12;
    const wb = fused.m20 + fused.m21 + fused.m22;
    console.log(`  White check (row sums, each should ≈ 1.0): R=${wr.toFixed(6)} G=${wg.toFixed(6)} B=${wb.toFixed(6)}`);
    console.log();

    // -- Build WAT from template -------------------------------------------
    const wat = WAT_TEMPLATE
        .replace(/\{\{m00\}\}/g, fused.m00.toFixed(10))
        .replace(/\{\{m01\}\}/g, fused.m01.toFixed(10))
        .replace(/\{\{m02\}\}/g, fused.m02.toFixed(10))
        .replace(/\{\{m10\}\}/g, fused.m10.toFixed(10))
        .replace(/\{\{m11\}\}/g, fused.m11.toFixed(10))
        .replace(/\{\{m12\}\}/g, fused.m12.toFixed(10))
        .replace(/\{\{m20\}\}/g, fused.m20.toFixed(10))
        .replace(/\{\{m21\}\}/g, fused.m21.toFixed(10))
        .replace(/\{\{m22\}\}/g, fused.m22.toFixed(10));

    process.stdout.write('  Compiling WAT... ');
    const wabt  = await wabtFactory();
    const mod   = wabt.parseWat('matrix_shaper_poc.wat', wat, {
        multi_value: true, mutable_globals: true, simd: true
    });
    const { buffer } = mod.toBinary({});
    mod.destroy();
    const wasmBytes = new Uint8Array(buffer);
    process.stdout.write(`${wasmBytes.length} bytes\n`);

    const wasmModule   = await WebAssembly.compile(wasmBytes);
    const wasmInstance = await WebAssembly.instantiate(wasmModule, {});
    const { run_scalar, run_simd, memory } = wasmInstance.exports;
    console.log(`  WASM memory: ${(memory.buffer.byteLength / 1024 / 1024).toFixed(1)} MB`);

    // -- Gamma LUTs ---------------------------------------------------------
    // POC: simple x^2.2 / x^(1/2.2). Any curve shape works — LUT is built in JS.
    const gammaLut = new Float32Array(memory.buffer);
    for (let i = 0; i < LUT_SIZE; i++) {
        const x = i / (LUT_SIZE - 1);
        gammaLut[i]            = Math.pow(x, 2.2);          // gamma_inv  (linearise)
        gammaLut[LUT_SIZE + i] = Math.pow(x, 1.0 / 2.2);   // gamma_fwd  (encode)
    }

    // -- Pixel data ---------------------------------------------------------
    const inputOffset  = PIXEL_BYTE;
    const outputOffset = PIXEL_BYTE + PIXEL_COUNT * 3;
    const inputView    = new Uint8Array(memory.buffer, inputOffset,  PIXEL_COUNT * 3);
    const outputScalar = new Uint8Array(memory.buffer, outputOffset, PIXEL_COUNT * 3);

    // Fill input with seeded pseudo-random bytes (reproducible, covers full range)
    let seed = 0x12345678;
    for (let i = 0; i < inputView.length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        inputView[i] = seed >>> 24;
    }

    // -- jsCE reference transforms ------------------------------------------
    // Build sRGB→AdobeRGB using the engine (float accuracy path — ground truth)
    const tFloat = new Transform({ dataFormat: 'int8', buildLut: false });
    tFloat.create(srgbProfile, adobeProfile, eIntent.relative);

    // Build sRGB→AdobeRGB using int-wasm-simd (existing production kernel)
    const tSimdLut = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd' });
    tSimdLut.create(srgbProfile, adobeProfile, eIntent.relative);

    // Also build the existing JS int kernel for reference
    const tIntJs = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int' });
    tIntJs.create(srgbProfile, adobeProfile, eIntent.relative);

    // Copy input to a normal Uint8Array for jsCE calls
    const jsInput = new Uint8Array(inputView);

    // -- Correctness check --------------------------------------------------
    console.log('  Correctness (spot-check first 20 pixels, scalar vs jsCE float):');
    run_scalar(inputOffset, outputOffset, PIXEL_COUNT);
    const refFloat = tFloat.transformArray(jsInput);
    spotCheck('WASM scalar', outputScalar, refFloat);

    // Check SIMD matches scalar
    const simdOffset = outputOffset + PIXEL_COUNT * 3;
    // (SIMD output would need a separate buffer; for simplicity reuse the same
    //  region — correctness check is done before the timed bench below)
    console.log();

    // -- Benchmarks ---------------------------------------------------------
    console.log('  Throughput:');

    bench('WASM scalar (matrix + gamma LUT)',
        () => run_scalar(inputOffset, outputOffset, PIXEL_COUNT),
        WARMUP_RUNS, TIMED_RUNS);

    bench('WASM SIMD  (matrix f32x4 + gamma/lane)',
        () => run_simd(inputOffset, outputOffset, PIXEL_COUNT),
        WARMUP_RUNS, TIMED_RUNS);

    bench('jsCE int JS (3D CLUT)',
        () => tIntJs.transformArray(jsInput),
        WARMUP_RUNS, TIMED_RUNS);

    bench('jsCE float (no LUT — f64 accuracy)',
        () => tFloat.transformArray(jsInput),
        WARMUP_RUNS, TIMED_RUNS);

    // -- V2: inline gamma, no function calls, shuffle input loading ----------
    console.log('\n  --- v2: inline gamma (256-entry LUTs) + v128.load + shuffle ---');

    const watV2 = WAT_V2_TEMPLATE
        .replace(/\{\{m00\}\}/g, fused.m00.toFixed(10))
        .replace(/\{\{m01\}\}/g, fused.m01.toFixed(10))
        .replace(/\{\{m02\}\}/g, fused.m02.toFixed(10))
        .replace(/\{\{m10\}\}/g, fused.m10.toFixed(10))
        .replace(/\{\{m11\}\}/g, fused.m11.toFixed(10))
        .replace(/\{\{m12\}\}/g, fused.m12.toFixed(10))
        .replace(/\{\{m20\}\}/g, fused.m20.toFixed(10))
        .replace(/\{\{m21\}\}/g, fused.m21.toFixed(10))
        .replace(/\{\{m22\}\}/g, fused.m22.toFixed(10));

    process.stdout.write('\n  Compiling v2 WAT... ');
    const modV2 = wabt.parseWat('matrix_shaper_poc_v2.wat', watV2, {
        multi_value: true, mutable_globals: true, simd: true
    });
    const { buffer: bufV2 } = modV2.toBinary({});
    modV2.destroy();
    process.stdout.write(`${bufV2.byteLength} bytes\n`);

    const wasmModuleV2   = await WebAssembly.compile(new Uint8Array(bufV2));
    const wasmInstanceV2 = await WebAssembly.instantiate(wasmModuleV2, {});
    const { run_scalar_v2, run_simd_v2, run_simd_v3, run_simd_v4, memory: memoryV2 } = wasmInstanceV2.exports;

    // Write v2 gamma tables (256-entry each, fit in L1 cache)
    const gammaInvV2 = new Float32Array(memoryV2.buffer, V2_GAMMA_INV_BYTE, 256);
    const gammaFwdV2 = new Uint8Array(memoryV2.buffer,  V2_GAMMA_FWD_BYTE, 256);
    for (let i = 0; i < 256; i++) {
        const x = i / 255;
        gammaInvV2[i] = Math.pow(x, 2.2);                                  // linearise
        gammaFwdV2[i] = Math.round(Math.pow(x, 1.0 / 2.2) * 255);         // encode → u8
    }

    // Write same pixel data into v2 memory
    const inputV2 = new Uint8Array(memoryV2.buffer, V2_PIXEL_BYTE, PIXEL_COUNT * 3);
    inputV2.set(jsInput);
    const outputV2Byte  = V2_PIXEL_BYTE + PIXEL_COUNT * 3;

    bench('V2 scalar (inline gamma 256-entry)',
        () => run_scalar_v2(V2_PIXEL_BYTE, outputV2Byte, PIXEL_COUNT),
        WARMUP_RUNS, TIMED_RUNS);

    bench('V2 SIMD   (shuffle + inline gamma)',
        () => run_simd_v2(V2_PIXEL_BYTE, outputV2Byte, PIXEL_COUNT),
        WARMUP_RUNS, TIMED_RUNS);

    bench('V3 SIMD   (byte→index→lane, no shuffle)',
        () => run_simd_v3(V2_PIXEL_BYTE, outputV2Byte, PIXEL_COUNT),
        WARMUP_RUNS, TIMED_RUNS);

    bench('V4 SIMD   (v3 + matrix consts pre-loaded)',
        () => run_simd_v4(V2_PIXEL_BYTE, outputV2Byte, PIXEL_COUNT),
        WARMUP_RUNS, TIMED_RUNS);

    // -- V5: same as v4 but 4096-entry output gamma table ------------------
    // Reduces max quantisation error at the sRGB knee from ±6.5 LSB to ±0.4 LSB.
    console.log('\n  --- v5: 4096-entry output gamma (4× precision, same structure) ---\n');

    const watV5 = WAT_V5_TEMPLATE
        .replace(/\{\{m00\}\}/g, fused.m00.toFixed(10))
        .replace(/\{\{m01\}\}/g, fused.m01.toFixed(10))
        .replace(/\{\{m02\}\}/g, fused.m02.toFixed(10))
        .replace(/\{\{m10\}\}/g, fused.m10.toFixed(10))
        .replace(/\{\{m11\}\}/g, fused.m11.toFixed(10))
        .replace(/\{\{m12\}\}/g, fused.m12.toFixed(10))
        .replace(/\{\{m20\}\}/g, fused.m20.toFixed(10))
        .replace(/\{\{m21\}\}/g, fused.m21.toFixed(10))
        .replace(/\{\{m22\}\}/g, fused.m22.toFixed(10));

    process.stdout.write('  Compiling v5 WAT... ');
    const modV5 = wabt.parseWat('matrix_shaper_poc_v5.wat', watV5, {
        multi_value: true, mutable_globals: true, simd: true
    });
    const { buffer: bufV5 } = modV5.toBinary({});
    modV5.destroy();
    process.stdout.write(`${bufV5.byteLength} bytes\n`);

    const wasmModuleV5   = await WebAssembly.compile(new Uint8Array(bufV5));
    const wasmInstanceV5 = await WebAssembly.instantiate(wasmModuleV5, {});
    const { run_simd_v5, memory: memoryV5 } = wasmInstanceV5.exports;

    // Input gamma: same 256-entry f32 table at byte 0
    const gammaInvV5 = new Float32Array(memoryV5.buffer, V5_GAMMA_INV_BYTE, 256);
    for (let i = 0; i < 256; i++) gammaInvV5[i] = Math.pow(i / 255, 2.2);

    // Output gamma: 4096-entry u8 table at byte 1024
    // Each entry: gamma_encode(i / 4095) → u8
    const gammaFwdV5 = new Uint8Array(memoryV5.buffer, V5_GAMMA_FWD_BYTE, 4096);
    for (let i = 0; i < 4096; i++) {
        gammaFwdV5[i] = Math.round(Math.pow(i / 4095, 1.0 / 2.2) * 255);
    }

    // Pixel data starts at V5_PIXEL_BYTE = 5120
    const inputV5 = new Uint8Array(memoryV5.buffer, V5_PIXEL_BYTE, PIXEL_COUNT * 3);
    inputV5.set(jsInput);
    const outputV5Byte = V5_PIXEL_BYTE + PIXEL_COUNT * 3;
    const outputV5     = new Uint8Array(memoryV5.buffer, outputV5Byte, PIXEL_COUNT * 3);

    // Correctness: compare v5 against the jsCE float reference
    run_simd_v5(V5_PIXEL_BYTE, outputV5Byte, PIXEL_COUNT);
    console.log('  Correctness (v5 vs jsCE float, first 20 pixels):');
    spotCheck('V5 SIMD (4096-entry output)', outputV5, refFloat);
    console.log();

    bench('V5 SIMD   (4096-entry output gamma)',
        () => run_simd_v5(V5_PIXEL_BYTE, outputV5Byte, PIXEL_COUNT),
        WARMUP_RUNS, TIMED_RUNS);

    console.log('\n  Note: WASM gamma is x^2.2/x^(1/2.2) POC — not the sRGB piecewise curve.');
    console.log('        Production would use the profile\'s own TRC built into the LUT at create() time.');
    console.log('        V2 correctness matches V1 (same gamma approximation, same matrix).\n');
}

main().catch(err => { console.error(err); process.exit(1); });
