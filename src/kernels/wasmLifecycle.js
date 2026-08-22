// src/kernels/wasmLifecycle.js
//
// Walk one kernel's wasmLadder, demote lutMode, release / compact the
// named slots. Does not know about 3-D vs 4-D — the kernel hands in the
// factories it wants. A kernel with no ladder demotes straight to JS.
//
// alsoLoad (scalar fallthrough for SIMD) is on demand: SIMD only covers
// cMax ∈ {3, 4}. Wide output instantiates the extra module; RGB→RGB does not.
'use strict';

var wasmLoader = require('../wasm/wasm_loader.js');

var SLOTS = ['wasmTetra3D', 'wasmTetra3DSimd', 'wasmTetra3DInt16', 'wasmTetra3DInt16Simd',
             'wasmTetra4D', 'wasmTetra4DSimd', 'wasmTetra4DInt16', 'wasmTetra4DInt16Simd',
             'wasmTetra5D', 'wasmTetra6D'];

var NO_WASM = {
    'int-wasm-simd': 'int',      'int-wasm-scalar': 'int',
    'int16-wasm-simd': 'int16',  'int16-wasm-scalar': 'int16',
};

function wantInKernelCache(transform){
    var hint = transform.pixelCache;
    return hint !== 0 && hint !== false && hint !== '0';
}

function applyInKernelCache(transform, state){
    if(!state || typeof state.setPixelCache !== 'function') return false;
    return state.setPixelCache(wantInKernelCache(transform));
}

function loadFactory(fn, transform){
    if(typeof fn === 'function') return fn({ wasmCache: transform.wasmCache });
    if(typeof fn === 'string' && wasmLoader[fn]) return wasmLoader[fn]({ wasmCache: transform.wasmCache });
    return null;
}

/** SIMD kernels cannot serve output widths other than 3 or 4. */
function needsScalarFallthrough(transform){
    var n = transform.outputChannels;
    return n !== 3 && n !== 4;
}

/**
 * Load this kernel's WASM, demoting lutMode to what the host can run.
 *
 * @param {Transform} transform
 * @param {object}    kernel
 * @param {object}    [ladder]
 * @returns {string} the settled transform.lutMode
 */
function settleWasmStates(transform, kernel, ladder){

    if(!ladder){
        var landed = NO_WASM[transform.lutMode];
        if(landed){
            if(transform.verbose){
                console.log('  lutMode=' + transform.lutMode + ': no WebAssembly kernels exist for '
                    + (kernel.name || 'this kernel') + ' - using "' + landed + '"');
            }
            transform.lutMode = landed;
        }
        return transform.lutMode;
    }

    while(ladder[transform.lutMode]){
        var rung = ladder[transform.lutMode];
        var state = loadFactory(rung.load, transform);

        if(state === null){
            if(transform.verbose){
                var loadName = (typeof rung.load === 'function' && rung.load.name) || rung.load;
                console.warn('  lutMode=' + transform.lutMode + ': ' + loadName
                    + ' unavailable - demoting to "' + rung.demoteTo + '"');
            }
            transform.lutMode = rung.demoteTo;
            continue;
        }

        kernel[rung.slot] = state;

        var extra = null;
        if(rung.alsoLoad && needsScalarFallthrough(transform)){
            extra = loadFactory(rung.alsoLoad, transform);
            if(extra !== null) kernel[rung.alsoSlot] = extra;
        }

        // Same hint as the accuracy-path cache. 0 stays on the verbatim
        // export; 'auto' / 1 / N swap in interp_*_cached when that export
        // exists. Missing export is a silent decline — not a create() fail.
        var cached = applyInKernelCache(transform, state);
        if(extra) cached = applyInKernelCache(transform, extra) || cached;
        if(cached) kernel.inKernelCache = 1;

        if(transform.verbose){
            var leadName = (typeof rung.load === 'function' && rung.load.name) || rung.load;
            console.log('  lutMode=' + transform.lutMode + ': ' + leadName + ' loaded'
                + (extra ? ' (+ scalar fallthrough)' : '')
                + (cached ? ' (pixel cache)' : ''));
        }
        return transform.lutMode;
    }

    return transform.lutMode;
}

function releaseWasmStates(transform){
    for(var i = 0; i < SLOTS.length; i++) transform[SLOTS[i]] = null;
}

function compactIfNeeded(holder, maxMemory, shrinkRatio){
    if(maxMemory <= 0 && shrinkRatio <= 0) return;
    for(var i = 0; i < SLOTS.length; i++){
        var state = holder[SLOTS[i]];
        if(state) state.compactIfNeeded();
    }
}

module.exports = {
    settleWasmStates: settleWasmStates,
    releaseWasmStates: releaseWasmStates,
    compactIfNeeded: compactIfNeeded,
    SLOTS: SLOTS,
};
