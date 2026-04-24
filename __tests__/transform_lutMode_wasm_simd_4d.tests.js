/**
 * lutMode='int-wasm-simd' — WASM SIMD 4D tetrahedral dispatcher tests (v1.2).
 *
 * This is the CMYK-input (inputChannels=4) sibling of
 * transform_lutMode_wasm_simd.tests.js. The 3D SIMD suite covers RGB
 * input routing through wasmTetra3DSimd; this suite covers CMYK input
 * routing through wasmTetra4DSimd. Both SIMD states coexist on the
 * same Transform — they load independently at create() time and fire
 * on disjoint input shapes.
 *
 * Coverage matrix (mirrors transform_lutMode_wasm_4d.tests.js for the
 * scalar 4D path, with a few SIMD-specific additions):
 *   1.  create() populates wasmTetra4DSimd (and siblings) under int-wasm-simd
 *   2.  CMYK→RGB  4D 3Ch — bit-exact against lutMode='int' sibling
 *   3.  CMYK→CMYK 4D 4Ch — bit-exact against lutMode='int' sibling
 *   4.  Below-threshold pixelCount falls back to JS — counters stay flat
 *   5.  Alpha: preserveAlpha in 4D 3Ch (CMYKA→RGBA)
 *   6.  Alpha: preserveAlpha in 4D 4Ch (CMYKA→CMYKA)
 *   7.  Alpha: input-alpha-only (CMYKA→RGB)
 *   8.  Alpha: output-alpha-only (CMYK→RGBA, fill 255)
 *   9.  Shared wasmCache reuses compiled 4D SIMD Module across Transforms
 *   10. Three-way equivalence: 4D-SIMD == 4D-scalar-WASM == JS-int
 *   11. 3D RGB pipeline leaves wasmTetra4DSimd unused (no cross-contamination)
 *   12. Format-tag guardrail still fires via 4D SIMD dispatch
 *
 * Why bit-exact:
 *   The SIMD 4D kernel is a channel-parallel rewrite of the same u20
 *   Q16.4 single-rounding math used by the scalar 4D WASM kernel and
 *   (transitively) the JS `_intLut_loop` kernels. See docs/Performance.md
 *   §1b "4D SIMD — measured".
 *
 * Dispatch-counter insurance:
 *   Without asserting wasmTetra4DSimd.dispatchCount advances, a silent
 *   fallthrough to wasmTetra4D (scalar) or to the JS int kernel would
 *   leave every bit-exact test trivially passing. `assertSimd4DRouted`
 *   is the hard tripwire — it fails fast if we ever regress the
 *   dispatcher logic.
 */

const {Transform, eIntent} = require('../src/main');
const Profile = require('../src/Profile');
const path = require('path');

const cmykFilename = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

// Same minimal SIMD-using module as in the 3D SIMD suite — both suites
// share a skip policy so they either both run or both skip as a unit.
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

// Hard assertion that a Transform is actually routing through the 4D
// SIMD WASM kernel (not silently demoted to scalar 4D, scalar 3D, or
// JS int). Returns a dispatched-delta closure the caller runs AFTER
// transformArray().
//
// This is the 4D SIMD analog of assertSimdRouted() in the 3D SIMD suite.
function assertSimd4DRouted(t){
    expect(t.lutMode).toBe('int-wasm-simd');
    expect(t.wasmTetra4DSimd).not.toBeNull();
    const before = t.wasmTetra4DSimd.dispatchCount;
    return function expectDispatched(delta){
        if(delta === undefined) delta = 1;
        const after = t.wasmTetra4DSimd.dispatchCount;
        expect(after - before).toBe(delta);
    };
}

function buildLargeInputCMYK(nPixels){
    const buf = new Uint8ClampedArray(nPixels * 4);
    let seed = 0xfade;
    for(let i = 0; i < nPixels * 4; i++){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = seed & 0xff;
    }
    return buf;
}

function buildLargeInputCMYKA(nPixels){
    const buf = new Uint8ClampedArray(nPixels * 5);
    let seed = 0xc001;
    for(let i = 0; i < nPixels * 5; i++){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = seed & 0xff;
    }
    return buf;
}


describeIfSimd('lutMode=int-wasm-simd — v1.2 WASM SIMD 4D dispatcher (CMYK input)', () => {

    // ---------------------------------------------------------------
    // 1. create() populates all four WASM states under int-wasm-simd
    // ---------------------------------------------------------------
    test('create(): all four WASM states populated (3D+4D, SIMD+scalar)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        t.create(cmykProfile, '*srgb', eIntent.relative);

        expect(t.wasmTetra3DSimd).not.toBeNull();
        expect(t.wasmTetra3D).not.toBeNull();
        expect(t.wasmTetra4DSimd).not.toBeNull();
        expect(t.wasmTetra4D).not.toBeNull();
        expect(t.lutMode).toBe('int-wasm-simd');

        expect(typeof t.wasmTetra4DSimd.kernel).toBe('function');
        expect(t.wasmTetra4DSimd.memory).toBeInstanceOf(WebAssembly.Memory);
        expect(t.wasmTetra4DSimd.isSimd).toBe(true);

        expect(t.lut.intLut).toBeTruthy();
        expect(t.wasmTetra4DSimd.dispatchCount).toBe(0);
        expect(t.wasmTetra4D.dispatchCount).toBe(0);
    });


    // ---------------------------------------------------------------
    // 2. CMYK → RGB bit-exact vs lutMode='int'
    // ---------------------------------------------------------------
    test('CMYK→RGB 4D 3Ch: bit-exact against lutMode=int (real ICC)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 1 << 17;
        const input = buildLargeInputCMYK(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, '*srgb', eIntent.relative);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create(cmykProfile, '*srgb', eIntent.relative);

        expect(simdT.lut.intLut.outputChannels).toBe(3);
        const expectDispatched = assertSimd4DRouted(simdT);

        const oInt  = intT.transformArray(input, false, false, false);
        const oSimd = simdT.transformArray(input, false, false, false);

        expectDispatched(1);
        // Scalar 4D MUST NOT fire when SIMD 4D is eligible.
        expect(simdT.wasmTetra4D.dispatchCount).toBe(0);

        const d = maxAbsDiff(oInt, oSimd);
        if(d.max !== 0){
            const px = (d.firstDiffIdx / 3) | 0;
            throw new Error('WASM SIMD 4D diverged from JS int at pixel ' + px +
                ' ch ' + (d.firstDiffIdx % 3) + ' (JS=' + d.A + ' SIMD=' + d.B + ')');
        }
        expect(d.max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 3. CMYK → CMYK bit-exact vs lutMode='int'
    // ---------------------------------------------------------------
    test('CMYK→CMYK 4D 4Ch: bit-exact against lutMode=int (GRACoL → GRACoL)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 1 << 17;
        const input = buildLargeInputCMYK(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, cmykProfile, eIntent.relative);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create(cmykProfile, cmykProfile, eIntent.relative);

        expect(simdT.lut.intLut.outputChannels).toBe(4);
        const expectDispatched = assertSimd4DRouted(simdT);

        const oInt  = intT.transformArray(input, false, false, false);
        const oSimd = simdT.transformArray(input, false, false, false);

        expectDispatched(1);
        expect(simdT.wasmTetra4D.dispatchCount).toBe(0);
        expect(oSimd.length).toBe(nPixels * 4);
        expect(maxAbsDiff(oInt, oSimd).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 4. Below-threshold pixelCount falls back to JS
    // ---------------------------------------------------------------
    test('below WASM_DISPATCH_MIN_PIXELS: falls back to JS, both 4D counters stay flat', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const input = [
            0,0,0,0,
            255,255,255,0,
            0,0,0,255,
            100,80,60,0,
            50,50,50,50,
        ];
        const pixelCount = input.length / 4;
        expect(pixelCount).toBeLessThan(Transform.WASM_DISPATCH_MIN_PIXELS);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, '*srgb', eIntent.relative);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create(cmykProfile, '*srgb', eIntent.relative);

        const before4DSimd = simdT.wasmTetra4DSimd.dispatchCount;
        const before4D     = simdT.wasmTetra4D.dispatchCount;

        const oInt  = intT.transformArray(input, false, false, false);
        const oSimd = simdT.transformArray(input, false, false, false);

        expect(simdT.wasmTetra4DSimd.dispatchCount).toBe(before4DSimd);
        expect(simdT.wasmTetra4D.dispatchCount).toBe(before4D);
        expect(maxAbsDiff(oInt, oSimd).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 5. Alpha: preserveAlpha in 4D 3Ch (CMYKA → RGBA)
    // ---------------------------------------------------------------
    test('alpha: preserveAlpha in 4D SIMD 3Ch kernel (CMYKA→RGBA)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 2048;
        const input = buildLargeInputCMYKA(nPixels);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create(cmykProfile, '*srgb', eIntent.relative);
        const expectDispatched = assertSimd4DRouted(simdT);

        const output = simdT.transformArray(input, true, true, true);
        expectDispatched(1);

        expect(output.length).toBe(nPixels * 4);

        let mismatches = 0;
        for(let i = 0; i < nPixels; i++){
            if(output[i*4 + 3] !== input[i*5 + 4]) mismatches++;
        }
        expect(mismatches).toBe(0);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, '*srgb', eIntent.relative);
        const oInt = intT.transformArray(input, true, true, true);
        expect(maxAbsDiff(oInt, output).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 6. Alpha: preserveAlpha in 4D 4Ch (CMYKA → CMYKA)
    // ---------------------------------------------------------------
    test('alpha: preserveAlpha in 4D SIMD 4Ch kernel (CMYKA→CMYKA)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 2048;
        const input = buildLargeInputCMYKA(nPixels);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create(cmykProfile, cmykProfile, eIntent.relative);
        const expectDispatched = assertSimd4DRouted(simdT);

        const output = simdT.transformArray(input, true, true, true);
        expectDispatched(1);

        expect(output.length).toBe(nPixels * 5);

        let mismatches = 0;
        for(let i = 0; i < nPixels; i++){
            if(output[i*5 + 4] !== input[i*5 + 4]) mismatches++;
        }
        expect(mismatches).toBe(0);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, cmykProfile, eIntent.relative);
        const oInt = intT.transformArray(input, true, true, true);
        expect(maxAbsDiff(oInt, output).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 7. Alpha: input-alpha-only (CMYKA → RGB, skip input alpha)
    // ---------------------------------------------------------------
    test('alpha: input-alpha-only via 4D SIMD (CMYKA→RGB, skip input alpha byte)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 2048;
        const input = buildLargeInputCMYKA(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, '*srgb', eIntent.relative);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create(cmykProfile, '*srgb', eIntent.relative);
        const expectDispatched = assertSimd4DRouted(simdT);

        const oInt  = intT.transformArray(input, true, false, false);
        const oSimd = simdT.transformArray(input, true, false, false);

        expectDispatched(1);
        expect(oSimd.length).toBe(nPixels * 3);
        expect(maxAbsDiff(oInt, oSimd).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 8. Alpha: output-alpha-only (CMYK → RGBA, fill 255)
    // ---------------------------------------------------------------
    test('alpha: output-alpha-only via 4D SIMD (CMYK→RGBA, fill alpha with 255)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 2048;
        const input = buildLargeInputCMYK(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, '*srgb', eIntent.relative);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create(cmykProfile, '*srgb', eIntent.relative);
        const expectDispatched = assertSimd4DRouted(simdT);

        const oInt  = intT.transformArray(input, false, true, false);
        const oSimd = simdT.transformArray(input, false, true, false);

        expectDispatched(1);
        expect(oSimd.length).toBe(nPixels * 4);
        expect(maxAbsDiff(oInt, oSimd).max).toBe(0);

        for(let i = 0; i < nPixels; i++){
            expect(oSimd[i*4 + 3]).toBe(255);
        }
    });


    // ---------------------------------------------------------------
    // 9. Shared wasmCache reuses compiled 4D SIMD Module
    // ---------------------------------------------------------------
    test('shared wasmCache: two Transforms reuse the compiled 4D SIMD Module', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const cache = {};
        const t1 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd', wasmCache: cache});
        t1.create(cmykProfile, '*srgb', eIntent.relative);

        const t2 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd', wasmCache: cache});
        t2.create(cmykProfile, '*srgb', eIntent.relative);

        const cache4DSimdKey = '__jsColorEngine_tetra4d_simd_module__';
        const cache4DKey     = '__jsColorEngine_tetra4d_nch_module__';
        const cache3DSimdKey = '__jsColorEngine_tetra3d_simd_module__';
        const cache3DKey     = '__jsColorEngine_tetra3d_nch_module__';
        expect(cache[cache4DSimdKey]).toBeInstanceOf(WebAssembly.Module);
        expect(cache[cache4DKey]).toBeInstanceOf(WebAssembly.Module);
        expect(cache[cache3DSimdKey]).toBeInstanceOf(WebAssembly.Module);
        expect(cache[cache3DKey]).toBeInstanceOf(WebAssembly.Module);

        const expect1 = assertSimd4DRouted(t1);
        const expect2 = assertSimd4DRouted(t2);

        // Each Transform has its OWN Instance + memory.
        expect(t1.wasmTetra4DSimd).not.toBe(t2.wasmTetra4DSimd);
        expect(t1.wasmTetra4DSimd.memory).not.toBe(t2.wasmTetra4DSimd.memory);

        const input = buildLargeInputCMYK(2048);
        const o1 = t1.transformArray(input, false, false, false);
        const o2 = t2.transformArray(input, false, false, false);
        expect1(1);
        expect2(1);
        expect(maxAbsDiff(o1, o2).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 10. Three-way equivalence: 4D-SIMD == 4D-scalar-WASM == JS-int
    // ---------------------------------------------------------------
    test('3-way bit-exact: 4D SIMD == 4D scalar WASM == JS int', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 8192;
        const input = buildLargeInputCMYK(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, '*srgb', eIntent.relative);

        const scalarT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
        scalarT.create(cmykProfile, '*srgb', eIntent.relative);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create(cmykProfile, '*srgb', eIntent.relative);

        const oInt    = intT.transformArray(input, false, false, false);
        const oScalar = scalarT.transformArray(input, false, false, false);
        const oSimd   = simdT.transformArray(input, false, false, false);

        expect(maxAbsDiff(oInt, oScalar).max).toBe(0);
        expect(maxAbsDiff(oInt, oSimd).max).toBe(0);
        expect(maxAbsDiff(oScalar, oSimd).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 11. 3D RGB pipeline leaves wasmTetra4DSimd untouched
    // ---------------------------------------------------------------
    test('3D RGB pipeline: wasmTetra4DSimd dispatchCount stays at 0', () => {
        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create('*srgb', '*adobergb', eIntent.relative);

        // 4D SIMD state still loaded — it's input-independent — but the
        // dispatcher MUST NOT fire it for RGB-input pipelines.
        expect(simdT.wasmTetra3DSimd).not.toBeNull();
        expect(simdT.wasmTetra4DSimd).not.toBeNull();

        const nPixels = 2048;
        const input = new Uint8ClampedArray(nPixels * 3);
        for(let i = 0; i < input.length; i++) input[i] = (i * 37) & 0xff;

        const before3DSimd = simdT.wasmTetra3DSimd.dispatchCount;
        const before4DSimd = simdT.wasmTetra4DSimd.dispatchCount;

        simdT.transformArray(input, false, false, false);

        expect(simdT.wasmTetra3DSimd.dispatchCount).toBe(before3DSimd + 1);
        expect(simdT.wasmTetra4DSimd.dispatchCount).toBe(before4DSimd); // untouched
    });


    // ---------------------------------------------------------------
    // 12. Format-tag guardrail still fires via 4D SIMD dispatch
    // ---------------------------------------------------------------
    test('format-tag guardrail: 4D SIMD throws on incompatible intLut', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create(cmykProfile, '*srgb', eIntent.relative);
        assertSimd4DRouted(simdT);

        const input = buildLargeInputCMYK(2048);

        const before = simdT.wasmTetra4DSimd.dispatchCount;
        expect(() => simdT.transformArray(input, false, false, false)).not.toThrow();
        expect(simdT.wasmTetra4DSimd.dispatchCount).toBe(before + 1);

        const savedVersion = simdT.lut.intLut.version;
        simdT.lut.intLut.version = 99;
        expect(() => simdT.transformArray(input, false, false, false))
            .toThrow(/intLut format tag incompatible/);
        simdT.lut.intLut.version = savedVersion;

        expect(() => simdT.transformArray(input, false, false, false)).not.toThrow();
    });

});
