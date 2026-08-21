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
 * STEP 3 OF THE WASM PIXEL-CACHE POC — does it actually pay?
 *
 *   node bench/pixel_cache_wasm/build.js && node bench/pixel_cache_wasm/run.js
 *
 * Two questions, and they are separate:
 *
 *   THE TOGGLE TAX.  `off` is the cached module with cacheMode = 0, against
 *   `baseline`, the shipped module with no cache code in it at all. The branch
 *   will predict — that is not in doubt. What is in doubt is whether its
 *   presence costs anything in unrolling or register allocation inside a tight
 *   scalar loop. If the tax is ~0, one block of code can serve every scalar
 *   kernel with a runtime toggle, and no variant needs forking.
 *
 *   THE WIN.  `last` and `hash-N` against `baseline`, across content that
 *   spans 0.8% to 89% distinct colours. A cache that helps a poster and hurts
 *   a beach photo is not a default.
 *
 * Every configuration's output is compared byte-for-byte against the shipped
 * kernel's. A cache that changes pixels is not a cache.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Transform, eIntent } = require('../../src/main.js');

const CORPUS = path.join(__dirname, '..', 'release_matrix', 'corpus');

const argv = process.argv.slice(2);
const arg  = (n, d) => { const h = argv.find(a => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const REPS = parseInt(arg('reps', '7'), 10);
const FROM = arg('from', '*prophoto'), TO = arg('to', '*sRGB');

const now = () => Number(process.hrtime.bigint()) / 1e6;
const median = xs => { const s = xs.slice().sort((a,b)=>a-b); const m = s.length>>1;
                       return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; };
const align = (n, a) => (n + a - 1) & ~(a - 1);

// ---- content -------------------------------------------------------------
function noise(npx){
    const a = new Uint8ClampedArray(npx * 3);
    let s = 0x13579bdf;
    for(let i = 0; i < a.length; i++){
        s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
        a[i] = (s >>> 23) & 0xff;            // bits 23-30, never the low byte
    }
    return a;
}
function solid(npx){
    const a = new Uint8ClampedArray(npx * 3);
    for(let p = 0; p < npx; p++){ a[p*3] = 91; a[p*3+1] = 140; a[p*3+2] = 37; }
    return a;
}
function frames(){
    let files = [];
    try { files = fs.readdirSync(CORPUS).filter(f => f.endsWith('.rgb.bin')).sort(); } catch(e){}
    return files.map(f => {
        const src = fs.readFileSync(path.join(CORPUS, f));
        const a = new Uint8ClampedArray(src.length - (src.length % 3));
        a.set(src.subarray(0, a.length));
        const tag = f.split(/[-_.]/).filter(w => w === w.toUpperCase() && w.length > 3)[0] || f.slice(0,8);
        return { name: tag, data: a, px: a.length / 3 };
    });
}

// ---- the LUT -------------------------------------------------------------
// A real one, from a real profile pair, through the engine's own builder —
// the kernel is fed exactly what it is fed in production.
const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: (argv.indexOf('--scalar') < 0 ? 'int-wasm-simd' : 'int-wasm-scalar'),
                         wasmMatrixShaper: false});
t.create(FROM, TO, eIntent.relative);
const intLut = t.lut.intLut;
if(!intLut) throw new Error('no intLut — lutMode did not resolve to an integer path');
const cMax = t.lut.outputChannels;

// ---- modules -------------------------------------------------------------
const SIMD = argv.indexOf('--scalar') < 0;
const baselineBytes = SIMD
    ? require('../../src/kernels/3d/tetra3d_simd.wasm.js')
    : require('../../src/kernels/3d/tetra3d_nch.wasm.js');
const cachedBytes = fs.readFileSync(path.join(__dirname,
    SIMD ? 'tetra3d_simd_cache.wasm' : 'tetra3d_cache.wasm'));
const BASE_EXPORT   = SIMD ? 'interp_tetra3d_simd'        : 'interp_tetra3d_nCh';
const CACHED_EXPORT = SIMD ? 'interp_tetra3d_simd_cached' : 'interp_tetra3d_nCh_cached';

function instantiate(bytes, name){
    const mod = new WebAssembly.Module(bytes);
    const inst = new WebAssembly.Instance(mod, {});
    const fn = inst.exports[name];
    if(typeof fn !== 'function') throw new Error('missing export ' + name);
    return { memory: inst.exports.memory, fn: fn };
}
const baseline = instantiate(baselineBytes, BASE_EXPORT);
const cached   = instantiate(cachedBytes,   CACHED_EXPORT);

const MAX_ENTRIES = 4096;

/** Lay out LUT / cache / input / output in one instance's linear memory. */
function layout(state, npx){
    const lutBytes   = intLut.CLUT.length * 2;
    const lutPtr     = 0;
    const cachePtr   = align(lutPtr + lutBytes, 64);
    const inputPtr   = align(cachePtr + MAX_ENTRIES * 8, 64);
    const outputPtr  = align(inputPtr + npx * 3, 64);
    const need       = outputPtr + npx * cMax + 64;   // +64 covers the SIMD kernel's spare byte
    const have       = state.memory.buffer.byteLength;
    if(need > have) state.memory.grow(Math.ceil((need - have) / 65536));
    new Uint16Array(state.memory.buffer, lutPtr, intLut.CLUT.length).set(intLut.CLUT);
    return { lutPtr, cachePtr, inputPtr, outputPtr };
}

const CONFIGS = [
    { label: 'baseline',  state: baseline, mode: null, entries: 0 },
    { label: 'off',       state: cached,   mode: 0,    entries: 0 },
    { label: 'last-v128', state: cached,   mode: 1,    entries: 0 },
    { label: 'last-i32',  state: cached,   mode: 3,    entries: 0 },
    { label: 'hash8',     state: cached,   mode: 2,    entries: 8 },
    { label: 'hash16',    state: cached,   mode: 2,    entries: 16 },
    { label: 'hash32',    state: cached,   mode: 2,    entries: 32 },
    { label: 'hash64',    state: cached,   mode: 2,    entries: 64 },
    { label: 'hash256',   state: cached,   mode: 2,    entries: 256 },
    { label: 'hash1024',  state: cached,   mode: 2,    entries: 1024 },
    { label: 'hash4096',  state: cached,   mode: 2,    entries: 4096 }
];

function runOnce(cfg, ptrs, npx){
    const s = cfg.state;
    if(cfg.mode === 2){
        // Clear the table between runs: a warm table from the previous
        // repetition would flatter the first pixels of this one.
        new Int32Array(s.memory.buffer, ptrs.cachePtr, cfg.entries * 2).fill(-1);
    }
    const args = [ptrs.inputPtr, ptrs.outputPtr, ptrs.lutPtr, npx, cMax,
                  intLut.go0, intLut.go1, intLut.go2,
                  intLut.gridPointsScale_fixed,
                  intLut.maxX, intLut.maxY, intLut.maxZ,
                  0, 0];
    if(cfg.mode !== null){
        const shift = cfg.entries ? 32 - Math.log2(cfg.entries) : 0;
        args.push(cfg.mode, ptrs.cachePtr, shift, Math.max(0, cfg.entries - 1));
    }
    s.fn.apply(null, args);
}

function logoBlock(npx, markFraction){
    const a = new Uint8ClampedArray(npx * 3);
    for(let p = 0; p < npx; p++){ a[p*3] = 255; a[p*3+1] = 255; a[p*3+2] = 255; }
    const mark = Math.floor(npx * markFraction);
    const start = Math.floor((npx - mark) / 2);
    for(let p = start; p < start + mark; p++){ a[p*3] = 200; a[p*3+1] = 30; a[p*3+2] = 40; }
    return a;
}
const N1 = 1 << 20;
const CONTENT = [
    {name: 'solid', data: solid(N1), px: N1},
    {name: 'logo30', data: logoBlock(N1, 0.30), px: N1}
].concat(frames())
 .concat([{name: 'noise', data: noise(N1), px: N1}]);

console.log('WASM PIXEL CACHE — tetra3d scalar, ' + FROM + ' -> ' + TO +
            ', ' + cMax + ' output channels, best of ' + REPS + ', MPx/s\n');
console.log('config    ' + CONTENT.map(c => c.name.slice(0,9).padStart(10)).join(''));

const results = {};
for(const cfg of CONFIGS){
    let line = '  ' + cfg.label.padEnd(9);
    results[cfg.label] = {};
    for(const content of CONTENT){
        const ptrs = layout(cfg.state, content.px);
        new Uint8Array(cfg.state.memory.buffer, ptrs.inputPtr, content.px * 3)
            .set(content.data.subarray(0, content.px * 3));

        runOnce(cfg, ptrs, content.px);                 // warm
        const got = new Uint8Array(
            cfg.state.memory.buffer.slice(ptrs.outputPtr, ptrs.outputPtr + content.px * cMax));

        let best = Infinity;
        for(let r = 0; r < REPS; r++){
            const t0 = now();
            runOnce(cfg, ptrs, content.px);
            best = Math.min(best, now() - t0);
        }
        const mpxs = content.px / (best / 1000) / 1e6;
        results[cfg.label][content.name] = mpxs;

        // Correctness against the shipped kernel, every cell.
        if(cfg.label === 'baseline'){
            content.expected = got;
        } else {
            let differing = 0;
            for(let i = 0; i < got.length; i++) if(got[i] !== content.expected[i]) differing++;
            if(differing){ line += ('DIFF' + differing).padStart(10); continue; }
        }
        line += mpxs.toFixed(1).padStart(10);
    }
    console.log(line);
}

console.log('\nRATIO vs baseline');
console.log('config    ' + CONTENT.map(c => c.name.slice(0,9).padStart(10)).join(''));
for(const cfg of CONFIGS){
    if(cfg.label === 'baseline') continue;
    let line = '  ' + cfg.label.padEnd(9);
    for(const content of CONTENT){
        const r = results[cfg.label][content.name] / results.baseline[content.name];
        line += (r.toFixed(3) + 'x').padStart(10);
    }
    console.log(line);
}
