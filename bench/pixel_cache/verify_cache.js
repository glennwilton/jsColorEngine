/**
 * bench/pixel_cache/verify_cache.js
 * =================================
 *
 * Proves the pixel cache is output-identical to no cache, byte for byte, over
 * real image data rather than a handful of test colours.
 *
 * The unit tests check neutrality on three Lab colours. That is not the case a
 * cache bug would hide in: with a 32-slot table and hundreds of thousands of
 * pixels there are evictions, collisions, and hit/miss interleavings that a
 * few colours never produce. This runs whole images through every cache mode
 * and compares every output byte, plus an FNV-1a hash of the whole buffer.
 *
 * Run:  node bench/pixel_cache/verify_cache.js
 *       node bench/pixel_cache/verify_cache.js --pixels 400000
 *
 * Exit code is non-zero if anything mismatches, so it can gate a release.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { Transform, Profile, eIntent } = require('../../src/main');

function argValue(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return (i !== -1 && process.argv[i + 1]) ? Number(process.argv[i + 1]) : fallback;
}

const MAX_PIXELS  = argValue('pixels', 250000);
const CACHE_MODES = [1, 16, 32];
const IMAGE_DIR   = path.join(__dirname, '..', '..', 'samples', 'images');

// ----------------------------------------------------------------------
// Content (same generators as cache_bench.js)
// ----------------------------------------------------------------------

function makeNoise(pixelCount) {
    const out = new Uint8ClampedArray(pixelCount * 3);
    let seed = 0x13579bdf;
    for (let i = 0; i < out.length; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) | 0;
        out[i] = (seed >>> 16) & 0xFF;
    }
    return out;
}

function makeGradient(pixelCount, width = 1024) {
    const out = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        const x = i % width, y = (i / width) | 0;
        for (let c = 0; c < 3; c++) out[i * 3 + c] = ((x >> 2) + (y >> 3) + c * 40) & 0xFF;
    }
    return out;
}

function makeCheckerboard(pixelCount, width = 1024) {
    const out = new Uint8ClampedArray(pixelCount * 3);
    const a = [30, 60, 200], b = [220, 180, 40];
    for (let i = 0; i < pixelCount; i++) {
        const x = i % width, y = (i / width) | 0;
        const colour = ((x + y) & 1) ? a : b;
        out[i * 3] = colour[0]; out[i * 3 + 1] = colour[1]; out[i * 3 + 2] = colour[2];
    }
    return out;
}

function makeSolid(pixelCount) {
    const out = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        out[i * 3] = 137; out[i * 3 + 1] = 42; out[i * 3 + 2] = 199;
    }
    return out;
}

function makePalette8(pixelCount) {
    const palette = [
        [255, 255, 255], [0, 0, 0], [237, 28, 36], [0, 166, 81],
        [46, 49, 146], [255, 242, 0], [140, 98, 57], [190, 190, 190],
    ];
    const out = new Uint8ClampedArray(pixelCount * 3);
    let seed = 0x2468ace0;
    for (let i = 0; i < pixelCount; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) | 0;
        const colour = palette[(seed >>> 16) % palette.length];
        out[i * 3] = colour[0]; out[i * 3 + 1] = colour[1]; out[i * 3 + 2] = colour[2];
    }
    return out;
}

/** Adversarial: every pixel differs from its neighbour by 1 LSB in one channel. */
function makeNearMiss(pixelCount) {
    const out = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        out[i * 3]     = 100 + (i % 3);
        out[i * 3 + 1] = 150 + ((i >> 1) % 3);
        out[i * 3 + 2] = 200 + ((i >> 2) % 3);
    }
    return out;
}

async function loadImageRGB(file, maxPixels) {
    const { createCanvas, loadImage } = require('canvas');
    const image = await loadImage(file);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, image.width, image.height).data;
    const pixelCount = Math.min(image.width * image.height, maxPixels);
    const out = new Uint8ClampedArray(pixelCount * 3);
    for (let i = 0; i < pixelCount; i++) {
        out[i * 3] = rgba[i * 4]; out[i * 3 + 1] = rgba[i * 4 + 1]; out[i * 3 + 2] = rgba[i * 4 + 2];
    }
    return { pixels: out, pixelCount };
}

// ----------------------------------------------------------------------

function fnv1a(buffer) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < buffer.length; i++) {
        hash ^= buffer[i] & 0xFF;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

function compare(expected, actual) {
    if (expected.length !== actual.length) {
        return { ok: false, mismatches: -1, detail: `length ${expected.length} vs ${actual.length}` };
    }
    let mismatches = 0;
    let firstAt = -1;
    let maxDelta = 0;
    for (let i = 0; i < expected.length; i++) {
        if (expected[i] !== actual[i]) {
            mismatches++;
            if (firstAt === -1) firstAt = i;
            const delta = Math.abs(expected[i] - actual[i]);
            if (delta > maxDelta) maxDelta = delta;
        }
    }
    return {
        ok: mismatches === 0,
        mismatches,
        detail: firstAt === -1 ? '' :
            `first at byte ${firstAt} (pixel ${(firstAt / 3) | 0}): ` +
            `${expected[firstAt]} vs ${actual[firstAt]}, max delta ${maxDelta}`
    };
}

// Several transform shapes, so both hash variants and 3- and 4-channel
// outputs are exercised, not just the default one.
function buildConfigs(cmykProfile) {
    return [
        { label: 'sRGB->AdobeRGB int8',  make: c => make('int8',  '*sRGB', '*AdobeRGB', c) },
        { label: 'sRGB->Lab int8',       make: c => make('int8',  '*sRGB', '*Lab',      c) },
        { label: 'sRGB->AdobeRGB int16', make: c => make('int16', '*sRGB', '*AdobeRGB', c) },
        cmykProfile
            ? { label: 'sRGB->GRACoL int8', make: c => make('int8', '*sRGB', cmykProfile, c) }
            : null,
    ].filter(Boolean);

    function make(dataFormat, from, to, cache) {
        const transform = new Transform({ dataFormat: dataFormat, buildLut: false, pixelCache: cache });
        transform.create(from, to, eIntent.relative);
        return transform;
    }
}

async function main() {
    let cmykProfile = null;
    const cmykPath = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');
    if (fs.existsSync(cmykPath)) {
        cmykProfile = new Profile();
        cmykProfile.loadBinary(fs.readFileSync(cmykPath), () => {}, false);
    }

    const contents = [
        ['noise',        makeNoise(MAX_PIXELS),        MAX_PIXELS],
        ['gradient',     makeGradient(MAX_PIXELS),     MAX_PIXELS],
        ['checkerboard', makeCheckerboard(MAX_PIXELS), MAX_PIXELS],
        ['palette8',     makePalette8(MAX_PIXELS),     MAX_PIXELS],
        ['solid',        makeSolid(MAX_PIXELS),        MAX_PIXELS],
        ['near-miss',    makeNearMiss(MAX_PIXELS),     MAX_PIXELS],
    ];

    try {
        for (const file of fs.readdirSync(IMAGE_DIR).filter(f => /\.(png|jpg|jpeg)$/i.test(f))) {
            const image = await loadImageRGB(path.join(IMAGE_DIR, file), MAX_PIXELS);
            contents.push([file, image.pixels, image.pixelCount]);
        }
    } catch (error) {
        console.log('(no sample images: ' + error.message + ')');
    }

    const configs = buildConfigs(cmykProfile);

    console.log('='.repeat(92));
    console.log(' Pixel cache — output verification (cached vs uncached, byte for byte)');
    console.log(' ' + MAX_PIXELS.toLocaleString() + ' pixels per content type, ' +
        configs.length + ' transform shapes, cache modes ' + CACHE_MODES.join('/'));
    console.log('='.repeat(92));

    let failures = 0;
    let comparisons = 0;

    for (const config of configs) {
        console.log('\n ' + config.label);
        const reference = config.make(0);

        for (const [label, pixels, pixelCount] of contents) {
            const expected = reference.transformArray(pixels, false, false, false, pixelCount);
            const expectedHash = fnv1a(expected);
            const cells = [];

            for (const mode of CACHE_MODES) {
                const cached = config.make(mode);
                const actual = cached.transformArray(pixels, false, false, false, pixelCount);
                const result = compare(expected, actual);
                const actualHash = fnv1a(actual);
                comparisons++;

                if (result.ok && actualHash === expectedHash) {
                    const rate = (cached.getPixelCacheStats().hitRate * 100).toFixed(0);
                    cells.push(`${mode}:ok(${rate}%)`);
                } else {
                    failures++;
                    cells.push(`${mode}:FAIL`);
                    console.log(`     ${label} slots=${mode}: ${result.mismatches} mismatched bytes — ${result.detail}`);
                    console.log(`     hash ${expectedHash} vs ${actualHash}`);
                }
            }
            console.log('   ' + label.padEnd(16) + ' hash ' + expectedHash + '   ' + cells.join('  '));
        }
    }

    console.log('\n' + '='.repeat(92));
    if (failures === 0) {
        console.log(' PASS — ' + comparisons + ' full-image comparisons, every output byte identical.');
    } else {
        console.log(' FAIL — ' + failures + ' of ' + comparisons + ' comparisons differ.');
    }
    console.log('='.repeat(92));
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => { console.error(error); process.exit(1); });
