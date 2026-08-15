/**
 * validatePipeline() and validateOnCreate option tests.
 *
 * Coverage matrix:
 *   Healthy baseline
 *     1.  object format RGB→CMYK returns true
 *     2.  int8 format RGB→CMYK (no LUT) returns true
 *     3.  int16 format RGB→CMYK returns true
 *     4.  device format RGB→CMYK returns true
 *     5.  objectFloat format RGB→RGB returns true
 *     6.  CMYK→RGB object returns true
 *     7.  buildLut:true returns true (validates device temp pipeline)
 *     8.  validatePipeline() before create() returns false (no pipeline)
 *
 *   validateOnCreate:false — create() does not throw, validatePipeline() detects damage
 *     9.  NaN in input XYZMatrix.m00 → NaN propagates through RGB→XYZ multiply
 *     10. NaN in output XYZMatrixInv.m00 → NaN in XYZ→RGB conversion
 *     11. NaN in AdobeRGB gamma (non-sRGB profile, so issRGB=false path runs Math.pow)
 *     12. NaN in all XYZMatrix entries (complete matrix wipe)
 *     13. Stage function replaced with a throwing stub after create()
 *
 *   validateOnCreate:true (default) — create() throws immediately
 *     14. NaN in input XYZMatrix.m00 → create() throws with 'pipeline validation failed'
 *     15. NaN in AdobeRGB gamma → create() throws with 'pipeline validation failed'
 *     16. NaN in output XYZMatrixInv.m00 → create() throws with 'pipeline validation failed'
 *
 *   setLut() path — cached LUT skips validation
 *     17. pre-built LUT loaded via setLut() does not trigger validateOnCreate
 *
 *   Profile corruption details
 *   ──────────────────────────
 *   The optimized RGBMatrix pipeline (_expandRGBStages=true, the default) uses:
 *     - XYZMatrix    for the input stage_matrix_rgb stage data (computed at build time)
 *     - XYZMatrixInv for the output stage_matrix_rgb_inv stage data (computed at build time)
 *   matrixV4 and matrixInv are only read in the non-expanded fallback path so
 *   corrupting them has no effect on the default pipeline.
 *
 *   For the gamma stage: sRGB profiles set issRGB=true and use a hardcoded piecewise
 *   curve, bypassing the gamma field entirely. AdobeRGB (issRGB=false) runs
 *   Math.pow(value, gamma), so setting gamma=NaN there produces NaN output.
 */

'use strict';

const { Transform, eIntent } = require('../src/main');
const Profile                = require('../src/Profile');
const path                   = require('path');
const fs                     = require('fs');

const CMYK_ICC = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

// ── Profile helpers ───────────────────────────────────────────────────────────

function makeSRGB()     { return new Profile('*sRGB'); }
function makeAdobeRGB() { return new Profile('*adobeRGB'); }
function makeCMYK()     { return new Profile(fs.readFileSync(CMYK_ICC)); }

// Return a fresh sRGB profile with deep-cloned RGBMatrix so corruption in one
// test cannot bleed into subsequent tests.
function corruptableSRGB() {
    const profile = makeSRGB();
    profile.RGBMatrix = JSON.parse(JSON.stringify(profile.RGBMatrix));
    return profile;
}

function corruptableAdobeRGB() {
    const profile = makeAdobeRGB();
    profile.RGBMatrix = JSON.parse(JSON.stringify(profile.RGBMatrix));
    return profile;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function createTransform(inputProfile, outputProfile, options) {
    const transform = new Transform(options || {});
    transform.create(inputProfile, outputProfile, eIntent.relative);
    return transform;
}

// ── 1–8: Healthy baselines ────────────────────────────────────────────────────

describe('validatePipeline — healthy baselines', () => {

    let cmykProfile;
    beforeAll(() => { cmykProfile = makeCMYK(); });

    test('1. object format RGB→CMYK returns true', () => {
        const transform = createTransform(makeSRGB(), cmykProfile, { dataFormat: 'object', validateOnCreate: false });
        expect(transform.validatePipeline()).toBe(true);
    });

    test('2. int8 format RGB→CMYK (no LUT) returns true', () => {
        const transform = createTransform(makeSRGB(), cmykProfile, { dataFormat: 'int8', buildLut: false, validateOnCreate: false });
        expect(transform.validatePipeline()).toBe(true);
    });

    test('3. int16 format RGB→CMYK returns true', () => {
        const transform = createTransform(makeSRGB(), cmykProfile, { dataFormat: 'int16', buildLut: false, validateOnCreate: false });
        expect(transform.validatePipeline()).toBe(true);
    });

    test('4. device format RGB→CMYK returns true', () => {
        const transform = createTransform(makeSRGB(), cmykProfile, { dataFormat: 'device', validateOnCreate: false });
        expect(transform.validatePipeline()).toBe(true);
    });

    test('5. objectFloat format RGB→RGB returns true', () => {
        const transform = createTransform(makeSRGB(), makeSRGB(), { dataFormat: 'objectFloat', validateOnCreate: false });
        expect(transform.validatePipeline()).toBe(true);
    });

    test('6. CMYK→RGB object returns true', () => {
        const transform = createTransform(cmykProfile, makeSRGB(), { dataFormat: 'object', validateOnCreate: false });
        expect(transform.validatePipeline()).toBe(true);
    });

    test('7. buildLut:true returns true (validates device temp pipeline)', () => {
        const transform = createTransform(makeSRGB(), cmykProfile, { dataFormat: 'int8', buildLut: true, validateOnCreate: false });
        expect(transform.validatePipeline()).toBe(true);
    });

    test('8. validatePipeline() before create() returns false', () => {
        const transform = new Transform({ dataFormat: 'object' });
        expect(transform.validatePipeline()).toBe(false);
    });

});

// ── 9–13: validateOnCreate:false — damage visible via validatePipeline() ──────

describe('validatePipeline — detects corrupt profiles (validateOnCreate:false)', () => {

    let cmykProfile;
    beforeAll(() => { cmykProfile = makeCMYK(); });

    test('9. NaN in input XYZMatrix.m00 → NaN propagates through RGB→XYZ multiply', () => {
        const corruptSRGB = corruptableSRGB();
        corruptSRGB.RGBMatrix.XYZMatrix.m00 = NaN;

        const transform = createTransform(corruptSRGB, cmykProfile, { dataFormat: 'object', validateOnCreate: false });
        expect(transform.validatePipeline()).toBe(false);
    });

    test('10. NaN in output XYZMatrixInv.m00 → NaN in XYZ→RGB conversion', () => {
        const corruptOutputSRGB = corruptableSRGB();
        corruptOutputSRGB.RGBMatrix.XYZMatrixInv.m00 = NaN;

        const transform = createTransform(cmykProfile, corruptOutputSRGB, { dataFormat: 'object', validateOnCreate: false });
        expect(transform.validatePipeline()).toBe(false);
    });

    test('11. NaN in AdobeRGB gamma — issRGB=false so Math.pow(value, NaN) fires', () => {
        const corruptAdobeRGB = corruptableAdobeRGB();
        // AdobeRGB has issRGB=false, so stage_Gamma_Inverse takes the
        // Math.pow(value, data.gamma) branch. NaN gamma → NaN output.
        corruptAdobeRGB.RGBMatrix.gamma = NaN;

        const transform = createTransform(corruptAdobeRGB, cmykProfile, { dataFormat: 'object', validateOnCreate: false });
        expect(transform.validatePipeline()).toBe(false);
    });

    test('12. NaN across entire XYZMatrix — complete matrix wipe', () => {
        const corruptSRGB = corruptableSRGB();
        const matrix = corruptSRGB.RGBMatrix.XYZMatrix;
        matrix.m00 = NaN; matrix.m01 = NaN; matrix.m02 = NaN;
        matrix.m10 = NaN; matrix.m11 = NaN; matrix.m12 = NaN;
        matrix.m20 = NaN; matrix.m21 = NaN; matrix.m22 = NaN;

        const transform = createTransform(corruptSRGB, cmykProfile, { dataFormat: 'object', validateOnCreate: false });
        expect(transform.validatePipeline()).toBe(false);
    });

    test('13. stage function replaced with throwing stub after create()', () => {
        const transform = createTransform(makeSRGB(), cmykProfile, { dataFormat: 'object', validateOnCreate: false });

        // Inject a stage that throws at transform time but was not present at build time,
        // exercising the try/catch path inside validatePipeline().
        transform.pipeline.unshift({
            funct:     () => { throw new Error('injected pipeline failure'); },
            stageData: null,
            stageName: 'injected-bad-stage',
        });

        expect(transform.validatePipeline()).toBe(false);
    });

});

// ── 14–16: validateOnCreate:true (default) — create() throws immediately ──────

describe('validatePipeline — validateOnCreate:true throws at create() time', () => {

    let cmykProfile;
    beforeAll(() => { cmykProfile = makeCMYK(); });

    test('14. NaN in input XYZMatrix.m00 → create() throws with clear message', () => {
        const corruptSRGB = corruptableSRGB();
        corruptSRGB.RGBMatrix.XYZMatrix.m00 = NaN;

        const transform = new Transform({ dataFormat: 'object' });
        expect(() => transform.create(corruptSRGB, cmykProfile, eIntent.relative))
            .toThrow('pipeline validation failed');
    });

    test('15. NaN in AdobeRGB gamma → create() throws with clear message', () => {
        const corruptAdobeRGB = corruptableAdobeRGB();
        corruptAdobeRGB.RGBMatrix.gamma = NaN;

        const transform = new Transform({ dataFormat: 'object' });
        expect(() => transform.create(corruptAdobeRGB, cmykProfile, eIntent.relative))
            .toThrow('pipeline validation failed');
    });

    test('16. NaN in output XYZMatrixInv.m00 → create() throws with clear message', () => {
        const corruptOutputSRGB = corruptableSRGB();
        corruptOutputSRGB.RGBMatrix.XYZMatrixInv.m00 = NaN;

        const transform = new Transform({ dataFormat: 'object' });
        expect(() => transform.create(cmykProfile, corruptOutputSRGB, eIntent.relative))
            .toThrow('pipeline validation failed');
    });

});

// ── 17: setLut() path — cached LUT skips validation ──────────────────────────

describe('validatePipeline — setLut() skips validation', () => {

    test('17. pre-built LUT loaded via setLut() does not trigger validateOnCreate', () => {
        const cmykProfile = makeCMYK();

        // Build and serialise a valid LUT.
        const sourceTransform = new Transform({ dataFormat: 'int8', buildLut: true, validateOnCreate: false });
        sourceTransform.create(makeSRGB(), cmykProfile, eIntent.relative);
        const serialisedLut = sourceTransform.toJSON();

        // Loading a cached LUT must not throw even with validateOnCreate:true (default).
        // Validation is intentionally skipped — the LUT was already valid when built.
        const loadedTransform = new Transform({ dataFormat: 'int8' });
        expect(() => loadedTransform.setLut(serialisedLut)).not.toThrow();
        expect(loadedTransform.validatePipeline()).toBe(true);
    });

});
