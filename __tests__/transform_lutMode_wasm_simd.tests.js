/**
 * lutMode='int-wasm-simd' — WASM SIMD 3D tetrahedral dispatcher tests (v1.2).
 *
 * Coverage matrix (mirrors transform_lutMode_wasm.tests.js for the scalar
 * path; diffs vs. the scalar suite are called out inline):
 *   1.  Option parsing — 'int-wasm-simd' is accepted as a valid lutMode
 *   2.  create() populates wasmTetra3DSimd for a real RGB pipeline
 *   3.  RGB→RGB 3D 3Ch — bit-exact against lutMode='int' sibling
 *   4.  RGB→CMYK 3D 4Ch — bit-exact against lutMode='int' sibling
 *   5.  Below-threshold pixelCount falls back to JS — output still matches
 *   6.  Alpha: preserveAlpha in 3D 3Ch (RGBA→RGBA)
 *   7.  Alpha: preserveAlpha in 3D 4Ch (RGBA→CMYKA)
 *   8.  Alpha: inputHasAlpha && !outputHasAlpha (input-alpha skip)
 *   9.  Alpha: !inputHasAlpha && outputHasAlpha (fill-255)
 *   10. Shared wasmCache reuses compiled SIMD Module across Transforms
 *   11. Three-way equivalence: SIMD == scalar-WASM == JS-int
 *   12. 4D CMYK pipeline dispatches through wasmTetra4DSimd, NOT wasmTetra3DSimd
 *   13. Format-tag guardrail still fires in wasm-simd mode
 *
 * Why bit-exact is the right bar:
 *   The SIMD kernel is a channel-parallel rewrite of the same math — same
 *   Q0.16 gps, same u16 CLUT, same `(x + 0x80) >> 8` rounding applied twice.
 *   The only difference from scalar is that the 3-or-4 channel loop collapsed
 *   into one v128 vector of i32 lanes. Any drift from the JS int or WASM
 *   scalar sibling is a bug, not a tolerance thing.
 *
 * Dispatch-counter insurance:
 *   Without checking `wasmTetra3DSimd.dispatchCount`, a silent demotion from
 *   'int-wasm-simd' → 'int-wasm-scalar' → 'int' (e.g. if SIMD fails to
 *   compile on the host) would leave every bit-exact test trivially passing.
 *   `assertSimdRouted()` is the hard tripwire.
 *
 * Skip strategy:
 *   These tests need both WebAssembly AND WebAssembly SIMD support. Node 16+
 *   has SIMD unflagged; Node 14 needed --experimental-wasm-simd. CI runs
 *   Node 18/20 and this is never skipped. Set `SKIP_WASM_TESTS=1` to bypass.
 */

const {Transform, eIntent} = require('../src/main');
const Profile = require('../src/Profile');
const path = require('path');

const cmykFilename = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

// Host must have both WebAssembly and WebAssembly SIMD. We detect SIMD by
// trying to compile a minimal SIMD-using module — same pattern the loader
// uses internally, so the detection matches reality.
const SIMD_PROBE = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
    0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,       // type: () -> v128
    0x03, 0x02, 0x01, 0x00,                         // func 0 -> type 0
    0x0a, 0x0a, 0x01, 0x08, 0x00,                   // code section, 1 func, 8 bytes
    0x41, 0x00,                                     //   i32.const 0
    0xfd, 0x0f, 0xfd, 0x62,                         //   i32x4.splat, v128.not (any SIMD op)
    0x0b                                            //   end
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

// Hard assertion the Transform is routing through the SIMD WASM kernel.
// Returns a closure the caller invokes AFTER transformArray() to confirm
// the SIMD dispatch counter advanced by the expected delta.
//
// Contrast with the scalar suite's `assertWasmRouted` — this one checks
// wasmTetra3DSimd, not wasmTetra3D. If the simd instance silently demotes
// to scalar (at create-time) or falls through to scalar (per-dispatch,
// for cMax ∉ {3,4}), this will correctly show delta=0 on the SIMD counter.
function assertSimdRouted(t){
    expect(t.lutMode).toBe('int-wasm-simd');
    expect(t.wasmTetra3DSimd).not.toBeNull();
    const before = t.wasmTetra3DSimd.dispatchCount;
    return function expectDispatched(delta){
        if(delta === undefined) delta = 1;
        const after = t.wasmTetra3DSimd.dispatchCount;
        expect(after - before).toBe(delta);
    };
}

function buildLargeInputRGBA(nPixels){
    const buf = new Uint8ClampedArray(nPixels * 4);
    let seed = 0xc0ffee;
    for(let i = 0; i < nPixels * 4; i++){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = seed & 0xff;
    }
    return buf;
}

function buildLargeInputRGB(nPixels){
    const buf = new Uint8ClampedArray(nPixels * 3);
    let seed = 0xc0ffee;
    for(let i = 0; i < nPixels * 3; i++){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = seed & 0xff;
    }
    return buf;
}

function buildInput4Ch(){
    const arr = [
        0,0,0,0,           255,255,255,255,
        255,0,0,0,   0,255,0,0,   0,0,255,0,   0,0,0,255,
        100,80,60,0,  100,80,60,128,  100,80,60,255,
        20, 40, 80, 5,   80, 60, 30, 120,   30, 90, 180, 60,
    ];
    let seed = 0xabcd;
    while(arr.length < 1000){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        arr.push(seed & 0xff);
    }
    return arr;
}


describeIfSimd('lutMode=int-wasm-simd — v1.2 WASM SIMD dispatcher', () => {

    // ---------------------------------------------------------------
    // 1. Option parsing
    // ---------------------------------------------------------------
    test('option parsing: int-wasm-simd is accepted as a valid lutMode', () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        expect(t.lutMode).toBe('int-wasm-simd');

        // Before create(): no WASM state yet
        expect(t.wasmTetra3DSimd).toBeNull();
        expect(t.wasmTetra3D).toBeNull();

        // wasmCache option threaded through
        const bag = {};
        const t2 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd', wasmCache: bag});
        expect(t2.wasmCache).toBe(bag);
    });


    // ---------------------------------------------------------------
    // 2. create() populates wasmTetra3DSimd (and scalar fallthrough)
    // ---------------------------------------------------------------
    test('create(): wasmTetra3DSimd is populated for a real RGB pipeline (no silent demotion)', () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        t.create('*srgb', '*adobergb', eIntent.relative);

        // Hard "SIMD actually wired up" guarantee — if any of these fail
        // the rest of the suite would trivially pass on the JS 'int' or
        // scalar WASM path.
        expect(t.wasmTetra3DSimd).not.toBeNull();
        expect(t.lutMode).toBe('int-wasm-simd'); // no demotion since SIMD is available
        expect(typeof t.wasmTetra3DSimd.kernel).toBe('function');
        expect(t.wasmTetra3DSimd.memory).toBeInstanceOf(WebAssembly.Memory);
        expect(t.wasmTetra3DSimd.isSimd).toBe(true);

        // Scalar fallthrough state is also loaded (for future cMax=5+ cases).
        // On a V8 build that supports SIMD, scalar compile also succeeds.
        expect(t.wasmTetra3D).not.toBeNull();
        expect(t.wasmTetra3D.isSimd).toBe(false);

        expect(t.lut.intLut).toBeTruthy();
        expect(t.wasmTetra3DSimd.dispatchCount).toBe(0);
    });


    // ---------------------------------------------------------------
    // 3. RGB → RGB bit-exact vs lutMode='int'
    // ---------------------------------------------------------------
    test('RGB→RGB 3D 3Ch: bit-exact against lutMode=int', () => {
        const nPixels = 1 << 20;
        const input = buildLargeInputRGB(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create('*srgb', '*adobergb', eIntent.relative);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create('*srgb', '*adobergb', eIntent.relative);

        const expectDispatched = assertSimdRouted(simdT);

        const oInt  = intT.transformArray(input, false, false, false);
        const oSimd = simdT.transformArray(input, false, false, false);

        expectDispatched(1);

        const d = maxAbsDiff(oInt, oSimd);
        if(d.max !== 0){
            const px = (d.firstDiffIdx / 3) | 0;
            throw new Error('SIMD diverged from JS int at pixel ' + px +
                ' ch ' + (d.firstDiffIdx % 3) + ' (JS=' + d.A + ' SIMD=' + d.B + ')');
        }
        expect(d.max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 4. RGB → CMYK bit-exact vs lutMode='int'
    // ---------------------------------------------------------------
    test('RGB→CMYK 3D 4Ch: bit-exact against lutMode=int (real ICC)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 1 << 19; // 512k
        const input = buildLargeInputRGB(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create('*srgb', cmykProfile, eIntent.relative);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create('*srgb', cmykProfile, eIntent.relative);

        expect(simdT.lut.intLut.outputChannels).toBe(4);
        const expectDispatched = assertSimdRouted(simdT);

        const oInt  = intT.transformArray(input, false, false, false);
        const oSimd = simdT.transformArray(input, false, false, false);

        expectDispatched(1);

        const d = maxAbsDiff(oInt, oSimd);
        expect(d.max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 5. Below-threshold pixelCount falls back to JS
    // ---------------------------------------------------------------
    test('below WASM_DISPATCH_MIN_PIXELS: falls back to JS, SIMD dispatchCount does NOT advance', () => {
        const input = [
            0,0,0,   255,255,255,
            255,0,0, 0,255,0,    0,0,255,
            64,64,64, 128,128,128, 192,192,192,
        ];
        const pixelCount = input.length / 3;
        expect(pixelCount).toBeLessThan(Transform.WASM_DISPATCH_MIN_PIXELS);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create('*srgb', '*adobergb', eIntent.relative);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create('*srgb', '*adobergb', eIntent.relative);

        expect(simdT.lutMode).toBe('int-wasm-simd');
        const beforeSimd = simdT.wasmTetra3DSimd.dispatchCount;
        const beforeScalar = simdT.wasmTetra3D.dispatchCount;

        const oInt  = intT.transformArray(input, false, false, false);
        const oSimd = simdT.transformArray(input, false, false, false);

        // Neither the SIMD counter nor the scalar fallthrough counter
        // advances — below threshold we skip BOTH WASM kernels and go
        // directly to 'int' JS.
        expect(simdT.wasmTetra3DSimd.dispatchCount).toBe(beforeSimd);
        expect(simdT.wasmTetra3D.dispatchCount).toBe(beforeScalar);
        expect(maxAbsDiff(oInt, oSimd).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 6. Alpha: preserveAlpha in 3D 3Ch (RGBA → RGBA)
    // ---------------------------------------------------------------
    test('alpha: preserveAlpha in 3D 3Ch kernel (RGBA→RGBA)', () => {
        const nPixels = 2048;
        const input = buildLargeInputRGBA(nPixels);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create('*srgb', '*adobergb', eIntent.relative);
        const expectDispatched = assertSimdRouted(simdT);

        const output = simdT.transformArray(input, true, true, true);
        expectDispatched(1);

        let mismatches = 0;
        for(let i = 0; i < nPixels; i++){
            if(output[i*4 + 3] !== input[i*4 + 3]) mismatches++;
        }
        expect(mismatches).toBe(0);

        // RGB bytes must match the lutMode='int' sibling exactly.
        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create('*srgb', '*adobergb', eIntent.relative);
        const oInt = intT.transformArray(input, true, true, true);
        expect(maxAbsDiff(oInt, output).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 7. Alpha: preserveAlpha in 3D 4Ch (RGBA → CMYKA)
    // ---------------------------------------------------------------
    test('alpha: preserveAlpha in 3D 4Ch kernel (RGBA→CMYKA)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 2048;
        const input = buildLargeInputRGBA(nPixels);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create('*srgb', cmykProfile, eIntent.relative);
        const expectDispatched = assertSimdRouted(simdT);

        const output = simdT.transformArray(input, true, true, true);
        expectDispatched(1);

        // 4 CMYK bytes + 1 alpha = 5 bytes per pixel
        expect(output.length).toBe(nPixels * 5);

        let mismatches = 0;
        for(let i = 0; i < nPixels; i++){
            if(output[i*5 + 4] !== input[i*4 + 3]) mismatches++;
        }
        expect(mismatches).toBe(0);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create('*srgb', cmykProfile, eIntent.relative);
        const oInt = intT.transformArray(input, true, true, true);
        expect(maxAbsDiff(oInt, output).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 8. Alpha: inputHasAlpha && !outputHasAlpha
    // ---------------------------------------------------------------
    test('alpha: input-alpha-only (RGBA→RGB, skip alpha byte)', () => {
        const nPixels = 2048;
        const input = buildLargeInputRGBA(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create('*srgb', '*adobergb', eIntent.relative);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create('*srgb', '*adobergb', eIntent.relative);
        const expectDispatched = assertSimdRouted(simdT);

        const oInt  = intT.transformArray(input, true, false, false);
        const oSimd = simdT.transformArray(input, true, false, false);

        expectDispatched(1);
        expect(oSimd.length).toBe(nPixels * 3);
        expect(maxAbsDiff(oInt, oSimd).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 9. Alpha: !inputHasAlpha && outputHasAlpha
    // ---------------------------------------------------------------
    test('alpha: output-alpha-only (RGB→RGBA, fill alpha with 255)', () => {
        const nPixels = 2048;
        const input = buildLargeInputRGB(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create('*srgb', '*adobergb', eIntent.relative);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create('*srgb', '*adobergb', eIntent.relative);
        const expectDispatched = assertSimdRouted(simdT);

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
    // 10. Shared wasmCache
    // ---------------------------------------------------------------
    test('shared wasmCache: two Transforms reuse the compiled SIMD Module', () => {
        const cache = {};
        const t1 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd', wasmCache: cache});
        t1.create('*srgb', '*adobergb', eIntent.relative);

        const t2 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd', wasmCache: cache});
        t2.create('*srgb', '*adobergb', eIntent.relative);

        // Both SIMD and scalar modules get cached when lutMode=int-wasm-simd
        // (the scalar one is loaded for future cMax ∉ {3,4} fallthrough).
        const simdCacheKey   = '__jsColorEngine_tetra3d_simd_module__';
        const scalarCacheKey = '__jsColorEngine_tetra3d_nch_module__';
        expect(cache[simdCacheKey]).toBeInstanceOf(WebAssembly.Module);
        expect(cache[scalarCacheKey]).toBeInstanceOf(WebAssembly.Module);

        const expect1 = assertSimdRouted(t1);
        const expect2 = assertSimdRouted(t2);

        // Each Transform still has its OWN Instance + memory.
        expect(t1.wasmTetra3DSimd).not.toBe(t2.wasmTetra3DSimd);
        expect(t1.wasmTetra3DSimd.memory).not.toBe(t2.wasmTetra3DSimd.memory);

        const input = buildLargeInputRGB(2048);
        const o1 = t1.transformArray(input, false, false, false);
        const o2 = t2.transformArray(input, false, false, false);
        expect1(1);
        expect2(1);
        expect(maxAbsDiff(o1, o2).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 11. Three-way equivalence: SIMD == scalar-WASM == JS-int
    // ---------------------------------------------------------------
    //
    // This is the key test that proves SIMD is a drop-in replacement.
    // We run the same input through all three LUT paths and assert
    // every output byte is identical across all three. If SIMD ever
    // diverges from scalar (or scalar from JS-int) by a single LSB,
    // this test surfaces it before any regression can hide behind
    // the "it's close enough" argument.
    test('three-way: int-wasm-simd == int-wasm-scalar == int (every byte)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 1 << 17; // 128k, big enough for all 6 tetra cases
        const input = buildLargeInputRGB(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create('*srgb', cmykProfile, eIntent.relative);

        const scalarT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
        scalarT.create('*srgb', cmykProfile, eIntent.relative);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create('*srgb', cmykProfile, eIntent.relative);

        const oInt    = intT.transformArray(input, false, false, false);
        const oScalar = scalarT.transformArray(input, false, false, false);
        const oSimd   = simdT.transformArray(input, false, false, false);

        expect(maxAbsDiff(oInt, oScalar).max).toBe(0);
        expect(maxAbsDiff(oInt, oSimd).max).toBe(0);
        expect(maxAbsDiff(oScalar, oSimd).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 12. 4D CMYK dispatches through wasmTetra4DSimd, NOT wasmTetra3DSimd
    // ---------------------------------------------------------------
    // Under lutMode='int-wasm-simd' a 4D CMYK-input pipeline with cMax
    // ∈ {3,4} must route through the 4D SIMD kernel. The 3D SIMD counter
    // must stay flat — if it advances, that's cross-contamination. See
    // the dedicated suite transform_lutMode_wasm_simd_4d.tests.js for
    // deeper coverage (alpha modes, cache sharing, bit-exactness vs
    // scalar 4D WASM, etc.); this test is the sibling-suite tripwire.
    test('4D CMYK: dispatches through WASM SIMD 4D (3D SIMD counter stays flat)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        // 2048 CMYK pixels (> WASM_DISPATCH_MIN_PIXELS) so the dispatcher
        // actually routes through WASM rather than falling back to JS int.
        const nPixels = 2048;
        const input = new Uint8ClampedArray(nPixels * 4);
        let seed = 0xbadf00d;
        for(let i = 0; i < input.length; i++){
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            input[i] = seed & 0xff;
        }

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create(cmykProfile, '*srgb', eIntent.relative);

        expect(simdT.wasmTetra3DSimd).not.toBeNull();
        expect(simdT.wasmTetra4DSimd).not.toBeNull();
        expect(simdT.lutMode).toBe('int-wasm-simd');

        const before3DSimd = simdT.wasmTetra3DSimd.dispatchCount;
        const before4DSimd = simdT.wasmTetra4DSimd.dispatchCount;

        simdT.transformArray(input, false, false, false);

        // 3D SIMD counter MUST NOT have moved — this pipeline is 4D.
        expect(simdT.wasmTetra3DSimd.dispatchCount).toBe(before3DSimd);
        // 4D SIMD counter DID move.
        expect(simdT.wasmTetra4DSimd.dispatchCount).toBe(before4DSimd + 1);
    });


    // ---------------------------------------------------------------
    // 13. Format-tag guardrail still fires in wasm-simd mode
    // ---------------------------------------------------------------
    test('format-tag guardrail: wasm-simd throws on incompatible intLut', () => {
        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create('*srgb', '*adobergb', eIntent.relative);
        assertSimdRouted(simdT);

        const input = buildLargeInputRGB(2048);

        const before1 = simdT.wasmTetra3DSimd.dispatchCount;
        expect(() => simdT.transformArray(input, false, false, false)).not.toThrow();
        expect(simdT.wasmTetra3DSimd.dispatchCount).toBe(before1 + 1);

        const savedVersion = simdT.lut.intLut.version;
        simdT.lut.intLut.version = 99;
        expect(() => simdT.transformArray(input, false, false, false))
            .toThrow(/intLut format tag incompatible/);
        simdT.lut.intLut.version = savedVersion;

        expect(() => simdT.transformArray(input, false, false, false)).not.toThrow();
    });

});
