/*
 * bench/compile_poc/profile_run.js
 *
 * One-shot V8-profiler harness for the profilable compile.
 *
 *   node bench/compile_poc/profile_run.js
 *   node bench/compile_poc/profile_run.js --pixels 5000000
 *
 * What it does:
 *   1. Wipes any stale isolate-*-v8.log in this dir.
 *   2. Spawns `node --prof bench_profilable.js --prof-mode --pixels N`.
 *   3. Locates the new isolate-*-v8.log.
 *   4. Spawns `node --prof-process` against it.
 *   5. Filters the [JavaScript] / [Bottom up] sections for our stage names
 *      and prints a clean per-stage table.
 *   6. Optionally keeps the raw .log for further inspection (--keep).
 *
 * The numbers it reports are V8 sample ticks (1ms each by default), so
 * they're a real time-of-execution attribution from the JIT'd code — not
 * timer-perturbed. The PERCENT column is what you trust.
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const cp   = require('child_process');

const here = __dirname;
const bench = path.join(here, 'bench_profilable.js');

const argv = process.argv.slice(2);
const argVal = (n, d) => { const i = argv.indexOf(n); return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : d; };
const PIXELS = parseInt(argVal('--pixels', '3000000'), 10);
const KEEP   = argv.includes('--keep');

console.log('---- 1. wiping old isolate logs ----');
for (const f of fs.readdirSync(here)) {
    if (/^isolate-.*-v8\.log$/.test(f)) {
        fs.unlinkSync(path.join(here, f));
        console.log('   removed', f);
    }
}

console.log('---- 2. running profilable bench under node --prof (' + PIXELS + ' px) ----');
const probeRun = cp.spawnSync(process.execPath, [
    '--prof',
    bench,
    '--prof-mode',
    '--pixels', String(PIXELS),
    '--runs',   '5',
], { cwd: here, encoding: 'utf8' });
if (probeRun.status !== 0) {
    console.error('bench_profilable.js exited with status', probeRun.status);
    console.error(probeRun.stderr);
    process.exit(probeRun.status || 1);
}
process.stdout.write(probeRun.stdout.split('\n').filter(l => !l.startsWith('To see')).join('\n') + '\n');

const logFiles = fs.readdirSync(here).filter(f => /^isolate-.*-v8\.log$/.test(f));
if (logFiles.length === 0) { console.error('no isolate log produced'); process.exit(1); }
logFiles.sort((a, b) => fs.statSync(path.join(here, b)).mtimeMs - fs.statSync(path.join(here, a)).mtimeMs);
const log = logFiles[0];

console.log('\n---- 3. processing ' + log + ' ----');
const proc = cp.spawnSync(process.execPath, [
    '--prof-process',
    path.join(here, log),
], { encoding: 'utf8' });
if (proc.status !== 0) { console.error(proc.stderr); process.exit(proc.status || 1); }

// --------------------------------------------------------------------------
// Parse the [JavaScript] section.  Each line is:
//      ticks    total%   nonlib%   name
// We pull every "_sN_<stage>" line for our compiled stages, plus the V8
// builtin row "<anonymous> :1:N" that catches Math.pow / cbrt time.
// We ALSO walk [Bottom up] to attribute the V8-builtin samples back to the
// stage that called them — that's where the real per-stage cost lives,
// because Math.pow/cbrt time is reported under the builtin, not the stage
// that called it.
// --------------------------------------------------------------------------
const out   = proc.stdout;
const lines = out.split('\n');

function captureSection(name) {
    const startIdx = lines.findIndex(l => l.trim() === '[' + name + ']:');
    if (startIdx < 0) return [];
    const rest = lines.slice(startIdx + 1);
    const endIdx = rest.findIndex(l => /^\s*\[/.test(l));
    return endIdx < 0 ? rest : rest.slice(0, endIdx);
}

const jsSection     = captureSection('JavaScript');
const bottomUpLines = captureSection('Bottom up (heavy) profile');

// Self ticks per JS function from [JavaScript]
const selfTicks   = new Map();
const builtinTicks = new Map(); // key = builtin location (e.g. '<anonymous> :1:20')
for (const l of jsSection) {
    let m = l.match(/^\s*(\d+)\s+([\d.]+)%\s+([\d.]+)%\s+JS:\s*[*~^]?(_s\d+_\S+)/);
    if (m) { selfTicks.set(m[4], { ticks: +m[1], pct: +m[2] }); continue; }
    m = l.match(/^\s*(\d+)\s+([\d.]+)%\s+([\d.]+)%\s+JS:\s*[*~^]?(<anonymous>\s+:1:\d+)/);
    if (m) builtinTicks.set(m[4], { ticks: +m[1], pct: +m[2] });
}

// Walk [Bottom up] to find the C++ block (`node.exe`) and read the depth-1
// JS callers underneath it. Each child says "this stage was on the JS
// stack while N C++ samples were taken" — i.e. the stage caused that much
// work in V8 builtins (Math.pow / Math.cbrt / GC / etc.).
//
// prof-process line format (depth is encoded by the gap between the % col
// and the name col):
//      depth-0 (top-level):   "    NNN   PP.P%  C:\\...node.exe"      (2 sp before name)
//      depth-1:               "    NNN   PP.P%    JS: *_sN_stage..."  (4 sp before name)
//      depth-2:               "    NNN   PP.P%      JS: ..."          (6 sp before name)
//      depth-3:               "    NNN   PP.P%        JS: ..."        (8 sp before name)
//
// We sum the depth-1 child counts under node.exe into each stage's
// `inclusive` total. Combined with the [JavaScript] self ticks, that
// gives the real per-stage cost (incl. C++ time spent in builtins).
const inclusive = new Map();
for (const [name, s] of selfTicks) inclusive.set(name, s.ticks);

// depth helper: number of spaces between the "%  " column and the name
function depthOf(line) {
    const m = line.match(/^\s*\d+\s+[\d.]+%(\s+)/);
    if (!m) return -1;
    // 2 spaces -> depth 0, 4 -> depth 1, 6 -> depth 2 ...
    return Math.floor(m[1].length / 2) - 1;
}

let cppBlockStart = -1;
for (let i = 0; i < bottomUpLines.length; i++) {
    if (depthOf(bottomUpLines[i]) === 0 && /node(?:\.exe)?\s*$/i.test(bottomUpLines[i])) {
        cppBlockStart = i;
        break;
    }
}
if (cppBlockStart >= 0) {
    for (let j = cppBlockStart + 1; j < bottomUpLines.length; j++) {
        const next = bottomUpLines[j];
        const d = depthOf(next);
        if (d === 0) break;                               // next top-level block
        if (d !== 1) continue;                            // only depth-1 children of node.exe
        const cm = next.match(/JS:\s*[*~^]?(_s\d+_\S+)\b/);
        const tm = next.match(/^\s*(\d+)\s+/);
        if (cm && tm) {
            const stage = cm[1];
            inclusive.set(stage, (inclusive.get(stage) || 0) + (+tm[1]));
        }
    }
}

// Build per-stage rows in chain order
const allStages = new Set([...selfTicks.keys(), ...inclusive.keys()]);
const stageOrder = [...allStages].sort((a, b) => {
    return (+a.match(/^_s(\d+)_/)[1]) - (+b.match(/^_s(\d+)_/)[1]);
});

const totalTicks = parseInt((out.match(/\((\d+)\s+ticks/) || [, '0'])[1], 10);

console.log('\n===== per-stage V8 profiler attribution =====');
console.log('total samples in run: ' + totalTicks + '   (1 sample ≈ 1ms by default)');
console.log('idx  stage                                      self    self%    +builtin    incl    incl%');
console.log('---  ----------------------------------------  ------   ------   --------   ------   ------');
let totalSelf = 0, totalIncl = 0;
for (const name of stageOrder) {
    const idx = +name.match(/^_s(\d+)_/)[1];
    const tag = name.replace(/^_s\d+_/, '');
    const s   = selfTicks.get(name) || { ticks: 0 };
    const inc = inclusive.get(name) || 0;
    const builtinShare = inc - s.ticks;
    const inclPct = totalTicks ? (100 * inc / totalTicks) : 0;
    const selfPct = totalTicks ? (100 * s.ticks / totalTicks) : 0;
    totalSelf += s.ticks;
    totalIncl += inc;
    console.log(
        String(idx).padStart(3, ' ') + '  ' +
        tag.padEnd(40, ' ').slice(0, 40) + '  ' +
        String(s.ticks).padStart(6, ' ') + '   ' +
        (selfPct.toFixed(2) + '%').padStart(6, ' ') + '   ' +
        String(builtinShare).padStart(8, ' ') + '   ' +
        String(inc).padStart(6, ' ') + '   ' +
        (inclPct.toFixed(2) + '%').padStart(6, ' ')
    );
}
console.log('---  ----------------------------------------  ------   ------   --------   ------   ------');
console.log('     totals across stages                       ' +
    String(totalSelf).padStart(6, ' ') + '            ' +
    '          ' +
    String(totalIncl).padStart(6, ' '));

console.log('\nself ticks    = samples taken with the stage as the topmost JS frame');
console.log('builtin ticks = samples in V8 builtins (Math.pow, Math.cbrt, etc.) charged back to the stage that called them');
console.log('incl ticks    = self + builtin (the real "what this stage costs" number)');

// Surface the top builtin rows for context
console.log('\n===== V8 builtin samples (top-N) =====');
const builtinSorted = [...builtinTicks].sort((a, b) => b[1].ticks - a[1].ticks).slice(0, 5);
for (const [name, v] of builtinSorted) {
    console.log('  ' + String(v.ticks).padStart(5, ' ') + '   ' + (v.pct + '%').padStart(7, ' ') + '   ' + name + '   (Math.pow / Math.cbrt / TF stub)');
}

if (!KEEP) {
    fs.unlinkSync(path.join(here, log));
    console.log('\n(removed ' + log + '; pass --keep to retain it for further analysis with `node --prof-process ...`)');
} else {
    console.log('\nkept ' + log + ' for manual analysis');
}
