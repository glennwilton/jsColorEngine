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
// tetra4d_nch.wasm.js — AUTO-GENERATED from tetra4d_nch.wat
// ============================================================================
//
// Do not edit by hand. Regenerate with:
//   node bench/wasm_poc/compile_wasm.js
//
// Source:  src/wasm/tetra4d_nch.wat
// Size:    2560 bytes .wasm
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
