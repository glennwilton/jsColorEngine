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

module.exports = {
    XYZNumber: function (binary, offset) {
        var x = this.s15Fixed16Number(this.uint32(binary, offset));
        var y = this.s15Fixed16Number(this.uint32(binary, offset + 4));
        var z = this.s15Fixed16Number(this.uint32(binary, offset + 8));
        return {X: x, Y: y, Z: z};
    },
    chars: function (binary, offset, length) {
        var str = '';
        for (var i = 0; i < length; i++) {
            str += String.fromCharCode(binary[offset]);
            offset++;
        }
        return str;
    },
    unicodeChars: function (binary, offset, length) {
        var str = '';
        for (var i = 0; i < length; i++) {
            str += String.fromCharCode((binary[offset] << 8) + binary[offset + 1]);
            offset += 2;
        }
        return str;
    },
    array: function (binary, offset, length) {
        var arr = [];
        for (var i = 0; i < length; i++) {
            arr.push(binary[offset]);
            offset++;
        }
        return arr
    },
    uInt8Array: function (binary, offset, length) {
        return new Uint8Array(binary.buffer.slice(offset, offset + length));
    },
    uInt16Array: function (binary, offset, length) {
        // Double the length to get the number of bytes
        var bytes = length * 2;

        var u8TempArray = new Uint8Array(binary.buffer.slice(offset, offset + bytes));

        // the data is in littleEndian format so we need to invert the data - Quick and easier than using DataView???
        for (var i = 0; i < bytes; i += 2) {
            var v = u8TempArray[i];
            u8TempArray[i] = u8TempArray[i + 1];
            u8TempArray[i + 1] = v;
        }
        return new Uint16Array(u8TempArray.buffer);
    },
    uint32: function (binary, offset) {
        return binary[offset + 3] + (binary[offset + 2] << 8) + (binary[offset + 1] << 16) + (binary[offset] << 24)
    },
    uint16: function (binary, offset) {
        return (binary[offset + 1]) + (binary[offset] << 8)
    },
    u8Fixed8Number: function (binary, pos) {
        return binary[pos] + (binary[pos + 1] / 256);
    },
    s15Fixed16Number: function (n) {
        if (n > 0x80000000) {
            return (0x100000000 - n) / -0x10000;
        }
        return n / 0x10000;
    },
    float32: function (binary, offset) {
        return new DataView(binary.buffer).getFloat32(offset);
    },
    float64: function (binary, offset) {
        return new DataView(binary.buffer).getFloat64(offset);
    },
    s15Array: function (binary, offset, tagLength) {
        // This type represents an array of generic 4-byte (32-bit) fixed point quantity
        // The number of values is determined from the size of the tag.
        var values = [];
        for (var p = 8; p < tagLength; p += 4) {
            values.push(this.s15Fixed16Number(this.uint32(binary, offset + p)));
        }
        return {
            sig: this.chars(binary, offset, 4), // sf32
            values: values
        };
    },
    XYZType: function (binary, offset) {
        //var sig = this.chars(binary, offset, 4);
        return this.XYZNumber(binary, offset + 8);
    },
    text: function (binary, offset) {
        var textType = this.chars(binary, offset, 4);
        switch (textType) {
            case 'desc':
                return this._textDescriptionType(binary, offset);
            case 'text':
                return this._textType(binary, offset);
            case 'mluc':
                return this._multiLocalizedUnicodeText(binary, offset);
            default:
                console.log('Unknown Text Type ' + textType);
                return {
                    sig: textType,
                    text: '<Unknown Text Type>'
                };
        }
    },
    _multiLocalizedUnicodeText: function (binary, offset) {
        var recordCount = this.uint32(binary, offset + 8);
        var recordSize = this.uint32(binary, offset + 12);
        var languages = [];
        var ptr = offset + 16;
        var textEn = '';
        for (var i = 0; i < recordCount; i++) {
            var languageCode = this.chars(binary, ptr, 2);
            var strLength = this.uint32(binary, ptr + 4) / 2;
            var strOffset = this.uint32(binary, ptr + 8);
            var text = this.unicodeChars(binary, offset + strOffset, strLength);

            // choose the first english text
            if (languageCode === 'en' && textEn === '') {
                textEn = text;
            }

            languages.push({
                languageCode: languageCode,  //language code specified in ISO 639-1
                countryCode: this.chars(binary, ptr + 2, 2),  //country code specified in ISO 3166-1
                text: text
            });

            ptr += recordSize;
        }

        if (textEn === '') {
            // No english, so just the first entry
            textEn = languages[0].text;
        }

        return {
            sig: this.chars(binary, offset, 4),
            text: textEn,
            languages: languages
        }

    },
    _textType: function (binary, offset) {
        return {
            sig: this.chars(binary, offset, 4),
            text: this.nts(binary, offset + 8)
        };
    },
    _textDescriptionType: function (binary, offset) {
        var AsciiLength = this.uint32(binary, offset + 8);
        return {
            sig: this.chars(binary, offset, 4),
            text: this.nts(binary, offset + 12),
            length: AsciiLength
        };
    },
    nts: function (binary, offset, maxLen) {
        maxLen = maxLen || 1024;
        var str = '';
        for (var i = 0; i < maxLen; i++) {
            if (binary[offset] === 0) {
                return str;
            }
            str += String.fromCharCode(binary[offset]);
            offset++;
        }
        return str;
    },
    matrixV2: function (binary, offset) {
        var matrix = [];
        for (var i = 0; i < 9; i++) {
            matrix[i] = this.s15Fixed16Number(this.uint32(binary, offset));
            offset += 4;
        }
        return matrix;
    },
    matrixV4: function (binary, offset) {
        var matrix = [];
        for (var i = 0; i < 12; i++) {
            matrix[i] = this.s15Fixed16Number(this.uint32(binary, offset));
            offset += 4;
        }
        return matrix;
    },
    viewingConditions: function (binary, offset) {
        return {
            sig: this.chars(binary, offset, 4),
            illuminant: this.XYZNumber(binary, offset + 8),
            surround: this.XYZNumber(binary, offset + 20),
            measurement: this.illuminant2Text(this.uint32(binary, offset + 32))
        }
    },
    measurement: function (binary, offset) {
        return {
            sig: this.chars(binary, offset, 4),
            observer: this.observer2Text(this.uint32(binary, offset + 8)),
            tristimulus: this.XYZNumber(binary, offset + 12),
            geometry: this.geometry2Text(this.uint32(binary, offset + 24)),
            flare: this.flare2Text(this.uint32(binary, offset + 28)),
            illuminant: this.illuminant2Text(this.uint32(binary, offset + 32))
        };
    },
    observer2Text: function (obs) {
        switch (obs) {
            case 1:
                return 'CIE 1931 standard colorimetric observer';
            case 2:
                return 'CIE 1964 standard colorimetric observer';
            default:
                return 'Unknown'
        }
    },
    geometry2Text: function (geo) {
        switch (geo) {
            case 1:
                return '0°:45° or 45°:0°';
            case 2:
                return '0°:d or d:0°';
            default:
                return 'Unknown'
        }
    },
    flare2Text: function (flare) {
        return (flare === 0) ? '0 (0 %)' : '1,0 (or 100 %)';
    },
    illuminant2Text: function (ill) {
        var illText = ['Unknown', 'D50', 'D65', 'D93', 'F2', 'D55', 'A', 'Equi-Power (E)', 'F8'];
        return illText[ill];
    },
    curves: function (binary, offset, count, useInverseFn) {
        var curves = [];
        var curveOffset = offset;

        for (var i = 0; i < count; i++) {
            var curve = this.curve(binary, curveOffset, useInverseFn);
            curves.push(curve);
            var byteLength = curve.byteLength;

            if (byteLength === false) {
                // we don't know the length so we can't continue
                break;
            }

            //32 bit aligned
            if (byteLength % 4 !== 0) {
                byteLength += 4 - (byteLength % 4);
            }

            curveOffset += byteLength;
        }
        return curves;
    },
    inverseCurve: function (curve, numPoints) {
        var step = 1 / (numPoints - 1);
        var inverseCurve = [];
        var a = 0;
        var b = 0;
        var inputLen = curve.length - 1;
        var x1, x2, y1, y2;
        var increasing = curve[0] < curve[inputLen];

        for (var i = 0; i < numPoints; i++) {

            var y = i * step;
            var j = getInterval(y, curve);

            if (j >= 0) {
                x1 = curve[j];
                x2 = curve[j + 1];

                y1 = j / inputLen;
                y2 = (j + 1) / inputLen;

                // curve has collapsed to a point
                if (x1 === x2) {
                    inverseCurve.push(increasing ? y2 : y1);
                    continue;
                } else {
                    a = (y2 - y1) / (x2 - x1);
                    b = y2 - a * x2;
                }
            }

            // Clip to 0.0 - 1.0
            var x = Math.min(1.0, Math.max(0.0, (a * y + b)));
            inverseCurve.push(x);
        }

        return inverseCurve;
        function getInterval(y, curve) {
            if (curve.length <= 1) {
                return -1;
            }

            var i;
            if (curve[0] < curve[curve.length - 1]) {
                // increasing overall, but maybe not at local point
                for (i = 0; i < curve.length - 2; i++) {
                    if (y >= curve[i] && y <= curve[i + 1]) {
                        // increasing at local point
                        return i;
                    } else {
                        if (curve[i + 1] < curve[i]) {
                            if (y >= curve[i + 1] && y <= curve[i]) {
                                // decreasing at local point
                                return i;
                            }
                        }
                    }
                }
            } else {
                // decreasing overall, but maybe not at local point
                for (i = 0; i < curve.length - 2; i++) {
                    if (curve[i] <= curve[i + 1]) {
                        if (y >= curve[i] && y <= curve[i + 1]) {
                            // increasing at local point
                            return i;
                        }
                    } else if (curve[i + 1] < curve[i]) {
                        if (y >= curve[i + 1] && y <= curve[i]) {
                            // decreasing at local point
                            return i;
                        }
                    }
                }
            }
            return -1;
        }

    },

    curve: function (binary, offset, useInverse, inverseCurveSteps) {
        var type = this.chars(binary, offset, 4);
        var curveHeaderBytes = 12;
        var curve = {
            use: false,
            count: 0,
            data: false,  // uint16 0 - 65535
            dataf: [],  // float 0.0 - 1.0
            gamma: 0,
            inverted: useInverse,
            passThrough: false,
            curveFn: false,
            params: false,
            byteLength: false,
        };

        switch (type) {
            case 'curv':
                curve.count = this.uint32(binary, offset + 8);

                // calculate the length of the curve, adding 20 bytes for the curve header
                curve.byteLength = curveHeaderBytes + (curve.count * 2);

                /*The count value specifies the number of entries in the curve table except as follows:
                 when count is 0, then a linear response (slope equal to 1.0) is assumed,
                 when count is 1, then the data entry is interpreted as a simple gamma value encoded as a
                 u8Fixed8Number. Gamma is interpreted canonically and not as an inverse.
                 Otherwise, the 16-bit unsigned integers in the range 0 to 65535 linearly map to curve values in the interval
                 [0.0, 1.0].*/
                if (curve.count === 0) {
                    curve.gamma = 1.0;
                    // curve.passThrough indicates that this curve can be ignored
                    curve.passThrough = true;

                } else {
                    if (curve.count === 1) {
                        curve.gamma = this.u8Fixed8Number(binary, offset + 12);
                    } else {
                        // flag for use
                        curve.use = true;
                        curve.data = this.uInt16Array(binary, offset + 12, curve.count);

                        curve.dataf = new Float64Array(curve.count);
                        for (i = 0; i < curve.data.length; i++) {
                            curve.dataf[i] = curve.data[i] / 65535.0;
                        }

                        if (useInverse) {
                            inverseCurveSteps = inverseCurveSteps || 4096;
                            curve.dataf = this.inverseCurve(curve.dataf, inverseCurveSteps);
                            curve.count = curve.dataf.length;
                            // for(i = 0; i < curve.dataf.length; i++){
                            //     // Rewrite 16 bit arrays
                            //     curve.data[i] = Math.round(curve.dataf[i] * 65535.0);
                            // }
                        }

                        // get midpoint
                        if (curve.count > 3) {
                            var y = curve.data[curve.count / 2];
                            curve.gamma = 0.0 - Math.log(y / 65535.0) / 0.69315;
                        }

                        if (curve.count === 2) {
                            if (curve.data[0] === 0 && curve.data[1] === 65535) {
                                // curve.passThrough indicates that this curve can be ignored
                                curve.passThrough = true;
                            }
                        }
                    }
                }


                break;
            case 'para':
                // parametricCurveType
                curve.use = true;
                var i;
                var functionType = this.uint16(binary, offset + 8);
                // get parameters

                //Table 68 — parametricCurveType function type encoding ICC V4.4 spec
                var functionType2PramCount = [1, 3, 4, 5, 7]
                var pramCount = functionType2PramCount[functionType];
                if (pramCount === undefined) {
                    console.log('Unknown parametricCurveType function type ' + functionType);
                    break;
                }

                curve.byteLength = curveHeaderBytes + (pramCount * 4);

                curve.params = [];
                for (i = 0; i < pramCount; i++) {
                    // Note that its 32 bit aligned, so i * 4 bytes
                    var paramOffset = offset + curveHeaderBytes + (i * 4);
                    curve.params.push(this.s15Fixed16Number(this.uint32(binary, paramOffset)));
                }

                //
                // Note that the inverse functions are mainly used for inverse matrix gamma tone curves
                // in the LUTS the curves are always as-is, since the luts know the directions
                //

                switch (functionType) {
                    case 0:
                        // Just use inline gamma as faster code
                        curve.gamma = curve.params[0];
                        if (curve.gamma === 1.0) {
                            // curve.passThrough indicates that this curve can be ignored
                            curve.passThrough = true;
                        }

                        // if(useInverse){
                        //     curve.curveFn = function(params, y){
                        //         //y = Math.max(0.0, Math.min(1.0, y));
                        //         return Math.pow(y, 1.0 / params[0]);
                        //     }
                        // } else {
                        //     // Gamma
                        //     // X = Y ^ Gamma
                        //     curve.curveFn = function(params, x){
                        //         //x = Math.max(0.0, Math.min(1.0, x));
                        //         return Math.pow(x, params[0]);
                        //     }
                        // }
                        break;
                    case 1:
                        if (useInverse) {
                            // X = (Y ^1/g  - b) / a
                            curve.curveFn = function (params, y) {
                                ///y = Math.max(0.0, Math.min(1.0, y));
                                return (Math.pow(y, 1.0 / params[0]) - params[2]) / params[1];
                            }
                        } else {
                            // CIE 122-1966
                            // Y = (aX + b)^Gamma  | X >= -b/a
                            // Y = 0               | else
                            curve.curveFn = function (params, x) {
                                //x = Math.max(0.0, Math.min(1.0, x));
                                var disc = -params[2] / params[1];
                                if (x >= disc) {
                                    var e = params[1] * x + params[2];
                                    if (e > 0) {
                                        return Math.pow(e, params[0]);
                                    }
                                    return 0;
                                }
                                return 0;
                            }
                        }
                        break;

                    case 2:// IEC 61966‐3
                        if (useInverse) {
                            // X=((Y^1/g-b)/a)    | Y >= (ad+b)^g
                            // X=Y/c              | Y< (ad+b)^g
                            curve.curveFn = function (params, y) {
                                //y = Math.max(0.0, Math.min(1.0, y));
                                var e = params[1] * params[4] + params[2];
                                var disc = 0;
                                if (e >= 0) {
                                    disc = Math.pow(e, params[0]);
                                }
                                if (y >= disc) {
                                    return (Math.pow(y, 1.0 / params[0]) - params[2]) / params[1];
                                }
                                return y / params[3];
                            }
                        } else {

                            // Y = (aX + b)^Gamma | X >= d
                            // Y = cX             | X < d
                            curve.curveFn = function (params, x) {
                                //x = Math.max(0.0, Math.min(1.0, x));
                                if (x >= params[4]) {
                                    var e = params[1] * x + params[2];
                                    if (e > 0) {
                                        return Math.pow(e, params[0]);
                                    }
                                    return 0;
                                }
                                return params[3] * x;
                            }
                        }
                        break;
                    case 3: //IEC 61966‐2.1 (sRGB)
                        if (useInverse) {
                            // X=((Y-e)1/g-b)/a   | Y >=(ad+b)^g+e), cd+f
                            // X=(Y-f)/c          | else
                            curve.curveFn = function (params, y) {
                                //y = Math.max(0.0, Math.min(1.0, y));
                                var disc = params[3] * params[4] + params[6];
                                if (y >= disc) {
                                    var e = y - params[5];
                                    if (e < 0) {
                                        return 0;
                                    }
                                    return (Math.pow(e, 1.0 / params[0]) - params[2]) / params[1];
                                }
                                return (y - params[6]) / params[3];
                            }
                        } else {
                            // Y = (aX + b)^Gamma + e | X >= d
                            // Y = cX + f             | X < d
                            curve.curveFn = function (params, x) {
                                //x = Math.max(0.0, Math.min(1.0, x));
                                if (x >= params[4]) {
                                    var e = params[1] * x + params[2];
                                    if (e > 0) {
                                        return Math.pow(e, params[0]) + params[5];
                                    }
                                    return params[5];
                                }
                                return params[3] * x + params[6];
                            }
                        }
                        break;
                    case 4:
                        if (useInverse) {
                            // X=((Y-e)1/g-b)/a   | Y >=(ad+b)^g+e), cd+f
                            // X=(Y-f)/c          | else
                            curve.curveFn = function (params, y) {
                                var disc = params[3] * params[4] + params[6];
                                if (y >= disc) {
                                    var e = y - params[5];
                                    if (e < 0) {
                                        return 0;
                                    }
                                    if (params[0] < 0.0001 || params[1] < 0.0001) {
                                        return 0;
                                    }
                                    return (Math.pow(e, 1.0 / params[0]) - params[2]) / params[1];
                                } else {
                                    if (params[3] < 0.0001) {
                                        return 0;
                                    }
                                    return (y - params[6]) / params[3];
                                }
                            }
                        } else {
                            curve.curveFn = function (params, x) {
                                // Y = (aX + b)^Gamma + e | X >= d
                                // Y = cX + f             | X < d
                                if (x >= params[4]) {

                                    var e = params[1] * x + params[2];

                                    if (e > 0) {
                                        return Math.pow(e, params[0]) + params[5];
                                    }

                                    return params[5];
                                }
                                return x * params[3] + params[6];
                            }
                        }
                        break;
                    default:
                        throw ('parametricCurveType function type ' + functionType + ' not implemented');
                }
                break;
            default:
                throw ('Unknown CURVE type' + type);
        }
        return curve;
    },
    lut: function (binary, offset) {
        var type = this.chars(binary, offset, 4);
        var lut = {type: type};
        var nGridPoints, i;
        var gridPoints = [];
        var bCurveOffset, matrixOffset, mCurveOffset, cLUTOffset, aCurveOffset;
        var inputTableSize;
        var outputTableSize;
        var lutSize;

        //(matrixV4) ⇒ (1d input tables) ⇒ (multidimensional lookup table) ⇒ (1d output tables).
        // a 3 by 3 matrixV4 (only used when the input color space is XYZ),
        switch (type) {
            case 'mft2': //lut16Type
                lut.precision = 16;
                lut.inputScale = 1;
                lut.outputScale = 1 / 65535;

                lut.inputChannels = binary[offset + 8];
                lut.outputChannels = binary[offset + 9]

                nGridPoints = binary[offset + 10];
                for (i = 0; i < lut.inputChannels; i++) {
                    gridPoints.push(nGridPoints);
                }

                lut.gridPoints = gridPoints;
                lut.matrix = this.matrixV2(binary, offset + 12);

                lut.inputTableEntries = this.uint16(binary, offset + 48);
                lut.outputTableEntries = this.uint16(binary, offset + 50);

                var readPos = offset + 52;

                ///////////////////////////////////////////////////////
                // Read input curves
                inputTableSize = lut.inputTableEntries * lut.inputChannels;

                lut.inputCurve = {
                    channels: lut.inputChannels,
                    entries: this.uint16(binary, offset + 48),
                    table: this.uInt16Array(binary, readPos, inputTableSize),
                    tablef: new Float64Array(inputTableSize),
                    outputScale: 1 / 65535
                };

                readPos += (inputTableSize * 2);

                for (i = 0; i < lut.inputCurve.table.length; i++) {
                    lut.inputCurve.tablef[i] = lut.inputCurve.table[i] / 65535.0;
                }

                ///////////////////////////////////////////////////////
                // Read xD Lut Table
                lutSize = Math.pow(lut.gridPoints[0], lut.inputChannels) * lut.outputChannels;
                lut.CLUT = this.uInt16Array(binary, readPos, lutSize);

                readPos += (lutSize * 2);

                ///////////////////////////////////////////////////////
                // Read output curves
                outputTableSize = lut.outputTableEntries * lut.outputChannels
                lut.outputCurve = {
                    channels: lut.outputChannels,
                    entries: this.uint16(binary, offset + 50),
                    table: this.uInt16Array(binary, readPos, outputTableSize),
                    tablef: new Float64Array(outputTableSize),
                    outputScale: 1 / 65535
                };

                for (i = 0; i < lut.outputCurve.table.length; i++) {
                    lut.outputCurve.tablef[i] = lut.outputCurve.table[i] / 65535.0;
                }
                break;

            case 'mft1': //lut16Type
                lut.precision = 8;
                lut.inputScale = 1;
                lut.outputScale = 1 / 255;
                lut.inputChannels = binary[offset + 8];
                lut.outputChannels = binary[offset + 9];

                nGridPoints = binary[offset + 10];
                for (i = 0; i < lut.inputChannels; i++) {
                    gridPoints.push(nGridPoints);
                }
                lut.gridPoints = gridPoints;
                lut.matrix = this.matrixV2(binary, offset + 12);

                lut.inputTableEntries = 256;
                lut.outputTableEntries = 256;

                // Read input curves
                inputTableSize = lut.inputTableEntries * lut.inputChannels;
                lut.inputCurve = {
                    channels: lut.inputChannels,
                    entries: 256,
                    table: this.uInt8Array(binary, offset + 48, inputTableSize),
                    tablef: new Float64Array(inputTableSize),
                    outputScale: 1 / 255
                };

                for (i = 0; i < lut.inputCurve.table.length; i++) {
                    lut.inputCurve.tablef[i] = lut.inputCurve.table[i] / 255.0;
                }

                ///////////////////////////////////////////////////////
                // Read xD Lut Table
                lutSize = Math.pow(lut.gridPoints[0], lut.inputChannels) * lut.outputChannels;
                lut.CLUT = this.uInt8Array(binary, offset + 48 + inputTableSize, lutSize);

                ///////////////////////////////////////////////////////
                // Read output curves
                outputTableSize = lut.outputTableEntries * lut.outputChannels;
                lut.outputCurve = {
                    channels: lut.outputChannels,
                    entries: 256,
                    table: this.uInt8Array(binary, offset + 48 + inputTableSize + lutSize, outputTableSize),
                    tablef: new Float64Array(outputTableSize),
                    outputScale: 1 / 255
                };

                for (i = 0; i < lut.outputCurve.table.length; i++) {
                    lut.outputCurve.tablef[i] = lut.outputCurve.table[i] / 255.0;
                }

                break;

            case 'mAB ': //lutAToBType V4
                lut.inputChannels = binary[offset + 8];
                lut.outputChannels = binary[offset + 9];
                bCurveOffset = this.uint32(binary, offset + 12);
                matrixOffset = this.uint32(binary, offset + 16);
                mCurveOffset = this.uint32(binary, offset + 20);
                cLUTOffset = this.uint32(binary, offset + 24);
                aCurveOffset = this.uint32(binary, offset + 28);

                lut.bCurves = (bCurveOffset === 0) ? false : this.curves(binary, offset + bCurveOffset, lut.outputChannels, false);
                lut.matrix = (matrixOffset === 0) ? false : this.matrixV4(binary, offset + matrixOffset);
                if (cLUTOffset === 0) {
                    lut.CLUT = false;
                } else {
                    this.CLUT4(lut, binary, offset + cLUTOffset, lut.inputChannels, lut.outputChannels);
                }
                lut.mCurves = (mCurveOffset === 0) ? false : this.curves(binary, offset + mCurveOffset, lut.outputChannels, false);
                lut.aCurves = (aCurveOffset === 0) ? false : this.curves(binary, offset + aCurveOffset, lut.inputChannels, false);
                break;


            case 'mBA ': //lutBToAType V4
                lut.inputChannels = binary[offset + 8];
                lut.outputChannels = binary[offset + 9];
                bCurveOffset = this.uint32(binary, offset + 12);
                matrixOffset = this.uint32(binary, offset + 16);
                mCurveOffset = this.uint32(binary, offset + 20);
                cLUTOffset = this.uint32(binary, offset + 24);
                aCurveOffset = this.uint32(binary, offset + 28);

                lut.bCurves = (bCurveOffset === 0) ? false : this.curves(binary, offset + bCurveOffset, lut.inputChannels, false);
                lut.matrix = (matrixOffset === 0) ? false : this.matrixV4(binary, offset + matrixOffset);
                if (cLUTOffset === 0) {
                    lut.CLUT = false;
                } else {
                    this.CLUT4(lut, binary, offset + cLUTOffset, lut.inputChannels, lut.outputChannels);
                }
                lut.mCurves = (mCurveOffset === 0) ? false : this.curves(binary, offset + mCurveOffset, lut.inputChannels, false);
                lut.aCurves = (aCurveOffset === 0) ? false : this.curves(binary, offset + aCurveOffset, lut.outputChannels, false);

                break;
            default:
                console.log('Unsupported LUT Tag ' + type);
        }

        lut.g1 = lut.gridPoints[0];
        lut.g2 = lut.g1 * lut.gridPoints[1];
        lut.g3 = lut.g2 * lut.gridPoints[2];
        lut.g4 = lut.g3 * lut.gridPoints[3];

        lut.go0 = lut.outputChannels;
        lut.go1 = lut.g1 * lut.outputChannels;
        lut.go2 = lut.g2 * lut.outputChannels;
        lut.go3 = lut.g3 * lut.outputChannels;
        return lut;

    },
    CLUT4: function (lut, binary, offset, inputChannels, outputChannels) {
        var gridPoints = [];
        var precision = binary[offset + 16];

        // get the gridpoints
        for (var i = 0; i < inputChannels; i++) {
            gridPoints.push(binary[offset + i]);
        }

        // calc the length
        var lutLength = gridPoints[0];
        for (i = 1; i < inputChannels; i++) {
            lutLength *= gridPoints[i];
        }

        if (precision === 1) {
            lut.CLUT = this.uInt8Array(binary, offset + 20, lutLength * outputChannels);
            lut.inputScale = 1;
            lut.outputScale = 1 / 255;
        } else {
            lut.CLUT = this.uInt16Array(binary, offset + 20, lutLength * outputChannels);
            lut.inputScale = 1;
            lut.outputScale = 1 / 65535;
        }

        // update the data
        lut.precision = precision * 8;  // 8 or 16 bit
        lut.gridPoints = gridPoints;
    },

    /**
     * MultiProcess Elements are mainly for Film use and not supported at this time
     *
     * https://www.color.org/whitepapers/ICC_White_Paper28-MultiProcessingElements.pdf
     *
     * From the whitepaper "CMM Support for Multi Processing Element Tag type is optional.
     * This means that MPE based tag support is NOT guaranteed to be provided an implemented
     * by CMMs in general! Additionally, all required tags must be present and valid."
     *
     * In Otherwords don't need to use them as standard TAGs for AtoB and BtoA are
     * provided and can be used instead.
     *
     * @param binary
     * @param offset
     * @returns {{elements: *[], inputChannels: *, outputChannels: *}}
     */
    multiProcessElement: function (binary, offset) {
        var elements = [];
        var inputChannels = this.uint16(binary, offset + 8);
        var outputChannels = this.uint16(binary, offset + 10);
        var elementCount = this.uint32(binary, offset + 12);

        var elementOffsets = [];
        for (var i = 0; i < elementCount; i++) {
            elementOffsets.push({
                offset: this.uint32(binary, offset + 16 + (i * 4)),
                size: this.uint32(binary, offset + 16 + (i * 4) + 4)
            });
        }

        for (i = 0; i < elementCount; i++) {
            var elementOffset = offset + elementOffsets[i].offset;
            var sig = this.chars(binary, elementOffset, 4);
            switch (sig) {
                case 'cvst':
                    // Curves Not supported at this time
                    elements.push({
                        sig: sig
                    });
                    break;
                case 'matf':
                    // Matrix Not supported at this time
                    elements.push({
                        sig: sig,
                    });
                    break;
                case 'clut':
                    // CLUT Not supported at this time
                    elements.push({
                        sig: sig,
                    });
                    break;

                case 'bACS':
                case 'eACS':
                    break;
                default:
                    console.log('Unknown MultiProcess Element ' + sig);
            }
        }
        return {
            inputChannels: inputChannels,
            outputChannels: outputChannels,
            elements: elements
        };
    }
};
