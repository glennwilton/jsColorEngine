// src/kernels/1d/kernel1D_loops.js
//
// The gray (1-channel input) image loop.
//
// PURE FUNCTIONS OF THEIR ARGUMENTS. No `this`, no module-scope state.
// Callers reach them through the module (v1.6 phase 4b); the
// Transform.prototype attachment is kept for compatibility, not for binding.
// Do not add module-scope dependencies here.
'use strict';

module.exports = {
        /**
         * HOT PATH. 1D LUT, 1-channel input → N-channel output.
         * Typical use: Gray → RGB, Gray → CMYK image conversion.
         *
         * INLINED in v1.6 (this was TODO B3, open since the v1.5 kernel
         * migration). It used to call linearInterp1D_NCh once per pixel:
         *
         *     temp = this.linearInterp1D_NCh([input[inputPos++]], lut)
         *
         * which allocated a one-element wrapper array to pass the sample in,
         * and got a fresh `new Array(outputChannels)` back — roughly 2M
         * allocations per megapixel. It also meant one function served both the
         * single-colour pipeline path and the image path, which is the exact
         * shape that deoptimises the array path 2-3x (see the PERFORMANCE
         * LESSONS block in src/Transform.js). 3D and 4D never did this.
         *
         * The maths is identical to Kernel1D's floatFor() implementation and
         * must stay that way; what differs is that everything is hoisted, the
         * grid index is computed once per pixel rather than per call, and
         * output is written straight into the destination array.
         *
         * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop for the
         * full set of contracts and trade-offs.
         */
        linearInterp1DArray_NCh_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var outputScale = lut.outputScale;
            var outputChannels = lut.outputChannels;
            var gridEnd = lut.g1 - 1;
            var gridPointsScale = gridEnd * lut.inputScale;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;

            var px, rx, X0, X1, c0, c1, o;

            for(var p = 0; p < length; p++) {
                // Scale FIRST, then clamp in grid space — the LUT may be baked
                // (inputScale = 1/255) or an ICC LUT in device 0..1.
                px = input[inputPos++] * gridPointsScale;
                if(px < 0){ px = 0; } else if(px > gridEnd){ px = gridEnd; }

                X0 = ~~px;
                rx = px - X0;
                if(X0 === gridEnd){
                    X1 = X0 *= go0;
                } else {
                    X0 *= go0;
                    X1 = X0 + go0;
                }

                for(o = 0; o < outputChannels; o++) {
                    c0 = CLUT[X0++];
                    c1 = CLUT[X1++];
                    output[outputPos++] = (c0 + ((c1 - c0) * rx)) * outputScale;
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
