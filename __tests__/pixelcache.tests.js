/**
 * Pixel cache — accuracy-path memoisation contract.
 *
 * The cache injects two stages into the pipeline (a check near the front and
 * a store just before the output conversion) and lets a hit jump the maths
 * via a mutable `step` on each stage. See docs/deepdive/PixelCache.md.
 *
 * What these tests pin down:
 *   - BEHAVIOUR NEUTRALITY: a cached transform returns exactly what an
 *     uncached one does, for every dataFormat. This is the important one —
 *     everything else is an optimisation detail.
 *   - Hit accounting, using three colours repeated ten times:
 *       interleaved A,B,C,A,B,C…  single-entry gets NO hits (never equal to
 *                                 the immediately preceding colour), while a
 *                                 keyed table gets 27 (3 misses to fill it).
 *       runs AAA…BBB…CCC          both forms get 27.
 *     That pair discriminates the two implementations — a single-entry cache
 *     passing the interleaved case would mean the table wasn't being used.
 *   - Mutation safety: with dataFormat 'device' nothing runs after the cache
 *     to rebuild a fresh result, so the hit path must hand back a copy.
 *     A caller mutating a result must not poison the entry.
 *   - The cache declines rather than misbehaves when it cannot guarantee
 *     correctness (pipelineDebug on, custom stages present).
 *
 * Counters are always on — they must NOT be tied to pipelineDebug, because
 * debug disables the cache, so requiring it would always report zero hits.
 */

const path = require('path');
const { Transform, eIntent } = require('../src/main');
const defs = require('../src/def');

const LAB = defs.eColourType.Lab;
const D50 = defs.illuminant.d50;

// Three distinct Lab colours, well separated so they cannot collide.
const COLOURS = [
    { type: LAB, L: 55, a: 30,  b: -20, whitePoint: D50 },
    { type: LAB, L: 80, a: -15, b: 40,  whitePoint: D50 },
    { type: LAB, L: 20, a: 5,   b: 5,   whitePoint: D50 },
];

const REPEATS = 10;
const TOTAL   = COLOURS.length * REPEATS;   // 30 conversions
const EXPECTED_HITS = TOTAL - COLOURS.length; // 27: one miss per distinct colour

function makeTransform(dataFormat, pixelCache) {
    const transform = new Transform({ dataFormat: dataFormat, pixelCache: pixelCache, buildLut: false });
    transform.create('*Lab', '*sRGB', eIntent.relative);
    return transform;
}

/** Stable string form so object and array results compare the same way. */
function normalise(value) {
    if (value === null || value === undefined) return String(value);
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        return Array.from(value).map(n => (+n).toFixed(9)).join(',');
    }
    if (typeof value === 'object') {
        return Object.keys(value).sort()
            .map(k => k + ':' + (typeof value[k] === 'number' ? value[k].toFixed(9) : String(value[k])))
            .join(',');
    }
    return String(value);
}

/** Fresh copy per call — a stage must never see a colour we already handed out. */
function labColour(index) {
    return Object.assign({}, COLOURS[index]);
}

describe('pixelCache — behaviour neutrality', () => {

    ['object', 'objectFloat', 'int8', 'int16'].forEach(dataFormat => {
        test(`${dataFormat}: cached output is identical to uncached`, () => {
            const plain  = makeTransform(dataFormat, 0);
            const single = makeTransform(dataFormat, 1);
            const keyed  = makeTransform(dataFormat, 32);

            for (let i = 0; i < TOTAL; i++) {
                const index = i % COLOURS.length;
                const expected = normalise(plain.transform(labColour(index)));
                expect(normalise(single.transform(labColour(index)))).toBe(expected);
                expect(normalise(keyed.transform(labColour(index)))).toBe(expected);
            }
        });
    });

    test('device: cached output is identical to uncached', () => {
        const plain = makeTransform('device', 0);
        const keyed = makeTransform('device', 32);
        const deviceColours = [[0.55, 0.60, 0.40], [0.80, 0.45, 0.70], [0.20, 0.52, 0.51]];

        for (let i = 0; i < TOTAL; i++) {
            const source = deviceColours[i % deviceColours.length];
            expect(normalise(keyed.transform(source.slice())))
                .toBe(normalise(plain.transform(source.slice())));
        }
        expect(keyed.getPixelCacheStats().hits).toBeGreaterThan(0);
    });
});

describe('pixelCache — hit accounting', () => {

    ['object', 'objectFloat', 'int8', 'int16'].forEach(dataFormat => {

        test(`${dataFormat}: interleaved A,B,C x${REPEATS} — single entry never hits, 32 slots hit ${EXPECTED_HITS}`, () => {
            const single = makeTransform(dataFormat, 1);
            const keyed  = makeTransform(dataFormat, 32);
            // create() runs one validation colour through the pipeline, so
            // start the count from zero here rather than allowing for it.
            single.resetPixelCacheStats();
            keyed.resetPixelCacheStats();

            for (let i = 0; i < TOTAL; i++) {
                single.transform(labColour(i % COLOURS.length));
                keyed.transform(labColour(i % COLOURS.length));
            }

            const singleStats = single.getPixelCacheStats();
            const keyedStats  = keyed.getPixelCacheStats();

            expect(singleStats.lookups).toBe(TOTAL);
            expect(keyedStats.lookups).toBe(TOTAL);

            // No colour ever equals the one immediately before it.
            expect(singleStats.hits).toBe(0);
            // Three misses to populate the table, everything after is a hit.
            expect(keyedStats.hits).toBe(EXPECTED_HITS);
            expect(keyedStats.misses).toBe(COLOURS.length);
            expect(keyedStats.hitRate).toBeCloseTo(EXPECTED_HITS / TOTAL, 10);
        });

        test(`${dataFormat}: runs AAA...BBB...CCC — both forms hit ${EXPECTED_HITS}`, () => {
            const single = makeTransform(dataFormat, 1);
            const keyed  = makeTransform(dataFormat, 32);
            single.resetPixelCacheStats();
            keyed.resetPixelCacheStats();

            for (let index = 0; index < COLOURS.length; index++) {
                for (let r = 0; r < REPEATS; r++) {
                    single.transform(labColour(index));
                    keyed.transform(labColour(index));
                }
            }

            expect(single.getPixelCacheStats().hits).toBe(EXPECTED_HITS);
            expect(keyed.getPixelCacheStats().hits).toBe(EXPECTED_HITS);
        });
    });

    test('slot count is reported, and a non-power-of-two request rounds down', () => {
        expect(makeTransform('object', 1).getPixelCacheStats().slots).toBe(1);
        expect(makeTransform('object', 16).getPixelCacheStats().slots).toBe(16);
        expect(makeTransform('object', 32).getPixelCacheStats().slots).toBe(32);
        expect(makeTransform('object', 48).getPixelCacheStats().slots).toBe(32);
    });

    test('hash variant is chosen from the boundary value, not from dataFormat', () => {
        function checkStageName(inputProfile, outputProfile, dataFormat) {
            const transform = new Transform({ dataFormat: dataFormat, buildLut: false, pixelCache: 32 });
            transform.create(inputProfile, outputProfile, eIntent.relative);
            const stage = transform.pipeline
                .filter(s => s.stageName.indexOf('stage_pixelCache_') === 0)[0];
            return stage ? stage.stageName : 'none';
        }

        // Same dataFormat, different variant: an sRGB input profile leaves raw
        // integers at the boundary, a Lab one leaves floats. This is why the
        // variant cannot be selected from dataFormat alone.
        expect(checkStageName('*sRGB', '*Lab', 'int8')).toBe('stage_pixelCache_keyedInt');
        expect(checkStageName('*Lab', '*sRGB', 'int8')).toBe('stage_pixelCache_keyed');

        expect(checkStageName('*sRGB', '*Lab', 'int16')).toBe('stage_pixelCache_keyedInt');
        expect(checkStageName('*Lab', '*sRGB', 'device')).toBe('stage_pixelCache_keyed');
        expect(checkStageName('*Lab', '*sRGB', 'object')).toBe('stage_pixelCache_keyed');
    });

    test('integer-boundary transforms still hit correctly', () => {
        // Regression guard: the first hash quantised by *65536, which throws
        // away the entropy of integer-valued input and collapsed distinct
        // colours into one slot. This is the case that caught it.
        const cached = new Transform({ dataFormat: 'int8', buildLut: false, pixelCache: 32 });
        cached.create('*sRGB', '*Lab', eIntent.relative);
        cached.resetPixelCacheStats();

        const sourceRGB = [[200, 30, 40], [10, 180, 90], [60, 70, 220]];
        for (let i = 0; i < TOTAL; i++) {
            cached.transform(sourceRGB[i % sourceRGB.length].slice());
        }
        expect(cached.getPixelCacheStats().hits).toBe(EXPECTED_HITS);
    });

    test('clearPixelCache() forces the next lookup to miss', () => {
        const keyed = makeTransform('object', 32);
        keyed.transform(labColour(0));
        keyed.resetPixelCacheStats();

        keyed.transform(labColour(0));
        expect(keyed.getPixelCacheStats().hits).toBe(1);

        keyed.clearPixelCache();
        keyed.resetPixelCacheStats();
        keyed.transform(labColour(0));
        expect(keyed.getPixelCacheStats().hits).toBe(0);
    });
});

describe('pixelCache — safety', () => {

    test('device: a caller mutating a result does not poison the cache', () => {
        const keyed = makeTransform('device', 32);
        const source = [0.55, 0.60, 0.40];

        const first = keyed.transform(source.slice());
        const expected = normalise(first);

        // Nothing runs after the cache for dataFormat 'device', so the hit
        // path hands back its own array unless it copies. Scribble on it.
        first[0] = 999;
        first[1] = -999;

        const second = keyed.transform(source.slice());
        expect(normalise(second)).toBe(expected);
        expect(keyed.getPixelCacheStats().hits).toBeGreaterThan(0);
    });

    test('off by default', () => {
        const transform = new Transform({ dataFormat: 'object', buildLut: false });
        transform.create('*Lab', '*sRGB', eIntent.relative);
        expect(transform.getPixelCacheStats().enabled).toBe(false);
    });

    test('declines when pipelineDebug is on, and still transforms correctly', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const debugged = new Transform({
            dataFormat: 'object', buildLut: false, pixelCache: 32, pipelineDebug: true,
            // Unrelated pre-existing issue: pipelineDebug on its own fails
            // validateOnCreate, with or without a pixel cache.
            validateOnCreate: false
        });
        debugged.create('*Lab', '*sRGB', eIntent.relative);
        warn.mockRestore();

        expect(debugged.getPixelCacheStats().enabled).toBe(false);

        const plain = makeTransform('object', 0);
        expect(normalise(debugged.transform(labColour(0))))
            .toBe(normalise(plain.transform(labColour(0))));
    });

    test('declines when custom stages are present — a hit could skip side effects', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const withCustom = new Transform({ dataFormat: 'object', buildLut: false, pixelCache: 32 });
        withCustom.create('*Lab', '*sRGB', eIntent.relative, [{
            location: 'afterPCS2Device',
            description: 'noop',
            stageFn: function (value) { return value; },
            stageData: null
        }]);
        warn.mockRestore();

        expect(withCustom.getPixelCacheStats().enabled).toBe(false);
    });

    test('real image: every output byte identical to uncached', () => {
        // The colour-level tests above cannot produce what a bug would need to
        // surface: evictions, hash collisions, and long hit/miss interleavings.
        // This runs a real photograph through and compares the whole buffer.
        // The exhaustive version (every content type, four transform shapes,
        // 250k pixels) is bench/pixel_cache/verify_cache.js.
        const fs = require('fs');
        const imagePath = path.join(__dirname, '..', 'samples', 'images', 'skin.png');
        if (!fs.existsSync(imagePath)) return;

        let rgba, width, height;
        try {
            const { createCanvas, loadImage } = require('canvas');
            // loadImage is async; the tests are sync, so use the sync decode
            // path via a data buffer instead of awaiting.
            const image = new (require('canvas').Image)();
            image.src = fs.readFileSync(imagePath);
            width = image.width;
            height = image.height;
            const canvas = createCanvas(width, height);
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            rgba = context.getImageData(0, 0, width, height).data;
        } catch (error) {
            return; // canvas unavailable in this environment — skip
        }

        const pixelCount = Math.min(width * height, 60000);
        const pixels = new Uint8ClampedArray(pixelCount * 3);
        for (let i = 0; i < pixelCount; i++) {
            pixels[i * 3]     = rgba[i * 4];
            pixels[i * 3 + 1] = rgba[i * 4 + 1];
            pixels[i * 3 + 2] = rgba[i * 4 + 2];
        }

        function run(cacheSlots) {
            const transform = new Transform({
                dataFormat: 'int8', buildLut: false, pixelCache: cacheSlots
            });
            transform.create('*sRGB', '*Lab', eIntent.relative);
            const output = transform.transformArray(pixels, false, false, false, pixelCount);
            return { output: output, stats: transform.getPixelCacheStats() };
        }

        const reference = run(0).output;
        for (const slots of [1, 32]) {
            const result = run(slots);
            expect(result.output.length).toBe(reference.length);
            // toEqual on 180k elements is slow; find the first difference.
            let firstMismatch = -1;
            for (let i = 0; i < reference.length; i++) {
                if (reference[i] !== result.output[i]) { firstMismatch = i; break; }
            }
            expect({ slots: slots, firstMismatch: firstMismatch })
                .toEqual({ slots: slots, firstMismatch: -1 });
            // and the cache genuinely engaged, so this isn't vacuously true
            expect(result.stats.hits).toBeGreaterThan(0);
        }
    });

    test('transformArray matches the uncached result and accumulates hits', () => {
        const plain = new Transform({ dataFormat: 'int8', buildLut: false });
        plain.create('*sRGB', '*Lab', eIntent.relative);
        const cached = new Transform({ dataFormat: 'int8', buildLut: false, pixelCache: 32 });
        cached.create('*sRGB', '*Lab', eIntent.relative);

        // three colours, ten pixels each, interleaved
        const pixels = new Uint8ClampedArray(TOTAL * 3);
        const sourceRGB = [[200, 30, 40], [10, 180, 90], [60, 70, 220]];
        for (let i = 0; i < TOTAL; i++) {
            const rgb = sourceRGB[i % sourceRGB.length];
            pixels[i * 3] = rgb[0]; pixels[i * 3 + 1] = rgb[1]; pixels[i * 3 + 2] = rgb[2];
        }

        cached.resetPixelCacheStats();
        const expected = plain.transformArray(pixels, false, false, false, TOTAL);
        const actual   = cached.transformArray(pixels, false, false, false, TOTAL);

        expect(Array.from(actual)).toEqual(Array.from(expected));
        expect(cached.getPixelCacheStats().hits).toBe(EXPECTED_HITS);
    });
});
