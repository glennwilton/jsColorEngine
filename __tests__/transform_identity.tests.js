/**
 * Transform identity / NOP detection tests.
 *
 * Coverage matrix:
 *   Detection
 *     1.  sRGB→sRGB (virtual name) sets isIdentity:true
 *     2.  adobeRGB→adobeRGB (virtual name) sets isIdentity:true
 *     3.  CMYK→CMYK same binary (binaryHash) sets isIdentity:true
 *     4.  sRGB→CMYK (different types) sets isIdentity:false
 *     5.  sRGB→adobeRGB (same type, different matrix) sets isIdentity:false
 *     6.  detectIdentity:false bypasses detection
 *     7.  chain.length === 1 after collapse (single remaining endpoint)
 *     8.  hasLut() returns false for identity transforms
 *     9.  validatePipeline() returns true for identity pipeline
 *
 *   Multi-stage collapse
 *     10. [sRGB > rel > sRGB > rel > sRGB] collapses to identity
 *     11. [CMYK > perc > sRGB > rel > sRGB] collapses to [CMYK > perc > sRGB]
 *     12. [sRGB > rel > Adobe > perc > Adobe > rel > sRGB] collapses middle pair
 *
 *   Correctness — object format
 *     13. RGB object: input values exactly preserved
 *     14. CMYK object: input values exactly preserved (no separation change)
 *     15. Lab object: input values exactly preserved
 *
 *   Correctness — int8 array
 *     16. transformArray copies pixel values exactly
 *     17. transformArray with inputHasAlpha + outputHasAlpha + preserveAlpha
 *     18. transformArray with outputHasAlpha=true, no input alpha → fills 255
 *
 *   detectIdentity:false falls through to real pipeline
 *     19. sRGB→sRGB with detectIdentity:false runs the full pipeline (no copy)
 */

'use strict';

const { Transform, eIntent, eColourType } = require('../src/main');
const Profile                              = require('../src/Profile');
const path                                 = require('path');
const fs                                   = require('fs');

const CMYK_ICC  = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');
const CMYK_BUF  = fs.readFileSync(CMYK_ICC);

function makeCMYK()    { return new Profile(CMYK_BUF); }
function makeSRGB()    { return new Profile('*sRGB'); }
function makeAdobeRGB(){ return new Profile('*adobeRGB'); }
function makeLab()     { return new Profile('*lab'); }

// ── Profile field sanity ──────────────────────────────────────────────────────

describe('identity detection — profile field prerequisites', () => {

    test('A. loaded ICC profile has binaryHash set', () => {
        const profile = makeCMYK();
        expect(typeof profile.binaryHash).toBe('string');
        expect(profile.binaryHash.length).toBe(8);   // 32-bit FNV-1a as 8 hex chars
        expect(profile.binaryHash).not.toBe('00000000');
    });

    test('B. two profiles loaded from same binary have identical binaryHash', () => {
        const profileA = makeCMYK();
        const profileB = makeCMYK();
        expect(profileA.binaryHash).toBe(profileB.binaryHash);
    });

    test('B2. binaryHash is stable when binary has trailing null padding', () => {
        // Profiles embedded in JPEG APP2 or TIFF tags are sometimes padded
        // to a block boundary. The hash must ignore bytes past the declared size.
        const paddedBuf = new Uint8Array(CMYK_BUF.length + 64); // 64 bytes of 0x00 padding
        paddedBuf.set(CMYK_BUF, 0);

        const normal = makeCMYK();                       // from unpadded buffer
        const padded = new Profile(paddedBuf);           // from padded buffer

        expect(padded.loaded).toBe(true);
        expect(padded.binaryHash).toBe(normal.binaryHash);  // hash ignores padding

        const transform = new Transform({ dataFormat: 'object' });
        transform.create(normal, padded, eIntent.relative);
        expect(transform.isIdentity).toBe(true);
    });

    test('C. virtual profile has virtualName set and binaryHash:false', () => {
        const profile = makeSRGB();
        expect(profile.virtualName).toBe('*sRGB');
        expect(profile.binaryHash).toBe(false);
    });

    test('D. CMYK→CMYK identity fires via binaryHash, not other strategies', () => {
        // CMYK is not RGBMatrix so areSameMatrix() cannot fire.
        // virtualName is false for loaded profiles so areSameVirtual() cannot fire.
        // The only path to isIdentity:true is areSameHash().
        const profileA = makeCMYK();
        const profileB = makeCMYK();
        expect(profileA.virtualName).toBe(false);
        expect(profileB.virtualName).toBe(false);
        expect(profileA.binaryHash).toBeTruthy();
        expect(profileA.binaryHash).toBe(profileB.binaryHash);

        const transform = new Transform({ dataFormat: 'object' });
        transform.create(profileA, profileB, eIntent.relative);
        expect(transform.isIdentity).toBe(true);
    });

});

// ── 1–9: Detection basics ─────────────────────────────────────────────────────

describe('identity detection — basics', () => {

    test('1. sRGB→sRGB (virtual name) sets isIdentity:true', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
        expect(transform.isIdentity).toBe(true);
    });

    test('2. adobeRGB→adobeRGB (virtual name) sets isIdentity:true', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.create('*adobeRGB', '*adobeRGB', eIntent.perceptual);
        expect(transform.isIdentity).toBe(true);
    });

    test('3. CMYK→CMYK same binary (binaryHash) sets isIdentity:true', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.create(makeCMYK(), makeCMYK(), eIntent.relative);
        expect(transform.isIdentity).toBe(true);
    });

    test('4. sRGB→CMYK (different types) sets isIdentity:false', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.create(makeSRGB(), makeCMYK(), eIntent.relative);
        expect(transform.isIdentity).toBe(false);
    });

    test('5. sRGB→adobeRGB (different matrix) sets isIdentity:false', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.create('*sRGB', '*adobeRGB', eIntent.relative);
        expect(transform.isIdentity).toBe(false);
    });

    test('6. detectIdentity:false bypasses detection', () => {
        const transform = new Transform({ dataFormat: 'object', detectIdentity: false });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
        expect(transform.isIdentity).toBe(false);
    });

    test('7. chain.length === 1 after collapse — single remaining endpoint', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
        expect(transform.chain.length).toBe(1);
    });

    test('8. hasLut() returns false for identity transforms', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
        expect(transform.hasLut()).toBe(false);
    });

    test('9. validatePipeline() returns true for identity pipeline', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
        expect(transform.validatePipeline()).toBe(true);
    });

});

// ── 10–12: Multi-stage collapse ───────────────────────────────────────────────

describe('identity detection — multi-stage chain collapse', () => {

    test('10. [sRGB > rel > sRGB > rel > sRGB] collapses to identity', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.createMultiStage([
            '*sRGB', eIntent.relative, '*sRGB', eIntent.relative, '*sRGB'
        ]);
        expect(transform.isIdentity).toBe(true);
    });

    test('11. [CMYK > perc > sRGB > rel > sRGB] collapses to [CMYK > perc > sRGB]', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.createMultiStage([
            makeCMYK(), eIntent.perceptual, '*sRGB', eIntent.relative, '*sRGB'
        ]);
        expect(transform.isIdentity).toBe(false);
        expect(transform.chain.length).toBe(3);
        expect(transform.chain[0].type).toBe(transform.inputProfile.type); // CMYK still input
    });

    test('12. [sRGB > rel > Adobe > perc > Adobe > rel > sRGB] collapses middle pair', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.createMultiStage([
            '*sRGB', eIntent.relative,
            '*adobeRGB', eIntent.perceptual,
            '*adobeRGB', eIntent.relative,
            '*sRGB'
        ]);
        expect(transform.isIdentity).toBe(false);
        expect(transform.chain.length).toBe(5);  // sRGB > rel > adobeRGB > rel > sRGB
    });

});

// ── 13–15: Correctness — object format ───────────────────────────────────────

describe('identity correctness — object format', () => {

    test('13. RGB object: input values exactly preserved', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
        const input  = { type: eColourType.RGB, R: 123, G: 45, B: 210 };
        const output = transform.transform(input);
        expect(output.R).toBe(123);
        expect(output.G).toBe(45);
        expect(output.B).toBe(210);
        expect(output.type).toBe(eColourType.RGB);
    });

    test('14. CMYK object: separation values exactly preserved', () => {
        const transform = new Transform({ dataFormat: 'object' });
        transform.create(makeCMYK(), makeCMYK(), eIntent.relative);
        const input  = { type: eColourType.CMYK, C: 40, M: 30, Y: 20, K: 10 };
        const output = transform.transform(input);
        expect(output.C).toBe(40);
        expect(output.M).toBe(30);
        expect(output.Y).toBe(20);
        expect(output.K).toBe(10);
        expect(output.type).toBe(eColourType.CMYK);
    });

    test('15. Lab object: input values exactly preserved', () => {
        // labInputAdaptation:false avoids the whitePoint-required adaptation stage.
        // The identity two-stage codec (Lab→device→Lab) is lossless at f64 precision.
        const transform = new Transform({ dataFormat: 'object', labInputAdaptation: false });
        transform.create('*lab', '*lab', eIntent.absolute);
        const input  = { type: eColourType.Lab, L: 60, a: -20, b: 35 };
        const output = transform.transform(input);
        expect(output.L).toBeCloseTo(60, 5);
        expect(output.a).toBeCloseTo(-20, 5);
        expect(output.b).toBeCloseTo(35, 5);
    });

});

// ── 16–22: Correctness — transformArray (kernelCopy) ─────────────────────────

describe('identity correctness — transformArray (kernelCopy)', () => {

    // 3-channel RGB, no alpha
    test('16. int8 RGB — pixel values copied exactly', () => {
        const transform = new Transform({ dataFormat: 'int8' });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
        const input  = new Uint8ClampedArray([255, 128, 0,   0, 200, 50]);
        const output = transform.transformArray(input, false, false);
        expect(Array.from(output)).toEqual([255, 128, 0, 0, 200, 50]);
    });

    // Alpha preserved (RGBA → RGBA)
    test('17. int8 RGB — preserveAlpha copies alpha through unchanged', () => {
        const transform = new Transform({ dataFormat: 'int8' });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
        const input  = new Uint8ClampedArray([255, 0, 0, 200,   0, 255, 0, 128]);
        const output = transform.transformArray(input, true, true, true);
        expect(output[0]).toBe(255);  expect(output[3]).toBe(200);
        expect(output[4]).toBe(0);    expect(output[7]).toBe(128);
    });

    // No input alpha, add output alpha filled with 255 (RGB → RGBA)
    test('18. int8 RGB — outputHasAlpha with no input alpha fills 255', () => {
        const transform = new Transform({ dataFormat: 'int8' });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
        const input  = new Uint8ClampedArray([100, 150, 200,   50, 75, 100]);
        const output = transform.transformArray(input, false, true, false);
        expect(output.length).toBe(8);
        expect(output[0]).toBe(100); expect(output[3]).toBe(255);
        expect(output[4]).toBe(50);  expect(output[7]).toBe(255);
    });

    // Strip alpha (RGBA → RGB)
    test('19. int8 RGB — inputHasAlpha=true outputHasAlpha=false strips alpha', () => {
        const transform = new Transform({ dataFormat: 'int8' });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
        const input  = new Uint8ClampedArray([255, 128, 0, 200,   10, 20, 30, 99]);
        const output = transform.transformArray(input, true, false, false);
        expect(output.length).toBe(6);
        expect(Array.from(output)).toEqual([255, 128, 0, 10, 20, 30]);
    });

    // 4-channel CMYK
    test('20. int8 CMYK — 4-channel values copied exactly', () => {
        const transform = new Transform({ dataFormat: 'int8' });
        transform.create(makeCMYK(), makeCMYK(), eIntent.relative);
        const input  = new Uint8ClampedArray([40, 30, 20, 10,   0, 0, 0, 255]);
        const output = transform.transformArray(input, false, false);
        expect(Array.from(output)).toEqual([40, 30, 20, 10, 0, 0, 0, 255]);
    });

    // int16 format
    test('21. int16 — 16-bit values copied exactly', () => {
        const transform = new Transform({ dataFormat: 'int16' });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
        const input  = new Uint16Array([60000, 30000, 0,   100, 200, 65535]);
        const output = transform.transformArray(input, false, false);
        expect(output).toBeInstanceOf(Uint16Array);
        expect(Array.from(output)).toEqual([60000, 30000, 0, 100, 200, 65535]);
    });

    // Pre-allocated output buffer
    test('22. pre-allocated outputArray is written in place and returned', () => {
        const transform = new Transform({ dataFormat: 'int8' });
        transform.create('*sRGB', '*sRGB', eIntent.relative);
        const input     = new Uint8ClampedArray([10, 20, 30,   40, 50, 60]);
        const preBuf    = new Uint8ClampedArray(6);
        const returned  = transform.transformArray(input, false, false, false, 2, null, preBuf);
        expect(returned).toBe(preBuf);                         // same reference
        expect(Array.from(preBuf)).toEqual([10, 20, 30, 40, 50, 60]);
    });

});

// ── 19: detectIdentity:false runs the real pipeline ──────────────────────────

describe('detectIdentity:false — full pipeline runs', () => {

    test('19. sRGB→sRGB with detectIdentity:false produces f64 round-trip (not a raw copy)', () => {
        const identity = new Transform({ dataFormat: 'object' });
        identity.create('*sRGB', '*sRGB', eIntent.relative);

        const fullPipeline = new Transform({ dataFormat: 'object', detectIdentity: false });
        fullPipeline.create('*sRGB', '*sRGB', eIntent.relative);

        // Both should produce the same output values — the round-trip is lossless
        // within f64 precision. The difference is the PATH, not the result.
        const input  = { type: eColourType.RGB, R: 128, G: 64, B: 200 };
        const outId  = identity.transform(input);
        const outFull = fullPipeline.transform(input);

        expect(outId.R).toBeCloseTo(outFull.R, 0);
        expect(outId.G).toBeCloseTo(outFull.G, 0);
        expect(outId.B).toBeCloseTo(outFull.B, 0);

        // Confirm only the full-pipeline one has no identity flag
        expect(identity.isIdentity).toBe(true);
        expect(fullPipeline.isIdentity).toBe(false);
    });

});
