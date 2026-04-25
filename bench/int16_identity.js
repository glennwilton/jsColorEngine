// ============================================================================
// int16_identity.js — v1.3 (Q0.13) identity gate for ALL FOUR u16 LUT kernels
// ============================================================================
//
// Builds an identity CLUT (input axis x → output axis x at every grid stop)
// at the v1.3 u16 contract — scale 65535 + Q0.13 gps + u13 weight extraction
// (v1.3 settled at Q0.13 over a brief internal Q0.12 iteration; Q0.13 halves
// the Q0.12 quantization noise while staying safely inside i32 — see
// Transform.buildIntLut header) — then sweeps every u16 input value on each
// input axis and asserts:
//
//   1.  worst per-axis |input - output| ≤ 1 LSB at u16 (precision floor)
//   2.  every grid-aligned input round-trips EXACTLY (zero error)
//
// Coverage matrix (one row per v1.3 JS u16 kernel):
//
//                       3-out            4-out
//   3D (XYZ in):        3D-3Ch ✓         3D-4Ch ✓
//   4D (KXYZ in):       4D-3Ch ✓         4D-4Ch ✓
//
// HISTORICAL CONTEXT (the unshipped u8-port prototype this gate prevents):
//   The first int16 prototype shared the u8 CLUT (scale 65280), used
//   the u8 fractional weight precision (Q0.8 → 8-bit rx), and bit-stretched
//   the [0, 65280] output to [0, 65535] at the end. Result: up to 17 LSB
//   identity error at g1=17, and a smooth u16 gradient like 12340..12349
//   collapsed to ONE output value (16:1 weight quantization within a cell).
//
// THE GATE: must PASS — fails loudly if anyone reverts the CLUT scale or
// weight precision or rounding. The buildIdentityIntLut helper here matches
// what Transform.buildIntLut produces when this.lutMode is u16. Keep the two
// in sync (see src/Transform.js buildIntLut for the truth).
//
// 4D KERNEL INPUT-CHANNEL ORDERING (from kernel source, NOT obvious):
//   The 4D kernels read input as [K, X, Y, Z] where K = input[0] is the
//   "outer" axis (stride go3) and Z = input[3] is the innermost (stride
//   go0). For the 4D-4Ch identity test we set CLUT cells to (K, X, Y, Z)
//   so that sweep-input[i] verifies output-channel[i]. For 4D-3Ch the K
//   axis has no matching output channel — we sweep K with the other
//   axes pinned to 0 and verify the output stays at the identity-zero
//   point (catches any K-axis interpolation drift).
//
// Run:    node bench/int16_identity.js
// ============================================================================

'use strict';

const Transform = require('../src/Transform.js');

// ---- identity intLut builder (matches buildIntLut for u16 modes) -----------
//
// Mirrors Transform.buildIntLut for lutMode in {int16, int16-wasm-scalar,
// int16-wasm-simd}: scale 65535, Q0.13 gps (v1.3). If the production
// builder contract changes, update this and bump the description above.

function buildIdentityIntLut(g1, inputChannels, outputChannels) {
    const SCALE = 65535;
    const supported4D = inputChannels === 4;

    // CLUT axis stride convention (see createLut() in Transform.js):
    //   go0 — innermost (Z for 3D, Z for 4D)
    //   go1 — Y axis
    //   go2 — X axis (3D top, or 'X' for 4D meaning input[1])
    //   go3 — K axis for 4D (outermost)
    const go0 = outputChannels;
    const go1 = g1 * outputChannels;
    const go2 = g1 * g1 * outputChannels;
    const go3 = supported4D ? g1 * g1 * g1 * outputChannels : 0;

    const totalGridPoints = supported4D
        ? g1 * g1 * g1 * g1
        : g1 * g1 * g1;
    const CLUT = new Uint16Array(totalGridPoints * outputChannels);

    // Per-cell write — encodes "identity" semantics. The matrix:
    //   3D-3Ch: output[0..2] = (X, Y, Z)
    //   3D-4Ch: output[0..2] = (X, Y, Z), output[3] = 0
    //           (4th channel is "uncoupled"; we don't sweep it)
    //   4D-4Ch: output[0..3] = (K, X, Y, Z) — round-trip every input axis
    //   4D-3Ch: output[0..2] = (X, Y, Z) — K axis dropped at output
    function writeCell(idxBase, K_norm, X_norm, Y_norm, Z_norm) {
        if (supported4D) {
            if (outputChannels === 4) {
                CLUT[idxBase + 0] = K_norm;
                CLUT[idxBase + 1] = X_norm;
                CLUT[idxBase + 2] = Y_norm;
                CLUT[idxBase + 3] = Z_norm;
            } else {
                CLUT[idxBase + 0] = X_norm;
                CLUT[idxBase + 1] = Y_norm;
                CLUT[idxBase + 2] = Z_norm;
            }
        } else {
            CLUT[idxBase + 0] = X_norm;
            CLUT[idxBase + 1] = Y_norm;
            CLUT[idxBase + 2] = Z_norm;
            if (outputChannels === 4) CLUT[idxBase + 3] = 0;
        }
    }

    const norm = i => Math.round((i / (g1 - 1)) * SCALE);

    if (supported4D) {
        for (let kg = 0; kg < g1; kg++) {
            for (let xg = 0; xg < g1; xg++) {
                for (let yg = 0; yg < g1; yg++) {
                    for (let zg = 0; zg < g1; zg++) {
                        const idx = kg * go3 + xg * go2 + yg * go1 + zg * go0;
                        writeCell(idx, norm(kg), norm(xg), norm(yg), norm(zg));
                    }
                }
            }
        }
    } else {
        for (let xg = 0; xg < g1; xg++) {
            for (let yg = 0; yg < g1; yg++) {
                for (let zg = 0; zg < g1; zg++) {
                    const idx = xg * go2 + yg * go1 + zg * go0;
                    writeCell(idx, 0, norm(xg), norm(yg), norm(zg));
                }
            }
        }
    }

    return {
        version: 1,
        dataType: 'u16',
        scale: SCALE,                                                 // v1.3: 65535
        gpsPrecisionBits: 13,                                         // v1.3: Q0.13 weight
        accWidth: 16,
        CLUT: CLUT,
        gridPointsScale_fixed:     0,                                 // u8 gps unused in u16 build
        gridPointsScale_fixed_u16: Math.round(((g1 - 1) << 13) / 65535),  // v1.3: Q0.13
        maxX: (g1 - 1) * go2,
        maxY: (g1 - 1) * go1,
        maxZ: (g1 - 1) * go0,
        maxK: supported4D ? (g1 - 1) * go3 : 0,
        inputChannels: inputChannels,
        outputChannels: outputChannels,
        g1: g1,
        go0: go0,
        go1: go1,
        go2: go2,
        go3: go3,
    };
}

// ---- per-axis sweep harness ------------------------------------------------

const N = 65536;     // sweep every u16 value
// One scratch Transform — kernels are methods but stateless beyond args.
const T = Object.create(Transform.prototype);

/**
 * Sweep one input axis from 0..65535 (other axes pinned to 0), invoke the
 * given kernel, and check `output[outChIdx] === input[inChIdx]` per pixel
 * (or `output[outChIdx] === 0` if outChIdx is null — used for the 4D-3Ch
 * K-axis "no output coupling" check).
 *
 * @param {string}  kernelName  — kernel method name on Transform.prototype
 * @param {object}  intLut      — built by buildIdentityIntLut
 * @param {number}  inChIdx     — which input channel to sweep (0..inputChannels-1)
 * @param {number?} outChIdx    — which output channel to compare (or null for "expect 0")
 * @param {string}  label       — human label for the report
 */
function sweepAxis(kernelName, intLut, inChIdx, outChIdx, label) {
    const inCh  = intLut.inputChannels;
    const outCh = intLut.outputChannels;
    const input  = new Uint16Array(N * inCh);   // zero-init, fill axis below
    const output = new Uint16Array(N * outCh);
    for (let i = 0; i < N; i++) input[i * inCh + inChIdx] = i;

    T[kernelName](input, 0, output, 0, N, intLut, false, false, false);

    // Per-pixel error histogram + grid-aligned check.
    const hist = new Map();
    let worst = 0;
    let worstAt = -1;
    let gridAlignedHits = 0;
    let gridPointsTested = 0;

    const cellWidth = 65535 / (intLut.g1 - 1);
    for (let i = 0; i < N; i++) {
        const got = output[i * outCh + (outChIdx === null ? 0 : outChIdx)];
        const expected = (outChIdx === null) ? 0 : i;
        const err = Math.abs(got - expected);

        hist.set(err, (hist.get(err) || 0) + 1);
        if (err > worst) { worst = err; worstAt = i; }

        const cellPos = i / cellWidth;
        if (Math.abs(cellPos - Math.round(cellPos)) < 1e-9) {
            gridPointsTested++;
            if (err === 0) gridAlignedHits++;
        }
    }

    // For null-coupling sweeps (4D-3Ch K), worst===0 is the only acceptable
    // outcome — there's no fractional weight on the output axis at all.
    const tolerance = (outChIdx === null) ? 0 : 1;
    const passed = (worst <= tolerance) && (gridAlignedHits === gridPointsTested);

    console.log('  ' + label.padEnd(36) +
        ' worst=' + String(worst).padStart(2) + ' LSB' +
        '  grid-exact=' + gridAlignedHits + '/' + gridPointsTested +
        '  ' + (passed ? 'PASS' : 'FAIL'));
    if (!passed) {
        const errs = Array.from(hist.keys()).sort((a, b) => a - b);
        console.log('      worst-at input=' + worstAt +
            '  err histogram: ' + errs.map(e => e + ':' + hist.get(e)).join(', '));
    }
    return { label, worst, gridAlignedHits, gridPointsTested, passed };
}

// ---- per-kernel test plans -------------------------------------------------

const PLANS = [
    {
        kernelName:    'tetrahedralInterp3DArray_3Ch_intLut16_loop',
        kernelLabel:   '3D-3Ch (XYZ → XYZ)',
        inputChannels: 3,
        outputChannels: 3,
        sweeps: [
            { inCh: 0, outCh: 0, label: 'X axis (in[0] → out[0])' },
            { inCh: 1, outCh: 1, label: 'Y axis (in[1] → out[1])' },
            { inCh: 2, outCh: 2, label: 'Z axis (in[2] → out[2])' },
        ],
    },
    {
        kernelName:    'tetrahedralInterp3DArray_4Ch_intLut16_loop',
        kernelLabel:   '3D-4Ch (XYZ → XYZ.)',
        inputChannels: 3,
        outputChannels: 4,
        sweeps: [
            { inCh: 0, outCh: 0, label: 'X axis (in[0] → out[0])' },
            { inCh: 1, outCh: 1, label: 'Y axis (in[1] → out[1])' },
            { inCh: 2, outCh: 2, label: 'Z axis (in[2] → out[2])' },
        ],
    },
    {
        kernelName:    'tetrahedralInterp4DArray_3Ch_intLut16_loop',
        kernelLabel:   '4D-3Ch (KXYZ → XYZ)',
        inputChannels: 4,
        outputChannels: 3,
        sweeps: [
            // K axis has no output coupling — verify zero phantom output
            // when sweeping K through a CLUT whose every K-plane is identical.
            { inCh: 0, outCh: null, label: 'K axis (in[0] → no output)' },
            { inCh: 1, outCh: 0, label: 'X axis (in[1] → out[0])' },
            { inCh: 2, outCh: 1, label: 'Y axis (in[2] → out[1])' },
            { inCh: 3, outCh: 2, label: 'Z axis (in[3] → out[2])' },
        ],
    },
    {
        kernelName:    'tetrahedralInterp4DArray_4Ch_intLut16_loop',
        kernelLabel:   '4D-4Ch (KXYZ → KXYZ)',
        inputChannels: 4,
        outputChannels: 4,
        sweeps: [
            { inCh: 0, outCh: 0, label: 'K axis (in[0] → out[0])' },
            { inCh: 1, outCh: 1, label: 'X axis (in[1] → out[1])' },
            { inCh: 2, outCh: 2, label: 'Y axis (in[2] → out[2])' },
            { inCh: 3, outCh: 3, label: 'Z axis (in[3] → out[3])' },
        ],
    },
];

// ---- run for each grid size -------------------------------------------------

const GRID_SIZES = [17, 33, 65];   // 17 = biggest cells (worst case),
                                    // 33 = typical, 65 = smallest cells

console.log('================================================================');
console.log(' v1.3 identity gate — all four JS u16 kernels (Q0.13 weights)');
console.log(' Pass: per-axis worst |in - out| <= 1 LSB AND all grid-aligned exact');
console.log('================================================================\n');

const summary = [];

for (const plan of PLANS) {
    console.log('============================================================');
    console.log(' ' + plan.kernelLabel + ' (' + plan.kernelName + ')');
    console.log('============================================================');

    let kernelPassed = true;
    for (const g1 of GRID_SIZES) {
        const intLut = buildIdentityIntLut(g1, plan.inputChannels, plan.outputChannels);
        const cellWidth = (65535 / (g1 - 1)).toFixed(2);
        console.log('  --- g1=' + g1 + ' (cell width=' + cellWidth + ' input units) ---');
        for (const sw of plan.sweeps) {
            const r = sweepAxis(plan.kernelName, intLut, sw.inCh, sw.outCh, sw.label);
            if (!r.passed) kernelPassed = false;
        }
    }
    summary.push({ kernel: plan.kernelLabel, passed: kernelPassed });
    console.log('');
}

console.log('================================================================');
console.log(' OVERALL SUMMARY');
console.log('================================================================');
for (const s of summary) {
    console.log('  ' + s.kernel.padEnd(28) + (s.passed ? 'PASS' : 'FAIL'));
}
const allPassed = summary.every(s => s.passed);
console.log('  -------------------------------------');
console.log('  ' + (allPassed ? 'ALL KERNELS PASS' : 'AT LEAST ONE KERNEL FAILED'));
process.exit(allPassed ? 0 : 1);
