// ----------------------------------------------------------------------------
// run.js — WASM proof-of-concept bench harness
// ----------------------------------------------------------------------------
//
// What this proves (or disproves):
//
//   1. Can WASM scalar match or beat JS for a real color-math kernel?
//      Compares JS vs WASM scalar 1D LERP through a 33-entry u16 LUT.
//      Same math as the v1.1 lutMode: 'int' path, one axis at a time.
//
//   2. How much does WASM SIMD help when LUTs are involved?
//      WASM SIMD has no native gather, so every LUT lookup has to be
//      done lane-by-lane. This bench measures the actual cost.
//
//   3. What's the SIMD ceiling without LUTs?
//      A pure SIMD multiply-shift kernel ("vectorMul") shows what WASM
//      SIMD can do when the algorithm fits — i.e. no scatter/gather.
//      This is the reference for "what we'd get if we could solve the
//      gather problem".
//
// Run:    node bench/wasm_poc/run.js
//
// Requires:
//   - Node 16+ (for WASM SIMD support; verified on Node 20)
//   - dev dependency: wabt (compiles .wat to .wasm at startup)
//
// ----------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const wabtFactory = require('wabt');

// ---- bench parameters -------------------------------------------------------

const PIXEL_COUNT = 1 << 20;        // 1 Mi pixels per pass
const WARMUP_ITERS = 50;             // discard
const TIMED_BATCHES = 5;             // batches of...
const BATCH_ITERS = 100;             // ...iters; report median batch ms

// ---- helpers ----------------------------------------------------------------

function pct(a, b) {
    if (b === 0) return 0;
    return ((a / b) * 100).toFixed(1) + '%';
}

function bytesToString(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

// Build a representative 33-entry u16 LUT — sRGB-ish gamma 2.2 curve.
// In the production engine these come from ICC profile decode.
//
// IMPORTANT: we cap the LUT at 65280 (= 255 * 256), not 65535. This is
// the same trick production color management uses: it guarantees that
// the final round-and-shift `(u16 + 0x80) >> 8` cannot overflow past
// 255, so neither the JS reference nor the WASM kernels need a u8
// clamp in the inner loop. The 65535 vs 65280 difference is < 0.4%
// of the u16 range — invisible in any output that gets converted
// back to 8 bits anyway. Without this cap, JS (Uint8ClampedArray)
// clamps silently while WASM (i32.store8) truncates to 0, which is
// a real footgun if you copy this kernel into production unchanged.
function buildGammaLut() {
    const lut = new Uint16Array(33);
    for (let i = 0; i < 33; i++) {
        const x = i / 32;
        lut[i] = Math.round(Math.pow(x, 1 / 2.2) * 65280);
    }
    return lut;
}

// Build a representative input — gradient + a few exact-boundary pixels.
function buildInput(n) {
    const buf = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) buf[i] = i & 0xFF;
    // sprinkle in some exact-255 pixels to exercise the boundary patch
    for (let i = 0; i < n; i += 1024) buf[i] = 255;
    return buf;
}

// Pure JS reference — same math as the WASM scalar kernel.
// Written to mirror the .wat as closely as possible so the comparison
// is honest. No micro-optimisations either way.
function applyCurve_js(input, output, lut) {
    const n = input.length;
    for (let i = 0; i < n; i++) {
        const val = input[i];
        if (val === 255) {
            output[i] = (lut[32] + 0x80) >> 8;
        } else {
            const fp = val << 5;
            const idx = fp >> 8;
            const w = fp & 0xFF;
            const lo = lut[idx];
            const hi = lut[idx + 1];
            const u16 = lo + (((hi - lo) * w + 0x80) >> 8);
            output[i] = (u16 + 0x80) >> 8;
        }
    }
}

// More heavily optimised JS variant — equivalent to what V8 might
// produce after warming up the simple version. Tracks whether
// idiomatic JS in fact converges to the same speed.
function applyCurve_js_imul(input, output, lut) {
    const n = input.length;
    const lutBoundary = (lut[32] + 0x80) >> 8;
    for (let i = 0; i < n; i++) {
        const val = input[i];
        if (val === 255) {
            output[i] = lutBoundary;
            continue;
        }
        const fp = val << 5;
        const idx = fp >> 8;
        const w = fp & 0xFF;
        const lo = lut[idx];
        const hi = lut[idx + 1];
        const u16 = lo + (((Math.imul(hi - lo, w) + 0x80) >> 8) | 0);
        output[i] = (u16 + 0x80) >> 8;
    }
}

// ---- timing -----------------------------------------------------------------

function timeIters(name, fn) {
    // warmup — gives V8 / WASM tier-up time to settle
    for (let i = 0; i < WARMUP_ITERS; i++) fn();

    // measure batches; report median to ignore single-batch jitter
    const batchMs = [];
    for (let b = 0; b < TIMED_BATCHES; b++) {
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < BATCH_ITERS; i++) fn();
        const t1 = process.hrtime.bigint();
        batchMs.push(Number(t1 - t0) / 1e6);
    }
    batchMs.sort((a, b) => a - b);
    const medianMs = batchMs[Math.floor(TIMED_BATCHES / 2)];

    const totalPx = PIXEL_COUNT * BATCH_ITERS;
    const mpps = (totalPx / (medianMs / 1000)) / 1e6;
    return { name, medianMs, mpps };
}

function diff(a, b) {
    if (a.length !== b.length) throw new Error('length mismatch');
    let max = 0, exact = 0, off1 = 0;
    for (let i = 0; i < a.length; i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d === 0) exact++;
        else if (d === 1) off1++;
        if (d > max) max = d;
    }
    return { max, exact, off1, total: a.length };
}

// ---- main -------------------------------------------------------------------

async function main() {
    console.log('===========================================================');
    console.log('  WASM Proof-of-Concept — 1D LERP through u16 LUT');
    console.log('===========================================================');
    console.log('Pixels per pass     :', PIXEL_COUNT.toLocaleString());
    console.log('Warmup iters        :', WARMUP_ITERS);
    console.log('Batches             :', TIMED_BATCHES);
    console.log('Iters per batch     :', BATCH_ITERS);
    console.log('Total timed pixels  :', (PIXEL_COUNT * BATCH_ITERS * TIMED_BATCHES).toLocaleString());
    console.log('Node                :', process.version);
    console.log('');

    // ---- build .wat → .wasm ------------------------------------------------
    const wabt = await wabtFactory();
    const here = __dirname;

    function compile(file, name) {
        const wat = fs.readFileSync(path.join(here, file), 'utf8');
        const mod = wabt.parseWat(file, wat, {
            multi_value: true,
            simd: true,
            mutable_globals: true,
        });
        const { buffer } = mod.toBinary({});
        mod.destroy();
        console.log(`  ${name.padEnd(28)} ${file.padEnd(24)} ${bytesToString(buffer.length)}`);
        return buffer;
    }

    console.log('--- Compiling .wat → .wasm --------------------------------');
    const scalarBytes = compile('linear_lerp.wat', 'scalar');
    const simdBytes = compile('linear_lerp_simd.wat', 'SIMD');
    console.log('');

    // ---- instantiate -------------------------------------------------------
    const scalarMod = await WebAssembly.instantiate(scalarBytes, {});
    const simdMod = await WebAssembly.instantiate(simdBytes, {});
    const wasmScalar = scalarMod.instance.exports;
    const wasmSimd = simdMod.instance.exports;

    // ---- set up shared memory layouts -------------------------------------
    // Scalar memory: [input | output | lut]
    // We need 1 MiB + 1 MiB + 66 B = ~2.06 MB → 33 pages of 64KB each.
    // Grow both wasm memories before use.
    const pagesNeeded = Math.ceil((PIXEL_COUNT * 2 + 66) / 65536);

    function ensurePages(mem) {
        const have = mem.buffer.byteLength / 65536;
        if (have < pagesNeeded) mem.grow(pagesNeeded - have);
    }
    ensurePages(wasmScalar.memory);
    ensurePages(wasmSimd.memory);

    const inputOffset = 0;
    const outputOffset = PIXEL_COUNT;
    const lutOffset = PIXEL_COUNT * 2;

    // ---- prepare data ------------------------------------------------------
    const lut = buildGammaLut();
    const input = buildInput(PIXEL_COUNT);
    const jsOutput = new Uint8ClampedArray(PIXEL_COUNT);
    const jsImulOutput = new Uint8ClampedArray(PIXEL_COUNT);

    // Copy input + LUT into both WASM memories
    function load(mem) {
        const u8 = new Uint8Array(mem.buffer);
        u8.set(input, inputOffset);
        u8.set(new Uint8Array(lut.buffer, lut.byteOffset, lut.byteLength), lutOffset);
    }
    load(wasmScalar.memory);
    load(wasmSimd.memory);

    // Read output back from a wasm memory
    function readOut(mem) {
        return new Uint8ClampedArray(mem.buffer, outputOffset, PIXEL_COUNT).slice();
    }

    // ---- correctness check (run once, compare all 4) -----------------------
    console.log('--- Correctness ------------------------------------------');
    applyCurve_js(input, jsOutput, lut);
    applyCurve_js_imul(input, jsImulOutput, lut);
    wasmScalar.applyCurve_scalar(inputOffset, outputOffset, lutOffset, PIXEL_COUNT);
    const wasmScalarOut = readOut(wasmScalar.memory);
    wasmSimd.applyCurve_simd(inputOffset, outputOffset, lutOffset, PIXEL_COUNT);
    const wasmSimdOut = readOut(wasmSimd.memory);

    const dJsImul = diff(jsOutput, jsImulOutput);
    const dWasmS = diff(jsOutput, wasmScalarOut);
    const dWasmV = diff(jsOutput, wasmSimdOut);

    function reportDiff(label, d) {
        console.log(`  ${label.padEnd(28)} max=${d.max}  exact=${pct(d.exact, d.total)}  off-by-1=${pct(d.off1, d.total)}`);
    }
    reportDiff('JS imul vs JS plain', dJsImul);
    reportDiff('WASM scalar vs JS', dWasmS);
    reportDiff('WASM SIMD vs JS', dWasmV);

    if (dWasmS.max > 0 || dWasmV.max > 0 || dJsImul.max > 0) {
        console.log('');
        console.log('  WARNING: bit-exactness lost — kernels diverge.');
        console.log('  Investigate before trusting speed numbers.');
    } else {
        console.log('  All four kernels are bit-exact. Speed comparison is fair.');
    }
    console.log('');

    // ---- benchmark ---------------------------------------------------------
    console.log('--- Speed (median of 5 batches × 100 iters) --------------');

    const results = [];
    results.push(timeIters('JS plain', () => applyCurve_js(input, jsOutput, lut)));
    results.push(timeIters('JS Math.imul', () => applyCurve_js_imul(input, jsImulOutput, lut)));
    results.push(timeIters('WASM scalar', () => wasmScalar.applyCurve_scalar(inputOffset, outputOffset, lutOffset, PIXEL_COUNT)));
    results.push(timeIters('WASM SIMD (gather)', () => wasmSimd.applyCurve_simd(inputOffset, outputOffset, lutOffset, PIXEL_COUNT)));
    results.push(timeIters('WASM SIMD (no LUT)', () => wasmSimd.vectorMul_simd(inputOffset, outputOffset, 128, PIXEL_COUNT)));

    const baseline = results[0].mpps;
    console.log('');
    console.log('  Kernel                     Batch ms     MPx/s     vs JS plain');
    console.log('  -------------------------- ----------  --------  ------------');
    for (const r of results) {
        const speedup = (r.mpps / baseline).toFixed(2);
        console.log(
            `  ${r.name.padEnd(26)} ` +
            `${r.medianMs.toFixed(2).padStart(8)} ms  ` +
            `${r.mpps.toFixed(1).padStart(7)}    ` +
            `${speedup.padStart(5)}×`
        );
    }
    console.log('');

    // ---- conclusions -------------------------------------------------------
    const wasmScalarSpeedup = results[2].mpps / results[0].mpps;
    const simdGatherSpeedup = results[3].mpps / results[0].mpps;
    const simdNoLutSpeedup = results[4].mpps / results[0].mpps;

    console.log('--- Findings ---------------------------------------------');
    console.log('');
    console.log(`  WASM scalar vs JS plain             : ${wasmScalarSpeedup.toFixed(2)}×`);
    console.log(`  WASM SIMD (with LUT gather) vs JS   : ${simdGatherSpeedup.toFixed(2)}×`);
    console.log(`  WASM SIMD (no LUT, pure math) vs JS : ${simdNoLutSpeedup.toFixed(2)}×`);
    console.log('');

    if (wasmScalarSpeedup >= 1.3) {
        console.log('  → WASM scalar shows meaningful win. Worth pursuing for hot kernels.');
    } else if (wasmScalarSpeedup >= 1.05) {
        console.log('  → WASM scalar shows small win. Probably not worth the complexity');
        console.log('    for kernels that V8 already optimises well.');
    } else {
        console.log('  → WASM scalar is at parity with JS. V8 already found the same machine');
        console.log('    code. WASM only pays off via SIMD or threads from here.');
    }
    console.log('');

    if (simdNoLutSpeedup >= 3.0) {
        console.log(`  → SIMD ceiling is ${simdNoLutSpeedup.toFixed(1)}× when the algorithm fits (no gather).`);
        console.log('    For tight loops over fixed-stride byte arrays, WASM SIMD delivers.');
    }
    if (simdGatherSpeedup < 1.5 && simdNoLutSpeedup >= 2.0) {
        console.log('  → SIMD with lane-by-lane gather loses most of the win. The LUT lookup');
        console.log('    pattern (which dominates color management) does NOT vectorise well in');
        console.log('    pure WASM SIMD. To get the SIMD benefit for color math we would need:');
        console.log('      a) Restructure to avoid per-pixel LUT gather (e.g. tile + sort by index)');
        console.log('      b) Use the relaxed-SIMD i8x16 swizzle for small LUTs (≤16 entries)');
        console.log('      c) Accept the ceiling and lean on multi-threading instead');
    }
    console.log('');

    console.log('  Implications for jsColorEngine:');
    console.log('  - The 3D tetrahedral kernel does 8 LUT lookups per pixel — even more');
    console.log('    gather-bound than this 1D test. Expect SIMD speedup ≤ this gather number.');
    console.log('  - Web Workers (v1.3 plan) is the higher-leverage path: linear scaling with');
    console.log('    core count, no SIMD complexity, works in every modern browser.');
    console.log('  - WASM scalar may still be worth it for the *integer math* surrounding the');
    console.log('    gather (idx/weight calc, the LERP itself), but only inside a per-tile');
    console.log('    arrangement — not as a 1:1 port of the existing kernel.');
    console.log('');
}

main().catch(err => {
    console.error('Bench failed:', err);
    process.exit(1);
});
