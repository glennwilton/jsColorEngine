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

const convert = require('./convert');
const colorEngineDef = require('./def');
const eIntent = colorEngineDef.eIntent;
const eProfileType = colorEngineDef.eProfileType;
const decode = require('./decodeICC');

/**
 * Loads and Decodes an ICC Profile, it does not perform any color conversions
 * It has several features
 *
 * 1. Decodes the ICC Profile from a binary Uint8Array, or a URL, or a base64 encoded string
 * 2. Creates virtual profiles in memory, i.e. sRGB, Adobe RGB, Lab D50, Lab D65
 * 3. Supports ICC Profile version 2 and 4
 * 4. Supports RGB, Gray, Lab and CMYK profiles
 * 5. RGB Profiles can be Matrix based or LUT based
 *
 * @param dataOrUrl     - Uint8Array
 *                      - String:  'data:base64...' - load from base64 encoded string
 *                      - String:  'file:filename'   - load from local drive using property File API
 *                      - String:  'http://...'      - load via XHR HTTP
 *                      - String:  '*name'           - create a virtual profile in memory
 *                                 -'*sRGB'          - sRGB
 *                                 -'*AdobeRGB'      - Adobe RGB (1998)
 *                                 -'*AppleRGB'      - Apple RGB
 *                                 -'*ColorMatchRGB' - ColorMatch RGB
 *                                 -'*ProPhotoRGB'   - ProPhoto RGB
 *                                 -'*Lab'           - Lab D50
 *                                 -'*LabD50'        - Lab D50
 *                                 -'*LabD65'        - Lab D65
 *
 * @param afterLoad     - function(profile) - callback function after the profile has been loaded
 * @constructor
 */

class Profile {

    constructor(dataOrUrl, afterLoad) {
        // this.hasFileAPI = (window.File && window.FileReader && window.FileList && window.Blob);
        this.loaded = false;
        this.loadError = false;
        this.type = 0;
        this.name = '';
        this.header = {};
        this.intent = 0;
        this.tags = [];
        this.description = '';
        this.tagDescription = '';
        this.copyright = '';
        this.technology = '';
        this.viewingConditions = '';
        this.characterizationTarget = '';
        this.mediaWhitePoint = null;
        this.PCSEncode = 2;
        this.PCSDecode = 2;
        this.PCS8BitScale = 0;
        this.version = 0;
        this.pcs = false;
        this.blackPoint = null;
        this.luminance = null;
        this.chromaticAdaptation = null;
        this.unsuportedTags = [];
        this.Gray = {
            kTRC: null,
            inv_kTRC: null,
        };
        this.rgb = {
            rTRC: null,
            rTRCInv: null,

            gTRC: null,
            gTRCInv: null,

            bTRC: null,
            bTRCInv: null,

            rXYZ: null,
            gXYZ: null,
            bXYZ: null
        };
        this.RGBMatrix = {
            gamma: 0,
            cRx: 0,
            cRy: 0,
            cGx: 0,
            cGy: 0,
            cBx: 0,
            cBy: 0
        };

        this.PCSWhitepoint = convert.d50;
        this.outputChannels = 0;
        this.lastError = {err: 0, text: 'No Error'};

        // These are floating point but more complicated
        // So not used yet
        this.B2D = [null, null, null, null];
        this.D2B = [null, null, null, null];

        this.A2B = [null, null, null];
        this.B2A = [null, null, null];

        this.absoluteAdaptationIn = {
            Xa: 1,
            Ya: 1,
            Za: 1
        };

        this.absoluteAdaptationOut = {
            Xa: 1,
            Ya: 1,
            Za: 1
        };

        if (dataOrUrl) {
            this.load(dataOrUrl, afterLoad);
        }
    };

    loadPromise(dataOrUrl) {
        return new Promise((resolve, reject) => {
            this.load(dataOrUrl, (loaded) => {
                if (loaded) {
                    resolve(loaded);
                } else {
                    reject(new Error("Profile failed to load"));
                }
            });
        });
    }

    /**
     *
     * @param dataOrUrl     - Uint8Array                - Load from binary Uint8Array
     *                      - String:  'file:filename'  - load from local drive in node.js
     *                      - String:  '*name'          - create a virtual profile
     *                      - String:  'data:base64...' - load from base64 encoded string
     *                      - String:  'http://...'     - load via XHR HTTP
     * @param afterLoad
     */
    load(dataOrUrl, afterLoad) {
        this.loaded = false;
        this.loadError = false;
        if (Object.prototype.toString.call(dataOrUrl) == '[object Uint8Array]') {
            this.loadBinary(dataOrUrl, afterLoad);
        } else if (dataOrUrl.substring(0, 1) === '*') {
            this.loadVirtualProfile(dataOrUrl, afterLoad);
        } else if (dataOrUrl.substring(0, 5).toLowerCase() === 'file:') {
            this.loadFile(dataOrUrl, afterLoad);
        } else if (dataOrUrl.substring(0, 5).toLowerCase() === 'data:') {
            this.loadBase64(dataOrUrl, afterLoad)
        } else {
            this.loadURL(dataOrUrl, afterLoad);
        }
    };

    loadBinary(binary, afterLoad, searchForProfile) {
        this.loaded = this.readICCProfile(binary, searchForProfile);
        this.loadError = !this.loaded;
        if(typeof afterLoad === 'function'){
            afterLoad(this);
        }
    };

    loadFile(filename, afterLoad) {
        if(filename.substring(0, 5).toLowerCase() === 'file:'){
            filename = filename.substring(5, filename.length);
        }

        var file = readBinaryFile(filename);
        if (file.err === 0) {
            this.loaded = this.readICCProfile(file.binary);
            this.loadError = !this.loaded;
        } else {
            this.loadError = true;
            this.lastError = {
                err: file.err,
                text: file.errorString || file.err
            };
        }

        if(typeof afterLoad === 'function'){
            afterLoad(this);
        }
    };

    loadBase64(base64, afterLoad) {
        if(base64.substring(0, 5).toLowerCase() === 'data:'){
            base64 = base64.substring(5, base64.length);
        }

        var data = base64ToUint8Array(base64);
        this.loaded = this.readICCProfile(data);
        this.loadError = !this.loaded;
        if(typeof afterLoad === 'function'){
            afterLoad(this);
        }
    };

    loadURL(url, afterLoad) {
        var _this = this;
        XHRLoadBinary(url, function (result, errorString) {
            _this.lastError = {err: errorString === '' ? 0 : -1, text: errorString};
            if (result) {
                _this.loaded = _this.readICCProfile(result);
                _this.loadError = !_this.loaded;
            } else {
                _this.loaded = false;
                _this.loadError = true;
            }
            if(typeof afterLoad === 'function'){
                afterLoad(_this);
            }
        });
    };

    loadVirtualProfile(name, afterLoad) {
        if(name.substring(0, 1) === '*'){
            name = name.substring(1, name.length);
        }
        this.loaded = this.createVirtualProfile(name);
        this.loadError = !this.loaded;
        if(typeof afterLoad === 'function'){
            afterLoad(this);
        }
    };

    createVirtualProfile(name) {

        // Virtual Profiles are this.version = v4 so that by default the Transform will output PCS V4 encoded date
        // http://www.brucelindbloom.com/index.html?WorkingSpaceInfo.html
        // https://infoscience.epfl.ch/record/34089/files/SusstrunkBS99.pdf?version=3
        // http://www.babelcolor.com/index_htm_files/A%20review%20of%20RGB%20color%20spaces.pdf

        // Set for RGB, Will change if we are a Lab profile
        this.outputChannels = 3;
        this.version = 4;
        this.pcs = 'XYZ';
        this.colorSpace = 'RGB';
        this.header = {
            profileSize: 0,
            cmmType: 0,
            version: 4,
            pClass: 'mntr',
            space: 'rgb',
            pcs: 'XYZ',
            date: new Date(),
            signature: '',
            platform: '',
            flags: 0,
            attributes: 0,
            intent: 3,
            PCSilluminant: convert.d50
        };

        switch (String(name).replace(' ', '').toLowerCase()) {
            case 'labd50': // LabD50
            case 'lab': // LabD50
                this.type = eProfileType.Lab;
                this.name = this.description = 'Lab D50 Profile';
                this.PCSWhitepoint = convert.d50;
                this.mediaWhitePoint = convert.d50;
                this.pcs = 'LAB';
                this.colorSpace = 'LAB';
                this.header = {
                    profileSize: 0,
                    cmmType: 0,
                    version: 4,
                    pClass: 'abst',
                    space: 'Lab',
                    pcs: 'LAB',
                    date: new Date(),
                    signature: '',
                    platform: '',
                    flags: 0,
                    attributes: 0,
                    intent: 3,
                    PCSilluminant: convert.d50
                }
                return true;

            case 'labd65': // LabD50
                this.type = eProfileType.Lab;
                this.name = this.description = 'Lab D65 Profile';
                this.PCSWhitepoint = convert.d50;
                this.mediaWhitePoint = convert.d65;
                this.pcs = 'LAB';
                this.colorSpace = 'LAB';
                this.header = {
                    profileSize: 0,
                    cmmType: 0,
                    version: 4,
                    pClass: 'abst',
                    space: 'Lab',
                    pcs: 'LAB',
                    date: new Date(),
                    signature: '',
                    platform: '',
                    flags: 0,
                    attributes: 0,
                    intent: 3,
                    PCSilluminant: convert.d50
                }
                return true;

            case 'srgb':
                this.type = eProfileType.RGBMatrix;
                this.name = 'sRGB';
                this.description = "RGB is a standard RGB color space created cooperatively by HP and Microsoft in 1996 for use on monitors, printers and the Internet<br><br>Note that sRGB's small Gamut is not suitable for graphic production.<br><br>Encompasses roughly 35% of the visible colors specified by the Lab color space";
                this.PCSWhitepoint = convert.d50;
                this.mediaWhitePoint = convert.d65;
                this.RGBMatrix = createMatrix(2.2, [0.64, 0.33, 0.30, 0.60, 0.15, 0.06], true);
                convert.computeMatrix(this);
                return true;

            case 'adobe1998':
            case 'adobergb':
            case 'adobe1998rgb':
                this.type = eProfileType.RGBMatrix;
                this.name = 'Adobe RGB (1998)';
                this.description = 'Developed by Adobe Systems, Inc. in 1998. It was designed to encompass most of the colors achievable on CMYK color printers, but by using RGB primary colors on a device such as a computer display. The Adobe RGB (1998) improves upon the gamut of the sRGB color space, primarily in cyan-green hues<br>Encompasses roughly 50% of the visible colors specified by the Lab color space';
                this.PCSWhitepoint = convert.d50;
                this.mediaWhitePoint = convert.d65;
                this.RGBMatrix = createMatrix(2.2, [0.64, 0.33, 0.21, 0.71, 0.15, 0.06], false);
                convert.computeMatrix(this);
                return true;

            case 'apple':
            case 'applergb':
                this.type = eProfileType.RGBMatrix;
                this.name = 'Apple RGB';
                this.description = 'Apple RGB is based on the classic Apple 13" RGB monitor. Because of its popularity and similar Trinitronbased monitors that followed, many key publishing applications, including Adobe Photoshop and Illustrator, used it as the default RGB space in the past.<br>Encompasses roughly 33.5% of the visible colors specified by the Lab color space';
                this.PCSWhitepoint = convert.d50;
                this.mediaWhitePoint = convert.d65;
                this.RGBMatrix = createMatrix(1.8, [0.6250, 0.3400, 0.2800, 0.5950, 0.1550, 0.0700], false);
                convert.computeMatrix(this);
                return true;

            case 'colormatchrgb':
            case 'colormatch':
                this.type = eProfileType.RGBMatrix;
                this.name = 'ColorMatch RGB';
                this.description = 'An RGB profile with a D50 whitepoint used for prepress<br>Encompasses roughly 35.2% of the visible colors specified by the Lab color space';
                this.PCSWhitepoint = convert.d50;
                this.mediaWhitePoint = convert.d50;
                this.RGBMatrix = createMatrix(1.8, [0.6300, 0.3400, 0.2950, 0.6050, 0.1500, 0.0750], false);
                convert.computeMatrix(this);
                return true;

            case 'prophoto':
            case 'prophotorgb':
                this.type = eProfileType.RGBMatrix;
                this.name = 'ProPhoto RGB';
                this.description = 'The ProPhoto RGB color space, also known as ROMM RGB (Reference Output Medium Metric), is an output referred RGB color space developed by Kodak. It offers an especially large gamut designed for use with photographic output in mind.<br>Encompasses roughly 91.2% of the visible colors specified by the Lab color space';
                this.PCSWhitepoint = convert.d50;
                this.mediaWhitePoint = convert.d50;
                this.RGBMatrix = createMatrix(1.8, [0.7347, 0.2653, 0.1596, 0.8404, 0.0366, 0.0001], false);
                convert.computeMatrix(this);
                return true;

        }
        return false;

        function createMatrix(gamma, primaries, isSRGB) {
            return {
                gamma: gamma,
                issRGB: isSRGB === true, // uses special sRGB Gamma formula
                cRx: primaries[0],
                cRy: primaries[1],
                cGx: primaries[2],
                cGy: primaries[3],
                cBx: primaries[4],
                cBy: primaries[5]
            };
        }
    };



    readICCProfile(data, searchForProfile) {
        var _this = this;
        var start = 0;
        if (searchForProfile){
            //Search for text "ICC_PROFILE" in an Image
            var ICC_PROFILE = [73 ,67 ,67 ,95 ,80 ,82 ,79 ,70 ,73 ,76 ,69 ];
            start = scan(data,0, ICC_PROFILE);
            if(start === -1){
                return false;
            }
        }

        // Search for text "acsp" in the profile header
        var acsp = [97, 99, 115, 112];
        var ascpPos = scan(data, start, acsp);
        if (ascpPos === -1) {
            return false;
        }

        // extract the core profile data
        var result = this.decodeFile(data);

        if (result === true) {
            // update whitepoint
            this.PCSWhitepoint = convert.getWhitePointFromIlluminant(this.header.PCSilluminant);

            // this.mediaWhitePoint = convert.getWhitePointFromIlluminant(this.mediaWhitePoint);

            // pre-calculate adaptation matrixV4 values
            this.absoluteAdaptationIn = {
                Xa: this.mediaWhitePoint.X / this.header.PCSilluminant.X,
                Ya: this.mediaWhitePoint.Y / this.header.PCSilluminant.Y,
                Za: this.mediaWhitePoint.Z / this.header.PCSilluminant.Z
            };

            this.absoluteAdaptationOut = {
                Xa: this.header.PCSilluminant.X / this.mediaWhitePoint.X,
                Ya: this.header.PCSilluminant.Y / this.mediaWhitePoint.Y,
                Za: this.header.PCSilluminant.Z / this.mediaWhitePoint.Z
            };

            //TODO check for required tags for all profile types...

            // determine the encoding on the A2b Tables
            //this.PCSDecode = this.findA2BEncoding(this.A2B[eIntent.relative]);
            if (_this.header.space === 'RGB ' &&
                _this.A2B[eIntent.relative] === null &&
                _this.B2A[eIntent.relative] === null &&
                _this.rgb.gXYZ &&
                _this.rgb.rXYZ &&
                _this.rgb.bXYZ &&
                _this.rgb.rTRC &&
                _this.rgb.gTRC &&
                _this.rgb.bTRC
            ) {
                // Convert to an RGBMatrix type profile.
                this.createRGBMatrix();
            }

            this.loaded = true;
            return true;
        }

        this.loaded = false;
        return false;

        function scan(outerArray, start, innerArray) {
            for (var i = start; i < outerArray.length - innerArray.length; i++) {
                var found = true;
                for (var j = 0; j < innerArray.length; j++) {
                    if (outerArray[i + j] !== innerArray[j]) {
                        found = false;
                        break;
                    }
                }
                if (found) {
                    return i;
                }
            }
            return -1;
        }
    };

    /**
     * @return {boolean}
     */
    createRGBMatrix() {
        //this.PCSWhitepoint = convert.getWhitePointFromIlluminant(this.header.PCSilluminant);
        this.PCSWhitepoint = this.header.PCSilluminant;
        var d50 = convert.d50;

        // adapt primaries from D50 as per the ICC spec to the whitepoint of the profile
        //
        //
        var rxy = convert.XYZ2xyY(convert.adaptation(this.rgb.rXYZ, d50, this.mediaWhitePoint), this.PCSWhitepoint);
        var gxy = convert.XYZ2xyY(convert.adaptation(this.rgb.gXYZ, d50, this.mediaWhitePoint), this.PCSWhitepoint);
        var bxy = convert.XYZ2xyY(convert.adaptation(this.rgb.bXYZ, d50, this.mediaWhitePoint), this.PCSWhitepoint);
        this.type = eProfileType.RGBMatrix;
        this.RGBMatrix = {
            gamma: this.rgb.rTRC.gamma,
            issRGB: (this.name.substr(0, 4) === 'sRGB'),

            cRx: rxy.x,//.round(4),
            cRy: rxy.y,//.round(4),

            cGx: gxy.x,//.round(4),
            cGy: gxy.y,//.round(4),

            cBx: bxy.x,//.round(4),
            cBy: bxy.y //.round(4)
        };
        convert.computeMatrix(this);
    };


    decodeHeader(binary) {
        var header = {};
        header.profileSize = decode.uint32(binary, 0);
        header.cmmType = decode.chars(binary, 4, 4);
        header.version = decode.array(binary, 8, 4);
        header.pClass = decode.chars(binary, 12, 4);
        header.space = decode.chars(binary, 16, 4);
        header.pcs = decode.chars(binary, 20, 4);
        header.date = decode.array(binary, 24, 12);
        header.signature = decode.chars(binary, 36, 4);
        header.platform = decode.chars(binary, 40, 4);
        header.flags = decode.array(binary, 44, 4);
        header.attributes = decode.array(binary, 56, 8);
        header.intent = decode.uint32(binary, 64);
        header.PCSilluminant = decode.XYZNumber(binary, 68);
        return header;
    };

    decodeTags(binary) {
        var tags = [];
        var tagCount = decode.uint32(binary, 128);
        var pos = 128 + 4;
        for (var i = 0; i < tagCount; i++) {
            tags.push({
                sig: decode.chars(binary, pos, 4),
                offset: decode.uint32(binary, pos + 4),
                length: decode.uint32(binary, pos + 8)
            });
            pos += 12;
        }
        return tags;
    };

    decodeFile(binary) {
        this.header = this.decodeHeader(binary);
        this.unsuportedTags = [];

        // copy down important header values
        this.version = this.header.version[0];
        this.pcs = this.header.pcs.trim().toUpperCase();
        this.colorSpace = this.header.space.trim().toUpperCase();

        if (!(this.pcs === 'LAB' || this.pcs === 'XYZ')) {
            this.lastError = {err: 100, text: 'Unsupported PCS [' + this.pcs + ']'};
            return false;
        }

        if (!(this.version === 2 || this.version === 4)) {
            this.lastError = {err: 101, text: 'Unsupported Profile Version [' + this.version + ']'};
            return false;
        }

        switch (this.header.space) {
            case 'GRAY':
                this.outputChannels = 1;
                this.type = eProfileType.Gray;
                break;

            case '2CLR':
                this.outputChannels = 2;
                this.type = eProfileType.Duo;
                break;

            case '3CLR':
            case 'CMY ':
            case 'RGB ':
                this.outputChannels = 3;
                // test LUTs then this will change to RGBMatrix
                this.type = eProfileType.RGBLut;
                break;

            case '4CLR':
            case 'CMYK':
                this.outputChannels = 4;
                this.type = eProfileType.CMYK; // cmyk
                break;

            default:
                this.lastError = {err: 110, text: 'Unsupported Profile Colorspace [' + this.header.space + ']'};
                return false;
        }

        this.tags = this.decodeTags(binary);

        // process common tags
        for (var i = 0; i < this.tags.length; i++) {
            var tag = this.tags[i];
            switch (tag.sig) {
                case 'rXYZ':
                    this.rgb.rXYZ = decode.XYZType(binary, tag.offset);
                    break;
                case 'gXYZ':
                    this.rgb.gXYZ = decode.XYZType(binary, tag.offset);
                    break;
                case 'bXYZ':
                    this.rgb.bXYZ = decode.XYZType(binary, tag.offset);
                    break;

                case 'rTRC':
                    this.rgb.rTRC = decode.curve(binary, tag.offset);
                    this.rgb.rTRCInv = decode.curve(binary, tag.offset, true);
                    break;
                case 'gTRC':
                    this.rgb.gTRC = decode.curve(binary, tag.offset);
                    this.rgb.gTRCInv = decode.curve(binary, tag.offset, true);
                    break;
                case 'bTRC':
                    this.rgb.bTRC = decode.curve(binary, tag.offset);
                    this.rgb.bTRCInv = decode.curve(binary, tag.offset, true);
                    break;

                case 'kTRC':
                    this.Gray.kTRC = decode.curve(binary, tag.offset);
                    this.Gray.inv_kTRC = decode.curve(binary, tag.offset, true);
                    break;

                case 'wtpt':
                    this.mediaWhitePoint = decode.XYZType(binary, tag.offset);
                    break;

                case 'A2B0': //perceptual
                    this.A2B[0] = decode.lut(binary, tag.offset);
                    break;

                case 'A2B1': //relative colorimetric
                    this.A2B[1] = decode.lut(binary, tag.offset);
                    break;

                case 'A2B2': //saturation
                    this.A2B[2] = decode.lut(binary, tag.offset);
                    break;

                case 'B2A0': //perceptual
                    this.B2A[0] = decode.lut(binary, tag.offset);
                    break;
                case 'B2A1': //relative colorimetric
                    this.B2A[1] = decode.lut(binary, tag.offset);
                    break;
                case 'B2A2': //saturation
                    this.B2A[2] = decode.lut(binary, tag.offset);
                    break;

                case 'desc':
                    this.name = decode.text(binary, tag.offset).text;
                    break;

                case 'cprt':
                    this.copyright = decode.text(binary, tag.offset).text;
                    break;
                case 'tech':
                    this.technology = this.techSignatureString(decode.chars(binary, tag.offset, 4));
                    break;
                case 'vued':
                    this.viewingConditions = decode.text(binary, tag.offset);
                    break;
                case 'targ':
                    this.characterizationTarget = decode.text(binary, tag.offset);
                    break;
                case 'bkpt':
                    this.blackPoint = decode.XYZType(binary, tag.offset);
                    break;
                case 'lumi':
                    this.luminance = decode.XYZType(binary, tag.offset);
                    break;
                case 'chad': //chromaticAdaptationTag
                    this.chromaticAdaptation = decode.s15Array(binary, tag.offset, tag.length);
                    break;
                case 'view': //viewingConditionsType
                    this.viewingConditions = decode.viewingConditions(binary, tag.offset);
                    break;
                case 'gamt':
                    // 'Gamut Tag Ignored' for now
                    break;
                case 'calt':
                    // 'Calibration Date Time Tag Ignored' for now
                    break;
                case 'chrm':
                    // chromaticityType Tag Ignored for now
                    break;
                case 'cicp':
                    // Coding-Independent Code Points (CICP) for video signal type identification Ignored for now
                    break;
                case 'clro':
                    // Colorant Order Ignored for now
                    break;
                case 'clrt':
                    // Colorant Table Ignored for now
                    break;
                case 'ciis':
                    // Colorant Table Out of Range Indicator Ignored for now
                    break;
                case 'dmnd':
                    // Device Manufacturer Description Ignored for now
                    break;
                case 'dmdd':
                    // Device Model Description Ignored for now
                    break;
                case 'meas':
                    // Measurement Type Ignored for now
                    break;
                case 'meta':
                    // Metadata Ignored for now
                    break;
                case 'ncl2':
                    // Named Color 2 Ignored for now
                    break;
                case 'resp':
                    // Output Response Ignored for now
                    break;
                case 'rig0':
                    // Perceptual Rendering Intent Gamut Ignored for now
                    break;
                case 'pre0':
                case 'pre1':
                case 'pre2':
                    // Preview 0,1,2 Ignored for now
                    break;
                case 'pseq':
                    // Profile Sequence Description Ignored for now
                    break;
                case 'psid':
                    // Profile Sequence Identifier Ignored for now
                    break;
                case 'rig2':
                    // saturationRenderingIntentGamut Ignored for now
                    break;

                case 'B2D0': //perceptual
                    this.B2D[0] = decode.multiProcessElement(binary, tag.offset);
                    break;

                case 'B2D1': //relative colorimetric
                    this.B2D[1] = decode.multiProcessElement(binary, tag.offset);
                    break;

                case 'B2D2': //saturation
                    this.B2D[2] = decode.multiProcessElement(binary, tag.offset);
                    break;

                case 'B2D3': //absolute colorimetric
                    this.B2D[3] = decode.multiProcessElement(binary, tag.offset);
                    break;

                case 'D2B0': //perceptual
                    this.D2B[0] = decode.multiProcessElement(binary, tag.offset);
                    break;

                case 'D2B1': //relative colorimetric
                    this.D2B[1] = decode.multiProcessElement(binary, tag.offset);
                    break;

                case 'D2B2': //saturation
                    this.D2B[2] = decode.multiProcessElement(binary, tag.offset);
                    break;

                case 'D2B3': //absolute colorimetric
                    this.D2B[3] = decode.multiProcessElement(binary, tag.offset);
                    break;

                case 'Info':
                    this.info = decode.text(binary, tag.offset);
                    break;

                default:
                    console.log('Unsupported Tag [' + tag.sig + ']');
                    this.unsuportedTags.push(tag);
            }
        }

        console.log(this);


        if (this.B2A[eIntent.perceptual] === null) {
            this.B2A[eIntent.perceptual] = this.B2A[eIntent.relative];
        } // No Perceptual, use Colorimetric
        if (this.B2A[eIntent.saturation] === null) {
            this.B2A[eIntent.saturation] = this.B2A[eIntent.perceptual];
        } // No Saturation - use Perceptual

        if (this.A2B[eIntent.perceptual] === null) {
            this.A2B[eIntent.perceptual] = this.A2B[eIntent.relative];
        } // No Perceptual, use Colorimetric
        if (this.A2B[eIntent.saturation] === null) {
            this.A2B[eIntent.saturation] = this.A2B[eIntent.perceptual];
        } // No Saturation - use Perceptual

        if (!(this.header.pClass === 'prtr' ||
            this.header.pClass === 'mntr' ||
            this.header.pClass === 'scnr' ||
            //this.header.pClass === 'link' ||// not supported as yet
            this.header.pClass === 'spac' ||
            this.header.pClass === 'abst'
        )) {
            this.lastError = {err: 100, text: 'profile class not ' + this.header.pClass + ' supported'};
            return false;
        }

        //console.log(this);

        return true;

    };

    techSignatureString(sig) {
        var TechnologySignatures =
            [{desc: 'Film Scanner', sig: 'fscn'},
                {desc: 'Digital Camera', sig: 'dcam'},
                {desc: 'Reflective Scanner', sig: 'rscn'},
                {desc: 'Ink Jet Printer', sig: 'ijet'},
                {desc: 'Thermal Wax Printer', sig: 'twax'},
                {desc: 'Electrophotographic Printer', sig: 'epho'},
                {desc: 'Electrostatic Printer', sig: 'esta'},
                {desc: 'Dye Sublimation Printer', sig: 'dsub'},
                {desc: 'Photographic Paper Printer', sig: 'rpho'},
                {desc: 'Film Writer', sig: 'fprn'},
                {desc: 'Video Monitor', sig: 'vidm'},
                {desc: 'Video Camera', sig: 'vidc'},
                {desc: 'Projection Television', sig: 'pjtv'},
                {desc: 'Cathode Ray Tube Display', sig: 'CRT '},
                {desc: 'Passive Matrix Display', sig: 'PMD '},
                {desc: 'Active Matrix Display', sig: 'AMD '},
                {desc: 'Photo CD', sig: 'KPCD'},
                {desc: 'PhotoImageSetter', sig: 'imgs'},
                {desc: 'Gravure', sig: 'grav'},
                {desc: 'Offset Lithography', sig: 'offs'},
                {desc: 'Silkscreen', sig: 'silk'},
                {desc: 'Flexography', sig: 'flex'}];

        for (var i = 0; i < TechnologySignatures.length; i++) {
            if (TechnologySignatures[i].sig === sig) {
                return TechnologySignatures[i].desc;
            }
        }
        return '<Unknown Technology Signature>';
    };
}


function readBinaryFile(filename) {
    var file
    if (window.cep && window.cep.fs && window.cep.fs.readFile) {
        //
        // In adobe illustrator cep enviroment
        //
        file = window.cep.fs.readFile(filename, cep.encoding.Base64);
        file.errorString = this.errorString[file.err];
        if (file.err === 0) {
            file.binary = Base64Binary.decode(file.data);
        }
        return file;
    }
    var fs = require('fs');
    return fs.readFileSync(filename, {encoding: 'base64'});
}

function XHRLoadBinary(url, onComplete) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, true);
    xhr.responseType = 'arraybuffer';

    xhr.onload = function(){
        if (this.status === 200) {
            // get binary data as a response
            var arrayBuffer = xhr.response;
            if (arrayBuffer) {
                var byteArray = new Uint8Array(arrayBuffer);
                onComplete(byteArray, '');
            } else {
                onComplete(false, 'Invalid arrayBuffer');
            }
        } else {
            onComplete(false, 'Server Status ' + this.status);
        }
    };

    xhr.timeout = function() {
        onComplete(false, 'Timeout');
    };

    xhr.error = function() {
        onComplete(false, 'XHR Error');
    };

    xhr.send();
}


function base64ToUint8Array(base64) {
    // Decode the Base64 string to a binary string
    let binary_string = window.atob(base64);

    // Create a new Uint8Array with the same length as the binary string
    let len = binary_string.length;
    let bytes = new Uint8Array(len);

    // Convert each character in the binary string to a byte
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }

    return bytes;
}

module.exports = Profile;
