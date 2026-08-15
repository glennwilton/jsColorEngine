# Plugin API

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Bench](./Bench.md) ·
[Performance](./Performance.md) ·
[Roadmap](./Roadmap.md) ·
[Examples](./Examples.md) ·
[API: Profile](./Profile.md) ·
[Transform](./Transform.md) ·
[Loader](./Loader.md)

---

Two extension points let you add capabilities to `Transform` without modifying
the core engine.

**`Transform.register(descriptor)`** — adds a new `lutMode` to the system.
Affects every future Transform that uses that mode.  Provides a custom kernel,
builder, and per-instance initialisation.

**`Transform.behaviour(descriptor)` + `t.use(...)`** — attaches a reusable
modifier to one specific Transform instance.  Like a PHP trait: declared once,
mixed in explicitly where needed.

---

## Lifecycle — when each hook fires

```
Transform.register(descriptor)        → descriptor.initialise fires in new Transform()
Transform.behaviour(descriptor)       → descriptor.initialise fires in Transform.behaviour()

new Transform({ lutMode: 'customLut' }) → plugin descriptor.initialise(transform, rawOpts)
t.use('ink-limit')                    → behaviour descriptor.apply(transform, mergedOpts)
t.create(src, dst, intent)            → descriptor.builder(transform)  [if provided]
                                        createLut() samples pipeline, hooks fire per cell
                                        descriptor.kernel cached on transform
t.transformArray(pixels)              → kernel called, zero selection overhead
```

**Key timing rules:**

| Hook | Fires when | Gets instance? | Once per? |
|---|---|---|---|
| plugin `initialise(transform, rawOpts)` | `new Transform()` constructor | ✓ | instance |
| behaviour `initialise()` | `Transform.behaviour()` call | ✗ | process |
| behaviour `apply(transform, opts)` | `t.use()` | ✓ | call |
| `builder(transform)` | `t.create()` build path | ✓ | LUT build |
| `kernel(...)` | `t.transformArray()` | ✓ | array call |

---

## The lutMode contract

**`kernel` and `builder` only fire when `transform.lutMode` exactly matches
your `descriptor.lutMode`.** No fallback, no inheritance.

```js
Transform.register({ name: 'My Plugin', lutMode: 'customLut', kernel: ... });

new Transform({ lutMode: 'customLut' })  // ✓  plugin active
new Transform({ lutMode: 'auto'    })  // ✗  plugin ignored
new Transform({ lutMode: 'float'   })  // ✗  plugin ignored
```

---

## Table of contents

- [Transform.register — full descriptor](#transformregister-full-descriptor)
- [Transform.behaviour + t.use](#transformbehaviour--tuse)
- [plugin store — transform.plugin](#plugin-store--transformplugin)
- [Kernel run-closure signature](#kernel-run-closure-signature)
- [Builder contract](#builder-contract)
- [JSON round-trip](#json-round-trip)
- [Transform.registered + transform.registeredMeta](#transformregistered--transformregisteredmeta)
- [Minimal example](#minimal-example)
- [Plugin wiring example](#plugin-wiring-example)
- [Constraints and gotchas](#constraints-and-gotchas)

---

## `Transform.register` — full descriptor

```js
Transform.register({

    // ── Identity ────────────────────────────────────────────────────────────
    name:    'jscolorengine-customlut',  // human-readable label for registered()
    lutMode: 'customLut',               // dispatcher key — new Transform({ lutMode: 'customLut' })

    // ── Kernel ───────────────────────────────────────────────────────────────
    kernel:      customKernelJS,        // required — JS run closure
    wasmKernel:  customKernelWasm,      // optional WASM scalar variant
    simdKernel:  customKernelWasmSimd,  // optional WASM SIMD variant
    isSupported: (variant) => {         // optional capability gate
        if (variant === 'simdKernel') return simdReady;
        if (variant === 'wasmKernel') return wasmReady;
        return true;
    },

    // ── Per-instance init ────────────────────────────────────────────────────
    // Runs in new Transform() constructor — once per instance, no flag needed.
    // Gets the instance AND raw constructor options.  Do everything here:
    // validate options, store to transform.plugin, add hooks.
    initialise: (transform, rawOpts) => {
        // Conditional activation — opt-in or opt-out per instance
        if (!rawOpts.featureEnabled) return;

        // Store plugin state in the namespaced store (not directly on transform)
        transform.plugin['customLut'].totalInk   = rawOpts.totalInk   ?? 300;
        transform.plugin['customLut'].gamutLimit = rawOpts.gamutLimit ?? true;

        // Hooks added here fire per grid cell during createLut()
        transform.addLutOutputHook(vals => rescale(vals, transform));
    },

    // ── Builder ───────────────────────────────────────────────────────────────
    // Optional — replaces createLut(). Omit to use the standard uniform CLUT.
    builder: (transform) => {
        const lut = buildAdaptiveClut(transform);
        return lut;
    },

    // ── JSON round-trip ───────────────────────────────────────────────────────
    serializer:   (json, lut) => { json.lutMode = 'customLut'; json.gridDensity = lut.gridDensity; return json; },
    deserializer: (lut)       => { lut.offsetTables = buildTables(lut.gridDensity); return lut; },

    // ── Metadata ─────────────────────────────────────────────────────────────
    meta: { version: '1.0.0', description: 'Custom LUT plugin' },
    // OR: meta: function() { return 'totalInk=' + this.plugin['customLut'].totalInk; }
});
```

`Transform.register()` returns `true` on success, `false` if that `lutMode` is
already registered (no overwrite).

---

## `Transform.behaviour` + `t.use`

Behaviours are per-instance modifiers — not tied to any `lutMode`, applied
explicitly to one Transform.

```js
// Declare the behaviour — once globally
Transform.behaviour({
    name:  'ink-limit',

    // Optional global setup at Transform.behaviour() time (no instance)
    initialise: () => { /* shared state, lookup tables, etc. */ },

    // Per-instance — called by t.use()
    apply: (transform, opts) => {
        // opts = merged(_originalOptions, explicit t.use() opts)
        // Explicit t.use() opts win over constructor opts.

        const store = transform.plugin['ink-limit'];   // auto-created by t.use()
        store.totalInk = opts.totalInk ?? 300;

        transform.addLutOutputHook(cmyk => scaleInk(cmyk, store.totalInk));
    },
});

// Apply to one instance — two forms:
const t = new Transform({ buildLut: true, totalInk: 260 });
t.use('ink-limit');                     // reads totalInk from _originalOptions → 260
t.use('ink-limit', { totalInk: 300 }); // explicit opts override _originalOptions
t.use(InkLimitDescriptor);             // pass descriptor directly (no prior registration needed)
t.create(src, dst, intent);
```

`t.use()` returns `this` for chaining:
```js
new Transform({ buildLut: true, totalInk: 260 })
    .use('ink-limit')
    .use('gamut-check')
    .create(src, dst, intent);
```

**Behaviours don't guard against double-call** — the author manages idempotency
via the plugin store if needed:

```js
apply: (transform, opts) => {
    const store = transform.plugin['ink-limit'];
    if (store.initialised) { store.totalInk = opts.totalInk ?? 300; return; }
    store.totalInk   = opts.totalInk ?? 300;
    store.initialised = true;
    transform.addLutOutputHook(cmyk => scaleInk(cmyk, store.totalInk));
}
```

---

## Plugin store — `transform.plugin`

Each registered plugin and named behaviour gets a namespaced store on the
Transform. Use it instead of adding properties directly to the Transform instance
— prevents collisions between plugins and with future Transform properties.

```js
// Auto-created by t.use('ink-limit') or by the constructor for registered plugins
transform.plugin['ink-limit'].totalInk   = 260;
transform.plugin['ink-limit'].initialised = true;

// Update state and rebuild LUT without re-calling use() or re-registering
transform.plugin['ink-limit'].totalInk = 300;
transform.lut = false;
transform.create(src, dst, intent);   // hook reads from store dynamically
```

The store is read dynamically at hook call time — closures over `transform`
always see current values. Snapshot closures over `opts` would break this.

---

## Kernel run-closure signature

All three kernel variants (`kernel`, `wasmKernel`, `simdKernel`) share this
exact signature — the same as every built-in kernel in `src/lutKernelTable.js`:

```js
function myKernel(
    transform,      // Transform instance
    inputArray,     // Uint8ClampedArray — pixel data in
    outputArray,    // Uint8ClampedArray — pre-allocated by dispatcher
    pixelCount,     // number of pixels (NOT bytes)
    lut,            // object returned by builder
    inputHasAlpha,  // boolean
    outputHasAlpha, // boolean
    preserveAlpha   // boolean
) { ... }
```

**Kernel selection** (`simdKernel > wasmKernel > kernel`) is resolved once at
`create()` time and cached — zero selection overhead in `transformArray()`.

`isSupported(variant)` is called once per variant at `create()` time.  Variant
strings are `'kernel'`, `'wasmKernel'`, `'simdKernel'`.  Defaults to
`() => true`. If WASM is initialised synchronously before `Transform.register()`,
flags will be set correctly when `isSupported` is queried.

**Note:** the kernel only fires for 3D and 4D inputs.  Gray (1D) and duotone
(2D) inputs bypass registered kernels and route to built-in paths.

---

## Builder contract

`builder(transform)` is called instead of `createLut()` when provided.  The
Transform is handed over after the temporary pipeline is built — the
device-to-device pipeline is ready for sampling.

```js
builder(transform) {
    // transform.lutGridPoints3D / lutGridPoints4D — grid size
    // transform.inputProfile / outputProfile      — profile objects
    // transform.plugin['customLut']                — plugin store
    // any hooks added in initialise are already installed

    return {
        inputChannels:  3,
        outputChannels: 4,
        gridPoints:     17,
        CLUT:           new Float64Array(...),
        // plugin-private fields the kernel will read:
        offsetTables:   { C, M, Y, K },
        gridDensity:    { C: spanC, ... },
    };
}
```

`transform.createLut()` handles all dimensionality automatically (1D/2D/3D/4D).
Call it as a base and modify the result, or build a fully custom CLUT.

**What `createLut()` actually produces:** a Float64Array CLUT in `[0,1]` — the
f64 LUT only.  For built-in integer modes (`int`, `int-wasm-*`, `int16-*`),
`buildIntLut()` is called automatically by `create()` after the builder returns.
For registered plugin modes it is **not** called.

Built-in integer kernels (`int`, `int-wasm-*`) read `lut.intLut` — a quantised
integer version of the f64 CLUT attached as a child of the same lut object.
If your custom kernel follows the same pattern, call `transform.buildIntLut(lut)`
at the end of your builder — it populates `lut.intLut` in place:

```js
builder: (transform) => {
    const lut = transform.createLut();      // f64 CLUT in [0,1]
    // ... modify lut.CLUT as needed ...
    transform.buildIntLut(lut);             // quantises to lut.intLut (child of lut)
    // ... optionally modify lut.intLut here (custom quantisation, clamping, etc.) ...
    return lut;
},
```

---

## JSON round-trip

```js
// serializer — called inside toJSON() after the core serializes CLUT/channels/chain
serializer: (json, lut) => {
    json.lutMode     = 'customLut';      // self-describing — enables fromJSON auto-detect
    json.gridDensity = lut.gridDensity;
    return json;
},

// deserializer — called inside setLut()/fromJSON() after CLUT is decoded from base64
deserializer: (lut) => {
    lut.offsetTables = buildTablesFromDensity(lut.gridDensity);
    return lut;
},
```

If the serializer writes `json.lutMode`, `Transform.fromJSON(json)` auto-detects
the plugin — no `{ lutMode: 'customLut' }` option needed at load time.

---

## `Transform.registered()` + `transform.registeredMeta()`

```js
Transform.registered();
// [{ name: 'jscolorengine-customlut', lutMode: 'customLut', meta: { version: '1.0' } }]

t.registeredMeta();   // static meta returned as-is
t.registeredMeta();   // function meta called with transform as `this`
t.registeredMeta();   // null for built-in modes or no meta
```

---

## Minimal example

```js
// my-plugin.js
const { Transform } = require('jscolorengine');

function identityKernel(transform, inputArray, outputArray, pixelCount, lut,
                        inputHasAlpha, outputHasAlpha, preserveAlpha) {
    const channels    = lut.inputChannels;
    const inputStride = channels + (inputHasAlpha  ? 1 : 0);
    const outStride   = channels + (outputHasAlpha ? 1 : 0);
    for (let pixel = 0; pixel < pixelCount; pixel++) {
        const i = pixel * inputStride, o = pixel * outStride;
        for (let c = 0; c < channels; c++) outputArray[o + c] = inputArray[i + c];
        if (outputHasAlpha) outputArray[o + channels] = 255;
    }
}

module.exports = {
    name:    'identity-plugin',
    lutMode: 'identity',
    kernel:  identityKernel,

    initialise: (transform, rawOpts) => {
        if (transform.inputProfile?.channels !== transform.outputProfile?.channels) {
            throw new Error('identity: input and output must have the same channel count');
        }
    },

    builder: (transform) => {
        const lut = transform.createLut();
        lut.CLUT = new Float64Array(0);  // kernel copies directly, no CLUT needed
        return lut;
    },

    meta: { version: '1.0', description: 'Pass-through identity transform' },
};
```

```js
const { Transform } = require('jscolorengine');
const IdentityPlugin = require('./my-plugin');

Transform.register(IdentityPlugin);

const t = new Transform({ buildLut: true, lutMode: 'identity' });
t.create(src, dst, eIntent.relative);
t.transformArray(pixels);
```

---

## Plugin wiring example

```js
// jscolorengine-customlut/index.js
const { Transform } = require('jscolorengine');

// WASM init at module load — flags ready before Transform.register()
initWasm();

module.exports = {
    name:    'jscolorengine-customlut',
    lutMode: 'customLut',
    kernel:      customKernelJS,
    wasmKernel:  customKernelWasm,
    simdKernel:  customKernelWasmSimd,
    isSupported: (v) => v === 'simdKernel' ? simdReady : v === 'wasmKernel' ? wasmReady : true,

    initialise: (transform, rawOpts) => {
        transform.plugin['customLut'].gridMode = rawOpts.gridMode ?? 'default';
    },

    builder:      buildCustomClut,
    serializer:   (json, lut) => { json.lutMode = 'customLut'; json.gridDensity = lut.gridDensity; return json; },
    deserializer: (lut) => { lut.offsetTables = buildTablesFromDensity(lut.gridDensity); return lut; },
    meta: { description: 'Custom LUT plugin' },
};

Transform.register(module.exports);
```

```js
// user
require('jscolorengine-customlut');   // self-registers

const t = new Transform({ buildLut: true, lutMode: 'customLut', gridMode: 'accuracy' });
t.create(srgb, cmyk, eIntent.relative);
t.transformArray(pixels);
```

---

## Constraints and gotchas

**Register before constructing.** `initialise` fires in `new Transform()`. A
`lutMode` passed before `Transform.register()` falls back to `'auto'` with a
warning.

**`lutMode` is immutable once registered.** `Transform.register()` returns
`false` on duplicate — the original is kept. Create a new Transform to use a
different plugin.

**1D/2D inputs bypass registered kernels.** Gray (1D) and duotone (2D) inputs
route to built-in kernels before the plugin dispatch is reached.

**No `buildIntLut` for registered modes.** Call `transform.buildIntLut(lut)`
yourself in the builder and attach the result if your kernel needs it.

**Custom builders own their hooks.** If your `builder` does not call
`transform.createLut()` internally, `addLutInputHook`/`addLutOutputHook`
callbacks will not fire automatically. Apply them manually, or call
`transform.createLut()` as a starting point.

**Serializer writes `lutMode` for auto-detection.** If the serializer includes
`json.lutMode = 'customLut'`, then `Transform.fromJSON(json)` auto-selects the
plugin at load time.

**Behaviours don't guard double-call.** Calling `t.use('ink-limit')` twice adds
the hook twice.  Use `transform.plugin['ink-limit'].initialised` as a guard if
needed.

---

## Related

- [Transform API](./Transform.md) — `buildLut`, `lutMode`, `transformArray`
- [LUT modes deep dive](./deepdive/LutModes.md) — built-in kernel dispatch
- [Roadmap](./Roadmap.md) — future plans
