// src/kernels/2d/kernel2D_loops.js
//
// The duotone (2-channel input) image loop. Attached to Transform.prototype at
// load time (see _attachPrototypeLoops at the bottom of Transform.js), so
// `this` is the Transform instance and every call site is unchanged.
//
// Do not add module-scope dependencies here: bodies may only use their
// arguments and locals.
'use strict';

module.exports = {
        /**
         * HOT PATH. 2D LUT, 2-channel input → N-channel output.
         * Typical use: Duotone → RGB / Duotone → CMYK image conversion.
         *
         * INLINED in v1.6 (this was TODO B3, open since the v1.5 kernel
         * migration). It used to call bilinearInterp2D_NCh once per pixel,
         * getting a fresh `new Array(outputChannels)` back each time, and it
         * meant one function served both the single-colour pipeline path and
         * the image path — the exact shape that deoptimises the array path
         * 2-3x (see the PERFORMANCE LESSONS block in src/Transform.js). 3D and
         * 4D never did this.
         *
         * The maths is identical to Kernel2D's floatFor() implementation and
         * must stay that way; what differs is that the LUT fields are hoisted
         * out of the loop and output is written straight to the destination.
         *
         * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop for the
         * full set of contracts and trade-offs.
         */
        bilinearInterp2DArray_NCh_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var outputScale = lut.outputScale;
            var outputChannels = lut.outputChannels;
            var gridEnd = lut.g1 - 1;
            var gridPointsScale = gridEnd * lut.inputScale;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;

            var px, py, rx, ry, X0, X1, Y0, Y1;
            var base0, base1, base2, base3, c0, c1, c2, c3, c02, o;

            for(var p = 0; p < length; p++) {
                // Scale FIRST, then clamp in grid space — the LUT may be baked
                // (inputScale = 1/255) or an ICC LUT in device 0..1.
                px = input[inputPos++] * gridPointsScale;
                if(px < 0){ px = 0; } else if(px > gridEnd){ px = gridEnd; }
                py = input[inputPos++] * gridPointsScale;
                if(py < 0){ py = 0; } else if(py > gridEnd){ py = gridEnd; }

                X0 = ~~px;
                rx = px - X0;
                if(X0 === gridEnd){
                    X1 = X0 *= go1;
                } else {
                    X0 *= go1;
                    X1 = X0 + go1;
                }

                Y0 = ~~py;
                ry = py - Y0;
                if(Y0 === gridEnd){
                    Y1 = Y0 *= go0;
                } else {
                    Y0 *= go0;
                    Y1 = Y0 + go0;
                }

                base0 = X0 + Y0;
                base1 = X0 + Y1;
                base2 = X1 + Y0;
                base3 = X1 + Y1;
                for(o = 0; o < outputChannels; o++) {
                    c0 = CLUT[base0++];
                    c1 = CLUT[base1++];
                    c2 = CLUT[base2++];
                    c3 = CLUT[base3++];
                    c02 = (c0 + ((c2 - c0) * rx));
                    output[outputPos++] = (c02 + (((c1 + ((c3 - c1) * rx)) - c02) * ry)) * outputScale;
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
};
