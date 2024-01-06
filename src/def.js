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


/**
 * @typedef {object} _cmsWhitePoint
 * @property {string} desc
 * @property {number} X
 * @property {number} Z
 */

/**
 * @typedef {object} _cmsCMYK
 * @property {number} type eColourType
 * @property {number} C 0 - 100
 * @property {number} M 0 - 100
 * @property {number} Y 0 - 100
 * @property {number} K 0 - 100
 */

/**
 * @typedef {object} _cmsCMYKf
 * @property {number} type eColourType
 * @property {number} Cf 0.0 - 1.0
 * @property {number} Mf 0.0 - 1.0
 * @property {number} Yf 0.0 - 1.0
 * @property {number} Kf 0.0 - 1.0
 */

/**
 * @typedef {object} _cmsXYZ
 * @property {number} type eColourType
 * @property {number} X 0 - 1
 * @property {number} Y 0 - 1
 * @property {number} Z 0 - 1
 */

/**
 * @typedef {object} _cmsLab
 * @property {number} type eColourType
 * @property {number} L 0 - 100
 * @property {number} a -128 - 127
 * @property {number} b -128 - 127
 * @property {_cmsWhitePoint} whitePoint
 */

/**
 * @typedef {object} _cmsLabD50
 * @property {number} L 0 - 100
 * @property {number} a -128 - 127
 * @property {number} b -128 - 127
 */

/**
 * @typedef {object} _cmsLCH
 * @property {number} type eColourType
 * @property {number} L 0 - 100
 * @property {number} C 0 - 100
 * @property {number} H 0 - 360
 * @property {_cmsWhitePoint} whitePoint
 */

/**
 * @typedef {object} _cmsRGB
 * @property {number} type eColourType
 * @property {number} R 0 - 255
 * @property {number} G 0 - 255
 * @property {number} B 0 - 255
 */

/**
 * @typedef {object} _cmsRGBf
 * @property {number} type eColourType
 * @property {number} Rf 0.0 - 1.0
 * @property {number} Gf 0.0 - 1.0
 * @property {number} Bf 0.0 - 1.0
 */

/**
 * @typedef {object} _cmsDuo
 * @property {number} type eColourType
 * @property {number} a 0.0 - 100
 * @property {number} b 0.0 - 100
 */

/**
 * @typedef {object} _cmsDuof
 * @property {number} type eColourType
 * @property {number} af 0.0 - 1.0
 * @property {number} bf 0.0 - 1.0
 */



/**
 * @typedef {object} _cmsGray
 * @property {number} type eColourType
 * @property {number} G 0.0 - 1.0
 */


/**
 * @typedef {number[]} _Device Array of n-Channel floats with a range of 0.0 to 1.0
 * @typedef {number[]} _PCS Array of n-Channel 16bit integers data with a range of 0 to 65535
 * @typedef {number[]} _PCSf Array of n-Channel floats of with a range of 0.0 to 1.0
 * @typedef {number} stageEncoding
 **/

/**
 * @typedef {object} _Stage
 * @property {stageEncoding} inputEncoding
 * @property {function} funct
 * @property {stageEncoding} outputEncoding
 * @property {object} stageData
 * @property {string} stageName
 * @property {string} debugFormat
 */

var defs = {
    eColourType : {
        None:0,
        XYZ:1,
        Lab:2,
        LCH:3,
        Gray:4,
        RGB:5,
        CMYK:6,
        custom:7,
        RGBf:8,
        CMYKf:9,
        Spectrum: 10,
        Greyf: 11,
        Duo: 12,
        Duof: 13,
        xyY: 14,
    },
    eProfileType: {
        Lab: 0,
        RGBMatrix: 1,
        RGBLut: 2,
        CMYK: 3,
        Gray: 4,
        Duo: 5,
        XYZ: 6,
    },
    eIntent: {
        perceptual: 0,
        relative: 1,
        saturation: 2,
        absolute: 3
    },
    intent2String: function (intent) {
        return ['Perceptual', 'Relative', 'Saturation', 'Absolute'][intent] || 'unknown';
    },
    illuminant:{
        a:   {desc:'a',    Y: 1.0, X: 1.09850, Z: 0.35585},
        b:   {desc: 'b',   Y: 1.0, X: 0.99072, Z: 0.85223},
        c:   {desc: 'c',   Y: 1.0, X: 0.98074, Z: 1.18232},
        d50: {desc: 'd50', Y: 1.0, X: 0.96422, Z: 0.82521},
        d55: {desc: 'd55', Y: 1.0, X: 0.95682, Z: 0.92149},
        d65: {desc: 'd65', Y: 1.0, X: 0.95047, Z: 1.08883},
        d75: {desc: 'd75', Y: 1.0, X: 0.94972, Z: 1.22638},
        e:   {desc: 'e',   Y: 1.0, X: 1.00000, Z: 1.00000},
        f2:  {desc: 'f2',  Y: 1.0, X: 0.99186, Z: 0.67393},
        f7:  {desc: 'f7',  Y: 1.0, X: 0.95041, Z: 1.08747},
        f11: {desc: 'f11', Y: 1.0, X: 1.00962, Z: 0.64350}
    },
    encoding:{
        device: 0, // 0.0 to 1.0 device colour such as grey, rgb, cmyk ir whatever
        PCSv2: 1, // V2 PCS 0.0 to 1.0 based on 16bit encoding where 0xFF00 = 1.0
        PCSv4: 2, // V4 PCS 0.0 to 1.0 based on 16bit encoding where 0xFFFF = 1.0
        PCSXYZ: 3,
        LabD50 : 3,
        cmsLab : 4,
        cmsRGB: 5,
        cmsCMYK: 6,
        cmsXYZ: 7
    },
    encodingStr: [
        'device',
        'PCSv2',
        'PCSv4',
        'PCSXYZ',
        'LabD50',
        'cmsLab',
        'cmsRGB',
        'cmsCMYK',
        'cmsXYZ'
    ]
};

module.exports = defs;