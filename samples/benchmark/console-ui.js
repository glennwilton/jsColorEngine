// console-ui.js
//
// Subscribes to BenchEngine progress events and prints readable output.
// Works in Node terminals and browser DevTools console.

import { GroupRunner } from './group-runner.js';

const COLORS = {
    reset:  '\x1b[0m',
    dim:    '\x1b[2m',
    cyan:   '\x1b[36m',
    green:  '\x1b[32m',
    yellow: '\x1b[33m',
    red:    '\x1b[31m',
    bold:   '\x1b[1m',
};

// ---- Formatters -----------------------------------------------------------

function fmtMs(ms) { return ms.toFixed(3).padStart(8) + ' ms'; }

function fmtMpx(n) { return n.toFixed(1).padStart(8) + ' MPx/s'; }

// Switches to GB/s automatically above 999 MB/s to keep column width stable.
function fmtMBps(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1).padStart(7)} GB/s`;
    return `${n.toFixed(0).padStart(7)} MB/s`;
}

function fmtOps(n) {
    if (n >= 1000) return `${(n / 1000).toFixed(1).padStart(7)}k ops/s`;
    return `${n.toFixed(1).padStart(7)}  ops/s`;
}

function fmtPct(n) {
    const s = (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
    return s.padStart(7);
}

// ---- ConsoleUI -----------------------------------------------------------

export class ConsoleUI {
    constructor(options = {}) {
        this.verbose  = options.verbose ?? true;
        this.hardware = null;
    }

    // Plug into BenchEngine config:
    //   onProgress: (e) => ui.onProgress(e)
    onProgress(e) {
        if (!this.verbose) return;

        switch (e.phase) {
            case 'thermal-warmup':
                console.log(`${COLORS.dim}  warming CPU...${COLORS.reset}`);
                break;

            case 'thermal-baseline':
                console.log(`${COLORS.dim}  thermal baseline: ${e.baselineMs.toFixed(2)} ms${COLORS.reset}`);
                break;

            case 'thermal-check': {
                const col = e.throttled ? COLORS.red : (e.degradationPct > 5 ? COLORS.yellow : COLORS.green);
                console.log(`${col}  🌡️  thermal: ${e.currentMs.toFixed(2)} ms (${fmtPct(e.degradationPct)})${COLORS.reset}`);
                break;
            }

            case 'setup':
                // Write partial line — result will be appended on 'complete'.
                process.stdout?.write?.(`  ${e.name.padEnd(34)} @${e.pixelCount.toLocaleString().padStart(11)} px  `);
                break;

            case 'complete':
                this._printResult(e.result);
                break;
        }
    }

    _printResult(r) {
        const med = r.hot.medianMs;

        switch (r.metric) {

            case 'none':
                // Overhead benchmark — just show the timing, no throughput column.
                writeLine(`${fmtMs(med)}`);
                break;

            case 'ops': {
                // CPU benchmark — report runs per second. Pixel count is irrelevant.
                const opsPerSec = med > 0 ? 1000 / med : 0;
                writeLine(`${fmtMs(med)}  ${fmtOps(opsPerSec)}`);
                break;
            }

            case 'mbps': {
                // Memory baseline — MPx/s + MB/s. No "% of peak" category
                // (these benchmarks ARE the peak references).
                writeLine(`${fmtMs(med)}  ${fmtMpx(r.MPxPerSec)}  ${fmtMBps(r.MBps)}`);
                break;
            }

            default:
            case 'mpx+mbps': {
                // Transform benchmark — MPx/s + MB/s + category vs hardware peak.
                const category = this.hardware
                    ? GroupRunner.categorize(r, this.hardware)
                    : '';
                const pctOfPeak = this.hardware?.wasmPeakMPx
                    ? `  (${((r.MPxPerSec / this.hardware.wasmPeakMPx) * 100).toFixed(1)}% of peak)`
                    : '';
                writeLine(`${fmtMs(med)}  ${fmtMpx(r.MPxPerSec)}  ${fmtMBps(r.MBps)}  ${category.padEnd(26)}${pctOfPeak}`);
                break;
            }
        }
    }

    // Called by main.js after run completes
    printSummary(out) {
        console.log('\n' + COLORS.bold + '=== Summary ===' + COLORS.reset);

        if (out.hardware) {
            const hw = out.hardware;
            console.log(`  hardware:`);
            console.log(`    js  peak: ${hw.jsPeakMBps?.toFixed(0)} MB/s  (${hw.jsPeakMPx?.toFixed(0)} MPx/s)`);
            console.log(`    wasm peak: ${hw.wasmPeakMBps?.toFixed(0)} MB/s  (${hw.wasmPeakMPx?.toFixed(0)} MPx/s)`);
            console.log(`    cpu primes: ${hw.cpuPrimesMs?.toFixed(2)} ms  (${hw.cpuPrimesMs > 0 ? (1000 / hw.cpuPrimesMs).toFixed(0) : '?'} ops/s)`);
        }

        if (out.thermal) {
            console.log(`  thermal validation:`);
            for (const [id, t] of Object.entries(out.thermal)) {
                const col = t.degradationPct > 10 ? COLORS.red
                    : t.degradationPct > 5  ? COLORS.yellow
                    : COLORS.green;
                console.log(`    ${col}${id}: ${fmtPct(t.degradationPct)}${COLORS.reset}`);
            }
        }

        // Best result per group (by MPx/s at largest configured size)
        console.log(`  best of group:`);
        for (const [gid, results] of Object.entries(out.byGroup)) {
            if (gid === 'baseline' || gid === 'baseline-retest') continue;
            const best = results.reduce((a, b) => (a && a.MPxPerSec > b.MPxPerSec ? a : b), null);
            if (best) {
                console.log(`    ${gid.padEnd(16)} ${best.name}  ${fmtMpx(best.MPxPerSec)} ${fmtMBps(best.MBps)} @${best.pixelCount.toLocaleString()} px`);
            }
        }
    }

    setHardware(hw) { this.hardware = hw; }
}

// ---- helpers ---------------------------------------------------------------

function writeLine(content) {
    if (process.stdout?.write) {
        process.stdout.write(content + '\n');
    } else {
        console.log(content);
    }
}
