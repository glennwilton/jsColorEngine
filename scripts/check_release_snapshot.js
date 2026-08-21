#!/usr/bin/env node
/**
 * scripts/check_release_snapshot.js — refuse to publish a version with no
 * frozen measurements behind it.
 *
 * WHY A CHECK AND NOT THE BENCH ITSELF. Running a 30-minute benchmark inside
 * `npm run publish` produces a publish step people learn to bypass, which is
 * worse than not having the gate. So the slow part is its own command
 * (`npm run release-snapshot`) and publish only verifies the result exists and
 * matches the version being shipped.
 *
 * Pass --allow-missing to publish anyway — deliberate, visible, and it says so.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT    = path.join(__dirname, '..');
const PKG     = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
const DIR     = path.join(ROOT, 'bench', 'history', VERSION);

if(process.argv.includes('--allow-missing')){
    console.log('  ! publishing ' + VERSION + ' WITHOUT a benchmark snapshot (--allow-missing).');
    process.exit(0);
}

// ANY machine having measured this version is enough to publish it. Snapshots
// are per machine because throughput is, but the release only needs the figures
// to be re-derivable from somewhere — not from the box that happens to run the
// publish. Two machines is better than one; zero is the thing being caught.
const machines = fs.existsSync(DIR)
    ? fs.readdirSync(DIR).filter(m => fs.existsSync(path.join(DIR, m, 'SNAPSHOT.json')))
    : [];

if(!machines.length){
    console.error('\n  No benchmark snapshot for version ' + VERSION + '.\n');
    console.error('  bench/history/' + VERSION + '/ holds no measured run, so the figures');
    console.error('  this release publishes could not be re-derived or audited later.\n');
    console.error('  Produce one (full bench + full test suite, ~35 min):\n');
    console.error('      npm run release-snapshot\n');
    console.error('  Or, if you already have a full run:\n');
    console.error('      node scripts/release_snapshot.js --from bench/results/<run>\n');
    console.error('  To publish without one anyway:\n');
    console.error('      node scripts/check_release_snapshot.js --allow-missing && npm run build\n');
    process.exit(1);
}

let failed = false;
for(const m of machines){
    const snap = JSON.parse(fs.readFileSync(path.join(DIR, m, 'SNAPSHOT.json'), 'utf8'));
    console.log('  snapshot ' + VERSION + ' @ ' + m + ' — ' + snap.tables + ' tables from '
                + snap.run + ' (' + snap.snapshot + '), tests: ' + snap.tests);
    if(snap.tests !== 'full suite passed'){
        console.error('    ^ records tests as "' + snap.tests + '"');
        failed = true;
    }
}

if(failed){
    console.error('\n  A snapshot with skipped tests is a record that nothing was verified.');
    console.error('  Re-run `npm run release-snapshot` without --skip-tests before publishing.\n');
    process.exit(1);
}
