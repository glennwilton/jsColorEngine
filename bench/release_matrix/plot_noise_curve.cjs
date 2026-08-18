/**
 * bench/release_matrix/plot_noise_curve.cjs
 * =========================================
 *
 * Turns a `--content noisy:N,...` run into an SVG chart.
 *
 * The point of the chart is the SHAPE, not the absolute values: how throughput
 * behaves as a real photograph is blended toward pure random noise, which is
 * the same thing as sweeping CLUT locality from "natural image" to "worst
 * case" while holding pixel count, buffer size and engine constant.
 *
 * Rendered as a file rather than inline markup because GitHub's markdown
 * sanitiser strips inline <svg>; a committed .svg referenced as an image
 * renders fine. Colours are chosen to read on both light and dark backgrounds
 * and the chart paints its own light card, so it does not vanish in dark mode.
 *
 * Usage:
 *   node run.js --isolate --sizes 1048576 \
 *        --content "noisy:0,noisy:1,noisy:2,noisy:5,noisy:10,noisy:20,noisy:50,noisy:100" > curve.txt
 *   node plot_noise_curve.cjs curve.txt "RGB -> Lab" ../../docs/deepdive/images/noise-curve.svg
 */
'use strict';

const fs = require('fs');
const path = require('path');

const [, , inFile, workflowWanted, outFile] = process.argv;
if (!inFile || !workflowWanted || !outFile) {
    console.error('usage: node plot_noise_curve.cjs <run-output.txt> "<workflow>" <out.svg>');
    process.exit(1);
}

// ---- parse the harness table -------------------------------------------

const lines = fs.readFileSync(inFile, 'utf8').split(/\r?\n/);
let inBlock = false, clut = '';
const points = [];

for (const line of lines) {
    const header = line.match(/^\s(\S.*?)\s{2,}CLUT\s+(\S+)\s+=\s+([\d,]+)\s+cells/);
    if (header) {
        inBlock = header[1].trim() === workflowWanted.trim();
        if (inBlock) clut = header[2] + ' = ' + header[3] + ' cells';
        continue;
    }
    if (!inBlock) continue;
    // noisy:20    0.0    546,690   15.2x    49.7   99.4   67.1   66.8   1.48x
    const m = line.match(/^\s+noisy:(\d+)\s+([\d.]+)\s+([\d,]+)\s+([\d.]+)x\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
    if (m) {
        points.push({
            noise: +m[1], adj: +m[2],
            distinct: +m[3].replace(/,/g, ''), cover: +m[4],
            int: +m[5], simd: +m[6], lcms: +m[7], lcmsnc: +m[8],
        });
    }
}
points.sort((a, b) => a.noise - b.noise);
if (points.length < 2) { console.error('no noisy: rows found for "' + workflowWanted + '"'); process.exit(1); }

// ---- geometry -----------------------------------------------------------

const W = 860, H = 470;
const M = { l: 62, r: 178, t: 54, b: 58 };
const plotW = W - M.l - M.r, plotH = H - M.t - M.b;

const series = [
    { key: 'simd',   label: 'jsCE WASM SIMD',    colour: '#2563eb' },
    { key: 'int',    label: 'jsCE int (pure JS)', colour: '#0891b2' },
    { key: 'lcmsnc', label: 'lcms-wasm NOCACHE',  colour: '#b45309' },
    { key: 'lcms',   label: 'lcms-wasm',          colour: '#dc2626' },
];

const maxY = Math.ceil(Math.max(...points.flatMap(p => series.map(s => p[s.key]))) / 20) * 20;
const x = n => M.l + (n / 100) * plotW;
const y = v => M.t + plotH - (v / maxY) * plotH;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const out = [];

out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">`);
out.push(`<rect width="${W}" height="${H}" fill="#ffffff" rx="6"/>`);
out.push(`<text x="${M.l}" y="26" font-size="15" font-weight="600" fill="#111827">Throughput as a photograph is blended toward random noise</text>`);
out.push(`<text x="${M.l}" y="44" font-size="11.5" fill="#6b7280">${esc(workflowWanted)} · ${esc(clut)} · 1 M px · one process per measurement · 0 % = untouched frame, 100 % = pure noise</text>`);

// gridlines + y axis
for (let v = 0; v <= maxY; v += 20) {
    out.push(`<line x1="${M.l}" y1="${y(v).toFixed(1)}" x2="${M.l + plotW}" y2="${y(v).toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`);
    out.push(`<text x="${M.l - 9}" y="${(y(v) + 4).toFixed(1)}" font-size="11" fill="#6b7280" text-anchor="end">${v}</text>`);
}
out.push(`<text x="16" y="${M.t + plotH / 2}" font-size="11.5" fill="#374151" text-anchor="middle" transform="rotate(-90 16 ${M.t + plotH / 2})">MPx/s</text>`);

// x axis
for (const n of [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
    out.push(`<line x1="${x(n).toFixed(1)}" y1="${M.t + plotH}" x2="${x(n).toFixed(1)}" y2="${M.t + plotH + 5}" stroke="#9ca3af" stroke-width="1"/>`);
    out.push(`<text x="${x(n).toFixed(1)}" y="${M.t + plotH + 19}" font-size="11" fill="#6b7280" text-anchor="middle">${n}</text>`);
}
out.push(`<text x="${M.l + plotW / 2}" y="${H - 12}" font-size="11.5" fill="#374151" text-anchor="middle">noise blended into the photograph (%)</text>`);
out.push(`<line x1="${M.l}" y1="${M.t + plotH}" x2="${M.l + plotW}" y2="${M.t + plotH}" stroke="#9ca3af" stroke-width="1.2"/>`);

// the knee: first point where the leading series has lost 90% of its total drop
const lead = points.map(p => p.simd);
const drop = lead[0] - Math.min(...lead);
let knee = null;
if (drop > 0) {
    for (const p of points) { if ((lead[0] - p.simd) >= drop * 0.9) { knee = p; break; } }
}
if (knee && knee.noise > 0) {
    out.push(`<line x1="${x(knee.noise).toFixed(1)}" y1="${M.t}" x2="${x(knee.noise).toFixed(1)}" y2="${M.t + plotH}" stroke="#9ca3af" stroke-width="1" stroke-dasharray="4 3"/>`);
    out.push(`<text x="${(x(knee.noise) + 6).toFixed(1)}" y="${M.t + 14}" font-size="10.5" fill="#6b7280">knee ≈ ${knee.noise} % noise</text>`);
    out.push(`<text x="${(x(knee.noise) + 6).toFixed(1)}" y="${M.t + 28}" font-size="10.5" fill="#9ca3af">${knee.distinct.toLocaleString()} colours · cover ${knee.cover}×</text>`);
}

// series
for (const s of series) {
    const d = points.map((p, i) => (i ? 'L' : 'M') + x(p.noise).toFixed(1) + ' ' + y(p[s.key]).toFixed(1)).join(' ');
    out.push(`<path d="${d}" fill="none" stroke="${s.colour}" stroke-width="2.2" stroke-linejoin="round"/>`);
    for (const p of points) {
        out.push(`<circle cx="${x(p.noise).toFixed(1)}" cy="${y(p[s.key]).toFixed(1)}" r="2.8" fill="${s.colour}"/>`);
    }
}

// legend, with the 0% -> 100% delta per series
let ly = M.t + 6;
for (const s of series) {
    const a = points[0][s.key], b = points[points.length - 1][s.key];
    const pct = (((b - a) / a) * 100).toFixed(0);
    out.push(`<line x1="${M.l + plotW + 16}" y1="${ly}" x2="${M.l + plotW + 40}" y2="${ly}" stroke="${s.colour}" stroke-width="2.4"/>`);
    out.push(`<text x="${M.l + plotW + 46}" y="${ly + 4}" font-size="11" fill="#111827">${esc(s.label)}</text>`);
    out.push(`<text x="${M.l + plotW + 46}" y="${ly + 18}" font-size="10.5" fill="#6b7280">${a.toFixed(1)} → ${b.toFixed(1)}  (${pct}%)</text>`);
    ly += 40;
}

out.push('</svg>');

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, out.join('\n'));
console.log('wrote ' + outFile + '  (' + points.length + ' points, ' + workflowWanted + ')');
