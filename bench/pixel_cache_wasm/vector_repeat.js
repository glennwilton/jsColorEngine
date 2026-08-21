/**
 * "Does this input register equal the previous input register?"
 *
 * A single-entry cache keyed on the VECTOR, not the pixel. It never interprets
 * the bytes, so it does not care about channel count, stride or bit depth —
 * and unlike a per-pixel cache it works in SIMD, because there is nothing to
 * branch per lane: one v128 compare for the whole batch, one v128 store on a
 * hit.
 *
 * Measured here against the alternative it replaces ("are the pixels WITHIN
 * this batch identical"), which still had to recompute every batch.
 *
 * Chunk sizes are the real ones:
 *   12 bytes = 4 x RGB8      (the 3->3 batch)
 *   16 bytes = 4 x RGBA8     (canvas data — exactly one v128 in and out)
 *   24 bytes = 4 x RGB16
 *
 * CAUTION — THE RGBA COLUMN IS STRICTER THAN THE SHIPPED KERNEL, and is kept
 * only as an upper bound on what a naive whole-register compare would give.
 * The real cache keys on the THREE COLOUR BYTES and nothing else, because
 * tetra3d reads three bytes, advances by three, and consumes alpha in a
 * separate tail that runs on the hit path as well. Alpha never enters the
 * colour computation, so it never enters the key.
 *
 * The difference is not academic. A solid RGB under an alpha gradient — every
 * pixel a different alpha — scores 0% in the RGBA column here and measures
 * 2.80x through the actual kernel, byte-identical with alpha preserved. Read
 * the 12-byte column as the honest one.
 */
'use strict';
const fs = require('fs'), path = require('path');
const CORPUS = path.join(__dirname, '..', 'release_matrix', 'corpus');

/** Fraction of chunks byte-identical to the chunk before them. */
function repeatRate(buf, chunkBytes){
    const n = Math.floor(buf.length / chunkBytes);
    let hits = 0;
    for(let c = 1; c < n; c++){
        const a = c * chunkBytes, b = a - chunkBytes;
        let same = true;
        for(let i = 0; i < chunkBytes; i++) if(buf[a+i] !== buf[b+i]){ same = false; break; }
        if(same) hits++;
    }
    return hits / (n - 1);
}

/** The earlier idea: all four pixels inside one batch identical. */
function uniformRate(px, npx){
    let uni = 0, batches = 0;
    const same = (a,b) => px[a*3]===px[b*3] && px[a*3+1]===px[b*3+1] && px[a*3+2]===px[b*3+2];
    for(let p = 0; p + 3 < npx; p += 4){
        batches++;
        if(same(p,p+1) && same(p,p+2) && same(p,p+3)) uni++;
    }
    return uni / batches;
}

function toRGBA(px, npx){
    const a = new Uint8ClampedArray(npx * 4);
    for(let p = 0; p < npx; p++){
        a[p*4]=px[p*3]; a[p*4+1]=px[p*3+1]; a[p*4+2]=px[p*3+2]; a[p*4+3]=255;
    }
    return a;
}

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
/** A logo: one flat background with a small mark on it — the case in question. */
function logo(npx, markFraction){
    const a = new Uint8ClampedArray(npx*3);
    for(let p=0;p<npx;p++){ a[p*3]=255; a[p*3+1]=255; a[p*3+2]=255; }
    const mark = Math.floor(npx * markFraction);
    for(let p=0;p<mark;p++){
        const q = ((p * 7919) % npx);            // scattered, the hostile layout
        a[q*3]=200; a[q*3+1]=30; a[q*3+2]=40;
    }
    return a;
}
/** The same ink, in one contiguous block — the realistic layout. */
function logoBlock(npx, markFraction){
    const a = new Uint8ClampedArray(npx*3);
    for(let p=0;p<npx;p++){ a[p*3]=255; a[p*3+1]=255; a[p*3+2]=255; }
    const mark = Math.floor(npx * markFraction);
    const start = Math.floor((npx - mark) / 2);
    for(let p=start;p<start+mark;p++){ a[p*3]=200; a[p*3+1]=30; a[p*3+2]=40; }
    return a;
}

const N = 1 << 20;
const items = [
    ['solid',            solid(N)],
    ['logo 5% scattered', logo(N, 0.05)],
    ['logo 5% block',    logoBlock(N, 0.05)],
    ['logo 30% block',   logoBlock(N, 0.30)]
];
for(const f of fs.readdirSync(CORPUS).filter(x => x.endsWith('.rgb.bin')).sort()){
    const b = fs.readFileSync(path.join(CORPUS, f));
    const a = new Uint8ClampedArray(b.length - (b.length % 3));
    a.set(b.subarray(0, a.length));
    items.push(['  ' + (f.split(/[-_.]/).filter(w => w === w.toUpperCase() && w.length > 3)[0] || f.slice(0,8)), a]);
}
items.push(['noise', noise(N)]);

console.log('VECTOR REPEAT — "same 128 bits in as last time?"\n');
console.log('content            RGB8/12B   RGBA8/16B   RGB16/24B   | within-batch');
for(const [name, px] of items){
    const npx = px.length / 3;
    const rgba = toRGBA(px, npx);
    const u16 = new Uint8ClampedArray(npx * 6);
    for(let i = 0; i < npx * 3; i++){ u16[i*2] = px[i]; u16[i*2+1] = px[i]; }
    console.log('  ' + name.padEnd(18) +
        (100*repeatRate(px, 12)).toFixed(1).padStart(8) + '%' +
        (100*repeatRate(rgba, 16)).toFixed(1).padStart(11) + '%' +
        (100*repeatRate(u16, 24)).toFixed(1).padStart(11) + '%' +
        (100*uniformRate(px, npx)).toFixed(1).padStart(14) + '%');
}
