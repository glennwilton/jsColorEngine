// ============================================================================
// tetra4d_simd_run.js — WASM SIMD vs WASM scalar vs JS bench for 4D tetra
// ============================================================================
//
// Three-way comparison on the full 6-config 4D matrix:
//
//   grid-point counts : 9, 17, 33           (g1^4 LUTs; 65^4 is 68 MB and
//                                             outside the working-set interest
//                                             region, dropped as in the
//                                             scalar bench)
//   output channels   : 3, 4
//   kernels:
//     JS_4D_intLut     = Transform.js _{3,4}Ch_intLut_loop (production int path)
//     WASM_4D_scalar   = bench/wasm_poc/tetra4d_nch.wat   (rolled n-channel +
//                                                           flag-gated K-loop)
//     WASM_4D_simd     = bench/wasm_poc/tetra4d_simd.wat  (channel-parallel +
//                                                           K0 u20 in v128 reg)
//
// Bit-exactness is checked for all three kernels against one another on
// every config. If the scalar-WASM output doesn't match JS int, or the
// SIMD-WASM doesn't match JS int (and therefore transitively the scalar),
// we bail out before touching the timing loop.
//
// Memory layouts are kernel-specific:
//
//   Scalar (from tetra4d_nch_run.js):
//     [ input | output | scratch (64B) | lut ]
//
//   SIMD:
//     [ input | output (+4B tail slack) | lut ]
//
//   SIMD keeps the K0 u20 in a v128 local, so it needs no scratch region.
//   It does need +4 bytes of output slack: v128.store32_lane writes 4 bytes
//   per pixel regardless of cMax, and for cMax=3 the last pixel's store
//   runs past the nominal output end by 1 byte. Match the tetra3d_simd
//   convention and pad by 4 to be safe across all cMax values.
//
// Both WASM kernels share the same 17-arg call signature — SIMD ignores
// scratchPtr. That lets the shipping wasm_loader.js reuse one Tetra4DState
// wrapper for both kernels; see createTetra4DSimdState.
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
// (Cloned verbatim from tetra4d_nch_run.js so the three kernels see the same
// numerical stress as the scalar bench.)

function buildSynthetic4DIntLut(g1, outputChannels) {
    const go0 = outputChannels;
    const go1 = g1 * outputChannels;
    const go2 = g1 * g1 * outputChannels;
    const go3 = g1 * g1 * g1 * outputChannels;

    const CLUT = new Uint16Array(g1 * g1 * g1 * g1 * outputChannels);
    const SCALE = 65280;

    const gamma = 0.85;
    for (let k = 0; k < g1; k++) {
        for (let x = 0; x < g1; x++) {
            for (let y = 0; y < g1; y++) {
                for (let z = 0; z < g1; z++) {
                    const kf = k / (g1 - 1);
                    const cf = x / (g1 - 1);
                    const mf = y / (g1 - 1);
                    const yf = z / (g1 - 1);
                    const idx = ((k * g1 + x) * g1 + y) * g1 + z;
                    const base = idx * outputChannels;
                    const kScale = 1 - kf * 0.5;
                    const o0 = Math.pow(Math.max(0, Math.min(1, (1 - cf) * kScale + 0.05 * (mf + yf) * (1 - kf) * 0.5)), gamma);
                    const o1 = Math.pow(Math.max(0, Math.min(1, (1 - mf) * kScale + 0.05 * (cf + yf) * (1 - kf) * 0.5)), gamma);
                    const o2 = Math.pow(Math.max(0, Math.min(1, (1 - yf) * kScale + 0.05 * (cf + mf) * (1 - kf) * 0.5)), gamma);
                    CLUT[base + 0] = (o0 * SCALE) | 0;
                    CLUT[base + 1] = (o1 * SCALE) | 0;
                    CLUT[base + 2] = (o2 * SCALE) | 0;
                    if (outputChannels >= 4) {
                        const o3 = Math.pow(Math.max(0, Math.min(1, kf * 0.8 + 0.1 * Math.min(cf, mf, yf))), gamma);
                        CLUT[base + 3] = (o3 * SCALE) | 0;
                    }
                }
            }
        }
    }

    return {
        version: 1,
        dataType: 'u16',
        scale: 65280,
        gpsPrecisionBits: 16,
        accWidth: 32,
        CLUT,
        maxX: (g1 - 1) * go2,
        maxY: (g1 - 1) * go1,
        maxZ: (g1 - 1) * go0,
        maxK: (g1 - 1) * go3,
        gridPointsScale_fixed: ((g1 - 1) * 256 / 255) | 0,
        inputChannels: 4,
        outputChannels: outputChannels,
        g1: g1,
        go0: go0,
        go1: go1,
        go2: go2,
        go3: go3,
    };
}

function buildInput(n) {
    const buf = new Uint8Array(n * 4);
    let idx = 0;

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

function reportBitExactFailure(label, input, jsOut, wasmOut, cMax) {
    const d = diff(jsOut, wasmOut);
    if (d.max === 0) return false;
    const px = (d.firstDiffIdx / cMax) | 0;
    const inP = px * 4;
    console.log('  ' + label + ' : BIT-EXACT FAILURE — pixel ' + px
              + ' ch ' + (d.firstDiffIdx % cMax)
              + '  JS=' + d.firstDiffA + '  WASM=' + d.firstDiffB);
    console.log('                  input K,C,M,Y = ('
              + input[inP] + ',' + input[inP+1] + ','
              + input[inP+2] + ',' + input[inP+3] + ')');
    console.log('                  total diffs: ' + (d.total - d.exact) + '/' + d.total
              + '  (' + d.off1 + ' off-by-1, max=' + d.max + ')');
    return true;
}

// ---- main -------------------------------------------------------------------

async function main() {
    console.log('==================================================================');
    console.log('  WASM SIMD vs WASM scalar vs JS — 4D tetrahedral int, full matrix');
    console.log('==================================================================');
    console.log('Node                :', process.version);
    console.log('Pixels / pass       :', PIXEL_COUNT.toLocaleString());
    console.log('Warmup iters        :', WARMUP_ITERS);
    console.log('Timed batches       :', TIMED_BATCHES, '×', BATCH_ITERS, 'iters');
    console.log('Total timed pixels  :', (PIXEL_COUNT * BATCH_ITERS * TIMED_BATCHES).toLocaleString(), '/ config');
    console.log('');

    const wabt = await wabtFactory();
    const scalarBytes = await compileWasm(wabt, path.join(__dirname, 'tetra4d_nch.wat'));
    const simdBytes   = await compileWasm(wabt, path.join(__dirname, 'tetra4d_simd.wat'));
    console.log('WASM 4D scalar      :', bytesToString(scalarBytes.length));
    console.log('WASM 4D SIMD        :', bytesToString(simdBytes.length));
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
        const inputBytes  = PIXEL_COUNT * 4;
        const outputBytes = PIXEL_COUNT * cMax;
        const scratchBytes = Math.max(64, cMax * 4);
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

        // =====================================================================
        //                    WASM 4D SCALAR — bit-exact + speed
        // =====================================================================
        const scalarMod = (await WebAssembly.instantiate(scalarBytes, {})).instance.exports;
        const sInputPtr   = 0;
        const sOutputPtr  = inputBytes;
        let   sScratchPtr = sOutputPtr + outputBytes;
        if (sScratchPtr & 3) sScratchPtr = (sScratchPtr + 3) & ~3;
        let   sLutPtr     = sScratchPtr + scratchBytes;
        if (sLutPtr & 1) sLutPtr += 1;
        const sTotalBytes = sLutPtr + lutBytes;
        {
            const pages = Math.ceil(sTotalBytes / 65536);
            const have = scalarMod.memory.buffer.byteLength / 65536;
            if (have < pages) scalarMod.memory.grow(pages - have);
        }
        {
            const memU8 = new Uint8Array(scalarMod.memory.buffer);
            const memU16 = new Uint16Array(scalarMod.memory.buffer);
            memU8.set(input, sInputPtr);
            memU16.set(intLut.CLUT, sLutPtr >> 1);
        }
        scalarMod.interp_tetra4d_nCh(
            sInputPtr, sOutputPtr, sLutPtr,
            PIXEL_COUNT, cMax,
            intLut.go0, intLut.go1, intLut.go2, intLut.go3,
            intLut.gridPointsScale_fixed,
            intLut.maxX, intLut.maxY, intLut.maxZ, intLut.maxK,
            sScratchPtr,
            0, 0
        );
        const scalarOut = new Uint8Array(scalarMod.memory.buffer, sOutputPtr, outputBytes).slice();
        if (reportBitExactFailure('scalar', input, jsOutput, scalarOut, cMax)) process.exit(1);
        console.log('  scalar        : bit-exact ✓');

        // =====================================================================
        //                    WASM 4D SIMD — bit-exact + speed
        // =====================================================================
        // Memory layout: [input | output (+4B tail slack) | lut]. SIMD
        // needs no scratch region — the K0 u20 lives in a v128 local
        // across the K-plane loop iteration.
        const simdMod = (await WebAssembly.instantiate(simdBytes, {})).instance.exports;
        const outputTail = 4;
        const iInputPtr  = 0;
        const iOutputPtr = inputBytes;
        let   iLutPtr    = iOutputPtr + outputBytes + outputTail;
        if (iLutPtr & 1) iLutPtr += 1;
        const iTotalBytes = iLutPtr + lutBytes;
        {
            const pages = Math.ceil(iTotalBytes / 65536);
            const have = simdMod.memory.buffer.byteLength / 65536;
            if (have < pages) simdMod.memory.grow(pages - have);
        }
        {
            const memU8 = new Uint8Array(simdMod.memory.buffer);
            const memU16 = new Uint16Array(simdMod.memory.buffer);
            memU8.set(input, iInputPtr);
            memU16.set(intLut.CLUT, iLutPtr >> 1);
        }
        simdMod.interp_tetra4d_simd(
            iInputPtr, iOutputPtr, iLutPtr,
            PIXEL_COUNT, cMax,
            intLut.go0, intLut.go1, intLut.go2, intLut.go3,
            intLut.gridPointsScale_fixed,
            intLut.maxX, intLut.maxY, intLut.maxZ, intLut.maxK,
            0,                      // scratchPtr ignored
            0, 0                    // inAlphaSkip, outAlphaMode — no alpha
        );
        const simdOut = new Uint8Array(simdMod.memory.buffer, iOutputPtr, outputBytes).slice();
        if (reportBitExactFailure('SIMD', input, jsOutput, simdOut, cMax)) process.exit(1);
        console.log('  SIMD          : bit-exact ✓');

        // --- Speed benchmark (all three kernels) ----------------------
        const jsBuf = new Uint8ClampedArray(outputBytes);
        const jsResult = timeIters(() => {
            transform[jsFnName](input, 0, jsBuf, 0, PIXEL_COUNT, intLut, false, false, false);
        });
        const scalarResult = timeIters(() => {
            scalarMod.interp_tetra4d_nCh(
                sInputPtr, sOutputPtr, sLutPtr,
                PIXEL_COUNT, cMax,
                intLut.go0, intLut.go1, intLut.go2, intLut.go3,
                intLut.gridPointsScale_fixed,
                intLut.maxX, intLut.maxY, intLut.maxZ, intLut.maxK,
                sScratchPtr, 0, 0
            );
        });
        const simdResult = timeIters(() => {
            simdMod.interp_tetra4d_simd(
                iInputPtr, iOutputPtr, iLutPtr,
                PIXEL_COUNT, cMax,
                intLut.go0, intLut.go1, intLut.go2, intLut.go3,
                intLut.gridPointsScale_fixed,
                intLut.maxX, intLut.maxY, intLut.maxZ, intLut.maxK,
                0, 0, 0
            );
        });

        console.log('  Speed:');
        console.log('    JS ' + jsFnName.padEnd(44) + jsResult.mpps.toFixed(1).padStart(7) + ' MPx/s   1.00×');
        const scalarRatio = (scalarResult.mpps / jsResult.mpps).toFixed(2);
        const simdRatio   = (simdResult.mpps / jsResult.mpps).toFixed(2);
        const simdVsScalar = (simdResult.mpps / scalarResult.mpps).toFixed(2);
        console.log('    WASM 4D scalar'.padEnd(49) + scalarResult.mpps.toFixed(1).padStart(7) + ' MPx/s   ' + scalarRatio + '× vs JS');
        console.log('    WASM 4D SIMD'.padEnd(49)   + simdResult.mpps.toFixed(1).padStart(7)   + ' MPx/s   ' + simdRatio   + '× vs JS  (' + simdVsScalar + '× vs scalar)');
        console.log('');

        allResults.push({
            cfg, lutKB,
            js:     jsResult.mpps,
            scalar: scalarResult.mpps,
            simd:   simdResult.mpps,
        });
    }

    // --- Summary ---------------------------------------------------------
    console.log('==================================================================');
    console.log('  Summary');
    console.log('==================================================================');
    console.log('');
    console.log('  g1  cMax  CLUT         JS     scalar  scalar/JS    SIMD  SIMD/JS  SIMD/scalar');
    console.log('  --  ----  --------   -----   ------   --------   -----   ------   -----------');
    for (const r of allResults) {
        const jsStr     = r.js.toFixed(1).padStart(5);
        const scalarStr = r.scalar.toFixed(1).padStart(6);
        const simdStr   = r.simd.toFixed(1).padStart(5);
        const sjRatio   = (r.scalar / r.js).toFixed(2) + '×';
        const ijRatio   = (r.simd / r.js).toFixed(2) + '×';
        const isRatio   = (r.simd / r.scalar).toFixed(2) + '×';
        const lutStr    = (r.lutKB + ' KB').padStart(8);
        console.log('  ' + String(r.cfg.g1).padStart(2)
                  + '  ' + String(r.cfg.cMax).padStart(4)
                  + '   ' + lutStr
                  + '   ' + jsStr
                  + '   ' + scalarStr
                  + '      ' + sjRatio.padStart(5)
                  + '   ' + simdStr
                  + '    ' + ijRatio.padStart(5)
                  + '       ' + isRatio.padStart(5));
    }
    console.log('');

    // --- Verdict ---------------------------------------------------------
    console.log('------------------------------------------------------------------');
    console.log('  Verdict');
    console.log('------------------------------------------------------------------');
    const simdVsJs     = allResults.map(r => r.simd   / r.js);
    const simdVsScalar = allResults.map(r => r.simd   / r.scalar);
    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const min = arr => Math.min(...arr);
    const max = arr => Math.max(...arr);
    console.log('  WASM 4D SIMD vs JS     : avg ' + avg(simdVsJs).toFixed(2)
              + '× (min ' + min(simdVsJs).toFixed(2) + '×, max ' + max(simdVsJs).toFixed(2) + '×)');
    console.log('  WASM 4D SIMD vs scalar : avg ' + avg(simdVsScalar).toFixed(2)
              + '× (min ' + min(simdVsScalar).toFixed(2) + '×, max ' + max(simdVsScalar).toFixed(2) + '×)');
    if (avg(simdVsJs) >= 2.0) {
        console.log('    → Ship. 4D SIMD hits the §1b projection of ~2-2.7× vs JS int.');
    } else if (avg(simdVsJs) >= 1.5) {
        console.log('    → Solid win, below projection. Worth shipping; profile for headroom.');
    } else {
        console.log('    → Below expectation — revisit design before shipping.');
    }
    console.log('');
}

main().catch(err => {
    console.error('Bench failed:', err);
    console.error(err.stack);
    process.exit(1);
});
