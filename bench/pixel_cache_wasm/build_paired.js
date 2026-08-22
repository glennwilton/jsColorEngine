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
 * The hand-written .wat is the source of truth. This script copies the
 * interpolator function verbatim, injects a single-entry cache at the
 * four `;;Inject:*` comments (same names on every shape), and compiles
 * both into one module:
 *
 *   interp_*             shipped kernel, byte for byte
 *   interp_*_cached      single-entry (registers)
 *   interp_*_cached_N    N-slot hash table, N baked in (8, 16, …)
 *
 * Counters and table size are compile toggles, not runtime branches:
 *
 *   buildAll({ stats: true, tables: [8] })
 *   buildAll({ tables: [8, 16, 32, 256, 1024, 4096] })
 *
 *   node bench/pixel_cache_wasm/build_paired.js [--stats] [--tables=8,32]
 *
 * 4D keys are 32 bits (int8) or 64 bits (int16) — every bit pattern is
 * a legal colour, so the sentinel is a $havePrev flag, not -1.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'src', 'kernels');
const OUT = __dirname;

function blockAt(src, from){
    let depth = 0, i = from;
    while(i < src.length){
        const c = src[i], d = src[i+1];
        if(c === ';' && d === ';'){
            while(i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if(c === '(' && d === ';'){
            i += 2;
            while(i < src.length && !(src[i] === ';' && src[i+1] === ')')) i++;
            i += 2;
            continue;
        }
        if(c === '"'){
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

const INJECT = {
    localsAfter: ';;Inject:localsAfter',
    initAfter:   ';;Inject:initAfter',
    probeAfter:  ';;Inject:probeAfter',
    storeBefore: ';;Inject:storeBefore'
};

const KERNELS = [
    {
        name:   'tetra3d_simd',
        src:    path.join(SRC, '3d', 'tetra3d_simd.wat'),
        export: 'interp_tetra3d_simd',
        kind:   'simd8',
        key:    'rgb',
        storeOp: 'store32',
        dim:    3
    },
    {
        name:   'tetra3d_simd_int16',
        src:    path.join(SRC, '3d', 'tetra3d_simd_int16.wat'),
        export: 'interp_tetra3d_simd_int16',
        kind:   'simd16',
        key:    'rgb16',
        storeOp: 'store64',
        dim:    3
    },
    {
        name:   'tetra3d_nch',
        src:    path.join(SRC, '3d', 'tetra3d_nch.wat'),
        export: 'interp_tetra3d_nCh',
        kind:   'scalar8',
        key:    'rgb',
        storeOp: 'copy',
        dim:    3
    },
    {
        name:   'tetra3d_nch_int16',
        src:    path.join(SRC, '3d', 'tetra3d_nch_int16.wat'),
        export: 'interp_tetra3d_nCh_int16',
        kind:   'scalar16',
        key:    'rgb16',
        storeOp: 'copy',
        dim:    3
    },
    {
        name:   'tetra4d_simd',
        src:    path.join(SRC, '4d', 'tetra4d_simd.wat'),
        export: 'interp_tetra4d_simd',
        kind:   'simd8',
        key:    'kcmy8',
        storeOp: 'store32',
        dim:    4
    },
    {
        name:   'tetra4d_simd_int16',
        src:    path.join(SRC, '4d', 'tetra4d_simd_int16.wat'),
        export: 'interp_tetra4d_simd_int16',
        kind:   'simd16',
        key:    'kcmy16',
        storeOp: 'store64',
        dim:    4
    },
    {
        name:   'tetra4d_nch',
        src:    path.join(SRC, '4d', 'tetra4d_nch.wat'),
        export: 'interp_tetra4d_nCh',
        kind:   'scalar8',
        key:    'kcmy8',
        storeOp: 'copy',
        dim:    4
    },
    {
        name:   'tetra4d_nch_int16',
        src:    path.join(SRC, '4d', 'tetra4d_nch_int16.wat'),
        export: 'interp_tetra4d_nCh_int16',
        kind:   'scalar16',
        key:    'kcmy16',
        storeOp: 'copy',
        dim:    4
    },
    {
        name:   'tetra5d_nch',
        src:    path.join(SRC, '5d', 'tetra5d_nch.wat'),
        export: 'interp_tetra5d_nCh',
        kind:   'scalar8',
        key:    'nch5',
        storeOp: 'copy',
        dim:    5
    },
    {
        name:   'tetra6d_nch',
        src:    path.join(SRC, '6d', 'tetra6d_nch.wat'),
        export: 'interp_tetra6d_nCh',
        kind:   'scalar8',
        key:    'nch6',
        storeOp: 'copy',
        dim:    6
    }
];

function twoWordKey(k){
    return k.key === 'kcmy16' || k.key === 'rgb16' || k.key === 'nch5' || k.key === 'nch6';
}

function localsDecl(k){
    if(k.key === 'rgb'){
        const extra = k.kind.startsWith('scalar')
            ? `\n    (local $cacheStride i32)\n    (local $ci i32)\n    (local $prevOutPtr i32)`
            : `\n    (local $prevOut v128)`;
        return `
    (local $ckey    i32)
    (local $prevKey i32)${extra}`;
    }
    if(k.key === 'kcmy8'){
        const stride = k.kind.startsWith('scalar')
            ? `\n    (local $cacheStride i32)\n    (local $ci i32)\n    (local $prevOutPtr i32)` : '';
        const prevOut = k.kind.startsWith('simd') ? `\n    (local $prevOut v128)` : '';
        return `
    (local $ckey     i32)
    (local $prevKey  i32)
    (local $havePrev i32)${prevOut}${stride}`;
    }
    const stride = k.kind.startsWith('scalar')
        ? `\n    (local $cacheStride i32)\n    (local $ci i32)\n    (local $prevOutPtr i32)` : '';
    const prevOut = k.kind.startsWith('simd') ? `\n    (local $prevOut v128)` : '';
    return `
    (local $ckeyLo   i32)
    (local $ckeyHi   i32)
    (local $prevLo   i32)
    (local $prevHi   i32)
    (local $havePrev i32)${prevOut}${stride}`;
}

function initSnippet(k){
    if(k.key === 'rgb'){
        const stride = k.kind.startsWith('scalar')
            ? `\n        (local.set $cacheStride (local.get $cMax))` : '';
        return `
    (local.set $prevKey (i32.const -1))${stride}`;
    }
    if(k.kind === 'scalar8'){
        return `
        (local.set $havePrev (i32.const 0))
        (local.set $cacheStride (local.get $cMax))`;
    }
    if(k.kind === 'scalar16'){
        return `
        (local.set $havePrev (i32.const 0))
        (local.set $cacheStride (i32.shl (local.get $cMax) (i32.const 1)))`;
    }
    return `
    (local.set $havePrev (i32.const 0))`;
}

function packKey(k){
    if(k.key === 'rgb'){
        return `(local.set $ckey
          (i32.or (i32.or (i32.shl (local.get $input0) (i32.const 16))
                          (i32.shl (local.get $input1) (i32.const 8)))
                  (local.get $input2)))`;
    }
    if(k.key === 'kcmy8'){
        return `(local.set $ckey
          (i32.or (i32.or (i32.or
            (i32.shl (local.get $inputK) (i32.const 24))
            (i32.shl (local.get $input0) (i32.const 16)))
            (i32.shl (local.get $input1) (i32.const 8)))
            (local.get $input2)))`;
    }
    if(k.key === 'rgb16'){
        return `(local.set $ckeyLo
          (i32.or (local.get $input0) (i32.shl (local.get $input1) (i32.const 16))))
        (local.set $ckeyHi (local.get $input2))`;
    }
    if(k.key === 'nch5'){
        return `(local.set $ckeyLo
          (i32.or (i32.or (i32.or
            (local.get $inputE)
            (i32.shl (local.get $inputK) (i32.const 8)))
            (i32.shl (local.get $input0) (i32.const 16)))
            (i32.shl (local.get $input1) (i32.const 24))))
        (local.set $ckeyHi (local.get $input2))`;
    }
    if(k.key === 'nch6'){
        return `(local.set $ckeyLo
          (i32.or (i32.or (i32.or
            (local.get $inputF)
            (i32.shl (local.get $inputE) (i32.const 8)))
            (i32.shl (local.get $inputK) (i32.const 16)))
            (i32.shl (local.get $input0) (i32.const 24))))
        (local.set $ckeyHi
          (i32.or (local.get $input1) (i32.shl (local.get $input2) (i32.const 8))))`;
    }
    return `(local.set $ckeyLo
          (i32.or (local.get $inputK) (i32.shl (local.get $input0) (i32.const 16))))
        (local.set $ckeyHi
          (i32.or (local.get $input1) (i32.shl (local.get $input2) (i32.const 16))))`;
}

function hitPred(k){
    if(k.key === 'rgb'){
        return `(i32.eq (local.get $ckey) (local.get $prevKey))`;
    }
    if(k.key === 'kcmy8'){
        return `(i32.and (local.get $havePrev)
            (i32.eq (local.get $ckey) (local.get $prevKey)))`;
    }
    return `(i32.and (local.get $havePrev)
            (i32.and (i32.eq (local.get $ckeyLo) (local.get $prevLo))
                     (i32.eq (local.get $ckeyHi) (local.get $prevHi))))`;
}

function hitStore(k){
    if(k.storeOp === 'store32'){
        return `(v128.store32_lane align=1 0
                (local.get $outputPos) (local.get $prevOut))
              (local.set $outputPos
                (i32.add (local.get $outputPos) (local.get $outputStride)))`;
    }
    if(k.storeOp === 'store64'){
        return `(v128.store64_lane align=1 0
                (local.get $outputPos) (local.get $prevOut))
              (local.set $outputPos
                (i32.add (local.get $outputPos) (local.get $outputStride)))`;
    }
    return `(local.set $ci (i32.const 0))
              (loop $cache_copy
                (i32.store8
                  (i32.add (local.get $outputPos) (local.get $ci))
                  (i32.load8_u (i32.add (local.get $prevOutPtr) (local.get $ci))))
                (local.set $ci (i32.add (local.get $ci) (i32.const 1)))
                (br_if $cache_copy (i32.lt_u (local.get $ci) (local.get $cacheStride))))
              (local.set $outputPos
                (i32.add (local.get $outputPos) (local.get $cacheStride)))`;
}

function missStore(k){
    const ptr = k.kind.startsWith('scalar')
        ? `\n        (local.set $prevOutPtr (i32.sub (local.get $outputPos) (local.get $cacheStride)))`
        : '';
    if(k.key === 'rgb'){
        const out = k.kind.startsWith('simd')
            ? `\n        (local.set $prevOut (local.get $vOut))` : '';
        return `(local.set $prevKey (local.get $ckey))${out}${ptr}`;
    }
    if(k.key === 'kcmy8'){
        const out = k.kind.startsWith('simd')
            ? `\n        (local.set $prevOut (local.get $vOut))` : '';
        return `(local.set $havePrev (i32.const 1))
        (local.set $prevKey (local.get $ckey))${out}${ptr}`;
    }
    const out = k.kind.startsWith('simd')
        ? `\n        (local.set $prevOut (local.get $vOut))` : '';
    return `(local.set $havePrev (i32.const 1))
        (local.set $prevLo (local.get $ckeyLo))
        (local.set $prevHi (local.get $ckeyHi))${out}${ptr}`;
}

const KNUTH = -1640531527; // i32 bits of 2654435761

function tableStride(k){
    return twoWordKey(k) ? 32 : 16;
}

function normalizeTables(opts){
    const raw = opts && opts.tables;
    if(raw == null) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    for(const n of list){
        if(n < 2 || (n & (n - 1))) throw new Error('table size must be a power of two >= 2: ' + n);
    }
    return list;
}

function tableLocals(k){
    const keys = twoWordKey(k)
        ? `\n    (local $ckeyLo i32)\n    (local $ckeyHi i32)`
        : `\n    (local $ckey i32)`;
    const scalar = k.kind.startsWith('scalar')
        ? `\n    (local $cacheStride i32)\n    (local $ci i32)` : '';
    return `${keys}
    (local $h       i32)
    (local $slotPtr i32)${scalar}`;
}

function tableInit(k){
    if(k.kind === 'scalar8'){
        return `
        (local.set $cacheStride (local.get $cMax))`;
    }
    if(k.kind === 'scalar16'){
        return `
        (local.set $cacheStride (i32.shl (local.get $cMax) (i32.const 1)))`;
    }
    return '';
}

function tableHash(k, slots){
    const shift = 32 - Math.log2(slots);
    const strideShift = Math.log2(tableStride(k));
    const key = twoWordKey(k)
        ? '(i32.xor (local.get $ckeyLo) (local.get $ckeyHi))'
        : '(local.get $ckey)';
    return `(local.set $h
          (i32.shr_u (i32.mul ${key} (i32.const ${KNUTH})) (i32.const ${shift})))
        (local.set $slotPtr
          (i32.add (global.get $cacheBase)
            (i32.shl (local.get $h) (i32.const ${strideShift}))))`;
}

function tableHitPred(k){
    if(twoWordKey(k)){
        return `(i32.and (i32.load (local.get $slotPtr))
            (i32.and (i32.eq (i32.load offset=4 (local.get $slotPtr)) (local.get $ckeyLo))
                     (i32.eq (i32.load offset=8 (local.get $slotPtr)) (local.get $ckeyHi))))`;
    }
    return `(i32.and (i32.load (local.get $slotPtr))
            (i32.eq (i32.load offset=4 (local.get $slotPtr)) (local.get $ckey)))`;
}

function tableHitStore(k){
    if(k.storeOp === 'store32'){
        return `(i32.store align=1 (local.get $outputPos)
                (i32.load offset=8 (local.get $slotPtr)))
              (local.set $outputPos
                (i32.add (local.get $outputPos) (local.get $outputStride)))`;
    }
    if(k.storeOp === 'store64'){
        return `(i64.store align=1 (local.get $outputPos)
                (i64.load offset=16 (local.get $slotPtr)))
              (local.set $outputPos
                (i32.add (local.get $outputPos) (local.get $outputStride)))`;
    }
    const off = twoWordKey(k) ? 16 : 8;
    return `(local.set $ci (i32.const 0))
              (loop $cache_copy
                (i32.store8
                  (i32.add (local.get $outputPos) (local.get $ci))
                  (i32.load8_u offset=${off}
                    (i32.add (local.get $slotPtr) (local.get $ci))))
                (local.set $ci (i32.add (local.get $ci) (i32.const 1)))
                (br_if $cache_copy (i32.lt_u (local.get $ci) (local.get $cacheStride))))
              (local.set $outputPos
                (i32.add (local.get $outputPos) (local.get $cacheStride)))`;
}

function tableMissStore(k){
    if(twoWordKey(k)){
        const body = k.kind.startsWith('simd')
            ? `(v128.store64_lane align=1 0
          (i32.add (local.get $slotPtr) (i32.const 16))
          (local.get $vOut))`
            : `(local.set $ci (i32.const 0))
        (loop $cache_save
          (i32.store8 offset=16
            (i32.add (local.get $slotPtr) (local.get $ci))
            (i32.load8_u (i32.add
              (i32.sub (local.get $outputPos) (local.get $cacheStride))
              (local.get $ci))))
          (local.set $ci (i32.add (local.get $ci) (i32.const 1)))
          (br_if $cache_save (i32.lt_u (local.get $ci) (local.get $cacheStride))))`;
        return `(i32.store (local.get $slotPtr) (i32.const 1))
        (i32.store offset=4 (local.get $slotPtr) (local.get $ckeyLo))
        (i32.store offset=8 (local.get $slotPtr) (local.get $ckeyHi))
        ${body}`;
    }
    const body = k.kind.startsWith('simd')
        ? `(v128.store32_lane align=1 0
          (i32.add (local.get $slotPtr) (i32.const 8))
          (local.get $vOut))`
        : `(local.set $ci (i32.const 0))
        (loop $cache_save
          (i32.store8 offset=8
            (i32.add (local.get $slotPtr) (local.get $ci))
            (i32.load8_u (i32.add
              (i32.sub (local.get $outputPos) (local.get $cacheStride))
              (local.get $ci))))
          (local.set $ci (i32.add (local.get $ci) (i32.const 1)))
          (br_if $cache_save (i32.lt_u (local.get $ci) (local.get $cacheStride))))`;
    return `(i32.store (local.get $slotPtr) (i32.const 1))
        (i32.store offset=4 (local.get $slotPtr) (local.get $ckey))
        ${body}`;
}

function addCache(fn, k, opts){
    const stats = !!(opts && opts.stats);
    const table = opts && opts.type === 'table';
    const slots = table ? opts.slots : 0;
    const suffix = table ? '_cached_' + slots : '_cached';
    fn = fn.replace('(func (export "' + k.export + '")',
                    '(func (export "' + k.export + suffix + '")');

    const hitInc = stats
        ? `(global.set $cacheHits (i32.add (global.get $cacheHits) (i32.const 1)))\n              `
        : '';
    const missInc = stats
        ? `(global.set $cacheMisses (i32.add (global.get $cacheMisses) (i32.const 1)))\n        `
        : '';
    const reset = stats
        ? `\n        (global.set $cacheHits (i32.const 0))\n        (global.set $cacheMisses (i32.const 0))`
        : '';

    const locals = table ? tableLocals(k) : localsDecl(k);
    const init = (table ? tableInit(k) : initSnippet(k)) + reset;
    const pred = table ? tableHitPred(k) : hitPred(k);
    const onHit = table ? tableHitStore(k) : hitStore(k);
    const onMiss = table ? tableMissStore(k) : missStore(k);
    const hash = table ? '\n        ' + tableHash(k, slots) : '';

    fn = at(fn, INJECT.localsAfter, '\n' + locals, 'after');
    fn = at(fn, INJECT.initAfter, init, 'after');
    fn = at(fn, INJECT.probeAfter, `

        ;; ---- CACHE PROBE -------------------------------------------------
        ${packKey(k)}${hash}
        (block $skip_work
          (if ${pred}
            (then
              ${hitInc}${onHit}
              (br $skip_work)))`, 'after');
    fn = at(fn, INJECT.storeBefore, `        ;; ---- CACHE STORE -------------------------------------------------
        ${missInc}${onMiss}
        )   ;; end $skip_work

`, 'before');
    return fn;
}

function addModuleGlobals(wat, opts){
    const memory = wat.match(/\(memory \(export "memory"\) \d+\)/);
    if(!memory) throw new Error('memory export not found');
    let extra = '';
    if(opts.stats){
        extra += `
    (global $cacheHits (mut i32) (i32.const 0))
    (global $cacheMisses (mut i32) (i32.const 0))
    (export "cacheHits" (global $cacheHits))
    (export "cacheMisses" (global $cacheMisses))`;
    }
    if(opts.table){
        extra += `
    (global $cacheBase (mut i32) (i32.const 0))
    (export "cacheBase" (global $cacheBase))`;
    }
    return extra ? at(wat, memory[0], extra, 'after') : wat;
}

function kernelForWat(watPath){
    const resolved = path.resolve(watPath);
    for(let i = 0; i < KERNELS.length; i++){
        if(path.resolve(KERNELS[i].src) === resolved) return KERNELS[i];
    }
    return null;
}

/** Verbatim interpolator plus `_cached`. No table exports. */
function injectSingleEntryWat(src, k){
    const start = src.indexOf('(func (export "' + k.export + '")');
    if(start < 0) throw new Error('export not found: ' + k.export);
    const fn = blockAt(src, start);
    const extra = addCache(fn, k, { type: 'single' });
    return src.slice(0, start) + fn + '\n\n' + extra + src.slice(start + fn.length);
}

async function buildOne(k, wabt, opts){
    const stats = !!(opts && opts.stats);
    const tables = normalizeTables(opts);
    const src = fs.readFileSync(k.src, 'utf8');
    const start = src.indexOf('(func (export "' + k.export + '")');
    if(start < 0) throw new Error('export not found: ' + k.export);

    const fn = blockAt(src, start);
    let extra = addCache(fn, k, { stats, type: 'single' });
    for(const n of tables){
        extra += '\n\n' + addCache(fn, k, { stats, type: 'table', slots: n });
    }
    let wat = src.slice(0, start) + fn + '\n\n' + extra + src.slice(start + fn.length);
    wat = addModuleGlobals(wat, { stats, table: tables.length > 0 });

    const needSimd = k.kind.startsWith('simd') || k.key === 'rgb';
    const mod = wabt.parseWat(k.name + '_paired.wat', wat, {
        multi_value: true, mutable_globals: true, simd: needSimd
    });
    const { buffer } = mod.toBinary({});
    mod.destroy();
    const tableExports = {};
    for(const n of tables) tableExports[n] = k.export + '_cached_' + n;
    return {
        name: k.name,
        export: k.export,
        cachedExport: k.export + '_cached',
        tableExports,
        tables,
        stride: tableStride(k),
        kind: k.kind,
        stats,
        wat,
        bytes: Buffer.from(buffer)
    };
}

async function buildAll(opts){
    const write = !opts || opts.write !== false;
    const stats = !!(opts && opts.stats);
    const tables = normalizeTables(opts);
    const wabt = await require('wabt')();
    const out = {};
    for(const k of KERNELS){
        const built = await buildOne(k, wabt, { stats, tables });
        if(write){
            fs.writeFileSync(path.join(OUT, k.name + '_paired.wat'), built.wat);
            fs.writeFileSync(path.join(OUT, k.name + '_paired.wasm'), built.bytes);
        }
        out[k.name] = built;
        if(!opts || opts.log !== false){
            const names = [k.export, k.export + '_cached']
                .concat(tables.map((n) => k.export + '_cached_' + n));
            console.log(k.name + '_paired.wasm  ' + built.bytes.length + ' bytes  ' +
                        '(' + names.length + ' exports: ' + names.join(', ') +
                        (stats ? ', cacheHits, cacheMisses' : '') + ')');
        }
    }
    return out;
}

function parseCliTables(){
    const h = process.argv.find((a) => a.startsWith('--tables='));
    if(!h) return [];
    return h.slice(9).split(',').map((s) => parseInt(s, 10));
}

module.exports = {
    KERNELS, INJECT, KNUTH, tableStride, normalizeTables,
    addCache, injectSingleEntryWat, kernelForWat,
    buildOne, buildAll, blockAt, at
};

if(require.main === module){
    buildAll({
        stats: process.argv.includes('--stats'),
        tables: parseCliTables()
    }).catch((e) => { console.error(e.message || e); process.exit(1); });
}
