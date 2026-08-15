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
// tetra3d_nch.wasm.js — AUTO-GENERATED from tetra3d_nch.wat
// ============================================================================
//
// Do not edit by hand. Regenerate with:
//   node bench/wasm_poc/compile_wasm.js
//
// Source:  src/wasm/tetra3d_nch.wat
// Size:    1900 bytes .wasm
// ============================================================================

'use strict';

// Base64-encoded WebAssembly module bytes. Decoded once at module-load
// time into a Uint8Array, which is what WebAssembly.compile / .Module
// expects. Works identically in Node and browser (atob fallback for
// environments where Buffer is absent).
const BASE64 = 'AGFzbQEAAAABEgFgDn9/f39/f39/f39/f39/AAMCAQAFAwEAAQcfAgZtZW1vcnkCABJpbnRlcnBfdGV0cmEzZF9uQ2gAAAqjDgGgDgEffyAAIQ8gASEQAkADQCAOIANODQEgDy0AACERIA9BAWotAAAhEiAPQQJqLQAAIRMgD0EDaiEPIBEgCGwhFCASIAhsIRUgEyAIbCEWIBFB/wFGBEAgCSEXIAkhGEEAIR0FIBRBEHYgB2whFyAXIAdqIRggFEEIdkH/AXEhHQsgEkH/AUYEQCAKIRkgCiEaQQAhHgUgFUEQdiAGbCEZIBkgBmohGiAVQQh2Qf8BcSEeCyATQf8BRgRAIAshGyALIRxBACEfBSAWQRB2IAVsIRsgGyAFaiEcIBZBCHZB/wFxIR8LIBcgGWogG2ohICAdIB5OIB4gH05xBEAgGCAZaiAbaiEhIBggGmogG2ohIiAYIBpqIBxqISRBACElA0AgAiAhQQF0ai8BACEmICFBAWohISACICJBAXRqLwEAIScgIkEBaiEiIAIgIEEBdGovAQAhKCAgQQFqISAgAiAkQQF0ai8BACEpICRBAWohJCAmIChrIB1sICcgJmsgHmxqICkgJ2sgH2xqISogKCAqQYABakEIdWohKyArQYABakEIdSEsICxBACAsQQBOGyEsICxB/wEgLEGAAkgbISwgECAsOgAAIBBBAWohECAlQQFqIiUgBEgNAAsFIB0gH04gHyAeTnEEQCAYIBlqIBtqISEgGCAaaiAcaiEiIBggGWogHGohI0EAISUDQCACICNBAXRqLwEAISYgI0EBaiEjIAIgIUEBdGovAQAhJyAhQQFqISEgAiAgQQF0ai8BACEoICBBAWohICACICJBAXRqLwEAISkgIkEBaiEiICcgKGsgHWwgKSAmayAebGogJiAnayAfbGohKiAoICpBgAFqQQh1aiErICtBgAFqQQh1ISwgLEEAICxBAE4bISwgLEH/ASAsQYACSBshLCAQICw6AAAgEEEBaiEQICVBAWoiJSAESA0ACwUgHSAeTiAfIB1OcQRAIBggGWogHGohISAXIBlqIBxqISIgGCAaaiAcaiEjQQAhJQNAIAIgIUEBdGovAQAhJiAhQQFqISEgAiAiQQF0ai8BACEnICJBAWohIiACICBBAXRqLwEAISggIEEBaiEgIAIgI0EBdGovAQAhKSAjQQFqISMgJiAnayAdbCApICZrIB5saiAnIChrIB9saiEqICggKkGAAWpBCHVqISsgK0GAAWpBCHUhLCAsQQAgLEEAThshLCAsQf8BICxBgAJIGyEsIBAgLDoAACAQQQFqIRAgJUEBaiIlIARIDQALBSAeIB1OIB0gH05xBEAgGCAaaiAbaiEhIBcgGmogG2ohIiAYIBpqIBxqISRBACElA0AgAiAiQQF0ai8BACEmICJBAWohIiACICFBAXRqLwEAIScgIUEBaiEhIAIgIEEBdGovAQAhKCAgQQFqISAgAiAkQQF0ai8BACEpICRBAWohJCAnICZrIB1sICYgKGsgHmxqICkgJ2sgH2xqISogKCAqQYABakEIdWohKyArQYABakEIdSEsICxBACAsQQBOGyEsICxB/wEgLEGAAkgbISwgECAsOgAAIBBBAWohECAlQQFqIiUgBEgNAAsFIB4gH04gHyAdTnEEQCAYIBpqIBxqISEgFyAaaiAcaiEiIBcgGmogG2ohI0EAISUDQCACICJBAXRqLwEAISYgIkEBaiEiIAIgI0EBdGovAQAhJyAjQQFqISMgAiAgQQF0ai8BACEoICBBAWohICACICFBAXRqLwEAISkgIUEBaiEhICkgJmsgHWwgJyAoayAebGogJiAnayAfbGohKiAoICpBgAFqQQh1aiErICtBgAFqQQh1ISwgLEEAICxBAE4bISwgLEH/ASAsQYACSBshLCAQICw6AAAgEEEBaiEQICVBAWoiJSAESA0ACwUgHyAeTiAeIB1OcQRAIBggGmogHGohISAXIBpqIBxqISIgFyAZaiAcaiEkQQAhJQNAIAIgIkEBdGovAQAhJiAiQQFqISIgAiAkQQF0ai8BACEnICRBAWohJCACICBBAXRqLwEAISggIEEBaiEgIAIgIUEBdGovAQAhKSAhQQFqISEgKSAmayAdbCAmICdrIB5saiAnIChrIB9saiEqICggKkGAAWpBCHVqISsgK0GAAWpBCHUhLCAsQQAgLEEAThshLCAsQf8BICxBgAJIGyEsIBAgLDoAACAQQQFqIRAgJUEBaiIlIARIDQALBUEAISUDQCACICBBAXRqLwEAISggIEEBaiEgIChBgAFqQQh1ISwgLEEAICxBAE4bISwgLEH/ASAsQYACSBshLCAQICw6AAAgEEEBaiEQICVBAWoiJSAESA0ACwsLCwsLCyANQQJGBEAgECAPLQAAOgAAIBBBAWohECAPQQFqIQ8FIA1BAUYEQCAQQf8BOgAAIBBBAWohEAsgDyAMaiEPCyAOQQFqIQ4MAAsLCw==';

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
