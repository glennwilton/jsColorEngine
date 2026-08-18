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
 * pool.js — worker pool for the multicore image path.
 *
 * Design and every constant here is measured; the reasoning lives in
 * docs/deepdive/multicore.md. The short version, because it is easy to
 * "simplify" this into something 30-48% slower:
 *
 * ONE MACHINE, ONE POOL. The pool is a process-level singleton keyed by
 *   (workers, lutMode). Threads do not become more parallel by being owned by
 *   different objects, they just contend — ten Transforms with their own pools
 *   would be eighty workers for one CPU. Each caller holds a LEASE.
 *
 * OVER-DECOMPOSE, NEVER ONE SLICE PER WORKER. A LUT transform is not
 *   fixed-cost per pixel: content moves throughput ~2.7x, because how much of
 *   the CLUT the pixels touch decides cache behaviour. So equal-sized slices
 *   take unequal time and an even split leaves workers idle behind the slowest
 *   one — measured 30-48% off on uniform hardware, and 2.6x off when cores are
 *   uneven (P/E, big.LITTLE). ~10 tasks per worker, pulled from a queue, fixes
 *   it without anyone having to predict which regions are expensive.
 *
 * THE BUFFER IS A CEILING, NOT A QUANTUM. Slice length comes from the image
 *   and the pool, then clamps to capacity. A small image must still spread
 *   across every worker, so cutting only at capacity boundaries is wrong.
 *
 * NOTHING HOLDS THE PROCESS OPEN. Workers and the idle timer are unref'd, so a
 *   caller who never releases gets "workers die at exit" rather than "process
 *   hangs forever" — which is measurably what happens otherwise.
 */
'use strict';

var path = require('path');

// ---- measured defaults -------------------------------------------------
// Changing these without re-running bench/multicore_poc/ is how a 30% loss
// gets shipped. Each is justified in docs/deepdive/multicore.md.
var DEFAULTS = {
    cores: 'auto',            // ~50% of logical = physical count on SMT parts
    minThreads: 2,            // one worker is slower than none once copies count
    maxThreads: 16,           // scaling flattens: 5.38x at 12, 5.46x at 16
    tasksPerWorker: 10,       // jitter needs 8-12; content variance only 2-4
    bufferPx: 262144,         // flat region; 16 workers ~28MB, not ~190MB
    minSlicePx: 16384,        // keeps ~7us per-task overhead under ~1%
    parallelFloorPx: 65536,   // below this, splitting stops paying at all
    idleTimeoutMs: 30000,     // 0 or Infinity = never expire
    keepAlive: true
};

function idealWorkers(cores){
    var logical = 4;
    try {
        var os = require('os');
        logical = (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 4;
    } catch(e){ /* non-node host: fall through to the default */ }

    if(cores === 'max') return logical;
    if(cores === 'auto' || cores === undefined || cores === null){
        // availableParallelism() reports LOGICAL threads (16 on an 8-core
        // 7700X). Two workers on one physical core share execution units and
        // do not add throughput proportionally, so half lands on the count
        // that actually parallelises.
        return Math.max(1, Math.floor(logical * 0.5));
    }
    return Math.max(1, cores | 0);
}

/**
 * Slice length for one image.
 *
 * Three terms, and which one binds moves with image size:
 *   capacity  binds on large images  (20MP -> 256K px slices, 80 tasks)
 *   the pool  binds in the middle    (2MP  -> 26K px slices, 80 tasks)
 *   the floor binds on small ones    (500K -> 16K px slices, 31 tasks)
 */
function sliceLengthFor(pixelCount, workers, opts){
    var wanted = Math.ceil(pixelCount / (workers * opts.tasksPerWorker));
    var len = Math.min(opts.bufferPx, Math.max(opts.minSlicePx, wanted));
    return Math.max(64, Math.ceil(len / 64) * 64);      // 64-px aligned
}

/**
 * Plan a batch into tasks. Pure and synchronous — no I/O, no async, trivially
 * testable, and the only place the split/whole distinction exists. A whole
 * image is simply a task with start = 0.
 */
function planBatch(images, workers, opts){
    var tasks = [];
    for(var i = 0; i < images.length; i++){
        var px = images[i].pixelCount;
        var per = sliceLengthFor(px, workers, opts);
        for(var start = 0; start < px; start += per){
            tasks.push({
                imageIndex: i,
                start: start,
                length: Math.min(per, px - start)
            });
        }
    }
    // Longest-processing-time-first. Within one image every slice is the same
    // length so this contributes nothing; across a batch of differently-sized
    // images it does real work, keeping a long task off the end of the run.
    tasks.sort(function(a, b){ return b.length - a.length; });
    return tasks;
}

// ---- the singleton -----------------------------------------------------

var pools = Object.create(null);        // key -> Pool

function Pool(workers, lutMode, opts){
    this.workers = workers;
    this.lutMode = lutMode;
    this.opts = opts;
    this.leases = 0;
    this.idleTimer = null;
    this.free = [];
    this.all = [];
    this.lutsPerWorker = [];            // Set of signatures shipped to worker i
    this.starting = null;
    this.busy = false;
}

Pool.prototype.start = function(){
    if(this.starting) return this.starting;
    var self = this;

    this.starting = new Promise(function(resolve, reject){
        var workerThreads;
        try {
            workerThreads = require('worker_threads');
        } catch(e){
            return reject(new Error('worker_threads unavailable'));
        }

        var file = path.join(__dirname, 'poolWorker.js');
        var pending = self.workers;
        var failed = false;

        for(var i = 0; i < self.workers; i++){
            (function(index){
                var w;
                try {
                    w = new workerThreads.Worker(file);
                } catch(e){
                    if(!failed){ failed = true; reject(e); }
                    return;
                }
                // An unref'd worker does not hold the event loop open, so a
                // caller who never releases gets a clean exit instead of a
                // hang. Re-ref'd while tasks are in flight.
                if(w.unref) w.unref();

                w.once('message', function(m){
                    if(m && m.type === 'ready'){
                        self.all[index] = w;
                        self.lutsPerWorker[index] = Object.create(null);
                        self.free.push(index);
                        if(--pending === 0 && !failed) resolve(self);
                    }
                });
                w.once('error', function(e){
                    if(!failed){ failed = true; reject(e); }
                });
            })(i);
        }
    });

    return this.starting;
};

Pool.prototype._refAll = function(on){
    for(var i = 0; i < this.all.length; i++){
        var w = this.all[i];
        if(!w) continue;
        if(on && w.ref) w.ref(); else if(!on && w.unref) w.unref();
    }
};

Pool.prototype.armIdleTimer = function(){
    var self = this;
    var ms = this.opts.idleTimeoutMs;
    this.clearIdleTimer();
    if(!this.opts.keepAlive){ this.destroy(); return; }
    if(!ms || ms === Infinity || !isFinite(ms)) return;      // 0 = never expire

    // Armed on drain rather than polled: a periodic wake-up is wasted work on
    // a laptop and defeats low-power states, and the queue already knows when
    // it empties.
    this.idleTimer = setTimeout(function(){ self.destroy(); }, ms);
    // The timer is itself an event-loop handle — measured holding a process
    // open 1215ms past the end of the work. Unref it or the leak has only
    // moved from the workers to the timer.
    if(this.idleTimer && this.idleTimer.unref) this.idleTimer.unref();
};

Pool.prototype.clearIdleTimer = function(){
    if(this.idleTimer){ clearTimeout(this.idleTimer); this.idleTimer = null; }
};

/** Ship a LUT to a worker once, keyed by content signature. */
Pool.prototype._ensureLut = function(index, signature, lut){
    var self = this;
    if(this.lutsPerWorker[index][signature]) return Promise.resolve();

    return new Promise(function(resolve, reject){
        var w = self.all[index];
        var onMsg = function(m){
            if(!m) return;
            if(m.type === 'lutOk' && m.signature === signature){
                w.off('message', onMsg);
                self.lutsPerWorker[index][signature] = true;
                resolve();
            } else if(m.type === 'error' && m.signature === signature){
                w.off('message', onMsg);
                reject(new Error(m.message));
            }
        };
        w.on('message', onMsg);
        w.postMessage({type: 'lut', signature: signature, lut: lut, lutMode: self.lutMode});
    });
};

/**
 * Run a planned batch. Workers pull the next task as they free up, which is
 * what absorbs content variance, core asymmetry, thread migration and SMT
 * contention without having to detect any of them.
 */
Pool.prototype.run = function(tasks, images, outputs, signature, lut, flags){
    var self = this;
    this.clearIdleTimer();
    this._refAll(true);
    this.busy = true;

    return new Promise(function(resolve, reject){
        if(!tasks.length){ self.busy = false; return resolve({workersUsed: self.all.length}); }

        var next = 0, done = 0, failedWith = null;
        var inCh = images[0].inChannels, outCh = images[0].outChannels;

        function finish(){
            self.busy = false;
            self._refAll(false);
            self.armIdleTimer();
            if(failedWith) reject(failedWith); else resolve({workersUsed: self.all.length});
        }

        function feed(index){
            if(failedWith) return;
            if(next >= tasks.length) return;
            var task = tasks[next++];
            var image = images[task.imageIndex];
            var w = self.all[index];

            self._ensureLut(index, signature, lut).then(function(){
                var bytes = task.length * image.inChannels;
                var slice = new Uint8ClampedArray(bytes);
                slice.set(image.data.subarray(task.start * image.inChannels,
                                              task.start * image.inChannels + bytes));
                w.postMessage({
                    type: 'run',
                    id: tasks.indexOf(task),
                    signature: signature,
                    buffer: slice.buffer,
                    pixelCount: task.length,
                    inputHasAlpha: flags.inputHasAlpha,
                    outputHasAlpha: flags.outputHasAlpha,
                    preserveAlpha: flags.preserveAlpha
                }, [slice.buffer]);
            }).catch(function(e){ failedWith = e; if(done === 0) finish(); });
        }

        self.all.forEach(function(w, index){
            w.removeAllListeners('message');
            w.removeAllListeners('error');
            w.on('message', function(msg){
                if(!msg) return;
                if(msg.type === 'error'){
                    failedWith = new Error(msg.message);
                    if(++done >= tasks.length) finish();
                    return;
                }
                if(msg.type !== 'done') return;

                var task = tasks[msg.id];
                var image = images[task.imageIndex];
                var chunk = new Uint8ClampedArray(msg.buffer);
                // Order does not matter: every task carries its destination.
                outputs[task.imageIndex].set(
                    chunk.subarray(0, task.length * image.outChannels),
                    task.start * image.outChannels);

                if(++done === tasks.length) finish();
                else feed(index);
            });
            w.on('error', function(e){ failedWith = e; finish(); });
        });

        for(var i = 0; i < self.all.length; i++) feed(i);
    });
};

Pool.prototype.destroy = function(){
    this.clearIdleTimer();
    for(var i = 0; i < this.all.length; i++){
        var w = this.all[i];
        if(!w) continue;
        try { w.postMessage({type: 'exit'}); } catch(e){ /* already gone */ }
        try { w.terminate(); } catch(e){ /* already gone */ }
    }
    this.all = [];
    this.free = [];
    this.lutsPerWorker = [];
    this.starting = null;
    delete pools[this.key];
};

// ---- public surface ----------------------------------------------------

function poolKey(workers, lutMode){ return workers + '|' + lutMode; }

function acquire(lutMode, options){
    var opts = {};
    for(var k in DEFAULTS) opts[k] = DEFAULTS[k];
    for(var j in (options || {})) if(options[j] !== undefined) opts[j] = options[j];

    var workers = Math.min(opts.maxThreads, idealWorkers(opts.cores));
    if(workers < opts.minThreads) return null;              // not worth a pool

    var key = poolKey(workers, lutMode);
    var pool = pools[key];
    if(!pool){
        pool = new Pool(workers, lutMode, opts);
        pool.key = key;
        pools[key] = pool;
    }
    pool.leases++;
    return pool;
}

function release(pool){
    if(!pool) return;
    pool.leases = Math.max(0, pool.leases - 1);
    // Dropping a lease must not strand another Transform mid-batch, so the
    // pool only goes away on the last lease — or later, on idle timeout.
    if(pool.leases === 0 && !pool.busy && !pool.opts.keepAlive) pool.destroy();
}

function destroyAll(){
    for(var k in pools) pools[k].destroy();
}

module.exports = {
    DEFAULTS: DEFAULTS,
    idealWorkers: idealWorkers,
    sliceLengthFor: sliceLengthFor,
    planBatch: planBatch,
    acquire: acquire,
    release: release,
    destroyAll: destroyAll,
    _pools: pools
};
