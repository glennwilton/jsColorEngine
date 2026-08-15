/**
 * N-channel (5CLR-15CLR) profile support — sanity contract.
 *
 * Uses the 7CLR press profile in testbed/profiles/6col/ (Lab PCS,
 * channels C M m Y K Or Bl, "STRAIGHT BLACK" separation, A2B 5-pt grid,
 * B2A 33-pt grid).
 *
 * No lcms reference numbers yet — these tests pin down physical sanity:
 *   - Lab white → zero ink on every channel (paper = no ink)
 *   - Lab black → K-dominant separation (straight black profile)
 *   - zero ink → paper white Lab, full ink → near-black Lab
 *   - array and {c0..cN} object inputs agree
 *   - Lab/RGB → NCh supports buildLut (3D input → generic NCh loops)
 *   - NCh input + buildLut degrades gracefully to the per-pixel pipeline
 *     (KernelND declines the LUT via provideLut() === false)
 *
 * When lcms validation numbers arrive, tighten these to ΔE tolerances.
 */

const path = require('path');
const { Transform, Profile, eIntent } = require('../src/main.js');

const PROFILE_7CLR = path.join(__dirname, '..', 'testbed', 'profiles', '6col',
    'Flag Direct Oct 05 360x720N 100L 270T CMmYKOrBlFy Full Spot STRAIGHT BLACK.icm');

function load7clr(){
    const p = new Profile();
    p.loadFile(PROFILE_7CLR);
    return p;
}

describe('NChannel — 7CLR profile decode', () => {

    const p = load7clr();

    test('loads with NChannel type and 7 channels', () => {
        expect(p.loaded).toBe(true);
        expect(p.header.space.trim()).toBe('7CLR');
        expect(p.outputChannels).toBe(7);
    });

    test('A2B decodes a 7-input CLUT with per-dimension gridPoints', () => {
        const lut = p.A2B[1];
        expect(lut.inputChannels).toBe(7);
        expect(lut.outputChannels).toBe(3);
        expect(Array.isArray(lut.gridPoints) || ArrayBuffer.isView(lut.gridPoints)).toBe(true);
        expect(lut.gridPoints.length).toBe(7);
    });

    test('B2A decodes a 3-input, 7-output CLUT', () => {
        const lut = p.B2A[1];
        expect(lut.inputChannels).toBe(3);
        expect(lut.outputChannels).toBe(7);
    });
});

describe('NChannel — Lab → 7CLR (accuracy pipeline)', () => {

    const p = load7clr();
    const t = new Transform({ dataFormat: 'object', buildLut: false });
    t.create('*lab', p, eIntent.relative);

    test('channel counts settle to 3 → 7', () => {
        expect(t.inputChannels).toBe(3);
        expect(t.outputChannels).toBe(7);
    });

    test('Lab media white → zero ink on all 7 channels', () => {
        const ink = t.transform(t.Lab(100, 0, 0));
        expect(ink.length).toBe(7);
        for(const v of ink){
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(0.001);
        }
    });

    test('Lab black → K-dominant separation (straight black)', () => {
        const ink = t.transform(t.Lab(0, 0, 0));
        expect(ink.length).toBe(7);
        expect(ink[3]).toBeGreaterThan(0.99);         // K channel ~ full
        for(const v of ink){
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
        }
    });

    test('Lab mid grey → finite in-range separation with real ink', () => {
        const ink = t.transform(t.Lab(50, 0, 0));
        expect(ink.length).toBe(7);
        let total = 0;
        for(const v of ink){
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThanOrEqual(1);
            total += v;
        }
        expect(total).toBeGreaterThan(0.5);           // grey needs ink
    });
});

describe('NChannel — 7CLR → Lab (N-D interpolator)', () => {

    const p = load7clr();
    const t = new Transform({ dataFormat: 'object', buildLut: false });
    t.create(p, '*lab', eIntent.relative);

    test('channel counts settle to 7 → 3', () => {
        expect(t.inputChannels).toBe(7);
        expect(t.outputChannels).toBe(3);
    });

    test('zero ink → paper white Lab', () => {
        const lab = t.transform([0, 0, 0, 0, 0, 0, 0]);
        expect(lab.L).toBeGreaterThan(95);
        expect(Math.abs(lab.a)).toBeLessThan(3);
        expect(Math.abs(lab.b)).toBeLessThan(3);
    });

    test('full ink on all channels → near-black Lab', () => {
        const lab = t.transform([1, 1, 1, 1, 1, 1, 1]);
        expect(lab.L).toBeLessThan(10);
    });

    test('single inks land in distinct hue directions', () => {
        // K (ch 3) → dark neutral-ish; Or (ch 4) → strongly positive a & b
        const k  = t.transform([0, 0, 0, 1, 0, 0, 0]);
        const or = t.transform([0, 0, 0, 0, 1, 0, 0]);
        expect(k.L).toBeLessThan(40);
        expect(or.a).toBeGreaterThan(30);
        expect(or.b).toBeGreaterThan(30);
    });

    test('{c0..cN} object input matches array input', () => {
        const fromArray  = t.transform([0, 0, 0, 0, 1, 0, 0]);
        const fromObject = t.transform({ c0: 0, c1: 0, c2: 0, c3: 0, c4: 1, c5: 0, c6: 0 });
        expect(fromObject.L).toBeCloseTo(fromArray.L, 10);
        expect(fromObject.a).toBeCloseTo(fromArray.a, 10);
        expect(fromObject.b).toBeCloseTo(fromArray.b, 10);
    });
});

describe('NChannel — buildLut behaviour', () => {

    test('RGB → 7CLR bakes a LUT and transformArray runs the 3D→NCh loop', () => {
        const p = load7clr();
        const t = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int' });
        t.create('*srgb', p, eIntent.relative);

        expect(t.hasLut()).toBe(true);
        expect(t.lut.outputChannels).toBe(7);

        // white, black — 2 pixels RGB in, 14 bytes out
        const out = t.transformArray(new Uint8ClampedArray([255, 255, 255, 0, 0, 0]), false, false);
        expect(out.length).toBe(14);
        // white pixel → no ink
        for(let c = 0; c < 7; c++){
            expect(out[c]).toBeLessThanOrEqual(2);
        }
        // black pixel → K-dominant (sRGB black is less deep than Lab 0 but K carries it)
        expect(out[7 + 3]).toBeGreaterThan(128);
    });

    test('7CLR input + buildLut degrades gracefully to the pipeline path', () => {
        const p = load7clr();
        const t = new Transform({ dataFormat: 'object', buildLut: true });
        t.create(p, '*lab', eIntent.relative);

        // KernelND.provideLut() returns false — LUT declined, pipeline used
        expect(t.lut).toBe(false);
        expect(t.builtLut).toBe(false);

        const lab = t.transform([0, 0, 0, 0, 0, 0, 0]);
        expect(lab.L).toBeGreaterThan(95);
    });
});
