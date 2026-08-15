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

/**
 * Try to compile/instantiate the tetrahedral WASM kernels for the
 * transform's current lutMode, demoting transform.lutMode on any failure
 * (simd → scalar → JS int / int16). Mutates transform.lutMode and the
 * transform.wasmTetra* state slots. Soft-fail-loud-log: warning in verbose
 * mode, silent otherwise.
 *
 * @param {Transform} transform
 * @returns {string} the settled transform.lutMode
 */
function settleWasmStates(transform){
    // WASM KERNEL INIT (lutMode begins with 'int-wasm-'): try to
    // compile and instantiate the tetrahedral WASM kernel(s) once,
    // at create() time. On any failure (no WebAssembly global, SIMD
    // unsupported by host, module bytes missing, instantiate throws)
    // demote lutMode to the next-best mode (simd → scalar → int) so
    // the best available kernel runs instead. The dispatcher
    // then sees the demoted lutMode and skips inapplicable WASM
    // routing on every call — zero per-call overhead from the
    // demotion.
    //
    // For 'int-wasm-simd' we try to load BOTH the SIMD module
    // (for 3D cMax ∈ {3, 4}) and the scalar module (for everything
    // else the SIMD kernel doesn't cover — currently just 3D with
    // cMax ∉ {3, 4}). If the SIMD module compile fails but the
    // scalar compile succeeds, we demote to 'int-wasm-scalar'.
    if(transform.lutMode === 'int-wasm-simd'){
        var simdState = wasmLoader.createTetra3DSimdState({ wasmCache: transform.wasmCache });
        if(simdState !== null){
            transform.wasmTetra3DSimd = simdState;
            // Also load scalar as a fallthrough step for cMax ∉ {3,4}.
            // Scalar compile rarely fails when SIMD compile succeeds
            // (SIMD is a strict superset of scalar capability in V8),
            // but we still check — on failure we leave wasmTetra3D
            // null and let the dispatcher fall through to 'int' JS
            // for those off-path cases.
            var scalarState = wasmLoader.createTetra3DState({ wasmCache: transform.wasmCache });
            if(scalarState !== null){
                transform.wasmTetra3D = scalarState;
            }
            if(transform.verbose){
                console.log('  lutMode=int-wasm-simd: WebAssembly SIMD kernel loaded'
                    + (scalarState !== null ? ' (+ scalar fallthrough)' : ' (scalar fallthrough unavailable)'));
            }
        } else {
            if(transform.verbose){
                console.warn('  lutMode=int-wasm-simd: WebAssembly SIMD unavailable — demoting to "int-wasm-scalar"');
            }
            transform.lutMode = 'int-wasm-scalar';
        }
    }

    if(transform.lutMode === 'int-wasm-scalar'){
        var wasmState = wasmLoader.createTetra3DState({ wasmCache: transform.wasmCache });
        if(wasmState !== null){
            transform.wasmTetra3D = wasmState;
            if(transform.verbose){
                console.log('  lutMode=int-wasm-scalar: WebAssembly kernel loaded');
            }
        } else {
            if(transform.verbose){
                console.warn('  lutMode=int-wasm-scalar: WebAssembly unavailable — demoting to "int"');
            }
            transform.lutMode = 'int';
        }
    }

    // INT16 WASM SIMD (v1.3 — u16 I/O SIMD, 3D + 4D). Sibling of
    // 'int-wasm-simd' for u16 image workloads. The SIMD 3D u16
    // module determines lutMode demotion: if it fails to compile
    // (host lacks WebAssembly SIMD) we demote to 'int16-wasm-scalar'
    // and the block below picks up the scalar u16 modules instead.
    // On success we ALSO load the scalar u16 3D module as a
    // fallthrough for cMax ∉ {3, 4} cases the SIMD kernel doesn't
    // cover (mirrors the u8 SIMD-block fallthrough convention),
    // plus the SIMD u16 4D module (best-effort) and the scalar u16
    // 4D module (fallthrough).
    if(transform.lutMode === 'int16-wasm-simd'){
        var simd3DInt16State = wasmLoader.createTetra3DInt16SimdState({ wasmCache: transform.wasmCache });
        if(simd3DInt16State !== null){
            transform.wasmTetra3DInt16Simd = simd3DInt16State;
            var scalar3DInt16State = wasmLoader.createTetra3DInt16State({ wasmCache: transform.wasmCache });
            if(scalar3DInt16State !== null){
                transform.wasmTetra3DInt16 = scalar3DInt16State;
            }
            var simd4DInt16State = wasmLoader.createTetra4DInt16SimdState({ wasmCache: transform.wasmCache });
            if(simd4DInt16State !== null){
                transform.wasmTetra4DInt16Simd = simd4DInt16State;
            }
            var scalar4DInt16State = wasmLoader.createTetra4DInt16State({ wasmCache: transform.wasmCache });
            if(scalar4DInt16State !== null){
                transform.wasmTetra4DInt16 = scalar4DInt16State;
            }
            if(transform.verbose){
                console.log('  lutMode=int16-wasm-simd: WebAssembly SIMD u16 kernels loaded'
                    + ' (3D SIMD' + (scalar3DInt16State !== null ? ' + scalar fallthrough' : ' only')
                    + ', 4D ' + (simd4DInt16State !== null ? 'SIMD' : 'no SIMD')
                    + (scalar4DInt16State !== null ? ' + scalar fallthrough' : '')
                    + ')');
            }
        } else {
            if(transform.verbose){
                console.warn('  lutMode=int16-wasm-simd: WebAssembly SIMD unavailable — demoting to "int16-wasm-scalar"');
            }
            transform.lutMode = 'int16-wasm-scalar';
        }
    }

    // INT16 WASM SCALAR (v1.3 — u16 I/O scalar, 3D + 4D). Sibling of
    // 'int-wasm-scalar' for u16 image workloads. The 3D module
    // determines lutMode demotion: if it fails to instantiate
    // we drop to JS 'int16'. The 4D module is best-effort and
    // mirrors the u8 4D-load policy (no demotion on 4D failure;
    // 4D inputs fall through to the JS 'int16' kernel).
    if(transform.lutMode === 'int16-wasm-scalar'){
        var wasmInt16State = wasmLoader.createTetra3DInt16State({ wasmCache: transform.wasmCache });
        if(wasmInt16State !== null){
            transform.wasmTetra3DInt16 = wasmInt16State;
            if(transform.verbose){
                console.log('  lutMode=int16-wasm-scalar: WebAssembly 3D int16 kernel loaded');
            }
            var wasm4DInt16State = wasmLoader.createTetra4DInt16State({ wasmCache: transform.wasmCache });
            if(wasm4DInt16State !== null){
                transform.wasmTetra4DInt16 = wasm4DInt16State;
                if(transform.verbose){
                    console.log('  lutMode=int16-wasm-scalar: WebAssembly 4D int16 kernel loaded');
                }
            } else if(transform.verbose){
                console.warn('  lutMode=int16-wasm-scalar: WebAssembly 4D int16 kernel unavailable — 4D u16 inputs will use JS int16 fallback');
            }
        } else {
            if(transform.verbose){
                console.warn('  lutMode=int16-wasm-scalar: WebAssembly unavailable — demoting to "int16"');
            }
            transform.lutMode = 'int16';
        }
    }

    // 4D WASM (CMYK input). Loaded alongside 3D any time lutMode is
    // still 'int-wasm-*' after the 3D blocks above ran. If the 3D
    // path just demoted to 'int' we don't try 4D either — there's
    // no meaningful scenario where the 4D module would instantiate
    // on a host where the 3D one didn't.
    //
    // For 'int-wasm-simd' we also load the 4D SIMD kernel for
    // cMax ∈ {3, 4} (which covers CMYK → RGB and CMYK → CMYK, i.e.
    // every real-world 4D pipeline). The scalar 4D state stays
    // loaded as a fallthrough for other cMax values.
    //
    // On 4D-load failure we DON'T demote lutMode — 3D can still run
    // through WASM; 4D just falls through to the JS 'int' kernel on
    // the dispatcher side. Soft degradation, matches pre-4D-WASM
    // behaviour exactly.
    if(transform.lutMode === 'int-wasm-simd'){
        var wasm4DSimdState = wasmLoader.createTetra4DSimdState({ wasmCache: transform.wasmCache });
        if(wasm4DSimdState !== null){
            transform.wasmTetra4DSimd = wasm4DSimdState;
            if(transform.verbose){
                console.log('  lutMode=int-wasm-simd: WebAssembly 4D SIMD kernel loaded');
            }
        } else if(transform.verbose){
            console.warn('  lutMode=int-wasm-simd: WebAssembly 4D SIMD kernel unavailable — 4D inputs will use scalar 4D WASM or JS int fallback');
        }
    }

    if(transform.lutMode === 'int-wasm-scalar' || transform.lutMode === 'int-wasm-simd'){
        var wasm4DState = wasmLoader.createTetra4DState({ wasmCache: transform.wasmCache });
        if(wasm4DState !== null){
            transform.wasmTetra4D = wasm4DState;
            if(transform.verbose){
                console.log('  lutMode=' + transform.lutMode + ': WebAssembly 4D scalar kernel loaded');
            }
        } else if(transform.verbose){
            console.warn('  lutMode=' + transform.lutMode + ': WebAssembly 4D scalar kernel unavailable — 4D inputs will use JS int fallback');
        }
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
    transform.wasmTetra3D          = null;
    transform.wasmTetra3DSimd      = null;
    transform.wasmTetra3DInt16     = null;
    transform.wasmTetra3DInt16Simd = null;
    transform.wasmTetra4D          = null;
    transform.wasmTetra4DSimd      = null;
    transform.wasmTetra4DInt16     = null;
    transform.wasmTetra4DInt16Simd = null;
}

module.exports = {
    settleWasmStates: settleWasmStates,
    releaseWasmStates: releaseWasmStates,
};
