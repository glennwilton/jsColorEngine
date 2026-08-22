// src/kernels/kernelUtils.js
//
// Shared helpers for the built-in kernel modules
// (see docs/deepdive/KernelContract.md).
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
 * See bindArrayRuns() below for who owns this number and when it is read.
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
 * Resolve this kernel's image path and store it ON ITSELF.
 *
 * Called from the kernel's own init(), which is the first moment everything
 * this depends on is final: the pipeline is built and optimised, the LUT
 * exists, and create() has already demoted lutMode to what the host can
 * actually run.
 *
 * THE THREE FIELDS ARE THE KERNEL'S OWN. Nothing outside reads them — not
 * Transform, not this module after it returns. A kernel with one
 * implementation leaves the threshold at 0 and never compares; a kernel with
 * a WASM path above some pixel count and a JS path below keeps both and picks
 * inside its array(). Batch size is not the caller's business.
 *
 * @param {object} kernel  kernel instance (has .transform)
 */
function bindArrayRuns(kernel){
    var bound = resolveArrayRuns(kernel);
    kernel.arrayFnBig     = bound.big;
    kernel.arrayFnSml     = bound.small;
    kernel.threshold      = bound.threshold;
    kernel.arrayFnBigName = bound.bigName;
    kernel.arrayFnSmlName = bound.smallName;
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

    // Non-built-in lutMode — the plugin registry answers.
    if(lutKernelTable.LUT_MODE_SHORT[transform.lutMode] === undefined){
        var plugin = transform.constructor._plugins[transform.lutMode];
        return plugin ? _resolvePluginRuns(kernel, plugin) : none;
    }

    // THE KERNEL ANSWERS FOR ITSELF. A kernel with a `table` resolves through
    // it; one without (1-D, 2-D, N-D) has a single implementation its array()
    // calls directly and needs no dispatch at all.
    if(!kernel.table || typeof kernel.table.resolve !== 'function') return none;

    var picked = kernel.table.resolve(kernel, lut);

    // Collapsed — BIG and SMALL are the same implementation, so there is no
    // WASM-eligible win in this configuration and a threshold of 0 saves the
    // per-call comparison.
    var bound = {
        big:       picked.big,
        small:     picked.small,
        bigName:   picked.bigName,
        smallName: picked.smallName,
        threshold: (picked.big === picked.small) ? 0 : resolveThreshold(kernel),
    };

    if(transform.verbose){
        console.log('  ' + (kernel.name || 'kernel') + ': big=' + bound.bigName
            + ' small=' + bound.smallName + ' threshold=' + bound.threshold);
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
 * Accuracy-path pixelCache hint. 'auto' is the kernel's to resolve.
 * 4/5/6 promote it to a single-entry table; a number is already a
 * decision and must not be overridden. Returns undefined to leave
 * Transform.pixelCache unchanged.
 *
 * @param {object} opts  from Transform._kernelOpts()
 * @returns {number|undefined}
 */
function autoPixelCacheSlots(opts){
    return (opts && opts.pixelCache === 'auto') ? 1 : undefined;
}

module.exports = {
    ensureOutputArray: ensureOutputArray,
    bindArrayRuns: bindArrayRuns,
    resolveThreshold: resolveThreshold,
    resolveArrayRuns: resolveArrayRuns,
    autoPixelCacheSlots: autoPixelCacheSlots,
};
