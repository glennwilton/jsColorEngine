# `LutBuilder` — practical guide

## Scope and positioning

jsColorEngine is primarily a **colour-accurate transform engine for professional work**. The core engine uses ICC profiles to produce accurate, auditable colour conversions — the kind required for prepress, regulated workflows, archival imaging, and cross-tool consistency.

`LutBuilder` was created as a practical companion to that core: a way to **pre-bake ICC-based transforms into portable LUT files**, to capture transforms from other colour engines (via the lcms-wasm bridge or the TIFF visual-editing workflow), and to validate that those LUTs reproduce the source transforms faithfully.

There are plenty of other uses for LUTs — colour grading, film emulation, photo effects, creative tone curves. We leave those entirely to the developer's imagination. The LutBuilder tooling works equally well for a sepia-tone creative effect as it does for a FOGRA-certified CMYK device link. We welcome feedback and contributions on creative uses, but they are outside the primary scope of the jsColorEngine project. The core commitment is to colour accuracy first.

---

`samples/LutBuilder/LutBuilder.js` covers four practical use cases:

1. **Pre-bake a transform** — build once with ICC profiles, ship JSON, run anywhere with no profiles at runtime.
2. **Capture any CMS** — export an identity TIFF, edit in Photoshop (or any colour-managed editor), reimport. The editor's CMS becomes your LUT.
3. **Bridge lcms-wasm** — bit-exact LittleCMS parity at WASM-SIMD speed. Build from lcms once, discard it, dispatch at full speed forever.
4. **Validate accuracy** — compare LUT output to a ground-truth image (Photoshop, lcms, or another tool) and get per-channel ΔP metrics.

> **Version:** jsColorEngine v1.4.4 — LutBuilder Stage 1–3 complete.
> **License:** MIT (separate from the engine's MPL-2.0).
> **Architecture / rationale:** see [`docs/deepdive/Luts.md`](../../docs/deepdive/Luts.md). This file is the how-to.

---

## Quick start

```js
const { Transform, eIntent } = require('jscolorengine');
const { LutBuilder, virtualRGB, virtualCMYK } = require('./LutBuilder');

// Identity LUT, hand to a Transform
const t = new LutBuilder()
    .createIdentity(3, 33)
    .setChain([virtualRGB('sRGB-like'), eIntent.perceptual, virtualRGB('sRGB-like')])
    .toTransform({ dataFormat: 'int8' });

const out = t.transformArray(new Uint8ClampedArray([255, 0, 0]));
// out → Uint8ClampedArray [ 255, 0, 0 ]
```

Or: build with profiles, save to JSON, load anywhere — no profiles needed at the consumer.

```js
// Producer (build time, has ICC profiles)
const producer = new Transform({ dataFormat: 'int8', buildLut: true });
producer.create('*srgb', cmykProfile, eIntent.perceptual);
fs.writeFileSync('srgb-to-cmyk.json', JSON.stringify(producer));

// Consumer (runtime, no profiles)
const consumer = Transform.fromJSON(fs.readFileSync('srgb-to-cmyk.json'),
                                    { dataFormat: 'int8' });
consumer.transformArray(rgbPixels);   // → CMYK output, full speed, no ICC code path
```

---

## What goes in, what comes out

LUTs at the API boundary are always **full-scale for their type**:

| Type | Range | Used for |
|---|---|---|
| `Float64Array` | `[0..1]` | The engine's canonical CLUT |
| `Uint16Array`  | `[0..65535]` | `getLut16()`, `LutBuilder` internal storage |
| `Uint8Array`   | `[0..255]` | `getLut8()` |

The kernel-internal `intLut` (with its 65280 scale and Q encoding) **never crosses any API boundary** — it lives inside `Transform` for WASM dispatch only.

---

## Why does the LUT carry a profile chain?

If you've worked with Hald CLUTs, `.cube` files, or 3D LUT plugins for video, you've seen LUT formats that are *just data* — no profiles, no metadata, no idea what colour space went in or came out. They work, but they're a black box: the moment you hand one off, the receiver has to guess what it does.

`jsColorEngine`'s LUT format requires a **chain** — `[inputDescriptor, intent, outputDescriptor]` (or longer for multi-stage). Three reasons:

**1. Pipeline routing — the engine literally needs it.**
When you call `setLut(lut)`, the engine reads the chain to set up the input and output stages of the pipeline:

- **Channel count** — `inputDescriptor.type` determines whether to expect 1ch (Gray), 3ch (RGB / Lab), or 4ch (CMYK) input. Same for output.
- **Encoding** — RGB vs CMYK vs Lab use different internal representations. The engine needs `header.colorSpace` and `type` to know which decoders/encoders to wire in.
- **Lab v2 vs v4** — Lab profiles have two PCS encodings; the descriptor's `version` field picks the right one.

Without these fields, `setLut()` doesn't know what to do with your bytes.

**2. Colour-managed workflow — auditability.**
A LUT without a chain is "this RGB triple becomes that CMYK quad" — but *which* RGB? sRGB? AdobeRGB? Linear? *Which* CMYK? GRACoL? FOGRA? SWOP? In a real prepress / regulated / archival workflow, you need to know. The chain answers it: `[*sRGB IEC61966-2.1, perceptual, GRACoL2006_Coated1v2]`. Anyone who opens the JSON months later knows exactly what colour journey produced the grid.

**3. Provenance — debugging and trust.**
The chain records intent (`perceptual`, `relative`, etc.), whitepoint, profile version. When a LUT produces "wrong" looking output, the chain tells you the original conversion intent. When two parties exchange a LUT, the chain is the contract — "this LUT was built with these profiles at this intent."

> Without the chain, a LUT is just a fancy colour converter. With it, it's an auditable workflow artefact.

The chain entries are **lightweight descriptors**, not full Profile objects — no A2B/B2A tables, no TRCs, no matrices. Just enough metadata for routing + provenance. See [Virtual profiles](#virtual-profiles) below for how to construct them when you don't have an ICC file (callback LUTs, lcms bridge, TIFF round-trips).

---

## Building a LUT

### From a callback — custom colour math

```js
const builder = new LutBuilder().create(
    { inChannels: 3, outChannels: 3, size: 33 },
    (rgb, cell) => {
        // rgb     : [r, g, b] in [0..1]
        // cell    : { indices, size, sizeMax }
        // return  : [r', g', b'] in [0..1]
        const [r, g, b] = rgb;
        return [Math.min(1, r * 1.1), g, b * 0.9];   // warm tone
    }
);
```

The callback is called once per grid cell. Loop order: axis 0 outermost (slowest), axis `inChannels-1` innermost (fastest) — same as `create3DDeviceLUT` in the engine.

### Identity — the blank canvas

```js
new LutBuilder().createIdentity(3, 33);   // 3D RGB identity, 33-pt grid
new LutBuilder().createIdentity(4, 17);   // 4D CMYK identity, 17-pt grid
```

Identity LUTs are useful as a starting point for `editLut()` or for the TIFF visual-editing workflow (Stage 3, see deep dive).

### From an existing Transform — extract and reuse

```js
// 1) Build once with profiles
const t = new Transform({ dataFormat: 'int8', buildLut: true });
t.create('*srgb', cmykProfile, eIntent.perceptual);

// 2) Extract LUT into a builder for editing/serialisation
const builder = LutBuilder.fromTransform(t);

// 3) Save, edit, or hand to a different Transform
fs.writeFileSync('lut.json', JSON.stringify(builder.toJSON()));
```

`fromTransform()` reads the canonical f64 CLUT from `transform.lut.CLUT` — never the kernel-internal `intLut`. It throws if the Transform was built without `buildLut: true`.

### From lcms-wasm — Tier 3 bridge

Use this when you need bit-exact parity with LittleCMS (regulatory workflows,
audit trails, tools that internally use lcms like Scribus/GIMP). Or use it as
emulation mode: bake an lcms-equivalent LUT once, then dispatch it through
jsCE's WASM-SIMD kernels at runtime — no lcms loaded for the actual pixel work.

```js
// Open profiles + create lcms transform (Emscripten lcms-wasm API)
const srcProfile = lcms.cmsOpenProfileFromMem(profileBytes, profileBytes.byteLength);
const dstProfile = lcms.cmsCreate_sRGBProfile();
const xform = lcms.cmsCreateTransform(
    srcProfile, lcmsConsts.TYPE_CMYK_16,
    dstProfile, lcmsConsts.TYPE_RGB_16,
    lcmsConsts.INTENT_RELATIVE_COLORIMETRIC,
    lcmsConsts.cmsFLAGS_BLACKPOINTCOMPENSATION | lcmsConsts.cmsFLAGS_HIGHRESPRECALC,
);

// Hand to LutBuilder — one call, all the heavy lifting handled internally
const builder = new LutBuilder().createFromLCMS(lcms, xform, {
    inChannels:  4,                                  // CMYK
    outChannels: 3,                                  // RGB
    size:        17,                                 // 17⁴ grid (~83K cells)
    chain: [virtualCMYK('GRACoL2006 (lcms)'),
            eIntent.relative,
            virtualRGB('sRGB (lcms emulation)')],
});

// Tear down lcms — the LUT is self-contained from here
lcms.cmsDeleteTransform(xform);
lcms.cmsCloseProfile(srcProfile);
lcms.cmsCloseProfile(dstProfile);

// Save for production, or use right now
fs.writeFileSync('cmyk-to-rgb.json', JSON.stringify(builder.toJSON()));
const transform = builder.toTransform({ dataFormat: 'int8' });
```

**API auto-detection.** `createFromLCMS` inspects the lcms instance and picks the
fastest path:

| API detected | Path | Speed |
|---|---|---|
| `_malloc`, `_free`, `_cmsDoTransform`, `HEAPU8` | Emscripten batched — fills the whole grid input on the WASM heap, runs **one** `_cmsDoTransform`, copies back. | ~80× faster than per-cell |
| `doTransformU16(xform, inU16, outU16)` | Per-cell fallback — generic JS lcms wrappers. | One JS↔WASM call per cell |

For a 17⁴ 4D LUT (≈ 83K cells), the difference is ~5 ms vs ~5 seconds. The demo
at [`lut-cmyk-to-rgb.html`](./lut-cmyk-to-rgb.html) builds a full 4D
GRACoL → sRGB LUT in **~80 ms** total via the Emscripten path.

> **Concrete numbers** (from `lut-cmyk-to-rgb.html`, 17⁴ CMYK→RGB):
> - Build: jsCE LUT ~28 ms, lcms LUT ~80 ms
> - JSON size: ~654 KB each (u16 base64 over 250K values)
> - JSON parse + setLut + intLut build (consumer-side cold start): ~6 ms
> - Per-frame transform on 240K pixels: live ~41 ms vs LUT ~6 ms (~6× faster)
> - jsCE LUT vs lcms LUT raw u16 grid agreement: **~0.1 ΔP per channel** (effectively the same colour math)
> - Mean ΔP between live (no LUT) and LUT: < 1 (sub-LSB at 8-bit)

---

## Editing a LUT

### Per-cell mutation

```js
builder.editLut((output, cell) => {
    // output           : current output values [0..1] for this cell
    // cell.indices     : integer grid indices
    // cell.normalised  : input coords [0..1] for this cell
    // cell.size, cell.sizeMax
    // return new output values [0..1]
    output[0] = 1 - output[0];   // invert channel 0
    return output;
});
```

### TAC limit (real CMYK example)

```js
const TAC = 3.0;   // 300% total ink

builder.editLut((cmyk) => {
    const total = cmyk[0] + cmyk[1] + cmyk[2] + cmyk[3];
    if (total > TAC) {
        const s = TAC / total;
        return [cmyk[0] * s, cmyk[1] * s, cmyk[2] * s, cmyk[3] * s];
    }
    return cmyk;
}).addAdjustment('TAC limit 300%');
```

### Cloning for variants

```js
const base = LutBuilder.fromTransform(rgbToCmykTransform);

const tac280 = base.clone().editLut(tacClamp(2.8)).addAdjustment('TAC 280%');
const tac300 = base.clone().editLut(tacClamp(3.0)).addAdjustment('TAC 300%');
const tac320 = base.clone().editLut(tacClamp(3.2)).addAdjustment('TAC 320%');
```

`clone()` is a deep copy — mutating one variant doesn't touch the others.

---

## Metadata

```js
builder
    .addCopyright('CC-BY-4.0')
    .addMeta({ author: 'Glenn', tags: ['prepress', 'GRACoL'] })
    .addAdjustment('Saturation +20%')
    .addAdjustment('Curves: shadows R+5')
    .setChain([virtualRGB('sRGB'), eIntent.perceptual, virtualCMYK('GRACoL')]);
```

| Method | Effect |
|---|---|
| `addMeta(obj)` | merges into `lut.meta` (additive — call multiple times) |
| `addCopyright(str)` | sets `lut.meta.copyright` |
| `addAdjustment(str)` | appends to `lut.meta.adjustments[]` (edit history) |
| `setChain([...])` | sets/overrides the profile chain (routing + provenance) |

All metadata lives under `lut.meta` in the JSON, ignored by the engine, available to humans/tooling.

---

## Audit trail — signatures and edit history

A content fingerprint is stamped into `lut.originalSignature`:

```
"originalSignature": "FNV1A:26c2efad"
```

It's FNV-1a 32-bit (`Math.imul`-based, ~1ms for a typical LUT) over the canonical content: input/output channel counts, grid points, chain (name|type|version per entry), and the u16 CLUT bytes. **Algorithm-prefixed** (`"FNV1A:..."`) so we can swap to a stronger hash later without breaking parsers. **Not cryptographic** — it detects accidental mutation, ordinary tampering, and "did this file change in transit"; it does *not* defend against adversarial tamper-evidence (for that, sign `JSON.stringify(json)` externally with crypto).

### When the signature gets computed (and when it doesn't)

The signature costs ~1 ms for a 33-pt 3D LUT and ~1.5 ms for a 17-pt 4D LUT. The engine deliberately doesn't pay this on the hot path — it computes lazily on export, and eagerly only when the user is explicitly extracting a LUT for the audit/edit workflow.

| Action | Effect on `originalSignature` |
|---|---|
| `Transform.create({ buildLut: true })` | **NOT stamped** — engine create stays fast; LUT is built and ready for `transformArray()` immediately |
| `transform.toJSON()` | **lazy-stamps** — computes once at export, included in the JSON output |
| `LutBuilder.fromTransform(t)` | **stamped at extraction** — explicit "I'm extracting this for editing/export" event |
| `LutBuilder.createFromLCMS(...)` | **stamped** after the lcms fill loop |
| `LutBuilder.create()` / `.createIdentity()` | **not stamped** (callback math has no "trusted source") |
| `.editLut(...)` | **NOT cleared** — it's the source-marker. Auto-appends a `meta.adjustments[]` entry: `"editLut() at <ISO timestamp>"` |
| `.clone()` | copied to the clone |
| `.toJSON()` / `.fromJSON()` | preserved through the JSON round-trip |

The hot path (`new Transform({ buildLut: true }).create(...).transformArray(pixels)`) pays nothing for signatures. If the LUT never gets exported, no hash is ever computed.

After 5 edits you'll see the same `originalSignature` plus 5 timestamped adjustment entries. Comparing the current data hash to `originalSignature` tells you whether the LUT was edited; `meta.adjustments[]` tells you how often.

### Verifying

```js
// On a builder
builder.verify();                   // → true (matches), false (edited), or null (no signature)
builder.signature();                // → the current data signature ("FNV1A:...")
builder.originalSignature;          // → the stamped marker

// On a Transform
transform.verifyLut();              // same trinary contract
transform.signLut();                // current data signature

// Static — works on a Transform's lut OR a JSON object/string
Transform.signLut(lut);
Transform.verifyLut(lutOrJsonStringOrObject);
```

> **`false` after editing is expected and correct** — it means the grid was
> modified after the source was stamped. `originalSignature` is the
> *source-of-truth marker*, not a "must stay unchanged forever" contract.
> Check `meta.adjustments[]` to see what was applied. Only panic if you get
> `false` on a LUT that was *not* supposed to be edited (e.g. a file loaded
> from a distribution you trust).

### Verifying on `setLut` (opt-in)

For consumer code that wants to fail fast on a tampered or corrupted LUT, opt in at load time:

```js
const t = new Transform({ dataFormat: 'int8' });
t.setLut(JSON.parse(jsonString), { verify: true });   // throws on signature mismatch
```

`Transform.fromJSON(input, opts)` forwards `opts.verify` through to `setLut`:

```js
const t = Transform.fromJSON(jsonString, { dataFormat: 'int8', verify: true });
```

Default is `verify: false` — verification costs a u16-bytes pass through the LUT (~1 ms for a 33-pt 3D LUT). For trusted-source applications (your own build artefacts), skip it. For untrusted-source applications (third-party LUT downloads, user uploads), enable it.

> **What signatures don't replace.** A non-cryptographic fingerprint can be re-computed by anyone who knows the algorithm. If you need adversarial tamper-evidence (regulated workflows, signed distribution), keep this signature for ergonomics but additionally sign the JSON externally with a crypto signature (SHA-256 + key, JWS, etc.). Two layers, separate concerns.

---

## Output

| Method | Returns | When to use |
|---|---|---|
| `.toLut()` | Engine LUT object (f64 CLUT) | You want to call `Transform.setLut()` manually |
| `.toTransform({ dataFormat })` | Ready-to-use `Transform` | The common path — go straight to `transformArray()` |
| `.toJSON({ dataType })` | Plain object (JSON-compatible) | Save to disk / send over the wire / cache in IndexedDB |

```js
const t       = builder.toTransform({ dataFormat: 'int8' });
const json    = builder.toJSON();                          // u16 b64 default
const small   = builder.toJSON({ dataType: 'u8' });        // ~half size, lossy
const lutObj  = builder.toLut();                           // f64 CLUT, manual
```

### `dataFormat` quick reference

| Format | Input | Output | Use case |
|---|---|---|---|
| `'int8'` | `Uint8ClampedArray` (0–255) | `Uint8ClampedArray` (RGB) / `Uint8ClampedArray` (CMYK) | RGB pixel work, CMYK separation — the safe default |
| `'int16'` | `Uint16Array` (0–65535) | `Uint16Array` | When 16-bit precision matters end-to-end |
| `'device'` | plain Array / Float* (0–1) | plain Array (0–1) | Sub-u8 precision, scientific work, no integer quantisation |

---

## JSON portability — the handshake format

`builder.toJSON()` and `transform.toJSON()` produce **byte-identical** output for the same logical LUT. Both delegate to `Transform.lutToJSON()` — the format authority.

### Two consumer paths

```js
// Builder route (returns a builder you can edit/clone/re-export)
const builder = LutBuilder.fromJSON(jsonString);
const t       = builder.toTransform({ dataFormat: 'int8' });

// Engine direct (no builder needed at runtime)
const t = Transform.fromJSON(jsonString, { dataFormat: 'int8' });
```

### Real workflow: producer → wire → consumer

```js
// PRODUCER (build time, has ICC profiles)
const producer = new Transform({ dataFormat: 'int8', buildLut: true });
producer.create('*srgb', cmykProfile, eIntent.perceptual);

// JSON.stringify(producer) auto-calls producer.toJSON()  (JS protocol)
fs.writeFileSync('srgb_to_cmyk.json', JSON.stringify(producer));


// CONSUMER (runtime, no profiles, no LutBuilder needed)
const consumer = Transform.fromJSON(
    fs.readFileSync('srgb_to_cmyk.json'),
    { dataFormat: 'int8' },
);
consumer.transformArray(rgbPixels);
```

### Why does `toJSON()` throw on a Transform with no LUT?

By design. Auto-building a LUT on demand would silently swap the f64 pipeline (~lossless) for a grid-sampled LUT path (~0.06 ΔE76 grid error at 33 points). That kind of hidden precision shift inside a serialise call is a debugging trap. If you want a LUT-backed JSON, opt in with `buildLut: true` at construction.

```js
const t = new Transform({ dataFormat: 'int8', buildLut: true });   // ← LUT built
t.create('*srgb', cmykProfile, eIntent.perceptual);
JSON.stringify(t);   // ✓ works
```

### `dataType: 'u16'` vs `'u8'` — size trade-off

For a 33-pt 3D RGB→CMYK LUT (~144K values):

| dataType | Raw KB | Base64 KB | Gzip-friendly | Lossless? |
|---|---|---|---|---|
| `'u16'` (default) | 281 | ~374 | ~220 | yes (matches u16 ICC ceiling) |
| `'u8'` | 140 | ~187 | ~120 | no — re-quantised, ~1 u8 LSB error |

Use `'u8'` for size-critical web LUTs where the consumer is known to be a u8 pipeline. Default `'u16'` is correct everywhere else.

---

## Virtual profiles

The chain in a LUT needs profile descriptors for `setLut()` routing. When you build from real ICC profiles, those descriptors come from `profile2Obj()` automatically. When you build from a callback, you provide them.

```js
const { virtualProfile, virtualRGB, virtualCMYK, virtualGray, virtualLab } =
    require('./LutBuilder');

// Minimal — header.colorSpace, name, type, version (all that setLut() needs)
virtualRGB('My RGB output');
virtualCMYK('GRACoL press');
virtualGray('Mono');
virtualLab('Lab working');

// Fully-populated — '*' prefix delegates to the engine's built-in virtuals,
// adding whitepoint, PCS encoding, primaries, etc.
virtualRGB('*sRGB');         // sRGB IEC61966-2.1
virtualRGB('*AdobeRGB');     // AdobeRGB 1998
virtualRGB('*ProPhotoRGB');  // ProPhoto RGB
virtualLab('*Lab');          // Lab D50
virtualLab('*LabD65');       // Lab D65 (the only D65 default)

// String shorthand — these are equivalent:
virtualProfile('*sRGB');
virtualProfile({ name: '*sRGB' });
virtualRGB('*sRGB');
```

Supported `*` names: `sRGB`, `AdobeRGB`, `AppleRGB`, `ColorMatchRGB`, `ProPhotoRGB`, `Lab`, `LabD50`, `LabD65`.

> **Whitepoints note.** All RGB virtual profiles store **D50** as `mediaWhitePoint` (the engine adapts native D65 → D50 for ICC PCS by default). `*LabD65` is the only one that stores D65. The chromatic adaptation is already baked into the primaries, so the LUT is correct either way — the whitepoint field is reference metadata.

---

## Common workflows

### W1 — Pre-baked LUT library

A prepress vendor with 50 paper-stock profiles. Build all LUTs at deploy time, ship as static JSON, no profiles at the client.

```js
for (const stock of paperStocks) {
    const t = new Transform({ dataFormat: 'int8', buildLut: true });
    t.create('*srgb', stock.profile, eIntent.perceptual);

    const builder = LutBuilder.fromTransform(t);
    builder.addMeta({
        paperName: stock.name,
        inkSet:    stock.inkSet,
        cert:      stock.cert,
    });
    fs.writeFileSync(`luts/${stock.slug}.json`, JSON.stringify(builder.toJSON()));
}
```

### W2 — Custom creative effect

A "warm" filter as a LUT, no profiles needed at all.

```js
function warmth([r, g, b]) {
    return [Math.min(1, r * 1.05), g * 0.95, b * 0.85];
}

const json = new LutBuilder()
    .create({ inChannels: 3, outChannels: 3, size: 33 }, warmth)
    .setChain([virtualRGB('sRGB'), eIntent.perceptual, virtualRGB('sRGB warm')])
    .addCopyright('CC-BY-4.0')
    .addAdjustment('Vintage warmth: R+5% G-5% B-15%')
    .toJSON();
```

### W3 — Edit and re-export

Load a base LUT, apply an edit, save the variant.

```js
const base = LutBuilder.fromJSON(fs.readFileSync('base.json'));

const tac = base.clone()
    .editLut((cmyk) => {
        const total = cmyk[0] + cmyk[1] + cmyk[2] + cmyk[3];
        if (total > 3.0) {
            const s = 3.0 / total;
            return cmyk.map(v => v * s);
        }
        return cmyk;
    })
    .addAdjustment('TAC limit 300%');

fs.writeFileSync('tac_300.json', JSON.stringify(tac.toJSON()));
```

### W4 — Hybrid try/catch (lcms fallback for exotic profiles)

> **The killer pattern for production use.** Any Transform produced by either path runs at the same WASM-SIMD speed — your image loop never knows which engine did the colour math. jsCE handles the common case; lcms catches anything it can't parse.

```js
let transform;
try {
    transform = new Transform({ dataFormat: 'int8', buildLut: true });
    transform.create(srcProfile, dstProfile, intent);
} catch (e) {
    // jsCE couldn't parse — fall back to lcms via the bridge
    const xform = lcms.createTransformU16(src, TYPE_RGB_16, dst, TYPE_CMYK_16, intent, 0);
    transform = new LutBuilder()
        .createFromLCMS(lcms, xform, { inChannels: 3, outChannels: 4, size: 33 })
        .toTransform({ dataFormat: 'int8' });
}
// Either path: same API, same kernel speed
transform.transformArray(pixels);
```

---

## TIFF visual editing workflow (Stage 3)

The TIFF workflow lets any ICC-aware image editor (Photoshop, Affinity, GIMP) act as a LUT authoring tool. The idea: export an identity LUT as an image, grade it in your editor, reimport the result.

![sRGB identity LUT TIFF — gradient grid with preview images and channel bars](tiff_samples/rgb_srgb_identity_n33_preview.jpg)

*sRGB identity LUT (N=33, scale=3, 16-bit). Left: 6×6 grid of N×N colour patches — each patch is a grid node. Right: reference preview images (grayscale conversion shown for context) and per-channel gradient bars (R/G/B). Text strip at bottom encodes all parameters for machine-readable fallback.*

```
1. Export identity TIFF  →  2. Open in Photoshop  →  3. Apply any adjustment
                         →  4. Save losslessly    →  5. Import → LUT JSON
```

### Export: create a LUT TIFF

```js
// In code
const b = new LutBuilder().createIdentity(3, 33);
b.setChain([virtualProfile('*AdobeRGB'), eIntent.perceptual, virtualProfile('*AdobeRGB')]);

const bytes = await b.exportTIFF({
    scale:           3,          // each grid point = 3×3 pixels (default; 2 for 4D)
    bitDepth:        16,         // 8 | 16 (default 16 — always use 16 for round-trip)
    previewImages:   ['face.png', 'fruit.png'],  // optional, drawn to the right
    outputProfile:   cmykProfile,                // required for CMYK output + images
    iccProfileBytes: fs.readFileSync('profile.icc'), // embed ICC in TIFF tag 34675
    description:     'My AdobeRGB LUT',
});
fs.writeFileSync('my_lut.tiff', bytes);
```

```
# Via CLI
node samples/LutBuilder/lut-tiff-cli.js --create \
    --channels 3 --size 33 --scale 3 --bps 16 \
    --chain-in *AdobeRGB --chain-out *AdobeRGB \
    --images face.png,fruit.png,skin.png \
    --out my_lut.tiff
```

**TIFF layout:**
```
┌─────────────────┬──────────────────────┬──────────────┐
│  LUT grid data  │  Preview images      │  Channel     │
│  (top-left 0,0) │  (right of LUT,      │  gradient    │
│                 │   same height)       │  bars        │
├─────────────────┴──────────────────────┴──────────────┤
│  Text strip: created date, inCh/outCh/size/scale/bps  │
└────────────────────────────────────────────────────────┘
```

- **Grid cells** are `scale × scale` solid pixel blocks so minor dither/noise is averaged out on import
- **1D LUTs** (tone curves) are rendered as a full-height gradient strip
- **Text strip** is a human-readable fallback: if all metadata is lost you can read the parameters directly from the image

### Edit in Photoshop (or any ICC-aware editor)

Open the TIFF. Apply any operation: Curves, Hue/Saturation, Convert to CMYK, a Photoshop Action, selective colour, etc. Then save **losslessly** — TIFF with no compression or LZW. JPEG destroys the solid pixel blocks.

The editor applies the same transformation to both the preview images (visible feedback) and the LUT grid region (the data).

> **Capturing another CMS as a LUT:** Open an AdobeRGB identity TIFF, choose Image → Mode → Convert to CMYK (using any CMYK profile). Save as TIFF. The result is a 3D RGB→CMYK device-link that exactly reproduces Adobe's CMM at the grid resolution.

### Import: TIFF → LUT JSON

```js
// In code
const b = LutBuilder.fromTIFF(fs.readFileSync('edited.tiff'));
const t = b.toTransform({ dataFormat: 'int8' });
t.transformArray(pixels);   // full WASM-SIMD speed
```

```
# Via CLI (auto-detects all parameters from TIFF metadata)
node samples/LutBuilder/lut-tiff-cli.js --import \
    --in edited.tiff \
    --out my_lut.json
```

**Output channel change is auto-detected.** If Photoshop converts the file from RGB to CMYK, `fromTIFF` reads the actual `SamplesPerPixel` from the TIFF header and updates `outCh` accordingly. The embedded ICC profile (tag 34675, always written by Photoshop) becomes the chain output descriptor.

**CMYK output always requires a profile** — either embedded in the TIFF or supplied via `--output-profile`:

```
# TIFF with no embedded ICC:
node samples/LutBuilder/lut-tiff-cli.js --import \
    --in edited_cmyk.tiff \
    --output-profile samples/profiles/CoatedGRACoL2006.icc \
    --out my_cmyk_lut.json
```

```js
// Or override in code after import:
const b = LutBuilder.fromTIFF(data);
b._chain[2] = virtualCMYK('My Press Profile');
```

### Three-layer metadata resilience

| Layer | Where stored | Survives Photoshop? |
|---|---|---|
| **XMP `jsce:LutMeta`** (tag 700) | XML embedded in TIFF | ✓ Always — XMP unknown namespaces are preserved |
| **Private tag 32768** | TIFF IFD entry | ✗ Photoshop strips it |
| **Text strip** | Visible pixels at bottom | ✓ Always — it's just image data |

On import: XMP is checked first, tag 32768 as fallback. If both are absent (rare) a human can read the parameters from the text strip and supply them via `--size`, `--in-channels`, `--out-channels`, `--scale`.

### Import error guide

| Error | Cause | Fix |
|---|---|---|
| `metadata tag absent` | TIFF has no XMP or private tag | Add `--size`, `--in-channels`, `--out-channels`, `--scale` (read from text strip) |
| `spread=N > threshold` | JPEG compression / painted-over cells | Resave as TIFF LZW or uncompressed; never use JPEG |
| `CMYK output requires a named profile` | CMYK TIFF but no embedded ICC | Add `--output-profile path/to/cmyk.icc` |

### `exportTIFF` / `fromTIFF` options

```js
// exportTIFF options
builder.exportTIFF({
    scale:           3,          // 1–8; default 3 (≤3D) or 2 (4D)
    bitDepth:        16,         // 8 | 16; default 16
    outputProfile,               // Profile object; required for CMYK + previewImages
    iccProfileBytes,             // Uint8Array of ICC file to embed as tag 34675
    previewImages,               // string[] of image paths (up to 3 recommended)
    description,                 // string for text strip
})
// → Promise<Uint8Array>

// fromTIFF options (only needed when TIFF has no metadata)
LutBuilder.fromTIFF(data, {
    size:    33,     // grid points per axis
    inCh:    3,      // input channels
    outCh:   3,      // output channels
    scale:   3,      // pixel scale
})
// → LutBuilder (synchronous)
```

### CLI quick reference

```
EXPORT (create identity LUT as TIFF):
  node lut-tiff-cli.js --create
    --channels 3        input channels: 1=Gray, 3=RGB, 4=CMYK
    --size 33           grid points per axis
    --scale 3           pixels per grid point
    --bps 16            bit depth: 8 or 16
    --chain-in  *AdobeRGB   input profile spec
    --chain-out *AdobeRGB   output profile spec
    --images a.png,b.png    preview images (comma-separated)
    --output-profile-icc /path/profile.icc   embed ICC in TIFF
    --out my_lut.tiff   output path

IMPORT (TIFF → LUT JSON):
  node lut-tiff-cli.js --import
    --in edited.tiff    input TIFF (required)
    --out my_lut.json   output JSON (default: same name + .json)
    --output-profile *sRGB | CMYK | /path.icc   override/provide output profile
    --chain-in *sRGB    override input profile
    -- Fallback (if TIFF has no metadata):
    --size 33  --in-channels 3  --out-channels 3  --scale 3

APPLY (run LUT over any image and save the result):
  node lut-tiff-cli.js --apply
    --source  original.tiff         Input image TIFF (any size)
    --lut     lut.json              LUT JSON from --import
    --out     result.tiff           Output TIFF (default: source + _lut_applied)
  Use case: apply a Photoshop-captured LUT to a test image, open both in Photoshop
            to visually verify the round-trip is accurate

VALIDATE (apply LUT to original, compare result to ground-truth edited):
  node lut-tiff-cli.js --validate
    --original identity.tiff        TIFF that went into Photoshop (before editing)
    --edited   edited.tiff          TIFF saved from Photoshop (ground truth)
    --lut      lut.json             LUT JSON from --import
    --threshold 1.0                 Max acceptable mean ΔP (default 1.0)
    --delta-out delta.tiff          Save delta images alongside a text report:
                                      delta_magnitude_amp10x.tiff  (1ch hotspot map)
                                      delta_channels_amp10x.tiff   (per-channel diff)
                                      delta_report.txt             (full text summary)
    --delta-amplify 10              Multiply delta values for visibility (default 10)
                                    ΔP=1 → gray-10; ΔP=5 → gray-50
  Reports: mean/max/RMSE/p95/p99 ΔP per channel + GRADE + pass/fail

COMPARE (direct pixel diff — no LUT applied):
  node lut-tiff-cli.js --compare
    --base  photoshop_out.tiff      Baseline / ground truth
    --test  jsce_out.tiff           Image to compare against the baseline
    --threshold 1.0
    --delta-out delta.tiff          (same delta image options as --validate)
    --delta-amplify 10
  Use case: take a test image, convert with jsCE / lcms / Photoshop, compare all to Photoshop as baseline

SAMPLES:
  node lut-tiff-cli.js --make-samples
    → samples/tiff_samples/rgb_srgb_identity_n33.tiff    (sRGB2014 embedded)
    → samples/tiff_samples/cmyk_gracol_identity_n17.tiff (CoatedGRACoL ICC embedded)
    → samples/tiff_samples/gray_identity_tonecurve_n255.tiff

Profile specs: *sRGB *AdobeRGB *ProPhotoRGB *Lab   RGB CMYK GRAY   /path/to.icc
```

---

## API reference

### `LutBuilder` class

| Method | Returns | Notes |
|---|---|---|
| `new LutBuilder()` | builder | Empty — call a create method |
| `new LutBuilder(lut)` | builder | From an existing LUT object |
| `LutBuilder.fromTransform(t)` | builder | Extract LUT from `Transform` (must have `buildLut: true`) |
| `LutBuilder.fromJSON(input)` | builder | From JSON string or parsed object |
| `.create(opts, callback)` | this | Synthetic LUT from a callback |
| `.createIdentity(channels, size)` | this | Identity LUT (output = input) |
| `.createFromLCMS(lcms, xform, opts)` | this | Tier 3 lcms-wasm bridge — auto-detects Emscripten heap API for ~80× speedup |
| `.editLut(callback)` | this | Per-cell mutation |
| `.clone()` | new builder | Deep copy |
| `.addMeta(obj)` | this | Merge into `lut.meta` |
| `.addCopyright(str)` | this | Set copyright |
| `.addAdjustment(str)` | this | Append to edit history |
| `.setChain([...])` | this | Set profile chain |
| `.toLut()` | LUT object | f64 CLUT, ready for `setLut()` |
| `.toTransform(opts)` | `Transform` | Ready for `transformArray()` |
| `.toJSON(opts)` | plain object | Portable JSON; auto-called by `JSON.stringify()` |
| `.exportTIFF(opts)` | `Promise<Uint8Array>` | Export as TIFF for visual editing. See [TIFF workflow](#tiff-visual-editing-workflow-stage-3) |
| `LutBuilder.fromTIFF(data, opts)` | builder | Import from TIFF (synchronous). Reads XMP + tag 32768, detects outCh change, extracts ICC |
| `LutBuilder.pixelsToTIFF(px, w, h, spp, bps, opts)` | `Uint8Array` | Write a raw pixel buffer as a TIFF (static). Used by `--apply` and delta output. |
| `.analyze(inputPx, expectedPx, opts)` | report | Apply LUT to `inputPx`, diff result against `expectedPx`. `opts.returnDelta:true` adds `deltaMagnitudeU8` / `deltaChannelsU8` arrays. |
| `LutBuilder.comparePixels(a, b, ch, opts)` | report | Direct pixel diff (no LUT). Same report shape as `analyze`. |

**`analyze` / `comparePixels` report shape:**

```js
{
  pass:         boolean,      // all pixels within threshold
  threshold:    number,       // the threshold used
  totalPixels:  number,
  failedPixels: number,       // pixels exceeding threshold
  grade:        string,       // 'SUB-LSB' | 'EXCELLENT' | 'GOOD' | 'ACCEPTABLE' | 'REVIEW'

  maxDeltaP:    number,       // worst-case ΔP (Euclidean, u8 scale)
  meanDeltaP:   number,
  rmseDeltaP:   number,
  p95DeltaP:    number,
  p99DeltaP:    number,

  channels: [                 // per output channel
    { name, meanDeltaP, maxDeltaP, rmseDeltaP }
  ],

  reportText:   string,       // formatted text summary (always present)

  // Only present when opts.returnDelta: true:
  deltaMagnitudeU8: Uint8Array,  // 1ch per pixel, ΔP magnitude × deltaAmplify
  deltaChannelsU8:  Uint8Array,  // outCh per pixel, per-channel abs diff × deltaAmplify
  _deltaAmplify:    number,      // the amplify factor used
}
```
| `.originalSignature` | string \| null | Stamped fingerprint (read-only getter) |
| `.signature()` | string \| null | Current data signature, computed on demand |
| `.verify()` | boolean \| null | true / false / null (no signature) |

### Engine-side counterparts (in `Transform`)

| Method | Returns | Notes |
|---|---|---|
| `transform.toJSON(opts)` | plain object | Same format as `builder.toJSON()` |
| `Transform.fromJSON(input, opts)` | `Transform` | Direct consumer path — no builder needed; `opts.verify` triggers signature check |
| `Transform.lutToJSON(lut, opts)` | plain object | Static; format authority |
| `Transform.jsonToLut(input)` | LUT object | Static; decode JSON → f64 LUT |
| `transform.setLut(lut, opts)` | undefined | `opts.verify: true` throws on signature mismatch |
| `transform.verifyLut()` / `signLut()` | boolean\|null / string\|null | Instance signature methods |
| `Transform.verifyLut(input)` / `signLut(lut)` | boolean\|null / string | Static signature methods |

### Errors

All methods throw on invalid input — clear messages, no silent failures. Wrap in try/catch if you need graceful handling. Common error cases:

| Call | Error |
|---|---|
| `create()` with bad channel count | `inChannels must be 1–4` |
| `toLut()` / `toJSON()` with no LUT | `no LUT loaded — call a create method first` |
| `transform.toJSON()` with no LUT | `no LUT to serialise. Construct with buildLut: true ...` |
| `fromTransform()` with un-lutted Transform | `Transform has no built LUT. Create with buildLut: true ...` |
| `virtualProfile('*Unknown')` | `unknown built-in profile "*Unknown"` |

---

## See also

- [`docs/deepdive/Luts.md`](../../docs/deepdive/Luts.md) — the deep dive: design rationale, format spec, lcms architecture, TIFF roadmap, precision proofs.
- [`samples/LutBuilder/lut-tiff-cli.js`](./lut-tiff-cli.js) — CLI for creating, importing, validating, and comparing LUT TIFFs. `--create`, `--import`, `--validate`, `--compare`, `--make-samples`.
- [`samples/ICCImage/iccimage.js`](../ICCImage/iccimage.js) — image-level wrapper around `Transform` (a sibling sample, MIT-licensed).
- [`__tests__/lutbuilder.tests.js`](../__tests__/lutbuilder.tests.js) — 90+ tests covering every API surface and the workflow patterns above.
- [`__tests__/lutbuilder_tiff.tests.js`](../__tests__/lutbuilder_tiff.tests.js) — TIFF round-trip integration tests (Photoshop saved files, outCh detection, ICC extraction, damaged file rejection).
