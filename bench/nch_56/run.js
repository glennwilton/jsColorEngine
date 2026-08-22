/**
 * bench/nch_56/run.js — 5CLR / 6CLR input: int8 JS vs int8 WASM scalar.
 *
 * Not a gate. The 3/4-channel rows stay the headline; this answers whether
 * the new Kernel5D / Kernel6D WASM is worth the clone to int16.
 *
 * Profiles: committed synthetic_05ch / synthetic_06ch (9^5 / 7^6 A2B) into
 * synthetic_03ch. Input is photo RGB in the first three channels, extras
 * derived, plus 5 % grain — same family as mpx_summary. Falls back to
 * noise if `canvas` is missing.
 *
 * Usage:
 *   node bench/nch_56/run.js
 *   node bench/nch_56/run.js --px 65536 --reps 5
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const Profile = require('../../src/Profile');
const { Transform, eIntent } = require('../../src/main');
const emit = require('../lib/emit.cjs');
const benchContent = require('../lib/benchContent.cjs');

const arg = (name, fallback) => {
    const i = process.argv.indexOf('--' + name);
    return (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--'))
        ? process.argv[i + 1] : fallback;
};

const PX   = parseInt(arg('px', '65536'), 10);
const REPS = parseInt(arg('reps', '5'), 10);
const DIR  = path.join(__dirname, '..', '..', '__tests__', 'profiles');

emit.meta({ tool: 'bench/nch_56/run.js' });

function loadN(n){
    const file = path.join(DIR, 'synthetic_' + String(n).padStart(2, '0') + 'ch.icc');
    if(!fs.existsSync(file)){
        console.error('  missing ' + path.basename(file)
            + ' — run: node scripts/make_test_profiles.js');
        process.exit(1);
    }
    const p = new Profile();
    p.loadBinary(new Uint8Array(fs.readFileSync(file)));
    return p;
}

function expandPhoto(npx, channels){
    const rgb = benchContent.photoPlane();
    const out = new Uint8ClampedArray(npx * channels);
    if(!rgb){
        return benchContent.buildInput(channels, npx, 'noise');
    }
    const src = rgb.data;
    const have = rgb.npx;
    for(let p = 0; p < npx; p++){
        const s = (p % have) * 3;
        const r = src[s], g = src[s + 1], b = src[s + 2];
        out[p * channels]     = r;
        out[p * channels + 1] = g;
        out[p * channels + 2] = b;
        for(let c = 3; c < channels; c++){
            out[p * channels + c] = ((r + g + b) / 3 + c * 17) & 0xff;
        }
    }
    return out;
}

function timeIters(fn, warmup, batch){
    for(let w = 0; w < warmup; w++) fn();
    const samples = [];
    for(let r = 0; r < REPS; r++){
        const t0 = process.hrtime.bigint();
        for(let i = 0; i < batch; i++) fn();
        const t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6 / batch);
    }
    samples.sort((a, b) => a - b);
    return samples[(REPS / 2) | 0];
}

function fmt(mpx){
    return (mpx < 10 ? mpx.toFixed(2) : mpx.toFixed(1)).padStart(6);
}

async function main(){
    try { await benchContent.ready(); }
    catch(e){ console.log('  (no canvas — using noise instead of photo with 5% noise added)'); }

    const dst = loadN(3);
    const modes = [
        { name: 'pipeline',  lutMode: 'int',              buildLut: false },
        { name: 'float',     lutMode: 'float',            buildLut: true  },
        { name: 'int JS',    lutMode: 'int',              buildLut: true  },
        { name: 'int WASM',  lutMode: 'int-wasm-scalar',  buildLut: true  },
    ];

    console.log('');
    console.log('  5CLR / 6CLR input  (' + PX.toLocaleString() + ' px, median of '
        + REPS + ', photo RGB + derived extras + 5% grain)');
    console.log('');
    console.log('  in  mode         kernel      lutMode              MPx/s   vs JS');
    console.log('  --  -----------  ----------  -------------------  ------  -----');

    const rows = [];

    for(const inCh of [5, 6]){
        const src = loadN(inCh);
        const input = expandPhoto(PX, inCh);
        const grain = benchContent.buildInput(inCh, PX, 'noise');
        for(let i = 0; i < input.length; i++){
            input[i] = Math.round(input[i] * 0.95 + grain[i] * 0.05);
        }

        let jsMpx = null;
        for(const mode of modes){
            const t = new Transform({
                dataFormat: 'int8',
                buildLut: mode.buildLut,
                lutMode: mode.lutMode,
            });
            t.create(src, dst, eIntent.relative);
            const probe = t.transformArray(input, false, false, false, Math.min(512, PX));
            const slot = inCh === 5 ? t.wasmTetra5D : t.wasmTetra6D;
            const usedWasm = !!(slot && slot.dispatchCount > 0);

            // Adaptive batch: land near ~200 ms so TurboFan stays hot.
            const probeMs = (function(){
                const t0 = process.hrtime.bigint();
                t.transformArray(input, false, false, false, PX);
                return Number(process.hrtime.bigint() - t0) / 1e6;
            })();
            const batch = Math.max(1, Math.min(40, Math.round(200 / Math.max(probeMs, 1))));
            const warmup = Math.max(2, Math.min(8, batch));
            const ms = timeIters(
                () => { t.transformArray(input, false, false, false, PX); },
                warmup, batch);
            const mpx = (PX / 1e6) / (ms / 1000);
            if(mode.name === 'int JS') jsMpx = mpx;
            const vs = jsMpx ? (mpx / jsMpx).toFixed(2) + '×' : '    —';
            const kName = (t.kernelInfo() && t.kernelInfo().name) || (t.kernel && t.kernel.name) || '?';
            const landed = t.lutMode + (mode.buildLut ? '' : ' (no lut)');
            console.log('  ' + inCh + '   '
                + mode.name.padEnd(11) + '  '
                + String(kName).padEnd(10) + '  '
                + landed.padEnd(19) + '  '
                + fmt(mpx) + '  ' + vs
                + (mode.name === 'int WASM' ? (usedWasm ? '  wasm' : '  NO WASM') : ''));
            rows.push({
                inCh: inCh, mode: mode.name, kernel: kName,
                lutMode: t.lutMode, buildLut: mode.buildLut,
                mpx: Number(mpx.toFixed(3)), usedWasm: usedWasm,
            });
            void probe;
        }
        console.log('');
    }

    emit.table({
        id: 'nch56.int8',
        title: '5CLR / 6CLR input, int8 JS vs WASM',
        units: 'MPx/s',
        columns: ['inCh', 'mode', 'kernel', 'lutMode', 'mpx'],
        rows: rows,
    });
}

main().catch(function(err){
    console.error(err);
    process.exit(1);
});
