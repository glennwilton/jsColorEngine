;; ============================================================================
;; tetra4d_nch.wat — 4D tetrahedral interpolation, n-channel output, int math
;; ============================================================================
;;
;; Hand-written WASM port of the hot path from src/Transform.js
;; (tetrahedralInterp4DArray_3Ch_intLut_loop and its 4Ch sibling), generalised
;; to n-channel output via a rolled channel loop (same "NCh" shape as the
;; tetra3d_nch.wat kernel — one `.wasm` handles cMax ∈ {3, 4, 5+}).
;;
;; Ported semantics:
;;   - Outer shape   : 4D tetra = 3D tetra at K0 plane, optionally 3D tetra at
;;                     K1 plane, then K-LERP. When rk=0 or inputK===255,
;;                     only the K0 pass runs (early-out, matches JS).
;;   - Integer math  : u16 CLUT, Q0.16 gps (gridPointsScale_fixed),
;;                     u20 (Q16.4) intermediate, single-rounding K-LERP:
;;                       u20 = (c << 4) + ((sum + 0x08) >> 4)        [inner, per pass]
;;                       interpK=false: u8 = (u20 + 0x800) >> 12     [clamp]
;;                       interpK=true : u8 = ((u20_K0 << 8)
;;                                           + imul(u20_K1 - u20_K0, rk)
;;                                           + 0x80000) >> 20        [clamp]
;;                     All `Math.imul`-style i32 products, bit-exact with the
;;                     JS `_intLut_loop` kernels (see Transform.js:10224
;;                     "U20 SINGLE-ROUNDING DESIGN" for the overflow analysis).
;;
;; Key architectural move vs. "run two 3D kernels back to back":
;;
;;   The 6-case tetra dispatch, the boundary patch, and the entire interp
;;   body are K-independent (depend only on C,M,Y and rx/ry/rz). They're
;;   emitted ONCE and re-executed for pass 2 via a flag-gated WASM `loop`.
;;   Between passes we just bump $K0 by $go3 — the case branch's base
;;   computation picks that up naturally on re-entry. No separate K1-plane
;;   branch of the tetra dispatch.
;;
;;   Compared to a literal "call the 3D kernel twice" decomposition, this
;;   avoids doubling the C,M,Y setup and ~halves the .wasm bytes for the
;;   inner body. The cost is one `br_if` per pixel plus re-running the
;;   6-case dispatch's compares on pass 2 — both negligible against the
;;   per-pixel budget.
;;
;; Memory layout (caller-provided, all offsets are byte offsets into linear
;; memory):
;;
;;   [ inputPtr   .. inputPtr   + pixelCount*4 )    u8 KCMY input (K first!)
;;   [ outputPtr  .. outputPtr  + pixelCount*cMax ) u8 n-channel output
;;   [ lutPtr     .. lutPtr     + lutLen*2 )        u16 CLUT
;;   [ scratchPtr .. scratchPtr + cMax*4 )          u20 scratch (per-pixel,
;;                                                   holds K0-plane u20 values
;;                                                   across the K-plane loop;
;;                                                   64 bytes covers cMax≤16)
;;
;; Stride conventions (u16-element units, NOT bytes — matches intLut.goN):
;;
;;   go0 = outputChannels              (next Z slice)
;;   go1 = g1 * outputChannels         (next Y row)
;;   go2 = g1 * g1 * outputChannels    (next X plane)
;;   go3 = g1 * g1 * g1 * outputChannels (next K plane — outermost axis)
;;
;; gps is gridPointsScale_fixed, Q0.16 — e.g. 4112 for g1=17.
;;
;; Input byte order: inputK, input0 (C), input1 (M), input2 (Y), [optional α].
;; Matches tetrahedralInterp4DArray_3Ch_intLut_loop exactly.
;;
;; Alpha handling: same two-flag convention as tetra3d_nch.wat.
;;
;;   $inAlphaSkip    0 or 1 — bytes to skip after each KCMY input quad
;;   $outAlphaMode   0 = no output alpha slot
;;                   1 = fill output alpha byte with 255
;;                   2 = copy input alpha byte through to output
;;
;; ============================================================================

(module
    (memory (export "memory") 1)

    ;; ------------------------------------------------------------------------
    ;; interp_tetra4d_nCh
    ;; ------------------------------------------------------------------------
    (func (export "interp_tetra4d_nCh")
        (param $inputPtr     i32)
        (param $outputPtr    i32)
        (param $lutPtr       i32)
        (param $pixelCount   i32)
        (param $cMax         i32)
        (param $go0          i32)
        (param $go1          i32)
        (param $go2          i32)
        (param $go3          i32)
        (param $gps          i32)
        (param $maxX         i32)
        (param $maxY         i32)
        (param $maxZ         i32)
        (param $maxK         i32)
        (param $scratchPtr   i32)   ;; byte offset, holds cMax u32 slots
        (param $inAlphaSkip  i32)   ;; 0 or 1
        (param $outAlphaMode i32)   ;; 0 = none, 1 = fill 255, 2 = preserve-copy

        ;; Per-pixel loop state
        (local $p           i32)
        (local $inputPos    i32)
        (local $outputPos   i32)

        ;; Decoded pixel
        (local $inputK      i32)
        (local $input0      i32)
        (local $input1      i32)
        (local $input2      i32)
        (local $pk          i32)
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
        (local $K0          i32)   ;; already scaled by go3 (K0 * go3)
        (local $rx          i32)
        (local $ry          i32)
        (local $rz          i32)
        (local $rk          i32)

        ;; Tetrahedron corner base indices (u16 element units), re-computed
        ;; from (X0,Y0,Z0,K0,case) at the top of each K-pass.
        (local $base0       i32)
        (local $base1       i32)
        (local $base2       i32)
        (local $base3       i32)
        (local $base4       i32)

        ;; K-plane loop state
        (local $kpass       i32)   ;; 0 = K0 pass, 1 = K1 pass
        (local $interpK     i32)   ;; 1 iff rk != 0 (and inputK != 255)
        (local $tailMode    i32)   ;; 0 = round to u8 directly (no interpK),
                                   ;; 1 = stash u20 to scratch (K0 pass, interpK),
                                   ;; 2 = K-LERP + store u8     (K1 pass)

        ;; Channel loop state
        (local $o           i32)
        (local $a           i32)
        (local $b           i32)
        (local $c           i32)
        (local $d           i32)
        (local $sum         i32)
        (local $u20         i32)   ;; Q16.4 intermediate
        (local $k0_u20      i32)   ;; K0-plane u20 loaded from scratch (K1 pass)
        (local $u8          i32)

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

                ;; -- Load 4 u8 input bytes: K, C, M, Y -------------------
                ;; NB: K is FIRST, matching tetrahedralInterp4DArray_*_intLut_loop.
                local.get $inputPos
                i32.load8_u
                local.set $inputK

                local.get $inputPos
                i32.const 1
                i32.add
                i32.load8_u
                local.set $input0

                local.get $inputPos
                i32.const 2
                i32.add
                i32.load8_u
                local.set $input1

                local.get $inputPos
                i32.const 3
                i32.add
                i32.load8_u
                local.set $input2

                local.get $inputPos
                i32.const 4
                i32.add
                local.set $inputPos

                ;; pk, px, py, pz = input * gps   (Q8.16 grid coordinates)
                local.get $inputK local.get $gps i32.mul local.set $pk
                local.get $input0 local.get $gps i32.mul local.set $px
                local.get $input1 local.get $gps i32.mul local.set $py
                local.get $input2 local.get $gps i32.mul local.set $pz

                ;; -- K-axis boundary patch -------------------------------
                ;; if (inputK === 255) { K0 = maxK; rk = 0; }
                ;; else               { K0 = (pk >>> 16) * go3;
                ;;                      rk = (pk >>> 8) & 0xFF; }
                (if (i32.eq (local.get $inputK) (i32.const 255))
                    (then
                        local.get $maxK
                        local.set $K0
                        i32.const 0
                        local.set $rk)
                    (else
                        local.get $pk
                        i32.const 16
                        i32.shr_u
                        local.get $go3
                        i32.mul
                        local.set $K0
                        local.get $pk
                        i32.const 8
                        i32.shr_u
                        i32.const 0xFF
                        i32.and
                        local.set $rk))

                ;; interpK = (rk != 0) ? 1 : 0
                ;; (Handles both inputK===255 → rk=0 and rk===0 degenerate.)
                local.get $rk
                i32.const 0
                i32.ne
                local.set $interpK

                ;; -- X-axis boundary patch -------------------------------
                (if (i32.eq (local.get $input0) (i32.const 255))
                    (then
                        local.get $maxX local.set $X0
                        local.get $maxX local.set $X1
                        i32.const 0     local.set $rx)
                    (else
                        local.get $px i32.const 16 i32.shr_u
                        local.get $go2 i32.mul
                        local.set $X0
                        local.get $X0 local.get $go2 i32.add
                        local.set $X1
                        local.get $px i32.const 8 i32.shr_u
                        i32.const 0xFF i32.and
                        local.set $rx))

                ;; -- Y-axis boundary patch -------------------------------
                (if (i32.eq (local.get $input1) (i32.const 255))
                    (then
                        local.get $maxY local.set $Y0
                        local.get $maxY local.set $Y1
                        i32.const 0     local.set $ry)
                    (else
                        local.get $py i32.const 16 i32.shr_u
                        local.get $go1 i32.mul
                        local.set $Y0
                        local.get $Y0 local.get $go1 i32.add
                        local.set $Y1
                        local.get $py i32.const 8 i32.shr_u
                        i32.const 0xFF i32.and
                        local.set $ry))

                ;; -- Z-axis boundary patch -------------------------------
                (if (i32.eq (local.get $input2) (i32.const 255))
                    (then
                        local.get $maxZ local.set $Z0
                        local.get $maxZ local.set $Z1
                        i32.const 0     local.set $rz)
                    (else
                        local.get $pz i32.const 16 i32.shr_u
                        local.get $go0 i32.mul
                        local.set $Z0
                        local.get $Z0 local.get $go0 i32.add
                        local.set $Z1
                        local.get $pz i32.const 8 i32.shr_u
                        i32.const 0xFF i32.and
                        local.set $rz))

                ;; -- Initialise K-plane pass ------------------------------
                ;; tailMode: iter-1 starts as (interpK ? 1 : 0).
                ;;   interpK=0 → tailMode=0: round u20→u8, store to output.
                ;;   interpK=1 → tailMode=1: stash u20 to scratch for K-LERP.
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

                        ;; base0 = X0 + Y0 + Z0 + K0    (anchor, u16 elems)
                        local.get $X0
                        local.get $Y0
                        i32.add
                        local.get $Z0
                        i32.add
                        local.get $K0
                        i32.add
                        local.set $base0

                        ;; --- Tetrahedral case dispatch (6 cases) --------
                        ;; Same dispatch as the 3D kernel; base formulas
                        ;; mirror Transform.js:10302..10443. Each case sets
                        ;; base1/2/3/4 (+ K0 included via base0 convention)
                        ;; then runs the rolled channel loop with the 3-way
                        ;; tail dispatch on $tailMode.

                        ;; ------ CASE 1: rx >= ry >= rz -----------------
                        (if (i32.and
                                (i32.ge_s (local.get $rx) (local.get $ry))
                                (i32.ge_s (local.get $ry) (local.get $rz)))
                            (then
                                ;; base1 = X1+Y0+Z0+K0, base2 = X1+Y1+Z0+K0,
                                ;; base4 = X1+Y1+Z1+K0
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
                                    ;; d = CLUT[base4++]
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

                                    ;; u20 = (c << 4) + ((sum + 0x08) >> 4)
                                    local.get $c i32.const 4 i32.shl
                                    local.get $sum i32.const 0x08 i32.add
                                    i32.const 4 i32.shr_s
                                    i32.add
                                    local.set $u20

                                    ;; --- Inlined 3-way tail dispatch ----
                                    ;; $tailMode ∈ {0,1,2}:
                                    ;;   0 = !interpK: u8 = (u20 + 0x800) >> 12, clamp, store, outputPos++
                                    ;;   1 = K0 pass:  scratch[o*4] = u20, outputPos unchanged
                                    ;;   2 = K1 pass:  k0 = scratch[o*4]; K-LERP; store u8, outputPos++
                                    (if (i32.eq (local.get $tailMode) (i32.const 1))
                                        (then
                                            local.get $scratchPtr
                                            local.get $o i32.const 2 i32.shl
                                            i32.add
                                            local.get $u20
                                            i32.store)
                                        (else
                                            (if (i32.eq (local.get $tailMode) (i32.const 2))
                                                (then
                                                    local.get $scratchPtr
                                                    local.get $o i32.const 2 i32.shl
                                                    i32.add
                                                    i32.load
                                                    local.set $k0_u20
                                                    local.get $k0_u20 i32.const 8 i32.shl
                                                    local.get $u20 local.get $k0_u20 i32.sub
                                                    local.get $rk i32.mul
                                                    i32.add
                                                    i32.const 0x80000 i32.add
                                                    i32.const 20 i32.shr_s
                                                    local.set $u8)
                                                (else
                                                    local.get $u20 i32.const 0x800 i32.add
                                                    i32.const 12 i32.shr_s
                                                    local.set $u8))
                                            local.get $u8 i32.const 0
                                                local.get $u8 i32.const 0 i32.ge_s select
                                                local.set $u8
                                            local.get $u8 i32.const 255
                                                local.get $u8 i32.const 256 i32.lt_s select
                                                local.set $u8
                                            local.get $outputPos local.get $u8 i32.store8
                                            local.get $outputPos i32.const 1 i32.add
                                            local.set $outputPos))

                                    ;; ++o; if (o < cMax) continue
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
                                ;; base1 = X1+Y0+Z0+K0, base2 = X1+Y1+Z1+K0,
                                ;; base3 = X1+Y0+Z1+K0
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
                                    ;; d = CLUT[base2++]
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

                                    local.get $c i32.const 4 i32.shl
                                    local.get $sum i32.const 0x08 i32.add
                                    i32.const 4 i32.shr_s
                                    i32.add
                                    local.set $u20

                                    ;; --- Inlined 3-way tail dispatch ----
                                    ;; $tailMode ∈ {0,1,2}:
                                    ;;   0 = !interpK: u8 = (u20 + 0x800) >> 12, clamp, store, outputPos++
                                    ;;   1 = K0 pass:  scratch[o*4] = u20, outputPos unchanged
                                    ;;   2 = K1 pass:  k0 = scratch[o*4]; K-LERP; store u8, outputPos++
                                    (if (i32.eq (local.get $tailMode) (i32.const 1))
                                        (then
                                            local.get $scratchPtr
                                            local.get $o i32.const 2 i32.shl
                                            i32.add
                                            local.get $u20
                                            i32.store)
                                        (else
                                            (if (i32.eq (local.get $tailMode) (i32.const 2))
                                                (then
                                                    local.get $scratchPtr
                                                    local.get $o i32.const 2 i32.shl
                                                    i32.add
                                                    i32.load
                                                    local.set $k0_u20
                                                    local.get $k0_u20 i32.const 8 i32.shl
                                                    local.get $u20 local.get $k0_u20 i32.sub
                                                    local.get $rk i32.mul
                                                    i32.add
                                                    i32.const 0x80000 i32.add
                                                    i32.const 20 i32.shr_s
                                                    local.set $u8)
                                                (else
                                                    local.get $u20 i32.const 0x800 i32.add
                                                    i32.const 12 i32.shr_s
                                                    local.set $u8))
                                            local.get $u8 i32.const 0
                                                local.get $u8 i32.const 0 i32.ge_s select
                                                local.set $u8
                                            local.get $u8 i32.const 255
                                                local.get $u8 i32.const 256 i32.lt_s select
                                                local.set $u8
                                            local.get $outputPos local.get $u8 i32.store8
                                            local.get $outputPos i32.const 1 i32.add
                                            local.set $outputPos))

                                    local.get $o i32.const 1 i32.add
                                    local.tee $o
                                    local.get $cMax i32.lt_s
                                    br_if $ch_loop_c2))
                        (else

                        ;; ------ CASE 3: rz >= rx >= ry (JS: rx>=ry && rz>=rx)
                        (if (i32.and
                                (i32.ge_s (local.get $rx) (local.get $ry))
                                (i32.ge_s (local.get $rz) (local.get $rx)))
                            (then
                                ;; base1 = X1+Y0+Z1+K0, base2 = X0+Y0+Z1+K0,
                                ;; base3 = X1+Y1+Z1+K0
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

                                    ;; sum = (a-b)*rx + (d-a)*ry + (b-c)*rz
                                    local.get $a local.get $b i32.sub local.get $rx i32.mul
                                    local.get $d local.get $a i32.sub local.get $ry i32.mul
                                    i32.add
                                    local.get $b local.get $c i32.sub local.get $rz i32.mul
                                    i32.add
                                    local.set $sum

                                    local.get $c i32.const 4 i32.shl
                                    local.get $sum i32.const 0x08 i32.add
                                    i32.const 4 i32.shr_s
                                    i32.add
                                    local.set $u20

                                    ;; --- Inlined 3-way tail dispatch ----
                                    ;; $tailMode ∈ {0,1,2}:
                                    ;;   0 = !interpK: u8 = (u20 + 0x800) >> 12, clamp, store, outputPos++
                                    ;;   1 = K0 pass:  scratch[o*4] = u20, outputPos unchanged
                                    ;;   2 = K1 pass:  k0 = scratch[o*4]; K-LERP; store u8, outputPos++
                                    (if (i32.eq (local.get $tailMode) (i32.const 1))
                                        (then
                                            local.get $scratchPtr
                                            local.get $o i32.const 2 i32.shl
                                            i32.add
                                            local.get $u20
                                            i32.store)
                                        (else
                                            (if (i32.eq (local.get $tailMode) (i32.const 2))
                                                (then
                                                    local.get $scratchPtr
                                                    local.get $o i32.const 2 i32.shl
                                                    i32.add
                                                    i32.load
                                                    local.set $k0_u20
                                                    local.get $k0_u20 i32.const 8 i32.shl
                                                    local.get $u20 local.get $k0_u20 i32.sub
                                                    local.get $rk i32.mul
                                                    i32.add
                                                    i32.const 0x80000 i32.add
                                                    i32.const 20 i32.shr_s
                                                    local.set $u8)
                                                (else
                                                    local.get $u20 i32.const 0x800 i32.add
                                                    i32.const 12 i32.shr_s
                                                    local.set $u8))
                                            local.get $u8 i32.const 0
                                                local.get $u8 i32.const 0 i32.ge_s select
                                                local.set $u8
                                            local.get $u8 i32.const 255
                                                local.get $u8 i32.const 256 i32.lt_s select
                                                local.set $u8
                                            local.get $outputPos local.get $u8 i32.store8
                                            local.get $outputPos i32.const 1 i32.add
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
                                ;; base1 = X1+Y1+Z0+K0, base2 = X0+Y1+Z0+K0,
                                ;; base4 = X1+Y1+Z1+K0
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

                                    ;; sum = (b-a)*rx + (a-c)*ry + (d-b)*rz
                                    local.get $b local.get $a i32.sub local.get $rx i32.mul
                                    local.get $a local.get $c i32.sub local.get $ry i32.mul
                                    i32.add
                                    local.get $d local.get $b i32.sub local.get $rz i32.mul
                                    i32.add
                                    local.set $sum

                                    local.get $c i32.const 4 i32.shl
                                    local.get $sum i32.const 0x08 i32.add
                                    i32.const 4 i32.shr_s
                                    i32.add
                                    local.set $u20

                                    ;; --- Inlined 3-way tail dispatch ----
                                    ;; $tailMode ∈ {0,1,2}:
                                    ;;   0 = !interpK: u8 = (u20 + 0x800) >> 12, clamp, store, outputPos++
                                    ;;   1 = K0 pass:  scratch[o*4] = u20, outputPos unchanged
                                    ;;   2 = K1 pass:  k0 = scratch[o*4]; K-LERP; store u8, outputPos++
                                    (if (i32.eq (local.get $tailMode) (i32.const 1))
                                        (then
                                            local.get $scratchPtr
                                            local.get $o i32.const 2 i32.shl
                                            i32.add
                                            local.get $u20
                                            i32.store)
                                        (else
                                            (if (i32.eq (local.get $tailMode) (i32.const 2))
                                                (then
                                                    local.get $scratchPtr
                                                    local.get $o i32.const 2 i32.shl
                                                    i32.add
                                                    i32.load
                                                    local.set $k0_u20
                                                    local.get $k0_u20 i32.const 8 i32.shl
                                                    local.get $u20 local.get $k0_u20 i32.sub
                                                    local.get $rk i32.mul
                                                    i32.add
                                                    i32.const 0x80000 i32.add
                                                    i32.const 20 i32.shr_s
                                                    local.set $u8)
                                                (else
                                                    local.get $u20 i32.const 0x800 i32.add
                                                    i32.const 12 i32.shr_s
                                                    local.set $u8))
                                            local.get $u8 i32.const 0
                                                local.get $u8 i32.const 0 i32.ge_s select
                                                local.set $u8
                                            local.get $u8 i32.const 255
                                                local.get $u8 i32.const 256 i32.lt_s select
                                                local.set $u8
                                            local.get $outputPos local.get $u8 i32.store8
                                            local.get $outputPos i32.const 1 i32.add
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
                                ;; base1 = X1+Y1+Z1+K0, base2 = X0+Y1+Z1+K0,
                                ;; base3 = X0+Y1+Z0+K0
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

                                    ;; sum = (d-a)*rx + (b-c)*ry + (a-b)*rz
                                    local.get $d local.get $a i32.sub local.get $rx i32.mul
                                    local.get $b local.get $c i32.sub local.get $ry i32.mul
                                    i32.add
                                    local.get $a local.get $b i32.sub local.get $rz i32.mul
                                    i32.add
                                    local.set $sum

                                    local.get $c i32.const 4 i32.shl
                                    local.get $sum i32.const 0x08 i32.add
                                    i32.const 4 i32.shr_s
                                    i32.add
                                    local.set $u20

                                    ;; --- Inlined 3-way tail dispatch ----
                                    ;; $tailMode ∈ {0,1,2}:
                                    ;;   0 = !interpK: u8 = (u20 + 0x800) >> 12, clamp, store, outputPos++
                                    ;;   1 = K0 pass:  scratch[o*4] = u20, outputPos unchanged
                                    ;;   2 = K1 pass:  k0 = scratch[o*4]; K-LERP; store u8, outputPos++
                                    (if (i32.eq (local.get $tailMode) (i32.const 1))
                                        (then
                                            local.get $scratchPtr
                                            local.get $o i32.const 2 i32.shl
                                            i32.add
                                            local.get $u20
                                            i32.store)
                                        (else
                                            (if (i32.eq (local.get $tailMode) (i32.const 2))
                                                (then
                                                    local.get $scratchPtr
                                                    local.get $o i32.const 2 i32.shl
                                                    i32.add
                                                    i32.load
                                                    local.set $k0_u20
                                                    local.get $k0_u20 i32.const 8 i32.shl
                                                    local.get $u20 local.get $k0_u20 i32.sub
                                                    local.get $rk i32.mul
                                                    i32.add
                                                    i32.const 0x80000 i32.add
                                                    i32.const 20 i32.shr_s
                                                    local.set $u8)
                                                (else
                                                    local.get $u20 i32.const 0x800 i32.add
                                                    i32.const 12 i32.shr_s
                                                    local.set $u8))
                                            local.get $u8 i32.const 0
                                                local.get $u8 i32.const 0 i32.ge_s select
                                                local.set $u8
                                            local.get $u8 i32.const 255
                                                local.get $u8 i32.const 256 i32.lt_s select
                                                local.set $u8
                                            local.get $outputPos local.get $u8 i32.store8
                                            local.get $outputPos i32.const 1 i32.add
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
                                ;; base1 = X1+Y1+Z1+K0, base2 = X0+Y1+Z1+K0,
                                ;; base4 = X0+Y0+Z1+K0
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

                                    ;; sum = (d-a)*rx + (a-b)*ry + (b-c)*rz
                                    local.get $d local.get $a i32.sub local.get $rx i32.mul
                                    local.get $a local.get $b i32.sub local.get $ry i32.mul
                                    i32.add
                                    local.get $b local.get $c i32.sub local.get $rz i32.mul
                                    i32.add
                                    local.set $sum

                                    local.get $c i32.const 4 i32.shl
                                    local.get $sum i32.const 0x08 i32.add
                                    i32.const 4 i32.shr_s
                                    i32.add
                                    local.set $u20

                                    ;; --- Inlined 3-way tail dispatch ----
                                    ;; $tailMode ∈ {0,1,2}:
                                    ;;   0 = !interpK: u8 = (u20 + 0x800) >> 12, clamp, store, outputPos++
                                    ;;   1 = K0 pass:  scratch[o*4] = u20, outputPos unchanged
                                    ;;   2 = K1 pass:  k0 = scratch[o*4]; K-LERP; store u8, outputPos++
                                    (if (i32.eq (local.get $tailMode) (i32.const 1))
                                        (then
                                            local.get $scratchPtr
                                            local.get $o i32.const 2 i32.shl
                                            i32.add
                                            local.get $u20
                                            i32.store)
                                        (else
                                            (if (i32.eq (local.get $tailMode) (i32.const 2))
                                                (then
                                                    local.get $scratchPtr
                                                    local.get $o i32.const 2 i32.shl
                                                    i32.add
                                                    i32.load
                                                    local.set $k0_u20
                                                    local.get $k0_u20 i32.const 8 i32.shl
                                                    local.get $u20 local.get $k0_u20 i32.sub
                                                    local.get $rk i32.mul
                                                    i32.add
                                                    i32.const 0x80000 i32.add
                                                    i32.const 20 i32.shr_s
                                                    local.set $u8)
                                                (else
                                                    local.get $u20 i32.const 0x800 i32.add
                                                    i32.const 12 i32.shr_s
                                                    local.set $u8))
                                            local.get $u8 i32.const 0
                                                local.get $u8 i32.const 0 i32.ge_s select
                                                local.set $u8
                                            local.get $u8 i32.const 255
                                                local.get $u8 i32.const 256 i32.lt_s select
                                                local.set $u8
                                            local.get $outputPos local.get $u8 i32.store8
                                            local.get $outputPos i32.const 1 i32.add
                                            local.set $outputPos))

                                    local.get $o i32.const 1 i32.add
                                    local.tee $o
                                    local.get $cMax i32.lt_s
                                    br_if $ch_loop_c6))
                        (else
                            ;; ---- Degenerate fallback (rx==ry==rz): pure
                            ;; K-axis LERP, no 3D interp. Mirrors JS at
                            ;; Transform.js:10428..10443.
                            ;;
                            ;; For consistency with the K-loop architecture:
                            ;; we *could* just write the final output here
                            ;; directly, but for simplicity we emit u20 via
                            ;; the same (c << 4) path so the tail dispatch
                            ;; handles it uniformly.
                            i32.const 0
                            local.set $o
                            (loop $ch_loop_cfb
                                ;; c = CLUT[base0++]
                                local.get $lutPtr
                                local.get $base0 i32.const 1 i32.shl i32.add
                                i32.load16_u
                                local.set $c
                                local.get $base0 i32.const 1 i32.add
                                local.set $base0

                                ;; u20 = c << 4  (sum = 0 in the degenerate)
                                local.get $c i32.const 4 i32.shl
                                local.set $u20

                                ;; --- Inlined 3-way tail dispatch ----
                                (if (i32.eq (local.get $tailMode) (i32.const 1))
                                    (then
                                        local.get $scratchPtr
                                        local.get $o i32.const 2 i32.shl
                                        i32.add
                                        local.get $u20
                                        i32.store)
                                    (else
                                        (if (i32.eq (local.get $tailMode) (i32.const 2))
                                            (then
                                                local.get $scratchPtr
                                                local.get $o i32.const 2 i32.shl
                                                i32.add
                                                i32.load
                                                local.set $k0_u20
                                                local.get $k0_u20 i32.const 8 i32.shl
                                                local.get $u20 local.get $k0_u20 i32.sub
                                                local.get $rk i32.mul
                                                i32.add
                                                i32.const 0x80000 i32.add
                                                i32.const 20 i32.shr_s
                                                local.set $u8)
                                            (else
                                                local.get $u20 i32.const 0x800 i32.add
                                                i32.const 12 i32.shr_s
                                                local.set $u8))
                                        local.get $u8 i32.const 0
                                            local.get $u8 i32.const 0 i32.ge_s select
                                            local.set $u8
                                        local.get $u8 i32.const 255
                                            local.get $u8 i32.const 256 i32.lt_s select
                                            local.set $u8
                                        local.get $outputPos local.get $u8 i32.store8
                                        local.get $outputPos i32.const 1 i32.add
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
                        ;; K0. The $outputPos was NOT advanced during iter 1
                        ;; (tail mode 1 stashes to scratch) — iter 2 writes
                        ;; the final u8 output.
                        (if (i32.and
                                (i32.eqz (local.get $kpass))
                                (local.get $interpK))
                            (then
                                local.get $K0 local.get $go3 i32.add
                                local.set $K0
                                i32.const 1 local.set $kpass
                                i32.const 2 local.set $tailMode
                                br $k_loop))

                        ;; Fall through to $k_exit.
                        br $k_exit))

                ;; -- Alpha tail (mirrors tetra3d_nch.wat exactly) ---------
                (if (i32.eq (local.get $outAlphaMode) (i32.const 2))
                    (then
                        local.get $outputPos
                        local.get $inputPos
                        i32.load8_u
                        i32.store8
                        local.get $outputPos i32.const 1 i32.add local.set $outputPos
                        local.get $inputPos  i32.const 1 i32.add local.set $inputPos)
                    (else
                        (if (i32.eq (local.get $outAlphaMode) (i32.const 1))
                            (then
                                local.get $outputPos
                                i32.const 255
                                i32.store8
                                local.get $outputPos i32.const 1 i32.add local.set $outputPos))
                        local.get $inputPos
                        local.get $inAlphaSkip
                        i32.add
                        local.set $inputPos))

                ;; -- End-of-pixel housekeeping ---------------------------
                local.get $p
                i32.const 1
                i32.add
                local.set $p
                br $pixel_loop))
    )
)
