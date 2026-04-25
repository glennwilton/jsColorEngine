/*
 * bench/compile_poc/bench_body_variants.js
 *
 * Take the body produced by Transform.compile() and rewrite it 5 ways to
 * find which intermediate locals are paying for themselves and which are
 * dead weight. All wrapped via the cheapest variant from bench_variants.js
 * (closure-spread; `store.X` references rewritten to closure parameters)
 * so the only thing that varies between rows is the per-pixel body itself.
 *
 *  baseline               — exactly what compile() emits
 *  strip-matrix-snapshot  — drop `let _r=r,_g=g,_b=b` in matrix_rgb
 *                           (X,Y,Z don't alias r,g,b → snapshot is dead)
 *  trilinear-corners-only — keep _d000.._d111 corner reads, collapse the
 *                           lerp tree (_dx?? / _dxy?) into one expression
 *                           per channel — relies on V8 CSE for the shared
 *                           sub-lerps
 *  trilinear-fully-fused  — drop ALL trilinear named temps including
 *                           corners; one giant expression per channel
 *                           (8 inline CLUT[] reads each)
 *  trilinear-NOP          — replace stage 4 entirely with d0=d1=d2=d3=0.5
 *                           Diagnostic only — output is wrong on purpose.
 *                           Tells us how much of the budget is the trilinear.
 *
 * Plus a "stripped-AND-corners" combo, just to see whether the small wins
 * stack.
 *
 * Usage:
 *     node bench/compile_poc/bench_body_variants.js
 *     node bench/compile_poc/bench_body_variants.js --pixels 1000000 --runs 5 --dump
 */

'use strict';

const path = require('path');
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

// --------------------------------------------------------------------------
//  Source rewrites — applied to the body returned by Transform.compile().
// --------------------------------------------------------------------------

/** Drop the dead `let _r = r, _g = g, _b = b;` snapshot in stage 1. */
function stripMatrixSnapshot(src) {
    return src.replace(
        /(\/\/ ----- stage \d+ : stage_matrix_rgb -----\n\{\n)\s*let _r = r, _g = g, _b = b;\n([\s\S]*?\n\})/,
        function (_match, head, rest) {
            // also rename _r/_g/_b → r/g/b in the X/Y/Z assignments
            const rewritten = rest.replace(/_r/g, 'r').replace(/_g/g, 'g').replace(/_b/g, 'b');
            return head + rewritten;
        }
    );
}

/**
 * Rebuild the trilinearInterp3D block from a recipe. Input source has
 * the original block emitted by compile(); we replace it with the
 * caller's choice of body shape.
 */
function rebuildTrilinear(src, makeBlock) {
    // Pull out the parameters baked into the block we emitted (gridEnd,
    // strides, outputScale, channels). Easier than threading them through
    // — read them straight back out of the source.
    const reBlock = /(\/\/ ----- stage \d+ : trilinearInterp3D -----\n\{)([\s\S]*?)(\n\}\n)/;
    const m = src.match(reBlock);
    if (!m) throw new Error('trilinear block not found');
    const inside = m[2];

    const gridEnd     = +/_X0 === (\d+)/.exec(inside)[1];
    const strideX     = +/_X0 \*= (\d+)/.exec(inside)[1];
    const strideY     = +/_Y0 \*= (\d+)/.exec(inside)[1];
    const strideZ     = +/_Z0 \*= (\d+)/.exec(inside)[1];
    const gridScale   = +/_i0 \* (\d+(?:\.\d+)?)/.exec(inside)[1];
    const outputScale = +/\* (\d+\.\d+(?:e-?\d+)?)/.exec(inside)[1];
    // Channel count = how many `dN = ` final assignments we see in the block.
    const channels = (inside.match(/d\d = /g) || []).length;

    const head = m[1] + '\n' +
        '  const _CLUT = _s4_clut;\n' + // closure-spread will rename store.s4_clut → _s4_clut
        '  let _i0 = pcsL < 0 ? 0 : (pcsL > 1 ? 1 : pcsL);\n' +
        '  let _i1 = pcsa < 0 ? 0 : (pcsa > 1 ? 1 : pcsa);\n' +
        '  let _i2 = pcsb < 0 ? 0 : (pcsb > 1 ? 1 : pcsb);\n' +
        '  let _px = _i0 * ' + gridScale + ';\n' +
        '  let _py = _i1 * ' + gridScale + ';\n' +
        '  let _pz = _i2 * ' + gridScale + ';\n' +
        '  let _X0 = ~~_px, _rx = _px - _X0;\n' +
        '  let _Y0 = ~~_py, _ry = _py - _Y0;\n' +
        '  let _Z0 = ~~_pz, _rz = _pz - _Z0;\n' +
        '  let _X1, _Y1, _Z1;\n' +
        '  if (_X0 === ' + gridEnd + ') { _X1 = _X0 *= ' + strideX + '; } else { _X0 *= ' + strideX + '; _X1 = _X0 + ' + strideX + '; }\n' +
        '  if (_Y0 === ' + gridEnd + ') { _Y1 = _Y0 *= ' + strideY + '; } else { _Y0 *= ' + strideY + '; _Y1 = _Y0 + ' + strideY + '; }\n' +
        '  if (_Z0 === ' + gridEnd + ') { _Z1 = _Z0 *= ' + strideZ + '; } else { _Z0 *= ' + strideZ + '; _Z1 = _Z0 + ' + strideZ + '; }\n';

    let blocks = '';
    for (let c = 0; c < channels; c++) {
        blocks += makeBlock('d' + c, c, outputScale);
    }
    // Note: we also drop the original `const _CLUT = store.s4_clut;` line
    // (head substitutes its own version using _s4_clut so closure-spread
    // works after the rewrite below).
    return src.replace(reBlock, head + blocks + m[3])
              .replace(/store\.s4_clut/g, '_s4_clut'); // already handled by rewrite
}

/** Variant: corners cached, lerp tree fused into one expression per channel. */
function trilinearCornersOnly(src) {
    return rebuildTrilinear(src, (target, c, outputScale) => {
        const C = '+ ' + c;
        return (
            '  {\n' +
            '    let _d000 = _CLUT[_X0 + _Y0 + _Z0 ' + C + '];\n' +
            '    let _d001 = _CLUT[_X0 + _Y0 + _Z1 ' + C + '];\n' +
            '    let _d010 = _CLUT[_X0 + _Y1 + _Z0 ' + C + '];\n' +
            '    let _d011 = _CLUT[_X0 + _Y1 + _Z1 ' + C + '];\n' +
            '    let _d100 = _CLUT[_X1 + _Y0 + _Z0 ' + C + '];\n' +
            '    let _d101 = _CLUT[_X1 + _Y0 + _Z1 ' + C + '];\n' +
            '    let _d110 = _CLUT[_X1 + _Y1 + _Z0 ' + C + '];\n' +
            '    let _d111 = _CLUT[_X1 + _Y1 + _Z1 ' + C + '];\n' +
            '    ' + target + ' = (\n' +
            '      (_d000 + _rx * (_d100 - _d000))\n' +
            '      + _ry * ((_d010 + _rx * (_d110 - _d010)) - (_d000 + _rx * (_d100 - _d000)))\n' +
            '      + _rz * (\n' +
            '        ((_d001 + _rx * (_d101 - _d001))\n' +
            '         + _ry * ((_d011 + _rx * (_d111 - _d011)) - (_d001 + _rx * (_d101 - _d001))))\n' +
            '        - ((_d000 + _rx * (_d100 - _d000))\n' +
            '           + _ry * ((_d010 + _rx * (_d110 - _d010)) - (_d000 + _rx * (_d100 - _d000))))\n' +
            '      )\n' +
            '    ) * ' + outputScale + ';\n' +
            '  }\n'
        );
    });
}

/** Variant: zero named temps. 8 inline CLUT reads per channel, compiler does it all. */
function trilinearFullyFused(src) {
    return rebuildTrilinear(src, (target, c, outputScale) => {
        const C = '+ ' + c;
        const c000 = '_CLUT[_X0 + _Y0 + _Z0 ' + C + ']';
        const c001 = '_CLUT[_X0 + _Y0 + _Z1 ' + C + ']';
        const c010 = '_CLUT[_X0 + _Y1 + _Z0 ' + C + ']';
        const c011 = '_CLUT[_X0 + _Y1 + _Z1 ' + C + ']';
        const c100 = '_CLUT[_X1 + _Y0 + _Z0 ' + C + ']';
        const c101 = '_CLUT[_X1 + _Y0 + _Z1 ' + C + ']';
        const c110 = '_CLUT[_X1 + _Y1 + _Z0 ' + C + ']';
        const c111 = '_CLUT[_X1 + _Y1 + _Z1 ' + C + ']';
        return (
            '  ' + target + ' = (\n' +
            '    (' + c000 + ' + _rx * (' + c100 + ' - ' + c000 + '))\n' +
            '    + _ry * ((' + c010 + ' + _rx * (' + c110 + ' - ' + c010 + ')) - (' + c000 + ' + _rx * (' + c100 + ' - ' + c000 + ')))\n' +
            '    + _rz * (\n' +
            '      ((' + c001 + ' + _rx * (' + c101 + ' - ' + c001 + '))\n' +
            '       + _ry * ((' + c011 + ' + _rx * (' + c111 + ' - ' + c011 + ')) - (' + c001 + ' + _rx * (' + c101 + ' - ' + c001 + '))))\n' +
            '      - ((' + c000 + ' + _rx * (' + c100 + ' - ' + c000 + '))\n' +
            '         + _ry * ((' + c010 + ' + _rx * (' + c110 + ' - ' + c010 + ')) - (' + c000 + ' + _rx * (' + c100 + ' - ' + c000 + '))))\n' +
            '    )\n' +
            '  ) * ' + outputScale + ';\n'
        );
    });
}

/** Variant: NOP the trilinear entirely. Output is wrong on purpose. */
function trilinearNOP(src) {
    return src.replace(
        /(\/\/ ----- stage \d+ : trilinearInterp3D -----\n)\{[\s\S]*?\n\}\n/,
        '$1{ d0 = 0.5; d1 = 0.5; d2 = 0.5; d3 = 0.5; }\n'
    );
}

/**
 * Diagnostic: replace every Math.pow(x,y) with just x. WRONG output.
 * The first-arg regex tolerates one level of nested parens so it matches
 *   Math.pow((_r + 0.055) / 1.055, 2.4)
 * not just simple identifiers.
 */
function nopMathPow(src) {
    return src.replace(/Math\.pow\(((?:[^(),]|\([^()]*\))+),\s*[^)]+\)/g, '($1)');
}

/** Diagnostic: NOP everything before the trilinear. Just feed PCSv2 noise in. */
function nopPreTrilinear(src) {
    // Strip stages 0..3, then seed pcsL/pcsa/pcsb from r/g/b directly.
    return src.replace(
        /\/\/ ----- stage 0 : stage_Gamma_Inverse -----[\s\S]*?(?=\/\/ ----- stage 4 : trilinearInterp3D -----)/,
        '// pre-trilinear NOPed — pcs* sourced from input directly\n' +
        '{ pcsL = r; pcsa = g; pcsb = b; }\n'
    );
}

/** Diagnostic: NOP everything AFTER the matrix (pretend we stop at XYZ). */
function nopPostMatrix(src) {
    return src.replace(
        /\/\/ ----- stage 2 : stage_PCSXYZ_to_PCSv2 -----[\s\S]*return \[d0, d1, d2, d3\];/,
        '// post-matrix NOPed\nreturn [X, Y, Z, 0];'
    );
}

/** Variant: replace Math.pow(x, 1.0/3.0) with Math.cbrt(x). */
function useCbrt(src) {
    return src.replace(/Math\.pow\(([^,]+),\s*1\.0\/3\.0\)/g, 'Math.cbrt($1)');
}

/**
 * Variant: inline the _L/_a/_b temps into the pcsL/pcsa/pcsb assignments.
 * Same float ops in the same order — bit-exact, just no named temps.
 *
 *   let _L = 116.0 * _fy - 16.0;
 *   let _a = 500.0 * (_fx - _fy);
 *   let _b = 200.0 * (_fy - _fz);
 *   pcsL =  _L * 0.00996...;
 *   pcsa = (_a + 128) * 0.00390...;
 *   pcsb = (_b + 128) * 0.00390...;
 *
 * becomes:
 *
 *   pcsL =  (116.0 * _fy - 16.0)         * 0.00996...;
 *   pcsa = (500.0 * (_fx - _fy) + 128)   * 0.00390...;
 *   pcsb = (200.0 * (_fy - _fz) + 128)   * 0.00390...;
 */
function inlineLabTemps(src) {
    return src.replace(
        /\s*let _L = 116\.0 \* _fy - 16\.0;\s*let _a = 500\.0 \* \(_fx - _fy\);\s*let _b = 200\.0 \* \(_fy - _fz\);\s*pcsL\s*=\s*_L \* (\S+);\s*pcsa = \(_a \+ 128\) \* (\S+);\s*pcsb = \(_b \+ 128\) \* \1;/,
        function (_m, scaleL, scaleAB) {
            return (
                '\n  pcsL =  (116.0 * _fy - 16.0)       * ' + scaleL  + ';' +
                '\n  pcsa = (500.0 * (_fx - _fy) + 128) * ' + scaleAB + ';' +
                '\n  pcsb = (200.0 * (_fy - _fz) + 128) * ' + scaleAB + ';'
            );
        }
    );
}

/**
 * Variant: pre-multiply all the L/a/b constants at emit time.
 * Trades 1 ULP of accuracy for 3 fewer multiplies per pixel.
 *
 *   pcsL = (116*_fy - 16) * scaleL  ->  cL_fy * _fy - cL_off
 *   pcsa = (500*(_fx-_fy) + 128) * scaleAB  ->  cA * (_fx-_fy) + cAB_off
 */
function inlineLabTempsPreMul(src) {
    return src.replace(
        /\s*let _L = 116\.0 \* _fy - 16\.0;\s*let _a = 500\.0 \* \(_fx - _fy\);\s*let _b = 200\.0 \* \(_fy - _fz\);\s*pcsL\s*=\s*_L \* (\S+);\s*pcsa = \(_a \+ 128\) \* (\S+);\s*pcsb = \(_b \+ 128\) \* \1;/,
        function (_m, scaleLStr, scaleABStr) {
            const scaleL  = parseFloat(scaleLStr);
            const scaleAB = parseFloat(scaleABStr);
            const cL_fy   = 116.0 * scaleL;
            const cL_off  =  16.0 * scaleL;
            const cA      = 500.0 * scaleAB;
            const cB      = 200.0 * scaleAB;
            const cAB_off =   128 * scaleAB;
            return (
                '\n  pcsL = ' + cL_fy + ' * _fy - ' + cL_off + ';' +
                '\n  pcsa = ' + cA + ' * (_fx - _fy) + ' + cAB_off + ';' +
                '\n  pcsb = ' + cB + ' * (_fy - _fz) + ' + cAB_off + ';'
            );
        }
    );
}

// --------------------------------------------------------------------------
//  Wrap-as-closure-spread (cheapest wrapper — see bench_variants.js)
// --------------------------------------------------------------------------

function wrap(body, store) {
    const keyRe   = /store\.([A-Za-z_$][A-Za-z0-9_$]*)|\b_(s\d+_\w+)\b/g;
    // Collect both `store.X` references AND already-rewritten _sN_X identifiers
    // (the trilinear rewrites inject `_s4_clut` directly).
    const used    = new Set();
    let m;
    while ((m = keyRe.exec(body))) used.add(m[1] || m[2]);
    const keys    = Array.from(used).filter(k => k && (store[k] !== undefined || store['_' + k.replace(/^_/, '')] !== undefined));

    // Normalise: `_s4_clut` (rewritten) → store.s4_clut at attach time.
    const paramNames = keys.map(k => k.startsWith('s') ? '_' + k : k);
    const values     = keys.map(k => store[k.replace(/^_/, '')]);

    // Final body uses _sN_xxx (the rewrites replace store.sN_xxx → _sN_xxx
    // for trilinear; do the same for everything else here).
    const finalBody  = body.replace(/store\.([A-Za-z_$][A-Za-z0-9_$]*)/g, '_$1');

    return new Function(...paramNames,
        'return function(input) {\n' + finalBody + '\n};'
    )(...values);
}

(async () => {
    const cmyk = new Profile();
    await cmyk.loadPromise('file:' + cmykFilename);
    if (!cmyk.loaded) throw new Error('CMYK profile failed to load');

    const t = new Transform({ dataFormat: 'device', buildLut: false, lutMode: 'float' });
    t.create('*srgb', cmyk, eIntent.relative);

    const compiled = t.compile({ target: 'js' });
    const baseBody = compiled.source;
    const store    = compiled.store;

    // Build the variants
    const bodyA = baseBody;
    const bodyB = stripMatrixSnapshot(baseBody);
    const bodyC = trilinearCornersOnly(baseBody);
    const bodyD = trilinearFullyFused(baseBody);
    const bodyE = trilinearNOP(baseBody);
    const bodyF = trilinearCornersOnly(stripMatrixSnapshot(baseBody)); // combo
    const bodyG = nopMathPow(baseBody);                                  // diagnostic
    const bodyH = nopPreTrilinear(baseBody);                             // diagnostic
    const bodyI = nopPostMatrix(baseBody);                               // diagnostic
    const bodyJ = useCbrt(baseBody);                                     // pow→cbrt
    const bodyK = inlineLabTemps(baseBody);                              // drop _L,_a,_b
    const bodyL = inlineLabTemps(useCbrt(baseBody));                     // both
    const bodyM = inlineLabTempsPreMul(useCbrt(baseBody));               // pre-mul const + cbrt

    const variants = [
        { name: 'baseline             ', body: bodyA, correctness: true  },
        { name: 'strip-matrix-snapshot', body: bodyB, correctness: true  },
        { name: 'trilinear-corners    ', body: bodyC, correctness: true  },
        { name: 'trilinear-fused      ', body: bodyD, correctness: true  },
        { name: 'trilinear-NOP        ', body: bodyE, correctness: false },
        { name: 'corners + strip-mtx  ', body: bodyF, correctness: true  },
        { name: 'NOP-Math.pow         ', body: bodyG, correctness: false },
        { name: 'NOP-pre-trilinear    ', body: bodyH, correctness: false },
        { name: 'NOP-post-matrix      ', body: bodyI, correctness: false },
        { name: 'pow→cbrt             ', body: bodyJ, correctness: 'tol' },
        { name: 'inline-Lab-temps     ', body: bodyK, correctness: true  },
        { name: 'cbrt + inline-Lab    ', body: bodyL, correctness: 'tol' },
        { name: 'cbrt + Lab-pre-mul   ', body: bodyM, correctness: 'tol' },
    ];

    if (DUMP) {
        for (const v of variants) {
            console.log('\n========== ' + v.name.trim() + ' ==========');
            console.log(v.body);
        }
    }

    // Wrap + correctness
    for (const v of variants) {
        v.fn = wrap(v.body, store);
    }

    console.log('===== correctness =====');
    const probes = [
        [150/255, 100/255, 50/255],
        [0.0, 0.0, 0.0],
        [1.0, 1.0, 1.0],
        [0.5, 0.5, 0.5],
        [0.25, 0.75, 0.10],
        [0.9, 0.1, 0.4],
    ];
    for (const v of variants) {
        if (v.correctness === false) {
            console.log('  skip  ' + v.name + '  (NOP variant — wrong on purpose)');
            continue;
        }
        let maxAbs = 0;
        // Use a denser probe set so cbrt vs pow drift actually shows up.
        const probesDense = [];
        for (const p of probes) probesDense.push(p);
        for (let i = 0; i < 200; i++) probesDense.push([Math.random(), Math.random(), Math.random()]);
        for (const p of probesDense) {
            const a = t.forward(p);
            const b = v.fn(p);
            for (let i = 0; i < a.length; i++) {
                const d = Math.abs(a[i] - b[i]);
                if (d > maxAbs) maxAbs = d;
            }
        }
        // Bit-exact required for `true`, ≤1e-4 tolerated for `'tol'`.
        const limit  = v.correctness === 'tol' ? 1e-4 : 1e-9;
        const status = maxAbs > limit ? '  FAIL  ' : (v.correctness === 'tol' ? '  ~ok   ' : '  ok    ');
        console.log(status + v.name + '  Δmax=' + maxAbs.toExponential(2));
    }

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

    // Warm up everything.
    for (let i = 0; i < 3; i++) {
        timeRuntime();
        for (const v of variants) timeFn(v.fn);
    }

    console.log('\n===== bench (' + N + ' px, best of ' + RUNS + ') =====');

    const bestRuntime = { ms: Infinity };
    const best = variants.map(v => ({ name: v.name, ms: Infinity }));

    for (let r = 0; r < RUNS; r++) {
        const rt = timeRuntime();
        if (rt.ms < bestRuntime.ms) bestRuntime.ms = rt.ms;
        for (let v = 0; v < variants.length; v++) {
            const r1 = timeFn(variants[v].fn);
            if (r1.ms < best[v].ms) best[v].ms = r1.ms;
        }
    }

    const fmt = (ms) => ms.toFixed(1).padStart(7) + ' ms   ' + (N / (ms * 1000)).toFixed(2).padStart(6) + ' MPx/s';
    console.log('  runtime forward()        ' + fmt(bestRuntime.ms) + '   1.00x   (baseline)');
    for (const b of best) {
        const sx = bestRuntime.ms / b.ms;
        console.log('  ' + b.name + '    ' + fmt(b.ms) + '   ' + sx.toFixed(2) + 'x');
    }

    // Diagnostic: budget breakdown via the NOP variant.
    const bestBaseline = best.find(b => b.name.indexOf('baseline') === 0).ms;
    const bestNOP      = best.find(b => b.name.indexOf('trilinear-NOP') === 0).ms;
    const trilinearBudget = bestBaseline - bestNOP;
    console.log('\n===== diagnostic =====');
    console.log('  baseline minus NOP-trilinear  =  ' + trilinearBudget.toFixed(1) + ' ms   (' + (100 * trilinearBudget / bestBaseline).toFixed(1) + '% of compiled budget)');
    console.log('  rest (curves + matrix + sRGB) =  ' + bestNOP.toFixed(1) + ' ms   (' + (100 * bestNOP / bestBaseline).toFixed(1) + '% of compiled budget)');
})().catch(e => { console.error(e); process.exit(1); });
