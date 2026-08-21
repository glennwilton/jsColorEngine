/**
 * The RGB->RGB matrix-shaper WASM kernel.
 *
 * An RGB matrix-shaper conversion is a curve, a 3x3 and another curve. The
 * generic pipeline walks that stage by stage in JS at ~8 MPx/s; this kernel
 * does the same arithmetic in WASM SIMD at 331 MPx/s, which is also 2.7x the
 * 3D CLUT path it can replace on photographic content.
 *
 * THE REFERENCE IS THE PIPELINE IT REPLACES. Every accuracy test here compares
 * against the same Transform with the kernel forced off, so the comparison is
 * against the exact stage-by-stage arithmetic and not against another
 * approximation. The bound asserted is 1 LSB, which is what the engine's LUT
 * paths already promise — and the kernel is measured at 0.000% of samples
 * exceeding it, not merely at the bound.
 */

const path = require('path');
const { Transform, eIntent, convert } = require('../src/main');
const Profile = require('../src/Profile');
const matrixShaper = require('../src/kernels/matrixShaper/matrixShaperKernel');

const CMYK = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

/** A Transform that will use the kernel. */
function accelerated(a, b, opts){
    const t = new Transform(Object.assign({dataFormat: 'int8', buildLut: false}, opts || {}));
    t.create(a, b, eIntent.relative);
    return t;
}

/**
 * The same conversion with the kernel off — the reference.
 * `wasmMatrixShaper: false` is a supported mode precisely so comparisons like this
 * do not have to reach into private state.
 */
function reference(a, b, opts){
    const t = new Transform(Object.assign(
        {dataFormat: 'int8', buildLut: false, wasmMatrixShaper: false}, opts || {}));
    t.create(a, b, eIntent.relative);
    return t;
}

/** A 64^3 sweep of the input cube: 262,144 colours, every eighth level. */
function cube(){
    const n = 64 * 64 * 64;
    const px = new Uint8ClampedArray(n * 3);
    let p = 0;
    for(let r = 0; r < 256; r += 4)
        for(let g = 0; g < 256; g += 4)
            for(let b = 0; b < 256; b += 4){ px[p++] = r; px[p++] = g; px[p++] = b; }
    return { data: px, pixelCount: n };
}

/** Assert "within 1 LSB" while still reporting what it actually was. */
function expectWithin1LSB(label, r){
    expect(`${label}: max ${r.max} LSB, ${r.over} over`)
        .toBe(r.max <= 1 && r.over === 0
            ? `${label}: max ${r.max} LSB, ${r.over} over`
            : `${label}: within 1 LSB, 0 over`);
}

/**
 * Did the matrix-shaper kernel actually run this transform?
 *
 * `claimed` is decided at create(); `built` only becomes true once a batch call
 * has forced the lazy table build. Both matter, and asking through the public
 * kernelInfo() rather than a private field means these tests exercise the same
 * surface a caller would use to answer the question.
 */
function kernelRan(t){
    const info = t.kernelInfo();
    return !!(info && info.name === 'matrix-shaper' && info.claimed && info.built);
}

/** Claimed at create(), whether or not it has been used yet. */
function kernelClaimed(t){
    const info = t.kernelInfo();
    return !!(info && info.name === 'matrix-shaper' && info.claimed);
}

function compare(got, expected){
    let max = 0, over = 0, sum = 0;
    for(let i = 0; i < expected.length; i++){
        const d = Math.abs(got[i] - expected[i]);
        if(d > max) max = d;
        if(d > 1) over++;
        sum += d;
    }
    return { max, over, mean: sum / expected.length };
}

const PAIRS = [
    ['*sRGB', '*AdobeRGB'],
    ['*AdobeRGB', '*sRGB'],
    ['*sRGB', '*prophoto'],
    ['*prophoto', '*sRGB'],
    ['*sRGB', '*applergb'],
    ['*sRGB', '*colormatch'],
];

describe('matrix-shaper kernel — accuracy against the pipeline it replaces', () => {

    jest.setTimeout(120000);

    const img = cube();

    for(const [a, b] of PAIRS){
        test(`${a} -> ${b}: within 1 LSB over 262,144 colours`, () => {
            const fast = accelerated(a, b);
            expect(kernelClaimed(fast)).toBe(true);            // it must actually engage

            const ref = reference(a, b);
            const expected = ref.transformArray(img.data, false, false, false, img.pixelCount);
            const got = fast.transformArray(img.data, false, false, false, img.pixelCount);

            expect(got.length).toBe(expected.length);
            const r = compare(got, expected);
            // Reported in the message so a regression says how far off it went.
            expectWithin1LSB(`${a} -> ${b}`, r);
            expect(r.mean).toBeLessThan(0.01);
        });
    }

    test('the kernel is what produced those results, not a silent fallback', () => {
        // If the kernel quietly stopped engaging, every accuracy test above
        // would still pass — by comparing the pipeline against itself.
        const fast = accelerated('*sRGB', '*AdobeRGB');
        const px = new Uint8ClampedArray([10, 20, 30, 200, 100, 50]);
        fast.transformArray(px, false, false, false, 2);
        expect(kernelRan(fast)).toBe(true);
        expect(typeof fast.kernel.array).toBe('function');
    });
});

describe('matrix-shaper kernel — when it declines', () => {

    jest.setTimeout(120000);

    // Declining is normal rather than a failure, so each case reports WHY.
    test('declines when a LUT was built — the CLUT path owns that', () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        expect(matrixShaper.inspect(t).ok).toBe(false);
        expect(matrixShaper.inspect(t).why).toMatch(/LUT/);
    });

    test('declines a non-RGB destination', () => {
        const cmyk = new Profile(); cmyk.loadFile(CMYK);
        const t = new Transform({dataFormat: 'int8', buildLut: false});
        t.create('*sRGB', cmyk, eIntent.relative);
        expect(matrixShaper.inspect(t).ok).toBe(false);
        expect(matrixShaper.inspect(t).why).toMatch(/3-channel/);
    });

    test('declines a Lab source — not a matrix-shaper pipeline', () => {
        const t = new Transform({dataFormat: 'int8', buildLut: false});
        t.create('*labd50', '*sRGB', eIntent.relative);
        expect(matrixShaper.inspect(t).ok).toBe(false);
    });

    test('declines object dataFormat', () => {
        const t = new Transform({dataFormat: 'object', buildLut: false});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        expect(matrixShaper.inspect(t).ok).toBe(false);
        expect(matrixShaper.inspect(t).why).toMatch(/int8/);
    });

    test('declines a multi-step chain — extra stages it does not model', () => {
        const cmyk = new Profile(); cmyk.loadFile(CMYK);
        const t = new Transform({dataFormat: 'int8', buildLut: false});
        t.createMultiStage(['*sRGB', eIntent.relative, cmyk, eIntent.relative, '*AdobeRGB']);
        expect(matrixShaper.inspect(t).ok).toBe(false);
    });
});

describe('matrix-shaper kernel — it must not change anything else', () => {

    jest.setTimeout(120000);

    test('alpha channels go through the kernel and come out identical', () => {
        // This test used to assert the opposite — that alpha kept the kernel
        // OUT, because it was 3-in 3-out only. The module now exports an entry
        // point per alpha shape, so RGBA is byte-for-byte what the generic
        // loops produce, at 40x the speed. Kept pointed at the same input so
        // the change of behaviour is visible in the history rather than in a
        // deleted file.
        const fast = accelerated('*sRGB', '*AdobeRGB');
        const ref  = reference('*sRGB', '*AdobeRGB');

        const px = new Uint8ClampedArray(400 * 4);
        for(let i = 0; i < px.length; i++) px[i] = (i * 37) & 255;

        const got = fast.transformArray(px, true, true, true, 400);
        const expected = ref.transformArray(px, true, true, true, 400);
        expect(Array.from(got)).toEqual(Array.from(expected));

        expect(kernelRan(fast)).toBe(true);
    });

    test('a supplied outputArray is written in place and returned', () => {
        const t = accelerated('*sRGB', '*AdobeRGB');
        const px = new Uint8ClampedArray(300);
        for(let i = 0; i < px.length; i++) px[i] = (i * 53) & 255;

        const out = new Uint8ClampedArray(300);
        const got = t.transformArray(px, false, false, false, 100, undefined, out);
        expect(got).toBe(out);
        expect(Array.from(out).some(v => v !== 0)).toBe(true);
    });

    test('an undersized outputArray does not corrupt memory', () => {
        const t = accelerated('*sRGB', '*AdobeRGB');
        const px = new Uint8ClampedArray(300);
        const tooSmall = new Uint8ClampedArray(30);
        const got = t.transformArray(px, false, false, false, 100, undefined, tooSmall);
        expect(got.length).toBe(300);          // allocated a correct one instead
    });

    test('rebuilding a Transform drops the kernel with the pipeline', () => {
        const t = accelerated('*sRGB', '*AdobeRGB');
        t.transformArray(new Uint8ClampedArray(30), false, false, false, 10);
        expect(kernelRan(t)).toBe(true);

        t.clear();
        expect(t.kernelInfo()).toBeNull();          // no pipeline, no kernel
    });

    test('odd pixel counts hit the scalar tail correctly', () => {
        // The SIMD loop does 4 pixels at a time; 1-3 remainder pixels go
        // through a separate scalar path that is easy to get wrong.
        const fast = accelerated('*sRGB', '*AdobeRGB');
        const ref  = reference('*sRGB', '*AdobeRGB');

        for(const n of [1, 2, 3, 5, 7, 9, 4095, 4097]){
            const px = new Uint8ClampedArray(n * 3);
            for(let i = 0; i < px.length; i++) px[i] = (i * 91) & 255;

            const got = fast.transformArray(px, false, false, false, n);
            const expected = ref.transformArray(px, false, false, false, n);
            expectWithin1LSB(`n=${n}`, compare(got, expected));
        }
    });

    test('growing past the initial memory works, and repeat calls stay correct', () => {
        // Linear memory starts at 2 pages; a large image forces memory.grow(),
        // which DETACHES the old buffer — every view has to be retaken.
        const fast = accelerated('*sRGB', '*AdobeRGB');
        const ref  = reference('*sRGB', '*AdobeRGB');

        for(const n of [1000, 500000, 1000, 900000]){
            const px = new Uint8ClampedArray(n * 3);
            for(let i = 0; i < px.length; i++) px[i] = (i * 17) & 255;

            const got = fast.transformArray(px, false, false, false, n);
            const expected = ref.transformArray(px, false, false, false, n);
            expectWithin1LSB(`n=${n}`, compare(got, expected));
        }
    });
});

describe('wasmMatrixShaper mode — auto / prefer / off', () => {

    jest.setTimeout(120000);

    // `buildLut: true` is a request, not a hint: callers export LUTs with
    // toJSON(), clone and diverge them, and manage their WASM memory. So the
    // kernel replaces a CLUT only when asked, and refuses whenever something
    // would silently stop working.

    function build(opts){
        const t = new Transform(Object.assign(
            {dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'}, opts));
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        return t;
    }

    test('off by default — buildLut:true still builds a LUT', () => {
        expect(build({}).lut).toBeTruthy();
    });

    test('on request, no CLUT is built and the kernel runs instead', () => {
        const t = build({wasmMatrixShaper: 'prefer'});
        expect(t.lut).toBe(false);
        expect(t.pipeline.map(s => s.stageName)).toEqual([
            'stage_Int_to_Device', 'stage_Gamma_Inverse', 'stage_matrix_rgb',
            'stage_Gamma', 'stage_device_to_int'
        ]);

        const px = new Uint8ClampedArray(300);
        for(let i = 0; i < px.length; i++) px[i] = (i * 41) & 255;
        t.transformArray(px, false, false, false, 100);
        expect(kernelRan(t)).toBe(true);
    });

    test('matrixShaper:true is the same thing, spelled shorter', () => {
        const t = build({matrixShaper: true});
        expect(t.lut).toBe(false);
        expect(t.getOptions().wasmMatrixShaper).toBe('prefer');
    });

    test('the resolved mode is reported in getOptions', () => {
        expect(build({}).getOptions().wasmMatrixShaper).toBe('auto');
        expect(build({wasmMatrixShaper: 'prefer'}).getOptions().wasmMatrixShaper).toBe('prefer');
        expect(build({wasmMatrixShaper: false}).getOptions().wasmMatrixShaper).toBe('off');
        // Aliases resolve to the same mode rather than being a second switch.
        expect(build({matrixShaper: true}).getOptions().wasmMatrixShaper).toBe('prefer');
        expect(build({wasmMatrixShaper: 'prefer'}).getOptions().wasmMatrixShaper).toBe('prefer');
    });

    test('wasmMatrixShaper:false turns it off on the no-LUT path too', () => {
        // The mode is about the kernel, not only about who beats the CLUT —
        // so `false` has to mean "never", including where there is no LUT.
        const t = new Transform({dataFormat: 'int8', buildLut: false, wasmMatrixShaper: false});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        t.transformArray(new Uint8ClampedArray(30), false, false, false, 10);
        expect(kernelClaimed(t)).toBe(false);
    });

    test('an unknown mode falls back to auto rather than throwing', () => {
        expect(build({wasmMatrixShaper: 'nonsense'}).getOptions().wasmMatrixShaper).toBe('auto');
    });

    describe('refuses whenever something depends on the LUT', () => {
        // Each of these would otherwise fail SILENTLY: the hook simply never
        // runs, because hooks only execute during the grid walk this skips.
        test('a lutOutputHook keeps the LUT, so the hook still fires', () => {
            let fired = 0;
            const t = new Transform({dataFormat: 'int8', buildLut: true,
                wasmMatrixShaper: 'prefer',
                lutOutputHook: (v) => { fired++; return v; }});
            t.create('*sRGB', '*AdobeRGB', eIntent.relative);
            expect(t.lut).toBeTruthy();
            expect(fired).toBeGreaterThan(0);
        });

        test('a lutInputHook keeps the LUT', () => {
            let fired = 0;
            const t = new Transform({dataFormat: 'int8', buildLut: true,
                wasmMatrixShaper: 'prefer',
                lutInputHook: (v) => { fired++; return v; }});
            t.create('*sRGB', '*AdobeRGB', eIntent.relative);
            expect(t.lut).toBeTruthy();
            expect(fired).toBeGreaterThan(0);
        });

        test('gamut mapping keeps the LUT — it is baked at build time', () => {
            const t = new Transform({dataFormat: 'int8', buildLut: true,
                wasmMatrixShaper: 'prefer', lutGamutMode: 'color'});
            t.create('*sRGB', '*AdobeRGB', eIntent.relative);
            expect(t.lut).toBeTruthy();
        });

        test('a non-RGB destination keeps the LUT', () => {
            const cmyk = new Profile(); cmyk.loadFile(CMYK);
            const t = new Transform({dataFormat: 'int8', buildLut: true,
                wasmMatrixShaper: 'prefer'});
            t.create('*sRGB', cmyk, eIntent.relative);
            expect(t.lut).toBeTruthy();
        });

        test('a LUT-BASED RGB profile keeps the LUT', () => {
            // Not every RGB profile is a matrix-shaper: printer RGB profiles
            // carry A2B/B2A tables. Caught by the pipeline shape rather than by
            // asking "is it RGB", which would have got this wrong.
            const p = new Profile();
            p.loadFile(path.join(__dirname, '..', 'testbed', 'profiles', 'rgb',
                                 'sRGB_v4_ICC_preference.icc'));
            if(!p.loaded) return;                    // profile not present
            const t = new Transform({dataFormat: 'int8', buildLut: true,
                wasmMatrixShaper: 'prefer'});
            t.create('*sRGB', p, eIntent.relative);
            expect(t.lut).toBeTruthy();
        });
    });

    test('the kernel is MORE accurate than the CLUT it replaces', () => {
        // The point worth pinning: this is not a speed-for-accuracy trade.
        // Against the exact pipeline over 262,144 colours, the CLUT reaches
        // 25 LSB on prophoto -> sRGB with 2.5% of samples beyond 1 LSB; the
        // kernel stays at 1 LSB with none.
        const img = cube();

        // wasmMatrixShaper:false is the supported way to get the exact
        // pipeline; poking a private field would stop working the moment the
        // kernel moved, which it since has.
        const exact = new Transform({dataFormat: 'int8', buildLut: false,
                                     wasmMatrixShaper: false});
        exact.create('*prophoto', '*sRGB', eIntent.relative);
        expect(kernelClaimed(exact)).toBe(false);
        const ref = exact.transformArray(img.data, false, false, false, img.pixelCount);

        const clut = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        clut.create('*prophoto', '*sRGB', eIntent.relative);
        const cStats = compare(clut.transformArray(img.data, false, false, false, img.pixelCount), ref);

        const kern = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd',
                                    wasmMatrixShaper: 'prefer'});
        kern.create('*prophoto', '*sRGB', eIntent.relative);
        const kStats = compare(kern.transformArray(img.data, false, false, false, img.pixelCount), ref);

        expectWithin1LSB('kernel vs exact', kStats);
        expect(kStats.max).toBeLessThan(cStats.max);      // strictly better
        expect(kStats.over).toBe(0);
        expect(cStats.over).toBeGreaterThan(0);           // the CLUT is not
    });
});

// ---------------------------------------------------------------------------
// int16
// ---------------------------------------------------------------------------

/** A 48^3 sweep, plus a dense near-black region. */
function cube16(){
    const vals = [];
    for(let i = 0; i < 48; i++) vals.push(Math.round(i * 65535 / 47));
    const px = [];
    for(const r of vals) for(const g of vals) for(const b of vals) px.push(r, g, b);
    // THE DARK END IS THE HARD PART. A power TRC has unbounded slope at zero,
    // so an output table indexed linearly in linear-light is worst exactly
    // here — ~97 LSB out in its first interval. At 8 bits that hides under
    // 1/257th of a code; at 16 bits it does not, which is why the int16 table
    // is indexed by sqrt(). Without these samples the suite would not notice.
    for(let i = 0; i <= 512; i++){
        const v = i * 4;
        px.push(v, v, v);  px.push(v, 0, 0);  px.push(0, v, 0);
        px.push(0, 0, v);  px.push(v, v >> 1, v >> 2);
    }
    return { data: new Uint16Array(px), pixelCount: px.length / 3 };
}

function accelerated16(a, b, opts){
    const t = new Transform(Object.assign({dataFormat: 'int16', buildLut: false}, opts || {}));
    t.create(a, b, eIntent.relative);
    return t;
}

function reference16(a, b, opts){
    const t = new Transform(Object.assign(
        {dataFormat: 'int16', buildLut: false, wasmMatrixShaper: false}, opts || {}));
    t.create(a, b, eIntent.relative);
    return t;
}

describe('matrix-shaper kernel — int16', () => {

    jest.setTimeout(120000);

    const img = cube16();

    for(const [a, b] of PAIRS){
        test(`${a} -> ${b}: within 1 LSB of 65535 over ${img.pixelCount} colours`, () => {
            const fast = accelerated16(a, b);
            const got = fast.transformArray(img.data, false, false, false, img.pixelCount);
            expect(kernelRan(fast)).toBe(true);
            expect(fast.kernelInfo().bits).toBe(16);

            const expected = reference16(a, b)
                .transformArray(img.data, false, false, false, img.pixelCount);

            expectWithin1LSB(`${a} -> ${b} (int16)`, compare(got, expected));
        });
    }

    test('the output is a Uint16Array, not bytes', () => {
        const t = accelerated16('*sRGB', '*AdobeRGB');
        const out = t.transformArray(new Uint16Array([1000, 2000, 3000]), false, false, false, 1);
        expect(out instanceof Uint16Array).toBe(true);
        expect(kernelRan(t)).toBe(true);
    });

    test('a supplied Uint16Array output is written in place and returned', () => {
        const t = accelerated16('*sRGB', '*AdobeRGB');
        const px = new Uint16Array(300);
        for(let i = 0; i < px.length; i++) px[i] = (i * 997) & 0xffff;
        const out = new Uint16Array(300);
        const got = t.transformArray(px, false, false, false, 100, undefined, out);
        expect(got).toBe(out);
        expect(kernelRan(t)).toBe(true);
    });

    test('wasmMatrixShaper prefer skips the CLUT at int16 too', () => {
        const t = new Transform({dataFormat: 'int16', buildLut: true, wasmMatrixShaper: 'prefer'});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        expect(t.lut).toBe(false);

        const px = new Uint16Array([0, 128, 65535, 30000, 30000, 30000]);
        const got = t.transformArray(px, false, false, false, 2);
        const expected = reference16('*sRGB', '*AdobeRGB')
            .transformArray(px, false, false, false, 2);
        expectWithin1LSB('prefer int16', compare(got, expected));
    });

    test('odd pixel counts hit the scalar tail correctly', () => {
        // 4 pixels per SIMD iteration, so 1..3 pixels fall through to the tail.
        const ref = reference16('*prophoto', '*sRGB');
        const fast = accelerated16('*prophoto', '*sRGB');
        for(const n of [1, 2, 3, 5, 7, 13]){
            const px = new Uint16Array(n * 3);
            for(let i = 0; i < px.length; i++) px[i] = (i * 4241) & 0xffff;
            const got = fast.transformArray(px, false, false, false, n);
            const expected = ref.transformArray(px, false, false, false, n);
            expectWithin1LSB(`int16 tail n=${n}`, compare(got, expected));
        }
    });
});

// ---------------------------------------------------------------------------
// the scalar fallback
// ---------------------------------------------------------------------------

describe('matrix-shaper kernel — the scalar build', () => {

    jest.setTimeout(120000);

    // Every machine that runs this suite has WASM SIMD, so the fallback is
    // unreachable without pinning it. Unreachable code is untested code, and
    // "the fallback is bit-identical" is exactly the kind of claim that quietly
    // stops being true.
    afterEach(() => matrixShaper.useVariant(null));

    function withVariant(kind, fn){
        matrixShaper.useVariant(kind);
        try { return fn(); } finally { matrixShaper.useVariant(null); }
    }

    test('pinning actually selects the scalar binary', () => {
        withVariant('scalar', () => {
            const t = accelerated('*sRGB', '*AdobeRGB');
            t.transformArray(new Uint8ClampedArray([1, 2, 3]), false, false, false, 1);
            expect(kernelRan(t)).toBe(true);
            expect(t.kernelInfo().variant).toBe('8-scalar');
            expect(t.kernelInfo().simd).toBe(false);
        });
    });

    test('int8 scalar is BIT-IDENTICAL to int8 SIMD', () => {
        // Not "within 1 LSB". The scalar loop performs the same f32 operations
        // in the same order as one SIMD lane, so anything short of exact
        // equality means one of the two drifted.
        const img = cube();

        const simd = withVariant('simd', () => {
            const t = accelerated('*prophoto', '*sRGB');
            return t.transformArray(img.data, false, false, false, img.pixelCount).slice();
        });
        const scalar = withVariant('scalar', () => {
            const t = accelerated('*prophoto', '*sRGB');
            // The kernel is built on first use, so read the variant after.
            const out = t.transformArray(img.data, false, false, false, img.pixelCount).slice();
            expect(t.kernelInfo().variant).toBe('8-scalar');
            return out;
        });

        const r = compare(scalar, simd);
        expect(`int8 scalar vs simd: max ${r.max}`).toBe('int8 scalar vs simd: max 0');
    });

    test('int16 scalar is BIT-IDENTICAL to int16 SIMD', () => {
        const img = cube16();

        const simd = withVariant('simd', () => {
            const t = accelerated16('*prophoto', '*sRGB');
            return t.transformArray(img.data, false, false, false, img.pixelCount).slice();
        });
        const scalar = withVariant('scalar', () => {
            const t = accelerated16('*prophoto', '*sRGB');
            const out = t.transformArray(img.data, false, false, false, img.pixelCount).slice();
            expect(t.kernelInfo().variant).toBe('16-scalar');
            return out;
        });

        const r = compare(scalar, simd);
        expect(`int16 scalar vs simd: max ${r.max}`).toBe('int16 scalar vs simd: max 0');
    });

    test('the scalar build is still within 1 LSB of the pipeline', () => {
        // The bit-identity test above would pass if BOTH builds were wrong in
        // the same way, so the scalar path is also checked against the maths.
        withVariant('scalar', () => {
            const img = cube();
            const fast = accelerated('*sRGB', '*colormatch');
            const got = fast.transformArray(img.data, false, false, false, img.pixelCount);
            const expected = reference('*sRGB', '*colormatch')
                .transformArray(img.data, false, false, false, img.pixelCount);
            expectWithin1LSB('scalar vs pipeline', compare(got, expected));
        });
    });

    test('auto selection prefers SIMD where the host has it', () => {
        const t = accelerated('*sRGB', '*AdobeRGB');
        t.transformArray(new Uint8ClampedArray([1, 2, 3]), false, false, false, 1);
        expect(t.kernelInfo().simd).toBe(true);
    });
});

describe('matrix-shaper kernel — toJSON on a transform it took', () => {

    test('the error names the real cause, not the advice already followed', () => {
        // buildLut:true WAS passed. Telling the caller to pass buildLut:true
        // sends them in a circle, which is what the generic message did.
        const t = new Transform({dataFormat: 'int8', buildLut: true, wasmMatrixShaper: 'prefer'});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        expect(t.lut).toBe(false);

        let msg = '';
        try { t.toJSON(); } catch(e){ msg = String(e); }
        expect(msg).toMatch(/wasmMatrixShaper/);
        expect(msg).toMatch(/auto/);
    });

    test("the generic message still applies when no LUT was asked for", () => {
        const t = new Transform({dataFormat: 'int8', buildLut: false});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        let msg = '';
        try { t.toJSON(); } catch(e){ msg = String(e); }
        expect(msg).toMatch(/buildLut/);
        expect(msg).not.toMatch(/wasmMatrixShaper/);
    });
});

// ---------------------------------------------------------------------------
// alpha
// ---------------------------------------------------------------------------

/**
 * The four alpha shapes, plus the fill/copy split on 4->4.
 *
 * THIS IS THE CASE THAT USED TO FALL OFF A CLIFF. Canvas ImageData is RGBA and
 * `buildLut` defaults to false, so before the kernel grew alpha entry points
 * the commonest input in a browser reached the generic loops — measured at
 * 8.0 MPx/s against 331 for the identical conversion without alpha. It is not
 * a 2x path, it was a 40x one.
 */
describe('matrix-shaper kernel — alpha', () => {

    jest.setTimeout(120000);

    const N = 20000;

    function rgbaNoise(n){
        const px = new Uint8ClampedArray(n * 4);
        let s = 0x13579bdf;
        for(let i = 0; i < px.length; i++){
            s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
            px[i] = (s >>> 23) & 0xff;                  // bits 23-30; low bits repeat
        }
        return px;
    }
    function stripAlpha(rgba, n){
        const px = new Uint8ClampedArray(n * 3);
        for(let p = 0; p < n; p++){
            px[p*3] = rgba[p*4]; px[p*3+1] = rgba[p*4+1]; px[p*3+2] = rgba[p*4+2];
        }
        return px;
    }

    const rgba = rgbaNoise(N);
    const rgb  = stripAlpha(rgba, N);

    const SHAPES = [
        ['3 -> 3',           rgb,  false, false, false, 3],
        ['4 -> 3, drop',     rgba, true,  false, false, 3],
        ['3 -> 4, fill',     rgb,  false, true,  false, 4],
        ['4 -> 4, copy',     rgba, true,  true,  true,  4],
        ['4 -> 4, fill',     rgba, true,  true,  false, 4]
    ];

    for(const [label, src, inA, outA, preserve, outCh] of SHAPES){
        test(label + ': matches the pipeline, and the kernel ran', () => {
            const fast = accelerated('*prophoto', '*sRGB');
            const got  = fast.transformArray(src, inA, outA, preserve, N);
            const exp  = reference('*prophoto', '*sRGB')
                             .transformArray(src, inA, outA, preserve, N);

            expect(kernelRan(fast)).toBe(true);                // not a silent fallback
            expect(got.length).toBe(N * outCh);

            // Colour channels only — alpha is checked separately below, because
            // "within 1 LSB" is the wrong bar for a byte that must be exact.
            let max = 0;
            for(let p = 0; p < N; p++)
                for(let c = 0; c < 3; c++)
                    max = Math.max(max, Math.abs(got[p*outCh+c] - exp[p*outCh+c]));
            expect(`${label}: colour max ${max} LSB`).toBe(`${label}: colour max ${max <= 1 ? max : 1} LSB`);
        });
    }

    test('a copied alpha is EXACT, not within 1 LSB', () => {
        // Alpha is opacity, not a colorant. It must not go through the TRC or
        // the matrix, so the only acceptable error is none.
        const t = accelerated('*prophoto', '*sRGB');
        const got = t.transformArray(rgba, true, true, true, N);
        let wrong = 0;
        for(let p = 0; p < N; p++) if(got[p*4+3] !== rgba[p*4+3]) wrong++;
        expect(wrong).toBe(0);
    });

    test('a filled alpha is opaque everywhere', () => {
        for(const [src, inA] of [[rgb, false], [rgba, true]]){
            const t = accelerated('*prophoto', '*sRGB');
            const got = t.transformArray(src, inA, true, false, N);
            let wrong = 0;
            for(let p = 0; p < N; p++) if(got[p*4+3] !== 255) wrong++;
            expect(wrong).toBe(0);
        }
    });

    test('int16 fills alpha with 65535, not 255', () => {
        const px = new Uint16Array(N * 3);
        for(let i = 0; i < px.length; i++) px[i] = (i * 4241) & 0xffff;
        const t = accelerated16('*prophoto', '*sRGB');
        const got = t.transformArray(px, false, true, false, N);
        expect(got instanceof Uint16Array).toBe(true);
        let wrong = 0;
        for(let p = 0; p < N; p++) if(got[p*4+3] !== 65535) wrong++;
        expect(wrong).toBe(0);
    });

    test('int16 copies alpha through exactly', () => {
        const px = new Uint16Array(N * 4);
        for(let i = 0; i < px.length; i++) px[i] = (i * 4241) & 0xffff;
        const t = accelerated16('*prophoto', '*sRGB');
        const got = t.transformArray(px, true, true, true, N);
        let wrong = 0;
        for(let p = 0; p < N; p++) if(got[p*4+3] !== px[p*4+3]) wrong++;
        expect(wrong).toBe(0);
    });

    test('the scalar build agrees with SIMD on the alpha shapes too', () => {
        // The alpha stores are plain loads and stores, so they should be
        // identical rather than merely close — same as the colour path.
        const run = kind => {
            matrixShaper.useVariant(kind);
            try {
                const t = accelerated('*prophoto', '*sRGB');
                return t.transformArray(rgba, true, true, true, N).slice();
            } finally { matrixShaper.useVariant(null); }
        };
        const simd = run('simd'), scalar = run('scalar');
        let diff = 0;
        for(let i = 0; i < simd.length; i++) if(simd[i] !== scalar[i]) diff++;
        expect(`alpha scalar vs simd: ${diff} bytes differ`).toBe('alpha scalar vs simd: 0 bytes differ');
    });

    test('odd pixel counts hit the scalar tail with alpha', () => {
        // 4 pixels per SIMD iteration, and the tail has its own alpha stores.
        const ref  = reference('*sRGB', '*AdobeRGB');
        const fast = accelerated('*sRGB', '*AdobeRGB');
        for(const n of [1, 2, 3, 5, 7, 13]){
            const px = new Uint8ClampedArray(n * 4);
            for(let i = 0; i < px.length; i++) px[i] = (i * 37) & 255;
            const got = fast.transformArray(px, true, true, true, n);
            const exp = ref.transformArray(px, true, true, true, n);
            expect(Array.from(got)).toEqual(Array.from(exp));
        }
    });

    test('a supplied RGBA outputArray is written in place and returned', () => {
        const t = accelerated('*sRGB', '*AdobeRGB');
        const out = new Uint8ClampedArray(N * 4);
        const got = t.transformArray(rgba, true, true, true, N, undefined, out);
        expect(got).toBe(out);
    });

    test('an RGB-sized outputArray is not used for an RGBA result', () => {
        // The old length check asked for pixelCount * 3 whatever the shape, so
        // a 3-channel buffer would have been accepted and overrun.
        const t = accelerated('*sRGB', '*AdobeRGB');
        const tooSmall = new Uint8ClampedArray(N * 3);
        const got = t.transformArray(rgba, true, true, true, N, undefined, tooSmall);
        expect(got).not.toBe(tooSmall);
        expect(got.length).toBe(N * 4);
    });
});

// ---------------------------------------------------------------------------
// the kernel descriptor
// ---------------------------------------------------------------------------

describe('matrix-shaper kernel — registered as a claiming kernel module', () => {

    jest.setTimeout(120000);

    test('it is registered, and does NOT occupy the 3-channel slot', () => {
        // Kernel3D still owns 3 channels. A claiming kernel is an addition to
        // the registry, not a replacement in it — every LUT-based RGB pair
        // must still reach the tetrahedral kernel.
        const names = Transform.claimKernels.map(k => k.name);
        expect(names).toContain('matrix-shaper');
        expect(Transform.kernels[3].name).not.toBe('matrix-shaper');
        expect(Transform.kernels[3].dimensions).toBe(3);
    });

    test('a matrix-shaper pair is claimed; a CMYK destination is not', () => {
        const claimed = accelerated('*sRGB', '*AdobeRGB');
        expect(claimed.kernelInfo().name).toBe('matrix-shaper');
        expect(claimed.kernelInfo().claimed).toBe(true);

        const cmyk = new Profile(); cmyk.loadFile(CMYK);
        const notClaimed = new Transform({dataFormat: 'int8', buildLut: false});
        notClaimed.create('*sRGB', cmyk, eIntent.relative);
        expect(notClaimed.kernelInfo().claimed).toBe(false);
        expect(notClaimed.kernelInfo().dimensions).toBe(3);   // Kernel3D, by channel count
    });

    test('a LUT-based transform keeps Kernel3D', () => {
        // The claim runs against the FINAL pipeline, which for a built LUT is
        // the interpolation pipeline — so the matrix shaper correctly declines
        // and the tetrahedral kernel keeps the transform.
        const t = new Transform({dataFormat: 'int8', buildLut: true});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        expect(t.kernelInfo().claimed).toBe(false);
        expect(t.kernelInfo().hasLut).toBe(true);
    });

    test('the claim needs the PIPELINE, not the channel count — identity proves it', () => {
        // sRGB -> sRGB is 3-channel in and out, same as a claimed pair. It
        // collapses to a copy, so there is nothing to accelerate and the claim
        // must not fire. No amount of inspecting profile types would separate
        // this case from the one above; only the built pipeline does.
        const t = new Transform({dataFormat: 'int8', buildLut: false});
        t.create('*sRGB', '*sRGB', eIntent.relative);
        const info = t.kernelInfo();
        expect(info === null || info.claimed === false).toBe(true);
    });

    test('the build is LAZY — claimed at create(), built on first use', () => {
        // Filling the tables costs 3-8 ms. A Transform that only ever converts
        // single colours must not pay it, and the gamut helpers make several
        // of those per LUT.
        const t = accelerated('*sRGB', '*AdobeRGB');
        expect(t.kernelInfo().claimed).toBe(true);
        expect(t.kernelInfo().built).toBe(false);

        t.transformArray(new Uint8ClampedArray(30), false, false, false, 10);
        expect(t.kernelInfo().built).toBe(true);
    });

    test('a single colour never triggers the build', () => {
        // dataFormat 'object' is the accuracy path and walks the pipeline
        // directly, so the kernel is not even claimed — which is the stronger
        // version of the same guarantee.
        const t = new Transform({dataFormat: 'object'});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        t.transform(convert.RGB(128, 64, 32));
        expect(t.kernelInfo().claimed).toBe(false);
    });

    test('kernelInfo() reports the variant once built', () => {
        const t = accelerated('*sRGB', '*AdobeRGB');
        t.transformArray(new Uint8ClampedArray(30), false, false, false, 10);
        const info = t.kernelInfo();
        expect(info.variant).toMatch(/^8-(simd|scalar)$/);
        expect(info.bits).toBe(8);
        expect(typeof info.simd).toBe('boolean');
    });

    test('a claim that throws does not break create()', () => {
        // A third-party kernel is registered code running inside create(). It
        // must not be able to take the Transform down — declining is always an
        // available answer, so an exception is treated as one.
        const broken = {
            name: 'test-broken-claim',
            dimensions: 3,
            claims: function(){ throw new Error('deliberate'); },
            create: function(m){ return m; },
            resolveRuns: function(){},
            array: function(){ return null; },
            release: function(){},
            provideLut: function(){ return null; }
        };
        Transform.registerKernel(broken);
        try {
            const t = accelerated('*sRGB', '*AdobeRGB');
            // The broken one is asked first (registered last, but we only care
            // that create() survived and the real kernel still won).
            expect(t.kernelInfo().name).toBe('matrix-shaper');
        } finally {
            const i = Transform.claimKernels.findIndex(k => k.name === 'test-broken-claim');
            if(i >= 0) Transform.claimKernels.splice(i, 1);
        }
    });

    test('registering the same name twice replaces rather than duplicating', () => {
        const before = Transform.claimKernels.length;
        Transform.registerKernel(require('../src/kernels/matrixShaper/KernelMatrixShaper.js'));
        expect(Transform.claimKernels.length).toBe(before);
    });

    test('clear() releases the kernel, and create() re-decides', () => {
        // The kernel holds a WASM instance sized for the last image. Keeping it
        // across clear() would hold that memory and offer the next create() a
        // kernel chosen for a conversion it no longer performs.
        const t = accelerated('*sRGB', '*AdobeRGB');
        t.transformArray(new Uint8ClampedArray(30), false, false, false, 10);
        expect(t.kernelInfo().built).toBe(true);

        t.clear();
        expect(t.kernelInfo()).toBeNull();

        // Re-created as something the kernel does NOT want: the claim must not
        // be sticky.
        const cmyk = new Profile(); cmyk.loadFile(CMYK);
        t.create('*sRGB', cmyk, eIntent.relative);
        expect(t.kernelInfo().claimed).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// the JS implementation
// ---------------------------------------------------------------------------

describe('matrix-shaper kernel — the JS implementation', () => {

    jest.setTimeout(120000);

    // Every machine running this suite has WASM with SIMD, so the JS path is
    // unreachable without pinning. Unreachable code is untested code.
    afterEach(() => matrixShaper.useVariant(null));

    function withJS(fn){
        matrixShaper.useVariant('js');
        try { return fn(); } finally { matrixShaper.useVariant(null); }
    }

    test('pinning routes to it, and it reports itself as JS', () => {
        withJS(() => {
            const t = accelerated('*sRGB', '*AdobeRGB');
            t.transformArray(new Uint8ClampedArray([1, 2, 3]), false, false, false, 1);
            const info = t.kernelInfo();
            expect(info.variant).toBe('8-js');
            expect(info.simd).toBe(false);
        });
    });

    for(const [a, b] of PAIRS){
        test(`${a} -> ${b}: within 1 LSB over 262,144 colours`, () => {
            const img = cube();
            const expected = reference(a, b)
                .transformArray(img.data, false, false, false, img.pixelCount);
            const got = withJS(() => {
                const t = accelerated(a, b);
                const out = t.transformArray(img.data, false, false, false, img.pixelCount);
                expect(t.kernelInfo().variant).toBe('8-js');
                return out;
            });
            expectWithin1LSB(`${a} -> ${b} (JS)`, compare(got, expected));
        });
    }

    test('int16 too, where a linear output index would be 7 LSB out', () => {
        // The quartic index is not decoration: a linearly indexed output table
        // measures 7 LSB here with 70,625 samples beyond 1, because a power
        // TRC's encode curve has unbounded slope at zero.
        const img = cube16();
        const expected = reference16('*prophoto', '*sRGB')
            .transformArray(img.data, false, false, false, img.pixelCount);
        const got = withJS(() => {
            const t = accelerated16('*prophoto', '*sRGB');
            const out = t.transformArray(img.data, false, false, false, img.pixelCount);
            expect(t.kernelInfo().variant).toBe('16-js');
            return out;
        });
        expectWithin1LSB('int16 JS', compare(got, expected));
    });

    test('every alpha shape, matching the pipeline and preserving alpha exactly', () => {
        const N = 5000;
        const rgba = new Uint8ClampedArray(N * 4);
        let s = 0x13579bdf;
        for(let i = 0; i < rgba.length; i++){
            s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
            rgba[i] = (s >>> 23) & 0xff;
        }
        const rgb = new Uint8ClampedArray(N * 3);
        for(let p = 0; p < N; p++){
            rgb[p*3] = rgba[p*4]; rgb[p*3+1] = rgba[p*4+1]; rgb[p*3+2] = rgba[p*4+2];
        }

        const SHAPES = [
            ['4 -> 3', rgba, true,  false, false, 3],
            ['3 -> 4', rgb,  false, true,  false, 4],
            ['4 -> 4 copy', rgba, true, true, true,  4],
            ['4 -> 4 fill', rgba, true, true, false, 4]
        ];
        for(const [label, src, inA, outA, preserve, outCh] of SHAPES){
            const expected = reference('*prophoto', '*sRGB')
                .transformArray(src, inA, outA, preserve, N);
            const got = withJS(() => accelerated('*prophoto', '*sRGB')
                .transformArray(src, inA, outA, preserve, N));

            expect(`${label}: length ${got.length}`).toBe(`${label}: length ${N * outCh}`);
            let max = 0;
            for(let p = 0; p < N; p++)
                for(let c = 0; c < 3; c++)
                    max = Math.max(max, Math.abs(got[p*outCh+c] - expected[p*outCh+c]));
            expect(`${label}: colour max ${max}`).toBe(`${label}: colour max ${max <= 1 ? max : 1}`);

            if(outCh === 4){
                let wrong = 0;
                for(let p = 0; p < N; p++){
                    const want = preserve && inA ? src[p*4+3] : 255;
                    if(got[p*4+3] !== want) wrong++;
                }
                expect(`${label}: alpha wrong ${wrong}`).toBe(`${label}: alpha wrong 0`);
            }
        }
    });

    test('it TAKES a per-channel TRC profile, which WASM declines', () => {
        // The coverage this exists for. One table per direction cannot serve
        // three different curves, so the WASM kernel refuses; JS has no
        // table-size pressure and carries three. Without it, such a transform
        // falls to the stage pipeline at ~8 MPx/s.
        //
        // Synthesised, because no profile in testbed/profiles/rgb carries
        // genuinely differing curves — which is itself worth knowing, and is
        // why this is coverage insurance rather than a measured cliff.
        const p = new Profile();
        p.loadFile(path.join(__dirname, '..', 'testbed', 'profiles', 'rgb', 'AdobeRGB1998.icc'));
        if(!p.loaded) return;

        const t = new Transform({dataFormat: 'int8', buildLut: false});
        t.create('*sRGB', p, eIntent.relative);
        const check = matrixShaper.inspect(t);
        expect(check.ok).toBe(true);

        // Force the per-channel branch directly: same pipeline, three tables.
        const js = require('../src/kernels/matrixShaper/matrixShaperJS');
        const perCh = js.build(t, Object.assign({}, check, {perChannel: 'input'}));
        const grey  = js.build(t, Object.assign({}, check, {perChannel: null}));

        expect(perCh.perChannel).toBe(true);
        expect(grey.perChannel).toBe(false);

        // A grey profile through the three-table path must give the same
        // answer as through the one-table path — otherwise the per-channel
        // code is not actually equivalent where the curves agree.
        const img = cube();
        const a = perCh.run(img.data, new Uint8ClampedArray(img.pixelCount * 3), img.pixelCount, false, false, false);
        const b = grey.run(img.data, new Uint8ClampedArray(img.pixelCount * 3), img.pixelCount, false, false, false);
        let differing = 0;
        for(let i = 0; i < a.length; i++) if(a[i] !== b[i]) differing++;
        expect(`three tables vs one: ${differing} bytes differ`).toBe('three tables vs one: 0 bytes differ');
    });

    test('grey curves share one table object rather than allocating three', () => {
        // The common case must not pay 3x the memory for curves that agree.
        const t = accelerated('*sRGB', '*AdobeRGB');
        const check = matrixShaper.inspect(t);
        expect(check.perChannel).toBeFalsy();
    });
});

describe('Transform.compatibility() — pinning an earlier release\'s defaults', () => {

    afterEach(() => Transform.compatibility(null));

    test('pinning 1.5 puts the no-LUT path back on the stage pipeline', () => {
        // The one default that moved output in 1.5.5: wasmMatrixShaper: 'auto'
        // engages the kernel where the stage pipeline used to run. Within
        // 1 LSB, and closer to the exact maths than the CLUT — but not
        // byte-identical, which is what a caller pinned to reproducibility
        // cares about.
        const now = accelerated('*prophoto', '*sRGB');
        expect(now.kernelInfo().claimed).toBe(true);

        Transform.compatibility('1.5');
        const then = accelerated('*prophoto', '*sRGB');
        expect(then.kernelInfo().claimed).toBe(false);
        expect(then.wasmMatrixShaper).toBe('off');
    });

    test('an explicit option always beats the pin', () => {
        // The pin sets DEFAULTS. It must never override something the caller
        // asked for, or upgrading would silently ignore their code.
        Transform.compatibility('1.5');
        const t = new Transform({dataFormat: 'int8', buildLut: false,
                                 wasmMatrixShaper: 'prefer'});
        t.create('*prophoto', '*sRGB', eIntent.relative);
        expect(t.wasmMatrixShaper).toBe('prefer');
        expect(t.kernelInfo().claimed).toBe(true);
    });

    test('it reads back, and null clears it', () => {
        expect(Transform.compatibility()).toBeNull();
        expect(Transform.compatibility('1.5')).toBe('1.5');
        expect(Transform.compatibility()).toBe('1.5');
        expect(Transform.compatibility(null)).toBeNull();
        expect(Transform.compatibility()).toBeNull();
    });

    test('a patch version resolves to its minor', () => {
        expect(Transform.compatibility('1.5.0')).toBe('1.5');
        expect(Transform.compatibility('1.5.4')).toBe('1.5');
    });

    test('an unknown version throws and lists what it knows', () => {
        // Silently ignoring it would leave the caller believing they were
        // pinned — the failure mode this whole feature exists to prevent.
        expect(() => Transform.compatibility('0.9')).toThrow(/unknown version/);
        expect(() => Transform.compatibility('0.9')).toThrow(/1\.5/);
        expect(Transform.compatibility()).toBeNull();     // and did not stick
    });

    test('pinning does not disturb a Transform already built', () => {
        // Defaults are read at construction. This is the one sharp edge, so it
        // is pinned down rather than left to be discovered.
        const before = accelerated('*prophoto', '*sRGB');
        expect(before.kernelInfo().claimed).toBe(true);
        Transform.compatibility('1.5');
        expect(before.kernelInfo().claimed).toBe(true);   // unchanged
    });
});
