/**
 * bench/release_matrix/plot_noise_bases.cjs
 * =========================================
 *
 * Plots several `noisy:<base>:N` sweeps on one chart, so the convergence is
 * visible: three very different starting contents, all blended toward the same
 * noise buffer, all landing on the same plateau.
 *
 * That convergence is the point. `solid`, `gradient` and `photo` disagree
 * wildly at 0 % noise — 182, 183 and 119 MPx/s — and agree to within a few per
 * cent once 2 % noise is added. The spread between content types is therefore
 * mostly an artifact of unrealistically clean input, not a property of the
 * engines, and any benchmark quoting one clean synthetic row is reporting its
 * generator rather than its transform.
 *
 * Usage:
 *   node plot_noise_bases.cjs <out.svg> "<workflow>" photo=curve_photo.txt gradient=curve_gradient.txt solid=curve_solid.txt
 */
'use strict';

const fs = require('fs');
const path = require('path');

const [, , outFile, workflowWanted, ...pairs] = process.argv;
if (!outFile || !workflowWanted || !pairs.length) {
    console.error('usage: node plot_noise_bases.cjs <out.svg> "<workflow>" <base>=<file> ...');
    process.exit(1);
}

function parse(file, workflow) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let inBlock = false;
    const pts = [];
    for (const line of lines) {
        const header = line.match(/^\s(\S.*?)\s{2,}CLUT\s/);
        if (header) { inBlock = header[1].trim() === workflow.trim(); continue; }
        if (!inBlock) continue;
        const m = line.match(/^\s+noisy:(?:\w+:)?(\d+)\s+([\d.]+)\s+([\d,]+)\s+([\d.]+)x\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
        if (m) pts.push({
            noise: +m[1], adj: +m[2], distinct: +m[3].replace(/,/g, ''),
            int: +m[5], simd: +m[6], lcms: +m[7], lcmsnc: +m[8],
        });
    }
    return pts.sort((a, b) => a.noise - b.noise);
}

const BASE_COLOUR = { solid: '#dc2626', gradient: '#d97706', photo: '#2563eb', blocks16: '#7c3aed', sweep: '#059669' };
const sets = pairs.map(p => {
    const [base, file] = p.split('=');
    return { base, points: parse(file, workflowWanted), colour: BASE_COLOUR[base] || '#374151' };
}).filter(s => s.points.length > 1);

if (!sets.length) { console.error('no data parsed'); process.exit(1); }

const W = 900, H = 520;
const M = { l: 64, r: 196, t: 58, b: 78 };
const plotW = W - M.l - M.r, plotH = H - M.t - M.b;
const maxY = Math.ceil(Math.max(...sets.flatMap(s => s.points.flatMap(p => [p.simd, p.lcms]))) / 20) * 20;

// sqrt x-scale: everything interesting happens below 10 % noise, and a linear
// axis compresses it into the left margin where it cannot be read.
const x = n => M.l + Math.sqrt(n / 100) * plotW;
const y = v => M.t + plotH - (v / maxY) * plotH;
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const o = [];
o.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">`);
o.push(`<rect width="${W}" height="${H}" fill="#ffffff" rx="6"/>`);
o.push(`<text x="${M.l}" y="26" font-size="15" font-weight="600" fill="#111827">Three starting contents, blended toward the same noise — all converge</text>`);
o.push(`<text x="${M.l}" y="45" font-size="11.5" fill="#6b7280">${esc(workflowWanted)} · 1 M px · solid = jsCE WASM SIMD, dashed = lcms-wasm · √ x-axis, the action is below 10 %</text>`);

for (let v = 0; v <= maxY; v += 20) {
    o.push(`<line x1="${M.l}" y1="${y(v).toFixed(1)}" x2="${M.l + plotW}" y2="${y(v).toFixed(1)}" stroke="#e5e7eb"/>`);
    o.push(`<text x="${M.l - 9}" y="${(y(v) + 4).toFixed(1)}" font-size="11" fill="#6b7280" text-anchor="end">${v}</text>`);
}
o.push(`<text x="17" y="${M.t + plotH / 2}" font-size="11.5" fill="#374151" text-anchor="middle" transform="rotate(-90 17 ${M.t + plotH / 2})">MPx/s</text>`);

for (const n of [0, 1, 2, 5, 10, 20, 50, 100]) {
    o.push(`<line x1="${x(n).toFixed(1)}" y1="${M.t + plotH}" x2="${x(n).toFixed(1)}" y2="${M.t + plotH + 5}" stroke="#9ca3af"/>`);
    o.push(`<text x="${x(n).toFixed(1)}" y="${M.t + plotH + 19}" font-size="11" fill="#6b7280" text-anchor="middle">${n}</text>`);
}
o.push(`<text x="${M.l + plotW / 2}" y="${H - 30}" font-size="11.5" fill="#374151" text-anchor="middle">noise blended in (%)</text>`);
o.push(`<line x1="${M.l}" y1="${M.t + plotH}" x2="${M.l + plotW}" y2="${M.t + plotH}" stroke="#9ca3af" stroke-width="1.2"/>`);

// the convergence band: min..max of every series from 5% noise onward
const tail = sets.flatMap(s => s.points.filter(p => p.noise >= 5).map(p => p.simd));
if (tail.length) {
    const lo = Math.min(...tail), hi = Math.max(...tail);
    o.push(`<rect x="${x(2).toFixed(1)}" y="${y(hi).toFixed(1)}" width="${(x(100) - x(2)).toFixed(1)}" height="${(y(lo) - y(hi)).toFixed(1)}" fill="#2563eb" opacity="0.07"/>`);
    o.push(`<text x="${x(30).toFixed(1)}" y="${(y(hi) - 7).toFixed(1)}" font-size="10.5" fill="#6b7280" text-anchor="middle">all bases agree within ${(((hi - lo) / lo) * 100).toFixed(0)} % beyond 5 % noise</text>`);
}

for (const s of sets) {
    for (const [key, dash, wid] of [['simd', '', 2.4], ['lcms', '5 4', 1.8]]) {
        const d = s.points.map((p, i) => (i ? 'L' : 'M') + x(p.noise).toFixed(1) + ' ' + y(p[key]).toFixed(1)).join(' ');
        o.push(`<path d="${d}" fill="none" stroke="${s.colour}" stroke-width="${wid}"${dash ? ` stroke-dasharray="${dash}"` : ''} stroke-linejoin="round"/>`);
        for (const p of s.points) o.push(`<circle cx="${x(p.noise).toFixed(1)}" cy="${y(p[key]).toFixed(1)}" r="2.6" fill="${s.colour}"/>`);
    }
}

let ly = M.t + 8;
for (const s of sets) {
    const a = s.points[0], b = s.points[s.points.length - 1];
    o.push(`<line x1="${M.l + plotW + 16}" y1="${ly}" x2="${M.l + plotW + 40}" y2="${ly}" stroke="${s.colour}" stroke-width="2.6"/>`);
    o.push(`<text x="${M.l + plotW + 46}" y="${ly + 4}" font-size="11.5" fill="#111827" font-weight="500">from ${esc(s.base)}</text>`);
    o.push(`<text x="${M.l + plotW + 46}" y="${ly + 19}" font-size="10.5" fill="#6b7280">SIMD ${a.simd.toFixed(0)} → ${b.simd.toFixed(0)}</text>`);
    o.push(`<text x="${M.l + plotW + 46}" y="${ly + 33}" font-size="10.5" fill="#9ca3af">lcms ${a.lcms.toFixed(0)} → ${b.lcms.toFixed(0)}</text>`);
    ly += 52;
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, o.join('\n'));
console.log('wrote ' + outFile + ' (' + sets.map(s => s.base + ':' + s.points.length).join(', ') + ')');
