# The kernel contract

> **Status: phases 1-3 landed 2026-08-21; phases 4-7 not built.**
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
| **`arrayFor(lut, hints)`** | no | **PROPOSED** — returns `{big, small, threshold, bigName, smallName}` for the image path, resolved once at create. See [arrayFor](#arrayfor) |
| **`wantsLut(pipeline, opts)`** | no | **NEW** — replaces `provideLut` + `displacesLut` |
| **`init(pipeline, opts)`** | no | **NEW** — replaces `claims`; returns `{pipeline, kernel}` |
| `create(lutMode)` | yes | settle WASM state, demote lutMode if the host can't run the request; returns the settled mode |
| `resolveRuns()` | yes | resolve BIG/SMALL run refs onto the instance |
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
ordered list of 3-channel strategies and ranks them in `init()`. Matrix-shaper
registers with Kernel3D, not with Transform. The invariant holds at the
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
| A JS → WASM → GPU kernel: three tiers, two thresholds orders of magnitude apart, and a decision that depends on device availability | the kernel's own dispatcher returned in both slots with `threshold: 0` | nothing — though a GPU tier raises an async question for the *public API*, see [arrayFor](#arrayfor) |

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
| 4 | Loops and WASM state move onto the kernel; the 22 `run_` adapters in `lutKernelTable.js` follow the loops they call | ~~They exist only to rename `t.method`~~ **Corrected:** they are real adapters — they insert the `0, 0` position arguments, and the WASM ones do a `bind` + `run` pair with computed bytes-per-pixel. They relocate; they do not vanish |
| 4e | [`arrayFor()`](#arrayfor) returns `{big, small, threshold}`; the shared `WASM_DISPATCH_MIN_PIXELS` constant retires into the kernels that own each break-even | After the loops and adapters move — it is the binding layer over them, so it has nothing to bind until then. **Not a throughput change**; measure `bindTransformArrayFn` first and expect nothing |
| 5 | `init()` + sub-registry; matrix-shaper moves inside Kernel3D; `claims`/`claimKernels` retire | Needs 3 and 4 landed first |
| 6 | `wantsLut()` merges `provideLut` + `displacesLut` | Smallest surface, last |
| 7 | Per-dimension WASM loading behind a cached host probe | Independent of the rest; re-express the loadout test first |

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

<a id="arrayfor"></a>

## `arrayFor(lut, hints)` — one bound function for the image path

`floatFor` gives the kernel ownership of the single-colour path. `arrayFor` is
its counterpart: the kernel returns **one function, bound once at create()**,
and `transformArray` calls it with no dispatch on either side.

```js
// at create()
var bound = kernel.arrayFor(lut, hints);
// { big, small, threshold, bigName, smallName }

// per call
var fn = (pixelCount >= bound.threshold) ? bound.big : bound.small;
fn(input, output, pixelCount, inAlpha, outAlpha, preserve);
```

**Two functions and a threshold, not one function that branches inside.** The
kernel already resolves exactly this shape today — `_runBig`, `_runSmall`,
`_threshold` on the instance — so returning it is a rename of something that
exists rather than a new mechanism. Making it a return value rather than
private state buys three things:

- **The threshold becomes data.** Inspectable, assertable, reportable by
  `kernelInfo()`. Today it is a private field and a test has to reach for
  `kernel._threshold` to check it.
- **Non-WASM modes collapse to one bound function and no compare at all.**
  When nothing in the fallback chain is WASM-eligible, `big === small` and the
  threshold is 0 — which the current resolver already special-cases, precisely
  to skip the per-call comparison. Measured on `*sRGB → GRACoL`:

  | lutMode | big | small | threshold | collapsed |
  |---|---|---|---|:-:|
  | `float` | `fl_3_4` | `fl_3_4` | 0 | **yes** |
  | `int` | `i_3_4` | `i_3_4` | 0 | **yes** |
  | `int-wasm-simd` | `i8wsi_3_4` | `i_3_4` | 256 | no |
  | `int16-wasm-simd` | `i16wsi_3_4` | `i16_3_4` | 256 | no |

  So the fully-bound "one and done" shape is real, but it is **not** the case
  for the WASM modes — which are exactly the ones image work uses. Those keep
  the compare. That costs one comparison per image, which is nothing, but it is
  worth being accurate about rather than claiming a collapse that the fast path
  does not get.
- **A caller that knows its size can hoist the decision.** `transformImages()`
  splits into fragments of known pixel count, so the pool can pick once for the
  whole run instead of re-deciding per fragment.

`bigName` / `smallName` carry the resolved table entry (`i8wsi_3_4`, `fl_4_n`)
for diagnostics — the same strings `_runBigKey` / `_runSmallKey` hold now, which
`verbose` already prints and which `kernelInfo()` should surface.

Two tiers because the break-even is one decision, not a ladder: the fallback
chain (simd → scalar → js → float) is walked once at create() and lands on
exactly two outcomes.

**And two tiers is enough forever, because the second tier is an escape hatch.**

The case that makes this concrete is a **JS → WASM → GPU** kernel. Three tiers,
and not evenly spaced: the WASM crossover is a memcpy, a few hundred pixels,
while a GPU crossover is an upload plus a round trip and sits somewhere in the
millions. Two thresholds, wildly different magnitudes, and the second one
depends on things `{big, small, threshold}` knows nothing about — whether a
device is available, whether the last upload is still resident, whether the
caller is going to ask for the result back immediately.

That shape cannot be expressed as one threshold, and it should not have to be.
A kernel that wants it returns *its own dispatcher* in both slots:

There are two shapes for this, and both are legitimate.

**Resolved at bind time** — everything decidable is decided once, and the
returned closure does one thing:

```js
arrayFor: function(lut, hints){
    var dispatch = makeWhateverRoutingIWant(lut, hints);   // built once
    return { big: dispatch, small: dispatch, threshold: 0,
             bigName: 'custom', smallName: 'custom' };
}
```

**Decided per call** — the kernel keeps a real dispatcher and re-decides on
whatever it likes: size, content, cache state, how the last call went:

```js
arrayFor: function(lut, hints){
    var dispatch = this.multiDispatch.bind(this);          // NOTE the bind
    return { big: dispatch, small: dispatch, threshold: 0,
             bigName: 'multiDispatch', smallName: 'multiDispatch' };
},

multiDispatch: function(input, output, px, inAlpha, outAlpha, preserve){
    // size, content, anything — then delegate
}
```

**The `.bind(this)` is not optional.** A method reference returned raw loses its
receiver: these files are strict-mode modules, so `this` inside `multiDispatch`
is `undefined` and the first `this.anything` throws. It fails loudly rather than
silently, but it fails on the first array call rather than at create, which is
the worst time to find out.

Binding once inside `arrayFor` costs one allocation per `create()` and nothing
per call, so there is no reason to avoid it. The alternative — having Transform
invoke `kernel.method(...)` so the receiver comes along — reintroduces exactly
the property lookup the bound shape exists to remove, and puts the kernel's
internal structure back into Transform's hands.

**Per-call decisions are free here.** `arrayFor`'s result is invoked once per
image, not once per pixel, so "check size and other stuff per call" costs
nothing measurable. A kernel should feel free to be as dynamic as it wants.
This is not a fast-path-versus-flexible trade; the fast path is inside the
loop, and this is outside it.

One thing the dynamic shape gives up: `bigName` / `smallName` can only name the
dispatcher, not the variant that actually ran. A kernel doing per-call routing
that wants honest diagnostics should record its choice and expose it — the
built-in kernels report `i8wsi_3_4` and friends, and a `multiDispatch` that
reports only `'multiDispatch'` is a step backwards for anyone reading
`verbose` output.

Threshold 0 means `big` is always chosen, Transform makes no comparison, and
whatever happens inside `dispatch` is invisible to it. **Transform.js does not
care what it was handed — it calls a function.**

And the cost of being that dynamic is nil, because the dispatcher runs once per
image. A three-way branch on device availability and pixel count, per image, is
not a measurable thing.

### Where a GPU tier would actually live

`transformArray()` is synchronous and a GPU round trip is not, which looks at
first like a problem needing a new async API.

It is not, because that API already exists. **`transformImages()` is already
`await`-able**, already fragments the work, already hands each fragment to
another execution context and reassembles the results out of order, already
reports per-image progress through `onImage`. Today that other context is a
worker pool. A GPU is another executor of the same shape.

So the split is clean, and it is the one the library already has:

| | | |
|---|---|---|
| `transformArray()` | synchronous, one buffer | CPU: JS and WASM. A GPU tier reached here falls back to WASM. |
| `transformImages()` | async, fragmented, out-of-order reassembly | where a GPU backend belongs |

That makes GPU support a **new pool backend rather than a new API**, which is a
much smaller and much better understood problem — the fragment queue,
reassembly and progress reporting are all written.

**And for a single buffer, `transformArrayAsync()`.** `transformImages()` is
the right home for a batch, but it is the wrong shape for "convert this one
image and give it back". An async sibling to `transformArray` covers that:

```js
var out = await t.transformArrayAsync(input, ...);
```

It is well behaved in the boring case, which is what makes it worth having: with
no device, or a batch below the crossover, it does the synchronous work and
resolves immediately. The caller writes `await` once and gets the GPU when the
GPU helps, without branching on availability. `transformArray()` stays exactly
as it is — synchronous, no promise allocation, no change for anyone.

That leaves three entry points with clear jobs rather than one overloaded one:

| | |
|---|---|
| `transformArray()` | sync, one buffer, CPU |
| `transformArrayAsync()` | one buffer, may use a device, falls back silently |
| `transformImages()` | batch, fragmented, workers or devices, progress |

One thing carried over from the pool that a GPU tier would feel more sharply:
[multicore.md](./multicore.md) found efficiency *falls* as the kernel gets
faster, because the fixed per-fragment cost stays put while the compute it
overlaps shrinks. A GPU's fixed cost is an upload and a download rather than a
`postMessage`, so its crossover sits higher again — well into the millions of
pixels, and higher still for anything that wants its result back immediately.
That is the number to measure first, before writing a shader.

So the contract does not need to grow a third tier, and should not. `{big,
small, threshold}` is the *convenience* shape for the one decision every
built-in kernel actually makes; a kernel with a different idea keeps full
control by declining to use it. That is the same property as the rest of this
document — see [The shape test](#the-shape-test--what-a-stranger-can-do-without-touching-transform):
name a thing a third party might want, and check what Transform has to learn.
Here, again, nothing.

Today the same journey is: `transformArrayViaLUT` preamble → `kernel.array()` →
`ensureOutputArray` → `runTableKernel` → threshold compare → the resolved run
ref → `_postRunWasmCheck`. Every step is cheap, but the decisions are spread
across `Transform.js`, `kernelUtils.js` and `lutKernelTable.js`, and none of
them can change without touching all three.

### It is not a speed feature, and the evidence is already in the repo

**This was built and measured.** `bindTransformArrayFn` exists, binds exactly
these closures, and is **off by default**, with the reason recorded at
[Transform.js:4160](../../src/Transform.js:4160):

> V8 method dispatch through the kernel is equally fast for images and faster
> for tiny batches.

The arithmetic says the same thing. On a 1 M px call the dispatch is a property
lookup, a compare and an indirect call — call it 10 ns against ~10 ms of pixel
work. **One part in a million.** It cannot show up in a measurement, and a
bound closure that skips it will not either.

So `arrayFor` should not be sold as throughput. Anyone proposing it on those
grounds should be shown this paragraph and the flag that already exists.

### What it is actually for

- **Ownership.** A third-party kernel currently controls what runs but not how
  it is reached: allocation, the BIG/SMALL threshold and the post-run WASM check
  all live outside it. With `arrayFor` the kernel returns the whole path.
- **`compile()`.** This is the real payoff. The descriptor already reserves
  `emitKernel(opts)` for feeding `Transform.compile()`, and a kernel that can
  hand back one bound function is one step from handing back *source* for one.
  See [CompiledPipeline.md](./CompiledPipeline.md).
- **One place to look.** The BIG/SMALL threshold, output allocation and the
  WASM check become one function the kernel wrote, rather than three files that
  must agree.

### The threshold belongs to the kernel, which is the point

Today `WASM_DISPATCH_MIN_PIXELS = 256` is **one number shared by everything** —
every kernel, every lutMode, every channel count — and it is written twice,
in `Transform.js` and again in `lutKernelTable.js`, kept in step by a comment.

Those break-evens are not the same number. A 3-D int8 SIMD run copies 3 bytes
per pixel in and 4 out, against a table of a few hundred KB; a 4-D int16 run
copies 8 in and 8 out against a much larger one; the matrix-shaper kernel has no
CLUT to upload at all. One constant is standing in for at least three different
crossovers.

`arrayFor` returning the threshold makes it the kernel's answer rather than a
class static every kernel inherits, and removes the duplicated constant. That
is a better reason to build it than the dispatch saving, which is nil.

### `threshold: 0` means `small` is unreachable — mirror `big`, never stub it

The dispatch is `pixelCount >= threshold ? big : small`, and `pixelCount` is
never negative, so **a threshold of 0 means `big` is always taken and `small`
is dead**.

Put the same reference in both slots, as the current resolver does when it
collapses. Do **not** put a stub `function(){}` in `small` on the grounds that
it can never be called:

- it is a landmine if the comparison is ever written as `>` rather than `>=`,
  where a zero-pixel call would hit the stub and silently produce nothing
- it makes `smallName` lie, and that string is what `verbose` prints and what
  `kernelInfo()` should report

An unreachable slot holding a real function costs one reference. An unreachable
slot holding a stub costs a debugging session.

### The threshold is real, and must not be optimised away

WASM has a memcpy break-even: below it, the JS variant wins. `pixelCount` is
not known at bind time, so the decision cannot be bound away in the general
case — returning `{big, small, threshold}` exposes it rather than hiding it,
which is the point.

Worth stating plainly so nobody removes the compare later and sends 64-pixel
calls through a path that loses on the copy. `WASM_DISPATCH_MIN_PIXELS` is
where that break-even lives, and it is a class static so a profiler can move it
before `create()`.

The case where it *can* be bound away is when `big === small` — no WASM-eligible
entry anywhere in the chain — and the resolver already collapses the threshold
to 0 there for exactly this reason.

### Before building it

Turn `bindTransformArrayFn` on and measure. It is the same idea already wired,
and if it still shows nothing at image sizes — which the note above says it
will not — then `arrayFor` is justified by the `compile()` path and by
ownership, or not at all. Building it for speed and then finding no speed is
the failure mode this section exists to prevent.

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

**One ordering constraint.** `init()` runs during `create()`, on the instance,
after the pipeline exists. `resolveRuns()` and `arrayFor()` come later, so a
kernel can stash the helpers at `init` and use them there. `floatFor()` cannot:
it is called on the *descriptor* while the pipeline is still being built, before
any `init`. That is fine — picking a single-colour function needs no dispatch
machinery — but it means the helpers are for the image path only, and the
contract should say so rather than let someone discover it.

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
