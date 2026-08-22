/**
 * Every input width into every output width, 1 to 15.
 *
 * 225 combinations, and the bar is deliberately low: does it produce a
 * plausible answer without throwing? Not "is it fast", not "does it match
 * another CMS" — those are bench/lcms-comparison/accuracy_*.js. This is the
 * one that says the engine can do what it claims across its whole declared
 * range.
 *
 * WHY IT DID NOT EXIST BEFORE. It needs profiles at fifteen channel widths,
 * and real ICC profiles are licensed — this repo ships two, at 3 and 4
 * channels. Everything else had never been converted at all, in either
 * direction, so a whole quadrant of the engine's advertised range had never
 * run. Two of the routes this opened up were found on the first attempt:
 * `transformArray()` had no general case above 4 input channels, and
 * `dataFormat: 'int16'` had no route above 4 output channels.
 *
 * FIFTEEN FILES, NOT 225. Each synthetic profile carries BOTH tables — A2B for
 * device→PCS and B2A for PCS→device — which is what a real device profile is.
 * Running profile A's A2B into profile B's B2A gives every pair.
 *
 * Regenerate with `node scripts/make_test_profiles.js`. See
 * docs/deepdive/SyntheticProfiles.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Profile = require('../src/Profile');
const { Transform, eIntent } = require('../src/main');
const { routeForInputChannels } = require('./helpers/expectRoute');

const DIR = path.join(__dirname, 'profiles');
const WIDTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

// Loaded once. Fifteen profiles is 4.6 MB and reloading them per combination
// would dominate the runtime of the whole suite.
const profiles = {};
for(const n of WIDTHS){
    const file = path.join(DIR, 'synthetic_' + String(n).padStart(2, '0') + 'ch.icc');
    const p = new Profile();
    p.loadBinary(new Uint8Array(fs.readFileSync(file)));
    profiles[n] = p;
}

/** Three pixels, deterministic, spanning the range including both ends. */
function pixels(channels, u16){
    const rows = [
        new Array(channels).fill(0),
        new Array(channels).fill(0).map((_, i) => ((i * 37) + 90) & 0xff),
        new Array(channels).fill(255),
    ];
    const flat = u16 ? new Uint16Array(3 * channels) : new Uint8ClampedArray(3 * channels);
    let w = 0;
    for(const row of rows) for(const v of row) flat[w++] = u16 ? v * 257 : v;
    return flat;
}

describe('the channel matrix — 1..15 in, 1..15 out', () => {

    test('every profile loaded, and carries both tables', () => {
        for(const n of WIDTHS){
            const p = profiles[n];
            expect(p.loaded).toBe(true);
            expect(p.A2B[0]).toBeTruthy();
            expect(p.B2A[0]).toBeTruthy();
            expect(p.A2B[0].inputChannels).toBe(n);      // device -> PCS
            expect(p.B2A[0].outputChannels).toBe(n);     // PCS -> device
        }
    });

    describe.each(WIDTHS)('%i channels in', (inCh) => {

        test('converts into every output width, 1 to 15', () => {
            const input = pixels(inCh, false);
            const failures = [];

            for(const outCh of WIDTHS){
                try {
                    const t = new Transform({ dataFormat: 'int8', buildLut: true });
                    t.create(profiles[inCh], profiles[outCh], eIntent.relative);

                    // Single colour, and the batch path, on the same Transform.
                    const single = t.transform([...input.slice(0, inCh)], false);
                    const batch  = t.transformArray(input, false, false, false, 3);
                    const route = routeForInputChannels(inCh, inCh === outCh);
                    if(t.lastUsedKernel !== route){
                        failures.push(inCh + '->' + outCh + ': lastUsedKernel '
                            + t.lastUsedKernel + ', wanted ' + route);
                        continue;
                    }

                    if(!single || single.length !== outCh){
                        failures.push(inCh + '->' + outCh + ': transform() gave '
                            + (single ? single.length : single) + ' channels');
                        continue;
                    }
                    if(!batch || batch.length !== 3 * outCh){
                        failures.push(inCh + '->' + outCh + ': transformArray() gave '
                            + (batch ? batch.length : batch) + ', wanted ' + (3 * outCh));
                        continue;
                    }
                    for(let i = 0; i < batch.length; i++){
                        if(!Number.isFinite(batch[i])){
                            failures.push(inCh + '->' + outCh + ': non-finite at ' + i);
                            break;
                        }
                    }
                    // The two surfaces must agree. 1 LSB, because the batch
                    // path rounds through a Uint8ClampedArray (half-to-even)
                    // and transform() does not.
                    for(let c = 0; c < outCh; c++){
                        if(Math.abs(Math.round(single[c]) - batch[c]) > 1){
                            failures.push(inCh + '->' + outCh + ': ch' + c + ' single '
                                + Math.round(single[c]) + ' vs batch ' + batch[c]);
                            break;
                        }
                    }
                } catch(e){
                    failures.push(inCh + '->' + outCh + ': ' + String(e).slice(0, 80));
                }
            }

            expect(failures).toEqual([]);
        });

        test('int16 reaches every output width too', () => {
            // The depth that could not do this at all until v1.6: the u16
            // dispatch ladder had no float terminus, so anything above 4
            // output channels threw while int8 degraded quietly.
            const input = pixels(inCh, true);
            const failures = [];

            for(const outCh of WIDTHS){
                try {
                    const t = new Transform({ dataFormat: 'int16', buildLut: true });
                    t.create(profiles[inCh], profiles[outCh], eIntent.relative);
                    const out = t.transformArray(input, false, false, false, 3);
                    const route = routeForInputChannels(inCh, inCh === outCh);
                    if(t.lastUsedKernel !== route){
                        failures.push(inCh + '->' + outCh + ': lastUsedKernel '
                            + t.lastUsedKernel + ', wanted ' + route);
                        continue;
                    }
                    if(!out || out.length !== 3 * outCh){
                        failures.push(inCh + '->' + outCh + ': got '
                            + (out ? out.length : out) + ', wanted ' + (3 * outCh));
                        continue;
                    }
                    if(!(out instanceof Uint16Array)){
                        failures.push(inCh + '->' + outCh + ': ' + out.constructor.name
                            + ', wanted Uint16Array');
                    }
                } catch(e){
                    failures.push(inCh + '->' + outCh + ': ' + String(e).slice(0, 80));
                }
            }

            expect(failures).toEqual([]);
        });
    });
});

describe('KernelND.array — the surface Transform does not normally reach', () => {

    // provideLut() declines for 5-15 channel input -- an N-D CLUT bake is
    // grid^n cells -- so Transform walks the per-pixel pipeline and this array
    // path is only entered through a LUT attached OUT OF BAND, via setLut() or
    // a direct assignment. That is a supported route (Transform.js has a
    // safety net for exactly it) and nothing had ever taken it.
    //
    // Two things it needed. It divided the input by 255 and multiplied the
    // result by 255 on top of the LUT's own inputScale/outputScale, which is
    // only correct when both are 1 -- against a normal LUT everything landed
    // near grid cell 0 and came back saturated, 187 LSB from the single-colour
    // path on the same table. And it named tetrahedralInterpND_NCh directly,
    // so past the split at 11 channels the two surfaces would have run
    // different interpolators over the same data.
    //
    // MEASURED WHILE HERE, because it answers whether declining the LUT costs
    // anything: a LUT-backed array() beats the pipeline walk by only 1.1x to
    // 1.3x. Both call the same interpolator per pixel, so the array loop saves
    // just the other seven pipeline stages -- about 0.2us/px. Against a 20-97ms
    // build and 1.4-3.8 MB of table, declining is the right answer.

    const KernelND = require('../src/kernels/nd/KernelND.js');

    function ndLut(inCh, outCh, grid){
        const cells = Math.pow(grid, inCh);
        const CLUT = new Float64Array(cells * outCh);
        // Deterministic and unsmooth: a ramp would let an index error land on
        // a neighbour holding nearly the right answer.
        for(let i = 0; i < CLUT.length; i++) CLUT[i] = ((i * 2654435761) >>> 0) / 4294967295;
        return { inputChannels: inCh, outputChannels: outCh,
                 gridPoints: new Array(inCh).fill(grid),
                 CLUT, inputScale: 1 / 255, outputScale: 255, g1: grid, intLut: null };
    }

    // Both sides of the interpolator split.
    const CASES = [[5, 3, 9], [6, 4, 7], [8, 3, 4], [11, 3, 2], [15, 3, 2]];

    test.each(CASES)('%i -> %i channels: array() matches the single-colour path exactly',
        (inCh, outCh, grid) => {
            const lut = ndLut(inCh, outCh, grid);
            const t = new Transform({ dataFormat: 'int8' });
            t.lut = lut;
            t.inputChannels = inCh;
            t.outputChannels = outCh;
            t.setKernel(inCh);

            const N = 64;
            const px = new Uint8ClampedArray(N * inCh);
            for(let i = 0; i < px.length; i++) px[i] = (i * 37) & 255;

            const batch = t.kernel.array(px, undefined, N, lut, false, false, false);

            const fn = KernelND.floatFor(lut, {}).funct;
            const single = [];
            for(let p = 0; p < N; p++){
                const colour = [];
                for(let c = 0; c < inCh; c++) colour.push(px[p * inCh + c]);
                const r = fn.call(t, colour, lut);
                for(let o = 0; o < outCh; o++){
                    single.push(Math.max(0, Math.min(255, Math.round(r[o]))));
                }
            }

            expect(batch.length).toBe(N * outCh);
            expect(Array.from(batch)).toEqual(single);
        });

    test('it uses the same interpolator floatFor would, on both sides of the split', () => {
        for(const [inCh] of CASES){
            const expected = KernelND.interpolatorFor(inCh);
            expect(expected).toBe(inCh >= KernelND.simplexFrom ? 'simplex' : 'tetrahedral');
        }
        // The split is what makes the agreement test above load-bearing: at 11
        // and 15 it is the simplex on both surfaces, at 5-8 the tetrahedral.
        expect(KernelND.interpolatorFor(10)).toBe('tetrahedral');
        expect(KernelND.interpolatorFor(11)).toBe('simplex');
    });
});
