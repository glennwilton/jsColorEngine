/*
 * bench/compile_poc/bench_profilable.js
 *
 * 1. Throughput compare: plain compiled vs profilable compiled.
 *    Profilable mode adds function-call overhead per stage but in return
 *    each stage shows up by name in the V8 CPU profiler.
 * 2. Generates a node --prof tick log in this dir if you re-invoke node
 *    with `node --prof bench/compile_poc/bench_profilable.js`. Process
 *    the resulting `isolate-*-v8.log` with `node --prof-process` to see
 *    per-stage attribution.
 *
 * Usage:
 *     node bench/compile_poc/bench_profilable.js
 *     node --prof bench/compile_poc/bench_profilable.js --pixels 5000000
 *     node --prof-process isolate-*-v8.log > prof.txt
 */

'use strict';

const path = require('path');
const { Transform, eIntent } = require('../../src/main');
const Profile = require('../../src/Profile');

const argv   = process.argv.slice(2);
const argVal = (name, def) => {
    const i = argv.indexOf(name);
    return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : def;
};
const N    = parseInt(argVal('--pixels', '500000'), 10);
const RUNS = parseInt(argVal('--runs',   '5'), 10);
const PROF = argv.includes('--prof-mode');

const cmykFilename = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

(async () => {
    const cmyk = new Profile();
    await cmyk.loadPromise('file:' + cmykFilename);
    if (!cmyk.loaded) throw new Error('CMYK profile failed to load');

    const t = new Transform({ dataFormat: 'device', buildLut: false, lutMode: 'float' });
    t.create('*srgb', cmyk, eIntent.relative);

    const plain      = t.compile({ target: 'js' });
    const profilable = t.compile({ target: 'js', profilable: true });

    console.log('chain:', t.pipeline.map(s => s.stageName).join(' > '));
    console.log('plain:        ', plain.coverage.emitted.length, 'emitted /', plain.coverage.fallback.length, 'fallback');
    console.log('profilable:   ', profilable.coverage.emitted.length, 'emitted /', profilable.coverage.fallback.length, 'fallback');

    // Correctness
    let dmax = 0;
    for (let i = 0; i < 200; i++) {
        const inp = [Math.random(), Math.random(), Math.random()];
        const a = plain.fn(inp);
        const b = profilable.fn(inp);
        for (let j = 0; j < a.length; j++) dmax = Math.max(dmax, Math.abs(a[j] - b[j]));
    }
    console.log('correctness Δmax (plain vs profilable) over 200 random px:', dmax);

    // Bench
    const buf = new Float64Array(N * 3);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.random();

    function timeFn(fn) {
        let acc = 0;
        const tmp = [0, 0, 0];
        const start = process.hrtime.bigint();
        for (let i = 0; i < N; i++) {
            tmp[0] = buf[i*3];
            tmp[1] = buf[i*3 + 1];
            tmp[2] = buf[i*3 + 2];
            const out = fn(tmp);
            acc += out[0] + out[1] + out[2] + out[3];
        }
        return { ms: Number(process.hrtime.bigint() - start) / 1e6, acc };
    }

    // Warm
    for (let i = 0; i < 3; i++) { timeFn(plain.fn); timeFn(profilable.fn); }

    let bestPlain = Infinity, bestProf = Infinity;
    for (let r = 0; r < RUNS; r++) {
        const a = timeFn(plain.fn);
        const b = timeFn(profilable.fn);
        if (a.ms < bestPlain) bestPlain = a.ms;
        if (b.ms < bestProf)  bestProf  = b.ms;
    }

    console.log('\n===== throughput (best of ' + RUNS + ' x ' + N + ' px) =====');
    const fmt = (ms) => ms.toFixed(1).padStart(7) + ' ms   ' + (N / (ms * 1000)).toFixed(2).padStart(6) + ' MPx/s';
    console.log('  plain compiled        ' + fmt(bestPlain) + '   1.00x');
    console.log('  profilable            ' + fmt(bestProf)  + '   ' + (bestPlain / bestProf).toFixed(2) + 'x');
    const overheadPct = ((bestProf - bestPlain) / bestPlain) * 100;
    console.log('  per-stage call overhead: +' + overheadPct.toFixed(1) + '%');

    if (PROF) {
        // Hot loop just for the profiler — single tight call site so all
        // samples land inside _s*_* fns, not in the bench harness.
        console.log('\nrunning hot loop for profiler attribution (no output)...');
        for (let r = 0; r < 3; r++) timeFn(profilable.fn);
        console.log('done — process the isolate-*-v8.log via:  node --prof-process isolate-*-v8.log');
    }

    console.log('\nTo see per-stage profiler attribution, run with V8 --prof:');
    console.log('  node --prof bench/compile_poc/bench_profilable.js --prof-mode --pixels 2000000');
    console.log('  node --prof-process isolate-*-v8.log | head -80');
})().catch(e => { console.error(e); process.exit(1); });
