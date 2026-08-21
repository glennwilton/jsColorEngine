// browser-entry.js
//
// esbuild entry point for the browser bench bundle.
// Static imports so esbuild can tree-shake and bundle correctly.
// Loaded after window.jsColorEngine is available (via <script> tag in HTML).
//
// Build:  npm run bench-browser
// Output: samples/benchmark/bench.bundle.js
//
// BENCH_BUILD: bump this string whenever you change the bench framework so the
// browser console + engine info panel can confirm the loaded bundle is current.
// (If the version in the browser doesn't match what's in this file → hard-reload.)
const BENCH_BUILD = 'v0.6-scenario-test';

import { resources }   from './shared-resources.js';
import { BenchEngine } from './bench-engine.js';
import { GroupRunner } from './group-runner.js';
import { BenchUI }     from './bench-ui.js';
import { load }        from './loaders/webLoader.js';

// Side-effect imports — registers groups with the global registry
import './groups/baseline.js';
import './groups/jsce.js';
import './groups/lcms.js';
import './groups/v5-experimental.js';
import { setEngine as setJsceEngine } from './groups/jsce.js';

// Self-contained scenario — imported statically so esbuild bundles it inline.
// This scenario lives in its OWN module so V8 compiles it as an independent
// unit rather than as one of N polymorphic transform closures.
import { measure_jsce_rgb_rgb_wasm_simd } from './scenarios/jsce_rgb_rgb_wasm_simd.js';

// ---- Boot -----------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
    // Print the bench bundle version at the top of the console so the user can
    // verify they're looking at the latest build (after rebuild + hard reload).
    console.log(
        `%c[bench] Bundle: ${BENCH_BUILD}%c · jsColorEngine: ${window.jsColorEngine?.version ?? '?'} · loaded ${new Date().toISOString()}`,
        'background:#1a4d1a;color:#a3e635;padding:2px 6px;border-radius:3px;font-weight:600',
        'color:#888'
    );

    // Wire the build version into the engine info panel.
    const buildEl = document.getElementById('info-bench-build');
    if (buildEl) buildEl.textContent = BENCH_BUILD;

    const ui = new BenchUI();
    await ui.init();

    const runBtn  = document.getElementById('run-btn');
    const copyBtn = document.getElementById('copy-btn');
    let lastOutput = null;

    runBtn.addEventListener('click', async () => {
        const pixelSize   = parseInt(document.getElementById('pixel-size').value);
        const warmupRuns  = parseInt(document.getElementById('warmup-runs').value);
        const timedRuns   = parseInt(document.getElementById('timed-runs').value);
        const timedBatches = parseInt(document.getElementById('timed-batches').value);
        const skipWarmup  = document.getElementById('skip-warmup').checked;

        runBtn.disabled  = true;
        if (copyBtn) copyBtn.disabled = true;
        ui.reset();

        try {
            // Load profiles + engine references
            const { profiles, jsce } = await load();

            // Show jsce version and profile status now that they're loaded
            document.getElementById('info-jsce').textContent =
                jsce?.version ? `v${jsce.version}` : '?';
            document.getElementById('info-profile').textContent = 'loaded';

            // Print to console so the user can confirm same version as the old bench
            console.log('[bench] jsColorEngine version:', jsce?.version,
                '· source:', (jsce?.Transform?.toString?.() || '').slice(0, 100));

            setJsceEngine(jsce, profiles);

            resources.reset();
            await resources.initialize({ pixelCounts: [pixelSize] });

            const engine = new BenchEngine({
                pixelCounts: [pixelSize],
                warmupRuns,
                timedRuns,
                timedBatches,
                resources,
                onProgress: (e) => ui.onProgress(e),
            });

            const runner = new GroupRunner(engine);

            const output = await runner.runGroups(['baseline', 'jsce'], {
                skipWarmup,
                runBaselineTwice: true,
            });

            lastOutput = output;
            ui.setHardware(output.hardware);
            ui.printSummary(output);

            if (copyBtn) copyBtn.disabled = false;
        } catch (err) {
            console.error('[bench]', err);
            ui.showError(err.message || String(err));
        } finally {
            runBtn.disabled = false;
        }
    });

    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            if (!lastOutput) return;
            const md = buildMarkdown(lastOutput);
            navigator.clipboard.writeText(md).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy markdown'; }, 2000);
            });
        });
    }

    // ---- Direct kernel reference test --------------------------------------
    // No framework, no wrapper functions, no property accesses on a ctx object.
    // Calls xform.transformArray(input) in the tightest possible loop.
    const directBtn = document.getElementById('direct-btn');
    if (directBtn) {
        directBtn.addEventListener('click', () => runDirectKernelTest());
    }

    // ---- Self-contained scenario test --------------------------------------
    // One scenario file that does its own warmup + hot + timing as a single
    // function. V8 sees this as an independent compilation unit — no shared
    // call site with other benchmarks → no megamorphic dispatch.
    const scenarioBtn = document.getElementById('scenario-btn');
    if (scenarioBtn) {
        scenarioBtn.addEventListener('click', () => runScenarioTest());
    }
});

async function runScenarioTest() {
    const btn       = document.getElementById('scenario-btn');
    const resultEl  = document.getElementById('scenario-result');
    btn.disabled = true;
    resultEl.textContent = 'running scenario...';
    try {
        const result = await measure_jsce_rgb_rgb_wasm_simd(window.jsColorEngine, 65536);
        resultEl.innerHTML =
            `<strong style="color:var(--accent-2)">Self-contained scenario:</strong> ` +
            `${result.medianMs.toFixed(3)} ms/iter &nbsp;·&nbsp; ` +
            `<strong>${result.MPxPerSec.toFixed(1)} MPx/s</strong> &nbsp;·&nbsp; ` +
            `${result.MBps.toFixed(0)} MB/s ` +
            `<span style="color:var(--text-muted)">(samples: ${result.samples.map((s) => s.toFixed(3)).join(', ')})</span>`;
    } catch (err) {
        console.error('[scenario-test]', err);
        resultEl.innerHTML = `<span style="color:var(--error)">Error: ${err.message}</span>`;
    } finally {
        btn.disabled = false;
    }
}

async function runDirectKernelTest() {
    const btn        = document.getElementById('direct-btn');
    const statusEl   = document.getElementById('direct-status');
    const resultEl   = document.getElementById('direct-result');

    btn.disabled = true;
    statusEl.textContent = 'preparing...';
    resultEl.textContent = '';

    try {
        const j = window.jsColorEngine;
        if (!j) throw new Error('window.jsColorEngine not loaded');

        // Build the transform — same as old bench's RGB→RGB int-wasm-simd row.
        // Uses '*srgb' source and '*adobergb' destination — both jsce built-in
        // virtual profiles, exactly matching samples/bench/main.js directionConfigs.
        const xform = new j.Transform({
            buildLut:   true,
            dataFormat: 'int8',
            lutMode:    'int-wasm-simd',
        });
        xform.create('*srgb', '*adobergb', j.eIntent.relative);

        const pixelCount = 65536;
        const input = new Uint8ClampedArray(pixelCount * 3);
        let seed = 0x13579bdf;
        for (let i = 0; i < input.length; i++) {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            input[i] = seed & 0xff;
        }

        // Warmup — chunked with rAF yields so V8's background TurboFan
        // compilation can drain before we start timing (matches old bench).
        statusEl.textContent = 'warmup (200 iters)...';
        const warmupChunk = 50;
        for (let w = 0; w < 200; w += warmupChunk) {
            for (let i = 0; i < warmupChunk; i++) xform.transformArray(input);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        }
        // Final drain
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        // Hot — 5 batches of 50, median reported. EXACTLY the old bench pattern.
        statusEl.textContent = 'timing (5×50 iters)...';
        const samples = [];
        for (let b = 0; b < 5; b++) {
            const t0 = performance.now();
            for (let i = 0; i < 50; i++) xform.transformArray(input);
            samples.push((performance.now() - t0) / 50);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        }

        // Sort and compute median + min/max
        const sorted = samples.slice().sort((a, b) => a - b);
        const med    = sorted[2];   // middle of 5
        const min    = sorted[0];
        const max    = sorted[4];
        const mpx    = pixelCount / med / 1000;
        const mbps   = mpx * 6;     // 3 in + 3 out bytes per pixel

        statusEl.textContent = 'done';
        resultEl.innerHTML =
            `<strong style="color:var(--accent)">Direct kernel result:</strong> ` +
            `${med.toFixed(3)} ms/iter &nbsp;·&nbsp; ` +
            `<strong>${mpx.toFixed(1)} MPx/s</strong> &nbsp;·&nbsp; ${mbps.toFixed(0)} MB/s ` +
            `<span style="color:var(--text-muted)">(min ${min.toFixed(3)}, max ${max.toFixed(3)} ms; samples: ${samples.map((s) => s.toFixed(3)).join(', ')})</span>`;
    } catch (err) {
        console.error('[direct-test]', err);
        statusEl.textContent = 'error';
        resultEl.innerHTML = `<span style="color:var(--error)">Error: ${err.message}</span>`;
    } finally {
        btn.disabled = false;
    }
}

// ---- Markdown export ------------------------------------------------------

function buildMarkdown(output) {
    const hw = output.hardware;
    const lines = [
        `## jsColorEngine Benchmark Results`,
        ``,
        `**Hardware:**`,
        `- JS peak: ${hw?.jsPeakMBps?.toFixed(0)} MB/s (${hw?.jsPeakMPx?.toFixed(0)} MPx/s)`,
        `- WASM peak: ${hw?.wasmPeakMBps?.toFixed(0)} MB/s (${hw?.wasmPeakMPx?.toFixed(0)} MPx/s)`,
        `- CPU primes: ${hw?.cpuPrimesMs?.toFixed(2)} ms`,
        ``,
        `| Benchmark | Hot ms | MPx/s | MB/s |`,
        `|---|---|---|---|`,
    ];

    for (const [, results] of Object.entries(output.byGroup)) {
        for (const result of results) {
            if (result.metric === 'none' || result.metric === 'ops') continue;
            lines.push(
                `| ${result.name} | ${result.hot.medianMs.toFixed(3)} | ${result.MPxPerSec.toFixed(1)} | ${result.MBps.toFixed(0)} |`
            );
        }
    }

    return lines.join('\n');
}
