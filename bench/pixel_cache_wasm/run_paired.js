/**
 * Paired-export measurement — three arms, one of which must be a tie.
 *
 *   node bench/pixel_cache_wasm/build_paired.js && node bench/pixel_cache_wasm/run_paired.js
 *
 *   shipped   src/kernels/3d/tetra3d_simd.wasm.js, exactly as published
 *   paired    the uncached export from the paired module — the SAME function
 *             text, recompiled alongside a second one
 *   cached    the cached export from that same module
 *
 * `shipped` vs `paired` is the control. It must come out a tie: the uncached
 * function is copied in verbatim, so any difference is codegen context, and
 * the earlier POC's 15-22% "toggle tax" was exactly that plus a mode
 * parameter. If this control is not a tie, nothing else on the page can be
 * attributed to the cache.
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const { Transform, eIntent } = require('../../src/main.js');

const CORPUS = path.join(__dirname, '..', 'release_matrix', 'corpus');
const argv = process.argv.slice(2);
const arg  = (n, d) => { const h = argv.find(a => a.startsWith('--' + n + '=')); return h ? h.slice(n.length+3) : d; };
const REPS = parseInt(arg('reps', '9'), 10);
const FROM = arg('from', '*prophoto'), TO = arg('to', '*sRGB');

const now = () => Number(process.hrtime.bigint()) / 1e6;
const median = xs => { const s = xs.slice().sort((a,b)=>a-b); const m = s.length>>1;
                       return s.length % 2 ? s[m] : (s[m-1]+s[m])/2; };
const align = (n,a) => (n + a - 1) & ~(a - 1);

function noise(npx){
    const a = new Uint8ClampedArray(npx*3); let s = 0x13579bdf;
    for(let i=0;i<a.length;i++){ s=(Math.imul(s,1103515245)+12345)&0x7fffffff; a[i]=(s>>>23)&0xff; }
    return a;
}
function solid(npx){
    const a = new Uint8ClampedArray(npx*3);
    for(let p=0;p<npx;p++){ a[p*3]=91; a[p*3+1]=140; a[p*3+2]=37; }
    return a;
}
function logoBlock(npx, frac){
    const a = new Uint8ClampedArray(npx*3);
    for(let p=0;p<npx;p++){ a[p*3]=255; a[p*3+1]=255; a[p*3+2]=255; }
    const mark = Math.floor(npx*frac), start = Math.floor((npx-mark)/2);
    for(let p=start;p<start+mark;p++){ a[p*3]=200; a[p*3+1]=30; a[p*3+2]=40; }
    return a;
}
function frames(){
    let files = [];
    try { files = fs.readdirSync(CORPUS).filter(f=>f.endsWith('.rgb.bin')).sort(); } catch(e){}
    return files.map(f => {
        const src = fs.readFileSync(path.join(CORPUS, f));
        const a = new Uint8ClampedArray(src.length - (src.length % 3));
        a.set(src.subarray(0, a.length));
        return {name: f.split(/[-_.]/).filter(w=>w===w.toUpperCase()&&w.length>3)[0] || f.slice(0,8),
                data: a, px: a.length/3};
    });
}

const t = new Transform({dataFormat:'int8', buildLut:true, lutMode:'int-wasm-simd',
                         wasmMatrixShaper:false});
t.create(FROM, TO, eIntent.relative);
const intLut = t.lut.intLut;
const cMax = t.lut.outputChannels;

function instantiate(bytes, name){
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    if(typeof inst.exports[name] !== 'function') throw new Error('missing export ' + name);
    return { memory: inst.exports.memory, fn: inst.exports[name] };
}
const pairedBytes = fs.readFileSync(path.join(__dirname, 'tetra3d_simd_paired.wasm'));
const ARMS = [
    ['shipped', instantiate(require('../../src/kernels/3d/tetra3d_simd.wasm.js'), 'interp_tetra3d_simd')],
    ['paired',  instantiate(pairedBytes, 'interp_tetra3d_simd')],
    ['cached',  instantiate(pairedBytes, 'interp_tetra3d_simd_cached')]
];

function layout(state, npx){
    const lutBytes  = intLut.CLUT.length * 2;
    const inputPtr  = align(lutBytes, 64);
    const outputPtr = align(inputPtr + npx*3, 64);
    const need = outputPtr + npx*cMax + 64;
    const have = state.memory.buffer.byteLength;
    if(need > have) state.memory.grow(Math.ceil((need-have)/65536));
    new Uint16Array(state.memory.buffer, 0, intLut.CLUT.length).set(intLut.CLUT);
    return {lutPtr:0, inputPtr, outputPtr};
}

const N1 = 1 << 20;
const CONTENT = [
    {name:'solid',  data: solid(N1),          px:N1},
    {name:'logo5',  data: logoBlock(N1,0.05), px:N1},
    {name:'logo30', data: logoBlock(N1,0.30), px:N1}
].concat(frames()).concat([{name:'noise', data: noise(N1), px:N1}]);

console.log('PAIRED EXPORTS — tetra3d SIMD, ' + FROM + ' -> ' + TO +
            ', best of ' + REPS + ', MPx/s\n');
console.log('arm       ' + CONTENT.map(c=>c.name.slice(0,9).padStart(10)).join(''));

const res = {};
for(const [label, state] of ARMS){
    let line = '  ' + label.padEnd(9);
    res[label] = {};
    for(const c of CONTENT){
        const p = layout(state, c.px);
        new Uint8Array(state.memory.buffer, p.inputPtr, c.px*3).set(c.data.subarray(0, c.px*3));
        const call = () => state.fn(p.inputPtr, p.outputPtr, p.lutPtr, c.px, cMax,
            intLut.go0, intLut.go1, intLut.go2, intLut.gridPointsScale_fixed,
            intLut.maxX, intLut.maxY, intLut.maxZ, 0, 0);
        call();
        const got = new Uint8Array(state.memory.buffer.slice(p.outputPtr, p.outputPtr + c.px*cMax));
        let best = Infinity;
        for(let r=0;r<REPS;r++){ const t0=now(); call(); best=Math.min(best, now()-t0); }
        res[label][c.name] = c.px/(best/1000)/1e6;
        if(label === 'shipped') c.expected = got;
        else {
            let d = 0;
            for(let i=0;i<got.length;i++) if(got[i]!==c.expected[i]) d++;
            if(d){ line += ('DIFF'+d).padStart(10); continue; }
        }
        line += res[label][c.name].toFixed(1).padStart(10);
    }
    console.log(line);
}

console.log('\nRATIO vs shipped');
console.log('arm       ' + CONTENT.map(c=>c.name.slice(0,9).padStart(10)).join(''));
for(const [label] of ARMS){
    if(label==='shipped') continue;
    console.log('  ' + label.padEnd(9) +
        CONTENT.map(c=>(res[label][c.name]/res.shipped[c.name]).toFixed(3)+'x').map(s=>s.padStart(10)).join(''));
}
console.log('\n"paired" is the control and must read ~1.000x — it is the shipped');
console.log('function verbatim, only recompiled next to a second one.');
