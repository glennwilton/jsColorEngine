// src/kernels/4d/kernel4D_table.js
//
// The 4-D rows of the LUT dispatch table: which implementation runs for a
// given (lutMode, inputChannels, outputChannels), what has to be true for it to
// be eligible, and what it falls back to when it is not.
//
// MOVED HERE in v1.6 phase 4d (docs/deepdive/KernelContract.md). These rows
// lived in src/lutKernelTable.js alongside the 3-D ones. They belong to this
// kernel: every fallback chain in the table stays inside one input dimension --
// i8wsi_4_4 degrades to i8ws_4_4 to i_4_4 to fl_4_4, and never leaves 4-D -- so
// the table was two independent ladders sharing a file.
//
// What did NOT move: the resolver that walks a chain, the key format, and the
// lutMode-to-prefix map. Those are generic and stay in src/lutKernelTable.js,
// which assembles the merged view the dispatcher and the tests still read.
//
// STILL PARAMETERISED ON THE TRANSFORM. The WASM runs and gates take `t` for
// `t.outputChannels` and `t.wasmTetra*`. That is phase 4c's problem -- when the
// WASM state moves onto the kernel instance, these take the kernel instead and
// the last of the coupling goes with it.
'use strict';

var loops = require('./kernel4D_loops.js');
// var WASM_DISPATCH_MIN_PIXELS = require('../dispatchThreshold.js');

function run_fl_4_3(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_3Ch_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_fl_4_4(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_4Ch_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}
function run_fl_4_n(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_NCh_loop(input, 0, output, 0, px, lut, ia, oa, pa);
}

// ---- u8 JS integer ----------------------------------------------------------

function run_i_4_3(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_3Ch_intLut_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i_4_4(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_4Ch_intLut_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
// no _i_3_n / _i_4_n: integer NCh has no intLut variant — falls to fl

// ---- u16 JS integer ---------------------------------------------------------

function run_i16_4_3(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_3Ch_intLut16_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
function run_i16_4_4(t, input, output, px, lut, ia, oa, pa){
    loops.tetrahedralInterp4DArray_4Ch_intLut16_loop(input, 0, output, 0, px, lut.intLut, ia, oa, pa);
}
// no _i16_3_n / _i16_4_n: u16 NCh has no intLut16 variant — falls to i_*_n → fl

// ---- u8 WASM scalar (rolled n-channel kernel — supports any cMax) -----------

function run_i8ws_4(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = ia ? 5 : 4;
    var outBPP = oa ? cMax + 1 : cMax;
    t.wasmTetra4D.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra4D.runTetra4D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

// ---- u8 WASM SIMD (cMax ∈ {3, 4} only — same call shape as scalar) ----------

function run_i8wsi_4(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = ia ? 5 : 4;
    var outBPP = oa ? cMax + 1 : cMax;
    t.wasmTetra4DSimd.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra4DSimd.runTetra4D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

// ---- u16 WASM scalar (rolled n-channel kernel — supports any cMax) ----------

function run_i16ws_4(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = (ia ? 5 : 4) * 2;
    var outBPP = (oa ? cMax + 1 : cMax) * 2;
    t.wasmTetra4DInt16.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra4DInt16.runTetra4D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

// ---- u16 WASM SIMD (cMax ∈ {3, 4} only — same call shape as scalar u16) -----

function run_i16wsi_4(t, input, output, px, lut, ia, oa, pa){
    var cMax   = t.outputChannels;
    var inBPP  = (ia ? 5 : 4) * 2;
    var outBPP = (oa ? cMax + 1 : cMax) * 2;
    t.wasmTetra4DInt16Simd.bind(lut.intLut, px, cMax, inBPP, outBPP);
    t.wasmTetra4DInt16Simd.runTetra4D(input, 0, output, 0, px, lut.intLut, cMax, ia, oa, pa);
}

// ============================================================================
// THE TABLE — every cell is the ONE place to look for "what runs when?"
// ============================================================================

// ---- resolution ------------------------------------------------------------
//
// WHAT THIS REPLACED, AND WHY. Until v1.6 this was a 21-row table of
// {run, gate, minPx, fallback} keyed by strings like 'i8wsi_3_4', walked by a
// generic resolver in lutKernelTable.js that built the key, looked up the row,
// called a gate closure and followed `fallback` until something answered.
//
// That design was right when it was written: Transform.js dispatched for EVERY
// dimension from one flat table, so the table had to be data rather than code.
// Phase 4d moved the rows into the kernels that own them and phase 5 stopped
// Transform sequencing any of it -- at which point a kernel was reaching
// through kernelUtils and lutKernelTable, building a key string and walking a
// graph, to look up a table sitting in its own file. Five hops to read its own
// data.
//
// A kernel resolving its own dispatch does not need a lookup structure. It
// knows its variants. The whole 21-row degradation graph is the code below,
// and it is the same decision the table encoded -- verified against all 560
// combinations of (lutMode x outputChannels x WASM availability x intLut).
//
// TWO THINGS THE TABLE ENCODED THAT ARE EASY TO LOSE:
//
//   1. SIMD only covers outputChannels 3 and 4. Anything wider falls to the
//      scalar WASM kernel, which is rolled rather than unrolled.
//   2. THE u16 FAMILY HAS NO FLOAT TERMINUS. An int16 mode without a built
//      intLut THROWS rather than degrading, because the output container is a
//      Uint16Array and a u8 kernel writing into it would divide every value by
//      ~257 and look almost right. Losing this turns a loud failure into a
//      quiet wrong answer.

/**
 * Which run implements this LUT, for a big batch and for a small one.
 *
 * @param {object} kernel  kernel instance — holds the wasmTetra* states
 * @param {object} lut     the LUT about to be walked
 * @returns {{big:Function, small:Function, bigName:string, smallName:string}}
 */
function resolve(kernel, lut){
    var outCh    = lut.outputChannels;
    var narrow   = (outCh === 3 || outCh === 4);   // SIMD covers these only
    var hasIntLut = !!lut.intLut;

    // The JS variants, by output width. These are the SMALL answer in every
    // integer mode and the terminus of the u8 ladder.
    var floatRun  = (outCh === 3) ? run_fl_4_3  : (outCh === 4) ? run_fl_4_4  : run_fl_4_n;
    var floatName = (outCh === 3) ? 'fl_4_3'    : (outCh === 4) ? 'fl_4_4'    : 'fl_4_n';
    var u8Run     = (outCh === 3) ? run_i_4_3   : (outCh === 4) ? run_i_4_4   : run_fl_4_n;
    var u8Name    = (outCh === 3) ? 'i_4_3'     : (outCh === 4) ? 'i_4_4'     : 'fl_4_n';
    // WIDE OUTPUT FALLS TO FLOAT, NOT TO NOTHING. There is no JS u16 variant
    // past 4 output channels, and until v1.6 that made an int16 conversion to
    // 5CLR or wider THROW -- so CMYK -> 5CLR worked at 8 bits and was
    // unreachable at 16. Float is the legal cross-family landing point
    // because it scales through lut.outputScale at call time, which the
    // optimiser has already folded to 65535 for an int16 mode; a u8 kernel
    // could not, which is what the original terminus was guarding against.
    var u16Run    = (outCh === 3) ? run_i16_4_3 : (outCh === 4) ? run_i16_4_4 : run_fl_4_n;
    var u16Name   = (outCh === 3) ? 'i16_4_3'   : (outCh === 4) ? 'i16_4_4'   : 'fl_4_n';

    var pick = function(big, bigName, small, smallName){
        return { big: big, small: small, bigName: bigName, smallName: smallName };
    };

    var mode = kernel.transform.lutMode;

    // An int16 mode without a built intLut is misuse rather than a shape we
    // can serve: the caller asked for 16-bit integer kernels and the table they
    // read from was never built. Loud, because the alternative is a silent
    // fall to a path they did not ask for.
    //
    // ONLY WHEN A u16 RUN ACTUALLY EXISTS, i.e. narrow output. Above 4 output
    // channels there is no u16 kernel at all and u16Run is already the FLOAT
    // run -- float being a legal landing point for an int16 mode, because
    // lut.outputScale is folded to 65535 and it scales at call time. Throwing
    // there said "you did not build a table" about a table that could not have
    // helped.
    //
    // It was reachable and it threw. buildIntLut() does not produce a table for
    // more than 4 output channels, so EVERY dataFormat:'int16' conversion into
    // a 5-or-more-channel profile died here -- while the same conversion at
    // int8 worked, because the u8 ladder degrades to float. The u16 ladder had
    // no such rung. Found by the first int16 run of the B2A oracle, on a
    // 6-channel profile.
    //
    // The narrow case keeps throwing, and that asymmetry with int8 (which falls
    // to float silently) is worth a second look -- but it is a different
    // decision from this one and nothing has demonstrated it wrong.
    if(mode === 'int16' || mode === 'int16-wasm-scalar' || mode === 'int16-wasm-simd'){
        if(!hasIntLut && narrow){
            throw 'lutKernelTable: fallback chain exhausted from "'
                + (mode === 'int16' ? 'i16' : mode === 'int16-wasm-simd' ? 'i16wsi' : 'i16ws')
                + '_4_' + (narrow ? outCh : 'n') + '" (no float fallback?)';
        }
    }

    switch(mode){

        case 'int16-wasm-simd':
            if(hasIntLut && narrow && kernel.wasmTetra4DInt16Simd){
                return pick(run_i16wsi_4, 'i16wsi_4_' + outCh, u16Run, u16Name);
            }
            /* falls through */
        case 'int16-wasm-scalar':
            if(hasIntLut && kernel.wasmTetra4DInt16){
                return pick(run_i16ws_4, 'i16ws_4_' + (narrow ? outCh : 'n'), u16Run, u16Name);
            }
            /* falls through */
        case 'int16':
            // u16Run is the float run when the output is wider than 4 channels
            // — see the guard above. Narrow output with no intLut already threw.
            return pick(u16Run, u16Name, u16Run, u16Name);

        case 'int-wasm-simd':
            if(hasIntLut && narrow && kernel.wasmTetra4DSimd){
                return pick(run_i8wsi_4, 'i8wsi_4_' + outCh, u8Run, u8Name);
            }
            /* falls through */
        case 'int-wasm-scalar':
            if(hasIntLut && kernel.wasmTetra4D){
                return pick(run_i8ws_4, 'i8ws_4_' + (narrow ? outCh : 'n'), u8Run, u8Name);
            }
            /* falls through */
        case 'int':
            if(hasIntLut) return pick(u8Run, u8Name, u8Run, u8Name);
            /* falls through */
        default:
            return pick(floatRun, floatName, floatRun, floatName);
    }
}

module.exports = { resolve: resolve };
