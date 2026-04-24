/*
 * bench/browser/lcms-runner.js
 * ============================
 *
 * Thin browser-side wrapper around lcms-wasm. Provides the same
 * "pinned heap buffers + cmsDoTransform in a tight loop" pattern that
 * bench/lcms-comparison/bench.js uses on Node, so the numbers are
 * directly comparable.
 *
 * Exports:
 *   loadLcms()                                   - initialise the wasm runtime
 *   buildProfiles(lcms, gracolBytes)             - open the working profiles
 *   freeProfiles(lcms, profiles)                 - cleanup
 *   makeLcmsRunner(lcms, wf, flags, input)       - returns { run, free, lutBuildMs, kernel }
 *
 * The runner allocates wasm-heap input/output buffers once, copies the
 * input into the heap once, and then each `run()` call is a single
 * `_cmsDoTransform` invocation - the production-realistic hot path.
 *
 * Flag-set choices match bench/lcms-comparison/bench.js so we can compare
 * apples-to-apples:
 *   - cmsFLAGS_HIGHRESPRECALC  : forces a large-grid baked precalc LUT.
 *                                Mirrors jsColorEngine `buildLut: true`.
 *   - cmsFLAGS_NOOPTIMIZE      : disables the precalc LUT entirely.
 *                                Each call walks the full per-pixel
 *                                pipeline. Mirrors jsColorEngine
 *                                `buildLut: false` (the "accuracy" path).
 */

const LCMS_DIST = '/bench/lcms-comparison/node_modules/lcms-wasm/dist/';

let cachedLcms = null;
let cachedConsts = null;
let cachedBuildInfo = null;

/**
 * Inspect lcms.wasm bytes to report whether the build uses WebAssembly
 * SIMD. Run once, on demand, for the engine-info panel. Purely
 * informational - doesn't affect the bench path.
 *
 * Heuristic: the SIMD prefix byte 0xfd appears in EVERY v128 opcode
 * encoding. If the density is above ~1% of the module size, the build
 * is compiled with `-msimd128`. If it is below 0.1% (coincidental
 * occurrences in imm data / LEB128 stretches), the build is scalar.
 *
 * Measured densities:
 *   - lcms-wasm 1.0.5 stock build:           85 / 315910 = 0.027%
 *   - jsColorEngine's own tetra3d_simd.wasm: 101 / 1391   = 7.3%
 * So the heuristic has a comfortable ~100x margin between the two
 * regimes and a single-shot byte scan is all we need.
 */
export async function probeLcmsBuild() {
    if (cachedBuildInfo) return cachedBuildInfo;
    try {
        const r = await fetch(LCMS_DIST + 'lcms.wasm');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const bytes = new Uint8Array(await r.arrayBuffer());
        let fd = 0;
        for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0xfd) fd++;
        const density = fd / bytes.length;
        cachedBuildInfo = {
            size:     bytes.length,
            fdCount:  fd,
            density,
            hasSimd:  density > 0.01,
        };
    } catch (err) {
        cachedBuildInfo = { error: String(err && err.message || err) };
    }
    return cachedBuildInfo;
}

/**
 * Dynamically import lcms-wasm and instantiate the WebAssembly runtime.
 * Idempotent - caches both the runtime and the named-constant exports.
 */
export async function loadLcms() {
    if (cachedLcms) return { lcms: cachedLcms, consts: cachedConsts };

    // Dynamic import - keeps page load light, only fetches when bench is run
    const mod = await import(LCMS_DIST + 'lcms.js');

    // Tell Emscripten where to find the .wasm sibling. Default behaviour
    // resolves it relative to the importing module URL, but we make it
    // explicit so the locateFile-style hook works under any base path.
    const lcms = await mod.instantiate({
        locateFile: (name) => LCMS_DIST + name,
    });

    cachedLcms = lcms;
    cachedConsts = {
        TYPE_RGB_8:                   mod.TYPE_RGB_8,
        TYPE_CMYK_8:                  mod.TYPE_CMYK_8,
        TYPE_Lab_8:                   mod.TYPE_Lab_8,
        INTENT_RELATIVE_COLORIMETRIC: mod.INTENT_RELATIVE_COLORIMETRIC,
        cmsFLAGS_HIGHRESPRECALC:      mod.cmsFLAGS_HIGHRESPRECALC,
        cmsFLAGS_LOWRESPRECALC:       mod.cmsFLAGS_LOWRESPRECALC,
        cmsFLAGS_NOOPTIMIZE:          mod.cmsFLAGS_NOOPTIMIZE,
        cmsInfoDescription:           mod.cmsInfoDescription || 0,
        LCMS_VERSION:                 mod.LCMS_VERSION,
    };
    return { lcms, consts: cachedConsts };
}

/**
 * Open the four working profiles we need.
 *
 * `gracolBytes` - raw .icc bytes for the CMYK profile (GRACoL2006_Coated1v2).
 * `adobeBytes`  - raw .icc bytes for AdobeRGB1998.
 *
 * AdobeRGB is loaded from bytes rather than synthesised because the
 * lcms-wasm build doesn't export cmsCreateRGBProfile / cmsBuildGamma
 * (see node_modules/lcms-wasm/lib/export.txt). Critically, we MUST use a
 * non-sRGB RGB profile as the output of the RGB->RGB direction - otherwise
 * cmsCreateTransform detects the identical sRGB<->sRGB wiring, resolves
 * it to an identity at optimisation time, and the resulting MPx/s number
 * is ~30% higher than any real RGB->RGB conversion. Measured in Node:
 *   sRGB -> sRGB:     78.1 MPx/s  (identity-optimised)
 *   sRGB -> AdobeRGB: 59.6 MPx/s  (real matrix + curves)
 *
 * Returns { srgb, adobe, cmyk, lab, cmykName, adobeName } with pointers
 * you must free via freeProfiles().
 */
export function buildProfiles(lcms, gracolBytes, adobeBytes) {
    const cmyk = lcms.cmsOpenProfileFromMem(gracolBytes, gracolBytes.byteLength);
    if (!cmyk) throw new Error('lcms-wasm: cmsOpenProfileFromMem(GRACoL) failed');
    const srgb = lcms.cmsCreate_sRGBProfile();
    if (!srgb) throw new Error('lcms-wasm: cmsCreate_sRGBProfile failed');
    const lab  = lcms.cmsCreateLab4Profile(null);
    if (!lab)  throw new Error('lcms-wasm: cmsCreateLab4Profile failed');
    if (!adobeBytes || !adobeBytes.byteLength) {
        throw new Error('lcms-wasm: buildProfiles requires AdobeRGB bytes (for a real RGB->RGB, not identity)');
    }
    const adobe = lcms.cmsOpenProfileFromMem(adobeBytes, adobeBytes.byteLength);
    if (!adobe) throw new Error('lcms-wasm: cmsOpenProfileFromMem(AdobeRGB) failed');

    // Grab friendly profile descriptions for the engine-info panel. Not all
    // builds expose cmsGetProfileInfoASCII the same way - guard it.
    const readName = (p, fallback) => {
        try {
            if (typeof lcms.cmsGetProfileInfoASCII === 'function') {
                const desc = lcms.cmsGetProfileInfoASCII(p, 0 /* description */, 'en', 'US');
                if (desc && typeof desc === 'string' && desc.length) return desc;
            }
        } catch (_) { /* fall through */ }
        return fallback;
    };
    const cmykName  = readName(cmyk,  'GRACoL2006');
    const adobeName = readName(adobe, 'AdobeRGB (1998)');

    return { srgb, adobe, cmyk, lab, cmykName, adobeName };
}

export function freeProfiles(lcms, profiles) {
    if (!profiles) return;
    if (profiles.srgb)  lcms.cmsCloseProfile(profiles.srgb);
    if (profiles.adobe) lcms.cmsCloseProfile(profiles.adobe);
    if (profiles.cmyk)  lcms.cmsCloseProfile(profiles.cmyk);
    if (profiles.lab)   lcms.cmsCloseProfile(profiles.lab);
}

/**
 * Build a "runner" object that owns the pinned heap buffers and the
 * cmsTransform handle. Matches the shape returned by makeJsceRunner()
 * in main.js so the timing harness is identical for both.
 *
 * @param  {object}     lcms        instantiated lcms-wasm runtime
 * @param  {object}     consts      named constants from loadLcms()
 * @param  {object}     wf          { pIn, fIn, pOut, fOut, inCh, outCh }
 * @param  {number}     flags       lcms flag mask (e.g. HIGHRESPRECALC | NOOPTIMIZE)
 * @param  {Uint8Array} input       pixel buffer (length = pixels * inCh)
 * @param  {number}     pixelCount  number of pixels to transform per call
 *
 * Returns:
 *   {
 *     run:         () => void          // hot-path: single _cmsDoTransform call
 *     free:        () => void          // free heap buffers + transform handle
 *     lutBuildMs:  number              // wall-clock of cmsCreateTransform
 *     output:      Uint8Array          // result buffer (heap-backed view)
 *   }
 *
 * If cmsCreateTransform fails (e.g. unsupported flag combo on this profile),
 * throws with a descriptive message - the caller marks the cell as errored
 * and continues with the next config.
 */
export function makeLcmsRunner(lcms, consts, wf, flags, input, pixelCount) {
    const inBytes  = pixelCount * wf.inCh;
    const outBytes = pixelCount * wf.outCh;

    const inPtr  = lcms._malloc(inBytes);
    const outPtr = lcms._malloc(outBytes);
    if (!inPtr || !outPtr) {
        if (inPtr)  lcms._free(inPtr);
        if (outPtr) lcms._free(outPtr);
        throw new Error('lcms-wasm: _malloc failed for ' + (inBytes + outBytes) + ' bytes');
    }
    lcms.HEAPU8.set(input.subarray(0, inBytes), inPtr);

    // ---- LUT build time: cmsCreateTransform is the lcms equivalent of
    // jsColorEngine's "Transform.create(...)" + buildIntLut. With
    // HIGHRESPRECALC it bakes a high-grid precalc LUT here; with
    // NOOPTIMIZE it does almost nothing (kernel is built lazily).
    const t0 = performance.now();
    const xf = lcms.cmsCreateTransform(
        wf.pIn,  wf.fIn,
        wf.pOut, wf.fOut,
        consts.INTENT_RELATIVE_COLORIMETRIC,
        flags
    );
    const lutBuildMs = performance.now() - t0;

    if (!xf) {
        lcms._free(inPtr);
        lcms._free(outPtr);
        throw new Error('lcms-wasm: cmsCreateTransform failed (flags=0x' +
                        flags.toString(16) + ')');
    }

    // The hot-path closure - pinned ptrs, captured in scope, no allocs per call.
    function run() {
        lcms._cmsDoTransform(xf, inPtr, outPtr, pixelCount);
    }

    function free() {
        lcms.cmsDeleteTransform(xf);
        lcms._free(inPtr);
        lcms._free(outPtr);
    }

    // outputView is for sanity-checks; do NOT hold across resize of HEAPU8.
    function outputBytes() {
        return new Uint8Array(lcms.HEAPU8.buffer, outPtr, outBytes).slice();
    }

    return { run, free, lutBuildMs, outputBytes };
}

/**
 * Pretty short label for an lcms flag set, for the results table.
 */
export function lcmsFlagLabel(consts, flags) {
    if (flags === consts.cmsFLAGS_HIGHRESPRECALC) return 'lcms-wasm HIGHRES';
    if (flags === consts.cmsFLAGS_LOWRESPRECALC)  return 'lcms-wasm LOWRES';
    if (flags === consts.cmsFLAGS_NOOPTIMIZE)     return 'lcms-wasm NOOPT';
    if (flags === 0)                              return 'lcms-wasm default';
    return 'lcms-wasm 0x' + flags.toString(16);
}
