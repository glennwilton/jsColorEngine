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

    var convert = require('./convert');
    var defs = require('./def');

    var eColourType = defs.eColourType;
    var illuminant = defs.illuminant;

    function roundN(n, places) {
        var p = Math.pow(10, places)
        return Math.round(n * p) / p;
    }

    /**
     * Stage functions for Transform — moved VERBATIM from src/Transform.js
     * (v1.5.5 split). Every method here was a Transform class method; they are
     * re-attached to Transform.prototype (non-enumerable) at the bottom of
     * Transform.js, so `this` is the Transform instance exactly as before and
     * every call site (createPipeline_* builders, addStage, compile()) is
     * unchanged.
     *
     * Contents: the ~100 stage_* pipeline functions, their compile()-time
     * emit_js_* / attachStore_js_* emitters (kept co-located so a stage and
     * its emitter drift together — they split out to a stage2code module only
     * when the v1.7 compiled-pipeline work needs it), and the colour/matrix
     * helpers the stages call (XYZ/Lab constructors, evalMatrix,
     * invertMatrix, gamma table builders).
     *
     * Do NOT "clean up" or restructure these bodies — see the PERFORMANCE
     * LESSONS block in src/Transform.js. The class wrapper below exists only
     * so the methods stay byte-for-byte identical to their original class-
     * body syntax (object literals would need comma separators).
     */
    class _TransformStages {
        stage_debug(data, label){
            var lastData = null;
            this.addDebugHistory(label, 'stage_debug', lastData, data);
            return data;
        };

        // Compile-time emitter for stage_debug. The pipeline's auto-inserted
        // 'Start' and 'END' markers are also stage_debug (just with different
        // stageNames — see addStage() calls in create() when pipelineDebug is
        // on). compile() routes any stage whose .funct === stage_debug here,
        // so there's a single place to control debug emission.
        //
        // For these stages the human-readable label is passed via stageData
        // (NOT debugFormat) — that's how stage_debug's runtime signature
        // works: stage_debug(data, label) where 'label' is the stageData arg.
        emit_js_stage_debug(index, stage){
            var name  = (stage && stage.stageName) ? stage.stageName : 'stage_debug';
            var label = '';
            if (stage) {
                if (typeof stage.stageData === 'string')   label = stage.stageData;
                else if (typeof stage.debugFormat === 'string') label = stage.debugFormat;
            }
            // The runtime substitutes {data}/{name}/etc. into the format; at
            // compile time we just want a clean single-line breadcrumb.
            var hint = label.replace(/\{[a-z]+\}/gi, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
            if (hint.length > 0) {
                return '// debug marker (' + name + '): ' + hint + ' — compile-time no-op';
            }
            return '// debug marker (' + name + ') — compile-time no-op';
        }

        addDebugHistory(label, stageName, lastData, data){

            if(label.indexOf('{name}') >= 0 ){
                label = label.replace('{name}', stageName );
            }

            var parts = label.split('{');

            for(var i =1 ; i < parts.length ; i++){
                var temp = parts[i].split('}');
                var format = temp[0].split(':');

                switch(format[0].toLowerCase()){
                    case 'last':
                        temp[0] = data2String(lastData, format[1], this.debugHistoryDecimals);
                        break;
                    case 'data':
                        temp[0] = data2String(data, format[1], this.debugHistoryDecimals);
                        break;
                }
                parts[i] = temp.join('');
            }
            this.debugHistory.push(parts.join(''));
        };

        stage_null(input){
            return input;
        };

        emit_js_stage_null(index, stage){
            return '';
        }

        stage_history(input, info){

            // Add the info to the history
            this.debugHistory.push(info);

            return input;
        };

        // Compile-time emitter for stage_history. Like stage_debug, this is a
        // pure side-effect stage at runtime (writes to this.debugHistory and
        // returns input unchanged) — so it compiles to a no-op comment carrying
        // the human-readable info string for source readability.
        //
        // The info string is passed as stageData (see runtime stage_history
        // signature: stage_history(input, info)). compile() routes any stage
        // whose .funct === stage_history here, so this fires for every name
        // injected by addStage(_, '<name>', this.stage_history, '<info>', _).
        emit_js_stage_history(index, stage){
            var name  = (stage && stage.stageName) ? stage.stageName : 'stage_history';
            var info  = '';
            if (stage && typeof stage.stageData === 'string') info = stage.stageData;
            // Collapse whitespace and trim long info strings so the comment
            // stays single-line in the dumped source.
            var hint = info.replace(/\s+/g, ' ').trim();
            if (hint.length > 120) hint = hint.slice(0, 117) + '...';
            if (hint.length > 0) {
                return '// history marker (' + name + '): ' + hint + ' — compile-time no-op';
            }
            return '// history marker (' + name + ') — compile-time no-op';
        }

        ////////////////////////////////////////////////////////////////////////////////
        //
        //  Stages for Gray Data
        //

        stage_device_to_Gray(device){
            return {
                G: (device[0] * 255),
                type: eColourType.Gray
            };
        };

        emit_js_stage_device_to_Gray(index, stage){
            return `return {\n` +
                        `G: (device[0] * 255),\n` +
                        `type: eColourType.Gray\n` +
                    `}\n`
        };

        stage_device_to_Grayf(device){
            return {
                Gf: device[0],
                type: eColourType.Grayf
            };
        };

        emit_js_stage_device_to_Grayf(index, stage){
            return `return {\n` +
                `Gf: device[0],\n` +
                `type: eColourType.Grayf\n` +
                `}\n`
        };

        stage_device_to_Gray_round(device, precision){
            return {
                G: roundN(device[0] * 255, precision),
                type: eColourType.Gray
            };
        };

        emit_js_stage_device_to_Gray_round(index, stage){
            return `return {\n` +
                `G: Math.round(device[0] * 255 * pp) / pp,\n` +
                `type: eColourType.Gray\n` +
                `}\n`
        };

        /**
         * @param { _cmsGray } cmsGray
         * @returns {_Device}
         */
        stage_Gray_to_Device(cmsGray){
            if(cmsGray.type === eColourType.Gray) {
                return [cmsGray.G / 255]
            }
            throw 'stage_Gray_to_Device: cmsInput expects _cmsGray';
        };

        emit_js_stage_Gray_to_Device(index, stage){
            return `return [G / 255]\n`
        };


        ////////////////////////////////////////////////////////////////////////////////
        //
        //  Stages for Duotone (2 colour) Data
        //


        stage_device_to_Duo(device){
            return {
                a: (device[0] * 100),
                b: (device[1] * 100),
                type: eColourType.Duo
            };
        };

        emit_js_stage_device_to_Duo(index, stage){
            return `return {\n` +
                `a: (device[0] * 100),\n` +
                `a: (device[1] * 100),\n` +
                `type: eColourType.Duo\n` +
                `}\n`
        };

        stage_device_to_Duof(device){
            return {
                af: device[0],
                bf: device[1],
                type: eColourType.Duof
            };
        };

        stage_device_to_Duo_round(device, precision){
            return {
                a: roundN(device[0] * 100, precision),
                b: roundN(device[1] * 100, precision),
                type: eColourType.Duo
            };
        };

        /**
         * @param { _cmsDuo  |  _cmsDuof} cmsDuo
         * @returns {_Device}
         */
        stage_Duo_to_Device(cmsDuo){
            if(cmsDuo.type === eColourType.Duo) {
                return [cmsDuo.a / 100, cmsDuo.b / 100]
            } else if(cmsDuo.type === eColourType.Duof) {
                return [cmsDuo.af, cmsDuo.bf]
            }
            throw 'stage_Duo_to_Device: cmsInput expects _cmsDuo';
        };

        ////////////////////////////////////////////////////////////////////////////////
        //
        //  Stages for RGB Data
        //

        stage_device_to_RGB(device){
            return {
                R: (device[0] * 255),
                G: (device[1] * 255),
                B: (device[2] * 255),
                type: eColourType.RGB
            };
        };

        stage_device_to_RGB_round(device, precision){
            return {
                R: roundN(device[0] * 255, precision),
                G: roundN(device[1] * 255, precision),
                B: roundN(device[2] * 255, precision),
                type: eColourType.RGB
            };
        };

        stage_device_to_RGBf(device){
            return {
                Rf: device[0],
                Gf: device[1],
                Bf: device[2],
                type: eColourType.RGBf
            };
        };

        /**
         * @param {_cmsRGB | _cmsRGBf} cmsRGB
         * @returns {_Device}
         */
        stage_RGB_to_Device(cmsRGB){
            if(cmsRGB.type === eColourType.RGB) {
                return [cmsRGB.R / 255, cmsRGB.G / 255, cmsRGB.B / 255]
            }
            if(cmsRGB.type === eColourType.RGBf) {
                return [cmsRGB.Rf, cmsRGB.Gf, cmsRGB.Bf]
            }
            throw 'InputtoPCS: cmsInput is not of type RGB or RGBf';
        };




        ////////////////////////////////////////////////////////////////////////////////
        //
        //   Stages for CMYK Data
        //

        stage_device_to_CMYKf(device){
            return {
                Cf: device[0],
                Mf: device[1],
                Yf: device[2],
                Kf: device[3],
                type: eColourType.CMYKf
            };
        };

        stage_device_to_CMYK(device){
            return {
                C: (device[0] * 100),
                M: (device[1] * 100),
                Y: (device[2] * 100),
                K: (device[3] * 100),
                type: eColourType.CMYK
            };
        };

        stage_device_to_CMYK_round(device, precision){
            return { //  * 0.0015259021896696422
                C: roundN(device[0] * 100, precision),
                M: roundN(device[1] * 100, precision),
                Y: roundN(device[2] * 100, precision),
                K: roundN(device[3] * 100, precision),
                type: eColourType.CMYK
            };
        };

        /**
         * @param {_cmsCMYK |_cmsCMYKf } cmsCMYK
         * @returns {_Device}
         */
        stage_CMYK_to_Device(cmsCMYK){
            if(cmsCMYK.type === eColourType.CMYK) {
                return [cmsCMYK.C / 100, cmsCMYK.M / 100, cmsCMYK.Y / 100, cmsCMYK.K / 100]
            }
            if(cmsCMYK.type === eColourType.CMYKf) {
                return [cmsCMYK.Cf , cmsCMYK.Mf , cmsCMYK.Yf, cmsCMYK.Kf]
            }
            throw 'stage_CMYK_to_Device: cmsInput expects _cmsCMYK or _cmsCMYKf ';
        };

        /**
         * N-channel (5CLR-15CLR) input stage — there is no named colour object
         * for 5+ channels, so accept either a plain device array (0..1) or a
         * {c0: v, c1: v, ...} object (per docs/NChannel.md usage).
         */
        stage_NCh_to_Device(input){
            if(Array.isArray(input) || ArrayBuffer.isView(input)){
                return Array.prototype.slice.call(input);
            }
            if(input && typeof input === 'object'){
                var arr = [];
                for(var i = 0; typeof input['c' + i] === 'number'; i++){
                    arr.push(input['c' + i]);
                }
                if(arr.length > 0){
                    return arr;
                }
            }
            throw 'stage_NCh_to_Device: expects a device array (0..1) or a {c0..cN} object';
        };

        /**
         * Generic N-channel integer input stage — sibling of stage_Int_to_Device
         * (which is unrolled for 3/4 channels) for arbitrary channel counts.
         */
        stage_IntN_to_Device(data, intScale){
            var out = new Array(data.length);
            for(var i = 0; i < data.length; i++){
                out[i] = data[i] / intScale;
            }
            return out;
        };

        /**
         * N-channel output stage — returns a copy of the device array (0..1).
         * The copy prevents downstream mutation aliasing (same contract as
         * stage_device2device).
         */
        stage_device_to_NCh(deviceArray){
            return Array.prototype.slice.call(deviceArray);
        };

        ////////////////////////////////////////////////////////////////////////////////
        //
        //
        //                     Stages for  Int Data
        //
        //

        stage_device1_to_int(device, intSize){
            return [
                Math.round(device[0] * intSize)
            ];
        };

        stage_device2_to_int(device, intSize){
            return [
                Math.round(device[0] * intSize),
                Math.round(device[1] * intSize),
            ];
        };


        stage_device3_to_int(device, intSize){
            return [
                Math.round(device[0] * intSize),
                Math.round(device[1] * intSize),
                Math.round(device[2] * intSize)
            ];
        };

        stage_device4_to_int(device, intSize){
            return [
                Math.round(device[0] * intSize),
                Math.round(device[1] * intSize),
                Math.round(device[2] * intSize),
                Math.round(device[3] * intSize),
            ];
        };


        /**
         *
         * @param {array} device
         * @param {number} intSize  255 || 65535
         */
        stage_deviceN_to_int(device, intSize){

            //todo - Impliment a dithering method for 8bit output
            var output = new Array(device.length);
            for(var i = 0; i < device.length; i++){
                output[i] = Math.round(device[i] * intSize);
            }
            return output;
        };

        stage_Int_to_Device(data, intScale){
            if(data.length === 3){
                return [
                    data[0] / intScale,
                    data[1] / intScale,
                    data[2] / intScale
                ]
            }
            return [
                data[0] / intScale,
                data[1] / intScale,
                data[2] / intScale,
                data[3] / intScale
            ]
        };

        XYZ(X, Y, Z){
            return {
                type: eColourType.XYZ,
                X:X,
                Y:Y,
                Z:Z,
            };
        };


        Lab(L, a, b, whitePoint){
            return {
                type: eColourType.Lab,
                L: L,
                a: a,
                b: b,
                whitePoint: whitePoint || illuminant.d50
            };
        }

        XYZ2Lab (XYZ, whitePoint){
            var limit = (24.0/116.0) * (24.0/116.0) * (24.0/116.0)
            whitePoint = whitePoint || illuminant.d50;

            var fx = (XYZ.X / whitePoint.X);
            var fy = (XYZ.Y / whitePoint.Y);
            var fz = (XYZ.Z / whitePoint.Z);

            fx = (fx <= limit) ? ((841.0/108.0) * fx) + (16.0/116.0) : Math.pow(fx, 1.0/3.0);
            fy = (fy <= limit) ? ((841.0/108.0) * fy) + (16.0/116.0) : Math.pow(fy, 1.0/3.0);
            fz = (fz <= limit) ? ((841.0/108.0) * fz) + (16.0/116.0) : Math.pow(fz, 1.0/3.0);

            return {
                L: 116.0 * fy - 16.0,
                a: 500.0 * (fx - fy),
                b: 200.0 * (fy - fz),
                whitePoint: whitePoint,
                type: eColourType.Lab
            }

        }

        Lab2XYZ (Lab, whitePoint){
            whitePoint = whitePoint || Lab.whitePoint || illuminant.d50;
            var limit = (24.0/116.0);

            var y = (Lab.L + 16.0) / 116.0;
            var x = y + 0.002 * Lab.a;
            var z = y - 0.005 * Lab.b;

            return {
                X: (x <= limit ? (108.0/841.0) * (x - (16.0/116.0)) : x*x*x) * whitePoint.X,
                Y: (y <= limit ? (108.0/841.0) * (y - (16.0/116.0)) : y*y*y) * whitePoint.Y,
                Z: (z <= limit ? (108.0/841.0) * (z - (16.0/116.0)) : z*z*z) * whitePoint.Z,
                type: eColourType.XYZ
            }
        }

        Lab2PCSv4(labD50){
            return [
                labD50.L / 100,
                (labD50.a + 128)/255,
                (labD50.b + 128)/255
            ];
        };


        Lab2PCSv2(labD50){
            return [
                labD50.L * 652.80 / 65535.0,
                (labD50.a + 128) * 256 / 65535.0,
                (labD50.b + 128) * 256 / 65535.0
            ];
        };

        RGBDevice_to_PCSv4_or_LabD50(device, RGBProfile, asLab, adaptation){
            // Gamma correction
            var R,G,B, matrix, d, d0,d1,d2;

            if(RGBProfile.rgb.rTRC && RGBProfile.rgb.rTRC.use){
                d = this.stage_curves_v4(device, [RGBProfile.rgb.rTRC, RGBProfile.rgb.rTRC, RGBProfile.rgb.rTRC]);
                d0 = d[0];
                d1 = d[1];
                d2 = d[2];
            } else {
                d0 = Math.min(Math.max(device[0], 0.0), 1.0);
                d1 = Math.min(Math.max(device[1], 0.0), 1.0);
                d2 = Math.min(Math.max(device[2], 0.0), 1.0);
            }

            if (RGBProfile.RGBMatrix.issRGB){
                R = convert.sRGBGamma(d0);
                G = convert.sRGBGamma(d1);
                B = convert.sRGBGamma(d2);
            } else {
                var gamma= 1 / RGBProfile.RGBMatrix.gamma;
                R = Math.pow(d0, gamma);
                G = Math.pow(d1, gamma);
                B = Math.pow(d2, gamma);
            }

            if(adaptation){
                // whitespace adaptaton
                matrix = RGBProfile.RGBMatrix.matrixV4;
            } else {
                matrix = RGBProfile.RGBMatrix.XYZMatrix;
            }

            var XYZ = {
                X: R * matrix.m00 + G * matrix.m01 + B * matrix.m02,
                Y: R * matrix.m10 + G * matrix.m11 + B * matrix.m12,
                Z: R * matrix.m20 + G * matrix.m21 + B * matrix.m22
            };

            if(adaptation) {
                // XYZ are now set, but may need chromatic adaptation
                var destWhitePoint = this.d50;
                    if (!this.compareWhitePoints(destWhitePoint, RGBProfile.mediaWhitePoint)) {
                    XYZ = convert.adaptation(XYZ, RGBProfile.mediaWhitePoint, destWhitePoint);
                }
            }

            if(asLab){
                return this.XYZ2Lab(XYZ, illuminant.d50);
            }

            var lab= this.XYZ2Lab(XYZ, illuminant.d50);

            return [
                lab.L / 100,
                (lab.a + 128)/255,
                (lab.b + 128)/255
            ]
        }

        PCSv4_to_RGBDevice(PCSv4, RGBProfile, adaptation){

            var XYZ = this.Lab2XYZ({
                L:PCSv4[0] * 100,
                a:((PCSv4[1] * 255) - 128.0),
                b: ((PCSv4[2] * 255) - 128.0),
            }, illuminant.d50);
            var R, G, B, matrixInv;

            if(adaptation){
                var whitePoint = illuminant.d50;
                // whitespace adaptaton, Note that there is a tolerance
                if(!convert.compareWhitePoints(whitePoint, RGBProfile.mediaWhitePoint)){
                    XYZ = convert.adaptation(XYZ, whitePoint, RGBProfile.mediaWhitePoint);
                }

                // XYZ to RGB
                matrixInv = RGBProfile.RGBMatrix.matrixInv;
            } else {
                matrixInv= RGBProfile.RGBMatrix.XYZMatrixInv;
            }

            R = XYZ.X * matrixInv.m00 + XYZ.Y * matrixInv.m01 + XYZ.Z * matrixInv.m02;
            G = XYZ.X * matrixInv.m10 + XYZ.Y * matrixInv.m11 + XYZ.Z * matrixInv.m12;
            B = XYZ.X * matrixInv.m20 + XYZ.Y * matrixInv.m21 + XYZ.Z * matrixInv.m22;

            if(RGBProfile.rgb.rTRCInv && RGBProfile.rgb.rTRCInv.use){
                return this.stage_curves_v4([R, G, B], [RGBProfile.rgb.rTRCInv, RGBProfile.rgb.rTRCInv, RGBProfile.rgb.rTRCInv]);
            }

            R = Math.min(Math.max(R, 0.0), 1.0);
            G = Math.min(Math.max(G, 0.0), 1.0);
            B = Math.min(Math.max(B, 0.0), 1.0);

            if(RGBProfile.RGBMatrix.issRGB){
                return [
                    convert.sRGBGammaInv(R),
                    convert.sRGBGammaInv(G),
                    convert.sRGBGammaInv(B)
                ];
            } else {
                return [
                    Math.pow(R,RGBProfile.RGBMatrix.gamma),
                    Math.pow(G,RGBProfile.RGBMatrix.gamma),
                    Math.pow(B,RGBProfile.RGBMatrix.gamma)
                ];
            }
        };

        /**
         * Note - That due to the way LitteCMS rounds numbers internally some of the values
         * are not exactly the same as the values output by LittleCMS
         * @param device
         * @param data
         * @returns {number[]}
         * @constructor
         */
        RGBDevice_to_RGBDevice(device, data){

            var Ro,Go,Bo, matrix, igamma;
            var Ri, Gi, Bi;

            if(data.input.curvesInv){
                var d = this.stage_curves_v4(device, data.output.curvesInv);
                Ri = d[0];
                Gi = d[1];
                Bi = d[2];
            } else {
                if (data.input.issRGB){
                    Ri = convert.sRGBGammaInv(device[0]);
                    Gi = convert.sRGBGammaInv(device[1]);
                    Bi = convert.sRGBGammaInv(device[2]);
                } else {
                    igamma = data.input.gamma;
                    Ri = Math.pow(device[0], igamma);
                    Gi = Math.pow(device[1], igamma);
                    Bi = Math.pow(device[2], igamma);
                }
            }

            matrix = data.matrix;
            Ro = Ri * matrix.m00 + Gi * matrix.m01 + Bi * matrix.m02;
            Go = Ri * matrix.m10 + Gi * matrix.m11 + Bi * matrix.m12;
            Bo = Ri * matrix.m20 + Gi * matrix.m21 + Bi * matrix.m22;

            // Some clipping
            Ro = Math.min(Math.max(Ro, 0.0), 1.0);
            Go = Math.min(Math.max(Go, 0.0), 1.0);
            Bo = Math.min(Math.max(Bo, 0.0), 1.0);

            // Gamma
            if(data.output.curves){
                return this.stage_curves_v4([Ro, Go, Bo], data.output.curves);
            }

            if(data.output.issRGB){
                return [
                    convert.sRGBGamma(Ro),
                    convert.sRGBGamma(Go),
                    convert.sRGBGamma(Bo)
                ]
            }
            return [
                Math.pow(Ro, 1 / data.output.gamma),
                Math.pow(Go, 1 / data.output.gamma),
                Math.pow(Bo, 1 / data.output.gamma)
            ];
        }

        // ── Gamma LUT helpers ────────────────────────────────────────────────────

        /**
         * Generic 1D per-channel LUT stage.  Replaces stage_Gamma and
         * stage_Gamma_Inverse when useCurveLut is true.  One array access per
         * channel — no Math.pow per pixel.
         * stageData = { lut: Float64Array(4096), lutMax: 4095 }
         */
        stage_gammaTable(device, data){
            var lut    = data.lut;
            var lutMax = data.lutMax;
            return [
                lut[(device[0] * lutMax + 0.5) | 0],
                lut[(device[1] * lutMax + 0.5) | 0],
                lut[(device[2] * lutMax + 0.5) | 0],
            ];
        }

        /**
         * Build a 4096-entry inverse-gamma LUT (non-linear → linear).
         * Extracted from attachStore_js_stage_Gamma_Inverse — same 4096 size,
         * same sRGB piecewise / power-curve logic.
         */
        _buildGammaInvLut(data, lutSize){
            var N   = lutSize || 4096;
            var lut = new Float64Array(N);
            if(data.issRGB){
                for(var i = 0; i < N; i++){
                    var x = i / (N - 1);
                    lut[i] = (x <= 0.04045) ? (x / 12.92) : Math.pow((x + 0.055) / 1.055, 2.4);
                }
            } else {
                var gamma = data.gamma;
                for(var j = 0; j < N; j++){
                    lut[j] = Math.pow(j / (N - 1), gamma);
                }
            }
            return { lut: lut, lutMax: N - 1 };
        }

        /**
         * Build a 4096-entry forward-gamma LUT (linear → non-linear).
         * Mirror of _buildGammaInvLut for the output encode direction.
         */
        _buildGammaFwdLut(data, lutSize){
            var N   = lutSize || 4096;
            var lut = new Float64Array(N);
            if(data.issRGB){
                for(var i = 0; i < N; i++){
                    var x = i / (N - 1);
                    lut[i] = (x <= 0.0031308) ? (x * 12.92) : (1.055 * Math.pow(x, 1 / 2.4) - 0.055);
                }
            } else {
                var gammaInv = 1 / data.gamma;
                for(var j = 0; j < N; j++){
                    lut[j] = Math.pow(j / (N - 1), gammaInv);
                }
            }
            return { lut: lut, lutMax: N - 1 };
        }

        stage_Gamma(device, data){
            var i0 = Math.min(Math.max(device[0], 0.0), 1.0);
            var i1 = Math.min(Math.max(device[1], 0.0), 1.0);
            var i2 = Math.min(Math.max(device[2], 0.0), 1.0);

            if(data.issRGB){
                return [
                    convert.sRGBGamma(i0),
                    convert.sRGBGamma(i1),
                    convert.sRGBGamma(i2)
                ]
            }
            return [
                Math.pow(i0,1 / data.gamma),
                Math.pow(i1,1 / data.gamma),
                Math.pow(i2,1 / data.gamma)
            ]
        }

        stage_Gamma_Inverse(device, data){
            var i0 = Math.min(Math.max(device[0], 0.0), 1.0);
            var i1 = Math.min(Math.max(device[1], 0.0), 1.0);
            var i2 = Math.min(Math.max(device[2], 0.0), 1.0);

            if(data.issRGB){
                return [
                    convert.sRGBGammaInv(i0),
                    convert.sRGBGammaInv(i1),
                    convert.sRGBGammaInv(i2)
                ]
            }

            return [
                Math.pow(i0, data.gamma),
                Math.pow(i1, data.gamma),
                Math.pow(i2, data.gamma)
            ]
        }

        // Compiled-pipeline POC: device-RGB clamp + inverse TRC.
        // In: r, g, b   Out: r, g, b   (in-place)
        //
        // Two emit modes (useGammaLUT defaults TRUE — see compile() JSDoc):
        //   useGammaLUT:true    4096-entry float LUT lookup attached to store —
        //                       this is the standard CMS curve-optimization
        //                       trick. lcms's cmsopt.c does the exact same
        //                       thing as its default fast path
        //                       (PRELINEARIZATION_POINTS = 4096), and lcms's
        //                       fast_float plugin classifies the accuracy as
        //                       "about 32 bits" — same trade-off, same
        //                       industry consensus.
        //   useGammaLUT:false   bit-exact `Math.pow` (or piecewise sRGB) —
        //                       opt-in for measurement-grade work where the
        //                       ~32-bit float ceiling isn't acceptable
        //                       (oracle generation, bit-for-bit cross-checks).
        attachStore_js_stage_Gamma_Inverse(store, index, stage, compileOptions){
            if (!compileOptions || !compileOptions.useGammaLUT) return;
            var data = stage.stageData;
            // 4096 entries to match lcms2/src/cmsopt.c #define PRELINEARIZATION_POINTS 4096.
            var N = 4096;
            var lut = new Float64Array(N);
            if (data.issRGB) {
                for (var i = 0; i < N; i++) {
                    var x = i / (N - 1);
                    lut[i] = (x <= 0.04045) ? (x / 12.92) : Math.pow((x + 0.055) / 1.055, 2.4);
                }
            } else {
                var g = data.gamma;
                for (var j = 0; j < N; j++) {
                    var y = j / (N - 1);
                    lut[j] = Math.pow(y, g);
                }
            }
            store['s' + index + '_gammaLut'] = lut;
            store['s' + index + '_gammaLutMax'] = N - 1;
        }

        emit_js_stage_Gamma_Inverse(index, stage, store, compileOptions){
            var data = stage.stageData;
            var useLUT = !!(compileOptions && compileOptions.useGammaLUT);
            var lines = [];
            lines.push('{');
            lines.push('  let _r = r < 0 ? 0 : (r > 1 ? 1 : r);');
            lines.push('  let _g = g < 0 ? 0 : (g > 1 ? 1 : g);');
            lines.push('  let _b = b < 0 ? 0 : (b > 1 ? 1 : b);');
            if (useLUT) {
                // LUT path — standard CMS curve-optimization, default-on.
                // The table baked by attachStore_js_stage_Gamma_Inverse already
                // encodes either the sRGB piecewise inverse or the plain power
                // curve, so this emit stays curve-agnostic. We use a truncating
                // `| 0` index (no rounding) and let LUT density (4096 entries,
                // matching lcms2 PRELINEARIZATION_POINTS) carry the accuracy.
                // Per lcms's own fast_float plugin classification: "Precision
                // is about 32 bits" — well below 1 code value at u8 / u16
                // output.
                var lutVar = '_gl' + index;
                var maxIdx = (store['s' + index + '_gammaLutMax']);
                lines.push('  // LUT-based inverse gamma — issRGB=' + (!!data.issRGB) + ', gamma=' + data.gamma + ' (4096-entry table, ~32-bit precision per lcms convention)');
                lines.push('  const ' + lutVar + ' = store.s' + index + '_gammaLut;');
                lines.push('  r = ' + lutVar + '[(_r * ' + maxIdx + ') | 0];');
                lines.push('  g = ' + lutVar + '[(_g * ' + maxIdx + ') | 0];');
                lines.push('  b = ' + lutVar + '[(_b * ' + maxIdx + ') | 0];');
            } else if (data.issRGB) {
                // sRGB piecewise inverse — bit-exact with convert.sRGBGammaInv.
                lines.push('  r = _r <= 0.04045 ? _r / 12.92 : Math.pow((_r + 0.055) / 1.055, 2.4);');
                lines.push('  g = _g <= 0.04045 ? _g / 12.92 : Math.pow((_g + 0.055) / 1.055, 2.4);');
                lines.push('  b = _b <= 0.04045 ? _b / 12.92 : Math.pow((_b + 0.055) / 1.055, 2.4);');
            } else {
                // Plain power gamma. Bake exponent as a numeric literal.
                lines.push('  r = Math.pow(_r, ' + data.gamma + ');');
                lines.push('  g = Math.pow(_g, ' + data.gamma + ');');
                lines.push('  b = Math.pow(_b, ' + data.gamma + ');');
            }
            lines.push('}');
            return lines.join('\n');
        }

        //m[row][column]
        //  00   01    02
        //  10   11    12
        //  20   21    22
        stage_matrix_rgb(device, matrix){
            var i0, i1, i2;
            var o0, o1, o2
            i0 = device[0]
            i1 = device[1]
            i2 = device[2]

            o0 = i0 * matrix.m00 + i1 * matrix.m01 + i2 * matrix.m02;
            o1 = i0 * matrix.m10 + i1 * matrix.m11 + i2 * matrix.m12;
            o2 = i0 * matrix.m20 + i1 * matrix.m21 + i2 * matrix.m22;

            return [o0, o1, o2];
        }

        // Compiled-pipeline POC: 3x3 RGB→PCSXYZ matrix.
        // In: r, g, b   Out: X, Y, Z
        // Coefficients baked as numeric literals so V8 folds them into the
        // emitted machine code; no per-pixel object property lookups.
        emit_js_stage_matrix_rgb(index, stage){
            var m = stage.stageData;
            var lines = [];
            lines.push('{');
            lines.push('  let _r = r, _g = g, _b = b;');
            lines.push('  X = _r * ' + m.m00 + ' + _g * ' + m.m01 + ' + _b * ' + m.m02 + ';');
            lines.push('  Y = _r * ' + m.m10 + ' + _g * ' + m.m11 + ' + _b * ' + m.m12 + ';');
            lines.push('  Z = _r * ' + m.m20 + ' + _g * ' + m.m21 + ' + _b * ' + m.m22 + ';');
            lines.push('}');
            return lines.join('\n');
        }

        stage_chromaticAdaptation(PCSXYZ, data){
            var XYZ = this.XYZ(
                PCSXYZ[0] * 1.999969482421875,
                PCSXYZ[1] * 1.999969482421875,
                PCSXYZ[2] * 1.999969482421875
            );

            XYZ = convert.adaptation(XYZ, data.inWhitePoint, data.outWhitePoint);

            return [
                XYZ.X / 1.999969482421875,
                XYZ.Y / 1.999969482421875,
                XYZ.Z / 1.999969482421875
            ]
        }

        ////////////////////////////////////////////////////////////////////////////////
        //
        //
        //                   Stages for Absolute Adaptation
        //
        //

        stage_absoluteAdaptationIn_PCSXYZ_to_PCSXYZ(pcsXYZ, profile){
            return [
                pcsXYZ[0] *= profile.absoluteAdaptationIn.Xa,
                pcsXYZ[1] *= profile.absoluteAdaptationIn.Ya,
                pcsXYZ[2] *= profile.absoluteAdaptationIn.Za
            ];
        };

        stage_absoluteAdaptationOut_PCSXYZ_to_PCSXYZ (pcsXYZ, profile){
            return [
                pcsXYZ[0] *= profile.absoluteAdaptationOut.Xa,
                pcsXYZ[1] *= profile.absoluteAdaptationOut.Ya,
                pcsXYZ[2] *= profile.absoluteAdaptationOut.Za
            ];
        };

        ////////////////////////////////////////////////////////////////////////////////
        //
        //  Stage for Black Point Compensation
        //

        stage_ApplyBPCScale_PCSXYZ_to_PCSXYZ(PCSXYZ, BPC){
            return [
                ((BPC.scale.X * (PCSXYZ[0] * 1.999969482421875)) + BPC.offset.X) / 1.999969482421875,
                ((BPC.scale.Y * (PCSXYZ[1] * 1.999969482421875)) + BPC.offset.Y) / 1.999969482421875,
                ((BPC.scale.Z * (PCSXYZ[2] * 1.999969482421875)) + BPC.offset.Z) / 1.999969482421875
            ]
        };


        ////////////////////////////////////////////////////////////////////////////////
        //
        //  Stages for converting Mono to PCS without a lut
        //

        stage_grayTRC_to_PCSXYZ_Via_Y(input, curves ){
            var n = this.stage_curves_v4([input[0]], curves)[0];

            return [
                illuminant.d50.X * n / 1.999969482421875,
                illuminant.d50.Y * n / 1.999969482421875,
                illuminant.d50.Z * n / 1.999969482421875,
            ];
        };

        stage_grayTRC_to_PCSV4_Via_L(input, curves ){
            return [
                this.stage_curves_v4([input[0]], curves)[0],
                0.5,
                0.5
            ];
        };

        stage_PCSXYZ_to_grayTRC_via_Y(pcsXYZ, invCurves ){
            var X = pcsXYZ[1] * 1.999969482421875; // grab the XYZ Y value
            return [
                this.stage_curves_v4([X], invCurves)[0],
            ];
        };

        stage_PCSV4_to_grayTRC_via_L(pcslab, invCurves ){
            var L = pcslab[0];
            return [
                this.stage_curves_v4([L], invCurves)[0],
            ];
        };

        ////////////////////////////////////////////////////////////////////////////////
        //
        //  Stage for Convert between PCS
        //

        stage_PCSv4_to_PCSv2(pcsLab){
            // 0x8000 / 0x8080
            // 65280.0/65535
            return [
                pcsLab[0] * 0.9961089494163424,
                pcsLab[1] * 0.9961089494163424,
                pcsLab[2] * 0.9961089494163424
            ]
        };

        /**
         *
         * @param pcsLab
         * @returns {*[]}
         */
        stage_PCSv2_to_PCSv4(pcsLab){
            // 0x8080 / 0x8000
            // 65535.0/65280.0 = 1.00390625
            return [
                pcsLab[0] * 1.00390625,
                pcsLab[1] * 1.00390625,
                pcsLab[2] * 1.00390625
            ]
        };

        ///////////////////////////////////////////////////////////////////////////////////////////////////////////////
        // Convert from PCS > X

        // TODO - check optimisation can use this
        stage_LabD50_to_PCSXYZ(labD50){
            var XYZ = this.Lab2XYZ(labD50);

            return [
                XYZ.X / 1.999969482421875,
                XYZ.Y / 1.999969482421875,
                XYZ.Z / 1.999969482421875
            ]
        };

        stage_XYZ_to_PCSXYZ(XYZ){
            return [
                XYZ.X / 1.999969482421875,
                XYZ.Y / 1.999969482421875,
                XYZ.Z / 1.999969482421875
            ]
        };

    /**
         *
         * @param {_PCS} PCSv2
         * @returns {_PCS}
         */
        stage_PCSv2_to_PCSXYZ(PCSv2){
            var XYZ = this.Lab2XYZ( this.Lab(
                PCSv2[0] * 100.390625, // L
                ((PCSv2[1] * 255.99609375) - 128.0), // a
                ((PCSv2[2] * 255.99609375) - 128.0),  // b
                illuminant.d50
            ));

            return [
                XYZ.X / 1.999969482421875,
                XYZ.Y / 1.999969482421875,
                XYZ.Z / 1.999969482421875
            ]
        };





        /**
         *
         * @param {_PCS} PCSv4
         * @returns {_PCS}
         */
        stage_PCSv4_to_PCSXYZ(PCSv4){
            var XYZ = this.Lab2XYZ( this.Lab(
                PCSv4[0] * 100, // L
                ((PCSv4[1] * 255) - 128.0), // a
                ((PCSv4[2] * 255) - 128.0), // b
                illuminant.d50
            ));
            return [
                XYZ.X / 1.999969482421875,
                XYZ.Y / 1.999969482421875,
                XYZ.Z / 1.999969482421875
            ]
        };

            /**
         *
         * @param {_cmsXYZ} PCSXYZ
         * @returns {[]}
         */
        stage_PCSXYZ_to_PCSv4(PCSXYZ){
            var XYZ = this.XYZ(
                PCSXYZ[0] * 1.999969482421875,
                PCSXYZ[1] * 1.999969482421875,
                PCSXYZ[2] * 1.999969482421875
            );
            var lab = this.XYZ2Lab(XYZ, illuminant.d50);
            return [
                lab.L / 100,
                (lab.a + 128)/255,
                (lab.b + 128)/255
            ];
        };

        stage_PCSXYZ_to_LabD50(PCSXYZ){
            var XYZ = this.XYZ(
                PCSXYZ[0] * 1.999969482421875,
                PCSXYZ[1] * 1.999969482421875,
                PCSXYZ[2] * 1.999969482421875
            );
            return this.XYZ2Lab(XYZ, illuminant.d50);
        };

        /**
         *
         * @param {_cmsXYZ} PCSXYZ
         * @returns {[]}
         */
        stage_PCSXYZ_to_PCSv2(PCSXYZ){
            var XYZ = this.XYZ(
                PCSXYZ[0] * 1.999969482421875,
                PCSXYZ[1] * 1.999969482421875,
                PCSXYZ[2] * 1.999969482421875,
            );
            var lab = this.XYZ2Lab(XYZ, illuminant.d50);
            return [
                lab.L * 652.80 / 65535.0,
                (lab.a + 128) * 256 / 65535.0,
                (lab.b + 128) * 256 / 65535.0
            ];
        };

        // Compiled-pipeline POC: PCSXYZ → PCSv2.
        // In: X, Y, Z   Out: pcsL, pcsa, pcsb
        // PCSXYZ is the ICC encoding where 1.0 == 0xFFFF (so values 0..2 map to
        // 0..1). The first scale (* 1.999969...) lifts back to "real" XYZ; then
        // XYZ2Lab vs D50; then the PCSv2 packing scales (Lab → 0..1 16-bit
        // integer fractions). All constants baked.
        emit_js_stage_PCSXYZ_to_PCSv2(index, stage){
            // ICC PCSXYZ -> CIE Lab (D50) -> PCSv2-packed Lab.
            //
            //   PCSXYZ scale factor k = 65535/32768 (so 1.0 -> 32768/65535).
            //   D50 illuminant (illuminant.d50): WX=0.96422, WY=1.0, WZ=0.82521.
            //   Lab perceptual curve breakpoint  = (6/29)^3 = 0.008856...
            //   Lab linear-segment slope         = 841/108  ~ 7.787037
            //   Lab linear-segment offset        = 16/116   ~ 0.137931
            //
            // Math.cbrt is used in place of Math.pow(x, 1.0/3.0): same value to
            // within 1 ULP and roughly 4-5x faster on V8 (cbrt is a dedicated
            // intrinsic; pow runs a generic polynomial path even for fixed
            // exponents). Verified: bench/compile_poc/bench_body_variants.js
            // shows ~35% body-time reduction from this single substitution.
            var k        = 1.999969482421875;
            var WX       = 0.96422;
            var WY       = 1.0;
            var WZ       = 0.82521;
            var labLimit = (24.0/116.0) * (24.0/116.0) * (24.0/116.0);
            var A        = 841.0/108.0;
            var B        = 16.0/116.0;
            var scaleL   = 652.80 / 65535.0;   // L  in [0,100]   -> [0,1]
            var scaleAB  = 256.0  / 65535.0;   // ab in [-128,127] -> [0,1]

            var lines = [];
            lines.push('{');
            lines.push('  // PCSXYZ -> XYZ relative to D50 (k/W literals baked in)');
            lines.push('  let _fx = X * ' + (k / WX) + ';');
            lines.push('  let _fy = Y * ' + (k / WY) + ';');
            lines.push('  let _fz = Z * ' + (k / WZ) + ';');
            lines.push('  // Lab perceptual curve: f(t) = t^(1/3) for t > (6/29)^3, else linear segment');
            lines.push('  _fx = _fx <= ' + labLimit + ' ? ' + A + ' * _fx + ' + B + ' : Math.cbrt(_fx);');
            lines.push('  _fy = _fy <= ' + labLimit + ' ? ' + A + ' * _fy + ' + B + ' : Math.cbrt(_fy);');
            lines.push('  _fz = _fz <= ' + labLimit + ' ? ' + A + ' * _fz + ' + B + ' : Math.cbrt(_fz);');
            lines.push('  // CIE Lab (L:0..100, a/b:-128..127) packed into PCSv2 (all 0..1).');
            lines.push('  // Inlined the (_L,_a,_b) temps; V8 collapses them to the same SSA either way.');
            lines.push('  pcsL =  (116.0 * _fy - 16.0)       * ' + scaleL  + '; // L');
            lines.push('  pcsa = (500.0 * (_fx - _fy) + 128) * ' + scaleAB + '; // a');
            lines.push('  pcsb = (200.0 * (_fy - _fz) + 128) * ' + scaleAB + '; // b');
            lines.push('}');
            return lines.join('\n');
        };
        /**
         *
         * @param {_PCS} PCSv2
         * @returns {_cmsLabD50}
         */
        stage_PCSv2_to_LabD50(PCSv2){
            return {
                // L:  PCSv2[0] * 65535 / 652.80,
                // a: ((PCSv2[1] * 65535 / 256.0) - 128.0),
                // b: ((PCSv2[2] * 65535 / 256.0) - 128.0)
                L:  PCSv2[0] * 100.390625,
                a: ((PCSv2[1] * 255.99609375) - 128.0),
                b: ((PCSv2[2] * 255.99609375) - 128.0)
            };
        };

        /**
         * @param {_PCS} PCSv2
         * @returns {_cmsLab}
         */
        stage_PCSv2_to_cmsLab(PCSv2){
            return {
                L:  PCSv2[0] * 100.390625,
                a: ((PCSv2[1] * 255.99609375) - 128.0),
                b: ((PCSv2[2] * 255.99609375) - 128.0),
                type: eColourType.Lab,
                whitePoint: illuminant.d50
            };
        };

        stage_PCSv4_to_LabD50(PCSv4){
            return {
                L:   PCSv4[0] * 100,
                a: ((PCSv4[1] * 255) - 128.0),
                b: ((PCSv4[2] * 255) - 128.0)
            };
        };

        /**
         * @param { _PCS } PCSv4
         * @returns {_cmsLab}
         */
        stage_PCSv4_to_cmsLab(PCSv4){
            return {
                //L:   PCSv4[0] * 65535 / 655.35,
                //a: ((PCSv4[1] * 65535 / 257.0) - 128.0),
                //b: ((PCSv4[2] * 65535 / 257.0) - 128.0),
                L:   PCSv4[0] * 100,
                a: ((PCSv4[1] * 255) - 128.0),
                b: ((PCSv4[2] * 255) - 128.0),
                type: eColourType.Lab,
                whitePoint: illuminant.d50
            };
        };






        ///////////////////////////////////////////////////////////////////////////////////////////////////////////////
        // Convert from cmsLab

        /**
         *
         * @param {_cmsLab} cmsLab
         * @returns {_cmsLabD50}
         */
        stage_cmsLab_to_LabD50(cmsLab){
            if(cmsLab.type === eColourType.Lab){
                return convert.Lab2LabD50(cmsLab);
            }
            throw 'stage_cmsLab_to_LabD50: input is not of type Lab';
        };

        /**
         * Array entry point for a Lab input profile.
         *
         * The device branch has an entry stage per dataFormat
         * (`stage_Int_to_Device` and friends); the Lab branch only ever had the
         * object one, so a Lab source on the LUT-free pipeline could not take
         * an array at all — it reached `stage_cmsLab_to_LabD50` as a bare
         * triple and threw, or reached `stage_LabD50_to_PCSv4` and produced
         * NaN. This is the missing sibling.
         *
         * AN ARRAY IS ASSUMED ALREADY PCS-ENCODED FOR THIS PROFILE'S VERSION.
         * No cross-version conversion happens here and none should: if the
         * caller hands over 16-bit values from a Lab TIFF, they are taken as
         * that profile's encoding, and it is the caller's job to have encoded
         * them that way. All this stage does is scale by the dataFormat range.
         *
         * ONE MULTIPLIER, BUT NOT ONE DIVISOR. L and a/b do not share a scale
         * (v2: lMul 652.8 vs abMul 256; v4: 655.35 vs 257), so normalising
         * with a single number would be right for L and wrong for a/b on v2.
         * `convert.int162Lab` already splits them per version, so the work here
         * is only to reach 16-bit PCS units:
         *
         *     int8    x labNumerator/255   (256 on v2, 257 on v4)
         *     int16   x 1
         *     device  x labNumerator
         *
         * Objects pass through untouched, so `dataFormat: 'int8'` keeps
         * accepting a Lab object — which validateOnCreate and the LUT builder
         * both rely on.
         *
         * PASSING AN ARRAY IS THE CALLER SAYING "I HAVE HANDLED THIS". The
         * whitePoint stamped on the result is D50 because PCS-encoded values
         * are D50 by definition, so `labInputAdaptation: true` finds nothing
         * to adapt and `labInputAdaptation: false` skips the question
         * entirely — both branches return the same answer for the same array,
         * which is the property to preserve if this is ever touched. Callers
         * working from some other white point convert before they get here,
         * with convert.lab2Int16 or their own encoding; an object is the input
         * form that carries a white point for the engine to adapt FROM.
         *
         * @param {Array|Object} value      PCS-encoded triple, or a Lab object
         * @param {{mul: number, enc: Object}} stageData
         * @returns {_cmsLab}
         */
        stage_Int_to_cmsLab(value, stageData){
            if(value && value.type === eColourType.Lab) return value;
            if(!value || typeof value.length !== 'number' || value.length < 3){
                throw 'stage_Int_to_cmsLab: expected a Lab object or a 3-value array';
            }
            var m = stageData.mul;
            return convert.int162Lab(value[0] * m, value[1] * m, value[2] * m,
                                     stageData.enc);
        };


        /**
         *
         * @param {Profile} profile
         * @param {_cmsLabD50} LabD50
         * @returns {_Device}
         */
        stage_PCSv4_to_RGBDevice(LabD50, profile ){
            return this.PCSv4_to_RGBDevice(LabD50, profile, this.RGBMatrixWhiteAdadaptation)
        };

        /**
         *
         * @param {Profile} profile
         * @param device
         * @returns {*}
         */
        stage_RGBDevice_to_PCSv4(device, profile){
            return this.RGBDevice_to_PCSv4_or_LabD50(device, profile, false, this.RGBMatrixWhiteAdadaptation);
        };


        /**
         *
         * @param {_cmsLab} labD50
         * @returns {_PCS}
         */
        stage_LabD50_to_PCSv4(labD50){
            return [
                labD50.L / 100,
                (labD50.a + 128)/255,
                (labD50.b + 128)/255
            ];
        };


        stage_LabD50_to_PCSv2(labD50){
            return [
                labD50.L * 652.80 / 65535.0,
                (labD50.a + 128) * 256 / 65535.0,
                (labD50.b + 128) * 256 / 65535.0
            ];
        };

        /**
         * @param {_cmsLabD50} labD50
         * @returns {_cmsLab}
         */
        stage_LabD50_to_cmsLab(labD50){
            return {
                L: labD50.L,
                a: labD50.a,
                b: labD50.b,
                type: eColourType.Lab,
                whitePoint: illuminant.d50
            };
        };


        ////////////////////////////////////////////////////////////////////////////////
        //
        //  Stage for 3 X 3 matrix operations with helper functions
        //

        /**
         *
         * @param matrix
         * @param input
         * @returns {[]}
         *
         *   [ 0 1 2 ] + [ 9  ]
         *   [ 3 4 5 ] + [ 10 ]
         *   [ 6 7 8 ] + [ 11 ]
         */
        stage_matrix_v4(input, matrix){
            //note that the b-curves will clip
            return [
                (matrix[0] * input[0]) + (matrix[1] * input[1]) + (matrix[2] * input[2]) + matrix[9],
                (matrix[3] * input[0]) + (matrix[4] * input[1]) + (matrix[5] * input[2]) + matrix[10],
                (matrix[6] * input[0]) + (matrix[7] * input[1]) + (matrix[8] * input[2]) + matrix[11]
            ]
        };

        stage_matrix_v4_noOffsets(input, matrix){
            //note that the b-curves will clip
            return [
                (matrix[0] * input[0]) + (matrix[1] * input[1]) + (matrix[2] * input[2]) ,
                (matrix[3] * input[0]) + (matrix[4] * input[1]) + (matrix[5] * input[2]) ,
                (matrix[6] * input[0]) + (matrix[7] * input[1]) + (matrix[8] * input[2])
            ]
        };
        /**
         *
         * @param {[]} vector array of 3 points
         * @param {[]} matrix array of 9 points
         *   [ 0 1 2 ]
         *   [ 3 4 5 ]
         *   [ 6 7 8 ]
         */
        evalMatrix( vector, matrix){
            return [
                matrix[0] * vector[0] + matrix[1] * vector[1] + matrix[2] * vector[2],
                matrix[3] * vector[0] + matrix[4] * vector[1] + matrix[5] * vector[2],
                matrix[6] * vector[0] + matrix[7] * vector[1] + matrix[8] * vector[2]
            ]
        };

        /**
         *
         * @param {[]} m matrix array of 12 points
         *       0 1 2
         *  0  [ 0 1 2 ]
         *  1  [ 3 4 5 ]
         *  2  [ 6 7 8 ]
         */
        invertMatrix(m){

            var determinant =
                m[0] * (m[8] * m[4] - m[7] * m[5]) -
                m[3] * (m[8] * m[1] - m[7] * m[2]) +
                m[6] * (m[5] * m[1] - m[4] * m[2]);

            var scale = 1.0 / determinant;

            return [
                scale * (m[8] * m[4] - m[7] * m[5]),
                -scale * (m[8] * m[1] - m[7] * m[2]),
                scale * (m[5] * m[1] - m[4] * m[2]),

                -scale * (m[8] * m[3] - m[6] * m[5]),
                scale * (m[8] * m[0] - m[6] * m[2]),
                -scale * (m[5] * m[0] - m[3] * m[2]),

                scale * (m[7] * m[3] - m[6] * m[4]),
                -scale * (m[7] * m[0] - m[6] * m[1]),
                scale * (m[4] * m[0] - m[3] * m[1])
            ]

        };

        invertMatrix3(m){

            var determinant =
                m[0] * (m[9] * m[4] - m[7] * m[4]) -
                m[3] * (m[9] * m[1] - m[7] * m[2]) +
                m[6] * (m[4] * m[1] - m[4] * m[2]);

            var scale = 1.0 / determinant;

            return [
                scale * (m[9] * m[4] - m[7] * m[4]),
                -scale * (m[9] * m[1] - m[7] * m[2]),
                scale * (m[4] * m[1] - m[4] * m[2]),

                -scale * (m[9] * m[3] - m[6] * m[4]),
                scale * (m[9] * m[0] - m[6] * m[2]),
                -scale * (m[4] * m[0] - m[3] * m[2]),

                scale * (m[7] * m[3] - m[6] * m[4]),
                -scale * (m[7] * m[0] - m[6] * m[1]),
                scale * (m[4] * m[0] - m[3] * m[1])
            ]
        };

        ////////////////////////////////////////////////////////////////////////////////
        //
        //  Stage for applying Curves
        //

        stage_curves_parametric(input, curves){
            var channels = input.length;
            var output = new Array(channels);
            for(var i=0; i < channels; i++){
                var c = curves[i];
                output[i] = c.curveFn(c.params, input[i]);
                //output[i] = Math.min(Math.max(y, 0.0), 1.0);
            }
            return output;
        }

        /**
         * array input - Values 0.0 to 1.0
         * curve array of points in ICC V4 format
         *
         * @param {Profile.inputCurve | Profile.outputCurve} input
         * @param {object} curves  = Array of Curves - One for each Channel
         * @returns {number[]}
         */
        stage_curves_v4(input, curves ){
            var output;
            var channels = curves.length;
            if(channels === 3){
                output = [0.0, 0.0, 0.0];
            } else {
                output = [0.0, 0.0, 0.0, 0.0];
            }
            for(var i=0; i < channels; i++){
                var c = curves[i];
                if(c.curveFn){
                    //
                    // Use Parametric Function,
                    // These are automatically inverted at creation in mAB or mAB
                    //
                    output[i] = c.curveFn(c.params, input[i]);
                } else if(c.dataf.length > 0){
                    //
                    // Interpolate the sampled curve.
                    // (Sampled curves may ALSO carry a midpoint .gamma — that
                    // is a hint only; the table is authoritative, so this
                    // branch must come before the gamma branch.)
                    //
                    var countMinus1 = c.count -1;
                    var p = input[i];
                    if(p >= 1.0){
                        output[i] = c.dataf[countMinus1];
                    } else if(p <= 0.0){
                        output[i] = c.dataf[0] ;
                    } else {
                        var pX = p * (countMinus1);
                        var pX0 = Math.floor(pX);
                        var data0 = curves[i].dataf[pX0];
                        output[i] = (data0 + ( (pX - pX0) * ( curves[i].dataf[pX0 + 1] - data0 ) ));
                    }
                } else if(c.gamma > 0 && c.gamma !== 1.0){
                    //
                    // Pure gamma curve with no table — 'curv' with count 1,
                    // or parametricCurveType function type 0 (the decoder
                    // stores the exponent inline instead of a curveFn).
                    // Seen in the wild in linearization DeviceLinks.
                    //
                    var pg = input[i];
                    pg = pg < 0 ? 0 : (pg > 1 ? 1 : pg);
                    output[i] = Math.pow(pg, c.inverted ? 1.0 / c.gamma : c.gamma);
                } else {
                    // Linear / passThrough (count 0, or gamma 1.0)
                    output[i] = input[i];
                }
            }
            return output;
        };

        /**
         * array input - Values 0.0 to 1.0
         * curve array of points in ICC V2 format
         *
         * @param {Profile.inputCurve | Profile.outputCurve} input
         * @param curve
         * @returns {number[]}
         */
        stage_curve_v2(input, curve){
            var offset = 0;

            var channels = curve.channels;
            var tableEntries = curve.entries;
            var tableEntriesMinus1 = tableEntries-1;
            var tablef = curve.tablef;
            var output = new Array(channels)

            for(var i=0; i < channels; i++){
                var p = input[i];
                if(p >= 1.0){
                    output[i] = tablef[offset+tableEntriesMinus1];
                } else if(p <= 0.0){
                    output[i] = tablef[offset];
                } else {
                    var pX = p * (tableEntriesMinus1); // scale to entries
                    var pX0 = Math.floor(pX);
                    var r = (pX - pX0);

                    var y0 = tablef[offset+pX0];
                    var y1 = tablef[offset+pX0+1];
                    output[i] = y0 + ((y1 - y0) * r);
                }
                offset += tableEntries;
            }

            return output;
        };

        // Compiled-pipeline POC: per-channel linear-interp of a v2 curve table.
        // Channel basis derived from the stage's input encoding:
        //   PCSv2 (1) → reads/writes pcsL, pcsa, pcsb            (3 channels)
        //   device (0) → reads/writes d0..d{channels-1}          (n channels)
        // The Float64 table goes on the store; entries / offsets are baked
        // numeric literals so the per-channel block is straight-line.
        attachStore_js_stage_curve_v2(store, idx, stage){
            store['s' + idx + '_table'] = stage.stageData.tablef;
        }

        emit_js_stage_curve_v2(index, stage){
            var c          = stage.stageData;
            var entries    = c.entries;
            var entriesM1  = entries - 1;
            var channels   = c.channels;
            var tableKey   = 's' + index + '_table';
            var inEnc      = stage.inputEncoding;

            var DEVICE_VARS = ['d0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];
            var vars;
            if (inEnc === 1 /* PCSv2 */ || inEnc === 2 /* PCSv4 */) {
                vars = ['pcsL', 'pcsa', 'pcsb'].slice(0, channels);
            } else {
                vars = DEVICE_VARS.slice(0, channels);
            }

            var lines = [];
            lines.push('{');
            // Pull table reference once.
            lines.push('  const _t = store.' + tableKey + ';');

            var offset = 0;
            for (var ch = 0; ch < channels; ch++) {
                var v = vars[ch];
                var off = offset; // baked
                lines.push('  // ch ' + ch + ' → ' + v);
                lines.push('  {');
                lines.push('    let _p = ' + v + ';');
                lines.push('    if (_p >= 1.0) ' + v + ' = _t[' + (off + entriesM1) + '];');
                lines.push('    else if (_p <= 0.0) ' + v + ' = _t[' + off + '];');
                lines.push('    else {');
                lines.push('      let _pX = _p * ' + entriesM1 + ';');
                lines.push('      let _p0 = _pX | 0;');
                lines.push('      let _rr = _pX - _p0;');
                lines.push('      let _y0 = _t[' + off + ' + _p0];');
                lines.push('      let _y1 = _t[' + off + ' + _p0 + 1];');
                lines.push('      ' + v + ' = _y0 + (_y1 - _y0) * _rr;');
                lines.push('    }');
                lines.push('  }');
                offset += entries;
            }
            lines.push('}');
            return lines.join('\n');
        };
    }

    // Moved here with addDebugHistory (its only caller) — it was left behind
    // in Transform.js by the v1.5.5 stages split, which silently broke
    // pipelineDebug: no test covered the debug path.
    function data2String(color, format, precision){
        if(typeof precision === 'undefined'){
            precision = 6;
        }

        if(color === null){
            return '<NULL>';
        }

        if(color.type){
            return convert.cmsColor2String(color);
        }

        if(color.hasOwnProperty('L')){ // labD50 object {L:0, a:0, b:0}
            return 'LabD50: ' + n2str(color.L) + ', ' + n2str(color.a) + ', ' + n2str(color.b);
        }

        var str ='';
        for(var i=0;i < color.length; i++){
            switch(format){
                case 'r':
                case 'round':
                    str += Math.round(color[i]);
                    break;
                case 'f>16':
                case 'float>16':
                    str += Math.round(color[i]*65535);
                    break;
                case 'float':
                case 'f':
                default:
                    // raw
                    str += n2str(color[i], precision);
            }
            if(i<color.length - 1){
                str += ', ';
            }
        }
        return str;

        function n2str(n){
            return isNaN(n) ? n : n.toFixed(precision);
        }





    }

var _exports = {};
Object.getOwnPropertyNames(_TransformStages.prototype).forEach(function(name){
    if (name !== 'constructor') _exports[name] = _TransformStages.prototype[name];
});
module.exports = _exports;
