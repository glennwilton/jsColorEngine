/**
 * bench/lcms-comparison/accuracy_gray.js
 *
 * THE FIRST ORACLE KERNEL1D HAS EVER HAD.
 *
 * accuracy.js compares jsColorEngine against Little CMS for RGB and CMYK,
 * because those are the profiles this repo can legally ship. Everything else —
 * 1, 2 and 5-15 channels — had no oracle at all: there was nothing to hand
 * lcms, so those kernels could only be checked against themselves. A suite
 * that only agrees with itself is exactly how a dropped clamp survived in four
 * interpolators at once.
 *
 * The way out is not to find profiles, it is to WRITE them. A profile the
 * engine wrote has no licensing question, and both engines can be pointed at
 * the same file. src/encodeICC.js does that; scripts/make_test_profiles.js
 * writes them to __tests__/profiles/ once, and this reads them from there
 * rather than regenerating — they are ordinary ICC files and worth being able
 * to open in an inspector.
 *
 * WHAT THIS PROVES THAT THE UNIT TESTS CANNOT. encodeICC.tests.js proves the
 * bytes are well-formed and that OUR decoder reads back what OUR encoder
 * wrote. A writer can be self-consistently wrong. This proves a second,
 * independent CMS opens the file, agrees what it means, and converts through
 * it to the same numbers.
 *
 * Run: cd bench/lcms-comparison && node accuracy_gray.js
 */
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
    instantiate,
    TYPE_GRAY_8,
    TYPE_RGB_8,
    INTENT_RELATIVE_COLORIMETRIC,
} from 'lcms-wasm';

const __d  = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__d, '..', '..');
const require = createRequire(import.meta.url);

const Profile = require(path.join(ROOT, 'src', 'Profile'));
const { Transform, eIntent } = require(path.join(ROOT, 'src', 'main'));

const PROFILE_DIR = path.join(ROOT, '__tests__', 'profiles');
const lcms = await instantiate();

const N = 256;                       // the whole 8-bit input range, every step
const input = new Uint8Array(N);
for(let i = 0; i < N; i++) input[i] = i;

const srgb = lcms.cmsCreate_sRGBProfile();

console.log('');
console.log('==============================================================');
console.log(' ACCURACY — gray, jsColorEngine vs lcms-wasm');
console.log('==============================================================');
console.log(' profiles : ' + path.relative(ROOT, PROFILE_DIR) + ' (written by src/encodeICC.js)');
console.log(' input    : 0..255, every step');
console.log(' workflow : gray -> sRGB, relative colorimetric');
console.log('');
console.log('  profile                          kernel     exact%   <=1LSB%   max   mean');
console.log('  -------------------------------  ---------  ------   -------   ---   -----');

const files = fs.readdirSync(PROFILE_DIR).filter(f => /^synthetic_gray.*\.icc$/.test(f)).sort();
if(!files.length){
    console.error('  no profiles found — run: node scripts/make_test_profiles.js');
    process.exit(1);
}

let worstMax = 0;
for(const file of files){
    const bytes = new Uint8Array(fs.readFileSync(path.join(PROFILE_DIR, file)));

    // ---- lcms -------------------------------------------------------------
    const lcmsGray = lcms.cmsOpenProfileFromMem(bytes, bytes.length);
    if(!lcmsGray){
        console.log('  ' + file.padEnd(33) + 'lcms REFUSED TO OPEN IT');
        worstMax = 999;
        continue;
    }
    const xf = lcms.cmsCreateTransform(lcmsGray, TYPE_GRAY_8, srgb, TYPE_RGB_8,
                                       INTENT_RELATIVE_COLORIMETRIC, 0);
    if(!xf){
        console.log('  ' + file.padEnd(33) + 'lcms COULD NOT BUILD A TRANSFORM');
        worstMax = 999;
        continue;
    }
    const ref = lcms.cmsDoTransform(xf, input, N);

    // ---- jsColorEngine ----------------------------------------------------
    const gray = new Profile();
    gray.loadBinary(bytes);
    const t = new Transform({ dataFormat: 'int8', buildLut: true });
    t.create(gray, '*sRGB', eIntent.relative);
    const got = t.transformArray(input, false, false, false, N);

    // ---- compare ----------------------------------------------------------
    let max = 0, sum = 0, exact = 0, within1 = 0;
    for(let i = 0; i < N * 3; i++){
        const d = Math.abs(ref[i] - got[i]);
        if(d > max) max = d;
        if(d === 0) exact++;
        if(d <= 1) within1++;
        sum += d;
    }
    if(max > worstMax) worstMax = max;

    console.log('  ' + file.padEnd(33)
        + t.kernelInfo().name.padEnd(11)
        + (exact / (N * 3) * 100).toFixed(2).padStart(6)
        + (within1 / (N * 3) * 100).toFixed(2).padStart(10)
        + String(max).padStart(6)
        + (sum / (N * 3)).toFixed(4).padStart(8));
}

console.log('');
if(worstMax > 1){
    console.log('  FAIL — more than 1 LSB from lcms somewhere above.');
    process.exit(1);
}
console.log('  All within 1 LSB of Little CMS, through profiles this engine wrote.');
console.log('');
