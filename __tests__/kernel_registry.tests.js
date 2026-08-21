/**
 * The dense kernel registry — phase 1 of docs/deepdive/KernelContract.md.
 *
 * `Transform.kernels` is an array indexed by INPUT CHANNEL COUNT over the full
 * ICC range 1..15 (FCLR is 15 channels). There is no 'nd' key and no
 * `inputChannels > 4` special case: KernelND simply occupies slots 5..15.
 *
 * The point of eleven slots holding one descriptor is that any single
 * dimension can be replaced — a tuned Kernel7D, or a test probe — without
 * forking the other ten. These tests hold that property, because it is the
 * thing the rest of the contract's testability rests on.
 *
 * Coverage:
 *   1. Shape          — dense 1..15, slots 5..15 share one object, named
 *   2. registerKernel — number, [from,to] range, legacy 'ND', range validation
 *   3. Isolation      — a probe at one dimension disturbs no other
 *   4. Routing        — setKernel() indexes the array; instances are per-Transform
 */
'use strict';

const path = require('path');
const { Transform, eIntent } = require('../src/main');
const Profile = require('../src/Profile');

const MAX = Transform.MAX_KERNEL_DIMENSIONS;

// A minimal descriptor that satisfies the registry without doing any work.
function probe(name, dimensions){
    return {
        name: name,
        dimensions: dimensions,
        supports: { float: true },
        create: function(m){ return m; },
        resolveRuns: function(){},
        array: function(){ return null; },
        release: function(){},
        provideLut: function(){ return null; }
    };
}

// Restore a span of slots after a test has patched them.
function snapshot(from, to){
    const saved = [];
    for(let d = from; d <= to; d++) saved.push(Transform.kernels[d]);
    return function restore(){
        for(let d = from; d <= to; d++) Transform.kernels[d] = saved[d - from];
    };
}

describe('kernel registry — dense 1..15', () => {

    test('MAX_KERNEL_DIMENSIONS is the ICC ceiling', () => {
        expect(MAX).toBe(15);
    });

    test('every dimension 1..15 has a registered descriptor', () => {
        for(let d = 1; d <= MAX; d++){
            expect(Transform.kernels[d]).toBeTruthy();
            expect(typeof Transform.kernels[d].array).toBe('function');
        }
    });

    test('1..4 are the dimensional kernels, and they are named', () => {
        expect(Transform.kernels[1].name).toBe('kernel1D');
        expect(Transform.kernels[2].name).toBe('kernel2D');
        expect(Transform.kernels[3].name).toBe('kernel3D');
        expect(Transform.kernels[4].name).toBe('kernel4D');
    });

    test('slots 5..15 hold ONE shared descriptor object', () => {
        // Identity, not equality. Sharing the object is what keeps eleven
        // slots free: Object.create() in setKernel() then produces a single
        // hidden class across the whole span rather than eleven.
        const nd = Transform.kernels[5];
        expect(nd.name).toBe('kernelND');
        for(let d = 6; d <= MAX; d++){
            expect(Transform.kernels[d]).toBe(nd);
        }
    });

    test('the claiming registry is separate and unaffected', () => {
        // matrix-shaper is an addition to the registry, not a replacement in
        // it — a LUT-based RGB pair must still reach Kernel3D.
        expect(Transform.claimKernels.map(k => k.name)).toContain('matrix-shaper');
        expect(Transform.kernels[3].name).toBe('kernel3D');
    });
});

describe('registerKernel — dimensions forms', () => {

    test('a single channel count fills exactly one slot', () => {
        const restore = snapshot(6, 8);
        try {
            Transform.registerKernel(probe('test-k7', 7));
            expect(Transform.kernels[7].name).toBe('test-k7');
            expect(Transform.kernels[6].name).toBe('kernelND');
            expect(Transform.kernels[8].name).toBe('kernelND');
        } finally { restore(); }
    });

    test('[from, to] fills the inclusive range and nothing outside it', () => {
        const restore = snapshot(5, MAX);
        try {
            Transform.registerKernel(probe('test-span', [8, 10]));
            expect(Transform.kernels[7].name).toBe('kernelND');
            expect(Transform.kernels[8].name).toBe('test-span');
            expect(Transform.kernels[9].name).toBe('test-span');
            expect(Transform.kernels[10].name).toBe('test-span');
            expect(Transform.kernels[11].name).toBe('kernelND');
        } finally { restore(); }
    });

    test('a range registers one shared object, not one per slot', () => {
        const restore = snapshot(5, MAX);
        try {
            const d = probe('test-span', [8, 10]);
            Transform.registerKernel(d);
            expect(Transform.kernels[8]).toBe(d);
            expect(Transform.kernels[9]).toBe(d);
            expect(Transform.kernels[10]).toBe(d);
        } finally { restore(); }
    });

    test("legacy 'ND' still means 5..15", () => {
        const restore = snapshot(5, MAX);
        try {
            Transform.registerKernel(probe('test-legacy-nd', 'ND'));
            for(let d = 5; d <= MAX; d++){
                expect(Transform.kernels[d].name).toBe('test-legacy-nd');
            }
            expect(Transform.kernels[4].name).toBe('kernel4D');
        } finally { restore(); }
    });

    test('out-of-range and malformed dimensions throw', () => {
        const bad = [0, -1, MAX + 1, undefined, null, 'xx', [3], [4, 2], [0, 3], [3, MAX + 1]];
        for(const dims of bad){
            expect(() => Transform.registerKernel(probe('test-bad', dims)))
                .toThrow(/dimensions must be/);
        }
        expect(() => Transform.registerKernel(null)).toThrow(/dimensions must be/);
    });

    test('re-registering a dimension replaces that slot for future create()s', () => {
        const restore = snapshot(3, 3);
        try {
            Transform.registerKernel(probe('test-replaces-3d', 3));
            expect(Transform.kernels[3].name).toBe('test-replaces-3d');
        } finally { restore(); }
        expect(Transform.kernels[3].name).toBe('kernel3D');
    });
});

describe('registry isolation — one slot, one dimension', () => {

    test('a probe at dimension 9 leaves every other dimension alone', () => {
        const restore = snapshot(5, MAX);
        try {
            Transform.registerKernel(probe('test-probe-9', 9));
            for(let d = 1; d <= MAX; d++){
                if(d === 9) continue;
                expect(Transform.kernels[d].name).not.toBe('test-probe-9');
            }
            expect(Transform.kernels[9].name).toBe('test-probe-9');
        } finally { restore(); }
    });

    test('a probe at dimension 9 does not disturb a real RGB conversion', () => {
        // The whole point: injecting a kernel for a dimension nobody is using
        // must be invisible to the dimensions that are.
        const restore = snapshot(5, MAX);
        try {
            Transform.registerKernel(probe('test-probe-9', 9));

            const t = new Transform({ dataFormat: 'int8', buildLut: false });
            t.create('*sRGB', '*AdobeRGB', eIntent.relative);

            const out = t.transform([128, 64, 200]);
            expect(Array.isArray(out) || ArrayBuffer.isView(out)).toBe(true);
            expect(Number.isFinite(out[0])).toBe(true);
            expect(t.kernelInfo().name).not.toBe('test-probe-9');
        } finally { restore(); }
    });
});

describe('setKernel — routing by input channel count', () => {

    test('setKernel(n) instantiates the descriptor in slot n', () => {
        const t = new Transform({ dataFormat: 'int8' });
        for(const [n, expected] of [[1, 'kernel1D'], [2, 'kernel2D'],
                                    [3, 'kernel3D'], [4, 'kernel4D'],
                                    [5, 'kernelND'], [15, 'kernelND']]){
            t.setKernel(n);
            expect(t.kernel).toBeTruthy();
            expect(t.kernel.name).toBe(expected);
            // An INSTANCE, never the shared descriptor itself — per-Transform
            // state must not leak across Transforms.
            expect(t.kernel).not.toBe(Transform.kernels[n]);
            expect(Object.getPrototypeOf(t.kernel)).toBe(Transform.kernels[n]);
            expect(t.kernel.transform).toBe(t);
        }
    });

    test('setKernel() routes to the probe once a slot is patched', () => {
        const restore = snapshot(9, 9);
        try {
            Transform.registerKernel(probe('test-probe-9', 9));
            const t = new Transform({ dataFormat: 'int8' });
            t.setKernel(9);
            expect(t.kernel.name).toBe('test-probe-9');
        } finally { restore(); }
    });

    test('an unregistered dimension leaves kernel null rather than throwing', () => {
        const t = new Transform({ dataFormat: 'int8' });
        t.setKernel(99);
        expect(t.kernel).toBeNull();
    });
});

describe('kernelInfo — names come from the descriptor', () => {

    test('a dimensional kernel reports its registered name', () => {
        const cmyk = new Profile();
        cmyk.loadFile(path.join(__dirname, 'GRACoL2006_Coated1v2.icc'));

        const t = new Transform({ dataFormat: 'int8' });
        t.create('*sRGB', cmyk, eIntent.relative);

        const info = t.kernelInfo();
        expect(info.name).toBe('kernel3D');       // 3-channel input
        expect(info.dimensions).toBe(3);
        expect(info.claimed).toBe(false);
    });
});

describe('floatFor — the kernel owns its single-colour stage function', () => {

    // Phase 2 of docs/deepdive/KernelContract.md. addStageLUT used to pick the
    // interpolator itself from a switch on lut.inputChannels; it now asks the
    // kernel registered for that dimension. The point is that ONE object owns
    // both surfaces, so a replacement kernel changes transform(colour) and
    // transformArray() together instead of only the latter.

    test('1D and 2D kernels return a function and a stage name', () => {
        for(const [dim, expectedName] of [[1, 'linearInterp1D'], [2, 'bilinearInterp2D']]){
            const bind = Transform.kernels[dim].floatFor({ outputChannels: 3 }, {});
            expect(typeof bind.funct).toBe('function');
            expect(bind.stageName).toBe(expectedName);
        }
    });

    test('the stage names are exactly what the optimiser and compile() expect', () => {
        // These strings are a coupling surface, not a label. optimisePipeline()
        // matches its fusion patterns against them and compile() resolves
        // emitters as emit_js_<stageName>. If one drifts, fusion stops firing
        // silently — throughput drops and every other test still passes.
        expect(Transform.kernels[1].floatFor({ outputChannels: 3 }, {}).stageName)
            .toBe('linearInterp1D');
        expect(Transform.kernels[2].floatFor({ outputChannels: 3 }, {}).stageName)
            .toBe('bilinearInterp2D');
    });

    test('the batch loop agrees with the single-colour function, bit for bit', () => {
        // The two are separate implementations on purpose — sharing one body
        // between the per-colour path and the image loop deoptimises the array
        // path 2-3x. Separate implementations of the same maths need a test
        // that says they still agree, which is this one.
        function grayLut(outCh, g1){
            const CLUT = new Float64Array(g1 * outCh);
            for(let i = 0; i < g1; i++){
                const v = i / (g1 - 1);
                for(let c = 0; c < outCh; c++) CLUT[i * outCh + c] = Math.min(1, v * (1 + c * 0.07));
            }
            return { inputChannels: 1, outputChannels: outCh, g1, gridPoints: [g1],
                     CLUT, inputScale: 1 / 255, outputScale: 255, go0: outCh, intLut: null };
        }

        for(const outCh of [3, 4, 6]){
            for(const g1 of [256, 33, 17]){
                const lut = grayLut(outCh, g1);
                const t = new Transform({ buildLut: true, lutMode: 'float', dataFormat: 'int8' });
                t.lut = lut;
                t.inputChannels = 1;
                t.outputChannels = outCh;
                t.setKernel(1);
                t._resolveLutKernels();

                const PX = 512;
                const inp = new Uint8ClampedArray(PX);
                for(let i = 0; i < PX; i++) inp[i] = (i * 37) & 255;

                const got = t.transformArrayViaLUT(inp, false, false);

                // Through the SAME container, so the rounding is identical —
                // Uint8ClampedArray rounds half-to-even, Math.round does not.
                const ref = Transform.kernels[1].floatFor(lut, {}).funct;
                const exp = new Uint8ClampedArray(PX * outCh);
                for(let p = 0, w = 0; p < PX; p++){
                    const r = ref([inp[p]], lut);
                    for(let c = 0; c < outCh; c++) exp[w++] = r[c];
                }
                expect(Array.from(got)).toEqual(Array.from(exp));
            }
        }
    });

    test('a gray pipeline stage is built from the registry, not a switch', () => {
        // Swap in a kernel that names its stage differently and check the name
        // reaches the built pipeline — proof the lookup is live rather than the
        // old hard-coded path happening to agree.
        const restore = snapshot(1, 1);
        try {
            const probe = Object.create(Transform.kernels[1]);
            probe.name = 'kernel1D-probe';
            probe.floatFor = () => ({ funct: () => [0, 0, 0], stageName: 'probeStage1D' });
            Transform.kernels[1] = probe;

            const t = new Transform({ buildLut: false, lutMode: 'float' });
            t.addStageLUT(true, 0, { inputChannels: 1, outputChannels: 3, g1: 2,
                                     gridPoints: [2], CLUT: new Float64Array(6),
                                     inputScale: 1, outputScale: 1, go0: 3 }, 0);
            expect(t.pipeline[t.pipeline.length - 1].stageName).toBe('probeStage1D');
        } finally { restore(); }
    });
});

describe('floatFor — 3D, 4D and ND resolve every branch of the old switch', () => {

    // Phase 3 moved ~120 lines of interpolator selection out of
    // Transform.addStageLUT and into the kernels. These pin each branch, since
    // the switch that used to encode them no longer exists to read.

    const enc = require('../src/def').encoding;
    const dev = { inputEncoding: enc.device, useTrilinearFor3ChInput: true };

    test('Kernel3D picks by output channels, and by interpolationFast', () => {
        const k = Transform.kernels[3];
        const pick = (outputChannels, over) =>
            k.floatFor({ outputChannels }, Object.assign({}, dev,
                { interpolation3D: 'tetrahedral', fast: true }, over));

        expect(pick(3).funct.name).toBe('tetrahedralInterp3D_3Ch');
        expect(pick(4).funct.name).toBe('tetrahedralInterp3D_4Ch');
        expect(pick(6).funct.name).toBe('tetrahedralInterp3D_NCh');
        expect(pick(3, { fast: false }).funct.name).toBe('tetrahedralInterp3D_3or4Ch');
        for(const outCh of [3, 4, 6]) expect(pick(outCh).stageName).toBe('tetrahedralInterp3D');
    });

    test('PCS-indexed input overrides to trilinear — a 3D-only rule', () => {
        // lcms 2.0 moved to tetrahedral and found it disagreed with 1.19,
        // SampleICC and Photoshop on Lab-indexed LUTs: L sits on one axis, so
        // the space is uncentred and tetrahedral splits it badly.
        const k = Transform.kernels[3];
        for(const e of [enc.PCSv2, enc.PCSv4]){
            const bind = k.floatFor({ outputChannels: 3 }, {
                inputEncoding: e, useTrilinearFor3ChInput: true,
                interpolation3D: 'tetrahedral', fast: true });
            expect(bind.stageName).toBe('trilinearInterp3D');
        }
        // Opting out of the override leaves tetrahedral in place.
        const off = k.floatFor({ outputChannels: 3 }, {
            inputEncoding: enc.PCSv4, useTrilinearFor3ChInput: false,
            interpolation3D: 'tetrahedral', fast: true });
        expect(off.stageName).toBe('tetrahedralInterp3D');

        // And 4D has no such rule — its absence there is the point.
        const bind4 = Transform.kernels[4].floatFor({ outputChannels: 3 },
            { inputEncoding: enc.PCSv4, useTrilinearFor3ChInput: true,
              interpolation4D: 'tetrahedral', fast: true });
        expect(bind4.stageName).toBe('tetrahedralInterp4D');
    });

    test('Kernel4D picks by output channels, and by interpolationFast', () => {
        const k = Transform.kernels[4];
        const pick = (outputChannels, over) =>
            k.floatFor({ outputChannels },
                Object.assign({ interpolation4D: 'tetrahedral', fast: true }, over));

        expect(pick(3).funct.name).toBe('tetrahedralInterp4D_3Ch');
        expect(pick(4).funct.name).toBe('tetrahedralInterp4D_4Ch');
        expect(pick(6).funct.name).toBe('tetrahedralInterp4D_NCh');
        expect(pick(3, { fast: false }).funct.name).toBe('tetrahedralInterp4D_3or4Ch');
        expect(pick(3, { interpolation4D: 'trilinear' }).stageName).toBe('trilinearInterp4D');
    });

    test('ND has one implementation and says so', () => {
        for(const d of [5, 9, 15]){
            const bind = Transform.kernels[d].floatFor({ outputChannels: d }, {});
            expect(bind.funct.name).toBe('tetrahedralInterpND_NCh');
            expect(bind.stageName).toBe('tetrahedralInterpND');
        }
    });

    test('an unrecognised interpolation method throws rather than defaulting', () => {
        // interpolation3D / interpolation4D are public options. A typo must not
        // quietly select tetrahedral — the throw is the contract, and it moved
        // into the kernels with the rest of the selection logic.
        expect(() => Transform.kernels[3].floatFor({ outputChannels: 3 },
            Object.assign({}, dev, { interpolation3D: 'quadratic', fast: true })))
            .toThrow(/Unknown 3D interpolation method/);
        expect(() => Transform.kernels[4].floatFor({ outputChannels: 3 },
            { interpolation4D: 'quadratic', fast: true }))
            .toThrow(/Unknown 4D interpolation method/);
    });

    test('every stage name floatFor can return is one the optimiser knows', () => {
        // optimisePipeline() fuses codec stages into interpolation stages by
        // matching these strings. A name the list does not contain silently
        // stops fusing — throughput drops and no test fails. So assert the
        // producers agree with the consumer.
        const known = ['linearInterp1D', 'bilinearInterp2D', 'trilinearInterp3D',
                       'tetrahedralInterp3D', 'trilinearInterp4D', 'tetrahedralInterp4D'];
        const produced = new Set();
        produced.add(Transform.kernels[1].floatFor({ outputChannels: 3 }, {}).stageName);
        produced.add(Transform.kernels[2].floatFor({ outputChannels: 3 }, {}).stageName);
        for(const method of ['tetrahedral', 'trilinear'])
            for(const fast of [true, false])
                for(const outCh of [3, 4, 6]){
                    produced.add(Transform.kernels[3].floatFor({ outputChannels: outCh },
                        Object.assign({}, dev, { interpolation3D: method, fast })).stageName);
                    produced.add(Transform.kernels[4].floatFor({ outputChannels: outCh },
                        { interpolation4D: method, fast }).stageName);
                }
        for(const name of produced) expect(known).toContain(name);
    });
});

describe('the array loops are reached through their modules, not the Transform', () => {

    // v1.6 phase 4b. The tuned loops used to be reachable only as
    // Transform.prototype methods, so lutKernelTable called them as
    // `t.tetrahedralInterp3DArray_3Ch_loop(...)`. They are pure functions of
    // their arguments — the last `this` went when the N-channel loops were
    // inlined in 4a — so callers now require the module directly.
    //
    // The prototype attachment stays as compatibility surface. These tests hold
    // the two to being the SAME function objects, because a copy would mean two
    // implementations that could drift.

    const loopModules = {
        '1d': require('../src/kernels/1d/kernel1D_loops.js'),
        '2d': require('../src/kernels/2d/kernel2D_loops.js'),
        '3d': require('../src/kernels/3d/kernel3D_loops.js'),
        '4d': require('../src/kernels/4d/kernel4D_loops.js'),
    };

    test('every loop is one object, shared by the module and the prototype', () => {
        let count = 0;
        for(const mod of Object.values(loopModules)){
            for(const name of Object.keys(mod)){
                expect(typeof mod[name]).toBe('function');
                // Identity, not equality: a copy would be a second implementation.
                expect(Transform.prototype[name]).toBe(mod[name]);
                count++;
            }
        }
        expect(count).toBeGreaterThanOrEqual(16);
    });

    test('the loops use no `this` — calling them bare produces the same result', () => {
        // This is what let them move. If a loop ever regains a `this`, calling
        // it detached throws or silently misbehaves, and this test says so
        // before lutKernelTable does it a million times per image.
        const g1 = 17, outCh = 3, dims = 3;
        const cells = g1 * g1 * g1 * outCh;
        const CLUT = new Float64Array(cells);
        let s = 7;
        for(let i = 0; i < cells; i++){ s = (s * 1103515245 + 12345) & 0x7fffffff; CLUT[i] = s / 0x7fffffff; }
        const lut = { inputChannels: dims, outputChannels: outCh,
                      gridPoints: [g1, g1, g1], CLUT, inputScale: 1 / 255, outputScale: 255,
                      g1, g2: g1 * g1, g3: g1 * g1 * g1,
                      go0: outCh, go1: g1 * outCh, go2: g1 * g1 * outCh };

        const px = 256;
        const input = new Uint8ClampedArray(px * dims);
        for(let i = 0; i < input.length; i++) input[i] = (i * 37) & 255;

        const loop = loopModules['3d'].tetrahedralInterp3DArray_3Ch_loop;
        const viaModule = new Uint8ClampedArray(px * outCh);
        const viaProto  = new Uint8ClampedArray(px * outCh);

        // Bare call — no receiver at all.
        loop(input, 0, viaModule, 0, px, lut, false, false, false);
        // Through the prototype, the way it was always called.
        Transform.prototype.tetrahedralInterp3DArray_3Ch_loop.call(
            Transform.prototype, input, 0, viaProto, 0, px, lut, false, false, false);

        expect(Array.from(viaModule)).toEqual(Array.from(viaProto));
        expect(viaModule.some(v => v !== 0)).toBe(true);   // it actually ran
    });
});

describe('the dispatch table lives with its kernels', () => {

    // v1.6 phase 4d. The 42 rows of the LUT dispatch table were one object in
    // lutKernelTable.js. Every fallback chain stays inside one input dimension
    // — i8wsi_3_3 degrades to i8ws_3_3 to i_3_3 to fl_3_3 and never leaves 3D —
    // so it was two independent ladders sharing a file. Each kernel owns its
    // own now; the resolver, the key format and the mode map stay shared.

    const lutKernelTable = require('../src/lutKernelTable');
    const table3d = require('../src/kernels/3d/kernel3D_table.js');
    const table4d = require('../src/kernels/4d/kernel4D_table.js');

    test('the merged view is exactly the two halves, and they do not overlap', () => {
        const merged = Object.keys(lutKernelTable.KERNEL).sort();
        const halves = Object.keys(table3d).concat(Object.keys(table4d)).sort();
        expect(merged).toEqual(halves);
        // No key in both — an overlap would mean one half silently winning.
        for(const k of Object.keys(table3d)) expect(table4d[k]).toBeUndefined();
        expect(merged.length).toBe(42);
    });

    test('each half holds only its own dimension', () => {
        for(const k of Object.keys(table3d)) expect(k.split('_')[1]).toBe('3');
        for(const k of Object.keys(table4d)) expect(k.split('_')[1]).toBe('4');
    });

    test('no fallback chain leaves its dimension', () => {
        // This is the property that made the split possible. If a chain ever
        // needs to cross — a 4D mode degrading to a 3D one — the tables cannot
        // stay separate, and this test is where that shows up.
        const K = lutKernelTable.KERNEL;
        for(const start of Object.keys(K)){
            const dim = start.split('_')[1];
            let key = start, hops = 0;
            while(key && hops < 20){
                expect(key.split('_')[1]).toBe(dim);
                key = K[key].fallback;
                hops++;
            }
            expect(hops).toBeLessThan(20);        // terminates
        }
    });

    test('the dispatch threshold has one definition', () => {
        // It used to be written twice — in Transform.js as the public static
        // and in lutKernelTable.js, kept in step by a comment — and splitting
        // the table would have made it three. Every WASM row reads the shared
        // module, so there is nothing left to drift.
        const threshold = require('../src/kernels/dispatchThreshold.js');
        expect(typeof threshold).toBe('number');
        expect(lutKernelTable.WASM_DISPATCH_MIN_PIXELS).toBe(threshold);
        expect(Transform.WASM_DISPATCH_MIN_PIXELS).toBe(threshold);

        const K = lutKernelTable.KERNEL;
        const wasmRows = Object.keys(K).filter(k => /^i(8|16)ws/.test(k) && K[k].run !== null);
        expect(wasmRows.length).toBeGreaterThan(0);
        for(const k of wasmRows) expect(K[k].minPx).toBe(threshold);
    });
});

describe('WASM state belongs to the kernel', () => {

    // v1.6 phase 4c. The eight wasmTetra* slots were declared on the Transform
    // and mutated by wasmLifecycle. They now live on the kernel instance,
    // because the kernel is what loads, dispatches to and releases them —
    // and because a kernel that owns its state can eventually load only its own
    // dimension's modules, which is phase 7.
    //
    // Transform keeps forwarding accessors. Those are a compatibility surface,
    // not the design: the public WASM API reads through them and the WASM test
    // suites assert on them in ~210 places. Keeping those suites working
    // unchanged is what made them a real check on this move.

    const SLOTS = ['wasmTetra3D', 'wasmTetra3DSimd', 'wasmTetra3DInt16', 'wasmTetra3DInt16Simd',
                   'wasmTetra4D', 'wasmTetra4DSimd', 'wasmTetra4DInt16', 'wasmTetra4DInt16Simd'];

    const cmykPath = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');
    const HAS_WASM = typeof WebAssembly !== 'undefined' && !process.env.SKIP_WASM_TESTS;

    test('the slots are the kernel instance\'s own properties, not the Transform\'s', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        for(const slot of SLOTS){
            expect(Object.prototype.hasOwnProperty.call(t.kernel, slot)).toBe(true);
            expect(Object.prototype.hasOwnProperty.call(t, slot)).toBe(false);
        }
    });

    test('reads and writes forward to the kernel', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        const sentinel = { marker: true };
        t.wasmTetra3D = sentinel;
        expect(t.kernel.wasmTetra3D).toBe(sentinel);
        t.kernel.wasmTetra3D = null;
        expect(t.wasmTetra3D).toBeNull();
    });

    test('null-safe before a kernel exists', () => {
        // The constructor no longer declares these, so a read before create()
        // has no kernel to go to. It must answer null rather than throw.
        const t = new Transform({ dataFormat: 'int8' });
        for(const slot of SLOTS) expect(t[slot]).toBeNull();
        expect(() => { t.wasmTetra3D = {}; }).not.toThrow();
    });

    (HAS_WASM ? test : test.skip)('release() clears the kernel\'s state, seen through both', () => {
        const cmyk = new Profile(); cmyk.loadFile(cmykPath);
        const t = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd' });
        t.create('*sRGB', cmyk, eIntent.relative);

        expect(t.wasmTetra3D).not.toBeNull();
        expect(t.wasmMemoryBytes()).toBeGreaterThan(0);

        t.releaseWasmMemory();
        expect(t.wasmTetra3D).toBeNull();
        expect(t.kernel.wasmTetra3D).toBeNull();
        expect(t.wasmMemoryBytes()).toBe(0);
    });

    (HAS_WASM ? test : test.skip)('both families still load — the phase 7 tripwire', () => {
        // Deliberate: phase 7 makes each kernel load only its own dimension,
        // at which point a CMYK transform stops carrying 3D modules and this
        // test SHOULD fail. It is here so that change is a decision rather than
        // a surprise, and so the 128 KB it recovers is visible when it happens.
        const cmyk = new Profile(); cmyk.loadFile(cmykPath);
        const t = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd' });
        t.create(cmyk, '*sRGB', eIntent.relative);

        expect(t.kernelInfo().name).toBe('kernel4D');
        expect(t.kernel.wasmTetra4D).not.toBeNull();
        expect(t.kernel.wasmTetra3D).not.toBeNull();   // ← phase 7 changes this
    });
});
