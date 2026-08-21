#!/usr/bin/env node
/* ============================================================================
 *  kernel-inspector.js — a kernel that measures other kernels
 * ----------------------------------------------------------------------------
 *  Released under the MIT License
 *  Copyright (c) 2026 Glenn Wilton, O2 Creative Limited.
 *
 *  A kernel does not have to convert anything. This one wraps whatever kernel
 *  currently owns a dimension, times every call that passes through it, and
 *  hands the work straight on. No hooks, no instrumentation flag, no change to
 *  Transform.js — an inspector is just a kernel that yields.
 *
 *  THE PATTERN. A kernel's init() is handed the built pipeline and returns
 *  {pipeline, kernel, meta}. Returning `kernel` yields the batch path to
 *  something else. A wrapper that wants the kernel beneath it to keep running
 *  simply delegates:
 *
 *      init: function(pipeline, opts){
 *          return base.init.call(this, pipeline, opts);   // yield downward
 *      }
 *
 *  Everything else — floatFor, array, create, release — is inherited through
 *  the prototype, so a wrapper only writes the members it actually wants to
 *  observe or change.
 *
 *  WHY THIS IS CHEAP. array() runs once per IMAGE, not once per pixel, so
 *  wrapping it costs one function call and one clock read per image. The
 *  per-pixel loop inside is untouched. Timing at this level is free in a way
 *  that timing inside the loop never could be.
 *
 *  Usage:
 *    node samples/kernels/kernel-inspector.js
 * ============================================================================
 */
'use strict';

const path = require('path');
const { Transform, eIntent } = require('../../src/main.js');
const Profile = require('../../src/Profile.js');

// ---------------------------------------------------------------------------
// The inspector
// ---------------------------------------------------------------------------

/**
 * Wrap the kernel currently registered for a dimension.
 *
 * @param {number} dimension  input channel count, 1..15
 * @param {object} [log]      collects rows; one is made if omitted
 * @returns {{restore: Function, rows: Array, report: Function}}
 */
function inspect(dimension, log){
    const rows = log || [];
    const base = Transform.kernels[dimension];

    // Object.create means every member we do not override is inherited — the
    // wrapper is only as big as the thing it wants to watch.
    const wrapper = Object.create(base);
    wrapper.name = base.name + '+inspector';

    wrapper.init = function(pipeline, opts){
        const started = process.hrtime.bigint();
        const result = base.init.call(this, pipeline, opts);
        rows.push({
            what: 'init',
            kernel: result && result.meta ? result.meta.name : base.name,
            ms: Number(process.hrtime.bigint() - started) / 1e6,
            px: null,
        });

        // If the kernel beneath yielded to another one, wrap THAT too —
        // otherwise the interesting calls happen somewhere we cannot see.
        if(result && result.kernel){
            result.kernel = wrapInstance(result.kernel, rows);
        }
        return result;
    };

    wrapper.array = function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
        const started = process.hrtime.bigint();
        const out = base.array.call(this, inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve);
        record(rows, base.name, started, pixelCount, inputArray, lut);
        return out;
    };

    Transform.kernels[dimension] = wrapper;

    return {
        rows,
        restore(){ Transform.kernels[dimension] = base; },
        report(){ return report(rows); },
    };
}

/** Wrap a kernel INSTANCE that was yielded to, so its array calls are timed. */
function wrapInstance(instance, rows){
    const name = (typeof instance.info === 'function') ? instance.info().name : instance.name;
    const inner = instance.array;
    instance.array = function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
        const started = process.hrtime.bigint();
        const out = inner.call(this, inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve);
        record(rows, name, started, pixelCount, inputArray, lut);
        return out;
    };
    return instance;
}

function record(rows, kernel, started, pixelCount, inputArray, lut){
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // transformArray() may leave pixelCount undefined; derive it the way the
    // kernels do so the MPx/s column is not nonsense.
    let px = pixelCount;
    if(px === undefined || px === null){
        const inCh = lut ? lut.inputChannels : 3;
        px = Math.floor(inputArray.length / inCh);
    }
    rows.push({ what: 'array', kernel, ms, px });
}

function report(rows){
    const out = [];
    out.push('');
    out.push('  call    kernel                        pixels        ms      MPx/s');
    out.push('  ------  ----------------------------  ---------  ------  ---------');
    for(const r of rows){
        const mpxs = (r.px && r.ms > 0) ? ((r.px / 1e6) / (r.ms / 1000)).toFixed(1) : '';
        out.push('  ' + r.what.padEnd(6)
            + '  ' + String(r.kernel).padEnd(28)
            + '  ' + (r.px === null ? '' : r.px.toLocaleString()).padStart(9)
            + '  ' + r.ms.toFixed(2).padStart(6)
            + '  ' + mpxs.padStart(9));
    }
    // Totals per kernel — the number you actually wanted.
    const totals = {};
    for(const r of rows){
        if(r.what !== 'array') continue;
        const t = totals[r.kernel] || (totals[r.kernel] = { ms: 0, px: 0, calls: 0 });
        t.ms += r.ms; t.px += r.px; t.calls++;
    }
    const names = Object.keys(totals);
    if(names.length){
        out.push('');
        out.push('  totals by kernel');
        for(const n of names){
            const t = totals[n];
            out.push('    ' + n.padEnd(28) + String(t.calls).padStart(3) + ' calls  '
                + t.ms.toFixed(2).padStart(8) + ' ms  '
                + ((t.px / 1e6) / (t.ms / 1000)).toFixed(1).padStart(8) + ' MPx/s');
        }
    }
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

if(require.main === module){
    const cmykPath = path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc');
    const cmyk = new Profile();
    cmyk.loadFile(cmykPath);

    const px = 1 << 18;                       // 262,144 pixels
    const rgb = new Uint8ClampedArray(px * 3);
    for(let i = 0; i < rgb.length; i++) rgb[i] = (i * 37) & 255;

    const probe = inspect(3);
    try {
        console.log('');
        console.log('=== kernel inspector ===============================================');
        console.log('  Wrapping Transform.kernels[3]. Nothing in Transform.js changes.');

        // 1. A pair that folds — Kernel3D yields to the matrix shaper, and the
        //    inspector follows it there.
        const folded = new Transform({ dataFormat: 'int8', buildLut: false });
        folded.create('*sRGB', '*AdobeRGB', eIntent.relative);
        console.log('');
        console.log('  *sRGB -> *AdobeRGB  ran on: ' + folded.kernelInfo().name);
        folded.transformArray(rgb, false, false, false, px);
        folded.transformArray(rgb, false, false, false, px);

        // 2. A pair that does not fold — the table path stays.
        const tabled = new Transform({ dataFormat: 'int8', buildLut: true });
        tabled.create('*sRGB', cmyk, eIntent.relative);
        console.log('  *sRGB -> GRACoL     ran on: ' + tabled.kernelInfo().name);
        tabled.transformArray(rgb, false, false, false, px);

        console.log(probe.report());
        console.log('');
        console.log('  Both conversions were measured without a single line of');
        console.log('  instrumentation in the engine. The inspector is a kernel that');
        console.log('  yields, and yielding is how kernels compose.');
        console.log('');
    } finally {
        probe.restore();
    }
}

module.exports = { inspect };
