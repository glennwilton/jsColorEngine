// src/kernels/5d/kernel5D_table.js
//
// 5-D dispatch: int8 WASM scalar → JS int8 → float. No SIMD / int16 this pass.
'use strict';

var loops = require('./kernel5D_loops.js');

function run_fl_5_n(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp5DArray_NCh_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_i_5_n(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp5DArray_NCh_intLut_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i8ws_5_n(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = ia ? 6 : 5;
    var outBPP = oa ? cMax + 1 : cMax;
    t.wasmTetra5D.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra5D.runTetra5D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
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
            if(hasIntLut && kernel.wasmTetra5D){
                return pick(run_i8ws_5_n, 'i8ws_5_n', run_i_5_n, 'i_5_n');
            }
            /* falls through */
        case 'int':
            if(hasIntLut) return pick(run_i_5_n, 'i_5_n', run_i_5_n, 'i_5_n');
            /* falls through */
        default:
            return pick(run_fl_5_n, 'fl_5_n', run_fl_5_n, 'fl_5_n');
    }
}

module.exports = { resolve: resolve };
