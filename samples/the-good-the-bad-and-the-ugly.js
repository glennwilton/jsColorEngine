import { runUglyBenchmark } from './the-good-the-bad-and-the-ugly-ugly.js';

const CONFIG = {
    pixelCount: 65536,
    warmupRuns: 200,
    warmupChunk: 50,
    timedRuns: 50,
    timedBatches: 5,
};

const CASES = {
    good: {
        label: 'The Good',
        note: 'Plugin pipeline, polluted dispatch IC at run().',
    },
    bad: {
        label: 'The Bad',
        note: 'Single fixed route wrapper around one Transform.',
    },
    ugly: {
        label: 'The Ugly',
        note: 'Hard-wired loop in its own module.',
    },
};

const results = new Map();

document.addEventListener('DOMContentLoaded', () => {
    setEngineInfo();
    wireButtons();
});

function wireButtons() {
    document.getElementById('run-all').addEventListener('click', runAll);
    document.getElementById('run-good').addEventListener('click', () => runCase('good'));
    document.getElementById('run-bad').addEventListener('click', () => runCase('bad'));
    document.getElementById('run-ugly').addEventListener('click', () => runCase('ugly'));
}

async function runAll() {
    setAllButtons(true);
    results.clear();
    clearResults();

    try {
        await runCase('good', { keepButtonsDisabled: true });
        await runCase('bad', { keepButtonsDisabled: true });
        await runCase('ugly', { keepButtonsDisabled: true });
    } finally {
        setAllButtons(false);
    }
}

async function runCase(id, options = {}) {
    const button = document.getElementById(`run-${id}`);
    const row = document.getElementById(`result-${id}`);
    const status = document.getElementById('status');

    if (!options.keepButtonsDisabled) button.disabled = true;
    setResultState(id, 'running warmup and timed batches...');
    status.textContent = `Running ${CASES[id].label.toLowerCase()}...`;

    try {
        const jsce = window.jsColorEngine;
        if (!jsce) throw new Error('jsColorEngine did not load.');

        const input = buildInput(CONFIG.pixelCount);
        const output = new Uint8ClampedArray(CONFIG.pixelCount * 3);

        let result;
        if (id === 'good') result = await runGoodBenchmark(jsce, input, output, CONFIG);
        if (id === 'bad') result = await runBadBenchmark(jsce, input, output, CONFIG);
        if (id === 'ugly') result = await runUglyBenchmark(jsce, input, output, CONFIG);

        results.set(id, result);
        renderResult(id, result);
        renderComparison();
        status.textContent = `${CASES[id].label} complete.`;
    } catch (err) {
        console.error('[good-bad-ugly]', err);
        row.querySelector('.result-main').textContent = 'Error';
        row.querySelector('.result-sub').textContent = err.message || String(err);
        status.textContent = 'Error. See console for details.';
    } finally {
        if (!options.keepButtonsDisabled) button.disabled = false;
    }
}

async function runGoodBenchmark(jsce, input, output, config) {
    const setupStart = performance.now();
    const pipeline = new FilterPipeline();
    pipeline.register('identity', new IdentityFilter());
    pipeline.register('invert', new InvertFilter());
    pipeline.register('gamma22', new GammaFilter(2.2));
    pipeline.register('gamma18', new GammaFilter(1.8));
    pipeline.register('brightness', new BrightnessFilter(20));
    pipeline.register('contrast', new ContrastFilter(1.2));
    pipeline.register('shuffle', new ChannelShuffleFilter());
    pipeline.register('jsce-wasm-simd', new JsceTransformFilter(createReadyTransform(jsce), config.pixelCount));
    const setupMs = performance.now() - setupStart;

    pollutePipelineIC(pipeline, input, output);

    pipeline.select('jsce-wasm-simd');
    for (let w = 0; w < config.warmupRuns; w += config.warmupChunk) {
        for (let i = 0; i < config.warmupChunk; i++) {
            pipeline.process(input, output);
        }
        await yieldRAF();
    }
    await yieldRAF();

    const samples = [];
    for (let b = 0; b < config.timedBatches; b++) {
        pollutePipelineIC(pipeline, input, output);
        pipeline.select('jsce-wasm-simd');

        const t0 = performance.now();
        for (let i = 0; i < config.timedRuns; i++) {
            pipeline.process(input, output);
        }
        samples.push((performance.now() - t0) / config.timedRuns);
        await yieldRAF();
    }

    return finishResult('good', setupMs, samples, config.pixelCount);
}

function pollutePipelineIC(pipeline, input, output) {
    for (const name of pipeline.plugins.keys()) {
        pipeline.select(name);
        pipeline.process(input, output);
        pipeline.process(input, output);
    }
}

async function runBadBenchmark(jsce, input, output, config) {
    const setupStart = performance.now();
    const route = new FixedRoute(createReadyTransform(jsce), config.pixelCount);
    const setupMs = performance.now() - setupStart;

    for (let w = 0; w < config.warmupRuns; w += config.warmupChunk) {
        for (let i = 0; i < config.warmupChunk; i++) {
            route.convert(input, output);
        }
        await yieldRAF();
    }
    await yieldRAF();

    const samples = [];
    for (let b = 0; b < config.timedBatches; b++) {
        const t0 = performance.now();
        for (let i = 0; i < config.timedRuns; i++) {
            route.convert(input, output);
        }
        samples.push((performance.now() - t0) / config.timedRuns);
        await yieldRAF();
    }

    return finishResult('bad', setupMs, samples, config.pixelCount);
}

class FilterPipeline {
    constructor() {
        this.plugins = new Map();
        this.current = null;
    }

    register(name, plugin) {
        this.plugins.set(name, plugin);
    }

    select(name) {
        this.current = this.plugins.get(name);
    }

    process(input, output) {
        return this.current.run(input, output);
    }
}

class IdentityFilter {
    constructor() { this.tag = 'identity'; }
    run(input, output) {
        output.set(input);
        return output;
    }
}

class InvertFilter {
    constructor() {
        this.lut = new Uint8Array(256);
        for (let i = 0; i < 256; i++) this.lut[i] = 255 - i;
    }
    run(input, output) {
        const lut = this.lut;
        const n = input.length;
        for (let i = 0; i < n; i++) output[i] = lut[input[i]];
        return output;
    }
}

class GammaFilter {
    constructor(gamma) {
        this.gamma = gamma;
        this.lut = new Uint8Array(256);
        const inv = 1 / gamma;
        for (let i = 0; i < 256; i++) {
            this.lut[i] = Math.round(Math.pow(i / 255, inv) * 255);
        }
    }
    run(input, output) {
        const lut = this.lut;
        const n = input.length;
        for (let i = 0; i < n; i++) output[i] = lut[input[i]];
        return output;
    }
}

class BrightnessFilter {
    constructor(delta) { this.delta = delta; this.kind = 'add'; }
    run(input, output) {
        const d = this.delta;
        const n = input.length;
        for (let i = 0; i < n; i++) {
            const v = input[i] + d;
            output[i] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        return output;
    }
}

class ContrastFilter {
    constructor(factor) { this.factor = factor; this.pivot = 128; this.kind = 'mul'; }
    run(input, output) {
        const f = this.factor;
        const p = this.pivot;
        const n = input.length;
        for (let i = 0; i < n; i++) {
            const v = (input[i] - p) * f + p;
            output[i] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        return output;
    }
}

class ChannelShuffleFilter {
    constructor() { this.order = [2, 0, 1]; this.kind = 'shuffle'; this.alpha = false; }
    run(input, output) {
        const n = input.length;
        for (let i = 0; i < n; i += 3) {
            output[i] = input[i + 2];
            output[i + 1] = input[i];
            output[i + 2] = input[i + 1];
        }
        return output;
    }
}

class JsceTransformFilter {
    constructor(transform, pixelCount) {
        this.transform = transform;
        this.pixelCount = pixelCount;
        this.kind = 'icc';
        this.inputHasAlpha = false;
        this.outputHasAlpha = false;
    }
    run(input, output) {
        return this.transform.transformArray(
            input, false, false, false,
            this.pixelCount, undefined, output
        );
    }
}

class FixedRoute {
    constructor(transform, pixelCount) {
        this.transform = transform;
        this.pixelCount = pixelCount;
    }

    convert(input, output) {
        return this.transform.transformArray(input, false, false, false, this.pixelCount, undefined, output);
    }
}

function createTransform(jsce) {
    return new jsce.Transform({
        buildLut: true,
        dataFormat: 'int8',
        lutMode: 'int-wasm-simd',
    });
}

function createReadyTransform(jsce) {
    const xform = createTransform(jsce);
    xform.create('*srgb', '*adobergb', jsce.eIntent.relative);
    return xform;
}

function buildInput(pixelCount) {
    const input = new Uint8Array(pixelCount * 3);
    let seed = 0x13579bdf;
    for (let i = 0; i < input.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        input[i] = seed & 0xff;
    }
    return input;
}

function finishResult(id, setupMs, samples, pixelCount) {
    const medianMs = median(samples);
    const MPxPerSec = pixelCount / medianMs / 1000;
    return {
        id,
        setupMs,
        samples,
        medianMs,
        MPxPerSec,
        MBps: MPxPerSec * 6,
    };
}

function median(samples) {
    const sorted = samples.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function yieldRAF() {
    if (typeof requestAnimationFrame === 'function') {
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    return new Promise((resolve) => setTimeout(resolve, 16));
}

function setEngineInfo() {
    const jsce = window.jsColorEngine;
    document.getElementById('info-jsce').textContent = jsce?.version ? `v${jsce.version}` : '?';
    document.getElementById('info-pixels').textContent = CONFIG.pixelCount.toLocaleString();
    document.getElementById('info-runs').textContent = `${CONFIG.warmupRuns} warmup, ${CONFIG.timedBatches} x ${CONFIG.timedRuns} timed`;
    document.getElementById('info-ua').textContent = navigator.userAgent;
}

function setAllButtons(disabled) {
    for (const button of document.querySelectorAll('button[data-run]')) {
        button.disabled = disabled;
    }
}

function clearResults() {
    for (const id of Object.keys(CASES)) {
        setResultState(id, 'not run yet');
    }
    document.getElementById('comparison-body').innerHTML = '';
}

function setResultState(id, text) {
    const row = document.getElementById(`result-${id}`);
    row.querySelector('.result-main').textContent = text;
    row.querySelector('.result-sub').textContent = CASES[id].note;
}

function renderResult(id, result) {
    const row = document.getElementById(`result-${id}`);
    row.querySelector('.result-main').textContent =
        `${result.MPxPerSec.toFixed(1)} MPx/s`;
    row.querySelector('.result-sub').textContent =
        `${result.medianMs.toFixed(3)} ms/iter, ${result.MBps.toFixed(0)} MB/s, setup ${result.setupMs.toFixed(1)} ms, samples ${result.samples.map((s) => s.toFixed(3)).join(', ')}`;
}

function renderComparison() {
    const tbody = document.getElementById('comparison-body');
    tbody.innerHTML = '';

    const ugly = results.get('ugly');
    const fastest = Math.max(...Array.from(results.values()).map((result) => result.MPxPerSec));

    for (const id of ['good', 'bad', 'ugly']) {
        const result = results.get(id);
        if (!result) continue;

        const row = tbody.insertRow();
        row.insertCell().textContent = CASES[id].label;
        row.insertCell().textContent = result.MPxPerSec.toFixed(1);
        row.insertCell().textContent = result.medianMs.toFixed(3);
        row.insertCell().textContent = ugly ? `${(result.MPxPerSec / ugly.MPxPerSec * 100).toFixed(0)}%` : '-';

        const barCell = row.insertCell();
        const bar = document.createElement('div');
        bar.className = 'speedbar';
        const fill = document.createElement('span');
        fill.style.width = `${Math.max(4, result.MPxPerSec / fastest * 100).toFixed(1)}%`;
        bar.appendChild(fill);
        barCell.appendChild(bar);
    }
}
