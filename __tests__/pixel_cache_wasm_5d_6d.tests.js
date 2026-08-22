/**
 * 5D / 6D WASM pixel cache — single-entry and an 8-slot table.
 *
 * int8 scalar only (no int16 / SIMD twins). 40-bit / 48-bit keys.
 * Same inject as 3D/4D; output must match the shipped kernel.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Transform, eIntent } = require('../src/main');
const Profile = require('../src/Profile');
const { KERNELS, KNUTH, buildOne, tableStride } =
    require('../bench/pixel_cache_wasm/build_paired');

const haveWasm = typeof WebAssembly !== 'undefined' && !process.env.SKIP_WASM_TESTS;
const describeIf = haveWasm ? describe : describe.skip;

const NPX = 16;
const TABLE = 8;
const DIR = path.join(__dirname, 'profiles');

const SPECS = [
    { name: 'tetra5d_nch', inCh: 5, shipped: '../src/kernels/5d/tetra5d_nch.wasm.js',
      A: [20, 80, 40, 10, 50], B: [90, 10, 70, 30, 200] },
    { name: 'tetra6d_nch', inCh: 6, shipped: '../src/kernels/6d/tetra6d_nch.wasm.js',
      A: [20, 80, 40, 10, 50, 15], B: [90, 10, 70, 30, 200, 181] },
];

function fill(npx, ch, colours){
    const a = new Uint8Array(npx * ch);
    for(let p = 0; p < npx; p++){
        const c = colours[p];
        for(let i = 0; i < ch; i++) a[p * ch + i] = c[i];
    }
    return a;
}

function solid(npx, ch, A){ return fill(npx, ch, Array(npx).fill(A)); }
function alternate(npx, ch, A, B){
    return fill(npx, ch, Array.from({ length: npx }, (_, i) => (i & 1) ? B : A));
}

function maxAbs(a, b){
    let m = 0;
    for(let i = 0; i < a.length; i++){
        const d = Math.abs(a[i] - b[i]);
        if(d > m) m = d;
    }
    return m;
}

function align(n, a){ return (n + a - 1) & ~(a - 1); }

function packKey(input, p, ch){
    const o = p * ch;
    if(ch === 5){
        const lo = (input[o] | (input[o + 1] << 8) | (input[o + 2] << 16) |
                    (input[o + 3] << 24)) >>> 0;
        const hi = input[o + 4] >>> 0;
        return { lo: lo, hi: hi };
    }
    const lo = (input[o] | (input[o + 1] << 8) | (input[o + 2] << 16) |
                (input[o + 3] << 24)) >>> 0;
    const hi = (input[o + 4] | (input[o + 5] << 8)) >>> 0;
    return { lo: lo, hi: hi };
}

function expectedSingle(input, ch){
    const npx = input.length / ch;
    let hits = 0;
    for(let p = 1; p < npx; p++){
        let same = true;
        for(let c = 0; c < ch; c++){
            if(input[p * ch + c] !== input[(p - 1) * ch + c]){ same = false; break; }
        }
        if(same) hits++;
    }
    return hits;
}

function expectedTable(input, ch, slots){
    const npx = input.length / ch;
    const have = new Uint8Array(slots);
    const keys = new Array(slots);
    const shift = 32 - Math.log2(slots);
    let hits = 0;
    for(let p = 0; p < npx; p++){
        const k = packKey(input, p, ch);
        const h = Math.imul((k.lo ^ k.hi) >>> 0, KNUTH) >>> shift;
        const id = k.lo + ',' + k.hi;
        if(have[h] && keys[h] === id) hits++;
        else { have[h] = 1; keys[h] = id; }
    }
    return hits;
}

function runExport(bytes, name, intLut, input, opts){
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
    const fn = inst.exports[name];
    if(typeof fn !== 'function') throw new Error('missing export ' + name);
    const mem = inst.exports.memory;
    const npx = opts.npx;
    const cMax = opts.cMax;
    const inCh = opts.inCh;
    const bppIn = inCh;
    const bppOut = cMax;
    const lutBytes = intLut.CLUT.length * 2;
    const scratchPtr = align(lutBytes, 64);
    const inputPtr = align(scratchPtr + 64, 64);
    const outputPtr = align(inputPtr + npx * bppIn, 64);
    const tableBytes = opts.tableSlots ? opts.tableSlots * opts.stride : 0;
    const tablePtr = align(outputPtr + npx * bppOut, 64);
    const need = tablePtr + tableBytes + 64;
    if(need > mem.buffer.byteLength){
        mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
    }
    new Uint16Array(mem.buffer, 0, intLut.CLUT.length).set(intLut.CLUT);
    new Uint8Array(mem.buffer, inputPtr, npx * inCh).set(input);
    if(opts.tableSlots){
        if(!inst.exports.cacheBase) throw new Error('cacheBase missing');
        new Uint8Array(mem.buffer, tablePtr, tableBytes).fill(0);
        inst.exports.cacheBase.value = tablePtr;
    }
    const args = [
        inputPtr, outputPtr, 0, npx, cMax,
        intLut.go0, intLut.go1, intLut.go2, intLut.go3,
        intLut.gridPointsScale_fixed,
        intLut.maxX, intLut.maxY, intLut.maxZ, intLut.maxK,
        intLut.go4, intLut.maxE,
    ];
    if(inCh === 6) args.push(intLut.go5, intLut.maxF);
    args.push(scratchPtr, 0, 0);
    fn.apply(null, args);

    const out = new Uint8Array(mem.buffer.slice(outputPtr, outputPtr + npx * cMax));
    return {
        out: out,
        hits: inst.exports.cacheHits ? inst.exports.cacheHits.value : null,
        misses: inst.exports.cacheMisses ? inst.exports.cacheMisses.value : null,
    };
}

function loadN(n){
    const p = new Profile();
    p.loadBinary(new Uint8Array(fs.readFileSync(
        path.join(DIR, 'synthetic_' + String(n).padStart(2, '0') + 'ch.icc'))));
    return p;
}

describeIf('5D / 6D pixel-cache paired exports', () => {
    let built = {};
    let luts = {};

    beforeAll(async () => {
        const wabt = await require('wabt')();
        const dst = loadN(3);
        for(const spec of SPECS){
            const k = KERNELS.find((x) => x.name === spec.name);
            built[spec.name] = await buildOne(k, wabt, { stats: true, tables: [TABLE] });
            const t = new Transform({
                dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-scalar',
            });
            t.create(loadN(spec.inCh), dst, eIntent.relative);
            luts[spec.name] = t.lut.intLut;
        }
    }, 60000);

    for(const spec of SPECS){
        test(spec.name + ': single and table-8 match shipped, hits match policy', () => {
            const b = built[spec.name];
            const inst = new WebAssembly.Instance(new WebAssembly.Module(b.bytes), {});
            expect(typeof inst.exports[b.export]).toBe('function');
            expect(typeof inst.exports[b.cachedExport]).toBe('function');
            expect(typeof inst.exports[b.tableExports[TABLE]]).toBe('function');

            const lut = luts[spec.name];
            const opts = {
                npx: NPX, cMax: lut.outputChannels, inCh: spec.inCh,
                stride: tableStride({ key: spec.inCh === 5 ? 'nch5' : 'nch6' }),
            };
            const shippedBytes = require(spec.shipped);
            const patterns = [
                { label: 'solid',     input: solid(NPX, spec.inCh, spec.A) },
                { label: 'alternate', input: alternate(NPX, spec.inCh, spec.A, spec.B) },
            ];

            for(const pat of patterns){
                const wantSingle = expectedSingle(pat.input, spec.inCh);
                const wantTable = expectedTable(pat.input, spec.inCh, TABLE);
                const unc = runExport(b.bytes, b.export, lut, pat.input, opts);
                const single = runExport(b.bytes, b.cachedExport, lut, pat.input, opts);
                const table = runExport(b.bytes, b.tableExports[TABLE], lut, pat.input,
                    Object.assign({}, opts, { tableSlots: TABLE }));
                const shipped = runExport(shippedBytes, b.export, lut, pat.input, opts);

                expect(maxAbs(unc.out, shipped.out)).toBe(0);
                expect(maxAbs(single.out, unc.out)).toBe(0);
                expect(maxAbs(table.out, unc.out)).toBe(0);
                expect(single.hits).toBe(wantSingle);
                expect(single.misses).toBe(NPX - wantSingle);
                expect(table.hits).toBe(wantTable);
                expect(table.misses).toBe(NPX - wantTable);
            }

            const alt = alternate(NPX, spec.inCh, spec.A, spec.B);
            expect(expectedSingle(alt, spec.inCh)).toBe(0);
            expect(expectedTable(alt, spec.inCh, TABLE)).toBeGreaterThan(0);
        });
    }
});
