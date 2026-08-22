# Examples

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Bench](./Bench.md) ·
[Performance](./deepdive/Performance.md) ·
[Roadmap](./Roadmap.md) ·
[Deep dive](./deepdive/) ·
[API: Profile](./Profile.md) ·
[Transform](./Transform.md) ·
[Loader](./Loader.md)

---

The [project README](../README.md) has the short tour (single colour,
image bytes, and a soft-proof chain). This page collects the rest —
working snippets for scenarios the README doesn't have room for.

`transform.array()` is the batch entry. Native units; the container
matches `dataFormat`. `transformArray()` is the same call plus an
optional `outputFormat` via `Transform.reformat`. After either,
`transform.lastUsedKernel` is the kernel `name`, or `'pipeline'` /
`'cache'`. See [Transform.md](./Transform.md).

All snippets are real, runnable code. You'll need the relevant ICC
profile files for examples that load from disk; the
[`__tests__/GRACoL2006_Coated1v2.icc`](../__tests__/GRACoL2006_Coated1v2.icc)
profile shipped with the repo works for every CMYK example here.

> Self-contained HTML demos live in [`samples/`](../samples/) and are
> [running online](https://www.o2creative.co.nz/jscolorengine/samples/) —
> this page covers code-snippet-level recipes.

## Contents

- [Canvas round-trip — soft-proof into a `<canvas>`](#canvas-round-trip--soft-proof-into-a-canvas)
- [Insert a custom pipeline stage](#insert-a-custom-pipeline-stage)
- [LUT hook — inverted colour (input hook)](#lut-hook--inverted-colour-input-hook)
- [LUT hook — TAC limiter (output hook)](#lut-hook--tac-limiter-output-hook)
- [LUT hook — debug logger (output hook with source context)](#lut-hook--debug-logger-output-hook-with-source-context)
- [LUT hook — chaining multiple hooks](#lut-hook--chaining-multiple-hooks)
- [ΔE analysis — measuring colour accuracy of a conversion](#δe-analysis--measuring-colour-accuracy-of-a-conversion)
- [16-bit Lab helpers — decoding int16 Lab output](#16-bit-lab-helpers--decoding-int16-lab-output)
- [Which path ran — `lastUsedKernel`](#which-path-ran--lastusedkernel)

---

## Canvas round-trip — soft-proof into a `<canvas>`

The trap: `array()` returns a raw typed array, not an
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
    const proofedBytes = proof.array(src.data, true, true);

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
const out = xf.array(src, false, false, false, 2);
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
    const result = xf.array(pixels, false, false, false, 2);
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

// Now array() runs at full speed — no hooks involved.
const img = new Uint8ClampedArray(1024 * 3);
const out = xf.array(img, false, false, false, 1024);
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
// At runtime, array() is full speed — hooks are baked in.
```

Hooks must be added **after** `new Transform()` and **before**
`create()` — `create()` is when the LUT is built and the hooks fire.
Use `clearLutHooks()` if you need to rebuild with different hooks.

---

## ΔE analysis — measuring colour accuracy of a conversion

This example uses the accuracy path (`transform()` per colour) to
convert a set of test colours through RGB→CMYK and back to Lab,
then measures the colour difference (ΔE2000) introduced by the
round-trip. This is the right tool for colour analysis — single
colours, full f64 precision, no LUT quantisation.

```js
const { Profile, Transform, eIntent, convert, color } = require('jscolorengine');

(async () => {
    const cmykProfile = new Profile();
    await cmykProfile.loadPromise('./profiles/GRACoL2006_Coated1v2.icc');

    // Three accuracy-path transforms (no buildLut — full f64 pipeline)
    const rgb2cmyk = new Transform();
    rgb2cmyk.create('*srgb', cmykProfile, eIntent.relative);

    const rgb2lab = new Transform();
    rgb2lab.create('*srgb', '*lab', eIntent.relative);

    const cmyk2lab = new Transform();
    cmyk2lab.create(cmykProfile, '*lab', eIntent.relative);

    // Test colours as RGB byte values
    const testColours = [
        { name: 'White',      rgb: color.RGB(255, 255, 255) },
        { name: 'Mid grey',   rgb: color.RGB(128, 128, 128) },
        { name: 'Red',        rgb: color.RGB(255, 0, 0) },
        { name: 'Green',      rgb: color.RGB(0, 255, 0) },
        { name: 'Blue',       rgb: color.RGB(0, 0, 255) },
        { name: 'Skin tone',  rgb: color.RGB(230, 180, 153) },
        { name: 'Deep cyan',  rgb: color.RGB(0, 128, 192) },
        { name: 'Rich black', rgb: color.RGB(5, 5, 5) },
    ];

    const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
    const num = (v, w, d) => v.toFixed(d).padStart(w);

    console.log('RGB → CMYK round-trip ΔE2000 analysis\n');
    console.log(pad('Name', 12) + '  Source Lab                 Round-trip Lab           CMYK                    ΔE2000');
    console.log('-'.repeat(100));

    for (const { name, rgb } of testColours) {
        // RGB → Lab (source reference in Lab)
        const labSrc = rgb2lab.transform(rgb);

        // RGB → CMYK (the conversion under test)
        const cmyk = rgb2cmyk.transform(rgb);

        // CMYK → Lab (round-trip: how well does the CMYK reproduce the original?)
        const labDst = cmyk2lab.transform(cmyk);

        // ΔE2000 — perceptual colour difference
        const dE = convert.deltaE2000(labSrc, labDst);

        const srcStr = `L=${num(labSrc.L,6,2)} a=${num(labSrc.a,7,2)} b=${num(labSrc.b,7,2)}`;
        const dstStr = `L=${num(labDst.L,6,2)} a=${num(labDst.a,7,2)} b=${num(labDst.b,7,2)}`;
        const cmykStr = `C=${num(cmyk.C,3,0)} M=${num(cmyk.M,3,0)} Y=${num(cmyk.Y,3,0)} K=${num(cmyk.K,3,0)}`;
        console.log(`${pad(name,12)}  ${srcStr}  ${dstStr}  ${cmykStr}  ${num(dE,6,2)}`);
    }
})();
```

**What this demonstrates:**

- **`transform()`** is the accuracy path — f64 throughout, no LUT
  quantisation. Use it for colour analysis, ΔE calculations, and
  any workflow where you care about the last 0.01 ΔE.
- **`convert.deltaE2000()`** computes CIEDE2000 — the
  industry-standard perceptual colour difference metric.
- In-gamut colours (mid grey, skin tone) should show very low ΔE
  (< 1.0). Out-of-gamut colours (saturated blue, deep cyan) will
  show higher ΔE because the CMYK gamut can't reproduce them
  exactly — that's gamut mapping at work, not an engine error.

---

## 16-bit Lab helpers — decoding int16 Lab output

When you use `dataFormat: 'int16'` with a Lab output profile, the
`array()` result contains ICC-encoded u16 Lab values — not
human-readable `L 0–100, a/b -128..+127`. The `outputInt162Lab()`
helper on the Transform decodes them back to float Lab, respecting
whichever PCS encoding (v2 or v4) the profile uses.

This example bulk-converts an array of RGB pixels to Lab via the
int16 fast path, then decodes a few representative values to float
Lab for inspection.

```js
const { Profile, Transform, eIntent } = require('jscolorengine');

(async () => {
    // Build an int16 RGB → Lab transform (image-grade speed)
    const rgb2lab = new Transform({ dataFormat: 'int16', buildLut: true });
    rgb2lab.create('*srgb', '*lab', eIntent.relative);

    // Bulk convert — 4 pixels as u16 RGB
    const input = new Uint16Array([
        65535, 0, 0,            // red
        0, 65535, 0,            // green
        0, 0, 65535,            // blue
        32768, 32768, 32768,    // mid grey
    ]);
    const labU16 = rgb2lab.array(input, false, false);

    // labU16 is a Uint16Array of ICC-encoded Lab values.
    // Decode each pixel to float Lab for human consumption:
    for (let i = 0; i < 4; i++) {
        const off = i * 3;
        const lab = rgb2lab.outputInt162Lab(labU16[off], labU16[off + 1], labU16[off + 2]);
        console.log(`Pixel ${i}: L=${lab.L.toFixed(2)}, a=${lab.a.toFixed(2)}, b=${lab.b.toFixed(2)}`);
    }
    // Pixel 0: L=53.23, a=80.11, b=67.22   (red)
    // Pixel 1: L=87.74, a=-86.18, b=83.18  (green)
    // Pixel 2: L=32.30, a=79.20, b=-107.86 (blue)
    // Pixel 3: L=53.59, a=0.00, b=-0.01    (grey)
})();
```

**The four Lab helpers on Transform:**

These live on the Transform instance because they know which PCS
encoding (ICC v2 or v4) the profile uses — you don't have to.

- **`inputLab2Int16(L, a, b)`** — encode float Lab → u16 using the
  *input* profile's PCS. Use when building u16 Lab input values to
  feed into `array()`.
- **`outputLab2Int16(L, a, b)`** — encode float Lab → u16 using the
  *output* profile's PCS. Use when you need to construct expected
  output values for comparison.
- **`inputInt162Lab(uL, ua, ub)`** — decode u16 → float Lab using
  the *input* profile's PCS. Use when inspecting u16 input values.
- **`outputInt162Lab(uL, ua, ub)`** — decode u16 → float Lab using
  the *output* profile's PCS. Use when inspecting u16 output from
  `array()`, as shown above.

All four throw if the relevant profile's PCS is not Lab.

For the general-case encoding helpers (when you're not working
through a Transform), see `convert.lab2Int16(L, a, b, encoding)`
and `convert.int162Lab(uL, ua, ub, encoding)` — these take an
explicit encoding parameter (`'v2'`, `'v4'`, or an encoding
object from `convert.labEncoding`).

---

## Which path ran — `lastUsedKernel`

After `array()` (or `transformArray()`), `transform.lastUsedKernel`
names the route. Null until the first batch.

```js
const { Transform, eIntent, eColourType } = require('jscolorengine');

const lut = new Transform({ buildLut: true, dataFormat: 'int8' });
lut.create('*sRGB', '*AdobeRGB', eIntent.relative);
lut.array(new Uint8ClampedArray([255, 0, 0]), false, false);
console.log(lut.lastUsedKernel);        // 'kernel3D' or 'matrix-shaper'

const same = new Transform({ dataFormat: 'object' });
same.create('*sRGB', '*sRGB', eIntent.relative);
same.array([{ type: eColourType.RGB, R: 12, G: 34, B: 56 }]);
console.log(same.lastUsedKernel);       // 'kernelIdentity'
// clones — mutating the output does not write through to the input
```

| Configuration | `lastUsedKernel` |
|---|---|
| Identity (same file twice, any `dataFormat`) | `'kernelIdentity'` |
| `int8` / `int16` LUT | `'kernel3D'` / `'kernel4D'` / … |
| Matrix-shaper pair, no LUT | `'matrix-shaper'` |
| Object colour conversion, or no LUT and no claim | `'pipeline'` |
| `pixelCache` live | `'cache'` |

`transformArrayViaLUT()` is the same work with a throw if there is no
table. Use it when a missing LUT must be a hard error (video loops).

---

## More recipes

If you've got a working snippet for something not covered here — gamut
warning, soft-proof strip, spectral-to-RGB demo, workflow diff —
we'd love to add it. Open an issue or PR.

## Related

- [Project README](../README.md) — install, quick start, the two basic examples
- [Transform API reference](./Transform.md) — `array()`, `lastUsedKernel`, constructor options
- [Bench](./Bench.md) / [BenchResults](./BenchResults.md) — current throughput
- [deepdive/Performance.md](./deepdive/Performance.md) — measurement retrospective
- [Deep dive](./deepdive/) — how the engine works and why it's fast
- [Profile API reference](./Profile.md) — profile loading, virtual profiles, tag access
- [Plugin.md](./Plugin.md) — custom `lutMode` and `t.use()`
