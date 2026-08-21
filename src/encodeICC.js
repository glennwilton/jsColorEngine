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
// SCOPE. Written as ICC v2.4 -- v2 rather than v4 because its text tag
// (`desc`) is a fixed layout rather than a language table, every CMS reads it,
// and nothing here needs what v4 added.
//
//   GRAY   wtpt + kTRC                 the smallest valid profile there is
//   nCLR   wtpt + A2B0/1/2 as mft2     2CLR through FCLR, Lab PCS
//
// RGB IS DELIBERATELY ABSENT. Not because it is hard -- because it is the one
// shape there is no shortage of. Real RGB profiles are everywhere and this
// engine already carries virtual ones; writing more would test the writer, not
// the engine. The gaps worth filling are 1-2 channels and LUT-based profiles
// above 4, which is exactly what is here.
//
// (It is also the shape most likely to be written WRONG: rXYZ/gXYZ/bXYZ hold
// D50-adapted colourants while the decoder keeps the unadapted matrix, so a
// naive writer produces a profile that opens cleanly and is off by a chromatic
// adaptation. Skipping it skips that.)
'use strict';

var D50 = { X: 0.9642, Y: 1.0, Z: 0.8249 };

/**
 * ICC colour-space signatures by channel count.
 *
 * The n-colour signatures run '2CLR'..'9CLR' and then keep going in HEX --
 * 'ACLR' is TEN channels, not A-as-in-letter, and 'FCLR' is fifteen. That is
 * also where MAX_KERNEL_DIMENSIONS = 15 comes from: it is the widest thing ICC
 * can name.
 */
var COLOUR_SPACE_SIG = {
    1: 'GRAY', 3: 'RGB ', 4: 'CMYK',
    2: '2CLR', 5: '5CLR', 6: '6CLR', 7: '7CLR', 8: '8CLR', 9: '9CLR',
    10: 'ACLR', 11: 'BCLR', 12: 'CCLR', 13: 'DCLR', 14: 'ECLR', 15: 'FCLR',
};

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
    chars(out, opts.pcs || 'XYZ ', 4);            // 'XYZ ' or 'Lab '

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
    var i, t;

    // SHARED TAG DATA. The ICC spec allows several tag signatures to point at
    // the same element data, and real profiles lean on it hard: A2B0, A2B1 and
    // A2B2 (perceptual, relative colorimetric, saturation) commonly reference
    // one table rather than carrying three copies of it. There is no A2B3 --
    // absolute colorimetric is derived from A2B1 and the media white point at
    // transform time, not stored.
    //
    // Sharing is by ARRAY IDENTITY: pass the same array object for two tags
    // and it is written once and pointed at twice. That keeps it explicit at
    // the call site, where the caller knows whether two tables are genuinely
    // the same thing or merely equal today. On a 6-channel A2B this is the
    // difference between a 3 MB profile and a 1 MB one.
    var written = [];               // [dataArray, offset] pairs, by identity
    var offsetOf = function(data){
        for(var w = 0; w < written.length; w++){
            if(written[w][0] === data) return written[w][1];
        }
        return -1;
    };

    // The tag table is fixed-size once the count is known, so every offset can
    // be computed before any data is appended.
    var tableBytes = 4 + tags.length * 12;
    var offset = out.length + tableBytes;

    u32(out, tags.length);
    for(i = 0; i < tags.length; i++){
        var data = tags[i][1];
        var shared = offsetOf(data);
        var at = (shared !== -1) ? shared : offset;

        chars(out, tags[i][0], 4);
        u32(out, at);
        u32(out, data.length);          // the SIZE excludes the alignment pad

        if(shared === -1){
            written.push([data, offset]);
            offset += data.length;
            while(offset % 4) offset++; // ...but the next offset accounts for it
        }
    }

    // A PLAIN LOOP, NOT push.apply. apply() passes every element as an
    // argument and blows the stack somewhere around 100k of them -- a 5CLR
    // CLUT is 966k bytes, so the first n-channel profile written found this
    // immediately.
    for(t = 0; t < written.length; t++){
        var data = written[t][0];
        for(var k = 0; k < data.length; k++) out.push(data[k]);
        pad4(out);
    }

    var bytes = new Uint8Array(out);
    var size = bytes.length;
    bytes[0] = (size >>> 24) & 0xff; bytes[1] = (size >>> 16) & 0xff;
    bytes[2] = (size >>> 8) & 0xff;  bytes[3] = size & 0xff;
    return bytes;
}

/**
 * lut16Type ('mft2') — the tag that does the work in a LUT-based profile.
 *
 * THE LAYOUT, which is the whole of it:
 *
 *    0  'mft2'
 *    4  reserved (4 zero bytes)
 *    8  input channels   (u8)
 *    9  output channels  (u8)
 *   10  grid points      (u8)   ONE byte, shared by every input axis
 *   11  reserved         (u8)
 *   12  3x3 matrix, 9 x s15Fixed16      (36 bytes)
 *   48  input table entries   (u16)
 *   50  output table entries  (u16)
 *   52  input curves   entries x inputChannels  x u16
 *       CLUT           grid^inputChannels x outputChannels x u16
 *       output curves  entries x outputChannels x u16
 *
 * TWO THINGS THAT BITE.
 *
 * The grid count is a SINGLE BYTE for all axes, so every input dimension has
 * the same resolution and the ceiling is 255. That is what makes a 15-channel
 * A2B impractical rather than merely large: the cell count is grid^channels, so
 * even 3 points per axis is 14.3 million cells before the output stride.
 *
 * The matrix is only meaningful when the input space is XYZ, and it must be
 * IDENTITY otherwise -- not zero. A zero matrix is a valid encoding of "map
 * everything to black", and a reader that applies it will do exactly that.
 *
 * @param {object} lut
 * @param {number} lut.inputChannels
 * @param {number} lut.outputChannels
 * @param {number} lut.gridPoints          per axis, same for all
 * @param {Uint16Array|number[]} lut.CLUT  grid^in x out, row-major, last axis fastest
 * @param {Uint16Array|number[]} [lut.inputCurve]   entries x in, identity if omitted
 * @param {Uint16Array|number[]} [lut.outputCurve]  entries x out, identity if omitted
 * @param {number} [lut.inputEntries=2]    2 is the smallest legal identity ramp
 * @param {number} [lut.outputEntries=2]
 * @param {number[]} [lut.matrix]          9 values; identity when omitted
 * @returns {number[]} tag bytes
 */
function lut16Type(lut){
    var out = [];
    var i;

    var inCh  = lut.inputChannels;
    var outCh = lut.outputChannels;
    var grid  = lut.gridPoints;

    if(!(inCh >= 1 && inCh <= 15))  throw new Error('encodeICC.lut16Type: inputChannels must be 1-15, got ' + inCh);
    if(!(outCh >= 1 && outCh <= 15)) throw new Error('encodeICC.lut16Type: outputChannels must be 1-15, got ' + outCh);
    if(!(grid >= 2 && grid <= 255)) throw new Error('encodeICC.lut16Type: gridPoints must be 2-255, got ' + grid);

    var cells = Math.pow(grid, inCh) * outCh;
    if(cells !== lut.CLUT.length){
        throw new Error('encodeICC.lut16Type: CLUT is ' + lut.CLUT.length + ' cells, expected '
            + 'grid^inputChannels * outputChannels = ' + grid + '^' + inCh + ' * ' + outCh
            + ' = ' + cells);
    }

    var inEntries  = lut.inputEntries  || 2;
    var outEntries = lut.outputEntries || 2;

    chars(out, 'mft2', 4);
    zeros(out, 4);
    u8(out, inCh);
    u8(out, outCh);
    u8(out, grid);
    u8(out, 0);

    // Identity unless told otherwise. See the note above about zero.
    var m = lut.matrix || [1,0,0, 0,1,0, 0,0,1];
    for(i = 0; i < 9; i++) s15Fixed16(out, m[i]);

    u16(out, inEntries);
    u16(out, outEntries);

    // Input curves. An identity ramp of 2 entries is 0, 65535 per channel --
    // the smallest thing that says "do not change the input".
    if(lut.inputCurve){
        for(i = 0; i < lut.inputCurve.length; i++) u16(out, lut.inputCurve[i]);
    } else {
        for(var c = 0; c < inCh; c++){
            for(var e = 0; e < inEntries; e++){
                u16(out, Math.round(e / (inEntries - 1) * 65535));
            }
        }
    }

    for(i = 0; i < lut.CLUT.length; i++) u16(out, lut.CLUT[i]);

    if(lut.outputCurve){
        for(i = 0; i < lut.outputCurve.length; i++) u16(out, lut.outputCurve[i]);
    } else {
        for(var oc = 0; oc < outCh; oc++){
            for(var oe = 0; oe < outEntries; oe++){
                u16(out, Math.round(oe / (outEntries - 1) * 65535));
            }
        }
    }

    return out;
}

/**
 * Legacy 16-bit Lab encoding, as an mft2 CLUT carries it.
 *
 * NOT THE OBVIOUS SCALING, and this is the single easiest thing to get wrong
 * in a LUT profile because nothing crashes -- the colours are just quietly
 * off. ICC v2 encodes PCS Lab in a CLUT so that 0xFF00 is the top of the
 * range, NOT 0xFFFF:
 *
 *     L*  0..100     ->  0..0xFF00
 *     a*  -128..127  ->  0..0xFF00
 *
 * so 100 % L is 65280 and the remaining 255 codes are above-white headroom.
 * Using 65535 puts every value out by a factor of 1.0039, which reads as a
 * fraction of an LSB at 8 bits and is invisible until something compares
 * against another CMS.
 *
 * @returns {number[]} [L, a, b] as u16
 */
function labToU16v2(L, a, b){
    var TOP = 0xFF00;
    var enc = function(v){ return Math.max(0, Math.min(0xFFFF, Math.round(v * TOP))); };
    return [enc(L / 100), enc((a + 128) / 255), enc((b + 128) / 255)];
}

module.exports = {
    D50: D50,
    COLOUR_SPACE_SIG: COLOUR_SPACE_SIG,
    u8: u8, u16: u16, u32: u32,
    s15Fixed16: s15Fixed16, u8Fixed8: u8Fixed8,
    chars: chars, zeros: zeros, pad4: pad4,
    XYZType: XYZType, curveType: curveType, lut16Type: lut16Type,
    labToU16v2: labToU16v2,
    textDescriptionType: textDescriptionType, textType: textType,
    header: header, assemble: assemble,
};
