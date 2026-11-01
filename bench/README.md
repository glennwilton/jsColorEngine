# `bench/`

The little that has to stay with the engine. Everything else that measures it,
including the LittleCMS comparison, lives in
[jsColorEngine-harness](https://github.com/glennwilton/jsColorEngine-harness).

- [`mpx_summary.js`](./mpx_summary.js): the throughput gate. `node bench/mpx_summary.js`.
  It needs no harness, so a change can be gated from this repository alone.
- [`lib/benchContent.cjs`](./lib/benchContent.cjs) and [`images/`](./images/): the test content it runs on.
- [`pixel_cache_wasm/`](./pixel_cache_wasm/): builds the paired `interp_*_cached`
  kernels. `scripts/compile_kernel_wat.js` and the pixel cache tests depend on it,
  so it is part of building the engine rather than measuring it.
- [`baseline/`](./baseline/): the pinned run that `scripts/bench_compare.js` gates
  against. See [`baseline/README.md`](./baseline/README.md).
- [`history/`](./history/): frozen measurements per release, read by
  `scripts/check_release_snapshot.js`. See [`history/README.md`](./history/README.md).

Current numbers are in [`docs/BenchResults.md`](../docs/BenchResults.md).

## Getting the harness

Clone it inside this repository, where it is gitignored:

```bash
git clone https://github.com/glennwilton/jsColorEngine-harness harness
```
