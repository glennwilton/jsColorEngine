/**
 * __tests__/multicore.tests.js
 *
 * The multicore image path (`transformImages`).
 *
 * THE CENTRAL ASSERTION IS BYTE-IDENTITY. Parallel output must equal
 * sequential output exactly — not "within a tolerance", exactly — because the
 * workers run the same kernels on the same bytes and only the scheduling
 * differs. Anything less means slice boundaries or the reassembly offsets are
 * wrong, and a tolerance would hide it.
 *
 * The sequential fallback is therefore both the feature (multicore must be an
 * optimisation, never a capability) and the oracle.
 *
 * Channel counts are exercised deliberately: 3->4, 4->3 and 3->9 all have
 * different input and output strides, which is where reassembly arithmetic
 * goes wrong if input and output are conflated.
 */

const path = require('path');
const { Transform, Profile, eIntent } = require('../src/main.js');
const pool = require('../src/pool.js');

const GRACOL = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');
const PROFILE_NCLR = path.join(__dirname, '..', 'testbed', 'profiles', '6col',
    'Flag Direct Oct 05 360x720N 100L 270T CMmYKOrBlFy Full Spot STRAIGHT BLACK.icm');

const fs = require('fs');
const hasNclr = fs.existsSync(PROFILE_NCLR);

function makeImage(px, channels, seed){
    const a = new Uint8ClampedArray(px * channels);
    let s = seed >>> 0;
    for(let i = 0; i < a.length; i++){
        s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
        a[i] = (s >>> 23) & 0xff;                    // high bits: real spread
    }
    return { data: a, pixelCount: px };
}

function gracol(){
    const p = new Profile();
    p.loadFile(GRACOL);
    return p;
}

afterAll(() => { pool.destroyAll(); });

describe('multicore — planner (pure, synchronous)', () => {

    const opts = pool.DEFAULTS;

    test('capacity binds on large images', () => {
        const len = pool.sliceLengthFor(20e6, 8, opts);
        expect(len).toBeLessThanOrEqual(opts.bufferPx);
        expect(Math.ceil(20e6 / len)).toBeGreaterThanOrEqual(8 * 9);
    });

    test('the pool binds in the middle — a small image still spreads across every worker', () => {
        // The failure this guards: cutting only at buffer boundaries would give
        // a 2 MP image 8 tasks on 8 workers, the worst measured configuration.
        const len = pool.sliceLengthFor(2097152, 8, opts);
        const tasks = Math.ceil(2097152 / len);
        expect(tasks).toBeGreaterThanOrEqual(8 * 8);
        expect(len).toBeLessThan(opts.bufferPx);
    });

    test('the floor binds on small images so per-task overhead stays bounded', () => {
        expect(pool.sliceLengthFor(200000, 8, opts)).toBe(opts.minSlicePx);
    });

    test('never emits a slice larger than buffer capacity', () => {
        for(const px of [1e5, 1e6, 8e6, 5e7]){
            expect(pool.sliceLengthFor(px, 4, opts)).toBeLessThanOrEqual(opts.bufferPx);
        }
    });

    test('planBatch covers every pixel exactly once, in order, per image', () => {
        const images = [{pixelCount: 1000000}, {pixelCount: 250000}, {pixelCount: 3}];
        const tasks = pool.planBatch(images, 4, opts);

        images.forEach((img, i) => {
            const mine = tasks.filter(t => t.imageIndex === i)
                              .sort((a, b) => a.start - b.start);
            expect(mine[0].start).toBe(0);
            let cursor = 0;
            for(const t of mine){
                expect(t.start).toBe(cursor);       // no gaps, no overlaps
                expect(t.length).toBeGreaterThan(0);
                cursor += t.length;
            }
            expect(cursor).toBe(img.pixelCount);    // exact coverage
        });
    });

    test('planBatch sorts longest-first so a long task cannot land last', () => {
        const tasks = pool.planBatch([{pixelCount: 50000}, {pixelCount: 4000000}], 4, opts);
        for(let i = 1; i < tasks.length; i++){
            expect(tasks[i - 1].length).toBeGreaterThanOrEqual(tasks[i].length);
        }
    });

    test('a tiny image yields one task rather than zero', () => {
        const tasks = pool.planBatch([{pixelCount: 3}], 8, opts);
        expect(tasks).toHaveLength(1);
        expect(tasks[0].length).toBe(3);
    });

    test('idealWorkers respects auto/max/explicit and never returns zero', () => {
        expect(pool.idealWorkers(1)).toBe(1);
        expect(pool.idealWorkers('auto')).toBeGreaterThanOrEqual(1);
        expect(pool.idealWorkers('max')).toBeGreaterThanOrEqual(pool.idealWorkers('auto'));
    });
});

describe('multicore — sequential fallback is always available', () => {

    test('multicore disabled returns correct pixels and reports workersUsed 0', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);

        const img = makeImage(20000, 3, 0x1234);
        const res = await t.transformImages([img], {multicore: false});

        expect(res.workersUsed).toBe(0);
        expect(res.images).toHaveLength(1);
        expect(res.images[0]).toEqual(t.transformArray(img.data, false, false, false, img.pixelCount));
    });

    test('work below the parallel floor stays on the calling thread', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);

        // Under parallelFloorPx: a pool would cost more than it saves.
        const img = makeImage(1000, 3, 0x99);
        const res = await t.transformImages([img], {multicore: true});
        expect(res.workersUsed).toBe(0);
    });

    test('an empty batch is not an error', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        await expect(t.transformImages([])).resolves.toEqual({images: [], workersUsed: 0, tasks: 0});
    });
});

describe('multicore — parallel output is byte-identical to sequential', () => {

    jest.setTimeout(120000);

    async function assertIdentical(t, images, opts){
        const expected = images.map(img =>
            t.transformArray(img.data, false, false, false, img.pixelCount));

        const res = await t.transformImages(images, Object.assign({multicore: true}, opts || {}));

        expect(res.images).toHaveLength(images.length);
        res.images.forEach((got, i) => {
            expect(got.length).toBe(expected[i].length);
            // Compare as plain arrays so a mismatch reports the differing index
            // rather than "objects differ".
            expect(Array.from(got)).toEqual(Array.from(expected[i]));
        });
        return res;
    }

    test('RGB -> CMYK (3 in, 4 out) across many slices', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        const res = await assertIdentical(t, [makeImage(300000, 3, 0xABCD)]);
        expect(res.tasks).toBeGreaterThan(1);      // it really did split
    });

    test('CMYK -> RGB (4 in, 3 out) — output stride differs from input', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create(gracol(), '*sRGB', eIntent.relative);
        await assertIdentical(t, [makeImage(300000, 4, 0x5EED)]);
    });

    test('a mixed batch of sizes shares one queue', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        const res = await assertIdentical(t, [
            makeImage(150000, 3, 1), makeImage(40000, 3, 2),
            makeImage(400000, 3, 3), makeImage(9000, 3, 4)
        ]);
        expect(res.images).toHaveLength(4);
    });

    test('an image whose length is not a multiple of the slice size', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        // Deliberately ragged: the last task is a small remainder.
        await assertIdentical(t, [makeImage(100003, 3, 0x7777)]);
    });

    test('multi-step chain: RGB -> CMYK -> RGB soft proof', async () => {
        // Three profiles, a five-slot chain, and the CMYK intermediate exists
        // only inside the LUT. A worker never sees the chain at all — the bake
        // has already collapsed it to a 3->3 table — so multi-step needs no
        // special handling in Mode 1. Asserted because it is the case most
        // likely to be assumed broken.
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.createMultiStage(['*sRGB', eIntent.relative, gracol(), eIntent.relative, '*sRGB']);

        const res = await assertIdentical(t, [makeImage(300000, 3, 0xC0FFEE)]);
        expect(res.workersUsed).toBeGreaterThan(0);
        expect(t.inputChannels).toBe(3);
        expect(t.outputChannels).toBe(3);
    });

    test('WASM SIMD kernel matches its own sequential output', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd'});
        t.create('*sRGB', gracol(), eIntent.relative);
        await assertIdentical(t, [makeImage(250000, 3, 0xFEED)]);
    });

    (hasNclr ? test : test.skip)('N-channel output stays correct by falling back, not by guessing', async () => {
        // Not every Transform can be rebuilt from its LUT alone. N-channel
        // output walks the pipeline, and a LUT-only rebuild diverges badly —
        // 27,204 wrong bytes in 35,000, max delta 254. The probe catches that
        // and the work runs sequentially instead.
        //
        // This asserts BOTH halves: the output is right, and it is right
        // because it declined to parallelise rather than because it got lucky.
        const p = new Profile();
        p.loadFile(PROFILE_NCLR);
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', p, eIntent.relative);
        expect(t.outputChannels).toBeGreaterThan(4);

        const img = makeImage(120000, 3, 0x2468);
        const res = await assertIdentical(t, [img]);

        expect(res.workersUsed).toBe(0);                 // declined, deliberately
        expect(res.images[0].length).toBe(img.pixelCount * t.outputChannels);
    });

    (hasNclr ? test : test.skip)('probing does not corrupt the Transform it probes', async () => {
        // setLut() mutates the LUT it is handed — it decodes the CLUT in place.
        // An earlier version of the probe passed the live LUT and silently
        // corrupted the source Transform, so every later conversion with it
        // was wrong. Converting after a probe must still be correct.
        const p = new Profile();
        p.loadFile(PROFILE_NCLR);
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', p, eIntent.relative);

        const img = makeImage(5000, 3, 0x1111);
        const before = t.transformArray(img.data, false, false, false, img.pixelCount);

        await t.transformImages([img], {multicore: true});   // triggers the probe

        const after = t.transformArray(img.data, false, false, false, img.pixelCount);
        expect(Array.from(after)).toEqual(Array.from(before));
    });
});

describe('multicore — pool lifecycle', () => {

    jest.setTimeout(120000);

    test('the pool is shared: a second Transform reuses it rather than spawning more', async () => {
        pool.destroyAll();

        const a = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        a.create('*sRGB', gracol(), eIntent.relative);
        const b = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        b.create(gracol(), '*sRGB', eIntent.relative);

        await a.transformImages([makeImage(200000, 3, 11)], {multicore: true});
        const after1 = Object.keys(pool._pools).length;
        await b.transformImages([makeImage(200000, 4, 12)], {multicore: true});
        const after2 = Object.keys(pool._pools).length;

        // Same (workers, lutMode) -> one pool, two LUTs registered in it.
        expect(after1).toBe(1);
        expect(after2).toBe(1);
        pool.destroyAll();
    });

    test('releaseWorkers tears the pool down', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        await t.transformImages([makeImage(200000, 3, 21)], {multicore: true});
        expect(Object.keys(pool._pools).length).toBeGreaterThan(0);

        t.releaseWorkers();
        expect(Object.keys(pool._pools).length).toBe(0);
    });

    test('cores:1 falls below minThreads and runs sequentially', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        const res = await t.transformImages([makeImage(300000, 3, 31)], {multicore: {cores: 1}});
        expect(res.workersUsed).toBe(0);
    });
});

describe('getOptions', () => {

    test('returns RESOLVED options, not what was passed in', () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'auto'});
        t.create('*sRGB', gracol(), eIntent.relative);

        const o = t.getOptions();
        expect(o.lutModeRequested).toBe('auto');
        expect(o.lutMode).not.toBe('auto');          // resolved to a real kernel
        expect(o.dataFormat).toBe('int8');
        expect(o.buildLut).toBe(true);
    });

    test('flags function-valued options, which are what cannot cross a worker boundary', () => {
        const plain = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        plain.create('*sRGB', gracol(), eIntent.relative);
        expect(plain.getOptions().functions).toEqual([]);

        const hooked = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int',
            lutInputHook: (c) => c});
        hooked.create('*sRGB', gracol(), eIntent.relative);
        expect(hooked.getOptions().functions).toContain('lutInputHook');
    });

    test('the returned options are structured-cloneable when nothing is a function', () => {
        // This is the property the multicore path depends on: options with no
        // functions can be handed to a worker, options with them cannot.
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        expect(() => structuredClone(t.getOptions())).not.toThrow();
    });
});
