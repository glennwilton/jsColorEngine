// ============================================================================
// tetra4d_nch_run.js — WASM vs JS bench for 4D tetrahedral, int path
// ============================================================================
//
// Matrix:
//
//   grid-point counts : 9, 17, 33           (4D LUTs grow as g1^4, so we
//                                             drop the 65-point config — a
//                                             65^4 LUT at cMax=4 is 68 MB,
//                                             way past working-set interest)
//   output channels   : 3, 4                (CMYK→RGB/Lab / CMYK→CMYK)
//   kernels:
//     JS_4D_intLut     = Transform.js _3Ch_intLut_loop (cMax=3)
//                       + Transform.js _4Ch_intLut_loop (cMax=4)
//                       = production int 4D path, fully unrolled
//     WASM_4D_rolled   = bench/wasm_poc/tetra4d_nch.wat
//                       = single n-channel kernel, channel loop rolled,
//                         flag-gated K-plane loop (body emitted once).
//
// Bit-exactness is the correctness bar — WASM output must match JS byte-for-byte.
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
const BATCH_ITERS   = 50;

// ---- LUT construction -------------------------------------------------------

function buildSynthetic4DIntLut(g1, outputChannels) {
    const go0 = outputChannels;
    const go1 = g1 * outputChannels;
    const go2 = g1 * g1 * outputChannels;
    const go3 = g1 * g1 * g1 * outputChannels;

    const CLUT = new Uint16Array(g1 * g1 * g1 * g1 * outputChannels);
    const SCALE = 65280;

    // 4D CMYK-like LUT:
    //   out 0 (R-ish) = (1 - C) * (1 - K * 0.5) + 0.05 * (M + Y) * (1-K)*0.5
    //   out 1 (G-ish) = (1 - M) * (1 - K * 0.5) + 0.05 * (C + Y) * (1-K)*0.5
    //   out 2 (B-ish) = (1 - Y) * (1 - K * 0.5) + 0.05 * (C + M) * (1-K)*0.5
    //   out 3 (K-ish) = K * 0.8 + 0.1 * min(C, M, Y)
    //
    // Gamma 0.85 on each output to make it non-linear (linear LUTs collapse
    // the tetra math to one case — we want all 6 tetra cases + interpK
    // variety hitting in the bench).
    const gamma = 0.85;
    for (let k = 0; k < g1; k++) {
        for (let x = 0; x < g1; x++) {
            for (let y = 0; y < g1; y++) {
                for (let z = 0; z < g1; z++) {
                    const fK = k / (g1 - 1);
                    const fC = x / (g1 - 1);
                    const fM = y / (g1 - 1);
                    const fY = z / (g1 - 1);
                    const kAttn = 1 - fK * 0.5;

                    const r = (1 - fC) * kAttn + 0.05 * (fM + fY) * (1 - fK) * 0.5;
                    const g = (1 - fM) * kAttn + 0.05 * (fC + fY) * (1 - fK) * 0.5;
                    const b = (1 - fY) * kAttn + 0.05 * (fC + fM) * (1 - fK) * 0.5;
                    const kk = fK * 0.8 + 0.1 * Math.min(fC, fM, fY);

                    const idx = k * go3 + x * go2 + y * go1 + z * go0;
                    CLUT[idx    ] = Math.min(SCALE, Math.max(0, Math.round(Math.pow(r,  gamma) * SCALE)));
                    CLUT[idx + 1] = Math.min(SCALE, Math.max(0, Math.round(Math.pow(g,  gamma) * SCALE)));
                    CLUT[idx + 2] = Math.min(SCALE, Math.max(0, Math.round(Math.pow(b,  gamma) * SCALE)));
                    if (outputChannels >= 4) {
                        CLUT[idx + 3] = Math.min(SCALE, Math.max(0, Math.round(Math.pow(kk, gamma) * SCALE)));
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
        gridPointsScale_fixed: Math.round(((g1 - 1) << 16) / 255),
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

// Input: 4 bytes per pixel = K, C, M, Y (K first, matching the JS kernel).
function buildInput(n) {
    const buf = new Uint8Array(n * 4);
    let idx = 0;

    // Hit the 16 tesseract corners (all K,C,M,Y ∈ {0,255}) for boundary patches.
    for (let kk = 0; kk <= 1; kk++) {
        for (let cc = 0; cc <= 1; cc++) {
            for (let mm = 0; mm <= 1; mm++) {
                for (let yy = 0; yy <= 1; yy++) {
                    buf[idx++] = kk * 255;
                    buf[idx++] = cc * 255;
                    buf[idx++] = mm * 255;
                    buf[idx++] = yy * 255;
                }
            }
        }
    }

    // Tetra-case stress pattern: run through all 6 orderings of (C,M,Y)
    // at 3 different K values (interpK-off at 0 grid-plane, interpK-on mid,
    // interpK-off at top boundary). 6 cases × 3 K = 18 pixels × 3 reps = 54.
    const tetraStress = [
        [200, 100,  50], [200,  50, 100], [100,  50, 200],
        [100, 200,  50], [ 50, 200, 100], [ 50, 100, 200],
    ];
    const kVals = [0, 128, 255];
    for (let rep = 0; rep < 3; rep++) {
        for (const kk of kVals) {
            for (const [c, m, y] of tetraStress) {
                buf[idx++] = kk; buf[idx++] = c; buf[idx++] = m; buf[idx++] = y;
            }
        }
    }

    // Pseudo-random fill for the rest — LCG, matches the 3D bench generator.
    let s = 1234567;
    while (idx < n * 4) {
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
    const mod = wabt.parseWat(name, wat, { multi_value: true, mutable_globals: true });
    const { buffer } = mod.toBinary({});
    mod.destroy();
    return buffer;
}

// ---- main -------------------------------------------------------------------

async function main() {
    console.log('==================================================================');
    console.log('  WASM vs JS — 4D tetrahedral int, scalar, full matrix');
    console.log('==================================================================');
    console.log('Node                :', process.version);
    console.log('Pixels / pass       :', PIXEL_COUNT.toLocaleString());
    console.log('Warmup iters        :', WARMUP_ITERS);
    console.log('Timed batches       :', TIMED_BATCHES, '×', BATCH_ITERS, 'iters');
    console.log('Total timed pixels  :', (PIXEL_COUNT * BATCH_ITERS * TIMED_BATCHES).toLocaleString(), '/ config');
    console.log('');

    const wabt = await wabtFactory();
    const wasmBytes = await compileWasm(wabt, path.join(__dirname, 'tetra4d_nch.wat'));
    console.log('WASM 4D nCh rolled  :', bytesToString(wasmBytes.length));
    console.log('');

    const transform = new Transform({});
    const input = buildInput(PIXEL_COUNT);

    const configs = [
        { g1:  9, cMax: 3 },
        { g1:  9, cMax: 4 },
        { g1: 17, cMax: 3 },
        { g1: 17, cMax: 4 },
        { g1: 33, cMax: 3 },
        { g1: 33, cMax: 4 },
    ];

    const allResults = [];

    for (const cfg of configs) {
        console.log('------------------------------------------------------------------');
        console.log('  Config: g1=' + cfg.g1 + '  cMax=' + cfg.cMax + '  (4D LUT: ' + cfg.g1 + '^4 × ' + cfg.cMax + ' × u16)');
        console.log('------------------------------------------------------------------');

        const intLut = buildSynthetic4DIntLut(cfg.g1, cfg.cMax);
        const cMax = cfg.cMax;
        const inputBytes  = PIXEL_COUNT * 4;                      // KCMY
        const outputBytes = PIXEL_COUNT * cMax;
        const scratchBytes = Math.max(64, cMax * 4);              // 64B floor keeps alignment simple
        const lutBytes    = intLut.CLUT.byteLength;

        const lutKB = (lutBytes / 1024).toFixed(1);
        const l1Pct = ((lutBytes / 32768) * 100).toFixed(0);
        const l2Pct = ((lutBytes / (256*1024)) * 100).toFixed(0);
        console.log('  CLUT          : ' + lutKB + ' KB  (' + l1Pct + '% of 32 KB L1d / ' + l2Pct + '% of 256 KB L2)');

        // --- JS reference ---------------------------------------------
        const jsOutput = new Uint8ClampedArray(outputBytes);
        const jsFnName = (cMax === 3)
            ? 'tetrahedralInterp4DArray_3Ch_intLut_loop'
            : 'tetrahedralInterp4DArray_4Ch_intLut_loop';
        transform[jsFnName](input, 0, jsOutput, 0, PIXEL_COUNT, intLut, false, false, false);

        // --- WASM 4D rolled -------------------------------------------
        const mod = (await WebAssembly.instantiate(wasmBytes, {})).instance.exports;

        // Memory layout: [input | output | scratch | lut].
        // Scratch is a 64-byte stable region the kernel uses to pass u20
        // values from the K0 pass to the K1 pass (per-pixel; overwritten
        // each iteration). Keep it 4-byte aligned (it holds i32 stores).
        // LUT must be 2-byte aligned for the u16 memU16.set() below.
        const inputPtr   = 0;
        const outputPtr  = inputBytes;
        let   scratchPtr = outputPtr + outputBytes;
        if (scratchPtr & 3) scratchPtr = (scratchPtr + 3) & ~3;
        let   lutPtr     = scratchPtr + scratchBytes;
        if (lutPtr & 1) lutPtr += 1;
        const totalBytes = lutPtr + lutBytes;
        const pagesNeeded = Math.ceil(totalBytes / 65536);
        {
            const have = mod.memory.buffer.byteLength / 65536;
            if (have < pagesNeeded) mod.memory.grow(pagesNeeded - have);
        }
        {
            const memU8 = new Uint8Array(mod.memory.buffer);
            const memU16 = new Uint16Array(mod.memory.buffer);
            memU8.set(input, inputPtr);
            memU16.set(intLut.CLUT, lutPtr >> 1);
        }

        mod.interp_tetra4d_nCh(
            inputPtr, outputPtr, lutPtr,
            PIXEL_COUNT, cMax,
            intLut.go0, intLut.go1, intLut.go2, intLut.go3,
            intLut.gridPointsScale_fixed,
            intLut.maxX, intLut.maxY, intLut.maxZ, intLut.maxK,
            scratchPtr,
            0, 0 // inAlphaSkip, outAlphaMode — no alpha for bench
        );
        const wasmOut = new Uint8Array(mod.memory.buffer, outputPtr, outputBytes).slice();

        const d = diff(jsOutput, wasmOut);
        if (d.max > 0) {
            const px = (d.firstDiffIdx / cMax) | 0;
            const inP = px * 4;
            console.log('  nCh rolled    : BIT-EXACT FAILURE — pixel ' + px
                      + ' ch ' + (d.firstDiffIdx % cMax)
                      + '  JS=' + d.firstDiffA + '  WASM=' + d.firstDiffB);
            console.log('                  input K,C,M,Y = ('
                      + input[inP] + ',' + input[inP+1] + ','
                      + input[inP+2] + ',' + input[inP+3] + ')');
            console.log('                  total diffs: ' + (d.total - d.exact) + '/' + d.total
                      + '  (' + d.off1 + ' off-by-1, max=' + d.max + ')');
            process.exit(1);
        }
        console.log('  nCh rolled    : bit-exact ✓  (' + d.total.toLocaleString() + ' bytes)');

        // --- Speed benchmark ------------------------------------------
        const jsBuf = new Uint8ClampedArray(outputBytes);
        const jsResult = timeIters(() => {
            transform[jsFnName](input, 0, jsBuf, 0, PIXEL_COUNT, intLut, false, false, false);
        });
        const wasmResult = timeIters(() => {
            mod.interp_tetra4d_nCh(
                inputPtr, outputPtr, lutPtr,
                PIXEL_COUNT, cMax,
                intLut.go0, intLut.go1, intLut.go2, intLut.go3,
                intLut.gridPointsScale_fixed,
                intLut.maxX, intLut.maxY, intLut.maxZ, intLut.maxK,
                scratchPtr,
                0, 0
            );
        });

        console.log('  Speed:');
        console.log('    JS ' + jsFnName.padEnd(44) + jsResult.mpps.toFixed(1).padStart(7) + ' MPx/s   1.00×');
        const ratio = (wasmResult.mpps / jsResult.mpps).toFixed(2);
        console.log('    WASM 4D nCh rolled'.padEnd(49) + wasmResult.mpps.toFixed(1).padStart(7) + ' MPx/s   ' + ratio + '×');
        console.log('');

        allResults.push({ cfg, lutKB, js: jsResult.mpps, wasm: wasmResult.mpps });
    }

    // --- Summary ---------------------------------------------------------
    console.log('==================================================================');
    console.log('  Summary');
    console.log('==================================================================');
    console.log('');
    console.log('  g1  cMax  CLUT       JS MPx/s   WASM MPx/s   WASM vs JS');
    console.log('  --  ----  --------   --------   ----------   ----------');
    for (const r of allResults) {
        const jsStr    = r.js.toFixed(1).padStart(8);
        const wasmStr  = r.wasm.toFixed(1).padStart(10);
        const ratioStr = (r.wasm / r.js).toFixed(2) + '×';
        const lutStr   = (r.lutKB + ' KB').padStart(8);
        console.log('  ' + String(r.cfg.g1).padStart(2)
                  + '  ' + String(r.cfg.cMax).padStart(4)
                  + '   ' + lutStr
                  + '   ' + jsStr
                  + '   ' + wasmStr
                  + '      ' + ratioStr);
    }
    console.log('');

    // --- Verdict ---------------------------------------------------------
    console.log('------------------------------------------------------------------');
    console.log('  Verdict');
    console.log('------------------------------------------------------------------');
    const speedups = allResults.map(r => r.wasm / r.js);
    const avg = speedups.reduce((a, b) => a + b, 0) / speedups.length;
    const min = Math.min(...speedups);
    const max = Math.max(...speedups);
    console.log('  WASM 4D nCh rolled : avg ' + avg.toFixed(2)
              + '× (min ' + min.toFixed(2) + '×, max ' + max.toFixed(2) + '×)');
    if (avg >= 1.3) {
        console.log('    → Green light: WASM 4D scalar meets/exceeds the 3D scalar speedup ratio.');
    } else if (avg >= 1.1) {
        console.log('    → Small win. V8 is harder to beat on 4D than 3D — still worth shipping.');
    } else {
        console.log('    → Parity/loss. V8 at ceiling for 4D int; revisit design.');
    }
    console.log('');
}

main().catch(err => {
    console.error('Bench failed:', err);
    console.error(err.stack);
    process.exit(1);
});
