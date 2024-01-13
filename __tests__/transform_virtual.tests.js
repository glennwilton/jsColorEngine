const {Transform, eIntent, color, eColourType} = require('../src/main');

test('Lab to Lab', () => {
    let lab2lab = new Transform();
    lab2lab.create('*lab', '*lab', eIntent.absolute);
    let input = color.Lab(30,50,-20);
    let output = lab2lab.transform(input);
    expect(output.L).toBeCloseTo(30, 5);
    expect(output.a).toBeCloseTo(50, 5);
    expect(output.b).toBeCloseTo(-20, 5);
});

test('Lab to srgb (int)', () => {
    let lab2srgb = new Transform();
    lab2srgb.create('*lab', '*srgb', eIntent.absolute);
    let input = color.Lab(30,50,-20);
    let output = lab2srgb.transform(input);
    expect(output.R).toBe(129 );
    expect(output.G).toBe(21);
    expect(output.B).toBe(103 );
    expect(output.type).toBe(eColourType.RGB);
});

test('Lab to srgb (3 decimals)', () => {
    let lab2srgb = new Transform({
        precession: 3
    });
    lab2srgb.create('*lab', '*srgb', eIntent.absolute);
    let input = color.Lab(30,50,-20);
    let output = lab2srgb.transform(input);
    expect(output.R).toBe(129.012 );
    expect(output.G).toBe(20.658);
    expect(output.B).toBe(103.199 );
    expect(output.type).toBe(eColourType.RGB);
});

test('srgb to Lab (no rounding)', () => {
    let rgb2lab = new Transform({
        roundOutput: false
    });
    rgb2lab.create('*srgb', '*lab', eIntent.absolute);
    let input = color.RGB(200,150,50);
    let output = rgb2lab.transform(input);
    expect(output.L).toBeCloseTo(65.677112680158, 5);
    expect(output.a).toBeCloseTo(12.542727997170147, 5);
    expect(output.b).toBeCloseTo(57.14452940610417, 5);
    expect(output.whitePoint.desc).toBe('d50');
});

test('sRGB to Adobe1998RGB', () => {
    let rgb2rgb = new Transform();
    rgb2rgb.create('*srgb', '*adobe1998', eIntent.absolute);
    let input = color.RGB(200,150,50);
    let output = rgb2rgb.transform(input);
    expect(output.R).toBe(186);
    expect(output.G).toBe(149);
    expect(output.B).toBe(61);
    expect(output.type).toBe(eColourType.RGB);
});


