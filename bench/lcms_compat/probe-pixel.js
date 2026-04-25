#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * bench/lcms_compat/probe-pixel.js — single-pixel stage-by-stage diff
 * between Little CMS (transicc) and jsColorEngine for outlier triage.
 *
 * Drives the existing patched/instrumented transicc.exe at
 *   bench/lcms_exposed/lcms2-2.16/bin/transicc.exe
 * via piped stdin (no recompile needed — transicc's interactive prompts
 * are guarded by xisatty(stdin), so any pipe input bypasses them).
 *
 * Builds the same Transform in jsCE with pipelineDebug:true, runs the
 * same pixel, then prints both stage traces side-by-side with the
 * canonical (input → output) tuple per stage. Endpoint delta is
 * reported in the destination profile's native units (LSB at u8 for
 * RGB/GRAY, % ink for CMYK, dE76 for Lab, fraction for n-CLR).
 *
 * Usage:
 *
 *   node bench/lcms_compat/probe-pixel.js \
 *        --src "*sRGB" --dst CoatedGRACoL2006.icc \
 *        --intent Relative --in 128,2,99
 *
 *   node bench/lcms_compat/probe-pixel.js \
 *        --src "*Lab" --dst ISOcoated_v2_grey1c_bas.ICC \
 *        --intent Perceptual --in 50,0,0
 *
 * Flags:
 *   --src        source profile spec — *sRGB / *Lab / <file.icc>
 *   --dst        dst profile spec — same
 *   --intent     Absolute | Relative | Perceptual | Saturation
 *   --bpc        enable black point compensation
 *   --in         comma-separated channel values in src native units
 *                  RGB:  0..255 each
 *                  Lab:  L 0..100, a/b -128..127
 *                  CMYK: 0..100 % ink each
 *                  GRAY: 0..255
 *   --transicc   override path to transicc.exe
 *   --quiet      skip the per-engine full trace, only show alignment
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const child_process = require('child_process');
const { Transform, eIntent, convert } = require('../../src/main');
const Profile       = require('../../src/Profile');

// --------------------------------------------------------------------------
//  CLI args
// --------------------------------------------------------------------------

const argv = process.argv.slice(2);
function arg(name, def) {
    const i = argv.indexOf(name);
    return (i >= 0 && i + 1 < argv.length) ? argv[i + 1] : def;
}
function flag(name) { return argv.includes(name); }

const SRC      = arg('--src',     '*sRGB');
const DST      = arg('--dst',     null);
const INTENT_S = arg('--intent', 'Relative');
const BPC      = flag('--bpc');
const IN       = arg('--in',      null);
const QUIET    = flag('--quiet');
const TRANSICC = arg('--transicc',
    path.join(__dirname, '..', 'lcms_exposed', 'lcms2-2.16', 'bin', 'transicc.exe'));

if (!DST || !IN) {
    console.error('Usage: node probe-pixel.js --src <spec> --dst <spec> --intent <Relative|...> --in v1,v2,...');
    console.error('       (--src defaults to "*sRGB")');
    process.exit(2);
}

const PROFILES_DIR = path.join(__dirname, 'profiles');

// --------------------------------------------------------------------------
//  Profile spec → { kind, transiccArg, jsceLoadSpec, kindHint }
// --------------------------------------------------------------------------

function specToTransiccArg(spec) {
    if (/^\*/.test(spec)) return '-i' + spec;        // virtual
    return path.join(PROFILES_DIR, spec);            // file path
}
function specToTransiccOutArg(spec) {
    if (/^\*/.test(spec)) return '-o' + spec;
    return path.join(PROFILES_DIR, spec);
}
function jsceLoadSpec(spec) {
    if (/^\*/.test(spec)) return spec;
    return 'file:' + path.join(PROFILES_DIR, spec);
}

const INTENTS = {
    Absolute:   eIntent.absolute,
    Relative:   eIntent.relative,
    Perceptual: eIntent.perceptual,
    Saturation: eIntent.saturation,
};
const intent = INTENTS[INTENT_S];
if (intent === undefined) {
    console.error('Unknown intent: ' + INTENT_S + ' — try Absolute/Relative/Perceptual/Saturation');
    process.exit(2);
}

// --------------------------------------------------------------------------
//  Build the input pixel for jsCE in the right shape based on src profile
//  colorSpace AFTER it loads. Hand back both the native-units array
//  (what we'll feed to transicc + use for headers) and the jsCE input
//  object (what t.forward() consumes).
// --------------------------------------------------------------------------

function buildJsceInput(srcColorSpace, vals) {
    switch (String(srcColorSpace).toUpperCase()) {
        case 'RGB':  return convert.RGBFloat(vals[0] / 255, vals[1] / 255, vals[2] / 255);
        case 'CMYK': return { type: 9 /* CMYKf */, Cf: vals[0] / 100, Mf: vals[1] / 100,
                              Yf: vals[2] / 100, Kf: vals[3] / 100 };
        case 'LAB':  return convert.Lab(vals[0], vals[1], vals[2]);
        case 'GRAY': return { type: 11 /* Grayf */, Gf: vals[0] / 255 };
        case 'XYZ':  return { type: 13 /* XYZf  */, X: vals[0], Y: vals[1], Z: vals[2] };
        default:     throw new Error('unsupported src colorSpace: ' + srcColorSpace);
    }
}

// transicc reads channels in the same order, but units are:
//   RGB / GRAY: 0..255
//   CMYK:       0..100
//   Lab:        L 0..100, a/b -128..127
//   XYZ:        0..1 (Y normalised)
function valsForTransicc(srcColorSpace, vals) {
    return vals.slice();           // already in native units; no conversion
}

// --------------------------------------------------------------------------
//  Spawn transicc with stdin pipe, capture full stdout
// --------------------------------------------------------------------------

function runTransicc(srcSpec, dstSpec, intentName, bpc, vals) {
    if (!fs.existsSync(TRANSICC)) {
        return { ok: false, reason: 'transicc.exe not found at ' + TRANSICC, out: '' };
    }

    const intentNum = { Perceptual: 0, Relative: 1, Saturation: 2, Absolute: 3 }[intentName];

    // -i / -o accept either the * virtual name or a file path. -t = intent.
    // -b enables BPC. We use -v3 to get the full per-stage trace from the
    // patched transicc (matches what we saw in the user paste).
    const args = ['-v3'];
    args.push('-t' + intentNum);
    if (bpc) args.push('-b');

    if (/^\*/.test(srcSpec)) args.push('-i' + srcSpec);
    else                     args.push('-i' + path.join(PROFILES_DIR, srcSpec));
    if (/^\*/.test(dstSpec)) args.push('-o' + dstSpec);
    else                     args.push('-o' + path.join(PROFILES_DIR, dstSpec));

    const stdinPayload = vals.join(' ') + ' q\n';

    let res;
    try {
        res = child_process.spawnSync(TRANSICC, args, {
            input: stdinPayload,
            encoding: 'utf8',
            timeout: 5000,
        });
    } catch (e) {
        return { ok: false, reason: 'spawn threw: ' + e.message, out: '' };
    }
    if (res.status !== 0 && !res.stdout) {
        return { ok: false, reason: 'transicc exit ' + res.status + ': ' + (res.stderr || ''), out: res.stdout || '' };
    }
    return { ok: true, out: res.stdout, args, stdinPayload };
}

// --------------------------------------------------------------------------
//  Parse lcms transicc -v3 stage trace into [{ index, name, in[], out[] }]
//
//  Each stage block starts with `  Stage N : <Name>` and ends just before
//  the next `Stage` line or the `Last Stage was` marker. We extract the
//  *last* `( inputs ) -> ( outputs )` line in each block — which is the
//  canonical engine summary line (multi-step stages like CLUT+curves
//  emit several intermediate ones; the trailing one is always the
//  whole-stage summary).
// --------------------------------------------------------------------------

const RE_STAGE_HEAD = /^\s*Stage\s+(\d+)\s*:\s*(.*)$/i;
// Tuple format variants seen in transicc -v3 output:
//   "(in1 in2 in3 ) -> (out1 out2 out3 )"           (Curves, CLUT sub-lines)
//   "<name> in1 in2 in3 ) -> (out1 out2 out3 )"     (Matrix, missing opening paren — looks like a bug
//                                                    in the patched lcms instrumentation, but consistent)
//   "PCSXYZ(in1 in2 in3) -> PCSLab(out1 out2 out3)" (XYZ2Lab labelled-paren form)
// We accept an optional opening "(" so the missing-paren case still matches,
// and we only require the closing ")" before the "-> (" arrow.
const RE_TUPLE_LINE = /\(?\s*([\-\d.eE][\-\d.eE\s,]*?)\s*\)\s*->\s*[A-Za-z]*\(\s*([\-\d.eE][\-\d.eE\s,]*?)\s*\)/;

function parseTupleFromLine(raw) {
    const m = raw.match(RE_TUPLE_LINE);
    if (!m) return null;
    const inA  = m[1].trim().split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
    const outA = m[2].trim().split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
    if (!inA.length || !outA.length) return null;
    return { in: inA, out: outA };
}

function parseLcmsStages(stdout) {
    // transicc -v3 fires up to TWO extra trivial transforms BEFORE the
    // actual pixel — the BPC black-point detection probes for input and
    // output profiles (look for "Black point compensation" + "Input Profile
    // BPC: 0 0 0" / "Output Profile PBC: 0 0 0" markers in the raw trace).
    // Each probe emits its own Stage 1, 2, 3 cycle with `(0,0,0)` inputs.
    // We only want the LAST cycle, which corresponds to the user's pixel.
    //
    // Strategy: re-anchor the stage list whenever we see `Stage 1` AFTER
    // having already seen a higher-numbered stage (so cycles 1→2→3 + 1→2→3
    // get reset, but the inner monotone progression survives).
    const lines  = stdout.split(/\r?\n/);
    let stages = [];
    let cur = null;
    let sawAfterReset = -1;
    for (const raw of lines) {
        const headMatch = raw.match(RE_STAGE_HEAD);
        if (headMatch) {
            const idx = parseInt(headMatch[1], 10);
            if (idx === 1 && stages.length > 0) {
                // new cycle — drop everything we accumulated so far
                if (cur) stages.push(cur);
                stages = [];
                cur = null;
            }
            if (cur) stages.push(cur);
            cur = { index: idx, name: headMatch[2].trim().split(/\s+/)[0],
                    rawName: headMatch[2].trim(), tuples: [] };
            sawAfterReset = idx;
            // fall through — same line may also carry a tuple (Stages 1,4,6)
        }
        if (cur) {
            const t = parseTupleFromLine(raw);
            if (t) cur.tuples.push(t);
        }
    }
    if (cur) stages.push(cur);
    return stages.map(s => ({
        index:   s.index,
        name:    s.name,
        rawName: s.rawName,
        // Whole-stage summary: first sub-line's input, last sub-line's output.
        // Single-tuple stages collapse to the obvious case; multi-tuple
        // stages (CLUT: FromFloatTo16 → TrilinearInterp16 → From16ToFloat)
        // get a true float-in-float-out summary across the int round-trip.
        in:      s.tuples.length ? s.tuples[0].in                     : null,
        out:     s.tuples.length ? s.tuples[s.tuples.length - 1].out  : null,
    }));
}

// Final OUTPUT line from transicc -v3:
//   "OUTPUT = (0.551919, 1.000000, 0.234928, 0.172442, )"
// We pull this for the endpoint comparison since the printed C=/M=/Y=/K=
// is integer-quantised and we want full float for the ΔE math.
function parseLcmsEndpoint(stdout) {
    // -v3 emits multiple OUTPUT lines (one per BPC probe + one for the
    // actual pixel). The actual pixel is always LAST, so take that.
    const all = stdout.match(/OUTPUT\s*=\s*\(\s*([-\d.eE,\s]+?)\)/g);
    if (!all || !all.length) return null;
    const last = all[all.length - 1];
    const m = last.match(/OUTPUT\s*=\s*\(\s*([-\d.eE,\s]+?)\)/);
    return m[1].trim().replace(/,$/, '').split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
}

// --------------------------------------------------------------------------
//  Parse jsCE historyInfo() into [{ name, in[], out[] }]
//
//  Format example:
//     [PipeLine Input] . . . . . . . . . . RGBf: 0.502, 0.0078, 0.3882
//     [Input2Device : RGBMatrix : stage_RGB_to_Device] . . . (RGBf: 0.502, 0.0078, 0.3882) > (0.501961, 0.007843, 0.388235)
//     *[optimised : stage_Gamma_Inverse] . . . (0.501961, 0.007843, 0.388235) > (0.215861, 0.000607, 0.124772)
//
//  We pull the last `( ... ) > ( ... )` per line; the labelled-prefix
//  variants like `RGBf: ...` get their type-prefix stripped before
//  number parsing.
// --------------------------------------------------------------------------

const RE_JSCE_TUPLE = /\(\s*([^()]+?)\s*\)\s*>\s*\(\s*([^()]+?)\s*\)/g;

function parseTupleNumbers(s) {
    return s
        .replace(/^[A-Za-z][A-Za-z0-9]*:\s*/, '') // strip "RGBf: " etc.
        .split(/[\s,]+/)
        .map(parseFloat)
        .filter(Number.isFinite);
}

function parseJsceStages(historyText) {
    const out = [];
    for (const rawLine of historyText.split(/\r?\n/)) {
        const labelMatch = rawLine.match(/^\s*\*?\s*\[([^\]]+)\]/);
        if (!labelMatch) continue;
        const label = labelMatch[1].trim();
        // skip the auto Start/End markers — they have no in/out tuple
        if (/^PipeLine/i.test(label)) continue;
        // grab the LAST (...) > (...) on the line
        let m, last = null;
        RE_JSCE_TUPLE.lastIndex = 0;
        while ((m = RE_JSCE_TUPLE.exec(rawLine)) !== null) last = m;
        if (!last) continue;
        out.push({
            name: label,
            in:   parseTupleNumbers(last[1]),
            out:  parseTupleNumbers(last[2]),
        });
    }
    return out;
}

// --------------------------------------------------------------------------
//  Stage alignment — match jsCE stages to lcms stages by output-shape
//  signature (channel count + closest L2 distance).
//
//  jsCE often has 1–2 extra "device wrap" stages (Input2Device,
//  Device2Output, PCSXYZ_to_PCSv4 split into two parts) that lcms
//  collapses into the curve+matrix pair. We just look up each lcms
//  stage in the jsCE list by "first jsCE stage whose output channel
//  count matches and whose values are within 1e-2 of lcms's output."
// --------------------------------------------------------------------------

function l2(a, b) {
    if (!a || !b || a.length !== b.length) return Infinity;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
    return Math.sqrt(s);
}

function alignStages(lcms, jsce) {
    const pairs = [];
    let jStart = 0;
    for (const L of lcms) {
        let bestIdx = -1, bestD = Infinity;
        for (let j = jStart; j < jsce.length; j++) {
            if (jsce[j].out.length !== (L.out ? L.out.length : -1)) continue;
            const d = l2(jsce[j].out, L.out);
            if (d < bestD) { bestD = d; bestIdx = j; }
        }
        if (bestIdx >= 0 && bestD < 1.0) {
            pairs.push({ lcms: L, jsce: jsce[bestIdx], delta: bestD });
            jStart = bestIdx + 1;
        } else {
            pairs.push({ lcms: L, jsce: null, delta: null });
        }
    }
    return pairs;
}

// --------------------------------------------------------------------------
//  Pretty-printing helpers
// --------------------------------------------------------------------------

function fmtArr(a, prec) {
    if (!a || !a.length) return '<none>';
    return '(' + a.map(v => v.toFixed(prec)).join(', ') + ')';
}

function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

// --------------------------------------------------------------------------
//  Endpoint metrics — match what bench/lcms_compat/run.js uses
// --------------------------------------------------------------------------

function nativeOut(jsceObj, dstColorSpace, lcmsRawOut) {
    switch (String(dstColorSpace).toUpperCase()) {
        case 'RGB':  return [jsceObj.Rf * 255, jsceObj.Gf * 255, jsceObj.Bf * 255];
        case 'CMYK': return [jsceObj.Cf * 100, jsceObj.Mf * 100, jsceObj.Yf * 100, jsceObj.Kf * 100];
        case 'GRAY': return ['Gf' in jsceObj ? jsceObj.Gf * 255 : jsceObj.G];
        case 'LAB':  return [jsceObj.L, jsceObj.a, jsceObj.b];
        case 'XYZ':  return [jsceObj.X, jsceObj.Y, jsceObj.Z];
        default:     return [];
    }
}

// transicc emits CMYK/RGB/GRAY in 0..255 / 0..100 already (its OutputRange),
// but the OUTPUT = (...) line is always the float pre-scale (0..1 for
// RGB/CMYK/GRAY, native for Lab/XYZ). Match jsCE's nativeOut units.
function lcmsOutNative(lcmsFloatOut, dstColorSpace) {
    switch (String(dstColorSpace).toUpperCase()) {
        case 'RGB':  return [lcmsFloatOut[0] * 255, lcmsFloatOut[1] * 255, lcmsFloatOut[2] * 255];
        case 'CMYK': return [lcmsFloatOut[0] * 100, lcmsFloatOut[1] * 100, lcmsFloatOut[2] * 100, lcmsFloatOut[3] * 100];
        case 'GRAY': return [lcmsFloatOut[0] * 255];
        // For Lab destinations, transicc emits the OUTPUT line in ICC PCS-LabV2 encoding:
        //   L_pcs = L / 100        a_pcs = (a + 128) / 255       b_pcs = (b + 128) / 255
        // Verified empirically from `*sRGB → *Lab` trace where OUTPUT = (0.283862,0.708983,0.424348)
        // resolves to lcms's "L*=28.3862 a*=52.7908 b*=-19.7912" (× 255, not 256).
        case 'LAB':  return [lcmsFloatOut[0] * 100, lcmsFloatOut[1] * 255 - 128, lcmsFloatOut[2] * 255 - 128];
        case 'XYZ':  return [lcmsFloatOut[0], lcmsFloatOut[1], lcmsFloatOut[2]];
        default:     return lcmsFloatOut.slice();
    }
}

function endpointMetric(actual, expected, dstColorSpace) {
    if (String(dstColorSpace).toUpperCase() === 'LAB') {
        const dL = actual[0] - expected[0];
        const da = actual[1] - expected[1];
        const db = actual[2] - expected[2];
        return { metric: 'dE76', value: Math.sqrt(dL*dL + da*da + db*db) };
    }
    let m = 0;
    for (let i = 0; i < actual.length; i++) m = Math.max(m, Math.abs(actual[i] - expected[i]));
    const cs = String(dstColorSpace).toUpperCase();
    const unit = (cs === 'CMYK') ? '% ink' :
                 (cs === 'RGB' || cs === 'GRAY') ? 'LSB at u8' :
                 'fraction';
    return { metric: 'max|d|', value: m, unit };
}

// --------------------------------------------------------------------------
//  Main
// --------------------------------------------------------------------------

(async () => {
    const vals = IN.split(',').map(s => parseFloat(s));
    if (vals.some(v => !Number.isFinite(v))) {
        console.error('--in must be comma-separated numbers; got: ' + IN);
        process.exit(2);
    }

    // 1. load jsCE profiles + build transform with debug on
    const srcP = new Profile(); await srcP.loadPromise(jsceLoadSpec(SRC));
    const dstP = new Profile(); await dstP.loadPromise(jsceLoadSpec(DST));
    if (!srcP.loaded) { console.error('src load failed: ' + SRC); process.exit(1); }
    if (!dstP.loaded) { console.error('dst load failed: ' + DST); process.exit(1); }

    const t = new Transform({ dataFormat: 'objectFloat', BPC: BPC, pipelineDebug: true });
    t.create(srcP, dstP, intent);
    const jsceInput = buildJsceInput(srcP.colorSpace, vals);
    const jsceOutObj = t.forward(jsceInput);

    const jsceStages   = parseJsceStages(t.historyInfo());
    const jsceEndpoint = nativeOut(jsceOutObj, dstP.colorSpace);

    // 2. run lcms transicc with the same input
    const lcms = runTransicc(SRC, DST, INTENT_S, BPC, valsForTransicc(srcP.colorSpace, vals));
    if (!lcms.ok) {
        console.error('!! transicc failed: ' + lcms.reason);
        console.error('   expected at: ' + TRANSICC);
        console.error('   (jsCE output below for reference)');
    }

    const lcmsStages   = lcms.ok ? parseLcmsStages(lcms.out) : [];
    const lcmsRaw      = lcms.ok ? parseLcmsEndpoint(lcms.out) : null;
    const lcmsEndpoint = lcmsRaw ? lcmsOutNative(lcmsRaw, dstP.colorSpace) : null;

    // 3. print
    console.log('');
    console.log('=== probe-pixel ===');
    console.log('  src      : ' + SRC + '  (' + srcP.colorSpace + ', ' + srcP.name + ')');
    console.log('  dst      : ' + DST + '  (' + dstP.colorSpace + ', ' + dstP.name + ')');
    console.log('  intent   : ' + INTENT_S + (BPC ? ' + BPC' : ''));
    console.log('  input    : ' + vals.join(', ') + '   (src native units)');
    console.log('');

    if (!QUIET) {
        console.log('--- lcms transicc -v3 (' + lcmsStages.length + ' stages) ---');
        for (const s of lcmsStages) {
            console.log('  ' + pad('S' + s.index, 4) + pad(s.name, 22) +
                        ' ' + fmtArr(s.in, 6) + ' -> ' + fmtArr(s.out, 6));
        }
        console.log('');

        console.log('--- jsCE pipelineDebug (' + jsceStages.length + ' stages) ---');
        for (let i = 0; i < jsceStages.length; i++) {
            const s = jsceStages[i];
            const shortName = s.name.replace(/^.*:\s*/, '').replace(/^optimised\s*:\s*/, '').trim();
            console.log('  ' + pad('S' + (i + 1), 4) + pad(shortName.slice(0, 30), 30) +
                        ' ' + fmtArr(s.in, 6) + ' -> ' + fmtArr(s.out, 6));
        }
        console.log('');
    }

    if (lcmsStages.length) {
        console.log('--- aligned per-stage delta (lcms ↔ jsCE) ---');
        const pairs = alignStages(lcmsStages, jsceStages);
        for (const p of pairs) {
            const L = p.lcms;
            if (!p.jsce) {
                console.log('  ' + pad('S' + L.index, 4) + pad(L.name, 24) +
                            ' lcms=' + fmtArr(L.out, 6) + '   jsCE=<no match>');
                continue;
            }
            const J = p.jsce;
            const jname = J.name.replace(/^.*:\s*/, '').replace(/^optimised\s*:\s*/, '').trim().slice(0, 22);
            console.log('  ' + pad('S' + L.index, 4) + pad(L.name, 22) +
                        ' Δ=' + p.delta.toExponential(2) +
                        '   lcms=' + fmtArr(L.out, 6) +
                        '   jsCE=' + fmtArr(J.out, 6) + '  (' + jname + ')');
        }
        console.log('');
    }

    console.log('--- endpoint (' + dstP.colorSpace + ', native units) ---');
    console.log('  jsCE : ' + fmtArr(jsceEndpoint, 6));
    if (lcmsEndpoint) {
        console.log('  lcms : ' + fmtArr(lcmsEndpoint, 6));
        const m = endpointMetric(jsceEndpoint, lcmsEndpoint, dstP.colorSpace);
        console.log('  Δ    : ' + m.value.toExponential(3) + '   (' + m.metric + (m.unit ? ' ' + m.unit : '') + ')');
    } else {
        console.log('  lcms : <not available>');
    }
    console.log('');
})();
