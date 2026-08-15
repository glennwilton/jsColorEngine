;; ============================================================================
;; tetra3d_simd_int16.wat — 3D tetrahedral interpolation, SIMD, u16 I/O
;;                          v1.3 (Q0.13 fractional weights, true 16-bit)
;; ============================================================================
;;
;; SIMD u16 sibling of tetra3d_simd.wat (u8 SIMD) and tetra3d_nch_int16.wat
;; (scalar u16). Same "vectorize across output channels" strategy:
;;
;;   The cMax channels at a given CLUT grid corner are stored contiguously
;;   (layout [X][Y][Z][ch]). A single v128.load64_zero picks up 4 u16
;;   values (covering cMax=3 with one junk lane, or cMax=4 exactly) into
;;   the low 64 bits, and i32x4.extend_low_i16x8_u unpacks them to i32
;;   lanes with 16 bits of arithmetic headroom. The tetrahedral math then
;;   runs once per pixel on v128 vectors rather than cMax times in a
;;   channel loop.
;;
;; Q0.13 contract (shared with tetra3d_nch_int16.wat / JS u16 kernels):
;; -------------------------------------------------------------------
;; - CLUT data scale: 65535 (FULL u16 range)
;; - Input grid scale: gridPointsScale_fixed_u16, Q0.13 (passed in as $gps)
;; - Boundary patch: input == 65535 (NOT 65280)
;; - Per-channel math (vectorised across cMax lanes):
;;       vSum = (vA - vC)*vRx + (vB - vA)*vRy + (vD - vB)*vRz   (case 1)
;;       vU16 = vC + ((vSum + 0x1000) >> 13)                    ; round-to-nearest at u13
;; - Saturating narrow i32x4 → i16x8 (u-saturate clamps [0, 65535] into u16)
;; - v128.store64_lane writes 8 bytes (4 × u16) per pixel
;;
;; No second-rounding bit-stretch — the CLUT is at full u16 scale, so the
;; c-corner enters at full precision and only the within-cell delta gets
;; quantized at the >>13 step. Worst-case kernel quantization error
;; ≤ 1 LSB at u16. Bit-exact against tetra3d_nch_int16.wat and
;; tetrahedralInterp3DArray_{3,4}Ch_intLut16_loop in src/Transform.js.
;;
;; i32 overflow analysis (per lane — same envelope as scalar u16 path):
;; --------------------------------------------------------------------
;; - corner_u16 - corner_u16  → s17  (signed 17-bit)
;; - i32x4.mul(s17, u13)      → s30  (Wasm SIMD i32x4.mul wraps mod 2^32,
;;                                    matching JS Math.imul exactly — the
;;                                    bit-exact contract holds across SIMD
;;                                    + scalar + JS implementations)
;; - sum of 3 terms           → s30.6 (~1.4 bits headroom in i32)
;; - + 0x1000 (round bias)    → fits s31
;; - >> 13 (i32x4.shr_s)      → s17.6
;; - + corner_u16             → fits s31 trivially
;;
;; Store width & slack:
;;
;;   For cMax=3, the SIMD math computes a 4th (junk) lane; v128.store64_lane
;;   writes 8 bytes (4 × u16) per pixel and outputPos advances by 6 (the
;;   nominal 3 channels × 2 bytes). The next pixel's first u16 store
;;   overwrites the junk u16, so it never escapes — except on the FINAL
;;   pixel when outAlphaMode == 0, where 2 junk bytes leak past the
;;   nominal end.
;;     * outAlphaMode == 0 (no alpha): caller must pad output with +2
;;       bytes of slack (we use +4 in Tetra3DInt16State for alignment).
;;     * outAlphaMode ∈ {1, 2}: the alpha write (2 bytes) lands exactly
;;       on the junk u16, so no slack is consumed.
;;
;;   For cMax=4, 8 bytes per pixel, advance 8. No slack. Alpha tail
;;   adds 2 bytes per pixel when on.
;;
;; Alpha tail (mirrors tetra3d_nch_int16.wat — u16 stride):
;;   $inAlphaSkip   0 or 1 — alpha samples to skip after RGB per pixel
;;                  (kernel internally shifts by 1 for byte stride)
;;   $outAlphaMode  0 = none, 1 = fill 0xFFFF, 2 = preserve-copy 1 u16
;;
;; v1.2 (u8) baggage NOT present (this kernel is born u16 / Q0.13):
;;   - no `>> 16` shifts → uses `>> 13` for Q0.13
;;   - no `(px >> 8) & 0xFF` → uses `px & 0x1FFF`
;;   - no double-rounding `(>> 8) >> 8` → single rounding `(+0x1000) >> 13`
;;   - no `i8x16.narrow_i16x8_u` → output is u16 directly
;;
;; ============================================================================

(module
  (memory (export "memory") 1)

  (func (export "interp_tetra3d_simd_int16")
    (param $inputPtr     i32)
    (param $outputPtr    i32)
    (param $lutPtr       i32)
    (param $pixelCount   i32)
    (param $cMax         i32)   ;; 3 or 4
    (param $go0          i32)
    (param $go1          i32)
    (param $go2          i32)
    (param $gps          i32)   ;; gridPointsScale_fixed_u16 (Q0.13)
    (param $maxX         i32)
    (param $maxY         i32)
    (param $maxZ         i32)
    (param $inAlphaSkip  i32)   ;; 0 or 1 (samples; stride is 2 bytes)
    (param $outAlphaMode i32)   ;; 0 = none, 1 = fill 0xFFFF, 2 = preserve-copy

    (local $p            i32)
    (local $inputPos     i32)
    (local $outputPos    i32)
    (local $outputStride i32)   ;; cMax * 2 bytes per pixel

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
    (local $vOut         v128)

    ;; --- Init -----------------------------------------------------------------
    (local.set $inputPos     (local.get $inputPtr))
    (local.set $outputPos    (local.get $outputPtr))
    ;; outputStride = cMax * 2 (bytes per pixel)
    (local.set $outputStride (i32.shl (local.get $cMax) (i32.const 1)))

    ;; --- Per-pixel loop -------------------------------------------------------
    (block $pixel_exit
      (loop $pixel_loop

        (br_if $pixel_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))

        ;; Three u16 input samples (RGB). Stride 2 bytes per sample, 6 per pixel.
        (local.set $input0 (i32.load16_u            (local.get $inputPos)))
        (local.set $input1 (i32.load16_u offset=2   (local.get $inputPos)))
        (local.set $input2 (i32.load16_u offset=4   (local.get $inputPos)))
        (local.set $inputPos (i32.add (local.get $inputPos) (i32.const 6)))

        ;; px = input * gps  (u16 * Q0.13 — fits i32 with 3 bits headroom)
        (local.set $px (i32.mul (local.get $input0) (local.get $gps)))
        (local.set $py (i32.mul (local.get $input1) (local.get $gps)))
        (local.set $pz (i32.mul (local.get $input2) (local.get $gps)))

        ;; Boundary patches (u16: input === 65535 → clamp). Same as scalar
        ;; u16 kernel, just splats rx/ry/rz at the end. Stays i32.
        (if (i32.eq (local.get $input0) (i32.const 65535))
          (then
            (local.set $X0 (local.get $maxX))
            (local.set $X1 (local.get $maxX))
            (local.set $rx (i32.const 0)))
          (else
            (local.set $X0 (i32.mul (i32.shr_u (local.get $px) (i32.const 13)) (local.get $go2)))
            (local.set $X1 (i32.add (local.get $X0) (local.get $go2)))
            (local.set $rx (i32.and (local.get $px) (i32.const 0x1FFF)))))

        (if (i32.eq (local.get $input1) (i32.const 65535))
          (then
            (local.set $Y0 (local.get $maxY))
            (local.set $Y1 (local.get $maxY))
            (local.set $ry (i32.const 0)))
          (else
            (local.set $Y0 (i32.mul (i32.shr_u (local.get $py) (i32.const 13)) (local.get $go1)))
            (local.set $Y1 (i32.add (local.get $Y0) (local.get $go1)))
            (local.set $ry (i32.and (local.get $py) (i32.const 0x1FFF)))))

        (if (i32.eq (local.get $input2) (i32.const 65535))
          (then
            (local.set $Z0 (local.get $maxZ))
            (local.set $Z1 (local.get $maxZ))
            (local.set $rz (i32.const 0)))
          (else
            (local.set $Z0 (i32.mul (i32.shr_u (local.get $pz) (i32.const 13)) (local.get $go0)))
            (local.set $Z1 (i32.add (local.get $Z0) (local.get $go0)))
            (local.set $rz (i32.and (local.get $pz) (i32.const 0x1FFF)))))

        ;; Splat rx/ry/rz to v128 (one per axis, broadcast to 4 lanes).
        (local.set $vRx (i32x4.splat (local.get $rx)))
        (local.set $vRy (i32x4.splat (local.get $ry)))
        (local.set $vRz (i32x4.splat (local.get $rz)))

        ;; Anchor corner (u16 element index — shift by 1 to get byte offset).
        (local.set $base0
          (i32.add (i32.add (local.get $X0) (local.get $Y0)) (local.get $Z0)))

        ;; Load vC once — anchor corner's cMax channels (4 u16 → 4 i32 lanes).
        (local.set $vC
          (i32x4.extend_low_i16x8_u
            (v128.load64_zero align=1
              (i32.add (local.get $lutPtr)
                       (i32.shl (local.get $base0) (i32.const 1))))))

        ;; ========================================================
        ;; Tetrahedral case dispatch — six cases + fallback.
        ;; Each case sets up base1/base2/base3 or base4, loads
        ;; vA/vB/vD, then computes vSum per the case-specific edge
        ;; formula. Shared "round + narrow + store" lives after the cascade.
        ;; ========================================================

        ;; ------ CASE 1: rx >= ry >= rz -----------------------------
        (if (i32.and (i32.ge_s (local.get $rx) (local.get $ry))
                     (i32.ge_s (local.get $ry) (local.get $rz)))
          (then
            (local.set $base1
              (i32.add (i32.add (local.get $X1) (local.get $Y0)) (local.get $Z0)))
            (local.set $base2
              (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z0)))
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
            ;; Fallback — degenerate path. vSum = 0; final tail rounds to
            ;; out = vC + ((0 + 0x1000) >> 13) = vC. Bit-exact with the
            ;; scalar u16 kernel's `out = c` fallback (the +0x1000 round
            ;; bias falls below the >>13 threshold).
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
        ;; Shared tail — round + narrow + store.
        ;; vU16 = vC + ((vSum + 0x1000) >> 13)                  [arith shift]
        ;; pack: narrow i32x4 → i16x8 (sat-u clamps lanes to [0, 65535])
        ;; store low 64 bits to outputPos, advance by outputStride
        ;; -----------------------------------------------------------

        (local.set $vU16
          (i32x4.add (local.get $vC)
            (i32x4.shr_s
              (i32x4.add (local.get $vSum)
                (v128.const i32x4 0x1000 0x1000 0x1000 0x1000))
              (i32.const 13))))

        ;; Saturating unsigned narrow i32x4 → i16x8 lanes 0..3.
        ;; Each i32 lane becomes a u16 in the corresponding i16x8 lane:
        ;;   negative → 0
        ;;   > 65535  → 65535
        ;;   else     → low 16 bits
        ;; Passing $vU16 twice is fine — we only care about lanes 0..3 of
        ;; the narrow result (low 64 bits of the i16x8).
        (local.set $vOut
          (i16x8.narrow_i32x4_u (local.get $vU16) (local.get $vU16)))

        ;; Store low 64 bits (4 u16 = 8 bytes) of $vOut.  For cMax=4 this is
        ;; the full output pixel; for cMax=3 the 4th u16 is overwritten by
        ;; the next pixel's first store (and the final pixel leaves 2 junk
        ;; bytes past the nominal end — caller allocates +4 in
        ;; Tetra3DInt16State for alignment).
        (v128.store64_lane align=1 0
          (local.get $outputPos)
          (local.get $vOut))

        (local.set $outputPos
          (i32.add (local.get $outputPos) (local.get $outputStride)))

        ;; --- Alpha tail (mirrors tetra3d_nch_int16.wat — u16 stride) -----
        ;; Same outer i32.or guard as the u8 SIMD path: collapses the
        ;; no-alpha hot path to a single test per pixel. inputPos is at
        ;; the (optional) alpha sample — we advanced by 6 after the RGB
        ;; load, not 8.
        (if (i32.or (local.get $outAlphaMode) (local.get $inAlphaSkip))
          (then
            (if (i32.eq (local.get $outAlphaMode) (i32.const 2))
              (then
                ;; PRESERVE-COPY: output[outputPos] = input[inputPos];
                ;; advance both by 2 bytes (1 u16 sample).
                (i32.store16 (local.get $outputPos)
                  (i32.load16_u (local.get $inputPos)))
                (local.set $outputPos (i32.add (local.get $outputPos) (i32.const 2)))
                (local.set $inputPos  (i32.add (local.get $inputPos)  (i32.const 2))))
              (else
                (if (i32.eq (local.get $outAlphaMode) (i32.const 1))
                  (then
                    ;; FILL_0xFFFF: output[outputPos] = 0xFFFF; outputPos += 2
                    (i32.store16 (local.get $outputPos) (i32.const 0xFFFF))
                    (local.set $outputPos
                      (i32.add (local.get $outputPos) (i32.const 2)))))
                ;; inputPos += inAlphaSkip * 2 (samples → bytes)
                (local.set $inputPos
                  (i32.add (local.get $inputPos)
                           (i32.shl (local.get $inAlphaSkip) (i32.const 1))))))))

        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $pixel_loop))))
)
