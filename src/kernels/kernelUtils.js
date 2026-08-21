// src/kernels/kernelUtils.js
//
// Shared helpers for the built-in kernel modules (v1.7 kernel module
// architecture — see docs/deepdive/KernelModules.md).
//
// These were extracted from Transform.transformArrayViaLUT() so that
// allocation + dispatch live behind the kernel boundary. Error strings are
// kept byte-identical to v1.5 — tests assert them.
'use strict';

var lutKernelTable = require('../lutKernelTable.js');
var DEFAULT_WASM_MIN_PIXELS = require('./dispatchThreshold.js');

/**
 * The batch size at which this kernel's WASM variant beats its JS one.
 *
 * See the note at the _threshold assignment below for why this exists and what
 * the precedence is.
 *
 * @param {object} kernel  kernel instance (has .transform)
 * @returns {number}
 */
function resolveThreshold(kernel){
    var override = kernel.transform.constructor.WASM_DISPATCH_MIN_PIXELS;
    if(override !== DEFAULT_WASM_MIN_PIXELS) return override;
    return (typeof kernel.wasmMinPixels === 'number')
        ? kernel.wasmMinPixels
        : DEFAULT_WASM_MIN_PIXELS;
}

/**
 * Allocate or validate the output array for a LUT batch run.
 *
 * Integer LUT modes bake their scale into the CLUT cell values at build
 * time, so the output container type is fixed by the settled lutMode
 * (via transform._expectsU16) — a mismatched container produces garbage,
 * hence the hard throw rather than a silent copy/convert.
 *
 * @param {Transform} transform
 * @param {object} lut
 * @param {number} pixelCount
 * @param {boolean} outputHasAlpha
 * @param {Uint8ClampedArray|Uint16Array} [outputArray]
 * @returns {Uint8ClampedArray|Uint16Array}
 */
function ensureOutputArray(transform, lut, pixelCount, outputHasAlpha, outputArray){
    var outputBytesPerPixel = (outputHasAlpha) ? lut.outputChannels + 1 : lut.outputChannels;
    var expectedLen = pixelCount * outputBytesPerPixel;
    var expectsU16 = transform._expectsU16;
    if(outputArray === undefined){
        return expectsU16
            ? new Uint16Array(expectedLen)
            : new Uint8ClampedArray(expectedLen);
    }
    if(expectsU16){
        if(!(outputArray instanceof Uint16Array)){
            throw new Error('transformArrayViaLUT: outputArray must be Uint16Array for lutMode="' + transform.lutMode + '".');
        }
    } else if(!(outputArray instanceof Uint8ClampedArray)){
        throw new Error('transformArrayViaLUT: outputArray must be Uint8ClampedArray for lutMode="' + transform.lutMode + '".');
    }
    if(outputArray.length < expectedLen){
        throw new Error('transformArrayViaLUT: outputArray too small (got ' + outputArray.length + ', need ' + expectedLen + ').');
    }
    return outputArray;
}

/**
 * Resolve the BIG/SMALL run closures for a kernel instance — v1.7 phase C.
 *
 * The (lutMode × dataFormat × outputChannels) variant selection — WASM
 * availability, intLut presence, fallback degradation — is resolved ONCE per
 * create() (src/lutKernelTable.js is the single source of truth) and cached
 * ON THE KERNEL INSTANCE as _runBig / _runSmall / _threshold. Per-array
 * dispatch is then one threshold compare + one indirect call, inside the
 * kernel — Transform.js holds no dispatch state.
 *
 * Plugin lutModes resolve here too (via _resolvePluginRuns): the plugin's
 * best run closure fills both slots with threshold 0.
 *
 * 1D/2D input LUTs never use the table (their kernels call the interp loop
 * directly) — the run slots stay null for them by design.
 *
 * @param {object} kernel  kernel instance (has .transform)
 */
function resolveTableRuns(kernel){
    var bound = resolveArrayRuns(kernel);
    kernel._runBig      = bound.big;
    kernel._runSmall    = bound.small;
    kernel._threshold   = bound.threshold;
    kernel._runBigKey   = bound.bigName;
    kernel._runSmallKey = bound.smallName;
}

/**
 * Walk this kernel's table and answer with the bound image path.
 *
 * THE TABLE BELONGS TO THE KERNEL (v1.6 phase 4d) — kernel3D_table.js and
 * kernel4D_table.js hold their own rows, gates and fallback ladders. This is
 * the parser for them, not the owner of them: it walks a chain, checks gates,
 * and returns what won. A kernel with a different idea about dispatch ignores
 * it entirely and returns its own {big, small, threshold}.
 *
 * @param {object} kernel  kernel instance (has .transform)
 * @returns {{big:?Function, small:?Function, threshold:number,
 *            bigName:?string, smallName:?string}}
 */
function resolveArrayRuns(kernel){
    var transform = kernel.transform;
    var none = { big: null, small: null, threshold: 0, bigName: null, smallName: null };

    var lut = transform.lut;
    if(!lut) return none;

    var inCh = lut.inputChannels;

    // Gray and duotone bypass the table — their kernels call the dedicated
    // interp loops directly, with no fallback chain to express.
    if(inCh !== 3 && inCh !== 4) return none;

    var modeShort = lutKernelTable.LUT_MODE_SHORT[transform.lutMode];
    if(modeShort === undefined){
        // Not a built-in lutMode — plugin-registered kernels resolve here.
        var plugin = transform.constructor._plugins[transform.lutMode];
        return plugin ? _resolvePluginRuns(kernel, plugin) : none;
    }

    var startKey = lutKernelTable.makeKey(modeShort, inCh, lut.outputChannels);
    var bigRes   = lutKernelTable.resolveLutKernel(transform, lut, startKey, Infinity);
    var smallRes = lutKernelTable.resolveLutKernel(transform, lut, startKey, 0);

    var bound = {
        big:       bigRes.entry.run,
        small:     smallRes.entry.run,
        bigName:   bigRes.key,
        smallName: smallRes.key,
        threshold: 0,
    };
    // Threshold for choosing BIG vs SMALL at call time:
    //   collapsed (BIG === SMALL) → 0 — no WASM-eligible win anywhere in the
    //     chain; threshold=0 saves a per-call comparison in this common case.
    //   distinct (BIG ≠ SMALL) → the class static, read at resolve time so
    //     callers can override it BEFORE create() for profiling (contract
    //     covered by transform_lutMode_wasm.tests.js).
    // THE THRESHOLD HAS ONE SOURCE (v1.6 phase 4e). It used to be read straight
    // off the Transform class static here, while the table rows carried their
    // own copy in `minPx` -- two numbers for one concept. They are reconciled
    // now: `minPx` is a MARKER in the table (the resolver only ever compares it
    // against Infinity or 0, so its value never mattered there), and the real
    // number comes from the kernel.
    //
    // Precedence, most specific first:
    //   1. Transform.WASM_DISPATCH_MIN_PIXELS when a caller has moved it off
    //      the default -- the documented profiling override, which must keep
    //      winning or `= 0` stops forcing the WASM path
    //   2. the kernel's own wasmMinPixels, for a kernel that has measured its
    //      own break-even
    //   3. the shared default
    //
    // Collapsed chains stay at 0: when BIG and SMALL resolve to the same entry
    // there is no WASM-eligible win anywhere in the chain, and a threshold of 0
    // saves the per-call comparison.
    bound.threshold = (bigRes.entry === smallRes.entry) ? 0 : resolveThreshold(kernel);

    if(transform.verbose){
        console.log('  lutKernelTable: ' + startKey
            + ' → big=' + bound.bigName
            + ' small=' + bound.smallName
            + ' threshold=' + bound.threshold);
    }
    return bound;
}

/**
 * Resolve run slots for a plugin-registered lutMode.
 * Picks the most capable variant the plugin offers:
 *   simd (if provided and isSupported('simdKernel'))
 *   wasm (if provided and isSupported('wasmKernel'))
 *   js   (always the base fallback)
 *
 * isSupported(variant) defaults to () => true when not provided.
 *
 * @param {object} kernel  kernel instance
 * @param {object} plugin  descriptor from Transform._plugins
 */
function _resolvePluginRuns(kernel, plugin){
    var transform = kernel.transform;
    var isSup = plugin.isSupported || function(){ return true; };
    var run = plugin.kernel;
    if(plugin.wasmKernel && isSup('wasmKernel')) run = plugin.wasmKernel;
    if(plugin.simdKernel && isSup('simdKernel')) run = plugin.simdKernel;

    var key = transform.lutMode + ':plugin';
    if(transform.verbose){
        console.log('  pluginKernel: ' + transform.lutMode + ' → ' + key);
    }
    return { big: run, small: run, threshold: 0, bigName: key, smallName: key };
}

/**
 * Table-driven BIG/SMALL dispatch for the 3D and 4D kernels — reads the
 * run refs resolved onto the kernel instance by resolveTableRuns().
 *
 * @param {object} kernel  kernel instance (has .transform, ._runBig, ...)
 */
function runTableKernel(kernel, inputArray, outputArray, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha){
    var transform = kernel.transform;

    // Lazy resolve safety net — resolution normally fires at the end of
    // create(). The only way to reach here with null refs is a LUT attached
    // out-of-band after create(). Still cheap (~10ns).
    if(kernel._runBig === null){
        transform._resolveLutKernels();
        if(kernel._runBig === null){
            throw 'lutKernelTable: failed to resolve dispatcher for inputChannels=' + lut.inputChannels
                + ', outputChannels=' + lut.outputChannels + ', lutMode=' + transform.lutMode;
        }
    }

    // One branch, one call.
    var run = (pixelCount >= kernel._threshold)
        ? kernel._runBig
        : kernel._runSmall;
    run(transform, inputArray, outputArray, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha);

    transform._postRunWasmCheck();
}

module.exports = {
    ensureOutputArray: ensureOutputArray,
    resolveTableRuns: resolveTableRuns,
    runTableKernel: runTableKernel,
    resolveThreshold: resolveThreshold,
    resolveArrayRuns: resolveArrayRuns,
};
