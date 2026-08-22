/*
 * samples/bench/main.js
 * =====================
 *
 * Browser-side bench orchestrator. Tabs:
 *
 *   1. Full comparison   - all 4 directions x all 4 jsColorEngine
 *                          lutModes + lcms-wasm (HIGHRES + NOOPT). Per
 *                          cell measures LUT build + cold + hot.
 *   2. JIT warmup curve  - one direction + mode, plot per-iter ms over
 *                          N iterations. Visualises Ignition -> Sparkplug
 *                          -> TurboFan tier-up.
 *   3. Pixel-count sweep - one direction + mode, sweep pixel count from
 *                          4 K to 4 M. Sanity-checks that headline MPx/s
 *                          is L2-cache-flattering, not peak truth.
 *   4. Pool demo         - 15-image queue through transformImages().
 *   5. Speed vs Noise    - solid / photo blended toward noise; jsCE vs
 *                          lcms vs lcms NOCACHE. Why a pinch of grain
 *                          stabilises headline MPx/s.
 *
 * Loads jsColorEngine via the UMD bundle (`window.jsColorEngine`) and
 * lcms-wasm via dynamic ESM import (see lcms-runner.js).
 *
 * UI yielding: between every config we `await yieldUi()` so the progress
 * bar / status text actually paints. `yieldUi` also `await browserFocus()`
 * — if the tab blurs, the pause overlay holds until Resume. Timing-
 * critical loops use `performance.now()` not Date.now.
 */

import { loadLcms, buildProfiles, freeProfiles, makeLcmsRunner, probeLcmsBuild } from './lcms-runner.js';
import { browserFocus, installBrowserFocus } from './browserFocus.js';
import {
    buildInput, buildInputU16, contentLabel, DEFAULT_KIND,
    PHOTO_URL, loadPhotoFromUrl, setPhotoCmyk, paintKneePreview,
} from './content.js';

// CMYK input profile: US coated sheet standard.
const PROFILE_URL       = '../profiles/CoatedGRACoL2006.icc';

// CMYK output profile for CMYK→CMYK: ECI ISO Coated v2 (European press standard).
// Must be a DIFFERENT binary from the input so the engine builds a real 4D LUT
// rather than hitting the identity fast-path (same binaryHash → _kernelCopy).
const ISO_COATED_URL    = '../profiles/ISOcoated_v2_eci.icc';

// RGB->RGB MUST be sRGB -> AdobeRGB (NOT sRGB -> sRGB). If both endpoints
// are sRGB, lcms's pipeline optimiser collapses the transform to an identity
// at cmsCreateTransform() time, and the resulting throughput is ~30% higher
// than any legitimate RGB->RGB conversion (measured: 78 vs 60 MPx/s in a
// node smoke-test). Every other benchmark in this suite exercises a real
// non-identity transform, so RGB->RGB has to too.
const ADOBE_RGB_URL     = '../profiles/AdobeRGB1998.icc';

// ============================================================ STATE

const state = {
    jsce:               null,    // window.jsColorEngine reference
    jsGracol:           null,    // jsColorEngine Profile — GRACoL (CMYK input)
    jsIsoCoated:        null,    // jsColorEngine Profile — ISO Coated v2 (CMYK output)
    profileBytes:       null,    // raw GRACoL bytes (for lcms)
    isoCoatedBytes:     null,    // raw ISOcoated bytes (for lcms)
    lcms:               null,    // instantiated lcms-wasm runtime
    lcmsConsts:         null,    // named exports (TYPE_*, INTENT_*, cmsFLAGS_*)
    lcmsProfiles:       null,    // { srgb, adobe, cmyk, cmyk2, lab, cmykName, cmyk2Name, adobeName }
    lcmsAvailable:      false,
    simdSupported:      null,    // tri-state until detected
    initOnce:           null,    // memoised init() promise
    activeRunner:       null,    // {abort: () => void} for the in-flight bench
};

// ============================================================ TINY UTILS

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }
function nowMs() { return performance.now(); }

/**
 * Yield to the event loop so the browser can paint. Two rAFs ensures
 * the layout step actually runs before we resume - one rAF queues for
 * the next frame, the second rAF runs after the paint has committed.
 * Also awaits browserFocus() so a blurred tab pauses instead of
 * writing a throttled sample.
 */
async function yieldUi() {
    await browserFocus();
    await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
    await browserFocus();
}

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s[(s.length / 2) | 0];
}

function mpxPerSec(msPerIter, pixelCount) {
    if (msPerIter <= 0) return 0;
    return (pixelCount / 1e6) / (msPerIter / 1000);
}

function fmtMs(ms) {
    if (!isFinite(ms)) return '-';
    if (ms < 0.1) return ms.toFixed(3);
    if (ms < 10)  return ms.toFixed(2);
    if (ms < 100) return ms.toFixed(1);
    return ms.toFixed(0);
}

function fmtMpx(m) {
    if (!isFinite(m) || m <= 0) return '-';
    if (m < 1)   return m.toFixed(2);
    if (m < 10)  return m.toFixed(1);
    return m.toFixed(0);
}

function fmtMBs(m) {
    if (!isFinite(m) || m <= 0) return '-';
    if (m < 10)  return m.toFixed(1);
    if (m < 100) return m.toFixed(0);
    return m.toFixed(0);
}

function totalBpp(inCh, outCh, is16bit) {
    return (inCh + outCh) * (is16bit ? 2 : 1);
}

/**
 * Reorder #results-full tbody rows so each direction block is sorted by
 * MPx/s descending (fastest first). Error rows (no `data-mpx` cell) sink
 * to the bottom of their block. Re-applies `dir-sep` on the first row
 * of each block only.
 */
function reorderFullComparisonTbody(tbody, directions) {
    const byDir = new Map();
    for (const d of directions) {
        byDir.set(d.id, []);
    }
    for (const tr of tbody.querySelectorAll('tr')) {
        const id = tr.dataset.benchDir;
        if (id && byDir.has(id)) {
            byDir.get(id).push(tr);
        }
    }
    for (const d of directions) {
        const list = byDir.get(d.id);
        list.sort((a, b) => {
            const aCell = a.querySelector('td.num[data-mpx]');
            const bCell = b.querySelector('td.num[data-mpx]');
            const aM    = aCell ? parseFloat(aCell.dataset.mpx) : -Infinity;
            const bM    = bCell ? parseFloat(bCell.dataset.mpx) : -Infinity;
            return bM - aM;
        });
    }
    for (const d of directions) {
        byDir.get(d.id).forEach((tr, i) => {
            if (i === 0) {
                tr.classList.add('dir-sep');
            } else {
                tr.classList.remove('dir-sep');
            }
            tbody.appendChild(tr);
        });
    }
}

/**
 * Match table order: per direction, MPx/s descending (for copy-to-markdown).
 */
function sortFullResultsByDirAndMpx(results, directions) {
    const byDir = new Map();
    for (const d of directions) {
        byDir.set(d.id, []);
    }
    for (const r of results) {
        if (byDir.has(r.dirId)) {
            byDir.get(r.dirId).push(r);
        }
    }
    const out = [];
    for (const d of directions) {
        const list = byDir.get(d.id);
        list.sort((a, b) => b.mpxs - a.mpxs);
        for (const x of list) {
            out.push(x);
        }
    }
    return out;
}

function currentContentKind() {
    const el = $('#content-full') || $('#content-warmup') || $('#content-sweep');
    return (el && el.value) || DEFAULT_KIND;
}

/** Off = 0 (headline). On = 'auto' (in-kernel WASM + 4/5/6 accuracy path). */
function currentPixelCacheHint() {
    const el = $('#pixel-cache-full');
    return (el && el.checked) ? 'auto' : 0;
}

/**
 * Detect WebAssembly SIMD support. Validates a minimal module:
 *   (module (func (result v128) v128.const i32x4 0 0 0 0))
 *
 * Byte layout (43 bytes total):
 *   [0..7]   header:   \0asm + version 1
 *   [8..14]  type:     id=1, size=5, 1 type, func() -> [v128 (0x7b)]
 *   [15..18] func:     id=3, size=2, 1 func using type idx 0
 *   [19..42] code:     id=10, size=22, 1 body of size 20:
 *                         0 locals
 *                         v128.const (0xfd 0x0c) + 16 immediate bytes
 *                         end (0x0b)
 *
 * The first version of this detector (shipped briefly in v1.2-dev) had
 * the wrong body-size and section-size prefixes (0x08 / 0x0a instead of
 * 0x14 / 0x16), so validate() rejected the module regardless of SIMD
 * support - a false-negative in EVERY modern browser, which showed up
 * as "WASM SIMD: NOT AVAILABLE" even in Chrome and Firefox where SIMD
 * is universally supported. Fixed: correct prefixes make validate()
 * accept iff the host actually supports v128.
 */
async function detectWasmSimd() {
    if (typeof WebAssembly !== 'object') return false;
    const bytes = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,         // header
        0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,                // type: () -> [v128]
        0x03, 0x02, 0x01, 0x00,                                  // func: type idx 0
        0x0a, 0x16, 0x01,                                        // code: section size=22, 1 func
        0x14, 0x00,                                              //   body size=20, 0 locals
        0xfd, 0x0c,                                              //   v128.const
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,          //     16 imm bytes (zero)
        0x0b,                                                    //   end
    ]);
    try {
        return WebAssembly.validate(bytes);
    } catch (_) {
        return false;
    }
}

// ============================================================ DIRECTION CONFIG

/**
 * Four standard directions. Each yields:
 *   - js  : { src, dst, inCh, outCh } where src/dst are the args for
 *           jsColorEngine Transform.create()
 *   - lcms: { pInKey, fInKey, pOutKey, fOutKey, inCh, outCh } - keys
 *           into the lcmsProfiles + lcmsConsts maps so we can rebuild
 *           the workflow object lazily once lcms is loaded.
 *   - shortLabel : table cell label
 */
function directionConfigs(jsGracol, jsIsoCoated) {
    // Each direction carries BOTH 8-bit and 16-bit lcms format names. The
    // 16-bit ones (fIn16/fOut16) are what we feed when the bench mode is
    // a TYPE_*_16 lcms variant - same profile handles, different format
    // tag. The lcms transform is recreated per cell anyway (cmsCreateTransform
    // bakes the precalc LUT against the chosen format), so this is free.
    return [
        {
            id: 'rgb-rgb',
            shortLabel: 'RGB &rarr; RGB',
            longLabel:  'RGB to RGB (sRGB to AdobeRGB)',
            js:   { src: '*srgb',     dst: '*adobergb',     inCh: 3, outCh: 3 },
            // pOut: 'adobe' (NOT 'srgb') to force a real matrix+curves conversion.
            // With pOut: 'srgb' lcms detects the identity at transform-create time
            // and collapses the hot path to a memcpy - bogus ~30% speedup.
            lcms: { pIn: 'srgb', fIn: 'TYPE_RGB_8',  fIn16: 'TYPE_RGB_16',  pOut: 'adobe', fOut: 'TYPE_RGB_8',  fOut16: 'TYPE_RGB_16',  inCh: 3, outCh: 3 },
        },
        {
            id: 'rgb-cmyk',
            shortLabel: 'RGB &rarr; CMYK',
            longLabel:  'RGB to CMYK (sRGB to GRACoL)',
            js:   { src: '*srgb',     dst: jsGracol,        inCh: 3, outCh: 4 },
            lcms: { pIn: 'srgb', fIn: 'TYPE_RGB_8',  fIn16: 'TYPE_RGB_16',  pOut: 'cmyk', fOut: 'TYPE_CMYK_8', fOut16: 'TYPE_CMYK_16', inCh: 3, outCh: 4 },
        },
        {
            id: 'cmyk-rgb',
            shortLabel: 'CMYK &rarr; RGB',
            longLabel:  'CMYK to RGB (GRACoL to sRGB)',
            js:   { src: jsGracol,    dst: '*srgb',         inCh: 4, outCh: 3 },
            lcms: { pIn: 'cmyk', fIn: 'TYPE_CMYK_8', fIn16: 'TYPE_CMYK_16', pOut: 'srgb', fOut: 'TYPE_RGB_8',  fOut16: 'TYPE_RGB_16',  inCh: 4, outCh: 3 },
        },
        {
            id: 'cmyk-cmyk',
            shortLabel: 'CMYK &rarr; CMYK',
            longLabel:  'CMYK to CMYK (GRACoL &rarr; ISO Coated v2)',
            js:   { src: jsGracol,    dst: jsIsoCoated,     inCh: 4, outCh: 4 },
            lcms: { pIn: 'cmyk', fIn: 'TYPE_CMYK_8', fIn16: 'TYPE_CMYK_16', pOut: 'cmyk2', fOut: 'TYPE_CMYK_8', fOut16: 'TYPE_CMYK_16', inCh: 4, outCh: 4 },
        },
    ];
}

/**
 * Same-profile pairs. Both engines collapse these to a copy (jsCE
 * identity kernel, lcms pipeline optimiser). Off by default — tick
 * "include identity" to measure the memcpy ceiling on this machine.
 */
function identityDirectionConfigs(jsGracol) {
    return [
        {
            id: 'rgb-id',
            identity: true,
            shortLabel: 'RGB &rarr; RGB <span class="id-tag">identity</span>',
            longLabel:  'RGB to RGB (sRGB to sRGB — identity / copy)',
            js:   { src: '*srgb', dst: '*srgb', inCh: 3, outCh: 3 },
            lcms: { pIn: 'srgb', fIn: 'TYPE_RGB_8',  fIn16: 'TYPE_RGB_16',  pOut: 'srgb', fOut: 'TYPE_RGB_8',  fOut16: 'TYPE_RGB_16',  inCh: 3, outCh: 3 },
        },
        {
            id: 'cmyk-id',
            identity: true,
            shortLabel: 'CMYK &rarr; CMYK <span class="id-tag">identity</span>',
            longLabel:  'CMYK to CMYK (GRACoL to GRACoL — identity / copy)',
            js:   { src: jsGracol, dst: jsGracol, inCh: 4, outCh: 4 },
            lcms: { pIn: 'cmyk', fIn: 'TYPE_CMYK_8', fIn16: 'TYPE_CMYK_16', pOut: 'cmyk', fOut: 'TYPE_CMYK_8', fOut16: 'TYPE_CMYK_16', inCh: 4, outCh: 4 },
        },
    ];
}

/**
 * Mirror of LittleCMS's `_cmsReasonableGridpointsByColorspace` from
 * lcms2-2.18/src/cmspcs.c. lcms picks the precalc-LUT grid size at
 * cmsCreateTransform() time based on:
 *   - input colorspace channel count, and
 *   - the flags (HIGHRESPRECALC bumps the grid up, LOWRESPRECALC drops it,
 *     NOOPTIMIZE skips the LUT entirely so this function is never called).
 *
 * For the four directions this bench runs, that resolves to:
 *   RGB  (inCh=3): default=33, HIGHRES=49, LOWRES=17
 *   CMYK (inCh=4): default=17, HIGHRES=23, LOWRES=17
 *
 * The explicit-override path (`dwFlags & 0x00FF0000`) isn't used here.
 * We do not call lcms's precalc API ourselves; this is purely for
 * labelling the LUT column so the reader can verify the grid at a glance
 * without digging into lcms internals.
 *
 * Returns 0 for NOOPTIMIZE (no LUT built at all).
 */
function lcmsReasonableGrid(inCh, flags, consts) {
    if (!consts) return 0;
    if (flags & consts.cmsFLAGS_NOOPTIMIZE) return 0;

    // HIGHRESPRECALC - maximum resolution
    if (flags & consts.cmsFLAGS_HIGHRESPRECALC) {
        if (inCh > 4) return 7;           // Hifi
        if (inCh === 4) return 23;         // CMYK
        return 49;                         // RGB and others
    }

    // LOWRESPRECALC - lower resolution
    if (consts.cmsFLAGS_LOWRESPRECALC && (flags & consts.cmsFLAGS_LOWRESPRECALC)) {
        if (inCh > 4) return 6;
        if (inCh === 1) return 33;         // monochrome
        return 17;                         // remaining
    }

    // Default
    if (inCh > 4) return 7;
    if (inCh === 4) return 17;             // CMYK
    return 33;                             // RGB
}

// jsColorEngine modes we always test in the full-comparison view.
// Order matters: int comes 2nd so that vs-int speedups for the WASM rows
// have a baseline already in scope. `no-lut` is the "full pipeline per
// pixel" accuracy path (buildLut: false) - same kernel family as lcms
// NOOPTIMIZE, answer to "how fast is jsce when you tell it to prioritise
// math fidelity over throughput".
//
// `int16` is the v1.3 16-bit-I/O path: same Q0.16 u16 LUT cells as `int`,
// but the kernel reads u16 input and writes u16 output (Uint16Array both
// directions). Slotted in right after `int` so the speed comparison is
// adjacent. See bench/int16_poc/RESULTS.md and Transform.js
// `tetrahedralInterp*Array_*Ch_intLut16_loop` for the implementation.
//
// `int16-wasm-scalar` and `int16-wasm-simd` (v1.3) are the WASM siblings
// of `int16`. Same Q0.13-weight u16 CLUT, same arithmetic as the JS u16
// kernel — bit-exact, just compiled to wasm32 (scalar) and v128 SIMD.
// All three int16-* rows share one intLut. Slotted next to `int16` so
// the JS/scalar/SIMD speed step is visible in adjacent rows.
const JSCE_MODES = [
    { id: 'no-lut',            label: 'jsce no-LUT (f64)',          badge: 'b-nolut',    isLut: false, dataFormat: 'int8'  },
    { id: 'matrix-shaper',     label: 'jsce matrix-shaper',         badge: 'b-shaper',   isLut: false, dataFormat: 'int8'  },
    { id: 'float',             label: 'jsce float',                 badge: 'b-float',    isLut: true,  dataFormat: 'int8'  },
    { id: 'int',               label: 'jsce int',                   badge: 'b-int',      isLut: true,  dataFormat: 'int8'  },
    { id: 'int16',             label: 'jsce int16 (u16 I/O)',       badge: 'b-int16',    isLut: true,  dataFormat: 'int16' },
    { id: 'int16-wasm-scalar', label: 'jsce int16-wasm-scalar',     badge: 'b-int16ws',  isLut: true,  dataFormat: 'int16' },
    { id: 'int16-wasm-simd',   label: 'jsce int16-wasm-simd',       badge: 'b-int16wsi', isLut: true,  dataFormat: 'int16' },
    { id: 'int-wasm-scalar',   label: 'jsce int-wasm-scalar',       badge: 'b-wasm',     isLut: true,  dataFormat: 'int8'  },
    { id: 'int-wasm-simd',     label: 'jsce int-wasm-simd',         badge: 'b-simd',     isLut: true,  dataFormat: 'int8'  },
];

// ============================================================ INIT / BOOT

async function init() {
    if (state.initOnce) return state.initOnce;
    state.initOnce = (async () => {
        // ---- 1. jsColorEngine UMD global ----
        if (typeof window.jsColorEngine === 'undefined') {
            throw new Error(
                'window.jsColorEngine is undefined. Did you build the UMD bundle?\n' +
                'Run:  npm run browser  (writes to browser/jsColorEngineWeb.js)'
            );
        }
        state.jsce = window.jsColorEngine;
        const jscVer = state.jsce.version || '?';
        $('#info-jsce').textContent = 'loaded (window.jsColorEngine) v' + jscVer;
        $('#info-jsce').classList.add('is-ok');

        $('#info-version').textContent = jscVer;

        // ---- 2. host capabilities ----
        $('#info-wasm').textContent = (typeof WebAssembly !== 'undefined') ? 'available' : 'NOT AVAILABLE';
        $('#info-wasm').classList.add(typeof WebAssembly !== 'undefined' ? 'is-ok' : 'is-error');

        state.simdSupported = await detectWasmSimd();
        $('#info-simd').textContent = state.simdSupported ? 'available' : 'NOT AVAILABLE (will demote)';
        $('#info-simd').classList.add(state.simdSupported ? 'is-ok' : 'is-warn');

        $('#info-ua').textContent    = navigator.userAgent;
        $('#info-cores').textContent = String(navigator.hardwareConcurrency || '?');
        $('#info-pool').textContent = 'not started';
        $('#info-secure').textContent = window.isSecureContext
            ? 'secure context'
            : 'NOT secure (some perf APIs throttled)';
        $('#info-secure').classList.add(window.isSecureContext ? 'is-ok' : 'is-warn');

        // ---- 3. Load profile bytes in parallel (used by both engines) ----
        // GRACoL = our CMYK target (ICC on disk, large).
        // AdobeRGB = our non-sRGB RGB target so the RGB->RGB row is a
        //            real matrix+curves conversion, not an identity passthrough.
        //            lcms-wasm doesn't expose cmsCreateRGBProfile() so we load
        //            a 560-byte reference profile from disk instead.
        const t0 = nowMs();
        const [respGracol, respAdobe, respIso] = await Promise.all([
            fetch(PROFILE_URL),
            fetch(ADOBE_RGB_URL),
            fetch(ISO_COATED_URL),
        ]);
        if (!respGracol.ok) {
            throw new Error('Failed to fetch ' + PROFILE_URL + ' (' + respGracol.status + ')');
        }
        if (!respAdobe.ok) {
            throw new Error('Failed to fetch ' + ADOBE_RGB_URL + ' (' + respAdobe.status + ')');
        }
        if (!respIso.ok) {
            throw new Error('Failed to fetch ' + ISO_COATED_URL + ' (' + respIso.status + ')');
        }
        const [bufGracolAb, bufAdobeAb, bufIsoAb] = await Promise.all([
            respGracol.arrayBuffer(),
            respAdobe.arrayBuffer(),
            respIso.arrayBuffer(),
        ]);
        const buf        = new Uint8Array(bufGracolAb);
        const bufAdobe   = new Uint8Array(bufAdobeAb);
        const bufIso     = new Uint8Array(bufIsoAb);
        state.profileBytes      = buf;
        state.adobeProfileBytes = bufAdobe;
        state.isoCoatedBytes    = bufIso;

        // jsce GRACoL profile — CMYK input (US press standard)
        state.jsGracol = new state.jsce.Profile();
        state.jsGracol.loadBinary(buf);
        if (!state.jsGracol.loaded) {
            throw new Error('jsColorEngine: failed to decode CoatedGRACoL2006.icc');
        }

        // jsce ISO Coated v2 — CMYK output for CMYK→CMYK (European press standard)
        // Using a different profile from the input ensures a real 4D LUT is built
        // instead of hitting the identity fast-path (same binaryHash = _kernelCopy).
        state.jsIsoCoated = new state.jsce.Profile();
        state.jsIsoCoated.loadBinary(bufIso);
        if (!state.jsIsoCoated.loaded) {
            throw new Error('jsColorEngine: failed to decode ISOcoated_v2_eci.icc');
        }

        // jsce side of RGB->RGB uses the built-in '*adobergb' profile
        // (same matrix primaries + gamma 2.2 as the AdobeRGB ICC bytes we
        // feed to lcms). We're not loading the ICC into jsce because the
        // built-in resolves faster and is byte-identical in colour output
        // for our purposes. Smoke-tested: 65K pixel RGB->RGB matches to
        // within +/-1 LSB vs the ICC.
        // Strawberries frame — the same JPEG the Node solo / release-matrix
        // benches use. CMYK workflows get a real GRACoL separation of it,
        // not four random ink channels.
        let photoNote = '';
        try {
            const photo = await loadPhotoFromUrl(PHOTO_URL);
            const sep = new state.jsce.Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int' });
            sep.create('*srgb', state.jsGracol, state.jsce.eIntent.relative);
            const rgbPlane = buildInput(3, photo.npx, 'photo');
            setPhotoCmyk(sep.transformArray(rgbPlane, false, false, false, photo.npx), photo.npx);
            photoNote = '; photo ' + photo.width + '\u00d7' + photo.height + ' strawberries + GRACoL sep';
            renderKneePreviews();
        } catch (e) {
            console.warn('jsColorEngine bench: photo failed to load, content will fall back', e);
            photoNote = '; photo FAILED — falling back';
        }

        const profileMs = nowMs() - t0;
        $('#info-profile').textContent =
            'CoatedGRACoL2006.icc (' + (buf.byteLength / 1024).toFixed(0) + ' KB) + ' +
            'ISOcoated_v2_eci.icc (' + (bufIso.byteLength / 1024).toFixed(0) + ' KB) + ' +
            'AdobeRGB1998.icc (' + (bufAdobe.byteLength / 1024).toFixed(1) + ' KB), ' +
            'fetched + decoded in ' + profileMs.toFixed(0) + ' ms' + photoNote;
        $('#info-profile').classList.add('is-ok');

        // ---- 4. lcms-wasm (best-effort - missing => disable lcms rows) ----
        try {
            const { lcms, consts } = await loadLcms();
            state.lcms = lcms;
            state.lcmsConsts = consts;
            state.lcmsProfiles = buildProfiles(lcms, buf, bufAdobe, bufIso);
            state.lcmsAvailable = true;

            // Inspect lcms.wasm to surface its build characteristics. This
            // is what tells the user why jsce can legitimately beat lcms
            // on SIMD-capable hosts: lcms-wasm is a straight emcc -O3
            // build of LittleCMS 2.16 *without* -msimd128, so every
            // lcms kernel runs scalar regardless of host SIMD support.
            // Meanwhile jsce ships hand-tuned v128 kernels that ARE SIMD.
            // Not a bench bias - a genuine capability gap.
            const build = await probeLcmsBuild();
            let tag = '';
            if (build && !build.error) {
                // Informational only: lcms-wasm is a stock emcc -O3 build of
                // LittleCMS 2.16 (no -msimd128). That is a property of the
                // shipped binary, not a host-capability problem, so the cell
                // stays green when lcms loads successfully.
                tag = build.hasSimd
                    ? ' - SIMD build'
                    : ' - stock scalar build';
            }
            $('#info-lcms').textContent =
                'lcms ' + (consts.LCMS_VERSION || '?') + ' (wasm32) loaded' + tag;
            $('#info-lcms').classList.add('is-ok');
        } catch (err) {
            state.lcmsAvailable = false;
            $('#info-lcms').textContent =
                'NOT AVAILABLE - add lcms.js + lcms.wasm under samples/lcms-wasm-dist/';
            $('#info-lcms').classList.add('is-warn');
            console.warn('lcms-wasm load failed:', err);
            // Disable the lcms checkbox since we can't run those rows
            const cb = $('#incl-lcms-full');
            if (cb) { cb.checked = false; cb.disabled = true; }
        }
    })().catch((err) => {
        // Surface init errors prominently
        state.initOnce = null;
        console.error(err);
        const banner = document.createElement('div');
        banner.className = 'card';
        banner.innerHTML = '<h2 style="color:var(--error)">Init failed</h2>' +
            '<pre style="white-space:pre-wrap; color:var(--error)">' +
            String(err && err.stack || err) + '</pre>';
        document.querySelector('main').prepend(banner);
        throw err;
    });
    return state.initOnce;
}

// ============================================================ JSCE RUNNER

/**
 * Build a jsColorEngine runner for a (direction, mode, pixelCount). Same
 * shape as the lcms runner so the timing harness is identical.
 *
 * Notes on what gets measured at create() time:
 *   - profile decode: NOT measured (already done at init() time)
 *   - pipeline build + integer mirror LUT bake (`int*` modes): measured
 *   - WASM module compile + instantiate (`int-wasm-*` modes): measured
 *
 * The created runner exposes `.actualMode` so we can render demoted
 * fallbacks (e.g. user picked int-wasm-simd but host has no SIMD ->
 * Transform.lutMode auto-demoted to int-wasm-scalar at create() time).
 */
function makeJsceRunner(dir, modeId, pixelCount, sharedWasmCache, contentKind) {
    const jsce = state.jsce;
    const wf = dir.js;
    const kind = contentKind || currentContentKind();

    const isNoLut = (modeId === 'no-lut');
    const isShaper = (modeId === 'matrix-shaper');
    // Any mode whose id starts with 'int16' uses u16 typed I/O. That
    // covers the JS u16 path (`int16`) AND the two WASM siblings
    // (`int16-wasm-scalar` / `int16-wasm-simd`) — they all consume the
    // same Uint16Array and produce the same Uint16Array, only the
    // kernel changes.
    const isInt16Family = (modeId === 'int16' || modeId.indexOf('int16-') === 0);

    // Input typed-array width follows dataFormat, NOT lutMode:
    //   - int16-family : Uint16Array (full u16 range)
    //   - everything else (int / float / int-wasm-* / no-LUT / shaper): Uint8ClampedArray
    let input = isInt16Family
        ? buildInputU16(wf.inCh, pixelCount, kind)
        : buildInput(wf.inCh, pixelCount, kind);

    const t0 = nowMs();
    let opts;
    if (isNoLut) {
        // Pin the stage pipeline OFF. Default wasmMatrixShaper:'auto' would
        // yield the fused kernel on sRGB→AdobeRGB and this row would quote
        // 300 MPx/s as "the accuracy path".
        opts = { dataFormat: 'int8', buildLut: false, useCurveLut: true, wasmMatrixShaper: false };
    } else if (isShaper) {
        opts = { dataFormat: 'int8', buildLut: false, wasmMatrixShaper: 'auto' };
    } else if (modeId === 'int16') {
        // dataFormat: 'int16' + buildLut: true with no explicit lutMode lets
        // the auto-resolver pick the best int16-family kernel for the host
        // (currently demoting through int16-wasm-simd -> int16-wasm-scalar
        // -> int16). For the bench we want to PIN this row to the JS u16
        // kernel so the comparison vs the wasm rows is honest, so force it.
        opts = { dataFormat: 'int16', buildLut: true, lutMode: 'int16' };
    } else if (modeId === 'int16-wasm-scalar' || modeId === 'int16-wasm-simd') {
        // u16 + explicit wasm lutMode. The shared wasm cache means
        // int16-wasm-scalar + int16-wasm-simd in the same run share the
        // module-compile cost; each Transform still gets its own
        // linear-memory instance.
        opts = { dataFormat: 'int16', buildLut: true, lutMode: modeId, wasmCache: sharedWasmCache };
    } else {
        opts = { dataFormat: 'int8', buildLut: true, lutMode: modeId, wasmCache: sharedWasmCache };
    }
    opts.pixelCache = currentPixelCacheHint();
    const xform = new jsce.Transform(opts);
    xform.create(wf.src, wf.dst, jsce.eIntent.relative);
    const lutBuildMs = nowMs() - t0;

    // may differ from requested if host lacked e.g. SIMD and the engine demoted
    let actualMode = isNoLut ? 'no-lut' : (isShaper ? 'matrix-shaper' : xform.lutMode);
    if (isShaper) {
        const info = (typeof xform.kernelInfo === 'function') ? xform.kernelInfo() : null;
        if (!info || info.name !== 'matrix-shaper') actualMode = 'matrix-shaper (declined)';
    }

    // Describe the LUT for the results column. This answers the question
    // "exactly how is this transform storing its colour data?" - which is
    // what separates the accuracy case (no LUT, f64 pipeline) from the
    // image case (pre-baked 33x33x33 u16 LUT + tetra interp).
    //
    //   - `no-lut`        : there IS no CLUT; every pixel walks the full
    //                       per-stage pipeline in f64. Most accurate jsce
    //                       path we ship. Matrix-shaper is FORCED off.
    //   - `matrix-shaper` : same pair, fused curve+3×3+curve WASM (or JS).
    //   - `float`         : Float64Array CLUT + f64 tetra interp. Same
    //                       accuracy as no-LUT in practice (grid interp is
    //                       the dominant error, not f64 vs f64) but much
    //                       faster because the pipeline collapses to a LUT.
    //   - `int*`          : Uint16Array CLUT (Q0.16) + int32 tetra interp.
    //                       The "image throughput" configuration.
    let lutDesc;
    if (isShaper) {
        lutDesc = (actualMode === 'matrix-shaper')
            ? 'no CLUT (curve + 3×3 + curve)'
            : 'declined — stage pipeline';
    } else if (isNoLut) {
        lutDesc = 'no LUT (f64 pipeline)';
    } else if (xform.lut && xform.lut.CLUT) {
        const g1    = xform.lut.g1 || 0;
        const inCh  = xform.lut.inputChannels  || wf.inCh;
        // Build e.g. "33x33x33" / "33x33x33x33"
        const axes = new Array(inCh).fill(g1).join('\u00d7'); // x
        const storage = (modeId === 'float') ? 'f64' : 'u16';
        // Tag the I/O width when it diverges from the default u8 path so the
        // reader can see "same LUT, different surface" at a glance.
        const ioTag = isInt16Family ? ' (u16 I/O)' : '';
        lutDesc = axes + ' ' + storage + ioTag;
    } else {
        lutDesc = '-';
    }

    function run() { xform.transformArray(input); }

    function setInput(next) { input = next; }

    function free() {
        // jsColorEngine Transform has no explicit free; GC will clean up.
        // Drop the closure references so the WASM linear-memory instances
        // can be reclaimed sooner.
    }

    return { run, setInput, free, lutBuildMs, actualMode, lutDesc, input };
}

// ============================================================ MEASUREMENT CORE

/**
 * Measure a runner. Returns { lutBuildMs, coldMs, hotMs, mpxs, samples }.
 *
 * Note: caller passes in `lutBuildMs` from the runner factory because that
 * cost is paid before we have the runner object - we just plumb it through
 * so all timing comes out of one struct.
 *
 * Cold == first run() call (includes JIT tier-up + WASM cache warm).
 * Hot  == warmup loop, then median of `BATCHES` batches of `perBatch` iters.
 *         Batches are independent timed regions so a single GC pause
 *         doesn't poison the steady-state number.
 */
async function measureRunner(runner, pixelCount, warmupIters, hotItersPerBatch) {
    const BATCHES = 5;
    await browserFocus();

    // 1) Cold
    const tCold = nowMs();
    runner.run();
    const coldMs = nowMs() - tCold;

    // 2) Warmup - keep the UI alive every ~50 iters so the progress bar
    //    paints. Yielding kills tier-up if we do it too often, so keep
    //    the chunk size big enough that V8 doesn't deopt.
    const warmupChunk = 50;
    for (let w = 0; w < warmupIters; w += warmupChunk) {
        const end = Math.min(warmupIters, w + warmupChunk);
        for (let i = w; i < end; i++) runner.run();
        await yieldUi();
    }

    // 3) Hot - 5 batches, take the median (robust to GC noise).
    //    If the tab blurred mid-batch, drop that sample and retry.
    const samples = [];
    while (samples.length < BATCHES) {
        await browserFocus();
        const t0 = nowMs();
        for (let i = 0; i < hotItersPerBatch; i++) runner.run();
        const t1 = nowMs();
        if (browserFocus.lost) {
            await browserFocus();
            continue;
        }
        samples.push((t1 - t0) / hotItersPerBatch);
        await yieldUi();
    }
    const hotMs = median(samples);

    return {
        lutBuildMs: runner.lutBuildMs,
        coldMs,
        hotMs,
        mpxs: mpxPerSec(hotMs, pixelCount),
        samples,
    };
}

// ============================================================ FULL COMPARISON

/**
 * What the hot path is "made of" at a glance: f64 (jsce no-LUT / float);
 * u8 (8-bit I/O + u16 integer LUT); u16 (jsce int16* rows = 16-bit I/O, or
 * lcms-wasm NOOPT = integer u16 pipeline in this wasm build vs native f64).
 * Lets you compare mixed rows without re-reading the Mode label every time.
 */
function benchTypeLabel(cfg) {
    if (cfg.kind === 'jsce') {
        const id = cfg.mode.id;
        if (id === 'no-lut' || id === 'float') {
            return 'f64';
        }
        if (id === 'matrix-shaper') {
            return 'u8';
        }
        if (id === 'int16' || id.indexOf('int16-') === 0) {
            return 'u16';
        }
        return 'u8';
    }
    const no = state.lcmsConsts && state.lcmsConsts.cmsFLAGS_NOOPTIMIZE;
    if (no && (cfg.lcmsFlags & no)) {
        // lcms-wasm NOOPT: integer u16 pipeline in this wasm build (not f64).
        return 'u16';
    }
    return (cfg.bitDepth === 16) ? 'u16' : 'u8';
}

function badgeForMode(modeId) {
    if (modeId === 'no-lut')            return 'b-nolut';
    if (modeId === 'matrix-shaper')     return 'b-shaper';
    if (modeId === 'float')             return 'b-float';
    if (modeId === 'int')               return 'b-int';
    if (modeId === 'int16')             return 'b-int16';
    if (modeId === 'int16-wasm-scalar') return 'b-int16ws';
    if (modeId === 'int16-wasm-simd')   return 'b-int16wsi';
    if (modeId === 'int-wasm-scalar')   return 'b-wasm';
    if (modeId === 'int-wasm-simd')     return 'b-simd';
    return 'b-lcms';
}

function setProgress(panelId, pct, text, kind) {
    const wrap = $('#progress-' + panelId);
    if (!wrap) return;
    wrap.querySelector('.progress-bar').style.width = (pct * 100).toFixed(1) + '%';
    const t = wrap.querySelector('.progress-text');
    t.textContent = text;
    t.classList.remove('is-busy', 'is-done', 'is-error');
    if (kind) t.classList.add('is-' + kind);
}

async function runFullComparison() {
    await init();
    await browserFocus();

    const pixelCount   = parseInt($('#pixels-full').value,  10);
    const warmupIters  = parseInt($('#warmup-full').value,  10);
    const hotPerBatch  = parseInt($('#hot-full').value,     10);
    const inclLcms     = $('#incl-lcms-full').checked && state.lcmsAvailable;
    const inclIdentity = !!( $('#incl-identity-full') && $('#incl-identity-full').checked );

    const realDirs = directionConfigs(state.jsGracol, state.jsIsoCoated);
    const directions = inclIdentity
        ? realDirs.concat(identityDirectionConfigs(state.jsGracol))
        : realDirs;

    // Build the full config matrix
    const configs = [];
    for (const dir of directions) {
        for (const mode of JSCE_MODES) {
            if (mode.id === 'matrix-shaper' && (dir.js.inCh !== 3 || dir.js.outCh !== 3)) continue;
            configs.push({ kind: 'jsce', dir, mode, isLut: mode.isLut });
        }
        if (inclLcms) {
            // Three lcms variants so there is no question we've given lcms every
            // chance to shine:
            //   - default (0)  : what every real lcms app uses; lcms picks the
            //                    grid size that *it* considers optimal for this
            //                    profile (usually 33 for CMYK, matches jsce).
            //   - HIGHRESPRECALC: force the biggest LUT, matches jsce's design
            //                    philosophy of "always LUT, always precomputed".
            //   - NOOPTIMIZE   : no LUT at all, full per-pixel pipeline. The
            //                    lcms equivalent of jsce `buildLut: false`.
            // All three use pinned wasm-heap buffers and call _cmsDoTransform
            // directly (no per-call _malloc/_free/.slice) - the fastest path
            // callable from JS.
            //
            // `lutDesc` for lcms is inferred from lcms's own grid-selection
            // rule (mirrored in lcmsReasonableGrid() above). lcms-wasm doesn't
            // expose the precalc-LUT grid back to JS through its public API,
            // but the rule is deterministic in the C source
            // (cmspcs.c :: _cmsReasonableGridpointsByColorspace), so we can
            // reconstruct the grid size exactly. Storage is u16 - lcms's
            // precalc LUT for 8-bit input profiles is always Uint16.
            const mkLcmsLutDesc = (flags, inCh, bit) => {
                const g = lcmsReasonableGrid(inCh, flags, state.lcmsConsts);
                if (g === 0) return 'no LUT (pipeline, ' + bit + '-bit I/O)';
                // lcms's precalc LUT cells are always Uint16 internally,
                // regardless of the I/O bit depth - what changes between
                // 8-bit and 16-bit modes is the format converter at the
                // pipeline edges, not the LUT shape. Tag the I/O width so
                // the comparison vs jsce 'int' / 'int16' is unambiguous.
                return new Array(inCh).fill(g).join('\u00d7') + ' u16 (' + bit + '-bit I/O)';
            };
            // 8-bit (TYPE_*_8) variants - paired with jsce int / float / int-wasm-*
            configs.push({ kind: 'lcms', dir, lcmsFlags: 0,                                        label: 'lcms-wasm default',      badge: 'b-lcms', isLut: true,  bitDepth: 8,  lutDesc: mkLcmsLutDesc(0, dir.lcms.inCh, 8) });
            configs.push({ kind: 'lcms', dir, lcmsFlags: state.lcmsConsts.cmsFLAGS_HIGHRESPRECALC, label: 'lcms-wasm HIGHRES',      badge: 'b-lcms', isLut: true,  bitDepth: 8,  lutDesc: mkLcmsLutDesc(state.lcmsConsts.cmsFLAGS_HIGHRESPRECALC, dir.lcms.inCh, 8) });
            configs.push({ kind: 'lcms', dir, lcmsFlags: state.lcmsConsts.cmsFLAGS_NOOPTIMIZE,     label: 'lcms-wasm NOOPT',        badge: 'b-lcms', isLut: false, bitDepth: 8,  lutDesc: mkLcmsLutDesc(state.lcmsConsts.cmsFLAGS_NOOPTIMIZE, dir.lcms.inCh, 8) });
            // 16-bit (TYPE_*_16) variants - paired with jsce int16. The lcms
            // precalc-LUT GRID is the same as the 8-bit row (lcms picks grid
            // by colourspace + flags, not by I/O bit depth), but the format
            // converters at the pipeline edges flip from u8 to u16 - which is
            // why headline MPx/s typically drops ~10-15% vs the 8-bit row.
            configs.push({ kind: 'lcms', dir, lcmsFlags: 0,                                        label: 'lcms-wasm default 16',   badge: 'b-lcms', isLut: true,  bitDepth: 16, lutDesc: mkLcmsLutDesc(0, dir.lcms.inCh, 16) });
            configs.push({ kind: 'lcms', dir, lcmsFlags: state.lcmsConsts.cmsFLAGS_HIGHRESPRECALC, label: 'lcms-wasm HIGHRES 16',   badge: 'b-lcms', isLut: true,  bitDepth: 16, lutDesc: mkLcmsLutDesc(state.lcmsConsts.cmsFLAGS_HIGHRESPRECALC, dir.lcms.inCh, 16) });
            configs.push({ kind: 'lcms', dir, lcmsFlags: state.lcmsConsts.cmsFLAGS_NOOPTIMIZE,     label: 'lcms-wasm NOOPT 16',     badge: 'b-lcms', isLut: false, bitDepth: 16, lutDesc: mkLcmsLutDesc(state.lcmsConsts.cmsFLAGS_NOOPTIMIZE, dir.lcms.inCh, 16) });
        }
    }

    // Reset table
    const tbody = $('#results-full tbody');
    tbody.innerHTML = '';
    $('#run-full').disabled  = true;
    $('#copy-full').disabled = true;

    // Shared WASM module cache - means int-wasm-scalar + int-wasm-simd
    // configs in the same run share compile work. (Each Transform still
    // gets its own linear-memory instance.)
    const sharedWasmCache = {};

    let results = []; // collected for markdown / vs-int normalisation
    let prevDirId = null;

    for (let i = 0; i < configs.length; i++) {
        const cfg = configs[i];
        setProgress('full',
            i / configs.length,
            'Running ' + cfg.dir.shortLabel.replace('&rarr;', '->') + '  /  ' +
            (cfg.kind === 'jsce' ? cfg.mode.label : cfg.label) +
            '  (' + (i + 1) + '/' + configs.length + ')',
            'busy');
        await yieldUi();

        const isNewDir = cfg.dir.id !== prevDirId;
        const tr = document.createElement('tr');
        tr.dataset.benchDir = cfg.dir.id;
        if (isNewDir) tr.classList.add('dir-sep');
        if (cfg.dir.identity) tr.classList.add('is-identity');
        prevDirId = cfg.dir.id;

        try {
            let result, kernelLabel, badgeCls, demoted = false, lutDesc;
            if (cfg.kind === 'jsce') {
                const runner = makeJsceRunner(cfg.dir, cfg.mode.id, pixelCount, sharedWasmCache);
                result = await measureRunner(runner, pixelCount, warmupIters, hotPerBatch);
                kernelLabel = cfg.mode.label;
                badgeCls = cfg.mode.badge;
                lutDesc = runner.lutDesc;
                if (runner.actualMode !== cfg.mode.id) {
                    kernelLabel = cfg.mode.label + ' [' + runner.actualMode + ']';
                    demoted = true;
                }
                runner.free();
            } else {
                // lcms - flip format tag + input width by bitDepth (8 or 16).
                const wf = cfg.dir.lcms;
                const is16  = (cfg.bitDepth === 16);
                const fIn   = is16 ? state.lcmsConsts[wf.fIn16]  : state.lcmsConsts[wf.fIn];
                const fOut  = is16 ? state.lcmsConsts[wf.fOut16] : state.lcmsConsts[wf.fOut];
                const input = is16
                    ? buildInputU16(wf.inCh, pixelCount, currentContentKind())
                    : buildInput(wf.inCh, pixelCount, currentContentKind());
                const runner = makeLcmsRunner(
                    state.lcms, state.lcmsConsts,
                    {
                        pIn:  state.lcmsProfiles[wf.pIn],
                        fIn:  fIn,
                        pOut: state.lcmsProfiles[wf.pOut],
                        fOut: fOut,
                        inCh: wf.inCh, outCh: wf.outCh,
                    },
                    cfg.lcmsFlags, input, pixelCount
                );
                result = await measureRunner(runner, pixelCount, warmupIters, hotPerBatch);
                kernelLabel = cfg.label;
                badgeCls = cfg.badge;
                lutDesc = cfg.lutDesc;
                runner.free();
            }

            const typeCode = benchTypeLabel(cfg);
            const is16 = cfg.kind === 'jsce'
                ? (cfg.mode.dataFormat === 'int16')
                : (cfg.bitDepth === 16);
            const wf = cfg.kind === 'jsce' ? cfg.dir.js : cfg.dir.lcms;
            const bpp = totalBpp(wf.inCh, wf.outCh, is16);
            const mbps = result.mpxs * bpp;

            tr.innerHTML =
                '<td>' + cfg.dir.shortLabel + '</td>' +
                '<td class="mode-cell ' + (demoted ? 'demoted' : '') + '">' +
                  '<span class="mode-badge ' + badgeCls + '">' + kernelLabel + '</span>' +
                '</td>' +
                '<td class="type-cell" title="f64=jsce no-LUT/float; u16 (NOOPT)=lcms-wasm integer pipeline in this build; u8/u16=I/O + integer LUT as labelled.">' +
                    typeCode + '</td>' +
                '<td class="lut-cell">' + lutDesc + '</td>' +
                '<td class="num">' + fmtMs(result.lutBuildMs) + '</td>' +
                '<td class="num">' + fmtMs(result.coldMs) + '</td>' +
                '<td class="num">' + fmtMs(result.hotMs) + '</td>' +
                '<td class="num">' + fmtMpx(result.mpxs) + '</td>' +
                '<td class="num">' + fmtMBs(mbps) + '</td>' +
                '<td class="bar-col"><div class="bar"><div class="bar-fill ' + badgeCls + '" data-mpx="' + result.mpxs + '"></div></div></td>' +
                '<td class="num" data-direction="' + cfg.dir.id + '" data-mpx="' + result.mpxs + '">-</td>';
            tbody.appendChild(tr);

            results.push({
                dirId: cfg.dir.id,
                dirLabel: cfg.dir.shortLabel.replace(/<[^>]+>/g, ''),
                identity: !!cfg.dir.identity,
                mode: kernelLabel,
                modeId: cfg.kind === 'jsce' ? cfg.mode.id : null,
                typeCode,
                kind: cfg.kind,
                isLut: cfg.isLut,
                lutDesc,
                mbps,
                ...result,
            });
        } catch (err) {
            tr.innerHTML =
                '<td>' + cfg.dir.shortLabel + '</td>' +
                '<td class="mode-cell"><span class="mode-badge ' + badgeForMode(cfg.kind === 'jsce' ? cfg.mode.id : 'lcms') + '">' +
                  (cfg.kind === 'jsce' ? cfg.mode.label : cfg.label) + '</span></td>' +
                '<td class="type-cell type-cell-na">&mdash;</td>' +
                '<td class="error-cell" colspan="8">' + (err && err.message || err) + '</td>';
            tbody.appendChild(tr);
            console.error('Bench cell failed:', cfg, err);
        }
        await yieldUi();
    }

    reorderFullComparisonTbody(tbody, directions);
    results = sortFullResultsByDirAndMpx(results, directions);

    // ---- Post-process: normalise bars per direction + compute vs-int ----
    const fastestPerDir = {};
    const intMpxPerDir = {};
    for (const r of results) {
        if (!fastestPerDir[r.dirId] || r.mpxs > fastestPerDir[r.dirId]) {
            fastestPerDir[r.dirId] = r.mpxs;
        }
        // 'jsce int' is the vs-ref baseline (v1.1's default LUT kernel).
        if (r.mode === 'jsce int') intMpxPerDir[r.dirId] = r.mpxs;
    }

    $$('#results-full .bar-col .bar-fill').forEach((el) => {
        const mpx = parseFloat(el.dataset.mpx);
        const tr  = el.closest('tr');
        const dirId = tr.querySelector('td.num[data-direction]').dataset.direction;
        const fastest = fastestPerDir[dirId];
        const pct = fastest > 0 ? (mpx / fastest) * 100 : 0;
        el.style.width = pct.toFixed(1) + '%';
    });

    // Highlight the fastest per direction
    $$('#results-full tbody tr').forEach((tr) => {
        const cell = tr.querySelector('td.num[data-mpx]');
        if (!cell) return;
        const mpx = parseFloat(cell.dataset.mpx);
        const dirId = cell.dataset.direction;
        const fastest = fastestPerDir[dirId];
        if (Math.abs(mpx - fastest) < 0.001) {
            tr.querySelectorAll('td.num').forEach((td) => td.classList.add('is-best'));
        }
        const intMpx = intMpxPerDir[dirId];
        if (intMpx > 0) {
            cell.textContent = (mpx / intMpx).toFixed(2) + 'x';
        }
    });

    // ---- Summary cards: best-of per use case ----
    // Use case grid:
    //   accuracy => isLut=false  (jsce no-LUT / lcms NOOPTIMIZE)
    //   image    => isLut=true   (any LUT-backed mode, 8-bit I/O)
    // For each (engine, case) tuple we pick the fastest row in EACH direction,
    // so the reader sees 4 direction-specific numbers rather than a single
    // headline that's always going to be RGB->RGB (the cheapest direction).
    renderSummaryCards(results, realDirs, state.lcmsAvailable);

    setProgress('full', 1, 'Done. ' + configs.length + ' configs measured. Best per direction is highlighted.', 'done');
    $('#run-full').disabled  = false;
    $('#copy-full').disabled = false;

    // Stash for the markdown copy button
    state.lastFullResults = { results, fastestPerDir, intMpxPerDir, pixelCount, warmupIters, hotPerBatch };
}

/**
 * Render the four "best of" summary cards at the top of the Full comparison
 * panel. Each card is one (engine, useCase) tuple; rows within a card are
 * the best-in-class MPx/s for each of the four directions.
 *
 * Winners are picked strictly from the current run's `results` array - no
 * persistence across runs. If a category has zero results (e.g. lcms was
 * excluded) the card shows em-dashes.
 */
function renderSummaryCards(results, directions, lcmsAvailable) {
    const wrap = $('#summary-full');
    if (!wrap) return;
    wrap.hidden = false;

    // Category predicates: (result) => boolean
    const cats = [
        { id: 'jsce-accuracy', key: (r) => r.kind === 'jsce' && r.modeId === 'no-lut' },
        { id: 'jsce-lut',      key: (r) => r.kind === 'jsce' &&  r.isLut },
        { id: 'lcms-accuracy', key: (r) => r.kind === 'lcms' && !r.isLut },
        { id: 'lcms-lut',      key: (r) => r.kind === 'lcms' &&  r.isLut },
    ];

    for (const cat of cats) {
        // winner per direction in this category
        const byDir = {};
        for (const r of results) {
            if (!cat.key(r)) continue;
            const cur = byDir[r.dirId];
            if (!cur || r.mpxs > cur.mpxs) byDir[r.dirId] = r;
        }
        const rowsHtml = directions.map((dir) => {
            const r = byDir[dir.id];
            if (!r) {
                return '<tr><td>' + dir.shortLabel + '</td>' +
                    '<td class="scr-mode">&mdash;</td>' +
                    '<td class="num scr-mpx">&mdash;</td></tr>';
            }
            // strip the "jsce " / "lcms-wasm " prefix for readability in the card
            const shortMode = r.mode.replace(/^jsce\s+/i, '').replace(/^lcms-wasm\s+/i, '');
            return '<tr>' +
                '<td>' + dir.shortLabel + '</td>' +
                '<td class="scr-mode">' + shortMode + '</td>' +
                '<td class="num scr-mpx">' + fmtMpx(r.mpxs) + '</td>' +
                '</tr>';
        }).join('');

        // min/max across directions: shown BIG at top of each card as a
        // headline range ("5.4 - 12 MPx/s"), so the reader can glance at one
        // number and know what they're trading between worst/best direction.
        let loR = null, hiR = null;
        for (const dirId in byDir) {
            const r = byDir[dirId];
            if (!loR || r.mpxs < loR.mpxs) loR = r;
            if (!hiR || r.mpxs > hiR.mpxs) hiR = r;
        }

        const card = $('#sum-card-' + cat.id);
        if (!card) continue;
        const rangeEl = card.querySelector('.summary-range');
        if (loR && hiR) {
            rangeEl.querySelector('.summary-range-lo').textContent = fmtMpx(loR.mpxs);
            rangeEl.querySelector('.summary-range-hi').textContent = fmtMpx(hiR.mpxs);
            rangeEl.classList.remove('muted');
        } else {
            rangeEl.querySelector('.summary-range-lo').textContent = '\u2014';
            rangeEl.querySelector('.summary-range-hi').textContent = '\u2014';
            rangeEl.classList.add('muted');
        }
        card.querySelector('.summary-body tbody').innerHTML = rowsHtml;
    }
}

/**
 * Collect the visible engine-info panel into a key/value array for the
 * markdown dump. Read at copy time rather than init time so transient state
 * (e.g. lcms load succeeded / demoted mode) is accurate.
 */
function readEngineInfo() {
    const pick = (id) => {
        const el = $(id);
        return el ? (el.textContent || '').trim() : '';
    };
    return [
        ['jsColorEngine', pick('#info-jsce')],
        ['jsce version',  pick('#info-version')],
        ['WebAssembly',   pick('#info-wasm')],
        ['WASM SIMD',     pick('#info-simd')],
        ['lcms-wasm',     pick('#info-lcms')],
        ['Profile',       pick('#info-profile')],
        ['User agent',    pick('#info-ua')],
        ['CPU cores',     pick('#info-cores')],
        ['Page',          pick('#info-secure')],
        ['DevTools open', window._devtoolsOpen ? 'YES ⚠ — results may be 2–3× slower' : 'No'],
    ];
}

function copyFullMarkdown() {
    const r = state.lastFullResults;
    if (!r) return;
    const lines = [];

    lines.push('# jsColorEngine browser bench &mdash; Full comparison');
    lines.push('');
    lines.push('_Generated ' + new Date().toISOString() + '_');
    lines.push('');

    // ---- Engine / host info ----
    lines.push('## Host &amp; engine');
    lines.push('');
    lines.push('| Item | Value |');
    lines.push('|---|---|');
    for (const [k, v] of readEngineInfo()) {
        lines.push('| ' + k + ' | ' + (v || '-').replace(/\|/g, '\\|') + ' |');
    }
    lines.push('');
    lines.push('Run config: pixels/iter = ' + r.pixelCount.toLocaleString() +
               ', content = ' + contentLabel(currentContentKind()) +
               ', pixelCache = ' + (currentPixelCacheHint() === 0 ? 'off' : 'auto') +
               ', warmup = ' + r.warmupIters +
               ', hot iters per batch = ' + r.hotPerBatch + ' (x5 batches, median reported)' +
               (r.results.some((x) => x.identity)
                   ? ', identity pairs included (sRGB→sRGB, GRACoL→GRACoL — memcpy ceiling).'
                   : '.'));
    lines.push('');

    // ---- Summary cards ----
    const directions = directionConfigs(state.jsGracol, state.jsIsoCoated);
    const cats = [
        { id: 'jsce-accuracy', title: 'Accuracy &middot; jsColorEngine', key: (x) => x.kind === 'jsce' && x.modeId === 'no-lut' },
        { id: 'lcms-accuracy', title: 'Accuracy &middot; lcms-wasm',     key: (x) => x.kind === 'lcms' && !x.isLut },
        { id: 'jsce-lut',      title: 'Image &middot; jsColorEngine',    key: (x) => x.kind === 'jsce' &&  x.isLut },
        { id: 'lcms-lut',      title: 'Image &middot; lcms-wasm',        key: (x) => x.kind === 'lcms' &&  x.isLut },
    ];

    lines.push('## Summary (best-of per use case)');
    lines.push('');
    for (const cat of cats) {
        const byDir = {};
        for (const row of r.results) {
            if (!cat.key(row)) continue;
            const cur = byDir[row.dirId];
            if (!cur || row.mpxs > cur.mpxs) byDir[row.dirId] = row;
        }
        let lo = Infinity, hi = -Infinity;
        for (const id in byDir) {
            const m = byDir[id].mpxs;
            if (m < lo) lo = m;
            if (m > hi) hi = m;
        }
        lines.push('### ' + cat.title.replace(/&middot;/g, '-') + ' &mdash; ' +
            (isFinite(lo) ? fmtMpx(lo) + ' &ndash; ' + fmtMpx(hi) + ' MPx/s' : 'no data'));
        lines.push('');
        lines.push('| Direction | Mode | MPx/s |');
        lines.push('|---|---|---:|');
        for (const dir of directions) {
            const row = byDir[dir.id];
            if (!row) {
                lines.push('| ' + dir.shortLabel.replace('&rarr;', '->') + ' | - | - |');
            } else {
                lines.push(
                    '| ' + dir.shortLabel.replace('&rarr;', '->') +
                    ' | ' + row.mode +
                    ' | ' + fmtMpx(row.mpxs) + ' |'
                );
            }
        }
        lines.push('');
    }

    // ---- Full table ----
    lines.push('## Full results');
    lines.push('');
    lines.push('| Direction | Mode | Type | LUT | LUT build (ms) | Cold (ms) | Hot (ms) | MPx/s | MB/s | vs `int` |');
    lines.push('|---|---|:---:|---|---:|---:|---:|---:|---:|---:|');
    for (const row of r.results) {
        const intMpx = r.intMpxPerDir[row.dirId];
        const vsInt  = (intMpx > 0) ? (row.mpxs / intMpx).toFixed(2) + 'x' : '-';
        lines.push(
            '| ' + row.dirLabel.replace('&rarr;', '->') +
            ' | ' + row.mode +
            ' | ' + (row.typeCode || '-') +
            ' | ' + (row.lutDesc || '-') +
            ' | ' + fmtMs(row.lutBuildMs) +
            ' | ' + fmtMs(row.coldMs) +
            ' | ' + fmtMs(row.hotMs) +
            ' | ' + fmtMpx(row.mpxs) +
            ' | ' + fmtMBs(row.mbps || 0) +
            ' | ' + vsInt + ' |'
        );
    }
    // Replace HTML entities with their plain-text equivalents so the markdown
    // renders cleanly wherever it's pasted (GitHub, Discord, email, etc.)
    const md = lines.join('\n')
        .replace(/&mdash;/g, '-')
        .replace(/&ndash;/g, '-')
        .replace(/&middot;/g, '-')
        .replace(/&rarr;/g, '->')
        .replace(/&times;/g, 'x')
        .replace(/&amp;/g, '&');
    navigator.clipboard.writeText(md).then(() => {
        const btn = $('#copy-full');
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
    });
}

// ============================================================ ACCURACY SWEEP
//
// Lab -> device (float) -> Lab round-trip over a regular grid of the full
// Lab colour space. jsColorEngine only, because:
//
//   - The high-level lcms-wasm JS binding (npm `lcms-wasm`) exposes 8-bit
//     and 16-bit buffer APIs. There's no direct cmsDoTransform with
//     cmsFloat64Number buffers (TYPE_Lab_DBL / TYPE_CMYK_DBL / TYPE_RGB_DBL)
//     from JS without hand-wiring the pointer-level API, which defeats
//     the point of the comparison.
//   - jsColorEngine's `dataFormat: 'objectFloat'` IS the pure-float path
//     and it's what real users reach for when they want measurement-grade
//     accuracy, so we benchmark it directly.
//
// What gets measured:
//   - Total wall-clock time of ~N round-trips (one round-trip = two
//     forward() calls: Lab->device, then device->Lab).
//   - Derived rate in M round-trips/s.
//   - dE76 statistics (median, p95, max). For in-gamut Lab points, this
//     is the engine's numerical fidelity (typically < 0.1 dE on a well-
//     behaved profile). For out-of-gamut Lab points, the dE reflects
//     gamut-mapping distance, which is a profile + intent property and
//     not an engine bug.

function makeLabSweepPoints(step) {
    // L: 0..100, a: -120..120, b: -120..120. Step 1 => 101 * 241 * 241 pts.
    // Returns plain objects, NOT using convert.Lab(), because that helper
    // clones a whitePoint on every call which dominates the memory cost at
    // 5.8M points. The Transform pipeline only reads L/a/b/type/whitePoint,
    // so we share one frozen whitePoint across all points.
    const jsce = state.jsce;
    const T    = jsce.eColourType.Lab;
    const wp   = jsce.convert.d50;
    const pts = [];
    for (let L = 0; L <= 100; L += step) {
        for (let a = -120; a <= 120; a += step) {
            for (let b = -120; b <= 120; b += step) {
                pts.push({ type: T, L: L, a: a, b: b, whitePoint: wp });
            }
        }
    }
    return pts;
}

/**
 * Build the two transforms + return a configured runner. Separate from the
 * run() loop so init cost is measured distinctly.
 */
function makeLabRoundTripRunner(targetKey, intentId) {
    const jsce = state.jsce;
    let target;
    if (targetKey === 'srgb')     target = '*srgb';
    else if (targetKey === 'adobergb') target = '*adobergb';
    else if (targetKey === 'gracol')   target = state.jsGracol;
    else throw new Error('Unknown profile: ' + targetKey);

    const intent = {
        relative:   jsce.eIntent.relative,
        perceptual: jsce.eIntent.perceptual,
        absolute:   jsce.eIntent.absolute,
        saturation: jsce.eIntent.saturation,
    }[intentId] || jsce.eIntent.relative;

    const lab = new jsce.Profile('*Lab');
    const labToDev = new jsce.Transform({ dataFormat: 'objectFloat', buildLut: false });
    labToDev.create(lab, target, intent);
    const devToLab = new jsce.Transform({ dataFormat: 'objectFloat', buildLut: false });
    devToLab.create(target, lab, intent);

    return { labToDev, devToLab };
}

/**
 * Run the full sweep with progress + UI yielding. Returns stats struct.
 *
 * The loop processes points in chunks so we can paint the progress bar
 * without yielding inside the hot inner loop (that destroys V8's type
 * feedback). A ~64 K chunk is small enough for smooth UI at step=1
 * (~5.9 M total) and still large enough to let TurboFan warm up.
 */
async function runLabSweep(runner, pts, onProgress) {
    const labToDev = runner.labToDev;
    const devToLab = runner.devToLab;
    const N = pts.length;
    const dEs = new Float64Array(N);

    const CHUNK = 65536;
    const tStart = nowMs();
    let idx = 0;
    while (idx < N) {
        const end = Math.min(N, idx + CHUNK);
        for (let i = idx; i < end; i++) {
            const pIn  = pts[i];
            const dev  = labToDev.forward(pIn);
            const pOut = devToLab.forward(dev);
            const dL = pIn.L - pOut.L;
            const da = pIn.a - pOut.a;
            const db = pIn.b - pOut.b;
            dEs[i] = Math.sqrt(dL * dL + da * da + db * db);
        }
        idx = end;
        if (onProgress) onProgress(idx, N);
        await yieldUi();
    }
    const totalMs = nowMs() - tStart;
    return { totalMs, dEs };
}

function dEstats(dEs, inGamutOnly) {
    // When inGamutOnly = true, drop dEs >= 2 before computing stats (those
    // are the gamut-clipped points whose "error" is really gamut distance,
    // not engine error). 2 dE is a conservative threshold - well above
    // any engine noise floor, well below any real gamut-mapping distance.
    let src = dEs;
    if (inGamutOnly) {
        const kept = [];
        for (let i = 0; i < dEs.length; i++) if (dEs[i] < 2) kept.push(dEs[i]);
        src = kept;
    } else {
        src = Array.from(dEs);
    }
    if (src.length === 0) {
        return { n: 0, mean: NaN, median: NaN, p95: NaN, max: NaN };
    }
    src.sort((a, b) => a - b);
    let sum = 0;
    for (let i = 0; i < src.length; i++) sum += src[i];
    const mean   = sum / src.length;
    const median = src[(src.length / 2) | 0];
    const p95    = src[Math.min(src.length - 1, Math.floor(src.length * 0.95))];
    const max    = src[src.length - 1];
    return { n: src.length, mean, median, p95, max };
}

function fmtDE(v) {
    if (!isFinite(v)) return '-';
    if (v < 0.01)  return v.toFixed(4);
    if (v < 1)     return v.toFixed(3);
    if (v < 10)    return v.toFixed(2);
    return v.toFixed(1);
}

/**
 * Run one kernel's sweep + stat computation. Factored out so we can run
 * RGB and CMYK back-to-back from the same click and share the point
 * array across both (it's shape-invariant - same Lab grid either way).
 */
async function runOneAccuracyKernel(kernelKey, target, intent, pts, step, inGamutOnly, progressLabel) {
    setProgress('accuracy', 0, progressLabel + ': building transforms...', 'busy');
    await yieldUi();

    const tBuild = nowMs();
    const runner = makeLabRoundTripRunner(target, intent);
    const buildMs = nowMs() - tBuild;

    setProgress('accuracy', 0.01,
        progressLabel + ': sweeping ' + pts.length.toLocaleString() + ' Lab points...',
        'busy');
    await yieldUi();

    const { totalMs, dEs } = await runLabSweep(runner, pts, (done, total) => {
        setProgress('accuracy', done / total,
            progressLabel + ': ' + done.toLocaleString() + ' / ' + total.toLocaleString(),
            'busy');
    });

    const statsAll     = dEstats(dEs, false);     // every point, raw
    const statsKept    = dEstats(dEs, true);      // < 2 dE subset (math-fidelity)
    const statsReport  = dEstats(dEs, inGamutOnly); // headline follows user's checkbox
    const rate         = pts.length / (totalMs / 1000);
    const forwardsRate = rate * 2;   // one round-trip = 2 forward() calls

    // Wire the headline cards for this kernel
    $('#ah-rate-' + kernelKey).textContent     = (rate / 1e6).toFixed(2);
    $('#ah-rate-' + kernelKey + '-sub').textContent =
        'M round-trips/s  (' + (forwardsRate / 1e6).toFixed(1) + ' M forward()/s)';
    $('#ah-time-' + kernelKey).textContent     = fmtMs(totalMs);
    $('#ah-pts-' + kernelKey).textContent      = pts.length.toLocaleString();
    $('#ah-pts-' + kernelKey + '-sub').textContent = 'Lab points, step = ' + step;
    $('#ah-dE-' + kernelKey).textContent       = fmtDE(statsReport.median);
    $('#ah-dE-' + kernelKey + '-sub').textContent = inGamutOnly
        ? 'n = ' + statsReport.n.toLocaleString() + ' (< 2 dE)'
        : 'ALL points (incl. out-of-gamut)';

    // Detail table
    const tbody = $('#results-' + kernelKey + ' tbody');
    tbody.innerHTML = '';
    const addRow = (metric, value, note) => {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td>' + metric + '</td>' +
                       '<td class="num">' + value + '</td>' +
                       '<td class="muted">' + (note || '') + '</td>';
        tbody.appendChild(tr);
    };
    addRow('Transform build',               fmtMs(buildMs) + ' ms',
        'Lab&rarr;device + device&rarr;Lab, objectFloat, buildLut: false');
    addRow('Total round-trip wall time',    fmtMs(totalMs) + ' ms',
        '2 forward() calls &times; ' + pts.length.toLocaleString() + ' pts');
    addRow('Round-trip rate',               (rate / 1e6).toFixed(2) + ' M/s',
        'One round-trip = Lab &rarr; float device &rarr; Lab');
    addRow('Forward rate',                  (forwardsRate / 1e6).toFixed(2) + ' M forward()/s',
        'Per-object float transform (no LUT, f64 pipeline)');
    addRow('&Delta;E<sub>76</sub> median (all points)', fmtDE(statsAll.median),
        'n = ' + statsAll.n.toLocaleString());
    addRow('&Delta;E<sub>76</sub> mean (all points)',   fmtDE(statsAll.mean), '');
    addRow('&Delta;E<sub>76</sub> p95 (all points)',    fmtDE(statsAll.p95),
        '95% of points are within this &Delta;E');
    addRow('&Delta;E<sub>76</sub> max (all points)',    fmtDE(statsAll.max),
        'Typically an out-of-gamut Lab point');
    addRow('&Delta;E<sub>76</sub> median (in-gamut, &lt; 2 dE)', fmtDE(statsKept.median),
        'n = ' + statsKept.n.toLocaleString() +
        ' &mdash; engine math-fidelity number');
    addRow('&Delta;E<sub>76</sub> max (in-gamut)',      fmtDE(statsKept.max), '');

    return { buildMs, totalMs, rate, forwardsRate, statsAll, statsKept };
}

async function runAccuracySweep() {
    await init();
    await browserFocus();
    const rgbKey  = $('#rgb-accuracy').value;
    const cmykKey = $('#cmyk-accuracy').value;
    const intent  = $('#intent-accuracy').value;
    const step    = parseInt($('#step-accuracy').value, 10);
    const inGamutOnly = $('#ingamut-accuracy').checked;
    const intentLabel  = $('#intent-accuracy').selectedOptions[0].text;
    const rgbLabel     = $('#rgb-accuracy').selectedOptions[0].text;
    const cmykLabel    = $('#cmyk-accuracy').selectedOptions[0].text;

    const btn = $('#run-accuracy');
    btn.disabled = true;
    $('#copy-accuracy').disabled = true;

    setProgress('accuracy', 0, 'Generating Lab sweep points...', 'busy');
    await yieldUi();

    const tGen = nowMs();
    const pts = makeLabSweepPoints(step);
    const genMs = nowMs() - tGen;

    // Unhide both result blocks with their profile labels so the progress
    // landing area isn't empty while a long sweep runs.
    $('#result-block-rgb').hidden = false;
    $('#result-block-cmyk').hidden = false;
    $('#block-rgb-label').innerHTML  = 'Lab &rarr; ' + rgbLabel  + ' &rarr; Lab &middot; ' + intentLabel;
    $('#block-cmyk-label').innerHTML = 'Lab &rarr; ' + cmykLabel + ' &rarr; Lab &middot; ' + intentLabel;

    let rgbResult = null;
    let cmykResult = null;

    try {
        rgbResult  = await runOneAccuracyKernel('rgb',  rgbKey,  intent, pts, step, inGamutOnly, 'RGB (matrix)');
        cmykResult = await runOneAccuracyKernel('cmyk', cmykKey, intent, pts, step, inGamutOnly, 'CMYK (4D tetra)');
    } catch (err) {
        setProgress('accuracy', 1, 'Error: ' + (err && err.message || err), 'error');
        btn.disabled = false;
        return;
    }

    // Final status: quote both rates so the contrast is visible at a glance.
    setProgress('accuracy', 1,
        'Done. RGB (matrix): ' + (rgbResult.rate / 1e6).toFixed(2) +
        ' M/s. CMYK (4D tetra): ' + (cmykResult.rate / 1e6).toFixed(2) +
        ' M/s. Ratio: ' + (rgbResult.rate / cmykResult.rate).toFixed(1) + 'x.',
        'done');
    btn.disabled = false;
    $('#copy-accuracy').disabled = false;

    state.lastAccuracyResults = {
        intent, step, inGamutOnly, pts: pts.length, genMs,
        intentLabel,
        rgb:  { key: rgbKey,  label: rgbLabel,  ...rgbResult  },
        cmyk: { key: cmykKey, label: cmykLabel, ...cmykResult },
    };
}

function copyAccuracyMarkdown() {
    const r = state.lastAccuracyResults;
    if (!r) return;
    const lines = [];
    lines.push('# jsColorEngine browser bench - Accuracy sweep');
    lines.push('');
    lines.push('_Generated ' + new Date().toISOString() + '_');
    lines.push('');
    lines.push('## Host & engine');
    lines.push('');
    lines.push('| Item | Value |');
    lines.push('|---|---|');
    for (const [k, v] of readEngineInfo()) {
        lines.push('| ' + k + ' | ' + (v || '-').replace(/\|/g, '\\|') + ' |');
    }
    lines.push('');
    lines.push('## Run config');
    lines.push('');
    lines.push('- Intent: ' + r.intentLabel);
    lines.push('- Sweep step: ' + r.step);
    lines.push('- Points swept: ' + r.pts.toLocaleString());
    lines.push('- RGB target (matrix kernel):  ' + r.rgb.label);
    lines.push('- CMYK target (4D tetra):      ' + r.cmyk.label);
    lines.push('- Round-trip: Lab (f64) -> device (f64) -> Lab (f64)  via objectFloat, buildLut: false');
    lines.push('');

    const ratio = (r.rgb.rate / r.cmyk.rate).toFixed(1);
    lines.push('## Summary');
    lines.push('');
    lines.push('| Kernel | Round-trip rate | forward() rate | median dE76 (in-gamut) |');
    lines.push('|---|---:|---:|---:|');
    lines.push('| RGB matrix   | ' + (r.rgb.rate  / 1e6).toFixed(2) + ' M/s | ' + (r.rgb.forwardsRate  / 1e6).toFixed(2) + ' M/s | ' + fmtDE(r.rgb.statsKept.median)  + ' |');
    lines.push('| CMYK 4D tetra | ' + (r.cmyk.rate / 1e6).toFixed(2) + ' M/s | ' + (r.cmyk.forwardsRate / 1e6).toFixed(2) + ' M/s | ' + fmtDE(r.cmyk.statsKept.median) + ' |');
    lines.push('');
    lines.push('Matrix kernel runs ' + ratio + 'x faster per forward() than the 4D tetra kernel.');
    lines.push('');

    const emitBlock = (title, x) => {
        lines.push('## ' + title);
        lines.push('');
        lines.push('| Metric | Value |');
        lines.push('|---|---:|');
        lines.push('| Transform build (x2)       | ' + fmtMs(x.buildMs) + ' ms |');
        lines.push('| Round-trip wall time       | ' + fmtMs(x.totalMs) + ' ms |');
        lines.push('| Round-trip rate            | ' + (x.rate / 1e6).toFixed(2) + ' M/s |');
        lines.push('| forward() rate             | ' + (x.forwardsRate / 1e6).toFixed(2) + ' M/s |');
        lines.push('| dE76 median (ALL)          | ' + fmtDE(x.statsAll.median) + ' |');
        lines.push('| dE76 p95    (ALL)          | ' + fmtDE(x.statsAll.p95) + ' |');
        lines.push('| dE76 max    (ALL)          | ' + fmtDE(x.statsAll.max) + ' |');
        lines.push('| dE76 median (in-gamut, <2) | ' + fmtDE(x.statsKept.median) + ' |');
        lines.push('| dE76 max    (in-gamut)     | ' + fmtDE(x.statsKept.max) + ' |');
        lines.push('| in-gamut sample count      | ' + x.statsKept.n.toLocaleString() + ' / ' + r.pts.toLocaleString() + ' |');
        lines.push('');
    };
    emitBlock('RGB round-trip - matrix kernel - ' + r.rgb.label,         r.rgb);
    emitBlock('CMYK round-trip - 4D tetrahedral kernel - ' + r.cmyk.label, r.cmyk);

    const md = lines.join('\n');
    navigator.clipboard.writeText(md).then(() => {
        const btn = $('#copy-accuracy');
        const orig = btn.textContent;
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = orig; }, 1500);
    });
}

// ============================================================ JIT WARMUP CURVE

/**
 * Resolve a `lcms-*` mode id from the warmup / pixel-sweep dropdowns into a
 * fully wired makeLcmsRunner. Handles both 8-bit and 16-bit variants:
 *
 *   lcms-highres     -> TYPE_*_8  + HIGHRESPRECALC
 *   lcms-noopt       -> TYPE_*_8  + NOOPTIMIZE
 *   lcms-default-16  -> TYPE_*_16 + flags=0
 *   lcms-highres-16  -> TYPE_*_16 + HIGHRESPRECALC
 *   lcms-noopt-16    -> TYPE_*_16 + NOOPTIMIZE
 *
 * Returns the same {run, free, lutBuildMs, ...} shape as makeJsceRunner so
 * the timing harness is identical.
 */
function makeLcmsWarmupRunner(dir, modeId, pixelCount) {
    const wf = dir.lcms;
    const is16 = modeId.endsWith('-16');
    let flags;
    if (modeId === 'lcms-highres' || modeId === 'lcms-highres-16') {
        flags = state.lcmsConsts.cmsFLAGS_HIGHRESPRECALC;
    } else if (modeId === 'lcms-noopt' || modeId === 'lcms-noopt-16') {
        flags = state.lcmsConsts.cmsFLAGS_NOOPTIMIZE;
    } else {
        flags = 0;
    }
    const fIn  = is16 ? state.lcmsConsts[wf.fIn16]  : state.lcmsConsts[wf.fIn];
    const fOut = is16 ? state.lcmsConsts[wf.fOut16] : state.lcmsConsts[wf.fOut];
    const input = is16
        ? buildInputU16(wf.inCh, pixelCount, currentContentKind())
        : buildInput(wf.inCh, pixelCount, currentContentKind());
    return makeLcmsRunner(
        state.lcms, state.lcmsConsts,
        {
            pIn:  state.lcmsProfiles[wf.pIn],
            fIn:  fIn,
            pOut: state.lcmsProfiles[wf.pOut],
            fOut: fOut,
            inCh: wf.inCh, outCh: wf.outCh,
        },
        flags, input, pixelCount
    );
}

async function runWarmupCurve() {
    await init();
    await browserFocus();
    const dirId      = $('#dir-warmup').value;
    const modeId     = $('#mode-warmup').value;
    const pixelCount = parseInt($('#pixels-warmup').value, 10);
    const iters      = parseInt($('#iters-warmup').value,  10);

    const dir = directionConfigs(state.jsGracol, state.jsIsoCoated).find((d) => d.id === dirId);
    if (!dir) return;

    setProgress('warmup', 0, 'Building runner...', 'busy');
    $('#run-warmup').disabled = true;

    // Build the runner
    let runner;
    try {
        if (modeId.startsWith('lcms-')) {
            if (!state.lcmsAvailable) throw new Error('lcms-wasm not loaded');
            runner = makeLcmsWarmupRunner(dir, modeId, pixelCount);
        } else {
            runner = makeJsceRunner(dir, modeId, pixelCount, {});
        }
    } catch (err) {
        setProgress('warmup', 1, 'Error: ' + err.message, 'error');
        $('#run-warmup').disabled = false;
        return;
    }

    // Record per-iter times
    const samples = new Float64Array(iters);
    const yieldEvery = 50;
    for (let i = 0; i < iters; i++) {
        const t0 = nowMs();
        runner.run();
        samples[i] = nowMs() - t0;
        if ((i % yieldEvery) === yieldEvery - 1) {
            setProgress('warmup', (i + 1) / iters,
                'iter ' + (i + 1) + ' / ' + iters + ' (latest: ' + samples[i].toFixed(3) + ' ms)',
                'busy');
            await yieldUi();
        }
    }
    runner.free();

    // Render
    drawWarmupChart(samples, pixelCount, modeId);
    const stableTail = samples.slice(Math.max(0, iters - 100));
    const hotMs = median(Array.from(stableTail));
    setProgress('warmup', 1,
        'Done. Hot median (last 100 iters): ' + fmtMs(hotMs) + ' ms = ' +
        fmtMpx(mpxPerSec(hotMs, pixelCount)) + ' MPx/s.', 'done');
    $('#run-warmup').disabled = false;
}

function drawWarmupChart(samples, pixelCount, modeId) {
    const canvas = $('#chart-warmup');
    const ctx    = canvas.getContext('2d');
    // Re-set canvas buffer size to match its layout size for crisp drawing
    const cssW = canvas.clientWidth || 900;
    const cssH = 320;
    const dpr  = window.devicePixelRatio || 1;
    canvas.width  = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.height = cssH + 'px';
    ctx.scale(dpr, dpr);

    const W = cssW, H = cssH;
    ctx.clearRect(0, 0, W, H);

    const padL = 56, padR = 16, padT = 16, padB = 36;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    // Y range: clip the top 1% so a single GC outlier doesn't squash the chart
    const sorted = [...samples].sort((a, b) => a - b);
    const yMaxRaw = sorted[Math.floor(sorted.length * 0.99)];
    const yMax = Math.max(yMaxRaw * 1.1, 0.001);
    const yMin = 0;

    // Background grid + axis labels
    ctx.fillStyle   = '#0f1419';
    ctx.fillRect(padL, padT, plotW, plotH);
    ctx.strokeStyle = '#2a323d';
    ctx.lineWidth   = 1;
    ctx.font        = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle   = '#8b95a4';
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'right';
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
        const v = yMin + (yMax - yMin) * (i / yTicks);
        const y = padT + plotH - (i / yTicks) * plotH;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
        ctx.fillText(v.toFixed(2) + ' ms', padL - 6, y);
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = 5;
    for (let i = 0; i <= xTicks; i++) {
        const x = padL + (i / xTicks) * plotW;
        const v = Math.round((i / xTicks) * samples.length);
        ctx.fillText(String(v), x, padT + plotH + 6);
    }

    // Scatter points (small alpha so density is visible)
    const colorByMode = {
        'no-lut':              '#94a3b8',
        'matrix-shaper':       '#e879f9',
        'float':               '#c084fc',
        'int':                 '#38bdf8',
        'int16':               '#22d3ee',
        'int16-wasm-scalar':   '#2dd4bf',
        'int16-wasm-simd':     '#14b8a6',
        'int-wasm-scalar':     '#a3e635',
        'int-wasm-simd':       '#4ade80',
        'lcms-highres':        '#fb7185',
        'lcms-noopt':          '#fbbf24',
        'lcms-default-16':     '#f472b6',
        'lcms-highres-16':     '#f43f5e',
        'lcms-noopt-16':       '#f59e0b',
    };
    ctx.fillStyle = colorByMode[modeId] || '#a3e635';
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < samples.length; i++) {
        const x = padL + (i / Math.max(1, samples.length - 1)) * plotW;
        const y = padT + plotH - (samples[i] - yMin) / (yMax - yMin) * plotH;
        ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
    }
    ctx.globalAlpha = 1;

    // Rolling median (window=21) line - much easier to see the tier-up
    const win = 21;
    const half = win >> 1;
    ctx.strokeStyle = colorByMode[modeId] || '#a3e635';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = half; i < samples.length - half; i++) {
        const slice = samples.slice(i - half, i + half + 1);
        const sortedSlice = [...slice].sort((a, b) => a - b);
        const m = sortedSlice[half];
        const x = padL + (i / Math.max(1, samples.length - 1)) * plotW;
        const y = padT + plotH - (m - yMin) / (yMax - yMin) * plotH;
        if (i === half) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Axis title
    ctx.fillStyle    = '#5c6675';
    ctx.font         = '11px ui-sans-serif, system-ui';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('iteration index   (' + pixelCount + ' pixels per iter)', padL + plotW / 2, padT + plotH + 22);
    ctx.save();
    ctx.translate(14, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('ms per iter', 0, 0);
    ctx.restore();

    // Legend
    const legend = $('#legend-warmup');
    legend.innerHTML =
        '<div class="legend-item"><span class="legend-swatch" style="background:' + (colorByMode[modeId] || '#a3e635') + ';opacity:0.5"></span>raw samples</div>' +
        '<div class="legend-item"><span class="legend-swatch" style="background:' + (colorByMode[modeId] || '#a3e635') + '"></span>rolling median (window=21)</div>';
}

// ============================================================ PIXEL SWEEP

async function runPixelSweep() {
    await init();
    await browserFocus();
    const dirId      = $('#dir-sweep').value;
    const modeId     = $('#mode-sweep').value;
    const hotPerBatch = parseInt($('#hot-sweep').value, 10);

    const dir = directionConfigs(state.jsGracol, state.jsIsoCoated).find((d) => d.id === dirId);
    if (!dir) return;

    const sizes = [
        { w:   64, h:   64 },     // 4 K
        { w:  128, h:  128 },     // 16 K
        { w:  256, h:  256 },     // 65 K
        { w:  512, h:  512 },     // 262 K
        { w: 1024, h: 1024 },     // 1 M
        { w: 2048, h: 2048 },     // 4 M
    ];

    const tbody = $('#results-sweep tbody');
    tbody.innerHTML = '';
    $('#run-sweep').disabled = true;

    const is16 = modeId.indexOf('int16') >= 0 || modeId.endsWith('-16');
    const wf = modeId.startsWith('lcms-') ? dir.lcms : dir.js;
    const bpp = totalBpp(wf.inCh, wf.outCh, is16);

    const results = [];
    for (let i = 0; i < sizes.length; i++) {
        const { w, h } = sizes[i];
        const px = w * h;
        setProgress('sweep', i / sizes.length,
            'size ' + w + 'x' + h + '  (' + px + ' px) ' + (i + 1) + '/' + sizes.length, 'busy');
        await yieldUi();

        let runner;
        try {
            if (modeId.startsWith('lcms-')) {
                if (!state.lcmsAvailable) throw new Error('lcms-wasm not loaded');
                runner = makeLcmsWarmupRunner(dir, modeId, px);
            } else {
                runner = makeJsceRunner(dir, modeId, px, {});
            }
            const itersPerBatch = Math.max(3, Math.min(hotPerBatch, Math.floor(hotPerBatch * 65536 / px)));
            const result = await measureRunner(runner, px, Math.min(50, hotPerBatch), itersPerBatch);
            runner.free();

            const mbps = result.mpxs * bpp;
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + w + ' &times; ' + h + '</td>' +
                '<td class="num">' + px.toLocaleString() + '</td>' +
                '<td class="num">' + fmtMs(result.hotMs) + '</td>' +
                '<td class="num">' + fmtMpx(result.mpxs) + '</td>' +
                '<td class="num">' + fmtMBs(mbps) + '</td>' +
                '<td class="bar-col"><div class="bar"><div class="bar-fill ' + badgeForMode(modeId) + '" data-mpx="' + result.mpxs + '"></div></div></td>';
            tbody.appendChild(tr);
            results.push(result);
        } catch (err) {
            const tr = document.createElement('tr');
            tr.innerHTML =
                '<td>' + w + ' &times; ' + h + '</td>' +
                '<td class="num">' + px.toLocaleString() + '</td>' +
                '<td class="error-cell" colspan="4">' + (err && err.message || err) + '</td>';
            tbody.appendChild(tr);
            console.error(err);
        }
        await yieldUi();
    }

    // Normalise bars
    const fastest = results.reduce((m, r) => Math.max(m, r.mpxs), 0);
    $$('#results-sweep .bar-col .bar-fill').forEach((el) => {
        const mpx = parseFloat(el.dataset.mpx);
        el.style.width = (fastest > 0 ? (mpx / fastest) * 100 : 0).toFixed(1) + '%';
    });

    setProgress('sweep', 1, 'Done.', 'done');
    $('#run-sweep').disabled = false;
}

// ============================================================ POOL DEMO

// Resolved from this module so the samples tree can sit anywhere on a site.
// `npm run browser` copies the worker into samples/browser/.
const WORKER_URL = new URL('../browser/jsColorEngineWorker.js', import.meta.url).href;
const POOL_PHOTOS = [
    {
        id: 'illustration',
        label: 'Illustration (small)',
        url: new URL('./images/illustration.jpg', import.meta.url).href,
        w: 512, h: 384,
    },
    {
        id: 'strawberries',
        label: 'Strawberries (medium)',
        url: new URL('./images/strawberries.jpg', import.meta.url).href,
        w: 1000, h: 1000,
    },
    {
        id: 'beach',
        label: 'Beach (large)',
        url: new URL('./images/beach.jpg', import.meta.url).href,
        w: 1920, h: 1280,
    },
];

let poolPhotos = null;

async function loadPoolPhoto(spec) {
    const img = new Image();
    img.decoding = 'async';
    await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('failed to load ' + spec.url));
        img.src = spec.url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = spec.w;
    canvas.height = spec.h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, spec.w, spec.h);
    const rgba = ctx.getImageData(0, 0, spec.w, spec.h).data;
    const npx = spec.w * spec.h;
    const rgb = new Uint8ClampedArray(npx * 3);
    for (let p = 0, i = 0; p < npx; p++, i += 4) {
        rgb[p * 3] = rgba[i];
        rgb[p * 3 + 1] = rgba[i + 1];
        rgb[p * 3 + 2] = rgba[i + 2];
    }
    return { spec, canvas, rgb, npx };
}

function drawRgbThumb(rgb, w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
        img.data[i]     = rgb[p * 3];
        img.data[i + 1] = rgb[p * 3 + 1];
        img.data[i + 2] = rgb[p * 3 + 2];
        img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
}

function poolStat(label, value, sub, extraClass) {
    const el = document.createElement('div');
    el.className = 'pool-stat' + (extraClass ? ' ' + extraClass : '');
    el.innerHTML = '<span class="lbl"></span><span class="val"></span>' +
        (sub ? '<span class="sub"></span>' : '');
    el.querySelector('.lbl').textContent = label;
    el.querySelector('.val').textContent = value;
    if (sub) el.querySelector('.sub').textContent = sub;
    return el;
}

function appendPoolLog(line) {
    const log = $('#pool-log');
    log.hidden = false;
    log.textContent += (log.textContent ? '\n' : '') + line;
}

function showPoolError(msg) {
    const box = $('#pool-error');
    if (!box) return;
    box.hidden = false;
    box.replaceChildren();
    const strong = document.createElement('strong');
    strong.textContent = 'Can’t run this combo. ';
    box.appendChild(strong);
    box.appendChild(document.createTextNode(msg));
}

function hidePoolError() {
    const box = $('#pool-error');
    if (!box) return;
    box.hidden = true;
    box.textContent = '';
}

function poolComboOk() {
    const dir = $('#dir-pool') && $('#dir-pool').value;
    const modeId = $('#mode-pool') && $('#mode-pool').value;
    if (modeId === 'matrix-shaper' && dir !== 'rgb-rgb') {
        showPoolError('matrix-shaper is RGB→RGB only. Switch direction to RGB → RGB, or pick another mode.');
        return false;
    }
    hidePoolError();
    return true;
}

async function runPoolDemo() {
    if (!poolComboOk()) {
        setProgress('pool', 0, 'idle');
        return;
    }
    await init();
    await browserFocus();
    const jsce = state.jsce;
    const Transform = jsce.Transform;
    $('#run-pool').disabled = true;
    hidePoolError();
    $('#pool-log').hidden = true;
    $('#pool-log').textContent = '';
    $('#pool-summary').replaceChildren();
    $('#results-pool tbody').replaceChildren();
    setProgress('pool', 0.05, 'Loading photographs…', 'busy');
    await yieldUi();

    try {
        if (!poolPhotos) {
            poolPhotos = await Promise.all(POOL_PHOTOS.map(loadPoolPhoto));
        }

        const thumbs = $('#pool-thumbs');
        thumbs.replaceChildren();
        for (const photo of poolPhotos) {
            const card = document.createElement('div');
            card.className = 'pool-thumb';
            card.appendChild(photo.canvas);
            const cap = document.createElement('div');
            cap.className = 'cap';
            cap.innerHTML = '<strong></strong><br>';
            cap.querySelector('strong').textContent = photo.spec.label;
            cap.appendChild(document.createTextNode(
                photo.spec.w + '\u00d7' + photo.spec.h + '  ·  ' +
                (photo.npx / 1e6).toFixed(2) + ' MP'));
            card.appendChild(cap);
            thumbs.appendChild(card);
        }

        const dir = $('#dir-pool').value;
        const modeId = $('#mode-pool').value;
        const dst = dir === 'rgb-rgb' ? '*adobergb' : state.jsGracol;
        const opts = (modeId === 'matrix-shaper')
            ? { dataFormat: 'int8', buildLut: false, wasmMatrixShaper: 'auto' }
            : { dataFormat: 'int8', buildLut: true, lutMode: modeId };
        opts.pixelCache = currentPixelCacheHint();

        setProgress('pool', 0.2, 'Starting worker pool…', 'busy');
        await yieldUi();
        const tSpawn = nowMs();
        const info = await Transform.enablePool({
            workerUrl: WORKER_URL,
            idleTimeoutMs: 0,
        });
        const spawnMs = nowMs() - tSpawn;
        const poolEl = $('#info-pool');
        poolEl.textContent = info.workers + ' × ' + info.host +
            (info.alreadyEnabled ? ' (already up)' : '');
        poolEl.classList.add('is-ok');
        appendPoolLog('enablePool: ' + info.workers + ' workers, host=' +
            info.host + ', ' + spawnMs.toFixed(1) + ' ms' +
            (info.alreadyEnabled ? ' (already enabled)' : ''));

        setProgress('pool', 0.35, 'Building transform…', 'busy');
        await yieldUi();
        const xform = new Transform(opts);
        xform.create('*srgb', dst, jsce.eIntent.relative);
        const k = xform.kernelInfo && xform.kernelInfo();
        appendPoolLog('kernel: ' + (k ? (k.name + (k.variant ? '/' + k.variant : '')) : modeId));

        let preview = null;
        if (dir === 'rgb-cmyk') {
            preview = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int' });
            preview.create(state.jsGracol, '*srgb', jsce.eIntent.relative);
        }

        // 1,2,3,1,2,3… × 5. Same three buffers, unique ids. A 15-image
        // queue is long enough that wall time shows the cores overlapping
        // instead of three images racing to idle.
        const REPEATS = 5;
        const images = [];
        for (let r = 0; r < REPEATS; r++) {
            for (let p = 0; p < poolPhotos.length; p++) {
                const photo = poolPhotos[p];
                images.push({
                    id: photo.spec.id + '-' + (r + 1),
                    kind: p,
                    data: photo.rgb,
                    pixelCount: photo.npx,
                    width: photo.spec.w,
                    height: photo.spec.h,
                    label: photo.spec.label,
                });
            }
        }
        const totalPx = images.reduce((a, im) => a + im.pixelCount, 0);

        setProgress('pool', 0.5, 'Sequential baseline (15 images)…', 'busy');
        await yieldUi();
        const tSeq = nowMs();
        const seq = await xform.transformImages(images, { multicore: false });
        const seqMs = nowMs() - tSeq;

        setProgress('pool', 0.65, 'Pool — first batch (LUT ship + compile)…', 'busy');
        await yieldUi();
        // Finish-order only during the timed window — no DOM. Logging
        // here used to recopy #pool-log on every image and count against
        // cold wall time.
        const finishOrder = [];
        const tCold = nowMs();
        const cold = await xform.transformImages(images, {
            multicore: true,
            requireWorkers: true,
            onImage: (_index, _data, imInfo) => {
                finishOrder.push(imInfo.id);
            },
        });
        const coldMs = nowMs() - tCold;
        finishOrder.forEach((id, i) => {
            const im = cold.imageInfo.find((info) => info && info.id === id);
            appendPoolLog('onImage  #' + (i + 1) + '  ' + id +
                '  wall ' + (im && im.ms != null ? im.ms : '—') + ' ms  compute ' +
                (im && im.computeMs != null ? im.computeMs.toFixed(1) : '—') +
                ' ms  fragments ' + (im && im.fragments != null ? im.fragments : '—'));
        });

        setProgress('pool', 0.85, 'Pool — hot 15-image queue…', 'busy');
        await yieldUi();
        const tHot = nowMs();
        const hot = await xform.transformImages(images, {
            multicore: true,
            requireWorkers: true,
        });
        const hotMs = nowMs() - tHot;

        const speedup = seqMs / hotMs;
        const hotMpx = mpxPerSec(hotMs, totalPx);
        const seqMpx = mpxPerSec(seqMs, totalPx);
        const summary = $('#pool-summary');
        summary.replaceChildren(
            poolStat('Speedup', speedup.toFixed(2) + '×',
                fmtMpx(hotMpx) + ' MPx/s total  ·  15-image queue', 'is-hero'),
            poolStat('Total MPx/s', fmtMpx(hotMpx),
                fmtMpx(seqMpx) + ' sequential'),
            poolStat('Workers', String(hot.workersUsed), info.host),
            poolStat('Fragments', String(hot.tasks),
                REPEATS + ' × 3 images'),
            poolStat('Sequential', fmtMs(seqMs) + ' ms',
                fmtMpx(seqMpx) + ' MPx/s'),
            poolStat('Pool cold', fmtMs(coldMs) + ' ms',
                'first ship + compile'),
            poolStat('Pool hot', fmtMs(hotMs) + ' ms',
                fmtMpx(hotMpx) + ' MPx/s total'),
        );

        if (typeof Transform.poolMemory === 'function') {
            appendPoolLog(Transform.poolMemory());
        }
        if (typeof Transform.workerStats === 'function') {
            const stats = Transform.workerStats();
            for (const pool of stats) {
                (pool.perWorker || []).forEach((w, i) => {
                    appendPoolLog('worker ' + i + ': ' +
                        (w.tasks || 0) + ' fragments, ' +
                        ((w.pixels || 0) / 1e6).toFixed(2) + ' MP, ' +
                        (w.mpxs != null ? w.mpxs.toFixed(1) + ' MPx/s' : '—'));
                });
                if (pool.spread != null) {
                    appendPoolLog('worker spread: ' + Number(pool.spread).toFixed(2));
                }
            }
        }

        const tbody = $('#results-pool tbody');
        tbody.replaceChildren();
        const byKind = poolPhotos.map((_, kind) =>
            hot.imageInfo.filter((_, i) => images[i].kind === kind));
        byKind.forEach((infos, kind) => {
            const photo = poolPhotos[kind];
            const avgCompute = infos.reduce((a, im) => a + (im.computeMs || 0), 0) / infos.length;
            const avgWall = infos.reduce((a, im) => a + (im.ms || 0), 0) / infos.length;
            const fragments = infos[0] && infos[0].fragments != null ? infos[0].fragments : '—';
            const mpx = avgCompute > 0 ? mpxPerSec(avgCompute, photo.npx) : 0;
            const ranks = infos.map((im) => finishOrder.indexOf(im.id))
                .filter((n) => n >= 0)
                .map((n) => n + 1);
            const avgRank = ranks.length
                ? (ranks.reduce((a, n) => a + n, 0) / ranks.length)
                : 0;
            const tr = document.createElement('tr');
            const cells = [
                photo.spec.label + '  ×' + infos.length,
                photo.spec.w + '\u00d7' + photo.spec.h,
                (photo.npx / 1e6).toFixed(2) + ' M',
                String(fragments),
                fmtMs(avgWall),
                fmtMs(avgCompute),
                fmtMpx(mpx),
                avgRank ? '#' + avgRank.toFixed(1) + ' avg' : '—',
            ];
            cells.forEach((text, c) => {
                const td = document.createElement('td');
                if (c > 0) td.className = 'num';
                td.textContent = text;
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });

        const lastOfKind = (kind) => {
            for (let i = images.length - 1; i >= 0; i--) {
                if (images[i].kind === kind) return hot.images[i];
            }
            return null;
        };

        if (preview) {
            setProgress('pool', 0.95, 'Previewing CMYK→sRGB…', 'busy');
            await yieldUi();
            thumbs.replaceChildren();
            for (let i = 0; i < poolPhotos.length; i++) {
                const photo = poolPhotos[i];
                const out = lastOfKind(i);
                const rgbOut = preview.array(out, false, false, false, photo.npx);
                const card = document.createElement('div');
                card.className = 'pool-thumb';
                card.appendChild(drawRgbThumb(rgbOut, photo.spec.w, photo.spec.h));
                const cap = document.createElement('div');
                cap.className = 'cap';
                cap.innerHTML = '<strong></strong><br>';
                cap.querySelector('strong').textContent = photo.spec.label + ' — GRACoL preview';
                cap.appendChild(document.createTextNode(
                    String(byKind[i][0] && byKind[i][0].fragments != null
                        ? byKind[i][0].fragments : '?') +
                    ' fragments · avg of ' + REPEATS));
                card.appendChild(cap);
                thumbs.appendChild(card);
            }
        } else {
            thumbs.replaceChildren();
            for (let i = 0; i < poolPhotos.length; i++) {
                const photo = poolPhotos[i];
                const card = document.createElement('div');
                card.className = 'pool-thumb';
                card.appendChild(drawRgbThumb(lastOfKind(i), photo.spec.w, photo.spec.h));
                const cap = document.createElement('div');
                cap.className = 'cap';
                cap.innerHTML = '<strong></strong><br>';
                cap.querySelector('strong').textContent = photo.spec.label + ' — AdobeRGB';
                cap.appendChild(document.createTextNode(
                    String(byKind[i][0] && byKind[i][0].fragments != null
                        ? byKind[i][0].fragments : '?') +
                    ' fragments · avg of ' + REPEATS));
                card.appendChild(cap);
                thumbs.appendChild(card);
            }
        }

        setProgress('pool', 1, 'Done. ' + hot.workersUsed + ' workers, ' +
            hot.tasks + ' fragments, ' + fmtMpx(hotMpx) + ' MPx/s total, ' +
            speedup.toFixed(2) + '× vs sequential.', 'done');
    } catch (err) {
        console.error(err);
        const msg = String(err && err.message || err);
        showPoolError(msg);
        setProgress('pool', 1, msg, 'error');
        appendPoolLog(String(err && err.stack || err));
        const poolEl = $('#info-pool');
        if (poolEl && !poolEl.classList.contains('is-ok')) {
            poolEl.textContent = 'failed — sequential fallback';
            poolEl.classList.add('is-warn');
        }
    } finally {
        $('#run-pool').disabled = false;
    }
}

function imFragments(res, i) {
    const info = res.imageInfo && res.imageInfo[i];
    return (info && info.fragments != null) ? info.fragments : '?';
}

// ============================================================ NOISE KNEE

const KNEE_PCTS = [0, 1, 2, 3, 5, 10, 15, 25, 50, 100];
const KNEE_BASES = ['solid', 'photo'];

const KNEE_SERIES = [
    { id: 'jsce-solid',    engine: 'jsce',    base: 'solid', label: 'jsCE · solid',     color: '#4ade80', dash: [] },
    { id: 'jsce-photo',    engine: 'jsce',    base: 'photo', label: 'jsCE · photo',     color: '#a3e635', dash: [6, 4] },
    { id: 'lcms-solid',    engine: 'lcms',    base: 'solid', label: 'lcms · solid',     color: '#fb7185', dash: [] },
    { id: 'lcms-photo',    engine: 'lcms',    base: 'photo', label: 'lcms · photo',     color: '#f472b6', dash: [6, 4] },
    { id: 'nocache-solid', engine: 'nocache', base: 'solid', label: 'NOCACHE · solid',  color: '#fbbf24', dash: [] },
    { id: 'nocache-photo', engine: 'nocache', base: 'photo', label: 'NOCACHE · photo',  color: '#f59e0b', dash: [6, 4] },
];

const KNEE_NOISE = [
    { id: 'jsce-noise',    engine: 'jsce',    label: 'jsCE · noise',    color: '#86efac' },
    { id: 'lcms-noise',    engine: 'lcms',    label: 'lcms · noise',    color: '#fda4af' },
    { id: 'nocache-noise', engine: 'nocache', label: 'NOCACHE · noise', color: '#fcd34d' },
];

function kneeDirection(id) {
    if (id === 'rgb-lab') {
        return {
            id: 'rgb-lab',
            shortLabel: 'RGB → Lab',
            js:   { src: '*srgb', dst: '*Lab', inCh: 3, outCh: 3 },
            lcms: {
                pIn: 'srgb', fIn: 'TYPE_RGB_8',  fIn16: 'TYPE_RGB_16',
                pOut: 'lab', fOut: 'TYPE_Lab_8', fOut16: 'TYPE_Lab_16',
                inCh: 3, outCh: 3,
            },
        };
    }
    const dirs = directionConfigs(state.jsGracol, state.jsIsoCoated);
    return dirs.find((d) => d.id === id) || dirs[1];
}

function contentKindFor(base, pct) {
    if (base === 'noise' || pct >= 100) return 'noise';
    if (pct <= 0) return base;
    return base + '-' + pct;
}

function kneeX01(pct) {
    // 0–10 % (the knee) occupies 55 % of the plot; 10–100 % the rest.
    if (pct <= 10) return (pct / 10) * 0.55;
    return 0.55 + ((pct - 10) / 90) * 0.45;
}

function renderKneePreviews() {
    const host = $('#knee-previews');
    if (!host) return;
    host.innerHTML = '';
    const side = 128;
    for (const pct of [0, 1, 3, 15, 100]) {
        const wrap = document.createElement('div');
        wrap.className = 'knee-preview';
        const canvas = document.createElement('canvas');
        canvas.width = side;
        canvas.height = side;
        paintKneePreview(canvas, pct);
        const cap = document.createElement('div');
        cap.className = 'cap';
        cap.textContent = pct === 0 ? 'photo 0%'
            : (pct === 100 ? 'noise 100%' : 'photo with ' + pct + '% noise');
        wrap.appendChild(canvas);
        wrap.appendChild(cap);
        host.appendChild(wrap);
    }
}

async function timeKneeCell(run, warmup, batches, perBatch) {
    await browserFocus();
    for (let i = 0; i < warmup; i++) run();
    await yieldUi();
    const samples = [];
    while (samples.length < batches) {
        await browserFocus();
        const t0 = nowMs();
        for (let i = 0; i < perBatch; i++) run();
        if (browserFocus.lost) {
            await browserFocus();
            continue;
        }
        samples.push((nowMs() - t0) / perBatch);
        await yieldUi();
    }
    return median(samples);
}

function drawKneeChart(seriesMap, noiseMap) {
    const canvas = $('#chart-knee');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const cssW = canvas.clientWidth || 900;
    const cssH = 380;
    const dpr  = window.devicePixelRatio || 1;
    canvas.width  = cssW * dpr;
    canvas.height = cssH * dpr;
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = cssW, H = cssH;
    ctx.clearRect(0, 0, W, H);
    const padL = 62, padR = 16, padT = 16, padB = 40;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;

    const ys = [];
    for (const s of KNEE_SERIES) {
        for (const p of (seriesMap[s.id] || [])) {
            if (isFinite(p.mpxs)) ys.push(p.mpxs);
        }
    }
    for (const n of KNEE_NOISE) {
        if (isFinite(noiseMap[n.id])) ys.push(noiseMap[n.id]);
    }
    const yMax = Math.max(10, (ys.length ? Math.max.apply(null, ys) : 100) * 1.12);

    ctx.fillStyle = '#0f1419';
    ctx.fillRect(padL, padT, plotW, plotH);
    ctx.strokeStyle = '#2a323d';
    ctx.lineWidth = 1;
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = '#8b95a4';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
        const v = (yMax * i) / yTicks;
        const y = padT + plotH - (i / yTicks) * plotH;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
        ctx.fillText(v.toFixed(0) + ' MPx/s', padL - 6, y);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const pct of KNEE_PCTS) {
        const x = padL + kneeX01(pct) * plotW;
        ctx.strokeStyle = '#2a323d';
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
        ctx.fillStyle = '#8b95a4';
        ctx.fillText(String(pct) + '%', x, padT + plotH + 8);
    }

    const kneeX = padL + kneeX01(3) * plotW;
    ctx.save();
    ctx.strokeStyle = '#e6edf3';
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(kneeX, padT); ctx.lineTo(kneeX, padT + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e6edf3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('knee', kneeX + 4, padT + 6);
    ctx.restore();

    function xy(pct, mpxs) {
        return {
            x: padL + kneeX01(pct) * plotW,
            y: padT + plotH - (mpxs / yMax) * plotH,
        };
    }

    for (const n of KNEE_NOISE) {
        const v = noiseMap[n.id];
        if (!isFinite(v)) continue;
        const y = xy(0, v).y;
        ctx.save();
        ctx.strokeStyle = n.color;
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([2, 5]);
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + plotW, y);
        ctx.stroke();
        ctx.restore();
    }

    for (const s of KNEE_SERIES) {
        const pts = (seriesMap[s.id] || []).filter((p) => isFinite(p.mpxs));
        if (!pts.length) continue;
        ctx.save();
        ctx.strokeStyle = s.color;
        ctx.fillStyle = s.color;
        ctx.lineWidth = 2;
        ctx.setLineDash(s.dash);
        ctx.beginPath();
        pts.forEach((p, i) => {
            const pt = xy(p.pct, p.mpxs);
            if (i === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        for (const p of pts) {
            const pt = xy(p.pct, p.mpxs);
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }

    const legend = $('#legend-knee');
    if (legend) {
        legend.innerHTML = '';
        const addItem = (label, color, kind) => {
            const item = document.createElement('div');
            item.className = 'legend-item';
            const sw = document.createElement('span');
            sw.className = 'legend-swatch' + (kind === 'dash' ? ' is-dash' : kind === 'dot' ? ' is-dot' : '');
            sw.style.color = color;
            if (kind === 'solid') sw.style.background = color;
            const lab = document.createElement('span');
            lab.textContent = label;
            item.appendChild(sw);
            item.appendChild(lab);
            legend.appendChild(item);
        };
        for (const s of KNEE_SERIES) {
            addItem(s.label, s.color, s.dash.length ? 'dash' : 'solid');
        }
        for (const n of KNEE_NOISE) {
            if (!isFinite(noiseMap[n.id])) continue;
            addItem(n.label + ' (' + fmtMpx(noiseMap[n.id]) + ')', n.color, 'dot');
        }
    }
}

function renderKneeTable(seriesMap) {
    const tbody = $('#results-knee tbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    const by = {};
    for (const s of KNEE_SERIES) {
        by[s.id] = {};
        for (const p of (seriesMap[s.id] || [])) by[s.id][p.pct] = p.mpxs;
    }
    for (const pct of KNEE_PCTS) {
        const tr = document.createElement('tr');
        if (pct === 3) tr.style.fontWeight = '600';
        const cells = [
            pct === 3 ? String(pct) + '%  ← knee' : String(pct) + '%',
            by['jsce-solid'][pct],
            by['jsce-photo'][pct],
            by['lcms-solid'][pct],
            by['lcms-photo'][pct],
            by['nocache-solid'][pct],
            by['nocache-photo'][pct],
        ];
        tr.innerHTML =
            '<td>' + cells[0] + '</td>' +
            cells.slice(1).map((v) =>
                '<td class="num">' + (isFinite(v) ? fmtMpx(v) : '…') + '</td>'
            ).join('');
        tbody.appendChild(tr);
    }
}

function pctDrop(a, b) {
    if (!isFinite(a) || !isFinite(b) || a === 0) return null;
    return ((b - a) / a) * 100;
}

function renderKneeInsights(seriesMap, noiseMap) {
    const host = $('#knee-insights');
    if (!host) return;
    const val = (id, pct) => {
        const hit = (seriesMap[id] || []).find((p) => p.pct === pct);
        return hit ? hit.mpxs : NaN;
    };
    const jsce1   = pctDrop(val('jsce-photo', 0), val('jsce-photo', 1));
    const cliff   = pctDrop(val('lcms-solid', 0), val('lcms-solid', 1));
    function spreadOf(ids, pct) {
        const vs = ids.map((id) => val(id, pct)).filter(isFinite);
        if (vs.length < 2) return null;
        return ((Math.max.apply(null, vs) - Math.min.apply(null, vs)) /
            Math.max.apply(null, vs)) * 100;
    }
    const jsceSpread = spreadOf(['jsce-solid', 'jsce-photo'], 3);

    host.hidden = false;
    host.innerHTML = '';
    function card(label, value, sub) {
        const el = document.createElement('div');
        el.className = 'pool-stat';
        el.innerHTML = '<span class="lbl"></span><span class="val"></span><span class="sub"></span>';
        el.querySelector('.lbl').textContent = label;
        el.querySelector('.val').textContent = value;
        el.querySelector('.sub').textContent = sub || '';
        host.appendChild(el);
    }
    const solid0 = val('jsce-solid', 0);
    const photo0 = val('jsce-photo', 0);
    if (isFinite(solid0) && isFinite(photo0) && photo0 > 0) {
        card('same colour vs a photo',
            (solid0 / photo0).toFixed(1) + '×',
            'on this PC — one colour stays in L1; a photo already wanders');
    }
    if (jsce1 != null) {
        card('1% grain, this PC',
            (jsce1 >= 0 ? '+' : '') + jsce1.toFixed(0) + '%',
            'a pinch of random colour and L1 is already missing');
    }
    if (jsceSpread != null) {
        card('past 3% on this PC',
            jsceSpread.toFixed(0) + '% spread',
            'solid and photo have already met — this machine is on the plateau');
    }
    const noiseJs = noiseMap['jsce-noise'];
    if (isFinite(noiseJs)) {
        card('pure noise, this PC',
            fmtMpx(noiseJs) + ' MPx/s',
            'worst case — almost every pixel wants a new corner of the table');
    }
    if (cliff != null) {
        card('lcms solid at 1%',
            (cliff >= 0 ? '+' : '') + cliff.toFixed(0) + '%',
            'its 1-pixel memo only helps when neighbours match');
    }
}

async function runKneeDemo() {
    await init();
    await browserFocus();
    const pixelCount = parseInt($('#pixels-knee').value, 10);
    const dir = kneeDirection($('#dir-knee').value);
    const jsceMode = state.simdSupported ? 'int-wasm-simd' : 'int';
    const inclLcms = state.lcmsAvailable;

    const seriesMap = {};
    for (const s of KNEE_SERIES) seriesMap[s.id] = [];
    const noiseMap = {};

    $('#run-knee').disabled = true;
    $('#knee-insights').hidden = true;
    renderKneePreviews();
    renderKneeTable(seriesMap);
    drawKneeChart(seriesMap, noiseMap);

    const sharedWasmCache = {};
    const runners = {};

    try {
        setProgress('knee', 0.02, 'Building transforms…', 'busy');
        await yieldUi();
        runners.jsce = makeJsceRunner(dir, jsceMode, pixelCount, sharedWasmCache, 'solid');
        if (inclLcms) {
            const wf = dir.lcms;
            const lcmsWf = {
                pIn:  state.lcmsProfiles[wf.pIn],
                fIn:  state.lcmsConsts[wf.fIn],
                pOut: state.lcmsProfiles[wf.pOut],
                fOut: state.lcmsConsts[wf.fOut],
                inCh: wf.inCh, outCh: wf.outCh,
            };
            const seed = buildInput(wf.inCh, pixelCount, 'solid');
            runners.lcms = makeLcmsRunner(
                state.lcms, state.lcmsConsts, lcmsWf, 0, seed, pixelCount);
            runners.nocache = makeLcmsRunner(
                state.lcms, state.lcmsConsts, lcmsWf,
                state.lcmsConsts.cmsFLAGS_NOCACHE, seed, pixelCount);
        }

        const engines = inclLcms ? ['jsce', 'lcms', 'nocache'] : ['jsce'];
        const cells = [];
        for (const pct of KNEE_PCTS) {
            for (const base of KNEE_BASES) {
                for (const engine of engines) {
                    cells.push({ base: base, pct: pct, engine: engine });
                }
            }
        }
        for (const engine of engines) {
            cells.push({ base: 'noise', pct: 100, engine: engine });
        }

        const warmed = {};
        let done = 0;
        for (const cell of cells) {
            const kind = contentKindFor(cell.base, cell.pct);
            const runner = runners[cell.engine];
            runner.setInput(buildInput(dir.js.inCh, pixelCount, kind));
            const warmup = warmed[cell.engine] ? 16 : 80;
            warmed[cell.engine] = true;
            setProgress('knee', done / cells.length,
                cell.engine + ' · ' + kind +
                '  (' + (done + 1) + '/' + cells.length + ')', 'busy');
            await yieldUi();
            const hotMs = await timeKneeCell(runner.run, warmup, 5, 6);
            const mpxs = mpxPerSec(hotMs, pixelCount);
            if (cell.base === 'noise') {
                noiseMap[cell.engine + '-noise'] = mpxs;
            } else {
                seriesMap[cell.engine + '-' + cell.base].push({ pct: cell.pct, mpxs: mpxs });
            }
            done++;
            renderKneeTable(seriesMap);
            drawKneeChart(seriesMap, noiseMap);
        }

        renderKneeInsights(seriesMap, noiseMap);
        setProgress('knee', 1,
            'Done. jsCE ' + (runners.jsce.actualMode || jsceMode) +
            ' · ' + dir.id +
            ' · ' + (pixelCount / 1000).toFixed(0) + ' K px' +
            (inclLcms ? '' : ' · lcms unavailable'),
            'done');
    } catch (err) {
        console.error(err);
        setProgress('knee', 1, String(err && err.message || err), 'error');
    } finally {
        for (const k of Object.keys(runners)) {
            if (runners[k] && runners[k].free) runners[k].free();
        }
        $('#run-knee').disabled = false;
    }
}

// ============================================================ TAB ROUTER

function activateTab(testId) {
    $$('.tab').forEach((b) => b.classList.toggle('is-active', b.dataset.test === testId));
    $$('.test-panel').forEach((p) => { p.hidden = p.id !== ('panel-' + testId); });
    if (testId === 'knee') renderKneePreviews();
}

// ============================================================ BOOT

// DevTools detection is handled by devtools-warn.js (loaded before this script).
// It shows a fixed yellow banner and logs console warnings when DevTools is open.

document.addEventListener('DOMContentLoaded', () => {
    // Tab handlers
    $$('.tab').forEach((btn) => {
        btn.addEventListener('click', () => activateTab(btn.dataset.test));
    });

    installBrowserFocus();

    // Run buttons
    $('#run-full').addEventListener('click',     () => runFullComparison().catch(console.error));
    $('#copy-full').addEventListener('click',    () => copyFullMarkdown());
    $('#run-accuracy').addEventListener('click', () => runAccuracySweep().catch(console.error));
    $('#copy-accuracy').addEventListener('click',() => copyAccuracyMarkdown());
    $('#run-warmup').addEventListener('click',   () => runWarmupCurve().catch(console.error));
    $('#run-sweep').addEventListener('click',    () => runPixelSweep().catch(console.error));
    $('#run-pool').addEventListener('click',     () => runPoolDemo().catch(console.error));
    const dirPool = $('#dir-pool');
    const modePool = $('#mode-pool');
    if (dirPool) dirPool.addEventListener('change', poolComboOk);
    if (modePool) modePool.addEventListener('change', poolComboOk);
    poolComboOk();
    $('#run-knee').addEventListener('click',     () => runKneeDemo().catch(console.error));

    // Pre-init so the engine info panel populates immediately on page load
    init().catch(console.error);
});
