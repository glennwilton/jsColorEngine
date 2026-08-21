/**
 * Matrix-shaper kernel accuracy — kernel and CLUT, both against the pipeline.
 *
 *   node --max-old-space-size=6144 bench/matrix_shaper_kernel/accuracy.js [8|16]
 *
 * THE REFERENCE IS THE EXACT JS STAGE PIPELINE, not a previous release and not
 * a LUT. Both the CLUT and the kernel are approximations of that arithmetic,
 * and the only fair question is which is closer. Reporting "the kernel is
 * within 1 LSB" without the CLUT column beside it invites the reading that the
 * kernel introduced an error, when it removed a larger one.
 */
'use strict';

const { Transform, eIntent } = require('../../src/main');
const emit = require('../lib/emit.cjs');   // no-op unless JSCE_BENCH_JSON is set

const BITS = parseInt(process.argv[2] || '8', 10);

const PAIRS = [
    ['*sRGB', '*AdobeRGB'],
    ['*AdobeRGB', '*sRGB'],
    ['*sRGB', '*prophoto'],
    ['*prophoto', '*sRGB'],
    ['*sRGB', '*applergb'],
    ['*sRGB', '*colormatch']
];

function run(a, b, opts, px, n){
    const t = new Transform(Object.assign({dataFormat: 'int' + BITS}, opts));
    t.create(a, b, eIntent.relative);
    return { out: t.transformArray(px, false, false, false, n), t: t };
}

function samples(){
    if(BITS === 8){
        const n = 64 * 64 * 64;                       // every fourth level
        const px = new Uint8ClampedArray(n * 3);
        let p = 0;
        for(let r = 0; r < 256; r += 4)
            for(let g = 0; g < 256; g += 4)
                for(let b = 0; b < 256; b += 4){ px[p++] = r; px[p++] = g; px[p++] = b; }
        return { px: px, n: n };
    }
    // int16: an even sweep, plus a dense near-black ramp. The dark end is where
    // a 16-bit output table is hardest — a power TRC's encode curve has
    // unbounded slope at zero — so an even sweep alone would miss the failure.
    const vals = [];
    for(let i = 0; i < 48; i++) vals.push(Math.round(i * 65535 / 47));
    const out = [];
    for(const r of vals) for(const g of vals) for(const b of vals) out.push(r, g, b);
    for(let i = 0; i <= 512; i++){
        const v = i * 4;
        out.push(v, v, v); out.push(v, 0, 0); out.push(0, v, 0);
        out.push(0, 0, v); out.push(v, v >> 1, v >> 2);
    }
    return { px: new Uint16Array(out), n: out.length / 3 };
}

function stats(got, ref){
    let max = 0, over = 0, sum = 0;
    for(let i = 0; i < ref.length; i++){
        const d = Math.abs(got[i] - ref[i]);
        if(d > max) max = d;
        if(d > 1) over++;
        sum += d;
    }
    return { max: max, over: over, overPct: 100 * over / ref.length, mean: sum / ref.length };
}

const fmt = s => 'max ' + String(s.max).padStart(5) +
                 '   mean ' + s.mean.toFixed(4) +
                 '   > 1 LSB ' + s.overPct.toFixed(3) + '%';

const { px, n } = samples();
console.log('int' + BITS + ', ' + n.toLocaleString() + ' colours per pair, reference = the exact pipeline\n');

const rows = [];

for(const [a, b] of PAIRS){
    const ref = run(a, b, {buildLut: false, wasmMatrixShaper: false}, px, n).out;
    const k   = run(a, b, {buildLut: false}, px, n);
    const lut = run(a, b, {buildLut: true, wasmMatrixShaper: false}, px, n).out;
    const info = k.t.kernelInfo();
    const variant = (info && info.variant) ? info.variant : 'DECLINED';
    const ks = stats(k.out, ref), ls = stats(lut, ref);
    console.log(a + ' -> ' + b + '   [' + variant + ']');
    console.log('   kernel : ' + fmt(ks));
    console.log('   CLUT   : ' + fmt(ls));

    // Both paths against the SAME reference, in one row: the comparison is the
    // point, and splitting them into two tables invites quoting one alone.
    rows.push({
        pair:          a + ' -> ' + b,
        variant:       variant,
        kernelMaxLsb:  ks.max,
        kernelMeanLsb: +ks.mean.toFixed(4),
        kernelOver1Pct: +ks.overPct.toFixed(3),
        clutMaxLsb:    ls.max,
        clutMeanLsb:   +ls.mean.toFixed(4),
        clutOver1Pct:  +ls.overPct.toFixed(3),
    });
}

emit.table({
    id:      'matrixShaper.accuracy.int' + BITS,
    title:   'Matrix-shaper kernel vs CLUT, accuracy against the exact pipeline, int' + BITS,
    units:   'LSB',
    meta:    { bits: BITS, coloursPerPair: n, reference: 'buildLut:false, wasmMatrixShaper:false' },
    columns: ['pair', 'variant', 'kernelMaxLsb', 'kernelMeanLsb', 'kernelOver1Pct',
              'clutMaxLsb', 'clutMeanLsb', 'clutOver1Pct'],
    rows:    rows,
});
