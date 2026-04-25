;; ============================================================================
;; tetra4d_simd_int16.wat — 4D tetrahedral interpolation, SIMD, u16 I/O
;;                          v1.3 (Q0.13 weights, true 16-bit, TWO-ROUNDING)
;; ============================================================================
;;
;; SIMD u16 sibling of:
;;   tetra4d_simd.wat        — u8 SIMD 4D       (same vectorize-channels strategy)
;;   tetra4d_nch_int16.wat   — scalar u16 4D    (same Q0.13 + two-rounding math)
;;   tetra3d_simd_int16.wat  — SIMD u16 3D      (same per-pixel SIMD shape)
;;
;; Same "vectorize across output channels" plan as the 3D SIMD u16 kernel —
;; all 3-4 output channels live in one v128, loaded by v128.load64_zero +
;; i32x4.extend_low_i16x8_u at each tetra corner — extended with the K-axis
;; loop from tetra4d_nch_int16.wat (scalar u16 4D).
;;
;; The architectural win vs the scalar u16 4D kernel is that the K0 u16
;; intermediate fits in a SINGLE v128 local (4 i32 lanes = 4 channels ×
;; 32-bit) and persists across the K-plane loop iteration in a CPU
;; register. NO scratch memory region is required — the scalar u16 4D
;; needed one because its rolled n-channel inner loop couldn't keep cMax
;; u16 locals addressable at runtime. SIMD processes all channels in
;; parallel so there's nothing to index.
;;
;; Q0.13 4D contract — TWO-ROUNDING (vs the 3D's single rounding):
;; ---------------------------------------------------------------
;; Per K-pass, per pixel:
;;   vSum = (vA - vC)*vRx + (vB - vA)*vRy + (vD - vB)*vRz       (case 1)
;;   vU16 = vC + ((vSum + 0x1000) >> 13)                        ; round at u13
;;
;; Final tail (once per pixel, in $k_exit):
;;   if !interpK:  vOut_i32 = vU16
;;   if  interpK:  vOut_i32 = vU16_K0 + ((vU16 - vU16_K0) * vRk + 0x1000) >> 13
;;
;;   pack: i16x8.narrow_i32x4_u(vOut_i32, vOut_i32)             ; sat-u clamp
;;   v128.store64_lane lane 0 → 8 bytes at outputPos (4 × u16)
;;
;; Why two roundings: with Q0.13 weights, `imul(corner_u17, w_u13)` already
;; eats ~30 bits of i32 headroom; carrying a u20 XYZ result into a
;; `(o << 8) + ...` K-LERP (the v1.2 u8 design) would overflow i32 (30 +
;; sign + outer add > 31). The two-rounding path keeps every accumulator
;; ≤ 2^30.6, fits in i32 with ~1.4 bits headroom. Worst-case kernel error
;; ≤ 1 LSB at u16 — same spec as the 3D u16 kernels. See
;; src/Transform.js `tetrahedralInterp4DArray_3Ch_intLut16_loop` JSDoc
;; (and tetra4d_nch_int16.wat header) for the bit-budget walkthrough.
;;
;; interpK fast path (pixel lies exactly on a K grid-plane):
;;
;;   When rk === 0 (because inputK divides cleanly into the grid, or
;;   because the inputK===65535 boundary patch pinned K0=K1=maxK), we
;;   skip the K1-plane pass entirely and pass vU16 straight to narrow.
;;   Same short-circuit as the scalar u16 4D and JS u16 4D kernels —
;;   cheap per-pixel branch, measurable win on ICC CMYK workflows where
;;   K=0 / K=65535 regions are common (solid whites, rich blacks).
;;
;; Store width & slack:
;;
;;   Same convention as tetra3d_simd_int16.wat — v128.store64_lane writes
;;   8 bytes (4 × u16) per pixel, $outputPos advances by $outputStride
;;   (= cMax * 2 bytes). For cMax=3 without alpha, the last pixel's store
;;   leaves 2 junk bytes past the nominal end — caller allocates +4 bytes
;;   of output-tail slack (Tetra4DInt16State.bind sets outputTail=4 when
;;   isSimd=true). With alpha (output mode 1 or 2) the alpha write lands
;;   exactly on the junk u16, so no slack is consumed.
;;
;; Signature parity with tetra4d_nch_int16.wat:
;;
;;   This kernel takes a $scratchPtr parameter (UNUSED by SIMD — the K0
;;   u16 lives in a v128 local, not in memory) purely so the JS state
;;   wrapper can dispatch the two kernels through a single call shape.
;;   Tetra4DInt16State.runTetra4D doesn't need a SIMD-vs-scalar branch.
;;
;; v1.2 (u8) baggage NOT present (this kernel is born u16 / Q0.13):
;;   - no `>> 16` shifts                  → uses `>> 13` for Q0.13
;;   - no `(p* >> 8) & 0xFF` weight extract → uses `p* & 0x1FFF`
;;   - no `(c << 4) + (sum+8)>>4` u20 build → single rounding to u16 directly
;;   - no `((vU20_K0<<8) + ... + 0x80000) >> 20` u20 K-LERP →
;;       `vU16_K0 + ((vU16 - vU16_K0) * rk + 0x1000) >> 13` u16 K-LERP
;;   - no `i8x16.narrow_i16x8_u`          → output is u16 directly
;;
;; ============================================================================

(module
  (memory (export "memory") 1)

  (func (export "interp_tetra4d_simd_int16")
    (param $inputPtr     i32)
    (param $outputPtr    i32)
    (param $lutPtr       i32)
    (param $pixelCount   i32)
    (param $cMax         i32)   ;; 3 or 4
    (param $go0          i32)
    (param $go1          i32)
    (param $go2          i32)
    (param $go3          i32)
    (param $gps          i32)   ;; gridPointsScale_fixed_u16 (Q0.13)
    (param $maxX         i32)
    (param $maxY         i32)
    (param $maxZ         i32)
    (param $maxK         i32)
    (param $scratchPtr   i32)   ;; UNUSED (signature parity with scalar u16 4D)
    (param $inAlphaSkip  i32)   ;; 0 or 1 (samples; stride is 2 bytes)
    (param $outAlphaMode i32)   ;; 0 = none, 1 = fill 0xFFFF, 2 = preserve

    (local $p            i32)
    (local $inputPos     i32)
    (local $outputPos    i32)
    (local $outputStride i32)   ;; cMax * 2 bytes per pixel

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
    (local $K0           i32)   ;; already scaled by go3 (K0 * go3)
    (local $rx           i32)
    (local $ry           i32)
    (local $rz           i32)
    (local $rk           i32)

    (local $interpK      i32)   ;; 1 iff rk != 0 (and inputK != 65535)
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
    (local $vU16         v128)  ;; per-K-pass u16 result (i32 lanes, [0..65535])
    (local $vU16_K0      v128)  ;; K0-plane u16 stashed across the K loop
    (local $vOutI        v128)  ;; final i32x4 for narrow (lanes pre-clamp)
    (local $vOut         v128)  ;; i16x8 result of unsigned narrow

    ;; --- Init -----------------------------------------------------------------
    (local.set $inputPos     (local.get $inputPtr))
    (local.set $outputPos    (local.get $outputPtr))
    (local.set $outputStride (i32.shl (local.get $cMax) (i32.const 1)))

    ;; --- Per-pixel loop -------------------------------------------------------
    (block $pixel_exit
      (loop $pixel_loop

        (br_if $pixel_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))

        ;; -- Load 4 u16 input samples: K, C, M, Y -------------------
        ;; K is FIRST, matching JS/scalar u16 4D _intLut16_loop order.
        (local.set $inputK (i32.load16_u            (local.get $inputPos)))
        (local.set $input0 (i32.load16_u offset=2   (local.get $inputPos)))
        (local.set $input1 (i32.load16_u offset=4   (local.get $inputPos)))
        (local.set $input2 (i32.load16_u offset=6   (local.get $inputPos)))
        (local.set $inputPos (i32.add (local.get $inputPos) (i32.const 8)))

        ;; pk/px/py/pz = input * gps  (u16 * Q0.13)
        (local.set $pk (i32.mul (local.get $inputK) (local.get $gps)))
        (local.set $px (i32.mul (local.get $input0) (local.get $gps)))
        (local.set $py (i32.mul (local.get $input1) (local.get $gps)))
        (local.set $pz (i32.mul (local.get $input2) (local.get $gps)))

        ;; -- K-axis boundary patch ----------------------------------
        (if (i32.eq (local.get $inputK) (i32.const 65535))
          (then
            (local.set $K0 (local.get $maxK))
            (local.set $rk (i32.const 0)))
          (else
            (local.set $K0
              (i32.mul (i32.shr_u (local.get $pk) (i32.const 13))
                       (local.get $go3)))
            (local.set $rk
              (i32.and (local.get $pk) (i32.const 0x1FFF)))))

        ;; interpK = (rk != 0)
        (local.set $interpK
          (i32.ne (local.get $rk) (i32.const 0)))

        ;; -- XYZ boundary patches (mirror tetra3d_simd_int16.wat) ---
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

        ;; Splat rx/ry/rz/rk across all 4 output-channel lanes.
        (local.set $vRx (i32x4.splat (local.get $rx)))
        (local.set $vRy (i32x4.splat (local.get $ry)))
        (local.set $vRz (i32x4.splat (local.get $rz)))
        (local.set $vRk (i32x4.splat (local.get $rk)))

        (local.set $kpass (i32.const 0))

        ;; =====================================================================
        ;; K-plane loop (emitted once, iterates once when !interpK, twice
        ;; when interpK). Body: recompute K-dependent bases (anchor includes
        ;; K0), reload the four tetra corners, compute vU16. On the first
        ;; iteration if interpK: save vU16 to vU16_K0, bump K0 to K1 plane,
        ;; re-enter.
        ;; =====================================================================
        (block $k_exit
          (loop $k_loop

            ;; base0 = X0 + Y0 + Z0 + K0   (anchor; includes K-plane shift)
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
            ;; Tetrahedral case dispatch — 6 cases + fallback. Bases all
            ;; include K0 so they pick up the K-plane shift naturally
            ;; when we re-enter the loop with K0 += go3. Each case sets
            ;; the 3 non-anchor bases it needs, loads vA/vB/vD, sets vSum.
            ;; vC was already loaded above.
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
                ;; Fallback — degenerate path. vSum = 0; the per-K-pass
                ;; round produces vU16 = vC + ((0 + 0x1000) >> 13) = vC.
                ;; Bit-exact with the scalar u16 4D fallback.
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
            ;; Per-K-pass u16 compute (single rounding to u16):
            ;;   vU16 = vC + ((vSum + 0x1000) >> 13)
            ;; -----------------------------------------------------------
            (local.set $vU16
              (i32x4.add (local.get $vC)
                (i32x4.shr_s
                  (i32x4.add (local.get $vSum)
                    (v128.const i32x4 0x1000 0x1000 0x1000 0x1000))
                  (i32.const 13))))

            ;; If this was the K0 pass AND we need K-LERP, stash vU16 as
            ;; vU16_K0, advance K0 to the K1 plane, and re-enter the loop.
            ;; vU16_K0 survives the back-edge in a v128 register — no
            ;; scratch memory needed (unlike scalar u16 4D, which can't
            ;; index per-channel u16 locals at runtime in its rolled
            ;; n-channel inner loop).
            (if (i32.and (i32.eqz (local.get $kpass)) (local.get $interpK))
              (then
                (local.set $vU16_K0 (local.get $vU16))
                (local.set $K0 (i32.add (local.get $K0) (local.get $go3)))
                (local.set $kpass (i32.const 1))
                (br $k_loop)))

            ;; Fall through to $k_exit with vU16 (single-pass or K1 result)
            ;; and, if interpK, vU16_K0 set.
            (br $k_exit)))

        ;; ====================================================================
        ;; Final tail — one of two paths based on $interpK. Both produce
        ;; vOutI : i32x4 with each lane in [0..65535] (pre-clamp; the
        ;; saturating narrow below cements the clamp).
        ;; ====================================================================
        (if (local.get $interpK)
          (then
            ;; K-LERP (two-rounding):
            ;;   vOutI = vU16_K0 + ((vU16 - vU16_K0) * vRk + 0x1000) >> 13
            ;;
            ;; Bit budget per lane:
            ;;   (vU16 - vU16_K0) is signed 17-bit
            ;;   * vRk (u13)      is signed 30-bit
            ;;   + 0x1000         fits s31 (~1.4 bits headroom)
            ;;   >> 13            is s17.6
            ;;   + vU16_K0 (u16)  fits s31 trivially
            ;; Bit-exact match with the scalar u16 4D K-LERP.
            (local.set $vOutI
              (i32x4.add (local.get $vU16_K0)
                (i32x4.shr_s
                  (i32x4.add
                    (i32x4.mul
                      (i32x4.sub (local.get $vU16) (local.get $vU16_K0))
                      (local.get $vRk))
                    (v128.const i32x4 0x1000 0x1000 0x1000 0x1000))
                  (i32.const 13)))))
          (else
            ;; Single-pass — vU16 already has the per-pixel u16 value.
            (local.set $vOutI (local.get $vU16))))

        ;; Saturating unsigned narrow i32x4 → i16x8 lanes 0..3.
        ;; Each i32 lane becomes a u16 in the corresponding i16x8 lane:
        ;;   negative → 0
        ;;   > 65535  → 65535
        ;;   else     → low 16 bits
        ;; Passing $vOutI twice — we only care about lanes 0..3 (low 64 bits).
        (local.set $vOut
          (i16x8.narrow_i32x4_u (local.get $vOutI) (local.get $vOutI)))

        ;; Store low 64 bits (4 u16 = 8 bytes). cMax=4 consumes the full
        ;; store; cMax=3 leaves 2 junk bytes the next pixel overwrites
        ;; (and the final pixel needs +4 caller-side slack — same convention
        ;; as tetra3d_simd_int16.wat).
        (v128.store64_lane align=1 0
          (local.get $outputPos)
          (local.get $vOut))

        (local.set $outputPos
          (i32.add (local.get $outputPos) (local.get $outputStride)))

        ;; --- Alpha tail (mirrors tetra3d_simd_int16.wat — u16 stride) -----
        ;; Outer i32.or guard collapses to a single test per pixel on the
        ;; no-alpha hot path. inputPos is at the (optional) alpha sample —
        ;; we advanced by 8 after the KCMY load, not 10.
        (if (i32.or (local.get $outAlphaMode) (local.get $inAlphaSkip))
          (then
            (if (i32.eq (local.get $outAlphaMode) (i32.const 2))
              (then
                ;; PRESERVE-COPY: output[outputPos] = input[inputPos]
                (i32.store16 (local.get $outputPos)
                  (i32.load16_u (local.get $inputPos)))
                (local.set $outputPos (i32.add (local.get $outputPos) (i32.const 2)))
                (local.set $inputPos  (i32.add (local.get $inputPos)  (i32.const 2))))
              (else
                (if (i32.eq (local.get $outAlphaMode) (i32.const 1))
                  (then
                    ;; FILL_0xFFFF
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
