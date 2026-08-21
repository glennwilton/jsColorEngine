/**
 * Matrix-shaper kernel throughput — SIMD, scalar, CLUT and the raw pipeline.
 *
 *   node --max-old-space-size=8192 bench/matrix_shaper_kernel/throughput.js
 *
 * The CLUT row uses the DEFAULT lutMode for the dataFormat, which resolves to
 * the WASM SIMD tetrahedral kernel. Comparing the SIMD kernel against
 * `int-wasm-scalar` instead makes the kernel look better than it is; that
 * mistake is on the record in docs/deepdive/MatrixShaperKernel.md.
 *
 * CONTENT IS AN AXIS, NOT A DETAIL. A CLUT's throughput depends on how much of
 * its 214 KB table the pixels touch — solid is one cache line, noise is the
 * whole table, photos sit in between. The kernel's tables are 1-D and small, so
 * it barely notices. Quoting one content type would be a claim about that
 * content rather than about the two paths, and the ratio between them moves by
 * more than 2x across this row.
 *
 * Best-of-N rather than mean: the thing being measured is the loop, and a mean
 * mostly measures whatever else the machine was doing.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Transform, eIntent } = require('../../src/main');
const matrixShaper = require('../../src/kernels/matrixShaper/matrixShaperKernel');
const emit         = require('../lib/emit.cjs');   // no-op unless JSCE_BENCH_JSON is set

const CORPUS = path.join(__dirname, '..', 'release_matrix', 'corpus');

const PX   = 4 * 1024 * 1024;      // well past any cache
const REPS = 5;
const PAIR = ['*prophoto', '*sRGB'];
const KINDS = ['solid', 'noise', 'photo'];

/**
 * The PRNG takes bits 23-30, NOT the low byte. An LCG's low bits have a period
 * of 256 — an earlier version of this file used `s % 256`, produced a few
 * hundred distinct colours, and so measured a solid-colour image wearing a
 * noise costume. It flattered the CLUT by about 2x, and the wrong number
 * reached the docs before the multicore bench contradicted it.
 */
function content(kind, bits){
    const shift = bits === 8 ? 0 : 8;
    const a = bits === 8 ? new Uint8ClampedArray(PX * 3) : new Uint16Array(PX * 3);
    let s = 0x13579bdf;
    const next = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return (s >>> 23) & 0xff; };

    if(kind === 'solid'){
        const px = [next(), next(), next()];
        for(let p = 0; p < PX; p++){
            a[p*3] = px[0] << shift; a[p*3+1] = px[1] << shift; a[p*3+2] = px[2] << shift;
        }
        return a;
    }
    if(kind === 'photo'){
        let files = [];
        try { files = fs.readdirSync(CORPUS).filter(f => f.endsWith('.rgb.bin')).sort(); } catch(e){}
        if(!files.length) return null;              // corpus not generated
        const src  = Buffer.concat(files.map(f => fs.readFileSync(path.join(CORPUS, f))));
        const have = (src.length / 3) | 0;
        for(let p = 0; p < PX; p++){
            const q = (p % have) * 3;
            a[p*3] = src[q] << shift; a[p*3+1] = src[q+1] << shift; a[p*3+2] = src[q+2] << shift;
        }
        return a;
    }
    for(let i = 0; i < a.length; i++) a[i] = next() << shift;
    return a;
}

function bench(t, px, out){
    t.transformArray(px, false, false, false, PX, undefined, out);      // warm
    let best = Infinity;
    for(let r = 0; r < REPS; r++){
        const start = process.hrtime.bigint();
        t.transformArray(px, false, false, false, PX, undefined, out);
        best = Math.min(best, Number(process.hrtime.bigint() - start));
    }
    return PX / (best / 1e9) / 1e6;
}

const ROWS = [
    ['kernel, SIMD',           {buildLut: false},                          'simd'],
    ['kernel, scalar',         {buildLut: false},                          'scalar'],
    ['kernel, plain JS',       {buildLut: false},                          'js'],
    ['CLUT (default lutMode)', {buildLut: true, wasmMatrixShaper: false},   null],
    ['JS stage pipeline',      {buildLut: false, wasmMatrixShaper: false},  null]
];

for(const bits of [8, 16]){
    const out = bits === 8 ? new Uint8ClampedArray(PX * 3) : new Uint16Array(PX * 3);
    console.log('\n=== int' + bits + '   ' + PAIR.join(' -> ') + '   ' +
                (PX / 1e6).toFixed(0) + ' MPx, best of ' + REPS + ', MPx/s ===');

    const images = {};
    for(const k of KINDS) images[k] = content(k, bits);
    console.log('  ' + ''.padEnd(24) + KINDS.map(k => k.padStart(8)).join(' '));

    const mpx = {};
    for(const [label, opts, pin] of ROWS){
        // Pinned during create() only: the variant is chosen when the kernel is
        // built, which happens on the first transformArray call.
        matrixShaper.useVariant(pin);
        const t = new Transform(Object.assign({dataFormat: 'int' + bits}, opts));
        t.create(PAIR[0], PAIR[1], eIntent.relative);
        t.transformArray(images.noise.subarray(0, 300), false, false, false, 100);
        matrixShaper.useVariant(null);

        mpx[label] = {};
        let line = '  ' + label.padEnd(24);
        for(const k of KINDS){
            if(!images[k]){ line += '       -'; continue; }
            const v = bench(t, images[k], out);
            mpx[label][k] = v;
            line += v.toFixed(1).padStart(8) + ' ';
        }
        console.log(line);
    }

    // The same rows the table above prints, as data. Content is a COLUMN here
    // rather than a separate table, because the spread across content is the
    // finding — a single-content figure would be a claim about one image.
    emit.table({
        id:      'matrixShaper.throughput.int' + bits,
        title:   'Matrix-shaper kernel vs CLUT, int' + bits + ', ' + PAIR.join(' -> '),
        units:   'MPx/s',
        meta:    { bits: bits, pixels: PX, reps: REPS, pair: PAIR, best: 'best of ' + REPS },
        columns: ['path'].concat(KINDS),
        rows:    ROWS.map(function(r){
            var row = { path: r[0] };
            KINDS.forEach(function(k){ row[k] = mpx[r[0]][k] != null ? +mpx[r[0]][k].toFixed(1) : null; });
            return row;
        }),
    });

    console.log('');
    const ratios = [];
    for(const k of KINDS){
        if(!images[k]) continue;
        const K = mpx['kernel, SIMD'][k], C = mpx['CLUT (default lutMode)'][k];
        const S = mpx['kernel, scalar'][k], P = mpx['JS stage pipeline'][k];
        const J = mpx['kernel, plain JS'][k];
        console.log('  ' + k.padEnd(8) + ' SIMD/CLUT ' + (K/C).toFixed(2) + 'x' +
                    '   SIMD/scalar ' + (K/S).toFixed(2) + 'x' +
                    '   SIMD/JS ' + (K/J).toFixed(2) + 'x' +
                    '   JS/pipeline ' + (J/P).toFixed(1) + 'x');
        ratios.push({ content: k,
                      simdOverClut:   +(K/C).toFixed(2),
                      simdOverScalar: +(K/S).toFixed(2),
                      simdOverJs:     +(K/J).toFixed(2),
                      jsOverPipeline: +(J/P).toFixed(1) });
    }

    emit.table({
        id:      'matrixShaper.ratios.int' + bits,
        title:   'Matrix-shaper kernel ratios, int' + bits,
        units:   'x',
        meta:    { bits: bits, pair: PAIR },
        columns: ['content', 'simdOverClut', 'simdOverScalar', 'simdOverJs', 'jsOverPipeline'],
        rows:    ratios,
    });
}
