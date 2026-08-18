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
 * Node `worker_threads` entry point. Nothing here is imported by the main
 * bundle; it is loaded by filename when the pool spins up, so the browser
 * build never sees it.
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

var workerThreads = require('worker_threads');
var parentPort = workerThreads.parentPort;
var Transform = require('./Transform.js');

// signature -> ready Transform. Small by construction: one entry per distinct
// LUT the caller actually uses.
var registry = Object.create(null);
var registryOrder = [];
var MAX_LUTS = 8;

function register(signature, lut, lutMode){
    if(registry[signature]) return;

    // setLut with the cloned object, NOT fromJSON with serialised text -- the
    // portable format quantises and would cost 1 LSB on some pixels.
    var t = new Transform({dataFormat: 'int8', lutMode: lutMode, buildLut: true});
    t.setLut(lut);
    registry[signature] = t;
    registryOrder.push(signature);

    // Bounded, so a long-lived pool cannot accumulate LUTs without limit.
    while(registryOrder.length > MAX_LUTS){
        var evict = registryOrder.shift();
        if(evict !== signature) delete registry[evict];
    }
}

parentPort.on('message', function(msg){

    if(msg.type === 'exit'){
        process.exit(0);
        return;
    }

    if(msg.type === 'lut'){
        try {
            register(msg.signature, msg.lut, msg.lutMode);
            parentPort.postMessage({type: 'lutOk', signature: msg.signature});
        } catch(e){
            parentPort.postMessage({type: 'error', signature: msg.signature, message: String(e && e.message || e)});
        }
        return;
    }

    if(msg.type !== 'run') return;

    try {
        var transform = registry[msg.signature];
        if(!transform){
            // The pool ships the LUT before any task referencing it, so this
            // means a protocol bug rather than a race — fail loudly.
            parentPort.postMessage({type: 'error', id: msg.id,
                message: 'poolWorker: unknown LUT signature ' + msg.signature});
            return;
        }

        // The buffer arrived by transfer; this worker owns it outright.
        var input = new Uint8ClampedArray(msg.buffer);

        var t0 = process.hrtime.bigint();
        var out = transform.transformArray(input, msg.inputHasAlpha, msg.outputHasAlpha,
                                           msg.preserveAlpha, msg.pixelCount);
        var computeMs = Number(process.hrtime.bigint() - t0) / 1e6;

        // transformArray may hand back a view whose buffer is larger than the
        // data; transfer needs an exact buffer.
        var outBuffer;
        if(out.byteOffset === 0 && out.byteLength === out.buffer.byteLength){
            outBuffer = out.buffer;
        } else {
            var exact = new Uint8ClampedArray(out.length);
            exact.set(out);
            outBuffer = exact.buffer;
        }

        parentPort.postMessage({
            type: 'done',
            id: msg.id,
            buffer: outBuffer,
            pixelCount: msg.pixelCount,
            computeMs: computeMs
        }, [outBuffer]);

    } catch(e){
        parentPort.postMessage({type: 'error', id: msg.id,
            message: String(e && e.message || e), stack: e && e.stack});
    }
});

parentPort.postMessage({type: 'ready'});
