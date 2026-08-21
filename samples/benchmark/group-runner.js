// group-runner.js
//
// Orchestrates running multiple groups in order, with the baseline group
// running both first (establish hardware capability) and last (detect
// thermal degradation).

import { groups } from './benchmark-groups.js';

export class GroupRunner {
    constructor(engine) {
        this.engine = engine;
    }

    async runGroups(groupIds, options = {}) {
        const runBaselineTwice = options.runBaselineTwice ?? true;
        const skipWarmup       = options.skipWarmup       ?? false;

        const out = {
            startedAt: new Date().toISOString(),
            phases:    [],
            byGroup:   {},
            hardware:  null,
            thermal:   null,
        };

        // ---- Phase 1: baseline first ----
        const baselineGroup = await groups.loadGroup('baseline');
        const baselineResults = await this.engine.run(baselineGroup.getAll());
        out.byGroup['baseline'] = baselineResults;
        out.phases.push({ name: 'baseline-initial', at: Date.now() });
        out.hardware = this._summarizeHardware(baselineResults);

        // ---- Phase 2: optional CPU preheat ----
        if (!skipWarmup) {
            const primesBench = baselineGroup.getById('cpu-primes-js');
            await this.engine.warmupCPU(primesBench);
            out.phases.push({ name: 'preheat', at: Date.now() });
        }

        // ---- Phase 3+: requested groups ----
        for (const id of groupIds) {
            if (id === 'baseline') continue;
            const g = await groups.loadGroup(id);
            const results = await this.engine.run(g.getAll());
            out.byGroup[id] = results;
            out.phases.push({ name: id, at: Date.now() });
        }

        // ---- Final: re-run baseline subset for thermal validation ----
        if (runBaselineTwice) {
            const retestBenches = [
                baselineGroup.getById('cpu-primes-js'),
                baselineGroup.getById('mem-wasm-bulk'),
            ].filter(Boolean);

            const retest = await this.engine.run(retestBenches);
            out.byGroup['baseline-retest'] = retest;
            out.phases.push({ name: 'baseline-retest', at: Date.now() });
            out.thermal = this._compareBaselines(baselineResults, retest);
        }

        out.finishedAt = new Date().toISOString();
        return out;
    }

    _summarizeHardware(baselineResults) {
        // Use 65K as reference size if available, otherwise pick smallest
        const ref = 65_536;
        const pick = (id) => {
            const candidates = baselineResults.filter((r) => r.id === id);
            return candidates.find((r) => r.pixelCount === ref) || candidates[0];
        };

        const wasmBulk = pick('mem-wasm-bulk');
        const jsSet    = pick('mem-js-set');
        const cpuJs    = pick('cpu-primes-js');

        return {
            wasmPeakMPx:  wasmBulk ? wasmBulk.MPxPerSec : null,
            wasmPeakMBps: wasmBulk ? (wasmBulk.pixelCount * 3 / wasmBulk.hot.medianMs / 1000) : null,
            jsPeakMPx:    jsSet ? jsSet.MPxPerSec : null,
            jsPeakMBps:   jsSet ? (jsSet.pixelCount * 3 / jsSet.hot.medianMs / 1000) : null,
            cpuPrimesMs:  cpuJs ? cpuJs.hot.medianMs : null,
        };
    }

    _compareBaselines(initial, retest) {
        const pctDiff = (a, b) => a > 0 ? ((b - a) / a) * 100 : 0;
        const out = {};
        for (const r of retest) {
            const init = initial.find((x) => x.id === r.id && x.pixelCount === r.pixelCount);
            if (!init) continue;
            out[r.id] = {
                pixelCount: r.pixelCount,
                initialMs:  init.hot.medianMs,
                retestMs:   r.hot.medianMs,
                degradationPct: pctDiff(init.hot.medianMs, r.hot.medianMs),
            };
        }
        return out;
    }

    // Categorize a result vs hardware peak.
    static categorize(result, hardware) {
        if (!hardware || !hardware.wasmPeakMPx) return 'Unknown';
        const pct = (result.MPxPerSec / hardware.wasmPeakMPx) * 100;
        if (pct > 50) return 'Memory Bench';
        if (pct > 20) return 'Balanced Memory + CPU Bench';
        if (pct > 5)  return 'CPU Bench';
        return 'Needs Optimization';
    }
}