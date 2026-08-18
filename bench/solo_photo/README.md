# `bench/solo_photo/` — the control bench

One photograph. One engine. One process. Nothing else loaded.

This exists because every other harness in the repo measures several
things in sequence, and this project has twice been caught by a harness
distorting what it measures:

- the old benches reported ~210 MPx/s on an input that contained
  [256 distinct colours](../../docs/deepdive/benchmark.md#20-two-more-ways-the-input-lied-2026-08-19);
- a shared process was shown to cost 27 % on an identical workload
  ([Schrödinger's Bench](../../docs/deepdive/benchmark.md#19-schrödingers-bench---a-new-law-of-benchmarking-in-v8)).

After correcting the first, throughput roughly halved — which raises the
obvious objection that the *new* harness might be depressing numbers the
way the old one inflated them. This file is the answer to that
objection, and it must stay minimal to be worth anything.

## What it deliberately does not do

- **No second engine in the process.** `--engine` constructs exactly
  one, so no call site ever sees two kernel shapes.
- **No second content type**, no second buffer size.
- **No `lcms-wasm` import.** A 300 KB WASM module and its heap sitting
  next to the timed code is precisely the kind of neighbour being ruled
  out.

Each engine runs in `--repeat` independent processes, each warmed for
3 s before any sample is taken. The parent reports every process's
result plus the spread, because the question is *how stable is this
number* and a median hides that.

## Running it

```bash
node bench/release_matrix/make_corpus.cjs        # once — decodes the photos
node bench/solo_photo/solo.js
node bench/solo_photo/solo.js --repeat 9 --workflow rgb2cmyk
node bench/solo_photo/solo.js --image rod-long-4dcsLxQxSHY-unsplash_BEACH
node bench/solo_photo/solo.js --child --engine simd    # one raw measurement
```

Workflows: `rgb2lab`, `rgb2rgb`, `rgb2cmyk`, `cmyk2rgb`.
Engines: `int` (pure JS), `scalar` (WASM), `simd` (WASM).

## Result (2026-08-19, Ryzen 7700X, Node 24)

Strawberries frame, 1 M px, best of 7 samples per process, 5 processes:

| engine | RGB → Lab | RGB → CMYK | spread |
|---|---:|---:|---:|
| `int` (pure JS) | 53.5 | 48.0 | 0.4–2.0 % |
| WASM scalar | 76.6 | 66.5 | 0.4–0.7 % |
| WASM SIMD | 115.2 | 113.7 | 0.9–1.1 % |

**The release matrix reports 52.7 / 110.9 for the same image and
workflow.** Two harnesses sharing no measurement code agreeing to within
a few per cent is the evidence that the matrix is not distorting its
figures — so the halving after the generator fix was the input, not the
harness.

It also fills in the tier the main tables skip: WASM scalar sits between
plain JS and SIMD at roughly 1.4× over JS and 0.6× of SIMD, about what
four-lane vectorisation predicts. That is a useful check that the SIMD
number is width rather than an artifact.

## Warmup is a measurement parameter

An earlier ~10 % run-to-run swing was put down to machine noise and
later traced to an 800 ms warmup being too short. At 3 s the same
measurement is stable to ~1 %. An under-warmed run looks exactly like a
noisy one, so if you shorten `WARMUP_MS` here, expect the spread column
to be the thing that tells you.
