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

describe('pixelCache — profiling mode', () => {

    // Profiling skips the maths on a miss by jumping straight to the store
    // stage. The keys still come from the stages BEFORE the check, which all
    // still run, so hit accounting must be bit-identical to a real run — that
    // is the entire premise of the feature.
    function paletteRGB(count) {
        const palette = [
            [255, 255, 255], [0, 0, 0], [237, 28, 36], [0, 166, 81],
            [46, 49, 146], [255, 242, 0], [140, 98, 57], [190, 190, 190],
        ];
        const pixels = new Uint8ClampedArray(count * 3);
        let seed = 0x2468ace0;
        for (let i = 0; i < count; i++) {
            seed = (Math.imul(seed, 1103515245) + 12345) | 0;
            const colour = palette[(seed >>> 16) % palette.length];
            pixels[i * 3] = colour[0]; pixels[i * 3 + 1] = colour[1]; pixels[i * 3 + 2] = colour[2];
        }
        return pixels;
    }

    function rgbTransform(cacheSlots) {
        const transform = new Transform({ dataFormat: 'int8', buildLut: false, pixelCache: cacheSlots });
        transform.create('*sRGB', '*Lab', eIntent.relative);
        return transform;
    }

    const COUNT = 5000;

    test('hit accounting is identical to a real run', () => {
        const pixels = paletteRGB(COUNT);

        const normal = rgbTransform(32);
        normal.resetPixelCacheStats();
        normal.transformArray(pixels, false, false, false, COUNT);
        expect(normal.lastUsedKernel).toBe('cache');
        const normalStats = normal.getPixelCacheStats();

        const profiling = rgbTransform(32);
        expect(profiling.setPixelCacheProfiling(true)).toBe(true);
        profiling.transformArray(pixels, false, false, false, COUNT);
        const profilingStats = profiling.getPixelCacheStats();

        expect(profilingStats.profiling).toBe(true);
        expect(normalStats.profiling).toBe(false);
        expect(profilingStats.lookups).toBe(normalStats.lookups);
        expect(profilingStats.hits).toBe(normalStats.hits);
        expect(profilingStats.hits).toBeGreaterThan(0);
    });

    test('turning it off flushes the cache, so later output is never poisoned', () => {
        // While profiling, the cached "values" are whatever was in flight, not
        // converted colour. If the mode change did not flush, every subsequent
        // hit would silently return that garbage.
        const pixels = paletteRGB(COUNT);

        const plain = new Transform({ dataFormat: 'int8', buildLut: false });
        plain.create('*sRGB', '*Lab', eIntent.relative);
        const expected = plain.transformArray(pixels, false, false, false, COUNT);

        const transform = rgbTransform(32);
        transform.setPixelCacheProfiling(true);
        transform.transformArray(pixels, false, false, false, COUNT);   // fill with garbage
        transform.setPixelCacheProfiling(false);

        const actual = transform.transformArray(pixels, false, false, false, COUNT);

        let firstMismatch = -1;
        for (let i = 0; i < expected.length; i++) {
            if (expected[i] !== actual[i]) { firstMismatch = i; break; }
        }
        expect(firstMismatch).toBe(-1);
        expect(transform.getPixelCacheStats().hits).toBeGreaterThan(0);
    });

    test('is a no-op when no cache is configured', () => {
        const transform = new Transform({ dataFormat: 'int8', buildLut: false });
        transform.create('*sRGB', '*Lab', eIntent.relative);
        expect(transform.setPixelCacheProfiling(true)).toBe(false);
        expect(transform.getPixelCacheStats().enabled).toBe(false);
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

// ---------------------------------------------------------------------------
//  N-channel input — the regime where the cache changes character
// ---------------------------------------------------------------------------

describe('pixelCache — n-channel input', () => {

    // 5/6 now bake a LUT (Kernel5D / Kernel6D); 7–15 still decline and walk
    // the pipeline. These tests are CORRECTNESS at those widths: cached
    // output matches uncached. The in-kernel WASM inject for 5/6 is
    // `__tests__/pixel_cache_wasm_5d_6d.tests.js`.
    //
    // That moves the break-even. docs/deepdive/PixelCache.md records
    // photographs as break-even at best for RGB. Measured on 8-channel input,
    // 4096 slots:
    //
    //     content        distinct   off     on      gain   hit%
    //     noise             6000    0.79    0.94    1.20x   17%
    //     flat 256 colour    256    0.78    9.28   11.95x   96%
    //     flat 16 colour      16    0.79   17.60   22.29x  100%
    //
    // Even 17% reuse pays here, where the same rate is a 0.82x LOSS at five
    // channels. These tests are about CORRECTNESS at those widths, not speed.

    const fs = require('fs');
    const DIR = path.join(__dirname, 'profiles');
    const profile = {};
    for(const n of [1, 2, 3, 4, 5, 6, 8, 12, 15]){
        const p = new (require('../src/Profile'))();
        p.loadBinary(new Uint8Array(fs.readFileSync(
            path.join(DIR, 'synthetic_' + String(n).padStart(2, '0') + 'ch.icc'))));
        profile[n] = p;
    }

    /** Deterministic, and narrow enough that colours actually repeat. */
    function pixels(count, channels){
        const px = new Uint8ClampedArray(count * channels);
        let s = 7;
        for(let i = 0; i < px.length; i++){
            s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
            // HIGH bits: an LCG's low byte has a short period, which would make
            // this content quietly cache-friendly and the test meaningless.
            px[i] = (s >>> 16) & 0x3f;
        }
        return px;
    }

    const PAIRS = [];
    for(const inCh of [1, 2, 3, 5, 6, 8, 12, 15]){
        for(const outCh of [1, 3, 4, 8, 15]) PAIRS.push([inCh, outCh]);
    }

    test.each(PAIRS)('%i -> %i channels: cached output is identical to uncached', (inCh, outCh) => {
        const N = 32;
        const px = pixels(N, inCh);

        const plain = new Transform({ dataFormat: 'int8', buildLut: true });
        plain.create(profile[inCh], profile[outCh], eIntent.relative);
        const uncached = Array.from(plain.array(px, false, false, false, N));

        const cached = new Transform({ dataFormat: 'int8', buildLut: true, pixelCache: 256 });
        cached.create(profile[inCh], profile[outCh], eIntent.relative);
        const withCache = Array.from(cached.array(px, false, false, false, N));

        expect(withCache).toEqual(uncached);
        expect(withCache.length).toBe(N * outCh);
    });

    test('it actually engages on n-channel input, rather than quietly declining', () => {
        // The suite above would pass just as well if the cache switched itself
        // off everywhere, so this asserts it is really in the pipeline: feed
        // one colour repeatedly and every lookup after the first must hit.
        const N = 64;
        const inCh = 8;
        const px = new Uint8ClampedArray(N * inCh);
        for(let p = 0; p < N; p++){
            for(let c = 0; c < inCh; c++) px[p * inCh + c] = (c * 17) & 0xff;
        }

        const t = new Transform({ dataFormat: 'int8', buildLut: true, pixelCache: 64 });
        t.create(profile[inCh], profile[3], eIntent.relative);
        t.array(px, false, false, false, N);

        const stats = t.getPixelCacheStats();
        expect(stats.lookups).toBeGreaterThan(0);
        expect(stats.hits).toBe(stats.lookups - 1);      // only the first misses
    });

    test('int16 too — the depth that could not reach these widths at all', () => {
        const N = 32;
        const inCh = 12, outCh = 6;
        const px = new Uint16Array(N * inCh);
        const src = pixels(N, inCh);
        for(let i = 0; i < px.length; i++) px[i] = src[i] * 257;

        const plain = new Transform({ dataFormat: 'int16', buildLut: true });
        plain.create(profile[inCh], profile[outCh], eIntent.relative);
        const uncached = Array.from(plain.array(px, false, false, false, N));

        const cached = new Transform({ dataFormat: 'int16', buildLut: true, pixelCache: 256 });
        cached.create(profile[inCh], profile[outCh], eIntent.relative);
        const withCache = Array.from(cached.array(px, false, false, false, N));

        expect(withCache).toEqual(uncached);
    });

    test('declining is safe: an identity pair still converts correctly', () => {
        // Profile n into profile n collapses to identity, and the optimiser
        // replaces the output boundary the cache needs -- so it switches off.
        // The conversion must still be right, and it must not be a cache hit
        // pretending to be one.
        const N = 16, ch = 8;
        const px = pixels(N, ch);

        const t = new Transform({ dataFormat: 'int8', buildLut: true, pixelCache: 256 });
        t.create(profile[ch], profile[ch], eIntent.relative);
        const out = t.array(px, false, false, false, N);

        expect(Array.from(out)).toEqual(Array.from(px));   // identity copies
    });
});

// ---------------------------------------------------------------------------
//  'auto' — Transform ignores it; the kernel may change it to 1
// ---------------------------------------------------------------------------

describe('pixelCache — kernel decides auto', () => {

    const fs = require('fs');
    const Profile = require('../src/Profile');
    const DIR = path.join(__dirname, 'profiles');
    const profile = {};
    for(const n of [3, 5, 6]){
        const p = new Profile();
        p.loadBinary(new Uint8Array(fs.readFileSync(
            path.join(DIR, 'synthetic_' + String(n).padStart(2, '0') + 'ch.icc'))));
        profile[n] = p;
    }

    test('6CLR init promotes auto to 1 and the pipeline is injected', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create(profile[6], profile[3], eIntent.relative);
        expect(t.pixelCacheUsed).toBe(1);
        expect(t.kernelInfo().cache).toBe(1);
        const names = t.pipeline.map(s => s.stageName).join(' ');
        expect(names).toMatch(/stage_pixelCache_/);
    });

    test('5CLR does the same', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true, pixelCache: 'auto' });
        t.create(profile[5], profile[3], eIntent.relative);
        expect(t.pixelCacheUsed).toBe(1);
    });

    test('3CLR leaves auto alone — nothing injected on the pipeline', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: false });
        t.create('*sRGB', '*Lab', eIntent.relative);
        expect(t.pixelCache).toBe('auto');
        expect(t.pixelCacheUsed).toBe(0);
        const names = t.pipeline.map(s => s.stageName).join(' ');
        expect(names).not.toMatch(/stage_pixelCache_/);
        // Image path: WASM binds the single-entry export; JS fallback stays off.
        if(String(t.lutMode).indexOf('wasm') >= 0){
            expect(t.kernelInfo().cache).toBe(1);
        } else {
            expect(t.kernelInfo().cache).toBe('off');
        }
    });

    test('3CLR forced 1 still injects', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: false, pixelCache: 1 });
        t.create('*sRGB', '*Lab', eIntent.relative);
        expect(t.pixelCacheUsed).toBe(1);
        const names = t.pipeline.map(s => s.stageName).join(' ');
        expect(names).toMatch(/stage_pixelCache_/);
    });

    test('6CLR pixelCache: 0 stays off', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true, pixelCache: 0 });
        t.create(profile[6], profile[3], eIntent.relative);
        expect(t.pixelCacheUsed).toBe(0);
        expect(t.kernelInfo().cache).toBe('off');
        const names = t.pipeline.map(s => s.stageName).join(' ');
        expect(names).not.toMatch(/stage_pixelCache_/);
    });

    test('array() still uses the 6D kernel — auto does not steal the image path', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int' });
        t.create(profile[6], profile[3], eIntent.relative);
        expect(t.pixelCacheUsed).toBe(1);
        const px = new Uint8ClampedArray(16 * 6);
        t.array(px, false, false, false, 16);
        expect(t.lastUsedKernel).toBe('kernel6D');
    });
});

// ---------------------------------------------------------------------------
//  In-kernel WASM single-entry — create() binds interp_*_cached
// ---------------------------------------------------------------------------

describe('pixelCache — in-kernel WASM', () => {

    const haveWasm = typeof WebAssembly !== 'undefined' && !process.env.SKIP_WASM_TESTS;
    const describeIf = haveWasm ? describe : describe.skip;
    const Profile = require('../src/Profile');
    const fs = require('fs');
    const cmyk = new Profile();
    cmyk.loadFile(path.join(__dirname, 'GRACoL2006_Coated1v2.icc'));

    function maxAbs(a, b){
        let m = 0;
        for(let i = 0; i < a.length; i++){
            const d = Math.abs(a[i] - b[i]);
            if(d > m) m = d;
        }
        return m;
    }

    test('shipped tetra modules export the single-entry twin', () => {
        const bytes = require('../src/kernels/3d/tetra3d_simd.wasm.js');
        const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
        expect(typeof inst.exports.interp_tetra3d_simd).toBe('function');
        expect(typeof inst.exports.interp_tetra3d_simd_cached).toBe('function');
        expect(inst.exports.interp_tetra3d_simd_cached_8).toBeUndefined();
    });

    describeIf('create() wiring', () => {

        test('RGB→CMYK auto uses the cached export; 0 does not', () => {
            const on = new Transform({ dataFormat: 'int8', buildLut: true });
            on.create('*sRGB', cmyk, eIntent.relative);
            expect(String(on.lutMode).indexOf('wasm')).toBeGreaterThan(-1);
            expect(on.kernelInfo().cache).toBe(1);
            expect(on.pixelCacheUsed).toBe(0);

            const off = new Transform({ dataFormat: 'int8', buildLut: true, pixelCache: 0 });
            off.create('*sRGB', cmyk, eIntent.relative);
            expect(off.kernelInfo().cache).toBe('off');
        });

        test('array() cached vs uncached is bit-exact with preserveAlpha', () => {
            const on = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar' });
            on.create('*sRGB', '*AdobeRGB', eIntent.relative);
            const off = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar', pixelCache: 0 });
            off.create('*sRGB', '*AdobeRGB', eIntent.relative);
            if(String(on.lutMode).indexOf('wasm') < 0) return;

            const rgba = new Uint8ClampedArray(64 * 4);
            for(let i = 0; i < 64; i++){
                const same = (i & 3) !== 0;
                rgba[i * 4]     = same ? 40 : 200;
                rgba[i * 4 + 1] = 80;
                rgba[i * 4 + 2] = 120;
                rgba[i * 4 + 3] = (i * 7) & 255;
            }
            expect(maxAbs(on.array(rgba, true, true, true), off.array(rgba, true, true, true))).toBe(0);
        });

        test('array() cached vs uncached is bit-exact on solid and alternate', () => {
            const on = new Transform({ dataFormat: 'int8', buildLut: true });
            on.create('*sRGB', cmyk, eIntent.relative);
            const off = new Transform({ dataFormat: 'int8', buildLut: true, pixelCache: 0 });
            off.create('*sRGB', cmyk, eIntent.relative);
            if(String(on.lutMode).indexOf('wasm') < 0) return;

            const solid = new Uint8ClampedArray(64 * 3);
            for(let i = 0; i < solid.length; i += 3){
                solid[i] = 40; solid[i + 1] = 80; solid[i + 2] = 120;
            }
            const alt = new Uint8ClampedArray(64 * 3);
            for(let i = 0; i < alt.length; i += 3){
                const onPx = (i / 3) & 1;
                alt[i] = onPx ? 200 : 10;
                alt[i + 1] = onPx ? 20 : 180;
                alt[i + 2] = onPx ? 90 : 30;
            }
            expect(maxAbs(on.array(solid), off.array(solid))).toBe(0);
            expect(maxAbs(on.array(alt), off.array(alt))).toBe(0);
        });
    });
});
