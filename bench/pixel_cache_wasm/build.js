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
 * STEP 2 OF THE WASM PIXEL-CACHE POC — build a cached tetra3d scalar kernel.
 *
 *   node bench/pixel_cache_wasm/build.js
 *
 * GENERATED FROM THE SHIPPED KERNEL, not hand-copied. It reads
 * src/kernels/3d/tetra3d_nch.wat and inserts the cache at five anchors, so
 * the POC is the shipped tetrahedral maths plus a diff, and cannot silently
 * drift from it. If the kernel changes and an anchor stops matching, this
 * throws rather than emitting something subtly different.
 *
 * ONE BLOCK OF CODE, THREE MODES, chosen by a runtime parameter — which is
 * the design question this POC exists to answer:
 *
 *   $cacheMode 0   off. One `i32.eqz`-shaped test per pixel and nothing else.
 *              1   last-pixel. The lcms design: compare against the previous
 *                  key held in a LOCAL, no memory touched at all.
 *              2   hash array. Direct-mapped, 8 bytes per entry (i32 key,
 *                  i32 packed value), Knuth multiplicative hash.
 *
 * Mode 0 measured against the UNMODIFIED kernel is the toggle tax: not
 * "does the branch predict" — it will — but whether its presence in the loop
 * costs anything in unrolling or register allocation. That is not knowable by
 * reasoning about it, which is the whole point.
 *
 * The value is packed into one i32 (up to 4 output channels), so a hit is one
 * i32 load for the key and one for the value. On a miss the freshly written
 * output bytes are read back from memory and packed — cMax loads — which
 * avoids threading the cache through 600 lines of channel loops.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src', 'kernels', '3d', 'tetra3d_nch.wat');
const OUT = __dirname;

function at(src, anchor, insert, where){
    const i = src.indexOf(anchor);
    if(i < 0) throw new Error('anchor not found — the kernel has changed:\n' + anchor.slice(0, 120));
    if(src.indexOf(anchor, i + 1) >= 0) throw new Error('anchor is not unique:\n' + anchor.slice(0, 120));
    return where === 'after'
        ? src.slice(0, i + anchor.length) + insert + src.slice(i + anchor.length)
        : src.slice(0, i) + insert + src.slice(i);
}

let wat = fs.readFileSync(SRC, 'utf8');

// 1. Parameters -------------------------------------------------------------
wat = at(wat,
`        (param $outAlphaMode i32)   ;; 0 = none, 1 = fill 255, 2 = preserve-copy`,
`

        ;; ---- PIXEL CACHE (POC) ------------------------------------------
        (param $cacheMode   i32)   ;; 0 = off, 1 = last-pixel, 2 = hash array
        (param $cachePtr    i32)   ;; byte offset of the table (mode 2)
        (param $cacheShift  i32)   ;; 32 - log2(entries)
        (param $cacheMask   i32)   ;; entries - 1`,
'after');

// 2. Locals -----------------------------------------------------------------
wat = at(wat,
`        (local $u8          i32)   ;; clamped u8 output`,
`

        ;; ---- PIXEL CACHE (POC) ------------------------------------------
        (local $ckey        i32)   ;; packed 24-bit input colour
        (local $cval        i32)   ;; packed output bytes (up to 4)
        (local $chit        i32)
        (local $caddr       i32)
        (local $prevKey     i32)
        (local $prevVal     i32)`,
'after');

// 3. Init -------------------------------------------------------------------
// -1 cannot collide: a packed 24-bit colour is at most 0x00FFFFFF.
wat = at(wat,
`        local.get $outputPtr
        local.set $outputPos`,
`

        i32.const -1
        local.set $prevKey`,
'after');

// 4. Probe, and open the skip block -----------------------------------------
// Placed after the three input bytes are read and inputPos has advanced, so a
// hit skips the grid maths as well as the interpolation.
wat = at(wat,
`                local.get $inputPos
                i32.const 3
                i32.add
                local.set $inputPos`,
`

                ;; ================= PIXEL CACHE: PROBE =====================
                ;; EVERYTHING IS INSIDE THE GUARD, including packing the key.
                ;; The first version of this POC packed the key before the
                ;; branch, so cacheMode 0 paid four instructions per pixel for
                ;; a cache it was not using, and the "toggle tax" measured 5-7%
                ;; that had nothing to do with the branch.
                (block $skip_work
                  (if (local.get $cacheMode)
                    (then
                      (local.set $chit (i32.const 0))
                      (local.set $ckey
                          (i32.or (i32.or (i32.shl (local.get $input0) (i32.const 16))
                                          (i32.shl (local.get $input1) (i32.const 8)))
                                  (local.get $input2)))
                      (if (i32.eq (local.get $cacheMode) (i32.const 1))
                        (then
                          ;; LAST-PIXEL — locals only, no memory touched.
                          (if (i32.eq (local.get $ckey) (local.get $prevKey))
                            (then
                              (local.set $cval (local.get $prevVal))
                              (local.set $chit (i32.const 1)))))
                        (else
                          ;; HASH ARRAY — direct mapped, 8 bytes per entry.
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
                              (local.set $cval (i32.load offset=4 (local.get $caddr)))
                              (local.set $chit (i32.const 1))))))

                      (if (local.get $chit)
                        (then
                          ;; HIT — write the packed bytes and skip the whole
                          ;; tetrahedron.
                          (i32.store8          (local.get $outputPos) (local.get $cval))
                          (i32.store8 offset=1 (local.get $outputPos) (i32.shr_u (local.get $cval) (i32.const 8)))
                          (i32.store8 offset=2 (local.get $outputPos) (i32.shr_u (local.get $cval) (i32.const 16)))
                          (if (i32.eq (local.get $cMax) (i32.const 4))
                            (then
                              (i32.store8 offset=3 (local.get $outputPos) (i32.shr_u (local.get $cval) (i32.const 24)))))
                          (local.set $outputPos (i32.add (local.get $outputPos) (local.get $cMax)))
                          (br $skip_work)))))`,
'after');

// 5. Store, and close the skip block ----------------------------------------
// outputPos now points past the bytes the channel loops just wrote, so the
// value is read back rather than threaded through them.
wat = at(wat,
`                ;; -- Alpha tail ------------------------------------------`,
`                ;; ================= PIXEL CACHE: STORE =====================
                (if (local.get $cacheMode)
                  (then
                    (local.set $caddr (i32.sub (local.get $outputPos) (local.get $cMax)))
                    (local.set $cval
                      (i32.or (i32.or (i32.load8_u          (local.get $caddr))
                                      (i32.shl (i32.load8_u offset=1 (local.get $caddr)) (i32.const 8)))
                              (i32.shl (i32.load8_u offset=2 (local.get $caddr)) (i32.const 16))))
                    (if (i32.eq (local.get $cMax) (i32.const 4))
                      (then
                        (local.set $cval
                          (i32.or (local.get $cval)
                                  (i32.shl (i32.load8_u offset=3 (local.get $caddr)) (i32.const 24))))))
                    (if (i32.eq (local.get $cacheMode) (i32.const 1))
                      (then
                        (local.set $prevKey (local.get $ckey))
                        (local.set $prevVal (local.get $cval)))
                      (else
                        ;; A collision is a miss AND an eviction — the newer
                        ;; colour wins, which is what the hit-rate model assumed.
                        (local.set $caddr
                          (i32.add (local.get $cachePtr)
                            (i32.shl
                              (i32.and (i32.shr_u (i32.mul (local.get $ckey)
                                                           (i32.const 0x9E3779B1))
                                                  (local.get $cacheShift))
                                       (local.get $cacheMask))
                              (i32.const 3))))
                        (i32.store          (local.get $caddr) (local.get $ckey))
                        (i32.store offset=4 (local.get $caddr) (local.get $cval))))))
                )   ;; end $skip_work

`,
'before');

// Rename the export so the two modules can coexist in one process.
wat = wat.replace('(func (export "interp_tetra3d_nCh")',
                  '(func (export "interp_tetra3d_nCh_cached")');

fs.writeFileSync(path.join(OUT, 'tetra3d_cache.wat'), wat);

(async () => {
    const wabt = await require('wabt')();
    const mod = wabt.parseWat('tetra3d_cache.wat', wat, {multi_value: true, mutable_globals: true, simd: true});
    const { buffer } = mod.toBinary({});
    mod.destroy();
    fs.writeFileSync(path.join(OUT, 'tetra3d_cache.wasm'), Buffer.from(buffer));
    console.log('tetra3d_cache.wat   ' + wat.split('\n').length + ' lines');
    console.log('tetra3d_cache.wasm  ' + buffer.length + ' bytes');
})().catch(e => { console.error(e.message || e); process.exit(1); });
