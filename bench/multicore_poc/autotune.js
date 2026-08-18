/**
 * bench/multicore_poc/autotune.js
 * ===============================
 *
 * A one-second calibration that derives this machine's dispatch constants,
 * instead of hard-coding numbers measured on one Ryzen.
 *
 * WHY CALIBRATE RATHER THAN ADAPT
 * -------------------------------
 * Kernel throughput and per-task overhead are machine properties -- a
 * 3D V-Cache part holds far more of the CLUT resident, a many-core server has
 * different jitter and message costs. Adapting from observed production
 * timings sounds tidier but has a feedback loop: slice size perturbs the very
 * number being fed back. Here we choose the slice sizes ourselves, so it is a
 * controlled experiment with no loop.
 *
 * METHOD
 * ------
 * Two timed passes over identical pixels, differing only in task count:
 *
 *     T(n) = compute + n * overhead
 *
 * Two points, two unknowns. No sweep needed:
 *
 *     overhead  = (T_hi - T_lo) / (n_hi - n_lo)
 *     compute   = T_lo - n_lo * overhead
 *     aggregate throughput = px / compute
 *
 * Both passes sit in the well-balanced region (>= 8 tasks/worker) so the
 * difference between them is overhead rather than load imbalance.
 *
 * WHAT IT DERIVES
 * ---------------
 * Not a fixed slice size -- that is image-dependent -- but the two constants a
 * planner needs, plus the target it implies. Empirically the optimum sits
 * where total per-task overhead is ~9% of the pass, which reproduces both
 * measured optima on this machine (SIMD 48 tasks, JS int 96) from one formula.
 *
 * Content is deliberately mid-range: a photograph blended ~5% toward noise,
 * which is the plateau from deepdive/benchmark.md section 21. Calibrating on
 * `solid` would measure L1 and on pure `noise` the worst case; neither
 * predicts real work.
 *
 * Run:  node bench/multicore_poc/autotune.js
 *       node bench/multicore_poc/autotune.js --workers 8 --lutMode int-wasm-simd
 */
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { Transform, eIntent } = require('../../src/main');
const Profile = require('../../src/Profile');

const GRACOL = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');
const CORPUS = path.join(__dirname, '..', 'release_matrix', 'corpus');

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : fallback;
}

const WORKERS  = Number(arg('workers', Math.min(8, os.availableParallelism())));
const LUT_MODE = arg('lutMode', 'int');
const CAL_PX   = Number(arg('pixels', 2097152));
const IN_CH = 3, OUT_CH = 4;

// Bounds. A throttled or contended machine must degrade to "slightly wrong",
// never to something pathological.
const BOUNDS = {
    kernelMPxPerSec: [20, 2000],
    perTaskOverheadUs: [1, 500],
    tasksPerWorker: [4, 16],
    overheadShareOfPass: 0.09,     // measured: the optimum sits here
};

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

// ---- calibration content ------------------------------------------------
// Mid-range on purpose: ~5% noise over a photograph is the plateau where every
// content class converges, so it predicts real work rather than a cache best
// or worst case. Falls back to synthetic if the corpus is not generated.
function calibrationContent(px) {
    const buf = new Uint8ClampedArray(px * IN_CH);
    let s = 0x13579bdf;
    const noise = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return (s >>> 23) & 0xff; };

    let src = null;
    try {
        const f = fs.readdirSync(CORPUS).find(n => n.endsWith('.rgb.bin'));
        if (f) src = fs.readFileSync(path.join(CORPUS, f));
    } catch { /* synthetic fallback below */ }

    if (src) {
        const have = (src.length / IN_CH) | 0;
        for (let p = 0; p < px; p++) {
            const o = p * IN_CH, q = (p % have) * IN_CH;
            for (let c = 0; c < IN_CH; c++) buf[o + c] = Math.round(src[q + c] * 0.95 + noise() * 0.05);
        }
    } else {
        for (let i = 0; i < buf.length; i++) buf[i] = noise();
    }
    return buf;
}

function startPool(lutJson, count) {
    return Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
        const w = new Worker(path.join(__dirname, 'worker.js'), {
            workerData: { lutJson, lutMode: LUT_MODE, warmupPixels: 200000, inChannels: IN_CH },
        });
        w.once('message', m => m.type === 'ready' ? resolve(w) : reject(new Error('handshake')));
        w.once('error', reject);
    })));
}

function runPass(pool, source, output, px, taskCount) {
    return new Promise((resolve, reject) => {
        const per = Math.ceil(px / taskCount / 64) * 64;
        const tasks = [];
        for (let s = 0; s < px; s += per) tasks.push({ start: s, length: Math.min(per, px - s) });

        let next = 0, done = 0, computeMs = 0, firstPerWorker = new Set();
        const t0 = process.hrtime.bigint();
        const feed = (w, id) => {
            if (next >= tasks.length) return;
            const t = tasks[next++];
            const slice = new Uint8ClampedArray(t.length * IN_CH);
            slice.set(source.subarray(t.start * IN_CH, (t.start + t.length) * IN_CH));
            w.postMessage({ type: 'run', index: tasks.indexOf(t), buffer: slice.buffer,
                            pixelCount: t.length }, [slice.buffer]);
        };
        pool.forEach((w, id) => {
            w.removeAllListeners('message'); w.removeAllListeners('error');
            w.on('message', (msg) => {
                if (msg.type !== 'done') return;
                // Discard each worker's FIRST task: it is a cold call and
                // under-reports the machine by ~25%.
                if (firstPerWorker.has(id)) computeMs += msg.computeMs;
                else firstPerWorker.add(id);
                const chunk = new Uint8ClampedArray(msg.buffer);
                output.set(chunk.subarray(0, tasks[msg.index].length * OUT_CH), tasks[msg.index].start * OUT_CH);
                if (++done === tasks.length) {
                    resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, tasks: tasks.length, computeMs });
                } else feed(w, id);
            });
            w.once('error', reject);
        });
        pool.forEach((w, id) => feed(w, id));
    });
}

async function main() {
    const t_start = Date.now();
    const gracol = new Profile();
    await gracol.loadPromise('file:' + GRACOL);
    const build = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: LUT_MODE });
    build.create('*sRGB', gracol, eIntent.relative);

    const source = calibrationContent(CAL_PX);
    const output = new Uint8ClampedArray(CAL_PX * OUT_CH);
    const pool = await startPool(build.toJSON(), WORKERS);

    // Both points in the balanced region, so the delta is overhead and not
    // load imbalance.
    const nLo = WORKERS * 8, nHi = WORKERS * 64;

    await runPass(pool, source, output, CAL_PX, nLo);      // warm
    await runPass(pool, source, output, CAL_PX, nHi);

    const best = async (n) => {
        let b = null;
        for (let r = 0; r < 3; r++) {
            const p = await runPass(pool, source, output, CAL_PX, n);
            if (!b || p.ms < b.ms) b = p;
        }
        return b;
    };
    const lo = await best(nLo);
    const hi = await best(nHi);

    // T(n) = compute + n*overhead
    const overheadMs = Math.max(0, (hi.ms - lo.ms) / (hi.tasks - lo.tasks));
    const computeMs  = Math.max(0.001, lo.ms - lo.tasks * overheadMs);

    const aggregateMPx = clamp((CAL_PX / 1e6) / (computeMs / 1000), BOUNDS.kernelMPxPerSec);
    const overheadUs   = clamp(overheadMs * 1000, BOUNDS.perTaskOverheadUs);

    // Implied task count for an image: keep total overhead at ~9% of the pass.
    const tasksFor = (px) => {
        const passMs = (px / 1e6) / aggregateMPx * 1000;
        const n = (BOUNDS.overheadShareOfPass * passMs) / (overheadUs / 1000);
        return Math.round(clamp(n / WORKERS, BOUNDS.tasksPerWorker) * WORKERS);
    };

    // ---- BAKE-OFF: derived vs default, keep the winner --------------------
    //
    // A derived constant is a hypothesis. Rather than trust it, run it against
    // the shipped default on this machine and keep whichever is actually
    // faster. This makes calibration incapable of making things worse, which
    // matters far more than making them slightly better -- a bad calibration
    // on a throttled or contended machine otherwise silently degrades every
    // subsequent run. Ties go to the default, because the known-good value
    // should not be displaced by noise.
    const DEFAULT_TASKS_PER_WORKER = 10;
    const nDefault = WORKERS * DEFAULT_TASKS_PER_WORKER;
    const nDerived = tasksFor(CAL_PX);

    const raceBest = async (n) => {
        let b = Infinity;
        for (let r = 0; r < 3; r++) b = Math.min(b, (await runPass(pool, source, output, CAL_PX, n)).ms);
        return b;
    };
    const msDefault = await raceBest(nDefault);
    const msDerived = nDerived === nDefault ? msDefault : await raceBest(nDerived);

    const gain = (msDefault - msDerived) / msDefault;
    const MIN_GAIN = 0.03;                       // 3% -- below this it is noise
    const useDerived = gain > MIN_GAIN;

    const elapsed = Date.now() - t_start;
    console.log('='.repeat(88));
    console.log(' autoTune — derived dispatch constants for this machine');
    console.log('='.repeat(88));
    console.log(' cpu           : ' + os.cpus()[0].model.trim());
    console.log(' workers       : ' + WORKERS + ' of ' + os.availableParallelism() + ' logical');
    console.log(' kernel        : lutMode ' + LUT_MODE);
    console.log(' calibrated on : ' + (CAL_PX / 1e6).toFixed(1) + ' MP, photo blended 5% toward noise');
    console.log(' calibration   : ' + elapsed + ' ms total\n');
    console.log('   raw passes');
    console.log('     ' + String(lo.tasks).padStart(5) + ' tasks  ' + lo.ms.toFixed(2).padStart(7) + ' ms');
    console.log('     ' + String(hi.tasks).padStart(5) + ' tasks  ' + hi.ms.toFixed(2).padStart(7) + ' ms\n');
    console.log('   DERIVED');
    console.log('     kernelMPxPerSec     ' + aggregateMPx.toFixed(1).padStart(8) + '   (aggregate across ' + WORKERS + ' workers)');
    console.log('     perTaskOverheadUs   ' + overheadUs.toFixed(1).padStart(8));
    console.log('     per-worker MPx/s    ' + (aggregateMPx / WORKERS).toFixed(1).padStart(8) + '\n');
    console.log('   IMPLIED PLAN (tasks / per worker / slice px)');
    for (const [label, px] of [['20 MP', 20e6], ['8 MP', 8388608], ['2 MP', 2097152], ['500 K', 500000]]) {
        const n = tasksFor(px);
        console.log('     ' + label.padEnd(7) + String(n).padStart(5) + ' tasks   ' +
            (n / WORKERS).toFixed(1).padStart(5) + ' /wk   ' +
            Math.ceil(px / n).toLocaleString().padStart(9) + ' px');
    }
    console.log('   BAKE-OFF — derived vs shipped default, winner kept');
    console.log('     default  ' + String(nDefault).padStart(5) + ' tasks (' + DEFAULT_TASKS_PER_WORKER + '/wk)   ' + msDefault.toFixed(2).padStart(7) + ' ms');
    console.log('     derived  ' + String(nDerived).padStart(5) + ' tasks (' + (nDerived / WORKERS).toFixed(1) + '/wk)  ' + msDerived.toFixed(2).padStart(7) + ' ms');
    console.log('     gain     ' + (gain * 100).toFixed(1) + ' %   ->  ' +
        (useDerived ? 'USE DERIVED' : 'KEEP DEFAULT (gain under ' + (MIN_GAIN * 100) + ' %, treat as noise)'));
    console.log('');

    const tuning = {
        kernelMPxPerSec: +aggregateMPx.toFixed(1),
        perTaskOverheadUs: +overheadUs.toFixed(1),
        tasksPerWorker: useDerived ? +(nDerived / WORKERS).toFixed(1) : DEFAULT_TASKS_PER_WORKER,
        source: useDerived ? 'calibrated' : 'default (calibration did not beat it)',
        workers: WORKERS,
        lutMode: LUT_MODE,
        overheadShareOfPass: BOUNDS.overheadShareOfPass,
        measuredAt: new Date().toISOString(),
    };
    console.log('   persist this, keyed by (workers, lutMode):');
    console.log('   ' + JSON.stringify(tuning));
    console.log('');

    for (const w of pool) w.postMessage({ type: 'exit' });
}

main().catch(e => { console.error(e); process.exit(1); });
