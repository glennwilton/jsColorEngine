// src/kernels/nch/int8TetraLast3.js
//
// Shared 6-case tetrahedral body for the last three axes, plus the u20
// peel helpers used by Kernel5D / Kernel6D JS int8 loops. Formulas match
// tetra4d_nch.wat bit-for-bit so the JS loop is the WASM oracle.
'use strict';

function lerpU20(lo, hi, r){
    return (lo + ((Math.imul(hi - lo, r) + 0x80) >> 8)) | 0;
}

function emitU8(u20){
    var u8 = (u20 + 0x800) >> 12;
    if(u8 < 0) u8 = 0;
    else if(u8 > 255) u8 = 255;
    return u8;
}

function emitU8Lerp(lo, hi, r){
    var u8 = ((lo << 8) + Math.imul(hi - lo, r) + 0x80000) >> 20;
    if(u8 < 0) u8 = 0;
    else if(u8 > 255) u8 = 255;
    return u8;
}

/**
 * Fill dest[0..cMax) with Q16.4 (u20) tetra results.
 * `plane` is the already-scaled extra-axis offset (K0+E0+… in LUT units).
 */
function tetraU20(CLUT, X0, X1, Y0, Y1, Z0, Z1, plane, rx, ry, rz, cMax, dest){
    var base0 = (X0 + Y0 + Z0 + plane) | 0;
    var base1, base2, base3, base4, o, a, b, c, d, sum;

    if(rx >= ry && ry >= rz){
        base1 = X1 + Y0 + Z0 + plane;
        base2 = X1 + Y1 + Z0 + plane;
        base4 = X1 + Y1 + Z1 + plane;
        for(o = 0; o < cMax; o++){
            a = CLUT[base1++]; b = CLUT[base2++]; c = CLUT[base0++]; d = CLUT[base4++];
            sum = Math.imul(a - c, rx) + Math.imul(b - a, ry) + Math.imul(d - b, rz);
            dest[o] = (c << 4) + ((sum + 0x08) >> 4);
        }
    } else if(rx >= rz && rz >= ry){
        base1 = X1 + Y0 + Z0 + plane;
        base2 = X1 + Y1 + Z1 + plane;
        base3 = X1 + Y0 + Z1 + plane;
        for(o = 0; o < cMax; o++){
            a = CLUT[base3++]; b = CLUT[base1++]; c = CLUT[base0++]; d = CLUT[base2++];
            sum = Math.imul(b - c, rx) + Math.imul(d - a, ry) + Math.imul(a - b, rz);
            dest[o] = (c << 4) + ((sum + 0x08) >> 4);
        }
    } else if(rx >= ry && rz >= rx){
        base1 = X1 + Y0 + Z1 + plane;
        base2 = X0 + Y0 + Z1 + plane;
        base3 = X1 + Y1 + Z1 + plane;
        for(o = 0; o < cMax; o++){
            a = CLUT[base1++]; b = CLUT[base2++]; c = CLUT[base0++]; d = CLUT[base3++];
            sum = Math.imul(a - b, rx) + Math.imul(d - a, ry) + Math.imul(b - c, rz);
            dest[o] = (c << 4) + ((sum + 0x08) >> 4);
        }
    } else if(ry >= rx && rx >= rz){
        base1 = X1 + Y1 + Z0 + plane;
        base2 = X0 + Y1 + Z0 + plane;
        base4 = X1 + Y1 + Z1 + plane;
        for(o = 0; o < cMax; o++){
            a = CLUT[base2++]; b = CLUT[base1++]; c = CLUT[base0++]; d = CLUT[base4++];
            sum = Math.imul(b - a, rx) + Math.imul(a - c, ry) + Math.imul(d - b, rz);
            dest[o] = (c << 4) + ((sum + 0x08) >> 4);
        }
    } else if(ry >= rz && rz >= rx){
        base1 = X1 + Y1 + Z1 + plane;
        base2 = X0 + Y1 + Z1 + plane;
        base3 = X0 + Y1 + Z0 + plane;
        for(o = 0; o < cMax; o++){
            a = CLUT[base2++]; b = CLUT[base3++]; c = CLUT[base0++]; d = CLUT[base1++];
            sum = Math.imul(d - a, rx) + Math.imul(b - c, ry) + Math.imul(a - b, rz);
            dest[o] = (c << 4) + ((sum + 0x08) >> 4);
        }
    } else if(rz >= ry && ry >= rx){
        base1 = X1 + Y1 + Z1 + plane;
        base2 = X0 + Y1 + Z1 + plane;
        base4 = X0 + Y0 + Z1 + plane;
        for(o = 0; o < cMax; o++){
            a = CLUT[base2++]; b = CLUT[base4++]; c = CLUT[base0++]; d = CLUT[base1++];
            sum = Math.imul(d - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c, rz);
            dest[o] = (c << 4) + ((sum + 0x08) >> 4);
        }
    } else {
        for(o = 0; o < cMax; o++) dest[o] = CLUT[base0++] << 4;
    }
}

function decodeAxis(input, gps, go, maxAt){
    var p = Math.imul(input, gps);
    if(input === 255) return { lo: maxAt, hi: maxAt, r: 0 };
    var idx = p >>> 16;
    return { lo: Math.imul(idx, go), hi: Math.imul(idx, go) + go, r: (p >>> 8) & 0xFF };
}

function decodePeel(input, gps, go, maxAt){
    var p = Math.imul(input, gps);
    if(input === 255) return { lo: maxAt, r: 0, interp: false };
    var r = (p >>> 8) & 0xFF;
    return { lo: Math.imul(p >>> 16, go), r: r, interp: r !== 0 };
}

module.exports = {
    lerpU20: lerpU20,
    emitU8: emitU8,
    emitU8Lerp: emitU8Lerp,
    tetraU20: tetraU20,
    decodeAxis: decodeAxis,
    decodePeel: decodePeel,
};
