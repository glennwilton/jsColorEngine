#!/usr/bin/env node
/* ============================================================================
 *  make_test_profiles.js — write the synthetic ICC profiles the oracle needs
 * ----------------------------------------------------------------------------
 *  Released under the MIT License
 *  Copyright (c) 2026 Glenn Wilton, O2 Creative Limited.
 *
 *  WHY THESE ARE GENERATED AND COMMITTED.
 *
 *  Real ICC profiles are licensed, which is why this repo ships exactly two and
 *  no more. That left every kernel except 3-D and 4-D without an oracle: there
 *  was nothing to hand Little CMS for 1, 2, or 5-15 channels, so those paths
 *  could only ever be checked against themselves — and a suite that only
 *  agrees with itself is how the 8-bit clamp bug survived in four
 *  interpolators.
 *
 *  A profile the engine WRITES has no licensing question. It is ours. So these
 *  go in git, and both engines get pointed at the same file.
 *
 *  GENERATED ONCE, NOT PER RUN. They are deterministic, so regenerating gives
 *  byte-identical output — but writing them to disk means they can be opened
 *  in an ICC viewer and looked at, which is worth more than saving a few
 *  milliseconds. Re-run this only when the writer changes.
 *
 *  Usage:
 *    node scripts/make_test_profiles.js
 *    node scripts/make_test_profiles.js --check    (verify, write nothing)
 * ============================================================================
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const Profile = require('../src/Profile');

const OUT_DIR = path.join(__dirname, '..', '__tests__', 'profiles');
const CHECK   = process.argv.includes('--check');

/**
 * Every profile this script knows how to make.
 *
 * Gray only so far — the writer cannot encode an A2B/B2A LUT yet, which is
 * what 2CLR through 15CLR need. When it can, the nCLR entries go here and
 * nothing else about this script changes.
 */
const PROFILES = [
    { file: 'synthetic_gray_g10.icc',
      make: () => Profile.createGrayICC({ gamma: 1.0, description: 'jsColorEngine synthetic Gray g1.0 - test profile, not for production' }),
      note: 'linear — the degenerate case, and the one where an off-by-one in the curve is invisible' },

    { file: 'synthetic_gray_g18.icc',
      make: () => Profile.createGrayICC({ gamma: 1.8, description: 'jsColorEngine synthetic Gray g1.8 - test profile, not for production' }),
      note: 'the classic Mac gamma' },

    { file: 'synthetic_gray_g22.icc',
      make: () => Profile.createGrayICC({ gamma: 2.2, description: 'jsColorEngine synthetic Gray g2.2 - test profile, not for production' }),
      note: 'the common one' },

    { file: 'synthetic_gray_sampled.icc',
      make: () => {
          // A SAMPLED curve, not a gamma. Different code path in both the
          // writer and every reader: count > 1 means 256 uint16 entries rather
          // than one u8Fixed8, and a reader that conflates them produces a
          // profile that opens and converts wrongly.
          const samples = [];
          for(let i = 0; i < 256; i++){
              samples.push(Math.round(Math.pow(i / 255, 1.8) * 65535));
          }
          return Profile.createGrayICC({ samples,
              description: 'jsColorEngine synthetic Gray sampled 1.8 - test profile, not for production' });
      },
      note: '256-entry sampled TRC — exercises the count>1 path, not the gamma one' },
];

// The n-channel device profiles: 2CLR (duotone) and 5..10.
//
// 2 and 5-15 are the channel counts this repo has never had a profile for, so
// Kernel2D and KernelND have never been compared against another CMS. These
// are device -> PCS (A2B), which is the direction that costs grid^channels and
// therefore stops at 10 — see Profile.gridFor(). PCS -> device (B2A) is a 3-D
// grid with a long output stride and goes to 15; that needs B2A encoding,
// which is the next piece.
// THE MATRIX, IN FIFTEEN FILES.
//
// Each of these carries BOTH tables -- A2B (device -> PCS) and B2A (PCS ->
// device) -- which is what a real device profile is, and which collapses the
// test matrix: running profile A's A2B into profile B's B2A gives every input
// width paired with every output width. 15 files, 225 combinations, rather
// than 225 files.
//
// The A2B grid falls as the channel count rises because the table is
// grid^channels; at 11 and up it is 2 points per axis, a table with no
// interior. That is not a useful profile and is not pretending to be one --
// it exists so the wide INPUT path can be exercised end to end. Accuracy at
// those widths is measured through B2A, whose grid is 3-D and stays 17^3
// however many inks there are.
for(let channels = 1; channels <= 15; channels++){
    const grid = Profile.gridFor(channels);
    PROFILES.push({
        file: 'synthetic_' + String(channels).padStart(2, '0') + 'ch.icc',
        make: () => Profile.createNChannelICC({ channels }),
        note: channels + '-channel: A2B ' + grid + '^' + channels + ' -> Lab, B2A Lab -> 17^3'
            + (grid === 2 ? ' (A2B has no interior at this width — coverage, not accuracy)' : ''),
    });
}

// ---------------------------------------------------------------------------

if(!CHECK) fs.mkdirSync(OUT_DIR, { recursive: true });

let changed = 0, same = 0, missing = 0;

console.log('');
console.log('  ' + (CHECK ? 'checking' : 'writing') + '  ' + OUT_DIR);
console.log('');

for(const spec of PROFILES){
    const target = path.join(OUT_DIR, spec.file);
    const bytes  = Buffer.from(spec.make());

    const exists = fs.existsSync(target);
    const identical = exists && Buffer.compare(fs.readFileSync(target), bytes) === 0;

    let status;
    if(identical){ status = 'unchanged'; same++; }
    else if(!exists){ status = CHECK ? 'MISSING' : 'created'; missing++; }
    else { status = CHECK ? 'DIFFERS' : 'updated'; changed++; }

    if(!CHECK && !identical) fs.writeFileSync(target, bytes);

    console.log('    ' + spec.file.padEnd(30)
        + String(bytes.length).padStart(6) + ' bytes   ' + status);
    console.log('      ' + spec.note);
}

console.log('');
if(CHECK && (changed || missing)){
    console.log('  ' + (changed + missing) + ' profile(s) differ from what the writer produces.');
    console.log('  Run without --check to regenerate, and look at the diff before committing:');
    console.log('  a change here means the WRITER changed, which is worth understanding.');
    console.log('');
    process.exit(1);
}
console.log('  ' + same + ' unchanged, ' + changed + ' updated, ' + missing + ' created');
console.log('');
console.log('  These are ordinary ICC files — open them in any profile inspector.');
console.log('');
