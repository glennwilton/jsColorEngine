#!/usr/bin/env node
/**
 * scripts/pin_baseline.js — establish or move this machine's pinned baseline.
 *
 * The pin is the fixed reference `scripts/bench_compare.js` gates against. It
 * exists so a sequence of individually-passing changes cannot ratchet the
 * numbers downward: comparing each step against the previous one hides
 * accumulated drift, comparing every step against a fixed point does not.
 *
 * PER MACHINE. Throughput is a property of the box as much as the code, so a
 * pin is only a control for the machine that produced it. Pulling the repo onto
 * a different machine means establishing that machine's own pin — the existing
 * ones stay untouched and keep gating their own hardware.
 *
 * MOVING A PIN IS A DECISION, NOT A FIX. `--why` is required because the reason
 * is the useful part six months later. Legitimate reasons: new machine, new
 * Node major, a shipped optimisation that is meant to change the numbers.
 * Making a failing comparison pass is not one — if a phase regressed, the
 * answer is the phase.
 *
 * Usage:
 *   node scripts/pin_baseline.js <results-dir> --why "new baseline after X"
 *   node scripts/pin_baseline.js <results-dir> --why "..." --force   # replace an existing pin
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { machineId, machineDetail } = require('./lib/machine.js');

const ROOT     = path.join(__dirname, '..');
const BASELINE = path.join(ROOT, 'bench', 'baseline');

const argv = process.argv.slice(2);
const has  = n => argv.includes('--' + n);
function flag(n, fallback){
    const i = argv.indexOf('--' + n);
    return (i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--'))
        ? argv[i + 1] : fallback;
}

const runArg = argv.find(a => !a.startsWith('--') && a !== flag('why', null));
const WHY    = flag('why', null);

if(!runArg){
    console.error('usage: node scripts/pin_baseline.js <results-dir> --why "reason"');
    process.exit(1);
}
if(!WHY){
    console.error('\n  --why is required.\n');
    console.error('  A pin that moved for an unrecorded reason is indistinguishable from');
    console.error('  a pin that moved to make a failure go away. Say which it was.\n');
    process.exit(1);
}

const runDir = path.resolve(runArg);
const jsonDir = path.join(runDir, 'json');
if(!fs.existsSync(jsonDir)){
    console.error('  no json/ in ' + runDir);
    process.exit(1);
}

// A partial run is not a control.
try {
    if(/QUICK/i.test(fs.readFileSync(path.join(runDir, 'conditions.md'), 'utf8')) && !has('force')){
        console.error('\n  That run was measured in --quick mode (reduced sizes and repeats).');
        console.error('  A pin must be a full run, or every later comparison inherits its gaps.');
        console.error('  Re-run `node bench/reproduce.js` without --quick.\n');
        process.exit(1);
    }
} catch(e){ /* older runs have no conditions.md */ }

const id  = machineId();
const dir = path.join(BASELINE, id);

if(fs.existsSync(path.join(dir, 'BASELINE.json')) && !has('force')){
    const existing = JSON.parse(fs.readFileSync(path.join(dir, 'BASELINE.json'), 'utf8'));
    console.error('\n  This machine already has a pin: ' + existing.run
                + ' (pinned ' + existing.pinned + ', jsCE ' + existing.jsce + ')');
    console.error('  why: ' + existing.why);
    console.error('\n  Moving it discards the fixed point every comparison since has used.');
    console.error('  Pass --force if that is what you mean.\n');
    process.exit(1);
}

fs.mkdirSync(path.join(dir, 'json'), { recursive: true });
for(const f of fs.readdirSync(jsonDir)) fs.copyFileSync(path.join(jsonDir, f), path.join(dir, 'json', f));
for(const f of ['conditions.md', 'summary.txt']){
    const src = path.join(runDir, f);
    if(fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
}

let tables = 0, jsce = null, node = null, platform = null, measured = null;
for(const f of fs.readdirSync(path.join(dir, 'json'))){
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'json', f), 'utf8'));
    tables += doc.tables.length;
    jsce = jsce || (doc.meta && doc.meta.jsce);
    node = node || doc.node;
    platform = platform || doc.platform;
    measured = measured || String(doc.generated).slice(0, 10);
}

fs.writeFileSync(path.join(dir, 'BASELINE.json'), JSON.stringify({
    run:      path.basename(runDir),
    pinned:   new Date().toISOString().slice(0, 10),
    jsce:     jsce,
    node:     node,
    platform: platform,
    measured: measured,
    tables:   tables,
    machine:  machineDetail(),
    why:      WHY,
    repin:    'Only on a deliberate, reviewed re-measurement — a new machine, a new '
            + 'Node major, or a shipped optimisation. Never to make a failing comparison pass.'
}, null, 2) + '\n');

console.log('\n  pinned ' + path.basename(runDir) + ' for ' + id);
console.log('  ' + tables + ' tables · jsCE ' + jsce + ' · node ' + node);
console.log('  why: ' + WHY);
console.log('\n  Commit bench/baseline/' + id + '/ — it is a control, and a control that');
console.log('  only exists on one disk is not one.\n');
