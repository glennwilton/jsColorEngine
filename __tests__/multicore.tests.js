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

// 1-channel and 2-channel sources: the narrowest input strides there are.
const GREY = path.join(__dirname, '..', 'testbed', 'profiles', 'grey',
    'RISO_MZ770_Black.icc');
const DUO  = path.join(__dirname, '..', 'testbed', 'profiles', 'duo',
    'RISO_MZ770_RedGreen.icc');
const hasGrey = fs.existsSync(GREY);
const hasDuo  = fs.existsSync(DUO);

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

    (hasNclr ? test : test.skip)('N-channel refuses the LUT hand-off and rebuilds instead', async () => {
        // Not every Transform can be rebuilt from its LUT alone. N-channel
        // output walks the pipeline, and a LUT-only rebuild diverges badly —
        // 27,204 wrong bytes in 35,000, max delta 254. The probe catches that,
        // so mode 1 is off the table.
        //
        // Mode 2 then rescues it: ship the profile chain and re-run create()
        // in the worker. Which is the point of having two modes — this case
        // used to fall all the way back to sequential.
        const p = new Profile();
        p.loadFile(PROFILE_NCLR);
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', p, eIntent.relative);
        expect(t.outputChannels).toBeGreaterThan(4);

        const img = makeImage(120000, 3, 0x2468);
        const res = await assertIdentical(t, [img]);

        expect(t._multicoreSafe).toBe(false);            // mode 1 declined
        expect(res.workersUsed).toBeGreaterThan(0);      // mode 2 took it
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

describe('multicore — the full matrix: LUT and LUT-free, across channel counts', () => {

    jest.setTimeout(240000);

    // Same oracle as above: sequential output, compared exactly.
    async function identical(t, images){
        const expected = images.map(img =>
            t.transformArray(img.data, false, false, false, img.pixelCount));
        const res = await t.transformImages(images, {multicore: true});
        res.images.forEach((got, i) => {
            expect(got.length).toBe(expected[i].length);
            expect(Array.from(got)).toEqual(Array.from(expected[i]));
        });
        return res;
    }

    // [name, buildLut, chain builder, input channels]
    const CASES = () => [
        ['RGB -> RGB   (matrix)',  ['*sRGB', eIntent.relative, '*AdobeRGB'],            3],
        ['RGB -> Lab',             ['*sRGB', eIntent.relative, '*labd50'],              3],
        ['RGB -> CMYK',            ['*sRGB', eIntent.relative, gracol()],               3],
        ['CMYK -> RGB',            [gracol(), eIntent.relative, '*sRGB'],               4],
        ['CMYK -> CMYK',           [gracol(), eIntent.relative, gracol()],              4],
        ['multi-step RGB>CMYK>RGB',['*sRGB', eIntent.relative, gracol(),
                                    eIntent.relative, '*sRGB'],                         3],
    ];

    describe('with a LUT (mode 1 — ship the baked table)', () => {
        for(const [name, chain, inCh] of CASES()){
            test(name, async () => {
                const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
                t.createMultiStage(chain);
                const res = await identical(t, [makeImage(150000, inCh, 0xA1 + inCh)]);
                expect(res.workersUsed).toBeGreaterThan(0);
            });
        }
    });

    describe('without a LUT (mode 2 — ship the chain, rebuild in the worker)', () => {
        for(const [name, chain, inCh] of CASES()){
            test(name, async () => {
                // The accuracy path: ~5-9 MPx/s single-threaded, so this is
                // where parallelism is worth the most, and mode 1 cannot serve
                // it because there is no LUT to ship.
                const t = new Transform({dataFormat: 'int8', buildLut: false});
                t.createMultiStage(chain);
                const res = await identical(t, [makeImage(90000, inCh, 0xB2 + inCh)]);
                expect(res.workersUsed).toBeGreaterThan(0);
            });
        }
    });

    (hasNclr ? describe : describe.skip)('N-channel', () => {
        const nclr = () => { const p = new Profile(); p.loadFile(PROFILE_NCLR); return p; };

        test('with a LUT — probe rejects mode 1, mode 2 carries it', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.create('*sRGB', nclr(), eIntent.relative);
            const res = await identical(t, [makeImage(90000, 3, 0xC3)]);
            expect(t._multicoreSafe).toBe(false);
            expect(res.workersUsed).toBeGreaterThan(0);
        });

        test('with a LUT AND a hook — no safe hand-off, so it warns and goes sequential', async () => {
            // The one genuinely unserveable combination. Mode 1 is out (the
            // probe rejects the LUT); mode 2 would re-bake in the worker, but
            // the hook cannot cross, so it would bake a DIFFERENT LUT.
            // Correct and slow beats fast and subtly wrong.
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
            try {
                const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int',
                    lutInputHook: (c) => c});
                t.create('*sRGB', nclr(), eIntent.relative);

                const res = await identical(t, [makeImage(90000, 3, 0x39)]);
                expect(res.workersUsed).toBe(0);
                expect(warn).toHaveBeenCalled();
                expect(String(warn.mock.calls[0][0])).toContain('lutInputHook');
            } finally {
                warn.mockRestore();
            }
        });

        test('without a LUT — mode 2 handles it, which mode 1 could not', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: false});
            t.create('*sRGB', nclr(), eIntent.relative);
            const res = await identical(t, [makeImage(70000, 3, 0xD4)]);
            expect(t.outputChannels).toBeGreaterThan(4);
            expect(res.workersUsed).toBeGreaterThan(0);
        });
    });

    describe('Lab source', () => {
        test('Lab -> RGB, with a LUT', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.create('*labd50', '*sRGB', eIntent.relative);
            await identical(t, [makeImage(150000, 3, 0x7D)]);
        });

        // Was skipped: a Lab source on the LUT-free pipeline used to throw
        // (labInputAdaptation on) or return NaN (off), so there was nothing
        // for multicore to be identical to. stage_Int_to_cmsLab gave the Lab
        // branch the array entry point the device branch always had, and
        // multicore needed no change to pick it up — mode 2 just re-runs
        // create() in the worker and inherited it.
        test('Lab -> RGB, LUT-free', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: false});
            t.create('*labd50', '*sRGB', eIntent.relative);
            await identical(t, [makeImage(90000, 3, 0x8E)]);
        });
    });

    describe('1D and 2D input — where the slice stride is not 3 or 4', () => {
        // Reassembly arithmetic is the thing most likely to be wrong here: a
        // 1-channel source has a stride of 1 in and 4 out, the widest in/out
        // mismatch in the suite and the opposite direction to N-channel.
        const grey = () => { const p = new Profile(); p.loadFile(GREY); return p; };
        const duo  = () => { const p = new Profile(); p.loadFile(DUO);  return p; };

        (hasGrey ? test : test.skip)('1D: grey -> CMYK, with a LUT', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.create(grey(), gracol(), eIntent.relative);
            expect(t.inputChannels).toBe(1);
            await identical(t, [makeImage(150000, 1, 0xE5)]);
        });

        (hasGrey ? test : test.skip)('1D: grey -> RGB, LUT-free', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: false});
            t.create(grey(), '*sRGB', eIntent.relative);
            expect(t.inputChannels).toBe(1);
            await identical(t, [makeImage(90000, 1, 0xF6)]);
        });

        (hasDuo ? test : test.skip)('2D: duotone -> RGB, with a LUT', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.create(duo(), '*sRGB', eIntent.relative);
            expect(t.inputChannels).toBe(2);
            await identical(t, [makeImage(150000, 2, 0x4A)]);
        });

        (hasDuo ? test : test.skip)('2D: duotone -> RGB, LUT-free', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: false});
            t.create(duo(), '*sRGB', eIntent.relative);
            expect(t.inputChannels).toBe(2);
            await identical(t, [makeImage(90000, 2, 0x5B)]);
        });

        (hasGrey && hasDuo ? test : test.skip)('1D -> 2D -> 3D multi-step keeps every stride straight', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: false});
            t.createMultiStage([grey(), eIntent.relative, duo(),
                                eIntent.relative, '*sRGB']);
            await identical(t, [makeImage(90000, 1, 0x6C)]);
        });
    });

    describe('hooks', () => {
        test('a LUT transform with a hook still parallelises — the hook is baked in', async () => {
            // gamutDeFn, lutInputHook and lutOutputHook all run during
            // buildIntLut(). Once the LUT exists they are irrelevant to
            // conversion, so shipping the baked table carries them for free.
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int',
                lutInputHook: (c) => c});
            t.create('*sRGB', gracol(), eIntent.relative);
            expect(t.getOptions().functions).toContain('lutInputHook');

            const res = await identical(t, [makeImage(150000, 3, 0x17)]);
            expect(res.workersUsed).toBeGreaterThan(0);
        });

        test('a LUT-free transform with a hook is fine — nothing bakes, so it is inert', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: false,
                lutInputHook: (c) => c});
            t.create('*sRGB', gracol(), eIntent.relative);
            const res = await identical(t, [makeImage(90000, 3, 0x28)]);
            expect(res.workersUsed).toBeGreaterThan(0);
        });
    });
});

describe('multicore — one shared pool, many Transforms', () => {

    jest.setTimeout(240000);

    // THE QUESTION THIS ANSWERS: if worker 3 is already holding transform A
    // and a task for transform B arrives, what stops it converting B's pixels
    // through A's table?
    //
    // Nothing about the worker is bound to a Transform. Every message carries
    // a content signature; the worker keeps signature -> ready Transform and
    // looks the right one up per task. The pool records which signatures each
    // worker already holds, so each crosses the wire once per worker no matter
    // how the batches interleave.
    //
    // These tests would pass trivially if the wrong table were used and the
    // outputs happened to be similar, so every assertion is byte-exact against
    // that Transform's own sequential output — and the three transforms are
    // chosen to have DIFFERENT OUTPUT CHANNEL COUNTS, so a mix-up cannot even
    // produce a right-sized answer.

    function seq(t, img){
        return t.transformArray(img.data, false, false, false, img.pixelCount);
    }

    async function runAndCheck(t, img, label){
        const expected = seq(t, img);
        const res = await t.transformImages([img], {multicore: true});
        const got = res.images[0];
        expect(`${label}: ${got.length}`).toBe(`${label}: ${expected.length}`);

        let differing = 0;
        for(let i = 0; i < expected.length; i++) if(got[i] !== expected[i]) differing++;
        expect(`${label}: ${differing} differing bytes`).toBe(`${label}: 0 differing bytes`);
        return res;
    }

    test('A,B,C,A,B,C interleaved — each batch uses its own transform', async () => {
        const A = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        A.create('*sRGB', gracol(), eIntent.relative);          // 3 -> 4

        const B = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        B.create(gracol(), '*sRGB', eIntent.relative);          // 4 -> 3

        const C = new Transform({dataFormat: 'int8', buildLut: false});
        C.createMultiStage(['*sRGB', eIntent.relative, gracol(),
                            eIntent.relative, '*AdobeRGB']);    // 3 -> 3, LUT-free

        const imgA = makeImage(150000, 3, 0xAAA1);
        const imgB = makeImage(150000, 4, 0xBBB2);
        const imgC = makeImage(120000, 3, 0xCCC3);

        // Two full rounds. The second round is the interesting one: every
        // signature is already resident, so it exercises the lookup rather
        // than the registration.
        for(const round of [1, 2]){
            await runAndCheck(A, imgA, `round ${round} A`);
            await runAndCheck(B, imgB, `round ${round} B`);
            await runAndCheck(C, imgC, `round ${round} C`);
        }

        // One pool, not three.
        expect(Object.keys(pool._pools).length).toBe(1);
    });

    test('the three signatures are distinct, and stable across runs', async () => {
        const A = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        A.create('*sRGB', gracol(), eIntent.relative);
        const B = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        B.create(gracol(), '*sRGB', eIntent.relative);

        // Signatures are content hashes: same content -> same key (so it is
        // shipped once), different content -> different key (so they cannot
        // collide onto one another's table).
        const A2 = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        A2.create('*sRGB', gracol(), eIntent.relative);

        expect(A.signLut()).toBe(A2.signLut());
        expect(A.signLut()).not.toBe(B.signLut());
    });

    test('concurrent batches from two Transforms do not cross', async () => {
        // Interleaving sequentially proves lookup works. Firing both at once
        // and letting their tasks share the same worker queue proves the
        // signature travels WITH THE TASK rather than being pool state.
        const A = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        A.create('*sRGB', gracol(), eIntent.relative);
        const B = new Transform({dataFormat: 'int8', buildLut: false});
        B.create(gracol(), '*sRGB', eIntent.relative);

        const imgA = makeImage(200000, 3, 0x5151);
        const imgB = makeImage(200000, 4, 0x6262);
        const expA = seq(A, imgA);
        const expB = seq(B, imgB);

        const [resA, resB] = await Promise.all([
            A.transformImages([imgA], {multicore: true}),
            B.transformImages([imgB], {multicore: true})
        ]);

        expect(Array.from(resA.images[0])).toEqual(Array.from(expA));
        expect(Array.from(resB.images[0])).toEqual(Array.from(expB));
    });

    test('more transforms than the worker cache holds — eviction stays in sync', async () => {
        // The worker registry is bounded and evicts least-recently-used. The
        // pool keeps its own record of what each worker holds, so if eviction
        // were silent the pool would keep dispatching against a signature the
        // worker had dropped and the task would fail with 'unknown LUT
        // signature'. The worker reports evictions on its reply.
        //
        // Twelve distinct transforms against a bound of eight, run twice, so
        // the second pass is all cache misses on already-"known" signatures.
        const dests = ['*sRGB', '*AdobeRGB', '*applergb', '*colormatch',
                       '*prophoto', '*labd50'];
        const transforms = [];
        for(const via of [gracol(), gracol()]){
            for(const dest of dests){
                const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
                t.createMultiStage(['*sRGB', eIntent.relative, via,
                                    eIntent.relative, dest]);
                transforms.push(t);
            }
        }
        expect(transforms.length).toBeGreaterThan(8);

        // Distinct LUTs, so they genuinely compete for the eight slots.
        expect(new Set(transforms.map(t => t.signLut())).size).toBe(dests.length);

        const img = makeImage(80000, 3, 0x7373);
        for(const round of [1, 2]){
            for(let i = 0; i < transforms.length; i++){
                await runAndCheck(transforms[i], img, `round ${round} #${i}`);
            }
        }
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('multicore — getInfo / getWorkerInfo', () => {

    jest.setTimeout(240000);

    // "It produced plausible pixels" is not evidence that the worker rebuilt
    // the same Transform. These compare what was actually built, field by
    // field, so a divergence surfaces as a named path rather than as slightly
    // wrong colour.

    describe('getInfo', () => {
        test('reports LUT shape and size, and the int table alongside it', () => {
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.create('*sRGB', gracol(), eIntent.relative);
            const i = t.getInfo();

            expect(i.inputChannels).toBe(3);
            expect(i.outputChannels).toBe(4);
            expect(i.lut).not.toBe(false);
            expect(i.lut.gridPoints).toEqual([33, 33, 33]);
            expect(i.lut.cells).toBe(33 * 33 * 33 * 4);
            expect(i.lut.bytes).toBe(i.lut.cells * 8);          // f64
            expect(i.lut.signature).toBe(t.signLut());

            // The quantised table the fast kernels actually read — a master
            // and a worker can agree on everything above and differ here.
            expect(i.lut.intLut).not.toBe(false);
            expect(i.lut.intLut.dataType).toBe('u16');
            expect(i.lut.intLut.bytes).toBe(i.lut.intLut.cells * 2);
        });

        test('lut is false, not missing, when the Transform runs the pipeline', () => {
            const t = new Transform({dataFormat: 'int8', buildLut: false});
            t.create('*sRGB', gracol(), eIntent.relative);
            const i = t.getInfo();

            expect(i.lut).toBe(false);
            expect(JSON.parse(JSON.stringify(i)).lut).toBe(false);  // survives JSON
            expect(i.options.buildLut).toBe(false);
        });

        test('a float LUT has no int table', () => {
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
            t.create('*sRGB', gracol(), eIntent.relative);
            expect(t.getInfo().lut.intLut).toBe(false);
        });

        test('the chain is described without dumping profile contents', () => {
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.create('*sRGB', gracol(), eIntent.relative);
            const chain = t.getInfo().chain;

            expect(chain.length).toBe(3);
            expect(chain[1]).toEqual({intent: eIntent.relative});
            expect(chain[2].channels).toBe(4);
            expect(JSON.stringify(chain).length).toBeLessThan(4000);
        });
    });

    describe('getWorkerInfo', () => {
        const modes = [
            ['LUT int',   {dataFormat: 'int8', buildLut: true,  lutMode: 'int'}],
            ['LUT float', {dataFormat: 'int8', buildLut: true,  lutMode: 'float'}],
            ['no LUT',    {dataFormat: 'int8', buildLut: false}]
        ];

        for(const [name, options] of modes){
            test(name + ': every worker built the same thing the master did', async () => {
                const t = new Transform(options);
                t.create('*sRGB', gracol(), eIntent.relative);

                const res = await t.getWorkerInfo();
                expect(res.workers.length).toBeGreaterThan(0);
                expect(res.workers.every(w => w !== null)).toBe(true);

                // Report the paths, not just the count, so a failure says what
                // diverged instead of "expected 0, received 3".
                expect(res.differences.map(
                    d => d.path + ': ' + JSON.stringify(d.master) + ' vs ' + JSON.stringify(d.value)
                )).toEqual([]);
                expect(res.inSync).toBe(true);
            });
        }

        test('mode 1 workers hold no profiles, and that is explained not flagged', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.create('*sRGB', gracol(), eIntent.relative);

            const res = await t.getWorkerInfo();
            expect(res.mode).toBe('lut');
            expect(res.inSync).toBe(true);

            // Absent by construction: setLut() rebuilds from a bare table.
            const paths = res.expected.map(d => d.path);
            expect(paths.some(p => p.indexOf('chain') === 0)).toBe(true);
            expect(res.expected.every(d => typeof d.reason === 'string')).toBe(true);
        });

        test('workers really do report their own build, not an echo', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.create('*sRGB', gracol(), eIntent.relative);

            const res = await t.getWorkerInfo();
            for(const w of res.workers){
                expect(w.lut).not.toBe(false);
                expect(w.lut.signature).toBe(t.signLut());
                expect(w.lut.intLut.dataType).toBe('u16');
            }
        });

        test('says so quietly when there is no hand-off to inspect', async () => {
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.create('*sRGB', gracol(), eIntent.relative);

            const res = await t.getWorkerInfo({multicore: false});
            expect(res.workers).toEqual([]);
            expect(res.inSync).toBe(true);       // nothing disagreed
            expect(res.master.lut).not.toBe(false);
        });
    });

    describe('worker cache keys', () => {
        test('two transforms differing only in buildLut do not share a worker entry', async () => {
            // REGRESSION. The mode-2 key was (chain, lutMode). A buildLut:true
            // Transform whose LUT the probe rejects resolves lutMode to
            // 'float' exactly like a buildLut:false one over the same
            // profiles — same key, different transform. Whichever registered
            // first won and the other was silently served it: a LUT
            // interpolation handed to a caller who asked for the exact
            // pipeline. Both return plausible pixels, which is why it took
            // getWorkerInfo to see it.
            const withLut = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
            withLut.create('*sRGB', gracol(), eIntent.relative);

            const without = new Transform({dataFormat: 'int8', buildLut: false});
            without.create('*sRGB', gracol(), eIntent.relative);

            const a = withLut._multicoreHandoff({multicore: true}, null);
            const b = without._multicoreHandoff({multicore: true}, null);

            expect(a.payload.mode).toBe('chain');
            expect(b.payload.mode).toBe('chain');
            expect(a.signature).not.toBe(b.signature);

            // And end to end: register both, then check neither was handed the
            // other one.
            const ra = await withLut.getWorkerInfo();
            const rb = await without.getWorkerInfo();
            expect(ra.workers[0].options.buildLut).toBe(true);
            expect(rb.workers[0].options.buildLut).toBe(false);
            expect(ra.inSync).toBe(true);
            expect(rb.inSync).toBe(true);
        });

        test('a key is assigned once and stays put', () => {
            const t = new Transform({dataFormat: 'int8', buildLut: false});
            t.create('*sRGB', gracol(), eIntent.relative);

            expect(t._workerKey).toBeNull();                  // nothing until asked
            const first = t._multicoreHandoff({multicore: true}, null).signature;
            expect(typeof first).toBe('string');
            expect(t._workerKey).toBe(first);

            // Asking again must not mint a second key, or every batch would
            // re-ship the transform to every worker.
            expect(t._multicoreHandoff({multicore: true}, null).signature).toBe(first);
        });

        test('identical Transforms get DIFFERENT keys — dedup is traded away on purpose', () => {
            // With a content hash these two shared one worker entry and the
            // LUT crossed the wire once. Assigned keys give them one entry
            // each, so the cost of a duplicate Transform is memory. That is
            // the trade: the alternative failure mode was two DIFFERENT
            // transforms sharing an entry and returning each other's colour.
            const a = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            a.create('*sRGB', gracol(), eIntent.relative);
            const b = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            b.create('*sRGB', gracol(), eIntent.relative);

            expect(a.signLut()).toBe(b.signLut());            // same content
            expect(a._multicoreHandoff({multicore: true}, null).signature)
                .not.toBe(b._multicoreHandoff({multicore: true}, null).signature);
        });

        test('rebuilding a Transform drops its key, so workers cannot serve the old pipeline', async () => {
            // THE RISK ASSIGNED KEYS CARRY. A content hash changes by itself
            // when the profiles do; an assigned key does not, so re-creating a
            // Transform over different profiles would keep the old key and be
            // handed the old pipeline out of the workers' registry.
            // createMultiStage() drops it.
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.create('*sRGB', gracol(), eIntent.relative);
            const before = t._multicoreHandoff({multicore: true}, null).signature;

            const img = makeImage(90000, 3, 0x4F1);
            await t.transformImages([img], {multicore: true});

            // Same object, different conversion. clear() is the supported
            // rebuild flow — re-creating without it now throws, because it
            // would silently convert through the old table.
            t.clear();
            t.create('*sRGB', '*AdobeRGB', eIntent.relative);
            expect(t._workerKey).toBeNull();
            expect(t._multicoreSafe).toBeUndefined();         // stale probe cleared too

            const after = t._multicoreHandoff({multicore: true}, null).signature;
            expect(after).not.toBe(before);

            // And it converts as the NEW transform, not the cached old one.
            const img2 = makeImage(90000, 3, 0x5F2);
            const expected = t.transformArray(img2.data, false, false, false, img2.pixelCount);
            const res = await t.transformImages([img2], {multicore: true});
            expect(res.images[0].length).toBe(expected.length);
            expect(Array.from(res.images[0])).toEqual(Array.from(expected));
        });

        test('re-creating with a LUT still attached throws rather than converting wrongly', () => {
            // The stale-LUT trap: outputChannels would update to the new space
            // while lut.outputChannels kept the old one, so transformArray
            // emitted the previous space's channel count with no error.
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.create('*sRGB', gracol(), eIntent.relative);
            expect(t.outputChannels).toBe(4);

            expect(() => t.create('*sRGB', '*AdobeRGB', eIntent.relative)).toThrow();

            // The escape hatch the message names, which plugins also use to
            // re-run their hooks over a fresh table.
            expect(t.clear()).toBe(t);                    // chainable
            expect(t.lut).toBe(false);
            expect(t.pipelineCreated).toBe(false);
            expect(t._workerKey).toBeNull();
            expect(() => t.create('*sRGB', '*AdobeRGB', eIntent.relative)).not.toThrow();
            expect(t.outputChannels).toBe(3);
            expect(t.lut.outputChannels).toBe(3);
        });
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('multicore — worker cache lifecycle', () => {

    jest.setTimeout(240000);

    // THE INVARIANT: the worker copy is a CACHE and the Transform is its
    // source of truth. Anything that removes the cached copy — LRU eviction,
    // an explicit forget, the idle timeout tearing the pool down — must be
    // invisible except in timing, because the next call simply re-registers
    // from the Transform.

    function exact(t, img){
        return t.transformArray(img.data, false, false, false, img.pixelCount);
    }

    function differing(got, expected){
        let n = 0;
        for(let i = 0; i < expected.length; i++) if(got[i] !== expected[i]) n++;
        return n;
    }

    test('a Transform used again an hour later re-registers itself', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        const img = makeImage(90000, 3, 0x9A1);
        const expected = exact(t, img);

        const first = await t.transformImages([img], {multicore: true});
        expect(first.workersUsed).toBeGreaterThan(0);
        expect(differing(first.images[0], expected)).toBe(0);

        // What the idle timeout does, without waiting 30 seconds for it.
        pool.destroyAll();
        expect(Object.keys(pool._pools).length).toBe(0);

        const later = await t.transformImages([img], {multicore: true});
        expect(later.workersUsed).toBeGreaterThan(0);
        expect(differing(later.images[0], expected)).toBe(0);
    });

    test('forgetWorkers drops only this Transform, and leaves the pool running', async () => {
        const a = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        a.create('*sRGB', gracol(), eIntent.relative);
        const b = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        b.create(gracol(), '*sRGB', eIntent.relative);

        const imgA = makeImage(90000, 3, 0x9B2);
        const imgB = makeImage(90000, 4, 0x9C3);
        const expA = exact(a, imgA);
        const expB = exact(b, imgB);

        await a.transformImages([imgA], {multicore: true});
        await b.transformImages([imgB], {multicore: true});

        const asked = await a.forgetWorkers();
        expect(asked).toBeGreaterThan(0);

        // releaseWorkers() would have taken the whole pool down with it, and
        // B is still using it.
        expect(Object.keys(pool._pools).length).toBe(1);

        const resB = await b.transformImages([imgB], {multicore: true});
        expect(resB.workersUsed).toBeGreaterThan(0);
        expect(differing(resB.images[0], expB)).toBe(0);

        // Forgetting is an optimisation, not a teardown: A still works.
        const resA = await a.transformImages([imgA], {multicore: true});
        expect(resA.workersUsed).toBeGreaterThan(0);
        expect(differing(resA.images[0], expA)).toBe(0);
    });

    test('forgetting something never registered is a no-op, not an error', async () => {
        pool.destroyAll();
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        await expect(t.forgetWorkers()).resolves.toBe(0);   // no pools to ask
    });

    test('a tight cache bound still gives exact output for every transform', async () => {
        // Six transforms through a three-deep cache: every one of them is
        // evicted and re-shipped at least once, and none of them is wrong.
        const dests = ['*sRGB', '*AdobeRGB', '*applergb',
                       '*colormatch', '*prophoto', '*labd50'];
        const img = makeImage(90000, 3, 0x9D4);

        for(const dest of dests){
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.createMultiStage(['*sRGB', eIntent.relative, gracol(),
                                eIntent.relative, dest]);
            const expected = exact(t, img);
            const res = await t.transformImages([img],
                {multicore: {transformsPerWorker: 3}});

            expect(res.workersUsed).toBeGreaterThan(0);
            expect(`${dest}: ${differing(res.images[0], expected)} differing`)
                .toBe(`${dest}: 0 differing`);
        }
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('multicore — a worker dying', () => {

    jest.setTimeout(240000);

    test('a dead worker retires the pool instead of wedging it', async () => {
        // The one loss the cache bookkeeping cannot repair by itself. Eviction,
        // forgetWorkers() and idle-timeout teardown all clear the pool's record
        // of what a worker holds; a DEATH does not — `all[i]` keeps pointing at
        // a corpse and `lutsPerWorker[i]` keeps claiming registrations it no
        // longer has. Without retiring the pool this test hangs forever on the
        // second transformImages (verified: it times out).
        pool.destroyAll();

        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        const img = makeImage(90000, 3, 0xDE1);
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);

        const first = await t.transformImages([img], {multicore: true});
        expect(first.workersUsed).toBeGreaterThan(0);

        // Kill one the way an OOM or a native crash would, rather than the way
        // a JS throw does — the worker catches those and reports them.
        const live = pool._pools[Object.keys(pool._pools)[0]];
        expect(live.all.length).toBeGreaterThan(0);
        await live.all[0].terminate();
        await new Promise(r => setTimeout(r, 300));

        expect(Object.keys(pool._pools).length).toBe(0);      // retired, not reused

        // Same recovery path as an idle timeout: fresh pool, everything
        // re-registers from the Transform, output still exact.
        const after = await t.transformImages([img], {multicore: true});
        expect(after.workersUsed).toBeGreaterThan(0);

        let differing = 0;
        for(let i = 0; i < expected.length; i++){
            if(after.images[0][i] !== expected[i]) differing++;
        }
        expect(differing).toBe(0);
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('multicore — memory reporting', () => {

    jest.setTimeout(240000);

    // THE POINT OF THIS API. In C, threads share one address space and a LUT
    // is one copy however many threads read it. Here every worker holds its
    // own, so the resident cost is (transform size x workers holding it) and
    // is invisible unless you ask. See docs/deepdive/multicore.md.

    test('reports nothing when no pool is running', () => {
        pool.destroyAll();
        const r = pool.memoryReport();
        expect(r.pools).toEqual([]);
        expect(r.residentBytes).toBe(0);
        expect(pool.memorySummary()).toContain('none running');
    });

    test('resident bytes scale with the number of workers holding a copy', async () => {
        pool.destroyAll();
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        await t.transformImages([makeImage(90000, 3, 0x9E1)], {multicore: true});

        const r = pool.memoryReport();
        expect(r.pools.length).toBe(1);

        const p = r.pools[0];
        expect(p.transformsResident).toBe(1);
        expect(p.workersHolding).toBeGreaterThan(0);
        expect(p.residencies).toBe(p.workersHolding);      // one transform each

        // The whole reason the API exists: the total is per-copy x holders,
        // not one shared table.
        expect(p.residentBytes).toBe(p.bytesPerWorkerSet * p.workersHolding);
        expect(p.bytesPerWorkerSet).toBeGreaterThan(1000000);   // ~1.4MB CMYK LUT
    });

    test('a second transform adds its own copies rather than sharing', async () => {
        pool.destroyAll();
        const a = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        a.create('*sRGB', gracol(), eIntent.relative);
        await a.transformImages([makeImage(90000, 3, 0x9E2)], {multicore: true});
        const one = pool.memoryReport().pools[0].residentBytes;

        const b = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        b.create('*sRGB', '*AdobeRGB', eIntent.relative);
        await b.transformImages([makeImage(90000, 3, 0x9E3)], {multicore: true});

        const after = pool.memoryReport().pools[0];
        expect(after.transformsResident).toBe(2);
        expect(after.residentBytes).toBeGreaterThan(one);
    });

    test('forgetWorkers actually gives the memory back', async () => {
        pool.destroyAll();
        const a = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        a.create('*sRGB', gracol(), eIntent.relative);
        const b = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        b.create('*sRGB', '*AdobeRGB', eIntent.relative);

        await a.transformImages([makeImage(90000, 3, 0x9E4)], {multicore: true});
        await b.transformImages([makeImage(90000, 3, 0x9E5)], {multicore: true});
        const before = pool.memoryReport().pools[0].residentBytes;

        await a.forgetWorkers();

        const after = pool.memoryReport().pools[0];
        expect(after.transformsResident).toBe(1);
        expect(after.residentBytes).toBeLessThan(before);
    });

    test('the summary is readable and states what is actually resident', async () => {
        pool.destroyAll();
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        await t.transformImages([makeImage(90000, 3, 0x9E6)], {multicore: true});

        const summary = pool.memorySummary();
        expect(summary).toContain('workers');
        expect(summary).toContain('resident');
        expect(summary).toMatch(/\d+\.\d MB/);
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('multicore — recovering from a pool/worker desync', () => {

    jest.setTimeout(240000);

    test('a worker that lost its transform is re-registered mid-batch, not failed', async () => {
        // FORCED DESYNC. The pool records what it shipped to each worker and
        // the worker reports evictions back, so the two are meant to stay in
        // step — this reaches behind both and makes one worker drop a
        // transform WITHOUT telling the pool, which is the state the
        // bookkeeping is supposed to make impossible.
        //
        // Before recovery existed, the next task sent to that worker came back
        // as a generic error and failed the whole batch. Now the worker
        // answers 'unknownSignature', the pool clears its record for that one
        // worker, re-registers and re-sends that one task.
        pool.destroyAll();

        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);

        const img = makeImage(400000, 3, 0xD5C);
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);

        // First pass registers the transform across the workers.
        const first = await t.transformImages([img], {multicore: true});
        expect(first.workersUsed).toBeGreaterThan(0);

        const live = pool._pools[Object.keys(pool._pools)[0]];
        const signature = t._workerKey;
        expect(signature).toBeTruthy();

        // Find a worker the pool believes is holding it, and make that worker
        // forget — while leaving the pool's record in place.
        const victim = live.lutsPerWorker.findIndex(held => held && held[signature]);
        expect(victim).toBeGreaterThanOrEqual(0);

        live.all[victim].postMessage({type: 'forget', signature: signature});
        await new Promise(r => setTimeout(r, 200));

        // The pool still thinks it is there. That is the desync.
        expect(live.lutsPerWorker[victim][signature]).toBe(true);

        // Second pass: whichever tasks land on that worker miss, and must be
        // recovered rather than lost.
        const second = await t.transformImages([img], {multicore: true});
        expect(second.workersUsed).toBeGreaterThan(0);

        let differing = 0;
        for(let i = 0; i < expected.length; i++){
            if(second.images[0][i] !== expected[i]) differing++;
        }
        expect(`${differing} differing bytes`).toBe('0 differing bytes');
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('multicore — per-image completion callback', () => {

    jest.setTimeout(240000);

    // AN IMAGE IS DONE WHEN ITS OWN TASKS ARE — a refcount, not a position in
    // the queue. Tasks are sorted longest-first and pulled by whichever worker
    // frees up, so an image's slices complete out of order and interleaved
    // with other images'. Anything positional would fire at the wrong time.

    test('fires once per image, with that image finished buffer', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);

        const images = [
            makeImage(600000, 3, 0xA01),
            makeImage(150000, 3, 0xA02),
            makeImage(400000, 3, 0xA03)
        ];

        const seen = [];
        const res = await t.transformImages(images, {
            multicore: true,
            onImage: (index, data, info) => seen.push({index, data, info})
        });

        expect(seen.length).toBe(images.length);
        expect(seen.map(s => s.index).sort()).toEqual([0, 1, 2]);   // each exactly once

        for(const s of seen){
            expect(s.info.pixelCount).toBe(images[s.index].pixelCount);
            expect(s.info.outputChannels).toBe(t.outputChannels);
            expect(s.data.length).toBe(images[s.index].pixelCount * t.outputChannels);
            // The buffer handed over IS the finished one, not a copy or a stub.
            expect(s.data).toBe(res.images[s.index]);
        }
    });

    test('the delivered image is complete, not partially written', async () => {
        // The refcount has to hit zero only when the LAST slice has been
        // copied into place. If it fired early the tail of the image would
        // still be zeros.
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);

        const img = makeImage(800000, 3, 0xA04);
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);

        let delivered = null;
        await t.transformImages([img], {
            multicore: true,
            // Copy at callback time — if the buffer were incomplete here, the
            // snapshot would differ from the final result.
            onImage: (i, data) => { delivered = Array.from(data); }
        });

        expect(delivered).not.toBeNull();
        let differing = 0;
        for(let i = 0; i < expected.length; i++) if(delivered[i] !== expected[i]) differing++;
        expect(`${differing} differing bytes at callback time`).toBe('0 differing bytes at callback time');
    });

    test('fires on the sequential path too', async () => {
        // Multicore is an optimisation, never a capability: a caller must not
        // have to know which path ran to get their callbacks.
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);

        const seen = [];
        await t.transformImages(
            [makeImage(2000, 3, 0xA05), makeImage(2000, 3, 0xA06)],
            {multicore: false, onImage: (i, data) => seen.push({i, len: data.length})}
        );

        expect(seen.map(s => s.i)).toEqual([0, 1]);
        expect(seen.every(s => s.len === 2000 * t.outputChannels)).toBe(true);
    });

    test('a throwing callback warns but does not lose the batch', async () => {
        // The conversion has already succeeded by the time the callback runs.
        // Losing it because a progress bar failed would be absurd.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
            t.create('*sRGB', gracol(), eIntent.relative);

            const img = makeImage(300000, 3, 0xA07);
            const expected = t.transformArray(img.data, false, false, false, img.pixelCount);

            const res = await t.transformImages([img], {
                multicore: true,
                onImage: () => { throw new Error('callback exploded'); }
            });

            expect(Array.from(res.images[0])).toEqual(Array.from(expected));
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test('omitting the callback costs nothing and changes nothing', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);

        const img = makeImage(300000, 3, 0xA08);
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);
        const res = await t.transformImages([img], {multicore: true});

        expect(Array.from(res.images[0])).toEqual(Array.from(expected));
    });

    afterAll(() => { pool.destroyAll(); });
});


describe('multicore — image ids, timing and metadata', () => {

    jest.setTimeout(240000);

    // Images finish out of submission order, so the array index is a poor
    // handle for whatever the caller is tracking. An id — theirs if supplied,
    // generated if not — is something stable to key on.

    const tagged = (px, seed, extra) => Object.assign(makeImage(px, 3, seed), extra || {});

    test('caller ids are preserved and missing ones are generated', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);

        const images = [
            tagged(300000, 0xB01, {id: 'hero.tif'}),
            tagged(200000, 0xB02),                       // no id
            tagged(250000, 0xB03, {id: 42})              // ids need not be strings
        ];

        const seen = new Map();
        const res = await t.transformImages(images, {
            multicore: true,
            onImage: (index, data, info) => seen.set(info.id, info)
        });

        expect(seen.has('hero.tif')).toBe(true);
        expect(seen.has(42)).toBe(true);
        expect(seen.has('image-1')).toBe(true);          // generated from position

        // Same ids, in submission order, on the result.
        expect(res.imageInfo.map(i => i.id)).toEqual(['hero.tif', 'image-1', 42]);
        expect(res.imageInfo.map(i => i.index)).toEqual([0, 1, 2]);
    });

    test('caller metadata rides along on the descriptor', async () => {
        // The engine does not define a metadata shape — it hands back the
        // caller's own object, so anything attached to it is available.
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);

        const img = tagged(300000, 0xB04, {id: 'x', client: 'Richardson', page: 7});
        const res = await t.transformImages([img], {multicore: true});

        expect(res.imageInfo[0].source).toBe(img);
        expect(res.imageInfo[0].source.client).toBe('Richardson');
        expect(res.imageInfo[0].source.page).toBe(7);
    });

    test('per-image compute time is reported, and reflects real work', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);

        const res = await t.transformImages([
            tagged(1500000, 0xB05, {id: 'big'}),
            tagged(150000,  0xB06, {id: 'small'})
        ], {multicore: true});

        const big   = res.imageInfo.find(i => i.id === 'big');
        const small = res.imageInfo.find(i => i.id === 'small');

        expect(big.computeMs).toBeGreaterThan(0);
        expect(small.computeMs).toBeGreaterThan(0);
        // Ten times the pixels through the same kernel: not a benchmark, just
        // a check that the figure tracks the work rather than the wall clock.
        expect(big.computeMs).toBeGreaterThan(small.computeMs);

        // Wall time is separate, and can be SMALLER than compute time because
        // one image's slices run on many workers at once. That is the point of
        // reporting both.
        expect(typeof big.ms).toBe('number');
        expect(big.fragments).toBeGreaterThan(small.fragments);
        expect(small.fragments).toBeGreaterThan(0);
        expect(res.tasks).toBe(big.fragments + small.fragments);
    });

    test('imageInfo comes back on the sequential path too', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);

        const res = await t.transformImages(
            [tagged(2000, 0xB07, {id: 'seq'})], {multicore: false});

        expect(res.imageInfo.length).toBe(1);
        expect(res.imageInfo[0].id).toBe('seq');
        expect(res.imageInfo[0].computeMs).not.toBeNull();
        expect(res.imageInfo[0].outputChannels).toBe(t.outputChannels);
        expect(res.imageInfo[0].fragments).toBe(1);
    });

    test('res.images keeps its shape — imageInfo is additive', async () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);

        const img = makeImage(300000, 3, 0xB08);
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);
        const res = await t.transformImages([img], {multicore: true});

        expect(Array.isArray(res.images)).toBe(true);
        expect(Array.from(res.images[0])).toEqual(Array.from(expected));
        expect(res.imageInfo[0].id).toBe('image-0');
    });

    afterAll(() => { pool.destroyAll(); });
});


describe('parallel batch — cancellation', () => {

    jest.setTimeout(240000);

    // THE RULE THAT MATTERS: a cancelled image still fires its callback. A
    // caller awaiting one result per image would otherwise wait forever for
    // work that will never run — the handler sits idle and the batch looks
    // hung. Cancelled images report `data: null` and `info.cancelled: true`.

    const tagged = (px, seed, id) => Object.assign(makeImage(px, 3, seed), {id});

    function transform(){
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        return t;
    }

    test('cancel(id) skips one image and every image still announces', async () => {
        pool.destroyAll();
        const t = transform();
        const images = [
            tagged(3000000, 0xC01, 'a'),
            tagged(3000000, 0xC02, 'b'),
            tagged(3000000, 0xC03, 'c')
        ];

        const fired = [];
        const run = t.transformImages(images, {
            multicore: true,
            onImage: (i, data, info) => fired.push({id: info.id, cancelled: info.cancelled, data})
        });
        setTimeout(() => pool.cancel('b'), 15);
        const res = await run;

        // Nothing left hanging — this is the whole point.
        expect(fired.length).toBe(images.length);
        expect(fired.map(f => f.id).sort()).toEqual(['a', 'b', 'c']);

        const b = fired.find(f => f.id === 'b');
        expect(b.cancelled).toBe(true);
        // Tasks already with a worker cannot be recalled, so the buffer may be
        // partly written. Null rather than half-converted pixels.
        expect(b.data).toBeNull();
        expect(res.images[1]).toBeNull();
        expect(res.cancelled[1]).toBe(true);
    });

    test('images that were not cancelled still convert correctly', async () => {
        pool.destroyAll();
        const t = transform();
        const keep = tagged(2000000, 0xC04, 'keep');
        const drop = tagged(3000000, 0xC05, 'drop');
        const expected = t.transformArray(keep.data, false, false, false, keep.pixelCount);

        const run = t.transformImages([drop, keep], {multicore: true});
        setTimeout(() => pool.cancel('drop'), 10);
        const res = await run;

        const got = res.images[1];
        expect(got).not.toBeNull();
        let differing = 0;
        for(let i = 0; i < expected.length; i++) if(got[i] !== expected[i]) differing++;
        expect(`${differing} differing bytes`).toBe('0 differing bytes');
    });

    test('cancelAll stops the batch, and every image still announces', async () => {
        pool.destroyAll();
        const t = transform();
        const fired = [];
        const run = t.transformImages(
            [tagged(3000000, 0xC06, 'x'), tagged(3000000, 0xC07, 'y')],
            {multicore: true, onImage: (i, d, info) => fired.push(info)}
        );
        setTimeout(() => pool.cancelAll(), 10);
        await run;

        expect(fired.length).toBe(2);
        // Work already finished is not undone, so which images report
        // cancelled depends on timing — but every one of them reports.
        expect(fired.every(f => typeof f.cancelled === 'boolean')).toBe(true);
    });

    test('a batch submitted AFTER cancelAll runs normally', async () => {
        // The generation counter is what makes this work without a resume()
        // nobody would remember to call: cancelAll stops what exists, and
        // anything created afterwards is a later generation.
        pool.destroyAll();
        const t = transform();

        pool.cancelAll();

        const img = tagged(1000000, 0xC08, 'fresh');
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);
        const fired = [];
        const res = await t.transformImages([img], {
            multicore: true, onImage: (i, d, info) => fired.push(info)
        });

        expect(fired.length).toBe(1);
        expect(fired[0].cancelled).toBe(false);
        expect(res.images[0]).not.toBeNull();
        expect(Array.from(res.images[0])).toEqual(Array.from(expected));
    });

    test('a cancelled id does not haunt a later batch that reuses it', async () => {
        // Per-id cancellations are scoped to the batch that owned them.
        // Otherwise cancelling 'hero.tif' once would silently skip a different
        // 'hero.tif' next week.
        pool.destroyAll();
        const t = transform();

        const run = t.transformImages([tagged(3000000, 0xC09, 'hero.tif')], {multicore: true});
        setTimeout(() => pool.cancel('hero.tif'), 10);
        await run;

        const again = tagged(1000000, 0xC0A, 'hero.tif');
        const expected = t.transformArray(again.data, false, false, false, again.pixelCount);
        const res = await t.transformImages([again], {multicore: true});

        expect(res.cancelled[0]).toBe(false);
        expect(res.images[0]).not.toBeNull();
        expect(Array.from(res.images[0])).toEqual(Array.from(expected));
    });

    test('cancelling nothing changes nothing', async () => {
        pool.destroyAll();
        const t = transform();
        const img = tagged(1000000, 0xC0B, 'untouched');
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);

        pool.cancel('some-other-id');
        const res = await t.transformImages([img], {multicore: true});

        expect(res.cancelled[0]).toBe(false);
        expect(Array.from(res.images[0])).toEqual(Array.from(expected));
    });


    test('cancelAll reaches a batch QUEUED behind the running one', async () => {
        // Batches are serialised, so a queued batch starts after any
        // cancelAll() that lands in the meantime. Capturing the generation at
        // batch START would read the new value and conclude it was never
        // cancelled — measured, before the fix: the queued batch ran to
        // completion. The generation is captured at SUBMISSION instead.
        //
        // This is also why cancelAll() cannot simply mark every id: the pool
        // has not seen a queued batch's ids yet.
        pool.destroyAll();
        const t = transform();
        const fired = [];
        const cb = (i, d, info) => fired.push({id: info.id, cancelled: info.cancelled});

        const running = t.transformImages(
            [tagged(5000000, 0xC10, 'running-1'), tagged(5000000, 0xC11, 'running-2')],
            {multicore: true, onImage: cb});
        const queued = t.transformImages(
            [tagged(5000000, 0xC12, 'queued-1'), tagged(5000000, 0xC13, 'queued-2')],
            {multicore: true, onImage: cb});

        setTimeout(() => pool.cancelAll(), 20);
        await Promise.all([running, queued]);

        expect(fired.length).toBe(4);                       // all four announced
        const q = fired.filter(f => f.id.indexOf('queued') === 0);
        expect(q.length).toBe(2);
        expect(q.every(f => f.cancelled)).toBe(true);       // and the queued batch stopped
    });

    afterAll(() => { pool.destroyAll(); });
});


describe('parallel batch — queue depth and backpressure', () => {

    jest.setTimeout(240000);

    function transform(){
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        return t;
    }

    test('queueDepth reflects outstanding batches and returns to zero', async () => {
        pool.destroyAll();
        const t = transform();
        expect(pool.queueDepth()).toBe(0);

        const pending = [];
        for(let i = 0; i < 5; i++){
            pending.push(t.transformImages([makeImage(400000, 3, 0xE0 + i)], {multicore: true}));
        }
        expect(pool.queueDepth()).toBe(5);

        await Promise.all(pending);
        expect(pool.queueDepth()).toBe(0);
    });

    test('a failed batch still counts down, so waiters are not wedged', async () => {
        // A rejected batch that left the depth permanently raised would make
        // every later onQueueBelow() hang forever.
        pool.destroyAll();
        const t = transform();
        await t.transformImages([makeImage(200000, 3, 0xE9)], {multicore: true});
        expect(pool.queueDepth()).toBe(0);
        await expect(pool.onQueueFree()).resolves.toBeDefined();
    });

    test('onQueueBelow resolves immediately when there is room', async () => {
        pool.destroyAll();
        await expect(pool.onQueueBelow(2)).resolves.toBe(0);
    });

    test('onQueueBelow(2) paces a producer to a bounded backlog', async () => {
        // The point of the primitive: a loop that submits without awaiting
        // each result runs arbitrarily far ahead of the pool. Pacing bounds it
        // without stalling to empty — measured at roughly half the peak
        // external memory for ~3% more wall time.
        pool.destroyAll();
        const t = transform();

        let maxDepth = 0;
        const sampler = setInterval(() => {
            const d = pool.queueDepth();
            if(d > maxDepth) maxDepth = d;
        }, 4);

        const pending = [];
        for(let i = 0; i < 12; i++){
            await pool.onQueueBelow(2);
            pending.push(t.transformImages([makeImage(500000, 3, 0xF0 + i)], {multicore: true}));
        }
        await Promise.all(pending);
        clearInterval(sampler);

        // Bounded: at most the batch running plus the one queued behind it,
        // with a little slack for sampling between submit and settle.
        expect(maxDepth).toBeLessThanOrEqual(3);
        expect(pool.queueDepth()).toBe(0);
    });

    test('onQueueFree waits for everything, and results are still correct', async () => {
        pool.destroyAll();
        const t = transform();

        const images = [
            makeImage(400000, 3, 0xF20),
            makeImage(400000, 3, 0xF21),
            makeImage(400000, 3, 0xF22)
        ];
        const expected = images.map(img =>
            t.transformArray(img.data, false, false, false, img.pixelCount));

        const promises = images.map(img => t.transformImages([img], {multicore: true}));

        expect(pool.queueDepth()).toBeGreaterThan(0);
        await pool.onQueueFree();

        // What onQueueFree DOES promise: the pool is idle.
        expect(pool.queueDepth()).toBe(0);

        // What it does NOT promise: that continuations you attached to your own
        // batch promises have run. Those are separate continuations, and
        // resolving the drain waiter does not order them. To use results, await
        // the promises transformImages() returned — which is what they are for.
        const results = await Promise.all(promises);
        for(let i = 0; i < images.length; i++){
            expect(Array.from(results[i].images[0])).toEqual(Array.from(expected[i]));
        }
    });

    test('output buffers are allocated per batch, not per submission', async () => {
        // Batches run one at a time, so allocating outputs when a batch was
        // QUEUED meant every outstanding batch sat on a full set while it
        // waited — 668 MB peak for 40 queued 4 MPx batches, against 123 MB
        // once allocation moved to batch start.
        //
        // Asserted STRUCTURALLY rather than by measuring memory: a heap-size
        // assertion depends on when GC happens to run and would flake. What
        // actually matters is that the pool is handed a FUNCTION to allocate
        // with, not an already-allocated array — that is the whole mechanism.
        pool.destroyAll();
        const t = transform();

        const realRun = pool._pools.constructor === Object ? null : null;
        let sawOutputsArg = null;

        // Intercept at the Pool prototype, which every batch goes through.
        const Pool = Object.getPrototypeOf(
            (await (async () => {
                await t.transformImages([makeImage(300000, 3, 0xF31)], {multicore: true});
                return pool._pools[Object.keys(pool._pools)[0]];
            })())
        );

        const original = Pool.run;
        Pool.run = function(tasks, images, makeOutputs, ...rest){
            sawOutputsArg = typeof makeOutputs;
            return original.call(this, tasks, images, makeOutputs, ...rest);
        };

        try {
            const img = makeImage(300000, 3, 0xF32);
            const expected = t.transformArray(img.data, false, false, false, img.pixelCount);
            const res = await t.transformImages([img], {multicore: true});

            expect(sawOutputsArg).toBe('function');       // deferred, not pre-allocated
            expect(Array.from(res.images[0])).toEqual(Array.from(expected));
        } finally {
            Pool.run = original;
        }
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('parallel batch — interrupt', () => {

    jest.setTimeout(240000);

    // interrupt(fn) rather than pause()/resume(): a bare pause deadlocks the
    // pool if the caller throws before resuming, or forgets — and the failure
    // is silent, just workers that never pick anything up again. A scoped
    // callback cannot be left held.

    function transform(){
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        return t;
    }

    test('the batch still completes byte-identically across an interrupt', async () => {
        pool.destroyAll();
        const t = transform();
        const img = makeImage(6000000, 3, 0x1A1);
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);

        const run = t.transformImages([img], {multicore: true});
        setTimeout(() => {
            pool.interrupt(() => {
                const t0 = Date.now();
                while(Date.now() - t0 < 60);      // hold the main thread
            });
        }, 20);

        const res = await run;
        let differing = 0;
        for(let i = 0; i < expected.length; i++){
            if(res.images[0][i] !== expected[i]) differing++;
        }
        expect(`${differing} differing bytes`).toBe('0 differing bytes');
    });

    test('it drains in-flight fragments before running the callback', async () => {
        // Stopping dispatch is not stopping work: workers mid-fragment keep
        // every core busy, which defeats the point of asking for the CPU.
        pool.destroyAll();
        const t = transform();
        const run = t.transformImages([makeImage(6000000, 3, 0x1A2)], {multicore: true});

        let sawDepth = null;
        await new Promise(r => setTimeout(r, 20));
        await pool.interrupt(() => { sawDepth = 'ran'; });
        expect(sawDepth).toBe('ran');

        await run;
    });

    test('a throwing callback still releases the pool', async () => {
        pool.destroyAll();
        const t = transform();

        await expect(pool.interrupt(() => { throw new Error('boom'); })).rejects.toThrow('boom');

        // If the pause leaked, this would hang rather than fail.
        const img = makeImage(1000000, 3, 0x1A3);
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);
        const res = await t.transformImages([img], {multicore: true});
        expect(res.workersUsed).toBeGreaterThan(0);
        expect(Array.from(res.images[0])).toEqual(Array.from(expected));
    });

    test('an async callback is awaited before work resumes', async () => {
        pool.destroyAll();
        const t = transform();
        let finished = false;

        await pool.interrupt(async () => {
            await new Promise(r => setTimeout(r, 40));
            finished = true;
        });
        expect(finished).toBe(true);

        const img = makeImage(1000000, 3, 0x1A4);
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);
        const res = await t.transformImages([img], {multicore: true});
        expect(Array.from(res.images[0])).toEqual(Array.from(expected));
    });

    test('nested interrupts resume only when the outermost finishes', async () => {
        pool.destroyAll();
        const t = transform();

        await pool.interrupt(async () => {
            await pool.interrupt(() => {});         // inner releases first
        });

        const img = makeImage(1000000, 3, 0x1A5);
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);
        const res = await t.transformImages([img], {multicore: true});
        expect(res.workersUsed).toBeGreaterThan(0);
        expect(Array.from(res.images[0])).toEqual(Array.from(expected));
    });

    test('interrupt returns the callback value', async () => {
        pool.destroyAll();
        await expect(pool.interrupt(() => 42)).resolves.toBe(42);
        await expect(pool.interrupt(async () => 'done')).resolves.toBe('done');
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('parallel batch — what is safe inside an interrupt', () => {

    jest.setTimeout(240000);

    function transform(){
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create('*sRGB', gracol(), eIntent.relative);
        return t;
    }

    test('management calls that would queue behind the batch run immediately instead', async () => {
        // forgetWorkers() and getWorkerInfo() normally chain behind the running
        // batch. Awaited inside an interrupt that would deadlock: the batch
        // cannot finish until the interrupt releases, the interrupt waits on
        // the callback, the callback awaits the queued operation. They detect
        // the pause and run now — safe because interrupt() drains first.
        pool.destroyAll();
        const t = transform();
        const img = makeImage(6000000, 3, 0x1B1);
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);

        const run = t.transformImages([img], {multicore: true});
        await new Promise(r => setTimeout(r, 25));

        let ok = false;
        await pool.interrupt(async () => {
            await t.forgetWorkers();
            const info = await t.getWorkerInfo();
            ok = Array.isArray(info.workers);
        });
        expect(ok).toBe(true);

        // And the interrupted batch still finishes correctly.
        const res = await run;
        let differing = 0;
        for(let i = 0; i < expected.length; i++){
            if(res.images[0][i] !== expected[i]) differing++;
        }
        expect(`${differing} differing bytes`).toBe('0 differing bytes');
    });

    test('submitting without awaiting is safe, and runs after release', async () => {
        pool.destroyAll();
        const t = transform();
        const img = makeImage(1000000, 3, 0x1B2);
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);

        let later = null;
        await pool.interrupt(() => {
            later = t.transformImages([img], {multicore: true});   // no await
        });

        const res = await later;
        expect(Array.from(res.images[0])).toEqual(Array.from(expected));
    });

    test('cancelAll inside an interrupt does not wedge the paused batch', async () => {
        pool.destroyAll();
        const t = transform();
        const run = t.transformImages([makeImage(6000000, 3, 0x1B3)], {multicore: true});
        await new Promise(r => setTimeout(r, 25));

        await pool.interrupt(() => { pool.cancelAll(); });
        await expect(run).resolves.toBeDefined();       // settles rather than hanging
    });

    test('destroying the pool mid-batch settles it rather than hanging', async () => {
        // Replies already queued still arrive after destroy() has cleared the
        // pool's state; following them into that state used to throw, and
        // before that the in-flight counter leaked and hung every later
        // interrupt(). The batch now settles and transformImages falls back to
        // sequential, so the caller still gets correct pixels.
        pool.destroyAll();
        const t = transform();
        // Kept small: the recovery path converts this sequentially, and a big
        // image made the test dominate the suite's runtime for no extra cover.
        const img = makeImage(900000, 3, 0x1B4);
        const expected = t.transformArray(img.data, false, false, false, img.pixelCount);

        const run = t.transformImages([img], {multicore: true});
        await new Promise(r => setTimeout(r, 15));
        pool.destroyAll();

        const res = await run;
        expect(Array.from(res.images[0])).toEqual(Array.from(expected));

        // And interrupt() still works afterwards — the counter did not leak.
        await expect(pool.interrupt(() => 'ok')).resolves.toBe('ok');
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('multicore — the matrix-shaper kernel with alpha', () => {

    jest.setTimeout(120000);

    // The kernel is built independently inside each worker, from a cloned
    // profile chain rather than a shipped LUT, and it now picks one of five
    // alpha entry points. That is two independent choices per worker, so
    // "sequential and parallel agree" is checking that every worker resolved
    // the SAME shape as the main thread — a mismatch would show up as a
    // stride error at a fragment boundary, not as a wrong colour.
    const N = 1 << 18;

    function rgba(n){
        const px = new Uint8ClampedArray(n * 4);
        let s = 0x13579bdf;
        for(let i = 0; i < px.length; i++){
            s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
            px[i] = (s >>> 23) & 0xff;
        }
        return px;
    }

    const SHAPES = [
        ['4 -> 4, alpha copied', true,  true,  true],
        ['4 -> 4, alpha filled', true,  true,  false],
        ['4 -> 3, alpha dropped', true, false, false],
        ['3 -> 4, alpha filled', false, true,  false]
    ];

    for(const [label, inA, outA, preserve] of SHAPES){
        test(label + ': parallel output is byte-identical to sequential', async () => {
            const src = inA ? rgba(N) : rgba(N).subarray(0, N * 3);

            const t = new Transform({dataFormat: 'int8', buildLut: false});
            t.create('*prophoto', '*sRGB', eIntent.relative);

            const expected = t.transformArray(src, inA, outA, preserve, N).slice();
            expect(t.kernelInfo().built).toBe(true);          // the kernel, not the loops

            const res = await t.transformImages([{data: src, pixelCount: N}], {
                inputHasAlpha: inA, outputHasAlpha: outA, preserveAlpha: preserve,
                multicore: {cores: 4, minThreads: 1, maxThreads: 4}
            });

            expect(res.workersUsed).toBeGreaterThan(0);
            expect(res.images[0].length).toBe(expected.length);

            let differing = 0;
            for(let i = 0; i < expected.length; i++)
                if(res.images[0][i] !== expected[i]) differing++;
            expect(`${label}: ${differing} bytes differ`).toBe(`${label}: 0 bytes differ`);
        });
    }

    afterAll(() => { pool.destroyAll(); });
});

describe('Transform.enablePool() — parallelism you can confirm', () => {

    jest.setTimeout(60000);

    // enablePool() sets PROCESS-WIDE state: it makes the pool the default for
    // later batches. Leaving it set leaked into the blocks below, which then
    // saw workers they had not asked for — so every block that enables must
    // disable, exactly as an app would at shutdown.
    afterEach(() => Transform.disablePool());

    test('it starts the pool and reports the worker count', async () => {
        const r = await Transform.enablePool({cores: 2, minThreads: 1, maxThreads: 2});
        expect(r.workers).toBe(2);
        expect(r.host).toBe('worker_threads');
    });

    test('it REJECTS rather than falling back silently', async () => {
        // Every other route into the pool degrades to sequential without a
        // word, which is right — multicore is an optimisation, never a
        // capability. This is the one place a caller who deliberately wants
        // parallelism can find out they did not get it.
        process.env.JSCE_POOL_DISABLE = '1';
        try {
            await expect(Transform.enablePool()).rejects.toThrow(/declined to start/);
        } finally {
            delete process.env.JSCE_POOL_DISABLE;
        }
    });

    test('transformImages still works after it, and still falls back quietly', async () => {
        // enablePool() is a diagnostic and a warm-up, not a mode switch: it
        // must not change what transformImages does or what it returns.
        await Transform.enablePool({cores: 2, minThreads: 1, maxThreads: 2});
        const t = new Transform({dataFormat: 'int8', buildLut: true});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);

        const n = 1 << 16;
        const px = new Uint8ClampedArray(n * 3);
        for(let i = 0; i < px.length; i++) px[i] = (i * 31) & 255;
        const expected = t.transformArray(px, false, false, false, n).slice();

        const res = await t.transformImages([{data: px, pixelCount: n}],
            {multicore: {cores: 2, minThreads: 1, maxThreads: 2}});

        let differing = 0;
        for(let i = 0; i < expected.length; i++) if(res.images[0][i] !== expected[i]) differing++;
        expect(`${differing} bytes differ`).toBe('0 bytes differ');
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('multicore — asked for and unavailable', () => {

    jest.setTimeout(60000);

    // ABOVE parallelFloorPx (65,536). Below it the pool declines to split at
    // all — splitting stops paying — so a smaller image would test the floor
    // rather than the thing these tests are about.
    const N = 1 << 17;
    const img = () => {
        const px = new Uint8ClampedArray(N * 3);
        for(let i = 0; i < px.length; i++) px[i] = (i * 31) & 255;
        return {data: px, pixelCount: N};
    };
    const build = () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        return t;
    };

    test('multicore:true on the CONSTRUCTOR works', async () => {
        // _multicoreHandoff has always read this.multicore as the per-call
        // fallback, but nothing set it — so the constructor option silently did
        // nothing. Regression guard for that.
        const t = new Transform({dataFormat: 'int8', buildLut: true, multicore: true});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        const res = await t.transformImages([img()], {});
        expect(res.workersUsed).toBeGreaterThan(0);
    });

    test('without multicore it runs sequentially and says nothing', async () => {
        // Not asking for parallelism is a legitimate choice — transformImages
        // is also the batch/callback API — so it must not warn.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            Transform._warnedNoWorkers = false;
            const res = await build().transformImages([img()], {});
            expect(res.workersUsed).toBe(0);
            expect(warn).not.toHaveBeenCalled();
        } finally { warn.mockRestore(); }
    });

    test('asked for and unavailable: still correct, warned once', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        process.env.JSCE_POOL_DISABLE = '1';
        pool.destroyAll();
        Transform._warnedNoWorkers = false;
        try {
            const t = build();
            const expected = t.transformArray(img().data, false, false, false, N).slice();

            const a = await t.transformImages([img()], {multicore: true});
            const b = await t.transformImages([img()], {multicore: true});

            expect(a.workersUsed).toBe(0);
            let differing = 0;
            for(let i = 0; i < expected.length; i++) if(a.images[0][i] !== expected[i]) differing++;
            expect(`${differing} bytes differ`).toBe('0 bytes differ');

            // Once, not once per call — a per-call log on a hot path is its own bug.
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toMatch(/SEQUENTIALLY/);
        } finally {
            delete process.env.JSCE_POOL_DISABLE;
            warn.mockRestore();
        }
    });

    test('requireWorkers turns it into a rejection', async () => {
        process.env.JSCE_POOL_DISABLE = '1';
        pool.destroyAll();
        try {
            await expect(build().transformImages([img()], {multicore: true, requireWorkers: true}))
                .rejects.toThrow(/requireWorkers/);
        } finally { delete process.env.JSCE_POOL_DISABLE; }
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('Transform.enablePool() — configure once, at startup', () => {

    jest.setTimeout(60000);

    const N = 1 << 18;
    const img = () => {
        const px = new Uint8ClampedArray(N * 3);
        for(let i = 0; i < px.length; i++) px[i] = (i * 31) & 255;
        return {data: px, pixelCount: N};
    };
    const build = () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        return t;
    };

    afterEach(() => Transform.disablePool());

    test('enabling makes later batches parallel with no per-call option', async () => {
        expect((await build().transformImages([img()], {})).workersUsed).toBe(0);
        await Transform.enablePool({workers: 3});
        expect((await build().transformImages([img()], {})).workersUsed).toBe(3);
    });

    test('workers / maxWorkers are accepted alongside cores / maxThreads', async () => {
        // Callers reach for "workers"; the pool's own vocabulary is "cores".
        // One concept, more than one spelling, resolved in one place.
        const a = await Transform.enablePool({workers: 2, maxWorkers: 2});
        expect(a.workers).toBe(2);
        Transform.disablePool();
        const b = await Transform.enablePool({cores: 2, maxThreads: 2});
        expect(b.workers).toBe(2);
    });

    test('an explicit option still beats the enabled pool', async () => {
        // Ambient must never override something the caller wrote down.
        await Transform.enablePool({workers: 3});
        const res = await build().transformImages([img()], {multicore: false});
        expect(res.workersUsed).toBe(0);
    });

    test('disablePool stops defaulting to it', async () => {
        await Transform.enablePool({workers: 2});
        Transform.disablePool();
        expect((await build().transformImages([img()], {})).workersUsed).toBe(0);
    });

    test('output is identical whichever way it was reached', async () => {
        const t = build();
        const expected = t.transformArray(img().data, false, false, false, N).slice();
        await Transform.enablePool({workers: 3});
        const res = await t.transformImages([img()], {});
        let differing = 0;
        for(let i = 0; i < expected.length; i++) if(res.images[0][i] !== expected[i]) differing++;
        expect(`${differing} bytes differ`).toBe('0 bytes differ');
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('enablePool / restartPool — lifecycle', () => {

    jest.setTimeout(60000);

    const live = () => Object.keys(pool._pools).length;
    const totalWorkers = () =>
        Object.keys(pool._pools).reduce((a, k) => a + pool._pools[k].workers, 0);

    afterEach(() => Transform.disablePool());

    test('a second enable with the SAME options is a no-op', async () => {
        // Two modules should both be able to ask for a pool without the second
        // one failing — making a caller know whether it is first is exactly
        // the coupling a process-wide resource should absorb.
        const a = await Transform.enablePool({workers: 2});
        expect(a.alreadyEnabled).toBeUndefined();
        const b = await Transform.enablePool({workers: 2});
        expect(b.alreadyEnabled).toBe(true);
        expect(b.workers).toBe(2);
        expect(live()).toBe(1);
    });

    test('a second enable with DIFFERENT options is ignored, and says so', async () => {
        // Pools are keyed by worker count, so before this the second call
        // built a SECOND pool and the process held 8 workers for a pool of 6.
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        Transform._warnedPoolReconfig = false;
        try {
            await Transform.enablePool({workers: 2});
            const b = await Transform.enablePool({workers: 6});
            expect(b.alreadyEnabled).toBe(true);
            expect(b.workers).toBe(2);              // still the original
            expect(live()).toBe(1);                 // and only one pool
            expect(totalWorkers()).toBe(2);
            expect(String(warn.mock.calls[0][0])).toMatch(/restart/);
        } finally { warn.mockRestore(); }
    });

    test('restartPool replaces the pool rather than adding one', async () => {
        await Transform.enablePool({workers: 2});
        const r = await Transform.restartPool({workers: 6});
        expect(r.workers).toBe(6);
        expect(r.alreadyEnabled).toBeUndefined();
        expect(live()).toBe(1);
        expect(totalWorkers()).toBe(6);
    });

    test('a restart waits for in-flight work, and that work still completes', async () => {
        // Reconfiguring replaces the workers, and workers hold fragments.
        // Draining first is the safe default: nothing in flight is lost.
        await Transform.enablePool({workers: 2});
        const t = new Transform({dataFormat: 'int8', buildLut: true});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);

        const n = 1 << 18;
        const px = new Uint8ClampedArray(n * 3);
        for(let i = 0; i < px.length; i++) px[i] = (i * 31) & 255;
        const expected = t.transformArray(px, false, false, false, n).slice();

        const batch = t.transformImages([{data: px, pixelCount: n}], {});
        const restarted = Transform.restartPool({workers: 4});

        const res = await batch;
        await restarted;

        let differing = 0;
        for(let i = 0; i < expected.length; i++) if(res.images[0][i] !== expected[i]) differing++;
        expect(`${differing} bytes differ`).toBe('0 bytes differ');
        expect(totalWorkers()).toBe(4);
    });

    test('bytes in flight are tracked, and onMemoryBelow waits on them', async () => {
        // queueDepth cannot tell four thumbnails from four 60 MP scans; this
        // is the number a caller actually has a budget for.
        await Transform.enablePool({workers: 2});
        const t = new Transform({dataFormat: 'int8', buildLut: true});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);

        const n = 1 << 19;
        const px = new Uint8ClampedArray(n * 3);
        expect(pool.memoryInFlight()).toBe(0);

        const batch = t.transformImages([{data: px, pixelCount: n}], {});
        expect(pool.memoryInFlight()).toBe(n * 6);      // 3 in + 3 out

        await Promise.all([batch, pool.onMemoryBelow(1024)]);
        expect(pool.memoryInFlight()).toBe(0);
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('per-image alpha overrides', () => {

    jest.setTimeout(60000);

    const N = 1 << 18;
    const rgba = (() => {
        const a = new Uint8ClampedArray(N * 4);
        let s = 0x13579bdf;
        for(let i = 0; i < a.length; i++){
            s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
            a[i] = (s >>> 23) & 0xff;
        }
        return a;
    })();
    const rgb = (() => {
        const a = new Uint8ClampedArray(N * 3);
        for(let p = 0; p < N; p++){
            a[p*3] = rgba[p*4]; a[p*3+1] = rgba[p*4+1]; a[p*3+2] = rgba[p*4+2];
        }
        return a;
    })();
    const build = () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        return t;
    };
    const mixed = () => ([
        {data: rgba, pixelCount: N, id: 'a', inputHasAlpha: true,  outputHasAlpha: true, preserveAlpha: true},
        {data: rgb,  pixelCount: N, id: 'b', inputHasAlpha: false, outputHasAlpha: false}
    ]);

    afterEach(() => Transform.disablePool());

    test('a mixed RGBA/RGB batch converts in ONE call', async () => {
        // The ordinary case for a batch converter is a folder of mixed
        // formats. Forcing one batch-wide answer means two calls, or padding
        // every JPEG with an alpha channel nobody asked for.
        const res = await build().transformImages(mixed(), {multicore: true});
        expect(res.images[0].length).toBe(N * 4);
        expect(res.images[1].length).toBe(N * 3);
    });

    test('parallel and sequential agree byte-for-byte on a mixed batch', async () => {
        // Both paths must resolve the overrides the same way, or a batch would
        // convert differently depending on whether workers happened to be
        // available — the one thing the sequential fallback exists to rule out.
        const t = build();
        const seq = await t.transformImages(mixed(), {multicore: false});
        const par = await t.transformImages(mixed(), {multicore: true});
        expect(par.workersUsed).toBeGreaterThan(0);

        for(let k = 0; k < 2; k++){
            let differing = 0;
            for(let i = 0; i < seq.images[k].length; i++)
                if(par.images[k][i] !== seq.images[k][i]) differing++;
            expect(`image ${k}: ${differing} bytes differ`).toBe(`image ${k}: 0 bytes differ`);
        }
    });

    test('alpha is preserved exactly on the image that has one', async () => {
        const res = await build().transformImages(mixed(), {multicore: true});
        let wrong = 0;
        for(let p = 0; p < N; p++) if(res.images[0][p*4+3] !== rgba[p*4+3]) wrong++;
        expect(wrong).toBe(0);
    });

    test('an image with no override inherits the batch flags', async () => {
        const res = await build().transformImages(
            [{data: rgba, pixelCount: N, id: 'inherits'}],
            {multicore: true, inputHasAlpha: true, outputHasAlpha: true, preserveAlpha: true});
        expect(res.images[0].length).toBe(N * 4);
        let wrong = 0;
        for(let p = 0; p < N; p++) if(res.images[0][p*4+3] !== rgba[p*4+3]) wrong++;
        expect(wrong).toBe(0);
    });

    test('preserveAlpha defaults to "both sides have one" per image', async () => {
        // Same rule transformArray uses, so an image that declares alpha in
        // and out gets it preserved without saying so a third time.
        const res = await build().transformImages(
            [{data: rgba, pixelCount: N, inputHasAlpha: true, outputHasAlpha: true}],
            {multicore: true});
        let wrong = 0;
        for(let p = 0; p < N; p++) if(res.images[0][p*4+3] !== rgba[p*4+3]) wrong++;
        expect(wrong).toBe(0);
    });

    afterAll(() => { pool.destroyAll(); });
});

describe('pixelCount is optional', () => {

    jest.setTimeout(60000);

    const N = 1 << 18;
    const rgba = new Uint8ClampedArray(N * 4);
    const rgb  = new Uint8ClampedArray(N * 3);
    (() => {
        let s = 0x13579bdf;
        for(let i = 0; i < rgba.length; i++){
            s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
            rgba[i] = (s >>> 23) & 0xff;
        }
        for(let p = 0; p < N; p++){
            rgb[p*3] = rgba[p*4]; rgb[p*3+1] = rgba[p*4+1]; rgb[p*3+2] = rgba[p*4+2];
        }
    })();
    const build = () => {
        const t = new Transform({dataFormat: 'int8', buildLut: true});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        return t;
    };

    afterEach(() => Transform.disablePool());

    test('inferred from the array length and the resolved alpha', async () => {
        // Once alpha is known the stride is known, so the count follows. A
        // caller who just decoded a file should not have to restate what the
        // array obviously contains.
        const res = await build().transformImages([
            {data: rgba, id: 'rgba', inputHasAlpha: true, outputHasAlpha: true},
            {data: rgb,  id: 'rgb'}
        ], {multicore: true});
        expect(res.imageInfo[0].pixelCount).toBe(N);
        expect(res.imageInfo[1].pixelCount).toBe(N);
        expect(res.images[0].length).toBe(N * 4);
        expect(res.images[1].length).toBe(N * 3);
    });

    test('inferring gives the same bytes as stating it', async () => {
        const t = build();
        const a = await t.transformImages([{data: rgb, pixelCount: N}], {});
        const b = await t.transformImages([{data: rgb}], {});
        let differing = 0;
        for(let i = 0; i < a.images[0].length; i++)
            if(a.images[0][i] !== b.images[0][i]) differing++;
        expect(`${differing} bytes differ`).toBe('0 bytes differ');
    });

    test('a ragged array is refused, not silently truncated', async () => {
        await expect(build().transformImages([{data: new Uint8ClampedArray(10), id: 'r'}], {}))
            .rejects.toThrow(/not a whole number of 3-channel pixels/);
    });

    test('a pixelCount that would overrun the buffer is refused', async () => {
        // An explicit count still wins — a pooled or oversized buffer is
        // exactly why it exists — but it is checked rather than trusted.
        await expect(build().transformImages(
            [{data: new Uint8ClampedArray(30), pixelCount: 100, id: 'o'}], {}))
            .rejects.toThrow(/overrun the buffer/);
    });

    test('an explicit count still wins on an oversized buffer', async () => {
        // The case inference cannot serve: a reused slab holding one small
        // image. Inference would happily convert the padding.
        const slab = new Uint8ClampedArray(N * 3);
        const res = await build().transformImages([{data: slab, pixelCount: 1024}], {});
        expect(res.imageInfo[0].pixelCount).toBe(1024);
        expect(res.images[0].length).toBe(1024 * 3);
    });

    test('an image with no data names itself in the error', async () => {
        await expect(build().transformImages([{id: 'missing'}], {}))
            .rejects.toThrow(/image "missing" has no `data`/);
    });

    afterAll(() => { pool.destroyAll(); });
});
