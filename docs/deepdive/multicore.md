# Multicore — design notes

> **Status: built.** `Transform.transformImages()` runs the multicore
> path, output byte-identical to sequential.
>
> **This page runs in the order the work happened**: the brainstorm and the
> two candidate models first, then the POC that ruled out the more invasive
> half of the document before any of it was implemented, then what was built,
> and finally the shipped pool measured across content, workers and kernels.
> If you only want numbers, jump to
> [the shipped pool](#measured--the-shipped-pool-across-content-workers-and-kernels)
> and [what it costs](#we-support-multicore-but-it-is-not-free).
>
> Headline: **6.2x peak** (noise/int), **787 MPx/s** peak throughput
> (solid/wasm-simd), byte-identical in all 72 cells. Current tables are
> generated into [BenchResults](../BenchResults.md#table-pool-peak); the
> analysis below is written against the 2026-08-19 run, whose numbers sit
> within run-to-run spread of these.
>
> **Two things to take away if you read nothing else.**
>
> 1. A LUT transform is *not* fixed-cost per pixel — content changes
>    throughput by up to 2.7x — so splitting an image evenly across N
>    threads is the wrong fit and measured 30-48% off. Over-decompose
>    instead.
> 2. **This is a different model from lcms, not a port of it.** lcms
>    splits one buffer evenly across N threads and joins; we fragment
>    images into a shared queue that a persistent pool pulls from, out of
>    order, across many images and many transforms. More flexible — and
>    it costs memory, because every worker holds its own copy of the LUT
>    rather than sharing one. Both sections below.

## A different model from lcms, not a port of it

It is easy to read "multicore" and assume both engines do the same thing in
different languages. They do not, and the difference is the reason for both our
advantages and our costs.

**lcms `threaded`** splits one buffer evenly across N threads
(`_cmsThrCountSlices` — an even division capped at the CPU count, with a 128 KB
per-thread floor), spawns the threads for that call, and joins. One image, N
threads, static split, done. Threads share the address space, so the CLUT is
one copy.

**Here**, an image is broken into **fragments** — around ten per worker — which
go into a shared queue that a persistent pool of workers pulls from. Fragments
complete out of order and are reassembled by position. The pool is a
process-level singleton that many Transforms share, each holding a lease; every
task carries its own transform signature, so a worker switches between
transforms task by task.

| | lcms `threaded` | jsColorEngine |
|---|---|---|
| unit of work | one buffer, divided evenly N ways | fragments, ~10 per worker |
| threads | spawned per call, joined | persistent pool, leased |
| scheduling | static, fixed before any work runs | pull queue, out of order |
| scope | one conversion | many images, many transforms |
| ordering | n/a | priority and grouping are expressible |
| completion | all-or-nothing at the join | per-image, as each lands |
| CLUT | one shared copy | one copy per worker |

### Why the difference is deliberate

An even static split is only optimal if pixels cost the same. **They do not** —
content moves throughput by up to 2.7×, because how much of the CLUT the pixels
touch decides cache behaviour (measured; see the shipped-pool results). So
equal-sized slices take
unequal time, and every thread waits on the slowest one: 30–48% off on uniform
hardware, 2.6× off when cores are uneven.

A static split *cannot* fix this, because the division is decided before any
work has run and nothing has measured which regions are expensive. Fragmenting
and pulling from a queue fixes it without predicting anything: a worker that
draws a cheap fragment simply comes back sooner.

That mattered more here than it would in C, for a reason specific to JS: worker
start-up is material, so spawning per call is not viable and a persistent pool
is forced on us. Having been forced into a pool, over-decomposition becomes
nearly free — and turns out to be worth 30–48%.

### What it buys, and what it costs

Buys: work from **many images and many transforms** can coexist; results can be
delivered **per image as they finish** rather than at a join; scheduling can
express **priority** and **grouping**; and uneven cores, thermal throttling,
SMT contention and content variance are all absorbed by the same mechanism
without detecting any of them.

Costs: **memory**. A persistent pool of isolated workers means the CLUT is
resident once per worker rather than once per process — see "We support
multicore, but it is not free". That is not a JS tax we failed to avoid; it is
the price of the model, and the model is what makes the rest of it possible.

Both halves belong in any honest comparison. lcms's approach is simpler and
cheaper in memory. Ours is more flexible and does not assume something we
measured to be false.

## The assumption to discard first: pixels are not fixed-cost

Almost every naive parallel-image design starts from *split the image by
the number of threads*. That is correct only if a pixel costs a constant
amount to convert. **In a LUT-based colour transform it does not**, and
everything else in this document follows from that.

The content work measured the same kernel running anywhere from **~100
to ~270 MPx/s on identical pixel counts** — a 2.7× spread — decided
purely by how much of the interpolation table the pixels touch
([benchmark.md §§20–21](./benchmark.md#21-noise-is-the-great-equaliser)).
A flat region converts fast because the CLUT working set stays in cache;
a detailed, colourful region converts slowly because it does not. Real
frames contain both, usually in large contiguous areas — sky at the top,
foliage at the bottom.

So for a colour transform:

| assumption | true? |
|---|---|
| every pixel costs the same | **no** — up to 2.7× depending on content |
| equal-sized slices take equal time | **no** — follows from the above |
| therefore: one slice per thread balances the load | **no** — measured 30–48 % off |

**`image.length / threadCount` is the wrong split**, and not by a little.
It is the worst configuration measured, because the batch finishes when
the slowest slice finishes and a slice that happens to land on detailed
content has nothing left to overlap it. The fix is not a smarter
estimate of where the expensive regions are — it is to cut the work into
many more pieces than there are workers and let a pull-queue absorb the
difference. Roughly ten tasks per worker, measured below.

This also means a scheduler cannot use slice *size* as a proxy for slice
*cost*, which is what an LPT sort implicitly assumes. Details in
"Equal pixels are not equal work" below.

## Why this is worth writing down now

The v1.5.0 kernel split turned out to have put the seam in the right
place. Three things fall out for free:

**The loops are already slice-shaped.** Every hot loop takes

```js
tetrahedralInterp4DArray_4Ch_intLut_loop(
    input, inputPos, output, outputPos, length, intLut,
    inputHasAlpha, outputHasAlpha, preserveAlpha)
```

`(buffer, offset, length)` *is* the worker contract. A worker is that
call with different numbers. Nothing about the maths changes.

**There is no mutable scratch.** WASM linear memory is laid out
`[LUT][input][output]` (`src/wasm/wasm_loader.js`) and the kernels read
input and write output with nothing in between. The only shared state
is the LUT, read-only once built. That is the ideal case for sharing —
no locks, no atomics, no per-worker arenas.

**Kernel descriptors are self-contained.** `create` / `array` /
`release` / `provideLut` is already a lifecycle a worker can drive.

## Two models, and the cheap one comes first

There are two ways to get pixels to workers, and they have very
different costs — not in speed, but in how much of the engine has to
change.

### Model A — transfer (no shared memory)

Split the image into N ordinary `ArrayBuffer`s, `postMessage` each with
a transfer list (zero-copy handover, sender loses access), convert,
transfer the result back, reassemble.

- **No `SharedArrayBuffer`, so no COOP/COEP requirement.** Works on any
  host, including embeds.
- **No imported-memory change**, no `compactIfNeeded` rework — each
  worker owns a private WASM instance with its own internal memory,
  exactly as today.
- **Works for the JS kernels too**, unchanged, because a worker just
  gets a normal typed array.
- Costs two copies per slice (split and reassemble). On a 20 MP RGB
  image that is ~120 MB of memcpy at maybe 10 GB/s ≈ 12 ms each way,
  against ~285 ms of compute being parallelised. Strongly favourable.

### Model B — shared (`SharedArrayBuffer`)

One buffer, disjoint ranges, zero copies — the model described in the
rest of this document.

- Needs cross-origin isolation on the web (see below).
- Needs imported WASM memory and the reclaim rework.
- Needs a SAB arena for the JS path (Glenn's "separate memory
  management" — the JS kernels have no allocation story today, arrays
  are just GC'd).

### Which first

**Model A.** It is strictly less invasive, has no deployment blocker,
and captures most of the win — the copies are ~8 % of the compute they
replace. Model B is the optimisation once the parallel path exists and
is measured, and it is where the last of the copy cost goes.

The important consequence: **items 2 and 3 below are Model B only.**
Item 1 (offsets) is needed by both; item 4 (deleting the in/out copy)
is worth doing regardless.

## What actually has to change

### 1. Thread the offsets through the wrapper

The offsets exist at the loop level and are dropped one layer up:

```js
// Kernel3D.js — no offsets
array: function(inputArray, outputArray, pixelCount, lut, inAlpha, outAlpha, preserve)
// kernelUtils.runTableKernel — same
run(transform, inputArray, outputArray, pixelCount, lut, ...)
```

Adding `inputPos` / `outputPos` to `array()` and `runTableKernel()` is
mechanical, and single-threaded callers pass 0. This is the smallest
enabling change and is worth doing on its own merits — it also lets a
caller convert a sub-range without slicing buffers.

### 2. WASM memory must be imported, not internal

All eight `.wat` sources declare memory internally:

```wat
(memory (export "memory") 1)
```

Shared memory has to be imported so every instance binds the *same*
one:

```wat
(import "env" "memory" (memory 1 <max> shared))
```

**This does not fork the variants.** The same module works shared or
unshared — JS owns the `Memory` either way. One line per file, roughly
neutral single-threaded.

### 3. `compactIfNeeded` cannot survive sharing

Our reclaim path does not shrink memory — nothing can, there is no
`Memory.shrink()`. `Tetra3DState.compact()` **re-instantiates from the
stored Module**, so the old instance and its large memory become
garbage:

```js
var instance = new WebAssembly.Instance(this.module, {});
this.memory = instance.exports.memory;   // fresh, 1 page
```

That works *because* the memory is internal. With imported shared
memory, re-instantiating hands back the same memory, so the reclaim
silently becomes a no-op — and swapping in a fresh shared memory
instead would leave workers holding the old one, writing into an
orphaned buffer. Silent divergence, no error raised.

So under Model B `compactIfNeeded` must be **disabled**, and
reclamation moves up a level. Note this is a Model B problem only —
under Model A each worker owns a private instance with internal memory
and compacts exactly as it does today.

**Reclaim should move to pool-drain in both models anyway.** Not because
Model A breaks, but because per-call compaction is the wrong trigger
under a pool: you compact, then immediately get handed the next slice
and re-grow. Across a batch that is pure churn.

Rather than adding a parallel `compactIfNeededMulticore` flag — which
duplicates a policy that is already fine — keep the existing
`shrinkRatio` / `maxMemory` policy and move *when it is evaluated*:

| mode | reclaim trigger |
|---|---|
| single-threaded | after a call — today's behaviour, opt-in |
| pooled | when the pool **drains**, i.e. no slices in flight |

The completion barrier the pool needs anyway is exactly that point, so
no new synchronisation has to be invented. It also happens to be the
only *safe* point for Model B: rebuilding the shared memory while any
worker might still touch it is precisely the orphaned-buffer failure
described above, and "drained" is the guarantee that rules it out.

Keep visible that under Model B this is not compaction at all — a
shared memory cannot shrink — but **teardown and rebuild**: re-instantiate
and re-copy the LUT per worker. That has to stay rare. Idle-triggered,
never per batch.

Under Model B, `setWasmShrinkRatio` / `setWasmMaxMemory` /
`compactWasmMemory` on an individual Transform also need to no-op or
throw rather than appear to work, since the memory is no longer the
Transform's to reclaim.

### 4. Delete the copy (worth doing regardless)

Today every call copies the image in and out of linear memory:

```js
memU8.set(input.subarray(inputPos, inputPos + inputBytes), this.inputPtr);
// ... kernel ...
new Uint8Array(this.memory.buffer, this.outputPtr, outputBytes)   // copy out
```

Under threading the image should already *live* in the shared memory so
workers read and write their slice in place. On a 20 MP RGB image that
is ~120 MB of copying removed. This may be a bigger single-threaded win
than the threading is a multi-threaded one, and it should be measured
first.

## The shape

```js
// main thread, once
const memory = new WebAssembly.Memory({ initial, maximum, shared: true });
const module = await WebAssembly.compileStreaming(fetch('tetra4d_simd.wasm'));
// WebAssembly.Module is structured-cloneable — post it, don't recompile
workers.forEach(w => w.postMessage({ module, memory, lutPtr, inPtr, outPtr }));

// per image
const slices = partition(pixelCount, workers.length);
slices.forEach((s, i) => workers[i].postMessage({ start: s.start, length: s.length }));
await barrier();      // Atomics.wait/notify, or count postMessage replies
```

Disjoint output ranges mean **no synchronisation in the inner loop at
all** — the only coordination is the completion barrier.

## Partitioning — three alignment rules

1. **Pixel boundaries.** Input and output strides differ (RGB→CMYK is 3
   in, 4 out), so each worker needs both offsets computed from its pixel
   index, not one byte offset.
2. **Multiples of 4 pixels** so no worker straddles an `f32x4` vector
   and has to handle a partial one mid-range.
3. **Align output starts to 64 bytes** or the seams false-share and the
   cores ping-pong a cache line for the whole run. RGBA/CMYK at 4 B/px
   is 16 px per line; RGB at 3 B/px means aligning on 64-pixel multiples
   (192 B).

Rule 3 is the one that silently costs 20–30 % if missed and looks like
"threading just doesn't scale here".

## The deployment blocker is headers, not code

`SharedArrayBuffer` requires cross-origin isolation:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

That breaks third-party embeds and is not settable on many static
hosts. Node's `worker_threads` has no such constraint.

**So this ships cleanly in Node / Electron / CLI, and conditionally on
the web.** Any API must degrade to single-threaded silently when
`crossOriginIsolated === false`, reporting it via a capability flag
rather than throwing.

## When it pays

- Worker startup is ~5–50 ms. **Pool and reuse**; never spawn per image.
- Post the compiled `Module`, don't recompile per worker.
- There is a crossover below which splitting loses. A 1 MP thumbnail at
  70 MPx/s is 14 ms — comparable to spin-up. A 20 MP image is ~285 ms
  and splits well. The threshold needs measuring, not guessing, and
  should be an option with a sane default.

Bandwidth is not expected to bind: 4 workers × 70 MPx/s on 8-bit
RGB→CMYK is ~1.9 GB/s, and even 4× the SIMD tier is ~7.5 GB/s against
30–50 GB/s of DDR5. Scaling should be near-linear in cores until the
pool exhausts them.

## Interaction with the pixel cache

**Per-worker tables, no sharing.** A shared cache would need atomics on
every lookup and would contend badly; a private table per worker has
zero coordination cost. Each worker starts cold, so hit rate drops
slightly at the slice seams — negligible for large slices.

**The cache goes on scalar paths only — never SIMD.** That is a
deliberate scope decision, consistent with the pixel-cache scoping in
[PixelCache.md](./PixelCache.md): keep the affected surface as small as
possible, and do not complicate the kernel whose entire value is doing
four pixels at once. SIMD stays pure.

*Recorded for completeness, not proposed:* a table genuinely cannot go
in a SIMD kernel anyway — four pixels per vector means four different
slots, i.e. a gather, and WASM SIMD has no gather (`v128.load` is
contiguous only), so any table lookup collapses to four scalar probes
and destroys the vectorisation. The only SIMD-compatible form would be
repeat detection at vector granularity (`v128.load` + `i8x16.eq` +
`i8x16.all_true`, three instructions, storing the previous output
vector on a hit). Elegant, but it still adds a branch to the hot path
of the fastest kernel we have, to serve content that the scalar path
already handles. Not doing it.

## API shape

Settled by the dispatcher section below: one call takes 1..n images and
the planner decides per image whether to slice it or run it whole.

```js
const pool = await jsColorEngine.createPool({ workers: 'auto' });
await pool.transformImages(transform, [img1, img2, ...]);
pool.release();
```

An explicit pool rather than a hidden one, because worker pools have a
lifecycle and pretending otherwise leaks. A convenience wrapper over a
lazily-created default pool can sit on top for the single-image case:

```js
transform.transformArray(pixels, ..., { workers: 'auto' });
```

`workers` accepts a number, `'max'` (reported count, falling back to 4
when the runtime reports nothing) or `'auto'` (a fraction of reported,
floor of 4, then capped by the measured slice rule).

## Getting the LUT to the workers

Separate problem from the pixels, and easy to overlook. Every worker
needs the baked CLUT, and rebuilding it per worker is wasteful — a 4D
bake is ~11 ms and the table is ~670 KB (17⁴ × 4 × u16).

Three options, cheapest first:

1. **Serialise once, rebuild in each worker.** We already have portable
   LUT JSON (`toJSON` / `fromJSON` / `jsonToLut`), so this needs no new
   machinery at all: build on the main thread, post the JSON, each
   worker calls `setLut()`. Costs one copy of the table per worker,
   once per pool — irrelevant against a long-lived pool.
2. **Transfer the CLUT buffer** to workers if they can own it outright.
3. **Share it via SAB** (Model B), one copy total, needs `setLut` to
   accept an externally-owned buffer.

Option 1 is almost free to implement and is the obvious starting point.
That the portable-LUT work already exists is a genuine piece of luck
here.

## Roadmap — a shared work queue, and why it needs counters rather than markers

Not built. Recorded here with the measurement that motivates it, because the
design question turned out to have a non-obvious answer.

### The cost of serialising batches

Batches run one at a time. `_runBatch` re-installs each worker's message
handler with a closure over that batch's state, so two live batches would
clobber each other — the second wipes the first's handler and the first waits
forever for replies nobody is listening for. Serialising is correct and costs
nothing in throughput, because both batches want the same N workers on the same
N cores.

It costs latency, and more than expected. A 0.4 MP preview issued behind a
20 MP export on this machine:

| | |
|---|---|
| small alone | 7 ms |
| big alone | 92 ms |
| **small behind big** | **84 ms — a 12× penalty** |
| both, total | 84 ms (throughput unaffected) |

For an editor showing a preview while an export runs, that is the difference
between instant and visibly stalled.

### What does not fix it

**A barrier or flush marker in the queue.** A marker saying "nobody starts B
until A drains" enforces exactly the ordering serialisation already enforces.
Same semantics, more machinery, same 12×.

**Appending a new batch to the tail with a flush marker.** Preserves ordering,
so the small job still waits behind every task of the big one. This is worth
stating because it is the intuitive design and it does not help with latency —
though it does remove the batch-boundary stall, so work streams continuously.

### What does fix it

One shared queue, persistent per-worker message handlers, and tasks routed by
id to their own batch's output and counter.

**The worker side already does this.** Every `run` message carries its own
`signature`, and the worker looks up `registry[msg.signature]` per task. A
worker can already switch transform between consecutive tasks; it has been able
to all along. What is batch-scoped is only the pool's bookkeeping: `signature`
and `payload` are `_runBatch` parameters, and the completion handler closes over
one batch's `tasks`/`images`/`outputs`/`done`.

So the change is to move `{signature, payload}` onto the task and route
completions by id.

### Ordering: sort by (priority, signature group, length descending)

Grouping by signature keeps a transform's CLUT hot for a whole group, so
workers cross a transform boundary only at group edges — roughly N−1
transitions rather than switching at random. Without it, interleaving different
transforms would have workers alternating between tables, and CLUT locality
moves throughput by up to 2.7× (see the content findings). The straddle
window at a boundary is about one task per worker.

Priority insertion places a group at the head rather than the tail. It cannot
preempt a task already running, but over-decomposition has already made that
cheap: a task is about a tenth of a worker's share, so the worst-case wait is
single-digit milliseconds instead of the 84 ms measured above.

Merging a new batch into an existing group of the same signature costs fewer
transitions but can starve: a caller repeatedly submitting the same transform
would keep an early group alive and later groups would never start. Merge only
into groups that have not begun, or cap growth after creation.

### Counters, not markers

The instinct is to express "tell me when this batch is done" and "drop this
transform once its work drains" as control items flowing through the queue.
That is the wrong mechanism, and the reason is specific: **priority insertion
and merging reorder the queue**, so a positional marker can be overtaken by
work that jumped ahead of it and will fire early. It is a load-dependent bug of
the worst kind — correct under test, wrong under load.

Counting is order-independent:

| need | mechanism |
|---|---|
| batch completion | per-batch refcount; resolve at zero |
| per-image completion | per-image refcount — **already built**, see `onImage` |
| fenced forget | per-signature refcount; forget at zero |
| cancellation | batch flag, drop queued tasks, decrement as they go |

The per-batch counter already exists as `done` inside `_runBatch`'s closure;
generalising it means moving it into a batch record keyed by id — the same
change that lets batches coexist.

**The per-image case is already shipped and demonstrates the principle.** With
tasks sorted longest-first and pulled by whichever worker frees up, a five-image
batch completed in the order 0, 2, 3, 1, 4. Anything positional would have
fired at the wrong time; the refcount did not care.

### Before building

Measure the cache cost with two *different* transforms in flight. The 84 ms
figure above is one transform, so every worker had the same CLUT hot.
Interleaving may buy 12× latency and hand back throughput — which is exactly
the trade the grouped sort is meant to bound, and exactly the kind of
assumption that has been wrong before in this document.

## Scope

**In:** the WASM scalar and SIMD kernels, **and the JS int kernels** —
8-bit, 3D and 4D, the same narrowing as the pixel cache. Under Model A
the JS kernels need nothing special: a worker receives a normal typed
array and calls the same loop. Under Model B they need their own SAB
arena, because unlike the WASM path they have no allocation story today
— typed arrays are simply GC'd, and SAB lifetimes have to be managed
explicitly.

That second memory model is the main reason Model A comes first: it
defers having to invent one.

**Out:** the accuracy path, float, and ND. And the pixel cache stays
off the SIMD kernels even when they are running in workers.

## MEASURED (2026-08-19) — the experiment has been run

`bench/multicore_poc/` — Model A, public API only, no engine changes.
Ryzen 7700X (8C/16T), Node 24, sRGB→GRACoL, `lutMode: 'int'`, 8 MP,
output byte-identical to single-threaded in every row.

It scaled to **4.30× at 8 workers and 5.46× at 16**, with efficiency falling
from 95 % to 34 % — close enough to the shipped pool's shape (measured at the
top of this page, and the numbers to quote) that the design questions below
could be settled on it.

**Model B is probably not worth building.** The copies cost **4–7 %** of
a pass (7–13 ms against 181 ms). That is the whole prize
`SharedArrayBuffer` would win, in exchange for cross-origin isolation,
imported WASM memory and the reclaim rework. The measurement that was
meant to choose between the models chose the cheap one.

**The crossover is slice size, not image size.** At a fixed 262,144 px:

| workers | slice | speedup |
|---:|---:|---:|
| 1 | 262 K | 0.93× |
| 2 | 131 K | 1.61× |
| **4** | **65 K** | **2.56×** |
| 8 | 32 K | 1.22× |

Same image, twice the workers, half the speed. **~64 K pixels per slice**
is the floor. So `auto` should derive the count from slice size rather
than gate on image size:

```js
workers = clamp(floor(pixels / 65536), 1, autoMax)
```

That reproduces the measured optimum everywhere tried — 1 worker at 16 K
and 64 K (where 8 lost), 4 at 262 K, the cap above ~1 MP.

**Hyperthreads are worth ~25 %.** Near-linear to 4, good to 8 (the
physical count), then flat — 12 and 16 land within noise. `auto` at 75 %
of `availableParallelism` gives 12 here, near the peak, and leaves the
machine usable.

**Trap:** the portable-LUT JSON round-trip is lossy by up to 1 LSB
(`toJSON` quantises to u16, `setLut` re-derives), so a round-tripped
transform differs from a freshly-built one on ~0.07 % of bytes by
exactly 1. That made the first run report a correctness failure on every
row including single-worker — the comparison was wrong, not the workers.
A real implementation should ship the exact CLUT rather than JSON.

**Batch mode covers what splitting cannot.** Task-parallel — each
worker takes a whole image and pulls the next when it finishes:

| image size | split, 8 workers | batch, whole-image |
|---:|---:|---:|
| 16 K | 0.83x | **3.26x** |
| 64 K | 0.87x | **4.39x** |
| 256 K | 1.21x | 2.53x |

The sizes that lose under splitting win under batching, because the unit
of work is never subdivided and so there is no slice floor. The two
modes are complementary, and the right implementation is one work queue
carrying both kinds of item: slices of a large image, or whole small
ones. A `transformArraysParallel(images)` is the natural public shape
for the second.

The memory objection is smaller than it appears — `workers + 1` images
need to be resident, not the whole batch, so lazy loading as workers
free up keeps the peak bounded.

## CONCLUSION — the allocation rule

Everything measured above collapses to one rule and four constants.

```js
// Per-worker buffers are allocated ONCE at pool start, at `capacity`.
// A worker's buffer is a maximum, never a unit of work.
function sliceLength(px, workers, kernelMPxPerSec, capacity = 262144) {
    const floor  = Math.round(kernelMPxPerSec * 80);   // 80 µs of work, in px
    const wanted = Math.ceil(px / (workers * 10));     // ~10 tasks per worker
    return Math.min(capacity, Math.max(floor, wanted));
}
```

| constant | value | why |
|---|---|---|
| tasks per worker | ~10 | jitter needs 8–12 to average out; content variance needs only 2–4, so jitter sets it |
| task floor | 80 µs of work | ~10× the ~7–8 µs effective per-task overhead. **In time, not pixels** — 40 K px for SIMD, 22 K for JS |
| buffer capacity | 128–256 K px | flat region; keeps 16 workers at ~28 MB rather than ~190 MB |
| don't parallelise below | ~64 K px total | measured floor where splitting stops paying at all |

**Which term binds, by image size** (8 workers, SIMD):

| image | binds | slice | tasks | per worker |
|---|---|---:|---:|---:|
| 20 MP | capacity | 256 K | 78 | 9.8 |
| 2 MP | floor | 40 K | 52 | 6.5 |
| 500 K px | floor | 40 K | 13 | 1.6 |
| < 64 K px | — | — | 1 | run on the calling thread |

**Dispatch**: one flat queue, workers pull the next task when they
finish. Keep the LPT sort for batches of differently-sized images; do
not rely on it inside a single image, where every slice is the same
length and it can see nothing.

**Startup**: spin the pool up eagerly (~85 ms, repaid inside the first
image), use the default constants immediately, and calibrate lazily off
the critical path if no cached tuning exists — calibration costs ~300 ms
and is repaid only after ~369 eight-megapixel images, so it must be
cached across sessions rather than recomputed. Detail in
[where calibration goes in the lifecycle](#where-calibration-goes-in-the-lifecycle--and-what-it-costs).

**Why this is the balanced answer**, in one line each:

- **Over-decompose, never one-slice-per-thread.** The tidy split is the
  worst measured, by 30–48 % on homogeneous hardware and by **2.6× when
  two of eight cores run at a third speed** — a LUT transform is not
  fixed-cost per pixel, cores are not equal, and the slowest slice sets
  the makespan. The penalty for under-decomposing scales with how uneven
  the machine is, which is why the default leans on the safe side.
- **Fixed buffers, variable slices.** Allocate once, never grow, never
  reclaim — the churn that makes a UI stutter disappears — while the
  slice still adapts to image and pool size.
- **Floor in time, not pixels.** The only constant that survives a
  change of kernel, and it already differs 2× between the two we ship.
- **Don't model cost.** A content-aware estimator would be expensive,
  fragile, and is unnecessary — queue depth solves the same problem for
  free.
- **Remainders don't matter.** A 3-pixel task costs ~7 µs, 0.013 % of a
  pass. No threshold, no special case, no second code path.

**Still unmeasured**, and the reason this is a rule rather than a
result: whether fixed slots actually deliver the smoothness that
motivates them. That needs the pool built and judged on p95/p99 task
latency, GC pause count and peak RSS — not mean throughput, which may
show no difference at all.

### Self-tuning: calibrate once, do not adapt continuously

The two constants that matter — kernel throughput and per-task overhead
— are both machine properties. A 3D V-Cache part with 96 MB of L3 keeps
far more of the CLUT resident and shifts throughput up; a 48-core server
has different jitter and different message costs. Hard-coding
`500 MPx/s` is a guess that will be wrong on most hardware.

The tempting fix is to measure production traffic and adapt as you go.
**It has a feedback loop in it.** Slice size affects the very number you
would feed back: smaller slices measure lower throughput, which raises
the floor, which enlarges slices, which measure higher... Reporting
worker-side *compute* time rather than wall time was the obvious way to
break that, and it only half works — measured across slice sizes, the
per-worker kernel figure still moved 24 → 32 MPx/s, largely because at
one task per worker you are timing a cold first call:

| tasks | px/task | wall MPx/s | kernel MPx/s (per worker) |
|---:|---:|---:|---:|
| 8 | 262 K | 233.8 | 24.2 |
| 24 | 87 K | 232.3 | 30.9 |
| 96 | 22 K | 205.3 | 27.5 |
| 192 | 11 K | 216.9 | 32.6 |

So prefer **a short calibration at startup** — a controlled experiment
rather than an inference from whatever traffic happens to arrive:

```js
// ~1 s, once. Returns constants the caller can persist and pass back.
const tuning = await pool.autoTune({ budgetMs: 1000 });
// { kernelMPxPerSec, perTaskOverheadUs, tasksPerWorker, capacity, measuredAt }
localStorage.setItem('jsce.tuning', JSON.stringify(tuning));
```

What it should do, and why each part:

1. **Two synthetic passes, not a sweep.** One with large slices to read
   kernel throughput with overhead amortised away, one with small slices
   where overhead dominates. Two points determine both unknowns —
   `T = px/throughput + n·overhead` — and a full sweep is not needed.
2. **Warm first, discard the first task per worker.** The 24 vs 32
   MPx/s spread above is mostly cold-start; a calibration that includes
   it will under-estimate the machine.
3. **Use synthetic content deliberately in the middle of the range.**
   Not `solid` (measures L1), not `noise` (measures the worst case).
   The corrected noise generator blended ~5 % — the plateau from
   [benchmark.md §21](./benchmark.md#21-noise-is-the-great-equaliser) —
   is the representative choice, and this is exactly the case that
   argument was made for.
4. **Clamp hard.** `kernelMPxPerSec` into something like 20–2000,
   `tasksPerWorker` 4–16, slice into `[floor, capacity]`. A pathological
   calibration on a throttled or contended machine must degrade to
   "slightly wrong", never to "one pixel per task".
5. **Persist it, keyed by worker count and kernel mode.** The result is
   a property of the machine and the kernel, not of the image, so it
   should survive a page reload and only be recomputed when the pool
   shape changes.

Why calibration beats continuous adaptation here: it is deterministic
and reproducible, it has no feedback loop because *we* choose the slice
sizes being measured, it costs a bounded one second rather than an
unbounded fraction of every batch, and it can be cached. The obvious
hybrid is cheap insurance rather than a second mechanism: keep a rolling
average of observed throughput and re-calibrate only if it drifts by
more than ~2× from the stored value, which catches a laptop dropping to
battery or a container being throttled.

**Every derived value is bounded, and then raced against the default.**
Clamps alone are not enough — they stop a calibration being absurd, not
being wrong. So after deriving, run the derived plan against the shipped
default on the same content and **keep whichever is actually faster**,
with ties going to the default. That makes calibration incapable of
making things worse, which matters far more than making them slightly
better: a bad calibration on a throttled or contended machine would
otherwise silently degrade every subsequent run.

| bound | range | why |
|---|---|---|
| `kernelMPxPerSec` | 20–2000 | a throttled machine must not produce a 1-pixel slice |
| `perTaskOverheadUs` | 1–500 | a contended one must not produce a whole-image slice |
| `tasksPerWorker` | 4–16 | measured envelope across both kernels |
| adopt threshold | > 3 % | below this it is noise, so keep the known-good default |

### MEASURED — `autotune.js` on this machine

Ryzen 7700X, 8 workers, 2 MP calibration image (photo blended 5 % toward
noise), **262–355 ms per run** — inside the one-second budget:

| kernel | aggregate | per worker | overhead | derived | bake-off | adopted |
|---|---:|---:|---:|---:|---:|---|
| `int` | 305.4 MPx/s | 38.2 | 6.8 µs | 11.4 /wk | −1.5 % | **default (10)** |
| `int-wasm-simd` | 608.5 MPx/s | 76.1 | 7.8 µs | 5.0 /wk | +3.1 % | **calibrated (5)** |

Three things worth noting:

- **The overhead figure cross-validates.** 6.8 and 7.8 µs, derived from
  two timed passes, independently reproduce the 7–8 µs found by the
  separate task-count sweep. Different method, same answer.
- **It rediscovered the kernel difference unprompted.** Nobody told it
  SIMD wants fewer, larger tasks; it derived 5 /wk for SIMD and 11.4 for
  JS from throughput alone, against measured optima of 6 and 12.
- **The bake-off did its job on the first run.** For the JS kernel the
  derived value was *worse* than the default and was correctly
  discarded. A calibration that only ever adopted its own answer would
  have shipped a 1.5 % regression on that path.

`autotune.js` is a working proof of the mechanism, not the shipped API —
`pool.autoTune()` still needs the pool. The numbers above are what it
should seed, and the JSON it prints is the shape to persist.

### Where calibration goes in the lifecycle — and what it costs

`create()` already has a slow phase, so the obvious idea is to fold
calibration into it: the LUT is built, buffer sizes are about to be
chosen, workers have to be spun up anyway. Measured, that turns out to
be the wrong place, and the numbers say so clearly:

| step | `int` | SIMD | already paid? |
|---|---:|---:|---|
| profile load | 8.9 ms | 8.9 ms | yes |
| LUT build | 15.1 ms | 9.6 ms | yes |
| `toJSON` for workers (376 KB) | 16.5 ms | 9.0 ms | new |
| pool spin-up ×8, incl. LUT hand-off + warmup | 66.5 ms | 66.5 ms | new |
| **calibration** | **355 ms** | **262 ms** | new |

**Calibration is 3–4× the entire pool setup and ~20× the LUT build.** It
cannot hide inside `create()`.

Payback settles it. At 45 MPx/s single-threaded against 305 aggregate on
eight workers, parallelism saves ~18.9 ms per megapixel:

| cost | pays back after | in 8 MP images |
|---|---:|---:|
| pool spin-up, 66.5 ms | 3.5 MP | **~0.4** |
| calibration, ~300 ms | **2,952 MP** | **~369** |

The asymmetry is the point. Pool spin-up is repaid before the first
image finishes, so starting workers eagerly is fine. Calibration is
repaid only out of the *margin over the default* — 3.1 % on SIMD, and
nothing at all on the JS kernel — so it needs roughly **369 eight-megapixel
images** to break even within a session. It will essentially never pay
for itself if recomputed per run.

So the lifecycle is:

1. **`create()` with multicore: spin up the pool, ship the LUT, use the
   default constants.** Costs ~85 ms on top of an existing ~25 ms, and
   is repaid inside the first image.
2. **Look for a cached calibration** keyed by `(cpuCount, workers,
   lutMode, engineVersion)`. If present, use it — the measurement is a
   property of the machine and survives restarts.
3. **If absent, calibrate lazily** — off the critical path, after the
   first batch or on idle — and apply it to *subsequent* work. Never
   block the first conversion on it.
4. **Re-calibrate only on drift**, when observed throughput moves more
   than ~2× from the stored value (battery, thermal throttling, a
   container being squeezed).

Which also vindicates keeping a good default: 10 tasks per worker wins
outright on the JS kernel and loses only 3 % on SIMD, so **the
uncalibrated path is nearly optimal** and calibration is a refinement
rather than a prerequisite. That is the right risk profile for something
shipping to unknown hardware.

One further consequence for small work: pool spin-up (66.5 ms) plus a
single small conversion is far more than doing it single-threaded. The
"don't parallelise below ~64 K px" floor should be joined by "and don't
spin up a pool for one small image" — the pool wants to be created once
and reused, which is what `transformImages()` taking 1..n images is for.

## Public options

Every default below is the measured one, with the finding that set it.
The intent is that **passing nothing is the right answer for almost
everyone** — these exist for the cases where the caller knows something
the library cannot, such as "leave two cores for the UI" or "this is a
384-core render node".

```js
const t = new Transform({
    dataFormat: 'int8',
    buildLut: true,
    multicore: true,              // false (default) | true | { …options }
});
```

`multicore: true` takes every default. The long form:

| option | default | what it does | measured basis |
|---|---|---|---|
| `cores` | `'auto'` | `1` disables; a number pins it; `'auto'` uses ~50 % of logical cores; `'max'` uses all | efficiency falls from 95 % at 1 worker to 34 % at 16; `availableParallelism()` reports LOGICAL threads (16 on an 8-core 7700X), so 50 % lands on physical cores, which is what actually parallelises |
| `minThreads` | `2` | never spin up a pool smaller than this; below it, run single-threaded | one worker is *slower* than no pool (0.95×) once copies are counted |
| `maxThreads` | `16` | hard ceiling regardless of `cores` | measured scaling flattens: 5.38× at 12 workers, 5.46× at 16 |
| `autoTune` | `'lazy'` | `false` uses defaults; `true` calibrates before first use; `'lazy'` calibrates off the critical path after the first batch; or pass a **stored tuning object** | calibration costs ~300 ms and repays only after ~369 × 8 MP images, so it must never block first use and must be cached |
| `tuning` | `null` | a previously persisted `autoTune()` result, keyed by `(cores, lutMode)` | the result is a property of the machine, not the image — it should survive a reload |
| `tasksPerWorker` | `10` | over-decomposition target | one task per worker is the worst measured split, 30–48 % off; 8–12 absorbs jitter, and content variance needs only 2–4 |
| `bufferPx` | `262144` | fixed per-worker slot capacity, allocated once | 128–256 K px sits in the flat region; 16 workers at ~28 MB rather than ~190 MB at 5 MB slots |
| `minSlicePx` | `16384` | never cut smaller than this | keeps per-task overhead (~7 µs) under ~1 % of a task |
| `parallelFloorPx` | `65536` | total pixels below which the work runs on the calling thread | measured floor where splitting stops paying at all |
| `keepAlive` | `true` | reuse the pool between batches; `false` tears it down after each | per-batch spin-up costs 66.5 ms every time — ten batches would burn 665 ms re-creating pools that repay in 3.5 MP each |
| `idleTimeoutMs` | `30000` | tear the pool down after this long idle; **`0` or `Infinity` = never expire**, hold until `releaseWorkers()` — the right setting for an interactive app that wants workers warm before the first slider drag | spin-up is 66.5 ms and repays in 3.5 MP, so rebuilding is nearly free and bounds the damage from a caller who never releases |
| `allocation` | `'fixed'` | `'fixed'` \| `'dynamic'` \| `'grow'` | fixed slots remove `Memory.grow()` and the reclaim path from the hot loop; the other two remain for the jitter comparison that is still unmeasured |

Notes that matter more than the table:

- **`cores: 'auto'` deliberately does not take the whole machine.**
  Efficiency is already down to 54 % at 8 workers and 34 % at 16, so the
  last cores buy little throughput while making the host unresponsive.
  A batch server should say `'max'`; a UI application should not.
- **`autoTune: 'lazy'` is the default, not `true`.** Blocking first use
  for ~300 ms to win 3 % is the wrong trade, and on the JS kernel there
  is nothing to win at all. Lazy calibration applies from the second
  batch onward and costs the caller nothing visible.
- **`tuning` is how calibration actually pays.** Run `autoTune()` once,
  persist the JSON, hand it back on subsequent runs. Without persistence
  the feature is close to pointless — see the payback table above.
- **`bufferPx` is a ceiling, not a quantum.** Slices are sized from the
  image and the pool and then clamped to it; a worker's buffer is
  frequently not full, and that is correct.
- **`allocation` should not need changing.** It exists because the
  claim that fixed slots reduce jitter is still unmeasured; when that
  comparison is done, the loser should be deleted rather than left as a
  option nobody understands.

`pool.transformImages([...])` takes 1..n images and always works, with
or without workers — where none are available it falls back to
sequential `transformArray()` and reports the worker count it actually
used, so a caller measuring throughput is never told a single-threaded
run was parallel.

## Teardown — workers do not clean themselves up

**No. Dropping a `Transform` does not close its workers**, and this is
the sharpest footgun in the whole design. JavaScript has no destructors,
and a `Worker` is not ordinary garbage: it owns an OS thread and, in
Node, a handle on the event loop.

Measured, not assumed — create a worker, drop the last reference, run
GC:

```
still alive 1516 ms after dropping the reference — process has NOT exited
```

The process had to be killed. In a CLI or a build step that is a hang on
exit with no error message, which is about the worst failure mode
available. Browsers are no kinder: a `Worker` persists until
`terminate()`, and an unreachable one is *permitted* to be collected but
not required to be.

### Four mechanisms, in order of reliability

**1. Explicit release, following the existing precedent.** The engine
already has `releaseWasmMemory()` for exactly this shape of problem, so
workers should match it rather than inventing a new idiom:

```js
transform.releaseWorkers();     // terminate pool, free slot buffers
```

**2. `unref()` while idle — the safety net that actually works.** An
unref'd worker does not hold the event loop open, so a forgotten pool
degrades from "process hangs forever" to "workers die at exit":

```
main work done at 1 ms; exiting cleanly despite a live worker
```

Ref while tasks are in flight, unref when the queue drains. This is
cheap, has no downside, and turns the worst failure into a non-event.
**It should be the default behaviour, not an option.**

**3. Idle timeout.** Tear the pool down after N seconds idle and rebuild
on demand. Spin-up is 66.5 ms and repays in 3.5 MP, so rebuilding is
close to free — this costs almost nothing and bounds the damage from a
caller who never releases. Default somewhere around 30 s.

**4. `FinalizationRegistry` as a backstop, never as the plan.** It can
log a warning when a `Transform` with a live pool is collected, which
turns a silent leak into a diagnosable one. It must not be the primary
mechanism: callbacks are not guaranteed to run at all, and never at a
predictable time.

### Per-batch or keep-alive? Keep-alive, with an idle timer

Both should be available, but the default decides almost every real
outcome, and the arithmetic is one-sided:

| policy | first batch | ten batches | idle cost |
|---|---:|---:|---|
| per-batch spin-up/teardown | 66.5 ms | **665 ms** | none |
| keep-alive + 30 s idle timer | 66.5 ms | **66.5 ms** | ~15–20 MB, 8 parked threads |

Spin-up repays in 3.5 MP, so paying it once is trivial and paying it ten
times is not. **Default to keep-alive with an idle timer**, which gets
both cases right without the caller deciding anything: repeated work
reuses a warm pool, and a one-shot conversion releases ~30 s later on
its own.

Note the idle cost is small but not zero — eight parked threads and the
slot buffers — which is exactly what the timer is protecting against.

**Arm the timer on drain, not on a poll.** A `setInterval` waking every
few seconds to ask "are we idle yet" is wasted work on a laptop and
wakes the CPU out of low-power states. The queue already knows when it
empties; arm a single timer there and cancel it when work arrives.

**And unref the timer, or you have simply moved the leak.** A pending
`setTimeout` is an event-loop handle in its own right:

```
armed a 30s idle timer, main work done
  -> still alive at 1215 ms, held open by the TIMER
```

With `timer.unref()` the same program exits at 0 ms. So both the workers
*and* the idle-shutdown timer must be unref'd; getting one right and not
the other still hangs the process, and the timer is the easier one to
forget because it looks like bookkeeping rather than a resource.

So the shipped policy is three independent layers, none of which relies
on the caller:

1. **`unref()` on workers and timer** — forgetting everything else can
   no longer hang a process.
2. **Idle timer, armed on drain** — reclaims memory and threads from
   callers who never release.
3. **`releaseWorkers()`** — for callers who want determinism now.

with `keepAlive: false` available for the memory-constrained case that
genuinely wants teardown after every batch.

**`idleTimeoutMs: 0` means never expire** — hold the pool until an
explicit `releaseWorkers()`. That is the right setting for an
interactive application: a photo editor wants the workers spun up, the
LUT already shipped and the kernels already warm *before* the user
touches a slider, because the 66.5 ms spin-up is invisible at load time
and very visible mid-drag. Same for a long-lived server process handling
a stream of requests.

The value is deliberately unambiguous in the docs because it reads both
ways: **0 means "no timeout", not "time out immediately"**. `Infinity`
is accepted as a synonym for callers who find that clearer, and
`keepAlive: false` remains the way to ask for teardown after every
batch. A caller setting `idleTimeoutMs: 0` is opting into holding
~15–20 MB and eight parked threads until they say otherwise, which is a
reasonable trade for interactive latency and a poor one for a CLI that
converts a single file.

**A "release when the Transform closes" watcher cannot be layer 1**, for
the reason measured above: there is no reliable close event in
JavaScript. `FinalizationRegistry` can *log* that it happened, which is
worth having as a diagnostic, but the timer is what actually reclaims.

### Workers are not pinned to cores, and cannot be

A worker is an OS thread with **no CPU affinity**. Windows, Linux and
macOS place it wherever they like and may migrate it between cores
mid-task. Neither `worker_threads` nor the Web Worker API exposes any
way to pin one — that needs a native addon (`SetThreadAffinityMask`,
`sched_setaffinity`), which is exactly why the native C benchmarks in
`bench/lcms_c/` can use `taskset -c 0` and the JS ones cannot.

Three consequences, and they all argue for the design already arrived
at rather than against it:

**Migration costs cache.** A worker moved from one core to another loses
its L1/L2, and everything measured about CLUT residency says that
matters. This is a real part of the jitter that over-decomposition
absorbs, and it cannot be prevented from JavaScript.

**Cores are not equal, and increasingly not even the same kind.** Intel
P/E cores from 12th gen, Apple performance/efficiency cores, ARM
big.LITTLE — a worker landing on an efficiency core may run at a third
the speed of one on a performance core. That is a large, *systematic*
variance the scheduler hands you unasked, on top of the content
variance already measured.

**Which is the strongest argument for the pull-queue.** A static split —
"worker N gets slice N" — is wrong twice over: it assumes equal pixels
cost equal time (they do not) *and* that equal work runs at equal speed
on every core (it does not). A pull-queue needs neither assumption: a
worker parked on an E-core simply pulls fewer tasks, and nobody has to
detect or model that. **Never assume worker N is as fast as worker M** —
with heterogeneous cores it may be permanently three times slower.

**Does SIMD availability vary by core? No — but its *speed* does.**

Availability is uniform by necessity: the scheduler migrates threads
freely, so a thread running an instruction its next core lacks would
fault. The ISA must therefore be homogeneous across cores, and the
clearest proof is Intel's own choice — **AVX-512 was fused off on Alder
Lake P-cores precisely because the E-cores lack it.** They removed it
from the fast cores rather than permit a mismatch. ARM is the same:
NEON is on every core, big or LITTLE. WASM SIMD is 128-bit `v128`
lowering to SSE2/NEON, both universal, and the feature is detected once
at instantiation rather than per core. **A worker cannot land on a core
without SIMD.**

Throughput is another matter, and it likely cuts *against* SIMD. E-cores
have narrower and fewer vector ports — Gracemont has 2×128-bit where
Golden Cove has 3×256-bit — so a vector workload loses more from landing
on an efficiency core than a scalar one does. The core-type variance
should therefore be **wider for the SIMD kernel than for the JS kernel**,
which is the opposite of the intuition that the faster kernel is the
safer one.

Two consequences:

- **The pull-queue already handles it.** A worker on a weak core pulls
  fewer tasks; nothing needs to detect core type. This is the same
  mechanism absorbing content variance, migration and SMT contention,
  which is why it is worth more than any of the individual measurements
  suggested.
- **`autoTune` is exposed to it.** A calibration lasting ~300 ms could
  be scheduled largely onto E-cores and derive a throughput figure for
  the wrong hardware — and unlike a production batch, it has no chance
  to average out. Taking best-of-3 (as `autotune.js` does) mitigates it;
  on a hybrid part the calibration should probably also be re-checked
  once against observed throughput before being trusted, which is what
  the ~2× drift rule already provides.

#### MEASURED — simulating asymmetric cores

The core-type effect can be tested without hybrid hardware: throttle
part of the pool. `--slow-workers 2 --slow-factor 3` makes two of eight
workers busy-wait to three times their true duration — busy-wait rather
than sleep, because a weak core is *executing slowly*, not idle. 2 MP,
`lutMode:'int'`:

| tasks | per worker | homogeneous | 2 of 8 at ⅓ speed |
|---:|---:|---:|---:|
| 8 | 1 | 10.8 ms | **27.4 ms** |
| 16 | 2 | 9.2 ms | 11.2 ms |
| **40** | **5** | **8.1 ms** | **10.7 ms** |
| 80 | 10 | 8.1 ms | 11.6 ms |
| **gain from over-decomposition** | | **25 %** | **61 %** |

**Over-decomposition is worth 2.4× more on asymmetric hardware**, and it
very nearly erases the penalty. Losing two of eight workers to a third
of their speed cuts effective capacity to 6.67/8, a theoretical floor of
**1.20×** — and the queue lands at **1.32×**. One task per worker
instead costs **2.6×**, because the batch cannot finish until the slow
worker completes its single oversized slice and there is nothing left to
overlap it with.

Put plainly: **a pull-queue turns a 3× slow core from a catastrophe into
a rounding error.** No detection, no core-type probing, no affinity —
the slow worker simply asks for less work. This is the clearest
demonstration of why the queue matters more than any of the individual
variance sources that motivated it.

It also sharpens the guidance for hybrid parts. On homogeneous hardware
the sweet spot was ~10 tasks per worker and the penalty for getting it
wrong was 25 %; with asymmetric cores the *same* setting is right but
the penalty for one-per-worker is 2.6×. **The cost of under-decomposing
scales with how uneven the machine is** — which is the argument for
defaulting to over-decomposition rather than tuning per platform.

**Still reasoned, not measured, for real E-cores.** This simulates
uniform slowness; a genuine E-core also differs in cache size, vector
width and clock behaviour, and the SIMD kernel may fare worse than the
JS one for the port-width reason above. An Intel 12th-gen-or-later,
Apple Silicon, or big.LITTLE ARM device is still needed to confirm, and
`autotune.js` there is the obvious first experiment.

**SMT is why `cores: 'auto'` takes ~50 %.** `os.availableParallelism()`
reports *logical* threads, not physical cores — on the 7700X used for
every measurement here it returns **16 for an 8-core part**. Two workers
on the same physical core share execution units and do not add
throughput proportionally, so the 50 % default lands on the physical
core count by construction, which is the number that actually
parallelises.

### One machine, one pool

Per-`Transform` pools are the obvious design and the wrong one: ten
Transforms would mean eighty workers, each with its own WASM instance
and slot buffers — hundreds of megabytes and heavy oversubscription for
what is still **one CPU**. Threads do not become more parallel by being
owned by different objects; they just contend.

So the pool is a **process-level singleton**, not a member of anything:
shared, reference-counted, keyed by `(cores, lutMode)`, with each
`Transform` holding a *lease* rather than a pool. The hardware is the
thing being modelled, and there is only one of it.

Consequences worth stating, because they are easy to get wrong:

- **`releaseWorkers()` drops a lease, it does not kill the pool.** The
  pool goes away on the last lease or on idle timeout. One Transform
  finishing must never strand another mid-batch.
- **Concurrent batches from different Transforms share the queue.** That
  is correct — it is one machine — and it means fairness is a queue
  property, not something each Transform can decide for itself.
- **`cores` is resolved once, by the first lease.** A second Transform
  asking for a different worker count gets the existing pool, not a
  second one; changing it should require the pool to drain. Silently
  honouring both would recreate exactly the oversubscription this
  design exists to avoid.

That raises one real problem: a worker holds a `Transform` rebuilt from
*one* LUT, so a shared pool has to serve several. The existing portable
LUT infrastructure answers it neatly — **LUTs already carry an FNV-1a
content signature**. Ship a LUT to a worker once, keyed by signature;
thereafter tasks reference it by signature alone. A worker keeps a small
LRU of decoded LUTs (376 KB each), and the hand-off cost is paid once
per (worker, LUT) pair rather than per task.

Which makes the signature work do a job it was not designed for, and is
a reason to prefer it over an ad-hoc pool-per-Transform shortcut.

## How lcms does it, and where the batch queue wins

Worth reading the reference implementation before claiming a design is
better. lcms's `threaded` plugin is vendored under
`bench/lcms_c/lcms2-2.18/plugins/threaded/`, and it makes two choices
that differ from everything measured here.

**It splits evenly, one slice per thread** (`threaded_split.c`):

```c
// Each thread takes 128K at least
WorkerCount = (MaxInputMem + MaxOutputMem) / (128 * 1024);
if (WorkerCount < 1) WorkerCount = 1;
else if (WorkerCount > MaxWorkers) WorkerCount = MaxWorkers;   // = CPU count
```

So any image larger than ~128 KB × nCPUs is cut into exactly nCPUs
slices — the configuration measured here at 30–48 % off on homogeneous
hardware and **2.6× off when cores are uneven**. Their 128 KB per-thread
floor is worth noting as independent agreement, though: for RGB→CMYK
that is ~18 K px, and we arrived at 16 K by a different route.

**It creates threads per call and joins before returning**
(`threaded_scheduler.c` — `_cmsThrJoinWorker` in a loop). There is no
persistent pool, and **every image ends with a barrier.**

**And the even split is correct for lcms, not a missed optimisation.**
It is tempting to read "one slice per thread" as dated — the plugin
counts cores with `GetSystemInfo` / `sysconf(_SC_NPROCESSORS_ONLN)`,
raw logical CPUs with no notion of E-cores or SMT siblings, which is
what everyone did before hybrid parts, and there is still no portable C
way to tell them apart. But the real reason is structural.

lcms creates **one thread per slice, per call** (`_cmsThrCreateWorker`
in a loop over `nSlices`, then joins). There is no persistent pool. That
inverts the economics of over-decomposition entirely:

| | jsCE (persistent pool) | lcms (thread per slice) |
|---|---|---|
| cost of one more task | a queue pull, ~7 µs | a **thread creation**, tens of µs |
| 80 tasks on 8 workers | 8 threads, 80 pulls | **80 threads** |

Over-decomposition is only cheap if there is a pool to pull from. For
lcms, cutting into ten times the cores would mean ten times the thread
spawns *per image* — several milliseconds of pure overhead. Given
thread-per-slice, an even split capped at core count is the right
answer.

Which makes our advantage partly accidental: **JS workers are so
expensive to spawn (~8 ms, measured) that a persistent pool was never
optional** — and the pool is precisely what makes over-decomposition
free. The constraint forced the better architecture. Worth remembering
before treating the difference as a like-for-like design win.

The remaining choices are reasonable for what lcms is: a library whose
API is "convert this buffer", called once per image, in C. Neither is a
mistake in context. But both are avoidable when the API accepts a
*batch*.

### MEASURED — what the per-image barrier costs

`bench/multicore_poc/batch_barrier.js`, identical work either way:
**BARRIER** plans, dispatches and joins each image in turn; **MERGED**
puts every image's tasks in one queue with no image boundaries. 8
workers, `lutMode:'int'`:

| batch | barrier | merged | merged faster by |
|---|---:|---:|---:|
| 20 × 0.1 MP | 11.66 ms | 7.27 ms | **37.6 %** |
| 7 × mixed, 0.15–8.4 MP | 63.33 ms | 59.53 ms | 6.0 % |
| 4 × 2 MP | 32.90 ms | 30.62 ms | 6.9 % |

**The gap tracks how badly each image fills the pool.** A 0.1 MP image
produces about seven tasks for eight workers, so a barrier leaves a
worker idle for the whole image and repeats that twenty times — 37.6 %
of the run. Large images produce enough tasks to keep everyone busy, so
the barrier only costs the ragged tail of each one, and merging buys the
~6–7 % that tail is worth.

Which makes the batch API a genuine structural advantage rather than
API sugar:

- **A worker finishing image 1 starts on image 3 immediately.** There is
  nothing to wait for, because the queue has no image boundaries in it.
- **Small images stop being a problem.** Individually they cannot fill a
  pool; collectively they always can. This is the case a per-image
  threading model cannot fix from inside, no matter how well it splits.
- **Sorting across the whole batch actually helps here.** Within a
  single image the LPT sort sees equal-length slices and contributes
  nothing; across a mixed batch the lengths genuinely differ, so the big
  slices go first and the small ones backfill the tail. It is the same
  sort doing real work only once it can see more than one image.

The honest limit: on a batch of uniformly large images the advantage is
~6 %, because a barrier costs little when every image saturates the pool
on its own. The 37 % case is a batch of thumbnails, which is also a very
common workload — contact sheets, web pipelines, catalogue processing.

## AS BUILT (v1.5.5) — what a worker can and cannot rebuild

A worker needs its own `Transform`. How it gets one decides which
workloads can be parallelised at all, and there are two possible
hand-offs.

### Mode 1 — ship the LUT (implemented)

`postMessage` the LUT object, `setLut()` it in the worker. Cheap, one
transfer per (worker, LUT) pair keyed by FNV signature, and no profiles
or ICC parsing in the worker.

**But not every Transform can be rebuilt from its LUT alone.** N-channel
output walks the pipeline rather than a LUT kernel, and a LUT-only
rebuild diverges badly — measured on a 7-channel profile: **27,204 wrong
bytes in 35,000, max delta 254.** Not rounding; different colour.

Rather than maintain a list of which shapes are safe — which rots the
moment a new path is added — the engine **proves it on a 256-pixel probe
the first time a Transform is used with `multicore`**, comparing the
rebuild byte-for-byte against the original. Equal, and the pool is used;
unequal or throwing, and it silently runs sequentially. Fails closed,
and costs a few hundred pixels once per Transform.

Two things that probe taught, both now guarded:

- **`setLut()` mutates the LUT it is given** — it decodes the CLUT in
  place. Handing it the live LUT corrupted the Transform being probed
  and every later conversion with it. The probe clones first
  (`structuredClone`); the worker path was never affected, since
  `postMessage` clones on the way out.
- **JSON is the wrong wire format here.** `toJSON()`/`fromJSON()` is the
  *portable* format and quantises: sequential-vs-sequential through it
  differs on 123 of 200,000 bytes by 1 LSB. Sending the LUT object
  itself keeps the typed arrays exact, which is what makes
  byte-identity achievable rather than merely "close".

### Mode 2 — ship the profiles (not built, but cheaper than it looks)

Send the ICC bytes and the chain, and let each worker run `create()`.
The obvious objection is cost — and measured, there is almost none:

| step | cost |
|---|---:|
| profile bytes on the wire | 2,684 KB |
| profile parse | 12.3 ms |
| **`create()` with `buildLut: false`** | **0.08 ms** |
| `create()` with `buildLut: true` | 7.0 ms |

**Building a pipeline without a LUT is essentially free** — no bake, no
heavy maths, and deterministic, so every worker independently builds the
identical thing. The whole per-worker cost is the profile parse, ~12.4 ms
including the build, and those run in parallel across workers. That is
*less than the 66.5 ms pool spin-up already being paid*.

Which makes Mode 2 reach everything Mode 1 cannot, for no meaningful
extra cost:

- **The LUT-free accuracy path** (`buildLut: false`) runs at ~5–9
  MPx/s. A 20 MP image is ~3 seconds single-threaded, so this is where
  8× is worth most — and there is no LUT to ship, so Mode 1 cannot serve
  it at all.
- **N-channel and anything else pipeline-driven**, with no probe needed.
- **No equivalence question whatsoever.** The worker runs the same
  `create()` on the same bytes and gets the same Transform by
  construction. Nothing to prove, nothing to fail closed on.

**The chain alone is not enough.** `lut.chain` is a *descriptor* —
header, name, whitePoint, description — and serialises to about **2.0 KB
against a 2,684 KB profile**. It records which profiles were used, not
what they contain.

**And there are no raw bytes to send.** `Profile` decodes the ICC file
and discards the source — after `loadFile()` there is not a single
binary property left on it. So "ship the profile bytes" is not available
without making the caller retain them.

The decoded `Profile` object itself is the answer, and it is better than
bytes: **42 plain properties, no functions, structured-cloneable as-is.**
Cloning drops the prototype, so the worker must restore it — after which
it behaves as a Profile and builds an identical Transform:

```js
// worker side
Object.setPrototypeOf(clonedProfile, Profile.prototype);
```

Measured: a Transform built from a cloned Profile is **byte-identical**
to one built from the original. That removes the 12.3 ms parse from the
per-worker cost entirely — the worker receives an already-decoded
profile. It costs more on the wire (~3.90 MB decoded against 2.62 MB of
ICC) but the wire is a same-process structured clone, not a network.

So the Mode 2 payload is:

```js
{ profiles: { '<hash>': <cloned Profile>, … },   // once per worker
  chain:    ['*sRGB', intent, '<hash>', intent, '*sRGB'],
  options:  { …non-function options… } }
```

Virtual profiles cost nothing — `'*sRGB'` is synthesised from its name —
so a soft-proof chain of `sRGB → GRACoL → sRGB` ships one profile, not
three, and the content-hash trick already used for LUTs applies:
send each distinct profile once per worker, reference it by hash after.

**The options must travel too, and four of them cannot.** `create()`
depends on 37 constructor options, and the Transform already keeps
`_originalOptions` for forwarding. But `gamutDeFn`, `lutInputHook`,
`lutOutputHook` — and any **custom stages** passed to `create()` /
`createMultiStage()` — are *functions*, and `structuredClone` throws
outright on those (`DataCloneError`).

**This is what stops Mode 2 replacing Mode 1**, and it is the reverse of
what the cost measurements suggested:

| | Mode 1 (LUT) | Mode 2 (profiles) |
|---|---|---|
| custom stages, hooks, custom ΔE | ✅ **already baked into the LUT** | ❌ cannot cross the wire |
| N-channel / pipeline-driven paths | ❌ diverges, caught by the probe | ✅ exact by construction |
| LUT-free accuracy path | ❌ nothing to ship | ✅ the main prize |
| a Transform restored from a portable LUT | ✅ | ❌ no profiles exist |

They are **complementary, not ranked.** A custom stage is baked into the
LUT at build time, so Mode 1 carries it for free and Mode 2 would
silently drop it — which is the worst possible failure, since the output
would look plausible. The selection rule follows:

1. LUT present **and** the probe passes → **Mode 1** (cheapest, and the
   only mode that carries baked functions).
2. Otherwise, profiles available **and** no function-valued options →
   **Mode 2**.
3. Otherwise → **sequential**, which is always correct.

**Multi-step needs no special handling in Mode 1**, which is worth
stating because it looks like it should. A five-slot soft-proof chain
bakes to a 3→3 LUT, so a worker never sees the chain at all — measured
byte-identical on 8 workers, and now asserted in the tests. Mode 2 is
the only mode that has to care about chains, because it rebuilds rather
than inherits.

Earlier in this document I concluded from the cost measurements that
Mode 2 should become the primary hand-off. The function-valued options
above correct that: neither mode dominates, and the selection rule is
the conclusion instead. The probe stays a correctness guard for Mode 1
rather than becoming a routing hint.

### A pool serving several transforms at once (future)

Once workers hold a registry keyed by signature — which Mode 1 already
does — nothing requires every task in flight to use the *same*
transform. A pool of 8 could run RGB→CMYK on some workers and CMYK→RGB
on others, which is the natural shape for a pipeline stage converting in
both directions, or a server handling mixed requests.

What that needs beyond today's code:

- **A per-transform concurrency cap**, so one large job cannot starve
  the others — "at most N workers on any one transform" rather than
  first-come-first-served on a single queue.
- **Fair queueing across transforms**, since the current queue is one
  flat LPT-sorted list and would drain the largest job first regardless
  of who is waiting.
- **Registry pressure**: each worker would hold several LUTs
  concurrently rather than sequentially, so the LRU bound (currently 8)
  becomes load-bearing rather than a safety net.

None of it is hard, and none of it is justified until someone has the
workload. Recorded so the registry-by-signature design is understood as
*enabling* it rather than accidental.

### Mode 3 — clone the pipeline (rejected)

The apparently-direct option: serialise the built pipeline and send it,
skipping both the LUT and the profiles. It does not work, and it is
worth saying why before someone tries it.

- **Stages are functions.** `structuredClone` and `postMessage` throw on
  functions outright, so the pipeline cannot cross a thread boundary as
  it stands.
- **`stageData` holds references into decoded profile internals** —
  matrices, curves, CLUTs, tag data. To serialise it you would end up
  shipping the profile contents anyway, just in a bespoke,
  version-fragile form instead of the ICC bytes you already have.
- **You would be re-implementing `create()` on the far side**, without
  its validation, and it would need maintaining in lockstep with every
  new stage type added.

Mode 2 gets the same result by sending the bytes we already hold and
calling the function that already exists. Cloning a pipeline is more
work, more fragile, and correct only until the next stage type lands.

The probe stays useful either way: it is what decides which mode a given
Transform qualifies for.

## The unified dispatcher — one queue, one task shape

The two modes above should not be two implementations. Make the task
uniform:

```js
{ imageIndex, start, length }      // a whole image is just start=0, length=all
```

and the worker never knows which mode it is in. The split/whole
distinction lives **only in the planner**, which means this design
*removes* a code path rather than adding one — the reason it is simpler
than it sounds, not more complex.

The planner is pure, synchronous, and runs once per batch:

```js
function plan(images, workers, capacity = 262144, minSlice = 16384) {
    const tasks = [];
    for (let i = 0; i < images.length; i++) {
        const px = images[i].pixelCount;
        // MEASURED: one task per worker is the WORST configuration -- a slow
        // task lands last with nothing to overlap it, costing 30-48%. Aim for
        // ~10 tasks per worker instead, clamped by what a worker's buffer can
        // hold and by a floor that keeps per-task overhead under ~1%.
        // See "The buffer is a ceiling, not a quantum".
        const wanted = Math.ceil(px / (workers * 10));
        const per = Math.ceil(Math.min(capacity, Math.max(minSlice, wanted)) / 64) * 64;
        for (let start = 0; start < px; start += per) {
            tasks.push({ imageIndex: i, start, length: Math.min(per, px - start) });
        }
    }
    // longest-processing-time-first: dispatch big tasks early so the tail
    // does not end with one long task and idle workers
    return tasks.sort((a, b) => b.length - a.length);
}
```

That is the whole "smart" part — a pure function, trivially unit
testable, no async, no I/O. Glenn's 128 K example falls straight out:
`floor(131072 / 65536) = 2`, so it takes two workers and leaves the
other two for the next image in the batch.

The LPT sort is worth the one line. Without it a long task can be
dispatched last and every other worker sits idle waiting for it; it is
the standard makespan heuristic and costs nothing at this scale.

**Where to stop.** Plan once, flat queue, workers pull the next task
when they finish. Do *not* add dynamic re-planning, cost models, or
cross-image work stealing beyond the queue pull — none of it is
justified by anything measured, and each would make the scheduler
harder to reason about than the kernels it is feeding.

Two things the planner still owns:

- **Reassembly.** Each task carries `imageIndex` and `start`, so a
  finished slice knows exactly where to write. Whole-image tasks use the
  same path with `start = 0`.
- **In-flight memory.** Cap resident images at roughly `workers + 1`
  rather than materialising a whole batch, so a 200-file job does not
  need 200 images in memory at once.

Public shape, then, is one call that covers both cases:

```js
await pool.transformImages([img1, img2, ...]);   // 1..n, planner decides
```

### Allocation: dynamic slices vs fixed slots — measure both

The planner above sizes each slice from the image: *slice size varies,
slice count is capped at the worker count*. There is an alternative that
inverts it — **fix the slice size, let the count vary** — and it is
probably the better engineering choice even if it is not the faster one.

**The problem with dynamic slices is the buffer sizing, not the maths.**
A worker's WASM memory is laid out `[LUT][input][output]`. If slice size
depends on the image, the worker cannot know how much memory it needs
until work arrives, so it either allocates for the worst case, or grows
and shrinks per task. Growing is a `Memory.grow()` plus re-instantiation;
shrinking is impossible (there is no `Memory.shrink()`), which is why
`compactIfNeeded` exists at all. Across a batch of mixed image sizes
that is continuous churn, and churn is exactly what makes a UI feel
choppy even when average throughput looks fine.

**Fixed slots remove the question.** Pick a chunk size once at pool
startup. Every worker allocates `[LUT][chunk_in][chunk_out]` exactly
once and never resizes. Work is cut into chunk-sized pieces: a 20 MP
image becomes many tasks, a 300 KB thumbnail becomes one, and a batch of
four small images is four tasks that happen to fit in one chunk each.
Nothing about the worker changes between tasks except `start` and
`length`.

What that buys, concretely:

- **No `Memory.grow()`, no re-instantiation, no `compactIfNeeded` in the
  hot path.** The reclaim problem that Model B could not solve simply
  does not arise, because nothing ever needs reclaiming.
- **Zero per-task allocation.** With transfer, the worker receives a
  fresh `ArrayBuffer` per task and drops it after — that is the garbage.
  Copying into a stable buffer instead trades one memcpy for no
  allocation at all. Given the copies were measured at **4–7 % of a
  pass**, that is a cheap trade for smoothness.
- **Better load balance, not worse.** Uniform task size means the
  makespan tail is bounded by one chunk. Variable slices can leave one
  worker holding a task several times longer than everything else, which
  is the case LPT sorting exists to mitigate.
- **Reassembly is unchanged.** Each task already carries `imageIndex`
  and `start`, so finished chunks copy into the destination in whatever
  order they complete. Fixed slots do not make this harder; if anything
  the destination arithmetic becomes trivial.

**The cost is resident memory, and it is the thing to size carefully.**
Per worker it is roughly `chunk_in + chunk_out`, times the worker count:

| chunk | pixels (RGB8) | ≈ per worker (RGB→CMYK) | × 16 workers |
|---|---:|---:|---:|
| 256 KB | 87 K px | ~0.6 MB | ~10 MB |
| 1 MB | 350 K px | ~2.3 MB | ~37 MB |
| 5 MB | 1.7 M px | ~12 MB | ~190 MB |

**5 MB is likely larger than it needs to be.** The measured floor for
splitting to pay at all is ~64 K px per worker — about 192 KB of RGB —
so a 512 KB–1 MB chunk already clears it by 5–10× while keeping a
16-worker pool under 40 MB. 190 MB resident in a browser tab is a real
cost to accept without evidence. Screen-resolution sizing (1920×1080 ≈
2.07 MP ≈ 6.2 MB) lands in the same expensive bracket.

### MEASURED — per-task overhead, and the planner is wrong

`bench/multicore_poc/task_overhead.js`. 8 MP through 4 workers,
sRGB→GRACoL, `lutMode:'int'`, best of 7. Total pixels and worker count
held constant; only the number of tasks the work is cut into varies, so
any rise is per-task cost and nothing else.

| tasks | px/task | uniform | ragged (incl. a 3-px task) |
|---:|---:|---:|---:|
| 4 | 2 M | 72.3 ms | 97.8 ms |
| 8 | 1 M | 52.1 ms | 62.4 ms |
| **16** | **524 K** | **50.6 ms** | **51.8 ms** |
| 64 | 131 K | 53.7 ms | 51.3 ms |
| 256 | 32 K | 52.5 ms | 51.6 ms |
| 1024 | 8 K | 58.5 ms | 55.7 ms |
| 2048 | 4 K | 67.2 ms | 66.5 ms |

**Per-task overhead is ~7–8 µs.** From the plateau to 2048 tasks costs
15–17 ms across ~2030 extra tasks, both splits agreeing. So a task
should carry at least ~50 K px to keep overhead under ~1 %, and the flat
region runs from roughly **32 K to 524 K px per task**.

Three results, in increasing order of how much they change the design:

**1. The 3-pixel task is a non-issue.** At ~7 µs it is 0.013 % of a
52 ms pass. Ragged splits — deliberately uneven, always including a
3-pixel remainder — are *within noise of uniform ones* from 16 tasks
upward. A "run slices under N pixels on the main thread" rule would be
buying nothing measurable, and would add a branch, a threshold to tune
and a second code path to the exact place that must stay simple. It was
right to call it premature; the measurement agrees.

**2. Raggedness only hurts when there are too few tasks.** At 4 and 8
tasks ragged costs 35 % and 20 % over uniform, because one long task
lands at the end with nothing to overlap it. By 16 tasks the LPT sort
absorbs the unevenness completely. Uniformity is not what matters —
*having enough tasks to schedule* is.

**3. The current planner produces the worst configuration measured.**
It caps slices at the worker count:

```js
const slices = Math.max(1, Math.min(Math.floor(px / minSlice), workers));
```

One task per worker is exactly the 4-task row: **72.3 ms uniform, 97.8 ms
ragged, against ~51 ms at 16 tasks.** That is a 30–48 % penalty for the
tidiest-looking split, because a single slow task has nothing left to
overlap with. **Over-decompose instead** — aim for several times the
worker count and let the queue balance it:

```js
// target ~4-8 tasks per worker, each at least minSlice
const target = Math.max(1, Math.floor(px / minSlice));
const slices = Math.min(target, workers * 6);
```

This is also the strongest argument *for* fixed slots, and it arrives
from a direction nobody was looking: fixed chunks over-decompose
naturally. A 20 MP image at 256 K px/chunk is 80 tasks whatever the
worker count, which lands in the flat region by construction, with no
planner heuristic to get wrong.

**So the chunk size should be ~128–256 K px, not 5 MB.** That is
384–768 KB of RGB, comfortably inside the flat region, and it puts a
16-worker pool at **~28 MB resident** rather than ~190 MB. The earlier
5 MB estimate was ~10× too large, and the cost of getting it wrong is
paid in memory rather than speed — which is the easier mistake to miss.

### Why more tasks helps — it is scheduling, not caching

"Smaller pieces run faster" is counter-intuitive enough to deserve a
control, and the obvious explanation is wrong. The tempting story is
memory: many small slices ought to be kinder to cache than a few large
ones. Two candidate mechanisms, and they make different predictions:

- **load balancing** — more tasks means the queue can even out jitter,
  which requires *more than one worker* to matter at all;
- **per-task working set** — a 22 K px task is ~65 KB in + 87 KB out +
  280 KB CLUT and fits L2, where a 262 K px task is ~2 MB and spills.
  This would show up with **one** worker just as clearly.

So run it with one worker, where there is nothing to balance. 2 MP:

| tasks | px/task | best ms | vs 1 task |
|---:|---:|---:|---:|
| 1 | 2 M | 46.4 | — |
| 8 | 262 K | 48.0 | +3.4 % |
| 32 | 66 K | 46.2 | −0.5 % |
| 96 | 22 K | 49.5 | +6.7 % |
| 192 | 11 K | 54.1 | +16.6 % |

**Flat to slightly worse — never better.** The working-set explanation is
dead. All of the 30 % gain at 8 workers is scheduling: with one task per
worker the batch ends when the *slowest* worker ends, and any jitter —
OS scheduling, SMT contention, the main thread busy copying — leaves
every other worker idle. At ten tasks per worker the fast ones pull more
and the tail shrinks to at most one task.

**Why slice size cannot help cache here:** the kernel is a pure
streaming workload. Every pixel is read once, written once, never
revisited, so the image never benefits from residency at any slice size.
The only structure with reuse is the CLUT, and it is the same ~280 KB
however the image is cut. This is the same lesson as the content work —
CLUT residency is what matters, and the image is just a stream passing
through.

### Equal pixels are not equal work — and LPT cannot see it

There is a second reason to over-decompose, and it comes straight out of
the content work in [benchmark.md §§20–21](./benchmark.md#21-noise-is-the-great-equaliser):
**the same kernel runs anywhere from ~100 to ~270 MPx/s depending on how
much of the CLUT the pixels touch.** A real frame is not uniform. Flat
sky converts fast, dense foliage converts slowly. So two slices of
*identical pixel count* can take substantially different times, and a
scheduler that treats size as a proxy for cost is wrong about every real
image.

Measured with content deliberately split down the middle — first half
flat colour, second half noise, equal pixels, very unequal cost. 2 MP,
8 workers:

| tasks | per worker | uniform noise | mixed content |
|---:|---:|---:|---:|
| 8 | 1 | 10.8 ms | 9.5 ms |
| **16** | **2** | 9.7 ms | **7.2 ms** |
| 24 | 3 | 8.4 ms | 7.3 ms |
| 96 | 12 | 7.6 ms | 7.4 ms |
| 192 | 24 | 8.3 ms | 7.5 ms |

**One task per worker is the worst case for both, and for different
reasons.** With uniform content the only imbalance is random jitter, so
it takes deep over-decomposition — around twelve tasks per worker — for
the queue to average it out. With mixed content the imbalance is
*systematic*: half the tasks are simply slower. Two tasks per worker is
enough to fix that, because each worker ends up with roughly one of
each.

Which yields a useful split:

- **Systematic cost variance (content)** — cured by modest
  over-decomposition, 2–4 tasks per worker.
- **Random jitter (OS scheduling, SMT, the main thread copying)** —
  needs 8–12 tasks per worker to average out.

Both point the same way, so the ~10-per-worker target covers both, but
the deeper figure is driven by jitter rather than content.

**The sharper consequence is for the LPT sort.** Longest-processing-time
scheduling orders tasks by *length*, which is only a proxy for cost —
and content is exactly what breaks the proxy. In the mixed run every
task is the same length, so the sort has nothing to work with and
contributes nothing; all the balancing comes from having enough tasks
in the queue. Fixing that properly would mean *estimating* cost per
slice, which means inspecting content before scheduling. Not worth it:
over-decomposition solves the same problem for free, and a cost model
that has to sample pixels to predict CLUT locality would be both
expensive and easy to get wrong. **Keep the LPT sort — it helps when
lengths genuinely differ, as in a mixed batch of image sizes — but do
not rely on it to balance a single image.**

**Per-task overhead is partly hidden by parallelism.** The same sweep
measures ~33 µs per task at 1 worker and ~7–8 µs at 4. Nothing about the
messages changed; with several workers the main thread copies for one
while another computes, so most of the cost overlaps with compute.
Quoting a single overhead figure is therefore wrong — it is ~33 µs
serialised and ~7–8 µs effective once the pool is deep enough to hide
it, and only the second number should inform the chunk size.

### The floor is a time, not a pixel count

Every figure above came from the JS `int` kernel. The WASM SIMD kernel
is roughly twice as fast per pixel, so the same ~7–8 µs of per-task
overhead buys proportionally less work — and the optimum moves. Same
2 MP, same 8 workers:

| tasks | per worker | px/task | jsCE `int` | WASM SIMD |
|---:|---:|---:|---:|---:|
| 8 | 1 | 262 K | 10.8 ms | 4.5 ms |
| **48** | **6** | **44 K** | 8.5 ms | **4.1 ms** |
| **96** | **12** | **22 K** | **7.6 ms** | 5.4 ms |
| 384 | 48 | 5.5 K | — | 6.3 ms |

**A fixed pixel floor would be wrong for one of them.** SIMD wants ~6
tasks per worker at ~44 K px; the JS kernel wants ~12 at ~22 K. Push
SIMD to 12 per worker and it *loses* 30 %.

The two agree once the floor is expressed as **time rather than
pixels**: a task should run for roughly **10× its own overhead**, i.e.
~80 µs of compute. Converting through the kernel's known throughput
reproduces both optima:

| kernel | throughput | 80 µs of work | measured optimum |
|---|---:|---:|---:|
| WASM SIMD | ~500 MPx/s | 40 K px | 44 K px |
| jsCE `int` | ~270 MPx/s | 22 K px | 22 K px |

That is the general form, and it self-adjusts to any future kernel
without a new constant to tune. It also explains why over-decomposition
pays far less for SIMD (9 % vs 30 %): the whole pass is only ~4 ms, so
there is less absolute jitter to hide and overhead bites sooner.

### The buffer is a ceiling, not a quantum

Fixed chunks over-decompose large images automatically, which is their
main virtue. They do the opposite on small ones: a 2 MP image at 256 K
px/chunk is 8 tasks, so on an 8-worker pool every worker gets exactly
one — the configuration already shown to be the worst. Cutting *only* at
chunk boundaries reintroduces the problem the chunk size was meant to
avoid.

Measured, 2 MP through **8** workers:

| tasks | per worker | px/task | best ms | MPx/s |
|---:|---:|---:|---:|---:|
| 8 | 1 | 262 K | 10.8 | 194.5 |
| 16 | 2 | 131 K | 9.7 | 217.0 |
| 24 | 3 | 87 K | 8.4 | 249.7 |
| **96** | **12** | **22 K** | **7.6** | **275.9** |
| 192 | 24 | 11 K | 8.3 | 252.9 |

**One task per worker costs 30 %** against ~12 tasks per worker. Note
also that the best slice here is 22 K px — *below* the 32 K figure the
4-worker sweep suggested. The useful task size is not a constant: it
falls as worker count rises, because balancing needs more pieces.

The fix is to treat the fixed buffer as **maximum capacity, not a unit
of work**. A worker's buffer never has to be full, so pick the slice
length from the image and the pool, then clamp it to what the buffer can
hold:

```js
// K ~ 8-12 measured; minSlice keeps per-task overhead under ~1%
function sliceLength(px, workers, chunkCapacity, K = 10, minSlice = 16384) {
    const wanted = Math.ceil(px / (workers * K));
    return Math.min(chunkCapacity, Math.max(minSlice, wanted));
}
```

Which behaves correctly across the range:

| image | slice chosen | tasks (8 workers) | why |
|---|---|---:|---|
| 20 MP | 250 K → capped at 256 K | 80 | capacity binds; over-decomposed anyway |
| 2 MP | 26 K | 80 | pool binds; spreads across all workers |
| 500 K px | 16 K (floor) | 31 | floor binds; overhead stays under 1 % |
| 100 K px | 16 K (floor) | 6 | below the parallel floor entirely — run it on the calling thread |

This keeps every benefit of fixed allocation — buffers sized once, never
grown, never reclaimed — while removing the only case where fixed chunks
lose to dynamic slicing. The planner stays a pure function of
`(px, workers, capacity)`, with no image inspection and nothing to tune
per workload.

**The grow-only variant** is worth including as a third arm: start each
worker small, let its buffer grow to the high-water mark, never shrink,
and expose a manual `pool.reset()` for a caller who knows the batch is
finished. That keeps allocation bounded and amortised without fixing a
size up front — slightly more complex than fixed slots, considerably
simpler than grow-and-shrink.

**What the experiment should measure.** Peak MPx/s is the least
interesting output here, and may well be identical across all three
arms. The motivation is smoothness, so the comparison must report
**distribution, not mean**: per-task latency p50/p95/p99, worst-case
frame time, GC pause count and total pause time, and peak RSS. A design
that is 3 % slower on average and has no 40 ms stalls is the better one
for anything driving a canvas.

| arm | slice size | worker buffer | expected trade |
|---|---|---|---|
| A — dynamic slices *(currently specified)* | `px / slices` | grows and shrinks | best average, worst jitter |
| B — fixed slots | constant | allocated once | small constant copy, no churn |
| C — grow-only + manual reset | constant | grows to high-water | between A and B |

All three share the same task shape `{imageIndex, start, length}` and the
same planner interface, so this is a swap inside `plan()` plus the
worker's allocation policy — not three implementations.

### The zero-worker fallback is the same call

Workers are not always available: `worker_threads` may be absent or
blocked, a browser may refuse to construct one under a restrictive CSP,
`cores: 1` may be set deliberately, or the planner may decide the job is
too small to be worth splitting. In every one of those cases the answer
is the same — **run the images sequentially through `transformArray()`
and return the identical result.**

```js
if (!pool.workerCount) {
    for (const image of images) {
        transform.transformArray(image.data, false, false, false, image.pixelCount);
    }
    return images;
}
```

This is what keeps multicore an *optimisation* rather than a
capability. Three consequences worth stating, because they are the
reason to design it in from the start rather than bolt it on:

- **`transformImages()` is always callable.** No feature detection at
  the call site, no second code path in the host application, no
  "multicore build" of the library. Availability is the pool's problem.
- **The fallback is the correctness oracle.** Sequential
  `transformArray()` is already the tested path, so
  "parallel output must equal sequential output byte-for-byte" is a test
  that writes itself — which is exactly how the POC was verified.
- **The planner already produces it.** A plan of one task per image with
  `start = 0` *is* the sequential run. The fallback is not a separate
  implementation; it is the same queue drained on the calling thread.

The one thing the fallback must not do is pretend: `transformImages()`
should report the worker count it actually used, so a caller measuring
throughput is never silently told a single-threaded run was parallel.

### What this leaves open

Model B, the imported-memory change and the reclaim rework are all
**deferred indefinitely** unless the 4–7 % copy cost turns out to matter
for some workload. The remaining questions are: browser behaviour
(slower spin-up, no COOP/COEP needed for Model A), whether the WASM SIMD
kernels scale the same way, and where the one-shot (unpooled) threshold
sits once worker spin-up is counted.

## MEASURED — the shipped pool, across content, workers and kernels

> **The live numbers are generated**, from the same bench, into
> [`pool.peak`](../BenchResults.md#table-pool-peak) and
> [`pool.scaling`](../BenchResults.md#table-pool-scaling). The tables in this
> section are the run the analysis was written against. Two things changed
> after it: the sequential baseline now reuses its output buffer (it was
> allocating a multi-megabyte array per iteration, which left a 25 % run-to-run
> spread in the denominator of every speedup here), and the peak now reads
> ~6.2x rather than 6.53x. **The absolute MPx/s barely moved** — which is the
> lesson: quote the throughput, not the ratio.

`bench/multicore_matrix/run.js`, 4 MPx sRGB→GRACoL2006, int8, median of 5,
**one process per cell** (`--isolate`). Ryzen 7 7700X, 8 physical / 16 logical,
Node 24. Raw rows in `bench/results/multicore_matrix.json`.

Three axes, because each has been wrong before: content (a LUT transform is not
fixed-cost per pixel), worker count including odd values (the pull queue is
supposed not to care), and kernel (a faster kernel makes each fragment cheaper,
which raises the relative cost of per-task overhead).

**The baseline is the same Transform running sequentially through
`transformArray()`, not the 1-worker pool.** One worker still pays copy and
message costs — it measures 0.76–0.88× of sequential — so calling it "1×" would
flatter every other column.

### Results

Median of 5 isolated runs, after the scratch-buffer change described in "Where
the variance actually lives". Peaks rose 13-67% against the same harness before
that change, so any figure quoted from an earlier draft of this document is low.

| content / kernel | sequential | peak | speedup | @ workers |
|---|---:|---:|---:|---:|
| solid / int | 56.7 | 340.9 | **6.01x** | 8 |
| noise / int | 45.3 | 295.4 | **6.53x** | 8 |
| photo / int | 48.8 | 305.3 | **6.26x** | 8 |
| solid / int-wasm-scalar | 83.0 | 455.6 | **5.49x** | 8 |
| noise / int-wasm-scalar | 60.5 | 330.8 | **5.47x** | 8 |
| photo / int-wasm-scalar | 67.4 | 383.1 | **5.68x** | 8 |
| solid / int-wasm-simd | 179.4 | 819.1 | **4.57x** | 8 |
| noise / int-wasm-simd | 100.2 | 564.5 | **5.63x** | 8 |
| photo / int-wasm-simd | 117.8 | 624.5 | **5.30x** | 8 |

MPx/s. **Every one of the 72 cells was byte-identical to sequential output** —
a speedup that does not produce identical bytes is not a speedup, so the
harness checks rather than assumes.

### Scaling from 1 to 8 workers

Median of 5 isolated matrix runs, each itself a median of 5.

| cell | seq | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | peak |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| solid/int | 56.7 | 0.93 | 1.84 | 2.66 | 3.49 | 4.22 | 4.89 | 5.15 | **6.01** | 6.01x @8 |
| noise/int | 45.3 | 0.97 | 1.86 | 2.73 | 4.04 | 4.82 | 5.43 | 5.86 | **6.53** | 6.53x @8 |
| photo/int | 48.8 | 0.96 | 1.86 | 2.97 | 3.87 | 4.97 | 5.68 | 6.16 | **6.26** | 6.26x @8 |
| solid/wasm-scalar | 83.0 | 0.94 | 1.84 | 2.62 | 3.52 | 4.08 | 4.62 | 4.64 | **5.49** | 5.49x @8 |
| noise/wasm-scalar | 60.5 | 0.95 | 1.87 | 2.69 | 3.56 | 4.28 | 4.85 | 5.41 | **5.47** | 5.47x @8 |
| photo/wasm-scalar | 67.4 | 0.95 | 1.83 | 2.61 | 3.42 | 4.14 | 4.84 | 5.40 | **5.68** | 5.68x @8 |
| solid/wasm-simd | 179.4 | 0.91 | 1.76 | 2.50 | 3.25 | 3.75 | 4.23 | 4.52 | **4.57** | 4.57x @8 |
| noise/wasm-simd | 100.2 | 0.95 | 1.85 | 2.67 | 3.47 | 4.18 | 4.69 | 5.21 | **5.63** | 5.63x @8 |
| photo/wasm-simd | 117.8 | 0.93 | 1.80 | 2.57 | 3.37 | 4.01 | 4.50 | 4.79 | **5.30** | 5.30x @8 |

**One worker is always SLOWER than sequential** — 0.75× to 0.92×. That is the
cost of copying a fragment out and the result back, with none of the benefit,
and it is worst on the fastest kernel (SIMD, 0.75×) because the copy is a
larger share of a cheaper conversion. It is also why the baseline for every
figure here is sequential rather than the 1-worker pool: calling that "1.0x"
would silently credit the pool with recovering its own overhead.

**Efficiency falls as workers are added, and falls fastest on the fastest
kernel.** At 8 workers it ranges from 71% (noise/int) down to 32%
(solid/wasm-simd). Same cause: a faster kernel makes each fragment cheaper, so
the fixed per-fragment cost is a larger share of it, and the shared memory
bandwidth is reached sooner.

### A ceiling that turned out to be the feed, not the bus

The first run of this measurement had every SIMD row peaking at 6 or 7 workers
and falling back at 8, which reads as memory bandwidth saturating before the
cores do. One cell was statistically significant (solid/wasm-simd, -6.8%,
CI [-10.9, -2.7]) and all three pointed the same way.

**It was orchestration, not bandwidth.** Once per-fragment allocation came out
(next section), every cell peaks at 8 workers and solid/wasm-simd moved from
2.75x @6 to 4.57x @8. The main thread could not feed eight workers while
allocating two buffers per fragment; the eighth worker made the feed worse
faster than it added compute.

What survives is smaller and real: per-worker throughput still declines as
workers are added, measured after the fix on int-wasm-simd —

| workers | per-worker MPx/s |
|---:|---|
| 2 | 100, 102 |
| 4 | 96, 97, 99, 100 |
| 6 | 92, 94, 95, 95, 96, 97 |
| 8 | 79, 80, 80, 81, 82, 82, 83, 84 |

— about 20% from 2 workers to 8, evenly across all of them, which is a shared
resource (L3 and memory bandwidth) rather than uneven scheduling. But it no
longer outweighs the extra core, so 8 is the right default on this part.

Worth carrying forward: **a plausible mechanism and a significant p-value are
not the same as a cause.** Bandwidth explained the data perfectly well, and
what settled it was fixing something else entirely and watching the effect
disappear.

### The finding that matters: speedup is inverse to kernel speed

| kernel | sequential | speedup range |
|---|---:|---|
| int (JS) | 45–57 | **5.33–5.97×** |
| int-wasm-scalar | 60–83 | 4.58–5.09× |
| int-wasm-simd | 100–178 | **3.13–4.31×** |

The slowest kernel scales best and the fastest scales worst, which is exactly
what over-decomposition predicts: a faster kernel makes each fragment cheaper,
so the fixed per-task cost — slicing, transfer, reassembly — is a larger share
of it.

**Do not read that as an argument for the slower kernel.** At 8 workers:

| content | int | wasm-scalar | wasm-simd |
|---|---:|---:|---:|
| solid | 304 | 381 | **556** |
| noise | 270 | 307 | **429** |
| photo | 279 | 318 | **495** |

SIMD scales worst and wins outright, every time. Scaling efficiency is a
property of the ratio, not of the throughput, and only the throughput is what
anyone converts images with.

### Parallelism partly flattens the content effect

Sequentially, content moves SIMD throughput by 1.77× (solid 177.6 vs noise
100.5). At 8 workers the same gap is 1.30× (556 vs 429). The int kernel
compresses too, 1.26× → 1.13×.

Content acts through CLUT cache behaviour, and once eight workers are competing
for shared cache and memory bandwidth, that shared bottleneck matters more than
whether any one worker's access pattern is friendly. It does not vanish — solid
is still fastest everywhere — but parallel figures understate how much content
matters single-threaded. A benchmark that only ever reports parallel numbers
would hide a 2.7× effect.

### Odd worker counts cost nothing — the pull queue holds

lcms divides one buffer evenly across N threads, so a count that does not
divide the work leaves a ragged tail. We fragment into ~10 tasks per worker and
pull from a queue, so nothing should care. Testing it needs care:

**The obvious test is confounded.** Comparing mean efficiency at {3,5,7}
against {4,6,8} makes odd look ~4 points better on any machine, penalty or not,
because efficiency falls as workers are added and the odd set has the lower
mean count. (This bench shipped with that mistake first and had to be
re-analysed — hence `--out=`, so raw rows survive the analysis.)

The local test is whether an odd point sits below the line joining its
neighbours:

| cell | w3 | w5 | w7 | mean |
|---|---:|---:|---:|---:|
| solid / int | +4.5% | −6.5% | −1.1% | −1.0% |
| noise / int | −3.9% | −8.7% | −3.6% | **−5.4%** |
| photo / int | −0.2% | −2.5% | −8.7% | −3.8% |
| solid / wasm-scalar | +2.1% | +5.5% | −3.4% | +1.4% |
| noise / wasm-scalar | +1.5% | +1.0% | −2.9% | −0.1% |
| photo / wasm-scalar | −0.2% | +0.1% | +5.1% | +1.6% |
| solid / wasm-simd | +2.4% | −2.3% | −4.5% | −1.4% |
| noise / wasm-simd | −0.2% | +0.1% | +5.5% | +1.8% |
| photo / wasm-simd | +0.6% | −9.7% | +4.4% | −1.6% |

Signs are mixed and magnitudes sit inside the 5–10% run-to-run spread on
parallel figures, so there is no ragged-tail penalty to find. **One exception
worth naming rather than averaging away:** noise/int is negative at all three
odd counts (mean −5.4%). One cell out of nine, and the only one with a
consistent sign — not enough to claim a real effect, and enough that a future
run should look at it again rather than treat the question as closed.

### Where the variance actually lives — and it is not core placement

The obvious suspect for 20%+ run-to-run spread on an SMT part is the OS putting
two workers on the two logical threads of one physical core while another core
idles. It is a good hypothesis and it is wrong here, which took two
measurements to establish.

**Within a run, placement is even.** `pool.workerStats()` reports each worker's
own throughput (its pixels over its own reported compute time). Because
fragments are PULLED rather than pre-assigned, a worker sharing a core would
take fewer of them and run at roughly half rate — an obvious bimodal split.
Across ten independent pool spin-ups at 8 workers:

```
worst within-run fastest/slowest ratio : 1.10x   (placement even in every run)
total throughput spread across runs    : 23%
```

Never above 1.10×, when core-sharing would show 1.8–2.0×. What does happen is
that **all eight workers speed up and slow down together** (one run 70–75
MPx/s each, another 81–87) — machine-wide boost and thermal state, not
placement.

**Workers slow down together as the count rises**, which is the real scaling
limit:

| workers | per-worker MPx/s (int-wasm-simd) |
|---:|---|
| 2 | 95, 96 |
| 4 | 87, 88, 89, 90 |
| 6 | 81, 82, 83, 84, 85, 88 |
| 8 | 74, 76, 76, 77, 78, 78, 79, 80 |

Equal shares of a shrinking pie — the signature of a saturating shared
resource, i.e. memory bandwidth, not of uneven scheduling.

**But the variance is not in the conversion at all.** Splitting wall time into
worker compute and everything else, over ten runs:

```
worker compute spread : 6%    <- the conversion itself, stable
orchestration spread  : 53%   <- copy in, copy out, reassembly
orchestration         : 25-37% of wall time at 8 workers
```

The conversion is the reliable part. The noise — and a quarter to a third of
the wall clock — is **main-thread orchestration**: each fragment allocates a
fresh `Uint8ClampedArray` and copies the source into it, and each result is
copied back into the output. The main thread touches every pixel twice while
the workers do the real work, and being allocation-heavy it moves with GC
state, which is where the run-to-run spread comes from.

That also explains two things noted separately above: why the fastest kernel
scales worst (compute shrinks, orchestration does not), and why efficiency
falls as workers are added.

**The optimisation this points at is not more workers, it is fewer
allocations.** That change has since been made and it is the largest single
win in this document.

#### The fix: one scratch pair per worker, reused for the whole batch

Transfer DETACHES a buffer, so the main thread cannot simply keep one and send
it again — which is why the original code allocated per fragment. The fix is to
have the worker hand both buffers BACK on its reply: the pool keeps
`scratchIn[i]` and `scratchOut[i]` per worker, sized once from the batch plan,
and the worker converts into the supplied output array
(`transformArray(..., outputArray)`) rather than allocating its own. Steady
state allocates nothing at all, so GC has no reason to run until the batch is
over.

Peak throughput, same harness, medians before and after:

| cell | before | after | change |
|---|---:|---:|---:|
| solid / int | 264.4 | 340.9 | +28.9% |
| noise / int | 256.6 | 295.4 | +15.1% |
| photo / int | 270.8 | 305.3 | +12.7% |
| solid / wasm-scalar | 354.5 | 455.6 | +28.5% |
| noise / wasm-scalar | 277.1 | 330.8 | +19.4% |
| photo / wasm-scalar | 321.6 | 383.1 | +19.1% |
| solid / wasm-simd | 489.9 | **819.1** | **+67.2%** |
| noise / wasm-simd | 428.1 | 564.5 | +31.9% |
| photo / wasm-simd | 423.1 | 624.5 | +47.6% |

Mean +30%, output byte-identical in every cell. Orchestration fell from 25-37%
of wall time to 17-26%, and the workers themselves got faster (aggregate 635 to
740 MPx/s) because they were no longer competing with their own garbage
collector. The largest gains land on the fastest kernels, which is the expected
shape: the less time a fragment spends converting, the more the overhead around
it matters.

#### What is left: four copies per pixel

Allocation is gone; copying is not. On the `int-wasm-simd` path every pixel is
still copied four times:

| # | copy | where |
|---|---|---|
| 1 | caller's image into the main-thread scratch | `slice.set(...)` in pool.js |
| 2 | scratch into WASM linear memory | `memU8.set(input, inputPtr)` |
| 3 | WASM linear memory back into a JS array | `output.set(outView, ...)` |
| 4 | scratch into the caller's output array | `outputs[i].set(chunk, ...)` |

Transfers between threads are free — they move ownership, not bytes — so all
four are memory traffic that buys nothing.

**A `SharedArrayBuffer` cannot be handed to WASM directly**: a kernel can only
address its own linear memory. But the linear memory can BE shared —
`new WebAssembly.Memory({initial, maximum, shared: true})` has a
`SharedArrayBuffer` for its `.buffer`. Import that instead of letting the module
define its own (today: `new WebAssembly.Instance(mod, {})`, with
`exports.memory`), and the main thread can hold a view of a worker's actual
WASM memory and write the fragment straight into the input region.

That collapses four copies to two — the caller's data in, the results out — and
even those go if the caller allocates images inside the shared memory. It also
removes the scratch buffers and the transfers entirely.

Requirements, none of them free: the WASM rebuilt with imported memory, a
declared `maximum` (shared memories cannot grow freely), and cross-origin
isolation in browsers, though not in Node. Synchronisation needs no atomics for
the pixel data — worker *i* only ever touches region *i*, and dispatch/reply is
already the handoff.

This is the same "WASM memory must be imported, not internal" item listed under
"What actually has to change" above, and it is worth revisiting: the 4-7% that
made Model B look not worth building measured transfer-versus-copy in the POC
and never counted copies 2 and 3.

#### Which copies actually matter — and why this is a multicore fix only

Copies 2 and 3 happen inside the worker, so they already parallelise: eight
workers do eight of them at once. Only copies 1 and 4 sit on the main thread,
one after another, for every fragment. **They are Amdahl's serial fraction.**

Measured single-threaded on the same 4 MPx conversion (12 MB in, 16 MB out),
timing the same `.set()` primitive the bridge uses:

| kernel | call | equivalent copies | share |
|---|---:|---:|---:|
| int-wasm-simd | 38.2 ms | 1.1 ms | 3% |
| int-wasm-scalar | 64.3 ms | 0.9 ms | 1% |
| int | 86.8 ms | 1.1 ms | 1% |

**Single-threaded there is nothing to win here.** 28 MB moves in about a
millisecond — roughly 25 GB/s — against a conversion that takes 38 to 87 ms.
Anyone tempted to optimise the WASM bridge for the single-core path should stop
at this table.

The multicore case is the same absolute cost against a much smaller wall clock.
At 8 workers the conversion falls to about 4.8 ms while the copies stay at
1.1 ms, so 1.1 / (4.8 + 1.1) is about 19% — which is where the independently
measured 17-26% orchestration comes from. The copies did not get more
expensive; everything else got cheaper.

#### FUTURE WORK: shared memory — but not where it first appears

Two changes are available and they are NOT the same size. Working out which
copies each one removes is what separates them.

**A. Imported shared `WebAssembly.Memory` — needs a recompile, worth ~3%.**

Every kernel today declares its memory internally:

```wat
(memory (export "memory") 1)          ;; src/kernels/3d/tetra3d_simd.wat:65 and 7 others
```

and the loader instantiates with an empty import object
(`new WebAssembly.Instance(mod, {})`), reading `exports.memory`. Whether memory
is imported or module-defined is part of the module's binary structure, so
**this cannot be done from the loader** — all eight `.wat` files must change to

```wat
(import "env" "memory" (memory 1 <max> shared))
```

and be rebuilt (`wabt` is already a devDependency). The loader then creates
`new WebAssembly.Memory({initial, maximum, shared: true})` and passes
`{env: {memory}}`. Hosts without cross-origin isolation cannot use shared
memory at all, so both builds have to ship and be chosen at runtime.

What it removes is copies **2 and 3** — JS array into linear memory and back.
Those run INSIDE the worker, so they already parallelise, and single-threaded
they measure about 3% of the call. Removing them takes ~3% off worker compute,
which at 8 workers is ~2-3% end to end. Real, but small, for a toolchain
change and a doubled build matrix.

**B. Caller-supplied `SharedArrayBuffer` images — no recompile, worth ~19%.**

The expensive copies are **1 and 4**, because they are the SERIAL ones: the
main thread copies the caller's pixels into scratch, and copies results back
out, once per fragment, while the workers wait. That is the ~19% derived above.

If the caller's image and output live in a `SharedArrayBuffer`, both disappear
— not by being made faster but by MOVING INTO THE WORKERS. Each worker takes a
view at its fragment's offset, reads straight from the shared image, and writes
its result straight into the shared output. The copies that remain are the ones
already inside the worker, and they run eight at a time.

**This needs no WASM change at all.** It is an API addition — accept SAB-backed
image buffers — plus offset bookkeeping in the pool, which already knows every
fragment's start and length.

**Order of work, therefore: B before A.** The intuition that a WASM bridge is
the thing to optimise gets this backwards; the bridge copies were never the
expensive ones, because they were already parallel. It is also why the 4-7% POC
figure misled — it was measured before the serial fraction dominated, and
against the copies that scale rather than the ones that do not.

### Repeatability, and how to compare two builds

Sequential baselines reproduce to about 1% (solid/simd: 180.3, 179.3, 177.6).
**Parallel peaks do not.** The same cell (solid/int-wasm-simd, 8 workers,
isolated, median of 5) has produced 556, 487, 442, 489, 495 and 510 MPx/s
across sessions — a spread of about 25%, and even a 5-repetition median moves
3% between sessions.

So a single parallel figure cannot resolve anything smaller than ~10%, and
comparing two builds by running one then the other is worse than useless:

> A blocked A/B (all of build A, then all of build B) confounds the build with
> TIME. In one 6-pair run here, the first two pairs were low for *both* arms
> and the last four high for *both* — roughly 10% of warm-up and thermal drift
> across the session. Run blocked, all of that lands on whichever arm went
> first. That is exactly how a 6% "regression" was once reported here that did
> not exist.

**Interleave and pair instead.** Alternate A, B, A, B…, take the difference
within each pair, and report the mean with a confidence interval. Each pair
experiences the same machine state, so the drift cancels. Measuring the cost of
the pause check, in-flight accounting and per-dispatch cancellation check this
way gave:

```
paired mean difference: -1.08%   (sd 5.63, n = 6)
95% CI: -5.58% to +3.42%   ->   spans zero, no detectable cost
```

Blocked, the same comparison had suggested a 6% loss.

## We support multicore, but it is not free

In C you spin up threads. They share one address space, so a LUT is **one
copy** no matter how many threads read it, and adding a thread costs a stack.

JavaScript has no such thing by default. A worker is closer to a process than a
thread: nothing is shared, and everything a worker needs has to be *copied in*.
So the same LUT ends up resident once **per worker**, and the cost of going
parallel is paid in memory as well as in scheduling.

That is the single largest architectural difference between this engine and
lcms on this axis, and it is invisible unless you go looking — which is why
`pool.memoryReport()` exists.

### The number

A 33-point CMYK LUT is about **1.4 MB**, because the int path keeps two tables:

| table | type | size |
|---|---|---|
| `lut.CLUT` | `Float64Array`, 33³ × 4 | 1,149,984 B |
| `lut.intLut.CLUT` | `Uint16Array`, the same grid | 287,496 B |
| | **per worker** | **~1.4 MB** |

Multiply by the pool. On an 8-core machine one transform is **~11.5 MB**
resident across the workers, for a table that lcms would hold once:

```
pool 8: 8 workers (6 holding), 1 transform(s), 6 copies, 8.2 MB resident
        — 1.4 MB per worker that holds them all
```

("6 holding" is not a bug. Workers pull from a queue, so a small batch may
never reach the last few, and a worker is only sent a transform when it is
handed a task that needs it.)

On the WASM kernels there is a **third** copy: `wasm_loader.js` does
`memU16.set(intLut.CLUT, lutPtr >> 1)`, uploading the u16 table into that
worker's linear memory. So `int-wasm-simd` — the default for `int8` +
`buildLut` — costs roughly 1.7 MB per worker, and only two thirds of that is
visible to `memoryReport()`.

### What follows from it

**Reuse Transforms; do not rebuild them.** Worker cache keys are *assigned*,
not derived from content, so two Transforms built from the same profiles are
two entries and two copies. That is deliberate — a content hash has to cover
every input that changes what the worker builds, forever, and getting that list
wrong silently serves one Transform another one's pipeline, which is a much
worse failure than using more memory. The cost is now yours to manage, and
managing it means keeping one Transform per conversion rather than making a
fresh one per image.

**The per-worker cache is bounded.** Each worker keeps `transformsPerWorker`
(default 8) transforms, evicted least-recently-used, so a long-running process
cannot accumulate them without limit. Raising it trades memory for not
re-shipping a transform that comes back around — 8 workers × 8 transforms ×
1.4 MB is ~92 MB, so raise it deliberately.

**Release what you have finished with.** `transform.forgetWorkers()` drops one
Transform from every worker without disturbing the pool that other Transforms
are using; `transform.releaseWorkers()` tears the pool down entirely. In an app
holding the pool open (`idleTimeoutMs: 0`), LRU alone will not reclaim a
finished transform until eight more push it out.

**Nothing is lost if a copy disappears.** The worker's copy is a *cache* and
the Transform is its source of truth, so eviction, an explicit forget, an idle
timeout or a worker dying all just mean the next call re-registers. The only
consequence is time.

### Where `SharedArrayBuffer` would and would not help

The LUT is read-only after it is built, which makes it a textbook candidate for
`SharedArrayBuffer`: a worker does `new Uint16Array(sab)` and reads it exactly
like any typed array, the view costs a few dozen bytes, and read-only means no
`Atomics`. That removes the JS-side copies outright.

It does **not** remove the WASM copy. Each worker instantiates its own module
with its own linear memory, so `int-wasm-simd` would still upload the table per
worker. Sharing that needs `WebAssembly.Memory({shared: true})` with
per-worker scratch regions partitioned inside one shared memory — a real
project, not a flag.

Worth checking first, and possibly worth more: on the wasm path the f64 CLUT
may be dead weight in the worker once `intLut` exists. Dropping it there would
be about 80% off the resident figure — larger than SAB would deliver on that
path — for much less work.

**And the bigger SAB prize is the image, not the LUT.** Removing per-fragment
allocation alone bought a mean +30% and up to +67%; what remains is four copies
per pixel, two of which are into and out of WASM linear memory. Sharing the LUT
saves memory; sharing the IMAGE — by importing a shared `WebAssembly.Memory`
rather than letting each module define its own — would save time, and attacks
the term that now limits scaling. See "What is left: four copies per pixel".

**How much time, measured — and then measured again, differently.** Fitting
`T(w) = S + P/w` to pooled runs gives a serial term of **0.31 ms/MPx for the
matrix-shaper kernel and 0.56 for the CLUT**, capping the pool at low single-
figure GPx/s. About half of `S` is the same order as main-thread `memcpy` at
32 GB/s, and the first version of this paragraph concluded that deleting the
copies would buy **+30% at 8 workers**.

**A spike says +5–13%.** See below — the copies turn out to be largely
interleaved with worker execution, so removing them frees time that was already
hidden. Full working, plus a fragment-size sweep showing the current default is
already at the optimum, is in
[MatrixShaperKernel.md](./MatrixShaperKernel.md#what-the-overhead-actually-is).

### MEASURED, AND NOT BUILT: SharedArrayBuffer is worth ~5–13%, not ~30%

`bench/sab_spike/` reimplements the pool's dispatch loop in the crudest way
that is still fair — a pull queue, real workers, the real matrix-shaper kernel,
output checked byte-for-byte — so the delivery model could be measured before
SAB was threaded through cancellation, eviction, scratch reuse and the worker
protocol. That was the point of building it: **if the answer was small, the work
would not get done.** The answer was small.

Four models, 4.2 MPx photo, 8 workers, `*prophoto → *sRGB`, paired so that
drift hits both arms:

| model | int8 | int16 |
|---|---:|---:|
| **transfer** (today) | baseline | baseline |
| **shared** — both buffers already SAB | 1.09–1.19× | — |
| **half-shared** — per-fragment copy in, shared out | **1.05, 1.13, 1.13×** | **1.05, 1.00×** |
| **shared + bulk copy-in** — plain-array caller | 0.83–0.91× | — |

Three findings, none of them what was predicted:

**1. The gain is 5–13% at int8 and nil at int16.** The projection in this
document was +30% at int8 and +50% at int16, derived from the fitted serial
term `S`. That derivation does not survive contact with its own inputs: for int16 the measured copy floor (0.646 ms/MPx) is
*larger* than the fitted `S` (0.429), which cannot be true of a genuinely
serial cost. **The main-thread copies are mostly interleaved with worker
execution** — the main thread copies fragment N+1 while the workers are still
chewing on fragment N — so removing them frees time that was already hidden.
`S` is contention and per-task cost, not memcpy.

**2. int16 gains less, not more, despite moving twice the bytes.** Same
mechanism, seen from the other side: at int16 each fragment is more work, so
the main thread has *more* idle time to hide its copies in. The copies grow, the
place to hide them grows faster.

**3. The naive design is a regression.** A caller with a plain
`Uint8ClampedArray` — canvas `ImageData`, every image decoder — cannot have
their buffer adopted into a SAB after the fact. Copying the image in up front
measures **0.83–0.91×**, i.e. 9–17% SLOWER than today, precisely because that
bulk copy is serial and not interleaved. Only the output side is ours to
allocate, hence "half-shared", which is where the 5–13% comes from.

### Why it was not built

The measured upside is 5–13% on one bit depth, and the spike's transfer
baseline is already faster than the real pool (it has none of the cancellation,
stats or promise machinery), so against the real pool the same absolute saving —
0.03 to 0.09 ms/MPx — is a smaller fraction still.

Against that:

- **Two delivery paths, forever.** `SharedArrayBuffer` is not always available,
  so the transfer path cannot be deleted. Both would need testing on every
  change to the pool.
- **A deployment blocker on the web.** Cross-origin isolation (COOP/COEP)
  breaks third-party embeds, and is not something a library can ask for.
- **Invasive where it is riskiest.** The worker protocol, scratch lifecycle and
  cancellation all assume transfer semantics.
- **Imported shared WASM memory** — needed to remove the *second* copy pair,
  inside the worker — additionally requires disabling `compactIfNeeded`, since
  a shared memory cannot be re-instantiated out from under the workers holding
  it. That is the item 2/3 work above, for a copy pair measured at 7–9% of the
  kernel call and divided by the worker count.

**What would change the answer:** more cores. At 8 workers the kernel's serial
and parallel terms are near enough equal; at 16 or 32 the serial fraction
dominates and the copies stop being hidden. The spike is kept so the question
can be re-asked on that hardware rather than re-argued.



### Measuring it

```js
const pool = require('jscolorengine/src/pool');

pool.memorySummary();   // one line per pool, human-readable
pool.memoryReport();    // structured: workers, transforms, residencies, bytes
```

`memoryReport()` counts what the workers reported holding after registration,
so it covers LUTs. It excludes each worker's own heap, WASM linear memory, and
slices in flight — it is a floor, not a total. Pass `multicore: {debug: true}`
to log every ship, eviction and teardown as it happens.

## Still open

The questions the design stage raised that the measurements above did not
settle. The ones they did settle — per-task overhead, whether Mode 2 replaces
Mode 1, the copy cost that Model B would have removed — are answered in place
above.

1. **Do the JS int kernels scale as well as the WASM ones?** 4 × 73 MPx/s
   would put pure JS level with single-threaded WASM SIMD, which would be an
   interesting result on its own.
2. **Does fixed-slot allocation actually reduce jitter?** The argument for it
   is smoothness rather than throughput, so it has to be judged on p95/p99 task
   latency, GC pause count and peak RSS — not on mean MPx/s, which may show no
   difference at all.
3. **How stable is a calibration across machines?** Both constants are machine
   properties, so `autoTune()` wants running on a spread of hardware — a laptop
   on battery, a 3D V-Cache desktop, a many-core server, a phone — to check the
   *rule* transfers even where the *numbers* do not. If the derived
   `tasksPerWorker` lands outside 4–16 anywhere, the model is missing a term.
4. **How much do heterogeneous cores widen the variance, and does SIMD suffer
   more?** Everything here is from a homogeneous Zen 4 part. On an Intel P/E or
   Apple Silicon machine the prediction is that core-type variance is *larger*
   for the SIMD kernel than the JS one, because E-cores have narrower vector
   ports — which would mean SIMD needs deeper over-decomposition on hybrid
   hardware, the reverse of what was measured here. A calibration that lands
   mostly on E-cores is also the likeliest way for `autoTune` to derive a wrong
   constant.
5. **Browser versus Node**, once the worker bundle exists: worker spin-up is
   slower, and a tab's memory ceiling is lower than a server's, which matters
   most for the pool's dominant cost — a LUT copy per worker.
