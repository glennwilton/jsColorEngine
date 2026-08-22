// src/wasm/instantiate.js
//
// The only compile / instantiate path. Tetra factories and the matrix-shaper
// both come through here. A kernel asks "can this binary run on this host?"
// and either gets an Instance or null. null IS the probe — compile throws on
// a host without SIMD, and that is how we find out.
//
// Module is expensive (~5 ms first time) and stateless: cached in the caller's
// wasmCache bag, or in a process bag if none is passed. Instance is cheap and
// per-Transform — linear memory is not shared.
//
// This file must not require any kernel .wasm.js. Those stay next to the
// kernel that owns them; pulling them in here would load every binary into
// every consumer (the matrix shaper does not want eight tetrahedral modules).
'use strict';

var processCache = {};

function hasWebAssembly(){
    return typeof WebAssembly !== 'undefined'
        && typeof WebAssembly.Module === 'function'
        && typeof WebAssembly.Instance === 'function';
}

function cacheOf(opts){
    return (opts && opts.cache) || processCache;
}

/**
 * Compile bytes to a WebAssembly.Module. Cached. null if the host cannot.
 *
 * @param {Uint8Array} bytes
 * @param {{cache?: object, cacheKey?: string}} [opts]
 * @returns {WebAssembly.Module|null}
 */
function compile(bytes, opts){
    if(!hasWebAssembly() || !bytes) return null;
    var cache = cacheOf(opts);
    var key = opts && opts.cacheKey;
    if(key && cache[key]) return cache[key];
    var mod;
    try { mod = new WebAssembly.Module(bytes); }
    catch(e){ return null; }
    if(key) cache[key] = mod;
    return mod;
}

/**
 * Compile (cached) and instantiate. Returns null if the host cannot run
 * this binary, or if the named export / memory is missing.
 *
 * @param {Uint8Array} bytes
 * @param {{cache?: object, cacheKey?: string, exportName?: string, imports?: object}} [opts]
 * @returns {{exports: object, module: WebAssembly.Module, instance: WebAssembly.Instance, kernel: Function|null}|null}
 */
function instantiate(bytes, opts){
    var mod = compile(bytes, opts);
    if(!mod) return null;
    var instance;
    try { instance = new WebAssembly.Instance(mod, (opts && opts.imports) || {}); }
    catch(e){ return null; }
    var exports = instance.exports;
    if(!exports || !exports.memory) return null;
    var name = opts && opts.exportName;
    if(name && typeof exports[name] !== 'function') return null;
    return { exports: exports, module: mod, instance: instance, kernel: name ? exports[name] : null };
}

module.exports = {
    hasWebAssembly: hasWebAssembly,
    compile: compile,
    instantiate: instantiate,
};
