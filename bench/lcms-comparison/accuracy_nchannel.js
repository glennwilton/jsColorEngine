/**
 * bench/lcms-comparison/accuracy_nchannel.js
 *
 * THE FIRST ORACLE KERNEL2D AND KERNELND HAVE EVER HAD.
 *
 * accuracy.js covers RGB and CMYK, because those are the profiles this repo
 * can legally ship. 2 channels and 5-15 channels had nothing — no profile to
 * hand Little CMS, so those kernels could only ever be checked against
 * themselves, and a suite that only agrees with itself is how a dropped clamp
 * survived in four interpolators at once.
 *
 * The way out is to WRITE the profiles. A profile the engine wrote carries no
 * licensing question, so it can be committed and both engines pointed at the
 * same file. src/encodeICC.js writes them, scripts/make_test_profiles.js puts
 * them in __tests__/profiles/, and this compares.
 *
 * WHY THE CLUTs ARE SMOOTH, AND WHY THAT WAS NOT THE FIRST ANSWER.
 *
 * They started as noise, on the reasoning in interp_reference.tests.js: a
 * smooth ramp hides index errors, because a wrong grid index lands on a
 * neighbour holding nearly the right answer. That is correct when comparing an
 * implementation to a REFERENCE OF THE SAME SCHEME. It is wrong across
 * ENGINES, because the two schemes are not the same:
 *
 *   Little CMS     tetrahedral in the last 3 axes, LINEAR on every extra one,
 *                  i.e. 2^(N-3) tetrahedral evaluations lerped together
 *                  (Eval4Inputs and the Eval##N##Inputs macro in
 *                  lcms2/src/cmsintrp.c)
 *   jsColorEngine  the same scheme since v1.6. It used to walk one Kuhn
 *                  simplex over all N axes -- O(N) rather than O(2^(N-3)) and
 *                  the nicer algorithm, but slower or less accurate at every
 *                  channel count measured. Kept as simplexInterpND_NCh with
 *                  the numbers, behind the toggle in KernelND.js.
 *
 * Both are exact at grid points and differ inside a cell. On a noise table
 * they cannot converge, because unrelated neighbours mean there is no answer
 * to converge on. Measured, same code, same profiles: max 144 LSB on noise,
 * max 6 on smooth. The 144 was the test, not the engine.
 *
 * WHAT THIS ORACLE IS FOR, THEREFORE. It catches STRUCTURAL faults -- index
 * arithmetic, channel order, stride, Lab encoding, a missing loop -- which
 * show as tens of LSB and a mean in double figures. It cannot certify sub-LSB
 * agreement while the schemes differ. The gate sits an order of magnitude
 * clear of both.
 *
 * It already earned that: the first run found transformArray() returning an
 * array of `undefined` for every input width above 4 channels. Silently. No
 * profile existed to catch it before this one.
 *
 * The residual tracks GRID COARSENESS rather than channel count -- a 9-point
 * grid lands 99% within 1 LSB, a 3-point grid 74% -- which is what a scheme
 * difference does when cells sit furthest apart.
 *
 * Run: cd bench/lcms-comparison && node accuracy_nchannel.js
 */
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
    instantiate,
    TYPE_RGB_8,
    COLORSPACE_SH, CHANNELS_SH, BYTES_SH,
    PT_MCH2, PT_MCH5, PT_MCH6, PT_MCH7, PT_MCH8, PT_MCH9, PT_MCH10,
    INTENT_RELATIVE_COLORIMETRIC,
} from 'lcms-wasm';

const __d  = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__d, '..', '..');
const require = createRequire(import.meta.url);

const Profile = require(path.join(ROOT, 'src', 'Profile'));
const { Transform, eIntent } = require(path.join(ROOT, 'src', 'main'));

const PROFILE_DIR = path.join(ROOT, '__tests__', 'profiles');

// PT_MCHn is the n-colour photometric type. Building the format by hand rather
// than using TYPE_CMYK5_8 and friends, because those only run 5..12 and stop
// short of both ends of what ICC can name.
const PT = { 2: PT_MCH2, 5: PT_MCH5, 6: PT_MCH6, 7: PT_MCH7,
             8: PT_MCH8, 9: PT_MCH9, 10: PT_MCH10 };
const formatFor = n => COLORSPACE_SH(PT[n]) | CHANNELS_SH(n) | BYTES_SH(1);

const lcms = await instantiate();
const srgb = lcms.cmsCreate_sRGBProfile();

const N = 4096;                      // pixels per profile

console.log('');
console.log('==============================================================');
console.log(' ACCURACY — n-channel, jsColorEngine vs lcms-wasm');
console.log('==============================================================');
console.log(' profiles : ' + path.relative(ROOT, PROFILE_DIR) + ' (written by src/encodeICC.js)');
console.log(' workflow : nCLR -> sRGB, relative colorimetric, ' + N + ' random device values');
console.log(' tables   : smooth ink model -- see the header for why not noise');
console.log('');
console.log('  profile                          kernel     grid  exact%   <=1LSB%   max   mean');
console.log('  -------------------------------  ---------  ----  ------   -------   ---   -----');

const files = fs.readdirSync(PROFILE_DIR).filter(f => /^synthetic_\d+clr.*\.icc$/i.test(f))
    .sort((a, b) => parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10));

if(!files.length){
    console.error('  no n-channel profiles found — run: node scripts/make_test_profiles.js');
    process.exit(1);
}

// Structural faults show as tens of LSB and a mean in double figures; the
// scheme difference shows as a handful of LSB and a mean near zero. The gate
// sits in the gap, an order of magnitude clear of both.
const MAX_LSB = 8, MAX_MEAN = 1;
let worst = 0, worstMean = 0, failed = false;
for(const file of files){
    const channels = parseInt(file.match(/synthetic_(\d+)clr/i)[1], 10);
    const bytes = new Uint8Array(fs.readFileSync(path.join(PROFILE_DIR, file)));

    // Same input to both engines. Seeded so a failure is reproducible from the
    // profile name alone.
    let state = 0xC0FFEE;
    const rnd = () => { state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff; return state & 0xff; };
    const input = new Uint8Array(N * channels);
    for(let i = 0; i < input.length; i++) input[i] = rnd();

    // ---- lcms -------------------------------------------------------------
    const lp = lcms.cmsOpenProfileFromMem(bytes, bytes.length);
    if(!lp){ console.log('  ' + file.padEnd(33) + 'lcms REFUSED TO OPEN IT'); failed = true; continue; }
    const xf = lcms.cmsCreateTransform(lp, formatFor(channels), srgb, TYPE_RGB_8,
                                       INTENT_RELATIVE_COLORIMETRIC, 0);
    if(!xf){ console.log('  ' + file.padEnd(33) + 'lcms COULD NOT BUILD A TRANSFORM'); failed = true; continue; }
    const ref = lcms.cmsDoTransform(xf, input, N);

    // ---- jsColorEngine ----------------------------------------------------
    const prof = new Profile();
    prof.loadBinary(bytes);
    const t = new Transform({ dataFormat: 'int8', buildLut: true });
    t.create(prof, '*sRGB', eIntent.relative);
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
    const mean = sum / (N * 3);
    if(max > worst) worst = max;
    if(mean > worstMean) worstMean = mean;

    console.log('  ' + file.padEnd(33)
        + t.kernelInfo().name.padEnd(11)
        + String(prof.A2B[0].gridPoints[0]).padStart(4)
        + (exact / (N * 3) * 100).toFixed(2).padStart(8)
        + (within1 / (N * 3) * 100).toFixed(2).padStart(10)
        + String(max).padStart(6)
        + mean.toFixed(4).padStart(8));
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
console.log('  Residual is the interpolation-scheme difference, not a fault: see the header.');
console.log('');
