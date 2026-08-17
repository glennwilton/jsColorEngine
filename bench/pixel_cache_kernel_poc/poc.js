/**
 * bench/pixel_cache_kernel_poc/poc.js
 * ===================================
 *
 * Does a pixel cache pay inside a HOT KERNEL, as opposed to the accuracy path?
 *
 * Target: DeviceLink CMYK -> CMYK, `tetrahedralInterp4DArray_4Ch_intLut_loop`.
 * That is the best case identified in docs/deepdive/PixelCache.md — 4D input
 * (4.3 G distinct inputs, far too many to precompute) and 4-channel output, so
 * the per-pixel work is the heaviest in the engine and the check dilutes best.
 *
 * WHY THIS IS DIFFERENT FROM THE ACCURACY-PATH RESULT
 * ---------------------------------------------------
 * On the accuracy path ~6.5 of the ~18 % tax was bare pipeline-stage dispatch.
 * A kernel has no stages, so that cost vanishes — but the per-pixel budget also
 * collapses from ~125 ns to ~21 ns, so the check is a much larger share of what
 * remains. Modelling said break-even ~25 % with a ~2.9x ceiling. This measures
 * it instead of modelling it.
 *
 * KEY DESIGN — the 8-bit CMYK case is unusually friendly
 * ------------------------------------------------------
 *   - 4 input channels x 8 bits = exactly 32 bits, so the key is ONE int32 and
 *     the comparison is ONE `===`. No multi-word compare, no hash chain.
 *   - 4 output channels x 8 bits = exactly 32 bits too, so a cached value is
 *     one int32.
 *   - Hashing a single int32 is one `Math.imul`, versus the three chained
 *     imuls the accuracy-path version needs for 3 separate float channels.
 *   - The check goes immediately after the four input reads, BEFORE the grid
 *     maths. Putting it after the `c0..c3 = CLUT[...]` reads (as first
 *     sketched) would already have paid 4 imuls, 4 shifts, 4 branches and 4
 *     CLUT loads — most of what there is to skip.
 *
 * This is 8-BIT ONLY. For u16 or float input the key does not pack into 32
 * bits and none of the above holds; the dispatcher would select the plain loop.
 *
 * The cached variant is produced by source-transforming the real kernel at
 * runtime, so the interpolation cascade is guaranteed byte-identical to
 * production rather than transcribed by hand.
 *
 * Run:  node bench/pixel_cache_kernel_poc/poc.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { Transform, Profile, eIntent } = require('../../src/main');

const LOOP_NAME = 'tetrahedralInterp4DArray_4Ch_intLut_loop';
const HASH_PRIME = 2654435761;

// ----------------------------------------------------------------------
// Build the cached kernel by transforming the real one
// ----------------------------------------------------------------------

/**
 * Evaluate one pixel through the UNMODIFIED kernel, so the cache can be seeded
 * with a real (key, value) pair instead of a sentinel.
 *
 * Borrowed from lcms2, which seeds its one-entry cache at transform creation by
 * evaluating the all-zero pixel. It matters more here than on the accuracy
 * path: with a packed 4x8-bit CMYK key there is NO impossible int32 to use as
 * an empty marker — CMYK(255,255,255,255) is exactly -1 — so the first version
 * had to keep keys in a Float64Array initialised to NaN. Seeding removes the
 * problem, which lets keys go back to Int32Array: half the memory per slot, and
 * an integer compare rather than a double one.
 */
function seedPair(link) {
    const transform = new Transform({
        dataFormat: 'int8', buildLut: true, lutMode: 'int', detectIdentity: false
    });
    transform.create(link);
    const out = transform.transformArray(new Uint8ClampedArray(4), false, false, false, 1);
    return {
        key: 0,                                   // (0<<24)|(0<<16)|(0<<8)|0
        value: out[0] | (out[1] << 8) | (out[2] << 16) | (out[3] << 24)
    };
}

function buildCachedLoop(slots, seed) {
    const original = Transform.prototype[LOOP_NAME];
    let source = original.toString();

    // 1. after the four input reads, before any grid maths
    const afterInputs = 'input2 = input[inputPos++]; // Y';
    if (source.indexOf(afterInputs) === -1) throw new Error('input-read anchor not found');

    const slotBits = Math.log2(slots);
    const check = `
                // ---- pixel cache check -------------------------------
                // 4 x u8 -> exactly 32 bits, so key and compare are single
                // int32 operations and the hash is one imul.
                _key = (inputK << 24) | (input0 << 16) | (input1 << 8) | input2;
                _slot = Math.imul(_key, ${HASH_PRIME}) >>> ${32 - slotBits};
                if (_ckeys[_slot] === _key) {
                    _val = _cvals[_slot];
                    output[outputPos++] = _val & 255;
                    output[outputPos++] = (_val >>> 8) & 255;
                    output[outputPos++] = (_val >>> 16) & 255;
                    output[outputPos++] = (_val >>> 24) & 255;
                    _hits++;
                } else {
                // ------------------------------------------------------`;

    source = source.replace(afterInputs, afterInputs + check);

    // 2. close the else and store, before the shared alpha handling
    const beforeAlpha = 'if(preserveAlpha) {';
    if (source.indexOf(beforeAlpha) === -1) throw new Error('alpha anchor not found');

    const store = `
                // ---- pixel cache store (miss only) -------------------
                _ckeys[_slot] = _key;
                _cvals[_slot] = output[outputPos - 4]
                    | (output[outputPos - 3] << 8)
                    | (output[outputPos - 2] << 16)
                    | (output[outputPos - 1] << 24);
                }
                // ------------------------------------------------------
                `;
    source = source.replace(beforeAlpha, store + beforeAlpha);

    // 3. declare the cache locals
    const declAnchor = 'var interpK = false;';
    source = source.replace(declAnchor, declAnchor +
        '\n            var _key = 0|0, _slot = 0|0, _val = 0|0;');

    // Int32Array keys, every slot seeded with a real (key, value) pair. No
    // sentinel and no validity flag, so the hot path is a single integer load
    // and compare. Filling every slot with the same pair is safe: a key only
    // ever probes one slot, so the duplicates elsewhere are unreachable by it
    // and any other key landing there compares unequal and misses.
    const keys = new Int32Array(slots).fill(seed.key);
    const vals = new Int32Array(slots).fill(seed.value);
    const state = { hits: 0, lookups: 0 };

    const body = source.slice(source.indexOf('{') + 1, source.lastIndexOf('}'));
    const factory = new Function('_ckeys', '_cvals', '_state', `
        return function ${LOOP_NAME}_cached(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var _hits = 0;
            ${body}
            _state.hits += _hits;
            _state.lookups += length;
        };`);

    return { fn: factory(keys, vals, state), state: state,
        reset: () => {
            keys.fill(seed.key); vals.fill(seed.value);
            state.hits = 0; state.lookups = 0;
        } };
}

// ----------------------------------------------------------------------
// Content
// ----------------------------------------------------------------------

function cmykNoise(pixelCount) {
    const out = new Uint8ClampedArray(pixelCount * 4);
    let seed = 0x13579bdf;
    for (let i = 0; i < out.length; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) | 0;
        out[i] = (seed >>> 16) & 0xFF;
    }
    return out;
}

function cmykSolid(pixelCount) {
    const out = new Uint8ClampedArray(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
        out[i * 4] = 12; out[i * 4 + 1] = 190; out[i * 4 + 2] = 88; out[i * 4 + 3] = 40;
    }
    return out;
}

function cmykGradient(pixelCount, width = 1024) {
    const out = new Uint8ClampedArray(pixelCount * 4);
    for (let i = 0; i < pixelCount; i++) {
        const x = i % width, y = (i / width) | 0;
        for (let c = 0; c < 4; c++) out[i * 4 + c] = ((x >> 2) + (y >> 3) + c * 40) & 0xFF;
    }
    return out;
}

/** Real photograph converted to CMYK — the realistic input for a DeviceLink. */
async function realCMYK(file, pixelCount) {
    const { createCanvas, loadImage } = require('canvas');
    const image = await loadImage(file);
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, image.width, image.height).data;

    const count = Math.min(image.width * image.height, pixelCount);
    const rgb = new Uint8ClampedArray(count * 3);
    for (let i = 0; i < count; i++) {
        rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2];
    }

    const cmykProfile = new Profile();
    cmykProfile.loadBinary(fs.readFileSync(
        path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc')), () => {}, false);
    const toCMYK = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int' });
    toCMYK.create('*sRGB', cmykProfile, eIntent.relative);
    return { pixels: toCMYK.transformArray(rgb, false, false, false, count), count };
}

// ----------------------------------------------------------------------

function median(values) { values.sort((a, b) => a - b); return values[values.length >> 1]; }

async function main() {
    const linkPath = path.join(__dirname, '..', '..', 'testbed', 'profiles', 'devicelink', 'null-cmyk-to-cmyk.icc');
    const link = new Profile();
    link.loadBinary(fs.readFileSync(linkPath), () => {}, false);

    const PIXELS = 400000;
    const contents = [
        ['cmyk noise', cmykNoise(PIXELS), PIXELS],
        ['cmyk gradient', cmykGradient(PIXELS), PIXELS],
        ['cmyk solid', cmykSolid(PIXELS), PIXELS],
    ];
    try {
        const dir = path.join(__dirname, '..', '..', '_wip', 'images');
        for (const file of fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.jpg')).slice(0, 3)) {
            const image = await realCMYK(path.join(dir, file), PIXELS);
            contents.push([file.slice(0, 18) + ' →CMYK', image.pixels, image.count]);
        }
    } catch (error) { console.log('  (real images unavailable: ' + error.message + ')'); }

    console.log('='.repeat(88));
    console.log(' Pixel cache in a HOT KERNEL — DeviceLink CMYK→CMYK, ' + LOOP_NAME);
    console.log(' 8-bit only: 4x u8 key = one int32 compare, one imul hash');
    console.log('='.repeat(88));

    const original = Transform.prototype[LOOP_NAME];

    function run(pixels, count, cached) {
        if (cached) Transform.prototype[LOOP_NAME] = cached.fn;
        else Transform.prototype[LOOP_NAME] = original;

        const transform = new Transform({
            dataFormat: 'int8', buildLut: true, lutMode: 'int', detectIdentity: false
        });
        // A DeviceLink is a complete device-to-device transform, so it is
        // passed alone — no source/destination pair.
        transform.create(link);

        for (let w = 0; w < 3; w++) transform.transformArray(pixels, false, false, false, count);
        if (cached) cached.reset();

        const times = [];
        for (let k = 0; k < 7; k++) {
            const t0 = process.hrtime.bigint();
            transform.transformArray(pixels, false, false, false, count);
            const t1 = process.hrtime.bigint();
            times.push(count / (Number(t1 - t0) / 1e6 * 1000));
        }
        const out = transform.transformArray(pixels, false, false, false, count);
        Transform.prototype[LOOP_NAME] = original;
        return { mpx: median(times), out: out };
    }

    const seed = seedPair(link);
    console.log('\n  seeded with CMYK(0,0,0,0) -> 0x' + (seed.value >>> 0).toString(16).padStart(8, '0') +
        '  (no sentinel, no validity flag)');

    for (const slots of [16, 64, 256]) {
        console.log('\n  slots = ' + slots);
        console.log('    content                    plain    cached    change   hit%   identical');
        for (const [label, pixels, count] of contents) {
            const cached = buildCachedLoop(slots, seed);
            const base = run(pixels, count, null);
            const withCache = run(pixels, count, cached);

            let identical = true;
            for (let i = 0; i < base.out.length; i++) {
                if (base.out[i] !== withCache.out[i]) { identical = false; break; }
            }
            const hitRate = cached.state.lookups ? (cached.state.hits / cached.state.lookups) : 0;
            console.log('    ' + label.padEnd(24) +
                base.mpx.toFixed(1).padStart(6) + '  ' + withCache.mpx.toFixed(1).padStart(7) + '  ' +
                (((withCache.mpx / base.mpx) - 1) * 100).toFixed(0).padStart(6) + '%  ' +
                (hitRate * 100).toFixed(0).padStart(4) + '%   ' + (identical ? 'yes' : '*** NO ***'));
        }
    }
    console.log('');
}

main().catch(error => { console.error(error); process.exit(1); });
