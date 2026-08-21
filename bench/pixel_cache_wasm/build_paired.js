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
 * PAIRED EXPORTS — one module, two entry points, no runtime mode.
 *
 *   node bench/pixel_cache_wasm/build_paired.js
 *
 * WHY THIS SHAPE. The earlier POC put the cache behind a `$cacheMode`
 * parameter, and measured a 15-22% penalty on the UNCACHED path — which grew
 * when a third mode was added, because the cost is the code behind the guard,
 * not the guard. A single mode compare per pixel was worth ~10% on its own:
 * swapping which mode was tested first swapped which one won.
 *
 * So the cache is not a mode. It is a second function:
 *
 *   interp_tetra3d_simd          the shipped kernel, byte for byte
 *   interp_tetra3d_simd_cached   the same, with a single-entry cache
 *
 * Both in one module, sharing one memory and one compile. The uncached export
 * pays nothing BY CONSTRUCTION rather than by measurement — there is no cache
 * code in it to pay for.
 *
 * THE CACHED EXPORT TAKES THE SAME PARAMETERS. The cache is one i32 key and
 * one v128 output held in LOCALS, so there is no table, no pointer, no size
 * and no mask to pass. Switching it on is swapping a function reference; the
 * call site does not change at all.
 *
 * WHAT THE CACHE IS. Not "have I seen this colour before" — "did the same bits
 * arrive as last time, so the same bits can leave". It never interprets the
 * pixel, which is why the same insertion works for int8, int16, RGB and RGBA,
 * and why it is identical for the scalar and SIMD kernels.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const OUT = __dirname;

/**
 * Find the balanced (...) block starting at `from`, respecting WAT lexical
 * rules — a paren inside a comment or a string is not a paren.
 */
function blockAt(src, from){
    let depth = 0, i = from;
    while(i < src.length){
        const c = src[i], d = src[i+1];
        if(c === ';' && d === ';'){                       // line comment
            while(i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if(c === '(' && d === ';'){                       // block comment
            i += 2;
            while(i < src.length && !(src[i] === ';' && src[i+1] === ')')) i++;
            i += 2;
            continue;
        }
        if(c === '"'){                                    // string
            i++;
            while(i < src.length && src[i] !== '"'){ if(src[i] === '\\') i++; i++; }
            i++;
            continue;
        }
        if(c === '('){ depth++; }
        else if(c === ')'){ depth--; if(depth === 0) return src.slice(from, i + 1); }
        i++;
    }
    throw new Error('unbalanced parens from offset ' + from);
}

function at(src, anchor, insert, where){
    const i = src.indexOf(anchor);
    if(i < 0) throw new Error('anchor not found — the kernel has changed:\n' + anchor.slice(0,120));
    if(src.indexOf(anchor, i + 1) >= 0) throw new Error('anchor is not unique:\n' + anchor.slice(0,120));
    return where === 'after'
        ? src.slice(0, i + anchor.length) + insert + src.slice(i + anchor.length)
        : src.slice(0, i) + insert + src.slice(i);
}

/**
 * One kernel's recipe. `anchors` are the five points the cache attaches to;
 * they differ between kernels only in the exact source text, not in what they
 * mean, which is the thing that makes this scale to the whole family.
 */
const KERNELS = [{
    name:   'tetra3d_simd',
    src:    path.join(__dirname, '..', '..', 'src', 'kernels', '3d', 'tetra3d_simd.wat'),
    export: 'interp_tetra3d_simd',

    // The last local declaration — cache locals go after it.
    localsAfter: `    (local $outputStride i32)   ;; 3 or 4 bytes per pixel`,
    // A statement in the prologue, before the pixel loop.
    initAfter:   `    (local.set $outputStride (local.get $cMax))`,
    // Right after the input bytes are read, so a hit skips the grid maths,
    // the case dispatch and all four corner gathers.
    probeAfter:  `        (local.set $inputPos (i32.add (local.get $inputPos) (i32.const 3)))`,
    // Where the finished pixel is still live in $vOut.
    storeBefore: `        ;; --- Alpha tail (mirrors tetra3d_nch.wat) --------------------`,
    // The v128 holding the finished pixel.
    outLocal:    '$vOut'
}];

function addCache(fn, k){
    fn = fn.replace('(func (export "' + k.export + '")',
                    '(func (export "' + k.export + '_cached")');

    fn = at(fn, k.localsAfter, `

    ;; ---- SINGLE-ENTRY PIXEL CACHE ---------------------------------------
    ;; Two locals, no memory, no parameters. The signature is unchanged from
    ;; the uncached export, so enabling this is swapping a function reference.
    (local $ckey    i32)
    (local $prevKey i32)
    (local $prevOut v128)`, 'after');

    fn = at(fn, k.initAfter, `
    ;; A packed RGB key is at most 0x00FFFFFF, so -1 can never collide.
    (local.set $prevKey (i32.const -1))`, 'after');

    fn = at(fn, k.probeAfter, `

        ;; ---- CACHE PROBE -------------------------------------------------
        ;; "Same bits in as last time?" — one compare. On a hit the previous
        ;; output vector goes straight back out; its bytes are never examined.
        (local.set $ckey
          (i32.or (i32.or (i32.shl (local.get $input0) (i32.const 16))
                          (i32.shl (local.get $input1) (i32.const 8)))
                  (local.get $input2)))
        (block $skip_work
          (if (i32.eq (local.get $ckey) (local.get $prevKey))
            (then
              (v128.store32_lane align=1 0
                (local.get $outputPos) (local.get ${k.outLocal === '$vOut' ? '$prevOut' : '$prevOut'}))
              (local.set $outputPos
                (i32.add (local.get $outputPos) (local.get $outputStride)))
              (br $skip_work)))`, 'after');

    fn = at(fn, k.storeBefore, `        ;; ---- CACHE STORE -------------------------------------------------
        (local.set $prevKey (local.get $ckey))
        (local.set $prevOut (local.get ${k.outLocal}))
        )   ;; end $skip_work

`, 'before');

    return fn;
}

(async () => {
    const wabt = await require('wabt')();

    for(const k of KERNELS){
        const src = fs.readFileSync(k.src, 'utf8');
        const start = src.indexOf('(func (export "' + k.export + '")');
        if(start < 0) throw new Error('export not found: ' + k.export);

        const fn = blockAt(src, start);
        const prefix = src.slice(0, start);
        const suffix = src.slice(start + fn.length);

        // The uncached function goes in VERBATIM. Nothing is regenerated, so
        // the shipped path cannot drift by a single instruction.
        const wat = prefix + fn + '\n\n' + addCache(fn, k) + suffix;
        fs.writeFileSync(path.join(OUT, k.name + '_paired.wat'), wat);

        const mod = wabt.parseWat(k.name + '_paired.wat', wat,
            {multi_value: true, mutable_globals: true, simd: true});
        const { buffer } = mod.toBinary({});
        mod.destroy();
        fs.writeFileSync(path.join(OUT, k.name + '_paired.wasm'), Buffer.from(buffer));

        const shipped = fs.statSync(k.src.replace('.wat', '.wasm.js')).size;
        console.log(k.name + '_paired.wasm  ' + buffer.length + ' bytes  ' +
                    '(2 exports: ' + k.export + ', ' + k.export + '_cached)');
    }
})().catch(e => { console.error(e.message || e); process.exit(1); });
