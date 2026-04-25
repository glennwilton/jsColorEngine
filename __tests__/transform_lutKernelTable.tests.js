/**
 * v1.3 LUT kernel dispatcher table — coverage + equivalence tests.
 *
 * The kernel table (src/lutKernelTable.js) is the single source of truth
 * for "what kernel runs for (lutMode, inputChannels, outputChannels)?".
 * Resolution happens once at the end of Transform.create() and caches
 * BIG/SMALL run closures + a threshold on the Transform itself. Per-call
 * dispatch is then one threshold compare + one indirect call.
 *
 * Coverage:
 *
 *  1. Table integrity
 *      1a. KERNEL is exhaustive: every LUT_MODE_SHORT × inCh{3,4} ×
 *          outBucket{3,4,n} cell has an entry.
 *      1b. Every entry has the {run, gate, minPx, fallback} shape.
 *      1c. Every non-null fallback key resolves to another KERNEL entry.
 *      1d. Every chain terminates at an fl_*_* entry with fallback:null.
 *      1e. No cycles (depth ≤ 16 from any starting key).
 *
 *  2. Resolver behaviour
 *      2a. Float entries always win (gate=alwaysOk, minPx=0) regardless
 *          of WASM state.
 *      2b. WASM-eligible entries are skipped at pixelCountFloor=0,
 *          chosen at pixelCountFloor=Infinity (when state is loaded).
 *      2c. Sparse passthrough (run:null, gate:alwaysFalse) advances to
 *          fallback transparently.
 *
 *  3. Transform integration
 *      3a. _resolveLutKernels() runs at end of create(), populates
 *          _lutKernelBig / _lutKernelSmall / _lutKernelThreshold.
 *      3b. inputChannels ∈ {1, 2} leaves the cache null (gray/duotone
 *          aren't table-dispatched).
 *      3c. _lutKernelThreshold is 0 when BIG and SMALL collapse to the
 *          same entry (no WASM win possible).
 *
 *  4. Bit-exact equivalence: v1.3 table dispatcher vs pre-v1.3 legacy cascade
 *      For each (mode × inCh × outCh) combo with available host support,
 *      transformArrayViaLUT() (v1.3 table) and transformArrayViaLUT_legacy()
 *      (pre-v1.3 cascade, kept for one release) must produce byte-identical
 *      outputs over a deterministic 256k-pixel input. Below-threshold
 *      (small batch) is also covered for the WASM modes to exercise the
 *      _lutKernelSmall path. These tests gate the legacy removal — the
 *      day they go red, fix src/lutKernelTable.js (NOT by reverting the
 *      swap).
 *
 * Skip strategy mirrors the WASM test suites: WASM tests gate on
 * (typeof WebAssembly !== 'undefined' && !process.env.SKIP_WASM_TESTS).
 */

'use strict';

const path = require('path');
const { Transform, eIntent } = require('../src/main');
const Profile = require('../src/Profile');
const lutKernelTable = require('../src/lutKernelTable');

const cmykFilename = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

const HAS_WASM = typeof WebAssembly !== 'undefined' && !process.env.SKIP_WASM_TESTS;

// ---- helpers ----------------------------------------------------------------

function maxAbsDiff(a, b){
    if(a.length !== b.length){
        throw new Error('length mismatch ' + a.length + ' vs ' + b.length);
    }
    let max = 0, firstDiffIdx = -1;
    for(let i = 0; i < a.length; i++){
        const d = Math.abs(a[i] - b[i]);
        if(d > max){ max = d; firstDiffIdx = i; }
    }
    return { max, firstDiffIdx, A: firstDiffIdx >= 0 ? a[firstDiffIdx] : 0, B: firstDiffIdx >= 0 ? b[firstDiffIdx] : 0 };
}

// Deterministic RGB u8 / u16 input (LCG → no flaky test from Math.random).
function buildInputU8(nPixels, channels, seed){
    const buf = new Uint8ClampedArray(nPixels * channels);
    let s = seed >>> 0;
    for(let i = 0; i < buf.length; i++){
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = s & 0xff;
    }
    return buf;
}
function buildInputU16(nPixels, channels, seed){
    const buf = new Uint16Array(nPixels * channels);
    let s = seed >>> 0;
    for(let i = 0; i < buf.length; i++){
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = s & 0xffff;
    }
    return buf;
}

// Mock Transform-like object with selectable WASM states.
function mockTransform(opts){
    return {
        outputChannels:        opts.outputChannels || 3,
        wasmTetra3D:           opts.wasmTetra3D           || null,
        wasmTetra3DSimd:       opts.wasmTetra3DSimd       || null,
        wasmTetra3DInt16:      opts.wasmTetra3DInt16      || null,
        wasmTetra3DInt16Simd:  opts.wasmTetra3DInt16Simd  || null,
        wasmTetra4D:           opts.wasmTetra4D           || null,
        wasmTetra4DSimd:       opts.wasmTetra4DSimd       || null,
        wasmTetra4DInt16:      opts.wasmTetra4DInt16      || null,
        wasmTetra4DInt16Simd:  opts.wasmTetra4DInt16Simd  || null,
    };
}

// ============================================================================
// 1. TABLE INTEGRITY
// ============================================================================

describe('lutKernelTable — table integrity', () => {

    test('1a. KERNEL is exhaustive: every (mode, inCh, outBucket) cell has an entry', () => {
        const modes  = Object.values(lutKernelTable.LUT_MODE_SHORT);
        const inChs  = [3, 4];
        const outBuckets = [3, 4, 'n'];

        const missing = [];
        for(const mode of modes){
            for(const inCh of inChs){
                for(const outB of outBuckets){
                    const key = mode + '_' + inCh + '_' + outB;
                    if(lutKernelTable.KERNEL[key] === undefined){
                        missing.push(key);
                    }
                }
            }
        }
        expect(missing).toEqual([]);
    });

    test('1b. every entry has {run, gate, minPx, fallback}', () => {
        for(const [key, entry] of Object.entries(lutKernelTable.KERNEL)){
            expect(entry).toHaveProperty('run');
            expect(entry).toHaveProperty('gate');
            expect(entry).toHaveProperty('minPx');
            expect(entry).toHaveProperty('fallback');
            expect(typeof entry.gate).toBe('function');
            expect(typeof entry.minPx).toBe('number');
            // run is either a function (real kernel) or null (passthrough)
            expect(entry.run === null || typeof entry.run === 'function')
                .toBe(true, 'entry "' + key + '" run must be function or null');
            // fallback is either a string (key) or null (chain end)
            expect(entry.fallback === null || typeof entry.fallback === 'string')
                .toBe(true, 'entry "' + key + '" fallback must be string or null');
        }
    });

    test('1c. every non-null fallback key resolves to another KERNEL entry', () => {
        const dangling = [];
        for(const [key, entry] of Object.entries(lutKernelTable.KERNEL)){
            if(entry.fallback !== null && lutKernelTable.KERNEL[entry.fallback] === undefined){
                dangling.push(key + ' → ' + entry.fallback);
            }
        }
        expect(dangling).toEqual([]);
    });

    test('1d. every chain terminates at the right bit-depth — u8 → fl_*_*, u16 → i16_*_*', () => {
        // Bit-depth invariant (see src/lutKernelTable.js header):
        //   u16 chains MUST NOT cross to u8 kernels (would silently
        //   scale outputs by ~1/257 into a Uint16Array). u16 chains
        //   therefore terminate at the JS u16 entry; u8 chains
        //   degrade all the way to the float entry.
        for(const startKey of Object.keys(lutKernelTable.KERNEL)){
            const isU16Chain = startKey.startsWith('i16');
            let key = startKey, last = startKey, depth = 0;
            while(key !== null){
                if(depth++ > 16){
                    throw new Error('chain from "' + startKey + '" exceeded depth 16');
                }
                last = key;
                // Cross-bit-depth assertion at every hop.
                if(isU16Chain){
                    expect(key.startsWith('i16') || key === 'fl_NEVER_HAPPENS')
                        .toBe(true, 'u16 chain "' + startKey + '" leaked into u8 kernel "' + key + '"');
                }
                key = lutKernelTable.KERNEL[key].fallback;
            }
            // Terminus check
            if(isU16Chain){
                expect(last.startsWith('i16_')).toBe(true);
            } else {
                expect(last.startsWith('fl_')).toBe(true);
                expect(lutKernelTable.KERNEL[last].run).not.toBeNull(); // float terminus is always real
            }
            expect(lutKernelTable.KERNEL[last].fallback).toBeNull();
        }
    });

    test('1f. bit-depth invariant: u16 misuse (no intLut) throws "fallback chain exhausted"', () => {
        // lutMode='int16' without buildIntLut() → gate fails → no u8
        // cross-over to silently corrupt → loud throw at resolve time.
        const t = mockTransform({});
        const lutNoInt = { intLut: null, inputChannels: 3, outputChannels: 3 };
        expect(() => lutKernelTable.resolveLutKernel(t, lutNoInt, 'i16_3_3', Infinity))
            .toThrow(/fallback chain exhausted/);

        // lutMode='int16' with cMax=6 (NCh has no u16 JS kernel) on a
        // host without WASM → also throws (instead of silently writing
        // u8 values into a Uint16Array as the legacy dispatcher did).
        expect(() => lutKernelTable.resolveLutKernel(t, lutNoInt, 'i16_3_n', Infinity))
            .toThrow(/fallback chain exhausted/);
    });

    test('1e. no cycles in any fallback chain', () => {
        for(const startKey of Object.keys(lutKernelTable.KERNEL)){
            const visited = new Set();
            let key = startKey;
            while(key !== null){
                if(visited.has(key)){
                    throw new Error('cycle detected in chain from "' + startKey + '" at "' + key + '"');
                }
                visited.add(key);
                key = lutKernelTable.KERNEL[key].fallback;
            }
        }
    });
});

// ============================================================================
// 2. RESOLVER BEHAVIOUR (mocked Transform — no real WASM needed)
// ============================================================================

describe('lutKernelTable.resolveLutKernel', () => {

    const fakeIntLut = { /* truthy stand-in — only presence is checked by gates */ };
    const fakeLut = { intLut: fakeIntLut, inputChannels: 3, outputChannels: 3 };

    test('2a. fl_3_3 always wins regardless of WASM state', () => {
        const t = mockTransform({});
        const big   = lutKernelTable.resolveLutKernel(t, fakeLut, 'fl_3_3', Infinity);
        const small = lutKernelTable.resolveLutKernel(t, fakeLut, 'fl_3_3', 0);
        expect(big.key).toBe('fl_3_3');
        expect(small.key).toBe('fl_3_3');
        expect(big.entry).toBe(small.entry);
    });

    test('2b. without intLut, integer chains degrade all the way to fl_*_*', () => {
        const t = mockTransform({});
        const lutNoInt = { intLut: null, inputChannels: 3, outputChannels: 4 };
        const big = lutKernelTable.resolveLutKernel(t, lutNoInt, 'i_3_4', Infinity);
        expect(big.key).toBe('fl_3_4');
    });

    test('2c. WASM available: BIG floor=Infinity wins WASM, SMALL floor=0 falls through to JS', () => {
        // v1.3 — WASM int16 gate is wired (Q0.13 kernels, bit-exact
        // with JS sibling). BIG batches route to the WASM kernel; SMALL
        // batches still fall through to the JS u16 kernel because the
        // i16ws entry has minPx > 0.
        const t = mockTransform({ wasmTetra3DInt16: { /* fake state */ } });
        const big   = lutKernelTable.resolveLutKernel(t, fakeLut, 'i16ws_3_3', Infinity);
        const small = lutKernelTable.resolveLutKernel(t, fakeLut, 'i16ws_3_3', 0);
        expect(big.key).toBe('i16ws_3_3');                    // WASM wins for big batches
        expect(small.key).toBe('i16_3_3');                    // JS u16 wins for small batches
        expect(big.entry).not.toBe(small.entry);
    });

    test('2c. WASM unavailable: BIG and SMALL both collapse to JS fallback', () => {
        const t = mockTransform({});                          // no WASM states
        const big   = lutKernelTable.resolveLutKernel(t, fakeLut, 'i16ws_3_3', Infinity);
        const small = lutKernelTable.resolveLutKernel(t, fakeLut, 'i16ws_3_3', 0);
        expect(big.key).toBe('i16_3_3');
        expect(small.key).toBe('i16_3_3');
        expect(big.entry).toBe(small.entry);
    });

    test('2d. SIMD on cMax=n falls through transparently to scalar WASM', () => {
        const t = mockTransform({
            outputChannels:  6,
            wasmTetra3DSimd: { /* fake */ },
            wasmTetra3D:     { /* fake */ },
        });
        const lut6 = { intLut: fakeIntLut, inputChannels: 3, outputChannels: 6 };
        const big = lutKernelTable.resolveLutKernel(t, lut6, 'i8wsi_3_n', Infinity);
        // i8wsi_3_n has gate:alwaysFalse → falls to i8ws_3_n which has scalar WASM
        expect(big.key).toBe('i8ws_3_n');
    });

    test('2e. i16wsi (SIMD u16) wins when SIMD state is loaded; falls to i16ws when not', () => {
        // v1.3 SIMD u16 kernels live behind a gate on
        // wasmTetra3DInt16Simd. With the SIMD state loaded, BIG batches
        // route to i16wsi; without it, the chain walks transparently
        // to the scalar u16 sibling i16ws_3_3 (which itself walks to
        // i16_3_3 if the scalar u16 state is also missing).
        const tSimd = mockTransform({
            wasmTetra3DInt16Simd: { /* fake */ },
            wasmTetra3DInt16:     { /* fake */ },
        });
        const bigSimd = lutKernelTable.resolveLutKernel(tSimd, fakeLut, 'i16wsi_3_3', Infinity);
        expect(bigSimd.key).toBe('i16wsi_3_3');

        const tScalar = mockTransform({ wasmTetra3DInt16: { /* fake */ } });
        const bigScalar = lutKernelTable.resolveLutKernel(tScalar, fakeLut, 'i16wsi_3_3', Infinity);
        expect(bigScalar.key).toBe('i16ws_3_3');
    });

    test('2f. SIMD u16 on cMax=n (e.g. 6-color CMYKOG) falls through transparently to scalar u16', () => {
        // Same gating rationale as the u8 SIMD _n cell: v128.store64_lane
        // writes 4 u16 lanes / 8 bytes / pixel which is invalid for
        // cMax ∉ {3, 4}. The _n cell is gate:alwaysFalse → walks to
        // i16ws_*_n which uses the rolled scalar u16 kernel.
        const t = mockTransform({
            outputChannels:       6,
            wasmTetra3DInt16Simd: { /* fake */ },
            wasmTetra3DInt16:     { /* fake */ },
        });
        const lut6 = { intLut: fakeIntLut, inputChannels: 3, outputChannels: 6 };
        const big = lutKernelTable.resolveLutKernel(t, lut6, 'i16wsi_3_n', Infinity);
        expect(big.key).toBe('i16ws_3_n');
    });
});

// ============================================================================
// 3. TRANSFORM INTEGRATION
// ============================================================================

describe('Transform — _resolveLutKernels integration', () => {

    test('3a. _resolveLutKernels runs at create() and populates the cache (RGB→RGB float)', () => {
        const t = new Transform({ buildLut: true, lutMode: 'float' });
        t.create('*srgb', '*adobergb', eIntent.relative);

        expect(t._lutKernelBig).not.toBeNull();
        expect(t._lutKernelSmall).not.toBeNull();
        expect(t._lutKernelBigKey).toBe('fl_3_3');           // float mode → fl entry
        expect(t._lutKernelSmallKey).toBe('fl_3_3');
        expect(t._lutKernelThreshold).toBe(0);               // collapsed → no per-call branch
    });

    test('3a. RGB→RGB int populates with integer cache', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int' });
        t.create('*srgb', '*adobergb', eIntent.relative);
        expect(t._lutKernelBigKey).toBe('i_3_3');
        expect(t._lutKernelSmallKey).toBe('i_3_3');
        expect(t._lutKernelThreshold).toBe(0);
    });

    test('3b. inputChannels ∈ {1, 2} (gray / duotone) leaves cache null', () => {
        // No virtual gray profile in createVirtualProfile() — fake the
        // post-create() shape directly. The bypass we're testing is in
        // _resolveLutKernels() and only inspects this.lut.{inputChannels,
        // outputChannels} + this.lutMode, so a minimal stub is enough.
        const t = new Transform({ buildLut: true, lutMode: 'float' });
        t.lut = { inputChannels: 1, outputChannels: 3, intLut: null };
        t._resolveLutKernels();
        expect(t._lutKernelBig).toBeNull();
        expect(t._lutKernelSmall).toBeNull();
        expect(t._lutKernelBigKey).toBeNull();

        t.lut = { inputChannels: 2, outputChannels: 3, intLut: null };
        t._resolveLutKernels();
        expect(t._lutKernelBig).toBeNull();
        expect(t._lutKernelSmall).toBeNull();
    });

    if(HAS_WASM){
        test('3c. WASM mode → threshold > 0 (BIG and SMALL diverge)', () => {
            const t = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar' });
            t.create('*srgb', '*adobergb', eIntent.relative);
            expect(t.lutMode).toBe('int-wasm-scalar');       // not demoted
            expect(t.wasmTetra3D).not.toBeNull();
            expect(t._lutKernelBigKey).toBe('i8ws_3_3');
            expect(t._lutKernelSmallKey).toBe('i_3_3');
            expect(t._lutKernelThreshold).toBe(Transform.WASM_DISPATCH_MIN_PIXELS);
        });
    }
});

// ============================================================================
// 4. BIT-EXACT EQUIVALENCE — legacy vs v2 across the matrix
// ============================================================================
//
// Pixel count is chosen above WASM_DISPATCH_MIN_PIXELS so the BIG path
// is exercised. A separate small-batch test below the threshold catches
// the SMALL path.
// ============================================================================

const N_BIG = 1 << 18;     // 256k pixels — well above WASM threshold (256)
const N_SMALL = 8;          // small batch → forces _lutKernelSmall

// (mode, srcSpec, dstSpec, channels, label)
// srcSpec/dstSpec: '*srgb' / '*adobergb' / 'cmyk' (loaded async below)
const MATRIX = [
    // float — universal baseline
    { mode: 'float', src: '*srgb',     dst: '*adobergb', dataFormat: 'object', label: 'fl RGB→RGB' },
    { mode: 'float', src: '*srgb',     dst: 'cmyk',      dataFormat: 'object', label: 'fl RGB→CMYK' },
    { mode: 'float', src: 'cmyk',      dst: '*srgb',     dataFormat: 'object', label: 'fl CMYK→RGB' },

    // u8 JS integer
    { mode: 'int',   src: '*srgb',     dst: '*adobergb', dataFormat: 'int8',   label: 'i RGB→RGB' },
    { mode: 'int',   src: '*srgb',     dst: 'cmyk',      dataFormat: 'int8',   label: 'i RGB→CMYK' },
    { mode: 'int',   src: 'cmyk',      dst: '*srgb',     dataFormat: 'int8',   label: 'i CMYK→RGB' },

    // u16 JS integer
    { mode: 'int16', src: '*srgb',     dst: '*adobergb', dataFormat: 'int16',  label: 'i16 RGB→RGB' },
    { mode: 'int16', src: '*srgb',     dst: 'cmyk',      dataFormat: 'int16',  label: 'i16 RGB→CMYK' },
    { mode: 'int16', src: 'cmyk',      dst: '*srgb',     dataFormat: 'int16',  label: 'i16 CMYK→RGB' },
];

const WASM_MATRIX = [
    // u8 WASM scalar
    { mode: 'int-wasm-scalar', src: '*srgb', dst: '*adobergb', dataFormat: 'int8', label: 'i8ws RGB→RGB' },
    { mode: 'int-wasm-scalar', src: '*srgb', dst: 'cmyk',      dataFormat: 'int8', label: 'i8ws RGB→CMYK' },
    { mode: 'int-wasm-scalar', src: 'cmyk',  dst: '*srgb',     dataFormat: 'int8', label: 'i8ws CMYK→RGB' },

    // u8 WASM SIMD
    { mode: 'int-wasm-simd',   src: '*srgb', dst: '*adobergb', dataFormat: 'int8', label: 'i8wsi RGB→RGB' },
    { mode: 'int-wasm-simd',   src: '*srgb', dst: 'cmyk',      dataFormat: 'int8', label: 'i8wsi RGB→CMYK' },
    { mode: 'int-wasm-simd',   src: 'cmyk',  dst: '*srgb',     dataFormat: 'int8', label: 'i8wsi CMYK→RGB' },

    // u16 WASM scalar — v1.3 SHIPPED. The Q0.13 WASM kernels are bit-exact
    // with the JS u16 sibling (mirror of `tetrahedralInterp{3,4}DArray_*Ch_intLut16_loop`),
    // so legacy and table dispatchers both end up at the same kernel via
    // either route.
    { mode: 'int16-wasm-scalar', src: '*srgb', dst: '*adobergb', dataFormat: 'int16', label: 'i16ws RGB→RGB' },
    { mode: 'int16-wasm-scalar', src: '*srgb', dst: 'cmyk',      dataFormat: 'int16', label: 'i16ws RGB→CMYK' },
    { mode: 'int16-wasm-scalar', src: 'cmyk',  dst: '*srgb',     dataFormat: 'int16', label: 'i16ws CMYK→RGB' },

    // u16 WASM SIMD — v1.3 SHIPPED. Bit-exact with the scalar u16 WASM
    // kernels (Q0.13). The legacy (v1.2-style cascade) dispatcher routes
    // through the SCALAR u16 WASM kernel for lutMode='int16-wasm-simd'
    // (it doesn't know about i16wsi); the table dispatcher routes through
    // the SIMD u16 WASM kernel. Both kernels are bit-exact siblings, so
    // the equivalence tests pass — that's the whole point of "SIMD
    // bit-exact with scalar".
    { mode: 'int16-wasm-simd', src: '*srgb', dst: '*adobergb', dataFormat: 'int16', label: 'i16wsi RGB→RGB' },
    { mode: 'int16-wasm-simd', src: '*srgb', dst: 'cmyk',      dataFormat: 'int16', label: 'i16wsi RGB→CMYK' },
    { mode: 'int16-wasm-simd', src: 'cmyk',  dst: '*srgb',     dataFormat: 'int16', label: 'i16wsi CMYK→RGB' },
];

describe('Transform — bit-exact: transformArrayViaLUT (v1.3 table) vs transformArrayViaLUT_legacy (pre-v1.3 cascade)', () => {

    let cmykProfile;

    beforeAll(async () => {
        cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);
    });

    function resolveSpec(spec){
        return spec === 'cmyk' ? cmykProfile : spec;
    }

    function inputForRow(row, nPixels){
        const inCh = row.src === 'cmyk' ? 4 : 3;
        switch(row.dataFormat){
            case 'int16':  return buildInputU16(nPixels, inCh, 0xC0FFEE ^ row.label.length);
            case 'int8':
            case 'object': return buildInputU8(nPixels, inCh, 0xDEADBEEF ^ row.label.length);
        }
    }

    // ---- non-WASM matrix --------------------------------------------------
    test.each(MATRIX)('$label — bit-exact (BIG batch ${N_BIG}px)', async (row) => {
        const t = new Transform({ dataFormat: row.dataFormat, buildLut: true, lutMode: row.mode });
        t.create(resolveSpec(row.src), resolveSpec(row.dst), eIntent.relative);

        const input = inputForRow(row, N_BIG);
        const oLegacy = t.transformArrayViaLUT_legacy(input, false, false, false);
        const oTable  = t.transformArrayViaLUT(input, false, false, false);

        expect(oLegacy.constructor).toBe(oTable.constructor);
        expect(oLegacy.length).toBe(oTable.length);

        const d = maxAbsDiff(oLegacy, oTable);
        if(d.max !== 0){
            const outCh = t.lut.outputChannels;
            const px = (d.firstDiffIdx / outCh) | 0;
            throw new Error(row.label + ': table dispatcher diverged from legacy at pixel ' + px +
                ' ch ' + (d.firstDiffIdx % outCh) + ' (legacy=' + d.A + ' table=' + d.B + ')');
        }
        expect(d.max).toBe(0);
    });

    if(HAS_WASM){
        test.each(WASM_MATRIX)('$label — bit-exact (BIG batch — WASM eligible)', async (row) => {
            const t = new Transform({ dataFormat: row.dataFormat, buildLut: true, lutMode: row.mode });
            t.create(resolveSpec(row.src), resolveSpec(row.dst), eIntent.relative);

            expect(t.lutMode).toBe(row.mode);

            const input = inputForRow(row, N_BIG);
            const oLegacy = t.transformArrayViaLUT_legacy(input, false, false, false);
            const oTable  = t.transformArrayViaLUT(input, false, false, false);

            expect(oLegacy.constructor).toBe(oTable.constructor);
            expect(oLegacy.length).toBe(oTable.length);

            const d = maxAbsDiff(oLegacy, oTable);
            if(d.max !== 0){
                const outCh = t.lut.outputChannels;
                const px = (d.firstDiffIdx / outCh) | 0;
                throw new Error(row.label + ': table dispatcher diverged from legacy at pixel ' + px +
                    ' ch ' + (d.firstDiffIdx % outCh) + ' (legacy=' + d.A + ' table=' + d.B + ')');
            }
            expect(d.max).toBe(0);
        });

        test.each(WASM_MATRIX)('$label — bit-exact (SMALL batch below WASM threshold)', async (row) => {
            const t = new Transform({ dataFormat: row.dataFormat, buildLut: true, lutMode: row.mode });
            t.create(resolveSpec(row.src), resolveSpec(row.dst), eIntent.relative);

            const input = inputForRow(row, N_SMALL);
            const oLegacy = t.transformArrayViaLUT_legacy(input, false, false, false);
            const oTable  = t.transformArrayViaLUT(input, false, false, false);

            const d = maxAbsDiff(oLegacy, oTable);
            expect(d.max).toBe(0);
        });
    }
});
