/**
 * LutBuilder — Stage 1 Jest tests
 *
 * Unit tests (mechanics):
 *   - virtualProfile() helpers
 *   - create() grid fill, callback contract, loop order
 *   - createIdentity()
 *   - toLut() shape and content
 *   - toTransform() — identity round-trip in int8 and int16
 *   - fromTransform() — extract an engine-built LUT
 *   - editLut() — per-cell mutation
 *   - clone() — deep copy independence
 *   - metadata methods
 *   - error throws
 *
 * Workflow tests (real colour data):
 *   W1 — Non-LUT transform (ground truth) vs LutBuilder-extracted LUT:
 *        measures interpolation error on real sRGB → CMYK conversion
 *   W2 — editLut() TAC limit applied to a real CMYK LUT
 *   W3 — Clone-and-diverge: two independent variants from one base LUT
 *   W4 — Custom creative callback (saturation boost) produces measurable effect
 */

'use strict';

const path = require('path');
const { Transform, eIntent } = require('../src/main');
const Profile = require('../src/Profile');
const {
    LutBuilder,
    virtualProfile,
    virtualRGB,
    virtualCMYK,
    virtualGray,
    virtualLab,
} = require('../samples/LutBuilder/LutBuilder');

const eProfileType = require('../src/main').eProfileType;

// ── Profile loaded once for integration tests ─────────────────────────────────

let cmykProfile;
beforeAll(async () => {
    cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + path.join(__dirname, 'GRACoL2006_Coated1v2.icc'));
});

// ─── virtualProfile helpers ───────────────────────────────────────────────────

describe('virtualProfile helpers', () => {
    test('virtualRGB produces correct shape', () => {
        const d = virtualRGB('sRGB input');
        expect(d.header.colorSpace).toBe('RGB');
        expect(d.name).toBe('sRGB input');
        expect(d.type).toBe(eProfileType.RGBMatrix);
        expect(d.version).toBe(4);
    });

    test('virtualCMYK produces correct shape', () => {
        const d = virtualCMYK('Press output');
        expect(d.header.colorSpace).toBe('CMYK');
        expect(d.type).toBe(eProfileType.CMYK);
    });

    test('virtualGray produces correct shape', () => {
        const d = virtualGray('Mono');
        expect(d.header.colorSpace).toBe('GRAY');
        expect(d.type).toBe(eProfileType.Gray);
    });

    test('virtualLab produces correct shape', () => {
        const d = virtualLab('Lab working');
        expect(d.header.colorSpace).toBe('Lab');
        expect(d.type).toBe(eProfileType.Lab);
    });

    test('virtualProfile with explicit type override', () => {
        const d = virtualProfile({ colorSpace: 'RGB', name: 'test', type: eProfileType.RGBLut });
        expect(d.type).toBe(eProfileType.RGBLut);
    });

    test('virtualProfile with whitepoint opts', () => {
        const wp = { X: 0.96422, Y: 1.0, Z: 0.82521 };
        const d = virtualProfile({ colorSpace: 'RGB', name: 'test' }, { whitePoint: wp });
        expect(d.whitePoint).toBe(wp);
    });

    test('virtualProfile throws on unknown colorSpace', () => {
        expect(() => virtualProfile({ colorSpace: 'XYZ99', name: 'bad' })).toThrow();
    });

    // '*' prefix — engine built-in virtual profiles
    test('virtualRGB("*sRGB") returns full descriptor with normalised colorSpace', () => {
        const d = virtualRGB('*sRGB');
        // header.colorSpace is normalised from header.space ('rgb' → 'RGB') in _profile2Desc
        expect(d.header.colorSpace).toBe('RGB');
        expect(d.name).toBeTruthy();
        expect(d.type).toBeDefined();
        expect(d.version).toBeDefined();
        // Full path has engine header fields the minimal path does not carry
        expect(d.header.pcs).toBeDefined();    // 'XYZ' for RGB profiles
        expect(d.header.pClass).toBeDefined(); // 'mntr' for display profiles
    });

    test('virtualRGB("*AdobeRGB") loads correctly', () => {
        const d = virtualRGB('*AdobeRGB');
        expect(d.header.colorSpace).toBe('RGB');
        expect(d.type).toBe(eProfileType.RGBMatrix);
    });

    test('virtualLab("*Lab") returns Lab descriptor with PCS encoding', () => {
        const d = virtualLab('*Lab');
        // Lab colorSpace normalised from 'Lab' → 'LAB' by toUpperCase()
        expect(d.header.colorSpace).toBe('LAB');
        expect(d.type).toBe(eProfileType.Lab);
        expect(d.PCSEncode).toBeDefined();   // PCS encoding set for Lab profiles
    });

    test('virtualProfile({ name: "*sRGB", colorSpace: "RGB" }) — * via virtualProfile directly', () => {
        const d = virtualProfile({ colorSpace: 'RGB', name: '*sRGB' });
        // Proves the * path was taken: has pcs field that the minimal path omits
        expect(d.header.pcs).toBeDefined();
    });

    test('virtualProfile("*sRGB") — string shorthand works identically to object form', () => {
        const fromString = virtualProfile('*sRGB');
        const fromObject = virtualProfile({ colorSpace: 'RGB', name: '*sRGB' });
        expect(fromString.header.colorSpace).toBe(fromObject.header.colorSpace);
        expect(fromString.type).toBe(fromObject.type);
        expect(fromString.version).toBe(fromObject.version);
    });

    test('mediaWhitePoint: RGB virtual profiles store D50-adapted primaries', () => {
        // The engine uses virtualProfileUsesD50AdaptedPrimaries = true by default.
        // Native sRGB/AdobeRGB white is D65, but stored as D50-adapted in the engine.
        const srgb  = virtualProfile('*sRGB');
        const adobe = virtualProfile('*AdobeRGB');
        expect(srgb.mediaWhitePoint.desc).toBe('d50');
        expect(adobe.mediaWhitePoint.desc).toBe('d50');
    });

    test('mediaWhitePoint: LabD65 is the exception — D65 native', () => {
        const labD65 = virtualProfile('*LabD65');
        expect(labD65.mediaWhitePoint.desc).toBe('d65');
    });

    test('virtualProfile with unknown * name throws with helpful message', () => {
        expect(() => virtualProfile({ colorSpace: 'RGB', name: '*NotARealProfile' }))
            .toThrow(/unknown built-in profile/);
    });

    test('*sRGB descriptor can wire into toTransform() without throwing', () => {
        expect(() => {
            new LutBuilder()
                .createIdentity(3, 9)
                .setChain([virtualRGB('*sRGB'), eIntent.perceptual, virtualRGB('*sRGB')])
                .toTransform({ dataFormat: 'int8' });
        }).not.toThrow();
    });
});

// ─── create() ────────────────────────────────────────────────────────────────

describe('create()', () => {
    test('identity callback produces correct u16 at extremes (3D, size 3)', () => {
        const b = new LutBuilder();
        b.create({ inChannels: 3, outChannels: 3, size: 3 }, (inp) => inp.slice());

        expect(b._u16).toBeInstanceOf(Uint16Array);
        // 3^3 cells × 3 channels = 81 values
        expect(b._u16.length).toBe(81);

        // First cell (0,0,0) → [0,0,0] → u16 [0,0,0]
        expect(b._u16[0]).toBe(0);
        expect(b._u16[1]).toBe(0);
        expect(b._u16[2]).toBe(0);

        // Last cell (1,1,1) → [1,1,1] → u16 [65535,65535,65535]
        expect(b._u16[78]).toBe(65535);
        expect(b._u16[79]).toBe(65535);
        expect(b._u16[80]).toBe(65535);
    });

    test('loop order: axis 0 varies slowest, axis 2 fastest (3D)', () => {
        const visitOrder = [];
        new LutBuilder().create(
            { inChannels: 3, outChannels: 1, size: 2 },
            (inp, cell) => {
                visitOrder.push(cell.indices.slice());
                return [0];
            }
        );
        // size=2: indices are 0 or 1 per axis
        // Expected: [0,0,0],[0,0,1],[0,1,0],[0,1,1],[1,0,0],[1,0,1],[1,1,0],[1,1,1]
        expect(visitOrder[0]).toEqual([0, 0, 0]);
        expect(visitOrder[1]).toEqual([0, 0, 1]);
        expect(visitOrder[2]).toEqual([0, 1, 0]);
        expect(visitOrder[4]).toEqual([1, 0, 0]);
        expect(visitOrder[7]).toEqual([1, 1, 1]);
    });

    test('cell.sizeMax and normalised values are correct', () => {
        const cells = [];
        new LutBuilder().create(
            { inChannels: 1, outChannels: 1, size: 3 },
            (inp, cell) => { cells.push({ inp: inp.slice(), cell }); return [0]; }
        );
        expect(cells[0].cell.sizeMax).toBe(2);
        expect(cells[0].inp[0]).toBeCloseTo(0);
        expect(cells[1].inp[0]).toBeCloseTo(0.5);
        expect(cells[2].inp[0]).toBeCloseTo(1);
    });

    test('output is clamped to [0..1]', () => {
        const b = new LutBuilder();
        b.create({ inChannels: 1, outChannels: 1, size: 2 }, () => [1.5]);
        expect(b._u16[0]).toBe(65535);  // clamped to 1.0
        b.create({ inChannels: 1, outChannels: 1, size: 2 }, () => [-0.5]);
        expect(b._u16[0]).toBe(0);      // clamped to 0.0
    });

    test('4D grid total size is N^4 * outCh', () => {
        const b = new LutBuilder();
        b.create({ inChannels: 4, outChannels: 3, size: 5 },
            (inp) => [inp[0], inp[1], inp[2]]);
        expect(b._u16.length).toBe(5 * 5 * 5 * 5 * 3);  // 1875
    });

    test('throws on bad inChannels', () => {
        expect(() => new LutBuilder().create({ inChannels: 0, outChannels: 3, size: 3 }, () => []))
            .toThrow();
        expect(() => new LutBuilder().create({ inChannels: 5, outChannels: 3, size: 3 }, () => []))
            .toThrow();
    });

    test('throws if callback returns too few values', () => {
        expect(() => new LutBuilder().create(
            { inChannels: 3, outChannels: 4, size: 2 },
            () => [0.5, 0.5]  // only 2, need 4
        )).toThrow();
    });

    test('chaining returns this', () => {
        const b = new LutBuilder();
        const ret = b.create({ inChannels: 1, outChannels: 1, size: 2 }, () => [0]);
        expect(ret).toBe(b);
    });
});

// ─── createIdentity() ─────────────────────────────────────────────────────────

describe('createIdentity()', () => {
    test('produces identity u16 at grid corners (3ch)', () => {
        const b = new LutBuilder().createIdentity(3, 3);
        // cell (0,0,0): first 3 values should be [0,0,0]
        expect(b._u16[0]).toBe(0);
        expect(b._u16[1]).toBe(0);
        expect(b._u16[2]).toBe(0);
        // cell (2,2,2): last 3 values should be [65535,65535,65535]
        expect(b._u16[78]).toBe(65535);
        expect(b._u16[79]).toBe(65535);
        expect(b._u16[80]).toBe(65535);
    });

    test('same result as create() with identity callback', () => {
        const b1 = new LutBuilder().createIdentity(3, 5);
        const b2 = new LutBuilder().create(
            { inChannels: 3, outChannels: 3, size: 5 },
            (inp) => inp.slice()
        );
        expect(b1._u16).toEqual(b2._u16);
    });

    test('throws on unsupported channel count', () => {
        expect(() => new LutBuilder().createIdentity(5, 3)).toThrow();
    });
});

// ─── toLut() ─────────────────────────────────────────────────────────────────

describe('toLut()', () => {
    test('required fields are present and typed correctly', () => {
        const lut = new LutBuilder().createIdentity(3, 17).toLut();
        expect(lut.CLUT).toBeInstanceOf(Float64Array);
        expect(lut.inputChannels).toBe(3);
        expect(lut.outputChannels).toBe(3);
        expect(Array.isArray(lut.gridPoints)).toBe(true);
        expect(lut.gridPoints).toHaveLength(3);
        expect(lut.gridPoints[0]).toBe(17);
        expect(lut.version).toBe(1);
        expect(lut.dataType).toBe('f64');
        expect(lut.encoding).toBe('number');
        expect(Array.isArray(lut.chain)).toBe(true);
    });

    test('strides match Transform.js createLut() formula (3D)', () => {
        const N = 17, C = 3;
        const lut = new LutBuilder().createIdentity(3, N).toLut();
        expect(lut.g1).toBe(N);
        expect(lut.g2).toBe(N * N);
        expect(lut.g3).toBe(N * N * N);
        expect(lut.go0).toBe(C);
        expect(lut.go1).toBe(N * C);
        expect(lut.go2).toBe(N * N * C);
        expect(lut.go3).toBe(N * N * N * C);
    });

    test('strides for 4D', () => {
        const N = 5, C = 3;
        const lut = new LutBuilder()
            .create({ inChannels: 4, outChannels: 3, size: N }, (inp) => [inp[0], inp[1], inp[2]])
            .toLut();
        expect(lut.g1).toBe(N);
        expect(lut.g2).toBe(N * N);
        expect(lut.g3).toBe(N * N * N);
        expect(lut.go3).toBe(N * N * N * C);
    });

    test('strides for 1D', () => {
        const lut = new LutBuilder().createIdentity(1, 64).toLut();
        expect(lut.g2).toBe(0);
        expect(lut.g3).toBe(0);
        expect(lut.go2).toBe(0);
        expect(lut.go3).toBe(0);
    });

    test('CLUT values are [0..1] float (identity)', () => {
        const lut = new LutBuilder().createIdentity(3, 3).toLut();
        // First cell (0,0,0): all zeros
        expect(lut.CLUT[0]).toBeCloseTo(0);
        // Last cell (1,1,1): all ones
        const last = lut.CLUT.length - 3;
        expect(lut.CLUT[last]).toBeCloseTo(1);
    });

    test('auto-generated chain has correct structure', () => {
        const lut = new LutBuilder().createIdentity(3, 3).toLut();
        expect(lut.chain).toHaveLength(3);
        expect(lut.chain[0]).toHaveProperty('header');
        expect(lut.chain[0]).toHaveProperty('name');
        expect(lut.chain[0]).toHaveProperty('type');
        expect(typeof lut.chain[1]).toBe('number'); // intent
        expect(lut.chain[2]).toHaveProperty('header');
    });

    test('explicit chain is used when set', () => {
        const inDesc  = virtualRGB('My RGB');
        const outDesc = virtualCMYK('My CMYK');
        const lut = new LutBuilder()
            .create({ inChannels: 3, outChannels: 4, size: 3 }, (inp) => [inp[0], inp[1], inp[2], 0])
            .setChain([inDesc, eIntent.perceptual, outDesc])
            .toLut();
        expect(lut.chain[0]).toBe(inDesc);
        expect(lut.chain[2]).toBe(outDesc);
    });

    test('meta is included when set', () => {
        const lut = new LutBuilder()
            .createIdentity(3, 3)
            .addMeta({ author: 'Test' })
            .toLut();
        expect(lut.meta.author).toBe('Test');
    });

    test('throws when no LUT loaded', () => {
        expect(() => new LutBuilder().toLut()).toThrow();
    });
});

// ─── toTransform() + identity round-trip ─────────────────────────────────────

describe('toTransform() — identity round-trip', () => {
    test('int8: 3D identity LUT transforms pixels ≈ identity', () => {
        const transform = new LutBuilder()
            .createIdentity(3, 33)
            .setChain([virtualRGB('in'), eIntent.perceptual, virtualRGB('out')])
            .toTransform({ dataFormat: 'int8' });

        const input  = new Uint8ClampedArray([0, 0, 0, 128, 128, 128, 255, 255, 255]);
        const output = transform.transformArray(input);
        expect(transform.lastUsedKernel).toBe('kernel3D');

        expect(output).toBeInstanceOf(Uint8ClampedArray);
        // At grid corners the identity is exact; allow ±1 for interpolation
        for (let i = 0; i < input.length; i++) {
            expect(Math.abs(output[i] - input[i])).toBeLessThanOrEqual(1);
        }
    });

    test('int8 LUT: Uint8ClampedArray in/out, identity is bit-exact at corners', () => {
        const transform = new LutBuilder()
            .createIdentity(3, 33)
            .setChain([virtualRGB('in'), eIntent.perceptual, virtualRGB('out')])
            .toTransform({ dataFormat: 'int8' });

        const input  = new Uint8ClampedArray([0, 128, 255]);
        const output = transform.transformArray(input);

        expect(output).toBeInstanceOf(Uint8ClampedArray);
        for (let i = 0; i < input.length; i++) {
            expect(Math.abs(output[i] - input[i])).toBeLessThanOrEqual(1);
        }
    });

    test('int16 LUT: Uint16Array in/out, identity preserves 16-bit precision', () => {
        // After the setLut() fix: dataFormat:'int16' produces Uint16Array output.
        // The LUT is the authority — setLut() re-resolves lutMode for int16.
        const transform = new LutBuilder()
            .createIdentity(3, 33)
            .setChain([virtualRGB('in'), eIntent.perceptual, virtualRGB('out')])
            .toTransform({ dataFormat: 'int16' });

        const input  = new Uint16Array([0, 16384, 32768, 49152, 65535,
                                         0, 16384, 32768, 49152]);
        const output = transform.transformArray(input);

        expect(output).toBeInstanceOf(Uint16Array);
        for (let i = 0; i < input.length; i++) {
            expect(Math.abs(output[i] - input[i])).toBeLessThanOrEqual(1);
        }
    });

    test('device LUT: [0-1] arrays in and out, plain Array result', () => {
        // dataFormat:'device' — pure float pipeline, no integer scaling.
        // Plain Array of [0..1] floats both ways. Useful for sub-u8 precision.
        const transform = new LutBuilder()
            .createIdentity(3, 33)
            .setChain([virtualRGB('in'), eIntent.perceptual, virtualRGB('out')])
            .toTransform({ dataFormat: 'device' });

        const input  = [0, 0.25, 0.5, 0.75, 1.0, 0.1];   // 2 pixels
        const output = transform.transformArray(input);

        expect(Array.isArray(output)).toBe(true);
        for (let i = 0; i < input.length; i++) {
            expect(Math.abs(output[i] - input[i])).toBeLessThan(0.01);
        }
    });

    test('custom callback: boost red channel', () => {
        const transform = new LutBuilder()
            .create(
                { inChannels: 3, outChannels: 3, size: 33 },
                ([r, g, b]) => [Math.min(1, r * 1.5), g, b]
            )
            .setChain([virtualRGB('in'), eIntent.perceptual, virtualRGB('out')])
            .toTransform({ dataFormat: 'int8' });

        // Mid-grey input: R=100, G=100, B=100
        const out = transform.transformArray(new Uint8ClampedArray([100, 100, 100]));
        // Red should be boosted ~150, green and blue unchanged
        expect(out[0]).toBeGreaterThan(120);
        expect(Math.abs(out[1] - 100)).toBeLessThanOrEqual(2);
        expect(Math.abs(out[2] - 100)).toBeLessThanOrEqual(2);
    });
});

// ─── fromTransform() ─────────────────────────────────────────────────────────

describe('fromTransform()', () => {
    test('extracts LUT from engine-built Transform (int16)', async () => {
        const t = new Transform({ dataFormat: 'int16', buildLut: true });
        t.create('*srgb', cmykProfile, eIntent.perceptual);
        expect(t.lut).toBeTruthy();

        const b = LutBuilder.fromTransform(t);
        expect(b._u16).toBeInstanceOf(Uint16Array);
        expect(b._inCh).toBe(3);
        expect(b._outCh).toBe(4);
        expect(b._u16.length).toBe(33 * 33 * 33 * 4);
    });

    test('round-trip: fromTransform → toTransform gives same pixel output', async () => {
        const t1 = new Transform({ dataFormat: 'int8', buildLut: true });
        t1.create('*srgb', cmykProfile, eIntent.perceptual);

        const t2 = LutBuilder.fromTransform(t1).toTransform({ dataFormat: 'int8' });

        const pixels = new Uint8ClampedArray([255, 0, 0,   0, 255, 0,   0, 0, 255,   255, 255, 255]);
        const out1   = t1.transformArray(pixels);
        const out2   = t2.transformArray(pixels);

        // Allow ±1 for the u16→u8 quantisation on the extract path
        for (let i = 0; i < out1.length; i++) {
            expect(Math.abs(out1[i] - out2[i])).toBeLessThanOrEqual(1);
        }
    });

    test('throws when Transform has no LUT', () => {
        const t = new Transform({ dataFormat: 'int16' });
        t.create('*srgb', '*srgb', eIntent.perceptual);
        expect(() => LutBuilder.fromTransform(t)).toThrow();
    });
});

// ─── editLut() ───────────────────────────────────────────────────────────────

describe('editLut()', () => {
    test('can invert channel 0 of an identity LUT', () => {
        const b = new LutBuilder().createIdentity(3, 3);
        b.editLut((output, cell) => {
            output[0] = 1 - output[0];
            return output;
        });
        const lut = b.toLut();
        // First cell (0,0,0): channel 0 was 0, should now be 1
        expect(lut.CLUT[0]).toBeCloseTo(1);
        // Last cell (1,1,1): channel 0 was 1, should now be 0
        const last = lut.CLUT.length - 3;
        expect(lut.CLUT[last]).toBeCloseTo(0);
    });

    test('cell.normalised matches cell.indices / sizeMax', () => {
        const cells = [];
        new LutBuilder()
            .create({ inChannels: 2, outChannels: 1, size: 3 }, () => [0])
            .editLut((out, cell) => {
                cells.push({ indices: cell.indices.slice(), norm: cell.normalised.slice() });
                return out;
            });
        for (const c of cells) {
            for (let ax = 0; ax < c.indices.length; ax++) {
                expect(c.norm[ax]).toBeCloseTo(c.indices[ax] / 2);
            }
        }
    });

    test('output is clamped when callback exceeds range', () => {
        const b = new LutBuilder().createIdentity(1, 2);
        b.editLut(() => [2.0]);   // exceeds 1
        expect(b._u16[0]).toBe(65535);
    });

    test('chaining: editLut returns this', () => {
        const b = new LutBuilder().createIdentity(1, 2);
        expect(b.editLut((o) => o)).toBe(b);
    });

    test('throws when no LUT loaded', () => {
        expect(() => new LutBuilder().editLut((o) => o)).toThrow();
    });
});

// ─── clone() ─────────────────────────────────────────────────────────────────

describe('clone()', () => {
    test('produces a deep copy — mutating u16 does not affect original', () => {
        const orig   = new LutBuilder().createIdentity(3, 3);
        const cloned = orig.clone();
        cloned._u16[0] = 9999;
        expect(orig._u16[0]).toBe(0);  // unchanged
    });

    test('cloned builder produces same toLut() output', () => {
        const orig   = new LutBuilder().createIdentity(3, 5);
        const cloned = orig.clone();
        expect(orig.toLut().CLUT).toEqual(cloned.toLut().CLUT);
    });

    test('mutating cloned meta does not affect original', () => {
        const orig = new LutBuilder().createIdentity(1, 2).addMeta({ key: 'original' });
        const cl   = orig.clone();
        cl._meta.key = 'changed';
        expect(orig._meta.key).toBe('original');
    });
});

// ─── metadata methods ─────────────────────────────────────────────────────────

describe('metadata', () => {
    test('addMeta merges keys', () => {
        const b = new LutBuilder()
            .createIdentity(1, 2)
            .addMeta({ a: 1 })
            .addMeta({ b: 2 });
        expect(b._meta.a).toBe(1);
        expect(b._meta.b).toBe(2);
    });

    test('addCopyright sets copyright', () => {
        const b = new LutBuilder().createIdentity(1, 2).addCopyright('MIT');
        expect(b._meta.copyright).toBe('MIT');
    });

    test('addAdjustment appends to array', () => {
        const b = new LutBuilder()
            .createIdentity(1, 2)
            .addAdjustment('step 1')
            .addAdjustment('step 2');
        expect(b._meta.adjustments).toEqual(['step 1', 'step 2']);
    });

    test('meta appears in toLut().meta', () => {
        const lut = new LutBuilder()
            .createIdentity(1, 2)
            .addMeta({ author: 'Glenn' })
            .addCopyright('MIT')
            .toLut();
        expect(lut.meta.author).toBe('Glenn');
        expect(lut.meta.copyright).toBe('MIT');
    });

    test('no meta field on toLut() when meta is empty', () => {
        const lut = new LutBuilder().createIdentity(1, 2).toLut();
        expect(lut.meta).toBeUndefined();
    });

    test('all metadata methods return this', () => {
        const b = new LutBuilder().createIdentity(1, 2);
        expect(b.addMeta({})).toBe(b);
        expect(b.addCopyright('x')).toBe(b);
        expect(b.addAdjustment('y')).toBe(b);
        expect(b.setChain([virtualRGB('a'), eIntent.perceptual, virtualRGB('b')])).toBe(b);
    });
});

// ─── W1: Non-LUT ground truth vs LutBuilder LUT ──────────────────────────────
//
// This is the most important workflow test. It answers: "how accurate is the
// LUT approximation compared to the engine's full-precision pipeline?"
//
// Setup:
//   groundTruth  — standard Transform with no LUT (full ICC pipeline, f64)
//   lutTransform — Transform with buildLut:true → fromTransform() → toTransform()
//
// The LUT introduces interpolation error (~0.06 ΔE76 worst case at 33 points).
// In u8 pixel space the error is typically 0–2 code values on real images.

describe('W1 — non-LUT ground truth vs LutBuilder LUT (sRGB → GRACoL2006)', () => {
    let groundTruth;
    let lutTransform;

    // Representative sRGB test colours: primaries, neutrals, near-black, near-white,
    // and a few saturated values that stress the gamut boundary.
    const testPixels = new Uint8ClampedArray([
        255,   0,   0,   // red
          0, 255,   0,   // green
          0,   0, 255,   // blue
        255, 255,   0,   // yellow
          0, 255, 255,   // cyan
        255,   0, 255,   // magenta
          0,   0,   0,   // black
        255, 255, 255,   // white
        128, 128, 128,   // mid grey
         50, 100, 150,   // muted blue
        200,  80,  40,   // orange-red
         30,  80,  30,   // dark green
    ]);

    beforeAll(async () => {
        // Ground truth: full ICC pipeline, no LUT (float path)
        groundTruth = new Transform({ dataFormat: 'int8' });
        groundTruth.create('*srgb', cmykProfile, eIntent.perceptual);

        // LUT path: build LUT from the same profiles, extract, re-wire
        const lutSource = new Transform({ dataFormat: 'int8', buildLut: true });
        lutSource.create('*srgb', cmykProfile, eIntent.perceptual);
        lutTransform = LutBuilder.fromTransform(lutSource).toTransform({ dataFormat: 'int8' });
    });

    test('LUT transform produces output for all test pixels', () => {
        const out = lutTransform.transformArray(testPixels);
        expect(out).toBeInstanceOf(Uint8ClampedArray);
        // 12 pixels × 4 CMYK channels = 48 values
        expect(out.length).toBe(48);
    });

    test('LUT output is within ±2 u8 units of non-LUT ground truth', () => {
        const refOut = groundTruth.transformArray(testPixels);
        const lutOut = lutTransform.transformArray(testPixels);

        let maxDiff = 0;
        const failures = [];

        for (let i = 0; i < refOut.length; i++) {
            const diff = Math.abs(refOut[i] - lutOut[i]);
            if (diff > maxDiff) maxDiff = diff;
            if (diff > 2) {
                const pixel = Math.floor(i / 4);
                const ch    = ['C', 'M', 'Y', 'K'][i % 4];
                failures.push(`pixel ${pixel} ${ch}: ref=${refOut[i]} lut=${lutOut[i]} diff=${diff}`);
            }
        }

        if (failures.length > 0) {
            console.log('W1 max diff:', maxDiff, '\nFailures:', failures.join('\n'));
        }

        expect(maxDiff).toBeLessThanOrEqual(2);
    });

    test('max pixel difference is reported (informational)', () => {
        const refOut = groundTruth.transformArray(testPixels);
        const lutOut = lutTransform.transformArray(testPixels);

        let maxDiff = 0;
        let maxIdx  = 0;
        for (let i = 0; i < refOut.length; i++) {
            const diff = Math.abs(refOut[i] - lutOut[i]);
            if (diff > maxDiff) { maxDiff = diff; maxIdx = i; }
        }

        const ch    = ['C', 'M', 'Y', 'K'][maxIdx % 4];
        const pixel = Math.floor(maxIdx / 4);
        // Log for human review — not a pass/fail assertion
        console.log(`W1: max LUT error = ${maxDiff} u8 (pixel ${pixel}, channel ${ch})`);
        expect(maxDiff).toBeGreaterThanOrEqual(0);  // always true — captures value in output
    });
});

// ─── W2: editLut() TAC limit on real CMYK LUT ────────────────────────────────
//
// Take a real sRGB→CMYK LUT from the engine, apply a TAC (total area coverage)
// clamp at 300%, verify that all output CMYK values from a test image respect
// the limit — and that the unmodified LUT does NOT clamp (proving editLut worked).

describe('W2 — editLut() TAC limit applied to real sRGB → CMYK LUT', () => {
    const TAC_LIMIT = 3.0;   // 300% in [0..1] scale

    let baseTransform;
    let tacTransform;

    beforeAll(() => {
        const lutSource = new Transform({ dataFormat: 'int8', buildLut: true });
        lutSource.create('*srgb', cmykProfile, eIntent.perceptual);

        const builder = LutBuilder.fromTransform(lutSource);

        // Apply TAC clamp
        builder.editLut((cmyk) => {
            const total = cmyk[0] + cmyk[1] + cmyk[2] + cmyk[3];
            if (total > TAC_LIMIT) {
                const scale = TAC_LIMIT / total;
                return [cmyk[0] * scale, cmyk[1] * scale, cmyk[2] * scale, cmyk[3] * scale];
            }
            return cmyk;
        });
        builder.addAdjustment('TAC limit 300%');

        const baseSource = new Transform({ dataFormat: 'int8', buildLut: true });
        baseSource.create('*srgb', cmykProfile, eIntent.perceptual);
        baseTransform = LutBuilder.fromTransform(baseSource).toTransform({ dataFormat: 'int8' });

        tacTransform = builder.toTransform({ dataFormat: 'int8' });
    });

    const testPixels = new Uint8ClampedArray([
        0, 0, 0,         // black — likely highest TAC
        20, 20, 20,      // near-black
        0, 0, 128,       // dark blue
        255, 255, 255,   // white — zero TAC
    ]);

    test('TAC-limited transform output stays within 300% limit', () => {
        const out = tacTransform.transformArray(testPixels);
        // out is Uint8ClampedArray CMYK [0-255], TAC limit 300% = 765 total
        const pixelCount = out.length / 4;
        for (let p = 0; p < pixelCount; p++) {
            const total = out[p*4] + out[p*4+1] + out[p*4+2] + out[p*4+3];
            // Allow +2 u8 tolerance for interpolation rounding at the LUT grid level
            expect(total).toBeLessThanOrEqual(765 + 2);
        }
    });

    test('base (unclamped) transform exceeds 300% on dark pixels', () => {
        const out = baseTransform.transformArray(testPixels);
        // Black and near-black typically have high TAC in CMYK; at least one pixel
        // should exceed 300% to prove the TAC edit actually does something
        let anyExceedsLimit = false;
        const pixelCount = out.length / 4;
        for (let p = 0; p < pixelCount; p++) {
            const total = out[p*4] + out[p*4+1] + out[p*4+2] + out[p*4+3];
            if (total > 765) anyExceedsLimit = true;
        }
        expect(anyExceedsLimit).toBe(true);
    });
});

// ─── W3: Clone-and-diverge (two independent variants) ────────────────────────
//
// fromTransform() → clone() → different editLut() on each variant.
// Verifies that (a) the variants produce different output, and (b) neither
// variant affects the other's data (true deep copy).

describe('W3 — clone-and-diverge produces independent LUT variants', () => {
    let warmTransform;
    let coolTransform;

    beforeAll(() => {
        const lutSource = new Transform({ dataFormat: 'int8', buildLut: true, detectIdentity: false });
        lutSource.create('*srgb', '*srgb', eIntent.perceptual);

        const base = LutBuilder.fromTransform(lutSource);

        const warm = base.clone()
            .editLut(([r, g, b]) => [Math.min(1, r * 1.15), g * 0.95, b * 0.80])
            .addAdjustment('Warm: R+15% G-5% B-20%');

        const cool = base.clone()
            .editLut(([r, g, b]) => [r * 0.85, g * 0.95, Math.min(1, b * 1.15)])
            .addAdjustment('Cool: R-15% G-5% B+15%');

        warmTransform = warm.toTransform({ dataFormat: 'int8' });
        coolTransform = cool.toTransform({ dataFormat: 'int8' });
    });

    const midGrey = new Uint8ClampedArray([128, 128, 128]);

    test('warm variant boosts red relative to cool', () => {
        const warmOut = warmTransform.transformArray(midGrey);
        const coolOut = coolTransform.transformArray(midGrey);
        // Warm should have more red, cool should have more blue
        expect(warmOut[0]).toBeGreaterThan(coolOut[0]);
        expect(warmOut[2]).toBeLessThan(coolOut[2]);
    });

    test('variants produce different output (not the same transform)', () => {
        const warmOut = warmTransform.transformArray(midGrey);
        const coolOut = coolTransform.transformArray(midGrey);
        // At least one channel should differ significantly
        const maxDiff = Math.max(
            Math.abs(warmOut[0] - coolOut[0]),
            Math.abs(warmOut[1] - coolOut[1]),
            Math.abs(warmOut[2] - coolOut[2])
        );
        expect(maxDiff).toBeGreaterThan(10);
    });
});

// ─── W4: Custom creative callback produces measurable effect ─────────────────
//
// create() with a saturation-boost callback. Verify the effect actually changes
// output relative to an identity transform — confirming the callback math
// flows through the full LUT → engine pipeline.

describe('W4 — custom creative callback (saturation boost) via create()', () => {
    // Simple saturation boost in RGB space: pull each channel toward/away from grey
    function boostSaturation(r, g, b, factor) {
        const grey = (r + g + b) / 3;
        return [
            Math.min(1, Math.max(0, grey + (r - grey) * factor)),
            Math.min(1, Math.max(0, grey + (g - grey) * factor)),
            Math.min(1, Math.max(0, grey + (b - grey) * factor)),
        ];
    }

    let identityTransform;
    let saturatedTransform;

    beforeAll(() => {
        const chain = [virtualRGB('sRGB in'), eIntent.perceptual, virtualRGB('sRGB out')];

        identityTransform = new LutBuilder()
            .createIdentity(3, 33)
            .setChain(chain)
            .toTransform({ dataFormat: 'int8' });

        saturatedTransform = new LutBuilder()
            .create({ inChannels: 3, outChannels: 3, size: 33 },
                ([r, g, b]) => boostSaturation(r, g, b, 1.5))
            .setChain(chain)
            .toTransform({ dataFormat: 'int8' });
    });

    test('red pixel is boosted (more red, less green/blue) vs identity', () => {
        const pixel = new Uint8ClampedArray([200, 80, 80]);
        const identOut = identityTransform.transformArray(pixel);
        const saturOut = saturatedTransform.transformArray(pixel);

        // Red channel should increase, green/blue should decrease
        expect(saturOut[0]).toBeGreaterThan(identOut[0]);
        expect(saturOut[1]).toBeLessThan(identOut[1]);
    });

    test('grey pixel is unchanged by saturation boost', () => {
        const pixel = new Uint8ClampedArray([128, 128, 128]);
        const identOut = identityTransform.transformArray(pixel);
        const saturOut = saturatedTransform.transformArray(pixel);

        // Grey (equal RGB) is unaffected by chroma scaling — all channels equal
        for (let ch = 0; ch < 3; ch++) {
            expect(Math.abs(saturOut[ch] - identOut[ch])).toBeLessThanOrEqual(2);
        }
    });

    test('colourful pixel shows measurable saturation increase', () => {
        const pixel = new Uint8ClampedArray([180, 100, 40]);
        const identOut = identityTransform.transformArray(pixel);
        const saturOut = saturatedTransform.transformArray(pixel);

        // The difference between channels should increase
        const identSpread = Math.max(...identOut) - Math.min(...identOut);
        const saturSpread = Math.max(...saturOut) - Math.min(...saturOut);
        expect(saturSpread).toBeGreaterThan(identSpread);
    });
});

// ─── toJSON / fromJSON ───────────────────────────────────────────────────────

describe('toJSON / fromJSON', () => {
    test('toJSON produces u16 base64 by default with required fields', () => {
        const json = new LutBuilder()
            .createIdentity(3, 17)
            .toJSON();

        expect(json.dataType).toBe('u16');
        expect(json.precision).toBe(16);
        expect(json.encoding).toBe('base64');
        expect(typeof json.CLUT).toBe('string');
        expect(json.CLUT.length).toBeGreaterThan(0);
        expect(json.inputChannels).toBe(3);
        expect(json.outputChannels).toBe(3);
        expect(json.gridPoints).toEqual([17, 17, 17]);
        expect(Array.isArray(json.chain)).toBe(true);
        expect(json.created).toBeTruthy();
        expect(json.generator).toMatch(/LutBuilder/);
    });

    test('toJSON({ dataType: "u8" }) produces ~half the CLUT size', () => {
        const builder = new LutBuilder().createIdentity(3, 17);
        const u16 = builder.toJSON({ dataType: 'u16' });
        const u8  = builder.toJSON({ dataType: 'u8'  });

        expect(u8.dataType).toBe('u8');
        expect(u8.precision).toBe(8);
        // u8 base64 is roughly half the size of u16 base64
        expect(u8.CLUT.length).toBeLessThan(u16.CLUT.length * 0.6);
    });

    test('toJSON throws on bad dataType', () => {
        const builder = new LutBuilder().createIdentity(3, 5);
        expect(() => builder.toJSON({ dataType: 'f32' })).toThrow();
    });

    test('round-trip via LutBuilder: identity LUT survives toJSON → fromJSON', () => {
        const before = new LutBuilder().createIdentity(3, 17);
        const json   = before.toJSON();
        const after  = LutBuilder.fromJSON(json);

        expect(after._u16.length).toBe(before._u16.length);
        for (let i = 0; i < before._u16.length; i++) {
            expect(after._u16[i]).toBe(before._u16[i]);
        }
    });

    test('round-trip with JSON string (not just object) works', () => {
        const before  = new LutBuilder().createIdentity(3, 9);
        const jsonStr = JSON.stringify(before.toJSON());
        const after   = LutBuilder.fromJSON(jsonStr);
        expect(after._u16).toEqual(before._u16);
    });

    test('round-trip preserves meta and chain', () => {
        const before = new LutBuilder()
            .createIdentity(3, 5)
            .setChain([virtualRGB('input'), eIntent.perceptual, virtualRGB('output')])
            .addMeta({ author: 'Test', tags: ['demo'] })
            .addCopyright('CC-BY-4.0');

        const after = LutBuilder.fromJSON(before.toJSON());

        expect(after._meta.author).toBe('Test');
        expect(after._meta.copyright).toBe('CC-BY-4.0');
        expect(after._meta.tags).toEqual(['demo']);
        // Chain descriptors round-trip (objects are deep-equal, not same ref)
        expect(after._chain).toHaveLength(3);
        expect(after._chain[0].name).toBe('input');
        expect(after._chain[2].name).toBe('output');
        expect(after._chain[1]).toBe(eIntent.perceptual);
    });

    test('u8 round-trip: data is preserved within u8 precision (lossy)', () => {
        const before = new LutBuilder().createIdentity(3, 17);
        const after  = LutBuilder.fromJSON(before.toJSON({ dataType: 'u8' }));

        // u8 → u16 expansion: max delta is 256 LSBs in u16 (one u8 step)
        for (let i = 0; i < before._u16.length; i++) {
            const diff = Math.abs(after._u16[i] - before._u16[i]);
            expect(diff).toBeLessThanOrEqual(257);  // bit-stretch tolerance
        }
    });

    test('CMYK 4D round-trip preserves grid through real ICC pipeline', () => {
        // Build a real CMYK LUT, serialise, deserialise, compare pixel output
        const src = new Transform({ dataFormat: 'int8', buildLut: true });
        src.create('*srgb', cmykProfile, eIntent.perceptual);

        const before = LutBuilder.fromTransform(src);
        const json   = before.toJSON();
        const after  = LutBuilder.fromJSON(json);

        const t1 = before.toTransform({ dataFormat: 'int8' });
        const t2 = after.toTransform({ dataFormat: 'int8' });

        const pixels = new Uint8ClampedArray([255, 0, 0,  0, 255, 0,  0, 0, 255,  128, 128, 128]);
        const out1   = t1.transformArray(pixels);
        const out2   = t2.transformArray(pixels);

        for (let i = 0; i < out1.length; i++) {
            expect(out1[i]).toBe(out2[i]);   // bit-exact through u16 round-trip
        }
    });

    test('JSON-direct → setLut(): no LutBuilder needed at consumer', () => {
        // Producer side: build with LutBuilder, serialise to JSON
        const json = new LutBuilder()
            .createIdentity(3, 17)
            .setChain([virtualRGB('in'), eIntent.perceptual, virtualRGB('out')])
            .toJSON();

        // Consumer side: parse JSON, hand directly to setLut() — no LutBuilder
        const transform = new Transform({ dataFormat: 'int8' });
        transform.setLut(JSON.parse(JSON.stringify(json)));   // simulate file round-trip

        const input  = new Uint8ClampedArray([0, 0, 0,  128, 128, 128,  255, 255, 255]);
        const output = transform.transformArray(input);

        expect(output).toBeInstanceOf(Uint8ClampedArray);
        for (let i = 0; i < input.length; i++) {
            expect(Math.abs(output[i] - input[i])).toBeLessThanOrEqual(1);
        }
    });

    test('JSON-direct → setLut() with int16 dataFormat works correctly', () => {
        const json = new LutBuilder()
            .createIdentity(3, 17)
            .setChain([virtualRGB('in'), eIntent.perceptual, virtualRGB('out')])
            .toJSON();

        const transform = new Transform({ dataFormat: 'int16' });
        transform.setLut(JSON.parse(JSON.stringify(json)));

        const input  = new Uint16Array([0, 0, 0,  32768, 32768, 32768,  65535, 65535, 65535]);
        const output = transform.transformArray(input);

        expect(output).toBeInstanceOf(Uint16Array);
        for (let i = 0; i < input.length; i++) {
            expect(Math.abs(output[i] - input[i])).toBeLessThanOrEqual(1);
        }
    });

    test('fromJSON throws on missing CLUT', () => {
        expect(() => LutBuilder.fromJSON({ chain: [], inputChannels: 3 })).toThrow();
    });
});

// ─── Transform.toJSON / fromJSON / lutToJSON / jsonToLut ─────────────────────

describe('Transform.toJSON / fromJSON', () => {
    test('Transform.toJSON produces same shape as LutBuilder.toJSON', () => {
        // Build the same LUT via both paths and verify identical JSON output
        const builder = new LutBuilder().createIdentity(3, 17);
        const builderJson = builder.toJSON();

        const t = builder.toTransform({ dataFormat: 'int8' });
        const transformJson = t.toJSON();

        // Same structural shape and same field names
        expect(Object.keys(transformJson).sort()).toEqual(Object.keys(builderJson).sort());
        // Same dataType, precision, encoding
        expect(transformJson.dataType).toBe(builderJson.dataType);
        expect(transformJson.precision).toBe(builderJson.precision);
        expect(transformJson.encoding).toBe(builderJson.encoding);
        // Same grid shape
        expect(transformJson.gridPoints).toEqual(builderJson.gridPoints);
        expect(transformJson.inputChannels).toBe(builderJson.inputChannels);
        expect(transformJson.outputChannels).toBe(builderJson.outputChannels);
        // CLUT bytes are identical (single source of truth for the encoding)
        expect(transformJson.CLUT).toBe(builderJson.CLUT);
    });

    test('JSON.stringify(transform) auto-calls toJSON via JS protocol', async () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create('*srgb', cmykProfile, eIntent.perceptual);

        const str = JSON.stringify(t);             // JS calls t.toJSON() automatically
        const parsed = JSON.parse(str);

        expect(parsed.dataType).toBe('u16');
        expect(parsed.encoding).toBe('base64');
        expect(parsed.inputChannels).toBe(3);
        expect(parsed.outputChannels).toBe(4);
    });

    test('Transform.fromJSON: end-to-end, no profiles needed at consumer', () => {
        // Producer side: build with profiles
        const producer = new Transform({ dataFormat: 'int8', buildLut: true });
        producer.create('*srgb', cmykProfile, eIntent.perceptual);

        const json = JSON.stringify(producer);

        // Consumer side: rebuild without touching ICC profiles
        const consumer = Transform.fromJSON(json, { dataFormat: 'int8' });

        const pixels = new Uint8ClampedArray([255, 0, 0,  0, 255, 0,  0, 0, 255,  128, 128, 128]);
        const a = producer.transformArray(pixels);
        const b = consumer.transformArray(pixels);

        // Bit-exact through u16 wire format
        expect([...a]).toEqual([...b]);
    });

    test('Transform.toJSON throws when no LUT', () => {
        const t = new Transform({ dataFormat: 'int8' });
        t.create('*srgb', '*srgb', eIntent.relative);
        expect(() => t.toJSON()).toThrow();
    });

    test('Transform.lutToJSON / jsonToLut roundtrip preserves data', () => {
        // Static helpers — no LutBuilder, no Transform instance
        const lut = new LutBuilder().createIdentity(3, 9).toLut();
        const json = Transform.lutToJSON(lut);
        const decoded = Transform.jsonToLut(json);

        expect(decoded.CLUT).toBeInstanceOf(Float64Array);
        expect(decoded.CLUT.length).toBe(lut.CLUT.length);
        // Within u16 quantisation tolerance (1/65535)
        for (let i = 0; i < lut.CLUT.length; i++) {
            expect(Math.abs(decoded.CLUT[i] - lut.CLUT[i])).toBeLessThan(1 / 65000);
        }
    });

    test('Transform.fromJSON accepts both string and object input', () => {
        const t1 = new Transform({ dataFormat: 'int8', buildLut: true });
        t1.create('*srgb', cmykProfile, eIntent.perceptual);
        const json = t1.toJSON();

        const tFromObj = Transform.fromJSON(json, { dataFormat: 'int8' });
        const tFromStr = Transform.fromJSON(JSON.stringify(json), { dataFormat: 'int8' });

        const pixels = new Uint8ClampedArray([200, 100, 50]);
        expect([...tFromObj.transformArray(pixels)]).toEqual([...tFromStr.transformArray(pixels)]);
    });
});

// ─── W5: Producer/Consumer JSON portability workflow ─────────────────────────
//
// The full real-world flow: build a LUT-backed Transform with profiles,
// serialise to JSON, "ship" it (simulated via JSON.stringify+parse), then
// rebuild on a consumer that has no ICC profiles. Output must be bit-exact.
//
// Two scenarios — RGB → CMYK (separation) and sRGB → AdobeRGB (RGB↔RGB).

describe('W5 — JSON portability: producer with profiles, consumer without', () => {
    let adobeProfile;
    beforeAll(async () => {
        adobeProfile = new Profile();
        await adobeProfile.loadPromise('file:' + path.join(__dirname, 'AdobeRGB1998.icc'));
    });

    test('RGB → CMYK: build, save, destroy, restore, identical output', () => {
        // Producer side: has ICC profiles, builds LUT once
        const producer = new Transform({ dataFormat: 'int8', buildLut: true });
        producer.create('*srgb', cmykProfile, eIntent.perceptual);

        // Diverse test pixels — primaries, neutrals, mid-tones, near-gamut
        const pixels = new Uint8ClampedArray([
            255,   0,   0,    0, 255,   0,    0,   0, 255,
            255, 255,   0,    0, 255, 255,  255,   0, 255,
              0,   0,   0,  255, 255, 255,  128, 128, 128,
             80,  20, 200,  200,  80,  20,   20, 180,  90,
        ]);
        const producerOutput = producer.transformArray(pixels);

        // Serialise via JSON.stringify (auto-calls toJSON), simulate a file/wire round-trip
        const wireJson = JSON.stringify(producer);

        // Destroy the producer (simulate process boundary)
        producer.lut = null;

        // Consumer side: parse JSON, rebuild Transform — no profiles loaded
        const consumer = Transform.fromJSON(wireJson, { dataFormat: 'int8' });
        const consumerOutput = consumer.transformArray(pixels);

        // Bit-exact: same kernel, same CLUT bytes (u16 lossless round-trip),
        // same input → same output
        expect(consumerOutput).toBeInstanceOf(Uint8ClampedArray);
        expect(consumerOutput.length).toBe(producerOutput.length);
        expect([...consumerOutput]).toEqual([...producerOutput]);
    });

    test('sRGB → AdobeRGB: RGB↔RGB workflow with int8 round-trip', () => {
        const producer = new Transform({ dataFormat: 'int8', buildLut: true });
        producer.create('*srgb', adobeProfile, eIntent.relative);

        const pixels = new Uint8ClampedArray([
            128, 128, 128,    255,   0,   0,    50, 150, 200,
              0,   0,   0,    255, 255, 255,    180,  90,  30,
        ]);
        const producerOutput = producer.transformArray(pixels);

        const wireJson = JSON.stringify(producer);
        producer.lut = null;

        const consumer = Transform.fromJSON(wireJson, { dataFormat: 'int8' });
        const consumerOutput = consumer.transformArray(pixels);

        expect([...consumerOutput]).toEqual([...producerOutput]);
    });

    test('CMYK in/out via LutBuilder edit: save → restore preserves the edit', () => {
        // Build a sRGB→CMYK LUT, apply a TAC clamp via LutBuilder, save+restore,
        // verify the edit survives the JSON round-trip.
        const src = new Transform({ dataFormat: 'int8', buildLut: true });
        src.create('*srgb', cmykProfile, eIntent.perceptual);

        const builder = LutBuilder.fromTransform(src).editLut((cmyk) => {
            const total = cmyk[0] + cmyk[1] + cmyk[2] + cmyk[3];
            if (total > 3.0) {
                const s = 3.0 / total;
                return [cmyk[0]*s, cmyk[1]*s, cmyk[2]*s, cmyk[3]*s];
            }
            return cmyk;
        }).addAdjustment('TAC limit 300%');

        const json = builder.toJSON();
        const restored = Transform.fromJSON(json, { dataFormat: 'int8' });

        // Both transforms should produce identical output for any pixel
        const before = builder.toTransform({ dataFormat: 'int8' });
        const pixels = new Uint8ClampedArray([
            0, 0, 0,   20, 20, 20,   0, 0, 128,   80, 30, 10,
        ]);
        expect([...restored.transformArray(pixels)]).toEqual([...before.transformArray(pixels)]);
    });

    test('Transform.toJSON throws helpfully on no-LUT transform (no auto-build)', () => {
        // Explicit policy: no auto-build on serialise. The f64 path is lossless;
        // the LUT path has grid error. Silent swap = hidden posterisation = bug.
        const t = new Transform({ dataFormat: 'int8' });   // no buildLut
        t.create('*srgb', '*srgb', eIntent.relative);

        // Verify the no-LUT transform actually works for normal use
        expect(() => t.transformArray(new Uint8ClampedArray([128, 64, 200]))).not.toThrow();

        // But toJSON should refuse with a helpful message
        let err;
        try { t.toJSON(); } catch (e) { err = e; }
        expect(err).toBeTruthy();
        expect(String(err)).toMatch(/buildLut/);
        expect(String(err)).toMatch(/setLut|grid|hidden/i);
    });

    test('4D CMYK→RGB: live (no LUT) and LUT-built produce matching pixels', async () => {
        // Regression for create4DDeviceLUT pipeline-chaining bug — previously
        // each stage was fed the original `src` instead of the previous stage's
        // output. CMYK 0,0,0,0 (white paper) used to render as black, max-ink
        // CMYK as white. Fixed by replacing inline loop with this.forward(src).
        const tLive = new Transform({ dataFormat: 'int8', BPC: true });
        tLive.create(cmykProfile, '*srgb', eIntent.relative);

        const tBuilt = new Transform({ dataFormat: 'int8', buildLut: true, BPC: true, lutGridPoints4D: 17 });
        tBuilt.create(cmykProfile, '*srgb', eIntent.relative);

        // White paper CMYK (0,0,0,0) → near-white sRGB
        const whiteIn = new Uint8ClampedArray([0, 0, 0, 0]);
        const whiteLive = tLive.transformArray(whiteIn);
        const whiteBuilt = tBuilt.transformArray(whiteIn);
        expect(whiteLive[0]).toBeGreaterThan(240);   // white-ish
        expect(whiteLive[1]).toBeGreaterThan(240);
        expect(whiteLive[2]).toBeGreaterThan(240);
        expect(Math.abs(whiteBuilt[0] - whiteLive[0])).toBeLessThanOrEqual(2);
        expect(Math.abs(whiteBuilt[1] - whiteLive[1])).toBeLessThanOrEqual(2);
        expect(Math.abs(whiteBuilt[2] - whiteLive[2])).toBeLessThanOrEqual(2);

        // Mixed test pixels — built should match live within ~3 ΔP (LUT grid noise)
        const pixels = new Uint8ClampedArray([
            50, 100, 150, 50,    200, 80, 40, 100,
            128, 128, 128, 0,    0, 0, 0, 100,
            0, 0, 0, 0,          255, 255, 255, 255,
        ]);
        const live  = tLive.transformArray(pixels);
        const built = tBuilt.transformArray(pixels);
        let max = 0;
        for (let i = 0; i < live.length; i++) max = Math.max(max, Math.abs(live[i] - built[i]));
        expect(max).toBeLessThanOrEqual(3);   // 17-pt grid interpolation noise

        // JSON round-trip preserves the same agreement
        const tFromJson = Transform.fromJSON(tBuilt.toJSON(), { dataFormat: 'int8' });
        const fromJsonOut = tFromJson.transformArray(pixels);
        for (let i = 0; i < built.length; i++) {
            expect(fromJsonOut[i]).toBe(built[i]);   // bit-exact through JSON
        }
    });

    test('Signature audit trail — full flow', () => {
        // Producer: build with profiles → originalSignature stamped automatically
        const producer = new Transform({ dataFormat: 'int8', buildLut: true });
        producer.create('*srgb', cmykProfile, eIntent.perceptual);

        const builder = LutBuilder.fromTransform(producer);
        const sig = builder.originalSignature;

        expect(sig).toMatch(/^FNV1A:[0-9a-f]{8}$/);
        expect(builder.verify()).toBe(true);

        // editLut adds a timestamped adjustment but does NOT clear the signature
        const t0 = Date.now();
        builder.editLut((cmyk) => cmyk);   // no-op edit
        const adjustments = builder._meta.adjustments;
        expect(adjustments).toBeTruthy();
        expect(adjustments[adjustments.length - 1]).toMatch(/editLut\(\) at \d{4}-\d{2}-\d{2}T/);
        expect(builder.originalSignature).toBe(sig);   // signature NOT cleared

        // No-op edit produces same u16, so verify() should still be true
        expect(builder.verify()).toBe(true);

        // Real edit changes the data — verify() now false
        builder.editLut(([c,m,y,k]) => [Math.min(1, c + 0.1), m, y, k]);
        expect(builder.verify()).toBe(false);
        expect(builder.originalSignature).toBe(sig);   // still the original marker
        expect(builder._meta.adjustments.length).toBe(2);   // two timestamped entries
    });

    test('Signature persists through toJSON / fromJSON round-trip', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create('*srgb', cmykProfile, eIntent.perceptual);

        const before = LutBuilder.fromTransform(t);
        const sig    = before.originalSignature;

        const json   = before.toJSON();
        expect(json.originalSignature).toBe(sig);

        const after = LutBuilder.fromJSON(json);
        expect(after.originalSignature).toBe(sig);
        expect(after.verify()).toBe(true);
    });

    test('clone() carries the signature, edits diverge correctly', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create('*srgb', cmykProfile, eIntent.perceptual);

        const base = LutBuilder.fromTransform(t);
        const sig  = base.originalSignature;

        const a = base.clone();
        const b = base.clone();

        expect(a.originalSignature).toBe(sig);
        expect(b.originalSignature).toBe(sig);

        // Mutate b — its data changes but originalSignature is still the marker
        b.editLut((cmyk) => [cmyk[0] * 0.9, cmyk[1], cmyk[2], cmyk[3]]);

        expect(a.verify()).toBe(true);   // unchanged
        expect(b.verify()).toBe(false);  // edited
        expect(b.originalSignature).toBe(sig);   // marker preserved
    });

    test('create() / createIdentity() do NOT stamp a signature', () => {
        const a = new LutBuilder().create({ inChannels: 3, outChannels: 3, size: 5 }, (rgb) => rgb);
        const b = new LutBuilder().createIdentity(3, 5);
        expect(a.originalSignature).toBeNull();
        expect(b.originalSignature).toBeNull();
        expect(a.verify()).toBeNull();   // null = "nothing to verify"
    });

    test('Transform.setLut({ verify: true }) throws on signature mismatch', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create('*srgb', cmykProfile, eIntent.perceptual);

        const json = JSON.parse(JSON.stringify(t));   // serialise to plain object
        expect(json.originalSignature).toMatch(/^FNV1A:/);

        // Tamper with the encoded CLUT (corrupt one byte by replacing with 'A')
        const tampered = Object.assign({}, json, {
            CLUT: 'AAAA' + json.CLUT.slice(4),
        });

        // Default: setLut accepts whatever it's handed, no verify
        const t1 = new Transform({ dataFormat: 'int8' });
        expect(() => t1.setLut(tampered)).not.toThrow();

        // With verify: true — throws helpfully
        const t2 = new Transform({ dataFormat: 'int8' });
        expect(() => t2.setLut(Object.assign({}, tampered), { verify: true })).toThrow(/signature mismatch/);
    });

    test('Transform.fromJSON forwards { verify: true } to setLut', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create('*srgb', cmykProfile, eIntent.perceptual);
        const json = JSON.parse(JSON.stringify(t));

        // Untampered — verify passes
        expect(() => Transform.fromJSON(json, { dataFormat: 'int8', verify: true })).not.toThrow();

        // Tampered — verify throws
        const tampered = Object.assign({}, json, { CLUT: 'AAAA' + json.CLUT.slice(4) });
        expect(() => Transform.fromJSON(tampered, { dataFormat: 'int8', verify: true })).toThrow(/signature/);
    });

    test('Transform.verifyLut + transform.verifyLut() instance method', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create('*srgb', cmykProfile, eIntent.perceptual);

        // No eager stamp — engine doesn't sign during create() for speed.
        // verifyLut() returns null (nothing to verify against)
        expect(t.verifyLut()).toBeNull();

        // signLut() computes the current data signature on demand
        const sig = t.signLut();
        expect(sig).toMatch(/^FNV1A:[0-9a-f]{8}$/);

        // After a JSON round-trip, the signature lives in the JSON →
        // verifyLut() now matches because the loaded transform has
        // originalSignature set on its lut.
        const restored = Transform.fromJSON(t.toJSON(), { dataFormat: 'int8' });
        expect(restored.verifyLut()).toBe(true);
        expect(Transform.verifyLut(restored.lut)).toBe(true);

        // No signature → returns null (nothing to verify)
        const noSig = new LutBuilder().createIdentity(3, 5).toLut();
        expect(Transform.verifyLut(noSig)).toBeNull();
    });

    test('JSON file size budget: 33-pt 3D RGB→CMYK fits in <500 KB', () => {
        // Practical sanity check — the JSON payload is web-shippable.
        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create('*srgb', cmykProfile, eIntent.perceptual);

        const wireSize    = JSON.stringify(t).length;
        const u8WireSize  = JSON.stringify(t.toJSON({ dataType: 'u8' })).length;

        expect(wireSize).toBeLessThan(500 * 1024);   // u16 fits in 500 KB
        expect(u8WireSize).toBeLessThan(wireSize / 1.7);   // u8 is meaningfully smaller

        // Non-CLUT overhead is small
        const json = t.toJSON();
        const nonClut = wireSize - json.CLUT.length - 'CLUT":""'.length;
        expect(nonClut).toBeLessThan(5 * 1024);   // metadata + chain < 5 KB
    });
});
