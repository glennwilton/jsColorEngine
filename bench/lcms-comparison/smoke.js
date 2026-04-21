/*
 * Smoke test — loads lcms-wasm, builds a transform against GRACoL2006,
 * runs a handful of pixels, and prints the output. Just confirms that
 * the library works on this machine before we spin up the real bench.
 */
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    instantiate,
    TYPE_RGB_8,
    TYPE_CMYK_8,
    TYPE_Lab_8,
    INTENT_RELATIVE_COLORIMETRIC,
    cmsInfoDescription,
} from 'lcms-wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GRACOL_PATH = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

const lcms = await instantiate();

// Load GRACoL profile from disk
const buf = await readFile(GRACOL_PATH);
const gracol = lcms.cmsOpenProfileFromMem(new Uint8Array(buf), buf.byteLength);
if(!gracol) throw new Error('failed to open GRACoL');
console.log('GRACoL loaded:');
console.log('  name :', lcms.cmsGetProfileInfoASCII(gracol, cmsInfoDescription, 'en', 'US'));
console.log('  space:', lcms.cmsGetColorSpaceASCII(gracol));

// Build sRGB virtual profile
const srgb = lcms.cmsCreate_sRGBProfile();
console.log('sRGB built in:', lcms.cmsGetColorSpaceASCII(srgb));

// Build sRGB -> CMYK transform, try a few values
const xf_rgb_to_cmyk = lcms.cmsCreateTransform(
    srgb,   TYPE_RGB_8,
    gracol, TYPE_CMYK_8,
    INTENT_RELATIVE_COLORIMETRIC, 0
);

const samples = new Uint8Array([
    255,255,255,  // white
      0,  0,  0,  // black
    255,  0,  0,  // red
      0,255,  0,  // green
      0,  0,255,  // blue
    128,128,128,  // mid grey
]);
const out = lcms.cmsDoTransform(xf_rgb_to_cmyk, samples, samples.length / 3);
console.log('\nsRGB -> GRACoL CMYK (8-bit):');
for(let i = 0; i < samples.length / 3; i++){
    const r = samples[i*3], g = samples[i*3+1], b = samples[i*3+2];
    const c = out[i*4], m = out[i*4+1], y = out[i*4+2], k = out[i*4+3];
    console.log(`  rgb(${r},${g},${b}) -> cmyk(${c},${m},${y},${k})`);
}

lcms.cmsDeleteTransform(xf_rgb_to_cmyk);
lcms.cmsCloseProfile(gracol);
lcms.cmsCloseProfile(srgb);
console.log('\nOK.');
