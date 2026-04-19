/* Regression tests for decodeICC fixes:
 *   P1 — parametric type 3 (sRGB) used to reference params[5]/[6] (out of
 *        range for the 5-param spec) and silently returned NaN.
 *   P2 — `curv` midpoint gamma estimate read curve.data[count/2], which
 *        is undefined (and gives NaN) for odd counts.
 */
var decoder = require('../src/decodeICC.js');

function s15Bytes(v) {
    var n = Math.round(v * 0x10000);
    if (n < 0) n = 0x100000000 + n;
    return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF];
}

function buildParaType3() {
    // sRGB parametric type-3 params: g, a, b, c, d
    var params = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045];
    var bytes = [];
    'para'.split('').forEach(function (c) { bytes.push(c.charCodeAt(0)); });
    bytes.push(0, 0, 0, 0);
    bytes.push(0, 3, 0, 0);
    params.forEach(function (p) { s15Bytes(p).forEach(function (b) { bytes.push(b); }); });
    return new Uint8Array(bytes);
}

function buildCurvOddCount() {
    var bytes = [];
    'curv'.split('').forEach(function (c) { bytes.push(c.charCodeAt(0)); });
    bytes.push(0, 0, 0, 0);
    bytes.push(0, 0, 0, 5); // count = 5 (odd)
    [0, 16384, 32768, 49152, 65535].forEach(function (s) {
        bytes.push((s >>> 8) & 0xFF, s & 0xFF);
    });
    return new Uint8Array(bytes);
}

describe('decodeICC parametric curve type 3 (sRGB)', function () {
    test('forward at x=0.5 matches sRGB linearization', function () {
        var fwd = decoder.curve(buildParaType3(), 0, false);
        var y = fwd.curveFn(fwd.params, 0.5);
        expect(isFinite(y)).toBe(true);
        expect(y).toBeCloseTo(0.21404, 3);
    });

    test('forward in linear region matches Y = X / c', function () {
        var fwd = decoder.curve(buildParaType3(), 0, false);
        var ylow = fwd.curveFn(fwd.params, 0.02);
        expect(ylow).toBeCloseTo(0.02 / 12.92, 5);
    });

    test('inverse round-trips a sample through the gamma branch', function () {
        var fwd = decoder.curve(buildParaType3(), 0, false);
        var inv = decoder.curve(buildParaType3(), 0, true);
        var y = fwd.curveFn(fwd.params, 0.5);
        var x = inv.curveFn(inv.params, y);
        expect(x).toBeCloseTo(0.5, 4);
    });
});

describe('decodeICC curv midpoint gamma estimate', function () {
    test('odd count produces a finite gamma (not NaN)', function () {
        var c = decoder.curve(buildCurvOddCount(), 0, false);
        expect(isFinite(c.gamma)).toBe(true);
        // linear ramp → gamma ≈ 1.0
        expect(c.gamma).toBeCloseTo(1.0, 2);
    });
});

function buildUnsupportedLut() {
    // 4-byte type signature 'XXXX' that no LUT branch handles
    var bytes = [];
    'XXXX'.split('').forEach(function (c) { bytes.push(c.charCodeAt(0)); });
    while (bytes.length < 32) bytes.push(0);
    return new Uint8Array(bytes);
}

describe('decodeICC unsupported LUT type', function () {
    test('returns a structurally valid sentinel LUT (no NaN strides)', function () {
        var origWarn = console.warn;
        var warned = false;
        console.warn = function () { warned = true; };
        try {
            var lut = decoder.lut(buildUnsupportedLut(), 0);

            expect(lut.invalid).toBe(true);
            expect(typeof lut.errorReason).toBe('string');
            expect(lut.errorReason).toMatch(/unsupported LUT type/);

            // Defensive defaults must not be NaN/undefined
            expect(lut.inputChannels).toBe(3);
            expect(lut.outputChannels).toBe(3);
            expect(lut.gridPoints).toEqual([2, 2, 2]);
            expect(lut.CLUT).toBeInstanceOf(Uint8Array);
            expect(lut.CLUT.length).toBe(2 * 2 * 2 * 3);

            // Stride pre-compute reads g1..g3, go0..go3 — must all be finite
            expect(lut.g1).toBe(2);
            expect(lut.g2).toBe(4);
            expect(lut.g3).toBe(8);
            expect(isFinite(lut.go0)).toBe(true);
            expect(isFinite(lut.go1)).toBe(true);
            expect(isFinite(lut.go2)).toBe(true);
            expect(isFinite(lut.go3)).toBe(true);

            expect(warned).toBe(true);
        } finally {
            console.warn = origWarn;
        }
    });
});
