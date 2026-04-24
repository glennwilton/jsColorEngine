// ============================================================================
// tetra3d_simd_run.js — WASM SIMD vs WASM scalar vs JS for 3D tetra, int path
// ============================================================================
//
// Matrix:
//   grid sizes      : 17, 33, 65
//   output channels : 3, 4
//   kernels         :
//     JS_prod         = Transform.js _{3,4}Ch_intLut_loop  (production int path)
//     WASM_scalar     = src/wasm/tetra3d_nch.wat            (shipped v1.2 kernel)
//     WASM_simd       = bench/wasm_poc/tetra3d_simd.wat     (NEW — this POC)
//
// Bit-exact requirement: SIMD must match scalar WASM and JS on every pixel.
// For cMax=3, the SIMD kernel writes 4 bytes per pixel and advances 3, so the
// output buffer is over-allocated by 1 byte (see tetra3d_simd.wat header).
//
// ============================================================================

'use strict';

const fs = require('fs');
const path = require('path');
const wabtFactory = require('wabt');
const Transform = require('../../src/Transform.js');

// ---- bench parameters -------------------------------------------------------

const PIXEL_COUNT   = 1 << 20;
const WARMUP_ITERS  = 50;
const TIMED_BATCHES = 5;
const BATCH_ITERS   = 100;

// ---- LUT + input builders (copied from tetra3d_run.js so this file stands
// alone; shared helpers can move to a util file once the POC is greenlit) ----

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
        CLUT,
        gridPointsScale_fixed: Math.round(((g1 - 1) << 16) / 255),
        maxX: (g1 - 1) * go2,
        maxY: (g1 - 1) * go1,
        maxZ: (g1 - 1) * go0,
        inputChannels: 3,
        outputChannels,
        g1, go0, go1, go2, go3: 0,
    };
}

function buildInput(n) {
    const buf = new Uint8Array(n * 3);
    let idx = 0;
    // Corners exercise every boundary patch (255 on each axis).
    const corners = [
        [0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255],
        [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ];
    for (const [r, g, b] of corners) {
        buf[idx++] = r; buf[idx++] = g; buf[idx++] = b;
    }
    // Tetra-stress inputs hit all 6 case-dispatch branches.
    const tetraStress = [
        [200, 100, 50], [200, 50, 100], [100, 50, 200],
        [100, 200, 50], [50, 200, 100], [50, 100, 200],
    ];
    for (let rep = 0; rep < 3; rep++) {
        for (const [r, g, b] of tetraStress) {
            buf[idx++] = r; buf[idx++] = g; buf[idx++] = b;
        }
    }
    let s = 1234567;
    while (idx < n * 3) {
        s = (s * 1103515245 + 12345) >>> 0;
        buf[idx++] = s & 0xFF;
    }
    return buf;
}

// ---- helpers ----------------------------------------------------------------

function bytesToString(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

function diff(a, b, compareLen) {
    const len = compareLen != null ? compareLen : a.length;
    let max = 0, firstDiffIdx = -1, firstDiffA = 0, firstDiffB = 0;
    for (let i = 0; i < len; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d > max) {
            max = d;
            firstDiffIdx = i;
            firstDiffA = a[i];
            firstDiffB = b[i];
        }
    }
    return { max, firstDiffIdx, firstDiffA, firstDiffB };
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

async function compileWasm(wabt, absPath) {
    const wat = fs.readFileSync(absPath, 'utf8');
    const name = path.basename(absPath);
    const mod = wabt.parseWat(name, wat, { simd: true, multi_value: true, mutable_globals: true });
    const { buffer } = mod.toBinary({});
    mod.destroy();
    return buffer;
}

function pages(bytes) { return Math.ceil(bytes / 65536); }

// ---- main -------------------------------------------------------------------

async function main() {
    console.log('==================================================================');
    console.log('  WASM SIMD vs WASM scalar vs JS — 3D tetrahedral int');
    console.log('==================================================================');
    console.log('Node                :', process.version);
    console.log('Pixels / pass       :', PIXEL_COUNT.toLocaleString());
    console.log('Warmup iters        :', WARMUP_ITERS);
    console.log('Timed batches       :', TIMED_BATCHES, '×', BATCH_ITERS, 'iters');
    console.log('');

    const wabt = await wabtFactory();
    const wasmBytesScalar = await compileWasm(wabt, path.join(__dirname, '..', '..', 'src', 'wasm', 'tetra3d_nch.wat'));
    const wasmBytesSimd   = await compileWasm(wabt, path.join(__dirname, 'tetra3d_simd.wat'));
    console.log('WASM scalar (nCh)   :', bytesToString(wasmBytesScalar.length));
    console.log('WASM SIMD           :', bytesToString(wasmBytesSimd.length));
    console.log('');

    const transform = new Transform({});
    const input = buildInput(PIXEL_COUNT);

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
        const inputBytes  = PIXEL_COUNT * 3;
        const outputBytes = PIXEL_COUNT * cMax;
        // +1 slack byte for cMax=3 (SIMD writes 4 bytes on the last pixel).
        // Round up to 2-byte alignment so the LUT (u16) that follows is aligned.
        const outputBytesAlloc = (outputBytes + (cMax === 3 ? 1 : 0) + 1) & ~1;
        const lutBytes    = intLut.CLUT.byteLength;

        console.log('  CLUT          : ' + (lutBytes / 1024).toFixed(1) + ' KB');

        // --- JS reference ---------------------------------------------
        const jsOutput = new Uint8ClampedArray(outputBytes);
        const jsFnName = (cMax === 3)
            ? 'tetrahedralInterp3DArray_3Ch_intLut_loop'
            : 'tetrahedralInterp3DArray_4Ch_intLut_loop';
        transform[jsFnName](input, 0, jsOutput, 0, PIXEL_COUNT, intLut, false, false, false);

        // --- WASM scalar ----------------------------------------------
        const scalarInst = (await WebAssembly.instantiate(wasmBytesScalar, {})).instance.exports;
        const inputPtr  = 0;
        const outputPtr = inputBytes;
        const lutPtr    = inputBytes + outputBytesAlloc;
        const totalBytes = lutPtr + lutBytes;
        {
            const have = scalarInst.memory.buffer.byteLength / 65536;
            if (have < pages(totalBytes)) scalarInst.memory.grow(pages(totalBytes) - have);
            const mem = new Uint8Array(scalarInst.memory.buffer);
            const memU16 = new Uint16Array(scalarInst.memory.buffer);
            mem.set(input, inputPtr);
            memU16.set(intLut.CLUT, lutPtr >> 1);
        }
        scalarInst.interp_tetra3d_nCh(
            inputPtr, outputPtr, lutPtr,
            PIXEL_COUNT, cMax,
            intLut.go0, intLut.go1, intLut.go2,
            intLut.gridPointsScale_fixed,
            intLut.maxX, intLut.maxY, intLut.maxZ,
            0, 0 // no alpha
        );
        const scalarOut = new Uint8Array(scalarInst.memory.buffer, outputPtr, outputBytes).slice();
        {
            const d = diff(jsOutput, scalarOut, outputBytes);
            if (d.max > 0) {
                console.log('  WASM scalar   : BIT-EXACT FAIL vs JS — idx ' + d.firstDiffIdx
                          + '  JS=' + d.firstDiffA + '  WASM=' + d.firstDiffB);
                process.exit(1);
            }
        }
        console.log('  WASM scalar   : bit-exact vs JS ✓');

        // --- WASM SIMD ------------------------------------------------
        const simdInst = (await WebAssembly.instantiate(wasmBytesSimd, {})).instance.exports;
        {
            const have = simdInst.memory.buffer.byteLength / 65536;
            if (have < pages(totalBytes)) simdInst.memory.grow(pages(totalBytes) - have);
            const mem = new Uint8Array(simdInst.memory.buffer);
            const memU16 = new Uint16Array(simdInst.memory.buffer);
            mem.set(input, inputPtr);
            memU16.set(intLut.CLUT, lutPtr >> 1);
            // Clear the output region so any missed write shows up as a 0 diff.
            mem.fill(0xAA, outputPtr, outputPtr + outputBytesAlloc);
        }
        simdInst.interp_tetra3d_simd(
            inputPtr, outputPtr, lutPtr,
            PIXEL_COUNT, cMax,
            intLut.go0, intLut.go1, intLut.go2,
            intLut.gridPointsScale_fixed,
            intLut.maxX, intLut.maxY, intLut.maxZ,
            0, 0 // inAlphaSkip, outAlphaMode — no alpha for speed bench
        );
        const simdOut = new Uint8Array(simdInst.memory.buffer, outputPtr, outputBytes).slice();
        {
            const d = diff(jsOutput, simdOut, outputBytes);
            if (d.max > 0) {
                const px  = (d.firstDiffIdx / cMax) | 0;
                const ch  = d.firstDiffIdx % cMax;
                const r = input[px*3], g = input[px*3+1], b = input[px*3+2];
                console.log('  WASM SIMD     : BIT-EXACT FAIL vs JS');
                console.log('                  idx ' + d.firstDiffIdx
                          + ' (px ' + px + ' ch ' + ch + ')'
                          + '  JS=' + d.firstDiffA + '  SIMD=' + d.firstDiffB);
                console.log('                  input RGB=(' + r + ',' + g + ',' + b + ')');
                process.exit(1);
            }
        }
        console.log('  WASM SIMD     : bit-exact vs JS ✓');

        // --- Speed benchmark ------------------------------------------
        const jsBuf = new Uint8ClampedArray(outputBytes);
        const jsResult = timeIters(() => {
            transform[jsFnName](input, 0, jsBuf, 0, PIXEL_COUNT, intLut, false, false, false);
        });
        const scalarResult = timeIters(() => {
            scalarInst.interp_tetra3d_nCh(
                inputPtr, outputPtr, lutPtr,
                PIXEL_COUNT, cMax,
                intLut.go0, intLut.go1, intLut.go2,
                intLut.gridPointsScale_fixed,
                intLut.maxX, intLut.maxY, intLut.maxZ,
                0, 0
            );
        });
        const simdResult = timeIters(() => {
            simdInst.interp_tetra3d_simd(
                inputPtr, outputPtr, lutPtr,
                PIXEL_COUNT, cMax,
                intLut.go0, intLut.go1, intLut.go2,
                intLut.gridPointsScale_fixed,
                intLut.maxX, intLut.maxY, intLut.maxZ,
                0, 0
            );
        });

        console.log('  Speed:');
        console.log('    JS production  :' + jsResult.mpps.toFixed(1).padStart(8)  + ' MPx/s   1.00×  (baseline)');
        console.log('    WASM scalar    :' + scalarResult.mpps.toFixed(1).padStart(8)  + ' MPx/s   '
                    + (scalarResult.mpps / jsResult.mpps).toFixed(2) + '× vs JS');
        console.log('    WASM SIMD      :' + simdResult.mpps.toFixed(1).padStart(8) + ' MPx/s   '
                    + (simdResult.mpps / jsResult.mpps).toFixed(2)   + '× vs JS     '
                    + (simdResult.mpps / scalarResult.mpps).toFixed(2) + '× vs WASM scalar');
        console.log('');

        allResults.push({
            cfg,
            js: jsResult.mpps,
            scalar: scalarResult.mpps,
            simd: simdResult.mpps,
        });
    }

    console.log('==================================================================');
    console.log('  Summary');
    console.log('==================================================================');
    console.log('');
    console.log('  g1  cMax  JS MPx/s  scalar MPx/s  SIMD MPx/s  SIMD/JS   SIMD/scalar');
    console.log('  --  ----  --------  ------------  ----------  -------   -----------');
    for (const r of allResults) {
        console.log('  ' + String(r.cfg.g1).padStart(2)
                  + '  ' + String(r.cfg.cMax).padStart(4)
                  + '   ' + r.js.toFixed(1).padStart(7)
                  + '   ' + r.scalar.toFixed(1).padStart(10)
                  + '   ' + r.simd.toFixed(1).padStart(8)
                  + '    ' + (r.simd / r.js).toFixed(2).padStart(5) + '×'
                  + '    ' + (r.simd / r.scalar).toFixed(2).padStart(5) + '×');
    }
    console.log('');

    // Verdict
    const vsJs  = allResults.map(r => r.simd / r.js);
    const vsSc  = allResults.map(r => r.simd / r.scalar);
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    console.log('------------------------------------------------------------------');
    console.log('  Verdict');
    console.log('------------------------------------------------------------------');
    console.log('  SIMD vs JS          : avg ' + avg(vsJs).toFixed(2) + '×'
              + '  (range ' + Math.min(...vsJs).toFixed(2) + '–' + Math.max(...vsJs).toFixed(2) + '×)');
    console.log('  SIMD vs WASM scalar : avg ' + avg(vsSc).toFixed(2) + '×'
              + '  (range ' + Math.min(...vsSc).toFixed(2) + '–' + Math.max(...vsSc).toFixed(2) + '×)');
    console.log('');
}

main().catch(err => {
    console.error('Bench failed:', err);
    console.error(err.stack);
    process.exit(1);
});
