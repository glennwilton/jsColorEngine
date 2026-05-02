/**
 * LutBuilder — TIFF import/export integration tests
 *
 * Tests the Stage 3 TIFF round-trip workflow using Photoshop-saved TIFFs.
 *
 * Test files in samples/tiff_samples/tests/:
 *   ps_rgb_desaturated_16bit.tif  — RGB identity, desaturated, LZW 16-bit
 *   ps_cmyk_to_rgb_8bit.tif              — CMYK identity, converted to RGB 8-bit
 *   ps_rgb_to_cmyk_16bit.tif             — RGB identity, converted to CMYK, LZW 16-bit
 *   ps_cmyk_to_rgb_8bit_damaged.tif      — CMYK→RGB, black line drawn in LUT area
 *   ps_rgb_zip_16bit.tif                        — RGB, ZIP/Deflate (tag 8) compression
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const { Transform, eIntent } = require('../src/main');
const Profile = require('../src/Profile');
const { LutBuilder, virtualProfile, virtualRGB, virtualCMYK } = require('../samples/LutBuilder');

const TIFF_DIR  = path.join(__dirname, '../samples/tiff_samples/tests');
const PROF_DIR  = path.join(__dirname, '.');

function loadTiff(name) {
    return fs.readFileSync(path.join(TIFF_DIR, name));
}

// ── Shared profiles ───────────────────────────────────────────────────────────

let adobeRGBProfile, gracolProfile;

beforeAll(async () => {
    adobeRGBProfile = new Profile();
    gracolProfile   = new Profile();
    await adobeRGBProfile.loadPromise('file:' + path.join(PROF_DIR, 'AdobeRGB1998.icc'));
    await gracolProfile.loadPromise('file:' + path.join(PROF_DIR, 'GRACoL2006_Coated1v2.icc'));
});

// ─── 1. RGB desaturated ───────────────────────────────────────────────────────

describe('TIFF import: RGB desaturated (u16)', () => {
    let b;
    beforeAll(() => { b = LutBuilder.fromTIFF(loadTiff('ps_rgb_desaturated_16bit.tif')); });

    test('inCh=3 outCh=3 size=33', () => {
        expect(b._inCh).toBe(3);
        expect(b._outCh).toBe(3);
        expect(b._size).toBe(33);
    });

    test('all output cells have R ≈ G ≈ B (desaturated)', () => {
        const totalCells = 33 * 33 * 33;
        let maxSpread = 0;
        for (let i = 0; i < totalCells; i++) {
            const base = i * 3;
            const r = b._u16[base], g = b._u16[base + 1], bv = b._u16[base + 2];
            const spread = Math.max(r, g, bv) - Math.min(r, g, bv);
            if (spread > maxSpread) maxSpread = spread;
        }
        // Desaturated: all channels equal within 1 u8 LSB (257 u16 units)
        expect(maxSpread).toBeLessThan(514);
    });

    test('chain preserved from XMP', () => {
        expect(b._chain).toBeTruthy();
        expect(b._chain.length).toBe(3);
    });

    test('acid: applying LUT to bright colours produces gray output', () => {
        const t = b.toTransform({ dataFormat: 'int8' });
        // Pure red, pure green, pure blue
        const pixels = new Uint8ClampedArray([255, 0, 0,  0, 255, 0,  0, 0, 255]);
        const out = t.transformArray(pixels);
        // Each output should be gray: R≈G≈B within 8 u8 units
        for (let i = 0; i < 3; i++) {
            const r = out[i*3], g = out[i*3+1], bv = out[i*3+2];
            expect(Math.abs(r - g)).toBeLessThan(8);
            expect(Math.abs(g - bv)).toBeLessThan(8);
        }
    });
});

// ─── 2. CMYK → RGB 8-bit ─────────────────────────────────────────────────────

describe('TIFF import: CMYK→RGB u8 (output channel change)', () => {
    let b;
    beforeAll(() => { b = LutBuilder.fromTIFF(loadTiff('ps_cmyk_to_rgb_8bit.tif')); });

    test('outCh updated to 3 (CMYK TIFF converted to RGB)', () => {
        expect(b._outCh).toBe(3);
    });

    test('inCh=4 preserved from XMP (original was 4D CMYK grid)', () => {
        expect(b._inCh).toBe(4);
    });

    test('size=17 preserved from XMP', () => {
        expect(b._size).toBe(17);
    });

    test('chain output updated with embedded ICC profile', () => {
        expect(b._chain).toBeTruthy();
        // Output descriptor should reflect RGB (profile extracted from TIFF tag 34675)
        const outDesc = b._chain[2];
        expect(outDesc).toBeTruthy();
    });

    test('LUT produces valid RGB values (0–65535 range)', () => {
        const totalCells = 17 * 17 * 17 * 17;
        for (let i = 0; i < totalCells * 3; i++) {
            expect(b._u16[i]).toBeGreaterThanOrEqual(0);
            expect(b._u16[i]).toBeLessThanOrEqual(65535);
        }
    });

    test('acid: CMYK identity white [0,0,0,0] → near-white RGB', () => {
        const t = b.toTransform({ dataFormat: 'int8' });
        // CMYK [0,0,0,0] = no ink = white paper
        const out = t.transformArray(new Uint8ClampedArray([0, 0, 0, 0]));
        // Should be near white
        expect(out[0]).toBeGreaterThan(220);
        expect(out[1]).toBeGreaterThan(220);
        expect(out[2]).toBeGreaterThan(220);
    });

    test('acid: CMYK identity black [0,0,0,255] → near-black RGB', () => {
        const t = b.toTransform({ dataFormat: 'int8' });
        const out = t.transformArray(new Uint8ClampedArray([0, 0, 0, 255]));
        // Black ink should give near-black RGB
        expect(out[0]).toBeLessThan(40);
        expect(out[1]).toBeLessThan(40);
        expect(out[2]).toBeLessThan(40);
    });
});

// ─── 3. RGB → CMYK 16-bit ────────────────────────────────────────────────────

describe('TIFF import: RGB→CMYK u16 (output channel change)', () => {
    let b;
    beforeAll(() => { b = LutBuilder.fromTIFF(loadTiff('ps_rgb_to_cmyk_16bit.tif')); });

    test('outCh updated to 4 (RGB TIFF converted to CMYK)', () => {
        expect(b._outCh).toBe(4);
    });

    test('inCh=3 preserved from XMP (original was 3D RGB grid)', () => {
        expect(b._inCh).toBe(3);
    });

    test('size=33 preserved from XMP', () => {
        expect(b._size).toBe(33);
    });

    test('chain output updated from embedded ICC profile', () => {
        expect(b._chain).toBeTruthy();
        const outDesc = b._chain[2];
        expect(outDesc).toBeTruthy();
    });

    test('acid: RGB white [255,255,255] → near-zero CMYK ink', () => {
        const t = b.toTransform({ dataFormat: 'int8' });
        const out = t.transformArray(new Uint8ClampedArray([255, 255, 255]));
        // White should produce very little ink in CMYK
        const totalInk = out[0] + out[1] + out[2] + out[3];
        expect(totalInk).toBeLessThan(30);
    });

    test('acid: LUT vs jsColorEngine direct — ΔP within grid interpolation tolerance', () => {
        // Build a direct Transform using same profiles for comparison
        const direct = new Transform({ dataFormat: 'int8', buildLut: false });
        direct.create(adobeRGBProfile, gracolProfile, eIntent.perceptual);

        const lutTransform = b.toTransform({ dataFormat: 'int8' });

        // Test a small set of diverse RGB colours
        const testPixels = new Uint8ClampedArray([
            255,   0,   0,   // red
              0, 255,   0,   // green
              0,   0, 255,   // blue
            255, 255,   0,   // yellow
            128, 128, 128,   // mid gray
            200,  50, 150,   // magenta-ish
        ]);

        const directOut = direct.transformArray(testPixels);
        const lutOut    = lutTransform.transformArray(testPixels);

        let maxDeltaP = 0;
        for (let i = 0; i < directOut.length; i++) {
            const d = Math.abs(directOut[i] - lutOut[i]);
            if (d > maxDeltaP) maxDeltaP = d;
        }
        // Grid interpolation at N=33 should give < 5 u8 delta on most colours
        // Allow generously for cross-CMM differences (Adobe CMM vs jsCE): observed ~42
        expect(maxDeltaP).toBeLessThan(50);
        console.log('    Max ΔP (Adobe CMM LUT vs jsCE direct):', maxDeltaP);
    });
});

// ─── 4. Damaged TIFF ─────────────────────────────────────────────────────────

describe('TIFF import: damaged LUT area (black line drawn)', () => {
    test('throws with spread error on corrupted cell', () => {
        expect(() => {
            LutBuilder.fromTIFF(loadTiff('ps_cmyk_to_rgb_8bit_damaged.tif'));
        }).toThrow('spread');
    });
});

// ─── 5. Gray with embedded dot-gain profile ──────────────────────────────────

describe('TIFF import: Gray 1D N=255 8-bit ZIP, Dot Gain 20% profile', () => {
    let b;
    beforeAll(() => { b = LutBuilder.fromTIFF(loadTiff('ps_grey_dotgain20_n255_8bit.tif')); });

    test('inCh=1 outCh=1 size=255', () => {
        expect(b._inCh).toBe(1);
        expect(b._outCh).toBe(1);
        expect(b._size).toBe(255);
    });

    test('embedded Dot Gain 20% ICC profile extracted into chain output', () => {
        expect(b._chain).toBeTruthy();
        expect(b._chain[2]).toBeTruthy();
        expect((b._chain[2].name || b._chain[2].description || '')).toMatch(/dot gain/i);
    });

    test('tone curve anchors: shadows=0 highlights=65535', () => {
        expect(b._u16[0]).toBe(0);
        expect(b._u16[b._u16.length - 1]).toBe(65535);
    });

    test('dot gain curve is non-linear (midtone compressed vs identity)', () => {
        // Dot gain shifts midtones darker: midpoint should be below 32768
        const mid = b._u16[127];
        expect(mid).toBeGreaterThan(0);
        expect(mid).toBeLessThan(32768);   // darker than identity midpoint
    });
});

// ─── 7. Planar TIFF ──────────────────────────────────────────────────────────

describe('TIFF import: planar format (PlanarConfiguration=2)', () => {
    test('throws with clear error directing user to resave as interleaved', () => {
        expect(() => {
            LutBuilder.fromTIFF(loadTiff('ps_rgb_planar.tif'));
        }).toThrow('planar');
    });
});

// ─── 6. Compression variants ─────────────────────────────────────────────────

describe('TIFF import: LZW compression (Photoshop default)', () => {
    let b;
    beforeAll(() => { b = LutBuilder.fromTIFF(loadTiff('ps_cmyk_to_rgb_8bit.tif')); });

    test('LZW file imports with correct structure', () => {
        expect(b._inCh).toBe(4);
        expect(b._outCh).toBe(3);
        expect(b._size).toBe(17);
    });

    test('LZW round-trip: identity corners correct', () => {
        // CMYK identity white [0,0,0,0] → near-white RGB
        const t = b.toTransform({ dataFormat: 'int8' });
        const out = t.transformArray(new Uint8ClampedArray([0, 0, 0, 0]));
        expect(out[0]).toBeGreaterThan(220);
    });
});

describe('TIFF import: ZIP/Deflate compression (tag 8)', () => {
    // ps_rgb_zip_16bit.tif = RGB 16-bit saved from Photoshop with ZIP compression
    let b;
    beforeAll(() => { b = LutBuilder.fromTIFF(loadTiff('ps_rgb_zip_16bit.tif')); });

    test('ZIP file imports with correct structure', () => {
        expect(b._inCh).toBe(3);
        expect(b._outCh).toBe(3);
        expect(b._size).toBe(33);
    });

    test('ZIP file LUT data is valid (all values in 0–65535)', () => {
        for (let i = 0; i < b._u16.length; i++) {
            expect(b._u16[i]).toBeGreaterThanOrEqual(0);
            expect(b._u16[i]).toBeLessThanOrEqual(65535);
        }
    });

    test('ZIP file identity corners: black→0 white→65535', () => {
        const N = b._size, L = (N * N * N - 1) * 3;
        expect(b._u16[0]).toBe(0);
        expect(b._u16[1]).toBe(0);
        expect(b._u16[2]).toBe(0);
        expect(b._u16[L]).toBe(65535);
        expect(b._u16[L + 1]).toBe(65535);
        expect(b._u16[L + 2]).toBe(65535);
    });
});

// ─── 8. CLI pipeline: generate sample outputs in cli_output/ ─────────────────
//
// These tests exercise the full import → analyze → save workflow and produce
// files in samples/tiff_samples/cli_output/ that serve as both test artefacts
// and developer-readable examples.

describe('CLI pipeline: import, analyze, write sample outputs', () => {
    const CLI_OUT    = path.join(__dirname, '../samples/tiff_samples/cli_output');
    const SAMPLE_DIR = path.join(__dirname, '../samples/tiff_samples');

    beforeAll(() => { fs.mkdirSync(CLI_OUT, { recursive: true }); });

    // ── Sample JSON files — keep as examples for developers ──────────────────

    test('save ps_rgb_to_cmyk_16bit → ps_rgb_to_cmyk.json', () => {
        const b = LutBuilder.fromTIFF(loadTiff('ps_rgb_to_cmyk_16bit.tif'));
        const jsonPath = path.join(CLI_OUT, 'ps_rgb_to_cmyk.json');
        fs.writeFileSync(jsonPath, JSON.stringify(b.toJSON(), null, 2));
        // Verify round-trip
        const b2 = LutBuilder.fromJSON(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
        expect(b2._inCh).toBe(3);
        expect(b2._outCh).toBe(4);
        expect(b2._size).toBe(33);
    });

    test('save ps_cmyk_to_rgb_8bit → ps_cmyk_to_rgb.json', () => {
        const b = LutBuilder.fromTIFF(loadTiff('ps_cmyk_to_rgb_8bit.tif'));
        const jsonPath = path.join(CLI_OUT, 'ps_cmyk_to_rgb.json');
        fs.writeFileSync(jsonPath, JSON.stringify(b.toJSON(), null, 2));
        const b2 = LutBuilder.fromJSON(JSON.parse(fs.readFileSync(jsonPath, 'utf8')));
        expect(b2._inCh).toBe(4);
        expect(b2._outCh).toBe(3);
        expect(b2._size).toBe(17);
    });

    test('save ps_rgb_desaturated_16bit → ps_rgb_desaturated.json', () => {
        const b = LutBuilder.fromTIFF(loadTiff('ps_rgb_desaturated_16bit.tif'));
        const jsonPath = path.join(CLI_OUT, 'ps_rgb_desaturated.json');
        fs.writeFileSync(jsonPath, JSON.stringify(b.toJSON(), null, 2));
        expect(fs.existsSync(jsonPath)).toBe(true);
    });

    // ── Validation with delta images + text report ────────────────────────────

    test('validate rgb→cmyk LUT: write delta TIFFs and text report', () => {
        const origPath   = path.join(SAMPLE_DIR, 'rgb_srgb_identity_n33.tiff');
        const editedPath = path.join(TIFF_DIR, 'ps_rgb_to_cmyk_16bit.tif');
        const lutPath    = path.join(CLI_OUT, 'ps_rgb_to_cmyk.json');

        if (!fs.existsSync(origPath) || !fs.existsSync(editedPath) || !fs.existsSync(lutPath)) {
            console.warn('Skipping delta output — required files missing');
            return;
        }

        const utif = require('utif');
        function readU8(p, spp, bps) {
            const raw = fs.readFileSync(p);
            const ab  = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
            const ifd = utif.decode(ab)[0]; utif.decodeImage(ab, ifd);
            const total = ifd.width * ifd.height;
            const bpSamp = bps === 16 ? 2 : 1;
            const out = new Uint8ClampedArray(total * spp);
            const px  = ifd.data;
            for (let i = 0; i < total; i++)
                for (let ch = 0; ch < spp; ch++) {
                    const off = (i * spp + ch) * bpSamp;
                    out[i*spp+ch] = bps===16 ? (px[off]|(px[off+1]<<8))>>8 : px[off];
                }
            return out;
        }

        const b    = LutBuilder.fromJSON(JSON.parse(fs.readFileSync(lutPath, 'utf8')));
        const orig = readU8(origPath,   3, 16);
        const edit = readU8(editedPath, 4, 16);

        const report = b.analyze(orig, edit, {
            threshold: 1.0, returnDelta: true, deltaAmplify: 20,
        });

        // Write delta TIFFs
        const base   = path.join(CLI_OUT, 'delta_rgb_to_cmyk');
        const ampTag = '_amp20x';
        fs.writeFileSync(base + '_magnitude' + ampTag + '.tiff',
            LutBuilder.pixelsToTIFF(report.deltaMagnitudeU8, 883, 694, 1, 8, {}));
        fs.writeFileSync(base + '_channels' + ampTag + '.tiff',
            LutBuilder.pixelsToTIFF(report.deltaChannelsU8, 883, 694, 4, 8, {}));

        // Write text report
        fs.writeFileSync(base + '_report.txt', report.reportText, 'utf8');

        // Verify the output files exist and report is reasonable
        expect(fs.existsSync(base + '_report.txt')).toBe(true);
        expect(report.grade).toMatch(/EXCELLENT|GOOD/);
        expect(report.meanDeltaP).toBeLessThan(3.0);
        console.log('    Grade:', report.grade, '| Mean ΔP:', report.meanDeltaP.toFixed(3));
    });
});
