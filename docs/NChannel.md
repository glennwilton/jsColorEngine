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

**Synthesise the profiles.** An n-channel device→PCS mapping plausible enough
to exercise the code paths does not need to be a real press. Build one from a
colour wheel:

1. Take HSB around 0–360°, and place the n colourants at their hue angles.
   Black sits at the origin, `0,0,0`.
2. Blend between adjacent colourants on the wheel to generate the mixes
   between them.
3. **Above L\*50**, blend toward zero ink — lighter means less of everything,
   converging on paper white.
4. **At or below L\*50**, blend toward a synthetically derived black: each
   chromatic channel at `1/(n-1)` of full, plus black. That gives a
   GCR-ish under-colour behaviour rather than a flat ramp, so the black
   generation logic actually gets exercised.

Bake that into a CLUT, write it as an ICC profile, and it is committable —
it is arithmetic, not a measurement of anyone's press.

**Then test both engines against it.** Same stimuli through lcms and through
jsColorEngine, same comparison the existing `lcms_compat` harness already
does for 1–4 channels. Neither engine is trusted a priori; agreement is the
signal, and disagreement is the interesting case — it would be the first
n-channel divergence either of us has looked at.

Two things fall out that are worth having regardless: a committable n-channel
profile set for the test suite, and the first real coverage of the generic
channel loop past 4 outputs, which today has no oracle at all (see
`__tests__/interp_reference.tests.js`).

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
