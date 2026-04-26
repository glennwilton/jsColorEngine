const {Transform, eIntent, convert} = require('../src/main');
const path = require("path");
const Profile = require("../src/Profile");

let cmykFilename = path.join(__dirname, './GRACoL2006_Coated1v2.icc');


// ── LUT tags ────────────────────────────────────────────────────────────────

test('LUT without gamut — gamutMode is none', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let t = new Transform({ dataFormat: 'object', buildLut: true });
    t.create('*lab', cmykProfile, eIntent.relative);

    expect(t.lut).toBeTruthy();
    expect(t.lut.gamutMode).toBe('none');
    expect(t.lut.gamutLimit).toBe(0);
    expect(t.lut.gamutMapScale).toBe(0);
});

test('LUT with lutGamutMode color — tags show color + limit', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let t = new Transform({
        dataFormat: 'object', buildLut: true,
        lutGamutMode: 'color', lutGamutLimit: 5,
    });
    t.create('*lab', cmykProfile, eIntent.relative);

    expect(t.lut.gamutMode).toBe('color');
    expect(t.lut.gamutLimit).toBe(5);
    expect(t.lut.gamutMapScale).toBe(0);
});

test('LUT with legacy bakeLutGamut:true — maps to color mode', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let t = new Transform({
        dataFormat: 'object', buildLut: true,
        bakeLutGamut: true, lutGamutLimit: 7,
    });
    t.create('*lab', cmykProfile, eIntent.relative);

    expect(t.lut.gamutMode).toBe('color');
    expect(t.lut.gamutLimit).toBe(7);
});

test('LUT with lutGamutMode map — tags show map + scale', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let t = new Transform({
        dataFormat: 'object', buildLut: true,
        lutGamutMode: 'map', lutGamutMapScale: 25.5,
    });
    t.create('*lab', cmykProfile, eIntent.relative);

    expect(t.lut.gamutMode).toBe('map');
    expect(t.lut.gamutLimit).toBe(0);
    expect(t.lut.gamutMapScale).toBe(25.5);
});

test('int8 LUT inherits gamut tags from float LUT (color mode)', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let t = new Transform({
        dataFormat: 'int8', buildLut: true,
        lutGamutMode: 'color', lutGamutLimit: 7,
    });
    t.create('*srgb', cmykProfile, eIntent.relative);

    expect(t.lut.gamutMode).toBe('color');
    expect(t.lut.gamutLimit).toBe(7);
    expect(t.lut.intLut).toBeTruthy();
    expect(t.lut.intLut.gamutMode).toBe('color');
    expect(t.lut.intLut.gamutLimit).toBe(7);
});

test('int8 LUT inherits gamut tags (map mode)', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let t = new Transform({
        dataFormat: 'int8', buildLut: true,
        lutGamutMode: 'map', lutGamutMapScale: 10,
    });
    t.create('*srgb', cmykProfile, eIntent.relative);

    expect(t.lut.gamutMode).toBe('map');
    expect(t.lut.gamutMapScale).toBe(10);
    expect(t.lut.intLut).toBeTruthy();
    expect(t.lut.intLut.gamutMode).toBe('map');
    expect(t.lut.intLut.gamutMapScale).toBe(10);
});

test('int8 LUT without gamut — intLut tags are none/0', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let t = new Transform({ dataFormat: 'int8', buildLut: true });
    t.create('*srgb', cmykProfile, eIntent.relative);

    expect(t.lut.gamutMode).toBe('none');
    expect(t.lut.intLut).toBeTruthy();
    expect(t.lut.intLut.gamutMode).toBe('none');
});


// ── Color mode behaviour ────────────────────────────────────────────────────

test('color mode — Lab edge corners get warning colour', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let gamutColor = convert.Lab(0, 127, 127);

    let tGamut = new Transform({
        dataFormat: 'object', buildLut: true,
        lutGamutMode: 'color', lutGamutLimit: 5, lutGamutColor: gamutColor,
    });
    tGamut.create('*lab', cmykProfile, eIntent.relative);

    let tNormal = new Transform({ dataFormat: 'object', buildLut: true });
    tNormal.create('*lab', cmykProfile, eIntent.relative);

    let warningCMYK = tNormal.transform(gamutColor);

    let extremeEdges = [
        convert.Lab(0,   -128, -128),
        convert.Lab(0,    127,  127),
        convert.Lab(100, -128,  127),
        convert.Lab(100,  127, -128),
    ];

    let replacedCount = 0;
    for (let lab of extremeEdges) {
        let cmyk = tGamut.transform(lab);
        let isWarning = (
            Math.abs(cmyk.C - warningCMYK.C) < 2 &&
            Math.abs(cmyk.M - warningCMYK.M) < 2 &&
            Math.abs(cmyk.Y - warningCMYK.Y) < 2 &&
            Math.abs(cmyk.K - warningCMYK.K) < 2
        );
        if (isWarning) replacedCount++;
    }
    expect(replacedCount).toBeGreaterThanOrEqual(2);
});

test('color mode — Lab mid-grey (50,0,0) NOT flagged', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let tGamut = new Transform({
        dataFormat: 'object', buildLut: true,
        lutGamutMode: 'color', lutGamutLimit: 5,
    });
    tGamut.create('*lab', cmykProfile, eIntent.relative);

    let tNormal = new Transform({ dataFormat: 'object', buildLut: true });
    tNormal.create('*lab', cmykProfile, eIntent.relative);

    let midGrey = convert.Lab(50, 0, 0);
    let cmykGamut  = tGamut.transform(midGrey);
    let cmykNormal = tNormal.transform(midGrey);

    expect(Math.abs(cmykGamut.C - cmykNormal.C)).toBeLessThan(1);
    expect(Math.abs(cmykGamut.M - cmykNormal.M)).toBeLessThan(1);
    expect(Math.abs(cmykGamut.Y - cmykNormal.Y)).toBeLessThan(1);
    expect(Math.abs(cmykGamut.K - cmykNormal.K)).toBeLessThan(1);
});

test('color mode — visible through int8 transformArrayViaLUT', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let tGamut = new Transform({
        dataFormat: 'int8', buildLut: true,
        lutGamutMode: 'color', lutGamutLimit: 5,
    });
    tGamut.create('*srgb', cmykProfile, eIntent.relative);

    let tNormal = new Transform({ dataFormat: 'int8', buildLut: true });
    tNormal.create('*srgb', cmykProfile, eIntent.relative);

    let input = [255, 0, 0,  128, 128, 128];

    let outGamut  = tGamut.transformArrayViaLUT(input);
    let outNormal = tNormal.transformArrayViaLUT(input);

    // Mid-grey (pixel 1, offset 4–7) identical
    expect(Math.abs(outGamut[4] - outNormal[4])).toBeLessThanOrEqual(1);
    expect(Math.abs(outGamut[5] - outNormal[5])).toBeLessThanOrEqual(1);
    expect(Math.abs(outGamut[6] - outNormal[6])).toBeLessThanOrEqual(1);
    expect(Math.abs(outGamut[7] - outNormal[7])).toBeLessThanOrEqual(1);

    expect(outGamut).toBeInstanceOf(Uint8ClampedArray);
    expect(outGamut.length).toBe(8);
});


// ── Map mode behaviour ──────────────────────────────────────────────────────

test('map mode — mid-grey produces near-zero ΔE (all channels ≈ 0)', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let tMap = new Transform({
        dataFormat: 'object', buildLut: true,
        lutGamutMode: 'map', lutGamutMapScale: 25.5,
    });
    tMap.create('*lab', cmykProfile, eIntent.relative);

    let midGrey = convert.Lab(50, 0, 0);
    let result = tMap.transform(midGrey);

    // Mid-grey is in gamut → ΔE ≈ 0 → all channels near 0
    expect(result.C).toBeLessThan(5);
    expect(result.M).toBeLessThan(5);
    expect(result.Y).toBeLessThan(5);
    expect(result.K).toBeLessThan(5);
});

test('map mode — extreme Lab corner produces high ΔE (all channels > 0)', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let tMap = new Transform({
        dataFormat: 'object', buildLut: true,
        lutGamutMode: 'map', lutGamutMapScale: 25.5,
    });
    tMap.create('*lab', cmykProfile, eIntent.relative);

    let extreme = convert.Lab(50, 127, 127);
    let result = tMap.transform(extreme);

    // Extreme chroma is way out of CMYK gamut → ΔE large → channels > 0
    // All channels should be the same value (map fills all equally)
    expect(result.C).toBeGreaterThan(5);
    expect(Math.abs(result.C - result.M)).toBeLessThan(1);
    expect(Math.abs(result.C - result.Y)).toBeLessThan(1);
    expect(Math.abs(result.C - result.K)).toBeLessThan(1);
});

test('map mode — int8 sRGB→CMYK heatmap, saturated blue > mid-grey', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let tMap = new Transform({
        dataFormat: 'int8', buildLut: true,
        lutGamutMode: 'map', lutGamutMapScale: 25.5,
    });
    tMap.create('*srgb', cmykProfile, eIntent.relative);

    let input = [
        0,   0, 255,     // saturated blue — likely out of gamut
        128, 128, 128,   // mid-grey — in gamut
    ];

    let out = tMap.transformArrayViaLUT(input);
    expect(out).toBeInstanceOf(Uint8ClampedArray);
    expect(out.length).toBe(8);

    // Blue pixel ch0 should be higher than grey pixel ch0
    let blueDe  = out[0];
    let greyDe  = out[4];
    expect(blueDe).toBeGreaterThan(greyDe);

    // All 4 channels of each pixel should be equal (map fills uniformly)
    expect(out[0]).toBe(out[1]); expect(out[0]).toBe(out[2]); expect(out[0]).toBe(out[3]);
    expect(out[4]).toBe(out[5]); expect(out[4]).toBe(out[6]); expect(out[4]).toBe(out[7]);
});


// ── ColorMap mode behaviour ─────────────────────────────────────────────────

test('colorMap mode — mid-grey (in gamut) produces near-white', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let tBlend = new Transform({
        dataFormat: 'object', buildLut: true,
        lutGamutMode: 'colorMap', lutGamutMapScale: 25.5,
    });
    tBlend.create('*lab', cmykProfile, eIntent.relative);

    let midGrey = convert.Lab(50, 0, 0);
    let result = tBlend.transform(midGrey);

    // In-gamut → blend factor ≈ 0 → result ≈ paper white (low CMYK ink)
    expect(result.C).toBeLessThan(5);
    expect(result.M).toBeLessThan(5);
    expect(result.Y).toBeLessThan(5);
    expect(result.K).toBeLessThan(5);
});

test('colorMap mode — extreme chroma shifts towards gamut colour', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let gamutColor = convert.Lab(0, 127, 127);

    let tBlend = new Transform({
        dataFormat: 'object', buildLut: true,
        lutGamutMode: 'colorMap', lutGamutMapScale: 25.5, lutGamutColor: gamutColor,
    });
    tBlend.create('*lab', cmykProfile, eIntent.relative);

    let tNormal = new Transform({ dataFormat: 'object', buildLut: true });
    tNormal.create('*lab', cmykProfile, eIntent.relative);

    let tRef = new Transform({ dataFormat: 'object' });
    tRef.create('*lab', cmykProfile, eIntent.relative);
    let warningCMYK = tRef.transform(gamutColor);

    let extreme = convert.Lab(50, 127, 127);
    let blended = tBlend.transform(extreme);
    let normal  = tNormal.transform(extreme);

    // Out-of-gamut → blend factor > 0 → result shifts towards warning colour
    // At least one channel should be noticeably different from normal
    let maxDiff = Math.max(
        Math.abs(blended.C - normal.C),
        Math.abs(blended.M - normal.M),
        Math.abs(blended.Y - normal.Y),
        Math.abs(blended.K - normal.K),
    );
    expect(maxDiff).toBeGreaterThan(2);
});

test('colorMap LUT tags show colorMap + mapScale', async () => {
    let cmykProfile = new Profile();
    await cmykProfile.loadPromise('file:' + cmykFilename);

    let t = new Transform({
        dataFormat: 'int8', buildLut: true,
        lutGamutMode: 'colorMap', lutGamutMapScale: 20,
    });
    t.create('*srgb', cmykProfile, eIntent.relative);

    expect(t.lut.gamutMode).toBe('colorMap');
    expect(t.lut.gamutMapScale).toBe(20);
    expect(t.lut.intLut.gamutMode).toBe('colorMap');
    expect(t.lut.intLut.gamutMapScale).toBe(20);
});
