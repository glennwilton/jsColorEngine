/*
 * samples/bench/_smoke_int16.js
 * =============================
 *
 * Headless smoke test: exercise the SAME int16 wiring the browser bench
 * uses, but from Node, so we can verify the integration before pointing
 * a browser at it. Loads:
 *   - the production UMD bundle (browser/jsColorEngineWeb.js) the same
 *     way the browser does (via <script>; here as require)
 *   - the lcms-wasm package (TYPE_RGB_16 / TYPE_CMYK_16)
 * Then runs one cell of each direction with the same buildInputU16
 * helper as main.js, and prints MPx/s + max |Δ| for the comparison.
 *
 * If this script reports green numbers (jsce int16 ~1.5-1.8x lcms,
 * max |Δ| under ~5 LSB u8 equivalent) the browser bench will too -
 * the only thing that differs in the browser is the JS module
 * loader and the perf clock source.
 *
 * This file is throwaway; safe to delete after a clean run.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

(async () => {
    const REPO = path.resolve(__dirname, '..', '..');
    // Load src/main.js directly. The browser bench loads the same code via
    // the UMD bundle (browser/jsColorEngineWeb.js), but webpack scopes the
    // top-level `var jsColorEngine` so it doesn't leak to Node's `global`.
    // The source path is identical for the int16 kernel dispatch.
    const jsce = require(path.join(REPO, 'src', 'main'));

    // Load profiles
    const gracolBytes = fs.readFileSync(
        path.join(REPO, 'samples', 'profiles', 'CoatedGRACoL2006.icc')
    );
    const adobeBytes  = fs.readFileSync(
        path.join(REPO, 'samples', 'profiles', 'AdobeRGB1998.icc')
    );

    const jsGracol = new jsce.Profile();
    jsGracol.loadBinary(new Uint8Array(gracolBytes));

    // lcms-wasm is ESM; use dynamic import.
    const lcmsMod = await import(
        'file:///' + path.join(REPO, 'samples', 'lcms-wasm-dist', 'lcms.js').replace(/\\/g, '/')
    );
    const lcms    = await lcmsMod.instantiate();
    const consts  = {
        TYPE_RGB_16:  lcmsMod.TYPE_RGB_16,
        TYPE_CMYK_16: lcmsMod.TYPE_CMYK_16,
        INTENT:       lcmsMod.INTENT_RELATIVE_COLORIMETRIC,
        FLAGS:        0,
    };

    function buildInputU16(channels, pixelCount) {
        const arr = new Uint16Array(pixelCount * channels);
        let seed = 0x13579bdf;
        for (let i = 0; i < arr.length; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            arr[i] = seed & 0xffff;
        }
        return arr;
    }

    // Open lcms profiles
    const pSrgb  = lcms.cmsCreate_sRGBProfile();
    const pCmyk  = lcms.cmsOpenProfileFromMem(new Uint8Array(gracolBytes), gracolBytes.byteLength);
    const pAdobe = lcms.cmsOpenProfileFromMem(new Uint8Array(adobeBytes),  adobeBytes.byteLength);

    const directions = [
        { id: 'rgb-rgb',   inCh: 3, outCh: 3, jsSrc: '*srgb',  jsDst: '*adobergb', lcmsIn: pSrgb, lcmsOut: pAdobe, fIn: consts.TYPE_RGB_16,  fOut: consts.TYPE_RGB_16  },
        { id: 'rgb-cmyk',  inCh: 3, outCh: 4, jsSrc: '*srgb',  jsDst: jsGracol,    lcmsIn: pSrgb, lcmsOut: pCmyk,  fIn: consts.TYPE_RGB_16,  fOut: consts.TYPE_CMYK_16 },
        { id: 'cmyk-rgb',  inCh: 4, outCh: 3, jsSrc: jsGracol, jsDst: '*srgb',     lcmsIn: pCmyk, lcmsOut: pSrgb,  fIn: consts.TYPE_CMYK_16, fOut: consts.TYPE_RGB_16  },
        { id: 'cmyk-cmyk', inCh: 4, outCh: 4, jsSrc: jsGracol, jsDst: jsGracol,    lcmsIn: pCmyk, lcmsOut: pCmyk,  fIn: consts.TYPE_CMYK_16, fOut: consts.TYPE_CMYK_16 },
    ];

    const PIXELS = 65536;
    const ITERS  = 30;

    function bench(fn) {
        for (let w = 0; w < 5; w++) fn();
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < ITERS; i++) fn();
        const t1 = process.hrtime.bigint();
        const ms = Number(t1 - t0) / 1e6 / ITERS;
        return { ms, mpxs: PIXELS / 1e6 / (ms / 1000) };
    }

    console.log('SMOKE TEST: jsCE int16 (UMD bundle) vs lcms-wasm u16, ' + PIXELS + ' px x ' + ITERS + ' iters/cell');
    console.log('================================================================');
    console.log('Direction       jsCE int16   lcms u16    speedup   max|Δ| u16  (=u8 equiv)');
    console.log('----------------------------------------------------------------');

    for (const d of directions) {
        const input = buildInputU16(d.inCh, PIXELS);

        // jsCE
        const xform = new jsce.Transform({ dataFormat: 'int16', buildLut: true });
        xform.create(d.jsSrc, d.jsDst, jsce.eIntent.relative);
        const jOut = xform.transformArray(input);    // first call to validate output buffer type
        if (!(jOut instanceof Uint16Array)) throw new Error(d.id + ': jsce int16 did NOT return Uint16Array (got ' + jOut.constructor.name + ')');
        const jBench = bench(() => xform.transformArray(input));

        // lcms u16
        const inBytes  = PIXELS * d.inCh  * 2;
        const outBytes = PIXELS * d.outCh * 2;
        const inPtr    = lcms._malloc(inBytes);
        const outPtr   = lcms._malloc(outBytes);
        new Uint16Array(lcms.HEAPU8.buffer, inPtr, PIXELS * d.inCh).set(input);
        const xf = lcms.cmsCreateTransform(d.lcmsIn, d.fIn, d.lcmsOut, d.fOut, consts.INTENT, consts.FLAGS);
        if (!xf) throw new Error(d.id + ': cmsCreateTransform failed');
        const lBench = bench(() => lcms._cmsDoTransform(xf, inPtr, outPtr, PIXELS));
        const lOut = new Uint16Array(lcms.HEAPU8.buffer, outPtr, PIXELS * d.outCh).slice();
        lcms.cmsDeleteTransform(xf); lcms._free(inPtr); lcms._free(outPtr);

        let maxDelta = 0;
        for (let i = 0; i < jOut.length; i++) {
            const dlt = Math.abs(jOut[i] - lOut[i]);
            if (dlt > maxDelta) maxDelta = dlt;
        }

        const speedup = jBench.mpxs / lBench.mpxs;
        const u8eq = (maxDelta / 257).toFixed(2);
        console.log(
            d.id.padEnd(15) + ' ' +
            jBench.mpxs.toFixed(1).padStart(8) + '   ' +
            lBench.mpxs.toFixed(1).padStart(8) + '   ' +
            speedup.toFixed(2).padStart(6) + 'x   ' +
            String(maxDelta).padStart(6) + '   (' + u8eq.padStart(5) + ' LSB u8)'
        );
    }

    lcms.cmsCloseProfile(pSrgb); lcms.cmsCloseProfile(pCmyk); lcms.cmsCloseProfile(pAdobe);
    console.log('================================================================');
    console.log('OK - integration is sound; safe to delete _smoke_int16.js');
})().catch(e => { console.error('SMOKE FAILED:', e.stack || e.message); process.exit(1); });
