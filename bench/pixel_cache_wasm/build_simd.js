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
 * Cache POC against the SIMD 3D kernel — the path that actually ships.
 *
 *   node bench/pixel_cache_wasm/build_simd.js
 *
 * THE SCALAR POC WAS MEASURING THE FALLBACK. The reasoning that sent it there
 * was "a pixel cache cannot go in a SIMD kernel, you cannot branch per lane",
 * and it is wrong for this kernel: tetra3d_simd vectorises across CHANNELS,
 * not pixels. One iteration is one pixel — the four lanes are the four u16
 * channels at a CLUT corner, picked up by `v128.load64_zero` +
 * `i32x4.extend_low_i16x8_u`. There is nothing per-lane about a pixel test
 * here, so the cache goes in exactly as easily as it does in the scalar
 * kernel, on the path everybody runs.
 *
 * THE HIT PATH IS ALSO MUCH CHEAPER HERE. The scalar POC had to pack the
 * output bytes into an i32 on a miss and unpack them on a hit. This kernel
 * already holds the finished pixel in a v128 (`$vOut`) and stores it with one
 * `v128.store32_lane`, so the cached value is just that vector held in a
 * local: a hit is ONE compare and ONE store, with no byte handling at all.
 *
 *   $cacheMode 0   off
 *              1   last-vector: previous key in an i32 local, previous output
 *                  in a v128 local. No memory touched.
 *              2   hash array, N entries of {i32 key, i32 packed output}.
 *
 * Note what mode 1 is: not "the last pixel's colour" as a semantic thing, but
 * "the same bits arrived, so the same bits leave". It never interprets the
 * pixel, which is why one implementation covers int8, int16, RGB and RGBA.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src', 'kernels', '3d', 'tetra3d_simd.wat');
const OUT = __dirname;

function at(src, anchor, insert, where){
    const i = src.indexOf(anchor);
    if(i < 0) throw new Error('anchor not found — the kernel has changed:\n' + anchor.slice(0,120));
    if(src.indexOf(anchor, i + 1) >= 0) throw new Error('anchor is not unique:\n' + anchor.slice(0,120));
    return where === 'after'
        ? src.slice(0, i + anchor.length) + insert + src.slice(i + anchor.length)
        : src.slice(0, i) + insert + src.slice(i);
}

let wat = fs.readFileSync(SRC, 'utf8');

// 1. Params -----------------------------------------------------------------
wat = at(wat,
`    (param $outAlphaMode i32)   ;; 0 = none, 1 = fill 255, 2 = preserve-copy`,
`

    ;; ---- PIXEL CACHE (POC) ----------------------------------------------
    (param $cacheMode   i32)   ;; 0 = off, 1 = last-vector, 2 = hash array
    (param $cachePtr    i32)
    (param $cacheShift  i32)   ;; 32 - log2(entries)
    (param $cacheMask   i32)   ;; entries - 1`,
'after');

// 2. Locals -----------------------------------------------------------------
wat = at(wat,
`    (local $outputStride i32)   ;; 3 or 4 bytes per pixel`,
`

    ;; ---- PIXEL CACHE (POC) ----------------------------------------------
    (local $ckey        i32)
    (local $chit        i32)
    (local $caddr       i32)
    (local $prevKey     i32)
    (local $prevOut     v128)   ;; the finished pixel, kept as a vector
    (local $cOut32      i32)`,
'after');

// 3. Init -------------------------------------------------------------------
wat = at(wat,
`    (local.set $outputStride (local.get $cMax))`,
`
    (local.set $prevKey (i32.const -1))   ;; a packed RGB key is <= 0x00FFFFFF`,
'after');

// 4. Probe ------------------------------------------------------------------
// After the three input bytes are read, so a hit skips the grid maths, the
// case dispatch and all four corner gathers.
wat = at(wat,
`        (local.set $inputPos (i32.add (local.get $inputPos) (i32.const 3)))`,
`

        ;; ================= PIXEL CACHE: PROBE =========================
        ;; Everything inside the guard, including packing the key — putting
        ;; the pack outside it made cacheMode 0 pay for a cache it was not
        ;; using, which is how the scalar POC first measured a 5-7% "toggle
        ;; tax" that was nothing to do with the branch.
        (block $skip_work
          (if (local.get $cacheMode)
            (then
              (local.set $chit (i32.const 0))
              (local.set $ckey
                (i32.or (i32.or (i32.shl (local.get $input0) (i32.const 16))
                                (i32.shl (local.get $input1) (i32.const 8)))
                        (local.get $input2)))

              ;; A PROPER IF/ELSE CHAIN. The first draft tested mode 3, then
              ;; tested mode 1 with the hash in its else — so a mode-3 MISS fell
              ;; into the hash probe with cacheMask 0 and did a bogus lookup on
              ;; every pixel. It still produced correct pixels, which is exactly
              ;; why it was not obvious: the only symptom was mode 3 measuring
              ;; slower than the thing it was meant to beat.
              (if (i32.eq (local.get $cacheMode) (i32.const 3))
                (then
                  ;; LAST, VALUE AS i32 — tested FIRST in this build. The
                  ;; previous build tested mode 1 first, which handed it a free
                  ;; compare on every pixel; if the ranking follows the order,
                  ;; the two are equivalent and the ordering was the whole
                  ;; difference.
                  (if (i32.eq (local.get $ckey) (local.get $prevKey))
                    (then
                      (i32.store align=1 (local.get $outputPos) (local.get $cOut32))
                      (local.set $outputPos
                        (i32.add (local.get $outputPos) (local.get $outputStride)))
                      (br $skip_work))))
                (else
                  (if (i32.eq (local.get $cacheMode) (i32.const 1))
                    (then
                      ;; LAST-VECTOR — tested second in this build.
                      (if (i32.eq (local.get $ckey) (local.get $prevKey))
                        (then
                          (v128.store32_lane align=1 0
                            (local.get $outputPos) (local.get $prevOut))
                          (local.set $outputPos
                            (i32.add (local.get $outputPos) (local.get $outputStride)))
                          (br $skip_work))))
                    (else
                      ;; HASH ARRAY — {i32 key, i32 packed output}.
                      (local.set $caddr
                        (i32.add (local.get $cachePtr)
                          (i32.shl
                            (i32.and (i32.shr_u (i32.mul (local.get $ckey)
                                                         (i32.const 0x9E3779B1))
                                                (local.get $cacheShift))
                                     (local.get $cacheMask))
                            (i32.const 3))))
                      (if (i32.eq (i32.load (local.get $caddr)) (local.get $ckey))
                        (then
                          (i32.store align=1 (local.get $outputPos)
                            (i32.load offset=4 (local.get $caddr)))
                          (local.set $outputPos
                            (i32.add (local.get $outputPos) (local.get $outputStride)))
                          (br $skip_work)))))))))`,
'after');

// 5. Store, and close the block ---------------------------------------------
// $vOut still holds the finished pixel here, so mode 1 stores a vector and
// touches no memory at all.
wat = at(wat,
`        ;; --- Alpha tail (mirrors tetra3d_nch.wat) --------------------`,
`        ;; ================= PIXEL CACHE: STORE =========================
        (if (local.get $cacheMode)
          (then
            (if (i32.eq (local.get $cacheMode) (i32.const 3))
              (then
                (local.set $prevKey (local.get $ckey))
                (local.set $cOut32 (i32x4.extract_lane 0 (local.get $vOut)))))
            (if (i32.eq (local.get $cacheMode) (i32.const 1))
              (then
                (local.set $prevKey (local.get $ckey))
                (local.set $prevOut (local.get $vOut)))
              (else
                (local.set $cOut32 (i32x4.extract_lane 0 (local.get $vOut)))
                (local.set $caddr
                  (i32.add (local.get $cachePtr)
                    (i32.shl
                      (i32.and (i32.shr_u (i32.mul (local.get $ckey)
                                                   (i32.const 0x9E3779B1))
                                          (local.get $cacheShift))
                               (local.get $cacheMask))
                      (i32.const 3))))
                (i32.store          (local.get $caddr) (local.get $ckey))
                (i32.store offset=4 (local.get $caddr) (local.get $cOut32))))))
        )   ;; end $skip_work

`,
'before');

wat = wat.replace('(func (export "interp_tetra3d_simd")',
                  '(func (export "interp_tetra3d_simd_cached")');

fs.writeFileSync(path.join(OUT, 'tetra3d_simd_cache.wat'), wat);

(async () => {
    const wabt = await require('wabt')();
    const mod = wabt.parseWat('tetra3d_simd_cache.wat', wat,
        {multi_value: true, mutable_globals: true, simd: true});
    const { buffer } = mod.toBinary({});
    mod.destroy();
    fs.writeFileSync(path.join(OUT, 'tetra3d_simd_cache.wasm'), Buffer.from(buffer));
    console.log('tetra3d_simd_cache.wasm  ' + buffer.length + ' bytes');
})().catch(e => { console.error(e.message || e); process.exit(1); });
