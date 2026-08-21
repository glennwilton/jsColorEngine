// src/kernels/dispatchThreshold.js
//
// The batch size at which a WASM kernel starts beating its JS equivalent.
//
// WHY IT EXISTS AS A MODULE. This number was written twice — once in
// Transform.js as the public, overridable class static, and once in
// lutKernelTable.js, "kept in sync" by a comment, because the table is built at
// Transform.js load time and the static is not assigned until later. Splitting
// the table across the kernels (v1.6 phase 4d) would have made that three
// copies. One definition, required by everyone who needs it, is cheaper than
// three that agree by convention.
//
// WHAT IT ACTUALLY MEASURES. Calling into WASM means copying the pixels into
// linear memory and the results back out. Below some batch size that copy costs
// more than the faster kernel saves, and the JS variant wins. The dispatcher
// resolves BOTH candidates at create() and picks per call:
//
//     fn = (pixelCount >= threshold) ? big : small
//
// ONE NUMBER STANDING IN FOR SEVERAL. A 3-D int8 SIMD run copies 3 bytes per
// pixel in and 4 out; a 4-D int16 run copies 8 and 8, against a much larger
// table; the matrix-shaper kernel has no CLUT to upload at all. Those
// crossovers are not the same, and this is a single measured compromise across
// them. Phase 4e of docs/deepdive/KernelContract.md moves the threshold into
// each kernel's `arrayFor()` so a kernel can answer for its own break-even —
// at which point this module becomes the default rather than the rule.
//
// OVERRIDABLE BEFORE create(). `Transform.WASM_DISPATCH_MIN_PIXELS = 0` forces
// the WASM path at every size, which is how the break-even was measured in the
// first place and how it should be re-measured on new hardware.
'use strict';

module.exports = 256;
