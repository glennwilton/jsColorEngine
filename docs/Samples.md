# Sample apps

The `samples/` directory holds runnable HTML demos of `jsColorEngine` plus
the small helper module they all share. Directory map and license:
[`samples/README.md`](../samples/README.md).

> **Live demos:** <https://www.o2creative.co.nz/jscolorengine/samples/>
>
> **Source:** <https://github.com/glennwilton/jsColorEngine/tree/main/samples>
>
> **License:** the engine in `src/` is **MPL-2.0**; everything in `samples/`
> is **MIT** (see [`samples/LICENSE`](../samples/LICENSE)). Copy the
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
| [`samples/ICCImage/iccimage.js`](../samples/ICCImage/iccimage.js) | Small immutable image wrapper (`ICCImage`). The thing every demo loads. |
| [`samples/ICCImage/ICCImage.md`](../samples/ICCImage/ICCImage.md) | Full API reference for the helper. |

`ICCImage` exists to make the "I have an image, I want to display / proof /
inspect it" workflow a one-liner. It is *not* a general-purpose image
library — see [`ICCImage.md`](../samples/ICCImage/ICCImage.md) for the design tenets
and the explicit list of what's deliberately missing.

## Demos

| File | Status | Demonstrates |
|---|---|---|
| [`live-video-softproof.html`](../samples/live-video-softproof.html) | Ready | **Real-time video soft-proofing.** Every frame through a pre-built 3D CLUT via `transformArrayViaLUT` — JavaScript + WASM SIMD, one thread. |
| [`softproof.html`](../samples/softproof.html) | Ready | Soft-proof an sRGB image through a CMYK profile + C / M / Y / K plates. Colour picker with Lab, sRGB, CMYK, ΔE. |
| [`softproof-vs-lcms.html`](../samples/softproof-vs-lcms.html) | Ready | Side-by-side jsColorEngine vs lcms-wasm. Pixel-by-pixel diff, signed RGB, accuracy stats, speed ratio. |
| [`colour-calculator.html`](../samples/colour-calculator.html) | Ready | ICC-aware Lab / XYZ / RGB / CMYK converter on the accuracy path. |
| [`lut-cmyk-to-rgb.html`](../samples/lut-cmyk-to-rgb.html) | Ready | CMYK → RGB via a pre-baked portable LUT. |
| [`lut-tiff-builder.html`](../samples/lut-tiff-builder.html) | Ready | Generate / import LUT TIFFs ([LutBuilder](../samples/LutBuilder/lutbuilder.md)). |
| [`index.html`](../samples/index.html) | Ready | Project landing page. |
| [`samples.html`](../samples/samples.html) | Ready | Sample hub. |

### Plugins

[`samples/plugins/identity-plugin.js`](../samples/plugins/identity-plugin.js)
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
