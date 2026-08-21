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

    test('the 3-channel slot holds Kernel3D, which yields when it wants to', () => {
        // The matrix shaper is not in the registry at all — it is Kernel3D's
        // other implementation, handed back from init(). A LUT-based RGB pair
        // still reaches the tetrahedral kernel.
        expect(Transform.kernels[3].name).toBe('kernel3D');
        expect(typeof Transform.kernels[3].init).toBe('function');
        expect(Transform.claimKernels).toBeUndefined();
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
        // 0 is IN range: it is the identity kernel's slot. The registry is
        // indexed by input DIMENSION, and identity has none -- an identity
        // RGB->RGB still has 3 input channels, it just needs no interpolation.
        const bad = [-1, MAX + 1, undefined, null, 'xx', [3], [4, 2], [-1, 3], [3, MAX + 1]];
        for(const dims of bad){
            expect(() => Transform.registerKernel(probe('test-bad', dims)))
                .toThrow(/dimensions must be/);
        }
        expect(() => Transform.registerKernel(null)).toThrow(/dimensions must be/);
    });

    test('dimension 0 is registrable — the identity slot', () => {
        const restore = snapshot(0, 0);
        try {
            Transform.registerKernel(probe('test-identity', 0));
            expect(Transform.kernels[0].name).toBe('test-identity');
        } finally { restore(); }
        expect(Transform.kernels[0].name).toBe('kernelIdentity');
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

describe('each kernel owns its dispatch', () => {

    // v1.6. The rows moved into the kernels in phase 4d and then stopped being
    // rows at all: a kernel resolving its own dispatch does not need a keyed
    // lookup structure, it knows its variants. What is left is a switch per
    // kernel, reached through kernel.table.resolve().

    test('3D and 4D expose their own resolver; nobody else needs one', () => {
        for(const dim of [3, 4]){
            const k = Transform.kernels[dim];
            expect(typeof k.table).toBe('object');
            expect(typeof k.table.resolve).toBe('function');
        }
        // 1D, 2D and ND have a single implementation their array() calls
        // directly, so they have no dispatch to resolve.
        for(const dim of [1, 2, 5, 15]){
            expect(Transform.kernels[dim].table).toBeUndefined();
        }
    });

    test('the two resolvers are separate objects, not one shared table', () => {
        expect(Transform.kernels[3].table).not.toBe(Transform.kernels[4].table);
    });

    test('the dispatch threshold still has one definition', () => {
        // It used to be written twice — the public static and a copy in the
        // table module, kept in step by a comment.
        const threshold = require('../src/kernels/dispatchThreshold.js');
        expect(typeof threshold).toBe('number');
        expect(Transform.WASM_DISPATCH_MIN_PIXELS).toBe(threshold);
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

    (HAS_WASM ? test : test.skip)('a kernel loads its own dimension and nothing else', () => {
        // This was the phase 7 tripwire: it asserted that BOTH families
        // loaded, deliberately written to fail the day each kernel started
        // loading only its own dimension, so that change would be a decision
        // rather than a surprise. It has now fired and been turned around.
        //
        // A CMYK transform used to compile and instantiate four 3-D modules it
        // could never reach -- kernel4D_table.js names no wasmTetra3D* slot at
        // all -- and a gray transform compiled all eight.
        const cmyk = new Profile(); cmyk.loadFile(cmykPath);

        const cmykT = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd' });
        cmykT.create(cmyk, '*sRGB', eIntent.relative);
        expect(cmykT.kernelInfo().name).toBe('kernel4D');
        expect(cmykT.kernel.wasmTetra4DSimd).not.toBeNull();
        expect(cmykT.kernel.wasmTetra4D).not.toBeNull();
        expect(cmykT.kernel.wasmTetra3DSimd).toBeNull();
        expect(cmykT.kernel.wasmTetra3D).toBeNull();

        const rgbT = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd' });
        rgbT.create('*sRGB', cmyk, eIntent.relative);
        expect(rgbT.kernelInfo().name).toBe('kernel3D');
        expect(rgbT.kernel.wasmTetra3DSimd).not.toBeNull();
        expect(rgbT.kernel.wasmTetra3D).not.toBeNull();
        expect(rgbT.kernel.wasmTetra4DSimd).toBeNull();
        expect(rgbT.kernel.wasmTetra4D).toBeNull();
    });

    (HAS_WASM ? test : test.skip)('a kernel with no WASM at all says so in its lutMode', () => {
        // 1-D, 2-D and N-D have no WASM kernels. They used to report
        // lutMode 'int-wasm-simd' anyway, because the 3-D module loaded
        // successfully on their behalf and nothing checked whether it was
        // reachable from a gray transform. It was not.
        //
        // No virtual gray profile exists in createVirtualProfile(), so drive
        // the kernel directly -- what is being checked is the settle, which
        // reads lutMode and the kernel's ladder and nothing else.
        // NOTE create(lutMode) ignores its argument and reads
        // transform.lutMode -- longstanding, and why this sets the field
        // rather than passing a value.
        for(const dims of [1, 2, 5, 15]){
            for(const [asked, landed] of [['int-wasm-simd', 'int'],
                                          ['int-wasm-scalar', 'int'],
                                          ['int16-wasm-simd', 'int16'],
                                          ['int16-wasm-scalar', 'int16'],
                                          ['float', 'float'],
                                          ['int', 'int']]){
                const t = new Transform({ dataFormat: 'int8', buildLut: true });
                t.setKernel(dims);
                t.lutMode = asked;
                expect(t.kernel.wasmLadder).toBeUndefined();
                expect(t.kernel.create(asked)).toBe(landed);
            }
        }
    });
});

describe('the image path — resolved in init(), kept inside the kernel', () => {

    // floatFor gives the kernel the single-colour path. This is its
    // counterpart for images, and the shape it landed on is the plainest one:
    // Transform calls kernel.array() and the kernel works it out.
    //
    // THREE DRAFTS GOT HERE. First kernelUtils.runTableKernel() reached back
    // into Transform for a resolve; then arrayFor() returned a bound function;
    // then arrayFor() returned {big, small, threshold} so a caller could pick.
    // The last one still leaked -- telling the caller there is a threshold
    // makes batch size its business. It is not. The kernel keeps both runs and
    // its own break-even, and picks inside array().
    //
    // These tests read arrayFnBig / arrayFnSml / threshold directly. They are
    // the kernel's private fields; a test is allowed to look, and what it is
    // checking is that create() alone settles them with no resolve step
    // sequenced from outside.
    //
    // NOT A THROUGHPUT CHANGE. Resolution happens once per create() and the
    // run executes once per image, not once per pixel.

    const cmykPath = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');
    const HAS_WASM = typeof WebAssembly !== 'undefined' && !process.env.SKIP_WASM_TESTS;

    function bound(opts, a, b){
        const t = new Transform(Object.assign({ buildLut: true }, opts));
        t.create(a, b, eIntent.relative);
        return t.kernel;
    }

    test('every kernel settles both runs and a threshold at create()', () => {
        const cmyk = new Profile(); cmyk.loadFile(cmykPath);
        for(const [a, b] of [['*sRGB', '*AdobeRGB'], ['*sRGB', cmyk], [cmyk, '*sRGB']]){
            const k = bound({ dataFormat: 'int8' }, a, b);
            expect(typeof k.arrayFnBig).toBe('function');
            expect(typeof k.arrayFnSml).toBe('function');
            expect(typeof k.threshold).toBe('number');
            expect(k.threshold).toBeGreaterThanOrEqual(0);
        }
    });

    test('non-WASM modes collapse: one run, threshold 0, no compare', () => {
        const cmyk = new Profile(); cmyk.loadFile(cmykPath);
        for(const lutMode of ['float', 'int']){
            const k = bound({ lutMode, dataFormat: 'int8' }, '*sRGB', cmyk);
            expect(k.arrayFnBig).toBe(k.arrayFnSml);
            expect(k.threshold).toBe(0);
        }
    });

    (HAS_WASM ? test : test.skip)('WASM modes do not collapse — big and small differ', () => {
        // Worth asserting so nobody "optimises" the compare away and sends
        // 64-pixel calls through a path that loses on the memcpy.
        const cmyk = new Profile(); cmyk.loadFile(cmykPath);
        const k = bound({ lutMode: 'int-wasm-simd', dataFormat: 'int8' }, '*sRGB', cmyk);
        expect(k.arrayFnBig).not.toBe(k.arrayFnSml);
        expect(k.threshold).toBeGreaterThan(0);
        expect(k.arrayFnBigName).not.toBe(k.arrayFnSmlName);
    });

    (HAS_WASM ? test : test.skip)('the threshold has one source, with the override winning', () => {
        // It used to exist twice: entry.minPx baked into the table at load,
        // and a read of the Transform static at resolve. Precedence now: an
        // explicit global override, then the kernel's own wasmMinPixels, then
        // the shared default.
        const DEFAULT = require('../src/kernels/dispatchThreshold.js');
        const cmyk = new Profile(); cmyk.loadFile(cmykPath);
        const opts = { lutMode: 'int-wasm-simd', dataFormat: 'int8' };

        expect(bound(opts, '*sRGB', cmyk).threshold).toBe(DEFAULT);

        // A kernel that has measured its own break-even declares it.
        const restore = snapshot(3, 3);
        try {
            const tuned = Object.create(Transform.kernels[3]);
            tuned.name = 'kernel3D-tuned';
            tuned.wasmMinPixels = 1024;
            Transform.kernels[3] = tuned;
            expect(bound(opts, '*sRGB', cmyk).threshold).toBe(1024);

            // The documented profiling override still beats it — `= 0` must
            // keep forcing the WASM path at every size.
            Transform.WASM_DISPATCH_MIN_PIXELS = 0;
            expect(bound(opts, '*sRGB', cmyk).threshold).toBe(0);
        } finally {
            Transform.WASM_DISPATCH_MIN_PIXELS = DEFAULT;
            restore();
        }
    });

    test('the names describe which run won', () => {
        const cmyk = new Profile(); cmyk.loadFile(cmykPath);
        const k = bound({ lutMode: 'int', dataFormat: 'int8' }, '*sRGB', cmyk);
        expect(k.arrayFnBigName).toBe('i_3_4');
        expect(k.arrayFnSmlName).toBe('i_3_4');
    });

    test('a kernel with one implementation has no dispatch at all', () => {
        // 1-D, 2-D and N-D call their single loop straight from array().
        // Nothing to choose between means no init(), no resolution, and the
        // fields stay null -- the split is not a tax every kernel pays.
        for(const dims of [1, 2, 5, 15]){
            const k = Transform.kernels[dims];
            expect(k.init).toBeUndefined();
            expect(typeof k.array).toBe('function');
        }
    });

    test('array() is the only entry point — no resolver survives on either side', () => {
        const cmyk = new Profile(); cmyk.loadFile(cmykPath);
        const t = new Transform({ buildLut: true, dataFormat: 'int8' });
        t.create('*sRGB', cmyk, eIntent.relative);
        expect(t.kernel.resolveRuns).toBeUndefined();
        expect(t.kernel.arrayFor).toBeUndefined();
        expect(t._resolveLutKernels).toBeUndefined();
        expect(t._bindLutTransformArrayFn).toBeUndefined();
        expect(require('../src/kernels/kernelUtils.js').runTableKernel).toBeUndefined();
    });
});

describe('init() — a kernel settles its own dimension, and may yield', () => {

    // v1.6 phase 5. There is no registry of claiming kernels on Transform and
    // no `claims` protocol. Transform asks the kernel that owns the dimension
    // to settle, and that kernel looks at its own pipeline. If it decides
    // something else should run the batch path, it hands that back.

    const cmykPath = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

    test('Kernel3D yields to the matrix shaper when the pipeline folded', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: false });
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        expect(t.kernelInfo().name).toBe('matrix-shaper');
        expect(t.kernelInfo().claimed).toBe(true);
    });

    test('and keeps the transform itself when it did not', () => {
        const cmyk = new Profile(); cmyk.loadFile(cmykPath);
        const t = new Transform({ dataFormat: 'int8', buildLut: true });
        t.create('*sRGB', cmyk, eIntent.relative);
        expect(t.kernelInfo().name).toBe('kernel3D');
        expect(t.kernelInfo().claimed).toBe(false);
    });

    test('init runs on the INSTANCE, not the shared descriptor', () => {
        // Calling it on the descriptor would have every Transform of a
        // dimension writing its decision into one object, and the next
        // conversion inheriting the last one's. The prototype chain hides that
        // until an instance field shadows it — which is how it was found.
        const cmyk = new Profile(); cmyk.loadFile(cmykPath);

        const folded = new Transform({ dataFormat: 'int8', buildLut: false });
        folded.create('*sRGB', '*AdobeRGB', eIntent.relative);
        const lutBased = new Transform({ dataFormat: 'int8', buildLut: true });
        lutBased.create('*sRGB', cmyk, eIntent.relative);

        // Neither disturbed the other, and neither wrote to the descriptor.
        expect(folded.kernelInfo().name).toBe('matrix-shaper');
        expect(lutBased.kernelInfo().name).toBe('kernel3D');
        expect(Transform.kernels[3].claimed).toBeUndefined();
    });

    test('init is handed what a kernel is allowed to know, by name', () => {
        const restore = snapshot(3, 3);
        let seen = null;
        try {
            const probe = Object.create(Transform.kernels[3]);
            probe.name = 'kernel3D-probe';
            probe.init = function(pipeline, opts){
                seen = { isArray: Array.isArray(pipeline), keys: Object.keys(opts).sort() };
                return { pipeline: pipeline, kernel: null,
                         meta: { name: 'kernel3D-probe', dimensions: 3, claimed: false } };
            };
            Transform.kernels[3] = probe;

            const t = new Transform({ dataFormat: 'int8', buildLut: true });
            t.create('*sRGB', '*AdobeRGB', eIntent.relative);

            expect(seen.isArray).toBe(true);
            for(const key of ['transform', 'lutMode', 'dataFormat', 'verbose',
                              'wasmMatrixShaper', 'pixelCacheActive', 'kernelOptions']){
                expect(seen.keys).toContain(key);
            }
        } finally { restore(); }
    });

    test('kernelOptions reach the kernel untouched', () => {
        const restore = snapshot(3, 3);
        let got = null;
        try {
            const probe = Object.create(Transform.kernels[3]);
            probe.name = 'kernel3D-probe';
            probe.init = function(pipeline, opts){
                got = opts.kernelOptions;
                return { pipeline: pipeline, kernel: null,
                         meta: { name: 'kernel3D-probe', dimensions: 3, claimed: false } };
            };
            Transform.kernels[3] = probe;

            const mine = { kernel3D: { f32: true, anything: 'at all' } };
            const t = new Transform({ dataFormat: 'int8', buildLut: true, kernelOptions: mine });
            t.create('*sRGB', '*AdobeRGB', eIntent.relative);

            // Transform does not validate or interpret these — it does not know
            // what any of them mean.
            expect(got).toBe(mine);
        } finally { restore(); }
    });

    test('the meta a kernel returns is what kernelInfo reports', () => {
        const t = new Transform({ dataFormat: 'int8', buildLut: false });
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        expect(t._kernelClaim).toEqual(expect.objectContaining({
            name: 'matrix-shaper', claimed: true }));
    });

    test('the matrix shaper no longer reads private Transform fields', () => {
        // It used to test transform._pixelCacheData directly — a kernel
        // reading a private field of the thing it is decoupled from. Kernel3D
        // reads opts.pixelCacheActive and decides before the matrix shaper is
        // even instantiated.
        let src = require('fs').readFileSync(
            path.join(__dirname, '..', 'src', 'kernels', '3d', 'matrixShaper',
                      'KernelMatrixShaper.js'), 'utf8');
        src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        expect(src).not.toMatch(/transform\._pixelCacheData/);
    });
});

describe('KernelIdentity — identity is a kernel, not a branch', () => {

    // Until now identity was the one dimension-shaped special case left in
    // Transform: an isIdentity branch that built its own pipeline, bound its
    // own closure, and returned from create() before the registry was ever
    // consulted. It is Transform.kernels[0] now.
    //
    // THE DISTINCTION THAT MADE IT POSSIBLE: input dimension is not input
    // channel count. An identity RGB->RGB conversion still has three input
    // channels; it needs no 3-D kernel because there is nothing to
    // interpolate. Transform sets inputDimension to 0 and hands over.

    const { eIntent } = require('../src/main');

    function identity(opts){
        const t = new Transform(Object.assign({ dataFormat: 'int8' }, opts));
        t.create('*sRGB', '*sRGB', eIntent.relative);
        return t;
    }

    test('an identity pair selects kernel 0, and says so', () => {
        const t = identity();
        expect(t.isIdentity).toBe(true);
        expect(t.inputDimension).toBe(0);
        expect(t.inputChannels).toBe(3);        // still three channels
        expect(t.kernelInfo().name).toBe('kernelIdentity');
    });

    test('the kernel builds the pipeline, and create() derives the flag from it', () => {
        const t = identity();
        expect(t.pipeline.length).toBeGreaterThan(0);
        expect(t.pipelineCreated).toBe(true);
    });

    test('a kernel whose init() throws leaves pipelineCreated false, not a silent empty pipeline', () => {
        // _initKernel swallows a throwing init() so one bad kernel cannot
        // break create(). For a kernel that BUILDS the pipeline that would
        // otherwise leave nothing behind and no sign of it, which is why the
        // flag is derived rather than asserted.
        const restore = snapshot(0, 0);
        const warn = console.warn;
        console.warn = () => {};
        const warned = Transform._warnedKernelInit;
        try {
            const broken = Object.create(Transform.kernels[0]);
            broken.name = 'test-throwing-identity';
            broken.init = function(){ throw new Error('deliberate'); };
            Transform.kernels[0] = broken;

            const t = identity();
            expect(t.pipeline.length).toBe(0);
            expect(t.pipelineCreated).toBe(false);
        } finally {
            Transform._warnedKernelInit = warned;
            console.warn = warn;
            restore();
        }
    });

    test('copies, through both surfaces, and they agree', () => {
        const t = identity();
        const px = new Uint8ClampedArray([10, 20, 30, 200, 150, 100]);
        expect(Array.from(t.transformArray(px, false, false, false, 2)))
            .toEqual([10, 20, 30, 200, 150, 100]);
        expect(t.transform([10, 20, 30], false)).toEqual([10, 20, 30]);
    });

    test('array() honours alpha the same way every other kernel does', () => {
        const t = identity();
        const withA = new Uint8ClampedArray([10, 20, 30, 77]);
        expect(Array.from(t.transformArray(withA, true, true, true, 1)))
            .toEqual([10, 20, 30, 77]);                       // preserved
        expect(Array.from(t.transformArray(withA, true, true, false, 1)))
            .toEqual([10, 20, 30, 255]);                      // opaque
        expect(Array.from(t.transformArray(withA, true, false, false, 1)))
            .toEqual([10, 20, 30]);                           // dropped
    });

    test('swapping kernel 0 changes what identity does, with no edit to Transform', () => {
        // The point of the slot. A stranger's identity kernel can return any
        // pipeline it likes -- or ignore the pipeline and answer differently.
        const restore = snapshot(0, 0);
        try {
            const inverting = Object.create(Transform.kernels[0]);
            inverting.name = 'test-inverting-identity';
            inverting.array = function(input, output, px, lut, inA, outA, preserve){
                const n = this.transform.inputChannels;
                output = output || new Uint8ClampedArray(px * n);
                for(let i = 0; i < px * n; i++) output[i] = 255 - input[i];
                return output;
            };
            Transform.kernels[0] = inverting;

            const t = identity();
            expect(t.kernelInfo().name).toBe('kernelIdentity');   // inherited info()
            expect(Array.from(t.transformArray(new Uint8ClampedArray([0, 10, 255]), false, false, false, 1)))
                .toEqual([255, 245, 0]);
        } finally { restore(); }
    });

    test('release() is safe and holds nothing', () => {
        const t = identity();
        expect(() => t.kernel.release()).not.toThrow();
        expect(t.kernel.arrayFnBig).toBeNull();   // never resolves a run
    });
});

describe('int16 wide output reaches float instead of throwing', () => {

    // buildIntLut() produces no table above 4 output channels, and the u16
    // dispatch ladder had no float rung -- so EVERY dataFormat:'int16'
    // conversion into a 5-or-more-channel profile threw, while the same
    // conversion at int8 worked because the u8 ladder degrades to float.
    //
    // Float is a legal landing point for an int16 mode: lut.outputScale is
    // folded to 65535 and the float run scales at call time. The guard that
    // threw was written for the case where a u16 run EXISTS and the caller
    // simply did not build its table -- it should never have covered the case
    // where no u16 run exists at all.
    //
    // Found by the first int16 run of bench/lcms-comparison/accuracy_b2a.js,
    // on a 6-channel profile. Nothing in this repo could reach it before,
    // because there were no profiles above 4 channels.

    const t3 = require('../src/kernels/3d/kernel3D_table.js');
    const t4 = require('../src/kernels/4d/kernel4D_table.js');
    const SLOTS = ['wasmTetra3D', 'wasmTetra3DSimd', 'wasmTetra3DInt16', 'wasmTetra3DInt16Simd',
                   'wasmTetra4D', 'wasmTetra4DSimd', 'wasmTetra4DInt16', 'wasmTetra4DInt16Simd'];

    function kernelFor(mode, outputChannels){
        const k = { transform: { lutMode: mode, outputChannels } };
        for(const s of SLOTS) k[s] = {};
        return k;
    }
    const lutFor = (inCh, outCh, intLut) =>
        ({ inputChannels: inCh, outputChannels: outCh, intLut: intLut ? {} : null });

    const MODES = ['int16', 'int16-wasm-scalar', 'int16-wasm-simd'];

    test('wide output with NO intLut resolves to float rather than throwing', () => {
        for(const [dim, mod] of [[3, t3], [4, t4]]){
            for(const mode of MODES){
                for(const outCh of [5, 6, 8, 12, 15]){
                    const picked = mod.resolve(kernelFor(mode, outCh), lutFor(dim, outCh, false));
                    expect(picked.bigName).toBe('fl_' + dim + '_n');
                    expect(picked.smallName).toBe('fl_' + dim + '_n');
                }
            }
        }
    });

    test('NARROW output with no intLut still throws — a u16 run exists, its table does not', () => {
        for(const [dim, mod] of [[3, t3], [4, t4]]){
            for(const mode of MODES){
                for(const outCh of [3, 4]){
                    expect(() => mod.resolve(kernelFor(mode, outCh), lutFor(dim, outCh, false)))
                        .toThrow(/fallback chain exhausted/);
                }
            }
        }
    });

    test('end to end: int16 into a wide profile converts instead of throwing', () => {
        const path = require('path');
        const fs = require('fs');
        const { eIntent } = require('../src/main');
        const file = path.join(__dirname, 'profiles', 'synthetic_6clr_b2a_g17.icc');
        const prof = new Profile();
        prof.loadBinary(new Uint8Array(fs.readFileSync(file)));

        const t = new Transform({ dataFormat: 'int16', buildLut: true });
        t.create('*sRGB', prof, eIntent.relative);
        expect(t.kernel.arrayFnBigName).toBe('fl_3_n');

        const out = t.transformArray(new Uint16Array([2570, 5140, 7710]), false, false, false, 1);
        expect(out.length).toBe(6);
        expect(out).toBeInstanceOf(Uint16Array);
        for(const v of out) expect(v).toBeGreaterThan(0);
    });
});
