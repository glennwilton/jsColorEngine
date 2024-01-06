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

var defs = require('./def');
var eIntent = defs.eIntent;
var eColourType = defs.eColourType;

/**
 * @typedef {object} _cmsWhitePoint
 * @property {string} desc
 * @property {number} X
 * @property {number} Y
 * @property {number} Z
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
 * @typedef {object} _cmsXYZ
 * @property {number} type eColourType
 * @property {number} X
 * @property {number} Y
 * @property {number} Z
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

function roundN(n , places) {
    var p = Math.pow(10, places)
    return Math.round(n * p) / p;
}

var convert = {};

convert.intent2String = function(intent){
    switch(intent){
        case eIntent.perceptual: return 'Perceptual';
        case eIntent.relative: return 'Relative';
        case eIntent.saturation: return 'Saturation';
        case eIntent.absolute: return 'Absolute';
    }
    return 'Unknown'
};

/**
 * ChromaticAdaption
 */

convert.BradfordMtxAdapt={
    m00 :  0.8951,
    m01 : -0.7502,
    m02 :  0.0389,
    m10 :  0.2664,
    m11 :  1.7135,
    m12 : -0.0685,
    m20 : -0.1614,
    m21 :  0.0367,
    m22 :  1.0296
};

convert.BradfordMtxAdaptInv={
    m00 :  0.9869929,
    m01 :  0.4323053,
    m02 : -0.0085287,
    m10 : -0.1470543,
    m11 :  0.5183603,
    m12 :  0.0400428,
    m20 :  0.1599627,
    m21 :  0.0492912,
    m22 :  0.9684867
};


convert.cmsColor2String = function(color, precession){

    if(typeof precession === 'undefined'){
        precession = 4;
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
                cols.push(props[i] + ': ' + roundN(obj[props[i]], precession));
            } else {
                cols.push( roundN(obj[props[i]], precession));
            }
        }
        return title + ': ' + cols.join(', ');
    }
};


/**
 *
 * @param  {_cmsWhitePoint} whitePoint
 * @returns {string}
 */
convert.whitepoint2String = function(whitePoint){
    return '(White ' + whitePoint.desc + ' X' + whitePoint.X.toFixed(4) + ' Y' + whitePoint.Y.toFixed(4) + ' Z' + whitePoint.Z.toFixed(4) + ')';
};


/**
 * XYZ 0.0 - 1.0
 * @param {number} X
 * @param {number} Y
 * @param {number} Z
 * @param {_cmsWhitePoint=} whitePoint
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
 * @param {number} L  0.0 - 100.0
 * @param {number} a range not specified
 * @param {number} b range not specified
 * @param {_cmsWhitePoint=} whitePoint Defaults to D50
 * @param {boolean=} rangeCheck
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
 *
 * @param {number} L
 * @param {number} c
 * @param {number} h
 * @param {_cmsWhitePoint=} whitePoint Defaults to D50
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
 * @param {number} g 0-100
 * @param {boolean=} rangeCheck
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
 * @param {number} a 0-100
 * @param {number} b 0-100
 * @param {boolean=} rangeCheck
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
 * @param rgb
 * @returns {string}
 */
convert.RGB2Hex = function(rgb) {
    return "#" + ((1 << 24) + (rgb.R << 16) + (rgb.G << 8) + rgb.B | 0).toString(16).slice(1);
};

/**
 *
 * @param {number} r 0-255
 * @param {number} g 0-255
 * @param {number} b 0-255
 * @param {boolean=} rangeCheck
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
 * Note that normal range is 0.0 to 1.0 but can be outside that range - outside gamut
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
 *
 * @param {number} x
 * @param {number} y
 * @param {number} Y
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

/**
 * WhitePoints
 * @param {string} whitepointDescription
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

/**
 *
 * @param {_cmsXYZ} cmsXYZ
 * @param  {_cmsWhitePoint} whitePoint
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
 *
 * @param {_cmsXYZ} XYZ
 * @param {_cmsWhitePoint} whitePoint
 * @returns {*}
 */
convert.XYZ2Lab = function(XYZ, whitePoint)
{
    var kE = 216.0 / 24389.0;
    var kK = 24389.0 / 27.0;
    //var kKE = 8.0;

    var xr = XYZ.X / whitePoint.X;
    var yr = XYZ.Y / whitePoint.Y;
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
 * XYZ has no whitePoint, so this convert from Lab @ whitePoint to XYZ
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
        Y: yr * whitePoint.Y,
        Z: zr * whitePoint.Z,
        type: eColourType.XYZ
    };
};

/**
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
 *
 * @param {_cmsLCH} cmsLCHab
 * @returns {_cmsLab}
 */
convert.LCH2Lab = function(cmsLCHab)
{
    var a = cmsLCHab.C * Math.cos(cmsLCHab.H * Math.PI / 180.0);
    var b = cmsLCHab.C * Math.sin(cmsLCHab.H * Math.PI / 180.0);
    return this.Lab(cmsLCHab.L,a,b);
};

/**
 * Converts from RGB to Lab, Is the
 * @param {_cmsRGB} rgb
 * @param {Profile} RGBProfile
 * @param {_cmsWhitePoint=} destWhitepoint
 * @returns {_cmsLab}
 */
convert.RGB2Lab = function(rgb, RGBProfile , destWhitepoint){
    var cmsXYZ;
    // do adapatation here if RGBProfile !== Lab Profile
    if(destWhitepoint){
        cmsXYZ = this.RGBf2XYZ({Rf:rgb.R/255, Gf:rgb.G/255, Bf:rgb.B/255}, RGBProfile , destWhitepoint);
        if(!this.compareWhitePoints(destWhitepoint, RGBProfile.mediaWhitePoint)){
            cmsXYZ = this.adaptation(cmsXYZ, RGBProfile.mediaWhitePoint, destWhitepoint)
        }
    } else {
        // assume whitePoint of the profile
        destWhitepoint = RGBProfile.mediaWhitePoint;
        cmsXYZ = this.RGBf2XYZ({Rf:rgb.R/255, Gf:rgb.G/255, Bf:rgb.B/255}, RGBProfile , destWhitepoint);
    }

    return this.XYZ2Lab(cmsXYZ, destWhitepoint);
};

// Takes RGB in 0-255 range and converts to XYZ
/**
 *
 * @param {_cmsRGB} rgb
 * @param {Profile} RGBprofile
 * @param {_cmsWhitePoint} XYZRefWhite
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

// converts XYZ to RGB in 0-255 range
/**
 *
 * @param {_cmsXYZ} XYZ
 * @param {_cmsWhitePoint} XYZRefWhite
 * @param {Profile} RGBProfile
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
 *
 * @param {_cmsLab} cmsLab
 * @param {Profile} RGBProfile
 * @param {boolean=} clip
 * @returns {_cmsRGBf}
 */
convert.Lab2RGBf = function(cmsLab, RGBProfile, clip){
    var XYZ = this.Lab2XYZ(cmsLab);
    return this.XYZ2RGBf(XYZ, cmsLab.whitePoint, RGBProfile, clip);
};

/**
 *
 * @param  {_cmsRGBf} rgbf
 * @returns {_cmsRGB}
 */
convert.RGB2byte = function(rgbf){
    return this.RGB( rgbf.Rf * 255, rgbf.Gf * 255, rgbf.Bf * 255);
};

/**
 *
 * @param {_cmsRGB} rgb
 * @returns {string}
 */
convert.cmsRGB2Hex = function(rgb){
    var R =(rgb.R<=15 ? '0' + rgb.R.toString(16) : rgb.R.toString(16));
    var G =(rgb.G<=15 ? '0' + rgb.G.toString(16) : rgb.G.toString(16));
    var B =(rgb.B<=15 ? '0' + rgb.B.toString(16) : rgb.B.toString(16));
    return '#' + R + G + B;
};

/**
 *
 * @param {_cmsXYZ | object}  XYZ
 * @param {_cmsWhitePoint} sourceWhite
 * @param {_cmsWhitePoint} destWhite
 * @returns {_cmsXYZ}
 */
convert.adaptation = function(XYZ, sourceWhite, destWhite){
    var MtxAdaptMa = this.BradfordMtxAdapt;
    var MtxAdaptMaI  = this.BradfordMtxAdaptInv;

    //http://www.brucelindbloom.com/index.html?Eqn_ChromAdapt.html

    // Transform RefWhite (SOURCE)
    var As = (sourceWhite.X * MtxAdaptMa.m00) + (sourceWhite.Y * MtxAdaptMa.m10) + (sourceWhite.Z * MtxAdaptMa.m20);
    var Bs = (sourceWhite.X * MtxAdaptMa.m01) + (sourceWhite.Y * MtxAdaptMa.m11) + (sourceWhite.Z * MtxAdaptMa.m21);
    var Cs = (sourceWhite.X * MtxAdaptMa.m02) + (sourceWhite.Y * MtxAdaptMa.m12) + (sourceWhite.Z * MtxAdaptMa.m22);

    // Transform Space _cmsWhitePoint (DEST)
    var Ad = (destWhite.X * MtxAdaptMa.m00) + (destWhite.Y * MtxAdaptMa.m10) + (destWhite.Z * MtxAdaptMa.m20);
    var Bd = (destWhite.X * MtxAdaptMa.m01) + (destWhite.Y * MtxAdaptMa.m11) + (destWhite.Z * MtxAdaptMa.m21);
    var Cd = (destWhite.X * MtxAdaptMa.m02) + (destWhite.Y * MtxAdaptMa.m12) + (destWhite.Z * MtxAdaptMa.m22);

    // Transform from XYZ into a cone response domain, (ρ, γ, β) using the Matrix
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
 *
 * @param {_cmsXYZ}  XYZ
 * @param {_cmsWhitePoint} XYZRefwhite
 * @param {Profile} RGBProfile
 * @param {boolean} clip
 * @returns {number[]}
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
 *
 * @param {_cmsXYZ}  XYZ
 * @param {_cmsWhitePoint} XYZRefwhite
 * @param {Profile} RGBProfile
 * @param {boolean=} clip
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
 * Converts from RGBf (0-1) to XYZ, if the XYZWhite
 * @param {number[]} device
 * @param {Profile} RGBProfile
 * @param {_cmsWhitePoint}  XYZRefWhite
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
 *
 * @param {_cmsRGBf} rgbf
 * @param {Profile} RGBProfile
 * @param {_cmsWhitePoint} XYZRefWhite
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
 *
 * @param {_cmsLab} cmsLab
 * @param {Profile} RGBProfile
 * @param {number=} decimals
 * @returns {_cmsRGB}
 */
convert.Lab2RGB = function(cmsLab, RGBProfile, decimals){
    decimals = decimals || 0;
    var RGBDevice = this.Lab2RGBDevice(cmsLab, RGBProfile);
    return {
        R : roundN(RGBDevice[0]*255, decimals),
        G : roundN(RGBDevice[0]*255, decimals),
        B : roundN(RGBDevice[0]*255, decimals),
        type: eColourType.RGB
    };
};

/**
 *
 * @param {_cmsLab} cmsLab
 * @returns {{R: number, G: number, B: number}}
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
 *
 * @param {_cmsLab | _cmsLabD50} cmsLab
 * @param {Profile} RGBProfile
 * @returns {_Device}
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

convert.compareWhitePoints = function(white1, white2, tolerance){
    tolerance = tolerance || 0.001;
    if( Math.abs(white1.X - white2.X) > tolerance) {return false;}
    if( Math.abs(white1.Y - white2.Y) > tolerance) {return false;}
    return Math.abs(white1.Z - white2.Z) <= tolerance;
};

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
    var yr = XYZ.Y / destWhitePoint.Y;
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
 * Covnerts RGB to Lab
 * @param {_cmsRGBf} RGBf
 * @param {Profile} RGBProfile
 * @param {_cmsWhitePoint=} destWhitePoint
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
    var yr = XYZ.Y ;
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
 *
 * @param {number} c - Colour Value
 * @param {number} Gamma
 * @returns {number}
 */
convert.gamma = function(c, Gamma){
    return Math.pow(c, Gamma);
};

/**
 *
 * @param {number} c - Colour Value
 * @param {number} Gamma
 * @returns {number}
 */
convert.gammaInv = function(c, Gamma){
    return Math.pow(c , 1/ Gamma);
};

/**
 *
 * @param {number} c - Colour Value
 * @returns {number}
 */
convert.sRGBGamma = function(c){
     return (c <= 0.0031308) ? (c * 12.92) : (1.055 * Math.pow(c, 1.0 / 2.4) - 0.055);
};
/**
 *
 * @param {number} c - Colour Value
 * @returns {number}
 */
convert.sRGBGammaInv = function(c){
    return ((c <= 0.04045) ? (c / 12.92) : Math.pow((c + 0.055) / 1.055, 2.4));
};

//m[row][column]
//  00   01    02
//  10   11    12
//  20   21    22
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

    profile.RGBMatrix.matrixV4 = {
        m00 : sR * m.m00,    m01 : sG * m.m01,   m02 : sB * m.m02,
        m10 : sR * m.m10,    m11 : sG * m.m11,   m12 : sB * m.m12,
        m20 : sR * m.m20,    m21 : sG * m.m21,   m22 : sB * m.m22
    };

    profile.RGBMatrix.XYZMatrix = {
        m00 : profile.rgb.rXYZ.X,   m01 : profile.rgb.gXYZ.X,  m02 : profile.rgb.bXYZ.X,
        m10 : profile.rgb.rXYZ.Y,   m11 : profile.rgb.gXYZ.Y,  m12 : profile.rgb.bXYZ.Y,
        m20 : profile.rgb.rXYZ.Z,   m21 : profile.rgb.gXYZ.Z,  m22 : profile.rgb.bXYZ.Z,
    };

    profile.RGBMatrix.XYZMatrixInv = this.invertMatrix(profile.RGBMatrix.XYZMatrix);
    profile.RGBMatrix.matrixInv = this.invertMatrix(profile.RGBMatrix.matrixV4);
};

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

    convert.matrix2Object = function(matrixArray) {
        return {
            m00: matrixArray[0][0], m01: matrixArray[0][1], m02: matrixArray[0][2],
            m10: matrixArray[1][0], m11: matrixArray[1][1], m12: matrixArray[1][2],
            m20: matrixArray[2][0], m21: matrixArray[2][1], m22: matrixArray[2][2]
        };
    }
    convert.objectToMatrix = function(matrixObject) {
        return [
            [matrixObject.m00, matrixObject.m01, matrixObject.m02],
            [matrixObject.m10, matrixObject.m11, matrixObject.m12],
            [matrixObject.m20, matrixObject.m21, matrixObject.m22]
        ];
    }

    convert.multiplyMatrices = function(matrixA, matrixB) {
        return this.matrix2Object(this.multiplyMatricesArray(this.objectToMatrix(matrixA), this.objectToMatrix(matrixB)));
    }

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























/**
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
 * A technical committee of the CIE (TC 1-29) published an equation in 1995 called CIE94.
 * The equation is similar to CMC but the weighting functions are largely based on RIT/DuPont
 * tolerance data derived from automotive paint experiments where sample surfaces are smooth.
 * i t also has ratios, labeled kL (lightness) and Kc (chroma) and the commercial factor (cf)
 * but these tend to be preset in software and are not often exposed for the user.
 * @param {_cmsLab}  Lab1 Reference
 * @param {_cmsLab}  Lab2 Sample
 * @param {{boolean}} IsTextiles
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
 * Delta-E 2000 is the first major revision of the dE94 equation.
 * Unlike dE94, which assumes that L* correctly reflects the perceived differences in lightness,
 * dE2000 varies the weighting of L* depending on where in the lightness range the color falls.
 * dE2000 is still under consideration and does not seem to be widely supported in graphics arts applications.
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
 * In 1984 the CMC (Color Measurement Committee of the Society of Dyes and Colourists of Great Britain)
 * developed and adopted an equation based on LCH numbers. Intended for the textiles industry,
 * CMC l:c allows the setting of lightness (l) and chroma (c) factors.
 * As the eye is more sensitive to chroma, the default ratio for l:c is 2:1 allowing for 2x the difference
 * in lightness than chroma (numbers). There is also a 'commercial factor' (cf) which allows an overall
 * varying of the size of the tolerance region according to accuracy requirements.
 * A cf=1.0 means that a delta-E CMC value <1.0 is acceptable.
 * @param {_cmsLab}  Lab1 Reference
 * @param {_cmsLab}  Lab2 Sample
 * @param {number} [lightnessFactor=2]
 * @param {number} [chromaFactor=2]
 *
 * acceptability are CMC(2:1)
 and for perceptibility are CMC(1:1).
 *
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

//http://www.efg2.com/Lab/ScienceAndEngineering/Spectra.htm
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