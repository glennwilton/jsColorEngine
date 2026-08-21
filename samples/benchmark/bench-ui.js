// bench-ui.js
//
// Browser-side UI for the benchmark. Equivalent to console-ui.js but writes
// to DOM instead of stdout. Drives the engine info panel, progress bar, and
// results table. Subscribes to BenchEngine onProgress events.

import { GroupRunner } from './group-runner.js';

// ---- Formatting helpers ---------------------------------------------------

function fmtMs(ms) {
    if (!isFinite(ms) || ms < 0) return '—';
    if (ms < 1)   return ms.toFixed(3) + ' ms';
    if (ms < 10)  return ms.toFixed(2) + ' ms';
    if (ms < 100) return ms.toFixed(1) + ' ms';
    return ms.toFixed(0) + ' ms';
}

function fmtMpx(n) {
    if (!isFinite(n) || n <= 0) return '—';
    return n.toFixed(1);
}

function fmtMBps(n) {
    if (!isFinite(n) || n <= 0) return '—';
    if (n >= 1000) return (n / 1000).toFixed(1) + ' GB/s';
    return n.toFixed(0) + ' MB/s';
}

function fmtOps(n) {
    if (!isFinite(n) || n <= 0) return '—';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k ops/s';
    return n.toFixed(1) + ' ops/s';
}

function fmtPct(n) {
    const sign = n >= 0 ? '+' : '';
    return `${sign}${n.toFixed(1)}%`;
}

function el(tag, classes, text) {
    const element = document.createElement(tag);
    if (classes) element.className = classes;
    if (text !== undefined) element.textContent = text;
    return element;
}

function td(text, classes) {
    const cell = document.createElement('td');
    if (classes) cell.className = classes;
    cell.textContent = text ?? '—';
    return cell;
}

// ---- WASM SIMD detection --------------------------------------------------

async function detectSimd() {
    if (typeof WebAssembly !== 'object') return false;
    const bytes = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
        0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7b,
        0x03, 0x02, 0x01, 0x00,
        0x0a, 0x16, 0x01, 0x14, 0x00,
        0xfd, 0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0x0b,
    ]);
    try { return WebAssembly.validate(bytes); } catch (_) { return false; }
}

// ---- Bar helper -----------------------------------------------------------

function makeBar(fraction, colorClass) {
    const wrap = el('div', 'bar-wrap');
    const fill = el('div', 'bar-fill ' + colorClass);
    fill.style.width = `${Math.min(100, fraction * 100).toFixed(1)}%`;
    wrap.appendChild(fill);
    return wrap;
}

function badgeClass(suffix) {
    if (suffix === 'wasm-simd')   return 'b-simd';
    if (suffix === 'wasm-scalar') return 'b-scalar';
    return 'b-js';
}
function barClass(suffix) {
    if (suffix === 'wasm-simd')   return '';          // default accent
    if (suffix === 'wasm-scalar') return 'bar-scalar';
    return 'bar-js';
}

// ---- BenchUI --------------------------------------------------------------

export class BenchUI {
    constructor() {
        this._hardware     = null;
        this._totalBenches = 0;
        this._doneBenches  = 0;
        // Per-direction: track fastest MPx/s to normalise bars
        this._dirFastest   = {};
        // Pending rows that arrived before hardware was set — need bar update
        this._pendingBars  = [];
    }

    // ---- Lifecycle --------------------------------------------------------

    async init() {
        // Populate static engine info
        const jsce = window.jsColorEngine;
        this._setText('info-jsce', jsce?.version ? `v${jsce.version}` : '?');
        this._setVal('info-wasm', typeof WebAssembly === 'object' ? 'available' : 'NOT available',
            typeof WebAssembly === 'object' ? 'ok' : 'err');
        const simd = await detectSimd();
        this._setVal('info-simd', simd ? 'available' : 'NOT available', simd ? 'ok' : 'warn');
        this._setText('info-ua',    navigator.userAgent.slice(0, 80));
        this._setText('info-cores', navigator.hardwareConcurrency ?? '?');
        this._setText('info-secure', isSecureContext ? 'secure (https / localhost)' : 'not secure');
    }

    reset() {
        this._hardware     = null;
        this._totalBenches = 0;
        this._doneBenches  = 0;
        this._dirFastest   = {};
        this._pendingBars  = [];

        this._setProgress(0, 'Starting…');
        this._clearTable('baseline-tbody');
        this._clearTable('transform-tbody');
        this._hide('hw-section');
        this._hide('results-section');
        this._hide('thermal-section');
        this._hide('error-banner');
        this._setText('error-banner', '');
    }

    showError(message) {
        this._show('error-banner');
        this._setText('error-banner', `Error: ${message}`);
    }

    // ---- BenchEngine event handler ----------------------------------------

    onProgress(e) {
        switch (e.phase) {
            case 'setup':
                this._setProgress(
                    this._doneBenches / Math.max(1, this._totalBenches),
                    `${e.name}  @  ${e.pixelCount.toLocaleString()} px`
                );
                break;

            case 'warmup':
                this._setProgress(
                    (this._doneBenches + e.iteration / e.total) / Math.max(1, this._totalBenches),
                    `warmup  ${e.name}`
                );
                break;

            case 'timed':
                this._setProgress(
                    (this._doneBenches + 0.8) / Math.max(1, this._totalBenches),
                    `timing  ${e.name}`
                );
                break;

            case 'complete':
                this._doneBenches++;
                this._setProgress(
                    this._doneBenches / Math.max(1, this._totalBenches),
                    `done  ${e.result.name}`
                );
                this._addResult(e.result);
                break;

            case 'thermal-check':
                this._updateThermal(e);
                break;
        }
    }

    setHardware(hardware) {
        this._hardware = hardware;
        if (!hardware) return;

        const hw = hardware;
        this._setText('hw-js-mbps',    hw.jsPeakMBps   ? hw.jsPeakMBps.toFixed(0)   : '?');
        this._setText('hw-js-mpx',     hw.jsPeakMPx    ? hw.jsPeakMPx.toFixed(0)    : '?');
        this._setText('hw-wasm-mbps',  hw.wasmPeakMBps ? hw.wasmPeakMBps.toFixed(0) : '?');
        this._setText('hw-wasm-mpx',   hw.wasmPeakMPx  ? hw.wasmPeakMPx.toFixed(0)  : '?');
        this._setText('hw-cpu-ms',     hw.cpuPrimesMs  ? hw.cpuPrimesMs.toFixed(2)  : '?');
        this._setText('hw-cpu-ops',    hw.cpuPrimesMs  ? (1000 / hw.cpuPrimesMs).toFixed(0) : '?');
        this._show('hw-section');

        // Flush pending bars now that we have hardware
        for (const { row, result } of this._pendingBars) {
            this._setRowCategory(row, result);
        }
        this._pendingBars = [];
    }

    printSummary(out) {
        this._setProgress(1, 'Complete.');

        if (out.thermal) {
            const thermalTbody = document.getElementById('thermal-tbody');
            if (thermalTbody) {
                thermalTbody.innerHTML = '';
                for (const [id, t] of Object.entries(out.thermal)) {
                    const row = thermalTbody.insertRow();
                    row.insertCell().textContent = id;
                    const pctCell = row.insertCell();
                    pctCell.className = 'num ' + (
                        t.degradationPct > 10 ? 'thermal-bad' :
                        t.degradationPct > 5  ? 'thermal-warn' : 'thermal-ok'
                    );
                    pctCell.textContent = fmtPct(t.degradationPct);
                    row.insertCell().textContent = fmtMs(t.retestMs);
                }
            }
            this._show('thermal-section');
        }

        this._show('results-section');
    }

    // ---- Internal: add result row -----------------------------------------

    _addResult(result) {
        const { metric, id } = result;

        if (metric === 'none') return; // overhead-noop — skip

        if (id.startsWith('jsce-')) {
            this._addTransformRow(result);
        } else {
            this._addBaselineRow(result);
        }
    }

    _addBaselineRow(result) {
        const tbody = document.getElementById('baseline-tbody');
        if (!tbody) return;
        this._show('results-section');

        const row = tbody.insertRow();
        row.appendChild(td(result.name));

        if (result.metric === 'ops') {
            const opsPerSec = result.hot.medianMs > 0 ? 1000 / result.hot.medianMs : 0;
            row.appendChild(td(fmtMs(result.hot.medianMs), 'num'));
            row.appendChild(td(fmtOps(opsPerSec), 'num'));
            row.appendChild(td('—', 'num'));
            row.appendChild(td('—', 'num'));
            row.appendChild(td('')); // no bar
        } else {
            row.appendChild(td(fmtMs(result.hot.medianMs), 'num'));
            row.appendChild(td(fmtMpx(result.MPxPerSec), 'num'));
            row.appendChild(td(fmtMBps(result.MBps), 'num'));

            const barCell = document.createElement('td');
            barCell.className = 'bar-col';
            // Normalise bar against mem-js-set as the JS peak reference
            const fraction = result.MPxPerSec / 25000; // rough ceiling for bar
            barCell.appendChild(makeBar(Math.min(fraction, 1), 'b-mem'));
            row.appendChild(barCell);
        }
    }

    _addTransformRow(result) {
        const tbody = document.getElementById('transform-tbody');
        if (!tbody) return;
        this._show('results-section');

        // Extract direction + variant from benchmark id: jsce-{dir}-{variant}
        // e.g. jsce-rgb-rgb-wasm-simd → dir=rgb-rgb, variant=wasm-simd
        const parts    = result.id.replace('jsce-', '').match(/^(rgb-rgb|rgb-cmyk|cmyk-rgb|cmyk-cmyk)-(.+)$/);
        const dirId    = parts ? parts[1] : result.id;
        const suffix   = parts ? parts[2] : '';

        // Section separator when direction changes
        if (!this._lastDir || this._lastDir !== dirId) {
            this._lastDir = dirId;
            const sepRow = tbody.insertRow();
            sepRow.className = 'dir-sep';
            const sepCell = sepRow.insertCell();
            sepCell.colSpan = 8;
            sepCell.className = 'dir-label';
            sepCell.textContent = result.name.replace(/ \(.*\)$/, ''); // strip (variant)
        }

        const row = tbody.insertRow();

        // Mode badge
        const modeCell = row.insertCell();
        const badge = el('span', 'mode-badge ' + badgeClass(suffix), suffix);
        modeCell.appendChild(badge);

        row.appendChild(td(fmtMs(result.setupMs), 'num'));
        row.appendChild(td(fmtMs(result.coldMs), 'num'));
        row.appendChild(td(fmtMs(result.hot.medianMs), 'num'));
        row.appendChild(td(fmtMpx(result.MPxPerSec), 'num'));
        row.appendChild(td(fmtMBps(result.MBps), 'num'));

        // % of WASM peak — needs hardware, may be deferred
        const pctCell = row.insertCell();
        pctCell.className = 'num';
        row._pctCell = pctCell;
        row._result  = result;

        // Speed bar — normalised per direction, max tracked as results arrive
        const current = this._dirFastest[dirId] ?? 0;
        if (result.MPxPerSec > current) this._dirFastest[dirId] = result.MPxPerSec;
        const barCell = document.createElement('td');
        barCell.className = 'bar-col';
        const bar = makeBar(result.MPxPerSec / Math.max(result.MPxPerSec, current, 1), barClass(suffix));
        barCell.appendChild(bar);
        row.appendChild(barCell);
        row._bar   = bar.querySelector('.bar-fill');
        row._dirId = dirId;

        if (this._hardware) {
            this._setRowCategory(row, result);
        } else {
            this._pendingBars.push({ row, result });
        }

        // Update all bars in this direction now that we have a new max
        this._refreshDirBars(dirId, tbody);
    }

    _setRowCategory(row, result) {
        if (!this._hardware || !row._pctCell) return;
        const pct = this._hardware.wasmPeakMPx
            ? (result.MPxPerSec / this._hardware.wasmPeakMPx) * 100
            : null;
        row._pctCell.textContent = pct !== null ? pct.toFixed(1) + '%' : '—';
    }

    _refreshDirBars(dirId, tbody) {
        const fastest = this._dirFastest[dirId] ?? 1;
        for (const row of tbody.rows) {
            if (row._dirId === dirId && row._bar && row._result) {
                row._bar.style.width = `${Math.min(100, (row._result.MPxPerSec / fastest) * 100).toFixed(1)}%`;
            }
        }
    }

    _updateThermal(e) {
        const el = document.getElementById('thermal-live');
        if (!el) return;
        const cls = e.throttled ? 'thermal-bad' : e.degradationPct > 5 ? 'thermal-warn' : 'thermal-ok';
        el.className = cls;
        el.textContent = `🌡️  thermal: ${e.currentMs.toFixed(2)} ms (${fmtPct(e.degradationPct)})`;
    }

    // ---- DOM helpers ------------------------------------------------------

    _setText(id, text)         { const e = document.getElementById(id); if (e) e.textContent = text; }
    _setVal(id, text, cls)     { const e = document.getElementById(id); if (e) { e.textContent = text; e.className = 'val ' + (cls || ''); } }
    _show(id)                  { const e = document.getElementById(id); if (e) e.hidden = false; }
    _hide(id)                  { const e = document.getElementById(id); if (e) e.hidden = true; }
    _clearTable(id)            { const e = document.getElementById(id); if (e) e.innerHTML = ''; }

    _setProgress(fraction, text) {
        const fill = document.getElementById('progress-fill');
        if (fill) fill.style.width = `${Math.min(100, fraction * 100).toFixed(1)}%`;
        const label = document.getElementById('progress-text');
        if (label) label.textContent = text ?? '';
    }
}
