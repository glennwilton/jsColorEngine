# Kernel Modules

> **Status: SHIPPED in v1.5.0 — phases A + B + C (2026-08-15).**
> This is the as-built architecture document. The step-by-step migration
> guide (`KernelModules_impl.md`) has been retired and its still-relevant
> content folded in here; the phase history is summarised at the bottom.
> Gates held at every phase: full test suite green (488 tests as of
> DeviceLink/NChannel landing) and MPx/s parity across all bench rows,
> including ~212 MPx/s RGB→RGB `int-wasm-simd` in Node — matching the
> README's headline number through the kernel boundary.

---

## Why

`Transform.js` used to contain everything: ICC pipeline construction, all
pixel-level math (unrolled tetrahedral loops, bilinear, linear), WASM
capability detection and lifecycle, LUT build, and per-call dispatch. Those
concerns evolve at different rates — pipeline logic changes rarely; kernel
implementations change whenever a new CPU feature appears or a faster
algorithm is found. The kernel module architecture splits them:

- **Transform.js** owns the ICC pipeline, LUT build orchestration, and the
  public API. It does not know what SIMD is. (15,878 → ~11,000 lines.)
- **`src/kernels/`** owns the image batch path: the tuned array loops, the
  WASM lifecycle, output allocation/validation, and per-call dispatch.

Single-pixel accuracy (`transform(color)`) always walks the ICC pipeline in
Transform.js — it never touches a kernel. Kernels are **LUT-only** batch
processors; the no-LUT array fallback (a dimension-generic per-pixel
pipeline walk) also stays in Transform.js, because duplicating it in every
kernel would be copy-paste risk for zero gain.

---

## File layout (as built)

```
src/
  Transform.js               — ICC pipeline, LUT build, public API, orchestration
  lutKernelTable.js          — create-time variant resolution table (see below)
  wasm/
    wasm_loader.js           — shared WASM compile/instantiate/memory utility
  kernels/
    kernelUtils.js           — ensureOutputArray, resolveTableRuns, runTableKernel
    wasmLifecycle.js         — settleWasmStates (load + demote), releaseWasmStates
    1d/
      Kernel1D.js            — gray descriptor (JS only)
      kernel1D_loops.js      — linearInterp1DArray_NCh_loop (verbatim from Transform.js)
    2d/
      Kernel2D.js            — duotone descriptor (JS only)
      kernel2D_loops.js      — bilinearInterp2DArray_NCh_loop
    3d/
      Kernel3D.js            — RGB/Lab descriptor (WASM SIMD/scalar + JS variants)
      kernel3D_loops.js      — 8 tuned 3D array loops (3Ch/4Ch/NCh × int/int16/16bit)
      tetra3d_*.wat / *.wasm.js   — WASM sources + compiled bytes (4 variants)
    4d/
      Kernel4D.js            — CMYK descriptor (WASM SIMD/scalar + JS variants)
      kernel4D_loops.js      — 7 tuned 4D array loops
      tetra4d_*.wat / *.wasm.js
    nd/
      KernelND.js            — N-channel catch-all (5CLR-15CLR), float only
```

The `*_loops.js` files were moved **verbatim** from Transform.js and are
re-attached to `Transform.prototype` at load time as non-enumerable methods
(see the `_attachPrototypeLoops` block at the bottom of Transform.js). Same
function objects, same `this` binding, same hidden-class behaviour — every
call site (lutKernelTable run closures, kernel modules, tests) is unchanged,
which is why the move was performance-neutral. Do not add module-scope
dependencies to loop files: bodies may only use their arguments, locals,
and `this.*`.

---

## Registration and instancing

Descriptors are registered once at the bottom of Transform.js (not
`main.js`, so direct `require('./Transform.js')` consumers — including the
test suites — get them too):

```js
Transform.registerKernel(require('./kernels/1d/Kernel1D.js'));  // '1d'
...
Transform.registerKernel(require('./kernels/nd/KernelND.js'));  // 'nd' (dimensions: 'ND')
```

`registerKernel(descriptor)` validates `descriptor.dimensions` (1–4 or
`'ND'`) and stores it in `Transform.kernels` keyed `'1d'…'4d','nd'`.
Registering again for the same dimensions replaces the slot for all future
`create()` calls — that's the **global override** path for kernel
developers. Live transforms keep the kernel instance they resolved at
create() time; swapping a descriptor never changes pixel math mid-run.

Per-Transform instancing happens in `setKernel(inChannels)` at create()
time (`inputChannels > 4` routes to `'nd'`):

```js
var instance = Object.create(descriptor);   // descriptor IS the prototype
instance.transform = this;                  // back-reference
instance._variant = null;
instance._runBig = null;                    // dispatch refs — see below
instance._runSmall = null;
instance._threshold = 0;
instance._runBigKey = null;
instance._runSmallKey = null;
this.kernel = instance;
```

`Object.create(descriptor)` with own-properties added in a fixed order means
every instance of a given dimension shares one hidden class — monomorphic
dispatch, zero class boilerplate. Never hand the shared descriptor to a
transform directly: per-instance state (`_variant`, run refs, `transform`)
must not leak across Transforms.

**Per-instance override** without touching the global registry: subclass and
override `setKernel()`.

---

## The kernel descriptor API

| Member | Required | Purpose |
|---|---|---|
| `dimensions` | yes | 1–4, or `'ND'` for the 5+-channel catch-all |
| `supports` | no | declarative variant capability map — diagnostics only |
| `create(lutMode)` | yes | settle WASM states, demote lutMode if the host can't run the request; returns the settled mode |
| `resolveRuns()` | yes | resolve BIG/SMALL run refs onto the instance (see Dispatch) |
| `array(in, out, px, lut, inAlpha, outAlpha, preserve)` | yes | image batch — owns output allocation/validation and dispatch |
| `release()` | yes | free WASM states |
| `provideLut(lutMode)` | no | intercept the LUT build: `{lut}` = use it, `false` = no LUT (pipeline path), `null` = build normally |

Call sequence per `create()` (inside `createMultiStage`):

```
setKernel(inputChannels)                    — instance created
kernel.provideLut(lutMode)                  — may take over / decline the LUT build
[LUT build via createLut() if applicable]
this.lutMode = kernel.create(this.lutMode)  — WASM settle + demotion
_expectsU16 / _isIntegerMode cached from the settled lutMode
_resolveLutKernels()                        — orchestrator → kernel.resolveRuns()
```

`create(lutMode)` currently delegates to `wasmLifecycle.settleWasmStates`,
which deliberately keeps the v1.5 behaviour of loading BOTH the 3D and 4D
WASM module families on every create, whatever the input dimension: lutMode
demotion is keyed on the 3D compile result (it answers "does this host
support WASM/SIMD") and the WASM test suites assert the full state loadout.
Splitting the load per-dimension is a possible later optimisation.

Demotion never upgrades, and never crosses the dataFormat family:

```
int8_simd    → int8_scalar  → int8_js  → float
int16_simd   → int16_scalar → int16_js → float
```

A failed `int16-wasm-scalar` load demotes to `'int16'`, never `'int'` — the
output container type (`Uint16Array` vs `Uint8ClampedArray`) is fixed by the
settled mode. `float` is the only cross-family landing point because the
float LUT scales via `lut.outputScale` at run time.

---

## Dispatch — how a pixel batch runs

```
transformArray(...)                             Transform.js
  ├─ transformArrayFn (identity copy, or opt-in bound closure)
  ├─ LUT path → transformArrayViaLUT(...)       preamble only (public choke point)
  │    └─ this.kernel.array(...)                THE kernel boundary
  │         ├─ kernelUtils.ensureOutputArray    allocate / validate output
  │         └─ 1D/2D: this.transform.<loop>()   direct tuned loop
  │            3D/4D: kernelUtils.runTableKernel(kernel, ...)
  │                 └─ (px >= kernel._threshold ? kernel._runBig : kernel._runSmall)(transform, ...)
  │                      └─ tuned loop on Transform.prototype, or WASM state run
  └─ no-LUT path → per-pixel pipeline walk      Transform.js (dimension-generic)
```

**Resolution happens once, at create() time.** `kernel.resolveRuns()` →
`kernelUtils.resolveTableRuns(kernel)` walks the fallback chain in
`src/lutKernelTable.js` for the (lutMode × inCh × outCh) triple twice —
floor `Infinity` for the BIG (WASM-eligible) entry, floor `0` for the SMALL
(JS) entry — and caches `_runBig` / `_runSmall` / `_threshold` (plus
`_runBigKey` / `_runSmallKey` diagnostics) **on the kernel instance**.
Transform.js holds no dispatch state.

Per-call "dispatch" is therefore: one null check, one `pixelCount`
threshold compare, one indirect call. The threshold compare is the only
decision that cannot move to create() time — WASM loses to JS below ~300
pixels (`Transform.WASM_DISPATCH_MIN_PIXELS`), and the batch size is only
known per call. When BIG and SMALL collapse to the same entry the threshold
is 0 and the branch is dead.

`lutKernelTable.js` remains the single source of truth for variant
resolution (gates on WASM state availability, intLut presence, cMax
bucketing, fallback degradation). It runs at create() time only — never in
the hot path. Its entries could migrate into the kernel files for full
co-location; that's cosmetic and listed under future work.

1D/2D LUTs never use the table — their kernels call the interp loops
directly and their run slots stay null by design.

**Plugins** (`Transform.register()` custom lutModes) resolve into the SAME
kernel run slots via `kernelUtils._resolvePluginRuns` (most capable of
simd > wasm > js wins, threshold 0, key `'<lutMode>:plugin'`). One dispatch
path for everything — no separate plugin bypass, and no change to the
plugin descriptor contract. The plugin API additionally owns LUT build
hooks, custom builders, serializers, and `initialise` — see
`docs/Plugin.md`.

---

## `provideLut(lutMode)` — kernel-controlled LUT build

Called by `createMultiStage()` (null-guarded) when `buildLut: true` and no
LUT is supplied. Return values:

| Return | Effect |
|---|---|
| object | becomes `this.lut` (stub or full CLUT — kernel's `array()` must understand it) |
| `null` | normal `createLut()` build |
| `false` | LUT declined — `buildLut` is cleared and the per-pixel pipeline path is used |

As built: Kernel1D–4D return `null`. **KernelND returns `false`** with a
`console.warn` — an N-channel-input CLUT bake grows as `grid^N` cells
(a 17-pt 5D grid is ~11 MB at u16; 7D is hopeless) and the profile's own
A2B grid is authoritative anyway (the 7CLR test profile carries a 5-pt
grid). If a u16 N-D bake is ever needed, `provideLut` is where it lands:
build the `Uint16Array` stub with `outputScale: 1/65535` and reduced grid
density; `tetrahedralInterpND_NCh` already honours the scales. Note the
N-channel **output** direction (e.g. RGB→7CLR) doesn't come through here —
that's a 3D-input transform using Kernel3D with the generic 3D→NCh loops,
and it bakes a normal (small) 3D LUT.

The matrix-shaper fast path (skip the CLUT entirely, return a
gamma/matrix/gamma stub) is the other intended `provideLut` user — see
`MatrixShaperKernel.md` (not yet wired).

---

## What stays in Transform.js by design

- **Single-pixel stage interpolators** (`tetrahedralInterp3D_3Ch`,
  `tetrahedralInterp4D_NCh`, `tetrahedralInterpND_NCh`, `linearInterp1D_NCh`,
  …) — these are ICC pipeline stage functions called by the pipeline
  walker, not by kernels.
- **The no-LUT array loop** — dimension-generic pipeline walk.
- **`transformArrayViaLUT()`** — kept as the public choke point (52 test
  call sites plus user code); it is preamble + `kernel.array(...)` and
  nothing else. `transformArray()` routes its LUT path through it.
- **WASM memory management API** (`setWasmShrinkRatio`, `setWasmMaxMemory`,
  `compactWasmMemory`, `releaseWasmMemory`, `wasmMemoryBytes`,
  `_postRunWasmCheck`) — public API over the transform-held state slots.
  `releaseWasmMemory()` delegates the nulling to
  `wasmLifecycle.releaseWasmStates` and re-resolves dispatch; WASM-variant
  runs call `transform._postRunWasmCheck()` from inside the kernel dispatch
  (JS variants don't).
- **`_resolveLutKernels()`** — now a thin orchestrator: reset/bind
  `transformArrayFn` (identity closure; opt-in `bindTransformArrayFn`
  closures), then `kernel.resolveRuns()`.

---

## V8 / performance notes

The dispatch-history lessons (why the v1.3 table beat closures, why
`this.kernel.array(...)` is fine) are covered in depth in
`benchmark.md` §16–20 — short version relevant here:

- The `kernel.array` call site sees at most **5 shapes ever** (one hidden
  class per dimension), bounded by construction — polymorphic at worst,
  never megamorphic (V8's cliff is >4). A real app uses 1–2. The
  bench-harness pathology needs many unbounded callees.
- `ensureOutputArray` / `runTableKernel` are module-level functions —
  single-target, trivially inlinable.
- The tuned loops stayed the same function objects on
  `Transform.prototype`; the `run(transform, …)` call through the resolved
  refs is bit-identical to v1.5.
- Measured after each phase: JS int/float/no-LUT parity across all four
  bench directions (`bench/mpx_summary.js`, multi-round), and
  `int-wasm-simd` at ~212 MPx/s RGB→RGB in Node — the README headline
  number, through the full kernel boundary. The scenario-shape caveats in
  `benchmark.md` apply to how you measure, not to this architecture.
- The endgame for apps juggling many transforms is
  `Transform.compile()` / `new Function` (see `CompiledPipeline.md`); the
  descriptor shape reserves an optional `emitKernel(opts)` hook for feeding
  it, without API breakage when it lands.

---

## Future work

| Item | Notes |
|---|---|
| `Transform.kernelInfo()` / `transform.currentMode()` diagnostics | read `supports` + settled state; no runtime effect |
| Co-locate lutKernelTable entries into kernel files | cosmetic — resolution is create-time only |
| `emitKernel(opts)` → `compile()` integration | descriptor hook reserved; see CompiledPipeline.md |
| N-channel-input u16 LUT bake via `KernelND.provideLut` | only if a real workload needs image-rate N-ch input |
| Per-dimension WASM module loading | currently both families load on every create (test-asserted) |
| Matrix-shaper `provideLut` stub kernel | see MatrixShaperKernel.md |
| 1D/2D loop inlining (TODO B3 markers in loop files) | gray/duo loops still delegate per pixel |

---

## Migration history (condensed)

| Phase | Landed | Content |
|---|---|---|
| A | 2026-08-15 | `registerKernel`/`setKernel` (instance objects via `Object.create`), `src/kernels/{1d..nd}/` descriptors delegating to the tuned loops, `provideLut` hook, `transformArrayViaLUT` reduced to preamble + `kernel.array()` |
| B | 2026-08-15 | ~3,250 lines of tuned array loops moved verbatim to `kernelXD_loops.js` (prototype re-attach); WASM settle/release moved to `wasmLifecycle.js` behind `kernel.create()`/`release()`; `.wasm.js` + `.wat` co-located into `src/kernels/{3d,4d}/` |
| C | 2026-08-15 | BIG/SMALL run refs onto the kernel instance (`_runBig`/`_runSmall`/`_threshold`), resolved by `kernel.resolveRuns()`; plugins resolve into the same slots; `_lutKernelBig`/`_lutKernelSmall`/`_lutKernelThreshold` removed from Transform |

Every phase was gated on: full test suite green, `bench/mpx_summary.js`
parity across all rows (multi-round, variance-aware), browser bundle
builds. Tests that asserted the old field locations were updated to the
new ones (`transform_lutKernelTable.tests.js`, `plugin_identity.tests.js`)
with identical coverage.
