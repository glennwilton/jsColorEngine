const defs = require("../src/def");
const Loader = require("../src/Loader");
const  {convert } = require('../src/main.js');

// Use the extended version with the speed_tests
const TransformTest = require('./TransformTests.js');

async function start() {
    let loader = new Loader();

    var profileFolder = './profiles/';
    var testDataFolder = './testData/';

    var roundRGBtoInt = false;

    var run = {
        speed: false,
        validation: false,
        lab2Device: true,
        device2Lab: true,
        rgb2Device: true,
        device2Rgb: true,
    }

    var lab2DeviceTests = [
        {
            intent: defs.eIntent.absolute,
            BPC: false,
            prefix: '*_to_',
            suffix: '_Absolute.it8'
        },
        {
            intent: defs.eIntent.relative,
            BPC: false,
            prefix: '*_to_',
            suffix: '_Relative.it8'
        },
        {
            intent: defs.eIntent.perceptual,
            BPC: false,
            prefix: '*_to_',
            suffix: '_Perceptual.it8'
        },
        {
            intent: defs.eIntent.perceptual,
            BPC: true,
            prefix: '*_to_',
            suffix: '_Perceptual_BPC.it8'
        },
        {
            intent: defs.eIntent.relative,
            BPC: true,
            prefix: '*_to_',
            suffix: '_Relative_BPC.it8'
        },
    ]

    var device2LabTests = [
        {
            intent: defs.eIntent.absolute,
            BPC: false,
            prefix: '',
            suffix: '_to_*_Absolute.it8'
        },
        {
            intent: defs.eIntent.relative,
            BPC: false,
            prefix: '',
            suffix: '_to_*_Relative.it8'
        },
        {
            intent: defs.eIntent.perceptual,
            BPC: false,
            prefix: '',
            suffix: '_to_*_Perceptual.it8'
        },
        {
            intent: defs.eIntent.perceptual,
            BPC: true,
            prefix: '',
            suffix: '_to_*_Perceptual_BPC.it8'
        },
        {
            intent: defs.eIntent.relative,
            BPC: true,
            prefix: '',
            suffix: '_to_*_Relative_BPC.it8'
        },
    ]

    var combinations = [
        {
            profile: 'AdobeRGB1998.icc',
            runTests: true,
            failAfter: 9 // due to rounding errors some extemene gamut colors are not accurate
        },
        {
            profile: 'sRGB_v4_ICC_preference.icc',
            runTests: true,
            failAfter: 9
        },
        {
            profile: 'USSheetfedCoated.icc',
            runTests: true
        },
        {
            profile: 'ISOcoated_v2_grey1c_bas.ICC',
            runTests: true
        },
        {
            profile: 'RISO_MZ770_Black.icc',
            runTests: true
        },
        {
            profile: 'RISO_MZ770_RedGreen.icc',
            runTests: true
        },
        {
            profile: 'RISO_MZ770_RedYellowBlue.icc',
        },
        {
            profile: 'RISO_MZ770_YellowBlueTeal.icc',
        },
        {
            profile: 'UncoatedFOGRA29.icc',
        },
        {
            profile: 'sRGB Color Space Profile.icm',
        },
    ];

    // Add hardcoded profiles
    var profileNames = [
        '*lab',
        '*srgb',
        '*adobe'
    ];

    combinations.forEach(combination => {
        // if (profileNames.indexOf(combination.input) === -1) {
        //     profileNames.push(combination.input);
        // }
        if (profileNames.indexOf(combination.profile) === -1) {
            profileNames.push(combination.profile);
        }
    });

    console.log("Loading profiles...")

    console.log(profileNames);

    var testCount = 0;
    var totalPass = 0;
    var totalWarn = 0;
    var pauseOnTest = -1;

    profileNames.forEach((profileFilename) => {
        let url = (profileFilename.substring(0,1) === '*') ? profileFilename : profileFolder + profileFilename;
        loader.add(url, profileFilename,  true)
    });

    await loader.loadAll();

    // let adobe = await loader.get('*adobe');
    // console.log(adobe.RGBMatrix.XYZMatrix)
    // console.log(adobe.RGBMatrix.XYZMatrixInv)
    // let adobe2 = await loader.get("AdobeRGB1998.icc");
    // console.log(adobe2.RGBMatrix.XYZMatrix)
    // console.log(adobe2.RGBMatrix.XYZMatrixInv)
    // debugger;

    if(run.validation){
        await validateInterpolations(loader);
    }

    for (const [i, combination] of combinations.entries()) {
        if(combination.runTests){
            let labProfile = await loader.get('*lab');
            let sRGBProfile = await loader.get('sRGB Color Space Profile.icm');

            let deviceProfile = await loader.get(combination.profile);
            if (!deviceProfile) {
                throw new Error("Device Profile profile not found: " + combination.deviceProfile);
            }

            if(run.lab2Device){
                await testTransformLab2Device(labProfile, deviceProfile, combination.profile, 'lab', combination.failAfter);
            }

            if(run.device2Lab){
                await testTransformDevice2Lab_or_RGB(deviceProfile, labProfile, combination.profile, 'lab', combination.failAfter);
            }

            if(run.device2Rgb){
                await testTransformDevice2Lab_or_RGB(deviceProfile, sRGBProfile, combination.profile, 'srgb', combination.failAfter);
            }


        }
    }

    let totalPassed = totalPass + totalWarn;
    let totalFailed = testCount - totalPassed;
    console.log('%c   COMPLETED ' + testCount + ' TESTS - ' + (totalPassed) + ' PASSED inc ' + totalWarn + ' PASSED WITH SOME FAILS ', 'background: yellow; color: darkgreen; font-size: 20px');
    if(totalFailed > 0){
        console.log('%c   ' + totalFailed + ' FAILED   ', 'background: red; color: yellow; font-size: 20px');
    }
    async function validateInterpolations(loader){
        let rgb1 = await loader.get('RISO_MZ770_RedYellowBlue.icc');
        let rgb2 = await loader.get('RISO_MZ770_YellowBlueTeal.icc');
        let cmyk1 = await loader.get('UncoatedFOGRA29.icc');
        let cmyk2 = await loader.get('USSheetfedCoated.icc');
        let transformValidate
        let iterations = 5;


        console.log('%c Testing 3 Channel to 3 Channel interpolation', 'color: yellow');
        transformValidate = new TransformTest({
            BPC: false,
            dataFormat: 'int8',
            builtLut: true,
            interpolationFast: false
        });
        transformValidate.create(rgb1, rgb2, defs.eIntent.relative);
        transformValidate.speedTest(iterations);
        transformValidate.validateInterpolation();

        console.log('%c Testing 3 Channel to 4 Channel interpolation', 'color: yellow');
        transformValidate = new TransformTest({
            BPC: false,
            dataFormat: 'int8',
            builtLut: true,
            interpolationFast: false
        });
        transformValidate.create(rgb1, cmyk2, defs.eIntent.relative);
        transformValidate.speedTest(iterations);
        transformValidate.validateInterpolation();

        console.log('%c Testing 4 Channel to 3 Channel interpolation', 'color: yellow');
        transformValidate = new TransformTest({
            BPC: false,
            dataFormat: 'int8',
            builtLut: true,
            interpolationFast: false
        });
        transformValidate.create(cmyk1, rgb2, defs.eIntent.relative);
        transformValidate.speedTest(iterations);
        transformValidate.validateInterpolation();

        console.log('%c Testing 4 Channel to 4 Channel interpolation', 'color: yellow');
        transformValidate = new TransformTest({
            BPC: false,
            dataFormat: 'int8',
            builtLut: true,
            interpolationFast: false
        });
        transformValidate.create(cmyk1, cmyk2, defs.eIntent.relative);
        transformValidate.speedTest(iterations);
        transformValidate.validateInterpolation();

    }


    async function testTransformDevice2Lab_or_RGB(inputProfile, labOrSrgbProfile, profileFilename, type, failAfter) {
        failAfter = failAfter || 1;
        var testData = await loadTestData(profileFilename, device2LabTests, type );

        //
        //
        //
        var precision = 0.01;

        console.log(" ")
        console.log("--------------------------------------------------")
        console.log("Testing transform from " + inputProfile.name + " to " + labOrSrgbProfile.name + ' at precision ' + precision);

        testData.forEach(test => {

            testCount++;

            if(pauseOnTest === testCount){
                debugger;
            }

            console.log(test.url);
            let transform = new TransformTest({
                BPC: test.BPC,
                dataFormat: 'objectFloat',
                pipelineDebug: true,
                //simulateLCMSQuantizedInterpolation: true
            });

            let transformTest = new TransformTest({
                BPC: test.BPC,
                dataFormat: 'objectFloat',
                //pipelineDebug: true
                //simulateLCMSQuantizedInterpolation: true
            });

            let transformSpeed = new TransformTest({
                BPC: test.BPC,
                dataFormat: 'objectFloat',
            });

            transform.create(inputProfile, labOrSrgbProfile, test.intent);
            transformSpeed.create(inputProfile, labOrSrgbProfile, test.intent);

            testSpeed(transformSpeed, inputProfile)



            let minLR = 100000;
            let maxLR = -100000;
            let minAG = 100000;
            let maxAG = -100000;
            let minBG = 100000;
            let maxBG = -100000;
            let passed = true;
            let errStr = '';
            let passCount = 0;
            let failCount = 0;
            let showDifferenceCount = 3;
            let failList = [];
            let failed = false;
            let warnCount = 0;
            let stopOnError = true;

            test.CGATS.data.forEach(data => {

                let input;
                let inputStr = '';
                precision = 0.01;
                switch (inputProfile.colorSpace){
                    case 'GRAY':
                        input = convert.Gray(data.IN_GRAY , false);
                        inputStr = data.IN_GRAY;
                        break;
                    case '2CLR':
                        data.IN_CH1 *= 100;
                        data.IN_CH2 *= 100;
                        input = convert.Duo(data.IN_CH1 , data.IN_CH2, false);
                        inputStr = data.IN_CH1 + ', ' + data.IN_CH2;
                        break;
                    case 'RGB':
                        input = convert.RGB(data.IN_RGB_R, data.IN_RGB_G, data.IN_RGB_B, false);
                        inputStr = data.IN_RGB_R + ', ' + data.IN_RGB_G + ', ' + data.IN_RGB_B;
                        precision = 0.1 ;
                        break;
                    case 'CMYK':
                        input = convert.CMYK(data.IN_CMYK_C, data.IN_CMYK_M, data.IN_CMYK_Y, data.IN_CMYK_K, false);
                        inputStr = data.IN_CMYK_C + ', ' + data.IN_CMYK_M + ', ' + data.IN_CMYK_Y + ', ' + data.IN_CMYK_K;
                        break;
                    default:
                        throw  new Error('Unknown color space ' + inputProfile.colorSpace);

                }

                let output = transform.transform(input);

                switch(labOrSrgbProfile.colorSpace){
                    case "LAB":
                        // CLIP LAB to valid range for PCS
                        output.L = Math.min(Math.max(output.L, 0), 100);
                        output.a = Math.min(Math.max(output.a, -128), 127);
                        output.b = Math.min(Math.max(output.b, -128), 127);

                        data.OUT_LAB_L = Math.min(Math.max(data.OUT_LAB_L, 0), 100);
                        data.OUT_LAB_A = Math.min(Math.max(data.OUT_LAB_A, -128), 127);
                        data.OUT_LAB_B = Math.min(Math.max(data.OUT_LAB_B, -128), 127);

                        let deltaL = Math.abs(output.L - data.OUT_LAB_L);
                        let deltaA = Math.abs(output.a - data.OUT_LAB_A);
                        let deltaB = Math.abs(output.b - data.OUT_LAB_B);

                        if(deltaL < minLR && deltaL !== 0){ minLR = deltaL; }
                        if(deltaL > maxLR){ maxLR = deltaL; }

                        if(deltaA < minAG && deltaA !== 0){ minAG = deltaA; }
                        if(deltaA > maxAG){ maxAG = deltaA; }

                        if(deltaB < minBG && deltaB !== 0){ minBG = deltaB; }
                        if(deltaB > maxBG){ maxBG = deltaB; }

                        // check if within precision
                        if( Math.abs(output.L - data.OUT_LAB_L) <= precision &&
                            Math.abs(output.a - data.OUT_LAB_A) <= precision &&
                            Math.abs(output.b - data.OUT_LAB_B) <= precision
                        ) {
                            passCount++;
                        } else {
                            failCount++;
                            if(failCount < failAfter){
                                warnCount++;
                                failCount++;
                                break;
                            }

                            passed = false;

                            errStr = 'Device: ' + (inputStr) + ' -> ' +
                                output.L + ', ' + output.a + ', ' + output.b + ' != ' +
                                data.OUT_LAB_L + ', ' + data.OUT_LAB_A  + ', ' + data.OUT_LAB_B;

                            if(stopOnError){
                                console.warn(convert.intent2String(test.intent) +'(' + test.intent + ') BPC='+ (test.BPC ? 'ON' : 'OFF'))

                                console.warn(transform.historyInfo());
                                debugger;
                                transformTest.create(inputProfile, labOrSrgbProfile, test.intent);
                                let output2 = transformTest.transform(input);
                                stopOnError = false
                            }

                            if(failList.length < showDifferenceCount){
                                failList.push('            - ' + errStr);
                            }
                        }

                        break;

                    case "RGB":
                        // CLIP RGB to valid range AND scale to 255 (makes new props)
                        output.R = Math.min(Math.max(output.Rf * 255, 0), 255);
                        output.G = Math.min(Math.max(output.Gf * 255, 0), 255);
                        output.B = Math.min(Math.max(output.Bf * 255, 0), 255);

                        data.OUT_RGB_R = Math.min(Math.max(data.OUT_RGB_R, 0), 255);
                        data.OUT_RGB_G = Math.min(Math.max(data.OUT_RGB_G, 0), 255);
                        data.OUT_RGB_B = Math.min(Math.max(data.OUT_RGB_B, 0), 255);

                        if(roundRGBtoInt){
                            output.R = Math.round(output.R);
                            output.G = Math.round(output.G);
                            output.B = Math.round(output.B);
                            data.OUT_RGB_B = Math.round(data.OUT_RGB_B);
                            data.OUT_RGB_G = Math.round(data.OUT_RGB_G);
                            data.OUT_RGB_R = Math.round(data.OUT_RGB_R);
                        }

                        let deltaR = Math.abs(output.R - data.OUT_RGB_R);
                        let deltaG = Math.abs(output.G - data.OUT_RGB_G);
                        let deltaBl = Math.abs(output.B - data.OUT_RGB_B);

                        if(deltaR < minLR && deltaR !== 0){ minLR = deltaR; }
                        if(deltaR > maxLR){ maxLR = deltaR; }

                        if(deltaG < minAG && deltaG !== 0){ minAG = deltaG; }
                        if(deltaG > maxAG){ maxAG = deltaG; }

                        if(deltaBl < minBG && deltaBl !== 0){ minBG = deltaBl; }
                        if(deltaBl > maxBG){ maxBG = deltaBl; }


                        precision = 0.4; // RGB is trickier to get right, at <0.5 will still round to correct int

                        if( Math.abs(output.R - data.OUT_RGB_R) <= precision &&
                            Math.abs(output.G - data.OUT_RGB_G) <= precision &&
                            Math.abs(output.B - data.OUT_RGB_B) <= precision
                        ) {
                            passCount++;
                        } else {
                            if(failCount < failAfter){
                                warnCount++;
                                failCount++;
                                break;
                            }
                            failCount++;
                            passed = false;

                            errStr = 'Device: ' + (inputStr) + ' -> ' +
                                output.R + ', ' + output.G + ', ' + output.B + ' != ' +
                                data.OUT_RGB_R + ', ' + data.OUT_RGB_G + ', ' + data.OUT_RGB_B;

                            if (stopOnError) {
                                console.log(errStr);
                                console.warn(convert.intent2String(test.intent) + '(' + test.intent + ') BPC=' + (test.BPC ? 'ON' : 'OFF'))
                                console.warn(transform.historyInfo());

                                debugger;
                                transformTest.create(inputProfile, labOrSrgbProfile, test.intent);
                                let output2 = transformTest.transform(input);
                                stopOnError = false
                            }

                            if (failList.length < showDifferenceCount) {
                                failList.push('            - ' + errStr);
                            }


                        }
                        break;
                }



            });

            var passPercent = Math.round(passCount / (passCount + failCount) * 100).toFixed(4);

            var result = ('TEST ' + testCount + ' RESULT ' + passPercent + '% same with ' + defs.intent2String(test.intent) + '(' + test.intent +') intent BPC=' +  (test.BPC ? 'ON' : 'OFF')  + ' (' + passCount + ' same, ' + failCount + ' different.)')
            if(!passed){
                console.log('%c' + result, 'color: red')
                if(failList.length > 0){
                    failList.forEach(fail => {
                        console.log('%c' + fail, 'color: red');
                    });
                }
            } else if (warnCount > 0) {
                totalWarn++;
                console.log('%c' + result + ' (' + warnCount + ' WARNINGS)', 'color: orange')
            } else{
                totalPass++;
                console.log('%c' + result, 'color: lime')
            }

            if(labOrSrgbProfile.colorSpace === 'LAB'){
                console.log('%c  - L delta min: ' + minLR.toFixed(7) + ' max: ' + maxLR.toFixed(7) + ' (0-100) Precession +-' + precision, 'color: lightblue');
                console.log('%c  - a delta min: ' + minAG.toFixed(7) + ' max: ' + maxAG.toFixed(7) + ' (-128-127) Precession +-' + precision, 'color: lightblue');
                console.log('%c  - b delta min: ' + minBG.toFixed(7) + ' max: ' + maxBG.toFixed(7) + ' (-128-127) Precession +-' + precision, 'color: lightblue');
            } else {
                console.log('%c  - R delta min: ' + minLR.toFixed(7) + ' max: ' + maxLR.toFixed(7) + ' (0-255) Precession +-' + precision, 'color: lightblue');
                console.log('%c  - G delta min: ' + minAG.toFixed(7) + ' max: ' + maxAG.toFixed(7) + ' (0-255) Precession +-' + precision, 'color: lightblue');
                console.log('%c  - B delta min: ' + minBG.toFixed(7) + ' max: ' + maxBG.toFixed(7) + ' (0-255) Precession +-' + precision, 'color: lightblue');

            }

        })



    }

    function createRandomData(count, colorSpace){

        switch(colorSpace){
            case 'LAB':
                var labData = [];
                for(var i = 0; i < count; i++){
                    labData.push(convert.Lab(
                        Math.random() * 100,
                        Math.random() * 255 - 128,
                        Math.random() * 255 - 128,
                        convert.d50
                    ));
                }
                return labData;
            case 'RGB':
                var rgbData = [];
                for(var i = 0; i < count; i++){
                    rgbData.push(convert.RGB(
                        Math.random() * 255,
                        Math.random() * 255,
                        Math.random() * 255,
                    ));
                }
                return rgbData;
            case 'GRAY':
                var grayData = [];
                for(var i = 0; i < count; i++){
                    grayData.push(convert.Gray(
                        Math.random() * 255,
                    ));
                }
                return grayData;
            case '2CLR':
                var duoData = [];
                for(var i = 0; i < count; i++){
                    duoData.push(convert.Duo(
                        Math.random() * 100,
                        Math.random() * 100,
                    ));
                }
                return duoData;
            case 'CMYK':
                var cmykData = [];
                for(var i = 0; i < count; i++){
                    cmykData.push(convert.CMYK(
                        Math.random() * 100,
                        Math.random() * 100,
                        Math.random() * 100,
                        Math.random() * 100,
                    ));
                }
                return cmykData;
            default:
                throw new Error('Unknown color space ' + colorSpace);
        }

    }

    function testSpeed(transform, inputProfile){

        var iterations = 2000000;
        var inputColorSpace = inputProfile.colorSpace;
        var data = createRandomData(iterations, inputColorSpace);
        var start = performance.now();
        for(var i = 0; i < iterations; i++){
            transform.transform(data[i]);
        }
        var end = performance.now();
        var time = end - start;
        var speed = Math.round(iterations / time * 1000);
        var millionPerSec = Math.round(speed / 1000000 * 1000) / 1000;
        console.log('%c Speed: ' + millionPerSec + ' million transforms per second', 'color: yellow');

    }


    async function testTransformLab2Device(labProfile, outputProfile, profileFilename, type, failAfter) {
        failAfter = failAfter || 0;
        var testData = await loadTestData(profileFilename, lab2DeviceTests, type);

        // 3 decimals precision
        let precision = 0.001;
        let inputScale = getDeviceColorScale(outputProfile.colorSpace);
        precision *= inputScale;

        if(outputProfile.colorSpace === 'RGB'){
            //RGB is trickery to get right, at <0.5 will still round to correct int
            precision = 0.4;
        }

        console.log(" ")
        console.log("--------------------------------------------------")
        console.log("Testing transform from " + labProfile.name + " to " + outputProfile.name + ' at precision ' + precision);





        testData.forEach(test => {

            testCount++;

            if(pauseOnTest === testCount){
                debugger;
            }

            let transform = new TransformTest({
                BPC: test.BPC,
                dataFormat: 'objectFloat',
                pipelineDebug: true
            });

            let transformTest = new TransformTest({
                BPC: test.BPC,
                dataFormat: 'objectFloat',
                //pipelineDebug: true
            });
            let transformSpeed = new TransformTest({
                BPC: test.BPC,
                dataFormat: 'objectFloat',
            });

            transform.create(labProfile, outputProfile, test.intent);
            transformSpeed.create(labProfile, outputProfile, test.intent);

            testSpeed(transformSpeed, labProfile)


            // Show how the profile is optimised
            //console.log(transform.getStageNames(true, false));

            let passCount = 0;
            let failCount = 0;
            let showDifferenceCount = 6;
            let failList = [];
            let passed = true;
            let minMax = false;
            let delta= 0;
            var m,errStr
            var warnCount = 0;
            var stopOnError = true;

            test.CGATS.data.forEach(data => {
                passed = true;
                let input  = convert.Lab(data.IN_LAB_L, data.IN_LAB_A, data.IN_LAB_B, convert.d50)

                let output = transform.transform(input);

                switch (outputProfile.colorSpace){
                    case 'GRAY':
                        output.Gf *= 255;

                        if(minMax === false){
                            minMax = [
                                { min: 100000, max: -100000, key1: 'Gf', key2: 'OUT_GRAY' }
                            ]
                        }
                        for(m = 0 ; m < 1; m++){
                            delta = Math.abs(output[minMax[m].key1] - data[minMax[m].key2]);
                            // We will always have 255 or 100 so not interested in zero deltas
                            if(delta < minMax[m].min && delta !== 0){ minMax[m].min = delta; }
                            if(delta > minMax[m].max){ minMax[m].max = delta; }
                        }

                        if( cp(output.Gf, data.OUT_GRAY)  ) {
                            passCount++;
                        } else {
                            failCount++;
                            if(failCount < failAfter){
                                warnCount++;
                                failCount++;
                                break;
                            }

                            passed= false;

                             errStr = 'Lab: ' + input.L + ', ' + input.a + ', ' + input.b + ' -> ' +
                            output.Gf  + ' != ' +
                            data.OUT_GRAY

                            if(stopOnError){
                                console.log(convert.intent2String(test.intent) + ' BPC='+ (test.BPC ? 'ON' : 'OFF'))
                                console.log(transform.historyInfo());;
                                debugger;
                                transformTest.create(labProfile, outputProfile, test.intent);
                                let output2 = transformTest.transform(input);
                                stopOnError = false ;
                            }

                            if(failList.length < showDifferenceCount){
                                failList.push('            - ' + errStr);
                            }
                        }
                    break;
                        case '2CLR':

                        if(minMax === false){
                            minMax = [
                                { min: 100000, max: -100000, key1: 'af', key2: 'OUT_CH1' },
                                { min: 100000, max: -100000, key1: 'bf', key2: 'OUT_CH1' },
                            ]
                        }
                        for(m = 0 ; m < 2; m++){
                            delta = Math.abs(output[minMax[m].key1] - data[minMax[m].key2]);
                            if(delta < minMax[m].min  && delta !== 0){ minMax[m].min = delta; }
                            if(delta > minMax[m].max){ minMax[m].max = delta; }
                        }

                        if( cp(output.af, data.OUT_CH1) && cp(output.bf, data.OUT_CH2) ) {
                            passCount++;
                        } else {
                            failCount++;
                            if(failCount < failAfter){
                                warnCount++;
                                failCount++;
                                break;
                            }

                            passed= false;

                            errStr = 'Lab: ' + input.L + ', ' + input.a + ', ' + input.b + ' -> ' +
                                output.af + ', ' + output.bf + ' != ' +
                                data.OUT_CH1 + ', ' + data.OUT_CH2;

                            if(stopOnError){
                                console.log(convert.intent2String(test.intent) + ' BPC='+ (test.BPC ? 'ON' : 'OFF'))
                                console.log(transform.historyInfo());;
                                debugger;
                                transformTest.create(labProfile, outputProfile, test.intent);
                                let output2 = transformTest.transform(input);
                                stopOnError = false ;
                            }


                            if(failList.length < showDifferenceCount){
                                failList.push('            - ' + errStr);
                            }
                        }
                        break;
                    case 'RGB':

                        output.Rf = Math.min(Math.max(output.Rf, 0), 1);
                        output.Gf = Math.min(Math.max(output.Gf, 0), 1);
                        output.Bf = Math.min(Math.max(output.Bf, 0), 1);

                        output.Rf *= 255;
                        output.Gf *= 255;
                        output.Bf *= 255;

                        data.OUT_RGB_R = Math.min(Math.max(data.OUT_RGB_R, 0), 255);
                        data.OUT_RGB_G = Math.min(Math.max(data.OUT_RGB_G, 0), 255);
                        data.OUT_RGB_B = Math.min(Math.max(data.OUT_RGB_B, 0), 255);

                        if(roundRGBtoInt){
                            output.Rf = Math.round(output.Rf);
                            output.Gf = Math.round(output.Gf);
                            output.Bf = Math.round(output.Bf);
                            data.OUT_RGB_B = Math.round(data.OUT_RGB_B);
                            data.OUT_RGB_G = Math.round(data.OUT_RGB_G);
                            data.OUT_RGB_R = Math.round(data.OUT_RGB_R);
                        }


                        if(minMax === false){
                            minMax = [
                                { min: 100000, max: -100000, key1: 'Rf', key2: 'OUT_RGB_R' },
                                { min: 100000, max: -100000, key1: 'Gf', key2: 'OUT_RGB_G' },
                                { min: 100000, max: -100000, key1: 'Bf', key2: 'OUT_RGB_B' },
                            ]
                        }
                        for(m = 0 ; m < 3; m++){
                            delta = Math.abs(output[minMax[m].key1] - data[minMax[m].key2]);
                            if(delta < minMax[m].min && delta !== 0){ minMax[m].min = delta; }
                            if(delta > minMax[m].max){ minMax[m].max = delta; }
                        }

                        if( cp(output.Rf, data.OUT_RGB_R) && cp(output.Gf, data.OUT_RGB_G) && cp(output.Bf, data.OUT_RGB_B) ) {
                            passCount++;
                        } else {
                            failCount++;
                            if(failCount < failAfter){
                                warnCount++;
                                failCount++;
                                break;
                            }
                            passed= false;

                            errStr = 'Lab: ' + input.L + ', ' + input.a + ', ' + input.b + ' -> ' +
                                output.Rf + ', ' + output.Gf + ', ' + output.Bf + ' != ' +
                                data.OUT_RGB_R + ', ' + data.OUT_RGB_G  + ', ' + data.OUT_RGB_B;


                            if(stopOnError){
                                console.log(errStr)
                                console.log(convert.intent2String(test.intent) + ' BPC='+ (test.BPC ? 'ON' : 'OFF'))
                                console.log(transform.historyInfo());
                                debugger;
                                transformTest.create(labProfile, outputProfile, test.intent);
                                let output2 = transformTest.transform(input);
                                stopOnError = false ;
                            }

                            if(failList.length < showDifferenceCount){
                                failList.push('            - ' + errStr);
                            }
                        }
                        break;
                    case 'CMYK':

                        output.Cf *= 100;
                        output.Mf *= 100;
                        output.Yf *= 100;
                        output.Kf *= 100;


                        if(minMax === false){
                            minMax = [
                                { min: 100000, max: -100000, key1: 'Cf', key2: 'OUT_CMYK_C' },
                                { min: 100000, max: -100000, key1: 'Mf', key2: 'OUT_CMYK_M' },
                                { min: 100000, max: -100000, key1: 'Yf', key2: 'OUT_CMYK_Y' },
                                { min: 100000, max: -100000, key1: 'Kf', key2: 'OUT_CMYK_K' },
                            ]
                        }
                        for(m = 0 ; m < 4; m++){
                            delta = Math.abs(output[minMax[m].key1] - data[minMax[m].key2]);
                            if(delta < minMax[m].min && delta !== 0){ minMax[m].min = delta; }
                            if(delta > minMax[m].max){ minMax[m].max = delta; }
                        }

                        if( cp(output.Cf, data.OUT_CMYK_C) && cp(output.Mf, data.OUT_CMYK_M) && cp(output.Yf, data.OUT_CMYK_Y) && cp(output.Kf, data.OUT_CMYK_K) ) {
                            passCount++;
                        } else {
                            failCount++;

                            if(failCount < failAfter){
                                warnCount++;
                                failCount++;
                                break;
                            }
                            passed = false;

                            errStr = 'Lab: ' +
                                input.L + ', ' + input.a + ', ' + input.b + ' -> ' +
                                output.Cf + ', ' + output.Mf+ ', ' + output.Yf+ ', ' + output.Kf+ ' != ' +
                                data.OUT_CMYK_C + ', ' + data.OUT_CMYK_M  + ', ' + data.OUT_CMYK_Y + ', ' + data.OUT_CMYK_K;

                            if(stopOnError){
                                console.log(convert.intent2String(test.intent) + ' BPC='+ (test.BPC ? 'ON' : 'OFF'))
                                console.log(transform.historyInfo());
                                debugger;
                                transformTest.create(labProfile, outputProfile, test.intent);
                                let output2 = transformTest.transform(input);
                                stopOnError = false ;
                            }

                            if(failList.length < showDifferenceCount){
                                failList.push('            - ' + errStr);
                            }
                        }
                        break;
                    default:
                        throw  new Error('Unknown color space ' + outputProfile.colorSpace);

                }
            });

            var passPercent = Math.round(passCount / (passCount + failCount) * 100).toFixed(4);

            var result = ('TEST ' + testCount + ' RESULT ' +passPercent + '% same with ' + defs.intent2String(test.intent) + '(' + test.intent +') intent BPC=' +  (test.BPC ? 'ON' : 'OFF')  + ' (' + passCount + ' same, ' + failCount + ' different.)')
            if(!passed){
                console.log('%c' + result, 'color: red')
                if(failList.length > 0){
                    failList.forEach(fail => {
                        console.log('%c' + fail, 'color: red');
                    });
                }
            } else if (warnCount > 0) {
                totalWarn++;
                console.log('%c' + result + ' (' + warnCount + ' WARNINGS)', 'color: orange')
            } else {
                totalPass++;
                console.log('%c' + result, 'color: lime')
            }


            for(m = 0; m < minMax.length; m++){
                console.log('%c  - ' + minMax[m].key1 + ' delta min: ' + minMax[m].min.toFixed(7) + ' max: ' + minMax[m].max.toFixed(7) + ' (0-' + inputScale + ') Precession +-' + precision, 'color: lightblue');
            }
            function cp(a, b){
                return Math.abs(a - b) <= precision;
            }

        });
    }


    function getDeviceColorScale(colorSpace){
        var inputScale = 1;
        switch (colorSpace){
            case 'GRAY': // Gray
                inputScale = 255;
                break;
            case '2CLR':
                inputScale = 1;
                break;
            case 'RGB':
                inputScale = 255;
                break;
            case 'CMYK':
                inputScale = 100;
                break;
        }
        return inputScale;
    }


    async function loadTestData(dataFilename, tests, type) {

        try {
            const filePromises = tests.map(async test => {
                var url = testDataFolder + test.prefix.replace('*',type) + dataFilename + test.suffix.replace('*',type);
                const response = await fetch(url);

                if (!response.ok) {
                    throw new Error(`Error fetching ${url}: ${response.status}`);
                }

                const contents = await response.text();
                return {
                    intent: test.intent,
                    BPC: test.BPC,
                    url: url,
                    contents: contents,
                    CGATS: false
                };
            });

            const testsWithData = await Promise.all(filePromises);

            // parse
            testsWithData.forEach(test => {
                test.CGATS = parseCGATS(test.contents);
            });

            return testsWithData;

        } catch (error) {
            console.error("Error loading files:", error);
            return [];
        }
    }

    function parseCGATS(content) {
        const lines = content.split('\n');
        let dataFormat = [];
        let inDataFormatSection = false;
        let inDataSection = false;
        let data = [];

        lines.forEach(line => {
            line = line.trim();

            if (line.startsWith('BEGIN_DATA_FORMAT')) {
                inDataFormatSection = true;
                inDataSection = false;
            } else if (line.startsWith('END_DATA_FORMAT')) {
                inDataFormatSection = false;
            } else if (line.startsWith('BEGIN_DATA')) {
                inDataSection = true;
            } else if (line.startsWith('END_DATA')) {
                inDataSection = false;
            } else {
                if (inDataFormatSection) {
                    // Parse the data format
                    dataFormat = line.split(/\s+/);
                } else if (inDataSection) {
                    // Parse the data line
                    const values = line.split(/\s+/);
                    let dataEntry = {};
                    dataFormat.forEach((key, index) => {
                        dataEntry[key] = parseFloat(values[index]);
                    });
                    data.push(dataEntry);
                }
            }
        });

        return {
            data,
            dataFormat
        };
    }



    function parseHeader(header) {
        let headerData = {};
        for (let line of header) {
            let key = line.split(':')[0].trim();
            let value = line.split(':')[1].trim();
            headerData[key] = value;
        }
        return headerData;
    }

}

window.addEventListener('load', function () {
    start();
})
