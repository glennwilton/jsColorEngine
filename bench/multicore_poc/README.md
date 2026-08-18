# Multicore experiment — Model A (transfer)

```bash
node bench/multicore_poc/run.js
node bench/multicore_poc/run.js --workers 1,2,4,8,auto,max --pixels 8000000
node bench/multicore_poc/run.js --workers 4 --pixels 262144 --minSlice 65536
```

The first experiment from [docs/deepdive/multicore.md](../../docs/deepdive/multicore.md).
**Uses the public API only — no engine changes.**

Build the LUT once, ship it to N workers as portable JSON, split the image
into ordinary `ArrayBuffer`s, transfer them, convert, transfer back,
reassemble. No `SharedArrayBuffer`, so no cross-origin isolation, no
imported WASM memory, no reclaim rework.

## Results (Ryzen 7700X, 8C/16T, Node 24, sRGB→GRACoL, `lutMode: 'int'`, 8 MP)

| workers | MPx/s | speedup | efficiency | copy overhead |
|---:|---:|---:|---:|---:|
| 1 | 41.8 | 0.95× | 95 % | 6.9 ms |
| 2 | 76.3 | 1.73× | 86 % | 7.1 ms |
| 4 | 130.5 | 2.96× | 74 % | 11.8 ms |
| 8 | 189.6 | 4.30× | 54 % | 7.3 ms |
| 12 | 237.3 | 5.38× | 45 % | 12.9 ms |
| 16 | 240.8 | 5.46× | 34 % | 8.4 ms |

Output byte-identical to single-threaded in every row.

**Three findings, in order of how much they matter.**

### 1. Model B is probably not worth building

The split-and-reassemble copies cost **7–13 ms against a 181 ms pass — 4–7 %**.
That is the entire prize `SharedArrayBuffer` would win, in exchange for
cross-origin isolation, imported WASM memory, and reworking the reclaim
path. The measurement that was supposed to decide between the two models
decides firmly for the cheap one.

### 2. The crossover is driven by SLICE size, not image size

| pixels | 8 workers |
|---:|---:|
| 16 K | 0.83× |
| 64 K | 0.87× |
| 256 K | 1.21× |
| 1 M | 3.73× |
| 4 M | 3.84× |

But at a fixed 262,144 px, varying the worker count:

| workers | slice | speedup |
|---:|---:|---:|
| 1 | 262 K | 0.93× |
| 2 | 131 K | 1.61× |
| **4** | **65 K** | **2.56×** |
| 8 | 32 K | 1.22× |

Same image, twice the workers, half the speed. **~64 K pixels per slice** is
the floor; below it the copy and the message round-trip stop being
amortised. So `auto` should derive the worker count from slice size:

```js
workers = clamp(floor(pixels / 65536), 1, autoMax)
```

which reproduces the measured optimum at every size tried.

### 3. Hyperthreads are worth ~25 %, not 100 %

Scaling is near-linear to 4, good to 8 (the physical core count), then
flattens: 12 and 16 workers land within noise of each other. `auto` at 75 %
of `availableParallelism` lands at 12 here, close to the peak, and leaves
the box usable.

## A trap worth knowing about

The **portable-LUT JSON round-trip is lossy by up to 1 LSB.** `toJSON()`
quantises the CLUT to u16 and `setLut()` re-derives the int LUT from it, so
a round-tripped transform differs from a freshly-built one on ~0.07 % of
output bytes, by exactly 1.

That is well inside the published accuracy envelope, but it is not
bit-identical — and it made the first run of this harness report a
correctness failure on every row, including single-worker. The bug was the
comparison, not the workers: the reference must carry the *same* LUT the
workers do.

A real implementation should ship the exact CLUT rather than JSON, which
avoids both the quantisation and the parse.

## Caveats

- Node `worker_threads`; browsers will be worse (slower spin-up).
- Noise input. Content does not matter here — no pixel cache involved.
- Workers are pooled and pre-warmed; spin-up is excluded from the timings,
  which is right for a long-lived pool and wrong for one-shot use.
