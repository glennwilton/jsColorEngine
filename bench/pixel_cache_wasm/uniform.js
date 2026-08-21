/**
 * Is the flat-content win reachable WITHOUT a pixel cache?
 *
 * A pixel cache cannot go in a SIMD kernel — you cannot branch per lane. But
 * the case it wins biggest on (3.5x) is flat content, and flat content has a
 * much simpler signature: THE FOUR PIXELS IN A SIMD BATCH ARE THE SAME PIXEL.
 * That is one comparison per batch, it works in SIMD, and it needs no memory,
 * no hash and no eviction policy.
 *
 * If uniform-batch rates on design-like content are high, the flat win is
 * available on the path everyone actually runs, and the hash cache is only
 * competing for the photo case — where it measured 1.04-1.15x on three of
 * five frames.
 */
'use strict';
const fs = require('fs'), path = require('path');
const CORPUS = path.join(__dirname, '..', 'release_matrix', 'corpus');

function stats(px, npx){
    let uni4 = 0, uni2 = 0, runTotal = 0, runs = 0, cur = 1;
    const same = (a, b) =>
        px[a*3] === px[b*3] && px[a*3+1] === px[b*3+1] && px[a*3+2] === px[b*3+2];
    for(let p = 0; p + 3 < npx; p += 4)
        if(same(p, p+1) && same(p, p+2) && same(p, p+3)) uni4++;
    for(let p = 0; p + 1 < npx; p += 2) if(same(p, p+1)) uni2++;
    for(let p = 1; p < npx; p++){
        if(same(p, p-1)) cur++;
        else { runTotal += cur; runs++; cur = 1; }
    }
    runTotal += cur; runs++;
    return {
        uni4: uni4 / Math.floor(npx / 4),
        uni2: uni2 / Math.floor(npx / 2),
        meanRun: runTotal / runs
    };
}

function noise(npx){
    const a = new Uint8ClampedArray(npx*3); let s = 0x13579bdf;
    for(let i = 0; i < a.length; i++){ s = (Math.imul(s,1103515245)+12345)&0x7fffffff; a[i] = (s>>>23)&0xff; }
    return a;
}
function solid(npx){
    const a = new Uint8ClampedArray(npx*3);
    for(let p = 0; p < npx; p++){ a[p*3]=91; a[p*3+1]=140; a[p*3+2]=37; }
    return a;
}

const items = [['solid', solid(1<<20)]];
for(const f of fs.readdirSync(CORPUS).filter(x => x.endsWith('.rgb.bin')).sort()){
    const b = fs.readFileSync(path.join(CORPUS, f));
    const a = new Uint8ClampedArray(b.length - (b.length % 3));
    a.set(b.subarray(0, a.length));
    items.push(['  ' + (f.split(/[-_.]/).filter(w => w === w.toUpperCase() && w.length > 3)[0] || f.slice(0,8)), a]);
}
items.push(['noise', noise(1<<20)]);

console.log('UNIFORM BATCHES — can SIMD skip work without a cache?\n');
console.log('content         4-px uniform  2-px uniform  mean run length');
for(const [name, a] of items){
    const s = stats(a, a.length / 3);
    console.log('  ' + name.padEnd(13) +
        (100*s.uni4).toFixed(1).padStart(11) + '%' +
        (100*s.uni2).toFixed(1).padStart(13) + '%' +
        s.meanRun.toFixed(2).padStart(16));
}
