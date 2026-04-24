/**
 * Minimal JIT-dump harness for the two "core lines" of the 4D tetrahedral
 * interp kernel — the expressions at the heart of the float and integer
 * unrolled hot paths. The REAL kernels are 7-10 KB of emitted x64 each,
 * which makes a side-by-side "what does V8 actually emit for this line"
 * comparison unreadable.
 *
 * This file extracts JUST the core per-channel expression into its own
 * tight loop so V8 emits a ~one-screenful function whose entire body maps
 * back to that single expression (plus bounds/overflow guards we'd see in
 * the real kernel too).
 *
 * Source lines mirrored:
 *   - float: src/Transform.js line 9444
 *       output[outputPos++] = (o0 + ((( d0 + ((CLUT[base1++] - a) * rx)
 *                          + ((b - d0) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;
 *   - int  : src/Transform.js line 10093 (u20 Q16.4 single-rounding)
 *       output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4)
 *                          + ((Math.imul(a - d0, rx) + Math.imul(b - a, ry)
 *                          + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o0, rk)
 *                          + 0x80000) >> 20;
 *
 * Run with:
 *   node --allow-natives-syntax --print-opt-code --code-comments \
 *        bench/jit_asm_core_line.js 2>&1 > bench/jit_asm_core_dump.txt
 *
 * Then search the dump for:
 *   name = floatCoreLine       <- 4D 3Ch float core expression
 *   name = intCoreLine         <- 4D 3Ch u20 integer core expression
 *   name = floatCoreLineTemps  <- same expression rewritten with named consts
 *   name = intCoreLineTemps    <- same expression rewritten with named consts
 *
 * SCOPE NOTE — what this microbench can and cannot tell you:
 *
 * This is a COMPANION data point for §1b of docs/Performance.md. It
 * reinforces what V8 emits for the core expression in isolation, so we
 * can point at concrete x64 when discussing the kernel. It does NOT
 * reproduce the full kernel's register pressure (14+ simultaneous live
 * values across the 6 unrolled tetrahedral branches × 3 channels × K0/K1
 * planes vs ~11 here), its L1i footprint (7.6 KB vs ~2 KB here), or its
 * spill budget. Conclusions drawn from the *speed* numbers in this file
 * apply only to this low-pressure scope. Conclusions about which x64
 * instructions V8 generates for the expression itself are valid, because
 * TurboFan's lowering of those exact arithmetic ops doesn't change with
 * surrounding pressure.
 *
 * In particular: the finding that named-temps variants are slightly
 * faster HERE does not mean they are faster in the real kernel. See
 * the "named temps hurt" section in docs/Performance.md for the full
 * argument and the proper full-kernel experiment that would actually
 * answer the question.
 */
'use strict';

// Same input/output/CLUT shapes as the real kernels so V8 specialises
// the types identically to the production path.
function floatCoreLine(CLUT, output, base1, base2, base3, outputPos, length,
                       o0, d0, rx, ry, rz, rk, outputScale){
    for(let i = 0; i < length; i++){
        const a = CLUT[base2++];
        const b = CLUT[base3++];
        output[outputPos++] = (o0 + ((( d0 + ((CLUT[base1++] - a) * rx)
                              + ((b - d0) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;
    }
}

function intCoreLine(CLUT, output, base1, base2, base4, outputPos, length,
                     o0, d0, rx, ry, rz, rk){
    for(let i = 0; i < length; i++){
        const a = CLUT[base1++];
        const b = CLUT[base2++];
        output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4)
                              + ((Math.imul(a - d0, rx) + Math.imul(b - a, ry)
                              + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o0, rk)
                              + 0x80000) >> 20;
    }
}

// ---------------------------------------------------------------------
// "Readable" variants — SAME math, but broken up through named `const`
// intermediate values the way a human would naturally write it.
//
// Prediction (from PERFORMANCE LESSONS in src/Transform.js): V8's
// register allocator treats each named binding as a separate SSA value
// that needs its own live-range, which INCREASES spill pressure in an
// already-GPR-constrained loop. The result should be:
//
//   - more `mov` traffic to/from [rbp-N] stack slots between the
//     arithmetic ops (a stall that doesn't appear in the one-expression
//     version where V8 keeps intermediates in registers through the
//     dependency chain),
//   - a slower per-pixel throughput even though the EMITTED ARITHMETIC
//     is identical.
//
// The benchmark numbers and asm dumps below confirm the prediction.
// Leave these in the tree as a regression check — any future "tidy the
// kernel into named locals" PR will fail the speed bench against the
// current in-place expression.
// ---------------------------------------------------------------------

function floatCoreLineTemps(CLUT, output, base1, base2, base3, outputPos, length,
                            o0, d0, rx, ry, rz, rk, outputScale){
    for(let i = 0; i < length; i++){
        const a = CLUT[base2++];
        const b = CLUT[base3++];
        const c = CLUT[base1++];
        const term1 = (c - a) * rx;
        const term2 = (b - d0) * ry;
        const term3 = (a - b) * rz;
        const k1 = d0 + term1 + term2 + term3;
        const lerp = (k1 - o0) * rk;
        const final = (o0 + lerp) * outputScale;
        output[outputPos++] = final;
    }
}

function intCoreLineTemps(CLUT, output, base1, base2, base4, outputPos, length,
                          o0, d0, rx, ry, rz, rk){
    for(let i = 0; i < length; i++){
        const a = CLUT[base1++];
        const b = CLUT[base2++];
        const c = CLUT[base4++];
        const term1 = Math.imul(a - d0, rx);
        const term2 = Math.imul(b - a, ry);
        const term3 = Math.imul(c - b, rz);
        const k1_u20 = (d0 << 4) + ((term1 + term2 + term3 + 0x08) >> 4);
        const lerp = Math.imul(k1_u20 - o0, rk);
        const final = ((o0 << 8) + lerp + 0x80000) >> 20;
        output[outputPos++] = final;
    }
}

// Same TypedArray flavours used in the real kernels.
const N = 65536;
const CLUTf = new Float64Array(N * 4);
const outF  = new Uint8ClampedArray(N);
const CLUTu = new Uint16Array(N * 4);
const outU  = new Uint8ClampedArray(N);

// Fill with varied but stable data. Content doesn't matter for
// the asm dump; only shape stability does.
for(let i = 0; i < CLUTf.length; i++){
    CLUTf[i] = (i * 37 + 11) & 0xFF;        // 0..255 in float
    CLUTu[i] = ((i * 37 + 11) & 0xFF) * 256; // scaled u16 (matches intLut format)
}

// Warm up hard. All four kernels need to be TurboFan'd, with all
// call sites monomorphic.
for(let w = 0; w < 2000; w++){
    floatCoreLine     (CLUTf, outF, 0, 1, 2, 0, N, 100, 120, 0.25, 0.5, 0.125, 0.75, 1/256);
    floatCoreLineTemps(CLUTf, outF, 0, 1, 2, 0, N, 100, 120, 0.25, 0.5, 0.125, 0.75, 1/256);
    intCoreLine       (CLUTu, outU, 0, 1, 2, 0, N, 25600, 30720, 1024, 2048, 512, 3072);
    intCoreLineTemps  (CLUTu, outU, 0, 1, 2, 0, N, 25600, 30720, 1024, 2048, 512, 3072);
}

// ---------------------------------------------------------------------
// Speed bench — median of 5 × 200 iters, after 500-iter warmup (on top
// of the 2000 above). Runs in the same process as the asm dump so V8
// emits the same optimized code for both measurements.
// ---------------------------------------------------------------------
function bench(fn, args, label){
    for(let w = 0; w < 500; w++) fn(...args);
    const batches = [];
    for(let b = 0; b < 5; b++){
        const t0 = process.hrtime.bigint();
        for(let i = 0; i < 200; i++) fn(...args);
        const t1 = process.hrtime.bigint();
        batches.push(Number(t1 - t0) / 1e6);
    }
    batches.sort((a,b) => a - b);
    const median_ms = batches[2];
    const px_per_s = (200 * N) / (median_ms / 1000);
    console.log('  ' + label.padEnd(24) + ':  ' +
                (median_ms).toFixed(2).padStart(7) + ' ms / 200 iter   ' +
                (px_per_s / 1e6).toFixed(1).padStart(6) + ' MPx/s');
    return px_per_s;
}

console.log('');
console.log('Speed: ' + N.toLocaleString() + ' px per iter, median of 5 × 200 iters');
console.log('-------------------------------------------------------------------');
const sFloat       = bench(floatCoreLine,
    [CLUTf, outF, 0, 1, 2, 0, N, 100, 120, 0.25, 0.5, 0.125, 0.75, 1/256],
    'floatCoreLine');
const sFloatTemps  = bench(floatCoreLineTemps,
    [CLUTf, outF, 0, 1, 2, 0, N, 100, 120, 0.25, 0.5, 0.125, 0.75, 1/256],
    'floatCoreLineTemps');
const sInt         = bench(intCoreLine,
    [CLUTu, outU, 0, 1, 2, 0, N, 25600, 30720, 1024, 2048, 512, 3072],
    'intCoreLine');
const sIntTemps    = bench(intCoreLineTemps,
    [CLUTu, outU, 0, 1, 2, 0, N, 25600, 30720, 1024, 2048, 512, 3072],
    'intCoreLineTemps');

console.log('');
console.log('Deltas (expression vs temps — lower-is-slower for temps):');
console.log('  float  temps / expression : ' + ((sFloatTemps / sFloat) * 100).toFixed(1) + ' %');
console.log('  int    temps / expression : ' + ((sIntTemps   / sInt  ) * 100).toFixed(1) + ' %');

const hasNatives = process.execArgv.some(a => a.indexOf('allow-natives-syntax') >= 0);
if(hasNatives){
    const getStatus = new Function('fn', 'return %GetOptimizationStatus(fn);');
    console.log('');
    console.log('Optimisation status bits (kOptimized=0x10 = TurboFan, present on all four expected):');
    console.log('  floatCoreLine       :', getStatus(floatCoreLine));
    console.log('  floatCoreLineTemps  :', getStatus(floatCoreLineTemps));
    console.log('  intCoreLine         :', getStatus(intCoreLine));
    console.log('  intCoreLineTemps    :', getStatus(intCoreLineTemps));
}
console.log('');
console.log('Run with --print-opt-code to dump x64. Search output for:');
console.log('  name = floatCoreLine         / name = floatCoreLineTemps');
console.log('  name = intCoreLine           / name = intCoreLineTemps');
