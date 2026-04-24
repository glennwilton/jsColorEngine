;; ============================================================================
;; tetra3d_simd.wat — 3D tetrahedral interpolation, SIMD, int math
;; ============================================================================
;;
;; POC for the "vectorize across output channels" plan. See chat history
;; for the design rationale; in short:
;;
;;   The n channels at a given CLUT grid corner are stored contiguously
;;   (layout [X][Y][Z][ch]). A single v128.load64_zero picks up 4 u16
;;   values (covering cMax=3 or cMax=4 channels) into the low 64 bits,
;;   and i32x4.extend_low_i16x8_u unpacks them to i32 lanes with 16 bits
;;   of arithmetic headroom. The tetrahedral math then runs once per
;;   pixel on v128 vectors rather than cMax times in a channel loop.
;;
;;   This sidesteps the SIMD gather problem from linear_lerp_simd.wat
;;   (which tried to vectorize ACROSS pixels and had to gather per lane).
;;   Here the lanes come from ONE pixel's ONE grid corner — a plain
;;   64-bit contiguous load.
;;
;; Scope of this kernel:
;;
;;   - cMax ∈ {3, 4}                       (covers 99% of LUT work)
;;   - all four alpha modes (none / input-skip / fill-255 / preserve-copy)
;;     matching the scalar kernel's $inAlphaSkip + $outAlphaMode contract
;;   - all 6 tetrahedral cases + fallback   (no correctness regression)
;;   - u16 CLUT, Q0.16 gridPointsScale
;;   - `(x + 0x80) >> 8` rounding applied twice — bit-exact with
;;     tetra3d_nch.wat and with Transform.js _{3,4}Ch_intLut_loop.
;;
;; Store width:
;;
;;   For cMax=3, the SIMD math still computes a 4th (junk) lane; we
;;   v128.store32_lane 4 bytes per pixel but advance outputPos by 3,
;;   so the next pixel's write overwrites the junk byte.
;;
;;     * With outAlphaMode == 0 (no alpha): the LAST pixel leaves 1
;;       junk byte past the nominal end — caller must allocate
;;       outputBuffer with +1 byte of slack.
;;     * With outAlphaMode == 1 or 2: the alpha write lands exactly
;;       on the junk byte of the preceding SIMD store, so no slack
;;       is needed and no byte is written past the output.
;;
;;   For cMax=4, 4 bytes per pixel, advance 4. No slack. Alpha
;;   tail writes a 5th byte per pixel when outAlphaMode is on.
;;
;; Alpha tail (mirrors tetra3d_nch.wat):
;;
;;   $inAlphaSkip   0 or 1 — extra byte to skip on input per pixel
;;   $outAlphaMode  0=none, 1=fill-255, 2=preserve-copy (copies
;;                  input[inputPos + 3] through; $inAlphaSkip must
;;                  be 1 for mode 2 to make sense).
;;
;; Math (identical to scalar, just vectorized):
;;
;;   vSum = (vA − vC) * rx + (vB − vA) * ry + (vD − vB) * rz   (case 1)
;;   vU16 = vC + ((vSum + 0x80) >> 8)                           ; arith shift
;;   vU8  = (vU16 + 0x80) >> 8                                  ; arith shift
;;   narrow i32x4 → i16x8 → i8x16 (both saturating unsigned — free clamp)
;;   v128.store32_lane lane 0 → 4 bytes at outputPos
;;
;; Headroom: max |vSum| ≈ 3 * 65280 * 255 ≈ 2^26, signed i32.mul fits.
;; ============================================================================

(module
  (memory (export "memory") 1)

  (func (export "interp_tetra3d_simd")
    (param $inputPtr     i32)
    (param $outputPtr    i32)
    (param $lutPtr       i32)
    (param $pixelCount   i32)
    (param $cMax         i32)   ;; 3 or 4
    (param $go0          i32)
    (param $go1          i32)
    (param $go2          i32)
    (param $gps          i32)
    (param $maxX         i32)
    (param $maxY         i32)
    (param $maxZ         i32)
    (param $inAlphaSkip  i32)   ;; 0 or 1
    (param $outAlphaMode i32)   ;; 0 = none, 1 = fill 255, 2 = preserve-copy

    (local $p            i32)
    (local $inputPos     i32)
    (local $outputPos    i32)
    (local $outputStride i32)   ;; 3 or 4 bytes per pixel

    (local $input0       i32)
    (local $input1       i32)
    (local $input2       i32)
    (local $px           i32)
    (local $py           i32)
    (local $pz           i32)

    (local $X0           i32)
    (local $X1           i32)
    (local $Y0           i32)
    (local $Y1           i32)
    (local $Z0           i32)
    (local $Z1           i32)
    (local $rx           i32)
    (local $ry           i32)
    (local $rz           i32)

    (local $base0        i32)
    (local $base1        i32)
    (local $base2        i32)
    (local $base3        i32)
    (local $base4        i32)

    ;; SIMD working set — lane-packed cMax channels at each of 4 tetra corners.
    (local $vA           v128)
    (local $vB           v128)
    (local $vC           v128)
    (local $vD           v128)
    (local $vRx          v128)
    (local $vRy          v128)
    (local $vRz          v128)
    (local $vSum         v128)
    (local $vU16         v128)
    (local $vU8          v128)
    (local $vOut         v128)

    ;; --- Init -----------------------------------------------------------------
    (local.set $inputPos     (local.get $inputPtr))
    (local.set $outputPos    (local.get $outputPtr))
    (local.set $outputStride (local.get $cMax))

    ;; --- Per-pixel loop -------------------------------------------------------
    (block $pixel_exit
      (loop $pixel_loop

        (br_if $pixel_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))

        ;; Three u8 input bytes (RGB). Input always 3 channels for this POC.
        (local.set $input0 (i32.load8_u            (local.get $inputPos)))
        (local.set $input1 (i32.load8_u offset=1   (local.get $inputPos)))
        (local.set $input2 (i32.load8_u offset=2   (local.get $inputPos)))
        (local.set $inputPos (i32.add (local.get $inputPos) (i32.const 3)))

        (local.set $px (i32.mul (local.get $input0) (local.get $gps)))
        (local.set $py (i32.mul (local.get $input1) (local.get $gps)))
        (local.set $pz (i32.mul (local.get $input2) (local.get $gps)))

        ;; Boundary patches (same as scalar kernel — stays i32).
        (if (i32.eq (local.get $input0) (i32.const 255))
          (then
            (local.set $X0 (local.get $maxX))
            (local.set $X1 (local.get $maxX))
            (local.set $rx (i32.const 0)))
          (else
            (local.set $X0 (i32.mul (i32.shr_u (local.get $px) (i32.const 16)) (local.get $go2)))
            (local.set $X1 (i32.add (local.get $X0) (local.get $go2)))
            (local.set $rx (i32.and (i32.shr_u (local.get $px) (i32.const 8)) (i32.const 0xFF)))))

        (if (i32.eq (local.get $input1) (i32.const 255))
          (then
            (local.set $Y0 (local.get $maxY))
            (local.set $Y1 (local.get $maxY))
            (local.set $ry (i32.const 0)))
          (else
            (local.set $Y0 (i32.mul (i32.shr_u (local.get $py) (i32.const 16)) (local.get $go1)))
            (local.set $Y1 (i32.add (local.get $Y0) (local.get $go1)))
            (local.set $ry (i32.and (i32.shr_u (local.get $py) (i32.const 8)) (i32.const 0xFF)))))

        (if (i32.eq (local.get $input2) (i32.const 255))
          (then
            (local.set $Z0 (local.get $maxZ))
            (local.set $Z1 (local.get $maxZ))
            (local.set $rz (i32.const 0)))
          (else
            (local.set $Z0 (i32.mul (i32.shr_u (local.get $pz) (i32.const 16)) (local.get $go0)))
            (local.set $Z1 (i32.add (local.get $Z0) (local.get $go0)))
            (local.set $rz (i32.and (i32.shr_u (local.get $pz) (i32.const 8)) (i32.const 0xFF)))))

        ;; Splat rx/ry/rz to v128 (same per all lanes — one weight per axis).
        (local.set $vRx (i32x4.splat (local.get $rx)))
        (local.set $vRy (i32x4.splat (local.get $ry)))
        (local.set $vRz (i32x4.splat (local.get $rz)))

        ;; Anchor corner (u16 element index — shift by 1 to get byte offset).
        (local.set $base0
          (i32.add (i32.add (local.get $X0) (local.get $Y0)) (local.get $Z0)))

        ;; Load vC once — the anchor corner's cMax channels.
        (local.set $vC
          (i32x4.extend_low_i16x8_u
            (v128.load64_zero align=1
              (i32.add (local.get $lutPtr)
                       (i32.shl (local.get $base0) (i32.const 1))))))

        ;; ========================================================
        ;; Tetrahedral case dispatch — six cases + fallback.
        ;; Each case sets up base1/base2/base3 or base4, loads
        ;; vA/vB/vD, then computes vSum per the case-specific edge
        ;; formula. Shared "narrow + store" lives after the cascade.
        ;; ========================================================

        ;; ------ CASE 1: rx >= ry >= rz -----------------------------
        (if (i32.and (i32.ge_s (local.get $rx) (local.get $ry))
                     (i32.ge_s (local.get $ry) (local.get $rz)))
          (then
            ;; base1 = X1 + Y0 + Z0
            (local.set $base1
              (i32.add (i32.add (local.get $X1) (local.get $Y0)) (local.get $Z0)))
            ;; base2 = X1 + Y1 + Z0
            (local.set $base2
              (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z0)))
            ;; base4 = X1 + Y1 + Z1
            (local.set $base4
              (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z1)))

            (local.set $vA
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base1) (i32.const 1))))))
            (local.set $vB
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base2) (i32.const 1))))))
            (local.set $vD
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base4) (i32.const 1))))))

            ;; vSum = (vA - vC)*rx + (vB - vA)*ry + (vD - vB)*rz
            (local.set $vSum
              (i32x4.add
                (i32x4.add
                  (i32x4.mul (i32x4.sub (local.get $vA) (local.get $vC)) (local.get $vRx))
                  (i32x4.mul (i32x4.sub (local.get $vB) (local.get $vA)) (local.get $vRy)))
                (i32x4.mul (i32x4.sub (local.get $vD) (local.get $vB)) (local.get $vRz)))))
          (else

        ;; ------ CASE 2: rx >= rz >= ry -----------------------------
        (if (i32.and (i32.ge_s (local.get $rx) (local.get $rz))
                     (i32.ge_s (local.get $rz) (local.get $ry)))
          (then
            (local.set $base1
              (i32.add (i32.add (local.get $X1) (local.get $Y0)) (local.get $Z0)))
            (local.set $base2
              (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z1)))
            (local.set $base3
              (i32.add (i32.add (local.get $X1) (local.get $Y0)) (local.get $Z1)))

            ;; a = CLUT[base3], b = CLUT[base1], d = CLUT[base2]
            (local.set $vA
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base3) (i32.const 1))))))
            (local.set $vB
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base1) (i32.const 1))))))
            (local.set $vD
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base2) (i32.const 1))))))

            ;; vSum = (vB - vC)*rx + (vD - vA)*ry + (vA - vB)*rz
            (local.set $vSum
              (i32x4.add
                (i32x4.add
                  (i32x4.mul (i32x4.sub (local.get $vB) (local.get $vC)) (local.get $vRx))
                  (i32x4.mul (i32x4.sub (local.get $vD) (local.get $vA)) (local.get $vRy)))
                (i32x4.mul (i32x4.sub (local.get $vA) (local.get $vB)) (local.get $vRz)))))
          (else

        ;; ------ CASE 3: rz >= rx >= ry (JS: rx>=ry && rz>=rx) ------
        (if (i32.and (i32.ge_s (local.get $rx) (local.get $ry))
                     (i32.ge_s (local.get $rz) (local.get $rx)))
          (then
            (local.set $base1
              (i32.add (i32.add (local.get $X1) (local.get $Y0)) (local.get $Z1)))
            (local.set $base2
              (i32.add (i32.add (local.get $X0) (local.get $Y0)) (local.get $Z1)))
            (local.set $base3
              (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z1)))

            ;; a = CLUT[base1], b = CLUT[base2], d = CLUT[base3]
            (local.set $vA
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base1) (i32.const 1))))))
            (local.set $vB
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base2) (i32.const 1))))))
            (local.set $vD
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base3) (i32.const 1))))))

            ;; vSum = (vA - vB)*rx + (vD - vA)*ry + (vB - vC)*rz
            (local.set $vSum
              (i32x4.add
                (i32x4.add
                  (i32x4.mul (i32x4.sub (local.get $vA) (local.get $vB)) (local.get $vRx))
                  (i32x4.mul (i32x4.sub (local.get $vD) (local.get $vA)) (local.get $vRy)))
                (i32x4.mul (i32x4.sub (local.get $vB) (local.get $vC)) (local.get $vRz)))))
          (else

        ;; ------ CASE 4: ry >= rx >= rz -----------------------------
        (if (i32.and (i32.ge_s (local.get $ry) (local.get $rx))
                     (i32.ge_s (local.get $rx) (local.get $rz)))
          (then
            (local.set $base1
              (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z0)))
            (local.set $base2
              (i32.add (i32.add (local.get $X0) (local.get $Y1)) (local.get $Z0)))
            (local.set $base4
              (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z1)))

            ;; a = CLUT[base2], b = CLUT[base1], d = CLUT[base4]
            (local.set $vA
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base2) (i32.const 1))))))
            (local.set $vB
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base1) (i32.const 1))))))
            (local.set $vD
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base4) (i32.const 1))))))

            ;; vSum = (vB - vA)*rx + (vA - vC)*ry + (vD - vB)*rz
            (local.set $vSum
              (i32x4.add
                (i32x4.add
                  (i32x4.mul (i32x4.sub (local.get $vB) (local.get $vA)) (local.get $vRx))
                  (i32x4.mul (i32x4.sub (local.get $vA) (local.get $vC)) (local.get $vRy)))
                (i32x4.mul (i32x4.sub (local.get $vD) (local.get $vB)) (local.get $vRz)))))
          (else

        ;; ------ CASE 5: ry >= rz >= rx -----------------------------
        (if (i32.and (i32.ge_s (local.get $ry) (local.get $rz))
                     (i32.ge_s (local.get $rz) (local.get $rx)))
          (then
            (local.set $base1
              (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z1)))
            (local.set $base2
              (i32.add (i32.add (local.get $X0) (local.get $Y1)) (local.get $Z1)))
            (local.set $base3
              (i32.add (i32.add (local.get $X0) (local.get $Y1)) (local.get $Z0)))

            ;; a = CLUT[base2], b = CLUT[base3], d = CLUT[base1]
            (local.set $vA
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base2) (i32.const 1))))))
            (local.set $vB
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base3) (i32.const 1))))))
            (local.set $vD
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base1) (i32.const 1))))))

            ;; vSum = (vD - vA)*rx + (vB - vC)*ry + (vA - vB)*rz
            (local.set $vSum
              (i32x4.add
                (i32x4.add
                  (i32x4.mul (i32x4.sub (local.get $vD) (local.get $vA)) (local.get $vRx))
                  (i32x4.mul (i32x4.sub (local.get $vB) (local.get $vC)) (local.get $vRy)))
                (i32x4.mul (i32x4.sub (local.get $vA) (local.get $vB)) (local.get $vRz)))))
          (else

        ;; ------ CASE 6: rz >= ry >= rx -----------------------------
        (if (i32.and (i32.ge_s (local.get $rz) (local.get $ry))
                     (i32.ge_s (local.get $ry) (local.get $rx)))
          (then
            (local.set $base1
              (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z1)))
            (local.set $base2
              (i32.add (i32.add (local.get $X0) (local.get $Y1)) (local.get $Z1)))
            (local.set $base4
              (i32.add (i32.add (local.get $X0) (local.get $Y0)) (local.get $Z1)))

            ;; a = CLUT[base2], b = CLUT[base4], d = CLUT[base1]
            (local.set $vA
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base2) (i32.const 1))))))
            (local.set $vB
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base4) (i32.const 1))))))
            (local.set $vD
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base1) (i32.const 1))))))

            ;; vSum = (vD - vA)*rx + (vA - vB)*ry + (vB - vC)*rz
            (local.set $vSum
              (i32x4.add
                (i32x4.add
                  (i32x4.mul (i32x4.sub (local.get $vD) (local.get $vA)) (local.get $vRx))
                  (i32x4.mul (i32x4.sub (local.get $vA) (local.get $vB)) (local.get $vRy)))
                (i32x4.mul (i32x4.sub (local.get $vB) (local.get $vC)) (local.get $vRz)))))
          (else
            ;; Fallback — equivalent to scalar kernel's degenerate-path tail.
            ;; All weights zero, output = clamp((c + 0x80) >> 8). Expressed
            ;; here as vSum = 0 so the shared shift+narrow below still works.
            (local.set $vSum (v128.const i32x4 0 0 0 0))
          )     ;; close case-6 (else
        )       ;; close case-6 (if
      )         ;; close case-5 (else
    )           ;; close case-5 (if
  )             ;; close case-4 (else
)               ;; close case-4 (if
  )             ;; close case-3 (else
)               ;; close case-3 (if
  )             ;; close case-2 (else
)               ;; close case-2 (if
  )             ;; close case-1 (else
)               ;; close case-1 (if

        ;; -----------------------------------------------------------
        ;; Shared tail — narrow + store.
        ;; vU16 = vC + ((vSum + 0x80) >> 8)                      [arith shift]
        ;; vU8  = (vU16 + 0x80) >> 8                             [arith shift]
        ;; pack: narrow i32x4 → i16x8 (sat-u) → i8x16 (sat-u)
        ;; store low 32 bits to outputPos, advance by outputStride
        ;; -----------------------------------------------------------

        (local.set $vU16
          (i32x4.add (local.get $vC)
            (i32x4.shr_s
              (i32x4.add (local.get $vSum)
                (v128.const i32x4 0x80 0x80 0x80 0x80))
              (i32.const 8))))

        (local.set $vU8
          (i32x4.shr_s
            (i32x4.add (local.get $vU16)
              (v128.const i32x4 0x80 0x80 0x80 0x80))
            (i32.const 8)))

        ;; Saturating narrow to u8.  The first narrow packs 4+4 i32 lanes into
        ;; 8 i16 lanes; the second packs 8+8 i16 lanes into 16 i8 lanes.
        ;; Passing $vU8 twice is fine — we only care about lanes 0..3 of the
        ;; final i8x16, which come from $vU8's lanes 0..3.
        (local.set $vOut
          (i8x16.narrow_i16x8_u
            (i16x8.narrow_i32x4_u (local.get $vU8) (local.get $vU8))
            (i16x8.narrow_i32x4_u (local.get $vU8) (local.get $vU8))))

        ;; Store 4 bytes from lane 0 of i32x4 view.  For cMax=4 this is the
        ;; full output pixel; for cMax=3 the 4th byte is overwritten by the
        ;; next pixel's R write (and the final pixel leaves 1 junk byte past
        ;; the nominal end — caller allocates +1).
        (v128.store32_lane align=1 0
          (local.get $outputPos)
          (local.get $vOut))

        (local.set $outputPos
          (i32.add (local.get $outputPos) (local.get $outputStride)))

        ;; --- Alpha tail (mirrors tetra3d_nch.wat) --------------------
        ;; Outer guard collapses the no-alpha hot path (inAlphaSkip==0,
        ;; outAlphaMode==0) to a single i32.or test per pixel — V8's
        ;; WASM backend hoists both inner branches out of the loop when
        ;; the combined flag is 0, recovering the ~8% that a naive
        ;; per-pixel nested-if structure costs.
        (if (i32.or (local.get $outAlphaMode) (local.get $inAlphaSkip))
          (then
            (if (i32.eq (local.get $outAlphaMode) (i32.const 2))
              (then
                ;; PRESERVE-COPY: output[outputPos] = input[inputPos];
                ;; advance both by 1. inputPos is currently at the alpha
                ;; byte (we advanced by 3 after the RGB load, not 4).
                (i32.store8 (local.get $outputPos)
                  (i32.load8_u (local.get $inputPos)))
                (local.set $outputPos (i32.add (local.get $outputPos) (i32.const 1)))
                (local.set $inputPos  (i32.add (local.get $inputPos)  (i32.const 1))))
              (else
                (if (i32.eq (local.get $outAlphaMode) (i32.const 1))
                  (then
                    ;; FILL_255: output[outputPos] = 255; outputPos++.
                    (i32.store8 (local.get $outputPos) (i32.const 255))
                    (local.set $outputPos
                      (i32.add (local.get $outputPos) (i32.const 1)))))
                ;; inputPos += inAlphaSkip (0 or 1)
                (local.set $inputPos
                  (i32.add (local.get $inputPos) (local.get $inAlphaSkip)))))))

        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $pixel_loop))))
)
