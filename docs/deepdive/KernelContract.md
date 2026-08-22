# The kernel contract

> **Status: as-built, v1.6.** All contract phases landed 2026-08-21.
> Remaining work is coverage, not shape: there is no independent oracle
> above 4 channels. See [The N-channel oracle](#the-n-channel-oracle).
>
> This is the specification **and** the journey. v1.5 split the files
> (`KernelModules.md`); v1.6 moved ownership. The old modules doc is a
> [redirect stub](./KernelModules.md). The v1.5 snapshot is git history.
> `KernelModules_impl.md` was a working file that was never committed —
> this file exists so intent can be checked against the result.

**jsColorEngine docs:**
[← Deepdive index](./README.md) ·
[Identity](./Identity.md) ·
[Matrix-shaper kernel](./MatrixShaperKernel.md) ·
[WASM kernels](./WasmKernels.md) ·
[Compiled pipeline](./CompiledPipeline.md) ·
[Plugin API](../Plugin.md)

---

## The principle

**Transform owns the pipeline. The kernel owns the transforms. One kernel
per input dimension.**

Transform decides what stages a conversion needs and in what order,
optimises them, and validates them. It does not decide how a colour is
interpolated, at any batch size, in any numeric format. That is the
kernel's, for both the single-colour path and the image path.

### What Transform actually does

Three things, and the list is the specification:

1. **Select a kernel by input dimension.** `Transform.kernels[inputDimension]`.
   Identity is dimension 0. A 7-channel press profile is 7. This is not
   always the input *channel count* — see [Identity at index 0](#kernelidentity-at-index-0).
2. **Initialise it** — offer it the LUT decision, then the built pipeline.
3. **Hand it work.** *Here is a colour, or here is an array. You work it out.*

Nothing else. Not which variant runs, not whether a batch is big enough
to be worth a WASM call, not how a fallback ladder degrades. **Batch
size is not Transform's concern.** A kernel that has a fast path for
large arrays and a different one for small holds both and picks.
Transform never learns a choice was made.

The public batch call is `kernel.array(...)`. What it calls inside
(`arrayFn`, `arrayFnBig` / `arrayFnSml`, a threshold) is the kernel's
secret. Do not put a Transform-level `transformArrayFn` or
`kernelArrayFn` back — see [Resolved](#resolved--do-not-reinvent).

### Everything Transform offers a kernel is optional

A kernel's obligations are small: answer `floatFor`, answer `array`,
clean up after itself. Everything else is a **convenience with an
escape hatch**:

| Transform offers | a kernel that wants something else |
|---|---|
| `hints` — the caller's interpolation preferences | ignores them; it is the authority on its own dimension |
| the LUT the builder baked | supplies its own through `provideLut`, in whatever representation suits it |
| `opts.helpers` — the resolver, key format, gates | never touches them and writes its own dispatch |
| `opts` named facts (`lutMode`, `wasmMatrixShaper`, `pixelCacheActive`) | reads only what it needs |

None of these is a requirement, and **nothing degrades if a kernel
declines one**. If a new member cannot be ignored, it is an obligation
rather than an offer, and it needs a better reason than convenience.

---

## How we got here

`Transform.js` used to contain everything: ICC pipeline construction,
all pixel-level math, WASM lifecycle, LUT build, and per-call dispatch.
Those concerns evolve at different rates — pipeline logic changes
rarely; kernel implementations change whenever a new CPU feature
appears. v1.5 split the files. v1.6 moved ownership.

### v1.5 — files moved, ownership did not

Three phases, each gated on a green suite and MPx/s parity
(2026-08-15):

| Phase | What it did |
|---|---|
| **A** | `registerKernel` / `setKernel` (`Object.create` instances), descriptors in `src/kernels/{1d..nd}/` that *delegated* to the tuned loops, `provideLut`, `transformArrayViaLUT` reduced to preamble + `kernel.array()` |
| **B** | ~3,250 lines of loops moved verbatim to `kernelXD_loops.js` and **re-attached to `Transform.prototype`**. WASM settle/release behind `kernel.create()` / `release()`. `.wat` / `.wasm.js` co-located |
| **C** | BIG/SMALL run refs onto the kernel instance (`_runBig` / `_runSmall` / `_threshold`), filled by `kernel.resolveRuns()`. Plugins resolved into the same slots. The three fields left Transform |

Phase B was performance-neutral on purpose: same function objects, same
`this`, same hidden class. That is why it felt finished. It was not.

The result, visible in the then-`Kernel3D.js`, was 56 lines of
delegation back out — `wasmLifecycle.settleWasmStates(this.transform)`,
`kernelUtils.resolveTableRuns(this)`, `kernelUtils.runTableKernel(...)`.
It owned a `supports` block and nothing else.

**Why the split was still worth doing.** Transform dropped from 15,878
lines toward ~11,000. Pipeline and kernels could evolve on different
clocks. Registration lived at the bottom of `Transform.js` (not
`main.js`) so `require('./Transform.js')` — including the test suites —
got the built-ins. That part stayed.

Three findings pushed v1.6:

**1. A behavioural hole, not just an aesthetic one.**
`registerKernel()` replaced the batch path only. A third-party Kernel3D
changed what `transformArray()` produced while `transform(colour)` kept
running Transform's own tetrahedral code. Single-colour and batch could
disagree for the same Transform, and a kernel author had no way to fix
it.

**2. The coupling that justified prototype attachment barely existed.**
The loop files use `this` almost only to call a sibling.
`interp.js` is the same: pure functions of `(input, lut)`. The
prototype was a namespace, not a receiver.

**3. Transform already treated the interp stage as an opaque triple.**
`optimisePipeline()` fuses by **stage name**, rewrites `stageData`
(`lut.inputScale = 1 / intValue`), and passes `stage.funct` through
without inspecting it. The only identity comparisons on any
`stage.funct` are `stage_debug` and `stage_history`. The one remaining
thing Transform did with the function was **choose** it — and that
choice is derivable from the LUT plus a few policy options.

---

## Resolved — do not reinvent

These are closed. A future session that "discovers" one of them is
reading an old spec or inventing a problem that was already paid for.
Git has the code; this table has the *reason*.

| Idea that looks reasonable | Resolved | Why not |
|---|---|---|
| Move the loops again / tidy the unrolled bodies into helpers | **No.** Read the PERFORMANCE LESSONS block at the top of `Transform.js`. Unrolling is the throughput. | Re-rolling saves ~5 KB of L1i and costs 5–10 cycles/px in mispredicts. |
| Re-attach loops to `Transform.prototype` so call sites stay identical | **Tried (v1.5 B).** Performance-neutral file move. Ownership never followed. | The next change still had to give each kernel both surfaces. |
| One `lutKernelTable` walker in Transform that dispatches every dimension | **Retired as the dispatcher.** Per-kernel `resolve()` switches live next to the kernel (`kernel3D_table.js`, `kernel4D_table.js`). `src/lutKernelTable.js` remains a generic helper (key format, plugin merge), not the owner of 3-D/4-D policy. | The v1.3 table existed because Transform dispatched every dimension from one flat structure. Nothing does that now. Do not rebuild a central 42-row table for kernels that already own a switch. |
| Share one function body between `floatFor` and the array loop | **Never.** Same tetrahedral maths, two ABIs, two array shapes. | V8 deoptimises; the array path slows **2–3×**. The 22 `run_` thunks were not cosmetic renames — they were the family boundary that kept float and int call sites apart. Phase 4's first write-up called them dead; measurement corrected that. |
| `arrayFor()` returning `{big, small, threshold}` so Transform can pick | **Superseded (phase 4e → 8).** | Telling the caller there is a threshold makes batch size Transform's business. The kernel holds both fns and compares inside `array()`. |
| `resolveRuns()` as a required descriptor member | **Never designed.** Arrived in v1.5 C as the vehicle for moving three fields off Transform. | Every spec written *after* C documented it as contract. It left Transform sequencing the resolve and comparing the threshold. Replaced by `init()` + `bindArrayRuns()` inside the kernel. |
| `transformArrayFn` / `bindTransformArrayFn` / a Transform-level `kernelArrayFn` | **Removed v1.6.** Option still accepted and ignored. | Measured no faster for images and slower for tiny batches. Once kernels own dispatch it is a wrapper around `kernel.array()`. Identity was the last reason to bind a closure; `kernels[0]` removed it. Do not restore. |
| Make `array()` `async`, or ship a stub `arrayAsync` that only `Promise.resolve`s today's path | **No. `array()` stays sync.** A waiter is a later Transform method, built when a backend actually waits (GPU `mapAsync`, UI yield). Do not put `await` on `kernel.array()`. | WASM `run()` is already sync; `create()` already paid instantiate. A Promise on every batch is the same tax as `transformArrayFn` — noise on 1M px, real on the small batches we refuse to gate. It also breaks the sequential oracle inside `transformImages()`. Workers already exist (`transformImages`). GPU is parked: upload+download dominates under ~10 MPx vs WASM SIMD ([Roadmap](../Roadmap.md#what-we-are-explicitly-not-doing)). A stub trains callers onto the slower name with no capability. |
| Identity as an `isIdentity` branch that binds a copy closure | **`KernelIdentity` at `kernels[0]`.** | Last dimension-shaped special case. Input *dimension* is not input *channel count*. Named for the role (`Identity`, not `Copy`) to match `Kernel3D` not `KernelTetrahedral`. |
| Replace `instance.array` with a bound `arrayFn` at init | **No.** `array()` is the trampoline. `arrayFn` / `arrayFnBig` / `arrayFnSml` live beside it. | Swapping `instance.array` breaks the hidden class. `kernel.array()` stays monomorphic. Identity binds `arrayFn` only; its `arrayFnBig`/`arrayFnSml` stay **null** (those are LUT dispatch slots). |
| `Transform.claimKernels` + `claims()` / `displacesLut()` | **Retired.** Kernel3D `init()` inspects the pipeline and **yields** a matrix-shaper instance. Transform has no claim list. | Channel count cannot tell `*sRGB→*AdobeRGB` (folds) from `*sRGB→GRACoL` (does not) from identity (collapses). Two hooks existed because two pipelines exist (temp device→device vs final). The dimensional owner can ask both questions itself. A claim registry at Transform level made two 3-channel accelerators collide and leaked `_pixelCacheData` into the claimant. |
| Rename `provideLut` to `wantsLut` | **Kept `provideLut`.** `displacesLut` was the narrower hook; its whole answer space already fitted. | Moving the *call* to where the temporary pipeline exists is what made the merge possible. It also removed a descriptor-vs-instance bug: `displacesLut` was asked of the shared descriptor, so any cache would have leaked across every Transform of that dimension. |
| `init` returning `{kernel: null}` means decline | **No. It means keep.** | An earlier draft used `decline` leftover from the claim registry. Kernel3D always has an answer for 3-channel input. A real decline would fail the transform. |
| Load both 3-D and 4-D WASM families on every `create()` | **Per-dimension `wasmLadder`, after `init()` yield.** One shared `instantiate()`. SIMD scalar fallthrough only when `outputChannels ∉ {3,4}`. | Used to compile tetrahedral modules for a matrix-shaper pair that then threw them away, and a second Instance for RGB→RGB that SIMD already covers. Do not put a second loader beside `src/wasm/instantiate.js`. |
| `floatFor` may return `null` and fall through | **No (phase 3).** | A stage has no fallback. A hole is discovered at transform time. `floatFor` returns a binding or raises. |
| Use `interpolationFast` as the hint for a lossy (f32 / small-grid) table | **No.** | That flag already means "reference vs tuned interpolator". A lossy *representation* needs its own hint, an accuracy budget, or a `lutMode` extension. |
| Kernel reuses one output buffer by default | **Allowed, usually wrong.** | The kernel cannot see the caller's lifetime. `transformImages()` + `onImage` that pushes buffers onto an array ends up with N references to the last image. The caller already passes its own buffer in. |
| Export `Transform.lutKernelTable` / `helpers` as public API | **Inject via `init(pipeline, opts)`, if at all.** | An export is a promise about a shape that moved twice. Built-ins that take a private path and third parties that take a public one is a contract nobody exercises. |
| Gate a kernel refactor on the content-matrix bench, on cells &lt; 256k px, or on "vs last run" | **No.** Pin `bench/baseline/<machine>/`. Gate `solo`. | Seven phases at 1.5% each is 11% slower with every step passing. 64k cells showed 17% spread with "before" in the middle of "after". The content matrix moves `lcmsWasm` columns just as hard. Two concurrent benches look like a regression. |
| Treat `lutMode: 'int-wasm-simd'` on a 1-D/2-D transform as "WASM ran" | **No.** | The mode string is the *request*, settled from `dataFormat` before the kernel is known. 1-D and 2-D have no WASM. `kernelInfo()` is what ran. |
| Treat GRACoL→GRACoL with a LUT as identity | **No.** | Identity is a collapsed *pipeline*. A LUT pair is Kernel4D (or 3D), not `kernels[0]`. |
| Pixel-cache the matrix-shaper | **No.** | ~3 ns/px. A probe costs more than the pixel. |
| Rule SIMD out of the in-kernel pixel cache because "a scalar check serialises f32x4" | **Wrong axis.** | `tetra3d_simd` lanes are the four channels at a CLUT corner; one iteration is one pixel, not four. Measured 3.07× on solids. Alpha must **not** be in the cache key. |
| Cache 1-D / 2-D input | **Precompute instead.** | Those spaces are enumerable (256 or 65,536). |
| Sell the JS matrix-shaper as a speed feature | **No. WASM beats it ~5×.** | It exists for **per-channel TRCs** (WASM keeps one shared table) and for hosts with no WebAssembly. |
| "Fix" a missing throw when `interpolation3D` is typo'd on a PCS-input LUT | **Old switch did the same.** | Trilinear override resolves the method before the bad value is examined. Device input still throws. Side-by-side vs `HEAD` settled it; do not "fix" without that probe. |
| Call `interp.tetrahedralInterp4D_3or4Ch` as a bare function | **Throws.** | 4-D reference variants reach 3-D siblings through `this`. Stages are `stage.funct.call(transform, …)`. Anything that changes invocation must keep a receiver carrying those methods. |
| Put matrix-shaper back on `Transform.registerKernel` as a peer of Kernel3D | **No.** | It lives in `src/kernels/3d/matrixShaper/` and is Kernel3D's other implementation. Transform must not learn the name. |
| Estimate allocation pressure from allocation *count* | **Overstates.** | Phase 2's per-pixel temps died in the nursery. Gray still gained ~30%, but the prediction of "catastrophic" was the count, not the lifetime. |
| One `'nd'` key for channels 5–15 | **Eleven slots, one descriptor object.** | A real 7-channel kernel can replace slot 7 alone. Tests can inject at 9. Same hidden class until a slot is actually replaced. |
| Register kernels from `main.js` | **No. Bottom of `Transform.js`.** | Direct `require('./Transform.js')` (the tests) must get them. |
| Hand the shared descriptor to a Transform | **`Object.create(descriptor)` in `setKernel`.** | Per-instance state must not leak across Transforms. Plant the same own-properties (including `arrayFn = null` and the WASM slots) on every instance so they share a hidden class. |
| A 15-D A2B oracle at 2 points/axis | **Legal, meaningless.** | No interior. Honest A2B ceiling is 10 channels; B2A (3-D in, N out) goes to 15 and is Kernel3D. |
| Bake an N-channel-input CLUT in the engine | **5/6 bake at the profile A2B density; KernelND (7–15) still returns `false`.** | WASM replaces the interpolator, so 9^5 / 7^6 are worth a table. Do not up-res. Real 7CLR A2B is ~5 pts/axis, not 2–3 — see [SyntheticProfiles.md § real grids](./SyntheticProfiles.md#what-real-profiles-actually-use). RGB→7CLR is a *3-D input* and bakes a normal 3-D LUT. |

---

## The registry — 0 to 15, dense

`Transform.kernels` is an array indexed by **input dimension**, covering
identity plus the entire ICC range (1–15; `FCLR` is 15 channels).

```js
Transform.kernels[0]  = KernelIdentity;
Transform.kernels[1]  = Kernel1D;
Transform.kernels[2]  = Kernel2D;
Transform.kernels[3]  = Kernel3D;
Transform.kernels[4]  = Kernel4D;
Transform.kernels[5]  = Kernel5D;   // int8 JS + WASM scalar
Transform.kernels[6]  = Kernel6D;
Transform.kernels[7]  = KernelND;   // slots 7–15 hold the SAME descriptor
// ...
Transform.kernels[15] = KernelND;
```

`setKernel` is one array index. There is no `'nd'` key and no
`inputChannels > 4` branch.

`registerKernel(descriptor)` validates `dimensions` as 0–15, or a
`[from, to]` range so KernelND registers slots 7–15 in one call.
Legacy `'ND'` still means `[5, 15]`. Re-registering replaces those
slots for future `create()` calls; live transforms keep the instance
they resolved at create time.

`MAX_KERNEL_DIMENSIONS` is a ceiling, not a floor — 0 is a legal lower
bound because identity has no ICC channel width.

---

## The descriptor API (as built)

| Member | Required | Purpose |
|---|---|---|
| `dimensions` | yes | 0–15, or `[from, to]` |
| `name` | yes | stable identity; re-registering the same name replaces in place |
| `supports` | no | diagnostics only |
| `floatFor(lut, hints)` | yes | `{funct, stageName}` for a single-colour pipeline stage. Called on the **descriptor**. |
| `array(in, out, px, lut, inAlpha, outAlpha, preserve)` | yes | image batch. Owns preamble, output allocation, and which secret fn runs. **Do not replace this function on the instance.** |
| `provideLut(lutMode)` | no | `null` build normally · `false` build none · a LUT object to use instead |
| `init(pipeline, opts)` | no | settle the instance; may rewrite the pipeline; may yield `{kernel: otherInstance}`. `{kernel: null}` means **keep**. |
| `create(lutMode)` | yes | settle WASM, demote lutMode; returns the settled mode |
| `release()` | yes | free WASM state |
| `emitKernel(opts)` | no | reserved for `compile()` — see [CompiledPipeline.md](./CompiledPipeline.md) |

Retired members (do not add them back): `claims`, `displacesLut`,
`resolveRuns`, `arrayFor`, `wantsLut`.

Instance fields the built-ins plant in `setKernel` so every kernel
shares one hidden class: `arrayFn`, `arrayFnBig`, `arrayFnSml`,
`threshold`, the `wasmTetra*` slots. Identity leaves the LUT slots
null on purpose.

---

## `floatFor(lut, hints)` — the kernel decides, the caller hints

`addStageLUT` is a registry lookup plus a hints object. All selection
— by `lut.inputChannels`, then `interpolation3D` / `interpolation4D`,
then `interpolationFast`, then `lut.outputChannels` — lives inside the
kernel that owns that dimension. `src/interp.js` is the built-in float
*implementations*; the kernels are the *policy*. A third-party kernel
can ignore the file.

```js
var bind = Transform.kernels[lut.inputChannels].floatFor(lut, {
    inputEncoding:            inputEncoding,
    useTrilinearFor3ChInput:  useTrilinearFor3ChInput,
    method:                   this.interpolation3D,   // or interpolation4D
    fast:                     this.interpolationFast
});
this.addStage(inputEncoding, bind.stageName, bind.funct, lut, outputEncoding, debugFormat);
```

### Hints, not orders

`hints` is advisory. The kernel is the authority on what interpolation
its dimension uses — trilinear for 3-D PCS input, tetrahedral for 4-D,
bilinear for 2-D. It may ignore a hint it has no variant for.

It is **not** free to ignore a hint *silently*. An unrecognised
`interpolation3D` throws `'Unknown 3D interpolation method "…"'` from
inside the kernel (device input). A typo in a public option must not
degrade into a default.

`interpolationFast: false` is a kernel-internal choice — the slow
`_3or4Ch` reference variants — without Transform knowing they exist.

### Statelessness is what makes this work

The float surface needs no WASM handle and no per-instance state. The
stage binds the **descriptor**, not an instance:

- `this.kernel` is the *batch* kernel, chosen by the Transform's input
  dimension
- a CMYK→RGB Transform binds its 4-D A2B stage to
  `Transform.kernels[4]` and its 3-D B2A stage to
  `Transform.kernels[3]`
- no second instance, no second lifecycle, one hidden class per
  dimension

### It may return a WASM function

Nothing says `funct` must be JS. Per single-colour call the boundary
crossing costs more than three floats of work. The consumer where it
could pay is **`createLut()`**, which bakes the grid by walking the
pipeline once per grid point — 33³ ≈ 36,000 identical-shape calls on
the `create()` path. A batch wearing a per-pixel coat. Left open;
not wired.

The PCS-input trilinear override lives **only in Kernel3D**. lcms 2.0
moved to tetrahedral and disagreed with 1.19 / SampleICC / Photoshop
on Lab-indexed LUTs because L sits on one axis and the space is
uncentred. **Its absence from Kernel4D is the point** — one function
used to carry one dimension's rule for all dimensions.

---

## The two-phase LUT contract

`optimisePipeline()` runs inside `createPipeline()`, **before**
`pipelineCreated` and before `init()`. It writes into the shared LUT
as it fuses:

```js
lut.inputScale  = 1 / intValue;        // stage_Int_to_Device folded in
lut.outputScale = lut.outputScale * intValue;
```

A stage is bound *before* its LUT's scales are final:

| hook | when | scales | may precompute from the LUT? |
|---|---|---|---|
| `floatFor(lut, hints)` | stage bind, **pre**-optimise | not final | **no** — read scales at call time |
| `init(pipeline, opts)` | **post**-optimise | final | yes |

Today's interpolators already comply — scale reads in `interp.js` are
off the `lut` argument at call time. A kernel that caches
`1/inputScale` in `floatFor` produces quietly wrong output on any
pipeline the optimiser touched.

---

## `provideLut()` and `init()` — two hooks, one object

Two questions, asked at two moments, because the answers depend on
different things:

```
kernels[n].provideLut(lutMode)      → null | false | a LUT
kernels[n].init(pipeline, opts)     → {pipeline, kernel, meta}
```

**`provideLut` runs against the temporary device-to-device pipeline**
the LUT builder makes before it walks the grid. **`init` runs against
the real one**, after `optimisePipeline()`, with `lutMode` already
settled by `create()`.

That is the whole reason v1.5 needed `displacesLut` *and* `claims`:
the first decides whether a 214 KB table gets built; the second
decides who runs the pixels. Saying `false` from `provideLut` means
**no CLUT is built**, so a later refusal would strand the caller on
the generic loops at ~8 MPx/s — worse than the table that was skipped.
Both checks therefore use the same conditions against their respective
pipelines. Kernel3D does both itself (`wantsInsteadOfLut` /
`inspect`). Opt-in via `wasmMatrixShaper: 'prefer'`.

`provideLut` is not only yes/no. A kernel may return a **different**
LUT: a smaller preview grid, f32 cells, a table never derived from
the profile pair (`createNDDeviceLUT`). Transform stores what it gets
and asks nothing. [Luts.md](./Luts.md) is the portable JSON format; a
table `toJSON()` cannot serialise is a private table, which is
allowed.

**Kernel5D / Kernel6D return `null`** (build the CLUT) at the profile's
own A2B density. **KernelND (7–15) still returns `false`** because those
grids have no interior worth baking. The temporary pipeline is still
built before the hook is asked; that cost is `create()`-once.

---

## Matrix-shaper — Kernel3D yields, Transform never learns

Under "one kernel per input dimension", a Transform-level claim list
cannot survive. It also does not need to move inside Kernel3D as a
mini-registry: there is one other 3-channel implementation, and
Kernel3D knows how to find it.

```
setKernel(3)                 → Kernel3D instance
provideLut()                 → false if the temp pipeline folds (opt-in)
init(pipeline, opts)
  ├─ inspect the FINAL pipeline
  ├─ keep  → bindArrayRuns(self); { kernel: null }
  └─ yield → Object.create(MatrixShaperKernel); { kernel: instance }
```

`*sRGB → *AdobeRGB` folds to inverse-gamma / 3×3 / gamma.
`*sRGB → GRACoL` does not. `*sRGB → *sRGB` with identity detection
collapses to a copy. **No channel count separates those three.** Only
the built pipeline does.

After `init`, `this.kernel` may not be `Transform.kernels[3]`. The
invariant is *"one kernel **owns** each dimension"*, not *"one kernel
**runs** it"*. `kernelInfo()` reports the endpoint (`matrix-shaper` or
`kernel3D`).

Detail, binaries, accuracy: [MatrixShaperKernel.md](./MatrixShaperKernel.md).

---

## The shape test — what a stranger can do without touching Transform

The point of the boundary is not the three hooks. It is that a kernel
is an isolated unit, so things nobody designed for become possible
without a core change. Falsifiable: **name something a third party
would want, and check what Transform has to learn.**

| Someone wants… | built as | what Transform must know |
|---|---|---|
| An f32 CLUT | Kernel3D `provideLut` + `floatFor` that read it | nothing |
| RGB → sepiatone, house look as a table | `provideLut` calls `createNDDeviceLUT` | nothing |
| Fast-preview on a small 8-bit grid | kernel returns 9³ / 17³ u8 when an option is set | nothing |
| A tuned 7-channel press kernel | `Transform.kernels[7] = Kernel7D` | nothing |
| A probe that records every dispatch | `Transform.kernels[9] = probe` | nothing |
| JS → WASM → GPU, two thresholds | the kernel's own sync `array()`, three internal tiers | nothing — a GPU wait is a later `arrayAsync()` on Transform, not on the kernel. Do not stub it. |

A LUT not derived from the profile pair still satisfies
`validatePipeline()` (mid-grey, no NaN, right types). Nothing about
"this LUT means profile A → profile B" was ever load-bearing. Grid
size and cell type used to be Transform-wide
(`lutGridPoints3D` / `lutGridPoints4D`); a kernel choosing both for
itself is what is new.

### The red kernel

A kernel whose `init` throws the pipeline away and returns red:

```js
init: function(pipeline, opts){
    if(opts.onlyRed) return {pipeline: redPipeline, lut: null};
    return {pipeline: pipeline};
}
```

Transform re-optimises, validates — mid-grey comes back red, which is
not NaN and is the right type, so it passes — and runs it. **That is
the goal, not a defect.** If Transform had to understand red, it would
not own only the pipeline.

The experiment found the hole: a red pipeline with the built CLUT
still attached makes `transform(colour)` return red while `array()`
returns whatever the LUT says, because the batch path uses the LUT
whenever one exists. Same single/batch divergence, re-entering through
the mutator.

**`init` owns both surfaces or neither.** Rewrite the pipeline and
settle the batch path — hand back a kernel whose `array()` agrees, or
clear the LUT. For red, clearing the LUT is the correct cheap answer.

### Wrapping rather than replacing

```js
var RedKernel = Object.create(Transform.kernels[3]);
RedKernel.name = 'kernel3D-red';        // do not skip — see below
RedKernel.init = function(pipeline, opts){
    if(opts.onlyRed) return {pipeline: redPipeline, lut: null};
    return Transform.kernels[3].init.call(this, pipeline, opts);
};
Transform.kernels[3] = RedKernel;
```

- **Override `name`.** `setKernel` already does `Object.create`, so a
  wrapper is a two-level chain. Inheriting `name` reports as
  `kernel3D` in `kernelInfo()`.
- **`supports` is inherited too.** Diagnostics-only, but a wrapper
  that narrows behaviour should narrow `supports`.

### How a custom option reaches a kernel

Top-level options are blanket-copied, so `{kernel3D_32f: true}` would
reach a kernel today. Prefer a named bag anyway:

```js
new Transform({
    kernelOptions: { kernel3D: { f32: true, preview: false } }
});
```

Keyed by **kernel name**, not dimension. Passed opaquely into
`floatFor`, `provideLut`, and `init`. Transform never validates the
bag; a typo inside it is the kernel's to catch; it survives
re-registration.

---

## Call sequence

```
create()
  ├─ isIdentity = <profile chain collapsed?>
  ├─ inputDimension = isIdentity ? 0 : inputChannels
  ├─ setKernel(inputDimension)           → Object.create(kernels[n])
  │
  ├─ IDENTITY: kernel.init() builds the copy pipeline; create() returns
  │
  ├─ createPipeline(...)                 → TEMPORARY device→device
  ├─ kernel.provideLut(lutMode)          → null | false | a LUT
  ├─ [CLUT build, unless it said otherwise]
  ├─ createPipeline(...)                 → the real one
  │    ├─ addStageLUT → kernels[lut.inputChannels].floatFor(lut, hints)
  │    │                 ↑ DESCRIPTOR, scales NOT final
  │    └─ optimisePipeline()             → folds scales into the LUT
  ├─ pipelineCreated = true
  ├─ {pipeline, kernel} = kernel.init(pipeline, opts)   yield first (cheap)
  ├─ kernel.create(lutMode)              → WINNING kernel loads its WASM
  │    └─ bindArrayRuns() once the slots exist
  └─ if init rewrote the pipeline: already re-optimised / re-validated
```

Then `array()` (the public Transform method) hands the kernel a batch
and `kernel.array()` decides everything else. There is no resolve step
after `init`.

Demotion never upgrades, and never crosses the dataFormat family:

```
int8_simd    → int8_scalar  → int8_js  → float
int16_simd   → int16_scalar → int16_js → float
```

A failed `int16-wasm-scalar` load demotes to `'int16'`, never `'int'` —
the output container (`Uint16Array` vs `Uint8ClampedArray`) is fixed
by the settled mode. `float` is the only cross-family landing point
because the float LUT scales via `lut.outputScale` at run time.

---

## `array()` — one call site; the kernel keeps its own secrets

`floatFor` is the single-colour path. `array()` is the image path.
Transform calls it. That is the entire interface.

```js
kernel.array(input, output, pixelCount, lut, inAlpha, outAlpha, preserve)
```

### What this replaced

Three drafts, each less leaky than the last:

1. **`kernel.array(...)` reaching back through
   `kernelUtils.runTableKernel`**, which consulted a resolver,
   compared a threshold, and called a run closure — with the kernel's
   own state written onto it from outside.
2. **`arrayFor()` returning a bound function.** The kernel answers
   once; the caller holds the result.
3. **`arrayFor()` returning `{big, small, threshold}`** so a caller
   could pick per call.

The third still leaks. A kernel with a WASM path above some pixel
count and a JS path below holds both and picks:

```js
// set up once, in init()
this.arrayFnBig = …;
this.arrayFnSml = …;
this.threshold  = …;      // the kernel's own number

array: function(input, output, px, lut, inAlpha, outAlpha, preserve){
    var fn = (px >= this.threshold) ? this.arrayFnBig : this.arrayFnSml;
    return fn(this.transform, input, output, px, lut, inAlpha, outAlpha, preserve);
}
```

One compare, once per image, inside the kernel that owns the reason.
A kernel with one implementation (Identity, 1-D, 2-D, N-D) assigns
`arrayFn` and there is no compare. Identity's `array()` is a
trampoline onto `this.arrayFn` so the per-call body does not switch
on `dataFormat`.

`bindArrayRuns()` in `kernelUtils.js` is how the built-in LUT kernels
fill the two slots. Plugins (`Transform.register()` custom lutModes)
resolve into the **same** slots via
`kernelUtils._resolvePluginRuns` (simd > wasm > js, threshold 0).
One dispatch path; no plugin bypass. See [Plugin.md](../Plugin.md).

The preamble (default `pixelCount`, clamp `preserve` to what the
input can supply, `ensureOutputArray`) is the kernel's. It used to be
applied by whichever caller was in front — which is how
`transformArray(input, false, false)` on a matrix-shaper pair once
returned `[]`.

---

## Helpers reach the kernel through `init`, not through an export

A third-party kernel already works with the public surface —
`registerKernel`, `floatFor`, `array` — and drives **both** paths.
Verified: an independent Kernel3D shows up in `kernelInfo()`,
`transform(colour)` and `array()` together.

What is *not* reachable without help is the dispatch machinery. Hand
it over at `init()`, do not export it:

```js
init: function(pipeline, opts){
    this.helpers = opts.helpers;   // makeKey, resolveChain, gates, threshold
    return { pipeline: pipeline };
}
```

`floatFor()` cannot use helpers: it is called on the descriptor
before any `init`. That is fine — picking a single-colour function
needs no dispatch machinery. Helpers are for the image path only.

The built-in tables are still module-level constants
(`kernel3D_table.js` reads gates at load time). Turning them into
`makeTable(helpers)` factories is a real restructure, not a rename,
and is why this is an extension rather than a requirement.

### A kernel owning its output buffer — allowed, and usually wrong

Nothing stops a kernel keeping one buffer and returning it every
call. For a fixed-size stream that removes an allocation. It is
still the wrong *default*: the kernel cannot see whether the caller
holds the result. The safe version already exists on the side that
has the knowledge — the caller passes `outputArray` and gets it
back. Permitted behind an explicit option; never the default.

---

## `KernelIdentity` at index 0

**Built.** Identity has no ICC channel width, so it used to sit
outside the registry as an `isIdentity` branch that bound
`transformArrayFn` to a copy. `setKernel(0)` when the profile chain
collapses. Transform still detects the collapse — that is a
profile-chain fact — and hands over.

`init()` builds the copy pipeline by calling back into Transform
(`addStage`, the input/output device pipelines). Those are shared by
every conversion and are not identity's to own. What belongs here is
the **decision** that an identity transform gets a device-to-device
copy between them.

`arrayFn` is bound from `dataFormat` in `init()`:

| `dataFormat` | what `arrayFn` does |
|---|---|
| `int8` / `int16` | typed-buffer memcpy; alpha stride |
| `device` | element copy into a plain `Array`, fill-alpha `1` |
| `object` / `objectFloat` | new `Array` of shallow-cloned colour objects |

Object batches used to walk the pipeline (`lastUsedKernel ===
'pipeline'`). They now report `'kernelIdentity'`. See
[Identity.md](./Identity.md) §6.

---

## Coverage — what exists, per kernel

Derived from each descriptor's `supports` and confirmed by probing a
built Transform. `kernelInfo()` reports what a given Transform
actually resolved to.

The kernel is chosen by **input** width. **Output** width then picks
the variant (or demotes). SIMD is channel-parallel on a CLUT corner
and only covers `outputChannels ∈ {3, 4}`. Wider output falls to
scalar WASM if an `intLut` exists, else float.

### Numeric variants (input)

| kernel | in | float | int8 JS | int8 WASM scalar | int8 WASM SIMD | int16 JS | int16 scalar | int16 SIMD |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `KernelIdentity` | 0 | copy | copy | — | — | copy | — | — |
| `Kernel1D` grey | 1 | ✅ | ✅ | — | — | ✅ | — | — |
| `Kernel2D` duotone | 2 | ✅ | ✅ | — | — | ✅ | — | — |
| `Kernel3D` RGB/Lab | 3 | ✅ | ✅ ⁽ᵇ⁾ | ✅ | ✅ ⁽ᶜ⁾ | ✅ ⁽ᵇ⁾ | ✅ | ✅ ⁽ᶜ⁾ |
| `Kernel4D` CMYK | 4 | ✅ | ✅ ⁽ᵇ⁾ | ✅ | ✅ ⁽ᶜ⁾ | ✅ ⁽ᵇ⁾ | ✅ | ✅ ⁽ᶜ⁾ |
| `Kernel5D` 5CLR | 5 | ✅ | ✅ | ✅ | — | — | — | — |
| `Kernel6D` Hexachrome | 6 | ✅ | ✅ | ✅ | — | — | — | — |
| `KernelND` | 7–15 | ✅ | — | — | — | — | — | — |
| **matrix-shaper** *(yielded by Kernel3D)* | 3 | — | ✅ ⁽ᵃ⁾ | ✅ | ✅ | ✅ ⁽ᵃ⁾ | ✅ | ✅ |

⁽ᵃ⁾ JS is `matrixShaperJS.js` — same fused 3×3 and curves, no LUT, no
WASM. ~62 / 57 MPx/s at int8 / int16, ≤ 1 LSB, against ~8 for the
stage pipeline and ~329 / 220 for WASM. Coverage insurance, not a
headline number.
⁽ᵇ⁾ JS int only for **narrow** output (3 or 4). Wide output (5–15)
has no `i_*_n` / `i16_*_n` and no `intLut` from `buildIntLut`.
⁽ᶜ⁾ SIMD only when `outputChannels ∈ {3, 4}`.

`matrixShaper.useVariant('simd' | 'scalar' | 'js' | null)` pins
the choice so fallbacks are reachable on machines that have SIMD.

### Input × output × format

What actually runs after `create()`. “intLut” is the integer CLUT
`buildIntLut` is willing to bake.

| in → out | intLut? | float | int8 JS | int8 WASM s | int8 WASM SIMD | int16 JS | int16 WASM s | int16 SIMD |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 1 → any | grey table | ✅ | ✅ | — | — | ✅ | — | — |
| 2 → any | duo table | ✅ | ✅ | — | — | ✅ | — | — |
| 3 → 3/4 | yes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 3 → 5–15 (print *to* HiFi) | **no** | ✅ `fl_3_n` | — | — | — | — | — | — |
| 4 → 3/4 | yes | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 4 → 5–15 | **no** | ✅ `fl_4_n` | — | — | — | — | — | — |
| 5 → any | yes (profile A2B density) | ✅ | ✅ | ✅ | — | — ⁽ᵈ⁾ | — | — |
| 6 → any | yes (profile A2B density) | ✅ | ✅ | ✅ | — | — ⁽ᵈ⁾ | — | — |
| 7–15 → any | **no** (`provideLut` false) | ✅ pipeline | — | — | — | — | — | — |

⁽ᵈ⁾ `dataFormat: 'int16'` on 5/6 **works** — it lands on the float
LUT (`outputScale` 65535). There is no int16 kernel. Not planned:
another Q0.13 pair (`tetra5d_nch_int16` / `tetra6d_nch_int16`) plus
JS oracles, for ~1.6× on a rare HiFi-16-bit *input*. Every binary
ships. int8 WASM 5/6 (~4 KB each) is the product; int16 / SIMD 5/6
are not.

Print *to* 5–15 (Lab/RGB → 7CLR) is the 3 → 5–15 row: already a
3-D bake, float `fl_3_n`. That is why 7–15 channels are cheap to
support and why they are not a kernel project. See
[NChannel.md](../NChannel.md).

### What ships (WASM)

On-demand instantiate (`src/wasm/instantiate.js`) — a matrix-shaper
pair never loads tetrahedral bytes. Still, every `.wasm.js` is in
the package:

| family | modules | ≈ `.wasm.js` |
|---|---|---|
| tetra 3D int8 + int16, scalar + SIMD | 4 | 15 KB |
| tetra 4D int8 + int16, scalar + SIMD | 4 | 17 KB |
| tetra 5D / 6D int8 scalar only | 2 | 9 KB |
| matrix-shaper int8 + int16, scalar + SIMD | 4 | 28 KB |

A 5/6 int16 twin would add two more modules and a second ladder to
test, for a format HiFi proofing almost never uses. That is the
cost/benefit.

### dataFormat

| dataFormat | `transform(colour)` | `array()` | `transformImages` | LUT export (`toJSON`) | matrix-shaper |
|---|:-:|:-:|:-:|:-:|:-:|
| `object` | ✅ | identity only (clone); colour *conversion* walks the pipeline | identity only | ✅ with `buildLut` | ✕ |
| `objectFloat` | ✅ | same | same | ✅ with `buildLut` | ✕ |
| `int8` | ✅ | ✅ | ✅ | ✅ with `buildLut` | ✅ |
| `int16` | ✅ | ✅ | ✅ | ✅ with `buildLut` | ✅ |
| `device` | ✅ | ✅ (identity copies to `Array`) | ✅ | ✅ with `buildLut` | ✕ ⁽ᵇ⁾ |

⁽ᵇ⁾ Matrix-shaper tables are indexed by an integer code; `device`
carries normalised floats.

Colour *conversion* of objects still walks the pipeline
(`lastUsedKernel === 'pipeline'`). Identity of objects is the kernel.

### Features

| feature | 1D | 2D | 3D | 4D | ND | matrix-shaper |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| alpha (skip / fill / preserve) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| multicore | ✅ | ✅ | ✅ | ✅ | ✅ ⁽¹⁾ | ✅ |
| pixel cache — accuracy path (`pixelCache`, beta) | ✅ | ✅ | ✅ ⁽⁷⁾ | ✅ ⁽⁸⁾ | ✅ | n/a ⁽²⁾ |
| pixel cache — in-kernel (1.6, beta, **off by default**) | ✕ ⁽³⁾ | ✕ ⁽³⁾ | **measured** ⁽⁵⁾ | planned ⁽⁶⁾ | ✕ | ✕ ⁽⁴⁾ |

⁽¹⁾ Workers ship the profile chain, not an N-channel CLUT.
⁽²⁾ Accuracy-path cache sits in the stage pipeline; matrix-shaper
bypasses that pipeline on the array path.
⁽³⁾ Enumerable — precompute.
⁽⁴⁾ Probe dearer than the pixel.
⁽⁵⁾ SIMD kernel, byte-identical paired exports: **3.07× solid,
2.40× 5% logo, 2.57× 30% logo**, ~1× on photos/noise. Alpha is not
in the key.
⁽⁶⁾ Same five-anchor insertion; four input bytes. Worth measuring
rather than assuming — a 4-D tetrahedral pixel is dearer, so
break-even hit rate is *lower*. That is the direction the 3-D
scoping was already wrong.
⁽⁷⁾ `'auto'` (the default) is left alone — Transform injects nothing.
A forced `1` / `N` still injects.
⁽⁸⁾ Kernel4D / 5D / 6D `init()` promote `'auto'` to `1`. `pixelCacheUsed`
is what ran. The LUT image path still uses the kernel.

---

## File layout

```
src/
  Transform.js                 — pipeline, LUT orchestration, public API
  interp.js                    — built-in float interpolators (policy is in the kernels)
  lutKernelTable.js            — generic key format / plugin merge; not the 3-D/4-D owner
  wasm/wasm_loader.js
  kernels/
    kernelUtils.js             — ensureOutputArray, bindArrayRuns, plugin resolve
    wasmLifecycle.js
    dispatchThreshold.js       — one source for the WASM break-even
    gates.js
    identity/KernelIdentity.js
    1d/  Kernel1D.js, kernel1D_loops.js
    2d/  Kernel2D.js, kernel2D_loops.js
    3d/  Kernel3D.js, kernel3D_loops.js, kernel3D_table.js, tetra3d_*
         matrixShaper/         — Kernel3D's other implementation, not registered
    4d/  Kernel4D.js, kernel4D_loops.js, kernel4D_table.js, tetra4d_*
    5d/  Kernel5D.js, kernel5D_loops.js, kernel5D_table.js, tetra5d_nch
    6d/  Kernel6D.js, kernel6D_loops.js, kernel6D_table.js, tetra6d_nch
    nd/  KernelND.js                   — 7–15 float only
```

Loop files still must not grow module-scope dependencies: bodies use
arguments, locals, and `this.*` only. Do not "clean up" the unrolled
loops.

---

## What stays in Transform, and why

Each of these has a reason. A bullet without one is how the last
boundary drifted.

- **Pipeline construction, optimisation and validation.** That is
  what Transform is for.
- **The policy options** — `interpolation3D`, `interpolation4D`,
  `interpolationFast`, `useTrilinearFor3ChInput`. Public API. Passed
  *into* kernels as hints; kernels must never read `transform.*` for
  them.
- **`lutMode` settling**, `_expectsU16`, `_isIntegerMode`. The
  settled mode is public and fixes the output container type.
  `create(lutMode)` returning the settled mode is the right shape.
- **`transformArrayViaLUT()`** — public choke point (tests + user
  code). Preamble plus `kernel.array(...)`. Throws `'No LUT loaded'`
  when there is none; `lastUsedKernel` is left unchanged on that
  throw.
- **The WASM memory management API** —
  `setWasmShrinkRatio`, `setWasmMaxMemory`, `compactWasmMemory`,
  `releaseWasmMemory`, `wasmMemoryBytes`. Public policy; the states
  being compacted live on the kernel. Forwarding accessors on
  `Transform.prototype` keep ~210 existing WASM tests honest.
- **The no-LUT dimension-generic pipeline walk.** Duplicating it in
  fifteen kernels is copy-paste for no gain. Colour-object
  *conversion* still uses it.
- **Identity *detection*.** A fact about the profile chain. The
  copy *implementation* is `kernels[0]`.

`lastUsedKernel` is the kernel `name`, or `'pipeline'` / `'cache'`.
Null until the first batch.

---

## Invariants that break silently

**1. Stage names are the coupling surface.** `compile()` resolves
emitters by `emit_js_<stageName>`. `optimisePipeline()` matches
fusion against six literal names. `floatFor` must return the stage
name alongside the function, and those names must stay byte-stable.
Change one and fusion quietly stops; throughput drops; tests still
pass.

**2. Never precompute from the LUT in `floatFor`.** Two-phase table
above.

**3. Float family and array family must never share bodies.** Once
both are members of one object, "these are both tetrahedral 3D, why
two implementations?" is the obvious thought. It is a 2–3× trap.
Belongs in the descriptor's own comments, not only here.

**4. Mutating the pipeline requires re-optimise plus re-validate.**

**5. `init` owns both surfaces or neither.** See [The red kernel](#the-red-kernel).

**6. Compare float and array output through the same container.**
`Uint8ClampedArray` rounds half-to-even; `Math.round` rounds
half-up. A 1 LSB "failure" across those is not one.

---

## V8 notes that still apply

Deep receipts: [benchmark.md](./benchmark.md) §§16–20,
[JitInspection.md](./JitInspection.md). Short version:

- The `kernel.array` call site sees at most **five shapes** (one
  hidden class per dimensional family, plus identity). Polymorphic
  at worst; V8's megamorphic cliff is >4. A real app uses 1–2.
- `ensureOutputArray` / `bindArrayRuns` are module-level —
  single-target, inlinable.
- `Object.create(descriptor)` plus a fixed order of own-properties
  is the instancing model. Do not add an occasional own-property in
  one kernel's `init` and not the others.
- Endgame for many live transforms is `Transform.compile()` /
  `new Function` ([CompiledPipeline.md](./CompiledPipeline.md)).
  `emitKernel(opts)` is reserved; not built.

---

## What this makes testable

- Inject a probe at any dimension (`kernels[9] = probe`) without
  touching a real conversion.
- Assert single-colour and batch agree for a third-party kernel —
  unprovable when only the batch path went through it.
- Assert the hint contract (unknown method throws; `interpolationFast:
  false` selects the reference).
- Assert the phase boundary: bind a stage, run the optimiser, check
  output still tracks rewritten `inputScale`.
- Assert WASM loadout *per dimension*, not "both families present".
- Assert `kernelInfo()` after an `init` yield.

`__tests__/kernel_registry.tests.js` is the contract suite.
`claimKernels`, `resolveRuns`, and `arrayFor` are asserted
**undefined**.

---

## Journey that still teaches

### Phase 2 — owning both surfaces *is* the B3 inlining

Kernel1D and Kernel2D took `floatFor` and their array loops.
`TODO (B3)` said the 1-D / 2-D array loops should be inlined like
the 3-D ones. The contract said float and array must never share
bodies. Those are the same statement: the loops shared a body
*because* nobody owned the pair.

Measured, 1M px, float lutMode, best of 5:

| workflow | before | after |
|---|---:|---:|
| gray → RGB | 72.6 | **93.8** (+29%) |
| gray → CMYK | 63.6 | **81.4** |
| gray → 6CLR | 49.7 | **64.9** |
| duotone → RGB | 50.7 | **61.5** |
| duotone → CMYK | 44.7 | **51.3** |
| duotone → 6CLR | 35.7 | **41.0** |

Gray gained more because bilinear's arithmetic dwarfed the
per-pixel allocation. Correctness: 159,744 values × 9 LUT shapes,
same `Uint8ClampedArray` container. Isolated `solo` bench on
untouched 3-D/4-D cells moved at most **+0.30%**.

### Phase 3 — proving a pure refactor is pure

`addStageLUT` went **133 lines → 34**. Risk was not a red test: a
subtly different interpolator for a combination nobody hits
directly. `HEAD` was extracted to a scratch tree and the same probe
run against both — stage names **and** colour output, fifteen
cases including every public interpolation override.
**Byte-identical.** `git archive HEAD | tar -x -C <scratch>` is
cheaper than a suite that cannot see a quiet number move.

Throughput unchanged (create-time only): jsCE median **+0.21%**
across 132 cells, `solo` worst **−0.61%**. Phase 2 gains held.

### How to gate the next kernel change

```bash
node bench/reproduce.js
node scripts/bench_compare.js          # newest run vs bench/baseline/<machine>/
```

Pinned baseline, not previous run. jsCE columns gate; `lcmsWasm` /
native are the noise-floor **control**; accuracy (`*MaxLsb`,
`*MeanLsb`) gates at **zero**. Small batches (&lt; 256k px) are
reported and never fail. Run one bench at a time. Gate `solo`, not
the content matrix. Same lesson as
[LcmsComparison.md](../LcmsComparison.md): quote the measurement
that controls its conditions.

v1.6 phases 1–8 (dense registry → `floatFor` 1/2 → `floatFor` N/3/4
→ loops+WASM onto the kernel → `{big,small,threshold}` then
withdrawn → `init` yield, no claim list → `provideLut` merge →
per-dimension WASM → `array()` secrets + Identity at 0) all used
this gate.

---

## Still open — with enough context to continue

- **Does `createLut()`'s bake walk an optimised pipeline?** Affects
  whether the bake can use a `floatFor` WASM variant safely, and
  whether the two-phase table needs a third row for the temporary
  pipeline.
- **What hint authorises a lossy representation?** New option,
  accuracy budget in `hints`, or a `lutMode` extension — not
  `interpolationFast`.
- **Per-channel TRCs vs WASM matrix-shaper.** JS carries three
  curves; WASM carries one. Second entry in Kernel3D's list, or a
  variant inside one entry? No profile in `testbed/profiles/rgb/`
  actually trips it. Treat as coverage until a calibrated display
  profile says otherwise.
- **`emitKernel(opts)` — function or source?** `compile()` currently
  sends CLUT stages to the runtime fallback. A kernel that owns its
  float function is the natural emitter.
- **A registration `parent` chain** so wrappers do not capture
  `var base = Transform.kernels[3]` at load time. Not needed yet
  (one wrapper, in a test). If built: pick *either* explicit
  `parent` *or* `Object.getPrototypeOf` — two chains that usually
  agree and sometimes do not is worse than either. Re-registering
  the same object must not make it its own parent (infinite
  `init` at create time).
- **N-channel-input u16 LUT bake** only if a real workload needs
  image-rate N-ch input. Hook is `KernelND.provideLut`;
  `tetrahedralInterpND_NCh` already honours scales. Do not build it
  for completeness.
- **In-kernel pixel cache on 4-D.** Same insertion as 3-D; measure
  it. Do not skip SIMD this time.
- **`arrayAsync()` — only when a backend waits.** `array()` and
  `kernel.array()` stay synchronous. If GPU or UI-slice yield ever
  land, add a new Transform method that returns a Promise; the
  JS/WASM path inside it may `Promise.resolve(this.array(...))` so
  callers who opted in pay one tick and everyone else does not.
  Do not mark `array()` `async` "to be ready". Workers are already
  `transformImages()`. See the resolved row.

### Future: helpers-as-factories

If built-ins also receive helpers rather than requiring them,
Transform builds them once and every kernel gets them from one
site. Instrumentation or a recording resolver becomes one change.
Blocked on the load-time tables becoming factories. The
break-even already has one source (`dispatchThreshold.js`); do not
reintroduce `entry.minPx` *and* `kernel._threshold` as two numbers
that can disagree.

---

<a id="the-n-channel-oracle"></a>

## The N-channel oracle

Every kernel above 4 channels, and every one below 3, could only
ever be checked **against itself**. `accuracy.js` compares to Little
CMS for RGB and CMYK because those are the profiles this repo can
legally ship.

That is not a small gap. A suite that only agrees with itself is
how a dropped clamp survived in **four** interpolators at once: the
reference suite ran every specialised variant against `_Master`, at
the one input scale where the bug was invisible, and the block that
used the revealing scale only ever ran the variant that was already
correct.

### The way out is to write profiles, not find them

Real ICC profiles are licensed. **A profile the engine wrote is
not.** `src/encodeICC.js`, `Profile.toICC()` /
`Profile.createGrayICC()`, `scripts/make_test_profiles.js` →
`__tests__/profiles/`. Ordinary ICC files. The second CMS is the
point; unit tests only prove the writer is self-consistent.

**Built and passing for gray.** Four profiles (γ1.0, γ1.8, γ2.2,
256-entry sampled TRC): gray → sRGB, all 256 steps, **100% within
1 LSB**, γ1.8 exact. First independent check Kernel1D has ever had.

The remaining piece is `mft2` / `mAB` encoding (2CLR–15CLR):

| | grid | cells | to |
|---|---|---|---|
| **PCS → Device** (`B2A`) | 3-D in, N out | 33³ × 15 = 538 K | **15 channels** (Kernel3D) |
| **Device → PCS** (`A2B`) | N-D in, 3 out | `points^N × 3` | **10 channels** honest |

A 15-D A2B is only encodable at 2 points/axis: a table with no
interior. Real 15-channel profiles are almost always PCS→Device
for the same reason. Journey and the two routes that measured the
wrong thing: [SyntheticProfiles.md](./SyntheticProfiles.md).
