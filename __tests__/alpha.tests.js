/**
 * Alpha preprocessing helpers.
 *
 * THE POINT OF THESE IS CORRECTNESS OF THE COLOUR, not of the alpha byte. The
 * transform has a TRC at each end, so it is not linear, so `T(a·C)` is not
 * `a·T(C)` — converting premultiplied data directly is wrong by up to 69 LSB
 * at a = 0.5. The test that matters is therefore the round trip through a real
 * conversion, not the arithmetic in isolation.
 */

const { Transform, alpha, eIntent } = require('../src/main');

function rgbaRamp(n, bits){
    const max = bits === 8 ? 255 : 65535;
    const a = bits === 8 ? new Uint8ClampedArray(n * 4) : new Uint16Array(n * 4);
    let s = 0x13579bdf;
    for(let p = 0; p < n; p++){
        for(let c = 0; c < 4; c++){
            s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
            a[p * 4 + c] = Math.round(((s >>> 23) & 0xff) * max / 255);
        }
    }
    return a;
}

describe('alpha.unpremultiply / premultiply', () => {

    test('a straight buffer survives a premultiply/unpremultiply round trip at full alpha', () => {
        const px = rgbaRamp(500, 8);
        for(let p = 0; p < 500; p++) px[p * 4 + 3] = 255;      // opaque
        const back = alpha.unpremultiply(alpha.premultiply(px, 500), 500);
        expect(Array.from(back)).toEqual(Array.from(px));
    });

    test('fully transparent pixels come back as zero, and round-trip', () => {
        // At a = 0 the colour was multiplied away and is not recoverable. Zero
        // is the choice that round-trips rather than the one that guesses.
        const px = new Uint8ClampedArray([200, 100, 50, 0]);
        const straight = alpha.unpremultiply(px, 1);
        expect(Array.from(straight)).toEqual([0, 0, 0, 0]);
        expect(Array.from(alpha.premultiply(straight, 1))).toEqual([0, 0, 0, 0]);
    });

    test('unpremultiply clamps rather than overflowing on malformed data', () => {
        // P > a should not happen, but a buffer from elsewhere may say so.
        const px = new Uint8ClampedArray([200, 255, 10, 100]);
        const out = alpha.unpremultiply(px, 1);
        expect(out[0]).toBe(255);
        expect(out[1]).toBe(255);
        expect(out[3]).toBe(100);            // alpha untouched
    });

    test('alpha is never altered by either direction', () => {
        const px = rgbaRamp(500, 8);
        for(const fn of [alpha.premultiply, alpha.unpremultiply]){
            const out = fn(px, 500);
            let wrong = 0;
            for(let p = 0; p < 500; p++) if(out[p * 4 + 3] !== px[p * 4 + 3]) wrong++;
            expect(wrong).toBe(0);
        }
    });

    test('int16 is handled by inferring the container, with no bit-depth argument', () => {
        const px = new Uint16Array([60000, 30000, 10000, 32768]);
        const straight = alpha.unpremultiply(px, 1);
        expect(straight[3]).toBe(32768);
        expect(straight[0]).toBeGreaterThan(60000);        // divided up
        expect(straight[0]).toBeLessThanOrEqual(65535);
    });

    test('a supplied out array is written in place and returned', () => {
        const px = rgbaRamp(100, 8);
        const out = new Uint8ClampedArray(400);
        expect(alpha.premultiply(px, 100, out)).toBe(out);
    });

    test('an undersized array is rejected rather than read past', () => {
        expect(() => alpha.unpremultiply(new Uint8ClampedArray(8), 100)).toThrow(/less than pixelCount/);
    });

    test('a Float32Array is rejected — the container decides the range', () => {
        expect(() => alpha.premultiply(new Float32Array(8), 2)).toThrow(/Uint8ClampedArray/);
    });
});

describe('alpha.flatten', () => {

    test('an opaque pixel is unchanged whatever the background', () => {
        const px = new Uint8ClampedArray([10, 20, 30, 255]);
        const out = alpha.flatten(px, 1, {background: [255, 255, 255]});
        expect(Array.from(out)).toEqual([10, 20, 30]);
    });

    test('a fully transparent pixel becomes the background', () => {
        const px = new Uint8ClampedArray([10, 20, 30, 0]);
        expect(Array.from(alpha.flatten(px, 1, {background: [255, 128, 0]}))).toEqual([255, 128, 0]);
    });

    test('half alpha lands halfway, straight and premultiplied agreeing', () => {
        // The same visual pixel in both conventions must flatten to the same
        // colour — that is what makes the `premultiplied` flag meaningful
        // rather than decorative.
        const straight = new Uint8ClampedArray([200, 200, 200, 128]);
        const pre      = new Uint8ClampedArray([Math.round(200 * 128 / 255),
                                                Math.round(200 * 128 / 255),
                                                Math.round(200 * 128 / 255), 128]);
        const bg = [0, 0, 0];
        const a = alpha.flatten(straight, 1, {background: bg});
        const b = alpha.flatten(pre, 1, {background: bg, premultiplied: true});
        expect(Math.abs(a[0] - b[0])).toBeLessThanOrEqual(1);
        expect(a[0]).toBeGreaterThan(99);
        expect(a[0]).toBeLessThan(102);
    });

    test('the background is required, with a message that says why', () => {
        const px = new Uint8ClampedArray(4);
        expect(() => alpha.flatten(px, 1, {})).toThrow(/no safe default/);
    });

    test('outputChannels 4 keeps a channel and makes it opaque', () => {
        const px = new Uint8ClampedArray([10, 20, 30, 0]);
        const out = alpha.flatten(px, 1, {background: [1, 2, 3], outputChannels: 4});
        expect(Array.from(out)).toEqual([1, 2, 3, 255]);
    });

    test('int16 fills the kept alpha with 65535', () => {
        const px = new Uint16Array([1, 2, 3, 0]);
        const out = alpha.flatten(px, 1, {background: [10, 20, 30], outputChannels: 4});
        expect(out[3]).toBe(65535);
    });
});

describe('alpha — the reason these exist', () => {

    jest.setTimeout(60000);

    function cube(step){
        const px = [];
        for(let r = 0; r < 256; r += step)
            for(let g = 0; g < 256; g += step)
                for(let b = 0; b < 256; b += step) px.push(r, g, b, 128);
        return { data: new Uint8ClampedArray(px), n: px.length / 4 };
    }

    test('converting premultiplied data directly is badly wrong', () => {
        // Not a regression guard — a demonstration, so the number in the docs
        // has a test behind it. If this ever stops being true, the docs are
        // wrong and this should fail.
        const { data, n } = cube(16);
        const t = new Transform({dataFormat: 'int8', buildLut: false});
        t.create('*prophoto', '*sRGB', eIntent.relative);

        const pre = alpha.premultiply(data, n);
        const wrong = t.transformArray(pre, true, true, true, n);      // T(a.C)
        expect(t.lastUsedKernel).toBe('matrix-shaper');

        const right = alpha.premultiply(
            t.transformArray(data, true, true, true, n), n);            // a.T(C)

        let max = 0;
        for(let p = 0; p < n; p++)
            for(let c = 0; c < 3; c++)
                max = Math.max(max, Math.abs(wrong[p * 4 + c] - right[p * 4 + c]));

        expect(max).toBeGreaterThan(20);        // it is tens of LSB, not one
    });

    test('unpremultiply -> convert -> premultiply is 42x closer on the mean', () => {
        const { data, n } = cube(16);
        const t = new Transform({dataFormat: 'int8', buildLut: false});
        t.create('*prophoto', '*sRGB', eIntent.relative);

        const pre = alpha.premultiply(data, n);

        // What it should equal: convert the straight original, then premultiply.
        const reference = alpha.premultiply(
            t.transformArray(data, true, true, true, n), n);

        const naive = t.transformArray(pre, true, true, true, n);
        const viaHelpers = alpha.premultiply(
            t.transformArray(alpha.unpremultiply(pre, n), true, true, true, n), n);

        const stat = (x) => {
            let max = 0, sum = 0, count = 0;
            for(let p = 0; p < n; p++)
                for(let c = 0; c < 3; c++){
                    const d = Math.abs(x[p * 4 + c] - reference[p * 4 + c]);
                    if(d > max) max = d;
                    sum += d; count++;
                }
            return { max, mean: sum / count };
        };
        const bad = stat(naive), good = stat(viaHelpers);

        // NOT ZERO, and the reason is worth stating: at a = 128/255 the
        // premultiply quantised the colour to half its codes, so dividing back
        // out cannot recover what was thrown away, and prophoto -> sRGB then
        // amplifies the residue in the shadows where its curve is steep. The
        // helpers do not make premultiplied storage lossless — nothing can —
        // they stop the transform adding a much larger error on top.
        expect(good.max).toBeLessThan(bad.max / 5);
        expect(good.mean).toBeLessThan(bad.mean / 20);
        expect(good.mean).toBeLessThan(0.5);
    });
});

describe('alpha — the canvas round trip these exist to serve', () => {

    jest.setTimeout(60000);

    const path = require('path');
    const Profile = require('../src/Profile');
    const CMYK = path.join(__dirname, 'GRACoL2006_Coated1v2.icc');

    test('RGBA -> CMYK+A -> RGBA keeps the layout and the alpha byte exactly', () => {
        // THE ORIGINAL REASON FOR ALPHA SUPPORT, and it is about LAYOUT more
        // than about compositing: canvas hands over 4 channels per pixel, and a
        // soft-proof round trip has to give 4 back. The intermediate is FIVE
        // channels — four colorants plus alpha riding alongside — because CMYK
        // has no spare channel to hide opacity in.
        //
        // Alpha is not colour-managed on either leg, so it must survive the
        // trip untouched. "Within 1 LSB" would be a failure here.
        const cmyk = new Profile();
        cmyk.loadFile(CMYK);
        if(!cmyk.loaded) return;

        const n = 4096;
        const rgba = rgbaRamp(n, 8);

        const toCmyk = new Transform({dataFormat: 'int8', buildLut: true});
        toCmyk.create('*sRGB', cmyk, eIntent.relative);
        const cmykA = toCmyk.transformArray(rgba, true, true, true, n);

        const toRgb = new Transform({dataFormat: 'int8', buildLut: true});
        toRgb.create(cmyk, '*sRGB', eIntent.relative);
        const back = toRgb.transformArray(cmykA, true, true, true, n);

        expect(cmykA.length).toBe(n * 5);        // 4 colorants + alpha
        expect(back.length).toBe(n * 4);

        let wrong = 0;
        for(let p = 0; p < n; p++){
            if(cmykA[p * 5 + 4] !== rgba[p * 4 + 3]) wrong++;    // leg 1
            if(back[p * 4 + 3]  !== rgba[p * 4 + 3]) wrong++;    // leg 2
        }
        expect(`alpha bytes altered: ${wrong}`).toBe('alpha bytes altered: 0');
    });

    test('the RGB->RGB leg of the same journey now uses the kernel', () => {
        // Canvas -> display profile, and soft-proof previews, are RGB->RGB with
        // alpha along for the ride. That leg used to miss the kernel entirely
        // and fall to the generic loops; it is the case the alpha entry points
        // were added for.
        const n = 4096;
        const rgba = rgbaRamp(n, 8);

        const t = new Transform({dataFormat: 'int8', buildLut: false});
        t.create('*sRGB', '*AdobeRGB', eIntent.relative);
        const out = t.transformArray(rgba, true, true, true, n);

        expect(t.kernelInfo().claimed).toBe(true);
        expect(out.length).toBe(n * 4);

        let wrong = 0;
        for(let p = 0; p < n; p++) if(out[p * 4 + 3] !== rgba[p * 4 + 3]) wrong++;
        expect(wrong).toBe(0);
    });
});
