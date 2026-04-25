/*
 * bench/compile_poc/bench_instrumented.js
 *
 * Run an INSTRUMENTED compile of the RGB→CMYK pipeline. Each stage gets a
 * hrtime() tap before & after. After N calls we read store._instTime[] to
 * see which stage dominates.
 *
 * IMPORTANT CAVEAT
 * ----------------
 *   Each timer tap is process.hrtime.bigint(), which costs ~50-100ns +
 *   2 BigInt allocations + a Number conversion. That's similar to or
 *   bigger than each per-stage's actual work (10-50ns). So the absolute
 *   "ns per stage" numbers are inflated by a roughly-constant overhead.
 *
 *   The PERCENT column is the trustworthy bit — it tells you which stage
 *   is hottest in relative terms. We also run an UN-instrumented compile
 *   in parallel and report the speedup ratio so you can see what the
 *   instrumentation overhead cost in throughput terms.
 *
 * Usage:
 *     node bench/compile_poc/bench_instrumented.js
 *     node bench/compile_poc/bench_instrumented.js --pixels 200000 --runs 3
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
const N    = parseInt(argVal('--pixels', '200000'), 10);
const RUNS = parseInt(argVal('--runs',   '3'), 10);

const cmykFilename = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

(async () => {
    const cmyk = new Profile();
    await cmyk.loadPromise('file:' + cmykFilename);
    if (!cmyk.loaded) throw new Error('CMYK profile failed to load');

    const t = new Transform({ dataFormat: 'device', buildLut: false, lutMode: 'float' });
    t.create('*srgb', cmyk, eIntent.relative);

    const compiledPlain = t.compile({ target: 'js' });
    const compiledInst  = t.compile({ target: 'js', instrument: true });

    console.log('chain:', t.pipeline.map(s => s.stageName).join(' > '));
    console.log('plain emit coverage:        ', compiledPlain.coverage.emitted.length, 'emitted,', compiledPlain.coverage.fallback.length, 'fallback');
    console.log('instrumented emit coverage: ', compiledInst.coverage.emitted.length,  'emitted,', compiledInst.coverage.fallback.length,  'fallback');

    // Quick correctness — instrumented should be bit-exact with plain.
    const probe = [150/255, 100/255, 50/255];
    const a = compiledPlain.fn(probe);
    const b = compiledInst.fn(probe);
    let dmax = 0;
    for (let i = 0; i < a.length; i++) dmax = Math.max(dmax, Math.abs(a[i] - b[i]));
    console.log('correctness Δmax(plain vs instrumented):', dmax);

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
        const end = process.hrtime.bigint();
        return { ms: Number(end - start) / 1e6, acc };
    }

    // Warmup
    for (let i = 0; i < 3; i++) {
        timeFn(compiledPlain.fn);
        timeFn(compiledInst.fn);
    }
    Transform.instrumentReset(compiledInst);

    let bestPlain = Infinity;
    let bestInst  = Infinity;
    for (let r = 0; r < RUNS; r++) {
        const p = timeFn(compiledPlain.fn);
        if (p.ms < bestPlain) bestPlain = p.ms;
    }
    // For the instrumented run we want clean counters, so reset and run.
    Transform.instrumentReset(compiledInst);
    for (let r = 0; r < RUNS; r++) {
        const i = timeFn(compiledInst.fn);
        if (i.ms < bestInst) bestInst = i.ms;
    }

    console.log('');
    console.log('===== throughput (best of ' + RUNS + ' x ' + N + ' px) =====');
    console.log('  plain compiled        ' + bestPlain.toFixed(1).padStart(7) + ' ms   ' + (N / (bestPlain * 1000)).toFixed(2).padStart(6) + ' MPx/s   (1.00x)');
    console.log('  instrumented          ' + bestInst.toFixed(1).padStart(7)  + ' ms   ' + (N / (bestInst  * 1000)).toFixed(2).padStart(6) + ' MPx/s   (' + (bestPlain / bestInst).toFixed(2) + 'x)');
    console.log('  instrumentation cost  ~' + ((bestInst - bestPlain) / bestPlain * 100).toFixed(0) + '% slowdown — expected, this is timer overhead, not real cost');

    console.log('');
    const report = Transform.instrumentReport(compiledInst);
    console.log(report.text);

    console.log('');
    console.log('===== caveat — read this before trusting the numbers =====');
    console.log('Each per-stage timer pair adds ~50-100ns AND wrapping each stage in an');
    console.log('opaque block { _hr(); ... _hr(); } prevents V8 from hoisting common');
    console.log('values across stage boundaries. So the absolute ns/call numbers are');
    console.log('inflated unevenly: Math-heavy stages (e.g. gamma_inverse with 3x');
    console.log('Math.pow) get punished less by the overhead because their own work');
    console.log('dominates; tiny stages (the 1D curves at ~10ns of real work) look');
    console.log('bigger than they really are.');
    console.log('');
    console.log('USE THIS REPORT FOR:');
    console.log('  - smoke-testing a new emitter (every stage fires, nothing is hit unexpectedly often)');
    console.log('  - rough ordering: which stages are in the same league?');
    console.log('  - debugging: confirming a stage was called N times, not 0 or 2N');
    console.log('USE bench_body_variants.js (NOP-differential) FOR:');
    console.log('  - "what does this stage really cost?" — does not perturb the JIT');
    console.log('  - "if I remove this, how much do I save?"');
})().catch(e => { console.error(e); process.exit(1); });
