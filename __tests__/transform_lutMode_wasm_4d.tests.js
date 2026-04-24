/**
 * lutMode='int-wasm-scalar' — WASM 4D tetrahedral dispatcher tests (v1.2).
 *
 * This is the CMYK-input sibling of transform_lutMode_wasm.tests.js.
 * The 3D suite covers inputChannels=3 (RGB/Lab input) routing through
 * wasmTetra3D; this suite covers inputChannels=4 (CMYK input) routing
 * through wasmTetra4D. Both states coexist on the same Transform — they
 * load independently at create() time and fire on disjoint input shapes.
 *
 * Coverage matrix (mirrors the 3D suite where applicable):
 *   1.  create() populates BOTH wasmTetra3D and wasmTetra4D
 *   2.  CMYK→RGB  4D 3Ch — bit-exact against lutMode='int' sibling
 *   3.  CMYK→CMYK 4D 4Ch — bit-exact against lutMode='int' sibling
 *   4.  Below-threshold pixelCount falls back to JS (counter doesn't advance)
 *   5.  Alpha: preserveAlpha in 4D 3Ch (KCMYA→RGBA)
 *   6.  Alpha: preserveAlpha in 4D 4Ch (KCMYA→CMYKA)
 *   7.  Alpha: inputHasAlpha && !outputHasAlpha (KCMY+A → RGB, skip alpha)
 *   8.  Alpha: !inputHasAlpha && outputHasAlpha (CMYK → RGBA, fill-255)
 *   9.  Shared wasmCache reuses compiled 4D Module across Transforms
 *   10. Format-tag guardrail fires in wasm-scalar mode for 4D too
 *   11. 3D RGB pipeline leaves wasmTetra4D unused (no cross-contamination)
 *   12. Under lutMode='int-wasm-simd' with cMax ∉ {3,4}, 4D scalar takes over
 *       (SIMD-only cMax {3,4} is covered in transform_lutMode_wasm_simd_4d)
 *
 * Why bit-exact is the right bar (same logic as the 3D suite):
 *   The WASM 4D kernel is a line-by-line port of the JS
 *   `tetrahedralInterp4DArray_{3,4}Ch_intLut_loop` — same u20 Q16.4
 *   single-rounding design, same u16 CLUT, same K-axis LERP.
 *   See docs/Performance.md §1b "4D scalar — measured".
 */

const {Transform, eIntent} = require('../src/main');
const Profile = require('../src/Profile');
const path = require('path');

const cmykFilename = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

const describeIfWasm = (typeof WebAssembly !== 'undefined' && !process.env.SKIP_WASM_TESTS)
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
// WASM kernel, not a silently-demoted JS-int fallback. Returns a
// dispatched-delta closure the caller runs AFTER transformArray().
function assertWasm4DRouted(t){
    expect(t.lutMode).toMatch(/^int-wasm-/);
    expect(t.wasmTetra4D).not.toBeNull();
    const before = t.wasmTetra4D.dispatchCount;
    return function expectDispatched(delta){
        if(delta === undefined) delta = 1;
        const after = t.wasmTetra4D.dispatchCount;
        expect(after - before).toBe(delta);
    };
}

// Deterministic KCMY input covering tesseract corners + interior spread.
// 4 bytes/pixel; padded out to >= 1000 bytes with a linear-congruential
// sequence for repeatable hits on all 24 tetrahedral cases.
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


describeIfWasm('lutMode=int-wasm-scalar — v1.2 WASM 4D dispatcher (CMYK input)', () => {

    // ---------------------------------------------------------------
    // 1. create() populates BOTH WASM states
    // ---------------------------------------------------------------
    test('create(): both wasmTetra3D and wasmTetra4D populated (no silent demotion)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
        t.create(cmykProfile, '*srgb', eIntent.relative);

        // Hard "WASM actually wired up" guarantee for both states.
        expect(t.wasmTetra3D).not.toBeNull();
        expect(t.wasmTetra4D).not.toBeNull();
        expect(t.lutMode).toBe('int-wasm-scalar');
        expect(typeof t.wasmTetra4D.kernel).toBe('function');
        expect(t.wasmTetra4D.memory).toBeInstanceOf(WebAssembly.Memory);

        expect(t.lut.intLut).toBeTruthy();
        expect(t.wasmTetra4D.dispatchCount).toBe(0);
        expect(t.wasmTetra3D.dispatchCount).toBe(0);
    });


    // ---------------------------------------------------------------
    // 2. CMYK → RGB bit-exact vs lutMode='int'
    // ---------------------------------------------------------------
    test('CMYK→RGB 4D 3Ch: bit-exact against lutMode=int (real ICC)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 1 << 17; // 128k
        const input = buildLargeInputCMYK(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, '*srgb', eIntent.relative);

        const wasmT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
        wasmT.create(cmykProfile, '*srgb', eIntent.relative);

        expect(wasmT.lut.intLut.outputChannels).toBe(3);
        const expectDispatched = assertWasm4DRouted(wasmT);

        const oInt  = intT.transformArray(input, false, false, false);
        const oWasm = wasmT.transformArray(input, false, false, false);

        expectDispatched(1);

        const d = maxAbsDiff(oInt, oWasm);
        if(d.max !== 0){
            const px = (d.firstDiffIdx / 3) | 0;
            throw new Error('WASM 4D diverged from JS int at pixel ' + px +
                ' ch ' + (d.firstDiffIdx % 3) + ' (JS=' + d.A + ' WASM=' + d.B + ')');
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

        const wasmT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
        wasmT.create(cmykProfile, cmykProfile, eIntent.relative);

        expect(wasmT.lut.intLut.outputChannels).toBe(4);
        const expectDispatched = assertWasm4DRouted(wasmT);

        const oInt  = intT.transformArray(input, false, false, false);
        const oWasm = wasmT.transformArray(input, false, false, false);

        expectDispatched(1);
        expect(oWasm.length).toBe(nPixels * 4);
        expect(maxAbsDiff(oInt, oWasm).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 4. Below-threshold pixelCount falls back to JS (still correct)
    // ---------------------------------------------------------------
    test('below WASM_DISPATCH_MIN_PIXELS: falls back to JS, dispatchCount does NOT advance', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        // Tiny input — 5 CMYK pixels.
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

        const wasmT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
        wasmT.create(cmykProfile, '*srgb', eIntent.relative);

        expect(wasmT.lutMode).toBe('int-wasm-scalar');
        const before = wasmT.wasmTetra4D.dispatchCount;

        const oInt  = intT.transformArray(input, false, false, false);
        const oWasm = wasmT.transformArray(input, false, false, false);

        // Counter MUST NOT have advanced — threshold gate is working.
        expect(wasmT.wasmTetra4D.dispatchCount).toBe(before);
        expect(maxAbsDiff(oInt, oWasm).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 5. Alpha: preserveAlpha in 4D 3Ch (KCMY+A → RGB+A)
    // ---------------------------------------------------------------
    test('alpha: preserveAlpha in 4D 3Ch kernel (CMYKA→RGBA)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 2048;
        const input = buildLargeInputCMYKA(nPixels);

        const wasmT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
        wasmT.create(cmykProfile, '*srgb', eIntent.relative);
        const expectDispatched = assertWasm4DRouted(wasmT);

        const output = wasmT.transformArray(input, true, true, true);
        expectDispatched(1);

        // 3 RGB bytes + 1 alpha = 4 bytes per pixel
        expect(output.length).toBe(nPixels * 4);

        let mismatches = 0;
        for(let i = 0; i < nPixels; i++){
            if(output[i*4 + 3] !== input[i*5 + 4]) mismatches++;
        }
        expect(mismatches).toBe(0);

        // RGB bytes match lutMode='int' sibling.
        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, '*srgb', eIntent.relative);
        const oInt = intT.transformArray(input, true, true, true);
        expect(maxAbsDiff(oInt, output).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 6. Alpha: preserveAlpha in 4D 4Ch (KCMY+A → CMYK+A)
    // ---------------------------------------------------------------
    test('alpha: preserveAlpha in 4D 4Ch kernel (CMYKA→CMYKA)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 2048;
        const input = buildLargeInputCMYKA(nPixels);

        const wasmT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
        wasmT.create(cmykProfile, cmykProfile, eIntent.relative);
        const expectDispatched = assertWasm4DRouted(wasmT);

        const output = wasmT.transformArray(input, true, true, true);
        expectDispatched(1);

        // 4 CMYK bytes + 1 alpha = 5 bytes per pixel
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
    // 7. Alpha: inputHasAlpha && !outputHasAlpha (skip input alpha)
    // ---------------------------------------------------------------
    test('alpha: input-alpha-only (CMYKA→RGB, skip input alpha byte)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 2048;
        const input = buildLargeInputCMYKA(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, '*srgb', eIntent.relative);

        const wasmT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
        wasmT.create(cmykProfile, '*srgb', eIntent.relative);
        const expectDispatched = assertWasm4DRouted(wasmT);

        const oInt  = intT.transformArray(input, true, false, false);
        const oWasm = wasmT.transformArray(input, true, false, false);

        expectDispatched(1);
        expect(oWasm.length).toBe(nPixels * 3);
        expect(maxAbsDiff(oInt, oWasm).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 8. Alpha: !inputHasAlpha && outputHasAlpha (fill 255)
    // ---------------------------------------------------------------
    test('alpha: output-alpha-only (CMYK→RGBA, fill alpha with 255)', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 2048;
        const input = buildLargeInputCMYK(nPixels);

        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, '*srgb', eIntent.relative);

        const wasmT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
        wasmT.create(cmykProfile, '*srgb', eIntent.relative);
        const expectDispatched = assertWasm4DRouted(wasmT);

        const oInt  = intT.transformArray(input, false, true, false);
        const oWasm = wasmT.transformArray(input, false, true, false);

        expectDispatched(1);
        expect(oWasm.length).toBe(nPixels * 4);
        expect(maxAbsDiff(oInt, oWasm).max).toBe(0);

        // Every 4th byte is the alpha slot, filled with 255.
        for(let i = 0; i < nPixels; i++){
            expect(oWasm[i*4 + 3]).toBe(255);
        }
    });


    // ---------------------------------------------------------------
    // 9. Shared wasmCache reuses compiled 4D Module
    // ---------------------------------------------------------------
    test('shared wasmCache: two Transforms reuse the compiled 4D Module', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const cache = {};
        const t1 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar', wasmCache: cache});
        t1.create(cmykProfile, '*srgb', eIntent.relative);

        const t2 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar', wasmCache: cache});
        t2.create(cmykProfile, '*srgb', eIntent.relative);

        const cache4DKey = '__jsColorEngine_tetra4d_nch_module__';
        const cache3DKey = '__jsColorEngine_tetra3d_nch_module__';
        expect(cache[cache4DKey]).toBeInstanceOf(WebAssembly.Module);
        expect(cache[cache3DKey]).toBeInstanceOf(WebAssembly.Module); // sibling still cached

        const expect1 = assertWasm4DRouted(t1);
        const expect2 = assertWasm4DRouted(t2);

        // Each Transform has its OWN Instance + memory.
        expect(t1.wasmTetra4D).not.toBe(t2.wasmTetra4D);
        expect(t1.wasmTetra4D.memory).not.toBe(t2.wasmTetra4D.memory);

        const input = buildLargeInputCMYK(2048);
        const o1 = t1.transformArray(input, false, false, false);
        const o2 = t2.transformArray(input, false, false, false);
        expect1(1);
        expect2(1);
        expect(maxAbsDiff(o1, o2).max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 10. Format-tag guardrail still fires for 4D in wasm-scalar mode
    // ---------------------------------------------------------------
    test('format-tag guardrail: wasm-scalar throws on incompatible intLut for 4D', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const wasmT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
        wasmT.create(cmykProfile, '*srgb', eIntent.relative);
        assertWasm4DRouted(wasmT);

        const input = buildLargeInputCMYK(2048);

        // Baseline — valid tag, no throw.
        const before = wasmT.wasmTetra4D.dispatchCount;
        expect(() => wasmT.transformArray(input, false, false, false)).not.toThrow();
        expect(wasmT.wasmTetra4D.dispatchCount).toBe(before + 1);

        // Tag drift → throw (same guardrail as 3D; 4D dispatch fires
        // the check via the same transformArrayViaLUT entry point).
        const savedVersion = wasmT.lut.intLut.version;
        wasmT.lut.intLut.version = 99;
        expect(() => wasmT.transformArray(input, false, false, false))
            .toThrow(/intLut format tag incompatible/);
        wasmT.lut.intLut.version = savedVersion;

        // Restored → works again.
        expect(() => wasmT.transformArray(input, false, false, false)).not.toThrow();
    });


    // ---------------------------------------------------------------
    // 11. 3D RGB pipeline leaves wasmTetra4D untouched
    // ---------------------------------------------------------------
    test('3D RGB pipeline: wasmTetra4D dispatchCount stays at 0 (no cross-contamination)', () => {
        const wasmT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
        wasmT.create('*srgb', '*adobergb', eIntent.relative);

        // 4D state still loaded — it's input-independent — but the
        // dispatcher MUST NOT fire it for RGB-input pipelines.
        expect(wasmT.wasmTetra4D).not.toBeNull();
        expect(wasmT.wasmTetra3D).not.toBeNull();

        const nPixels = 2048;
        const input = new Uint8ClampedArray(nPixels * 3);
        for(let i = 0; i < input.length; i++) input[i] = (i * 37) & 0xff;

        const before3D = wasmT.wasmTetra3D.dispatchCount;
        const before4D = wasmT.wasmTetra4D.dispatchCount;

        wasmT.transformArray(input, false, false, false);

        expect(wasmT.wasmTetra3D.dispatchCount).toBe(before3D + 1);
        expect(wasmT.wasmTetra4D.dispatchCount).toBe(before4D); // untouched
    });


    // ---------------------------------------------------------------
    // 12. Under lutMode='int-wasm-simd', 4D scalar is still loaded
    //     alongside 4D SIMD (diagnostic check — the SIMD 4D suite
    //     covers the SIMD-fires-on-{3,4}-cMax case).
    // ---------------------------------------------------------------
    test('lutMode=int-wasm-simd: both 4D scalar and 4D SIMD states are loaded', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const simdT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        simdT.create(cmykProfile, '*srgb', eIntent.relative);

        // All four WASM states should be loaded under int-wasm-simd.
        expect(simdT.wasmTetra3DSimd).not.toBeNull();
        expect(simdT.wasmTetra3D).not.toBeNull();
        expect(simdT.wasmTetra4DSimd).not.toBeNull();
        expect(simdT.wasmTetra4D).not.toBeNull();
        expect(simdT.lutMode).toBe('int-wasm-simd');

        const nPixels = 2048;
        const input = buildLargeInputCMYK(nPixels);

        const before4DSimd = simdT.wasmTetra4DSimd.dispatchCount;
        const before4D     = simdT.wasmTetra4D.dispatchCount;
        const beforeSimd   = simdT.wasmTetra3DSimd.dispatchCount;
        const before3D     = simdT.wasmTetra3D.dispatchCount;

        const oSimd = simdT.transformArray(input, false, false, false);

        // cMax=3 is a SIMD sweet spot — 4D SIMD fires, everything else sits.
        expect(simdT.wasmTetra4DSimd.dispatchCount).toBe(before4DSimd + 1);
        expect(simdT.wasmTetra4D.dispatchCount).toBe(before4D);
        expect(simdT.wasmTetra3DSimd.dispatchCount).toBe(beforeSimd);
        expect(simdT.wasmTetra3D.dispatchCount).toBe(before3D);

        // Bit-exact vs lutMode='int'.
        const intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        intT.create(cmykProfile, '*srgb', eIntent.relative);
        const oInt = intT.transformArray(input, false, false, false);
        expect(maxAbsDiff(oInt, oSimd).max).toBe(0);
    });

});
