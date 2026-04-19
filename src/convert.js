/*************************************************************************
 *  @license
 *
 *
 *  Copyright © 2019, 2024 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 * jsColorEngine is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with this program.
 * If not, see <https://www.gnu.org/licenses/>.
 *
 */

'use strict';

/**
 * ============================================================================
 *  convert.js — colour-math helper layer
 * ============================================================================
 *
 *  This module is the maths floor of jsColorEngine. It is a flat collection of
 *  pure (and a few side-effecting) functions that:
 *
 *    - Construct typed colour objects (`RGB()`, `Lab()`, `XYZ()`, `CMYK()`...)
 *    - Convert between colour spaces using closed-form maths (XYZ ↔ Lab ↔ LCH,
 *      RGB matrix profiles ↔ XYZ ↔ Lab, xyY ↔ XYZ).
 *    - Perform Bradford chromatic adaptation between whitepoints.
 *    - Compute, invert, transpose and multiply 3x3 RGB-profile matrices.
 *    - Apply / invert per-channel gamma (sRGB curve and pure-gamma).
 *    - Compute ΔE colour-difference (1976, 1994, 2000, CMC).
 *    - A handful of display/format helpers (RGB→hex, intent→string, etc.).
 *
 *  ----------------------------------------------------------------------------
 *  WHEN TO USE THIS FILE vs Transform.js
 *  ----------------------------------------------------------------------------
 *
 *   - convert.js  → ACCURACY PATH. Single colour, full precision, allocates
 *                   small objects. Ideal for swatches, ΔE, analysis, and as
 *                   the building blocks Transform.js calls when it isn't
 *                   walking a CLUT. NEVER call these in a per-pixel loop over
 *                   image data — use Transform's prebuilt-LUT image path.
 *
 *   - Transform.js → speed-and-correctness path: ICC pipeline, LUT baking,
 *                   per-pixel inner loops.
 *
 *  ----------------------------------------------------------------------------
 *  TYPED COLOUR OBJECT CONVENTION
 *  ----------------------------------------------------------------------------
 *
 *  Every colour value is a plain object tagged with `type` (an `eColourType`
 *  enum value) and uppercase channel keys:
 *
 *      RGB    { type, R, G, B }                   // 0–255 byte
 *      RGBf   { type, Rf, Gf, Bf }                // 0.0–1.0 float
 *      CMYK   { type, C, M, Y, K }                // 0–100 percent
 *      CMYKf  { type, Cf, Mf, Yf, Kf }            // 0.0–1.0 float
 *      Gray   { type, G }                         // 0–255 byte (see TODO D1)
 *      Duo    { type, a, b }                      // 0–100 percent
 *      Lab    { type, L, a, b, whitePoint }       // L 0–100, a/b ≈ ±128
 *      LabD50 { L, a, b }                         // un-tagged D50 helper
 *      LCH    { type, L, C, H, whitePoint }       // H 0–360
 *      XYZ    { type, X, Y, Z, whitePoint? }      // Y normalised to 1.0
 *      xyY    { type, x, y, Y }                   // chromaticity + luminance
 *
 *  Lab/LCH carry their reference whitepoint with them so a downstream
 *  conversion can adapt automatically. XYZ optionally carries one but the
 *  adaptation API takes whitepoints as explicit args.
 *
 *  ----------------------------------------------------------------------------
 *  WHITEPOINT CONVENTION  ⚠ enforced invariant
 *  ----------------------------------------------------------------------------
 *
 *  All whitepoints in this engine are XYZ values NORMALISED SO `Y === 1.0`.
 *  They are attached to `convert` as `convert.d50`, `convert.d65`,
 *  `convert.a`, etc. Look up by name with `getWhitePoint('d65')`
 *  (defaults to D50).
 *
 *  This invariant is leaned on as a perf optimisation throughout the file:
 *  a number of functions deliberately drop `wp.Y` multiplies/divides
 *  because the result is identical when Y === 1.0. Each such site has an
 *  inline `INTENTIONAL: Y === 1.0` comment — do NOT "fix" them by adding
 *  the `* wp.Y` term back. Sites:
 *
 *      - XYZ2Lab            yr = XYZ.Y         (instead of / wp.Y)
 *      - Lab2XYZ            Y: yr              (instead of yr * wp.Y)
 *      - Lab2RGBDevice      Y: yr              (same as Lab2XYZ)
 *      - RGBDevice2LabD50   yr = XYZ.Y         (same as XYZ2Lab)
 *      - RGBf2Lab           yr = XYZ.Y         (same as XYZ2Lab)
 *      - adaptation         drops `* sourceWhite.Y` and `* destWhite.Y`
 *                           in the cone-space projections (the input XYZ.Y
 *                           multiplies are KEPT — colour Y is not 1.0).
 *
 *  If you ever need to support un-normalised whitepoints, every site
 *  listed above has to be updated together — and the perf tradeoff
 *  reconsidered.
 *
 *  ----------------------------------------------------------------------------
 *  CIE Lab MATH CONSTANTS (used throughout)
 *  ----------------------------------------------------------------------------
 *
 *      kE  = 216 / 24389  ≈ 0.008856   (CIE epsilon, the "linear-segment knee")
 *      kK  = 24389 / 27   ≈ 903.296    (CIE kappa)
 *      kKE = 8                          (kE * kK, used as L threshold)
 *
 *  These are the modern (TC1-48 corrected) values. `Lab2sRGB` below uses the
 *  older `0.008856 / 7.787` constants for historical reasons — same maths to
 *  ~6 d.p., kept as an alternate D65 fast-path.
 *
 *  ----------------------------------------------------------------------------
 *  RGB MATRIX PROFILES
 *  ----------------------------------------------------------------------------
 *
 *  An RGB matrix profile (sRGB, AdobeRGB, etc.) is just a set of:
 *      - primary chromaticities (cRx,cRy / cGx,cGy / cBx,cBy)
 *      - a media whitepoint
 *      - a gamma curve (or the sRGB piecewise curve)
 *
 *  `computeMatrix(profile)` derives the RGB→XYZ and XYZ→RGB 3x3 matrices from
 *  the primaries + whitepoint and stuffs them onto `profile.RGBMatrix.matrixV4`
 *  / `.matrixInv`. After that, the per-pixel maths is:
 *
 *      linear  = gammaInv(rgb)         // display → linear
 *      XYZ     = matrixV4 · linear     // 3x3 multiply
 *      [adapt] = bradford(XYZ, src→dst whitepoint, if needed)
 *      Lab     = XYZ2Lab(adapted, dst whitepoint)
 *
 *  ----------------------------------------------------------------------------
 *  HISTORY / RESOLVED ISSUES
 *  ----------------------------------------------------------------------------
 *
 *      C1  Lab2RGB           — FIXED: copy-paste typo (RGBDevice[0] for all
 *                              channels) replaced with [0]/[1]/[2].
 *      C2  RGB2Lab           — FIXED: was double-adapting across whitepoints
 *                              because RGBf2XYZ already adapts internally.
 *      C3  Lab2RGBDevice     — RECLASSIFIED as intentional Y === 1.0 perf
 *      C4  RGBf2Lab            optimisation. See WHITEPOINT CONVENTION above.
 *      D2  Lab2sRGB          — RECLASSIFIED as by-design: it is a display-
 *                              only "show this Lab roughly on screen" helper,
 *                              not a colorimetric path. No adaptation, no
 *                              profile, hardcoded sRGB/D65. Doc updated.
 *
 *  REMAINING DOC NOTES (not bugs, just things to be aware of):
 *
 *      D1  Gray ctor         — JSDoc-vs-clamp range conflict; clamp wins
 *                              (0–255). Doc updated.
 *      D3  gamma/gammaInv    — naming reads back-to-front; mnemonic in JSDoc.
 *      D4  computeMatrix     — side-effecting initialiser; documented.
 *      D5  transpose         — mutates input in place; documented.
 *
 *  ----------------------------------------------------------------------------
 *  REFERENCES
 *  ----------------------------------------------------------------------------
 *
 *      Bruce Lindbloom — http://www.brucelindbloom.com/
 *      ICC.1:2010 (Profile spec)
 *      CIE 15:2004 (Colorimetry, 3rd ed.)
 *      CIE 142:2001 (CIEDE2000)
 *      Wyszecki & Stiles, Color Science (2nd ed.)
 */

var defs = require('./def');
var eIntent = defs.eIntent;
var eColourType = defs.eColourType;

// ============================================================================
//  TYPEDEFS — shapes of the colour objects passed around the engine
// ============================================================================

/**
 * @typedef {object} _cmsWhitePoint
 * @property {string} desc  Short label, e.g. 'd50', 'd65', 'a'.
 * @property {number} X     Normalised X (Y is always 1.0 in the bundled WPs).
 * @property {number} Y     Normalised Y (always 1.0 for bundled WPs).
 * @property {number} Z     Normalised Z.
 */


/**
 * @typedef {object} _cmsGrey
 * @property {number} type
 * @property {number} g
 */

/**
 * @typedef {object} _cmsDuo
 * @property {number} type
 * @property {number} a
 * @property {number} b
 */


/**
 * @typedef {object} _cmsCMYK
 * @property {number} type
 * @property {number} C
 * @property {number} M
 * @property {number} Y
 * @property {number} K
 */

/**
 * XYZ tristimulus, normalised so reference white Y == 1.0.
 *
 * `whitePoint` is optional and informational — most XYZ-consuming functions
 * take a separate explicit whitepoint argument. When set, downstream Lab
 * conversions can pick it up automatically.
 *
 * @typedef {object} _cmsXYZ
 * @property {number} type eColourType.XYZ
 * @property {number} X
 * @property {number} Y
 * @property {number} Z
 * @property {_cmsWhitePoint} [whitePoint]
 */

/**
 * @typedef {object} _cmsLab
 * @property {number} type eColourType
 * @property {number} L
 * @property {number} a
 * @property {number} b
 * @property {_cmsWhitePoint} whitePoint
 */

/**
 * @typedef {object} _cmsLabD50
 * @property {number} L
 * @property {number} a
 * @property {number} b
 */

/**
 * @typedef {object} _cmsLCH
 * @property {number} type eColourType
 * @property {number} L
 * @property {number} C
 * @property {number} H
 * @property {_cmsWhitePoint} whitePoint
 */

/**
 * @typedef {object} _cmsRGB
 * @property {number} type
 * @property {number} R
 * @property {number} G
 * @property {number} B
 */

/**
 * @typedef {object} _cmsRGBf
 * @property {number} type
 * @property {number} Rf
 * @property {number} Gf
 * @property {number} Bf
 */

// ============================================================================
//  INTERNAL UTILS
// ============================================================================

/**
 * Round `n` to `places` decimal places. Used by the display/format helpers and
 * by `Lab2RGB`. Not for hot paths.
 *
 * @param {number} n
 * @param {number} places
 * @returns {number}
 */
function roundN(n , places) {
    var p = Math.pow(10, places)
    return Math.round(n * p) / p;
}

var convert = {};

// ============================================================================
//  DISPLAY / FORMAT HELPERS
// ============================================================================

/**
 * Map an `eIntent` enum value to its short ICC name.
 *
 * @param {number} intent
 * @returns {string}  'Perceptual' | 'Relative' | 'Saturation' | 'Absolute' | 'Unknown'
 */
convert.intent2String = function(intent){
    switch(intent){
        case eIntent.perceptual: return 'Perceptual';
        case eIntent.relative: return 'Relative';
        case eIntent.saturation: return 'Saturation';
        case eIntent.absolute: return 'Absolute';
    }
    return 'Unknown'
};

// ============================================================================
//  CHROMATIC ADAPTATION — Bradford matrices
// ============================================================================
//
//  Forward and inverse Bradford cone-response matrices used by
//  `convert.adaptation()`.
//
//  PUBLIC API:
//
//      convert.getBradfordMtxAdapt()      // recommended — returns frozen ref
//      convert.getBradfordMtxAdaptInv()
//
//      convert.BradfordMtxAdapt           // legacy direct-property access
//      convert.BradfordMtxAdaptInv        //   (also frozen)
//
//  Both are protected with `Object.freeze` so external code cannot mutate
//  them. The getter functions are preferred for new code (cleaner intent,
//  avoids accidental rebinds) and are written as plain functions — NOT
//  defineProperty getters — so the API stays compatible with old JS engines
//  that don't support ES5 accessors.
//
//      Reference: Lindbloom — http://www.brucelindbloom.com/Eqn_ChromAdapt.html
//
// ============================================================================

/**
 * Bradford cone-response matrix (XYZ → LMS). Frozen singleton — do not
 * attempt to mutate (assignment is silently ignored in non-strict mode and
 * throws in strict mode).
 * @type {{m00:number,m01:number,m02:number,m10:number,m11:number,m12:number,m20:number,m21:number,m22:number}}
 */
convert.BradfordMtxAdapt = Object.freeze({
    m00 :  0.8951,
    m01 : -0.7502,
    m02 :  0.0389,
    m10 :  0.2664,
    m11 :  1.7135,
    m12 : -0.0685,
    m20 : -0.1614,
    m21 :  0.0367,
    m22 :  1.0296
});

/**
 * Inverse Bradford matrix (LMS → XYZ). Frozen singleton — see notes on
 * `BradfordMtxAdapt`.
 * @type {{m00:number,m01:number,m02:number,m10:number,m11:number,m12:number,m20:number,m21:number,m22:number}}
 */
convert.BradfordMtxAdaptInv = Object.freeze({
    m00 :  0.9869929,
    m01 :  0.4323053,
    m02 : -0.0085287,
    m10 : -0.1470543,
    m11 :  0.5183603,
    m12 :  0.0400428,
    m20 :  0.1599627,
    m21 :  0.0492912,
    m22 :  0.9684867
});

/**
 * Get the Bradford cone-response matrix (XYZ → LMS). Returns the frozen
 * singleton — safe to read, mutation is rejected.
 *
 * If you need a mutable copy (e.g. for matrix-composition experiments), do:
 *
 *      var m = Object.assign({}, convert.getBradfordMtxAdapt());
 *
 * @returns {{m00:number,m01:number,m02:number,m10:number,m11:number,m12:number,m20:number,m21:number,m22:number}}
 */
convert.getBradfordMtxAdapt = function(){
    return convert.BradfordMtxAdapt;
};

/**
 * Get the inverse Bradford matrix (LMS → XYZ). Returns the frozen
 * singleton — safe to read, mutation is rejected. See `getBradfordMtxAdapt`
 * for how to obtain a mutable copy.
 *
 * @returns {{m00:number,m01:number,m02:number,m10:number,m11:number,m12:number,m20:number,m21:number,m22:number}}
 */
convert.getBradfordMtxAdaptInv = function(){
    return convert.BradfordMtxAdaptInv;
};


/**
 * Format a typed colour object as a human-readable string for logs / UI.
 *
 *      cmsColor2String(convert.RGB(255,0,0))
 *      // -> 'RGB: 255, 0, 0'
 *      cmsColor2String(convert.Lab(50,20,-30), 2)
 *      // -> 'Lab: 50, 20, -30 (d50)'
 *
 * @param {object} color           Any typed colour object (must have `.type`).
 * @param {number} [precision=4]   Decimal places to round each channel to.
 * @returns {string}
 */
convert.cmsColor2String = function(color, precision){

    if(typeof precision === 'undefined'){
        precision = 4;
    }

    switch (color.type){
        case eColourType.CMYK:  return col2Str('CMYK', color, ['C','M','Y','K']);
        case eColourType.CMYKf: return col2Str('CMYKf', color, ['Cf','Mf','Yf','Kf']);

        case eColourType.RGB:   return col2Str('RGB', color, ['R','G','B']);
        case eColourType.RGBf:  return col2Str('RGBf', color, ['Rf','Gf','Bf']);

        case eColourType.Gray:  return col2Str('Gray', color, ['G']);

        case eColourType.Lab:   return col2Str('Lab', color, ['L','a','b']) + (color.whitePoint ? ' (' + color.whitePoint.desc + ')' : '');
        case eColourType.LCH:   return col2Str('LCH', color, ['L','C','H']) + (color.whitePoint ? ' (' + color.whitePoint.desc + ')' : '');
        case eColourType.XYZ:   return col2Str('XYZ', color, ['X','Y','Z']);
        default:
            return color.toString();
    }

    function col2Str(title, obj, props, includeProp){
        var cols = [];
        for(var i=0; i<props.length; i++){
            if(includeProp){
                cols.push(props[i] + ': ' + roundN(obj[props[i]], precision));
            } else {
                cols.push( roundN(obj[props[i]], precision));
            }
        }
        return title + ': ' + cols.join(', ');
    }
};


/**
 * Format a whitepoint as `'(White d50 X0.9642 Y1.0000 Z0.8252)'`.
 * @param  {_cmsWhitePoint} whitePoint
 * @returns {string}
 */
convert.whitepoint2String = function(whitePoint){
    return '(White ' + whitePoint.desc + ' X' + whitePoint.X.toFixed(4) + ' Y' + whitePoint.Y.toFixed(4) + ' Z' + whitePoint.Z.toFixed(4) + ')';
};


// ============================================================================
//  TYPED COLOUR CONSTRUCTORS
// ============================================================================
//
//  Most constructors accept an optional `rangeCheck` flag. When it is the
//  literal `false` the inputs are stored as-is (useful when feeding values
//  that are already known good, or when out-of-gamut/negative values are
//  intentional). Otherwise the constructor clamps and rounds.
//
//  Whitepoint defaulting: Lab/LCH default to D50 (the ICC PCS whitepoint).
//
// ============================================================================

/**
 * Build an XYZ colour. Components are normally in 0.0–1.0 (Y normalised so
 * the reference white is 1.0).
 * @param {number} X
 * @param {number} Y
 * @param {number} Z
 * @param {_cmsWhitePoint=} whitePoint  Defaults to D50.
 * @returns {_cmsXYZ}
 */
convert.XYZ = function(X, Y, Z, whitePoint){
    return {
        type: eColourType.XYZ,
        X:X,
        Y:Y,
        Z:Z,
        whitePoint: whitePoint || this.d50
    };
};

/**
 * Build a Lab colour at the given whitepoint. By default L is clamped to
 * 0–100 and a/b are clamped to ±127 (Lab16 ICC convention). Pass
 * `rangeCheck === false` to skip clamping (e.g. for delta-E maths where
 * negative or >100 L can occur intermediately).
 *
 * @param {number} L  0.0 - 100.0 (clamped unless rangeCheck === false)
 * @param {number} a  ±127 (clamped unless rangeCheck === false)
 * @param {number} b  ±127 (clamped unless rangeCheck === false)
 * @param {_cmsWhitePoint=} whitePoint Defaults to D50.
 * @param {boolean=} rangeCheck  Pass `false` to disable clamping.
 * @returns {_cmsLab}
 */
convert.Lab = function(L, a, b, whitePoint, rangeCheck){

    if(rangeCheck === false){
        return {
            type: eColourType.Lab,
            L: L,
            a: a,
            b: b,
            whitePoint: whitePoint || this.d50
        };
    }

    return {
        type: eColourType.Lab,
        L: (L > 100.0 ? 100.0 : L < 0.0 ? 0.0 : L),
        a: (a > 127.0 ? 127.0 : a < -128.0 ? -128.0 : a),
        b: (b > 127.0 ? 127.0 : b < -128.0 ? -128.0 : b),
        whitePoint: whitePoint || this.d50
    };
};
/**
 * Build an LCH (cylindrical Lab) colour. L 0–100, C clamped ≥ 0, H wrapped
 * into 0–360. Note: the negative-H wrap uses `(h + 3600) % 360` so very
 * large negative inputs (h < -3600) won't wrap correctly — fine for normal
 * use, but worth knowing.
 *
 * @param {number} L  0.0 - 100.0
 * @param {number} c  Chroma, clamped to ≥ 0.
 * @param {number} h  Hue in degrees, wrapped into 0–360.
 * @param {_cmsWhitePoint=} whitePoint Defaults to D50.
 * @returns {_cmsLCH}
 */
convert.Lch = function(L, c, h, whitePoint){
    return {
        type: eColourType.LCH,
        L: (L > 100.0 ? 100.0 : L < 0.0 ? 0.0 : L),
        C: (c < 0.0 ? 0.0 : c),
        H: (h > 360.0 ? h % 360.0 : h < 0.0 ? (h + 3600) % 360 : h),
        whitePoint: whitePoint || this.d50
    }
};

convert.LCH = convert.Lch;

/**
 * Build a Gray colour. Stored as 0–255 byte (despite the legacy JSDoc range).
 *
 * TODO (doc bug D1): JSDoc historically said 0–100 but the clamp is 0–255.
 * The 0–255 clamp matches the rest of the engine's grey handling, so the
 * range tag here is what's wrong. Fix when next touching the file.
 *
 * @param {number} g 0–255
 * @param {boolean=} rangeCheck Pass `false` to disable clamping/rounding.
 * @returns {_cmsGrey}
 */
convert.Gray = function(g, rangeCheck){
    if(rangeCheck === false){
        return {
            type: eColourType.Gray,
            G: g,
        }
    }
    return {
        type: eColourType.Gray,
        G:(g > 255 ? 255 : g < 0 ? 0 : Math.round(g)),
    };
};


/**
 * Build a Duotone (2-channel) colour. Each channel is an ink percent 0–100.
 * @param {number} a 0–100
 * @param {number} b 0–100
 * @param {boolean=} rangeCheck Pass `false` to disable clamping/rounding.
 * @returns {_cmsDuo}
 */
convert.Duo = function(a, b, rangeCheck){
    if(rangeCheck === false){
        return {
            type: eColourType.Duo,
            a: a,
            b: b,
        }
    }
    return {
        type: eColourType.Duo,
        a:(a > 100 ? 100 : a < 0 ? 0 : Math.round(a)),
        b:(b > 100 ? 100 : b < 0 ? 0 : Math.round(b))
    };
};



/**
 * Convert an `_cmsRGB` byte triple to a `#rrggbb` string.
 *
 * Implementation note: the `(1 << 24) + ... | 0` trick is the well-known
 * leading-zero pad hack — the leading `1` becomes a 7th hex digit which is
 * stripped by `slice(1)`, guaranteeing exactly 6 chars.
 *
 * @param {_cmsRGB} rgb
 * @returns {string}  e.g. '#ff0000'
 */
convert.RGB2Hex = function(rgb) {
    return "#" + ((1 << 24) + (rgb.R << 16) + (rgb.G << 8) + rgb.B | 0).toString(16).slice(1);
};

/**
 * Build an RGB byte colour. Components clamped to 0–255 and rounded unless
 * `rangeCheck === false`.
 *
 * @param {number} r 0–255
 * @param {number} g 0–255
 * @param {number} b 0–255
 * @param {boolean=} rangeCheck Pass `false` to disable clamping/rounding.
 * @returns {_cmsRGB}
 */
convert.RGB = function(r, g, b, rangeCheck){
    if(rangeCheck === false){
        return {
            type: eColourType.RGB,
            R: r,
            G: g,
            B: b
        }
    }
    return {
        type: eColourType.RGB,
        R:(r > 255 ? 255 : r < 0 ? 0 : Math.round(r)),
        G:(g > 255 ? 255 : g < 0 ? 0 : Math.round(g)),
        B:(b > 255 ? 255 : b < 0 ? 0 : Math.round(b))
    };
};


/**
 * Build an RGB float colour (no clamping). Alias of `RGBFloat`.
 * @param {number} r 0.0 - 1.0 (typically; out-of-gamut is allowed)
 * @param {number} g 0.0 - 1.0
 * @param {number} b 0.0 - 1.0
 * @returns {_cmsRGBf}
 */
convert.RGBf = function(r, g, b){
    return {
        type: eColourType.RGBf,
        Rf: r,
        Gf: g,
        Bf: b
    }
};

/**
 * Build an RGB float colour. Normal range is 0.0–1.0 but values may fall
 * outside that range to represent out-of-gamut colours (handled by clipping
 * downstream when needed).
 * @param {number} rf
 * @param {number} gf
 * @param {number} bf
 * @returns {_cmsRGBf}
 */
convert.RGBFloat = function(rf, gf, bf){
    return {
        type: eColourType.RGBf,
        Rf:rf,
        Gf:gf,
        Bf:bf
    };
};
/**
 * RGB 0-255 -> Float 0.0-1.0
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {_cmsRGBf}
 */
convert.RGBbyte2Float = function(r, g, b){
    return {
        type: eColourType.RGBf,
        Rf:r / 255,
        Gf:g / 255,
        Bf:b / 255
    };
};
/**
 *
 * @param {number} c 0-100
 * @param {number} m 0-100
 * @param {number} y 0-100
 * @param {number} k 0-100
 * @param {boolean=} rangeCheck
 * @returns {_cmsCMYK}
 */
convert.CMYK = function(c, m, y, k, rangeCheck){
    if(rangeCheck === false){
        return  {
            type: eColourType.CMYK,
            C: c,
            M: m,
            Y: y,
            K: k
        };
    }
    return  {
        type: eColourType.CMYK,
        C: (c > 100 ? 100 : c<0 ? 0 : Math.round(c)),
        M: (m > 100 ? 100 : m<0 ? 0 : Math.round(m)),
        Y: (y > 100 ? 100 : y<0 ? 0 : Math.round(y)),
        K: (k > 100 ? 100 : k<0 ? 0 : Math.round(k))
    };
};

/**
 * Build a CMYK float colour (0.0–1.0 per channel). No clamping.
 * @param {number} c
 * @param {number} m
 * @param {number} y
 * @param {number} k
 * @returns {_cmsCMYK}
 */
convert.CMYKf = function(c, m, y, k){
    return  {
        type: eColourType.CMYKf,
        Cf: c,
        Mf: m,
        Yf: y,
        Kf: k
    }
};

/**
 * Build an xyY chromaticity+luminance colour.
 * @param {number} x  Chromaticity x (0–1).
 * @param {number} y  Chromaticity y (0–1).
 * @param {number} Y  Luminance (matches the XYZ Y normalisation).
 * @returns {{type: number, x: number, y: number, Y: number}}
 */
convert.xyY = function(x, y, Y){
    return {
        type: eColourType.xyY,
        x:x,
        y:y,
        Y:Y
    };
};

// ============================================================================
//  WHITEPOINTS — bundled CIE standard illuminants
// ============================================================================
//
//  All values are XYZ tristimuli normalised so Y = 1.0 (ASTM E308-01, except
//  where noted). They are stored on `convert` itself as `convert.d50`,
//  `convert.d65`, etc. Look them up by name with `getWhitePoint('d65')`.
//
//  D50 is the ICC PCS reference and is the default for Lab/LCH constructors.
//
// ============================================================================

/**
 * Look up a bundled whitepoint by short name (case-insensitive).
 * Falls through to D65 if the name is not recognised.
 *
 *      getWhitePoint('d65')   // -> convert.d65
 *      getWhitePoint('D50')   // -> convert.d50
 *      getWhitePoint('foo')   // -> convert.d65 (fallback)
 *
 * @param {string} whitepointDescription
 *        One of: 'a','b','c','d50','d55','d65','d75','e','f2','f7','f11'.
 * @returns {_cmsWhitePoint}
 */
convert.getWhitePoint = function(whitepointDescription){
    switch(whitepointDescription.toLowerCase()){
        case 'a':  //A (ASTM E308-01)
            return this.a;
        case 'b':  // B (Wyszecki & Stiles, p. 769))
            return this.b;
        case 'c':	// C (ASTM E308-01)
            return this.c;
        case 'd50': // D50 (ASTM E308-01)
            return this.d50;
        case 'd55': // D55 (ASTM E308-01)
            return this.d55;
        case 'd75': //D75 (ASTM E308-01)
            return this.d75;
        case 'e':  // E (ASTM E308-01)
            return this.e;
        case 'f2': // F2 (ASTM E308-01)
            return this.f2;
        case 'f7': 	// F7 (ASTM E308-01)
            return this.f7;
        case 'f11': // F11 (ASTM E308-01)
            return this.f11;
        default: // D65 (ASTM E308-01)
            return this.d65;
    }
};


convert.a =   {desc:'a',    Y: 1.0, X: 1.09850, Z: 0.35585};
convert.b =   {desc: 'b',   Y: 1.0, X: 0.99072, Z: 0.85223};
convert.c =   {desc: 'c',   Y: 1.0, X: 0.98074, Z: 1.18232};
convert.d50 = {desc: 'd50', Y: 1.0, X: 0.96422, Z: 0.82521};
convert.d55 = {desc: 'd55', Y: 1.0, X: 0.95682, Z: 0.92149};
convert.d65 = {desc: 'd65', Y: 1.0, X: 0.95047, Z: 1.08883};
convert.d75 = {desc: 'd75', Y: 1.0, X: 0.94972, Z: 1.22638};
convert.e =   {desc: 'e',   Y: 1.0, X: 1.00000, Z: 1.00000};
convert.f2 =  {desc: 'f2',  Y: 1.0, X: 0.99186, Z: 0.67393};
convert.f7 =  {desc: 'f7',  Y: 1.0, X: 0.95041, Z: 1.08747};
convert.f11 = {desc: 'f11', Y: 1.0, X: 1.00962, Z: 0.64350};


/**
 * Reverse lookup: given an XYZ illuminant (typically the output of a
 * spectral integration) return the matching named whitepoint, or a
 * synthesised one if no bundled illuminant matches within ±0.001.
 *
 * @param {{X:number, Y:number, Z:number}} illuminant
 * @returns {_cmsWhitePoint}
 */
convert.getWhitePointFromIlluminant = function(illuminant){
    if(t(illuminant.X, 1.0985)){  //A (ASTM E308-01)
        return this.a;
    }
    if(t(illuminant.X, 0.9907)){  // B (Wyszecki & Stiles, p. 769))
        return this.b;
    }
    if(t(illuminant.X, 0.98074)){	// C (ASTM E308-01)
        return this.c;
    }
    if(t(illuminant.X, 0.96422)) { // D50 (ASTM E308-01)
        return this.d50;
    }
    if(t(illuminant.X, 0.95682)) { // D55 (ASTM E308-01)
        return this.d55;
    }
    if(t(illuminant.X, 0.94972)) { //D75 (ASTM E308-01)
        return this.d75
    }
    if(t(illuminant.X, 1.00000)) {  // E (ASTM E308-01)
        return this.e;
    }
    if(t(illuminant.X, 0.99186)) { // F2 (ASTM E308-01)
        return this.f2;
    }
    if(t(illuminant.X, 0.95041)) { 	// F7 (ASTM E308-01)
        return this.f7;
    }
    if(t(illuminant.X, 1.00962)) { // F11 (ASTM E308-01)
        return this.f11;
    }

    return {desc:'', Y: illuminant.Y , X: illuminant.X, Z: illuminant.Z};

    function t(x,n){
        var tolerance = 0.001;
        return (x > (n-tolerance) && x < (n+tolerance));
    }
};

// ============================================================================
//  COLOUR-SPACE CONVERSIONS
//      XYZ ↔ xyY ↔ Lab ↔ LCH (closed-form, no profile data needed)
// ============================================================================

/**
 * XYZ → xyY chromaticity. If the XYZ sum is zero (pure black) the
 * chromaticity is taken from `whitePoint` so the output isn't NaN.
 *
 * @param {_cmsXYZ} cmsXYZ
 * @param {_cmsWhitePoint} whitePoint  Used only for the black-fallback chromaticity.
 * @returns {{x: number, y: number, Y: number}}
 */
convert.XYZ2xyY = function(cmsXYZ, whitePoint)
{
    /** @type {number} den */
    var den = cmsXYZ.X + cmsXYZ.Y + cmsXYZ.Z;
    var xyY ={x:0,y:0,Y:0};
    if (den > 0.0)
    {
        xyY.x = cmsXYZ.X / den;// TODO: Need to handle divide by zero
        xyY.y = cmsXYZ.Y / den;
    }
    else
    {
        xyY.x = whitePoint.X / (whitePoint.X + 1 + whitePoint.Z);
        xyY.y = 1 / (whitePoint.X + 1 + whitePoint.Z);
    }
    xyY.Y = cmsXYZ.Y;
    return this.xyY(xyY.x,xyY.y,xyY.Y);
};

/**
 * xyY → XYZ. Returns black if y is effectively zero (avoids divide-by-zero).
 *
 * @param {{x: number, y: number, Y: number}} cmsxyY
 * @returns {_cmsXYZ}
 */
convert.xyY2XYZ = function(cmsxyY)
{
    var X, Y, Z ;
    if (cmsxyY.y < 0.000001)
    {
        X = Y = Z = 0.0;
    }
    else
    {
        X = (cmsxyY.x * cmsxyY.Y) / cmsxyY.y;
        Y = cmsxyY.Y;
        Z = ((1.0 - cmsxyY.x - cmsxyY.y) * cmsxyY.Y) / cmsxyY.y;
    }

    return this.XYZ(X,Y,Z);
};

/**
 * XYZ → CIE Lab at the given whitepoint (CIE 15:2004).
 *
 * Uses the modern (TC1-48 corrected) constants: kE = 216/24389,
 * kK = 24389/27. The whitepoint argument is REQUIRED — no D50 fallback —
 * and the same whitepoint is attached to the result so any subsequent Lab→
 * conversion can pick it up.
 *
 * @param {_cmsXYZ} XYZ
 * @param {_cmsWhitePoint} whitePoint  Reference white. NOT optional.
 * @returns {_cmsLab}
 */
convert.XYZ2Lab = function(XYZ, whitePoint)
{
    var kE = 216.0 / 24389.0;
    var kK = 24389.0 / 27.0;
    //var kKE = 8.0;

    var xr = XYZ.X / whitePoint.X;
    // yr: by convention, every whitepoint in this engine has Y === 1.0,
    // so `XYZ.Y / whitePoint.Y` reduces to `XYZ.Y`. Don't "fix" this back.
    var yr = XYZ.Y;
    var zr = XYZ.Z / whitePoint.Z;

    var fx = (xr > kE) ? Math.pow(xr, 1.0 / 3.0) : ((kK * xr + 16.0) / 116.0);
    var fy = (yr > kE) ? Math.pow(yr, 1.0 / 3.0) : ((kK * yr + 16.0) / 116.0);
    var fz = (zr > kE) ? Math.pow(zr, 1.0 / 3.0) : ((kK * zr + 16.0) / 116.0);

    return {
        L: 116.0 * fy - 16.0,
        a: 500.0 * (fx - fy),
        b: 200.0 * (fy - fz),
        whitePoint: whitePoint,
        type: eColourType.Lab
    };
};

/**
 * CIE Lab → XYZ. Uses `cmsLab.whitePoint` as the reference white (defaults
 * to D50 if missing). Inverse of `XYZ2Lab`.
 *
 * @param {_cmsLab | _cmsLabD50} cmsLab
 * @returns {_cmsXYZ}
 */
convert.Lab2XYZ = function(cmsLab)
{
    var kE = 216.0 / 24389.0;
    var kK = 24389.0 / 27.0;
    var kKE = 8.0;

    var fy = (cmsLab.L + 16.0) / 116.0;
    var fx = 0.002 * cmsLab.a + fy;
    var fz = fy - 0.005 * cmsLab.b;

    var fx3 = fx * fx * fx;
    var fz3 = fz * fz * fz;

    var xr = (fx3 > kE) ? fx3 : ((116.0 * fx - 16.0) / kK);
    var yr = (cmsLab.L > kKE) ? Math.pow((cmsLab.L + 16.0) / 116.0, 3.0) : (cmsLab.L / kK);
    var zr = (fz3 > kE) ? fz3 : ((116.0 * fz - 16.0) / kK);

    var whitePoint = cmsLab.whitePoint || this.d50;

    return {
        X: xr * whitePoint.X,
        // Y: every whitepoint in this engine has Y === 1.0 by convention,
        // so `yr * whitePoint.Y` reduces to `yr`. Don't "fix" this back.
        Y: yr,
        Z: zr * whitePoint.Z,
        type: eColourType.XYZ
    };
};

/**
 * Adapt a Lab value into D50 Lab (the ICC PCS reference). Returns a stripped
 * `{L,a,b}` (no whitepoint, no type) since the result is by definition D50.
 *
 * If the source is already at D50 (within tolerance) this is a near-no-op
 * field copy — no XYZ round-trip.
 *
 * @param {_cmsLab} sourceLab
 * @returns {_cmsLabD50}
 */
convert.Lab2LabD50 = function(sourceLab){
    var destWhitepoint = this.d50

    if( !this.compareWhitePoints(destWhitepoint, sourceLab.whitePoint)){
        var XYZ = convert.Lab2XYZ(sourceLab);
        XYZ = convert.adaptation(XYZ, sourceLab.whitePoint, destWhitepoint);
        sourceLab = convert.XYZ2Lab(XYZ, destWhitepoint );
    }
    return {
        L: sourceLab.L,
        a: sourceLab.a,
        b: sourceLab.b
    }
};


/**
 * Adapt a Lab value to a different reference whitepoint. Round-trips
 * through XYZ + Bradford adaptation. Returns the same object if the
 * whitepoints already match.
 *
 * @param {_cmsLab} sourceLab
 * @param {_cmsWhitePoint} destWhitepoint
 * @returns {_cmsLab}
 */
convert.Lab2Lab = function(sourceLab, destWhitepoint){
    if(sourceLab.whitePoint.X !== destWhitepoint.X || sourceLab.whitePoint.Z !== destWhitepoint.Z ){
        var XYZ = convert.Lab2XYZ(sourceLab);
        XYZ = convert.adaptation(XYZ, sourceLab.whitePoint, destWhitepoint);
        return convert.XYZ2Lab(XYZ, destWhitepoint );
    }
    return sourceLab
};



/**
 * Lab → cylindrical LCH. C = sqrt(a² + b²), H = atan2(b, a) in 0–360°.
 * Whitepoint is NOT carried into the LCH (could be — known limitation,
 * not in scope here).
 *
 * @param {_cmsLab} cmsLab
 * @returns {_cmsLCH}
 */
convert.Lab2LCH = function(cmsLab)
{
    var C = Math.sqrt(cmsLab.a * cmsLab.a + cmsLab.b * cmsLab.b);
    var H = 180.0 * Math.atan2(cmsLab.b, cmsLab.a) / Math.PI;
    if (H < 0.0)
    {
        H += 360.0;
    }
    return this.Lch(cmsLab.L,C,H);
};

/**
 * Cylindrical LCH → Lab. Inverse of `Lab2LCH`.
 * @param {_cmsLCH} cmsLCHab
 * @returns {_cmsLab}
 */
convert.LCH2Lab = function(cmsLCHab)
{
    var a = cmsLCHab.C * Math.cos(cmsLCHab.H * Math.PI / 180.0);
    var b = cmsLCHab.C * Math.sin(cmsLCHab.H * Math.PI / 180.0);
    return this.Lab(cmsLCHab.L,a,b);
};

// ============================================================================
//  RGB MATRIX-PROFILE CONVERSIONS
//      RGB ↔ XYZ ↔ Lab via per-profile gamma + 3x3 matrix + Bradford adapt.
// ============================================================================
//
//  These functions need an `RGBProfile` whose `RGBMatrix` field has been
//  populated by `computeMatrix()`. They are the bridge between the typeless
//  matrix-profile world and the Lab/XYZ analytical world.
//
//  Use them for single-colour work. For image data, build a Transform with
//  `buildLut: true` and use `transformArrayViaLUT()`.
//
// ============================================================================

/**
 * RGB byte triple → Lab at a destination whitepoint.
 *
 * If `destWhitepoint` is omitted, the RGB profile's media whitepoint is
 * used (no adaptation needed). When supplied, chromatic adaptation from
 * the profile's mediaWhitePoint to `destWhitepoint` is performed inside
 * `RGBf2XYZ` — do NOT re-adapt here.
 *
 * @param {_cmsRGB} rgb
 * @param {RGBProfile} RGBProfile
 * @param {_cmsWhitePoint=} destWhitepoint  Defaults to profile's mediaWhitePoint.
 * @returns {_cmsLab}
 */
convert.RGB2Lab = function(rgb, RGBProfile , destWhitepoint){
    if(!destWhitepoint){
        // assume whitePoint of the profile
        destWhitepoint = RGBProfile.mediaWhitePoint;
    }
    // RGBf2XYZ adapts the XYZ from RGBProfile.mediaWhitePoint → destWhitepoint
    // internally if the two differ; no second adaptation pass needed here.
    var cmsXYZ = this.RGBf2XYZ({Rf:rgb.R/255, Gf:rgb.G/255, Bf:rgb.B/255}, RGBProfile , destWhitepoint);
    return this.XYZ2Lab(cmsXYZ, destWhitepoint);
};

/**
 * RGB byte triple (0–255) → XYZ at the given reference white. Thin wrapper
 * over `RGBf2XYZ` that just normalises bytes to floats first.
 *
 * @param {_cmsRGB} rgb
 * @param {RGBProfile} RGBprofile
 * @param {_cmsWhitePoint} XYZRefWhite  Reference white the result should sit at.
 * @returns {_cmsXYZ}
 */
convert.RGB2XYZ_bytes = function(rgb, RGBprofile , XYZRefWhite){
    return this.RGBf2XYZ({
        Rf:rgb.R/255,
        Gf:rgb.G/255,
        Bf:rgb.B/255,
        type: eColourType.RGBf
    }, RGBprofile , XYZRefWhite);
};

/**
 * XYZ → RGB byte triple (0–255). Thin wrapper that calls `XYZ2RGBf` then
 * scales/clamps to bytes. Always clips to 0..1 before scaling.
 *
 * @param {_cmsXYZ} XYZ
 * @param {_cmsWhitePoint} XYZRefWhite  Reference white the input XYZ is at.
 * @param {RGBProfile} RGBProfile
 * @returns {_cmsRGB}
 */
convert.XYZ2RGB_bytes = function(XYZ, XYZRefWhite, RGBProfile){
    return convert.RGB2byte( convert.XYZ2RGBf(XYZ, XYZRefWhite, RGBProfile, true) );
};



// /**
//  *
//  * @param {_cmsLab} cmsLab
//  * @param {_cmsWhitePoint} LabRefWhite
//  * @param {Profile} RGBProfile
//  * @returns {_cmsRGB}
//  */
// convert.Lab2RGB_bytes2 = function(cmsLab, LabRefWhite, RGBProfile){
//     var XYZ = this.Lab2XYZ(cmsLab);
//     return this.XYZ2RGB_bytes(XYZ, LabRefWhite, RGBProfile);
// };

/**
 * Lab → RGB float via XYZ. The Lab's whitepoint is used as the XYZ reference
 * white for adaptation into the RGB profile's media whitepoint.
 *
 * @param {_cmsLab} cmsLab
 * @param {RGBProfile} RGBProfile
 * @param {boolean=} clip  Pass `false` to keep out-of-gamut values; default clips to 0..1.
 * @returns {_cmsRGBf}
 */
convert.Lab2RGBf = function(cmsLab, RGBProfile, clip){
    var XYZ = this.Lab2XYZ(cmsLab);
    return this.XYZ2RGBf(XYZ, cmsLab.whitePoint, RGBProfile, clip);
};

/**
 * RGB float (0..1) → RGB byte triple (0..255). Goes through `convert.RGB()`
 * so values are clamped and rounded.
 *
 * @param  {_cmsRGBf} rgbf
 * @returns {_cmsRGB}
 */
convert.RGB2byte = function(rgbf){
    return this.RGB( rgbf.Rf * 255, rgbf.Gf * 255, rgbf.Bf * 255);
};

/**
 * Alternative RGB→hex string formatter. Returns lowercase `#rrggbb`.
 * Functionally equivalent to `RGB2Hex` but uses a per-channel padding
 * approach instead of the bitwise hack.
 *
 * @param {_cmsRGB} rgb
 * @returns {string}  e.g. '#0a1b2c'
 */
convert.cmsRGB2Hex = function(rgb){
    var R =(rgb.R<=15 ? '0' + rgb.R.toString(16) : rgb.R.toString(16));
    var G =(rgb.G<=15 ? '0' + rgb.G.toString(16) : rgb.G.toString(16));
    var B =(rgb.B<=15 ? '0' + rgb.B.toString(16) : rgb.B.toString(16));
    return '#' + R + G + B;
};

/**
 * Bradford chromatic adaptation between two whitepoints.
 *
 * Transforms the input XYZ from `sourceWhite` to `destWhite` using the
 * Bradford cone-response matrix. Algorithm (Lindbloom):
 *
 *   1. Take both whitepoints into Bradford LMS cone space.
 *   2. Take the input XYZ into the same cone space.
 *   3. Scale each cone channel by destWhitePointLMS / sourceWhitePointLMS.
 *   4. Take the result back to XYZ via the inverse Bradford matrix.
 *
 * Cheap (just a couple of 3x3 multiplies) but called once per pixel in
 * matrix-profile transforms, so worth keeping inline.
 *
 *  Reference: http://www.brucelindbloom.com/index.html?Eqn_ChromAdapt.html
 *
 * @param {_cmsXYZ | object}  XYZ        XYZ tristimulus to adapt (read-only).
 * @param {_cmsWhitePoint} sourceWhite   Whitepoint the input XYZ is at.
 * @param {_cmsWhitePoint} destWhite     Whitepoint the output should be at.
 * @returns {_cmsXYZ}                    New object; input is not mutated.
 */
convert.adaptation = function(XYZ, sourceWhite, destWhite){
    var MtxAdaptMa = this.BradfordMtxAdapt;
    var MtxAdaptMaI  = this.BradfordMtxAdaptInv;

    //http://www.brucelindbloom.com/index.html?Eqn_ChromAdapt.html

    // Transform RefWhite (SOURCE) into Bradford LMS cone space.
    // Note: every whitepoint in this engine has Y === 1.0 by convention, so
    // the `(sourceWhite.Y * MtxAdaptMa.m1?)` terms collapse to bare matrix
    // elements. The XYZ multiplies further down keep their `.Y` term — that
    // is a colour value, not a whitepoint, and is generally NOT 1.0.
    var As = (sourceWhite.X * MtxAdaptMa.m00) + MtxAdaptMa.m10 + (sourceWhite.Z * MtxAdaptMa.m20);
    var Bs = (sourceWhite.X * MtxAdaptMa.m01) + MtxAdaptMa.m11 + (sourceWhite.Z * MtxAdaptMa.m21);
    var Cs = (sourceWhite.X * MtxAdaptMa.m02) + MtxAdaptMa.m12 + (sourceWhite.Z * MtxAdaptMa.m22);

    // Transform Space _cmsWhitePoint (DEST). Same Y === 1.0 simplification.
    var Ad = (destWhite.X * MtxAdaptMa.m00) + MtxAdaptMa.m10 + (destWhite.Z * MtxAdaptMa.m20);
    var Bd = (destWhite.X * MtxAdaptMa.m01) + MtxAdaptMa.m11 + (destWhite.Z * MtxAdaptMa.m21);
    var Cd = (destWhite.X * MtxAdaptMa.m02) + MtxAdaptMa.m12 + (destWhite.Z * MtxAdaptMa.m22);

    // Transform from XYZ into a cone response domain, (ρ, γ, β) using the Matrix.
    // KEEP the `XYZ.Y * ...` terms — XYZ.Y is a colour Y, not a whitepoint Y.
    var X1 = (XYZ.X * MtxAdaptMa.m00) + (XYZ.Y * MtxAdaptMa.m10) + (XYZ.Z * MtxAdaptMa.m20);
    var Y1 = (XYZ.X * MtxAdaptMa.m01) + (XYZ.Y * MtxAdaptMa.m11) + (XYZ.Z * MtxAdaptMa.m21);
    var Z1 = (XYZ.X * MtxAdaptMa.m02) + (XYZ.Y * MtxAdaptMa.m12) + (XYZ.Z * MtxAdaptMa.m22);

    // Scale the vector components by factors dependent upon both the source and destination reference whites.
    X1 *= (Ad / As);
    Y1 *= (Bd / Bs);
    Z1 *= (Cd / Cs);

    // Transform from (ρ, γ, β) back to XYZ using the inverse transform of step 1
    return {
        X: (X1 * MtxAdaptMaI.m00) + (Y1 * MtxAdaptMaI.m10) + (Z1 * MtxAdaptMaI.m20),
        Y: (X1 * MtxAdaptMaI.m01) + (Y1 * MtxAdaptMaI.m11) + (Z1 * MtxAdaptMaI.m21),
        Z: (X1 * MtxAdaptMaI.m02) + (Y1 * MtxAdaptMaI.m12) + (Z1 * MtxAdaptMaI.m22),
        type: eColourType.XYZ
    }
};

/**
 * XYZ → linear-then-gamma-encoded RGB device values, returned as a raw
 * `[R, G, B]` float array (no `_cmsRGBf` wrapping).
 *
 *   1. Adapt XYZ to the profile's media whitepoint if needed.
 *   2. Multiply by `RGBMatrix.matrixInv` (XYZ → linear RGB).
 *   3. Optionally clip to 0..1.
 *   4. Apply per-channel gamma encoding (sRGB curve or pure-gamma).
 *
 * "Device" here means values in the profile's RGB colour space, gamma
 * encoded, ready to drop into a pixel buffer (after × 255 if you want bytes).
 *
 * @param {_cmsXYZ}  XYZ
 * @param {_cmsWhitePoint} XYZRefwhite  Whitepoint the input XYZ is at.
 * @param {Profile} RGBProfile
 * @param {boolean} clip   Pass `false` to keep out-of-gamut values; default clips.
 * @returns {number[]}     Plain `[R,G,B]` floats, gamma-encoded.
 */
convert.XYZ2RGBDevice = function(XYZ, XYZRefwhite, RGBProfile, clip){

    // whitespace adaptaton
    if(!this.compareWhitePoints(XYZRefwhite, RGBProfile.mediaWhitePoint)){
        XYZ = this.adaptation(XYZ,XYZRefwhite,RGBProfile.mediaWhitePoint);
    }

    var matrixInv = RGBProfile.RGBMatrix.matrixInv;
    var R = XYZ.X * matrixInv.m00 + XYZ.Y * matrixInv.m01 + XYZ.Z * matrixInv.m02;
    var G = XYZ.X * matrixInv.m10 + XYZ.Y * matrixInv.m11 + XYZ.Z * matrixInv.m12;
    var B = XYZ.X * matrixInv.m20 + XYZ.Y * matrixInv.m21 + XYZ.Z * matrixInv.m22;

    if(clip !== false){
        R = (R>1.0)? 1.0 : R;
        G = (G>1.0)? 1.0 : G;
        B = (B>1.0)? 1.0 : B;
        R = (R<0.0)? 0.0 : R;
        G = (G<0.0)? 0.0 : G;
        B = (B<0.0)? 0.0 : B;
    }

    if(RGBProfile.RGBMatrix.issRGB){

        R = this.sRGBGamma(R);
        G = this.sRGBGamma(G);
        B = this.sRGBGamma(B);

    } else {

        R = this.gamma(R, RGBProfile.RGBMatrix.gamma);
        G = this.gamma(G, RGBProfile.RGBMatrix.gamma);
        B = this.gamma(B, RGBProfile.RGBMatrix.gamma);

    }

    return [R,G,B];
};

/**
 * XYZ → `_cmsRGBf` (typed RGB float). Same maths as `XYZ2RGBDevice` but
 * wraps the result in a typed colour object.
 *
 * @param {_cmsXYZ}  XYZ
 * @param {_cmsWhitePoint} XYZRefwhite  Whitepoint the input XYZ is at.
 * @param {Profile} RGBProfile
 * @param {boolean=} clip   Pass `false` to keep out-of-gamut values.
 * @returns {_cmsRGBf}
 */
convert.XYZ2RGBf = function(XYZ, XYZRefwhite, RGBProfile, clip){
//        if (space === undefined || space === null) {
//            space = SpacesRGB
//        } else {
//            if (typeof space === 'string') { space = cmsGetSpace(space) }
//        }
    XYZRefwhite = XYZRefwhite || this.D50;

    // whitespace adaptaton
    if(!this.compareWhitePoints(XYZRefwhite, RGBProfile.mediaWhitePoint)){
        XYZ = this.adaptation(XYZ,XYZRefwhite,RGBProfile.mediaWhitePoint);
    }

    var matrixInv = RGBProfile.RGBMatrix.matrixInv;
    var R = XYZ.X * matrixInv.m00 + XYZ.Y * matrixInv.m01 + XYZ.Z * matrixInv.m02;
    var G = XYZ.X * matrixInv.m10 + XYZ.Y * matrixInv.m11 + XYZ.Z * matrixInv.m12;
    var B = XYZ.X * matrixInv.m20 + XYZ.Y * matrixInv.m21 + XYZ.Z * matrixInv.m22;

    if(clip !== false){
        R = (R>1.0)? 1.0 : R;
        G = (G>1.0)? 1.0 : G;
        B = (B>1.0)? 1.0 : B;
        R = (R<0.0)? 0.0 : R;
        G = (G<0.0)? 0.0 : G;
        B = (B<0.0)? 0.0 : B;
    }

    if(RGBProfile.RGBMatrix.issRGB){

        R = this.sRGBGamma(R);
        G = this.sRGBGamma(G);
        B = this.sRGBGamma(B);

    } else {

        R = this.gamma(R, RGBProfile.RGBMatrix.gamma);
        G = this.gamma(G, RGBProfile.RGBMatrix.gamma);
        B = this.gamma(B, RGBProfile.RGBMatrix.gamma);

    }

    return this.RGBFloat(R,G,B);
};

/**
 * Raw `[R,G,B]` device array (gamma-encoded, 0..1) → XYZ at `XYZRefWhite`.
 *
 *   1. Linearise via inverse gamma (sRGB curve or pure-gamma).
 *   2. Multiply by `RGBMatrix.matrixV4` (linear RGB → XYZ at media WP).
 *   3. Adapt to `XYZRefWhite` if it differs from the media whitepoint.
 *
 * @param {number[]} device  Plain `[R,G,B]` floats in 0..1, gamma-encoded.
 * @param {Profile} RGBProfile
 * @param {_cmsWhitePoint}  XYZRefWhite  Reference white the result should sit at.
 * @returns {_cmsXYZ}
 */
convert.RGBDevice2XYZ = function(device, RGBProfile, XYZRefWhite){
    // Gamma correction
    var R, G, B;
    if (RGBProfile.RGBMatrix.issRGB){
        R = this.sRGBGammaInv(device[0]);
        G = this.sRGBGammaInv(device[1]);
        B = this.sRGBGammaInv(device[2]);
    } else {
        R = this.gammaInv(device[0] , RGBProfile.RGBMatrix.gamma);
        G = this.gammaInv(device[1] , RGBProfile.RGBMatrix.gamma);
        B = this.gammaInv(device[2] , RGBProfile.RGBMatrix.gamma);
    }

    var matrix = RGBProfile.RGBMatrix.matrixV4;
    var XYZ={
        X:R * matrix.m00 + G * matrix.m01 + B * matrix.m02,
        Y:R * matrix.m10 + G * matrix.m11 + B * matrix.m12,
        Z:R * matrix.m20 + G * matrix.m21 + B * matrix.m22,
        type: eColourType.XYZ
    };

    // XYZ are now set, but may need chromatic adaptation

    if(!this.compareWhitePoints(XYZRefWhite, RGBProfile.mediaWhitePoint)){
        XYZ = this.adaptation(XYZ, RGBProfile.mediaWhitePoint, XYZRefWhite);
    }
    return XYZ;
};

/**
 * `_cmsRGBf` (typed RGB float, 0..1, gamma-encoded) → XYZ at `XYZRefWhite`.
 * Same maths as `RGBDevice2XYZ`; takes a typed colour object instead of a
 * plain array.
 *
 * @param {_cmsRGBf} rgbf
 * @param {Profile} RGBProfile
 * @param {_cmsWhitePoint} XYZRefWhite  Reference white the result should sit at.
 * @returns {_cmsXYZ}
 */
convert.RGBf2XYZ = function(rgbf, RGBProfile, XYZRefWhite){
    var R = rgbf.Rf;
    var G = rgbf.Gf;
    var B = rgbf.Bf;

    // Gamma correction
    if (RGBProfile.RGBMatrix.issRGB){
        R = this.sRGBGammaInv(R);
        G = this.sRGBGammaInv(G);
        B = this.sRGBGammaInv(B);
    } else {
        R = this.gammaInv(R , RGBProfile.RGBMatrix.gamma);
        G = this.gammaInv(G , RGBProfile.RGBMatrix.gamma);
        B = this.gammaInv(B , RGBProfile.RGBMatrix.gamma);
    }

    var matrix = RGBProfile.RGBMatrix.matrixV4;
    var XYZ={
        X:R * matrix.m00 + G * matrix.m01 + B * matrix.m02,
        Y:R * matrix.m10 + G * matrix.m11 + B * matrix.m12,
        Z:R * matrix.m20 + G * matrix.m21 + B * matrix.m22,
        type: eColourType.XYZ
    };

    // XYZ are now set, but may need chromatic adaptation

    if(!this.compareWhitePoints(XYZRefWhite, RGBProfile.mediaWhitePoint)){
        XYZ = this.adaptation(XYZ, RGBProfile.mediaWhitePoint, XYZRefWhite);
    }
    return XYZ;
};


/**
 * Lab → RGB byte triple (0..255). Convenience wrapper over `Lab2RGBDevice`
 * that scales 0..1 → 0..255 and rounds to `decimals` places (default 0,
 * i.e. integers).
 *
 * @param {_cmsLab} cmsLab
 * @param {Profile} RGBProfile
 * @param {number=} decimals  Decimal places to round each channel to (default 0).
 * @returns {_cmsRGB}
 */
convert.Lab2RGB = function(cmsLab, RGBProfile, decimals){
    decimals = decimals || 0;
    var RGBDevice = this.Lab2RGBDevice(cmsLab, RGBProfile);
    return {
        R : roundN(RGBDevice[0]*255, decimals),
        G : roundN(RGBDevice[1]*255, decimals),
        B : roundN(RGBDevice[2]*255, decimals),
        type: eColourType.RGB
    };
};

/**
 * Lab → sRGB byte fast-path. INTENDED FOR DISPLAY ONLY (showing a close
 * approximation of a Lab colour in a browser swatch / canvas / DOM colour
 * style) — NOT for colorimetric work.
 *
 * What this function deliberately does NOT do:
 *
 *   - It does NOT chromatically adapt. The input Lab is taken as-is and
 *     fed straight through D65-referenced maths (D65 is sRGB's whitepoint).
 *     `cmsLab.whitePoint` is ignored.
 *   - It does NOT consult an ICC profile. The matrix and gamma are the
 *     hardcoded standard sRGB constants.
 *   - It does NOT preserve out-of-gamut information — values are clipped
 *     to 0..255 and rounded.
 *
 * If you actually need a colorimetric Lab → RGB conversion (round-trippable,
 * whitepoint-aware, profile-aware), use `Lab2RGB(lab, sRGBProfile)` with a
 * loaded sRGB profile, or build a Transform.
 *
 * The "good enough for a swatch" sweet spot:
 *
 *      // got Lab from anywhere, want to show it in the DOM
 *      var rgb = convert.Lab2sRGB(lab);
 *      element.style.background = 'rgb(' + rgb.R + ',' + rgb.G + ',' + rgb.B + ')';
 *
 * Uses the historical `0.008856 / 7.787` Lab constants instead of the
 * modern `kE / kK` — equivalent to ~6 d.p. Kept as a zero-dependency
 * convenience.
 *
 * @param {_cmsLab} cmsLab  Treated as D65 regardless of cmsLab.whitePoint.
 * @returns {{R: number, G: number, B: number}}  sRGB bytes 0..255, clipped.
 */
convert.Lab2sRGB = function(cmsLab) {
    // CIE-L*ab -> XYZ
    var y = (cmsLab.L + 16) / 116;
    var x = cmsLab.a / 500 + y;
    var z = y - cmsLab.b / 200;

    if (Math.pow(y, 3) > 0.008856)
        y = Math.pow(y, 3);
    else
        y = (y - 16 / 116) / 7.787;
    if (Math.pow(x, 3) > 0.008856)
        x = Math.pow(x, 3);
    else
        x = (x - 16 / 116) / 7.787;
    if (Math.pow(z, 3) > 0.008856)
        z = Math.pow(z, 3);
    else
        z = (z - 16 / 116) / 7.787;

    x = 0.95047 * x;     //ref_X =  95.047     Observer= 2°, Illuminant= D65
    //y = 1.00000 * y;   //ref_Y = 100.000
    z = 1.08883 * z;     //ref_Z = 108.883

    var r = x * 3.2406 + y * -1.5372 + z * -0.4986;
    var g = x * -0.9689 + y * 1.8758 + z * 0.0415;
    var b = x * 0.0557 + y * -0.2040 + z * 1.0570;

    if (r > 0.0031308)
        r = 1.055 * Math.pow(r, 1 / 2.4) - 0.055;
    else
        r = 12.92 * r;
    if (g > 0.0031308)
        g = 1.055 * Math.pow(g, 1 / 2.4) - 0.055;
    else
        g = 12.92 * g;
    if (b > 0.0031308)
        b = 1.055 * Math.pow(b, 1 / 2.4) - 0.055;
    else
        b = 12.92 * b;

    r = Math.min(255, Math.max(0, Math.round(r * 255)));
    g = Math.min(255, Math.max(0, Math.round(g * 255)));
    b = Math.min(255, Math.max(0, Math.round(b * 255)));

    return {R: r, G: g, B: b}
};

/**
 * Lab → linear-then-gamma-encoded RGB device values, returned as a raw
 * `[R, G, B]` float array. Inlines the Lab→XYZ maths to avoid an extra
 * object allocation, then runs the same pipeline as `XYZ2RGBDevice`.
 *
 * Always clips to 0..1 (no opt-out — used as the leaf for `Lab2RGB`).
 *
 * @param {_cmsLab | _cmsLabD50} cmsLab
 * @param {Profile} RGBProfile
 * @returns {number[]}  Plain `[R, G, B]` floats in 0..1, gamma-encoded.
 */
convert.Lab2RGBDevice = function(cmsLab, RGBProfile){

    // convert to XYZ
    var kE = 216.0 / 24389.0;
    var kK = 24389.0 / 27.0;
    var kKE = 8.0;

    var fy = (cmsLab.L + 16.0) / 116.0;
    var fx = 0.002 * cmsLab.a + fy;
    var fz = fy - 0.005 * cmsLab.b;

    var fx3 = fx * fx * fx;
    var fz3 = fz * fz * fz;

    var xr = (fx3 > kE) ? fx3 : ((116.0 * fx - 16.0) / kK);
    var yr = (cmsLab.L > kKE) ? Math.pow((cmsLab.L + 16.0) / 116.0, 3.0) : (cmsLab.L / kK);
    var zr = (fz3 > kE) ? fz3 : ((116.0 * fz - 16.0) / kK);

    var whitePoint = cmsLab.whitePoint || convert.d50;

    // INTENTIONAL: every whitepoint in this engine has Y === 1.0 by
    // convention, so `yr * whitePoint.Y` reduces to `yr`. Don't "fix" by
    // adding the multiply back. (See file-top WHITEPOINT CONVENTION.)
    var XYZ = {X: xr * whitePoint.X, Y: yr, Z: zr * whitePoint.Z, type: eColourType.XYZ};

    // whitespace adaptaton
    if(!this.compareWhitePoints(whitePoint, RGBProfile.mediaWhitePoint)){
        XYZ = this.adaptation(XYZ, whitePoint, RGBProfile.mediaWhitePoint);
    }

    // XYZ to RGB
    var matrixInv = RGBProfile.RGBMatrix.matrixInv;
    var R = XYZ.X * matrixInv.m00 + XYZ.Y * matrixInv.m01 + XYZ.Z * matrixInv.m02;
    var G = XYZ.X * matrixInv.m10 + XYZ.Y * matrixInv.m11 + XYZ.Z * matrixInv.m12;
    var B = XYZ.X * matrixInv.m20 + XYZ.Y * matrixInv.m21 + XYZ.Z * matrixInv.m22;

    // Range Check
    R = (R>1.0)? 1.0 : R;
    G = (G>1.0)? 1.0 : G;
    B = (B>1.0)? 1.0 : B;
    R = (R<0.0)? 0.0 : R;
    G = (G<0.0)? 0.0 : G;
    B = (B<0.0)? 0.0 : B;

    // Gamma
    if(RGBProfile.RGBMatrix.issRGB){

        R = this.sRGBGamma(R);
        G = this.sRGBGamma(G);
        B = this.sRGBGamma(B);

    } else {

        R = this.gamma(R, RGBProfile.RGBMatrix.gamma);
        G = this.gamma(G, RGBProfile.RGBMatrix.gamma);
        B = this.gamma(B, RGBProfile.RGBMatrix.gamma);

    }

    return [R, G, B];
};

/**
 * Compare two whitepoints component-wise within a tolerance. Used to decide
 * whether chromatic adaptation can be skipped on the fast path.
 *
 * @param {_cmsWhitePoint} white1
 * @param {_cmsWhitePoint} white2
 * @param {number} [tolerance=0.001]
 * @returns {boolean}  True if all three components match within tolerance.
 */
convert.compareWhitePoints = function(white1, white2, tolerance){
    tolerance = tolerance || 0.001;
    if( Math.abs(white1.X - white2.X) > tolerance) {return false;}
    if( Math.abs(white1.Y - white2.Y) > tolerance) {return false;}
    return Math.abs(white1.Z - white2.Z) <= tolerance;
};

/**
 * Raw `[R,G,B]` device array (gamma-encoded, 0..1) → D50 Lab. Inlines the
 * full RGB → linear → XYZ → adapt → Lab pipeline to avoid intermediate
 * object allocations.
 *
 * @param {number[]} device  Plain `[R,G,B]` floats in 0..1, gamma-encoded.
 * @param {Profile} RGBProfile
 * @returns {_cmsLab}  Lab tagged with whitePoint = D50.
 */
convert.RGBDevice2LabD50 = function(device, RGBProfile){

    // Gamma correction
    var R,G,B;
    if (RGBProfile.RGBMatrix.issRGB){
        R = this.sRGBGammaInv(device[0]);
        G = this.sRGBGammaInv(device[1]);
        B = this.sRGBGammaInv(device[2]);
    } else {
        R = this.gammaInv(device[0] , RGBProfile.RGBMatrix.gamma);
        G = this.gammaInv(device[1] , RGBProfile.RGBMatrix.gamma);
        B = this.gammaInv(device[2] , RGBProfile.RGBMatrix.gamma);
    }

    var matrix = RGBProfile.RGBMatrix.matrixV4;
    var XYZ = {
        X:R * matrix.m00 + G * matrix.m01 + B * matrix.m02,
        Y:R * matrix.m10 + G * matrix.m11 + B * matrix.m12,
        Z:R * matrix.m20 + G * matrix.m21 + B * matrix.m22
    };

    // XYZ are now set, but may need chromatic adaptation
    var destWhitePoint = this.d50;
    if(!this.compareWhitePoints(destWhitePoint, RGBProfile.mediaWhitePoint)){
        XYZ = this.adaptation(XYZ, RGBProfile.mediaWhitePoint, destWhitePoint);
    }

    //XYZ2Lab
    var kE = 216.0 / 24389.0;
    var kK = 24389.0 / 27.0;
    //var kKE = 8.0;

    var xr = XYZ.X / destWhitePoint.X;
    // yr: every whitepoint in this engine has Y === 1.0 by convention,
    // so `XYZ.Y / destWhitePoint.Y` reduces to `XYZ.Y`. Don't "fix" this back.
    var yr = XYZ.Y;
    var zr = XYZ.Z / destWhitePoint.Z;

    var fx = (xr > kE) ? Math.pow(xr, 1.0 / 3.0) : ((kK * xr + 16.0) / 116.0);
    var fy = (yr > kE) ? Math.pow(yr, 1.0 / 3.0) : ((kK * yr + 16.0) / 116.0);
    var fz = (zr > kE) ? Math.pow(zr, 1.0 / 3.0) : ((kK * zr + 16.0) / 116.0);

    return {
        L: 116.0 * fy - 16.0,
        a: 500.0 * (fx - fy),
        b: 200.0 * (fy - fz),
        type: eColourType.Lab,
        whitePoint: destWhitePoint
    };
};

/**
 * `_cmsRGBf` (typed RGB float, 0..1, gamma-encoded) → Lab at the given
 * whitepoint. Inlines the full RGB → linear → XYZ → adapt → Lab pipeline.
 *
 * If `destWhitePoint` is omitted, the RGB profile's media whitepoint is
 * used (no adaptation needed).
 *
 * @param {_cmsRGBf} RGBf
 * @param {Profile} RGBProfile
 * @param {_cmsWhitePoint=} destWhitePoint  Defaults to profile's mediaWhitePoint.
 * @returns {_cmsLab}
 */
convert.RGBf2Lab = function(RGBf, RGBProfile, destWhitePoint){

    // Gamma correction
    var R,G,B;
    if (RGBProfile.RGBMatrix.issRGB){
        R = this.sRGBGammaInv(RGBf.Rf);
        G = this.sRGBGammaInv(RGBf.Gf);
        B = this.sRGBGammaInv(RGBf.Bf);
    } else {
        R = this.gammaInv(RGBf.Rf , RGBProfile.RGBMatrix.gamma);
        G = this.gammaInv(RGBf.Gf , RGBProfile.RGBMatrix.gamma);
        B = this.gammaInv(RGBf.Bf , RGBProfile.RGBMatrix.gamma);
    }

    var matrix = RGBProfile.RGBMatrix.matrixV4;
    var XYZ = {
        X:R * matrix.m00 + G * matrix.m01 + B * matrix.m02,
        Y:R * matrix.m10 + G * matrix.m11 + B * matrix.m12,
        Z:R * matrix.m20 + G * matrix.m21 + B * matrix.m22
    };

    // XYZ are now set, but may need chromatic adaptation
    if(destWhitePoint){

        if(!this.compareWhitePoints(destWhitePoint, RGBProfile.mediaWhitePoint)){
            XYZ = this.adaptation(XYZ, RGBProfile.mediaWhitePoint, destWhitePoint);
        }
    } else {
        // if no whoit provided use the profiles whitePoint
        destWhitePoint = RGBProfile.mediaWhitePoint;
    }

    //XYZ2Lab
    var kE = 216.0 / 24389.0;
    var kK = 24389.0 / 27.0;
    //var kKE = 8.0;

    var xr = XYZ.X / destWhitePoint.X;
    // INTENTIONAL: every whitepoint in this engine has Y === 1.0 by
    // convention, so `XYZ.Y / destWhitePoint.Y` reduces to `XYZ.Y`. Don't
    // "fix" by adding the divide back. (See file-top WHITEPOINT CONVENTION.)
    var yr = XYZ.Y;
    var zr = XYZ.Z / destWhitePoint.Z;

    var fx = (xr > kE) ? Math.pow(xr, 1.0 / 3.0) : ((kK * xr + 16.0) / 116.0);
    var fy = (yr > kE) ? Math.pow(yr, 1.0 / 3.0) : ((kK * yr + 16.0) / 116.0);
    var fz = (zr > kE) ? Math.pow(zr, 1.0 / 3.0) : ((kK * zr + 16.0) / 116.0);

    return {
        L: 116.0 * fy - 16.0,
        a: 500.0 * (fx - fy),
        b: 200.0 * (fy - fz),
        type: eColourType.Lab,
        whitePoint: destWhitePoint
    };
};


// ============================================================================
//  GAMMA — encoding and inverse for matrix-profile RGB
// ============================================================================
//
//  The naming here is a long-standing source of confusion (TODO D3): the
//  function called `gamma()` actually APPLIES the encoding gamma (linear →
//  display, the `c^(1/γ)` direction), and `gammaInv()` LINEARISES (display →
//  linear, the `c^γ` direction).
//
//  Mnemonic: `gamma()` is what you call on the way OUT to the screen,
//  `gammaInv()` is what you call on the way IN from the screen.
//
// ============================================================================

/**
 * Apply gamma ENCODING (linear → display). Returns `c^(1/Gamma)`.
 *
 * Despite the name, this is the "going to the display" direction.
 * Use this when you have linear RGB and want display-encoded RGB.
 *
 * @param {number} c      Linear-light value, normally 0..1.
 * @param {number} Gamma  Display gamma, e.g. 2.2.
 * @returns {number}      Display-encoded value, normally 0..1.
 */
convert.gamma = function(c, Gamma){
    return Math.pow(c,  1 / Gamma);
};

/**
 * Apply gamma DECODING / linearisation (display → linear). Returns `c^Gamma`.
 *
 * Despite the name, this is the "coming from the display" direction.
 * Use this when you have display-encoded RGB and want linear RGB before
 * a matrix multiply to XYZ.
 *
 * @param {number} c      Display-encoded value, normally 0..1.
 * @param {number} Gamma  Display gamma, e.g. 2.2.
 * @returns {number}      Linear-light value.
 */
convert.gammaInv = function(c, Gamma){
    return Math.pow(c , Gamma);
};

/**
 * sRGB encoding curve (linear → sRGB display). Piecewise: linear segment
 * below 0.0031308, then `1.055·c^(1/2.4) - 0.055`. IEC 61966-2-1.
 * @param {number} c  Linear-light value 0..1.
 * @returns {number}  sRGB-encoded value 0..1.
 */
convert.sRGBGamma = function(c){
     return (c <= 0.0031308) ? (c * 12.92) : (1.055 * Math.pow(c, 1.0 / 2.4) - 0.055);
};

/**
 * sRGB decoding curve (sRGB display → linear). Inverse of `sRGBGamma`.
 * Piecewise: linear segment below 0.04045, then `((c + 0.055) / 1.055)^2.4`.
 * @param {number} c  sRGB-encoded value 0..1.
 * @returns {number}  Linear-light value 0..1.
 */
convert.sRGBGammaInv = function(c){
    return (c <= 0.04045) ? (c / 12.92) : Math.pow((c + 0.055) / 1.055, 2.4);
};

// ============================================================================
//  3x3 MATRIX HELPERS
// ============================================================================
//
//  Matrices are stored as flat objects with row-major keys:
//
//      m[row][column]
//        00   01    02
//        10   11    12
//        20   21    22
//
//  The flat-object layout (rather than `[[..],[..]]` arrays) is deliberate:
//  V8 keeps a stable hidden class for these and the per-element multiplies
//  inline cleanly. Conversion helpers `matrix2Object` / `objectToMatrix`
//  exist for the few places that need nested-array form (e.g. for
//  `multiplyMatricesArray`).
//
// ============================================================================

/**
 * Compute and CACHE the RGB↔XYZ matrices for a matrix-style RGB profile.
 *
 * SIDE EFFECTS (TODO D4): mutates `profile.RGBMatrix` in place, populating:
 *      - `matrixV4`     RGB → XYZ (linear)
 *      - `matrixInv`    XYZ → RGB (linear)
 *      - `XYZMatrix`    RGB → XYZ derived directly from rXYZ/gXYZ/bXYZ tags
 *      - `XYZMatrixInv` inverse of `XYZMatrix`
 *
 * The two RGB→XYZ matrices (`matrixV4` from primaries+whitepoint, vs
 * `XYZMatrix` from per-primary XYZ tags) should agree for a well-formed
 * profile but are computed from independent sources.
 *
 * Reference: Lindbloom — http://www.brucelindbloom.com/Eqn_RGB_XYZ_Matrix.html
 *
 * @param {Profile} profile  Must have populated `.RGBMatrix.cRx/cRy/cGx/cGy/
 *                           cBx/cBy`, `.mediaWhitePoint`, and (for XYZMatrix)
 *                           `.rgb.rXYZ/.gXYZ/.bXYZ`.
 * @returns {void}
 */
convert.computeMatrix = function(profile){

    var m = {
        m00: profile.RGBMatrix.cRx / profile.RGBMatrix.cRy,
        m01: profile.RGBMatrix.cGx / profile.RGBMatrix.cGy,
        m02: profile.RGBMatrix.cBx / profile.RGBMatrix.cBy,

        m10:1.0,
        m11:1.0,
        m12:1.0,

        m20:(1.0 - profile.RGBMatrix.cRx - profile.RGBMatrix.cRy) / profile.RGBMatrix.cRy,
        m21:(1.0 - profile.RGBMatrix.cGx - profile.RGBMatrix.cGy) / profile.RGBMatrix.cGy,
        m22:(1.0 - profile.RGBMatrix.cBx - profile.RGBMatrix.cBy) / profile.RGBMatrix.cBy
    };

    var mi = this.invertMatrix(m);

    // Y = 1
    // var sr = whitePoint.X * mi.m00 + whitePoint.Y * mi.m01 + whitePoint.Z * mi.m02;
    var sR = (profile.mediaWhitePoint.X * mi.m00) + (profile.mediaWhitePoint.Y * mi.m01) + (profile.mediaWhitePoint.Z * mi.m02);
    var sG = (profile.mediaWhitePoint.X * mi.m10) + (profile.mediaWhitePoint.Y * mi.m11) + (profile.mediaWhitePoint.Z * mi.m12);
    var sB = (profile.mediaWhitePoint.X * mi.m20) + (profile.mediaWhitePoint.Y * mi.m21) + (profile.mediaWhitePoint.Z * mi.m22);

    // Matrix from primaries
    profile.RGBMatrix.matrixV4 = {
        m00 : sR * m.m00,    m01 : sG * m.m01,   m02 : sB * m.m02,
        m10 : sR * m.m10,    m11 : sG * m.m11,   m12 : sB * m.m12,
        m20 : sR * m.m20,    m21 : sG * m.m21,   m22 : sB * m.m22
    };
    profile.RGBMatrix.matrixInv = this.invertMatrix(profile.RGBMatrix.matrixV4);

    // Matrix from XYZ values
    // RGB to XYZ
    profile.RGBMatrix.XYZMatrix = {
        m00 : profile.rgb.rXYZ.X,   m01 : profile.rgb.gXYZ.X,  m02 : profile.rgb.bXYZ.X,
        m10 : profile.rgb.rXYZ.Y,   m11 : profile.rgb.gXYZ.Y,  m12 : profile.rgb.bXYZ.Y,
        m20 : profile.rgb.rXYZ.Z,   m21 : profile.rgb.gXYZ.Z,  m22 : profile.rgb.bXYZ.Z,
    };

    //XYZ to RGB
    profile.RGBMatrix.XYZMatrixInv = this.invertMatrix(profile.RGBMatrix.XYZMatrix);

};

/**
 * Invert a 3x3 flat-object matrix using cofactor expansion.
 * Throws nothing on a singular matrix — returns Infinity-laden garbage if
 * the determinant is zero. Caller's responsibility to avoid that.
 *
 * @param {object} m  Flat-key 3x3 matrix.
 * @returns {object}  New flat-key 3x3 matrix.
 */
convert.invertMatrix = function(m){

    var determinant =
        m.m00 * (m.m22 * m.m11 - m.m21 * m.m12) -
        m.m10 * (m.m22 * m.m01 - m.m21 * m.m02) +
        m.m20 * (m.m12 * m.m01 - m.m11 * m.m02);

    var scale = 1.0 / determinant;

    return {
        m00:  scale * (m.m22 * m.m11 - m.m21 * m.m12),
        m01: -scale * (m.m22 * m.m01 - m.m21 * m.m02),
        m02:  scale * (m.m12 * m.m01 - m.m11 * m.m02),

        m10: -scale * (m.m22 * m.m10 - m.m20 * m.m12),
        m11:  scale * (m.m22 * m.m00 - m.m20 * m.m02),
        m12: -scale * (m.m12 * m.m00 - m.m10 * m.m02),

        m20:  scale * (m.m21 * m.m10 - m.m20 * m.m11),
        m21: -scale * (m.m21 * m.m00 - m.m20 * m.m01),
        m22:  scale * (m.m11 * m.m00 - m.m10 * m.m01)
    }

};

    /**
     * Scalar-multiply every element of a flat-key 3x3 matrix. Returns a new
     * matrix; input is not mutated.
     * @param {object} matrix
     * @param {number} scale
     * @returns {object}
     */
    convert.matrixScaleValues = function(matrix, scale){
        return {
                m00: matrix.m00 * scale,
                m01: matrix.m01 * scale,
                m02: matrix.m02 * scale,

                m10: matrix.m10 * scale,
                m11: matrix.m11 * scale,
                m12: matrix.m12 * scale,

                m20: matrix.m20 * scale,
                m21: matrix.m21 * scale,
                m22: matrix.m22 * scale
            };
    }

    /**
     * Nested-array `[[..],[..],[..]]` → flat-key matrix object.
     * @param {number[][]} matrixArray
     * @returns {object}
     */
    convert.matrix2Object = function(matrixArray) {
        return {
            m00: matrixArray[0][0], m01: matrixArray[0][1], m02: matrixArray[0][2],
            m10: matrixArray[1][0], m11: matrixArray[1][1], m12: matrixArray[1][2],
            m20: matrixArray[2][0], m21: matrixArray[2][1], m22: matrixArray[2][2]
        };
    }
    /**
     * Flat-key matrix object → nested-array `[[..],[..],[..]]`.
     * (Naming inconsistency with `matrix2Object` is preserved for back-compat.)
     * @param {object} matrixObject
     * @returns {number[][]}
     */
    convert.objectToMatrix = function(matrixObject) {
        return [
            [matrixObject.m00, matrixObject.m01, matrixObject.m02],
            [matrixObject.m10, matrixObject.m11, matrixObject.m12],
            [matrixObject.m20, matrixObject.m21, matrixObject.m22]
        ];
    }

    /**
     * Multiply two flat-key 3x3 matrices: `A · B`. Returns a new matrix.
     * Round-trips through nested-array form; if you need to do this in a
     * tight loop, inline the 9 multiply-adds instead.
     * @param {object} matrixA
     * @param {object} matrixB
     * @returns {object}
     */
    convert.multiplyMatrices = function(matrixA, matrixB) {
        return this.matrix2Object(this.multiplyMatricesArray(this.objectToMatrix(matrixA), this.objectToMatrix(matrixB)));
    }

    /**
     * Multiply two nested-array matrices `A · B`. Generic over rectangular
     * shapes (uses `matrixA.length`, `matrixB[0].length`).
     * @param {number[][]} matrixA
     * @param {number[][]} matrixB
     * @returns {number[][]}
     */
    convert.multiplyMatricesArray = function(matrixA, matrixB) {
        let result = [];

        for (let i = 0; i < matrixA.length; i++) {
            result[i] = [];
            for (let j = 0; j < matrixB[0].length; j++) {
                let sum = 0;
                for (let k = 0; k < matrixA[0].length; k++) {
                    sum += matrixA[i][k] * matrixB[k][j];
                }
                result[i][j] = sum;
            }
        }
        return result;
    }

    /**
     * Transpose a flat-key 3x3 matrix IN PLACE.
     *
     * TODO (D5): mutates its argument. Calls swap m01↔m10, m02↔m20,
     * m12↔m21. If the caller needs to keep the original, copy first.
     *
     * @param {object} m  Flat-key 3x3 matrix; mutated.
     * @returns {void}
     */
    convert.transpose = function(m){
        var v = m.m01;
        m.m01 = m.m10;
        m.m10 = v;

        v = m.m02;
        m.m02 = m.m20;
        m.m20 = v;

        v = m.m12;
        m.m12 = m.m21;
        m.m21 = v;
    };























// ============================================================================
//  ΔE — colour-difference metrics
// ============================================================================
//
//  Pick a metric to suit the use case:
//
//      ΔE76     Simple Euclidean Lab. Fastest, perceptually nonuniform.
//               Good for very rough thresholds and unit-test comparisons.
//      ΔE94    Refines ΔE76 in chroma/hue with separate weighting.
//               Tuned originally on automotive-paint data.
//      ΔE2000  Modern CIE recommendation. Best perceptual uniformity but
//               most expensive. Use for soft-proof tolerance and any
//               serious "do these match?" question.
//      ΔECMC   Textile-industry tolerance metric (CMC l:c). Allows lightness
//               vs chroma weighting; default 2:1 for acceptability.
//
//  All metrics assume both Lab values share the same reference whitepoint
//  (typically D50). If they don't, adapt one with `Lab2Lab` first.
//
// ============================================================================

/**
 * ΔE 1976 (Euclidean Lab distance). `sqrt(ΔL² + Δa² + Δb²)`.
 * Both Lab values must be at the same whitepoint.
 *
 * @param {_cmsLab} Lab1
 * @param {_cmsLab} Lab2
 * @returns {number}
 */
convert.deltaE1976 = function(Lab1, Lab2)
{
    var dL = Lab1.L - Lab2.L;
    var da = Lab1.a - Lab2.a;
    var db = Lab1.b - Lab2.b;
    return Math.sqrt(dL * dL + da * da + db * db);
};


/**
 * ΔE 1994 (CIE94). Refines ΔE76 with separate lightness, chroma and hue
 * weightings.
 *
 * A technical committee of the CIE (TC 1-29) published an equation in 1995
 * called CIE94. The equation is similar to CMC but the weighting functions
 * are largely based on RIT/DuPont tolerance data derived from automotive
 * paint experiments where sample surfaces are smooth. It also has ratios
 * labelled kL (lightness) and kC (chroma) and the commercial factor (cf)
 * but these tend to be preset in software and are not often exposed.
 *
 * Asymmetric: Lab1 is the reference, Lab2 is the sample.
 *
 * @param {_cmsLab}  Lab1 Reference
 * @param {_cmsLab}  Lab2 Sample
 * @param {boolean} [IsTextiles]  If true, uses the textiles weighting (kL=2,
 *                                k1=0.048, k2=0.014). Otherwise graphics-arts.
 * @returns {number}
 */
convert.deltaE1994= function(Lab1, Lab2, IsTextiles)
{
    var k1 = (IsTextiles === true) ? 0.048 : 0.045;
    var k2 = (IsTextiles === true) ? 0.014 : 0.015;
    var kL = (IsTextiles === true) ? 2.0 : 1.0;
    var kC = 1.0;
    var kH = 1.0;

    var C1 = Math.sqrt(Lab1.a * Lab1.a + Lab1.b * Lab1.b);
    var C2 = Math.sqrt(Lab2.a * Lab2.a + Lab2.b * Lab2.b);

    var delA = Lab1.a - Lab2.a;
    var delB = Lab1.b - Lab2.b;
    var delC = C1 - C2;
    var delH2 = delA * delA + delB * delB - delC * delC;
    var delH = (delH2 > 0.0) ? Math.sqrt(delH2) : 0.0;
    var delL = Lab1.L - Lab2.L;

    var sL = 1.0;
    var sC = 1.0 + k1 * C1;
    var sH = 1.0 + k2 * C1;

    var vL = delL / (kL * sL);
    var vC = delC / (kC * sC);
    var vH = delH / (kH * sH);

    return Math.sqrt(vL * vL + vC * vC + vH * vH);
};

/**
 * ΔE 2000 (CIEDE2000). The current CIE-recommended colour difference.
 *
 * Unlike ΔE94, which assumes that L* correctly reflects perceived
 * lightness differences, ΔE2000 varies the weighting of L* depending on
 * where in the lightness range the colour falls. It also adds chroma /
 * hue interaction terms and a near-blue rotation correction. The most
 * perceptually accurate of the four metrics in this file, and the most
 * expensive (heavy use of `pow`, `sqrt`, `cos`, `sin`, `atan2`).
 *
 * Reference: CIE 142:2001 / Lindbloom CIEDE2000.
 *
 * @param {_cmsLab}  Lab1 Reference
 * @param {_cmsLab}  Lab2 Sample
 * @returns {number}
 */
convert.deltaE2000 = function(Lab1, Lab2)
{
    var kL = 1.0;
    var kC = 1.0;
    var kH = 1.0;
    var lBarPrime = 0.5 * (Lab1.L + Lab2.L);
    var c1 = Math.sqrt(Lab1.a * Lab1.a + Lab1.b * Lab1.b);
    var c2 = Math.sqrt(Lab2.a * Lab2.a + Lab2.b * Lab2.b);
    var cBar = 0.5 * (c1 + c2);
    var cBar7 = cBar * cBar * cBar * cBar * cBar * cBar * cBar;
    var g = 0.5 * (1.0 - Math.sqrt(cBar7 / (cBar7 + 6103515625.0)));	/* 6103515625 = 25^7 */
    var a1Prime = Lab1.a * (1.0 + g);
    var a2Prime = Lab2.a * (1.0 + g);
    var c1Prime = Math.sqrt(a1Prime * a1Prime + Lab1.b * Lab1.b);
    var c2Prime = Math.sqrt(a2Prime * a2Prime + Lab2.b * Lab2.b);
    var cBarPrime = 0.5 * (c1Prime + c2Prime);
    var h1Prime = (Math.atan2(Lab1.b, a1Prime) * 180.0) / Math.PI;
    if (h1Prime < 0.0){
        h1Prime += 360.0;
    }
    var h2Prime = (Math.atan2(Lab2.b, a2Prime) * 180.0) / Math.PI;
    if (h2Prime < 0.0){
        h2Prime += 360.0;
    }
    var hBarPrime = (Math.abs(h1Prime - h2Prime) > 180.0) ? (0.5 * (h1Prime + h2Prime + 360.0)) : (0.5 * (h1Prime + h2Prime));
    var t = 1.0 -
        0.17 * Math.cos(Math.PI * (      hBarPrime - 30.0) / 180.0) +
        0.24 * Math.cos(Math.PI * (2.0 * hBarPrime       ) / 180.0) +
        0.32 * Math.cos(Math.PI * (3.0 * hBarPrime +  6.0) / 180.0) -
        0.20 * Math.cos(Math.PI * (4.0 * hBarPrime - 63.0) / 180.0);

    var dhPrime;
    if (Math.abs(h2Prime - h1Prime) <= 180.0){
        dhPrime = h2Prime - h1Prime;
    } else{
        dhPrime = (h2Prime <= h1Prime) ? (h2Prime - h1Prime + 360.0) : (h2Prime - h1Prime - 360.0);
    }
    var dLPrime = Lab2.L - Lab1.L;
    var dCPrime = c2Prime - c1Prime;

    var dHPrime = 2.0 * Math.sqrt(c1Prime * c2Prime) * Math.sin(Math.PI * (0.5 * dhPrime) / 180.0);
    var sL = 1.0 + ((0.015 * (lBarPrime - 50.0) * (lBarPrime - 50.0)) / Math.sqrt(20.0 + (lBarPrime - 50.0) * (lBarPrime - 50.0)));
    var sC = 1.0 + 0.045 * cBarPrime;
    var sH = 1.0 + 0.015 * cBarPrime * t;
    var dTheta = 30.0 * Math.exp(-((hBarPrime - 275.0) / 25.0) * ((hBarPrime - 275.0) / 25.0));
    var cBarPrime7 = cBarPrime * cBarPrime * cBarPrime * cBarPrime * cBarPrime * cBarPrime * cBarPrime;
    var rC = Math.sqrt(cBarPrime7 / (cBarPrime7 + 6103515625.0));
    var rT = -2.0 * rC * Math.sin(Math.PI * (2.0 * dTheta) / 180.0);
    return Math.sqrt(
        (dLPrime / (kL * sL)) * (dLPrime / (kL * sL)) +
        (dCPrime / (kC * sC)) * (dCPrime / (kC * sC)) +
        (dHPrime / (kH * sH)) * (dHPrime / (kH * sH)) +
        (dCPrime / (kC * sC)) * (dHPrime / (kH * sH)) * rT);
};

/**
 * ΔE CMC (l:c). Textile-industry tolerance metric based on LCH.
 *
 * In 1984 the CMC (Color Measurement Committee of the Society of Dyes and
 * Colourists of Great Britain) developed an equation based on LCH numbers.
 * CMC l:c allows the setting of lightness (l) and chroma (c) factors. As
 * the eye is more sensitive to chroma, the default ratio for l:c is 2:1,
 * allowing 2x the lightness difference for the same tolerance. There is
 * also a 'commercial factor' (cf) which scales the overall tolerance
 * region; cf = 1.0 means a ΔECMC < 1.0 is acceptable.
 *
 *   - acceptability tolerances → CMC(2:1)
 *   - perceptibility tolerances → CMC(1:1)
 *
 * Note: the function defaults to `lightnessFactor=2, chromaFactor=1`, i.e.
 * CMC(2:1).
 *
 * @param {_cmsLab}  Lab1 Reference
 * @param {_cmsLab}  Lab2 Sample
 * @param {number} [lightnessFactor=2]
 * @param {number} [chromaFactor=1]
 * @returns {number}
 */
convert.deltaECMC= function(Lab1, Lab2, lightnessFactor, chromaFactor)
{
    if(lightnessFactor === undefined){lightnessFactor = 2;}
    if(chromaFactor === undefined){chromaFactor = 1;}
    var c1 = Math.sqrt(Lab1.a * Lab1.a + Lab1.b * Lab1.b);
    var c2 = Math.sqrt(Lab2.a * Lab2.a + Lab2.b * Lab2.b);
    var sl = (Lab1.L < 16.0) ? (0.511) : ((0.040975 * Lab1.L) / (1.0 + 0.01765 * Lab1.L));
    var sc = (0.0638 * c1) / (1.0 + 0.0131 * c1) + 0.638;
    var h1 = (c1 < 0.000001) ? 0.0 : ((Math.atan2(Lab1.b, Lab1.a) * 180.0) / Math.PI);
    while (h1 < 0.0){
        h1 += 360.0;
    }

    while (h1 >= 360.0){
        h1 -= 360.0;
    }

    var t = ((h1 >= 164.0) && (h1 <= 345.0)) ? (0.56 + Math.abs(0.2 * Math.cos((Math.PI * (h1 + 168.0)) / 180.0))) : (0.36 + Math.abs(0.4 * Math.cos((Math.PI * (h1 + 35.0)) / 180.0)));
    var c4 = c1 * c1 * c1 * c1;
    var f = Math.sqrt(c4 / (c4 + 1900.0));
    var sh = sc * (f * t + 1.0 - f);
    var delL = Lab1.L - Lab2.L;
    var delC = c1 - c2;
    var delA = Lab1.a - Lab2.a;
    var delB = Lab1.b - Lab2.b;
    var dH2 = delA * delA + delB * delB - delC * delC;
    var v1 = delL / (lightnessFactor * sl);
    var v2 = delC / (chromaFactor * sc);
    var v3 = sh;
    return Math.sqrt(v1 * v1 + v2 * v2 + (dH2 / (v3 * v3)));
};

// ============================================================================
//  WAVELENGTH HELPER
// ============================================================================

/**
 * Approximate sRGB byte triple for a given visible wavelength (380–780 nm).
 *
 * This is NOT a colorimetrically correct rendering — it's a perceptual
 * approximation suitable for plotting spectrum charts and UI rainbows.
 * Values outside 380–780 nm return black. Includes a near-edge intensity
 * roll-off and a fixed display gamma of 0.80.
 *
 * Source: http://www.efg2.com/Lab/ScienceAndEngineering/Spectra.htm
 *
 * @param {number} wavelength  Wavelength in nm.
 * @returns {_cmsRGB}  Approximate RGB byte triple for the wavelength.
 */
convert.wavelength2RGB = function (wavelength) {
    var red, green, blue, factor;
    if((wavelength >= 380) && (wavelength < 440)){
        red = -(wavelength - 440) / (440 - 380);
        green = 0.0;
        blue = 1.0;
    }else if((wavelength >= 440) && (wavelength < 490)){
        red = 0.0;
        green = (wavelength - 440) / (490 - 440);
        blue = 1.0;
    }else if((wavelength >= 490) && (wavelength < 510)){
        red = 0.0;
        green = 1.0;
        blue = -(wavelength - 510) / (510 - 490);
    }else if((wavelength >= 510) && (wavelength < 580)){
        red = (wavelength - 510) / (580 - 510);
        green = 1.0;
        blue = 0.0;
    }else if((wavelength >= 580) && (wavelength < 645)){
        red = 1.0;
        green = -(wavelength - 645) / (645 - 580);
        blue = 0.0;
    }else if((wavelength >= 645) && (wavelength < 781)){
        red = 1.0;
        green = 0.0;
        blue = 0.0;
    }else{
        red = 0.0;
        green = 0.0;
        blue = 0.0;
    }

    // Let the intensity fall off near the vision limits

    if((wavelength >= 380) && (wavelength < 420)){
        factor = 0.3 + 0.7*(wavelength - 380) / (420 - 380);
    }else if((wavelength >= 420) && (wavelength < 701)){
        factor = 1.0;
    }else if((wavelength >= 701) && (wavelength < 781)){
        factor = 0.3 + 0.7 * (780 - wavelength) / (780 - 700);
    }else{
        factor = 0.0;
    }

    var gamme = 0.80;
    var intensityMax = 255;

    return{
        type: eColourType.RGB,
        R: (red   === 0.0) ? 0 : Math.round(intensityMax * Math.pow(red * factor, gamme)),
        G: (green === 0.0) ? 0 : Math.round(intensityMax * Math.pow(green * factor, gamme)),
        B: (blue  === 0.0) ? 0 : Math.round(intensityMax * Math.pow(blue * factor, gamme))
    }
};

module.exports = convert;