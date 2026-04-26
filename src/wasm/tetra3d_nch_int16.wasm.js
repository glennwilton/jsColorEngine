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
// tetra3d_nch_int16.wasm.js — AUTO-GENERATED from tetra3d_nch_int16.wat
// ============================================================================
//
// Do not edit by hand. Regenerate with:
//   node bench/wasm_poc/compile_wasm.js
//
// Source:  src/wasm/tetra3d_nch_int16.wat
// Size:    1645 bytes .wasm
// ============================================================================

'use strict';

// Base64-encoded WebAssembly module bytes. Decoded once at module-load
// time into a Uint8Array, which is what WebAssembly.compile / .Module
// expects. Works identically in Node and browser (atob fallback for
// environments where Buffer is absent).
const BASE64 = 'AGFzbQEAAAABEgFgDn9/f39/f39/f39/f39/AAMCAQAFAwEAAQclAgZtZW1vcnkCABhpbnRlcnBfdGV0cmEzZF9uQ2hfaW50MTYAAAqeDAGbDAEefyAAIQ8gASEQAkADQCAOIANODQEgDy8BACERIA9BAmovAQAhEiAPQQRqLwEAIRMgD0EGaiEPIBEgCGwhFCASIAhsIRUgEyAIbCEWIBFB//8DRgRAIAkhFyAJIRhBACEdBSAUQQ12IAdsIRcgFyAHaiEYIBRB/z9xIR0LIBJB//8DRgRAIAohGSAKIRpBACEeBSAVQQ12IAZsIRkgGSAGaiEaIBVB/z9xIR4LIBNB//8DRgRAIAshGyALIRxBACEfBSAWQQ12IAVsIRsgGyAFaiEcIBZB/z9xIR8LIBcgGWogG2ohICAdIB5OIB4gH05xBEAgGCAZaiAbaiEhIBggGmogG2ohIiAYIBpqIBxqISRBACElA0AgAiAhQQF0ai8BACEmICFBAWohISACICJBAXRqLwEAIScgIkEBaiEiIAIgIEEBdGovAQAhKCAgQQFqISAgAiAkQQF0ai8BACEpICRBAWohJCAmIChrIB1sICcgJmsgHmxqICkgJ2sgH2xqISogKCAqQYAgakENdWohKyAQICs7AQAgEEECaiEQICVBAWoiJSAESA0ACwUgHSAfTiAfIB5OcQRAIBggGWogG2ohISAYIBpqIBxqISIgGCAZaiAcaiEjQQAhJQNAIAIgI0EBdGovAQAhJiAjQQFqISMgAiAhQQF0ai8BACEnICFBAWohISACICBBAXRqLwEAISggIEEBaiEgIAIgIkEBdGovAQAhKSAiQQFqISIgJyAoayAdbCApICZrIB5saiAmICdrIB9saiEqICggKkGAIGpBDXVqISsgECArOwEAIBBBAmohECAlQQFqIiUgBEgNAAsFIB0gHk4gHyAdTnEEQCAYIBlqIBxqISEgFyAZaiAcaiEiIBggGmogHGohI0EAISUDQCACICFBAXRqLwEAISYgIUEBaiEhIAIgIkEBdGovAQAhJyAiQQFqISIgAiAgQQF0ai8BACEoICBBAWohICACICNBAXRqLwEAISkgI0EBaiEjICYgJ2sgHWwgKSAmayAebGogJyAoayAfbGohKiAoICpBgCBqQQ11aiErIBAgKzsBACAQQQJqIRAgJUEBaiIlIARIDQALBSAeIB1OIB0gH05xBEAgGCAaaiAbaiEhIBcgGmogG2ohIiAYIBpqIBxqISRBACElA0AgAiAiQQF0ai8BACEmICJBAWohIiACICFBAXRqLwEAIScgIUEBaiEhIAIgIEEBdGovAQAhKCAgQQFqISAgAiAkQQF0ai8BACEpICRBAWohJCAnICZrIB1sICYgKGsgHmxqICkgJ2sgH2xqISogKCAqQYAgakENdWohKyAQICs7AQAgEEECaiEQICVBAWoiJSAESA0ACwUgHiAfTiAfIB1OcQRAIBggGmogHGohISAXIBpqIBxqISIgFyAaaiAbaiEjQQAhJQNAIAIgIkEBdGovAQAhJiAiQQFqISIgAiAjQQF0ai8BACEnICNBAWohIyACICBBAXRqLwEAISggIEEBaiEgIAIgIUEBdGovAQAhKSAhQQFqISEgKSAmayAdbCAnIChrIB5saiAmICdrIB9saiEqICggKkGAIGpBDXVqISsgECArOwEAIBBBAmohECAlQQFqIiUgBEgNAAsFIB8gHk4gHiAdTnEEQCAYIBpqIBxqISEgFyAaaiAcaiEiIBcgGWogHGohJEEAISUDQCACICJBAXRqLwEAISYgIkEBaiEiIAIgJEEBdGovAQAhJyAkQQFqISQgAiAgQQF0ai8BACEoICBBAWohICACICFBAXRqLwEAISkgIUEBaiEhICkgJmsgHWwgJiAnayAebGogJyAoayAfbGohKiAoICpBgCBqQQ11aiErIBAgKzsBACAQQQJqIRAgJUEBaiIlIARIDQALBUEAISUDQCACICBBAXRqLwEAISggIEEBaiEgIBAgKDsBACAQQQJqIRAgJUEBaiIlIARIDQALCwsLCwsLIA1BAkYEQCAQIA8vAQA7AQAgEEECaiEQIA9BAmohDwUgDUEBRgRAIBBB//8DOwEAIBBBAmohEAsgDyAMQQF0aiEPCyAOQQFqIQ4MAAsLCw==';

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
