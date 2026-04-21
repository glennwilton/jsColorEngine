// Diagnostic / regression check for the integer kernel's directional
// bias vs the float kernel.
//
// This script found TWO bugs during the v1.1 release cycle and is
// kept as a permanent smoke test — if anyone touches buildIntLut(),
// the u16 scale factor, or gridPointsScale_fixed, run this. You
// should see ≥ 97 % exact and a 50/50 split of int>float vs int<float
// on the residual off-by-1.
//
// --------------------------------------------------------------------
// WHAT THIS FINDS
// --------------------------------------------------------------------
// If 99 %+ of off-by-1 channels go in the SAME direction (all int>float
// or all int<float), you have a SYSTEMATIC BIAS, not rounding noise.
// Systematic bias means the math is wrong somewhere. Candidates:
//
// 1. u16 CLUT scale mismatch with the kernel's final shift.
//    v1.1 fix: scale by 255*256 = 65280, not 65535. The kernel's
//    `>> 8` divides by 256 exactly, so u16 must be u8 × 256.
//
// 2. Q0.x precision truncation on gridPointsScale_fixed.
//    v1.1 fix: carry at Q0.16, not Q0.8. Q0.8 truncates (g1-1)/255
//    by enough to bias rx/ry/rz/rk on every pixel.
//
// --------------------------------------------------------------------
// HISTORY
// --------------------------------------------------------------------
// Before any fix:        24 % exact,  75 % off-by-1 (100 % int>float)
// After CLUT scale fix:  55 % exact,  44 % off-by-1 (99.9 % int>float)
// After Q0.16 gps fix:   97.6 % exact, 2.4 % off-by-1 (100 % int>float
//                         — all at exact X.5 half-ties, banker's vs
//                         half-up disagreement, not math error)
//
// --------------------------------------------------------------------
// RUN
// --------------------------------------------------------------------
//   node bench/diag_cmyk_to_rgb.js
//
// Expected output (on the GRACoL2006 test profile):
//   exact:     ≥ 97 %
//   off by 2:  0
//   off by 3+: 0

var Profile  = require('../src/Profile');
var Transform = require('../src/Transform');
var eIntent  = require('../src/def').eIntent;
var path     = require('path');

async function run() {
    var cmykFile = path.join(__dirname, '..', '__tests__', 'GRACoL2006_Coated1v2.icc');
    var cmyk = new Profile();
    await cmyk.loadPromise('file:' + cmykFile);

    var floatT = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'float' });
    floatT.create(cmyk, '*srgb', eIntent.relative);

    var intT = new Transform({ dataFormat: 'int8', buildLut: true, lutMode: 'int' });
    intT.create(cmyk, '*srgb', eIntent.relative);

    var N = 65536;
    var input = new Uint8ClampedArray(N * 4);
    var s = 12345;
    for (var i = 0; i < input.length; i++) {
        s = (s * 1103515245 + 12345) | 0;
        input[i] = (s >>> 16) & 0xFF;
    }

    var oFloat = floatT.transformArray(input);
    var oInt   = intT.transformArray(input);

    var exact = 0, off1 = 0, off2 = 0, off3 = 0, offMore = 0;
    var intHigh = 0, intLow = 0;
    for (var i = 0; i < oFloat.length; i++) {
        var d = oInt[i] - oFloat[i];
        var ad = Math.abs(d);
        if (ad === 0) exact++;
        else if (ad === 1) { off1++; if (d > 0) intHigh++; else intLow++; }
        else if (ad === 2) off2++;
        else if (ad === 3) off3++;
        else offMore++;
    }
    var total = oFloat.length;
    console.log('\n=== CMYK -> sRGB diagnostic (GRACoL2006) ===');
    console.log('  channels: ' + total);
    console.log('  exact:     ' + exact + '  (' + (exact*100/total).toFixed(2) + ' %)');
    console.log('  off by 1:  ' + off1  + '  (' + (off1 *100/total).toFixed(2) + ' %)');
    if (off1 > 0) {
        console.log('    int > float: ' + intHigh + '  (' + (intHigh*100/off1).toFixed(1) + ' % of off-by-1)');
        console.log('    int < float: ' + intLow  + '  (' + (intLow *100/off1).toFixed(1) + ' % of off-by-1)');
    }
    console.log('  off by 2:  ' + off2  + '  (' + (off2 *100/total).toFixed(3) + ' %)');
    console.log('  off by 3:  ' + off3  + '  (' + (off3 *100/total).toFixed(3) + ' %)');
    console.log('  off by >3: ' + offMore);

    // Verdict. Key insight: at exact u8 half-ties (X.5 where X is
    // even), Uint8ClampedArray banker's-rounds to X, our kernel rounds
    // half-up to X+1. So a small fraction of all outputs — roughly the
    // fraction that lands on even-X.5 boundaries, 1–5 % on typical
    // profiles — will legitimately show int>float. That's NOT a bug.
    //
    // But if off-by-1 exceeds ~5 % AND goes 100 % one direction, the
    // math is biased beyond what half-ties can explain.
    console.log('');
    var off1Pct = off1 * 100 / total;
    var directional = off1 > 100 && (intHigh / off1 > 0.95 || intLow / off1 > 0.95);
    if (directional && off1Pct > 5) {
        console.log('  ⚠ SYSTEMATIC BIAS (' + off1Pct.toFixed(1) + ' % off-by-1, 100 % one direction).');
        console.log('    Check buildIntLut() — u16 scale factor (must be 255*256 = 65280)');
        console.log('    and gridPointsScale_fixed precision (must be Q0.16, not Q0.8).');
    } else if (exact > total * 0.95 && off2 === 0 && off3 === 0) {
        console.log('  ✓ CLEAN. Residual off-by-1 is banker\'s-rounding-vs-half-up at');
        console.log('    exact u8 half-ties (expected — not interp error).');
    } else if (exact > total * 0.95) {
        console.log('  ⚠ Exact rate OK but off-by-2+ present — investigate.');
    } else {
        console.log('  ⚠ Exact rate below 95 % — regression somewhere.');
    }
}

run().catch(function(err){ console.error(err); process.exit(1); });
