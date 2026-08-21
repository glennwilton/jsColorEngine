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
 * Where does the pool's overhead go, and would a different fragment size move
 * it?
 *
 * Two questions, because they have different answers and get confused:
 *
 *   1. FRAGMENT SIZE is a load-balance knob. Smaller fragments balance better
 *      and cost more messages; larger ones the reverse. It should barely touch
 *      total throughput, because the dominant cost is O(bytes) not O(fragments)
 *      — but "should" is why this file exists.
 *
 *   2. THE SERIAL FRACTION is what actually caps parallel speedup. Fit
 *      T(w) = S + P/w to the measured times and S falls out. If S matches the
 *      cost of memcpy'ing the image twice, the overhead is the copies and no
 *      amount of scheduling will fix it — only not copying will.
 *
 * The kernel is the interesting subject for both: it made the parallel term
 * ~3x smaller without touching the serial one, so it is where any remaining
 * overhead shows up first.
 *
 * USAGE
 *   node --max-old-space-size=8192 bench/matrix_shaper_kernel/overhead.js
 *   node bench/matrix_shaper_kernel/overhead.js --px=8000000 --workers=8
 */
'use strict';

const path = require('path');
const fs   = require('fs');

const { Transform, eIntent } = require('../../src/main.js');
const pool = require('../../src/pool.js');

const CORPUS_DIR = path.join(__dirname, '..', 'release_matrix', 'corpus');

const argv = process.argv.slice(2);
const arg  = (n, d) => { const h = argv.find(a => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };

const PX      = parseInt(arg('px', '4000000'), 10);
const RUNS    = parseInt(arg('runs', '5'), 10);
const WORKERS = parseInt(arg('workers', '8'), 10);
const PAIR    = [arg('from', '*prophoto'), arg('to', '*sRGB')];
// Each section costs minutes, and they answer different questions. --sections
// lets one be re-run without the others.
const SECTIONS = (arg('sections', '1,2,3')).split(',').map(Number);

const now = () => Number(process.hrtime.bigint()) / 1e6;
const median = xs => { const s = xs.slice().sort((a,b) => a-b); const m = s.length >> 1;
                       return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };

function photo(npx){
    const buf = new Uint8ClampedArray(npx * 3);
    const files = fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith('.rgb.bin')).sort();
    if(!files.length) throw new Error('no photo corpus — run: node bench/release_matrix/make_corpus.cjs');
    const src  = Buffer.concat(files.map(f => fs.readFileSync(path.join(CORPUS_DIR, f))));
    const have = (src.length / 3) | 0;
    for(let p = 0; p < npx; p++){
        const s = (p % have) * 3;
        buf[p*3] = src[s]; buf[p*3+1] = src[s+1]; buf[p*3+2] = src[s+2];
    }
    return { data: buf, pixelCount: npx };
}

function makeTransform(kind){
    const t = kind === 'clut'
        ? new Transform({dataFormat: 'int8', buildLut: true, wasmMatrixShaper: false})
        : new Transform({dataFormat: 'int8', buildLut: false});
    t.create(PAIR[0], PAIR[1], eIntent.relative);
    return t;
}

/**
 * Formats chosen for their BYTES PER PIXEL, not for their colour interest:
 * 6, 7 and 12. Channel counts and bit depth both move it, and if the serial
 * term is a memcpy it has to track bytes rather than pixels across all four.
 */
const CMYK_ICC = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');
let cmykProfile = null;
function cmyk(){
    if(!cmykProfile){
        const Profile = require('../../src/Profile.js');
        cmykProfile = new Profile();
        cmykProfile.loadFile(CMYK_ICC);
    }
    return cmykProfile;
}

/** Widen the int8 photo to int16 by replicating the byte into both halves. */
function widen(img){
    const a = new Uint16Array(img.data.length);
    for(let i = 0; i < a.length; i++) a[i] = img.data[i] * 257;
    return { data: a, pixelCount: img.pixelCount };
}

/** RGB photo -> 4 channels, so a CMYK-source run has real content to chew on. */
function toCmyk(img){
    const t = new Transform({dataFormat: 'int8', buildLut: true});
    t.create('*sRGB', cmyk(), eIntent.relative);
    const out = t.transformArray(img.data, false, false, false, img.pixelCount);
    return { data: out, pixelCount: img.pixelCount };
}

let FORMATS = null;
function buildFormats(img){
    const mk = (opts, a, b) => () => {
        const t = new Transform(opts);
        t.create(a, b, eIntent.relative);
        return t;
    };
    return [
        { label: 'int8  RGB->RGB kernel',  bytesPerPx: 6,
          image: () => img,
          make:  mk({dataFormat: 'int8', buildLut: false}, PAIR[0], PAIR[1]),
          outFor: n => new Uint8ClampedArray(n * 3) },
        { label: 'int8  RGB->RGB CLUT',    bytesPerPx: 6,
          image: () => img,
          make:  mk({dataFormat: 'int8', buildLut: true, wasmMatrixShaper: false}, PAIR[0], PAIR[1]),
          outFor: n => new Uint8ClampedArray(n * 3) },
        { label: 'int8  RGB->CMYK',        bytesPerPx: 7,
          image: () => img,
          make:  () => { const t = new Transform({dataFormat: 'int8', buildLut: true});
                         t.create('*sRGB', cmyk(), eIntent.relative); return t; },
          outFor: n => new Uint8ClampedArray(n * 4) },
        { label: 'int8  CMYK->RGB',        bytesPerPx: 7,
          image: () => toCmyk(img),
          make:  () => { const t = new Transform({dataFormat: 'int8', buildLut: true});
                         t.create(cmyk(), '*sRGB', eIntent.relative); return t; },
          outFor: n => new Uint8ClampedArray(n * 3) },
        { label: 'int16 RGB->RGB kernel',  bytesPerPx: 12,
          image: () => widen(img),
          make:  mk({dataFormat: 'int16', buildLut: false}, PAIR[0], PAIR[1]),
          outFor: n => new Uint16Array(n * 3) },
        { label: 'int16 RGB->RGB CLUT',    bytesPerPx: 12,
          image: () => widen(img),
          make:  mk({dataFormat: 'int16', buildLut: true, wasmMatrixShaper: false}, PAIR[0], PAIR[1]),
          outFor: n => new Uint16Array(n * 3) }
    ];
}

async function timePool(t, img, opts){
    await t.transformImages([img], opts);
    await t.transformImages([img], opts);
    const times = [];
    for(let i = 0; i < RUNS; i++){
        const t0 = now();
        await t.transformImages([img], opts);
        times.push(now() - t0);
    }
    return median(times);
}

/**
 * The floor: copy the image out in fragments and back again, on the main
 * thread, doing no colour work at all. This is what the pool must pay per
 * image however fast the kernel gets, because a worker cannot see the caller's
 * array — it gets its own copy, and the result is copied back.
 */
/**
 * The same floor, parameterised by bytes per pixel, so the "it is the copies"
 * claim can be checked against the one variable that should move it.
 * `bytesPerPx` counts BOTH directions — 3 in and 3 out is 6.
 */
function copyFloorBytes(npx, bytesPerPx, alloc, sliceLen){
    const inArr  = alloc();
    const outArr = alloc();
    const perPxIn = inArr.length / npx;
    const scratch = alloc().subarray(0, sliceLen * perPxIn);
    const times = [];
    for(let r = 0; r < RUNS + 1; r++){
        const t0 = now();
        for(let start = 0; start < npx; start += sliceLen){
            const n = Math.min(sliceLen, npx - start) * perPxIn;
            scratch.set(inArr.subarray(start * perPxIn, start * perPxIn + n));
            outArr.set(scratch.subarray(0, n), start * perPxIn);
        }
        if(r) times.push(now() - t0);
    }
    return median(times);
}

function copyFloor(img, sliceLen){
    const src = img.data;
    const dst = new Uint8ClampedArray(src.length);
    const scratch = new Uint8ClampedArray(sliceLen * 3);
    const times = [];
    for(let r = 0; r < RUNS + 1; r++){
        const t0 = now();
        for(let start = 0; start < img.pixelCount; start += sliceLen){
            const n = Math.min(sliceLen, img.pixelCount - start) * 3;
            scratch.set(src.subarray(start*3, start*3 + n));        // into the worker
            dst.set(scratch.subarray(0, n), start*3);               // and back out
        }
        if(r) times.push(now() - t0);
    }
    return median(times);
}

async function main(){
    const img = photo(PX);
    const mpx = PX / 1e6;
    FORMATS = buildFormats(img);

    console.log('photo   ' + PAIR.join(' -> ') + '   ' + mpx.toFixed(1) + ' MPx   ' +
                WORKERS + ' workers   median of ' + RUNS + '\n');

    // ---- 1. fragment size ------------------------------------------------
    // tasksPerWorker sets the slice length, subject to bufferPx above and
    // minSlicePx below — so the extremes are reached by moving those too.
    const PLANS = [
        ['8 tasks   (524k px)',  {tasksPerWorker: 1,  bufferPx: 1048576}],
        ['16 tasks  (262k px)',  {tasksPerWorker: 2,  bufferPx: 1048576}],
        ['32 tasks  (131k px)',  {tasksPerWorker: 4,  bufferPx: 1048576}],
        ['80 tasks  (52k px)',   {tasksPerWorker: 10}],                    // the default
        ['128 tasks (33k px)',   {tasksPerWorker: 16}],
        ['256 tasks (16k px)',   {tasksPerWorker: 40}],
        ['512 tasks (8k px)',    {tasksPerWorker: 80, minSlicePx: 4096}],
        ['1024 tasks (4k px)',   {tasksPerWorker: 160, minSlicePx: 2048}]
    ];

    if(SECTIONS.includes(1)){
    console.log('FRAGMENT SIZE            kernel MPx/s     CLUT MPx/s');
    for(const [label, extra] of PLANS){
        const opts = { multicore: Object.assign(
            {cores: WORKERS, minThreads: 1, maxThreads: WORKERS}, extra) };
        pool.destroyAll();
        const k = mpx / (await timePool(makeTransform('kernel'), img, opts) / 1000);
        const c = mpx / (await timePool(makeTransform('clut'),   img, opts) / 1000);
        console.log('  ' + label.padEnd(22) + k.toFixed(1).padStart(10) + c.toFixed(1).padStart(15));
    }
    pool.destroyAll();
    }

    // ---- 2. the serial fraction, per format -----------------------------
    // MPx/s IS THE WRONG UNIT FOR THE OVERHEAD. Pixels are the right unit for
    // work done — that is what an image costs — but the pool's serial term is
    // BYTES MOVED, and bytes per pixel is not a constant: 6 for int8 RGB->RGB,
    // 7 for int8 RGB->CMYK, 12 for int16 RGB->RGB. If S really is a memcpy it
    // should be flat in ms/MB and vary by 2x in ms/MPx across this table. Both
    // columns are printed so that is checkable rather than asserted.
    // LEAST SQUARES OVER w = 2..7, NOT TWO POINTS. S is a small difference of
    // two large numbers, so a two-point fit hands almost all of the run-to-run
    // noise straight to it — the first version of this bench reported S varying
    // 3.6x across formats, which was the estimator talking, not the pool. R^2
    // is printed so a bad fit is visible rather than averaged into a number
    // that looks authoritative. w=1 is excluded: one worker has no queue to
    // pull from, so it does not sit on the same line as the rest.
    console.log('\nSERIAL FRACTION, PER FORMAT   least squares T = S + P*(1/w), w = 2..7');
    console.log('  format                   B/px  seq ms/MPx        P        S  S ms/MB     R^2');

    for(const f of (SECTIONS.includes(2) ? FORMATS : [])){
        const fimg = f.image();
        const fmpx = fimg.pixelCount / 1e6;
        const t = f.make();

        const xs = [], ys = [];
        for(const w of [2, 3, 4, 5, 6, 7]){
            pool.destroyAll();
            xs.push(1 / w);
            ys.push(await timePool(t, fimg, {multicore: {cores: w, minThreads: 1, maxThreads: w}}) / fmpx);
        }
        const n    = xs.length;
        const mx   = xs.reduce((a, b) => a + b, 0) / n;
        const my   = ys.reduce((a, b) => a + b, 0) / n;
        const sxy  = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
        const sxx  = xs.reduce((a, x) => a + (x - mx) * (x - mx), 0);
        const P    = sxy / sxx;
        const S    = my - P * mx;
        const ssTot = ys.reduce((a, y) => a + (y - my) * (y - my), 0);
        const ssRes = ys.reduce((a, y, i) => { const e = y - (S + P * xs[i]); return a + e * e; }, 0);
        const r2   = 1 - ssRes / ssTot;

        const out = f.outFor(fimg.pixelCount);
        t.transformArray(fimg.data, false, false, false, fimg.pixelCount, undefined, out);
        let seq = Infinity;
        for(let i = 0; i < RUNS; i++){
            const t0 = now();
            t.transformArray(fimg.data, false, false, false, fimg.pixelCount, undefined, out);
            seq = Math.min(seq, now() - t0);
        }
        seq /= fmpx;

        const mbPerMpx = f.bytesPerPx;      // 1 MPx x B/px bytes = that many MB
        console.log('  ' + f.label.padEnd(24) +
            String(f.bytesPerPx).padStart(4) +
            seq.toFixed(3).padStart(12) +
            P.toFixed(3).padStart(9) +
            S.toFixed(3).padStart(9) +
            (S / mbPerMpx).toFixed(4).padStart(9) +
            r2.toFixed(4).padStart(8));
        console.log('     ceiling ' + (seq / S).toFixed(1) + 'x  =  ' +
            (1 / S * 1000).toFixed(0) + ' MPx/s  =  ' +
            (mbPerMpx / S * 1000 / 1024).toFixed(1) + ' GB/s' +
            '   measured: ' + ys.map((y, i) => (1/xs[i]).toFixed(0) + 'w ' + y.toFixed(3)).join('  '));
    }
    pool.destroyAll();

    // ---- 3. what is S made of? ------------------------------------------
    // NO FITTING HERE, which is the point: this is a stopwatch on the memcpy
    // itself, at three widths. If the pool's serial term is the copies, ms/MPx
    // must double from 6 to 12 B/px while ms/MB stays flat — and unlike the
    // regression above, nothing here can hide behind an R^2.
    console.log('\nTHE COPY FLOOR   main-thread memcpy in and out, no colour work, 52k px slices');
    console.log('  bytes per pixel      ms/MPx     ms/MB      GB/s');
    for(const [label, bpp, arr] of [
        ['6   (int8  RGB->RGB)',  6,  () => new Uint8ClampedArray(PX * 3)],
        ['7   (int8  RGB->CMYK)', 7,  () => new Uint8ClampedArray(PX * 4)],   // 3 in + 4 out
        ['12  (int16 RGB->RGB)',  12, () => new Uint16Array(PX * 3)]
    ]){
        const ms = copyFloorBytes(PX, bpp, arr, 52480) / mpx;
        console.log('  ' + label.padEnd(22) + ms.toFixed(3).padStart(7) +
                    (ms / bpp).toFixed(4).padStart(10) +
                    (bpp / (ms / 1000) / 1024).toFixed(1).padStart(10));
    }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
