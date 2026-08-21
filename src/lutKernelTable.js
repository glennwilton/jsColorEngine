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
// lutKernelTable.js — flat lookup table for the LUT kernel dispatcher
// ============================================================================
//
// One config object per supported (lutMode, inputChannels, outputChannels)
// triple. Drives `Transform.transformArrayViaLUT` v2 (the table-driven
// dispatcher). Each entry self-describes:
//
//   run       — kernel invocation closure (inline so Cmd+Click on the
//               method name jumps to its definition; profiler shows the
//               wrapper function name; per-kernel arg-shape adaptation
//               happens here, not in the dispatcher)
//   gate      — `(t, lut) => boolean`; checked at create() time and cached
//               in `entry.cachedGatePass` per Transform. Includes both
//               WASM-state availability AND lut.intLut presence (every
//               integer kernel needs a built intLut).
//   minPx     — minimum pixelCount for this entry to be eligible. Non-zero
//               only for WASM entries (memcpy break-even). Checked per call.
//   fallback  — sibling key the resolver walks to if `gate` fails OR
//               `pixelCount < minPx`. Encoded as data — no separate
//               per-mode fallback config to keep in sync.
//
// Key naming: "<modeShort>_<inCh>_<outCh>" where outCh='n' covers every
// outputChannels not explicitly listed (so cMax ∈ {3, 4} are explicit
// entries, cMax ∈ {1, 5, 6, ...} resolves to '_n').
//
//   modeShort:  fl     float (last resort, always works)
//               i      u8  JS  (intLut required)
//               i16    u16 JS  (intLut required)
//               i8ws   u8  WASM scalar  (3D + 4D, all cMax)
//               i8wsi  u8  WASM SIMD    (3D + 4D, cMax ∈ {3, 4} only)
//               i16ws  u16 WASM scalar  (3D + 4D, all cMax)
//               i16wsi u16 WASM SIMD    (3D + 4D, cMax ∈ {3, 4} only — v1.3 / Q0.13)
//
// Fallback graph (degradation order — strict feature loss, never gain).
//
// BIT-DEPTH INVARIANT: a chain MUST NOT cross between u8 and u16
// kernels. The dispatcher pre-allocates the output buffer based on
// lutMode (Uint16Array for int16-* modes, Uint8ClampedArray
// otherwise — see transformArrayViaLUT). If a u16 chain fell through
// to a u8 kernel, that kernel would write 0..255 values into a
// Uint16Array — the data would silently divide by ~257 and look
// "almost right" until someone printed a proof.
//
//   u16 chains  →  terminate at the JS u16 kernel (or earlier).
//                  fallback: null past the JS rung means a misuse
//                  (e.g. lutMode='int16' without buildIntLut, or
//                  cMax outside {3, 4} on a non-WASM host) throws
//                  loudly rather than silently corrupting.
//   u8  chains  →  degrade all the way to the float kernel, which
//                  also writes 0..255 (matches Uint8ClampedArray).
//
//   i16wsi → i16ws → i16 → null                    (u16 — chain ends at JS u16)
//   i16ws  → i16   → null
//   i16    → null                                  (no u8 cross-over)
//
//   i8wsi  → i8ws  → i  → fl                       (u8 — full degradation to float)
//   i8ws   → i     → fl
//   i      → fl
//   fl     → null                                  (chain end — alwaysOk)
//
// Sparse cells (kernel doesn't cover this shape) use `run: null` and
// `gate: alwaysFalse` — the resolver treats them as transparent
// passthrough to `fallback`. We keep the cell present (rather than
// deleting it) so the table stays exhaustive: every (mode, inCh, outB)
// triple is documented in one place, even when the answer is "skip me".
//
// "n" entries cover the multichannel case (cMax not in {3, 4}, e.g.
// CMYKOG 6-color or hexachrome inks). Coverage by mode:
//
//   • SCALAR WASM (i8ws_*_n, i16ws_*_n) → ✓ DOES run. The scalar
//     kernels are rolled-NCh (loop `o < cMax` over output channels)
//     so they handle any output width. Big win vs legacy, which
//     hard-coded `outputChannels === 3 || === 4` and dropped n-color
//     pipelines onto a per-pixel allocating JS path.
//
//   • SIMD WASM (i8wsi_*_n, i16wsi_*_n) → ✗ CANNOT run. The SIMD
//     kernels store one full output pixel per `i32x4` lane write
//     (4 bytes / pixel). Letting them run on cMax=5+ would corrupt
//     memory past the output stride — gated out as a hard
//     correctness requirement, not a perf trade-off. Falls through
//     transparently to the scalar WASM sibling above.
//
//   • JS INTEGER (i_*_n, i16_*_n) → ✗ NOT IMPLEMENTED. The JS NCh
//     kernels (`tetrahedralInterp3DArray_NCh_loop` and 4D sibling)
//     don't have `intLut` variants because 6+ channel CLUTs are
//     comparatively rare and the WASM scalar path already covers
//     them well. Falls through to `fl_*_n` (per-pixel JS NCh loop).
//
// ============================================================================

'use strict';

// THE ROWS NOW LIVE WITH THEIR KERNELS (v1.6 phase 4d). Every fallback chain
// in this table stays inside one input dimension, so what used to be one
// table was two independent ladders sharing a file. Each kernel owns its own.
//
// What stays here is what is genuinely shared: the key format, the
// lutMode-to-prefix map, and the resolver that walks a chain checking gates
// and minimum pixel counts. KERNEL is assembled from the two halves so the
// dispatcher and the existing exhaustiveness tests read one table, as before.

var WASM_DISPATCH_MIN_PIXELS = require('./kernels/dispatchThreshold.js');

var gates    = require('./kernels/gates.js');
var alwaysOk = gates.alwaysOk, alwaysFalse = gates.alwaysFalse, needsIntLut = gates.needsIntLut;

var table3d = require('./kernels/3d/kernel3D_table.js');
var table4d = require('./kernels/4d/kernel4D_table.js');

// ---- gate predicates (cached at create() time per-Transform) ----------------


// ---- the merged view --------------------------------------------------------
//
// One object, assembled from the per-kernel halves. Nothing reaches past it:
// callers look up a key and walk `fallback`, exactly as before.

var KERNEL = {};
for(var _k3 in table3d) KERNEL[_k3] = table3d[_k3];
for(var _k4 in table4d) KERNEL[_k4] = table4d[_k4];

// ---- modeShort mapping ------------------------------------------------------

var LUT_MODE_SHORT = {
    'float':              'fl',
    'int':                'i',
    'int16':              'i16',
    'int-wasm-scalar':    'i8ws',
    'int-wasm-simd':      'i8wsi',
    'int16-wasm-scalar':  'i16ws',
    'int16-wasm-simd':    'i16wsi',
};

// ---- key builder ------------------------------------------------------------

function makeKey(modeShort, inCh, outCh){
    // Collapse all "other" output channel counts to the catch-all 'n' bucket.
    var outBucket = (outCh === 3 || outCh === 4) ? String(outCh) : 'n';
    return modeShort + '_' + inCh + '_' + outBucket;
}

// ---- resolver ---------------------------------------------------------------
//
// Walk the fallback linked list starting at `startKey`, returning the
// first entry whose gate passes AND whose minPx is satisfied at the
// supplied `pixelCount` floor. Used at create() time for two passes:
//
//   resolveLutKernel(t, lut, startKey, Infinity)  → 'big batch' kernel
//   resolveLutKernel(t, lut, startKey, 0)         → 'small batch' kernel
//
// Both refs are then cached on the Transform; per-call dispatch is one
// threshold compare + one indirect call.
//
// Throws if the chain runs off the end:
//   - For u8 chains this means a config bug (the fl_*_* tier has
//     gate=alwaysOk and should always catch).
//   - For u16 chains this is the BIT-DEPTH INVARIANT firing: u16 modes
//     with no eligible u16 kernel (e.g. lutMode='int16' without
//     buildIntLut, or cMax='n' on a non-WASM host). Loud throw is
//     intentional — see the chain graph in the file header.
//
// ─────────────────────────────────────────────────────────────────
// FUTURE: auto-bench kernel selection (v1.5)
// ─────────────────────────────────────────────────────────────────
// Because every entry's `run` is a uniform-signature closure with
// the SAME args (t, in, out, px, lut, ia, oa, pa), the resolver can
// be extended with a `mode='bench'` that walks the WHOLE chain (not
// just first match), runs each survivor through a 16k-pixel timed
// probe, and picks the MEASURED winner instead of the assumed one.
// The default fallback graph (SIMD > scalar > JS > float) will still
// win 99% of the time — but on hosts where intuition is wrong (SIMD
// bridge cost on Bun, L1-fit pathology, etc.) the bencher quietly
// picks the better path. See the matching TODO in
// each kernel's own resolve() switch for the full sketch.
//
// This function is the natural injection point — bench mode would
// collect candidates from the same chain walk that already powers
// the gate-and-minPx resolution today.

function resolveLutKernel(t, lut, startKey, pixelCountFloor){
    var key = startKey;
    var hops = 0;
    while (key !== null) {
        if (hops++ > 16) {
            throw new Error('lutKernelTable: fallback chain too deep starting at "' + startKey + '" — likely a cycle');
        }
        var entry = KERNEL[key];
        if (entry === undefined) {
            throw new Error('lutKernelTable: missing entry "' + key + '" (chain from "' + startKey + '")');
        }
        // `minPx` IS A MARKER HERE, NOT A NUMBER. pixelCountFloor is only ever
        // Infinity (resolving BIG) or 0 (resolving SMALL), so this compares to
        // "does this row need a big batch?" and the actual value never
        // participates. The real threshold — the one compared against a live
        // pixel count — is resolved per kernel in kernelUtils.resolveThreshold.
        // Keeping the value here anyway means the table still reads as the
        // documentation of which rows are WASM-gated.
        if (entry.run !== null && entry.gate(t, lut) && pixelCountFloor >= entry.minPx) {
            return { entry: entry, key: key };
        }
        key = entry.fallback;
    }
    throw new Error('lutKernelTable: fallback chain exhausted from "' + startKey + '" (no float fallback?)');
}

// ---- exports ---------------------------------------------------------------

module.exports = {
    KERNEL: KERNEL,
    LUT_MODE_SHORT: LUT_MODE_SHORT,
    WASM_DISPATCH_MIN_PIXELS: WASM_DISPATCH_MIN_PIXELS,
    makeKey: makeKey,
    resolveLutKernel: resolveLutKernel,
};
