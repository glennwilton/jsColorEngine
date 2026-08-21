/*************************************************************************
 *  @license
 *
 *  Copyright © 2019, 2026 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 */

/**
 * A HOT MATRIX SHAPER IN PURE JS — which shape actually wins?
 *
 *   node bench/js_matrix_shaper/run.js
 *
 * The reference points are the two things it sits between: the WASM kernel at
 * ~331 MPx/s and the generic stage pipeline at ~9 MPx/s. Anything that does
 * not comfortably clear the pipeline is not worth having; anything close to
 * the kernel would question whether the WASM is earning its keep on this path.
 *
 * Following the two documented V8 findings that bear on it:
 *
 *   "V8 does unroll, but conservatively, and gives up on functions over a size
 *    threshold. So our manual unrolling IS load-bearing in JS."
 *      — Performance.md, on reading lcms2
 *
 *   "Float values live in XMM0-XMM15, a separate 16-register file, so
 *    arithmetic intermediates don't compete for GPRs with pointers, indices
 *    and counters." Float 3D kernels spill 36-37%, int 47-50%.
 *      — JitInspection.md
 *
 * The second is why this should behave better than the tetrahedral kernels:
 * the working set is 9 coefficients plus 3 in-flight values — twelve doubles
 * against sixteen XMM registers — with no grid bookkeeping and no four base
 * pointers competing for the ~11 allocatable GPRs.
 *
 * VARIANTS
 *
 *   exact      input table indexed by the raw code (256 or 65536 entries, one
 *              per possible input — exact, no multiply). Output table indexed
 *              linearly. Three locals for the linear RGB, outputs computed
 *              inline into the stores.
 *   temps      identical, but the three output values go through their own
 *              locals first. Tests whether extra intermediates cost anything,
 *              or whether V8 keeps them in XMM regardless.
 *   noTemps    no locals at all: every table lookup recomputed inside each
 *              output expression. Nine input lookups per pixel instead of
 *              three. Included because "no intermediate variables" taken
 *              literally is a trap, and it is worth showing where the line is.
 *   scaled     the generic shape: normalise the code with a flat multiply by
 *              1/255 or 1/65535, then index a 4096-entry DEVICE-indexed curve.
 *              One table size for every bit depth, at the cost of a multiply
 *              and some accuracy.
 *   rolled     a channel loop instead of an unrolled body — the control for
 *              the unrolling claim.
 */
'use strict';

const { Transform, eIntent } = require('../../src/main');

const argv = process.argv.slice(2);
const arg  = (n,d) => { const h = argv.find(a=>a.startsWith('--'+n+'=')); return h ? h.slice(n.length+3) : d; };
const BITS = parseInt(arg('bits','8'), 10);
const N    = parseInt(arg('px', String(1<<20)), 10);
const REPS = parseInt(arg('reps','7'), 10);
const FROM = arg('from','*prophoto'), TO = arg('to','*sRGB');

const Arr = BITS === 8 ? Uint8ClampedArray : Uint16Array;
const CODES = BITS === 8 ? 256 : 65536;
const MAXV  = CODES - 1;

// ---- pull the fused matrix and the curves off the pipeline ---------------
// Exactly what the WASM kernel does: the optimiser already folded this pair
// into stage_Gamma_Inverse -> stage_matrix_rgb -> stage_Gamma, so nothing is
// reimplemented here.
const ref = new Transform({dataFormat:'int'+BITS, buildLut:false, wasmMatrixShaper:false});
ref.create(FROM, TO, eIntent.relative);
const stageNamed = n => ref.pipeline.find(s => s.stageName === n);
const sInv = stageNamed('stage_Gamma_Inverse'), sMat = stageNamed('stage_matrix_rgb'),
      sFwd = stageNamed('stage_Gamma');
if(!sInv || !sMat || !sFwd) throw new Error('not a matrix-shaper pipeline');
const curveAt = (stage, v) => stage.funct.call(ref, [v,v,v], stage.stageData, stage);
const M = sMat.stageData;

// Input, indexed by the raw code — exact, one entry per possible input.
const iT = new Float64Array(CODES);
for(let c = 0; c < CODES; c++) iT[c] = curveAt(sInv, c / MAXV)[0];

// Input, indexed by DEVICE value — 4096 entries whatever the bit depth.
const DEV = 4096, DEVMAX = DEV - 1;
const dT = new Float64Array(DEV);
for(let i = 0; i < DEV; i++) dT[i] = curveAt(sInv, i / DEVMAX)[0];

// Output, linearly indexed. 65536 entries is what the WASM int8 kernel uses
// and measures at <= 1 LSB; int16 needs the quartic index instead, so this
// bench is int8-first and reports int16 separately.
const OUTN = 65536, OUTMAX = OUTN - 1;
const oT = BITS === 8 ? new Uint8Array(OUTN) : new Uint16Array(OUTN);
for(let i = 0; i < OUTN; i++){
    const e = Math.round(curveAt(sFwd, i / OUTMAX)[0] * MAXV);
    oT[i] = e < 0 ? 0 : (e > MAXV ? MAXV : e);
}

// Output, QUARTIC-indexed — entry i is the encoded value of (i/QMAX)^4.
// A linear index cannot resolve the dark end at 16 bits: a power TRC's encode
// curve has unbounded slope at zero, so the first interval alone is hundreds of
// LSB out. Substituting v = t^4 moves the worst case to white, where the slope
// is (4/g). Same reasoning as the WASM kernel, same table.
const QN = 131072, QMAX = QN - 1;
const qT = BITS === 8 ? new Uint8Array(QN) : new Uint16Array(QN);
for(let i = 0; i < QN; i++){
    let lin = i / QMAX; lin *= lin; lin *= lin;
    const e = Math.round(curveAt(sFwd, lin)[0] * MAXV);
    qT[i] = e < 0 ? 0 : (e > MAXV ? MAXV : e);
}

const m00=M.m00, m01=M.m01, m02=M.m02,
      m10=M.m10, m11=M.m11, m12=M.m12,
      m20=M.m20, m21=M.m21, m22=M.m22;

/** Clamp a scaled index into the output table. */
function idx(v){ v = (v * OUTMAX + 0.5) | 0; return v < 0 ? 0 : (v > OUTMAX ? OUTMAX : v); }

/** The quartic index: clamp, two square roots, scale. */
function idxQ(v){
    v = v < 0 ? 0 : (v > 1 ? 1 : v);
    v = (Math.sqrt(Math.sqrt(v)) * QMAX + 0.5) | 0;
    return v > QMAX ? QMAX : v;
}

// ---- variants ------------------------------------------------------------
const VARIANTS = {
    // Three locals for the linear RGB; the nine products are computed inline
    // into the stores, so nothing beyond r/g/b is ever named.
    exact(px, out, n){
        for(let i = 0; i < n; i++){
            const p = i*3;
            const r = iT[px[p]], g = iT[px[p+1]], b = iT[px[p+2]];
            out[p]   = oT[idx(m00*r + m01*g + m02*b)];
            out[p+1] = oT[idx(m10*r + m11*g + m12*b)];
            out[p+2] = oT[idx(m20*r + m21*g + m22*b)];
        }
    },
    // The same, plus three more locals for the results.
    temps(px, out, n){
        for(let i = 0; i < n; i++){
            const p = i*3;
            const r = iT[px[p]], g = iT[px[p+1]], b = iT[px[p+2]];
            const x = m00*r + m01*g + m02*b;
            const y = m10*r + m11*g + m12*b;
            const z = m20*r + m21*g + m22*b;
            out[p]   = oT[idx(x)];
            out[p+1] = oT[idx(y)];
            out[p+2] = oT[idx(z)];
        }
    },
    // No named values at all — every lookup recomputed. Nine input lookups
    // per pixel instead of three.
    noTemps(px, out, n){
        for(let i = 0; i < n; i++){
            const p = i*3;
            out[p]   = oT[idx(m00*iT[px[p]] + m01*iT[px[p+1]] + m02*iT[px[p+2]])];
            out[p+1] = oT[idx(m10*iT[px[p]] + m11*iT[px[p+1]] + m12*iT[px[p+2]])];
            out[p+2] = oT[idx(m20*iT[px[p]] + m21*iT[px[p+1]] + m22*iT[px[p+2]])];
        }
    },
    // Generic across bit depths: normalise with one multiply, then index a
    // 4096-entry device-indexed curve.
    scaled(px, out, n){
        const s = DEVMAX / MAXV;
        for(let i = 0; i < n; i++){
            const p = i*3;
            const r = dT[(px[p]*s + 0.5)|0], g = dT[(px[p+1]*s + 0.5)|0], b = dT[(px[p+2]*s + 0.5)|0];
            out[p]   = oT[idx(m00*r + m01*g + m02*b)];
            out[p+1] = oT[idx(m10*r + m11*g + m12*b)];
            out[p+2] = oT[idx(m20*r + m21*g + m22*b)];
        }
    },
    // The shape that is actually correct at 16 bits: exact code-indexed input,
    // quartic-indexed output. Two Math.sqrt per channel is the price.
    quartic(px, out, n){
        for(let i = 0; i < n; i++){
            const p = i*3;
            const r = iT[px[p]], g = iT[px[p+1]], b = iT[px[p+2]];
            out[p]   = qT[idxQ(m00*r + m01*g + m02*b)];
            out[p+1] = qT[idxQ(m10*r + m11*g + m12*b)];
            out[p+2] = qT[idxQ(m20*r + m21*g + m22*b)];
        }
    },
    // Post-increment in the index expressions. Reads the same three cells, but
    // each ++ must retire before the next index exists — a serial chain where
    // p / p+1 / p+2 are independent and fold into the addressing mode.
    incr(px, out, n){
        let p = 0;
        for(let i = 0; i < n; i++){
            const r = iT[px[p++]], g = iT[px[p++]], b = iT[px[p]];
            p -= 2;
            out[p]   = qT[idxQ(m00*r + m01*g + m02*b)];
            out[p+1] = qT[idxQ(m10*r + m11*g + m12*b)];
            out[p+2] = qT[idxQ(m20*r + m21*g + m22*b)];
            p += 3;
        }
    },
    // A running pointer, independent offsets, and NO multiply per pixel —
    // which is what the post-increment idea is really reaching for.
    ptr(px, out, n){
        for(let p = 0, end = n*3; p < end; p += 3){
            const r = iT[px[p]], g = iT[px[p+1]], b = iT[px[p+2]];
            out[p]   = qT[idxQ(m00*r + m01*g + m02*b)];
            out[p+1] = qT[idxQ(m10*r + m11*g + m12*b)];
            out[p+2] = qT[idxQ(m20*r + m21*g + m22*b)];
        }
    },
    // A channel loop instead of an unrolled body — the control.
    rolled(px, out, n){
        const mm = [m00,m01,m02,m10,m11,m12,m20,m21,m22];
        for(let i = 0; i < n; i++){
            const p = i*3;
            const r = iT[px[p]], g = iT[px[p+1]], b = iT[px[p+2]];
            for(let c = 0; c < 3; c++){
                out[p+c] = oT[idx(mm[c*3]*r + mm[c*3+1]*g + mm[c*3+2]*b)];
            }
        }
    }
};

// ---- content -------------------------------------------------------------
const px = new Arr(N*3);
let s = 0x13579bdf;
for(let i = 0; i < px.length; i++){
    s = (Math.imul(s,1103515245)+12345) & 0x7fffffff;
    px[i] = ((s>>>23)&0xff) * (BITS === 8 ? 1 : 257);
}
const out = new Arr(N*3);

// ---- references ----------------------------------------------------------
const kern = new Transform({dataFormat:'int'+BITS, buildLut:false});
kern.create(FROM, TO, eIntent.relative);
const pipeOut = new Arr(N*3);
const expected = ref.transformArray(px, false, false, false, N, undefined, pipeOut).slice();

function bench(fn){
    fn(px, out, N);
    let best = Infinity;
    for(let r = 0; r < REPS; r++){
        const t0 = process.hrtime.bigint();
        fn(px, out, N);
        best = Math.min(best, Number(process.hrtime.bigint()-t0));
    }
    return N/(best/1e9)/1e6;
}

console.log('JS MATRIX SHAPER — int' + BITS + ', ' + FROM + ' -> ' + TO +
            ', ' + (N/1e6).toFixed(1) + ' MPx noise, best of ' + REPS + '\n');
console.log('variant      MPx/s    vs pipeline   max LSB   >1 LSB');

const pipeMpx = bench((p,o,n) => ref.transformArray(p, false, false, false, n, undefined, o));
console.log('  ' + 'pipeline'.padEnd(11) + pipeMpx.toFixed(1).padStart(7) +
            '        1.00x         0        0');

for(const [name, fn] of Object.entries(VARIANTS)){
    const mpx = bench(fn);
    fn(px, out, N);
    let max = 0, over = 0;
    for(let i = 0; i < expected.length; i++){
        const d = Math.abs(out[i] - expected[i]);
        if(d > max) max = d;
        if(d > 1) over++;
    }
    console.log('  ' + name.padEnd(11) + mpx.toFixed(1).padStart(7) +
                (mpx/pipeMpx).toFixed(1).padStart(13) + 'x' +
                String(max).padStart(10) + String(over).padStart(9));
}

const kMpx = bench((p,o,n) => kern.transformArray(p, false, false, false, n, undefined, o));
console.log('  ' + 'WASM kernel'.padEnd(11) + kMpx.toFixed(1).padStart(7) +
            (kMpx/pipeMpx).toFixed(1).padStart(13) + 'x');
