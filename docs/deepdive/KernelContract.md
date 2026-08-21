# The kernel contract

> **Status: phases 1-5 landed 2026-08-21. Phase 6 (`wantsLut`), phase 7
> (per-dimension WASM) and the simplification below are not built.**
> This is the specification for the v1.6 kernel boundary. The shipped architecture is described in
> [KernelModules.md](./KernelModules.md), which this supersedes in part; when
> this lands, the two are folded into one as-built document.
>
> The previous migration's design notes (`KernelModules_impl.md`) were a
> working file that was never committed, so the original intent could not be
> checked against the result. This file is committed for that reason.

**jsColorEngine docs:**
[← Deepdive index](./README.md) ·
[Kernel modules (as built)](./KernelModules.md) ·
[Matrix-shaper kernel](./MatrixShaperKernel.md) ·
[WASM kernels](./WasmKernels.md) ·
[Compiled pipeline](./CompiledPipeline.md)

---

## The principle

**Transform owns the pipeline. The kernel owns the transforms. One kernel per
input dimension.**

Everything below follows from that sentence. Transform decides what stages a
conversion needs and in what order, optimises them, and validates them. It
does not decide how a colour is interpolated, at any batch size, in any
numeric format. That is the kernel's, and it is the kernel's for both the
single-colour path and the image path.

### What Transform actually does

Three things, and the list is the specification:

1. **Select a kernel by input channel count.** `Transform.kernels[inputChannels]`.
2. **Initialise it** — offer it the LUT decision, then the built pipeline.
3. **Hand it work.** *Here is a colour, or here is an array. You work it out.*

Nothing else. Not which variant runs, not whether a batch is big enough to be
worth a WASM call, not how a fallback ladder degrades. **Batch size is not
Transform's concern** — a kernel that has a fast path for large arrays and a
different one for small holds both and picks, and Transform never learns a
choice was made.

That last point is where several earlier drafts leaked. Returning
`{big, small, threshold}` for the caller to compare still tells the caller
there is a threshold. There is not, as far as it is concerned: there is a
function that converts an array.

### Everything Transform offers a kernel is optional

This turns out to be the shape of the whole contract, and it is worth stating
once rather than rediscovering per feature. A kernel's obligations are small —
answer `floatFor`, answer `array`, clean up after itself. Everything else
Transform provides is a **convenience with an escape hatch**:

| Transform offers | a kernel that wants something else |
|---|---|
| `hints` — the caller's interpolation preferences | ignores them; it is the authority on its own dimension |
| `{big, small, threshold}` — the two-tier dispatch shape | returns its own dispatcher in both slots and routes however it likes |
| the LUT the builder baked | supplies its own through `wantsLut`, in whatever representation suits it |
| `opts.helpers` — the resolver, key format, gates | never touches them and writes its own dispatch |

None of these is a requirement, and **nothing degrades if a kernel declines
one**. That is the property to preserve when adding to this contract: if a new
member cannot be ignored, it is an obligation rather than an offer, and it
needs a much better reason than convenience.

---

## What we found

The v1.5 kernel migration landed in three phases, each individually correct
and each gated on measured throughput parity. Phase A created descriptors
"delegating to the tuned loops". Phase B moved 3,250 lines of loop source into
the kernel folders and re-attached them to `Transform.prototype`. Phase C moved
dispatch state onto the kernel instance.

Files moved. Data moved. **Ownership never did.**

The result is visible in [Kernel3D.js](../../src/kernels/3d/Kernel3D.js): 56
lines, five members, every one a single delegation back out —
`wasmLifecycle.settleWasmStates(this.transform)`,
`kernelUtils.resolveTableRuns(this)`, `kernelUtils.runTableKernel(this, …)`.
It owns a `supports` block and nothing else.

Three findings pushed this redesign:

**1. There is a behavioural hole, not just an aesthetic one.**
`registerKernel()` replaces the batch path only. A third-party Kernel3D changes
what `transformArray()` produces while `transform(colour)` keeps running
Transform's own tetrahedral code — so single-colour and batch can disagree for
the same Transform, and a kernel author has no way to fix it.

**2. The coupling that justified prototype attachment barely exists.**
[kernel3D_loops.js](../../src/kernels/3d/kernel3D_loops.js) uses `this` exactly
once, at line 418, to call a sibling. [interp.js](../../src/interp.js) — 3,155
lines, 16 interpolators — uses `this` at four call sites, all sibling
interpolators. Nothing reads Transform instance state. These are already pure
functions of `(input, lut)`; the prototype is a namespace, not a receiver.

**3. Transform already treats the interp stage as an opaque triple.**
`optimisePipeline()` fuses `stage_Int_to_Device` into the following interp
stage by matching on **stage name**, rewriting **stageData**
(`lut.inputScale = 1 / intValue`), and passing `stage.funct` through without
ever inspecting it. The only identity comparisons on any `stage.funct` in the
codebase are `stage_debug` and `stage_history`.

So the pipeline already manipulates these stages as *(name, opaque function,
lut)*. The one remaining thing Transform does with the function is **choose**
it — and that choice is derivable from the LUT plus a few policy options.

---

## The registry — 1 to 15, dense

`Transform.kernels` becomes an array indexed by input channel count, covering
the entire ICC range: 1–15 (`FCLR` is 15 channels, see
[Profile.js:1180](../../src/Profile.js:1180)). There is no `'nd'` key and no
`inputChannels > 4` branch.

```js
Transform.kernels[1]  = Kernel1D;
Transform.kernels[2]  = Kernel2D;
Transform.kernels[3]  = Kernel3D;
Transform.kernels[4]  = Kernel4D;
Transform.kernels[5]  = KernelND;   // slots 5-15 hold the SAME descriptor
Transform.kernels[6]  = KernelND;   // object today — one implementation,
// ...                              // eleven independently replaceable slots
Transform.kernels[15] = KernelND;
```

**Why eleven slots instead of one shared key.** Registering the same object
eleven times costs nothing and buys the ability to replace *one* dimension
without forking the rest. Someone with a real 7-channel workload can register
a tuned Kernel7D and leave 5, 6, 8–15 on the generic implementation. A test can
inject a probe kernel at dimension 9 and assert dispatch without touching any
path a real conversion uses. Neither is possible while 5–15 share one key.

**It does not add hidden classes.** Slots 5–15 point at one descriptor object,
so `Object.create(descriptor)` produces one shape for all of them — the
`kernel.array(...)` call site still sees five shapes, exactly as today.
Patching a single slot with a distinct descriptor adds one shape, bounded by
15 and in practice never more than one or two per process.

`setKernel` simplifies with it:

```js
// today — builds a string and hashes it, on every create()
var key = inChannels > 4 ? 'nd' : inChannels + 'd';
var descriptor = Transform.kernels[key];

// after
var descriptor = Transform.kernels[inChannels];
```

`registerKernel(descriptor)` validates `dimensions` as 1–15, or accepts a
`[from, to]` range so `KernelND` registers its eleven slots in one call.

---

## The descriptor API

| Member | Required | Purpose |
|---|---|---|
| `dimensions` | yes | 1–15, or `[from, to]` for a range |
| `name` | yes | stable identity; re-registering the same name replaces in place |
| `supports` | no | declarative variant capability map — diagnostics only |
| **`floatFor(lut, hints)`** | **yes** | **NEW** — returns `{funct, stageName}` for a single-colour pipeline stage |
| **`arrayFn(in, out, px, inAlpha, outAlpha, preserve)`** | yes | **TARGET** — converts an array. Any variant choice, including batch size, happens inside. See [arrayFn](#arrayfn) |
| **`wantsLut(pipeline, opts)`** | no | **NEW** — replaces `provideLut` + `displacesLut` |
| **`init(pipeline, opts)`** | no | **NEW** — replaces `claims`; returns `{pipeline, kernel}` |
| `create(lutMode)` | yes | settle WASM state, demote lutMode if the host can't run the request; returns the settled mode |
| ~~`resolveRuns()`~~ | — | **TO BE REMOVED** — see [why it exists](#resolveruns) |
| `array(in, out, px, lut, inAlpha, outAlpha, preserve)` | yes | image batch — owns output allocation/validation and dispatch |
| `release()` | yes | free WASM state |
| `emitKernel(opts)` | no | reserved for `compile()` integration — see [CompiledPipeline.md](./CompiledPipeline.md) |

---

## `floatFor(lut, hints)` — the kernel decides, the caller hints

Today [`addStageLUT`](../../src/Transform.js:7678) is a ~120-line switch, called
from 11 sites, that picks a single-colour interpolator. It reads exactly four
things:

| input | whose knowledge |
|---|---|
| `lut.inputChannels` | the registry key — *is* the kernel selector |
| `lut.outputChannels` → `_3Ch` / `_4Ch` / `_NCh` | **kernel-internal** — nobody else needs to know a kernel's variants |
| `interpolation3D` / `interpolation4D` / `interpolationFast` | Transform policy, public API |
| `inputEncoding` + `useTrilinearFor3ChInput` | Transform policy — and **3D-only** |

The switch's top level (`case 1 / 2 / 3 / 4 / default`) is a hand-maintained
copy of the registry keys. The PCS→trilinear override appears **only** in
`case 3`; `case 4` has no equivalent. That asymmetry is the clearest single
sign that this is dimensional knowledge living in the wrong file.

It collapses to:

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

`hints` is advisory. The kernel resolves the actual function and **is the
authority** on what interpolation its dimension uses — trilinear for 3D PCS
input, tetrahedral for 4D, bilinear for 2D. A kernel is free to ignore a hint
it has no variant for.

It is **not** free to ignore a hint silently. Today an unrecognised
`interpolation3D` throws `'Unknown 3D interpolation method "…"'`. That throw
moves inside the kernel; a typo in a public option must not degrade into a
default.

`interpolationFast: false` comes along as a kernel-internal choice — a kernel
may offer a slow reference variant (today's `_3or4Ch` functions) without
Transform knowing it exists. That is a decent test of whether the boundary is
in the right place.

### Statelessness is what makes this work

The float surface needs no WASM handle, no `transform` back-reference, no
per-instance state. So the stage binds the **descriptor**, not an instance:

- `this.kernel` keeps meaning exactly what it means today — the *batch* kernel,
  chosen by the Transform's input channel count
- a CMYK→RGB Transform binds its 4D A2B stage to `Transform.kernels[4]` and its
  3D B2A stage to `Transform.kernels[3]`
- no second instance, no second lifecycle, one hidden class per dimension
  shared across every Transform

The kernel controls the whole of its dimension without owning the Transform.

### It may return a WASM function

Nothing in the contract says `funct` must be JS. A kernel may return a WASM
entry point provided it is bit-compatible with the JS variant. Per call this is
a poor trade — the boundary crossing costs more than three floats of work,
which is why `WASM_DISPATCH_MIN_PIXELS` exists at all.

There is one consumer where it is not a per-call decision: **`createLut()`
bakes the grid by walking the pipeline once per grid point** — 33³ ≈ 36,000
single-colour calls, identical shape every time, on the `create()` critical
path. That is a batch wearing a per-pixel coat. The option costs nothing to
leave open and that is where it would first pay.

---

## The two-phase LUT contract

`optimisePipeline()` runs at [Transform.js:5005](../../src/Transform.js:5005),
inside `createPipeline()`. That is **before** `pipelineCreated = true`
([2057](../../src/Transform.js:2057)) and before the claim pass
([2113](../../src/Transform.js:2113)). The optimiser writes into the shared LUT
as it fuses:

```js
lut.inputScale  = 1 / intValue;        // stage_Int_to_Device folded in
lut.outputScale = lut.outputScale * intValue;
```

So a stage is bound *before* its LUT's scales are final. That is a footgun
unless it is named, and naming it gives us a clean phase boundary:

| hook | when | `inputScale` / `outputScale` | may precompute from the LUT? |
|---|---|---|---|
| `floatFor(lut, hints)` | stage bind, **pre**-optimise | not final | **no** — read scales at call time |
| `init(pipeline, opts)` | **post**-optimise | final | yes |

Today's interpolators already comply — 249 scale reads in `interp.js`, all off
the `lut` argument at call time. A kernel author caching `1/inputScale` in
`floatFor` would produce quietly wrong output on any pipeline the optimiser
touched, which is exactly the class of bug a written contract prevents.

---

## `wantsLut()` and `init()` — two hooks, one object

The shipped design has three hooks (`provideLut`, `displacesLut`, `claims`) and
two registries (`Transform.kernels`, `Transform.claimKernels`). This has two
hooks and one registry.

### Why it cannot be one hook

`displacesLut` runs against the **temporary device-to-device pipeline** the LUT
builder constructs before walking the grid. Its entire purpose is to decide
whether a 214 KB table gets built at all. A post-pipeline hook is far too late
— by then the table exists and the cost is paid.

`provideLut` and `displacesLut` are the same question asked either side of a
build, so they merge:

```js
// Before the CLUT grid walk, against the temporary device-to-device pipeline.
// Returns: {lut}  — use this one, don't build
//          false  — build no LUT; the pipeline path is the fast path here
//          null   — build normally
kernels[n].wantsLut(tempPipeline, opts)
```

`init` runs where `_claimKernel()` runs today — after `optimisePipeline()`,
after `pipelineCreated`:

```js
// Post-optimise. The kernel may rewrite the pipeline and may hand back a
// different kernel to run the batch path.
var r = Transform.kernels[this.inputChannels].init(this.pipeline, opts);
this.pipeline = r.pipeline;
if(r.kernel) this.kernel = r.kernel;
```

### The kernel may also choose the LUT's *representation*

`wantsLut` is not only a yes/no about building a table. A kernel may decide
what the table should *be* — for example baking a u16 CLUT for its own
interpolators and running float → u16 → float, where the win is not integer
arithmetic but the size of the table. The shipping CLUT is a **`Float64Array`**
([Transform.js:3627](../../src/Transform.js:3627)). A 33³ grid with 4 output
channels is 143,748 cells — **1.10 MB at f64, 575 KB at f32, 287 KB at u16** —
and a grid walk is cache-bound, so the cell type is a throughput decision as
much as a memory one.

**This pattern already exists and is already formalised** — it just belongs to
Transform instead of the kernel. `buildIntLut()` produces `lut.intLut`, a
tagged sidecar carrying `{version, dataType, scale, gpsPrecisionBits,
accWidth}`, and `isIntLutCompatible()` exists specifically to reject a foreign
one from a serialised pipeline or a cross-version cache. The generalisation is
to let a kernel own that view rather than have one Transform-wide integer
mirror chosen by `lutMode`.

**It must be additive, never a replacement.** The float CLUT stays canonical:
`getLut()` is public API for serialising to JSON and shipping to a worker, the
pool posts `{lut, lutMode}` across the worker boundary, and
[Luts.md](./Luts.md) documents the portable JSON format. A `wantsLut` that
returned a u16-only LUT would break all three. The kernel's representation is a
sidecar it owns, tags, and can rebuild from the float CLUT at any time —
which also means a worker can rebuild it locally instead of receiving it, for a
smaller `postMessage`.

**One hazard, and it is about honesty rather than mechanism.** The obvious hint
to hang this on is `interpolationFast`, and that would be wrong.
`interpolationFast` is accuracy-neutral today: the fast `_3Ch`/`_4Ch`/`_NCh`
variants "should produce numerically identical results to the reference
variants — the LCMS test suite verifies this"
([interp.js:81](../../src/interp.js:81)). Overloading it to authorise a lossy
representation turns a free flag into one that silently costs LSBs, in an
engine whose positioning is sub-LSB agreement with Little CMS on 130 of 150
files. A representation change needs either its own hint or an explicit
accuracy budget the kernel declares and `kernelInfo()` reports.

The direction is already measured on the batch path — the integer lutModes beat
the float CLUT, which is the entire reason they exist. On the single-colour
path it is unmeasured; `pixelCache.accuracyPath.*` in
[BenchResults](../BenchResults.md) is where that number would go.

### Mutation gets a guardrail that already ships

If `init` returns a changed pipeline, Transform re-runs `optimisePipeline()`
(it loops `while(Opt)` to a fixpoint — idempotent, create-time only) and then
`validatePipeline()`, which pushes a mid-grey colour through and fails on NaN,
`undefined`, or a wrong output type. Both already exist. A mutator hook
inherits a safety net rather than needing a new one.

Encoding continuity is the thing a careless splice breaks — every stage has an
`inputEncoding` / `outputEncoding` that must chain. `validatePipeline()` catches
the resulting garbage; the contract should say to check it rather than rely on
that.

### A hook that throws is a decline

Unchanged from today, and it matters more now that a hook can mutate: a kernel
is registered third-party code running inside `create()`. Declining is always
an available answer, so an exception must never take the Transform down. On a
throw, the pre-hook pipeline stands.

---

## The sub-registry — where matrix-shaper goes

Under "one kernel per input dimension", `Transform.claimKernels` cannot survive
at the Transform level. It should not simply be deleted either: it is an ordered
list, and two independent 3-channel accelerators can coexist in it today. Under a
single dimensional owner, adding one would mean replacing `Transform.kernels[3]`
wholesale, and two vendors would collide.

**The list moves inside the dimension that owns it.** Kernel3D hosts its own
ordered list of 3-channel claiming kernels and asks them in `init()`.
Matrix-shaper registers with Kernel3D, not with Transform.

Terminology note: these are **claiming kernels**, the name the codebase already
uses — `claims()`, `claimed`, `_kernelClaim`. An earlier draft of this section
called them "strategies", which was a synonym for something that already had a
name and left the code holding a list called `strategies` full of things
implementing `claims()`. One concept, one word. The invariant holds at the
Transform level; composability survives where the domain knowledge is.

This pays immediately. `KernelMatrixShaper.claims()` currently opens by
reaching into Transform internals:

```js
if(transform.wasmMatrixShaper === 'off') { /* ... */ }
if(transform._pixelCacheData !== null && transform._pixelCacheData !== undefined) { /* ... */ }
```

A kernel reading `_pixelCacheData` is the boundary leaking. When Kernel3D owns
the decision it passes those in as part of the offer, and matrix-shaper stops
needing to know Transform exists.

**One consequence to plan for.** After `init`, `this.kernel` may not be
`Transform.kernels[inputChannels]`. The invariant is *"one kernel **owns** each
dimension"*, not *"one kernel **runs** it"*. `kernelInfo()` should report the
chain — `kernel3D → matrix-shaper` — rather than only the endpoint.

---

## The shape test — what a stranger can do without touching Transform

The point of the boundary is not the three hooks. It is that a kernel becomes
an isolated unit with its own control, so things nobody designed for become
possible without a core change. That is the criterion this design should be
judged against, and it is falsifiable: **name something a third party would
want, and check what Transform has to learn.**

| Someone wants… | built as | what Transform must know |
|---|---|---|
| An f32 CLUT — half the memory, better cache behaviour, one ULP of loss | a Kernel3D variant whose `wantsLut` returns an f32-celled table and whose `floatFor` reads it | nothing |
| RGB → sepiatone, or any house look baked as a table | a kernel whose `wantsLut` returns a LUT that was never derived from the profile pair | nothing |
| A fast-preview mode on a small 8-bit grid | a kernel that returns a 9³ or 17³ u8 table when a preview option is set | nothing |
| A tuned 7-channel press kernel, leaving 5, 6, 8–15 generic | `Transform.kernels[7] = Kernel7D` | nothing |
| A probe that records every dispatch, for a test | `Transform.kernels[9] = probe` | nothing |
| A JS → WASM → GPU kernel: three tiers, two thresholds orders of magnitude apart, and a decision that depends on device availability | the kernel's own `arrayFn`, dispatching over three tiers internally | nothing — though a GPU tier raises an async question for the *public API*, see [arrayFn](#arrayfn) |

Every row is a kernel decision expressed through hooks that already exist in
this document. None of them is a case in a switch in `Transform.js`, which is
where all five would have to live today.

Two of those deserve a note. **A LUT that is not derived from the profile pair**
still satisfies everything Transform checks — `validatePipeline()` pushes a
mid-grey through and looks for NaN, `undefined` and wrong output types, and a
sepiatone table passes. The stage's `inputEncoding` / `outputEncoding` still
chain, because the table replaced one of the same shape. Nothing about "this
LUT means profile A → profile B" was ever load-bearing. **A smaller grid** is
already half-expressible: `lutGridPoints3D` (33) and `lutGridPoints4D` (17) are
public options today — but Transform-wide, one number, and with no say over the
cell type. What is new is a kernel choosing both, for itself.

### The red kernel

The limit case: a kernel whose `init` throws the pipeline away and returns a
one-stage pipeline that returns red.

```js
init: function(pipeline, opts){
    if(opts.onlyRed) return {pipeline: redPipeline};
    return {pipeline: pipeline};
}
```

Transform re-optimises it, validates it — a mid-grey test colour comes back red,
which is not NaN, not `undefined`, and the right output type, so it passes —
and then runs it. It never learns that anything unusual happened. **That is the
goal, not a defect.** The test of an ownership boundary is whether the owner can
be absurd without the host noticing; if Transform had to understand red, it
would not own only the pipeline.

**And the experiment finds a hole worth closing.** A red pipeline with the
built CLUT still attached would make `transform(colour)` return red while
`transformArray()` returns whatever the LUT says, because the batch path routes
through `transformArrayViaLUT` whenever a LUT exists. That is the same
single-colour/batch divergence this whole design set out to close, re-entering
through the mutator hook.

So the contract needs one more line: **`init` owns both surfaces or neither.**
If it rewrites the pipeline it must also settle the batch path — hand back a
kernel whose `array()` agrees, or clear the LUT so batch walks the same
pipeline it just installed. For the red kernel, clearing the LUT is both the
cheapest answer and the correct one.

### Wrapping rather than replacing

The right idiom for a kernel that only wants to intercept sometimes is to
inherit and delegate, not to reimplement:

```js
var RedKernel = Object.create(Transform.kernels[3]);
RedKernel.name = 'kernel3D-red';        // do not skip this — see below
RedKernel.init = function(pipeline, opts){
    if(opts.onlyRed) return {pipeline: redPipeline, lut: null};
    return Transform.kernels[3].init.call(this, pipeline, opts);
};
Transform.kernels[3] = RedKernel;
```

Every hook the wrapper does not override keeps working, and keeps picking up
later fixes to the base kernel. Two practical notes:

- **Override `name`.** `setKernel` already does `Object.create(descriptor)` per
  Transform, so a wrapper makes the instance a two-level chain — harmless for
  correctness and one extra link on a lookup that resolves once per create. But
  a wrapper that inherits `name` reports as `kernel3D` in `kernelInfo()`, and an
  invisible override is a bad thing to debug.
- **`supports` is inherited too**, and will claim capabilities the wrapper may
  not honour. It is diagnostics-only, so the stakes are low, but a wrapper that
  narrows behaviour should narrow `supports` with it.

### How a custom option reaches a kernel

Options are merged with a blanket copy
([Transform.js:600](../../src/Transform.js:600)), so an unrecognised key is
carried rather than rejected: `{kernel3D_32f: true}` would in fact reach a
kernel today with no Transform change at all.

Prefer a named bag anyway:

```js
new Transform({
    kernelOptions: { 'kernel3D': { f32: true, preview: false } }
});
```

Keyed by **kernel name**, not by dimension — the name is the stable identity,
and a dimension slot can be re-registered by someone else. Passed opaquely into
`floatFor(lut, hints)`, `wantsLut(pipeline, opts)` and `init(pipeline, opts)`.

Three reasons over a flat prefixed key:

- **Transform never validates it, and never has to.** A flat namespace forces a
  choice between rejecting unknown top-level options (which would break the
  blanket copy that everything relies on) and never being able to catch a typo
  in a core option.
- **A typo inside the bag is the kernel's to catch**, and it can, because it
  owns the schema. That is the same split as `hints`: the caller asks, the
  kernel decides, and an unrecognised request is an error the kernel raises
  rather than a default it silently falls back to.
- **It survives re-registration.** A kernel that moves slots, or a test kernel
  parked at dimension 9, still finds its own options.

---

## Call sequence

```
create()
  ├─ setKernel(inputChannels)            → Transform.kernels[n], one array index
  ├─ kernels[n].wantsLut(tempPipeline)   → {lut} | false | null
  ├─ [CLUT build, if any]
  ├─ createPipeline(...)
  │    ├─ addStageLUT → kernels[lut.inputChannels].floatFor(lut, hints)
  │    │                 ↑ scales NOT final here
  │    └─ optimisePipeline()             → folds scales into the LUT
  ├─ pipelineCreated = true
  ├─ kernel.create(lutMode)              → WASM settle + lutMode demotion
  ├─ {pipeline, kernel} = kernels[n].init(pipeline, opts)
  │    └─ if mutated: optimisePipeline() + validatePipeline()
  ├─ _expectsU16 / _isIntegerMode        ← cached from the settled lutMode
  └─ _resolveLutKernels()                → kernel.resolveRuns()
```

---

## What stays in Transform, and why

Each of these has a reason. A bullet without one is how the last boundary
drifted.

- **Pipeline construction, optimisation and validation.** This is the whole of
  what Transform is for.
- **The policy options** — `interpolation3D`, `interpolation4D`,
  `interpolationFast`, `useTrilinearFor3ChInput`. Public API, documented,
  user-settable. They are passed *into* kernels as hints; kernels must never
  read `transform.*` for them, or the coupling grows straight back.
- **`lutMode` settling and demotion**, `_expectsU16`, `_isIntegerMode`. The
  settled mode is public (`t.lutMode`) and fixes the output container type
  across the whole Transform. `create(lutMode)` returning the settled mode is
  already the right shape.
- **`transformArrayViaLUT()`** — the public choke point, 52 test call sites plus
  user code. Preamble plus `kernel.array(...)`.
- **The WASM memory management API** — `setWasmShrinkRatio`, `setWasmMaxMemory`,
  `compactWasmMemory`, `releaseWasmMemory`, `wasmMemoryBytes`. Public API.
- **The no-LUT dimension-generic pipeline walk.** Duplicating it in fifteen
  kernels is copy-paste risk for no gain.

---

## Invariants that break silently

These are the ways to get this wrong without a test failing.

**1. Stage names are the coupling surface.** `compile()` resolves emitters by
string — `emit_js_<stageName>` at
[Transform.js:8373](../../src/Transform.js:8373) — and `optimisePipeline()`
matches its fusion patterns against a list of six literal names at
[5044](../../src/Transform.js:5044). `floatFor` must return the stage name
alongside the function, and the six names must stay byte-stable. Change one and
fusion quietly stops firing; throughput drops and every test still passes.

**2. Never precompute from the LUT in `floatFor`.** See the two-phase table
above.

**3. The float family and the array family must never share bodies.** From
[Transform.js:7655](../../src/Transform.js:7655): sharing inner code between the
single-colour path and the array loop **poisons the JIT** — same function, two
ABIs and two array shapes, V8 deoptimises and the array path slows 2–3×. Once
`float` and `array` are members of one object, "these are both tetrahedral 3D,
why two implementations?" becomes the obvious next thought. It is a 2–3× trap
and it belongs in the descriptor's own comments, not only in Transform.js.

**4. Mutating the pipeline requires re-optimise plus re-validate.** See above.

**5. `init` owns both surfaces or neither.** Rewriting the pipeline without
settling the batch path re-opens the single-colour/batch divergence this design
exists to close — `transformArrayViaLUT` runs whenever a LUT is attached,
whatever the pipeline now says. Return a kernel whose `array()` agrees, or clear
the LUT. See [The red kernel](#the-red-kernel).

**6. Both WASM families load on every create today, and a test asserts it.**
[transform_lutMode_wasm_4d.tests.js:97](../../__tests__/transform_lutMode_wasm_4d.tests.js:97)
— *"create(): both wasmTetra3D and wasmTetra4D populated (no silent
demotion)"*. Its purpose is to prove WASM actually ran rather than falling back
to `'int'` (see [WasmKernels.md](./WasmKernels.md)). Per-dimension loading is a
real win — a CMYK Transform compiles four 3D modules it never calls — but the
test's *intent* must be re-expressed against a host-capability probe, not
deleted. "Can this host do WASM/SIMD?" is a property of the host, cached once
per process; it is not a property of a Transform.

---

## What this makes testable

This is half the point of the change.

- **Inject a probe kernel at any dimension.** `Transform.kernels[9] = probe` and
  assert what got called, with no effect on dimensions a real conversion uses.
- **Assert single-colour and batch agree.** Currently unprovable for a
  third-party kernel, because `transform(colour)` does not go through it. Once
  one object owns both surfaces, "the same kernel produced both" is a test you
  can write.
- **Assert the hint contract.** An unknown `interpolation3D` throws; a known one
  is honoured; `interpolationFast: false` selects the reference variant.
- **Assert the phase boundary.** Bind a stage, run the optimiser, check the
  kernel's output still tracks the rewritten `inputScale`.
- **Assert the WASM loadout per dimension**, once loading is per-dimension.
- **Assert `kernelInfo()` reports the chain** after an `init` reassignment.

---

## Migration

Every step gated on: full test suite green, both bundles building, and MPx/s
parity from `node bench/reproduce.js` against the previous run. This is the
first kernel work with a bench harness that can prove neutrality on demand
rather than by comparison across vintages — v1.6 is already scheduled for a
full benchmark rebuild, so each phase gets a before/after from one harness.

The gate is a **pinned baseline**, not the previous run:

```bash
node bench/reproduce.js
node scripts/bench_compare.js          # newest run vs bench/baseline/<machine>/
```

Comparing each phase against whatever ran last is a ratchet that only turns one
way — seven phases at 1.5% each is 11% slower with every step passing. The pin
is a committed run that moves only deliberately (`bench/baseline/README.md`).
It is filed per machine, because a Ryzen pin is not a control for an M2; the
comparison picks the pin matching the machine it is running on and refuses
rather than reporting a different CPU as a regression.

`bench_compare` sorts columns three ways: jsCE throughput **gates**, third-party
`lcmsWasm`/`native` columns are the **control** that sets the noise floor, and
accuracy (`*MaxLsb`, `*MeanLsb`) is gated at **zero** — a refactor that quietly
changes rounding is the failure worth catching, and it never shows up as a
throughput number.

**Small batches do not gate.** Cells below 256k px are reported and never fail
a comparison. `js.sweep.rgb-rgb-matrix.64k / noise / jsceInt` was measured four
times around phase 1 — 53.9 before, then 47.5, 53.9, 56.5 after — a 17% spread
with the "before" value sitting in the middle of the "after" range. Small
batches are dominated by per-call overhead and GC rather than the kernel loop
and they measure like it. The published tables use 1M px; the small sizes exist
to show the shape of the size curve, which is worth seeing and not worth failing
a build over.

**Run one bench at a time.** Two concurrent runs on the same box produce control
columns down ~3% and individual cells down 16%, which reads exactly like a
regression. `bench_compare`'s control columns catch it — the noise floor jumps
from 7% to 15% — but the run is still wasted. The tool can tell you a
measurement is untrustworthy; it cannot make it trustworthy.

**Gate on the `solo` phase, not the content matrix.** Phase 1 measured both.
`solo` runs one image, one engine, one process per measurement and reported
0.2–1.0% internal spread; across 6 engine/workflow cells it moved by at most
0.42%, which is inside each cell's own spread. The `js` content matrix, over
the same code, showed individual cells moving up to 12% — but the movement
lands on the `lcmsWasm` and `lcmsWasmNoCache` columns just as hard, and those
are Little CMS running in WASM, which a jsCE refactor cannot touch. Its mean
across 324 cells was +0.32%. **Per-cell variance in the content matrix is too
large to gate a refactor on; the isolated measurement is the one that answers
the question.** This is the same lesson as
[LcmsComparison.md](../LcmsComparison.md)'s "quote the MPx/s rather than the
speedup", one level down: quote the measurement that controls its conditions.

| Phase | Content | Why here |
|---|---|---|
| ~~1~~ | ~~Dense 1–15 registry; `setKernel` becomes an array index; `registerKernel` accepts a range~~ **LANDED 2026-08-21** — descriptors gained `name`, `KernelND` registers `[5, 15]`, `MAX_KERNEL_DIMENSIONS = 15`. New suite `__tests__/kernel_registry.tests.js` (17 tests) | Mechanical, no behaviour change, unblocks test injection |
| ~~2~~ | ~~`floatFor` on Kernel1D and Kernel2D; `addStageLUT` cases 1 and 2 become registry lookups~~ **LANDED 2026-08-21**, and it closed `TODO (B3)` with it — see [Phase 2 as built](#phase-2-as-built) | No WASM in the way. Ownership change plus a real throughput win, with a number to show before touching 3D/4D |
| ~~3~~ | ~~`floatFor` on KernelND, then Kernel3D, then Kernel4D~~ **LANDED 2026-08-21** — `addStageLUT` went from 133 lines to 34. See [Phase 3 as built](#phase-3-as-built) | Ascending risk. 3D and 4D one at a time |
| ~~4~~ | ~~Loops and WASM state move onto the kernel; the 22 `run_` adapters in `lutKernelTable.js` follow the loops they call~~ **LANDED 2026-08-21** across 4/4b/4c/4d | ~~They exist only to rename `t.method`~~ **Corrected**: they are the family boundary that keeps float and int bodies from sharing a call site and poisoning the JIT |
| ~~4e~~ | ~~`arrayFor()` returns `{big, small, threshold}`~~ **LANDED 2026-08-21, AND SUPERSEDED** — the shared `WASM_DISPATCH_MIN_PIXELS` retired into `dispatchThreshold.js`, but returning a threshold to the caller still made batch size Transform's business. Replaced by [`arrayFn`](#arrayfn) in phase 8 | After the loops move, this is the last thing Transform knows about dispatch |
| ~~5~~ | ~~`init()` + sub-registry; matrix-shaper moves inside Kernel3D; `claims`/`claimKernels` retire~~ **LANDED 2026-08-21** — no claim registry at all in the end: Kernel3D reads the pipeline and yields to the matrix shaper itself, and Transform never learns a choice was made. The 42-row dispatch table became a `resolve()` switch in each kernel file, verified against a 560-decision oracle; the u16 wide-output gap it hid (CMYK→5CLR threw at 16 bits) is fixed | Needs 3 and 4 landed first |
| 6 | `wantsLut()` merges `provideLut` + `displacesLut` | Smallest surface, last |
| 7 | Per-dimension WASM loading behind a cached host probe | Independent of the rest; re-express the loadout test first |
| **8** | **`arrayFn` replaces `arrayFor`; `resolveRuns`, `_resolveLutKernels` and `_bindLutTransformArrayFn` retire; `init()` decides everything and `create()` stores it on the instance** | The half-steps left Transform holding a threshold, sequencing a resolve, and knowing there is a BIG and a SMALL. None of that is its business. See [What Transform actually does](#the-principle) |

---

<a id="phase-2-as-built"></a>

## Phase 2 as built

Kernel1D and Kernel2D own their single-colour function and their array loop.
`addStageLUT` cases 1 and 2 are registry lookups; `linearInterp1D_NCh` and
`bilinearInterp2D_NCh` moved out of `src/interp.js` into the kernel modules.

**The ownership change and `TODO (B3)` turned out to be one change seen from
either end.** B3 said the 1-D and 2-D array loops should be inlined like the
3-D ones. The contract said the float and array families must never share
bodies. Those are the same statement: the loops shared a body *because* nobody
owned the pair, and giving the kernel both surfaces is what made the
duplication deliberate rather than accidental.

Measured, 1M px, float lutMode, best of 5, three consecutive runs agreeing to
0.3%:

| workflow | before | after | change |
|---|---:|---:|---:|
| gray → RGB | 72.6 | **93.8** | +29% |
| gray → CMYK | 63.6 | **81.4** | +28% |
| gray → 6CLR | 49.7 | **64.9** | +31% |
| duotone → RGB | 50.7 | **61.5** | +21% |
| duotone → CMYK | 44.7 | **51.3** | +15% |
| duotone → 6CLR | 35.7 | **41.0** | +15% |

Gray gains more than duotone because bilinear does four CLUT reads and more
arithmetic per output channel, so the per-pixel allocation was a smaller share
of its total.

**A third, not a multiple, and the reason is worth keeping.** The prediction
before measuring was larger — ~2M allocations per megapixel sounds
catastrophic. It is not, because V8 allocates short-lived small objects by
bumping a pointer in the nursery and collects them almost free when they die
immediately, which these did. The allocation was real cost but never the
dominant one. Estimating allocation pressure from the allocation *count* rather
than from its lifetime overstates it.

Correctness was checked by comparing the loop against the kernel's own
`floatFor` function across 159,744 values and 9 LUT shapes per dimension —
through the same `Uint8ClampedArray` container, because it rounds half-to-even
where `Math.round` rounds half-up, and comparing through different rounding
shows a 1 LSB "failure" that is not one.

The isolated `solo` bench moved at most **+0.30%** across six 3D/4D cells,
confirming the kernels this phase did not touch were also not disturbed.

<a id="phase-3-as-built"></a>

## Phase 3 as built

`addStageLUT` went from **133 lines to 34**. All the selection logic — by
`lut.inputChannels`, then `interpolation3D`/`interpolation4D`, then
`interpolationFast`, then `lut.outputChannels` — is now inside the kernels that
own those dimensions. What is left is a registry lookup and a hints object.

`src/interp.js` becomes the built-in float *implementations*; the kernels are
the *policy*. A third-party kernel can ignore the file entirely.

### Proving a pure refactor is pure

The risk here was not that tests would fail. It was that a subtly different
interpolator would be installed for some combination nobody tests directly, and
everything would still pass while the numbers quietly moved.

So `HEAD` was extracted to a scratch tree and the same probe run against both
copies — stage names **and** accuracy-path colour output, for RGB→RGB, RGB→Lab,
RGB→CMYK, CMYK→RGB, CMYK→CMYK and CMYK→Lab, each also with
`interpolationFast:false`, `interpolation3D:'trilinear'`,
`interpolation4D:'trilinear'`, `useTrilinearFor3ChInput:false` and
`buildLut:true`. **Byte-identical across all fifteen cases.** That comparison
was worth more than any number of new assertions, and it is cheap: `git archive
HEAD | tar -x -C <scratch>` and run the same script twice.

It also settled something that looked like a regression. A typo in
`interpolation3D` does **not** throw for a PCS-input LUT, because the trilinear
override resolves the method before the bad value is ever examined. The probe
showed the old switch did exactly the same thing. With device input, it throws.
Without the side-by-side, that would have been a plausible-looking bug to chase
or, worse, to "fix".

### The rule that proves the boundary was wrong

The PCS-input trilinear override existed **only** in the 3-channel branch —
lcms 2.0 moved to tetrahedral and found it disagreed with 1.19, SampleICC and
Photoshop on Lab-indexed LUTs, because L sits on one axis and the space is
uncentred. The 4-D branch had no equivalent.

One function was carrying one dimension's rule for all dimensions. It now lives
in Kernel3D, and **its absence from Kernel4D is the point.**

### A fragility worth knowing about

`src/interp.js` is still attached to `Transform.prototype`, and that is
load-bearing rather than vestigial. The 4-D reference variants evaluate two 3-D
interpolations at the bracketing K planes and reach their siblings through
`this`:

```js
var output1 = this.tetrahedralInterp3D_Master(cmyInput, lut, K0);
```

Stages are invoked as `stage.funct.call(transform, …)`, so `this` is the
Transform and the sibling resolves off the prototype. Calling
`interp.tetrahedralInterp4D_3or4Ch(…)` as a bare function throws. **Anything
that changes how stages are invoked must keep a receiver carrying these
methods** — which is a live constraint on phase 4, when the loops and WASM state
move onto the kernels.

### Measured

Throughput unchanged, as a create-time-only change should be: jsCE **median
+0.21%** across 132 cells, isolated `solo` bench **worst −0.61%**, accuracy
identical. Phase 2's gray and duotone gains held.

<a id="arrayfn"></a>

## `arrayFn` — one function, and the kernel keeps its own secrets

`floatFor` gives the kernel the single-colour path. `arrayFn` is the image
path, and it is deliberately the plainest possible thing:

```js
kernel.arrayFn(input, output, pixelCount, inAlpha, outAlpha, preserve)
```

Transform calls it. That is the entire interface.

### What this replaced, and why the earlier shapes were wrong

Three drafts of this exist in the history of this document, each less leaky
than the last:

1. **`kernel.array(...)` reaching back through `kernelUtils.runTableKernel`**,
   which consulted a resolver, compared a threshold and called a run closure —
   with the kernel's own state written onto it from outside.
2. **`arrayFor()` returning a bound function.** Better: the kernel answers once
   and the caller holds the result.
3. **`arrayFor()` returning `{big, small, threshold}`** so a caller could pick
   per call, or skip the compare when they collapse.

The third still leaks. Telling the caller there is a threshold makes the batch
size their business, and it is not — **why would Transform care how big the
array is?** A kernel with a WASM path above some pixel count and a JS path
below holds both and picks:

```js
// set up once, in create() / init()
this.arrayFnBig = …;
this.arrayFnSml = …;
this.threshold  = …;      // the kernel's own number, nobody else's

arrayFn: function(input, output, px, inAlpha, outAlpha, preserve){
    var fn = (px >= this.threshold) ? this.arrayFnBig : this.arrayFnSml;
    return fn(input, output, px, inAlpha, outAlpha, preserve);
}
```

One compare, once per image, inside the kernel that owns the reason for it. A
kernel with one implementation just assigns `arrayFn` directly and there is no
compare at all.

<a id="resolveruns"></a>

### And resolution happens in `init()`

There is no `resolveRuns()` in the target. `init()` already receives the built
pipeline and everything the kernel is allowed to know; whatever it decides —
which variant, which threshold, which tables — it decides there and stores on
itself.

**`resolveRuns()` was never part of the design.** It is worth being precise
about this, because the spec that documented it made it look deliberate. From
the v1.5 migration history:

> **C** — BIG/SMALL run refs onto the kernel instance
> (`_runBig`/`_runSmall`/`_threshold`), resolved by `kernel.resolveRuns()`;
> `_lutKernelBig`/`_lutKernelSmall`/`_lutKernelThreshold` removed from
> Transform

Phases A and B — the modular kernel work proper — have no `resolveRuns`. It
arrived in phase C purely as the vehicle for moving three fields off Transform,
and every revision of the spec was written after C, which is why it reads as a
required member of the contract rather than as the migration step it was.

It is a half-step by its own description: the *fields* moved to the kernel, but
Transform kept *sequencing* the resolve and *comparing* the threshold. It also
brought `_resolveLutKernels()` with it, which grew a second unrelated job and
ended up being called on the identity path, where there is no kernel at all.

**A doc that records what was built reads exactly like a doc that records what
was intended.** This one now says which it is.

### The resolution itself lives in the kernel file

Not in a table module beside it, and certainly not in a shared registry.
**Open `Kernel3D.js` and see how 3-D dispatch resolves** — a switch on the
lutMode, twenty readable lines, with the fallback ladder written as code
because that is what it is. The v1.3 table existed because Transform.js
dispatched for every dimension out of one flat structure and it had to be
data. Nothing dispatches that way any more.

## Helpers reach the kernel through `init`, not through an export

A third-party kernel already works with nothing but the public surface —
`Transform.registerKernel(descriptor)`, a `floatFor` and an `array` — and it
drives **both** paths, which is what phases 2 and 3 were for. Verified rather
than assumed: an independent Kernel3D returning its own maths shows up in
`kernelInfo()`, in `transform(colour)` and in `transformArray()` together.

What is *not* reachable is the dispatch machinery: the fallback resolver, the
key format, the gate predicates, the break-even constant. A kernel that wants
several variants — SIMD, scalar, JS, with eligibility gates and a degradation
ladder — currently has to write its own version of what
`src/lutKernelTable.js` already does.

**The answer is to hand them over at `init()`, not to export them.**

```js
init: function(pipeline, opts){
    this.helpers = opts.helpers;   // makeKey, resolveChain, gates, threshold
    return { pipeline: pipeline };
}
```

`init(pipeline, opts)` already takes an options bag, so this adds no new
surface. That matters more than it sounds:

- **Nothing new becomes public.** An exported `Transform.lutKernelTable` is a
  promise about a shape that is still moving — it changed twice today. Passing
  it in is dependency injection, and the contract is the `opts` shape, which is
  already versioned by this document.
- **A kernel that does not want them never sees them.** The built-ins reach
  their own tables directly; the helpers exist for strangers.
- **Drift is visible at the boundary.** If a helper changes, `opts` changes,
  and a kernel notices at `init()` — at create time, in one place — rather than
  through a deep import that silently resolves to something different.

### A kernel owning its output buffer — allowed, and usually wrong

Output allocation is the kernel's business, so nothing stops a kernel keeping
one buffer and returning it every call. For a fixed-size stream — frames off a
camera, tiles of a known size — that removes an allocation per image, and the
temptation is obvious.

It is still the wrong place for the decision, and the reason is the same one
that runs through this whole document: **the kernel cannot see the caller's
lifetime.** It does not know whether the result is consumed before the next
call or held. Return a reused buffer to someone who stashes it and the data
changes underneath them, with no error and no wrong-looking output until much
later.

`transformImages()` makes it concrete. Its documented pattern is an `onImage`
callback that writes each result out as it completes — safe, because the
callback consumes immediately. Anyone who instead pushes the buffer onto an
array ends up with N references to one buffer holding the last image.

**And the safe version already exists, on the side that has the knowledge.**
The caller passes its own buffer and gets it back:

```js
var mine = new Uint8ClampedArray(px * outCh);
t.transformArrayViaLUT(input, false, false, false, px, mine);   // returns mine
```

Same allocation saved, decided by the party that knows whether reuse is safe.
A kernel that wants this should want its *caller* to do it.

So: permitted, occasionally right behind an explicit option the caller sets,
never the default. It is the one case so far where the answer to "can a kernel
do this?" is yes but you probably should not, rather than yes and Transform
does not care.

### The built-ins should take them the same way

If the built-in kernels also receive helpers rather than requiring them, then
**Transform builds them once and every kernel gets them from one site.** That is
worth more than the symmetry: instrumentation, a recording resolver for a test,
or an alternate threshold become a change at that one site instead of edits
spread across however many modules did their own `require`.

It also keeps the built-ins honest. A contract where the built-in kernels take a
private path and third parties take a public one is a contract whose public path
nobody exercises.

**What stands in the way, concretely.** The per-kernel tables are module-level
constants: `kernel3D_table.js` reads the gates and the threshold at *load* time,
long before any `init()` exists to hand it anything. Taking helpers means the
tables become factories —

```js
module.exports = function makeTable(helpers){ return { 'fl_3_3': { … } }; };
```

— built once per kernel at `init` and cached. That is a real restructure, not a
rename, and it is why this is a future extension rather than part of phase 4.

**And there is a duplication to resolve first.** The break-even exists twice
with different sourcing: `entry.minPx`, baked into the table at module load, and
`kernel._threshold`, read at resolve time from
`Transform.WASM_DISPATCH_MIN_PIXELS`. Both are 256 today so nothing is wrong —
and the documented `= 0` profiling override still works, because `big` is
resolved with an infinite pixel floor. But a kernel answering for its own
break-even (phase 4e) would have to feed both, or the resolver would pick an
entry the per-call compare then declines to use. One source, then helpers.

**One ordering constraint.** `init()` runs during `create()`, on the instance,
after the pipeline exists, so a kernel can stash the helpers there and use them
for everything the image path needs. `floatFor()` cannot:
it is called on the *descriptor* while the pipeline is still being built, before
any `init`. That is fine — picking a single-colour function needs no dispatch
machinery — but it means the helpers are for the image path only, and the
contract should say so rather than let someone discover it.

## Future: `KernelIdentity` at index 0, so identity stops being a special case

`Transform.kernels` runs 1 to 15 because those are the input widths ICC can
express. Identity has no input width in that sense — it copies — so it sits
outside the registry as an `isIdentity` branch:

```js
if(this.isIdentity){
    this.transformArrayFn = function(...){ return t._kernelCopy(...); };
    return;
}
```

That is the last dimension-shaped special case left in Transform, and it does
not have to be one. **Register `KernelIdentity` at index 0** — its `array()`
is the copy — call `setKernel(0)` when `isIdentity`, and the branch goes away
along with the `isIdentity` check under it. Identity becomes a kernel selected
the same way as every other kernel.

Named for the role rather than the implementation, which is why not
`KernelCopy`: copying is how it works, identity is what it is, and the rest of
the registry is named the same way (`Kernel3D`, not `KernelTetrahedral`).

It buys more than symmetry. It gets `init(pipeline, opts)` like the rest, so an identity transform could **rewrite its own pipeline** — an
alpha-only pass, a copy with a stride change, a clamp — with none of it
becoming Transform's business. And index 0 becomes a place to put a test
kernel that counts identity conversions, which today there is nowhere to hook.

The registry already tolerates it: `registerKernel` takes a number or a range,
and `MAX_KERNEL_DIMENSIONS` is a ceiling, not a floor.

## Future: a registration chain, so wrappers do not have to capture

`init()` yielding to another kernel turns out to be the composition primitive.
A wrapper checks its own condition and either takes the transform or hands back
what it wrapped:

```js
init: function(pipeline, opts){
    if(!opts.kernelOptions || !opts.kernelOptions.sepia){
        return base.init.call(this, pipeline, opts);   // yield to the original
    }
    return { pipeline: pipeline, kernel: mySepiaKernel, meta: {...} };
}
```

The awkward part is `base`. Today a wrapper has to capture the previous
occupant itself — `var base = Transform.kernels[3]` at load time — and that is
fragile: two wrappers loading in the wrong order, or one capturing after the
other has already replaced the slot, and the chain is wrong in a way nothing
reports.

**Registration could do it.** `registerKernel` knows what it is displacing, so
it could set `descriptor.parent` to the previous occupant, `null` at the base.
Three kernels registered in turn would form a chain, each yielding to its
parent until the original answers.

```js
init: function(pipeline, opts){
    if(!thisIsForMe(opts)) return this.parent.init.call(this, pipeline, opts);
    …
}
```

Two things to get right if this is built:

- **There is already a chain.** `Object.create(Transform.kernels[3])` — the
  documented wrapping idiom — makes the previous occupant the *prototype*, so
  `Object.getPrototypeOf(this)` is the parent for anything built that way. An
  explicit `parent` is more reliable, because it does not depend on how the
  descriptor was constructed, but two chains that usually agree and sometimes
  do not is worse than either alone. Pick one and say so.
- **Re-registering the same object must not make it its own parent.** A cycle
  here is an infinite `init` recursion at create() time, which is a bad way to
  find out.

Worth having. Not needed yet, because the one wrapper that exists is in a test
and captures explicitly.

## Open questions

- **Does `createLut()`'s bake walk an optimised pipeline?** It affects whether
  the bake can use a `floatFor` WASM variant safely, and whether the two-phase
  rule needs a third row for the temporary pipeline.
- **What hint authorises a lossy representation?** A new option, an accuracy
  budget passed in `hints`, or an extension of the `lutMode` family — but not
  `interpolationFast`. See the representation section above.
- ~~**Should `floatFor` be allowed to return `null`?**~~ **Answered by phase 3:
  no.** A stage has no fallback to fall through to, and the kernels that had a
  real choice to make (3D, 4D) all resolve to something or throw. Returning
  `null` would mean a pipeline with a hole in it, discovered at transform time
  rather than build time. `floatFor` returns a binding or raises.
- **Per-channel TRCs and the sub-registry.** Matrix-shaper's JS variant exists
  partly to carry three curves where WASM carries one. Whether that is a second
  entry in Kernel3D's list or a variant inside one entry is a v1.6 question.
- **Does `emitKernel(opts)` want `floatFor`'s function or its source?**
  `compile()` currently sends CLUT stages to the runtime fallback. A kernel that
  owns its float function is the natural place to emit one.
