;; ============================================================================
;; tetra4d_simd.wat — 4D tetrahedral interpolation, SIMD, int math
;; ============================================================================
;;
;; 4D SIMD companion to tetra3d_simd.wat. Same "vectorize across output
;; channels" strategy — all 3-4 output channels live in one v128, loaded
;; by v128.load64_zero + i32x4.extend_low_i16x8_u at each tetra corner —
;; extended with the K-axis loop from tetra4d_nch.wat.
;;
;; The architectural win vs. the scalar 4D WASM kernel is that the K0
;; u20 intermediate fits in a SINGLE v128 local (4 i32 lanes = 4 channels
;; × 32-bit) and persists across the K-plane loop iteration in a CPU
;; register. No scratch memory region is required — the scalar version
;; needed one because the rolled n-channel loop couldn't keep cMax u20
;; locals addressable at runtime. SIMD processes all channels in parallel
;; so there's nothing to index.
;;
;; Scope:
;;
;;   - inputChannels = 4 (KCMY — K-first byte order matches
;;     tetrahedralInterp4DArray_{3,4}Ch_intLut_loop)
;;   - outputChannels (cMax) ∈ {3, 4}
;;   - all four alpha modes via $inAlphaSkip + $outAlphaMode,
;;     identical contract to tetra3d_simd.wat / tetra4d_nch.wat
;;   - all 6 tetrahedral cases + fallback
;;   - u16 CLUT, Q0.16 gps, u20 Q16.4 single-rounding K-LERP
;;
;; Math — per K-pass and final narrow (matches tetra4d_nch.wat, vectorized):
;;
;;   Per K-pass, per pixel (rerun at K0 plane, then again at K1 plane
;;   when $interpK):
;;     vSum = (vA - vC)*vRx + (vB - vA)*vRy + (vD - vB)*vRz     (i32x4)
;;     vU20 = (vC << 4) + ((vSum + 0x08) >> 4)                  (i32x4, ~20 bits)
;;
;;   Final narrow (happens once per pixel, in the $k_exit tail):
;;     if !interpK:  vU8_i32 = (vU20      + 0x800   ) >> 12    ;; single rounding
;;     if  interpK:  vU8_i32 = ((vU20_K0 << 8)
;;                             + (vU20 - vU20_K0) * vRk
;;                             + 0x80000) >> 20                 ;; single rounding
;;     vU16 = i16x8.narrow_i32x4_u  vU8_i32 vU8_i32             (saturating → [0..255])
;;     vU8  = i8x16.narrow_i16x8_u  vU16    vU16
;;     v128.store32_lane lane 0 → outputPos
;;
;; Headroom analysis:
;;   u20 ∈ [0, 2^20 - 1] ≈ 1 M     (fits i32 with 11 bits to spare)
;;   u20_K0 << 8        ≈ 2^28 signed
;;   (u20 - u20_K0) * rk ≤ 2^20 * 255 ≈ 2^28 signed — fits i32x4.mul.
;;   Everything fits signed i32, bit-exact with the scalar 4D WAT kernel
;;   (which is bit-exact against the JS _intLut_loop 4D reference).
;;
;; interpK fast path (pixel lies exactly on a K grid-plane):
;;
;;   When rk === 0 (because inputK divides cleanly into the grid, or
;;   because the inputK===255 boundary patch pinned K0=K1=maxK), we
;;   skip the K1-plane pass entirely and round vU20 → u8 directly.
;;   Same short-circuit as the scalar 4D WAT and JS 4D kernels — cheap
;;   per-pixel branch, measurable win on ICC CMYK workflows where K=0
;;   / K=255 regions are common (solid whites, rich blacks).
;;
;; Store width & slack:
;;
;;   Same convention as tetra3d_simd.wat — v128.store32_lane writes 4
;;   bytes, $outputPos advances by $outputStride (= cMax). For cMax=3
;;   without alpha, the last pixel's store leaves 1 junk byte past the
;;   nominal end — caller allocates +4 bytes of output-tail slack. With
;;   alpha (output mode 1 or 2) the alpha write lands exactly on the
;;   junk byte, so no slack is ever actually consumed.
;;
;; Signature parity with tetra4d_nch.wat:
;;
;;   This kernel takes a $scratchPtr parameter (unused by SIMD — the K0
;;   u20 lives in a v128 local, not in memory) purely so the JS state
;;   wrapper can dispatch the two kernels through a single call shape.
;;   The wat is 14 arguments to the scalar's 17 minus ... actually we
;;   keep it at 17 so Tetra4DState can run either kernel without a
;;   signature-branch. $scratchPtr is just ignored.
;;
;; ============================================================================

(module
  (memory (export "memory") 1)

  (func (export "interp_tetra4d_simd")
    (param $inputPtr     i32)
    (param $outputPtr    i32)
    (param $lutPtr       i32)
    (param $pixelCount   i32)
    (param $cMax         i32)   ;; 3 or 4
    (param $go0          i32)
    (param $go1          i32)
    (param $go2          i32)
    (param $go3          i32)
    (param $gps          i32)
    (param $maxX         i32)
    (param $maxY         i32)
    (param $maxZ         i32)
    (param $maxK         i32)
    (param $scratchPtr   i32)   ;; unused (signature parity with scalar)
    (param $inAlphaSkip  i32)   ;; 0 or 1
    (param $outAlphaMode i32)   ;; 0 = none, 1 = fill 255, 2 = preserve-copy

    (local $p            i32)
    (local $inputPos     i32)
    (local $outputPos    i32)
    (local $outputStride i32)   ;; cMax bytes per pixel

    (local $inputK       i32)
    (local $input0       i32)
    (local $input1       i32)
    (local $input2       i32)
    (local $pk           i32)
    (local $px           i32)
    (local $py           i32)
    (local $pz           i32)

    (local $X0           i32)
    (local $X1           i32)
    (local $Y0           i32)
    (local $Y1           i32)
    (local $Z0           i32)
    (local $Z1           i32)
    (local $K0           i32)   ;; already scaled by go3 (K0_index * go3)
    (local $rx           i32)
    (local $ry           i32)
    (local $rz           i32)
    (local $rk           i32)

    (local $interpK      i32)   ;; 1 iff rk != 0 (and inputK != 255)
    (local $kpass        i32)   ;; 0 = K0 pass, 1 = K1 pass

    (local $base0        i32)
    (local $base1        i32)
    (local $base2        i32)
    (local $base3        i32)
    (local $base4        i32)

    (local $vA           v128)
    (local $vB           v128)
    (local $vC           v128)
    (local $vD           v128)
    (local $vRx          v128)
    (local $vRy          v128)
    (local $vRz          v128)
    (local $vRk          v128)
    (local $vSum         v128)
    (local $vU20         v128)
    (local $vU20_K0      v128)  ;; K0-plane u20 stashed across the K loop
    (local $vU8i         v128)  ;; i32x4 with each lane in [0..255]
    (local $vOut         v128)

    ;; --- Init -----------------------------------------------------------------
    (local.set $inputPos     (local.get $inputPtr))
    (local.set $outputPos    (local.get $outputPtr))
    (local.set $outputStride (local.get $cMax))

    ;; --- Per-pixel loop -------------------------------------------------------
    (block $pixel_exit
      (loop $pixel_loop

        (br_if $pixel_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))

        ;; -- Load 4 u8 input bytes: K, C, M, Y -----------------------
        ;; K is FIRST, matching JS _intLut_loop convention.
        (local.set $inputK (i32.load8_u            (local.get $inputPos)))
        (local.set $input0 (i32.load8_u offset=1   (local.get $inputPos)))
        (local.set $input1 (i32.load8_u offset=2   (local.get $inputPos)))
        (local.set $input2 (i32.load8_u offset=3   (local.get $inputPos)))
        (local.set $inputPos (i32.add (local.get $inputPos) (i32.const 4)))

        (local.set $pk (i32.mul (local.get $inputK) (local.get $gps)))
        (local.set $px (i32.mul (local.get $input0) (local.get $gps)))
        (local.set $py (i32.mul (local.get $input1) (local.get $gps)))
        (local.set $pz (i32.mul (local.get $input2) (local.get $gps)))

        ;; -- K-axis boundary patch -----------------------------------
        (if (i32.eq (local.get $inputK) (i32.const 255))
          (then
            (local.set $K0 (local.get $maxK))
            (local.set $rk (i32.const 0)))
          (else
            (local.set $K0
              (i32.mul (i32.shr_u (local.get $pk) (i32.const 16))
                       (local.get $go3)))
            (local.set $rk
              (i32.and (i32.shr_u (local.get $pk) (i32.const 8))
                       (i32.const 0xFF)))))

        ;; interpK = (rk != 0)
        (local.set $interpK
          (i32.ne (local.get $rk) (i32.const 0)))

        ;; -- XYZ boundary patches (identical to 3D SIMD) -------------
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

        ;; Splat rx/ry/rz/rk into v128 lanes — same weight broadcast
        ;; across all 4 output-channel lanes.
        (local.set $vRx (i32x4.splat (local.get $rx)))
        (local.set $vRy (i32x4.splat (local.get $ry)))
        (local.set $vRz (i32x4.splat (local.get $rz)))
        (local.set $vRk (i32x4.splat (local.get $rk)))

        (local.set $kpass (i32.const 0))

        ;; =====================================================================
        ;; K-plane loop (emitted once, iterates once when !interpK, twice
        ;; when interpK). Body: recompute K-dependent bases, reload the
        ;; four tetra corners, compute vU20. On the first iteration if
        ;; interpK: save vU20 to vU20_K0, bump K0 to K1 plane, re-enter.
        ;; =====================================================================
        (block $k_exit
          (loop $k_loop

            ;; base0 = X0 + Y0 + Z0 + K0   (anchor)
            (local.set $base0
              (i32.add
                (i32.add (i32.add (local.get $X0) (local.get $Y0)) (local.get $Z0))
                (local.get $K0)))

            ;; vC = CLUT[base0]  (4 × u16 → 4 × i32 via load64_zero + extend)
            (local.set $vC
              (i32x4.extend_low_i16x8_u
                (v128.load64_zero align=1
                  (i32.add (local.get $lutPtr)
                           (i32.shl (local.get $base0) (i32.const 1))))))

            ;; ==========================================================
            ;; Tetrahedral case dispatch — 6 cases + fallback.
            ;; Bases all include K0, so they pick up the K-plane shift
            ;; naturally when we re-enter the loop with K0 += go3.
            ;; Each case sets the 3 non-anchor bases it needs, loads
            ;; vA/vB/vD, and sets vSum. vC is already loaded above.
            ;; ==========================================================

            ;; ------ CASE 1: rx >= ry >= rz ------------------------------
            (if (i32.and (i32.ge_s (local.get $rx) (local.get $ry))
                         (i32.ge_s (local.get $ry) (local.get $rz)))
              (then
                (local.set $base1
                  (i32.add
                    (i32.add (i32.add (local.get $X1) (local.get $Y0)) (local.get $Z0))
                    (local.get $K0)))
                (local.set $base2
                  (i32.add
                    (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z0))
                    (local.get $K0)))
                (local.set $base4
                  (i32.add
                    (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z1))
                    (local.get $K0)))

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

            ;; ------ CASE 2: rx >= rz >= ry ------------------------------
            (if (i32.and (i32.ge_s (local.get $rx) (local.get $rz))
                         (i32.ge_s (local.get $rz) (local.get $ry)))
              (then
                (local.set $base1
                  (i32.add
                    (i32.add (i32.add (local.get $X1) (local.get $Y0)) (local.get $Z0))
                    (local.get $K0)))
                (local.set $base2
                  (i32.add
                    (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z1))
                    (local.get $K0)))
                (local.set $base3
                  (i32.add
                    (i32.add (i32.add (local.get $X1) (local.get $Y0)) (local.get $Z1))
                    (local.get $K0)))

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

            ;; ------ CASE 3: rx >= ry  && rz >= rx ------------------------
            (if (i32.and (i32.ge_s (local.get $rx) (local.get $ry))
                         (i32.ge_s (local.get $rz) (local.get $rx)))
              (then
                (local.set $base1
                  (i32.add
                    (i32.add (i32.add (local.get $X1) (local.get $Y0)) (local.get $Z1))
                    (local.get $K0)))
                (local.set $base2
                  (i32.add
                    (i32.add (i32.add (local.get $X0) (local.get $Y0)) (local.get $Z1))
                    (local.get $K0)))
                (local.set $base3
                  (i32.add
                    (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z1))
                    (local.get $K0)))

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

            ;; ------ CASE 4: ry >= rx >= rz ------------------------------
            (if (i32.and (i32.ge_s (local.get $ry) (local.get $rx))
                         (i32.ge_s (local.get $rx) (local.get $rz)))
              (then
                (local.set $base1
                  (i32.add
                    (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z0))
                    (local.get $K0)))
                (local.set $base2
                  (i32.add
                    (i32.add (i32.add (local.get $X0) (local.get $Y1)) (local.get $Z0))
                    (local.get $K0)))
                (local.set $base4
                  (i32.add
                    (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z1))
                    (local.get $K0)))

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

            ;; ------ CASE 5: ry >= rz >= rx ------------------------------
            (if (i32.and (i32.ge_s (local.get $ry) (local.get $rz))
                         (i32.ge_s (local.get $rz) (local.get $rx)))
              (then
                (local.set $base1
                  (i32.add
                    (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z1))
                    (local.get $K0)))
                (local.set $base2
                  (i32.add
                    (i32.add (i32.add (local.get $X0) (local.get $Y1)) (local.get $Z1))
                    (local.get $K0)))
                (local.set $base3
                  (i32.add
                    (i32.add (i32.add (local.get $X0) (local.get $Y1)) (local.get $Z0))
                    (local.get $K0)))

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

            ;; ------ CASE 6: rz >= ry >= rx ------------------------------
            (if (i32.and (i32.ge_s (local.get $rz) (local.get $ry))
                         (i32.ge_s (local.get $ry) (local.get $rx)))
              (then
                (local.set $base1
                  (i32.add
                    (i32.add (i32.add (local.get $X1) (local.get $Y1)) (local.get $Z1))
                    (local.get $K0)))
                (local.set $base2
                  (i32.add
                    (i32.add (i32.add (local.get $X0) (local.get $Y1)) (local.get $Z1))
                    (local.get $K0)))
                (local.set $base4
                  (i32.add
                    (i32.add (i32.add (local.get $X0) (local.get $Y0)) (local.get $Z1))
                    (local.get $K0)))

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
                ;; Fallback — degenerate tetra cell. vSum = 0; the tail
                ;; rounding produces u8 = c (clamped), matching scalar.
                (local.set $vSum (v128.const i32x4 0 0 0 0))
              )
            )
            )
            )
            )
            )
            )
            )
            )
            )
            )
            )

            ;; -----------------------------------------------------------
            ;; Per-K-pass u20 compute (matches scalar u20 Q16.4):
            ;;   vU20 = (vC << 4) + ((vSum + 0x08) >> 4)
            ;; -----------------------------------------------------------
            (local.set $vU20
              (i32x4.add
                (i32x4.shl (local.get $vC) (i32.const 4))
                (i32x4.shr_s
                  (i32x4.add (local.get $vSum)
                    (v128.const i32x4 0x08 0x08 0x08 0x08))
                  (i32.const 4))))

            ;; If this was the K0 pass AND we need K-LERP, stash vU20 as
            ;; vU20_K0, advance K0 to the K1 plane, and re-enter the loop.
            ;; vU20_K0 survives the back-edge in a v128 register — no
            ;; scratch memory needed, unlike the scalar n-channel kernel.
            (if (i32.and (i32.eqz (local.get $kpass)) (local.get $interpK))
              (then
                (local.set $vU20_K0 (local.get $vU20))
                (local.set $K0 (i32.add (local.get $K0) (local.get $go3)))
                (local.set $kpass (i32.const 1))
                (br $k_loop)))

            ;; Fall through to $k_exit with vU20 (either single-pass or
            ;; K1 value) and, if interpK, vU20_K0 set.
            (br $k_exit)))

        ;; ====================================================================
        ;; Final narrow — one of two paths based on $interpK.
        ;; Both produce vU8i : i32x4 with each lane in [0..255] (pre-clamp;
        ;; the saturating narrows below cement the clamp).
        ;; ====================================================================
        (if (local.get $interpK)
          (then
            ;; K-LERP:
            ;;   u8 = ((vU20_K0 << 8) + (vU20 - vU20_K0) * rk + 0x80000) >> 20
            (local.set $vU8i
              (i32x4.shr_s
                (i32x4.add
                  (i32x4.add
                    (i32x4.shl (local.get $vU20_K0) (i32.const 8))
                    (i32x4.mul
                      (i32x4.sub (local.get $vU20) (local.get $vU20_K0))
                      (local.get $vRk)))
                  (v128.const i32x4 0x80000 0x80000 0x80000 0x80000))
                (i32.const 20))))
          (else
            ;; Single-pass round:
            ;;   u8 = (vU20 + 0x800) >> 12
            (local.set $vU8i
              (i32x4.shr_s
                (i32x4.add (local.get $vU20)
                  (v128.const i32x4 0x800 0x800 0x800 0x800))
                (i32.const 12)))))

        ;; Saturating narrow i32x4 → i16x8 → i8x16. First narrow packs
        ;; 4+4 i32 lanes into 8 i16 lanes; second packs 8+8 i16 lanes
        ;; into 16 i8 lanes. Passing vU8i twice is fine — we only care
        ;; about lanes 0..3 of the final i8x16 (low 32 bits).
        (local.set $vOut
          (i8x16.narrow_i16x8_u
            (i16x8.narrow_i32x4_u (local.get $vU8i) (local.get $vU8i))
            (i16x8.narrow_i32x4_u (local.get $vU8i) (local.get $vU8i))))

        ;; Store 4 bytes from lane 0 of the i32x4 view. cMax=4 consumes
        ;; the full store; cMax=3 leaves 1 junk byte that the next pixel
        ;; overwrites (and the final pixel needs +4 caller-side slack,
        ;; same convention as tetra3d_simd.wat).
        (v128.store32_lane align=1 0
          (local.get $outputPos)
          (local.get $vOut))

        (local.set $outputPos
          (i32.add (local.get $outputPos) (local.get $outputStride)))

        ;; --- Alpha tail (mirrors tetra3d_simd.wat) --------------------
        ;; Outer i32.or guard collapses to a single test per pixel on
        ;; the no-alpha hot path. inputPos is sitting on the (optional)
        ;; alpha byte — we advanced by 4 after the KCMY load, not 5.
        (if (i32.or (local.get $outAlphaMode) (local.get $inAlphaSkip))
          (then
            (if (i32.eq (local.get $outAlphaMode) (i32.const 2))
              (then
                ;; PRESERVE-COPY: output[outputPos] = input[inputPos]
                (i32.store8 (local.get $outputPos)
                  (i32.load8_u (local.get $inputPos)))
                (local.set $outputPos (i32.add (local.get $outputPos) (i32.const 1)))
                (local.set $inputPos  (i32.add (local.get $inputPos)  (i32.const 1))))
              (else
                (if (i32.eq (local.get $outAlphaMode) (i32.const 1))
                  (then
                    ;; FILL-255
                    (i32.store8 (local.get $outputPos) (i32.const 255))
                    (local.set $outputPos
                      (i32.add (local.get $outputPos) (i32.const 1)))))
                ;; inputPos += inAlphaSkip (0 or 1)
                (local.set $inputPos
                  (i32.add (local.get $inputPos) (local.get $inAlphaSkip)))))))

        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $pixel_loop))))
)
