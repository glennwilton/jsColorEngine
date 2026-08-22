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
        // not there.
        //
        // WIDENING _Master IS NOT THE FIX. It is a useful oracle for the 3-D
        // unrolled variants because it is structurally different from them --
        // helpers as separate functions rather than inlined and specialised.
        // Extending it to N channels would just be our generic implementation
        // written a second time by the same hand, and two copies of one idea
        // share that idea's blind spots. tetrahedralInterp3D_NCh already IS
        // reference-grade; what it lacks is an outside opinion.
        //
        // The oracle is Little CMS, as it is for every other channel count in
        // bench/lcms_compat/. The blocker is input: real n-colour profiles are
        // licensed and cannot be committed. See the synthetic colour-wheel
        // profile plan in docs/NChannel.md.
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

describe('the N-channel array loops agree with their single-colour counterparts', () => {

    // v1.6 phase 4 inlined tetrahedralInterp3DArray_NCh_loop and
    // tetrahedralInterp4DArray_NCh_loop, which had been calling their
    // single-colour interpolator once per pixel. Those are the RGB -> 6CLR and
    // CMYK -> 6CLR n-colour separation paths.
    //
    // The single-colour function is the oracle here — it is the code the loop
    // was derived from, and it is separately checked against _Master above at
    // the channel counts _Master supports.
    //
    // The 4-D case earns particular attention. A 4-D interpolation evaluates
    // two 3-D ones at the bracketing K planes, and when interpK is true the
    // first pass produces an UNSCALED 0..1 intermediate that the second reads
    // back. The batch output is a Uint8ClampedArray, so writing that
    // intermediate into it would round to 0 or 1 and silently destroy it. The
    // loop keeps a float scratch for exactly that reason, and these tests cover
    // both sides of the interpK branch.

    function ndLut(dims, gridPoints, outputChannels, seed){
        const lut = makeLut(dims, gridPoints, outputChannels, seed);
        lut.inputScale = 1 / 255;
        lut.outputScale = 255;
        return lut;
    }

    function viaLoop(dims, lut, pixels, outputChannels){
        const loop = dims === 3 ? 'tetrahedralInterp3DArray_NCh_loop'
                                : 'tetrahedralInterp4DArray_NCh_loop';
        const out = new Uint8ClampedArray((pixels.length / dims) * outputChannels);
        T[loop].call(T, pixels, 0, out, 0, pixels.length / dims, lut, false, false, false);
        return out;
    }

    function viaSingle(dims, lut, pixels, outputChannels){
        const fn = dims === 3 ? interp.tetrahedralInterp3D_NCh : interp.tetrahedralInterp4D_NCh;
        const n = pixels.length / dims;
        const out = new Uint8ClampedArray(n * outputChannels);
        for(let p = 0, w = 0; p < n; p++){
            const colour = [];
            for(let c = 0; c < dims; c++) colour.push(pixels[p * dims + c]);
            const r = fn.call(T, colour, lut);
            for(let c = 0; c < outputChannels; c++) out[w++] = r[c];
        }
        return out;
    }

    for(const [dims, gridPoints] of [[3, 33], [3, 17], [4, 17], [4, 9]]){
        for(const outputChannels of [5, 6, 8]){
            test(`${dims}D -> ${outputChannels}ch on a ${gridPoints}-point grid`, () => {
                const lut = ndLut(dims, gridPoints, outputChannels, 20260821);
                const n = 1024;
                const pixels = new Uint8ClampedArray(n * dims);
                for(let i = 0; i < pixels.length; i++) pixels[i] = (i * 61) & 255;

                expect(Array.from(viaLoop(dims, lut, pixels, outputChannels)))
                    .toEqual(Array.from(viaSingle(dims, lut, pixels, outputChannels)));
            });
        }
    }

    test('4D agrees on both sides of the interpK branch, including the K edge', () => {
        // interpK is false only when K lands exactly on the last grid point, so
        // the K=255 column is the one that exercises the "scratch already holds
        // the scaled value" path. It is a single column of the input space and
        // trivially missed by random sampling.
        const lut = ndLut(4, 17, 6, 99);
        const ks = [0, 1, 15, 16, 127, 200, 253, 254, 255];
        const pixels = new Uint8ClampedArray(ks.length * 4);
        ks.forEach((k, i) => {
            pixels[i * 4]     = k;
            pixels[i * 4 + 1] = 10;
            pixels[i * 4 + 2] = 200;
            pixels[i * 4 + 3] = 60;
        });
        expect(Array.from(viaLoop(4, lut, pixels, 6)))
            .toEqual(Array.from(viaSingle(4, lut, pixels, 6)));
    });

    test('alpha handling matches across every mode', () => {
        for(const dims of [3, 4]){
            const outputChannels = 6;
            const lut = ndLut(dims, dims === 3 ? 17 : 9, outputChannels, 555);
            const n = 256;

            for(const [inAlpha, outAlpha, preserve] of
                [[false, false, false], [true, true, true], [true, false, false], [false, true, false]]){
                const inBPP  = inAlpha ? dims + 1 : dims;
                const outBPP = (outAlpha || preserve) ? outputChannels + 1 : outputChannels;
                const pixels = new Uint8ClampedArray(n * inBPP);
                for(let i = 0; i < pixels.length; i++) pixels[i] = (i * 37) & 255;

                const loop = dims === 3 ? 'tetrahedralInterp3DArray_NCh_loop'
                                        : 'tetrahedralInterp4DArray_NCh_loop';
                const out = new Uint8ClampedArray(n * outBPP);
                T[loop].call(T, pixels, 0, out, 0, n, lut, inAlpha, outAlpha, preserve);

                // Every colour channel written, and the alpha slot carrying what
                // the mode says it should.
                expect(out.length).toBe(n * outBPP);
                if(preserve){
                    expect(out[outputChannels]).toBe(pixels[dims]);
                } else if(outAlpha){
                    expect(out[outputChannels]).toBe(255);
                }
            }
        }
    });
});

describe('the 8-bit input contract — inputScale 1/255, raw 0..255 colours', () => {

    // THE DIAGONAL THIS SUITE WAS MISSING, AND WHAT FELL THROUGH IT.
    //
    // Everything above ran the specialised variants against _Master with
    // inputScale = 1, i.e. device 0..1 colours. The N-channel block below ran
    // inputScale = 1/255 -- but only against _NCh, at 5, 6 and 8 output
    // channels. So the specialised _3Ch and _4Ch forms, which are what a
    // 3-channel or 4-channel output actually selects, were never once run at
    // 1/255 by anything.
    //
    // They were broken there. All four clamped the input to 0..1 BEFORE
    // applying gridPointsScale:
    //
    //     input0 = Math.min(1, Math.max(0, input[0]));
    //     px     = input0 * gridPointsScale;
    //
    // With inputScale = 1/255 every value from 1 to 255 collapses to 1, lands
    // on the same grid cell, and returns the same colour. transform() on a
    // buildLut:true + dataFormat:"int8" Transform gave a CONSTANT for every
    // input -- [2,2,2] for sRGB->AdobeRGB, whatever the colour. The batch path
    // was correct throughout, because the array loops are separate code, so
    // the two disagreed and nothing noticed.
    //
    // A test at inputScale 1 cannot see it: clamping to 1 is a no-op when the
    // contract already says 0..1. That is the whole reason this block exists
    // as a scale dimension rather than a regression case for one function --
    // the same blind spot would hide the next one.

    function scaled(dims, gridPoints, outputChannels, seed){
        const lut = makeLut(dims, gridPoints, outputChannels, seed);
        lut.inputScale  = 1 / 255;   // callers hand over raw 0..255
        lut.outputScale = 1;         // keep the comparison in CLUT units
        return lut;
    }

    describe('3D', () => {
        const variants = [
            [3, 'tetrahedralInterp3D_3Ch'],
            [4, 'tetrahedralInterp3D_4Ch'],
            [3, 'tetrahedralInterp3D_NCh'],
            [4, 'tetrahedralInterp3D_NCh'],
        ];
        for(const [outputChannels, variant] of variants){
            for(const gridPoints of [17, 33]){
                test(`_Master vs ${variant} at ${outputChannels}ch, ${gridPoints}^3 grid`, () => {
                    const lut  = scaled(3, gridPoints, outputChannels, 12345);
                    const fast = interp[variant];
                    const rnd  = lcg(999);
                    for(let i = 0; i < 2000; i++){
                        const input = [rnd() * 255, rnd() * 255, rnd() * 255];
                        const ref = interp.tetrahedralInterp3D_Master.call(T, input, lut, 0);
                        const got = fast.call(T, input, lut);
                        for(let c = 0; c < outputChannels; c++) expect(got[c]).toBe(ref[c]);
                    }
                });
            }
        }
    });

    describe('4D', () => {
        for(const outputChannels of [3, 4]){
            for(const gridPoints of [9, 17]){
                const name = outputChannels === 3 ? 'tetrahedralInterp4D_3Ch' : 'tetrahedralInterp4D_4Ch';
                test(`_Master vs ${name}, ${gridPoints}^4 grid`, () => {
                    const lut  = scaled(4, gridPoints, outputChannels, 777);
                    const fast = interp[name];
                    const rnd  = lcg(31337);
                    for(let i = 0; i < 1500; i++){
                        const input = [rnd() * 255, rnd() * 255, rnd() * 255, rnd() * 255];
                        const ref = interp.tetrahedralInterp4D_3or4Ch_Master.call(T, input, lut);
                        const got = fast.call(T, input, lut);
                        for(let c = 0; c < outputChannels; c++) expect(got[c]).toBe(ref[c]);
                    }
                });
            }
        }
    });

    test('the whole 8-bit range is used, not collapsed onto one cell', () => {
        // The direct statement of the bug, independent of any reference: a
        // sweep across 0..255 must produce many distinct answers. The variants
        // returned exactly two -- one for 0, one for everything else.
        const cases = [
            [3, 'tetrahedralInterp3D_3Ch', 3], [3, 'tetrahedralInterp3D_4Ch', 4],
            [4, 'tetrahedralInterp4D_3Ch', 3], [4, 'tetrahedralInterp4D_4Ch', 4],
        ];
        for(const [dims, name, outputChannels] of cases){
            const lut = scaled(dims, 17, outputChannels, 4242);
            const seen = new Set();
            for(let v = 0; v <= 255; v += 5){
                const got = interp[name].call(T, new Array(dims).fill(v), lut);
                seen.add(got.slice(0, outputChannels).join(','));
            }
            expect(seen.size).toBeGreaterThan(40);
        }
    });

    test('out-of-range input still clamps, at the grid edges', () => {
        // Clamping moved into grid space; it did not go away. Below 0 and
        // above 255 must pin to the first and last cell.
        for(const [dims, name, outputChannels] of [
            [3, 'tetrahedralInterp3D_3Ch', 3], [4, 'tetrahedralInterp4D_4Ch', 4]]){
            const lut = scaled(dims, 17, outputChannels, 555);
            const fn  = interp[name];
            const at  = v => Array.from(fn.call(T, new Array(dims).fill(v), lut)).slice(0, outputChannels);
            expect(at(-50)).toEqual(at(0));
            expect(at(400)).toEqual(at(255));
        }
    });
});

describe('single colour and batch agree on a real profile pair', () => {

    // The end-to-end shape of the same bug, which is how it was found:
    // transform() and transformArray() disagreeing on a buildLut:true,
    // dataFormat:"int8" Transform. One pair per specialised variant.

    const Profile = require('../src/Profile');
    const { eIntent } = require('../src/main');
    const path = require('path');

    const cmyk = new Profile();
    cmyk.loadFile(path.join(__dirname, 'GRACoL2006_Coated1v2.icc'));

    for(const [a, b, label] of [
        ['*sRGB', '*AdobeRGB', 'RGB→RGB  (3D_3Ch)'],
        ['*sRGB', cmyk,        'RGB→CMYK (3D_4Ch)'],
        [cmyk,    '*sRGB',     'CMYK→RGB  (4D_3Ch)'],
        [cmyk,    cmyk,        'CMYK→CMYK (4D_4Ch)'],
    ]){
        test(label, () => {
            const t = new Transform({ dataFormat: 'int8', buildLut: true });
            t.create(a, b, eIntent.relative);
            const inCh = t.inputChannels;

            for(const v of [0, 1, 17, 64, 128, 200, 254, 255]){
                const px     = new Array(inCh).fill(v);
                const single = t.transform(px, false).map(x => Math.round(x));

                const flat = new Uint8ClampedArray(inCh);
                flat.set(px);
                const batch = Array.from(t.transformArray(flat, false, false, false, 1));
                const route = label.indexOf('CMYK→') === 0 ? 'kernel4D' : 'kernel3D';
                expect(t.lastUsedKernel).toBe(route);

                // 1 LSB, because the batch path rounds through a
                // Uint8ClampedArray (half-to-even) and transform() does not.
                single.forEach((got, c) => {
                    expect(Math.abs(got - batch[c])).toBeLessThanOrEqual(1);
                });
            }
        });
    }
});
