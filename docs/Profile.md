# Profile

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Bench](./Bench.md) ·
[Performance](./Performance.md) ·
[Roadmap](./Roadmap.md) ·
[Deep dive](./deepdive/) ·
[Examples](./Examples.md) ·
[API: Transform](./Transform.md) ·
[Loader](./Loader.md)

---

The `Profile` class loads and decodes ICC profiles (and synthesises
"virtual" profiles like sRGB / Adobe RGB from hard-coded primaries +
gammas) into an in-memory representation that the [`Transform`](./Transform.md)
class then uses to actually convert colours.

> [!NOTE]
> `Profile` does **not** perform colour conversions. It just owns the
> profile data. To convert colours, hand a `Profile` to a `Transform`.

> [!TIP]
> The most authoritative reference for `Profile` is the in-source JSDoc
> in [`src/Profile.js`](../src/Profile.js) — every public method has full
> parameter docs, return types, and notes on edge cases. This page is
> the high-level overview.

## Contents

* [Virtual vs ICC profiles](#virtual-vs-icc-profiles)
* [Quick start](#quick-start)
* [Methods](#methods)
* [Built-in virtual profile names](#built-in-virtual-profile-names)
* [Properties](#properties)
* [Deprecated property names](#deprecated-property-names)
* [Environments](#environments)

---

## Virtual vs ICC profiles

`Profile` can be constructed two ways:

1. **Virtual** — `'*sRGB'`, `'*AdobeRGB'`, `'*ProPhotoRGB'`, `'*Lab'`, etc.
   Built in memory from primaries + gamma. No file I/O, no decode.
2. **From an ICC file** — load a real `.icc` / `.icm` profile from disk,
   URL, base64, or an in-memory `Uint8Array`.

For the common RGB working spaces (sRGB, Adobe RGB, Apple RGB,
ColorMatch RGB, ProPhoto RGB) **virtual profiles are the right default**.
Most RGB ICC profiles in the wild are matrix + TRC (no LUT) — the maths
is exactly the same as what the virtual constructor builds. Once loaded,
`Transform` can't tell the two apart at runtime, they hit the identical
inlined matrix-and-gamma kernel. The only real difference is startup
cost: virtual = essentially free, ICC = a fetch + a decode.

Use a real ICC profile when you actually need one:

* It's a CMYK or 3CLR/4CLR device profile (LUT-based — there's no virtual
  equivalent).
* It's a printer / scanner / press profile with measurement-derived
  AtoB/BtoA LUTs (the gamut mapping is real measured data, not a
  formula).
* It's a custom monitor profile from a calibrator.
* You need to faithfully reproduce another CMM's interpretation of a
  specific embedded profile (e.g. matching Photoshop output exactly).

Internal optimisation: when `Profile` decodes an RGB ICC that has no
AtoB / BtoA LUT, it auto-promotes to the same fast matrix-and-gamma path
that virtual profiles use. So even for a real ICC like `sRGB.icc`, you
only pay the startup cost — runtime is identical.

---

## Quick start

```js
const { Profile, Transform, eIntent, color } = require('jscolorengine');

(async () => {
    // 1. Virtual profile — synchronous, no I/O.
    const sRGB = new Profile('*sRGB');

    // 2. ICC profile — async load.
    const cmyk = new Profile();
    await cmyk.loadPromise('file:./profiles/GRACoL2006_Coated1v2.icc');

    if (!cmyk.loaded) {
        console.error('Failed to load CMYK profile:', cmyk.lastError);
        return;
    }

    console.log(cmyk.description);   // 'GRACoL2006_Coated1v2.icc'
    console.log(cmyk.outputChannels); // 4

    // Hand them to a Transform to actually convert.
    const lab2cmyk = new Transform();
    lab2cmyk.create('*lab', cmyk, eIntent.perceptual);

    console.log(lab2cmyk.transform(color.Lab(50, 20, -30)));
})();
```

---

## Methods

### `new Profile(dataOrUrl?)`

If `dataOrUrl` is provided, the constructor calls `load()` for you. If
omitted, you can call `load()` (or any of the more specific loaders)
later. The constructor itself never does I/O — async loaders return
without waiting.

### `profile.load(dataOrUrl, afterLoad?)`

Load a profile from any supported source. The source type is detected
from the prefix of the string:

| Input | Treated as |
|---|---|
| `Uint8Array` | Raw ICC binary, decoded immediately |
| `'data:...'` | base64-encoded ICC |
| `'file:...'` | Local file path (Node + Adobe CEP only) |
| `'http://...' / 'https://...'` | URL — fetched via XHR (browser) or `http.get` (Node) |
| `'*sRGB'` etc. | Virtual profile name (case-insensitive) |

`afterLoad` is an optional callback `(profile) => {}` invoked when
loading finishes. For URL / file loads it fires asynchronously. Inspect
`profile.loaded` and `profile.lastError` to tell success from failure.

### `profile.loadPromise(dataOrUrl)`

Promise-returning equivalent of `load()`. Resolves to the `Profile`
itself when loading completes (whether successful or not — check
`profile.loaded`).

```js
const p = await new Profile().loadPromise('file:./srgb.icc');
if (!p.loaded) throw p.lastError;
```

### `profile.loadBinary(binary, afterLoad?, searchForProfile?)`

Decode an already-in-memory `Uint8Array` containing ICC binary.

* `searchForProfile = true` — scan the buffer for an embedded profile
  signature (`acsp`) instead of treating offset 0 as the profile start.
  Useful for extracting the embedded profile out of a JPEG / TIFF.

### `profile.loadFile(filename, afterLoad?)`

Read an ICC file from local disk. Available in Node and Adobe CEP only;
not in the browser.

### `profile.loadBase64(base64String, afterLoad?)`

Decode a base64 string (with or without the `data:` prefix).

### `profile.loadURL(url, afterLoad?)`

Fetch from a URL. Uses XHR in browsers, `http.get` in Node. Has a
built-in timeout — both timeout and network errors will set
`lastError` and call `afterLoad`.

### `profile.loadVirtualProfile(name)`

Synchronously build a virtual profile by name. See the
[Built-in virtual profile names](#built-in-virtual-profile-names) table.
The leading `*` and case are normalised — `'*srgb'`, `'*sRGB'`, `'sRGB'`
all resolve to the same profile.

---

## Built-in virtual profile names

| Name | Description |
|---|---|
| `*sRGB` | sRGB IEC 61966-2.1 |
| `*AdobeRGB` | Adobe RGB (1998) |
| `*AppleRGB` | Apple RGB |
| `*ColorMatchRGB` | ColorMatch RGB |
| `*ProPhotoRGB` | ProPhoto RGB |
| `*Lab` / `*LabD50` | Lab D50 (the ICC PCS whitepoint) |
| `*LabD65` | Lab D65 |

Lab profiles are **abstract** — per the ICC specification, the engine
will not perform chromatic adaptation when a Lab profile is the source
or destination. If you need to convert a Lab D65 measurement to Lab D50
with adaptation, use `convert.Lab2Lab(...)` from
[`src/convert.js`](../src/convert.js).

---

## Properties

| Property | Type | Description |
|---|---|---|
| `loaded` | Boolean | True if the profile loaded successfully. Always check this after an async load. |
| `lastError` | Object | Set when loading fails. Contains a code + human-readable message. |
| `type` | Integer | Profile type — see `eProfileType` (Lab, RGBMatrix, RGBLut, CMYK, Gray, Duo, XYZ). |
| `name` | String | Profile name (set from your input or extracted from the profile description). |
| `header` | Object | Decoded ICC header (version, device class, colour space, PCS, render intent, primary platform, etc.). |
| `intent` | Integer | Default rendering intent declared by the profile. |
| `description` | String | Human-readable profile description (`desc` v2 / `mluc` v4). |
| `copyright` | String | Copyright text from the profile. |
| `technology` | String | Technology signature (e.g. CRT display, LCD display, ink jet printer) — see `Profile.techSignatureString()`. |
| `mediaWhitePoint` | Object | XYZ media whitepoint (`{X, Y, Z}` with `Y = 1`). |
| `outputChannels` | Integer | Number of output channels (1 for Gray, 3 for RGB / Lab / XYZ, 4 for CMYK, more for n-channel inks). |
| `unsupportedTags` | Array | List of tag signatures the decoder skipped. Populated only for ICC loads (empty for virtual). Useful for diagnosing weird profiles. |
| `virtualProfileUsesD50AdaptedPrimaries` | Boolean | When `true`, virtual profile primaries are pre-adapted to D50 (matches LittleCMS behaviour). When `false`, primaries are used as published. Default `true`. |

---

## Deprecated property names

A couple of properties exist under both their original (typo'd)
spelling and their corrected spelling. Both refer to the same underlying
data — you can read or write either name. The typo'd names are kept for
backwards compatibility and are marked `@deprecated` in the JSDoc.
Prefer the corrected names in new code:

| Deprecated (still works) | Use instead |
|---|---|
| `unsuportedTags` | `unsupportedTags` |
| `virutalProfileUsesD50AdaptedPrimaries` | `virtualProfileUsesD50AdaptedPrimaries` |

For the array (`unsupportedTags`), both names point to the **same**
underlying array — pushing to one is visible on the other. For the
boolean, writes via either name are mirrored to the other before the
profile is built.

---

## Environments

`Profile` auto-detects the runtime and uses the appropriate I/O backend:

| Environment | File reads | URL fetches |
|---|---|---|
| Node.js | `fs.readFileSync` | `http.get` / `https.get` |
| Browser | — (use `loadBinary` or `loadBase64`) | `XMLHttpRequest` |
| Adobe CEP (PS / Ai panels) | `window.cep.fs.readFile` | `XMLHttpRequest` |

`loadFile()` will throw "not supported in this environment" if you call
it from a plain browser context. For browser apps, fetch the file
yourself and pass the resulting `Uint8Array` to `loadBinary()`, or use
`loadURL()` if it's hosted somewhere CORS-accessible.
