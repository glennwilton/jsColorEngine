// ============================================================================
// tetra3d_simd.wasm.js — AUTO-GENERATED from tetra3d_simd.wat
// ============================================================================
//
// Do not edit by hand. Regenerate with:
//   node bench/wasm_poc/compile_wasm.js
//
// Source:  src/wasm/tetra3d_simd.wat
// Size:    1391 bytes .wasm
// ============================================================================

'use strict';

// Base64-encoded WebAssembly module bytes. Decoded once at module-load
// time into a Uint8Array, which is what WebAssembly.compile / .Module
// expects. Works identically in Node and browser (atob fallback for
// environments where Buffer is absent).
const BASE64 = 'AGFzbQEAAAABEgFgDn9/f39/f39/f39/f39/AAMCAQAFAwEAAQcgAgZtZW1vcnkCABNpbnRlcnBfdGV0cmEzZF9zaW1kAAAKpQoBogoCGH8LeyAAIQ8gASEQIAQhEQJAA0AgDiADTg0BIA8tAAAhEiAPLQABIRMgDy0AAiEUIA9BA2ohDyASIAhsIRUgEyAIbCEWIBQgCGwhFyASQf8BRgRAIAkhGCAJIRlBACEeBSAVQRB2IAdsIRggGCAHaiEZIBVBCHZB/wFxIR4LIBNB/wFGBEAgCiEaIAohG0EAIR8FIBZBEHYgBmwhGiAaIAZqIRsgFkEIdkH/AXEhHwsgFEH/AUYEQCALIRwgCyEdQQAhIAUgF0EQdiAFbCEcIBwgBWohHSAXQQh2Qf8BcSEgCyAe/REhKiAf/REhKyAg/REhLCAYIBpqIBxqISEgAiAhQQF0av1dAAD9qQEhKCAeIB9OIB8gIE5xBEAgGSAaaiAcaiEiIBkgG2ogHGohIyAZIBtqIB1qISUgAiAiQQF0av1dAAD9qQEhJiACICNBAXRq/V0AAP2pASEnIAIgJUEBdGr9XQAA/akBISkgJiAo/bEBICr9tQEgJyAm/bEBICv9tQH9rgEgKSAn/bEBICz9tQH9rgEhLQUgHiAgTiAgIB9OcQRAIBkgGmogHGohIiAZIBtqIB1qISMgGSAaaiAdaiEkIAIgJEEBdGr9XQAA/akBISYgAiAiQQF0av1dAAD9qQEhJyACICNBAXRq/V0AAP2pASEpICcgKP2xASAq/bUBICkgJv2xASAr/bUB/a4BICYgJ/2xASAs/bUB/a4BIS0FIB4gH04gICAeTnEEQCAZIBpqIB1qISIgGCAaaiAdaiEjIBkgG2ogHWohJCACICJBAXRq/V0AAP2pASEmIAIgI0EBdGr9XQAA/akBIScgAiAkQQF0av1dAAD9qQEhKSAmICf9sQEgKv21ASApICb9sQEgK/21Af2uASAnICj9sQEgLP21Af2uASEtBSAfIB5OIB4gIE5xBEAgGSAbaiAcaiEiIBggG2ogHGohIyAZIBtqIB1qISUgAiAjQQF0av1dAAD9qQEhJiACICJBAXRq/V0AAP2pASEnIAIgJUEBdGr9XQAA/akBISkgJyAm/bEBICr9tQEgJiAo/bEBICv9tQH9rgEgKSAn/bEBICz9tQH9rgEhLQUgHyAgTiAgIB5OcQRAIBkgG2ogHWohIiAYIBtqIB1qISMgGCAbaiAcaiEkIAIgI0EBdGr9XQAA/akBISYgAiAkQQF0av1dAAD9qQEhJyACICJBAXRq/V0AAP2pASEpICkgJv2xASAq/bUBICcgKP2xASAr/bUB/a4BICYgJ/2xASAs/bUB/a4BIS0FICAgH04gHyAeTnEEQCAZIBtqIB1qISIgGCAbaiAdaiEjIBggGmogHWohJSACICNBAXRq/V0AAP2pASEmIAIgJUEBdGr9XQAA/akBIScgAiAiQQF0av1dAAD9qQEhKSApICb9sQEgKv21ASAmICf9sQEgK/21Af2uASAnICj9sQEgLP21Af2uASEtBf0MAAAAAAAAAAAAAAAAAAAAACEtCwsLCwsLICggLf0MgAAAAIAAAACAAAAAgAAAAP2uAUEI/awB/a4BIS4gLv0MgAAAAIAAAACAAAAAgAAAAP2uAUEI/awBIS8gLyAv/YYBIC8gL/2GAf1mITAgECAw/VoAAAAgECARaiEQIA0gDHIEQCANQQJGBEAgECAPLQAAOgAAIBBBAWohECAPQQFqIQ8FIA1BAUYEQCAQQf8BOgAAIBBBAWohEAsgDyAMaiEPCwsgDkEBaiEODAALCws=';

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
