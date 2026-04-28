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
- [LUT hook — inverted colour (input hook)](#lut-hook--inverted-colour-input-hook)
- [LUT hook — TAC limiter (output hook)](#lut-hook--tac-limiter-output-hook)
- [LUT hook — debug logger (output hook with source context)](#lut-hook--debug-logger-output-hook-with-source-context)
- [LUT hook — chaining multiple hooks](#lut-hook--chaining-multiple-hooks)

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

    // Always wrap profile loading in try/catch — profiles can be corrupt,
    // missing, or served with wrong MIME type. Check .loaded afterwards.
    const cmyk = new Profile();
    try {
        await cmyk.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');
    } catch (err) {
        console.error('Profile load failed:', err.message);
        return;
    }
    if (!cmyk.loaded) {
        console.error('Profile invalid or unsupported:', cmyk.lastError);
        return;
    }

    // Build a single soft-proof transform: sRGB -> CMYK -> sRGB.
    // BPC is per-stage: on for the perceptual leg, off for the relative leg.
    // dataFormat:'int8' guarantees a Uint8ClampedArray output that can drop
    // straight into ImageData. buildLut speeds up the per-pixel loop.
    const proof = new Transform({
        buildLut: true,
        dataFormat: 'int8',
        BPC: [true, false]
    });
    try {
        proof.createMultiStage([
            '*sRGB',  eIntent.perceptual,
            cmyk,     eIntent.relative,
            '*sRGB'
        ]);
    } catch (err) {
        console.error('Transform create failed:', err.message);
        return;
    }

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
    try {
        await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');
    } catch (err) {
        console.error('Profile load failed:', err.message);
        return;
    }
    if (!cmykProfile.loaded) {
        console.error('Profile invalid or unsupported:', cmykProfile.lastError);
        return;
    }

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
    try {
        greyToCMYK.create('*lab', cmykProfile, eIntent.perceptual, [desaturateAtPCS]);
    } catch (err) {
        console.error('Transform create failed:', err.message);
        return;
    }
})();
```

Custom stages can be added at any location the pipeline exposes:

- **Input encoding** — right after input decode, before matrix/curves
- **PCS** — between input and output profiles (the most common place)
- **Output encoding** — right before output encode, after matrix/curves

See [`src/Transform.js`](../src/Transform.js) `stageFn` documentation
for the full signature and available locations.

---

## LUT hook — inverted colour (input hook)

An **input hook** warps the device values before the profile transform
runs. Here we invert the RGB input so the resulting LUT bakes the
inversion into every grid cell — at runtime the kernel runs at full
speed with zero per-pixel overhead.

```js
const { Transform, eIntent } = require('jscolorengine');

const xf = new Transform({
    dataFormat: 'int8',
    buildLut:   true,

    // Input hook: invert RGB before the profile transform.
    // Each channel is device-space [0–1], so 1 − v flips it.
    lutInputHook: (rgb) => [1 - rgb[0], 1 - rgb[1], 1 - rgb[2]],
});

xf.create('*srgb', '*adobergb', eIntent.relative);

// Every pixel that goes through this transform now gets a
// colour-managed inversion — not a naive byte flip, but an
// inversion that passes through the full profile pipeline.
const src = new Uint8ClampedArray([255, 0, 0,  0, 128, 255]);
const out = xf.transformArray(src, false, false, false, 2);
// out: inverted + gamut-mapped to AdobeRGB
```

---

## LUT hook — TAC limiter (output hook)

An **output hook** modifies device values after the profile transform.
This example clamps Total Area Coverage (the sum of all CMYK
channels) to a maximum. When the total exceeds the limit, C, M, and Y
are scaled down proportionally while K is preserved — print workflows
often protect K because it carries the most visual weight.

> **Note:** This is a simplified demonstration, not a colorimetrically
> correct TAC strategy. Production GCR/UCR workflows typically operate
> in the profile's AToB/BToA tables or via ICC DeviceLink profiles,
> not post-transform hooks. Use this as a starting point.

```js
const { Profile, Transform, eIntent } = require('jscolorengine');

(async () => {
    const cmyk = new Profile();
    await cmyk.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');

    const TAC_LIMIT = 3.0;  // 300% expressed in [0–1] per channel

    const xf = new Transform({
        dataFormat: 'int8',
        buildLut:   true,

        // Output hook: if total ink > TAC_LIMIT, scale CMY
        // down to fit while keeping K untouched.
        lutOutputHook: (cmyk) => {
            const total = cmyk[0] + cmyk[1] + cmyk[2] + cmyk[3];
            if (total > TAC_LIMIT) {
                const cmyTotal = cmyk[0] + cmyk[1] + cmyk[2];
                if (cmyTotal > 0) {
                    const allowed = TAC_LIMIT - cmyk[3];
                    const scale   = allowed / cmyTotal;
                    cmyk[0] *= scale;
                    cmyk[1] *= scale;
                    cmyk[2] *= scale;
                }
            }
            return cmyk;
        },
    });

    xf.create('*srgb', cmyk, eIntent.perceptual);

    const pixels = new Uint8ClampedArray([10, 20, 30,  200, 100, 50]);
    const result = xf.transformArray(pixels, false, false, false, 2);
    // result: CMYK bytes with TAC guaranteed ≤ 300%
})();
```

---

## LUT hook — debug logger (output hook with source context)

Output hooks receive an optional **second argument** — the original
grid-cell input (read-only). This is perfect for build-time
debugging: you can log every (input → output) pair the LUT produces
without touching the values.

Because hooks only run during `create()` (once per grid cell, not once
per pixel), logging here is free at runtime — the kernel never calls
your hook.

```js
const { Transform, eIntent } = require('jscolorengine');

const xf = new Transform({
    dataFormat: 'int8',
    buildLut:   true,
    lutGridPoints3D: 5,   // small grid so the log is readable
});

// Log every grid sample during build.
xf.addLutOutputHook(function (deviceOut, deviceIn) {
    console.log(
        'IN  [%s] → OUT [%s]',
        deviceIn.map(v => v.toFixed(3)).join(', '),
        deviceOut.map(v => v.toFixed(3)).join(', ')
    );
    return deviceOut;   // pass through unchanged
});

xf.create('*srgb', '*adobergb', eIntent.relative);
// Console shows 125 lines (5³), e.g.:
//   IN  [0.000, 0.000, 0.000] → OUT [0.000, 0.000, 0.000]
//   IN  [0.000, 0.000, 0.250] → OUT [0.065, 0.047, 0.259]
//   ...
//   IN  [1.000, 1.000, 1.000] → OUT [1.000, 1.000, 1.000]

// Now transformArray runs at full speed — no hooks involved.
const img = new Uint8ClampedArray(1024 * 3);
const out = xf.transformArray(img, false, false, false, 1024);
```

---

## LUT hook — chaining multiple hooks

Multiple hooks can be added before `create()`. They run in the order
they were added — each hook receives the previous hook's output.

```js
const t = new Transform({ dataFormat: 'int8', buildLut: true });

t.addLutOutputHook(tacLimit);    // first: clamp TAC
t.addLutOutputHook(debugLog);    // second: log the clamped result

t.create('*srgb', cmykProfile, eIntent.perceptual);
// tacLimit ran on every grid cell, then debugLog saw the clamped values.
// At runtime, transformArray is full speed — hooks are baked in.
```

Hooks must be added **after** `new Transform()` and **before**
`create()` — `create()` is when the LUT is built and the hooks fire.
Use `clearLutHooks()` if you need to rebuild with different hooks.

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
