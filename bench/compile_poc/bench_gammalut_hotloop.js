/*
 * bench/compile_poc/bench_gammalut_hotloop.js
 *
 * Bench the two new compile() options:
 *   - useGammaLUT  → replace Math.pow(x, 2.4) in stage_Gamma_Inverse
 *                    with a 4096-entry float LUT lookup (lossy, fast)
 *   - hotLoop      → wrap the per-pixel body in a tight outer for-loop
 *                    that takes (input, output, n) typed arrays
 *
 * Same RGB → CMYK chain as bench_compiled.js (sRGB → GRACoL2006_Coated1v2,
 * relative). Compares 4 modes:
 *
 *   plain                       baseline (single-pixel fn, Math.pow gamma)
 *   +useGammaLUT                LUT replaces Math.pow
 *   +hotLoop                    array-in / array-out, tight loop, Math.pow
 *   +useGammaLUT +hotLoop       both stacked
 *
 * Usage (from repo root):
 *     node bench/compile_poc/bench_gammalut_hotloop.js
 *     node bench/compile_poc/bench_gammalut_hotloop.js --pixels 1000000
 *     node bench/compile_poc/bench_gammalut_hotloop.js --dump   // dump emitted source for each variant
 */

'use strict';

const path = require('path');
const { Transform, eIntent } = require('../../src/main');
const Profile = require('../../src/Profile');

const argv     = process.argv.slice(2);
const flag     = name => argv.includes(name);
const argVal   = (name, def) => {
    const i = argv.indexOf(name);
    return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : def;
};

const N        = parseInt(argVal('--pixels', '500000'), 10);
const RUNS     = parseInt(argVal('--runs',   '5'), 10);
const DUMP     = flag('--dump');

const cmykFilename = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

(async () => {
    const cmyk = new Profile();
    await cmyk.loadPromise('file:' + cmykFilename);
    if (!cmyk.loaded) throw new Error('CMYK profile failed to load');

    const t = new Transform({ dataFormat: 'device', buildLut: false, lutMode: 'float' });
    t.create('*srgb', cmyk, eIntent.relative);

    console.log('chain: ' + t.pipeline.map(s => s.stageName).join(' > '));
    console.log('pixels per run: ' + N);
    console.log('runs:           ' + RUNS);

    // -------------------------------------------------------------------
    //  Build the 4 compile variants.
    // -------------------------------------------------------------------
    const plain    = t.compile({ target: 'js' });
    const lut      = t.compile({ target: 'js', useGammaLUT: true });
    const hot      = t.compile({ target: 'js', hotLoop: true });
    const hotLut   = t.compile({ target: 'js', useGammaLUT: true, hotLoop: true });

    if (DUMP) {
        console.log('\n===== plain =====\n'    + plain.source);
        console.log('\n===== +LUT =====\n'     + lut.source);
        console.log('\n===== +hotLoop =====\n' + hot.source);
        console.log('\n===== +LUT+hotLoop =====\n' + hotLut.source);
    }

    // -------------------------------------------------------------------
    //  Correctness — each variant against t.forward().
    //  LUT path is LOSSY by design; we tolerate ~1e-3 (well under 1 code value at u8).
    // -------------------------------------------------------------------
    const probes = [
        [150/255, 100/255, 50/255],
        [0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0],
        [0.5, 0.5, 0.5],
        [0.25, 0.75, 0.10],
        [0.9, 0.1, 0.4],
    ];

    function maxAbs(a, b) {
        let m = 0;
        for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - b[i]);
            if (d > m) m = d;
        }
        return m;
    }

    function callHot(compiled, p) {
        const inp = new Float64Array(p);
        const out = new Float64Array(4);
        compiled.fn(inp, out, 1);
        return Array.from(out);
    }

    console.log('\n===== correctness vs t.forward() =====');
    let plainMax = 0, lutMax = 0, hotMax = 0, hotLutMax = 0;
    for (const p of probes) {
        const truth = t.forward(p);
        const a = plain.fn(p);
        const b = lut.fn(p);
        const c = callHot(hot,    p);
        const d = callHot(hotLut, p);
        plainMax  = Math.max(plainMax,  maxAbs(truth, a));
        lutMax    = Math.max(lutMax,    maxAbs(truth, b));
        hotMax    = Math.max(hotMax,    maxAbs(truth, c));
        hotLutMax = Math.max(hotLutMax, maxAbs(truth, d));
    }
    console.log('  plain                Δmax = ' + plainMax.toExponential(2));
    console.log('  +useGammaLUT         Δmax = ' + lutMax.toExponential(2)    + '   (lossy by design)');
    console.log('  +hotLoop             Δmax = ' + hotMax.toExponential(2));
    console.log('  +useGammaLUT+hotLoop Δmax = ' + hotLutMax.toExponential(2) + '   (lossy by design)');

    if (plainMax > 1e-9 || hotMax > 1e-9) {
        console.log('\n  ERROR: non-LUT variants must match t.forward() bit-tight (≤1e-9). Aborting bench.');
        process.exit(1);
    }
    if (lutMax > 5e-3 || hotLutMax > 5e-3) {
        console.log('\n  WARNING: LUT variants diverged more than 5e-3 — table density may need to grow.');
    }

    // -------------------------------------------------------------------
    //  Bench setup: shared input + reusable Float64 input/output buffers
    //  for the hot-loop variants (no per-pixel allocation).
    // -------------------------------------------------------------------
    const buf = new Float64Array(N * 3);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.random();

    const outBuf = new Float64Array(N * 4);

    function benchSinglePixel(compiled) {
        const tmp = [0, 0, 0];
        let acc = 0;
        const start = process.hrtime.bigint();
        for (let i = 0; i < N; i++) {
            tmp[0] = buf[i*3]; tmp[1] = buf[i*3+1]; tmp[2] = buf[i*3+2];
            const out = compiled.fn(tmp);
            acc += out[0] + out[1] + out[2] + out[3];
        }
        const end = process.hrtime.bigint();
        return { ms: Number(end - start) / 1e6, acc };
    }

    function benchHotLoop(compiled) {
        const start = process.hrtime.bigint();
        compiled.fn(buf, outBuf, N);
        const end = process.hrtime.bigint();
        let acc = 0;
        for (let i = 0; i < outBuf.length; i++) acc += outBuf[i];
        return { ms: Number(end - start) / 1e6, acc };
    }

    // Warmup
    benchSinglePixel(plain);
    benchSinglePixel(lut);
    benchHotLoop(hot);
    benchHotLoop(hotLut);

    // -------------------------------------------------------------------
    //  Bench — best of RUNS for each mode.
    // -------------------------------------------------------------------
    const variants = [
        { name: 'plain                ', kind: 'single', c: plain  },
        { name: '+useGammaLUT         ', kind: 'single', c: lut    },
        { name: '+hotLoop             ', kind: 'hot',    c: hot    },
        { name: '+useGammaLUT+hotLoop ', kind: 'hot',    c: hotLut },
    ];

    console.log('\n===== bench =====');
    const best = {};
    for (const v of variants) {
        let bestMs = Infinity;
        for (let r = 0; r < RUNS; r++) {
            const res = (v.kind === 'hot' ? benchHotLoop(v.c) : benchSinglePixel(v.c));
            if (res.ms < bestMs) bestMs = res.ms;
        }
        const mpxs = (N / bestMs / 1000).toFixed(2);
        console.log('  ' + v.name + '  best ' + bestMs.toFixed(1).padStart(6) + ' ms   ' + mpxs.padStart(5) + ' MPx/s');
        best[v.name.trim()] = bestMs;
    }

    // -------------------------------------------------------------------
    //  Speedups against runtime forward() — measure that too for context.
    // -------------------------------------------------------------------
    let runtimeBest = Infinity;
    {
        const tmp = [0, 0, 0];
        for (let r = 0; r < RUNS; r++) {
            const start = process.hrtime.bigint();
            let acc = 0;
            for (let i = 0; i < N; i++) {
                tmp[0] = buf[i*3]; tmp[1] = buf[i*3+1]; tmp[2] = buf[i*3+2];
                const out = t.forward(tmp);
                acc += out[0] + out[1] + out[2] + out[3];
            }
            const end = process.hrtime.bigint();
            const ms  = Number(end - start) / 1e6;
            if (ms < runtimeBest) runtimeBest = ms;
        }
    }
    console.log('  ' + 'runtime forward()    '.padEnd(20) + '  best ' + runtimeBest.toFixed(1).padStart(6) + ' ms   ' + (N / runtimeBest / 1000).toFixed(2).padStart(5) + ' MPx/s');

    console.log('\n===== speedup vs runtime forward() =====');
    for (const v of variants) {
        const ms = best[v.name.trim()];
        console.log('  ' + v.name + '  ' + (runtimeBest / ms).toFixed(2) + 'x');
    }

    console.log('\n===== speedup vs plain compile =====');
    const plainMs = best['plain'];
    for (const v of variants) {
        const ms = best[v.name.trim()];
        console.log('  ' + v.name + '  ' + (plainMs / ms).toFixed(2) + 'x');
    }
})().catch(err => {
    console.error('bench failed:', err);
    process.exit(1);
});
