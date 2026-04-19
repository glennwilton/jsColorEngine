// Regression tests for two recent fixes:
//
// 1. tetrahedralInterp3DArray_3Ch_loop had its preserveAlpha block placed
//    OUTSIDE the for(){} loop, so for any RGB->RGB / RGB->Lab LUT image
//    transform with more than one pixel, alpha was not preserved and
//    output channels stepped on each other. Affects soft-proof chains.
//
// 2. The Transform constructor JSDoc documents `buildLut` as the option
//    name but the constructor previously only read `options.builtLut`.
//    Both spellings should now work and produce a usable LUT.

const {Transform, eIntent} = require('../src/main');
const path = require('path');
const Profile = require('../src/Profile');

const cmykFilename = path.join(__dirname, './GRACoL2006_Coated1v2.icc');

describe('tetrahedralInterp3DArray_3Ch_loop preserveAlpha (multi-pixel)', () => {

    test('sRGB -> CMYK -> sRGB multistage preserves alpha across multiple pixels', async () => {
        const cmykProfile = new Profile();
        await cmykProfile.loadPromise('file:' + cmykFilename);
        expect(cmykProfile.loaded).toBe(true);

        const proof = new Transform({
            builtLut: true,
            dataFormat: 'int8',
            BPC: [true, false]
        });
        proof.createMultiStage([
            '*sRGB', eIntent.perceptual,
            cmykProfile, eIntent.relative,
            '*sRGB'
        ]);

        // 4 pixels x RGBA, each with a distinct alpha so we'd notice any
        // off-by-one or wrong-pixel preservation.
        const input = new Uint8ClampedArray([
            255,   0,   0,  10,
              0, 255,   0,  90,
              0,   0, 255, 170,
            128, 128, 128, 250,
        ]);

        const out = proof.transformArray(input, true, true, true);

        expect(out).toBeInstanceOf(Uint8ClampedArray);
        expect(out.length).toBe(16); // 4 px * (3 RGB + 1 alpha)

        // Per-pixel alpha must be preserved verbatim.
        expect(out[3]).toBe(10);
        expect(out[7]).toBe(90);
        expect(out[11]).toBe(170);
        expect(out[15]).toBe(250);
    });

    test('sRGB -> Lab via LUT preserves alpha across multiple pixels', async () => {
        const t = new Transform({
            builtLut: true,
            dataFormat: 'int8'
        });
        t.create('*sRGB', '*Lab', eIntent.relative);

        const input = new Uint8ClampedArray([
            255,   0,   0,  64,
              0, 255,   0, 128,
              0,   0, 255, 192,
        ]);

        const out = t.transformArray(input, true, true, true);

        expect(out.length).toBe(12);
        expect(out[3]).toBe(64);
        expect(out[7]).toBe(128);
        expect(out[11]).toBe(192);
    });

    test('sRGB -> sRGB with outputHasAlpha=true (no input alpha) writes 255 per pixel', async () => {
        const t = new Transform({
            builtLut: true,
            dataFormat: 'int8'
        });
        t.create('*sRGB', '*sRGB', eIntent.relative);

        // 3 pixels, no input alpha; ask for alpha on output (should be 255).
        const input = new Uint8ClampedArray([
            255,   0,   0,
              0, 255,   0,
              0,   0, 255,
        ]);

        const out = t.transformArray(input, false, true, false);

        expect(out.length).toBe(12);
        expect(out[3]).toBe(255);
        expect(out[7]).toBe(255);
        expect(out[11]).toBe(255);
    });
});

describe('Transform constructor buildLut / builtLut option spellings', () => {

    test('buildLut: true builds the LUT', () => {
        const t = new Transform({ buildLut: true, dataFormat: 'int8' });
        t.create('*sRGB', '*sRGB', eIntent.relative);
        expect(t.builtLut).toBe(true);
        expect(t.lut).not.toBe(false);
    });

    test('builtLut: true also builds the LUT (legacy spelling)', () => {
        const t = new Transform({ builtLut: true, dataFormat: 'int8' });
        t.create('*sRGB', '*sRGB', eIntent.relative);
        expect(t.builtLut).toBe(true);
        expect(t.lut).not.toBe(false);
    });

    test('neither set: no LUT is built', () => {
        const t = new Transform({ dataFormat: 'int8' });
        t.create('*sRGB', '*sRGB', eIntent.relative);
        expect(t.builtLut).toBe(false);
    });
});
