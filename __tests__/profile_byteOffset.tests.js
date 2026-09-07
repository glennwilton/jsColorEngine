/**
 * GitHub #9 — Uint8Array views with non-zero byteOffset (TIFF / JPEG
 * embedded ICC) used to decode against the host ArrayBuffer and
 * silently produce a wrong transform.
 */

const fs = require('fs');
const path = require('path');
const { Transform, eIntent } = require('../src/main');
const Profile = require('../src/Profile');

const iccPath = path.join(__dirname, './GRACoL2006_Coated1v2.icc');

function readIcc() {
    return new Uint8Array(fs.readFileSync(iccPath));
}

/** Profile bytes live at `padding` inside a larger buffer. */
function paddedView(bytes, padding) {
    const big = new Uint8Array(padding + bytes.length);
    big.set(bytes, padding);
    const view = new Uint8Array(big.buffer, padding, bytes.length);
    expect(view.byteOffset).toBe(padding);
    return view;
}

/**
 * Real ICC at offset 0 of the host buffer; the view points at
 * `padding` bytes of zeros *after* it. Old parser would slice
 * buffer from 0 and succeed. Correct parser must fail.
 */
function viewPastRealProfile(iccBytes, padding, junkLength) {
    const big = new Uint8Array(iccBytes.length + padding + junkLength);
    big.set(iccBytes, 0);
    const view = new Uint8Array(big.buffer, iccBytes.length + padding, junkLength);
    expect(view.byteOffset).toBe(iccBytes.length + padding);
    return view;
}

test('loadBinary: padded views at several offsets match standalone', () => {
    const standalone = readIcc();
    const a = new Profile();
    a.loadBinary(standalone);
    expect(a.loaded).toBe(true);

    for (const padding of [1, 7, 128, 1000]) {
        const b = new Profile();
        b.loadBinary(paddedView(standalone, padding));
        expect(b.loaded).toBe(true);
        expect(b.name).toBe(a.name);
        expect(b.binaryHash).toBe(a.binaryHash);
        expect(b.header.version).toBe(a.header.version);
    }
});

test('loadPromise: offset view transform matches standalone (issue #9)', async () => {
    const standalone = readIcc();
    const view = paddedView(standalone, 1000);

    const p0 = new Profile();
    const p1 = new Profile();
    await p0.loadPromise(standalone);
    await p1.loadPromise(view);

    const t0 = new Transform({ buildLut: true, dataFormat: 'int8', BPC: true });
    const t1 = new Transform({ buildLut: true, dataFormat: 'int8', BPC: true });
    t0.create('*sRGB', p0, eIntent.relative);
    t1.create('*sRGB', p1, eIntent.relative);

    const px = new Uint8ClampedArray([0, 43, 102, 255]);
    const out0 = t0.array(px, true, true);
    const out1 = t1.array(px, true, true);
    expect(Array.from(out1)).toEqual(Array.from(out0));
});

test('loadBinary: zeros at non-zero offset is not an ICC (host buffer starts with a real profile)', () => {
    const icc = readIcc();
    const view = viewPastRealProfile(icc, 64, 512);

    const p = new Profile();
    p.loadBinary(view);
    expect(p.loaded).toBe(false);
    expect(p.loadError).toBe(true);
});

test('loadBinary: random noise view is not an ICC', () => {
    const noise = new Uint8Array(2048);
    for (let i = 0; i < noise.length; i++) {
        noise[i] = (i * 37 + 11) & 0xff;
    }
    const view = paddedView(noise, 333);

    const p = new Profile();
    p.loadBinary(view);
    expect(p.loaded).toBe(false);
    expect(p.loadError).toBe(true);
});

test('loadPromise: junk offset view does not report a loaded profile', async () => {
    const zeros = new Uint8Array(256);
    const view = paddedView(zeros, 80);
    const p = new Profile();
    await p.loadPromise(view);
    expect(p.loaded).toBe(false);
    expect(p.loadError).toBe(true);
});
