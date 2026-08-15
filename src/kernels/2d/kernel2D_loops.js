// src/kernels/2d/kernel2D_loops.js
//
// 2D (duotone-input) LUT array loops — MOVED VERBATIM from src/Transform.js (v1.7 phase B,
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
         * HOT PATH. 2D LUT, 2-channel input → N-channel output.
         * Typical use: Duotone → RGB / Duotone → CMYK image conversion.
         *
         * TODO (B3): NOT YET fully inlined for speed — currently delegates to
         * bilinearInterp2D_NCh per pixel and allocates an output array each
         * iteration. Should be inlined like tetrahedralInterp3DArray_3Ch_loop.
         *
         * See HOT PATH header above tetrahedralInterp3DArray_4Ch_loop for the
         * full set of contracts and trade-offs.
         */
        bilinearInterp2DArray_NCh_loop(input, inputPos, output, outputPos, length, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
            var colorIn, temp, o;
            var outputChannels = lut.outputChannels;
            colorIn = new Uint8ClampedArray(2);
            for(var p = 0; p < length; p++) {
                colorIn[0] = input[inputPos++];
                colorIn[1] = input[inputPos++];
                temp = this.bilinearInterp2D_NCh(colorIn, lut)
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
