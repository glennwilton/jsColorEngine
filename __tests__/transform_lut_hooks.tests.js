/**
 * Tests for LUT build hooks — lutInputHook / lutOutputHook.
 *
 * Hooks run per grid cell during LUT build (zero per-pixel cost).
 * They receive and return device-space [0–1] arrays.
 */

const { Transform, eIntent } = require('../src/main');

function createXf(overrides) {
    var opts = Object.assign({
        dataFormat: 'int8',
        buildLut: true,
        verbose: false,
    }, overrides || {});
    var t = new Transform(opts);
    t.create('*srgb', '*adobergb', eIntent.relative);
    return t;
}

function makeRGB(pixels) {
    var a = new Uint8ClampedArray(pixels * 3);
    for (var i = 0; i < a.length; i++) a[i] = i & 0xFF;
    return a;
}

// ─── constructor options ───────────────────────────────────────────

describe('lutInputHook / lutOutputHook constructor options', () => {

    test('no hooks: transform works normally', () => {
        var xf = createXf();
        var inp = makeRGB(4);
        var out = xf.transformArray(inp, false, false, false, 4);
        expect(out).toBeInstanceOf(Uint8ClampedArray);
        expect(out.length).toBe(12);
    });

    test('lutOutputHook via constructor clamps a channel', () => {
        var xfPlain = createXf();
        var xfHooked = createXf({
            lutOutputHook: function (device) {
                device[0] = Math.min(device[0], 0.5);
                return device;
            },
        });

        var inp = makeRGB(64);
        var plain  = xfPlain.transformArray(inp, false, false, false, 64);
        var hooked = xfHooked.transformArray(inp.slice(), false, false, false, 64);

        var anyDiff = false;
        for (var i = 0; i < plain.length; i += 3) {
            expect(hooked[i]).toBeLessThanOrEqual(128);
            if (hooked[i] !== plain[i]) anyDiff = true;
        }
        expect(anyDiff).toBe(true);
    });

    test('lutInputHook via constructor modifies input', () => {
        var xfHooked = createXf({
            lutInputHook: function (device) {
                return [0, 0, 0];
            },
        });

        var inp = makeRGB(8);
        var out = xfHooked.transformArray(inp, false, false, false, 8);

        var firstPixel = [out[0], out[1], out[2]];
        for (var i = 3; i < out.length; i += 3) {
            expect(out[i]).toBe(firstPixel[0]);
            expect(out[i + 1]).toBe(firstPixel[1]);
            expect(out[i + 2]).toBe(firstPixel[2]);
        }
    });
});

// ─── addLutInputHook / addLutOutputHook ────────────────────────────

describe('addLutInputHook / addLutOutputHook', () => {

    test('addLutInputHook throws on non-function', () => {
        var xf = new Transform({ buildLut: true, dataFormat: 'int8' });
        expect(() => xf.addLutInputHook('not a fn')).toThrow();
    });

    test('addLutOutputHook throws on non-function', () => {
        var xf = new Transform({ buildLut: true, dataFormat: 'int8' });
        expect(() => xf.addLutOutputHook(42)).toThrow();
    });

    test('returns this for chaining', () => {
        var xf = new Transform({ buildLut: true, dataFormat: 'int8' });
        var ret = xf.addLutInputHook(v => v);
        expect(ret).toBe(xf);
    });

    test('hook added via addLutOutputHook takes effect on create()', () => {
        var xf = new Transform({ buildLut: true, dataFormat: 'int8', verbose: false });
        xf.addLutOutputHook(function (device) {
            device[0] = 0;
            return device;
        });
        xf.create('*srgb', '*adobergb', eIntent.relative);

        var inp = new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 0, 255]);
        var out = xf.transformArray(inp, false, false, false, 3);
        expect(out[0]).toBe(0);
        expect(out[3]).toBe(0);
        expect(out[6]).toBe(0);
    });
});

// ─── hook ordering (before / after) ───────────────────────────────

describe('hook ordering', () => {

    test('default (after) runs hooks in add order', () => {
        var log = [];
        var xf = new Transform({ buildLut: true, dataFormat: 'int8', verbose: false });
        xf.addLutOutputHook(function (d) { log.push('A'); return d; });
        xf.addLutOutputHook(function (d) { log.push('B'); return d; });
        xf.create('*srgb', '*adobergb', eIntent.relative);

        expect(log.length).toBeGreaterThan(0);
        for (var i = 0; i < log.length; i += 2) {
            expect(log[i]).toBe('A');
            expect(log[i + 1]).toBe('B');
        }
    });

    test('"before" prepends to the hook chain', () => {
        var log = [];
        var xf = new Transform({ buildLut: true, dataFormat: 'int8', verbose: false });
        xf.addLutOutputHook(function (d) { log.push('A'); return d; });
        xf.addLutOutputHook(function (d) { log.push('B'); return d; }, 'before');
        xf.create('*srgb', '*adobergb', eIntent.relative);

        expect(log.length).toBeGreaterThan(0);
        for (var i = 0; i < log.length; i += 2) {
            expect(log[i]).toBe('B');
            expect(log[i + 1]).toBe('A');
        }
    });
});

// ─── clearLutHooks ─────────────────────────────────────────────────

describe('clearLutHooks', () => {

    test('clears all hooks', () => {
        var xf = new Transform({ buildLut: true, dataFormat: 'int8', verbose: false });
        xf.addLutInputHook(v => v);
        xf.addLutOutputHook(v => v);
        xf.clearLutHooks();
        expect(xf._lutInputHooks.length).toBe(0);
        expect(xf._lutOutputHooks.length).toBe(0);
    });

    test('hooks cleared before create() have no effect', () => {
        var hookCalled = false;
        var xf = new Transform({ buildLut: true, dataFormat: 'int8', verbose: false });
        xf.addLutOutputHook(function (d) { hookCalled = true; return d; });
        xf.clearLutHooks();
        xf.create('*srgb', '*adobergb', eIntent.relative);
        expect(hookCalled).toBe(false);
    });
});

// ─── composability (multiple hooks chain) ──────────────────────────

describe('composability', () => {

    test('output hooks chain: second hook sees first hook output', () => {
        var xf = new Transform({ buildLut: true, dataFormat: 'int8', verbose: false });

        xf.addLutOutputHook(function (d) {
            d[0] = 0.25;
            return d;
        });
        xf.addLutOutputHook(function (d) {
            d[0] = d[0] * 2;
            return d;
        });
        xf.create('*srgb', '*adobergb', eIntent.relative);

        var inp = new Uint8ClampedArray([255, 128, 64]);
        var out = xf.transformArray(inp, false, false, false, 1);
        expect(out[0]).toBe(Math.round(0.5 * 255));
    });

    test('input hooks chain similarly', () => {
        var log = [];
        var xf = new Transform({ buildLut: true, dataFormat: 'int8', verbose: false });
        xf.addLutInputHook(function (d) {
            log.push(d.slice());
            d[0] = 1.0;
            return d;
        });
        xf.addLutInputHook(function (d) {
            expect(d[0]).toBe(1.0);
            return d;
        });
        xf.create('*srgb', '*adobergb', eIntent.relative);
        expect(log.length).toBeGreaterThan(0);
    });
});

// ─── hook receives correct channel counts ──────────────────────────

describe('hook channel count', () => {

    test('RGB→RGB: hooks receive 3-element arrays', () => {
        var inLen = null;
        var outLen = null;
        var xf = new Transform({ buildLut: true, dataFormat: 'int8', verbose: false });
        xf.addLutInputHook(function (d) { inLen = d.length; return d; });
        xf.addLutOutputHook(function (d) { outLen = d.length; return d; });
        xf.create('*srgb', '*adobergb', eIntent.relative);
        expect(inLen).toBe(3);
        expect(outLen).toBe(3);
    });
});

// ─── output hook receives original input as second arg ─────────────

describe('output hook second argument (deviceIn)', () => {

    test('output hook receives the grid-cell input as second arg', () => {
        var captured = [];
        var xf = new Transform({
            buildLut: true, dataFormat: 'int8', verbose: false,
            lutGridPoints3D: 5,
        });
        xf.addLutOutputHook(function (deviceOut, deviceIn) {
            captured.push({ in: deviceIn.slice(), out: deviceOut.slice() });
            return deviceOut;
        });
        xf.create('*srgb', '*adobergb', eIntent.relative);

        expect(captured.length).toBe(125);
        expect(captured[0].in).toEqual([0, 0, 0]);
        expect(captured[0].in.length).toBe(3);
        expect(captured[0].out.length).toBe(3);
        var last = captured[captured.length - 1];
        expect(last.in).toEqual([1, 1, 1]);
    });
});

// ─── hook call count ───────────────────────────────────────────────

describe('hook call count', () => {

    test('3D LUT: hook called gridPoints^3 times', () => {
        var count = 0;
        var gridPts = 9;
        var xf = new Transform({
            buildLut: true, dataFormat: 'int8', verbose: false,
            lutGridPoints3D: gridPts,
        });
        xf.addLutInputHook(function (d) { count++; return d; });
        xf.create('*srgb', '*adobergb', eIntent.relative);
        expect(count).toBe(gridPts * gridPts * gridPts);
    });
});
