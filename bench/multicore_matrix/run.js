/*************************************************************************
 *  @license
 *
 *  Copyright © 2019, 2026 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 */

/**
 * multicore_matrix — does the worker pool actually pay, and where?
 *
 * Three axes, because each one has been wrong before:
 *
 *   CONTENT   solid / noise / photo. A LUT transform is NOT fixed-cost per
 *             pixel — content moves single-threaded throughput by up to 2.7x,
 *             because how much of the CLUT the pixels touch decides cache
 *             behaviour. Solid is one cache line; noise is the whole table;
 *             photos sit in between and slide. If parallel speedup were
 *             measured on one content type it would be a claim about that
 *             content, not about the pool.
 *
 *   WORKERS   1..N, INCLUDING ODD COUNTS. lcms divides a buffer evenly across
 *             threads, so an odd count leaves a ragged tail. We fragment into
 *             ~10 tasks per worker and pull from a queue, so nothing should
 *             care whether the count divides the image. Odd counts are here to
 *             test that claim rather than assume it.
 *
 *   KERNEL    int (JS) / int-wasm-scalar / int-wasm-simd. A faster kernel
 *             makes each fragment cheaper, which raises the relative cost of
 *             the per-task overhead — so the kernel that wins single-threaded
 *             is not automatically the one that scales best.
 *
 * The baseline is the SAME Transform running sequentially through
 * transformArray(), not the 1-worker pool. One worker still pays copy and
 * message costs, so calling it "1x" would flatter every other column.
 *
 * Output is checked against the sequential result on every cell. A speedup
 * that does not produce identical bytes is not a speedup.
 *
 * USAGE
 *   node bench/multicore_matrix/run.js
 *   node bench/multicore_matrix/run.js --px=8000000 --runs=7
 *   node bench/multicore_matrix/run.js --isolate          # process per cell
 *   node bench/multicore_matrix/run.js --content=noise --kernel=int-wasm-simd
 *
 * --isolate runs every cell in a fresh process. Slower, and the honest option:
 * a shared harness process has been measured to move results by 27% (see
 * "Schrodinger's Bench" in docs/deepdive/benchmark.md), because one cell's JIT
 * state and heap follow the next one in.
 */
'use strict';

const path  = require('path');
const emit = require('../lib/emit.cjs');   // no-op unless JSCE_BENCH_JSON is set
const fs    = require('fs');
const { execFileSync } = require('child_process');

const { Transform, Profile, eIntent } = require('../../src/main.js');
const pool = require('../../src/pool.js');

const CORPUS_DIR = path.join(__dirname, '..', 'release_matrix', 'corpus');
const CMYK_ICC   = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

// ---- args ---------------------------------------------------------------
const argv = process.argv.slice(2);
const arg  = (name, dflt) => {
    const hit = argv.find(a => a.startsWith('--' + name + '='));
    return hit ? hit.slice(name.length + 3) : dflt;
};
const has = (name) => argv.includes('--' + name);

const PX        = parseInt(arg('px', '4000000'), 10);
const RUNS      = parseInt(arg('runs', '5'), 10);
const MAX_WORKERS = parseInt(arg('workers', '8'), 10);
const ISOLATE   = has('isolate');
const ONLY_CONTENT = arg('content', null);
const ONLY_KERNEL  = arg('kernel', null);
const CELL      = arg('cell', null);          // internal, used by --isolate

const CONTENTS = ['solid', 'noise', 'photo'];
const KERNELS  = ['int', 'int-wasm-scalar', 'int-wasm-simd'];

// ---- content ------------------------------------------------------------
// Byte-identical to bench/release_matrix/run.js. That harness exports nothing,
// so these are replicated rather than imported — if either changes, both must.
// The PRNG takes bits 23-30, NOT the low byte: an LCG's low bits have a period
// of 256, which produced only 105-256 distinct colours and made "noise" a
// solid-colour test in disguise.
function genNoise(buf) {
    let seed = 0x13579bdf;
    for (let i = 0; i < buf.length; i++) {
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        buf[i] = (seed >>> 23) & 0xff;
    }
}

function genSolid(buf, npx, channels) {
    let seed = 0x13579bdf;
    const px = new Uint8Array(4);
    for (let c = 0; c < channels; c++) {
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        px[c] = (seed >>> 23) & 0xff;
    }
    for (let p = 0; p < npx; p++) for (let c = 0; c < channels; c++) buf[p * channels + c] = px[c];
}

let photoPlane = null;
function loadPhotoPlane() {
    if (photoPlane !== null) return photoPlane;
    try {
        const files = fs.readdirSync(CORPUS_DIR).filter(f => f.endsWith('.rgb.bin')).sort();
        if (!files.length) { photoPlane = false; return photoPlane; }
        photoPlane = Buffer.concat(files.map(f => fs.readFileSync(path.join(CORPUS_DIR, f))));
    } catch { photoPlane = false; }
    return photoPlane;
}

function genPhoto(buf, npx, channels) {
    const src = loadPhotoPlane();
    if (!src) throw new Error(
        'no photo corpus — run: node bench/release_matrix/make_corpus.cjs');
    const have = (src.length / channels) | 0;
    for (let p = 0; p < npx; p++) {
        const s = (p % have) * channels;
        for (let c = 0; c < channels; c++) buf[p * channels + c] = src[s + c];
    }
}

function makeImage(kind, npx, channels) {
    const buf = new Uint8ClampedArray(npx * channels);
    if (kind === 'solid') genSolid(buf, npx, channels);
    else if (kind === 'noise') genNoise(buf);
    else if (kind === 'photo') genPhoto(buf, npx, channels);
    else throw new Error('unknown content ' + kind);
    return { data: buf, pixelCount: npx };
}

// ---- timing -------------------------------------------------------------
const now = () => Number(process.hrtime.bigint()) / 1e6;
const median = (xs) => {
    const s = xs.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function buildTransform(kernel) {
    const cmyk = new Profile();
    cmyk.loadFile(CMYK_ICC);
    const t = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: kernel });
    t.create('*sRGB', cmyk, eIntent.relative);
    return t;
}

/** Sequential baseline: the same Transform, no workers, no copies. */
function benchSequential(t, img, outBuf) {
    // Warm the JIT and the kernel before anything is timed.
    for (let i = 0; i < 2; i++)
        t.transformArray(img.data, false, false, false, img.pixelCount, undefined, outBuf);

    const times = [];
    for (let i = 0; i < RUNS; i++) {
        const t0 = now();
        t.transformArray(img.data, false, false, false, img.pixelCount, undefined, outBuf);
        times.push(now() - t0);
    }
    return median(times);
}

async function benchWorkers(t, img, workers) {
    // Pin the pool to exactly this many workers. minThreads must drop to 1 or
    // acquire() refuses a single-worker pool and silently runs sequentially,
    // which would show up as a suspiciously good "1 worker" number.
    const opts = { multicore: { cores: workers, minThreads: 1, maxThreads: workers } };

    // Warm: JIT, worker spawn, and shipping the LUT to every worker. Without
    // this the first timed run pays for registration and the column reads low.
    await t.transformImages([img], opts);
    await t.transformImages([img], opts);

    const times = [];
    let out = null;
    for (let i = 0; i < RUNS; i++) {
        const t0 = now();
        const res = await t.transformImages([img], opts);
        times.push(now() - t0);
        out = res;
    }
    return { ms: median(times), workersUsed: out.workersUsed, images: out.images };
}

function differingBytes(a, b) {
    if (a.length !== b.length) return Infinity;
    let n = 0;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
    return n;
}

/** Output channels for the built transform — 4 for the CMYK destination. */
function outputChannels(t) {
    return (t.outputChannels || (t.outputProfile && t.outputProfile.outputChannels) || 4);
}

// ---- one cell -----------------------------------------------------------
async function runCell(content, kernel) {
    const t   = buildTransform(kernel);
    const img = makeImage(content, PX, 3);
    const mpx = PX / 1e6;

    // The baseline REUSES its output buffer. Letting it allocate a fresh
    // multi-megabyte array per iteration measured 36-45 MPx/s run to run — a
    // 25% spread that lands entirely in the denominator of every speedup on
    // this page, and enough to put a single worker above 1.00x, which cannot
    // happen. The pool's own scratch buffers persist across calls, so this is
    // the like-for-like comparison as well as the stable one.
    const outBuf  = new Uint8ClampedArray(PX * outputChannels(t));
    const seqMs   = benchSequential(t, img, outBuf);
    const expected = t.transformArray(img.data, false, false, false, img.pixelCount);

    const rows = [];
    for (let w = 1; w <= MAX_WORKERS; w++) {
        pool.destroyAll();                       // each count gets a clean pool
        const r = await benchWorkers(t, img, w);
        const wrong = differingBytes(r.images[0], expected);
        rows.push({
            workers:  w,
            used:     r.workersUsed,
            ms:       r.ms,
            mpxs:     mpx / (r.ms / 1000),
            speedup:  seqMs / r.ms,
            exact:    wrong === 0,
            wrong:    wrong
        });
    }
    pool.destroyAll();

    return {
        content, kernel,
        seqMs, seqMpxs: mpx / (seqMs / 1000),
        rows
    };
}

// ---- reporting ----------------------------------------------------------
function printCell(cell) {
    const f = (n, d = 1) => n.toFixed(d);
    console.log();
    console.log(`${cell.content} / ${cell.kernel}   (${(PX / 1e6).toFixed(1)} MPx, median of ${RUNS})`);
    console.log(`  sequential baseline: ${f(cell.seqMpxs)} MPx/s  (${f(cell.seqMs)} ms)`);
    console.log('  workers  used   MPx/s   speedup   efficiency   exact');
    for (const r of cell.rows) {
        const eff = (r.speedup / r.workers) * 100;
        console.log(
            '  ' + String(r.workers).padStart(7) +
            String(r.used).padStart(6) +
            f(r.mpxs).padStart(9) +
            (f(r.speedup, 2) + 'x').padStart(10) +
            (f(eff, 0) + '%').padStart(13) +
            (r.exact ? '     yes' : `   NO (${r.wrong})`)
        );
    }
}

function printSummary(cells) {
    console.log('\n\n=== peak speedup vs sequential ===\n');
    const kernels = [...new Set(cells.map(c => c.kernel))];
    const contents = [...new Set(cells.map(c => c.content))];

    console.log('kernel'.padEnd(20) + contents.map(c => c.padStart(14)).join(''));
    for (const k of kernels) {
        let line = k.padEnd(20);
        for (const c of contents) {
            const cell = cells.find(x => x.kernel === k && x.content === c);
            if (!cell) { line += ''.padStart(14); continue; }
            const best = cell.rows.reduce((a, b) => (b.speedup > a.speedup ? b : a));
            line += (best.speedup.toFixed(2) + 'x @' + best.workers).padStart(14);
        }
        console.log(line);
    }

    console.log('\n=== sequential MPx/s (what parallelism is multiplying) ===\n');
    console.log('kernel'.padEnd(20) + contents.map(c => c.padStart(14)).join(''));
    for (const k of kernels) {
        let line = k.padEnd(20);
        for (const c of contents) {
            const cell = cells.find(x => x.kernel === k && x.content === c);
            line += cell ? cell.seqMpxs.toFixed(1).padStart(14) : ''.padStart(14);
        }
        console.log(line);
    }

    console.log('\n=== does an odd worker count cost anything? ===');
    console.log('(pull-queue claim: no. lcms divides a buffer evenly, so a worker count');
    console.log(' that does not divide the work leaves a ragged tail. We fragment.)\n');
    console.log('NOT "mean odd efficiency vs mean even efficiency" — that comparison is');
    console.log('CONFOUNDED. Efficiency falls as workers are added, and {3,5,7} has a');
    console.log('lower mean count than {4,6,8}, so odd wins by about 4 points on any');
    console.log('machine, penalty or no penalty. The right test is local: does an odd');
    console.log('point sit BELOW the straight line joining its two neighbours?\n');

    for (const cell of cells) {
        const sp = w => {
            const r = cell.rows.find(x => x.workers === w);
            return r ? r.speedup : NaN;
        };
        const residuals = [];
        for (const w of [3, 5, 7]) {
            const lo = sp(w - 1), hi = sp(w + 1), mid = sp(w);
            if (isNaN(lo) || isNaN(hi) || isNaN(mid)) continue;
            const expected = (lo + hi) / 2;
            residuals.push({ w, pct: ((mid - expected) / expected) * 100 });
        }
        if (!residuals.length) continue;
        const mean = residuals.reduce((a, r) => a + r.pct, 0) / residuals.length;
        console.log('  ' + (cell.content + '/' + cell.kernel).padEnd(28) +
            residuals.map(r => 'w' + r.w + ' ' + (r.pct >= 0 ? '+' : '') +
                               r.pct.toFixed(1) + '%').join('  ').padEnd(32) +
            'mean ' + (mean >= 0 ? '+' : '') + mean.toFixed(1) + '%');
    }
    console.log('\n  Negative = an odd count underperforms its neighbours, i.e. a');
    console.log('  ragged-tail penalty. Around zero = the fragment queue does not care');
    console.log('  whether the worker count divides the image. Note run-to-run spread');
    console.log('  on parallel figures is 5-10%, so only a consistent sign means much.');

    const bad = cells.flatMap(c => c.rows.filter(r => !r.exact));
    console.log('\n' + (bad.length
        ? '!!! ' + bad.length + ' cell(s) did NOT match sequential output'
        : 'every cell byte-identical to sequential.'));
}

// ---- main ---------------------------------------------------------------
async function main() {
    if (CELL) {
        // Isolated child: one cell, JSON to stdout, nothing else in the process.
        const [content, kernel] = CELL.split('|');
        const cell = await runCell(content, kernel);
        process.stdout.write('\n@@CELL@@' + JSON.stringify(cell) + '@@END@@\n');
        return;
    }

    const contents = ONLY_CONTENT ? [ONLY_CONTENT] : CONTENTS;
    const kernels  = ONLY_KERNEL  ? [ONLY_KERNEL]  : KERNELS;

    console.log('multicore matrix — ' + (PX / 1e6).toFixed(1) + ' MPx, ' + RUNS +
                ' runs/cell, up to ' + MAX_WORKERS + ' workers' +
                (ISOLATE ? ', ISOLATED (process per cell)' : ', shared process'));
    console.log('sRGB -> GRACoL2006, int8, LUT');
    if (!ISOLATE) {
        console.log('note: --isolate is the honest mode; a shared process has been ' +
                    'measured to move results by 27%.');
    }

    const cells = [];
    for (const kernel of kernels) {
        for (const content of contents) {
            if (ISOLATE) {
                const out = execFileSync(process.execPath,
                    [__filename, '--cell=' + content + '|' + kernel,
                     '--px=' + PX, '--runs=' + RUNS, '--workers=' + MAX_WORKERS],
                    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
                const m = out.match(/@@CELL@@([\s\S]*?)@@END@@/);
                if (!m) { console.error(out); throw new Error('child produced no result'); }
                const cell = JSON.parse(m[1]);
                cells.push(cell);
                printCell(cell);
            } else {
                const cell = await runCell(content, kernel);
                cells.push(cell);
                printCell(cell);
            }
        }
    }

    printSummary(cells);

    // Same numbers as the summary above, as data. `scaling` carries every
    // worker count so the shape can be re-read later; `peak` is the row the
    // docs quote. Both come from the same cells, so they cannot disagree.
    emit.meta({ pixels: PX, runs: RUNS, maxWorkers: MAX_WORKERS, isolated: ISOLATE,
                workflow: 'sRGB -> GRACoL2006, int8, LUT' });

    emit.table({
        id:      'pool.peak',
        title:   'Worker pool — peak speedup vs sequential, by kernel and content',
        units:   'x',
        meta:    { pixels: PX, maxWorkers: MAX_WORKERS },
        columns: ['kernel', 'content', 'sequentialMpxs', 'peakSpeedup', 'atWorkers',
                  'peakMpxs', 'efficiencyPct', 'exact'],
        rows:    cells.map(function (c) {
            var best = c.rows.reduce(function (a, b) { return b.speedup > a.speedup ? b : a; });
            return {
                kernel:         c.kernel,
                content:        c.content,
                sequentialMpxs: +c.seqMpxs.toFixed(1),
                peakSpeedup:    +best.speedup.toFixed(2),
                atWorkers:      best.workers,
                peakMpxs:       +best.mpxs.toFixed(1),
                efficiencyPct:  Math.round((best.speedup / best.workers) * 100),
                exact:          c.rows.every(function (r) { return r.exact; }),
            };
        }),
    });

    emit.table({
        id:      'pool.scaling',
        title:   'Worker pool — every worker count',
        units:   'MPx/s',
        meta:    { pixels: PX },
        columns: ['kernel', 'content', 'workers', 'mpxs', 'speedup', 'efficiencyPct', 'exact'],
        rows:    cells.reduce(function (acc, c) {
            c.rows.forEach(function (r) {
                acc.push({
                    kernel: c.kernel, content: c.content, workers: r.workers,
                    mpxs: +r.mpxs.toFixed(1), speedup: +r.speedup.toFixed(2),
                    efficiencyPct: Math.round((r.speedup / r.workers) * 100),
                    exact: r.exact,
                });
            });
            return acc;
        }, []),
    });

    // Raw rows, so the analysis can be redone without re-benching. That is not
    // hypothetical: the first version of the odd/even statistic above was
    // confounded and had to be replaced, which cost a full re-run.
    const outFile = arg('out', null);
    if (outFile) {
        fs.writeFileSync(outFile, JSON.stringify({
            px: PX, runs: RUNS, maxWorkers: MAX_WORKERS, isolated: ISOLATE,
            node: process.version, when: new Date().toISOString(), cells
        }, null, 1));
        console.log('\nraw results -> ' + outFile);
    }
}

main().then(() => { pool.destroyAll(); })
      .catch(e => { console.error(e && e.stack || e); process.exit(1); });
