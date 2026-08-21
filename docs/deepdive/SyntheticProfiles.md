# Synthetic profiles, and testing what you cannot buy

> **Status: gray, device→PCS (`A2B`) and PCS→device (`B2A`) built and passing
> 2026-08-22. B2A reaches all 15 channels.**

Most of this engine has never been compared against another colour management
system. Not because nobody thought to — because there was nothing to compare
*with*.

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

It still missed a bug in **four** interpolators at once.

`_3Ch`, `_4Ch` and both 4-D variants clamped their input to 0..1 *before*
applying the grid scale. With `inputScale` at 1/255 — which is what a LUT built
for an 8-bit pipeline uses — every value from 1 to 255 collapsed onto one grid
cell. `transform()` on a `buildLut: true` Transform returned a **constant
colour**, whatever you passed it. `[2,2,2]` for sRGB→AdobeRGB, for every input.

The suite could not see it, and the reason is worth stating exactly: it ran the
variants at `inputScale = 1`, where clamping to 1 is a no-op. It *also* had a
block at `inputScale = 1/255` — which only ever exercised `_NCh`, the one
variant that was already correct. Right functions at the wrong scale; right
scale with the wrong functions. Nothing covered the diagonal.

That is what a self-consistent test suite fails to catch: not carelessness, a
blind spot that is invisible from inside.

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
| `Profile.createNChannelICC()` | synthesise 2CLR–10CLR, device→PCS |
| `Profile.createNChannelB2AICC()` | synthesise 2CLR–15CLR, PCS→device |
| `scripts/make_test_profiles.js` | write them to `__tests__/profiles/` once |
| `accuracy_gray.js` / `_nchannel.js` / `_b2a.js` | hand them to lcms |

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
every tool and is wrong by a chromatic adaptation. Nothing crashes. The colours
are just quietly off.

Refusing to guess is the correct behaviour for a writer, and `toICC()` throws
rather than emitting one.

---

## Four bugs, found immediately

The oracle earned itself on its first runs. Three below; the fourth — int16
being unable to reach a wide profile at all — is in the B2A section, because
that is the run that found it.

**1. `transformArray()` returned `undefined` for every input above 4 channels.**
The per-pixel fallback switched on `inputChannels` with cases 1, 2, 3, 4 — and
no `default`. It allocated an output of the right length, filled none of it,
and returned it. Silently, for the entire N-channel range the engine
advertises. Nothing had caught it because nothing could: there were no
5-to-15-channel profiles to catch it with.

**2. The same path under-allocated the output by one element per pixel** when
`outputHasAlpha` was true and `preserveAlpha` false. It sized on `preserveAlpha`
alone while the loop writes an alpha slot for either.

That one had been invisible for a subtle reason: the path returned an *untyped*
`Array`, and writing past the end of one silently grows it. The bug only
surfaced when the same path started returning a `Uint8ClampedArray`, where the
overflow writes are dropped and the reads come back `undefined`. A latent
sizing bug hidden by a container choice.

**3. Which container came back depended on whether a LUT happened to be built.**
The LUT path returned typed arrays; the fallback returned a plain `Array`, so
callers could not rely on `.subarray()` or hand the result to `ImageData`. Now
`int8` and `int16` return typed arrays either way — and only those, because
`device` and the float formats carry 0..1 values that a `Uint8ClampedArray`
would round to 0 or 1 and destroy. `lutbuilder.tests.js` caught the first
version of that fix doing exactly that.

---

## The mistake worth keeping: noise versus smooth

The n-channel CLUTs started as **noise**, on reasoning taken straight from
`interp_reference.tests.js`:

> Random rather than smooth: a smooth ramp hides index errors, because a
> neighbouring cell holds nearly the right answer.

That is correct, and it is why that suite uses noise. Applied across engines it
was wrong, and expensively so — the first n-channel run reported **max 144 LSB,
mean 33.5**, which reads as catastrophic failure.

It was not. The two engines interpolate differently:

| | scheme |
|---|---|
| Little CMS | tetrahedral on the last 3 axes, linear on every extra one |
| jsColorEngine (then) | one Kuhn simplex across all n axes |

Both are exact at grid points and differ inside a cell. ICC mandates neither.
On a table of unrelated neighbours there is **no answer for two schemes to
converge on**, so the difference is unbounded. Same code, same profiles, smooth
table instead: **max 6, mean 0.18**.

The rule that falls out:

- **Noise, comparing an implementation to a reference of the same scheme.** A
  ramp hides index errors; noise exposes them. This is `interp_reference`.
- **Smooth, comparing across engines.** Noise amplifies a legitimate scheme
  difference into apparent catastrophe.

So the n-channel tables are a plausible ink model — coverage darkens, the first
two channels rotate hue, chroma collapses toward black as coverage rises. Not a
characterisation of anything real, but smooth, which is the property that makes
the comparison mean something. `opts.noise` restores the old behaviour for
self-consistency work, where it is once again the better choice.

---

## What the oracle can and cannot certify

It catches **structural** faults — index arithmetic, channel order, stride, Lab
encoding, a missing loop. Those show as tens of LSB and a mean in double
figures, which is exactly how bug 1 announced itself.

It **cannot** certify sub-LSB agreement while the schemes differ, and the gate
says so rather than pretending: max 8 LSB, mean 1. An order of magnitude clear
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

### The fourth bug: int16 could not reach a wide profile at all

The **first int16 run** threw:

```
lutKernelTable: fallback chain exhausted from "i16wsi_3_n" (no float fallback?)
```

`buildIntLut()` produces no table above 4 output channels. At int8 that is
harmless — the u8 ladder degrades to float. The u16 ladder had no float rung,
so **every `dataFormat: 'int16'` conversion into a 5-or-more-channel profile
died**, while the identical conversion at int8 worked.

The omission was inherited: the v1.3 dispatch table had no u16 float terminus,
and the v1.6 switch rewrite reproduced it faithfully — verified against a
560-case oracle, which is exactly why the bug survived the rewrite. An oracle
that asks "does the new code agree with the old code" cannot find a fault they
share.

The guard's reasoning was sound and its scope was not. "You asked for 16-bit
kernels and never built the table" is fair when a u16 run *exists*; above 4
output channels none does, and `u16Run` was already the float run. Float is a
legal landing point for an int16 mode because `outputScale` is folded to 65535
and the float run scales at call time.

The narrow case still throws, and the asymmetry with int8 — which falls to
float silently — is worth a second look. It is a different decision, and
nothing has demonstrated it wrong.

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
node accuracy_gray.js        # 1 channel
node accuracy_nchannel.js    # 2-10 channels, device -> PCS
node accuracy_b2a.js         # 2-15 channels, PCS -> device, both depths
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
- [LcmsComparison.md](../LcmsComparison.md) — the RGB/CMYK oracle
- `__tests__/encodeICC.tests.js` — what the writer guarantees on its own
