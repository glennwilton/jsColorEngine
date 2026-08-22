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
 * ONE MACHINE, ONE POOL. The pool is a process-level singleton keyed by worker
 *   count alone. Threads do not become more parallel by being owned by
 *   different objects, they just contend — ten Transforms with their own pools
 *   would be eighty workers for one CPU. Each caller holds a LEASE.
 *
 *   Nothing else may enter that key. `lutMode` used to, which quietly doubled
 *   the worker count on any process mixing a LUT transform (int) with a
 *   LUT-free one (float) — 16 workers for 8 cores, the exact failure the
 *   singleton exists to prevent. It travels on the registration message
 *   instead, where it belongs: the worker registry is keyed by signature, so
 *   each transform carries its own mode and one pool serves both.
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

var path = null;
try { path = require('path'); } catch(e){ /* browser bundle — path is unused there */ }
var settings = require('./settings.js');

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
    keepAlive: true,
    // How many DIFFERENT TRANSFORMS each worker keeps ready, evicted
    // least-recently-used. Not a thread count: raising it does not add
    // parallelism, it trades memory for not re-shipping a transform that comes
    // back around. Cost is per worker, so the pool holds
    // (workers x transforms x LUT size) — and a 33-point CMYK LUT is ~1.4 MB
    // (f64 table plus its u16 twin), so 8 workers x 8 transforms is ~92 MB.
    // Raise it for an app cycling through a fixed set of profiles; leave it
    // alone otherwise.
    transformsPerWorker: 8,
    // Log registrations, evictions and teardown to the console. Off by
    // default; the numbers are also available without it via
    // pool.memoryReport() / pool.memorySummary().
    debug: false
};

function logicalCores(){
    try {
        var os = require('os');
        if(os && (os.availableParallelism || os.cpus)){
            return (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 4;
        }
    } catch(e){ /* browser bundle, or os stubbed */ }
    try {
        if(typeof navigator !== 'undefined' && navigator.hardwareConcurrency){
            return navigator.hardwareConcurrency;
        }
    } catch(e){ /* no navigator */ }
    return 4;
}

function idealWorkers(cores){
    var logical = logicalCores();

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

function Pool(workers, opts){
    this.workers = workers;
    this.opts = opts;
    this.leases = 0;
    this.idleTimer = null;
    this.free = [];
    this.all = [];
    this.lutsPerWorker = [];            // Set of signatures shipped to worker i
    this.payloadBytes = Object.create(null);   // signature -> bytes ONE worker holds
    this.cancelledIds = Object.create(null);   // image id -> true, for the live batch
    this.inFlight = 0;                  // fragments with a worker right now
    // Per-worker tallies, for asking whether the OS actually spread the
    // workers across distinct cores — see workerStats().
    // SCRATCH BUFFERS, ONE PAIR PER WORKER, REUSED FOR THE WHOLE BATCH.
    // Allocating a fragment in and a fragment out per task meant ~160
    // allocations of up to 256K px for one 4 MPx batch, and that allocator
    // churn is where the run-to-run variance lived: worker compute varied 6%
    // while the orchestration around it varied 53%. Transfer DETACHES, so
    // reuse only works if the worker hands both buffers back, which it does.
    this.scratchIn = [];
    this.scratchOut = [];
    this.workerTasks = [];
    this.workerPixels = [];
    this.workerComputeMs = [];
    this.destroyed = false;             // set by destroy(); batches must check
    this._chain = Promise.resolve();    // batches run one at a time; see run()
    this.starting = null;
    this.busy = false;
}

Pool.prototype.start = function(){
    if(this.starting) return this.starting;
    var self = this;

    this.starting = new Promise(function(resolve, reject){
        var backend = resolveBackend(self.opts);
        if(!backend){
            return reject(new Error(unavailableReason()));
        }
        self.host = backend.host;

        var pending = self.workers;
        var failed = false;

        for(var i = 0; i < self.workers; i++){
            (function(index){
                var w;
                try {
                    w = backend.spawn();
                } catch(e){
                    if(!failed){ failed = true; reject(e); }
                    return;
                }
                // An unref'd worker does not hold the event loop open, so a
                // caller who never releases gets a clean exit instead of a
                // hang. Re-ref'd while tasks are in flight. Browser workers
                // have no ref/unref — the wrapper no-ops them.
                if(w.unref) w.unref();

                // A DEAD WORKER RETIRES THE POOL. Eviction, forget and idle
                // teardown all clear the pool's record of what a worker holds;
                // a death does not — `all[index]` would keep pointing at a
                // corpse and `lutsPerWorker[index]` would keep claiming
                // registrations it no longer has, so every later batch posts
                // into the void and waits forever. Retiring sends the next
                // acquire to a fresh pool, where every Transform re-registers
                // itself: the same recovery path as an idle timeout.
                //
                // Attached HERE, not per batch — `_runBatch` re-installs
                // 'message' and 'error' each time but not 'exit', so a
                // per-batch handler would accumulate one listener per batch.
                // Death is a pool-lifetime concern, so it belongs at spawn.
                w.on('exit', function(code){
                    if(code !== 0 && pools[self.key] === self) self.destroy();
                });

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

/**
 * Ship a transform to a worker once, keyed by content signature.
 *
 * ONE POOL SERVES MANY TRANSFORMS. `lutsPerWorker[i]` is this side's record of
 * which signatures worker i already holds, so a second Transform sharing the
 * pool ships its own payload once and thereafter costs nothing — and
 * interleaved batches across several Transforms never re-ship.
 *
 * The worker's registry is bounded, so it can evict. It reports what it
 * dropped on the `lutOk` reply and that record is cleared here; without that
 * the two sides drift and a later task references a signature the worker no
 * longer has.
 */
Pool.prototype._ensureLut = function(index, signature, payload){
    var self = this;
    if(this.lutsPerWorker[index][signature]) return Promise.resolve();

    return new Promise(function(resolve, reject){
        var w = self.all[index];
        var onMsg = function(m){
            if(!m) return;
            if(m.type === 'lutOk' && m.signature === signature){
                w.off('message', onMsg);
                if(m.evicted){
                    for(var e = 0; e < m.evicted.length; e++){
                        delete self.lutsPerWorker[index][m.evicted[e]];
                        if(self.opts.debug){
                            console.log('jsColorEngine pool: worker ' + index +
                                ' evicted ' + m.evicted[e]);
                        }
                    }
                }
                self.lutsPerWorker[index][signature] = true;
                // Reported by the worker rather than guessed here, because in
                // chain mode the worker decides whether a LUT gets built at all.
                if(m.bytes !== undefined) self.payloadBytes[signature] = m.bytes;
                if(self.opts.debug){
                    console.log('jsColorEngine pool: shipped ' + signature +
                        ' (' + payload.mode + ') to worker ' + index +
                        ', ' + ((m.bytes || 0) / 1048576).toFixed(2) + ' MB');
                }
                resolve();
            } else if(m.type === 'error' && m.signature === signature){
                w.off('message', onMsg);
                reject(new Error(m.message));
            }
        };
        w.on('message', onMsg);
        // payload.mode picks the hand-off: 'lut' ships the baked table,
        // 'chain' ships cloned profiles for the worker to create() from.
        if(payload.mode === 'chain'){
            w.postMessage({type: 'chain', signature: signature,
                           chain: payload.chain, options: payload.options,
                           maxTransforms: self.opts.transformsPerWorker});
        } else {
            w.postMessage({type: 'lut', signature: signature,
                           lut: payload.lut, lutMode: payload.lutMode,
                           maxTransforms: self.opts.transformsPerWorker});
        }
    });
};

/**
 * Ask every worker to describe what it built for `signature`.
 *
 * Registers first where a worker has not seen this transform yet, so the
 * answer describes the same thing a real batch would use rather than whatever
 * happened to be resident. Queued behind any running batch for the same reason
 * run() is: it re-installs message handlers.
 *
 * @returns {Promise<Object[]>} one getInfo() per worker, in worker order
 */
Pool.prototype.workerInfo = function(signature, payload){
    var self = this;

    // Same reasoning as forget(): safe to run during an interrupt, and
    // deadlocks if queued behind the batch the interrupt has paused.
    if(isPaused()) return run();

    var queued = this._chain.then(run, run);
    this._chain = queued.catch(function(){});
    return queued;

    function run(){
        // Workers spawn lazily, so a pool that has never run a batch has none
        // yet — and reporting "zero workers, nothing disagreed" would be the
        // most misleading possible answer to "are the workers in sync?".
        return self.start().then(collect);
    }

    function collect(){
        return Promise.all(self.all.map(function(w, index){
            return self._ensureLut(index, signature, payload).then(function(){
                return new Promise(function(resolve, reject){
                    var onMsg = function(m){
                        if(!m || m.type !== 'info' || m.signature !== signature) return;
                        w.off('message', onMsg);
                        resolve(m.info);
                    };
                    w.on('message', onMsg);
                    w.postMessage({type: 'info', signature: signature});
                });
            });
        }));
    }
};

/**
 * Drop one transform from every worker in this pool.
 *
 * Safe to call for a signature no worker holds — that is the common case, and
 * it is a no-op rather than an error. Queued like any other batch so it cannot
 * land mid-conversion.
 *
 * @returns {Promise<number>} how many workers were asked
 */
Pool.prototype.forget = function(signature){
    var self = this;

    // INSIDE AN INTERRUPT, RUN NOW RATHER THAN QUEUE. Queueing behind the
    // paused batch deadlocks: the batch cannot finish until the interrupt
    // releases, the interrupt cannot release until its callback resolves, and
    // the callback is awaiting this. Running immediately is safe precisely
    // because interrupt() drains first — no fragment is with a worker, which
    // is the only thing the queueing was protecting against.
    if(isPaused()) return Promise.resolve(drop());

    var queued = this._chain.then(drop, drop);
    this._chain = queued.catch(function(){});
    return queued;

    function drop(){
        self.all.forEach(function(w, index){
            if(self.lutsPerWorker[index]) delete self.lutsPerWorker[index][signature];
            if(w) w.postMessage({type: 'forget', signature: signature});
        });
        return self.all.length;
    }
};

/**
 * Run a planned batch, one batch at a time.
 *
 * BATCHES ARE SERIALISED, deliberately. `_runBatch` re-installs the message
 * handlers on every worker when it starts, so two batches in flight at once
 * would have the second tear off the first's handlers and the first would wait
 * for replies that no longer land anywhere — a hang, not a wrong answer, but a
 * hang is still a bug.
 *
 * Serialising costs nothing: both batches want the same N workers on the same
 * N cores, so running them together cannot finish the pair any sooner. It only
 * changes who waits where. Two Transforms sharing this pool can therefore each
 * call transformImages() whenever they like, concurrently, without
 * coordinating — which is the point of a shared pool.
 *
 * The chain absorbs rejection (`.catch`) so one failed batch does not wedge
 * every batch queued behind it.
 */
Pool.prototype.run = function(tasks, images, makeOutputs, signature, payload, flags, onImage, ids){
    var self = this;

    // GENERATION IS CAPTURED HERE, AT SUBMISSION — not when the batch starts.
    // Batches are serialised, so a batch queued behind another one starts
    // AFTER any cancelAll() that lands in the meantime; capturing at start
    // would read the new generation and conclude it was never cancelled.
    // Measured: the queued batch ran to completion after cancelAll().
    //
    // This is also why cancelAll() cannot just mark every id cancelled and let
    // the loop drain: the pool has not seen a queued batch's ids yet.
    var submittedGeneration = cancelGeneration;

    var args = [tasks, images, makeOutputs, signature, payload, flags, onImage, ids,
                submittedGeneration];
    var queued = this._chain.then(function(){
        return self._runBatch.apply(self, args);
    }, function(){
        return self._runBatch.apply(self, args);
    });
    this._chain = queued.catch(function(){ /* keep the queue moving */ });

    return queued;
};

/**
 * Convert one planned batch. Workers pull the next task as they free up, which
 * is what absorbs content variance, core asymmetry, thread migration and SMT
 * contention without having to detect any of them.
 */
Pool.prototype._runBatch = function(tasks, images, makeOutputs, signature, payload, flags, onImage, ids, submittedGeneration){
    var self = this;

    // A BATCH MUST NOT START WHILE AN INTERRUPT IS HELD. Starting means
    // re-installing every worker's message handler with removeAllListeners(),
    // which would tear off listeners that forgetWorkers()/getWorkerInfo() had
    // just attached — those run immediately during a pause rather than queueing
    // behind this batch, and their replies would then land on nothing. Parking
    // only the FRAGMENT dispatch was not enough; startup has to wait too.
    if(isPaused()){
        var args = arguments;
        return whenResumed().then(function(){
            return self._runBatch.apply(self, args);
        });
    }

    this.clearIdleTimer();
    this._refAll(true);
    this.busy = true;

    // OUTPUT BUFFERS ARE ALLOCATED HERE, NOT AT SUBMISSION. Batches run one at
    // a time, so allocating when the batch was queued meant every outstanding
    // batch held a full set of output buffers while waiting its turn — a
    // caller submitting faster than the pool drains grew memory without bound.
    // Measured: 40 queued batches of one 4 MPx image peaked at 668 MB of
    // external memory, against 65 MB for the same work allocated per batch.
    //
    // Only OUR allocation can be deferred. The caller's input buffers are the
    // caller's, and they hold them either way.
    var outputs = makeOutputs();

    return new Promise(function(resolve, reject){
        if(!tasks.length){ self.busy = false; return resolve({outputs: outputs, workersUsed: self.all.length}); }

        var next = 0, done = 0, failedWith = null;
        // No batch-wide channel counts: every read below goes through the
        // image's own `inChannels` / `outChannels`, because alpha may differ
        // per image. (The two that used to live here were never read.)

        // AN IMAGE IS DONE WHEN ITS OWN TASKS ARE, which is a refcount and not
        // a position in the queue. Tasks are sorted longest-first and pulled by
        // whichever worker frees up, so an image's slices finish out of order
        // and interleaved with other images' — counting is the only thing that
        // survives that. (It is also what will survive priority insertion and
        // regrouping if the queue is ever shared across batches.)
        // Largest fragment this batch can ask for, so scratch is sized once
        // rather than grown task by task.
        var maxInBytes = 0, maxOutBytes = 0;
        for(var mt = 0; mt < tasks.length; mt++){
            var mi = images[tasks[mt].imageIndex];
            var bi = tasks[mt].length * mi.inChannels;
            var bo = tasks[mt].length * mi.outChannels;
            if(bi > maxInBytes) maxInBytes = bi;
            if(bo > maxOutBytes) maxOutBytes = bo;
        }

        var outstanding = new Array(images.length);
        var computeMs   = new Array(images.length);
        var cancelled   = new Array(images.length);
        var fragments   = new Array(images.length);
        for(var im = 0; im < images.length; im++){
            outstanding[im] = 0; computeMs[im] = 0; cancelled[im] = false; fragments[im] = 0;
        }
        for(var tk = 0; tk < tasks.length; tk++){
            outstanding[tasks[tk].imageIndex] += 1;
            fragments[tasks[tk].imageIndex] += 1;
        }

        // The generation this batch was SUBMITTED in (see run()). cancelAll()
        // moves the counter, so everything submitted before the call is
        // cancelled — running or still queued — and anything submitted after
        // is not. No flag to reset, and a new export after a cancel just works.
        var myGeneration = (submittedGeneration === undefined)
            ? cancelGeneration : submittedGeneration;
        ids = ids || [];

        function isCancelled(imageIndex){
            if(cancelGeneration !== myGeneration) return true;
            return self.cancelledIds[ids[imageIndex]] === true;
        }

        // A cancelled image STILL ANNOUNCES. A caller awaiting one callback per
        // image would otherwise wait forever for work that will never run.
        function retire(imageIndex, wasCancelled){
            if(wasCancelled) cancelled[imageIndex] = true;
            if(!onImage) return;
            onImage(imageIndex,
                    wasCancelled ? null : outputs[imageIndex],
                    {computeMs: computeMs[imageIndex], cancelled: !!wasCancelled,
                     fragments: fragments[imageIndex]});
        }

        var finished = false;
        function finish(){
            // Idempotent: a worker dying, a destroy mid-batch and the last task
            // completing can all reach here, and resolving twice would hide
            // whichever arrived second.
            if(finished) return;
            finished = true;
            self.busy = false;
            self._refAll(false);
            // Per-id cancellations are scoped to the batch that owned them —
            // otherwise cancelling 'hero.tif' today would silently skip a
            // different 'hero.tif' next week.
            self.cancelledIds = Object.create(null);
            self.armIdleTimer();
            if(failedWith) reject(failedWith);
            else resolve({outputs: outputs, workersUsed: self.all.length,
                          cancelled: cancelled});
        }

        // Tasks already retried after a worker reported it did not hold the
        // transform. One retry each: a second miss means something worse than
        // a stale cache record, and looping would hide it.
        var retried = Object.create(null);

        function feed(index){
            // THE POOL CAN VANISH UNDER A RUNNING BATCH — destroyAll(), an idle
            // timeout with keepAlive off, or a worker dying all call destroy(),
            // which clears lutsPerWorker and terminates the workers. Replies
            // already queued still arrive afterwards, and following them into
            // cleared state threw. Settle the batch instead: transformImages
            // catches and falls back to sequential, so the caller still gets
            // correct pixels.
            if(self.destroyed){
                failedWith = failedWith || new Error('jsColorEngine: worker pool was destroyed mid-batch');
                finish();
                return;
            }
            if(failedWith) return;
            if(next >= tasks.length) return;
            // Paused: park this worker rather than giving it a fragment. It is
            // fed again from releasePause().
            if(isPaused()){ parkFeed(function(){ feed(index); }); return; }
            dispatch(index, next++);
        }

        function dispatch(index, taskId){
            var task = tasks[taskId];

            // Cancelled work is DROPPED, not sent. Tasks already with a worker
            // cannot be recalled, so a cancelled image may be partly converted
            // — which is why its buffer is reported as null rather than handed
            // back half-written.
            if(isCancelled(task.imageIndex)){
                if(--outstanding[task.imageIndex] === 0) retire(task.imageIndex, true);
                if(++done === tasks.length) finish();
                else feed(index);
                return;
            }

            var image = images[task.imageIndex];
            var w = self.all[index];

            self._ensureLut(index, signature, payload).then(function(){
                var bytes    = task.length * image.inChannels;
                var outBytes = task.length * image.outChannels;

                // Reuse this worker's scratch pair, growing only when a batch
                // needs more than last time. Steady state allocates nothing,
                // so GC has no reason to run until the batch is over.
                var inBuf = self.scratchIn[index];
                if(!inBuf || inBuf.byteLength < bytes){
                    inBuf = new ArrayBuffer(Math.max(bytes, maxInBytes));
                }
                var outBuf = self.scratchOut[index];
                if(!outBuf || outBuf.byteLength < outBytes){
                    outBuf = new ArrayBuffer(Math.max(outBytes, maxOutBytes));
                }
                // Transferred away; the worker owns them until it replies.
                self.scratchIn[index] = null;
                self.scratchOut[index] = null;

                var slice = new Uint8ClampedArray(inBuf, 0, bytes);
                slice.set(image.data.subarray(task.start * image.inChannels,
                                              task.start * image.inChannels + bytes));
                w.postMessage({
                    type: 'run',
                    id: taskId,
                    signature: signature,
                    buffer: inBuf,
                    outBuffer: outBuf,
                    byteLength: bytes,
                    outByteLength: outBytes,
                    pixelCount: task.length,
                    // THIS IMAGE's flags, not the batch's — resolved by the
                    // caller and carried on the descriptor, so a mixed batch
                    // of RGBA and RGB is one call.
                    inputHasAlpha:  image.flags ? image.flags.inputHasAlpha  : flags.inputHasAlpha,
                    outputHasAlpha: image.flags ? image.flags.outputHasAlpha : flags.outputHasAlpha,
                    preserveAlpha:  image.flags ? image.flags.preserveAlpha  : flags.preserveAlpha
                }, [inBuf, outBuf]);
                self.inFlight += 1;
            }).catch(function(e){ failedWith = e; if(done === 0) finish(); });
        }

        self.all.forEach(function(w, index){
            w.removeAllListeners('message');
            w.removeAllListeners('error');
            w.on('message', function(msg){
                if(!msg) return;
                if(self.destroyed){ finish(); return; }
                // THE WORKER SAYS IT DOES NOT HAVE THIS TRANSFORM.
                //
                // The pool keeps a record of what it shipped to each worker,
                // and eviction is reported back so the two stay in step — so
                // in principle this cannot happen. In principle is not a
                // recovery strategy: the cost of being wrong is a task that
                // never completes and a batch that hangs.
                //
                // Recovery is local and cheap, because the payload is right
                // here: clear this worker's record, re-register, re-send THIS
                // task. Not a pool rebuild, and not a stall for anyone else.
                //
                // (Asking another worker to pass its copy across would be
                // strictly worse — workers have no channel to each other, so
                // it would route through this thread, which already holds the
                // payload.)
                if(msg.type === 'unknownSignature' || msg.type === 'error' ||
                   msg.type === 'done'){
                    self.inFlight -= 1;
                    notifyIdle();
                }

                if(msg.type === 'unknownSignature'){
                    if(retried[msg.id]){
                        failedWith = new Error('poolWorker: worker ' + index +
                            ' still does not hold ' + msg.signature + ' after re-registering');
                        if(++done >= tasks.length) finish();
                        return;
                    }
                    retried[msg.id] = true;
                    if(self.lutsPerWorker[index]) delete self.lutsPerWorker[index][msg.signature];
                    dispatch(index, msg.id);
                    return;
                }

                if(msg.type === 'error'){
                    failedWith = new Error(msg.message);
                    if(++done >= tasks.length) finish();
                    return;
                }
                if(msg.type !== 'done') return;

                var task = tasks[msg.id];
                var image = images[task.imageIndex];

                // Both buffers come home, so the next fragment on this worker
                // allocates nothing.
                if(msg.inBuffer) self.scratchIn[index] = msg.inBuffer;
                if(msg.buffer)   self.scratchOut[index] = msg.buffer;

                var chunk = new Uint8ClampedArray(msg.buffer, 0,
                                                  task.length * image.outChannels);
                // Order does not matter: every task carries its destination.
                outputs[task.imageIndex].set(chunk, task.start * image.outChannels);

                // Summed worker time for this image's slices. Distinct from
                // wall time, and the more honest per-image figure: it is the
                // work actually done, unaffected by how long the image sat in
                // the queue or how many workers happened to be free.
                computeMs[task.imageIndex] += (msg.computeMs || 0);

                self.workerTasks[index]     = (self.workerTasks[index] || 0) + 1;
                self.workerPixels[index]    = (self.workerPixels[index] || 0) + task.length;
                self.workerComputeMs[index] = (self.workerComputeMs[index] || 0) + (msg.computeMs || 0);

                // Announce before the batch resolves, so a caller can start
                // writing this image out while the rest are still converting.
                if(--outstanding[task.imageIndex] === 0){
                    retire(task.imageIndex, cancelled[task.imageIndex]);
                }

                if(++done === tasks.length) finish();
                else feed(index);
            });
            // A worker that DIES is the one loss the cache bookkeeping cannot
            // repair on its own. Eviction, forget and idle-timeout teardown
            // all clear the pool's record of what that worker holds; a death
            // does not — `all[index]` keeps pointing at a corpse and
            // `lutsPerWorker[index]` keeps claiming registrations it no longer
            // has, so every later batch would post into the void and wait
            // forever. Retire the whole pool instead: the next acquire builds
            // a fresh one and every Transform re-registers, which is the same
            // recovery path as an idle timeout and is already proven.
            //
            // Rare by construction — the worker catches and reports JS throws,
            // so reaching here means OOM or a native crash.
            w.on('error', function(e){ failedWith = e; self.destroy(); finish(); });
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
    // Workers just died with fragments outstanding; those replies are never
    // coming. Leaving the count raised would hang every later interrupt().
    this.inFlight = 0;
    this.destroyed = true;
    delete pools[this.key];
    notifyIdle();
};

// ---- environment overrides ---------------------------------------------

/**
 * Deployment-time pool settings, read from the host.
 *
 * Set them as environment variables in Node, or on `globalThis` in a browser —
 * same names either way, `globalThis` wins. See src/settings.js.
 *
 * WHY ENV IS RIGHT HERE AND NOT FOR COLOUR BEHAVIOUR. Worker counts are a
 * property of the MACHINE rather than of the conversion. Nothing here can
 * change a pixel: every one of these settings only moves work between threads,
 * and the sequential path is always available and always correct.
 *
 * The motivating case is real. `cores: 'auto'` asks
 * `os.availableParallelism()`, which inside a cgroup-limited container
 * typically reports the HOST's core count rather than the quota — so a 2-CPU
 * container happily spawns 8 workers and thrashes. That is a deployment
 * problem, fixed at deployment, without a code change.
 *
 * PRECEDENCE: explicit options > environment > DEFAULTS. Code always wins, so
 * a caller who passes `{cores: 4}` gets 4 whatever the environment says — the
 * environment sets the default, it does not seize control.
 *
 *   JSCE_POOL_CORES                 'auto' | 'max' | a number
 *   JSCE_POOL_MIN_THREADS           below this, run sequentially instead
 *   JSCE_POOL_MAX_THREADS           ceiling regardless of cores
 *   JSCE_POOL_IDLE_MS               0 = never expire
 *   JSCE_POOL_TRANSFORMS_PER_WORKER LRU depth per worker
 *   JSCE_POOL_DISABLE               '1' to force the sequential path
 */
var ENV_KEYS = {
    JSCE_POOL_CORES:                 'cores',
    JSCE_POOL_MIN_THREADS:           'minThreads',
    JSCE_POOL_MAX_THREADS:           'maxThreads',
    JSCE_POOL_IDLE_MS:               'idleTimeoutMs',
    JSCE_POOL_TRANSFORMS_PER_WORKER: 'transformsPerWorker'
};

function envOverrides(){
    var out = {};
    for(var key in ENV_KEYS){
        var name = ENV_KEYS[key];
        var v;
        v = (name === 'cores')
            ? settings.readEnumOrNumber(key, ['auto', 'max'])
            : settings.readNumber(key);
        if(v !== undefined) out[name] = v;
    }
    return out;
}

/** True when the host asks for the sequential path outright. */
function envDisabled(){ return settings.readFlag('JSCE_POOL_DISABLE'); }

// ---- public surface ----------------------------------------------------

function poolKey(workers){ return String(workers); }

function acquire(options){
    if(envDisabled()) return null;              // sequential; always correct

    var opts = {};
    for(var k in DEFAULTS) opts[k] = DEFAULTS[k];
    var env = envOverrides();
    for(var e in env) opts[e] = env[e];
    for(var j in (options || {})) if(options[j] !== undefined) opts[j] = options[j];

    var workers = Math.min(opts.maxThreads, idealWorkers(opts.cores));
    if(workers < opts.minThreads) return null;              // not worth a pool

    var key = poolKey(workers);
    var pool = pools[key];
    if(!pool){
        pool = new Pool(workers, opts);
        pool.key = key;
        pools[key] = pool;
    }
    pool.leases++;
    return pool;
}

/**
 * Spin the pool up NOW, and say plainly whether it worked.
 *
 * WHY THIS EXISTS. Every other route into the pool falls back to sequential on
 * failure and says nothing — which is the right default, because multicore is
 * an optimisation and never a capability. But it leaves a caller who
 * DELIBERATELY wants parallelism with no way to discover they did not get it:
 * the batch completes, the bytes are correct, and it quietly ran on one thread.
 * This turns that into one catchable failure at a point the caller chose.
 *
 * Also warms the pool. Spawning workers costs tens of milliseconds, and doing
 * it inside the first timed batch is how a benchmark measures the wrong thing.
 *
 * @param {object} [options]  pool options, plus `workerUrl` for browsers
 * @returns {Promise<{workers:number, host:string}>} rejects with the reason
 */
function enable(options){
    options = options || {};

    if(!hasWorkerBackend(options)){
        return Promise.reject(new Error(unavailableReason()));
    }

    var pool = acquire(options);
    if(!pool){
        return Promise.reject(new Error(
            'jsColorEngine: pool declined to start. Either JSCE_POOL_DISABLE ' +
            'is set, or the resolved worker count is below minThreads ' +
            '(default 2) — one worker is measurably slower than none.'));
    }
    return pool.start()
        .then(function(){ return {workers: pool.workers, host: pool.host}; })
        .catch(function(e){ release(pool); throw e; });
}

/**
 * Why can the pool not run here? Phrased so the caller can act on it, and so
 * the browser case names the missing piece rather than shrugging.
 */
function unavailableReason(){
    if(hasWorkerThreads()){
        if(settings.readFlag('JSCE_POOL_DISABLE')){
            return 'JSCE_POOL_DISABLE is set.';
        }
        return 'the resolved worker count is below minThreads (default 2) — one ' +
               'worker is measurably slower than none, so the pool declined.';
    }
    if(typeof Worker !== 'function'){
        return 'No worker backend on this host. Under Node the pool needs ' +
               'worker_threads; in a browser it needs the Worker constructor.';
    }
    if(!resolveWorkerUrl()){
        return 'No worker URL. Call Transform.enablePool({workerUrl: ' +
               "'/path/to/jsColorEngineWorker.js'}) or set " +
               'globalThis.JSCE_WORKER_URL to the worker bundle.';
    }
    return 'Worker backend is available but the pool declined to start.';
}

/** Is a real worker_threads module reachable? The browser build stubs it. */
function hasWorkerThreads(){
    try {
        var wt = require('worker_threads');
        return !!(wt && typeof wt.Worker === 'function');
    } catch(e){ return false; }
}

function resolveWorkerUrl(options){
    if(options && options.workerUrl) return options.workerUrl;
    return settings.raw('JSCE_WORKER_URL');
}

function hasWorkerBackend(options){
    if(hasWorkerThreads()) return true;
    return !!(resolveWorkerUrl(options) && typeof Worker === 'function');
}

/**
 * Pick a spawn function. Node uses worker_threads and the source file next
 * to this module. A browser needs the worker *bundle* URL — a library cannot
 * know where the app put it, so the app says via workerUrl / JSCE_WORKER_URL.
 */
function resolveBackend(opts){
    if(hasWorkerThreads()){
        return {
            host: 'worker_threads',
            spawn: function(){
                var workerThreads = require('worker_threads');
                var file = path.join(__dirname, 'poolWorker.js');
                return new workerThreads.Worker(file);
            }
        };
    }
    var url = resolveWorkerUrl(opts);
    if(url && typeof Worker === 'function'){
        return {
            host: 'web_worker',
            spawn: function(){ return wrapBrowserWorker(new Worker(url)); }
        };
    }
    return null;
}

/**
 * Present a Web Worker as the Node worker_threads.Worker surface the rest
 * of this file already talks to: on/once/off, removeAllListeners, postMessage
 * with a transfer list, terminate. Event payloads are the data object, not
 * the MessageEvent. ref/unref are no-ops — browsers have no equivalent.
 */
function wrapBrowserWorker(w){
    var listeners = {message: [], error: [], exit: []};

    function emit(type, arg){
        var list = listeners[type].slice();
        for(var i = 0; i < list.length; i++){
            list[i].fn(arg);
        }
        listeners[type] = listeners[type].filter(function(x){ return !x.once; });
    }

    w.addEventListener('message', function(ev){ emit('message', ev.data); });
    w.addEventListener('error', function(ev){
        emit('error', ev.error || new Error(ev.message || 'worker error'));
    });

    function add(type, fn, once){
        if(!listeners[type]) listeners[type] = [];
        listeners[type].push({fn: fn, once: !!once});
        return api;
    }
    function remove(type, fn){
        if(!listeners[type]) return api;
        listeners[type] = listeners[type].filter(function(x){ return x.fn !== fn; });
        return api;
    }

    var api = {
        postMessage: function(msg, xfer){ w.postMessage(msg, xfer || []); },
        terminate: function(){ w.terminate(); },
        on: function(type, fn){ return add(type, fn, false); },
        once: function(type, fn){ return add(type, fn, true); },
        off: function(type, fn){ return remove(type, fn); },
        removeListener: function(type, fn){ return remove(type, fn); },
        removeAllListeners: function(type){
            if(type) listeners[type] = [];
            else { listeners.message = []; listeners.error = []; listeners.exit = []; }
            return api;
        },
        ref: function(){},
        unref: function(){}
    };
    return api;
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

/**
 * What is this pool actually holding, and what did it cost?
 *
 * THE NUMBER THAT MATTERS IS MULTIPLIED BY WORKER COUNT. In C, threads share
 * one address space and a LUT is one copy however many threads read it. In JS
 * every worker gets its own structured clone, so the same table is resident
 * N times — a 33-point CMYK LUT is ~1.4 MB (f64 plus its u16 twin), which is
 * ~11.5 MB across eight workers for ONE transform. That asymmetry is the main
 * cost of multicore here and it is invisible without asking, hence this.
 *
 * `bytes` is what the caller reported when registering, so it covers the LUT
 * and not the worker's own heap, WASM linear memory, or in-flight slices. It
 * is a floor, not a total.
 *
 * @returns {Object} per-pool and aggregate figures, safe to JSON.stringify
 */
function memoryReport(){
    var report = {pools: [], workers: 0, transforms: 0, residentBytes: 0};

    Object.keys(pools).forEach(function(key){
        var pool = pools[key];
        var distinct = Object.create(null);
        var residencies = 0;
        var residentBytes = 0;
        var workersHolding = 0;

        for(var i = 0; i < pool.lutsPerWorker.length; i++){
            var held = pool.lutsPerWorker[i];
            if(!held) continue;
            var sigs = Object.keys(held);
            if(sigs.length) workersHolding += 1;
            for(var k = 0; k < sigs.length; k++){
                var bytes = pool.payloadBytes[sigs[k]] || 0;
                distinct[sigs[k]] = bytes;
                residencies   += 1;
                residentBytes += bytes;       // once per WORKER holding it
            }
        }

        // What a single worker would hold if it held every resident transform.
        var names = Object.keys(distinct);
        var bytesPerWorkerSet = 0;
        for(var d = 0; d < names.length; d++) bytesPerWorkerSet += distinct[names[d]];

        report.pools.push({
            key:                 key,
            workers:             pool.all.length,
            workersHolding:      workersHolding,
            leases:              pool.leases,
            busy:                pool.busy,
            transformsResident:  names.length,
            residencies:         residencies,        // transform x worker pairs
            bytesPerWorkerSet:   bytesPerWorkerSet,
            residentBytes:       residentBytes,      // the number that matters
            transformsPerWorker: pool.opts.transformsPerWorker,
            idleTimeoutMs:       pool.opts.idleTimeoutMs
        });

        report.workers       += pool.all.length;
        report.transforms    += names.length;
        report.residentBytes += residentBytes;
    });

    return report;
}

/** memoryReport() as a line per pool, for a console.log during development. */
function memorySummary(){
    var r = memoryReport();
    if(!r.pools.length) return 'jsColorEngine pool: none running';

    var mb = function(b){ return (b / 1048576).toFixed(1) + ' MB'; };
    var out = r.pools.map(function(p){
        // workersHolding can be BELOW the worker count and that is not a bug:
        // over-decomposition feeds workers from a queue, so a small batch may
        // never reach the last few, and a worker is only shipped a transform
        // when it is handed a task using it.
        return 'pool ' + p.key + ': ' + p.workers + ' workers (' +
               p.workersHolding + ' holding), ' +
               p.transformsResident + ' transform(s), ' +
               p.residencies + ' copies, ' + mb(p.residentBytes) + ' resident' +
               ' — ' + mb(p.bytesPerWorkerSet) + ' per worker that holds them all';
    });
    out.push('total: ' + r.workers + ' workers, ' + mb(r.residentBytes) +
             ' resident in worker LUTs');
    return out.join('\n');
}

/**
 * CANCELLATION.
 *
 * Two kinds, and both have to answer the same awkward question: what happens
 * to a caller waiting on the per-image callback for work that will now never
 * run? If cancelled images simply went quiet, a handler awaiting one result
 * per image would wait forever. So **a cancelled image still fires its
 * callback**, with `data: null` and `info.cancelled: true`. Nothing is left
 * hanging; the caller is told, and can clean up.
 *
 * `cancelAll()` uses a GENERATION COUNTER rather than a flag, which removes
 * the need for a resume() nobody would remember to call. Every batch records
 * the generation it was created in; a batch is cancelled if the generation has
 * moved since. So one call stops everything queued or running, and a batch
 * submitted afterwards is unaffected — which is what "the user pressed Cancel,
 * then started a new export" needs.
 *
 * `cancel(id)` is per image, scoped to the batches currently in flight, and
 * cleared when the batch that owned it finishes — otherwise cancelling
 * 'hero.tif' today would silently skip a different 'hero.tif' next week.
 *
 * TASKS ALREADY DISPATCHED CANNOT BE RECALLED. A worker mid-fragment finishes
 * it. So a cancelled image may be partially converted, and its output buffer is
 * therefore reported as `null` rather than handed back half-written.
 */
var cancelGeneration = 0;

/**
 * BACKPRESSURE.
 *
 * A producer that submits faster than the pool drains is the one way left to
 * grow memory without bound. Output buffers are now allocated when a batch
 * starts rather than when it is queued, so the pool's own footprint is capped
 * at one batch — but the CALLER's input buffers are the caller's, and a loop
 * that reads ten thousand files and fires transformImages() at each one still
 * holds ten thousand of them.
 *
 * These let a producer pace itself against the consumer:
 *
 *     for (const file of thousands) {
 *         await pool.onQueueBelow(2);           // one running, one queued
 *         convert(file);                        // no await — keep the pool fed
 *     }
 *
 * `onQueueBelow(2)` rather than `onQueueFree()` in a loop, deliberately.
 * Waiting for empty means the workers sit idle between submissions, because
 * nothing is queued behind the batch that just finished — it converts a
 * pipeline into a stop-start. Keeping one batch queued costs one batch of
 * memory and keeps every worker fed.
 *
 * `onQueueFree()` is for "tell me when everything is done", not for pacing.
 */
var drainWaiters = [];

/**
 * PAUSE / INTERRUPT.
 *
 * `interrupt(fn)` rather than `pause()` + `resume()`, deliberately. A bare
 * pause deadlocks the pool if the caller throws before resuming, or simply
 * forgets — and the failure is silent: no error, just workers that never pick
 * anything up again. A scoped callback releases in a finally, so it cannot be
 * left held.
 *
 * IT DRAINS BEFORE RUNNING fn. Stopping dispatch is not the same as stopping
 * work: eight workers mid-fragment keep every core busy, which defeats the
 * point of asking for the CPU. So interrupt() stops handing out fragments and
 * waits for the ones already out to come back — with ~10 tasks per worker that
 * is roughly one task's duration, single-digit milliseconds — and only then
 * runs fn.
 *
 * Nesting is counted, so overlapping interrupts behave.
 */
var pauseDepth   = 0;
var parkedFeeds  = [];      // workers that asked for a task while paused
var idleWaiters  = [];      // resolved when no fragment is with a worker

function isPaused(){ return pauseDepth > 0; }

function parkFeed(fn){ parkedFeeds.push(fn); }

// FRAGMENTS IN FLIGHT ARE COUNTED PER POOL, not in one module-level number.
// A module-level counter leaked: destroying a pool mid-batch terminates
// workers whose fragments never reply, so the count stayed above zero forever
// and EVERY later interrupt() hung waiting for a drain that could not happen.
// Per-pool, destroy() can zero exactly what that pool was holding.
function totalInFlight(){
    var keys = Object.keys(pools);
    var n = 0;
    for(var i = 0; i < keys.length; i++) n += pools[keys[i]].inFlight;
    return n;
}

function notifyIdle(){
    if(!idleWaiters.length) return;
    if(totalInFlight() > 0) return;
    var list = idleWaiters; idleWaiters = [];
    for(var i = 0; i < list.length; i++) list[i]();
}

function whenNothingInFlight(){
    if(totalInFlight() <= 0) return Promise.resolve();
    return new Promise(function(resolve){ idleWaiters.push(resolve); });
}

/**
 * Stop handing fragments to workers, run `fn` with the cores to itself, then
 * carry on. Returns whatever `fn` returns.
 *
 * `fn` MAY BE ASYNC — it is awaited, and work resumes only once it settles.
 *
 * WHAT YOU MAY DO INSIDE fn
 *   - CPU work. That is the point: dispatch is stopped and fragments already
 *     with a worker have been drained first, so the cores really are yours.
 *   - Submit conversions without awaiting them. They queue and start when the
 *     interrupt releases.
 *   - Await management calls: forgetWorkers(), getWorkerInfo(), cancel(),
 *     cancelAll(), memoryReport(). The first two would normally queue behind
 *     the running batch, which would deadlock, so they detect the pause and
 *     run immediately — safe precisely because the drain already happened.
 *
 * WHAT YOU MUST NOT DO
 *   - **Await a conversion.** `await t.transformImages(...)` inside `fn` never
 *     returns: the batch needs workers, the workers are parked until this
 *     interrupt releases, and this interrupt is waiting on `fn`. Circular, and
 *     it cannot be detected — interrupt() is process-wide, so "called from
 *     inside the callback" is indistinguishable from "unrelated code called
 *     while an interrupt happened to be active". Submit without awaiting, or
 *     await after the interrupt returns.
 *
 * @param {Function} fn  sync or async
 * @returns {Promise<*>}
 */
function interrupt(fn){
    pauseDepth += 1;
    return whenNothingInFlight()
        .then(function(){ return fn(); })
        .then(function(v){ releasePause(); return v; },
              function(e){ releasePause(); throw e; });
}

var resumeWaiters = [];

/** Resolves once no interrupt is holding the pool. */
function whenResumed(){
    if(!isPaused()) return Promise.resolve();
    return new Promise(function(resolve){ resumeWaiters.push(resolve); });
}

function releasePause(){
    pauseDepth -= 1;
    if(pauseDepth > 0) return;
    pauseDepth = 0;

    var waiting = resumeWaiters; resumeWaiters = [];
    for(var r = 0; r < waiting.length; r++) waiting[r]();

    var list = parkedFeeds; parkedFeeds = [];
    for(var i = 0; i < list.length; i++) list[i]();
}

// Counted at SUBMISSION — when transformImages() commits to the parallel
// path — not when the batch reaches run(). run() is only called after
// pool.start() resolves, which is a microtask later, so counting there made
// queueDepth() read 0 for work already submitted and onQueueBelow() wave a
// whole loop through without pacing anything.
var submitted = 0;

function enterQueue(bytes){
    submitted += 1;
    inFlightBytes += (bytes || 0);
}
function leaveQueue(bytes){
    submitted -= 1;
    inFlightBytes -= (bytes || 0);
    if(inFlightBytes < 0) inFlightBytes = 0;    // paranoia; a mismatched pair
    notifyDrain();
}

/** Batches submitted and not yet settled. */
function queueDepth(){ return submitted; }

/**
 * Bytes of IMAGE DATA submitted and not yet settled — input plus output, for
 * every batch in flight.
 *
 * Deliberately NOT the same question as memoryReport(). That reports what the
 * workers hold: LUT copies and WASM linear memory, which are a fixed cost of
 * having a pool at all and do not move with the queue. This is the part that
 * grows when a producer runs ahead of the workers, and therefore the part
 * worth applying backpressure to.
 */
function memoryInFlight(){ return inFlightBytes; }

var inFlightBytes = 0;

function notifyDrain(){
    if(!drainWaiters.length) return;
    var depth = queueDepth(), bytes = memoryInFlight();
    var still = [];
    for(var i = 0; i < drainWaiters.length; i++){
        var w = drainWaiters[i];
        var value = (w.kind === 'bytes') ? bytes : depth;
        if(value < w.limit) w.resolve(value);
        else still.push(w);
    }
    drainWaiters = still;
}

/**
 * Resolves once fewer than `limit` batches are outstanding.
 * @param {number} [limit=2]
 * @returns {Promise<number>} the depth at the moment it resolved
 */
function onQueueBelow(limit){
    limit = (limit === undefined) ? 2 : limit;
    var depth = queueDepth();
    if(depth < limit) return Promise.resolve(depth);
    return new Promise(function(resolve){
        drainWaiters.push({limit: limit, resolve: resolve, kind: 'depth'});
    });
}

/**
 * Wait until fewer than `bytes` of image data are in flight.
 *
 *     for(const file of tenThousandFiles){
 *         await pool.onMemoryBelow(512 * 1024 * 1024);
 *         t.transformImages([await load(file)], {onImage: save});
 *     }
 *
 * COUNTING BYTES RATHER THAN BATCHES is the honest unit when the images are
 * not the same size. `onQueueBelow(4)` holds four batches, which is 12 MB of
 * thumbnails or 3 GB of scans — the queue depth cannot tell you which, and the
 * number you actually have a budget for is the second one.
 *
 * Counts input plus output for everything submitted and not yet settled. It
 * does NOT count what the workers hold — LUT copies and WASM memory are a
 * fixed cost of having a pool, they do not grow with the queue, and
 * memoryReport() is the tool for those.
 */
function onMemoryBelow(bytes){
    if(!(bytes > 0)) return Promise.resolve(memoryInFlight());
    var live = memoryInFlight();
    if(live < bytes) return Promise.resolve(live);
    return new Promise(function(resolve){
        drainWaiters.push({limit: bytes, resolve: resolve, kind: 'bytes'});
    });
}

/**
 * Resolves once nothing is queued or running. For "is the pool idle?", not for
 * pacing — see onQueueBelow().
 *
 * IT DOES NOT MEAN YOUR RESULTS ARE IN HAND. This resolves when the pool's
 * last batch settles; a `.then()` you attached to your own batch promise is a
 * separate continuation and may not have run yet. To use the results, await
 * the promises transformImages() returned — that is what they are for. This is
 * for the case where you did not keep them: shutting down, reporting idle, or
 * deciding it is safe to release workers.
 */
function onQueueFree(){
    return onQueueBelow(1);
}

/** Cancel one image by id, across every batch currently in flight. */
function cancel(id){
    var keys = Object.keys(pools);
    var marked = 0;
    for(var i = 0; i < keys.length; i++){
        pools[keys[i]].cancelledIds[id] = true;
        marked += 1;
    }
    return marked > 0;
}

/** Stop everything queued or running. Batches submitted later are unaffected. */
function cancelAll(){
    cancelGeneration += 1;
    return cancelGeneration;
}

/**
 * Per-worker throughput, for the question "did the OS actually put my workers
 * on different cores?".
 *
 * Workers are NOT pinned — placement is the operating system's business, and
 * on an SMT part it may put two workers on the two logical threads of one
 * physical core while another core sits idle. Two workers sharing a core run
 * at roughly half rate each, and because fragments are PULLED rather than
 * pre-assigned, a slow worker simply takes fewer of them. So the tell is not
 * wall time — the queue hides that — but an uneven split of fragments and a
 * bimodal spread of per-worker MPx/s.
 *
 * Rates are pixels divided by the worker's own reported compute time, so they
 * exclude queueing and transfer.
 *
 * @returns {Array} one entry per pool: {key, workers, perWorker: [...], spread}
 */
function workerStats(){
    return Object.keys(pools).map(function(key){
        var pool = pools[key];
        var per = [];
        for(var i = 0; i < pool.workers; i++){
            var ms = pool.workerComputeMs[i] || 0;
            var px = pool.workerPixels[i] || 0;
            per.push({
                worker:    i,
                tasks:     pool.workerTasks[i] || 0,
                pixels:    px,
                computeMs: ms,
                mpxs:      ms > 0 ? (px / 1e6) / (ms / 1000) : 0
            });
        }
        var rates = per.map(function(w){ return w.mpxs; }).filter(function(r){ return r > 0; });
        var lo = Math.min.apply(null, rates), hi = Math.max.apply(null, rates);
        return {
            key: key,
            workers: pool.workers,
            perWorker: per,
            slowestMpxs: rates.length ? lo : 0,
            fastestMpxs: rates.length ? hi : 0,
            spread: rates.length && lo > 0 ? hi / lo : 0
        };
    });
}

var _keySeq = 0;

/**
 * A fresh worker-cache key, unique for the life of this process.
 *
 * ASSIGNED, NOT DERIVED. The obvious alternative is to hash what the worker
 * builds from — the profile chain plus the resolved options — and that is what
 * this did first. It is wrong in a way that is hard to keep fixed: correctness
 * then depends on the hash covering EVERY input that changes the result,
 * forever, including options added later. It already failed once. A
 * `buildLut:true` Transform whose LUT the probe rejected and a
 * `buildLut:false` Transform over the same profiles both resolve lutMode to
 * 'float', so they hashed identically; whichever registered first won and the
 * other was silently served it — a LUT interpolation handed to a caller who
 * asked for the exact pipeline. Both return plausible pixels.
 *
 * A counter cannot do that. Two Transforms are the same to the workers only if
 * they are literally the same object, so the failure mode inverts: identical
 * Transforms no longer share a worker entry, and the cost is memory rather
 * than wrong colour. That trade is deliberate — see docs/deepdive/multicore.md
 * on why multicore is not free in JS — and it is the caller's to manage by
 * reusing Transforms rather than rebuilding them.
 *
 * @returns {string}
 */
function nextKey(){
    _keySeq += 1;
    return 'tx' + _keySeq;
}

/**
 * Drop a transform from every live pool.
 *
 * A Transform does not track which pool served it — there is normally only one
 * — so forgetting asks all of them. Pools that never held it shrug.
 *
 * @returns {Promise<number>} total workers asked, across all pools
 */
function forgetEverywhere(signature){
    var keys = Object.keys(pools);
    return Promise.all(keys.map(function(k){
        return pools[k].forget(signature);
    })).then(function(counts){
        return counts.reduce(function(a, b){ return a + b; }, 0);
    });
}

module.exports = {
    DEFAULTS: DEFAULTS,
    idealWorkers: idealWorkers,
    sliceLengthFor: sliceLengthFor,
    planBatch: planBatch,
    acquire: acquire,
    enable: enable,
    unavailableReason: unavailableReason,
    release: release,
    destroyAll: destroyAll,
    forgetEverywhere: forgetEverywhere,
    nextKey: nextKey,
    cancel: cancel,
    cancelAll: cancelAll,
    queueDepth: queueDepth,
    workerStats: workerStats,
    interrupt: interrupt,
    isPaused: isPaused,
    enterQueue: enterQueue,
    leaveQueue: leaveQueue,
    onQueueBelow: onQueueBelow,
    onMemoryBelow: onMemoryBelow,
    memoryInFlight: memoryInFlight,
    onQueueFree: onQueueFree,
    memoryReport: memoryReport,
    memorySummary: memorySummary,
    _pools: pools
};
