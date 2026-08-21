/**
 * bench/lcms-comparison/accuracy_b2a.js
 *
 * PCS -> DEVICE, THE DIRECTION HIGH-CHANNEL PROFILES ARE ACTUALLY BUILT FOR.
 *
 * accuracy_nchannel.js goes the other way: device -> PCS, through an A2B table
 * whose grid is gridPoints^channels. That ceiling is why it stops at ten
 * channels -- a 15-D A2B is only encodable at 2 points per axis, a table with
 * no interior at all.
 *
 * B2A has no such problem. The grid is 3-D whatever the ink count, and only
 * the output stride grows: 17^3 x 15 is 73,695 cells, 145 KB. Which is why
 * real 12- and 15-colour profiles carry B2A and treat A2B as an afterthought.
 *
 * IT ALSO EXERCISES A DIFFERENT SET OF RUNS. 3-channel input with n-channel
 * output is Kernel3D, not KernelND, and specifically its WIDE-OUTPUT runs --
 * fl_3_n and i_3_n. That is the same code path where the u16 wide-output gap
 * was found during the v1.6 kernel work: CMYK -> 5CLR worked at 8 bits and
 * threw at 16, because the int16 modes had no route above 4 output channels.
 * Nothing tested those runs against another CMS until this.
 *
 * WHY sRGB IN RATHER THAN LAB. Feeding Lab directly would put the v2-versus-v4
 * Lab encoding on the interface between the two engines, where a mismatch
 * looks exactly like an interpolation error. sRGB input keeps the PCS internal
 * to each engine and still drives the B2A table it is here to test.
 *
 * Run: cd bench/lcms-comparison && node accuracy_b2a.js
 */
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
    instantiate,
    TYPE_RGB_8,
    COLORSPACE_SH, CHANNELS_SH, BYTES_SH,
    PT_GRAY, PT_RGB, PT_CMYK,
    PT_MCH2, PT_MCH5, PT_MCH6, PT_MCH7, PT_MCH8,
    PT_MCH9, PT_MCH10, PT_MCH11, PT_MCH12, PT_MCH13, PT_MCH14, PT_MCH15,
    INTENT_RELATIVE_COLORIMETRIC,
} from 'lcms-wasm';

const __d  = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__d, '..', '..');
const require = createRequire(import.meta.url);

const Profile = require(path.join(ROOT, 'src', 'Profile'));
const { Transform, eIntent } = require(path.join(ROOT, 'src', 'main'));

const PROFILE_DIR = path.join(ROOT, '__tests__', 'profiles');

// THE STANDARD SPACES ARE NOT MCHn. A 4-channel profile signs as 'CMYK', not
// '4CLR', and lcms refuses to build a transform when the pixel format claims
// PT_MCH4 against it -- the photometric type has to match the profile's colour
// space, not just the channel count. Same for 1 (GRAY) and 3 (RGB).
const PT = { 1: PT_GRAY, 2: PT_MCH2, 3: PT_RGB, 4: PT_CMYK, 5: PT_MCH5,
             6: PT_MCH6, 7: PT_MCH7, 8: PT_MCH8, 9: PT_MCH9, 10: PT_MCH10,
             11: PT_MCH11, 12: PT_MCH12, 13: PT_MCH13, 14: PT_MCH14,
             15: PT_MCH15 };
const formatFor = (n, bytes) => COLORSPACE_SH(PT[n]) | CHANNELS_SH(n) | BYTES_SH(bytes);
const RGB_16 = COLORSPACE_SH(PT_RGB) | CHANNELS_SH(3) | BYTES_SH(2);

const lcms = await instantiate();
const srgb = lcms.cmsCreate_sRGBProfile();

const N = 4096;

console.log('');
console.log('==============================================================');
console.log(' ACCURACY — PCS to device (B2A), jsColorEngine vs lcms-wasm');
console.log('==============================================================');
console.log(' profiles : ' + path.relative(ROOT, PROFILE_DIR) + ' (written by src/encodeICC.js)');
console.log(' workflow : sRGB -> nCLR, relative colorimetric, ' + N + ' random colours');
console.log(' path     : Kernel3D wide-output runs (fl_3_n / i_3_n / i16_3_n)');
console.log('');
console.log(' BOTH DEPTHS. The int16 pass is not decoration: the u16 wide-output');
console.log(' gap found during the v1.6 kernel work lived exactly here -- the int16');
console.log(' modes had no route above 4 output channels, so CMYK -> 5CLR worked at');
console.log(' 8 bits and threw at 16. Nothing compared those runs to another CMS.');
console.log('');
console.log('  profile                        depth  kernel     out   exact%   <=1LSB%   max   mean');
console.log('  -----------------------------  -----  ---------  ---   ------   -------   ---   -----');

const files = fs.readdirSync(PROFILE_DIR).filter(f => /^synthetic_\d+clr_b2a.*\.icc$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

if(!files.length){
    console.error('  no B2A profiles found — run: node scripts/make_test_profiles.js');
    process.exit(1);
}

// Same gate as the A2B oracle, and for the same reason: this catches
// structural faults, not sub-LSB scheme differences. See accuracy_nchannel.js.
const MAX_LSB = 8, MAX_MEAN = 1;
let worst = 0, worstMean = 0, failed = false;

for(const file of files){
    const channels = parseInt(file.match(/synthetic_(\d+)clr/i)[1], 10);
    const bytes = new Uint8Array(fs.readFileSync(path.join(PROFILE_DIR, file)));

    let state = 0xBADF00D;
    const rnd = () => { state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff; return state & 0xff; };
    const input = new Uint8Array(N * 3);
    for(let i = 0; i < input.length; i++) input[i] = rnd();

    const lp = lcms.cmsOpenProfileFromMem(bytes, bytes.length);
    if(!lp){ console.log('  ' + file.padEnd(31) + 'lcms REFUSED TO OPEN IT'); failed = true; continue; }

    const prof = new Profile();
    prof.loadBinary(bytes);

    for(const depth of ['int8', 'int16']){
        const bytesPer = (depth === 'int16') ? 2 : 1;
        const src = (depth === 'int16')
            ? Uint16Array.from(input, v => v * 257)      // 8-bit value, u16 range
            : input;

        const xf = lcms.cmsCreateTransform(srgb, (depth === 'int16') ? RGB_16 : TYPE_RGB_8,
                                           lp, formatFor(channels, bytesPer),
                                           INTENT_RELATIVE_COLORIMETRIC, 0);
        if(!xf){
            console.log('  ' + file.padEnd(31) + depth.padEnd(7) + 'lcms COULD NOT BUILD A TRANSFORM');
            failed = true; continue;
        }
        const ref = lcms.cmsDoTransform(xf, src, N);

        const t = new Transform({ dataFormat: depth, buildLut: true });
        t.create('*sRGB', prof, eIntent.relative);
        const got = t.transformArray(src, false, false, false, N);

        // Compare in the SAME units. u16 outputs are 257x an 8-bit one, so a
        // raw LSB count would look 257x worse for no reason -- scale back.
        const scale = (depth === 'int16') ? 1 / 257 : 1;
        let max = 0, sum = 0, exact = 0, within1 = 0;
        const n = N * channels;
        for(let i = 0; i < n; i++){
            const d = Math.abs(ref[i] - got[i]) * scale;
            if(d > max) max = d;
            if(d === 0) exact++;
            if(d <= 1) within1++;
            sum += d;
        }
        const mean = sum / n;
        if(max > worst) worst = max;
        if(mean > worstMean) worstMean = mean;

        console.log('  ' + file.padEnd(31)
            + depth.padEnd(7)
            + t.kernelInfo().name.padEnd(11)
            + String(channels).padStart(3)
            + (exact / n * 100).toFixed(2).padStart(9)
            + (within1 / n * 100).toFixed(2).padStart(10)
            + max.toFixed(2).padStart(6)
            + mean.toFixed(4).padStart(8));
    }
}

console.log('');
if(failed || worst > MAX_LSB || worstMean > MAX_MEAN){
    console.log('  FAIL — ' + (failed
        ? 'lcms could not use a profile above.'
        : 'max ' + worst + ' LSB / mean ' + worstMean.toFixed(3)
          + ' exceeds the structural gate (' + MAX_LSB + ' / ' + MAX_MEAN + ').'));
    process.exit(1);
}
console.log('  PASS — worst ' + worst + ' LSB, worst mean ' + worstMean.toFixed(3)
    + ', through profiles this engine wrote.');
console.log('');
