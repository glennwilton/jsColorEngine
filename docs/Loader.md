# Loader

A small **optional** convenience class for managing a collection of
[`Profile`](./Profile.md)s — a simple registry that lets you queue
profiles up by key, optionally preload them in parallel, and then look
them up by key later.

> [!NOTE]
> `Loader` is a thin convenience layer on top of `Profile`. If you only
> have one or two profiles, just use `Profile` directly — `Loader`
> doesn't do anything you can't do with `await Profile.loadPromise(...)`.

> [!TIP]
> The most authoritative reference for `Loader` is the in-source JSDoc
> in [`src/Loader.js`](../src/Loader.js).

---

## Methods

### `loader.add(url, key, preload)`

Register a profile with the loader.

* `url` — anything `Profile.load()` accepts (file path with `'file:'`
  prefix, URL, base64 with `'data:'` prefix, virtual name with `'*'`
  prefix, or a raw `Uint8Array`).
* `key` — the unique ID you'll use to retrieve this profile later via
  `loader.get(key)`.
* `preload` — when `true`, the profile is loaded as part of the next
  `loadAll()` call. When `false`, it's loaded lazily on the first
  `get(key)` call.

### `await loader.loadAll()`

Load every profile registered with `preload: true` (in parallel).
Resolves once they've all finished. Profiles registered with
`preload: false` are not touched here — they remain lazy.

### `await loader.get(key)`

Return the `Profile` registered under `key`. If the profile is already
loaded, returns immediately. Otherwise loads it on demand and caches the
result.

Always check `profile.loaded` afterwards — a load can fail (network
error, bad file, unknown virtual name) and `get()` will still return
the `Profile` instance with `loaded === false` and `lastError` set.

### `loader.findByKey(key)`

Synchronously look up a profile by key. Returns the `Profile` or
`false` if not found. Does not trigger a load — use `get()` for that.

### `loader.findByURL(url)`

Synchronously look up by the original URL passed to `add()`. Returns
the `Profile` or `false`.

---

## Usage

```js
const { Loader, Transform, eIntent, color } = require('jscolorengine');

(async () => {
    const loader = new Loader();

    loader.add('*lab',                              'Lab',  true);   // preloaded
    loader.add('file:./profiles/sRGB_v4.icc',       'sRGB', true);   // preloaded
    loader.add('file:./profiles/GRACoL2006.icc',    'CMYK', false);  // lazy

    await loader.loadAll();   // 'Lab' and 'sRGB' are now ready

    const labProfile  = await loader.get('Lab');
    const cmykProfile = await loader.get('CMYK');   // loaded on demand here

    if (labProfile.loaded && cmykProfile.loaded) {
        const t = new Transform();
        t.create(labProfile, cmykProfile, eIntent.perceptual);

        const lab  = color.Lab(80.1, -22.3, 35.1);
        const cmyk = t.transform(lab);

        console.log(`CMYK: ${cmyk.C}, ${cmyk.M}, ${cmyk.Y}, ${cmyk.K}`);
    }
})();
```
