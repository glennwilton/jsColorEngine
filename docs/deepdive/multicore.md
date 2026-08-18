# Multicore — design notes

> **Status: measured, not implemented.** The design below was written
> first as a brainstorm; the experiment has since been run
> (`bench/multicore_poc/`, public API only, no engine changes) and the
> results are in "MEASURED" near the end. Read that first — it rules out
> the more invasive half of this document. Nothing has been built into
> the engine. Multicore is still an empty cell in the
> [LcmsComparison](../LcmsComparison.md) "not comparable" table; the
> numbers here are from a proof of concept, not a shipped feature.
>
> Headline: **5.46x peak**, byte-identical, and the copies that Model B
> exists to eliminate cost only **4-7%** — so Model B is probably never
> worth building.

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

| workers | MPx/s | speedup | efficiency | copy overhead |
|---:|---:|---:|---:|---:|
| 1 | 41.8 | 0.95× | 95 % | 6.9 ms |
| 2 | 76.3 | 1.73× | 86 % | 7.1 ms |
| 4 | 130.5 | 2.96× | 74 % | 11.8 ms |
| 8 | 189.6 | 4.30× | 54 % | 7.3 ms |
| 12 | 237.3 | 5.38× | 45 % | 12.9 ms |
| 16 | 240.8 | 5.46× | 34 % | 8.4 ms |

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
function plan(images, workers, minSlice = 65536) {
    const tasks = [];
    for (let i = 0; i < images.length; i++) {
        const px = images[i].pixelCount;
        // MEASURED CORRECTION: capping at the worker count is the WORST
        // configuration -- one task per worker leaves a slow task with
        // nothing to overlap, costing 30-48%. Over-decompose instead and
        // let the queue balance it. See MEASURED, per-task overhead.
        const slices = Math.min(Math.max(1, Math.floor(px / minSlice)), workers * 6);
        const per = Math.ceil(px / slices / 64) * 64;          // 64-px aligned
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

## Open questions — measure before building

1. **How much does Model A's copying actually cost?** The estimate is
   ~8 % of the compute it parallelises. If that holds, Model B may never
   be worth its invasiveness.
2. How much of the win is just deleting the in/out WASM copy? Measure
   that single-threaded first; it may be most of it.
3. Where is the image-size crossover below which splitting loses?
4. Does near-linear scaling hold at 4, 8, 16 workers, or does something
   unexpected bind first?
5. Do the JS int kernels scale as well as the WASM ones? 4 × 73 MPx/s
   would put pure JS level with single-threaded WASM SIMD, which would
   be a genuinely interesting result on its own.
6. ~~What is the per-task overhead?~~ **ANSWERED: ~7–8 µs**
   (`task_overhead.js`). The flat region is 32 K–524 K px per task, so
   the fixed-slot chunk wants to be ~128–256 K px — about 10× smaller
   than the 5 MB first proposed. It also showed the current planner's
   one-slice-per-worker cap is the worst measured configuration, 30–48 %
   off the plateau. See MEASURED above.
7. **Does fixed-slot allocation actually reduce jitter?** The whole
   argument for it is smoothness rather than throughput, so it has to be
   judged on p95/p99 task latency, GC pause count and peak RSS — not on
   mean MPx/s, which may show no difference at all.
6. Browser vs Node: how much worse is the browser path in practice,
   given slower worker spin-up (and COOP/COEP if Model B).
7. Does the imported-memory change cost anything single-threaded?
   (Model B only.)

## First experiment — done

Run, and written up under MEASURED above. `bench/multicore_poc/` is the
harness; it needed no engine changes and uses the public API only.

Outcome in one line: **5.46x peak, byte-identical, and Model B is
probably never worth building** because the copies it would eliminate
cost only 4-7%.
