/**
 * transform() and colour objects: which formats accept one, and which say so.
 *
 * transform() is polymorphic by contract — `{object|number[]}` — and arrays
 * work in every format that accepts them. Objects are the interesting case:
 *
 *   - `object` / `objectFloat`      always, that is the point of the format
 *   - Lab or XYZ input profile      always, at EVERY dataFormat, because
 *                                   createPipeline_Input_to_Device has no
 *                                   dataFormat switch for them
 *   - device source + int/device    only when a LUT exists to absorb it
 *
 * That last row used to return `[NaN, NaN, NaN, NaN]` without a LUT — right
 * length, right shape, no error, garbage values. These tests pin the throw
 * that replaced it, and just as importantly pin the two carve-outs, because
 * guarding too widely breaks the LUT builder (which drives transform() once
 * per grid cell) and validateOnCreate for every Lab/XYZ transform.
 */

const path = require('path');
const fs = require('fs');
const { Transform, eIntent, eColourType } = require('../src/main');
const Profile = require('../src/Profile');
const convert = require('../src/convert');

const CMYK = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');
const XYZ_PROFILE = path.join(__dirname, '..', 'testbed', 'profiles', 'xyz', 'D50_XYZ.icc');

function cmyk(){ const p = new Profile(); p.loadFile(CMYK); return p; }
function xyz(){  const p = new Profile(); p.loadFile(XYZ_PROFILE); return p; }

// The file is present but the loader rejects it: "Unsupported Profile
// Colorspace [XYZ ]". So XYZ INPUT PROFILES CANNOT BE BUILT TODAY, which makes
// the XYZ arm of the guard (and _buildValidationInput's XYZ branch)
// unreachable through a real profile. Kept, and gated on the profile actually
// loading rather than merely existing, so the day XYZ input lands this starts
// running instead of silently passing.
const hasXyz = fs.existsSync(XYZ_PROFILE) && xyz().loaded === true;

const ARRAY_FORMATS = ['int8', 'int16', 'device'];

describe('transform() with a colour object', () => {

    describe('device source, no LUT — throws instead of returning NaN', () => {
        for(const dataFormat of ARRAY_FORMATS){
            test(`${dataFormat} rejects an object, and says why`, () => {
                const t = new Transform({dataFormat, buildLut: false});
                t.create('*sRGB', cmyk(), eIntent.relative);

                let caught = null;
                try { t.transform(convert.RGB(128, 128, 128)); }
                catch(e){ caught = String(e && e.message || e); }

                expect(caught).not.toBeNull();
                // The message has to name the way out, not just the problem.
                expect(caught).toContain(dataFormat);
                expect(caught).toContain('number array');
                expect(caught).toContain('buildLut');
            });

            test(`${dataFormat} still takes an array`, () => {
                // The LUT builder only ever passes arrays, so this is the path
                // that must not regress.
                const t = new Transform({dataFormat, buildLut: false});
                t.create('*sRGB', cmyk(), eIntent.relative);

                const out = t.transform([0.5, 0.5, 0.5]);
                expect(out.length).toBe(4);
                expect(out.every(v => typeof v === 'number' && !Number.isNaN(v))).toBe(true);
            });
        }
    });

    describe('device source, with a LUT — the object is absorbed, as before', () => {
        for(const dataFormat of ['int8', 'int16']){
            test(`${dataFormat} accepts an object when a LUT exists`, () => {
                const t = new Transform({dataFormat, buildLut: true});
                t.create('*sRGB', cmyk(), eIntent.relative);

                const out = t.transform(convert.RGB(128, 128, 128));
                expect(out.length).toBe(4);
                expect(out.every(v => typeof v === 'number' && !Number.isNaN(v))).toBe(true);
            });
        }
    });

    describe('Lab and XYZ sources — an object is the REQUIRED input, at any format', () => {
        // These pipelines have no dataFormat switch: the first stage always
        // receives an object. Guarding them would reject the only input they
        // accept, and break validateOnCreate for every Lab/XYZ transform —
        // which is exactly how the over-broad first version of the guard was
        // caught.
        // 'device' is deliberately absent: _buildValidationInput gates its
        // Lab/XYZ carve-out on `format !== 'device'`, so under device format
        // even a Lab source takes an array. An object there used to return
        // [null, null, null]; it now throws, asserted below.
        for(const dataFormat of ['int8', 'int16', 'object']){
            test(`Lab source accepts an object with dataFormat ${dataFormat}`, () => {
                const t = new Transform({dataFormat, buildLut: false});
                t.create('*labd50', cmyk(), eIntent.relative);

                const out = t.transform({
                    type: eColourType.Lab, L: 50, a: 0, b: 0,
                    whitePoint: {desc: 'd50', X: 0.96422, Y: 1, Z: 0.82521}
                });
                expect(out).toBeDefined();
                expect(out).not.toBeNull();
            });
        }

        test('Lab source with dataFormat device wants an array, and says so', () => {
            const t = new Transform({dataFormat: 'device', buildLut: false});
            t.create('*labd50', cmyk(), eIntent.relative);

            expect(() => t.transform({
                type: eColourType.Lab, L: 50, a: 0, b: 0,
                whitePoint: {desc: 'd50', X: 0.96422, Y: 1, Z: 0.82521}
            })).toThrow();

            const out = t.transform([0.5, 0.50196, 0.50196]);
            expect(out.length).toBe(4);
            expect(out.every(v => typeof v === 'number' && !Number.isNaN(v))).toBe(true);
        });

        (hasXyz ? test : test.skip)('XYZ source accepts an object with dataFormat int8', () => {
            const t = new Transform({dataFormat: 'int8', buildLut: false});
            t.create(xyz(), cmyk(), eIntent.relative);

            const out = t.transform({type: eColourType.XYZ, X: 0.5, Y: 0.5, Z: 0.5});
            expect(out).toBeDefined();
            expect(out).not.toBeNull();
        });
    });

    describe('object formats are untouched', () => {
        for(const dataFormat of ['object', 'objectFloat']){
            for(const buildLut of [true, false]){
                test(`${dataFormat}, buildLut:${buildLut} returns a colour object`, () => {
                    const t = new Transform({dataFormat, buildLut});
                    t.create('*sRGB', cmyk(), eIntent.relative);

                    const out = t.transform(convert.RGB(128, 128, 128));
                    expect(out).not.toBeNull();
                    expect(typeof out).toBe('object');
                    expect(out.type).toBeDefined();
                });
            }
        }
    });

    test('the guard does not slow the LUT build path down to a crawl', () => {
        // Not a benchmark — a canary. The builder calls transform() once per
        // grid cell, so a guard that did real work per call (deep inspection,
        // try/catch, property enumeration) would show up here.
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutGridPoints: 33});
        const started = Date.now();
        t.create('*sRGB', cmyk(), eIntent.relative);
        const elapsed = Date.now() - started;

        expect(t.lut).not.toBe(false);
        expect(elapsed).toBeLessThan(20000);
    });
});

describe('Lab source: array input', () => {

    // The device branch has always had an entry stage per dataFormat
    // (stage_Int_to_Device and friends). The Lab branch only had the object
    // one, so a Lab source on the LUT-free pipeline could not take an array at
    // all — it threw with labInputAdaptation on, and returned NaN with it off.
    // stage_Int_to_cmsLab is the missing sibling.
    //
    // AN ARRAY IS ALREADY PCS-ENCODED FOR THIS PROFILE'S VERSION. Nothing here
    // converts between v2 and v4; the only work is scaling by the dataFormat
    // range.

    const labObject = () => ({
        type: eColourType.Lab, L: 50.196, a: 0, b: 0,
        whitePoint: {desc: 'd50', X: 0.96422, Y: 1, Z: 0.82521}
    });

    // Mid-scale in each encoding, all denoting the same colour.
    const MID = {int8: [128, 128, 128], int16: [32896, 32896, 32896]};

    describe('array and object agree', () => {
        for(const dataFormat of ['int8', 'int16']){
            test(`${dataFormat}: the array result equals the object result`, () => {
                const t = new Transform({dataFormat, buildLut: false});
                t.create('*labd50', '*sRGB', eIntent.relative);

                const fromArray  = Array.from(t.transform(MID[dataFormat]));
                const fromObject = Array.from(t.transform(labObject()));
                expect(fromArray).toEqual(fromObject);
                expect(fromArray.every(v => !Number.isNaN(v))).toBe(true);
            });
        }
    });

    describe('both labInputAdaptation branches', () => {
        // With adaptation ON  the pipeline is cmsLab_to_LabD50 -> LabD50_to_PCSv4.
        // With adaptation OFF it is LabD50_to_PCSv4 alone. Arrays used to throw
        // on the first and produce NaN on the second.
        for(const labInputAdaptation of [true, false]){
            for(const dataFormat of ['int8', 'int16']){
                test(`adaptation:${labInputAdaptation} ${dataFormat} takes an array`, () => {
                    const t = new Transform({dataFormat, buildLut: false, labInputAdaptation});
                    t.create('*labd50', '*sRGB', eIntent.relative);

                    const out = Array.from(t.transform(MID[dataFormat]));
                    expect(out.length).toBe(3);
                    expect(out.every(v => typeof v === 'number' && !Number.isNaN(v))).toBe(true);
                });
            }
        }

        test('an array gives the SAME answer whether adaptation is on or off', () => {
            // Not a coincidence and worth pinning: a PCS-encoded array is D50
            // by definition, so adaptation has nothing to adapt. Passing an
            // array is the caller saying they have handled the encoding.
            const on  = new Transform({dataFormat: 'int8', buildLut: false, labInputAdaptation: true});
            const off = new Transform({dataFormat: 'int8', buildLut: false, labInputAdaptation: false});
            on.create('*labd50', '*sRGB', eIntent.relative);
            off.create('*labd50', '*sRGB', eIntent.relative);

            expect(Array.from(on.transform([128, 128, 128])))
                .toEqual(Array.from(off.transform([128, 128, 128])));
        });
    });

    test('transformArray works for a Lab source with no LUT', () => {
        // The gap this whole thread started from.
        const t = new Transform({dataFormat: 'int8', buildLut: false});
        t.create('*labd50', '*sRGB', eIntent.relative);

        const out = t.transformArray(
            new Uint8ClampedArray([128, 128, 128, 200, 100, 150]), false, false, false, 2);

        expect(out.length).toBe(6);
        expect(Array.from(out).every(v => typeof v === 'number' && !Number.isNaN(v))).toBe(true);

        // And it agrees with the single-colour API, which is the contract:
        // whatever transform(x) does, transformArray([x, ...]) does too.
        const single = Array.from(t.transform([128, 128, 128]));
        expect(Array.from(out).slice(0, 3)).toEqual(single);
    });

    test('the encoding lands on the documented 8-bit Lab values', () => {
        // 0 -> L 0 / a -128,  128 -> L 50.196 / a 0,  255 -> L 100 / a +127,
        // for BOTH v2 (x256) and v4 (x257) — the multiplier is
        // labNumerator/255, so one expression covers both.
        for(const version of ['v2', 'v4']){
            const enc = convert.labEncoding[version];
            const mul = enc.labNumerator / 255;

            const at = v => convert.int162Lab(v * mul, v * mul, v * mul, enc);
            expect(at(0).L).toBeCloseTo(0, 6);
            expect(at(0).a).toBeCloseTo(-128, 6);
            expect(at(128).L).toBeCloseTo(50.196, 3);
            expect(at(128).a).toBeCloseTo(0, 6);
            expect(at(255).L).toBeCloseTo(100, 6);
            expect(at(255).a).toBeCloseTo(127, 6);
        }
    });

    test('a malformed array is rejected rather than silently converted', () => {
        const t = new Transform({dataFormat: 'int8', buildLut: false});
        t.create('*labd50', '*sRGB', eIntent.relative);
        expect(() => t.transform([128, 128])).toThrow();
    });
});
