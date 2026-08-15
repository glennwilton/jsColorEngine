#!/usr/bin/env node
/* ============================================================================
 *  identity-plugin.js — demo of the Transform plugin architecture
 * ----------------------------------------------------------------------------
 *  Released under the MIT License
 *  Copyright (c) 2026 Glenn Wilton, O2 Creative Limited.
 *
 *  Demonstrates registerKernel / registerBuilder with a dead-simple identity
 *  plugin: passes every pixel through unchanged. Useful for testing that the
 *  plugin hooks fire correctly and the hot-path dispatch is wired up.
 *
 *  Intentionally throws for mismatched channel counts (e.g. RGB→CMYK) since
 *  an identity pass-through is meaningless across different colour spaces.
 *
 *  Usage:
 *    node samples/identity-plugin.js
 * ============================================================================
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const { Transform, eIntent } = require('../src/main');
const Profile                = require('../src/Profile');

// ── 1. Kernel ─────────────────────────────────────────────────────────────────
//
// Called per transformArray() invocation.  Copies each pixel channel-for-channel
// with no colour math.  Alpha is preserved when preserveAlpha is set.
//
// The signature must match every built-in kernel in src/lutKernelTable.js.

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

// ── 2. Builder ────────────────────────────────────────────────────────────────
//
// The builder receives the Transform instance.  `transform.createLut()` handles
// all dimensionality (1D gray, 2D duotone, 3D RGB, 4D CMYK) by dispatching on
// the input profile type — the builder doesn't need separate cases.
//
// For a custom sampler (e.g. dynamic non-uniform grid), call
// `transform.create3DDeviceLUT(outputChannels, gridSize)` directly.
//
// Note: the identity kernel only fires for 3D and 4D inputs.  1D/2D inputs
// bypass plugin kernels entirely and route to the built-in gray/duotone path.

function identityBuilder(transform) {
    const lut = transform.createLut();   // auto-detects input/output channels from profile chain

    if (lut.inputChannels !== lut.outputChannels) {
        throw new Error(
            'identity plugin: channel mismatch — ' +
            'input is ' + lut.inputChannels + 'ch but output is ' + lut.outputChannels + 'ch. ' +
            'Identity pass-through requires the same colour space on both ends.'
        );
    }

    // Kernel copies pixels directly — discard CLUT data, it is not used.
    lut.CLUT = new Float64Array(0);
    return lut;
}

// ── 3. Registration ───────────────────────────────────────────────────────────

Transform.register({
    name:    'identity-plugin-demo',
    lutMode: 'identity',
    kernel:  identityKernel,   // required — the hot-path run closure
    builder: identityBuilder,  // optional — replaces createLut()
    // no wasmKernel/simdKernel/isSupported — JS is sufficient for a demo
    // no options/initialise/serializer/deserializer — nothing extra needed
});


// ── 4. Demo ───────────────────────────────────────────────────────────────────

const PROFILES = path.join(__dirname, 'profiles');

function loadICC(filename) {
    const p = new Profile();
    p.loadBinary(fs.readFileSync(path.join(PROFILES, filename)));
    if (!p.loaded) throw new Error('Failed to load: ' + filename);
    return p;
}

function pixelMatch(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

function runDemo() {

    // ── Case 1: RGB → RGB ────────────────────────────────────────────────────
    // Transform.create() accepts '*sRGB' string shortcut for built-in profiles.
    console.log('\n── Case 1: sRGB → sRGB (identity, should pass) ─────────────');
    {
        const t = new Transform({ buildLut: true, lutMode: 'identity', dataFormat: 'int8' });
        t.create('*sRGB', '*sRGB', eIntent.relative);

        const pixels = new Uint8ClampedArray([
            255,   0,   0,    // red
              0, 255,   0,    // green
              0,   0, 255,    // blue
            128, 128, 128,    // mid grey
        ]);

        const out = t.transformArray(pixels);
        console.log('  Input: ', Array.from(pixels));
        console.log('  Output:', Array.from(out));
        console.log(pixelMatch(pixels, out) ? '  PASS — output matches input exactly'
                                            : '  FAIL — output differs from input');
    }

    // ── Case 2: CMYK → CMYK ─────────────────────────────────────────────────
    console.log('\n── Case 2: GRACoL → GRACoL (identity, should pass) ─────────');
    {
        const cmyk = loadICC('CoatedGRACoL2006.icc');
        const t = new Transform({ buildLut: true, lutMode: 'identity', dataFormat: 'int8' });
        t.create(cmyk, cmyk, eIntent.relative);

        const pixels = new Uint8ClampedArray([
              0,   0,   0,   0,    // paper white
            255,   0,   0, 255,    // max ink
            128,  64,  32, 200,    // arbitrary values
        ]);

        const out = t.transformArray(pixels);
        console.log('  Input: ', Array.from(pixels));
        console.log('  Output:', Array.from(out));
        console.log(pixelMatch(pixels, out) ? '  PASS — output matches input exactly'
                                            : '  FAIL — output differs from input');
    }

    // ── Case 3: RGB → CMYK (should throw) ───────────────────────────────────
    console.log('\n── Case 3: sRGB → GRACoL (should throw — channel mismatch) ─');
    {
        const cmyk = loadICC('CoatedGRACoL2006.icc');
        const t = new Transform({ buildLut: true, lutMode: 'identity', dataFormat: 'int8' });

        try {
            t.create('*sRGB', cmyk, eIntent.perceptual);
            console.log('  FAIL — should have thrown');
        } catch (e) {
            console.log('  PASS — threw:', e.message);
        }
    }

    console.log('\n── Done ────────────────────────────────────────────────────\n');
}

runDemo();
