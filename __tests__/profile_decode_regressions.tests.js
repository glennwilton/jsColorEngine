/**
 * Profile shapes the shipped fixtures do not reach. Every one of these passed
 * validation silently, or crashed, until a sweep against Little CMS over the
 * full testbed found them: the two profiles this repo ships are both mft2 v2
 * with all three intents present, so they cannot exercise any of this.
 *
 * Fixtures are written here with src/encodeICC.js so nothing depends on the
 * gitignored testbed.
 */

const fs = require('fs');
const path = require('path');
const { Transform, eIntent, convert } = require('../src/main');
const Profile = require('../src/Profile');
const decode = require('../src/decodeICC');
const enc = require('../src/encodeICC');

const GRACOL = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');
const ADOBE = path.join(__dirname, 'AdobeRGB1998.icc');
const NCHANNEL = path.join(__dirname, 'profiles', 'synthetic_06ch.icc');

const SRGB_D50 = {
    r: {X: 0.4360747, Y: 0.2225045, Z: 0.0139322},
    g: {X: 0.3850649, Y: 0.7168786, Z: 0.0971045},
    b: {X: 0.1430804, Y: 0.0606169, Z: 0.7141733},
};
const SRGB_PARAMS = [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045];

function fromBytes(bytes) {
    const profile = new Profile();
    profile.loadBinary(new Uint8Array(bytes), () => {});
    return profile;
}

function readBytes(file) {
    return new Uint8Array(fs.readFileSync(file));
}

function paraTag(functionType, params) {
    const out = [];
    enc.chars(out, 'para', 4);
    enc.zeros(out, 4);
    enc.u16(out, functionType);
    enc.u16(out, 0);
    params.forEach((value) => enc.s15Fixed16(out, value));
    return out;
}

function curvGamma(gamma) {
    const out = [];
    enc.chars(out, 'curv', 4);
    enc.zeros(out, 4);
    enc.u32(out, 1);
    enc.u8Fixed8(out, gamma);
    return out;
}

function curvTable(samples) {
    const out = [];
    enc.chars(out, 'curv', 4);
    enc.zeros(out, 4);
    enc.u32(out, samples.length);
    samples.forEach((value) => enc.u16(out, value));
    enc.pad4(out);
    return out;
}

function gammaSamples(gamma) {
    return Array.from({length: 1024}, (_, index) => Math.round(Math.pow(index / 1023, gamma) * 65535));
}

function asV4(bytes) {
    bytes[8] = 4;
    bytes[9] = 0x20;
    return bytes;
}

function matrixProfile(redCurve, greenCurve, blueCurve, withWhitePoint) {
    const tags = [
        ['bTRC', blueCurve], ['bXYZ', enc.XYZType(SRGB_D50.b)],
        ['cprt', enc.textType('test')], ['desc', enc.textDescriptionType('test')],
        ['gTRC', greenCurve], ['gXYZ', enc.XYZType(SRGB_D50.g)],
        ['rTRC', redCurve], ['rXYZ', enc.XYZType(SRGB_D50.r)],
    ];
    if(withWhitePoint !== false){
        tags.push(['wtpt', enc.XYZType(enc.D50)]);
    }
    return enc.assemble({colorSpace: 'RGB ', profileClass: 'mntr', pcs: 'XYZ ', intent: 0}, tags);
}

function identityGammaCurves(){
    const curves = [];
    for(let channel = 0; channel < 3; channel++){
        curves.push(...paraTag(0, [1.0]));
    }
    return curves;
}

/** lutAToB / lutBToA with passThrough curves around an optional u16 CLUT. */
function v4LutTag(signature, gridPerAxis, cells) {
    const out = [];
    enc.chars(out, signature, 4);
    enc.zeros(out, 4);
    enc.u8(out, 3);
    enc.u8(out, 3);
    enc.u16(out, 0);

    const curves = identityGammaCurves();
    const bOffset = 32;
    if(!cells){
        enc.u32(out, bOffset); enc.u32(out, 0); enc.u32(out, 0); enc.u32(out, 0); enc.u32(out, 0);
        out.push(...curves);
        return out;
    }
    const aOffset = bOffset + curves.length;
    const clutOffset = aOffset + curves.length;
    enc.u32(out, bOffset); enc.u32(out, 0); enc.u32(out, 0); enc.u32(out, clutOffset); enc.u32(out, aOffset);
    out.push(...curves, ...curves);
    for(let axis = 0; axis < 16; axis++){
        out.push(axis < 3 ? gridPerAxis : 0);
    }
    enc.u8(out, 2);
    enc.zeros(out, 3);
    cells.forEach((value) => enc.u16(out, value));
    enc.pad4(out);
    return out;
}

/** RGB <-> Lab v4 LUT profile with curves the pipeline drops as passThrough. */
function v4LutProfile() {
    const grid = 5;
    const toLab = [];
    const toDevice = [];
    for(let r = 0; r < grid; r++){
        for(let g = 0; g < grid; g++){
            for(let b = 0; b < grid; b++){
                toLab.push(Math.round((r + g + b) / (3 * (grid - 1)) * 65535), 32896, 32896);
                const level = Math.round(r / (grid - 1) * 65535);
                toDevice.push(level, level, level);
            }
        }
    }
    const a2b = v4LutTag('mAB ', grid, toLab);
    const b2a = v4LutTag('mBA ', grid, toDevice);
    return asV4(enc.assemble({colorSpace: 'RGB ', profileClass: 'prtr', pcs: 'Lab ', intent: 0}, [
        ['A2B0', a2b], ['A2B1', a2b], ['B2A0', b2a], ['B2A1', b2a],
        ['cprt', enc.textType('test')], ['desc', enc.textDescriptionType('v4 lut')],
        ['wtpt', enc.XYZType(enc.D50)],
    ]));
}

function mft1Tag(inputChannels, outputChannels, grid, cells) {
    const out = [];
    enc.chars(out, 'mft1', 4);
    enc.zeros(out, 4);
    enc.u8(out, inputChannels);
    enc.u8(out, outputChannels);
    enc.u8(out, grid);
    enc.u8(out, 0);
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((value) => enc.s15Fixed16(out, value));
    for(let channel = 0; channel < inputChannels; channel++){
        for(let entry = 0; entry < 256; entry++){ out.push(entry); }
    }
    cells.forEach((value) => out.push(value));
    for(let channel = 0; channel < outputChannels; channel++){
        for(let entry = 0; entry < 256; entry++){ out.push(entry); }
    }
    return out;
}

function mft1Profile() {
    const grid = 5;
    const toLab = [];
    const toDevice = [];
    for(let r = 0; r < grid; r++){
        for(let g = 0; g < grid; g++){
            for(let b = 0; b < grid; b++){
                toLab.push(Math.round((r + g + b) / (3 * (grid - 1)) * 255), 128, 128);
                const level = Math.round(r / (grid - 1) * 255);
                toDevice.push(level, level, level);
            }
        }
    }
    const a2b = mft1Tag(3, 3, grid, toLab);
    const b2a = mft1Tag(3, 3, grid, toDevice);
    return enc.assemble({colorSpace: 'RGB ', profileClass: 'prtr', pcs: 'Lab ', intent: 0}, [
        ['A2B0', a2b], ['A2B1', a2b], ['A2B2', a2b], ['B2A0', b2a], ['B2A1', b2a], ['B2A2', b2a],
        ['cprt', enc.textType('test')], ['desc', enc.textDescriptionType('mft1')],
        ['wtpt', enc.XYZType(enc.D50)],
    ]);
}

function renameTags(bytes, renames) {
    const out = new Uint8Array(bytes);
    const tagCount = (out[128] << 24) | (out[129] << 16) | (out[130] << 8) | out[131];
    for(let tag = 0; tag < tagCount; tag++){
        const at = 132 + tag * 12;
        const signature = String.fromCharCode(out[at], out[at + 1], out[at + 2], out[at + 3]);
        if(renames[signature]){
            for(let c = 0; c < 4; c++){ out[at + c] = renames[signature].charCodeAt(c); }
        }
    }
    return out;
}

describe('curve decoding', () => {
    test('parametric type 2 is (aX+b)^g + c, forward and inverse', () => {
        const tag = new Uint8Array(paraTag(2, [2.2, 1, 0, 0.1]));
        const forward = decode.curve(tag, 0);
        const inverse = decode.curve(tag, 0, true);
        const expected = Math.pow(0.5, 2.2) + 0.1;
        expect(forward.curveFn(forward.params, 0.5)).toBeCloseTo(expected, 4);
        expect(inverse.curveFn(inverse.params, expected)).toBeCloseTo(0.5, 4);
    });

    test('a 2-point curve inverts to its own ramp', () => {
        const inverse = decode.curve(new Uint8Array(curvTable([0, 65535])), 0, true);
        expect(inverse.passThrough).toBe(true);
        expect(inverse.dataf[2048]).toBeCloseTo(2048 / 4095, 6);
        expect(Number.isNaN(inverse.gamma)).toBe(false);
    });

    test('inversion reaches the last segment of the curve', () => {
        const inverse = decode.curve(new Uint8Array(curvTable([0, 20000, 65535])), 0, true);
        const y = 0.8;
        const start = 20000 / 65535;
        expect(inverse.dataf[Math.round(y * 4095)])
            .toBeCloseTo(0.5 + 0.5 * ((y - start) / (1 - start)), 3);
    });
});

describe('LUT tags', () => {
    test('building a Transform leaves the Profile LUT alone', () => {
        const profile = fromBytes(v4LutProfile());
        const lab = new Profile('*Lab');
        const before = [profile.A2B[1].inputScale, profile.A2B[1].outputScale,
                        profile.B2A[1].inputScale, profile.B2A[1].outputScale];

        const run = () => {
            const transform = new Transform({dataFormat: 'int8', pixelCache: 0});
            transform.create(lab, profile, eIntent.relative);
            return Array.from(transform.transform(convert.Lab(50, 0, 0)));
        };
        const first = run();
        expect(run()).toEqual(first);

        const toLab = new Transform({dataFormat: 'int8', pixelCache: 0});
        toLab.create(profile, lab, eIntent.relative);

        expect([profile.A2B[1].inputScale, profile.A2B[1].outputScale,
                profile.B2A[1].inputScale, profile.B2A[1].outputScale]).toEqual(before);

        const afterwards = new Transform({dataFormat: 'object'});
        afterwards.create(lab, profile, eIntent.relative);
        expect(afterwards.transform(convert.Lab(50, 0, 0)).R).toBeLessThanOrEqual(255);
    });

    test.each([
        ['relative', eIntent.relative],
        ['absolute', eIntent.absolute],
        ['perceptual', eIntent.perceptual],
        ['saturation', eIntent.saturation],
    ])('tag 0 alone serves %s', (name, intent) => {
        const profile = fromBytes(renameTags(readBytes(GRACOL),
            {A2B1: 'xxx1', A2B2: 'xxx2', B2A1: 'yyy1', B2A2: 'yyy2'}));
        const lab = new Profile('*Lab');

        const forward = new Transform({dataFormat: 'object'});
        forward.create(profile, lab, intent);
        expect(Number.isFinite(forward.transform(convert.CMYK(0, 100, 0, 0)).L)).toBe(true);

        const backward = new Transform({dataFormat: 'object'});
        backward.create(lab, profile, intent);
        expect(Number.isFinite(backward.transform(convert.Lab(50, 20, 20)).C)).toBe(true);
    });

    test('mAB and mBA with no CLUT run their curves', () => {
        const a2b = v4LutTag('mAB ');
        const b2a = v4LutTag('mBA ');
        const profile = fromBytes(asV4(enc.assemble(
            {colorSpace: 'RGB ', profileClass: 'mntr', pcs: 'XYZ ', intent: 0}, [
                ['A2B0', a2b], ['A2B1', a2b], ['B2A0', b2a], ['B2A1', b2a],
                ['cprt', enc.textType('test')], ['desc', enc.textDescriptionType('no clut')],
                ['wtpt', enc.XYZType(enc.D50)],
            ])));
        const lab = new Profile('*Lab');

        const forward = new Transform({dataFormat: 'object'});
        forward.create(profile, lab, eIntent.relative);
        expect(Number.isFinite(forward.transform(convert.RGB(128, 128, 128)).L)).toBe(true);

        const backward = new Transform({dataFormat: 'object'});
        backward.create(lab, profile, eIntent.relative);
        expect(Number.isFinite(backward.transform(convert.Lab(50, 0, 0)).R)).toBe(true);
    });

    test('mft1 A2B uses the 8-bit Lab encoding, not the 16-bit v2 one', () => {
        const transform = new Transform({dataFormat: 'object'});
        transform.create(fromBytes(mft1Profile()), new Profile('*Lab'), eIntent.relative);
        const white = transform.transform(convert.RGB(255, 255, 255));
        expect(white.L).toBeCloseTo(100, 6);
        expect(white.a).toBeCloseTo(0, 6);
        expect(white.b).toBeCloseTo(0, 6);
    });

    test('a null stage at the head of the pipeline is folded, not thrown on', () => {
        const transform = new Transform({dataFormat: 'device'});
        transform.create(new Profile('*Lab'), fromBytes(mft1Profile()), eIntent.relative);
        expect(transform.transform([0.5, 0.5, 0.5]).length).toBe(3);
    });
});

describe('matrix profiles', () => {
    const parametric = () => paraTag(3, SRGB_PARAMS);

    test('parametric output TRCs clamp out of gamut colours', () => {
        const target = fromBytes(asV4(matrixProfile(parametric(), parametric(), parametric())));
        const transform = new Transform({dataFormat: 'object'});
        transform.create(new Profile('*ProPhotoRGB'), target, eIntent.relative);
        const green = transform.transform(convert.RGB(0, 255, 0));
        expect([green.R, green.G, green.B]).toEqual([0, 255, 0]);
    });

    test('a pure power parametric TRC does not go NaN on a negative channel', () => {
        const power = () => paraTag(1, [2.2, 1, 0]);
        const target = fromBytes(asV4(matrixProfile(power(), power(), power())));
        const transform = new Transform({dataFormat: 'object'});
        transform.create(new Profile('*ProPhotoRGB'), target, eIntent.relative);
        const green = transform.transform(convert.RGB(0, 255, 0));
        expect(Number.isNaN(green.R)).toBe(false);
        expect(Number.isNaN(green.B)).toBe(false);
    });

    test('int16 out of gamut no longer wraps', () => {
        const target = fromBytes(asV4(matrixProfile(parametric(), parametric(), parametric())));
        const transform = new Transform({dataFormat: 'int16'});
        transform.create(new Profile('*ProPhotoRGB'), target, eIntent.relative);
        const out = transform.array(new Uint16Array([0, 65535, 0]), false, false);
        expect(Array.from(out)).toEqual([0, 65535, 0]);
    });

    test('three different single-gamma TRCs stay three', () => {
        const toLab = (profile) => {
            const transform = new Transform({dataFormat: 'object'});
            transform.create(profile, new Profile('*Lab'), eIntent.relative);
            return transform.transform(convert.RGB(128, 128, 128));
        };
        const gamma = toLab(fromBytes(matrixProfile(curvGamma(1.8), curvGamma(2.2), curvGamma(2.6))));
        const sampled = toLab(fromBytes(matrixProfile(curvTable(gammaSamples(1.8)),
            curvTable(gammaSamples(2.2)), curvTable(gammaSamples(2.6)))));
        expect(gamma.L).toBeCloseTo(sampled.L, 1);
        expect(gamma.a).toBeCloseTo(sampled.a, 1);
        expect(gamma.b).toBeCloseTo(sampled.b, 1);
    });

    test('*AppleRGB is gamma 1.8', () => {
        expect(new Profile('*AppleRGB').RGBMatrix.gamma).toBe(1.8);
    });

    test.each([
        ['sampled', () => curvTable(gammaSamples(2.2))],
        ['parametric', parametric],
    ])('the matrix shaper claims %s TRCs within 1 LSB of the pipeline', (name, curve) => {
        const profile = fromBytes(asV4(matrixProfile(curve(), curve(), curve())));
        const pixels = new Uint8Array(3000);
        for(let i = 0; i < pixels.length; i++){ pixels[i] = (i * 2654435761) >>> 24; }

        const fast = new Transform({dataFormat: 'int8'});
        fast.create(profile, new Profile('*AdobeRGB'), eIntent.relative);
        const fastOut = fast.array(pixels, false, false);
        expect(fast.lastUsedKernel).toBe('matrix-shaper');

        const slow = new Transform({dataFormat: 'int8', wasmMatrixShaper: false, pixelCache: 0});
        slow.create(profile, new Profile('*AdobeRGB'), eIntent.relative);
        const slowOut = slow.array(pixels, false, false);
        for(let i = 0; i < fastOut.length; i++){
            expect(Math.abs(fastOut[i] - slowOut[i])).toBeLessThanOrEqual(1);
        }
    });
});

describe('gray kTRC with a Lab PCS', () => {
    const grayLab = () => {
        const bytes = Profile.createGrayICC({gamma: 1.0});
        bytes.set([76, 97, 98, 32], 20); // PCS 'Lab '
        return fromBytes(bytes);
    };

    test('neutral stays neutral', () => {
        const transform = new Transform({dataFormat: 'object', BPC: false});
        transform.create(grayLab(), new Profile('*Lab'), eIntent.relative);
        const result = transform.transform(convert.Gray(128));
        expect(result.a).toBeCloseTo(0, 6);
        expect(result.b).toBeCloseTo(0, 6);
    });

    test('BPC does not feed XYZ to the L curve', () => {
        const gracol = fromBytes(readBytes(GRACOL));
        const convertWith = (BPC) => {
            const transform = new Transform({dataFormat: 'object', BPC});
            transform.create(gracol, grayLab(), eIntent.relative);
            return transform.transform(convert.CMYK(0, 0, 0, 60)).G;
        };
        expect(Math.abs(convertWith(true) - convertWith(false))).toBeLessThan(30);
    });
});

describe('black point compensation', () => {
    test.each([
        ['into', (nChannel) => ['*sRGB', nChannel, [0.5, 0.5, 0.5]]],
        ['out of', (nChannel) => [nChannel, '*sRGB', [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]]],
    ])('runs %s an n-channel profile', (name, route) => {
        const [input, output, colour] = route(fromBytes(readBytes(NCHANNEL)));
        const transform = new Transform({dataFormat: 'device', BPC: true});
        transform.create(input, output, eIntent.relative);
        expect(transform.transform(colour).length).toBeGreaterThan(0);
    });

    test('a v4 source does not force BPC on a v2 destination', () => {
        const transform = new Transform({dataFormat: 'object'});
        transform.create(fromBytes(v4LutProfile()), fromBytes(readBytes(ADOBE)), eIntent.perceptual);
        expect(transform.usesBPC).toBe(false);
    });

    test('a v4 gray TRC takes its black from the curve', () => {
        const gray = fromBytes(asV4(Profile.createGrayICC({gamma: 2.2})));
        const adobe = fromBytes(readBytes(ADOBE));
        const convertAt = (intent) => {
            const transform = new Transform({dataFormat: 'object', BPC: true});
            transform.create(gray, adobe, intent);
            return transform.transform(convert.Gray(20)).R;
        };
        expect(convertAt(eIntent.perceptual)).toBeCloseTo(convertAt(eIntent.relative), 6);
    });
});

describe('array() through the pixel cache', () => {
    const cmykToRgb = (dataFormat) => {
        const transform = new Transform({dataFormat});
        transform.create(fromBytes(readBytes(GRACOL)), new Profile('*sRGB'), eIntent.relative);
        return transform;
    };

    test('a filled alpha channel is allocated', () => {
        const transform = cmykToRgb('int8');
        const out = transform.array(new Uint8Array(12), false, true);
        expect(transform.lastUsedKernel).toBe('cache');
        expect(out.length).toBe(12);
        expect(out[11]).toBe(255);
    });

    test('filled alpha is opaque in the dataFormat', () => {
        const out = cmykToRgb('int16').array(new Uint16Array(4), false, true);
        expect(out[3]).toBe(65535);
    });

    test("the caller's output buffer is used", () => {
        const buffer = new Uint8ClampedArray(9);
        expect(cmykToRgb('int8').array(new Uint8Array(12), false, false, false, 3, buffer)).toBe(buffer);
    });
});

describe('loading', () => {
    test('displayChromaticAdaptation builds and runs', () => {
        const transform = new Transform({dataFormat: 'object', displayChromaticAdaptation: true});
        transform.create(fromBytes(readBytes(GRACOL)), fromBytes(readBytes(ADOBE)), eIntent.relative);
        expect(Number.isFinite(transform.transform(convert.CMYK(0, 0, 0, 0)).R)).toBe(true);
    });

    test('searchForProfile decodes from the embedded profile', () => {
        const icc = readBytes(ADOBE);
        const host = new Uint8Array(1000 + icc.length);
        host.set([73, 67, 67, 95, 80, 82, 79, 70, 73, 76, 69, 0, 1, 1], 500); // ICC_PROFILE
        host.set(icc, 514);
        const profile = new Profile();
        profile.loadBinary(host, () => {}, true);
        expect(profile.loaded).toBe(true);
        expect(profile.colorSpace).toBe('RGB');
    });

    test('a decode failure is a failed load, not a throw', () => {
        const curve = () => curvGamma(2.2);
        const profile = fromBytes(matrixProfile(curve(), curve(), curve(), false));
        expect(profile.loaded).toBe(false);
        expect(profile.lastError.text).toMatch(/decode failed/i);
    });

    test('version 3 reads as version 2', () => {
        const bytes = readBytes(ADOBE);
        bytes[8] = 3;
        const profile = fromBytes(bytes);
        expect(profile.loaded).toBe(true);
        expect(profile.version).toBe(2);
    });
});

describe('truncated and padded files', () => {
    const icc = () => readBytes(ADOBE);

    test('short of the declared size fails, with a reason', () => {
        const bytes = icc();
        const profile = fromBytes(bytes.slice(0, bytes.length - 4));
        expect(profile.loaded).toBe(false);
        expect(profile.lastError.text).toMatch(/truncated/i);
    });

    test('up to three missing pad bytes are tolerated', () => {
        const bytes = icc();
        expect(fromBytes(bytes.slice(0, bytes.length - 3)).loaded).toBe(true);
    });

    test('zeros past the declared size are ignored', () => {
        const bytes = icc();
        const padded = new Uint8Array(bytes.length + 512);
        padded.set(bytes);
        expect(fromBytes(padded).loaded).toBe(true);
    });

    test('a tag ending past the data fails even if the size field agrees', () => {
        const bytes = icc();
        bytes.set([0x00, 0x10, 0x00, 0x00], 132 + 8); // first tag's length
        const profile = fromBytes(bytes);
        expect(profile.loaded).toBe(false);
        expect(profile.lastError.text).toMatch(/truncated/i);
    });

    test('a file smaller than a header fails', () => {
        expect(fromBytes(icc().slice(0, 130)).loaded).toBe(false);
    });

    test('an unreadable LUT tag fails rather than converting to black', () => {
        const unknown = [];
        enc.chars(unknown, 'xxxx', 4);
        enc.zeros(unknown, 60);
        const bytes = enc.assemble({colorSpace: 'RGB ', profileClass: 'prtr', pcs: 'Lab ', intent: 0}, [
            ['A2B0', unknown], ['cprt', enc.textType('test')], ['desc', enc.textDescriptionType('bad')],
            ['wtpt', enc.XYZType(enc.D50)],
        ]);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const profile = fromBytes(bytes);
        warn.mockRestore();
        expect(profile.loaded).toBe(false);
        expect(profile.lastError.text).toMatch(/LUT/);
    });
});

describe('DeviceLink LUT JSON', () => {
    const rgbToCmykLink = () => {
        const grid = 3;
        const cells = [];
        const ink = (index) => Math.min(65535, 32768 * (2 - index));
        for(let r = 0; r < grid; r++){
            for(let g = 0; g < grid; g++){
                for(let b = 0; b < grid; b++){
                    cells.push(ink(r), ink(g), ink(b), 0);
                }
            }
        }
        return fromBytes(enc.assemble({colorSpace: 'RGB ', profileClass: 'link', pcs: 'CMYK', intent: 0}, [
            ['A2B0', enc.lut16Type({inputChannels: 3, outputChannels: 4, gridPoints: grid, CLUT: cells})],
            ['cprt', enc.textType('test')], ['desc', enc.textDescriptionType('link')],
        ]));
    };
    const pixels = new Uint8Array([10, 20, 30, 200, 100, 50]);

    test('a baked link keeps the output channel count', () => {
        const link = rgbToCmykLink();
        const baked = new Transform({dataFormat: 'int8', buildLut: true});
        baked.create(link);
        const walked = new Transform({dataFormat: 'int8', pixelCache: 0});
        walked.create(link);
        const bakedOut = baked.array(pixels, false, false);
        const walkedOut = walked.array(pixels, false, false);
        expect(bakedOut.length).toBe(8);
        bakedOut.forEach((value, index) => {
            expect(Math.abs(value - walkedOut[index])).toBeLessThanOrEqual(1);
        });
    });

    test('toJSON output round trips through fromJSON', () => {
        const baked = new Transform({dataFormat: 'int8', buildLut: true});
        baked.create(rgbToCmykLink());
        const restored = Transform.fromJSON(JSON.parse(JSON.stringify(baked.toJSON())), {dataFormat: 'int8'});
        expect(Array.from(restored.array(pixels, false, false)))
            .toEqual(Array.from(baked.array(pixels, false, false)));
    });

    test('a one-entry chain is refused unless it is a DeviceLink', () => {
        const baked = new Transform({dataFormat: 'int8', buildLut: true});
        baked.create(new Profile('*sRGB'), new Profile('*AdobeRGB'), eIntent.relative);
        const json = JSON.parse(JSON.stringify(baked.toJSON()));
        json.chain = [json.chain[0]];
        let refusal = '';
        try { Transform.fromJSON(json); } catch(error) { refusal = String(error); }
        expect(refusal).toMatch(/DeviceLink/);
    });
});

describe('matrix black point', () => {
    const lifted = () => curvTable(gammaSamples(2.2).map((value) => Math.max(value, 2000)));

    test('comes from the curves when they do not start at zero', () => {
        const profile = fromBytes(matrixProfile(lifted(), lifted(), lifted()));
        expect(new Transform({}).detectBlackpoint(profile, eIntent.relative).Y).toBeGreaterThan(0);
    });

    test('BPC runs between matrix profiles when a black differs', () => {
        const transform = new Transform({dataFormat: 'object', BPC: true});
        transform.create(fromBytes(matrixProfile(lifted(), lifted(), lifted())),
            fromBytes(readBytes(ADOBE)), eIntent.relative);
        expect(transform.usesBPC).toBe(true);
    });

    test('a curve starting at zero stays on the fast kernel under BPC', () => {
        const curve = () => curvTable(gammaSamples(2.2));
        const transform = new Transform({dataFormat: 'int8', BPC: true});
        transform.create(fromBytes(matrixProfile(curve(), curve(), curve())),
            fromBytes(readBytes(ADOBE)), eIntent.relative);
        transform.array(new Uint8Array(30), false, false);
        expect(transform.lastUsedKernel).toBe('matrix-shaper');
    });
});

describe('absolute intent on matrix profiles', () => {
    const D65 = {X: 0.95045, Y: 1, Z: 1.08905};
    const withWhite = (version) => {
        const gamma = () => curvGamma(2.2);
        const tags = [
            ['bTRC', gamma()], ['bXYZ', enc.XYZType(SRGB_D50.b)],
            ['cprt', enc.textType('test')], ['desc', enc.textDescriptionType('d65')],
            ['gTRC', gamma()], ['gXYZ', enc.XYZType(SRGB_D50.g)],
            ['rTRC', gamma()], ['rXYZ', enc.XYZType(SRGB_D50.r)],
            ['wtpt', enc.XYZType(D65)],
        ];
        const bytes = enc.assemble({colorSpace: 'RGB ', profileClass: 'mntr', pcs: 'XYZ ', intent: 0}, tags);
        return fromBytes(version === 4 ? asV4(bytes) : bytes);
    };
    const toLab = (profile, intent) => {
        const transform = new Transform({dataFormat: 'object', pixelCache: 0});
        transform.create(profile, new Profile('*Lab'), intent);
        return transform.transform(convert.RGB(255, 255, 255));
    };

    test('a v4 media white scales absolute', () => {
        const absolute = toLab(withWhite(4), eIntent.absolute);
        const relative = toLab(withWhite(4), eIntent.relative);
        expect(Math.abs(absolute.b - relative.b)).toBeGreaterThan(10);
    });

    test('a v2 display white does not', () => {
        const absolute = toLab(withWhite(2), eIntent.absolute);
        const relative = toLab(withWhite(2), eIntent.relative);
        expect(absolute.b).toBeCloseTo(relative.b, 6);
    });

    test('absolute into the profile is the inverse of absolute out of it', () => {
        const profile = withWhite(4);
        const out = new Transform({dataFormat: 'object', pixelCache: 0});
        out.create(profile, new Profile('*Lab'), eIntent.absolute);
        const back = new Transform({dataFormat: 'object', pixelCache: 0});
        back.create(new Profile('*Lab'), profile, eIntent.absolute);
        const colour = back.transform(out.transform(convert.RGB(120, 90, 200)));
        expect(Math.abs(colour.R - 120)).toBeLessThan(1);
        expect(Math.abs(colour.G - 90)).toBeLessThan(1);
        expect(Math.abs(colour.B - 200)).toBeLessThan(1);
    });

    test('a D50 white keeps the matrix kernel', () => {
        const curve = () => curvGamma(2.2);
        const transform = new Transform({dataFormat: 'int8'});
        transform.create(fromBytes(matrixProfile(curve(), curve(), curve())), new Profile('*AdobeRGB'), eIntent.absolute);
        transform.array(new Uint8Array(30), false, false);
        expect(transform.lastUsedKernel).toBe('matrix-shaper');
    });
});

describe('black point detection', () => {
    // An RGB LUT profile whose darkest colorant sits at a chosen L*.
    const withDarkest = (lightness, tagNames) => {
        const cells = [];
        for(let r = 0; r < 2; r++){
            for(let g = 0; g < 2; g++){
                for(let b = 0; b < 2; b++){
                    const L = lightness + (100 - lightness) * (r + g + b) / 3;
                    cells.push(...enc.labToU16v2(L, 0, 0));
                }
            }
        }
        const a2b = enc.lut16Type({inputChannels: 3, outputChannels: 3, gridPoints: 2, CLUT: cells});
        return fromBytes(enc.assemble({colorSpace: 'RGB ', profileClass: 'prtr', pcs: 'Lab ', intent: 0}, [
            ...tagNames.map((name) => [name, a2b]),
            ['cprt', enc.textType('test')], ['desc', enc.textDescriptionType('dark')],
            ['wtpt', enc.XYZType(enc.D50)],
        ]));
    };
    const blackLightness = (profile, intent) => {
        const transform = new Transform({});
        const black = transform.detectBlackpoint(profile, intent);
        return transform.XYZ2Lab(black).L;
    };

    test('a dark colorant is the black point', () => {
        expect(blackLightness(withDarkest(20, ['A2B0', 'A2B1']), eIntent.relative)).toBeCloseTo(20, 1);
    });

    test('L* is limited to 50', () => {
        expect(blackLightness(withDarkest(70, ['A2B0', 'A2B1']), eIntent.relative)).toBeCloseTo(50, 1);
    });

    test('a darkest colorant above L* 95 is a synthetic negative, not a black', () => {
        expect(blackLightness(withDarkest(97, ['A2B0', 'A2B1']), eIntent.relative)).toBeCloseTo(0, 3);
    });

    test('no table for the intent means no black point', () => {
        const profile = withDarkest(20, ['A2B0']);
        expect(blackLightness(profile, eIntent.relative)).toBeCloseTo(0, 3);
        expect(blackLightness(profile, eIntent.perceptual)).toBeCloseTo(20, 1);
    });
});

describe('gray LUT density', () => {
    const gray = () => fromBytes(Profile.createGrayICC({gamma: 1.8}));
    const bake = (options) => {
        const transform = new Transform(Object.assign({buildLut: true}, options));
        transform.create(gray(), fromBytes(readBytes(GRACOL)), eIntent.relative);
        return transform;
    };

    test('int8 has a node on every code, so the LUT is exact', () => {
        const codes = new Uint8Array(256).map((_, code) => code);
        const walked = new Transform({dataFormat: 'int8', pixelCache: 0});
        walked.create(gray(), fromBytes(readBytes(GRACOL)), eIntent.relative);
        const baked = bake({dataFormat: 'int8'});
        expect(baked.lut.gridPoints).toEqual([256]);
        expect(Array.from(baked.array(codes, false, false)))
            .toEqual(Array.from(walked.array(codes, false, false)));
    });

    test('other formats default to 4096', () => {
        expect(bake({dataFormat: 'int16'}).lut.gridPoints).toEqual([4096]);
    });

    test('lutGridPoints1D wins, and lutGridPoints3D alone still applies', () => {
        expect(bake({dataFormat: 'int8', lutGridPoints1D: 129}).lut.gridPoints).toEqual([129]);
        expect(bake({dataFormat: 'int8', lutGridPoints3D: 65}).lut.gridPoints).toEqual([65]);
    });

    test('getOptions reports the grid sizes', () => {
        const options = bake({dataFormat: 'int8'}).getOptions();
        expect(options.lutGridPoints1D).toBe(256);
        expect(options.lutGridPoints3D).toBe(33);
        expect(options.lutGridPoints4D).toBe(17);
    });
});

describe('small fixes', () => {
    test('reformat clamps into containers that would wrap', () => {
        expect(Array.from(Transform.reformat([1.2, -0.1, 0.5], 'device', 'int16'))).toEqual([65535, 0, 32768]);
        expect(Array.from(Transform.reformat([1.2, -0.1], 'device', 'int8', new Uint8Array(2)))).toEqual([255, 0]);
    });

    test('toSpectral derives a positive step', () => {
        const Spectral = require('../src/Spectral');
        expect(new Spectral().toSpectral(380, 730, new Array(36).fill(1)).step).toBe(10);
    });

    test('stage_curves_v4 returns one value per curve', () => {
        const passThrough = {curveFn: false, dataf: [], gamma: 1};
        const transform = new Transform({});
        expect(transform.stage_curves_v4([0.5], [passThrough]).length).toBe(1);
        expect(transform.stage_curves_v4([0.5, 0.5], [passThrough, passThrough]).length).toBe(2);
    });

    test('a 1-D LUT honours lutGamutMode', () => {
        const build = (lutGamutMode) => {
            const transform = new Transform({dataFormat: 'int8', buildLut: true, lutGamutMode});
            transform.create(fromBytes(Profile.createGrayICC({gamma: 2.2})), new Profile('*sRGB'), eIntent.relative);
            return Array.from(transform.array(new Uint8Array([100]), false, false));
        };
        expect(build('map')).not.toEqual(build('none'));
    });

    test('the compiled Duo stage writes b', () => {
        const source = new Transform({}).emit_js_stage_device_to_Duo(0, {});
        expect(source).toMatch(/b: \(device\[1\]/);
    });

    test('Loader lazy load waits for a URL', async () => {
        const http = require('http');
        const { Loader } = require('../src/main');
        const server = http.createServer((request, response) => {
            setTimeout(() => { response.writeHead(200); response.end(readBytes(ADOBE)); }, 10);
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        try {
            const loader = new Loader();
            loader.add('http://127.0.0.1:' + server.address().port + '/profile.icc', 'adobe', false);
            expect((await loader.get('adobe')).loaded).toBe(true);
        } finally {
            server.close();
        }
    });

    test('Loader.loadAll counts a bad profile and carries on', async () => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const loader = new (require('../src/main').Loader)();
        loader.add('*NotAProfile', 'bad', true);
        loader.add('*sRGB', 'good', true);
        await loader.loadAll();
        log.mockRestore();
        expect(loader.loadCount).toBe(1);
        expect(loader.errorCount).toBe(1);
    });
});

describe('X*Y*Z CLUT grids', () => {
    // A table linear in every channel: any correct interpolator returns the
    // function itself, so the expected answer comes from the formula and from
    // neither engine. An axis or stride error cannot land on the right value.
    const toPcs = (x) => [
        0.2 + 0.7 * x[0],
        0.3 + 0.4 * x[1 % x.length],
        0.25 + 0.5 * x[x.length - 1],
    ];
    const toDevice = (outputChannels) => (lab) => {
        const device = [];
        for(let c = 0; c < outputChannels; c++){
            device.push(0.1 + 0.8 * lab[c % 3]);
        }
        return device;
    };

    function gridTag(signature, dims, outputChannels, fn) {
        const inputChannels = dims.length;
        const out = [];
        enc.chars(out, signature, 4);
        enc.zeros(out, 4);
        enc.u8(out, inputChannels);
        enc.u8(out, outputChannels);
        enc.u16(out, 0);

        const curveSet = (count) => {
            const curves = [];
            for(let c = 0; c < count; c++){ curves.push(...paraTag(0, [1.0])); }
            return curves;
        };
        const bCurves = curveSet(signature === 'mAB ' ? outputChannels : inputChannels);
        const aCurves = curveSet(signature === 'mAB ' ? inputChannels : outputChannels);
        const bOffset = 32;
        const aOffset = bOffset + bCurves.length;
        enc.u32(out, bOffset); enc.u32(out, 0); enc.u32(out, 0);
        enc.u32(out, aOffset + aCurves.length); enc.u32(out, aOffset);
        out.push(...bCurves, ...aCurves);

        for(let axis = 0; axis < 16; axis++){ out.push(dims[axis] || 0); }
        enc.u8(out, 2);
        enc.zeros(out, 3);

        const index = new Array(inputChannels).fill(0);
        const walk = (axis) => {
            if(axis === inputChannels){
                fn(index.map((value, d) => value / (dims[d] - 1)))
                    .forEach((value) => enc.u16(out, Math.round(value * 65535)));
                return;
            }
            for(let i = 0; i < dims[axis]; i++){
                index[axis] = i;
                walk(axis + 1);
            }
        };
        walk(0);
        enc.pad4(out);
        return out;
    }

    function gridProfile(space, inputDims, outputDims) {
        const a2b = gridTag('mAB ', inputDims, 3, toPcs);
        const b2a = gridTag('mBA ', outputDims, inputDims.length, toDevice(inputDims.length));
        return fromBytes(asV4(enc.assemble({colorSpace: space, profileClass: 'prtr', pcs: 'Lab ', intent: 0}, [
            ['A2B0', a2b], ['A2B1', a2b], ['B2A0', b2a], ['B2A1', b2a],
            ['cprt', enc.textType('test')], ['desc', enc.textDescriptionType('xyz grid')],
            ['wtpt', enc.XYZType(enc.D50)],
        ])));
    }

    const expectLab = (result, device) => {
        const pcs = toPcs(device);
        expect(result.L).toBeCloseTo(pcs[0] * 100, 2);
        expect(result.a).toBeCloseTo(pcs[1] * 255 - 128, 2);
        expect(result.b).toBeCloseTo(pcs[2] * 255 - 128, 2);
    };

    test.each([
        ['RGB ', [5, 9, 17], [0.13, 0.62, 0.81]],
        ['RGB ', [17, 9, 5], [0.77, 0.41, 0.29]],
        ['CMYK', [5, 9, 7, 11], [0.13, 0.62, 0.81, 0.37]],
    ])('%s %j device to Lab', (space, dims, device) => {
        const transform = new Transform({dataFormat: 'device', pixelCache: 0});
        transform.create(gridProfile(space, dims, [5, 9, 17]), new Profile('*Lab'), eIntent.relative);
        expect(transform.getStageNames()).toMatch(/tetrahedralInterpND/);
        const encoded = transform.transform(device);
        expectLab({L: encoded[0] * 100, a: encoded[1] * 255 - 128, b: encoded[2] * 255 - 128}, device);
    });

    test('2-channel input takes the same route', () => {
        const device = [0.3, 0.7];
        const transform = new Transform({dataFormat: 'device', pixelCache: 0});
        transform.create(gridProfile('2CLR', [5, 9], [5, 9, 17]), new Profile('*Lab'), eIntent.relative);
        const encoded = transform.transform(device);
        expectLab({L: encoded[0] * 100, a: encoded[1] * 255 - 128, b: encoded[2] * 255 - 128}, device);
    });

    test('Lab input is multilinear, as the fixed-grid path is', () => {
        const transform = new Transform({dataFormat: 'device', pixelCache: 0});
        transform.create(new Profile('*Lab'), gridProfile('RGB ', [5, 5, 5], [5, 9, 17]), eIntent.relative);
        expect(transform.getStageNames()).toMatch(/multilinearInterpND/);
        const lab = [0.42, 0.58, 0.47];
        const expected = toDevice(3)(lab);
        transform.transform(lab).forEach((value, channel) => {
            expect(value).toBeCloseTo(expected[channel], 4);
        });
    });

    test('integer pixels go through the walk with the right scales', () => {
        const device = [64, 128, 200];
        const transform = new Transform({dataFormat: 'int16', pixelCache: 0});
        transform.create(gridProfile('RGB ', [5, 9, 17], [9, 17, 5]), new Profile('*Lab'), eIntent.relative);
        const encoded = transform.transform(device.map((value) => value * 257));
        const pcs = toPcs(device.map((value) => value / 255));
        Array.from(encoded).slice(0, 3).forEach((value, channel) => {
            expect(Math.abs(value / 65535 - pcs[channel])).toBeLessThan(0.001);
        });
    });

    test('a baked LUT lands on the fixed grid and the image kernels', () => {
        const profile = gridProfile('RGB ', [5, 9, 17], [9, 17, 5]);
        const baked = new Transform({dataFormat: 'int8', buildLut: true});
        baked.create(profile, new Profile('*AdobeRGB'), eIntent.relative);
        expect(new Set(baked.lut.gridPoints).size).toBe(1);

        const walked = new Transform({dataFormat: 'int8', pixelCache: 0});
        walked.create(profile, new Profile('*AdobeRGB'), eIntent.relative);

        const pixels = new Uint8Array(300);
        for(let i = 0; i < pixels.length; i++){ pixels[i] = (i * 2654435761) >>> 24; }
        const bakedOut = baked.array(pixels, false, false);
        expect(baked.lastUsedKernel).toBe('kernel3D');
        const walkedOut = walked.array(pixels, false, false);
        for(let i = 0; i < bakedOut.length; i++){
            expect(Math.abs(bakedOut[i] - walkedOut[i])).toBeLessThanOrEqual(3);
        }
    });

    test('an N*N*N LUT keeps its kernel', () => {
        const transform = new Transform({dataFormat: 'device', pixelCache: 0});
        transform.create(gridProfile('RGB ', [9, 9, 9], [9, 9, 9]), new Profile('*Lab'), eIntent.relative);
        expect(transform.getStageNames()).not.toMatch(/InterpND/);
    });

    test('an n-channel bake uses the densest axis, within the size limit', () => {
        const transform = new Transform({});
        expect(transform.nChannelLutGrid([9, 9, 9, 9, 9, 9], 4)).toBe(9);
        expect(transform.nChannelLutGrid([3, 2, 2, 2, 5], 3)).toBe(5);
        const grid = transform.nChannelLutGrid([17, 3, 3, 3, 3, 3], 3);
        expect(grid).toBe(13);
        expect(Math.pow(grid, 6) * 3).toBeLessThanOrEqual(16e6);
    });

    test('a 5-channel bake uses the densest axis', () => {
        const dims = [3, 2, 2, 2, 5];
        const a2b = gridTag('mAB ', dims, 3, toPcs);
        const bytes = asV4(enc.assemble({colorSpace: '5CLR', profileClass: 'prtr', pcs: 'Lab ', intent: 0}, [
            ['A2B0', a2b], ['A2B1', a2b],
            ['cprt', enc.textType('test')], ['desc', enc.textDescriptionType('5clr')],
            ['wtpt', enc.XYZType(enc.D50)],
        ]));
        const baked = new Transform({dataFormat: 'int8', buildLut: true});
        baked.create(fromBytes(bytes), new Profile('*sRGB'), eIntent.relative);
        expect(baked.lut.gridPoints).toEqual([5, 5, 5, 5, 5]);
    });
});

// ---------------------------------------------------------------------------
// Audit pass: wrong colour with no error, and damaged profiles.
// ---------------------------------------------------------------------------

const readFixture = (name) => new Uint8Array(fs.readFileSync(path.join(__dirname, name)));
const uint32At = (bytes, offset) => ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
const tagOffset = (bytes, signature) => {
    for (let index = 0; index < uint32At(bytes, 128); index++) {
        const entry = 132 + index * 12;
        if (String.fromCharCode(bytes[entry], bytes[entry + 1], bytes[entry + 2], bytes[entry + 3]) === signature) {
            return uint32At(bytes, entry + 4);
        }
    }
    throw new Error('no ' + signature + ' tag');
};
const renameTag = (bytes, signature) => {
    const copy = bytes.slice();
    for (let index = 0; index < uint32At(copy, 128); index++) {
        const entry = 132 + index * 12;
        if (String.fromCharCode(copy[entry], copy[entry + 1], copy[entry + 2], copy[entry + 3]) === signature) {
            copy.set([122, 122, 122, 122], entry);
        }
    }
    return copy;
};
const deviceTransform = (source, destination) => {
    const transform = new Transform({dataFormat: 'device', BPC: false});
    transform.create(source, destination, eIntent.relative);
    return transform;
};
const jpegWith = (profileBytes) => {
    const segmentSize = 65519;
    const total = Math.ceil(profileBytes.length / segmentSize);
    const parts = [[0xFF, 0xD8]];
    for (let sequence = 1; sequence <= total; sequence++) {
        const chunk = profileBytes.subarray((sequence - 1) * segmentSize, Math.min(profileBytes.length, sequence * segmentSize));
        const length = 2 + 12 + 2 + chunk.length;
        parts.push([0xFF, 0xE2, length >> 8, length & 255, 73, 67, 67, 95, 80, 82, 79, 70, 73, 76, 69, 0, sequence, total]);
        parts.push(chunk);
    }
    parts.push([0xFF, 0xDA, 0, 2, 0xFF, 0xD9]);
    const jpeg = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let written = 0;
    for (const part of parts) { jpeg.set(part, written); written += part.length; }
    return jpeg;
};

describe('lut16 tables follow the table type, not the profile version', () => {
    // ICC.1:2010 10.8 and 10.9: a lut8/lut16 keeps its curves, its matrix and
    // the legacy Lab encoding in a v4 profile exactly as in a v2 one, so the
    // same tables must convert the same under either header.
    const shipped = readFixture('GRACoL2006_Coated1v2.icc');
    const flagged = shipped.slice();
    flagged[8] = 4;
    flagged[9] = 0x20;
    const versionTwo = fromBytes(shipped);
    const versionFour = fromBytes(flagged);
    const lab = new Profile('*Lab');

    test('the header version alone does not change Lab to CMYK', () => {
        expect(versionFour.version).toBe(4);
        const expected = deviceTransform(lab, versionTwo);
        const actual = deviceTransform(lab, versionFour);
        for (const colour of [[0.5, 0.5, 0.5], [0.7, 0.6, 0.4], [0.2, 0.5, 0.5], [0.95, 0.5, 0.5]]) {
            const want = expected.transform(colour);
            const got = actual.transform(colour);
            for (let channel = 0; channel < 4; channel++) {
                expect(got[channel]).toBeCloseTo(want[channel], 6);
            }
        }
    });

    test('nor CMYK to Lab', () => {
        const expected = deviceTransform(versionTwo, lab);
        const actual = deviceTransform(versionFour, lab);
        for (const colour of [[0, 0, 0, 0], [0.2, 0.1, 0.1, 0], [0.5, 0.4, 0.4, 0.1], [1, 1, 1, 1]]) {
            const want = expected.transform(colour);
            const got = actual.transform(colour);
            for (let channel = 0; channel < 3; channel++) {
                expect(got[channel]).toBeCloseTo(want[channel], 6);
            }
        }
    });
});

describe('a matrix profile is described by its curves', () => {
    const adobeBytes = readFixture('AdobeRGB1998.icc');

    test('a description starting "sRGB" does not swap in the sRGB curve', () => {
        const renamed = adobeBytes.slice();
        renamed.set([0x73, 0x52, 0x47, 0x42], tagOffset(adobeBytes, 'desc') + 12);
        const original = fromBytes(adobeBytes);
        const impostor = fromBytes(renamed);
        expect(impostor.name.substring(0, 4)).toBe('sRGB');

        const lab = new Profile('*Lab');
        const want = deviceTransform(original, lab).transform([0.1, 0.1, 0.1]);
        const got = deviceTransform(impostor, lab).transform([0.1, 0.1, 0.1]);
        expect(got[0]).toBeCloseTo(want[0], 9);
    });

    test('same primaries with a different gamma is not an identity conversion', () => {
        const linear = adobeBytes.slice();
        const seen = new Set();
        for (const signature of ['rTRC', 'gTRC', 'bTRC']) {
            const offset = tagOffset(adobeBytes, signature);
            if (!seen.has(offset)) { linear.set([1, 0], offset + 12); seen.add(offset); }
        }
        const transform = deviceTransform(fromBytes(adobeBytes), fromBytes(linear));
        expect(transform.isIdentity).toBe(false);
        expect(transform.transform([0.25, 0.25, 0.25])[0]).toBeCloseTo(Math.pow(0.25, 563 / 256), 4);
    });

    test('the same file loaded twice still collapses to identity', () => {
        const transform = deviceTransform(fromBytes(adobeBytes), fromBytes(adobeBytes));
        expect(transform.isIdentity).toBe(true);
    });

    describe('one RGB profile as source and destination', () => {
        const rgbLutFile = path.join(__dirname, 'profiles', 'synthetic_03ch.icc');
        const fromFile = (file) => new Profile('file:' + file);
        const fromBase64 = (file) => new Profile('data:' + fs.readFileSync(file).toString('base64'));

        test('every load route gives the same fingerprint', () => {
            const viaBytes = fromBytes(readFixture(path.join('profiles', 'synthetic_03ch.icc')));
            expect(typeof viaBytes.profileFingerprint).toBe('string');
            expect(fromFile(rgbLutFile).profileFingerprint).toBe(viaBytes.profileFingerprint);
            expect(fromBase64(rgbLutFile).profileFingerprint).toBe(viaBytes.profileFingerprint);
        });

        test('an RGB LUT profile loaded from a file is a no-op against itself', () => {
            const profile = fromFile(rgbLutFile);
            expect(deviceTransform(profile, profile).isIdentity).toBe(true);
            expect(deviceTransform(fromFile(rgbLutFile), fromBase64(rgbLutFile)).isIdentity).toBe(true);
        });

        test('a one-byte difference is a different profile', () => {
            const changed = readFixture(path.join('profiles', 'synthetic_03ch.icc'));
            changed[changed.length - 1] ^= 1;
            const original = fromFile(rgbLutFile);
            const altered = fromBytes(changed);
            expect(altered.loaded).toBe(true);
            expect(altered.profileFingerprint).not.toBe(original.profileFingerprint);
            expect(deviceTransform(original, altered).isIdentity).toBe(false);
        });

        test('a CMYK profile loaded from a file is still a real conversion against itself', () => {
            const transform = deviceTransform(fromFile(GRACOL), fromFile(GRACOL));
            expect(transform.isIdentity).toBe(false);
        });

        test('virtual profiles carry no fingerprint', () => {
            expect(new Profile('*sRGB').profileFingerprint).toBe(false);
        });
    });

    test('create() leaves the chain and BPC arrays it was given alone', () => {
        const chain = ['*sRGB', eIntent.relative, '*sRGB', eIntent.relative, '*AdobeRGB'];
        const blackPoint = [true, false];
        const transform = new Transform({BPC: blackPoint});
        transform.createMultiStage(chain);
        expect(chain).toEqual(['*sRGB', eIntent.relative, '*sRGB', eIntent.relative, '*AdobeRGB']);
        expect(blackPoint).toEqual([true, false]);
    });
});

describe('profiles embedded in a JPEG', () => {
    test('a profile split across APP2 segments is put back together', () => {
        const profileBytes = readFixture('GRACoL2006_Coated1v2.icc');
        expect(profileBytes.length).toBeGreaterThan(65519 * 2);
        const reference = fromBytes(profileBytes);
        const embedded = new Profile();
        embedded.loadBinary(jpegWith(profileBytes), null, true);

        expect(embedded.loaded).toBe(true);
        expect(embedded.binaryHash).toBe(reference.binaryHash);
        const lab = new Profile('*Lab');
        expect(Array.from(deviceTransform(lab, embedded).transform([0.6, 0.55, 0.45])))
            .toEqual(Array.from(deviceTransform(lab, reference).transform([0.6, 0.55, 0.45])));
    });

    test('a JPEG missing one of the segments is refused', () => {
        const profileBytes = readFixture('GRACoL2006_Coated1v2.icc');
        const jpeg = jpegWith(profileBytes);
        // Rename the second APP2 segment so its part of the profile is absent.
        jpeg[2 + 2 + (2 + 12 + 2 + 65519) + 1] = 0xE3;
        const embedded = new Profile();
        embedded.loadBinary(jpeg, null, true);
        expect(embedded.loaded).toBe(false);
    });
});

describe('damaged profiles are refused quickly', () => {
    const adobeBytes = readFixture('AdobeRGB1998.icc');
    const cmykBytes = readFixture('GRACoL2006_Coated1v2.icc');
    const refusedWithin = (bytes, milliseconds) => {
        const started = Date.now();
        const profile = new Profile();
        profile.loadBinary(bytes);
        expect(Date.now() - started).toBeLessThan(milliseconds);
        expect(profile.loaded).toBe(false);
        return profile.lastError.text;
    };

    test('a curve entry count far larger than the file', () => {
        const damaged = adobeBytes.slice();
        damaged[tagOffset(adobeBytes, 'rTRC') + 8] = 0x01;      // 1 entry becomes 16,777,217
        expect(refusedWithin(damaged, 500)).toMatch(/curv tag declares/);
    });

    test.each([
        ['255 input channels', 8, 255, /input and/],
        ['255 grid points', 10, 255, /LUT table holds/],
        ['1 grid point', 10, 1, /grid has 1 points/],
        ['1 input channel in a CMYK profile', 8, 1, /header needs 4 to 3/],
    ])('a lut16 header declaring %s', (label, byte, value, message) => {
        const damaged = cmykBytes.slice();
        damaged[tagOffset(cmykBytes, 'A2B0') + byte] = value;
        expect(refusedWithin(damaged, 500)).toMatch(message);
    });

    test('an RGB profile with one matrix tag missing does not load', () => {
        const profile = new Profile();
        profile.loadBinary(renameTag(adobeBytes, 'gTRC'));
        expect(profile.loaded).toBe(false);
        expect(profile.lastError.text).toMatch(/incomplete set of matrix and curve tags/);
    });

    test('a gray profile with no kTRC does not load', () => {
        const profile = new Profile();
        profile.loadBinary(renameTag(readFixture('profiles/synthetic_gray_g22.icc'), 'kTRC'));
        expect(profile.loaded).toBe(false);
    });

    test('a profile with no B2A table says so when used as a destination', () => {
        let inputOnly = cmykBytes;
        for (const signature of ['B2A0', 'B2A1', 'B2A2']) { inputOnly = renameTag(inputOnly, signature); }
        const profile = fromBytes(inputOnly);
        expect(profile.loaded).toBe(true);
        const transform = new Transform({dataFormat: 'device'});
        expect(() => transform.create('*Lab', profile, eIntent.relative)).toThrow(/has no B2A table/);
    });
});

describe('loader odds and ends', () => {
    test('load() takes an ArrayBuffer', () => {
        const bytes = readFixture('AdobeRGB1998.icc');
        const profile = new Profile();
        profile.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        expect(profile.loaded).toBe(true);
    });

    test('load() fails cleanly on something that is not a profile source', () => {
        const profile = new Profile();
        let calledBack = false;
        profile.load(null, () => { calledBack = true; });
        expect(profile.loaded).toBe(false);
        expect(profile.loadError).toBe(true);
        expect(calledBack).toBe(true);
    });

    test('toICC keeps a parametric gray curve', () => {
        // A gray profile whose kTRC is a parametric gamma 2.4 (function type 1).
        const source = fromBytes(Profile.createGrayICC({gamma: 2.2}));
        const parametric = decode.curve(new Uint8Array(paraTag(1, [2.4, 1, 0])), 0);
        source.Gray.kTRC = parametric;
        const written = fromBytes(source.toICC());
        const middle = written.Gray.kTRC.dataf[Math.round(0.5 * (written.Gray.kTRC.count - 1))];
        expect(middle).toBeCloseTo(Math.pow(0.5, 2.4), 2);
    });
});

describe('RGB profile with a table in one direction and matrix tags', () => {
    // Little CMS uses the table where there is one and the matrix for the
    // other direction. Checked against lcms-wasm: 192 cases (two curves, XYZ
    // and Lab PCS, v2 and v4, three intents, BPC on and off) all within 0.06
    // of an 8-bit level and 0.03 dE.
    const curve = () => curvGamma(2.2);
    const tableCells = [];
    for (let r = 0; r < 5; r++) {
        for (let g = 0; g < 5; g++) {
            for (let b = 0; b < 5; b++) {
                tableCells.push(20 + r * 50, 20 + g * 50, 20 + b * 50);
            }
        }
    }
    const hybridProfile = (tableSignatures, withWhitePoint) => {
        const table = mft1Tag(3, 3, 5, tableCells);
        const tags = tableSignatures.map((signature) => [signature, table]).concat([
            ['bTRC', curve()], ['bXYZ', enc.XYZType(SRGB_D50.b)],
            ['cprt', enc.textType('test')], ['desc', enc.textDescriptionType('hybrid')],
            ['gTRC', curve()], ['gXYZ', enc.XYZType(SRGB_D50.g)],
            ['rTRC', curve()], ['rXYZ', enc.XYZType(SRGB_D50.r)],
        ]);
        if (withWhitePoint !== false) {
            tags.push(['wtpt', enc.XYZType(enc.D50)]);
        }
        return fromBytes(enc.assemble({colorSpace: 'RGB ', profileClass: 'mntr', pcs: 'XYZ ', intent: 0}, tags));
    };
    const plainMatrix = () => fromBytes(matrixProfile(curve(), curve(), curve()));
    const labSamples = [[0.5, 0.5, 0.5], [0.7, 0.6, 0.4], [0.2, 0.5, 0.5], [0.95, 0.5, 0.5]];
    const rgbSamples = [[0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], [0.8, 0.3, 0.2]];
    const convertAll = (source, destination, samples, intent) => {
        const transform = new Transform({dataFormat: 'device', BPC: false});
        transform.create(source, destination, intent);
        return samples.map((sample) => Array.from(transform.transform(sample)));
    };
    const expectSame = (actual, expected) => {
        actual.forEach((pixel, pixelIndex) => pixel.forEach((value, channel) => {
            expect(value).toBeCloseTo(expected[pixelIndex][channel], 10);
        }));
    };

    test('a profile with only A2B tables stays a LUT profile and flags the fallback', () => {
        const profile = hybridProfile(['A2B0']);
        expect(profile.loaded).toBe(true);
        expect(profile.hasMatrixFallback).toBe(true);
        expect(plainMatrix().hasMatrixFallback).toBe(false);
    });

    test('only A2B tables: as a destination it converts as the matrix profile does', () => {
        for (const intent of [eIntent.perceptual, eIntent.relative, eIntent.absolute]) {
            expectSame(convertAll('*Lab', hybridProfile(['A2B0']), labSamples, intent),
                       convertAll('*Lab', plainMatrix(), labSamples, intent));
        }
    });

    test('only B2A tables: as a source it converts as the matrix profile does', () => {
        for (const intent of [eIntent.perceptual, eIntent.relative, eIntent.absolute]) {
            expectSame(convertAll(hybridProfile(['B2A0']), '*Lab', rgbSamples, intent),
                       convertAll(plainMatrix(), '*Lab', rgbSamples, intent));
        }
    });

    test('the direction that has a table still uses the table', () => {
        const viaTable = convertAll(hybridProfile(['A2B0']), '*Lab', rgbSamples, eIntent.relative);
        const viaMatrix = convertAll(plainMatrix(), '*Lab', rgbSamples, eIntent.relative);
        expect(Math.abs(viaTable[0][0] - viaMatrix[0][0])).toBeGreaterThan(0.01);
    });

    test('the image path runs through the fallback', () => {
        const transform = new Transform({dataFormat: 'int8', buildLut: true, BPC: false});
        transform.create('*sRGB', hybridProfile(['A2B0']), eIntent.relative);
        const reference = new Transform({dataFormat: 'int8', buildLut: true, BPC: false});
        reference.create('*sRGB', plainMatrix(), eIntent.relative);
        const pixels = new Uint8ClampedArray([0, 0, 0, 128, 128, 128, 204, 77, 51, 255, 255, 255]);
        const output = Array.from(transform.transformArray(pixels));
        const expected = Array.from(reference.transformArray(pixels));
        output.forEach((value, index) => expect(Math.abs(value - expected[index])).toBeLessThanOrEqual(1));
    });

    test('black point compensation builds, with the black measured through the table', () => {
        // The profile's black is what its A2B table says device black is,
        // which here is well above zero, so the result differs from the plain
        // matrix profile. Little CMS measures it the same way.
        const transform = new Transform({dataFormat: 'device', BPC: true});
        transform.create('*Lab', hybridProfile(['A2B0']), eIntent.relative);
        const output = Array.from(transform.transform([0.5, 0.5, 0.5]));
        output.forEach((value) => expect(Number.isFinite(value)).toBe(true));
        const withoutCompensation = convertAll('*Lab', hybridProfile(['A2B0']), [[0.5, 0.5, 0.5]], eIntent.relative)[0];
        expect(output[0]).not.toBeCloseTo(withoutCompensation[0], 3);
    });

    test('without a wtpt tag there is no fallback, and the error is clear', () => {
        const profile = hybridProfile(['A2B0'], false);
        expect(profile.hasMatrixFallback).toBe(false);
        expect(() => convertAll('*Lab', profile, labSamples, eIntent.relative)).toThrow(/has no B2A table/);
    });
});
