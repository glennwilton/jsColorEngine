/**
 * 3D WASM pixel cache — single-entry and an 8-slot table.
 * Same inject as 4D; RGB key (24-bit int8 / 48-bit int16).
 */

'use strict';

const { Transform, eIntent } = require('../src/main');
const { KERNELS, KNUTH, buildAll, tableStride } =
    require('../bench/pixel_cache_wasm/build_paired');

const haveWasm = typeof WebAssembly !== 'undefined' && !process.env.SKIP_WASM_TESTS;
const describeIf = haveWasm ? describe : describe.skip;

const NPX = 16;
const TABLE = 8;
const A = [20, 80, 40];
const B = [90, 10, 70];

function fillRgb(npx, colours){
    const a = new Uint8Array(npx * 3);
    for(let p = 0; p < npx; p++){
        const c = colours[p];
        a[p * 3]     = c[0];
        a[p * 3 + 1] = c[1];
        a[p * 3 + 2] = c[2];
    }
    return a;
}

function solid(npx){ return fillRgb(npx, Array(npx).fill(A)); }
function alternate(npx){
    return fillRgb(npx, Array.from({ length: npx }, (_, i) => (i & 1) ? B : A));
}

function toU16(u8){
    const a = new Uint16Array(u8.length);
    for(let i = 0; i < u8.length; i++) a[i] = u8[i] * 257;
    return a;
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

function expectedTable(input, ch, slots, u16){
    const npx = input.length / ch;
    const have = new Uint8Array(slots);
    const keys = new Array(slots);
    const shift = 32 - Math.log2(slots);
    let hits = 0;
    for(let p = 0; p < npx; p++){
        let key, h;
        if(!u16){
            key = ((input[p * ch] << 16) | (input[p * ch + 1] << 8) | input[p * ch + 2]) >>> 0;
            h = Math.imul(key, KNUTH) >>> shift;
        } else {
            const lo = (input[p * ch] | (input[p * ch + 1] << 16)) >>> 0;
            const hi = input[p * ch + 2] >>> 0;
            key = lo + ',' + hi;
            h = Math.imul((lo ^ hi) >>> 0, KNUTH) >>> shift;
        }
        if(have[h] && keys[h] === key) hits++;
        else { have[h] = 1; keys[h] = key; }
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
    const bppIn = opts.u16 ? 6 : 3;
    const bppOut = opts.u16 ? cMax * 2 : cMax;
    const lutBytes = intLut.CLUT.length * 2;
    const inputPtr = align(lutBytes, 64);
    const outputPtr = align(inputPtr + npx * bppIn, 64);
    const tableBytes = opts.tableSlots ? opts.tableSlots * opts.stride : 0;
    const tablePtr = align(outputPtr + npx * bppOut, 64);
    const need = tablePtr + tableBytes + 64;
    if(need > mem.buffer.byteLength){
        mem.grow(Math.ceil((need - mem.buffer.byteLength) / 65536));
    }
    new Uint16Array(mem.buffer, 0, intLut.CLUT.length).set(intLut.CLUT);
    if(opts.u16) new Uint16Array(mem.buffer, inputPtr, npx * 3).set(input);
    else new Uint8Array(mem.buffer, inputPtr, npx * 3).set(input);
    if(opts.tableSlots){
        new Uint8Array(mem.buffer, tablePtr, tableBytes).fill(0);
        inst.exports.cacheBase.value = tablePtr;
    }
    const gps = opts.u16 ? intLut.gridPointsScale_fixed_u16 : intLut.gridPointsScale_fixed;
    fn(
        inputPtr, outputPtr, 0, npx, cMax,
        intLut.go0, intLut.go1, intLut.go2,
        gps, intLut.maxX, intLut.maxY, intLut.maxZ,
        0, 0
    );
    const out = opts.u16
        ? new Uint16Array(mem.buffer.slice(outputPtr, outputPtr + npx * cMax * 2))
        : new Uint8Array(mem.buffer.slice(outputPtr, outputPtr + npx * cMax));
    return {
        out,
        hits: inst.exports.cacheHits ? inst.exports.cacheHits.value : null,
        misses: inst.exports.cacheMisses ? inst.exports.cacheMisses.value : null
    };
}

describeIf('3D pixel-cache paired exports', () => {
    let built;
    let lut8;
    let lut16;

    beforeAll(async () => {
        built = await buildAll({ write: false, log: false, stats: true, tables: [TABLE] });
        const t8 = new Transform({
            dataFormat: 'int8', buildLut: true, lutMode: 'int-wasm-simd',
            wasmMatrixShaper: false
        });
        t8.create('*prophoto', '*sRGB', eIntent.relative);
        lut8 = t8.lut.intLut;
        const t16 = new Transform({
            dataFormat: 'int16', buildLut: true, lutMode: 'int16-wasm-simd',
            wasmMatrixShaper: false
        });
        t16.create('*prophoto', '*sRGB', eIntent.relative);
        lut16 = t16.lut.intLut;
    }, 60000);

    const THREE = KERNELS.filter((k) => k.dim === 3).map((k) => ({
        name: k.name,
        u16: k.kind.endsWith('16')
    }));

    const SHIPPED = {
        tetra3d_simd:       '../src/kernels/3d/tetra3d_simd.wasm.js',
        tetra3d_simd_int16: '../src/kernels/3d/tetra3d_simd_int16.wasm.js',
        tetra3d_nch:        '../src/kernels/3d/tetra3d_nch.wasm.js',
        tetra3d_nch_int16:  '../src/kernels/3d/tetra3d_nch_int16.wasm.js'
    };

    const PATTERNS = [
        { label: 'solid',     input: solid(NPX) },
        { label: 'alternate', input: alternate(NPX) }
    ];

    for(const spec of THREE){
        test(spec.name + ': single and table-8 match shipped, hits match policy', () => {
            const b = built[spec.name];
            const inst = new WebAssembly.Instance(new WebAssembly.Module(b.bytes), {});
            expect(typeof inst.exports[b.cachedExport]).toBe('function');
            expect(typeof inst.exports[b.tableExports[TABLE]]).toBe('function');

            const lut = spec.u16 ? lut16 : lut8;
            const opts = {
                npx: NPX, cMax: lut.outputChannels, u16: spec.u16,
                stride: tableStride({ key: spec.u16 ? 'rgb16' : 'rgb' })
            };
            const shippedBytes = require(SHIPPED[spec.name]);

            for(const pat of PATTERNS){
                const input = spec.u16 ? toU16(pat.input) : pat.input;
                const wantSingle = expectedSingle(input, 3);
                const wantTable = expectedTable(input, 3, TABLE, spec.u16);
                const unc = runExport(b.bytes, b.export, lut, input, opts);
                const single = runExport(b.bytes, b.cachedExport, lut, input, opts);
                const table = runExport(b.bytes, b.tableExports[TABLE], lut, input,
                    Object.assign({}, opts, { tableSlots: TABLE }));
                const shipped = runExport(shippedBytes, b.export, lut, input, opts);

                expect(maxAbs(unc.out, shipped.out)).toBe(0);
                expect(maxAbs(single.out, unc.out)).toBe(0);
                expect(maxAbs(table.out, unc.out)).toBe(0);
                expect(single.hits).toBe(wantSingle);
                expect(single.misses).toBe(NPX - wantSingle);
                expect(table.hits).toBe(wantTable);
                expect(table.misses).toBe(NPX - wantTable);
            }

            const alt = spec.u16 ? toU16(alternate(NPX)) : alternate(NPX);
            expect(expectedSingle(alt, 3)).toBe(0);
            expect(expectedTable(alt, 3, TABLE, spec.u16)).toBeGreaterThan(0);
        });
    }
});
