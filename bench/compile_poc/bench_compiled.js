/*
 * bench/compile_poc/bench_compiled.js
 *
 * Proof-of-concept benchmark for monolithic compiled pipeline vs the
 * runtime stage walker. Same RGB → CMYK chain as
 * probe_rgb_to_cmyk.js (sRGB → GRACoL2006_Coated1v2.icc, relative).
 *
 * Usage (from repo root):
 *     node bench/compile_poc/bench_compiled.js
 *     node bench/compile_poc/bench_compiled.js --dump      // also print emitted source
 *     node bench/compile_poc/bench_compiled.js --pixels 1000000
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

const cmykFilename = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

(async () => {
    const cmyk = new Profile();
    await cmyk.loadPromise('file:' + cmykFilename);
    if (!cmyk.loaded) throw new Error('CMYK profile failed to load');

    // No-LUT, full stage pipeline: this is the path the compiler is for.
    const t = new Transform({
        dataFormat: 'device',
        buildLut:   false,
        lutMode:    'float',
    });
    t.create('*srgb', cmyk, eIntent.relative);

    // Explicitly opt OUT of useGammaLUT — this bench asserts bit-exact
    // (Δmax ≤ 1e-9) against t.forward(), so we need the bit-exact Math.pow
    // path. compile() now defaults useGammaLUT=true (lcms parity) so this
    // override is needed to preserve the regression test.
    const compiled = t.compile({ target: 'js', useGammaLUT: false });

    if (DUMP_SRC) {
        console.log('===== emitted source =====');
        console.log(compiled.source);
    }

    console.log('===== coverage =====');
    console.log('  emitted  : ' + compiled.coverage.emitted.length);
    compiled.coverage.emitted.forEach(s => console.log('             ' + s));
    console.log('  fallback : ' + compiled.coverage.fallback.length);
    compiled.coverage.fallback.forEach(s => console.log('             ' + s));

    // -------------- correctness --------------
    console.log('\n===== correctness vs t.forward() =====');
    const probes = [
        [150/255, 100/255, 50/255],
        [0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0],
        [0.5, 0.5, 0.5],
        [0.25, 0.75, 0.10],
        [0.9, 0.1, 0.4],
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

    if (maxAbsAll > 1e-9) {
        console.log('\n  WARNING: compiled output diverges from runtime by > 1e-9 — likely a bug in an emitter.');
    }

    // -------------- bench --------------
    const buf = new Float64Array(N * 3);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.random();

    function benchRuntime() {
        let acc = 0;
        const tmp = [0, 0, 0];
        const start = process.hrtime.bigint();
        for (let i = 0; i < N; i++) {
            tmp[0] = buf[i*3];
            tmp[1] = buf[i*3 + 1];
            tmp[2] = buf[i*3 + 2];
            const out = t.forward(tmp);
            acc += out[0] + out[1] + out[2] + out[3];
        }
        const end = process.hrtime.bigint();
        return { ms: Number(end - start) / 1e6, acc };
    }

    function benchCompiled() {
        let acc = 0;
        const tmp = [0, 0, 0];
        const fn  = compiled.fn;
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

    // warm-up — let TurboFan tier each loop up.
    for (let i = 0; i < 3; i++) { benchRuntime(); benchCompiled(); }

    console.log('\n===== bench =====');
    console.log('pixels per run : ' + N);
    console.log('runs           : ' + RUNS);
    console.log('');

    let bestRuntime = Infinity, bestCompiled = Infinity;
    for (let r = 0; r < RUNS; r++) {
        const a = benchRuntime();
        const b = benchCompiled();
        if (a.ms < bestRuntime) bestRuntime = a.ms;
        if (b.ms < bestCompiled) bestCompiled = b.ms;
        console.log(
            '  run ' + (r + 1) + '   ' +
            'runtime ' + a.ms.toFixed(1).padStart(7) + ' ms  ' +
            (N / (a.ms * 1000)).toFixed(2).padStart(6) + ' MPx/s   |   ' +
            'compiled ' + b.ms.toFixed(1).padStart(7) + ' ms  ' +
            (N / (b.ms * 1000)).toFixed(2).padStart(6) + ' MPx/s   ' +
            'speedup ' + (a.ms / b.ms).toFixed(2) + 'x   ' +
            '(sumΔ ' + (a.acc - b.acc).toExponential(2) + ')'
        );
    }
    console.log('');
    console.log('  best runtime  : ' + bestRuntime.toFixed(1) + ' ms  (' + (N / (bestRuntime * 1000)).toFixed(2) + ' MPx/s)');
    console.log('  best compiled : ' + bestCompiled.toFixed(1) + ' ms  (' + (N / (bestCompiled * 1000)).toFixed(2) + ' MPx/s)');
    console.log('  best speedup  : ' + (bestRuntime / bestCompiled).toFixed(2) + 'x');

})().catch(e => { console.error(e); process.exit(1); });
