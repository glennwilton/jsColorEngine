/**
 * lutMode='int' integer hot path — accuracy & dispatch tests (v1.1).
 *
 * Coverage matrix:
 *   1. RGB->RGB    (3D 3Ch — int kernel exercised, ≤1 LSB drift)
 *   2. RGB->CMYK   (3D 4Ch — int kernel exercised, ≤2 LSB drift)
 *   3. CMYK->RGB   (4D 3Ch — int kernel exercised, ≤1 LSB drift)
 *   4. CMYK->CMYK  (4D 4Ch — int kernel exercised, ≤1 LSB drift after
 *                   v1.1 u20 single-rounding refactor)
 *   5. Builder gating — intLut present for 3D AND 4D shapes in v1.1
 *   6. Alpha preservation in the 3D 3Ch int kernel
 *   7. Alpha preservation in the 4D 3Ch int kernel (CMYK input)
 *   8. lutMode option parsing — float / int / unknown / undefined
 *   9. intLut format-tag guardrail — transformArrayViaLUT throws on
 *      an incompatible intLut rather than silently producing wrong pixels
 *
 * Accuracy budgets are derived from the bench files:
 *   - bench/int_vs_float.js     (3D, ≤1 LSB at u8)
 *   - bench/int_vs_float_4d.js  (4D, ≤3 LSB at u8 due to extra K-LERP rounding)
 *
 * 4D drift is slightly higher than 3D because the K-axis adds one more
 * integer rounding step. This is well below JND (~5-8 LSB in midtones).
 *
 * `lutMode` is a string enum so future kernels (`'wasm-scalar'`,
 * `'wasm-simd'`, `'auto'`) can be added through the same option without
 * breaking the call signature. Unknown values fall through to `'float'`.
 */
const {Transform, eIntent, eColourType} = require('../src/main');
const Profile = require('../src/Profile');
const path = require('path');

const cmykFilename = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

function maxAbsDiff(a, b){
    if(a.length !== b.length){
        throw new Error('length mismatch ' + a.length + ' vs ' + b.length);
    }
    var max = 0;
    for(var i = 0; i < a.length; i++){
        var d = Math.abs(a[i] - b[i]);
        if(d > max) max = d;
    }
    return max;
}

// Deterministic, well-distributed input — covers cube corners, primaries,
// neutrals, and a few interior random-ish values. 1000 channels (~333 px)
// is enough to exercise all 6 tetrahedral sub-blocks plus the 6 boundary
// patches without making the test slow.
function buildInput3Ch(){
    var arr = [
        // cube corners + primaries first (these stress the boundary patch)
        0,0,0,    255,255,255,
        255,0,0,  0,255,0,    0,0,255,
        255,255,0, 255,0,255, 0,255,255,
        // neutrals
        64,64,64, 128,128,128, 192,192,192,
        // off-axis interior
        200,100,50,  50,100,200,  100,200,50,
        173, 89, 211,  17, 200, 144,  240, 30, 90,
    ];
    var seed = 0x1234;
    while(arr.length < 1000){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        arr.push(seed & 0xff);
    }
    return arr;
}

function buildInput4Ch(){
    var arr = [
        // CMYK extremes
        0,0,0,0,           255,255,255,255,
        // pure inks
        255,0,0,0,   0,255,0,0,   0,0,255,0,   0,0,0,255,
        // overprints
        255,255,0,0,  0,255,255,0,  255,0,255,0,
        // K-axis variations (stresses the K boundary patch + interpK guard)
        100,80,60,0,  100,80,60,128,  100,80,60,255,
        // realistic shadow/midtone/highlight
        20, 40, 80, 5,   80, 60, 30, 120,   30, 90, 180, 60,
    ];
    var seed = 0xabcd;
    while(arr.length < 1000){
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        arr.push(seed & 0xff);
    }
    return arr;
}


// -----------------------------------------------------------------------
// 1. RGB->RGB (3D 3Ch — int kernel)
// -----------------------------------------------------------------------
test("lutMode='int': sRGB->AdobeRGB matches float within 1 LSB", () => {
    var input = buildInput3Ch();

    var floatT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
    floatT.create('*srgb', '*adobergb', eIntent.relative);
    // Requested mode must survive create() — 'float' has no demotion chain.
    expect(floatT.lutMode).toBe('float');
    expect(floatT.lutModeRequested).toBe('float');

    var intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    intT.create('*srgb', '*adobergb', eIntent.relative);
    // 'int' has no demotion chain either; requested === actual after create().
    expect(intT.lutMode).toBe('int');
    expect(intT.lutModeRequested).toBe('int');

    expect(intT.lut.intLut).toBeTruthy();
    expect(intT.lut.intLut.CLUT).toBeInstanceOf(Uint16Array);
    expect(intT.lut.intLut.inputChannels).toBe(3);

    var oFloat = floatT.transformArray(input);
    var oInt   = intT.transformArray(input);

    expect(oInt.length).toBe(oFloat.length);
    expect(maxAbsDiff(oInt, oFloat)).toBeLessThanOrEqual(1);

    // (0,0,0) → (0,0,0) and (255,255,255) → (255,255,255) — boundary patches.
    expect(oInt[0]).toBe(0); expect(oInt[1]).toBe(0); expect(oInt[2]).toBe(0);
    expect(oInt[3]).toBe(255); expect(oInt[4]).toBe(255); expect(oInt[5]).toBe(255);
});


// -----------------------------------------------------------------------
// 2. RGB->CMYK (3D 4Ch — int kernel, real ICC profile)
// -----------------------------------------------------------------------
test("lutMode='int': sRGB->GRACoL CMYK matches float within 2 LSB", async () => {
    var cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);
    expect(cmykProfile.loaded).toBe(true);

    var input = buildInput3Ch();

    var floatT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
    floatT.create('*srgb', cmykProfile, eIntent.relative);
    expect(floatT.lutMode).toBe('float');

    var intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    intT.create('*srgb', cmykProfile, eIntent.relative);
    expect(intT.lutMode).toBe('int');

    expect(intT.lut.intLut).toBeTruthy();
    expect(intT.lut.intLut.outputChannels).toBe(4);
    expect(intT.lut.intLut.inputChannels).toBe(3);

    var oFloat = floatT.transformArray(input);
    var oInt   = intT.transformArray(input);

    expect(oInt.length).toBe(oFloat.length);
    expect(maxAbsDiff(oInt, oFloat)).toBeLessThanOrEqual(2);

    // (255,255,255) sRGB → "paper white" → CMYK 0,0,0,0 — exact corner.
    var paperOffset = 4;
    expect(oInt[paperOffset    ]).toBe(0);
    expect(oInt[paperOffset + 1]).toBe(0);
    expect(oInt[paperOffset + 2]).toBe(0);
    expect(oInt[paperOffset + 3]).toBe(0);
});


// -----------------------------------------------------------------------
// 3. CMYK->RGB (4D 3Ch — int kernel, NEW IN v1.1)
// -----------------------------------------------------------------------
test("lutMode='int': CMYK->sRGB matches float within 1 LSB (4D)", async () => {
    var cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    var input = buildInput4Ch();

    var floatT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
    floatT.create(cmykProfile, '*srgb', eIntent.relative);
    expect(floatT.lutMode).toBe('float');

    var intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    intT.create(cmykProfile, '*srgb', eIntent.relative);
    expect(intT.lutMode).toBe('int');

    // 4D intLut MUST exist now (v1.1 added 4D support).
    expect(intT.lut.intLut).toBeTruthy();
    expect(intT.lut.intLut.inputChannels).toBe(4);
    expect(intT.lut.intLut.outputChannels).toBe(3);
    expect(intT.lut.intLut.maxK).toBeGreaterThan(0);

    var oFloat = floatT.transformArray(input);
    var oInt   = intT.transformArray(input);

    expect(oInt.length).toBe(oFloat.length);
    // 4D 3Ch budget = 1 LSB on GRACoL→sRGB. Two fixes in v1.1 combine
    // to get us here:
    //   1. u16 CLUT scaled by 65280 (= 255*256) instead of 65535, so
    //      u16/256 gives u8 exactly with no +0.4 % systematic high bias.
    //   2. gridPointsScale_fixed carried at Q0.16 (was Q0.8), so the
    //      true (g1-1)/255 ratio is preserved through rx/ry/rz/rk.
    // Without either fix, CMYK→RGB showed up to 3 LSB drift with 100 %
    // of errors going int>float. See src/Transform.js buildIntLut
    // JSDoc and bench/diag_cmyk_to_rgb.js for the diagnostic trail.
    expect(maxAbsDiff(oInt, oFloat)).toBeLessThanOrEqual(1);
});


// -----------------------------------------------------------------------
// 4. CMYK->CMYK (4D 4Ch — int kernel, NEW IN v1.1)
// -----------------------------------------------------------------------
test("lutMode='int': CMYK->CMYK matches float within 1 LSB (4D u20)", async () => {
    var cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    var input = buildInput4Ch();

    var floatT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
    floatT.create(cmykProfile, cmykProfile, eIntent.relative);
    expect(floatT.lutMode).toBe('float');

    var intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    intT.create(cmykProfile, cmykProfile, eIntent.relative);
    expect(intT.lutMode).toBe('int');

    expect(intT.lut.intLut).toBeTruthy();
    expect(intT.lut.intLut.inputChannels).toBe(4);
    expect(intT.lut.intLut.outputChannels).toBe(4);

    var oFloat = floatT.transformArray(input);
    var oInt   = intT.transformArray(input);

    expect(oInt.length).toBe(oFloat.length);
    // v1.1 u20 Q16.4 single-rounding refactor drops the 4D 4Ch budget
    // to ≤1 LSB (was 3 LSB with the old 4-stacked-rounding design).
    // Regression guard: if this starts failing, someone touched the
    // u20 math in tetrahedralInterp4DArray_4Ch_intLut_loop.
    expect(maxAbsDiff(oInt, oFloat)).toBeLessThanOrEqual(1);
});


// -----------------------------------------------------------------------
// 5. Builder gating — intLut present for both 3D and 4D shapes in v1.1
// -----------------------------------------------------------------------
test("lutMode='int': buildIntLut handles all four shapes in v1.1", async () => {
    var cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    // 3D 3Ch — supported
    var t3x3 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    t3x3.create('*srgb', '*adobergb', eIntent.relative);
    expect(t3x3.lutMode).toBe('int');
    expect(t3x3.lut.intLut).toBeTruthy();
    expect(t3x3.lut.intLut.inputChannels).toBe(3);
    expect(t3x3.lut.intLut.outputChannels).toBe(3);
    // Q0.16 precise representation of 32/255 = 0.12549... (was Q0.8 = 32)
    expect(t3x3.lut.intLut.gridPointsScale_fixed).toBe(8224);

    // Format tag — bump these when the encoding changes (see buildIntLut
    // comment block). Keeping them as hard asserts means any accidental
    // drift lights up red in CI rather than silently shipping broken
    // integer output.
    expect(t3x3.lut.intLut.version).toBe(1);
    expect(t3x3.lut.intLut.dataType).toBe('u16');
    expect(t3x3.lut.intLut.scale).toBe(65280);
    expect(t3x3.lut.intLut.gpsPrecisionBits).toBe(16);
    expect(t3x3.lut.intLut.accWidth).toBe(16);        // 3D uses u16 acc
    expect(t3x3.isIntLutCompatible(t3x3.lut.intLut)).toBe(true);

    // Outer float LUT also carries a dataType tag for inspection — this
    // is informational (not enforced at dispatch) but must be consistent
    // with the `Float64Array` CLUT that createLut() actually produces.
    expect(t3x3.lut.dataType).toBe('f64');
    expect(t3x3.lut.CLUT).toBeInstanceOf(Float64Array);

    // Simulated stale / foreign intLut — the compatibility helper must
    // reject these so any future deserialization path has a clear fail.
    expect(t3x3.isIntLutCompatible(null)).toBe(false);
    expect(t3x3.isIntLutCompatible({...t3x3.lut.intLut, version: 2})).toBe(false);
    expect(t3x3.isIntLutCompatible({...t3x3.lut.intLut, scale: 65535})).toBe(false);
    expect(t3x3.isIntLutCompatible({...t3x3.lut.intLut, gpsPrecisionBits: 8})).toBe(false);
    expect(t3x3.isIntLutCompatible({...t3x3.lut.intLut, dataType: 'f32'})).toBe(false);

    // 3D 4Ch — supported
    var t3x4 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    t3x4.create('*srgb', cmykProfile, eIntent.relative);
    expect(t3x4.lutMode).toBe('int');
    expect(t3x4.lut.intLut).toBeTruthy();
    expect(t3x4.lut.intLut.inputChannels).toBe(3);
    expect(t3x4.lut.intLut.outputChannels).toBe(4);

    // 4D 3Ch — supported (NEW in v1.1)
    var t4x3 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    t4x3.create(cmykProfile, '*srgb', eIntent.relative);
    expect(t4x3.lutMode).toBe('int');
    expect(t4x3.lut.intLut).toBeTruthy();
    expect(t4x3.lut.intLut.inputChannels).toBe(4);
    expect(t4x3.lut.intLut.outputChannels).toBe(3);
    expect(t4x3.lut.intLut.maxK).toBeGreaterThan(0);

    // 4D 4Ch — supported (NEW in v1.1)
    var t4x4 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    t4x4.create(cmykProfile, cmykProfile, eIntent.relative);
    expect(t4x4.lutMode).toBe('int');
    expect(t4x4.lut.intLut).toBeTruthy();
    expect(t4x4.lut.intLut.inputChannels).toBe(4);
    expect(t4x4.lut.intLut.outputChannels).toBe(4);
    // 4D kernels widen the accumulator to u20 (Q16.4) for single-rounding
    expect(t4x4.lut.intLut.accWidth).toBe(20);

    // explicit lutMode='float' — must NOT build intLut; lutMode stays 'float'.
    var tFloat = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
    tFloat.create('*srgb', '*adobergb', eIntent.relative);
    expect(tFloat.lutMode).toBe('float');
    expect(tFloat.lut.intLut).toBeUndefined();

    // dataFormat NOT int8 — must NOT build intLut even with lutMode='int'.
    // Note: lutMode stays 'int' (the property reflects the user's request),
    // but since intLut is undefined the dispatcher will fall through to the
    // float kernel at call time. The dispatcher check is tested by
    // "dispatcher throws on incompatible intLut tag" below.
    var tObj = new Transform({dataFormat: 'object', buildLut: true, lutMode: 'int'});
    tObj.create('*srgb', '*adobergb', eIntent.relative);
    expect(tObj.lut.intLut).toBeUndefined();
});


// -----------------------------------------------------------------------
// 6. Alpha preservation in the 3D 3Ch int kernel
// -----------------------------------------------------------------------
test("lutMode='int': preserveAlpha works in 3D 3Ch kernel", () => {
    var intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    intT.create('*srgb', '*adobergb', eIntent.relative);
    expect(intT.lutMode).toBe('int');

    var input = [
        255,   0,   0, 11,
          0, 255,   0, 47,
          0,   0, 255, 99,
        128, 128, 128, 200
    ];
    var output = intT.transformArray(input, true, true, true);

    expect(output.length).toBe(16);
    expect(output[3]).toBe(11);
    expect(output[7]).toBe(47);
    expect(output[11]).toBe(99);
    expect(output[15]).toBe(200);

    // Sanity: gray maps to gray (small drift OK).
    expect(Math.abs(output[12] - output[13])).toBeLessThanOrEqual(1);
    expect(Math.abs(output[13] - output[14])).toBeLessThanOrEqual(1);
});


// -----------------------------------------------------------------------
// 7. Alpha preservation in the 4D 3Ch int kernel (CMYK input — NEW v1.1)
// -----------------------------------------------------------------------
test("lutMode='int': preserveAlpha works in 4D 3Ch kernel (CMYK->RGB)", async () => {
    var cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    var intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    intT.create(cmykProfile, '*srgb', eIntent.relative);
    expect(intT.lutMode).toBe('int');

    // CMYKA input, 4 pixels with distinct alpha values.
    var input = [
          0,   0,   0,   0,  11,   // paper white + alpha
        255,   0,   0,   0,  47,   // pure cyan + alpha
          0, 255,   0, 128,  99,   // M+50%K + alpha
         50,  40,  30,  20, 200,   // realistic + alpha
    ];
    var output = intT.transformArray(input, true, true, true);

    // 4 pixels × (3 RGB + 1 alpha) = 16 channels out
    expect(output.length).toBe(16);
    expect(output[3]).toBe(11);
    expect(output[7]).toBe(47);
    expect(output[11]).toBe(99);
    expect(output[15]).toBe(200);
});


// -----------------------------------------------------------------------
// 8. lutMode option parsing — v1.2+: 'auto' is the default
// -----------------------------------------------------------------------
test("lutMode: option parsing — 'auto' default, resolution rule, valid values", () => {
    // default (omitted) + int8 + buildLut=true → resolves to 'int-wasm-simd'
    // (then demotes to scalar/int/float at create() time if the host lacks
    // WASM or SIMD — not covered by this test; see transform_lutMode_wasm_*
    // test files for demotion behaviour).
    var tDefaultInt8 = new Transform({dataFormat: 'int8', buildLut: true});
    expect(tDefaultInt8.lutMode).toBe('int-wasm-simd');
    expect(tDefaultInt8.lutModeRequested).toBe('auto');

    // default (omitted) + dataFormat NOT int8 → resolves to 'float'
    var tDefaultObj = new Transform({dataFormat: 'object', buildLut: true});
    expect(tDefaultObj.lutMode).toBe('float');
    expect(tDefaultObj.lutModeRequested).toBe('auto');

    // default (omitted) + buildLut=false → resolves to 'float'
    // (no LUT will be built, so the LUT kernel selector is irrelevant;
    //  'float' is the honest answer for what will run)
    var tDefaultNoLut = new Transform({dataFormat: 'int8'});
    expect(tDefaultNoLut.lutMode).toBe('float');
    expect(tDefaultNoLut.lutModeRequested).toBe('auto');

    // explicit 'auto' — same resolution as omitted default
    var tAuto = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'auto'});
    expect(tAuto.lutMode).toBe('int-wasm-simd');
    expect(tAuto.lutModeRequested).toBe('auto');

    // explicit 'float' — pinned, no auto-resolution
    var tFloat = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
    expect(tFloat.lutMode).toBe('float');
    expect(tFloat.lutModeRequested).toBe('float');

    // explicit 'int' — pinned
    var tInt = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    expect(tInt.lutMode).toBe('int');
    expect(tInt.lutModeRequested).toBe('int');

    // explicit 'int-wasm-scalar' — pinned
    var tScalar = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar'});
    expect(tScalar.lutMode).toBe('int-wasm-scalar');
    expect(tScalar.lutModeRequested).toBe('int-wasm-scalar');

    // explicit 'int-wasm-simd' — pinned
    var tSimd = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
    expect(tSimd.lutMode).toBe('int-wasm-simd');
    expect(tSimd.lutModeRequested).toBe('int-wasm-simd');

    // unknown value (typo) on an int8+LUT transform → auto-resolution
    // ('int-wasm-simd'). Previously fell back to 'float'; the new
    // behaviour is strictly better for "someone wrote lutMode: 'turbojet'"
    // because they almost certainly meant "fast".
    var tBogus = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'turbojet'});
    expect(tBogus.lutMode).toBe('int-wasm-simd');
    expect(tBogus.lutModeRequested).toBe('auto');

    // unknown value on a non-LUT transform → auto-resolution ('float').
    var tBogusObj = new Transform({dataFormat: 'object', buildLut: true, lutMode: 'turbojet'});
    expect(tBogusObj.lutMode).toBe('float');
    expect(tBogusObj.lutModeRequested).toBe('auto');

    // future modes that don't exist yet — also auto-resolve. A user
    // setting `lutMode: 'wasm-simd'` against this version doesn't crash
    // and gets the best available kernel for their (dataFormat, buildLut).
    var tFutureInt8 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'wasm-simd'});
    expect(tFutureInt8.lutMode).toBe('int-wasm-simd');
    expect(tFutureInt8.lutModeRequested).toBe('auto');
});


// -----------------------------------------------------------------------
// 8b. lutMode='auto' end-to-end — survives create() through the full
//     demotion chain, produces correct output, and `xform.lutMode`
//     accurately reflects the kernel that actually runs afterwards.
//
// The earlier "option parsing" test asserts constructor-time resolution.
// This one asserts that `create()` doesn't silently undo that resolution
// on a host where the initial pick (int-wasm-simd) is available — and
// that what `xform.lutMode` reports is honest.
// -----------------------------------------------------------------------
test("lutMode='auto': survives create() across all four directions", async () => {
    var cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    var input3 = buildInput3Ch();
    var input4 = buildInput4Ch();

    // All four directions through 'auto' on int8+LUT. On this host (Node
    // 20 / V8 with SIMD) 'auto' resolves to 'int-wasm-simd' and stays
    // there through create(). On a non-SIMD host the demotion chain
    // would land on 'int-wasm-scalar' / 'int' — that's covered by
    // transform_lutMode_wasm{,_simd}{,_4d}.tests.js. Here we just assert
    // the default path is healthy.
    var directions = [
        {label: 'RGB->RGB',   src: '*srgb',      dst: '*adobergb',  input: input3},
        {label: 'RGB->CMYK',  src: '*srgb',      dst: cmykProfile,  input: input3},
        {label: 'CMYK->RGB',  src: cmykProfile,  dst: '*srgb',      input: input4},
        {label: 'CMYK->CMYK', src: cmykProfile,  dst: cmykProfile,  input: input4},
    ];

    for(var i = 0; i < directions.length; i++){
        var d = directions[i];

        var autoT = new Transform({dataFormat: 'int8', buildLut: true}); // 'auto' is implicit
        expect(autoT.lutMode).toBe('int-wasm-simd');   // constructor-time resolution
        expect(autoT.lutModeRequested).toBe('auto');

        autoT.create(d.src, d.dst, eIntent.relative);

        // After create(), the SIMD kernel module must have loaded (on any
        // modern host). If it demoted silently this test catches it —
        // which is the whole point of the user's "inspect lutMode after
        // create" ask.
        expect(autoT.lutMode).toBe('int-wasm-simd');
        expect(autoT.lutModeRequested).toBe('auto');

        // intLut must exist — SIMD kernel reads the same u16 mirror LUT
        // the 'int' kernel does.
        expect(autoT.lut.intLut).toBeTruthy();

        // Against the pinned 'float' reference, the 'auto' (SIMD) kernel
        // must produce output within the ≤ 2 LSB integer-kernel budget.
        // We intentionally don't compare against 'int-wasm-simd' pinned
        // — the dedicated WASM/SIMD test files do the bit-exactness work.
        // This test's job is "did auto route us to the right place?", not
        // "is the SIMD kernel correct?".
        var floatT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
        floatT.create(d.src, d.dst, eIntent.relative);
        expect(floatT.lutMode).toBe('float');

        var oAuto = autoT.transformArray(d.input);
        var oFloat = floatT.transformArray(d.input);
        expect(oAuto.length).toBe(oFloat.length);
        expect(maxAbsDiff(oAuto, oFloat)).toBeLessThanOrEqual(2);   // integer-kernel budget
    }
});

// Separately: 'auto' on a non-int8 Transform resolves to 'float' and
// that survives create() too. Covers the branch where auto routes away
// from the WASM kernels because the dataFormat doesn't support them.
test("lutMode='auto': non-int8 transform resolves to 'float' and stays there", () => {
    var autoObj = new Transform({dataFormat: 'object', buildLut: true});
    expect(autoObj.lutMode).toBe('float');
    expect(autoObj.lutModeRequested).toBe('auto');

    autoObj.create('*srgb', '*adobergb', eIntent.relative);
    expect(autoObj.lutMode).toBe('float');
    expect(autoObj.lutModeRequested).toBe('auto');

    // No intLut built (float kernel doesn't need it)
    expect(autoObj.lut.intLut).toBeUndefined();

    // Float kernel reads the f64 CLUT that create() always builds for
    // buildLut: true transforms.
    expect(autoObj.lut).toBeTruthy();
    expect(autoObj.lut.CLUT).toBeInstanceOf(Float64Array);

    // Smoke — round-trip a single RGB through the object interface so
    // we know the float kernel actually runs.
    var out = autoObj.transform({R: 128, G: 128, B: 128, type: eColourType.RGB});
    expect(out).toBeTruthy();
    expect(typeof out.R).toBe('number');
    expect(typeof out.G).toBe('number');
    expect(typeof out.B).toBe('number');
});


// -----------------------------------------------------------------------
// 9. intLut format-tag guardrail
//
// The dispatcher in `transformArrayViaLUT` calls `isIntLutCompatible()`
// once per array call (cheap — not per pixel) and throws if the tag has
// drifted. The alternative — silent fallback to float — would hide the
// bug while making the transform mysteriously slower, which is exactly
// what the format tag was added to prevent.
//
// We simulate drift by mutating the tag on an otherwise-valid intLut,
// which is what a stale serialised cache from a future version would
// look like.
// -----------------------------------------------------------------------
test("lutMode='int': dispatcher throws on incompatible intLut tag", () => {
    var intT = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
    intT.create('*srgb', '*adobergb', eIntent.relative);

    var input = [255, 0, 0, 0, 255, 0, 0, 0, 255];

    // Baseline — unmutated tag should transform without throwing.
    expect(() => intT.transformArray(input, false, false, false)).not.toThrow();

    // Simulate a future version's intLut ending up here (e.g. persisted
    // by a v1.2 WASM build and loaded into a v1.1 engine).
    var savedVersion = intT.lut.intLut.version;
    intT.lut.intLut.version = 99;
    expect(() => intT.transformArray(input, false, false, false))
        .toThrow(/intLut format tag incompatible/);
    intT.lut.intLut.version = savedVersion;

    // Simulate a scale drift (e.g. someone rebuilt with the old 65535
    // factor that caused the +0.4 % bias fix).
    var savedScale = intT.lut.intLut.scale;
    intT.lut.intLut.scale = 65535;
    expect(() => intT.transformArray(input, false, false, false))
        .toThrow(/intLut format tag incompatible/);
    intT.lut.intLut.scale = savedScale;

    // Simulate a Q0.8 gps drift (the pre-v1.1 bias bug).
    var savedGps = intT.lut.intLut.gpsPrecisionBits;
    intT.lut.intLut.gpsPrecisionBits = 8;
    expect(() => intT.transformArray(input, false, false, false))
        .toThrow(/intLut format tag incompatible/);
    intT.lut.intLut.gpsPrecisionBits = savedGps;

    // Simulate a dataType drift (e.g. a future f32 CLUT variant loaded
    // into kernels that still expect u16).
    var savedType = intT.lut.intLut.dataType;
    intT.lut.intLut.dataType = 'f32';
    expect(() => intT.transformArray(input, false, false, false))
        .toThrow(/intLut format tag incompatible/);
    intT.lut.intLut.dataType = savedType;

    // After restoring everything, the transform works again — proves the
    // failure mode is strictly tag-based, not some side-effect of the
    // first call.
    expect(() => intT.transformArray(input, false, false, false)).not.toThrow();
});
