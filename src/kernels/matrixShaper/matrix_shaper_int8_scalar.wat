(module
  (memory (export "memory") 2)

  ;; Gamma tables and the matrix are read from linear memory; see the layout in
  ;; scripts/build_matrix_shaper_wasm.js. One entry point per alpha shape —
  ;; strides are baked in, so 3->3 keeps its constant offsets.

  ;; run(inputPtr, outputPtr, pixelCount)
  ;;   input  : 3 channels per pixel, u8
  ;;   output : 3 channels per pixel, u8
  ;;   alpha  : none in the output
  (func (export "run") (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p      i32)
    (local $inPos  i32) (local $outPos i32)
    (local $ti i32)
    (local $s00 f32) (local $s01 f32) (local $s02 f32)
    (local $s10 f32) (local $s11 f32) (local $s12 f32)
    (local $s20 f32) (local $s21 f32) (local $s22 f32)
    (local $tr f32) (local $tg f32) (local $tb f32)
    (local $tro f32) (local $tgo f32) (local $tbo f32)

    (local.set $inPos  (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))

    ;; Matrix from memory into locals, ONCE per call.
    (local.set $s00 (f32.load offset=66560 (i32.const 0))) (local.set $s01 (f32.load offset=66564 (i32.const 0))) (local.set $s02 (f32.load offset=66568 (i32.const 0)))
    (local.set $s10 (f32.load offset=66572 (i32.const 0))) (local.set $s11 (f32.load offset=66576 (i32.const 0))) (local.set $s12 (f32.load offset=66580 (i32.const 0)))
    (local.set $s20 (f32.load offset=66584 (i32.const 0))) (local.set $s21 (f32.load offset=66588 (i32.const 0))) (local.set $s22 (f32.load offset=66592 (i32.const 0)))

    ;; --- one pixel per iteration -------------------------------------------
    ;; The same operations in the same order as one lane of the SIMD build, so
    ;; a host without SIMD gets the same bytes out, not merely similar ones.
    (block $tail_exit
      (loop $tail_loop
        (br_if $tail_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))
        (local.set $tr (f32.load (i32.shl (i32.load8_u (local.get $inPos)) (i32.const 2))))
        (local.set $tg (f32.load (i32.shl (i32.load8_u offset=1 (local.get $inPos)) (i32.const 2))))
        (local.set $tb (f32.load (i32.shl (i32.load8_u offset=2 (local.get $inPos)) (i32.const 2))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 3)))
        (local.set $tro (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s00)) (f32.mul (local.get $tg) (local.get $s01))) (f32.mul (local.get $tb) (local.get $s02))))
        (local.set $tgo (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s10)) (f32.mul (local.get $tg) (local.get $s11))) (f32.mul (local.get $tb) (local.get $s12))))
        (local.set $tbo (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s20)) (f32.mul (local.get $tg) (local.get $s21))) (f32.mul (local.get $tb) (local.get $s22))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tro) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tgo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tbo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 3)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $tail_loop)))
  )

  ;; run_a_in(inputPtr, outputPtr, pixelCount)
  ;;   input  : 4 channels per pixel, u8
  ;;   output : 3 channels per pixel, u8
  ;;   alpha  : none in the output
  (func (export "run_a_in") (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p      i32)
    (local $inPos  i32) (local $outPos i32)
    (local $ti i32)
    (local $s00 f32) (local $s01 f32) (local $s02 f32)
    (local $s10 f32) (local $s11 f32) (local $s12 f32)
    (local $s20 f32) (local $s21 f32) (local $s22 f32)
    (local $tr f32) (local $tg f32) (local $tb f32)
    (local $tro f32) (local $tgo f32) (local $tbo f32)

    (local.set $inPos  (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))

    ;; Matrix from memory into locals, ONCE per call.
    (local.set $s00 (f32.load offset=66560 (i32.const 0))) (local.set $s01 (f32.load offset=66564 (i32.const 0))) (local.set $s02 (f32.load offset=66568 (i32.const 0)))
    (local.set $s10 (f32.load offset=66572 (i32.const 0))) (local.set $s11 (f32.load offset=66576 (i32.const 0))) (local.set $s12 (f32.load offset=66580 (i32.const 0)))
    (local.set $s20 (f32.load offset=66584 (i32.const 0))) (local.set $s21 (f32.load offset=66588 (i32.const 0))) (local.set $s22 (f32.load offset=66592 (i32.const 0)))

    ;; --- one pixel per iteration -------------------------------------------
    ;; The same operations in the same order as one lane of the SIMD build, so
    ;; a host without SIMD gets the same bytes out, not merely similar ones.
    (block $tail_exit
      (loop $tail_loop
        (br_if $tail_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))
        (local.set $tr (f32.load (i32.shl (i32.load8_u (local.get $inPos)) (i32.const 2))))
        (local.set $tg (f32.load (i32.shl (i32.load8_u offset=1 (local.get $inPos)) (i32.const 2))))
        (local.set $tb (f32.load (i32.shl (i32.load8_u offset=2 (local.get $inPos)) (i32.const 2))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 4)))
        (local.set $tro (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s00)) (f32.mul (local.get $tg) (local.get $s01))) (f32.mul (local.get $tb) (local.get $s02))))
        (local.set $tgo (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s10)) (f32.mul (local.get $tg) (local.get $s11))) (f32.mul (local.get $tb) (local.get $s12))))
        (local.set $tbo (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s20)) (f32.mul (local.get $tg) (local.get $s21))) (f32.mul (local.get $tb) (local.get $s22))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tro) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tgo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tbo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 3)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $tail_loop)))
  )

  ;; run_a_out(inputPtr, outputPtr, pixelCount)
  ;;   input  : 3 channels per pixel, u8
  ;;   output : 4 channels per pixel, u8
  ;;   alpha  : written opaque (255)
  (func (export "run_a_out") (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p      i32)
    (local $inPos  i32) (local $outPos i32)
    (local $ti i32)
    (local $s00 f32) (local $s01 f32) (local $s02 f32)
    (local $s10 f32) (local $s11 f32) (local $s12 f32)
    (local $s20 f32) (local $s21 f32) (local $s22 f32)
    (local $tr f32) (local $tg f32) (local $tb f32)
    (local $tro f32) (local $tgo f32) (local $tbo f32)

    (local.set $inPos  (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))

    ;; Matrix from memory into locals, ONCE per call.
    (local.set $s00 (f32.load offset=66560 (i32.const 0))) (local.set $s01 (f32.load offset=66564 (i32.const 0))) (local.set $s02 (f32.load offset=66568 (i32.const 0)))
    (local.set $s10 (f32.load offset=66572 (i32.const 0))) (local.set $s11 (f32.load offset=66576 (i32.const 0))) (local.set $s12 (f32.load offset=66580 (i32.const 0)))
    (local.set $s20 (f32.load offset=66584 (i32.const 0))) (local.set $s21 (f32.load offset=66588 (i32.const 0))) (local.set $s22 (f32.load offset=66592 (i32.const 0)))

    ;; --- one pixel per iteration -------------------------------------------
    ;; The same operations in the same order as one lane of the SIMD build, so
    ;; a host without SIMD gets the same bytes out, not merely similar ones.
    (block $tail_exit
      (loop $tail_loop
        (br_if $tail_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))
        (local.set $tr (f32.load (i32.shl (i32.load8_u (local.get $inPos)) (i32.const 2))))
        (local.set $tg (f32.load (i32.shl (i32.load8_u offset=1 (local.get $inPos)) (i32.const 2))))
        (local.set $tb (f32.load (i32.shl (i32.load8_u offset=2 (local.get $inPos)) (i32.const 2))))
        (i32.store8 offset=3 (local.get $outPos) (i32.const 255))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 3)))
        (local.set $tro (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s00)) (f32.mul (local.get $tg) (local.get $s01))) (f32.mul (local.get $tb) (local.get $s02))))
        (local.set $tgo (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s10)) (f32.mul (local.get $tg) (local.get $s11))) (f32.mul (local.get $tb) (local.get $s12))))
        (local.set $tbo (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s20)) (f32.mul (local.get $tg) (local.get $s21))) (f32.mul (local.get $tb) (local.get $s22))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tro) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tgo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tbo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 4)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $tail_loop)))
  )

  ;; run_a_copy(inputPtr, outputPtr, pixelCount)
  ;;   input  : 4 channels per pixel, u8
  ;;   output : 4 channels per pixel, u8
  ;;   alpha  : copied straight through, never colour-managed
  (func (export "run_a_copy") (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p      i32)
    (local $inPos  i32) (local $outPos i32)
    (local $ti i32)
    (local $s00 f32) (local $s01 f32) (local $s02 f32)
    (local $s10 f32) (local $s11 f32) (local $s12 f32)
    (local $s20 f32) (local $s21 f32) (local $s22 f32)
    (local $tr f32) (local $tg f32) (local $tb f32)
    (local $tro f32) (local $tgo f32) (local $tbo f32)

    (local.set $inPos  (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))

    ;; Matrix from memory into locals, ONCE per call.
    (local.set $s00 (f32.load offset=66560 (i32.const 0))) (local.set $s01 (f32.load offset=66564 (i32.const 0))) (local.set $s02 (f32.load offset=66568 (i32.const 0)))
    (local.set $s10 (f32.load offset=66572 (i32.const 0))) (local.set $s11 (f32.load offset=66576 (i32.const 0))) (local.set $s12 (f32.load offset=66580 (i32.const 0)))
    (local.set $s20 (f32.load offset=66584 (i32.const 0))) (local.set $s21 (f32.load offset=66588 (i32.const 0))) (local.set $s22 (f32.load offset=66592 (i32.const 0)))

    ;; --- one pixel per iteration -------------------------------------------
    ;; The same operations in the same order as one lane of the SIMD build, so
    ;; a host without SIMD gets the same bytes out, not merely similar ones.
    (block $tail_exit
      (loop $tail_loop
        (br_if $tail_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))
        (local.set $tr (f32.load (i32.shl (i32.load8_u (local.get $inPos)) (i32.const 2))))
        (local.set $tg (f32.load (i32.shl (i32.load8_u offset=1 (local.get $inPos)) (i32.const 2))))
        (local.set $tb (f32.load (i32.shl (i32.load8_u offset=2 (local.get $inPos)) (i32.const 2))))
        (i32.store8 offset=3 (local.get $outPos) (i32.load8_u offset=3 (local.get $inPos)))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 4)))
        (local.set $tro (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s00)) (f32.mul (local.get $tg) (local.get $s01))) (f32.mul (local.get $tb) (local.get $s02))))
        (local.set $tgo (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s10)) (f32.mul (local.get $tg) (local.get $s11))) (f32.mul (local.get $tb) (local.get $s12))))
        (local.set $tbo (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s20)) (f32.mul (local.get $tg) (local.get $s21))) (f32.mul (local.get $tb) (local.get $s22))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tro) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tgo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tbo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 4)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $tail_loop)))
  )

  ;; run_a_fill(inputPtr, outputPtr, pixelCount)
  ;;   input  : 4 channels per pixel, u8
  ;;   output : 4 channels per pixel, u8
  ;;   alpha  : written opaque (255)
  (func (export "run_a_fill") (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p      i32)
    (local $inPos  i32) (local $outPos i32)
    (local $ti i32)
    (local $s00 f32) (local $s01 f32) (local $s02 f32)
    (local $s10 f32) (local $s11 f32) (local $s12 f32)
    (local $s20 f32) (local $s21 f32) (local $s22 f32)
    (local $tr f32) (local $tg f32) (local $tb f32)
    (local $tro f32) (local $tgo f32) (local $tbo f32)

    (local.set $inPos  (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))

    ;; Matrix from memory into locals, ONCE per call.
    (local.set $s00 (f32.load offset=66560 (i32.const 0))) (local.set $s01 (f32.load offset=66564 (i32.const 0))) (local.set $s02 (f32.load offset=66568 (i32.const 0)))
    (local.set $s10 (f32.load offset=66572 (i32.const 0))) (local.set $s11 (f32.load offset=66576 (i32.const 0))) (local.set $s12 (f32.load offset=66580 (i32.const 0)))
    (local.set $s20 (f32.load offset=66584 (i32.const 0))) (local.set $s21 (f32.load offset=66588 (i32.const 0))) (local.set $s22 (f32.load offset=66592 (i32.const 0)))

    ;; --- one pixel per iteration -------------------------------------------
    ;; The same operations in the same order as one lane of the SIMD build, so
    ;; a host without SIMD gets the same bytes out, not merely similar ones.
    (block $tail_exit
      (loop $tail_loop
        (br_if $tail_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))
        (local.set $tr (f32.load (i32.shl (i32.load8_u (local.get $inPos)) (i32.const 2))))
        (local.set $tg (f32.load (i32.shl (i32.load8_u offset=1 (local.get $inPos)) (i32.const 2))))
        (local.set $tb (f32.load (i32.shl (i32.load8_u offset=2 (local.get $inPos)) (i32.const 2))))
        (i32.store8 offset=3 (local.get $outPos) (i32.const 255))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 4)))
        (local.set $tro (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s00)) (f32.mul (local.get $tg) (local.get $s01))) (f32.mul (local.get $tb) (local.get $s02))))
        (local.set $tgo (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s10)) (f32.mul (local.get $tg) (local.get $s11))) (f32.mul (local.get $tb) (local.get $s12))))
        (local.set $tbo (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s20)) (f32.mul (local.get $tg) (local.get $s21))) (f32.mul (local.get $tb) (local.get $s22))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tro) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tgo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tbo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 65535.0)) (f32.const 0.5))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 4)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $tail_loop)))
  )
)