#!/usr/bin/env node
/**
 * scripts/build_bench_results.js — render docs/BenchResults.md (or a
 * named sibling) from measured JSON.
 *
 * WHY. Throughput figures used to be transcribed by hand into whichever page
 * needed them, so the same number could exist in three vintages at once and
 * nothing said which was current. The benches now emit structured rows
 * (`bench/lib/emit.cjs`); this renders them into one page that owns the
 * numbers, and every other page links to a table instead of restating it.
 *
 * STALENESS IS PART OF THE OUTPUT. Every table carries the jsColorEngine
 * version and the date it was measured. When the package version has moved on
 * since a table was produced, the table says so rather than looking current.
 *
 * NEVER HAND-EDIT the output. Re-run this instead — an edit here is lost on the
 * next bench run, which is the point.
 *
 * Usage:
 *   node scripts/build_bench_results.js                 # newest results folder
 *   node scripts/build_bench_results.js <results-dir>
 *   node scripts/build_bench_results.js "bobs pc"       # newest folder → BenchResults-bobs-pc.md
 *   node scripts/build_bench_results.js <results-dir> "bobs pc"
 *
 * A host name writes docs/BenchResults-<slug>.md and leaves the default
 * BenchResults.md alone.
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT    = path.join(__dirname, '..');
const RESULTS = path.join(ROOT, 'bench', 'results');
const DOCS    = path.join(ROOT, 'docs');

const PKG_VERSION = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// ---- pick a results folder ---------------------------------------------

function newestRun() {
    const stamped = fs.readdirSync(RESULTS)
        .filter(n => /^\d{4}-\d{2}-\d{2}T/.test(n))
        .filter(n => fs.existsSync(path.join(RESULTS, n, 'json')))
        .sort();
    if (!stamped.length) {
        throw new Error('no results folder holds a json/ subfolder — run ' +
                        '`node bench/reproduce.js` first');
    }
    return path.join(RESULTS, stamped[stamped.length - 1]);
}

function isResultsDir(arg) {
    const resolved = path.resolve(arg);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) return resolved;
    const under = path.join(RESULTS, arg);
    if (fs.existsSync(under) && fs.statSync(under).isDirectory()) return under;
    return null;
}

function parseArgs() {
    var runDir = null;
    var hostName = null;
    process.argv.slice(2).forEach(function(arg) {
        if (arg.charAt(0) === '-') return;
        var dir = isResultsDir(arg);
        if (dir && !runDir) runDir = dir;
        else if (!hostName) hostName = arg;
    });
    return { runDir: runDir || newestRun(), hostName: hostName };
}

function hostSlug(name) {
    var s = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return s || 'named';
}

const ARGS    = parseArgs();
const RUN_DIR = ARGS.runDir;
const OUT     = path.join(DOCS, ARGS.hostName
    ? 'BenchResults-' + hostSlug(ARGS.hostName) + '.md'
    : 'BenchResults.md');

// ---- load ---------------------------------------------------------------

const jsonDir = path.join(RUN_DIR, 'json');
const emitted = fs.readdirSync(jsonDir).filter(f => f.endsWith('.json')).sort()
    .map(f => JSON.parse(fs.readFileSync(path.join(jsonDir, f), 'utf8')));

const tables = [];
for (const d of emitted) for (const t of d.tables) tables.push(Object.assign({ _run: d }, t));
if (!tables.length) throw new Error('no tables in ' + jsonDir);

// ---- rendering ----------------------------------------------------------

const slug = id => 'table-' + id.toLowerCase().replace(/[^a-z0-9]+/g, '-');

function humanColumn(c) {
    const named = {
        mpxs: 'MPx/s', peakMpxs: 'Peak MPx/s', sequentialMpxs: 'Sequential MPx/s',
        efficiencyPct: 'Efficiency', jsceSimd: 'jsCE SIMD', jsceInt: 'jsCE int',
        lcmsWasm: 'lcms-wasm', lcmsWasmNoCache: 'lcms-wasm NOCACHE',
        simdOverClut: 'SIMD / CLUT', simdOverScalar: 'SIMD / scalar',
        simdOverJs: 'SIMD / plain JS', jsOverPipeline: 'JS / pipeline',
        ratioVsLcms: 'jsCE SIMD / lcms-wasm', coverX: 'cover', adjPct: 'adj %',
    };
    if (named[c]) return named[c];
    return c.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, m => m.toUpperCase());
}

function cell(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'boolean') return v ? 'yes' : '**NO**';
    return String(v);
}

function renderTable(t) {
    const cols = t.columns;
    const numeric = c => t.rows.every(r => r[c] === null || typeof r[c] === 'number');
    const version = (t._run.meta && t._run.meta.jsce) || t._run.jsce || null;
    const stale   = version && version !== PKG_VERSION;

    const out = [];
    out.push('### ' + t.title);
    out.push('');
    out.push('`' + t.id + '`' + (t.units ? ' · ' + t.units : '') +
             ' · measured by `' + t._run.tool + '`' +
             (version ? ' · jsCE **' + version + '**' : '') +
             ' · ' + String(t._run.generated).slice(0, 10));
    if (stale) {
        out.push('');
        out.push('> **Stale.** Measured on ' + version + '; the package is now ' +
                 PKG_VERSION + '. Re-run the bench before quoting these.');
    }
    out.push('');
    const meta = Object.entries(t.meta || {})
        .map(([k, v]) => '**' + k + '** ' + (Array.isArray(v) ? v.join(' → ') : v));
    if (meta.length) { out.push(meta.join(' · ')); out.push(''); }
    out.push('| ' + cols.map(humanColumn).join(' | ') + ' |');
    out.push('|' + cols.map(c => (numeric(c) ? '---:' : '---')).join('|') + '|');
    for (const r of t.rows) out.push('| ' + cols.map(c => cell(r[c])).join(' | ') + ' |');
    out.push('');
    return out.join('\n');
}

// ---- who cites what -----------------------------------------------------
//
// A page cites a table by linking to its anchor. Scanning for the link rather
// than for the number is what makes a re-measurement finite: regenerate this
// page, then walk the index for the places that also state a figure in prose.

function markdownFiles(dir, acc = []) {
    for (const name of fs.readdirSync(dir)) {
        if (name === 'node_modules' || name === '_archive' || name.startsWith('.')) continue;
        const p = path.join(dir, name);
        if (fs.statSync(p).isDirectory()) markdownFiles(p, acc);
        else if (name.endsWith('.md') && p !== OUT) acc.push(p);
    }
    return acc;
}

function citations() {
    const byAnchor = {};
    for (const file of markdownFiles(ROOT)) {
        const text = fs.readFileSync(file, 'utf8');
        const re = /BenchResults\.md#([a-z0-9-]+)/g;
        let m;
        while ((m = re.exec(text))) {
            (byAnchor[m[1]] = byAnchor[m[1]] || new Set())
                .add(path.relative(ROOT, file).split(path.sep).join('/'));
        }
    }
    return byAnchor;
}

// ---- assemble -----------------------------------------------------------

let conditions = '';
try {
    // Keep the table and the note under it; drop the file's own heading and its
    // "paste this into LcmsComparison" instruction, which wraps onto a second
    // line and reads as a stray sentence once the first line is gone.
    const lines = fs.readFileSync(path.join(RUN_DIR, 'conditions.md'), 'utf8').split('\n');
    const start = lines.findIndex(l => l.startsWith('| | |'));
    conditions = (start === -1 ? lines : lines.slice(start)).join('\n').trim();
    if (ARGS.hostName && conditions.indexOf('| | |') !== -1) {
        conditions = conditions.replace(
            /\|---\|---\|\r?\n/,
            '|---|---|\n| Machine | ' + ARGS.hostName + ' |\n'
        );
    }
} catch { /* an older run without a conditions file */ }

const cites   = citations();
const runName = path.basename(RUN_DIR);
const dates   = [...new Set(tables.map(t => String(t._run.generated).slice(0, 10)))].sort();
const versions = [...new Set(tables
    .map(t => (t._run.meta && t._run.meta.jsce) || null).filter(Boolean))];

const page = [];
page.push('# Benchmark results — ' + (ARGS.hostName || 'generated'));
page.push('');
page.push('**jsColorEngine docs:**');
page.push('[← Project README](../README.md) ·');
page.push('[Performance](./deepdive/Performance.md) ·');
page.push('[LittleCMS comparison](./LcmsComparison.md) ·');
page.push('[Parallel pool](./pool.md) ·');
page.push('[Bench](./Bench.md)');
if (ARGS.hostName) {
    page.push('');
    page.push('Named run — the default tables stay in [BenchResults.md](./BenchResults.md).');
}
page.push('');
page.push('---');
page.push('');
page.push('> **Generated file — do not edit.** Every table was written by the bench');
page.push('> that measured it (`bench/lib/emit.cjs`) and rendered by');
page.push('> `scripts/build_bench_results.js`. To refresh:');
page.push('>');
page.push('>     node bench/reproduce.js');
page.push('>     node scripts/build_bench_results.js');
page.push('>');
page.push('> Run `' + runName + '`' +
          (ARGS.hostName ? ' · **' + ARGS.hostName + '**' : '') +
          ' · measured ' + dates.join(', ') +
          (versions.length ? ' · jsCE ' + versions.join(', ') : '') +
          ' · package now **' + PKG_VERSION + '**');
page.push('');
page.push('Other pages should **link to a table here** rather than restating its');
page.push('numbers: prose keeps the finding, this page owns the figures. The');
page.push('[citation index](#citation-index) lists what points where, so a');
page.push('re-measurement is a finite job rather than a search.');
page.push('');
if (conditions) {
    page.push('## Conditions');
    page.push('');
    page.push(conditions);
    page.push('');
}

page.push('## Contents');
page.push('');
for (const t of tables) page.push('- [' + t.title + '](#' + slug(t.id) + ') — `' + t.id + '`');
page.push('');

for (const t of tables) {
    page.push('<a id="' + slug(t.id) + '"></a>');
    page.push('');
    page.push(renderTable(t));
}

page.push('## Citation index');
page.push('');
page.push('Which documents link to which table. A table with no citations is either');
page.push('new or quoted only in prose — both worth knowing before a re-measurement.');
page.push('');
page.push('| Table | Cited by |');
page.push('|---|---|');
for (const t of tables) {
    const who = cites[slug(t.id)];
    page.push('| [`' + t.id + '`](#' + slug(t.id) + ') | ' +
        (who ? [...who].sort().map(f => '`' + f + '`').join(', ') : '*not cited yet*') + ' |');
}
page.push('');

fs.writeFileSync(OUT, page.join('\n'));
process.stdout.write('wrote ' + path.relative(ROOT, OUT) + ' — ' + tables.length +
    ' tables from ' + runName +
    (ARGS.hostName ? ' (' + ARGS.hostName + ')' : '') + '\n');
