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
// matrix_shaper_int16_scalar.wasm.js — AUTO-GENERATED from matrix_shaper_int16_scalar.wat
// ============================================================================
//
// Do not edit by hand. Regenerate with:
//   node scripts/build_matrix_shaper_wasm.js
//
// Variant: 16-bit, scalar (no SIMD) — f32, bit-identical to the SIMD build
// Size: 2024 bytes .wasm
//
// Memory layout:
//   0 .. 262143  input gamma  65536 x f32
//   262144 .. 524287  output gamma 65537 x f32, sqrt-indexed
//   524288  matrix 9 x f32
//   524352  pixel data
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
    bits:         16,
    gammaInByte:  0,
    gammaOutByte: 262144,
    matrixByte:   524288,
    pixelByte:    524352,
    inEntries:    65536,
    outIndexMax:   131071,
    outValueMax:   65535,
    outEntryBytes: 2,
    indexRoot:     4
};
