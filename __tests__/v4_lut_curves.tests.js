/**
 * v4 mAB/mBA curve-stage gates must treat a missing set the same way
 * whether decodeICC wrote `false` or a hand-made LUT left the field
 * undefined / empty. PowerScripts hit
 * "Cannot read properties of undefined (reading 'length')" on the
 * older `lut.xCurves !== false` check.
 */

const path = require('path');
const { Transform, eIntent } = require('../src/main');
const Profile = require('../src/Profile');

const V4_SRGB = path.join(__dirname, '..', 'testbed', 'profiles', 'rgb',
                          'sRGB_v4_ICC_preference.icc');

const PASS = [
    { passThrough: true },
    { passThrough: true },
    { passThrough: true },
];

const SENTINELS = [undefined, false, []];
const FIELDS = ['aCurves', 'mCurves', 'bCurves'];

function loadV4() {
    const p = new Profile();
    p.loadFile(V4_SRGB);
    expect(p.loaded).toBe(true);
    expect(p.version).toBe(4);
    return p;
}

function applyField(luts, field, value) {
    for (const lut of luts) {
        if (!lut) continue;
        if (value === undefined) delete lut[field];
        else lut[field] = value;
    }
}

function sample(...args) {
    const t = new Transform({ dataFormat: 'device', buildLut: false });
    t.create(...args);
    return t.transform([0.5, 0.3, 0.2]);
}

describe('isPassThrough', () => {
    const t = new Transform();

    test('undefined and [] are pass-through (no curve stage)', () => {
        expect(t.isPassThrough(undefined)).toBe(true);
        expect(t.isPassThrough([])).toBe(true);
    });

    test('false (decodeICC missing-offset sentinel) is pass-through', () => {
        expect(t.isPassThrough(false)).toBe(true);
    });

    test('valid identity curves stay pass-through; a live curve does not', () => {
        expect(t.isPassThrough(PASS)).toBe(true);
        expect(t.isPassThrough([{ passThrough: false }])).toBe(false);
        expect(t.isPassThrough([{ passThrough: true }, { passThrough: false }])).toBe(false);
    });
});

describe('v4 B2A (PCS → device) missing curve sets', () => {
    let baseline;

    beforeAll(() => {
        const p = loadV4();
        applyField(p.B2A, 'aCurves', PASS);
        applyField(p.B2A, 'mCurves', PASS);
        applyField(p.B2A, 'bCurves', PASS);
        baseline = sample('*sRGB', p, eIntent.relative);
    });

    for (const field of FIELDS) {
        for (const sentinel of SENTINELS) {
            const label = sentinel === undefined ? 'undefined'
                : sentinel === false ? 'false' : '[]';
            test(`B2A ${field} = ${label} does not throw and matches pass-through`, () => {
                const p = loadV4();
                applyField(p.B2A, 'aCurves', PASS);
                applyField(p.B2A, 'mCurves', PASS);
                applyField(p.B2A, 'bCurves', PASS);
                applyField(p.B2A, field, sentinel);
                expect(sample('*sRGB', p, eIntent.relative)).toEqual(baseline);
            });
        }
    }
});

test('PowerScripts case: omitted aCurves on a v4 B2A LUT does not throw', () => {
    const p = loadV4();
    delete p.B2A[eIntent.relative].aCurves;
    expect(p.B2A[eIntent.relative].aCurves).toBeUndefined();
    const t = new Transform({ dataFormat: 'device', buildLut: false });
    expect(() => t.create('*sRGB', p, eIntent.relative)).not.toThrow();
    expect(t.transform([0.2, 0.4, 0.6])).toEqual(expect.any(Array));
});

describe('v4 missing matrix (same !== false trap)', () => {
    const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

    test('isIdentityMatrix treats a missing matrix as skip-stage', () => {
        const t = new Transform();
        expect(t.isIdentityMatrix(undefined)).toBe(true);
        expect(t.isIdentityMatrix(false)).toBe(true);
        expect(t.isIdentityMatrix(IDENTITY)).toBe(true);
        expect(t.isIdentityMatrix([2, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])).toBe(false);
    });

    test('B2A matrix omitted or false matches an identity matrix', () => {
        const ident = loadV4();
        applyField(ident.B2A, 'matrix', IDENTITY);
        const expected = sample('*sRGB', ident, eIntent.relative);

        const missing = loadV4();
        applyField(missing.B2A, 'matrix', undefined);
        expect(sample('*sRGB', missing, eIntent.relative)).toEqual(expected);

        const sent = loadV4();
        applyField(sent.B2A, 'matrix', false);
        expect(sample('*sRGB', sent, eIntent.relative)).toEqual(expected);
    });
});

describe('v4 A2B (device → PCS) missing curve sets', () => {
    let baseline;

    beforeAll(() => {
        const p = loadV4();
        applyField(p.A2B, 'aCurves', PASS);
        applyField(p.A2B, 'mCurves', PASS);
        applyField(p.A2B, 'bCurves', PASS);
        baseline = sample(p, '*Lab', eIntent.relative);
    });

    for (const field of FIELDS) {
        for (const sentinel of SENTINELS) {
            const label = sentinel === undefined ? 'undefined'
                : sentinel === false ? 'false' : '[]';
            test(`A2B ${field} = ${label} does not throw and matches pass-through`, () => {
                const p = loadV4();
                applyField(p.A2B, 'aCurves', PASS);
                applyField(p.A2B, 'mCurves', PASS);
                applyField(p.A2B, 'bCurves', PASS);
                applyField(p.A2B, field, sentinel);
                expect(sample(p, '*Lab', eIntent.relative)).toEqual(baseline);
            });
        }
    }
});
