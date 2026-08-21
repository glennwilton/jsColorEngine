// src/kernels/wasmLifecycle.js
//
// WASM kernel lifecycle — settle (load + demote) and release — MOVED VERBATIM
// from Transform.createMultiStage() (v1.7 phase B), with `this.` renamed to
// `transform.`. Called via kernel.create(lutMode) / kernel.release().
//
// NOTE ON SHAPE: this deliberately keeps the v1.5 behaviour of loading BOTH
// the 3D and 4D module families on every create(), whatever the transform's
// input dimension — lutMode demotion is keyed on the 3D module compile
// result (it answers "does this host support WASM/SIMD"), and the WASM test
// suites assert the full state loadout. Splitting the load per-dimension is
// a possible later optimisation, not part of the verbatim move.
'use strict';

var wasmLoader = require('../wasm/wasm_loader.js');

// The eight module states a kernel can hold. Named once so the walkers below
// cannot drift apart from each other.
var SLOTS = ['wasmTetra3D', 'wasmTetra3DSimd', 'wasmTetra3DInt16', 'wasmTetra3DInt16Simd',
             'wasmTetra4D', 'wasmTetra4DSimd', 'wasmTetra4DInt16', 'wasmTetra4DInt16Simd'];

/** Where a WASM lutMode lands when no WASM module can serve this kernel. */
var NO_WASM = {
    'int-wasm-simd': 'int',      'int-wasm-scalar': 'int',
    'int16-wasm-simd': 'int16',  'int16-wasm-scalar': 'int16',
};

/**
 * Load this kernel's WASM modules, demoting lutMode to what the host can run.
 *
 * ONE KERNEL, ONE DIMENSION'S MODULES (v1.6 phase 7). Until now every create()
 * loaded BOTH families whatever the input width, so a CMYK conversion compiled
 * and instantiated four 3-D modules it could never reach, and a gray
 * conversion compiled all eight. The dispatch switches confirm they were never
 * needed: kernel3D_table.js names no wasmTetra4D* slot, and kernel4D_table.js
 * names no wasmTetra3D* slot.
 *
 * THE LADDER IS THE KERNEL'S, DECLARED IN ITS OWN FILE as `wasmLadder` and
 * HANDED IN by its create(). This module only walks what it is given. Open Kernel3D.js and you can see every module it can
 * load and the order it gives up in, next to the dispatch switch that decides
 * which one runs -- the same reason the 42-row dispatch table moved out of
 * here in phase 4d.
 *
 * Each rung names the module whose failure DEMOTES lutMode, and optionally one
 * loaded best-effort for the shapes the lead does not cover (the SIMD kernels
 * handle 3 and 4 output channels; anything wider needs the scalar module).
 * Failing to load that one is not a demotion -- the dispatch switch picks a
 * lower rung for those shapes by itself.
 *
 * A KERNEL WITH NO LADDER demotes straight to the JS mode. That is a behaviour
 * change and an honest one: 1-D, 2-D and N-D have no WASM kernels, so a gray
 * transform reporting lutMode 'int-wasm-simd' was reporting something that
 * could not happen. It used to, because the 3-D module loaded on its behalf
 * and nothing checked whether it was reachable.
 *
 * EXPLICIT ARGUMENTS, NOT A MAGIC PROPERTY NAME. The caller says which
 * transform's lutMode may be demoted, which kernel the module states land on,
 * and which ladder to walk. Reaching into `kernel.wasmLadder` from in here
 * would have made the contract invisible at the call site and impossible to
 * override for a wrapper kernel that wants a different set.
 *
 * @param {Transform} transform  its lutMode is demoted in place
 * @param {object}    kernel     the module states are written onto this
 * @param {object}    [ladder]   this kernel's rungs; omit for none
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
        var state = wasmLoader[rung.load]({ wasmCache: transform.wasmCache });

        if(state === null){
            if(transform.verbose){
                console.warn('  lutMode=' + transform.lutMode + ': ' + rung.load
                    + ' unavailable - demoting to "' + rung.demoteTo + '"');
            }
            transform.lutMode = rung.demoteTo;
            continue;
        }

        kernel[rung.slot] = state;

        var extra = null;
        if(rung.alsoLoad){
            extra = wasmLoader[rung.alsoLoad]({ wasmCache: transform.wasmCache });
            if(extra !== null) kernel[rung.alsoSlot] = extra;
        }

        if(transform.verbose){
            console.log('  lutMode=' + transform.lutMode + ': ' + rung.load + ' loaded'
                + (rung.alsoLoad ? (extra !== null ? ' (+ scalar fallthrough)' : ' (scalar fallthrough unavailable)') : ''));
        }
        return transform.lutMode;
    }

    return transform.lutMode;
}

/**
 * Null out every WASM state slot, releasing linear memory to GC. The
 * caller (Transform.releaseWasmMemory / kernel.release) decides whether
 * to re-resolve dispatch afterwards.
 *
 * @param {Transform} transform
 */
function releaseWasmStates(transform){
    for(var i = 0; i < SLOTS.length; i++) transform[SLOTS[i]] = null;
}

/**
 * Compact this kernel's WASM memory if the caller's policy asks for it.
 *
 * Runs after every batch that used a WASM variant. The thresholds are the
 * Transform's — setWasmMaxMemory() / setWasmShrinkRatio() are public API and a
 * per-Transform decision — but the module states are the kernel's, so the walk
 * lives here rather than in Transform reaching back through eight forwarding
 * accessors that bounce straight to the kernel anyway.
 *
 * Cheap when disabled, which is the default: two compares and a return.
 *
 * @param {object} holder       kernel instance or Transform — anything holding the slots
 * @param {number} maxMemory    bytes, <= 0 to disable
 * @param {number} shrinkRatio  <= 0 to disable
 */
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
