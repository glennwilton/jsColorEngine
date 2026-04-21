;; ----------------------------------------------------------------------------
;; linear_lerp_simd.wat — WASM SIMD (v128) 1D LERP through a 33-entry u16 LUT
;; ----------------------------------------------------------------------------
;;
;; SIMD version of linear_lerp.wat. Processes 4 pixels per iteration
;; using the v128 i32x4 lane type.
;;
;; CAVEAT — and this is the whole point of running the POC:
;;
;;   WASM SIMD has no native gather. Each LUT lookup must be done
;;   lane-by-lane (extract index, scalar load, replace_lane). For LUT-
;;   heavy kernels like color management, this caps the SIMD speedup
;;   below the theoretical 4×. Pure arithmetic (no gather) is where
;;   SIMD shines — see the bench output for both numbers.
;;
;; The bench will tell us whether SIMD is worth pursuing for the
;; full 3D tetrahedral kernel (which needs 8 LUT lookups per pixel,
;; so the gather cost dominates even more).
;;
;; ----------------------------------------------------------------------------

(module
  (memory (export "memory") 1)

  ;; --------------------------------------------------------------------------
  ;; applyCurve_simd — 4 pixels per iteration via i32x4
  ;;
  ;; Boundary patch (val == 255) is applied per-lane via i32x4 select,
  ;; same as the scalar version. We process all 4 lanes through both
  ;; paths and select; this is faster than branching per lane in SIMD.
  ;; --------------------------------------------------------------------------
  (func $applyCurve_simd (export "applyCurve_simd")
    (param $input i32) (param $output i32) (param $lut i32) (param $length i32)
    (local $i i32)
    (local $vals v128)        ;; 4 input vals as i32x4
    (local $fp v128)          ;; vals * 32
    (local $idx v128)         ;; fp >> 8
    (local $w v128)           ;; fp & 0xFF
    (local $lo v128)          ;; lut[idx] per lane (gather)
    (local $hi v128)          ;; lut[idx+1] per lane (gather)
    (local $diff v128)        ;; hi - lo (signed)
    (local $u16 v128)         ;; interpolated value per lane
    (local $u8s v128)         ;; final u8 per lane (rounded)
    (local $is255 v128)       ;; mask: 0xFFFFFFFF where val == 255, else 0
    (local $boundary v128)    ;; (lut[32] + 0x80) >> 8 splatted
    (local $boundaryU16 i32)  ;; scalar lut[32]

    ;; Pre-compute the boundary value once (lut[32] is constant across iterations)
    (local.set $boundaryU16 (i32.load16_u offset=64 (local.get $lut)))
    (local.set $boundary
      (i32x4.splat
        (i32.shr_u (i32.add (local.get $boundaryU16) (i32.const 0x80)) (i32.const 8))))

    (local.set $i (i32.const 0))
    (block $end
      (loop $L
        ;; Stop if fewer than 4 pixels remain — the JS harness pads input
        ;; to a multiple of 4, so this is just a safety net.
        (br_if $end
          (i32.gt_u (i32.add (local.get $i) (i32.const 4)) (local.get $length)))

        ;; --- Load 4 u8 inputs as i32x4 -----------------------------------
        ;; Use 4 scalar loads + replace_lane. WASM has v128.load32_zero +
        ;; i16x8.extend_low_i8x16_u + i32x4.extend_low_i16x8_u for an 8-byte
        ;; load → 4 lanes, but our values are byte-spaced so manual is fine.
        (local.set $vals
          (i32x4.replace_lane 0
            (v128.const i32x4 0 0 0 0)
            (i32.load8_u (i32.add (local.get $input) (local.get $i)))))
        (local.set $vals
          (i32x4.replace_lane 1
            (local.get $vals)
            (i32.load8_u (i32.add (local.get $input) (i32.add (local.get $i) (i32.const 1))))))
        (local.set $vals
          (i32x4.replace_lane 2
            (local.get $vals)
            (i32.load8_u (i32.add (local.get $input) (i32.add (local.get $i) (i32.const 2))))))
        (local.set $vals
          (i32x4.replace_lane 3
            (local.get $vals)
            (i32.load8_u (i32.add (local.get $input) (i32.add (local.get $i) (i32.const 3))))))

        ;; --- 4-wide arithmetic (the "win" zone) --------------------------
        ;; fp = vals << 5
        (local.set $fp (i32x4.shl (local.get $vals) (i32.const 5)))
        ;; idx = fp >> 8
        (local.set $idx (i32x4.shr_u (local.get $fp) (i32.const 8)))
        ;; w = fp & 0xFF
        (local.set $w (v128.and (local.get $fp) (v128.const i32x4 0xFF 0xFF 0xFF 0xFF)))

        ;; --- Gather (the "limit" zone) ----------------------------------
        ;; Lane-by-lane scalar loads, then replace_lane. 4 lanes × 2 loads = 8 loads.
        ;; This is what kills SIMD speedup for LUT-heavy color math.
        (local.set $lo
          (i32x4.replace_lane 0
            (v128.const i32x4 0 0 0 0)
            (i32.load16_u
              (i32.add (local.get $lut)
                (i32.shl (i32x4.extract_lane 0 (local.get $idx)) (i32.const 1))))))
        (local.set $lo
          (i32x4.replace_lane 1 (local.get $lo)
            (i32.load16_u
              (i32.add (local.get $lut)
                (i32.shl (i32x4.extract_lane 1 (local.get $idx)) (i32.const 1))))))
        (local.set $lo
          (i32x4.replace_lane 2 (local.get $lo)
            (i32.load16_u
              (i32.add (local.get $lut)
                (i32.shl (i32x4.extract_lane 2 (local.get $idx)) (i32.const 1))))))
        (local.set $lo
          (i32x4.replace_lane 3 (local.get $lo)
            (i32.load16_u
              (i32.add (local.get $lut)
                (i32.shl (i32x4.extract_lane 3 (local.get $idx)) (i32.const 1))))))

        (local.set $hi
          (i32x4.replace_lane 0
            (v128.const i32x4 0 0 0 0)
            (i32.load16_u
              (i32.add (local.get $lut)
                (i32.shl
                  (i32.add (i32x4.extract_lane 0 (local.get $idx)) (i32.const 1))
                  (i32.const 1))))))
        (local.set $hi
          (i32x4.replace_lane 1 (local.get $hi)
            (i32.load16_u
              (i32.add (local.get $lut)
                (i32.shl
                  (i32.add (i32x4.extract_lane 1 (local.get $idx)) (i32.const 1))
                  (i32.const 1))))))
        (local.set $hi
          (i32x4.replace_lane 2 (local.get $hi)
            (i32.load16_u
              (i32.add (local.get $lut)
                (i32.shl
                  (i32.add (i32x4.extract_lane 2 (local.get $idx)) (i32.const 1))
                  (i32.const 1))))))
        (local.set $hi
          (i32x4.replace_lane 3 (local.get $hi)
            (i32.load16_u
              (i32.add (local.get $lut)
                (i32.shl
                  (i32.add (i32x4.extract_lane 3 (local.get $idx)) (i32.const 1))
                  (i32.const 1))))))

        ;; --- 4-wide arithmetic again -------------------------------------
        ;; diff = hi - lo (signed)
        (local.set $diff (i32x4.sub (local.get $hi) (local.get $lo)))
        ;; u16 = lo + ((diff * w + 0x80) >> 8)   ; arithmetic shift for signed
        (local.set $u16
          (i32x4.add
            (local.get $lo)
            (i32x4.shr_s
              (i32x4.add
                (i32x4.mul (local.get $diff) (local.get $w))
                (v128.const i32x4 0x80 0x80 0x80 0x80))
              (i32.const 8))))
        ;; u8s = (u16 + 0x80) >> 8
        (local.set $u8s
          (i32x4.shr_u
            (i32x4.add (local.get $u16)
              (v128.const i32x4 0x80 0x80 0x80 0x80))
            (i32.const 8)))

        ;; --- Boundary patch via select -----------------------------------
        ;; mask = vals == 255  (per lane, 0xFFFFFFFF or 0)
        (local.set $is255
          (i32x4.eq (local.get $vals) (v128.const i32x4 255 255 255 255)))
        ;; u8s = is255 ? boundary : u8s
        (local.set $u8s
          (v128.bitselect (local.get $boundary) (local.get $u8s) (local.get $is255)))

        ;; --- Store 4 u8 results ------------------------------------------
        (i32.store8 (i32.add (local.get $output) (local.get $i))
          (i32x4.extract_lane 0 (local.get $u8s)))
        (i32.store8 (i32.add (local.get $output) (i32.add (local.get $i) (i32.const 1)))
          (i32x4.extract_lane 1 (local.get $u8s)))
        (i32.store8 (i32.add (local.get $output) (i32.add (local.get $i) (i32.const 2)))
          (i32x4.extract_lane 2 (local.get $u8s)))
        (i32.store8 (i32.add (local.get $output) (i32.add (local.get $i) (i32.const 3)))
          (i32x4.extract_lane 3 (local.get $u8s)))

        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $L)
      )
    )
  )

  ;; --------------------------------------------------------------------------
  ;; vectorMul_simd — pure SIMD multiply, no LUT, no gather
  ;;
  ;; Computes output[i] = (input[i] * scalar) >> 8 for u8 arrays.
  ;; This is a "best case" for WASM SIMD — no scatter/gather, just
  ;; wide arithmetic. Useful as a control number to show what SIMD CAN
  ;; do when the algorithm fits.
  ;; --------------------------------------------------------------------------
  (func $vectorMul_simd (export "vectorMul_simd")
    (param $input i32) (param $output i32) (param $scalar i32) (param $length i32)
    (local $i i32)
    (local $bytes v128)       ;; 16 u8 input bytes
    (local $lo16 v128)        ;; lower 8 lanes as i16x8
    (local $hi16 v128)        ;; upper 8 lanes as i16x8
    (local $scalarVec v128)   ;; scalar splatted to i16x8

    (local.set $scalarVec (i16x8.splat (local.get $scalar)))
    (local.set $i (i32.const 0))
    (block $end
      (loop $L
        (br_if $end
          (i32.gt_u (i32.add (local.get $i) (i32.const 16)) (local.get $length)))

        ;; Load 16 u8 bytes
        (local.set $bytes
          (v128.load (i32.add (local.get $input) (local.get $i))))

        ;; Widen to two i16x8 vectors (low 8 lanes, high 8 lanes)
        (local.set $lo16 (i16x8.extend_low_i8x16_u (local.get $bytes)))
        (local.set $hi16 (i16x8.extend_high_i8x16_u (local.get $bytes)))

        ;; Multiply by scalar, shift down by 8
        (local.set $lo16
          (i16x8.shr_u (i16x8.mul (local.get $lo16) (local.get $scalarVec)) (i32.const 8)))
        (local.set $hi16
          (i16x8.shr_u (i16x8.mul (local.get $hi16) (local.get $scalarVec)) (i32.const 8)))

        ;; Narrow back to u8 and store 16 bytes
        (v128.store (i32.add (local.get $output) (local.get $i))
          (i8x16.narrow_i16x8_u (local.get $lo16) (local.get $hi16)))

        (local.set $i (i32.add (local.get $i) (i32.const 16)))
        (br $L)
      )
    )
  )
)
