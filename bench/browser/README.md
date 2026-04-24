# jsColorEngine — Browser Bench (source)

A fully self-contained, zero-upload, in-browser benchmark for
jsColorEngine. Runs every `lutMode` against the real `lcms-wasm`
library directly in your browser. Clone the repo, start a static
server, open `localhost:8080/`, and you've reproduced the numbers
in [`../../docs/Performance.md`](../../docs/Performance.md) on your
own hardware.

**For the full user-facing guide — methodology, all five tabs,
how to submit your results — see
[`docs/Bench.md`](../../docs/Bench.md).** This file covers the
source layout only.

## Quickstart

From the repo root:

```sh
npm run browser                                       # build UMD bundle (once)
cd bench/lcms-comparison && npm install && cd ../..   # one-time, enables lcms rows
npm run bench:browser                                 # or: node bench/browser/serve.js
```

Then open <http://localhost:8080/>. Stop with `Ctrl+C`.

## Source layout

| File             | Purpose                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| `index.html`     | Page chrome, five tabs, controls, results tables, and the in-page "About this bench" methodology essay           |
| `styles.css`     | All styling. Dark slate + lime accent. No framework, no build step                                               |
| `main.js`        | Bench orchestrator (ES module) — detection, Transform builds, timing, result rendering, markdown export          |
| `lcms-runner.js` | Thin `lcms-wasm` wrapper (dynamic ESM import, pinned heap buffers, probe for SIMD opcodes in the shipped `.wasm`) |
| `serve.js`       | Zero-dep Node static HTTP server. Sets `.wasm` / `.icc` MIME types and CORS / COOP / COEP headers                |

## The five tabs

1. **Full comparison** — every direction × every mode, headline MPx/s table + summary cards
2. **Accuracy sweep** — Lab → device → Lab round-trip, ΔE76 stats, jsColorEngine only
3. **JIT warmup curve** — per-iter ms plotted across N iters, shows Ignition → Sparkplug → TurboFan tier-up
4. **Pixel-count sweep** — same direction × mode swept from 4 K to 4 M pixels, exposes L1 / L2 / L3 transitions
5. **About this bench** — in-page methodology essay (duplicate of the content in `docs/Bench.md`)

Full description of each tab, the modes compared, the methodology,
and the submission template live in
[`../../docs/Bench.md`](../../docs/Bench.md).

## Stopping the server

`Ctrl+C` in the terminal running `node bench/browser/serve.js`.
