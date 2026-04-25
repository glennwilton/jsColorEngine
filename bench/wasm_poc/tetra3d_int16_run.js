// ============================================================================
// tetra3d_int16_run.js — bit-exactness + bench for the u16 I/O 3D scalar
//                        WASM kernel (src/wasm/tetra3d_nch_int16.wat)
// ============================================================================
//
// Two jobs:
//
//   1. CORRECTNESS — call both the JS reference kernel
//      (`tetrahedralInterp3DArray_{3,4}Ch_intLut16_loop`) and the new WASM
//      kernel on identical inputs across the 6-config matrix
//      ({g1=17,33,65} × {cMax=3,4}), assert bit-exact outputs. A single
//      LSB drift fails the run.
//
//   2. SPEED — under the same conditions used for the u8 kernel
//      (`tetra3d_run.js`), measure JS int16 vs WASM int16 MPx/s and
//      derive the speedup. Also report JS int (u8) for context — the
//      u16 path is naturally slower than u8 due to memory bandwidth
//      (≤ ~0.7-0.9× per Firefox baseline; see Roadmap.md v1.3 16-bit
//      measured baseline).
//
// Why this lives in bench/wasm_poc/ — same place as `tetra3d_run.js`,
// `tetra4d_nch_run.js` etc. Pre-Transform.js wiring sanity-check; once
// it passes we hook the kernel into the dispatcher.
//
// Run:    node bench/wasm_poc/tetra3d_int16_run.js
// ============================================================================

'use strict';

const path        = require('path');
const Transform   = require('../../src/Transform.js');
const wasmLoader  = require('../../src/wasm/wasm_loader.js');

// ---- bench parameters -------------------------------------------------------

const PIXEL_COUNT   = 1 << 20;     // 1 Mi pixels per pass
const WARMUP_ITERS  = 50;
const TIMED_BATCHES = 5;
const BATCH_ITERS   = 50;          // u16 path is slower per pixel; halve

// ---- LUT construction (mirrors tetra3d_run.js) -----------------------------

function buildSyntheticIntLut(g1, outputChannels) {
    const go0 = outputChannels;
    const go1 = g1 * outputChannels;
    const go2 = g1 * g1 * outputChannels;
    const CLUT = new Uint16Array(g1 * g1 * g1 * outputChannels);
    const SCALE = 65280;

    const gamma = 0.85;
    for (let x = 0; x < g1; x++) {
        for (let y = 0; y < g1; y++) {
            for (let z = 0; z < g1; z++) {
                const fx = x / (g1 - 1);
                const fy = y / (g1 - 1);
                const fz = z / (g1 - 1);
                const r = 0.90 * fx + 0.05 * fy + 0.05 * fz;
                const g = 0.05 * fx + 0.90 * fy + 0.05 * fz;
                const b = 0.05 * fx + 0.05 * fy + 0.90 * fz;
                const k = Math.min(fx, fy, fz) * 0.5;
                const idx = (x * go2 + y * go1 + z * go0);
                CLUT[idx    ] = Math.min(SCALE, Math.max(0, Math.round(Math.pow(r, gamma) * SCALE)));
                CLUT[idx + 1] = Math.min(SCALE, Math.max(0, Math.round(Math.pow(g, gamma) * SCALE)));
                CLUT[idx + 2] = Math.min(SCALE, Math.max(0, Math.round(Math.pow(b, gamma) * SCALE)));
                if (outputChannels >= 4) {
                    CLUT[idx + 3] = Math.min(SCALE, Math.max(0, Math.round(Math.pow(k, gamma) * SCALE)));
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
        maxK: 0,
        inputChannels: 3,
        outputChannels: outputChannels,
        g1: g1,
        go0: go0,
        go1: go1,
        go2: go2,
        go3: 0,
    };
}

// Build u16 input — corners + tetra-stress + LCG noise. Each "corner" is
// one of {0, 65535} per channel so the boundary patch fires deterministically.
function buildInputU16(n) {
    const buf = new Uint16Array(n * 3);
    let idx = 0;
    const corners = [
        [0, 0, 0], [65535, 0, 0], [0, 65535, 0], [0, 0, 65535],
        [65535, 65535, 0], [65535, 0, 65535], [0, 65535, 65535], [65535, 65535, 65535],
    ];
    for (const [r, g, b] of corners) { buf[idx++] = r; buf[idx++] = g; buf[idx++] = b; }
    const tetraStress = [
        [50000, 25000, 12500], [50000, 12500, 25000], [25000, 12500, 50000],
        [25000, 50000, 12500], [12500, 50000, 25000], [12500, 25000, 50000],
    ];
    for (let rep = 0; rep < 3; rep++) {
        for (const [r, g, b] of tetraStress) { buf[idx++] = r; buf[idx++] = g; buf[idx++] = b; }
    }
    let s = 1234567;
    while (idx < n * 3) {
        s = (s * 1103515245 + 12345) >>> 0;
        buf[idx++] = s & 0xFFFF;
    }
    return buf;
}

// Companion u8 input — same pattern, scaled down — for the JS int (u8)
// reference timing.
function buildInputU8(n) {
    const buf = new Uint8Array(n * 3);
    let idx = 0;
    const corners = [
        [0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255],
        [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ];
    for (const [r, g, b] of corners) { buf[idx++] = r; buf[idx++] = g; buf[idx++] = b; }
    const tetraStress = [
        [200, 100, 50], [200, 50, 100], [100, 50, 200],
        [100, 200, 50], [50, 200, 100], [50, 100, 200],
    ];
    for (let rep = 0; rep < 3; rep++) {
        for (const [r, g, b] of tetraStress) { buf[idx++] = r; buf[idx++] = g; buf[idx++] = b; }
    }
    let s = 1234567;
    while (idx < n * 3) {
        s = (s * 1103515245 + 12345) >>> 0;
        buf[idx++] = s & 0xFF;
    }
    return buf;
}

// ---- helpers ----------------------------------------------------------------

function diff16(a, b) {
    if (a.length !== b.length) throw new Error('length mismatch');
    let max = 0, exact = 0, off1 = 0;
    let firstDiffIdx = -1, firstDiffA = 0, firstDiffB = 0;
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d === 0) exact++;
        else if (d === 1) off1++;
        if (d > max) { max = d; firstDiffIdx = i; firstDiffA = a[i]; firstDiffB = b[i]; }
    }
    return { max, exact, off1, total: a.length, firstDiffIdx, firstDiffA, firstDiffB };
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
    console.log('  WASM int16 vs JS int16 vs JS int (u8) — 3D tetra, full matrix');
    console.log('==================================================================');
    console.log('Node                :', process.version);
    console.log('Pixels / pass       :', PIXEL_COUNT.toLocaleString());
    console.log('Warmup iters        :', WARMUP_ITERS);
    console.log('Timed batches       :', TIMED_BATCHES, '×', BATCH_ITERS, 'iters');
    console.log('');

    const transform   = new Transform({});
    const inputU16    = buildInputU16(PIXEL_COUNT);
    const inputU8     = buildInputU8(PIXEL_COUNT);

    // Single shared wasmCache bag — module compiled once across all configs.
    const wasmCache = {};
    const int16State = wasmLoader.createTetra3DInt16State({ wasmCache: wasmCache });
    if (!int16State) {
        console.log('FAIL: createTetra3DInt16State returned null (no WebAssembly?).');
        process.exit(2);
    }
    console.log('WASM module         : tetra3d_nch_int16.wasm.js loaded ✓');
    console.log('');

    const configs = [
        { g1: 17, cMax: 3 },
        { g1: 17, cMax: 4 },
        { g1: 33, cMax: 3 },
        { g1: 33, cMax: 4 },
        { g1: 65, cMax: 3 },
        { g1: 65, cMax: 4 },
    ];

    const allResults = [];

    for (const cfg of configs) {
        console.log('------------------------------------------------------------------');
        console.log('  Config: g1=' + cfg.g1 + '  cMax=' + cfg.cMax);
        console.log('------------------------------------------------------------------');

        const intLut = buildSyntheticIntLut(cfg.g1, cfg.cMax);
        const cMax = cfg.cMax;
        const lutKB = (intLut.CLUT.byteLength / 1024).toFixed(1);
        console.log('  CLUT          : ' + lutKB + ' KB  (u16 store at scale=65280)');

        // --- JS int16 reference ----------------------------------------
        const jsOut16 = new Uint16Array(PIXEL_COUNT * cMax);
        const jsFn16 = (cMax === 3)
            ? 'tetrahedralInterp3DArray_3Ch_intLut16_loop'
            : 'tetrahedralInterp3DArray_4Ch_intLut16_loop';
        transform[jsFn16](inputU16, 0, jsOut16, 0, PIXEL_COUNT, intLut, false, false, false);

        // --- WASM int16 -------------------------------------------------
        int16State.bind(intLut, PIXEL_COUNT, cMax);
        const wasmOut16 = new Uint16Array(PIXEL_COUNT * cMax);
        int16State.runTetra3D(inputU16, 0, wasmOut16, 0, PIXEL_COUNT, intLut, cMax,
                              false, false, false);

        const d = diff16(jsOut16, wasmOut16);
        if (d.max > 0) {
            const px = (d.firstDiffIdx / cMax) | 0;
            console.log('  WASM int16    : BIT-EXACT FAILURE — pixel ' + px
                      + ' ch ' + (d.firstDiffIdx % cMax)
                      + '  JS=' + d.firstDiffA + '  WASM=' + d.firstDiffB
                      + '  (Δ=' + d.max + ')');
            console.log('                  input=(' + inputU16[px*3] + ',' + inputU16[px*3+1] + ',' + inputU16[px*3+2] + ')');
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
            int16State.runTetra3D(inputU16, 0, wasmOut16_t, 0, PIXEL_COUNT, intLut, cMax,
                                  false, false, false);
        });
        console.log('  WASM int16    : ' + tWasmInt16.mpps.toFixed(1).padStart(6) + ' MPx/s   ('
                  + tWasmInt16.medianMs.toFixed(2) + ' ms × ' + BATCH_ITERS + ')   '
                  + (tWasmInt16.mpps / tJsInt16.mpps).toFixed(2) + 'x vs JS int16');

        const jsFn8 = (cMax === 3)
            ? 'tetrahedralInterp3DArray_3Ch_intLut_loop'
            : 'tetrahedralInterp3DArray_4Ch_intLut_loop';
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

    // --- summary -----------------------------------------------------------
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
