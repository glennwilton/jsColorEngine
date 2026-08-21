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
