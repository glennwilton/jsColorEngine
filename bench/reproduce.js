#!/usr/bin/env node
/**
 * bench/reproduce.js
 * ==================
 *
 * ONE command that reproduces every number in docs/LcmsComparison.md.
 *
 * Why this exists
 * ---------------
 * That page opens by saying the comparison should be produced "in one
 * controlled session on one machine, rather than assembled from runs made
 * months apart" — and the first time we produced it, the orchestration lived
 * in a shell script in a temp directory. This file is that script, kept.
 *
 * It matters for three reasons:
 *   - **Review.** Anyone doubting a figure can regenerate the whole set rather
 *     than one cherry-picked row.
 *   - **Re-runs.** New hardware, new Node, new lcms — same command.
 *   - **Attribution.** Every phase writes its raw output to the same
 *     timestamped folder alongside a conditions file, so a number can always
 *     be traced back to the machine and versions that produced it.
 *
 * Phases (each can be run alone with --only)
 * ------------------------------------------
 *   corpus         decode the photo corpus to raw planes (both harnesses read these)
 *   accuracy       jsCE vs the lcms oracle — the half that matters most
 *   flags          sweep lcms CFLAGS, so lcms gets its best build      [slow, opt-in]
 *   native         lcms native C: content matrix at -O2 and -O3, then a size sweep
 *   js             jsCE + lcms-wasm: content matrix, size sweep, per-image
 *   matrix         the fused matrix-shaper kernel: throughput by content, and accuracy
 *   pool           the worker pool: the content x kernel x worker-count matrix   [slow]
 *   pixelcache     accuracy-path cache + in-kernel WASM off-vs-auto
 *   solo           the minimal control bench (one image, one engine, one process)
 *
 * NOTHING ELSE SHOULD BE RUNNING. These are timing measurements on one pinned
 * core; a background build or test run will quietly corrupt them. We know,
 * because a stray `npx jest` corrupted a native block during the first run and
 * it had to be re-measured.
 *
 * Usage:
 *   node bench/reproduce.js                       # everything except the flag sweep
 *   node bench/reproduce.js --quick               # 1M px only, fewer repeats (~15 min)
 *   node bench/reproduce.js --only js,solo
 *   node bench/reproduce.js --with-flags          # include the CFLAGS sweep
 *   node bench/reproduce.js --skip-native         # no WSL/gcc available
 *   node bench/reproduce.js --wsl-distro Ubuntu
 *
 * Native is the fourth phase, only seconds after start (corpus + accuracy
 * are cheap). A background `wsl` poke would still lose that race, so on
 * Windows we start the distro at the top and wait until `gcc --version`
 * answers — same as opening a WSL terminal, without the extra click.
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const ROOT        = path.join(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');
const LCMS_C      = path.join(__dirname, 'lcms_c');
const MATRIX      = path.join(__dirname, 'release_matrix');

// ---- arguments ---------------------------------------------------------

function arg(name, fallback) {
    const i = process.argv.indexOf('--' + name);
    return (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'))
        ? process.argv[i + 1] : fallback;
}
const has = name => process.argv.includes('--' + name);

const QUICK       = has('quick');
const WITH_FLAGS  = has('with-flags');
const SKIP_NATIVE = has('skip-native');
const WSL_DISTRO  = arg('wsl-distro', 'Ubuntu');
const ONLY        = arg('only', null);

const ALL_PHASES = ['corpus', 'accuracy', 'flags', 'native', 'js', 'matrix', 'pool',
                    'pixelcache', 'smalldim', 'solo'];
const phases = ONLY
    ? ONLY.split(',').map(s => s.trim()).filter(p => ALL_PHASES.includes(p))
    : ALL_PHASES.filter(p => p !== 'flags' || WITH_FLAGS);

// The size axis is the expensive part: a 10M px cell allocates 40 MB and
// counts distinct colours over it. --quick drops to the one size the
// published content tables actually use.
const CONTENT_SIZE = 1048576;
const SIZE_SWEEP   = QUICK ? '65536,1048576' : '16384,65536,1048576,10485760';
const SOLO_REPEAT  = QUICK ? 3 : 5;
// The pool matrix is the slowest phase — 3 contents x 3 kernels x 8 worker
// counts, each in its own process. Quick mode halves the image and the
// repeats; the SHAPE survives that, the absolute numbers do not.
const POOL_PX      = QUICK ? 2097152 : 4194304;
const POOL_RUNS    = QUICK ? 3 : 5;

// ---- output folder -----------------------------------------------------

const stamp   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT_DIR = path.join(RESULTS_DIR, stamp);
fs.mkdirSync(OUT_DIR, { recursive: true });

function write(name, text) { fs.writeFileSync(path.join(OUT_DIR, name), text); }

// ---- running things ----------------------------------------------------

/**
 * Run a bench in its own process.
 *
 * `jsonName` names a file under `<results>/json/`; the child writes its own
 * structured rows there through `bench/lib/emit.cjs` (a no-op when the variable
 * is absent, so the bench still runs normally by hand). That is what stops a
 * published table being a hand transcription of console output.
 */
function node(args, cwd, jsonName) {
    const env = Object.assign({}, process.env);
    if (jsonName) env.JSCE_BENCH_JSON = path.join(OUT_DIR, 'json', jsonName + '.json');
    else delete env.JSCE_BENCH_JSON;
    return execFileSync(process.execPath, args, {
        cwd: cwd || ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env,
    });
}

// Native lcms needs gcc. On Windows that means WSL, and the path has to be
// translated; elsewhere we just run bash. Either way the binary is pinned to
// core 0 so it is never migrated mid-measurement.
const isWindows = process.platform === 'win32';

function bashInLcmsDir(script) {
    if (isWindows) {
        const wslPath = '/mnt/' + LCMS_C[0].toLowerCase() + LCMS_C.slice(2).replace(/\\/g, '/');
        return execFileSync('wsl.exe', ['-d', WSL_DISTRO, '--', 'bash', '-lc',
            `cd ${wslPath} && ${script}`],
            { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    }
    return execSync(script, { cwd: LCMS_C, encoding: 'utf8', shell: '/bin/bash',
        maxBuffer: 64 * 1024 * 1024 });
}

function nativeAvailable() {
    try {
        const out = bashInLcmsDir('gcc --version | head -1');
        return out.trim();
    } catch { return null; }
}

function sleepMs(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Cold WSL2 is not started by the first `gcc --version` probe. Kick the
// distro now and wait — native is only seconds away, not 14 minutes.
function wakeWsl() {
    if (!isWindows || SKIP_NATIVE) return;
    if (!phases.includes('native') && !phases.includes('flags')) return;
    process.stdout.write('waking WSL2 (' + WSL_DISTRO + ')…\n');
    const deadline = Date.now() + 120000;
    let last = 'not started';
    while (Date.now() < deadline) {
        try {
            execFileSync('wsl.exe', ['-d', WSL_DISTRO, '--', 'true'], {
                encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
            });
            const gcc = nativeAvailable();
            if (gcc) {
                process.stdout.write('  ready: ' + gcc + '\n');
                return gcc;
            }
            last = 'distro is up, gcc is not on PATH';
        } catch (e) {
            last = (e.stderr && String(e.stderr).trim()) || e.message;
        }
        process.stdout.write('  waiting for WSL/gcc…\n');
        sleepMs(3000);
    }
    process.stdout.write('  warmup gave up: ' + last + '\n');
    return null;
}

// ---- conditions --------------------------------------------------------
//
// The doc's Conditions table is not decoration: a throughput figure without
// the CPU, the compiler flags and the versions attached is not reproducible.
// This captures what can be captured automatically.

function captureConditions(gccVersion) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    let lcmsWasm = 'not installed';
    try {
        lcmsWasm = JSON.parse(fs.readFileSync(
            path.join(MATRIX, 'node_modules', 'lcms-wasm', 'package.json'), 'utf8')).version;
    } catch { /* the js phase will fail loudly if this matters */ }

    let corpus = 'not generated';
    try {
        const m = JSON.parse(fs.readFileSync(path.join(MATRIX, 'corpus', 'corpus.json'), 'utf8'));
        corpus = `${m.images.length} images, ` +
            `${m.images.reduce((a, e) => a + e.pixels, 0).toLocaleString()} px, ` +
            `mean adjacency ${m.meanAdjRgb}% RGB / ${m.meanAdjCmyk}% CMYK`;
    } catch { /* corpus phase reports this */ }

    const lines = [
        '# Reproduction conditions',
        '',
        'Generated by `bench/reproduce.js`. Paste into the Conditions table of',
        'docs/LcmsComparison.md, and state the winning CFLAGS from the flag sweep.',
        '',
        '| | |',
        '|---|---|',
        `| Date | ${new Date().toISOString().slice(0, 10)} |`,
        `| CPU | ${os.cpus()[0].model} (${os.cpus().length} logical) |`,
        `| RAM | ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB |`,
        `| JS host | Node ${process.version}, ${process.platform} ${process.arch} |`,
        `| lcms native host | ${gccVersion ? (isWindows ? `WSL2 (${WSL_DISTRO}), ` : '') + gccVersion : 'SKIPPED'} |`,
        `| lcms-wasm version | ${lcmsWasm} |`,
        `| jsColorEngine version | ${pkg.version} |`,
        `| Photo corpus | ${corpus} |`,
        `| Content size | ${CONTENT_SIZE.toLocaleString()} px |`,
        `| Size sweep | ${SIZE_SWEEP} |`,
        `| Mode | ${QUICK ? 'QUICK — reduced sizes/repeats, not for publication' : 'full'} |`,
        '',
        '`taskset -c 0` pins the native binary to one core. Every JS measurement',
        'runs in its own process with its own warmup.',
        '',
    ];
    write('conditions.md', lines.join('\n'));
    return lines.join('\n');
}

// ---- phases ------------------------------------------------------------

const results = [];

function phase(name, fn) {
    if (!phases.includes(name)) return;
    const started = Date.now();
    process.stdout.write(`\n=== ${name} ${'='.repeat(Math.max(0, 60 - name.length))}\n`);
    try {
        fn();
        const mins = ((Date.now() - started) / 60000).toFixed(1);
        results.push({ name, status: 'ok', mins });
        process.stdout.write(`--- ${name}: done in ${mins} min\n`);
    } catch (error) {
        const mins = ((Date.now() - started) / 60000).toFixed(1);
        results.push({ name, status: 'FAILED', mins, error: error.message.split('\n')[0] });
        process.stdout.write(`!!! ${name}: FAILED after ${mins} min — ${error.message.split('\n')[0]}\n`);
        write(name + '.error.txt', String(error.stack || error.message));
    }
}

let gccVersion = wakeWsl();

phase('corpus', () => {
    const out = node([path.join(MATRIX, 'make_corpus.cjs')]);
    write('corpus.txt', out);
    process.stdout.write(out);
});

phase('accuracy', () => {
    const out = node([path.join(__dirname, 'lcms-comparison', 'accuracy.js')],
        path.join(__dirname, 'lcms-comparison'));
    write('accuracy.txt', out);
    // The summary table is the part worth seeing on screen.
    process.stdout.write(out.slice(out.indexOf('SUMMARY') - 64));
});

phase('flags', () => {
    if (SKIP_NATIVE) throw new Error('--skip-native given');
    const out = bashInLcmsDir('bash flag_sweep.sh');
    write('native-flag-sweep.txt', out);
    process.stdout.write(out);
});

phase('native', () => {
    if (SKIP_NATIVE) throw new Error('--skip-native given');
    gccVersion = gccVersion || nativeAvailable();
    if (!gccVersion) throw new Error(
        'no gcc after waking WSL2 (' + WSL_DISTRO + '). Install build-essential ' +
        'in that distro, pass --wsl-distro <name>, or pass --skip-native.');

    process.stdout.write('building lcms2 at -O2 and -O3 (a few minutes)...\n');
    bashInLcmsDir(
        'gcc -O2 -std=c99 -I lcms2-2.18/include -o /tmp/bm_O2 ' +
        'bench_content_matrix.c lcms2-2.18/src/*.c -lm && ' +
        'gcc -O3 -std=c99 -I lcms2-2.18/include -o /tmp/bm_O3 ' +
        'bench_content_matrix.c lcms2-2.18/src/*.c -lm');

    // Both builds, because no single flag set wins every workflow: -O2 takes
    // the RGB-source ones, -O3 the CMYK-source ones. The published table
    // quotes lcms's best per workflow, which needs both measured.
    for (const build of ['O2', 'O3']) {
        process.stdout.write(`native content matrix, -${build}...\n`);
        const out = bashInLcmsDir(`taskset -c 0 /tmp/bm_${build} --sizes ${CONTENT_SIZE}`);
        write(`native-content-${build}.txt`, out);
    }

    process.stdout.write('native size sweep, -O3, noise...\n');
    write('native-sizes-O3.txt',
        bashInLcmsDir(`taskset -c 0 /tmp/bm_O3 --sizes ${SIZE_SWEEP} --content noise`));
});

phase('js', () => {
    process.stdout.write('js content matrix (one process per cell)...\n');
    const content = node([path.join(MATRIX, 'run.js'), '--isolate', '--sizes', String(CONTENT_SIZE)],
        MATRIX, 'js-content');
    write('js-content.txt', content);
    process.stdout.write(content);

    process.stdout.write('js size sweep...\n');
    write('js-sizes.txt',
        node([path.join(MATRIX, 'run.js'), '--isolate', '--sizes', SIZE_SWEEP, '--content', 'noise'],
            MATRIX, 'js-sizes'));

    // Per-image rows: the claim that throughput tracks distinct-colour count
    // rather than adjacency is only checkable image by image.
    let stems = [];
    try {
        stems = JSON.parse(fs.readFileSync(path.join(MATRIX, 'corpus', 'corpus.json'), 'utf8'))
            .images.map(i => 'image:' + i.stem);
    } catch { /* no corpus — skip */ }
    if (stems.length) {
        process.stdout.write('js per-image...\n');
        write('js-per-image.txt',
            node([path.join(MATRIX, 'run.js'), '--isolate', '--sizes', String(CONTENT_SIZE),
                  '--content', stems.join(',')], MATRIX, 'js-per-image'));
    }
});

phase('matrix', () => {
    // The matrix-shaper kernel owns its own numbers: it displaces the CLUT
    // rather than sitting in the lutMode ladder, so the release matrix above
    // never measures it.
    process.stdout.write('matrix-shaper throughput (int8 and int16, three content classes)...\n');
    const out = node([path.join(__dirname, 'matrix_shaper_kernel', 'throughput.js')],
        ROOT, 'matrix-throughput');
    write('matrix-throughput.txt', out);
    process.stdout.write(out);

    // Both depths: int16 is where the quartic output-table index earns its
    // keep, so running only int8 misses half the accuracy case.
    for (const bits of ['8', '16']) {
        process.stdout.write('matrix-shaper accuracy vs the exact pipeline, int' + bits + '...\n');
        write('matrix-accuracy-int' + bits + '.txt',
            node([path.join(__dirname, 'matrix_shaper_kernel', 'accuracy.js'), bits],
                ROOT, 'matrix-accuracy-int' + bits));
    }
});

phase('pool', () => {
    // One process per cell: a shared process has been measured to move these
    // by 27%. Slow, and the only honest way to run it.
    process.stdout.write('worker pool matrix (process per cell — this is the slow one)...\n');
    // This bench takes --name=value, not --name value. Passing them apart
    // silently measures the defaults instead of what was asked for.
    const out = node([path.join(__dirname, 'multicore_matrix', 'run.js'), '--isolate',
                      '--px=' + POOL_PX, '--runs=' + POOL_RUNS,
                      '--out=' + path.join(OUT_DIR, 'pool-raw.json')],
        ROOT, 'pool-matrix');
    write('pool-matrix.txt', out);
    process.stdout.write(out);

    process.stdout.write('matrix-shaper kernel in the pool (the faster kernel scales worse)...\n');
    write('pool-matrix-shaper.txt',
        node([path.join(__dirname, 'matrix_shaper_kernel', 'multicore.js')],
            ROOT, 'pool-matrix-shaper'));
});

phase('pixelcache', () => {
    const out = node([path.join(MATRIX, 'run.js'), '--pixelcache', '--sizes', '262144'],
        MATRIX, 'pixelcache');
    write('pixelcache.txt', out);
    process.stdout.write(out);
});

phase('smalldim', () => {
    // The 1- and 2-channel kernels. Every other phase here measures 3 and 4
    // channel input, which left Kernel1D and Kernel2D with no coverage at all.
    // Synthetic LUTs, so this needs no gray or duotone profile — those are
    // vendor artefacts that cannot be committed, and there is no virtual gray
    // profile to fall back on.
    process.stdout.write('gray and duotone kernels (synthetic LUTs)...\n');
    const out = node([path.join(__dirname, 'small_dim', 'run.js'),
                      '--px', String(CONTENT_SIZE)], ROOT, 'small-dim');
    write('small-dim.txt', out);
    process.stdout.write(out);
});

phase('solo', () => {
    for (const workflow of ['rgb2lab', 'rgb2cmyk']) {
        const out = node([path.join(__dirname, 'solo_photo', 'solo.js'),
            '--repeat', String(SOLO_REPEAT), '--workflow', workflow], ROOT, 'solo-' + workflow);
        write(`solo-${workflow}.txt`, out);
        process.stdout.write(out);
    }
});

// ---- wrap up -----------------------------------------------------------

const conditions = captureConditions(gccVersion || (SKIP_NATIVE ? null : nativeAvailable()));

const summary = [
    '',
    '='.repeat(70),
    ' REPRODUCTION COMPLETE',
    '='.repeat(70),
    ' results: ' + OUT_DIR,
    '',
    ...results.map(r => `  ${r.status === 'ok' ? '✓' : '✗'} ${r.name.padEnd(12)} ${String(r.mins).padStart(5)} min` +
        (r.error ? '   ' + r.error : '')),
    '',
    ' conditions.md holds the machine/version block for the doc.',
    QUICK ? ' QUICK MODE — reduced coverage, do not publish these figures.' : '',
    '',
].filter(Boolean).join('\n');

write('summary.txt', summary + '\n\n' + conditions);
process.stdout.write(summary + '\n');

if (results.some(r => r.status !== 'ok')) process.exitCode = 1;
