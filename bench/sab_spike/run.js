/**
 * SPIKE — what does SharedArrayBuffer actually buy the pool?
 *
 *   node --max-old-space-size=8192 bench/sab_spike/run.js
 *
 * NOT PRODUCTION CODE. It reimplements the pool's dispatch loop in the crudest
 * way that is still fair, so the two delivery models can be compared without
 * threading SAB through cancellation, eviction, scratch reuse and the rest of
 * src/pool.js first. If the answer here is small, that work does not get done.
 *
 * The two models:
 *
 *   transfer   today. Main thread copies the fragment into a scratch buffer,
 *              postMessage with a transfer list, worker converts, transfers
 *              both buffers home, main thread copies the result into the
 *              output image. Two main-thread memcpys per fragment.
 *
 *   shared     input and output live in SharedArrayBuffers. The worker gets
 *              {start, length} and takes subarray views. Zero main-thread
 *              copies; the reply carries no data at all.
 *
 * Both run the same real matrix-shaper kernel on the same pixels, and the
 * output is compared byte-for-byte against the sequential result — a delivery
 * model that produces different pixels is not a delivery model.
 */
'use strict';

const path = require('path');
const fs   = require('fs');
const { Worker } = require('worker_threads');
const { Transform, eIntent } = require('../../src/main.js');

const argv = process.argv.slice(2);
const arg  = (n, d) => { const h = argv.find(a => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };

const PX      = parseInt(arg('px', '4194304'), 10);
const RUNS    = parseInt(arg('runs', '5'), 10);
const WORKERS = parseInt(arg('workers', '8'), 10);
const TASKS_PER_WORKER = parseInt(arg('tasksPerWorker', '10'), 10);
const FROM = arg('from', '*prophoto'), TO = arg('to', '*sRGB');
const BITS = parseInt(arg('bits', '8'), 10);
const Arr  = BITS === 8 ? Uint8ClampedArray : Uint16Array;
const BPC  = BITS === 8 ? 1 : 2;                 // bytes per channel

const CORPUS = path.join(__dirname, '..', 'release_matrix', 'corpus');

const now = () => Number(process.hrtime.bigint()) / 1e6;
const median = xs => { const s = xs.slice().sort((a,b) => a-b); const m = s.length >> 1;
                       return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2; };

function photoInto(target, npx){
    const files = fs.readdirSync(CORPUS).filter(f => f.endsWith('.rgb.bin')).sort();
    if(!files.length) throw new Error('no photo corpus — run: node bench/release_matrix/make_corpus.cjs');
    const src = Buffer.concat(files.map(f => fs.readFileSync(path.join(CORPUS, f))));
    const have = (src.length / 3) | 0;
    for(let p = 0; p < npx; p++){
        const s = (p % have) * 3;
        target[p*3] = src[s]; target[p*3+1] = src[s+1]; target[p*3+2] = src[s+2];
    }
    return target;
}

/** Same slicing rule as src/pool.js sliceLengthFor(), so the task count matches. */
function sliceLength(pixelCount, workers){
    const wanted = Math.ceil(pixelCount / (workers * TASKS_PER_WORKER));
    const len = Math.min(262144, Math.max(16384, wanted));
    return Math.max(64, Math.ceil(len / 64) * 64);
}

function planTasks(pixelCount, workers){
    const per = sliceLength(pixelCount, workers);
    const tasks = [];
    for(let start = 0; start < pixelCount; start += per){
        tasks.push({start: start, length: Math.min(per, pixelCount - start)});
    }
    return tasks;
}

/** Hand tasks out as workers report in — the pull queue, minus everything else. */
function runBatch(workers, tasks, dispatch, onDone){
    return new Promise((resolve) => {
        let next = 0, done = 0;
        const feed = (w, index) => {
            if(next >= tasks.length) return;
            const id = next++;
            dispatch(w, id, tasks[id]);
        };
        workers.forEach((w, i) => {
            w.onReply = (msg) => {
                if(onDone) onDone(msg, tasks[msg.id]);
                if(++done >= tasks.length){ resolve(); return; }
                feed(w, i);
            };
        });
        // Prime every worker, then let replies pull the rest.
        const prime = Math.min(workers.length, tasks.length);
        for(let i = 0; i < prime; i++) feed(workers[i], i);
    });
}

async function main(){
    const mpx = PX / 1e6;

    // ---- the images ------------------------------------------------------
    const sabIn  = new SharedArrayBuffer(PX * 3 * BPC);
    const sabOut = new SharedArrayBuffer(PX * 3 * BPC);
    const sharedIn  = new Arr(sabIn);
    const sharedOut = new Arr(sabOut);
    photoInto(sharedIn, PX);

    // A plain copy of the same pixels for the transfer model, so neither model
    // is reading out of the other's memory.
    const plainIn  = new Arr(PX * 3);
    plainIn.set(sharedIn);
    const plainOut = new Arr(PX * 3);

    // ---- the oracle ------------------------------------------------------
    const seqT = new Transform({dataFormat: 'int' + BITS, buildLut: false});
    seqT.create(FROM, TO, eIntent.relative);
    const expected = new Arr(PX * 3);
    seqT.transformArray(plainIn, false, false, false, PX, undefined, expected);
    let seqMs = Infinity;
    for(let i = 0; i < RUNS; i++){
        const t0 = now();
        seqT.transformArray(plainIn, false, false, false, PX, undefined, expected);
        seqMs = Math.min(seqMs, now() - t0);
    }

    console.log('photo   int' + BITS + '   ' + FROM + ' -> ' + TO + '   ' + mpx.toFixed(1) + ' MPx   ' +
                WORKERS + ' workers   median of ' + RUNS);
    console.log('sequential ' + (mpx / (seqMs / 1000)).toFixed(1) + ' MPx/s  (' +
                (seqMs / mpx).toFixed(3) + ' ms/MPx)\n');

    // ---- workers ---------------------------------------------------------
    const workers = [];
    for(let i = 0; i < WORKERS; i++){
        const w = new Worker(path.join(__dirname, 'worker.js'), {
            workerData: {from: FROM, to: TO, sabIn: sabIn, sabOut: sabOut, bits: BITS}
        });
        w.on('message', (m) => { if(w.onReply) w.onReply(m); });
        workers.push(w);
    }
    await new Promise(r => setTimeout(r, 400));      // let the kernels build

    const tasks = planTasks(PX, WORKERS);
    console.log('tasks ' + tasks.length + '  slice ' + tasks[0].length + ' px\n');

    // ---- model: shared ---------------------------------------------------
    const sharedDispatch = (w, id, task) =>
        w.postMessage({type: 'shared', id: id, start: task.start, length: task.length});

    // ---- model: transfer -------------------------------------------------
    // Scratch buffers per worker, reused exactly as the pool does — the copies
    // are the subject here, not the allocations.
    const maxBytes = tasks[0].length * 3;   // in ELEMENTS, not bytes
    const scratchIn  = workers.map(() => new Arr(maxBytes));
    const scratchOut = workers.map(() => new Arr(maxBytes));
    const slotOf = new Map();
    workers.forEach((w, i) => slotOf.set(w, i));

    const transferDispatch = (w, id, task) => {
        const slot = slotOf.get(w);
        const bytes = task.length * 3;
        let sIn = scratchIn[slot], sOut = scratchOut[slot];
        if(!sIn || sIn.length < bytes) sIn = scratchIn[slot] = new Uint8ClampedArray(maxBytes);
        if(!sOut || sOut.length < bytes) sOut = scratchOut[slot] = new Uint8ClampedArray(maxBytes);
        sIn.set(plainIn.subarray(task.start * 3, task.start * 3 + bytes));   // COPY 1
        scratchIn[slot] = null; scratchOut[slot] = null;                     // on loan
        w.postMessage({type: 'transfer', id: id, length: task.length,
                       buffer: sIn.buffer, out: sOut.buffer},
                      [sIn.buffer, sOut.buffer]);
    };
    const transferOnDone = (msg, task) => {
        const slot = slotOf.get(workers.find(w => w.onReplyId === msg.id));
        // Buffers come home; put them back in the slot they came from.
        const bytes = task.length * 3;
        const chunk = new Uint8ClampedArray(msg.out, 0, bytes);
        plainOut.set(chunk, task.start * 3);                                 // COPY 2
        msg._in = msg.buffer; msg._out = msg.out;
    };

    // The reply handler needs to know which worker replied to recycle scratch,
    // so wrap dispatch/reply per worker rather than searching.
    function makeTransferRunner(){
        return new Promise((resolve) => {
            let next = 0, done = 0;
            const feed = (w, slot) => {
                if(next >= tasks.length) return;
                const id = next++;
                const task = tasks[id];
                const bytes = task.length * 3;
                const sIn = scratchIn[slot] || new Arr(maxBytes);
                const sOut = scratchOut[slot] || new Arr(maxBytes);
                sIn.set(plainIn.subarray(task.start * 3, task.start * 3 + bytes));
                scratchIn[slot] = null; scratchOut[slot] = null;
                w.postMessage({type: 'transfer', id: id, length: task.length,
                               buffer: sIn.buffer, out: sOut.buffer},
                              [sIn.buffer, sOut.buffer]);
            };
            workers.forEach((w, slot) => {
                w.onReply = (msg) => {
                    const task = tasks[msg.id];
                    scratchIn[slot]  = new Arr(msg.buffer);
                    scratchOut[slot] = new Arr(msg.out);
                    plainOut.set(scratchOut[slot].subarray(0, task.length * 3), task.start * 3);
                    if(++done >= tasks.length){ resolve(); return; }
                    feed(w, slot);
                };
            });
            const prime = Math.min(workers.length, tasks.length);
            for(let i = 0; i < prime; i++) feed(workers[i], i);
        });
    }

    async function time(label, fn, out){
        await fn();                                       // warm
        const times = [];
        for(let i = 0; i < RUNS; i++){
            const t0 = now();
            await fn();
            times.push(now() - t0);
        }
        const ms = median(times);
        let differing = 0;
        for(let i = 0; i < expected.length; i++) if(out[i] !== expected[i]) differing++;
        console.log('  ' + label.padEnd(10) +
            (mpx / (ms / 1000)).toFixed(1).padStart(8) + ' MPx/s' +
            '   ' + (ms / mpx).toFixed(3) + ' ms/MPx' +
            '   speedup ' + (seqMs / ms).toFixed(2) + 'x' +
            '   eff ' + (100 * (seqMs / ms) / WORKERS).toFixed(0) + '%' +
            (differing ? '   *** ' + differing + ' BYTES DIFFER ***' : '   bytes identical'));
        return ms;
    }

    // THE CALLER'S BUFFER MAY NOT BE SHARED. Canvas ImageData is a plain
    // Uint8ClampedArray, and a SAB cannot be adopted after the fact — so a
    // caller who has not allocated one pays a bulk copy in. The output side
    // still costs nothing, because we allocate that. This row is the honest
    // default; the row above it is what a caller gets only if they allocate
    // shared buffers themselves.
    const sharedCopyIn = async () => {
        sharedIn.set(plainIn);                       // one bulk copy, not N
        await runBatch(workers, tasks, sharedDispatch, null);
    };

    // THE MIDDLE, AND THE ONE WE WOULD ACTUALLY SHIP for a plain-array caller:
    // keep the per-fragment copy IN (so it stays interleaved with worker
    // execution, as today) but make the OUTPUT shared, so the reassembly copy
    // disappears. Only the output side is ours to allocate, so only the output
    // side can be fixed without the caller changing anything.
    function makeHalfSharedRunner(){
        return new Promise((resolve) => {
            let next = 0, done = 0;
            const feed = (w, slot) => {
                if(next >= tasks.length) return;
                const id = next++;
                const task = tasks[id];
                const bytes = task.length * 3;
                // Copy into the shared INPUT at the fragment's own offset —
                // interleaved with the workers, exactly like today's scratch copy.
                sharedIn.set(plainIn.subarray(task.start * 3, task.start * 3 + bytes),
                             task.start * 3);
                w.postMessage({type: 'shared', id: id, start: task.start, length: task.length});
            };
            workers.forEach((w, slot) => {
                w.onReply = () => {
                    if(++done >= tasks.length){ resolve(); return; }
                    feed(w, slot);
                };
            });
            const prime = Math.min(workers.length, tasks.length);
            for(let i = 0; i < prime; i++) feed(workers[i], i);
        });
    }

    // PAIRED, NOT BLOCKED. Running all of one model then all of the other
    // hands every bit of thermal and scheduler drift to whichever went second;
    // the first version of this spike reported the gain anywhere between 1.08x
    // and 1.19x across four runs for exactly that reason. Alternating puts both
    // models in the same conditions on every repetition.
    async function paired(aLabel, aFn, aOut, bLabel, bFn, bOut){
        await aFn(); await bFn();                          // warm both
        const at = [], bt = [];
        for(let i = 0; i < RUNS; i++){
            let t0 = now(); await aFn(); at.push(now() - t0);
            t0 = now();     await bFn(); bt.push(now() - t0);
        }
        const check = (out) => {
            let d = 0;
            for(let i = 0; i < expected.length; i++) if(out[i] !== expected[i]) d++;
            return d;
        };
        const am = median(at), bm = median(bt);
        const row = (label, ms, out) =>
            '  ' + label.padEnd(10) + (mpx / (ms / 1000)).toFixed(1).padStart(8) + ' MPx/s' +
            '   ' + (ms / mpx).toFixed(3) + ' ms/MPx' +
            '   speedup ' + (seqMs / ms).toFixed(2) + 'x' +
            '   eff ' + (100 * (seqMs / ms) / WORKERS).toFixed(0) + '%' +
            (check(out) ? '   *** BYTES DIFFER ***' : '   identical');
        console.log(row(aLabel, am, aOut));
        console.log(row(bLabel, bm, bOut));
        console.log('  -> ' + bLabel + ' is ' + (am / bm).toFixed(3) + 'x ' + aLabel +
                    '   (' + ((am - bm) / mpx).toFixed(3) + ' ms/MPx removed)\n');
        return am / bm;
    }

    console.log('PAIRED: transfer vs half-shared (the shippable design)');
    const ratio = await paired('transfer', makeTransferRunner, plainOut,
                               'half', makeHalfSharedRunner, sharedOut);

    console.log('BLOCKED reference runs (same models, unpaired):');
    const tMs = await time('transfer', makeTransferRunner, plainOut);
    const sMs = await time('shared', () => runBatch(workers, tasks, sharedDispatch, null), sharedOut);
    const cMs = await time('shared+in', sharedCopyIn, sharedOut);
    const hMs = await time('half', makeHalfSharedRunner, sharedOut);

    console.log('\n  shared          ' + (tMs / sMs).toFixed(2) + 'x the transfer model' +
                '   (' + ((tMs - sMs) / mpx).toFixed(3) + ' ms/MPx removed)');
    console.log('  shared+copy-in  ' + (tMs / cMs).toFixed(2) + 'x' +
                '   (' + ((tMs - cMs) / mpx).toFixed(3) + ' ms/MPx removed)' +
                '   <- bulk copy up front: SLOWER, because it is not interleaved');
    console.log('  half-shared     ' + (tMs / hMs).toFixed(2) + 'x' +
                '   (' + ((tMs - hMs) / mpx).toFixed(3) + ' ms/MPx removed)' +
                '   <- per-fragment copy in, shared out: the shippable default');

    await Promise.all(workers.map(w => w.terminate()));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
