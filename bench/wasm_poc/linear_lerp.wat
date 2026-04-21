;; ----------------------------------------------------------------------------
;; linear_lerp.wat — WASM scalar 1D LERP through a 33-entry u16 LUT
;; ----------------------------------------------------------------------------
;;
;; This is the WASM scalar baseline for the POC. It applies a 33-entry
;; u16 LUT to a u8 input array, producing a u8 output array, using
;; linear interpolation between adjacent LUT entries.
;;
;; This kernel matches the math of jsColorEngine's v1.1 lutMode: 'int' path
;; one axis at a time (no tetrahedral 3D selection — just 1D LERP).
;; If WASM scalar is meaningfully faster than JS for this kernel,
;; WASM is worth pursuing for the full 3D kernel. If not, WASM only
;; pays off via SIMD (see linear_lerp_simd.wat).
;;
;; Memory layout (caller's responsibility):
;;   $input  : N bytes, u8     (N = $length)
;;   $output : N bytes, u8     (N = $length)
;;   $lut    : 66 bytes, u16   (33 entries × 2 bytes each)
;;
;; Math per pixel (matches the production fastLUT pattern):
;;   val = input[i]                                   ;; u8
;;   if val == 255:                                   ;; boundary patch
;;     u8 = (lut[32] + 0x80) >> 8
;;   else:
;;     fp  = val * 32                                 ;; Q0.8 [0..8159]
;;     idx = fp >> 8                                  ;; integer grid index [0..31]
;;     w   = fp & 0xFF                                ;; Q0.8 fractional weight [0..255]
;;     lo  = lut[idx]                                 ;; u16
;;     hi  = lut[idx+1]                               ;; u16
;;     u16 = lo + (((hi - lo) * w + 0x80) >> 8)       ;; signed shift — (hi-lo) can be negative
;;     u8  = (u16 + 0x80) >> 8
;;
;; The "+ 0x80 >> 8" pattern is round-to-nearest for u8 conversion,
;; same as the v1.1 lutMode: 'int' FINDING #5 (single-step rounding).
;; ----------------------------------------------------------------------------

(module
  (memory (export "memory") 1)  ;; 1 page = 64KB initial; bench grows as needed

  (func $applyCurve_scalar (export "applyCurve_scalar")
    (param $input i32) (param $output i32) (param $lut i32) (param $length i32)
    (local $i i32)
    (local $val i32)
    (local $fp i32)
    (local $idx i32)
    (local $w i32)
    (local $lo i32)
    (local $hi i32)
    (local $u16 i32)

    (local.set $i (i32.const 0))
    (block $end
      (loop $L
        (br_if $end (i32.ge_u (local.get $i) (local.get $length)))

        ;; val = input[i]
        (local.set $val
          (i32.load8_u (i32.add (local.get $input) (local.get $i))))

        (if (i32.eq (local.get $val) (i32.const 255))
          (then
            ;; Boundary: u8 = (lut[32] + 0x80) >> 8
            (local.set $u16
              (i32.load16_u offset=64 (local.get $lut)))
            (i32.store8
              (i32.add (local.get $output) (local.get $i))
              (i32.shr_u
                (i32.add (local.get $u16) (i32.const 0x80))
                (i32.const 8)))
          )
          (else
            ;; fp = val << 5  (i.e. val * 32)
            (local.set $fp (i32.shl (local.get $val) (i32.const 5)))
            ;; idx = fp >> 8
            (local.set $idx (i32.shr_u (local.get $fp) (i32.const 8)))
            ;; w = fp & 0xFF
            (local.set $w (i32.and (local.get $fp) (i32.const 0xFF)))

            ;; lo = lut[idx]      (u16, 2 bytes per entry)
            (local.set $lo
              (i32.load16_u
                (i32.add
                  (local.get $lut)
                  (i32.shl (local.get $idx) (i32.const 1)))))
            ;; hi = lut[idx+1]
            (local.set $hi
              (i32.load16_u
                (i32.add
                  (local.get $lut)
                  (i32.shl (i32.add (local.get $idx) (i32.const 1)) (i32.const 1)))))

            ;; u16 = lo + (((hi - lo) * w + 0x80) >> 8)
            ;; signed shift because (hi - lo) can be negative for non-monotonic curves
            (local.set $u16
              (i32.add
                (local.get $lo)
                (i32.shr_s
                  (i32.add
                    (i32.mul
                      (i32.sub (local.get $hi) (local.get $lo))
                      (local.get $w))
                    (i32.const 0x80))
                  (i32.const 8))))

            ;; u8 = (u16 + 0x80) >> 8 ; store
            (i32.store8
              (i32.add (local.get $output) (local.get $i))
              (i32.shr_u
                (i32.add (local.get $u16) (i32.const 0x80))
                (i32.const 8)))
          )
        )

        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $L)
      )
    )
  )
)
