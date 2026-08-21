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
 * matrixShaperJS.js — the matrix-shaper kernel in plain JS.
 *
 * Same fused 3x3 and the same curves the WASM kernel reads, off
 * `stage_matrix_rgb.stageData` and the two gamma stages. Measured at
 * 62 MPx/s at int8 and 57 at int16 (`bench/js_matrix_shaper/`), against 8 for
 * the stage pipeline it replaces and 329 / 220 for WASM.
 *
 * IT IS NOT A FALLBACK FOR SLOW HOSTS. It is here for two things WASM cannot
 * do, and being clear about that stops it being sold as a speed feature:
 *
 *   1. PER-CHANNEL TRCs. The WASM kernel keeps one input table and one output
 *      table shared across R/G/B, so a profile whose rTRC/gTRC/bTRC genuinely
 *      differ has to fall back to the stage pipeline at ~8 MPx/s. JS has no
 *      table-size pressure: three in and three out cost nothing but memory,
 *      and when the curves ARE grey all three references point at one table,
 *      so the common case allocates once and the code does not branch.
 *   2. Hosts with no WebAssembly at all.
 *
 * SHAPE, and why it is this shape — every point below was measured, and three
 * of them contradict the guidance that holds for the tetrahedral kernels
 * (`bench/js_matrix_shaper/run.js`):
 *
 *   - INPUT TABLE INDEXED BY THE RAW CODE. Exact, one entry per possible
 *     input, and identical source at both bit depths — only the table length
 *     changes. Normalising with a flat 1/255 or 1/65535 multiply into a
 *     4096-entry device-indexed curve was tried: 22% slower AND less accurate
 *     (2 LSB at int8, 360 at int16).
 *   - OUTPUT TABLE INDEXED BY v^(1/4), same as the WASM kernel. A linear index
 *     measures 7 LSB at int16 with 70,625 samples beyond 1, because a power
 *     TRC's encode curve has unbounded slope at zero. Two Math.sqrt per
 *     channel cost NOTHING — at int8 the quartic form is the fastest variant
 *     measured.
 *   - NAMING INTERMEDIATES IS FREE. Adding three more locals measured 61.1
 *     against 61.3. The documented spill problem is a GPR problem and these
 *     are doubles: nine coefficients plus six values live in the 16-register
 *     XMM file and never compete with the pointers. Taken literally, avoiding
 *     intermediates is a 7% LOSS — it means nine input lookups per pixel
 *     instead of three.
 *   - UNROLLING IS WORTH 3% HERE, not the load-bearing lever it is in the
 *     tetrahedral kernels, and address arithmetic does not register at all
 *     (`p, p+1, p+2` vs `p++` vs a running pointer: all within noise).
 *
 * The reason every micro-choice measures flat: the loop is bound on a
 * dependent load chain — `px[p]` -> `iT[...]` -> arithmetic -> `oT[...]` —
 * two dependent lookups per channel, the second a scattered access into a
 * large table. Everything else hides underneath it.
 */
'use strict';

// Quartic-indexed output table. 2^17 entries: the index resolution is what
// buys <= 1 LSB at int16, and it costs nothing at int8 beyond memory.
var QN = 131072, QMAX = QN - 1;

/** Run a curve stage on one value, returning all three channels. */
function curveAt(transform, stage, v){
    return stage.funct.call(transform, [v, v, v], stage.stageData, stage);
}

/**
 * Build the six tables. When the curves are grey — which is every ordinary
 * working space — the three references are THE SAME OBJECT, so the common case
 * allocates one input and one output table and the hot loop cannot tell the
 * difference.
 */
function buildTables(transform, stages, bits, grey){
    var codes  = bits === 8 ? 256 : 65536;
    var maxIn  = codes - 1;
    var maxOut = bits === 8 ? 255 : 65535;
    var OutArr = bits === 8 ? Uint8Array : Uint16Array;
    var i, c, e, lin;

    var iT = [], oT = [];
    var channels = grey ? 1 : 3;

    for(c = 0; c < channels; c++){
        var inTable = new Float64Array(codes);
        for(i = 0; i < codes; i++) inTable[i] = curveAt(transform, stages.inv, i / maxIn)[c];
        iT.push(inTable);

        var outTable = new OutArr(QN);
        for(i = 0; i < QN; i++){
            lin = i / QMAX; lin *= lin; lin *= lin;          // v = t^4
            e = Math.round(curveAt(transform, stages.fwd, lin)[c] * maxOut);
            outTable[i] = e < 0 ? 0 : (e > maxOut ? maxOut : e);
        }
        oT.push(outTable);
    }
    if(grey){ iT[1] = iT[2] = iT[0]; oT[1] = oT[2] = oT[0]; }
    return {iT: iT, oT: oT};
}

/**
 * Build a JS runner for this Transform, or null if the pipeline is not one it
 * can serve. `check` is the result of matrixShaperKernel.inspect().
 */
function build(transform, check){
    var bits   = check.bits;
    var tables = buildTables(transform, check.stages, bits, !check.perChannel);
    var iR = tables.iT[0], iG = tables.iT[1], iB = tables.iT[2];
    var oR = tables.oT[0], oG = tables.oT[1], oB = tables.oT[2];

    var m = check.stages.mat.stageData;
    var m00 = m.m00, m01 = m.m01, m02 = m.m02;
    var m10 = m.m10, m11 = m.m11, m12 = m.m12;
    var m20 = m.m20, m21 = m.m21, m22 = m.m22;

    var maxOut = bits === 8 ? 255 : 65535;

    return {
        variant: bits + '-js',
        bits: bits,
        simd: false,
        js: true,
        perChannel: !!check.perChannel,

        /**
         * `output` is written in place and returned.
         *
         * Two loops rather than a branch inside one: the 3->3 case is the hot
         * one and must not carry a per-pixel test for a channel it does not
         * have. Alpha is a stride and a copy, never colour-managed.
         */
        run: function(input, output, pixelCount, inHasAlpha, outHasAlpha, preserveAlpha){
            var inCh  = inHasAlpha  ? 4 : 3;
            var outCh = outHasAlpha ? 4 : 3;
            var i, end, r, g, b, v;

            if(inCh === 3 && outCh === 3){
                for(i = 0, end = pixelCount * 3; i < end; i += 3){
                    r = iR[input[i]]; g = iG[input[i + 1]]; b = iB[input[i + 2]];

                    v = m00 * r + m01 * g + m02 * b;
                    v = v < 0 ? 0 : (v > 1 ? 1 : v);
                    output[i]     = oR[(Math.sqrt(Math.sqrt(v)) * QMAX + 0.5) | 0];

                    v = m10 * r + m11 * g + m12 * b;
                    v = v < 0 ? 0 : (v > 1 ? 1 : v);
                    output[i + 1] = oG[(Math.sqrt(Math.sqrt(v)) * QMAX + 0.5) | 0];

                    v = m20 * r + m21 * g + m22 * b;
                    v = v < 0 ? 0 : (v > 1 ? 1 : v);
                    output[i + 2] = oB[(Math.sqrt(Math.sqrt(v)) * QMAX + 0.5) | 0];
                }
                return output;
            }

            // Alpha shapes. `preserveAlpha` only means anything when the input
            // has an alpha to preserve; otherwise the channel is written
            // opaque, matching the LUT kernels' fill-255 mode.
            var copyAlpha = outCh === 4 && inCh === 4 && preserveAlpha;
            for(i = 0; i < pixelCount; i++){
                var ip = i * inCh, op = i * outCh;
                r = iR[input[ip]]; g = iG[input[ip + 1]]; b = iB[input[ip + 2]];

                v = m00 * r + m01 * g + m02 * b;
                v = v < 0 ? 0 : (v > 1 ? 1 : v);
                output[op]     = oR[(Math.sqrt(Math.sqrt(v)) * QMAX + 0.5) | 0];

                v = m10 * r + m11 * g + m12 * b;
                v = v < 0 ? 0 : (v > 1 ? 1 : v);
                output[op + 1] = oG[(Math.sqrt(Math.sqrt(v)) * QMAX + 0.5) | 0];

                v = m20 * r + m21 * g + m22 * b;
                v = v < 0 ? 0 : (v > 1 ? 1 : v);
                output[op + 2] = oB[(Math.sqrt(Math.sqrt(v)) * QMAX + 0.5) | 0];

                if(outCh === 4) output[op + 3] = copyAlpha ? input[ip + 3] : maxOut;
            }
            return output;
        }
    };
}

module.exports = { build: build };
