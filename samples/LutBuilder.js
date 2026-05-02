/* ============================================================================
 *  LutBuilder.js — Stage 1: LUT creation, mutation, and transform wiring
 * ----------------------------------------------------------------------------
 *  Released under the MIT License
 *  Copyright (c) 2026 Glenn Wilton, O2 Creative Limited.
 *
 *  Note: the engine in ../src is MPL-2.0. This wrapper is MIT so it can be
 *  freely copied and adapted in projects that use jsColorEngine.
 * ============================================================================
 *
 *  WHAT THIS IS
 *
 *    A separation-of-concerns layer that creates, loads, mutates, and
 *    serialises LUTs — then hands them to jsColorEngine via setLut().
 *    The engine does not need to change; LutBuilder is purely a consumer
 *    of the existing Transform.setLut() contract.
 *
 *    See ./lutbuilder.md for the practical how-to with code samples, and
 *    ../docs/deepdive/Luts.md for the deep-dive design rationale, format
 *    spec, the lcms bridge, and the TIFF workflow roadmap.
 *
 *  STAGE 1 API
 *
 *    // Construction
 *    new LutBuilder()                    — empty builder, call a create method
 *    new LutBuilder(lut)                 — from existing LUT object (getLut())
 *    LutBuilder.fromTransform(t, opts)   — extract/build from a Transform
 *
 *    // Creation (each returns this for chaining)
 *    .create(options, callback)          — synthetic LUT from callback
 *    .createIdentity(channels, size)     — identity LUT (blank canvas)
 *    .createFromLCMS(lcms, xform, opts)  — lcms-wasm bridge (Tier 3)
 *
 *    // Mutation
 *    .editLut(callback)                  — per-cell mutation
 *    .clone()                            — deep copy
 *
 *    // Metadata
 *    .addMeta(obj)                       — merge key/values into lut.meta
 *    .addCopyright(str)
 *    .addAdjustment(str)                 — append to edit history
 *    .setChain(chain)                    — override profile chain
 *
 *    // Output
 *    .toLut()                            — raw LUT object (for setLut())
 *    .toTransform(options)               — ready-to-use Transform
 *
 *    // Virtual profile helpers
 *    virtualProfile(spec, opts)
 *    virtualRGB(name), virtualCMYK(name), virtualGray(name), virtualLab(name)
 *
 *  INTERNAL STORAGE
 *
 *    Canonical format is Uint16Array (u16, values 0–65535). This matches
 *    ICC spec precision, TIFF workflows, lcms-wasm output, and the engine's
 *    integer kernels. toLut() expands u16 → Float64Array for the engine.
 *    See docs/deepdive/Luts.md §2.4 for the precision proof.
 *
 *  LOOP ORDER
 *
 *    Grid axes fill outermost-first (axis 0 slowest, axis inCh-1 fastest),
 *    matching create3DDeviceLUT / create4DDeviceLUT in Transform.js. The
 *    callback receives input[0..inCh-1] with input[0] varying slowest.
 * ============================================================================
 */

'use strict';

// Resolve the engine + Profile in both Node (require) and the browser
// (window.jsColorEngine — set by ../browser/jsColorEngineWeb.js). The browser
// path lets demos load LutBuilder.js with a regular <script> tag without a
// bundler — no separate ESM build needed.
var engineModule, Profile;
if (typeof module === 'object' && module.exports && typeof require === 'function') {
    engineModule = require('../src/main');
    Profile      = require('../src/Profile');
} else if (typeof window !== 'undefined' && window.jsColorEngine) {
    engineModule = window.jsColorEngine;
    Profile      = window.jsColorEngine.Profile;
} else {
    throw 'LutBuilder.js: jsColorEngine not found — load ../browser/jsColorEngineWeb.js first (in browsers) or run from Node with the engine on disk.';
}
var Transform    = engineModule.Transform;
var eProfileType = engineModule.eProfileType;
var eIntent      = engineModule.eIntent;

// ─── Grid-fill helper for createFromLCMS (Emscripten batch path) ─────────────
//
// Fills the Uint16Array `view` with grid input coordinates as u16 [0..65535].
// Loop order: axis 0 outermost (slowest), axis inCh-1 innermost (fastest) —
// matches the engine's createNDDeviceLUT loop order so each cell's storage
// position aligns with what the engine's LUT kernels expect.

function _fillGridU16(view, inCh, size, sizeMax) {
    var p = 0, a, b, c, d, av, bv, cv;
    var step = function(i) { return Math.round(i / sizeMax * 65535); };
    switch (inCh) {
        case 1:
            for (a = 0; a < size; a++) view[p++] = step(a);
            break;
        case 2:
            for (a = 0; a < size; a++) { av = step(a);
            for (b = 0; b < size; b++) { view[p++] = av; view[p++] = step(b); }}
            break;
        case 3:
            for (a = 0; a < size; a++) { av = step(a);
            for (b = 0; b < size; b++) { bv = step(b);
            for (c = 0; c < size; c++) { view[p++] = av; view[p++] = bv; view[p++] = step(c); }}}
            break;
        case 4:
            for (a = 0; a < size; a++) { av = step(a);
            for (b = 0; b < size; b++) { bv = step(b);
            for (c = 0; c < size; c++) { cv = step(c);
            for (d = 0; d < size; d++) {
                view[p++] = av; view[p++] = bv; view[p++] = cv; view[p++] = step(d);
            }}}}
            break;
    }
}

// ─── colorSpace ↔ profile type mapping ───────────────────────────────────────

var _CS_FROM_CHANNELS = [undefined, 'GRAY', 'Duo', 'RGB', 'CMYK'];

var _TYPE_FROM_CS = {
    'GRAY': eProfileType.Gray,
    'Duo':  eProfileType.Duo,
    'RGB':  eProfileType.RGBMatrix,
    'CMYK': eProfileType.CMYK,
    'Lab':  eProfileType.Lab,
};

// ─── Virtual profile helpers ──────────────────────────────────────────────────

// Extract the same fields profile2Obj() does in Transform.js (not exported,
// so we replicate the field list here — both read the same Profile properties).
// The engine stores colorSpace in header.space (lowercase, e.g. 'rgb', 'Lab').
// We add header.colorSpace (uppercase, e.g. 'RGB', 'LAB') so the full path
// produces the same key name as the minimal virtualProfile() path.
function _profile2Desc(profile) {
    var h = Object.assign({}, profile.header || {});
    if (!h.colorSpace && h.space) {
        h.colorSpace = h.space.toUpperCase();
    }
    return {
        header:            h,
        name:              profile.name,
        type:              profile.type,
        intent:            profile.intent,
        whitePoint:        profile.whitePoint,
        description:       profile.description,
        viewingConditions: profile.viewingConditions,
        mediaWhitePoint:   profile.mediaWhitePoint,
        PCSEncode:         profile.PCSEncode,
        PCSDecode:         profile.PCSDecode,
        PCS8BitScale:      profile.PCS8BitScale,
        version:           profile.version,
    };
}

/**
 * Create a profile descriptor for use in a LUT chain.
 *
 * Accepts a '*'-prefixed string or object:
 *
 *   virtualProfile('*sRGB')                      — string shorthand
 *   virtualProfile({ name: '*sRGB' })             — object with *-name
 *   virtualProfile({ colorSpace: 'RGB', name: 'My RGB' })  — minimal descriptor
 *
 * When the name starts with '*', delegates to the engine's built-in virtual
 * profile builder (Profile.loadVirtualProfile — synchronous, no I/O) and
 * returns a full descriptor with PCS encoding, adapted primaries, and all the
 * provenance fields the engine normally serialises via profile2Obj().
 *
 * Supported '*' names: *sRGB, *AdobeRGB, *AppleRGB, *ColorMatchRGB,
 *                      *ProPhotoRGB, *Lab, *LabD50, *LabD65
 *
 * White point notes:
 *   RGB profiles (*sRGB, *AdobeRGB, etc.) have native D65 media white, but
 *   the engine stores D50-adapted primaries by default
 *   (virtualProfileUsesD50AdaptedPrimaries = true), so mediaWhitePoint is D50
 *   for all RGB virtual profiles. Use *LabD65 to get a D65 Lab profile.
 *
 * Without '*', produces a minimal descriptor — header, name, type, version.
 * Sufficient for pipeline routing; no primaries or whitepoint.
 *
 * @param {string|object} spec
 *   string  — '*<name>' shorthand, e.g. '*sRGB'
 *   object:
 *     .colorSpace {string}  — 'RGB', 'CMYK', 'GRAY', 'Lab', 'Duo'
 *     .name       {string}  — label, or '*<name>' for built-in
 *     .type       {number}  — eProfileType (derived from colorSpace if omitted)
 *     .version    {number}  — ICC version (default 4)
 * @param {object} [opts]
 *   opts.whitePoint, opts.mediaWhitePoint — reference metadata (minimal path only)
 * @returns {object} profile descriptor
 */
function virtualProfile(spec, opts) {
    // String shorthand: virtualProfile('*sRGB')
    var name = (typeof spec === 'string') ? spec : (spec.name || '');

    // '*' prefix — delegate to the engine's built-in virtual profile builder
    if (name.charAt(0) === '*') {
        var p = new Profile();
        p.loadVirtualProfile(name);   // strips '*' internally, synchronous, no I/O
        if (!p.loaded)
            throw 'virtualProfile: unknown built-in profile "' + name + '". ' +
                  'Supported: *sRGB, *AdobeRGB, *AppleRGB, *ColorMatchRGB, ' +
                  '*ProPhotoRGB, *Lab, *LabD50, *LabD65';
        return _profile2Desc(p);
    }

    // Minimal descriptor path — sufficient for pipeline routing
    var cs = (typeof spec === 'string') ? spec : spec.colorSpace;
    if (!cs) {
        var ch = spec.channels || 3;
        cs = _CS_FROM_CHANNELS[ch];
        if (!cs) throw 'virtualProfile: unsupported channel count ' + ch;
    }
    var type = (spec.type !== undefined) ? spec.type : _TYPE_FROM_CS[cs];
    if (type === undefined) throw 'virtualProfile: unknown colorSpace "' + cs + '"';

    var d = {
        header:  { colorSpace: cs },
        name:    name || ('LUT ' + cs),
        type:    type,
        version: spec.version || 4,
    };
    if (opts) {
        if (opts.whitePoint)      d.whitePoint      = opts.whitePoint;
        if (opts.mediaWhitePoint) d.mediaWhitePoint = opts.mediaWhitePoint;
    }
    return d;
}

function virtualRGB(name)  { return virtualProfile({ colorSpace: 'RGB',  name: name }); }
function virtualCMYK(name) { return virtualProfile({ colorSpace: 'CMYK', name: name }); }
function virtualGray(name) { return virtualProfile({ colorSpace: 'GRAY', name: name, channels: 1 }); }
function virtualLab(name)  { return virtualProfile({ colorSpace: 'Lab',  name: name }); }

// ─── TIFF builder utilities (Stage 3) ────────────────────────────────────────

var _TIFF_META_TAG  = 32768;
var _TIFF_DEF_SCALE = [0, 3, 3, 3, 2];   // default scale by inCh; 4D=2, rest=3

// Compute 2D slice-grid layout for exportTIFF / fromTIFF.
//
// For inCh >= 2: pack size^(inCh-2) slices, each slice is size×size pixels.
//   inCh=3 → N slices of N×N  (one per outermost axis)
//   inCh=4 → N² slices of N×N (one per combination of two outermost axes)
//
// For inCh=1 (tone curve): the data strip is size×1 pixels, but we give the canvas the
//   same visual height as the equivalent 3D layout (ceil(sqrt(size))×size×scale) so
//   preview images and text render at a comfortable size. On export, the strip is
//   expanded to fill that full height. On import, cells are always read from row 0.
//
// Returns { numSlices, slicesPerRow, slicesPerCol, lutW, lutH }
function _tiffLayout(inCh, size, scale) {
    var numSlices    = inCh < 2 ? 1 : Math.round(Math.pow(size, inCh - 2));
    var slicesPerRow = numSlices <= 1 ? 1 : Math.ceil(Math.sqrt(numSlices));
    var slicesPerCol = Math.ceil(numSlices / slicesPerRow);
    var sliceH       = inCh < 2 ? 1 : size;
    // For 1D (tone curves): decouple width from height so large N (e.g. 255) doesn't blow up.
    //   lutW = size × scale — the actual data strip width (255×3=765 for N=255 scale=3)
    //   lutH = 6 × 33 × scale — fixed reference height (same as 3D N=33), gives room
    //          for preview images and text regardless of how large N is.
    // On import, 1D cells are always read from row 0 (full-height columns have spread=0).
    var lutW = (inCh === 1) ? size * scale                               : slicesPerRow * size * scale;
    var lutH = (inCh === 1) ? Math.max(6 * 33 * scale, size * scale)   : slicesPerCol * sliceH * scale;
    return {
        numSlices:    numSlices,
        slicesPerRow: slicesPerRow,
        slicesPerCol: slicesPerCol,
        lutW: lutW,
        lutH: lutH,
    };
}

// Map a LUT cell (by linear index) to the top-left pixel of its scale×scale block.
// Loop order: axis 0 outermost, axis inCh-1 innermost — matches LutBuilder storage.
// The first (inCh-2) axes form the slice index; the last 2 are row/col within the slice.
function _cellPixelPos(cellIdx, inCh, size, scale, slicesPerRow) {
    var axes = new Array(inCh);
    var rem  = cellIdx;
    for (var ax = inCh - 1; ax >= 0; ax--) { axes[ax] = rem % size; rem = Math.floor(rem / size); }
    if (inCh === 1) return { px: axes[0] * scale, py: 0 };
    var sliceIdx = 0;
    for (var i = 0; i < inCh - 2; i++) sliceIdx = sliceIdx * size + axes[i];
    var cellRow = axes[inCh - 2];
    var cellCol = axes[inCh - 1];
    return {
        px: ((sliceIdx % slicesPerRow) * size + cellCol) * scale,
        py: (Math.floor(sliceIdx / slicesPerRow) * size + cellRow) * scale,
    };
}

// Read a scale×scale solid block from decoded TIFF pixel bytes and return u16[] per channel.
// pixels: Uint8Array (utif ifd.data), stride: image width in pixels, bps: 8|16 (LE).
// Throws if LSB spread exceeds threshold — indicates JPEG noise, wrong scale, or misalignment.
function _readTiffCell(pixels, stride, px, py, scale, outCh, bps) {
    var bpp       = outCh * (bps === 16 ? 2 : 1);
    var threshold = bps === 16 ? 512 : 514;   // 8-bit: allow 2 u8 LSB dither/quant noise (514 = 2*257)
    var n         = scale * scale;
    var sums = new Float64Array(outCh);
    var mins = new Uint32Array(outCh);  mins.fill(0xFFFF);
    var maxs = new Uint32Array(outCh);
    for (var dy = 0; dy < scale; dy++) {
        for (var dx = 0; dx < scale; dx++) {
            var base = ((py + dy) * stride + (px + dx)) * bpp;
            for (var ch = 0; ch < outCh; ch++) {
                var off = base + ch * (bps === 16 ? 2 : 1);
                var v   = bps === 16 ? (pixels[off] | (pixels[off + 1] << 8)) : pixels[off] * 257;
                sums[ch] += v;
                if (v < mins[ch]) mins[ch] = v;
                if (v > maxs[ch]) maxs[ch] = v;
            }
        }
    }
    for (var ch = 0; ch < outCh; ch++) {
        var spread = maxs[ch] - mins[ch];
        if (spread > threshold)
            throw 'LutBuilder.fromTIFF: cell at pixel (' + px + ',' + py + ') ch' + ch +
                  ' spread=' + spread + ' > threshold=' + threshold +
                  '. Likely JPEG compression, wrong scale, or grid misalignment.';
    }
    var result = new Array(outCh);
    for (var ch = 0; ch < outCh; ch++) result[ch] = Math.round(sums[ch] / n);
    return result;
}

// Write a minimal uncompressed little-endian TIFF.
// Metadata is stored in two places so it survives Photoshop round-trips:
//   tag 32768 (private) — read directly by our importer
//   tag 700   (XMP)     — preserved by Photoshop; our importer also reads this
// opts: { width, height, spp, bps, pixels: Uint8Array|Uint16Array, meta: string }
// Returns Uint8Array of raw TIFF bytes.
function _encodeTIFF(opts) {
    var w = opts.width, h = opts.height, spp = opts.spp, bps = opts.bps;
    var px = opts.pixels;
    // Escape non-ASCII so the tag stays pure 7-bit ASCII (JSON.parse handles \uXXXX).
    var metaStr = (opts.meta || '{}').replace(/[^\x00-\x7F]/g, function(c) {
        return '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4);
    });

    // Null-terminated ASCII bytes for private tag 32768
    var mBytes = [];
    for (var i = 0; i < metaStr.length; i++) mBytes.push(metaStr.charCodeAt(i));
    mBytes.push(0);
    var mLen = mBytes.length;

    // XMP packet — embeds the same JSON in a custom namespace (jsce:LutMeta).
    // Photoshop preserves unknown XMP namespaces through open/edit/save cycles.
    function _xmlEsc(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    var xmpStr =
        '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
        '<rdf:Description rdf:about="" xmlns:jsce="http://jscolorengine.io/lut/1.0/">\n' +
        '<jsce:LutMeta>' + _xmlEsc(metaStr) + '</jsce:LutMeta>\n' +
        '</rdf:Description>\n' +
        '</rdf:RDF>\n' +
        '</x:xmpmeta>\n' +
        '<?xpacket end="w"?>';
    var xBytes = [];
    for (var i = 0; i < xmpStr.length; i++) xBytes.push(xmpStr.charCodeAt(i) & 0xFF);
    var xLen = xBytes.length;

    // ── Build raw pixel bytes (LE for 16-bit) ────────────────────────────────
    var rawBytes;
    if (bps === 8) {
        rawBytes = (px instanceof Uint8Array) ? px : new Uint8Array(px);
    } else {
        rawBytes = new Uint8Array(px.length * 2);
        for (var i = 0, q = 0; i < px.length; i++) {
            rawBytes[q++] = px[i] & 0xFF;
            rawBytes[q++] = (px[i] >> 8) & 0xFF;
        }
    }

    // ── Compress in Node with zlib deflate; browser stays uncompressed ───────
    // TIFF compression tag 8 = ZIP/Deflate (supported by Photoshop, Affinity, GIMP).
    // utif handles tag 8 on import automatically (pako bundled inside utif).
    var stripData = rawBytes, compression = 1;
    if (typeof require === 'function') {
        try {
            var _zlib = require('zlib');
            var _comp = new Uint8Array(_zlib.deflateSync(rawBytes));
            if (_comp.length < rawBytes.length) { stripData = _comp; compression = 8; }
        } catch(e) { /* zlib unavailable — keep uncompressed */ }
    }
    var stripLen = stripData.length;

    var iccLen  = (opts.iccData instanceof Uint8Array) ? opts.iccData.length : 0;
    var numTags = iccLen > 0 ? 15 : 14;
    var ifdOff  = 8;
    var ifdSize = 2 + numTags * 12 + 4;
    var bpsOff  = ifdOff + ifdSize;
    var xresOff = bpsOff  + spp * 2;
    var yresOff = xresOff + 8;
    var metaOff = yresOff + 8;
    var xmpOff  = metaOff + mLen + (mLen & 1);
    var iccOff  = xmpOff  + xLen + (xLen & 1);
    var imgOff  = iccLen > 0 ? iccOff + iccLen + (iccLen & 1) : iccOff;

    var buf = new Uint8Array(imgOff + stripLen);

    function w16(o, v) { buf[o] = v & 0xFF; buf[o+1] = (v >> 8) & 0xFF; }
    function w32(o, v) { buf[o]=v&0xFF; buf[o+1]=(v>>8)&0xFF; buf[o+2]=(v>>16)&0xFF; buf[o+3]=(v>>>24)&0xFF; }

    // TIFF header: II (LE), magic 42, IFD offset
    buf[0]=0x49; buf[1]=0x49; w16(2, 42); w32(4, ifdOff);

    var p = ifdOff;
    w16(p, numTags); p += 2;

    function entry(tag, type, count, val) {
        w16(p, tag); w16(p+2, type); w32(p+4, count);
        if (type === 3 && count === 1) { w16(p+8, val); buf[p+10]=0; buf[p+11]=0; }
        else                            { w32(p+8, val); }
        p += 12;
    }

    var photom = spp === 4 ? 5 : (spp === 1 ? 1 : 2); // CMYK=5, MinIsBlack=1, RGB=2
    entry(256, 4, 1, w);
    entry(257, 4, 1, h);
    if (spp === 1) { entry(258, 3, 1, bps); } else { entry(258, 3, spp, bpsOff); }
    entry(259, 3, 1, compression);             // Compression: 1=none, 8=ZIP/Deflate
    entry(262, 3, 1, photom);                  // PhotometricInterpretation
    entry(273, 4, 1, imgOff);                  // StripOffsets
    entry(277, 3, 1, spp);                     // SamplesPerPixel
    entry(278, 4, 1, h);                       // RowsPerStrip
    entry(279, 4, 1, stripLen);                // StripByteCounts
    entry(282, 5, 1, xresOff);
    entry(283, 5, 1, yresOff);
    entry(296, 3, 1, 2);                       // ResolutionUnit: inch
    entry(700, 1, xLen, xmpOff);              // XMP (preserved by Photoshop)
    if (iccLen > 0) entry(34675, 1, iccLen, iccOff);  // ICC profile tag 34675
    entry(_TIFF_META_TAG, 1, mLen, metaOff);  // Private JSON tag 32768
    w32(p, 0);

    // Extra data
    for (var i = 0; i < spp; i++) w16(bpsOff + i * 2, bps);
    w32(xresOff, 72);  w32(xresOff + 4, 1);
    w32(yresOff, 72);  w32(yresOff + 4, 1);
    for (var i = 0; i < mLen; i++) buf[metaOff + i] = mBytes[i];
    for (var i = 0; i < xLen; i++) buf[xmpOff  + i] = xBytes[i];
    if (iccLen > 0) buf.set(opts.iccData, iccOff);

    buf.set(stripData, imgOff);   // compressed (Node) or raw (browser)
    return buf;
}

// Canvas environment factory — native Canvas API in browser, node-canvas in Node.
function _getCanvasEnv() {
    if (typeof document !== 'undefined' && document.createElement) {
        return {
            createCanvas: function(w, h) {
                var c = document.createElement('canvas'); c.width = w; c.height = h; return c;
            },
            loadImage: function(src) {
                return new Promise(function(res, rej) {
                    var img = new Image();
                    img.onload  = function() { res(img); };
                    img.onerror = function(e) { rej(new Error('Failed to load image: ' + src)); };
                    img.src = src;
                });
            },
        };
    }
    try {
        var nc = require('canvas');
        return { createCanvas: nc.createCanvas, loadImage: nc.loadImage };
    } catch(e) {
        throw 'LutBuilder.exportTIFF: canvas module not found. Install it: npm install canvas';
    }
}

// ─── LutBuilder ───────────────────────────────────────────────────────────────

class LutBuilder {

    constructor(lut) {
        this._u16   = null;   // Uint16Array — canonical internal storage
        this._inCh  = 0;
        this._outCh = 0;
        this._size  = 0;      // grid points per axis (symmetric grids only, Stage 1)
        this._chain = null;
        this._meta  = {};
        this._originalSignature = null;   // stamped on fromTransform/createFromLCMS
        if (lut) this._importLutObject(lut);
    }

    // ── Private: import from a LUT object ────────────────────────────────────
    //
    // Rule of thumb: LUTs at the API boundary are full-scale for their type.
    //   Float64Array  → values in [0..1]      (engine canonical, getLut())
    //   Uint16Array   → values in [0..65535]  (getLut16())
    //   Uint8Array    → values in [0..255]    (getLut8())
    //
    // The Transform's internal `intLut` (with its 65280 scale and Q0.16/Q0.13
    // weight encoding) is a WASM-kernel artifact and is never read here —
    // we always go through the canonical full-scale CLUT.

    _importLutObject(lut) {
        if (!lut || !lut.CLUT) throw 'LutBuilder: invalid lut object (missing CLUT)';

        this._inCh  = lut.inputChannels;
        this._outCh = lut.outputChannels;
        this._size  = lut.gridPoints[0];   // symmetric grids: all axes same size
        this._chain = lut.chain ? lut.chain.slice() : null;

        var clut = lut.CLUT;
        var n    = clut.length;
        this._u16 = new Uint16Array(n);

        if (clut instanceof Uint16Array) {
            // u16 full-scale [0..65535] — direct copy
            this._u16.set(clut);
        } else if (clut instanceof Uint8Array || clut instanceof Uint8ClampedArray) {
            // u8 full-scale [0..255] → u16 lossless bit-stretch (v * 257)
            for (var i = 0; i < n; i++) this._u16[i] = clut[i] * 257;
        } else {
            // Float64Array / Float32Array / plain Array — [0..1], quantise to u16
            for (var i = 0; i < n; i++) {
                this._u16[i] = Math.round(Math.min(1, Math.max(0, clut[i])) * 65535);
            }
        }

        if (lut.meta) this._meta = Object.assign({}, lut.meta);
        if (lut.originalSignature) this._originalSignature = lut.originalSignature;
    }

    // ── create(options, callback) ─────────────────────────────────────────────
    //
    // Fill a grid by calling callback(normalised, cell) → outputValues for
    // every grid point. Values are [0..1] in, [0..1] out.
    //
    // callback(normalised, cell)
    //   normalised  — number[] length inCh, [0..1] coords (pre-computed)
    //   cell.indices  — integer grid indices [0..size-1]
    //   cell.size     — grid points per axis
    //   cell.sizeMax  — size - 1 (convenience for normalisation)
    //   returns number[] length outCh, clamped to [0..1]

    create(options, callback) {
        var inCh  = options.inChannels;
        var outCh = options.outChannels;
        var size  = options.size || 33;

        if (!inCh || inCh < 1 || inCh > 4) throw 'LutBuilder.create: inChannels must be 1–4, got ' + inCh;
        if (!outCh || outCh < 1)            throw 'LutBuilder.create: outChannels must be >= 1, got ' + outCh;
        if (typeof callback !== 'function') throw 'LutBuilder.create: callback must be a function';
        if (size < 2)                       throw 'LutBuilder.create: size must be >= 2, got ' + size;

        this._inCh  = inCh;
        this._outCh = outCh;
        this._size  = size;
        this._chain = options.chain || null;
        this._originalSignature = null;   // user-defined callback — no "trusted source" to fingerprint

        var sizeMax    = size - 1;
        var totalCells = Math.pow(size, inCh);
        this._u16 = new Uint16Array(totalCells * outCh);

        var u16     = this._u16;
        var pos     = 0;
        var coords  = new Array(inCh).fill(0);
        var indices = new Array(inCh).fill(0);

        var writeCell = function () {
            var cell = { indices: indices.slice(), size: size, sizeMax: sizeMax };
            var out  = callback(coords.slice(), cell);
            if (!out || out.length < outCh)
                throw 'LutBuilder.create: callback returned ' + (out ? out.length : 0) +
                      ' values, expected ' + outCh;
            for (var o = 0; o < outCh; o++)
                u16[pos++] = Math.round(Math.min(1, Math.max(0, out[o])) * 65535);
        };

        // Nested loops — outermost first, innermost last.
        // Matches create3DDeviceLUT / create4DDeviceLUT loop order in Transform.js.
        var a, b, c, d;
        switch (inCh) {
            case 1:
                for (a = 0; a < size; a++) {
                    coords[0] = a / sizeMax; indices[0] = a;
                    writeCell();
                }
                break;
            case 2:
                for (a = 0; a < size; a++) { coords[0] = a / sizeMax; indices[0] = a;
                for (b = 0; b < size; b++) { coords[1] = b / sizeMax; indices[1] = b;
                    writeCell();
                }}
                break;
            case 3:
                for (a = 0; a < size; a++) { coords[0] = a / sizeMax; indices[0] = a;
                for (b = 0; b < size; b++) { coords[1] = b / sizeMax; indices[1] = b;
                for (c = 0; c < size; c++) { coords[2] = c / sizeMax; indices[2] = c;
                    writeCell();
                }}}
                break;
            case 4:
                for (a = 0; a < size; a++) { coords[0] = a / sizeMax; indices[0] = a;
                for (b = 0; b < size; b++) { coords[1] = b / sizeMax; indices[1] = b;
                for (c = 0; c < size; c++) { coords[2] = c / sizeMax; indices[2] = c;
                for (d = 0; d < size; d++) { coords[3] = d / sizeMax; indices[3] = d;
                    writeCell();
                }}}}
                break;
        }
        return this;
    }

    // ── createIdentity(channels, size) ───────────────────────────────────────

    createIdentity(channels, size) {
        if (!channels || channels < 1 || channels > 4)
            throw 'LutBuilder.createIdentity: channels must be 1–4, got ' + channels;
        return this.create(
            { inChannels: channels, outChannels: channels, size: size || 33 },
            function (input) { return input.slice(); }
        );
    }

    // ── createFromLCMS(lcms, xformId, options) ────────────────────────────────
    //
    // Tier 3 — lcms-wasm bridge. Samples the lcms transform at every grid
    // point and stores the u16 output directly. Zero-copy for the u16 path.
    //
    // The bridge is ~20 lines. lcms lifecycle (open/close profiles, transforms)
    // is the caller's responsibility. The builder only reads doTransformU16().
    //
    // Performance: ~36K calls for a 33-pt 3D LUT, ~1.2M for 33-pt 4D.
    // Build once and serialise (Stage 2) — not for per-request use.
    // For 4D in a UI context, offload to a Worker.

    createFromLCMS(lcms, xformId, options) {
        var inCh  = options.inChannels;
        var outCh = options.outChannels;
        var size  = options.size || 33;

        if (!inCh || inCh < 1 || inCh > 4) throw 'LutBuilder.createFromLCMS: inChannels must be 1–4';
        if (!outCh || outCh < 1)            throw 'LutBuilder.createFromLCMS: outChannels must be >= 1';
        if (size < 2)                       throw 'LutBuilder.createFromLCMS: size must be >= 2';
        if (!lcms) throw 'LutBuilder.createFromLCMS: lcms is required';

        // Two supported lcms APIs (auto-detected):
        //
        // 1. EMSCRIPTEN (lcms-wasm)  — preferred; ~80× faster.
        //    Requires _malloc, _free, _cmsDoTransform, HEAPU8 — all standard
        //    Emscripten exports. The entire grid is filled into one heap
        //    buffer, transformed in a single _cmsDoTransform call, then read
        //    back. Crosses the JS↔WASM boundary once instead of N⁴ times.
        //
        // 2. Per-cell  — lcms.doTransformU16(xformId, inU16, outU16).
        //    Fallback for any JS lcms wrapper that exposes a typed-array
        //    transform call. Slow for big grids (one WASM call per cell)
        //    but correct, and lets the API stay generic.
        var hasEmscripten = typeof lcms._malloc === 'function'
            && typeof lcms._free === 'function'
            && typeof lcms._cmsDoTransform === 'function'
            && lcms.HEAPU8;
        var hasPerCell = typeof lcms.doTransformU16 === 'function';
        if (!hasEmscripten && !hasPerCell)
            throw 'LutBuilder.createFromLCMS: lcms must expose either _cmsDoTransform/_malloc/_free (Emscripten lcms-wasm) or doTransformU16() (generic per-cell API)';

        this._inCh  = inCh;
        this._outCh = outCh;
        this._size  = size;
        this._chain = options.chain || null;

        var sizeMax    = size - 1;
        var totalCells = Math.pow(size, inCh);
        this._u16 = new Uint16Array(totalCells * outCh);

        if (hasEmscripten) {
            // Allocate input + output buffers on the WASM heap
            var inBytes  = totalCells * inCh  * 2;
            var outBytes = totalCells * outCh * 2;
            var inPtr  = lcms._malloc(inBytes);
            var outPtr = lcms._malloc(outBytes);
            try {
                var inView  = new Uint16Array(lcms.HEAPU8.buffer, inPtr,  totalCells * inCh);
                var outView = new Uint16Array(lcms.HEAPU8.buffer, outPtr, totalCells * outCh);

                // Fill the grid input — same loop order as createNDDeviceLUT
                _fillGridU16(inView, inCh, size, sizeMax);

                // One JS↔WASM crossing for the whole grid
                lcms._cmsDoTransform(xformId, inPtr, outPtr, totalCells);

                // Copy output off the heap (the heap may grow between calls)
                this._u16.set(outView);
            } finally {
                lcms._free(inPtr);
                lcms._free(outPtr);
            }
        } else {
            // Per-cell fallback path
            var u16    = this._u16;
            var pos    = 0;
            var inU16  = new Uint16Array(inCh);
            var outU16 = new Uint16Array(outCh);
            var indices = new Array(inCh).fill(0);
            var o;
            var fillCell = function () {
                for (var ch = 0; ch < inCh; ch++)
                    inU16[ch] = Math.round(indices[ch] / sizeMax * 65535);
                lcms.doTransformU16(xformId, inU16, outU16);
                for (o = 0; o < outCh; o++) u16[pos++] = outU16[o];
            };
            var a, b, c, d;
            switch (inCh) {
                case 1:
                    for (a = 0; a < size; a++) { indices[0]=a; fillCell(); }
                    break;
                case 2:
                    for (a = 0; a < size; a++) { indices[0]=a;
                    for (b = 0; b < size; b++) { indices[1]=b; fillCell(); }}
                    break;
                case 3:
                    for (a = 0; a < size; a++) { indices[0]=a;
                    for (b = 0; b < size; b++) { indices[1]=b;
                    for (c = 0; c < size; c++) { indices[2]=c; fillCell(); }}}
                    break;
                case 4:
                    for (a = 0; a < size; a++) { indices[0]=a;
                    for (b = 0; b < size; b++) { indices[1]=b;
                    for (c = 0; c < size; c++) { indices[2]=c;
                    for (d = 0; d < size; d++) { indices[3]=d; fillCell(); }}}}
                    break;
            }
        }

        // Stamp signature — lcms is a "trusted source" (deterministic conversion)
        this._originalSignature = Transform.signLut(this.toLut());
        return this;
    }

    // ── editLut(callback) ─────────────────────────────────────────────────────
    //
    // Iterate every grid cell. callback receives current output values and
    // the grid-cell context, returns mutated output values.
    //
    // callback(output, cell) → output
    //   output          — number[] length outCh, [0..1] (decoded from u16)
    //   cell.indices    — integer grid indices for this cell
    //   cell.normalised — input coords [0..1] for this cell
    //   cell.size / cell.sizeMax
    //   returns number[] length outCh, clamped to [0..1]

    editLut(callback) {
        if (!this._u16) throw 'LutBuilder.editLut: no LUT loaded';
        var u16     = this._u16;
        var inCh    = this._inCh;
        var outCh   = this._outCh;
        var size    = this._size;
        var sizeMax = size - 1;
        var totalCells = Math.pow(size, inCh);
        var pos = 0;

        for (var cell = 0; cell < totalCells; cell++) {
            // Decode current output values to [0..1]
            var output = new Array(outCh);
            for (var o = 0; o < outCh; o++)
                output[o] = u16[pos + o] / 65535;

            // Reverse the loop order to recover input indices for this cell
            var rem     = cell;
            var indices = new Array(inCh);
            for (var ax = inCh - 1; ax >= 0; ax--) {
                indices[ax] = rem % size;
                rem = Math.floor(rem / size);
            }
            var normalised = indices.map(function (i) { return i / sizeMax; });
            var cellObj = { indices: indices, size: size, sizeMax: sizeMax, normalised: normalised };

            var result = callback(output, cellObj);
            if (!result || result.length < outCh)
                throw 'LutBuilder.editLut: callback returned ' + (result ? result.length : 0) +
                      ' values, expected ' + outCh;
            for (var o = 0; o < outCh; o++)
                u16[pos + o] = Math.round(Math.min(1, Math.max(0, result[o])) * 65535);
            pos += outCh;
        }
        // Audit trail: auto-append a timestamped breadcrumb to meta.adjustments[].
        // Originally-stamped signature is intentionally NOT cleared — it remains
        // the source-marker. Verifiers compare current data hash to the stamped
        // signature; mismatch → "edited", and adjustments[] tells you what edits.
        if (!this._meta.adjustments) this._meta.adjustments = [];
        this._meta.adjustments.push('editLut() at ' + new Date().toISOString());
        return this;
    }

    // ── clone() ───────────────────────────────────────────────────────────────

    clone() {
        var b    = new LutBuilder();
        b._u16   = this._u16   ? new Uint16Array(this._u16) : null;
        b._inCh  = this._inCh;
        b._outCh = this._outCh;
        b._size  = this._size;
        b._chain = this._chain ? this._chain.slice() : null;
        b._meta  = JSON.parse(JSON.stringify(this._meta));
        b._originalSignature = this._originalSignature;
        return b;
    }

    // ── metadata ──────────────────────────────────────────────────────────────

    addMeta(obj) {
        Object.assign(this._meta, obj);
        return this;
    }

    addCopyright(str) {
        this._meta.copyright = str;
        return this;
    }

    addAdjustment(str) {
        if (!this._meta.adjustments) this._meta.adjustments = [];
        this._meta.adjustments.push(str);
        return this;
    }

    setChain(chain) {
        this._chain = chain;
        return this;
    }

    // ── toLut() ───────────────────────────────────────────────────────────────
    //
    // Build the LUT object that Transform.setLut() consumes.
    // CLUT is always Float64Array (engine contract). Strides match createLut()
    // in Transform.js: g1=N, g2=N², g3=N³, go0=C, go1=N·C, go2=N²·C, go3=N³·C.

    toLut() {
        if (!this._u16) throw 'LutBuilder.toLut: no LUT loaded — call a create method first';
        var N     = this._size;
        var inCh  = this._inCh;
        var outCh = this._outCh;

        // u16 → f64 (engine contract: CLUT must be Float64Array)
        var len  = this._u16.length;
        var CLUT = new Float64Array(len);
        for (var i = 0; i < len; i++) CLUT[i] = this._u16[i] / 65535;

        // Strides — identical to createLut() in Transform.js
        var g1 = N;
        var g2 = (inCh >= 2) ? g1 * N : 0;
        var g3 = (inCh >= 3) ? g2 * N : 0;

        var gridPoints = [];
        for (var ax = 0; ax < inCh; ax++) gridPoints.push(N);

        // Auto-generate a minimal chain if none was set.
        // The chain's first and last entries must have header + name + type + version
        // for setLut() pipeline routing. Intent is documentation only (baked into grid).
        var chain = this._chain;
        if (!chain) {
            var inCS  = _CS_FROM_CHANNELS[inCh]  || 'RGB';
            var outCS = _CS_FROM_CHANNELS[outCh] || 'RGB';
            chain = [
                virtualProfile({ colorSpace: inCS,  name: 'LUT input ('  + inCh  + 'ch)' }),
                eIntent.perceptual,
                virtualProfile({ colorSpace: outCS, name: 'LUT output (' + outCh + 'ch)' }),
            ];
        }

        var lut = {
            chain:          chain,
            version:        1,
            inputChannels:  inCh,
            outputChannels: outCh,
            gridPoints:     gridPoints,
            g1:             g1,
            g2:             g2,
            g3:             g3,
            go0:            outCh,
            go1:            g1 * outCh,
            go2:            g2 * outCh,
            go3:            g3 * outCh,
            CLUT:           CLUT,
            dataType:       'f64',
            encoding:       'number',
            precision:      null,
            outputScale:    1,
            inputScale:     1,
            gamutMode:      'none',
            gamutLimit:     0,
            gamutMapScale:  0,
            inLab:          null,
            outLab:         null,
        };

        if (Object.keys(this._meta).length > 0)
            lut.meta = Object.assign({}, this._meta);

        if (this._originalSignature)
            lut.originalSignature = this._originalSignature;

        return lut;
    }

    // ── toTransform(options) ─────────────────────────────────────────────────
    //
    // Build the LUT object and wire it into a new Transform via setLut().
    // Transform.setLut() is the authority — it reads the LUT, resolves the
    // matching kernel for dataFormat, and builds the intLut as needed.
    // No buildLut flag required.
    //
    // options.dataFormat — 'int8' | 'int16' | 'device' (default: 'int16')
    // options.lutMode    — passed to Transform constructor (default: 'auto')

    toTransform(options) {
        options = options || {};
        var lut = this.toLut();
        var transform = new Transform({
            dataFormat: options.dataFormat || 'int16',
            lutMode:    options.lutMode,
        });
        transform.setLut(lut);
        return transform;
    }

    // ── static fromTransform(transform, options) ──────────────────────────────
    //
    // Two paths:
    //   1. Transform already has a built LUT (buildLut: true was used)
    //      → extract it directly. options are ignored.
    //   2. Transform has no LUT → not yet implemented in Stage 1.
    //      Pass gridSize as a number; 'auto'/'high'/'low' modes come in Stage 2.

    static fromTransform(transform, options) {
        if (!transform) throw 'LutBuilder.fromTransform: transform is required';
        var b = new LutBuilder();

        if (transform.lut && transform.lut.CLUT) {
            // Read the canonical f64 CLUT — never the kernel-internal intLut.
            b._importLutObject(transform.lut);
            // Stamp signature — engine pipeline is a "trusted source" of colour math
            if (!b._originalSignature) {
                b._originalSignature = Transform.signLut(b.toLut());
            }
        } else {
            throw 'LutBuilder.fromTransform: Transform has no built LUT. ' +
                  'Create the Transform with buildLut: true, or call create()/createFromLCMS() ' +
                  'to build from scratch. (Building from an un-lutted Transform is Stage 2.)';
        }

        return b;
    }

    // ── toJSON(options) ──────────────────────────────────────────────────────
    //
    // Serialise to the portable JSON handshake format. Identical output to
    // `transform.toJSON()` — both delegate to `Transform.lutToJSON`, which is
    // the format authority. The result is directly consumable by:
    //   - Transform.fromJSON(json, opts)        — full Transform, ready to use
    //   - new Transform(opts).setLut(json)      — same thing, more explicit
    //   - LutBuilder.fromJSON(json)             — back into a builder
    //
    // options.dataType — 'u16' (default, lossless) | 'u8' (half size, lossy)
    // options.generator — override the generator metadata field

    toJSON(options) {
        if (!this._u16) throw 'LutBuilder.toJSON: no LUT loaded';
        // Default the generator to identify this came from LutBuilder; user
        // can override via options.generator.
        var opts = Object.assign({ generator: 'jsColorEngine LutBuilder' }, options || {});
        return Transform.lutToJSON(this.toLut(), opts);
    }

    // ── static fromJSON(input) ───────────────────────────────────────────────
    //
    // Inverse of toJSON. Accepts a JSON string or already-parsed object.
    // Delegates the format decoding to `Transform.jsonToLut` — same authority
    // as the engine path. This method exists for callers that want a
    // LutBuilder back (e.g. to edit, clone, re-export); for direct dispatch
    // use `Transform.fromJSON(json, opts)` instead.

    static fromJSON(input) {
        if (input == null) throw 'LutBuilder.fromJSON: input is required';
        var lut = Transform.jsonToLut(input);   // f64 CLUT, normalised
        var b = new LutBuilder();
        b._importLutObject(lut);
        return b;
    }

    // ── Signature accessors ──────────────────────────────────────────────────
    //
    // The signature ("FNV1A:<hex>") is a content fingerprint stamped at extract
    // time on `fromTransform()` and `createFromLCMS()`. It survives `editLut()`
    // (which records what changed in `meta.adjustments[]`) and `clone()`.
    // Use `verify()` to check whether the current LUT data still matches.

    /** Current `originalSignature` ("FNV1A:..." or null if not stamped). */
    get originalSignature() { return this._originalSignature; }

    /** Compute the current LUT signature on demand. */
    signature() {
        if (!this._u16) return null;
        return Transform.signLut(this.toLut());
    }

    /**
     * Verify the LUT against its `originalSignature`.
     * @returns {boolean|null} true if data matches, false if mutated, null if no signature stamped
     */
    verify() {
        if (!this._originalSignature) return null;
        return this.signature() === this._originalSignature;
    }

    // ── analyze(inputPixels, expectedPixels, opts) ───────────────────────────
    //
    // Measure how accurately this LUT reproduces a reference transformation.
    // Applies the LUT to inputPixels, then diffs the result against expectedPixels.
    //
    // inputPixels    — Uint8ClampedArray, inCh channels per pixel
    // expectedPixels — Uint8ClampedArray, outCh channels per pixel (ground truth)
    // opts.threshold — max acceptable mean ΔP for pass/fail (default 1.0)
    //
    // Returns the same report shape as LutBuilder.comparePixels.

    analyze(inputPixels, expectedPixels, opts) {
        if (!this._u16) throw 'LutBuilder.analyze: no LUT loaded';
        var t    = this.toTransform({ dataFormat: 'int8' });
        var pred = t.transformArray(inputPixels);
        if (pred.length !== expectedPixels.length)
            throw 'LutBuilder.analyze: predicted length ' + pred.length +
                  ' != expected length ' + expectedPixels.length +
                  ' (check inCh/outCh match the pixel arrays)';
        return LutBuilder.comparePixels(pred, expectedPixels, this._outCh, opts);
    }

    // ── static comparePixels(pixelsA, pixelsB, channels, opts) ──────────────
    //
    // Pure pixel-by-pixel comparison — no LUT transform applied.
    // Use this to compare two images directly (e.g. jsCE output vs Photoshop output).
    //
    // pixelsA, pixelsB — Uint8ClampedArray, same length, `channels` values per pixel
    // channels         — number of channels per pixel (e.g. 3 for RGB, 4 for CMYK)
    // opts.threshold   — max acceptable mean ΔP for pass/fail (default 1.0)
    //
    // ΔP = √(Σ (a_ch − b_ch)²) per pixel, all values on [0–255] scale.
    //   ΔP < 0.5 = sub-LSB — invisible at 8-bit
    //   ΔP < 1.0 = excellent
    //   ΔP < 3.0 = good
    //   ΔP < 5.0 = acceptable
    //   ΔP ≥ 5.0 = review

    // ── static pixelsToTIFF(pixels, width, height, spp, bps, opts) ──────────
    //
    // Write a raw pixel buffer as a minimal TIFF.  Useful for saving the output
    // of transformArray() as a file without going through exportTIFF's canvas path.
    //
    // pixels — Uint8Array or Uint8ClampedArray, spp channels per pixel, 8-bit values
    // bps    — bit depth: 8 (default) or 16
    // opts.iccData  — Uint8Array of ICC profile to embed (tag 34675)
    // opts.meta     — JSON string for private tag 32768 (optional)
    //
    // Returns Uint8Array of raw TIFF bytes.

    static pixelsToTIFF(pixels, width, height, spp, bps, opts) {
        return _encodeTIFF({
            width: width, height: height,
            spp: spp, bps: bps || 8,
            pixels: pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength),
            meta: (opts && opts.meta) || '{}',
            iccData: (opts && opts.iccData) || undefined,
        });
    }

    static comparePixels(pixelsA, pixelsB, channels, opts) {
        opts = opts || {};
        var outCh     = channels || 3;
        var threshold = opts.threshold != null ? opts.threshold : 1.0;

        if (pixelsA.length !== pixelsB.length)
            throw 'LutBuilder.comparePixels: length mismatch ' + pixelsA.length + ' vs ' + pixelsB.length;

        var total    = Math.floor(pixelsA.length / outCh);
        var dpArr    = new Float32Array(total);
        var sumDP    = 0, sumSqDP = 0, maxDP = 0, failed = 0;
        var chSumAbs = new Float64Array(outCh);
        var chSumSq  = new Float64Array(outCh);
        var chMax    = new Float64Array(outCh);

        for (var i = 0; i < total; i++) {
            var sqSum = 0;
            for (var ch = 0; ch < outCh; ch++) {
                var d  = pixelsA[i * outCh + ch] - pixelsB[i * outCh + ch];
                var da = d < 0 ? -d : d;
                sqSum        += d * d;
                chSumAbs[ch] += da;
                chSumSq[ch]  += d * d;
                if (da > chMax[ch]) chMax[ch] = da;
            }
            var dp = Math.sqrt(sqSum);
            dpArr[i] = dp;
            sumDP   += dp;
            sumSqDP += dp * dp;
            if (dp > maxDP) maxDP = dp;
            if (dp > threshold) failed++;
        }

        var sorted = dpArr.slice().sort();
        var meanDP = sumDP / total;
        var rmseDP = Math.sqrt(sumSqDP / total);

        var CS_NAMES = { 1: ['Gray'], 3: ['R','G','B'], 4: ['C','M','Y','K'] };
        var chNames  = CS_NAMES[outCh] || null;
        var channels_ = [];
        for (var ch = 0; ch < outCh; ch++) {
            channels_.push({
                name:       (chNames && chNames[ch]) || ('ch' + ch),
                meanDeltaP: chSumAbs[ch] / total,
                maxDeltaP:  chMax[ch],
                rmseDeltaP: Math.sqrt(chSumSq[ch] / total),
            });
        }

        var report = {
            pass:         failed === 0,
            threshold:    threshold,
            totalPixels:  total,
            failedPixels: failed,
            grade:        meanDP < 0.5 ? 'SUB-LSB' : meanDP < 1.0 ? 'EXCELLENT' :
                          meanDP < 3.0 ? 'GOOD'    : meanDP < 5.0 ? 'ACCEPTABLE' : 'REVIEW',
            maxDeltaP:    maxDP,
            meanDeltaP:   meanDP,
            rmseDeltaP:   rmseDP,
            p95DeltaP:    sorted[Math.floor(total * 0.95)],
            p99DeltaP:    sorted[Math.floor(total * 0.99)],
            channels:     channels_,
        };

        // Optional delta pixel arrays — disabled by default (can be large).
        // opts.returnDelta: true  — attach delta arrays to the report
        // opts.deltaAmplify: N    — multiply delta values for visibility (default 10)
        //
        // report.deltaMagnitudeU8  — Uint8Array(total), 1ch, ΔP magnitude per pixel
        // report.deltaChannelsU8   — Uint8Array(total * outCh), per-channel abs diff
        //
        // Both are amplified and clamped to [0,255]. A ΔP of 1.0 with amplify=10
        // appears as gray-10 in the magnitude image — subtle but visible.
        // Build a formatted text summary (always included — cheap to generate)
        var CS_N = { 1: ['Gray'], 3: ['R','G','B'], 4: ['C','M','Y','K'] };
        var txt = '=== ΔP Analysis Report ===\n';
        txt += 'Date     : ' + new Date().toISOString() + '\n';
        txt += 'Grade    : ' + report.grade + '\n';
        txt += 'Pixels   : ' + total + '\n';
        txt += '\nΔP overall\n';
        txt += '  Mean  : ' + report.meanDeltaP.toFixed(4) + '\n';
        txt += '  Max   : ' + report.maxDeltaP.toFixed(2) + '\n';
        txt += '  RMSE  : ' + report.rmseDeltaP.toFixed(4) + '\n';
        txt += '  p95   : ' + report.p95DeltaP.toFixed(3) + '\n';
        txt += '  p99   : ' + report.p99DeltaP.toFixed(3) + '\n';
        txt += '\nChannel breakdown:\n';
        for (var ci2 = 0; ci2 < outCh; ci2++) {
            var c2 = report.channels[ci2];
            txt += '  ' + c2.name.padEnd(5) + 'mean=' + c2.meanDeltaP.toFixed(3) +
                   '  max=' + Math.round(c2.maxDeltaP) + '  rmse=' + c2.rmseDeltaP.toFixed(3) + '\n';
        }
        txt += '\nPass   : ' + (report.pass ? 'YES' : 'NO — ' + failed + ' pixels exceed threshold ' + threshold) + '\n';
        report.reportText = txt;

        if (opts.returnDelta) {
            var amp  = opts.deltaAmplify != null ? opts.deltaAmplify : 10;
            report._deltaAmplify = amp;
            var magU8  = new Uint8Array(total);
            var chU8   = new Uint8Array(total * outCh);
            for (var i = 0; i < total; i++) {
                magU8[i] = Math.min(255, Math.round(dpArr[i] * amp));
                for (var ch = 0; ch < outCh; ch++) {
                    var d = Math.abs(pixelsA[i * outCh + ch] - pixelsB[i * outCh + ch]);
                    chU8[i * outCh + ch] = Math.min(255, Math.round(d * amp));
                }
            }
            report.deltaMagnitudeU8 = magU8;
            report.deltaChannelsU8  = chU8;
        }

        return report;
    }

    // ── exportTIFF(options) ───────────────────────────────────────────────────
    //
    // Export this LUT as a TIFF image.
    //
    // Layout:
    //   • LUT region  (top-left, 0,0): grid data packed as scale×scale solid
    //     pixel blocks.  Size = slicesPerRow×size×scale  ×  slicesPerCol×size×scale.
    //   • Preview column (right of LUT, same height): optional reference images,
    //     vertically stacked with a small gap, scaled to fill the column height.
    //   • Text strip (bottom 100 px): creation timestamp, chain info, copyright.
    //
    // The entire canvas background is drawn first (preview images, text), then
    // the LUT region is overwritten with the raw grid values so the data is always
    // pixel-perfect regardless of the background content.
    //
    // options:
    //   scale         {number}   1–8; default 3 (inCh<4) or 2 (inCh=4)
    //   bitDepth      {number}   8 | 16; default 16
    //   outputProfile {Profile}  optional — used to convert the sRGB canvas to the output colour space
    //   previewImages {string[]} optional image URLs / file paths
    //   description   {string}   optional first line of text strip
    //
    // Returns Promise<Uint8Array> — raw TIFF bytes ready to write to disk or download.

    exportTIFF(options) {
        if (!this._u16) throw 'LutBuilder.exportTIFF: no LUT loaded';
        options = options || {};

        var inCh  = this._inCh;
        var outCh = this._outCh;
        var size  = this._size;
        var u16   = this._u16;
        var self  = this;

        var scale    = options.scale    != null ? options.scale    : (_TIFF_DEF_SCALE[inCh] || 3);
        var bitDepth = options.bitDepth != null ? options.bitDepth : 16;
        if (scale < 1 || scale > 8)          throw 'LutBuilder.exportTIFF: scale must be 1–8';
        if (bitDepth !== 8 && bitDepth !== 16) throw 'LutBuilder.exportTIFF: bitDepth must be 8 or 16';

        var layout = _tiffLayout(inCh, size, scale);
        var lutW   = layout.lutW;
        var lutH   = layout.lutH;
        var GAP    = Math.max(4, scale * 4);
        var TEXT_H = 100;
        var env    = _getCanvasEnv();

        return Promise.resolve(options.previewImages || [])
            .then(function(srcs) {
                // Multi-channel (CMYK) output with preview images requires an output profile
                // to convert the sRGB canvas to the output colour space.
                // If no profile is supplied, silently drop preview images — the LUT data,
                // channel gradient bars, and text strip still export correctly.
                // This is the "untagged/generic CMYK" path: useful when an exact press
                // profile is not available or not required.
                if (outCh > 3 && srcs.length > 0 && !options.outputProfile) {
                    if (typeof console !== 'undefined')
                        console.warn('LutBuilder.exportTIFF: no outputProfile for CMYK export — ' +
                                     'preview images skipped. Provide outputProfile to include them.');
                    srcs = [];
                }
                return srcs.length
                    ? Promise.all(srcs.map(function(s) { return env.loadImage(s); }))
                    : [];
            })
            .then(function(imgs) {
                // Preview column: images fill lutH, stacked with gaps.
                // Column width = widest drawn image, but never wider than the image's
                // native width — prevents upscaling small images to an oversized column.
                var prevColW = 0;
                var imgDrawH = 0;
                if (imgs.length) {
                    imgDrawH = Math.floor((lutH - GAP * (imgs.length - 1)) / imgs.length);
                    imgs.forEach(function(img) {
                        var iw  = img.naturalWidth  || img.width  || 1;
                        var ih  = img.naturalHeight || img.height || 1;
                        var dw  = Math.min(Math.round(imgDrawH * iw / ih), iw); // cap at native width
                        if (dw > prevColW) prevColW = dw;
                    });
                }

                // Gradient bar column: one bar per output channel, right of preview images
                var BAR_W   = Math.max(20, scale * 7);  // bar width (= square height)
                var BAR_GAP = Math.max(3,  scale * 2);  // gap between bars
                var barColW = outCh * BAR_W + (outCh - 1) * BAR_GAP;
                // x origin of bar column inside outPx (calculated again after canvas is built)
                var barX0   = lutW + (prevColW ? GAP + prevColW : 0) + GAP;

                // Enforce a minimum canvas width so the text strip always has room.
                // Reference: 6×33×scale (= 594 at scale=3) — the standard N=33 3D width.
                // Small N (e.g. 9) would otherwise produce an 81px-wide canvas.
                var minW    = Math.ceil(Math.sqrt(33)) * 33 * scale;  // 594 at scale=3
                var canvasW = Math.max(barX0 + barColW, minW);
                var canvasH = lutH + TEXT_H;
                var canvas  = env.createCanvas(canvasW, canvasH);
                var ctx     = canvas.getContext('2d');

                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvasW, canvasH);

                // Draw preview images to the right of the LUT region
                if (imgs.length) {
                    var ix = lutW + GAP, iy = 0;
                    imgs.forEach(function(img) {
                        var iw  = img.naturalWidth  || img.width  || 1;
                        var ih  = img.naturalHeight || img.height || 1;
                        var dw  = Math.min(Math.round(imgDrawH * iw / ih), iw); // cap at native width
                        var dh  = Math.min(imgDrawH, ih);                        // cap at native height
                        ctx.drawImage(img, ix, iy, dw, dh);
                        iy += imgDrawH + GAP;
                    });
                }

                // Text strip below LUT region
                var fontSize = Math.max(11, Math.min(16, scale * 4));
                ctx.font      = fontSize + 'px monospace';
                ctx.fillStyle = '#222222';
                var ty = lutH + 18;
                var lines = [];
                if (options.description) lines.push(options.description);
                lines.push('Created: ' + new Date().toISOString());
                lines.push('jsColorEngine LutBuilder — inCh=' + inCh + ' outCh=' + outCh +
                           ' size=' + size + ' scale=' + scale + ' bps=' + bitDepth);
                if (self._meta.copyright) lines.push('© ' + self._meta.copyright);
                lines.forEach(function(line) { ctx.fillText(line, 8, ty); ty += fontSize + 5; });

                // Extract RGBA pixels from canvas
                var raw   = ctx.getImageData(0, 0, canvasW, canvasH).data; // Uint8ClampedArray
                var total = canvasW * canvasH;

                // Build per-channel pixel buffer (u8 or u16, outCh channels per pixel).
                var outPx = bitDepth === 16
                    ? new Uint16Array(total * outCh)
                    : new Uint8Array(total  * outCh);

                // Detect sRGB output profile by name — canvas is already sRGB so converting
                // sRGB→sRGB would be an identity pass. Skip it and copy channels directly.
                var _prof = options.outputProfile;
                var _profName = _prof ? ((_prof.description || _prof.name || '') + '').toLowerCase() : '';
                var _isSRGBOut = _prof && (_profName.indexOf('srgb') >= 0 || _profName.indexOf('iec61966') >= 0);

                if (_prof && !_isSRGBOut) {
                    // Convert sRGB canvas → output colour space (e.g. CMYK) using jsColorEngine.
                    // Strip alpha first (RGBA → RGB), transform, then write to outPx.
                    var convT = new Transform({ dataFormat: 'int8' });
                    convT.create('*sRGB', options.outputProfile, eIntent.perceptual);
                    var rgbIn = new Uint8ClampedArray(total * 3);
                    for (var i = 0; i < total; i++) {
                        rgbIn[i*3]   = raw[i*4];
                        rgbIn[i*3+1] = raw[i*4+1];
                        rgbIn[i*3+2] = raw[i*4+2];
                    }
                    var converted = convT.transformArray(rgbIn); // outCh channels per pixel
                    for (var i = 0; i < total; i++) {
                        for (var ch = 0; ch < outCh; ch++) {
                            var v = converted[i * outCh + ch];
                            outPx[i * outCh + ch] = bitDepth === 16 ? v * 257 : v;
                        }
                    }
                } else {
                    // No outputProfile path — each case handled by output channel count.
                    for (var i = 0; i < total; i++) {
                        var r4 = i * 4;
                        if (outCh === 1) {
                            // Gray: BT.601 luminance
                            var L = Math.round(0.299 * raw[r4] + 0.587 * raw[r4+1] + 0.114 * raw[r4+2]);
                            outPx[i] = bitDepth === 16 ? L * 257 : L;
                        } else if (outCh >= 4) {
                            // CMYK / multi-channel without a profile: copying sRGB channels
                            // directly would map white→[255,255,255,255] = 400% ink = black.
                            // Instead use K-only from inverted luminance so the background
                            // reads as white paper (K=0) and dark elements (text, bars) as
                            // black ink (K=220+). CMY channels stay zero = untagged CMYK.
                            var lum = Math.round(0.299 * raw[r4] + 0.587 * raw[r4+1] + 0.114 * raw[r4+2]);
                            var kVal = 255 - lum;   // white=0, black=255
                            for (var ch = 0; ch < outCh; ch++) {
                                var v = (ch === outCh - 1) ? kVal : 0; // K is last channel in CMYK
                                outPx[i * outCh + ch] = bitDepth === 16 ? v * 257 : v;
                            }
                        } else {
                            // RGB / Duo: copy channels from RGBA
                            for (var ch = 0; ch < outCh; ch++) {
                                var v = raw[r4 + (ch < 4 ? ch : 3)];
                                outPx[i * outCh + ch] = bitDepth === 16 ? v * 257 : v;
                            }
                        }
                    }
                }

                // Gradient bars — written directly as native channel values.
                // Layout: solid square → white gap (background) → gradient.
                //
                // Gradient direction by mode:
                //   CMYK (outputProfile set): ink ramp ci=max→0, others=0 → bottom=[0,0,0,0]=white paper
                //   RGB  (no profile, outCh>1): tint ramp ci=max(constant), others=0→max → bottom=white
                //   Gray (outCh=1):             standard ramp max→0 → bottom=black
                var maxVal  = bitDepth === 16 ? 65535 : 255;
                var sqH     = BAR_W;
                var sqGap   = Math.max(2, scale);              // white gap separating square from gradient
                var gradH   = lutH - sqH - sqGap;
                // inkMode: CMYK/multi-channel uses ink ramps (bars fade to 0 ink = white paper).
                // RGB uses tint ramps (bars fade to white = all channels at max).
                // Triggered by any outCh > 3, regardless of whether outputProfile was supplied.
                var inkMode = (outCh > 3) || !!options.outputProfile;

                for (var ci = 0; ci < outCh; ci++) {
                    var bx = barX0 + ci * (BAR_W + BAR_GAP);

                    // Solid square at top: pure channel colour
                    for (var dy = 0; dy < sqH; dy++) {
                        for (var dx = 0; dx < BAR_W; dx++) {
                            var dst = (dy * canvasW + bx + dx) * outCh;
                            for (var ch = 0; ch < outCh; ch++)
                                outPx[dst + ch] = (ch === ci) ? maxVal : 0;
                        }
                    }
                    // sqGap rows stay as background (white) — the visual separator

                    // Gradient (starts at sqH + sqGap)
                    for (var dy = 0; dy < gradH; dy++) {
                        var t   = (gradH - 1 - dy) / Math.max(1, gradH - 1); // 1=top, 0=bottom
                        var val = Math.round(t * maxVal);
                        for (var dx = 0; dx < BAR_W; dx++) {
                            var dst = ((sqH + sqGap + dy) * canvasW + bx + dx) * outCh;
                            for (var ch = 0; ch < outCh; ch++) {
                                var v;
                                if (ch === ci) {
                                    // Gray or CMYK: ramp down. RGB: stay at max (tint effect).
                                    v = (inkMode || outCh === 1) ? val : maxVal;
                                } else {
                                    // CMYK: other channels = 0. RGB: fade up to white.
                                    v = inkMode ? 0 : (maxVal - val);
                                }
                                outPx[dst + ch] = v;
                            }
                        }
                    }
                }

                // Overwrite LUT region with actual grid data.
                // ND (inCh>=2): scale×scale solid blocks per cell.
                // 1D (inCh=1): each cell is a full-height column (scale wide, lutH tall)
                //   so the tone curve renders as a visible gradient strip.
                //   On import, cells are still read from row 0 — the full-height write
                //   ensures every row of the block is solid (spread=0 validation passes).
                var totalCells = Math.round(Math.pow(size, inCh));
                var writeH     = (inCh === 1) ? lutH : scale;
                for (var ci = 0; ci < totalCells; ci++) {
                    var pos = _cellPixelPos(ci, inCh, size, scale, layout.slicesPerRow);
                    var src = ci * outCh;
                    for (var dy = 0; dy < writeH; dy++) {
                        for (var dx = 0; dx < scale; dx++) {
                            var dst = ((pos.py + dy) * canvasW + (pos.px + dx)) * outCh;
                            for (var ch = 0; ch < outCh; ch++) {
                                outPx[dst + ch] = bitDepth === 16
                                    ? u16[src + ch]
                                    : Math.round(u16[src + ch] / 257);
                            }
                        }
                    }
                }

                // Build TIFF metadata for private tag 32768
                var tagObj = {
                    v: 1, size: size, inCh: inCh, outCh: outCh, scale: scale,
                    slicesPerRow: layout.slicesPerRow, slicesPerCol: layout.slicesPerCol,
                    lutW: lutW, lutH: lutH,
                    inCS:  _CS_FROM_CHANNELS[inCh]  || 'RGB',
                    outCS: _CS_FROM_CHANNELS[outCh] || 'RGB',
                };
                if (self._chain) tagObj.chain = self._chain;
                if (Object.keys(self._meta).length) tagObj.lmeta = self._meta;
                if (options.description) tagObj.description = options.description;

                // Pass optional ICC profile bytes (tag 34675) for embedding
                var iccData = (options.iccProfileBytes instanceof Uint8Array)
                    ? options.iccProfileBytes
                    : null;
                if (iccData) tagObj.hasICC = true;

                return _encodeTIFF({
                    width: canvasW, height: canvasH, spp: outCh, bps: bitDepth,
                    pixels: outPx, meta: JSON.stringify(tagObj),
                    iccData: iccData || undefined,
                });
            });
    }

    // ── static fromTIFF(data, options) ────────────────────────────────────────
    //
    // Import a LUT from TIFF bytes written by exportTIFF() (or a compatible
    // colour-managed editor that preserved the private tag and used lossless
    // compression or none at all).
    //
    // Reads private tag 32768 for grid metadata. If the tag is absent (third-party
    // TIFF), supply the same values via options:
    //   options.size   {number}  grid points per axis — required
    //   options.inCh   {number}  default 3
    //   options.outCh  {number}  default 3
    //   options.scale  {number}  default 3
    //
    // Cell validation: each scale×scale block must have low LSB spread
    // (threshold: 2 for 8-bit, 512 for 16-bit). High spread → throws, indicating
    // JPEG artefacts, wrong scale, or grid misalignment.
    //
    // Returns a LutBuilder (synchronous).
    // Requires utif: npm install utif  |  <script src="utif.js"></script>

    static fromTIFF(data, options) {
        options = options || {};
        if (data == null) throw 'LutBuilder.fromTIFF: data is required';

        // Resolve utif dependency
        var utif;
        if (typeof require === 'function') { try { utif = require('utif'); } catch(e) {} }
        if (!utif && typeof window !== 'undefined') utif = window.UTIF;
        if (!utif)
            throw 'LutBuilder.fromTIFF: utif not available. ' +
                  'Install with: npm install utif  or  load utif.js in the browser.';

        // Normalise to ArrayBuffer
        var ab;
        if (data instanceof ArrayBuffer) {
            ab = data;
        } else if (ArrayBuffer.isView(data)) {
            ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        } else {
            throw 'LutBuilder.fromTIFF: data must be an ArrayBuffer or TypedArray';
        }

        var ifds = utif.decode(ab);
        if (!ifds || !ifds.length) throw 'LutBuilder.fromTIFF: no IFD found in TIFF data';
        var ifd = ifds[0];
        utif.decodeImage(ab, ifd);

        // ── Read LUT metadata — two sources, XMP takes priority ──────────────
        //
        // Tag 32768 (private): present in our own exports, stripped by Photoshop.
        // Tag 700 (XMP):       written by our exporter in jsce:LutMeta element;
        //                      Photoshop preserves unknown XMP namespaces on round-trip.
        //
        // Priority: XMP first (most likely to survive editing), then tag 32768.

        function _parseTagBytes(bytes) {
            var s = '';
            for (var i = 0; i < bytes.length; i++) { if (bytes[i] === 0) break; s += String.fromCharCode(bytes[i]); }
            return JSON.parse(s);
        }

        var meta = null;

        // 1. Try XMP tag 700 — jsce:LutMeta element
        var xmpTag = ifd['t700'];
        if (xmpTag && !meta) {
            try {
                var xmpStr = '';
                for (var i = 0; i < xmpTag.length; i++) xmpStr += String.fromCharCode(xmpTag[i]);
                var m = xmpStr.match(/<jsce:LutMeta>([\s\S]*?)<\/jsce:LutMeta>/);
                if (m) {
                    var jsonStr = m[1]
                        .replace(/&amp;/g,'&').replace(/&lt;/g,'<')
                        .replace(/&gt;/g,'>').replace(/&quot;/g,'"');
                    meta = JSON.parse(jsonStr);
                }
            } catch(e) { meta = null; }
        }

        // 2. Fallback: tag 32768 (preserved in non-Photoshop tools)
        var rawTag = ifd['t' + _TIFF_META_TAG] || ifd[_TIFF_META_TAG];
        if (rawTag && !meta) {
            try { meta = _parseTagBytes(rawTag); } catch(e) { meta = null; }
        }

        // Fall back to caller-supplied options when both tags are absent
        if (!meta) {
            if (!options.size)
                throw 'LutBuilder.fromTIFF: metadata tag absent. ' +
                      'Supply options.size (and optionally options.inCh, options.outCh, options.scale).';
            var fl = _tiffLayout(options.inCh || 3, options.size, options.scale || 3);
            meta = {
                v: 1, size: options.size,
                inCh:  options.inCh  || 3,
                outCh: options.outCh || 3,
                scale: options.scale || 3,
                slicesPerRow: fl.slicesPerRow, slicesPerCol: fl.slicesPerCol,
                lutW: fl.lutW, lutH: fl.lutH,
            };
        }

        // 0. Reject planar (PlanarConfiguration=2 — RRRGGGBBB) — not supported.
        //    Resave the TIFF as interleaved (Photoshop default) to import.
        var pcTag = ifd['t284'];
        if (pcTag && pcTag[0] === 2)
            throw 'LutBuilder.fromTIFF: planar TIFF (PlanarConfiguration=2, RRRGGGBBB) is not ' +
                  'supported. Re-save from Photoshop with interleaved channels (the default): ' +
                  'File → Save As → TIFF → uncheck "Save Image Pyramid" and leave Pixel Order as Interleaved.';

        // 1. Detect actual output channel count — Photoshop may have changed the colour space
        var sppTag    = ifd['t277'];
        var actualSPP = (sppTag && sppTag[0]) ? sppTag[0] : 0;
        if (actualSPP > 0 && actualSPP !== meta.outCh) {
            meta = Object.assign({}, meta);
            meta.outCh = actualSPP;
        }

        // 2. Extract embedded ICC profile (tag 34675) for chain output descriptor
        var embeddedProfileDesc = null;
        var iccTag = ifd['t34675'];
        if (iccTag && iccTag.length > 0) {
            try {
                var iccBuf = (iccTag instanceof Uint8Array) ? iccTag : new Uint8Array(iccTag);
                var iccProf = new Profile();
                iccProf.loadBinary(iccBuf);
                if (iccProf.loaded) embeddedProfileDesc = _profile2Desc(iccProf);
            } catch(e) { /* ignore — use chain from metadata */ }
        }

        var size         = meta.size;
        var inCh         = meta.inCh;
        var outCh        = meta.outCh;
        var scale        = meta.scale || options.scale || 3;
        var slicesPerRow = meta.slicesPerRow;

        // Detect bit depth from IFD (utif stores BitsPerSample as 't258' Uint16Array)
        var bpsArr = ifd['t258'];
        var bps    = (bpsArr && bpsArr[0]) ? bpsArr[0] : 8;

        var pixels = ifd.data;   // Uint8Array — utif decoded pixel bytes (LE for 16-bit)
        var width  = ifd.width;

        var totalCells = Math.round(Math.pow(size, inCh));
        var u16arr     = new Uint16Array(totalCells * outCh);

        for (var ci = 0; ci < totalCells; ci++) {
            var pos  = _cellPixelPos(ci, inCh, size, scale, slicesPerRow);
            var vals = _readTiffCell(pixels, width, pos.px, pos.py, scale, outCh, bps);
            for (var ch = 0; ch < outCh; ch++) {
                u16arr[ci * outCh + ch] = vals[ch];
            }
        }

        var b = new LutBuilder();
        b._inCh  = inCh;
        b._outCh = outCh;
        b._size  = size;
        b._u16   = u16arr;
        if (meta.chain) b._chain = meta.chain.slice();
        if (embeddedProfileDesc && b._chain && b._chain.length >= 3) {
            b._chain[2] = embeddedProfileDesc;  // override with embedded ICC profile
        }
        if (meta.lmeta) b._meta  = Object.assign({}, meta.lmeta);
        return b;
    }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

var _exports = {
    LutBuilder:     LutBuilder,
    virtualProfile: virtualProfile,
    virtualRGB:     virtualRGB,
    virtualCMYK:    virtualCMYK,
    virtualGray:    virtualGray,
    virtualLab:     virtualLab,
};

if (typeof module === 'object' && module.exports) {
    // Node CJS — what the Jest tests use.
    module.exports = _exports;
} else if (typeof window !== 'undefined') {
    // Browser global — the demo loads via <script src="LutBuilder.js"></script>.
    window.LutBuilder     = LutBuilder;
    window.virtualProfile = virtualProfile;
    window.virtualRGB     = virtualRGB;
    window.virtualCMYK    = virtualCMYK;
    window.virtualGray    = virtualGray;
    window.virtualLab     = virtualLab;
}
