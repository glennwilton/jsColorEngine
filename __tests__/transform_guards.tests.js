/**
 * Input/output validation guards for transformArray and transformArrayViaLUT.
 *
 * Uses a config array to drive multiple scenarios through the same assertion
 * logic, keeping each case concise while covering:
 *   - outputArray wrong type (Uint8Array, Float32Array, plain Array, etc.)
 *   - outputArray too small
 *   - transformArray before create() (no pipeline)
 *   - preserveAlpha without input alpha
 *   - outputArray correct type accepted without error
 */

const {Transform, eIntent} = require('../src/main');
const path = require('path');

const cmykFile = path.join(__dirname, './GRACoL2006_Coated1v2.icc');
const Profile = require('../src/Profile');

let cmykProfile;

beforeAll(async () => {
    cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFile);
});

function createTransform(overrides) {
    var opts = Object.assign({
        dataFormat: 'int8',
        buildLut: true,
        verbose: false,
    }, overrides || {});
    var t = new Transform(opts);
    t.create('*srgb', '*adobergb', eIntent.relative);
    return t;
}

function makeRGBInput(pixels) {
    var a = new Uint8ClampedArray(pixels * 3);
    for (var i = 0; i < a.length; i++) a[i] = i & 0xFF;
    return a;
}

// ---------- transformArray: no pipeline ----------

test('transformArray throws when no pipeline has been created', () => {
    var t = new Transform({ dataFormat: 'int8', buildLut: true });
    var input = makeRGBInput(4);
    expect(() => t.transformArray(input, false, false)).toThrow('No Pipeline');
});

// ---------- transformArray: preserveAlpha without input alpha ----------

test('preserveAlpha is a preference: asking for it without input alpha is served, not refused', () => {
    // It used to throw -- and only on the per-pixel path, because the CLUT and
    // identity routes dispatch before the check, so the same call was refused
    // or served depending on which kernel took the batch.
    //
    // Refusing is the wrong answer either way. Running a batch and saying
    // "keep the alpha" is a reasonable thing to mean for all of it, including
    // the images that have none. It clamps to what the input can supply.
    for(const buildLut of [false, true]){
        var t = new Transform({ dataFormat: 'int8', buildLut: buildLut, verbose: false });
        t.create('*srgb', '*adobergb', eIntent.relative);
        var input = makeRGBInput(4);

        var asked = t.transformArray(input, false, false, true);
        var plain = t.transformArray(input, false, false, false);

        expect(asked.length).toBe(4 * 3);          // no alpha slot invented
        expect(Array.from(asked)).toEqual(Array.from(plain));
    }
});

// ---------- transformArrayViaLUT: outputArray type guards ----------

describe('transformArrayViaLUT outputArray type checks', () => {

    var wrongTypeConfigs = [
        { name: 'Uint8Array is not Uint8ClampedArray',  ctor: Uint8Array },
        { name: 'Float32Array rejected',                ctor: Float32Array },
        { name: 'Float64Array rejected',                ctor: Float64Array },
        { name: 'Int32Array rejected',                  ctor: Int32Array },
    ];

    wrongTypeConfigs.forEach(function (cfg) {
        test('int8 mode — rejects ' + cfg.name, () => {
            var t = createTransform({ lutMode: 'int' });
            var input = makeRGBInput(4);
            var bad = new cfg.ctor(4 * 3);
            expect(() => {
                t.transformArrayViaLUT(input, false, false, false, undefined, bad);
            }).toThrow(/outputArray must be Uint8ClampedArray/);
        });
    });

    test('int16 mode — rejects Uint8ClampedArray', () => {
        var t = createTransform({ lutMode: 'int16' });
        var input = new Uint16Array(4 * 3);
        for (var i = 0; i < input.length; i++) input[i] = i * 256;
        var bad = new Uint8ClampedArray(4 * 3);
        expect(() => {
            t.transformArrayViaLUT(input, false, false, false, undefined, bad);
        }).toThrow(/outputArray must be Uint16Array/);
    });

    test('int16 mode — rejects Float64Array', () => {
        var t = createTransform({ lutMode: 'int16' });
        var input = new Uint16Array(4 * 3);
        var bad = new Float64Array(4 * 3);
        expect(() => {
            t.transformArrayViaLUT(input, false, false, false, undefined, bad);
        }).toThrow(/outputArray must be Uint16Array/);
    });
});

// ---------- transformArrayViaLUT: outputArray too small ----------

describe('transformArrayViaLUT outputArray size checks', () => {

    var sizeConfigs = [
        { name: '1 byte too short',  shortBy: 1 },
        { name: 'half size',         shortBy: 6 },
        { name: 'empty array',       shortBy: 12 },
    ];

    sizeConfigs.forEach(function (cfg) {
        test('rejects outputArray ' + cfg.name, () => {
            var t = createTransform();
            var pixels = 4;
            var input = makeRGBInput(pixels);
            var needed = pixels * 3;
            var small = new Uint8ClampedArray(Math.max(0, needed - cfg.shortBy));
            expect(() => {
                t.transformArrayViaLUT(input, false, false, false, undefined, small);
            }).toThrow(/outputArray too small/);
        });
    });
});

// ---------- transformArrayViaLUT: valid outputArray accepted ----------

describe('transformArrayViaLUT accepts valid outputArray', () => {

    test('int8 mode — Uint8ClampedArray of correct size', () => {
        var t = createTransform();
        var input = makeRGBInput(4);
        var out = new Uint8ClampedArray(4 * 3);
        expect(() => {
            t.transformArrayViaLUT(input, false, false, false, undefined, out);
        }).not.toThrow();
        expect(t.lastUsedKernel).toBe('kernel3D');
    });

    test('int8 mode — oversized Uint8ClampedArray is fine', () => {
        var t = createTransform();
        var input = makeRGBInput(4);
        var out = new Uint8ClampedArray(4 * 3 + 100);
        expect(() => {
            t.transformArrayViaLUT(input, false, false, false, undefined, out);
        }).not.toThrow();
        expect(t.lastUsedKernel).toBe('kernel3D');
    });

    test('int16 mode — Uint16Array of correct size', () => {
        var t = createTransform({ lutMode: 'int16' });
        var input = new Uint16Array(4 * 3);
        for (var i = 0; i < input.length; i++) input[i] = i * 256;
        var out = new Uint16Array(4 * 3);
        expect(() => {
            t.transformArrayViaLUT(input, false, false, false, undefined, out);
        }).not.toThrow();
        expect(t.lastUsedKernel).toBe('kernel3D');
    });
});

// ---------- transformArrayViaLUT with CMYK profiles (different channel counts) ----------

describe('transformArrayViaLUT: CMYK output — guards still work', () => {

    test('RGB→CMYK: outputArray too small for 4-channel output', () => {
        var t = new Transform({ dataFormat: 'int8', buildLut: true, verbose: false });
        t.create('*srgb', cmykProfile, eIntent.relative);
        var input = makeRGBInput(4);
        var tooSmall = new Uint8ClampedArray(4 * 3);
        expect(() => {
            t.transformArrayViaLUT(input, false, false, false, undefined, tooSmall);
        }).toThrow(/outputArray too small/);
    });

    test('RGB→CMYK: correct size Uint8ClampedArray accepted', () => {
        var t = new Transform({ dataFormat: 'int8', buildLut: true, verbose: false });
        t.create('*srgb', cmykProfile, eIntent.relative);
        var input = makeRGBInput(4);
        var out = new Uint8ClampedArray(4 * 4);
        expect(() => {
            t.transformArrayViaLUT(input, false, false, false, undefined, out);
        }).not.toThrow();
        expect(t.lastUsedKernel).toBe('kernel3D');
    });
});

// ---------- transformArray: routes to transformArrayViaLUT guards ----------

describe('transformArray forwards outputArray guards to transformArrayViaLUT', () => {

    test('wrong outputArray type throws via transformArray', () => {
        var t = createTransform();
        var input = makeRGBInput(4);
        var bad = new Float32Array(4 * 3);
        expect(() => {
            t.transformArray(input, false, false, false, undefined, undefined, bad);
        }).toThrow(/outputArray must be Uint8ClampedArray/);
    });

    test('outputArray too small throws via transformArray', () => {
        var t = createTransform();
        var input = makeRGBInput(4);
        var small = new Uint8ClampedArray(2);
        expect(() => {
            t.transformArray(input, false, false, false, undefined, undefined, small);
        }).toThrow(/outputArray too small/);
    });
});

// ---------- Transform.reformat: the container conversion outputFormat implied ----------

describe('Transform.reformat', () => {

    // transformArray's outputFormat looked like it converted and did not: it
    // changed the container the engine allocated without touching the numbers
    // going into it, so an integer LUT mode wrote 0-255 values into a
    // Float32Array and called it float. This is the conversion that was meant.

    test('integer widths use 257, so white stays white', () => {
        // 256 would put 0xFF at 0xFF00 and drift the whole range.
        const wide = Transform.reformat(new Uint8ClampedArray([0, 128, 255]), 'int8', 'int16');
        expect(Array.from(wide)).toEqual([0, 32896, 65535]);
        expect(wide).toBeInstanceOf(Uint16Array);
    });

    test('int8 round-trips through int16 exactly', () => {
        const src = new Uint8ClampedArray(256);
        for(let i = 0; i < 256; i++) src[i] = i;
        const back = Transform.reformat(
            Transform.reformat(src, 'int8', 'int16'), 'int16', 'int8');
        expect(Array.from(back)).toEqual(Array.from(src));
    });

    test('integers become 0..1 floats and back', () => {
        const f = Transform.reformat(new Uint8ClampedArray([0, 128, 255]), 'int8', 'float32');
        expect(f).toBeInstanceOf(Float32Array);
        expect(f[0]).toBeCloseTo(0, 6);
        expect(f[1]).toBeCloseTo(128 / 255, 6);
        expect(f[2]).toBeCloseTo(1, 6);

        const back = Transform.reformat(f, 'float32', 'int8');
        expect(Array.from(back)).toEqual([0, 128, 255]);
    });

    test('writes into a supplied buffer and returns it', () => {
        const out = new Uint8ClampedArray(3);
        const got = Transform.reformat(new Uint16Array([0, 32896, 65535]), 'int16', 'int8', out);
        expect(got).toBe(out);
        expect(Array.from(out)).toEqual([0, 128, 255]);
    });

    test('same format in and out still copies into the right container', () => {
        const got = Transform.reformat(new Uint8ClampedArray([1, 2, 3]), 'int8', 'int8');
        expect(got).toBeInstanceOf(Uint8ClampedArray);
        expect(Array.from(got)).toEqual([1, 2, 3]);
    });

    test('device is 0..1 in a plain Array, same scale as float64', () => {
        const got = Transform.reformat(new Uint8ClampedArray([0, 255]), 'int8', 'device');
        expect(Array.isArray(got)).toBe(true);
        expect(got[0]).toBeCloseTo(0, 6);
        expect(got[1]).toBeCloseTo(1, 6);
    });

    test('refuses an unknown format or an undersized buffer', () => {
        expect(() => Transform.reformat(new Uint8ClampedArray(3), 'int8', 'int12'))
            .toThrow(/unknown toFormat/);
        expect(() => Transform.reformat(new Uint8ClampedArray(3), 'rgb8', 'int8'))
            .toThrow(/unknown fromFormat/);
        expect(() => Transform.reformat(new Uint8ClampedArray(3), 'int8', 'int16', new Uint16Array(2)))
            .toThrow(/needs 3/);
    });

    test('transformArray applies outputFormat instead of casting into it', () => {
        // It used to allocate the requested container and write the
        // transform's own values in unscaled: an int8 LUT mode put 0-255
        // numbers into a Float32Array and called it float. Now the values are
        // rescaled to match, so the two agree once you undo the scale.
        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create('*srgb', '*adobergb', eIntent.relative);
        const px = makeRGBInput(2);

        const native = t.array(px, false, false, false, 2);
        const asF32  = t.transformArray(px, false, false, false, 2, 'float32');
        const asU16  = t.transformArray(px, false, false, false, 2, 'int16');

        expect(asF32).toBeInstanceOf(Float32Array);
        expect(asU16).toBeInstanceOf(Uint16Array);
        for(let i = 0; i < native.length; i++){
            expect(Math.round(asF32[i] * 255)).toBe(native[i]);
            expect(Math.round(asU16[i] / 257)).toBe(native[i]);
        }

        // Asking for the format it already is costs nothing extra.
        const same = t.transformArray(px, false, false, false, 2, 'int8');
        expect(Array.from(same)).toEqual(Array.from(native));
    });

    test('deprecated, but silent — a batch loop must not print per call', () => {
        const warn = console.warn;
        const said = [];
        console.warn = m => said.push(String(m));
        try {
            const t = new Transform({ dataFormat: 'int8', buildLut: true });
            t.create('*srgb', '*adobergb', eIntent.relative);
            for(let i = 0; i < 5; i++){
                t.transformArray(makeRGBInput(2), false, false, false, 2, 'float32');
            }
        } finally { console.warn = warn; }
        expect(said.filter(m => /outputFormat/.test(m))).toEqual([]);
    });
});

test('reformat is device-scaled, which is why it must not be handed Lab', () => {
    // PCS Lab v2 tops out at 0xFF00, not 0xFFFF. This helper scales by 65535,
    // so Lab through it lands 1.0039x out — a fraction of an LSB at 8 bits,
    // and invisible until another CMS disagrees. There is no flag because a
    // buffer of numbers cannot say which it is, and guessing would be wrong
    // quietly. The test states the boundary rather than defending it.
    const LAB_TOP = 0xFF00;
    const white = Transform.reformat(new Uint8ClampedArray([255]), 'int8', 'int16');
    expect(white[0]).toBe(0xFFFF);          // device: full range
    expect(white[0]).not.toBe(LAB_TOP);     // NOT the Lab v2 ceiling
    expect(white[0] / LAB_TOP).toBeCloseTo(1.0039, 4);
});

test('a LUT attached out of band gets a kernel, rather than the input back', () => {
    // The supported route for a Transform that never ran create(): assign a
    // LUT and convert. transformArrayViaLUT() used to set the kernel itself;
    // when its body merged into array() that net briefly went with it, and the
    // failure mode was the quiet kind — no kernel, so the dispatch fell to the
    // per-pixel walk, which found an EMPTY pipeline and handed the input
    // straight back looking like a conversion.
    const grid = 9, inCh = 2, outCh = 3, cells = grid * grid;
    const CLUT = new Float64Array(cells * outCh);
    for(let i = 0; i < CLUT.length; i++) CLUT[i] = ((i * 2654435761) >>> 0) / 4294967295;
    const lut = { inputChannels: inCh, outputChannels: outCh, gridPoints: [grid, grid],
                  CLUT, inputScale: 1 / 255, outputScale: 255,
                  g1: grid, g2: grid * grid,
                  go0: outCh, go1: grid * outCh, go2: grid * grid * outCh, intLut: null };

    const px = new Uint8ClampedArray([10, 20, 128, 200]);

    function convert(setKernelFirst){
        const t = new Transform({ dataFormat: 'int8' });
        t.lut = lut;
        t.inputChannels = inCh;
        t.outputChannels = outCh;
        if(setKernelFirst) t.setKernel(inCh);
        return Array.from(t.array(px, false, false, false, 2));
    }

    const explicit = convert(true);
    const viaNet   = convert(false);

    expect(viaNet).toEqual(explicit);
    expect(viaNet.length).toBe(2 * outCh);
    // Not the input echoed back, which is what the missing net produced.
    expect(viaNet.slice(0, 2)).not.toEqual([10, 20]);

    // transformArrayViaLUT still reaches the same place.
    const t = new Transform({ dataFormat: 'int8' });
    t.lut = lut; t.inputChannels = inCh; t.outputChannels = outCh;
    expect(Array.from(t.transformArrayViaLUT(px, false, false, false, 2))).toEqual(explicit);
    expect(t.lastUsedKernel).toBe('kernel2D');
});

describe('lastUsedKernel records the route array() took', () => {
    test('LUT RGB → kernel3D; ViaLUT throws leave it unchanged', () => {
        const t = createTransform();
        expect(t.lastUsedKernel).toBe(null);
        t.array(makeRGBInput(4), false, false);
        expect(t.lastUsedKernel).toBe('kernel3D');

        const loud = new Transform({ dataFormat: 'int8' });
        expect(() => loud.transformArrayViaLUT(makeRGBInput(1), false, false))
            .toThrow('No LUT loaded');
        expect(loud.lastUsedKernel).toBe(null);
    });

    test('same-file identity → kernelIdentity', () => {
        const t = new Transform({ dataFormat: 'int8' });
        t.create('*srgb', '*srgb', eIntent.relative);
        t.array(makeRGBInput(4), false, false);
        expect(t.lastUsedKernel).toBe('kernelIdentity');
    });

    test('no LUT, not claimed → pipeline', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: false });
        t.create('*srgb', cmykProfile, eIntent.relative);
        t.array(makeRGBInput(4), false, false);
        expect(t.lastUsedKernel).toBe('pipeline');
    });

    test('pixelCache → cache', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: false, pixelCache: 1 });
        t.create('*srgb', cmykProfile, eIntent.relative);
        t.array(makeRGBInput(4), false, false);
        expect(t.lastUsedKernel).toBe('cache');
    });
});
