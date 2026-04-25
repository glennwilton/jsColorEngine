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

## Modes covered (current)

The full-comparison table runs **every direction × every mode** below:

| Mode (jsCE)                  | I/O width | LUT cells | Notes                                                                                                              |
| ---------------------------- | --------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| `no-LUT (f64)`               | u8        | —         | Per-pixel f64 pipeline. Accuracy ceiling for jsCE.                                                                 |
| `float`                      | u8        | f64       | Float64 CLUT + f64 tetra interp.                                                                                   |
| `int`                        | u8        | u16       | Q0.16 weighted CLUT, int32 tetra via `Math.imul`. v1.1 baseline.                                                   |
| **`int16` (u16 I/O)**        | **u16**   | **u16**   | **v1.3.** u16-scaled CLUT (Q0.13 weights), JS u16 kernel. Bit-exact identity round-trip (≤1 LSB). For HDR / 16-bit TIFF / measurement workflows. |
| **`int16-wasm-scalar`**      | **u16**   | **u16**   | **v1.3.** WASM port of `int16`. Bit-exact with JS u16 (0 LSB delta). ~1.4× over `int16` on 3D.                    |
| **`int16-wasm-simd`**        | **u16**   | **u16**   | **v1.3.** WASM SIMD u16 kernel (channel-parallel `v128`, Q0.13). Bit-exact with both `int16` and `int16-wasm-scalar`. ~1.7–2.4× over `int16-wasm-scalar`, ~3.9–4.9× over `lcms 16-bit` best. Falls back to scalar on hosts without WASM SIMD. |
| `int-wasm-scalar`            | u8        | u16       | Same int math compiled to WebAssembly.                                                                             |
| `int-wasm-simd`              | u8        | u16       | Channel-parallel WASM SIMD (v128). Fastest mode on a SIMD-capable host.                                            |

| Mode (lcms-wasm)             | I/O width | Flags                          | Notes                                                                          |
| ---------------------------- | --------- | ------------------------------ | ------------------------------------------------------------------------------ |
| `lcms default`               | u8        | `0`                            | Default real-app config. Pinned heap buffers via `_cmsDoTransform`.            |
| `lcms HIGHRES`               | u8        | `cmsFLAGS_HIGHRESPRECALC`      | Big precalc LUT (49 RGB / 23 CMYK).                                            |
| `lcms NOOPT`                 | u8        | `cmsFLAGS_NOOPTIMIZE`          | No precalc LUT — full pipeline per pixel. Accuracy comparison vs jsCE no-LUT.  |
| **`lcms default 16`**        | **u16**   | `0`                            | **v1.3.** Same precalc grid as the 8-bit row, but u16 I/O. Compare vs jsce `int16`. |
| **`lcms HIGHRES 16`**        | **u16**   | `cmsFLAGS_HIGHRESPRECALC`      | **v1.3.** 16-bit + max grid.                                                   |
| **`lcms NOOPT 16`**          | **u16**   | `cmsFLAGS_NOOPTIMIZE`          | **v1.3.** 16-bit pipeline accuracy comparison.                                 |

Full table = 4 directions × (8 jsCE modes + 6 lcms-wasm flag/width combos) = **56 cells**.

## Stopping the server

`Ctrl+C` in the terminal running `node bench/browser/serve.js`.
