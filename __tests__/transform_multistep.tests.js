const {Transform, eIntent, color, eColourType} = require('../src/main');
const path = require("path");
const Profile = require("../src/Profile");

let cmykFilename = path.join(__dirname, './GRACoL2006_Coated1v2.icc');


test('multi Stage - sRGB->relative->CMYK->relative->adobeRGB ', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename)

    expect(cmykProfile.loaded).toBe(true);

    let rgb2CMYK2rgb = new Transform({
        dataFormat: 'int8',
    });
    rgb2CMYK2rgb.createMultiStage(['*srgb', eIntent.relative, cmykProfile, eIntent.relative, '*adobe1998']);

    let input = [
        150,100,50,
        50,50,50,
        200,200,200,
        0,0,0,
        255,255,255
    ];

    let output = rgb2CMYK2rgb.transformArray(input);
    // transformArray() returns a TYPED array, matching dataFormat -- it used to
    // hand back an untyped Array on the non-LUT route only, so which container
    // you got depended on whether a LUT was built. Uint8ClampedArray is
    // array-like but is NOT an instanceof Array, hence the explicit check.
    expect(ArrayBuffer.isView(output)).toBe(true);
    expect(Array.from(output)).toEqual([
        139, 101, 59,
        53, 53, 54,
        199, 199, 199,
        33, 32, 32, //<---- As  expected CMYK black is lighter than RGB black
        255, 255, 255
    ]);
});


test('multi Stage - sRGB->perceptual->CMYK->relative->adobeRGB ', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename)

    expect(cmykProfile.loaded).toBe(true);

    let rgb2CMYK2rgb = new Transform({
        dataFormat: 'int8',
    });
    rgb2CMYK2rgb.createMultiStage(['*srgb', eIntent.perceptual, cmykProfile, eIntent.relative, '*adobe1998']);

    let input = [
        150,100,50,
        50,50,50,
        200,200,200,
        0,0,0,
        255,255,255
    ];

    let output = rgb2CMYK2rgb.transformArray(input);
    // transformArray() returns a TYPED array, matching dataFormat -- it used to
    // hand back an untyped Array on the non-LUT route only, so which container
    // you got depended on whether a LUT was built. Uint8ClampedArray is
    // array-like but is NOT an instanceof Array, hence the explicit check.
    expect(ArrayBuffer.isView(output)).toBe(true);
    expect(Array.from(output)).toEqual([
        138, 102, 61,
        60, 60, 60, //<---- grey is different as perceptual intent shifts lightness
        205, 205, 205,
        33,  32,  32, //<---- As  expected CMYK black is lighter than RGB black
        255, 255, 255
    ]);
});