// ============================================================================
// tetra4d_int16_run.js — bit-exactness + bench for the u16 I/O 4D scalar
//                        WASM kernel (src/wasm/tetra4d_nch_int16.wat)
// ============================================================================
//
// Two jobs:
//
//   1. CORRECTNESS — call both the JS reference kernel
//      (`tetrahedralInterp4DArray_{3,4}Ch_intLut16_loop`) and the new WASM
//      kernel on identical KCMY inputs across the 4-config matrix
//      ({g1=9,17} × {cMax=3,4}), assert bit-exact outputs. A single LSB
//      drift fails the run.
//
//   2. SPEED — under the same conditions used for the 3D kernel
//      (`tetra3d_int16_run.js`), measure JS int16 vs WASM int16 MPx/s
//      and derive the speedup. Also report JS int (u8) for context.
//
// Why this lives in bench/wasm_poc/ — same place as the other tetra runs.
// Pre-Transform.js wiring sanity-check; once it passes we hook the kernel
// into the dispatcher and into the int16-wasm-scalar 4D fast path.
//
// Run:    node bench/wasm_poc/tetra4d_int16_run.js
// ============================================================================

'use strict';

const Transform   = require('../../src/Transform.js');
const wasmLoader  = require('../../src/wasm/wasm_loader.js');

// ---- bench parameters -------------------------------------------------------

const PIXEL_COUNT   = 1 << 20;     // 1 Mi pixels per pass
const WARMUP_ITERS  = 50;
const TIMED_BATCHES = 5;
const BATCH_ITERS   = 50;

// ---- LUT construction (4D KCMY → nCh) --------------------------------------

function buildSyntheticIntLut4D(g1, outputChannels) {
    const go0 = outputChannels;
    const go1 = g1 * outputChannels;
    const go2 = g1 * g1 * outputChannels;
    const go3 = g1 * g1 * g1 * outputChannels;
    const CLUT = new Uint16Array(g1 * g1 * g1 * g1 * outputChannels);
    const SCALE = 65280;

    // Synthetic 4D shape: smooth gradient of (C, M, Y) ink coverage with K
    // adding a curved darkening factor. Output is a fake "RGB(K)" mapping.
    const gamma = 0.85;
    for (let xk = 0; xk < g1; xk++) {
        const fk = xk / (g1 - 1);
        for (let xc = 0; xc < g1; xc++) {
            const fc = xc / (g1 - 1);
            for (let xm = 0; xm < g1; xm++) {
                const fm = xm / (g1 - 1);
                for (let xy = 0; xy < g1; xy++) {
                    const fy = xy / (g1 - 1);
                    const idx = xc * go2 + xm * go1 + xy * go0 + xk * go3;
                    const r = (1 - fc) * (1 - 0.7 * fk);
                    const g = (1 - fm) * (1 - 0.7 * fk);
                    const b = (1 - fy) * (1 - 0.7 * fk);
                    const k = Math.min(fc, fm, fy) * 0.5 + fk * 0.5;
                    CLUT[idx    ] = Math.min(SCALE, Math.max(0, Math.round(Math.pow(Math.max(0, r), gamma) * SCALE)));
                    CLUT[idx + 1] = Math.min(SCALE, Math.max(0, Math.round(Math.pow(Math.max(0, g), gamma) * SCALE)));
                    CLUT[idx + 2] = Math.min(SCALE, Math.max(0, Math.round(Math.pow(Math.max(0, b), gamma) * SCALE)));
                    if (outputChannels >= 4) {
                        CLUT[idx + 3] = Math.min(SCALE, Math.max(0, Math.round(Math.pow(k, gamma) * SCALE)));
                    }
                }
            }
        }
    }

    return {
        version: 1,
        dataType: 'u16',
        scale: SCALE,
        gpsPrecisionBits: 16,
        accWidth: 16,
        CLUT: CLUT,
        gridPointsScale_fixed:     Math.round(((g1 - 1) << 16) / 255),
        gridPointsScale_fixed_u16: Math.round(((g1 - 1) << 16) / 65535),
        maxX: (g1 - 1) * go2,
        maxY: (g1 - 1) * go1,
        maxZ: (g1 - 1) * go0,
        maxK: (g1 - 1) * go3,
        inputChannels: 4,
        outputChannels: outputChannels,
        g1: g1,
        go0: go0,
        go1: go1,
        go2: go2,
        go3: go3,
    };
}

// Build u16 KCMY input — corners of the 4D hypercube (every {0, 65535}^4
// combination, 16 corners) + tetra-stress patterns + LCG noise. Boundary
// patch on every axis fires deterministically.
function buildInputKCMY_U16(n) {
    const buf = new Uint16Array(n * 4);
    let idx = 0;

    // 16 corners (input order is K, C, M, Y)
    for (let m = 0; m < 16; m++) {
        buf[idx++] = (m & 1)        ? 65535 : 0;   // K
        buf[idx++] = (m & 2)        ? 65535 : 0;   // C
        buf[idx++] = (m & 4)        ? 65535 : 0;   // M
        buf[idx++] = (m & 8)        ? 65535 : 0;   // Y
    }

    // Tetra-stress: mid-range KCMY combos that hit every case branch.
    const stress = [
        [10000, 50000, 25000, 12500], [10000, 50000, 12500, 25000],
        [10000, 25000, 12500, 50000], [10000, 25000, 50000, 12500],
        [10000, 12500, 50000, 25000], [10000, 12500, 25000, 50000],
        [40000, 50000, 25000, 12500], [40000, 12500, 50000, 25000],
        [40000, 25000, 12500, 50000], [40000, 25000, 50000, 12500],
        [    0, 50000, 25000, 12500], [65535, 50000, 25000, 12500],
    ];
    for (let rep = 0; rep < 3; rep++) {
        for (const [k, c, m, y] of stress) {
            buf[idx++] = k; buf[idx++] = c; buf[idx++] = m; buf[idx++] = y;
        }
    }

    let s = 1234567;
    while (idx < n * 4) {
        s = (s * 1103515245 + 12345) >>> 0;
        buf[idx++] = s & 0xFFFF;
    }
    return buf;
}

// Companion u8 KCMY — same pattern, scaled — for the JS int (u8) reference.
function buildInputKCMY_U8(n) {
    const buf = new Uint8Array(n * 4);
    let idx = 0;
    for (let m = 0; m < 16; m++) {
        buf[idx++] = (m & 1) ? 255 : 0;
        buf[idx++] = (m & 2) ? 255 : 0;
        buf[idx++] = (m & 4) ? 255 : 0;
        buf[idx++] = (m & 8) ? 255 : 0;
    }
    const stress = [
        [40, 200, 100, 50], [40, 200, 50, 100],
        [40, 100, 50, 200], [40, 100, 200, 50],
        [40,  50, 200, 100], [40,  50, 100, 200],
        [160, 200, 100, 50], [160,  50, 200, 100],
        [160, 100,  50, 200], [160, 100, 200, 50],
        [  0, 200, 100, 50], [255, 200, 100, 50],
    ];
    for (let rep = 0; rep < 3; rep++) {
        for (const [k, c, m, y] of stress) {
            buf[idx++] = k; buf[idx++] = c; buf[idx++] = m; buf[idx++] = y;
        }
    }
    let s = 1234567;
    while (idx < n * 4) {
        s = (s * 1103515245 + 12345) >>> 0;
        buf[idx++] = s & 0xFF;
    }
    return buf;
}

// ---- helpers ----------------------------------------------------------------

function diff16(a, b) {
    if (a.length !== b.length) throw new Error('length mismatch');
    let max = 0, exact = 0;
    let firstDiffIdx = -1, firstDiffA = 0, firstDiffB = 0;
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d === 0) exact++;
        if (d > max) { max = d; firstDiffIdx = i; firstDiffA = a[i]; firstDiffB = b[i]; }
    }
    return { max, exact, total: a.length, firstDiffIdx, firstDiffA, firstDiffB };
}

function timeIters(fn) {
    for (let i = 0; i < WARMUP_ITERS; i++) fn();
    const batchMs = [];
    for (let b = 0; b < TIMED_BATCHES; b++) {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < BATCH_ITERS; i++) fn();
        const t1 = process.hrtime.bigint();
        batchMs.push(Number(t1 - t0) / 1e6);
    }
    batchMs.sort((a, b) => a - b);
    const medianMs = batchMs[Math.floor(TIMED_BATCHES / 2)];
    const mpps = (PIXEL_COUNT * BATCH_ITERS / (medianMs / 1000)) / 1e6;
    return { medianMs, mpps };
}

// ---- main -------------------------------------------------------------------

function main() {
    console.log('==================================================================');
    console.log('  WASM int16 vs JS int16 vs JS int (u8) — 4D tetra (KCMY input)');
    console.log('==================================================================');
    console.log('Node                :', process.version);
    console.log('Pixels / pass       :', PIXEL_COUNT.toLocaleString());
    console.log('Warmup iters        :', WARMUP_ITERS);
    console.log('Timed batches       :', TIMED_BATCHES, '×', BATCH_ITERS, 'iters');
    console.log('');

    const transform   = new Transform({});
    const inputU16    = buildInputKCMY_U16(PIXEL_COUNT);
    const inputU8     = buildInputKCMY_U8(PIXEL_COUNT);

    const wasmCache = {};
    const int16State = wasmLoader.createTetra4DInt16State({ wasmCache: wasmCache });
    if (!int16State) {
        console.log('FAIL: createTetra4DInt16State returned null (no WebAssembly?).');
        process.exit(2);
    }
    console.log('WASM module         : tetra4d_nch_int16.wasm.js loaded ✓');
    console.log('');

    const configs = [
        { g1:  9, cMax: 3 },
        { g1:  9, cMax: 4 },
        { g1: 17, cMax: 3 },
        { g1: 17, cMax: 4 },
    ];

    const allResults = [];

    for (const cfg of configs) {
        console.log('------------------------------------------------------------------');
        console.log('  Config: g1=' + cfg.g1 + '  cMax=' + cfg.cMax);
        console.log('------------------------------------------------------------------');

        const intLut = buildSyntheticIntLut4D(cfg.g1, cfg.cMax);
        const cMax = cfg.cMax;
        const lutKB = (intLut.CLUT.byteLength / 1024).toFixed(1);
        console.log('  CLUT          : ' + lutKB + ' KB  (u16 store at scale=65280)');

        // --- JS int16 reference ----------------------------------------
        const jsOut16 = new Uint16Array(PIXEL_COUNT * cMax);
        const jsFn16 = (cMax === 3)
            ? 'tetrahedralInterp4DArray_3Ch_intLut16_loop'
            : 'tetrahedralInterp4DArray_4Ch_intLut16_loop';
        transform[jsFn16](inputU16, 0, jsOut16, 0, PIXEL_COUNT, intLut, false, false, false);

        // --- WASM int16 -------------------------------------------------
        int16State.bind(intLut, PIXEL_COUNT, cMax);
        const wasmOut16 = new Uint16Array(PIXEL_COUNT * cMax);
        int16State.runTetra4D(inputU16, 0, wasmOut16, 0, PIXEL_COUNT, intLut, cMax,
                              false, false, false);

        const d = diff16(jsOut16, wasmOut16);
        if (d.max > 0) {
            const px = (d.firstDiffIdx / cMax) | 0;
            console.log('  WASM int16    : BIT-EXACT FAILURE — pixel ' + px
                      + ' ch ' + (d.firstDiffIdx % cMax)
                      + '  JS=' + d.firstDiffA + '  WASM=' + d.firstDiffB
                      + '  (Δ=' + d.max + ')');
            console.log('                  KCMY input=('
                      + inputU16[px*4] + ',' + inputU16[px*4+1] + ','
                      + inputU16[px*4+2] + ',' + inputU16[px*4+3] + ')');
            console.log('  Aborting bench — fix correctness first.');
            process.exit(1);
        }
        console.log('  WASM int16    : bit-exact vs JS int16 ✓ ('
                  + d.exact.toLocaleString() + ' samples)');

        // --- Speed: JS int16 vs WASM int16 vs JS int (u8) --------------
        const jsOut16_t = new Uint16Array(PIXEL_COUNT * cMax);
        const jsOut8_t  = new Uint8ClampedArray(PIXEL_COUNT * cMax);

        const tJsInt16 = timeIters(() => {
            transform[jsFn16](inputU16, 0, jsOut16_t, 0, PIXEL_COUNT, intLut, false, false, false);
        });
        console.log('  JS int16      : ' + tJsInt16.mpps.toFixed(1).padStart(6) + ' MPx/s   ('
                  + tJsInt16.medianMs.toFixed(2) + ' ms × ' + BATCH_ITERS + ')');

        const wasmOut16_t = new Uint16Array(PIXEL_COUNT * cMax);
        const tWasmInt16 = timeIters(() => {
            int16State.runTetra4D(inputU16, 0, wasmOut16_t, 0, PIXEL_COUNT, intLut, cMax,
                                  false, false, false);
        });
        console.log('  WASM int16    : ' + tWasmInt16.mpps.toFixed(1).padStart(6) + ' MPx/s   ('
                  + tWasmInt16.medianMs.toFixed(2) + ' ms × ' + BATCH_ITERS + ')   '
                  + (tWasmInt16.mpps / tJsInt16.mpps).toFixed(2) + 'x vs JS int16');

        const jsFn8 = (cMax === 3)
            ? 'tetrahedralInterp4DArray_3Ch_intLut_loop'
            : 'tetrahedralInterp4DArray_4Ch_intLut_loop';
        const tJsInt8 = timeIters(() => {
            transform[jsFn8](inputU8, 0, jsOut8_t, 0, PIXEL_COUNT, intLut, false, false, false);
        });
        console.log('  JS int (u8)   : ' + tJsInt8.mpps.toFixed(1).padStart(6) + ' MPx/s   '
                  + '(reference; u8 I/O — naturally faster due to memory bw)');

        allResults.push({
            cfg,
            jsInt16: tJsInt16.mpps,
            wasmInt16: tWasmInt16.mpps,
            jsInt8: tJsInt8.mpps,
            speedup: tWasmInt16.mpps / tJsInt16.mpps,
        });
        console.log('');
    }

    console.log('==================================================================');
    console.log('  Summary');
    console.log('==================================================================');
    console.log('config          JS int16   WASM int16   speedup    (JS u8 ref)');
    console.log('-------         --------   ----------   -------    -----------');
    for (const r of allResults) {
        const cfgStr = ('g1=' + r.cfg.g1 + ' cMax=' + r.cfg.cMax).padEnd(15);
        console.log(cfgStr
            + '  ' + r.jsInt16.toFixed(1).padStart(7)
            + '   ' + r.wasmInt16.toFixed(1).padStart(8)
            + '    ' + r.speedup.toFixed(2).padStart(5) + 'x'
            + '    ' + r.jsInt8.toFixed(1).padStart(7));
    }
    console.log('');

    const avgSpeedup = allResults.reduce((s, r) => s + r.speedup, 0) / allResults.length;
    console.log('Average WASM int16 / JS int16 speedup: ' + avgSpeedup.toFixed(2) + 'x');
    console.log('');
    console.log('All ' + allResults.length + ' configs bit-exact ✓');
}

main();
