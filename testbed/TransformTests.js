

////////////////////////////////////////////////////////////////////////////////
//
//  Performance and testing functions
//
//  Extend the base class
//
//

let Transform = require('../src/Transform.js');


class TransformTests extends Transform {
    constructor(options) {
        super(options);
    }

    validateInterpolation(gridPoints, doSpeedTest) {
        gridPoints = gridPoints || 20;

        var deleteLut = false;
        if (!this.lut) {
            this.createLut();
        }

        if (this.interpolationFast) {
            throw new Error('Do not built the test LUT with interpolationFast = true');
        }

        console.log(' ')
        console.log(' --------------------- VALIDATION  --------------------- ')

        if (gridPoints === this.lut.g1) {
            console.log('ERROR - Testing LUT interpolation with same grid points as LUT will result in no Interpolation');
        }

        //speed speed_tests first so the right data is passed thorough for the LUT
        if (doSpeedTest) {
            this.speedTest();
        }

        console.log('Testing LUT interpolation with ' + gridPoints + ' grid points  : ' + this.lut.inputChannels + ' -> ' + this.lut.outputChannels + ' Channels ');

        switch (this.lut.inputChannels) {
            // case 1:
            //     this.validate1DInterpolation(this.lut, gridPoints);
            //     break;
            // case 2:
            //     this.validate2DInterpolation(this.lut, gridPoints);
            //     break;
            case 3:
                this.validate3DInterpolation(this.lut, gridPoints);
                break;
            case 4:
                this.validate4DInterpolation(this.lut, gridPoints);
                break;
            default:
                throw new Error('Unsupported input channels');
        }

        if (deleteLut) {
            this.lut = false;
        }

    }

    validate3DInterpolation(lut, gridPoints) {
        var step = 1 / (gridPoints - 1);
        var r, g, b;
        var rv, gv;
        var count = 0;
        var input;
        var outputChannels = lut.outputChannels;
        var inputChannels = lut.inputChannels;
        var masterOutput, output;

        var samplePos = Math.floor((gridPoints * gridPoints * gridPoints) * .23)

        var testingList = {
            'trilinearInterp3D_NCh': {passCount: 0, failCount: 0, failList: ''},
            'tetrahedralInterp3D_3or4Ch': {passCount: 0, failCount: 0, failList: ''},
            'tetrahedralInterp3D_NCh': {passCount: 0, failCount: 0, failList: ''},
            'tetrahedralInterp3D_3Ch': {passCount: 0, failCount: 0, failList: ''},
            'tetrahedralInterp3D_4Ch': {passCount: 0, failCount: 0, failList: ''},
            'tetrahedralInterp3DArray_3Ch_loop': {passCount: 0, failCount: 0, failList: ''},
            'tetrahedralInterp3DArray_4Ch_loop': {passCount: 0, failCount: 0, failList: ''},
        }

        //
        //
        // For the speed_tests we need to setup the LUTS not to scale
        lut.inputScale = 1;
        lut.outputScale = 1;
        var input255 = new Array(3);

        for (r = 0; r < gridPoints; r++) {
            rv = r * step;
            for (g = 0; g < gridPoints; g++) {
                gv = g * step;
                for (b = 0; b < gridPoints; b++) {
                    count++;
                    input = [rv, gv, b * step];
                    input255[0] = rv * 255;
                    input255[1] = gv * 255;
                    input255[2] = b * step * 255;

                    //---------------------- trilinear --------------------

                    lut.inputScale = 1;
                    lut.outputScale = 1;
                    var masterTrilinear = this.trilinearInterp3D_3or4Ch(input, lut, 0);
                    if (count === samplePos) {
                        console.log('Trilinear Master Sample   ' + array2String(input, 7) + ' = ' + array2String(masterTrilinear, 7));
                    }

                    lut.inputScale = 1;
                    lut.outputScale = 1;
                    output = this.trilinearInterp3D_NCh(input, lut, 0);
                    this.compare(testingList, 'trilinearInterp3D_NCh', input, masterTrilinear, output, outputChannels);

                    //---------------------- tetrahedral --------------------
                    lut.inputScale = 1;
                    lut.outputScale = 1;
                    masterOutput = this.tetrahedralInterp3D_Master(input, lut, 0);
                    if (count === samplePos) {
                        console.log('Tetrahedral Master Sample ' + array2String(input, 7) + ' = ' + array2String(masterOutput, 7));
                    }

                    lut.inputScale = 1;
                    lut.outputScale = 1;
                    output = this.tetrahedralInterp3D_3or4Ch(input, lut, 0);
                    this.compare(testingList, 'tetrahedralInterp3D_3or4Ch', input, masterOutput, output, outputChannels);
                    output = null;

                    lut.inputScale = 1;
                    lut.outputScale = 1;
                    output = this.tetrahedralInterp3D_NCh(input, lut);
                    this.compare(testingList, 'tetrahedralInterp3D_NCh', input, masterOutput, output, outputChannels);
                    output = null;

                    if (outputChannels === 3) {
                        lut.inputScale = 1;
                        lut.outputScale = 1;
                        output = this.tetrahedralInterp3D_3Ch(input, lut);
                        this.compare(testingList, 'tetrahedralInterp3D_3Ch', input, masterOutput, output, outputChannels);

                        output = new Array(3);
                        lut.inputScale = 1 / 255;
                        lut.outputScale = 1;
                        this.tetrahedralInterp3DArray_3Ch_loop(input255, 0, output, 0, 1, lut, false, false, false);
                        this.compare(testingList, 'tetrahedralInterp3DArray_3Ch_loop', input, masterOutput, output, outputChannels);
                    }

                    if (outputChannels === 4) {
                        lut.inputScale = 1;
                        lut.outputScale = 1;
                        output = this.tetrahedralInterp3D_4Ch(input, lut);
                        this.compare(testingList, 'tetrahedralInterp3D_4Ch', input, masterOutput, output, outputChannels);

                        output = new Array(4);
                        lut.inputScale = 1 / 255;
                        lut.outputScale = 1;
                        this.tetrahedralInterp3DArray_4Ch_loop(input255, 0, output, 0, 1, lut, false, false, false);
                        this.compare(testingList, 'tetrahedralInterp3DArray_4Ch_loop', input, masterOutput, output, outputChannels);
                    }
                }
            }
        }
        console.log('Tested 3D : ' + count + ' points ');
        console.log('  BASELINE  = trilinearInterp3D_3or4Ch');
        console.log('  BASELINE  = tetrahedralInterp3D_Master');
        this.logResults(testingList);
    }

    validate4DInterpolation(lut, gridPoints) {

        gridPoints = gridPoints || 33;
        var step = 1 / (gridPoints - 1);
        var c, m, y, k;
        var cv, mv, yv, kv;
        var count = 0;
        var input;
        var input255;
        var outputChannels = lut.outputChannels;
        var masterOutput, output;

        //
        //
        // For the speed_tests we need to setup the LUTS not to scale
        lut.inputScale = 1;
        lut.outputScale = 1;

        var samplePos = Math.floor((gridPoints * gridPoints * gridPoints * gridPoints) * .678)

        var testingList = {

            'tetrahedralInterp4D_3or4Ch': {passCount: 0, failCount: 0, failList: ''},
            'tetrahedralInterp4D_NCh': {passCount: 0, failCount: 0, failList: ''},
            'tetrahedralInterp4D_3Ch': {passCount: 0, failCount: 0, failList: ''},
            'tetrahedralInterp4D_4Ch': {passCount: 0, failCount: 0, failList: ''},
            'tetrahedralInterp4DArray_3Ch_loop': {passCount: 0, failCount: 0, failList: ''},
            'tetrahedralInterp4DArray_4Ch_loop': {passCount: 0, failCount: 0, failList: ''},
        }


        input255 = new Array(4);

        for (c = 0; c < gridPoints; c++) {
            cv = c * step;
            for (m = 0; m < gridPoints; m++) {
                mv = m * step;
                for (y = 0; y < gridPoints; y++) {
                    yv = y * step;
                    for (k = 0; k < gridPoints; k++) {
                        // input is already scaled to 0.0 to 1.0 as we are using device encoding


                        input = [cv, mv, yv, k * step];
                        input255[0] = cv * 255;
                        input255[1] = mv * 255;
                        input255[2] = yv * 255;
                        input255[3] = k * step * 255;

                        // if(c === 0 && m === 0 && y === 0 && k === 0){
                        //     input = [0.3, 0.5, 0.7, 0.91];
                        // }

                        count++;
                        lut.inputScale = 1;
                        lut.outputScale = 1;
                        masterOutput = this.tetrahedralInterp4D_3or4Ch_Master(input, lut, 0);
                        if (count === samplePos) {
                            console.log('Master Sample ' + array2String(input, 7) + ' = ' + array2String(masterOutput, 7));
                        }

                        lut.inputScale = 1;
                        lut.outputScale = 1;
                        output = this.tetrahedralInterp4D_3or4Ch(input, lut);
                        this.compare(testingList, 'tetrahedralInterp4D_3or4Ch', input, masterOutput, output, outputChannels);

                        lut.inputScale = 1;
                        lut.outputScale = 1;
                        output = this.tetrahedralInterp4D_NCh(input, lut);
                        this.compare(testingList, 'tetrahedralInterp4D_NCh', input, masterOutput, output, outputChannels);

                        if (outputChannels === 3) {
                            lut.inputScale = 1;
                            lut.outputScale = 1;
                            output = this.tetrahedralInterp4D_3Ch(input, lut);
                            this.compare(testingList, 'tetrahedralInterp4D_3Ch', input, masterOutput, output, outputChannels);

                            output = new Array(3);
                            lut.inputScale = 1 / 255;
                            lut.outputScale = 1;
                            this.tetrahedralInterp4DArray_3Ch_loop(input255, 0, output, 0, 1, lut, false, false, false);
                            this.compare(testingList, 'tetrahedralInterp4DArray_3Ch_loop', input, masterOutput, output, outputChannels);
                        }

                        if (outputChannels === 4) {
                            lut.inputScale = 1;
                            lut.outputScale = 1;
                            output = this.tetrahedralInterp4D_4Ch(input, lut);
                            this.compare(testingList, 'tetrahedralInterp4D_4Ch', input, masterOutput, output, outputChannels);

                            output = new Array(4);
                            lut.inputScale = 1 / 255;
                            lut.outputScale = 1;
                            this.tetrahedralInterp4DArray_4Ch_loop(input255, 0, output, 0, 1, lut, false, false, false);
                            this.compare(testingList, 'tetrahedralInterp4DArray_4Ch_loop', input, masterOutput, output, outputChannels);
                        }
                    }
                }
            }
        }

        console.log('  Tested 4D : ' + count + ' points ');
        console.log('  BASELINE  = tetrahedralInterp4D_3or4Ch_Master');
        this.logResults(testingList);
    }

    logResults(results) {
        var r = Object.keys(results);
        for (var i = 0; i < r.length; i++) {
            var key = r[i];
            var result = results[key];
            if (result.failCount > 0 || result.passCount > 0) {
                if (result.failCount > 0) {
                    console.log('%c  FAILED :  ' + key + ' ' + result.passCount + ' passed, ' + result.failCount + ' failed', 'color:red');
                    console.log(result.failList);
                } else {
                    console.log('%c  PASSED :  ' + key + ' ' + result.passCount + ' passed', 'color:limegreen');
                }
            } else {
                //console.log(key + ' NOT TESTED');
            }
        }

        console.log('--------------------------------------------------------- ')
        console.log(' ')
    }

    compare(testingList, key, input, a, b, channels) {
        var precession = 7;
        var passed = false;
        if (channels === 3) {
            passed = (a[0].toFixed(precession) === b[0].toFixed(precession) && a[1].toFixed(precession) === b[1].toFixed(precession) && a[2].toFixed(precession) == b[2].toFixed(precession));
        } else if (channels === 4) {
            passed = (a[0].toFixed(precession) === b[0].toFixed(precession) && a[1].toFixed(precession) === b[1].toFixed(precession) && a[2].toFixed(precession) == b[2].toFixed(precession) && a[3].toFixed(precession) == b[3].toFixed(precession));
        } else {
            debugger;
        }

        if (passed) {
            testingList[key].passCount++;
            return
        }

        testingList[key].failCount++;
        if (testingList[key].failCount < 10) {
            testingList[key].failList += array2String(input, precession) + ' > ' + array2String(a, precession) + ' != ' + array2String(b, precession) + '\n';
        }
    }

    speedTest(iterations) {

        var iterations = iterations || 10;
        var pixelLength = 1092 * 1024; // average image size

        console.log('Speed Test with ' + iterations + ' iterations over ' + pixelLength + ' pixels');
        var i;
        var input;
        switch (this.lut.inputChannels) {
            case 3:
                var r = 0, g = 0, b = 0;
                input = new Uint8ClampedArray(pixelLength * 3);
                for (var p = 0; p < pixelLength; p++) {
                    input[p++] = r;
                    input[p++] = g;
                    input[p++] = b;
                    r += 1;
                    if (r > 255) {
                        r = 0;
                        g += 1;
                        if (g > 255) {
                            g = 0;
                            b += 1;
                            if (b > 255) {
                                b = 0;
                            }
                        }
                    }
                }

                break;
            case 4:
                var c = 0, m = 0, y = 0, k = 0;
                input = new Uint8ClampedArray(pixelLength * 4);
                for (var p = 0; p < pixelLength; p++) {
                    input[p++] = c;
                    input[p++] = m;
                    input[p++] = y;
                    input[p++] = k;
                    c += 1;
                    if (c > 255) {
                        c = 0;
                        m += 1;
                        if (m > 255) {
                            m = 0;
                            y += 1;
                            if (y > 255) {
                                y = 0;
                                k += 1;
                                if (k > 255) {
                                    k = 0;
                                }
                            }
                        }
                    }
                }
                break;
        }

        var masterOutput = new Uint8ClampedArray(pixelLength * this.lut.outputChannels);
        var output = new Uint8ClampedArray(pixelLength * this.lut.outputChannels);

        // test each one
        var lut = this.lut;
        var inputPos = 0;
        var outputPos = 0;
        var inputStep = this.lut.inputChannels;
        var outputStep = this.lut.outputChannels;
        var p;
        var t, t2;
        var name;
        var results = [];
        var pixelCount = pixelLength * iterations;

        input[0] = 99;
        input[1] = 177;
        input[2] = 255;
        input[3] = 66;

        var tInput, tOutput;
        tInput = new Array(4);
        var dots = ': . . . . . . . . . . . . '

        switch (this.lut.inputChannels) {
            // ----------------------------------- 3 Channel inputs -----------------------------------
            case 3:

                t = performance.now();
                for (i = 0; i < iterations; i++) {
                    inputPos = 0;
                    for (p = 0; p < pixelLength; p++) {
                        tInput[0] = input[inputPos++];
                        tInput[1] = input[inputPos++];
                        tInput[2] = input[inputPos++];
                        tOutput = this.trilinearInterp3D_3or4Ch(tInput, lut, 0);
                    }
                }
                t2 = performance.now() - t;
                name = 'trilinearInterp3D_3or4Ch';
                console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3));

                var basePerformance = t2;

                t = performance.now();
                for (i = 0; i < iterations; i++) {
                    inputPos = 0;
                    for (p = 0; p < pixelLength; p++) {
                        tInput[0] = input[inputPos++];
                        tInput[1] = input[inputPos++];
                        tInput[2] = input[inputPos++];
                        tOutput = this.tetrahedralInterp3D_3or4Ch(tInput, lut, 0);
                    }
                }
                t2 = performance.now() - t;
                name = 'tetrahedralInterp3D_3or4Ch';
                console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3) + '  ' + (basePerformance / t2).toFixed(3) + 'x faster');


                t = performance.now();
                for (i = 0; i < iterations; i++) {
                    inputPos = 0;
                    for (p = 0; p < pixelLength; p++) {
                        tInput[0] = input[inputPos++];
                        tInput[1] = input[inputPos++];
                        tInput[2] = input[inputPos++];
                        tOutput = this.tetrahedralInterp3D_NCh(tInput, lut, 0);
                    }
                }
                t2 = performance.now() - t;
                name = 'tetrahedralInterp3D_NCh';
                console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3) + '  ' + (basePerformance / t2).toFixed(3) + 'x faster')

                if (this.lut.outputChannels === 3) {
                    t = performance.now();
                    for (i = 0; i < iterations; i++) {
                        inputPos = 0;
                        for (p = 0; p < pixelLength; p++) {
                            tInput[0] = input[inputPos++];
                            tInput[1] = input[inputPos++];
                            tInput[2] = input[inputPos++];
                            tOutput = this.tetrahedralInterp3D_3Ch(tInput, lut, 0);
                        }
                    }
                    t2 = performance.now() - t;
                    name = 'tetrahedralInterp3D_3Ch ';
                    console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3) + '  ' + (basePerformance / t2).toFixed(3) + 'x faster')

                    inputPos = 0;
                    outputPos = 0;
                    t = performance.now();
                    for (i = 0; i < iterations; i++) {
                        this.tetrahedralInterp3DArray_3Ch_loop(input, inputPos, output, outputPos, pixelLength, lut, false, false, false);
                    }
                    t2 = performance.now() - t;
                    name = 'tetrahedralInterp3DArray_3Ch_loop';
                    console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3) + '  ' + (basePerformance / t2).toFixed(3) + 'x faster')
                }

                if (this.lut.outputChannels === 4) {

                    t = performance.now();
                    for (i = 0; i < iterations; i++) {
                        for (p = 0; p < pixelLength; p++) {
                            tInput[0] = input[inputPos++];
                            tInput[1] = input[inputPos++];
                            tInput[2] = input[inputPos++];
                            tOutput = this.tetrahedralInterp3D_4Ch(tInput, lut, 0);
                        }
                    }
                    t2 = performance.now() - t;
                    name = 'tetrahedralInterp3D_4Ch';
                    console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3) + '  ' + (basePerformance / t2).toFixed(3) + 'x faster')

                    inputPos = 0;
                    outputPos = 0;
                    t = performance.now();
                    for (i = 0; i < iterations; i++) {
                        this.tetrahedralInterp3DArray_4Ch_loop(input, inputPos, output, outputPos, pixelLength, lut, false, false, false);
                    }
                    t2 = performance.now() - t;
                    name = 'tetrahedralInterp3DArray_4Ch_loop';
                    console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3) + '  ' + (basePerformance / t2).toFixed(3) + 'x faster')
                }

                break;

            // ----------------------------------- 4 Channel inputs -----------------------------------
            case 4:


                t = performance.now();
                for (i = 0; i < iterations; i++) {
                    inputPos = 0;
                    for (p = 0; p < pixelLength; p++) {
                        tInput[0] = input[inputPos++];
                        tInput[1] = input[inputPos++];
                        tInput[2] = input[inputPos++];
                        tInput[3] = input[inputPos++];
                        tOutput = this.trilinearInterp4D_3or4Ch(tInput, lut, 0);
                    }
                }
                t2 = performance.now() - t;
                name = 'trilinearInterp4D_3or4Ch';
                console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3));

                var basePerformance = t2;

                t = performance.now();
                for (i = 0; i < iterations; i++) {
                    inputPos = 0;
                    for (p = 0; p < pixelLength; p++) {
                        tInput[0] = input[inputPos++];
                        tInput[1] = input[inputPos++];
                        tInput[2] = input[inputPos++];
                        tInput[3] = input[inputPos++];
                        tOutput = this.tetrahedralInterp3D_3or4Ch(tInput, lut, 0);
                    }
                }
                t2 = performance.now() - t;
                name = 'tetrahedralInterp3D_3or4Ch';
                console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3) + '  ' + (basePerformance / t2).toFixed(3) + 'x faster')


                t = performance.now();
                for (i = 0; i < iterations; i++) {
                    inputPos = 0;
                    for (p = 0; p < pixelLength; p++) {
                        tInput[0] = input[inputPos++];
                        tInput[1] = input[inputPos++];
                        tInput[2] = input[inputPos++];
                        tInput[3] = input[inputPos++];
                        tOutput = this.tetrahedralInterp4D_NCh(tInput, lut, 0);
                    }
                }
                t2 = performance.now() - t;
                name = 'tetrahedralInterp4D_NCh';
                console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3) + '  ' + (basePerformance / t2).toFixed(3) + 'x faster')

                if (this.lut.outputChannels === 3) {

                    t = performance.now();
                    for (i = 0; i < iterations; i++) {
                        inputPos = 0;
                        for (p = 0; p < pixelLength; p++) {
                            tInput[0] = input[inputPos++];
                            tInput[1] = input[inputPos++];
                            tInput[2] = input[inputPos++];
                            tInput[3] = input[inputPos++];
                            tOutput = this.tetrahedralInterp4D_3Ch(tInput, lut, 0);
                        }
                    }
                    t2 = performance.now() - t;
                    name = 'tetrahedralInterp4D_3Ch';
                    console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3) + '  ' + (basePerformance / t2).toFixed(3) + 'x faster')

                    inputPos = 0;
                    outputPos = 0;
                    t = performance.now();
                    for (i = 0; i < iterations; i++) {
                        this.tetrahedralInterp4DArray_3Ch_loop(input, inputPos, output, outputPos, pixelLength, lut, false, false, false);

                    }
                    t2 = performance.now() - t;
                    name = 'tetrahedralInterp4DArray_3Ch_loop';
                    console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3) + '  ' + (basePerformance / t2).toFixed(3) + 'x faster')
                }

                if (this.lut.outputChannels === 4) {

                    t = performance.now();
                    for (i = 0; i < iterations; i++) {
                        for (p = 0; p < pixelLength; p++) {
                            tInput[0] = input[inputPos++];
                            tInput[1] = input[inputPos++];
                            tInput[2] = input[inputPos++];
                            tInput[3] = input[inputPos++];
                            tOutput = this.tetrahedralInterp4D_4Ch(tInput, lut, 0);
                        }
                    }
                    t2 = performance.now() - t;
                    name = 'tetrahedralInterp4D_4Ch';
                    console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3) + '  ' + (basePerformance / t2).toFixed(3) + 'x faster')

                    inputPos = 0;
                    outputPos = 0;
                    t = performance.now();
                    for (i = 0; i < iterations; i++) {
                        this.tetrahedralInterp4DArray_4Ch_loop(input, inputPos, output, outputPos, pixelLength, lut, false, false, false);

                    }
                    t2 = performance.now() - t;
                    name = 'tetrahedralInterp4DArray_4Ch_loop';
                    console.log((name + dots).substring(0, 40) + (t2).toFixed(3) + 'ms  Million Pixels per second=' + (pixelCount / (t2) * 1000 / 1000000).toFixed(3) + '  ' + (basePerformance / t2).toFixed(3) + 'x faster')
                }

                break;
        }

    }

}


function array2String(a, decimals){
    var s = '';
    for(var i = 0; i < a.length; i++){
        s += a[i].toFixed(decimals) + ', ';
    }
    return s;
}

module.exports = TransformTests;