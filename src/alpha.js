/*************************************************************************
 *  @license
 *
 *  Copyright © 2019, 2026 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 */

/**
 * alpha.js — pixel-array helpers for the two things alpha needs done to it
 * BEFORE a colour transform.
 *
 * WHY THESE ARE HELPERS AND NOT A TRANSFORM OPTION. Nothing in a buffer says
 * whether it is premultiplied: straight and associated RGBA are the same bytes,
 * and only the caller knows which arrived. A `premultipliedAlpha: true` option
 * would therefore be a flag the Transform cannot verify, threaded through the
 * pipeline, the LUT path, the pool and the workers, to control what is really
 * one pass over an array. Keeping it out here leaves the Transform doing
 * colour conversion and nothing else, and leaves the decision with the only
 * party that can make it correctly.
 *
 * TWO DIFFERENT JOBS, OFTEN CONFUSED:
 *
 *   unpremultiply()  Associated -> straight. Recovers the colour so it can be
 *                    converted, and KEEPS the alpha channel. Pair it with
 *                    premultiply() afterwards to hand back what you were given.
 *
 *   flatten()        Composites against a background and DISCARDS alpha. This
 *                    is what you want when the destination has none — print,
 *                    JPEG — and it is not a fix for premultiplied data, it is
 *                    a different outcome.
 *
 * WHY IT MATTERS. The transform is not linear: there is a TRC at each end. So
 * `T(a·C)` is not `a·T(C)`, and converting premultiplied data directly is
 * measurably wrong — up to 69 LSB at a = 0.5 on *prophoto -> *sRGB, against a
 * kernel that is otherwise inside 1 LSB. See
 * docs/deepdive/MatrixShaperKernel.md.
 *
 * ENCODED SPACE, NOT LINEAR. Both operations work on the values as stored,
 * because that is how the data was authored: canvas and PNG premultiply and
 * composite in the encoded (gamma) domain. Doing it in linear light would be
 * more defensible in the abstract and would NOT round-trip the buffers people
 * actually have. If you want linear compositing, convert to a linear-gamma
 * space first and composite there.
 */
'use strict';

/** Max code for the container. Inferred, because the array already says it. */
function maxFor(data){
    if(data instanceof Uint16Array) return 65535;
    if(data instanceof Uint8ClampedArray || data instanceof Uint8Array) return 255;
    throw 'alpha: expected a Uint8ClampedArray, Uint8Array or Uint16Array, got ' +
          (data && data.constructor ? data.constructor.name : typeof data);
}

function sameKind(data, length){
    return (data instanceof Uint16Array) ? new Uint16Array(length)
         : (data instanceof Uint8Array)  ? new Uint8Array(length)
         : new Uint8ClampedArray(length);
}

function checkLength(data, pixelCount, channels, what){
    if(!(pixelCount >= 0)) throw 'alpha: pixelCount must be a number';
    if(data.length < pixelCount * channels){
        throw 'alpha.' + what + ': array holds ' + data.length + ' values, which is ' +
              'less than pixelCount ' + pixelCount + ' x ' + channels + ' channels';
    }
}

/**
 * Associated (premultiplied) RGBA -> straight RGBA. Alpha is unchanged.
 *
 *     C = P / a
 *
 * FULLY TRANSPARENT PIXELS KEEP A COLOUR OF ZERO. At a = 0 the original colour
 * is not recoverable — it was multiplied away — so there is nothing to divide
 * back out and no value is more correct than another. Zero is chosen because
 * it round-trips: premultiply() will put it back where it was.
 *
 * LOSSY AT LOW ALPHA, unavoidably. At a = 0.1 the stored colour carries about
 * three usable bits, so dividing by 0.1 magnifies each one into ten codes. That
 * is information the premultiply threw away, not something this introduces —
 * but it is why a pipeline that keeps straight alpha throughout beats one that
 * converts back and forth.
 *
 * @param {Uint8ClampedArray|Uint8Array|Uint16Array} data   RGBA, 4 channels
 * @param {number} pixelCount
 * @param {Uint8ClampedArray|Uint8Array|Uint16Array} [out]  written in place if given
 * @returns {Uint8ClampedArray|Uint8Array|Uint16Array} `out`, or a new array
 */
function unpremultiply(data, pixelCount, out){
    var max = maxFor(data);
    checkLength(data, pixelCount, 4, 'unpremultiply');
    if(!out) out = sameKind(data, pixelCount * 4);
    else checkLength(out, pixelCount, 4, 'unpremultiply (out)');

    for(var p = 0; p < pixelCount; p++){
        var i = p * 4;
        var a = data[i + 3];
        if(a === 0){
            out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
            continue;
        }
        if(a === max){
            out[i] = data[i]; out[i + 1] = data[i + 1]; out[i + 2] = data[i + 2];
            out[i + 3] = a;
            continue;
        }
        // Clamped, not just rounded: malformed data with P > a would otherwise
        // produce a value above the container's range.
        var s = max / a;
        var r = Math.round(data[i]     * s); out[i]     = r > max ? max : r;
        var g = Math.round(data[i + 1] * s); out[i + 1] = g > max ? max : g;
        var b = Math.round(data[i + 2] * s); out[i + 2] = b > max ? max : b;
        out[i + 3] = a;
    }
    return out;
}

/**
 * Straight RGBA -> associated (premultiplied) RGBA. Alpha is unchanged.
 *
 *     P = C * a
 *
 * The inverse of unpremultiply(), for handing a buffer back in the form it
 * arrived in. Round-trips exactly at a = 0 and a = max; in between it is
 * limited by the container, which is the nature of premultiplied storage.
 */
function premultiply(data, pixelCount, out){
    var max = maxFor(data);
    checkLength(data, pixelCount, 4, 'premultiply');
    if(!out) out = sameKind(data, pixelCount * 4);
    else checkLength(out, pixelCount, 4, 'premultiply (out)');

    for(var p = 0; p < pixelCount; p++){
        var i = p * 4;
        var a = data[i + 3];
        if(a === max){
            out[i] = data[i]; out[i + 1] = data[i + 1]; out[i + 2] = data[i + 2];
            out[i + 3] = a;
            continue;
        }
        var s = a / max;
        out[i]     = Math.round(data[i]     * s);
        out[i + 1] = Math.round(data[i + 1] * s);
        out[i + 2] = Math.round(data[i + 2] * s);
        out[i + 3] = a;
    }
    return out;
}

/**
 * Composite RGBA over a background and drop alpha.
 *
 *     straight:       out = a*C + (1-a)*BG
 *     premultiplied:  out = P   + (1-a)*BG
 *
 * FLATTEN BEFORE CONVERTING, NOT AFTER, and in the source space. Compositing
 * is space-dependent: the same two colours blended in sRGB and in AdobeRGB give
 * different results, so blending after the conversion answers a different
 * question. The background colour is therefore in SOURCE encoding.
 *
 * THE BACKGROUND IS REQUIRED. White and black are both plausible defaults and
 * they differ everywhere the image is not opaque, so guessing would silently
 * change every soft edge in the picture.
 *
 * @param {Uint8ClampedArray|Uint8Array|Uint16Array} data  RGBA, 4 channels
 * @param {number} pixelCount
 * @param {object} opts
 * @param {number[]} opts.background      [r, g, b] in SOURCE encoding, 0..max
 * @param {boolean} [opts.premultiplied]  true if `data` is associated
 * @param {number}  [opts.outputChannels=3]  3 drops alpha; 4 keeps it, opaque
 * @param {*} [opts.out]                  written in place if given
 * @returns {Uint8ClampedArray|Uint8Array|Uint16Array}
 */
function flatten(data, pixelCount, opts){
    opts = opts || {};
    var max = maxFor(data);
    checkLength(data, pixelCount, 4, 'flatten');

    var bg = opts.background;
    if(!bg || bg.length < 3){
        throw 'alpha.flatten: opts.background is required — [r, g, b] in the SOURCE ' +
              'encoding, 0..' + max + '. There is no safe default: white and black ' +
              'differ everywhere the image is not opaque.';
    }
    var outCh = opts.outputChannels === undefined ? 3 : opts.outputChannels;
    if(outCh !== 3 && outCh !== 4) throw 'alpha.flatten: outputChannels must be 3 or 4';

    var out = opts.out;
    if(!out) out = sameKind(data, pixelCount * outCh);
    else checkLength(out, pixelCount, outCh, 'flatten (out)');

    var pre = opts.premultiplied === true;
    var bg0 = bg[0], bg1 = bg[1], bg2 = bg[2];

    for(var p = 0; p < pixelCount; p++){
        var i = p * 4, o = p * outCh;
        var a = data[i + 3];
        if(a === max){
            out[o] = data[i]; out[o + 1] = data[i + 1]; out[o + 2] = data[i + 2];
        } else {
            var inv = (max - a) / max;
            if(pre){
                out[o]     = Math.round(data[i]     + bg0 * inv);
                out[o + 1] = Math.round(data[i + 1] + bg1 * inv);
                out[o + 2] = Math.round(data[i + 2] + bg2 * inv);
            } else {
                var f = a / max;
                out[o]     = Math.round(data[i]     * f + bg0 * inv);
                out[o + 1] = Math.round(data[i + 1] * f + bg1 * inv);
                out[o + 2] = Math.round(data[i + 2] * f + bg2 * inv);
            }
        }
        if(outCh === 4) out[o + 3] = max;
    }
    return out;
}

module.exports = {
    unpremultiply: unpremultiply,
    premultiply: premultiply,
    flatten: flatten
};
