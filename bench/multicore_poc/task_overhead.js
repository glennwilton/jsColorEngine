/**
 * bench/multicore_poc/task_overhead.js
 * ====================================
 *
 * WHAT IS THE COST OF ONE TASK?
 *
 * The multicore design has an open question that decides the chunk size for
 * fixed-slot allocation: we know the per-*pass* copy cost (4-7%), but not the
 * per-*task* cost. Too-small chunks and messaging dominates; too-large and both
 * resident memory and the makespan tail grow.
 *
 * Method: hold total pixels and worker count constant, vary only how many
 * tasks that work is cut into. Any rise in total time as the task count grows
 * is per-task overhead and nothing else, because the pixels, the kernel, the
 * workers and the transform are all identical across rows.
 *
 *     T(n) = compute + n x overhead      ->      overhead = slope of T vs n
 *
 * A least-squares fit over the sweep gives the per-task cost directly, in
 * microseconds, which is the number the chunk-size decision needs.
 *
 * THE RAGGED CASE
 * ---------------
 * Uniform tasks are the easy case and not the real one. Cutting an image into
 * fixed chunks leaves a remainder -- sometimes three pixels of it -- and a
 * batch of many images leaves one remainder each. `--ragged` reproduces that:
 * same total pixels, same task count, but lengths drawn at random with a long
 * tail of tiny tasks. If per-task overhead is real, ragged should cost more
 * than uniform at the same task count, and the gap is what a "run tiny slices
 * on the main thread" rule would be buying.
 *
 * Run:
 *   node bench/multicore_poc/task_overhead.js
 *   node bench/multicore_poc/task_overhead.js --workers 8 --pixels 8000000
 *   node bench/multicore_poc/task_overhead.js --ragged
 */
'use strict';

const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { Transform, eIntent } = require('../../src/main');
const Profile = require('../../src/Profile');

const GRACOL = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : fallback;
}
const has = n => process.argv.includes('--' + n);

const WORKERS   = Number(arg('workers', 4));
const TOTAL_PX  = Number(arg('pixels', 8388608));      // 8 MP
const REPEATS   = Number(arg('repeats', 5));
const LUT_MODE  = arg('lutMode', 'int');
const RAGGED    = has('ragged');
const CONTENT   = arg('content', 'uniform');   // uniform | mixed
const TASK_COUNTS = arg('tasks', '1,4,16,64,256,1024')
    .split(',').map(s => parseInt(s.trim(), 10));

const IN_CH = 3, OUT_CH = 4;                            // sRGB -> GRACoL

// ---- task splitting ----------------------------------------------------

// Uniform: every task the same size bar the remainder.
function splitUniform(total, n) {
    const per = Math.ceil(total / n / 64) * 64;         // 64-px aligned
    const out = [];
    for (let s = 0; s < total; s += per) out.push({ start: s, length: Math.min(per, total - s) });
    return out;
}

// Ragged: same total, same count, wildly uneven lengths including tiny ones.
// This is what a batch of many images actually produces -- one remainder per
// image, and remainders are not politely sized.
function splitRagged(total, n, seed) {
    if (n === 1) return [{ start: 0, length: total }];
    let s = seed >>> 0;
    const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return (s >>> 8) / 0x7fffff; };

    // Exponential-ish weights: most tasks small, a few large. Then one task is
    // forced to a handful of pixels, because that is the case being asked about.
    const weights = Array.from({ length: n }, () => Math.pow(rnd(), 3) + 0.002);
    const sum = weights.reduce((a, b) => a + b, 0);
    const lens = weights.map(w => Math.max(1, Math.round((w / sum) * total)));
    lens[n - 1] = 3;                                     // the notorious 3-pixel task

    let drift = total - lens.reduce((a, b) => a + b, 0);
    for (let i = 0; drift !== 0 && i < n; i++) {         // repair to exactly total
        const room = drift > 0 ? drift : Math.max(-(lens[i] - 1), drift);
        lens[i] += room; drift -= room;
    }
    const out = [];
    let start = 0;
    for (const l of lens) { out.push({ start, length: l }); start += l; }
    return out;
}

// ---- pool --------------------------------------------------------------

function startPool(lutJson, count) {
    return Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
        const w = new Worker(path.join(__dirname, 'worker.js'), {
            workerData: { lutJson, lutMode: LUT_MODE, warmupPixels: 200000, inChannels: IN_CH },
        });
        w.once('message', m => m.type === 'ready' ? resolve(w) : reject(new Error('bad handshake')));
        w.once('error', reject);
    })));
}

// Dispatch a task list across the pool, pulling the next task as each worker
// frees up. Returns wall time for the whole set.
function runTasks(pool, tasks, source, output, stats) {
    return new Promise((resolve, reject) => {
        // longest first, so the tail is not one long task behind idle workers
        const queue = [...tasks].sort((a, b) => b.length - a.length);
        let next = 0, done = 0;
        const t0 = process.hrtime.bigint();

        const feed = (w) => {
            if (next >= queue.length) return;
            const task = queue[next++];
            const slice = new Uint8ClampedArray(task.length * IN_CH);
            slice.set(source.subarray(task.start * IN_CH, (task.start + task.length) * IN_CH));
            w.postMessage({ type: 'run', index: tasks.indexOf(task), buffer: slice.buffer,
                            pixelCount: task.length, start: task.start }, [slice.buffer]);
        };

        for (const w of pool) {
            w.removeAllListeners('message');
            w.removeAllListeners('error');
            w.on('message', (msg) => {
                if (msg.type !== 'done') return;
                // copy the finished chunk home; order does not matter
                const chunk = new Uint8ClampedArray(msg.buffer);
                const task = tasks[msg.index];
                output.set(chunk.subarray(0, task.length * OUT_CH), task.start * OUT_CH);
                // Worker-side compute only: the signal an adaptive dispatcher
                // would feed back, and the thing that must stay stable as the
                // slice size changes or the feedback loop is unstable.
                if (stats) { stats.px += task.length; stats.computeMs += msg.computeMs; }
                if (++done === queue.length) {
                    resolve(Number(process.hrtime.bigint() - t0) / 1e6);
                } else {
                    feed(w);
                }
            });
            w.once('error', reject);
        }
        for (const w of pool) feed(w);
    });
}

// least-squares slope of ms vs task count => per-task cost
function slope(points) {
    const n = points.length;
    const sx = points.reduce((a, p) => a + p.n, 0);
    const sy = points.reduce((a, p) => a + p.ms, 0);
    const sxy = points.reduce((a, p) => a + p.n * p.ms, 0);
    const sxx = points.reduce((a, p) => a + p.n * p.n, 0);
    return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

async function main() {
    const gracol = new Profile();
    await gracol.loadPromise('file:' + GRACOL);

    const build = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: LUT_MODE });
    build.create('*sRGB', gracol, eIntent.relative);
    const lutJson = build.toJSON();

    // One deterministic source image, reused for every row.
    //
    // CONTENT MATTERS TO SCHEDULING, not just to throughput. The content work
    // (deepdive/benchmark.md §§20-21) showed the same kernel runs anywhere
    // from ~100 to ~270 MPx/s depending on how much of the CLUT the pixels
    // touch. A real image is not uniform: flat sky converts fast, dense
    // foliage converts slowly. So two slices of identical PIXEL COUNT can take
    // very different times, and a scheduler that assumes equal cost per equal
    // size is wrong about real images.
    //
    //   uniform  every slice statistically identical - the easy case
    //   mixed    first half solid, second half noise - equal pixels,
    //            very unequal cost, which is what a real frame looks like
    //            in caricature
    const source = new Uint8ClampedArray(TOTAL_PX * IN_CH);
    let s = 0x13579bdf;
    const noiseByte = () => {
        s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
        return (s >>> 23) & 0xff;
    };
    if (CONTENT === 'mixed') {
        const half = (TOTAL_PX >> 1) * IN_CH;
        for (let i = 0; i < half; i++) source[i] = 200;           // flat: tiny CLUT working set
        for (let i = half; i < source.length; i++) source[i] = noiseByte();
    } else {
        for (let i = 0; i < source.length; i++) source[i] = noiseByte();
    }
    const output = new Uint8ClampedArray(TOTAL_PX * OUT_CH);

    console.log('='.repeat(96));
    console.log(' Per-task overhead — total pixels and worker count held constant');
    console.log('='.repeat(96));
    console.log(' workers      : ' + WORKERS + ' of ' + os.availableParallelism() + ' logical');
    console.log(' total pixels : ' + TOTAL_PX.toLocaleString() + '  (sRGB -> GRACoL, lutMode ' + LUT_MODE + ')');
    console.log(' split        : ' + (RAGGED ? 'RAGGED — uneven lengths, one 3-px task per row' : 'uniform'));
 console.log(' content      : ' + (CONTENT === 'mixed' ? 'MIXED — half flat, half noise (equal pixels, unequal cost)' : 'uniform noise'));
    console.log(' repeats      : ' + REPEATS + ', best taken\n');
    console.log('  tasks   px/task (median)      best ms   wall MPx/s   kernel MPx/s    vs 1 task');
    console.log('  ------  ------------------  ---------  -----------  -------------  ----------');

    const pool = await startPool(lutJson, WORKERS);
    const points = [];
    let baseline = 0;

    for (const n of TASK_COUNTS) {
        if (n > TOTAL_PX) continue;
        const tasks = RAGGED ? splitRagged(TOTAL_PX, n, 0x2545f491 + n) : splitUniform(TOTAL_PX, n);
        await runTasks(pool, tasks, source, output);          // warm this shape

        let best = Infinity;
        const stats = { px: 0, computeMs: 0 };
        for (let r = 0; r < REPEATS; r++) {
            best = Math.min(best, await runTasks(pool, tasks, source, output, stats));
        }
        // kernel-only throughput, summed across workers
        const kernelMpx = (stats.px / 1e6) / (stats.computeMs / 1000);
        const lens = tasks.map(t => t.length).sort((a, b) => a - b);
        const med = lens[lens.length >> 1];
        const mpx = (TOTAL_PX / 1e6) / (best / 1000);
        // Rows with fewer tasks than workers leave workers idle, so they
        // measure parallelism, not overhead. Baseline and slope both start
        // at the first saturating row.
        const saturated = tasks.length >= WORKERS;
        if (saturated && !baseline) baseline = best;
        if (saturated) points.push({ n: tasks.length, ms: best });
        console.log('  ' + String(tasks.length).padStart(6) + '  ' +
            (med.toLocaleString() + (RAGGED ? '  (min ' + lens[0] + ')' : '')).padEnd(18) + '  ' +
            best.toFixed(1).padStart(9) + '  ' + mpx.toFixed(1).padStart(11) + '  ' + kernelMpx.toFixed(1).padStart(13) + '  ' +
            (saturated ? ((best / baseline - 1) * 100).toFixed(1).padStart(9) + '%'
                       : '   idle wk'));
    }

    if (points.length >= 2) {
        const perTaskMs = slope(points);
        const pxPerMs = TOTAL_PX / points[0].ms;          // throughput at the fastest split
        console.log('\n  per-task overhead (least-squares slope over saturated rows): ' +
            (perTaskMs * 1000).toFixed(1) + ' µs');
        console.log('  a task should run ~10x its own overhead, so minimum useful chunk ≈ ' +
            Math.max(0, Math.round(perTaskMs * 10 * pxPerMs)).toLocaleString() + ' px');
    }
    console.log('');

    for (const w of pool) w.postMessage({ type: 'exit' });
}

main().catch(e => { console.error(e); process.exit(1); });
