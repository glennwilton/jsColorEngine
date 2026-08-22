/**
 * Bench input: solid / photo / noise.
 *
 * Headline is photo with 5 % noise added (high-bit grain). Past ~3 % grain every starting
 * content collapses onto the same plateau; 5 % sits on it without
 * walking as far into noise as 15 %. Clean photo and solid stay on the
 * menu so you can still see L1 / locality. Pure noise is the other bound.
 *
 * The old `seed * k + c` then `seed & 0xff` stream produced ~105 colours.
 * That is `legacy` — do not quote. See docs/deepdive/benchmark.md.
 */
export const DEFAULT_KIND = 'photo-5';
// Relative to this module — works wherever the samples tree is mounted.
export const PHOTO_URL = new URL('./images/strawberries.jpg', import.meta.url).href;

function lcgStep(seed) {
    return (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
}

export function genLegacyNoise(buf) {
    let seed = 0x13579bdf;
    for (let i = 0; i < buf.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        buf[i] = seed & 0xff;
    }
}

export function genNoise(buf) {
    let seed = 0x13579bdf;
    for (let i = 0; i < buf.length; i++) {
        seed = lcgStep(seed);
        buf[i] = (seed >>> 23) & 0xff;
    }
}

export function genSolid(buf, npx, channels) {
    let seed = 0x13579bdf;
    const px = new Uint8Array(4);
    for (let c = 0; c < 4; c++) {
        seed = lcgStep(seed);
        px[c] = (seed >>> 23) & 0xff;
    }
    for (let p = 0; p < npx; p++) {
        for (let c = 0; c < channels; c++) buf[p * channels + c] = px[c];
    }
}

let photoRgb = null;   // { data, npx, width, height }
let photoCmyk = null;

export function setPhotoRgb(data, npx, width, height) {
    photoRgb = { data: data, npx: npx, width: width || 0, height: height || 0 };
}

export function setPhotoCmyk(data, npx) {
    photoCmyk = { data: data, npx: npx };
}

export function hasPhoto(channels) {
    return channels === 4 ? !!photoCmyk : !!photoRgb;
}

function tilePhoto(buf, npx, channels) {
    const src = channels === 4 ? photoCmyk : photoRgb;
    if (!src) {
        // No frame loaded — last resort, not a photo. Caller should have waited.
        genSolid(buf, npx, channels);
        return;
    }
    const have = src.npx;
    const plane = src.data;
    for (let p = 0; p < npx; p++) {
        const s = (p % have) * channels;
        for (let c = 0; c < channels; c++) buf[p * channels + c] = plane[s + c];
    }
}

function blendNoise(buf, percent) {
    const noise = new Uint8ClampedArray(buf.length);
    genNoise(noise);
    const t = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
    for (let i = 0; i < buf.length; i++) {
        buf[i] = Math.round(buf[i] * (1 - t) + noise[i] * t);
    }
}

export function parseContentKind(kind) {
    if (kind === 'solid' || kind === 'photo' || kind === 'noise' || kind === 'legacy') return kind;
    const m = String(kind || '').match(/^(photo|solid)-(\d+)$/);
    if (m) return { base: m[1], noisy: Number(m[2]) };
    return { base: 'photo', noisy: 5 };
}

export function buildInput(channels, pixelCount, kind) {
    const arr = new Uint8ClampedArray(pixelCount * channels);
    const parsed = parseContentKind(kind);
    if (parsed === 'legacy') genLegacyNoise(arr);
    else if (parsed === 'noise') genNoise(arr);
    else if (parsed === 'solid') genSolid(arr, pixelCount, channels);
    else if (parsed === 'photo') tilePhoto(arr, pixelCount, channels);
    else {
        if (parsed.base === 'solid') genSolid(arr, pixelCount, channels);
        else tilePhoto(arr, pixelCount, channels);
        if (parsed.noisy > 0) blendNoise(arr, parsed.noisy);
    }
    return arr;
}

export function buildInputU16(channels, pixelCount, kind) {
    const u8 = buildInput(channels, pixelCount, kind);
    const arr = new Uint16Array(u8.length);
    for (let i = 0; i < u8.length; i++) arr[i] = u8[i] << 8;
    return arr;
}

export function contentLabel(kind) {
    const parsed = parseContentKind(kind);
    if (parsed === 'legacy') return 'legacy 256-colour LCG (do not quote)';
    if (parsed === 'noise') return 'pure noise (high-bit LCG)';
    if (parsed === 'solid') return 'solid (one colour)';
    if (parsed === 'photo') return 'photo (strawberries, clean)';
    const base = parsed.base === 'solid' ? 'solid' : 'photo';
    const plateau = (parsed.base === 'photo' && parsed.noisy === 5) ? ' (plateau)' : '';
    return base + ' with ' + parsed.noisy + '% noise added' + plateau;
}

/**
 * Decode a JPEG in the browser and stash the RGB plane.
 * @returns {{npx: number, width: number, height: number}}
 */
export async function loadPhotoFromUrl(url) {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('failed to load photo: ' + url));
        img.src = url;
    });
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const npx = w * h;
    const rgb = new Uint8ClampedArray(npx * 3);
    for (let p = 0, i = 0; p < npx; p++, i += 4) {
        rgb[p * 3]     = rgba[i];
        rgb[p * 3 + 1] = rgba[i + 1];
        rgb[p * 3 + 2] = rgba[i + 2];
    }
    setPhotoRgb(rgb, npx, w, h);
    return { npx: npx, width: w, height: h };
}

/**
 * Paint a square preview of the strawberries frame (scaled in 2D, not
 * a linear wrap) with `percent` grain. 100 = pure noise.
 * `buildInput(3, 128*128, 'photo')` tiles the first 16 k pixels of a
 * 1000-wide frame into 128-wide rows — that looks like streaks.
 */
export function paintKneePreview(canvas, percent) {
    const side = canvas.width;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(side, side);
    const rgba = img.data;
    const t = Math.max(0, Math.min(100, Number(percent) || 0)) / 100;
    const src = photoRgb;
    const sw = src && src.width;
    const sh = src && src.height;
    const hasPhoto = !!(src && sw > 0 && sh > 0);
    let seed = 0x13579bdf;
    for (let y = 0; y < side; y++) {
        const sy = hasPhoto ? Math.min(sh - 1, (y * sh / side) | 0) : 0;
        for (let x = 0; x < side; x++) {
            const di = (y * side + x) * 4;
            let r = 0, g = 0, b = 0;
            if (hasPhoto && t < 1) {
                const sx = Math.min(sw - 1, (x * sw / side) | 0);
                const si = (sy * sw + sx) * 3;
                r = src.data[si];
                g = src.data[si + 1];
                b = src.data[si + 2];
            }
            if (t > 0) {
                seed = lcgStep(seed);
                const nr = (seed >>> 23) & 0xff;
                seed = lcgStep(seed);
                const ng = (seed >>> 23) & 0xff;
                seed = lcgStep(seed);
                const nb = (seed >>> 23) & 0xff;
                r = Math.round(r * (1 - t) + nr * t);
                g = Math.round(g * (1 - t) + ng * t);
                b = Math.round(b * (1 - t) + nb * t);
            }
            rgba[di]     = r;
            rgba[di + 1] = g;
            rgba[di + 2] = b;
            rgba[di + 3] = 255;
        }
    }
    ctx.putImageData(img, 0, 0);
}
