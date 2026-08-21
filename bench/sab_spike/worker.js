/** Spike worker: one kernel, two delivery models. Not production code. */
'use strict';
const { parentPort, workerData } = require('worker_threads');
const { Transform, eIntent } = require('../../src/main.js');

const BITS = workerData.bits || 8;
const Arr  = BITS === 8 ? Uint8ClampedArray : Uint16Array;
const t = new Transform({dataFormat: 'int' + BITS, buildLut: false});
t.create(workerData.from, workerData.to, eIntent.relative);
// Force the lazy table build before any timing starts.
t.transformArray(new Arr(30), false, false, false, 10);

const sharedIn  = workerData.sabIn  ? new Arr(workerData.sabIn)  : null;
const sharedOut = workerData.sabOut ? new Arr(workerData.sabOut) : null;

parentPort.on('message', (msg) => {
    if(msg.type === 'shared'){
        // SAB: views onto the caller's memory. No copy in, no copy out, and
        // nothing to transfer — the reply is an acknowledgement, not data.
        const inView  = sharedIn.subarray(msg.start * 3, (msg.start + msg.length) * 3);
        const outView = sharedOut.subarray(msg.start * 3, (msg.start + msg.length) * 3);
        t.transformArray(inView, false, false, false, msg.length, undefined, outView);
        parentPort.postMessage({type: 'done', id: msg.id});
        return;
    }
    if(msg.type === 'transfer'){
        // Today's model: the fragment arrived as its own buffer and goes home
        // the same way.
        const inArr  = new Arr(msg.buffer, 0, msg.length * 3);
        const outArr = new Arr(msg.out,    0, msg.length * 3);
        t.transformArray(inArr, false, false, false, msg.length, undefined, outArr);
        parentPort.postMessage({type: 'done', id: msg.id, buffer: msg.buffer, out: msg.out},
                               [msg.buffer, msg.out]);
        return;
    }
});
