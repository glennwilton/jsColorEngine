/*
 * bench/compile_poc/probe_rgb_to_cmyk.js
 * Small one-off probe: build an RGB -> CMYK (no-LUT/float pipeline) Transform,
 * enable pipelineDebug, run a single pixel, dump what stages got used.
 *
 * Usage (from repo root):
 *     node bench/compile_poc/probe_rgb_to_cmyk.js
 */

'use strict';

const path  = require('path');
const { Transform, eIntent } = require('../../src/main');
const Profile = require('../../src/Profile');

const cmykFilename = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

(async () => {
    const cmyk = new Profile();
    await cmyk.loadPromise('file:' + cmykFilename);
    if (!cmyk.loaded) {
        throw new Error('CMYK profile failed to load');
    }

    // No LUT: force the full stage pipeline so emit_js_stage_* has something
    // to bite on. Use the float/accuracy path, pipelineDebug ON.
    const t = new Transform({
        dataFormat: 'device',
        buildLut:   false,
        lutMode:    'float',
        pipelineDebug: true,
    });

    t.create('*srgb', cmyk, eIntent.relative);

    // Single pixel: sRGB device-scale 0..1
    const rgb = [150/255, 100/255, 50/255];
    const out = t.forward(rgb);

    console.log('===== chainInfo =====');
    console.log(t.chainInfo());

    console.log('\n===== stage list (inputs > name > outputs) =====');
    console.log(t.getStageNames(true, false));

    console.log('\n===== pipelineDebug history =====');
    console.log(t.historyInfo());

    console.log('\n===== input -> output =====');
    console.log('rgb in  :', rgb);
    console.log('device out:', out);

    console.log('\n===== distinct stage names =====');
    const names = t.pipeline.map(s => s.stageName);
    const uniq  = Array.from(new Set(names));
    console.log(uniq.join('\n'));

    console.log('\n===== emit coverage =====');
    for (const n of uniq) {
        const m = 'emit_js_stage_' + n;
        const has = typeof t[m] === 'function';
        console.log((has ? '  ok   ' : '  MISS ') + m);
    }
})().catch(e => { console.error(e); process.exit(1); });
