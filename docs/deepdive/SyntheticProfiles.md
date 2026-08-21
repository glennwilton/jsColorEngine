# Synthetic profiles, and testing what you cannot buy

> **Status: built and passing 2026-08-22. Fifteen dual-table profiles, every
> input width into every output width, 1 to 15, both depths.**

Most of this engine had never been compared against another colour management
system. Not because nobody thought to — because there was nothing to compare
*with*.

This is the account of building something to compare with, what turned up once
it existed, and the two routes that looked right and turned out to measure
something else.

---

## The shape of the hole

`bench/lcms-comparison/accuracy.js` measures jsColorEngine against Little CMS
for RGB and CMYK. It is the most valuable test in the repo. It covers two
channel counts.

The reason is licensing. Real ICC profiles are somebody's intellectual
property, so this repo ships exactly two — sRGB is virtual, AdobeRGB and
GRACoL are the files. That is 3 and 4 channels. Which leaves:

| kernel | channels | oracle before this work |
|---|---|---|
| `Kernel1D` | 1 | **none** |
| `Kernel2D` | 2 | **none** |
| `Kernel3D` | 3 | accuracy.js |
| `Kernel4D` | 4 | accuracy.js |
| `KernelND` | 5–15 | **none** |

Three of the five kernels could only ever be checked against themselves.

### Why "checked against itself" is not a small caveat

`__tests__/interp_reference.tests.js` exists precisely because self-comparison
is weak, and it is a good suite: it runs every specialised interpolator against
`tetrahedralInterp3D_Master`, on random tables, at exact equality.

It could not see a fault running through **four** interpolators at once.

`_3Ch`, `_4Ch` and both 4-D variants clamped their input to 0..1 *before*
applying the grid scale. With `inputScale` at 1/255 — which is what a LUT built
for an 8-bit pipeline uses — every value from 1 to 255 collapsed onto one grid
cell. `transform()` on a `buildLut: true` Transform returned a **constant
colour**, whatever you passed it. `[2,2,2]` for sRGB→AdobeRGB, for every input.

The suite could not see it, and the reason is worth stating exactly: it ran the
variants at `inputScale = 1`, where clamping to 1 is a no-op. It *also* had a
block at `inputScale = 1/255` — which only ever exercised `_NCh`, the one
variant that was already correct. Right functions at one scale, right scale
with the other functions — nothing covered the diagonal.

That is the shape of a blind spot in a self-consistent suite — not
carelessness, a gap invisible from inside the thing doing the checking. It is
the whole reason a second engine is worth building profiles for.

---

## The way out is to write profiles, not find them

A profile **the engine wrote** carries no licensing question. It is ours. It
can be committed, opened in an inspector, and handed to Little CMS.

So `src/encodeICC.js` is the mirror of `decodeICC.js`:

| | |
|---|---|
| `encodeICC.js` | primitive writers, tag types, `mft2`, profile assembly |
| `Profile.toICC()` | encode a loaded profile |
| `Profile.createGrayICC()` | synthesise gray |
| `Profile.createNChannelICC()` | synthesise 1–15 channels, **both tables** |
| `scripts/make_test_profiles.js` | write them to `__tests__/profiles/` once |
| `accuracy_gray.js` / `_nchannel.js` / `_b2a.js` | hand them to lcms |
| `__tests__/channel_matrix.tests.js` | every width into every width |

It is also a feature rather than only scaffolding: decode a profile, change a
TRC or a CLUT cell, write it back. That is profile editing.

### What it refuses to write, and why that is the interesting part

**RGB matrix profiles.** Not because they are hard — because they are the one
shape there is no shortage of, so writing them would test the writer rather
than the engine.

But there is a second reason, and it is the better one. The `rXYZ`/`gXYZ`/`bXYZ`
tags hold **D50-adapted** colourants. `RGBMatrix.matrixV4` decodes to the
*unadapted* matrix, and the decoder does not keep the tag values themselves.
Writing `matrixV4` into those tags produces a profile that opens cleanly in
every tool and is off by a chromatic adaptation. Nothing crashes; the colours
are simply not what the profile says they are.

Refusing to guess is the correct behaviour for a writer, and `toICC()` throws
rather than emitting one.

---

## What the oracle surfaced

It was built to reach what nothing else could, and on its first runs it did.
Every finding below is a path the engine advertised and no test had been able
to execute — not because the code was careless, but because there was no
profile in existence to take that route.

**Above 4 input channels, the batch entry point had no route in.** The
per-pixel fallback in `transformArray()` handled 1 to 4 and had no general
case, so an n-channel conversion allocated an output of the right length and
returned it unfilled. The kernel, the registry and the interpolators were all
correct; the door into them was the piece nobody could reach to check.

Two more have sections of their own, because each says something beyond the
fix: **int16 had no route into a wide profile**
([below](#int16-and-the-wide-output-route)) and **a stage name assembled by
concatenation** left 165 of 225 conversions unreachable
([below](#the-165-of-225-finding)).

The wider surface also settled two smaller questions about what
`transformArray()` returns — a typed array matching `dataFormat` rather than
one that depends on whether a LUT was built, and an output sized for an alpha
slot whenever one gets written.

## Fifteen files, two hundred and twenty-five combinations

The first version of this generated separate A2B-only and B2A-only profiles, as
though they were different kinds of thing. They are not: **a real device
profile carries both tables**, and once each profile has both, the test matrix
collapses.

Run profile *A*'s `A2B` into profile *B*'s `B2A` and you have every input width
paired with every output width. Fifteen files, 225 combinations, 4.6 MB.

`__tests__/channel_matrix.tests.js` does exactly that, and the bar is
deliberately low: three pixels, both surfaces, does it come back finite and the
right length. Not speed, not agreement with another CMS — those are the
accuracy benches. This one answers *can the engine do what it says it can*
across its whole declared range.

Two shapes fell out of the consolidation that were worth having anyway: a
**LUT-based RGB** profile, where every RGB profile in the repo had been
matrix-based, and a synthetic CMYK.

<a id="the-165-of-225-finding"></a>

### The 165-of-225 finding

The matrix turned something up on its first run that no single test could have.
Every conversion **into** a 5-or-more-channel profile stopped in the same
place:

```
TypeError: Cannot read properties of undefined (reading 'call')
```

`optimisePipeline()` assembles one stage name by concatenation:

```js
var deviceToIntFunctionName = 'stage_device' + lut.outputChannels + '_to_int';
```

The unrolled `stage_deviceN_to_int` variants cover 1 to 4 channels. Above that
the name resolves to nothing and the stage carries no function. A generic
`stage_deviceN_to_int` was already sitting in `stages.js`; the answer is to
reach for it when no specialised one exists.

**The interesting part is what had already passed.** The B2A accuracy bench
converts sRGB into 6-, 10- and 15-channel profiles and agrees with Little CMS
to within 1 LSB — because the optimiser pattern this depends on does not fire
on that pipeline shape. The same conversion succeeded from one entry point and
stopped at another.

A bench that exercises one route through a feature measures that route. "Does
the feature work" is a different question, and 225 combinations across two
entry points is what it takes to ask it.

## The noise route, and what it measured instead

The n-channel CLUTs started as **noise**, on reasoning taken straight from
`interp_reference.tests.js`:

> Random rather than smooth: a smooth ramp hides index errors, because a
> neighbouring cell holds nearly the right answer.

That is correct, and it is why that suite uses noise. Across *engines* it
measures something else. The first n-channel run reported **max 144 LSB, mean
33.5** — a number that reads as total failure and turned out to be a property
of the comparison rather than of the engine.

The two interpolate differently:

| | scheme |
|---|---|
| Little CMS | tetrahedral on the last 3 axes, linear on every extra one |
| jsColorEngine (then) | one Kuhn simplex across all n axes |

Both are exact at grid points and differ inside a cell. ICC mandates neither.
On a table of unrelated neighbours there is **no answer for two schemes to
converge on**, so the difference is unbounded and says nothing about either.
Same code, same profiles, smooth table instead: **max 6, mean 0.18**.

The rule that falls out is worth carrying:

- **Noise, comparing an implementation to a reference of the same scheme.** A
  ramp hides index errors; noise exposes them. This is `interp_reference`.
- **Smooth, comparing across engines.** Noise turns a legitimate scheme
  difference into a number that looks like failure.

So the n-channel tables are a plausible ink model — coverage darkens, the first
two channels rotate hue, chroma collapses toward black as coverage rises. Not a
characterisation of anything real, but smooth, which is the property that makes
the comparison mean something. `opts.noise` restores the old behaviour for
self-consistency work, where it is once again the better choice.

---

## What the oracle can and cannot certify

It catches **structural** faults — index arithmetic, channel order, stride, Lab
encoding, a missing loop. Those show as tens of LSB and a mean in double
figures, which is exactly how the missing batch route announced itself.

It **cannot** certify sub-LSB agreement while the schemes differ, and the gate
is set to say so rather than imply otherwise: max 8 LSB, mean 1. An order of magnitude clear
of both the scheme difference and anything that would indicate a real fault.

That distinction is the reason the comparison is a bench and not a test. A test
asserts; this measures, and the number needs reading.

---

## Results

**Gray** — γ1.0, γ1.8, γ2.2 and a 256-entry sampled TRC (a different code path
in every reader), gray→sRGB across all 256 input steps:

| | ≤1 LSB | max | mean |
|---|---|---|---|
| all four | **100%** | 1 | 0.004 |

γ1.8 is bit-exact.

**n-channel** — device→sRGB, 4096 random device values per profile:

| profile | kernel | grid | exact | ≤1 LSB | max | mean |
|---|---|---|---|---|---|---|
| 2CLR | kernel2D | 33 | **100%** | **100%** | **0** | **0.0000** |
| 5CLR | kernelND | 9 | 82.6% | 99.0% | 6 | 0.197 |
| 6CLR | kernelND | 7 | 95.6% | 99.2% | 6 | 0.073 |
| 7CLR | kernelND | 5 | 87.1% | 99.0% | 5 | 0.147 |
| 8CLR | kernelND | 4 | 97.9% | **100%** | 1 | 0.021 |
| 9CLR | kernelND | 3 | 97.4% | 99.7% | 4 | 0.031 |
| 10CLR | kernelND | 3 | 99.2% | **100%** | 1 | 0.008 |

`Kernel2D` agrees with Little CMS **bit for bit**.

---

## Why the interpolator changed, and why the old one is still here

The n-channel numbers above are after adopting lcms's scheme. Before it, the
same table read:

| ch | grid | simplex | lcms scheme |
|---|---|---|---|
| 5 | 9 | 119 ms, mean 0.177 | 60 ms, mean 0.197 |
| 8 | 4 | 155 ms, mean 0.479 | 441 ms, mean 0.021 |
| 10 | 3 | 180 ms, mean 1.130 | 1746 ms, mean 0.008 |

The simplex is not better anywhere. At 5 and 6 channels — the counts anyone
ships, Hexachrome being 6 — the lcms scheme is **faster**, because four
tetrahedral evaluations cost less than a sort the simplex cannot avoid. Above
that the simplex wins on speed and loses 23× to 140× on agreement.

And it loses it precisely where `grid^n` has already forced the table down to 3
or 4 points per axis. **The Lab gamut is a lobed solid, not a box** — at that
density nothing is recovering real colour, so the speed is bought with nothing.
Choosing between two kinds of nothing, matching the reference CMS is the
better kind.

`simplexInterpND_NCh` is kept with the measurement in its JSDoc, behind a
hard-coded `ND_INTERPOLATOR` toggle in `KernelND.js`. Not a user option — a
switch for whoever wants to re-run the comparison rather than take the numbers
on trust. Deleting it would throw away both the better algorithm and the
evidence for not using it.

---

## PCS → device: the direction that reaches 15

`B2A` is the other table, and the one real 12- and 15-colour profiles are built
around. Its grid is **3-D whatever the ink count** — only the output stride
grows — so 17³ × 15 is 73,695 cells and 145 KB, where the same width in `A2B`
is not encodable at any useful density.

It exercises different code, too: 3 channels in, n out is `Kernel3D`'s
**wide-output** runs (`fl_3_n`, `i_3_n`, `i16_3_n`), not `KernelND`.

sRGB → nCLR, 4096 random colours, both depths:

| profile | out | int8 max / mean | int16 max / mean |
|---|---|---|---|
| 2CLR | 2 | 1 / 0.0059 | 0.01 / 0.0024 |
| 4CLR | 4 | 1 / 0.0078 | 0.01 / 0.0016 |
| 6CLR | 6 | 1 / 0.0033 | 0.01 / 0.0022 |
| 8CLR | 8 | 1 / 0.0015 | 0.01 / 0.0022 |
| 10CLR | 10 | 1 / 0.0031 | 0.02 / 0.0022 |
| 12CLR | 12 | 1 / 0.0016 | 0.01 / 0.0022 |
| 15CLR | 15 | 1 / 0.0026 | 0.01 / 0.0022 |

**100% within 1 LSB at every width, both depths.** (int16 figures are in
8-bit-equivalent units, so 0.01 is roughly 3 raw u16 LSB out of 65535.)

Feeding sRGB rather than Lab is deliberate: Lab on the interface would put the
v2-versus-v4 encoding between the two engines, where a mismatch looks exactly
like an interpolation error. sRGB keeps the PCS internal to each and still
drives the table under test.

<a id="int16-and-the-wide-output-route"></a>

### int16 and the wide-output route

The **first int16 run** stopped cleanly and said exactly why:

```
lutKernelTable: fallback chain exhausted from "i16wsi_3_n" (no float fallback?)
```

`buildIntLut()` builds no table above 4 output channels, which is a sensible
place to stop. At int8 that costs nothing — the u8 dispatch ladder degrades to
float and the conversion runs. The u16 ladder had no float rung, so
`dataFormat: 'int16'` had no route into a 5-or-more-channel profile.

The guard that stopped it was reasoning correctly about a different situation.
"16-bit kernels were asked for and their table was never built" is a fair thing
to say when a u16 run exists; above 4 output channels none does, and `u16Run`
was already the float run. Float is a legal landing point for an int16 mode,
because `outputScale` is folded to 65535 and the float run scales at call time.
The guard now covers narrow output only, and every input width 1–15 reaches
every output width 1–15 in every mode.

**What is worth carrying forward is how it stayed out of reach.** The u16
ladder inherited its shape from the v1.3 dispatch table, and the v1.6 switch
rewrite reproduced it faithfully — verified against a 560-case equivalence
oracle. That oracle did precisely what it was built to do: prove the new switch
matched the old table. An oracle framed as *does this agree with the previous
version* answers that question and no other, however thorough it is. Little CMS
answers a different one, which is why both are worth having.

---

## What the profiles made measurable

Once fifteen widths exist, `bench/channel_matrix/run.js` can measure all 225
combinations. It is **not a gate** — 3- and 4-channel input is where the
throughput work is, and where the pinned baseline lives. This is a map of the
correctness path: how slow is it, and where are the cliffs.

Mean MPx/s by input width, diagonal excluded:

| in | MPx/s | ×prev | |
|---|---|---|---|
| 1–4 | 61 / 40 / 43 / 24 | | a CLUT is built; tuned array loops run it |
| 5 | 2.50 | | `KernelND` declines the LUT — grid^n — so the per-pixel walk runs |
| 6 | 1.80 | 1.4× | |
| 8 | 0.68 | 1.6× | |
| 10 | 0.20 | 1.9× | |
| 12 | 0.055 | 1.9× | |
| 15 | 0.007 | 2.0× | a 1 MP image takes 143 seconds |

**The ×prev column settling at 2.0 is the interpolator, not the pipeline.** The
Little CMS scheme is `2^(n-3)` tetrahedral evaluations, so every extra channel
doubles the work.

### Recording the conditions

`channel-matrix.json` carries an `ndInterpolator` field, and the reason
generalises. The two n-channel interpolators differ by up to 75× at 15
channels, so a table measured with one is not comparable to a table measured
with the other — and nothing in a column of MPx/s says which produced it. A
results file that does not record its own conditions reads as authoritative
when it is not.

The pinned baseline carries an `addedLater` block for the same reason: it was
assembled from two runs, and a manifest claiming one provenance for two
measurements would be worse than no manifest at all.

The **diagonal is identity**, and it sits outside the summary. Profile *n* into
profile *n* is the same profile twice: the chain collapses, `KernelIdentity`
takes it, and it copies at memcpy speed. It stays visible in the grid because
watching identity detection fire is worth something, and out of the means
because at ~5,000 MPx/s it would swamp them.

---

### The surface Transform does not normally reach

`KernelND.provideLut()` declines — an N-D CLUT bake is `grid^n` cells — so
Transform walks the per-pixel pipeline and `KernelND.array()` is only entered
through a LUT attached **out of band**, via `setLut()` or direct assignment.
That is a supported route with a safety net written for it in `Transform.js`,
and nothing had ever taken it.

Taking it needed two things. The loop divided its input by 255 and multiplied
the result by 255, on top of the LUT's own `inputScale` and `outputScale` —
correct only when both are 1. Against a normal LUT every colour landed near
grid cell 0 and came back saturated, **187 LSB** from the single-colour path on
the same table. And it named `tetrahedralInterpND_NCh` directly, so past the
split at 11 channels the two surfaces would have run different interpolators
over the same data.

Both surfaces now agree **exactly**, on both sides of the split.

**And it answers whether declining the LUT costs anything**, which is the more
useful half. A LUT-backed `array()` against the pipeline walk:

| in | grid | pipeline | LUT + array() | gain | build | table |
|---|---|---|---|---|---|---|
| 5 | 9 | 3.23 | 4.18 | 1.3× | 20 ms | 1.4 MB |
| 6 | 7 | 2.22 | 2.63 | 1.2× | 60 ms | 3.8 MB |
| 7 | 5 | 1.24 | 1.43 | 1.1× | 63 ms | 1.9 MB |
| 8 | 4 | 0.71 | 0.77 | 1.1× | 97 ms | 1.6 MB |

**1.1× to 1.3×**, because both paths call the same interpolator per pixel — the
array loop only skips the other seven pipeline stages, which is the ~0.2 µs/px
measured [above](#where-the-time-actually-goes) arriving from the other
direction. Break-even is 0.3–0.9 MPx, so it would pay back on a large image;
against `grid^n` memory and a 20–97 ms build for that much, declining is the
right answer. Now with a measurement behind it rather than an assumption.

---

## The interpolator split

Two schemes, opposite shapes:

| | cost |
|---|---|
| Little CMS — tetrahedral on the last 3 axes, linear on the extras | `2^(n-3)`, doubles per channel |
| Kuhn simplex across all n axes | `O(n)`, flat |

| ch | tetrahedral | simplex | |
|---|---|---|---|
| 5 | **2.50** | 0.98 | tetrahedral 2.6× faster |
| 7 | **1.11** | 0.86 | tetrahedral 1.3× |
| 8 | 0.68 | **0.85** | crossover |
| 10 | 0.20 | **0.69** | simplex 3.4× |
| 15 | 0.007 | **0.53** | simplex **75×** |

`KernelND` splits at **11, not at the crossover of 8**. Between 8 and 10 the
accuracy gap is still real — mean 0.02 LSB from lcms against 0.48–1.13 — and
paying 1.2–3.4× to stay near the reference CMS is worth it.

At 11 and up the A2B grid is **2 points per axis**, and that is a ceiling
rather than a choice: `3^15` is 43 million cells. A 2-point table has no
interior at all, and the Lab gamut is a lobed solid that `2^n` corners cannot
express in any case. Accuracy there is not something either scheme can deliver,
so 6–75× is bought with nothing.

### The allocation route, and what it measured

The recursion allocates a `lo` and a `hi` array at every internal node — around
8,000 arrays per pixel at 15 channels — which looks like the obvious thing to
remove. Replacing them with a single preallocated `Float64Array` indexed by
depth made 5-channel input **40% slower** (2.50 → 1.50 MPx/s) and changed
11–15 not at all.

Two useful things came out of that. V8 handles small short-lived arrays better
than a typed array with computed offsets at these sizes — the young generation
is doing exactly what it is for. And at high *n* the cost genuinely is the
`2^(n-3)` evaluations, so no amount of allocation work reaches it. That is what
sent the answer toward the split at 11 instead.

<a id="where-the-time-actually-goes"></a>

### Where the time actually goes

| input | total/px | interpolator | share |
|---|---|---|---|
| 5ch | 0.297 µs | 0.171 µs | 57% |
| 6ch | 0.421 µs | 0.289 µs | 69% |
| 8ch | 1.277 µs | 1.055 µs | 83% |

The other eight pipeline stages are a flat ~0.2 µs/px. So the interpolator is
the right target if this path is ever worth optimising — and the obvious lever
is that **A2B output is always 3 channels**, because device→PCS lands in Lab or
XYZ. The inner loop over `outCh` could be unrolled for the only case that
occurs. Not attempted: this is the correctness path, and the throughput that
matters is 3- and 4-channel input, which is already tuned, WASM-backed and
gated against a pinned baseline.

---

## Why `A2B` stops at 10 channels

The device→PCS table is `gridPoints ^ inputChannels` cells:

| dims | points | cells × 3 |
|---|---|---|
| 4 | 33 | 3.5 M |
| 6 | 7 | 706 K |
| 8 | 4 | 393 K |
| 10 | 3 | 354 K |
| 15 | 3 | **43 M** — no |
| 15 | 2 | 98 K — legal, and a table with no interior |

A 15-D `A2B` is only encodable at 2 points per axis. That has no interior at
all: it would exercise the plumbing and say nothing about interpolation.

This is also why real 15-channel profiles are almost always **PCS→device**. The
`B2A` direction keeps a 3-D input grid — 33³ resolves the gamut properly — and
only the output stride grows: 33³ × 15 is 538 K. That direction is not built
yet, and it is the one that matters, both because it is what such profiles
actually contain and because it exercises `Kernel3D`'s wide-output runs
(`fl_3_n`, `i_3_n`) — the same code path where the u16 wide-output gap was
found during the v1.6 kernel work.

---

## Reproducing

```bash
node scripts/make_test_profiles.js            # regenerate, deterministic
node scripts/make_test_profiles.js --check    # verify, write nothing
cd bench/lcms-comparison
node accuracy_gray.js        # 1 channel, kTRC profiles
node accuracy_nchannel.js    # 2-10 channels, device -> PCS
node accuracy_b2a.js         # 2-15 channels, PCS -> device, both depths
```

and the coverage matrix, which is an ordinary test:

```bash
npx jest channel_matrix                    # 225 combinations, does it work
node bench/channel_matrix/run.js           # 225 combinations, how fast
```

The profiles are ordinary ICC files. Open them in any inspector — a
third-party one confirmed the shared-tag layout (`A2B0`, `A2B1` and `A2B2` all
pointing at one offset) and the legacy 16-bit Lab encoding independently of
both engines.

**They say what they are.** Nothing about ICC bytes distinguishes a test
fixture from a profile somebody should assign to real artwork, and these are
committed. Both the description and the copyright tag carry *synthetic*, *test
profile*, *not for production*.

---

## See also

- [KernelContract.md](./KernelContract.md) — the kernel boundary these test
- `bench/channel_matrix/run.js` — the 225-combination throughput map
- [LcmsComparison.md](../LcmsComparison.md) — the RGB/CMYK oracle
- `__tests__/encodeICC.tests.js` — what the writer guarantees on its own
