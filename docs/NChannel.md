# N-channel support (5CLR–15CLR) — implementation notes

> **Shipped 2026-08-15.** This page describes how N-channel profiles are
> supported as built. Tests: `__tests__/transform_nchannel.tests.js`,
> validated against the 7CLR press profile in `testbed/profiles/6col/`
> (Lab PCS, inks C M m Y K Or Bl, "straight black" separation).

Profiles with more than 4 device channels (hexachrome, 7-ink press,
spot-colour devices) load and transform in **both directions**. The design
trade-off, per the kernel-module architecture: N-channel is a
proof/measurement use case, not a 4K-image throughput path — so the input
direction is correct-not-fast, while the output direction gets the fast
baked-LUT path for free.

---

## What was added

### Profile loading (`src/Profile.js`, `src/def.js`)

- `eProfileType.NChannel` (value 31).
- The `header.space` switch accepts `5CLR`–`9CLR` and `ACLR`–`FCLR`
  (ICC uses hex digits for 10–15 channels), setting `outputChannels`
  accordingly. The existing LUT decoders already handled N-input CLUTs
  generically — including per-dimension `gridPoints` arrays (the 7CLR test
  profile carries a 5-point grid on each of its 7 A2B axes and a 33³ B2A).

### Pipeline (`src/Transform.js`)

- `NChannel` cases in `getProfileChannels` (channel count from the
  decoded header), `getInput2DevicePCSInfo` / `getDevice2OutputPCSInfo`
  (device encoding, like CMYK), and both pipeline builders
  (`createPipeline_Device_to_PCS`, `createPipeline_PCS_to_Device`) — the
  profile is LUT-based, so it joins the CMYK fall-through to the
  V2/V4 LUT builders.
- `addStageLUT` routes `inputChannels > 4` to the generic
  `tetrahedralInterpND_NCh` stage — a sorted-fraction simplex walk (the
  same algorithm as the dedicated 3D/4D kernels, generalised to N
  dimensions, honouring per-dimension grid sizes and
  `inputScale`/`outputScale`). The channel-count pre-gates that used to
  throw in the V2/V4 builders were removed; `addStageLUT` is the authority.
- Input codec stages: there is no named colour object for 5+ channels, so
  object formats accept **a plain device array (0..1)** or a
  **`{c0: v, c1: v, …}` object** (`stage_NCh_to_Device`); int8/int16 use
  the generic `stage_IntN_to_Device`. Output is a plain device array
  (`stage_device_to_NCh`), or integers via the existing generic
  `stage_deviceN_to_int`.
- `validatePipeline` builds an N-length mid-grey array for N-channel
  inputs and accepts a plain array as valid N-channel output.

### Kernel / LUT behaviour

- **N-channel OUTPUT (e.g. RGB→7CLR) with `buildLut: true` — supported
  and fast.** The input side is 3D, so `createLut()` bakes a normal
  (small) 3D grid with N output channels via the generic device-LUT
  builders, and the image path runs the existing `3D→NCh` array loop
  through Kernel3D. Integer mirror LUTs don't cover >4 output channels,
  so `lutMode: 'int'` falls back to the float CLUT kernel automatically
  (silent, by design).
- **N-channel INPUT (e.g. 7CLR→Lab) with `buildLut: true` — declined,
  falls back to the per-pixel pipeline** with a `console.warn`.
  `KernelND.provideLut()` returns `false`: a baked CLUT grows as
  `gridPoints^N` cells (a 17-pt 5D grid is ~11 MB at u16; 6D+ is
  hopeless), and the profile's own A2B grid is authoritative anyway.
  If a real workload ever needs image-rate N-channel input, the u16 N-D
  bake lands in `KernelND.provideLut()` (reduced grid density, stub LUT
  with `outputScale: 1/65535` — `tetrahedralInterpND_NCh` already honours
  the scales) and `KernelND.array()` runs it.

### A latent bug this exposed

The four `*_NCh` single-pixel interpolators (1D/2D/3D/4D) clamped raw
input to [0,1] **before** scaling by `gridEnd * lut.inputScale`. That is
correct for ICC LUTs (`inputScale: 1`, device 0..1 input) but silently
broke baked integer LUTs (`inputScale: 1/255`, raw u8 input — every pixel
sampled the black corner). The path was unreachable until N-channel
outputs existed, so 462 tests never caught it. Fixed by scaling first and
clamping in grid space — bit-identical for all previously reachable
inputs.

---

## Usage

```js
// Accuracy path, either direction:
const t = new Transform({ dataFormat: 'object', buildLut: false });
t.create(sevenColorProfile, '*lab', eIntent.relative);
t.transform([0, 0, 0, 0, 0, 0, 0]);        // → paper-white Lab
t.transform({ c0: 0, c1: 0, c2: 0, c3: 1, c4: 0, c5: 0, c6: 0 }); // K only

// Fast image path — N-channel OUTPUT:
const t2 = new Transform({ dataFormat: 'int8', buildLut: true });
t2.create('*srgb', sevenColorProfile, eIntent.relative);
t2.transformArray(rgbPixels, false, false); // 3 bytes in → 7 bytes out per px
```

## Validation status

No lcms reference numbers yet — the tests pin physical sanity: media
white → zero ink on every channel, Lab black → K-dominant straight-black
separation, zero ink → paper white (L≈100), full ink → near black, single
inks land in distinct hue directions, array and `{c0..cN}` inputs agree.
Tighten to ΔE tolerances when lcms validation numbers arrive.

### TODO: synthetic N-channel profiles, then lcms as the oracle

The blocker is not the harness, it is the *profiles*. Real n-colour press
profiles are licensed vendor artefacts that cannot be committed (see
[`bench/lcms_compat/profiles/README.md`](../bench/lcms_compat/profiles/README.md)),
so there is nothing to validate against that ships with the repo.

**Not the answer: a wider `_Master`.** `tetrahedralInterp3D_Master` is the
reference for the *unrolled* 3-D variants, and it works because it is
structurally different from them — helpers as separate functions rather than
inlined and hand-specialised. Widening it to cover 5+ output channels would
just be our generic implementation written a second time by the same hand.
Two copies of one idea share the blind spots of that idea. It would prove the
code matches itself, which is not the question. **`tetrahedralInterpND_NCh`
already is the reference-grade implementation** — there is no faster variant it
needs to be checked against, only an outside opinion.

**The oracle is Little CMS**, as it is for every other channel count in
[`bench/lcms_compat/`](../bench/lcms_compat/). What is missing is input.

#### The CLUT contents do not need to be plausible

The instinct is to synthesise a *believable* profile first. For validating
interpolation that is wasted effort: both engines walk the same table, and
whether that table describes a printable press or nonsense makes no difference
to whether they agree about walking it. **Fill it with noise or channel sweeps.**

The two are complementary, and both are worth running:

| fill | what it is good for |
|---|---|
| **Noise** — every cell independent | **Detection.** Any index error lands on an unrelated cell and shows up immediately as a wildly wrong value. A smooth table hides exactly this, because the neighbouring cell holds nearly the right answer and the output stays plausible. |
| **Channel sweeps** — one axis ramping per channel | **Diagnosis.** When something fails, a per-axis ramp says *which* axis and *which* channel is wrong, because the output is a readable function of the input. Noise tells you there is a bug; a sweep tells you where. |

This is the same reasoning `__tests__/interp_reference.tests.js` already uses
for the 3-D and 4-D comparisons, which fill their test CLUTs with random values
for precisely this reason. Nothing about it is n-channel-specific — it just
removes the profile problem entirely.

**It may not need an ICC profile at all.** lcms can build a pipeline from a CLUT
directly (`cmsPipelineAlloc` + `cmsStageAllocCLut16bitGranular`), so the native
harness in [`bench/lcms_c/`](../bench/lcms_c/) could hand both engines the same
generated table without anyone writing a profile encoder. Worth checking before
building one: it would reduce this task to a harness and a fill function.

#### A believable profile is a different test, and still worth having

The colour-wheel construction below answers a different question — not "do the
engines agree" but "does an n-channel separation behave like a separation". It
is what ΔE tolerances, black-generation checks and documentation illustrations
need, and it is committable for the same reason the noise fill is: arithmetic,
not a measurement of anyone's press.

1. Take HSB around 0–360°, and place the n colourants at their hue angles.
   Black sits at the origin, `0,0,0`.
2. Blend between adjacent colourants on the wheel to generate the mixes
   between them.
3. **Above L\*50**, blend toward zero ink — lighter means less of everything,
   converging on paper white.
4. **At or below L\*50**, blend toward a synthetically derived black: each
   chromatic channel at `1/(n-1)` of full, plus black. That gives GCR-ish
   under-colour behaviour rather than a flat ramp, so the black generation
   logic actually gets exercised rather than bypassed.

#### Both directions, and a round trip that needs no oracle at all

The same construction gives **A2B and B2A**, which matters because they are not
symmetrical problems:

- **A2B** is device → PCS. Every input is reachable: n channels of ink, all
  combinations valid, and the wheel construction above defines the whole
  domain.
- **B2A** is PCS → device, and most of its input space is *not reachable*. Lab
  is far larger than any printable gamut, so a B2A table indexed over the full
  space is mostly describing colours the device cannot make. Fill that with
  nonsense and the table tests the interpolator fine — but it tests nothing
  about gamut behaviour, and a round trip through it is meaningless.

So constrain the PCS side to something gamut-shaped. **Two cones base to base**
is the cheap approximation and close enough to a real gamut solid: chroma
collapses to zero at L\*0 and L\*100 and is widest in the middle.

```
Cmax(L) = C0 * (1 - |L - 50| / 50)        // C0 around 60-70
```

Inside that solid, map Lab back to ink by inverting the wheel — hue angle
selects the colourants, chroma sets how much, lightness drives the ink-to-black
blend from step 4. Outside it, clamp to the boundary, which is what a real B2A
does anyway.

Flattening `Cmax(L)` to a constant — `a`, `b` limited to ±50 — is the simpler
version and probably enough to start. It over-covers the light and dark ends,
where a real gamut has already pinched in, so a round trip near L\*5 or L\*95
will clamp rather than round-trip cleanly. That is a known and acceptable
artefact of the simpler shape, not a bug to chase.

**The payoff is a test with no external oracle.** With both tables built from
one construction, `device → A2B → Lab → B2A → device` should return
approximately what went in, for any starting ink combination inside the gamut.
That exercises both interpolators, both channel counts, the full pipeline and
the gamut clamp — and it is self-checking, so it needs neither lcms nor a
committed profile. Divergence is the signal, and the size of the divergence is
itself a measurement.

Round-trip identity is a weaker check than agreeing with lcms — an error that
is symmetric in both directions cancels — so it does not replace the oracle. It
does arrive much sooner and costs almost nothing.

#### Then test both engines

Same stimuli through lcms and through jsColorEngine, same comparison the
existing `lcms_compat` harness already does for 1–4 channels. Neither engine
is trusted a priori; agreement is the signal, and disagreement is the
interesting case — it would be the first n-channel divergence either of us has
looked at.

Order of work, cheapest first: noise fill and sweeps to get an oracle running
at all, then the colour wheel when appearance-level assertions are wanted.

## CLUT memory reference (why N-channel input LUTs are declined)

| Dimensions | 17-pt grid cells | f64 | u16 |
|---|---|---|---|
| 3D (RGB) | 4,913 | ~157 KB | ~39 KB |
| 4D (CMYK) | 83,521 | ~2.7 MB | ~668 KB |
| 5D (5CLR) | 1.4 M | ~45 MB | ~11 MB |
| 6D (6CLR) | 24 M | ~768 MB | ~192 MB |
| 7D (7CLR) | 410 M | 13 GB | 3.3 GB |

At 5D+ the only sane options are u16 + reduced grid density (9 or 11
points) — or, as shipped, don't bake at all and walk the pipeline.
