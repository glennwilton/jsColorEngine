// src/kernels/3d/kernel3D_loops.js
//
// 3D (RGB/Lab-input) LUT array loops — MOVED VERBATIM from src/Transform.js (v1.7 phase B,
// see docs/deepdive/KernelModules.md). Transform.js attaches these to
// Transform.prototype at load time (non-enumerable, matching class-method
// semantics), so `this` is the Transform instance and every call site —
// lutKernelTable run closures, kernel modules, tests — is unchanged.
//
// PURE FUNCTIONS OF THEIR ARGUMENTS. No `this`, no module-scope state — the
// last `this` in these files went when the N-channel loops were inlined in
// v1.6 phase 4a. Callers reach them through the module (phase 4b); the
// Transform.prototype attachment is kept for compatibility, not for binding.
// Do not add module-scope dependencies here.
'use strict';

module.exports = {
        /**
         * HOT PATH. 3D LUT, 3-channel input → 4-channel output.
         * Typical use: RGB → CMYK image conversion.
         * See HOT PATH header above for the contract and trade-offs that apply
         * to all functions in this group.
         */
        tetrahedralInterp3DArray_4Ch_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var rx,ry,rz;
            var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2
            var base1,base2, base3, base4,
                c0,c1,c2,c3, a, b

            var outputScale = lut.outputScale;
            var gridPointsScale = (lut.g1 - 1) * lut.inputScale;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;
            var go2 = lut.go2;

            for(var p = 0; p < length; p++) {

                // We need some clipping here
                input0 = input[inputPos++];
                input1 = input[inputPos++];
                input2 = input[inputPos++];

                // No clipping checks for speed needed for clamped arrays

                // Rather than divide input by 255 then multiply by (lut.g1 - 1)
                // Just do this once, this means input0 stays an int and
                // only px needs to be a float
                px = input0 * gridPointsScale;
                py = input1 * gridPointsScale;
                pz = input2 * gridPointsScale;

                //
                // A few optimisations here, X0 is multiplied by go2, which is precalculated grid x outputChannels
                // Keeping input0 as int means we can just check input0 === 255 rather than input0 >= 1.0 as a float
                // And rather than X0+1 we can just do X0 + offset to location in lut
                //
                // TODO (B2): The (inputN === 255) upper-edge clamps below are
                // ONLY correct for 8-bit input. The same pattern is duplicated
                // across 6 _loop functions and is reused by the (commented-out)
                // _loop_16bit variants. When re-enabling 16-bit, swap each
                // `(inputN === 255)` for the type-independent `(XN === gridEnd)`
                // (where gridEnd = lut.g1 - 1) in ALL copies. Same speed.
                X0 = ~~px; //~~ is the same as Math.floor(px)
                rx = (px - X0); // get the fractional part
                X0 *= go2; // change to index in array
                X1 = (input0 === 255) ? X0 : X0 + go2; // work out next index

                Y0 = ~~py;
                ry = (py - Y0);
                Y0 *= go1;
                Y1 = (input1 === 255) ? Y0 : Y0 + go1;

                Z0 = ~~pz;
                rz = (pz - Z0);
                Z0 *= go0;
                Z1 = (input2 === 255) ? Z0 : Z0 + go0;

                // Starting point in CLUT
                // Note that X0, Y0, Z0 are all multiplied by the grid offset and the outputChannels
                // So we only need additions rather than n = ((X0 * go2) + (Y0 * go1) + Z0)) * outputChannels
                base1 = X0 + Y0 + Z0;
                c0 = CLUT[base1++];
                c1 = CLUT[base1++];
                c2 = CLUT[base1++];
                c3 = CLUT[base1];

                if (rx >= ry && ry >= rz) {
                    // block1
                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z0;
                    //base3 = base1; SAME AS base1
                    base4 = X1 + Y1 + Z1;
                    //base5 = base2; SAME as base2

                    // Important performance issues noted in Chrome and Firefox, assigning intermediate variables slows things down a lot
                    // Just having one long line of code is much faster, I suspect internally all this math is done in registers,
                    // as the JIT can see that variables are not used, so it can just do the math and store the result
                    // If we were to use intermediate variables forces the compiler to read/write memory and potentially trigger the GC
                    // However using a/b below to read only once from the array does appear to be faster, The less memory reads the better
                    //
                    // Note that baseN is increased after each read from the array to move to the next channel
                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                    // Duno if this helps, but no need to increase base1/2/3/4 again as we are done with them
                    a = CLUT[base1  ];
                    b = CLUT[base2  ];
                    output[outputPos++] = (c3 + ((a - c3) * rx) +  ((b - a) * ry) + ((CLUT[base4  ] - b) * rz)) * outputScale;

                } else if (rx >= rz && rz >= ry) {
                    // block2

                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z1;
                    base3 = X1 + Y0 + Z1;
                    //base4 = base3;
                    //base5 = base1;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[outputPos++] =( c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[outputPos++] =( c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[outputPos++] =( c2 + ((b - c2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                    a = CLUT[base3];
                    b = CLUT[base1];
                    output[outputPos++] =( c3 + ((b - c3) * rx) + ((CLUT[base2  ] - a) * ry) + ((a - b) * rz) ) * outputScale;

                } else if (rx >= ry && rz >= rx) {
                    // block3

                    base1 = X1 + Y0 + Z1;
                    base2 = X0 + Y0 + Z1;
                    base3 = X1 + Y1 + Z1;
                    //base4 = base1;
                    //base5 = base2;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (c2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c2) * rz)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (c3 + ((a - b) * rx) + ((CLUT[base3  ] - a) * ry) + ((b - c3) * rz)) * outputScale;

                } else if (ry >= rx && rx >= rz) {
                    // block4

                    base1 = X1 + Y1 + Z0;
                    base2 = X0 + Y1 + Z0;
                    //base3 = base2;
                    base4 = X1 + Y1 + Z1;
                    //base5 = base1;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[outputPos++] = (c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[outputPos++] = (c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[outputPos++] = (c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                    a = CLUT[base2];
                    b = CLUT[base1];
                    output[outputPos++] = (c3 + ((b - a) * rx) + ((a - c3) * ry) + ((CLUT[base4  ] - b) * rz) ) * outputScale;

                } else if (ry >= rz && rz >= rx) {
                    // block5

                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    base3 = X0 + Y1 + Z0;
                    //base4 = base2;
                    //base5 = base3;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[outputPos++] = (c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz) ) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[outputPos++] = (c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz) ) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[outputPos++] = (c2 + ((CLUT[base1++] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz) ) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[outputPos++] = (c3 + ((CLUT[base1++] - a) * rx) + ((b - c3) * ry) + ((a - b) * rz) ) * outputScale;

                } else if (rz >= ry && ry >= rx) {
                    // block6

                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    //base3 = base2;
                    base4 = X0 + Y0 + Z1;
                    //base5 = base4;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[outputPos++] = (c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ) * outputScale;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[outputPos++] = (c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz) ) * outputScale;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[outputPos++] = (c2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz) ) * outputScale;

                    a = CLUT[base2]
                    b = CLUT[base4]
                    output[outputPos++] = (c3 + ((CLUT[base1  ] - a) * rx) + ((a - b) * ry) + ((b - c3) * rz) ) * outputScale;

                } else {
                    output[outputPos++] = c0 * outputScale;
                    output[outputPos++] = c1 * outputScale;
                    output[outputPos++] = c2 * outputScale;
                    output[outputPos++] = c3 * outputScale;

                }

                if(preserveAlpha) {
                    output[outputPos++] = input[inputPos++];
                } else {
                    if(inputHasAlpha)  { inputPos++;  }
                    if(outputHasAlpha) {
                        output[outputPos++] = 255;
                    }
                }

            }
        },

        /**
         * INT HOT PATH. 3D LUT, 3-channel input → 4-channel output.
         * Integer-math sibling of tetrahedralInterp3DArray_4Ch_loop.
         * Used when lutMode='int' is set. Reads 4 LUT values per CLUT
         * lookup (one extra channel write per sub-block vs the 3Ch variant).
         * See INTEGER HOT PATH header above tetrahedralInterp3DArray_3Ch_intLut_loop
         * for the math contract and tuning notes.
         */
        tetrahedralInterp3DArray_4Ch_intLut_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var rx = 0|0, ry = 0|0, rz = 0|0;
            var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0;
            var px = 0|0, py = 0|0, pz = 0|0;
            var input0 = 0|0, input1 = 0|0, input2 = 0|0;
            var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
            var c0 = 0|0, c1 = 0|0, c2 = 0|0, c3 = 0|0, a = 0|0, b = 0|0;

            var gps  = intLut.gridPointsScale_fixed | 0;
            var CLUT = intLut.CLUT;
            var go0  = intLut.go0 | 0;
            var go1  = intLut.go1 | 0;
            var go2  = intLut.go2 | 0;
            var maxX = intLut.maxX | 0;
            var maxY = intLut.maxY | 0;
            var maxZ = intLut.maxZ | 0;

            for(var p = 0; p < length; p++) {
                input0 = input[inputPos++];
                input1 = input[inputPos++];
                input2 = input[inputPos++];

                px = Math.imul(input0, gps);
                py = Math.imul(input1, gps);
                pz = Math.imul(input2, gps);

                if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
                else { X0 = px >>> 16; rx = (px >>> 8) & 0xFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

                if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
                else { Y0 = py >>> 16; ry = (py >>> 8) & 0xFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

                if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
                else { Z0 = pz >>> 16; rz = (pz >>> 8) & 0xFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

                base1 = X0 + Y0 + Z0;
                c0 = CLUT[base1++];
                c1 = CLUT[base1++];
                c2 = CLUT[base1++];
                c3 = CLUT[base1];

                if (rx >= ry && ry >= rz) {
                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z0;
                    base4 = X1 + Y1 + Z1;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base1];   b = CLUT[base2];
                    output[outputPos++] = ((c3 + ((Math.imul(a - c3, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                } else if (rx >= rz && rz >= ry) {
                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z1;
                    base3 = X1 + Y0 + Z1;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = ((c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = ((c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = ((c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base3];   b = CLUT[base1];
                    output[outputPos++] = ((c3 + ((Math.imul(b - c3, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                } else if (rx >= ry && rz >= rx) {
                    base1 = X1 + Y0 + Z1;
                    base2 = X0 + Y0 + Z1;
                    base3 = X1 + Y1 + Z1;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c2, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((c3 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c3, rz) + 0x80) >> 8)) + 0x80) >> 8;
                } else if (ry >= rx && rx >= rz) {
                    base1 = X1 + Y1 + Z0;
                    base2 = X0 + Y1 + Z0;
                    base4 = X1 + Y1 + Z1;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = ((c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = ((c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = ((c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2];   b = CLUT[base1];
                    output[outputPos++] = ((c3 + ((Math.imul(b - a, rx) + Math.imul(a - c3, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                } else if (ry >= rz && rz >= rx) {
                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    base3 = X0 + Y1 + Z0;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = ((c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = ((c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = ((c2 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2];   b = CLUT[base3];
                    output[outputPos++] = ((c3 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c3, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                } else if (rz >= ry && ry >= rx) {
                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    base4 = X0 + Y0 + Z1;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = ((c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = ((c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = ((c2 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2];   b = CLUT[base4];
                    output[outputPos++] = ((c3 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c3, rz) + 0x80) >> 8)) + 0x80) >> 8;
                } else {
                    output[outputPos++] = (c0 + 0x80) >> 8;
                    output[outputPos++] = (c1 + 0x80) >> 8;
                    output[outputPos++] = (c2 + 0x80) >> 8;
                    output[outputPos++] = (c3 + 0x80) >> 8;
                }

                if(preserveAlpha) {
                    output[outputPos++] = input[inputPos++];
                } else {
                    if(inputHasAlpha)  { inputPos++;  }
                    if(outputHasAlpha) {
                        output[outputPos++] = 255;
                    }
                }
            }
        },

        /**
         * HOT PATH. 3D LUT, 3-channel input → N-channel output (N != 3 and N != 4).
         * Typical use: RGB → 5+-channel inks (n-color separations).
         *
         * TODO (B3): Currently delegates to tetrahedralInterp3D_NCh per pixel and
         * allocates per-pixel arrays. Should be inlined like the 3Ch / 4Ch
         * variants for image-grade speed on n-color workflows.
         *
         * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop.
         */
        tetrahedralInterp3DArray_NCh_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha) {
            // INLINED in v1.6 phase 4. This used to call
            // tetrahedralInterp3D_NCh once per pixel, which returned a fresh
            // `new Array(outputChannels)` every time -- and it is the RGB ->
            // 6CLR / 8CLR n-colour separation path, so it is not a corner. The
            // same fix as the 1-D and 2-D loops got in phase 2.
            //
            // Derived from tetrahedralInterp3D_NCh rather than transcribed from
            // the _4Ch loop: the six simplex branches pair their differences
            // with the fractions differently, so there is no shared channel
            // loop to factor out, and copying the wrong branch would be a
            // plausible-looking wrong answer. The maths below is that function
            // with the LUT reads hoisted out of the pixel loop and the result
            // written straight to the destination.
            var rx, ry, rz;
            var X0, X1, Y0, Y1, Z0, Z1, px, py, pz;
            var base0, base1, base2, base3, base4, a, b, c, o;

            var outputScale = lut.outputScale;
            var outputChannels = lut.outputChannels;
            var gridEnd = (lut.g1 - 1);
            var gridPointsScale = gridEnd * lut.inputScale;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;
            var go2 = lut.go2;

            for(var p = 0; p < length; p++) {
                // Scale FIRST, then clamp in grid space — the LUT may be baked
                // (inputScale = 1/255) or an ICC LUT in device 0..1.
                px = input[inputPos++] * gridPointsScale;
                if(px < 0){ px = 0; } else if(px > gridEnd){ px = gridEnd; }
                py = input[inputPos++] * gridPointsScale;
                if(py < 0){ py = 0; } else if(py > gridEnd){ py = gridEnd; }
                pz = input[inputPos++] * gridPointsScale;
                if(pz < 0){ pz = 0; } else if(pz > gridEnd){ pz = gridEnd; }

                X0 = ~~px;
                rx = (px - X0);
                if(X0 === gridEnd){
                    X1 = X0 *= go2;
                } else {
                    X0 *= go2;
                    X1 = X0 + go2;
                }

                Y0 = ~~py;
                ry = (py - Y0);
                if(Y0 === gridEnd){
                    Y1 = Y0 *= go1;
                } else {
                    Y0 *= go1;
                    Y1 = Y0 + go1;
                }

                Z0 = ~~pz;
                rz = (pz - Z0);
                if(Z0 === gridEnd){
                    Z1 = Z0 *= go0;
                } else {
                    Z0 *= go0;
                    Z1 = Z0 + go0;
                }

                base0 = X0 + Y0 + Z0;

                if (rx >= ry && ry >= rz) {
                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z0;
                    base4 = X1 + Y1 + Z1;
                    for(o = 0; o < outputChannels; o++){
                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        c = CLUT[base0++];
                        output[outputPos++] = (c + ((a - c) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;
                    }

                } else if (rx >= rz && rz >= ry) {
                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z1;
                    base3 = X1 + Y0 + Z1;
                    for(o = 0; o < outputChannels; o++){
                        a = CLUT[base3++];
                        b = CLUT[base1++];
                        c = CLUT[base0++];
                        output[outputPos++] = (c + ((b - c) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) * outputScale;
                    }

                } else if (rx >= ry && rz >= rx) {
                    base1 = X1 + Y0 + Z1;
                    base2 = X0 + Y0 + Z1;
                    base3 = X1 + Y1 + Z1;
                    for(o = 0; o < outputChannels; o++){
                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        c = CLUT[base0++];
                        output[outputPos++] = (c + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c) * rz)) * outputScale;
                    }

                } else if (ry >= rx && rx >= rz) {
                    base1 = X1 + Y1 + Z0;
                    base2 = X0 + Y1 + Z0;
                    base4 = X1 + Y1 + Z1;
                    for(o = 0; o < outputChannels; o++){
                        a = CLUT[base2++];
                        b = CLUT[base1++];
                        c = CLUT[base0++];
                        output[outputPos++] = (c + ((b - a) * rx) + ((a - c) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;
                    }

                } else if (ry >= rz && rz >= rx) {
                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    base3 = X0 + Y1 + Z0;
                    for(o = 0; o < outputChannels; o++){
                        a = CLUT[base2++];
                        b = CLUT[base3++];
                        c = CLUT[base0++];
                        output[outputPos++] = (c + ((CLUT[base1++] - a) * rx) + ((b - c) * ry) + ((a - b) * rz)) * outputScale;
                    }

                } else if (rz >= ry && ry >= rx) {
                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    base4 = X0 + Y0 + Z1;
                    for(o = 0; o < outputChannels; o++){
                        a = CLUT[base2++];
                        b = CLUT[base4++];
                        c = CLUT[base0++];
                        output[outputPos++] = (c + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c) * rz) ) * outputScale;
                    }

                } else {
                    for(o = 0; o < outputChannels; o++){
                        output[outputPos++] = CLUT[base0++] * outputScale;
                    }
                }

                if(preserveAlpha) {
                    output[outputPos++] = input[inputPos++];
                } else {
                    if(inputHasAlpha)  { inputPos++;  }
                    if(outputHasAlpha) {
                        output[outputPos++] = 255;
                    }
                }
            }
        },

        /**
         * HOT PATH. 3D LUT, 3-channel input → 3-channel output.
         * Typical use: RGB → RGB image conversion (e.g. sRGB → AdobeRGB) and
         * RGB → Lab analysis pipelines.
         *
         * The most-exercised inner loop in this file. See HOT PATH header above
         * tetrahedralInterp3DArray_4Ch_loop for the contract and trade-offs.
         */
        tetrahedralInterp3DArray_3Ch_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var rx,ry,rz,
                X0,X1,Y0,
                Y1,Z0,Z1,
                px,py,pz,
                input0, input1, input2
            var base1,base2,base3,base4,
                c0,c1,c2, a, b

            var outputScale = lut.outputScale;
            var gridPointsScale = (lut.g1 - 1) * lut.inputScale;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;
            var go2 = lut.go2;

            for(var p = 0; p < length; p++) {

                // We need some clipping here
                input0 = input[inputPos++];
                input1 = input[inputPos++];
                input2 = input[inputPos++];

                // No clipping checks for speed needed for clamped arrays

                // Rather than divide input by 255 then multiply by (lut.g1 - 1)
                // Just do this once, this means input0 stays an int and
                // only px needs to be a float
                px = input0 * gridPointsScale;
                py = input1 * gridPointsScale;
                pz = input2 * gridPointsScale;

                //
                // A few optimisations here, X0 is multiplied by go2, which is precalculated grid x outputChannels
                // Keeping input0 as int means we can just check input0 === 255 rather than input0 >= 1.0 as a float
                // And rather than X0+1 we can just do X0 + offset to location in lut
                X0 = ~~px; //~~ is the same as Math.floor(px)
                rx = (px - X0); // get the fractional part
                X0 *= go2; // change to index in array
                X1 = (input0 === 255) ? X0 : X0 + go2; // work out next index

                Y0 = ~~py;
                ry = (py - Y0);
                Y0 *= go1;
                Y1 = (input1 === 255) ? Y0 : Y0 + go1;

                Z0 = ~~pz;
                rz = (pz - Z0);
                Z0 *= go0;
                Z1 = (input2 === 255) ? Z0 : Z0 + go0;

                // Starting point in CLUT
                // Note that X0, Y0, Z0 are all multiplied by the grid offset and the outputChannels
                // So we only need additions rather than n = ((X0 * go2) + (Y0 * go1) + Z0)) * outputChannels
                base1 = X0 + Y0 + Z0;
                c0 = CLUT[base1++];
                c1 = CLUT[base1++];
                c2 = CLUT[base1];

                if (rx >= ry && ry >= rz) {
                    // block1
                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z0;
                    //base3 = base1; SAME AS base1
                    base4 = X1 + Y1 + Z1;
                    //base5 = base2; SAME as base2

                    // Important performance issues noted in Chrome and Firefox, assigning intermediate variables slows things down a lot
                    // Just having one long line of code is much faster, I suspect internally all this math is done in registers,
                    // as the JIT can see that variables are not used, so it can just do the math and store the result
                    // If we were to use intermediate variables forces the compiler to read/write memory and potentially trigger the GC
                    // However using a/b below to read only once from the array does appear to be faster, The less memory reads the better
                    //
                    // Note that baseN is increased after each read from the array to move to the next channel
                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                    a = CLUT[base1];
                    b = CLUT[base2];
                    output[outputPos++] = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4] - b) * rz)) * outputScale;


                } else if (rx >= rz && rz >= ry) {
                    // block2

                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z1;
                    base3 = X1 + Y0 + Z1;
                    //base4 = base3;
                    //base5 = base1;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[outputPos++] =( c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[outputPos++] =( c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                    a = CLUT[base3];
                    b = CLUT[base1];
                    output[outputPos++] =( c2 + ((b - c2) * rx) + ((CLUT[base2] - a) * ry) + ((a - b) * rz) ) * outputScale;



                } else if (rx >= ry && rz >= rx) {
                    // block3

                    base1 = X1 + Y0 + Z1;
                    base2 = X0 + Y0 + Z1;
                    base3 = X1 + Y1 + Z1;
                    //base4 = base1;
                    //base5 = base2;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[outputPos++] = (c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz)) * outputScale;

                    a = CLUT[base1];
                    b = CLUT[base2];
                    output[outputPos++] = (c2 + ((a - b) * rx) + ((CLUT[base3] - a) * ry) + ((b - c2) * rz)) * outputScale;



                } else if (ry >= rx && rx >= rz) {
                    // block4

                    base1 = X1 + Y1 + Z0;
                    base2 = X0 + Y1 + Z0;
                    //base3 = base2;
                    base4 = X1 + Y1 + Z1;
                    //base5 = base1;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[outputPos++] = (c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[outputPos++] = (c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                    a = CLUT[base2];
                    b = CLUT[base1];
                    output[outputPos++] = (c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4] - b) * rz) ) * outputScale;


                } else if (ry >= rz && rz >= rx) {
                    // block5

                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    base3 = X0 + Y1 + Z0;
                    //base4 = base2;
                    //base5 = base3;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[outputPos++] = (c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz) ) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[outputPos++] = (c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz) ) * outputScale;

                    a = CLUT[base2];
                    b = CLUT[base3];
                    output[outputPos++] = (c2 + ((CLUT[base1] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz) ) * outputScale;


                } else if (rz >= ry && ry >= rx) {
                    // block6

                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    //base3 = base2;
                    base4 = X0 + Y0 + Z1;
                    //base5 = base4;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[outputPos++] = (c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ) * outputScale;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[outputPos++] = (c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz) ) * outputScale;

                    a = CLUT[base2]
                    b = CLUT[base4]
                    output[outputPos++] = (c2 + ((CLUT[base1] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz) ) * outputScale;

                } else {
                    output[outputPos++] = c0 * outputScale;
                    output[outputPos++] = c1 * outputScale;
                    output[outputPos++] = c2 * outputScale;
                }

                // Alpha handling — MUST be inside the per-pixel loop. Was previously
                // outside the for, which silently broke alpha preservation for any
                // RGB->RGB / RGB->Lab LUT image transform with more than one pixel
                // (e.g. soft-proof chains). See bug fix in CHANGELOG.
                if(preserveAlpha) {
                    output[outputPos++] = input[inputPos++];
                } else {
                    if(inputHasAlpha)  { inputPos++;  }
                    if(outputHasAlpha) {
                        output[outputPos++] = 255;
                    }
                }
            }
        },

        /**
         * INT HOT PATH. 3D LUT, 3-channel input → 3-channel output.
         * Integer-math sibling of tetrahedralInterp3DArray_3Ch_loop.
         * Used when lutMode='int' is set. See INTEGER HOT PATH header above.
         */
        tetrahedralInterp3DArray_3Ch_intLut_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var rx = 0|0, ry = 0|0, rz = 0|0;
            var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0;
            var px = 0|0, py = 0|0, pz = 0|0;
            var input0 = 0|0, input1 = 0|0, input2 = 0|0;
            var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
            var c0 = 0|0, c1 = 0|0, c2 = 0|0, a = 0|0, b = 0|0;

            var gps  = intLut.gridPointsScale_fixed | 0;
            var CLUT = intLut.CLUT;
            var go0  = intLut.go0 | 0;
            var go1  = intLut.go1 | 0;
            var go2  = intLut.go2 | 0;
            var maxX = intLut.maxX | 0;
            var maxY = intLut.maxY | 0;
            var maxZ = intLut.maxZ | 0;

            for(var p = 0; p < length; p++) {
                input0 = input[inputPos++];
                input1 = input[inputPos++];
                input2 = input[inputPos++];

                px = Math.imul(input0, gps);
                py = Math.imul(input1, gps);
                pz = Math.imul(input2, gps);

                // Per-axis input===255 boundary patch (FINDING #2 in bench).
                if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
                else { X0 = px >>> 16; rx = (px >>> 8) & 0xFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

                if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
                else { Y0 = py >>> 16; ry = (py >>> 8) & 0xFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

                if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
                else { Z0 = pz >>> 16; rz = (pz >>> 8) & 0xFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

                base1 = X0 + Y0 + Z0;
                c0 = CLUT[base1++];
                c1 = CLUT[base1++];
                c2 = CLUT[base1];

                if (rx >= ry && ry >= rz) {
                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z0;
                    base4 = X1 + Y1 + Z1;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base1];   b = CLUT[base2];
                    output[outputPos++] = ((c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                } else if (rx >= rz && rz >= ry) {
                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z1;
                    base3 = X1 + Y0 + Z1;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = ((c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = ((c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base3];   b = CLUT[base1];
                    output[outputPos++] = ((c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                } else if (rx >= ry && rz >= rx) {
                    base1 = X1 + Y0 + Z1;
                    base2 = X0 + Y0 + Z1;
                    base3 = X1 + Y1 + Z1;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = ((c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base1];   b = CLUT[base2];
                    output[outputPos++] = ((c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c2, rz) + 0x80) >> 8)) + 0x80) >> 8;
                } else if (ry >= rx && rx >= rz) {
                    base1 = X1 + Y1 + Z0;
                    base2 = X0 + Y1 + Z0;
                    base4 = X1 + Y1 + Z1;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = ((c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = ((c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2];   b = CLUT[base1];
                    output[outputPos++] = ((c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                } else if (ry >= rz && rz >= rx) {
                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    base3 = X0 + Y1 + Z0;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = ((c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = ((c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2];   b = CLUT[base3];
                    output[outputPos++] = ((c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x80) >> 8)) + 0x80) >> 8;
                } else if (rz >= ry && ry >= rx) {
                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    base4 = X0 + Y0 + Z1;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = ((c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = ((c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x80) >> 8)) + 0x80) >> 8;
                    a = CLUT[base2];   b = CLUT[base4];
                    output[outputPos++] = ((c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x80) >> 8)) + 0x80) >> 8;
                } else {
                    output[outputPos++] = (c0 + 0x80) >> 8;
                    output[outputPos++] = (c1 + 0x80) >> 8;
                    output[outputPos++] = (c2 + 0x80) >> 8;
                }

                // Alpha handling — same shape as the float sibling above.
                if(preserveAlpha) {
                    output[outputPos++] = input[inputPos++];
                } else {
                    if(inputHasAlpha)  { inputPos++;  }
                    if(outputHasAlpha) {
                        output[outputPos++] = 255;
                    }
                }
            }
        },

        /**
         * INT16 HOT PATH (v1.3, Q0.13). 3D LUT, 3-channel input → 3-channel output.
         * Typical use: u16 RGB→RGB / RGB→Lab image conversion (PNG-16,
         * TIFF-16). See the INT16 HOT PATH header above for the design
         * overview. Mirror structure of tetrahedralInterp3DArray_3Ch_intLut_loop
         * (the u8 sibling) — same 6 tetra cases, same boundary patch, same
         * Math.imul style. Differences from the u8 sibling, reading
         * outwards from the inner loop:
         *
         *   - rx/ry/rz extracted as u13 (`px & 0x1FFF`) — the bottom 13
         *     bits of the Q0.13 grid coordinate (was `(px >>> 8) & 0xFF`
         *     in u8). Boundary check `=== 65535` (was 255).
         *   - X0 derived from `px >>> 13` (was `>>> 16`).
         *   - Per-output-channel: `v = c + ((sum + 0x1000) >> 13)` (was
         *     `(... + 0x80) >> 8`). NO `v + (v >>> 8)` bit-stretch — the
         *     u16 CLUT already covers [0, 65535].
         *   - Degenerate fallback: writes `c0`/`c1`/`c2` directly (was
         *     `c0 + (c0 >>> 8)` bit-stretch).
         */
        tetrahedralInterp3DArray_3Ch_intLut16_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var rx = 0|0, ry = 0|0, rz = 0|0;
            var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0;
            var px = 0|0, py = 0|0, pz = 0|0;
            var input0 = 0|0, input1 = 0|0, input2 = 0|0;
            var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
            var c0 = 0|0, c1 = 0|0, c2 = 0|0, a = 0|0, b = 0|0;
            var v = 0|0;

            var gps  = intLut.gridPointsScale_fixed_u16 | 0;   // Q0.13 (v1.3)
            var CLUT = intLut.CLUT;                             // u16 CLUT @ scale 65535 (v1.3)
            var go0  = intLut.go0 | 0;
            var go1  = intLut.go1 | 0;
            var go2  = intLut.go2 | 0;
            var maxX = intLut.maxX | 0;
            var maxY = intLut.maxY | 0;
            var maxZ = intLut.maxZ | 0;

            for(var p = 0; p < length; p++) {
                input0 = input[inputPos++];
                input1 = input[inputPos++];
                input2 = input[inputPos++];

                px = Math.imul(input0, gps);   // u16 * Q0.13 ≤ 2^20, well under i32
                py = Math.imul(input1, gps);
                pz = Math.imul(input2, gps);

                // Per-axis input===65535 boundary patch (u16 sibling of the
                // u8 input===255 patch — see bench/int_vs_float.js FINDING #2).
                // Same maxX/Y/Z grid-index offsets as u8 path (bit-width
                // independent).
                if (input0 === 65535) { X0 = maxX; X1 = maxX; rx = 0; }
                else { X0 = px >>> 13; rx = px & 0x1FFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

                if (input1 === 65535) { Y0 = maxY; Y1 = maxY; ry = 0; }
                else { Y0 = py >>> 13; ry = py & 0x1FFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

                if (input2 === 65535) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
                else { Z0 = pz >>> 13; rz = pz & 0x1FFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

                base1 = X0 + Y0 + Z0;
                c0 = CLUT[base1++];
                c1 = CLUT[base1++];
                c2 = CLUT[base1];

                // Output write: c + ((delta-sum + 0x1000) >> 13). The c-corner
                // enters at full u16 precision; the >> 13 only quantizes the
                // small within-cell linear correction (max ~1 cell-step ≈
                // 2048 LSB out of 65535). No bit-stretch.
                if (rx >= ry && ry >= rz) {
                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z0;
                    base4 = X1 + Y1 + Z1;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base1];   b = CLUT[base2];
                    output[outputPos++] = c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x1000) >> 13);
                } else if (rx >= rz && rz >= ry) {
                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z1;
                    base3 = X1 + Y0 + Z1;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base3];   b = CLUT[base1];
                    output[outputPos++] = c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                } else if (rx >= ry && rz >= rx) {
                    base1 = X1 + Y0 + Z1;
                    base2 = X0 + Y0 + Z1;
                    base3 = X1 + Y1 + Z1;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x1000) >> 13);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x1000) >> 13);
                    a = CLUT[base1];   b = CLUT[base2];
                    output[outputPos++] = c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c2, rz) + 0x1000) >> 13);
                } else if (ry >= rx && rx >= rz) {
                    base1 = X1 + Y1 + Z0;
                    base2 = X0 + Y1 + Z0;
                    base4 = X1 + Y1 + Z1;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2];   b = CLUT[base1];
                    output[outputPos++] = c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x1000) >> 13);
                } else if (ry >= rz && rz >= rx) {
                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    base3 = X0 + Y1 + Z0;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2];   b = CLUT[base3];
                    output[outputPos++] = c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                } else if (rz >= ry && ry >= rx) {
                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    base4 = X0 + Y0 + Z1;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x1000) >> 13);
                    a = CLUT[base2];   b = CLUT[base4];
                    output[outputPos++] = c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x1000) >> 13);
                } else {
                    // Degenerate (shouldn't trigger after the 6 cases — kept
                    // for safety, mirrors the u8 sibling). c-corner pass-through
                    // at full u16 precision (no bit-stretch needed).
                    output[outputPos++] = c0;
                    output[outputPos++] = c1;
                    output[outputPos++] = c2;
                }

                if(preserveAlpha) {
                    output[outputPos++] = input[inputPos++];
                } else {
                    if(inputHasAlpha)  { inputPos++;  }
                    if(outputHasAlpha) {
                        output[outputPos++] = 0xFFFF;
                    }
                }
            }
        },

        /**
         * INT16 HOT PATH (v1.3, Q0.13). 3D LUT, 3-channel input → 4-channel output.
         * Typical use: u16 RGB→CMYK image conversion (16-bit print
         * separations). Mirror of tetrahedralInterp3DArray_4Ch_intLut_loop;
         * 4-channel sibling of tetrahedralInterp3DArray_3Ch_intLut16_loop
         * — same per-channel `c + ((sum + 0x1000) >> 13)` math, just one
         * extra channel per tetra case. See INT16 HOT PATH header for the
         * v1.3 (Q0.13) design overview.
         */
        tetrahedralInterp3DArray_4Ch_intLut16_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var rx = 0|0, ry = 0|0, rz = 0|0;
            var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0;
            var px = 0|0, py = 0|0, pz = 0|0;
            var input0 = 0|0, input1 = 0|0, input2 = 0|0;
            var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
            var c0 = 0|0, c1 = 0|0, c2 = 0|0, c3 = 0|0, a = 0|0, b = 0|0;
            var v = 0|0;

            var gps  = intLut.gridPointsScale_fixed_u16 | 0;   // Q0.13 (v1.3)
            var CLUT = intLut.CLUT;                             // u16 CLUT @ scale 65535 (v1.3)
            var go0  = intLut.go0 | 0;
            var go1  = intLut.go1 | 0;
            var go2  = intLut.go2 | 0;
            var maxX = intLut.maxX | 0;
            var maxY = intLut.maxY | 0;
            var maxZ = intLut.maxZ | 0;

            for(var p = 0; p < length; p++) {
                input0 = input[inputPos++];
                input1 = input[inputPos++];
                input2 = input[inputPos++];

                px = Math.imul(input0, gps);
                py = Math.imul(input1, gps);
                pz = Math.imul(input2, gps);

                if (input0 === 65535) { X0 = maxX; X1 = maxX; rx = 0; }
                else { X0 = px >>> 13; rx = px & 0x1FFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

                if (input1 === 65535) { Y0 = maxY; Y1 = maxY; ry = 0; }
                else { Y0 = py >>> 13; ry = py & 0x1FFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

                if (input2 === 65535) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
                else { Z0 = pz >>> 13; rz = pz & 0x1FFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

                base1 = X0 + Y0 + Z0;
                c0 = CLUT[base1++];
                c1 = CLUT[base1++];
                c2 = CLUT[base1++];
                c3 = CLUT[base1];

                if (rx >= ry && ry >= rz) {
                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z0;
                    base4 = X1 + Y1 + Z1;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base1];   b = CLUT[base2];
                    output[outputPos++] = c3 + ((Math.imul(a - c3, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x1000) >> 13);
                } else if (rx >= rz && rz >= ry) {
                    base1 = X1 + Y0 + Z0;
                    base2 = X1 + Y1 + Z1;
                    base3 = X1 + Y0 + Z1;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base3++]; b = CLUT[base1++];
                    output[outputPos++] = c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base3];   b = CLUT[base1];
                    output[outputPos++] = c3 + ((Math.imul(b - c3, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                } else if (rx >= ry && rz >= rx) {
                    base1 = X1 + Y0 + Z1;
                    base2 = X0 + Y0 + Z1;
                    base3 = X1 + Y1 + Z1;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x1000) >> 13);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x1000) >> 13);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    output[outputPos++] = c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c2, rz) + 0x1000) >> 13);
                    a = CLUT[base1];   b = CLUT[base2];
                    output[outputPos++] = c3 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c3, rz) + 0x1000) >> 13);
                } else if (ry >= rx && rx >= rz) {
                    base1 = X1 + Y1 + Z0;
                    base2 = X0 + Y1 + Z0;
                    base4 = X1 + Y1 + Z1;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base1++];
                    output[outputPos++] = c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2];   b = CLUT[base1];
                    output[outputPos++] = c3 + ((Math.imul(b - a, rx) + Math.imul(a - c3, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x1000) >> 13);
                } else if (ry >= rz && rz >= rx) {
                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    base3 = X0 + Y1 + Z0;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base3++];
                    output[outputPos++] = c2 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2];   b = CLUT[base3];
                    output[outputPos++] = c3 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c3, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                } else if (rz >= ry && ry >= rx) {
                    base1 = X1 + Y1 + Z1;
                    base2 = X0 + Y1 + Z1;
                    base4 = X0 + Y0 + Z1;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base4++];
                    output[outputPos++] = c2 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x1000) >> 13);
                    a = CLUT[base2];   b = CLUT[base4];
                    output[outputPos++] = c3 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c3, rz) + 0x1000) >> 13);
                } else {
                    output[outputPos++] = c0;
                    output[outputPos++] = c1;
                    output[outputPos++] = c2;
                    output[outputPos++] = c3;
                }

                if(preserveAlpha) {
                    output[outputPos++] = input[inputPos++];
                } else {
                    if(inputHasAlpha)  { inputPos++;  }
                    if(outputHasAlpha) {
                        output[outputPos++] = 0xFFFF;
                    }
                }
            }
        },

        tetrahedralInterp3DArray_4Ch_16bit(input, inputPos, output, outputPos, length, lut){
            var rx,ry,rz;
            var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2
            var base1,base2,
                c00,c01,c02,c03,
                c10,c11,c12,c13,
                c20,c21,c22,c23,
                c30,c31,c32,c33;

            var outputScale = lut.outputScale;
            var outputChannels = lut.outputChannels;
            var gridPointsMinus1 = lut.g1 - 1;
            var CLUT = lut.CLUT;
            var go1 = lut.go1;
            var go2 = lut.go2;

            for(var p = 0; p < length; p++) {

                // We need some clipping here
                input0 = input[inputPos++];
                input1 = input[inputPos++];
                input2 = input[inputPos++];

                // No clipping checks for speed needed for clamped arrays

                px = input0 * gridPointsMinus1 / 255;
                py = input1 * gridPointsMinus1 / 255;
                pz = input2 * gridPointsMinus1 / 255;

                X0 = Math.floor(px);
                rx = input0;
                X1 = (input0  === 255) ? X0 : X0 + 1;

                Y0 = Math.floor(py);
                ry = input1;
                Y1 = (input1  === 255) ? Y0 : Y0 + 1;

                Z0 = Math.floor(pz);
                rz = input2;
                Z1 = (input2  === 255) ? Z0 : Z0 + 1;

                Z0 *= outputChannels;
                Z1 *= outputChannels;

                //c0 = lookup(X0, Y0, Z0);
                base1 = ((X0 * go2) + (Y0 * go1) + Z0);
                c00 = CLUT[base1++];
                c01 = CLUT[base1++];
                c02 = CLUT[base1++];
                c03 = CLUT[base1];

                if (rx >= ry && ry >= rz) {
                    // block1
                    // X1, Y0, Z0, c0);
                    base1 = ((X1 * go2) + (Y0 * go1) + Z0);
                    c10 = CLUT[base1++] - c00;
                    c11 = CLUT[base1++] - c01;
                    c12 = CLUT[base1++] - c02;
                    c13 = CLUT[base1] - c03;

                    // X1, Y1, Z0,
                    // X1, Y0, Z0);
                    base1 = ((X1 * go2) + (Y1 * go1) + Z0);
                    base2 = ((X1 * go2) + (Y0 * go1) + Z0);
                    c20 = CLUT[base1++] - CLUT[base2++];
                    c21 = CLUT[base1++] - CLUT[base2++];
                    c22 = CLUT[base1++] - CLUT[base2++];
                    c23 = CLUT[base1] - CLUT[base2];

                    // X1, Y1, Z1,
                    // X1, Y1, Z0);
                    base1 = ((X1 * go2) + (Y1 * go1) + Z1);
                    base2 = ((X1 * go2) + (Y1 * go1) + Z0);
                    c30 = CLUT[base1++] - CLUT[base2++];
                    c31 = CLUT[base1++] - CLUT[base2++];
                    c32 = CLUT[base1++] - CLUT[base2++];
                    c33 = CLUT[base1] - CLUT[base2]

                } else if (rx >= rz && rz >= ry) {
                    // block2
                    // X1, Y0, Z0, c0);
                    base1 = ((X1 * go2) + (Y0 * go1) + Z0);
                    c10 = CLUT[base1++] - c00;
                    c11 = CLUT[base1++] - c01;
                    c12 = CLUT[base1++] - c02;
                    c13 = CLUT[base1] - c03;

                    // X1, Y1, Z1,
                    // X1, Y0, Z1)
                    base1 = ((X1 * go2) + (Y1 * go1) + Z1);
                    base2 = ((X1 * go2) + (Y0 * go1) + Z1);
                    c20 = CLUT[base1++] - CLUT[base2++];
                    c21 = CLUT[base1++] - CLUT[base2++];
                    c22 = CLUT[base1++] - CLUT[base2++];
                    c23 = CLUT[base1] - CLUT[base2];

                    // X1, Y0, Z1,
                    // X1, Y0, Z0);
                    base1 = ((X1 * go2) + (Y0 * go1) + Z1);
                    base2 = ((X1 * go2) + (Y0 * go1) + Z0);
                    c30 = CLUT[base1++] - CLUT[base2++];
                    c31 = CLUT[base1++] - CLUT[base2++];
                    c32 = CLUT[base1++] - CLUT[base2++];
                    c33 = CLUT[base1] - CLUT[base2]

                } else if (rz >= rx && rx >= ry) {
                    // block3
                    // X1, Y0, Z1,
                    // X0, Y0, Z1);
                    base1 = ((X1 * go2) + (Y0 * go1) + Z1);
                    base2 = ((X0 * go2) + (Y0 * go1) + Z1);
                    c10 = CLUT[base1++] - CLUT[base2++];
                    c11 = CLUT[base1++] - CLUT[base2++];
                    c12 = CLUT[base1++] - CLUT[base2++];
                    c13 = CLUT[base1] - CLUT[base2];

                    // X1, Y1, Z1,
                    // X1, Y0, Z1);
                    base1 = ((X1 * go2) + (Y1 * go1) + Z1);
                    base2 = ((X1 * go2) + (Y0 * go1) + Z1);
                    c20 = CLUT[base1++] - CLUT[base2++];
                    c21 = CLUT[base1++] - CLUT[base2++];
                    c22 = CLUT[base1++] - CLUT[base2++];
                    c23 = CLUT[base1] - CLUT[base2];

                    // X0, Y0, Z1, c0);
                    base1 = ((X0 * go2) + (Y0 * go1) + Z1);
                    c30 = CLUT[base1++] - c00;
                    c31 = CLUT[base1++] - c01;
                    c32 = CLUT[base1++] - c02;
                    c33 = CLUT[base1] - c03;

                } else if (ry >= rx && rx >= rz) {
                    // block4

                    //  X1, Y1, Z0,
                    //  X0, Y1, Z0);
                    base1 = ((X1 * go2) + (Y1 * go1) + Z0);
                    base2 = ((X0 * go2) + (Y1 * go1) + Z0);
                    c10 = CLUT[base1++] - CLUT[base2++];
                    c11 = CLUT[base1++] - CLUT[base2++];
                    c12 = CLUT[base1++] - CLUT[base2++];
                    c13 = CLUT[base1++] - CLUT[base2];

                    // X0, Y1, Z0, c0);
                    base1 = ((X0 * go2) + (Y1 * go1) + Z0);
                    c20 = CLUT[base1++] - c00;
                    c21 = CLUT[base1++] - c01;
                    c22 = CLUT[base1++] - c02;
                    c23 = CLUT[base1] - c03;

                    // X1, Y1, Z1,
                    // X1, Y1, Z0);
                    base1 = ((X1 * go2) + (Y1 * go1) + Z1);
                    base2 = ((X1 * go2) + (Y1 * go1) + Z0);
                    c30 = CLUT[base1++] - CLUT[base2++];
                    c31 = CLUT[base1++] - CLUT[base2++];
                    c32 = CLUT[base1++] - CLUT[base2++];
                    c33 = CLUT[base1] - CLUT[base2]

                } else if (ry >= rz && rz >= rx) {
                    // block5

                    //  X1, Y1, Z1,
                    //  X0, Y1, Z1);
                    base1 = ((X1 * go2) + (Y1 * go1) + Z1);
                    base2 = ((X0 * go2) + (Y1 * go1) + Z1);
                    c10 = CLUT[base1++] - CLUT[base2++];
                    c11 = CLUT[base1++] - CLUT[base2++];
                    c12 = CLUT[base1++] - CLUT[base2++];
                    c13 = CLUT[base1] - CLUT[base2];

                    // X0, Y1, Z0, c0);
                    base1 = ((X0 * go2) + (Y1 * go1) + Z0);
                    c20 = CLUT[base1++] - c00;
                    c21 = CLUT[base1++] - c01;
                    c22 = CLUT[base1++] - c02;
                    c23 = CLUT[base1] - c03;

                    // X0, Y1, Z1,
                    // X0, Y1, Z0);
                    base1 = ((X0 * go2) + (Y1 * go1) + Z1);
                    base2 = ((X0 * go2) + (Y1 * go1) + Z0) ;
                    c30 = CLUT[base1++] - CLUT[base2++];
                    c31 = CLUT[base1++] - CLUT[base2++];
                    c32 = CLUT[base1++] - CLUT[base2++];
                    c33 = CLUT[base1] - CLUT[base2]

                } else if (rz >= ry && ry >= rx) {
                    // block6

                    //   X1, Y1, Z1,
                    //   X0, Y1, Z1);
                    base1 = ((X1 * go2) + (Y1 * go1) + Z1);
                    base2 = ((X0 * go2) + (Y1 * go1) + Z1);
                    c10 = CLUT[base1++] - CLUT[base2++];
                    c11 = CLUT[base1++] - CLUT[base2++];
                    c12 = CLUT[base1++] - CLUT[base2++];
                    c13 = CLUT[base1] - CLUT[base2];

                    //  X0, Y1, Z1,
                    //  X0, Y0, Z1);
                    base1 = ((X0 * go2) + (Y1 * go1) + Z1);
                    base2 = ((X0 * go2) + (Y0 * go1) + Z1);
                    c20 = CLUT[base1++] - CLUT[base2++];
                    c21 = CLUT[base1++] - CLUT[base2++];
                    c22 = CLUT[base1++] - CLUT[base2++];
                    c23 = CLUT[base1] - CLUT[base2];

                    //X0, Y0, Z1, c0
                    base1 = ((X0 * go2) + (Y0 * go1) + Z1);
                    c30 = CLUT[base1++] - c00;
                    c31 = CLUT[base1++] - c01;
                    c32 = CLUT[base1++] - c02;
                    c33 = CLUT[base1] - c03;

                } else {
                    output[outputPos++] = c00 * outputScale;
                    output[outputPos++] = c01 * outputScale;
                    output[outputPos++] = c02 * outputScale;
                    output[outputPos++] = c03 * outputScale;
                    continue;
                }

                // Output should be computed as x = ROUND_FIXED_TO_INT(_cmsToFixedDomain(Rest))
                // which expands as: x = (Rest + ((Rest+0x7fff)/0xFFFF) + 0x8000)>>16
                // This can be replaced by: t = Rest+0x8001, x = (t + (t>>16))>>16
                // at the cost of being off by one at 7fff and 17ffe.
                var t;
                t = (c10 * rx) + (c20 * ry) + (c30 * rz) + 0x8001; // 24 bits
                output[outputPos++] = ((c00 * 256) + t + (t>>16)) >> 16;

                t = (c11 * rx) + (c21 * ry) + (c31 * rz) + 0x8001; // 24 bits
                output[outputPos++] = ((c01 * 256) + t + (t>>16)) >> 16;

                t = (c12 * rx) + (c22 * ry) + (c32 * rz) + 0x8001; // 24 bits
                output[outputPos++] = ((c02 * 256) + t + (t>>16)) >> 16;

                t = (c13 * rx) + (c23 * ry) + (c33 * rz) + 0x8001; // 24 bits
                output[outputPos++] = ((c03 * 256) + t + (t>>16)) >> 16;

                // output[outputPos++] = ((c00 * 256) + (c10 * rx) + (c20 * ry) + (c30 * rz)) >> 16;
            }
        },
};
