;; ============================================================================
;; tetra3d_nch_int16.wat — 3D tetrahedral interpolation, n-channel, u16 I/O
;;                        v1.3 (Q0.13 fractional weights, true 16-bit precision)
;; ============================================================================
;;
;; Bit-exact WASM sibling of `tetrahedralInterp3DArray_{3,4,N}Ch_intLut16_loop`
;; in src/Transform.js. Same algorithm, same arithmetic ordering, same
;; rounding constants — drop a synthetic adversarial CLUT into both kernels
;; and every output u16 must match exactly. JS uses `Math.imul(a, b)`; WASM
;; uses `i32.mul`; both are defined to wrap mod 2^32 the same way, which is
;; the contract that lets us guarantee bit-exactness across V8, JSC,
;; SpiderMonkey, and any compliant WASM host.
;;
;; Q0.13 contract (shared with the JS u16 kernels):
;; -------------------------------------------------
;; - CLUT data scale: 65535  (FULL u16 range — no scale-down vs the data
;;                            type as the early v1.2 broken int16 kernel did)
;; - Input grid scale: gridPointsScale_fixed_u16 = round(((g1-1) << 13) / 65535)
;;                    Q0.13 fixed-point — passed in via the `$gps` param
;; - Boundary patch: input == 65535 (NOT 65280; we use the full u16 input
;;                                   range like every consumer expects)
;; - Per-channel math:
;;       sum = (corner_a - corner_c) * rx       ; one cross-cell delta per axis
;;           + (corner_b - corner_a) * ry
;;           + (corner_d - corner_b) * rz
;;       v   = c + ((sum + 0x1000) >> 13)       ; round-to-nearest at u13
;;       output[o] = v                          ; stored as u16 (i32.store16)
;;
;; No second-rounding bit-stretch (`v + (v >>> 8)`) like the early v1.2 int16
;; kernel did — the CLUT is now at full u16 scale, `c` enters at full u16 and
;; only the small within-cell delta gets quantized at the >>13 step. Worst-
;; case quantization error per channel ≤ 1 LSB at u16 (= 1/64 LSB at u8 =
;; 0.0015 % of u16 range).
;;
;; i32 overflow analysis (the reason for Q0.13 specifically):
;; ---------------------------------------------------------
;; - corner_u16 - corner_u16 → s17 (signed 17-bit)
;; - i32.mul(s17, u13)        → s30
;; - sum of 3 such terms      → s30.6
;; - + 0x1000 (s30.6)         → still fits s31  ← ~1.4 bits headroom
;; - >> 13 (signed)           → s17.6
;; - + corner_u16             → fits s31 trivially
;; Going up to Q0.14 weights blows past the i32 envelope; Q0.13 is the
;; max safe precision for an i32-internal kernel without runtime bound
;; checks. lcms uses Q0.16 weights and accepts i64 (or trusts non-
;; adversarial CLUTs) — see docs/deepdive/Accuracy.md "16-bit kernel
;; accuracy (v1.3, Q0.13)" for the design rationale.
;;
;; Earlier u8-style baggage removed (DO NOT add back):
;;   - Per-axis `>> 16` shift   →  was for Q0.16 weights against a 65280-scale
;;                                  CLUT. Replaced with `>> 13` for Q0.13.
;;   - `(px >> 8) & 0xFF` u8 weight extract → replaced with `px & 0x1FFF`.
;;   - `(sum + 0x80) >> 8` rounding → replaced with `(sum + 0x1000) >> 13`.
;;   - `v + (v >>> 8)` u8→u16 bit-stretch → removed (CLUT is at scale 65535).
;;   - Fallback `c + (c >>> 8)` → just `c` (already at full u16 scale).
;;
;; Memory layout (caller-provided byte offsets into linear memory, identical
;; to the v1.2 u8 kernels — only the CLUT contents and the per-pixel math
;; changed):
;;
;;   [ inputPtr  ..  inputPtr  + pixelCount*3*2 )      u16 RGB input
;;   [ outputPtr ..  outputPtr + pixelCount*cMax*2 )   u16 n-channel output
;;   [ lutPtr    ..  lutPtr    + lutLen*2 )            u16 CLUT @ scale 65535
;;
;; Stride conventions (parameters, all in u16-element units, NOT bytes):
;;   go0 = outputChannels             (step to next Z slice entry)
;;   go1 = g1 * outputChannels        (step to next Y row)
;;   go2 = g1 * g1 * outputChannels   (step to next X plane)
;;
;; gps  — gridPointsScale_fixed_u16, Q0.13 (typically 4 for g1=33, 8 for g1=65)
;; maxX/Y/Z — boundary patch grid offsets (g1-1 in the relevant stride units)
;;
;; Alpha handling (mirrors tetra3d_nch.wat exactly, but reads/writes 2 bytes
;; per alpha sample):
;;   $inAlphaSkip    0 or 1 — alpha samples to skip after each input
;;                   pixel's RGB. Stride is 2 BYTES per alpha sample
;;                   (i.e. inputPos += inAlphaSkip * 2).
;;   $outAlphaMode   0 = no output alpha
;;                   1 = fill output alpha sample with 0xFFFF
;;                   2 = preserve-copy 1 input u16 alpha → 1 output u16
;;
;; ============================================================================

(module
    (memory (export "memory") 1)

    (func (export "interp_tetra3d_nCh_int16")
        (param $inputPtr     i32)
        (param $outputPtr    i32)
        (param $lutPtr       i32)
        (param $pixelCount   i32)
        (param $cMax         i32)
        (param $go0          i32)
        (param $go1          i32)
        (param $go2          i32)
        (param $gps          i32)   ;; pass gridPointsScale_fixed_u16 (Q0.13)
        (param $maxX         i32)
        (param $maxY         i32)
        (param $maxZ         i32)
        (param $inAlphaSkip  i32)   ;; 0 or 1 (samples; stride is 2 bytes)
        (param $outAlphaMode i32)   ;; 0 = none, 1 = fill 0xFFFF, 2 = preserve-copy

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

        (local $base0       i32)
        (local $base1       i32)
        (local $base2       i32)
        (local $base3       i32)
        (local $base4       i32)

        (local $o           i32)
        (local $a           i32)
        (local $b           i32)
        (local $c           i32)
        (local $d           i32)
        (local $sum         i32)
        (local $out         i32)   ;; final u16 output value (no bit-stretch)

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

                ;; Load 3 u16 input samples (stride 2 bytes per sample)
                local.get $inputPos
                i32.load16_u
                local.set $input0

                local.get $inputPos
                i32.const 2
                i32.add
                i32.load16_u
                local.set $input1

                local.get $inputPos
                i32.const 4
                i32.add
                i32.load16_u
                local.set $input2

                local.get $inputPos
                i32.const 6
                i32.add
                local.set $inputPos

                ;; px = input0 * gps   (Q0.13 grid coordinate; gps is Q0.13)
                ;; Bit budget: u16 * Q0.13 ≤ 2^29, fits i32 with 3 bits headroom.
                local.get $input0
                local.get $gps
                i32.mul
                local.set $px

                local.get $input1
                local.get $gps
                i32.mul
                local.set $py

                local.get $input2
                local.get $gps
                i32.mul
                local.set $pz

                ;; -- X-axis boundary patch (input0 === 65535 → clamp) ----
                (if (i32.eq (local.get $input0) (i32.const 65535))
                    (then
                        local.get $maxX
                        local.set $X0
                        local.get $maxX
                        local.set $X1
                        i32.const 0
                        local.set $rx)
                    (else
                        ;; X0 = (px >>> 13) * go2  ; cell index times stride
                        ;; rx = px & 0x1FFF        ; Q0.13 fractional weight
                        local.get $px
                        i32.const 13
                        i32.shr_u
                        local.get $go2
                        i32.mul
                        local.set $X0
                        local.get $X0
                        local.get $go2
                        i32.add
                        local.set $X1
                        local.get $px
                        i32.const 0x1FFF
                        i32.and
                        local.set $rx))

                ;; -- Y-axis boundary patch -------------------------------
                (if (i32.eq (local.get $input1) (i32.const 65535))
                    (then
                        local.get $maxY
                        local.set $Y0
                        local.get $maxY
                        local.set $Y1
                        i32.const 0
                        local.set $ry)
                    (else
                        local.get $py
                        i32.const 13
                        i32.shr_u
                        local.get $go1
                        i32.mul
                        local.set $Y0
                        local.get $Y0
                        local.get $go1
                        i32.add
                        local.set $Y1
                        local.get $py
                        i32.const 0x1FFF
                        i32.and
                        local.set $ry))

                ;; -- Z-axis boundary patch -------------------------------
                (if (i32.eq (local.get $input2) (i32.const 65535))
                    (then
                        local.get $maxZ
                        local.set $Z0
                        local.get $maxZ
                        local.set $Z1
                        i32.const 0
                        local.set $rz)
                    (else
                        local.get $pz
                        i32.const 13
                        i32.shr_u
                        local.get $go0
                        i32.mul
                        local.set $Z0
                        local.get $Z0
                        local.get $go0
                        i32.add
                        local.set $Z1
                        local.get $pz
                        i32.const 0x1FFF
                        i32.and
                        local.set $rz))

                ;; base0 = X0 + Y0 + Z0   (anchor corner, u16 element index)
                local.get $X0
                local.get $Y0
                i32.add
                local.get $Z0
                i32.add
                local.set $base0

                ;; ======================================================
                ;; Tetrahedral case dispatch — same 6 cases as the JS kernel.
                ;; Per-channel math (Q0.13, no bit-stretch):
                ;;
                ;;   sum = (edge_x)*rx + (edge_y)*ry + (edge_z)*rz
                ;;   out = c + ((sum + 0x1000) >> 13)        ; round-to-nearest
                ;;   i32.store16 (truncates high bits = matches JS Uint16Array)

                ;; ------ CASE 1: rx >= ry >= rz -----------------------
                (if (i32.and
                        (i32.ge_s (local.get $rx) (local.get $ry))
                        (i32.ge_s (local.get $ry) (local.get $rz)))
                    (then
                        local.get $X1 local.get $Y0 i32.add local.get $Z0 i32.add
                        local.set $base1
                        local.get $X1 local.get $Y1 i32.add local.get $Z0 i32.add
                        local.set $base2
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
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

                            ;; out = c + ((sum + 0x1000) >> 13)
                            local.get $c
                            local.get $sum i32.const 0x1000 i32.add i32.const 13 i32.shr_s
                            i32.add
                            local.set $out

                            ;; output[outputPos] = out (u16); outputPos += 2
                            local.get $outputPos
                            local.get $out
                            i32.store16
                            local.get $outputPos i32.const 2 i32.add
                            local.set $outputPos

                            local.get $o i32.const 1 i32.add
                            local.tee $o
                            local.get $cMax
                            i32.lt_s
                            br_if $ch_loop_c1))
                (else

                ;; ------ CASE 2: rx >= rz >= ry -----------------------
                (if (i32.and
                        (i32.ge_s (local.get $rx) (local.get $rz))
                        (i32.ge_s (local.get $rz) (local.get $ry)))
                    (then
                        local.get $X1 local.get $Y0 i32.add local.get $Z0 i32.add
                        local.set $base1
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base2
                        local.get $X1 local.get $Y0 i32.add local.get $Z1 i32.add
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
                            local.get $sum i32.const 0x1000 i32.add i32.const 13 i32.shr_s
                            i32.add
                            local.set $out

                            local.get $outputPos local.get $out i32.store16
                            local.get $outputPos i32.const 2 i32.add
                            local.set $outputPos

                            local.get $o i32.const 1 i32.add
                            local.tee $o
                            local.get $cMax i32.lt_s
                            br_if $ch_loop_c2))
                (else

                ;; ------ CASE 3: rz >= rx >= ry -----------------------
                (if (i32.and
                        (i32.ge_s (local.get $rx) (local.get $ry))
                        (i32.ge_s (local.get $rz) (local.get $rx)))
                    (then
                        local.get $X1 local.get $Y0 i32.add local.get $Z1 i32.add
                        local.set $base1
                        local.get $X0 local.get $Y0 i32.add local.get $Z1 i32.add
                        local.set $base2
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
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
                            local.get $sum i32.const 0x1000 i32.add i32.const 13 i32.shr_s
                            i32.add
                            local.set $out

                            local.get $outputPos local.get $out i32.store16
                            local.get $outputPos i32.const 2 i32.add
                            local.set $outputPos

                            local.get $o i32.const 1 i32.add
                            local.tee $o
                            local.get $cMax i32.lt_s
                            br_if $ch_loop_c3))
                (else

                ;; ------ CASE 4: ry >= rx >= rz -----------------------
                (if (i32.and
                        (i32.ge_s (local.get $ry) (local.get $rx))
                        (i32.ge_s (local.get $rx) (local.get $rz)))
                    (then
                        local.get $X1 local.get $Y1 i32.add local.get $Z0 i32.add
                        local.set $base1
                        local.get $X0 local.get $Y1 i32.add local.get $Z0 i32.add
                        local.set $base2
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
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
                            local.get $sum i32.const 0x1000 i32.add i32.const 13 i32.shr_s
                            i32.add
                            local.set $out

                            local.get $outputPos local.get $out i32.store16
                            local.get $outputPos i32.const 2 i32.add
                            local.set $outputPos

                            local.get $o i32.const 1 i32.add
                            local.tee $o
                            local.get $cMax i32.lt_s
                            br_if $ch_loop_c4))
                (else

                ;; ------ CASE 5: ry >= rz >= rx -----------------------
                (if (i32.and
                        (i32.ge_s (local.get $ry) (local.get $rz))
                        (i32.ge_s (local.get $rz) (local.get $rx)))
                    (then
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base1
                        local.get $X0 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base2
                        local.get $X0 local.get $Y1 i32.add local.get $Z0 i32.add
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
                            local.get $sum i32.const 0x1000 i32.add i32.const 13 i32.shr_s
                            i32.add
                            local.set $out

                            local.get $outputPos local.get $out i32.store16
                            local.get $outputPos i32.const 2 i32.add
                            local.set $outputPos

                            local.get $o i32.const 1 i32.add
                            local.tee $o
                            local.get $cMax i32.lt_s
                            br_if $ch_loop_c5))
                (else

                ;; ------ CASE 6: rz >= ry >= rx -----------------------
                (if (i32.and
                        (i32.ge_s (local.get $rz) (local.get $ry))
                        (i32.ge_s (local.get $ry) (local.get $rx)))
                    (then
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base1
                        local.get $X0 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base2
                        local.get $X0 local.get $Y0 i32.add local.get $Z1 i32.add
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
                            local.get $sum i32.const 0x1000 i32.add i32.const 13 i32.shr_s
                            i32.add
                            local.set $out

                            local.get $outputPos local.get $out i32.store16
                            local.get $outputPos i32.const 2 i32.add
                            local.set $outputPos

                            local.get $o i32.const 1 i32.add
                            local.tee $o
                            local.get $cMax i32.lt_s
                            br_if $ch_loop_c6))
                (else
                    ;; ---- Fallback (degenerate; matches JS fallback at
                    ;;      _intLut16_loop bottom — write c at full u16
                    ;;      precision; no bit-stretch needed because CLUT
                    ;;      is already at scale 65535) -----------------
                    i32.const 0
                    local.set $o
                    (loop $ch_loop_cfb
                        local.get $lutPtr
                        local.get $base0 i32.const 1 i32.shl i32.add
                        i32.load16_u
                        local.set $c
                        local.get $base0 i32.const 1 i32.add
                        local.set $base0

                        ;; out = c (no scale stretch — CLUT is at full u16)
                        local.get $outputPos local.get $c i32.store16
                        local.get $outputPos i32.const 2 i32.add
                        local.set $outputPos

                        local.get $o i32.const 1 i32.add
                        local.tee $o
                        local.get $cMax i32.lt_s
                        br_if $ch_loop_cfb))
                )))))))))))

                ;; -- Alpha tail (u16 stride: 2 bytes per sample) ---------
                ;;   if (preserveAlpha)  { output[o] = input[i]; o += 2; i += 2; }
                ;;   else                { i += inAlphaSkip * 2;
                ;;                         if (outAlpha==1) { output[o] = 0xFFFF; o += 2; } }
                (if (i32.eq (local.get $outAlphaMode) (i32.const 2))
                    (then
                        ;; PRESERVE-COPY (1 u16 sample)
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
                        ;; inputPos += inAlphaSkip * 2
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
