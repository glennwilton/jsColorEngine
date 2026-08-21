#!/usr/bin/env node
/* ============================================================================
 *  red-kernel.js — a kernel that returns red, and one that yields
 * ----------------------------------------------------------------------------
 *  Released under the MIT License
 *  Copyright (c) 2026 Glenn Wilton, O2 Creative Limited.
 *
 *  The limit case for the kernel contract. This kernel ignores the colour
 *  science entirely and answers red to everything — and the engine runs it
 *  without complaint, because deciding what a conversion means is the kernel's
 *  job and Transform's job is to build a pipeline and get out of the way.
 *
 *  That is the point, not a defect. The test of an ownership boundary is
 *  whether the owner can be absurd without the host noticing. If Transform had
 *  to understand red, it would not own only the pipeline.
 *
 *  IT ONLY APPLIES WHEN ASKED. `kernelOptions.onlyRed` turns it on; without it
 *  the kernel delegates to whatever it wrapped and the engine behaves normally.
 *  That is the composition pattern in miniature — a wrapper checks its own
 *  condition and either takes the transform or yields downward:
 *
 *      init: function(pipeline, opts){
 *          if(!mine(opts)) return base.init.call(this, pipeline, opts);
 *          return { pipeline: pipeline, kernel: null, meta: {...} };
 *      }
 *
 *  BOTH SURFACES, OR NEITHER. A kernel that changes what a colour becomes has
 *  to change BOTH paths, or transform(colour) and transformArray() disagree —
 *  single colours would go red while images stayed correct, and nothing would
 *  report it. So this overrides floatFor AND array.
 *
 *  Usage:
 *    node samples/kernels/red-kernel.js
 * ============================================================================
 */
'use strict';

const path = require('path');
const { Transform, eIntent } = require('../../src/main.js');
const Profile = require('../../src/Profile.js');

// ---------------------------------------------------------------------------
// The kernel
// ---------------------------------------------------------------------------

/**
 * Wrap the kernel registered for 3-channel input with one that can answer red.
 * @returns {Function} restore
 */
function installRedKernel(){
    const base = Transform.kernels[3];

    // Object.create: everything not overridden below is inherited, so this is
    // only as large as the behaviour it actually changes.
    const red = Object.create(base);
    red.name = 'red-kernel';

    // Both hooks see kernelOptions, which matters: floatFor runs on the
    // descriptor while the pipeline is being built, BEFORE init(), so it cannot
    // read anything init stashed. It has to decide from its options directly.
    const wantsRed = opts => !!(opts && opts.kernelOptions && opts.kernelOptions.onlyRed);

    // Describe ourselves honestly — a wrapper that yielded should not claim
    // to have handled the conversion.
    red.info = function(){
        return this._red
            ? { name: 'red-kernel', dimensions: 3, claimed: true }
            : (typeof base.info === 'function'
                ? base.info.call(this)
                : { name: base.name, dimensions: 3, claimed: false });
    };

    red.init = function(pipeline, opts){
        // Not for us — hand the transform back to the kernel we wrapped. The
        // engine never learns we were in the chain.
        if(!wantsRed(opts)) return base.init.call(this, pipeline, opts);

        this._red = true;
        return {
            pipeline: pipeline,
            kernel: null,                       // we keep it ourselves
            meta: { name: 'red-kernel', dimensions: 3, claimed: true, why: 'onlyRed' },
        };
    };

    // SINGLE COLOUR. floatFor returns the function a pipeline stage runs, one
    // colour at a time.
    //
    // EMIT IN THE STAGE'S OUTPUT ENCODING, which here is device 0..1. Do NOT
    // multiply by lut.outputScale: that is the factor the normal interpolator
    // applies to the CLUT's own cell values on the way out — 1/65535 for a u16
    // table — and a kernel that already has a 0..1 answer would be scaling it
    // down into the noise. (It is worth getting wrong once: `1 * outputScale`
    // produced 0.0000153 and the sample printed black.)
    red.floatFor = function(lut, hints){
        if(!wantsRed(hints)) return base.floatFor.call(this, lut, hints);
        return {
            stageName: 'tetrahedralInterp3D',   // a name the optimiser knows
            funct: function(input, l){
                const out = new Array(l.outputChannels);
                out[0] = 1;                                   // full first channel
                for(let c = 1; c < l.outputChannels; c++) out[c] = 0;
                return out;
            },
        };
    };

    // IMAGES. Same answer, written straight into the destination.
    red.array = function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve){
        if(!this._red){
            return base.array.call(this, inputArray, outputArray, pixelCount, lut,
                                   inAlpha, outAlpha, preserve);
        }
        const outCh  = (lut ? lut.outputChannels : 3) + (outAlpha ? 1 : 0);
        const colour = (lut ? lut.outputChannels : 3);
        if(pixelCount === undefined || pixelCount === null){
            pixelCount = Math.floor(inputArray.length / ((lut ? lut.inputChannels : 3) + (inAlpha ? 1 : 0)));
        }
        const out = outputArray && outputArray.length >= pixelCount * outCh
            ? outputArray : new Uint8ClampedArray(pixelCount * outCh);

        for(let p = 0, w = 0; p < pixelCount; p++){
            out[w++] = 255;
            for(let c = 1; c < colour; c++) out[w++] = 0;
            if(outAlpha) out[w++] = 255;
        }
        return out;
    };

    Transform.kernels[3] = red;
    return () => { Transform.kernels[3] = base; };
}

// ---------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------

if(require.main === module){
    // RGB -> CMYK through a real profile: the pipeline has a LUT stage, so
    // floatFor is actually consulted, and the accuracy path works. (With
    // buildLut:true the single-colour path on a baked table does not agree with
    // the image path — a separate issue, and not one to demonstrate here.)
    const cmyk = new Profile();
    cmyk.loadFile(path.join(__dirname, '..', '..', '__tests__', 'GRACoL2006_Coated1v2.icc'));

    const restore = installRedKernel();
    try {
        const sample = [128, 64, 200];
        const show = (label, opts) => {
            const t = new Transform(Object.assign({ dataFormat: 'int8', buildLut: false }, opts));
            t.create('*sRGB', cmyk, eIntent.relative);
            console.log('    kernel        : ' + t.kernelInfo().name);
            console.log('    transform()   : ' + JSON.stringify(t.transform(sample)));
            console.log('    transformArray: ' + JSON.stringify(Array.from(
                t.transformArray(new Uint8ClampedArray(sample), false, false, false, 1))));
        };

        console.log('');
        console.log('=== red kernel =====================================================');
        console.log('');
        console.log('  Without kernelOptions.onlyRed — the wrapper yields downward:');
        show('normal', {});

        console.log('');
        console.log('  With onlyRed: true — the wrapper keeps the transform:');
        show('red', { kernelOptions: { onlyRed: true } });

        console.log('');
        console.log('  Both paths agree, which is the part that matters. A kernel that');
        console.log('  changed only one of them would give different answers for the');
        console.log('  same colour depending on whether you asked for one or a million.');
        console.log('');
    } finally {
        restore();
    }
}

module.exports = { installRedKernel };
