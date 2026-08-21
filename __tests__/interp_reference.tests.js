/**
 * The reference implementations, and what they are for.
 *
 * `tetrahedralInterp3D_Master` and `tetrahedralInterp4D_3or4Ch_Master` are the
 * original, easy-to-read tetrahedral interpolators, with the lookup() and
 * sub16() helpers as separate functions. They are not production code — nothing
 * selects them, and the optimised variants are roughly 70% faster — and their
 * JSDoc has always said they are "the reference against which the optimised
 * variants are tested".
 *
 * Nothing actually tested that. This suite does.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS. The unrolled variants exist because a
 * generic loop over output channels runs 10-20x slower, so `_3Ch`, `_4Ch` and
 * `_NCh` hand-specialise the same maths three ways. Hand-unrolling is exactly
 * where an off-by-one in a grid index or a dropped clamp hides: the output stays
 * plausible, no test fails, and the error is a fraction of an LSB somewhere in
 * the middle of a gamut. A reference implementation is the only thing that
 * catches that class of bug, and it can only catch it if something runs it.
 *
 * It also stops the references being deleted. Code nothing calls looks like dead
 * code; code a test calls is load-bearing.
 *
 * The bar is EXACT equality, not a tolerance. These are the same operations in
 * the same order — the optimised forms hoist and inline, they do not reassociate
 * — so any difference at all is a bug rather than drift.
 */
'use strict';

const { Transform } = require('../src/main');
const interp = require('../src/interp');

// Stage functions are invoked as stage.funct.call(transform, ...), and the 4-D
// reference reaches its 3-D sibling through `this`. The prototype is the
// receiver that carries them, so bind to it here exactly as a stage would.
const T = Transform.prototype;

// Deterministic, so a failure is reproducible from the test name alone.
function lcg(seed){
    let s = seed >>> 0;
    return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function makeLut(dims, gridPoints, outputChannels, seed){
    const cells = Math.pow(gridPoints, dims) * outputChannels;
    const CLUT = new Float64Array(cells);
    const rnd = lcg(seed);
    // Random rather than smooth: a smooth ramp hides index errors, because a
    // neighbouring cell holds nearly the right answer.
    for(let i = 0; i < cells; i++) CLUT[i] = rnd();

    // A LUT carries TWO families of stride, and the interpolators disagree
    // about which they use. `_Master` derives what it needs from gridPoints[0];
    // the optimised variants read precomputed g1/g2/g3 (cumulative CELL counts)
    // and go0..go3 (the same scaled by output channels). Supplying only one
    // family yields NaN rather than an error — which is how this fixture failed
    // the first time it ran, and is worth knowing before hand-building a LUT.
    const lut = {
        inputChannels: dims, outputChannels,
        gridPoints: new Array(dims).fill(gridPoints),
        CLUT, inputScale: 1, outputScale: 1,
        g1: gridPoints,
        g2: gridPoints * gridPoints,
        g3: gridPoints * gridPoints * gridPoints,
        go0: outputChannels,
        go1: gridPoints * outputChannels,
        go2: gridPoints * gridPoints * outputChannels,
    };
    if(dims === 4){
        lut.g4  = gridPoints * gridPoints * gridPoints * gridPoints;
        lut.go3 = gridPoints * gridPoints * gridPoints * outputChannels;
    }
    return lut;
}

/** Grid boundaries, and a hair either side — where unrolled code diverges. */
function edgeValues(gridPoints){
    const step = 1 / (gridPoints - 1);
    const e = 1e-12;
    return [0, e, step - e, step, step + e, 0.5, 0.5 + e, 1 - step, 1 - e, 1];
}

describe('optimised interpolators match the reference implementation', () => {

    describe('3D tetrahedral', () => {

        // WHAT THE ORACLE COVERS. tetrahedralInterp3D_Master handles 3 and 4
        // output channels; past that it silently returns 4 values, because its
        // lookup helper is built around a 4-element vector. So `_NCh` is
        // compared against it at 3 and 4 channels — which does exercise the
        // generic code path — and the 5+ channel case has NO reference
        // implementation. See the explicit test for that gap below.
        const variants = [
            [3, 'tetrahedralInterp3D_3Ch'],
            [4, 'tetrahedralInterp3D_4Ch'],
            [3, 'tetrahedralInterp3D_NCh'],
            [4, 'tetrahedralInterp3D_NCh'],
        ];

        for(const [outputChannels, variant] of variants){
            for(const gridPoints of [17, 33]){
                test(`_Master vs ${variant} at ${outputChannels}ch, ${gridPoints}^3 grid`, () => {
                    const lut = makeLut(3, gridPoints, outputChannels, 12345);
                    const fast = interp[variant];
                    const rnd = lcg(999);

                    for(let i = 0; i < 2000; i++){
                        const input = [rnd(), rnd(), rnd()];
                        const ref = interp.tetrahedralInterp3D_Master.call(T, input, lut, 0);
                        const got = fast.call(T, input, lut);
                        for(let c = 0; c < outputChannels; c++){
                            expect(got[c]).toBe(ref[c]);
                        }
                    }
                });
            }
        }

        test('_Master vs _3or4Ch — the interpolationFast:false path', () => {
            // _3or4Ch is what interpolationFast:false actually selects; _Master
            // is what _3or4Ch was optimised FROM. Both are reference-grade, so
            // the pair has to agree too.
            for(const outputChannels of [3, 4]){
                const lut = makeLut(3, 33, outputChannels, 4242);
                const rnd = lcg(24680);
                for(let i = 0; i < 2000; i++){
                    const input = [rnd(), rnd(), rnd()];
                    const ref = interp.tetrahedralInterp3D_Master.call(T, input, lut, 0);
                    const got = interp.tetrahedralInterp3D_3or4Ch.call(T, input, lut, 0);
                    for(let c = 0; c < outputChannels; c++) expect(got[c]).toBe(ref[c]);
                }
            }
        });

        test('agreement holds at grid boundaries and just either side', () => {
            const gridPoints = 17;
            const lut = makeLut(3, gridPoints, 4, 555);
            const edges = edgeValues(gridPoints);
            for(const a of edges) for(const b of edges) for(const c of edges){
                const input = [a, b, c];
                const ref = interp.tetrahedralInterp3D_Master.call(T, input, lut, 0);
                const got = interp.tetrahedralInterp3D_4Ch.call(T, input, lut);
                for(let o = 0; o < 4; o++) expect(got[o]).toBe(ref[o]);
            }
        });
    });

    describe('4D tetrahedral', () => {

        for(const outputChannels of [3, 4]){
            for(const gridPoints of [9, 17]){
                const name = outputChannels === 3 ? 'tetrahedralInterp4D_3Ch' : 'tetrahedralInterp4D_4Ch';
                test(`_Master vs ${name}, ${gridPoints}^4 grid`, () => {
                    const lut = makeLut(4, gridPoints, outputChannels, 777);
                    const fast = interp[name];
                    const rnd = lcg(31337);
                    for(let i = 0; i < 1500; i++){
                        const input = [rnd(), rnd(), rnd(), rnd()];
                        const ref = interp.tetrahedralInterp4D_3or4Ch_Master.call(T, input, lut);
                        const got = fast.call(T, input, lut);
                        for(let c = 0; c < outputChannels; c++) expect(got[c]).toBe(ref[c]);
                    }
                });
            }
        }

        test('agreement holds at grid boundaries, including the K axis', () => {
            const gridPoints = 17;
            const lut = makeLut(4, gridPoints, 4, 8080);
            const edges = edgeValues(gridPoints);
            const coarse = [0, 1 / (gridPoints - 1), 0.5, 1];
            for(const k of edges) for(const a of edges) for(const b of coarse) for(const c of coarse){
                const input = [k, a, b, c];
                const ref = interp.tetrahedralInterp4D_3or4Ch_Master.call(T, input, lut);
                const got = interp.tetrahedralInterp4D_4Ch.call(T, input, lut);
                for(let o = 0; o < 4; o++) expect(got[o]).toBe(ref[o]);
            }
        });
    });

    test('the 5+ output channel path has no reference implementation', () => {
        // Documenting a real gap rather than hiding it.
        //
        // tetrahedralInterp3D_NCh is what an RGB -> 6CLR / 7CLR n-colour
        // separation runs, and tetrahedralInterp3D_Master cannot check it:
        // asked for 6 channels it returns 4, silently, because its lookup
        // helper is built around a 4-element vector. Its generic loop IS
        // exercised above at 3 and 4 channels, so the indexing arithmetic is
        // covered; what is not covered is the channel loop past 4.
        //
        // This test asserts the limitation so nobody assumes coverage that is
        // not there. If a wider reference is ever written, delete this and add
        // the comparison.
        const lut = makeLut(3, 17, 6, 4321);
        const ref = interp.tetrahedralInterp3D_Master.call(T, [0.3, 0.6, 0.4], lut, 0);
        const got = interp.tetrahedralInterp3D_NCh.call(T, [0.3, 0.6, 0.4], lut);

        expect(got).toHaveLength(6);
        expect(ref).toHaveLength(4);           // the oracle stops at 4
        for(let c = 0; c < 4; c++) expect(got[c]).toBe(ref[c]);   // agrees where it can
    });

    test('the references are still reachable and still unselected', () => {
        // Both halves matter. Present, so the oracle exists; unselected, so no
        // production path pays for it. If a kernel ever starts returning one,
        // that is a deliberate choice and this test should be updated to say so.
        expect(typeof interp.tetrahedralInterp3D_Master).toBe('function');
        expect(typeof interp.tetrahedralInterp4D_3or4Ch_Master).toBe('function');

        const enc = require('../src/def').encoding;
        const selected = new Set();
        for(const method of ['tetrahedral', 'trilinear'])
            for(const fast of [true, false])
                for(const outputChannels of [3, 4, 6]){
                    selected.add(Transform.kernels[3].floatFor({ outputChannels }, {
                        inputEncoding: enc.device, useTrilinearFor3ChInput: true,
                        interpolation3D: method, fast }).funct.name);
                    selected.add(Transform.kernels[4].floatFor({ outputChannels }, {
                        interpolation4D: method, fast }).funct.name);
                }
        expect([...selected]).not.toContain('tetrahedralInterp3D_Master');
        expect([...selected]).not.toContain('tetrahedralInterp4D_3or4Ch_Master');
    });
});
