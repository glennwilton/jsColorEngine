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
// tetra4d_simd_int16.wasm.js — AUTO-GENERATED from tetra4d_simd_int16.wat
// ============================================================================
//
// Do not edit by hand. Regenerate with:
//   node bench/wasm_poc/compile_wasm.js
//
// Source:  src/wasm/tetra4d_simd_int16.wat
// Size:    1576 bytes .wasm
// ============================================================================

'use strict';

// Base64-encoded WebAssembly module bytes. Decoded once at module-load
// time into a Uint8Array, which is what WebAssembly.compile / .Module
// expects. Works identically in Node and browser (atob fallback for
// environments where Buffer is absent).
const BASE64 = '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';

function decode(b64) {
    if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
        return new Uint8Array(Buffer.from(b64, 'base64'));
    }
    if (typeof atob === 'function') {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }
    throw new Error('No base64 decoder available (need Buffer or atob).');
}

module.exports = decode(BASE64);
