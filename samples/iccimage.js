/* ============================================================================
 *  iccimage.js — small immutable image wrapper around jsColorEngine
 * ----------------------------------------------------------------------------
 *  Released under the MIT License (see ./LICENSE).
 *  Copyright (c) 2026 Glenn Wilton, O2 Creative Limited.
 *
 *  Note: the engine in ../src is MPL-2.0. This helper module and the rest of
 *  the samples folder are MIT, so demos can be copy-pasted freely.
 * ============================================================================
 *
 *  WHAT THIS IS
 *
 *    A small helper that owns the "I have an image, I want to display /
 *    proof / inspect it" workflow on top of jsColorEngine. It is the
 *    reference helper behind the demos in `samples/*.html` and doubles
 *    as living documentation of how to drive the core engine on real
 *    image data. Spec sits in docs/Roadmap.md §v1.4.
 *
 *  WHAT THIS IS NOT
 *
 *    Not Photoshop. No filters, no layers, no compositing, no blur, no
 *    sharpen, no encode/decode of JPEG/TIFF/PNG. The two amenities that
 *    DID make it in are basic bilinear downscale and bit-depth conversion
 *    — both are minimal, both are useful as defensive guards against
 *    huge browser uploads and dtype mismatches in demos. KISS.
 *
 *  DESIGN TENETS
 *
 *    1. Immutable. Every toSRGB / toProof / toSeparation / toBitDepth /
 *       resizeTo returns a NEW ICCImage. The source is never mutated.
 *
 *    2. Always profile-tagged. ICCImageData carries the Profile AND the
 *       full chain history (`[Profile, intent, Profile, intent, ...]`,
 *       same shape as `Transform.chain` — see src/Transform.js:1305 for
 *       the analogous pattern in the engine).
 *
 *    3. Lazy + cached transforms. Transforms are built on first use and
 *       keyed by chain + BPC + dataFormat + buildLut. Cache lives on the
 *       source image and is shared with derived images via the
 *       transformCache constructor option.
 *
 *    4. toCanvas auto-converts only when needed. If the terminal profile
 *       is the virtual *sRGB instance and the buffer is uint8, blit
 *       direct. Otherwise build a [terminal, *sRGB] LUT once and convert.
 *
 *  ENGINE WIRING
 *
 *    jsColorEngine ships a UMD bundle at browser/jsColorEngineWeb.js
 *    that exposes a global `jsColorEngine`. By default this module
 *    reads `globalThis.jsColorEngine` lazily on first use:
 *
 *        <script src="../browser/jsColorEngineWeb.js"></script>
 *        <script type="module">
 *            import { ICCImage } from './iccimage.js';
 *            // ...just works
 *        </script>
 *
 *    For ESM environments with their own bundling:
 *
 *        import * as engine from 'jscolorengine';
 *        ICCImage.init({ engine });
 *
 * ============================================================================
 */

// ── Engine resolution (lazy) ────────────────────────────────────────────────

let _injectedEngine = null;

function _engine() {
    const e = _injectedEngine || (typeof globalThis !== 'undefined' && globalThis.jsColorEngine);
    if (!e || !e.Profile || !e.Transform) {
        throw new Error(
            'iccimage: jsColorEngine not found. Either load browser/jsColorEngineWeb.js ' +
            'before this module, or call ICCImage.init({ engine }).'
        );
    }
    return e;
}

// Single shared *sRGB Profile instance — pointer equality lets toCanvas
// fast-path the "already display-ready" case without string sniffing.
let _sRGB = null;
function _sRGBProfile() {
    if (_sRGB) return _sRGB;
    const { Profile } = _engine();
    _sRGB = new Profile();
    _sRGB.load('*sRGB');
    if (!_sRGB.loaded) throw new Error('iccimage: failed to synthesise *sRGB');
    return _sRGB;
}

// ── Channel sets, scoped to colour space ───────────────────────────────────
//
// Numeric lookups need a context — channel index 0 means Red in RGB and
// Cyan in CMYK. `tint` is a visualisation approximation; real ink colours
// would come from the profile's `colorantTable` tag.

export const ChannelSets = {
    GRAY: [
        { index: 0, name: 'gray',    short: 'K', tint: [  0,   0,   0] },
    ],
    RGB: [
        { index: 0, name: 'red',     short: 'R', tint: [255,   0,   0] },
        { index: 1, name: 'green',   short: 'G', tint: [  0, 255,   0] },
        { index: 2, name: 'blue',    short: 'B', tint: [  0,   0, 255] },
    ],
    CMYK: [
        { index: 0, name: 'cyan',    short: 'C', tint: [  0, 174, 239] },
        { index: 1, name: 'magenta', short: 'M', tint: [236,   0, 140] },
        { index: 2, name: 'yellow',  short: 'Y', tint: [255, 242,   0] },
        { index: 3, name: 'black',   short: 'K', tint: [  0,   0,   0] },
    ],
};

export function resolveChannel(spaceTag, ref) {
    const set = ChannelSets[spaceTag] || ChannelSets.RGB;
    if (typeof ref === 'number') return set[ref] || null;
    const n = String(ref).toLowerCase().trim();
    return set.find(c => c.name === n || c.short.toLowerCase() === n) || null;
}

// ── 1. ICCImageData — immutable pixel container ────────────────────────────

export class ICCImageData {
    /**
     * @param {object} opts
     * @param {number} opts.width
     * @param {number} opts.height
     * @param {number} opts.channels        Colorant channels only (3 RGB, 4 CMYK).
     * @param {number} opts.bitDepth        8 | 16 | 32  (32 → Float32Array).
     * @param {Uint8ClampedArray|Uint16Array|Float32Array} opts.data
     * @param {Profile} opts.profile        Terminal profile of `chain`.
     * @param {string}  opts.colorSpace     'RGB' | 'CMYK' | 'GRAY' | etc.
     * @param {false|'straight'|'premultiplied'} [opts.alpha=false]
     * @param {Array}   [opts.chain]        Lineage `[Profile, intent, Profile, ...]`.
     *                                      Defaults to `[profile]` (no history).
     */
    constructor({ width, height, channels, bitDepth, data, profile, colorSpace, alpha = false, chain = null }) {
        this.width      = width;
        this.height     = height;
        this.channels   = channels;
        this.bitDepth   = bitDepth;
        this.data       = data;
        this.profile    = profile;
        this.colorSpace = colorSpace;
        this.alpha      = alpha;
        this.chain      = chain || [profile];
    }

    /** Items per pixel including alpha (the buffer's actual stride). */
    get bytesPerPixel() { return this.channels + (this.alpha ? 1 : 0); }

    clone() {
        return new ICCImageData({
            width:      this.width,
            height:     this.height,
            channels:   this.channels,
            bitDepth:   this.bitDepth,
            data:       new this.data.constructor(this.data),
            profile:    this.profile,
            colorSpace: this.colorSpace,
            alpha:      this.alpha,
            chain:      this.chain.slice(),
        });
    }
}

// ── 2. TransformCache — keyed Transform store ──────────────────────────────
//
// Identity is built from the engine-shape chain (`[Profile|'*name',
// intent, Profile, ...]`) plus BPC + dataFormat + buildLut. Profile
// identity uses description / name with a WeakMap-backed monotonic
// fallback for unnamed profiles, so two unrelated unnamed profiles
// never collide.

let _profileIdCounter = 0;
const _profileIdMap = new WeakMap();

function _profileKey(p) {
    if (!p) return 'null';
    if (typeof p === 'string') return p;
    let id = _profileIdMap.get(p);
    if (!id) {
        const tag = p.description || p.name || 'profile';
        id = `${tag}#${++_profileIdCounter}`;
        _profileIdMap.set(p, id);
    }
    return id;
}

export class TransformCache {
    constructor() { this.cache = new Map(); }

    /**
     * @param {object} spec
     * @param {Array}  spec.chain         `[Profile, intent, Profile, intent, Profile, ...]`
     *                                    Strings starting with '*' are auto-virtualised
     *                                    by the engine.
     * @param {boolean|boolean[]} [spec.BPC=false]
     * @param {string}  [spec.dataFormat='int8']
     * @param {boolean} [spec.buildLut=true]
     * @param {string}  [spec.lutGamutMode='none']  'none' | 'color' | 'map'
     * @param {number}  [spec.lutGamutLimit=5]
     * @param {number}  [spec.lutGamutMapScale=25.5]
     * @param {object}  [spec.lutGamutColor]
     */
    get(spec) {
        const { Transform, eIntent } = _engine();
        const BPC = spec.BPC ?? false;
        const dataFormat = spec.dataFormat || 'int8';
        const buildLut = spec.buildLut !== false;
        const lutGamutMode = spec.lutGamutMode ?? 'none';
        const lutGamutLimit = spec.lutGamutLimit ?? 5;
        const lutGamutMapScale = spec.lutGamutMapScale ?? 25.5;

        let gamutKey = '';
        if (lutGamutMode === 'color')    gamutKey = `|gc${lutGamutLimit}`;
        else if (lutGamutMode === 'map') gamutKey = `|gm${lutGamutMapScale}`;
        else if (lutGamutMode === 'colorMap') gamutKey = `|gb${lutGamutMapScale}`;
        const key = this._key(spec.chain, BPC, dataFormat, buildLut) + gamutKey;

        const hit = this.cache.get(key);
        if (hit) return hit;

        const opts = { buildLut, dataFormat, BPC, lutGamutMode, lutGamutLimit, lutGamutMapScale };
        if (spec.lutGamutColor) opts.lutGamutColor = spec.lutGamutColor;
        const t = new Transform(opts);
        if (spec.chain.length === 2) {
            t.create(spec.chain[0], spec.chain[1], eIntent.relative);
        } else if (spec.chain.length === 3) {
            t.create(spec.chain[0], spec.chain[2], spec.chain[1]);
        } else {
            t.createMultiStage(spec.chain);
        }
        this.cache.set(key, t);
        return t;
    }

    _key(chain, BPC, dataFormat, buildLut) {
        const c = chain.map(item => {
            if (item == null) return 'null';
            if (typeof item === 'number') return `i${item}`;     // intent
            if (typeof item === 'string') return item;           // '*sRGB' etc.
            return _profileKey(item);
        }).join('|');
        const b = Array.isArray(BPC) ? BPC.map(x => x ? 1 : 0).join(',') : (BPC ? '1' : '0');
        return `${c}::bpc=${b}::fmt=${dataFormat}::lut=${buildLut ? 1 : 0}`;
    }

    clear() { this.cache.clear(); }
    get size() { return this.cache.size; }
}

// ── 3. ICCImage — the public API ───────────────────────────────────────────

export class ICCImage {

    /**
     * Direct construction from a typed array. Most demos use one of the
     * static factories instead.
     *
     * @param {object} opts
     * @param {number} opts.width
     * @param {number} opts.height
     * @param {Uint8ClampedArray|Uint16Array|Float32Array} opts.data
     * @param {Profile|string} opts.profile         Profile instance or '*name' virtual.
     * @param {number} [opts.channels]              Colorant channels (auto-detected from
     *                                              profile.outputChannels if omitted).
     * @param {number} [opts.bitDepth=8]            8 | 16 | 32 (32 = Float32Array).
     * @param {string} [opts.colorSpace]            Auto-detected from profile.colorSpace.
     * @param {false|'straight'|'premultiplied'} [opts.alpha=false]
     * @param {Array}  [opts.chain]
     * @param {TransformCache} [opts.transformCache]  Share with other ICCImages.
     */
    constructor(opts) {
        if (opts instanceof ICCImageData) {
            this._raw   = opts;
            this._cache = new TransformCache();
        } else {
            const profile = ICCImage._toProfile(opts.profile);
            const channels   = opts.channels   ?? profile.outputChannels ?? 3;
            const colorSpace = opts.colorSpace ?? (profile.colorSpace || 'RGB').replace(/\s+/g, '');
            this._raw = new ICCImageData({
                width:      opts.width,
                height:     opts.height,
                channels,
                bitDepth:   opts.bitDepth ?? 8,
                data:       opts.data,
                profile,
                colorSpace,
                alpha:      opts.alpha ?? false,
                chain:      opts.chain ?? [profile],
            });
            this._cache = opts.transformCache || new TransformCache();
        }

        // Lazy single-pixel accuracy-path transforms (built on first pixel() call).
        this._pixelToLab  = null;
        this._pixelToSRGB = null;
    }

    // ── Engine + resource injection ───────────────────────────────────────

    static init({ engine } = {}) {
        if (engine) {
            _injectedEngine = engine;
            _sRGB = null; // re-create against the injected engine
        }
    }

    // ── Constructors ──────────────────────────────────────────────────────

    /**
     * Wrap an existing browser ImageData. The browser has already given
     * you sRGB (canvas API guarantee), so the profile defaults to '*sRGB'.
     */
    static fromImageData(imageData, profile = '*sRGB', { maxPixels } = {}) {
        const p = ICCImage._toProfile(profile);
        const img = new ICCImage({
            width:      imageData.width,
            height:     imageData.height,
            channels:   3,
            bitDepth:   8,
            data:       new Uint8ClampedArray(imageData.data),
            profile:    p,
            colorSpace: 'RGB',
            alpha:      'straight',
        });
        return maxPixels ? img.resizeTo({ maxPixels }) : img;
    }

    /**
     * Pull pixels off an HTMLImageElement / HTMLCanvasElement / ImageBitmap
     * via a 2D canvas. Always 8-bit RGBA — that's what the canvas API gives
     * back. For real 16-bit sources, decode the bytes yourself and use
     * `new ICCImage({...})` directly.
     *
     * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} source
     * @param {object} [opts]
     * @param {string|Profile} [opts.profile='*sRGB']
     * @param {number} [opts.maxPixels]   Defensive downscale cap (bilinear).
     */
    static async fromHTMLImage(source, { profile = '*sRGB', maxPixels } = {}) {
        const w = source.naturalWidth || source.width;
        const h = source.naturalHeight || source.height;
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const ctx = cv.getContext('2d');
        ctx.drawImage(source, 0, 0);
        const imgData = ctx.getImageData(0, 0, w, h);
        return ICCImage.fromImageData(imgData, profile, { maxPixels });
    }

    // ── Read accessors ────────────────────────────────────────────────────

    get info() {
        if (!this._raw) return { disposed: true };
        const r = this._raw;
        const eng = _engine();
        const i2s = (eng.convert && eng.convert.intent2String)
            || (v => ['Perceptual', 'Relative', 'Saturation', 'Absolute'][v] || `intent(${v})`);
        const chainHuman = r.chain.map((it, i) => {
            if (i % 2 === 0) {
                return it.name || it.description || `profile#${i / 2}`;
            }
            return i2s(it);
        }).join(' \u2192 ');
        return {
            width:      r.width,
            height:     r.height,
            channels:   r.channels,
            bitDepth:   r.bitDepth,
            colorSpace: r.colorSpace,
            alpha:      r.alpha,
            profile:    r.profile.name || r.profile.description || 'unnamed',
            chain:      chainHuman,
            cacheSize:  this._cache.size,
        };
    }

    /** Defensive copy of the raw buffer. Returns null if disposeRaw() was called. */
    getRaw() { return this._raw ? this._raw.clone() : null; }

    /** Direct (non-copying) view of the underlying ICCImageData. Read-only by convention. */
    get raw() { return this._raw; }

    // ── Conversions — every one returns a NEW ICCImage ────────────────────

    /**
     * Convert to sRGB display. If the source is already sRGB-tagged this
     * is effectively a no-op clone — the cache hit makes it instant on
     * second call.
     */
    async toSRGB({ intent, BPC = false } = {}) {
        const { eIntent } = _engine();
        const useIntent = intent ?? eIntent.relative;
        const sRGB = _sRGBProfile();
        if (this._raw.profile === sRGB) return this; // already sRGB — same instance is fine (immutable)

        const transformChain = [this._raw.profile, useIntent, sRGB];
        const t = this._cache.get({ chain: transformChain, BPC, dataFormat: 'int8' });
        const out = this._runArrayTransform(t, true);

        const newChain = [...this._raw.chain, useIntent, sRGB];
        return this._derive({ data: out, profile: sRGB, colorSpace: 'RGB', channels: 3, alpha: 'straight', chain: newChain });
    }

    /**
     * Soft-proof: src → proofProfile → *sRGB. Returned ICCImage is sRGB-
     * tagged so toCanvas() blits without further conversion.
     *
     * `intent` may be a single value (RGB→proof only; the CMYK→*sRGB preview
     * leg is always relative colorimetric) or `[srcToProof, proofToScreen]`.
     * `BPC` may be boolean (black-point compensation on the RGB→proof leg only)
     * or `[srcToProof, proofToScreen]`.
     */
    async toProof(proofProfile, { intent, BPC = [false, false], lutGamutMode = 'none', lutGamutLimit = 5, lutGamutMapScale = 25.5, lutGamutColor } = {}) {
        const { eIntent } = _engine();
        const intents = Array.isArray(intent)
            ? intent
            : [intent ?? eIntent.relative, eIntent.relative]; // [ user intent for src to profile, proofing intent is always eIntent.relative]
        const bpcArr = Array.isArray(BPC) ? BPC : [BPC, false];
        const sRGB = _sRGBProfile();

        const transformChain = [this._raw.profile, intents[0], proofProfile, intents[1], sRGB];
        const spec = { chain: transformChain, BPC: bpcArr, dataFormat: 'int8', lutGamutMode, lutGamutLimit, lutGamutMapScale };
        if (lutGamutColor) spec.lutGamutColor = lutGamutColor;
        const t = this._cache.get(spec);
        const out = this._runArrayTransform(t, true);

        const newChain = [...this._raw.chain, intents[0], proofProfile, intents[1], sRGB];
        return this._derive({ data: out, profile: sRGB, colorSpace: 'RGB', channels: 3, alpha: 'straight', chain: newChain });
    }

    /**
     * Convert to the proof profile's native space (typically CMYK). The
     * returned ICCImage is tagged with `proofProfile` so its raw data IS
     * the actual ink separation. toCanvas() on this will build a
     * [proofProfile, *sRGB] transform on the fly to display it.
     */
    async toSeparation(proofProfile, { intent, BPC = false, lutGamutMode = 'none', lutGamutLimit = 5, lutGamutMapScale = 25.5, lutGamutColor } = {}) {
        const { eIntent } = _engine();
        const useIntent = intent ?? eIntent.relative;
        const transformChain = [this._raw.profile, useIntent, proofProfile];
        const spec = { chain: transformChain, BPC, dataFormat: 'int8', lutGamutMode, lutGamutLimit, lutGamutMapScale };
        if (lutGamutColor) spec.lutGamutColor = lutGamutColor;
        const t = this._cache.get(spec);

        // Separation drops alpha (CMYK in the wild rarely carries alpha).
        const out = this._runArrayTransform(t, false);

        const outChannels   = proofProfile.outputChannels;
        const outColorSpace = (proofProfile.colorSpace || 'CMYK').replace(/\s+/g, '');
        const newChain = [...this._raw.chain, useIntent, proofProfile];
        return this._derive({
            data: out, profile: proofProfile,
            colorSpace: outColorSpace, channels: outChannels,
            alpha: false, chain: newChain,
        });
    }

    /**
     * Bilinear downscale. Returns the same instance unchanged if the source
     * already fits the budget (the immutable contract still holds because
     * the source IS the result). Up-sampling is rejected by design.
     *
     * @param {object} target
     * @param {number} [target.maxPixels]  Cap on width*height. Computes the
     *                                     scale factor to fit the budget,
     *                                     preserving aspect ratio.
     * @param {number} [target.width]      Explicit width (height auto-computed
     *                                     to preserve aspect ratio if omitted).
     * @param {number} [target.height]     Explicit height.
     */
    resizeTo(target) {
        const r = this._raw;
        let dstW, dstH;

        if (target.maxPixels) {
            const srcPx = r.width * r.height;
            if (srcPx <= target.maxPixels) return this;
            const scale = Math.sqrt(target.maxPixels / srcPx);
            dstW = Math.max(1, Math.round(r.width  * scale));
            dstH = Math.max(1, Math.round(r.height * scale));
        } else {
            dstW = target.width  ?? Math.round(target.height * (r.width / r.height));
            dstH = target.height ?? Math.round(target.width  * (r.height / r.width));
            if (dstW > r.width || dstH > r.height) {
                throw new Error(`iccimage: resizeTo refuses upscaling (${r.width}x${r.height} → ${dstW}x${dstH}). KISS — use a real image library if you need this.`);
            }
            if (dstW === r.width && dstH === r.height) return this;
        }

        const totalCh = r.bytesPerPixel;
        const out = new r.data.constructor(dstW * dstH * totalCh);
        _bilinearDownsample(r.data, r.width, r.height, dstW, dstH, totalCh, out);

        return this._derive({
            data: out,
            profile: r.profile,
            colorSpace: r.colorSpace,
            channels: r.channels,
            alpha: r.alpha,
            chain: r.chain.slice(),
            width: dstW, height: dstH,
        });
    }

    /**
     * Convert numeric format. Profile and colour space are unchanged —
     * only the cell type and scaling differ.
     *
     * @param {8|16|32|'uint8'|'uint16'|'float32'} target
     */
    toBitDepth(target) {
        const r = this._raw;
        const tgt = target === 8 || target === 'uint8'   ? 8
                  : target === 16 || target === 'uint16' ? 16
                  : target === 32 || target === 'float32' ? 32
                  : null;
        if (tgt === null) throw new Error(`iccimage: toBitDepth target must be 8 | 16 | 'float32' (got ${target})`);
        if (tgt === r.bitDepth) return this;

        const Out = tgt === 8 ? Uint8ClampedArray : tgt === 16 ? Uint16Array : Float32Array;
        const out = new Out(r.data.length);
        _convertBitDepth(r.data, out, r.bitDepth, tgt);

        return this._derive({
            data: out,
            profile: r.profile,
            colorSpace: r.colorSpace,
            channels: r.channels,
            alpha: r.alpha,
            chain: r.chain.slice(),
            bitDepth: tgt,
        });
    }

    // ── Display + inspection ──────────────────────────────────────────────

    /**
     * Paint onto a canvas. Auto-resizes the canvas to match. If the
     * terminal profile is sRGB and the buffer is uint8 RGBA, blits direct;
     * otherwise builds (and caches) a [terminal, *sRGB] transform first.
     */
    async toCanvas(canvas) {
        const r = this._raw;
        if (!r) throw new Error('iccimage: disposed');

        let displayBuf;
        if (this._isDisplayReady()) {
            displayBuf = r.data;
        } else {
            const sRGB = _sRGBProfile();
            const { eIntent } = _engine();
            const t = this._cache.get({
                chain: [r.profile, eIntent.relative, sRGB],
                BPC: false, dataFormat: 'int8',
            });
            displayBuf = this._runArrayTransform(t, true);
        }

        const out = displayBuf instanceof Uint8ClampedArray ? displayBuf : new Uint8ClampedArray(displayBuf);
        canvas.width  = r.width;
        canvas.height = r.height;
        canvas.getContext('2d').putImageData(new ImageData(out, r.width, r.height), 0, 0);
        return canvas;
    }

    /**
     * Render a single channel as a tinted RGBA ICCImage. Useful for "C / M /
     * Y / K" plate previews. The resulting ICCImage is sRGB-tagged so
     * `.toCanvas()` blits direct.
     *
     * @param {string|number} ref     Channel reference: 'C' / 'cyan' / 0 etc.
     * @param {string|number[]} [tint] CSS hex string ('#00AEEF') or [r,g,b]
     *                                 array. Defaults to ChannelSets[space][i].tint.
     */
    renderChannelAs(ref, tint) {
        const r = this._raw;
        const ch = resolveChannel(r.colorSpace, ref);
        if (!ch) throw new Error(`iccimage: channel '${ref}' not in ${r.colorSpace}`);
        if (ch.index >= r.channels) throw new Error(`iccimage: channel index ${ch.index} >= ${r.channels}`);

        const tintRGB = _resolveTint(tint) || ch.tint;
        const stride  = r.bytesPerPixel;
        const total   = r.width * r.height;
        const rgba    = new Uint8ClampedArray(total * 4);
        const data    = r.data;
        const isU16   = data instanceof Uint16Array;
        const isF32   = data instanceof Float32Array;

        for (let i = 0, j = ch.index, k = 0; i < total; i++, j += stride, k += 4) {
            const v = data[j];
            const ink = isU16 ? (v >> 8) : isF32 ? Math.round(v * 255) : v;
            rgba[k]     = tintRGB[0];
            rgba[k + 1] = tintRGB[1];
            rgba[k + 2] = tintRGB[2];
            rgba[k + 3] = ink;
        }

        const sRGB = _sRGBProfile();
        return this._derive({
            data: rgba, profile: sRGB, colorSpace: 'RGB',
            channels: 3, alpha: 'straight', bitDepth: 8,
            chain: [sRGB], // synthetic — channel rendering doesn't extend the engine chain
        });
    }

    /**
     * Single-pixel readout via the ACCURACY PATH (no LUT). Returns the
     * pixel in three useful spaces at once.
     *
     * @param {number} x
     * @param {number} y
     * @returns {{ lab: {L,a,b}, srgb: {R,G,B,hex}, device: number[], space: string }}
     *          - lab     CIE L*a*b* D50 (L 0..100, a/b -128..127)
     *          - srgb    integer 0..255 + '#rrggbb' hex string
     *          - device  source-space values normalised to 0..1 (length === channels)
     *          - space   source colour space tag ('RGB' | 'CMYK' | ...)
     */
    pixel(x, y) {
        const r = this._raw;
        if (x < 0 || x >= r.width || y < 0 || y >= r.height) {
            throw new Error(`iccimage: pixel(${x},${y}) out of bounds (${r.width}x${r.height})`);
        }
        const { eColourType } = _engine();

        // Read raw sample as native + as 0..1 normalised.
        const stride = r.bytesPerPixel;
        const idx    = (y * r.width + x) * stride;
        const data   = r.data;
        const norm   = (r.bitDepth === 8) ? 1 / 255
                     : (r.bitDepth === 16) ? 1 / 65535
                     : 1;
        const device = new Array(r.channels);
        for (let i = 0; i < r.channels; i++) device[i] = data[idx + i] * norm;

        // Build the colour object the engine wants. We use 'object' format
        // (integer ranges) for both pixelToLab and pixelToSRGB — same input
        // shape feeds both, output ranges are intuitive for display.
        const inObj = ICCImage._buildPixelObject(r.colorSpace, device, eColourType);

        // Lazy-build the two no-LUT accuracy-path transforms (cached on
        // the instance — not the cross-image TransformCache, which is
        // tuned for buildLut: true bulk pipelines).
        if (!this._pixelToLab) {
            const { Transform, eIntent } = _engine();
            this._pixelToLab = new Transform({ dataFormat: 'object' });
            this._pixelToLab.create(r.profile, '*Lab', eIntent.relative);
        }
        if (!this._pixelToSRGB) {
            const { Transform, eIntent } = _engine();
            this._pixelToSRGB = new Transform({ dataFormat: 'object' });
            this._pixelToSRGB.create(r.profile, '*sRGB', eIntent.relative);
        }

        const lab    = this._pixelToLab.transform(inObj);
        const srgbIn = this._pixelToSRGB.transform(inObj);
        const R = Math.round(srgbIn.R), G = Math.round(srgbIn.G), B = Math.round(srgbIn.B);

        return {
            lab:    { L: lab.L, a: lab.a, b: lab.b },
            srgb:   { R, G, B, hex: '#' + _hex2(R) + _hex2(G) + _hex2(B) },
            device,
            space:  r.colorSpace,
        };
    }

    // ── Memory ────────────────────────────────────────────────────────────

    /** Drop the raw buffer; keep the transform cache so derived ICCImages still work. */
    disposeRaw() {
        this._raw = null;
    }

    /** Drop everything. The instance is unusable after this. */
    dispose() {
        this._raw = null;
        this._cache.clear();
        this._pixelToLab = null;
        this._pixelToSRGB = null;
    }

    // ── Internals ─────────────────────────────────────────────────────────

    /** Produce a new ICCImage that shares this instance's transform cache. */
    _derive({ data, profile, colorSpace, channels, alpha, chain, bitDepth, width, height }) {
        const r = this._raw;
        const next = new ICCImage({
            width:    width  ?? r.width,
            height:   height ?? r.height,
            data,
            profile,
            colorSpace,
            channels,
            bitDepth: bitDepth ?? r.bitDepth,
            alpha,
            chain,
            transformCache: this._cache,
        });
        return next;
    }

    /** Run a Transform.transformArray over the raw buffer with sane alpha defaults. */
    _runArrayTransform(transform, outputRGBA) {
        const r = this._raw;
        const inU8 = this._rawAsUint8();
        const inHasAlpha = r.alpha !== false;
        const outHasAlpha = outputRGBA && inHasAlpha;
        return transform.transformArray(inU8, inHasAlpha, outHasAlpha, outHasAlpha);
    }

    /** The 'int8' fast path needs uint8 input. Down-convert from 16/float when needed. */
    _rawAsUint8() {
        const r = this._raw;
        if (r.bitDepth === 8) return r.data;
        const out = new Uint8ClampedArray(r.data.length);
        if (r.bitDepth === 16) {
            for (let i = 0; i < r.data.length; i++) out[i] = r.data[i] >> 8;
        } else {
            for (let i = 0; i < r.data.length; i++) out[i] = Math.round(r.data[i] * 255);
        }
        return out;
    }

    /** True if toCanvas() can blit without a colour transform. */
    _isDisplayReady() {
        const r = this._raw;
        return r.profile === _sRGBProfile()
            && r.bitDepth === 8
            && (r.alpha === 'straight' || r.alpha === 'premultiplied' || r.alpha === false)
            && r.colorSpace === 'RGB';
    }

    static _toProfile(spec) {
        if (spec && typeof spec === 'object' && spec.loaded !== undefined) return spec;
        if (typeof spec === 'string') {
            // Fast path for *sRGB so pointer-equality in _isDisplayReady holds.
            if (spec === '*sRGB') return _sRGBProfile();
            const { Profile } = _engine();
            const p = new Profile();
            p.load(spec);
            if (!p.loaded) throw new Error(`iccimage: could not load profile '${spec}'`);
            return p;
        }
        throw new Error('iccimage: profile must be a Profile instance or a "*name" string');
    }

    /** Build the `dataFormat: 'object'` colour object the engine expects. */
    static _buildPixelObject(colorSpace, normDevice, eColourType) {
        switch (colorSpace) {
            case 'RGB':
                return { type: eColourType.RGB,
                    R: Math.round(normDevice[0] * 255),
                    G: Math.round(normDevice[1] * 255),
                    B: Math.round(normDevice[2] * 255) };
            case 'CMYK':
                return { type: eColourType.CMYK,
                    C: normDevice[0] * 100, M: normDevice[1] * 100,
                    Y: normDevice[2] * 100, K: normDevice[3] * 100 };
            case 'GRAY':
                return { type: eColourType.Gray, G: normDevice[0] * 100 };
            default:
                throw new Error(`iccimage: pixel() unsupported colorSpace ${colorSpace}`);
        }
    }
}

// ── Free helpers ───────────────────────────────────────────────────────────

function _hex2(n) {
    const v = Math.max(0, Math.min(255, n | 0)).toString(16);
    return v.length < 2 ? '0' + v : v;
}

function _resolveTint(tint) {
    if (!tint) return null;
    if (Array.isArray(tint)) return tint;
    // CSS hex: '#rgb' or '#rrggbb'
    const m3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(tint);
    if (m3) return [parseInt(m3[1] + m3[1], 16), parseInt(m3[2] + m3[2], 16), parseInt(m3[3] + m3[3], 16)];
    const m6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(tint);
    if (m6) return [parseInt(m6[1], 16), parseInt(m6[2], 16), parseInt(m6[3], 16)];
    throw new Error(`iccimage: invalid tint '${tint}' (expected '#rrggbb' or [r,g,b])`);
}

/**
 * In-place bilinear downsample. Generic across Uint8ClampedArray /
 * Uint16Array / Float32Array — the typed-array store does the rounding.
 * Honest implementation; fast enough for demo-grade buffers (a 4 MP →
 * 2 MP RGBA8 downscale runs in tens of ms on V8).
 */
function _bilinearDownsample(srcData, srcW, srcH, dstW, dstH, totalCh, out) {
    const xRatio = srcW / dstW;
    const yRatio = srcH / dstH;
    for (let y = 0; y < dstH; y++) {
        const srcY = y * yRatio;
        const y0 = Math.floor(srcY);
        const y1 = Math.min(y0 + 1, srcH - 1);
        const fy = srcY - y0;
        const oy = 1 - fy;
        const rowA = y0 * srcW;
        const rowB = y1 * srcW;
        for (let x = 0; x < dstW; x++) {
            const srcX = x * xRatio;
            const x0 = Math.floor(srcX);
            const x1 = Math.min(x0 + 1, srcW - 1);
            const fx = srcX - x0;
            const ox = 1 - fx;
            const w00 = ox * oy;
            const w10 = fx * oy;
            const w01 = ox * fy;
            const w11 = fx * fy;
            const i00 = (rowA + x0) * totalCh;
            const i10 = (rowA + x1) * totalCh;
            const i01 = (rowB + x0) * totalCh;
            const i11 = (rowB + x1) * totalCh;
            const oi  = (y * dstW + x) * totalCh;
            for (let c = 0; c < totalCh; c++) {
                out[oi + c] = srcData[i00 + c] * w00
                            + srcData[i10 + c] * w10
                            + srcData[i01 + c] * w01
                            + srcData[i11 + c] * w11;
            }
        }
    }
}

/** Element-wise dtype conversion preserving normalised value range. */
function _convertBitDepth(src, dst, srcBits, dstBits) {
    const fromNorm = srcBits === 8 ? 1 / 255 : srcBits === 16 ? 1 / 65535 : 1;
    if (dstBits === 8) {
        const k = 255;
        for (let i = 0; i < src.length; i++) dst[i] = src[i] * fromNorm * k;
    } else if (dstBits === 16) {
        const k = 65535;
        for (let i = 0; i < src.length; i++) dst[i] = src[i] * fromNorm * k;
    } else {
        for (let i = 0; i < src.length; i++) dst[i] = src[i] * fromNorm;
    }
}
