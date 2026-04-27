# Sample apps

The `samples/` directory holds runnable HTML demos of `jsColorEngine` plus
the small helper module they all share.

> **Live demos:** <https://www.o2creative.co.nz/jscolorengine/samples/>
>
> **Source:** <https://github.com/glennwilton/jsColorEngine/tree/main/samples>
>
> **License:** the engine in `src/` is **MPL-2.0**; everything in `samples/`
> is **MIT** (see [`samples/LICENSE`](../samples/LICENSE)). Copy the
> samples freely.

## Helper

| File | Purpose |
|---|---|
| [`samples/iccimage.js`](../samples/iccimage.js) | Small immutable image wrapper (`ICCImage`). The thing every demo loads. |
| [`samples/ICCImage.md`](../samples/ICCImage.md) | Full API reference for the helper. |

`ICCImage` exists to make the "I have an image, I want to display / proof /
inspect it" workflow a one-liner. It is *not* a general-purpose image
library — see [`ICCImage.md`](../samples/ICCImage.md) for the design tenets
and the explicit list of what's deliberately missing.

## Demos

| File | Status | Demonstrates |
|---|---|---|
| [`live-video-softproof.html`](../samples/live-video-softproof.html) | Ready | **Real-time video soft-proofing.** Every frame decoded and run through a full ICC sRGB → CMYK → sRGB pipeline via a pre-built 3D CLUT — in real time. Pure JS, no WASM (for the transform), no WebGL, no workers. 40+ fps on 720p. |
| [`softproof.html`](../samples/softproof.html) | Ready | Soft-proof an sRGB image through a CMYK profile + render the C / M / Y / K plates as tinted previews. Floating colour picker with Lab, sRGB, CMYK, Delta E 2000 and Delta E 76. Shows `toProof`, `toSeparation`, `renderChannelAs`, `pixel()`, intent + BPC controls. |
| [`softproof-vs-lcms.html`](../samples/softproof-vs-lcms.html) | Ready | Side-by-side jsColorEngine vs lcms-wasm comparison. Same image, same profile, same pipeline — pixel-by-pixel diff visualisation with logarithmic gain slider (up to 128×), signed RGB mode, CMYK + RGB accuracy stats, speed ratio. |
| [`index.html`](../samples/index.html) | Ready | Project landing page (overview; links to samples and bench). |
| [`samples.html`](../samples/samples.html) | Ready | Sample hub with demo index, local run instructions, and `ICCImage` links. |

### Planned demos (from [Roadmap §v1.4](./Roadmap.md))

| Demo | Will show |
|---|---|
| `colour-calculator.html` | Per-pixel `pixel(x, y)` — Lab + sRGB + device readout via the no-LUT accuracy path. |
| `intent-comparison.html` | Side-by-side perceptual / relative / saturation / absolute through the same proof profile. |

## Running locally

The engine ships a UMD bundle at `browser/jsColorEngineWeb.js` that the
demos load via a `<script>` tag (it exposes `window.jsColorEngine`).

```bash
npm run browser          # rebuild browser/jsColorEngineWeb.js
npm run serve  # start dev server on :8080 (samples + browser bench)
# then open http://localhost:8080/samples/  (landing)
#    demos index: http://localhost:8080/samples/samples.html
#    bench: http://localhost:8080/samples/bench/
```

For the soft-proof and comparison demos, drop one or more CMYK ICC profiles
into `samples/profiles/` (e.g. `CoatedGRACoL2006.icc` from
[color.org](https://www.color.org/registry/index.xalter), or
`ISOcoated_v2_eci.icc` from [eci.org](http://www.eci.org/)).

The vs-lcms demo also requires the lcms-wasm dist files in
`samples/lcms-wasm-dist/` (see the README in that folder).
