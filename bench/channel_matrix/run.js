#!/usr/bin/env node
/* ============================================================================
 *  bench/channel_matrix/run.js — throughput for every input width into every
 *  output width, 1 to 15.
 * ----------------------------------------------------------------------------
 *  Released under the MIT License
 *  Copyright (c) 2026 Glenn Wilton, O2 Creative Limited.
 *
 *  WHAT THIS IS, AND WHAT IT IS NOT.
 *
 *  Not a gate. The interesting numbers in this engine are 3- and 4-channel
 *  input: that is where images are, where the WASM kernels are, and where the
 *  pinned baseline lives. Everything else is a correctness path -- N-channel
 *  press work is proofing and measurement, not throughput -- and the honest
 *  question here is "how slow is the correctness path", not "did it regress".
 *
 *  So this is a map. It shows where the cliffs are, which is worth knowing
 *  before anyone optimises the wrong thing.
 *
 *  THE THREE REGIMES IT MAKES VISIBLE:
 *
 *    1-4 in   a CLUT is built and a tuned array loop runs it. Tens to
 *             hundreds of MPx/s. WASM applies at 3 and 4.
 *    5-6 in   Kernel5D / Kernel6D now bake at the profile A2B density
 *             (9^5 / 7^6) and run int8 WASM scalar. See bench/nch_56/run.js.
 *    7-15 in  KernelND declines the LUT -- an N-D CLUT bake is grid^N cells --
 *             so the generic per-pixel pipeline walk runs instead. ~1 MPx/s,
 *             and the interpolator is most of it.
 *    any out  wide output costs linearly: more channels written per pixel,
 *             and above 4 output channels the specialised runs give way to
 *             the generic _NCh ones.
 *
 *  Profiles: __tests__/profiles/synthetic_NNch.icc, each carrying both an A2B
 *  and a B2A, so one file per width covers both sides of every pair. Generate
 *  with `node scripts/make_test_profiles.js`.
 *
 *  Usage:
 *    node bench/channel_matrix/run.js
 *    node bench/channel_matrix/run.js --px 50000 --format int16
 * ============================================================================
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const Profile = require('../../src/Profile');
const { Transform, eIntent } = require('../../src/main');
const KernelND = require('../../src/kernels/nd/KernelND.js');

const arg = (name, fallback) => {
    const i = process.argv.indexOf('--' + name);
    return (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'))
        ? process.argv[i + 1] : fallback;
};

const PX      = parseInt(arg('px', '20000'), 10);
const FORMAT  = arg('format', 'int8');
const REPS    = 3;
const WIDTHS  = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
const DIR     = path.join(__dirname, '..', '..', '__tests__', 'profiles');

// ---------------------------------------------------------------------------

const profiles = {};
for(const n of WIDTHS){
    const file = path.join(DIR, 'synthetic_' + String(n).padStart(2, '0') + 'ch.icc');
    if(!fs.existsSync(file)){
        console.error('  missing ' + path.basename(file)
            + ' — run: node scripts/make_test_profiles.js');
        process.exit(1);
    }
    const p = new Profile();
    p.loadBinary(new Uint8Array(fs.readFileSync(file)));
    profiles[n] = p;
}

const u16 = (FORMAT === 'int16');

function input(channels, px){
    px = px || PX;
    const buf = u16 ? new Uint16Array(px * channels) : new Uint8ClampedArray(px * channels);
    let seed = 0x9E3779B9;
    for(let i = 0; i < buf.length; i++){
        seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
        buf[i] = u16 ? (seed & 0xffff) : (seed & 0xff);
    }
    return buf;
}

/**
 * Best-of, not mean: the floor is the measurement, everything above it is
 * interference.
 *
 * ADAPTIVE PIXEL COUNT. The slow end of this matrix is four orders of
 * magnitude below the fast end -- 15-channel input is ~0.03 MPx/s against
 * ~100 for RGB -- so one fixed count either takes minutes on the slow rows or
 * measures nothing on the fast ones. Probe cheaply, then pick a count that
 * lands each measurement near 30ms.
 */
function measure(inCh, outCh){
    const t = new Transform({ dataFormat: FORMAT, buildLut: true });
    t.create(profiles[inCh], profiles[outCh], eIntent.relative);
    const kernel = t.kernelInfo().name;

    const probeN = 256;
    const probe = input(inCh, probeN);
    t.transformArray(probe, false, false, false, probeN);
    const p0 = process.hrtime.bigint();
    t.transformArray(probe, false, false, false, probeN);
    const probeMs = Math.max(0.001, Number(process.hrtime.bigint() - p0) / 1e6);

    const want = Math.round(probeN * (30 / probeMs));
    const n = Math.max(256, Math.min(PX, want));

    const inp = input(inCh, n);
    t.transformArray(inp, false, false, false, n);       // warm at size
    let best = Infinity;
    for(let r = 0; r < REPS; r++){
        const t0 = process.hrtime.bigint();
        t.transformArray(inp, false, false, false, n);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        if(ms < best) best = ms;
    }
    return { mpxs: (n / 1e6) / (best / 1000), kernel, lut: !!t.lut, mode: t.lutMode, px: n };
}

// ---------------------------------------------------------------------------

console.log('');
console.log('============================================================================');
console.log(' CHANNEL MATRIX — MPx/s, every input width into every output width');
console.log('============================================================================');
console.log(' pixels   : ' + PX.toLocaleString() + ' per measurement, best of ' + REPS);
console.log(' format   : ' + FORMAT);
console.log(' node     : ' + process.version + '   platform: ' + process.platform + ' ' + process.arch);
console.log(' profiles : synthetic, both tables per file (see docs/deepdive/SyntheticProfiles.md)');
console.log(' ND interp: ' + KernelND.ndInterpolator
    + '   (ND_INTERPOLATOR in src/kernels/nd/KernelND.js)');
console.log('');
console.log(' NOT A GATE. 3- and 4-channel input is where the throughput work is; the');
console.log(' rest is a correctness path and this measures how slow it is, not whether');
console.log(' it regressed.');
console.log('');

const cells = {};
const started = Date.now();

let header = '  in\\out ';
for(const o of WIDTHS) header += String(o).padStart(7);
console.log(header);
console.log('  ' + '-'.repeat(header.length - 2));

for(const i of WIDTHS){
    let row = '  ' + String(i).padStart(5) + '  ';
    for(const o of WIDTHS){
        try {
            const r = measure(i, o);
            cells[i + 'x' + o] = r;
            row += (r.mpxs >= 100 ? r.mpxs.toFixed(0) : r.mpxs.toFixed(1)).padStart(7);
        } catch(e){
            cells[i + 'x' + o] = { error: String(e).slice(0, 60) };
            row += '   ERR ';
        }
    }
    // Label from an OFF-DIAGONAL cell: profile n into profile n is the same
    // profile twice, which collapses to identity and says nothing about the
    // kernel that owns the dimension.
    const k = cells[i + 'x' + (i === 1 ? 2 : 1)];
    console.log(row + '   ' + (k && k.kernel ? k.kernel : ''));
}

console.log('');

// ---- what the shape says ---------------------------------------------------

const off = i => cells[i + 'x' + (i === 1 ? 2 : 1)];
const withLut    = WIDTHS.filter(i => off(i) && off(i).lut);
const withoutLut = WIDTHS.filter(i => off(i) && !off(i).lut);

// THE DIAGONAL IS EXCLUDED, and deliberately. Profile n into profile n is the
// same profile twice: the chain collapses, kernelIdentity takes it, and it
// runs at memcpy speed. That is correct and it is not what this measures --
// left in the grid because seeing identity detection fire is worth something,
// kept out of the means because it would swamp them.
const rowMean = i => {
    const vs = WIDTHS.filter(o => o !== i)
        .map(o => cells[i + 'x' + o]).filter(c => c && c.mpxs).map(c => c.mpxs);
    return vs.reduce((a, b) => a + b, 0) / vs.length;
};

console.log('  The DIAGONAL is identity: profile n into profile n is the same profile');
console.log('  twice, so the chain collapses and kernelIdentity copies. Shown because');
console.log('  seeing that fire is worth something; excluded from the means below.');
console.log('');
console.log('  input widths that build a CLUT      : ' + withLut.join(', '));
console.log('  input widths on the per-pixel walk  : ' + withoutLut.join(', '));
console.log('');
console.log('  mean MPx/s by input width (diagonal excluded)');
for(const i of WIDTHS){
    const m = rowMean(i);
    const bar = '#'.repeat(Math.max(1, Math.min(52, Math.round((Math.log10(Math.max(m, 0.01)) + 2) * 13))));
    const halving = (i > 5 && rowMean(i - 1) > 0) ? (rowMean(i - 1) / m).toFixed(1) + 'x' : '';
    console.log('    ' + String(i).padStart(2) + '  ' + m.toFixed(3).padStart(9)
        + '  ' + halving.padStart(6) + '  ' + bar);
}

console.log('');
console.log('  The right-hand column is the ratio to the width below. From 6 channels up');
console.log('  it sits near 2, which is the signature of the interpolator: KernelND uses');
console.log('  the Little CMS scheme -- tetrahedral on the last three axes, linear on');
console.log('  every extra one -- so the work is 2^(n-3) tetrahedral evaluations. Each');
console.log('  extra channel doubles it. See src/interp.js and the ND_INTERPOLATOR');
console.log('  toggle in src/kernels/nd/KernelND.js, which selects the O(n) simplex');
console.log('  instead: faster here, and 23x to 140x further from lcms.');

const errs = Object.entries(cells).filter(([, c]) => c.error);
if(errs.length){
    console.log('');
    console.log('  ' + errs.length + ' combination(s) FAILED:');
    for(const [k, c] of errs.slice(0, 10)) console.log('    ' + k + '  ' + c.error);
}

console.log('');
console.log('  ' + Object.keys(cells).length + ' combinations in '
    + ((Date.now() - started) / 1000).toFixed(1) + 's');
console.log('');

const out = path.join(__dirname, 'channel-matrix.json');
fs.writeFileSync(out, JSON.stringify({
    tool: 'bench/channel_matrix/run.js',
    generated: new Date().toISOString(),
    node: process.version,
    platform: process.platform + ' ' + process.arch,
    pixels: PX, format: FORMAT, reps: REPS,
    // WITHOUT THIS the file is a trap. The two n-channel interpolators differ
    // by up to 75x at 15 channels, so a run made with the non-default one
    // reads as a catastrophic regression against a run made with the default.
    // This file was committed once with simplex numbers while the engine
    // shipped tetrahedral, and nothing in it said so.
    ndInterpolator: KernelND.ndInterpolator,
    tables: [{
        id: 'channelMatrix.' + FORMAT,
        title: 'Channel matrix — MPx/s by input and output width',
        units: 'MPx/s',
        columns: ['inputChannels', 'outputChannels', 'mpxs', 'kernel', 'lut', 'lutMode'],
        rows: Object.entries(cells).map(([k, c]) => {
            const [i, o] = k.split('x').map(Number);
            return { inputChannels: i, outputChannels: o,
                     mpxs: c.mpxs ? +c.mpxs.toFixed(3) : null,
                     kernel: c.kernel || null, lut: c.lut === undefined ? null : c.lut,
                     lutMode: c.mode || null, error: c.error || undefined };
        }),
    }],
}, null, 1) + '\n');
console.log('  wrote ' + path.relative(path.join(__dirname, '..', '..'), out));
console.log('');
