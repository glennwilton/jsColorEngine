var _jsceBench = (() => {
  // samples/benchmark/shared-resources.js
  var ResourcePool = class {
    constructor() {
      this.testData = /* @__PURE__ */ new Map();
      this.loaded = false;
    }
    reset() {
      this.testData.clear();
      this.loaded = false;
    }
    async initialize(config = {}) {
      if (this.loaded) return;
      const seed = config.seed ?? 305419896;
      const pixelCounts = config.pixelCounts ?? [32768, 65536, 1e6, 1e7];
      for (const pixelCount of pixelCounts) {
        this.testData.set(pixelCount, {
          rgbIn: { label: `RGB input (${pixelCount} px)`, bin: this._gen(pixelCount * 3, seed) },
          cmykIn: { label: `CMYK input (${pixelCount} px)`, bin: this._gen(pixelCount * 4, seed + 1) }
        });
      }
      this.loaded = true;
    }
    // Deterministic LCG — same seed produces identical bytes every run.
    _gen(byteCount, seed) {
      const data = new Uint8Array(byteCount);
      let rng = seed >>> 0;
      for (let i = 0; i < byteCount; i++) {
        rng = rng * 1664525 + 1013904223 >>> 0;
        data[i] = rng >>> 24;
      }
      return data;
    }
    getTestData(pixelCount) {
      if (!this.testData.has(pixelCount)) {
        throw new Error(`No test data for ${pixelCount} px. Available: ${[...this.testData.keys()].join(", ")}`);
      }
      return this.testData.get(pixelCount);
    }
    // Always allocate a fresh buffer — never reuse across timed runs.
    // Reuse hides allocation cost and can warm/pollute caches.
    createOutputBuffer(type, pixelCount) {
      const channels = type === "cmyk" ? 4 : 3;
      return {
        label: `${type.toUpperCase()} output (${pixelCount} px)`,
        bin: new Uint8Array(pixelCount * channels)
      };
    }
  };
  var resources = new ResourcePool();

  // samples/benchmark/bench-engine.js
  var HAS_GC = typeof globalThis.gc === "function";
  function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
  function stdDev(arr) {
    const m = arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  }
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
  function yieldToCompilation() {
    if (typeof requestAnimationFrame === "function") {
      return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
    }
    return new Promise((r) => setTimeout(r, 50));
  }
  var BenchEngine = class {
    constructor(config = {}) {
      this.config = {
        pixelCounts: config.pixelCounts || [32768, 65536, 1e6, 1e7],
        warmupRuns: config.warmupRuns ?? 200,
        // Hot timing uses batch mode: time `timedRuns` iterations as one block,
        // repeat `timedBatches` times, report median of the per-iter batch averages.
        // This eliminates performance.now() overhead and timer jitter for sub-ms ops
        // and allows V8 to optimize the tight inner loop — matching the old bench.
        timedRuns: config.timedRuns ?? 50,
        // iters per batch
        timedBatches: config.timedBatches ?? 5,
        // number of batches
        warmupSampleEvery: config.warmupSampleEvery ?? 10,
        isolateRuns: config.isolateRuns ?? true,
        isolationSleepMs: config.isolationSleepMs ?? 10,
        detectThermalThrottle: config.detectThermalThrottle ?? true,
        thermalIntervalMs: config.thermalIntervalMs ?? 3e4,
        thermalWarmupMs: config.thermalWarmupMs ?? 5e3,
        thermalCheckRuns: config.thermalCheckRuns ?? 10,
        resources: config.resources || null,
        onProgress: config.onProgress || (() => {
        }),
        onComplete: config.onComplete || (() => {
        })
      };
      this.thermalBaseline = null;
      this.thermalHistory = [];
      this.benchStartTime = 0;
    }
    // Force GC if available (Node --expose-gc). Safe no-op in browser.
    forceGC() {
      if (this.config.isolateRuns && HAS_GC) {
        globalThis.gc();
      }
    }
    // Cheap sampled checksum for output validation.
    // Not cryptographic — just enough to detect "transform produced different bytes".
    checksum(data, samples = 1024) {
      let sum = 0;
      const step = Math.max(1, Math.floor(data.length / samples));
      for (let i = 0; i < data.length; i += step) {
        sum = sum * 31 + data[i] >>> 0;
      }
      return sum;
    }
    // ---- Thermal monitoring ----------------------------------------------
    async warmupCPU(cpuBench) {
      if (!this.config.detectThermalThrottle) return;
      if (!cpuBench) return;
      this.config.onProgress({ phase: "thermal-warmup" });
      const ctx = await cpuBench.setup(null, new Uint8Array(16));
      const start = performance.now();
      while (performance.now() - start < this.config.thermalWarmupMs) {
        cpuBench.transform(ctx, null, new Uint8Array(16));
      }
      const times = [];
      for (let i = 0; i < this.config.thermalCheckRuns; i++) {
        const t0 = performance.now();
        cpuBench.transform(ctx, null, new Uint8Array(16));
        times.push(performance.now() - t0);
      }
      this.thermalBaseline = median(times);
      this.thermalHistory.push({
        t: Date.now(),
        ms: this.thermalBaseline,
        phase: "baseline"
      });
      this.thermalCpuBench = cpuBench;
      this.thermalCpuCtx = ctx;
      this.config.onProgress({
        phase: "thermal-baseline",
        baselineMs: this.thermalBaseline
      });
    }
    async checkThermalThrottle() {
      if (!this.config.detectThermalThrottle) return null;
      if (!this.thermalBaseline) return null;
      if (!this.thermalCpuBench) return null;
      const t0 = performance.now();
      this.thermalCpuBench.transform(this.thermalCpuCtx, null, new Uint8Array(16));
      const current = performance.now() - t0;
      const degradation = (current - this.thermalBaseline) / this.thermalBaseline * 100;
      this.thermalHistory.push({
        t: Date.now(),
        ms: current,
        phase: "check",
        degradationPct: degradation
      });
      const status = { baselineMs: this.thermalBaseline, currentMs: current, degradationPct: degradation, throttled: degradation > 10 };
      this.config.onProgress({ phase: "thermal-check", ...status });
      return status;
    }
    // ---- Single benchmark ------------------------------------------------
    async benchSingle(benchmark, pixelCount, ioType = "rgb") {
      const { id, name, setup, transform } = benchmark;
      const res = this.config.resources;
      if (!res) {
        throw new Error("BenchEngine requires a resources pool (config.resources)");
      }
      const inputType = benchmark.inputType ?? ioType;
      const outputType = benchmark.outputType ?? ioType;
      const testData = res.getTestData(pixelCount);
      const input = inputType === "cmyk" ? testData.cmykIn.bin : testData.rgbIn.bin;
      this.config.onProgress({ phase: "setup", id, name, pixelCount });
      const setupT0 = performance.now();
      const sharedOutput = res.createOutputBuffer(outputType, pixelCount).bin;
      const context = await setup(input, sharedOutput);
      const setupMs = performance.now() - setupT0;
      this.config.onProgress({ phase: "cold", id, name, pixelCount });
      this.forceGC();
      const coldOutput = res.createOutputBuffer(outputType, pixelCount).bin;
      const coldT0 = performance.now();
      transform(context, input, coldOutput);
      const coldMs = performance.now() - coldT0;
      this.config.onProgress({ phase: "warmup", id, name, pixelCount, total: this.config.warmupRuns });
      const warmupChunk = 50;
      for (let w = 0; w < this.config.warmupRuns; w += warmupChunk) {
        const end = Math.min(this.config.warmupRuns, w + warmupChunk);
        for (let i = w; i < end; i++) {
          transform(context, input, sharedOutput);
        }
        await yieldToCompilation();
      }
      await yieldToCompilation();
      this.config.onProgress({ phase: "timed", id, name, pixelCount, total: this.config.timedBatches });
      const batchTimes = [];
      const timedRuns = this.config.timedRuns;
      const timedBatches = this.config.timedBatches;
      const runFn = context && typeof context.run === "function" ? context.run : null;
      if (benchmark.reuseOutput !== false) {
        if (runFn) {
          for (let b = 0; b < timedBatches; b++) {
            const t0 = performance.now();
            for (let i = 0; i < timedRuns; i++) {
              runFn();
            }
            batchTimes.push((performance.now() - t0) / timedRuns);
            await yieldToCompilation();
          }
        } else {
          for (let b = 0; b < timedBatches; b++) {
            const t0 = performance.now();
            for (let i = 0; i < timedRuns; i++) {
              transform(context, input, sharedOutput);
            }
            batchTimes.push((performance.now() - t0) / timedRuns);
            await yieldToCompilation();
          }
        }
      } else {
        for (let b = 0; b < timedBatches; b++) {
          const t0 = performance.now();
          for (let i = 0; i < timedRuns; i++) {
            const freshOut = res.createOutputBuffer(outputType, pixelCount).bin;
            transform(context, input, freshOut);
          }
          batchTimes.push((performance.now() - t0) / timedRuns);
          await yieldToCompilation();
        }
      }
      const checksumValue = this.checksum(sharedOutput);
      const sorted = [...batchTimes].sort((a, b) => a - b);
      const med = sorted[Math.floor(sorted.length / 2)];
      const inputChannels = inputType === "cmyk" ? 4 : 3;
      const outputChannels = outputType === "cmyk" ? 4 : 3;
      const bytesPerElement = benchmark.bytesPerElement ?? 1;
      const totalBytesPerPixel = (inputChannels + outputChannels) * bytesPerElement;
      const result = {
        id,
        name,
        pixelCount,
        inputType,
        outputType,
        metric: benchmark.metric ?? "mpx+mbps",
        checksum: checksumValue,
        setupMs,
        coldMs,
        hot: {
          minMs: sorted[0],
          medianMs: med,
          maxMs: sorted[sorted.length - 1],
          p95Ms: sorted[Math.floor(sorted.length * 0.95)],
          stdDev: stdDev(batchTimes),
          samples: batchTimes.length,
          // number of batches
          itersPerBatch: this.config.timedRuns
        },
        MPxPerSec: med > 0 ? pixelCount / med / 1e3 : 0,
        MBps: med > 0 ? pixelCount * totalBytesPerPixel / med / 1e3 : 0
      };
      if (this.config.isolateRuns) {
        this.forceGC();
        await sleep(this.config.isolationSleepMs);
      }
      this.config.onProgress({ phase: "complete", result });
      return result;
    }
    // ---- Run a list of benchmarks at all configured sizes ----------------
    async run(benchmarks, options = {}) {
      const ioType = options.ioType || "rgb";
      const results = [];
      let lastThermalCheck = Date.now();
      for (const bench of benchmarks) {
        for (const pixelCount of this.config.pixelCounts) {
          if (this.config.detectThermalThrottle && Date.now() - lastThermalCheck > this.config.thermalIntervalMs) {
            await this.checkThermalThrottle();
            lastThermalCheck = Date.now();
          }
          const result = await this.benchSingle(bench, pixelCount, ioType);
          results.push(result);
        }
      }
      return results;
    }
  };

  // samples/benchmark/benchmark-groups.js
  var BenchmarkGroup = class {
    constructor(config) {
      this.id = config.id;
      this.name = config.name;
      this.description = config.description || "";
      this.tags = config.tags || [];
      this.dependencies = config.dependencies || [];
      this.loader = config.loader;
      this.benchmarks = [];
      this.loaded = false;
    }
    register(benchmark) {
      if (!benchmark.id || !benchmark.name) {
        throw new Error("Benchmark requires id and name");
      }
      if (typeof benchmark.setup !== "function" || typeof benchmark.transform !== "function") {
        throw new Error(`Benchmark "${benchmark.id}" requires setup() and transform()`);
      }
      this.benchmarks.push(benchmark);
    }
    async load() {
      if (this.loaded) return;
      if (this.loader) await this.loader(this);
      this.loaded = true;
    }
    getAll() {
      return this.benchmarks.slice();
    }
    getById(id) {
      return this.benchmarks.find((b) => b.id === id);
    }
    getByTag(tag) {
      return this.benchmarks.filter((b) => b.tags?.includes(tag));
    }
  };
  var GroupRegistry = class {
    constructor() {
      this.groups = /* @__PURE__ */ new Map();
    }
    register(group) {
      this.groups.set(group.id, group);
    }
    get(id) {
      return this.groups.get(id);
    }
    has(id) {
      return this.groups.has(id);
    }
    list() {
      return [...this.groups.values()];
    }
    async loadGroup(id) {
      const group = this.groups.get(id);
      if (!group) throw new Error(`Group "${id}" not found`);
      for (const depId of group.dependencies) {
        await this.loadGroup(depId);
      }
      await group.load();
      return group;
    }
  };
  var groups = new GroupRegistry();

  // samples/benchmark/group-runner.js
  var GroupRunner = class {
    constructor(engine2) {
      this.engine = engine2;
    }
    async runGroups(groupIds, options = {}) {
      const runBaselineTwice = options.runBaselineTwice ?? true;
      const skipWarmup = options.skipWarmup ?? false;
      const out = {
        startedAt: (/* @__PURE__ */ new Date()).toISOString(),
        phases: [],
        byGroup: {},
        hardware: null,
        thermal: null
      };
      const baselineGroup2 = await groups.loadGroup("baseline");
      const baselineResults = await this.engine.run(baselineGroup2.getAll());
      out.byGroup["baseline"] = baselineResults;
      out.phases.push({ name: "baseline-initial", at: Date.now() });
      out.hardware = this._summarizeHardware(baselineResults);
      if (!skipWarmup) {
        const primesBench = baselineGroup2.getById("cpu-primes-js");
        await this.engine.warmupCPU(primesBench);
        out.phases.push({ name: "preheat", at: Date.now() });
      }
      for (const id of groupIds) {
        if (id === "baseline") continue;
        const g = await groups.loadGroup(id);
        const results = await this.engine.run(g.getAll());
        out.byGroup[id] = results;
        out.phases.push({ name: id, at: Date.now() });
      }
      if (runBaselineTwice) {
        const retestBenches = [
          baselineGroup2.getById("cpu-primes-js"),
          baselineGroup2.getById("mem-wasm-bulk")
        ].filter(Boolean);
        const retest = await this.engine.run(retestBenches);
        out.byGroup["baseline-retest"] = retest;
        out.phases.push({ name: "baseline-retest", at: Date.now() });
        out.thermal = this._compareBaselines(baselineResults, retest);
      }
      out.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
      return out;
    }
    _summarizeHardware(baselineResults) {
      const ref = 65536;
      const pick = (id) => {
        const candidates = baselineResults.filter((r) => r.id === id);
        return candidates.find((r) => r.pixelCount === ref) || candidates[0];
      };
      const wasmBulk = pick("mem-wasm-bulk");
      const jsSet = pick("mem-js-set");
      const cpuJs = pick("cpu-primes-js");
      return {
        wasmPeakMPx: wasmBulk ? wasmBulk.MPxPerSec : null,
        wasmPeakMBps: wasmBulk ? wasmBulk.pixelCount * 3 / wasmBulk.hot.medianMs / 1e3 : null,
        jsPeakMPx: jsSet ? jsSet.MPxPerSec : null,
        jsPeakMBps: jsSet ? jsSet.pixelCount * 3 / jsSet.hot.medianMs / 1e3 : null,
        cpuPrimesMs: cpuJs ? cpuJs.hot.medianMs : null
      };
    }
    _compareBaselines(initial, retest) {
      const pctDiff = (a, b) => a > 0 ? (b - a) / a * 100 : 0;
      const out = {};
      for (const r of retest) {
        const init = initial.find((x) => x.id === r.id && x.pixelCount === r.pixelCount);
        if (!init) continue;
        out[r.id] = {
          pixelCount: r.pixelCount,
          initialMs: init.hot.medianMs,
          retestMs: r.hot.medianMs,
          degradationPct: pctDiff(init.hot.medianMs, r.hot.medianMs)
        };
      }
      return out;
    }
    // Categorize a result vs hardware peak.
    static categorize(result, hardware) {
      if (!hardware || !hardware.wasmPeakMPx) return "Unknown";
      const pct = result.MPxPerSec / hardware.wasmPeakMPx * 100;
      if (pct > 50) return "Memory Bench";
      if (pct > 20) return "Balanced Memory + CPU Bench";
      if (pct > 5) return "CPU Bench";
      return "Needs Optimization";
    }
  };

  // samples/benchmark/bench-ui.js
  function fmtMs(ms) {
    if (!isFinite(ms) || ms < 0) return "\u2014";
    if (ms < 1) return ms.toFixed(3) + " ms";
    if (ms < 10) return ms.toFixed(2) + " ms";
    if (ms < 100) return ms.toFixed(1) + " ms";
    return ms.toFixed(0) + " ms";
  }
  function fmtMpx(n) {
    if (!isFinite(n) || n <= 0) return "\u2014";
    return n.toFixed(1);
  }
  function fmtMBps(n) {
    if (!isFinite(n) || n <= 0) return "\u2014";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + " GB/s";
    return n.toFixed(0) + " MB/s";
  }
  function fmtOps(n) {
    if (!isFinite(n) || n <= 0) return "\u2014";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k ops/s";
    return n.toFixed(1) + " ops/s";
  }
  function fmtPct(n) {
    const sign = n >= 0 ? "+" : "";
    return `${sign}${n.toFixed(1)}%`;
  }
  function el(tag, classes, text) {
    const element = document.createElement(tag);
    if (classes) element.className = classes;
    if (text !== void 0) element.textContent = text;
    return element;
  }
  function td(text, classes) {
    const cell = document.createElement("td");
    if (classes) cell.className = classes;
    cell.textContent = text ?? "\u2014";
    return cell;
  }
  async function detectSimd() {
    if (typeof WebAssembly !== "object") return false;
    const bytes = new Uint8Array([
      0,
      97,
      115,
      109,
      1,
      0,
      0,
      0,
      1,
      5,
      1,
      96,
      0,
      1,
      123,
      3,
      2,
      1,
      0,
      10,
      22,
      1,
      20,
      0,
      253,
      12,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      11
    ]);
    try {
      return WebAssembly.validate(bytes);
    } catch (_) {
      return false;
    }
  }
  function makeBar(fraction, colorClass) {
    const wrap = el("div", "bar-wrap");
    const fill = el("div", "bar-fill " + colorClass);
    fill.style.width = `${Math.min(100, fraction * 100).toFixed(1)}%`;
    wrap.appendChild(fill);
    return wrap;
  }
  function badgeClass(suffix) {
    if (suffix === "wasm-simd") return "b-simd";
    if (suffix === "wasm-scalar") return "b-scalar";
    return "b-js";
  }
  function barClass(suffix) {
    if (suffix === "wasm-simd") return "";
    if (suffix === "wasm-scalar") return "bar-scalar";
    return "bar-js";
  }
  var BenchUI = class {
    constructor() {
      this._hardware = null;
      this._totalBenches = 0;
      this._doneBenches = 0;
      this._dirFastest = {};
      this._pendingBars = [];
    }
    // ---- Lifecycle --------------------------------------------------------
    async init() {
      const jsce = window.jsColorEngine;
      this._setText("info-jsce", jsce?.version ? `v${jsce.version}` : "?");
      this._setVal(
        "info-wasm",
        typeof WebAssembly === "object" ? "available" : "NOT available",
        typeof WebAssembly === "object" ? "ok" : "err"
      );
      const simd = await detectSimd();
      this._setVal("info-simd", simd ? "available" : "NOT available", simd ? "ok" : "warn");
      this._setText("info-ua", navigator.userAgent.slice(0, 80));
      this._setText("info-cores", navigator.hardwareConcurrency ?? "?");
      this._setText("info-secure", isSecureContext ? "secure (https / localhost)" : "not secure");
    }
    reset() {
      this._hardware = null;
      this._totalBenches = 0;
      this._doneBenches = 0;
      this._dirFastest = {};
      this._pendingBars = [];
      this._setProgress(0, "Starting\u2026");
      this._clearTable("baseline-tbody");
      this._clearTable("transform-tbody");
      this._hide("hw-section");
      this._hide("results-section");
      this._hide("thermal-section");
      this._hide("error-banner");
      this._setText("error-banner", "");
    }
    showError(message) {
      this._show("error-banner");
      this._setText("error-banner", `Error: ${message}`);
    }
    // ---- BenchEngine event handler ----------------------------------------
    onProgress(e) {
      switch (e.phase) {
        case "setup":
          this._setProgress(
            this._doneBenches / Math.max(1, this._totalBenches),
            `${e.name}  @  ${e.pixelCount.toLocaleString()} px`
          );
          break;
        case "warmup":
          this._setProgress(
            (this._doneBenches + e.iteration / e.total) / Math.max(1, this._totalBenches),
            `warmup  ${e.name}`
          );
          break;
        case "timed":
          this._setProgress(
            (this._doneBenches + 0.8) / Math.max(1, this._totalBenches),
            `timing  ${e.name}`
          );
          break;
        case "complete":
          this._doneBenches++;
          this._setProgress(
            this._doneBenches / Math.max(1, this._totalBenches),
            `done  ${e.result.name}`
          );
          this._addResult(e.result);
          break;
        case "thermal-check":
          this._updateThermal(e);
          break;
      }
    }
    setHardware(hardware) {
      this._hardware = hardware;
      if (!hardware) return;
      const hw = hardware;
      this._setText("hw-js-mbps", hw.jsPeakMBps ? hw.jsPeakMBps.toFixed(0) : "?");
      this._setText("hw-js-mpx", hw.jsPeakMPx ? hw.jsPeakMPx.toFixed(0) : "?");
      this._setText("hw-wasm-mbps", hw.wasmPeakMBps ? hw.wasmPeakMBps.toFixed(0) : "?");
      this._setText("hw-wasm-mpx", hw.wasmPeakMPx ? hw.wasmPeakMPx.toFixed(0) : "?");
      this._setText("hw-cpu-ms", hw.cpuPrimesMs ? hw.cpuPrimesMs.toFixed(2) : "?");
      this._setText("hw-cpu-ops", hw.cpuPrimesMs ? (1e3 / hw.cpuPrimesMs).toFixed(0) : "?");
      this._show("hw-section");
      for (const { row, result } of this._pendingBars) {
        this._setRowCategory(row, result);
      }
      this._pendingBars = [];
    }
    printSummary(out) {
      this._setProgress(1, "Complete.");
      if (out.thermal) {
        const thermalTbody = document.getElementById("thermal-tbody");
        if (thermalTbody) {
          thermalTbody.innerHTML = "";
          for (const [id, t] of Object.entries(out.thermal)) {
            const row = thermalTbody.insertRow();
            row.insertCell().textContent = id;
            const pctCell = row.insertCell();
            pctCell.className = "num " + (t.degradationPct > 10 ? "thermal-bad" : t.degradationPct > 5 ? "thermal-warn" : "thermal-ok");
            pctCell.textContent = fmtPct(t.degradationPct);
            row.insertCell().textContent = fmtMs(t.retestMs);
          }
        }
        this._show("thermal-section");
      }
      this._show("results-section");
    }
    // ---- Internal: add result row -----------------------------------------
    _addResult(result) {
      const { metric, id } = result;
      if (metric === "none") return;
      if (id.startsWith("jsce-")) {
        this._addTransformRow(result);
      } else {
        this._addBaselineRow(result);
      }
    }
    _addBaselineRow(result) {
      const tbody = document.getElementById("baseline-tbody");
      if (!tbody) return;
      this._show("results-section");
      const row = tbody.insertRow();
      row.appendChild(td(result.name));
      if (result.metric === "ops") {
        const opsPerSec = result.hot.medianMs > 0 ? 1e3 / result.hot.medianMs : 0;
        row.appendChild(td(fmtMs(result.hot.medianMs), "num"));
        row.appendChild(td(fmtOps(opsPerSec), "num"));
        row.appendChild(td("\u2014", "num"));
        row.appendChild(td("\u2014", "num"));
        row.appendChild(td(""));
      } else {
        row.appendChild(td(fmtMs(result.hot.medianMs), "num"));
        row.appendChild(td(fmtMpx(result.MPxPerSec), "num"));
        row.appendChild(td(fmtMBps(result.MBps), "num"));
        const barCell = document.createElement("td");
        barCell.className = "bar-col";
        const fraction = result.MPxPerSec / 25e3;
        barCell.appendChild(makeBar(Math.min(fraction, 1), "b-mem"));
        row.appendChild(barCell);
      }
    }
    _addTransformRow(result) {
      const tbody = document.getElementById("transform-tbody");
      if (!tbody) return;
      this._show("results-section");
      const parts = result.id.replace("jsce-", "").match(/^(rgb-rgb|rgb-cmyk|cmyk-rgb|cmyk-cmyk)-(.+)$/);
      const dirId = parts ? parts[1] : result.id;
      const suffix = parts ? parts[2] : "";
      if (!this._lastDir || this._lastDir !== dirId) {
        this._lastDir = dirId;
        const sepRow = tbody.insertRow();
        sepRow.className = "dir-sep";
        const sepCell = sepRow.insertCell();
        sepCell.colSpan = 8;
        sepCell.className = "dir-label";
        sepCell.textContent = result.name.replace(/ \(.*\)$/, "");
      }
      const row = tbody.insertRow();
      const modeCell = row.insertCell();
      const badge = el("span", "mode-badge " + badgeClass(suffix), suffix);
      modeCell.appendChild(badge);
      row.appendChild(td(fmtMs(result.setupMs), "num"));
      row.appendChild(td(fmtMs(result.coldMs), "num"));
      row.appendChild(td(fmtMs(result.hot.medianMs), "num"));
      row.appendChild(td(fmtMpx(result.MPxPerSec), "num"));
      row.appendChild(td(fmtMBps(result.MBps), "num"));
      const pctCell = row.insertCell();
      pctCell.className = "num";
      row._pctCell = pctCell;
      row._result = result;
      const current = this._dirFastest[dirId] ?? 0;
      if (result.MPxPerSec > current) this._dirFastest[dirId] = result.MPxPerSec;
      const barCell = document.createElement("td");
      barCell.className = "bar-col";
      const bar = makeBar(result.MPxPerSec / Math.max(result.MPxPerSec, current, 1), barClass(suffix));
      barCell.appendChild(bar);
      row.appendChild(barCell);
      row._bar = bar.querySelector(".bar-fill");
      row._dirId = dirId;
      if (this._hardware) {
        this._setRowCategory(row, result);
      } else {
        this._pendingBars.push({ row, result });
      }
      this._refreshDirBars(dirId, tbody);
    }
    _setRowCategory(row, result) {
      if (!this._hardware || !row._pctCell) return;
      const pct = this._hardware.wasmPeakMPx ? result.MPxPerSec / this._hardware.wasmPeakMPx * 100 : null;
      row._pctCell.textContent = pct !== null ? pct.toFixed(1) + "%" : "\u2014";
    }
    _refreshDirBars(dirId, tbody) {
      const fastest = this._dirFastest[dirId] ?? 1;
      for (const row of tbody.rows) {
        if (row._dirId === dirId && row._bar && row._result) {
          row._bar.style.width = `${Math.min(100, row._result.MPxPerSec / fastest * 100).toFixed(1)}%`;
        }
      }
    }
    _updateThermal(e) {
      const el2 = document.getElementById("thermal-live");
      if (!el2) return;
      const cls = e.throttled ? "thermal-bad" : e.degradationPct > 5 ? "thermal-warn" : "thermal-ok";
      el2.className = cls;
      el2.textContent = `\u{1F321}\uFE0F  thermal: ${e.currentMs.toFixed(2)} ms (${fmtPct(e.degradationPct)})`;
    }
    // ---- DOM helpers ------------------------------------------------------
    _setText(id, text) {
      const e = document.getElementById(id);
      if (e) e.textContent = text;
    }
    _setVal(id, text, cls) {
      const e = document.getElementById(id);
      if (e) {
        e.textContent = text;
        e.className = "val " + (cls || "");
      }
    }
    _show(id) {
      const e = document.getElementById(id);
      if (e) e.hidden = false;
    }
    _hide(id) {
      const e = document.getElementById(id);
      if (e) e.hidden = true;
    }
    _clearTable(id) {
      const e = document.getElementById(id);
      if (e) e.innerHTML = "";
    }
    _setProgress(fraction, text) {
      const fill = document.getElementById("progress-fill");
      if (fill) fill.style.width = `${Math.min(100, fraction * 100).toFixed(1)}%`;
      const label = document.getElementById("progress-text");
      if (label) label.textContent = text ?? "";
    }
  };

  // samples/benchmark/loaders/webLoader.js
  var PROFILE_URLS = {
    AdobeRGB: "../profiles/AdobeRGB1998.icc",
    GRACoL: "../profiles/CoatedGRACoL2006.icc",
    ISOCoated: "../profiles/ISOcoated_v2_eci.icc"
  };
  var LCMS_DIST = "../../lcms-wasm-dist/";
  async function fetchBytes(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`fetch ${url}: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
  async function load() {
    const profileEntries = await Promise.all(
      Object.entries(PROFILE_URLS).map(async ([name, url]) => [name, await fetchBytes(url)])
    );
    const profiles = Object.fromEntries(profileEntries);
    const jsce = typeof window !== "undefined" && window.jsColorEngine || null;
    if (!jsce) throw new Error('jsColorEngine not on window \u2014 add <script src="../browser/jsColorEngineWeb.js"> before the bench');
    let lcms = null;
    try {
      const mod = await import(LCMS_DIST + "lcms.js");
      lcms = await mod.instantiate({ locateFile: (name) => LCMS_DIST + name });
    } catch (error) {
      console.warn("[webLoader] lcms-wasm unavailable:", error.message);
    }
    return { profiles, jsce, lcms };
  }

  // samples/benchmark/groups/baseline.js
  var WASM_MEMORY_COPY = new Uint8Array([
    // Magic + version
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    // Type section: (i32, i32, i32) -> ()
    1,
    7,
    1,
    96,
    3,
    127,
    127,
    127,
    0,
    // Function section: 1 function, type 0
    3,
    2,
    1,
    0,
    // Memory section: 1 memory, min=128 pages (8 MB). 128 in LEB128 = 0x80 0x01 (2 bytes) → section size 4.
    5,
    4,
    1,
    0,
    128,
    1,
    // Export section: "memory" (memory 0), "copy" (func 0)
    7,
    17,
    2,
    6,
    109,
    101,
    109,
    111,
    114,
    121,
    2,
    0,
    4,
    99,
    111,
    112,
    121,
    0,
    0,
    // Code section: 1 function body = 0 locals + local.get 0,1,2 + memory.copy + end (12 bytes)
    //   section size = count(1) + body_size_prefix(1) + body(12) = 14 = 0x0e
    //   body size = locals(1) + local.get×3(6) + memory.copy(4) + end(1) = 12 = 0x0c
    10,
    14,
    1,
    12,
    0,
    32,
    0,
    32,
    1,
    32,
    2,
    252,
    10,
    0,
    0,
    11
  ]);
  async function compileWasm(bytes) {
    const mod = await WebAssembly.compile(bytes);
    return WebAssembly.instantiate(mod, {});
  }
  var baselineGroup = new BenchmarkGroup({
    id: "baseline",
    name: "Hardware Baselines",
    description: "Overhead, memory bandwidth, and CPU compute baselines",
    tags: ["baseline", "required"],
    loader: async (group) => {
      group.register({
        id: "overhead-noop",
        name: "overhead-noop",
        tags: ["overhead"],
        metric: "none",
        // no data moved — MPx/s would be meaningless
        setup: (input, output) => ({}),
        transform: (ctx, input, output) => {
        }
      });
      group.register({
        id: "mem-js-set",
        name: "mem-js-set",
        tags: ["memory", "js"],
        metric: "mbps",
        setup: (input, output) => ({}),
        transform: (ctx, input, output) => {
          output.set(input);
        }
      });
      group.register({
        id: "mem-js-loop",
        name: "mem-js-loop",
        tags: ["memory", "js"],
        metric: "mbps",
        setup: (input, output) => ({}),
        transform: (ctx, input, output) => {
          const len = input.length;
          for (let i = 0; i < len; i++) output[i] = input[i];
        }
      });
      group.register({
        id: "mem-js-uint32",
        name: "mem-js-uint32",
        tags: ["memory", "js"],
        metric: "mbps",
        setup: (input, output) => {
          const len32 = Math.floor(input.length / 4);
          return {
            in32: new Uint32Array(input.buffer, input.byteOffset, len32),
            out32: new Uint32Array(output.buffer, output.byteOffset, len32),
            tailStart: len32 * 4
          };
        },
        transform: (ctx, input, output) => {
          ctx.out32.set(ctx.in32);
          for (let i = ctx.tailStart; i < input.length; i++) output[i] = input[i];
        }
      });
      group.register({
        id: "mem-wasm-bulk",
        name: "mem-wasm-bulk",
        tags: ["memory", "wasm", "peak"],
        metric: "mbps",
        setup: async (input) => {
          const inst = await compileWasm(WASM_MEMORY_COPY);
          const exports = (inst.instance || inst).exports;
          const neededBytes = input.length * 2;
          const currentBytes = exports.memory.buffer.byteLength;
          if (neededBytes > currentBytes) {
            const extraPages = Math.ceil((neededBytes - currentBytes) / 65536);
            exports.memory.grow(extraPages);
          }
          return { exports };
        },
        transform: (ctx, input, output) => {
          const mem = new Uint8Array(ctx.exports.memory.buffer);
          mem.set(input, 0);
          ctx.exports.copy(input.length, 0, input.length);
          output.set(mem.subarray(input.length, input.length * 2));
        }
      });
      group.register({
        id: "cpu-primes-js",
        name: "cpu-primes-js",
        tags: ["cpu", "js"],
        metric: "ops",
        // reports runs/sec (1 run = one sieve to 100K), not pixels
        setup: (input, output) => ({
          limit: 1e5,
          // small enough for sub-millisecond timing
          out: output || new Uint8Array(4)
        }),
        transform: (ctx) => {
          const sieve = new Uint8Array(ctx.limit);
          let count = 0;
          for (let i = 2; i < ctx.limit; i++) {
            if (sieve[i] === 0) {
              count++;
              for (let j = i + i; j < ctx.limit; j += i) sieve[j] = 1;
            }
          }
          ctx.out[0] = count & 255;
          ctx.out[1] = count >> 8 & 255;
        }
      });
    }
  });
  groups.register(baselineGroup);

  // samples/benchmark/groups/jsce.js
  var engine = null;
  var profileBytes = null;
  function setEngine(jsce, profiles) {
    engine = jsce;
    profileBytes = profiles;
  }
  var DIRECTIONS = [
    { id: "rgb-rgb", label: "sRGB \u2192 AdobeRGB", srcKey: "*srgb", dstKey: "AdobeRGB", inputType: "rgb", outputType: "rgb", inChannels: 3, outChannels: 3 },
    { id: "rgb-cmyk", label: "sRGB \u2192 GRACoL", srcKey: "*srgb", dstKey: "GRACoL", inputType: "rgb", outputType: "cmyk", inChannels: 3, outChannels: 4 },
    { id: "cmyk-rgb", label: "GRACoL \u2192 sRGB", srcKey: "GRACoL", dstKey: "*srgb", inputType: "cmyk", outputType: "rgb", inChannels: 4, outChannels: 3 },
    { id: "cmyk-cmyk", label: "GRACoL \u2192 ISOCoated", srcKey: "GRACoL", dstKey: "ISOCoated", inputType: "cmyk", outputType: "cmyk", inChannels: 4, outChannels: 4 }
  ];
  var VARIANTS = [
    {
      suffix: "wasm-simd",
      transformOptions: { buildLut: true, dataFormat: "int8", lutMode: "int-wasm-simd" }
    },
    {
      suffix: "wasm-scalar",
      transformOptions: { buildLut: true, dataFormat: "int8", lutMode: "int-wasm-scalar" }
    },
    {
      suffix: "js",
      transformOptions: { buildLut: true, dataFormat: "int8", lutMode: "int" }
    }
  ];
  function buildProfile(Profile, key) {
    const profile = new Profile();
    if (key.startsWith("*")) {
      profile.load(key);
    } else {
      const bytes = profileBytes[key];
      if (!bytes) throw new Error(`jsce: no profile bytes for "${key}"`);
      profile.loadBinary(bytes);
    }
    if (!profile.loaded) throw new Error(`jsce: profile "${key}" failed to load`);
    return profile;
  }
  function makeBenchmark(direction, variant, reuseOutput = true, callMode = "public-output") {
    const modeBits = [];
    if (callMode === "public-noargs") modeBits.push("oldstyle");
    if (!reuseOutput) modeBits.push("alloc");
    const modeTag = modeBits.length ? "-" + modeBits.join("-") : "";
    const modeSuffix = modeBits.length ? " (" + modeBits.join(", ") + ")" : "";
    return {
      id: `jsce-${direction.id}-${variant.suffix}${modeTag}`,
      name: `jsce ${direction.label} (${variant.suffix}${modeSuffix})`,
      tags: ["jsce", direction.id, variant.suffix, reuseOutput ? "reuse" : "alloc", callMode],
      inputType: direction.inputType,
      outputType: direction.outputType,
      metric: "mpx+mbps",
      reuseOutput,
      setup(input, output) {
        const { Profile, Transform, eIntent } = engine;
        const src = buildProfile(Profile, direction.srcKey);
        const dst = buildProfile(Profile, direction.dstKey);
        const xform = new Transform(variant.transformOptions);
        xform.create(src, dst, eIntent.relative);
        const pixelCount = Math.floor(input.length / direction.inChannels);
        const clampedOutput = reuseOutput && callMode === "public-output" ? new Uint8ClampedArray(output.buffer, output.byteOffset, output.length) : null;
        let run;
        if (callMode === "public-noargs") {
          run = function() {
            xform.transformArray(input);
          };
        } else if (reuseOutput) {
          run = function() {
            xform.transformArray(input, false, false, false, pixelCount, void 0, clampedOutput);
          };
        } else {
          run = null;
        }
        return { xform, run, clampedOutput, pixelCount, callMode, reuseOutput };
      },
      // Tight wrapper for alloc mode (called only when ctx.run is null).
      // Keeps the alloc-mode code path off the reuse-mode hot path.
      transform(ctx, input, output) {
        const out = new Uint8ClampedArray(output.buffer, output.byteOffset, output.length);
        ctx.xform.transformArray(input, false, false, false, ctx.pixelCount, void 0, out);
      }
    };
  }
  var jsceGroup = new BenchmarkGroup({
    id: "jsce",
    name: "jsColorEngine",
    description: "jsColorEngine LUT transform variants \u2014 4 directions \xD7 3 LUT modes",
    tags: ["jsce"],
    dependencies: ["baseline"],
    loader: async (group) => {
      if (!engine) {
        console.warn("[jsce group] no engine set \u2014 call setEngine() before runGroups()");
        return;
      }
      if (!profileBytes) {
        console.warn("[jsce group] no profile bytes \u2014 call setEngine(jsce, profiles)");
        return;
      }
      for (const direction of DIRECTIONS) {
        for (const variant of VARIANTS) {
          group.register(makeBenchmark(direction, variant, true, "public-output"));
        }
        for (const variant of VARIANTS) {
          group.register(makeBenchmark(direction, variant, false, "public-output"));
        }
        const simdVariant = VARIANTS[0];
        group.register(makeBenchmark(direction, simdVariant, true, "public-noargs"));
      }
    }
  });
  groups.register(jsceGroup);

  // samples/benchmark/groups/lcms.js
  var lcmsGroup = new BenchmarkGroup({
    id: "lcms",
    name: "LCMS Reference",
    description: "Little CMS WASM reference implementations",
    tags: ["reference", "lcms"],
    dependencies: ["baseline"],
    loader: async (group) => {
      console.warn("[lcms group] stub \u2014 no benchmarks registered yet");
    }
  });
  groups.register(lcmsGroup);

  // samples/benchmark/groups/v5-experimental.js
  var v5Group = new BenchmarkGroup({
    id: "v5-experimental",
    name: "V5 Matrix-Shaper POC",
    description: "Experimental V5 SIMD matrix-shaper (sRGB -> AdobeRGB)",
    tags: ["experimental", "v5"],
    dependencies: ["baseline"],
    loader: async (group) => {
      console.warn("[v5 group] stub \u2014 no benchmarks registered yet");
    }
  });
  groups.register(v5Group);

  // samples/benchmark/scenarios/jsce_rgb_rgb_wasm_simd.js
  function yieldRAF() {
    if (typeof requestAnimationFrame === "function") {
      return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    return new Promise((r) => setTimeout(r, 50));
  }
  async function measure_jsce_rgb_rgb_wasm_simd(jsce, pixelCount) {
    pixelCount = pixelCount ?? 65536;
    const xform = new jsce.Transform({
      buildLut: true,
      dataFormat: "int8",
      lutMode: "int-wasm-simd"
    });
    const setupT0 = performance.now();
    xform.create("*srgb", "*adobergb", jsce.eIntent.relative);
    const setupMs = performance.now() - setupT0;
    const input = new Uint8ClampedArray(pixelCount * 3);
    let seed = 324508639;
    for (let i = 0; i < input.length; i++) {
      seed = seed * 1103515245 + 12345 & 2147483647;
      input[i] = seed & 255;
    }
    const output = new Uint8ClampedArray(pixelCount * 3);
    const coldT0 = performance.now();
    xform.transformArray(input, false, false, false, pixelCount, void 0, output);
    const coldMs = performance.now() - coldT0;
    for (let w = 0; w < 200; w += 50) {
      for (let i = 0; i < 50; i++) {
        xform.transformArray(input, false, false, false, pixelCount, void 0, output);
      }
      await yieldRAF();
    }
    await yieldRAF();
    const samples = [];
    for (let b = 0; b < 5; b++) {
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) {
        xform.transformArray(input, false, false, false, pixelCount, void 0, output);
      }
      samples.push((performance.now() - t0) / 50);
      await yieldRAF();
    }
    samples.sort((a, b) => a - b);
    const medianMs = samples[2];
    const MPxPerSec = pixelCount / medianMs / 1e3;
    const MBps = MPxPerSec * 6;
    return {
      name: "jsce RGB \u2192 AdobeRGB (wasm-simd) [self-contained scenario]",
      pixelCount,
      setupMs,
      coldMs,
      samples,
      medianMs,
      MPxPerSec,
      MBps
    };
  }

  // samples/benchmark/browser-entry.js
  var BENCH_BUILD = "v0.6-scenario-test";
  document.addEventListener("DOMContentLoaded", async () => {
    console.log(
      `%c[bench] Bundle: ${BENCH_BUILD}%c \xB7 jsColorEngine: ${window.jsColorEngine?.version ?? "?"} \xB7 loaded ${(/* @__PURE__ */ new Date()).toISOString()}`,
      "background:#1a4d1a;color:#a3e635;padding:2px 6px;border-radius:3px;font-weight:600",
      "color:#888"
    );
    const buildEl = document.getElementById("info-bench-build");
    if (buildEl) buildEl.textContent = BENCH_BUILD;
    const ui = new BenchUI();
    await ui.init();
    const runBtn = document.getElementById("run-btn");
    const copyBtn = document.getElementById("copy-btn");
    let lastOutput = null;
    runBtn.addEventListener("click", async () => {
      const pixelSize = parseInt(document.getElementById("pixel-size").value);
      const warmupRuns = parseInt(document.getElementById("warmup-runs").value);
      const timedRuns = parseInt(document.getElementById("timed-runs").value);
      const timedBatches = parseInt(document.getElementById("timed-batches").value);
      const skipWarmup = document.getElementById("skip-warmup").checked;
      runBtn.disabled = true;
      if (copyBtn) copyBtn.disabled = true;
      ui.reset();
      try {
        const { profiles, jsce } = await load();
        document.getElementById("info-jsce").textContent = jsce?.version ? `v${jsce.version}` : "?";
        document.getElementById("info-profile").textContent = "loaded";
        console.log(
          "[bench] jsColorEngine version:",
          jsce?.version,
          "\xB7 source:",
          (jsce?.Transform?.toString?.() || "").slice(0, 100)
        );
        setEngine(jsce, profiles);
        resources.reset();
        await resources.initialize({ pixelCounts: [pixelSize] });
        const engine2 = new BenchEngine({
          pixelCounts: [pixelSize],
          warmupRuns,
          timedRuns,
          timedBatches,
          resources,
          onProgress: (e) => ui.onProgress(e)
        });
        const runner = new GroupRunner(engine2);
        const output = await runner.runGroups(["baseline", "jsce"], {
          skipWarmup,
          runBaselineTwice: true
        });
        lastOutput = output;
        ui.setHardware(output.hardware);
        ui.printSummary(output);
        if (copyBtn) copyBtn.disabled = false;
      } catch (err) {
        console.error("[bench]", err);
        ui.showError(err.message || String(err));
      } finally {
        runBtn.disabled = false;
      }
    });
    if (copyBtn) {
      copyBtn.addEventListener("click", () => {
        if (!lastOutput) return;
        const md = buildMarkdown(lastOutput);
        navigator.clipboard.writeText(md).then(() => {
          copyBtn.textContent = "Copied!";
          setTimeout(() => {
            copyBtn.textContent = "Copy markdown";
          }, 2e3);
        });
      });
    }
    const directBtn = document.getElementById("direct-btn");
    if (directBtn) {
      directBtn.addEventListener("click", () => runDirectKernelTest());
    }
    const scenarioBtn = document.getElementById("scenario-btn");
    if (scenarioBtn) {
      scenarioBtn.addEventListener("click", () => runScenarioTest());
    }
  });
  async function runScenarioTest() {
    const btn = document.getElementById("scenario-btn");
    const resultEl = document.getElementById("scenario-result");
    btn.disabled = true;
    resultEl.textContent = "running scenario...";
    try {
      const result = await measure_jsce_rgb_rgb_wasm_simd(window.jsColorEngine, 65536);
      resultEl.innerHTML = `<strong style="color:var(--accent-2)">Self-contained scenario:</strong> ${result.medianMs.toFixed(3)} ms/iter &nbsp;\xB7&nbsp; <strong>${result.MPxPerSec.toFixed(1)} MPx/s</strong> &nbsp;\xB7&nbsp; ${result.MBps.toFixed(0)} MB/s <span style="color:var(--text-muted)">(samples: ${result.samples.map((s) => s.toFixed(3)).join(", ")})</span>`;
    } catch (err) {
      console.error("[scenario-test]", err);
      resultEl.innerHTML = `<span style="color:var(--error)">Error: ${err.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }
  async function runDirectKernelTest() {
    const btn = document.getElementById("direct-btn");
    const statusEl = document.getElementById("direct-status");
    const resultEl = document.getElementById("direct-result");
    btn.disabled = true;
    statusEl.textContent = "preparing...";
    resultEl.textContent = "";
    try {
      const j = window.jsColorEngine;
      if (!j) throw new Error("window.jsColorEngine not loaded");
      const xform = new j.Transform({
        buildLut: true,
        dataFormat: "int8",
        lutMode: "int-wasm-simd"
      });
      xform.create("*srgb", "*adobergb", j.eIntent.relative);
      const pixelCount = 65536;
      const input = new Uint8ClampedArray(pixelCount * 3);
      let seed = 324508639;
      for (let i = 0; i < input.length; i++) {
        seed = seed * 1103515245 + 12345 & 2147483647;
        input[i] = seed & 255;
      }
      statusEl.textContent = "warmup (200 iters)...";
      const warmupChunk = 50;
      for (let w = 0; w < 200; w += warmupChunk) {
        for (let i = 0; i < warmupChunk; i++) xform.transformArray(input);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      statusEl.textContent = "timing (5\xD750 iters)...";
      const samples = [];
      for (let b = 0; b < 5; b++) {
        const t0 = performance.now();
        for (let i = 0; i < 50; i++) xform.transformArray(input);
        samples.push((performance.now() - t0) / 50);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }
      const sorted = samples.slice().sort((a, b) => a - b);
      const med = sorted[2];
      const min = sorted[0];
      const max = sorted[4];
      const mpx = pixelCount / med / 1e3;
      const mbps = mpx * 6;
      statusEl.textContent = "done";
      resultEl.innerHTML = `<strong style="color:var(--accent)">Direct kernel result:</strong> ${med.toFixed(3)} ms/iter &nbsp;\xB7&nbsp; <strong>${mpx.toFixed(1)} MPx/s</strong> &nbsp;\xB7&nbsp; ${mbps.toFixed(0)} MB/s <span style="color:var(--text-muted)">(min ${min.toFixed(3)}, max ${max.toFixed(3)} ms; samples: ${samples.map((s) => s.toFixed(3)).join(", ")})</span>`;
    } catch (err) {
      console.error("[direct-test]", err);
      statusEl.textContent = "error";
      resultEl.innerHTML = `<span style="color:var(--error)">Error: ${err.message}</span>`;
    } finally {
      btn.disabled = false;
    }
  }
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
      `|---|---|---|---|`
    ];
    for (const [, results] of Object.entries(output.byGroup)) {
      for (const result of results) {
        if (result.metric === "none" || result.metric === "ops") continue;
        lines.push(
          `| ${result.name} | ${result.hot.medianMs.toFixed(3)} | ${result.MPxPerSec.toFixed(1)} | ${result.MBps.toFixed(0)} |`
        );
      }
    }
    return lines.join("\n");
  }
})();
