;; ============================================================================
;; tetra3d_nch.wat — 3D tetrahedral interpolation, n-channel output, int math
;; ============================================================================
;;
;; Hand-written WASM port of the hot path from src/Transform.js.
;;
;; Ported semantics are a hybrid of TWO JS kernels:
;;   - Outer shape   : `tetrahedralInterp3D_NCh`              (Transform.js:6472)
;;                     6 tetrahedral cases × channel loop 0..cMax
;;                     (chosen because it's the cleanest "n-channel" form
;;                     already in the codebase — each case is a tight loop,
;;                     not an unrolled 3× body.)
;;   - Integer math  : `tetrahedralInterp3DArray_3Ch_intLut_loop` (:9033)
;;                     Q0.16 gridPointsScale_fixed, u16 CLUT,
;;                     Math.imul-style i32 products,
;;                     `(x + 0x80) >> 8` rounding (applied twice: u16 → u16,
;;                     then u16 → u8).
;;
;; First-cut goal:
;;
;;   Does WASM scalar BEAT the JS int kernel at cMax=3, or does V8 already
;;   produce machine code of the same quality for this algorithm?
;;
;;   If WASM beats JS by ≥30%: v1.2 WASM port is green-lit, and the rolled
;;   channel-loop form (this kernel) is justified — same kernel handles
;;   3Ch/4Ch/NCh, L1i footprint drops ~4×.
;;
;;   If WASM is within ±10%: V8 is at the ceiling for this algorithm and
;;   the port only pays off for SIMD-friendly subsets (no gather).
;;
;; Memory layout (caller-provided, all offsets are byte offsets into linear
;; memory):
;;
;;   [ inputPtr ..  inputPtr  + pixelCount*3 )     u8 RGB input
;;   [ outputPtr .. outputPtr + pixelCount*cMax )  u8 n-channel output
;;   [ lutPtr ..    lutPtr    + lutLen*2 )         u16 CLUT (as produced
;;                                                  by Transform.intLut.CLUT)
;;
;; Stride conventions (bytes passed in as parameters, mirrors intLut.goN):
;;
;;   go0 = outputChannels             (step to next Z slice entry)
;;   go1 = g1 * outputChannels        (step to next Y row)
;;   go2 = g1 * g1 * outputChannels   (step to next X plane)
;;
;;   All three are in u16-element units, NOT bytes — matching the JS
;;   intLut convention exactly. (CLUT[idx] in JS == memory.loadU16(lutPtr+idx*2)
;;   in WASM.)
;;
;; gps is gridPointsScale_fixed, Q0.16 — e.g. 4112 for g1=17, 8225 for g1=33.
;;
;; Alpha handling (two extra params at the end of the signature):
;;
;;   $inAlphaSkip    0 or 1 — bytes to skip after each input pixel's RGB
;;                   (1 when inputHasAlpha, 0 otherwise)
;;   $outAlphaMode   0 = no output alpha slot (normal RGB→{3,4}Ch)
;;                   1 = fill output alpha byte with 255 (outputHasAlpha
;;                       and NOT preserveAlpha)
;;                   2 = copy input alpha byte through to output alpha byte
;;                       (preserveAlpha; inputHasAlpha must also be true)
;;
;; This maps exactly to the JS alpha tail in _3Ch_intLut_loop /
;; _4Ch_intLut_loop:
;;
;;   if (preserveAlpha)     { output[o++] = input[i++]; }
;;   else if (outAlpha)     { if (inAlpha) i++; output[o++] = 255; }
;;   else if (inAlpha)      { i++; }
;;
;; It's ~10 instructions of WAT at the bottom of the pixel loop; the
;; interpolation math itself is entirely unchanged. Passing flags rather
;; than byte-strides keeps V8's WASM backend free to hoist the
;; outAlphaMode check out of the per-pixel iteration via PGO.
;;
;; ============================================================================

(module
    (memory (export "memory") 1)

    ;; ------------------------------------------------------------------------
    ;; interp_tetra3d_nCh
    ;;
    ;; Parameters exactly match the JS reference except:
    ;;   - pointers (byte offsets) replace the (array, pos) pairs
    ;;   - alpha flags compressed to two params (see header for mapping)
    ;; ------------------------------------------------------------------------
    (func (export "interp_tetra3d_nCh")
        (param $inputPtr     i32)
        (param $outputPtr    i32)
        (param $lutPtr       i32)
        (param $pixelCount   i32)
        (param $cMax         i32)
        (param $go0          i32)
        (param $go1          i32)
        (param $go2          i32)
        (param $gps          i32)
        (param $maxX         i32)
        (param $maxY         i32)
        (param $maxZ         i32)
        (param $inAlphaSkip  i32)   ;; 0 or 1
        (param $outAlphaMode i32)   ;; 0 = none, 1 = fill 255, 2 = preserve-copy

        ;; Per-pixel loop state
        (local $p           i32)
        (local $inputPos    i32)   ;; byte offset into memory
        (local $outputPos   i32)   ;; byte offset into memory

        ;; Decoded pixel
        (local $input0      i32)
        (local $input1      i32)
        (local $input2      i32)
        (local $px          i32)
        (local $py          i32)
        (local $pz          i32)

        ;; Grid indices + fractional weights
        (local $X0          i32)
        (local $X1          i32)
        (local $Y0          i32)
        (local $Y1          i32)
        (local $Z0          i32)
        (local $Z1          i32)
        (local $rx          i32)
        (local $ry          i32)
        (local $rz          i32)

        ;; Tetrahedron corner base indices (u16 element units)
        (local $base0       i32)
        (local $base1       i32)
        (local $base2       i32)
        (local $base3       i32)
        (local $base4       i32)

        ;; Channel loop state
        (local $o           i32)
        (local $a           i32)   ;; a, b = CLUT reads on the "edges" of tetra
        (local $b           i32)
        (local $c           i32)   ;; c = CLUT at anchor corner (per channel)
        (local $d           i32)   ;; d = CLUT at opposite corner
        (local $sum         i32)   ;; sum of three products (signed)
        (local $u16         i32)   ;; c + rounded term (pre-clamp)
        (local $u8          i32)   ;; clamped u8 output

        ;; -- Init ----------------------------------------------------------
        local.get $inputPtr
        local.set $inputPos
        local.get $outputPtr
        local.set $outputPos

        ;; -- Main per-pixel loop ------------------------------------------
        (block $pixel_exit
            (loop $pixel_loop

                ;; Exit condition: p >= pixelCount
                local.get $p
                local.get $pixelCount
                i32.ge_s
                br_if $pixel_exit

                ;; Load 3 u8 input bytes
                local.get $inputPos
                i32.load8_u
                local.set $input0

                local.get $inputPos
                i32.const 1
                i32.add
                i32.load8_u
                local.set $input1

                local.get $inputPos
                i32.const 2
                i32.add
                i32.load8_u
                local.set $input2

                local.get $inputPos
                i32.const 3
                i32.add
                local.set $inputPos

                ;; px = input0 * gps   (Q8.16 grid coordinate)
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

                ;; -- X-axis boundary patch (input0 === 255 → clamp) -------
                (if (i32.eq (local.get $input0) (i32.const 255))
                    (then
                        local.get $maxX
                        local.set $X0
                        local.get $maxX
                        local.set $X1
                        i32.const 0
                        local.set $rx)
                    (else
                        ;; X0 = (px >>> 16) * go2
                        local.get $px
                        i32.const 16
                        i32.shr_u
                        local.get $go2
                        i32.mul
                        local.set $X0
                        ;; X1 = X0 + go2
                        local.get $X0
                        local.get $go2
                        i32.add
                        local.set $X1
                        ;; rx = (px >>> 8) & 0xFF
                        local.get $px
                        i32.const 8
                        i32.shr_u
                        i32.const 0xFF
                        i32.and
                        local.set $rx))

                ;; -- Y-axis boundary patch -------------------------------
                (if (i32.eq (local.get $input1) (i32.const 255))
                    (then
                        local.get $maxY
                        local.set $Y0
                        local.get $maxY
                        local.set $Y1
                        i32.const 0
                        local.set $ry)
                    (else
                        local.get $py
                        i32.const 16
                        i32.shr_u
                        local.get $go1
                        i32.mul
                        local.set $Y0
                        local.get $Y0
                        local.get $go1
                        i32.add
                        local.set $Y1
                        local.get $py
                        i32.const 8
                        i32.shr_u
                        i32.const 0xFF
                        i32.and
                        local.set $ry))

                ;; -- Z-axis boundary patch -------------------------------
                (if (i32.eq (local.get $input2) (i32.const 255))
                    (then
                        local.get $maxZ
                        local.set $Z0
                        local.get $maxZ
                        local.set $Z1
                        i32.const 0
                        local.set $rz)
                    (else
                        local.get $pz
                        i32.const 16
                        i32.shr_u
                        local.get $go0
                        i32.mul
                        local.set $Z0
                        local.get $Z0
                        local.get $go0
                        i32.add
                        local.set $Z1
                        local.get $pz
                        i32.const 8
                        i32.shr_u
                        i32.const 0xFF
                        i32.and
                        local.set $rz))

                ;; base0 = X0 + Y0 + Z0    (anchor corner, u16 element index)
                local.get $X0
                local.get $Y0
                i32.add
                local.get $Z0
                i32.add
                local.set $base0

                ;; ======================================================
                ;; Tetrahedral case dispatch
                ;; ======================================================
                ;; Six cases, mirrors Transform.js:9074..9138 exactly.
                ;; Each case computes cMax output bytes via an inner loop.
                ;;
                ;; Per-channel math (same in every case, only the 3 tetra
                ;; edges change):
                ;;
                ;;   a, b, d = CLUT reads on the three non-anchor tetra corners
                ;;   c       = CLUT read on the anchor corner (this channel)
                ;;   sum     = (edge_x) * rx + (edge_y) * ry + (edge_z) * rz
                ;;   u16     = c + ((sum + 0x80) >> 8)
                ;;   u8      = clamp( (u16 + 0x80) >> 8 )
                ;;
                ;; where edge_{x,y,z} are signed deltas between the tetra
                ;; corner values, varying per case.

                ;; ------ CASE 1: rx >= ry >= rz -----------------------
                (if (i32.and
                        (i32.ge_s (local.get $rx) (local.get $ry))
                        (i32.ge_s (local.get $ry) (local.get $rz)))
                    (then
                        ;; base1 = X1 + Y0 + Z0
                        local.get $X1 local.get $Y0 i32.add local.get $Z0 i32.add
                        local.set $base1
                        ;; base2 = X1 + Y1 + Z0
                        local.get $X1 local.get $Y1 i32.add local.get $Z0 i32.add
                        local.set $base2
                        ;; base4 = X1 + Y1 + Z1
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base4

                        i32.const 0
                        local.set $o
                        (loop $ch_loop_c1
                            ;; a = CLUT[base1++]
                            local.get $lutPtr
                            local.get $base1 i32.const 1 i32.shl
                            i32.add
                            i32.load16_u
                            local.set $a
                            local.get $base1 i32.const 1 i32.add
                            local.set $base1

                            ;; b = CLUT[base2++]
                            local.get $lutPtr
                            local.get $base2 i32.const 1 i32.shl
                            i32.add
                            i32.load16_u
                            local.set $b
                            local.get $base2 i32.const 1 i32.add
                            local.set $base2

                            ;; c = CLUT[base0++]
                            local.get $lutPtr
                            local.get $base0 i32.const 1 i32.shl
                            i32.add
                            i32.load16_u
                            local.set $c
                            local.get $base0 i32.const 1 i32.add
                            local.set $base0

                            ;; d = CLUT[base4++]
                            local.get $lutPtr
                            local.get $base4 i32.const 1 i32.shl
                            i32.add
                            i32.load16_u
                            local.set $d
                            local.get $base4 i32.const 1 i32.add
                            local.set $base4

                            ;; sum = (a - c)*rx + (b - a)*ry + (d - b)*rz
                            local.get $a local.get $c i32.sub local.get $rx i32.mul
                            local.get $b local.get $a i32.sub local.get $ry i32.mul
                            i32.add
                            local.get $d local.get $b i32.sub local.get $rz i32.mul
                            i32.add
                            local.set $sum

                            ;; u16 = c + ((sum + 0x80) >> 8)         [signed shift]
                            local.get $c
                            local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s
                            i32.add
                            local.set $u16

                            ;; u8 = (u16 + 0x80) >> 8   then clamp to [0,255]
                            local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                            local.set $u8

                            ;; Clamp low:  if (u8 < 0) u8 = 0
                            local.get $u8
                            i32.const 0
                            local.get $u8 i32.const 0 i32.ge_s
                            select
                            local.set $u8
                            ;; Clamp high: if (u8 > 255) u8 = 255
                            local.get $u8
                            i32.const 255
                            local.get $u8 i32.const 256 i32.lt_s
                            select
                            local.set $u8

                            ;; output[outputPos++] = u8
                            local.get $outputPos
                            local.get $u8
                            i32.store8
                            local.get $outputPos i32.const 1 i32.add
                            local.set $outputPos

                            ;; ++o; if (o < cMax) continue
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
                        ;; base1 = X1 + Y0 + Z0
                        local.get $X1 local.get $Y0 i32.add local.get $Z0 i32.add
                        local.set $base1
                        ;; base2 = X1 + Y1 + Z1
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base2
                        ;; base3 = X1 + Y0 + Z1
                        local.get $X1 local.get $Y0 i32.add local.get $Z1 i32.add
                        local.set $base3

                        i32.const 0
                        local.set $o
                        (loop $ch_loop_c2
                            ;; a = CLUT[base3++]
                            local.get $lutPtr
                            local.get $base3 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $a
                            local.get $base3 i32.const 1 i32.add
                            local.set $base3
                            ;; b = CLUT[base1++]
                            local.get $lutPtr
                            local.get $base1 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $b
                            local.get $base1 i32.const 1 i32.add
                            local.set $base1
                            ;; c = CLUT[base0++]
                            local.get $lutPtr
                            local.get $base0 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $c
                            local.get $base0 i32.const 1 i32.add
                            local.set $base0
                            ;; d = CLUT[base2++]   (opposite corner for this case)
                            local.get $lutPtr
                            local.get $base2 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $d
                            local.get $base2 i32.const 1 i32.add
                            local.set $base2

                            ;; sum = (b - c)*rx + (d - a)*ry + (a - b)*rz
                            local.get $b local.get $c i32.sub local.get $rx i32.mul
                            local.get $d local.get $a i32.sub local.get $ry i32.mul
                            i32.add
                            local.get $a local.get $b i32.sub local.get $rz i32.mul
                            i32.add
                            local.set $sum

                            local.get $c
                            local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s
                            i32.add
                            local.set $u16
                            local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                            local.set $u8
                            local.get $u8 i32.const 0
                                local.get $u8 i32.const 0 i32.ge_s
                                select
                                local.set $u8
                            local.get $u8 i32.const 255
                                local.get $u8 i32.const 256 i32.lt_s
                                select
                                local.set $u8

                            local.get $outputPos local.get $u8 i32.store8
                            local.get $outputPos i32.const 1 i32.add
                            local.set $outputPos

                            local.get $o i32.const 1 i32.add
                            local.tee $o
                            local.get $cMax i32.lt_s
                            br_if $ch_loop_c2))
                (else

                ;; ------ CASE 3: rz >= rx >= ry -----------------------
                ;; JS condition: (rx >= ry && rz >= rx)
                (if (i32.and
                        (i32.ge_s (local.get $rx) (local.get $ry))
                        (i32.ge_s (local.get $rz) (local.get $rx)))
                    (then
                        ;; base1 = X1 + Y0 + Z1
                        local.get $X1 local.get $Y0 i32.add local.get $Z1 i32.add
                        local.set $base1
                        ;; base2 = X0 + Y0 + Z1
                        local.get $X0 local.get $Y0 i32.add local.get $Z1 i32.add
                        local.set $base2
                        ;; base3 = X1 + Y1 + Z1
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base3

                        i32.const 0
                        local.set $o
                        (loop $ch_loop_c3
                            ;; a = CLUT[base1++]
                            local.get $lutPtr
                            local.get $base1 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $a
                            local.get $base1 i32.const 1 i32.add
                            local.set $base1
                            ;; b = CLUT[base2++]
                            local.get $lutPtr
                            local.get $base2 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $b
                            local.get $base2 i32.const 1 i32.add
                            local.set $base2
                            ;; c = CLUT[base0++]
                            local.get $lutPtr
                            local.get $base0 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $c
                            local.get $base0 i32.const 1 i32.add
                            local.set $base0
                            ;; d = CLUT[base3++]
                            local.get $lutPtr
                            local.get $base3 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $d
                            local.get $base3 i32.const 1 i32.add
                            local.set $base3

                            ;; sum = (a - b)*rx + (d - a)*ry + (b - c)*rz
                            local.get $a local.get $b i32.sub local.get $rx i32.mul
                            local.get $d local.get $a i32.sub local.get $ry i32.mul
                            i32.add
                            local.get $b local.get $c i32.sub local.get $rz i32.mul
                            i32.add
                            local.set $sum

                            local.get $c
                            local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s
                            i32.add
                            local.set $u16
                            local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                            local.set $u8
                            local.get $u8 i32.const 0
                                local.get $u8 i32.const 0 i32.ge_s
                                select
                                local.set $u8
                            local.get $u8 i32.const 255
                                local.get $u8 i32.const 256 i32.lt_s
                                select
                                local.set $u8

                            local.get $outputPos local.get $u8 i32.store8
                            local.get $outputPos i32.const 1 i32.add
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
                        ;; base1 = X1 + Y1 + Z0
                        local.get $X1 local.get $Y1 i32.add local.get $Z0 i32.add
                        local.set $base1
                        ;; base2 = X0 + Y1 + Z0
                        local.get $X0 local.get $Y1 i32.add local.get $Z0 i32.add
                        local.set $base2
                        ;; base4 = X1 + Y1 + Z1
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base4

                        i32.const 0
                        local.set $o
                        (loop $ch_loop_c4
                            ;; a = CLUT[base2++]
                            local.get $lutPtr
                            local.get $base2 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $a
                            local.get $base2 i32.const 1 i32.add
                            local.set $base2
                            ;; b = CLUT[base1++]
                            local.get $lutPtr
                            local.get $base1 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $b
                            local.get $base1 i32.const 1 i32.add
                            local.set $base1
                            ;; c = CLUT[base0++]
                            local.get $lutPtr
                            local.get $base0 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $c
                            local.get $base0 i32.const 1 i32.add
                            local.set $base0
                            ;; d = CLUT[base4++]
                            local.get $lutPtr
                            local.get $base4 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $d
                            local.get $base4 i32.const 1 i32.add
                            local.set $base4

                            ;; sum = (b - a)*rx + (a - c)*ry + (d - b)*rz
                            local.get $b local.get $a i32.sub local.get $rx i32.mul
                            local.get $a local.get $c i32.sub local.get $ry i32.mul
                            i32.add
                            local.get $d local.get $b i32.sub local.get $rz i32.mul
                            i32.add
                            local.set $sum

                            local.get $c
                            local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s
                            i32.add
                            local.set $u16
                            local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                            local.set $u8
                            local.get $u8 i32.const 0
                                local.get $u8 i32.const 0 i32.ge_s
                                select
                                local.set $u8
                            local.get $u8 i32.const 255
                                local.get $u8 i32.const 256 i32.lt_s
                                select
                                local.set $u8

                            local.get $outputPos local.get $u8 i32.store8
                            local.get $outputPos i32.const 1 i32.add
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
                        ;; base1 = X1 + Y1 + Z1
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base1
                        ;; base2 = X0 + Y1 + Z1
                        local.get $X0 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base2
                        ;; base3 = X0 + Y1 + Z0
                        local.get $X0 local.get $Y1 i32.add local.get $Z0 i32.add
                        local.set $base3

                        i32.const 0
                        local.set $o
                        (loop $ch_loop_c5
                            ;; a = CLUT[base2++]
                            local.get $lutPtr
                            local.get $base2 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $a
                            local.get $base2 i32.const 1 i32.add
                            local.set $base2
                            ;; b = CLUT[base3++]
                            local.get $lutPtr
                            local.get $base3 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $b
                            local.get $base3 i32.const 1 i32.add
                            local.set $base3
                            ;; c = CLUT[base0++]
                            local.get $lutPtr
                            local.get $base0 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $c
                            local.get $base0 i32.const 1 i32.add
                            local.set $base0
                            ;; d = CLUT[base1++]
                            local.get $lutPtr
                            local.get $base1 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $d
                            local.get $base1 i32.const 1 i32.add
                            local.set $base1

                            ;; sum = (d - a)*rx + (b - c)*ry + (a - b)*rz
                            local.get $d local.get $a i32.sub local.get $rx i32.mul
                            local.get $b local.get $c i32.sub local.get $ry i32.mul
                            i32.add
                            local.get $a local.get $b i32.sub local.get $rz i32.mul
                            i32.add
                            local.set $sum

                            local.get $c
                            local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s
                            i32.add
                            local.set $u16
                            local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                            local.set $u8
                            local.get $u8 i32.const 0
                                local.get $u8 i32.const 0 i32.ge_s
                                select
                                local.set $u8
                            local.get $u8 i32.const 255
                                local.get $u8 i32.const 256 i32.lt_s
                                select
                                local.set $u8

                            local.get $outputPos local.get $u8 i32.store8
                            local.get $outputPos i32.const 1 i32.add
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
                        ;; base1 = X1 + Y1 + Z1
                        local.get $X1 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base1
                        ;; base2 = X0 + Y1 + Z1
                        local.get $X0 local.get $Y1 i32.add local.get $Z1 i32.add
                        local.set $base2
                        ;; base4 = X0 + Y0 + Z1
                        local.get $X0 local.get $Y0 i32.add local.get $Z1 i32.add
                        local.set $base4

                        i32.const 0
                        local.set $o
                        (loop $ch_loop_c6
                            ;; a = CLUT[base2++]
                            local.get $lutPtr
                            local.get $base2 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $a
                            local.get $base2 i32.const 1 i32.add
                            local.set $base2
                            ;; b = CLUT[base4++]
                            local.get $lutPtr
                            local.get $base4 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $b
                            local.get $base4 i32.const 1 i32.add
                            local.set $base4
                            ;; c = CLUT[base0++]
                            local.get $lutPtr
                            local.get $base0 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $c
                            local.get $base0 i32.const 1 i32.add
                            local.set $base0
                            ;; d = CLUT[base1++]
                            local.get $lutPtr
                            local.get $base1 i32.const 1 i32.shl i32.add
                            i32.load16_u
                            local.set $d
                            local.get $base1 i32.const 1 i32.add
                            local.set $base1

                            ;; sum = (d - a)*rx + (a - b)*ry + (b - c)*rz
                            local.get $d local.get $a i32.sub local.get $rx i32.mul
                            local.get $a local.get $b i32.sub local.get $ry i32.mul
                            i32.add
                            local.get $b local.get $c i32.sub local.get $rz i32.mul
                            i32.add
                            local.set $sum

                            local.get $c
                            local.get $sum i32.const 0x80 i32.add i32.const 8 i32.shr_s
                            i32.add
                            local.set $u16
                            local.get $u16 i32.const 0x80 i32.add i32.const 8 i32.shr_s
                            local.set $u8
                            local.get $u8 i32.const 0
                                local.get $u8 i32.const 0 i32.ge_s
                                select
                                local.set $u8
                            local.get $u8 i32.const 255
                                local.get $u8 i32.const 256 i32.lt_s
                                select
                                local.set $u8

                            local.get $outputPos local.get $u8 i32.store8
                            local.get $outputPos i32.const 1 i32.add
                            local.set $outputPos

                            local.get $o i32.const 1 i32.add
                            local.tee $o
                            local.get $cMax i32.lt_s
                            br_if $ch_loop_c6))
                (else
                    ;; ---- Fallback (degenerate: should never fire with
                    ;;      i32.ge_s reflexive comparisons above, matches
                    ;;      the JS fallback at Transform.js:9134) -------
                    ;; Write cMax bytes of (c + 0x80) >> 8, clamped.
                    i32.const 0
                    local.set $o
                    (loop $ch_loop_cfb
                        local.get $lutPtr
                        local.get $base0 i32.const 1 i32.shl i32.add
                        i32.load16_u
                        local.set $c
                        local.get $base0 i32.const 1 i32.add
                        local.set $base0

                        local.get $c i32.const 0x80 i32.add i32.const 8 i32.shr_s
                        local.set $u8
                        local.get $u8 i32.const 0
                            local.get $u8 i32.const 0 i32.ge_s
                            select
                            local.set $u8
                        local.get $u8 i32.const 255
                            local.get $u8 i32.const 256 i32.lt_s
                            select
                            local.set $u8

                        local.get $outputPos local.get $u8 i32.store8
                        local.get $outputPos i32.const 1 i32.add
                        local.set $outputPos

                        local.get $o i32.const 1 i32.add
                        local.tee $o
                        local.get $cMax i32.lt_s
                        br_if $ch_loop_cfb))
                )))))))))))

                ;; -- Alpha tail ------------------------------------------
                ;; Mirrors the JS alpha block:
                ;;   if (preserveAlpha)  { output[o++] = input[i++]; }
                ;;   else                { i += inAlphaSkip;
                ;;                         if (outAlpha==1) { output[o++] = 255; } }
                (if (i32.eq (local.get $outAlphaMode) (i32.const 2))
                    (then
                        ;; PRESERVE-COPY: memory[outputPos] = memory[inputPos];
                        ;; outputPos++; inputPos++;
                        local.get $outputPos
                        local.get $inputPos
                        i32.load8_u
                        i32.store8
                        local.get $outputPos i32.const 1 i32.add local.set $outputPos
                        local.get $inputPos  i32.const 1 i32.add local.set $inputPos)
                    (else
                        (if (i32.eq (local.get $outAlphaMode) (i32.const 1))
                            (then
                                ;; FILL_255: memory[outputPos] = 255; outputPos++;
                                local.get $outputPos
                                i32.const 255
                                i32.store8
                                local.get $outputPos i32.const 1 i32.add local.set $outputPos))
                        ;; inputPos += inAlphaSkip
                        local.get $inputPos
                        local.get $inAlphaSkip
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
