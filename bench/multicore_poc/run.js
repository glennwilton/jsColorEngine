/**
 * bench/multicore_poc/run.js
 * ==========================
 *
 * FIRST EXPERIMENT for the multicore design in docs/deepdive/multicore.md.
 * Needs no engine changes at all — it uses the public API only.
 *
 * Question it answers: does a worker-parallel image path scale, and what does
 * "Model A" (transfer, no SharedArrayBuffer) actually cost?
 *
 *   - Build the LUT once on the main thread, ship it to workers as portable
 *     JSON. No profiles, no ICC parsing, no LUT rebuild per worker.
 *   - Split the image into N ordinary ArrayBuffers, transfer them (zero-copy
 *     handover), convert, transfer the results back, reassemble.
 *   - Verify byte-identical against a single-threaded run. A speedup that
 *     produces different pixels is not a speedup.
 *   - Report scaling at 1/2/4/8/... workers, and measure the split+reassemble
 *     copy overhead SEPARATELY, since that is the number that decides whether
 *     Model B (SharedArrayBuffer, zero copy, far more invasive) is ever worth
 *     building.
 *
 * Deliberately Model A: no SharedArrayBuffer, so no cross-origin isolation
 * requirement, no imported WASM memory, no reclaim rework. Each worker owns a
 * private Transform and private WASM memory.
 *
 * Run:
 *   node bench/multicore_poc/run.js
 *   node bench/multicore_poc/run.js --pixels 20000000 --workers 1,2,4,8,16
 *   node bench/multicore_poc/run.js --lutMode int-wasm-simd
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Worker } = require('worker_threads');
const { Transform, Profile, eIntent } = require('../../src/main');

// ----------------------------------------------------------------------

function argValue(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return (i !== -1 && process.argv[i + 1]) ? process.argv[i + 1] : fallback;
}

const PIXELS   = Number(argValue('pixels', 8000000));      // ~8 MP, a typical camera frame
const LUT_MODE = argValue('lutMode', 'int');
const REPS     = Number(argValue('reps', 5));

// os.availableParallelism() respects affinity and cgroup limits, unlike
// os.cpus().length — it is the right hint in Node. Browsers have
// navigator.hardwareConcurrency, with the same "hint, not a guarantee" caveat.
const AVAILABLE = (typeof os.availableParallelism === 'function')
    ? os.availableParallelism() : os.cpus().length;

/**
 * Resolve a worker-count spec. Prototypes the eventual public option:
 *
 *   <n>     exactly n
 *   'max'   every core the runtime admits to — assertive, saturates the box
 *   'auto'  a fraction of them, leaving headroom for the main thread (which
 *           still does the split and reassemble) and for the rest of the
 *           system. A library that pins every core by default is a bad
 *           citizen, so 'auto' should be the friendly one.
 *
 * The auto fraction is tunable here precisely so this experiment can show
 * where the knee actually is — logical cores are not equal to usable
 * throughput once hyperthreading is in play, and integer-heavy kernels
 * typically get well under 2x from a hyperthread pair.
 */
const AUTO_FRACTION = Number(argValue('autoFraction', 0.75));

/**
 * MEASURED: the control variable is slice size per worker, not image size.
 *
 * At 262,144 px the same image gives 2.56x on 4 workers (65 K px each) and
 * collapses to 1.22x on 8 (32 K px each) — the slices get small enough that
 * the copy and the message round-trip stop being amortised. So 'auto' should
 * derive the worker count from how much work each one would get, and only
 * incidentally fall back to 1:
 *
 *     workers = clamp(floor(pixels / MIN_SLICE), 1, autoMax)
 *
 * That predicts the measured optimum at every size tried: 1 worker at 16 K and
 * 64 K (where 8 workers lost), 4 at 262 K (the measured best), and the autoMax
 * cap above ~1 MP.
 */
const MIN_SLICE_PIXELS = Number(argValue('minSlice', 65536));

// Fallback when the runtime reports nothing. Browsers can return undefined on
// older engines; 4 is the conventional guess.
const REPORTED = AVAILABLE || 4;

// Floor for 'auto'. NOT a claim about real cores — a hedge against runtimes
// that under-report. Safari and privacy-hardened browsers clamp
// navigator.hardwareConcurrency, so trusting a reported "2" on a 10-core Mac
// would idle most of the machine. Mild oversubscription costs far less than
// that, and the slice rule below caps it on small images anyway.
const AUTO_MIN_WORKERS = Number(argValue('autoMin', 4));

function resolveWorkerCount(spec, pixelCount) {
    if (spec === 'max') return REPORTED;
    if (spec === 'auto') {
        var autoMax = Math.max(AUTO_MIN_WORKERS, Math.floor(REPORTED * AUTO_FRACTION));
        if (pixelCount === undefined) return autoMax;
        // Slice floor still wins: no point spawning 4 for a thumbnail.
        var bySlice = Math.floor(pixelCount / MIN_SLICE_PIXELS);
        return Math.max(1, Math.min(bySlice, autoMax));
    }
    const n = Number(spec);
    return (n > 0) ? n : 1;
}

const WORKER_SPECS = argValue('workers', '1,2,4,8').split(',').map(s => s.trim());
const WORKER_COUNTS = WORKER_SPECS.map(function(s){ return resolveWorkerCount(s, PIXELS); })
    .filter((n, i, a) => n > 0 && a.indexOf(n) === i);

// ----------------------------------------------------------------------

function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
}

function makeNoise(pixelCount, channels) {
    const out = new Uint8ClampedArray(pixelCount * channels);
    let seed = 0x13579bdf;
    for (let i = 0; i < out.length; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) | 0;
        out[i] = (seed >>> 16) & 0xFF;
    }
    return out;
}

/**
 * Partition into N slices on PIXEL boundaries, each aligned to 64 pixels so
 * that no slice boundary falls inside a cache line on either the input or the
 * output side. Misaligned seams make neighbouring workers share a line and can
 * cost 20-30% for no visible reason — see multicore.md.
 */
function partition(pixelCount, workers) {
    const align = 64;
    const per = Math.ceil(pixelCount / workers / align) * align;
    const slices = [];
    for (let start = 0; start < pixelCount; start += per) {
        slices.push({ start: start, length: Math.min(per, pixelCount - start) });
    }
    return slices;
}

// ----------------------------------------------------------------------

function spawnPool(count, lutJson, inChannels) {
    return Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, 'worker.js'), {
            workerData: {
                lutJson: lutJson,
                lutMode: LUT_MODE,
                inChannels: inChannels,
                warmupPixels: 65536,
            },
        });
        worker.once('message', (msg) => {
            if (msg.type === 'ready') resolve(worker);
            else reject(new Error('unexpected first message: ' + msg.type));
        });
        worker.once('error', reject);
    })));
}

/** One parallel pass: split -> transfer -> convert -> transfer back -> reassemble. */
function runParallel(pool, pixels, pixelCount, inCh, outCh) {
    const slices = partition(pixelCount, pool.length);
    const output = new Uint8ClampedArray(pixelCount * outCh);

    return new Promise((resolve, reject) => {
        let pending = slices.length;
        let nextSlice = 0;

        const dispatch = (worker) => {
            if (nextSlice >= slices.length) return;
            const index = nextSlice++;
            const s = slices[index];
            // .slice() copies — this is Model A's cost, and it is what the
            // "copy overhead" row below measures in isolation.
            const buffer = pixels.buffer.slice(
                s.start * inCh, (s.start + s.length) * inCh);
            worker.postMessage(
                { type: 'slice', index: index, buffer: buffer, pixelCount: s.length },
                [buffer]
            );
        };

        pool.forEach((worker) => {
            worker.on('message', (msg) => {
                if (msg.type !== 'done') return;
                const s = slices[msg.index];
                output.set(new Uint8ClampedArray(msg.buffer), s.start * outCh);
                if (--pending === 0) resolve(output);
                else dispatch(worker);
            });
            worker.on('error', reject);
            dispatch(worker);
        });
    });
}

/**
 * BATCH mode — task-parallel instead of data-parallel.
 *
 * Each worker takes a WHOLE image and, on finishing, pulls the next one off
 * the queue. Work-stealing, so uneven image sizes balance themselves.
 *
 * The reason this matters: it has no slice floor. Data-parallel splitting
 * loses below ~64 K pixels per slice, so small images cannot be accelerated
 * that way at all — but one whole small image per worker is fine, because the
 * unit of work is never subdivided. The two modes cover complementary regions,
 * and a real scheduler would just put both kinds of item on one queue.
 *
 * Cost: `depth` images resident at once. That is worker-count, NOT batch size
 * — load lazily as workers free up and the memory objection mostly evaporates.
 */
function runBatch(pool, images, inCh, outCh) {
    const results = new Array(images.length);
    return new Promise((resolve, reject) => {
        let pending = images.length;
        let next = 0;

        const dispatch = (worker) => {
            if (next >= images.length) return;
            const index = next++;
            const image = images[index];
            const buffer = image.pixels.buffer.slice(0);
            worker.postMessage(
                { type: 'slice', index: index, buffer: buffer, pixelCount: image.pixelCount },
                [buffer]
            );
        };

        pool.forEach((worker) => {
            worker.on('message', (msg) => {
                if (msg.type !== 'done') return;
                results[msg.index] = new Uint8ClampedArray(msg.buffer);
                if (--pending === 0) resolve(results);
                else dispatch(worker);
            });
            worker.on('error', reject);
            dispatch(worker);
        });
    });
}

/** Split + reassemble with NO conversion — isolates Model A's copy cost. */
function copyOverheadOnly(pixels, pixelCount, inCh, outCh, workers) {
    const slices = partition(pixelCount, workers);
    const output = new Uint8ClampedArray(pixelCount * outCh);
    for (const s of slices) {
        const buffer = pixels.buffer.slice(s.start * inCh, (s.start + s.length) * inCh);
        // stand in for the returned slice: same size as a real output slice
        output.set(new Uint8ClampedArray(s.length * outCh), s.start * outCh);
        if (buffer.byteLength === 0) throw new Error('empty slice');
    }
    return output;
}

// ----------------------------------------------------------------------

async function main() {
    const cmykPath = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');
    const cmyk = new Profile();
    cmyk.loadBinary(fs.readFileSync(cmykPath), () => {}, false);

    console.log('='.repeat(78));
    console.log(' Multicore experiment — Model A (transfer, no SharedArrayBuffer)');
    console.log('='.repeat(78));
    console.log(' workflow      : sRGB -> GRACoL (3 in, 4 out), lutMode ' + LUT_MODE);
    console.log(' pixels/pass   : ' + PIXELS.toLocaleString());
    console.log(' cores visible : ' + AVAILABLE + '  (os.availableParallelism)');
    console.log(' median of     : ' + REPS);

    const built = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: LUT_MODE });
    built.create('*sRGB', cmyk, eIntent.relative);

    // Serialise the baked LUT once. Workers rebuild from this alone.
    const lutJson = built.toJSON();

    // IMPORTANT: the single-threaded reference is built from the SAME JSON the
    // workers get, not from `built` directly.
    //
    // The portable-LUT round-trip is lossy by up to 1 LSB — toJSON quantises
    // the CLUT to u16 and setLut re-derives the int LUT from that, so a
    // round-tripped transform differs from the freshly-built one on ~0.07 % of
    // output bytes by exactly 1. Well inside our published accuracy envelope,
    // but NOT bit-identical, and comparing a round-tripped worker against a
    // freshly-built reference would report a correctness failure that is really
    // just LUT provenance. Both sides must carry the same LUT for the
    // comparison to mean "did parallelism change the answer".
    //
    // A real implementation should ship the exact CLUT to workers rather than
    // JSON, which sidesteps both the quantisation and the parse cost.
    const transform = Transform.fromJSON(lutJson, { dataFormat: 'int8', lutMode: LUT_MODE });

    const inCh = transform.inputChannels;
    const outCh = transform.outputChannels;
    const pixels = makeNoise(PIXELS, inCh);
    const lutBytes = JSON.stringify(lutJson).length;
    console.log(' LUT to worker : ' + (lutBytes / 1024).toFixed(0) + ' KB of portable JSON'
        + ' (no profiles, no rebuild)');
    console.log('');

    // ---- single-threaded baseline ----
    for (let w = 0; w < 2; w++) transform.transformArray(pixels, false, false, false, PIXELS);
    const baseTimes = [];
    let expected = null;
    for (let r = 0; r < REPS; r++) {
        const t0 = process.hrtime.bigint();
        const out = transform.transformArray(pixels, false, false, false, PIXELS);
        baseTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
        if (expected === null) expected = out;
    }
    const baseMs = median(baseTimes);
    const baseMpx = PIXELS / (baseMs * 1000);
    console.log('  single-threaded baseline   ' + baseMpx.toFixed(1).padStart(7) + ' MPx/s   ('
        + baseMs.toFixed(1) + ' ms)');
    console.log('');
    console.log('  workers   MPx/s   speedup   efficiency   copy overhead   identical');
    console.log('  -------  -------  -------   ----------   -------------   ---------');

    for (const count of WORKER_COUNTS) {
        const pool = await spawnPool(count, lutJson, inCh);

        // warm the parallel path too, so we time steady state
        await runParallel(pool, pixels, PIXELS, inCh, outCh);

        const times = [];
        let actual = null;
        for (let r = 0; r < REPS; r++) {
            const t0 = process.hrtime.bigint();
            const out = await runParallel(pool, pixels, PIXELS, inCh, outCh);
            times.push(Number(process.hrtime.bigint() - t0) / 1e6);
            if (actual === null) actual = out;
        }

        // copy cost with the same slicing, no conversion
        const copyTimes = [];
        for (let r = 0; r < REPS; r++) {
            const t0 = process.hrtime.bigint();
            copyOverheadOnly(pixels, PIXELS, inCh, outCh, count);
            copyTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }

        let identical = true;
        for (let i = 0; i < expected.length; i++) {
            if (expected[i] !== actual[i]) { identical = false; break; }
        }

        const ms = median(times);
        const mpx = PIXELS / (ms * 1000);
        const speedup = mpx / baseMpx;
        const copyMs = median(copyTimes);

        console.log('  ' + String(count).padStart(7)
            + mpx.toFixed(1).padStart(9)
            + (speedup.toFixed(2) + 'x').padStart(9)
            + ((speedup / count * 100).toFixed(0) + '%').padStart(13)
            + (copyMs.toFixed(1) + ' ms').padStart(16)
            + ('  ' + (identical ? 'yes' : '*** NO ***')).padStart(12));

        pool.forEach(w => w.postMessage({ type: 'exit' }));
        await Promise.all(pool.map(w => new Promise(res => w.once('exit', res))));
    }

    // ---- BATCH mode: many small images, one per worker ----------------
    // The case data-parallel splitting cannot serve. Uses the same sizes that
    // lost above, to show the two modes are complementary rather than rivals.
    const BATCH_SIZES = [16384, 65536, 262144];
    console.log('');
    console.log('  BATCH mode — whole images, work-stealing (no slice floor)');
    console.log('  img pixels   count   1 thread   pooled    speedup   identical');
    console.log('  ----------   -----   --------   -------   -------   ---------');

    for (const size of BATCH_SIZES) {
        const count = Math.max(8, Math.ceil(2000000 / size));
        const images = [];
        for (let i = 0; i < count; i++) {
            images.push({ pixels: makeNoise(size, inCh), pixelCount: size });
        }

        // serial reference
        for (let w = 0; w < 2; w++) images.forEach(im => transform.transformArray(im.pixels, false, false, false, im.pixelCount));
        const serialTimes = [];
        let serialOut = null;
        for (let r = 0; r < 3; r++) {
            const t0 = process.hrtime.bigint();
            const outs = images.map(im => transform.transformArray(im.pixels, false, false, false, im.pixelCount));
            serialTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
            if (serialOut === null) serialOut = outs.map(o => Uint8ClampedArray.from(o));
        }
        const serialMs = median(serialTimes);

        const poolSize = resolveWorkerCount('auto', size * count);
        const pool = await spawnPool(poolSize, lutJson, inCh);
        await runBatch(pool, images, inCh, outCh);
        const parTimes = [];
        let parOut = null;
        for (let r = 0; r < 3; r++) {
            const t0 = process.hrtime.bigint();
            const outs = await runBatch(pool, images, inCh, outCh);
            parTimes.push(Number(process.hrtime.bigint() - t0) / 1e6);
            if (parOut === null) parOut = outs;
        }
        const parMs = median(parTimes);

        let identical = true;
        outer: for (let i = 0; i < serialOut.length; i++) {
            for (let j = 0; j < serialOut[i].length; j++) {
                if (serialOut[i][j] !== parOut[i][j]) { identical = false; break outer; }
            }
        }

        const totalPx = size * count;
        console.log('  ' + String(size).padStart(10) + String(count).padStart(8)
            + (totalPx / (serialMs * 1000)).toFixed(1).padStart(11)
            + (totalPx / (parMs * 1000)).toFixed(1).padStart(10)
            + ((serialMs / parMs).toFixed(2) + 'x').padStart(10)
            + ('  ' + (identical ? 'yes' : '*** NO ***')).padStart(12)
            + '   (' + poolSize + ' workers)');

        pool.forEach(w => w.postMessage({ type: 'exit' }));
        await Promise.all(pool.map(w => new Promise(res => w.once('exit', res))));
    }

    console.log('');
    console.log('  Efficiency = speedup / workers. Copy overhead is the split+reassemble');
    console.log('  cost alone — if it is small next to the time saved, Model B');
    console.log('  (SharedArrayBuffer, zero copy, far more invasive) is not worth building.');
    console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
