// src/kernels/gates.js
//
// The dimension-independent gate predicates for the LUT dispatch table.
//
// A gate answers "is this row eligible for this Transform and this LUT?", is
// checked once at create() and cached per Transform. Most gates are specific to
// a dimension -- they ask whether a particular WASM module loaded -- and live
// with their kernel. These three are not:
//
//   alwaysOk     the float rows, which are the terminus of every fallback
//                chain and can never be ineligible
//   alwaysFalse  a sparse cell, where the kernel does not cover this shape.
//                The row is kept rather than deleted so the table stays
//                exhaustive, and the resolver treats it as transparent
//                passthrough to `fallback`
//   needsIntLut  every integer row, JS or WASM, needs a built intLut
//
// They live here rather than in lutKernelTable.js because the per-kernel tables
// need them too, and a kernel requiring lutKernelTable would be circular --
// lutKernelTable requires the kernels to assemble the merged view.
'use strict';

function alwaysOk()   { return true; }
function alwaysFalse(){ return false; }
function needsIntLut(t, lut)  { return !!(lut && lut.intLut); }

module.exports = { alwaysOk: alwaysOk, alwaysFalse: alwaysFalse, needsIntLut: needsIntLut };
