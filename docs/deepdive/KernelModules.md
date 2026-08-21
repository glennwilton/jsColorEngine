# Kernel Modules

> **Status: SHIPPED in v1.5.0 — phases A + B + C (2026-08-15).**
> This is the as-built architecture document. The step-by-step migration
> guide (`KernelModules_impl.md`) has been retired and its still-relevant
> content folded in here; the phase history is summarised at the bottom.
> Gates held at every phase: full test suite green (488 tests as of
> DeviceLink/NChannel landing) and MPx/s parity across all bench rows,
> including ~212 MPx/s RGB→RGB `int-wasm-simd` in Node — matching the
> README's headline number through the kernel boundary.
>
> **Superseded in part by [KernelContract.md](./KernelContract.md)**
> (DESIGN, v1.6). That document moves the single-colour interpolators,
> the tuned loops and the WASM state onto the kernels themselves, makes
> the registry a dense 1-15 array, and replaces `claims`/`displacesLut`/
> `provideLut` with `init()` + `wantsLut()`. Read this file for what ships
> today and that one for where it is going.

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
Transform.js — it never touches a kernel. Dimensional kernels are **LUT-only**
batch processors; the no-LUT array fallback (a dimension-generic per-pixel
pipeline walk) also stays in Transform.js, because duplicating it in every
kernel would be copy-paste risk for zero gain.

> **Revised.** That "LUT-only" rule held while every kernel was a table
> walker. The matrix-shaper kernel has no CLUT at all — two 1-D tables and
> nine coefficients — and is the fast path precisely when there is *no* LUT.
> It joins the registry as a **claiming** kernel rather than a dimensional
> one; see [Claiming kernels](#claiming-kernels--selected-by-pipeline-shape-not-channel-count).

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
    matrixShaper/
      KernelMatrixShaper.js  — CLAIMING descriptor (see below) — no CLUT
      matrixShaperKernel.js  — inspect / build / wantsInsteadOfLut
      matrix_shaper_int{8,16}_{simd,scalar}.wat / .wasm.js
    3d/
      Kernel3D.js            — RGB/Lab descriptor (WASM SIMD/scalar + JS variants)
      kernel3D_loops.js      — 8 tuned 3D array loops (3Ch/4Ch/NCh × int/int16/16bit)
      tetra3d_*.wat / *.wasm.js   — WASM sources + compiled bytes (4 variants)
    4d/
      Kernel4D.js            — CMYK descriptor (WASM SIMD/scalar + JS variants)
      kernel4D_loops.js      — 7 tuned 4D array loops
      tetra4d_*.wat / *.wasm.js
    nd/
      KernelND.js            — N-channel catch-all, registered across slots 5..15, float only
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
Transform.registerKernel(require('./kernels/nd/KernelND.js'));  // slots 5..15 (dimensions: [5, 15])
```

`registerKernel(descriptor)` validates `descriptor.dimensions` and stores the
descriptor in `Transform.kernels`, **an array indexed by input channel count
over 1..15** — the full ICC range (`FCLR` is 15 channels). `dimensions` is
either one channel count or an inclusive `[from, to]` range; `KernelND`
registers `[5, 15]`, putting one descriptor object into eleven independently
replaceable slots. Legacy `'ND'` is still accepted and means `[5, 15]`.
*(Landed 2026-08-21, phase 1 of [KernelContract.md](./KernelContract.md).)*
Registering again for the same dimensions replaces the slot for all future
`create()` calls — that's the **global override** path for kernel
developers. Live transforms keep the kernel instance they resolved at
create() time; swapping a descriptor never changes pixel math mid-run.

Per-Transform instancing happens in `setKernel(inChannels)` at create()
time (one array index — no key string, no `> 4` special case):

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

## Claiming kernels — selected by pipeline shape, not channel count

> **This section revises two statements above.** "Kernels are LUT-only batch
> processors" and "kernel selection is by input channel count" were both true
> of every kernel until the matrix shaper. They are now the description of
> *dimensional* kernels specifically.

A dimensional kernel owns a channel count and is chosen in `setKernel()`,
**before the pipeline is built** — three channels in means Kernel3D, always.
That works because a table walker only needs to know the table's shape.

It does not work for a kernel whose applicability depends on what the
optimiser did. `*sRGB → *AdobeRGB` and `*sRGB → GRACoL` are both 3-channel
input; only the first folds to a curve, a 3×3 and another curve. `*sRGB →
*sRGB` with identity detection on is 3-channel too, and collapses to a copy
with nothing left to accelerate. **No channel count separates those three
cases. Only the built pipeline does.**

So a descriptor may declare `claims(transform)` instead, and is offered the
transform after `pipelineCreated`:

```js
module.exports = {
    name: 'matrix-shaper',
    dimensions: 3,                       // informational; does NOT take the slot
    claims: function(transform){ ... },  // cheap, post-pipeline, {ok, why}
    displacesLut: function(transform){ ... },   // optional, see below
    create, resolveRuns, array, release, provideLut     // the usual contract
};
```

`registerKernel()` routes on the presence of `claims`: a claiming descriptor
goes into `Transform.claimKernels` in registration order, a dimensional one
into `Transform.kernels[key]` as before. **A claiming kernel never occupies a
dimensional slot** — decline it and the transform still gets Kernel3D, which
is what every LUT-based RGB pair continues to use.

### The two decision points, and why they are different hooks

```
create()
  ├─ setKernel(inputChannels)          dimensional kernel, by channel count
  ├─ kernel.provideLut(lutMode)        may refuse to build a LUT at all
  ├─ [LUT build]
  │    └─ displacesLut(transform)      ← asked of claiming kernels, against the
  │                                       TEMPORARY device-to-device pipeline,
  │                                       to skip the CLUT grid walk entirely
  ├─ createPipeline(...)
  ├─ pipelineCreated = true
  ├─ kernel.create(lutMode)            WASM lifecycle for the dimensional kernel
  └─ _claimKernel()                    ← claims(transform), against the FINAL
                                          pipeline; first yes takes this.kernel
```

They cannot be one hook because they run against different pipelines at
different times. `displacesLut` sees the three-stage device-to-device pipeline
the LUT builder makes before walking the grid; `claims` sees the five-stage
final one with its int conversions. Both matter: the first decides whether a
214 KB table gets built, the second decides who runs the pixels.

`displacesLut` is deliberately conservative. Saying yes means **no CLUT is
built**, so a later refusal by `claims` would strand the caller on the generic
loops at ~8 MPx/s — worse than the table that was skipped. Both hooks therefore
check the same conditions against their respective pipelines.

### Contract notes

- **`claims()` must be cheap.** It runs on every `create()`. The matrix shaper
  walks five stage names and samples the two curves at 33 points. Table
  building — 3–8 ms — is deferred to the first `array()` call, so a Transform
  that only ever converts single colours never pays for it.
- **`array()` may return `null`** to mean "I declined after all"; the caller
  falls through to the generic loops rather than being stranded.
- **A claim that throws is treated as a decline.** A third-party kernel is
  registered code running inside `create()`, and declining is always an
  available answer, so an exception must not take the Transform down.
- **`clear()` releases the kernel.** A claimed kernel is bound to the pipeline
  that earned it the claim and holds a WASM instance — up to 512 KB of tables
  at int16, plus pixel buffers. `create()` re-runs both selection steps.
- **Registering the same `name` again replaces in place**, keeping order
  stable, rather than appending a second copy that would never be reached.

### Inspecting the result

`transform.kernelInfo()` reports which kernel holds the batch path:

```js
t.kernelInfo()
// { name: 'matrix-shaper', dimensions: 3, claimed: true, lutMode: 'float',
//   hasLut: false, built: true, variant: '8-simd', bits: 8, simd: true }

// a LUT-based pair, same channel count:
// { name: 'kernel3D', dimensions: 3, claimed: false,
//   lutMode: 'int-wasm-simd', hasLut: true }
```

`built` is false between the claim and the first batch call — a real state,
worth being able to see rather than an implementation detail to hide.

### Cost

None measurable. The claim pass is one predicate per registered claiming
kernel per `create()`, and dispatch is the same single indirect call it was
before — the matrix shaper measured 338.6 MPx/s through the kernel boundary
against 331 when it was hard-coded into `transformArray`, which is inside the
run-to-run spread.

---

## The kernel descriptor API

| Member | Required | Purpose |
|---|---|---|
| `dimensions` | yes | 1–15, or `[from, to]` for a range (`'ND'` = `[5, 15]`) |
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

## Coverage — what exists, per kernel

Derived from each descriptor's `supports` block and confirmed by probing a
built Transform, not from memory. `transform.kernelInfo()` reports which of
these a given Transform actually resolved to.

### Numeric variants

| kernel | channels in | float | int8 JS | int8 WASM scalar | int8 WASM SIMD | int16 JS | int16 scalar | int16 SIMD |
|---|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `Kernel1D` grey | 1 | ✅ | ✅ | — | — | ✅ | — | — |
| `Kernel2D` duotone | 2 | ✅ | ✅ | — | — | ✅ | — | — |
| `Kernel3D` RGB/Lab | 3 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `Kernel4D` CMYK | 4 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `KernelND` | 5–15 | ✅ | — | — | — | — | — | — |
| **matrix-shaper** *(claiming)* | 3 | — | ✅ ⁽ᵃ⁾ | ✅ | ✅ | ✅ ⁽ᵃ⁾ | ✅ | ✅ |

Two things that table is there to make visible:

**`lutMode` is not the same question as "what ran".** A 1D or 2D transform with
`dataFormat: 'int8'` reports `lutMode: 'int-wasm-simd'`, because the mode is
settled from the dataFormat before the kernel is known — but 1D and 2D have no
WASM variant at all, and their JS interpolation loops run regardless. The mode
string is the *request*, resolved; `kernelInfo()` is the answer.

**The matrix-shaper kernel is the inverse of the others.** No float variant,
because it is not a table walker — it exists only where there is no LUT. It
also does not own a dimensional slot: a 3-channel pair it declines still gets
`Kernel3D`.

⁽ᵃ⁾ **The JS implementation is `matrixShaperJS.js`**, reading the same fused
3×3 and the same curves off `stage_matrix_rgb.stageData` — no LUT, no WASM.
62 MPx/s at int8 and 57 at int16, ≤ 1 LSB, one function for both depths,
against 8 for the stage pipeline it replaces and 329 / 220 for WASM.

**It is not a speed feature and should not be sold as one** — WASM beats it
5×. It exists for two things WASM cannot do:

- **Per-channel TRCs.** The WASM kernel keeps one input and one output table
  shared across R/G/B, so a profile whose `rTRC`/`gTRC`/`bTRC` genuinely differ
  would otherwise drop to the stage pipeline at ~8 MPx/s. JS has no table-size
  pressure and carries three. When the curves ARE grey — every ordinary working
  space — all three references point at one table, so the common case allocates
  once and the hot loop cannot tell the difference.
- **Hosts with no WebAssembly.**

Note this is a **no-LUT problem only**: `createLut()` walks the grid through
the gamma stages, so a CLUT has per-channel curves baked into its samples, and
the WASM LUT kernels can be pure interpolators. And no profile in
`testbed/profiles/rgb/` actually trips it — so treat it as coverage insurance
until a calibrated display profile says otherwise.

`matrixShaper.useVariant('simd' | 'scalar' | 'js' | null)` pins the choice.
It exists because every machine that runs the test suite has WASM with SIMD, so
both fallbacks are otherwise unreachable — and unreachable code is untested
code.

### dataFormat

| dataFormat | `transform(colour)` | `transformArray` | `transformImages` (multicore) | LUT export (`toJSON`) | matrix-shaper kernel |
|---|:-:|:-:|:-:|:-:|:-:|
| `object` | ✅ | throws | throws | ✅ with `buildLut` | ✕ |
| `objectFloat` | ✅ | throws | throws | ✅ with `buildLut` | ✕ |
| `int8` | ✅ | ✅ | ✅ | ✅ with `buildLut` | ✅ |
| `int16` | ✅ | ✅ | ✅ | ✅ with `buildLut` | ✅ |
| `device` | ✅ | ✅ | ✅ | ✅ with `buildLut` | ✕ ⁽⁷⁾ |

`transformArray` throws for the object formats rather than guessing: a flat
array cannot carry a colour object, and the pipeline would return NaN. That is
also why multicore excludes them — the worker path is the array path.

⁽⁷⁾ `device` declines at the first gate — `dataFormat is not int8 or int16` —
because the kernel's tables are indexed by an integer code and `device` carries
normalised floats. Verified by probe, not assumed.

### Features

| feature | 1D | 2D | 3D | 4D | ND | matrix-shaper |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| alpha (skip / fill / preserve) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| multicore | ✅ | ✅ | ✅ | ✅ | ✅ ⁽¹⁾ | ✅ |
| pixel cache — accuracy path (`pixelCache`, beta) | ✅ | ✅ | ✅ | ✅ | ✅ | n/a ⁽²⁾ |
| pixel cache — in-kernel (1.6, beta, **off by default**) | ✕ ⁽³⁾ | ✕ ⁽³⁾ | **measured** ⁽⁵⁾ | planned ⁽⁶⁾ | ✕ | ✕ ⁽⁴⁾ |

⁽¹⁾ N-channel reaches the workers by shipping the profile chain rather than a
LUT, because an N-channel CLUT would be enormous. Same result, different
payload.

⁽²⁾ The accuracy-path cache sits in the stage pipeline; a matrix-shaper
transform bypasses that pipeline entirely on the array path.

⁽³⁾ 1D and 2D input spaces are *enumerable* — 256 or 65,536 entries. Precompute
the whole answer instead of caching part of it.

⁽⁴⁾ ~3 ns/pixel. A probe costs more than the pixel it would save; the cache is
worth least exactly where the kernel is best.

⁽⁵⁾ Measured on the **SIMD** kernel, not the scalar fallback — the original
scoping ruled SIMD out on the grounds that "a scalar check serialises what
f32x4 vectorises", which is true of a pixel-parallel kernel and `tetra3d_simd`
is not one: its lanes are the four channels at a CLUT corner, one iteration is
one pixel. Paired exports against the shipped binary, all outputs
byte-identical: **3.07× solid, 2.40× on a 5% logo, 2.57× on a 30% logo**,
1.04× on an illustration, 0.93–0.96× on photographs, 0.99× on noise. The
uncached export measures 0.985–1.008×, a tie, because there is no cache code
in it. Alpha is **not** in the key and must not be — a solid RGB under a
per-pixel alpha gradient hits every pixel, measured 2.80× with alpha preserved
exactly.

⁽⁶⁾ 4D is the same five-anchor insertion; only the key differs, packing four
input bytes instead of three. Worth measuring rather than assuming: a 4D
tetrahedral pixel is dearer, so the break-even hit rate is lower and the case
should be stronger — but that is the direction the 3D scoping was wrong in
once already.

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
  walker, not by kernels. (Since the v1.5.5 file split their source lives
  in `src/interp.js`, but they remain `Transform.prototype` methods —
  attached at the bottom of Transform.js — so behaviourally nothing moved.)
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
| ~~`Transform.kernelInfo()` diagnostics~~ | **shipped v1.5.5** — reports name, dimensions, claimed, lutMode, hasLut, and once built, variant/bits/simd |
| Co-locate lutKernelTable entries into kernel files | cosmetic *while the loops live on `Transform.prototype`* — under [KernelContract.md](./KernelContract.md) the 22 `run_` thunks do not move, they cease to exist |
| `emitKernel(opts)` → `compile()` integration | descriptor hook reserved; see CompiledPipeline.md |
| N-channel-input u16 LUT bake via `KernelND.provideLut` | only if a real workload needs image-rate N-ch input |
| Per-dimension WASM module loading | currently both families load on every create (test-asserted). Phase 7 of [KernelContract.md](./KernelContract.md) — needs the loadout test re-expressed against a host-capability probe first |
| ~~Matrix-shaper `provideLut` stub kernel~~ | **superseded v1.5.5** — it is a claiming kernel with a `displacesLut` hook, not a dimensional one with a `provideLut` stub. `provideLut` is asked before the pipeline exists, which is too early for this decision. |
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
