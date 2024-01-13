const {Transform, eIntent, color, eColourType} = require('../src/main');
const path = require("path");
const Profile = require("../src/Profile");

let cmykFilename = path.join(__dirname, './GRACoL2006_Coated1v2.icc');

//TODO - Have a seperate file with known good transforms i.e Lab2RGB = { lab: {}, rgb: {} , rgbf: {} }

test('Lab to srgb as objectFloat', () => {
    let lab2srgb = new Transform({
        dataFormat: 'objectFloat'
    });
    lab2srgb.create('*lab', '*srgb', eIntent.absolute);
    let input = color.Lab(30,50,-20);
    let output = lab2srgb.transform(input);
    expect(output.Rf).toBeCloseTo(129/255);
    expect(output.Gf).toBeCloseTo(21/255);
    expect(output.Bf).toBeCloseTo(103/255);
    expect(output.type).toBe(eColourType.RGBf);
});

test('Lab to CMYK as objectFloat ', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename)

    expect(cmykProfile.loaded).toBe(true);

    let lab2CMYK = new Transform({
        dataFormat: 'objectFloat'
    });
    lab2CMYK.create('*lab', cmykProfile, eIntent.absolute);

    let input = color.Lab(30,50,-20);
    let output = lab2CMYK.transform(input);
    expect(output.Cf).toBeCloseTo(0.39420816003754827);
    expect(output.Mf).toBeCloseTo(1);
    expect(output.Yf).toBeCloseTo(0);
    expect(output.Kf).toBeCloseTo( 0.21425042968301292);
    expect(output.type).toBe(eColourType.CMYKf);
});

test('srgb to Lab as objectFloat', () => {
    let rgb2lab = new Transform({
        dataFormat: 'objectFloat'
    });
    rgb2lab.create('*srgb', '*lab', eIntent.absolute);
    let input = color.RGBf(200/255,150/255,50/255);
    let output = rgb2lab.transform(input);
    expect(output.L).toBeCloseTo(65.677112680158, 5);
    expect(output.a).toBeCloseTo(12.542727997170147, 5);
    expect(output.b).toBeCloseTo(57.14452940610417, 5);
    expect(output.whitePoint.desc).toBe('d50');
});


//
// ---------------------------------------------------------------------------------------------------------------
//

test('sRGB to CMYK as device ', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename)

    expect(cmykProfile.loaded).toBe(true);

    let lab2CMYK = new Transform({
        dataFormat: 'device'
    });
    lab2CMYK.create('*lab', cmykProfile, eIntent.absolute);

    let input = color.Lab(30,50,-20);

    // convert to PCS
    input = lab2CMYK.Lab2PCSv4(input);
    let output = lab2CMYK.transform(input);
    expect(output[0]).toBeCloseTo(0.39420816003754827);
    expect(output[1]).toBeCloseTo(1);
    expect(output[2]).toBeCloseTo(0);
    expect(output[3]).toBeCloseTo( 0.21425042968301292);
});

test('srgb to Lab as device', () => {
    let rgb2lab = new Transform({
        dataFormat: 'device'
    });
    rgb2lab.create('*srgb', '*lab', eIntent.absolute);
    let input = [200/255,150/255,50/255];
    let output = rgb2lab.transform(input);
    // [ 0.65677112680158, 0.551147952930079, 0.7260569780631536 ]
    expect(output[0]).toBeCloseTo(0.65677112680158);
    expect(output[1]).toBeCloseTo(0.55114795293007);
    expect(output[2]).toBeCloseTo(0.72605697806315);
});

//
// ---------------------------------------------------------------------------------------------------------------
//

test('srgb to adobe1998 as int8', () => {
    let rgb2lab = new Transform({
        dataFormat: 'int8'
    });
    rgb2lab.create('*srgb', '*adobe1998', eIntent.absolute);
    let input = new Uint8ClampedArray(3)
    input[0] = 200;
    input[1] = 150;
    input[2] = 50;
    let output = rgb2lab.transform(input);

    expect(output).toBeInstanceOf(Array);
    expect(output[0]).toBe(186);
    expect(output[1]).toBe(149);
    expect(output[2]).toBe(61);
});
