# Sample apps

The `samples/` directory holds runnable HTML demos of `jsColorEngine` plus
the small helper module they all share. Directory map and license:
[`samples/README.md`](https://github.com/glennwilton/jsColorEngine-samples/tree/main/README.md).

> **Live demos:** <https://www.o2creative.co.nz/jscolorengine/samples/>
>
> **Source:** <https://github.com/glennwilton/jsColorEngine/tree/main/samples>
>
> **License:** the engine in `src/` is **MPL-2.0**; everything in `samples/`
> is **MIT** (see [`samples/LICENSE`](https://github.com/glennwilton/jsColorEngine-samples/tree/main/LICENSE)). Copy the
> samples freely.

## Calling the engine

Demos use `transform.array()` (or `transformArray()`). That is the
batch entry — native units, container matches `dataFormat`. After the
call, `transform.lastUsedKernel` is the kernel `name`, or
`'pipeline'` / `'cache'`.

`transformArrayViaLUT()` is the same work with a throw if there is no
table. The live-video demo uses it so a missing LUT cannot silently
walk the pipeline on every frame.

See [Transform.md](./Transform.md) and the usage guide at the top of
`src/Transform.js`.

## Helper

| File | Purpose |
|---|---|
| [`samples/ICCImage/iccimage.js`](https://github.com/glennwilton/jsICCImage/blob/main/iccimage.js) | Small immutable image wrapper (`ICCImage`). The thing every demo loads. |
| [`samples/ICCImage/ICCImage.md`](https://github.com/glennwilton/jsICCImage/blob/main/docs/API.md) | Full API reference for the helper. |

`ICCImage` exists to make the "I have an image, I want to display / proof /
inspect it" workflow a one-liner. It is *not* a general-purpose image
library — see [`ICCImage.md`](https://github.com/glennwilton/jsICCImage/blob/main/docs/API.md) for the design tenets
and the explicit list of what's deliberately missing.

## Demos

| File | Status | Demonstrates |
|---|---|---|
| [`live-video-softproof.html`](https://www.o2creative.co.nz/jscolorengine/samples/live-video-softproof.html) | Ready | **Real-time video soft-proofing.** Every frame through a pre-built 3D CLUT via `transformArrayViaLUT` — JavaScript + WASM SIMD, one thread. |
| [`softproof.html`](https://www.o2creative.co.nz/jscolorengine/samples/softproof.html) | Ready | Soft-proof an sRGB image through a CMYK profile + C / M / Y / K plates. Colour picker with Lab, sRGB, CMYK, ΔE. |
| [`softproof-vs-lcms.html`](https://www.o2creative.co.nz/jscolorengine/samples/softproof-vs-lcms.html) | Ready | Side-by-side jsColorEngine vs lcms-wasm. Pixel-by-pixel diff, signed RGB, accuracy stats, speed ratio. |
| [`colour-calculator.html`](https://www.o2creative.co.nz/jscolorengine/samples/colour-calculator.html) | Ready | ICC-aware Lab / XYZ / RGB / CMYK converter on the accuracy path. |
| [`lut-cmyk-to-rgb.html`](https://www.o2creative.co.nz/jscolorengine/samples/lut-cmyk-to-rgb.html) | Ready | CMYK → RGB via a pre-baked portable LUT. |
| [`lut-tiff-builder.html`](https://www.o2creative.co.nz/jscolorengine/samples/lut-tiff-builder.html) | Ready | Generate / import LUT TIFFs ([LutBuilder](https://github.com/glennwilton/jsColorEngine-samples/tree/main/LutBuilder/lutbuilder.md)). |
| [`index.html`](https://www.o2creative.co.nz/jscolorengine/samples/index.html) | Ready | Project landing page. |
| [`samples.html`](https://www.o2creative.co.nz/jscolorengine/samples/samples.html) | Ready | Sample hub. |

### Plugins

[`samples/plugins/identity-plugin.js`](./Plugin.md#complete-example)
is a `Transform.register` demo (custom `lutMode`, builder + kernel).
Run with `node samples/plugins/identity-plugin.js`. Same-file pairs need
`detectIdentity: false` or the built-in identity kernel takes the batch
before the plugin runs. Tests: `__tests__/plugin_identity.tests.js`,
`__tests__/plugin_isolation.tests.js`. Contract: [Plugin.md](./Plugin.md).

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
