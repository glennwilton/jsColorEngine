// src/kernels/1d/kernel1D_loops.js
//
// 1D (gray-input) LUT array loops — MOVED VERBATIM from src/Transform.js (v1.7 phase B,
// see docs/deepdive/KernelModules.md). Transform.js attaches these to
// Transform.prototype at load time (non-enumerable, matching class-method
// semantics), so `this` is the Transform instance and every call site —
// lutKernelTable run closures, kernel modules, tests — is unchanged.
//
// Do not add module-scope dependencies here: bodies may only use their
// arguments, locals, and `this.*`.
'use strict';

module.exports = {
        /**
         * HOT PATH. 1D LUT, 1-channel input → N-channel output.
         * Typical use: Gray → RGB, Gray → CMYK image conversion.
         *
         * TODO (B3): Currently delegates to linearInterp1D_NCh per pixel and
         * allocates a 1-element wrapper array + an output array per pixel. Should
         * be inlined like tetrahedralInterp3DArray_3Ch_loop. Affects throughput
         * on Gray→multichannel image conversions.
         *
         * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop for the
         * full set of contracts and trade-offs.
         */
        linearInterp1DArray_NCh_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var temp, o;
            var outputChannels = lut.outputChannels;
            for(var p = 0; p < length; p++) {
                temp = this.linearInterp1D_NCh([input[inputPos++]], lut)
                for(o = 0; o < outputChannels; o++) {
                    output[outputPos++] = temp[o];
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
