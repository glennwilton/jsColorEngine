/**
 * Plugin architecture — identity kernel / builder tests.
 *
 * Coverage matrix:
 *   1.  registerKernel accepts a new lutMode name without warning
 *   2.  registerBuilder is stored and called instead of createLut()
 *   3.  RGB→RGB (3D 3ch) — output is byte-identical to input
 *   4.  CMYK→CMYK (4D 4ch) — output is byte-identical to input
 *   5.  RGB→CMYK — builder throws on channel mismatch before create() completes
 *   6.  Alpha: preserveAlpha copies alpha channel through unchanged
 *   7.  Alpha: outputHasAlpha && !inputHasAlpha fills alpha with 255
 *   8.  Kernel is resolved once at create() time — kernel.arrayFnBig is
 *       non-null and kernel.threshold is 0 (no WASM split needed)
 *   9.  registerKernel throws on missing descriptor.js
 *   10. registerBuilder throws on non-function builderFn
 *   11. Unknown lutMode still falls back to 'auto' (plugin not registered)
 *
 * This file also serves as the reference for how to write tests against
 * the plugin API — same structure as the built-in lutMode tests.
 */

'use strict';

const { Transform, eIntent } = require('../src/main');
const Profile                = require('../src/Profile');
const path                   = require('path');
const fs                     = require('fs');

const CMYK_ICC = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

// ── Identity plugin (local registration — isolated to this test file) ─────────
//
// Registered with a unique name so it doesn't conflict with any globally
// registered plugins in other test files.

const PLUGIN_MODE = 'identity-test';

function identityKernel(transform, inputArray, outputArray, pixelCount, lut,
                        inputHasAlpha, outputHasAlpha, preserveAlpha) {
    const channels    = lut.inputChannels;
    const inputStride = channels + (inputHasAlpha  ? 1 : 0);
    const outStride   = channels + (outputHasAlpha ? 1 : 0);

    for (let pixel = 0; pixel < pixelCount; pixel++) {
        const inOffset  = pixel * inputStride;
        const outOffset = pixel * outStride;

        for (let channel = 0; channel < channels; channel++) {
            outputArray[outOffset + channel] = inputArray[inOffset + channel];
        }
        if (outputHasAlpha) {
            outputArray[outOffset + channels] = (preserveAlpha && inputHasAlpha)
                ? inputArray[inOffset + channels]
                : 255;
        }
    }
}

function identityBuilder(transform) {
    const lut = transform.createLut();

    if (lut.inputChannels !== lut.outputChannels) {
        throw new Error(
            'identity plugin: channel mismatch — ' +
            'input is ' + lut.inputChannels + 'ch but output is ' + lut.outputChannels + 'ch'
        );
    }

    lut.CLUT = new Float64Array(0);
    return lut;
}

Transform.register({
    name:    'identity-plugin-test',
    lutMode: PLUGIN_MODE,
    kernel:  identityKernel,
    builder: identityBuilder,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCmykProfile() {
    const p = new Profile();
    p.loadBinary(fs.readFileSync(CMYK_ICC));
    return p;
}

function pixelsMatch(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('plugin: identity kernel — registration', () => {

    test('getPlugins: returns entry with name, lutMode, and meta', () => {
        const plugins = Transform.registered();
        const entry = plugins.find(p => p.lutMode === PLUGIN_MODE);
        expect(entry).toBeDefined();
        expect(entry.name).toBe('identity-plugin-test');
        expect(entry.lutMode).toBe(PLUGIN_MODE);
        expect(entry.meta).toBeNull();   // identity plugin has no meta
    });

    test('meta — static object: pluginMeta() returns the object unchanged', () => {
        const staticMeta = { version: '1.0', url: 'https://example.com' };
        Transform.register({
            name:    'meta-static-test',
            lutMode: 'meta-static',
            kernel:  identityKernel,
            meta:    staticMeta,
        });
        const t = new Transform({ buildLut: true, lutMode: 'meta-static', dataFormat: 'int8' });
        t.create('*sRGB', '*sRGB', eIntent.relative);
        expect(t.registeredMeta()).toBe(staticMeta);
        expect(t.registeredMeta().version).toBe('1.0');
    });

    test('meta — function: pluginMeta() calls it with transform as this', () => {
        Transform.register({
            name:    'meta-dynamic-test',
            lutMode: 'meta-dynamic',
            kernel:  identityKernel,
            initialise: (transform, rawOpts) => { transform.testValue = rawOpts.testValue; },
            meta:    function() { return 'testValue=' + this.testValue + ',lutMode=' + this.lutMode; },
        });
        const t = new Transform({ buildLut: true, lutMode: 'meta-dynamic', dataFormat: 'int8', testValue: 42 });
        t.create('*sRGB', '*sRGB', eIntent.relative);
        expect(t.registeredMeta()).toBe('testValue=42,lutMode=meta-dynamic');
    });

    test('pluginMeta() returns null for non-plugin lutMode', () => {
        const t = new Transform({ dataFormat: 'int8' });
        expect(t.registeredMeta()).toBeNull();
    });

    test('registerKernel: mode is accepted by constructor without warning', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const t = new Transform({ buildLut: true, lutMode: PLUGIN_MODE, dataFormat: 'int8' });
        expect(t.lutMode).toBe(PLUGIN_MODE);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });

    test('register: throws when descriptor.lutMode is missing', () => {
        expect(() => Transform.register({ name: 'bad', kernel: identityKernel }))
            .toThrow('descriptor.lutMode');
    });

    test('register: throws when descriptor.kernel is missing', () => {
        expect(() => Transform.register({ name: 'bad', lutMode: 'bad' }))
            .toThrow('descriptor.kernel');
    });

    test('register: throws when descriptor.name is missing', () => {
        expect(() => Transform.register({ lutMode: 'x', kernel: identityKernel }))
            .toThrow('descriptor.name');
    });

    test('register: returns true on success', () => {
        const result = Transform.register({ name: 'ret-test', lutMode: 'ret-test', kernel: identityKernel });
        expect(result).toBe(true);
    });

    test('register: returns false and does not overwrite on duplicate lutMode', () => {
        Transform.register({ name: 'dup-original', lutMode: 'dup-test', kernel: identityKernel });
        const result = Transform.register({ name: 'dup-overwrite', lutMode: 'dup-test', kernel: identityKernel });
        expect(result).toBe(false);
        // original is unchanged
        const entry = Transform.registered().find(p => p.lutMode === 'dup-test');
        expect(entry.name).toBe('dup-original');
    });

    test('register: throws when descriptor.builder is not a function', () => {
        expect(() => Transform.register({ name: 'bad', lutMode: 'bad', kernel: identityKernel, builder: 'not-a-function' }))
            .toThrow('descriptor.builder');
    });

    test('register: throws when descriptor.serializer is not a function', () => {
        expect(() => Transform.register({ name: 'bad', lutMode: 'bad', kernel: identityKernel, serializer: 42 }))
            .toThrow('descriptor.serializer');
    });

    test('unknown lutMode (not registered) falls back to auto without crash', () => {
        const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const t = new Transform({ buildLut: true, lutMode: 'no-such-mode', dataFormat: 'int8', verbose: true });
        // Should have warned and resolved to a built-in mode
        expect(t.lutMode).not.toBe('no-such-mode');
        spy.mockRestore();
    });

});

describe('plugin: identity kernel — RGB→RGB (3D 3ch)', () => {

    let transform;
    const input = new Uint8ClampedArray([
        255,   0,   0,   // red
          0, 255,   0,   // green
          0,   0, 255,   // blue
        128, 128, 128,   // mid grey
          0,   0,   0,   // black
        255, 255, 255,   // white
    ]);

    beforeAll(() => {
        // detectIdentity:false — this suite tests kernel resolution, not color correctness.
        // The identity path skips LUT building so kernel.arrayFnBig would be null.
        transform = new Transform({ buildLut: true, lutMode: PLUGIN_MODE, dataFormat: 'int8', detectIdentity: false });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
    });

    test('kernel is resolved once — kernel.arrayFnBig is set', () => {
        expect(transform.kernel.arrayFnBig).toBeInstanceOf(Function);
    });

    test('kernel.threshold is 0 (no WASM split)', () => {
        expect(transform.kernel.threshold).toBe(0);
    });

    test('output is byte-identical to input', () => {
        const output = transform.transformArray(input);
        expect(transform.lastUsedKernel).toBe('kernel3D');
        expect(pixelsMatch(input, output)).toBe(true);
    });

    test('output has correct length', () => {
        const output = transform.transformArray(input);
        expect(transform.lastUsedKernel).toBe('kernel3D');
        expect(output.length).toBe(input.length);
    });

});

describe('plugin: identity kernel — CMYK→CMYK (4D 4ch)', () => {

    let transform;
    const input = new Uint8ClampedArray([
          0,   0,   0,   0,   // paper white
        255,   0,   0, 255,   // max ink
        128,  64,  32, 200,   // arbitrary
          0,   0,   0, 255,   // black
    ]);

    beforeAll(() => {
        const cmyk = makeCmykProfile();
        transform = new Transform({ buildLut: true, lutMode: PLUGIN_MODE, dataFormat: 'int8' });
        transform.create(cmyk, cmyk, eIntent.relative);
    });

    test('output is byte-identical to input', () => {
        const output = transform.transformArray(input);
        expect(transform.lastUsedKernel).toBe('kernelIdentity');
        expect(pixelsMatch(input, output)).toBe(true);
    });

});

describe('plugin: identity kernel — channel mismatch throws', () => {

    test('RGB→CMYK throws during create() with clear message', () => {
        const cmyk = makeCmykProfile();
        const t = new Transform({ buildLut: true, lutMode: PLUGIN_MODE, dataFormat: 'int8' });
        expect(() => t.create('*sRGB', cmyk, eIntent.perceptual))
            .toThrow('channel mismatch');
    });

    test('CMYK→RGB throws during create() with clear message', () => {
        const cmyk = makeCmykProfile();
        const t = new Transform({ buildLut: true, lutMode: PLUGIN_MODE, dataFormat: 'int8' });
        expect(() => t.create(cmyk, '*sRGB', eIntent.perceptual))
            .toThrow('channel mismatch');
    });

});

describe('plugin: use() installs hooks per instance, no double-up on forced rebuild', () => {

    test('hooks added via t.use() fire correctly and survive forced LUT rebuild', () => {
        let hookCallCount = 0;

        const HookBehaviour = {
            name:   'hook-count-test',
            apply: (transform) => {
                transform.addLutOutputHook(function(vals) { hookCallCount++; return vals; });
            },
        };

        const t = new Transform({ buildLut: true, lutMode: PLUGIN_MODE, dataFormat: 'int8', detectIdentity: false });
        t.use(HookBehaviour);
        t.create('*sRGB', '*sRGB', eIntent.relative);

        expect(hookCallCount).toBeGreaterThan(0);   // hook fired during build
        const countFirst = hookCallCount;

        // Force a rebuild — use() was not called again, so hook is still there
        // once. clear() is the supported reset: it drops the LUT, pipeline,
        // WASM state and pool registration, but keeps hooks and options, which
        // is exactly what this test is about.
        t.clear();
        hookCallCount = 0;
        t.create('*sRGB', '*sRGB', eIntent.relative);

        expect(hookCallCount).toBe(countFirst);     // same count — not doubled
    });

    test('user hooks survive forced rebuild without doubling', () => {
        let userCallCount = 0;

        const t = new Transform({ buildLut: true, lutMode: PLUGIN_MODE, dataFormat: 'int8', detectIdentity: false });
        t.addLutOutputHook(function(vals) { userCallCount++; return vals; });

        t.create('*sRGB', '*sRGB', eIntent.relative);
        const countFirst = userCallCount;
        expect(countFirst).toBeGreaterThan(0);

        t.clear();
        userCallCount = 0;
        t.create('*sRGB', '*sRGB', eIntent.relative);

        expect(userCallCount).toBe(countFirst);     // same count, not doubled
    });

});

describe('plugin: identity kernel — alpha handling', () => {

    let transform;

    beforeAll(() => {
        transform = new Transform({
            buildLut:     true,
            lutMode:      PLUGIN_MODE,
            dataFormat:   'int8',
        });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
    });

    test('preserveAlpha: alpha channel is copied through unchanged', () => {
        // 4 bytes per pixel: R G B A
        const input = new Uint8ClampedArray([
            255, 0, 0, 200,   // red, alpha=200
              0, 0, 0, 128,   // black, alpha=128
        ]);
        // transformArray(pixels, inputHasAlpha, outputHasAlpha, preserveAlpha)
        const output = transform.transformArray(input, true, true, true);
        expect(transform.lastUsedKernel).toBe('kernelIdentity');
        // colour channels copied
        expect(output[0]).toBe(255);
        expect(output[1]).toBe(0);
        expect(output[2]).toBe(0);
        // alpha preserved
        expect(output[3]).toBe(200);
        expect(output[7]).toBe(128);
    });

    test('outputHasAlpha && !inputHasAlpha: alpha filled with 255', () => {
        const input = new Uint8ClampedArray([100, 150, 200]);  // 1 pixel, no alpha
        const output = transform.transformArray(input, false, true, false);
        expect(transform.lastUsedKernel).toBe('kernelIdentity');
        expect(output[0]).toBe(100);
        expect(output[1]).toBe(150);
        expect(output[2]).toBe(200);
        expect(output[3]).toBe(255);   // filled
    });

});
