/*************************************************************************
 *  @license
 *
 *  Copyright © 2019, 2026 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
*/

    'use strict';

    /**
     * ACCURACY PATH single-colour interpolators — the built-in float library.
     *
     * ONE COLOUR AT A TIME. Everything in this file converts a single colour and
     * returns a new array. **For images, look in `src/kernels/` instead** — each
     * kernel carries its own array loop, tuned for its dimension and its output
     * channel count, writing straight into the destination buffer:
     *
     *     1 -> N   src/kernels/1d/kernel1D_loops.js
     *     2 -> N   src/kernels/2d/kernel2D_loops.js
     *     3 -> 3, 4, N + WASM variants   src/kernels/3d/kernel3D_loops.js
     *     4 -> 3, 4, N + WASM variants   src/kernels/4d/kernel4D_loops.js
     *
     * The two families are the same maths written twice, deliberately, and must
     * stay that way: one function serving both a per-colour caller and a
     * million-iteration loop gets deoptimised by V8 and the array path loses
     * 2-3x. `__tests__/interp_reference.tests.js` holds them to agreeing
     * bit-for-bit, which is what makes the duplication safe rather than a
     * liability.
     *
     * So this file is the readable, correctness-first statement of what each
     * conversion means. It is the reference the loops were derived from, the
     * code the accuracy path actually runs, and the place to fix a definition
     * -- but it is not where image throughput lives.
     *
     * These are the per-colour stage LUT evaluators used by transform(), the
     * per-pixel path of transformArray(), and the LUT bake (createLut) — NOT
     * the image *_loop kernels, which live in src/kernels/.
     *
     * WHO CHOOSES BETWEEN THEM. Since v1.6 phase 3, nothing in this file and
     * nothing in Transform.js does. Each kernel requires this module and
     * returns the variant it wants from `floatFor(lut, hints)`:
     * Kernel3D owns the tetrahedral/trilinear decision and the PCS-input rule,
     * Kernel4D owns its own, KernelND has one implementation. Transform asks
     * the registry and installs whatever it gets. This file is the built-in
     * IMPLEMENTATIONS; the kernels are the policy. A third-party kernel can
     * ignore this file entirely.
     *
     * The 1-D and 2-D interpolators are NOT here — they moved to
     * src/kernels/1d/ and 2d/ in phase 2, because those kernels have exactly
     * one implementation each and nothing was left to share.
     *
     * STILL ATTACHED TO Transform.prototype (non-enumerable, at the bottom of
     * Transform.js) and that is load-bearing, not vestigial: the 4-D reference
     * variants evaluate two 3-D interpolations at the bracketing K planes and
     * reach their siblings through `this` —
     *
     *     var output1 = this.tetrahedralInterp3D_Master(cmyInput, lut, K0);
     *
     * Stage functions are invoked as `stage.funct.call(transform, ...)`, so
     * that `this` is the Transform and the sibling resolves off the prototype.
     * Calling `interp.tetrahedralInterp4D_3or4Ch(...)` as a bare function would
     * throw. Anything that changes how stages are invoked has to keep a
     * receiver carrying these methods, or the 4-D reference path breaks.
     *
     * Do NOT "clean up" or restructure these bodies — see the PERFORMANCE
     * LESSONS block in src/Transform.js and the section header below. The
     * class wrapper exists only so the methods stay byte-for-byte identical
     * to their original class-body syntax.
     */
    class _TransformInterp {
    /* ========================================================================
     *  ACCURACY PATH — single-colour interpolators
     * ========================================================================
     *
     *  The functions in this section (trilinearInterp3D_*, trilinearInterp4D_*,
     *  tetrahedralInterp3D_*, tetrahedralInterp4D_*, linearInterp1D_NCh,
     *  bilinearInterp2D_NCh) convert ONE colour at a time. They are the stages
     *  that get pushed onto this.pipeline by addStageLUT() and are called by
     *  transform() / the per-pixel path of transformArray().
     *
     *  Design priorities here are different from the *_loop variants:
     *
     *   - ACCURACY first. Allocations (`new Array(outputChannels)`,
     *     intermediate result objects) are acceptable.
     *   - CORRECTNESS over micro-optimisation. Edge-case clamping, NaN safety,
     *     and clean fallback behaviour matter more than ns-per-call.
     *   - DIAGNOSABILITY. These functions feed pipelineDebug / pipelineHistory
     *     when enabled, so deterministic intermediate values are useful.
     *
     *  When to use which:
     *
     *      INPUT      OUTPUT     FUNCTION                       NOTES
     *      ──────     ──────     ─────────────────────────      ─────────────
     *      1 ch       N ch       linearInterp1D_NCh             Gray
     *      2 ch       N ch       bilinearInterp2D_NCh           Duotone
     *      3 ch       3 ch       tetrahedralInterp3D_3Ch        RGB→RGB / Lab
     *      3 ch       4 ch       tetrahedralInterp3D_4Ch        RGB→CMYK
     *      3 ch       N ch       tetrahedralInterp3D_NCh        RGB→n-color
     *      4 ch       3 ch       tetrahedralInterp4D_3Ch        CMYK→RGB / Lab
     *      4 ch       4 ch       tetrahedralInterp4D_4Ch        CMYK→CMYK
     *      4 ch       N ch       tetrahedralInterp4D_NCh        CMYK→n-color
     *
     *  Trilinear vs tetrahedral
     *  ----------------------------------------------------------------------
     *
     *   For DEVICE LUTs (white at one cube corner, black at the opposite,
     *   colour ramps along the diagonals) tetrahedral is BOTH faster AND more
     *   accurate. Stay on tetrahedral.
     *
     *   For PCS-INPUT LUTs (Lab/XYZ — luma on one axis, a/b on the other two,
     *   data NOT diagonally encoded) tetrahedral subtly mis-samples and
     *   trilinear is more accurate. Matches LittleCMS, SampleICC, Photoshop
     *   behaviour. addStageLUT() switches automatically based on inputEncoding.
     *
     *  Reference vs optimised variants
     *  ----------------------------------------------------------------------
     *
     *   *_3or4Ch / _Master are the easy-to-read "reference" implementations
     *   used when interpolationFast === false (diagnostic / accuracy testing).
     *   The _3Ch / _4Ch / _NCh variants are the fast versions used in
     *   production. They should produce numerically identical results to the
     *   reference variants — the LCMS test suite verifies this.
     *
     *  Channel-dispatched fast variants
     *  ----------------------------------------------------------------------
     *
     *   _3Ch and _4Ch are unrolled per-output-channel. _NCh handles 5+ output
     *   channels with a generic loop. Most real-world workloads hit _3Ch or
     *   _4Ch.
     *
     *  Known issues / TODOs in this section
     *  ----------------------------------------------------------------------
     *
     *   B1.  trilinearInterp3D_3or4Ch upper-edge clamp uses raw input[N] >= 1.0
     *        rather than (X0 === gridPoints-1). Can produce out-of-bounds CLUT
     *        reads when lut.inputScale != 1.0. Other interpolators use the
     *        safer X0-vs-gridEnd test.
     *
     *   B4.  tetrahedralInterp3D_Master and tetrahedralInterp3D_3or4Ch fall
     *        through to `c1 = c2 = c3 = [0,0,0,0]` when none of the 6 octant
     *        comparisons match (only possible with NaN inputs). The single
     *        shared array is aliased to all three slots. The _NCh / _3Ch /
     *        _4Ch variants correctly fall through to a c0-only output.
     *
     *   B5.  Octant predicate ordering varies cosmetically between variants
     *        (e.g. `else if (rx >= ry && rz >= rx)` in _NCh vs
     *        `else if (rz >= rx && rx >= ry)` in _3or4Ch — algebraically
     *        identical, visually distracting on side-by-side review).
     *
     *   P3.  Math.floor(px) vs ~~px is inconsistent across variants.
     *        Standardise when next touching this code; ~~ is faster and
     *        produces an SMI for px in [0, 2^31).
     * ========================================================================
     */

    /**
     * 3D trilinear, n-channel output. Accuracy path. See ACCURACY PATH header
     * above for design priorities.
     *
     * Used (in preference to tetrahedral) when the source is a PCS LUT with
     * vertically-encoded luma, where tetrahedral can mis-sample. addStageLUT()
     * routes here automatically for PCSv2 / PCSv4 input.
     *
     * @param {number[]}  input  Device-space input, channels in 0..1.
     * @param {object}    lut    The stage's CLUT object (CLUT, gridPoints,
     *                           inputScale, outputScale, go0..go2, etc.).
     * @returns {number[]}       New array of length lut.outputChannels.
     */
    // Compiled-pipeline POC: 3D trilinear interpolation (PCSv2 in → device out).
    // In: pcsL, pcsa, pcsb (3 channels)
    // Out: d0..d{outputChannels-1}
    // CLUT goes on the store; grid strides / scales / outputScale baked as
    // numeric literals. Whole 4-channel evaluation is unrolled — no inner loop.
    attachStore_js_trilinearInterp3D(store, idx, stage){
        store['s' + idx + '_clut'] = stage.stageData.CLUT;
    }

    emit_js_trilinearInterp3D(index, stage){
        var lut             = stage.stageData;
        var outCh           = lut.outputChannels;
        var gridEnd         = lut.g1 - 1;
        var inputScale      = lut.inputScale;
        var gridPointsScale = gridEnd * inputScale;
        var outputScale     = lut.outputScale;
        var go0             = lut.go0;
        var go1             = lut.go1;
        var go2             = lut.go2;
        var clutKey         = 's' + index + '_clut';

        var DEVICE_VARS = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
        var dVars = DEVICE_VARS.slice(0, outCh);

        var lines = [];
        lines.push('{');
        lines.push('  const _CLUT = store.' + clutKey + ';');
        // Clamp PCS inputs to 0..1.
        lines.push('  let _i0 = pcsL < 0 ? 0 : (pcsL > 1 ? 1 : pcsL);');
        lines.push('  let _i1 = pcsa < 0 ? 0 : (pcsa > 1 ? 1 : pcsa);');
        lines.push('  let _i2 = pcsb < 0 ? 0 : (pcsb > 1 ? 1 : pcsb);');
        // Scale into grid space.
        lines.push('  let _px = _i0 * ' + gridPointsScale + ';');
        lines.push('  let _py = _i1 * ' + gridPointsScale + ';');
        lines.push('  let _pz = _i2 * ' + gridPointsScale + ';');
        lines.push('  let _X0 = ~~_px, _rx = _px - _X0;');
        lines.push('  let _Y0 = ~~_py, _ry = _py - _Y0;');
        lines.push('  let _Z0 = ~~_pz, _rz = _pz - _Z0;');
        lines.push('  let _X1, _Y1, _Z1;');
        // Upper-edge clamp (matches runtime _NCh kernel).
        lines.push('  if (_X0 === ' + gridEnd + ') { _X1 = _X0 *= ' + go2 + '; } else { _X0 *= ' + go2 + '; _X1 = _X0 + ' + go2 + '; }');
        lines.push('  if (_Y0 === ' + gridEnd + ') { _Y1 = _Y0 *= ' + go1 + '; } else { _Y0 *= ' + go1 + '; _Y1 = _Y0 + ' + go1 + '; }');
        lines.push('  if (_Z0 === ' + gridEnd + ') { _Z1 = _Z0 *= ' + go0 + '; } else { _Z0 *= ' + go0 + '; _Z1 = _Z0 + ' + go0 + '; }');
        // Per-output-channel trilinear lerp. Channel `c` lives at base+c
        // (because the runtime CLUT is interleaved [X][Y][Z][ch] with
        // the inner-channel stride = 1).
        for (var c = 0; c < outCh; c++) {
            var dv = dVars[c];
            lines.push('  {');
            lines.push('    let _d000 = _CLUT[_X0 + _Y0 + _Z0 + ' + c + '];');
            lines.push('    let _d001 = _CLUT[_X0 + _Y0 + _Z1 + ' + c + '];');
            lines.push('    let _d010 = _CLUT[_X0 + _Y1 + _Z0 + ' + c + '];');
            lines.push('    let _d011 = _CLUT[_X0 + _Y1 + _Z1 + ' + c + '];');
            lines.push('    let _d100 = _CLUT[_X1 + _Y0 + _Z0 + ' + c + '];');
            lines.push('    let _d101 = _CLUT[_X1 + _Y0 + _Z1 + ' + c + '];');
            lines.push('    let _d110 = _CLUT[_X1 + _Y1 + _Z0 + ' + c + '];');
            lines.push('    let _d111 = _CLUT[_X1 + _Y1 + _Z1 + ' + c + '];');
            lines.push('    let _dx00 = _d000 + _rx * (_d100 - _d000);');
            lines.push('    let _dx01 = _d001 + _rx * (_d101 - _d001);');
            lines.push('    let _dx10 = _d010 + _rx * (_d110 - _d010);');
            lines.push('    let _dx11 = _d011 + _rx * (_d111 - _d011);');
            lines.push('    let _dxy0 = _dx00 + _ry * (_dx10 - _dx00);');
            lines.push('    let _dxy1 = _dx01 + _ry * (_dx11 - _dx01);');
            lines.push('    ' + dv + ' = (_dxy0 + _rz * (_dxy1 - _dxy0)) * ' + outputScale + ';');
            lines.push('  }');
        }
        lines.push('}');
        return lines.join('\n');
    }

    trilinearInterp3D_NCh(input, lut){
        var rx,ry,rz;
        var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2;
        var d000, d001, d010, d011, d100, d101, d110, d111;
        var dx00, dx01, dx10, dx11, dxy0, dxy1;

        var outputScale = lut.outputScale;
        var outputChannels = lut.outputChannels;
        var gridEnd = (lut.g1 - 1);
        var gridPointsScale = gridEnd * lut.inputScale;
        var CLUT = lut.CLUT;
        var go0 = lut.go0;
        var go1 = lut.go1;
        var go2 = lut.go2;

        input0 = Math.min(Math.max(input[0], 0), 1);
        input1 = Math.min(Math.max(input[1], 0), 1);
        input2 = Math.min(Math.max(input[2], 0), 1);

        // only px needs to be a float
        px = input0 * gridPointsScale;
        py = input1 * gridPointsScale;
        pz = input2 * gridPointsScale;

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

        var output = new Array(outputChannels);

        for(var c = 0; c < outputChannels; c++){
            d000 = CLUT[X0 + Y0 + Z0];
            d001 = CLUT[X0 + Y0 + Z1];
            d010 = CLUT[X0 + Y1 + Z0];
            d011 = CLUT[X0 + Y1 + Z1];

            d100 = CLUT[X1 + Y0 + Z0];
            d101 = CLUT[X1 + Y0 + Z1];
            d110 = CLUT[X1 + Y1 + Z0];
            d111 = CLUT[X1 + Y1 + Z1];

            dx00 = d000 + ( rx * ( d100 - d000 ));
            dx01 = d001 + ( rx * ( d101 - d001 ));
            dx10 = d010 + ( rx * ( d110 - d010 ));
            dx11 = d011 + ( rx * ( d111 - d011 ));

            dxy0 = dx00 + ( ry * ( dx10 - dx00 ));
            dxy1 = dx01 + ( ry * ( dx11 - dx01 ));
            output[c] = (dxy0 + ( rz * ( dxy1 - dxy0 )))  * outputScale;

            // To go to the next channel we only need to increment the index by 1
            // so rather than go CLUT(X0 + Y0 + Z0 + c) we just increment the X indexes
            X0++;
            X1++;
        }
        return output;
    };


        /**
         * 3D trilinear, 3- or 4-channel output. REFERENCE/diagnostic variant —
         * the per-channel-count fast paths are normally used instead. Only
         * reached when interpolationFast === false.
         *
         * Also called internally by trilinearInterp4D_3or4Ch as the inner pass
         * for K-axis interpolation (with K0 as the 4th-axis offset).
         *
         * TODO (B1): Upper-edge clamp at the X1/Y1/Z1 assignment uses the raw
         * input[N] >= 1.0 test instead of (X0 === gridPoints-1). When
         * lut.inputScale != 1.0, an input value below 1.0 can still land X0 on
         * gridPoints-1, after which X1 = X0 + 1 reads past the end of the CLUT.
         * Switch to the X0-vs-gridEnd test used in the other interpolators.
         *
         * @param {number[]} input  3 or 4 channels in 0..1.
         * @param {object}   lut
         * @param {number}  [K0=0] 4D-axis CLUT offset when called from the 4D
         *                         outer wrapper.
         * @returns {number[]}     New array of length 3 or 4.
         */
        trilinearInterp3D_3or4Ch(input, lut, K0){
            K0 = (K0 === undefined) ? 0 : K0;
            var inputChannels = lut.inputChannels;
            var outputChannels = lut.outputChannels;
            var gridPoints = lut.gridPoints[0];
            var CLUT = lut.CLUT;

            var g1 = gridPoints;
            var g2 = gridPoints * g1; // g^2
            var g3 = gridPoints * g2; // g^3

            var X0, Y0, Z0, X1, Y1, Z1;
            var fx, fy, fz,
                d000, d001, d010, d011,
                d100, d101, d110, d111,
                dx00, dx01, dx10, dx11,
                dxy0, dxy1, dxyz;

            var px = input[0] * lut.inputScale;
            var py = input[1] * lut.inputScale;
            var pz = input[2] * lut.inputScale;

            px = Math.min(Math.max(px, 0.0), 1.0);
            py = Math.min(Math.max(py, 0.0), 1.0);
            pz = Math.min(Math.max(pz, 0.0), 1.0);

            px = px * (gridPoints - 1);
            py = py * (gridPoints - 1);
            pz = pz * (gridPoints - 1);

            X0 = Math.floor(px); fx = px - X0;
            Y0 = Math.floor(py); fy = py - Y0;
            Z0 = Math.floor(pz); fz = pz - Z0;

            // TODO (B1): unsafe upper-edge clamp. Tests the raw input ( >= 1.0 )
            // rather than the scaled grid index, so when lut.inputScale != 1.0 it
            // can leave X1/Y1/Z1 at gridPoints, then the lookup() reads past the
            // end of the CLUT (garbage colours, possibly NaN). Other interpolators
            // use the type-independent (X0 === gridPoints - 1) test — switch to
            // that here too. Low impact in practice because most LUTs have
            // inputScale === 1.0, but worth fixing.
            X1 = X0 + ( input[0] >= 1.0 ? 0.0 : 1.0);
            Y1 = Y0 + ( input[1] >= 1.0 ? 0.0 : 1.0);
            Z1 = Z0 + ( input[2] >= 1.0 ? 0.0 : 1.0);

            //lookup
            d000 = lookup(X0, Y0, Z0, K0,  CLUT, inputChannels, outputChannels);
            d001 = lookup(X0, Y0, Z1, K0,  CLUT, inputChannels, outputChannels);
            d010 = lookup(X0, Y1, Z0, K0,  CLUT, inputChannels, outputChannels);
            d011 = lookup(X0, Y1, Z1, K0,  CLUT, inputChannels, outputChannels);

            d100 = lookup(X1, Y0, Z0, K0,  CLUT, inputChannels, outputChannels);
            d101 = lookup(X1, Y0, Z1, K0,  CLUT, inputChannels, outputChannels);
            d110 = lookup(X1, Y1, Z0, K0,  CLUT, inputChannels, outputChannels);
            d111 = lookup(X1, Y1, Z1, K0,  CLUT, inputChannels, outputChannels);


            dx00 = LERP(fx, d000, d100);
            dx01 = LERP(fx, d001, d101);
            dx10 = LERP(fx, d010, d110);
            dx11 = LERP(fx, d011, d111);

            dxy0 = LERP(fy, dx00, dx10);
            dxy1 = LERP(fy, dx01, dx11);

            dxyz = LERP(fz, dxy0, dxy1);

            if(outputChannels === 3){
                return [
                    dxyz[0] *= lut.outputScale,
                    dxyz[1] *= lut.outputScale,
                    dxyz[2] *= lut.outputScale
                ]
            }

            return [
                dxyz[0] *= lut.outputScale,
                dxyz[1] *= lut.outputScale,
                dxyz[2] *= lut.outputScale,
                dxyz[3] *= lut.outputScale
            ];

            function LERP(frac,low,high){
                if(outputChannels === 3){
                    return [
                        low[0] + ( frac * ( high[0]-low[0] )),
                        low[1] + ( frac * ( high[1]-low[1] )),
                        low[2] + ( frac * ( high[2]-low[2] ))
                    ];
                }

                return [
                    low[0] + ( frac * ( high[0]-low[0] )),
                    low[1] + ( frac * ( high[1]-low[1] )),
                    low[2] + ( frac * ( high[2]-low[2] )),
                    low[3] + ( frac * ( high[3]-low[3] ))
                ];
            }

            function lookup(x, y, z, k, CLUT, inputChannels, outputChannels){

                var base;
                if(inputChannels === 3) {
                    base = ((x * g2) + (y * g1) + z) * outputChannels;
                } else {
                    base = ((k * g3) + (x * g2) + (y * g1) + z) * outputChannels;
                }

                if(outputChannels === 3){
                    return [CLUT[base], CLUT[base+1], CLUT[base+2]];
                }
                return [CLUT[base], CLUT[base+1], CLUT[base+2], CLUT[base+3]];
            }
        };

        /**
         * 4D trilinear, 3- or 4-channel output. REFERENCE/diagnostic variant —
         * the per-channel-count fast paths are normally used instead. Only
         * reached when interpolationFast === false.
         *
         * Implemented as two trilinear 3D passes (one at K0, one at K1) followed
         * by a linear interpolation along the K axis between the two results.
         * Includes an early-out when rk === 0 (we landed exactly on a K grid
         * line) to skip the second 3D pass.
         *
         * @param {number[]} input  4 channels in 0..1 (treats input[0] as K).
         * @param {object}   lut
         * @returns {number[]}      New array of length 3 or 4.
         */
        trilinearInterp4D_3or4Ch(input, lut){
            var K0,K1, inputK, pk, rk;
            inputK = pk = Math.max(0.0, Math.min(1.0, input[0] * lut.inputScale));

            pk = pk * (lut.g1 - 1);
            K0 = Math.floor(pk);
            rk = pk - K0;
            K1 = (inputK >= 1.0) ? K0 : K0 + 1;

            var cmyInput = [input[1], input[2], input[3]];

            // Note that K0 and K1 are the offsets into the lut for the 4D case
            var Output1 = this.trilinearInterp3D_3or4Ch(cmyInput, lut, K0 );
            if(rk === 0 ){
                return Output1;
            } // edge case

            var Output2 = this.trilinearInterp3D_3or4Ch(cmyInput, lut, K1);

            // interpolate two results
            // Note that trilinearInterp3D already applies the output scale
            if(lut.outputChannels === 3){
                return [
                    Output1[0] + ( Output2[0] - Output1[0] ) * rk,
                    Output1[1] + ( Output2[1] - Output1[1] ) * rk,
                    Output1[2] + ( Output2[2] - Output1[2] ) * rk,
                ]
            }

            Output1[0] = Output1[0] + ( Output2[0] - Output1[0] ) * rk;
            Output1[1] = Output1[1] + ( Output2[1] - Output1[1] ) * rk;
            Output1[2] = Output1[2] + ( Output2[2] - Output1[2] ) * rk;
            Output1[3] = Output1[3] + ( Output2[3] - Output1[3] ) * rk;
            return Output1;
        };

        /**
         * tetrahedralInterp3D_Master — REFERENCE implementation.
         *
         * The original, easy-to-read version of the 3D tetrahedral interpolator,
         * with the lookup() / sub16() helpers as separate functions. Kept for
         * clarity and as the reference against which the optimised variants are
         * tested. NOT used in production by default — the optimised
         * tetrahedralInterp3D_3or4Ch (~70% faster) is the actual diagnostic
         * fallback when interpolationFast === false.
         *
         * TODO (B4): The final `else { c1 = c2 = c3 = [0,0,0,0]; }` aliases the
         * single literal across all three slots — no callers mutate them, but it
         * is a pre-existing footgun. The optimised _NCh / _3Ch / _4Ch variants
         * correctly fall through to a c0-only output instead.
         *
         * @param {number[]} input
         * @param {object}   lut
         * @param {number}  [K0=0]
         * @returns {number[]}
         */
        tetrahedralInterp3D_Master(input, lut, K0){

            var inputChannels = lut.inputChannels;
            var outputChannels = lut.outputChannels;
            var gridPoints = lut.gridPoints[0];
            var CLUT = lut.CLUT;
            var rx,ry,rz;

            var g1 = gridPoints;
            var g2 = gridPoints*g1; // g^2
            var g3 = gridPoints*g2; // g^3

            var output;
            if(lut.outputChannels === 3){
                output = [0.0,0.0,0.0];
            } else {
                output = [0.0,0.0,0.0,0.0];
            }
            var c0, c1, c2, c3;
            var X0,X1,Y0,Y1,Z0,Z1, px,py,pz, input0, input1, input2
            input0 = px = input[0] * lut.inputScale;
            input1 = py = input[1] * lut.inputScale;
            input2 = pz = input[2] * lut.inputScale;

            px = Math.min(Math.max(px, 0.0), 1.0);
            py = Math.min(Math.max(py, 0.0), 1.0);
            pz = Math.min(Math.max(pz, 0.0), 1.0);

            px = px * (gridPoints-1);
            py = py * (gridPoints-1);
            pz = pz * (gridPoints-1);

            X0 = Math.floor(px);
            rx = (px - X0);
            X1 = X0 + ( input0 >= 1.0 ? 0.0 : 1.0 );

            Y0 = Math.floor(py);
            ry = (py - Y0);
            Y1 = Y0 + ( input1 >= 1.0 ? 0.0 : 1.0 );

            Z0 = Math.floor(pz);
            rz = (pz - Z0);
            Z1 = Z0 + ( input2 >= 1.0 ? 0.0 : 1.0 );

            c0 = lookup(X0, Y0, Z0, K0);

            //console.log('X0='+X0+' Y0='+Y0+' Z0='+Z0+' K0='+K0);
            //console.log(c0);
            if (rx >= ry && ry >= rz) {
                //1
                c1 = sub16( lookup(X1, Y0, Z0, K0) , c0);
                c2 = sub16( lookup(X1, Y1, Z0, K0) , lookup(X1, Y0, Z0, K0));
                c3 = sub16( lookup(X1, Y1, Z1, K0) , lookup(X1, Y1, Z0, K0));
            } else if (rx >= rz && rz >= ry) {
                //2
                c1 = sub16( lookup(X1, Y0, Z0, K0) , c0);
                c2 = sub16( lookup(X1, Y1, Z1, K0) , lookup(X1, Y0, Z1, K0));
                c3 = sub16( lookup(X1, Y0, Z1, K0) , lookup(X1, Y0, Z0, K0));
            } else if (rz >= rx && rx >= ry) {
                //3
                c1 = sub16( lookup(X1, Y0, Z1, K0) , lookup(X0, Y0, Z1, K0));
                c2 = sub16( lookup(X1, Y1, Z1, K0) , lookup(X1, Y0, Z1, K0));
                c3 = sub16( lookup(X0, Y0, Z1, K0) , c0);
            }  else if (ry >= rx && rx >= rz) {
                //4
                c1 = sub16( lookup(X1, Y1, Z0, K0) , lookup(X0, Y1, Z0, K0));
                c2 = sub16( lookup(X0, Y1, Z0, K0) , c0);
                c3 = sub16( lookup(X1, Y1, Z1, K0) , lookup(X1, Y1, Z0, K0));
            } else if (ry >= rz && rz >= rx) {
                //5
                c1 = sub16( lookup(X1, Y1, Z1, K0) , lookup(X0, Y1, Z1, K0));
                c2 = sub16( lookup(X0, Y1, Z0, K0) , c0);
                c3 = sub16( lookup(X0, Y1, Z1, K0) , lookup(X0, Y1, Z0, K0));
            }  else if (rz >= ry && ry >= rx) {
                //6
                c1 = sub16( lookup(X1, Y1, Z1, K0) , lookup(X0, Y1, Z1, K0));
                c2 = sub16( lookup(X0, Y1, Z1, K0) , lookup(X0, Y0, Z1, K0));
                c3 = sub16( lookup(X0, Y0, Z1, K0) , c0);
            } else {
                // TODO (B4): Only reachable with NaN inputs (none of the >= chains
                // hold). Aliasing one literal across c1/c2/c3 is fine because no
                // caller mutates them, but the optimised _NCh / _3Ch / _4Ch
                // variants intentionally fall through to a c0-only output instead
                // of a c0 + (zero * r) sum. Make consistent across all variants.
                c1 = c2 = c3 = [0,0,0,0];
            }

            output[0] = (  c0[0] + (c1[0] * rx) + (c2[0] * ry) + (c3[0] * rz)  ) * lut.outputScale;
            output[1] = (  c0[1] + (c1[1] * rx) + (c2[1] * ry) + (c3[1] * rz)  ) * lut.outputScale;
            output[2] = (  c0[2] + (c1[2] * rx) + (c2[2] * ry) + (c3[2] * rz)  ) * lut.outputScale;
            if(lut.outputChannels === 3){
                return output;
            }
            output[3] = (  c0[3] + (c1[3] * rx) + (c2[3] * ry) + (c3[3] * rz)  ) * lut.outputScale;
            return output;

            function lookup(x, y, z, k){
                var base;
                if(inputChannels === 3){
                    base =            ((x * g2) + (y*g1) + z)* outputChannels;
                } else {
                    base =((k * g3) + (x * g2) + (y*g1) + z) * outputChannels;
                }

                if(lut.outputChannels === 3){
                    return [CLUT[base], CLUT[base+1],CLUT[base+2]];
                }
                return [CLUT[base], CLUT[base+1],CLUT[base+2], CLUT[base+3]];
            }

            function sub16(a,b){
                var r =[];
                r[0] = a[0] - b[0];
                r[1] = a[1] - b[1];
                r[2] = a[2] - b[2];
                if(lut.outputChannels === 3){
                    return r;
                }
                r[3] = a[3] - b[3];
                return r;
            }
        };

        /**
         * Optimised reference variant of tetrahedralInterp3D — the lookup() and
         * sub16() helpers are inlined as closures sharing CLUT/g1/g2/g3 with
         * the outer scope, giving ~70% over the _Master form. Used as the
         * fallback when interpolationFast === false (diagnostic path).
         *
         * Production code routes to tetrahedralInterp3D_3Ch / _4Ch / _NCh
         * instead, which avoid the closure helpers entirely.
         *
         * TODO (B4): Same fall-through aliasing as the _Master variant — see
         * its JSDoc.
         *
         * @param {number[]} input
         * @param {object}   lut
         * @param {number}  [K0=0]
         * @returns {number[]}
         */
        tetrahedralInterp3D_3or4Ch(input, lut, K0){
            var rx,ry,rz;
            var inputScale = lut.inputScale;
            var outputScale = lut.outputScale;
            var inputChannels = lut.inputChannels;
            var outputChannels = lut.outputChannels;
            var gridPointsMinus1 = lut.g1 - 1;
            var CLUT = lut.CLUT;
            var g1 = lut.g1;
            var g2 = lut.g2;
            var g3 = lut.g3;

            var c0, c1, c2, c3;
            var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2
            input0 = px = input[0] * inputScale;
            input1 = py = input[1] * inputScale;
            input2 = pz = input[2] * inputScale;

            px = Math.min(Math.max(px, 0.0), 1.0);
            py = Math.min(Math.max(py, 0.0), 1.0);
            pz = Math.min(Math.max(pz, 0.0), 1.0);

            px = px * gridPointsMinus1;
            py = py * gridPointsMinus1;
            pz = pz * gridPointsMinus1;

            X0 = Math.floor(px);
            rx = (px - X0);
            X1 = X0 + ( input0 >= 1.0 ? 0.0 : 1.0 );

            Y0 = Math.floor(py);
            ry = (py - Y0);
            Y1 = Y0 + ( input1 >= 1.0 ? 0.0 : 1.0 );

            Z0 = Math.floor(pz);
            rz = (pz - Z0);
            Z1 = Z0 + ( input2 >= 1.0 ? 0.0 : 1.0 );

            c0 = lookup(X0, Y0, Z0, K0);

            if (rx >= ry && ry >= rz) {
                c1 =  sub16lookup(X1, Y0, Z0, K0, c0);
                c2 = sub16Lookup2(X1, Y1, Z0, K0, X1, Y0, Z0, K0);
                c3 = sub16Lookup2(X1, Y1, Z1, K0, X1, Y1, Z0, K0);

            } else if (rx >= rz && rz >= ry) {
                c1 =  sub16lookup(X1, Y0, Z0, K0, c0);
                c2 = sub16Lookup2(X1, Y1, Z1, K0, X1, Y0, Z1, K0);
                c3 = sub16Lookup2(X1, Y0, Z1, K0, X1, Y0, Z0, K0);

            } else if (rz >= rx && rx >= ry) {
                c1 = sub16Lookup2(X1, Y0, Z1, K0, X0, Y0, Z1, K0);
                c2 = sub16Lookup2(X1, Y1, Z1, K0, X1, Y0, Z1, K0);
                c3 =  sub16lookup(X0, Y0, Z1, K0, c0);

            }  else if (ry >= rx && rx >= rz) {
                c1 = sub16Lookup2(X1, Y1, Z0, K0, X0, Y1, Z0, K0);
                c2 =  sub16lookup(X0, Y1, Z0, K0, c0);
                c3 = sub16Lookup2(X1, Y1, Z1, K0, X1, Y1, Z0, K0);

            } else if (ry >= rz && rz >= rx) {
                c1 = sub16Lookup2(X1, Y1, Z1, K0, X0, Y1, Z1, K0);
                c2 =  sub16lookup(X0, Y1, Z0, K0, c0);
                c3 = sub16Lookup2(X0, Y1, Z1, K0, X0, Y1, Z0, K0);

            }  else if (rz >= ry && ry >= rx) {
                c1 = sub16Lookup2(X1, Y1, Z1, K0, X0, Y1, Z1, K0);
                c2 = sub16Lookup2(X0, Y1, Z1, K0, X0, Y0, Z1, K0);
                c3 =  sub16lookup(X0, Y0, Z1, K0, c0);

            } else {
                // TODO (B4): Same fall-through aliasing as tetrahedralInterp3D_Master.
                // Only reachable on NaN input. Harmless today (callers don't mutate)
                // but inconsistent with the optimised variants.
                c1 = c2 = c3 = [0,0,0,0];
            }

            if(outputChannels === 3){
                return [
                    (c0[0] + (c1[0] * rx) + (c2[0] * ry) + (c3[0] * rz)) * outputScale,
                    (c0[1] + (c1[1] * rx) + (c2[1] * ry) + (c3[1] * rz)) * outputScale,
                    (c0[2] + (c1[2] * rx) + (c2[2] * ry) + (c3[2] * rz)) * outputScale,
                ]
            }

            return [
                (c0[0] + (c1[0] * rx) + (c2[0] * ry) + (c3[0] * rz)) * outputScale,
                (c0[1] + (c1[1] * rx) + (c2[1] * ry) + (c3[1] * rz)) * outputScale,
                (c0[2] + (c1[2] * rx) + (c2[2] * ry) + (c3[2] * rz)) * outputScale,
                (c0[3] + (c1[3] * rx) + (c2[3] * ry) + (c3[3] * rz)) * outputScale,
            ]

            function lookup(x, y, z, k){
                var base;
                if(inputChannels === 3){
                    base =            ((x * g2) + (y * g1) + z) * outputChannels;
                } else {
                    base = ((k * g3) + (x * g2) + (y * g1) + z) * outputChannels;
                }

                if(outputChannels === 3){
                    return [CLUT[base++], CLUT[base++],CLUT[base]];
                }
                return [CLUT[base++], CLUT[base++],CLUT[base++], CLUT[base]];
            }

            function sub16lookup(x, y, z, k, b){
                var base, r0, r1, r2, r3;
                if(inputChannels === 3){
                    base =             ((x * g2) + (y * g1) + z) * outputChannels;
                } else {
                    base = ((k * g3) + (x * g2) + (y * g1) + z) * outputChannels;
                }

                r0 = CLUT[base++] - b[0];
                r1 = CLUT[base++] - b[1];
                r2 = CLUT[base++] - b[2];

                if(outputChannels === 3){
                    return [r0, r1, r2];
                }

                r3 = CLUT[base] - b[3];
                return [r0, r1, r2, r3];
            }

            function sub16Lookup2(x1, y1, z1, k1, x2, y2, z2, k2){
                var base1, base2;
                var r0, r1, r2, r3;
                if(inputChannels === 3) {
                    base1 =             ((x1 * g2) + (y1 * g1) + z1) * outputChannels;
                    base2 =             ((x2 * g2) + (y2 * g1) + z2) * outputChannels;
                } else {
                    base1 = ((k1 * g3) + (x1 * g2) + (y1 * g1) + z1) * outputChannels;
                    base2 = ((k2 * g3) + (x2 * g2) + (y2 * g1) + z2) * outputChannels;
                }

                r0 = CLUT[base1++] - CLUT[base2++];
                r1 = CLUT[base1++] - CLUT[base2++];
                r2 = CLUT[base1++] - CLUT[base2++];

                if(outputChannels === 3){
                    return [r0, r1, r2];
                }
                r3 = CLUT[base1] - CLUT[base2]
                return [r0, r1, r2, r3];
            }
        };

        /**
         * ========================================================================
         *  PERFORMANCE LESSONS — read this before "tidying up" the code below
         * ========================================================================
         *
         *  These rules were established by direct measurement (Chrome V8 +
         *  Firefox SpiderMonkey, see speed_tests/) when building the unrolled
         *  interpolators in this file. They run counter to the usual JS style
         *  guides but they are the difference between 5 Mpx/s and 30 Mpx/s.
         *
         *  1. INLINE FUNCTION CALLS in hot loops.
         *     Even tiny helpers like LERP(a,b,t) or sub16(a,b) cost real time
         *     when invoked millions of times per second. The compiled code
         *     becomes bigger, but the JIT keeps everything in registers and the
         *     net throughput is much higher.
         *
         *  2. DO NOT EXTRACT INTERMEDIATE LOCALS in hot expressions.
         *
         *         FASTER:    a = b * c * d;
         *                    e = b * c * n;
         *
         *         SLOWER:    var t = b * c;
         *                    a = t * d;
         *                    e = t * n;
         *
         *     The "obvious" CSE optimisation actually hurts. Hypothesis: V8's
         *     register allocator spills `t` to memory across the two reads,
         *     whereas the inlined form keeps the partial product in an xmm
         *     register. Verified empirically on these interpolators (~15-25%
         *     regression when intermediate vars were introduced).
         *
         *     EXCEPTION: caching a value that's READ FROM AN ARRAY twice IS
         *     worth it — the array read is the expensive part, not the local
         *     write. Hence the `a = CLUT[base++]; b = CLUT[base++]; ...` pattern
         *     in the unrolled tetra blocks below.
         *
         *  3. AVOID PER-PIXEL ALLOCATIONS.
         *     `new Array(n)`, `[a, b, c]`, `{...}` all trigger GC pressure at
         *     image scale. The single-colour interpolators below DO allocate
         *     (one new Array per call) — that's fine for the accuracy path.
         *     The image-grade `*_loop` functions write directly into a passed
         *     output buffer and allocate nothing per pixel.
         *
         *  4. PREFER `~~x` OVER `Math.floor(x)` for non-negative floats.
         *     Both produce an int32; `~~x` is a couple of ns faster and signals
         *     "I know x is non-negative" to readers. (Currently inconsistent in
         *     this file — TODO P3.)
         *
         *  5. STRUCTURE-OF-ARRAYS for LUTs, not array-of-objects.
         *     The CLUT is one flat Float64Array (or Uint16Array), not an array
         *     of {r,g,b,k} objects. Keeps cache-line utilisation high and lets
         *     the JIT use indexed reads.
         *
         *  6. DON'T CALL BACK INTO `this.foo(...)` from inner loops.
         *     Property lookup + this-binding adds up. The `*_loop` variants
         *     hoist everything they need into local vars at the top.
         *
         *  7. TYPE STABILITY — keep variables monomorphic.
         *     The hot vars below stay int (SMI) or stay double; never mix.
         *     The compiler optimises monomorphic operations heavily.
         *
         *  WHEN IN DOUBT: re-run speed_tests/ before AND after your change. If
         *  you can't measure a difference, prefer the more readable version. If
         *  the existing form looks ugly, it is probably ugly for a reason.
         * ========================================================================
         */

        /**
         * 1D linear interpolation, 1-channel input → N-channel output. Accuracy
         * path single-colour variant. Used for Gray-input profiles.
         *
         * @param {number[]} input  [g] in 0..1.
         * @param {object}   lut
         * @returns {number[]}      New array of length lut.outputChannels.
         */
        // linearInterp1D_NCh and bilinearInterp2D_NCh MOVED in v1.6 phase 2.
        //
        // They now live with the kernels that own those dimensions —
        // src/kernels/1d/Kernel1D.js and src/kernels/2d/Kernel2D.js — and are
        // reached through kernel.floatFor(lut, hints) rather than off
        // Transform.prototype. The pipeline builder asks the registry for the
        // stage function instead of choosing one itself, so a replacement
        // Kernel1D changes single-colour results and batch results together
        // rather than only the latter.
        //
        // See docs/deepdive/KernelContract.md.

        tetrahedralInterp3D_NCh(input, lut){
            var rx,ry,rz;
            var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2
            var base0, base1,base2, base3, base4,
                a, b, c, o

            var outputScale = lut.outputScale;
            var outputChannels = lut.outputChannels;
            var gridEnd = (lut.g1 - 1);
            var gridPointsScale = gridEnd * lut.inputScale;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;
            var go2 = lut.go2;

            // Scale FIRST, then clamp in grid space — see linearInterp1D_NCh
            // note (raw u8/u16 vs device 0..1 input contracts).
            px = Math.min(Math.max(input[0] * gridPointsScale, 0), gridEnd);
            py = Math.min(Math.max(input[1] * gridPointsScale, 0), gridEnd);
            pz = Math.min(Math.max(input[2] * gridPointsScale, 0), gridEnd);

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

            // Starting point
            base0 = X0 + Y0 + Z0;

            var output = new Array(outputChannels);

            if (rx >= ry && ry >= rz) {
                // block1
                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z0;
                base4 = X1 + Y1 + Z1;
                for(o = 0; o < outputChannels; o++){
                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    c = CLUT[base0++];
                    output[o] = (c + ((a - c) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;
                }

            } else if (rx >= rz && rz >= ry) {
                // block2

                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z1;
                base3 = X1 + Y0 + Z1;
                for(o = 0; o < outputChannels; o++){
                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    c = CLUT[base0++];
                    output[o] = (c + ((b - c) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) * outputScale;
                }

            } else if (rx >= ry && rz >= rx) {
                // block3

                base1 = X1 + Y0 + Z1;
                base2 = X0 + Y0 + Z1;
                base3 = X1 + Y1 + Z1;
                for(o = 0; o < outputChannels; o++){
                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    c = CLUT[base0++];
                    output[o] = (c + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c) * rz)) * outputScale;
                }

            } else if (ry >= rx && rx >= rz) {
                // block4

                base1 = X1 + Y1 + Z0;
                base2 = X0 + Y1 + Z0;
                base4 = X1 + Y1 + Z1;
                for(o = 0; o < outputChannels; o++){
                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    c = CLUT[base0++];
                    output[o] = (c + ((b - a) * rx) + ((a - c) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;
                }

            } else if (ry >= rz && rz >= rx) {
                // block5

                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                base3 = X0 + Y1 + Z0;
                for(o = 0; o < outputChannels; o++){
                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    c = CLUT[base0++];
                    output[o] = (c + ((CLUT[base1++] - a) * rx) + ((b - c) * ry) + ((a - b) * rz)) * outputScale;
                }

            } else if (rz >= ry && ry >= rx) {
                // block6

                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                base4 = X0 + Y0 + Z1;
                for(o = 0; o < outputChannels; o++){
                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    c = CLUT[base0++];
                    output[o] = (c + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c) * rz) ) * outputScale;
                }

            } else {
                for(o = 0; o < outputChannels; o++){
                    output[o] = CLUT[base0++] * outputScale;
                }
            }

            return output;
        };

        /**
         * 3D tetrahedral interpolation, 3-channel input → 4-channel output.
         * Accuracy path. Used for RGB → CMYK single-colour conversions
         * (e.g. picking RGB swatches and asking "what CMYK would this be").
         *
         * Output channel writes are unrolled (no inner for-o loop) for speed.
         *
         * @param {number[]} input  [r, g, b] in 0..1.
         * @param {object}   lut
         * @returns {number[]}      [c, m, y, k] scaled to lut.outputScale.
         */
        tetrahedralInterp3D_4Ch(input, lut){
            var rx,ry,rz;
            var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2
            var base1,base2, base3, base4,
                c0,c1,c2,c3, a, b

            var outputScale = lut.outputScale;
            var gridEnd = (lut.g1 - 1);
            var gridPointsScale = gridEnd * lut.inputScale;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;
            var go2 = lut.go2;

            // CLAMP IN GRID SPACE, NOT IN 0..1. `input` here is whatever the
            // caller's contract says: device 0..1 when inputScale is 1, raw
            // 0..255 when the LUT was built for an 8-bit pipeline and folded
            // 1/255 into inputScale. Clamping to 1 BEFORE applying the scale
            // collapsed the whole 8-bit range onto one grid cell, so every
            // colour came back as the same value. tetrahedralInterp3D_NCh had
            // the same shape and was fixed first; these four kept it.
            //
            // gridPointsScale does the divide and the multiply at once.
            px = Math.min(Math.max(input[0] * gridPointsScale, 0), gridEnd);
            py = Math.min(Math.max(input[1] * gridPointsScale, 0), gridEnd);
            pz = Math.min(Math.max(input[2] * gridPointsScale, 0), gridEnd);

            //
            // A few optimisations here, X0 is multiplied by go2, which is precalculated grid x outputChannels
            // And rather than X0+1 we can just do X0 + offset to location in lut
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

            // Starting point in CLUT
            // Note that X0, Y0, Z0 are all multiplied by the grid offset and the outputChannels
            // So we only need additions rather than n = ((X0 * go2) + (Y0 * go1) + Z0)) * outputChannels
            base1 = X0 + Y0 + Z0;
            c0 = CLUT[base1++];
            c1 = CLUT[base1++];
            c2 = CLUT[base1++];
            c3 = CLUT[base1];

            var output = new Array(4);

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
                output[0] = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[1] = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[2] = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                // Duno if this helps, but no need to increase base1/2/3/4 again as we are done with them
                a = CLUT[base1  ];
                b = CLUT[base2  ];
                output[3] = (c3 + ((a - c3) * rx) +  ((b - a) * ry) + ((CLUT[base4  ] - b) * rz)) * outputScale;

            } else if (rx >= rz && rz >= ry) {
                // block2

                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z1;
                base3 = X1 + Y0 + Z1;
                //base4 = base3;
                //base5 = base1;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[0] =( c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[1] =( c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[2] =( c2 + ((b - c2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base3];
                b = CLUT[base1];
                output[3] =( c3 + ((b - c3) * rx) + ((CLUT[base2  ] - a) * ry) + ((a - b) * rz) ) * outputScale;

            } else if (rx >= ry && rz >= rx) {
                // block3

                base1 = X1 + Y0 + Z1;
                base2 = X0 + Y0 + Z1;
                base3 = X1 + Y1 + Z1;
                //base4 = base1;
                //base5 = base2;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[0] = (c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[1] = (c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[2] = (c2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c2) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[3] = (c3 + ((a - b) * rx) + ((CLUT[base3  ] - a) * ry) + ((b - c3) * rz)) * outputScale;

            } else if (ry >= rx && rx >= rz) {
                // block4

                base1 = X1 + Y1 + Z0;
                base2 = X0 + Y1 + Z0;
                //base3 = base2;
                base4 = X1 + Y1 + Z1;
                //base5 = base1;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[0] = (c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[1] = (c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[2] = (c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                a = CLUT[base2];
                b = CLUT[base1];
                output[3] = (c3 + ((b - a) * rx) + ((a - c3) * ry) + ((CLUT[base4  ] - b) * rz) ) * outputScale;

            } else if (ry >= rz && rz >= rx) {
                // block5

                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                base3 = X0 + Y1 + Z0;
                //base4 = base2;
                //base5 = base3;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[0] = (c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[1] = (c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[2] = (c2 + ((CLUT[base1++] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[3] = (c3 + ((CLUT[base1++] - a) * rx) + ((b - c3) * ry) + ((a - b) * rz) ) * outputScale;

            } else if (rz >= ry && ry >= rx) {
                // block6

                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                //base3 = base2;
                base4 = X0 + Y0 + Z1;
                //base5 = base4;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[0] = (c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ) * outputScale;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[1] = (c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz) ) * outputScale;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[2] = (c2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz) ) * outputScale;

                a = CLUT[base2]
                b = CLUT[base4]
                output[3] = (c3 + ((CLUT[base1  ] - a) * rx) + ((a - b) * ry) + ((b - c3) * rz) ) * outputScale;

            } else {
                output[0] = c0 * outputScale;
                output[1] = c1 * outputScale;
                output[2] = c2 * outputScale;
                output[3] = c3 * outputScale;
            }

            return output;
        };

        /**
         * 3D tetrahedral interpolation, 3-channel input → 3-channel output.
         * Accuracy path. Used for RGB → RGB and RGB → Lab single-colour
         * conversions — by far the most-called accuracy-path interpolator.
         *
         * Output channel writes are unrolled (no inner for-o loop) for speed.
         *
         * @param {number[]} input  [r, g, b] in 0..1.
         * @param {object}   lut
         * @returns {number[]}      [x, y, z] scaled to lut.outputScale.
         */
        tetrahedralInterp3D_3Ch(input, lut){
            var rx,ry,rz,
                X0,X1,Y0,
                Y1,Z0,Z1,
                px,py,pz,
                input0, input1, input2
            var base1,base2,base3,base4,
                c0,c1,c2, a, b

            var outputScale = lut.outputScale;
            var gridEnd = (lut.g1 - 1);
            var gridPointsScale = gridEnd * lut.inputScale;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;
            var go2 = lut.go2;

            // CLAMP IN GRID SPACE, NOT IN 0..1. `input` here is whatever the
            // caller's contract says: device 0..1 when inputScale is 1, raw
            // 0..255 when the LUT was built for an 8-bit pipeline and folded
            // 1/255 into inputScale. Clamping to 1 BEFORE applying the scale
            // collapsed the whole 8-bit range onto one grid cell, so every
            // colour came back as the same value. tetrahedralInterp3D_NCh had
            // the same shape and was fixed first; these four kept it.
            //
            // gridPointsScale does the divide and the multiply at once.
            px = Math.min(Math.max(input[0] * gridPointsScale, 0), gridEnd);
            py = Math.min(Math.max(input[1] * gridPointsScale, 0), gridEnd);
            pz = Math.min(Math.max(input[2] * gridPointsScale, 0), gridEnd);

            //
            // A few optimisations here, X0 is multiplied by go2, which is precalculated grid x outputChannels
            // And rather than X0+1 we can just do X0 + offset to location in lut
            X0 = ~~px; //~~ is the same as Math.floor(px)
            rx = (px - X0); // get the fractional part
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

            // Starting point in CLUT
            // Note that X0, Y0, Z0 are all multiplied by the grid offset and the outputChannels
            // So we only need additions rather than n = ((X0 * go2) + (Y0 * go1) + Z0)) * outputChannels
            base1 = X0 + Y0 + Z0;
            c0 = CLUT[base1++];
            c1 = CLUT[base1++];
            c2 = CLUT[base1];

            var output = new Array(3);

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
                output[0] = (c0 + ((a - c0) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[1] = (c1 + ((a - c1) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;

                a = CLUT[base1];
                b = CLUT[base2];
                output[2] = (c2 + ((a - c2) * rx) +  ((b - a) * ry) + ((CLUT[base4] - b) * rz)) * outputScale;


            } else if (rx >= rz && rz >= ry) {
                // block2

                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z1;
                base3 = X1 + Y0 + Z1;
                //base4 = base3;
                //base5 = base1;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[0] =( c0 + ((b - c0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base3++];
                b = CLUT[base1++];
                output[1] =( c1 + ((b - c1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base3];
                b = CLUT[base1];
                output[2] =( c2 + ((b - c2) * rx) + ((CLUT[base2] - a) * ry) + ((a - b) * rz) ) * outputScale;



            } else if (rx >= ry && rz >= rx) {
                // block3

                base1 = X1 + Y0 + Z1;
                base2 = X0 + Y0 + Z1;
                base3 = X1 + Y1 + Z1;
                //base4 = base1;
                //base5 = base2;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[0] = (c0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c0) * rz)) * outputScale;

                a = CLUT[base1++];
                b = CLUT[base2++];
                output[1] = (c1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c1) * rz)) * outputScale;

                a = CLUT[base1];
                b = CLUT[base2];
                output[2] = (c2 + ((a - b) * rx) + ((CLUT[base3] - a) * ry) + ((b - c2) * rz)) * outputScale;



            } else if (ry >= rx && rx >= rz) {
                // block4

                base1 = X1 + Y1 + Z0;
                base2 = X0 + Y1 + Z0;
                //base3 = base2;
                base4 = X1 + Y1 + Z1;
                //base5 = base1;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[0] = (c0 + ((b - a) * rx) + ((a - c0) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base1++];
                output[1] = (c1 + ((b - a) * rx) + ((a - c1) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;

                a = CLUT[base2];
                b = CLUT[base1];
                output[2] = (c2 + ((b - a) * rx) + ((a - c2) * ry) + ((CLUT[base4] - b) * rz) ) * outputScale;


            } else if (ry >= rz && rz >= rx) {
                // block5

                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                base3 = X0 + Y1 + Z0;
                //base4 = base2;
                //base5 = base3;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[0] = (c0 + ((CLUT[base1++] - a) * rx) + ((b - c0) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base2++];
                b = CLUT[base3++];
                output[1] = (c1 + ((CLUT[base1++] - a) * rx) + ((b - c1) * ry) + ((a - b) * rz) ) * outputScale;

                a = CLUT[base2];
                b = CLUT[base3];
                output[2] = (c2 + ((CLUT[base1] - a) * rx) + ((b - c2) * ry) + ((a - b) * rz) ) * outputScale;


            } else if (rz >= ry && ry >= rx) {
                // block6

                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                //base3 = base2;
                base4 = X0 + Y0 + Z1;
                //base5 = base4;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[0] = (c0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c0) * rz) ) * outputScale;

                a = CLUT[base2++]
                b = CLUT[base4++]
                output[1] = (c1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c1) * rz) ) * outputScale;

                a = CLUT[base2]
                b = CLUT[base4]
                output[2] = (c2 + ((CLUT[base1] - a) * rx) + ((a - b) * ry) + ((b - c2) * rz) ) * outputScale;

            } else {
                output[0] = c0 * outputScale;
                output[1] = c1 * outputScale;
                output[2] = c2 * outputScale;
            }

            return output;
        };

        /**
         * 4D tetrahedral interpolation, 4-channel input → 3-channel output.
         * Accuracy path. Used for CMYK → RGB and CMYK → Lab single-colour
         * conversions (soft-proof picker, ΔE round-trips through CMYK).
         *
         * Implemented as two 3D tetrahedral passes (one at K0, one at K1) and a
         * linear blend across the K axis. Includes an interpK early-out — when
         * rk === 0 the second pass is skipped.
         *
         * @param {number[]} input  [k, c, m, y] in 0..1 (input[0] is the K axis).
         * @param {object}   lut
         * @returns {number[]}      [x, y, z] scaled to lut.outputScale.
         */
        tetrahedralInterp4D_3Ch(input, lut){
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
            var gridEnd = (lut.g1 - 1);
            var gridPointsScale = gridEnd * lut.inputScale;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;
            var go2 = lut.go2;
            var go3 = lut.go3;
            var kOffset = go3 - lut.outputChannels + 1; // +1 since we don't do a [base++] for the last CLUT lookup

            // CLAMP IN GRID SPACE, NOT IN 0..1. `input` here is whatever the
            // caller's contract says: device 0..1 when inputScale is 1, raw
            // 0..255 when the LUT was built for an 8-bit pipeline and folded
            // 1/255 into inputScale. Clamping to 1 BEFORE applying the scale
            // collapsed the whole 8-bit range onto one grid cell, so every
            // colour came back as the same value. tetrahedralInterp3D_NCh had
            // the same shape and was fixed first; these four kept it.
            //
            // gridPointsScale does the divide and the multiply at once.
            px = Math.min(Math.max(input[1] * gridPointsScale, 0), gridEnd); // C
            py = Math.min(Math.max(input[2] * gridPointsScale, 0), gridEnd); // M
            pz = Math.min(Math.max(input[3] * gridPointsScale, 0), gridEnd); // Y
            pk = Math.min(Math.max(input[0] * gridPointsScale, 0), gridEnd); // K

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

            base1 = X0 + Y0 + Z0 + K0;
            c0 = CLUT[base1++];
            c1 = CLUT[base1++];
            c2 = CLUT[base1];

            if(interpK) {
                base1 +=kOffset;
                d0 = CLUT[base1++];
                d1 = CLUT[base1++];
                d2 = CLUT[base1];
            }

            var output = new Array(3);

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
                    output[0] = (o0 + (((d0 + ((a - d0) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o0) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[1] = (o1 + (((d1 + ((a - d1) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o1) * rk)) * outputScale;

                    a = CLUT[base1];
                    b = CLUT[base2];
                    output[2] = (o2 + (((d2 + ((a - d2) * rx) + ((b - a) * ry) + ((CLUT[base4] - b) * rz)) - o2) * rk)) * outputScale;

                } else {
                    output[0] = o0 * outputScale;
                    output[1] = o1 * outputScale;
                    output[2] = o2 * outputScale;
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
                    output[0] = (o0 + ((( d0 + ((b - d0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[1] = (o1 + ((( d1 + ((b - d1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base3];
                    b = CLUT[base1];
                    output[2] = (o2 + ((( d2 + ((b - d2) * rx) + ((CLUT[base2] - a) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                } else {
                    output[0] = o0 * outputScale;
                    output[1] = o1 * outputScale;
                    output[2] = o2 * outputScale;
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
                    output[0] = (o0 + ((( d0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d0) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[1] = (o1 + ((( d1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - d1) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base1];
                    b = CLUT[base2];
                    output[2] = (o2 + ((( d2 + ((a - b) * rx) + ((CLUT[base3] - a) * ry) + ((b - d2) * rz) ) - o2) * rk)) * outputScale;
                } else {
                    output[0] = o0 * outputScale;
                    output[1] = o1 * outputScale;
                    output[2] = o2 * outputScale;
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
                    output[0] = (o0 + ((( d0 + ((b - a) * rx) + ((a - d0) * ry) + ((CLUT[base4++] - b) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[1] = (o1 + ((( d1 + ((b - a) * rx) + ((a - d1) * ry) + ((CLUT[base4++] - b) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base2];
                    b = CLUT[base1];
                    output[2] = (o2 + ((( d2 + ((b - a) * rx) + ((a - d2) * ry) + ((CLUT[base4] - b) * rz) ) - o2) * rk)) * outputScale;

                } else {
                    output[0] = o0 * outputScale;
                    output[1] = o1 * outputScale;
                    output[2] = o2 * outputScale;
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
                    output[0] = (o0 + ((( d0 + ((CLUT[base1++] - a) * rx) + ((b - d0) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[1] = (o1 + ((( d1 + ((CLUT[base1++] - a) * rx) + ((b - d1) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base2];
                    b = CLUT[base3];
                    output[2] = (o2 + ((( d2 + ((CLUT[base1] - a) * rx) + ((b - d2) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                } else {
                    output[0] = o0 * outputScale;
                    output[1] = o1 * outputScale;
                    output[2] = o2 * outputScale;
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
                    output[0] = (o0 + ((( d0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d0) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[1] = (o1 + ((( d1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - d1) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base2]
                    b = CLUT[base4]
                    output[2] = (o2 + ((( d2 + ((CLUT[base1] - a) * rx) + ((a - b) * ry) + ((b - d2) * rz) ) - o2) * rk)) * outputScale;

                } else {
                    output[0] = o0 * outputScale;
                    output[1] = o1 * outputScale;
                    output[2] = o2 * outputScale;
                }

            } else {
                if(interpK) {
                    output[0] = c0 + (( d0 - c0 ) * rk) * outputScale;
                    output[1] = c1 + (( d1 - c1 ) * rk) * outputScale;
                    output[2] = c2 + (( d2 - c2 ) * rk) * outputScale;
                } else {
                    output[0] = c0 * outputScale;
                    output[1] = c1 * outputScale;
                    output[2] = c2 * outputScale;
                }
            }
            return output;
        };

        /**
         * 4D tetrahedral interpolation, 4-channel input → 4-channel output.
         * Accuracy path. Used for CMYK → CMYK single-colour conversions (DeviceLink
         * application, press-to-press re-purposing analysis).
         *
         * Same K-axis early-out as the 4D→3Ch variant.
         *
         * @param {number[]} input  [k, c, m, y] in 0..1 (input[0] is the K axis).
         * @param {object}   lut
         * @returns {number[]}      [c, m, y, k] scaled to lut.outputScale.
         */
        tetrahedralInterp4D_4Ch(input, lut){
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

            var gridEnd = (lut.g1 - 1);
            var gridPointsScale = gridEnd * lut.inputScale;
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;
            var go2 = lut.go2;
            var go3 = lut.go3;
            var kOffset = go3 - lut.outputChannels + 1; // +1 since we don't do a [base++] for the last CLUT lookup

            // CLAMP IN GRID SPACE, NOT IN 0..1. `input` here is whatever the
            // caller's contract says: device 0..1 when inputScale is 1, raw
            // 0..255 when the LUT was built for an 8-bit pipeline and folded
            // 1/255 into inputScale. Clamping to 1 BEFORE applying the scale
            // collapsed the whole 8-bit range onto one grid cell, so every
            // colour came back as the same value. tetrahedralInterp3D_NCh had
            // the same shape and was fixed first; these four kept it.
            //
            // gridPointsScale does the divide and the multiply at once.
            px = Math.min(Math.max(input[1] * gridPointsScale, 0), gridEnd); // C
            py = Math.min(Math.max(input[2] * gridPointsScale, 0), gridEnd); // M
            pz = Math.min(Math.max(input[3] * gridPointsScale, 0), gridEnd); // Y
            pk = Math.min(Math.max(input[0] * gridPointsScale, 0), gridEnd); // K

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

            base1 = X0 + Y0 + Z0 + K0;
            c0 = CLUT[base1++];
            c1 = CLUT[base1++];
            c2 = CLUT[base1++];
            c3 = CLUT[base1];

            if(interpK) {
                base1 +=kOffset;
                k0 = CLUT[base1++];
                k1 = CLUT[base1++];
                k2 = CLUT[base1++];
                k3 = CLUT[base1];
            }

            var output = new Array(4);

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
                    output[0] = (o0 + (((k0 + ((a - k0) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o0) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[1] = (o1 + (((k1 + ((a - k1) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o1) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[2] = (o2 + (((k2 + ((a - k2) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o2) * rk)) * outputScale;

                    a = CLUT[base1];
                    b = CLUT[base2];
                    output[3] = (o3 + (((k3 + ((a - k3) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - o3) * rk)) * outputScale;
                } else {
                    output[0] = o0 * outputScale;
                    output[1] = o1 * outputScale;
                    output[2] = o2 * outputScale;
                    output[3] = o3 * outputScale;
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
                    output[0] = (o0 + ((( k0 + ((b - k0) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[1] = (o1 + ((( k1 + ((b - k1) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[2] = (o2 + ((( k2 + ((b - k2) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    output[3] = (o3 + ((( k3 + ((b - k3) * rx) + ((CLUT[base2  ] - a) * ry) + ((a - b) * rz) ) - o3) * rk)) * outputScale;
                } else {
                    output[0] = o0 * outputScale;
                    output[1] = o1 * outputScale;
                    output[2] = o2 * outputScale;
                    output[3] = o3 * outputScale;
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
                    output[0] = (o0 + ((( k0 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - k0) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[1] = (o1 + ((( k1 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - k1) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    output[2] = (o2 + ((( k2 + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - k2) * rz) ) - o2) * rk)) * outputScale;

                    a = CLUT[base1];
                    b = CLUT[base2];
                    output[3] = (o3 + ((( k3 + ((a - b) * rx) + ((CLUT[base3  ] - a) * ry) + ((b - k3) * rz) ) - o3) * rk)) * outputScale;
                } else {
                    output[0] = o0 * outputScale;
                    output[1] = o1 * outputScale;
                    output[2] = o2 * outputScale;
                    output[3] = o3 * outputScale;
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
                    output[0] = (o0 + ((( k0 + ((b - a) * rx) + ((a - k0) * ry) + ((CLUT[base4++] - b) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[1] = (o1 + ((( k1 + ((b - a) * rx) + ((a - k1) * ry) + ((CLUT[base4++] - b) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    output[2] = (o2 + ((( k2 + ((b - a) * rx) + ((a - k2) * ry) + ((CLUT[base4++] - b) * rz) ) - o2) * rk)) * outputScale;

                    a = CLUT[base2];
                    b = CLUT[base1];
                    output[3] = (o3 + ((( k3 + ((b - a) * rx) + ((a - k3) * ry) + ((CLUT[base4  ] - b) * rz) ) - o3) * rk)) * outputScale;
                } else {
                    output[0] = o0 * outputScale;
                    output[1] = o1 * outputScale;
                    output[2] = o2 * outputScale;
                    output[3] = o3 * outputScale;
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
                    output[0] = (o0 + ((( k0 + ((CLUT[base1++] - a) * rx) + ((b - k0) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[1] = (o1 + ((( k1 + ((CLUT[base1++] - a) * rx) + ((b - k1) * ry) + ((a - b) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    output[2] = (o2 + ((( k2 + ((CLUT[base1++] - a) * rx) + ((b - k2) * ry) + ((a - b) * rz) ) - o2) * rk)) * outputScale;

                    a = CLUT[base2];
                    b = CLUT[base3];
                    output[3] = (o3 + ((( k3 + ((CLUT[base1++] - a) * rx) + ((b - k3) * ry) + ((a - b) * rz) ) - o3) * rk)) * outputScale;
                } else {
                    output[0] = o0 * outputScale;
                    output[1] = o1 * outputScale;
                    output[2] = o2 * outputScale;
                    output[3] = o3 * outputScale;
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
                    output[0] = (o0 + ((( k0 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - k0) * rz) ) - o0) * rk)) * outputScale;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[1] = (o1 + ((( k1 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - k1) * rz) ) - o1) * rk)) * outputScale;

                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    output[2] = (o2 + ((( k2 + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - k2) * rz) ) - o2) * rk)) * outputScale;

                    a = CLUT[base2]
                    b = CLUT[base4]
                    output[3] = (o3 + ((( k3 + ((CLUT[base1  ] - a) * rx) + ((a - b) * ry) + ((b - k3) * rz) ) - o3) * rk)) * outputScale;
                } else {
                    output[0] = o0 * outputScale;
                    output[1] = o1 * outputScale;
                    output[2] = o2 * outputScale;
                    output[3] = o3 * outputScale;
                }

            } else {
                if(interpK) {
                    output[0] = c0 + (( k0 - c0 ) * rk) * outputScale;
                    output[1] = c1 + (( k1 - c1 ) * rk) * outputScale;
                    output[2] = c2 + (( k2 - c2 ) * rk) * outputScale;
                    output[3] = c3 + (( k3 - c3 ) * rk) * outputScale;
                } else {
                    output[0] = c0 * outputScale;
                    output[1] = c1 * outputScale;
                    output[2] = c2 * outputScale;
                    output[3] = c3 * outputScale;
                }
            }
            return output;
        };

        /**
         * 4D tetrahedral interpolation, 4-channel input → N-channel output
         * (typically N >= 5 — n-color separations from a CMYK source).
         * Accuracy path.
         *
         * For the common 4→3 (CMYK→RGB / Lab) and 4→4 (CMYK→CMYK) cases the
         * unrolled tetrahedralInterp4D_3Ch / _4Ch variants above are dispatched
         * by addStageLUT() instead.
         *
         * @param {number[]} input  4 channels in 0..1.
         * @param {object}   lut
         * @returns {number[]}      New array of length lut.outputChannels.
         */
        tetrahedralInterp4D_NCh(input, lut){
            var X0, X1, Y0, K0,
                Y1, Z0, Z1,
                rx, ry, rz, rk,
                px, py, pz, pk,
                input0, input1, input2, inputK,
                base0, base1, base2, base3, base4,
                a, b, c, d, o,
                interpK;

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

            // Scale FIRST, then clamp in grid space — see linearInterp1D_NCh
            // note (raw u8/u16 vs device 0..1 input contracts).
            pk = Math.min(Math.max(input[0] * gridPointsScale, 0), gridEnd); // K
            px = Math.min(Math.max(input[1] * gridPointsScale, 0), gridEnd); // C
            py = Math.min(Math.max(input[2] * gridPointsScale, 0), gridEnd); // M
            pz = Math.min(Math.max(input[3] * gridPointsScale, 0), gridEnd); // Y

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

            var output = new Array(outputChannels);

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
                    output[o] = (c + ((a - c) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScaleK0;
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
                        d = output[o]; // get the output from the previous loop to interpolate
                        output[o] = (d + (((c + ((a - c) * rx) + ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) - d) * rk)) * outputScale;
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
                    output[o] = (c + ((b - c) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) * outputScaleK0;
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
                        d = output[o];
                        output[o] = (d + ((( c + ((b - c) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz) ) - d) * rk)) * outputScale;
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
                    output[o] = (c + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c) * rz)) * outputScaleK0;
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
                        d = output[o];
                        output[o] = (d + ((( c + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c) * rz) ) - d) * rk)) * outputScale;
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
                    output[o] = (c + ((b - a) * rx) + ((a - c) * ry) + ((CLUT[base4++] - b) * rz)) * outputScaleK0;
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
                        d = output[o];
                        output[o] = (d + (((c + ((b - a) * rx) + ((a - c) * ry) + ((CLUT[base4++] - b) * rz) ) - d) * rk)) * outputScale;
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
                    output[o] = (c + ((CLUT[base1++] - a) * rx) + ((b - c) * ry) + ((a - b) * rz)) * outputScaleK0;
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
                        d = output[o];
                        output[o] = (d + ((( c + ((CLUT[base1++] - a) * rx) + ((b - c) * ry) + ((a - b) * rz) ) - d) * rk)) * outputScale;
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
                    output[o] = (c + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c) * rz)) * outputScaleK0;
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
                        d = output[o];
                        output[o] = (d + ((( c + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c) * rz) ) - d) * rk)) * outputScale;
                    }
                }

            } else {
                if(interpK) {
                    for(o = 0 ; o < outputChannels ; o++) {
                        output[o] = CLUT[base0++];
                    }
                    base0 += kOffset;
                    for(o = 0 ; o < outputChannels ; o++) {
                        c = CLUT[base0++]
                        output[o] = (c + (( output[o] - c ) * rk)) * outputScale;
                    }
                } else {
                    for(o = 0 ; o < outputChannels ; o++) {
                        output[o] = CLUT[base0++] * outputScale;
                    }
                }
            }

            return output;
        };

        /**
         * N-channel input interpolation: tetrahedral base, linear extras.
         *
         * THE SCHEME, AND WHY THIS ONE. Little CMS evaluates an n-dimensional
         * CLUT by peeling the FIRST input axis, evaluating the remaining
         * (n-1)-dimensional table at the two bracketing planes, and lerping
         * between them -- recursing until three axes are left, where it does a
         * real 3-D tetrahedral interpolation (cmsintrp.c: Eval4Inputs and the
         * Eval##N##Inputs macro). Last three axes tetrahedral, every extra
         * axis linear.
         *
         * The 4-channel case of that is a deliberate colour decision, and lcms
         * names its variables to say so -- fk, fx, fy, fz: K is the linear
         * axis, CMY the tetrahedral base, which is exactly what
         * tetrahedralInterp4D_3Ch does. The n>4 generalisation is MECHANICAL,
         * not colour-reasoned: the recursion peels from the front because that
         * is the cheapest way to reuse the 3-D evaluator, so on a CMYK+spots
         * profile it is the SPOTS that get the tetrahedron and CMYK that gets
         * lerped. Nobody chose that; it falls out of the recursion.
         *
         * WHAT IT REPLACED. simplexInterpND_NCh below -- a Kuhn simplex across
         * all n axes, O(n) rather than O(2^(n-3)), and the nicer algorithm.
         * Retired on measurement, not taste:
         *
         *      ch  grid   simplex             lcms scheme
         *       5     9   119ms  mean 0.177   60ms   mean 0.197
         *       8     4   155ms  mean 0.479   441ms  mean 0.021
         *      10     3   180ms  mean 1.130   1746ms mean 0.008
         *
         * (mean = LSB from Little CMS over a smooth table --
         * bench/lcms-comparison/accuracy_nchannel.js)
         *
         * The simplex is not better anywhere. At 5 and 6 channels -- the
         * counts anyone ships, Hexachrome being 6 -- this scheme is FASTER,
         * because four tetrahedral evaluations cost less than the sort the
         * simplex cannot avoid. Above that the simplex wins on speed and loses
         * 23x to 140x on agreement, and loses it exactly where grid^n has
         * squeezed the table to 3 or 4 points per axis. The Lab gamut is a
         * lobed solid rather than a box, so at that density no scheme recovers
         * anything real, and the speed is bought with nothing.
         *
         * @param {number[]|TypedArray} input  n channels
         * @param {object} lut
         * @returns {number[]} new array of length lut.outputChannels
         */
        tetrahedralInterpND_NCh(input, lut) {
            const dims    = lut.inputChannels;
            const outCh   = lut.outputChannels;
            const CLUT    = lut.CLUT;
            const gPoints = lut.gridPoints;
            const scale   = lut.outputScale;
            const inScale = lut.inputScale;

            // stride[d] = one step along axis d, in CLUT elements. Last axis
            // fastest, which is the ICC storage order.
            const stride = new Array(dims);
            stride[dims - 1] = outCh;
            for (let d = dims - 2; d >= 0; d--) {
                stride[d] = stride[d + 1] * gPoints[d + 1];
            }

            // Lower grid index and fraction per axis. Scale FIRST, clamp in
            // grid space -- see tetrahedralInterp3D_NCh for what clamping to
            // 0..1 beforehand costs when inputScale is 1/255.
            const idx = new Array(dims);
            const fx  = new Array(dims);
            for (let d = 0; d < dims; d++) {
                const gm = gPoints[d] - 1;
                const v  = Math.min(Math.max(input[d] * inScale, 0), 1) * gm;
                const i0 = Math.floor(v);
                idx[d] = (i0 >= gm) ? (gm > 0 ? gm - 1 : 0) : i0;
                fx[d]  = v - idx[d];
            }

            // The 3-D tetrahedral base on axes (b, b+1, b+2). Six cases, one
            // per ordering of the three fractions: which tetrahedron of the
            // cube the point landed in.
            const tetra = (b, off, out) => {
                const rx = fx[b], ry = fx[b + 1], rz = fx[b + 2];
                const sx = stride[b], sy = stride[b + 1], sz = stride[b + 2];
                const base = off + idx[b] * sx + idx[b + 1] * sy + idx[b + 2] * sz;

                for (let c = 0; c < outCh; c++) {
                    const c000 = CLUT[base + c];
                    let c1, c2, c3;
                    if (rx >= ry && ry >= rz) {
                        c1 = CLUT[base + sx + c] - c000;
                        c2 = CLUT[base + sx + sy + c] - CLUT[base + sx + c];
                        c3 = CLUT[base + sx + sy + sz + c] - CLUT[base + sx + sy + c];
                    } else if (rx >= rz && rz >= ry) {
                        c1 = CLUT[base + sx + c] - c000;
                        c2 = CLUT[base + sx + sy + sz + c] - CLUT[base + sx + sz + c];
                        c3 = CLUT[base + sx + sz + c] - CLUT[base + sx + c];
                    } else if (rz >= rx && rx >= ry) {
                        c1 = CLUT[base + sx + sz + c] - CLUT[base + sz + c];
                        c2 = CLUT[base + sx + sy + sz + c] - CLUT[base + sx + sz + c];
                        c3 = CLUT[base + sz + c] - c000;
                    } else if (ry >= rx && rx >= rz) {
                        c1 = CLUT[base + sx + sy + c] - CLUT[base + sy + c];
                        c2 = CLUT[base + sy + c] - c000;
                        c3 = CLUT[base + sx + sy + sz + c] - CLUT[base + sx + sy + c];
                    } else if (ry >= rz && rz >= rx) {
                        c1 = CLUT[base + sx + sy + sz + c] - CLUT[base + sy + sz + c];
                        c2 = CLUT[base + sy + c] - c000;
                        c3 = CLUT[base + sy + sz + c] - CLUT[base + sy + c];
                    } else {
                        c1 = CLUT[base + sx + sy + sz + c] - CLUT[base + sy + sz + c];
                        c2 = CLUT[base + sy + sz + c] - CLUT[base + sz + c];
                        c3 = CLUT[base + sz + c] - c000;
                    }
                    out[c] = c000 + c1 * rx + c2 * ry + c3 * rz;
                }
            };

            // Peel axis d linearly, recursing until three axes remain.
            const peel = (d, off, out) => {
                if (dims - d === 3) { tetra(d, off, out); return; }
                const s  = stride[d];
                const lo = new Array(outCh);
                const hi = new Array(outCh);
                peel(d + 1, off + idx[d] * s, lo);
                peel(d + 1, off + (idx[d] + 1) * s, hi);
                const r = fx[d];
                for (let c = 0; c < outCh; c++) out[c] = lo[c] + (hi[c] - lo[c]) * r;
            };

            const result = new Array(outCh);

            if (dims >= 3) {
                peel(0, 0, result);
            } else {
                // 1 or 2 axes: no tetrahedron to reach. Multilinear over the
                // 2^dims corners. KernelND owns 5..15 so nothing built-in
                // arrives here, but this is exported and a caller with a
                // narrow LUT should get an answer rather than a crash.
                const corners = 1 << dims;
                for (let c = 0; c < outCh; c++) result[c] = 0;
                for (let m = 0; m < corners; m++) {
                    let w = 1, off = 0;
                    for (let d = 0; d < dims; d++) {
                        const up = (m >> d) & 1;
                        w *= up ? fx[d] : (1 - fx[d]);
                        off += (idx[d] + up) * stride[d];
                    }
                    if (w === 0) continue;
                    for (let c = 0; c < outCh; c++) result[c] += w * CLUT[off + c];
                }
            }

            for (let c = 0; c < outCh; c++) result[c] *= scale;
            return result;
        }

        /**
         * N-dimensional Kuhn simplex interpolation. NOT THE DEFAULT.
         *
         * Sort the fractional coordinates, walk the n+1 corners of the simplex
         * they select, weight by the sorted differences. This is the honest
         * generalisation of tetrahedral interpolation to n dimensions: O(n)
         * corner reads and one sort, against O(2^(n-3)) tetrahedral
         * evaluations for tetrahedralInterpND_NCh above. It is the nicer
         * algorithm, which is why it is still here.
         *
         * WHY IT IS NOT USED, measured rather than argued:
         *
         *      ch  grid   simplex             lcms scheme
         *       5     9   119ms  mean 0.177   60ms   mean 0.197
         *       8     4   155ms  mean 0.479   441ms  mean 0.021
         *      10     3   180ms  mean 1.130   1746ms mean 0.008
         *
         * (mean = LSB from Little CMS over a smooth table --
         * bench/lcms-comparison/accuracy_nchannel.js)
         *
         * Not better anywhere. At 5 and 6 channels it is SLOWER and no more
         * accurate -- the sort costs more than four tetrahedral evaluations.
         * Above that it wins on speed and loses 23x to 140x on agreement with
         * the reference CMS, and loses it exactly where grid^n has forced the
         * table down to 3 or 4 points per axis. At that density, the Lab gamut
         * being a lobed solid rather than a box, nothing is recovering real
         * colour and the speed buys nothing.
         *
         * KEPT DELIBERATELY. The measurement belongs in the source rather than
         * a commit message, and a future workflow with a genuinely dense
         * n-channel table would change the arithmetic. Reachable through the
         * toggle at the top of src/kernels/nd/KernelND.js.
         *
         * @param {number[]|TypedArray} input  n channels
         * @param {object} lut
         * @returns {number[]} new array of length lut.outputChannels
         */
        simplexInterpND_NCh(input, lut) {
            const dims    = lut.inputChannels;
            const outCh   = lut.outputChannels;
            const CLUT    = lut.CLUT;
            const gPoints = lut.gridPoints;   // array [g0, g1, g2, ...]
            const scale   = lut.outputScale;
            const inScale = lut.inputScale;

            // Strides: stride[d] = product of gridPoints[d+1..dims-1] * outCh
            const stride = new Array(dims);
            stride[dims - 1] = outCh;
            for (let d = dims - 2; d >= 0; d--) {
                stride[d] = stride[d + 1] * gPoints[d + 1];
            }

            // Clamp, find lower grid index, compute fraction per dimension
            const idx = new Array(dims);
            const fx  = new Array(dims);

            for (let d = 0; d < dims; d++) {
                const v  = Math.min(1, Math.max(0, input[d] * inScale));
                const gm = gPoints[d] - 1;
                const vg = v * gm;
                idx[d]   = Math.min(Math.floor(vg), gm - 1);
                fx[d]    = vg - idx[d];
            }

            // Base offset of the [0,0,...,0] corner of the hypercell
            let base = 0;
            for (let d = 0; d < dims; d++) {
                base += idx[d] * stride[d];
            }

            // Sort dimensions by descending fraction — defines the simplex path
            const order = Array.from({length: dims}, (_, i) => i)
                .sort((a, b) => fx[b] - fx[a]);

            const result = new Array(outCh).fill(0);
            let offset = base;
            let prevFx = 1.0;

            for (let i = 0; i < dims; i++) {
                const d      = order[i];
                const weight = prevFx - fx[d];
                prevFx       = fx[d];

                for (let c = 0; c < outCh; c++) {
                    result[c] += weight * CLUT[offset + c];
                }

                offset += stride[d];
            }

            // Final corner: weight = fx[order[dims-1]]
            for (let c = 0; c < outCh; c++) {
                result[c] += prevFx * CLUT[offset + c];
            }

            for (let c = 0; c < outCh; c++) {
                result[c] *= scale;
            }

            return result;
        }

        /* ========================================================================
         *  HOT PATH — image-grade pixel loops
         * ========================================================================
         *
         *  The functions below (linearInterp1DArray_NCh_loop, bilinearInterp2D...,
         *  tetrahedralInterp3DArray_3Ch / 4Ch / NCh _loop, tetrahedralInterp4D...
         *  _loop) are the inner loops used by transformArrayViaLUT(). They are
         *  called once per IMAGE — not once per pixel — and the per-pixel loop is
         *  inside the function body. On a 4 MP image, the body runs 4,000,000
         *  times per call. Several deliberate trade-offs apply across all of
         *  them; resist the temptation to "tidy up":
         *
         *  1. NO BOUNDS CHECKS on input data.
         *     Caller guarantees a Uint8ClampedArray of well-formed pixel data
         *     (values 0..255, length === pixelCount * channelsPerPixel). Adding
         *     `if (x < 0 || x > 255)` per channel adds tens of millions of
         *     branches per image — measured to dominate runtime. If you need
         *     validation, use the per-colour `transform()` accuracy path instead.
         *
         *  2. ALL ARITHMETIC INLINED into single expressions.
         *     Saving partial results to temporary variables MEASURABLY tanks
         *     performance — both V8 and SpiderMonkey spill values to memory
         *     instead of keeping them in xmm registers between operations. The
         *     unrolled, ugly-looking single-line expressions are the fast form.
         *     See "PERFORMANCE LESSONS" comment further down in this file.
         *
         *  3. THE 6 OCTANT BRANCHES ARE FULLY UNROLLED.
         *     There are 6 nearly-identical octant blocks per function, with
         *     small inner unrolls per output channel. Combined across
         *     {3D,4D} × {3Ch,4Ch,NCh} × {single-color, _loop}, the same algorithm
         *     is duplicated ~12 times. Bug fixes must be applied to ALL copies.
         *     TODO: codegen these from a single template (see issue / TODO P7).
         *
         *  4. NO PER-PIXEL ALLOCATIONS.
         *     Output is written directly into `output[outputPos++]`. The single-
         *     colour interpolators above (e.g. tetrahedralInterp3D_3Ch) allocate
         *     a small Array per call — that's fine for the accuracy path but
         *     would dominate cost here, hence the inlined loop variants.
         *
         *  5. THE STAGE PIPELINE IS COLLAPSED INTO ONE STEP.
         *     transformArrayViaLUT does NOT walk this.pipeline per pixel; the
         *     prebuilt LUT already encodes the full pipeline including any
         *     custom stages and BPC. This is the reason this path is 20–30×
         *     faster than the accuracy path.
         *
         *  KNOWN ISSUES / TODOs in the loops below
         *  ----------------------------------------------------------------------
         *
         *   B2.  The `(input0 === 255)` upper-edge clamp is correct only for
         *        8-bit input. The planned _loop_16bit variants (currently
         *        commented-out at the routing switch in transformArrayViaLUT)
         *        will need to be `(X0 === gridEnd)` instead — same speed, type-
         *        independent. Apply to all 6 unrolled `_loop` functions when
         *        re-enabling the 16-bit path.
         *
         *   B3.  linearInterp1DArray_NCh_loop / bilinearInterp2DArray_NCh_loop /
         *        tetrahedralInterp3DArray_NCh_loop / tetrahedralInterp4DArray_NCh_loop
         *        currently DELEGATE to the single-colour interpolator and copy
         *        the result, allocating ~2 small arrays per pixel. They should
         *        be inlined the same way the 3Ch and 4Ch variants are. This is
         *        the only real Tier-A perf bug remaining; affects exotic channel
         *        counts (Gray→4ch, Duo→Nch, RGB→{2,5,6,7,8}, CMYK→Nch).
         *
         *   P4.  Each call allocates a fresh Uint8ClampedArray for the output.
         *        For real-time soft-proofing of video / repeated canvas redraws
         *        consider an optional `out` parameter on transformArrayViaLUT.
         *
         *  TESTING
         *  ----------------------------------------------------------------------
         *  If you change anything in this section, re-run BOTH:
         *      __tests__/lcms.tests.js          (numerical accuracy vs LittleCMS)
         *      speed_tests/                     (ns per pixel, before vs after)
         *  Both regress easily — small algebraic rewrites can introduce 1-LSB
         *  errors that fail the LCMS comparison, and "harmless" extracts to
         *  intermediate variables can halve throughput.
         * ========================================================================
         */

        /* ====================================================================
         * INTEGER HOT PATH KERNELS — lutMode='int' (opt-in)
         * --------------------------------------------------------------------
         * One-to-one with their float siblings above; opted into via the
         * `lutMode: 'int'` constructor option. Each variant assumes:
         *
         *   - intLut.CLUT is Uint16Array, values in [0, 65280] (= 255*256,
         *     NOT 65535 — see buildIntLut JSDoc for why; in short, the
         *     kernel's final >> 8 divides by 256 exactly, so scaling the
         *     CLUT by 256*255 makes u16/256 = u8 with no systematic bias)
         *   - intLut.gridPointsScale_fixed is Q0.16 (e.g. 8224 for g1=33,
         *     NOT 32 — the Q0.8 version truncated (g1-1)/255 enough to
         *     introduce a second int>float bias on decreasing axes)
         *   - intLut.maxX/Y/Z[/maxK] hold (g1-1)*goN for the input===255
         *     boundary patch (see bench/int_vs_float.js FINDING #2 —
         *     non-optional, fixes a corner-rounding bug)
         *   - input is u8 (Uint8ClampedArray), values 0..255
         *   - output is u8 (Uint8ClampedArray); the array's natural clamp
         *     handles any ±1 LSB rounding overshoot at corners
         *
         * Math contract:
         *   Q0.16 input scale: px = Math.imul(input, gps) is a Q8.16 value.
         *   Extract: X0 = px >>> 16, rx = (px >>> 8) & 0xFF (Q0.8).
         *
         *   Q0.8 weights (rx/ry/rz/rk in [0..255]). Per-channel:
         *     u16_out = c0 + ((sum_in_Q0.8 + 0x80) >> 8)   // round-to-nearest
         *     u8_out  = (u16_out + 0x80) >> 8
         *
         * For 4D kernels the K-axis adds one more interp pass. 4D uses a
         * u20 (Q16.4) single-rounding intermediate to avoid stacked-round
         * error — see tetrahedralInterp4DArray_3Ch_intLut_loop JSDoc.
         *
         * Result: ~1.05–1.20× in-engine speedup vs float kernel, max diff
         * **≤ 1 LSB on u8 output across all four directions** (0 LSB on
         * RGB→RGB). The residual 1 LSB is Uint8ClampedArray banker's
         * rounding disagreeing with the kernel's round-half-up at exact
         * X.5 half-ties — not interpolation error. See
         * bench/fastLUT_real_world.js (3D+4D real numbers) and
         * bench/diag_cmyk_to_rgb.js (accuracy trail for the two fixes
         * that eliminated the systematic +0.4 % bias and the Q0.8 gps
         * truncation bias).
         *
         * ⚠ DO NOT EDIT WITHOUT RUNNING THE BENCH. The hot paths are
         *   tightly tuned for V8 (Math.imul + bit shifts + monomorphic
         *   call sites) — innocent-looking changes (e.g. extracting
         *   sub-expressions to temp vars) routinely lose 10-30% perf.
         * ==================================================================== */

        /* ====================================================================
         * INTEGER HOT PATH KERNELS — lutMode='int16' (u16 I/O, v1.3 / Q0.13)
         * --------------------------------------------------------------------
         * Opted into via `lutMode: 'int16'` (auto-resolved from
         * `dataFormat: 'int16' + buildLut: true`).
         *
         * v1.3 DESIGN — TRUE 16-BIT PRECISION (Q0.13)
         * --------------------------------------------------------------------
         * An earlier "minimal u8 port" prototype (never shipped) reused the
         * u8 CLUT (scale 65280, top 255 storage values dead), used 8-bit
         * weight precision (Q0.8 → 8-bit rx), and bit-stretched the
         * [0, 65280] output to [0, 65535] at the end. That cost up to 17
         * LSB (g1=17) of identity error and produced VISIBLE BANDING — a
         * smooth u16 gradient like 12340..12349 collapsed to a single
         * output value because the 8-bit weight quantized 16 input units to
         * 1 weight step. See bench/int16_identity.js for the regression
         * demo.
         *
         * v1.3 fixes both losses with three changes (Q0.13 was reached
         * after a brief internal Q0.12 iteration during v1.3 development —
         * Q0.13 halves the Q0.12 quantization floor while still fitting
         * inside i32):
         *
         *   1. CLUT SCALE = 65535 (not 65280)
         *      Built fresh by buildIntLut() when lutMode is u16. Every
         *      Uint16Array slot is used. The corner value `c` enters the
         *      output addition `v = c + offset` at full u16 precision —
         *      no bit-stretch, no scale-mismatch rounding.
         *
         *   2. WEIGHT PRECISION = u13 (Q0.13 — was Q0.8 in the prototype)
         *      gridPointsScale_fixed_u16 is Q0.13. Per axis: rx =
         *      (input × gps) & 0x1FFF, range [0, 8191]. Bit budget proof
         *      for 3D: delta×rx max = 65535×8191 ≈ 2^29.0, sum of 3 axes
         *      ≈ 2^30.6, fits i32 with ~1.4 bits headroom. u14 rejected
         *      (sum-of-3 ≈ 2^31.6 — overflows i32 on adversarial CLUTs
         *      in WASM `i32.mul` AND in JS `Math.imul`, breaking the
         *      JS↔WASM bit-exactness contract). We are NOT an lcms clone
         *      — for true Q0.16 weight precision use lutMode='float'.
         *
         *   3. OUTPUT WRITE = `c + ((sum + 0x1000) >> 13)`
         *      Q0.13 round-to-nearest. NO bit-stretch — the CLUT already
         *      covers full u16 range, so the c-add produces u16 directly.
         *
         * Accuracy gates (run before shipping any change to these kernels):
         *
         *   1. bench/int16_identity.js — synthetic identity round-trip.
         *      g1 ∈ {17, 33, 65}: worst |in - out| ≤ 1 LSB on every axis,
         *      all grid-aligned inputs round-trip exactly. No banding.
         *      THIS IS THE GATE for kernel correctness.
         *
         *   2. bench/int16_poc/accuracy_v1_7_self.js — float-LUT-vs-int16-LUT
         *      self-delta on real ICC profiles (sRGB / GRACoL2006). Holds
         *      everything constant EXCEPT the kernel; the delta IS the
         *      Q0.13 quantization error.
         *      Result on v1.3: max 4 LSB u16 (0.006 % of range), mean
         *      ≤ 0.48 LSB u16 (≤ 0.0008 % of range), ≥ 97.7 % of channels
         *      within 1 LSB on every workflow (RGB→Lab, RGB→CMYK,
         *      CMYK→RGB, CMYK→CMYK). The filename retains its
         *      development-artifact prefix (accuracy_v1_7_self.js).
         *
         *   3. bench/int16_poc/accuracy_v1_6_vs_lcms.js — sanity check vs
         *      lcms-wasm. NOT a precision reference (the source ICC builds
         *      to different float LUTs in jsCE vs lcms), but useful for
         *      "are we in the same league?" — yes, ≥ 98 % within 256 LSB
         *      (1 LSB u8 equivalence) on every workflow.
         *
         * 4D NOTES
         * --------------------------------------------------------------------
         * The 4D u8 kernel uses a Q16.4 single-rounding intermediate
         * `o = (c << 4) + ((sum_xyz + 0x8) >> 4)` so the K-LERP can do one
         * final `>> 20`. With u13 weight on a u16 CLUT, the K-LERP term
         * `(K1 - o) × rk_u13` is s23 × u13 = s36 — overflows i32. So 4D
         * u16 uses TWO ROUNDINGS: XYZ → u16, then K-LERP `>> 13`. Worst
         * case ≤1 LSB error (vs ≤0.5 for single-rounding) — still 17×
         * better than the u8-port prototype and identity-near-exact.
         *
         * SHARED ACROSS ALL KERNELS HERE
         * --------------------------------------------------------------------
         *   - intLut.scale === 65535 (verified by isIntLutCompatible)
         *   - intLut.gridPointsScale_fixed_u16 is Q0.13
         *   - input boundary patch: input === 65535 → r* = 0, X0 = X1 = max*
         *   - Alpha: opaque marker is 0xFFFF (matches PNG-16, TIFF-16, PSD)
         *   - JS↔WASM bit-exact on synthetic inputs (asserts pass on every
         *     machine running the same JS engine; the WASM scalar + SIMD
         *     u16 kernels produce identical bytes).
         *
         * ⚠ DO NOT EDIT WITHOUT RUNNING bench/int16_identity.js — that
         *   gate is the v1.3 (Q0.13) contract. Other tests
         *   (transform_lutMode_*) verify dispatcher integration and
         *   end-to-end ICC pipelines.
         * ==================================================================== */


        tetrahedralInterp3D_NCh_F16(input16, lut){
            var rx,ry,rz;
            var X0,X1,Y0,Y1,Z0,Z1,px,py,pz, input0, input1, input2
            var base0, base1,base2, base3, base4,
                a, b, c, o

            var outputScale = lut.outputScale;
            var outputChannels = lut.outputChannels;
            var gridEnd = (lut.g1 - 1);
            var CLUT = lut.CLUT;
            var go0 = lut.go0;
            var go1 = lut.go1;
            var go2 = lut.go2;

            // We need some clipping here
            input0 = Math.min(Math.max(input16[0], 0), 0xFFFF);
            input1 = Math.min(Math.max(input16[1], 0), 0xFFFF);
            input2 = Math.min(Math.max(input16[2], 0), 0xFFFF);

            // only px needs to be a float
            px = input0 * gridEnd / 0xFFFF;
            py = input1 * gridEnd / 0xFFFF;
            pz = input2 * gridEnd / 0xFFFF;

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

            // Starting point
            base0 = X0 + Y0 + Z0;

            var output = new Array(outputChannels);

            if (rx >= ry && ry >= rz) {
                // block1
                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z0;
                base4 = X1 + Y1 + Z1;
                for(o = 0; o < outputChannels; o++){
                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    c = CLUT[base0++];
                    output[o] = (c + ((a - c) * rx) +  ((b - a) * ry) + ((CLUT[base4++] - b) * rz)) * outputScale;
                }

            } else if (rx >= rz && rz >= ry) {
                // block2

                base1 = X1 + Y0 + Z0;
                base2 = X1 + Y1 + Z1;
                base3 = X1 + Y0 + Z1;
                for(o = 0; o < outputChannels; o++){
                    a = CLUT[base3++];
                    b = CLUT[base1++];
                    c = CLUT[base0++];
                    output[o] = (c + ((b - c) * rx) + ((CLUT[base2++] - a) * ry) + ((a - b) * rz)) * outputScale;
                }

            } else if (rx >= ry && rz >= rx) {
                // block3

                base1 = X1 + Y0 + Z1;
                base2 = X0 + Y0 + Z1;
                base3 = X1 + Y1 + Z1;
                for(o = 0; o < outputChannels; o++){
                    a = CLUT[base1++];
                    b = CLUT[base2++];
                    c = CLUT[base0++];
                    output[o] = (c + ((a - b) * rx) + ((CLUT[base3++] - a) * ry) + ((b - c) * rz)) * outputScale;
                }

            } else if (ry >= rx && rx >= rz) {
                // block4

                base1 = X1 + Y1 + Z0;
                base2 = X0 + Y1 + Z0;
                base4 = X1 + Y1 + Z1;
                for(o = 0; o < outputChannels; o++){
                    a = CLUT[base2++];
                    b = CLUT[base1++];
                    c = CLUT[base0++];
                    output[o] = (c + ((b - a) * rx) + ((a - c) * ry) + ((CLUT[base4++] - b) * rz) ) * outputScale;
                }

            } else if (ry >= rz && rz >= rx) {
                // block5

                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                base3 = X0 + Y1 + Z0;
                for(o = 0; o < outputChannels; o++){
                    a = CLUT[base2++];
                    b = CLUT[base3++];
                    c = CLUT[base0++];
                    output[o] = (c + ((CLUT[base1++] - a) * rx) + ((b - c) * ry) + ((a - b) * rz)) * outputScale;
                }

            } else if (rz >= ry && ry >= rx) {
                // block6

                base1 = X1 + Y1 + Z1;
                base2 = X0 + Y1 + Z1;
                base4 = X0 + Y0 + Z1;
                for(o = 0; o < outputChannels; o++){
                    a = CLUT[base2++]
                    b = CLUT[base4++]
                    c = CLUT[base0++];
                    output[o] = (c + ((CLUT[base1++] - a) * rx) + ((a - b) * ry) + ((b - c) * rz) ) * outputScale;
                }

            } else {
                for(o = 0; o < outputChannels; o++){
                    output[o] = CLUT[base0++] * outputScale;
                }
            }

            return output;
        };


    //UPDATED
        tetrahedralInterp4D_3or4Ch_Master(input, lut){
            /**
             * For more than 3 inputs (i.e., CMYK)
             * evaluate two 3-dimensional interpolations and then linearly interpolate between them.
             */
            var K0,K1, inputK, pk, rk;
            inputK = pk = Math.max(0.0, Math.min(1.0, input[0] * lut.inputScale));

            pk = pk * (lut.g1 - 1);
            K0 = Math.floor(pk);
            rk = pk - K0;
            K1 = (inputK >= 1.0) ? K0 : K0 + 1;

            var cmyInput = [input[1], input[2], input[3]];

            var output1 = this.tetrahedralInterp3D_Master(cmyInput, lut, K0);
            // Such a small edge case where k===n/g1 perhaps faster without checking
            if(rk === 0){
                return output1;
            }
            var output2 = this.tetrahedralInterp3D_Master(cmyInput, lut, K1);

            // interpolate two results
            // Note that tetrahedralInterp3D already applies the output scale
            output1[0] = output1[0] + (( output2[0] - output1[0] ) * rk);
            output1[1] = output1[1] + (( output2[1] - output1[1] ) * rk);
            output1[2] = output1[2] + (( output2[2] - output1[2] ) * rk);
            if(lut.outputChannels === 3){
                return output1;
            }
            output1[3] = output1[3] + (( output2[3] - output1[3] ) * rk);
            return output1;
        };

        // todo - tetrahedralInterp5D, tetrahedralInterp6D ....
        /**
         * Generic tetrahedral 4D interpolation for 3D LUTs
         * @param input
         * @param lut
         * @returns {*}
         */
        //UPDATED
        tetrahedralInterp4D_3or4Ch(input, lut){
            /**
             * For more than 3 inputs (i.e., CMYK)
             * evaluate two 3-dimensional interpolations and then linearly interpolate between them.
             */
            var K0,K1, inputK, pk, rk;
            inputK = pk = Math.max(0.0, Math.min(1.0, input[0] * lut.inputScale));

            pk = pk * (lut.g1 - 1);
            K0 = Math.floor(pk);
            rk = pk - K0;
            K1 = (inputK >= 1.0) ? K0 : K0 + 1;

            var cmyInput = [input[1], input[2], input[3]];

            var output1 = this.tetrahedralInterp3D_3or4Ch(cmyInput, lut, K0);
            // Such a small edge case where k===n/g1 perhaps faster without checking
            if(rk === 0){
                return output1;
            }
            var output2 = this.tetrahedralInterp3D_3or4Ch(cmyInput, lut, K1);

            // interpolate two results
            // Note that tetrahedralInterp3D already applies the output scale
            output1[0] = output1[0] + (( output2[0] - output1[0] ) * rk);
            output1[1] = output1[1] + (( output2[1] - output1[1] ) * rk);
            output1[2] = output1[2] + (( output2[2] - output1[2] ) * rk);
            if(lut.outputChannels === 3){
                return output1;
            }
            output1[3] = output1[3] + (( output2[3] - output1[3] ) * rk);
            return output1;
        };
    }

var _exports = {};
Object.getOwnPropertyNames(_TransformInterp.prototype).forEach(function(name){
    if (name !== 'constructor') _exports[name] = _TransformInterp.prototype[name];
});
module.exports = _exports;
