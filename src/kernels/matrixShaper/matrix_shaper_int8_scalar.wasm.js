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

// ============================================================================
// matrix_shaper_int8_scalar.wasm.js — AUTO-GENERATED from matrix_shaper_int8_scalar.wat
// ============================================================================
//
// Do not edit by hand. Regenerate with:
//   node scripts/build_matrix_shaper_wasm.js
//
// Variant: 8-bit, scalar (no SIMD) — f32, bit-identical to the SIMD build
// Size: 1932 bytes .wasm
//
// Memory layout:
//   0 .. 1023  input gamma  256 x f32
//   1024 .. 66559  output gamma 65536 x u8
//   66560  matrix 9 x f32
//   66624  pixel data
// ============================================================================

'use strict';

var BASE64 = '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';

function decode(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    if (typeof atob !== 'undefined') {
        var bin = atob(b64), out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    throw new Error('No base64 decoder available (need Buffer or atob).');
}

module.exports = decode(BASE64);
module.exports.LAYOUT = {
    bits:         8,
    gammaInByte:  0,
    gammaOutByte: 1024,
    matrixByte:   66560,
    pixelByte:    66624,
    inEntries:    256,
    outIndexMax:   65535,
    outValueMax:   255,
    outEntryBytes: 1,
    indexRoot:     1
};
