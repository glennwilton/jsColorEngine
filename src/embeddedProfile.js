/*************************************************************************
 *  @license
 *
 *  Copyright © 2019, 2026 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 *  jsColorEngine is free software: you can redistribute it and/or modify
 *  it under the terms of the Mozilla Public License, v. 2.0.
 *  If a copy of the MPL was not distributed with this file, You can
 *  obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

/**
 * ============================================================================
 *  embeddedProfile.js — pull an ICC profile out of an image file
 * ============================================================================
 *
 *  Used by Profile.loadBinary(bytes, callback, true). Each container keeps
 *  the profile differently, and none of them can be found by scanning for a
 *  marker:
 *
 *      JPEG   APP2 segments marked "ICC_PROFILE\0", at most 65519 bytes of
 *             profile each, numbered. Anything over 64 KB is split and has
 *             to be put back together in order.
 *      TIFF   tag 34675 in an image file directory. The value is the profile,
 *             whole and uncompressed, wherever in the file the writer put it.
 *             Image compression (LZW, ZIP, JPEG) applies to the pixel strips
 *             only and never to this tag.
 *      PNG    one iCCP chunk before the image data: a name, a zero byte, a
 *             compression method, then the profile as a zlib stream. It is
 *             always compressed, so this file carries a small inflate.
 *
 *  Everything here reads untrusted bytes. Every offset and length is checked
 *  against the buffer, loops are bounded, and anything that does not add up
 *  returns null rather than throwing.
 *
 *  BigTIFF (version 43) is not read.
 */

/**
 * @param {Uint8Array} bytes  an image file, or at least the part of it that
 *                            holds the profile
 * @returns {Uint8Array|null} the profile bytes, or null if the container is
 *                            not recognised or carries no complete profile
 */
function extractEmbeddedProfile(bytes) {
    if (!bytes || bytes.length < 12) {
        return null;
    }
    try {
        if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
            return profileFromJpeg(bytes);
        }
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
            bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A) {
            return profileFromPng(bytes);
        }
        if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0) ||
            (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[2] === 0 && bytes[3] === 42)) {
            return profileFromTiff(bytes);
        }
    } catch (error) {
        return null;
    }
    return null;
}

/**
 * True if the bytes start like one of the containers read here. Lets the
 * caller tell "not an image I know" from "an image with no profile".
 *
 * @param {Uint8Array} bytes
 * @returns {string|false} 'JPEG', 'PNG', 'TIFF' or false
 */
function embeddedContainerType(bytes) {
    if (!bytes || bytes.length < 4) {
        return false;
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
        return 'JPEG';
    }
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'PNG';
    }
    if ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 42 && bytes[3] === 0) ||
        (bytes[0] === 0x4D && bytes[1] === 0x4D && bytes[2] === 0 && bytes[3] === 42)) {
        return 'TIFF';
    }
    return false;
}

/**
 * For bytes that are not one of the containers above: the profile itself, or
 * a file that holds one whole and uncompressed somewhere inside it (a PSD and
 * a WebP both do).
 *
 * A profile header carries "acsp" 36 bytes in and its own length in the first
 * four. A candidate counts only if that length is at least a header and fits
 * in the bytes that are left, which is what stops a stray "acsp" in pixel
 * data from being taken for a profile.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array|null} the profile bytes, or null
 */
function findProfileInBytes(bytes) {
    if (!bytes || bytes.length < 128) {
        return null;
    }
    var lastStart = bytes.length - 128;
    for (var signature = 36; signature - 36 <= lastStart; signature++) {
        if (bytes[signature] !== 0x61 || bytes[signature + 1] !== 0x63 ||
            bytes[signature + 2] !== 0x73 || bytes[signature + 3] !== 0x70) {
            continue;
        }
        var start = signature - 36;
        var declaredSize = ((bytes[start] << 24) | (bytes[start + 1] << 16) | (bytes[start + 2] << 8) | bytes[start + 3]) >>> 0;
        if (declaredSize >= 128 && start + declaredSize <= bytes.length) {
            return bytes.subarray(start, start + declaredSize);
        }
    }
    return null;
}

// ----------------------------------------------------------------------------
//  JPEG
// ----------------------------------------------------------------------------

function profileFromJpeg(bytes) {
    var marker = [73, 67, 67, 95, 80, 82, 79, 70, 73, 76, 69, 0]; // ICC_PROFILE, then 0
    var chunks = [];
    var chunkTotal = 0;
    var position = 2;

    while (position + 4 <= bytes.length && bytes[position] === 0xFF) {
        var segmentType = bytes[position + 1];
        // Start of scan or end of image: the header segments are over.
        if (segmentType === 0xDA || segmentType === 0xD9) {
            break;
        }
        var segmentLength = (bytes[position + 2] << 8) | bytes[position + 3];
        if (segmentLength < 2) {
            break;
        }
        var payload = position + 4;
        var payloadEnd = Math.min(position + 2 + segmentLength, bytes.length);

        if (segmentType === 0xE2 && payloadEnd - payload > 14) {
            var isProfile = true;
            for (var markerIndex = 0; markerIndex < marker.length; markerIndex++) {
                if (bytes[payload + markerIndex] !== marker[markerIndex]) { isProfile = false; break; }
            }
            if (isProfile) {
                var sequence = bytes[payload + 12];
                chunkTotal = bytes[payload + 13];
                chunks[sequence] = bytes.subarray(payload + 14, payloadEnd);
            }
        }
        position += 2 + segmentLength;
    }

    if (chunkTotal === 0) {
        return null;
    }
    var size = 0;
    var chunkIndex;
    for (chunkIndex = 1; chunkIndex <= chunkTotal; chunkIndex++) {
        if (!chunks[chunkIndex]) {
            return null; // a segment is missing, so there is no whole profile
        }
        size += chunks[chunkIndex].length;
    }
    var profile = new Uint8Array(size);
    var written = 0;
    for (chunkIndex = 1; chunkIndex <= chunkTotal; chunkIndex++) {
        profile.set(chunks[chunkIndex], written);
        written += chunks[chunkIndex].length;
    }
    return profile;
}

// ----------------------------------------------------------------------------
//  TIFF
// ----------------------------------------------------------------------------

var TIFF_ICC_PROFILE_TAG = 34675;
var TIFF_MAX_DIRECTORIES = 64;

function profileFromTiff(bytes) {
    var littleEndian = bytes[0] === 0x49;
    var length = bytes.length;

    function uint16At(offset) {
        return littleEndian
            ? bytes[offset] | (bytes[offset + 1] << 8)
            : (bytes[offset] << 8) | bytes[offset + 1];
    }
    function uint32At(offset) {
        return (littleEndian
            ? bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)
            : (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    }

    var directoryOffset = uint32At(4);
    for (var directory = 0; directory < TIFF_MAX_DIRECTORIES; directory++) {
        if (directoryOffset < 8 || directoryOffset + 2 > length) {
            return null;
        }
        var entryCount = uint16At(directoryOffset);
        var entriesEnd = directoryOffset + 2 + entryCount * 12;
        if (entriesEnd > length) {
            return null;
        }
        for (var entry = 0; entry < entryCount; entry++) {
            var entryOffset = directoryOffset + 2 + entry * 12;
            if (uint16At(entryOffset) !== TIFF_ICC_PROFILE_TAG) {
                continue;
            }
            var byteCount = uint32At(entryOffset + 4);
            var valueOffset = uint32At(entryOffset + 8);
            if (byteCount < 128 || valueOffset + byteCount > length) {
                return null;
            }
            return bytes.subarray(valueOffset, valueOffset + byteCount);
        }
        if (entriesEnd + 4 > length) {
            return null;
        }
        var nextDirectory = uint32At(entriesEnd);
        // The chain ends at 0. A link that does not move forward is a loop.
        if (nextDirectory === 0 || nextDirectory <= directoryOffset) {
            return null;
        }
        directoryOffset = nextDirectory;
    }
    return null;
}

// ----------------------------------------------------------------------------
//  PNG
// ----------------------------------------------------------------------------

// Far larger than any real profile, and small enough that a crafted stream
// cannot be used to exhaust memory.
var PNG_MAX_PROFILE_BYTES = 64 * 1024 * 1024;

function profileFromPng(bytes) {
    var length = bytes.length;
    var position = 8;

    while (position + 12 <= length) {
        var chunkLength = ((bytes[position] << 24) | (bytes[position + 1] << 16) | (bytes[position + 2] << 8) | bytes[position + 3]) >>> 0;
        var chunkType = String.fromCharCode(bytes[position + 4], bytes[position + 5], bytes[position + 6], bytes[position + 7]);
        var dataStart = position + 8;
        var dataEnd = dataStart + chunkLength;

        // The profile has to come before the image data.
        if (chunkType === 'IDAT' || chunkType === 'IEND') {
            return null;
        }
        if (chunkType === 'iCCP') {
            if (dataEnd > length) {
                return null;
            }
            // Profile name: 1 to 79 bytes, then a zero.
            var nameEnd = dataStart;
            while (nameEnd < dataEnd && nameEnd - dataStart < 80 && bytes[nameEnd] !== 0) {
                nameEnd++;
            }
            if (nameEnd >= dataEnd || bytes[nameEnd] !== 0) {
                return null;
            }
            // Compression method: 0, zlib deflate, is the only one defined.
            if (bytes[nameEnd + 1] !== 0) {
                return null;
            }
            return inflateZlib(bytes, nameEnd + 2, dataEnd, PNG_MAX_PROFILE_BYTES);
        }
        position = dataEnd + 4; // skip the CRC
    }
    return null;
}

// ----------------------------------------------------------------------------
//  Inflate (RFC 1950 zlib wrapper around RFC 1951 deflate)
// ----------------------------------------------------------------------------
//
//  Decodes one bit at a time against canonical Huffman tables, the way zlib's
//  own reference decoder (puff) does. It is not fast, and does not need to be:
//  it runs once per profile, on at most a few megabytes.

var LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
var LENGTH_EXTRA_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
var DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
var DISTANCE_EXTRA_BITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
var CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * @param {Uint8Array} bytes
 * @param {number} start       first byte of the zlib stream
 * @param {number} end         one past its last byte
 * @param {number} maxOutput   refuse to produce more than this
 * @returns {Uint8Array|null}  the decompressed data, or null if the stream is
 *                             damaged, truncated or over the limit
 */
function inflateZlib(bytes, start, end, maxOutput) {
    if (end - start < 6) {
        return null;
    }
    var compressionInfo = bytes[start];
    var flags = bytes[start + 1];
    // Method 8 (deflate), header check, and no preset dictionary.
    if ((compressionInfo & 0x0F) !== 8 || ((compressionInfo << 8) | flags) % 31 !== 0 || (flags & 0x20)) {
        return null;
    }

    var position = start + 2;
    var bitBuffer = 0;
    var bitCount = 0;
    var output = new Uint8Array(Math.min(maxOutput, Math.max(1024, (end - start) * 4)));
    var outputLength = 0;
    var failed = false;

    function readBits(count) {
        while (bitCount < count) {
            if (position >= end) {
                failed = true;
                return 0;
            }
            bitBuffer |= bytes[position++] << bitCount;
            bitCount += 8;
        }
        var value = bitBuffer & ((1 << count) - 1);
        bitBuffer >>>= count;
        bitCount -= count;
        return value;
    }

    function reserve(extra) {
        if (outputLength + extra <= output.length) {
            return true;
        }
        if (outputLength + extra > maxOutput) {
            failed = true;
            return false;
        }
        var larger = new Uint8Array(Math.min(maxOutput, Math.max(output.length * 2, outputLength + extra)));
        larger.set(output.subarray(0, outputLength));
        output = larger;
        return true;
    }

    function buildTable(codeLengths, symbolCount) {
        var counts = new Uint16Array(16);
        var symbols = new Uint16Array(symbolCount);
        var symbol, bitLength;
        for (symbol = 0; symbol < symbolCount; symbol++) {
            counts[codeLengths[symbol]]++;
        }
        counts[0] = 0;
        // More codes of a length than that length can hold is not a Huffman code.
        var remaining = 1;
        for (bitLength = 1; bitLength < 16; bitLength++) {
            remaining = (remaining << 1) - counts[bitLength];
            if (remaining < 0) {
                failed = true;
                return null;
            }
        }
        var offsets = new Uint16Array(16);
        for (bitLength = 1; bitLength < 15; bitLength++) {
            offsets[bitLength + 1] = offsets[bitLength] + counts[bitLength];
        }
        for (symbol = 0; symbol < symbolCount; symbol++) {
            if (codeLengths[symbol] !== 0) {
                symbols[offsets[codeLengths[symbol]]++] = symbol;
            }
        }
        return {counts: counts, symbols: symbols};
    }

    function decodeSymbol(table) {
        var code = 0;
        var first = 0;
        var index = 0;
        for (var bitLength = 1; bitLength < 16; bitLength++) {
            code |= readBits(1);
            if (failed) {
                return -1;
            }
            var count = table.counts[bitLength];
            if (code - count < first) {
                return table.symbols[index + (code - first)];
            }
            index += count;
            first = (first + count) << 1;
            code <<= 1;
        }
        failed = true;
        return -1;
    }

    function inflateBlock(lengthTable, distanceTable) {
        for (;;) {
            var symbol = decodeSymbol(lengthTable);
            if (failed) {
                return;
            }
            if (symbol < 256) {
                if (!reserve(1)) {
                    return;
                }
                output[outputLength++] = symbol;
            } else if (symbol === 256) {
                return;
            } else {
                symbol -= 257;
                if (symbol >= 29) {
                    failed = true;
                    return;
                }
                var runLength = LENGTH_BASE[symbol] + readBits(LENGTH_EXTRA_BITS[symbol]);
                var distanceSymbol = decodeSymbol(distanceTable);
                if (failed || distanceSymbol >= 30) {
                    failed = true;
                    return;
                }
                var distance = DISTANCE_BASE[distanceSymbol] + readBits(DISTANCE_EXTRA_BITS[distanceSymbol]);
                if (failed || distance > outputLength || !reserve(runLength)) {
                    failed = true;
                    return;
                }
                // Byte by byte on purpose: the run may overlap its own output.
                for (var copied = 0; copied < runLength; copied++) {
                    output[outputLength] = output[outputLength - distance];
                    outputLength++;
                }
            }
        }
    }

    var fixedLengthTable = null;
    var fixedDistanceTable = null;
    var lastBlock;
    do {
        lastBlock = readBits(1);
        var blockType = readBits(2);
        if (failed) {
            return null;
        }

        if (blockType === 0) {
            // Stored: drop the rest of the current byte, then length and its complement.
            bitBuffer = 0;
            bitCount = 0;
            if (position + 4 > end) {
                return null;
            }
            var storedLength = bytes[position] | (bytes[position + 1] << 8);
            var storedCheck = bytes[position + 2] | (bytes[position + 3] << 8);
            position += 4;
            if (storedLength !== (~storedCheck & 0xFFFF) || position + storedLength > end || !reserve(storedLength)) {
                return null;
            }
            output.set(bytes.subarray(position, position + storedLength), outputLength);
            outputLength += storedLength;
            position += storedLength;

        } else if (blockType === 1) {
            if (!fixedLengthTable) {
                var fixedLengths = new Uint8Array(288);
                var fixedSymbol;
                for (fixedSymbol = 0; fixedSymbol < 144; fixedSymbol++) { fixedLengths[fixedSymbol] = 8; }
                for (; fixedSymbol < 256; fixedSymbol++) { fixedLengths[fixedSymbol] = 9; }
                for (; fixedSymbol < 280; fixedSymbol++) { fixedLengths[fixedSymbol] = 7; }
                for (; fixedSymbol < 288; fixedSymbol++) { fixedLengths[fixedSymbol] = 8; }
                fixedLengthTable = buildTable(fixedLengths, 288);
                var fixedDistances = new Uint8Array(30);
                for (fixedSymbol = 0; fixedSymbol < 30; fixedSymbol++) { fixedDistances[fixedSymbol] = 5; }
                fixedDistanceTable = buildTable(fixedDistances, 30);
            }
            inflateBlock(fixedLengthTable, fixedDistanceTable);

        } else if (blockType === 2) {
            var lengthCodeCount = readBits(5) + 257;
            var distanceCodeCount = readBits(5) + 1;
            var codeLengthCodeCount = readBits(4) + 4;
            if (failed || lengthCodeCount > 286 || distanceCodeCount > 30) {
                return null;
            }
            var codeLengths = new Uint8Array(320);
            var index;
            for (index = 0; index < codeLengthCodeCount; index++) {
                codeLengths[CODE_LENGTH_ORDER[index]] = readBits(3);
            }
            var codeLengthTable = buildTable(codeLengths.subarray(0, 19), 19);
            if (failed) {
                return null;
            }
            var allLengths = new Uint8Array(320);
            index = 0;
            while (index < lengthCodeCount + distanceCodeCount) {
                var lengthSymbol = decodeSymbol(codeLengthTable);
                if (failed) {
                    return null;
                }
                if (lengthSymbol < 16) {
                    allLengths[index++] = lengthSymbol;
                } else {
                    var repeated = 0;
                    var repeatCount;
                    if (lengthSymbol === 16) {
                        if (index === 0) {
                            return null;
                        }
                        repeated = allLengths[index - 1];
                        repeatCount = 3 + readBits(2);
                    } else if (lengthSymbol === 17) {
                        repeatCount = 3 + readBits(3);
                    } else {
                        repeatCount = 11 + readBits(7);
                    }
                    if (failed || index + repeatCount > lengthCodeCount + distanceCodeCount) {
                        return null;
                    }
                    while (repeatCount--) {
                        allLengths[index++] = repeated;
                    }
                }
            }
            // Without an end-of-block code the block could never finish.
            if (allLengths[256] === 0) {
                return null;
            }
            var dynamicLengthTable = buildTable(allLengths.subarray(0, lengthCodeCount), lengthCodeCount);
            var dynamicDistanceTable = buildTable(allLengths.subarray(lengthCodeCount, lengthCodeCount + distanceCodeCount), distanceCodeCount);
            if (failed) {
                return null;
            }
            inflateBlock(dynamicLengthTable, dynamicDistanceTable);

        } else {
            return null;
        }
        if (failed) {
            return null;
        }
    } while (!lastBlock);

    // Adler-32 of the output follows, on a byte boundary.
    if (position + 4 > end) {
        return null;
    }
    var expectedChecksum = ((bytes[position] << 24) | (bytes[position + 1] << 16) | (bytes[position + 2] << 8) | bytes[position + 3]) >>> 0;
    var sumA = 1;
    var sumB = 0;
    for (var outputIndex = 0; outputIndex < outputLength;) {
        // 3800 bytes is the most that can be summed before the modulo is needed.
        var blockEnd = Math.min(outputIndex + 3800, outputLength);
        for (; outputIndex < blockEnd; outputIndex++) {
            sumA += output[outputIndex];
            sumB += sumA;
        }
        sumA %= 65521;
        sumB %= 65521;
    }
    if ((((sumB << 16) | sumA) >>> 0) !== expectedChecksum) {
        return null;
    }
    return output.slice(0, outputLength);
}

module.exports = {
    extractEmbeddedProfile: extractEmbeddedProfile,
    embeddedContainerType: embeddedContainerType,
    findProfileInBytes: findProfileInBytes,
    inflateZlib: inflateZlib
};
