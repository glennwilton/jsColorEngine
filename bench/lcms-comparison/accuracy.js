/*
 * bench/lcms-comparison/accuracy.js
 * =================================
 *
 * Accuracy check: run the same input pixels through jsColorEngine and
 * lcms-wasm side-by-side, and report how far apart the 8-bit outputs
 * are. This is the reality-check before claiming a speed win.
 *
 * Test inputs (per workflow):
 *   - a dense systematic grid through the input cube (9^3 or 9^4 samples)
 *   - a set of named reference points (whites, blacks, primaries,
 *     mid-greys, deep shadow, skin tones, etc.)
 *
 * Reported per workflow:
 *   - exact match %
 *   - within 1 LSB %
 *   - within 2 LSB %
 *   - max |delta| and mean |delta| across all output channels
 *   - the 5 worst input samples with both outputs side-by-side
 *
 * Run: cd bench/lcms-comparison && node accuracy.js
 */

import { readFile } from 'fs/promises';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
    instantiate,
    TYPE_RGB_8,
    TYPE_CMYK_8,
    TYPE_Lab_8,
    INTENT_RELATIVE_COLORIMETRIC,
    cmsFLAGS_HIGHRESPRECALC,
} from 'lcms-wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const { Transform, eIntent } = require('../../src/main');
const Profile = require('../../src/Profile');

const GRACOL_PATH = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');


// ---- input sets -----------------------------------------------------

// Dense systematic grid: step 32 through [0..255] -> 9 values per axis
const GRID_STEPS = [0, 32, 64, 96, 128, 160, 192, 224, 255];

function buildGrid3D(){
    const out = [];
    for(const r of GRID_STEPS){
        for(const g of GRID_STEPS){
            for(const b of GRID_STEPS){
                out.push([r, g, b]);
            }
        }
    }
    return out;
}

function buildGrid4D(){
    const out = [];
    for(const c of GRID_STEPS){
        for(const m of GRID_STEPS){
            for(const y of GRID_STEPS){
                for(const k of GRID_STEPS){
                    out.push([c, m, y, k]);
                }
            }
        }
    }
    return out;
}

// A small set of named reference colors (RGB inputs) so if something
// goes badly wrong on e.g. pure primaries we see the named sample in
// the "worst offenders" list.
const NAMED_RGB = [
    { name: 'white',       px: [255, 255, 255] },
    { name: 'black',       px: [  0,   0,   0] },
    { name: 'mid grey',    px: [128, 128, 128] },
    { name: '25% grey',    px: [ 64,  64,  64] },
    { name: '75% grey',    px: [192, 192, 192] },
    { name: 'pure red',    px: [255,   0,   0] },
    { name: 'pure green',  px: [  0, 255,   0] },
    { name: 'pure blue',   px: [  0,   0, 255] },
    { name: 'cyan',        px: [  0, 255, 255] },
    { name: 'magenta',     px: [255,   0, 255] },
    { name: 'yellow',      px: [255, 255,   0] },
    { name: 'skin tone',   px: [224, 172, 144] },
    { name: 'deep shadow', px: [ 12,   8,   6] },
    { name: 'paper white', px: [252, 250, 248] },
];

const NAMED_CMYK = [
    { name: 'paper',       px: [  0,   0,   0,   0] },
    { name: 'solid K',     px: [  0,   0,   0, 255] },
    { name: 'rich black',  px: [200, 180, 170, 255] },
    { name: '100% C',      px: [255,   0,   0,   0] },
    { name: '100% M',      px: [  0, 255,   0,   0] },
    { name: '100% Y',      px: [  0,   0, 255,   0] },
    { name: '50% grey',    px: [ 50,  39,  39, 128] },
    { name: 'skin tone',   px: [ 12,  45,  55,   0] },
    { name: 'dark blue',   px: [230, 175,  40,  35] },
    { name: 'sky',         px: [148,  52,  15,   0] },
];


// ---- helpers --------------------------------------------------------

function flatten(pixels, ch){
    const out = new Uint8ClampedArray(pixels.length * ch);
    for(let i = 0; i < pixels.length; i++){
        for(let c = 0; c < ch; c++) out[i * ch + c] = pixels[i][c];
    }
    return out;
}

function fmtPx(arr, ch, i){
    const p = [];
    for(let c = 0; c < ch; c++) p.push(String(arr[i * ch + c]).padStart(3));
    return '(' + p.join(',') + ')';
}

function compare(name, pixels, inCh, outCh, lcmsBytes, jsBytes, namedSamples){
    const n = pixels.length;
    let maxDiff = 0;
    let sumDiff = 0;
    let diffCount = 0;
    let exact = 0;
    let within1 = 0;
    let within2 = 0;

    // worst N offenders
    const worst = [];
    const WORST_KEEP = 8;

    for(let i = 0; i < n; i++){
        let pxMaxDiff = 0;
        let pxSumDiff = 0;
        for(let c = 0; c < outCh; c++){
            const d = Math.abs(lcmsBytes[i*outCh+c] - jsBytes[i*outCh+c]);
            if(d > pxMaxDiff) pxMaxDiff = d;
            pxSumDiff += d;
            if(d > maxDiff) maxDiff = d;
            sumDiff += d;
            diffCount++;
        }
        if(pxMaxDiff === 0) exact++;
        if(pxMaxDiff <= 1) within1++;
        if(pxMaxDiff <= 2) within2++;

        if(pxMaxDiff > 0){
            const rec = { idx: i, pxMaxDiff, pxSumDiff };
            // keep the WORST_KEEP most-different samples
            if(worst.length < WORST_KEEP){
                worst.push(rec);
                worst.sort((a,b) => b.pxMaxDiff - a.pxMaxDiff || b.pxSumDiff - a.pxSumDiff);
            } else if(pxMaxDiff > worst[WORST_KEEP-1].pxMaxDiff ||
                     (pxMaxDiff === worst[WORST_KEEP-1].pxMaxDiff && pxSumDiff > worst[WORST_KEEP-1].pxSumDiff)){
                worst[WORST_KEEP-1] = rec;
                worst.sort((a,b) => b.pxMaxDiff - a.pxMaxDiff || b.pxSumDiff - a.pxSumDiff);
            }
        }
    }

    const meanDiff = sumDiff / diffCount;

    console.log('\n--------------------------------------------------------------');
    console.log(' ' + name);
    console.log('--------------------------------------------------------------');
    console.log('  samples                  : ' + n);
    console.log('  exact match              : ' + exact + ' / ' + n + '  (' + (100 * exact / n).toFixed(2) + ' %)');
    console.log('  within 1 LSB             : ' + within1 + ' / ' + n + '  (' + (100 * within1 / n).toFixed(2) + ' %)');
    console.log('  within 2 LSB             : ' + within2 + ' / ' + n + '  (' + (100 * within2 / n).toFixed(2) + ' %)');
    console.log('  max |delta| across ch    : ' + maxDiff + ' LSB');
    console.log('  mean |delta|  across ch  : ' + meanDiff.toFixed(3) + ' LSB');

    if(worst.length > 0){
        console.log('  worst offenders:');
        for(const w of worst){
            const inStr = fmtPx(flatten([pixels[w.idx]], inCh), inCh, 0);
            const jsStr = fmtPx(jsBytes, outCh, w.idx);
            const lcStr = fmtPx(lcmsBytes, outCh, w.idx);
            console.log('    in ' + inStr + '  js ' + jsStr + '  lcms ' + lcStr +
                        '   Δmax=' + w.pxMaxDiff + ' Δsum=' + w.pxSumDiff);
        }
    }

    // Named samples (always print, even if exact)
    if(namedSamples && namedSamples.length){
        console.log('  named reference samples:');
        for(const ns of namedSamples){
            // Find ns in pixels (first index — our grid + named are appended
            // so named samples are always at a known offset)
            const idx = ns.idx;
            const inStr = fmtPx(flatten([pixels[idx]], inCh), inCh, 0);
            const jsStr = fmtPx(jsBytes, outCh, idx);
            const lcStr = fmtPx(lcmsBytes, outCh, idx);
            let maxD = 0;
            for(let c = 0; c < outCh; c++){
                const d = Math.abs(lcmsBytes[idx*outCh+c] - jsBytes[idx*outCh+c]);
                if(d > maxD) maxD = d;
            }
            console.log('    ' + ns.name.padEnd(12) + ' in ' + inStr +
                        '  js ' + jsStr + '  lcms ' + lcStr + '   Δmax=' + maxD);
        }
    }

    return { name, n, exact, within1, within2, maxDiff, meanDiff };
}


// ---- main -----------------------------------------------------------

const lcms = await instantiate();

// Profiles
const gracolBytes = await readFile(GRACOL_PATH);
const lcmsGRACoL  = lcms.cmsOpenProfileFromMem(new Uint8Array(gracolBytes), gracolBytes.byteLength);
const lcmsSRGB    = lcms.cmsCreate_sRGBProfile();
const lcmsLab     = lcms.cmsCreateLab4Profile(null);

const jsGRACoL = new Profile();
await jsGRACoL.loadPromise('file:' + GRACOL_PATH);
if(!jsGRACoL.loaded) throw new Error('js: failed to load GRACoL');


function runLcms(pIn, fIn, pOut, fOut, input, nPx){
    // HIGHRESPRECALC: match our "big precomputed LUT" story for fairness
    const xf = lcms.cmsCreateTransform(pIn, fIn, pOut, fOut,
        INTENT_RELATIVE_COLORIMETRIC, cmsFLAGS_HIGHRESPRECALC);
    const out = lcms.cmsDoTransform(xf, input, nPx);
    lcms.cmsDeleteTransform(xf);
    return out;
}

function runJS(src, dst, input, lutMode){
    const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode});
    t.create(src, dst, eIntent.relative);
    return t.transformArray(input);
}


// Build test inputs for 3D and 4D
const grid3D = buildGrid3D();                                 // 729 RGB samples
const grid4D = buildGrid4D();                                 // 6561 CMYK samples

// For RGB inputs, append named RGB samples and remember their indices
function withNamed(grid, named, inCh){
    const pixels = grid.slice();
    const recs = named.map(n => ({ name: n.name, idx: pixels.length + named.indexOf(n) }));
    for(const n of named) pixels.push(n.px);
    return { pixels, recs };
}

const rgbSet  = withNamed(grid3D, NAMED_RGB, 3);
const cmykSet = withNamed(grid4D, NAMED_CMYK, 4);


// ---- workflows ------------------------------------------------------

const results = [];

function runWorkflow(name, inputSet, inCh, outCh, lcmsArgs, jsArgs){
    const input = flatten(inputSet.pixels, inCh);
    const lcmsOut = runLcms(lcmsArgs.pIn, lcmsArgs.fIn, lcmsArgs.pOut, lcmsArgs.fOut, input, inputSet.pixels.length);
    // Compare BOTH lutMode variants vs lcms — we want to know whether
    // 'int' introduces extra drift vs 'float'.
    const jsFloatOut = runJS(jsArgs.src, jsArgs.dst, input, 'float');
    const jsIntOut   = runJS(jsArgs.src, jsArgs.dst, input, 'int');

    results.push(compare(name + '   js[float] vs lcms-wasm',
        inputSet.pixels, inCh, outCh, lcmsOut, jsFloatOut, inputSet.recs));
    results.push(compare(name + '   js[int]   vs lcms-wasm',
        inputSet.pixels, inCh, outCh, lcmsOut, jsIntOut, inputSet.recs));

    // Also js-float vs js-int to be sure our lutMode swap isn't drifting
    results.push(compare(name + '   js[float] vs js[int]  (self-check)',
        inputSet.pixels, inCh, outCh, jsFloatOut, jsIntOut, inputSet.recs));
}


console.log('==============================================================');
console.log(' Accuracy check — jsColorEngine vs lcms-wasm (8-bit I/O)');
console.log('==============================================================');
console.log(' intent        : relative colorimetric');
console.log(' lcms flags    : cmsFLAGS_HIGHRESPRECALC');
console.log(' profile       : GRACoL2006_Coated1v2.icc');
console.log(' node          : ' + process.version);
console.log(' lcms-wasm     : 1.0.5 (LCMS 2.16 compiled to wasm32)');
console.log(' grid          : ' + GRID_STEPS.length + '^N through input cube (+ named samples)');


runWorkflow('RGB -> Lab    (sRGB -> LabD50)',
    rgbSet, 3, 3,
    { pIn: lcmsSRGB,   fIn: TYPE_RGB_8,  pOut: lcmsLab,     fOut: TYPE_Lab_8  },
    { src: '*srgb',    dst: '*labd50' });

runWorkflow('RGB -> CMYK   (sRGB -> GRACoL)',
    rgbSet, 3, 4,
    { pIn: lcmsSRGB,   fIn: TYPE_RGB_8,  pOut: lcmsGRACoL,  fOut: TYPE_CMYK_8 },
    { src: '*srgb',    dst: jsGRACoL });

runWorkflow('CMYK -> RGB   (GRACoL -> sRGB)',
    cmykSet, 4, 3,
    { pIn: lcmsGRACoL, fIn: TYPE_CMYK_8, pOut: lcmsSRGB,    fOut: TYPE_RGB_8  },
    { src: jsGRACoL,   dst: '*srgb' });

runWorkflow('CMYK -> CMYK  (GRACoL -> GRACoL)',
    cmykSet, 4, 4,
    { pIn: lcmsGRACoL, fIn: TYPE_CMYK_8, pOut: lcmsGRACoL,  fOut: TYPE_CMYK_8 },
    { src: jsGRACoL,   dst: jsGRACoL });


// ---- summary table --------------------------------------------------

console.log('\n==============================================================');
console.log(' SUMMARY — accuracy');
console.log('==============================================================');
console.log('  workflow                                                samples  exact%  ≤1LSB%  ≤2LSB%  max  mean');
console.log('  ------------------------------------------------------  -------  ------  ------  ------  ---  ----');
for(const r of results){
    const line = '  ' + r.name.padEnd(54) +
                 '  ' + String(r.n).padStart(5) +
                 '   ' + (100 * r.exact   / r.n).toFixed(2).padStart(5) +
                 '   ' + (100 * r.within1 / r.n).toFixed(2).padStart(5) +
                 '   ' + (100 * r.within2 / r.n).toFixed(2).padStart(5) +
                 '   ' + String(r.maxDiff).padStart(3) +
                 '  ' + r.meanDiff.toFixed(3).padStart(5);
    console.log(line);
}

// Clean up
lcms.cmsCloseProfile(lcmsGRACoL);
lcms.cmsCloseProfile(lcmsSRGB);
lcms.cmsCloseProfile(lcmsLab);
