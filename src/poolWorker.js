/*************************************************************************
 *  @license
 *
 *  Copyright © 2019, 2026 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 */

/**
 * poolWorker.js — the worker end of the multicore image path.
 *
 * Worker entry for the multicore image path.
 *
 * Node loads this file via `worker_threads`. The browser build bundles it
 * (plus the engine) as `browser/jsColorEngineWorker.js` and the app passes
 * that URL to `Transform.enablePool({workerUrl})`. Same protocol either way.
 *
 * PROTOCOL
 * --------
 *   { type:'lut', signature, lut, lutMode }       register a LUT, reply 'lutOk'
 *   { type:'run', id, signature, buffer, ... }    convert a slice, reply 'done'
 *   { type:'exit' }                               terminate
 *
 * LUTs are registered by their FNV-1a content signature and cached, so a
 * shared pool can serve many Transforms and each LUT crosses the wire once per
 * worker rather than once per task. The LUT alone is enough to rebuild a ready
 * Transform — no profiles, no ICC parsing, no pipeline build — which is what
 * makes a shared pool practical.
 *
 * THE LUT IS SENT AS A STRUCTURED CLONE, NOT AS JSON. `toJSON()`/`fromJSON()`
 * is a *portable* format and quantises: a sequential-vs-sequential comparison
 * through it differs on 123 of 200,000 bytes by 1 LSB. Sending the LUT object
 * itself keeps the typed arrays exact, so parallel output is byte-identical to
 * single-threaded rather than merely close — which is the property the tests
 * assert and the only one worth having.
 */
'use strict';

var parentPort, Transform, Profile, nowMs, workerExit;

function isBrowserWorker(){
    return (typeof WorkerGlobalScope !== 'undefined')
        && (typeof self !== 'undefined')
        && (self instanceof WorkerGlobalScope);
}

if(isBrowserWorker()){
    parentPort = {
        on: function(type, fn){
            self.addEventListener(type, function(ev){ fn(ev.data); });
        },
        postMessage: function(msg, xfer){
            self.postMessage(msg, xfer || []);
        }
    };
    Transform = require('./Transform.js');
    Profile   = require('./Profile.js');
    nowMs = function(){ return performance.now(); };
    workerExit = function(){ self.close(); };
} else {
    var workerThreads = require('worker_threads');
    parentPort = workerThreads.parentPort;
    Transform = require('./Transform.js');
    Profile   = require('./Profile.js');
    nowMs = function(){ return Number(process.hrtime.bigint()) / 1e6; };
    workerExit = function(){ process.exit(0); };
}

// signature -> ready Transform. One entry per distinct transform the caller
// actually uses, which is what lets ONE pool serve MANY Transforms: every
// message carries its signature, and the worker looks up the matching
// Transform rather than assuming it only ever has one.
//
// Bounded, so a long-lived pool cannot accumulate transforms without limit,
// and evicted LEAST-RECENTLY-USED rather than first-in: a set of transforms in
// active rotation would otherwise evict each other in turn and re-ship on
// every batch.
//
// Eviction is REPORTED BACK to the pool. The pool keeps its own per-worker
// record of what it has shipped, and if the two disagree it will dispatch a
// task for a signature this worker has dropped — which fails. Whoever evicts
// has to say so.
var registry = Object.create(null);
var registryOrder = [];
var MAX_LUTS = 8;                       // pool.transformsPerWorker overrides

/**
 * Bytes this worker is holding for one transform.
 *
 * The f64 CLUT and its u16 twin both stay resident on the int path, so the
 * honest figure is their sum. Excludes WASM linear memory, which holds a THIRD
 * copy of the u16 table on the wasm kernels — see docs/deepdive/multicore.md.
 */
function residentBytes(t){
    var n = 0;
    if(t && t.lut){
        if(t.lut.CLUT) n += t.lut.CLUT.byteLength;
        if(t.lut.intLut && t.lut.intLut.CLUT) n += t.lut.intLut.CLUT.byteLength;
    }
    return n;
}

function touch(signature){
    var i = registryOrder.indexOf(signature);
    if(i >= 0) registryOrder.splice(i, 1);
    registryOrder.push(signature);
}

function admit(signature, transform){
    registry[signature] = transform;
    touch(signature);

    var evicted = [];
    while(registryOrder.length > MAX_LUTS){
        var victim = registryOrder.shift();
        if(victim === signature) continue;
        delete registry[victim];
        evicted.push(victim);
    }
    return evicted;
}

function register(signature, lut, lutMode){
    if(registry[signature]){ touch(signature); return []; }

    // setLut with the cloned object, NOT fromJSON with serialised text -- the
    // portable format quantises and would cost 1 LSB on some pixels.
    var t = new Transform({dataFormat: 'int8', lutMode: lutMode, buildLut: true});
    t.setLut(lut);
    return admit(signature, t);
}

/**
 * MODE 2 — rebuild from the chain rather than from a LUT.
 *
 * Used where a LUT cannot serve: the LUT-free accuracy path (there is no LUT
 * to send) and N-channel output (a LUT-only rebuild diverges). The chain
 * arrives as cloned Profile objects and intents; structured clone drops
 * prototypes, so each profile has to be re-attached before `createMultiStage`
 * will accept it.
 *
 * Deterministic by construction: the worker runs the same create() on the same
 * profiles and gets the same Transform, so unlike Mode 1 there is nothing to
 * probe.
 */
function registerChain(signature, chain, options){
    if(registry[signature]){ touch(signature); return []; }

    var rebuilt = chain.map(function(slot, i){
        if(i % 2) return slot;                       // intent, a plain number
        if(typeof slot === 'string') return slot;    // virtual profile: '*sRGB'
        // A cloned Profile is plain data until its prototype is restored.
        return Object.setPrototypeOf(slot, Profile.prototype);
    });

    var t = new Transform(options);
    t.createMultiStage(rebuilt);
    return admit(signature, t);
}

parentPort.on('message', function(msg){

    // The pool owns this bound; it rides along on registration rather than
    // being fixed at spawn so it stays one number in one place (DEFAULTS).
    if(msg && msg.maxTransforms > 0) MAX_LUTS = msg.maxTransforms;

    if(msg.type === 'exit'){
        workerExit();
        return;
    }

    // Drop one transform on request. LRU eviction already bounds the registry,
    // but it only reclaims memory when something ELSE needs the slot — so an
    // app holding the pool open (idleTimeoutMs: 0) would keep a finished
    // transform's LUT resident in every worker until eight more pushed it out.
    // This is the caller saying "done with that one" and getting the memory
    // back now.
    if(msg.type === 'forget'){
        var at = registryOrder.indexOf(msg.signature);
        if(at >= 0) registryOrder.splice(at, 1);
        delete registry[msg.signature];
        parentPort.postMessage({type: 'forgot', signature: msg.signature});
        return;
    }

    // What did this worker ACTUALLY build? Compared against the master's
    // getInfo() so a rebuild that diverged shows up as a named field rather
    // than as subtly wrong pixels.
    if(msg.type === 'info'){
        var known = registry[msg.signature];
        parentPort.postMessage({
            type: 'info',
            signature: msg.signature,
            info: known ? known.getInfo() : null
        });
        return;
    }

    if(msg.type === 'chain'){
        try {
            var evictedChain = registerChain(msg.signature, msg.chain, msg.options);
            parentPort.postMessage({type: 'lutOk', signature: msg.signature,
                                    evicted: evictedChain,
                                    bytes: residentBytes(registry[msg.signature])});
        } catch(e){
            parentPort.postMessage({type: 'error', signature: msg.signature,
                message: String(e && e.message || e)});
        }
        return;
    }

    if(msg.type === 'lut'){
        try {
            var evictedLut = register(msg.signature, msg.lut, msg.lutMode);
            parentPort.postMessage({type: 'lutOk', signature: msg.signature,
                                    evicted: evictedLut,
                                    bytes: residentBytes(registry[msg.signature])});
        } catch(e){
            parentPort.postMessage({type: 'error', signature: msg.signature, message: String(e && e.message || e)});
        }
        return;
    }

    if(msg.type !== 'run') return;

    try {
        var transform = registry[msg.signature];
        if(transform) touch(msg.signature);
        if(!transform){
            // Distinct from a generic error so the pool can RECOVER rather
            // than fail the batch: it clears its record for this worker,
            // re-registers and re-sends the one task. Should not happen —
            // evictions are reported back so both sides stay in step — but a
            // task that never completes hangs the batch, which is too
            // expensive a way to find out we were wrong.
            parentPort.postMessage({type: 'unknownSignature', id: msg.id,
                                    signature: msg.signature});
            return;
        }

        // BOTH BUFFERS ARE THE POOL'S REUSED SCRATCH, on loan by transfer.
        // They go back on the reply, so the next fragment on this worker
        // allocates nothing. Allocating here instead would put the allocator
        // back in the hot path, which is what this design exists to avoid.
        var inLen = (msg.byteLength !== undefined) ? msg.byteLength : msg.buffer.byteLength;
        var input = new Uint8ClampedArray(msg.buffer, 0, inLen);

        var outBuffer = msg.outBuffer;
        var target = null;
        if(outBuffer && msg.outByteLength !== undefined &&
           outBuffer.byteLength >= msg.outByteLength){
            // Exact-length view: transformArray checks the length it is given.
            target = new Uint8ClampedArray(outBuffer, 0, msg.outByteLength);
        }

        var t0 = nowMs();
        var out = transform.transformArray(input, msg.inputHasAlpha, msg.outputHasAlpha,
                                           msg.preserveAlpha, msg.pixelCount,
                                           undefined, target || undefined);
        var computeMs = nowMs() - t0;

        // If the transform did not write into the supplied array — no array was
        // usable, or a kernel returned its own — copy into the scratch anyway,
        // so the pool always gets a buffer back in the shape it expects.
        if(!target || out !== target){
            if(!outBuffer || outBuffer.byteLength < out.length){
                outBuffer = new ArrayBuffer(out.length);
            }
            new Uint8ClampedArray(outBuffer, 0, out.length).set(out);
        }

        var transfers = [outBuffer];
        if(msg.buffer) transfers.push(msg.buffer);

        parentPort.postMessage({
            type: 'done',
            id: msg.id,
            buffer: outBuffer,
            inBuffer: msg.buffer,          // handed back for reuse
            pixelCount: msg.pixelCount,
            computeMs: computeMs
        }, transfers);

    } catch(e){
        parentPort.postMessage({type: 'error', id: msg.id,
            message: String(e && e.message || e), stack: e && e.stack});
    }
});

parentPort.postMessage({type: 'ready'});
