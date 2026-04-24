// ============================================================================
// tetra4d_simd.wasm.js — AUTO-GENERATED from tetra4d_simd.wat
// ============================================================================
//
// Do not edit by hand. Regenerate with:
//   node bench/wasm_poc/compile_wasm.js
//
// Source:  src/wasm/tetra4d_simd.wat
// Size:    1616 bytes .wasm
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
