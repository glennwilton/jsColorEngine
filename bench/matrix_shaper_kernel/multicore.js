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
 * Does the matrix-shaper kernel scale in the pool as well as the CLUT does?
 *
 * IT SHOULD NOT, AND THE REASON IS ARITHMETIC. The per-fragment cost the pool
 * pays — copy in, post, copy out — is fixed per pixel and does not parallelise.
 * Amdahl says efficiency at N workers depends on that serial fraction, and the
 * fraction is (fixed overhead) / (fixed overhead + kernel time). The kernel is
 * 2.7-3.1x faster than the CLUT single-threaded, so it SHRINKS the denominator
 * without touching the numerator: the same absolute overhead becomes a larger
 * share of a smaller total. The faster path should therefore show the LOWER
 * parallel efficiency while still finishing first, which is the distinction
 * this bench exists to keep straight — speedup ratios and wall clock disagree
 * here, and only one of them is what a caller waits for.
 *
 * THE TWO PATHS ARE INTERLEAVED, not run in blocks. A blocked design confounds
 * the arm with the time: thermal drift, another process waking up, or the JIT
 * settling all land on whichever arm ran second. Every repetition times CLUT
 * then kernel back to back, so drift hits both.
 *
 * The baseline for each path is ITS OWN sequential transformArray(), not the
 * 1-worker pool and not the other path's baseline. Speedup answers "what did
 * the pool buy this path"; the MPx/s columns answer "which one is faster".
 *
 * USAGE
 *   node bench/matrix_shaper_kernel/multicore.js
 *   node bench/matrix_shaper_kernel/multicore.js --px=8000000 --runs=7
 *   node bench/matrix_shaper_kernel/multicore.js --content=photo
 */
'use strict';

const path = require('path');
const fs   = require('fs');

const { Transform, eIntent } = require('../../src/main.js');
const pool = require('../../src/pool.js');
const emit = require('../lib/emit.cjs');   // no-op unless JSCE_BENCH_JSON is set

const CORPUS_DIR = path.join(__dirname, '..', 'release_matrix', 'corpus');

const argv = process.argv.slice(2);
const arg  = (name, dflt) => {
    const hit = argv.find(a => a.startsWith('--' + name + '='));
    return hit ? hit.slice(name.length + 3) : dflt;
};

const PX          = parseInt(arg('px', '4000000'), 10);
const RUNS        = parseInt(arg('runs', '5'), 10);
const MAX_WORKERS = parseInt(arg('workers', '8'), 10);
const CONTENTS    = (arg('content', 'noise,photo')).split(',');
const PAIR        = [arg('from', '*prophoto'), arg('to', '*sRGB')];

// ---- content ------------------------------------------------------------
// Same generators as bench/multicore_matrix/run.js. The PRNG takes bits 23-30,
// NOT the low byte: an LCG's low bits have a period of 256, which once made
// "noise" a solid-colour test in disguise.
function genNoise(buf){
    let seed = 0x13579bdf;
    for(let i = 0; i < buf.length; i++){
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        buf[i] = (seed >>> 23) & 0xff;
    }
}

function genPhoto(buf, npx){
    const files = fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith('.rgb.bin')).sort();
    if(!files.length) throw new Error('no photo corpus — run: node bench/release_matrix/make_corpus.cjs');
    const src  = Buffer.concat(files.map(f => fs.readFileSync(path.join(CORPUS_DIR, f))));
    const have = (src.length / 3) | 0;
    for(let p = 0; p < npx; p++){
        const s = (p % have) * 3;
        buf[p*3] = src[s]; buf[p*3+1] = src[s+1]; buf[p*3+2] = src[s+2];
    }
}

function makeImage(kind, npx){
    const buf = new Uint8ClampedArray(npx * 3);
    if(kind === 'noise') genNoise(buf);
    else if(kind === 'photo') genPhoto(buf, npx);
    else throw new Error('unknown content ' + kind);
    return { data: buf, pixelCount: npx };
}

// ---- timing -------------------------------------------------------------
const now = () => Number(process.hrtime.bigint()) / 1e6;
const median = xs => {
    const s = xs.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
};

/** The two paths under test. Both int8, same profile pair, same output. */
const PATHS = {
    clut: () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, wasmMatrixShaper: false});
        t.create(PAIR[0], PAIR[1], eIntent.relative);
        return t;
    },
    kernel: () => {
        const t = new Transform({dataFormat: 'int8', buildLut: false});
        t.create(PAIR[0], PAIR[1], eIntent.relative);
        return t;
    }
};

async function main(){
    for(const content of CONTENTS){
        const img = makeImage(content, PX);
        const mpx = PX / 1e6;

        const t = { clut: PATHS.clut(), kernel: PATHS.kernel() };

        // ---- sequential baselines, interleaved ---------------------------
        // The output buffer is REUSED, because the pool reuses its scratch
        // buffers. Letting the baseline allocate 12 MB per call and the pool
        // not would credit the pool with avoiding an allocation the caller
        // could avoid anyway, and inflated every speedup below by ~1.3x when
        // this bench was first written.
        const out = new Uint8ClampedArray(PX * 3);
        for(const k of ['clut', 'kernel'])
            for(let i = 0; i < 2; i++) t[k].transformArray(img.data, false, false, false, img.pixelCount, undefined, out);

        const seqTimes = { clut: [], kernel: [] };
        for(let i = 0; i < RUNS; i++){
            for(const k of ['clut', 'kernel']){
                const t0 = now();
                t[k].transformArray(img.data, false, false, false, img.pixelCount, undefined, out);
                seqTimes[k].push(now() - t0);
            }
        }
        const seq = { clut: median(seqTimes.clut), kernel: median(seqTimes.kernel) };

        // Same bytes out of both paths, or none of the rest means anything.
        const refClut   = t.clut.transformArray(img.data, false, false, false, img.pixelCount).slice();
        const refKernel = t.kernel.transformArray(img.data, false, false, false, img.pixelCount).slice();
        let maxDiff = 0;
        for(let i = 0; i < refClut.length; i++){
            const d = Math.abs(refClut[i] - refKernel[i]);
            if(d > maxDiff) maxDiff = d;
        }

        const rows = [];
        console.log('\n=== ' + content + '   ' + PAIR.join(' -> ') +
                    '   ' + mpx.toFixed(1) + ' MPx   median of ' + RUNS + ' ===');
        console.log('sequential:  CLUT ' + (mpx/(seq.clut/1000)).toFixed(1) + ' MPx/s' +
                    '   kernel ' + (mpx/(seq.kernel/1000)).toFixed(1) + ' MPx/s' +
                    '   (kernel is ' + (seq.clut/seq.kernel).toFixed(2) + 'x)' +
                    '   CLUT vs kernel max diff ' + maxDiff + ' LSB');
        console.log('');
        console.log(' w |      CLUT MPx/s  speedup   eff |    kernel MPx/s  speedup   eff | kernel/CLUT');
        console.log('---+------------------------------- +--------------------------------+------------');

        for(let w = 1; w <= MAX_WORKERS; w++){
            const opts = { multicore: { cores: w, minThreads: 1, maxThreads: w } };
            pool.destroyAll();                       // each count gets a clean pool

            // Warm: spawn, register, ship the LUT or the profile chain.
            for(const k of ['clut', 'kernel']){
                await t[k].transformImages([img], opts);
                await t[k].transformImages([img], opts);
            }

            const times = { clut: [], kernel: [] };
            let used = 0, wrong = 0;
            for(let i = 0; i < RUNS; i++){
                for(const k of ['clut', 'kernel']){
                    const t0 = now();
                    const r = await t[k].transformImages([img], opts);
                    times[k].push(now() - t0);
                    used = r.workersUsed;
                    const ref = k === 'clut' ? refClut : refKernel;
                    if(i === 0){
                        const got = r.images[0];
                        for(let j = 0; j < ref.length; j++) if(got[j] !== ref[j]) { wrong++; break; }
                    }
                }
            }

            const m  = { clut: median(times.clut), kernel: median(times.kernel) };
            const sp = { clut: seq.clut / m.clut, kernel: seq.kernel / m.kernel };
            const th = { clut: mpx / (m.clut/1000), kernel: mpx / (m.kernel/1000) };

            console.log(
                String(w).padStart(2) + ' | ' +
                th.clut.toFixed(1).padStart(14) + '  ' + sp.clut.toFixed(2).padStart(6) + 'x  ' +
                (100*sp.clut/w).toFixed(0).padStart(3) + '% | ' +
                th.kernel.toFixed(1).padStart(14) + '  ' + sp.kernel.toFixed(2).padStart(6) + 'x  ' +
                (100*sp.kernel/w).toFixed(0).padStart(3) + '% | ' +
                (th.kernel/th.clut).toFixed(2).padStart(6) + 'x' +
                (wrong ? '   *** OUTPUT MISMATCH ***' : '') +
                (used !== w ? '   (used ' + used + ')' : ''));

            rows.push({
                workers:        w,
                clutMpxs:       +th.clut.toFixed(1),
                clutSpeedup:    +sp.clut.toFixed(2),
                clutEffPct:     Math.round(100 * sp.clut / w),
                kernelMpxs:     +th.kernel.toFixed(1),
                kernelSpeedup:  +sp.kernel.toFixed(2),
                kernelEffPct:   Math.round(100 * sp.kernel / w),
                kernelOverClut: +(th.kernel / th.clut).toFixed(2),
                exact:          wrong === 0,
            });
        }

        // The sequential baselines belong in the table too — the whole finding
        // is that the ratio SHRINKS as workers are added, which cannot be read
        // without the one-thread row to compare against.
        emit.table({
            id:      'pool.matrixShaper.' + content,
            title:   'Matrix-shaper kernel vs CLUT in the worker pool — ' + content,
            units:   'MPx/s',
            meta:    { content: content, pair: PAIR, pixels: PX, runs: RUNS,
                       sequentialClutMpxs: +(mpx / (seq.clut / 1000)).toFixed(1),
                       sequentialKernelMpxs: +(mpx / (seq.kernel / 1000)).toFixed(1),
                       maxKernelVsClutLsb: maxDiff },
            columns: ['workers', 'clutMpxs', 'clutSpeedup', 'clutEffPct',
                      'kernelMpxs', 'kernelSpeedup', 'kernelEffPct',
                      'kernelOverClut', 'exact'],
            rows:    rows,
        });

        pool.destroyAll();
    }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
