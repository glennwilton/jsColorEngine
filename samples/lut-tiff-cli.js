#!/usr/bin/env node
/* ============================================================================
 *  lut-tiff-cli.js — Command-line LUT TIFF builder
 * ----------------------------------------------------------------------------
 *  Released under the MIT License
 *  Copyright (c) 2026 Glenn Wilton, O2 Creative Limited.
 *
 *  Builds LUT TIFF files using LutBuilder.js.
 *
 *  Usage:
 *    node samples/lut-tiff-cli.js --help
 *    node samples/lut-tiff-cli.js --make-samples
 *    node samples/lut-tiff-cli.js --identity --channels 3 --size 33 \
 *        --chain-in *AdobeRGB --chain-out *AdobeRGB \
 *        --images face.png,fruit.png,skin.png \
 *        --out out.tiff
 * ============================================================================
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const {
    LutBuilder,
    virtualProfile,
    virtualRGB,
    virtualCMYK,
    virtualGray,
    virtualLab,
} = require('./LutBuilder');

// ─── Arg helpers ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag  = (n)      => argv.includes(n);
const opt   = (n, def) => { const i = argv.indexOf(n); return i >= 0 && argv[i+1] !== undefined ? argv[i+1] : def; };

// ─── Entry ────────────────────────────────────────────────────────────────────

if (flag('--help') || flag('-h'))  { showHelp();      process.exit(0); }
if (flag('--make-samples'))        { makeSamples();   }
else if (flag('--import'))         { runImport();     }
else if (flag('--validate'))       { runValidate();   }
else if (flag('--compare'))        { runCompare();    }
else if (flag('--apply'))          { runApply();      }
else                               { runCreate();     }

// ─── Help ─────────────────────────────────────────────────────────────────────

function showHelp() {
    console.log(`
lut-tiff-cli.js — jsColorEngine LUT TIFF builder / importer

MODES
  --create              Export a new identity LUT as a TIFF  (alias: --identity)
  --import              Import a LUT TIFF → LUT JSON
  --make-samples        Generate the built-in RGB + CMYK + Gray sample TIFFs

─── CREATE ──────────────────────────────────────────────────────────────────
  --channels <n>        Input channels: 1–4           (default: 3)
  --out-channels <n>    Output channels                (default: same)
  --size <n>            Grid points per axis           (default: 33 for ≤3ch, 17 for 4ch)
  --scale <n>           Pixels per grid point 1–8     (default: 3 for ≤3ch, 2 for 4ch)
  --bps <n>             Bit depth: 8 | 16             (default: 16)
  --chain-in  <spec>    Input profile for chain        (see Profile specs below)
  --chain-out <spec>    Output profile for chain
  --images <paths>      Comma-separated preview image paths (up to 3)
  --output-profile-icc <path>   ICC file to embed in TIFF (tag 34675)
  --desc <text>         Description in TIFF info strip
  --out <path>          Output TIFF path               (required)

─── IMPORT ──────────────────────────────────────────────────────────────────
  --in  <path>          Input TIFF (required)
  --out <path>          Output JSON path               (default: same name + .json)
  --output-profile <spec>   Override / provide the output profile if not embedded
  --chain-in  <spec>    Override the input profile in chain
  --intent <name>       Rendering intent used in the editor: perceptual | relative | saturation | absolute
                        Required (warned if missing) when colour space changes
  --bpc                 Record that Black Point Compensation was enabled
  --require-intent      Fail (instead of warn) if colour space changed and --intent not supplied
  --size <n>            Fallback: grid size if TIFF has no metadata
  --in-channels <n>     Fallback: input channels
  --out-channels <n>    Fallback: output channels
  --scale <n>           Fallback: pixel scale

─── VALIDATE ────────────────────────────────────────────────────────────────
  --validate            Apply LUT to original, compare result to edited (ground truth)
  --original <path>     TIFF that went into Photoshop (before editing)
  --edited   <path>     TIFF saved from Photoshop (ground truth)
  --lut      <path>     LUT JSON from --import
  --threshold <n>       Max acceptable mean ΔP (default: 1.0)
  --delta-out <path>    Save delta images: <base>_magnitude.tiff (1ch) + <base>_channels.tiff
  --delta-amplify <n>   Multiply delta for visibility, default 10 (ΔP=1 → gray-10)

─── APPLY ───────────────────────────────────────────────────────────────────
  --apply               Apply a LUT to a source TIFF and save the result
  --source <path>       Input TIFF (any size/image — not just the identity grid)
  --lut    <path>       LUT JSON file from --import
  --out    <path>       Output TIFF (default: source name + _lut_applied.tiff)
  Use case: apply a Photoshop-captured LUT to a test image, open both in
            Photoshop to visually verify the round-trip is accurate

─── COMPARE ─────────────────────────────────────────────────────────────────
  --compare             Direct pixel-by-pixel diff — no LUT applied
  --base    <path>      Baseline TIFF (ground truth, e.g. Photoshop output)
  --test    <path>      Test TIFF to compare (e.g. jsCE output, lcms output)
  --threshold <n>       Max acceptable mean ΔP (default: 1.0)
  --delta-out <path>    Save delta images (same as --validate)
  --delta-amplify <n>   Amplify factor (default: 10)
  Use case: compare jsCE / lcms / Photoshop conversions of the same source image

─── PROFILE SPECS ───────────────────────────────────────────────────────────
  *sRGB  *AdobeRGB  *AppleRGB  *ProPhotoRGB  *Lab    built-in virtual profiles
  RGB    CMYK    GRAY    Lab                          colorspace-only descriptors
  /path/to/profile.icc                                load from ICC file

Examples:
  # Create an AdobeRGB identity LUT with preview images:
  node samples/lut-tiff-cli.js --create --channels 3 --size 33 --scale 3 \\
      --chain-in *AdobeRGB --chain-out *AdobeRGB \\
      --images face.png,fruit.png,skin.png \\
      --out adobe_rgb.tiff

  # Import a Photoshop-edited TIFF (auto-detects metadata):
  node samples/lut-tiff-cli.js --import --in edited.tiff --out my_lut.json

  # Import when TIFF has no embedded profile (CMYK always needs one):
  node samples/lut-tiff-cli.js --import --in edited_cmyk.tiff \\
      --output-profile samples/profiles/CoatedGRACoL2006.icc \\
      --out my_cmyk_lut.json

  node samples/lut-tiff-cli.js --make-samples
`);
}

// ─── Profile spec resolver ────────────────────────────────────────────────────
//
// Accepts: *sRGB, *AdobeRGB (built-in), RGB/CMYK/GRAY/LAB (colorspace),
//          /path/to/file.icc (load from disk).
// Returns a chain descriptor object.

function resolveProfileSpec(spec, fallbackChannels) {
    if (!spec) {
        if (fallbackChannels === 4) return virtualCMYK('CMYK');
        if (fallbackChannels === 1) return virtualGray('Gray');
        return virtualRGB('RGB');
    }
    const up = spec.toUpperCase();
    if (spec.startsWith('*'))            return virtualProfile(spec);
    if (up === 'CMYK')                   return virtualCMYK('CMYK');
    if (up === 'GRAY' || up === 'GREY')  return virtualGray('Gray');
    if (up === 'LAB')                    return virtualLab('Lab');
    if (up === 'RGB')                    return virtualRGB('RGB');
    // Try as ICC file path
    if (fs.existsSync(spec)) {
        const Profile = require('../src/Profile');
        const p = new Profile();
        p.loadBinary(fs.readFileSync(spec));
        if (!p.loaded) throw new Error('Failed to load ICC profile: ' + spec);
        const cs = (p.header && (p.header.colorSpace || (p.header.space && p.header.space.toUpperCase()))) || '';
        const name = p.description || p.name || path.basename(spec);
        if (cs.includes('CMYK') || cs === 'CMYK') return virtualCMYK(name);
        if (cs === 'GRAY')  return virtualGray(name);
        if (cs === 'LAB')   return virtualLab(name);
        return virtualRGB(name);
    }
    return virtualRGB(spec);
}

// ─── CREATE mode (--create / --identity) ─────────────────────────────────────

function runCreate() {
    if (!flag('--create') && !flag('--identity')) {
        console.error('Error: specify a mode: --create, --import, or --make-samples.');
        console.error('       Run with --help for usage.');
        process.exit(1);
    }

    const inCh  = parseInt(opt('--channels',     '3'), 10);
    const outCh = parseInt(opt('--out-channels', String(inCh)), 10);
    const size  = parseInt(opt('--size',  inCh >= 4 ? '17' : '33'), 10);
    const scale = parseInt(opt('--scale', inCh >= 4 ? '2'  : '3'),  10);
    const bps   = parseInt(opt('--bps', '16'), 10);
    const desc  = opt('--desc', '');
    const out   = opt('--out',  '');
    const imgs  = opt('--images', '').split(',').filter(Boolean);
    const iccPath = opt('--output-profile-icc', '');

    if (!out) { console.error('Error: --out <path> is required'); process.exit(1); }

    const { eIntent } = require('../src/main');

    const b = new LutBuilder().createIdentity(inCh, size);
    b.setChain([
        resolveProfileSpec(opt('--chain-in',  ''), inCh),
        eIntent.perceptual,
        resolveProfileSpec(opt('--chain-out', ''), outCh),
    ]);
    if (desc) b.addMeta({ description: desc });

    ensureDir(path.dirname(out));

    const iccBytes = (iccPath && fs.existsSync(iccPath)) ? fs.readFileSync(iccPath) : null;
    const label = desc || ('Identity LUT — ' + size + 'pt ' + inCh + 'ch');
    console.log(`Creating ${inCh}D identity LUT: size=${size}, scale=${scale}, bps=${bps} …`);

    b.exportTIFF({ scale, bitDepth: bps, previewImages: imgs, description: label,
                   iccProfileBytes: iccBytes })
        .then(function(bytes) {
            fs.writeFileSync(out, bytes);
            console.log(`Written: ${out} (${kb(bytes.length)} KB)`);
        })
        .catch(function(e) { console.error('Error:', e.message || e); process.exit(1); });
}

// ─── IMPORT mode (--import) ───────────────────────────────────────────────────

function runImport() {
    const inPath  = opt('--in',  '');
    const outPath = opt('--out', '');
    if (!inPath) { console.error('Error: --in <path> is required'); process.exit(1); }
    if (!fs.existsSync(inPath)) { console.error('Error: file not found: ' + inPath); process.exit(1); }

    const { eIntent } = require('../src/main');

    // Optional fallback parameters for TIFFs with no metadata
    const fallback = {};
    const sz  = opt('--size',         null);
    const ich = opt('--in-channels',  null);
    const och = opt('--out-channels', null);
    const sc  = opt('--scale',        null);
    if (sz)  fallback.size  = parseInt(sz,  10);
    if (ich) fallback.inCh  = parseInt(ich, 10);
    if (och) fallback.outCh = parseInt(och, 10);
    if (sc)  fallback.scale = parseInt(sc,  10);

    let b;
    try {
        b = LutBuilder.fromTIFF(fs.readFileSync(inPath), fallback);
    } catch(e) {
        const msg = String(e.message || e);
        console.error('\nImport failed: ' + msg + '\n');
        if (msg.includes('metadata tag absent') || msg.includes('no metadata')) {
            console.error('The TIFF has no embedded metadata. Provide grid parameters:');
            console.error('  --size <n>            grid points per axis (e.g. 33)');
            console.error('  --in-channels <n>     input channels: 1=Gray, 3=RGB, 4=CMYK');
            console.error('  --out-channels <n>    output channels');
            console.error('  --scale <n>           pixel scale used on export (1, 2, or 3)');
            console.error('\nThese values are printed in the text strip at the bottom of the TIFF.');
        } else if (msg.includes('spread')) {
            console.error('The LUT pixel data is corrupted:');
            console.error('LUT region corrupted — JPEG compression, incorrect crop, or wrong --scale value.');
            console.error('Resave as TIFF LZW or uncompressed; never use JPEG.');
        }
        process.exit(1);
    }

    // Override chain entries if explicitly requested
    const outputSpec  = opt('--output-profile', '');
    const chainInSpec = opt('--chain-in', '');
    const intentOpt   = opt('--intent', '');
    const bpcOpt      = flag('--bpc');

    if (chainInSpec && b._chain) b._chain[0] = resolveProfileSpec(chainInSpec, b._inCh);

    // CMYK output always needs a known profile — check and error if missing
    if (b._outCh >= 4) {
        const outDesc    = b._chain && b._chain[2];
        const outCS      = outDesc && outDesc.header && (outDesc.header.colorSpace || (outDesc.header.space || '').toUpperCase());
        const hasProfile = outCS && (outCS.includes('CMYK') || outCS === 'CMYK');
        if (!hasProfile && !outputSpec) {
            console.error('\nError: CMYK output requires a named profile but none is embedded in the TIFF.');
            console.error('Provide it with:');
            console.error('  --output-profile samples/profiles/CoatedGRACoL2006.icc');
            console.error('  --output-profile CMYK   (colorspace-only, no press name)');
            process.exit(1);
        }
    }

    if (outputSpec && b._chain) b._chain[2] = resolveProfileSpec(outputSpec, b._outCh);

    // Detect colour space change — warn (or fail) if intent not provided
    const intentMap = { perceptual: 0, relative: 1, saturation: 2, absolute: 3,
                        '0':0, '1':1, '2':2, '3':3 };
    function chainCSName(desc) {
        if (!desc) return null;
        const h = desc.header || {};
        return h.colorSpace || (h.space && h.space.toUpperCase()) || null;
    }
    const inCS  = b._chain && chainCSName(b._chain[0]);
    const outCS = b._chain && chainCSName(b._chain[2]);
    const spaceChanged = inCS && outCS && inCS !== outCS;

    if (spaceChanged) {
        if (!intentOpt) {
            console.warn('\nWarning: colour space changed (' + inCS + ' → ' + outCS + ') but --intent was not supplied.');
            console.warn('The chain intent will default to "perceptual". Specify the actual intent used:');
            console.warn('  --intent perceptual | relative | saturation | absolute');
            console.warn('  --bpc                (if Black Point Compensation was enabled)');
            if (flag('--require-intent')) {
                console.error('\nError: --require-intent set — intent must be specified for cross-space LUTs.');
                process.exit(1);
            }
        }
        // Apply intent to chain[1]
        const resolvedIntent = intentOpt ? (intentMap[intentOpt.toLowerCase()] ?? 0) : 0;
        if (b._chain) b._chain[1] = resolvedIntent;
        // Record BPC in meta
        if (bpcOpt) {
            if (!b._meta) b._meta = {};
            b._meta.bpc = true;
        }
        console.log('  Intent :', ['perceptual','relative','saturation','absolute'][b._chain[1]] + (bpcOpt ? ' + BPC' : ''));
    }

    // Resolve output path
    const finalOut = outPath || inPath.replace(/\.(tif|tiff)$/i, '.json');
    ensureDir(path.dirname(finalOut));

    const json = b.toJSON();
    fs.writeFileSync(finalOut, JSON.stringify(json, null, 2));

    const inName  = (b._chain && b._chain[0] && b._chain[0].name)  || (_CS_NAMES[b._inCh]  || b._inCh + 'ch');
    const outName = (b._chain && b._chain[2] && b._chain[2].name)  || (_CS_NAMES[b._outCh] || b._outCh + 'ch');
    console.log(`Imported: ${path.basename(inPath)}`);
    console.log(`  LUT:   inCh=${b._inCh} outCh=${b._outCh} size=${b._size}`);
    console.log(`  Chain: ${inName} → ${outName}`);
    console.log(`Written: ${finalOut} (${kb(fs.statSync(finalOut).size)} KB)`);
}

const _CS_NAMES = { 1: 'Gray', 2: 'Duo', 3: 'RGB', 4: 'CMYK' };

// ─── VALIDATE mode (--validate) ──────────────────────────────────────────────
//
// Measures how accurately the LUT reproduces a Photoshop (or any editor) transform:
//   1. Reads the original TIFF (what went into the editor)
//   2. Reads the edited TIFF (ground truth output from the editor)
//   3. Applies the LUT (from JSON) to the original pixels
//   4. Diffs predicted vs actual, reports ΔP stats

function runValidate() {
    const origPath   = opt('--original', '');
    const editedPath = opt('--edited',   '');
    const lutPath    = opt('--lut',      '');

    if (!origPath || !editedPath || !lutPath) {
        console.error('Error: --validate requires --original, --edited, and --lut');
        process.exit(1);
    }
    for (const [n, p] of [['--original', origPath], ['--edited', editedPath], ['--lut', lutPath]]) {
        if (!fs.existsSync(p)) { console.error('Error: file not found: ' + p + ' (' + n + ')'); process.exit(1); }
    }

    const utif = require('utif');
    const { LutBuilder } = require('./LutBuilder');

    let b;
    try { b = LutBuilder.fromJSON(JSON.parse(fs.readFileSync(lutPath, 'utf8'))); }
    catch(e) { console.error('Error loading LUT JSON:', e.message || e); process.exit(1); }

    const orig   = readTiffU8(utif, origPath);
    const edited = readTiffU8(utif, editedPath);

    if (orig.w !== edited.w || orig.h !== edited.h) {
        console.error('Error: dimension mismatch — original ' + orig.w + '×' + orig.h +
                      ', edited ' + edited.w + '×' + edited.h);
        process.exit(1);
    }

    const deltaOut = opt('--delta-out', '');
    let report;
    try {
        report = b.analyze(orig.pixels, edited.pixels, {
            threshold:    parseFloat(opt('--threshold', '1.0')),
            returnDelta:  !!deltaOut,
            deltaAmplify: parseFloat(opt('--delta-amplify', '10')),
        });
    } catch(e) { console.error('Error:', e.message || e); process.exit(1); }

    printReport('Validation report', path.basename(origPath), path.basename(editedPath),
                path.basename(lutPath) + ` (inCh=${b._inCh} outCh=${b._outCh} N=${b._size})`,
                orig.w, orig.h, orig.spp, orig.bps, edited.spp, edited.bps, report);
    writeDeltaTIFFs(report, deltaOut, orig.w, orig.h, b._outCh);
}

// ─── APPLY mode (--apply) ────────────────────────────────────────────────────
//
// Apply a LUT JSON to a source TIFF pixel-by-pixel and save the result.
// The output TIFF has the LUT's output channel count (e.g. 4ch CMYK).
// Open source + output in Photoshop side-by-side to verify the round-trip visually.

function runApply() {
    const srcPath = opt('--source', '');
    const lutPath = opt('--lut',    '');
    const outPath = opt('--out',    '');

    if (!srcPath || !lutPath) {
        console.error('Error: --apply requires --source and --lut'); process.exit(1);
    }
    for (const [n, p] of [['--source', srcPath], ['--lut', lutPath]]) {
        if (!fs.existsSync(p)) { console.error('Error: file not found: ' + p + ' (' + n + ')'); process.exit(1); }
    }

    const utif = require('utif');
    const { LutBuilder } = require('./LutBuilder');

    // Load source TIFF as u8 pixels
    const src = readTiffU8(utif, srcPath);

    // Load LUT
    let b;
    try { b = LutBuilder.fromJSON(JSON.parse(fs.readFileSync(lutPath, 'utf8'))); }
    catch(e) { console.error('Error loading LUT:', e.message || e); process.exit(1); }

    if (src.spp !== b._inCh) {
        console.warn('Warning: source has ' + src.spp + ' channels but LUT expects ' + b._inCh +
                     ' input channels — results may be incorrect.');
    }

    // Apply LUT (int8: u8 in, u8 out)
    const t = b.toTransform({ dataFormat: 'int8' });
    const outputPixels = t.transformArray(src.pixels);

    // Write output TIFF (output channel count from LUT)
    const finalOut = outPath ||
        srcPath.replace(/(\.(tif|tiff))$/i, '_lut_applied$1').replace(/^(.*)$/, (m) =>
            m.endsWith('.tif') || m.endsWith('.tiff') ? m : m + '_lut_applied.tiff');
    ensureDir(path.dirname(finalOut));

    const tiffBytes = LutBuilder.pixelsToTIFF(outputPixels, src.w, src.h, b._outCh, 8, {});
    fs.writeFileSync(finalOut, tiffBytes);

    console.log('Applied LUT: ' + path.basename(lutPath));
    console.log('  Source : ' + path.basename(srcPath) +
                ' (' + src.w + '\xd7' + src.h + ', ' + src.spp + 'ch ' + src.bps + 'bit)');
    console.log('  Output : ' + finalOut +
                ' (' + b._outCh + 'ch 8bit, ' + kb(tiffBytes.length) + ' KB)');
    console.log('  Chain  : ' + (b._chain && b._chain[0] && b._chain[0].name || '?') +
                ' → ' + (b._chain && b._chain[2] && b._chain[2].name || '?'));
}

// ─── COMPARE mode (--compare) ────────────────────────────────────────────────
//
// Direct pixel comparison between two TIFFs of the same size — no LUT applied.
// Both images must have the same width, height, and channel count.

function runCompare() {
    const basePath = opt('--base', '');
    const testPath = opt('--test', '');

    if (!basePath || !testPath) {
        console.error('Error: --compare requires --base and --test');
        process.exit(1);
    }
    for (const [n, p] of [['--base', basePath], ['--test', testPath]]) {
        if (!fs.existsSync(p)) { console.error('Error: file not found: ' + p + ' (' + n + ')'); process.exit(1); }
    }

    const utif = require('utif');
    const { LutBuilder } = require('./LutBuilder');

    const base = readTiffU8(utif, basePath);
    const test = readTiffU8(utif, testPath);

    if (base.w !== test.w || base.h !== test.h) {
        console.error('Error: dimension mismatch — base ' + base.w + '×' + base.h +
                      ', test ' + test.w + '×' + test.h);
        process.exit(1);
    }
    if (base.spp !== test.spp) {
        console.error('Error: channel mismatch — base spp=' + base.spp + ', test spp=' + test.spp);
        process.exit(1);
    }

    const threshold = parseFloat(opt('--threshold', '1.0'));
    const deltaOut  = opt('--delta-out', '');
    const report    = LutBuilder.comparePixels(base.pixels, test.pixels, base.spp, {
        threshold,
        returnDelta:  !!deltaOut,
        deltaAmplify: parseFloat(opt('--delta-amplify', '10')),
    });

    printReport('Comparison report', path.basename(basePath), path.basename(testPath), null,
                base.w, base.h, base.spp, base.bps, test.spp, test.bps, report);
    writeDeltaTIFFs(report, deltaOut, base.w, base.h, base.spp);
}

// ─── Shared TIFF pixel reader + report printer ────────────────────────────────

// Write magnitude + per-channel delta TIFFs when --delta-out is provided.
// <base>_magnitude.tiff  — single-channel grayscale showing ΔP hotspots
// <base>_channels.tiff   — per-channel abs diff (same channel count as source)
function writeDeltaTIFFs(report, deltaOut, w, h, spp) {
    if (!deltaOut || !report.deltaMagnitudeU8) return;
    const { LutBuilder } = require('./LutBuilder');
    const ext     = path.extname(deltaOut);
    const base    = deltaOut.slice(0, -ext.length);
    const ampTag  = '_amp' + Math.round(report._deltaAmplify || 10) + 'x';  // e.g. _amp20x

    const magPath = base + '_magnitude' + ampTag + ext;
    fs.writeFileSync(magPath, LutBuilder.pixelsToTIFF(report.deltaMagnitudeU8, w, h, 1, 8, {}));
    console.log('  Delta magnitude : ' + path.basename(magPath) +
                ' (1ch grayscale amplified ×' + (report._deltaAmplify || 10) + ', bright = large ΔP)');

    const chPath = base + '_channels' + ampTag + ext;
    fs.writeFileSync(chPath, LutBuilder.pixelsToTIFF(report.deltaChannelsU8, w, h, spp, 8, {}));
    console.log('  Delta channels  : ' + path.basename(chPath) +
                ' (' + spp + 'ch per-channel diff amplified ×' + (report._deltaAmplify || 10) + ')');

    if (report.reportText) {
        const txtPath = base + '_report.txt';
        fs.writeFileSync(txtPath, report.reportText, 'utf8');
        console.log('  Report text     : ' + path.basename(txtPath));
    }
}

function readTiffU8(utif, filePath) {
    const raw = fs.readFileSync(filePath);
    const ab  = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
    const ifd = utif.decode(ab)[0];
    utif.decodeImage(ab, ifd);
    const w   = ifd.width, h = ifd.height;
    const spp = (ifd['t277'] && ifd['t277'][0]) || 3;
    const bps = (ifd['t258'] && ifd['t258'][0]) || 8;
    const total = w * h;
    const out = new Uint8ClampedArray(total * spp);
    const px  = ifd.data;
    const bpSamp = bps === 16 ? 2 : 1;
    for (let i = 0; i < total; i++) {
        for (let ch = 0; ch < spp; ch++) {
            const off = (i * spp + ch) * bpSamp;
            out[i * spp + ch] = bps === 16
                ? (px[off] | (px[off + 1] << 8)) >> 8
                : px[off];
        }
    }
    return { pixels: out, w, h, spp, bps };
}

function printReport(title, aName, bName, lutName, w, h, sppA, bpsA, sppB, bpsB, r) {
    console.log('\n' + title);
    console.log('  A        :', aName, `(${w}×${h}, ${sppA}ch ${bpsA}bit)`);
    console.log('  B        :', bName, `(${w}×${h}, ${sppB}ch ${bpsB}bit)`);
    if (lutName) console.log('  LUT      :', lutName);
    console.log('  Pixels   :', r.totalPixels.toLocaleString());
    console.log();
    console.log('  ΔP overall   mean ' + r.meanDeltaP.toFixed(3).padStart(7) +
                '   max ' + r.maxDeltaP.toFixed(1).padStart(6) +
                '   RMSE ' + r.rmseDeltaP.toFixed(3).padStart(7) +
                '   p95 ' + r.p95DeltaP.toFixed(2).padStart(5) +
                '   p99 ' + r.p99DeltaP.toFixed(2).padStart(5));
    console.log();
    console.log('  Channel breakdown:');
    console.log('  ' + 'Chan'.padEnd(6) + 'Mean'.padStart(8) + 'Max'.padStart(7) + 'RMSE'.padStart(8));
    r.channels.forEach(function(c) {
        console.log('  ' + c.name.padEnd(6) + c.meanDeltaP.toFixed(3).padStart(8) +
                    String(Math.round(c.maxDeltaP)).padStart(7) + c.rmseDeltaP.toFixed(3).padStart(8));
    });
    console.log();
    console.log('  Grade: ' + r.grade + ' (mean ΔP ' + r.meanDeltaP.toFixed(3) + ' / threshold ' + r.threshold + ')');
    console.log('  Pass:  ' + (r.pass ? 'YES' : 'NO — ' + r.failedPixels.toLocaleString() + ' pixels exceed threshold'));
}

// ─── Built-in samples ────────────────────────────────────────────────────────

function makeSamples() {
    const { eIntent } = require('../src/main');
    const Profile = require('../src/Profile');

    const outDir     = path.join(__dirname, 'tiff_samples');
    const imgDir     = path.join(__dirname, 'images');
    const profileDir = path.join(__dirname, 'profiles');
    ensureDir(outDir);

    const images = ['face.png', 'fruit.png', 'skin.png']
        .map(f => path.join(imgDir, f))
        .filter(f => fs.existsSync(f));

    if (!images.length) console.warn('Warning: no preview images found in samples/images/');

    // Load CoatedGRACoL2006 for sRGB→CMYK canvas conversion and embedding
    const gracolPath  = path.join(profileDir, 'CoatedGRACoL2006.icc');
    const gracolBytes = fs.readFileSync(gracolPath);
    const gracolProfile = new Profile();
    gracolProfile.loadBinary(gracolBytes);
    if (!gracolProfile.loaded)
        throw new Error('Failed to load CoatedGRACoL2006.icc from ' + gracolPath);
    console.log('Loaded: ' + (gracolProfile.description || gracolProfile.name || path.basename(gracolPath)));

    // Load sRGB2014.icc for embedding in the RGB sample (canvas is already sRGB — no conversion needed,
    // just embed the profile as tag 34675 so editors see a properly tagged sRGB TIFF)
    const srgbPath  = path.join(profileDir, 'sRGB2014.icc');
    const srgbBytes = fs.existsSync(srgbPath) ? fs.readFileSync(srgbPath) : null;
    if (srgbBytes) console.log('Loaded: sRGB2014.icc (embed only — no canvas conversion needed)');

    // ── Sample 1: sRGB identity (3D N=33 scale=3 16-bit, sRGB2014 embedded) ──
    const rgbFile = path.join(outDir, 'rgb_srgb_identity_n33.tiff');
    const rgbDesc = 'sRGB identity — open in Photoshop, apply colour grade, reimport as LUT';

    const rgbB = new LutBuilder().createIdentity(3, 33);
    rgbB.setChain([virtualProfile('*sRGB'), eIntent.perceptual, virtualProfile('*sRGB')]);
    rgbB.addMeta({ description: rgbDesc, copyright: 'jsColorEngine sample — MIT licence' });

    // ── Sample 2: CMYK GRACoL identity (4D N=17 scale=2 16-bit) ─────────────
    // Preview images are converted sRGB→GRACoL so the TIFF looks correct in CMYK editors.
    const cmykFile = path.join(outDir, 'cmyk_gracol_identity_n17.tiff');
    const cmykDesc = 'GRACoL 2006 CMYK identity — apply CMYK press adjustments, TAC limits, etc.';

    const cmykB = new LutBuilder().createIdentity(4, 17);
    cmykB.setChain([
        virtualCMYK('GRACoL 2006 Coated'),
        eIntent.perceptual,
        virtualCMYK('GRACoL 2006 Coated'),
    ]);
    cmykB.addMeta({ description: cmykDesc, copyright: 'jsColorEngine sample — MIT licence' });

    // ── Sample 3: Gray identity tone curve (1D N=33 scale=3 16-bit) ─────────
    // A neutral 1D tone curve. Open in Photoshop, apply Curves to adjust tonal
    // response, save losslessly, reimport to get a custom tone-curve LUT.
    const grayFile = path.join(outDir, 'gray_identity_tonecurve_n255.tiff');
    const grayDesc = 'Gray identity tone curve (1D N=255) — apply Curves in Photoshop to adjust tonal response';

    const grayB = new LutBuilder().createIdentity(1, 255);
    grayB.setChain([virtualGray('Gray'), eIntent.perceptual, virtualGray('Gray')]);
    grayB.addMeta({ description: grayDesc, copyright: 'jsColorEngine sample — MIT licence' });

    // ── Build sequentially so console output is ordered ───────────────────────
    console.log('\nBuilding sample TIFFs → samples/tiff_samples/\n');

    console.log('1/3  RGB  sRGB identity            (N=33 scale=3 16-bit, sRGB2014 embedded) …');
    rgbB.exportTIFF({ scale: 3, bitDepth: 16, previewImages: images, description: rgbDesc,
                      iccProfileBytes: srgbBytes || undefined })
        .then(function(bytes) {
            fs.writeFileSync(rgbFile, bytes);
            console.log(`     → ${path.basename(rgbFile)} (${kb(bytes.length)} KB)`);

            console.log('\n2/3  CMYK GRACoL 2006 identity    (N=17 scale=2 16-bit) …');
            return cmykB.exportTIFF({
                scale: 2, bitDepth: 16,
                previewImages: images,
                outputProfile: gracolProfile,
                iccProfileBytes: gracolBytes,
                description: cmykDesc,
            });
        })
        .then(function(bytes) {
            fs.writeFileSync(cmykFile, bytes);
            console.log(`     → ${path.basename(cmykFile)} (${kb(bytes.length)} KB)`);

            console.log('\n3/3  Gray identity tone curve      (N=255 scale=3 16-bit) …');
            return grayB.exportTIFF({
                scale: 3, bitDepth: 16,
                previewImages: images,          // auto-converted to grayscale via BT.601
                description: grayDesc,
            });
        })
        .then(function(bytes) {
            fs.writeFileSync(grayFile, bytes);
            console.log(`     → ${path.basename(grayFile)} (${kb(bytes.length)} KB)`);
            printNextSteps(rgbFile, cmykFile);
        })
        .catch(function(e) { console.error('\nError:', e.message || e); process.exit(1); });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function ensureDir(dir) {
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function kb(n) { return (n / 1024).toFixed(1); }

function printNextSteps(rgbFile, cmykFile) {
    console.log(`
Done.

Next steps:
  1. Open ${path.basename(rgbFile)} in Photoshop (or any colour-managed editor)
  2. Apply a Curves / Hue-Saturation / colour-grade adjustment
  3. Save losslessly (TIFF, no JPEG compression)
  4. Reimport with:

       const { LutBuilder } = require('./samples/LutBuilder');
       const lut = LutBuilder.fromTIFF(require('fs').readFileSync('${rgbFile}'));
       const t   = lut.toTransform({ dataFormat: 'int8' });
       // t.transformArray(pixels)  — full WASM-SIMD speed

  The CMYK file works the same way for CMYK press adjustments.
`);
}
