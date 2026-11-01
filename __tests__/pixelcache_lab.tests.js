/**
 * PCS Lab object boundary — the pixel-cache bug, and the BPC probes
 * that walk the same conversion.
 *
 * A CMYK LUT → Lab pipeline fuses the PCS→cmsLab stage. The cache
 * marker used to be left on the old stage, so STORE sat after the
 * object conversion and the second transform() returned [undefined].
 * BPC measures black with that same CMYK→Lab walk, repeated down an
 * L* ramp, which is why Uncoated FOGRA29 and Japan Color 2001 Coated
 * shifted when BPC was on.
 *
 * What is pinned down here:
 *   - Cache off, 1 slot, and 32 slots return the same finite colour
 *     for Lab in and Lab out, including black. The second call is a
 *     hit, not [undefined].
 *   - That holds with BPC on and with BPC off. The two BPC settings
 *     are compared separately: they are not expected to match each
 *     other when the destination is a printer.
 *   - A printer conversion (sRGB → FOGRA29) with BPC on does not
 *     depend on the caller's pixel cache. The probes are built with
 *     the cache off.
 *   - The black-point L* ramp itself (256 Lab → device → Lab steps,
 *     the walk BPC actually runs) matches with the cache off, at 1
 *     slot, and at 32 slots, including the repeated blacks.
 */

const fs = require('fs');
const path = require('path');
const { Transform, eIntent, convert } = require('../src/main');
const Profile = require('../src/Profile');

const GRACOL = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');
const FOGRA29 = path.join(__dirname, '..', 'testbed', 'profiles', 'cmyk', 'UncoatedFOGRA29.icc');
const CMYK_V4 = path.join(__dirname, '..', 'testbed', 'profiles', 'lcms_testbed', 'lcms2cmyk.icc');
const FOGRA39 = 'C:/Program Files (x86)/Common Files/Adobe/Color/Profiles/Recommended/CoatedFOGRA39.icc';
const JAPAN = 'C:/Program Files (x86)/Common Files/Adobe/Color/Profiles/Recommended/JapanColor2001Coated.icc';

const INTENTS = [
    ['perceptual', eIntent.perceptual],
    ['relative', eIntent.relative],
    ['absolute', eIntent.absolute],
];

function load(file) {
    const profile = new Profile();
    profile.loadFile(file);
    if (!profile.loaded) throw new Error('profile did not load: ' + file);
    return profile;
}

function normalise(value) {
    if (value === null || value === undefined) return String(value);
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        return 'array:' + Array.from(value).map(n => (typeof n === 'number' ? n.toFixed(9) : String(n))).join(',');
    }
    if (typeof value === 'object') {
        return Object.keys(value).sort()
            .map(k => k + ':' + (typeof value[k] === 'number' ? value[k].toFixed(9) : String(value[k])))
            .join(',');
    }
    return String(value);
}

function assertFiniteColour(value) {
    expect(value).toBeTruthy();
    expect(Array.isArray(value)).toBe(false);
    const numbers = Object.keys(value).filter(k => typeof value[k] === 'number');
    expect(numbers.length).toBeGreaterThan(0);
    for (const key of numbers) {
        expect(Number.isFinite(value[key])).toBe(true);
    }
}

/**
 * Cache off, one slot, and 32 slots must agree, including a second
 * call of the same colour. When the cache engages, that second call
 * is a hit and hands back a new object.
 */
function expectCacheAgrees(input, output, colourFn, intent, bpc, requireCache) {
    const plain = new Transform({ dataFormat: 'object', buildLut: false, pixelCache: 0, BPC: bpc });
    plain.create(input, output, intent);
    const expected = plain.transform(colourFn());
    assertFiniteColour(expected);
    const expectedText = normalise(expected);

    for (const slots of [1, 32]) {
        const cached = new Transform({ dataFormat: 'object', buildLut: false, pixelCache: slots, BPC: bpc });
        cached.create(input, output, intent);
        if (requireCache) expect(cached.pixelCacheUsed).toBe(slots);

        cached.resetPixelCacheStats();
        const first = cached.transform(colourFn());
        const second = cached.transform(colourFn());

        expect(normalise(first)).toBe(expectedText);
        expect(normalise(second)).toBe(expectedText);
        assertFiniteColour(second);

        if (cached.pixelCacheUsed) {
            // Two identical calls. The second is always a hit. The first
            // is a hit too when the colour is the one create() seeded
            // with (object RGB 128,128,128).
            const stats = cached.getPixelCacheStats();
            expect(stats.lookups).toBe(2);
            expect(stats.hits).toBeGreaterThanOrEqual(1);
            expect(second).not.toBe(first);
            // A hit must rebuild the object. Scribbling on the first
            // result must not change the next one.
            if (typeof first.L === 'number') first.L = -999;
            else if (typeof first.C === 'number') first.C = -999;
            else if (typeof first.R === 'number') first.R = -999;
            expect(normalise(cached.transform(colourFn()))).toBe(expectedText);
        }
    }
}

function cmykSamples() {
    return [
        ['black K', () => convert.CMYK(0, 0, 0, 100)],
        ['rich black', () => convert.CMYK(100, 100, 100, 100)],
        ['paper', () => convert.CMYK(0, 0, 0, 0)],
        ['reported', () => convert.CMYK(92, 64, 74, 84)],
    ];
}

describe('pixel cache — PCS Lab in and out', () => {

    const gracol = load(GRACOL);
    const v4 = load(CMYK_V4);
    expect(gracol.version).toBe(2);
    expect(v4.version).toBe(4);

    test('CMYK v2 (GRACoL) → Lab agrees with the cache off, BPC on and off, including black', () => {
        for (const [, intent] of INTENTS) {
            for (const bpc of [false, true]) {
                for (const [, colour] of cmykSamples()) {
                    expectCacheAgrees(gracol, '*Lab', colour, intent, bpc, true);
                }
            }
        }
    });

    test('CMYK v4 → Lab agrees with the cache off, BPC on and off', () => {
        for (const bpc of [false, true]) {
            for (const [, colour] of cmykSamples()) {
                expectCacheAgrees(v4, '*Lab', colour, eIntent.relative, bpc, true);
            }
        }
    });

    test('store sits in front of the Lab object stage', () => {
        const cached = new Transform({ dataFormat: 'object', buildLut: false, pixelCache: 1, BPC: false });
        cached.create(gracol, '*Lab', eIntent.relative);
        const names = cached.pipeline.map(s => s.stageName);
        const storeAt = names.indexOf('stage_pixelCacheStore');
        expect(storeAt).toBeGreaterThan(0);
        expect(names[storeAt + 1]).toMatch(/cmsLab/);
    });

    test('Lab → CMYK and sRGB → Lab agree with the cache off', () => {
        const labBlack = () => convert.Lab(0, 0, 0);
        const labMid = () => convert.Lab(50, 10, -20);
        const rgbBlack = () => convert.RGB(0, 0, 0);
        const rgbMid = () => convert.RGB(20, 18, 16);

        for (const bpc of [false, true]) {
            expectCacheAgrees('*Lab', gracol, labBlack, eIntent.relative, bpc, true);
            expectCacheAgrees('*Lab', gracol, labMid, eIntent.relative, bpc, true);
            expectCacheAgrees('*sRGB', '*Lab', rgbBlack, eIntent.relative, bpc, true);
            expectCacheAgrees('*sRGB', '*Lab', rgbMid, eIntent.relative, bpc, true);
            expectCacheAgrees('*Lab', '*sRGB', labBlack, eIntent.relative, bpc, true);
            expectCacheAgrees('*Lab', '*sRGB', labMid, eIntent.relative, bpc, true);
        }
    });

    test('Lab → Lab stays a finite Lab when the cache declines', () => {
        // No numeric array exists in front of the output stage, so the
        // cache must refuse rather than store the {L,a,b} object.
        for (const bpc of [false, true]) {
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            expectCacheAgrees('*Lab', '*Lab', () => convert.Lab(0, 0, 0), eIntent.relative, bpc, false);
            const cached = new Transform({ dataFormat: 'object', buildLut: false, pixelCache: 1, BPC: bpc });
            cached.create('*Lab', '*Lab', eIntent.relative);
            expect(cached.pixelCacheUsed).toBe(0);
            warn.mockRestore();
        }
    });

    const optional = [
        ['Coated FOGRA39', FOGRA39],
        ['Japan Color 2001 Coated', JAPAN],
    ];
    for (const [name, file] of optional) {
        const present = fs.existsSync(file);
        const runner = present ? test : test.skip;
        runner(name + ' → Lab agrees with the cache off, including black', () => {
            const profile = load(file);
            for (const bpc of [false, true]) {
                expectCacheAgrees(profile, '*Lab', () => convert.CMYK(0, 0, 0, 100), eIntent.relative, bpc, true);
                expectCacheAgrees(profile, '*Lab', () => convert.CMYK(92, 64, 74, 84), eIntent.perceptual, bpc, true);
            }
        });
    }
});

describe('pixel cache — BPC black point does not depend on it', () => {

    test('sRGB → Uncoated FOGRA29, BPC on and off, cache on matches cache off', () => {
        if (!fs.existsSync(FOGRA29)) return;
        const fogra = load(FOGRA29);
        const samples = [
            () => convert.RGB(0, 0, 0),
            () => convert.RGB(20, 18, 16),
            () => convert.RGB(128, 128, 128),
        ];
        for (const bpc of [false, true]) {
            for (const colour of samples) {
                expectCacheAgrees('*sRGB', fogra, colour, eIntent.relative, bpc, false);
            }
        }
    });

    test('sRGB → Japan Color 2001 Coated, BPC on, cache on matches cache off', () => {
        if (!fs.existsSync(JAPAN)) return;
        const japan = load(JAPAN);
        for (const colour of [() => convert.RGB(0, 0, 0), () => convert.RGB(16, 16, 16)]) {
            expectCacheAgrees('*sRGB', japan, colour, eIntent.relative, true, false);
            expectCacheAgrees('*sRGB', japan, colour, eIntent.relative, false, false);
        }
    });
});

/**
 * The walk detectOutputBlackpoint() actually runs: 256 steps up L*,
 * Lab → device at the requested intent, then device → Lab at relative.
 * Same Lab object reused, same as the probe. Cache off is the
 * reference. One slot and 32 slots must match it at every step,
 * including where the device colour repeats and the cache hits.
 */
function rampRoundTrip(profile, intent, pixelCache) {
    const labProfile = new Profile('*Lab');
    const toDevice = new Transform({ precision: 3, buildLut: false, pixelCache: pixelCache, BPC: false });
    const toLab = new Transform({ precision: 3, buildLut: false, pixelCache: pixelCache, BPC: false });
    toDevice._BPCAutoEnable = false;
    toLab._BPCAutoEnable = false;
    toDevice.create(labProfile, profile, intent);
    toLab.create(profile, labProfile, eIntent.relative);
    toLab.resetPixelCacheStats();

    const lab = convert.Lab(0, 0, 0);
    const rows = [];
    let repeats = 0;
    let previousKey = null;
    for (let step = 0; step < 256; step++) {
        lab.L = (step * 100) / 255;
        const device = toDevice.transform(lab);
        const key = device.C + ',' + device.M + ',' + device.Y + ',' + device.K;
        if (key === previousKey) repeats++;
        previousKey = key;
        const back = toLab.transform(device);
        rows.push({
            device: [device.C, device.M, device.Y, device.K],
            lab: back && [back.L, back.a, back.b],
            isArray: Array.isArray(back),
        });
    }
    return {
        rows: rows,
        repeats: repeats,
        used: toLab.pixelCacheUsed,
        hits: toLab.getPixelCacheStats().hits,
    };
}

function expectRampAgrees(profile) {
    for (const [, intent] of INTENTS) {
        const off = rampRoundTrip(profile, intent, 0);
        expect(off.rows).toHaveLength(256);
        for (const slots of [1, 32]) {
            const on = rampRoundTrip(profile, intent, slots);
            expect(on.used).toBe(slots);
            expect(on.rows).toHaveLength(256);
            for (let step = 0; step < 256; step++) {
                expect(on.rows[step].isArray).toBe(false);
                expect(on.rows[step].lab.map(Number.isFinite)).toEqual([true, true, true]);
                expect(on.rows[step].device).toEqual(off.rows[step].device);
                expect(on.rows[step].lab).toEqual(off.rows[step].lab);
            }
            if (off.repeats > 0) expect(on.hits).toBeGreaterThan(0);
        }
    }
}

describe('pixel cache — BPC L* ramp, all 256 steps', () => {

    test('GRACoL v2 ramp matches with the cache off, 1 slot, and 32 slots', () => {
        expectRampAgrees(load(GRACOL));
    });

    test('v4 CMYK ramp matches with the cache off, 1 slot, and 32 slots', () => {
        expectRampAgrees(load(CMYK_V4));
    });

    test('Uncoated FOGRA29 ramp matches with the cache off, 1 slot, and 32 slots', () => {
        if (!fs.existsSync(FOGRA29)) return;
        expectRampAgrees(load(FOGRA29));
    });

    const optional = [
        ['Coated FOGRA39', FOGRA39],
        ['Japan Color 2001 Coated', JAPAN],
    ];
    for (const [name, file] of optional) {
        const runner = fs.existsSync(file) ? test : test.skip;
        runner(name + ' ramp matches with the cache off, 1 slot, and 32 slots', () => {
            expectRampAgrees(load(file));
        });
    }
});
