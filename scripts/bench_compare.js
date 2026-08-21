#!/usr/bin/env node
/**
 * scripts/bench_compare.js — compare a bench run against the PINNED baseline.
 *
 * WHY A PIN AND NOT "THE PREVIOUS RUN". Gating each change against whatever ran
 * last is a ratchet that only turns one way: seven refactor phases at 1.5% each
 * is 11% slower with every individual step passing its gate. So the reference
 * is a named, committed run in bench/baseline/ that does not move unless
 * someone deliberately moves it, and every comparison is against that.
 *
 * Comparing against the previous run is still useful — it says which step did
 * it — so `--vs <dir>` is there. It is the diagnosis, not the gate.
 *
 * THE lcms COLUMNS ARE THE CONTROL, NOT A TARGET. Every content-matrix row
 * carries lcmsWasm / lcmsWasmNoCache beside the jsCE columns: Little CMS
 * running in WASM, which no jsColorEngine refactor can touch. When those move
 * as far as ours did, the machine moved, not the code. This tool reports that
 * comparison rather than making the reader eyeball it.
 *
 * ACCURACY IS GATED AT ZERO. Throughput has a tolerance; LSB error does not.
 * A refactor that quietly changes rounding is the failure mode worth catching.
 *
 * THREE GATES, MATCHED TO WHAT EACH MEASUREMENT SUPPORTS. The solo bench
 * controls its conditions and reports its own spread under 1%, so its cells
 * gate individually. The content matrix does not: single 1024k cells were
 * observed swinging 5-18% between clean runs on an idle machine while their
 * median held to a fraction of a percent, so the median gates and individual
 * cells are reported for diagnosis only. Gating a noisy instrument per cell
 * produces failures nobody believes, which is how a gate stops being read.
 *
 * Usage:
 *   node scripts/bench_compare.js                     # newest run vs pinned baseline
 *   node scripts/bench_compare.js <run>               # that run vs pinned baseline
 *   node scripts/bench_compare.js <run> --vs <other>  # explicit pair
 *   node scripts/bench_compare.js --tolerance 5       # percent, default 3
 *   node scripts/bench_compare.js --markdown          # emit a block for a PR/CHANGELOG
 *
 * Exit code 1 if the aggregate regresses past tolerance, an isolated
 * measurement regresses, a single cell moves catastrophically, or any accuracy
 * figure moves at all.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { machineId, machineDetail } = require('./lib/machine.js');

const ROOT     = path.join(__dirname, '..');
const RESULTS  = path.join(ROOT, 'bench', 'results');
const BASELINE = path.join(ROOT, 'bench', 'baseline');

// ---- arguments ----------------------------------------------------------

const argv = process.argv.slice(2);
function flag(name, fallback){
    const i = argv.indexOf('--' + name);
    return (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[i + 1] : fallback;
}
const has       = name => argv.includes('--' + name);
const TOLERANCE = Number(flag('tolerance', 3));
const MARKDOWN  = has('markdown');
const positional = argv.filter((a, i) =>
    !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !has(argv[i - 1].slice(2))));

// ---- which columns mean what -------------------------------------------
//
// Gated: jsColorEngine's own throughput. Control: third-party engines measured
// in the same process on the same content — they answer "was it the machine?".
// Everything else (distinct colour counts, cover ratios) is descriptive.

const GATED   = /^(jsce|kernel|peak|sequential|median|mean)?mpxs?$|^(jsce|kernel)/i;
const CONTROL = /^(lcms|native)/i;
const ACCURACY = /(MaxLsb|MeanLsb|Over1Pct|maxLsb|meanLsb)$/;

// TWO MEASUREMENT REGIMES, TWO KINDS OF GATE.
//
// A table that reports its own spread (`spreadPct`) measured itself under
// control — the solo bench runs one image, one engine, one process per cell and
// reports 0.2-1.0%. Those cells are trustworthy individually, so each one gates.
//
// The content matrix does not. Individual 1024k cells were observed moving
// 5-18% between clean runs on an idle machine, while the MEAN across 132 of
// them held to +0.83% and +0.80% on two consecutive clean runs. So for those,
// the aggregate gates and single cells are reported but never fail a build.
// Gating a noisy instrument per-cell produces failures nobody believes, which
// is how a gate stops being read.
const CONTROLLED = t => t.rows.some(r => typeof r.spreadPct === 'number');

// Small batches are dominated by per-call overhead and GC rather than the
// kernel loop, and they measure like it. `js.sweep.rgb-rgb-matrix.64k /
// noise / jsceInt` was measured four times around one code change: 53.9
// (before), then 47.5, 53.9, 56.5 (after) — a 17% spread with the "before"
// value sitting in the middle of the "after" range. A gate that fires on that
// is a gate that gets ignored.
//
// So cells below this size are reported and never gate. The published tables
// use 1M px; 64k and 16k exist to show the shape of the size curve, which is
// still worth seeing and is not worth failing a build over.
const GATE_MIN_PIXELS = 262144;

function tablePixels(t){
    if(t.meta && typeof t.meta.pixels === 'number') return t.meta.pixels;
    const m = /\.(\d+)k$/.exec(t.id);          // js.sweep.rgb-lab.64k
    return m ? Number(m[1]) * 1024 : Infinity; // unsized tables gate normally
}

// ---- loading ------------------------------------------------------------

function newestRun(){
    const stamped = fs.readdirSync(RESULTS)
        .filter(n => /^\d{4}-\d{2}-\d{2}T/.test(n))
        .filter(n => fs.existsSync(path.join(RESULTS, n, 'json')))
        .sort();
    if(!stamped.length) throw new Error('no results folder holds a json/ subfolder — run `node bench/reproduce.js` first');
    return path.join(RESULTS, stamped[stamped.length - 1]);
}

// Baselines are filed per machine. Throughput is a property of the box at
// least as much as of the code, so a Ryzen pin is not a control for an M2 —
// comparing across them reports a wall of "regressions" that are a different
// CPU, which is how a tool teaches people to ignore it.
function pinnedBaseline(){
    const id  = machineId();
    const dir = path.join(BASELINE, id);
    const meta = path.join(dir, 'BASELINE.json');
    if(!fs.existsSync(meta)){
        const others = fs.existsSync(BASELINE)
            ? fs.readdirSync(BASELINE).filter(n => fs.existsSync(path.join(BASELINE, n, 'BASELINE.json')))
            : [];
        const lines = ['no pinned baseline for this machine (' + id + ').', ''];
        if(others.length){
            lines.push('  Pins exist for:');
            for(const o of others) lines.push('      ' + o);
            lines.push('');
            lines.push('  Those are different hardware — comparing against one would report');
            lines.push('  a CPU difference as a regression. Establish a pin for this machine:');
        } else {
            lines.push('  No pins exist yet. Establish one for this machine:');
        }
        lines.push('');
        lines.push('      node bench/reproduce.js');
        lines.push('      node scripts/pin_baseline.js <results-dir> --why "..."');
        lines.push('');
        lines.push('  Or compare two runs directly, which needs no pin:');
        lines.push('      node scripts/bench_compare.js <run> --vs <other>');
        lines.push('');
        throw new Error(lines.join('\n'));
    }
    return { dir, meta: JSON.parse(fs.readFileSync(meta, 'utf8')) };
}

function loadTables(dir){
    const jsonDir = path.join(dir, 'json');
    if(!fs.existsSync(jsonDir)) throw new Error('no json/ in ' + dir);
    const out = {};
    for(const f of fs.readdirSync(jsonDir).filter(f => f.endsWith('.json'))){
        const doc = JSON.parse(fs.readFileSync(path.join(jsonDir, f), 'utf8'));
        for(const t of doc.tables) out[t.id] = Object.assign({ _run: doc }, t);
    }
    return out;
}

// ---- comparison ---------------------------------------------------------

function compare(base, run){
    const cells = [];
    const missing = [];
    for(const id of Object.keys(run)){
        const b = base[id];
        if(!b){ missing.push(id); continue; }
        const small      = tablePixels(run[id]) < GATE_MIN_PIXELS;
        const controlled = CONTROLLED(run[id]);
        const key = run[id].columns[0];
        for(const rowB of run[id].rows){
            const rowA = b.rows.find(r => r[key] === rowB[key]);
            if(!rowA) continue;
            for(const col of run[id].columns){
                const a = rowA[col], n = rowB[col];
                if(typeof a !== 'number' || typeof n !== 'number') continue;
                const kind = ACCURACY.test(col) ? 'accuracy'
                           : GATED.test(col)    ? (controlled ? 'controlled'
                                                 : small      ? 'small' : 'gated')
                           : CONTROL.test(col)  ? 'control'
                           : null;
                if(!kind) continue;
                cells.push({
                    id, row: String(rowB[key]), col, kind, old: a, now: n,
                    delta: a === 0 ? (n === 0 ? 0 : Infinity) : (n - a) / a * 100
                });
            }
        }
    }
    return { cells, missing };
}

const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
const median = xs => {
    if(!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---- run ----------------------------------------------------------------

const runDir  = positional[0] ? path.resolve(positional[0]) : newestRun();
const vsArg   = flag('vs', null);
const basePin = vsArg ? null : pinnedBaseline();
const baseDir = vsArg ? path.resolve(vsArg) : basePin.dir;

const base = loadTables(baseDir);
const run  = loadTables(runDir);

// An explicit --vs can still cross machines. Say so rather than silently
// reporting hardware as a code change.
let crossMachine = null;
if(vsArg){
    const bp = run[Object.keys(run)[0]]._run.platform;
    const ap = base[Object.keys(base)[0]]._run.platform;
    if(ap && bp && ap !== bp) crossMachine = ap + ' vs ' + bp;
}
const { cells, missing } = compare(base, run);

const gated      = cells.filter(c => c.kind === 'gated');
const control    = cells.filter(c => c.kind === 'control');
const accuracy   = cells.filter(c => c.kind === 'accuracy');
const small      = cells.filter(c => c.kind === 'small');
const controlled = cells.filter(c => c.kind === 'controlled');

const gatedMean   = mean(gated.map(c => c.delta));
const controlMean = mean(control.map(c => c.delta));

// A cell is only a finding if it moved beyond tolerance AND the third-party
// control on the same run did not move with it. If lcms swung as far as we
// did, the machine was busy — that is a measurement to repeat, not a
// regression to chase.
//
// P95, NOT MAX. The control distribution on a healthy run is tight with a long
// thin tail: one measured run went median 1.1%, p90 4.1%, p95 4.8% — and then a
// single cell at 20.8%. Taking the max let that one cell raise the floor above
// every plausible regression and silently switch the gate off. The p95 tracks
// the machine's actual restlessness and still rises properly when a run is
// genuinely contaminated, which is the behaviour that was wanted.
function percentile(xs, p){
    if(!xs.length) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    return s[Math.floor((s.length - 1) * p)];
}
const controlAbs    = control.map(c => Math.abs(c.delta));
const controlSpread = percentile(controlAbs, 0.95);
const controlMax    = controlAbs.length ? Math.max(...controlAbs) : 0;
const noiseFloor = Math.max(TOLERANCE, controlSpread);

// THREE GATES, matched to what each measurement can actually support.
//
//   1. Accuracy — zero tolerance, per cell.
//   2. Controlled tables (the solo bench) — per cell at tolerance. These
//      report their own spread and it is under 1%, so a cell that moves 3% is
//      a real event.
//   3. The content matrix — AGGREGATE only. Its median across all gated cells
//      is stable to a fraction of a percent between clean runs while
//      individual cells swing 5-18%, so the median gates and single cells are
//      reported for diagnosis. Median rather than mean: one wild cell should
//      not move the verdict in either direction.
//
// A single catastrophic cell still fails, because a genuinely broken kernel
// looks nothing like jitter. CATASTROPHIC is set well clear of the observed
// per-cell spread.
const CATASTROPHIC = 30;

const accuracyChanged = accuracy.filter(c => c.old !== c.now);
const controlledBad   = controlled.filter(c => c.delta < -TOLERANCE);
const gatedMedian     = median(gated.map(c => c.delta));
const aggregateBad    = gated.length && gatedMedian < -TOLERANCE;
const findings        = gated.filter(c => c.delta < -CATASTROPHIC);
const suspicious      = gated.filter(c => c.delta < -noiseFloor && c.delta >= -CATASTROPHIC);

// ---- report -------------------------------------------------------------

const L = [];
const pct = d => (d >= 0 ? '+' : '') + d.toFixed(2) + '%';

L.push('');
L.push('  baseline : ' + path.relative(ROOT, baseDir).split(path.sep).join('/')
       + (basePin ? '  (pinned: ' + basePin.meta.run + ', jsCE ' + basePin.meta.jsce + ')' : '  (--vs)'));
L.push('  run      : ' + path.relative(ROOT, runDir).split(path.sep).join('/'));
L.push('  machine  : ' + machineId());
if(crossMachine){
    L.push('');
    L.push('  ! CROSS-MACHINE COMPARISON (' + crossMachine + ') — the differences below');
    L.push('    are hardware before they are code. Ratios within one run compare across');
    L.push('    machines; absolute MPx/s does not.');
}
L.push('  tolerance: ' + TOLERANCE + '%   noise floor: ' + noiseFloor.toFixed(1)
       + '%  (control p95 ' + controlSpread.toFixed(1)
       + '%, max ' + controlMax.toFixed(1) + '%)');
L.push('');
L.push('  jsCE throughput   ' + String(gated.length).padStart(4) + ' cells   median '
       + pct(gatedMedian) + ', mean ' + pct(gatedMean) + '   <- GATES (aggregate)');
if(controlled.length){
    L.push('  isolated (solo)   ' + String(controlled.length).padStart(4) + ' cells   worst '
           + pct(Math.min(...controlled.map(c => c.delta))) + '   <- GATES (per cell)');
}
L.push('  third-party ctrl  ' + String(control.length).padStart(4) + ' cells   mean ' + pct(controlMean));
L.push('  accuracy          ' + String(accuracy.length).padStart(4) + ' cells   '
       + (accuracyChanged.length ? accuracyChanged.length + ' CHANGED' : 'identical'));
if(small.length){
    const worst = Math.min(...small.map(c => c.delta));
    L.push('  small batches     ' + String(small.length).padStart(4) + ' cells   mean '
           + pct(mean(small.map(c => c.delta))) + ', worst ' + pct(worst)
           + '  (< ' + (GATE_MIN_PIXELS / 1024) + 'k px — reported, not gated)');
}
if(missing.length){
    L.push('');
    L.push('  ' + missing.length + ' table(s) in the run have no baseline counterpart:');
    for(const id of missing.slice(0, 8)) L.push('      ' + id);
    if(missing.length > 8) L.push('      ... and ' + (missing.length - 8) + ' more');
}

if(accuracyChanged.length){
    L.push('');
    L.push('  ACCURACY MOVED — gated at zero, no tolerance:');
    for(const c of accuracyChanged.slice(0, 20)){
        L.push('      ' + c.id + ' / ' + c.row + ' / ' + c.col + '   ' + c.old + ' -> ' + c.now);
    }
}

if(controlledBad.length){
    L.push('');
    L.push('  ISOLATED MEASUREMENT REGRESSED — these control their conditions:');
    for(const c of controlledBad.sort((a, b) => a.delta - b.delta)){
        L.push('      ' + pct(c.delta).padStart(8) + '  ' + c.id + ' / ' + c.row
               + ' / ' + c.col + '   ' + c.old + ' -> ' + c.now);
    }
}

if(aggregateBad){
    L.push('');
    L.push('  AGGREGATE REGRESSED — median across ' + gated.length + ' cells is '
           + pct(gatedMedian) + ', past the ' + TOLERANCE + '% tolerance.');
}

if(findings.length){
    L.push('');
    L.push('  CATASTROPHIC single cells (past ' + CATASTROPHIC + '% — not jitter):');
    for(const c of findings.sort((a, b) => a.delta - b.delta).slice(0, 20)){
        L.push('      ' + pct(c.delta).padStart(8) + '  ' + c.id + ' / ' + c.row
               + ' / ' + c.col + '   ' + c.old + ' -> ' + c.now);
    }
}

if(suspicious.length){
    const worst = suspicious.slice().sort((a, b) => a.delta - b.delta).slice(0, 5);
    L.push('');
    L.push('  Largest individual moves (diagnosis only — the content matrix gates on');
    L.push('  its median, because single cells here swing 5-18% between clean runs):');
    for(const c of worst){
        L.push('      ' + pct(c.delta).padStart(8) + '  ' + c.id + ' / ' + c.row + ' / ' + c.col);
    }
    if(suspicious.length > worst.length) L.push('      ... and ' + (suspicious.length - worst.length) + ' more');
}

const ok = !findings.length && !accuracyChanged.length
        && !controlledBad.length && !aggregateBad;
L.push('');
L.push(ok ? '  PASS — aggregate within tolerance, isolated measurements steady,'
            + ' accuracy unchanged.'
          : '  FAIL — see above.');
L.push('');

if(MARKDOWN){
    console.log('| measure | cells | mean change |');
    console.log('|---|---:|---:|');
    console.log('| jsCE throughput | ' + gated.length + ' | ' + pct(gatedMean) + ' |');
    console.log('| third-party control | ' + control.length + ' | ' + pct(controlMean) + ' |');
    console.log('| accuracy | ' + accuracy.length + ' | '
        + (accuracyChanged.length ? '**' + accuracyChanged.length + ' changed**' : 'identical') + ' |');
    console.log('');
    console.log('Against pinned baseline `' + (basePin ? basePin.meta.run : path.basename(baseDir))
        + '`, tolerance ' + TOLERANCE + '%. ' + (ok ? 'Pass.' : '**Fail.**'));
} else {
    console.log(L.join('\n'));
}

process.exit(ok ? 0 : 1);
