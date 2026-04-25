/*
 * bench/compile_poc/bench_compiled_cmyk2cmyk.js
 *
 * Same shape as bench_compiled.js but for a CMYK → CMYK chain
 * (GRACoL → USWebCoatedSWOP). This is the "pure LUT" path — there's
 * no sRGB inverse-gamma stage so Math.pow(x, 2.4) doesn't dominate
 * the body. It tells us what the speedup looks like when the
 * compiled body's hot spot is trilinear interp + curves rather than
 * gamma. Useful contrast against the RGB→CMYK numbers.
 *
 * Usage:
 *     node bench/compile_poc/bench_compiled_cmyk2cmyk.js
 *     node bench/compile_poc/bench_compiled_cmyk2cmyk.js --pixels 1000000
 *     node bench/compile_poc/bench_compiled_cmyk2cmyk.js --dump
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
const DUMP_SRC = flag('--dump');
const RUNS     = parseInt(argVal('--runs', '5'), 10);

const srcCmykIcc = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');
const dstCmykIcc = path.join(__dirname, '..', 'lcms_compat', 'profiles', 'USWebCoatedSWOP.icc');

(async () => {
    const src = new Profile();
    const dst = new Profile();
    await src.loadPromise('file:' + srcCmykIcc);
    await dst.loadPromise('file:' + dstCmykIcc);
    if (!src.loaded) throw new Error('source CMYK profile failed to load');
    if (!dst.loaded) throw new Error('destination CMYK profile failed to load — make sure ' + dstCmykIcc + ' exists');

    const t = new Transform({
        dataFormat: 'device',
        buildLut:   false,
        lutMode:    'float',
    });
    t.create(src, dst, eIntent.relative);

    console.log('chain: ' + t.pipeline.map(s => s.stageName).join(' > '));

    let compiled;
    let compileErr = null;
    try {
        compiled = t.compile({ target: 'js' });
    } catch (e) {
        compileErr = e;
    }

    if (compileErr) {
        console.log('\ncompile() threw — likely missing emitter for one of the CMYK→CMYK stages:');
        console.log('  ' + compileErr.message);
        console.log('\nThis is the useful signal — tells us which emitters to add for the CMYK->CMYK path.');
        process.exit(0);
    }

    if (DUMP_SRC) {
        console.log('===== emitted source =====');
        console.log(compiled.source);
    }

    console.log('\n===== coverage =====');
    console.log('  emitted  : ' + compiled.coverage.emitted.length);
    compiled.coverage.emitted.forEach(s => console.log('             ' + s));
    console.log('  fallback : ' + compiled.coverage.fallback.length);
    compiled.coverage.fallback.forEach(s => console.log('             ' + s));

    if (compiled.coverage.fallback.length > 0) {
        console.log('\nNote: fallback stages still go through the runtime walker and bound .call(), so the');
        console.log('compiled fn may not show its full speedup until those have emit_js_* implementations.');
    }

    // Correctness
    console.log('\n===== correctness vs t.forward() =====');
    const probes = [
        [0.10, 0.20, 0.30, 0.40],
        [0.0, 0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0, 1.0],
        [0.5, 0.5, 0.5, 0.5],
        [0.25, 0.75, 0.10, 0.90],
        [0.9, 0.1, 0.4, 0.0],
    ];
    let maxAbsAll = 0;
    for (const p of probes) {
        const a = t.forward(p);
        const b = compiled.fn(p);
        let maxAbs = 0;
        for (let i = 0; i < a.length; i++) {
            const d = Math.abs(a[i] - b[i]);
            if (d > maxAbs) maxAbs = d;
        }
        if (maxAbs > maxAbsAll) maxAbsAll = maxAbs;
        console.log(
            '  ' + JSON.stringify(p),
            '\n    runtime  : [' + a.map(v => v.toFixed(6)).join(', ') + ']',
            '\n    compiled : [' + b.map(v => v.toFixed(6)).join(', ') + ']',
            '\n    Δmax     : ' + maxAbs.toExponential(2)
        );
    }
    console.log('  overall Δmax = ' + maxAbsAll.toExponential(2));

    if (maxAbsAll > 1e-3) {
        console.log('\n  ABORT: compiled output diverges from the runtime by ' + maxAbsAll.toExponential(2) + '.');
        console.log('  Likely cause(s):');
        console.log('   (1) compile() currently hardcodes a 3-channel RGB preamble');
        console.log('       (var r = input[0], g = input[1], b = input[2];) — CMYK input');
        console.log('       needs (var d0 = input[0], d1 = input[1], d2 = input[2], d3 = input[3];)');
        console.log('   (2) tetrahedralInterp4D and stage_PCSv2_to_PCSv4 have no emit_js_*');
        console.log('       implementation, so they fall through to the runtime stub.');
        console.log('  Skipping bench — numbers would be meaningless. Add the missing emitters');
        console.log('  + a multi-channel-input preamble to compile() and re-run.');
        process.exit(0);
    }

    // Bench
    const buf = new Float64Array(N * 4);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.random();

    function benchRuntime() {
        let acc = 0;
        const tmp = [0, 0, 0, 0];
        const start = process.hrtime.bigint();
        for (let i = 0; i < N; i++) {
            tmp[0] = buf[i*4];
            tmp[1] = buf[i*4 + 1];
            tmp[2] = buf[i*4 + 2];
            tmp[3] = buf[i*4 + 3];
            const out = t.forward(tmp);
            acc += out[0] + out[1] + out[2] + out[3];
        }
        return { ms: Number(process.hrtime.bigint() - start) / 1e6, acc };
    }

    function benchCompiled() {
        let acc = 0;
        const tmp = [0, 0, 0, 0];
        const fn  = compiled.fn;
        const start = process.hrtime.bigint();
        for (let i = 0; i < N; i++) {
            tmp[0] = buf[i*4];
            tmp[1] = buf[i*4 + 1];
            tmp[2] = buf[i*4 + 2];
            tmp[3] = buf[i*4 + 3];
            const out = fn(tmp);
            acc += out[0] + out[1] + out[2] + out[3];
        }
        return { ms: Number(process.hrtime.bigint() - start) / 1e6, acc };
    }

    for (let i = 0; i < 3; i++) { benchRuntime(); benchCompiled(); }

    console.log('\n===== bench (CMYK->CMYK) =====');
    console.log('pixels per run : ' + N);
    console.log('runs           : ' + RUNS);
    console.log('');

    let bestR = Infinity, bestC = Infinity;
    for (let r = 0; r < RUNS; r++) {
        const a = benchRuntime();
        const b = benchCompiled();
        if (a.ms < bestR) bestR = a.ms;
        if (b.ms < bestC) bestC = b.ms;
        console.log(
            '  run ' + (r + 1) + '   ' +
            'runtime ' + a.ms.toFixed(1).padStart(7) + ' ms  ' +
            (N / (a.ms * 1000)).toFixed(2).padStart(6) + ' MPx/s   |   ' +
            'compiled ' + b.ms.toFixed(1).padStart(7) + ' ms  ' +
            (N / (b.ms * 1000)).toFixed(2).padStart(6) + ' MPx/s   ' +
            'speedup ' + (a.ms / b.ms).toFixed(2) + 'x'
        );
    }
    console.log('');
    console.log('  best runtime  : ' + bestR.toFixed(1) + ' ms  (' + (N / (bestR * 1000)).toFixed(2) + ' MPx/s)');
    console.log('  best compiled : ' + bestC.toFixed(1) + ' ms  (' + (N / (bestC * 1000)).toFixed(2) + ' MPx/s)');
    console.log('  best speedup  : ' + (bestR / bestC).toFixed(2) + 'x');
})().catch(e => { console.error(e); process.exit(1); });
