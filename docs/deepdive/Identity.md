# Transform identity / NOP detection

**jsColorEngine docs:**
[← Project README](../../README.md) ·
[Bench](../Bench.md) ·
[Performance](../Performance.md) ·
[Roadmap](../Roadmap.md) ·
[Examples](../Examples.md) ·
[API: Profile](../Profile.md) ·
[Transform](../Transform.md) ·
[Loader](../Loader.md)

**Deep Dive:**
[← Index](./README.md) ·
[Architecture](./Architecture.md) ·
[LUT modes](./LutModes.md) ·
[JIT inspection](./JitInspection.md) ·
[WASM kernels](./WasmKernels.md) ·
[Compiled pipeline](./CompiledPipeline.md) ·
[Accuracy](./Accuracy.md)

---

> **Status: planned — v1.5.** This document is the design reference.
> Nothing described here is implemented yet.

## Table of contents

- [The problem](#the-problem)
- [1. Profile comparison — how to tell two profiles are the same](#1-profile-comparison--how-to-tell-two-profiles-are-the-same)
    - [1.1 Binary hash](#11-binary-hash)
    - [1.2 Virtual profile name matching](#12-virtual-profile-name-matching)
    - [1.3 Matrix property comparison](#13-matrix-property-comparison)
    - [1.4 `areSameType` — mandatory pre-check](#14-aresametype--mandatory-pre-check)
    - [1.5 Combining the strategies](#15-combining-the-strategies)
- [2. Chain collapse — finding identity in multi-stage transforms](#2-chain-collapse--finding-identity-in-multi-stage-transforms)
    - [2.1 The collapse rule](#21-the-collapse-rule)
    - [2.2 Examples](#22-examples)
    - [2.3 The collapse algorithm](#23-the-collapse-algorithm)
    - [2.4 Full identity vs. partial collapse](#24-full-identity-vs-partial-collapse)
    - [2.5 Intent is ignored](#25-intent-is-ignored)
    - [2.6 Black Point Compensation array must be updated on collapse](#26-black-point-compensation-array-must-be-updated-on-collapse)
- [3. The identity pipeline](#3-the-identity-pipeline)
    - [3.1 No LUT for identity](#31-no-lut-for-identity)
    - [3.2 Object format — two-stage pipeline](#32-object-format--two-stage-pipeline)
    - [3.3 Array formats — stage_device2device](#33-array-formats--stage_device2device)
    - [3.4 Optimiser interaction](#34-optimiser-interaction)
- [4. transformArray — the kernelCopy path](#4-transformarray--the-kernelcopy-path)
- [5. API surface and the breaking change](#5-api-surface-and-the-breaking-change)
- [6. Connection to kernel binding](#6-connection-to-kernel-binding)
- [Open questions](#open-questions)

---

## The problem

When source and destination profiles are the same, a colour transform
should be a no-op — the output should equal the input within floating-point
rounding. Today the engine doesn't detect this: it builds the full pipeline
(TRC decode → XYZ → chromatic adaptation → XYZ → TRC encode), and if
`buildLut:true` is set it allocates and fills a full CLUT.

This has two consequences:

1. **Correctness risk — CMYK separations are destroyed.** A CMYK→CMYK
   round-trip through the full pipeline is not lossless. The pipeline
   converts CMYK → XYZ → CMYK, which recalculates the ink separation from
   scratch using the output profile's gamut-mapping and UCR/GCR curves.
   A rich black (`0 0 0 100`) may come back as a four-colour build
   (`40 30 30 80`), and a carefully crafted spot-colour separation may
   have its K channel completely rebalanced. For prepress workflows —
   where the separation *is* the deliverable — this is a critical
   correctness failure, not a rounding issue.

2. **Wasted work.** Building a 17⁴ × 4 CMYK-to-CMYK LUT takes ~100 ms and
   ~100 MB of WASM memory for a transform that should cost a `memcpy`.

The fix is to detect same-profile pairs at `create()` time and route them to
a no-op path — both for single-pixel `transform()` calls and for
`transformArray()` image processing.

---

## 1. Profile comparison — how to tell two profiles are the same

No single comparison strategy works for every profile type. Three strategies
cover the space; they are tried in order and any match is sufficient.

### 1.1 Binary hash

When a profile is loaded from a binary ICC file, compute a fast hash
(FNV-1a 32-bit, same algorithm already used for LUT content signatures) over
the raw bytes and store it as `profile.binaryHash`.

```
profile.binaryHash = fnv1a(rawIccBuffer)   // set in Profile.load()
```

Two profiles with the same `binaryHash` are byte-identical — guaranteed
to produce the same pipeline regardless of type or content. This correctly
handles the case of comparing an embedded ICC profile extracted from a TIFF or
JPEG with a separately loaded copy of the same file.

**Limitation:** Virtual profiles (`*sRGB`, `*lab`, etc.) have no binary
source, so `binaryHash` is absent. Profiles loaded from the same file path
will match; profiles from different encodings of the same colour space
(e.g. a hand-crafted sRGB ICC vs. `*sRGB`) will not.

### 1.2 Virtual profile name matching

Virtual profiles are constructed from a canonical name string (`'*sRGB'`,
`'*adobeRGB'`, `'*lab'`, `'*p3'`, etc.). Two virtual profiles with the same
name are definitionally identical — they are constructed from the same
hard-coded data.

```
profile.virtualName = '*sRGB'   // set in Profile constructor for virtual profiles
```

Match: `inputProfile.virtualName === outputProfile.virtualName` (both
non-null). This correctly handles the overwhelmingly common case of
`new Transform().create('*sRGB', '*sRGB', intent)`.

**Limitation:** Does not match a virtual `*sRGB` against a loaded sRGB ICC
file, even if they are numerically close. Use strategy 1.3 for that.

### 1.3 Matrix property comparison

For RGB matrix profiles (`eProfileType.RGBMatrix`), identity can be
established by comparing the 9 elements of the forward XYZ matrix and the
gamma/TRC parameters. These are the only fields that drive the pipeline
for this profile type, so numerical agreement means the pipeline will be
identical.

```js
function rgbMatrixProfilesAreEqual(profileA, profileB) {
    if (profileA.type !== eProfileType.RGBMatrix) return false;
    if (profileB.type !== eProfileType.RGBMatrix) return false;
    const matrixA = profileA.RGBMatrix.XYZMatrix;
    const matrixB = profileB.RGBMatrix.XYZMatrix;
    const epsilon = 1e-10;
    for (const key of ['m00','m01','m02','m10','m11','m12','m20','m21','m22']) {
        if (Math.abs(matrixA[key] - matrixB[key]) > epsilon) return false;
    }
    // Also compare gamma / TRC — details TBD during implementation.
    return true;
}
```

This correctly matches a virtual `*sRGB` against a loaded sRGB ICC file if
the matrices agree numerically, which they do for well-known standard profiles.

**Limitation:** Only applies to `RGBMatrix` profiles. CMYK and LUT-based
RGB profiles require strategy 1.1 (binary hash) for reliable comparison.

### 1.4 `areSameType` — mandatory pre-check

Before any content comparison is attempted, both profiles must pass a type
guard. There is no point comparing matrices or hashes if the profiles cannot
possibly produce the same pipeline:

```js
function areSameType(profileA, profileB) {
    return profileA.type          === profileB.type
        && profileA.outputChannels === profileB.outputChannels
        && profileA.pcs           === profileB.pcs
        && profileA.version       === profileB.version;
}
```

`areSameType` returning `false` short-circuits the whole comparison
immediately. It catches the obvious mismatches (CMYK vs RGB, v2 vs v4)
cheaply before any hash or matrix work is done.

### 1.5 Combining the strategies

The comparison function applies the type guard first, then tries each content
strategy in order, returning `true` on the first match:

```
areProfilesTheSame(A, B):
  0. areSameType(A, B)     → type, channels, PCS, version all match
  1. areSameVirtual(A, B)  → virtualName && virtualName === virtualName
  2. areSameHash(A, B)     → binaryHash  && binaryHash  === binaryHash
  3. areSameMatrix(A, B)   → both RGBMatrix, XYZMatrix and gamma agree
  → false
```

**`areSameProps` / `areSameLUT` — stubbed `false` for now.** A natural
fourth strategy would compare the profile's actual colour data — for CMYK
profiles this means the A2B0 / B2A0 CLUT tables. `profile2Obj` is not
suitable for this: it captures only header metadata (name, type, intent,
white point, PCS encoding) and two CMYK profiles built for different TAC
limits (260% vs 300%) could have identical metadata but completely different
CLUTs. Falsely matching them would destroy their ink separations — which is
worse than not matching at all.

The correct implementation is a content hash computed at load time over
the raw CLUT bytes only (not the full file, so timestamp differences don't
prevent matching). That is a separate piece of work. Until it lands,
`areProfilesTheSame` returns `false` for any LUT-based profile pair that
doesn't match via binary hash — safe, just not optimal (the full pipeline
runs, which is always correct).

---

## 2. Chain collapse — finding identity in multi-stage transforms

`createMultiStage` receives a chain like
`[profileA, intent, profileB, intent, profileC]`. Identity detection needs
to look at the whole chain, not just the first and last profiles.

### 2.1 The collapse rule

> If two **adjacent** profiles in the chain are equal (by the comparison in
> §1), that pair and the intent between them can be removed from the chain.
> The intent on the **other side** of the removed pair is preserved.

Removing a pair never changes the semantics of the remaining conversions —
the profiles that surrounded the pair are now adjacent and will be connected
directly.

### 2.2 Examples

```
[sRGB > perceptual > sRGB]
   → sRGB == sRGB → remove pair → [] → 0 profiles left → full identity

[sRGB > perceptual > sRGB > relative > sRGB]
   → first pair: sRGB == sRGB → remove → [sRGB > relative > sRGB]
   → first pair again: sRGB == sRGB → remove → [] → full identity

[CMYK > perceptual > sRGB > relative > sRGB]
   → first pair: CMYK ≠ sRGB → no collapse
   → second pair: sRGB == sRGB → remove → [CMYK > perceptual > sRGB]
   → one pair left, CMYK ≠ sRGB → stop → partial collapse, no identity

[sRGB > perceptual > Adobe > perceptual > Adobe > relative > sRGB]
   → first pair: sRGB ≠ Adobe → skip
   → second pair: Adobe == Adobe → remove → [sRGB > perceptual > Adobe > relative > sRGB]
   → loop again: sRGB ≠ Adobe → skip; Adobe ≠ sRGB → stop
   → partial collapse to a valid 2-profile chain, no identity

[sRGB > perceptual > CMYK > relative > sRGB]
   → sRGB ≠ CMYK, CMYK ≠ sRGB → no collapse possible → standard pipeline
```

### 2.3 The collapse algorithm

```
function collapseChain(chain):
    loop:
        changed = false
        for i in 0 .. chain.length-3 step 2:   // walk profile slots
            profileLeft  = chain[i]
            profileRight = chain[i + 2]
            if profilesAreEqual(profileLeft, profileRight):
                // remove [profileLeft, intent, profileRight] from chain
                // keeping the intent on the right side of profileRight
                // (or nothing if profileRight was the last profile)
                chain.splice(i, 2)   // removes profileLeft + intent
                changed = true
                break   // restart — indices have shifted
    until not changed

    return chain   // may be [], [profileA, intent, profileB], or longer
```

Restarting on each change is safe because the chain is short (typical
multi-stage proofing chains are 3–7 profiles). Worst-case iterations is
`floor(chainLength / 2)`.

### 2.4 Full identity vs. partial collapse

| Collapsed chain length | Result |
|---|---|
| 0 (empty) | Full identity — `isIdentity = true`, identity pipeline |
| 2 (one pair) | Standard two-profile transform with the collapsed chain |
| ≥ 4 | Standard multi-stage transform with the simplified chain |

Partial collapse is still a win — it removes redundant pipeline stages and
simplifies the LUT even if full identity is not achieved.

### 2.5 Intent is ignored

When `profilesAreEqual` returns true for an adjacent pair, the intent
between them is discarded. This is correct: if source and destination are
the same profile, no rendering intent can change the output — the transform
is the identity regardless of whether perceptual, relative, or absolute is
requested. A SWOPCMYK→SWOPCMYK soft-proof should always produce pixel-identical
output, regardless of what intent the caller specified.

### 2.6 Black Point Compensation array must be updated on collapse

The `BPC` constructor option can be a single boolean (`BPC: true`) or a
per-stage array (`BPC: [true, false, true]`). The array form is indexed by
intent slot — `BPC[0]` applies to the first profile pair, `BPC[1]` to the
second, and so on.

When the collapse algorithm removes an adjacent pair, the corresponding BPC
entry must also be removed from the array, otherwise every subsequent entry
shifts down by one and the wrong steps get BPC applied.

Example — a three-profile proofing chain where the last two profiles are equal:

```
chain:  [CMYK, intent0, sRGB, intent1, sRGB]
BPC:    [true, false]        // index 0 = CMYK→sRGB, index 1 = sRGB→sRGB

after collapse of sRGB==sRGB pair (indices 2, 3 removed from chain):
chain:  [CMYK, intent0, sRGB]
BPC:    [true]               // index 1 removed, index 0 unchanged ✓
```

If BPC is a plain boolean rather than an array, no adjustment is needed —
it applies uniformly to all remaining steps.

The collapse algorithm therefore tracks the **intent slot index** of each
removed pair and splices the same index out of the BPC array in step:

```
if (Array.isArray(this.useBPC)) {
    this.useBPC.splice(intentSlotIndex, 1);
}
```

where `intentSlotIndex` is `i / 2` (the pair at profile position `i`
occupies intent slot `i / 2` in a zero-indexed chain walk over profile
positions `0, 2, 4, …`).

---

## 3. The identity pipeline

### 3.1 No LUT for identity

Identity transforms **never build a LUT**, even if `buildLut:true` was set
in the constructor. Before the LUT build is attempted, `isIdentity` is
checked and the LUT path is skipped entirely. `this.builtLut` remains
`false`. The `isIdentity` flag is set on the instance for downstream
inspection.

### 3.2 Object format — two-stage pipeline

For `dataFormat:'object'` and `'objectFloat'`, the identity pipeline reuses
the existing codec stages:

```
stage 1: createPipeline_Input_to_Device   (cmsObject → device[0..1])
stage 2: createPipeline_Device_to_Output  (device[0..1] → cmsObject)
```

The device `[0..1]` float array is a lossless intermediary at f64 precision.
The output is a correctly-shaped colour object with the right `type` and field
names, numerically equivalent to the input.

The alternative — dedicated `stage_copyRGB`, `stage_copyCMYK`,
`stage_copyCMYKf`, `stage_copyLab`, `stage_copyGray`, `stage_copyDuo` stages
— would be six new stages that each do nothing except copy field names from
one object to another. The two-stage codec achieves the same result by
reusing what already exists. The small cost (two function calls per pixel on
the accuracy path) is irrelevant at single-pixel throughput, and
`transformArray` bypasses this entirely via `kernelCopy` (§4).

### 3.3 Array formats — stage_device2device

For `dataFormat:'int8'`, `'int16'`, and `'device'`, the round-trip through
device encoding adds quantisation noise (int8 is lossy at 1/255 resolution).
For these formats the identity pipeline is:

```
stage 1: createPipeline_Input_to_Device    (int/device → float device array)
stage 2: stage_device2device               (copy — avoids mutation aliasing)
stage 3: createPipeline_Device_to_Output   (float device array → int/device)
```

`stage_device2device` is a shallow array copy:
```js
stage_device2device(deviceArray) {
    return deviceArray.slice();
}
```

The copy is needed because pipeline stages may mutate their input in place
(the optimiser's fused stages do this). Without the copy, the caller's
original array could be silently modified.

### 3.4 Optimiser interaction

The optimiser can detect the 3-stage identity pattern and remove
`stage_device2device`, since `createPipeline_Input_to_Device` and
`createPipeline_Device_to_Output` together form a codec that is lossless
(within quantisation) — the copy is only there as a guard against mutation,
and the optimiser can verify that the surrounding stages do not mutate in
place.

Detection condition:
- `pipeline.length === 3`
- `pipeline[0].stageName` starts with `'stage_*_to_Device'` (input codec)
- `pipeline[1].stageName === 'stage_device2device'`
- `pipeline[2].stageName` starts with `'stage_device_to_*'` (output codec)

If detected, `pipeline[1]` is removed and the pattern is logged as
`'[identity: 2-stage codec, device2device removed]'`.

---

## 4. transformArray — the kernelCopy path

`transformArray` today dispatches to different inner loops based on
`dataFormat`, `buildLut`, and `lutMode`. Identity adds a new top-level branch:

```js
transformArray(...) {
    if (this.isIdentity) {
        return this._kernelCopy(inputArray, inputHasAlpha, outputHasAlpha,
                                preserveAlpha, pixelCount, outputArray);
    }
    // ... existing dispatch ...
}
```

`_kernelCopy` is not a trivial `memcpy` — it must handle the same alpha and
typed-array contract as the existing image kernels:

- **Alpha flags**: strip input alpha, add output alpha, preserve alpha — the
  same three-flag logic as the existing inner loops, just without colour math.
- **Output array type**: `Uint8ClampedArray` for int8, `Uint16Array` for int16.
  The output container must match `dataFormat` exactly.
- **Pre-allocated output**: if the caller passes `outputArray`, write into it
  rather than allocating.

When `inputHasAlpha === outputHasAlpha` and `preserveAlpha`, the inner loop
reduces to a direct typed-array copy of a contiguous stride — effectively a
`memcpy`. The more complex alpha cases need a channel-stride loop, but still
no colour conversion.

`_kernelCopy` is always used for identity regardless of `lutMode`, `buildLut`,
or WASM availability. The binding step (see §6) sets `this.transformArrayFn`
to a closure over `_kernelCopy` at `create()` time.

---

## 5. API surface and the breaking change

**New constructor option:**

```js
new Transform({ detectIdentity: true })   // default: true
```

`detectIdentity: true` (the default) enables chain collapse and identity
detection at `create()` time. Setting `false` forces the full pipeline even
for same-profile pairs — useful for testing or for intentional round-trip
measurements.

**New instance property:**

```js
transform.isIdentity   // boolean, set after create()
```

**Breaking change.** Defaulting `detectIdentity` to `true` means existing
code that relies on same-profile transforms being lossy (e.g. a test that
expects specific rounding from a round-trip) will start seeing exact
pass-through. This is the correct behaviour, but it is a semantic change.

The breakage surface is small:
- Production code: same-profile transforms *should* be identity.
  If any production code breaks on this, it was relying on a bug.
- Tests: any test that asserts specific non-identity values from a
  same-profile transform will fail. These tests should be updated to
  assert identity (or to use `detectIdentity: false` if the round-trip
  measurement is intentional).

The change should be noted prominently in the v1.5 release notes.

**Identity detection does not catch functionally identical but binary-different
profiles.** Two CMYK profiles built from the same measurement charts will have
minor floating-point differences in their CLUTs (different rounding from the
profiling software, different timestamps). They will not match on any of the
three comparison strategies and the full pipeline will run. This is correct
behaviour — the engine cannot know they are semantically equivalent without
actually comparing all the colour data.

Developers are encouraged to bypass transforms entirely at the application
level when they know no conversion is needed. A common example: reading a
JPEG with no embedded profile and assuming sRGB → skip the transform
altogether rather than constructing a same-profile Transform. Identity
detection is a safety net for when same-profile pairs appear inside a larger
chain, not a substitute for application-level no-op checks.

---

## 6. Identity is a kernel

Until v1.6 identity was the one dimension-shaped special case left in
Transform. It had its own branch in `create()`, its own pipeline-builder call,
its own bound closure, and it returned before the kernel registry was ever
consulted:

```js
if(this.isIdentity){
    this._buildIdentityPipeline();
    this.pipelineCreated = true;
    this._bindTransformArrayFn();      // bound _kernelCopy in a closure
    return;
}
this.setKernel(this.inputChannels);
```

It is `Transform.kernels[0]` now.

### The distinction that made it possible

**Input dimension is not input channel count.** An identity RGB→RGB conversion
still has three input channels; it needs no 3-D kernel because there is nothing
to interpolate. Those two were the same variable, which is why identity had to
duck out of `create()` before `setKernel` rather than flow through it:

```js
this.inputDimension = this.isIdentity ? 0 : this.inputChannels;
this.setKernel(this.inputDimension);

if(this.isIdentity){
    this._initKernel();                             // the kernel builds the pipeline
    this.pipelineCreated = this.pipeline.length > 0;
    return;
}
```

`pipelineCreated` is **derived, not asserted**. `_initKernel()` deliberately
swallows a throwing `init()` so one bad kernel cannot break `create()` — a
reasonable policy when the kernel is choosing a variant, and the wrong one when
the kernel is *building the pipeline*, because it would leave an empty one
behind with nothing to show for it. Deriving the flag turns that into a clean
`pipelineCreated: false`.

### What moved, and what did not

`KernelIdentity.init()` calls `_buildIdentityPipeline()`, which stays on
Transform along with `createPipeline_Input_to_Device` and the rest — those are
shared with every other conversion and are not identity's to own. What moved is
the **decision** that an identity transform gets a device-to-device copy
between them. Register a different kernel at index 0 and that changes, with
nothing in `Transform.js` to edit.

That is the same shape as Kernel3D yielding to the matrix shaper, and it is
what the slot buys beyond symmetry: `init()` receives the pipeline, so an
identity transform can now **rewrite its own pipeline** — an alpha-only pass, a
copy with a stride change, a clamp — without any of it becoming Transform's
business. Index 0 is also somewhere to hang a probe that counts identity
conversions, which there was previously nowhere to hook.

### `transformArrayFn` is gone

The bound closure that used to carry identity was removed in the same change.
For the LUT path it had been measured worthless before any of this — the
[Roadmap](../Roadmap.md) records "no faster for images and slower for tiny
batches", which is why it shipped defaulted off — and once the kernels owned
dispatch, its LUT branch was a wrapper calling `kernel.array()`, so it could
not be faster than the thing it called.

Identity was the half that was doing real work: without it, an identity
`transformArray()` fell through to the generic per-pixel pipeline walk. So it
was replaced rather than simply deleted. `transformArray()` reaches the kernel
directly:

```js
if(this.isIdentity && this.kernel){
    return this.kernel.array(inputArray, outputArray, pixelCount, this.lut,
                             inputHasAlpha, outputHasAlpha, preserveAlpha);
}
```

`bindTransformArrayFn` is still accepted and ignored, so v1.5 option objects
keep working.

**Not measurable, and said plainly.** An identity copy runs at 4–5 GPx/s and is
bounded by memory bandwidth: repeated A/B runs spanned 4020–5280 MPx/s on the
old code and 4252–5098 on the new, with the sign flipping between rounds. No
claim is made either way. The LUT paths, which are slow enough to measure, were
flat across the same runs.

## Open questions

**Q1. General-purpose profile equality for LUT-based profiles.**
Binary hash (§1.1) handles loaded-file vs loaded-file. Matrix comparison
(§1.3) handles RGB matrix profiles. LUT-based profiles (CMYK, RGBLut) with
no binary hash — loaded from different paths but numerically identical — will
fall through to `false`.

Two candidate approaches for a future `areSameLUT`:

- **CLUT content hash** — compute FNV-1a over the raw A2B0 / B2A0 bytes at
  profile load time, ignoring the header timestamp. Two profiles with the
  same CLUT data match regardless of file origin.
- **Profile object walker** — walk the profile object recursively with a list
  of ignored properties (timestamps, descriptions, creator strings) and
  compare the rest. This works on ALL profile types without type-specific
  logic, at the cost of being slower and needing a carefully curated ignore
  list.

`areSameType` (§1.4) already guards against the obvious mismatches before any
CLUT data is touched. The work here is only needed for same-type profiles that
lack a binary hash.

**Q2. `*lab → *lab` and `*xyz → *xyz`.**
Matched virtual names → identity by §1.2. The two-stage codec round-trip is
numerically stable for Lab at f64 precision. One edge case: if
`labInputAdaptation` or `forceChromaticAdaptation` is enabled, the Lab input
stage adapts the white point before entering the pipeline. If input and
output white points are the same (both D50, which all virtual Lab profiles
are), the adaptation is a no-op and identity holds. If a non-standard white
point is supplied via the input colour object, the round-trip will adapt
forward then back — still identity as long as both profiles share the same
white point.

**Q3. `create()` vs. `createMultiStage()`.**
`create()` is a one-line wrapper that calls `createMultiStage` with a
3-element chain. The collapse algorithm lives entirely in `createMultiStage`.
`create()` gets identity detection for free with no changes.

**Q4. `validateOnCreate` interaction.**
No special casing needed. `validatePipeline()` runs on the identity pipeline
normally — the test colour round-trips through device encoding and back. The
result is valid and non-NaN.

**Q5. `isIdentity` and `toJSON()` / `hasLut()`.**
An identity transform has no CLUT. `toJSON()` already throws when `this.lut`
is falsy, so no change needed — the existing error is correct.

A `hasLut()` helper (or `transform.lut !== false` check) would let callers
branch cleanly before calling `toJSON()`:

```js
if (transform.hasLut()) {
    const json = transform.toJSON();
    // ... save to disk ...
}
```

Add `hasLut()` as a simple getter alongside the identity work.
