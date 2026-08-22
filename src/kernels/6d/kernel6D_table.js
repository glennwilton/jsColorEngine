// src/kernels/6d/kernel6D_table.js
//
// 6-D dispatch: int8 WASM scalar → JS int8 → float. No SIMD / int16 this pass.
'use strict';

var loops = require('./kernel6D_loops.js');

function run_fl_6_n(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp6DArray_NCh_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_i_6_n(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp6DArray_NCh_intLut_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i8ws_6_n(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = ia ? 7 : 6;
    var outBPP = oa ? cMax + 1 : cMax;
    t.wasmTetra6D.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra6D.runTetra6D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

function resolve(kernel, lut){
    var hasIntLut = !!lut.intLut;
    var pick = function(big, bigName, small, smallName){
        return { big: big, small: small, bigName: bigName, smallName: smallName };
    };
    var mode = kernel.transform.lutMode;

    switch(mode){
        case 'int-wasm-simd':
        case 'int-wasm-scalar':
            if(hasIntLut && kernel.wasmTetra6D){
                return pick(run_i8ws_6_n, 'i8ws_6_n', run_i_6_n, 'i_6_n');
            }
            /* falls through */
        case 'int':
            if(hasIntLut) return pick(run_i_6_n, 'i_6_n', run_i_6_n, 'i_6_n');
            /* falls through */
        default:
            return pick(run_fl_6_n, 'fl_6_n', run_fl_6_n, 'fl_6_n');
    }
}

module.exports = { resolve: resolve };
