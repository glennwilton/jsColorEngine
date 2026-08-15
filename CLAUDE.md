# jsColorEngine — AI session entry point

Start at **[docs/README.md](./docs/README.md)** — the project summary
and document index (what the engine is, source map, where every doc
lives, current state). Regenerate it per
[docs/summary-generator.md](./docs/summary-generator.md) after doc-heavy
sessions.

Hard rules for this repo:

- **Never "clean up" the unrolled kernel loops** (`src/Transform.js`
  hot paths, `src/kernels/`, `src/interp.js`, `src/stages.js`) — read
  the PERFORMANCE LESSONS comment block at the top of
  `src/Transform.js` before touching them, and benchmark before/after
  any change.
- **Gates before committing engine changes:** `npx jest` fully green
  (488+ tests) and `node bench/mpx_summary.js` throughput parity.
- **Performance/accuracy claims need a runnable bench or oracle**, and
  comparisons are always single-threaded, apples-to-apples.
- Docs have owners: future plans → `docs/Roadmap.md`; measurement
  retrospectives → `docs/Performance.md`; release notes →
  `CHANGELOG.md`. Don't duplicate content across them.
