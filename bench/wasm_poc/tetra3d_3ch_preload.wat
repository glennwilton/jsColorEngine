;; ============================================================================
;; tetra3d_3ch_preload.wat — 3D tetrahedral, 3-channel SPECIALISED, preloaded c
;; ============================================================================
;;
;; Sibling of tetra3d_nch.wat. Two differences:
;;
;;   1. cMax is FIXED at 3 — no runtime parameter. The channel loop is
;;      unrolled into 3 explicit writes per tetrahedral case.
;;   2. c0, c1, c2 are preloaded into WASM locals ONCE per pixel, before
;;      the tetrahedral case dispatch — matching the pattern the JS
;;      `tetrahedralInterp3DArray_3Ch_intLut_loop` uses.
;;
;; What we're testing:
;;
;;   Does WASM benefit from the same "pre-load anchor-corner values" trick
;;   the JS kernel uses, or does V8's WASM backend already CSE those loads
;;   when inlining the n-channel loop?
;;
;;   If this beats tetra3d_nch.wat by ≥5%: preload matters, and the
;;   v1.2 port should generate specialised-cMax kernels (one per output
;;   channel count — probably via a small JS codegen script, as the user
;;   flagged). If neutral: the rolled n-channel form is fine and there's
;;   no need for codegen at all.
;;
;; Implementation notes:
;;
;;   - Channel corners are read via `i32.load16_u offset=N` with a static
;;     byte offset. This lets us compute each case's 3 base pointers
;;     ONCE, then load all 9 u16 values (3 channels × 3 corners) without
;;     a single `base++` in the hot body.
;;   - The clamp-and-store sequence is still inline per channel. Could
;;     factor out via a function call; deliberately not done here so
;;     the emitted assembly is directly comparable to tetra3d_nch.wat.
;;
;; ============================================================================

(module
    (memory (export "memory") 1)

    (func (export "interp_tetra3d_3Ch")
        (param $inputPtr    i32)
        (param $outputPtr   i32)
        (param $lutPtr      i32)
        (param $pixelCount  i32)
        (param $go0         i32)
        (param $go1         i32)
        (param $go2         i32)
        (param $gps         i32)
        (param $maxX        i32)
        (param $maxY        i32)
        (param $maxZ        i32)

        (local $p           i32)
        (local $inputPos    i32)
        (local $outputPos   i32)

        (local $input0      i32)
        (local $input1      i32)
        (local $input2      i32)
        (local $px          i32)
        (local $py          i32)
        (local $pz          i32)

        (local $X0          i32)
        (local $X1          i32)
        (local $Y0          i32)
        (local $Y1          i32)
        (local $Z0          i32)
        (local $Z1          i32)
        (local $rx          i32)
        (local $ry          i32)
        (local $rz          i32)

        ;; Preloaded anchor-corner values (u16) — same for all 6 cases,
        ;; used across all 3 channel writes per pixel.
        (local $c0          i32)
        (local $c1          i32)
        (local $c2          i32)

        ;; Byte pointers into CLUT for the 3 non-anchor tetra corners.
        ;; Naming follows the mapping JS uses in each case (see comments
        ;; on each `if` block below for the permutation).
        (local $pA          i32)
        (local $pB          i32)
        (local $pD          i32)

        ;; Per-channel temps
        (local $a           i32)
        (local $b           i32)
        (local $d           i32)
        (local $sum         i32)
        (local $u16         i32)
        (local $u8          i32)

        ;; -- Init ---------------------------------------------------------
        local.get $inputPtr
        local.set $inputPos
        local.get $outputPtr
        local.set $outputPos

        ;; -- Main per-pixel loop ------------------------------------------
        (block $pixel_exit
            (loop $pixel_loop

                local.get $p
                local.get $pixelCount
                i32.ge_s
                br_if $pixel_exit

                ;; Load 3 input bytes
                local.get $inputPos
                i32.load8_u
                local.set $input0
                local.get $inputPos i32.const 1 i32.add
                i32.load8_u
                local.set $input1
                local.get $inputPos i32.const 2 i32.add
                i32.load8_u
                local.set $input2
                local.get $inputPos i32.const 3 i32.add
                local.set $inputPos

                ;; px/py/pz
                local.get $input0 local.get $gps i32.mul local.set $px
                local.get $input1 local.get $gps i32.mul local.set $py
                local.get $input2 local.get $gps i32.mul local.set $pz

                ;; X-axis boundary patch
                (if (i32.eq (local.get $input0) (i32.const 255))
                    (then
                        local.get $maxX local.set $X0
                        local.get $maxX local.set $X1
                        i32.const 0     local.set $rx)
                    (else
                        local.get $px i32.const 16 i32.shr_u
                        local.get $go2 i32.mul
                        local.set $X0
                        local.get $X0 local.get $go2 i32.add local.set $X1
                        local.get $px i32.const 8 i32.shr_u
                        i32.const 0xFF i32.and
                        local.set $rx))

                ;; Y-axis boundary patch
                (if (i32.eq (local.get $input1) (i32.const 255))
                    (then
                        local.get $maxY local.set $Y0
                        local.get $maxY local.set $Y1
                        i32.const 0     local.set $ry)
                    (else
                        local.get $py i32.const 16 i32.shr_u
                        local.get $go1 i32.mul
                        local.set $Y0
                        local.get $Y0 local.get $go1 i32.add local.set $Y1
                        local.get $py i32.const 8 i32.shr_u
                        i32.const 0xFF i32.and
                        local.set $ry))

                ;; Z-axis boundary patch
                (if (i32.eq (local.get $input2) (i32.const 255))
                    (then
                        local.get $maxZ local.set $Z0
                        local.get $maxZ local.set $Z1
                        i32.const 0     local.set $rz)
                    (else
                        local.get $pz i32.const 16 i32.shr_u
                        local.get $go0 i32.mul
                        local.set $Z0
                        local.get $Z0 local.get $go0 i32.add local.set $Z1
                        local.get $pz i32.const 8 i32.shr_u
                        i32.const 0xFF i32.and
                        local.set $rz))

                ;; Preload c0, c1, c2 from anchor corner CLUT[X0+Y0+Z0]
                ;; base0_bytes = lutPtr + (X0 + Y0 + Z0) << 1
                local.get $lutPtr
                local.get $X0 local.get $Y0 i32.add local.get $Z0 i32.add
                i32.const 1 i32.shl
                i32.add
                local.tee $pA           ;; reuse pA as temp; we'll overwrite below
                i32.load16_u offset=0
                local.set $c0
                local.get $pA i32.load16_u offset=2
                local.set $c1
                local.get $pA i32.load16_u offset=4
                local.set $c2

                ;; ==========================================================
                ;; Tetrahedral case dispatch — 6 cases, each handles 3
                ;; channels inline using preloaded c0/c1/c2.
                ;; ==========================================================

                ;; ---- CASE 1: rx >= ry >= rz ------------------------------
                ;; a = CLUT[X1+Y0+Z0+ch]
                ;; b = CLUT[X1+Y1+Z0+ch]
                ;; d = CLUT[X1+Y1+Z1+ch]
                ;; sum = (a - c_ch)*rx + (b - a)*ry + (d - b)*rz
                (if (i32.and
                        (i32.ge_s (local.get $rx) (local.get $ry))
                        (i32.ge_s (local.get $ry) (local.get $rz)))
                    (then
                        local.get $lutPtr
                        local.get $X1 local.get $Y0 i32.add local.get $Z0 i32.add
                        i32.const 1 i32.shl i32.add local.set $pA
                        local.get $lutPtr
                        local.get $X1 local.get $Y1 i32.add local.get $Z0 i32.add
                        i32.const 1 i32.shl i32.add local.set $pB
                        local.get $lutPtr
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        i32.const 1 i32.shl i32.add local.set $pD

                        ;; ----- ch 0 (c0) -----
                        local.get $pA i32.load16_u offset=0 local.set $a
                        local.get $pB i32.load16_u offset=0 local.set $b
                        local.get $pD i32.load16_u offset=0 local.set $d
                        local.get $a local.get $c0 i32.sub local.get $rx i32.mul
                        local.get $b local.get $a i32.sub local.get $ry i32.mul i32.add
                        local.get $d local.get $b i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c0
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos local.get $u8 i32.store8

                        ;; ----- ch 1 (c1) -----
                        local.get $pA i32.load16_u offset=2 local.set $a
                        local.get $pB i32.load16_u offset=2 local.set $b
                        local.get $pD i32.load16_u offset=2 local.set $d
                        local.get $a local.get $c1 i32.sub local.get $rx i32.mul
                        local.get $b local.get $a i32.sub local.get $ry i32.mul i32.add
                        local.get $d local.get $b i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c1
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos i32.const 1 i32.add
                        local.get $u8 i32.store8

                        ;; ----- ch 2 (c2) -----
                        local.get $pA i32.load16_u offset=4 local.set $a
                        local.get $pB i32.load16_u offset=4 local.set $b
                        local.get $pD i32.load16_u offset=4 local.set $d
                        local.get $a local.get $c2 i32.sub local.get $rx i32.mul
                        local.get $b local.get $a i32.sub local.get $ry i32.mul i32.add
                        local.get $d local.get $b i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c2
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos i32.const 2 i32.add
                        local.get $u8 i32.store8)
                (else

                ;; ---- CASE 2: rx >= rz >= ry ------------------------------
                ;; a = CLUT[X1+Y0+Z1+ch]
                ;; b = CLUT[X1+Y0+Z0+ch]
                ;; d = CLUT[X1+Y1+Z1+ch]
                ;; sum = (b - c_ch)*rx + (d - a)*ry + (a - b)*rz
                (if (i32.and
                        (i32.ge_s (local.get $rx) (local.get $rz))
                        (i32.ge_s (local.get $rz) (local.get $ry)))
                    (then
                        ;; pA = X1+Y0+Z1  (base3 in JS)
                        local.get $lutPtr
                        local.get $X1 local.get $Y0 i32.add local.get $Z1 i32.add
                        i32.const 1 i32.shl i32.add local.set $pA
                        ;; pB = X1+Y0+Z0  (base1 in JS)
                        local.get $lutPtr
                        local.get $X1 local.get $Y0 i32.add local.get $Z0 i32.add
                        i32.const 1 i32.shl i32.add local.set $pB
                        ;; pD = X1+Y1+Z1  (base2 in JS)
                        local.get $lutPtr
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        i32.const 1 i32.shl i32.add local.set $pD

                        local.get $pA i32.load16_u offset=0 local.set $a
                        local.get $pB i32.load16_u offset=0 local.set $b
                        local.get $pD i32.load16_u offset=0 local.set $d
                        local.get $b local.get $c0 i32.sub local.get $rx i32.mul
                        local.get $d local.get $a i32.sub local.get $ry i32.mul i32.add
                        local.get $a local.get $b i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c0
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos local.get $u8 i32.store8

                        local.get $pA i32.load16_u offset=2 local.set $a
                        local.get $pB i32.load16_u offset=2 local.set $b
                        local.get $pD i32.load16_u offset=2 local.set $d
                        local.get $b local.get $c1 i32.sub local.get $rx i32.mul
                        local.get $d local.get $a i32.sub local.get $ry i32.mul i32.add
                        local.get $a local.get $b i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c1
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos i32.const 1 i32.add
                        local.get $u8 i32.store8

                        local.get $pA i32.load16_u offset=4 local.set $a
                        local.get $pB i32.load16_u offset=4 local.set $b
                        local.get $pD i32.load16_u offset=4 local.set $d
                        local.get $b local.get $c2 i32.sub local.get $rx i32.mul
                        local.get $d local.get $a i32.sub local.get $ry i32.mul i32.add
                        local.get $a local.get $b i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c2
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos i32.const 2 i32.add
                        local.get $u8 i32.store8)
                (else

                ;; ---- CASE 3: rz >= rx >= ry ------------------------------
                ;; JS cond: (rx >= ry && rz >= rx)
                ;; a = CLUT[X1+Y0+Z1+ch]  (base1 in JS)
                ;; b = CLUT[X0+Y0+Z1+ch]  (base2 in JS)
                ;; d = CLUT[X1+Y1+Z1+ch]  (base3 in JS)
                ;; sum = (a - b)*rx + (d - a)*ry + (b - c_ch)*rz
                (if (i32.and
                        (i32.ge_s (local.get $rx) (local.get $ry))
                        (i32.ge_s (local.get $rz) (local.get $rx)))
                    (then
                        local.get $lutPtr
                        local.get $X1 local.get $Y0 i32.add local.get $Z1 i32.add
                        i32.const 1 i32.shl i32.add local.set $pA
                        local.get $lutPtr
                        local.get $X0 local.get $Y0 i32.add local.get $Z1 i32.add
                        i32.const 1 i32.shl i32.add local.set $pB
                        local.get $lutPtr
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        i32.const 1 i32.shl i32.add local.set $pD

                        local.get $pA i32.load16_u offset=0 local.set $a
                        local.get $pB i32.load16_u offset=0 local.set $b
                        local.get $pD i32.load16_u offset=0 local.set $d
                        local.get $a local.get $b i32.sub local.get $rx i32.mul
                        local.get $d local.get $a i32.sub local.get $ry i32.mul i32.add
                        local.get $b local.get $c0 i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c0
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos local.get $u8 i32.store8

                        local.get $pA i32.load16_u offset=2 local.set $a
                        local.get $pB i32.load16_u offset=2 local.set $b
                        local.get $pD i32.load16_u offset=2 local.set $d
                        local.get $a local.get $b i32.sub local.get $rx i32.mul
                        local.get $d local.get $a i32.sub local.get $ry i32.mul i32.add
                        local.get $b local.get $c1 i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c1
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos i32.const 1 i32.add
                        local.get $u8 i32.store8

                        local.get $pA i32.load16_u offset=4 local.set $a
                        local.get $pB i32.load16_u offset=4 local.set $b
                        local.get $pD i32.load16_u offset=4 local.set $d
                        local.get $a local.get $b i32.sub local.get $rx i32.mul
                        local.get $d local.get $a i32.sub local.get $ry i32.mul i32.add
                        local.get $b local.get $c2 i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c2
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos i32.const 2 i32.add
                        local.get $u8 i32.store8)
                (else

                ;; ---- CASE 4: ry >= rx >= rz ------------------------------
                ;; a = CLUT[X0+Y1+Z0+ch]  (base2 in JS)
                ;; b = CLUT[X1+Y1+Z0+ch]  (base1 in JS)
                ;; d = CLUT[X1+Y1+Z1+ch]  (base4 in JS)
                ;; sum = (b - a)*rx + (a - c_ch)*ry + (d - b)*rz
                (if (i32.and
                        (i32.ge_s (local.get $ry) (local.get $rx))
                        (i32.ge_s (local.get $rx) (local.get $rz)))
                    (then
                        local.get $lutPtr
                        local.get $X0 local.get $Y1 i32.add local.get $Z0 i32.add
                        i32.const 1 i32.shl i32.add local.set $pA
                        local.get $lutPtr
                        local.get $X1 local.get $Y1 i32.add local.get $Z0 i32.add
                        i32.const 1 i32.shl i32.add local.set $pB
                        local.get $lutPtr
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        i32.const 1 i32.shl i32.add local.set $pD

                        local.get $pA i32.load16_u offset=0 local.set $a
                        local.get $pB i32.load16_u offset=0 local.set $b
                        local.get $pD i32.load16_u offset=0 local.set $d
                        local.get $b local.get $a i32.sub local.get $rx i32.mul
                        local.get $a local.get $c0 i32.sub local.get $ry i32.mul i32.add
                        local.get $d local.get $b i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c0
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos local.get $u8 i32.store8

                        local.get $pA i32.load16_u offset=2 local.set $a
                        local.get $pB i32.load16_u offset=2 local.set $b
                        local.get $pD i32.load16_u offset=2 local.set $d
                        local.get $b local.get $a i32.sub local.get $rx i32.mul
                        local.get $a local.get $c1 i32.sub local.get $ry i32.mul i32.add
                        local.get $d local.get $b i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c1
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos i32.const 1 i32.add
                        local.get $u8 i32.store8

                        local.get $pA i32.load16_u offset=4 local.set $a
                        local.get $pB i32.load16_u offset=4 local.set $b
                        local.get $pD i32.load16_u offset=4 local.set $d
                        local.get $b local.get $a i32.sub local.get $rx i32.mul
                        local.get $a local.get $c2 i32.sub local.get $ry i32.mul i32.add
                        local.get $d local.get $b i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c2
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos i32.const 2 i32.add
                        local.get $u8 i32.store8)
                (else

                ;; ---- CASE 5: ry >= rz >= rx ------------------------------
                ;; a = CLUT[X0+Y1+Z1+ch]  (base2 in JS)
                ;; b = CLUT[X0+Y1+Z0+ch]  (base3 in JS)
                ;; d = CLUT[X1+Y1+Z1+ch]  (base1 in JS)
                ;; sum = (d - a)*rx + (b - c_ch)*ry + (a - b)*rz
                (if (i32.and
                        (i32.ge_s (local.get $ry) (local.get $rz))
                        (i32.ge_s (local.get $rz) (local.get $rx)))
                    (then
                        local.get $lutPtr
                        local.get $X0 local.get $Y1 i32.add local.get $Z1 i32.add
                        i32.const 1 i32.shl i32.add local.set $pA
                        local.get $lutPtr
                        local.get $X0 local.get $Y1 i32.add local.get $Z0 i32.add
                        i32.const 1 i32.shl i32.add local.set $pB
                        local.get $lutPtr
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        i32.const 1 i32.shl i32.add local.set $pD

                        local.get $pA i32.load16_u offset=0 local.set $a
                        local.get $pB i32.load16_u offset=0 local.set $b
                        local.get $pD i32.load16_u offset=0 local.set $d
                        local.get $d local.get $a i32.sub local.get $rx i32.mul
                        local.get $b local.get $c0 i32.sub local.get $ry i32.mul i32.add
                        local.get $a local.get $b i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c0
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos local.get $u8 i32.store8

                        local.get $pA i32.load16_u offset=2 local.set $a
                        local.get $pB i32.load16_u offset=2 local.set $b
                        local.get $pD i32.load16_u offset=2 local.set $d
                        local.get $d local.get $a i32.sub local.get $rx i32.mul
                        local.get $b local.get $c1 i32.sub local.get $ry i32.mul i32.add
                        local.get $a local.get $b i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c1
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos i32.const 1 i32.add
                        local.get $u8 i32.store8

                        local.get $pA i32.load16_u offset=4 local.set $a
                        local.get $pB i32.load16_u offset=4 local.set $b
                        local.get $pD i32.load16_u offset=4 local.set $d
                        local.get $d local.get $a i32.sub local.get $rx i32.mul
                        local.get $b local.get $c2 i32.sub local.get $ry i32.mul i32.add
                        local.get $a local.get $b i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c2
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos i32.const 2 i32.add
                        local.get $u8 i32.store8)
                (else

                ;; ---- CASE 6: rz >= ry >= rx ------------------------------
                ;; a = CLUT[X0+Y1+Z1+ch]  (base2 in JS)
                ;; b = CLUT[X0+Y0+Z1+ch]  (base4 in JS)
                ;; d = CLUT[X1+Y1+Z1+ch]  (base1 in JS)
                ;; sum = (d - a)*rx + (a - b)*ry + (b - c_ch)*rz
                (if (i32.and
                        (i32.ge_s (local.get $rz) (local.get $ry))
                        (i32.ge_s (local.get $ry) (local.get $rx)))
                    (then
                        local.get $lutPtr
                        local.get $X0 local.get $Y1 i32.add local.get $Z1 i32.add
                        i32.const 1 i32.shl i32.add local.set $pA
                        local.get $lutPtr
                        local.get $X0 local.get $Y0 i32.add local.get $Z1 i32.add
                        i32.const 1 i32.shl i32.add local.set $pB
                        local.get $lutPtr
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        i32.const 1 i32.shl i32.add local.set $pD

                        local.get $pA i32.load16_u offset=0 local.set $a
                        local.get $pB i32.load16_u offset=0 local.set $b
                        local.get $pD i32.load16_u offset=0 local.set $d
                        local.get $d local.get $a i32.sub local.get $rx i32.mul
                        local.get $a local.get $b i32.sub local.get $ry i32.mul i32.add
                        local.get $b local.get $c0 i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c0
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos local.get $u8 i32.store8

                        local.get $pA i32.load16_u offset=2 local.set $a
                        local.get $pB i32.load16_u offset=2 local.set $b
                        local.get $pD i32.load16_u offset=2 local.set $d
                        local.get $d local.get $a i32.sub local.get $rx i32.mul
                        local.get $a local.get $b i32.sub local.get $ry i32.mul i32.add
                        local.get $b local.get $c1 i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c1
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos i32.const 1 i32.add
                        local.get $u8 i32.store8

                        local.get $pA i32.load16_u offset=4 local.set $a
                        local.get $pB i32.load16_u offset=4 local.set $b
                        local.get $pD i32.load16_u offset=4 local.set $d
                        local.get $d local.get $a i32.sub local.get $rx i32.mul
                        local.get $a local.get $b i32.sub local.get $ry i32.mul i32.add
                        local.get $b local.get $c2 i32.sub local.get $rz i32.mul i32.add
                        local.set $sum
                        local.get $c2
                        local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s i32.add
                        local.set $u16
                        local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                        local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                        local.get $outputPos i32.const 2 i32.add
                        local.get $u8 i32.store8)
                (else
                    ;; ---- Fallback (degenerate; matches JS:9134) --------
                    ;; output[0..2] = clamp((c_ch + 0x80) >> 8)
                    local.get $c0 i32.const 0x80 i32.add i32.const 8 i32.shr_s local.set $u8
                    local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                    local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                    local.get $outputPos local.get $u8 i32.store8
                    local.get $c1 i32.const 0x80 i32.add i32.const 8 i32.shr_s local.set $u8
                    local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                    local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                    local.get $outputPos i32.const 1 i32.add local.get $u8 i32.store8
                    local.get $c2 i32.const 0x80 i32.add i32.const 8 i32.shr_s local.set $u8
                    local.get $u8 i32.const 0   local.get $u8 i32.const 0   i32.ge_s select local.set $u8
                    local.get $u8 i32.const 255 local.get $u8 i32.const 256 i32.lt_s select local.set $u8
                    local.get $outputPos i32.const 2 i32.add local.get $u8 i32.store8)
                )))))))))))

                ;; Advance outputPos by 3 (cMax=3, unrolled writes above)
                local.get $outputPos i32.const 3 i32.add local.set $outputPos

                ;; Advance pixel counter
                local.get $p i32.const 1 i32.add local.set $p
                br $pixel_loop))
    )
)
