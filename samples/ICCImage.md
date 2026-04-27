# `ICCImage` — colour-managed image wrapper

`samples/iccimage.js` is a small immutable image wrapper around `jsColorEngine`.
It is the helper used by every demo in `samples/*.html` and doubles as living
documentation of how to drive the engine on real image data.

> **License:** MIT (separate from the engine's MPL-2.0 — see [LICENSE](./LICENSE)).
> **Status:** demo-grade. Not a general-purpose image library.

---

## Why it exists

Three things that come up in every demo:

1. **Load an image, get RGB onto a canvas.** Browser canvas already does that
   — but with no colour management and no profile tagging.
2. **Soft-proof an image through a CMYK profile and back to sRGB.** That's a
   3-stage `Transform.createMultiStage` and a couple of buffer juggles. It
   should be `await img.toProof(cmyk).toCanvas(cv)`.
3. **Inspect a single pixel in a colour picker.** That wants the *accuracy*
   path (no LUT) and three answers at once: Lab, sRGB, and the source-space
   device values.

`ICCImage` wraps those three workflows behind a small immutable API that
hides the cache + transform plumbing.

## Why it is NOT a general image library

There are no filters, no compositing, no blur, no encode/decode of JPEG / TIFF
/ PNG. The two amenities that *did* make it in are bilinear downscale (for
defensive `maxPixels` guards) and bit-depth conversion. Both are essentially
free to write and both come up constantly in demos. Beyond that, KISS.

## Design tenets

| Tenet | What it means |
|---|---|
| **Immutable** | Every `toX()` returns a *new* `ICCImage`. Source is never mutated. |
| **Always profile-tagged** | The internal `ICCImageData` carries the `Profile` AND the full lineage chain. There is no such thing as an untagged `ICCImage`. |
| **Lazy + cached** | `Transform`s are built on first use and stored in a `TransformCache` keyed by `chain + BPC + dataFormat + buildLut`. Derived images share their parent's cache. |
| **Two paths** | Bulk image work uses `dataFormat: 'int8'` + `buildLut: true` (the engine's fast LUT path). Single-pixel work uses `dataFormat: 'object'` with no LUT (accuracy path). |

## Data model

```text
ICCImage
  ├─ _raw : ICCImageData                # immutable pixel container
  │    ├─ width, height, channels, bitDepth, alpha, colorSpace
  │    ├─ data : Uint8ClampedArray | Uint16Array | Float32Array
  │    ├─ profile : Profile             # terminal profile of `chain`
  │    └─ chain   : [Profile, intent, Profile, intent, Profile, ...]
  │                                     # same shape as engine `Transform.chain`
  └─ _cache : TransformCache            # shared with derived ICCImages
```

The `chain` is the lineage. Reading it left to right tells you exactly what
the data has been through. Reading the *terminal* profile alone tells you
how the data is currently encoded.

---

## Quick start

```html
<script src="../browser/jsColorEngineWeb.js"></script>
<script type="module">
    import { ICCImage } from './iccimage.js';
    const { Profile, eIntent } = window.jsColorEngine;

    const cmyk = new Profile();
    await cmyk.loadPromise('GRACoL2006_Coated1v2.icc');

    const src   = await ICCImage.fromHTMLImage(myImg, { maxPixels: 4_000_000 });
    const proof = await src.toProof(cmyk, { intent: eIntent.perceptual, BPC: true });
    const sep   = await src.toSeparation(cmyk);

    await src.toCanvas(canvas1);                       // sRGB
    await proof.toCanvas(canvas2);                     // soft-proofed sRGB
    await sep.renderChannelAs('C').toCanvas(canvas3);  // cyan plate

    const px = src.pixel(120, 200);
    // { lab: {L,a,b}, srgb: {R,G,B,hex}, device: [0..1, ...], space: 'RGB' }
</script>
```

---

## API reference

### Engine wiring

```js
ICCImage.init({ engine })   // optional — if you've imported jsColorEngine yourself
```

By default, `ICCImage` reads `globalThis.jsColorEngine` lazily on first use.
The UMD bundle (`browser/jsColorEngineWeb.js`) sets that global. If you've
imported the engine some other way (ESM bundler), pass it in via `init()`.

### Constructors

#### `new ICCImage(opts)`

Direct construction from a typed array. Use this when you've decoded image
bytes yourself (e.g. raw 16-bit TIFF) and want to hand the buffer over.

| Option | Type | Notes |
|---|---|---|
| `width`, `height` | `number` | required |
| `data` | `Uint8ClampedArray` / `Uint16Array` / `Float32Array` | required |
| `profile` | `Profile` or `'*sRGB'`-style string | required |
| `channels` | `number` | colorant channels only; default = `profile.outputChannels` |
| `bitDepth` | `8` / `16` / `32` | default `8` |
| `colorSpace` | `'RGB'` / `'CMYK'` / `'GRAY'` | default from profile |
| `alpha` | `false` / `'straight'` / `'premultiplied'` | default `false` |
| `chain` | `[Profile, intent, Profile, ...]` | default `[profile]` |
| `transformCache` | `TransformCache` | optional shared cache |

#### `ICCImage.fromImageData(imageData, profile = '*sRGB', { maxPixels } = {})`

Wrap an existing `ImageData` (e.g. from `ctx.getImageData(...)`). The browser
hands you sRGB so the profile defaults match.

#### `await ICCImage.fromHTMLImage(source, { profile, maxPixels } = {})`

Pull pixels off an `HTMLImageElement` / `HTMLCanvasElement` / `ImageBitmap`
through a 2D canvas. Always returns 8-bit RGBA — that's the canvas API's
ceiling. Pass `maxPixels` (e.g. `4_000_000`) to defensively bilinear-downscale
huge uploads before they OOM the page.

### Conversions (each returns a new `ICCImage`)

#### `await img.toSRGB({ intent, BPC } = {})`

Convert to display sRGB. If the source is already sRGB-tagged this returns
`this` unchanged (the immutable contract still holds — the source IS the
result).

#### `await img.toProof(proofProfile, { intent, BPC } = {})`

Soft-proof: `src → proofProfile → *sRGB`. Returned image is sRGB-tagged so
`.toCanvas()` blits directly.

A single `intent` sets **RGB → proof** only; the CMYK → display-sRGB preview
leg is always **relative colorimetric**. A single `BPC` applies **black-point
compensation on the first leg only**. Pass `[srcToProof, proofToScreen]` or
`[bpcFirst, bpcSecond]` to override either leg explicitly.

#### `await img.toSeparation(proofProfile, { intent, BPC } = {})`

Convert to the proof profile's native space (typically CMYK). The returned
`ICCImage` is tagged with `proofProfile` — its raw data IS the actual ink
separation. Calling `.toCanvas()` on it builds an on-the-fly
`[proofProfile, *sRGB]` transform to display it. Alpha is dropped.

#### `img.toBitDepth(target)`

Element-wise dtype conversion preserving the normalised value range.
`target` is `8` / `16` / `'float32'` (or the explicit string forms).
Profile and chain unchanged.

#### `img.resizeTo(target)`

Bilinear downscale. Up-sampling is rejected by design.

```js
img.resizeTo({ maxPixels: 4_000_000 })   // cap on width × height
img.resizeTo({ width: 800 })             // height auto-computed
img.resizeTo({ width: 800, height: 600 })
```

If the source already fits the budget, returns `this` (immutable: source IS
the result).

### Display + inspection

#### `await img.toCanvas(canvas)`

Paint onto a `<canvas>`. Auto-resizes the canvas to match. If the terminal
profile is `*sRGB` and the buffer is uint8 RGBA, blits direct. Otherwise
builds (and caches) a `[terminal, *sRGB]` transform first.

#### `img.renderChannelAs(ref, tint?)`

Render a single channel as a tinted RGBA `ICCImage`. The result is
sRGB-tagged so `.toCanvas()` blits direct.

```js
sep.renderChannelAs('C')                 // default cyan tint
sep.renderChannelAs('C', '#0099ff')      // custom CSS hex
sep.renderChannelAs(0,  [0, 153, 255])   // [r,g,b]
```

#### `img.pixel(x, y)`

Single-pixel readout via the **accuracy path** (no LUT). Returns the pixel
in three useful spaces at once:

```js
{
    lab:    { L, a, b },                      // CIE L*a*b* D50
    srgb:   { R, G, B, hex: '#rrggbb' },      // 0..255 ints
    device: [0..1, 0..1, ...],                // length === channels
    space:  'CMYK',                           // source colour space tag
}
```

The two transforms backing this (`src→*Lab` and `src→*sRGB`) are built
lazily on first call and cached on the instance, so subsequent reads are
near-instant. The cache here is *separate* from the bulk LUT cache —
mixing accuracy-path no-LUT transforms into the LUT-tuned cache would
muddy the keying.

#### `img.info`

Human-readable summary of the wrapped image:

```js
{
    width: 1200, height: 800,
    channels: 3, bitDepth: 8,
    colorSpace: 'RGB', alpha: 'straight',
    profile: 'sRGB IEC61966-2.1',
    chain: 'sRGB IEC61966-2.1 → perceptual → ISO Coated v2 → relative → sRGB IEC61966-2.1',
    cacheSize: 2,
}
```

#### `img.getRaw()` / `img.raw`

`getRaw()` returns a defensive copy of the underlying `ICCImageData`.
`raw` (the getter) returns the live instance — read-only by convention,
useful for inspection.

### Memory

#### `img.disposeRaw()`

Drop the raw buffer; keep the transform cache. Useful when you've already
generated all the `toCanvas` outputs you need and want to free the source
pixels.

#### `img.dispose()`

Drop everything. Instance is unusable after this call.

---

## Choosing intent + BPC

Quick guide for soft-proofing demos:

| Goal | `intent` | `BPC` |
|---|---|---|
| "How will this print look on screen?" | `[perceptual, relative]` | `[true, false]` |
| "Show me the absolute colorimetric truth" | `[absolute, relative]` | `[false, false]` |
| "Maximum vibrancy for charts / graphics" | `[saturation, relative]` | `[false, false]` |

`*sRGB`-on-the-screen leg almost always wants `relative` + `BPC: false`,
since both source and dest are bright RGB displays.

---

## Pluggable channel sets

`ChannelSets` is exported and editable:

```js
import { ChannelSets } from './iccimage.js';

ChannelSets.CMYK[0].tint = [0, 153, 255];  // company-blue cyan in plate previews
```

Real ink colours live in the profile's `colorantTable` tag — wiring that
up to override the default `tint` is on the roadmap.

---

## What's deliberately missing

| Feature | Status | Why |
|---|---|---|
| `getChannel('C')` returning a 1D ICCImage | ❌ | Would violate "always profile-tagged" — there's no profile for a 1D grey extracted from a CMYK separation. Use `renderChannelAs` for previews instead. |
| `fromBuffer(arrayBuffer, mimeType)` | 🚧 later | Punted until we wire pluggable JPEG/TIFF/PNG decoders. For now construct from typed arrays directly, or paint onto a canvas and use `fromHTMLImage`. |
| Filters / blur / sharpen / composite | ❌ | Out of scope — not Photoshop. |
| Upscaling | ❌ | `resizeTo` rejects it. KISS — use a real image library if you need it. |
