/**
 * bench/multicore_poc/batch_barrier.js
 * ====================================
 *
 * WHAT DOES A PER-IMAGE BARRIER COST?
 *
 * lcms's threaded plugin splits one image across N threads and joins them
 * before the call returns (`_cmsThrJoinWorker`, threaded_scheduler.c). That is
 * the natural shape for a library whose API is "convert this buffer" -- but it
 * means every image ends with a barrier, and a barrier means idle workers for
 * however long the slowest slice runs past the others.
 *
 * Our dispatcher takes 1..n images and plans them into ONE flat queue, so a
 * worker finishing image 1 immediately starts on image 3. Nothing waits at an
 * image boundary because there are no image boundaries in the queue.
 *
 * This measures the difference on identical work:
 *
 *   BARRIER  each image planned, dispatched and joined in turn
 *   MERGED   every image's tasks in one queue, sorted longest-first
 *
 * The gap should widen with a batch of MIXED sizes, because a small image
 * cannot fill the pool -- with a barrier, the spare workers idle until it
 * finishes; merged, they are already working on the next image.
 *
 * Run:  node bench/multicore_poc/batch_barrier.js
 *       node bench/multicore_poc/batch_barrier.js --workers 8 --lutMode int-wasm-simd
 */
'use strict';

const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { Transform, eIntent } = require('../../src/main');
const Profile = require('../../src/Profile');

const GRACOL = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');
const IN_CH = 3, OUT_CH = 4;

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : fallback;
}
const WORKERS  = Number(arg('workers', 8));
const LUT_MODE = arg('lutMode', 'int');
const REPEATS  = Number(arg('repeats', 5));

// A realistic mixed batch: thumbnails, web images, a couple of full frames.
const BATCH = arg('batch', '300000,2097152,500000,8388608,1000000,150000,4194304')
    .split(',').map(s => parseInt(s.trim(), 10));

const TASKS_PER_WORKER = 10;
const MIN_SLICE = 16384;
const CAPACITY  = 262144;

function sliceLen(px) {
    return Math.min(CAPACITY, Math.max(MIN_SLICE, Math.ceil(px / (WORKERS * TASKS_PER_WORKER))));
}

function planImage(imageIndex, px) {
    const per = Math.ceil(sliceLen(px) / 64) * 64;
    const out = [];
    for (let s = 0; s < px; s += per) out.push({ imageIndex, start: s, length: Math.min(per, px - s) });
    return out;
}

function startPool(lutJson, n) {
    return Promise.all(Array.from({ length: n }, () => new Promise((res, rej) => {
        const w = new Worker(path.join(__dirname, 'worker.js'), {
            workerData: { lutJson, lutMode: LUT_MODE, warmupPixels: 200000, inChannels: IN_CH, slowFactor: 1 },
        });
        w.once('message', m => m.type === 'ready' ? res(w) : rej(new Error('handshake')));
        w.once('error', rej);
    })));
}

// Drain one task list across the pool. Resolves when the LAST task lands --
// i.e. this is the barrier.
function drain(pool, tasks, sources, outputs) {
    return new Promise((resolve, reject) => {
        if (!tasks.length) return resolve();
        const queue = [...tasks].sort((a, b) => b.length - a.length);
        let next = 0, done = 0;
        const feed = (w) => {
            if (next >= queue.length) return;
            const t = queue[next++];
            const src = sources[t.imageIndex];
            const slice = new Uint8ClampedArray(t.length * IN_CH);
            slice.set(src.subarray(t.start * IN_CH, (t.start + t.length) * IN_CH));
            w.postMessage({ type: 'run', index: queue.indexOf(t), buffer: slice.buffer,
                            pixelCount: t.length, meta: { i: t.imageIndex, s: t.start } }, [slice.buffer]);
        };
        for (const w of pool) {
            w.removeAllListeners('message'); w.removeAllListeners('error');
            w.on('message', (msg) => {
                if (msg.type !== 'done') return;
                const t = queue[msg.index];
                const chunk = new Uint8ClampedArray(msg.buffer);
                outputs[t.imageIndex].set(chunk.subarray(0, t.length * OUT_CH), t.start * OUT_CH);
                if (++done === queue.length) resolve(); else feed(w);
            });
            w.once('error', reject);
        }
        for (const w of pool) feed(w);
    });
}

async function main() {
    const gracol = new Profile();
    await gracol.loadPromise('file:' + GRACOL);
    const build = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: LUT_MODE });
    build.create('*sRGB', gracol, eIntent.relative);

    let s = 0x13579bdf;
    const sources = BATCH.map(px => {
        const b = new Uint8ClampedArray(px * IN_CH);
        for (let i = 0; i < b.length; i++) { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; b[i] = (s >>> 23) & 0xff; }
        return b;
    });
    const outputs = BATCH.map(px => new Uint8ClampedArray(px * OUT_CH));
    const totalPx = BATCH.reduce((a, b) => a + b, 0);

    const pool = await startPool(build.toJSON(), WORKERS);

    // BARRIER: plan, dispatch and join each image in turn -- the lcms shape.
    const runBarrier = async () => {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < BATCH.length; i++) await drain(pool, planImage(i, BATCH[i]), sources, outputs);
        return Number(process.hrtime.bigint() - t0) / 1e6;
    };
    // MERGED: one queue for the whole batch, no image boundaries.
    const allTasks = BATCH.flatMap((px, i) => planImage(i, px));
    const runMerged = async () => {
        const t0 = process.hrtime.bigint();
        await drain(pool, allTasks, sources, outputs);
        return Number(process.hrtime.bigint() - t0) / 1e6;
    };

    await runBarrier(); await runMerged();                 // warm both shapes
    let bBest = Infinity, mBest = Infinity;
    for (let r = 0; r < REPEATS; r++) {
        bBest = Math.min(bBest, await runBarrier());
        mBest = Math.min(mBest, await runMerged());
    }

    console.log('='.repeat(84));
    console.log(' Per-image barrier vs one merged queue');
    console.log('='.repeat(84));
    console.log(' workers  : ' + WORKERS + '   kernel: ' + LUT_MODE);
    console.log(' batch    : ' + BATCH.length + ' images, ' + (totalPx / 1e6).toFixed(2) + ' MP total');
    console.log('            ' + BATCH.map(p => (p / 1e6).toFixed(2)).join(', ') + ' MP');
    console.log(' tasks    : ' + allTasks.length + ' total\n');
    console.log('   barrier per image (lcms shape)   ' + bBest.toFixed(2).padStart(8) + ' ms   ' +
        ((totalPx / 1e6) / (bBest / 1000)).toFixed(1).padStart(6) + ' MPx/s');
    console.log('   one merged queue                 ' + mBest.toFixed(2).padStart(8) + ' ms   ' +
        ((totalPx / 1e6) / (mBest / 1000)).toFixed(1).padStart(6) + ' MPx/s');
    console.log('   ' + '-'.repeat(66));
    console.log('   merged is ' + (((bBest - mBest) / bBest) * 100).toFixed(1) + ' % faster on identical work\n');

    for (const w of pool) w.postMessage({ type: 'exit' });
}

main().catch(e => { console.error(e); process.exit(1); });
