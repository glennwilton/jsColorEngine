#!/usr/bin/env node
/**
 * scripts/release_snapshot.js — freeze the measured numbers for a release.
 *
 * WHY. docs/BenchResults.md always describes the newest run, so it tells you
 * what the engine does *now* and nothing about what 1.4 did. The raw JSON that
 * backs it lives in bench/results/, which is gitignored and machine-local: lose
 * the folder and a published figure can never be reproduced or audited again.
 *
 * A snapshot fixes both. Per version, committed:
 *
 *     bench/history/<version>/<machine-id>/
 *         BenchResults.md     the generated page exactly as it read at release
 *         conditions.md       machine, compiler, versions
 *         json/*.json         the measured rows, so any figure can be re-derived
 *         SNAPSHOT.json       what was run, when, on what, and whether tests passed
 *
 * PER MACHINE, because throughput is a property of the box as much as of the
 * code. The same release measured on a Ryzen and on an M2 mini are both true
 * and neither supersedes the other, so they sit side by side. Comparing a
 * version against itself across machines measures hardware; comparing two
 * versions on ONE machine measures the engine.
 *
 * ~120 KB per release. That is a cheap price for being able to answer "was
 * 1.5.5 actually faster than 1.5.0, or did the machine change?" — which is not
 * answerable from prose, and is the question that gets asked.
 *
 * THIS DOES NOT MOVE THE PIN. bench/baseline/ is the reference refactors are
 * gated against and only moves deliberately (see bench/baseline/README.md).
 * A release snapshot is history; the pin is a control.
 *
 * Usage:
 *   node scripts/release_snapshot.js                  # full bench, then snapshot
 *   node scripts/release_snapshot.js --from <run-dir> # reuse a run you already have
 *   node scripts/release_snapshot.js --skip-tests     # snapshot only (not for a real release)
 */
'use strict';

const fs    = require('fs');
const path  = require('path');
const { spawnSync } = require('child_process');
const { machineId, machineDetail } = require('./lib/machine.js');

const ROOT    = path.join(__dirname, '..');
const RESULTS = path.join(ROOT, 'bench', 'results');
const HISTORY = path.join(ROOT, 'bench', 'history');
const DOCS    = path.join(ROOT, 'docs');

const PKG     = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;

const argv = process.argv.slice(2);
const has  = n => argv.includes('--' + n);
function flag(n, fallback){
    const i = argv.indexOf('--' + n);
    return (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : fallback;
}

// Filed per version AND per machine: the same release measured on a Ryzen and
// on an M2 are both true and neither supersedes the other, so they are siblings
// rather than one overwriting the other.
const MACHINE = machineId();
const OUT = path.join(HISTORY, VERSION, MACHINE);

function run(cmd, args, label){
    process.stdout.write('\n  → ' + label + '\n');
    const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if(r.status !== 0) throw new Error(label + ' failed (exit ' + r.status + ')');
}

function newestRun(){
    const stamped = fs.readdirSync(RESULTS)
        .filter(n => /^\d{4}-\d{2}-\d{2}T/.test(n))
        .filter(n => fs.existsSync(path.join(RESULTS, n, 'json')))
        .sort();
    if(!stamped.length) throw new Error('no results folder holds a json/ subfolder');
    return path.join(RESULTS, stamped[stamped.length - 1]);
}

function copyDir(from, to){
    fs.mkdirSync(to, { recursive: true });
    for(const f of fs.readdirSync(from)){
        const src = path.join(from, f);
        if(fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(to, f));
    }
}

// ---- 1. measure ---------------------------------------------------------

console.log('\n=== release snapshot — jsColorEngine ' + VERSION + ' ===');
console.log('    machine: ' + MACHINE);

if(fs.existsSync(OUT) && !has('force')){
    throw new Error('bench/history/' + VERSION + '/' + MACHINE + ' already exists. '
                  + 'Bump the version, or pass --force to overwrite a snapshot you are '
                  + 'deliberately redoing. Snapshots from OTHER machines for this version '
                  + 'are untouched either way.');
}

let runDir = flag('from', null);
if(runDir){
    runDir = path.resolve(runDir);
    console.log('\n  reusing run: ' + path.relative(ROOT, runDir));
} else {
    run('node', ['bench/reproduce.js'], 'full bench (all phases — this takes ~30 min)');
    runDir = newestRun();
}

const quick = (() => {
    try {
        return /QUICK/i.test(fs.readFileSync(path.join(runDir, 'conditions.md'), 'utf8'));
    } catch(e){ return false; }
})();
if(quick && !has('force')){
    throw new Error('that run was measured in --quick mode (reduced coverage). A release '
                  + 'snapshot must be a full run. Re-run without --quick, or --force if you '
                  + 'genuinely mean to record a partial one.');
}

// ---- 2. regenerate the page from that run -------------------------------

run('node', ['scripts/build_bench_results.js', runDir], 'render docs/BenchResults.md');

// ---- 3. tests -----------------------------------------------------------

let testsPassed = null;
if(has('skip-tests')){
    console.log('\n  ! tests skipped — this snapshot records that fact');
} else {
    run('npx', ['jest', '--silent'], 'full test suite');
    testsPassed = true;
}

// ---- 4. freeze ----------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });
copyDir(path.join(runDir, 'json'), path.join(OUT, 'json'));
for(const f of ['conditions.md', 'summary.txt']){
    const src = path.join(runDir, f);
    if(fs.existsSync(src)) fs.copyFileSync(src, path.join(OUT, f));
}
// Native C has no emit.cjs JSON — keep the harness text so a skipped-WSL
// run and a measured one are distinguishable after results/ is gone.
for(const f of fs.readdirSync(runDir)){
    if(/^native-/.test(f) && f.endsWith('.txt')){
        fs.copyFileSync(path.join(runDir, f), path.join(OUT, f));
    }
}
fs.copyFileSync(path.join(DOCS, 'BenchResults.md'), path.join(OUT, 'BenchResults.md'));

let tables = 0, node = null, platform = null;
for(const f of fs.readdirSync(path.join(OUT, 'json'))){
    const doc = JSON.parse(fs.readFileSync(path.join(OUT, 'json', f), 'utf8'));
    tables += doc.tables.length;
    node = node || doc.node;
    platform = platform || doc.platform;
}

fs.writeFileSync(path.join(OUT, 'SNAPSHOT.json'), JSON.stringify({
    version:   VERSION,
    machine:   machineDetail(),
    run:       path.basename(runDir),
    snapshot:  new Date().toISOString().slice(0, 10),
    node:      node,
    platform:  platform,
    tables:    tables,
    tests:     testsPassed === true ? 'full suite passed' : 'SKIPPED',
    note:      'Frozen at release. Never edit — it is the record of what this '
             + 'version measured on this machine. Compare releases with '
             + 'scripts/bench_compare.js <newer> --vs bench/history/<older>.'
}, null, 2) + '\n');

console.log('\n  snapshot written: ' + path.relative(ROOT, OUT).split(path.sep).join('/'));
console.log('  ' + tables + ' tables · node ' + node + ' · ' + platform);
console.log('\n  Commit it with the release. Compare against an earlier version');
console.log('  ON THIS MACHINE — across machines the differences are hardware:');
console.log('    node scripts/bench_compare.js \\');
console.log('      bench/history/' + VERSION + '/' + MACHINE + ' \\');
console.log('      --vs bench/history/<older>/' + MACHINE + '\n');
