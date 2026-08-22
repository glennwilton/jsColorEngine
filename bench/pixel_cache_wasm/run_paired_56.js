/**
 * 5D / 6D paired-export measurement — shipped / paired / single / table-N.
 *
 *   node bench/pixel_cache_wasm/run_paired_56.js
 *   node bench/pixel_cache_wasm/run_paired_56.js --kernel=tetra5d_nch --px 262144
 *
 * int8 scalar only. `paired` vs `shipped` is the control and must read ~1.0×.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Transform, eIntent } = require('../../src/main.js');
const Profile = require('../../src/Profile');
const { KERNELS, buildOne, tableStride } = require('./build_paired');
const content = require('../lib/benchContent.cjs');

const argv = process.argv.slice(2);
const arg  = (n, d) => { const h = argv.find(a => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const REPS = parseInt(arg('reps', '5'), 10);
const NPX  = parseInt(arg('px', String(1 << 18)), 10);
const WANT = arg('kernel', 'all');
const TABLES = arg('tables', '8,16,32,256').split(',').map((s) => parseInt(s, 10));
const DIR = path.join(__dirname, '..', '..', '__tests__', 'profiles');

const now = () => Number(process.hrtime.bigint()) / 1e6;
const align = (n, a) => (n + a - 1) & ~(a - 1);

const SPECS = KERNELS.filter(k => (k.dim === 5 || k.dim === 6) &&
    (WANT === 'all' || WANT.split(',').includes(k.name)));

const SHIPPED = {
    tetra5d_nch: '../../src/kernels/5d/tetra5d_nch.wasm.js',
    tetra6d_nch: '../../src/kernels/6d/tetra6d_nch.wasm.js',
};

function instantiate(bytes, name){
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    if(typeof inst.exports[name] !== 'function') throw new Error('missing export ' + name);
    return {
        memory: inst.exports.memory,
        fn: inst.exports[name],
        cacheBase: inst.exports.cacheBase || null,
    };
}

function expand(npx, ch, kind){
    const rgb = (kind === 'noise' || kind === 'solid')
        ? content.buildInput(3, npx, kind)
        : content.buildInput(3, npx, kind);
    const out = new Uint8Array(npx * ch);
    for(let p = 0; p < npx; p++){
        const r = rgb[p * 3], g = rgb[p * 3 + 1], b = rgb[p * 3 + 2];
        out[p * ch]     = r;
        out[p * ch + 1] = g;
        out[p * ch + 2] = b;
        for(let c = 3; c < ch; c++){
            out[p * ch + c] = ((r + g + b) / 3 + c * 17) & 0xff;
        }
    }
    return out;
}

function logoBlock(npx, ch, frac){
    const a = new Uint8Array(npx * ch);
    const mark = Math.floor(npx * frac);
    const start = Math.floor((npx - mark) / 2);
    for(let p = start; p < start + mark; p++){
        a[p * ch] = 200;
        a[p * ch + 1] = 30;
        a[p * ch + 2] = 40;
        for(let c = 3; c < ch; c++) a[p * ch + c] = 80 + c * 10;
    }
    return a;
}

function layout(state, npx, inCh, cMax, intLut, tableBytes){
    const lutBytes = intLut.CLUT.length * 2;
    const scratchPtr = align(lutBytes, 64);
    const inputPtr = align(scratchPtr + 64, 64);
    const outputPtr = align(inputPtr + npx * inCh, 64);
    const tablePtr = align(outputPtr + npx * cMax, 64);
    const need = tablePtr + (tableBytes || 0) + 64;
    const have = state.memory.buffer.byteLength;
    if(need > have) state.memory.grow(Math.ceil((need - have) / 65536));
    new Uint16Array(state.memory.buffer, 0, intLut.CLUT.length).set(intLut.CLUT);
    if(state.cacheBase && tableBytes){
        new Uint8Array(state.memory.buffer, tablePtr, tableBytes).fill(0);
        state.cacheBase.value = tablePtr;
    }
    return { lutPtr: 0, inputPtr: inputPtr, outputPtr: outputPtr, scratchPtr: scratchPtr };
}

function callKernel(state, p, npx, inCh, cMax, intLut){
    const args = [
        p.inputPtr, p.outputPtr, p.lutPtr, npx, cMax,
        intLut.go0, intLut.go1, intLut.go2, intLut.go3,
        intLut.gridPointsScale_fixed,
        intLut.maxX, intLut.maxY, intLut.maxZ, intLut.maxK,
        intLut.go4, intLut.maxE,
    ];
    if(inCh === 6) args.push(intLut.go5, intLut.maxF);
    args.push(p.scratchPtr, 0, 0);
    state.fn.apply(null, args);
}

function loadN(n){
    const p = new Profile();
    p.loadBinary(new Uint8Array(fs.readFileSync(
        path.join(DIR, 'synthetic_' + String(n).padStart(2, '0') + 'ch.icc'))));
    return p;
}

async function main(){
    try { await content.ready(); } catch(e){ /* noise fallback */ }

    const wabt = await require('wabt')();
    const dst = loadN(3);
    const built = {};
    const luts = {};
    for(const spec of SPECS){
        built[spec.name] = await buildOne(spec, wabt, { stats: false, tables: TABLES });
        const t = new Transform({
            dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar',
        });
        t.create(loadN(spec.dim), dst, eIntent.relative);
        luts[spec.name] = t.lut.intLut;
    }

    console.log('PAIRED 5D/6D — synthetic Nch -> 3ch, ' + NPX + ' px, best of ' + REPS +
                ', tables ' + TABLES.join(',') + ', stats:false, MPx/s\n');

    for(const spec of SPECS){
        const b = built[spec.name];
        const intLut = luts[spec.name];
        const cMax = intLut.outputChannels;
        const inCh = spec.dim;
        const shippedBytes = require(SHIPPED[spec.name]);
        const stride = tableStride({ key: inCh === 5 ? 'nch5' : 'nch6' });
        const tableBytes = (TABLES.length ? Math.max.apply(null, TABLES) : 0) * stride;

        const CONTENT = [
            { name: 'solid',   data: expand(NPX, inCh, 'solid') },
            { name: 'logo5',   data: logoBlock(NPX, inCh, 0.05) },
            { name: 'logo30',  data: logoBlock(NPX, inCh, 0.30) },
            { name: 'photo-5', data: expand(NPX, inCh, 'photo-5') },
            { name: 'noise',   data: expand(NPX, inCh, 'noise') },
        ];

        const arms = [
            ['shipped', instantiate(shippedBytes, b.export)],
            ['paired',  instantiate(b.bytes, b.export)],
            ['single',  instantiate(b.bytes, b.cachedExport)],
        ];
        for(const n of TABLES){
            arms.push(['t' + n, instantiate(b.bytes, b.tableExports[n])]);
        }

        console.log(spec.name + '  (' + inCh + ' -> ' + cMax + ', grid '
            + intLut.CLUT.length / cMax + ' cells)');
        console.log('arm       ' + CONTENT.map(c => c.name.slice(0, 9).padStart(10)).join(''));

        const res = {};
        const expected = {};
        for(const [label, state] of arms){
            let line = '  ' + label.padEnd(9);
            res[label] = {};
            for(const c of CONTENT){
                const p = layout(state, NPX, inCh, cMax, intLut, tableBytes);
                new Uint8Array(state.memory.buffer, p.inputPtr, NPX * inCh).set(c.data);
                const go = () => callKernel(state, p, NPX, inCh, cMax, intLut);
                go();
                const got = new Uint8Array(state.memory.buffer.slice(p.outputPtr, p.outputPtr + NPX * cMax));
                let best = Infinity;
                for(let r = 0; r < REPS; r++){
                    const t0 = now();
                    go();
                    best = Math.min(best, now() - t0);
                }
                res[label][c.name] = NPX / (best / 1000) / 1e6;
                if(label === 'shipped') expected[c.name] = got;
                else {
                    let d = 0;
                    const exp = expected[c.name];
                    for(let i = 0; i < got.length; i++) if(got[i] !== exp[i]) d++;
                    if(d){ line += ('DIFF' + d).padStart(10); continue; }
                }
                line += res[label][c.name].toFixed(1).padStart(10);
            }
            console.log(line);
        }
        console.log('  vs ship');
        for(const [label] of arms){
            if(label === 'shipped') continue;
            console.log('  ' + label.padEnd(9) +
                CONTENT.map(c => (res[label][c.name] / res.shipped[c.name]).toFixed(3) + 'x')
                    .map(s => s.padStart(10)).join(''));
        }
        console.log('');
    }

    console.log('"paired" is the control and must read ~1.000x.');
}

main().catch((e) => { console.error(e.stack || e); process.exit(1); });
