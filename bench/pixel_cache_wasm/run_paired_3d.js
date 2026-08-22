/**
 * 3D paired-export measurement — shipped / paired / single / table-N.
 *
 *   node bench/pixel_cache_wasm/run_paired_3d.js
 */
'use strict';

const { Transform, eIntent } = require('../../src/main.js');
const { KERNELS, buildAll, tableStride } = require('./build_paired');
const content = require('../lib/benchContent.cjs');

const argv = process.argv.slice(2);
const arg  = (n, d) => { const h = argv.find(a => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const REPS = parseInt(arg('reps', '7'), 10);
const NPX  = parseInt(arg('px', String(1 << 20)), 10);
const WANT = arg('kernel', 'all');
const TABLES = arg('tables', '8,16,32').split(',').map((s) => parseInt(s, 10));

const now = () => Number(process.hrtime.bigint()) / 1e6;
const align = (n, a) => (n + a - 1) & ~(a - 1);

const SPECS = KERNELS.filter(k => k.dim === 3 &&
    (WANT === 'all' || WANT.split(',').includes(k.name)));

const SHIPPED = {
    tetra3d_simd:       '../../src/kernels/3d/tetra3d_simd.wasm.js',
    tetra3d_simd_int16: '../../src/kernels/3d/tetra3d_simd_int16.wasm.js',
    tetra3d_nch:        '../../src/kernels/3d/tetra3d_nch.wasm.js',
    tetra3d_nch_int16:  '../../src/kernels/3d/tetra3d_nch_int16.wasm.js'
};

function instantiate(bytes, name){
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    if(typeof inst.exports[name] !== 'function') throw new Error('missing export ' + name);
    return {
        memory: inst.exports.memory,
        fn: inst.exports[name],
        cacheBase: inst.exports.cacheBase || null
    };
}

function toU16(u8){
    const a = new Uint16Array(u8.length);
    for(let i = 0; i < u8.length; i++) a[i] = u8[i] * 257;
    return a;
}

function logoBlock(npx, frac){
    const a = new Uint8Array(npx * 3);
    const mark = Math.floor(npx * frac);
    const start = Math.floor((npx - mark) / 2);
    for(let p = start; p < start + mark; p++){
        a[p * 3] = 200; a[p * 3 + 1] = 30; a[p * 3 + 2] = 40;
    }
    return a;
}

function layout(state, npx, u16, cMax, intLut, tableBytes){
    const bppIn = u16 ? 6 : 3;
    const bppOut = u16 ? cMax * 2 : cMax;
    const lutBytes = intLut.CLUT.length * 2;
    const inputPtr = align(lutBytes, 64);
    const outputPtr = align(inputPtr + npx * bppIn, 64);
    const tablePtr = align(outputPtr + npx * bppOut, 64);
    const need = tablePtr + (tableBytes || 0) + 64;
    const have = state.memory.buffer.byteLength;
    if(need > have) state.memory.grow(Math.ceil((need - have) / 65536));
    new Uint16Array(state.memory.buffer, 0, intLut.CLUT.length).set(intLut.CLUT);
    if(state.cacheBase && tableBytes){
        new Uint8Array(state.memory.buffer, tablePtr, tableBytes).fill(0);
        state.cacheBase.value = tablePtr;
    }
    return { lutPtr: 0, inputPtr, outputPtr };
}

function callKernel(state, p, npx, cMax, intLut, u16){
    const gps = u16 ? intLut.gridPointsScale_fixed_u16 : intLut.gridPointsScale_fixed;
    state.fn(
        p.inputPtr, p.outputPtr, p.lutPtr, npx, cMax,
        intLut.go0, intLut.go1, intLut.go2,
        gps, intLut.maxX, intLut.maxY, intLut.maxZ,
        0, 0
    );
}

async function main(){
    const built = await buildAll({ write: false, log: false, stats: false, tables: TABLES });
    const t8 = new Transform({
        dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd',
        wasmMatrixShaper: false
    });
    t8.create('*prophoto', '*sRGB', eIntent.relative);
    const t16 = new Transform({
        dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd',
        wasmMatrixShaper: false
    });
    t16.create('*prophoto', '*sRGB', eIntent.relative);

    try { await content.ready(); } catch(e){}
    const CONTENT = [
        { name: 'solid',  data: content.buildInput(3, NPX, 'solid') },
        { name: 'logo5',  data: logoBlock(NPX, 0.05) },
        { name: 'logo30', data: logoBlock(NPX, 0.30) }
    ];
    if(content.photoPlane()) CONTENT.push({ name: 'photo-5', data: content.buildInput(3, NPX, 'photo-5') });
    CONTENT.push({ name: 'noise', data: content.buildInput(3, NPX, 'noise') });

    console.log('PAIRED 3D — ProPhoto -> sRGB, ' + NPX + ' px, best of ' + REPS +
                ', tables ' + TABLES.join(',') + ', stats:false, MPx/s\n');

    for(const spec of SPECS){
        const b = built[spec.name];
        const u16 = spec.kind.endsWith('16');
        const intLut = u16 ? t16.lut.intLut : t8.lut.intLut;
        const cMax = intLut.outputChannels;
        const shippedBytes = require(SHIPPED[spec.name]);
        const stride = tableStride({ key: u16 ? 'rgb16' : 'rgb' });
        const tableBytes = (TABLES.length ? Math.max.apply(null, TABLES) : 0) * stride;
        const arms = [
            ['shipped', instantiate(shippedBytes, b.export)],
            ['paired',  instantiate(b.bytes, b.export)],
            ['single',  instantiate(b.bytes, b.cachedExport)]
        ];
        for(const n of TABLES) arms.push(['t' + n, instantiate(b.bytes, b.tableExports[n])]);

        console.log(spec.name);
        console.log('arm       ' + CONTENT.map(c => c.name.slice(0, 9).padStart(10)).join(''));

        const res = {};
        const expected = {};
        for(const [label, state] of arms){
            let line = '  ' + label.padEnd(9);
            res[label] = {};
            for(const c of CONTENT){
                const input = u16 ? toU16(c.data) : c.data;
                const p = layout(state, NPX, u16, cMax, intLut, tableBytes);
                if(u16) new Uint16Array(state.memory.buffer, p.inputPtr, NPX * 3).set(input);
                else new Uint8Array(state.memory.buffer, p.inputPtr, NPX * 3).set(input);
                const go = () => callKernel(state, p, NPX, cMax, intLut, u16);
                go();
                const outBytes = u16 ? NPX * cMax * 2 : NPX * cMax;
                const got = new Uint8Array(state.memory.buffer.slice(p.outputPtr, p.outputPtr + outBytes));
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
