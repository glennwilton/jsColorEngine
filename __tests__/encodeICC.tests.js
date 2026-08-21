/**
 * The ICC writer.
 *
 * WHY IT EXISTS. The engine could read profiles and never write one, so the
 * only profiles it could be tested against were the ones somebody shipped it.
 * That is fine for RGB and CMYK, where real profiles are everywhere, and
 * useless above four channels — there was nothing to hand Little CMS, so
 * Kernel1D, Kernel2D and KernelND had no oracle at all and could only ever be
 * checked against themselves.
 *
 * WHAT THESE TESTS CAN AND CANNOT PROVE. They prove the bytes are
 * well-formed and that our own decoder reads back what was written. They do
 * NOT prove any other CMS agrees — a writer can be self-consistently wrong,
 * which is the same trap the interpolator suite fell into when it tested every
 * variant at the one input scale where the bug was invisible.
 *
 * The thing that closes that gap is bench/lcms-comparison/accuracy_gray.js,
 * which hands the written profile to Little CMS and compares outputs. It is a
 * bench rather than a test because it needs the lcms-wasm dependency, and it
 * is the reason this writer exists at all.
 */
'use strict';

const Profile = require('../src/Profile');
const encode  = require('../src/encodeICC');
const decode  = require('../src/decodeICC');

// ---------------------------------------------------------------------------

describe('encodeICC — primitives are the inverse of decodeICC', () => {

    test('s15Fixed16 round-trips through the decoder', () => {
        for(const v of [0, 1, 0.9642, -1.5, 1.08905, 2.19921875, 0.0001]){
            const out = [];
            encode.s15Fixed16(out, v);
            const bytes = new Uint8Array(out);
            const back = decode.s15Fixed16Number(decode.uint32(bytes, 0));
            // 1/65536 is the representable step; anything larger is a bug.
            expect(Math.abs(back - v)).toBeLessThanOrEqual(1 / 65536);
        }
    });

    test('s15Fixed16 rounds rather than truncates', () => {
        // Truncation would make every round trip lose in the same direction,
        // so a profile written from a decoded one would drift a little
        // further on every pass.
        const out = [];
        encode.s15Fixed16(out, 1 / 65536 * 0.6);          // just over half a step
        expect(decode.uint32(new Uint8Array(out), 0)).toBe(1);
    });

    test('u8Fixed8 round-trips a gamma', () => {
        const out = [];
        encode.u8Fixed8(out, 2.2);
        expect(decode.u8Fixed8Number(new Uint8Array(out), 0)).toBeCloseTo(2.2, 2);
    });

    test('chars truncates and NUL-pads to exactly the length asked for', () => {
        let out = [];
        encode.chars(out, 'abcdefgh', 4);
        expect(out).toEqual([97, 98, 99, 100]);

        out = [];
        encode.chars(out, 'ab', 4);
        expect(out).toEqual([97, 98, 0, 0]);
    });
});

describe('encodeICC — tag types', () => {

    test('XYZType is 20 bytes and decodes back', () => {
        const bytes = new Uint8Array(encode.XYZType({ X: 0.9642, Y: 1, Z: 0.8249 }));
        expect(bytes.length).toBe(20);
        expect(decode.chars(bytes, 0, 4)).toBe('XYZ ');
        const xyz = decode.XYZType(bytes, 0);
        expect(xyz.X).toBeCloseTo(0.9642, 4);
        expect(xyz.Y).toBeCloseTo(1, 4);
        expect(xyz.Z).toBeCloseTo(0.8249, 4);
    });

    test('curveType carries all three meanings of count', () => {
        // 0 = linear, 1 = one gamma value, n = n samples. Getting these
        // confused produces a profile that opens fine and converts wrongly.
        const linear = new Uint8Array(encode.curveType({ passThrough: true }));
        expect(decode.curve(linear, 0).passThrough).toBe(true);

        const gamma = new Uint8Array(encode.curveType({ count: 1, gamma: 2.2 }));
        expect(decode.curve(gamma, 0).gamma).toBeCloseTo(2.2, 2);

        const samples = [0, 16384, 32768, 49152, 65535];
        const sampled = new Uint8Array(encode.curveType({
            count: samples.length, data: samples, use: true }));
        const back = decode.curve(sampled, 0);
        expect(back.count).toBe(5);
        expect(Array.from(back.data)).toEqual(samples);
    });

    test('textDescriptionType keeps the trailing block a reader walks past', () => {
        // The Unicode and ScriptCode fields are not optional even when empty:
        // a reader that walks the tag runs off the end without them.
        const bytes = new Uint8Array(encode.textDescriptionType('Hello'));
        expect(decode.text(bytes, 0).text).toBe('Hello');
        // 12 header + ascii + NUL + 4 language + 4 count + 2 + 1 + 67 script
        expect(bytes.length).toBe(91 + 5);
    });

    test('textType is ASCII plus a NUL', () => {
        const bytes = new Uint8Array(encode.textType('Copyright nobody'));
        expect(decode.text(bytes, 0).text).toBe('Copyright nobody');
    });
});

describe('Profile.createGrayICC — a profile the engine wrote', () => {

    test('the header says what it should', () => {
        const bytes = Profile.createGrayICC({ gamma: 2.2 });
        expect(decode.chars(bytes, 36, 4)).toBe('acsp');          // the signature
        expect(decode.uint32(bytes, 0)).toBe(bytes.length);       // size is patched
        expect(decode.chars(bytes, 16, 4)).toBe('GRAY');
        expect(decode.chars(bytes, 20, 4)).toBe('XYZ ');
        expect(decode.uint32(bytes, 8)).toBe(0x02400000);         // v2.4
    });

    test('every tag offset is 4-aligned and inside the file', () => {
        // Misalignment is the classic ICC writer bug: readers that use aligned
        // loads fault, and the ones that do not silently read the wrong bytes.
        const bytes = Profile.createGrayICC({ gamma: 2.2 });
        const count = decode.uint32(bytes, 128);
        expect(count).toBe(4);
        for(let i = 0; i < count; i++){
            const at = 132 + i * 12;
            const offset = decode.uint32(bytes, at + 4);
            const size   = decode.uint32(bytes, at + 8);
            expect(offset % 4).toBe(0);
            expect(offset + size).toBeLessThanOrEqual(bytes.length);
        }
    });

    test('our own decoder reads back what was written', () => {
        const bytes = Profile.createGrayICC({ gamma: 2.2, description: 'Synthetic Gray 2.2' });
        const p = new Profile();
        p.loadBinary(bytes);

        expect(p.loaded).toBe(true);
        expect(p.header.space.trim()).toBe('GRAY');
        expect(p.name).toBe('Synthetic Gray 2.2');
        expect(p.Gray.kTRC.gamma).toBeCloseTo(2.2, 2);
        expect(p.mediaWhitePoint.X).toBeCloseTo(0.9642, 3);
        expect(p.tags.map(t => t.sig).sort()).toEqual(['cprt', 'desc', 'kTRC', 'wtpt']);
    });

    test('decode → encode is byte-identical', () => {
        // The strongest statement available without a second CMS: nothing was
        // lost, reordered or re-rounded on the way through.
        const first = Profile.createGrayICC({ gamma: 2.2, description: 'Synthetic Gray 2.2' });
        const p = new Profile();
        p.loadBinary(first);
        expect(Array.from(p.toICC())).toEqual(Array.from(first));
    });

    test('a sampled curve survives the round trip exactly', () => {
        const samples = [];
        for(let i = 0; i < 256; i++) samples.push(Math.round(Math.pow(i / 255, 1.8) * 65535));
        const bytes = Profile.createGrayICC({ samples, description: 'Sampled' });
        const p = new Profile();
        p.loadBinary(bytes);
        expect(p.Gray.kTRC.count).toBe(256);
        expect(Array.from(p.Gray.kTRC.data)).toEqual(samples);
    });

    test('it drives a real Transform, and 1-D is the kernel that runs', () => {
        const { Transform, eIntent } = require('../src/main');
        const gray = new Profile();
        gray.loadBinary(Profile.createGrayICC({ gamma: 2.2 }));

        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create(gray, '*sRGB', eIntent.relative);
        expect(t.kernelInfo().name).toBe('kernel1D');

        const input = new Uint8ClampedArray([0, 64, 128, 255]);
        const out = t.transformArray(input, false, false, false, 4);
        expect(out.length).toBe(12);
        expect(Array.from(out.slice(0, 3))).toEqual([0, 0, 0]);
        expect(Array.from(out.slice(9))).toEqual([255, 255, 255]);
        // Monotonic: a gray ramp in must be a gray ramp out.
        for(let i = 1; i < 4; i++) expect(out[i * 3]).toBeGreaterThan(out[(i - 1) * 3]);
    });
});

describe('Profile.toICC — refuses what it cannot write honestly', () => {

    const path = require('path');

    test('a matrix profile throws rather than dropping its colourants', () => {
        const rgb = new Profile();
        rgb.loadFile(path.join(__dirname, 'AdobeRGB1998.icc'));
        expect(() => rgb.toICC()).toThrow(/only GRAY profiles/);
    });

    test('a LUT profile throws rather than dropping the tag that does the work', () => {
        // Reaching the LUT guard needs a GRAY profile carrying an A2B, which
        // no real file here is — so assert the guard reads the array contents
        // rather than the array, which is what it got wrong first time.
        // [null, null, null] is what a profile with no LUT tags carries, and
        // testing the array itself is testing that it exists.
        const gray = new Profile();
        gray.loadBinary(Profile.createGrayICC({ gamma: 2.2 }));
        expect(gray.A2B).toEqual([null, null, null]);
        expect(() => gray.toICC()).not.toThrow();

        gray.A2B[0] = { pretend: 'a LUT' };
        expect(() => gray.toICC()).toThrow(/A2B\/B2A LUT/);
    });
});
