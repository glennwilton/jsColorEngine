# Pixel cache — design notes

> **Status (2026-08-17).** The **pipeline path is implemented and
> instrumented** — `src/cache.js`, opt-in via `pixelCache`, covered by
> `__tests__/pixelcache.tests.js`. What it is *worth* is still unknown:
> no hit-rate corpus has been run, and no throughput claim should be
> made from it. The **kernel path remains design-only.** Every
> performance number below is either an estimate (labelled as such) or
> a measurement of *LittleCMS*, not of us. Do not quote any of it.
> See "As built" at the end for what shipped and what it taught us.

## What this is

LittleCMS memoises the last pixel inside `cmsDoTransform` (unless
`cmsFLAGS_NOCACHE`): if the incoming pixel is byte-identical to the
previous one, it copies the previous output and skips the
interpolation entirely. jsColorEngine's kernels have no such cache —
they are **content-neutral**, converting noise and flat colour at the
same rate.

That difference is measured and written up in
[LcmsComparison.md](../LcmsComparison.md) (noise / gradient / solid
runs of the native harness). The short version: the cache does nothing
on noise, roughly 2–3× on gradients, ~5× on solid fills, and every
workflow converges on the same cache-hit ceiling — the cost of compare
plus copy with no interpolation at all.

**So this is a content-class feature, not a throughput feature.** It
must be opt-in, and it must never quietly change the numbers we
publish.

Which content classes win was, until measured, assumed — wrongly. See
"Measured" immediately below.

## Measured — accuracy path, 2026-08-17

`node bench/pixel_cache/cache_bench.js` — sRGB → AdobeRGB, 250k pixels,
`buildLut: false`, median of 3. Hit rate is the transferable figure;
the MPx/s columns describe this path only.

| content | cache off | slots=1 | slots=32 |
|---|---:|---:|---:|
| noise | 7.75 | 0.0 % · 0.82x | 0.0 % · 0.82x |
| gradient | 9.01 | 75.0 % · 1.85x | 75.0 % · 1.78x |
| checkerboard | 9.06 | 0.1 % · 0.76x | 100 % · 3.25x |
| palette8 | 9.10 | 12.5 % · 0.86x | 87.5 % · 1.94x |
| solid | 8.83 | 100 % · 3.39x | 100 % · 3.25x |
| face.png | 9.56 | 26.1 % · 0.83x | 58.8 % · 1.22x |
| fruit.png | 10.73 | 58.3 % · 1.20x | 76.2 % · 1.39x |
| skin.png | 8.98 | 52.1 % · 1.03x | 83.3 % · 1.91x |

**The assumption this overturns.** Every design note above argued that
real photographs would almost never hit, because sensor noise and JPEG
artifacts break byte-identical *adjacent* pixels. Adjacency is indeed
weak — single-entry manages only 26 % on `face.png`. But a keyed table
does not care about adjacency: it catches a colour recurring anywhere
in a rolling window, and 8-bit images reuse colours heavily. The three
sample photographs hit **59–83 %** at 32 slots and are *faster* with
the cache on, not slower. Adjacency was simply the wrong model.

**Adjacency vs recurrence, separated.** The `slots=1` column *is* the
pure adjacency measure, and the gap to `slots=32` is everything else:

| image | adjacency (slots=1) | + recurrence (slots=32) |
|---|---:|---:|
| face.png | 26.1 % | 58.8 % |
| fruit.png | 58.3 % | 76.2 % |
| skin.png | 52.1 % | 83.3 % |

So roughly half the hits on `face.png` come from colours recurring
elsewhere in the rolling window rather than from neighbouring pixels —
a noisy flat background cycling through a dozen values is invisible to
a single entry and free to a small table. The synthetic `near-miss`
pattern (every pixel differing by 1 LSB, 27 distinct colours) shows the
same shape: 0 % at one entry, 83 % at 32 slots.

**Caveats — these are not a corpus.**

- Three PNGs, and they are *AI-generated / adjusted* images. Those
  plausibly carry smoother gradients and fewer distinct colours than
  camera output, which would inflate every figure above.
- Each has a substantial flat background (~20 % of frame), so some of
  the win is background, not subject.
- Counter-intuitively, JPEG input may score *higher*, not lower:
  quantisation flattens smooth DCT blocks to identical values. The
  familiar "JPEG artifacts break byte-equality" intuition applies to
  high-frequency detail, not flat regions.

Enough to redirect the work. Not enough to publish.

**Verified, not assumed.** `bench/pixel_cache/verify_cache.js` compares
cached against uncached output byte for byte — every content type
above, four transform shapes (3- and 4-channel output, int8 and int16),
all cache modes: 108 whole-image comparisons, every byte identical,
FNV-1a hashes matching. A reduced version runs in the test suite. This
matters because colour-level unit tests cannot generate the evictions,
collisions and hit/miss interleavings that only appear at image scale.

**Worst case is worse than estimated.** Pure noise costs 0.82x — about
a 20 % tax, against the 8–12 % predicted from op counts. And note the
uncached column is itself content-sensitive (7.75 on noise vs 10.73 on
`fruit.png`), so the pipeline was never truly content-neutral either.

**What it means for the next step.** The keyed table, not the single
entry, is the design worth carrying to the kernels: single-entry loses
on four of the eight content types and wins big only on solid fills.

## Decisions taken (2026-08-16)

Still unmeasured — these set the build order, not the outcome.

| Path | Call | Reasoning |
|---|---|---|
| Pipeline / accuracy path | **YES — first** | Biggest payoff: a hit skips the entire stage walk. See below. |
| 8-bit kernels | **YES — test** | The typical speed path. Test 1, 2, 16 and 32 slots against real data. |
| int16 | **NO** | Accuracy-oriented path where the cache suits least, and it doubles the live-register count. Revisit only if the 8-bit data is compelling. |
| SIMD kernels | **NO** | A scalar check serialises what the f32x4 path vectorises. |

### Pipeline path — design notes

A hit returns cached output and skips every stage. Two things fall out
of that:

**Cache at the device boundary, not at the API boundary.** Every
`dataFormat` normalises to a device array (0.0–1.0) in the pipeline's
first step, and converts back in the last. So the cache only ever
needs to handle *one* input shape — a device array — regardless of
whether the caller passed objects, floats or ints. Check the device
array against the cached one; on a hit, skip straight to the output
block. One implementation covers every format.

This also disposes of the mutability problem: the output converters
all build fresh results (`stage_device_to_RGB` returns a new literal,
`stage_device_to_NCh` slices), so the cached device array is never
handed to the caller and cannot be corrupted by them.

Four things to get right, verified against the pipeline builder:

1. **`dataFormat: 'device'` is the exception.** The output converter is
   gated on `convertOutput && this.dataFormat !== 'device'`
   (`Transform.js` ~3673), so that path has none — a hit would return
   the cached array itself. **Resolved:** two variants rather than a
   runtime test — one that checks and returns a copy (`'device'`), one
   that checks and jumps to the output block (everything else).
   `dataFormat` is fixed at construction, so `create()` picks one of
   three bound forms — no-cache, cache+converter, cache+device-copy —
   and the hot path never branches on it.
2. **The output converter isn't reliably last.**
   `insertCustomStage('afterDevice2Output', …)` can follow it, and
   `pipelineDebug` appends an `'END'` marker. Jump to the *start index
   of the output block*, never `pipeline.length - 1`.
3. **Capture indices after `optimisePipeline()`**, which merges stages
   and shifts positions. For the same reason, don't hardcode the check
   at index 0 or 1: the debug `'Start'` stage only exists when
   `pipelineDebug` is on, and `convertInput` may omit the input
   converter. Record both indices at build time.
4. **Keep it away from `pipelineDebug`.** That branch records
   `pipelineHistory` per stage; jumping would fabricate a history that
   never ran. Falls out of the branch ordering below at no cost.

### Mechanism — a mutable `step`, in its own loop arm

The cache check *is* a normal pipeline stage. The walk reads a `step`
field instead of incrementing, and the stage sets its own on a hit:

```js
// in the cache stage
stage.step = cacheHit ? stage.stageData.endStep : 1;

// the walk
while (i < len) {
    var stage = pipeline[i];
    result = stage.funct.call(this, result, stage.stageData, stage);
    i += stage.step;
}
```

No new plumbing is needed — `funct` already receives the stage object
as its third argument (`Transform.js` ~2629), so a stage can set its
own step today. `endStep` is the relative jump to the output block,
computed once at `create()` (post-optimiser, per gotcha 3) and parked
in the stage's `stageData`.

**Give it its own arm rather than changing the shared walk:**

```js
if (this.pipelineDebug) { … }        // existing, untouched
else if (this.cacheEnabled) { … }    // the step-based walk
else { … }                           // existing i++ walk, untouched
```

`transform()` already branches on `pipelineDebug` outside the loop and
duplicates the walk, so a third arm is the established idiom, not a
new pattern. Two things fall out of it for free:

- **Cache-off pays nothing.** The `step` field replaces `i++` — a
  register increment the CPU speculates through — with a load the loop
  counter depends on, lengthening the loop-carried dependency chain.
  Probably hidden behind ~50 cycles of per-stage work, but "probably
  hidden" is exactly the assumption [benchmark.md](./benchmark.md)
  warns about. Confining it to its own arm means the question never
  arises for anyone who hasn't opted in.
- **Debug and cache are mutually exclusive by construction**, because
  `pipelineDebug` is tested first (gotcha 4, with no explicit guard).

The device/converter split from gotcha 1 collapses into this too: both
are the same stage with a different `funct`, chosen at `create()` —
one returns a copy, the other returns the cached device array and
jumps. Same loop, no runtime branch.

The `step` field is also the general mechanism for runtime-togglable
stages, conditional bypass, or disabling debug without rebuilding the
pipeline, should any of those come up later.

### Build-time injection

One call site in `createPipeline()`: **after `optimisePipeline()` but
before the pipeline-validity check** (`Transform.js` ~3686–3691).
After the optimiser so the cache stage can't be folded into a
neighbour; before the verify so its device→device encodings are still
checked — otherwise a malformed injection sails through silently.

```js
if (this.optimise) this.optimisePipeline();
if (this.pixelCache) this.injectCacheStage();   // ← here
// … existing pipeline validity check
```

Everything the stage needs is fixed at that point, so `endStep` is
computed once and parked in `stageData` — never recalculated per
call.

**Two injection positions, chosen by input format:**

- **`int8` / `int16` → inject at the front**, before the input
  converter, and key on the raw integers. This is safe rather than
  merely cheaper: the int→device conversion is deterministic, so
  identical ints always yield identical device floats — keying on the
  ints is *exactly equivalent* to keying on the normalised values, not
  an approximation of them. Buys an integer key (one exact compare
  instead of three float compares) and skips the converter on a hit.
- **All other formats → inject after the converter**, letting the
  existing object→device stage handle normalisation so the awkward
  shapes (`object`, `objectFloat`, arrays) need no per-format cache
  code at all.

Both positions are resolved at build time, so this is a third
build-time axis alongside the variant matrix below — not a runtime
branch.

### Variant matrix

The stage's `funct` is chosen at build time from a 2×2, so nothing
branches at runtime:

|  | single entry | keyed (16 / 32) |
|---|---|---|
| **`dataFormat: 'device'`** | check, return copy | check, return copy |
| **all other formats** | check, jump to output block | check, jump to output block |

Four small hand-written functions — the pipeline path needs **no
codegen**. That idea stays scoped to the kernel matrix, which is the
one that actually explodes.

Suggested option shape: a single `pixelCache: 0 | 1 | 16 | 32`
(`0`/`false` = off) rather than separate `cacheEnabled` + `cacheSize`,
which admit the invalid `enabled: true, size: 0` combination.

**The keyed variant needs a quantised index.** Unlike the byte
kernels, the pipeline key is a device float array, so there's no
integer to hash. Quantise for bucket selection — `(d[0] * 65536) | 0`
folded across channels — and keep the exact float compare on the
stored key. Lossy index, exact tag, per the rule above. At ~50 cycles
per stage even a sloppy hash is free here.

Custom stages sitting *before* the output block are naturally included
in the cached value, which is correct — but a side-effecting custom
stage (logging, accumulating statistics) would be silently skipped on
hits. Either document that or disable the cache when custom stages are
present.

**Compare the device components directly — don't pack a key.** All the
`<<`/`&` machinery below exists so the byte kernels get one compare per
pixel. Here the stage walk dwarfs any compare, and the device array is
0.0–1.0 doubles that don't pack into an int32 at all. So:

```js
if (d[0] === p[0] && d[1] === p[1] && d[2] === p[2]) { /* hit */ }
```

Exact, no packing code to get wrong, and NaN never compares equal — so
a NaN input can never produce a false hit. Fail-safe by construction.

**Copy only where there's no output converter.** For every format
except `dataFormat: 'device'`, the output block already rebuilds a
fresh result on each hit, so no copy is needed and no `stage_*_cacheout`
formatter has to be written — the existing converters do the job. The
`'device'` path has no converter (gotcha 1 above) and hands back the
cached array directly, so that one case must copy.

Where a copy is required, returning the cached array *itself* is not
merely an aliasing surprise: if the caller mutates it, the cache entry
is corrupted and every subsequent hit returns bad data —
nondeterministic and data-dependent. And skipping the copy buys
little. The accuracy path already allocates ~6 arrays per pixel
walking the stages, so a hit saves ~6 allocations and pays 1 back for
the copy; a no-copy variant reclaims one-sixth of the allocation win
for that bug class. If a read-only caller ever needs it, expose it as
a documented opt-in (`unsafeSharedOutput: true`) — never the default.

## Three shapes, cheapest first

### 1. Single-value memo

Keep the previous input key and previous packed output in two locals.
One compare per pixel.

```js
var prevKey = -1, prevOut = 0;      // -1 can never collide: keys are 0..0xFFFFFF
// inside the pixel loop, reusing the r/g/b loads already being done:
var key = (r << 16) | (g << 8) | b;
if (key === prevKey) {
    out[o]   =  prevOut         & 255;
    out[o+1] = (prevOut >>>  8) & 255;
    out[o+2] = (prevOut >>> 16) & 255;
} else {
    /* existing cascade, unchanged */
    prevKey = key;
    prevOut = c0 | (c1 << 8) | (c2 << 16);
}
```

Catches solid fills and flat regions. Two live values, no memory
traffic, no allocation. This is the lcms behaviour and the baseline
every other option has to beat.

### 2. Two-entry rotating memo — for dither

Ordered dithering is the pathological case for (1): it alternates over
a short horizontal period, so the branch mispredicts on nearly every
pixel while never hitting. But the pattern is **periodic, not
random** — an ABAB alternation is caught exactly by keeping the last
*two* entries and comparing against both. Four live values, still no
memory traffic. A 4-pixel period would need eight, which almost
certainly spills.

### 3. Small direct-mapped table — 32 or 64 slots

Interleaved `Int32Array`, key at `[2n]`, value at `[2n+1]`, so a hit
touches one cache line:

```js
var idx = (Math.imul(key, 2654435761) >>> (32 - LOG2_SLOTS)) << 1;
// 32 slots → >>> 27, Int32Array(64)    64 slots → >>> 26, Int32Array(128)
// fold the two shifts: (h >>> 25) << 1  ≡  (h >>> 24) & 0xFE
```

**Index on a hash of the whole key, never on a channel.** Indexing on
the low byte (blue) collapses to a single slot on any blue-flat
image — sky gradients, single-hue art — giving 100 % conflict misses
*and* full overhead: strictly worse than (1). `2654435761` is
`0x9E3779B1`, the nearest prime to 2³²/φ (Knuth multiplicative
hashing, TAOCP Vol. 3 §6.4); the golden ratio is the hardest number to
approximate by a fraction, so clustered keys — exactly what adjacent
pixels are — scatter evenly instead of piling up. **Take the high
bits** (`>>>`), never `& 255`: carries in a multiply only propagate
upward, so the low bits are barely mixed.

**Stay small — 32 or 64, not 256.** The binding constraint isn't the
table's own footprint, it's that the tetrahedral kernel is already
streaming a large CLUT through cache. Every line the table occupies is
a line not holding CLUT data. 64 slots is 512 bytes / 8 lines; 256
slots is 2 KB / 32 lines. Dither only needs to hold a handful of
distinct values locally (a 4×4 ordered dither is ≤ 16), so the bigger
table likely buys little hit rate for four times the cache pressure.

## Mechanics common to all three

- **Fuse the key into loads you already do.** `(r<<16)|(g<<8)|b` is
  two shifts and two ors against bytes already in registers — no extra
  memory traffic. This beats aliasing a `Uint32Array` over the input,
  which is impossible for 3-byte RGB anyway: a `Uint32Array` view
  requires a 4-byte-aligned `byteOffset`, and pixel *n* starts at byte
  *3n*. (`DataView.getUint32` permits unaligned reads but is a
  bounds-checked call per access — not worth it against three byte
  loads.)
- **32 bits is enough.** 3×8 = 24 bits and 4×8 = 32 bits both fit one
  int32, so a single `===` covers every 8-bit workflow. `c3 << 24`
  makes the value negative; that's fine, the comparison is still
  exact. `int16` mode is the exception (48 bits, two compares) — see
  the next section.
- **No cheap 64-bit in JS.** `BigInt64Array` heap-allocates;
  `Float64Array` bit-compare misbehaves on NaN patterns. Interleaved
  `Int32Array` is the answer.
- **Pack the output too**, one u32 rather than 3–4 separate cached
  channel values — it halves the live register count on the hit path.
- **Endianness matters only if you store *through* a `Uint32Array`
  view** — it's little-endian, so the byte order is the reverse of
  manual `<<` packing. Silent-corruption bug if mixed up.
- **Alpha isn't a complication**: `preserveAlpha` copies it separately,
  so the memo only ever covers colour channels.

## int16 — exact keys, and why not lossy ones

3×16 = 48 bits doesn't fit an int32, so int16 needs two. The exact
form is **cheaper than the 8-bit case**, because the channels arrive
as separate `Uint16Array` elements — you're combining, not extracting:

```js
var k1 = (r << 16) | g;    // 2 ops   (r<<16 sets the sign bit; harmless, === is exact)
var k2 = b;                // 0 ops
if (k1 === prevK1 && k2 === prevK2) { ... }
```

Two ops versus four for int8. The `&&` short-circuits, so a miss —
the common case — usually pays only the first compare. Four-channel
is `k1 = (c<<16)|m, k2 = (y<<16)|k`, still exact, 4 ops.

No 64-bit needed, and none is available: `BigInt64Array`
heap-allocates. The f64 trick (`r*2³² + g*2¹⁶ + b` is exact inside the
53-bit mantissa) was considered and rejected — 4 float ops plus
int→double conversion of the loads loses to two int32 compares.

**The real int16 cost is register pressure.** Output is 48/64 bits
too, so the memo carries four live values (`prevK1, prevK2, prevOut1,
prevOut2`) against two for int8. With pressure already binding on the
cascade, int16 is the *worst* candidate for a memo — test it last, if
at all.

### Slot layout, if a table is ever built for int16

Use a **uniform 4-word slot**, decided by cache-line alignment rather
than size. int16 RGB is 48-bit key + 48-bit result = 96 bits, which
packs into exactly 3 words with no waste (`[key R,G][key B | result
B][result R,G]`), and int16 CMYK is 64+64 = 128 bits = 4 words with no
masking at all. Tempting to use 3 for RGB — but a 64-byte line is 16
words, so **4-word slots divide a line exactly** (4 per line, never
straddling), while 3-word slots land at word offsets 0, 3, 6, 9, 12,
15… and cross a line boundary on roughly one access in five. The
saving is 256 bytes at 64 slots, in a table that is L1-resident
either way; the straddle is not worth it. Masking cost is the minor
consideration (~2 ops), not the deciding one.

int8 doesn't raise the question: 24+24 and 32+32 bits both fit **2
words**, which is the interleaved layout above and is equally
self-aligning at 8 slots per line.

### Lossy keys — considered and rejected

Tempting, because it's true that the kernel doesn't actually compute
16 bits of precision: the int16 POC keeps **Q0.8 frac**, so only 8 of
the 16 fractional bits weight the interpolation (`bench/int16_poc/
RESULTS.md`, "Accuracy ceiling"). So a 16-bit-exact key is arguably
over-precise relative to what the kernel produces, and masking down to
10+10+10 (or the display-style 10+11+10) fits one int32 again.

Rejected on four counts:

1. **It's slower.** `((r>>>6)<<20) | ((g>>>6)<<10) | (b>>>6)` is 7
   ops against the exact version's 2. Lossiness doesn't buy op count —
   it buys hit *rate*.
2. **It buys that hit rate on exactly the wrong content.** Lossy keys
   only help on smooth gradients, which is the one thing 16-bit mode
   exists to serve. The feature would degrade the workload that asked
   for it.
3. **The error isn't a clean quantisation.** A bucket returns whatever
   pixel landed in it *first*, so output becomes scan-order dependent:
   the same image cropped differently converts differently. That is
   non-determinism, not precision loss.
4. **It's unverifiable.** Content- and order-dependent output can't be
   checked against the lcms oracle, which breaks the accuracy story
   and the v1.6 QC plan.

(The 10+11+10 split gives green the extra bit for luminance
sensitivity — a *display* convention. It doesn't transfer here: the
error propagates non-linearly through the CLUT rather than landing on
the eye.)

**Two places lossiness is legitimate:**

- **As the hash index** for the 32/64-slot table. A bucket selector is
  allowed to be lossy; only the key stored *in* the slot must be
  compared exactly. `idx = hash(high bytes)` is fine and cheap.
- **As an explicit input pre-quantise.** If the speed is wanted, round
  the input to N bits up front and then run the *exact* memo. Same
  hit-rate win, fully deterministic, oracle-verifiable, and the caller
  opted in knowingly — rather than a hidden lossy compare inside the
  kernel.

## Costs, honestly

| Cost | Applies to | Notes |
|---|---|---|
| ~6 ALU ops per pixel on a miss | all | Against ~40–60 ops for the 3D int cascade — *estimated* 8–12 % tax on photographic content; proportionally less on 4D. |
| Register pressure | (1), (2) | Cached values stay live across the cascade, where [JitInspection.md](./JitInspection.md) already found pressure binding. V8 will spill. This is the main reason to consider the run-scan restructure below. |
| Branch misprediction | all | Solid and noise both predict perfectly (always / never taken). **Dither is the bad case** — alternating outcomes, ~15–20 cycles a pop. Could exceed the op-count estimate. |
| Store traffic on every miss | (3) only | Photographic content misses on every pixel, so every pixel writes two slots. (1) and (2) update registers — free. This is what most likely sinks the table on photos. |
| CLUT cache-line eviction | (3) only | See sizing note above. |

**Restructure that removes the register pressure:** identical
semantics to (1) — both only ever catch *consecutive* identical
pixels, both produce bit-identical output — but the cache state never
sits live across the cascade:

```js
while (i < n) {
    var key = pack(in, p);
    var j = i + 1, q = p + 3;
    while (j < n && pack(in, q) === key) { j++; q += 3; }
    interpolateOnce(key, tmp);   // hot kernel, zero cache state
    fillRun(out, i, j, tmp);     // tight store loop
    i = j; p = q;
}
```

On noise, runs are length 1 and the cost matches (1). On flat content
`fillRun` is pure stores and should run far past the lcms compare-and-
copy ceiling, because lcms still pays a per-pixel compare inside a run
and this doesn't.

## Where it probably pays: standard loops, not hot loops

Working hypothesis, and the thing to test first:

**A cache's payoff scales with the cost of the work it skips.** The
no-LUT accuracy path runs ~6–11 MPx/s, walking the full stage pipeline
with per-pixel allocation — a hit there skips *two orders of magnitude*
more work than a hit in the int kernel, while the ~6-op key cost stays
constant. Register pressure is a non-issue on that path (it is already
allocating arrays per pixel), and the branch is noise against the stage
walk.

The tuned LUT kernels are the opposite: 49–73 MPx/s, register pressure
already binding, and ~6 ops is a much larger relative tax. They may
simply be fast enough that the cache is a pure cost.

This inverts the usual instinct to optimise the hottest loop, and it
is cheap to check — so check it before building anything for the
kernels.

**Never in the SIMD kernels.** A scalar last-pixel check serialises
what the f32x4 path vectorises. This is a scalar-path idea only.

## Codegen — specialised interpolators via `new Function()`

The combinatorial problem: cache off / single / 2-entry / 32 / 64,
× dimension, × output channels, × lutMode. Hand-writing that matrix is
untenable, and a runtime `if (cacheEnabled)` inside the loop taxes the
no-cache path — so today it would have to be all-or-none.

Codegen resolves it: emit the loop with the cache config baked in as
literals, so the no-cache variant contains no cache code at all and the
table size is a constant, not a load. Points in its favour here:

- The emitter infrastructure already exists — `emit_js_*` /
  `attachStore_js_*` in [`src/stages.js`](../../src/stages.js), and
  `compile()` / `getSource()` / `toModule()` in
  [CompiledPipeline.md](./CompiledPipeline.md). There is already a
  `new Function` runner experiment queued in
  [benchmark_todo.md](./benchmark_todo.md).
- A generated kernel registers as a normal kernel descriptor
  (`lutMode: 'int-memo'`, etc.), so it can be A/B'd against `'int'`
  with **zero risk to the default path or any published number**.
- Each generated variant is a fresh function object with its own type
  feedback — monomorphic per config, no polymorphic dispatch. That is
  a genuine advantage, not just a packaging convenience.

Costs to keep in view: compile plus tier-up warmup per generated
variant (cache generated functions by config key so repeated identical
configs share one object), and **`new Function` is blocked under a
strict CSP without `unsafe-eval`** — a browser library must fall back
to the hand-written kernels, so codegen can never be the only path.

## What to measure first

Hit rate, and it needs **no kernel work at all** — the pipeline cache
is the instrument. Build that first (it's shipping anyway), give the
test build a hit counter, and run a real corpus through it. The
measurement effort isn't throwaway, unlike a standalone counting
script.

Three things make it predictive of the kernel decision:

- **Feed it images in scanline order, not swatches.** Hit rate is a
  property of the data; the pipeline cache only predicts the kernel's
  rate if it sees the same pixel sequence the kernel would. Use
  `transformArray` with `buildLut: false`.
- **Speed of the instrument is irrelevant.** Hit rate converges after
  a few hundred thousand pixels, so 6–11 MPx/s is ample — no need for
  full-resolution runs.
- **Only the hit rate transfers — never the timings.** The cost sides
  are completely different: register pressure and branch
  misprediction dominate in the kernels and are near-free on the
  pipeline path. Accuracy-path speed numbers are not a kernel verdict.

Count per image: single-entry hits, 2-entry hits, and 16/32-slot table
hits. That alone decides which shape (if any) is worth building.

Corpus must include:

- photographs (the case that pays the tax)
- UI screenshots and flat vector art (the case that pays out)
- **dithered / halftone content** — otherwise the bench looks better
  than reality, since that is the branch-mispredict case
- the noise / gradient / solid synthetics, mirroring `BENCH_INPUT` in
  the native harness (`bench/lcms_c/`) so results line up with the
  lcms measurements

Then, only if the hit rate justifies it: the miss-path tax on the
accuracy path and on the int kernel, measured separately.

One prior observation worth re-checking: our 4D kernel measured ~20 %
*slower* on uniform content than on noise, so the flat-art win starts
from a slightly worse baseline than the noise numbers suggest.

## As built (2026-08-17)

`src/cache.js`, attached to `Transform.prototype` like `stages.js` and
`interp.js`. Opt in with `pixelCache: 0 | 1 | 16 | 32` (0 = off, the
default; 1 = single entry; anything else rounds down to a power of
two). Read counters with `getPixelCacheStats()` →
`{enabled, slots, hits, misses, lookups, hitRate}`; also
`resetPixelCacheStats()` and `clearPixelCache()`.

Two stages are injected after `optimisePipeline()` and before the
pipeline-validity check. The walk in `transform()` gained a third arm
(`if pipelineDebug … else if cache … else …`) that reads `stage.step`.

**Three things the design notes got wrong, found by building it:**

1. **The boundary can't be located from encodings or options.** First
   attempt scanned encodings — but `stage_device_to_int` labels its
   output `device`, and encoding `3` is *both* `LabD50` (an object) and
   `PCSXYZ` (an array). Second attempt used options
   (`convertInputOutput ? 1 : 0`) — but a Lab input profile's stage 0
   emits a `{L,a,b}` **object**, so position 1 holds nothing
   cacheable, and it scored zero hits everywhere. The position also
   depends on what the *optimiser* did, which no option records.
   Resolved by walking one probe colour from
   `_buildValidationInput()` at build time and taking the first
   position holding a numeric array of the right length — the same
   technique `validatePipeline()` already uses. The store position uses
   a marker to the **first output-conversion stage**, which survives
   optimisation because no optimiser pattern matches
   `stage_device_to_*`.

2. **A fixed quantiser in the hash is a bug, not a detail.** The first
   hash used `(value * 65536) | 0`, assuming device floats in 0..1.
   The boundary often holds **raw integers** instead (0..255 /
   0..65535), where that multiply pushes all the entropy out of range
   and collapses distinct colours into one slot — an interleaved
   3-colour test scored 9 hits instead of 27. There are now two
   build-time variants: `stage_pixelCache_keyedInt` (one `imul` on the
   value) and `stage_pixelCache_keyed` (hashes the double's raw bits,
   scale-free). **`dataFormat` cannot choose between them** — `*sRGB`
   + int8 leaves raw ints at the boundary while `*Lab` + int8 leaves
   floats — so the variant is detected from the probe colour.
   Misdetection is harmless: the hash only picks a bucket and the
   stored key is still compared exactly, so a wrong guess costs hit
   rate, never correctness.

3. **`transformArray` needed a separate implementation.** Its
   per-pixel walks increment blindly, so they would re-run the maths
   on a value a hit had already resolved. A `cache active?` test
   inside those loops measured ~2.5% on the *uncached* path, so the
   cached case now routes to a generic `_transformArrayCached()` and
   the unrolled loops are byte-identical to before. (That 2.5% later
   proved to be mostly measurement noise on a loaded box — a
   controlled A/B put it near 1% — but the restructure makes
   "cache-off costs nothing" structural rather than something to
   re-measure.)

**Declines rather than misbehaves** when it cannot guarantee
correctness: `pipelineDebug` on (a jump would fabricate a history that
never ran), custom stages present (a hit would skip their side
effects), no numeric-array position before the output conversion, or
the output marker lost to the optimiser.

**Unrelated regression caught on the way.** `pipelineDebug` had been
broken since the v1.5.5 stages split: `addDebugHistory` moved to
`stages.js` while the module-scope `data2String` it calls stayed in
`Transform.js`. All 488 tests passed regardless, because none of them
switched debug on. Fixed by moving the helper, and
`__tests__/pipeline_debug.tests.js` now covers that path.

## Open questions

- Does the accuracy-path hypothesis hold? (Cheapest, highest-value
  test.)
- Does the run-scan restructure actually beat the memo, or does V8
  handle the spill better than expected?
- Is dithered continuous-tone input a real workload? Normally you
  transform *before* screening, and post-screen 1-bit data never
  reaches a colour transform — if so, option (2) and (3) both lose
  their justification and (1) is the whole story.
- Interaction with `preserveAlpha` and the identity `_kernelCopy`
  path — both already skip work; confirm no double-counting.
