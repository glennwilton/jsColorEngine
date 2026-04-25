// ============================================================================
// tetra4d_nch_int16.wasm.js — AUTO-GENERATED from tetra4d_nch_int16.wat
// ============================================================================
//
// Do not edit by hand. Regenerate with:
//   node bench/wasm_poc/compile_wasm.js
//
// Source:  src/wasm/tetra4d_nch_int16.wat
// Size:    2288 bytes .wasm
// ============================================================================

'use strict';

// Base64-encoded WebAssembly module bytes. Decoded once at module-load
// time into a Uint8Array, which is what WebAssembly.compile / .Module
// expects. Works identically in Node and browser (atob fallback for
// environments where Buffer is absent).
const BASE64 = 'AGFzbQEAAAABFQFgEX9/f39/f39/f39/f39/f39/AAMCAQAFAwEAAQclAgZtZW1vcnkCABhpbnRlcnBfdGV0cmE0ZF9uQ2hfaW50MTYAAAqeEQGbEQEnfyAAIRIgASETAkADQCARIANODQEgEi8BACEUIBJBAmovAQAhFSASQQRqLwEAIRYgEkEGai8BACEXIBJBCGohEiAUIAlsIRggFSAJbCEZIBYgCWwhGiAXIAlsIRsgFEH//wNGBEAgDSEiQQAhJgUgGEENdiAIbCEiIBhB/z9xISYLICZBAEchLSAVQf//A0YEQCAKIRwgCiEdQQAhIwUgGUENdiAHbCEcIBwgB2ohHSAZQf8/cSEjCyAWQf//A0YEQCALIR4gCyEfQQAhJAUgGkENdiAGbCEeIB4gBmohHyAaQf8/cSEkCyAXQf//A0YEQCAMISAgDCEhQQAhJQUgG0ENdiAFbCEgICAgBWohISAbQf8/cSElC0EAISwgLSEuAkADQCAcIB5qICBqICJqIScgIyAkTiAkICVOcQRAIB0gHmogIGogImohKCAdIB9qICBqICJqISkgHSAfaiAhaiAiaiErQQAhLwNAIAIgKEEBdGovAQAhMCAoQQFqISggAiApQQF0ai8BACExIClBAWohKSACICdBAXRqLwEAITIgJ0EBaiEnIAIgK0EBdGovAQAhMyArQQFqISsgMCAyayAjbCAxIDBrICRsaiAzIDFrICVsaiE0IDIgNEGAIGpBDXVqITUgLkEBRgRAIA4gL0ECdGogNTYCAAUgLkECRgRAIA4gL0ECdGooAgAhNiA2IDUgNmsgJmxBgCBqQQ11aiE3BSA1ITcLIBMgNzsBACATQQJqIRMLIC9BAWoiLyAESA0ACwUgIyAlTiAlICROcQRAIB0gHmogIGogImohKCAdIB9qICFqICJqISkgHSAeaiAhaiAiaiEqQQAhLwNAIAIgKkEBdGovAQAhMCAqQQFqISogAiAoQQF0ai8BACExIChBAWohKCACICdBAXRqLwEAITIgJ0EBaiEnIAIgKUEBdGovAQAhMyApQQFqISkgMSAyayAjbCAzIDBrICRsaiAwIDFrICVsaiE0IDIgNEGAIGpBDXVqITUgLkEBRgRAIA4gL0ECdGogNTYCAAUgLkECRgRAIA4gL0ECdGooAgAhNiA2IDUgNmsgJmxBgCBqQQ11aiE3BSA1ITcLIBMgNzsBACATQQJqIRMLIC9BAWoiLyAESA0ACwUgIyAkTiAlICNOcQRAIB0gHmogIWogImohKCAcIB5qICFqICJqISkgHSAfaiAhaiAiaiEqQQAhLwNAIAIgKEEBdGovAQAhMCAoQQFqISggAiApQQF0ai8BACExIClBAWohKSACICdBAXRqLwEAITIgJ0EBaiEnIAIgKkEBdGovAQAhMyAqQQFqISogMCAxayAjbCAzIDBrICRsaiAxIDJrICVsaiE0IDIgNEGAIGpBDXVqITUgLkEBRgRAIA4gL0ECdGogNTYCAAUgLkECRgRAIA4gL0ECdGooAgAhNiA2IDUgNmsgJmxBgCBqQQ11aiE3BSA1ITcLIBMgNzsBACATQQJqIRMLIC9BAWoiLyAESA0ACwUgJCAjTiAjICVOcQRAIB0gH2ogIGogImohKCAcIB9qICBqICJqISkgHSAfaiAhaiAiaiErQQAhLwNAIAIgKUEBdGovAQAhMCApQQFqISkgAiAoQQF0ai8BACExIChBAWohKCACICdBAXRqLwEAITIgJ0EBaiEnIAIgK0EBdGovAQAhMyArQQFqISsgMSAwayAjbCAwIDJrICRsaiAzIDFrICVsaiE0IDIgNEGAIGpBDXVqITUgLkEBRgRAIA4gL0ECdGogNTYCAAUgLkECRgRAIA4gL0ECdGooAgAhNiA2IDUgNmsgJmxBgCBqQQ11aiE3BSA1ITcLIBMgNzsBACATQQJqIRMLIC9BAWoiLyAESA0ACwUgJCAlTiAlICNOcQRAIB0gH2ogIWogImohKCAcIB9qICFqICJqISkgHCAfaiAgaiAiaiEqQQAhLwNAIAIgKUEBdGovAQAhMCApQQFqISkgAiAqQQF0ai8BACExICpBAWohKiACICdBAXRqLwEAITIgJ0EBaiEnIAIgKEEBdGovAQAhMyAoQQFqISggMyAwayAjbCAxIDJrICRsaiAwIDFrICVsaiE0IDIgNEGAIGpBDXVqITUgLkEBRgRAIA4gL0ECdGogNTYCAAUgLkECRgRAIA4gL0ECdGooAgAhNiA2IDUgNmsgJmxBgCBqQQ11aiE3BSA1ITcLIBMgNzsBACATQQJqIRMLIC9BAWoiLyAESA0ACwUgJSAkTiAkICNOcQRAIB0gH2ogIWogImohKCAcIB9qICFqICJqISkgHCAeaiAhaiAiaiErQQAhLwNAIAIgKUEBdGovAQAhMCApQQFqISkgAiArQQF0ai8BACExICtBAWohKyACICdBAXRqLwEAITIgJ0EBaiEnIAIgKEEBdGovAQAhMyAoQQFqISggMyAwayAjbCAwIDFrICRsaiAxIDJrICVsaiE0IDIgNEGAIGpBDXVqITUgLkEBRgRAIA4gL0ECdGogNTYCAAUgLkECRgRAIA4gL0ECdGooAgAhNiA2IDUgNmsgJmxBgCBqQQ11aiE3BSA1ITcLIBMgNzsBACATQQJqIRMLIC9BAWoiLyAESA0ACwVBACEvA0AgAiAnQQF0ai8BACEyICdBAWohJyAyITUgLkEBRgRAIA4gL0ECdGogNTYCAAUgLkECRgRAIA4gL0ECdGooAgAhNiA2IDUgNmsgJmxBgCBqQQ11aiE3BSA1ITcLIBMgNzsBACATQQJqIRMLIC9BAWoiLyAESA0ACwsLCwsLCyAsRSAtcQRAICIgCGohIkEBISxBAiEuDAELDAELCyAQQQJGBEAgEyASLwEAOwEAIBNBAmohEyASQQJqIRIFIBBBAUYEQCATQf//AzsBACATQQJqIRMLIBIgD0EBdGohEgsgEUEBaiERDAALCws=';

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
