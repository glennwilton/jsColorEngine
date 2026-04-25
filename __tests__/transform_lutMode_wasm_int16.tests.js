/**
 * lutMode='int16-wasm-scalar' — WASM u16 tetrahedral dispatcher tests
 * (v1.3). Covers BOTH the 3D RGB-input and 4D CMYK-input WASM kernels.
 *
 * v1.3 STATUS — SHIPPED.
 *   The shipped tetra3d_nch_int16.wat / tetra4d_nch_int16.wat were
 *   redesigned for true 16-bit precision in v1.3: Q0.13 fractional
 *   weights (settled at Q0.13 over a brief internal Q0.12 iteration),
 *   full-range u16 CLUT (scale 65535), single rounding for 3D and
 *   TWO-ROUNDING for 4D (XYZ→u16 at K0, XYZ→u16 at K1, then
 *   K-LERP→u16). The dispatcher gates `needsWasm{3D,4D}Int16` are
 *   wired in src/lutKernelTable.js so int16-wasm-scalar mode routes
 *   straight to the WASM kernel.
 *
 * Coverage matrix:
 *   1.  Option parsing — 'int16-wasm-scalar' is accepted as a valid lutMode
 *   2.  create() populates wasmTetra3DInt16 + wasmTetra4DInt16 for an
 *       RGB pipeline (no silent demotion to JS 'int16')
 *   3.  RGB→RGB 3D 3Ch (u16 I/O) — bit-exact against lutMode='int16',
 *       3D WASM dispatched, 4D WASM not touched
 *   4.  RGB→CMYK 3D 4Ch (u16 I/O) — bit-exact against lutMode='int16'
 *       (real ICC GRACoL profile), 3D WASM dispatched
 *   5.  Below-threshold pixelCount falls back to JS for both 3D and 4D,
 *       both dispatchCounts stay flat (and outputs still bit-exact)
 *   6.  4D CMYK→RGB (u16 I/O) — bit-exact against lutMode='int16';
 *       4D WASM dispatched (NOT 3D — cross-contamination guardrail)
 *   7.  Format-tag guardrail still fires on incompatible intLut
 *   8.  Shared wasmCache reuses the compiled int16 Modules across
 *       Transforms (both 3D and 4D module keys)
 *   9.  'auto' + dataFormat='int16' + buildLut resolves to
 *       'int16-wasm-scalar' (default routing assertion)
 *
 * Why bit-exact is the right bar:
 *   The v1.3 int16 WASM kernels are line-by-line ports of the v1.3 JS
 *   `tetrahedralInterp{3,4}DArray_{3,4}Ch_intLut16_loop` — same Q0.13
 *   gps, same scale-65535 u16 CLUT, same `(sum + 0x1000) >> 13`
 *   rounding, same two-rounding K-LERP for 4D. JS uses Math.imul; WASM
 *   uses i32.mul; both wrap mod 2^32 the same way, which guarantees
 *   bit-exactness across V8/JSC/SpiderMonkey/any compliant WASM host.
 *   Any drift from the JS int16 sibling is a kernel bug, not a tolerance.
 *
 * Skip strategy mirrors the u8 wasm tests (SKIP_WASM_TESTS=1).
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

// Hard assertion that a Transform is actually routing through the int16
// WASM kernel, not silently demoted to the JS 'int16' fallback.
function assertWasmInt16Routed(t){
    expect(t.lutMode).toBe('int16-wasm-scalar');
    expect(t.wasmTetra3DInt16).not.toBeNull();
    const before = t.wasmTetra3DInt16.dispatchCount;
    return function expectDispatched(delta){
        if(delta === undefined) delta = 1;
        const after = t.wasmTetra3DInt16.dispatchCount;
        expect(after - before).toBe(delta);
    };
}

// Build a 1 MPx u16 RGB input — guarantees pixelCount >= WASM_DISPATCH_MIN_PIXELS
// without needing to know the exact threshold.
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


describeIfWasm('lutMode=int16-wasm-scalar — v1.3 WASM int16 dispatcher', () => {

    // ---------------------------------------------------------------
    // 1. Option parsing
    // ---------------------------------------------------------------
    test('option parsing: int16-wasm-scalar is accepted as a valid lutMode', () => {
        const t = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-scalar'});
        expect(t.lutMode).toBe('int16-wasm-scalar');
        expect(t.wasmTetra3DInt16).toBeNull(); // not loaded until create()

        const bag = {};
        const t2 = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-scalar', wasmCache: bag});
        expect(t2.wasmCache).toBe(bag);
    });


    // ---------------------------------------------------------------
    // 2. create() populates wasmTetra3DInt16 + wasmTetra4DInt16
    // ---------------------------------------------------------------
    test('create(): wasmTetra3DInt16 + wasmTetra4DInt16 are populated for a real RGB pipeline (no silent demotion)', () => {
        const t = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-scalar'});
        t.create('*srgb', '*adobergb', eIntent.relative);

        // Hard guarantees — fail fast if WASM didn't actually load.
        expect(t.wasmTetra3DInt16).not.toBeNull();
        expect(t.wasmTetra4DInt16).not.toBeNull();   // both u16 modules eagerly loaded
        expect(t.lutMode).toBe('int16-wasm-scalar'); // no demotion since WASM is available
        expect(typeof t.wasmTetra3DInt16.kernel).toBe('function');
        expect(typeof t.wasmTetra4DInt16.kernel).toBe('function');
        expect(t.wasmTetra3DInt16.memory).toBeInstanceOf(WebAssembly.Memory);
        expect(t.wasmTetra4DInt16.memory).toBeInstanceOf(WebAssembly.Memory);

        expect(t.lut.intLut).toBeTruthy();
        expect(t.lut.intLut.gridPointsScale_fixed_u16).toBeGreaterThan(0);
        expect(t.wasmTetra3DInt16.dispatchCount).toBe(0);
        expect(t.wasmTetra4DInt16.dispatchCount).toBe(0);
    });


    // ---------------------------------------------------------------
    // 3. RGB → RGB bit-exact vs lutMode='int16'
    // ---------------------------------------------------------------
    test('RGB→RGB 3D 3Ch (u16): bit-exact against lutMode=int16', () => {
        const nPixels = 1 << 20;
        const input = buildLargeInputRGB16(nPixels);

        const jsT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16'});
        jsT.create('*srgb', '*adobergb', eIntent.relative);

        const wasmT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-scalar'});
        wasmT.create('*srgb', '*adobergb', eIntent.relative);

        const expectDispatched = assertWasmInt16Routed(wasmT);

        const oJs   = jsT.transformArray(input, false, false, false);
        const oWasm = wasmT.transformArray(input, false, false, false);

        expectDispatched(1);

        // Sanity: outputs are u16 (Uint16Array) on both paths
        expect(oJs).toBeInstanceOf(Uint16Array);
        expect(oWasm).toBeInstanceOf(Uint16Array);

        const d = maxAbsDiff(oJs, oWasm);
        if(d.max !== 0){
            const px = (d.firstDiffIdx / 3) | 0;
            throw new Error('WASM int16 diverged from JS int16 at pixel ' + px +
                ' ch ' + (d.firstDiffIdx % 3) + ' (JS=' + d.A + ' WASM=' + d.B + ')');
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

        const wasmT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-scalar'});
        wasmT.create('*srgb', cmykProfile, eIntent.relative);

        expect(wasmT.lut.intLut.outputChannels).toBe(4);
        const expectDispatched = assertWasmInt16Routed(wasmT);

        const oJs   = jsT.transformArray(input, false, false, false);
        const oWasm = wasmT.transformArray(input, false, false, false);

        expectDispatched(1);

        const d = maxAbsDiff(oJs, oWasm);
        expect(d.max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 5. Below WASM_DISPATCH_MIN_PIXELS: JS fallback, counter stays flat
    // ---------------------------------------------------------------
    test('below WASM_DISPATCH_MIN_PIXELS: falls back to JS int16, dispatchCount does NOT advance', () => {
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

        const wasmT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-scalar'});
        wasmT.create('*srgb', '*adobergb', eIntent.relative);

        expect(wasmT.lutMode).toBe('int16-wasm-scalar'); // stays at requested mode
        const before = wasmT.wasmTetra3DInt16.dispatchCount;

        const oJs   = jsT.transformArray(input, false, false, false);
        const oWasm = wasmT.transformArray(input, false, false, false);

        // Counter MUST NOT have advanced — proves the gate fired
        expect(wasmT.wasmTetra3DInt16.dispatchCount).toBe(before);

        const d = maxAbsDiff(oJs, oWasm);
        expect(d.max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 6. 4D CMYK→RGB (u16): 4D WASM kernel dispatched, bit-exact vs JS
    //                       int16; 3D WASM counter stays flat (cross-
    //                       contamination guardrail)
    // ---------------------------------------------------------------
    test('4D CMYK→RGB (u16): 4D WASM dispatched, bit-exact vs JS int16; 3D WASM counter stays flat', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        const nPixels = 1 << 17; // 128k — well above threshold
        const input = buildLargeInputCMYK16(nPixels);

        const jsT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16'});
        jsT.create(cmykProfile, '*srgb', eIntent.relative);

        const wasmT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-scalar'});
        wasmT.create(cmykProfile, '*srgb', eIntent.relative);

        // Both 3D and 4D u16 modules are loaded at create() time
        // (Transform-level resources, not per-call). The dispatcher
        // routes by inputChannels; 4D=CMYK → wasmTetra4DInt16.
        expect(wasmT.wasmTetra3DInt16).not.toBeNull();
        expect(wasmT.wasmTetra4DInt16).not.toBeNull();
        expect(wasmT.lut.intLut.inputChannels).toBe(4);

        const before3D = wasmT.wasmTetra3DInt16.dispatchCount;
        const before4D = wasmT.wasmTetra4DInt16.dispatchCount;

        const oJs   = jsT.transformArray(input, false, false, false);
        const oWasm = wasmT.transformArray(input, false, false, false);

        // The 4D u16 WASM kernel WAS invoked for CMYK input...
        expect(wasmT.wasmTetra4DInt16.dispatchCount).toBe(before4D + 1);
        // ...and the 3D u16 WASM kernel was NOT (cross-contamination
        // guardrail: a 4D pipeline must never silently route through
        // a 3D kernel even when both states are loaded).
        expect(wasmT.wasmTetra3DInt16.dispatchCount).toBe(before3D);

        // u16 outputs on both sides
        expect(oJs).toBeInstanceOf(Uint16Array);
        expect(oWasm).toBeInstanceOf(Uint16Array);

        const d = maxAbsDiff(oJs, oWasm);
        if(d.max !== 0){
            const px = (d.firstDiffIdx / wasmT.lut.intLut.outputChannels) | 0;
            throw new Error('4D WASM int16 diverged from JS int16 at pixel ' + px +
                ' ch ' + (d.firstDiffIdx % wasmT.lut.intLut.outputChannels) +
                ' (JS=' + d.A + ' WASM=' + d.B + ')');
        }
        expect(d.max).toBe(0);
    });

    // ---------------------------------------------------------------
    // 6b. 4D CMYK→RGB (u16) below threshold: JS fallback, 4D counter
    //                                         stays flat
    // ---------------------------------------------------------------
    test('4D CMYK→RGB (u16) below WASM_DISPATCH_MIN_PIXELS: falls back to JS int16; 4D counter stays flat', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);

        // Below the dispatch threshold so the WASM gate misses
        const nPixels = 8;
        const input = buildLargeInputCMYK16(nPixels);
        expect(nPixels).toBeLessThan(Transform.WASM_DISPATCH_MIN_PIXELS);

        const jsT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16'});
        jsT.create(cmykProfile, '*srgb', eIntent.relative);

        const wasmT = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-scalar'});
        wasmT.create(cmykProfile, '*srgb', eIntent.relative);

        const before4D = wasmT.wasmTetra4DInt16.dispatchCount;

        const oJs   = jsT.transformArray(input, false, false, false);
        const oWasm = wasmT.transformArray(input, false, false, false);

        // Counter MUST NOT have advanced — proves the threshold gate fired
        // and the JS int16 4D kernel handled the call.
        expect(wasmT.wasmTetra4DInt16.dispatchCount).toBe(before4D);

        const d = maxAbsDiff(oJs, oWasm);
        expect(d.max).toBe(0);
    });


    // ---------------------------------------------------------------
    // 7. Format-tag guardrail still fires
    // ---------------------------------------------------------------
    test('format-tag guardrail: int16-wasm-scalar throws on incompatible intLut', () => {
        const t = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-scalar'});
        t.create('*srgb', '*adobergb', eIntent.relative);

        // Tamper with the intLut tag (simulate a foreign serialised LUT)
        t.lut.intLut.version = 999;

        const input = buildLargeInputRGB16(1024);
        expect(() => t.transformArray(input, false, false, false)).toThrow(/intLut format tag incompatible/);
    });


    // ---------------------------------------------------------------
    // 8. Shared wasmCache reuses the compiled int16 Module
    // ---------------------------------------------------------------
    test('shared wasmCache: two Transforms reuse the compiled int16 Module', () => {
        const cache = {};

        const t1 = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-scalar', wasmCache: cache});
        t1.create('*srgb', '*adobergb', eIntent.relative);

        // After the first create(), the int16 module key is in the cache
        const cacheKeyAfter1 = Object.keys(cache).filter(k => k.indexOf('int16') !== -1);
        expect(cacheKeyAfter1.length).toBeGreaterThan(0);
        const moduleAfter1 = cache[cacheKeyAfter1[0]];
        expect(moduleAfter1).toBeInstanceOf(WebAssembly.Module);

        const t2 = new Transform({dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-scalar', wasmCache: cache});
        t2.create('*srgb', '*adobergb', eIntent.relative);

        // Same Module reference — the second Transform reused the cache
        expect(cache[cacheKeyAfter1[0]]).toBe(moduleAfter1);

        // But each Transform has its own Instance / state object
        expect(t1.wasmTetra3DInt16).not.toBe(t2.wasmTetra3DInt16);
        expect(t1.wasmTetra3DInt16.memory).not.toBe(t2.wasmTetra3DInt16.memory);
    });


    // ---------------------------------------------------------------
    // 9. 'auto' + dataFormat='int16' + buildLut resolves to int16-wasm-simd
    //    (v1.3 — was int16-wasm-scalar mid-development pre-SIMD; SIMD is
    //    now the default since it's bit-exact with scalar and faster).
    // ---------------------------------------------------------------
    test("'auto' + dataFormat='int16' + buildLut resolves to int16-wasm-simd (v1.3)", () => {
        const t = new Transform({dataFormat: 'int16', buildLut: true /* lutMode defaults to 'auto' */});
        expect(t.lutModeRequested).toBe('auto');
        expect(t.lutMode).toBe('int16-wasm-simd');

        // After create() it should remain int16-wasm-simd (no demotion
        // since WASM SIMD is available on Node 16+) and the SIMD u16
        // states should be populated alongside scalar fallthroughs.
        t.create('*srgb', '*adobergb', eIntent.relative);
        expect(t.lutMode).toBe('int16-wasm-simd');
        expect(t.wasmTetra3DInt16Simd).not.toBeNull();
        expect(t.wasmTetra3DInt16).not.toBeNull();    // scalar fallthrough loaded too
    });

});
