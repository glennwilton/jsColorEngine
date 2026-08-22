const {Transform, eIntent, color, eColourType} = require('../src/main');
const path = require("path");
const Profile = require("../src/Profile");

let cmykFilename = path.join(__dirname, './GRACoL2006_Coated1v2.icc');


test('sRGB to CMYK via LUT ', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename)

    expect(cmykProfile.loaded).toBe(true);

    let rgb2CMYK = new Transform({
        dataFormat: 'int8',
        builtLut: true
    });
    rgb2CMYK.create('*srgb', cmykProfile, eIntent.relative);

    let input = [
        150,100,50,
        50,50,50,
        200,200,200,
        0,0,0,
        255,255,255
    ];

    let output = rgb2CMYK.transformArrayViaLUT(input);
    expect(rgb2CMYK.lastUsedKernel).toBe('kernel3D');
    expect(output).toBeInstanceOf(Uint8ClampedArray);
    expect(output).toEqual(  new Uint8ClampedArray([
            94, 157, 243, 40,
            202, 182, 177, 171,
            62,  46, 46,0,
            205, 183,174, 255,
            0,  0,   0,   0
    ]));
});



test('sRGB+Alpha to CMYK via LUT ', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename)

    expect(cmykProfile.loaded).toBe(true);

    let rgb2CMYK = new Transform({
        dataFormat: 'int8',
        builtLut: true
    });
    rgb2CMYK.create('*srgb', cmykProfile, eIntent.relative);

    let input = [
        150,100,50,     200,
        50,50,50,       200,
        200,200,200,    200,
        0,0,0,          200,
        255,255,255,    200,
    ];

    let output = rgb2CMYK.transformArrayViaLUT(input, true, false);
    expect(rgb2CMYK.lastUsedKernel).toBe('kernel3D');
    expect(output).toBeInstanceOf(Uint8ClampedArray);
    expect(output).toEqual( new Uint8ClampedArray([
        94, 157, 243, 40,
        202, 182, 177, 171,
        62,  46, 46, 0,
        205, 183, 174, 255,
        0,  0,   0,   0
    ]));
});

test('sRGB+Alpha to CMYK+Alpha via LUT ', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename)

    expect(cmykProfile.loaded).toBe(true);

    let rgb2CMYK = new Transform({
        dataFormat: 'int8',
        builtLut: true
    });
    rgb2CMYK.create('*srgb', cmykProfile, eIntent.relative);

    let input = [
        150,100,50,     200,
        50,50,50,       200,
        200,200,200,    200,
        0,0,0,          200,
        255,255,255,    200,
    ];

    let output = rgb2CMYK.transformArrayViaLUT(input, true, true, false);
    expect(rgb2CMYK.lastUsedKernel).toBe('kernel3D');
    expect(output).toBeInstanceOf(Uint8ClampedArray);
    expect(output).toEqual(  new Uint8ClampedArray([
        94, 157, 243, 40,       255,
        202, 182, 177, 171,     255,
        62, 46, 46, 0,          255,
        205, 183,174, 255,      255,
        0,  0,   0,   0,        255
    ]));
});

test('sRGB+Alpha to CMYK+Alpha via LUT with PRESERVE Alpha ', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename)

    expect(cmykProfile.loaded).toBe(true);

    let rgb2CMYK = new Transform({
        dataFormat: 'int8',
        builtLut: true
    });
    rgb2CMYK.create('*srgb', cmykProfile, eIntent.relative);

    let input = [
        150,100,50,     200,
        50,50,50,       200,
        200,200,200,    200,
        0,0,0,          200,
        255,255,255,    200,
    ];

    let output = rgb2CMYK.transformArrayViaLUT(input, true, true, true);
    expect(rgb2CMYK.lastUsedKernel).toBe('kernel3D');
    expect(output).toBeInstanceOf(Uint8ClampedArray);
    expect(output).toEqual(  new Uint8ClampedArray([
        94, 157, 243, 40,       200,
        202, 182, 177, 171,     200,
        62, 46, 46, 0,          200,
        205, 183,174, 255,      200,
        0,  0,   0,   0,        200
    ]));
});

test('sRGB+Alpha to CMYK+Alpha via LUT with PRESERVE Alpha with length of 3', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename)

    expect(cmykProfile.loaded).toBe(true);

    let rgb2CMYK = new Transform({
        dataFormat: 'int8',
        builtLut: true
    });
    rgb2CMYK.create('*srgb', cmykProfile, eIntent.relative);

    let input = [
        150,100,50,     200,
        50,50,50,       200,
        200,200,200,    200,
        0,0,0,          200,
        255,255,255,    200,
    ];

    let output = rgb2CMYK.transformArrayViaLUT(input, true, true, true, 3);
    expect(rgb2CMYK.lastUsedKernel).toBe('kernel3D');
    expect(output).toBeInstanceOf(Uint8ClampedArray);
    expect(output).toEqual(  new Uint8ClampedArray([
        94, 157, 243, 40,       200,
        202, 182, 177, 171,     200,
        62, 46, 46, 0,          200
    ]));
});

test('transformArrayViaLUT supports reusable output buffer', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    expect(cmykProfile.loaded).toBe(true);

    let rgb2CMYK = new Transform({
        dataFormat: 'int8',
        builtLut: true
    });
    rgb2CMYK.create('*srgb', cmykProfile, eIntent.relative);

    let input = [
        150,100,50,
        50,50,50,
        200,200,200
    ];
    let out = new Uint8ClampedArray(20);

    let output = rgb2CMYK.transformArrayViaLUT(input, false, false, false, 3, out);
    expect(rgb2CMYK.lastUsedKernel).toBe('kernel3D');
    expect(output).toBe(out);
    expect(output.slice(0, 12)).toEqual(new Uint8ClampedArray([
        94, 157, 243, 40,
        202, 182, 177, 171,
        62, 46, 46, 0
    ]));
});

test('transformArray forwards reusable output buffer on LUT route', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    expect(cmykProfile.loaded).toBe(true);

    let rgb2CMYK = new Transform({
        dataFormat: 'int8',
        builtLut: true
    });
    rgb2CMYK.create('*srgb', cmykProfile, eIntent.relative);

    let input = [
        150,100,50,
        50,50,50,
        200,200,200
    ];
    let out = new Uint8ClampedArray(20);

    let output = rgb2CMYK.transformArray(input, false, false, false, 3, undefined, out);
    expect(rgb2CMYK.lastUsedKernel).toBe('kernel3D');
    expect(output).toBe(out);
    expect(output.slice(0, 12)).toEqual(new Uint8ClampedArray([
        94, 157, 243, 40,
        202, 182, 177, 171,
        62, 46, 46, 0
    ]));
});
