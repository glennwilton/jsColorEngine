// src/kernels/4d/kernel4D_loops.js
//
// 4D (CMYK-input) LUT array loops — MOVED VERBATIM from src/Transform.js (v1.7 phase B,
// see docs/deepdive/KernelContract.md). Transform.js attaches these to
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
         * HOT PATH. 4D LUT, 4-channel input → N-channel output (N != 3 and N != 4).
         * Typical use: CMYK → 5+-channel inks (n-color separations).
         *
         * TODO (B3): Currently delegates to tetrahedralInterp4D_NCh per pixel and
         * allocates per-pixel arrays. Should be inlined like the 3Ch / 4Ch
         * variants for image-grade speed on n-color workflows.
         *
         * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop.
         */
        tetrahedralInterp4DArray_NCh_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha) {
            // INLINED in v1.6 phase 4, completing what phase 2 started on the
            // 1-D and 2-D loops. This used to call tetrahedralInterp4D_NCh once
            // per pixel, which returned a fresh `new Array(outputChannels)`
            // every time -- and it is the CMYK -> 6CLR / n-colour separation
            // path, the slowest row in bench/small_dim.
            //
            // THE SCRATCH IS NOT TIDINESS. A 4-D interpolation evaluates two
            // 3-D ones at the bracketing K planes. When interpK is true the
            // first pass writes an UNSCALED 0..1 intermediate that the second
            // reads back, and `output` here is a Uint8ClampedArray -- writing
            // that intermediate into it would round to 0 or 1 and quietly
            // destroy it. Both passes therefore write to a float scratch,
            // allocated once outside the pixel loop, and the final values are
            // copied out afterwards.
            //
            // Derived mechanically from tetrahedralInterp4D_NCh rather than
            // transcribed: six branches, each with two channel loops whose
            // differences pair with the fractions differently, is too much to
            // retype safely. Verified bit-identical against the previous loop.
            var outputScale = lut.outputScale;
            var gridEnd = (lut.g1 - 1);
            var gridPointsScale = gridEnd * lut.inputScale;
            var outputChannels = lut.outputChannels;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;
            var go2 = lut.go2;
            var go3 = lut.go3;
            var kOffset = go3 - lut.outputChannels;
            var scratch = new Float64Array(outputChannels);
            var in0, in1, in2, in3, oo;

            for(var p = 0; p < length; p++) {
                in0 = input[inputPos++];
                in1 = input[inputPos++];
                in2 = input[inputPos++];
                in3 = input[inputPos++];

                var X0, X1, Y0, K0,
                    Y1, Z0, Z1,
                    rx, ry, rz, rk,
                    px, py, pz, pk,
                    input0, input1, input2, inputK,
                    base0, base1, base2, base3, base4,
                    a, b, c, d, o,
                    interpK;
    
    
                // Scale FIRST, then clamp in grid space — see linearInterp1D_NCh
                // note (raw u8/u16 vs device 0..1 input contracts).
                pk = Math.min(Math.max(in0 * gridPointsScale, 0), gridEnd); // K
                px = Math.min(Math.max(in1 * gridPointsScale, 0), gridEnd); // C
                py = Math.min(Math.max(in2 * gridPointsScale, 0), gridEnd); // M
                pz = Math.min(Math.max(in3 * gridPointsScale, 0), gridEnd); // Y
    
                K0 = ~~pk;
                rk = (pk - K0);
                interpK = !(K0 === gridEnd)// K0 and K1 are identical if K0 is the last grid point
                K0 *= go3;
                // No need to calc K1 as we will add kOffset to the base location to get the K1 location
    
                X0 = ~~px; //~~ is the same as Math.floor(px)
                rx = (px - X0); // get the fractional part
                if(X0 === gridEnd){
                    X1 = X0 *= go2;// change to index in array
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
    
                var outputScaleK0 = (interpK) ? 1 : outputScale
    
                base0 = X0 + Y0 + Z0 + K0;
    
    
                if (rx >= ry && ry >= rz) {
                    // block1
                    base1 = X1 + Y0 + Z0 + K0;
                    base2 = X1 + Y1 + Z0 + K0;
                    base4 = X1 + Y1 + Z1 + K0;
    
                    // Read in K0, If K1 is needed outputScaleK0 = 1, else outputScaleK0 = outputScale
                    for(o = 0 ; o < outputChannels ; o++) {
                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        c = CLUT[base0++];
                        scratch[o] = (c + ((a - c) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScaleK0;
                    }
    
                    // Only interpolate K1 if needed, K1 is the next n items in the LUT
                    if(interpK) {
                        base0 += kOffset;
                        base1 += kOffset;
                        base2 += kOffset;
                        base4 += kOffset;
                        for(o = 0 ; o < outputChannels ; o++) {
                            a = CLUT[base1++];
                            b = CLUT[base2++];
                            c = CLUT[base0++];
                            d = scratch[o]; // get the output from the previous loop to interpolate
                            scratch[o] = (d + (((c + ((a - c) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - d) * rk)) * outputScale;
                        }
                    }
    
                } else if (rx >= rz && rz >= ry) {
                    // block2
    
                    base1 = X1 + Y0 + Z0 + K0;
                    base2 = X1 + Y1 + Z1 + K0;
                    base3 = X1 + Y0 + Z1 + K0;
                    for(o = 0 ; o < outputChannels ; o++) {
                        a = CLUT[base3++];
                        b = CLUT[base1++];
                        c = CLUT[base0++];
                        scratch[o] = (c + ((b - c) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) * outputScaleK0;
                    }
    
                    if(interpK) {
                        base0 += kOffset;
                        base1 += kOffset;
                        base2 += kOffset;
                        base3 += kOffset;
                        for(o = 0 ; o < outputChannels ; o++) {
                            a = CLUT[base3++];
                            b = CLUT[base1++];
                            c = CLUT[base0++];
                            d = scratch[o];
                            scratch[o] = (d + ((( c + ((b - c) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - d) * rk)) * outputScale;
                        }
                    }
    
                } else if (rx >= ry && rz >= rx) {
                    // block3
    
                    base1 = X1 + Y0 + Z1 + K0;
                    base2 = X0 + Y0 + Z1 + K0;
                    base3 = X1 + Y1 + Z1 + K0;
                    for(o = 0 ; o < outputChannels ; o++) {
                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        c = CLUT[base0++];
                        scratch[o] = (c + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c) * rz)) * outputScaleK0;
                    }
    
                    if(interpK) {
                        base0 += kOffset;
                        base1 += kOffset;
                        base2 += kOffset;
                        base3 += kOffset;
    
                        for(o = 0 ; o < outputChannels ; o++) {
                            a = CLUT[base1++];
                            b = CLUT[base2++];
                            c = CLUT[base0++];
                            d = scratch[o];
                            scratch[o] = (d + ((( c + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c) * rz) ) - d) * rk)) * outputScale;
                        }
                    }
    
                } else if (ry >= rx && rx >= rz) {
                    // block4
    
                    base1 = X1 + Y1 + Z0 + K0;
                    base2 = X0 + Y1 + Z0 + K0;
                    base4 = X1 + Y1 + Z1 + K0;
                    for(o = 0 ; o < outputChannels ; o++) {
                        a = CLUT[base2++];
                        b = CLUT[base1++];
                        c = CLUT[base0++];
                        scratch[o] = (c + ((b - a) * rx) + ((a - c) * ry) + ((CLUT[base4++] - b) * rz)) * outputScaleK0;
                    }
    
                    if(interpK) {
                        base0 += kOffset;
                        base1 += kOffset;
                        base2 += kOffset;
                        base4 += kOffset;
                        for(o = 0 ; o < outputChannels ; o++) {
                            a = CLUT[base2++];
                            b = CLUT[base1++];
                            c = CLUT[base0++];
                            d = scratch[o];
                            scratch[o] = (d + (((c + ((b - a) * rx) + ((a - c) * ry) + ((CLUT[base4++] - b) * rz) ) - d) * rk)) * outputScale;
                        }
                    }
    
                } else if (ry >= rz && rz >= rx) {
                    // block5
    
                    base1 = X1 + Y1 + Z1 + K0;
                    base2 = X0 + Y1 + Z1 + K0;
                    base3 = X0 + Y1 + Z0 + K0;
                    for(o = 0 ; o < outputChannels ; o++) {
                        a = CLUT[base2++];
                        b = CLUT[base3++];
                        c = CLUT[base0++];
                        scratch[o] = (c + ((CLUT[base1++] - a) * rx) + ((b - c) * ry) + ((a - b) * rz)) * outputScaleK0;
                    }
    
                    if(interpK) {
                        base0 += kOffset;
                        base1 += kOffset;
                        base2 += kOffset;
                        base3 += kOffset;
                        for(o = 0 ; o < outputChannels ; o++) {
                            a = CLUT[base2++];
                            b = CLUT[base3++];
                            c = CLUT[base0++];
                            d = scratch[o];
                            scratch[o] = (d + ((( c + ((CLUT[base1++] - a) * rx) + ((b - c) * ry) + ((a - b) * rz) ) - d) * rk)) * outputScale;
                        }
                    }
    
                } else if (rz >= ry && ry >= rx) {
                    // block6
    
                    base1 = X1 + Y1 + Z1 + K0;
                    base2 = X0 + Y1 + Z1 + K0;
                    base4 = X0 + Y0 + Z1 + K0;
    
                    for(o = 0 ; o < outputChannels ; o++) {
                        a = CLUT[base2++];
                        b = CLUT[base4++];
                        c = CLUT[base0++];
                        scratch[o] = (c + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c) * rz)) * outputScaleK0;
                    }
    
                    if(interpK) {
                        base0 += kOffset;
                        base1 += kOffset;
                        base2 += kOffset;
                        base4 += kOffset;
                        for(o = 0 ; o < outputChannels ; o++) {
                            a = CLUT[base2++]
                            b = CLUT[base4++]
                            c = CLUT[base0++]
                            d = scratch[o];
                            scratch[o] = (d + ((( c + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c) * rz) ) - d) * rk)) * outputScale;
                        }
                    }
    
                } else {
                    if(interpK) {
                        for(o = 0 ; o < outputChannels ; o++) {
                            scratch[o] = CLUT[base0++];
                        }
                        base0 += kOffset;
                        for(o = 0 ; o < outputChannels ; o++) {
                            c = CLUT[base0++]
                            scratch[o] = (c + (( scratch[o] - c ) * rk)) * outputScale;
                        }
                    } else {
                        for(o = 0 ; o < outputChannels ; o++) {
                            scratch[o] = CLUT[base0++] * outputScale;
                        }
                    }
                }
    

                for(oo = 0; oo < outputChannels; oo++) output[outputPos++] = scratch[oo];

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
         * HOT PATH. 4D LUT, 4-channel input → 3-channel output.
         * Typical use: CMYK → RGB image conversion (preview / soft-proof) and
         * CMYK → Lab analysis pipelines.
         *
         * Includes the K-axis interpolation as a second pass (interpK flag): when
         * the K fraction is zero, the function skips the second tetrahedron and
         * returns the 3D result directly — meaningful speed-up on flat K regions.
         *
         * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop.
         */
        tetrahedralInterp4DArray_3Ch_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var X0, X1, Y0, K0,
                Y1, Z0, Z1,
                rx, ry, rz, rk,
                px, py, pz, pk,
                input0, input1, input2, inputK,
                base1, base2, base3, base4,
                c0, c1, c2,
                o0, o1, o2,
                d0, d1, d2,
                a, b,
                interpK;

            var outputScale = lut.outputScale;
            var gridPointsScale = (lut.g1 - 1) * lut.inputScale;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;
            var go2 = lut.go2;
            var go3 = lut.go3;
            var kOffset = go3 - lut.outputChannels + 1; // +1 since we don't do a [base++] for the last CLUT lookup

            for(var p = 0; p < length; p++) {

                // We need some clipping here
                inputK = input[inputPos++]; // K
                input0 = input[inputPos++]; // C
                input1 = input[inputPos++]; // M
                input2 = input[inputPos++]; // Y


                // No clipping checks for speed needed for clamped arrays

                px = input0 * gridPointsScale;
                py = input1 * gridPointsScale;
                pz = input2 * gridPointsScale;
                pk = inputK * gridPointsScale;

                K0 = ~~pk;
                rk = (pk - K0);
                K0 *= go3;
                // K1 is not required, we just need to test if
                // we need to interpolate or not

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

                base1 = X0 + Y0 + Z0 + K0;
                c0 = CLUT[base1++];
                c1 = CLUT[base1++];
                c2 = CLUT[base1];

                if(inputK === 255 || rk === 0) {
                    interpK = false;
                } else {
                    base1 +=kOffset;
                    d0 = CLUT[base1++];
                    d1 = CLUT[base1++];
                    d2 = CLUT[base1];
                    interpK = true;
                }

                if (rx >= ry && ry >= rz) {
                    // block1
                    base1 = X1 + Y0 + Z0 + K0;
                    base2 = X1 + Y1 + Z0 + K0;
                    //base3 = base1; SAME AS base1
                    base4 = X1 + Y1 + Z1 + K0;
                    //base5 = base2; SAME as base2

                    // Note that baseN is increased after each read from the array to move to the next channel
                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    o0 = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    o1 = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

                    a = CLUT[base1];
                    b = CLUT[base2];
                    o2 = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4] - b) * rz));

                    if(interpK) {
                        base1+=kOffset;
                        base2+=kOffset;
                        base4+=kOffset;

                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        //output[outputPos++] = c1 + (( d1 - c1 ) * rk)
                        output[outputPos++] = (o0 + (((d0 + ((a - d0) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o0) * rk)) * outputScale;

                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        output[outputPos++] = (o1 + (((d1 + ((a - d1) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o1) * rk)) * outputScale;

                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        output[outputPos++] = (o2 + (((d2 + ((a - d2) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o2) * rk)) * outputScale;

                    } else {
                        output[outputPos++] = o0 * outputScale;
                        output[outputPos++] = o1 * outputScale;
                        output[outputPos++] = o2 * outputScale;
                    }

                } else if (rx >= rz && rz >= ry) {
                    // block2

                    base1 = X1 + Y0 + Z0 + K0;
                    base2 = X1 + Y1 + Z1 + K0;
                    base3 = X1 + Y0 + Z1 + K0;
                    //base4 = base3;
                    //base5 = base1;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    o0 = c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    o1 = c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

                    a = CLUT[base3];
                    b = CLUT[base1];
                    o2 = c2 + ((b - c2) * rx) + ((CLUT[base2] - a) * ry) + ((a - b) * rz);


                    if(interpK) {
                        base3 += kOffset;
                        base1 += kOffset;
                        base2 += kOffset;

                        a = CLUT[base3++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o0 + ((( d0 + ((b - d0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                        a = CLUT[base3++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o1 + ((( d1 + ((b - d1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                        a = CLUT[base3++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o2 + ((( d2 + ((b - d2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                    } else {
                        output[outputPos++] = o0 * outputScale;
                        output[outputPos++] = o1 * outputScale;
                        output[outputPos++] = o2 * outputScale;
                    }

                } else if (rx >= ry && rz >= rx) {
                    // block3

                    base1 = X1 + Y0 + Z1 + K0;
                    base2 = X0 + Y0 + Z1 + K0;
                    base3 = X1 + Y1 + Z1 + K0;
                    //base4 = base1;
                    //base5 = base2;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    o0 = c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz);

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    o1 = c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz);

                    a = CLUT[base1];
                    b = CLUT[base2];
                    o2 = c2 + ((a - b) * rx) + ((CLUT[base3] - a) * ry) + ((b - c2) * rz);


                    if(interpK) {
                        base1 += kOffset;
                        base2 += kOffset;
                        base3 += kOffset;

                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        output[outputPos++] = (o0 + ((( d0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d0) * rz) ) - o0) * rk)) * outputScale;

                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        output[outputPos++] = (o1 + ((( d1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d1) * rz) ) - o1) * rk)) * outputScale;

                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        output[outputPos++] = (o2 + ((( d2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d2) * rz) ) - o2) * rk)) * outputScale;
                    } else {
                        output[outputPos++] = o0 * outputScale;
                        output[outputPos++] = o1 * outputScale;
                        output[outputPos++] = o2 * outputScale;
                    }

                } else if (ry >= rx && rx >= rz) {
                    // block4

                    base1 = X1 + Y1 + Z0 + K0;
                    base2 = X0 + Y1 + Z0 + K0;
                    //base3 = base2;
                    base4 = X1 + Y1 + Z1 + K0;
                    //base5 = base1;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    o0 = c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz);

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    o1 = c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz);

                    a = CLUT[base2];
                    b = CLUT[base1];
                    o2 = c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4] - b) * rz);


                    if(interpK) {
                        base1 += kOffset;
                        base2 += kOffset;
                        base4 += kOffset;

                        a = CLUT[base2++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o0 + ((( d0 + ((b - a) * rx) + ((a - d0) * ry) + ((CLUT[base4++] - b) * rz) ) - o0) * rk)) * outputScale;

                        a = CLUT[base2++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o1 + ((( d1 + ((b - a) * rx) + ((a - d1) * ry) + ((CLUT[base4++] - b) * rz) ) - o1) * rk)) * outputScale;

                        a = CLUT[base2++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o2 + ((( d2 + ((b - a) * rx) + ((a - d2) * ry) + ((CLUT[base4++] - b) * rz) ) - o2) * rk)) * outputScale;

                    } else {
                        output[outputPos++] = o0 * outputScale;
                        output[outputPos++] = o1 * outputScale;
                        output[outputPos++] = o2 * outputScale;
                    }

                } else if (ry >= rz && rz >= rx) {
                    // block5

                    base1 = X1 + Y1 + Z1 + K0;
                    base2 = X0 + Y1 + Z1 + K0;
                    base3 = X0 + Y1 + Z0 + K0;
                    //base4 = base2;
                    //base5 = base3;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    o0 = c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz);

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    o1 = c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz);

                    a = CLUT[base2];
                    b = CLUT[base3];
                    o2 = c2 + ((CLUT[base1] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz);

                    if(interpK) {
                        base1 += kOffset;
                        base2 += kOffset;
                        base3 += kOffset;

                        a = CLUT[base2++];
                        b = CLUT[base3++];
                        output[outputPos++] = (o0 + ((( d0 + ((CLUT[base1++] - a) * rx) + ((b - d0) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                        a = CLUT[base2++];
                        b = CLUT[base3++];
                        output[outputPos++] = (o1 + ((( d1 + ((CLUT[base1++] - a) * rx) + ((b - d1) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                        a = CLUT[base2++];
                        b = CLUT[base3++];
                        output[outputPos++] = (o2 + ((( d2 + ((CLUT[base1++] - a) * rx) + ((b - d2) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                    } else {
                        output[outputPos++] = o0 * outputScale;
                        output[outputPos++] = o1 * outputScale;
                        output[outputPos++] = o2 * outputScale;
                    }

                } else if (rz >= ry && ry >= rx) {
                    // block6

                    base1 = X1 + Y1 + Z1 + K0;
                    base2 = X0 + Y1 + Z1 + K0;
                    //base3 = base2;
                    base4 = X0 + Y0 + Z1 + K0;
                    //base5 = base4;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    o0 = c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    o1 = c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz);

                    a = CLUT[base2]
                    b = CLUT[base4]
                    o2 = c2 + ((CLUT[base1] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz);

                    if(interpK) {
                        base1 += kOffset;
                        base2 += kOffset;
                        base4 += kOffset;

                        a = CLUT[base2++]
                        b = CLUT[base4++]
                        output[outputPos++] = (o0 + ((( d0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d0) * rz) ) - o0) * rk)) * outputScale;

                        a = CLUT[base2++]
                        b = CLUT[base4++]
                        output[outputPos++] = (o1 + ((( d1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d1) * rz) ) - o1) * rk)) * outputScale;

                        a = CLUT[base2++]
                        b = CLUT[base4++]
                        output[outputPos++] = (o2 + ((( d2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d2) * rz) ) - o2) * rk)) * outputScale;

                    } else {
                        output[outputPos++] = o0 * outputScale;
                        output[outputPos++] = o1 * outputScale;
                        output[outputPos++] = o2 * outputScale;
                    }

                } else {
                    if(interpK) {
                        output[outputPos++] = c0 + (( d0 - c0 ) * rk) * outputScale;
                        output[outputPos++] = c1 + (( d1 - c1 ) * rk) * outputScale;
                        output[outputPos++] = c2 + (( d2 - c2 ) * rk) * outputScale;
                    } else {
                        output[outputPos++] = c0 * outputScale;
                        output[outputPos++] = c1 * outputScale;
                        output[outputPos++] = c2 * outputScale;
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
         * HOT PATH. 4D LUT, 4-channel input → 4-channel output.
         * Typical use: CMYK → CMYK image conversion (e.g. SWOP → GRACoL,
         * profile-to-profile re-purposing for press changes).
         *
         * As with the 3Ch 4D variant, the K axis is interpolated as a second
         * pass with an early-out (interpK flag) when rk is zero.
         *
         * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop.
         */
        tetrahedralInterp4DArray_4Ch_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var X0, X1, Y0, K0,
                Y1, Z0, Z1,
                rx, ry, rz, rk,
                px, py, pz, pk,
                input0, input1, input2, inputK,
                base1, base2, base3, base4,
                c0, c1, c2, c3,
                o0, o1, o2, o3,
                k0, k1, k2, k3,
                a, b,
                interpK;

            var outputScale = lut.outputScale;
            var gridPointsScale = (lut.g1 - 1) * lut.inputScale;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;
            var go2 = lut.go2;
            var go3 = lut.go3;
            var kOffset = go3 - lut.outputChannels + 1; // +1 since we don't do a [base++] for the last CLUT lookup

            for(var p = 0; p < length; p++) {

                // We need some clipping here
                inputK = input[inputPos++]; // K
                input0 = input[inputPos++]; // C
                input1 = input[inputPos++]; // M
                input2 = input[inputPos++]; // Y

                // No clipping checks for speed needed for clamped arrays
                px = input0 * gridPointsScale;
                py = input1 * gridPointsScale;
                pz = input2 * gridPointsScale;
                pk = inputK * gridPointsScale;

                K0 = ~~pk;
                rk = (pk - K0);
                K0 *= go3;
                // K1 is not required, we just need to test if
                // we need to interpolate or not

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

                base1 = X0 + Y0 + Z0 + K0;

                base1 = X0 + Y0 + Z0 + K0;
                c0 = CLUT[base1++];
                c1 = CLUT[base1++];
                c2 = CLUT[base1++];
                c3 = CLUT[base1];

                if(inputK === 255 || rk === 0) {
                    interpK = false;
                } else {
                    base1 +=kOffset;
                    k0 = CLUT[base1++];
                    k1 = CLUT[base1++];
                    k2 = CLUT[base1++];
                    k3 = CLUT[base1];
                    interpK = true;
                }

                if (rx >= ry && ry >= rz) {
                    // block1
                    base1 = X1 + Y0 + Z0 + K0;
                    base2 = X1 + Y1 + Z0 + K0;
                    //base3 = base1; SAME AS base1
                    base4 = X1 + Y1 + Z1 + K0;
                    //base5 = base2; SAME as base2

                    // Note that baseN is increased after each read from the array to move to the next channel
                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    o0 = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    o1 = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    o2 = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz));

                    a = CLUT[base1];
                    b = CLUT[base2];
                    o3 = (c3 + ((a - c3) * rx) +  ((b - a) * ry) + ((CLUT[base4] - b) * rz));

                    if(interpK) {
                        base1+=kOffset;
                        base2+=kOffset;
                        base4+=kOffset;

                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        //output[outputPos++] = c1 + (( d1 - c1 ) * rk)
                        output[outputPos++] = (o0 + (((k0 + ((a - k0) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o0) * rk)) * outputScale;

                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        output[outputPos++] = (o1 + (((k1 + ((a - k1) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o1) * rk)) * outputScale;

                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        output[outputPos++] = (o2 + (((k2 + ((a - k2) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o2) * rk)) * outputScale;

                        a = CLUT[base1];
                        b = CLUT[base2];
                        output[outputPos++] = (o3 + (((k3 + ((a - k3) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o3) * rk)) * outputScale;
                    } else {
                        output[outputPos++] = o0 * outputScale;
                        output[outputPos++] = o1 * outputScale;
                        output[outputPos++] = o2 * outputScale;
                        output[outputPos++] = o3 * outputScale;
                    }

                } else if (rx >= rz && rz >= ry) {
                    // block2

                    base1 = X1 + Y0 + Z0 + K0;
                    base2 = X1 + Y1 + Z1 + K0;
                    base3 = X1 + Y0 + Z1 + K0;
                    //base4 = base3;
                    //base5 = base1;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    o0 = c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    o1 = c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    o2 = c2 + ((b - c2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz);

                    a = CLUT[base3];
                    b = CLUT[base1];
                    o3 = c3 + ((b - c3) * rx) + ((CLUT[base2] - a) * ry) + ((a - b) * rz);

                    if(interpK) {
                        base3 += kOffset;
                        base1 += kOffset;
                        base2 += kOffset;

                        a = CLUT[base3++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o0 + ((( k0 + ((b - k0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                        a = CLUT[base3++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o1 + ((( k1 + ((b - k1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                        a = CLUT[base3++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o2 + ((( k2 + ((b - k2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                        a = CLUT[base3++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o3 + ((( k3 + ((b - k3) * rx) + ((CLUT[base2  ] - a) * ry) + ((a - b) * rz) ) - o3) * rk)) * outputScale;
                    } else {
                        output[outputPos++] = o0 * outputScale;
                        output[outputPos++] = o1 * outputScale;
                        output[outputPos++] = o2 * outputScale;
                        output[outputPos++] = o3 * outputScale;
                    }

                } else if (rx >= ry && rz >= rx) {
                    // block3

                    base1 = X1 + Y0 + Z1 + K0;
                    base2 = X0 + Y0 + Z1 + K0;
                    base3 = X1 + Y1 + Z1 + K0;
                    //base4 = base1;
                    //base5 = base2;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    o0 = c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz);

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    o1 = c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz);

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    o2 = c2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c2) * rz);

                    a = CLUT[base1];
                    b = CLUT[base2];
                    o3 = c3 + ((a - b) * rx) + ((CLUT[base3] - a) * ry) + ((b - c3) * rz);

                    if(interpK) {
                        base1 += kOffset;
                        base2 += kOffset;
                        base3 += kOffset;

                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        output[outputPos++] = (o0 + ((( k0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - k0) * rz) ) - o0) * rk)) * outputScale;

                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        output[outputPos++] = (o1 + ((( k1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - k1) * rz) ) - o1) * rk)) * outputScale;

                        a = CLUT[base1++];
                        b = CLUT[base2++];
                        output[outputPos++] = (o2 + ((( k2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - k2) * rz) ) - o2) * rk)) * outputScale;

                        a = CLUT[base1];
                        b = CLUT[base2];
                        output[outputPos++] = (o3 + ((( k3 + ((a - b) * rx) + ((CLUT[base3  ] - a) * ry) + ((b - k3) * rz) ) - o3) * rk)) * outputScale;
                    } else {
                        output[outputPos++] = o0 * outputScale;
                        output[outputPos++] = o1 * outputScale;
                        output[outputPos++] = o2 * outputScale;
                        output[outputPos++] = o3 * outputScale;
                    }

                } else if (ry >= rx && rx >= rz) {
                    // block4

                    base1 = X1 + Y1 + Z0 + K0;
                    base2 = X0 + Y1 + Z0 + K0;
                    //base3 = base2;
                    base4 = X1 + Y1 + Z1 + K0;
                    //base5 = base1;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    o0 = c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz);

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    o1 = c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz);

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    o2 = c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4++] - b) * rz);

                    a = CLUT[base2];
                    b = CLUT[base1];
                    o3 = c3 + ((b - a) * rx) + ((a - c3) * ry) + ((CLUT[base4] - b) * rz);

                    if(interpK) {
                        base1 += kOffset;
                        base2 += kOffset;
                        base4 += kOffset;

                        a = CLUT[base2++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o0 + ((( k0 + ((b - a) * rx) + ((a - k0) * ry) + ((CLUT[base4++] - b) * rz) ) - o0) * rk)) * outputScale;

                        a = CLUT[base2++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o1 + ((( k1 + ((b - a) * rx) + ((a - k1) * ry) + ((CLUT[base4++] - b) * rz) ) - o1) * rk)) * outputScale;

                        a = CLUT[base2++];
                        b = CLUT[base1++];
                        output[outputPos++] = (o2 + ((( k2 + ((b - a) * rx) + ((a - k2) * ry) + ((CLUT[base4++] - b) * rz) ) - o2) * rk)) * outputScale;

                        a = CLUT[base2];
                        b = CLUT[base1];
                        output[outputPos++] = (o3 + ((( k3 + ((b - a) * rx) + ((a - k3) * ry) + ((CLUT[base4  ] - b) * rz) ) - o3) * rk)) * outputScale;
                    } else {
                        output[outputPos++] = o0 * outputScale;
                        output[outputPos++] = o1 * outputScale;
                        output[outputPos++] = o2 * outputScale;
                        output[outputPos++] = o3 * outputScale;
                    }

                } else if (ry >= rz && rz >= rx) {
                    // block5

                    base1 = X1 + Y1 + Z1 + K0;
                    base2 = X0 + Y1 + Z1 + K0;
                    base3 = X0 + Y1 + Z0 + K0;
                    //base4 = base2;
                    //base5 = base3;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    o0 = c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz);

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    o1 = c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz);

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    o2 = c2 + ((CLUT[base1++] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz);

                    a = CLUT[base2];
                    b = CLUT[base3];
                    o3 = c3 + ((CLUT[base1] - a) * rx) + ((b - c3) * ry) + ((a - b) * rz);

                    if(interpK) {
                        base1 += kOffset;
                        base2 += kOffset;
                        base3 += kOffset;

                        a = CLUT[base2++];
                        b = CLUT[base3++];
                        output[outputPos++] = (o0 + ((( k0 + ((CLUT[base1++] - a) * rx) + ((b - k0) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                        a = CLUT[base2++];
                        b = CLUT[base3++];
                        output[outputPos++] = (o1 + ((( k1 + ((CLUT[base1++] - a) * rx) + ((b - k1) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                        a = CLUT[base2++];
                        b = CLUT[base3++];
                        output[outputPos++] = (o2 + ((( k2 + ((CLUT[base1++] - a) * rx) + ((b - k2) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                        a = CLUT[base2];
                        b = CLUT[base3];
                        output[outputPos++] = (o3 + ((( k3 + ((CLUT[base1++] - a) * rx) + ((b - k3) * ry) + ((a - b) * rz) ) - o3) * rk)) * outputScale;
                    } else {
                        output[outputPos++] = o0 * outputScale;
                        output[outputPos++] = o1 * outputScale;
                        output[outputPos++] = o2 * outputScale;
                        output[outputPos++] = o3 * outputScale;
                    }

                } else if (rz >= ry && ry >= rx) {
                    // block6

                    base1 = X1 + Y1 + Z1 + K0;
                    base2 = X0 + Y1 + Z1 + K0;
                    //base3 = base2;
                    base4 = X0 + Y0 + Z1 + K0;
                    //base5 = base4;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    o0 = c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    o1 = c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz);

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    o2 = c2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz);

                    a = CLUT[base2]
                    b = CLUT[base4]
                    o3 = c3 + ((CLUT[base1] - a) * rx) + ((a - b) * ry) + ((b - c3) * rz);

                    if(interpK) {
                        base1 += kOffset;
                        base2 += kOffset;
                        base4 += kOffset;

                        a = CLUT[base2++]
                        b = CLUT[base4++]
                        output[outputPos++] = (o0 + ((( k0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - k0) * rz) ) - o0) * rk)) * outputScale;

                        a = CLUT[base2++]
                        b = CLUT[base4++]
                        output[outputPos++] = (o1 + ((( k1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - k1) * rz) ) - o1) * rk)) * outputScale;

                        a = CLUT[base2++]
                        b = CLUT[base4++]
                        output[outputPos++] = (o2 + ((( k2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - k2) * rz) ) - o2) * rk)) * outputScale;

                        a = CLUT[base2]
                        b = CLUT[base4]
                        output[outputPos++] = (o3 + ((( k3 + ((CLUT[base1  ] - a) * rx) + ((a - b) * ry) + ((b - k3) * rz) ) - o3) * rk)) * outputScale;
                    } else {
                        output[outputPos++] = o0 * outputScale;
                        output[outputPos++] = o1 * outputScale;
                        output[outputPos++] = o2 * outputScale;
                        output[outputPos++] = o3 * outputScale;
                    }

                } else {
                    if(interpK) {
                        output[outputPos++] = c0 + (( k0 - c0 ) * rk) * outputScale;
                        output[outputPos++] = c1 + (( k1 - c1 ) * rk) * outputScale;
                        output[outputPos++] = c2 + (( k2 - c2 ) * rk) * outputScale;
                        output[outputPos++] = c3 + (( k3 - c3 ) * rk) * outputScale;
                    } else {
                        output[outputPos++] = c0 * outputScale;
                        output[outputPos++] = c1 * outputScale;
                        output[outputPos++] = c2 * outputScale;
                        output[outputPos++] = c3 * outputScale;
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
         * INT HOT PATH. 4D LUT, 4-channel input → 3-channel output.
         * Integer-math sibling of tetrahedralInterp4DArray_3Ch_loop.
         * Used when lutMode='int' is set. Typical use: CMYK → RGB / Lab.
         *
         * Same K-axis early-out as the float kernel: when rk=0 (input lands
         * exactly on a K grid plane) or inputK===255 (top boundary), only
         * one 3D tetrahedral pass runs. Otherwise both K planes are
         * interpolated and LERPed by rk.
         *
         * -----------------------------------------------------------------
         * U20 SINGLE-ROUNDING DESIGN (all non-degenerate tetrahedral cases)
         * -----------------------------------------------------------------
         * CLUT stays u16 (Uint16Array). Intermediate interpolated values
         * o0/o1/o2 are carried at u20 precision (Q16.4 — four extra
         * fractional bits vs u16). This buys two things:
         *
         *   1. ONE meaningful rounding step instead of three.
         *      Old kernel did: K0 plane >>8, K1 plane >>8, K-LERP >>8,
         *      final >>8 — four stacked roundings, each ±0.5 LSB of error.
         *      New kernel does: inner >>4 (negligible: 1/16 LSB of u16 =
         *      ~1/4096 LSB of u8), final >>20 (the only meaningful ½ LSB).
         *      Result: max diff on CMYK→CMYK drops from 3 LSB → 1 LSB.
         *      Combined with the u16 CLUT scale fix (255×256 not 65535)
         *      and the Q0.16 `gridPointsScale_fixed` fix (both in v1.1),
         *      CMYK→RGB also holds to ≤1 LSB max on GRACoL2006.
         *
         *   2. No int32 overflow. All intermediate Math.imul operations
         *      fit safely in signed 32-bit. Constraint math:
         *        o0_u20     ≤ 2^20         (u16 × 16)
         *        o0 << 8    ≤ 2^28         (~268M)
         *        |K1-o0|    ≤ 2^20
         *        imul(K1-o0, rk)  ≤ 2^20 × 255  ≤ 2^28
         *        sum        ≤ 2 × 2^28     ≤ 2^29 (~537M)
         *      All well below signed-int32 ceiling (2^31 - 1 ≈ 2.14B).
         *      Going beyond u20 (e.g. u22) would start pushing limits.
         *
         * Final K-LERP collapses three stacked `>> 8` rounds into:
         *   ((o << 8) + imul(K1_u20 - o, rk) + 0x80000) >> 20
         * where K1_u20 is inlined as `(d << 4) + ((sum + 0x08) >> 4)`
         * (no named temporary — the sum expression is reused in place to
         * avoid forcing the JIT to spill `sum` to stack — see PERFORMANCE
         * LESSONS at the top of this file).
         *
         * Non-interpK path: `(o_u20 + 0x800) >> 12` (shift from u20 → u8).
         *
         * Degenerate rx==ry==rz path: uses a straight u16 K-LERP with
         * correct `+0x8000) >> 16` bias. (The pre-u1.1 code had a
         * rounding-bias bug here — `+0x80` instead of `+0x8000` — fixed
         * at the same time as the u20 refactor.)
         *
         * Bench reference: bench/fastLUT_real_world.js with GRACoL2006.
         */
        tetrahedralInterp4DArray_3Ch_intLut_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0, K0 = 0|0;
            var rx = 0|0, ry = 0|0, rz = 0|0, rk = 0|0;
            var px = 0|0, py = 0|0, pz = 0|0, pk = 0|0;
            var input0 = 0|0, input1 = 0|0, input2 = 0|0, inputK = 0|0;
            var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
            var c0 = 0|0, c1 = 0|0, c2 = 0|0;
            var d0 = 0|0, d1 = 0|0, d2 = 0|0;
            var o0 = 0|0, o1 = 0|0, o2 = 0|0;
            var a = 0|0, b = 0|0;
            var interpK = false;

            var gps  = intLut.gridPointsScale_fixed | 0;
            var CLUT = intLut.CLUT;
            var go0  = intLut.go0 | 0;
            var go1  = intLut.go1 | 0;
            var go2  = intLut.go2 | 0;
            var go3  = intLut.go3 | 0;
            var maxX = intLut.maxX | 0;
            var maxY = intLut.maxY | 0;
            var maxZ = intLut.maxZ | 0;
            var maxK = intLut.maxK | 0;
            // +1 because the c0/c1/c2 reads above didn't do a final base++ before
            // jumping to the K1 plane — same convention as the float kernel.
            var kOffset = (go3 - intLut.outputChannels + 1) | 0;

            for(var p = 0; p < length; p++) {
                inputK = input[inputPos++]; // K
                input0 = input[inputPos++]; // C
                input1 = input[inputPos++]; // M
                input2 = input[inputPos++]; // Y

                // Q0.8 grid coords with 4-axis input===255 boundary patches.
                // The K-axis patch (inputK===255) is in the K-interp guard
                // below: when inputK===255 we set K0=maxK and force interpK
                // off, since there's no "K1 plane above the top of the LUT".
                pk = Math.imul(inputK, gps);
                if (inputK === 255) { K0 = maxK; rk = 0; }
                else { K0 = pk >>> 16; rk = (pk >>> 8) & 0xFF; K0 = Math.imul(K0, go3); }

                px = Math.imul(input0, gps);
                if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
                else { X0 = px >>> 16; rx = (px >>> 8) & 0xFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

                py = Math.imul(input1, gps);
                if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
                else { Y0 = py >>> 16; ry = (py >>> 8) & 0xFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

                pz = Math.imul(input2, gps);
                if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
                else { Z0 = pz >>> 16; rz = (pz >>> 8) & 0xFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

                base1 = X0 + Y0 + Z0 + K0;
                c0 = CLUT[base1++]; c1 = CLUT[base1++]; c2 = CLUT[base1];

                if (inputK === 255 || rk === 0) {
                    interpK = false;
                } else {
                    base1 += kOffset;
                    d0 = CLUT[base1++]; d1 = CLUT[base1++]; d2 = CLUT[base1];
                    interpK = true;
                }

                // Six tetrahedral cases. Each case does:
                //   1. 3D interp at K0 plane → o0/o1/o2 in u16 scale
                //   2. if interpK: 3D interp at K1 plane (inline) + K-LERP →
                //      final u8 via two-step rounding
                //   3. else: final u8 from o via single-step rounding
                // The 3D-interp form mirrors the 3D 3Ch intLut kernel exactly;
                // only the +K0 in base offsets and the K-interp tail are new.
                // Tetrahedral inner-interp produces o0/o1/o2 at u20 (Q16.4)
                // scale: o = (corner << 4) + ((sum + 0x08) >> 4). The inner
                // `>> 4` is a negligible 1/16-LSB-of-u16 rounding step.
                // Final u8 is one meaningful rounding step away:
                //   - interpK: ((o << 8) + imul(K1_u20 - o, rk) + 0x80000) >> 20
                //   - non-interpK: (o + 0x800) >> 12
                // See INTEGER HOT PATH header for the full derivation and
                // int32-overflow analysis behind the u20 choice.
                if (rx >= ry && ry >= rz) {
                    base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o0 = (c0 << 4) + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o1 = (c1 << 4) + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                    a = CLUT[base1];   b = CLUT[base2];
                    o2 = (c2 << 4) + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x08) >> 4);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base4 += kOffset;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4) + ((Math.imul(a - d0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        output[outputPos++] = ((o1 << 8) + Math.imul(((d1 << 4) + ((Math.imul(a - d1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        output[outputPos++] = ((o2 << 8) + Math.imul(((d2 << 4) + ((Math.imul(a - d2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                    } else {
                        output[outputPos++] = (o0 + 0x800) >> 12;
                        output[outputPos++] = (o1 + 0x800) >> 12;
                        output[outputPos++] = (o2 + 0x800) >> 12;
                    }
                } else if (rx >= rz && rz >= ry) {
                    base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z1 + K0; base3 = X1 + Y0 + Z1 + K0;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    o0 = (c0 << 4) + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    a = CLUT[base3++]; b = CLUT[base1++];
                    o1 = (c1 << 4) + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    a = CLUT[base3];   b = CLUT[base1];
                    o2 = (c2 << 4) + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    if (interpK) {
                        base3 += kOffset; base1 += kOffset; base2 += kOffset;
                        a = CLUT[base3++]; b = CLUT[base1++];
                        output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4) + ((Math.imul(b - d0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                        a = CLUT[base3++]; b = CLUT[base1++];
                        output[outputPos++] = ((o1 << 8) + Math.imul(((d1 << 4) + ((Math.imul(b - d1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                        a = CLUT[base3++]; b = CLUT[base1++];
                        output[outputPos++] = ((o2 << 8) + Math.imul(((d2 << 4) + ((Math.imul(b - d2, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                    } else {
                        output[outputPos++] = (o0 + 0x800) >> 12;
                        output[outputPos++] = (o1 + 0x800) >> 12;
                        output[outputPos++] = (o2 + 0x800) >> 12;
                    }
                } else if (rx >= ry && rz >= rx) {
                    base1 = X1 + Y0 + Z1 + K0; base2 = X0 + Y0 + Z1 + K0; base3 = X1 + Y1 + Z1 + K0;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o0 = (c0 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x08) >> 4);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o1 = (c1 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x08) >> 4);
                    a = CLUT[base1];   b = CLUT[base2];
                    o2 = (c2 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c2, rz) + 0x08) >> 4);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base3 += kOffset;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - d0, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        output[outputPos++] = ((o1 << 8) + Math.imul(((d1 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - d1, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        output[outputPos++] = ((o2 << 8) + Math.imul(((d2 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - d2, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                    } else {
                        output[outputPos++] = (o0 + 0x800) >> 12;
                        output[outputPos++] = (o1 + 0x800) >> 12;
                        output[outputPos++] = (o2 + 0x800) >> 12;
                    }
                } else if (ry >= rx && rx >= rz) {
                    base1 = X1 + Y1 + Z0 + K0; base2 = X0 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    o0 = (c0 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                    a = CLUT[base2++]; b = CLUT[base1++];
                    o1 = (c1 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                    a = CLUT[base2];   b = CLUT[base1];
                    o2 = (c2 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x08) >> 4);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base4 += kOffset;
                        a = CLUT[base2++]; b = CLUT[base1++];
                        output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - d0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                        a = CLUT[base2++]; b = CLUT[base1++];
                        output[outputPos++] = ((o1 << 8) + Math.imul(((d1 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - d1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                        a = CLUT[base2++]; b = CLUT[base1++];
                        output[outputPos++] = ((o2 << 8) + Math.imul(((d2 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - d2, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                    } else {
                        output[outputPos++] = (o0 + 0x800) >> 12;
                        output[outputPos++] = (o1 + 0x800) >> 12;
                        output[outputPos++] = (o2 + 0x800) >> 12;
                    }
                } else if (ry >= rz && rz >= rx) {
                    base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base3 = X0 + Y1 + Z0 + K0;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    o0 = (c0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    a = CLUT[base2++]; b = CLUT[base3++];
                    o1 = (c1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    a = CLUT[base2];   b = CLUT[base3];
                    o2 = (c2 << 4) + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base3 += kOffset;
                        a = CLUT[base2++]; b = CLUT[base3++];
                        output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - d0, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                        a = CLUT[base2++]; b = CLUT[base3++];
                        output[outputPos++] = ((o1 << 8) + Math.imul(((d1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - d1, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                        a = CLUT[base2++]; b = CLUT[base3++];
                        output[outputPos++] = ((o2 << 8) + Math.imul(((d2 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - d2, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                    } else {
                        output[outputPos++] = (o0 + 0x800) >> 12;
                        output[outputPos++] = (o1 + 0x800) >> 12;
                        output[outputPos++] = (o2 + 0x800) >> 12;
                    }
                } else if (rz >= ry && ry >= rx) {
                    base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base4 = X0 + Y0 + Z1 + K0;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    o0 = (c0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x08) >> 4);
                    a = CLUT[base2++]; b = CLUT[base4++];
                    o1 = (c1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x08) >> 4);
                    a = CLUT[base2];   b = CLUT[base4];
                    o2 = (c2 << 4) + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x08) >> 4);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base4 += kOffset;
                        a = CLUT[base2++]; b = CLUT[base4++];
                        output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - d0, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                        a = CLUT[base2++]; b = CLUT[base4++];
                        output[outputPos++] = ((o1 << 8) + Math.imul(((d1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - d1, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                        a = CLUT[base2++]; b = CLUT[base4++];
                        output[outputPos++] = ((o2 << 8) + Math.imul(((d2 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - d2, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                    } else {
                        output[outputPos++] = (o0 + 0x800) >> 12;
                        output[outputPos++] = (o1 + 0x800) >> 12;
                        output[outputPos++] = (o2 + 0x800) >> 12;
                    }
                } else {
                    // Degenerate rx==ry==rz path. Mirrors the float kernel's
                    // K-only LERP (no 3D interp needed when all weights equal).
                    // Also fixes a pre-existing rounding-bias bug: the +0x80
                    // was correct for >> 8 but wrong for >> 16 (half of 2^16
                    // is 0x8000). Contributed ≤1 LSB drift on this branch.
                    if (interpK) {
                        output[outputPos++] = ((c0 << 8) + Math.imul(d0 - c0, rk) + 0x8000) >> 16;
                        output[outputPos++] = ((c1 << 8) + Math.imul(d1 - c1, rk) + 0x8000) >> 16;
                        output[outputPos++] = ((c2 << 8) + Math.imul(d2 - c2, rk) + 0x8000) >> 16;
                    } else {
                        output[outputPos++] = (c0 + 0x80) >> 8;
                        output[outputPos++] = (c1 + 0x80) >> 8;
                        output[outputPos++] = (c2 + 0x80) >> 8;
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
         * INT HOT PATH. 4D LUT, 4-channel input → 4-channel output.
         * Integer-math sibling of tetrahedralInterp4DArray_4Ch_loop.
         * Used when lutMode='int' is set. Typical use: CMYK → CMYK
         * profile-to-profile re-purposing (SWOP → GRACoL etc).
         *
         * Same u20 single-rounding design as the 4D 3Ch intLut kernel
         * above — see that JSDoc for the derivation and int32 overflow
         * analysis. Differences here:
         *   - Reads 4 LUT values per sub-block (one extra channel write)
         *   - Uses k0..k3 instead of d0..d2 for K1 plane corners (matches
         *     float kernel's variable naming)
         *
         * Accuracy on GRACoL2006 → GRACoL2006 (65k random pixels,
         * bench/fastLUT_real_world.js): 95.89 % bit-exact vs float, max
         * 1 LSB drift on the remaining 4.11 %, zero channels off by ≥2.
         */
        tetrahedralInterp4DArray_4Ch_intLut_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0, K0 = 0|0;
            var rx = 0|0, ry = 0|0, rz = 0|0, rk = 0|0;
            var px = 0|0, py = 0|0, pz = 0|0, pk = 0|0;
            var input0 = 0|0, input1 = 0|0, input2 = 0|0, inputK = 0|0;
            var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
            var c0 = 0|0, c1 = 0|0, c2 = 0|0, c3 = 0|0;
            var k0 = 0|0, k1 = 0|0, k2 = 0|0, k3 = 0|0;
            var o0 = 0|0, o1 = 0|0, o2 = 0|0, o3 = 0|0;
            var a = 0|0, b = 0|0;
            var interpK = false;

            var gps  = intLut.gridPointsScale_fixed | 0;
            var CLUT = intLut.CLUT;
            var go0  = intLut.go0 | 0;
            var go1  = intLut.go1 | 0;
            var go2  = intLut.go2 | 0;
            var go3  = intLut.go3 | 0;
            var maxX = intLut.maxX | 0;
            var maxY = intLut.maxY | 0;
            var maxZ = intLut.maxZ | 0;
            var maxK = intLut.maxK | 0;
            var kOffset = (go3 - intLut.outputChannels + 1) | 0;

            for(var p = 0; p < length; p++) {
                inputK = input[inputPos++]; // K
                input0 = input[inputPos++]; // C
                input1 = input[inputPos++]; // M
                input2 = input[inputPos++]; // Y

                pk = Math.imul(inputK, gps);
                if (inputK === 255) { K0 = maxK; rk = 0; }
                else { K0 = pk >>> 16; rk = (pk >>> 8) & 0xFF; K0 = Math.imul(K0, go3); }

                px = Math.imul(input0, gps);
                if (input0 === 255) { X0 = maxX; X1 = maxX; rx = 0; }
                else { X0 = px >>> 16; rx = (px >>> 8) & 0xFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

                py = Math.imul(input1, gps);
                if (input1 === 255) { Y0 = maxY; Y1 = maxY; ry = 0; }
                else { Y0 = py >>> 16; ry = (py >>> 8) & 0xFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

                pz = Math.imul(input2, gps);
                if (input2 === 255) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
                else { Z0 = pz >>> 16; rz = (pz >>> 8) & 0xFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

                base1 = X0 + Y0 + Z0 + K0;
                c0 = CLUT[base1++]; c1 = CLUT[base1++]; c2 = CLUT[base1++]; c3 = CLUT[base1];

                if (inputK === 255 || rk === 0) {
                    interpK = false;
                } else {
                    base1 += kOffset;
                    k0 = CLUT[base1++]; k1 = CLUT[base1++]; k2 = CLUT[base1++]; k3 = CLUT[base1];
                    interpK = true;
                }

                // Same u20 (Q16.4) single-rounding design as the 4D 3Ch
                // intLut kernel above. Inner 3D interp lands o0..o3 at u20
                // scale, then the K-LERP folds K1 plane interp and final
                // u8 rounding into one `+0x80000) >> 20` operation.
                if (rx >= ry && ry >= rz) {
                    base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o0 = (c0 << 4) + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o1 = (c1 << 4) + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o2 = (c2 << 4) + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                    a = CLUT[base1];   b = CLUT[base2];
                    o3 = (c3 << 4) + ((Math.imul(a - c3, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x08) >> 4);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base4 += kOffset;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        output[outputPos++] = ((o0 << 8) + Math.imul(((k0 << 4) + ((Math.imul(a - k0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        output[outputPos++] = ((o1 << 8) + Math.imul(((k1 << 4) + ((Math.imul(a - k1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        output[outputPos++] = ((o2 << 8) + Math.imul(((k2 << 4) + ((Math.imul(a - k2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                        a = CLUT[base1];   b = CLUT[base2];
                        output[outputPos++] = ((o3 << 8) + Math.imul(((k3 << 4) + ((Math.imul(a - k3, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x08) >> 4)) - o3, rk) + 0x80000) >> 20;
                    } else {
                        output[outputPos++] = (o0 + 0x800) >> 12;
                        output[outputPos++] = (o1 + 0x800) >> 12;
                        output[outputPos++] = (o2 + 0x800) >> 12;
                        output[outputPos++] = (o3 + 0x800) >> 12;
                    }
                } else if (rx >= rz && rz >= ry) {
                    base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z1 + K0; base3 = X1 + Y0 + Z1 + K0;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    o0 = (c0 << 4) + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    a = CLUT[base3++]; b = CLUT[base1++];
                    o1 = (c1 << 4) + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    a = CLUT[base3++]; b = CLUT[base1++];
                    o2 = (c2 << 4) + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    a = CLUT[base3];   b = CLUT[base1];
                    o3 = (c3 << 4) + ((Math.imul(b - c3, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    if (interpK) {
                        base3 += kOffset; base1 += kOffset; base2 += kOffset;
                        a = CLUT[base3++]; b = CLUT[base1++];
                        output[outputPos++] = ((o0 << 8) + Math.imul(((k0 << 4) + ((Math.imul(b - k0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                        a = CLUT[base3++]; b = CLUT[base1++];
                        output[outputPos++] = ((o1 << 8) + Math.imul(((k1 << 4) + ((Math.imul(b - k1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                        a = CLUT[base3++]; b = CLUT[base1++];
                        output[outputPos++] = ((o2 << 8) + Math.imul(((k2 << 4) + ((Math.imul(b - k2, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                        a = CLUT[base3];   b = CLUT[base1];
                        output[outputPos++] = ((o3 << 8) + Math.imul(((k3 << 4) + ((Math.imul(b - k3, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o3, rk) + 0x80000) >> 20;
                    } else {
                        output[outputPos++] = (o0 + 0x800) >> 12;
                        output[outputPos++] = (o1 + 0x800) >> 12;
                        output[outputPos++] = (o2 + 0x800) >> 12;
                        output[outputPos++] = (o3 + 0x800) >> 12;
                    }
                } else if (rx >= ry && rz >= rx) {
                    base1 = X1 + Y0 + Z1 + K0; base2 = X0 + Y0 + Z1 + K0; base3 = X1 + Y1 + Z1 + K0;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o0 = (c0 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x08) >> 4);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o1 = (c1 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x08) >> 4);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o2 = (c2 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c2, rz) + 0x08) >> 4);
                    a = CLUT[base1];   b = CLUT[base2];
                    o3 = (c3 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c3, rz) + 0x08) >> 4);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base3 += kOffset;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        output[outputPos++] = ((o0 << 8) + Math.imul(((k0 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - k0, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        output[outputPos++] = ((o1 << 8) + Math.imul(((k1 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - k1, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        output[outputPos++] = ((o2 << 8) + Math.imul(((k2 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - k2, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                        a = CLUT[base1];   b = CLUT[base2];
                        output[outputPos++] = ((o3 << 8) + Math.imul(((k3 << 4) + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - k3, rz) + 0x08) >> 4)) - o3, rk) + 0x80000) >> 20;
                    } else {
                        output[outputPos++] = (o0 + 0x800) >> 12;
                        output[outputPos++] = (o1 + 0x800) >> 12;
                        output[outputPos++] = (o2 + 0x800) >> 12;
                        output[outputPos++] = (o3 + 0x800) >> 12;
                    }
                } else if (ry >= rx && rx >= rz) {
                    base1 = X1 + Y1 + Z0 + K0; base2 = X0 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    o0 = (c0 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                    a = CLUT[base2++]; b = CLUT[base1++];
                    o1 = (c1 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                    a = CLUT[base2++]; b = CLUT[base1++];
                    o2 = (c2 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4);
                    a = CLUT[base2];   b = CLUT[base1];
                    o3 = (c3 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - c3, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x08) >> 4);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base4 += kOffset;
                        a = CLUT[base2++]; b = CLUT[base1++];
                        output[outputPos++] = ((o0 << 8) + Math.imul(((k0 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - k0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                        a = CLUT[base2++]; b = CLUT[base1++];
                        output[outputPos++] = ((o1 << 8) + Math.imul(((k1 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - k1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                        a = CLUT[base2++]; b = CLUT[base1++];
                        output[outputPos++] = ((o2 << 8) + Math.imul(((k2 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - k2, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                        a = CLUT[base2];   b = CLUT[base1];
                        output[outputPos++] = ((o3 << 8) + Math.imul(((k3 << 4) + ((Math.imul(b - a, rx) + Math.imul(a - k3, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x08) >> 4)) - o3, rk) + 0x80000) >> 20;
                    } else {
                        output[outputPos++] = (o0 + 0x800) >> 12;
                        output[outputPos++] = (o1 + 0x800) >> 12;
                        output[outputPos++] = (o2 + 0x800) >> 12;
                        output[outputPos++] = (o3 + 0x800) >> 12;
                    }
                } else if (ry >= rz && rz >= rx) {
                    base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base3 = X0 + Y1 + Z0 + K0;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    o0 = (c0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    a = CLUT[base2++]; b = CLUT[base3++];
                    o1 = (c1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    a = CLUT[base2++]; b = CLUT[base3++];
                    o2 = (c2 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    a = CLUT[base2];   b = CLUT[base3];
                    o3 = (c3 << 4) + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c3, ry) + Math.imul(a - b, rz) + 0x08) >> 4);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base3 += kOffset;
                        a = CLUT[base2++]; b = CLUT[base3++];
                        output[outputPos++] = ((o0 << 8) + Math.imul(((k0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - k0, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                        a = CLUT[base2++]; b = CLUT[base3++];
                        output[outputPos++] = ((o1 << 8) + Math.imul(((k1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - k1, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                        a = CLUT[base2++]; b = CLUT[base3++];
                        output[outputPos++] = ((o2 << 8) + Math.imul(((k2 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - k2, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                        a = CLUT[base2];   b = CLUT[base3];
                        output[outputPos++] = ((o3 << 8) + Math.imul(((k3 << 4) + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - k3, ry) + Math.imul(a - b, rz) + 0x08) >> 4)) - o3, rk) + 0x80000) >> 20;
                    } else {
                        output[outputPos++] = (o0 + 0x800) >> 12;
                        output[outputPos++] = (o1 + 0x800) >> 12;
                        output[outputPos++] = (o2 + 0x800) >> 12;
                        output[outputPos++] = (o3 + 0x800) >> 12;
                    }
                } else if (rz >= ry && ry >= rx) {
                    base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base4 = X0 + Y0 + Z1 + K0;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    o0 = (c0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x08) >> 4);
                    a = CLUT[base2++]; b = CLUT[base4++];
                    o1 = (c1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x08) >> 4);
                    a = CLUT[base2++]; b = CLUT[base4++];
                    o2 = (c2 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x08) >> 4);
                    a = CLUT[base2];   b = CLUT[base4];
                    o3 = (c3 << 4) + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c3, rz) + 0x08) >> 4);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base4 += kOffset;
                        a = CLUT[base2++]; b = CLUT[base4++];
                        output[outputPos++] = ((o0 << 8) + Math.imul(((k0 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - k0, rz) + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
                        a = CLUT[base2++]; b = CLUT[base4++];
                        output[outputPos++] = ((o1 << 8) + Math.imul(((k1 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - k1, rz) + 0x08) >> 4)) - o1, rk) + 0x80000) >> 20;
                        a = CLUT[base2++]; b = CLUT[base4++];
                        output[outputPos++] = ((o2 << 8) + Math.imul(((k2 << 4) + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - k2, rz) + 0x08) >> 4)) - o2, rk) + 0x80000) >> 20;
                        a = CLUT[base2];   b = CLUT[base4];
                        output[outputPos++] = ((o3 << 8) + Math.imul(((k3 << 4) + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - k3, rz) + 0x08) >> 4)) - o3, rk) + 0x80000) >> 20;
                    } else {
                        output[outputPos++] = (o0 + 0x800) >> 12;
                        output[outputPos++] = (o1 + 0x800) >> 12;
                        output[outputPos++] = (o2 + 0x800) >> 12;
                        output[outputPos++] = (o3 + 0x800) >> 12;
                    }
                } else {
                    // Degenerate rx==ry==rz K-only LERP.
                    // Fixes pre-existing rounding-bias bug: +0x80 was wrong
                    // for >> 16 (half of 2^16 is 0x8000).
                    if (interpK) {
                        output[outputPos++] = ((c0 << 8) + Math.imul(k0 - c0, rk) + 0x8000) >> 16;
                        output[outputPos++] = ((c1 << 8) + Math.imul(k1 - c1, rk) + 0x8000) >> 16;
                        output[outputPos++] = ((c2 << 8) + Math.imul(k2 - c2, rk) + 0x8000) >> 16;
                        output[outputPos++] = ((c3 << 8) + Math.imul(k3 - c3, rk) + 0x8000) >> 16;
                    } else {
                        output[outputPos++] = (c0 + 0x80) >> 8;
                        output[outputPos++] = (c1 + 0x80) >> 8;
                        output[outputPos++] = (c2 + 0x80) >> 8;
                        output[outputPos++] = (c3 + 0x80) >> 8;
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
         * INT16 HOT PATH (v1.3, Q0.13). 4D LUT, 4-channel input → 3-channel output.
         * Typical use: u16 CMYK→RGB / CMYK→Lab analysis pipelines and
         * 16-bit soft-proof previews. Mirror of
         * tetrahedralInterp4DArray_3Ch_intLut_loop, redesigned for true
         * 16-bit precision per the v1.3 (Q0.13) contract.
         *
         * v1.3 design — TWO-ROUNDING (XYZ → u16, then K-LERP → u16):
         *   1. Tetra-interpolate XYZ at K0 plane → o = c + ((sum + 0x1000) >> 13)
         *      yielding a u16 result. Single rounding from u13 weights.
         *   2. If interpK, tetra-interpolate XYZ at K1 plane the same way → v
         *      yielding a second u16 result.
         *   3. Linear-interpolate o↔v over K with `o + ((imul(v - o, rk) + 0x1000) >> 13)`.
         *      Single rounding from u13 weight rk.
         *
         * Why two roundings instead of u8's one (Q16.4 u20 intermediate)?
         *   With u13 weights `imul(corner_u17, w_u13)` already eats ~30 bits of
         *   i32 headroom; carrying a u20 XYZ result into a `(o << 8) + ...`
         *   K-LERP would overflow i32 (30 + sign + outer add > 31). The two-
         *   rounding path keeps every accumulator ≤ 2^30.6, fits in i32 with
         *   ~1.4 bits headroom, and has worst-case error ≤ 1 LSB (u16) — same
         *   spec as the 3D kernels, accepted in lieu of the u8 mode's exact
         *   single-rounding because u16 outputs already absorb the noise.
         *
         * Per-axis bit budget (matches 3D, see tetrahedralInterp3DArray_3Ch_intLut16_loop):
         *   delta = corner_u16 - c_u16 → s17.  imul(delta, weight_u13) → s30.
         *   sum of 3 terms: s30.6. + 0x1000 (s30.6) → s30.6. >> 13 → s17.6,
         *   ∈ [-8, 65543]. c_u16 + that → u16 (clamped by data invariants).
         */
        tetrahedralInterp4DArray_3Ch_intLut16_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0, K0 = 0|0;
            var rx = 0|0, ry = 0|0, rz = 0|0, rk = 0|0;
            var px = 0|0, py = 0|0, pz = 0|0, pk = 0|0;
            var input0 = 0|0, input1 = 0|0, input2 = 0|0, inputK = 0|0;
            var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
            var c0 = 0|0, c1 = 0|0, c2 = 0|0;
            var d0 = 0|0, d1 = 0|0, d2 = 0|0;
            var o0 = 0|0, o1 = 0|0, o2 = 0|0;
            var a = 0|0, b = 0|0;
            var v = 0|0;
            var interpK = false;

            var gps  = intLut.gridPointsScale_fixed_u16 | 0;   // Q0.13 (v1.3)
            var CLUT = intLut.CLUT;                             // u16 CLUT @ scale 65535 (v1.3)
            var go0  = intLut.go0 | 0;
            var go1  = intLut.go1 | 0;
            var go2  = intLut.go2 | 0;
            var go3  = intLut.go3 | 0;
            var maxX = intLut.maxX | 0;
            var maxY = intLut.maxY | 0;
            var maxZ = intLut.maxZ | 0;
            var maxK = intLut.maxK | 0;
            var kOffset = (go3 - intLut.outputChannels + 1) | 0;

            for(var p = 0; p < length; p++) {
                inputK = input[inputPos++];
                input0 = input[inputPos++];
                input1 = input[inputPos++];
                input2 = input[inputPos++];

                pk = Math.imul(inputK, gps);
                if (inputK === 65535) { K0 = maxK; rk = 0; }
                else { K0 = pk >>> 13; rk = pk & 0x1FFF; K0 = Math.imul(K0, go3); }

                px = Math.imul(input0, gps);
                if (input0 === 65535) { X0 = maxX; X1 = maxX; rx = 0; }
                else { X0 = px >>> 13; rx = px & 0x1FFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

                py = Math.imul(input1, gps);
                if (input1 === 65535) { Y0 = maxY; Y1 = maxY; ry = 0; }
                else { Y0 = py >>> 13; ry = py & 0x1FFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

                pz = Math.imul(input2, gps);
                if (input2 === 65535) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
                else { Z0 = pz >>> 13; rz = pz & 0x1FFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

                base1 = X0 + Y0 + Z0 + K0;
                c0 = CLUT[base1++]; c1 = CLUT[base1++]; c2 = CLUT[base1];

                if (inputK === 65535 || rk === 0) {
                    interpK = false;
                } else {
                    base1 += kOffset;
                    d0 = CLUT[base1++]; d1 = CLUT[base1++]; d2 = CLUT[base1];
                    interpK = true;
                }

                if (rx >= ry && ry >= rz) {
                    base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o0 = c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o1 = c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base1];   b = CLUT[base2];
                    o2 = c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x1000) >> 13);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base4 += kOffset;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        v = d0 + ((Math.imul(a - d0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o0 + ((Math.imul(v - o0, rk) + 0x1000) >> 13);
                        a = CLUT[base1++]; b = CLUT[base2++];
                        v = d1 + ((Math.imul(a - d1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o1 + ((Math.imul(v - o1, rk) + 0x1000) >> 13);
                        a = CLUT[base1];   b = CLUT[base2];
                        v = d2 + ((Math.imul(a - d2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o2 + ((Math.imul(v - o2, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = o0;
                        output[outputPos++] = o1;
                        output[outputPos++] = o2;
                    }
                } else if (rx >= rz && rz >= ry) {
                    base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z1 + K0; base3 = X1 + Y0 + Z1 + K0;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    o0 = c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base3++]; b = CLUT[base1++];
                    o1 = c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base3];   b = CLUT[base1];
                    o2 = c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    if (interpK) {
                        base3 += kOffset; base1 += kOffset; base2 += kOffset;
                        a = CLUT[base3++]; b = CLUT[base1++];
                        v = d0 + ((Math.imul(b - d0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o0 + ((Math.imul(v - o0, rk) + 0x1000) >> 13);
                        a = CLUT[base3++]; b = CLUT[base1++];
                        v = d1 + ((Math.imul(b - d1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o1 + ((Math.imul(v - o1, rk) + 0x1000) >> 13);
                        a = CLUT[base3];   b = CLUT[base1];
                        v = d2 + ((Math.imul(b - d2, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o2 + ((Math.imul(v - o2, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = o0;
                        output[outputPos++] = o1;
                        output[outputPos++] = o2;
                    }
                } else if (rx >= ry && rz >= rx) {
                    base1 = X1 + Y0 + Z1 + K0; base2 = X0 + Y0 + Z1 + K0; base3 = X1 + Y1 + Z1 + K0;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o0 = c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x1000) >> 13);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o1 = c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x1000) >> 13);
                    a = CLUT[base1];   b = CLUT[base2];
                    o2 = c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c2, rz) + 0x1000) >> 13);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base3 += kOffset;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        v = d0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - d0, rz) + 0x1000) >> 13);
                        output[outputPos++] = o0 + ((Math.imul(v - o0, rk) + 0x1000) >> 13);
                        a = CLUT[base1++]; b = CLUT[base2++];
                        v = d1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - d1, rz) + 0x1000) >> 13);
                        output[outputPos++] = o1 + ((Math.imul(v - o1, rk) + 0x1000) >> 13);
                        a = CLUT[base1];   b = CLUT[base2];
                        v = d2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - d2, rz) + 0x1000) >> 13);
                        output[outputPos++] = o2 + ((Math.imul(v - o2, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = o0;
                        output[outputPos++] = o1;
                        output[outputPos++] = o2;
                    }
                } else if (ry >= rx && rx >= rz) {
                    base1 = X1 + Y1 + Z0 + K0; base2 = X0 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    o0 = c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base1++];
                    o1 = c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2];   b = CLUT[base1];
                    o2 = c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x1000) >> 13);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base4 += kOffset;
                        a = CLUT[base2++]; b = CLUT[base1++];
                        v = d0 + ((Math.imul(b - a, rx) + Math.imul(a - d0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o0 + ((Math.imul(v - o0, rk) + 0x1000) >> 13);
                        a = CLUT[base2++]; b = CLUT[base1++];
                        v = d1 + ((Math.imul(b - a, rx) + Math.imul(a - d1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o1 + ((Math.imul(v - o1, rk) + 0x1000) >> 13);
                        a = CLUT[base2];   b = CLUT[base1];
                        v = d2 + ((Math.imul(b - a, rx) + Math.imul(a - d2, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o2 + ((Math.imul(v - o2, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = o0;
                        output[outputPos++] = o1;
                        output[outputPos++] = o2;
                    }
                } else if (ry >= rz && rz >= rx) {
                    base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base3 = X0 + Y1 + Z0 + K0;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    o0 = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base3++];
                    o1 = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2];   b = CLUT[base3];
                    o2 = c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base3 += kOffset;
                        a = CLUT[base2++]; b = CLUT[base3++];
                        v = d0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - d0, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o0 + ((Math.imul(v - o0, rk) + 0x1000) >> 13);
                        a = CLUT[base2++]; b = CLUT[base3++];
                        v = d1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - d1, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o1 + ((Math.imul(v - o1, rk) + 0x1000) >> 13);
                        a = CLUT[base2];   b = CLUT[base3];
                        v = d2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - d2, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o2 + ((Math.imul(v - o2, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = o0;
                        output[outputPos++] = o1;
                        output[outputPos++] = o2;
                    }
                } else if (rz >= ry && ry >= rx) {
                    base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base4 = X0 + Y0 + Z1 + K0;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    o0 = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base4++];
                    o1 = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x1000) >> 13);
                    a = CLUT[base2];   b = CLUT[base4];
                    o2 = c2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x1000) >> 13);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base4 += kOffset;
                        a = CLUT[base2++]; b = CLUT[base4++];
                        v = d0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - d0, rz) + 0x1000) >> 13);
                        output[outputPos++] = o0 + ((Math.imul(v - o0, rk) + 0x1000) >> 13);
                        a = CLUT[base2++]; b = CLUT[base4++];
                        v = d1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - d1, rz) + 0x1000) >> 13);
                        output[outputPos++] = o1 + ((Math.imul(v - o1, rk) + 0x1000) >> 13);
                        a = CLUT[base2];   b = CLUT[base4];
                        v = d2 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - d2, rz) + 0x1000) >> 13);
                        output[outputPos++] = o2 + ((Math.imul(v - o2, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = o0;
                        output[outputPos++] = o1;
                        output[outputPos++] = o2;
                    }
                } else {
                    if (interpK) {
                        output[outputPos++] = c0 + ((Math.imul(d0 - c0, rk) + 0x1000) >> 13);
                        output[outputPos++] = c1 + ((Math.imul(d1 - c1, rk) + 0x1000) >> 13);
                        output[outputPos++] = c2 + ((Math.imul(d2 - c2, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = c0;
                        output[outputPos++] = c1;
                        output[outputPos++] = c2;
                    }
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
         * INT16 HOT PATH (v1.3, Q0.13). 4D LUT, 4-channel input → 4-channel output.
         * Typical use: u16 CMYK→CMYK profile-to-profile re-purposing
         * (16-bit SWOP → GRACoL etc). 4-channel sibling of
         * tetrahedralInterp4DArray_3Ch_intLut16_loop — same TWO-ROUNDING
         * (XYZ→u16, then K-LERP→u16) design and bit-budget; see that
         * function's header for the v1.3 (Q0.13) contract and i32 overflow
         * analysis. Only difference is one extra channel per tetra case.
         */
        tetrahedralInterp4DArray_4Ch_intLut16_loop(input, inputPos, output, outputPos, length, intLut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var X0 = 0|0, X1 = 0|0, Y0 = 0|0, Y1 = 0|0, Z0 = 0|0, Z1 = 0|0, K0 = 0|0;
            var rx = 0|0, ry = 0|0, rz = 0|0, rk = 0|0;
            var px = 0|0, py = 0|0, pz = 0|0, pk = 0|0;
            var input0 = 0|0, input1 = 0|0, input2 = 0|0, inputK = 0|0;
            var base1 = 0|0, base2 = 0|0, base3 = 0|0, base4 = 0|0;
            var c0 = 0|0, c1 = 0|0, c2 = 0|0, c3 = 0|0;
            var k0 = 0|0, k1 = 0|0, k2 = 0|0, k3 = 0|0;
            var o0 = 0|0, o1 = 0|0, o2 = 0|0, o3 = 0|0;
            var a = 0|0, b = 0|0;
            var v = 0|0;
            var interpK = false;

            var gps  = intLut.gridPointsScale_fixed_u16 | 0;   // Q0.13 (v1.3)
            var CLUT = intLut.CLUT;                             // u16 CLUT @ scale 65535 (v1.3)
            var go0  = intLut.go0 | 0;
            var go1  = intLut.go1 | 0;
            var go2  = intLut.go2 | 0;
            var go3  = intLut.go3 | 0;
            var maxX = intLut.maxX | 0;
            var maxY = intLut.maxY | 0;
            var maxZ = intLut.maxZ | 0;
            var maxK = intLut.maxK | 0;
            var kOffset = (go3 - intLut.outputChannels + 1) | 0;

            for(var p = 0; p < length; p++) {
                inputK = input[inputPos++];
                input0 = input[inputPos++];
                input1 = input[inputPos++];
                input2 = input[inputPos++];

                pk = Math.imul(inputK, gps);
                if (inputK === 65535) { K0 = maxK; rk = 0; }
                else { K0 = pk >>> 13; rk = pk & 0x1FFF; K0 = Math.imul(K0, go3); }

                px = Math.imul(input0, gps);
                if (input0 === 65535) { X0 = maxX; X1 = maxX; rx = 0; }
                else { X0 = px >>> 13; rx = px & 0x1FFF; X0 = Math.imul(X0, go2); X1 = X0 + go2; }

                py = Math.imul(input1, gps);
                if (input1 === 65535) { Y0 = maxY; Y1 = maxY; ry = 0; }
                else { Y0 = py >>> 13; ry = py & 0x1FFF; Y0 = Math.imul(Y0, go1); Y1 = Y0 + go1; }

                pz = Math.imul(input2, gps);
                if (input2 === 65535) { Z0 = maxZ; Z1 = maxZ; rz = 0; }
                else { Z0 = pz >>> 13; rz = pz & 0x1FFF; Z0 = Math.imul(Z0, go0); Z1 = Z0 + go0; }

                base1 = X0 + Y0 + Z0 + K0;
                c0 = CLUT[base1++]; c1 = CLUT[base1++]; c2 = CLUT[base1++]; c3 = CLUT[base1];

                if (inputK === 65535 || rk === 0) {
                    interpK = false;
                } else {
                    base1 += kOffset;
                    k0 = CLUT[base1++]; k1 = CLUT[base1++]; k2 = CLUT[base1++]; k3 = CLUT[base1];
                    interpK = true;
                }

                if (rx >= ry && ry >= rz) {
                    base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o0 = c0 + ((Math.imul(a - c0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o1 = c1 + ((Math.imul(a - c1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o2 = c2 + ((Math.imul(a - c2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base1];   b = CLUT[base2];
                    o3 = c3 + ((Math.imul(a - c3, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x1000) >> 13);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base4 += kOffset;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        v = k0 + ((Math.imul(a - k0, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o0 + ((Math.imul(v - o0, rk) + 0x1000) >> 13);
                        a = CLUT[base1++]; b = CLUT[base2++];
                        v = k1 + ((Math.imul(a - k1, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o1 + ((Math.imul(v - o1, rk) + 0x1000) >> 13);
                        a = CLUT[base1++]; b = CLUT[base2++];
                        v = k2 + ((Math.imul(a - k2, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o2 + ((Math.imul(v - o2, rk) + 0x1000) >> 13);
                        a = CLUT[base1];   b = CLUT[base2];
                        v = k3 + ((Math.imul(a - k3, rx) + Math.imul(b - a, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o3 + ((Math.imul(v - o3, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = o0;
                        output[outputPos++] = o1;
                        output[outputPos++] = o2;
                        output[outputPos++] = o3;
                    }
                } else if (rx >= rz && rz >= ry) {
                    base1 = X1 + Y0 + Z0 + K0; base2 = X1 + Y1 + Z1 + K0; base3 = X1 + Y0 + Z1 + K0;
                    a = CLUT[base3++]; b = CLUT[base1++];
                    o0 = c0 + ((Math.imul(b - c0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base3++]; b = CLUT[base1++];
                    o1 = c1 + ((Math.imul(b - c1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base3++]; b = CLUT[base1++];
                    o2 = c2 + ((Math.imul(b - c2, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base3];   b = CLUT[base1];
                    o3 = c3 + ((Math.imul(b - c3, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    if (interpK) {
                        base3 += kOffset; base1 += kOffset; base2 += kOffset;
                        a = CLUT[base3++]; b = CLUT[base1++];
                        v = k0 + ((Math.imul(b - k0, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o0 + ((Math.imul(v - o0, rk) + 0x1000) >> 13);
                        a = CLUT[base3++]; b = CLUT[base1++];
                        v = k1 + ((Math.imul(b - k1, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o1 + ((Math.imul(v - o1, rk) + 0x1000) >> 13);
                        a = CLUT[base3++]; b = CLUT[base1++];
                        v = k2 + ((Math.imul(b - k2, rx) + Math.imul(CLUT[base2++] - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o2 + ((Math.imul(v - o2, rk) + 0x1000) >> 13);
                        a = CLUT[base3];   b = CLUT[base1];
                        v = k3 + ((Math.imul(b - k3, rx) + Math.imul(CLUT[base2]   - a, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o3 + ((Math.imul(v - o3, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = o0;
                        output[outputPos++] = o1;
                        output[outputPos++] = o2;
                        output[outputPos++] = o3;
                    }
                } else if (rx >= ry && rz >= rx) {
                    base1 = X1 + Y0 + Z1 + K0; base2 = X0 + Y0 + Z1 + K0; base3 = X1 + Y1 + Z1 + K0;
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o0 = c0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c0, rz) + 0x1000) >> 13);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o1 = c1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c1, rz) + 0x1000) >> 13);
                    a = CLUT[base1++]; b = CLUT[base2++];
                    o2 = c2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - c2, rz) + 0x1000) >> 13);
                    a = CLUT[base1];   b = CLUT[base2];
                    o3 = c3 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - c3, rz) + 0x1000) >> 13);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base3 += kOffset;
                        a = CLUT[base1++]; b = CLUT[base2++];
                        v = k0 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - k0, rz) + 0x1000) >> 13);
                        output[outputPos++] = o0 + ((Math.imul(v - o0, rk) + 0x1000) >> 13);
                        a = CLUT[base1++]; b = CLUT[base2++];
                        v = k1 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - k1, rz) + 0x1000) >> 13);
                        output[outputPos++] = o1 + ((Math.imul(v - o1, rk) + 0x1000) >> 13);
                        a = CLUT[base1++]; b = CLUT[base2++];
                        v = k2 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3++] - a, ry) + Math.imul(b - k2, rz) + 0x1000) >> 13);
                        output[outputPos++] = o2 + ((Math.imul(v - o2, rk) + 0x1000) >> 13);
                        a = CLUT[base1];   b = CLUT[base2];
                        v = k3 + ((Math.imul(a - b, rx) + Math.imul(CLUT[base3]   - a, ry) + Math.imul(b - k3, rz) + 0x1000) >> 13);
                        output[outputPos++] = o3 + ((Math.imul(v - o3, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = o0;
                        output[outputPos++] = o1;
                        output[outputPos++] = o2;
                        output[outputPos++] = o3;
                    }
                } else if (ry >= rx && rx >= rz) {
                    base1 = X1 + Y1 + Z0 + K0; base2 = X0 + Y1 + Z0 + K0; base4 = X1 + Y1 + Z1 + K0;
                    a = CLUT[base2++]; b = CLUT[base1++];
                    o0 = c0 + ((Math.imul(b - a, rx) + Math.imul(a - c0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base1++];
                    o1 = c1 + ((Math.imul(b - a, rx) + Math.imul(a - c1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base1++];
                    o2 = c2 + ((Math.imul(b - a, rx) + Math.imul(a - c2, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2];   b = CLUT[base1];
                    o3 = c3 + ((Math.imul(b - a, rx) + Math.imul(a - c3, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x1000) >> 13);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base4 += kOffset;
                        a = CLUT[base2++]; b = CLUT[base1++];
                        v = k0 + ((Math.imul(b - a, rx) + Math.imul(a - k0, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o0 + ((Math.imul(v - o0, rk) + 0x1000) >> 13);
                        a = CLUT[base2++]; b = CLUT[base1++];
                        v = k1 + ((Math.imul(b - a, rx) + Math.imul(a - k1, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o1 + ((Math.imul(v - o1, rk) + 0x1000) >> 13);
                        a = CLUT[base2++]; b = CLUT[base1++];
                        v = k2 + ((Math.imul(b - a, rx) + Math.imul(a - k2, ry) + Math.imul(CLUT[base4++] - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o2 + ((Math.imul(v - o2, rk) + 0x1000) >> 13);
                        a = CLUT[base2];   b = CLUT[base1];
                        v = k3 + ((Math.imul(b - a, rx) + Math.imul(a - k3, ry) + Math.imul(CLUT[base4]   - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o3 + ((Math.imul(v - o3, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = o0;
                        output[outputPos++] = o1;
                        output[outputPos++] = o2;
                        output[outputPos++] = o3;
                    }
                } else if (ry >= rz && rz >= rx) {
                    base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base3 = X0 + Y1 + Z0 + K0;
                    a = CLUT[base2++]; b = CLUT[base3++];
                    o0 = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c0, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base3++];
                    o1 = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c1, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base3++];
                    o2 = c2 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - c2, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    a = CLUT[base2];   b = CLUT[base3];
                    o3 = c3 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - c3, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base3 += kOffset;
                        a = CLUT[base2++]; b = CLUT[base3++];
                        v = k0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - k0, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o0 + ((Math.imul(v - o0, rk) + 0x1000) >> 13);
                        a = CLUT[base2++]; b = CLUT[base3++];
                        v = k1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - k1, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o1 + ((Math.imul(v - o1, rk) + 0x1000) >> 13);
                        a = CLUT[base2++]; b = CLUT[base3++];
                        v = k2 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(b - k2, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o2 + ((Math.imul(v - o2, rk) + 0x1000) >> 13);
                        a = CLUT[base2];   b = CLUT[base3];
                        v = k3 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(b - k3, ry) + Math.imul(a - b, rz) + 0x1000) >> 13);
                        output[outputPos++] = o3 + ((Math.imul(v - o3, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = o0;
                        output[outputPos++] = o1;
                        output[outputPos++] = o2;
                        output[outputPos++] = o3;
                    }
                } else if (rz >= ry && ry >= rx) {
                    base1 = X1 + Y1 + Z1 + K0; base2 = X0 + Y1 + Z1 + K0; base4 = X0 + Y0 + Z1 + K0;
                    a = CLUT[base2++]; b = CLUT[base4++];
                    o0 = c0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c0, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base4++];
                    o1 = c1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c1, rz) + 0x1000) >> 13);
                    a = CLUT[base2++]; b = CLUT[base4++];
                    o2 = c2 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c2, rz) + 0x1000) >> 13);
                    a = CLUT[base2];   b = CLUT[base4];
                    o3 = c3 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - c3, rz) + 0x1000) >> 13);
                    if (interpK) {
                        base1 += kOffset; base2 += kOffset; base4 += kOffset;
                        a = CLUT[base2++]; b = CLUT[base4++];
                        v = k0 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - k0, rz) + 0x1000) >> 13);
                        output[outputPos++] = o0 + ((Math.imul(v - o0, rk) + 0x1000) >> 13);
                        a = CLUT[base2++]; b = CLUT[base4++];
                        v = k1 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - k1, rz) + 0x1000) >> 13);
                        output[outputPos++] = o1 + ((Math.imul(v - o1, rk) + 0x1000) >> 13);
                        a = CLUT[base2++]; b = CLUT[base4++];
                        v = k2 + ((Math.imul(CLUT[base1++] - a, rx) + Math.imul(a - b, ry) + Math.imul(b - k2, rz) + 0x1000) >> 13);
                        output[outputPos++] = o2 + ((Math.imul(v - o2, rk) + 0x1000) >> 13);
                        a = CLUT[base2];   b = CLUT[base4];
                        v = k3 + ((Math.imul(CLUT[base1]   - a, rx) + Math.imul(a - b, ry) + Math.imul(b - k3, rz) + 0x1000) >> 13);
                        output[outputPos++] = o3 + ((Math.imul(v - o3, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = o0;
                        output[outputPos++] = o1;
                        output[outputPos++] = o2;
                        output[outputPos++] = o3;
                    }
                } else {
                    if (interpK) {
                        output[outputPos++] = c0 + ((Math.imul(k0 - c0, rk) + 0x1000) >> 13);
                        output[outputPos++] = c1 + ((Math.imul(k1 - c1, rk) + 0x1000) >> 13);
                        output[outputPos++] = c2 + ((Math.imul(k2 - c2, rk) + 0x1000) >> 13);
                        output[outputPos++] = c3 + ((Math.imul(k3 - c3, rk) + 0x1000) >> 13);
                    } else {
                        output[outputPos++] = c0;
                        output[outputPos++] = c1;
                        output[outputPos++] = c2;
                        output[outputPos++] = c3;
                    }
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
};
