/*************************************************************************
 *  @license
 *
 *  Copyright © 2019, 2026 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 */

/**
 * build_matrix_shaper_wasm.js — emit the matrix-shaper kernel .wat and .wasm.js
 *
 *   node scripts/build_matrix_shaper_wasm.js
 *
 * FOUR BINARIES, from one generator: {int8, int16} x {simd, scalar}.
 *
 *   matrix_shaper_int8_simd     the fast path almost everyone gets
 *   matrix_shaper_int8_scalar   same arithmetic, one pixel at a time
 *   matrix_shaper_int16_simd
 *   matrix_shaper_int16_scalar
 *
 * THE SCALAR VARIANTS ARE f32, NOT FIXED POINT. They exist for hosts without
 * WebAssembly SIMD, and the one thing that matters about a fallback is that it
 * gives the SAME ANSWER as the path it replaces — otherwise output depends on
 * the browser. Every lane of the SIMD kernel already performs IEEE-754 f32
 * multiply and add in a fixed order; doing those same operations in the same
 * order with `f32.mul` / `f32.add` is bit-identical, and the tests assert exact
 * equality rather than a tolerance. A 32-bit fixed-point variant would have
 * been a second, differently-rounded implementation to validate — a second
 * accuracy story for no speed, since f32 arithmetic is native on every target
 * that runs WASM at all.
 *
 * Structure is the POC's V4/V5 SIMD kernel (bench/matrix_shaper_poc/), with two
 * deliberate changes:
 *
 * 1. THE OUTPUT GAMMA TABLE IS 16-BIT, not 4096-entry. Measured against the
 *    engine's exact pipeline over 262,144 colours per profile pair, 4096
 *    entries gives up to 4 LSB — the POC document's "±0.4 LSB" claim is wrong.
 *    65536 entries gives <= 1 LSB everywhere, and costs nothing: 237.8 MPx/s
 *    against 239.4 for the small table, which is inside noise. A 1-D table
 *    indexed by a scalar has locality a 3-D CLUT does not.
 *
 * 2. THE MATRIX LIVES IN LINEAR MEMORY, not in the code. The POC baked nine
 *    f32 constants into the module and the design notes proposed patching them
 *    in the binary by scanning for sentinel values. Loading them from memory
 *    into the same v128 locals at function entry keeps V4's "constants hoisted
 *    into locals" benefit — they are still locals for the whole loop — while
 *    making ONE prebuilt binary serve every profile pair. No patching, no
 *    sentinel scan that can silently go stale, no per-pair compile, and the
 *    module caches globally instead of per matrix.
 *
 * INT16 IS NOT INT8 WITH BIGGER TABLES. Two things change, both forced by
 * measurement rather than taste:
 *
 *   Input.  One f32 entry per possible input code, so 65536 entries / 256 KB.
 *           Still exact — no interpolation on the way in.
 *
 *   Output. A table indexed LINEARLY by the linear-light value falls apart near
 *           black at 16 bits. For a pure power TRC the encode curve has
 *           unbounded slope at zero, so with 65536 uniform steps the first
 *           interval alone carries ~260 LSB of error. That error is present at
 *           8 bits too — it just hides under 1/257th of a code, which is why
 *           the int8 table gets away with a linear index.
 *
 *           The fix is to index by v^(1/4) rather than by v. Substituting
 *           v = t^4 turns v^(1/g) into t^(4/g), and 4/g > 1 for every TRC in
 *           practice, so the curve has bounded slope and no singularity at the
 *           origin: the worst case moves from black to white, where the error
 *           is (4/g)/4 LSB. With 2^17 entries that is 0.42 LSB for gamma 2.4,
 *           0.56 for gamma 1.8, and 1.0 for a linear TRC.
 *
 *           The fourth root is two `f32.sqrt` instructions, which is why this
 *           shape and not interpolation. AN INTERPOLATED TABLE WAS BUILT AND
 *           MEASURED FIRST: 65537 f32 entries indexed by sqrt(v), accurate to
 *           0.1 LSB and 40 MPx/s — five times SLOWER than the int16 CLUT it is
 *           supposed to replace, and slower in SIMD than in scalar, because
 *           twelve extract_lane -> load -> lerp chains per iteration are all
 *           latency. Solid-colour input ran at 49 MPx/s against 41 for noise,
 *           so it was never the cache; it was the ops. One rounded lookup is
 *           the whole point of a table.
 *
 * MEMORY LAYOUT (int8)
 *   0      .. 1023    input gamma, 256 x f32   (one per possible input byte,
 *                                               therefore exact - no interpolation)
 *   1024   .. 66559   output gamma, 65536 x u8
 *   66560  .. 66595   matrix, 9 x f32, row major
 *   66624  ..         pixel data (caller sets the pointers; grown at runtime)
 *
 * MEMORY LAYOUT (int16)
 *   0      .. 262143  input gamma, 65536 x f32 (one per possible input code)
 *   262144 .. 524287  output gamma, 131072 x u16, indexed by (linear^0.25)*131071
 *   524288 .. 524323  matrix, 9 x f32, row major
 *   524352 ..         pixel data
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'src', 'kernels', 'matrixShaper');

/** Round `n` up to the next multiple of `a`. */
const align = (n, a) => (n + a - 1) & ~(a - 1);

/**
 * Everything that differs between the int8 and int16 kernels.
 * Derived rather than written out, so the two layouts cannot drift apart.
 */
function layoutFor(bits) {
    const inEntries   = bits === 8 ? 256 : 65536;
    // Top index of the output table. int8 has 256 possible answers and 65536
    // slots to find them in, so it is oversampled 256x; int16 has 65536 answers
    // and needs the extra bit of index to stay inside 1 LSB.
    const outIndexMax = bits === 8 ? 65535 : 131071;
    const outEntry    = bits === 8 ? 1 : 2;
    // Index is v^(1/indexRoot). See the header: a linear index cannot resolve
    // the dark end of a power TRC at 16 bits, and each root is one f32.sqrt.
    const indexRoot   = bits === 8 ? 1 : 4;

    const gammaIn  = 0;
    const gammaOut = align(gammaIn + inEntries * 4, 64);
    const matrix   = align(gammaOut + (outIndexMax + 1) * outEntry, 64);
    const pixel    = align(matrix + 36, 64);
    return {
        bits:            bits,
        gammaInByte:     gammaIn,
        gammaOutByte:    gammaOut,
        matrixByte:      matrix,
        pixelByte:       pixel,
        inEntries:       inEntries,
        outIndexMax:     outIndexMax,
        outValueMax:     bits === 8 ? 255 : 65535,
        outEntryBytes:   outEntry,
        indexRoot:       indexRoot,
        bytesPerChannel: bits === 8 ? 1 : 2,
        initialPages:    Math.ceil(pixel / 65536)
    };
}

// ---------------------------------------------------------------------------
// WAT fragments
// ---------------------------------------------------------------------------

/**
 * Load one channel and turn it into linear light: read the input code, use it
 * directly as a table index, load the f32.
 *
 * The code IS the index — (code << 2) is the address, because the table starts
 * at 0 and each entry is 4 bytes. That is the POC's V3 trick, worth +23% over
 * shuffling bytes into lanes.
 */
function loadLinear(L, channelIndex) {
    const off  = channelIndex * L.bytesPerChannel;
    const at   = off ? ' offset=' + off : '';
    const load = L.bits === 8
        ? '(i32.load8_u' + at + ' (local.get $inPos))'
        : '(i32.load16_u' + at + ' (local.get $inPos))';
    return '(f32.load (i32.shl ' + load + ' (i32.const 2)))';
}

/**
 * Output encode: clamp to [0,1], take the index root, scale to the table index,
 * round, look the answer up, store it.
 *
 * ONE LOOKUP, NO INTERPOLATION, at both bit depths. Interpolating would need a
 * second load, a subtract, a multiply and an add per channel — measured at 40
 * MPx/s against 190 for this, which is worse than the CLUT it is meant to beat.
 * The accuracy interpolation was there to buy comes instead from indexing the
 * table by v^(1/4) and giving it 2^17 entries: see the header.
 */
function encode(L, valueExpr, channelIndex) {
    const off  = channelIndex > 0 ? ' offset=' + (channelIndex * L.bytesPerChannel) : '';
    const clamped = '(f32.min (f32.max ' + valueExpr + ' (f32.const 0.0)) (f32.const 1.0))';
    // indexRoot 1 -> no sqrt, 2 -> one, 4 -> two.
    let rooted = clamped;
    for (let r = L.indexRoot; r > 1; r >>= 1) rooted = '(f32.sqrt ' + rooted + ')';

    const load  = L.outEntryBytes === 1
        ? '(i32.load8_u (i32.add (i32.const ' + L.gammaOutByte + ') (local.get $ti)))'
        : '(i32.load16_u (i32.add (i32.const ' + L.gammaOutByte + ') (i32.shl (local.get $ti) (i32.const 1))))';
    const store = L.bytesPerChannel === 1 ? 'i32.store8' : 'i32.store16';

    // Clamped to [0,1] before scaling, so the index cannot exceed outIndexMax
    // and needs no second clamp. trunc_sat rather than trunc, matching the SIMD
    // lane exactly: a NaN lands on index 0 instead of trapping.
    return '\n' +
'        (local.set $ti (i32.trunc_sat_f32_u (f32.add (f32.mul ' + rooted + ' (f32.const ' + L.outIndexMax + '.0)) (f32.const 0.5))))\n' +
'        (' + store + off + ' (local.get $outPos) ' + load + ')';
}

/** Load matrix coefficient `i` (row major) from linear memory. */
const mAt = (L, i) => '(f32.load offset=' + (L.matrixByte + i * 4) + ' (i32.const 0))';

/**
 * Turn a vector of linear-light values into a vector of TABLE INDICES, whole.
 *
 * EVERYTHING THAT CAN BE DONE FOUR AT A TIME IS DONE HERE, before any lane is
 * extracted, and that is most of the encode: clamp, both roots, the scale and
 * the rounding. Only the gather and the store are inherently per-lane, since
 * WASM SIMD has no gather.
 *
 * Doing the roots after extraction instead — the obvious way to write it — put
 * 24 scalar f32.sqrt on the critical path per iteration and measured 40 MPx/s
 * at int16, SLOWER than the scalar build. Hoisting them here took it to 131.
 */
function simdToIndex(L, v) {
    let rooted = '(f32x4.min (f32x4.max (local.get ' + v + ') (local.get $vZero)) (local.get $vOne))';
    for (let r = L.indexRoot; r > 1; r >>= 1) rooted = '(f32x4.sqrt ' + rooted + ')';
    // Clamped to [0,1] first, so the scaled value cannot exceed outIndexMax and
    // needs no second clamp. trunc_sat rather than trunc: NaN lands on 0
    // instead of trapping.
    return '\n        (local.set ' + v + ' (i32x4.trunc_sat_f32x4_u (f32x4.add (f32x4.mul ' +
        rooted + ' (local.get $vScale)) (local.get $vHalf))))';
}

/** The twelve gather-and-store pairs for one 4-pixel SIMD batch. */
function simdEncodes(L, V) {
    const load  = L.outEntryBytes === 1
        ? '(i32.load8_u (i32.add (i32.const ' + L.gammaOutByte + ') (local.get $ti)))'
        : '(i32.load16_u (i32.add (i32.const ' + L.gammaOutByte + ') (i32.shl (local.get $ti) (i32.const 1))))';
    const store = L.bytesPerChannel === 1 ? 'i32.store8' : 'i32.store16';

    const out = ['$vRo', '$vGo', '$vBo'].map(v => simdToIndex(L, v));
    for (let lane = 0; lane < 4; lane++) {
        ['$vRo', '$vGo', '$vBo'].forEach(function (v, c) {
            const i = lane * V.outCh + c;
            const off = i > 0 ? ' offset=' + (i * L.bytesPerChannel) : '';
            out.push('\n' +
'        (local.set $ti (i32x4.extract_lane ' + lane + ' (local.get ' + v + ')))\n' +
'        (' + store + off + ' (local.get $outPos) ' + load + ')');
        });
    }
    return out.join('');
}

/**
 * The alpha stores for one pixel, or '' when there is no alpha channel out.
 *
 * FOUR SHAPES, and they are not symmetric:
 *
 *   none  3 -> 3   the original kernel
 *   drop  4 -> 3   read past the source alpha, write none
 *   fill  * -> 4   write opaque, because the caller asked for a channel the
 *                  source either does not have or told us not to keep
 *   copy  4 -> 4   move the byte through untouched
 *
 * Alpha is NEVER colour-managed: it is opacity, not a colorant, and putting it
 * through a TRC and a matrix would be a bug that looks like a haze. So it is a
 * plain load/store outside the maths, which is also why it costs so little —
 * one instruction per pixel against ~15 for the colour.
 */
function alphaStore(L, V, pixel) {
    if (V.outCh !== 4) return '';
    const store = L.bytesPerChannel === 1 ? 'i32.store8' : 'i32.store16';
    const outOff = (pixel * V.outCh + 3) * L.bytesPerChannel;
    const at = outOff ? ' offset=' + outOff : '';
    if (V.alpha === 'copy') {
        const inOff = (pixel * V.inCh + 3) * L.bytesPerChannel;
        const load  = L.bytesPerChannel === 1
            ? '(i32.load8_u' + (inOff ? ' offset=' + inOff : '') + ' (local.get $inPos))'
            : '(i32.load16_u' + (inOff ? ' offset=' + inOff : '') + ' (local.get $inPos))';
        return '\n        (' + store + at + ' (local.get $outPos) ' + load + ')';
    }
    return '\n        (' + store + at + ' (local.get $outPos) (i32.const ' + L.outValueMax + '))';
}

/** The scalar per-pixel body: the SIMD tail, and the whole of the scalar build. */
function scalarBody(L, V) {
    const inStep  = V.inCh  * L.bytesPerChannel;
    const outStep = V.outCh * L.bytesPerChannel;
    return '\n' +
'        (local.set $tr ' + loadLinear(L, 0) + ')\n' +
'        (local.set $tg ' + loadLinear(L, 1) + ')\n' +
'        (local.set $tb ' + loadLinear(L, 2) + ')' +
alphaStore(L, V, 0) + '\n' +
'        (local.set $inPos (i32.add (local.get $inPos) (i32.const ' + inStep + ')))\n' +
'        (local.set $tro (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s00)) (f32.mul (local.get $tg) (local.get $s01))) (f32.mul (local.get $tb) (local.get $s02))))\n' +
'        (local.set $tgo (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s10)) (f32.mul (local.get $tg) (local.get $s11))) (f32.mul (local.get $tb) (local.get $s12))))\n' +
'        (local.set $tbo (f32.add (f32.add (f32.mul (local.get $tr) (local.get $s20)) (f32.mul (local.get $tg) (local.get $s21))) (f32.mul (local.get $tb) (local.get $s22))))' +
encode(L, '(local.get $tro)', 0) +
encode(L, '(local.get $tgo)', 1) +
encode(L, '(local.get $tbo)', 2) + '\n' +
'        (local.set $outPos (i32.add (local.get $outPos) (i32.const ' + outStep + ')))\n' +
'        (local.set $p (i32.add (local.get $p) (i32.const 1)))';
}

/** One 4-pixel SIMD iteration. */
function simdBody(L, V) {
    const inStep  = V.inCh  * L.bytesPerChannel;
    const outStep = V.outCh * L.bytesPerChannel;
    // Lane 0 splats, lanes 1..3 replace — the POC's shape, kept because it
    // avoids a shuffle network for what is really four scalar loads.
    const lanes = function (c) {
        const at = (pixel) => loadLinear(L, c + pixel * V.inCh);
        return '(f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1\n' +
'            (f32x4.splat ' + at(0) + ')\n' +
'            ' + at(1) + ')\n' +
'            ' + at(2) + ')\n' +
'            ' + at(3) + ')';
    };
    // The four alpha stores go here, BEFORE inPos advances, so a copy variant
    // can still read the source alpha. They are independent of the colour
    // work and the scheduler is free to hide them in its shadow.
    const alphas = [0, 1, 2, 3].map(px => alphaStore(L, V, px)).join('');
    return '\n' +
'        (local.set $vR ' + lanes(0) + ')\n' +
'        (local.set $vG ' + lanes(1) + ')\n' +
'        (local.set $vB ' + lanes(2) + ')' +
alphas + '\n' +
'        (local.set $inPos (i32.add (local.get $inPos) (i32.const ' + (inStep * 4) + ')))\n' +
'        (local.set $vRo (f32x4.add (f32x4.add (f32x4.mul (local.get $vR) (local.get $cm00)) (f32x4.mul (local.get $vG) (local.get $cm01))) (f32x4.mul (local.get $vB) (local.get $cm02))))\n' +
'        (local.set $vGo (f32x4.add (f32x4.add (f32x4.mul (local.get $vR) (local.get $cm10)) (f32x4.mul (local.get $vG) (local.get $cm11))) (f32x4.mul (local.get $vB) (local.get $cm12))))\n' +
'        (local.set $vBo (f32x4.add (f32x4.add (f32x4.mul (local.get $vR) (local.get $cm20)) (f32x4.mul (local.get $vG) (local.get $cm21))) (f32x4.mul (local.get $vB) (local.get $cm22))))' +
simdEncodes(L, V) + '\n' +
'        (local.set $outPos (i32.add (local.get $outPos) (i32.const ' + (outStep * 4) + ')))\n' +
'        (local.set $p      (i32.add (local.get $p)      (i32.const 4)))';
}

/**
 * The alpha shapes, as separate EXPORTS OF ONE MODULE rather than separate
 * binaries.
 *
 * Four shapes x two bit depths x SIMD/scalar would have been sixteen binaries
 * to ship, compile and keep in step. One module per {depth, SIMD} with five
 * entry points costs ~4 KB of extra code, compiles once, and shares the gamma
 * tables and the matrix — which are the expensive part and are identical
 * across shapes. Picking an export is free at call time.
 *
 * The strides are baked in per function, so the common 3->3 path keeps its
 * constant `offset=` operands and pays nothing for the others existing. A
 * runtime stride parameter would have put an add on every load in every
 * variant to serve one that does not need it.
 */
const SHAPES = [
    { name: 'run',        inCh: 3, outCh: 3, alpha: 'none' },
    { name: 'run_a_in',   inCh: 4, outCh: 3, alpha: 'none' },   // drop source alpha
    { name: 'run_a_out',  inCh: 3, outCh: 4, alpha: 'fill' },   // no source alpha; write opaque
    { name: 'run_a_copy', inCh: 4, outCh: 4, alpha: 'copy' },   // preserveAlpha: true
    { name: 'run_a_fill', inCh: 4, outCh: 4, alpha: 'fill' }    // preserveAlpha: false
];

function genWat(L, simd) {
    const simdLocals = simd ? '\n' +
'    (local $vR  v128) (local $vG  v128) (local $vB  v128)\n' +
'    (local $vRo v128) (local $vGo v128) (local $vBo v128)\n' +
'    (local $cm00 v128) (local $cm01 v128) (local $cm02 v128)\n' +
'    (local $cm10 v128) (local $cm11 v128) (local $cm12 v128)\n' +
'    (local $cm20 v128) (local $cm21 v128) (local $cm22 v128)\n' +
'    (local $vZero v128) (local $vOne v128) (local $vScale v128) (local $vHalf v128)' : '';

    const splats = simd ? '\n' +
'    (local.set $vZero  (f32x4.splat (f32.const 0.0)))\n' +
'    (local.set $vOne   (f32x4.splat (f32.const 1.0)))\n' +
'    (local.set $vScale (f32x4.splat (f32.const ' + L.outIndexMax + '.0)))\n' +
'    (local.set $vHalf  (f32x4.splat (f32.const 0.5)))\n' +
'    ;; The v128 splats are what V4 measured +3% for; reading the coefficients\n' +
'    ;; from memory rather than baking them in costs nine loads per call and\n' +
'    ;; buys one binary for every profile pair.\n' +
'    (local.set $cm00 (f32x4.splat (local.get $s00)))\n' +
'    (local.set $cm01 (f32x4.splat (local.get $s01)))\n' +
'    (local.set $cm02 (f32x4.splat (local.get $s02)))\n' +
'    (local.set $cm10 (f32x4.splat (local.get $s10)))\n' +
'    (local.set $cm11 (f32x4.splat (local.get $s11)))\n' +
'    (local.set $cm12 (f32x4.splat (local.get $s12)))\n' +
'    (local.set $cm20 (f32x4.splat (local.get $s20)))\n' +
'    (local.set $cm21 (f32x4.splat (local.get $s21)))\n' +
'    (local.set $cm22 (f32x4.splat (local.get $s22)))' : '';

    const simdLoop = (V) => simd ? '\n' +
'    ;; --- 4 pixels per iteration -------------------------------------------\n' +
'    (block $simd_exit\n' +
'      (loop $simd_loop\n' +
'        (br_if $simd_exit (i32.gt_s (i32.add (local.get $p) (i32.const 4)) (local.get $pixelCount)))' +
simdBody(L, V) + '\n' +
'        (br $simd_loop)))\n' : '';

    const tailComment = simd
        ? ';; --- scalar tail (0-3 pixels) ------------------------------------------\n' +
          '    ;; Byte-for-byte the arithmetic of one SIMD lane, in the same order, which\n' +
          '    ;; is what lets the scalar build be bit-identical rather than close.'
        : ';; --- one pixel per iteration -------------------------------------------\n' +
          '    ;; The same operations in the same order as one lane of the SIMD build, so\n' +
          '    ;; a host without SIMD gets the same bytes out, not merely similar ones.';

    const unit = (L.bits === 8 ? 'u8' : 'u16');

    const fn = (V) =>
'\n  ;; ' + V.name + '(inputPtr, outputPtr, pixelCount)\n' +
'  ;;   input  : ' + V.inCh  + ' channels per pixel, ' + unit + '\n' +
'  ;;   output : ' + V.outCh + ' channels per pixel, ' + unit + '\n' +
'  ;;   alpha  : ' + (V.alpha === 'none' ? 'none in the output'
                   : V.alpha === 'copy' ? 'copied straight through, never colour-managed'
                   : 'written opaque (' + L.outValueMax + ')') + '\n' +
'  (func (export "' + V.name + '") (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)\n' +
'    (local $p      i32)\n' +
'    (local $inPos  i32) (local $outPos i32)\n' +
'    (local $ti i32)' + simdLocals + '\n' +
'    (local $s00 f32) (local $s01 f32) (local $s02 f32)\n' +
'    (local $s10 f32) (local $s11 f32) (local $s12 f32)\n' +
'    (local $s20 f32) (local $s21 f32) (local $s22 f32)\n' +
'    (local $tr f32) (local $tg f32) (local $tb f32)\n' +
'    (local $tro f32) (local $tgo f32) (local $tbo f32)\n' +
'\n' +
'    (local.set $inPos  (local.get $inputPtr))\n' +
'    (local.set $outPos (local.get $outputPtr))\n' +
'\n' +
'    ;; Matrix from memory into locals, ONCE per call.\n' +
'    (local.set $s00 ' + mAt(L, 0) + ') (local.set $s01 ' + mAt(L, 1) + ') (local.set $s02 ' + mAt(L, 2) + ')\n' +
'    (local.set $s10 ' + mAt(L, 3) + ') (local.set $s11 ' + mAt(L, 4) + ') (local.set $s12 ' + mAt(L, 5) + ')\n' +
'    (local.set $s20 ' + mAt(L, 6) + ') (local.set $s21 ' + mAt(L, 7) + ') (local.set $s22 ' + mAt(L, 8) + ')' + splats + '\n' +
simdLoop(V) + '\n' +
'    ' + tailComment + '\n' +
'    (block $tail_exit\n' +
'      (loop $tail_loop\n' +
'        (br_if $tail_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))' +
scalarBody(L, V) + '\n' +
'        (br $tail_loop)))\n' +
'  )';

    return '(module\n' +
'  (memory (export "memory") ' + L.initialPages + ')\n' +
'\n' +
'  ;; Gamma tables and the matrix are read from linear memory; see the layout in\n' +
'  ;; scripts/build_matrix_shaper_wasm.js. One entry point per alpha shape —\n' +
'  ;; strides are baked in, so 3->3 keeps its constant offsets.\n' +
SHAPES.map(fn).join('\n') + '\n' +
')';
}

// ---------------------------------------------------------------------------

const VARIANTS = [
    { bits: 8,  simd: true  },
    { bits: 8,  simd: false },
    { bits: 16, simd: true  },
    { bits: 16, simd: false }
];

async function main() {
    const wabtFactory = require('wabt');
    const wabt = await wabtFactory();

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const header = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'kernels', '3d', 'tetra3d_simd.wasm.js'), 'utf8'
    ).split('// ====')[0];

    for (const v of VARIANTS) {
        const L    = layoutFor(v.bits);
        const name = 'matrix_shaper_int' + v.bits + '_' + (v.simd ? 'simd' : 'scalar');
        const WAT  = genWat(L, v.simd);

        fs.writeFileSync(path.join(OUT_DIR, name + '.wat'), WAT);

        const mod = wabt.parseWat(name + '.wat', WAT, {
            multi_value: true, mutable_globals: true, simd: true
        });
        const { buffer } = mod.toBinary({});
        mod.destroy();

        const bytes = Buffer.from(buffer);
        const js = header + '// ============================================================================\n' +
'// ' + name + '.wasm.js — AUTO-GENERATED from ' + name + '.wat\n' +
'// ============================================================================\n' +
'//\n' +
'// Do not edit by hand. Regenerate with:\n' +
'//   node scripts/build_matrix_shaper_wasm.js\n' +
'//\n' +
'// Variant: ' + v.bits + '-bit, ' +
    (v.simd ? 'SIMD, 4 pixels per iteration'
            : 'scalar (no SIMD) — f32, bit-identical to the SIMD build') + '\n' +
'// Size: ' + bytes.length + ' bytes .wasm\n' +
'//\n' +
'// Memory layout:\n' +
'//   ' + L.gammaInByte + ' .. ' + (L.gammaOutByte - 1) + '  input gamma  ' + L.inEntries + ' x f32\n' +
'//   ' + L.gammaOutByte + ' .. ' + (L.matrixByte - 1) + '  output gamma ' +
    (L.bits === 8 ? '65536 x u8' : '65537 x f32, sqrt-indexed') + '\n' +
'//   ' + L.matrixByte + '  matrix 9 x f32\n' +
'//   ' + L.pixelByte + '  pixel data\n' +
'// ============================================================================\n' +
'\n' +
"'use strict';\n" +
'\n' +
"var BASE64 = '" + bytes.toString('base64') + "';\n" +
'\n' +
'function decode(b64) {\n' +
"    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));\n" +
"    if (typeof atob !== 'undefined') {\n" +
'        var bin = atob(b64), out = new Uint8Array(bin.length);\n' +
'        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);\n' +
'        return out;\n' +
'    }\n' +
"    throw new Error('No base64 decoder available (need Buffer or atob).');\n" +
'}\n' +
'\n' +
'module.exports = decode(BASE64);\n' +
'module.exports.LAYOUT = {\n' +
'    bits:         ' + L.bits + ',\n' +
'    gammaInByte:  ' + L.gammaInByte + ',\n' +
'    gammaOutByte: ' + L.gammaOutByte + ',\n' +
'    matrixByte:   ' + L.matrixByte + ',\n' +
'    pixelByte:    ' + L.pixelByte + ',\n' +
'    inEntries:    ' + L.inEntries + ',\n' +
'    outIndexMax:   ' + L.outIndexMax + ',\n' +
'    outValueMax:   ' + L.outValueMax + ',\n' +
'    outEntryBytes: ' + L.outEntryBytes + ',\n' +
'    indexRoot:     ' + L.indexRoot + '\n' +
'};\n';

        fs.writeFileSync(path.join(OUT_DIR, name + '.wasm.js'), js);
        console.log(name.padEnd(30) + String(bytes.length).padStart(7) + ' bytes .wasm');
    }
}

main().catch(e => { console.error(e); process.exit(1); });
