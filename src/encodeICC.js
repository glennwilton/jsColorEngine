// src/encodeICC.js
//
// ICC profile WRITER — the mirror of decodeICC.js.
//
// WHY THIS EXISTS. The engine could read ICC profiles and never write one, so
// the only profiles it could be tested against were the ones somebody shipped
// it. That is fine for RGB and CMYK, where real profiles are everywhere, and
// useless above four channels: there is no oracle for Kernel1D, Kernel2D or
// KernelND because there is nothing to hand Little CMS. An encoder turns
// "we agree with ourselves" into "we agree with lcms".
//
// It is also a feature in its own right. A Profile that has been decoded can
// have its TRCs or its CLUT modified and written back out, which is what
// profile editing is; and a Transform that has collapsed a chain can be
// written as a device link.
//
// SCOPE, DELIBERATELY SMALL FOR NOW. Two shapes, both tag-based, no LUT
// encoding:
//
//   GRAY   wtpt + kTRC          -- gray, the smallest valid profile there is
//   RGB    wtpt + [rgb]XYZ + [rgb]TRC   -- a matrix-shaper
//
// Both are written as ICC v2.4 with an XYZ PCS. v2 rather than v4 because its
// text tag (`desc`) is a fixed layout rather than a language table, every CMS
// reads it, and nothing here needs what v4 added.
//
// WHAT IT REFUSES. Anything needing an A2B/B2A LUT -- CMYK, nCLR, and any
// profile whose decode produced .A2B or .B2A -- throws rather than writing a
// profile that silently drops the tag that does the work. mft2/mAB encoding is
// the next piece, and it is what unlocks 2CLR through 15CLR.
'use strict';

var D50 = { X: 0.9642, Y: 1.0, Z: 0.8249 };

// ============================================================================
//  PRIMITIVE WRITERS — the inverse of decodeICC's readers
// ============================================================================

/** Append a big-endian uint8. */
function u8(out, n){ out.push(n & 0xff); }

/** Append a big-endian uint16. */
function u16(out, n){ out.push((n >>> 8) & 0xff, n & 0xff); }

/** Append a big-endian uint32. */
function u32(out, n){
    out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

/**
 * Append an s15Fixed16Number (signed 15.16 fixed point).
 *
 * Math.round rather than truncation: decodeICC divides by 65536 on the way
 * back, so truncating here makes every round trip lose up to 1/65536 in the
 * same direction, and a profile written from a decoded one would drift a
 * little further every pass.
 */
function s15Fixed16(out, v){ u32(out, Math.round(v * 65536)); }

/** Append a u8Fixed8Number (unsigned 8.8), used for `curv` gamma. */
function u8Fixed8(out, v){ u16(out, Math.round(v * 256)); }

/** Append `length` ASCII bytes, truncated or NUL-padded to fit exactly. */
function chars(out, str, length){
    str = String(str == null ? '' : str);
    for(var i = 0; i < length; i++){
        out.push(i < str.length ? (str.charCodeAt(i) & 0xff) : 0);
    }
}

/** Append `n` zero bytes. */
function zeros(out, n){ for(var i = 0; i < n; i++) out.push(0); }

/** Pad to the next 4-byte boundary. Every ICC tag is 4-aligned. */
function pad4(out){ while(out.length % 4) out.push(0); }

// ============================================================================
//  TAG TYPE WRITERS
// ============================================================================

/** XYZType ('XYZ '). 20 bytes: sig, reserved, then one XYZNumber. */
function XYZType(xyz){
    var out = [];
    chars(out, 'XYZ ', 4);
    zeros(out, 4);
    s15Fixed16(out, xyz.X);
    s15Fixed16(out, xyz.Y);
    s15Fixed16(out, xyz.Z);
    return out;
}

/**
 * curveType ('curv'), written to match how decodeICC.curve() reads it.
 *
 * The ICC count field carries three different meanings, and this is the whole
 * of the curve encoding:
 *   0    linear -- no data follows
 *   1    one u8Fixed8 gamma value
 *   n    n uint16 samples mapping 0..65535 onto 0.0..1.0
 *
 * A decoded curve arrives as {passThrough, count, gamma, data, dataf}. A
 * `para` (parametric) curve decodes with .params set and no samples; there is
 * nothing to write it as in this version, so it is resampled to 1024 points
 * through its own curveFn. That is lossy in representation and not in value:
 * 1024 points is finer than the 8- and 16-bit paths that read it.
 */
function curveType(curve){
    var out = [];
    chars(out, 'curv', 4);
    zeros(out, 4);

    if(!curve || curve.passThrough){
        u32(out, 0);                       // linear
        return out;
    }

    if(curve.data && curve.count > 1){
        u32(out, curve.count);
        for(var i = 0; i < curve.count; i++) u16(out, curve.data[i]);
        return out;
    }

    if(curve.params && typeof curve.curveFn === 'function'){
        var N = 1024;
        u32(out, N);
        for(var s = 0; s < N; s++){
            var v = curve.curveFn(s / (N - 1));
            u16(out, Math.max(0, Math.min(65535, Math.round(v * 65535))));
        }
        return out;
    }

    // A single gamma. u8Fixed8 tops out at 255.996, which no real TRC
    // approaches, but clamp rather than silently wrapping.
    u32(out, 1);
    u8Fixed8(out, Math.max(0, Math.min(255.99, curve.gamma || 1)));
    return out;
}

/**
 * textDescriptionType ('desc') -- the v2 description tag.
 *
 * Fixed layout, and the trailing block is not optional: a reader that walks it
 * will run off the end of the tag without the Unicode and ScriptCode fields,
 * even when they are empty. 90 bytes of overhead plus the ASCII.
 */
function textDescriptionType(text){
    var out = [];
    var ascii = String(text == null ? '' : text);
    chars(out, 'desc', 4);
    zeros(out, 4);
    u32(out, ascii.length + 1);            // count INCLUDES the NUL
    chars(out, ascii, ascii.length);
    u8(out, 0);
    u32(out, 0);                           // Unicode language code
    u32(out, 0);                           // Unicode count
    u16(out, 0);                           // ScriptCode code
    u8(out, 0);                            // ScriptCode count
    zeros(out, 67);                        // ScriptCode description
    return out;
}

/** textType ('text'). ASCII plus a NUL. Used for the copyright tag. */
function textType(text){
    var out = [];
    var ascii = String(text == null ? '' : text);
    chars(out, 'text', 4);
    zeros(out, 4);
    chars(out, ascii, ascii.length);
    u8(out, 0);
    return out;
}

// ============================================================================
//  PROFILE ASSEMBLY
// ============================================================================

/**
 * The 128-byte header.
 *
 * profileSize is written as 0 and patched once the tag data is laid out --
 * it cannot be known until then, and guessing it is how a profile ends up
 * unreadable.
 */
function header(opts){
    var out = [];
    u32(out, 0);                                  // size, patched later
    zeros(out, 4);                                // preferred CMM: none
    u32(out, 0x02400000);                         // v2.4.0
    chars(out, opts.profileClass || 'mntr', 4);
    chars(out, opts.colorSpace, 4);
    chars(out, 'XYZ ', 4);                        // PCS

    var d = opts.date || new Date();
    u16(out, d.getUTCFullYear()); u16(out, d.getUTCMonth() + 1); u16(out, d.getUTCDate());
    u16(out, d.getUTCHours());    u16(out, d.getUTCMinutes());   u16(out, d.getUTCSeconds());

    chars(out, 'acsp', 4);
    zeros(out, 4);                                // platform
    zeros(out, 4);                                // flags
    zeros(out, 4);                                // device manufacturer
    zeros(out, 4);                                // device model
    zeros(out, 8);                                // device attributes
    u32(out, opts.intent || 0);
    s15Fixed16(out, D50.X); s15Fixed16(out, D50.Y); s15Fixed16(out, D50.Z);
    zeros(out, 4);                                // profile creator
    zeros(out, 16);                               // profile ID (md5) -- not computed
    zeros(out, 28);                               // reserved
    return out;
}

/**
 * Lay out header + tag table + tag data, and patch the size.
 *
 * @param {object} opts             header fields
 * @param {Array<[string, Array]>} tags  [signature, bytes] in table order
 * @returns {Uint8Array}
 */
function assemble(opts, tags){
    var out = header(opts);

    // The tag table is fixed-size once the count is known, so every tag's
    // offset can be computed before any of the data is appended.
    var tableBytes = 4 + tags.length * 12;
    var offset = out.length + tableBytes;

    u32(out, tags.length);
    var offsets = [];
    for(var i = 0; i < tags.length; i++){
        var size = tags[i][1].length;
        offsets.push(offset);
        chars(out, tags[i][0], 4);
        u32(out, offset);
        u32(out, size);                 // the SIZE excludes the alignment pad
        offset += size;
        while(offset % 4) offset++;     // ...but the next offset accounts for it
    }

    for(var t = 0; t < tags.length; t++){
        Array.prototype.push.apply(out, tags[t][1]);
        pad4(out);
    }

    var bytes = new Uint8Array(out);
    var size = bytes.length;
    bytes[0] = (size >>> 24) & 0xff; bytes[1] = (size >>> 16) & 0xff;
    bytes[2] = (size >>> 8) & 0xff;  bytes[3] = size & 0xff;
    return bytes;
}

module.exports = {
    D50: D50,
    u8: u8, u16: u16, u32: u32,
    s15Fixed16: s15Fixed16, u8Fixed8: u8Fixed8,
    chars: chars, zeros: zeros, pad4: pad4,
    XYZType: XYZType, curveType: curveType,
    textDescriptionType: textDescriptionType, textType: textType,
    header: header, assemble: assemble,
};
