# Examples

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Bench](./Bench.md) ·
[Performance](./Performance.md) ·
[Roadmap](./Roadmap.md) ·
[Deep dive](./deepdive/) ·
[API: Profile](./Profile.md) ·
[Transform](./Transform.md) ·
[Loader](./Loader.md)

---

The [project README](../README.md) has the short tour (single colour,
image bytes, and a soft-proof chain). This page collects the rest —
working snippets for scenarios the README doesn't have room for.

All snippets are real, runnable code. You'll need the relevant ICC
profile files for examples that load from disk; the
[`__tests__/GRACoL2006_Coated1v2.icc`](../__tests__/GRACoL2006_Coated1v2.icc)
profile shipped with the repo works for every CMYK example here.

> A full folder of self-contained HTML demos is planned for
> `samples/` — this page covers code-snippet-level recipes today.

## Contents

- [Canvas round-trip — soft-proof into a `<canvas>`](#canvas-round-trip--soft-proof-into-a-canvas)
- [Insert a custom pipeline stage](#insert-a-custom-pipeline-stage)

---

## Canvas round-trip — soft-proof into a `<canvas>`

The trap: `transformArray` returns a raw typed array, not an
`ImageData`. You can't hand its result directly to `putImageData` —
you have to allocate a fresh `ImageData` via
`ctx.createImageData()` and copy the transformed bytes into its
`.data` buffer. This snippet is the full read-modify-write pattern.

See [issue #1](https://github.com/glennwilton/jsColorEngine/issues/1)
for the history of this one.

```html
<script src="jsColorEngineWeb.js"></script>
<script>
(async () => {
    const { Profile, Transform, eIntent } = jsColorEngine;

    const cmyk = new Profile();
    await cmyk.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');

    // Build a single soft-proof transform: sRGB -> CMYK -> sRGB.
    // BPC is per-stage: on for the perceptual leg, off for the relative leg.
    // dataFormat:'int8' guarantees a Uint8ClampedArray output that can drop
    // straight into ImageData. buildLut speeds up the per-pixel loop.
    const proof = new Transform({
        buildLut: true,
        dataFormat: 'int8',
        BPC: [true, false]
    });
    proof.createMultiStage([
        '*sRGB',  eIntent.perceptual,
        cmyk,     eIntent.relative,
        '*sRGB'
    ]);

    const img = document.getElementById('source');         // an <img> already loaded
    const canvas = document.getElementById('preview');     // a <canvas> in the DOM
    canvas.width  = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const src = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Input has alpha (RGBA), output also has alpha — preserveAlpha copies
    // it through. The result is a Uint8ClampedArray of the same length.
    const proofedBytes = proof.transformArray(src.data, true, true);

    // You MUST allocate a fresh ImageData; you cannot pass a raw typed
    // array to putImageData.
    const out = ctx.createImageData(canvas.width, canvas.height);
    out.data.set(proofedBytes);
    ctx.putImageData(out, 0, 0);
})();
</script>
```

## Insert a custom pipeline stage

Custom stages let you intercept the pipeline at a known location (here, at
the PCS — Profile Connection Space, between the input and output profiles)
and modify the values. Useful for desaturation previews, channel swaps,
gamut warnings, etc. The stage runs inside the LUT build so you only pay
the cost once.

```js
const { Profile, Transform, eIntent, encoding } = require('jscolorengine');

(async () => {
    const cmykProfile = new Profile();
    await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');

    // A stage that converts whatever's at the PCS to grey.
    const desaturateAtPCS = {
        description: 'Convert to Grey',
        location: 'PCS',
        stageData: null,
        stageFn: function (input, data, stage) {
            if (stage.inputEncoding === encoding.PCSXYZ) {
                // XYZ at PCS — set X and Z to Y (rough greyscale approximation)
                input[0] = input[1];
                input[2] = input[1];
            } else {
                // Lab at PCS — zero the chroma (a, b → 0.5 in normalised PCS)
                input[1] = 0.5;
                input[2] = 0.5;
            }
            return input;
        }
    };

    const greyToCMYK = new Transform();
    greyToCMYK.create('*lab', cmykProfile, eIntent.perceptual, [desaturateAtPCS]);
})();
```

Custom stages can be added at any location the pipeline exposes:

- **Input encoding** — right after input decode, before matrix/curves
- **PCS** — between input and output profiles (the most common place)
- **Output encoding** — right before output encode, after matrix/curves

See [`src/Transform.js`](../src/Transform.js) `stageFn` documentation
for the full signature and available locations.

---

## More recipes

If you've got a working snippet for something not covered here — gamut
warning, soft-proof strip, spectral-to-RGB demo, workflow diff —
we'd love to add it. Open an issue or PR.

## Related

- [Project README](../README.md) — install, quick start, the two basic examples
- [Deep dive](./deepdive/) — how the engine works and why it's fast
- [Performance](./Performance.md) — benchmark numbers and learnings
- [Transform API reference](./Transform.md) — full constructor options, method signatures
- [Profile API reference](./Profile.md) — profile loading, virtual profiles, tag access
