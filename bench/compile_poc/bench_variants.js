/*
 * bench/compile_poc/bench_variants.js
 *
 * Same body produced by Transform.compile(), wrapped 5 ways. Goal is to
 * measure whether anything beats the current "new Function + .bind(store)"
 * shape:
 *
 *  A) bind            — new Function('store', 'input', body).bind(null, store)
 *                       (the current Transform.compile() output)
 *  B) closure         — factory closes over `store`, returns inner function
 *                       (no .bind wrapper, store is closure-cell access)
 *  C) closure-spread  — store.s3_table / store.s4_clut rewritten to bare
 *                       names, factory parameters bind those names directly
 *                       (no `store.` indirection at all)
 *  D) class-method    — same body, but as a class method called via
 *                       `inst.transform(input)` — V8 sometimes inlines
 *                       class methods better via hidden classes.
 *  E) module          — same body written to a separate .js file and
 *                       require()'d, so V8 sees it as static code.
 *
 * All five must produce bit-identical output to t.forward(); the bench
 * times each over the same random pixel buffer.
 *
 * Usage:
 *     node bench/compile_poc/bench_variants.js
 *     node bench/compile_poc/bench_variants.js --pixels 1000000 --runs 5
 *     node bench/compile_poc/bench_variants.js --dump
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { Transform, eIntent } = require('../../src/main');
const Profile = require('../../src/Profile');

const argv   = process.argv.slice(2);
const flag   = name => argv.includes(name);
const argVal = (name, def) => {
    const i = argv.indexOf(name);
    return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : def;
};
const N    = parseInt(argVal('--pixels', '500000'), 10);
const RUNS = parseInt(argVal('--runs',   '5'), 10);
const DUMP = flag('--dump');

const cmykFilename = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

(async () => {
    const cmyk = new Profile();
    await cmyk.loadPromise('file:' + cmykFilename);
    if (!cmyk.loaded) throw new Error('CMYK profile failed to load');

    const t = new Transform({ dataFormat: 'device', buildLut: false, lutMode: 'float' });
    t.create('*srgb', cmyk, eIntent.relative);

    // Variants must match t.forward() bit-exact (see correctness check below),
    // so opt OUT of the now-default useGammaLUT (LUT is ~32-bit precision
    // vs t.forward()'s f64). compile() defaults useGammaLUT=true for lcms parity.
    const compiled = t.compile({ target: 'js', useGammaLUT: false });
    const store    = compiled.store;
    const body     = compiled.source; // includes "use strict" + locals + body + return

    // ------------------------------------------------------------------
    // Identify which store keys the body actually references.
    // (compile() may attach more than the body uses.)
    // ------------------------------------------------------------------
    const keyRe   = /store\.([A-Za-z_$][A-Za-z0-9_$]*)/g;
    const keys    = Array.from(new Set(Array.from(body.matchAll(keyRe), m => m[1])));
    const values  = keys.map(k => store[k]);

    if (DUMP) {
        console.log('===== body source =====');
        console.log(body);
        console.log('===== store keys referenced =====');
        keys.forEach(k => console.log('  ' + k + ' : ' +
            (store[k] && store[k].constructor && store[k].constructor.name) +
            (store[k] && store[k].length != null ? ' (len=' + store[k].length + ')' : '')));
        console.log('=================================\n');
    }

    // ------------------------------------------------------------------
    // Build the 5 variants.
    // ------------------------------------------------------------------

    // A) bind
    const fn_bind = new Function('store', 'input', body).bind(null, store);

    // B) closure: factory closes `store` and returns the inner function. No
    //    bound-function wrapper. The inner body still uses `store.X`, but
    //    `store` is a closure cell, not an argument bound through .bind().
    const fn_closure = (new Function('store',
        'return function(input) {\n' + body + '\n};'
    ))(store);

    // C) closure-spread: rewrite `store.<key>` → `<key>` in the body, then
    //    create a factory whose parameter names are exactly the keys, and
    //    return a closure that uses them directly. One closure cell per
    //    typed-array, no property hop, no `store` object at all.
    const bodyNoStore = body.replace(/store\.([A-Za-z_$][A-Za-z0-9_$]*)/g, '$1');
    const fn_spread   = (new Function(...keys,
        'return function(input) {\n' + bodyNoStore + '\n};'
    ))(...values);

    // D) class-method. Body uses `store.X` references; the constructor
    //    captures `store` in a closure-bound transform method to keep the
    //    method body straight (no `this.store` indirection inside the hot
    //    loop — that would lose to the closure variant for sure).
    const Cls = (new Function('store',
        'return class CompiledTransform {\n' +
        '  constructor() {}\n' +
        '  transform(input) {\n' +
        body + '\n' +
        '  }\n' +
        '};'
    ))(store);
    const inst   = new Cls();
    const fn_cls = inst.transform.bind(inst);

    // E) module: write the body out as a real .js file and require() it.
    const moduleFile = path.join(__dirname, '_generated_compiled.js');
    fs.writeFileSync(moduleFile,
        '/* AUTO-GENERATED by bench_variants.js — do not edit. */\n' +
        '"use strict";\n' +
        'module.exports = function makeFn(store) {\n' +
        '  return function transform(input) {\n' +
        body + '\n' +
        '  };\n' +
        '};\n'
    );
    delete require.cache[require.resolve(moduleFile)];
    const fn_module = require(moduleFile)(store);

    const variants = [
        { name: 'bind          ', fn: fn_bind    },
        { name: 'closure       ', fn: fn_closure },
        { name: 'closure-spread', fn: fn_spread  },
        { name: 'class-method  ', fn: fn_cls     },
        { name: 'module        ', fn: fn_module  },
    ];

    // ------------------------------------------------------------------
    // Correctness — each variant must be bit-exact with t.forward().
    // ------------------------------------------------------------------
    const probes = [
        [150/255, 100/255, 50/255],
        [0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0],
        [0.5, 0.5, 0.5],
        [0.25, 0.75, 0.10],
        [0.9, 0.1, 0.4],
    ];

    console.log('===== correctness =====');
    let anyFail = false;
    for (const v of variants) {
        let maxAbs = 0;
        for (const p of probes) {
            const a = t.forward(p);
            const b = v.fn(p);
            for (let i = 0; i < a.length; i++) {
                const d = Math.abs(a[i] - b[i]);
                if (d > maxAbs) maxAbs = d;
            }
        }
        const status = maxAbs > 1e-9 ? '  FAIL  ' : '  ok    ';
        if (maxAbs > 1e-9) anyFail = true;
        console.log(status + v.name + '  Δmax=' + maxAbs.toExponential(2));
    }
    if (anyFail) {
        console.error('\nABORTING: at least one variant produced wrong output.');
        process.exit(1);
    }

    // ------------------------------------------------------------------
    // Bench
    // ------------------------------------------------------------------
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

    function timeRuntime() {
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

    // Warm up every variant so each gets to TurboFan.
    for (let i = 0; i < 3; i++) {
        timeRuntime();
        for (const v of variants) timeFn(v.fn);
    }

    console.log('\n===== bench =====');
    console.log('pixels per run : ' + N);
    console.log('runs           : ' + RUNS);
    console.log('');

    // Best-of-RUNS for each variant.
    const bestRuntime = { ms: Infinity };
    const best = variants.map(v => ({ name: v.name, fn: v.fn, ms: Infinity }));

    for (let r = 0; r < RUNS; r++) {
        const rt = timeRuntime();
        if (rt.ms < bestRuntime.ms) bestRuntime.ms = rt.ms;
        process.stdout.write('  run ' + (r + 1) + '   runtime ' + rt.ms.toFixed(1).padStart(7) + ' ms');
        for (let v = 0; v < variants.length; v++) {
            const r1 = timeFn(variants[v].fn);
            if (r1.ms < best[v].ms) best[v].ms = r1.ms;
            process.stdout.write('   ' + variants[v].name.trim() + ' ' + r1.ms.toFixed(1).padStart(7));
        }
        process.stdout.write('\n');
    }

    console.log('\n===== summary (best of ' + RUNS + ', ms / MPx/s / × runtime) =====');
    const fmt = (ms) => ms.toFixed(1).padStart(7) + ' ms   ' + (N / (ms * 1000)).toFixed(2).padStart(6) + ' MPx/s';
    console.log('  runtime          ' + fmt(bestRuntime.ms) + '   1.00x   (baseline)');
    for (const b of best) {
        const sx = bestRuntime.ms / b.ms;
        console.log('  ' + b.name + '   ' + fmt(b.ms) + '   ' + sx.toFixed(2) + 'x');
    }

    // Clean up the generated module
    try { fs.unlinkSync(moduleFile); } catch (_) {}

})().catch(e => { console.error(e); process.exit(1); });
