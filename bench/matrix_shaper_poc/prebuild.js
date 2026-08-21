// prebuild.js — compile the v5 matrix-shaper WASM for browser use
//
// Extracts the sRGB→AdobeRGB fused matrix from the engine's virtual profiles,
// fills the v5 WAT template, compiles to binary via wabt, and writes
//   bench/matrix_shaper_poc/v5_srgb_adobe.wasm.js
//
// Run once before opening bench_browser.html:
//   node bench/matrix_shaper_poc/prebuild.js

'use strict';

const fs         = require('fs');
const path       = require('path');
const wabtFactory = require('wabt');
const { Profile } = require('../../src/main');

function mulMat(A, B) {
    return {
        m00: A.m00*B.m00 + A.m01*B.m10 + A.m02*B.m20,
        m01: A.m00*B.m01 + A.m01*B.m11 + A.m02*B.m21,
        m02: A.m00*B.m02 + A.m01*B.m12 + A.m02*B.m22,
        m10: A.m10*B.m00 + A.m11*B.m10 + A.m12*B.m20,
        m11: A.m10*B.m01 + A.m11*B.m11 + A.m12*B.m21,
        m12: A.m10*B.m02 + A.m11*B.m12 + A.m12*B.m22,
        m20: A.m20*B.m00 + A.m21*B.m10 + A.m22*B.m20,
        m21: A.m20*B.m01 + A.m21*B.m11 + A.m22*B.m21,
        m22: A.m20*B.m02 + A.m21*B.m12 + A.m22*B.m22,
    };
}

function genOutputEncode(lane, channel, byteOffset, maxVal, fwdBase) {
    const off = byteOffset > 0 ? ` offset=${byteOffset}` : '';
    return `
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (f32x4.extract_lane ${lane} (local.get ${channel})) (f32.const 0.0)) (f32.const 1.0)) (f32.const ${maxVal}.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const ${maxVal}) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const ${maxVal}))))
        (i32.store8${off} (local.get $outPos) (i32.load8_u (i32.add (i32.const ${fwdBase}) (local.get $ti))))`;
}

function genOutputEncodes(maxVal, fwdBase) {
    return [
        [0,'$vRo',0],[0,'$vGo',1],[0,'$vBo',2],
        [1,'$vRo',3],[1,'$vGo',4],[1,'$vBo',5],
        [2,'$vRo',6],[2,'$vGo',7],[2,'$vBo',8],
        [3,'$vRo',9],[3,'$vGo',10],[3,'$vBo',11],
    ].map(([l, c, o]) => genOutputEncode(l, c, o, maxVal, fwdBase)).join('');
}

const WAT_V5 = `(module
  (memory (export "memory") 400)  ;; 25.6 MB — fits 4M pixels in+out + gamma tables
  (func (export "run_simd_v5")
    (param $inputPtr i32) (param $outputPtr i32) (param $pixelCount i32)
    (local $p i32) (local $inPos i32) (local $outPos i32)
    (local $vR v128) (local $vG v128) (local $vB v128)
    (local $vRo v128) (local $vGo v128) (local $vBo v128)
    (local $ti i32)
    (local $cm00 v128) (local $cm01 v128) (local $cm02 v128)
    (local $cm10 v128) (local $cm11 v128) (local $cm12 v128)
    (local $cm20 v128) (local $cm21 v128) (local $cm22 v128)
    (local $tr f32) (local $tg f32) (local $tb f32)
    (local $tro f32) (local $tgo f32) (local $tbo f32)
    (local.set $inPos (local.get $inputPtr))
    (local.set $outPos (local.get $outputPtr))
    (local.set $cm00 (v128.const f32x4 {{m00}} {{m00}} {{m00}} {{m00}}))
    (local.set $cm01 (v128.const f32x4 {{m01}} {{m01}} {{m01}} {{m01}}))
    (local.set $cm02 (v128.const f32x4 {{m02}} {{m02}} {{m02}} {{m02}}))
    (local.set $cm10 (v128.const f32x4 {{m10}} {{m10}} {{m10}} {{m10}}))
    (local.set $cm11 (v128.const f32x4 {{m11}} {{m11}} {{m11}} {{m11}}))
    (local.set $cm12 (v128.const f32x4 {{m12}} {{m12}} {{m12}} {{m12}}))
    (local.set $cm20 (v128.const f32x4 {{m20}} {{m20}} {{m20}} {{m20}}))
    (local.set $cm21 (v128.const f32x4 {{m21}} {{m21}} {{m21}} {{m21}}))
    (local.set $cm22 (v128.const f32x4 {{m22}} {{m22}} {{m22}} {{m22}}))
    (block $simd_exit
      (loop $simd_loop
        (br_if $simd_exit (i32.gt_s (i32.add (local.get $p) (i32.const 4)) (local.get $pixelCount)))
        (local.set $vR (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
          (f32x4.splat (f32.load (i32.shl (i32.load8_u           (local.get $inPos)) (i32.const 2))))
          (f32.load    (i32.shl (i32.load8_u offset=3  (local.get $inPos)) (i32.const 2))))
          (f32.load    (i32.shl (i32.load8_u offset=6  (local.get $inPos)) (i32.const 2))))
          (f32.load    (i32.shl (i32.load8_u offset=9  (local.get $inPos)) (i32.const 2)))))
        (local.set $vG (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
          (f32x4.splat (f32.load (i32.shl (i32.load8_u offset=1  (local.get $inPos)) (i32.const 2))))
          (f32.load    (i32.shl (i32.load8_u offset=4  (local.get $inPos)) (i32.const 2))))
          (f32.load    (i32.shl (i32.load8_u offset=7  (local.get $inPos)) (i32.const 2))))
          (f32.load    (i32.shl (i32.load8_u offset=10 (local.get $inPos)) (i32.const 2)))))
        (local.set $vB (f32x4.replace_lane 3 (f32x4.replace_lane 2 (f32x4.replace_lane 1
          (f32x4.splat (f32.load (i32.shl (i32.load8_u offset=2  (local.get $inPos)) (i32.const 2))))
          (f32.load    (i32.shl (i32.load8_u offset=5  (local.get $inPos)) (i32.const 2))))
          (f32.load    (i32.shl (i32.load8_u offset=8  (local.get $inPos)) (i32.const 2))))
          (f32.load    (i32.shl (i32.load8_u offset=11 (local.get $inPos)) (i32.const 2)))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 12)))
        (local.set $vRo (f32x4.add (f32x4.add (f32x4.mul (local.get $vR) (local.get $cm00)) (f32x4.mul (local.get $vG) (local.get $cm01))) (f32x4.mul (local.get $vB) (local.get $cm02))))
        (local.set $vGo (f32x4.add (f32x4.add (f32x4.mul (local.get $vR) (local.get $cm10)) (f32x4.mul (local.get $vG) (local.get $cm11))) (f32x4.mul (local.get $vB) (local.get $cm12))))
        (local.set $vBo (f32x4.add (f32x4.add (f32x4.mul (local.get $vR) (local.get $cm20)) (f32x4.mul (local.get $vG) (local.get $cm21))) (f32x4.mul (local.get $vB) (local.get $cm22))))
${genOutputEncodes(4095, 1024)}
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 12)))
        (local.set $p      (i32.add (local.get $p)      (i32.const 4)))
        (br $simd_loop)))
    (block $tail_exit
      (loop $tail_loop
        (br_if $tail_exit (i32.ge_s (local.get $p) (local.get $pixelCount)))
        (local.set $tr  (f32.load (i32.shl (i32.load8_u           (local.get $inPos)) (i32.const 2))))
        (local.set $tg  (f32.load (i32.shl (i32.load8_u offset=1  (local.get $inPos)) (i32.const 2))))
        (local.set $tb  (f32.load (i32.shl (i32.load8_u offset=2  (local.get $inPos)) (i32.const 2))))
        (local.set $inPos (i32.add (local.get $inPos) (i32.const 3)))
        (local.set $tro (f32.add (f32.add (f32.mul (local.get $tr) (f32.const {{m00}})) (f32.mul (local.get $tg) (f32.const {{m01}}))) (f32.mul (local.get $tb) (f32.const {{m02}}))))
        (local.set $tgo (f32.add (f32.add (f32.mul (local.get $tr) (f32.const {{m10}})) (f32.mul (local.get $tg) (f32.const {{m11}}))) (f32.mul (local.get $tb) (f32.const {{m12}}))))
        (local.set $tbo (f32.add (f32.add (f32.mul (local.get $tr) (f32.const {{m20}})) (f32.mul (local.get $tg) (f32.const {{m21}}))) (f32.mul (local.get $tb) (f32.const {{m22}}))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tro) (f32.const 0.0)) (f32.const 1.0)) (f32.const 4095.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 4095) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 4095))))
        (i32.store8          (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tgo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 4095.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 4095) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 4095))))
        (i32.store8 offset=1 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $ti (i32.trunc_f32_u (f32.add (f32.mul (f32.min (f32.max (local.get $tbo) (f32.const 0.0)) (f32.const 1.0)) (f32.const 4095.0)) (f32.const 0.5))))
        (local.set $ti (select (i32.const 4095) (local.get $ti) (i32.gt_u (local.get $ti) (i32.const 4095))))
        (i32.store8 offset=2 (local.get $outPos) (i32.load8_u (i32.add (i32.const 1024) (local.get $ti))))
        (local.set $outPos (i32.add (local.get $outPos) (i32.const 3)))
        (local.set $p (i32.add (local.get $p) (i32.const 1)))
        (br $tail_loop)))
  )
)`;

async function main() {
    const srgb  = new Profile();
    const adobe = new Profile();
    await new Promise(r => srgb.load('*sRGB',     () => r()));
    await new Promise(r => adobe.load('*AdobeRGB', () => r()));

    const fused = mulMat(adobe.RGBMatrix.XYZMatrixInv, srgb.RGBMatrix.XYZMatrix);

    console.log('Fused sRGB→AdobeRGB matrix:');
    console.log(`  [ ${fused.m00.toFixed(6)}  ${fused.m01.toFixed(6)}  ${fused.m02.toFixed(6)} ]`);
    console.log(`  [ ${fused.m10.toFixed(6)}  ${fused.m11.toFixed(6)}  ${fused.m12.toFixed(6)} ]`);
    console.log(`  [ ${fused.m20.toFixed(6)}  ${fused.m21.toFixed(6)}  ${fused.m22.toFixed(6)} ]`);

    const wat = WAT_V5
        .replace(/\{\{m00\}\}/g, fused.m00.toFixed(10))
        .replace(/\{\{m01\}\}/g, fused.m01.toFixed(10))
        .replace(/\{\{m02\}\}/g, fused.m02.toFixed(10))
        .replace(/\{\{m10\}\}/g, fused.m10.toFixed(10))
        .replace(/\{\{m11\}\}/g, fused.m11.toFixed(10))
        .replace(/\{\{m12\}\}/g, fused.m12.toFixed(10))
        .replace(/\{\{m20\}\}/g, fused.m20.toFixed(10))
        .replace(/\{\{m21\}\}/g, fused.m21.toFixed(10))
        .replace(/\{\{m22\}\}/g, fused.m22.toFixed(10));

    const wabt   = await wabtFactory();
    const mod    = wabt.parseWat('v5_srgb_adobe.wat', wat, { multi_value: true, mutable_globals: true, simd: true });
    const { buffer } = mod.toBinary({});
    mod.destroy();
    const bytes  = Buffer.from(buffer);
    const base64 = bytes.toString('base64');

    const outPath = path.join(__dirname, 'v5_srgb_adobe.wasm.js');
    fs.writeFileSync(outPath, [
        '// AUTO-GENERATED — run: node bench/matrix_shaper_poc/prebuild.js',
        '// v5 matrix-shaper WASM, sRGB→AdobeRGB, 4096-entry output gamma table',
        `// ${bytes.length} bytes .wasm`,
        "'use strict';",
        `const BASE64 = '${base64}';`,
        'function decode(b64) {',
        "    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));",
        "    const bin = atob(b64); const out = new Uint8Array(bin.length);",
        "    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out;",
        '}',
        'const wasmV5Bytes = decode(BASE64);',
        "if (typeof module !== 'undefined') module.exports = wasmV5Bytes;",
        '',
    ].join('\n'));

    console.log(`Written: ${outPath}  (${bytes.length} bytes wasm / ${base64.length} bytes base64)`);
}

main().catch(err => { console.error(err); process.exit(1); });
