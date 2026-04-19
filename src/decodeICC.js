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
 * ============================================================================
 *  decodeICC.js — low-level ICC binary decoders
 * ============================================================================
 *
 *  CLOSED-BOX MODULE. Almost nobody outside `Profile.js` should need to
 *  touch this file. If you're trying to load a `.icc` / `.icm` profile,
 *  use:
 *
 *      var p = new Profile();
 *      p.load(buffer, callback);          // or p.loadBinary(uint8Array, ...)
 *
 *  This module is the byte-level layer that `Profile.js` calls into to
 *  decode raw ICC tag bytes into structured JS objects (XYZ tristimuli,
 *  TRC curves, LUTs, viewing conditions, etc.).
 *
 *  ----------------------------------------------------------------------------
 *  CONVENTIONS
 *  ----------------------------------------------------------------------------
 *
 *  - All multi-byte integers in ICC are BIG-ENDIAN. The primitive readers
 *    here (`uint16`, `uint32`, `XYZNumber`, ...) assume big-endian and do
 *    the byte-swap explicitly.
 *
 *  - Every reader takes `(binary, offset, ...)` where `binary` is a
 *    `Uint8Array` containing the entire profile and `offset` is a byte
 *    index into it. Readers are stateless — no streaming, no cursor.
 *    Callers compute offsets from the tag table.
 *
 *  - `binary.byteOffset` is assumed to be 0 (i.e. `binary` is NOT a
 *    sub-view created by `.subarray()`). Profile.js always constructs a
 *    fresh `new Uint8Array(arrayBuffer)`, which satisfies this. If you
 *    ever pass a sub-view, the typed-array readers (`uInt8Array`,
 *    `uInt16Array`) will read from the wrong place.
 *
 *  - Returned objects use the field names from the ICC.1:2010 spec where
 *    practical (`sig`, `inputChannels`, `gridPoints`, ...).
 *
 *  ----------------------------------------------------------------------------
 *  ICC v2 / v4 COVERAGE
 *  ----------------------------------------------------------------------------
 *
 *    V4 SUPPORT IN PRACTICE: the vast majority of V4 ICC profiles in the
 *    wild use only the subset of tag types that already overlap with V2
 *    (XYZ, mluc, sf32, curv/para, mAB/mBA), all of which are fully
 *    decoded here. Everyday display, working-space and printer V4
 *    profiles therefore round-trip the same as their V2 equivalents.
 *
 *    The main thing missing is multiProcessElement (`mpet`), which the
 *    spec uses for film, scientific and high-end colour workflows. As
 *    the ICC MPE white paper notes, MPE support is OPTIONAL for any CMM
 *    and the standard `AtoB`/`BtoA` tags MUST always be present and
 *    valid in any conforming profile — so for an MPE-bearing profile
 *    we simply use the mandatory standard tags instead.
 *
 *    SUPPORTED tag-data types:
 *      XYZ      ('XYZ ')     XYZType
 *      desc     ('desc')     textDescriptionType (ASCII portion only — see P5)
 *      text     ('text')     textType
 *      mluc     ('mluc')     multiLocalizedUnicodeType
 *      sf32     ('sf32')     s15Fixed16ArrayType (via `s15Array`)
 *      curv     ('curv')     curveType (sampled TRC)
 *      para     ('para')     parametricCurveType, function types 0-4
 *      mft1     ('mft1')     lut8Type   (input curves + 3D/4D CLUT + output)
 *      mft2     ('mft2')     lut16Type
 *      mAB      ('mAB ')     lutAToBType (V4)  A → CLUT → M → matrix → B
 *      mBA      ('mBA ')     lutBToAType (V4)  B → matrix → M → CLUT → A
 *      view     ('view')     viewingConditionsType (partial — see notes)
 *      meas     ('meas')     measurementType
 *
 *    NOT SUPPORTED (`console.warn` is emitted when encountered):
 *      mpet                   multiProcessElementsType (stub returns
 *                             element signatures only; no maths runs)
 *      Unknown text types     (returns `<Unknown Text Type>` placeholder)
 *      Unknown LUT types      (returns a partially-populated lut object)
 *      Parametric type ≥ 5    (currently throws)
 *
 *    NOT IMPLEMENTED (silently absent — Profile.js handles fallback):
 *      sig, data, dtim, ui16, ui32, ui64, uf32,
 *      pseq, psid, ncl2, chrm, clrt, crdi, devs, ncol,
 *      pmtb, rcs2, screen, ucmt
 *
 *  ----------------------------------------------------------------------------
 *  KNOWN LIMITATIONS vs SPEC
 *  ----------------------------------------------------------------------------
 *
 *    - `desc` (V2): only the ASCII section is decoded. The Unicode and
 *      ScriptCode sections that follow it in the spec are ignored. For V4
 *      profiles, use `mluc` instead — it supersedes `desc`.
 *
 *    - MultiProcessElements (`mpet`) are stubbed: the element signatures
 *      are returned but `cvst` (curves), `matf` (matrix) and `clut` are
 *      not actually decoded. As the ICC MPE white-paper notes, CMM
 *      support for MPE is OPTIONAL and the standard `AtoB`/`BtoA` tags
 *      must always be present, so we lean on those.
 *
 *    - `inverseCurve` is a numerical inversion of a sampled curve — it
 *      assumes overall monotonicity and degrades gracefully on locally
 *      non-monotonic curves. Not a high-precision general-purpose inverse.
 *
 *  ----------------------------------------------------------------------------
 *  REFERENCES
 *  ----------------------------------------------------------------------------
 *
 *    ICC.1:2010 (V4.3) — base spec used here
 *    ICC.1:2022 (V4.4) — newer; `para` function-type table is unchanged
 *    ICC MPE white paper:
 *      https://www.color.org/whitepapers/ICC_White_Paper28-MultiProcessingElements.pdf
 *
 * ============================================================================
 */

module.exports = {

    // ========================================================================
    //  ICC NUMBER FORMATS
    // ========================================================================

    /**
     * Read an XYZNumber (3 × s15Fixed16, big-endian). 12 bytes.
     * @returns {{X:number, Y:number, Z:number}}
     */
    XYZNumber: function (binary, offset) {
        var x = this.s15Fixed16Number(this.uint32(binary, offset));
        var y = this.s15Fixed16Number(this.uint32(binary, offset + 4));
        var z = this.s15Fixed16Number(this.uint32(binary, offset + 8));
        return {X: x, Y: y, Z: z};
    },
    // ========================================================================
    //  PRIMITIVE READERS — strings and small arrays
    // ========================================================================

    /**
     * Read `length` ASCII bytes starting at `offset`. Each byte is taken
     * verbatim as a Latin-1 codepoint.
     * @returns {string}
     */
    chars: function (binary, offset, length) {
        var str = '';
        for (var i = 0; i < length; i++) {
            str += String.fromCharCode(binary[offset]);
            offset++;
        }
        return str;
    },
    /**
     * Read `length` UTF-16BE code units starting at `offset` (i.e. `length * 2`
     * bytes). Used by `mluc` text records.
     * @returns {string}
     */
    unicodeChars: function (binary, offset, length) {
        var str = '';
        for (var i = 0; i < length; i++) {
            str += String.fromCharCode((binary[offset] << 8) + binary[offset + 1]);
            offset += 2;
        }
        return str;
    },
    /**
     * Read `length` bytes as a plain JS array. Prefer `uInt8Array` when you
     * want a typed-array view (faster, lower memory).
     * @returns {number[]}
     */
    array: function (binary, offset, length) {
        var arr = [];
        for (var i = 0; i < length; i++) {
            arr.push(binary[offset]);
            offset++;
        }
        return arr
    },

    // ========================================================================
    //  TYPED ARRAY READERS — 8-bit and 16-bit slices
    // ========================================================================

    /**
     * Slice `length` bytes into a fresh `Uint8Array`. The underlying buffer
     * is copied via `ArrayBuffer.prototype.slice`, so the result is
     * independent of `binary`.
     *
     * Caller contract: `binary.byteOffset === 0` (see file header).
     * @returns {Uint8Array}
     */
    uInt8Array: function (binary, offset, length) {
        return new Uint8Array(binary.buffer.slice(offset, offset + length));
    },
    /**
     * Slice `length` 16-bit big-endian samples into a fresh `Uint16Array`.
     * Bytes are swapped in place into a temp buffer and then re-viewed,
     * which is faster than building each sample with `DataView.getUint16`.
     *
     * Caller contract: `binary.byteOffset === 0` (see file header) AND
     * `offset` lands on an even byte (16-bit alignment).
     * @returns {Uint16Array}
     */
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
    /**
     * Read a big-endian uint32. 4 bytes.
     *
     * NOTE (P3, latent): `<< 24` produces a SIGNED int32 when the top byte
     * is ≥ 0x80, so values > 0x7FFFFFFF come back negative. This works
     * correctly in this codebase because:
     *   (a) ICC offsets/lengths in real-world profiles fit in 31 bits, and
     *   (b) `s15Fixed16Number` happens to handle the signed result correctly
     *       (the `> 0x80000000` test is false for negatives, and the
     *       direct `n / 0x10000` for a signed-negative gives the right
     *       fixed-point value).
     * If you ever need a true unsigned uint32, append `>>> 0`.
     * @returns {number}
     */
    uint32: function (binary, offset) {
        return binary[offset + 3] + (binary[offset + 2] << 8) + (binary[offset + 1] << 16) + (binary[offset] << 24)
    },
    /**
     * Read a big-endian uint16. 2 bytes.
     * @returns {number}
     */
    uint16: function (binary, offset) {
        return (binary[offset + 1]) + (binary[offset] << 8)
    },
    /**
     * Read a u8Fixed8Number (8.8 unsigned fixed point). 2 bytes.
     * Used for legacy gamma values in `curv` curves with count == 1.
     * @returns {number}
     */
    u8Fixed8Number: function (binary, pos) {
        return binary[pos] + (binary[pos + 1] / 256);
    },
    /**
     * Convert a 32-bit value to s15Fixed16Number (signed 15.16 fixed point).
     * Range: ≈ −32768.0 … +32767.999985.
     *
     * Accepts either a raw unsigned 32-bit value OR the signed value that
     * `uint32` returns for top-bit-set inputs (see P3 in `uint32`) — both
     * produce the correct decoded number.
     * @returns {number}
     */
    s15Fixed16Number: function (n) {
        if (n > 0x80000000) {
            return (0x100000000 - n) / -0x10000;
        }
        return n / 0x10000;
    },
    /**
     * Read an IEEE-754 float32 at `offset`. Big-endian (`DataView` default).
     * @returns {number}
     */
    float32: function (binary, offset) {
        return new DataView(binary.buffer).getFloat32(offset);
    },
    /**
     * Read an IEEE-754 float64 at `offset`. Big-endian.
     * @returns {number}
     */
    float64: function (binary, offset) {
        return new DataView(binary.buffer).getFloat64(offset);
    },
    /**
     * Decode an `sf32` (s15Fixed16ArrayType) tag body. The number of values
     * is derived from the tag length (4 bytes per entry, after the 8-byte
     * type signature + reserved header).
     * @param {Uint8Array} binary
     * @param {number} offset      Tag body start.
     * @param {number} tagLength   Total tag length in bytes.
     * @returns {{sig:string, values:number[]}}
     */
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
    // ========================================================================
    //  TAG TYPE READERS — XYZ, text, viewing conditions, measurement
    // ========================================================================

    /**
     * Read an `XYZ ` tag (4 bytes signature + 4 bytes reserved + XYZNumber).
     * @returns {{X:number, Y:number, Z:number}}
     */
    XYZType: function (binary, offset) {
        //var sig = this.chars(binary, offset, 4);
        return this.XYZNumber(binary, offset + 8);
    },
    /**
     * Dispatch to the appropriate text-tag decoder based on the 4-byte
     * type signature at `offset`. Handles `desc` (V2 ASCII), `text`
     * (raw ASCII), and `mluc` (V4 multi-localized Unicode).
     *
     * Unknown types log a warning and return a `<Unknown Text Type>`
     * placeholder rather than throwing — this matches the rest of the
     * decoder's "best-effort, never crash" stance.
     * @returns {{sig:string, text:string, [length]:number, [languages]:object[]}}
     */
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
                console.warn('decodeICC: unknown text tag type "' + textType + '" at offset ' + offset);
                return {
                    sig: textType,
                    text: '<Unknown Text Type>'
                };
        }
    },
    /**
     * Decode a `mluc` (multiLocalizedUnicodeType) tag. Iterates the record
     * table, collects every (lang, country, text) triple, and picks the
     * first English entry as the canonical `text` (or the first record if
     * none is English). All records are kept on `.languages`.
     * @returns {{sig:string, text:string, languages:Array<{languageCode:string, countryCode:string, text:string}>}}
     */
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
    /**
     * Decode a `text` tag (raw NUL-terminated ASCII after 8-byte header).
     * @returns {{sig:string, text:string}}
     */
    _textType: function (binary, offset) {
        return {
            sig: this.chars(binary, offset, 4),
            text: this.nts(binary, offset + 8)
        };
    },
    /**
     * Decode a `desc` (textDescriptionType, V2) tag. ASCII portion only.
     *
     * TODO (P5): the V2 `desc` tag also carries a Unicode string and a
     * Macintosh ScriptCode string after the ASCII section. Both are
     * ignored here. Acceptable for V4 profiles (which use `mluc`
     * instead) and for the vast majority of V2 profiles in the wild
     * which fill in all three with the same string.
     * @returns {{sig:string, text:string, length:number}}
     */
    _textDescriptionType: function (binary, offset) {
        var AsciiLength = this.uint32(binary, offset + 8);
        return {
            sig: this.chars(binary, offset, 4),
            text: this.nts(binary, offset + 12),
            length: AsciiLength
        };
    },
    /**
     * Read a NUL-terminated ASCII string starting at `offset`, capped at
     * `maxLen` bytes (defaults to 1024). Stops at the first 0 byte
     * (exclusive).
     * @returns {string}
     */
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
    /**
     * Read a 3x3 V2 matrix as a flat array of 9 s15Fixed16Numbers
     * (row-major). 36 bytes.
     * @returns {number[]}
     */
    matrixV2: function (binary, offset) {
        var matrix = [];
        for (var i = 0; i < 9; i++) {
            matrix[i] = this.s15Fixed16Number(this.uint32(binary, offset));
            offset += 4;
        }
        return matrix;
    },
    /**
     * Read a 3x4 V4 matrix as a flat array of 12 s15Fixed16Numbers (the 3x3
     * linear part followed by the 3-element translation vector). 48 bytes.
     * Used by `mAB`/`mBA` LUTs.
     * @returns {number[]}
     */
    matrixV4: function (binary, offset) {
        var matrix = [];
        for (var i = 0; i < 12; i++) {
            matrix[i] = this.s15Fixed16Number(this.uint32(binary, offset));
            offset += 4;
        }
        return matrix;
    },
    /**
     * Decode a `view` (viewingConditionsType) tag.
     *
     * Note: only the standard-illuminant code is decoded as `measurement`
     * here. The full V4 `view` tag also carries the surround illuminant
     * geometry and observer index, which Profile.js doesn't currently use.
     * @returns {{sig:string, illuminant:object, surround:object, measurement:string}}
     */
    viewingConditions: function (binary, offset) {
        return {
            sig: this.chars(binary, offset, 4),
            illuminant: this.XYZNumber(binary, offset + 8),
            surround: this.XYZNumber(binary, offset + 20),
            measurement: this.illuminant2Text(this.uint32(binary, offset + 32))
        }
    },
    /**
     * Decode a `meas` (measurementType) tag. Returns the standard observer,
     * tristimulus value, geometry, flare and standard illuminant in
     * human-readable form.
     * @returns {{sig:string, observer:string, tristimulus:object, geometry:string, flare:string, illuminant:string}}
     */
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
    // ========================================================================
    //  ENUM DECODERS — small lookup tables for human-readable output
    // ========================================================================

    /**
     * Map a standard-observer code (0–2) to its human-readable name.
     * @returns {string}
     */
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
    /**
     * Map a measurement-geometry code (0–2) to its description.
     * @returns {string}
     */
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
    /**
     * Map a measurement-flare code (0 or 1) to its description.
     * @returns {string}
     */
    flare2Text: function (flare) {
        return (flare === 0) ? '0 (0 %)' : '1,0 (or 100 %)';
    },
    /**
     * Map a standard-illuminant code (0–8) to its short name.
     * @returns {string}
     */
    illuminant2Text: function (ill) {
        var illText = ['Unknown', 'D50', 'D65', 'D93', 'F2', 'D55', 'A', 'Equi-Power (E)', 'F8'];
        return illText[ill];
    },

    // ========================================================================
    //  CURVE READERS — `curv` (sampled TRC) and `para` (parametric)
    // ========================================================================

    /**
     * Read `count` consecutive curves (each `curv` or `para`) starting at
     * `offset`. Each curve is read with `curve()` and the cursor is
     * advanced by its `byteLength` (rounded up to the next 4-byte
     * alignment). If a curve reports an unknown length, iteration stops.
     *
     * Used by the `mAB`/`mBA` LUT readers for a/b/m curve banks.
     * @returns {object[]}
     */
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
    /**
     * Numerically invert a sampled tone curve by piecewise-linear
     * interpolation. Given `curve[i] = f(i / (N-1))`, returns a length-
     * `numPoints` array `inv[j]` such that `f(inv[j]) ≈ j / (numPoints-1)`.
     *
     * Limitations (acceptable for ICC TRCs in practice):
     *   - Assumes overall monotonic curve. Locally non-monotonic regions
     *     are searched for both increasing and decreasing intervals so
     *     mild wobble is tolerated, but a U-shape or similar will produce
     *     unreliable results.
     *   - `numPoints` must be ≥ 2. With `numPoints === 1` the step
     *     becomes Infinity. Caller's responsibility.
     *
     * @param {number[]|Float64Array} curve   Source samples in 0..1.
     * @param {number} numPoints              Output sample count.
     * @returns {number[]}                    Inverted samples in 0..1.
     */
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

    /**
     * Decode a single curve tag (`curv` or `para`).
     *
     * Returns an object describing the curve in several forms — pick the
     * one that suits the consumer:
     *
     *    .passThrough  true if the curve is the identity (skip it)
     *    .gamma        scalar gamma (set for `curv` count==1, `para`
     *                  type 0, and as a midpoint estimate for sampled
     *                  curves with count > 3)
     *    .data         Uint16Array of raw 16-bit samples (sampled curves)
     *    .dataf        Float64Array of normalized 0..1 samples
     *    .curveFn      function(params, x) for parametric curves
     *    .params       parameter array for parametric curves
     *    .byteLength   total bytes consumed (or `false` if unknown)
     *    .inverted     true if the curve has been pre-inverted
     *
     * @param {Uint8Array} binary
     * @param {number} offset
     * @param {boolean} [useInverse]
     *   For `curv`: numerically invert the sampled table once at decode
     *   time (so downstream reads are forward lookups). For `para`:
     *   install the closed-form inverse function instead of the forward
     *   one. Used for matrix-shaper inverse-TRC builds.
     * @param {number} [inverseCurveSteps=4096]
     *   Sample count for the numerical `curv` inverse.
     */
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

                        // Midpoint gamma estimate: solve 0.5^g = y(0.5)/65535
                        // Used downstream as a hint only (e.g. for picking a
                        // gamma-style fast path). Not a fit — sampled
                        // curves keep their .data/.dataf for actual eval.
                        // FIX (P2): index must be an integer; `count / 2`
                        // produced `undefined` for odd counts → NaN gamma.
                        if (curve.count > 3) {
                            var y = curve.data[Math.floor(curve.count / 2)];
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
                    console.warn('decodeICC: unknown parametricCurveType function type ' + functionType + ' at offset ' + offset);
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
                        // FIX (P1): per ICC.1:2010 Table 65, parametric type 3
                        // has 5 parameters (g, a, b, c, d) and the formula:
                        //     Y = (aX + b)^g     | X >= d
                        //     Y = cX             | X < d
                        // The previous implementation referenced params[5]
                        // and params[6] (i.e. the e/f offsets that only
                        // exist in type 4), which are `undefined` here and
                        // caused both forward and inverse to silently
                        // return NaN for every sample. Now matches the
                        // spec; type 4 below is the same shape with
                        // explicit e/f.
                        if (useInverse) {
                            // X = ((Y^(1/g)) - b) / a   | Y >= c*d
                            // X = Y / c                 | Y <  c*d
                            curve.curveFn = function (params, y) {
                                //y = Math.max(0.0, Math.min(1.0, y));
                                var disc = params[3] * params[4];
                                if (y >= disc) {
                                    if (y < 0) {
                                        return 0;
                                    }
                                    return (Math.pow(y, 1.0 / params[0]) - params[2]) / params[1];
                                }
                                return y / params[3];
                            }
                        } else {
                            // Y = (aX + b)^g | X >= d
                            // Y = cX         | X <  d
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
    // ========================================================================
    //  LUT READERS — mft1 (lut8), mft2 (lut16), mAB / mBA (V4 A2B/B2A)
    // ========================================================================

    /**
     * Decode an `AtoB`/`BtoA` lookup-table tag. Dispatches on the
     * 4-byte type signature:
     *
     *   mft1   lut8Type  — fixed 256-entry 8-bit input/output curves +
     *                       N-D 8-bit CLUT + optional 3x3 input matrix.
     *   mft2   lut16Type — variable-entry 16-bit input/output curves +
     *                       N-D 16-bit CLUT + optional 3x3 input matrix.
     *   mAB    lutAToB   — V4: A-curves → CLUT → M-curves → 3x4 matrix → B-curves.
     *   mBA    lutBToA   — V4: B-curves → 3x4 matrix → M-curves → CLUT → A-curves.
     *
     * Any subset of the V4 stages may be absent (offset == 0). The
     * decoded `lut` object exposes the stages directly for the runtime
     * pipeline to consume.
     *
     * Trailing fields `g1..g4` and `go0..go3` are precomputed CLUT stride
     * multipliers used by the interpolation hot path in `Transform.js`.
     *
     * On an unsupported `type`, returns a sentinel 2×2×2 zero-filled
     * 3-in/3-out LUT with `lut.invalid = true` and `lut.errorReason`
     * set, so callers can detect failure without the engine crashing
     * on undefined fields.
     *
     * @returns {object} lut descriptor
     */
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
                // FIX (P4): formerly fell through to the stride-precompute
                // block below with `gridPoints = []` and `outputChannels`
                // undefined, leaving every derived field as NaN/undefined
                // and silently producing an unusable LUT.
                //
                // We now populate a tiny, structurally-valid sentinel:
                // a 2×2×2 zero-filled 3-in / 3-out LUT marked with
                //   `lut.invalid = true`
                //   `lut.errorReason = 'unsupported LUT type "xxx"'`
                //
                // - New callers can opt in by checking `lut.invalid` and
                //   refusing the profile / picking a fallback transform.
                // - Legacy callers that don't check keep working: they
                //   get a black-clamped passthrough rather than a crash
                //   from `undefined` arithmetic in the interpolator.
                console.warn('decodeICC: unsupported LUT tag type "' + type + '" at offset ' + offset);
                lut.invalid = true;
                lut.errorReason = 'unsupported LUT type "' + type + '"';
                lut.inputChannels = 3;
                lut.outputChannels = 3;
                lut.precision = 8;
                lut.inputScale = 1;
                lut.outputScale = 1 / 255;
                lut.gridPoints = [2, 2, 2];
                lut.CLUT = new Uint8Array(2 * 2 * 2 * 3); // 24 zero bytes
                lut.inputCurve = false;
                lut.outputCurve = false;
                lut.matrix = false;
                lut.bCurves = false;
                lut.mCurves = false;
                lut.aCurves = false;
                break;
        }

        // Stride pre-compute for the interpolation hot path.
        // For 3D LUTs `gridPoints[3]` is undefined → g4 is NaN; that's
        // intentional (consumers only read up to g_inputChannels).
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
    /**
     * Decode the multi-dimensional CLUT block of a V4 `mAB`/`mBA` tag and
     * attach `CLUT`, `gridPoints`, `precision`, `inputScale`,
     * `outputScale` to the supplied `lut` object.
     *
     * Bytes 0..15 are the gridPoint-per-dimension array (16 dims max,
     * unused dims = 0), byte 16 is the precision (1 = 8-bit, 2 = 16-bit),
     * and byte 20 onwards is the CLUT itself.
     */
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

    // ========================================================================
    //  MULTI-PROCESS ELEMENTS — `mpet` (stub)
    // ========================================================================

    /**
     * Decode a `mpet` (multiProcessElementsType) tag — STUB IMPLEMENTATION.
     *
     * MPE was added in ICC v4 mainly for film and high-end workflows. Per
     * the ICC MPE white paper:
     *
     *   "CMM Support for Multi Processing Element Tag type is optional.
     *    This means that MPE based tag support is NOT guaranteed to be
     *    provided and implemented by CMMs in general! Additionally, all
     *    required tags must be present and valid."
     *
     *   https://www.color.org/whitepapers/ICC_White_Paper28-MultiProcessingElements.pdf
     *
     * Because the standard `AtoB`/`BtoA` tags MUST always be present and
     * valid in any conforming profile, the engine just leans on those.
     * This decoder returns the element signatures (`cvst`, `matf`,
     * `clut`, `bACS`, `eACS`) so callers can tell what was there, but
     * does not actually decode their bodies — `transform` does not
     * traverse MPE pipelines at runtime.
     *
     * @param {Uint8Array} binary
     * @param {number} offset
     * @returns {{inputChannels:number, outputChannels:number, elements:Array<{sig:string}>}}
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
                    console.warn('decodeICC: unknown MultiProcess element "' + sig + '" at offset ' + elementOffset);
            }
        }
        return {
            inputChannels: inputChannels,
            outputChannels: outputChannels,
            elements: elements
        };
    }
};
