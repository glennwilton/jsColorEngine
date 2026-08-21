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
 * STEP 1 OF THE WASM PIXEL-CACHE POC — hit rate, and nothing else.
 *
 *   node bench/pixel_cache_wasm/hitrate.js
 *
 * HIT RATE IS A PROPERTY OF THE IMAGE, NOT OF THE KERNEL. It does not depend
 * on WASM, on scalar vs SIMD, or on how the cache is written — so it is
 * answerable in plain JS in seconds, and it gates everything else. If a
 * 16-entry cache gets 3% on a photograph, no amount of WAT tuning rescues it,
 * and the throughput POC never gets written.
 *
 * The break-even it has to clear is not fixed either. From the 4D POC, roughly
 * a 10% hit rate; but a 4D tetrahedral pixel is ~40 instructions and eight
 * corner loads, a 3D one fewer, and the matrix-shaper kernel about ten — so the
 * cheaper the kernel, the higher the hit rate has to be to pay for the probe.
 * The cache is worth least exactly where the kernel is best.
 *
 * POLICIES
 *
 *   last          lcms's cache: compare against the previous pixel only. One
 *                 3-byte compare, no memory, no hashing — this is the one that
 *                 could live in registers and be on by default.
 *   direct-N      N-entry direct-mapped hash table. A hit needs the stored key
 *                 to match, so a collision is a miss plus an eviction.
 *
 * Two hash functions, because a bad one would be indistinguishable from "the
 * idea does not work":
 *
 *   mul   Knuth multiplicative on the packed 24-bit colour — good mixing, one
 *         multiply and a shift.
 *   fold  cheap byte fold, closer to what a scalar WASM loop would want to pay.
 */
'use strict';

const path = require('path');
const fs   = require('fs');

const CORPUS = path.join(__dirname, '..', 'release_matrix', 'corpus');

const argv = process.argv.slice(2);
const arg  = (n, d) => { const h = argv.find(a => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const PX = parseInt(arg('px', '4194304'), 10);

// ---- content -------------------------------------------------------------
// Same generators as the other benches. Bits 23-30 of the LCG, never the low
// byte — that mistake made "noise" a solid-colour test twice already.
function noise(npx){
    const a = new Uint8ClampedArray(npx * 3);
    let s = 0x13579bdf;
    for(let i = 0; i < a.length; i++){
        s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
        a[i] = (s >>> 23) & 0xff;
    }
    return a;
}
function solid(npx){
    const a = new Uint8ClampedArray(npx * 3);
    for(let p = 0; p < npx; p++){ a[p*3] = 91; a[p*3+1] = 140; a[p*3+2] = 37; }
    return a;
}
function photo(npx){
    let files = [];
    try { files = fs.readdirSync(CORPUS).filter(f => f.endsWith('.rgb.bin')).sort(); } catch(e){}
    if(!files.length) return null;
    const src  = Buffer.concat(files.map(f => fs.readFileSync(path.join(CORPUS, f))));
    const have = (src.length / 3) | 0;
    const a = new Uint8ClampedArray(npx * 3);
    for(let p = 0; p < npx; p++){
        const q = (p % have) * 3;
        a[p*3] = src[q]; a[p*3+1] = src[q+1]; a[p*3+2] = src[q+2];
    }
    return a;
}
/**
 * EVERY frame in the corpus, separately, at its own size.
 *
 * Not one frame and not the tiled concatenation: the corpus spans 0.8% to
 * 30.7% distinct colours, a 38x range, so any single frame is a claim about
 * that frame. The first draft of this bench quoted the 0.8% one — the most
 * cache-friendly image in the set — which would have made the cache look
 * roughly twice as good as it is.
 */
function photoFrames(){
    let files = [];
    try { files = fs.readdirSync(CORPUS).filter(f => f.endsWith('.rgb.bin')).sort(); } catch(e){}
    return files.map(f => {
        const src = fs.readFileSync(path.join(CORPUS, f));
        const a = new Uint8ClampedArray(src.length - (src.length % 3));
        a.set(src.subarray(0, a.length));
        return [f.split(/[-_.]/).filter(w => w === w.toUpperCase() && w.length > 3)[0] ||
                f.slice(0, 10), a];
    });
}

// ---- policies ------------------------------------------------------------
function lastPixel(px, npx){
    let hits = 0, pr = -1, pg = -1, pb = -1;
    for(let p = 0; p < npx; p++){
        const r = px[p*3], g = px[p*3+1], b = px[p*3+2];
        if(r === pr && g === pg && b === pb) hits++;
        else { pr = r; pg = g; pb = b; }
    }
    return hits / npx;
}

const HASHES = {
    // Knuth multiplicative on the packed colour, then take the top bits.
    mul: (key, shift) => (Math.imul(key, 2654435761) >>> shift),
    // Cheap fold: what a scalar loop would rather pay for.
    fold: (key, shift) => (((key >>> 16) ^ (key >>> 8) ^ key) & 0xff) >>> 0
};

function directMapped(px, npx, entries, hashName){
    const shift = 32 - Math.log2(entries);
    const mask  = entries - 1;
    const keys  = new Int32Array(entries).fill(-1);
    const hash  = HASHES[hashName];
    let hits = 0;
    for(let p = 0; p < npx; p++){
        const key = (px[p*3] << 16) | (px[p*3+1] << 8) | px[p*3+2];
        const slot = (hashName === 'mul' ? hash(key, shift) : hash(key, 0) & mask) & mask;
        if(keys[slot] === key) hits++;
        else keys[slot] = key;          // a collision is a miss AND an eviction
    }
    return hits / npx;
}

/** How many distinct colours are actually in there — the ceiling on locality. */
function distinct(px, npx){
    const seen = new Set();
    for(let p = 0; p < npx; p++) seen.add((px[p*3] << 16) | (px[p*3+1] << 8) | px[p*3+2]);
    return seen.size;
}

// ---- report --------------------------------------------------------------
const CONTENT = [
    ['solid',       solid(PX)],
    ['photo tiled', photo(PX)]
].concat(photoFrames().map(([n, a]) => ['  ' + n, a]))
 .concat([['noise', noise(PX)]]);

const SIZES = [16, 64, 256, 1024, 4096];

console.log('HIT RATE — ' + (PX / 1e6).toFixed(1) + ' MPx unless noted\n');
console.log('content        pixels  distinct    last' +
            SIZES.map(n => ('mul' + n).padStart(8)).join('') +
            '');

for(const [label, px] of CONTENT){
    if(!px){ console.log('  ' + label.padEnd(13) + ' (no corpus — run bench/release_matrix/make_corpus.cjs)'); continue; }
    const npx = px.length / 3;
    const d = distinct(px, npx);
    let line = '  ' + label.padEnd(12) +
        (npx / 1e6).toFixed(2).padStart(7) + 'M' +
        d.toLocaleString().padStart(10) +
        (100 * lastPixel(px, npx)).toFixed(1).padStart(8) + '%';
    for(const n of SIZES) line += (100 * directMapped(px, npx, n, 'mul')).toFixed(1).padStart(7) + '%';
    
    console.log(line);
}

console.log('\nA hit must beat the probe it cost: a hash, a load, a compare, and');
console.log('on a miss a store. Break-even was ~10% on the 4D kernel; it is higher');
console.log('on 3D and higher again on the matrix shaper.');
