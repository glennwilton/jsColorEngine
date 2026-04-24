// ============================================================================
// tetra3d_run.js — WASM vs JS bench for 3D tetrahedral, int path
// ============================================================================
//
// Matrix:
//
//   grid-point counts : 17, 33, 65        (L1d-friendly → L2 pressure)
//   output channels   : 3, 4              (RGB→RGB / RGB→CMYK)
//   kernels           :
//     JS_nCh_intLut       = Transform.js _3Ch_intLut_loop (when cMax=3)
//                         + Transform.js _4Ch_intLut_loop (when cMax=4)
//                         = production int path, fully unrolled
//     WASM_nCh_rolled     = src/wasm/tetra3d_nch.wat
//                         = single n-channel kernel, channel loop rolled
//                           (shipping kernel; lives in src/wasm/ as of v1.2)
//     WASM_3Ch_preload    = bench/wasm_poc/tetra3d_3ch_preload.wat
//                         = specialised cMax=3, c0/c1/c2 preloaded,
//                           channel loop unrolled (only meaningful when
//                           cMax=3; skipped otherwise)
//
// Thresholds (per user):
//   < 10% win → parity, V8 at ceiling
//   10-50%    → small win, viable with caveats
//   50%+      → green light for v1.2 WASM port
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

// ---- LUT construction -------------------------------------------------------

function buildSyntheticIntLut(g1, outputChannels) {
    const go0 = outputChannels;
    const go1 = g1 * outputChannels;
    const go2 = g1 * g1 * outputChannels;

    const CLUT = new Uint16Array(g1 * g1 * g1 * outputChannels);
    const SCALE = 65280;

    // Twisted RGB→{3 or 4}Ch mapping.
    // - Out-ch 0-2: 90% identity + 5% cross-bleed each axis
    // - Out-ch 3 (CMYK-K simulation): min(fx, fy, fz) * 0.5 — gives a
    //   non-trivial 4th channel that actually varies across the LUT.
    //
    // Gamma 0.85 per output to make the LUT non-linear (linear LUTs
    // collapse the tetrahedral math to one case; we want all 6 hit).
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
        gridPointsScale_fixed: Math.round(((g1 - 1) << 16) / 255),
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

function buildInput(n) {
    const buf = new Uint8Array(n * 3);
    let idx = 0;
    const corners = [
        [0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255],
        [255, 255, 0], [255, 0, 255], [0, 255, 255], [255, 255, 255],
    ];
    for (const [r, g, b] of corners) {
        buf[idx++] = r; buf[idx++] = g; buf[idx++] = b;
    }
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

function diff(a, b) {
    if (a.length !== b.length) throw new Error('length mismatch: ' + a.length + ' vs ' + b.length);
    let max = 0, exact = 0, off1 = 0;
    let firstDiffIdx = -1, firstDiffA = 0, firstDiffB = 0;
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d === 0) exact++;
        else if (d === 1) off1++;
        if (d > max) {
            max = d;
            firstDiffIdx = i;
            firstDiffA = a[i];
            firstDiffB = b[i];
        }
    }
    return { max, exact, off1, total: a.length, firstDiffIdx, firstDiffA, firstDiffB };
}

function pct(a, b) {
    if (b === 0) return '0.0%';
    return ((a / b) * 100).toFixed(1) + '%';
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

// ---- WASM compile once ------------------------------------------------------

async function compileWasm(wabt, absPath) {
    const wat = fs.readFileSync(absPath, 'utf8');
    const name = path.basename(absPath);
    const mod = wabt.parseWat(name, wat, { multi_value: true, mutable_globals: true });
    const { buffer } = mod.toBinary({});
    mod.destroy();
    return buffer;
}

// ---- main -------------------------------------------------------------------

async function main() {
    console.log('==================================================================');
    console.log('  WASM vs JS — 3D tetrahedral int, full matrix');
    console.log('==================================================================');
    console.log('Node                :', process.version);
    console.log('Pixels / pass       :', PIXEL_COUNT.toLocaleString());
    console.log('Warmup iters        :', WARMUP_ITERS);
    console.log('Timed batches       :', TIMED_BATCHES, '×', BATCH_ITERS, 'iters');
    console.log('Total timed pixels  :', (PIXEL_COUNT * BATCH_ITERS * TIMED_BATCHES).toLocaleString(), '/ config');
    console.log('');

    // --- Compile both WASM modules once ------------------------------------
    const wabt = await wabtFactory();
    const wasmBytesNCh = await compileWasm(wabt, path.join(__dirname, '..', '..', 'src', 'wasm', 'tetra3d_nch.wat'));
    const wasmBytes3Ch = await compileWasm(wabt, path.join(__dirname, 'tetra3d_3ch_preload.wat'));
    console.log('WASM nCh rolled     :', bytesToString(wasmBytesNCh.length));
    console.log('WASM 3Ch preload    :', bytesToString(wasmBytes3Ch.length));
    console.log('');

    const transform = new Transform({});
    const input = buildInput(PIXEL_COUNT);

    // --- Config matrix -----------------------------------------------------
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
        const lutBytes    = intLut.CLUT.byteLength;

        const lutKB = (lutBytes / 1024).toFixed(1);
        const l1Pct = ((lutBytes / 32768) * 100).toFixed(0);
        console.log('  CLUT          : ' + lutKB + ' KB  (' + l1Pct + '% of 32 KB L1d)');

        // --- JS reference ---------------------------------------------
        const jsOutput = new Uint8ClampedArray(outputBytes);
        const jsFnName = (cMax === 3)
            ? 'tetrahedralInterp3DArray_3Ch_intLut_loop'
            : 'tetrahedralInterp3DArray_4Ch_intLut_loop';
        transform[jsFnName](input, 0, jsOutput, 0, PIXEL_COUNT, intLut, false, false, false);

        // --- WASM nCh rolled ------------------------------------------
        const nChMod = (await WebAssembly.instantiate(wasmBytesNCh, {})).instance.exports;

        // Memory layout: [input | output | lut]
        const inputPtr  = 0;
        const outputPtr = inputBytes;
        const lutPtr    = inputBytes + outputBytes;
        const totalBytes = lutPtr + lutBytes;
        const pagesNeeded = Math.ceil(totalBytes / 65536);
        {
            const have = nChMod.memory.buffer.byteLength / 65536;
            if (have < pagesNeeded) nChMod.memory.grow(pagesNeeded - have);
        }
        {
            const memU8 = new Uint8Array(nChMod.memory.buffer);
            const memU16 = new Uint16Array(nChMod.memory.buffer);
            memU8.set(input, inputPtr);
            memU16.set(intLut.CLUT, lutPtr >> 1);
        }

        nChMod.interp_tetra3d_nCh(
            inputPtr, outputPtr, lutPtr,
            PIXEL_COUNT, cMax,
            intLut.go0, intLut.go1, intLut.go2,
            intLut.gridPointsScale_fixed,
            intLut.maxX, intLut.maxY, intLut.maxZ,
            0, 0 // inAlphaSkip, outAlphaMode — no alpha for bench
        );
        const nChOut = new Uint8Array(nChMod.memory.buffer, outputPtr, outputBytes).slice();

        const dNCh = diff(jsOutput, nChOut);
        if (dNCh.max > 0) {
            const px = (dNCh.firstDiffIdx / cMax) | 0;
            console.log('  nCh rolled    : BIT-EXACT FAILURE — pixel ' + px
                      + ' ch ' + (dNCh.firstDiffIdx % cMax)
                      + '  JS=' + dNCh.firstDiffA + '  WASM=' + dNCh.firstDiffB);
            console.log('                  input=(' + input[px*3] + ',' + input[px*3+1] + ',' + input[px*3+2] + ')');
            process.exit(1);
        }
        console.log('  nCh rolled    : bit-exact ✓');

        // --- WASM 3Ch preload (cMax=3 only) --------------------------
        let threeChMod = null;
        let threeChOut = null;
        if (cMax === 3) {
            threeChMod = (await WebAssembly.instantiate(wasmBytes3Ch, {})).instance.exports;
            {
                const have = threeChMod.memory.buffer.byteLength / 65536;
                if (have < pagesNeeded) threeChMod.memory.grow(pagesNeeded - have);
            }
            {
                const memU8 = new Uint8Array(threeChMod.memory.buffer);
                const memU16 = new Uint16Array(threeChMod.memory.buffer);
                memU8.set(input, inputPtr);
                memU16.set(intLut.CLUT, lutPtr >> 1);
            }
            threeChMod.interp_tetra3d_3Ch(
                inputPtr, outputPtr, lutPtr,
                PIXEL_COUNT,
                intLut.go0, intLut.go1, intLut.go2,
                intLut.gridPointsScale_fixed,
                intLut.maxX, intLut.maxY, intLut.maxZ
            );
            threeChOut = new Uint8Array(threeChMod.memory.buffer, outputPtr, outputBytes).slice();
            const d3Ch = diff(jsOutput, threeChOut);
            if (d3Ch.max > 0) {
                const px = (d3Ch.firstDiffIdx / cMax) | 0;
                console.log('  3Ch preload   : BIT-EXACT FAILURE — pixel ' + px
                          + ' ch ' + (d3Ch.firstDiffIdx % cMax)
                          + '  JS=' + d3Ch.firstDiffA + '  WASM=' + d3Ch.firstDiffB);
                process.exit(1);
            }
            console.log('  3Ch preload   : bit-exact ✓');
        }

        // --- Speed benchmark ------------------------------------------
        const jsBuf = new Uint8ClampedArray(outputBytes);
        const jsResult = timeIters(() => {
            transform[jsFnName](input, 0, jsBuf, 0, PIXEL_COUNT, intLut, false, false, false);
        });
        const nChResult = timeIters(() => {
            nChMod.interp_tetra3d_nCh(
                inputPtr, outputPtr, lutPtr,
                PIXEL_COUNT, cMax,
                intLut.go0, intLut.go1, intLut.go2,
                intLut.gridPointsScale_fixed,
                intLut.maxX, intLut.maxY, intLut.maxZ,
                0, 0 // inAlphaSkip, outAlphaMode — no alpha for bench
            );
        });
        let threeChResult = null;
        if (cMax === 3) {
            threeChResult = timeIters(() => {
                threeChMod.interp_tetra3d_3Ch(
                    inputPtr, outputPtr, lutPtr,
                    PIXEL_COUNT,
                    intLut.go0, intLut.go1, intLut.go2,
                    intLut.gridPointsScale_fixed,
                    intLut.maxX, intLut.maxY, intLut.maxZ
                );
            });
        }

        console.log('  Speed:');
        console.log('    JS ' + jsFnName.padEnd(42) + jsResult.mpps.toFixed(1).padStart(7) + ' MPx/s   1.00×');
        const nChRatio = (nChResult.mpps / jsResult.mpps).toFixed(2);
        console.log('    WASM nCh rolled'.padEnd(48) + nChResult.mpps.toFixed(1).padStart(7) + ' MPx/s   ' + nChRatio + '×');
        if (threeChResult) {
            const ratio3Ch = (threeChResult.mpps / jsResult.mpps).toFixed(2);
            console.log('    WASM 3Ch preload'.padEnd(48) + threeChResult.mpps.toFixed(1).padStart(7) + ' MPx/s   ' + ratio3Ch + '×');
        }
        console.log('');

        allResults.push({
            cfg: cfg,
            lutKB: lutKB,
            js: jsResult.mpps,
            nCh: nChResult.mpps,
            threeCh: threeChResult ? threeChResult.mpps : null,
        });
    }

    // --- Summary table ---------------------------------------------------
    console.log('==================================================================');
    console.log('  Summary');
    console.log('==================================================================');
    console.log('');
    console.log('  g1  cMax  CLUT KB   JS MPx/s   nCh MPx/s  nCh vs JS   3Ch MPx/s  3Ch vs JS');
    console.log('  --  ----  -------   --------   ---------  ---------   ---------  ---------');
    for (const r of allResults) {
        const jsStr = r.js.toFixed(1).padStart(8);
        const nChStr = r.nCh.toFixed(1).padStart(9);
        const nChRatio = (r.nCh / r.js).toFixed(2);
        const threeChStr = r.threeCh ? r.threeCh.toFixed(1).padStart(9) : '      -  ';
        const threeChRatio = r.threeCh ? (r.threeCh / r.js).toFixed(2) + '×' : '    -  ';
        console.log('  ' + String(r.cfg.g1).padStart(2) + '  ' + String(r.cfg.cMax).padStart(4)
                  + '   ' + r.lutKB.padStart(6) + '   ' + jsStr
                  + '   ' + nChStr + '      ' + nChRatio + '×    '
                  + threeChStr + '     ' + threeChRatio);
    }
    console.log('');

    // --- Verdict ---------------------------------------------------------
    console.log('------------------------------------------------------------------');
    console.log('  Verdict');
    console.log('------------------------------------------------------------------');

    // Average speedup across all configs for the n-channel kernel
    const nChSpeedups = allResults.map(r => r.nCh / r.js);
    const nChAvg = nChSpeedups.reduce((a, b) => a + b, 0) / nChSpeedups.length;
    const nChMin = Math.min(...nChSpeedups);
    const nChMax = Math.max(...nChSpeedups);
    console.log('  WASM nCh rolled   : avg ' + nChAvg.toFixed(2)
              + '× (min ' + nChMin.toFixed(2) + '×, max ' + nChMax.toFixed(2) + '×)');

    const threeChResults = allResults.filter(r => r.threeCh);
    if (threeChResults.length) {
        const speedups = threeChResults.map(r => r.threeCh / r.js);
        const avg = speedups.reduce((a, b) => a + b, 0) / speedups.length;
        const min = Math.min(...speedups);
        const max = Math.max(...speedups);
        console.log('  WASM 3Ch preload  : avg ' + avg.toFixed(2)
                  + '× (min ' + min.toFixed(2) + '×, max ' + max.toFixed(2) + '×)');

        // Preload vs rolled (only for cMax=3 configs)
        const preloadVsRolled = threeChResults.map(r => r.threeCh / r.nCh);
        const pvrAvg = preloadVsRolled.reduce((a, b) => a + b, 0) / preloadVsRolled.length;
        const pvrMin = Math.min(...preloadVsRolled);
        const pvrMax = Math.max(...preloadVsRolled);
        console.log('  3Ch preload / nCh : avg ' + pvrAvg.toFixed(2)
                  + '× (min ' + pvrMin.toFixed(2) + '×, max ' + pvrMax.toFixed(2) + '×)');
        if (pvrAvg > 1.05) {
            console.log('    → Preload win is real. Codegen specialised kernels for each cMax.');
        } else if (pvrAvg < 0.95) {
            console.log('    → Preload loses. Rolled nCh form is better; stick with one kernel.');
        } else {
            console.log('    → Preload is neutral. Rolled nCh form is simpler; no reason to specialise.');
        }
    }
    console.log('');
}

main().catch(err => {
    console.error('Bench failed:', err);
    console.error(err.stack);
    process.exit(1);
});
