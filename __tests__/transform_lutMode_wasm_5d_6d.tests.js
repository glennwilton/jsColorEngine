/**
 * 5D / 6D int8 WASM scalar — bit-exact vs JS int, LSB vs float ND.
 *
 * Skip with SKIP_WASM_TESTS=1.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Profile = require('../src/Profile');
const { Transform, eIntent } = require('../src/main');

const describeIfWasm = (typeof WebAssembly !== 'undefined' && !process.env.SKIP_WASM_TESTS)
    ? describe
    : describe.skip;

const DIR = path.join(__dirname, 'profiles');

function loadN(n){
    const p = new Profile();
    p.loadBinary(new Uint8Array(fs.readFileSync(
        path.join(DIR, 'synthetic_' + String(n).padStart(2, '0') + 'ch.icc'))));
    return p;
}

function maxAbsDiff(a, b){
    let max = 0;
    for(let i = 0; i < a.length; i++){
        const d = Math.abs(a[i] - b[i]);
        if(d > max) max = d;
    }
    return max;
}

function pixels(channels, count){
    const out = new Uint8ClampedArray(count * channels);
    for(let p = 0; p < count; p++){
        for(let c = 0; c < channels; c++){
            if(p === 0) out[p * channels + c] = 0;
            else if(p === 1) out[p * channels + c] = 255;
            else out[p * channels + c] = ((p * 37 + c * 19) * 13) & 0xff;
        }
    }
    return out;
}

function makePair(inCh, lutMode){
    const src = loadN(inCh);
    const dst = loadN(3);
    const t = new Transform({
        dataFormat: 'int8',
        buildLut: true,
        lutMode: lutMode,
    });
    t.create(src, dst, eIntent.relative);
    return t;
}

describeIfWasm('5D / 6D int8 WASM scalar', () => {
    const prevMin = Transform.WASM_DISPATCH_MIN_PIXELS;
    beforeAll(() => { Transform.WASM_DISPATCH_MIN_PIXELS = 0; });
    afterAll(() => { Transform.WASM_DISPATCH_MIN_PIXELS = prevMin; });

    describe.each([5, 6])('%i-channel input', (inCh) => {
        const kernelName = inCh === 5 ? 'kernel5D' : 'kernel6D';
        const slot = inCh === 5 ? 'wasmTetra5D' : 'wasmTetra6D';

        test('create() with int-wasm-scalar runs WASM', () => {
            const t = makePair(inCh, 'int-wasm-scalar');
            expect(t.lutMode).toBe('int-wasm-scalar');
            expect(t.hasLut()).toBe(true);
            expect(t.lut.intLut).toBeTruthy();
            expect(t.lut.inputChannels).toBe(inCh);
            expect(t[slot]).toBeTruthy();
            expect(t.kernelInfo().name).toBe(kernelName);

            const input = pixels(inCh, 16);
            const before = t[slot].dispatchCount;
            const out = t.transformArray(input, false, false, false, 16);
            expect(t.lastUsedKernel).toBe(kernelName);
            expect(t[slot].dispatchCount).toBeGreaterThan(before);
            expect(out.length).toBe(16 * 3);
        });

        test('WASM is byte-identical to JS int (solid + mixed)', () => {
            const js = makePair(inCh, 'int');
            const wasm = makePair(inCh, 'int-wasm-scalar');
            const input = pixels(inCh, 32);
            const oJs = js.transformArray(input, false, false, false, 32);
            const before = wasm[slot].dispatchCount;
            const oWasm = wasm.transformArray(input, false, false, false, 32);
            expect(wasm[slot].dispatchCount).toBeGreaterThan(before);
            expect(maxAbsDiff(oJs, oWasm)).toBe(0);
        });

        test('int8 vs float ND stays within the 4D LSB budget', () => {
            const js = makePair(inCh, 'int');
            const fl = makePair(inCh, 'float');
            const input = pixels(inCh, 32);
            const oInt = js.transformArray(input, false, false, false, 32);
            const oFl = fl.transformArray(input, false, false, false, 32);
            // 4D int vs float is ≤1 LSB on GRACoL; extra peels keep the same budget.
            expect(maxAbsDiff(oInt, oFl)).toBeLessThanOrEqual(1);
        });
    });

    test('7-in stays KernelND, provideLut false, no 5/6 WASM load', () => {
        const src = loadN(7);
        const dst = loadN(3);
        const t = new Transform({
            dataFormat: 'int8',
            buildLut: true,
            lutMode: 'int-wasm-scalar',
        });
        t.create(src, dst, eIntent.relative);
        expect(t.kernel.name).toBe('kernelND');
        expect(t.lut).toBe(false);
        expect(t.wasmTetra5D).toBeNull();
        expect(t.wasmTetra6D).toBeNull();
        const input = pixels(7, 3);
        t.transformArray(input, false, false, false, 3);
        expect(t.lastUsedKernel).toBe('pipeline');
    });
});
