;; ============================================================================
;; tetra4d_nch_int16.wat — 4D tetrahedral interpolation, n-channel, u16 I/O
;;                        v1.3 (Q0.13 fractional weights, true 16-bit precision)
;; ============================================================================
;;
;; Bit-exact WASM sibling of `tetrahedralInterp4DArray_{3,4}Ch_intLut16_loop`
;; in src/Transform.js. Same algorithm, same arithmetic ordering, same
;; rounding constants, same TWO-ROUNDING design — drop a synthetic adversarial
;; CLUT into both kernels and every output u16 must match exactly.
;;
;; Q0.13 4D contract — TWO-ROUNDING (vs the 3D's single rounding):
;; ---------------------------------------------------------------
;; Step 1 (K0 plane):  o_u16 = c_K0 + ((tetra_sum_K0 + 0x1000) >> 13)
;; Step 2 (K1 plane):  v_u16 = c_K1 + ((tetra_sum_K1 + 0x1000) >> 13)
;; Step 3 (K-LERP):    out   = o_u16 + ((imul(v_u16 - o_u16, rk) + 0x1000) >> 13)
;;
;; Why two roundings instead of u8's one (where u20 carried K-LERP):
;;   With u13 weights `imul(corner_u17, w_u13)` already eats ~30 bits of
;;   i32 headroom; carrying a u20 XYZ result into a `(o << 8) + ...`
;;   K-LERP would overflow i32 (30 + sign + outer add > 31). The two-
;;   rounding path keeps every accumulator ≤ 2^30.6, fits in i32 with
;;   ~1.4 bits headroom. Worst-case kernel error ≤ 1 LSB at u16 — same
;;   spec as the 3D kernels. See Transform.js
;;   `tetrahedralInterp4DArray_3Ch_intLut16_loop` JSDoc for the bit-budget
;;   walkthrough and i32-safety analysis.
;;
;; Implementation note — the K-pass loop:
;;   We keep the existing K0/K1 two-pass structure (re-enter the entire
;;   tetra case dispatch with K0 += go3 on the K1 pass). What changed
;;   from the earlier u8-style design is what lives in the per-channel
;;   scratch slot during the pass-1 → pass-2 handoff: that design
;;   stashed a u20 (Q16.4) intermediate that fed a (u20<<8 + ...)/12
;;   K-LERP. The v1.3 Q0.13 design stashes the per-channel K0-plane u16
;;   result (already rounded once) and the K-LERP is the simple
;;   `o + ((v - o) * rk + 0x1000) >> 13` form above.
;;
;; Earlier u8-style baggage removed (DO NOT add back):
;;   - Per-axis `>> 16` shift → replaced with `>> 13` (Q0.13 weights).
;;   - `(p* >> 8) & 0xFF`     → replaced with `p* & 0x1FFF`.
;;   - `c << 4 + (sum+0x08)>>4` u20 build → replaced with single rounding
;;                              `c + (sum+0x1000)>>13` to u16 directly.
;;   - K-LERP `((k0<<8) + (u20-k0)*rk + 0x800) >> 12` → replaced with
;;                              `o + ((v - o) * rk + 0x1000) >> 13`.
;;   - `v + (v >>> 8)` u8→u16 bit-stretch → removed (CLUT is at scale 65535).
;;   - Fallback `c << 4` → just `c` (CLUT corner enters at full u16).
;;
;; Memory layout (caller-provided byte offsets):
;;   [ inputPtr   .. inputPtr   + pixelCount*4*2 )    u16 KCMY input (K first)
;;   [ outputPtr  .. outputPtr  + pixelCount*cMax*2 ) u16 n-channel output
;;   [ lutPtr     .. lutPtr     + lutLen*2 )          u16 CLUT @ scale 65535
;;   [ scratchPtr .. scratchPtr + cMax*4 )            u16 scratch (i32 slots,
;;                                                     1 per channel; 64 B
;;                                                     covers cMax ≤ 16)
;;
;; The scratch region storage width didn't change — still i32 slots, just
;; with smaller values (u16 instead of u20). Keeping i32 slots avoids
;; re-aligning the scratch region for one less byte per channel.
;;
;; Stride conventions (u16-element units, NOT bytes):
;;   go0 = outputChannels              (next Z slice)
;;   go1 = g1 * outputChannels         (next Y row)
;;   go2 = g1 * g1 * outputChannels    (next X plane)
;;   go3 = g1 * g1 * g1 * outputChannels (next K plane — outermost axis)
;;
;; gps  — gridPointsScale_fixed_u16, Q0.13 (e.g. 2 for g1=17)
;; maxX/Y/Z/K — boundary patch grid offsets
;;
;; Input sample order: inputK, input0 (C), input1 (M), input2 (Y), [opt α].
;; Matches `tetrahedralInterp4DArray_*_intLut16_loop` exactly.
;;
;; Alpha handling (mirrors tetra3d_nch_int16.wat — u16 stride):
;;   $inAlphaSkip   0 or 1 — alpha samples to skip after each KCMY quad
;;                  (kernel internally shifts by 1 for byte stride)
;;   $outAlphaMode  0 = no output alpha
;;                  1 = fill output alpha with 0xFFFF
;;                  2 = preserve-copy 1 input u16 alpha → 1 output u16
;;
;; ============================================================================

(module
    (memory (export "memory") 1)

    (func (export "interp_tetra4d_nCh_int16")
        (param $inputPtr     i32)
        (param $outputPtr    i32)
        (param $lutPtr       i32)
        (param $pixelCount   i32)
        (param $cMax         i32)
        (param $go0          i32)
        (param $go1          i32)
        (param $go2          i32)
        (param $go3          i32)
        (param $gps          i32)   ;; pass gridPointsScale_fixed_u16 (Q0.13)
        (param $maxX         i32)
        (param $maxY         i32)
        (param $maxZ         i32)
        (param $maxK         i32)
        (param $scratchPtr   i32)   ;; byte offset; cMax i32 slots (per pixel)
        (param $inAlphaSkip  i32)   ;; 0 or 1 (samples; stride is 2 bytes)
        (param $outAlphaMode i32)   ;; 0 = none, 1 = fill 0xFFFF, 2 = preserve

        (local $p           i32)
        (local $inputPos    i32)
        (local $outputPos   i32)

        (local $inputK      i32)
        (local $input0      i32)
        (local $input1      i32)
        (local $input2      i32)
        (local $pk          i32)
        (local $px          i32)
        (local $py          i32)
        (local $pz          i32)

        (local $X0          i32)
        (local $X1          i32)
        (local $Y0          i32)
        (local $Y1          i32)
        (local $Z0          i32)
        (local $Z1          i32)
        (local $K0          i32)   ;; already scaled by go3 (K0 * go3)
        (local $rx          i32)
        (local $ry          i32)
        (local $rz          i32)
        (local $rk          i32)

        (local $base0       i32)
        (local $base1       i32)
        (local $base2       i32)
        (local $base3       i32)
        (local $base4       i32)

        (local $kpass       i32)   ;; 0 = K0 pass, 1 = K1 pass
        (local $interpK     i32)   ;; 1 iff rk != 0 (and inputK != 65535)
        (local $tailMode    i32)   ;; 0 = u16 directly, 1 = stash, 2 = K-LERP

        (local $o           i32)
        (local $a           i32)
        (local $b           i32)
        (local $c           i32)
        (local $d           i32)
        (local $sum         i32)
        (local $u16         i32)   ;; Q0.13: per-channel rounded u16 result
        (local $k0_u16      i32)   ;; K0-plane u16 from scratch (K1 pass)
        (local $out         i32)   ;; final u16 output

        ;; -- Init ---------------------------------------------------------
        local.get $inputPtr
        local.set $inputPos
        local.get $outputPtr
        local.set $outputPos

        ;; -- Main per-pixel loop -----------------------------------------
        (block $pixel_exit
            (loop $pixel_loop

                ;; Exit condition: p >= pixelCount
                local.get $p
                local.get $pixelCount
                i32.ge_s
                br_if $pixel_exit

                ;; -- Load 4 u16 input samples: K, C, M, Y --------------
                local.get $inputPos
                i32.load16_u
                local.set $inputK

                local.get $inputPos
                i32.const 2
                i32.add
                i32.load16_u
                local.set $input0

                local.get $inputPos
                i32.const 4
                i32.add
                i32.load16_u
                local.set $input1

                local.get $inputPos
                i32.const 6
                i32.add
                i32.load16_u
                local.set $input2

                local.get $inputPos
                i32.const 8
                i32.add
                local.set $inputPos

                ;; pk, px, py, pz = input * gps_u16  (Q0.13 grid coords)
                local.get $inputK local.get $gps i32.mul local.set $pk
                local.get $input0 local.get $gps i32.mul local.set $px
                local.get $input1 local.get $gps i32.mul local.set $py
                local.get $input2 local.get $gps i32.mul local.set $pz

                ;; -- K-axis boundary patch -----------------------------
                ;; if (inputK === 65535) { K0 = maxK; rk = 0; }
                ;; else                  { K0 = (pk >>> 13) * go3;
                ;;                         rk = pk & 0x1FFF; }
                (if (i32.eq (local.get $inputK) (i32.const 65535))
                    (then
                        local.get $maxK
                        local.set $K0
                        i32.const 0
                        local.set $rk)
                    (else
                        local.get $pk
                        i32.const 13
                        i32.shr_u
                        local.get $go3
                        i32.mul
                        local.set $K0
                        local.get $pk
                        i32.const 0x1FFF
                        i32.and
                        local.set $rk))

                ;; interpK = (rk != 0) ? 1 : 0
                local.get $rk
                i32.const 0
                i32.ne
                local.set $interpK

                ;; -- X-axis boundary patch -----------------------------
                (if (i32.eq (local.get $input0) (i32.const 65535))
                    (then
                        local.get $maxX local.set $X0
                        local.get $maxX local.set $X1
                        i32.const 0     local.set $rx)
                    (else
                        local.get $px i32.const 13 i32.shr_u
                        local.get $go2 i32.mul
                        local.set $X0
                        local.get $X0 local.get $go2 i32.add
                        local.set $X1
                        local.get $px i32.const 0x1FFF i32.and
                        local.set $rx))

                ;; -- Y-axis boundary patch -----------------------------
                (if (i32.eq (local.get $input1) (i32.const 65535))
                    (then
                        local.get $maxY local.set $Y0
                        local.get $maxY local.set $Y1
                        i32.const 0     local.set $ry)
                    (else
                        local.get $py i32.const 13 i32.shr_u
                        local.get $go1 i32.mul
                        local.set $Y0
                        local.get $Y0 local.get $go1 i32.add
                        local.set $Y1
                        local.get $py i32.const 0x1FFF i32.and
                        local.set $ry))

                ;; -- Z-axis boundary patch -----------------------------
                (if (i32.eq (local.get $input2) (i32.const 65535))
                    (then
                        local.get $maxZ local.set $Z0
                        local.get $maxZ local.set $Z1
                        i32.const 0     local.set $rz)
                    (else
                        local.get $pz i32.const 13 i32.shr_u
                        local.get $go0 i32.mul
                        local.set $Z0
                        local.get $Z0 local.get $go0 i32.add
                        local.set $Z1
                        local.get $pz i32.const 0x1FFF i32.and
                        local.set $rz))

                ;; -- Initialise K-plane pass ---------------------------
                ;; tailMode: iter-1 starts as (interpK ? 1 : 0).
                ;;   interpK=0 → tailMode=0: store u16 directly
                ;;   interpK=1 → tailMode=1: stash u16 to scratch
                ;; Iter-2 (entered only if interpK=1) sets tailMode=2.
                i32.const 0
                local.set $kpass
                local.get $interpK
                local.set $tailMode

                ;; ======================================================
                ;; K-plane loop (emitted once, iterates once or twice)
                ;; ======================================================
                (block $k_exit
                    (loop $k_loop

                        ;; base0 = X0 + Y0 + Z0 + K0
                        local.get $X0
                        local.get $Y0
                        i32.add
                        local.get $Z0
                        i32.add
                        local.get $K0
                        i32.add
                        local.set $base0

                        ;; ------ CASE 1: rx >= ry >= rz -----------------
                        (if (i32.and
                                (i32.ge_s (local.get $rx) (local.get $ry))
                                (i32.ge_s (local.get $ry) (local.get $rz)))
                            (then
                                local.get $X1 local.get $Y0 i32.add
                                local.get $Z0 i32.add
                                local.get $K0 i32.add
                                local.set $base1
                                local.get $X1 local.get $Y1 i32.add
                                local.get $Z0 i32.add
                                local.get $K0 i32.add
                                local.set $base2
                                local.get $X1 local.get $Y1 i32.add
                                local.get $Z1 i32.add
                                local.get $K0 i32.add
                                local.set $base4

                                i32.const 0
                                local.set $o
                                (loop $ch_loop_c1
                                    local.get $lutPtr
                                    local.get $base1 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $a
                                    local.get $base1 i32.const 1 i32.add
                                    local.set $base1
                                    local.get $lutPtr
                                    local.get $base2 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $b
                                    local.get $base2 i32.const 1 i32.add
                                    local.set $base2
                                    local.get $lutPtr
                                    local.get $base0 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $c
                                    local.get $base0 i32.const 1 i32.add
                                    local.set $base0
                                    local.get $lutPtr
                                    local.get $base4 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $d
                                    local.get $base4 i32.const 1 i32.add
                                    local.set $base4

                                    ;; sum = (a-c)*rx + (b-a)*ry + (d-b)*rz
                                    local.get $a local.get $c i32.sub local.get $rx i32.mul
                                    local.get $b local.get $a i32.sub local.get $ry i32.mul
                                    i32.add
                                    local.get $d local.get $b i32.sub local.get $rz i32.mul
                                    i32.add
                                    local.set $sum

                                    ;; Q0.13: u16 = c + ((sum + 0x1000) >> 13)
                                    local.get $c
                                    local.get $sum i32.const 0x1000 i32.add
                                    i32.const 13 i32.shr_s
                                    i32.add
                                    local.set $u16

                                    ;; --- Inlined 3-way tail dispatch ----
                                    ;; $tailMode ∈ {0, 1, 2}:
                                    ;;   0 = !interpK: store u16 directly; outputPos += 2
                                    ;;   1 = K0 pass:  scratch[o*4] = u16; outputPos unchanged
                                    ;;   2 = K1 pass:  k0=scratch[o*4]; out=k0+((u16-k0)*rk+0x1000)>>13; store; outputPos+=2
                                    (if (i32.eq (local.get $tailMode) (i32.const 1))
                                        (then
                                            local.get $scratchPtr
                                            local.get $o i32.const 2 i32.shl
                                            i32.add
                                            local.get $u16
                                            i32.store)
                                        (else
                                            (if (i32.eq (local.get $tailMode) (i32.const 2))
                                                (then
                                                    local.get $scratchPtr
                                                    local.get $o i32.const 2 i32.shl
                                                    i32.add
                                                    i32.load
                                                    local.set $k0_u16
                                                    ;; out = k0 + ((u16 - k0) * rk + 0x1000) >> 13
                                                    local.get $k0_u16
                                                    local.get $u16 local.get $k0_u16 i32.sub
                                                    local.get $rk i32.mul
                                                    i32.const 0x1000 i32.add
                                                    i32.const 13 i32.shr_s
                                                    i32.add
                                                    local.set $out)
                                                (else
                                                    ;; out = u16 (no second rounding)
                                                    local.get $u16
                                                    local.set $out))
                                            local.get $outputPos local.get $out i32.store16
                                            local.get $outputPos i32.const 2 i32.add
                                            local.set $outputPos))

                                    local.get $o i32.const 1 i32.add
                                    local.tee $o
                                    local.get $cMax i32.lt_s
                                    br_if $ch_loop_c1))
                        (else

                        ;; ------ CASE 2: rx >= rz >= ry -----------------
                        (if (i32.and
                                (i32.ge_s (local.get $rx) (local.get $rz))
                                (i32.ge_s (local.get $rz) (local.get $ry)))
                            (then
                                local.get $X1 local.get $Y0 i32.add
                                local.get $Z0 i32.add
                                local.get $K0 i32.add
                                local.set $base1
                                local.get $X1 local.get $Y1 i32.add
                                local.get $Z1 i32.add
                                local.get $K0 i32.add
                                local.set $base2
                                local.get $X1 local.get $Y0 i32.add
                                local.get $Z1 i32.add
                                local.get $K0 i32.add
                                local.set $base3

                                i32.const 0
                                local.set $o
                                (loop $ch_loop_c2
                                    local.get $lutPtr
                                    local.get $base3 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $a
                                    local.get $base3 i32.const 1 i32.add
                                    local.set $base3
                                    local.get $lutPtr
                                    local.get $base1 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $b
                                    local.get $base1 i32.const 1 i32.add
                                    local.set $base1
                                    local.get $lutPtr
                                    local.get $base0 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $c
                                    local.get $base0 i32.const 1 i32.add
                                    local.set $base0
                                    local.get $lutPtr
                                    local.get $base2 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $d
                                    local.get $base2 i32.const 1 i32.add
                                    local.set $base2

                                    ;; sum = (b-c)*rx + (d-a)*ry + (a-b)*rz
                                    local.get $b local.get $c i32.sub local.get $rx i32.mul
                                    local.get $d local.get $a i32.sub local.get $ry i32.mul
                                    i32.add
                                    local.get $a local.get $b i32.sub local.get $rz i32.mul
                                    i32.add
                                    local.set $sum

                                    local.get $c
                                    local.get $sum i32.const 0x1000 i32.add
                                    i32.const 13 i32.shr_s
                                    i32.add
                                    local.set $u16

                                    (if (i32.eq (local.get $tailMode) (i32.const 1))
                                        (then
                                            local.get $scratchPtr
                                            local.get $o i32.const 2 i32.shl
                                            i32.add
                                            local.get $u16
                                            i32.store)
                                        (else
                                            (if (i32.eq (local.get $tailMode) (i32.const 2))
                                                (then
                                                    local.get $scratchPtr
                                                    local.get $o i32.const 2 i32.shl
                                                    i32.add
                                                    i32.load
                                                    local.set $k0_u16
                                                    local.get $k0_u16
                                                    local.get $u16 local.get $k0_u16 i32.sub
                                                    local.get $rk i32.mul
                                                    i32.const 0x1000 i32.add
                                                    i32.const 13 i32.shr_s
                                                    i32.add
                                                    local.set $out)
                                                (else
                                                    local.get $u16
                                                    local.set $out))
                                            local.get $outputPos local.get $out i32.store16
                                            local.get $outputPos i32.const 2 i32.add
                                            local.set $outputPos))

                                    local.get $o i32.const 1 i32.add
                                    local.tee $o
                                    local.get $cMax i32.lt_s
                                    br_if $ch_loop_c2))
                        (else

                        ;; ------ CASE 3: rz >= rx >= ry -----------------
                        (if (i32.and
                                (i32.ge_s (local.get $rx) (local.get $ry))
                                (i32.ge_s (local.get $rz) (local.get $rx)))
                            (then
                                local.get $X1 local.get $Y0 i32.add
                                local.get $Z1 i32.add
                                local.get $K0 i32.add
                                local.set $base1
                                local.get $X0 local.get $Y0 i32.add
                                local.get $Z1 i32.add
                                local.get $K0 i32.add
                                local.set $base2
                                local.get $X1 local.get $Y1 i32.add
                                local.get $Z1 i32.add
                                local.get $K0 i32.add
                                local.set $base3

                                i32.const 0
                                local.set $o
                                (loop $ch_loop_c3
                                    local.get $lutPtr
                                    local.get $base1 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $a
                                    local.get $base1 i32.const 1 i32.add
                                    local.set $base1
                                    local.get $lutPtr
                                    local.get $base2 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $b
                                    local.get $base2 i32.const 1 i32.add
                                    local.set $base2
                                    local.get $lutPtr
                                    local.get $base0 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $c
                                    local.get $base0 i32.const 1 i32.add
                                    local.set $base0
                                    local.get $lutPtr
                                    local.get $base3 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $d
                                    local.get $base3 i32.const 1 i32.add
                                    local.set $base3

                                    ;; sum = (a-b)*rx + (d-a)*ry + (b-c)*rz
                                    local.get $a local.get $b i32.sub local.get $rx i32.mul
                                    local.get $d local.get $a i32.sub local.get $ry i32.mul
                                    i32.add
                                    local.get $b local.get $c i32.sub local.get $rz i32.mul
                                    i32.add
                                    local.set $sum

                                    local.get $c
                                    local.get $sum i32.const 0x1000 i32.add
                                    i32.const 13 i32.shr_s
                                    i32.add
                                    local.set $u16

                                    (if (i32.eq (local.get $tailMode) (i32.const 1))
                                        (then
                                            local.get $scratchPtr
                                            local.get $o i32.const 2 i32.shl
                                            i32.add
                                            local.get $u16
                                            i32.store)
                                        (else
                                            (if (i32.eq (local.get $tailMode) (i32.const 2))
                                                (then
                                                    local.get $scratchPtr
                                                    local.get $o i32.const 2 i32.shl
                                                    i32.add
                                                    i32.load
                                                    local.set $k0_u16
                                                    local.get $k0_u16
                                                    local.get $u16 local.get $k0_u16 i32.sub
                                                    local.get $rk i32.mul
                                                    i32.const 0x1000 i32.add
                                                    i32.const 13 i32.shr_s
                                                    i32.add
                                                    local.set $out)
                                                (else
                                                    local.get $u16
                                                    local.set $out))
                                            local.get $outputPos local.get $out i32.store16
                                            local.get $outputPos i32.const 2 i32.add
                                            local.set $outputPos))

                                    local.get $o i32.const 1 i32.add
                                    local.tee $o
                                    local.get $cMax i32.lt_s
                                    br_if $ch_loop_c3))
                        (else

                        ;; ------ CASE 4: ry >= rx >= rz -----------------
                        (if (i32.and
                                (i32.ge_s (local.get $ry) (local.get $rx))
                                (i32.ge_s (local.get $rx) (local.get $rz)))
                            (then
                                local.get $X1 local.get $Y1 i32.add
                                local.get $Z0 i32.add
                                local.get $K0 i32.add
                                local.set $base1
                                local.get $X0 local.get $Y1 i32.add
                                local.get $Z0 i32.add
                                local.get $K0 i32.add
                                local.set $base2
                                local.get $X1 local.get $Y1 i32.add
                                local.get $Z1 i32.add
                                local.get $K0 i32.add
                                local.set $base4

                                i32.const 0
                                local.set $o
                                (loop $ch_loop_c4
                                    local.get $lutPtr
                                    local.get $base2 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $a
                                    local.get $base2 i32.const 1 i32.add
                                    local.set $base2
                                    local.get $lutPtr
                                    local.get $base1 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $b
                                    local.get $base1 i32.const 1 i32.add
                                    local.set $base1
                                    local.get $lutPtr
                                    local.get $base0 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $c
                                    local.get $base0 i32.const 1 i32.add
                                    local.set $base0
                                    local.get $lutPtr
                                    local.get $base4 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $d
                                    local.get $base4 i32.const 1 i32.add
                                    local.set $base4

                                    ;; sum = (b-a)*rx + (a-c)*ry + (d-b)*rz
                                    local.get $b local.get $a i32.sub local.get $rx i32.mul
                                    local.get $a local.get $c i32.sub local.get $ry i32.mul
                                    i32.add
                                    local.get $d local.get $b i32.sub local.get $rz i32.mul
                                    i32.add
                                    local.set $sum

                                    local.get $c
                                    local.get $sum i32.const 0x1000 i32.add
                                    i32.const 13 i32.shr_s
                                    i32.add
                                    local.set $u16

                                    (if (i32.eq (local.get $tailMode) (i32.const 1))
                                        (then
                                            local.get $scratchPtr
                                            local.get $o i32.const 2 i32.shl
                                            i32.add
                                            local.get $u16
                                            i32.store)
                                        (else
                                            (if (i32.eq (local.get $tailMode) (i32.const 2))
                                                (then
                                                    local.get $scratchPtr
                                                    local.get $o i32.const 2 i32.shl
                                                    i32.add
                                                    i32.load
                                                    local.set $k0_u16
                                                    local.get $k0_u16
                                                    local.get $u16 local.get $k0_u16 i32.sub
                                                    local.get $rk i32.mul
                                                    i32.const 0x1000 i32.add
                                                    i32.const 13 i32.shr_s
                                                    i32.add
                                                    local.set $out)
                                                (else
                                                    local.get $u16
                                                    local.set $out))
                                            local.get $outputPos local.get $out i32.store16
                                            local.get $outputPos i32.const 2 i32.add
                                            local.set $outputPos))

                                    local.get $o i32.const 1 i32.add
                                    local.tee $o
                                    local.get $cMax i32.lt_s
                                    br_if $ch_loop_c4))
                        (else

                        ;; ------ CASE 5: ry >= rz >= rx -----------------
                        (if (i32.and
                                (i32.ge_s (local.get $ry) (local.get $rz))
                                (i32.ge_s (local.get $rz) (local.get $rx)))
                            (then
                                local.get $X1 local.get $Y1 i32.add
                                local.get $Z1 i32.add
                                local.get $K0 i32.add
                                local.set $base1
                                local.get $X0 local.get $Y1 i32.add
                                local.get $Z1 i32.add
                                local.get $K0 i32.add
                                local.set $base2
                                local.get $X0 local.get $Y1 i32.add
                                local.get $Z0 i32.add
                                local.get $K0 i32.add
                                local.set $base3

                                i32.const 0
                                local.set $o
                                (loop $ch_loop_c5
                                    local.get $lutPtr
                                    local.get $base2 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $a
                                    local.get $base2 i32.const 1 i32.add
                                    local.set $base2
                                    local.get $lutPtr
                                    local.get $base3 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $b
                                    local.get $base3 i32.const 1 i32.add
                                    local.set $base3
                                    local.get $lutPtr
                                    local.get $base0 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $c
                                    local.get $base0 i32.const 1 i32.add
                                    local.set $base0
                                    local.get $lutPtr
                                    local.get $base1 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $d
                                    local.get $base1 i32.const 1 i32.add
                                    local.set $base1

                                    ;; sum = (d-a)*rx + (b-c)*ry + (a-b)*rz
                                    local.get $d local.get $a i32.sub local.get $rx i32.mul
                                    local.get $b local.get $c i32.sub local.get $ry i32.mul
                                    i32.add
                                    local.get $a local.get $b i32.sub local.get $rz i32.mul
                                    i32.add
                                    local.set $sum

                                    local.get $c
                                    local.get $sum i32.const 0x1000 i32.add
                                    i32.const 13 i32.shr_s
                                    i32.add
                                    local.set $u16

                                    (if (i32.eq (local.get $tailMode) (i32.const 1))
                                        (then
                                            local.get $scratchPtr
                                            local.get $o i32.const 2 i32.shl
                                            i32.add
                                            local.get $u16
                                            i32.store)
                                        (else
                                            (if (i32.eq (local.get $tailMode) (i32.const 2))
                                                (then
                                                    local.get $scratchPtr
                                                    local.get $o i32.const 2 i32.shl
                                                    i32.add
                                                    i32.load
                                                    local.set $k0_u16
                                                    local.get $k0_u16
                                                    local.get $u16 local.get $k0_u16 i32.sub
                                                    local.get $rk i32.mul
                                                    i32.const 0x1000 i32.add
                                                    i32.const 13 i32.shr_s
                                                    i32.add
                                                    local.set $out)
                                                (else
                                                    local.get $u16
                                                    local.set $out))
                                            local.get $outputPos local.get $out i32.store16
                                            local.get $outputPos i32.const 2 i32.add
                                            local.set $outputPos))

                                    local.get $o i32.const 1 i32.add
                                    local.tee $o
                                    local.get $cMax i32.lt_s
                                    br_if $ch_loop_c5))
                        (else

                        ;; ------ CASE 6: rz >= ry >= rx -----------------
                        (if (i32.and
                                (i32.ge_s (local.get $rz) (local.get $ry))
                                (i32.ge_s (local.get $ry) (local.get $rx)))
                            (then
                                local.get $X1 local.get $Y1 i32.add
                                local.get $Z1 i32.add
                                local.get $K0 i32.add
                                local.set $base1
                                local.get $X0 local.get $Y1 i32.add
                                local.get $Z1 i32.add
                                local.get $K0 i32.add
                                local.set $base2
                                local.get $X0 local.get $Y0 i32.add
                                local.get $Z1 i32.add
                                local.get $K0 i32.add
                                local.set $base4

                                i32.const 0
                                local.set $o
                                (loop $ch_loop_c6
                                    local.get $lutPtr
                                    local.get $base2 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $a
                                    local.get $base2 i32.const 1 i32.add
                                    local.set $base2
                                    local.get $lutPtr
                                    local.get $base4 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $b
                                    local.get $base4 i32.const 1 i32.add
                                    local.set $base4
                                    local.get $lutPtr
                                    local.get $base0 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $c
                                    local.get $base0 i32.const 1 i32.add
                                    local.set $base0
                                    local.get $lutPtr
                                    local.get $base1 i32.const 1 i32.shl i32.add
                                    i32.load16_u
                                    local.set $d
                                    local.get $base1 i32.const 1 i32.add
                                    local.set $base1

                                    ;; sum = (d-a)*rx + (a-b)*ry + (b-c)*rz
                                    local.get $d local.get $a i32.sub local.get $rx i32.mul
                                    local.get $a local.get $b i32.sub local.get $ry i32.mul
                                    i32.add
                                    local.get $b local.get $c i32.sub local.get $rz i32.mul
                                    i32.add
                                    local.set $sum

                                    local.get $c
                                    local.get $sum i32.const 0x1000 i32.add
                                    i32.const 13 i32.shr_s
                                    i32.add
                                    local.set $u16

                                    (if (i32.eq (local.get $tailMode) (i32.const 1))
                                        (then
                                            local.get $scratchPtr
                                            local.get $o i32.const 2 i32.shl
                                            i32.add
                                            local.get $u16
                                            i32.store)
                                        (else
                                            (if (i32.eq (local.get $tailMode) (i32.const 2))
                                                (then
                                                    local.get $scratchPtr
                                                    local.get $o i32.const 2 i32.shl
                                                    i32.add
                                                    i32.load
                                                    local.set $k0_u16
                                                    local.get $k0_u16
                                                    local.get $u16 local.get $k0_u16 i32.sub
                                                    local.get $rk i32.mul
                                                    i32.const 0x1000 i32.add
                                                    i32.const 13 i32.shr_s
                                                    i32.add
                                                    local.set $out)
                                                (else
                                                    local.get $u16
                                                    local.set $out))
                                            local.get $outputPos local.get $out i32.store16
                                            local.get $outputPos i32.const 2 i32.add
                                            local.set $outputPos))

                                    local.get $o i32.const 1 i32.add
                                    local.tee $o
                                    local.get $cMax i32.lt_s
                                    br_if $ch_loop_c6))
                        (else
                            ;; ---- Degenerate fallback (rx==ry==rz=0) ----
                            ;; Pure K-axis LERP, no 3D interp. The tetra
                            ;; sum is zero so u16 = c + (0+0x1000)>>13 = c
                            ;; (the rounding bias bias bit lies below the
                            ;; >>13 threshold). Tail dispatch handles K-LERP
                            ;; uniformly: !interpK stores c, K0 pass stashes
                            ;; c, K1 pass does c0 + (c1-c0)*rk K-LERP.
                            i32.const 0
                            local.set $o
                            (loop $ch_loop_cfb
                                local.get $lutPtr
                                local.get $base0 i32.const 1 i32.shl i32.add
                                i32.load16_u
                                local.set $c
                                local.get $base0 i32.const 1 i32.add
                                local.set $base0

                                ;; Q0.13: u16 = c (no scaling required)
                                local.get $c
                                local.set $u16

                                (if (i32.eq (local.get $tailMode) (i32.const 1))
                                    (then
                                        local.get $scratchPtr
                                        local.get $o i32.const 2 i32.shl
                                        i32.add
                                        local.get $u16
                                        i32.store)
                                    (else
                                        (if (i32.eq (local.get $tailMode) (i32.const 2))
                                            (then
                                                local.get $scratchPtr
                                                local.get $o i32.const 2 i32.shl
                                                i32.add
                                                i32.load
                                                local.set $k0_u16
                                                local.get $k0_u16
                                                local.get $u16 local.get $k0_u16 i32.sub
                                                local.get $rk i32.mul
                                                i32.const 0x1000 i32.add
                                                i32.const 13 i32.shr_s
                                                i32.add
                                                local.set $out)
                                            (else
                                                local.get $u16
                                                local.set $out))
                                        local.get $outputPos local.get $out i32.store16
                                        local.get $outputPos i32.const 2 i32.add
                                        local.set $outputPos))

                                local.get $o i32.const 1 i32.add
                                local.tee $o
                                local.get $cMax i32.lt_s
                                br_if $ch_loop_cfb))
                        )))))))))))

                        ;; --- End of K-pass body ---
                        ;; If iter 1 (kpass==0) and interpK: bump K0 to K1
                        ;; plane, flip tailMode to 2, and re-enter kloop so
                        ;; the entire case dispatch runs again with the new
                        ;; K0. outputPos was NOT advanced during iter 1 (tail
                        ;; mode 1 stashes to scratch); iter 2 writes the
                        ;; final u16 output via K-LERP.
                        (if (i32.and
                                (i32.eqz (local.get $kpass))
                                (local.get $interpK))
                            (then
                                local.get $K0 local.get $go3 i32.add
                                local.set $K0
                                i32.const 1 local.set $kpass
                                i32.const 2 local.set $tailMode
                                br $k_loop))

                        br $k_exit))

                ;; -- Alpha tail (u16 stride: 2 bytes per sample) --------
                (if (i32.eq (local.get $outAlphaMode) (i32.const 2))
                    (then
                        ;; PRESERVE-COPY 1 u16 sample
                        local.get $outputPos
                        local.get $inputPos
                        i32.load16_u
                        i32.store16
                        local.get $outputPos i32.const 2 i32.add local.set $outputPos
                        local.get $inputPos  i32.const 2 i32.add local.set $inputPos)
                    (else
                        (if (i32.eq (local.get $outAlphaMode) (i32.const 1))
                            (then
                                ;; FILL_0xFFFF
                                local.get $outputPos
                                i32.const 0xFFFF
                                i32.store16
                                local.get $outputPos i32.const 2 i32.add local.set $outputPos))
                        ;; inputPos += inAlphaSkip * 2  (samples → bytes)
                        local.get $inputPos
                        local.get $inAlphaSkip i32.const 1 i32.shl
                        i32.add
                        local.set $inputPos))

                ;; -- End-of-pixel housekeeping --------------------------
                local.get $p
                i32.const 1
                i32.add
                local.set $p
                br $pixel_loop))
    )
)
