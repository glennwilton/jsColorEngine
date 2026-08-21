/**
 * Every input width into every output width, 1 to 15.
 *
 * 225 combinations, and the bar is deliberately low: does it produce a
 * plausible answer without throwing? Not "is it fast", not "does it match
 * another CMS" — those are bench/lcms-comparison/accuracy_*.js. This is the
 * one that says the engine can do what it claims across its whole declared
 * range.
 *
 * WHY IT DID NOT EXIST BEFORE. It needed profiles at fifteen channel widths,
 * and real ICC profiles are licensed — this repo ships two, at 3 and 4
 * channels. Everything else had never been converted at all, in either
 * direction, so a whole quadrant of the engine's advertised range had never
 * run. Two bugs found by the first n-channel oracle runs lived exactly there:
 * `transformArray()` returning an array of `undefined` above 4 input channels,
 * and `dataFormat: 'int16'` throwing outright above 4 output channels.
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
