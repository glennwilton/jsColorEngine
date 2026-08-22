/**
 * Plugin architecture — builder / kernel isolation tests.
 *
 * The identity tests confirm the pipeline produces correct results, but
 * they cannot prove which component is responsible — an inert builder and
 * a pass-through kernel produce the same output as a working builder and a
 * correct kernel.
 *
 * These tests use three deliberately asymmetric plugin modes that make each
 * component's contribution visible:
 *
 *   'test-fixed-clut'   builder writes a fixed value into the CLUT;
 *                       kernel reads CLUT and emits that value.
 *                       → proves builder data survives into the kernel.
 *
 *   'test-invert'       builder is the standard createLut() path (unchanged);
 *                       kernel inverts each channel (255 − input).
 *                       → proves the kernel receives and transforms live input.
 *
 *   'test-both'         builder stores a known value on the lut object;
 *                       kernel emits 255 − lut.knownValue for every channel.
 *                       → proves a custom builder field reaches the kernel
 *                         and is used — neither alone could produce the result.
 */

'use strict';

const { Transform, eIntent } = require('../src/main');
const Profile                = require('../src/Profile');
const path                   = require('path');
const fs                     = require('fs');

const CMYK_ICC = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

function makeCmykProfile() {
    const p = new Profile();
    p.loadBinary(fs.readFileSync(CMYK_ICC));
    return p;
}

// ── Mode 1: test-fixed-clut ───────────────────────────────────────────────────
//
// Builder fills the entire CLUT with a known constant (200/255 in [0,1]).
// Kernel reads lut.CLUT[0] back and writes that byte value to every output
// channel — input pixels are deliberately ignored.
//
// If the builder is broken (CLUT not filled):  output ≠ 200
// If the kernel is broken (CLUT not read):     output would be something else
// Both working:                                every output byte is 200

const FIXED_VALUE = 200;

function fixedClutBuilder(transform) {
    const lut = transform.createLut();
    lut.CLUT.fill(FIXED_VALUE / 255);   // normalize to [0,1] — same as createLut() contract
    return lut;
}

function fixedClutKernel(transform, inputArray, outputArray, pixelCount, lut,
                         inputHasAlpha, outputHasAlpha, preserveAlpha) {
    // Read the value the builder wrote, scale back to u8
    const value = Math.round(lut.CLUT[0] * 255);
    const channels = lut.outputChannels;
    const outStride = channels + (outputHasAlpha ? 1 : 0);

    for (let pixel = 0; pixel < pixelCount; pixel++) {
        const outOffset = pixel * outStride;
        for (let channel = 0; channel < channels; channel++) {
            outputArray[outOffset + channel] = value;
        }
        if (outputHasAlpha) outputArray[outOffset + channels] = 255;
    }
}

Transform.register({ name: 'test-fixed-clut', lutMode: 'test-fixed-clut', kernel: fixedClutKernel, builder: fixedClutBuilder });


// ── Mode 2: test-invert ───────────────────────────────────────────────────────
//
// Builder is the unmodified standard path (transform.createLut()).
// Kernel inverts each input channel: output = 255 − input.  CLUT is not read.
//
// If the kernel is broken (input not received):    output ≠ 255 − input
// If the builder is broken (lut shape invalid):    create() or kernel would crash
// Both working:                                    output[i] === 255 − input[i]

function invertKernel(transform, inputArray, outputArray, pixelCount, lut,
                      inputHasAlpha, outputHasAlpha, preserveAlpha) {
    const channels    = lut.inputChannels;
    const inputStride = channels + (inputHasAlpha  ? 1 : 0);
    const outStride   = channels + (outputHasAlpha ? 1 : 0);

    for (let pixel = 0; pixel < pixelCount; pixel++) {
        const inOffset  = pixel * inputStride;
        const outOffset = pixel * outStride;
        for (let channel = 0; channel < channels; channel++) {
            outputArray[outOffset + channel] = 255 - inputArray[inOffset + channel];
        }
        if (outputHasAlpha) outputArray[outOffset + channels] = 255;
    }
}

function standardBuilder(transform) {
    return transform.createLut();   // no modifications — proves kernel, not builder
}

Transform.register({ name: 'test-invert', lutMode: 'test-invert', kernel: invertKernel, builder: standardBuilder });


// ── Mode 3: test-both ─────────────────────────────────────────────────────────
//
// Builder stores a specific number on the lut (knownValue = 42).
// Kernel reads lut.knownValue and emits 255 − knownValue for every channel.
// Input pixels are ignored; CLUT is not used.
//
// Breakdown of what would break each:
//   builder broken (knownValue not set):   lut.knownValue === undefined → output NaN/255
//   kernel broken (not reading knownValue): output would be something other than 213
//   both working:                           every output byte is 255 − 42 = 213

const KNOWN_VALUE    = 42;
const INVERTED_VALUE = 255 - KNOWN_VALUE;   // 213

function knownValueBuilder(transform) {
    const lut = transform.createLut();
    lut.knownValue = KNOWN_VALUE;           // custom field — survives into kernel
    lut.CLUT = new Float64Array(0);         // unused
    return lut;
}

function invertFromKnownKernel(transform, inputArray, outputArray, pixelCount, lut,
                               inputHasAlpha, outputHasAlpha, preserveAlpha) {
    // If builder didn't set knownValue, this will produce garbage
    const value = 255 - lut.knownValue;
    const channels = lut.outputChannels;
    const outStride = channels + (outputHasAlpha ? 1 : 0);

    for (let pixel = 0; pixel < pixelCount; pixel++) {
        const outOffset = pixel * outStride;
        for (let channel = 0; channel < channels; channel++) {
            outputArray[outOffset + channel] = value;
        }
        if (outputHasAlpha) outputArray[outOffset + channels] = 255;
    }
}

Transform.register({ name: 'test-both', lutMode: 'test-both', kernel: invertFromKnownKernel, builder: knownValueBuilder });


// ── Helpers ───────────────────────────────────────────────────────────────────

function allChannelsEqual(array, value, channels, pixelCount) {
    for (let pixel = 0; pixel < pixelCount; pixel++) {
        for (let channel = 0; channel < channels; channel++) {
            if (array[pixel * channels + channel] !== value) return false;
        }
    }
    return true;
}

const RGB_INPUT = new Uint8ClampedArray([
    100, 150, 200,
     50,  75, 125,
      0, 128, 255,
]);
const RGB_PIXELS = 3;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('plugin isolation: builder proves data reaches kernel', () => {

    let transform;

    beforeAll(() => {
        transform = new Transform({ buildLut: true, lutMode: 'test-fixed-clut', dataFormat: 'int8', detectIdentity: false });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
    });

    test('output is FIXED_VALUE (200) for every channel regardless of input', () => {
        const output = transform.transformArray(RGB_INPUT);
        expect(transform.lastUsedKernel).toBe('kernel3D');
        expect(allChannelsEqual(output, FIXED_VALUE, 3, RGB_PIXELS)).toBe(true);
    });

    test('output does not match input (builder rewrote the CLUT)', () => {
        const output = transform.transformArray(RGB_INPUT);
        expect(transform.lastUsedKernel).toBe('kernel3D');
        // Input has values like 100, 150, 200 — output should be all 200, not those values
        let inputEchoed = true;
        for (let i = 0; i < RGB_INPUT.length; i++) {
            if (output[i] !== RGB_INPUT[i]) { inputEchoed = false; break; }
        }
        expect(inputEchoed).toBe(false);
    });

    test('builder field lut.CLUT[0] is the expected normalized value', () => {
        expect(transform.lut.CLUT[0]).toBeCloseTo(FIXED_VALUE / 255, 5);
    });

});


describe('plugin isolation: kernel proves it receives and transforms input', () => {

    let transform;

    beforeAll(() => {
        transform = new Transform({ buildLut: true, lutMode: 'test-invert', dataFormat: 'int8', detectIdentity: false });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
    });

    test('output[i] === 255 − input[i] for every channel', () => {
        const output = transform.transformArray(RGB_INPUT);
        expect(transform.lastUsedKernel).toBe('kernel3D');
        for (let i = 0; i < RGB_INPUT.length; i++) {
            expect(output[i]).toBe(255 - RGB_INPUT[i]);
        }
    });

    test('different inputs produce different outputs (kernel is not constant)', () => {
        const a = new Uint8ClampedArray([10, 20, 30]);
        const b = new Uint8ClampedArray([40, 50, 60]);
        const outA = transform.transformArray(a);
        const outB = transform.transformArray(b);
        expect(transform.lastUsedKernel).toBe('kernel3D');
        expect(Array.from(outA)).toEqual([245, 235, 225]);
        expect(Array.from(outB)).toEqual([215, 205, 195]);
    });

});


describe('plugin isolation: both builder and kernel work together', () => {

    let transform;

    beforeAll(() => {
        transform = new Transform({ buildLut: true, lutMode: 'test-both', dataFormat: 'int8', detectIdentity: false });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
    });

    test('lut.knownValue was set by builder', () => {
        expect(transform.lut.knownValue).toBe(KNOWN_VALUE);
    });

    test('output is INVERTED_VALUE (213 = 255 − 42) for every channel', () => {
        const output = transform.transformArray(RGB_INPUT);
        expect(transform.lastUsedKernel).toBe('kernel3D');
        expect(allChannelsEqual(output, INVERTED_VALUE, 3, RGB_PIXELS)).toBe(true);
    });

    test('output does not equal input (kernel used builder data, not input)', () => {
        const output = transform.transformArray(RGB_INPUT);
        let inputEchoed = true;
        for (let i = 0; i < RGB_INPUT.length; i++) {
            if (output[i] !== RGB_INPUT[i]) { inputEchoed = false; break; }
        }
        expect(inputEchoed).toBe(false);
    });

    test('output does not equal raw inversion of input (builder data is in play)', () => {
        // If kernel was using input instead of knownValue, output would be 255-input
        // Check that at least one pixel differs from that
        const output  = transform.transformArray(RGB_INPUT);
        const inverted = RGB_INPUT.map(v => 255 - v);
        let matchesInversion = true;
        for (let i = 0; i < output.length; i++) {
            if (output[i] !== inverted[i]) { matchesInversion = false; break; }
        }
        expect(matchesInversion).toBe(false);
    });

});


describe('plugin isolation: CMYK variant (4ch builder/kernel path)', () => {

    let fixedTransform;
    let invertTransform;

    beforeAll(() => {
        const cmyk = makeCmykProfile();

        fixedTransform = new Transform({ buildLut: true, lutMode: 'test-fixed-clut', dataFormat: 'int8', detectIdentity: false });
        fixedTransform.create(cmyk, cmyk, eIntent.relative);

        invertTransform = new Transform({ buildLut: true, lutMode: 'test-invert', dataFormat: 'int8', detectIdentity: false });
        invertTransform.create(cmyk, cmyk, eIntent.relative);
    });

    const CMYK_INPUT = new Uint8ClampedArray([
          0,   0,   0,   0,
        255,   0,   0, 255,
         50, 100, 150, 200,
    ]);
    const CMYK_PIXELS = 3;

    test('fixed-clut: all output channels are FIXED_VALUE (200)', () => {
        const output = fixedTransform.transformArray(CMYK_INPUT);
        expect(allChannelsEqual(output, FIXED_VALUE, 4, CMYK_PIXELS)).toBe(true);
    });

    test('invert: output[i] === 255 − input[i] for 4ch', () => {
        const output = invertTransform.transformArray(CMYK_INPUT);
        for (let i = 0; i < CMYK_INPUT.length; i++) {
            expect(output[i]).toBe(255 - CMYK_INPUT[i]);
        }
    });

});
