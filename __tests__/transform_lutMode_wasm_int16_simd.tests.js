/**
 * lutMode='int16-wasm-simd' — WASM SIMD u16 tetrahedral dispatcher tests
 * (v1.3, Q0.13). Covers BOTH the 3D RGB-input and 4D CMYK-input SIMD u16 kernels.
 *
 * Mirrors transform_lutMode_wasm_simd.tests.js (u8 SIMD) for the u16 path
 * and transform_lutMode_wasm_int16.tests.js (u16 scalar) for the u16
 * specifics. Diffs vs both parents called out inline.
 *
 * Coverage matrix:
 *   1.  Option parsing — 'int16-wasm-simd' is accepted as a valid lutMode
 *   2.  create() populates wasmTetra3DInt16Simd + wasmTetra4DInt16Simd +
 *       scalar fallthroughs (no silent demotion)
 *   3.  RGB→RGB 3D 3Ch (u16): bit-exact against lutMode='int16'
 *       (JS u16 is the bit-exact reference, same as scalar u16 WASM)
 *   4.  RGB→CMYK 3D 4Ch (u16): bit-exact against JS u16 (real ICC GRACoL)
 *   5.  Below-threshold pixelCount falls back to JS u16 — counters flat
 *   6.  4D CMYK→RGB (u16): 4D SIMD WASM dispatched, bit-exact vs JS;
 *       3D SIMD counter stays flat (cross-contamination guardrail)
 *   7.  Three-way: int16-wasm-simd == int16-wasm-scalar == int16
 *       (the key "drop-in replacement" gate — proves SIMD is truly
 *       bit-exact with both scalar siblings on a real ICC pipeline)
 *   8.  Shared wasmCache reuses the compiled SIMD u16 Modules across
 *       Transforms (both 3D and 4D module keys)
 *   9.  Format-tag guardrail still fires on incompatible intLut
 *
 * Why bit-exact is the right bar (same as scalar u16 / u8 SIMD):
 *   The SIMD u16 kernels are channel-parallel rewrites of the same Q0.13
 *   math as the JS u16 kernels — same gridPointsScale_fixed_u16, same
 *   scale-65535 u16 CLUT, same `(sum + 0x1000) >> 13` rounding (and the
 *   same TWO-ROUNDING K-LERP for 4D). The only difference vs scalar is
 *   that the per-channel loop collapsed into one v128 of i32 lanes.
 *   JS uses Math.imul, WASM uses i32.mul — both wrap mod 2^32 the same
 *   way. Any drift from JS u16 / scalar u16 WASM is a bug, not a
 *   tolerance.
 *
 * Skip strategy mirrors transform_lutMode_wasm_simd.tests.js — both
 * WebAssembly AND WebAssembly SIMD must be available. SKIP_WASM_TESTS=1
 * also skips.
 */

const {Transform, eIntent} = require('../src/main');
const Profile = require('../src/Profile');
const path = require('path');

const cmykFilename = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

const SIMD_PROBE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
    0x03, 0x02, 0x01, 0x00,
    0x0a, 0x0a, 0x01, 0x08, 0x00,
    0x41, 0x00,
    0xfd, 0x0f, 0xfd, 0x62,
    0x0b
]);

const hasSimd = (() => {
    if(typeof WebAssembly === 'undefined') return false;
    try { return WebAssembly.validate(SIMD_PROBE); }
    catch(_){ return false; }
})();

const describeIfSimd = (hasSimd && !process.env.SKIP_WASM_TESTS)
    ? describe
    : describe.skip;

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

// Hard assertion the Transform is routing through the SIMD u16 WASM
// kernel (not silently demoted to scalar u16 WASM, JS u16, or float).
// Returns a closure the caller invokes AFTER transformArray() to confirm
// the SIMD u16 dispatch counter advanced by the expected delta.
function assertSimd16Routed(t){
    expect(t.lutMode).toBe('int16-wasm-simd');
    expect(t.wasmTetra3DInt16Simd).not.toBeNull();
    const before = t.wasmTetra3DInt16Simd.dispatchCount;
    return function expectDispatched(delta){
        if(delta === undefined) delta = 1;
        const after = t.wasmTetra3DInt16Simd.dispatchCount;
        expect(after - before).toBe(delta);
    };
}

function buildLargeInputRGB16(nPixels){
    const buf = new Uint16Array(nPixels * 3);
    let seed = 0xc0ffee;
    for(let i = 0; i < nPixels * 3; i++){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = seed & 0xffff;
    }
    return buf;
}

function buildLargeInputCMYK16(nPixels){
    const buf = new Uint16Array(nPixels * 4);
    let seed = 0xabcdef;
    for(let i = 0; i < nPixels * 4; i++){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = seed & 0xffff;
    }
    return buf;
}


describeIfSimd('lutMode=int16-wasm-simd — v1.3 WASM SIMD u16 dispatcher', () => {

    // ---------------------------------------------------------------
    // 1. Option parsing
    // ---------------------------------------------------------------
    test('option parsing: int16-wasm-simd is accepted as a valid lutMode', () => {
        const t = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd'});
        expect(t.lutMode).toBe('int16-wasm-simd');
        expect(t.wasmTetra3DInt16Simd).toBeNull(); // not loaded until create()

        const bag = {};
        const t2 = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd', wasmCache: bag});
        expect(t2.wasmCache).toBe(bag);
    });


    // ---------------------------------------------------------------
    // 2. create() populates wasmTetra3DInt16Simd + scalar fallthroughs
    // ---------------------------------------------------------------
    test('create(): all four u16 states populated for a real RGB pipeline (no silent demotion)', () => {
        const t = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd'});
        t.create('*srgb', '*adobergb', eIntent.relative);

        // SIMD u16 states — the headline kernels for this mode.
        expect(t.wasmTetra3DInt16Simd).not.toBeNull();
        expect(t.wasmTetra4DInt16Simd).not.toBeNull();
        expect(t.wasmTetra3DInt16Simd.isSimd).toBe(true);
        expect(t.wasmTetra4DInt16Simd.isSimd).toBe(true);

        // Scalar u16 fallthroughs — loaded for cMax ∉ {3, 4} cases the
        // SIMD kernels can't service (mirrors u8 SIMD-mode loadout).
        expect(t.wasmTetra3DInt16).not.toBeNull();
        expect(t.wasmTetra4DInt16).not.toBeNull();
        expect(t.wasmTetra3DInt16.isSimd).toBe(false);
        expect(t.wasmTetra4DInt16.isSimd).toBe(false);

        expect(t.lutMode).toBe('int16-wasm-simd'); // no demotion since SIMD is available
        expect(typeof t.wasmTetra3DInt16Simd.kernel).toBe('function');
        expect(typeof t.wasmTetra4DInt16Simd.kernel).toBe('function');
        expect(t.wasmTetra3DInt16Simd.memory).toBeInstanceOf(WebAssembly.Memory);
        expect(t.wasmTetra4DInt16Simd.memory).toBeInstanceOf(WebAssembly.Memory);

        expect(t.lut.intLut).toBeTruthy();
        expect(t.lut.intLut.gridPointsScale_fixed_u16).toBeGreaterThan(0);
        expect(t.wasmTetra3DInt16Simd.dispatchCount).toBe(0);
        expect(t.wasmTetra4DInt16Simd.dispatchCount).toBe(0);
    });


    // ---------------------------------------------------------------
    // 3. RGB → RGB bit-exact vs lutMode='int16'
    // ---------------------------------------------------------------
    test('RGB→RGB 3D 3Ch (u16): bit-exact against lutMode=int16', () => {
        const nPixels = 1 << 20;
        const input = buildLargeInputRGB16(nPixels);

        const jsT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16'});
        jsT.create('*srgb', '*adobergb', eIntent.relative);

        const simdT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd'});
        simdT.create('*srgb', '*adobergb', eIntent.relative);

        const expectDispatched = assertSimd16Routed(simdT);

        const oJs   = jsT.transformArray(input, false, false, false);
        const oSimd = simdT.transformArray(input, false, false, false);

        expectDispatched(1);

        expect(oJs).toBeInstanceOf(Uint16Array);
        expect(oSimd).toBeInstanceOf(Uint16Array);

        const d = maxAbsDiff(oJs, oSimd);
        if(d.max !== 0){
            const px = (d.firstDiffIdx / 3) | 0;
            throw new Error('SIMD u16 diverged from JS u16 at pixel ' + px +
                ' ch ' + (d.firstDiffIdx % 3) + ' (JS=' + d.A + ' SIMD=' + d.B + ')');
        }
        expect(d.max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 4. RGB → CMYK bit-exact vs lutMode='int16' (real ICC profile)
    // ---------------------------------------------------------------
    test('RGB→CMYK 3D 4Ch (u16): bit-exact against lutMode=int16 (real ICC)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 1 << 19;
        const input = buildLargeInputRGB16(nPixels);

        const jsT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16'});
        jsT.create('*srgb', cmykProfile, eIntent.relative);

        const simdT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd'});
        simdT.create('*srgb', cmykProfile, eIntent.relative);

        expect(simdT.lut.intLut.outputChannels).toBe(4);
        const expectDispatched = assertSimd16Routed(simdT);

        const oJs   = jsT.transformArray(input, false, false, false);
        const oSimd = simdT.transformArray(input, false, false, false);

        expectDispatched(1);

        const d = maxAbsDiff(oJs, oSimd);
        expect(d.max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 5. Below WASM_DISPATCH_MIN_PIXELS: JS fallback, counter stays flat
    // ---------------------------------------------------------------
    test('below WASM_DISPATCH_MIN_PIXELS: falls back to JS u16, SIMD counter does NOT advance', () => {
        const inputArr = [
            0,0,0,        65535,65535,65535,
            65535,0,0,    0,65535,0,        0,0,65535,
            16384,16384,16384, 32768,32768,32768, 49152,49152,49152,
        ];
        const input = new Uint16Array(inputArr);
        const pixelCount = input.length / 3;
        expect(pixelCount).toBeLessThan(Transform.WASM_DISPATCH_MIN_PIXELS);

        const jsT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16'});
        jsT.create('*srgb', '*adobergb', eIntent.relative);

        const simdT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd'});
        simdT.create('*srgb', '*adobergb', eIntent.relative);

        expect(simdT.lutMode).toBe('int16-wasm-simd');
        const beforeSimd   = simdT.wasmTetra3DInt16Simd.dispatchCount;
        const beforeScalar = simdT.wasmTetra3DInt16.dispatchCount;

        const oJs   = jsT.transformArray(input, false, false, false);
        const oSimd = simdT.transformArray(input, false, false, false);

        // Neither SIMD u16 nor scalar u16 WASM advances — below threshold
        // the dispatcher routes directly to JS u16.
        expect(simdT.wasmTetra3DInt16Simd.dispatchCount).toBe(beforeSimd);
        expect(simdT.wasmTetra3DInt16.dispatchCount).toBe(beforeScalar);

        const d = maxAbsDiff(oJs, oSimd);
        expect(d.max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 6. 4D CMYK → RGB: 4D SIMD u16 dispatched, bit-exact vs JS;
    //                   3D SIMD u16 counter stays flat
    // ---------------------------------------------------------------
    test('4D CMYK→RGB (u16): 4D SIMD WASM dispatched, bit-exact vs JS u16; 3D SIMD counter stays flat', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 1 << 17;
        const input = buildLargeInputCMYK16(nPixels);

        const jsT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16'});
        jsT.create(cmykProfile, '*srgb', eIntent.relative);

        const simdT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd'});
        simdT.create(cmykProfile, '*srgb', eIntent.relative);

        expect(simdT.wasmTetra3DInt16Simd).not.toBeNull();
        expect(simdT.wasmTetra4DInt16Simd).not.toBeNull();
        expect(simdT.lut.intLut.inputChannels).toBe(4);

        const before3D = simdT.wasmTetra3DInt16Simd.dispatchCount;
        const before4D = simdT.wasmTetra4DInt16Simd.dispatchCount;

        const oJs   = jsT.transformArray(input, false, false, false);
        const oSimd = simdT.transformArray(input, false, false, false);

        // 4D SIMD u16 WAS invoked for CMYK input...
        expect(simdT.wasmTetra4DInt16Simd.dispatchCount).toBe(before4D + 1);
        // ...3D SIMD u16 was NOT (cross-contamination guardrail).
        expect(simdT.wasmTetra3DInt16Simd.dispatchCount).toBe(before3D);

        expect(oJs).toBeInstanceOf(Uint16Array);
        expect(oSimd).toBeInstanceOf(Uint16Array);

        const d = maxAbsDiff(oJs, oSimd);
        if(d.max !== 0){
            const outCh = simdT.lut.intLut.outputChannels;
            const px = (d.firstDiffIdx / outCh) | 0;
            throw new Error('4D SIMD u16 diverged from JS u16 at pixel ' + px +
                ' ch ' + (d.firstDiffIdx % outCh) +
                ' (JS=' + d.A + ' SIMD=' + d.B + ')');
        }
        expect(d.max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 7. Three-way: SIMD u16 == scalar u16 WASM == JS u16
    // ---------------------------------------------------------------
    test('three-way: int16-wasm-simd == int16-wasm-scalar == int16 (every byte)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 1 << 17;
        const input = buildLargeInputRGB16(nPixels);

        const jsT     = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16'});
        jsT.create('*srgb', cmykProfile, eIntent.relative);
        const scalarT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-scalar'});
        scalarT.create('*srgb', cmykProfile, eIntent.relative);
        const simdT   = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd'});
        simdT.create('*srgb', cmykProfile, eIntent.relative);

        const oJs     = jsT.transformArray(input, false, false, false);
        const oScalar = scalarT.transformArray(input, false, false, false);
        const oSimd   = simdT.transformArray(input, false, false, false);

        expect(maxAbsDiff(oJs, oScalar).max).toBe(0);
        expect(maxAbsDiff(oJs, oSimd).max).toBe(0);
        expect(maxAbsDiff(oScalar, oSimd).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 8. Shared wasmCache reuses the compiled SIMD u16 Modules
    // ---------------------------------------------------------------
    test('shared wasmCache: two Transforms reuse the compiled SIMD u16 Modules', () => {
        const cache = {};
        const t1 = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd', wasmCache: cache});
        t1.create('*srgb', '*adobergb', eIntent.relative);

        const t2 = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd', wasmCache: cache});
        t2.create('*srgb', '*adobergb', eIntent.relative);

        // Both SIMD u16 module keys (3D + 4D) are cached when
        // lutMode=int16-wasm-simd; scalar u16 keys are also cached
        // for the fallthrough path.
        const simd3DKey   = '__jsColorEngine_tetra3d_simd_int16_module__';
        const simd4DKey   = '__jsColorEngine_tetra4d_simd_int16_module__';
        const scalar3DKey = '__jsColorEngine_tetra3d_nch_int16_module__';
        const scalar4DKey = '__jsColorEngine_tetra4d_nch_int16_module__';
        expect(cache[simd3DKey]).toBeInstanceOf(WebAssembly.Module);
        expect(cache[simd4DKey]).toBeInstanceOf(WebAssembly.Module);
        expect(cache[scalar3DKey]).toBeInstanceOf(WebAssembly.Module);
        expect(cache[scalar4DKey]).toBeInstanceOf(WebAssembly.Module);

        // Each Transform has its own Instance + memory for each state.
        expect(t1.wasmTetra3DInt16Simd).not.toBe(t2.wasmTetra3DInt16Simd);
        expect(t1.wasmTetra3DInt16Simd.memory).not.toBe(t2.wasmTetra3DInt16Simd.memory);
        expect(t1.wasmTetra4DInt16Simd).not.toBe(t2.wasmTetra4DInt16Simd);
    });


    // ---------------------------------------------------------------
    // 9. Format-tag guardrail still fires
    // ---------------------------------------------------------------
    test('format-tag guardrail: int16-wasm-simd throws on incompatible intLut', () => {
        const t = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd'});
        t.create('*srgb', '*adobergb', eIntent.relative);

        const input = buildLargeInputRGB16(1024);

        const before1 = t.wasmTetra3DInt16Simd.dispatchCount;
        expect(() => t.transformArray(input, false, false, false)).not.toThrow();
        expect(t.wasmTetra3DInt16Simd.dispatchCount).toBe(before1 + 1);

        const savedVersion = t.lut.intLut.version;
        t.lut.intLut.version = 99;
        expect(() => t.transformArray(input, false, false, false))
            .toThrow(/intLut format tag incompatible/);
        t.lut.intLut.version = savedVersion;

        expect(() => t.transformArray(input, false, false, false)).not.toThrow();
    });

});
