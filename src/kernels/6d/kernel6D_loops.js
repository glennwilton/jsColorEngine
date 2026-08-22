// src/kernels/6d/kernel6D_loops.js
//
// 6-channel input array loops. Same peel+tetra scheme as 5D with one more
// outer plane (F). Int8 is the WASM oracle.
'use strict';

var interp = require('../../interp.js');
var tetra = require('../nch/int8TetraLast3.js');

function alphaTail(input, inputPos, output, outputPos, inputHasAlpha, outputHasAlpha, preserveAlpha){
    if(preserveAlpha){
        output[outputPos++] = input[inputPos++];
    } else {
        if(inputHasAlpha) inputPos++;
        if(outputHasAlpha) output[outputPos++] = 255;
    }
    return { inputPos: inputPos, outputPos: outputPos };
}

function tetrahedralInterp6DArray_NCh_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
    var inCh = 6;
    var outCh = lut.outputChannels;
    var pixel = new Array(inCh);
    var p, c, o, result, tail;
    for(p = 0; p < length; p++){
        for(c = 0; c < inCh; c++) pixel[c] = input[inputPos++];
        result = interp.tetrahedralInterpND_NCh(pixel, lut);
        for(o = 0; o < outCh; o++) output[outputPos++] = Math.round(result[o]);
        tail = alphaTail(input, inputPos, output, outputPos, inputHasAlpha, outputHasAlpha, preserveAlpha);
        inputPos = tail.inputPos;
        outputPos = tail.outputPos;
    }
}

function tetrahedralInterp6DArray_NCh_intLut_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
    var gps = intLut.gridPointsScale_fixed | 0;
    var CLUT = intLut.CLUT;
    var go0 = intLut.go0 | 0;
    var go1 = intLut.go1 | 0;
    var go2 = intLut.go2 | 0;
    var go3 = intLut.go3 | 0;
    var go4 = intLut.go4 | 0;
    var go5 = intLut.go5 | 0;
    var cMax = intLut.outputChannels | 0;
    var scratchK = new Int32Array(cMax);
    var scratchE = new Int32Array(cMax);
    var scratchF = new Int32Array(cMax);
    var u20 = new Int32Array(cMax);
    var p, o, plane;
    var F, E, K, ax, ay, az;
    var fpass, epass, kpass, fLim, eLim, kLim;

    for(p = 0; p < length; p++){
        F = tetra.decodePeel(input[inputPos++], gps, go5, intLut.maxF | 0);
        E = tetra.decodePeel(input[inputPos++], gps, go4, intLut.maxE | 0);
        K = tetra.decodePeel(input[inputPos++], gps, go3, intLut.maxK | 0);
        ax = tetra.decodeAxis(input[inputPos++], gps, go2, intLut.maxX | 0);
        ay = tetra.decodeAxis(input[inputPos++], gps, go1, intLut.maxY | 0);
        az = tetra.decodeAxis(input[inputPos++], gps, go0, intLut.maxZ | 0);

        fLim = F.interp ? 2 : 1;
        eLim = E.interp ? 2 : 1;
        kLim = K.interp ? 2 : 1;
        for(fpass = 0; fpass < fLim; fpass++){
            for(epass = 0; epass < eLim; epass++){
                for(kpass = 0; kpass < kLim; kpass++){
                    plane = (F.lo + (fpass ? go5 : 0) + E.lo + (epass ? go4 : 0) + K.lo + (kpass ? go3 : 0)) | 0;
                    tetra.tetraU20(CLUT, ax.lo, ax.hi, ay.lo, ay.hi, az.lo, az.hi, plane, ax.r, ay.r, az.r, cMax, u20);
                    for(o = 0; o < cMax; o++){
                        var v = u20[o];
                        if(kpass === 0 && K.interp){ scratchK[o] = v; continue; }
                        if(kpass === 1) v = tetra.lerpU20(scratchK[o], v, K.r);
                        if(epass === 0 && E.interp){ scratchE[o] = v; continue; }
                        if(epass === 1) v = tetra.lerpU20(scratchE[o], v, E.r);
                        if(fpass === 0 && F.interp){ scratchF[o] = v; continue; }
                        output[outputPos++] = fpass === 1
                            ? tetra.emitU8Lerp(scratchF[o], v, F.r)
                            : tetra.emitU8(v);
                    }
                }
            }
        }

        var tail = alphaTail(input, inputPos, output, outputPos, inputHasAlpha, outputHasAlpha, preserveAlpha);
        inputPos = tail.inputPos;
        outputPos = tail.outputPos;
    }
}

module.exports = {
    tetrahedralInterp6DArray_NCh_loop: tetrahedralInterp6DArray_NCh_loop,
    tetrahedralInterp6DArray_NCh_intLut_loop: tetrahedralInterp6DArray_NCh_intLut_loop,
};
