'use strict';

var main      = require('../src/main');
var convert   = main.convert;
var Transform = main.Transform;
var eIntent   = main.eIntent;
var Profile   = main.Profile;

// ============================================================ convert.labEncoding

describe('convert.labEncoding presets', function () {
    test('v2 preset has correct constants', function () {
        var enc = convert.labEncoding.v2;
        expect(enc.pcsVersion).toBe(2);
        expect(enc.labNumerator).toBe(65280);
        expect(enc.lMul).toBeCloseTo(652.80, 4);
        expect(enc.abMul).toBeCloseTo(256, 4);
        expect(enc.lInvMul).toBeCloseTo(100 / 65280, 10);
        expect(enc.abInvMul).toBeCloseTo(255 / 65280, 10);
    });

    test('v4 preset has correct constants', function () {
        var enc = convert.labEncoding.v4;
        expect(enc.pcsVersion).toBe(4);
        expect(enc.labNumerator).toBe(65535);
        expect(enc.lMul).toBeCloseTo(655.35, 4);
        expect(enc.abMul).toBeCloseTo(257, 4);
        expect(enc.lInvMul).toBeCloseTo(100 / 65535, 10);
        expect(enc.abInvMul).toBeCloseTo(255 / 65535, 10);
    });

    test('presets are frozen', function () {
        expect(Object.isFrozen(convert.labEncoding.v2)).toBe(true);
        expect(Object.isFrozen(convert.labEncoding.v4)).toBe(true);
    });
});

// ============================================================ convert.lab2Int16

describe('convert.lab2Int16', function () {
    test('v4 L=100 → 65535', function () {
        var u = convert.lab2Int16(100, 0, 0, 'v4');
        expect(u[0]).toBe(65535);
    });

    test('v4 L=0 → 0', function () {
        var u = convert.lab2Int16(0, 0, 0, 'v4');
        expect(u[0]).toBe(0);
    });

    test('v4 a=0 → 0x8080 (32896)', function () {
        var u = convert.lab2Int16(50, 0, 0, 'v4');
        expect(u[1]).toBe(128 * 257);  // 32896 = 0x8080
    });

    test('v4 a=-128 → 0', function () {
        var u = convert.lab2Int16(50, -128, 0, 'v4');
        expect(u[1]).toBe(0);
    });

    test('v4 a=+127 → 65535', function () {
        var u = convert.lab2Int16(50, 127, 0, 'v4');
        expect(u[1]).toBe(65535);
    });

    test('v2 L=100 → 65280 (0xFF00)', function () {
        var u = convert.lab2Int16(100, 0, 0, 'v2');
        expect(u[0]).toBe(65280);
    });

    test('v2 a=0 → 32768 (0x8000)', function () {
        var u = convert.lab2Int16(50, 0, 0, 'v2');
        expect(u[1]).toBe(128 * 256);  // 32768 = 0x8000
    });

    test('v2 a=-128 → 0', function () {
        var u = convert.lab2Int16(50, -128, 0, 'v2');
        expect(u[1]).toBe(0);
    });

    test('v2 a=+127 → 65280', function () {
        var u = convert.lab2Int16(50, 127, 0, 'v2');
        expect(u[1]).toBe(255 * 256);  // 65280
    });

    test('accepts encoding object directly', function () {
        var u = convert.lab2Int16(100, 0, 0, convert.labEncoding.v4);
        expect(u[0]).toBe(65535);
    });

    test('clamps negative u16 to 0', function () {
        var u = convert.lab2Int16(-10, -200, -200, 'v4');
        expect(u[0]).toBe(0);
        expect(u[1]).toBe(0);
        expect(u[2]).toBe(0);
    });

    test('clamps over-range u16 to 65535', function () {
        var u = convert.lab2Int16(200, 200, 200, 'v4');
        expect(u[0]).toBe(65535);
        expect(u[1]).toBe(65535);
        expect(u[2]).toBe(65535);
    });

    test('throws on unknown string encoding', function () {
        expect(function () { convert.lab2Int16(50, 0, 0, 'v5'); }).toThrow();
    });
});

// ============================================================ convert.int162Lab

describe('convert.int162Lab', function () {
    test('v4 round-trip L=50, a=20, b=-30', function () {
        var u = convert.lab2Int16(50, 20, -30, 'v4');
        var lab = convert.int162Lab(u[0], u[1], u[2], 'v4');
        expect(lab.L).toBeCloseTo(50, 1);
        expect(lab.a).toBeCloseTo(20, 1);
        expect(lab.b).toBeCloseTo(-30, 1);
    });

    test('v2 round-trip L=50, a=20, b=-30', function () {
        var u = convert.lab2Int16(50, 20, -30, 'v2');
        var lab = convert.int162Lab(u[0], u[1], u[2], 'v2');
        expect(lab.L).toBeCloseTo(50, 1);
        expect(lab.a).toBeCloseTo(20, 1);
        expect(lab.b).toBeCloseTo(-30, 1);
    });

    test('v4 returns typed Lab object with D50 whitepoint', function () {
        var lab = convert.int162Lab(32768, 32896, 32896, 'v4');
        expect(lab).toHaveProperty('type');
        expect(lab).toHaveProperty('whitePoint');
        expect(lab.whitePoint).toBe(convert.d50);
    });

    test('v4 u16=0 decodes to L=0, a=-128, b=-128', function () {
        var lab = convert.int162Lab(0, 0, 0, 'v4');
        expect(lab.L).toBeCloseTo(0, 5);
        expect(lab.a).toBeCloseTo(-128, 5);
        expect(lab.b).toBeCloseTo(-128, 5);
    });

    test('v4 u16=65535 decodes to L=100, a=+127, b=+127', function () {
        var lab = convert.int162Lab(65535, 65535, 65535, 'v4');
        expect(lab.L).toBeCloseTo(100, 5);
        expect(lab.a).toBeCloseTo(127, 5);
        expect(lab.b).toBeCloseTo(127, 5);
    });

    test('round-trip error within 0.01 for arbitrary Lab values (v4)', function () {
        var cases = [
            [0, 0, 0], [100, 0, 0], [50, -80, 60],
            [25, 127, -128], [75, -10, 90]
        ];
        for (var i = 0; i < cases.length; i++) {
            var c = cases[i];
            var u = convert.lab2Int16(c[0], c[1], c[2], 'v4');
            var lab = convert.int162Lab(u[0], u[1], u[2], 'v4');
            expect(Math.abs(lab.L - c[0])).toBeLessThan(0.01);
            expect(Math.abs(lab.a - c[1])).toBeLessThan(0.01);
            expect(Math.abs(lab.b - c[2])).toBeLessThan(0.01);
        }
    });
});

// ============================================================ Transform wrappers + lut.inLab / outLab

describe('Transform Lab int16 wrappers', function () {
    var xformLabToRgb, xformRgbToLab, xformRgbToCmyk;

    beforeAll(function () {
        xformRgbToLab = new Transform({ dataFormat: 'int16', buildLut: true });
        xformRgbToLab.create('*srgb', '*Lab', eIntent.relative);

        xformLabToRgb = new Transform({ dataFormat: 'int16', buildLut: true });
        xformLabToRgb.create('*Lab', '*srgb', eIntent.relative);

        xformRgbToCmyk = new Transform({ dataFormat: 'int16', buildLut: true });
        var gracol = new Profile();
        gracol.loadBinary(require('fs').readFileSync(
            require('path').join(__dirname, '..', 'samples', 'profiles', 'CoatedGRACoL2006.icc')
        ));
        xformRgbToCmyk.create('*srgb', gracol, eIntent.relative);
    });

    test('lut.outLab is set for RGB → Lab transform', function () {
        expect(xformRgbToLab.lut.outLab).not.toBeNull();
        expect(xformRgbToLab.lut.outLab.pcsVersion).toBeDefined();
        expect(xformRgbToLab.lut.inLab).toBeNull();
    });

    test('lut.inLab is set for Lab → RGB transform', function () {
        expect(xformLabToRgb.lut.inLab).not.toBeNull();
        expect(xformLabToRgb.lut.inLab.pcsVersion).toBeDefined();
        expect(xformLabToRgb.lut.outLab).toBeNull();
    });

    test('lut.inLab and outLab are both null for RGB → CMYK', function () {
        expect(xformRgbToCmyk.lut.inLab).toBeNull();
        expect(xformRgbToCmyk.lut.outLab).toBeNull();
    });

    test('outputLab2Int16 works on RGB → Lab transform', function () {
        var u = xformRgbToLab.outputLab2Int16(50, 0, 0);
        expect(u).toHaveLength(3);
        expect(u[0]).toBeGreaterThan(0);
        expect(u[0]).toBeLessThanOrEqual(65535);
    });

    test('outputInt162Lab works on RGB → Lab transform', function () {
        var u = xformRgbToLab.outputLab2Int16(75, -20, 40);
        var lab = xformRgbToLab.outputInt162Lab(u[0], u[1], u[2]);
        expect(lab.L).toBeCloseTo(75, 1);
        expect(lab.a).toBeCloseTo(-20, 1);
        expect(lab.b).toBeCloseTo(40, 1);
    });

    test('inputLab2Int16 works on Lab → RGB transform', function () {
        var u = xformLabToRgb.inputLab2Int16(50, 0, 0);
        expect(u).toHaveLength(3);
        expect(u[0]).toBeGreaterThan(0);
    });

    test('inputInt162Lab works on Lab → RGB transform', function () {
        var u = xformLabToRgb.inputLab2Int16(60, 10, -25);
        var lab = xformLabToRgb.inputInt162Lab(u[0], u[1], u[2]);
        expect(lab.L).toBeCloseTo(60, 1);
        expect(lab.a).toBeCloseTo(10, 1);
        expect(lab.b).toBeCloseTo(-25, 1);
    });

    test('inputLab2Int16 throws on non-Lab input PCS', function () {
        expect(function () {
            xformRgbToLab.inputLab2Int16(50, 0, 0);
        }).toThrow(/input PCS is not Lab/);
    });

    test('outputLab2Int16 throws on non-Lab output PCS', function () {
        expect(function () {
            xformLabToRgb.outputLab2Int16(50, 0, 0);
        }).toThrow(/output PCS is not Lab/);
    });

    test('outputInt162Lab throws on non-Lab output PCS', function () {
        expect(function () {
            xformRgbToCmyk.outputInt162Lab(32768, 32768, 32768);
        }).toThrow(/output PCS is not Lab/);
    });
});
