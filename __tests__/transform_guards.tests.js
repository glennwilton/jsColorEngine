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

test('transformArray throws when preserveAlpha=true but inputHasAlpha=false (pipeline path)', () => {
    var t = new Transform({ dataFormat: 'int8', buildLut: false, verbose: false });
    t.create('*srgb', '*adobergb', eIntent.relative);
    var input = makeRGBInput(4);
    expect(() => t.transformArray(input, false, false, true)).toThrow('preserveAlpha');
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
    });

    test('int8 mode — oversized Uint8ClampedArray is fine', () => {
        var t = createTransform();
        var input = makeRGBInput(4);
        var out = new Uint8ClampedArray(4 * 3 + 100);
        expect(() => {
            t.transformArrayViaLUT(input, false, false, false, undefined, out);
        }).not.toThrow();
    });

    test('int16 mode — Uint16Array of correct size', () => {
        var t = createTransform({ lutMode: 'int16' });
        var input = new Uint16Array(4 * 3);
        for (var i = 0; i < input.length; i++) input[i] = i * 256;
        var out = new Uint16Array(4 * 3);
        expect(() => {
            t.transformArrayViaLUT(input, false, false, false, undefined, out);
        }).not.toThrow();
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
