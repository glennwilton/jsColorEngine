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
 * The matrix-shaper kernel across cores: WASM SIMD against plain JS.
 *
 *   node --max-old-space-size=8192 bench/matrix_shaper_kernel/multicore_js.js
 *
 * THE SLOWER KERNEL SHOULD SCALE BETTER, and the reason is the same one that
 * made the fast kernel scale worse than the CLUT: the pool's per-fragment cost
 * is fixed per pixel and does not parallelise, so Amdahl's serial fraction is
 * overhead / (overhead + kernel time). JS makes the denominator ~3.7x larger
 * without touching the numerator, so its efficiency should be HIGHER while its
 * wall clock stays worse. Efficiency is a ratio against a moving baseline; it
 * is not a measure of which one to use.
 *
 * Worth measuring rather than asserting, because it says how much of the WASM
 * advantage survives the pool — if enough of it evaporated, a WASM-free build
 * would be a reasonable option rather than a fallback.
 *
 * WORKERS ARE PINNED BY ENV, not by useVariant(): a worker is a separate module
 * instance in a separate thread, so a call on the main thread does not reach
 * it. process.env is inherited at spawn, so the pool is torn down and respawned
 * between arms.
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const { Transform, eIntent } = require('../../src/main.js');
const matrixShaper = require('../../src/kernels/3d/matrixShaper/matrixShaperKernel.js');
const pool = require('../../src/pool.js');

const CORPUS = path.join(__dirname, '..', 'release_matrix', 'corpus');
const argv = process.argv.slice(2);
const arg  = (n,d) => { const h = argv.find(a=>a.startsWith('--'+n+'=')); return h ? h.slice(n.length+3) : d; };

const PX    = parseInt(arg('px', '4000000'), 10);
const RUNS  = parseInt(arg('runs', '5'), 10);
const MAXW  = parseInt(arg('workers', '8'), 10);
const BITS  = parseInt(arg('bits', '8'), 10);
const PAIR  = [arg('from', '*prophoto'), arg('to', '*sRGB')];

const now = () => Number(process.hrtime.bigint()) / 1e6;
const median = xs => { const s = xs.slice().sort((a,b)=>a-b); const m = s.length>>1;
                       return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; };

function photo(npx){
    const Arr = BITS === 8 ? Uint8ClampedArray : Uint16Array;
    const shift = BITS === 8 ? 0 : 8;
    const files = fs.readdirSync(CORPUS).filter(f => f.endsWith('.rgb.bin')).sort();
    if(!files.length) throw new Error('no photo corpus — run bench/release_matrix/make_corpus.cjs');
    const src  = Buffer.concat(files.map(f => fs.readFileSync(path.join(CORPUS, f))));
    const have = (src.length / 3) | 0;
    const a = new Arr(npx * 3);
    for(let p = 0; p < npx; p++){
        const q = (p % have) * 3;
        a[p*3] = src[q] << shift; a[p*3+1] = src[q+1] << shift; a[p*3+2] = src[q+2] << shift;
    }
    return { data: a, pixelCount: npx };
}

async function main(){
    const img = photo(PX);
    const mpx = PX / 1e6;
    const Arr = BITS === 8 ? Uint8ClampedArray : Uint16Array;

    console.log('photo   int' + BITS + '   ' + PAIR.join(' -> ') + '   ' +
                mpx.toFixed(1) + ' MPx   median of ' + RUNS + '\n');

    const results = {};
    for(const variant of ['simd', 'js']){
        // Pin BOTH sides: env for the workers (read when their module loads),
        // useVariant for this thread's sequential baseline.
        process.env.JSCE_MATRIX_SHAPER_VARIANT = variant;
        pool.destroyAll();                       // force a respawn with the new env
        matrixShaper.useVariant(variant);

        const t = new Transform({dataFormat: 'int' + BITS, buildLut: false});
        t.create(PAIR[0], PAIR[1], eIntent.relative);

        const out = new Arr(PX * 3);
        for(let i = 0; i < 2; i++) t.transformArray(img.data, false, false, false, PX, undefined, out);
        const seqTimes = [];
        for(let i = 0; i < RUNS; i++){
            const t0 = now();
            t.transformArray(img.data, false, false, false, PX, undefined, out);
            seqTimes.push(now() - t0);
        }
        const seq = median(seqTimes);
        const expected = t.transformArray(img.data, false, false, false, PX).slice();
        const actual = t.kernelInfo().variant;

        console.log('=== ' + variant.toUpperCase() + '  (kernel reports "' + actual + '")   ' +
                    'sequential ' + (mpx/(seq/1000)).toFixed(1) + ' MPx/s ===');
        console.log(' w |     MPx/s   speedup    eff   bytes');

        results[variant] = { seq: seq, rows: {} };
        for(let w = 1; w <= MAXW; w++){
            const opts = { multicore: {cores: w, minThreads: 1, maxThreads: w} };
            pool.destroyAll();
            await t.transformImages([img], opts);
            await t.transformImages([img], opts);

            const times = [];
            let res = null;
            for(let i = 0; i < RUNS; i++){
                const t0 = now();
                res = await t.transformImages([img], opts);
                times.push(now() - t0);
            }
            const ms = median(times);
            let differing = 0;
            for(let i = 0; i < expected.length; i++) if(res.images[0][i] !== expected[i]) differing++;

            results[variant].rows[w] = mpx / (ms/1000);
            console.log(String(w).padStart(2) + ' | ' +
                (mpx/(ms/1000)).toFixed(1).padStart(9) +
                (seq/ms).toFixed(2).padStart(9) + 'x' +
                (100*(seq/ms)/w).toFixed(0).padStart(6) + '%' +
                (differing ? ('  *** ' + differing + ' DIFFER ***') : '       0'));
        }
        console.log('');
    }

    delete process.env.JSCE_MATRIX_SHAPER_VARIANT;
    matrixShaper.useVariant(null);
    pool.destroyAll();

    console.log('WASM ADVANTAGE, by worker count');
    console.log(' w | sequential' + Array.from({length: MAXW}, (_,i)=>String(i+1).padStart(7)).join(''));
    let line = '   | ' + (results.js.seq / results.simd.seq).toFixed(2) + 'x     ';
    for(let w = 1; w <= MAXW; w++){
        line += ((results.simd.rows[w] / results.js.rows[w]).toFixed(2) + 'x').padStart(7);
    }
    console.log(line);
    console.log('\nIf that row falls with worker count, the pool is closing the gap —');
    console.log('the faster kernel is the one the fixed per-fragment cost hurts most.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
