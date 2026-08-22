# N-channel support (5CLR–15CLR) — implementation notes

> **Shipped 2026-08-15** (load + both directions). 5CLR / 6CLR *input*
> gained int8 WASM scalar later. Tests:
> `__tests__/transform_nchannel.tests.js`,
> `__tests__/transform_lutMode_wasm_5d_6d.tests.js`. Validated against
> the 7CLR press profile in `testbed/profiles/6col/` (Lab PCS, inks
> C M m Y K Or Bl, "straight black" separation).

ICC allows 5–15 device channels (`5CLR`–`9CLR`, then `ACLR`–`FCLR`).
We load and transform all of them in both directions. The useful split
is not “n-channel vs CMYK” — it is **which way the pixels face**.

**Above 6 channels, the real job is print output *to* the device
colours** — Lab / RGB / CMYK → 7CLR…15CLR. That is a 3-D input with a
wide output stride. `Kernel3D` already owns it, `buildLut` bakes a
normal 17³ / 33³ table, and throughput is the 3-D kernel's problem, not
an N-D one. Supporting 15 channels there is correctness and completeness
(RIP separations, spot-ink recipes). It is **not a performance
priority**: nobody is pushing 4K Hexachrome+ at 100 MPx/s through this
engine, and a 15-ink B2A is still a 33³ walk.

Device → PCS for 7+ (a 7CLR proof back to Lab) exists and is correct.
It stays on `KernelND`, walks the profile's own A2B (typically 5 pts/axis
on a real 7CLR — see
[SyntheticProfiles.md § real grids](./deepdive/SyntheticProfiles.md#what-real-profiles-actually-use)),
and does not bake a second LUT or load WASM. That path is
preview / measurement, not an image kernel.

5CLR and 6CLR *input* are the exception: Hexachrome / 5-colour proofing
is common enough that `Kernel5D` / `Kernel6D` bake at the profile A2B
density and run **int8 JS + int8 WASM scalar**. No SIMD, no int16
kernel — every binary ships, and 16-bit HiFi input is not worth a
second ladder (~1.6× on a rare format). `dataFormat: 'int16'` still
works; it lands on the float LUT. 7–15 input does not get a kernel,
on purpose.

Full in × out × format matrix:
[KernelContract.md § Coverage](./deepdive/KernelContract.md#coverage--what-exists-per-kernel).

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

- **N-channel OUTPUT (e.g. RGB→7CLR, Lab→15CLR) with `buildLut: true` —
  supported and fast.** This is the print-to-device path and the reason
  7–15 exist. The input side is 3-D, so `createLut()` bakes a normal
  (small) 3-D grid with N output channels, and the image path runs the
  existing `3D→NCh` array loop through Kernel3D. Integer mirror LUTs
  don't cover >4 output channels, so `lutMode: 'int'` falls back to the
  float CLUT kernel automatically (silent, by design). Wide output is
  linear in channel count, not exponential; performance work here is
  not a priority.
- **5CLR / 6CLR INPUT (device→PCS) with `buildLut: true` — baked at the
  profile A2B density** (typically 9^5 / 7^6). `Kernel5D` / `Kernel6D`
  run int8 WASM scalar, JS int8 fallback. Do not up-res. Throughput
  probe: `bench/nch_56/run.js`.
- **7–15 INPUT (e.g. 7CLR→Lab) with `buildLut: true` — declined.**
  `KernelND.provideLut()` returns `false`; the per-pixel pipeline walks
  the profile's own A2B. Real 7CLR A2B is ~5 pts/axis, not a 17^7
  monster — we still do not bake or WASM that path. Correct, not fast.

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
t2.array(rgbPixels, false, false); // 3 bytes in → 7 bytes out per px
```

## Validation status

The hole this section used to describe — no committable n-channel
profile, so no second CMS — is **closed**. Journey and numbers:
[SyntheticProfiles.md](./deepdive/SyntheticProfiles.md).

| what | where | status |
|---|---|---|
| Writer + 15 dual-table files (`1CLR`–`FCLR`) | `encodeICC.js`, `Profile.createNChannelICC()`, `__tests__/profiles/synthetic_NNch.icc` | shipped |
| Every width into every width | `__tests__/channel_matrix.tests.js` — 225 pairs, both depths | shipped (does it run, not ΔE) |
| lcms, device → PCS | `bench/lcms-comparison/accuracy_nchannel.js` — 2–10 ch | shipped; residual tracks grid coarseness |
| lcms, PCS → device | `bench/lcms-comparison/accuracy_b2a.js` — 2–15 ch, int8 + int16 | shipped |
| Gray | `accuracy_gray.js` | shipped |
| 5/6 int8 WASM ≡ JS | `__tests__/transform_lutMode_wasm_5d_6d.tests.js` | shipped |
| Real 7CLR press file | `__tests__/transform_nchannel.tests.js` | physical sanity only (licensed; cannot commit) |

A2B vs lcms stops at 10 channels on purpose: 11–15 fixtures are 2 points
per axis and have no interior. B2A (3-D in) goes to 15.

**Still not the answer: a wider `_Master`.**
`tetrahedralInterpND_NCh` is the reference-grade walk. Checking it
against a second copy of itself would prove nothing. The outside
opinion is Little CMS.

### What we learned about fill (do not redo)

The first instinct in this TODO — fill with **noise** so index errors
cannot hide — is right when comparing two implementations of the *same*
scheme (`interp_reference.tests.js`). It is **wrong across engines**.
lcms and jsCE now share tetrahedral-on-last-three / linear peel, but
they still differ inside a cell. On noise that shows as ~144 LSB; on
the smooth ink model we shipped, ~6 LSB and the residual tracks grid
spacing, not a bug. Do not switch the committed profiles back to
noise.

`cmsPipelineAlloc` + a raw CLUT (skip the ICC writer) was the other
shortcut. We wrote the encoder instead, because a real file is what
both CMMs already consume and because `toICC()` is a product feature.

### Still open

1. **Promote the accuracy benches to a gate.** They are hand-run
   (`cd bench/lcms-comparison && node accuracy_nchannel.js`). Same
   shape as `bench/reproduce.js` — see Roadmap “Automated profile
   oracle”.
2. **Appearance-level synthetics.** `createNChannelICC()` uses a
   simple coverage → Lab ink model, good enough to walk. A colour-wheel
   + two-cone B2A (GCR-ish black below L*50, chroma pinched at the
   ends) would test whether a *separation* behaves like one, and would
   give a self-checking `device → A2B → Lab → B2A → device` round trip
   that needs no lcms. Weaker than the oracle (symmetric errors
   cancel); cheaper for black-generation / docs pictures. Not built.
   Not a blocker for 7–15 support.
3. **ΔE on a real 7CLR** against lcms. Needs a licensed file in a
   private corpus — the physical-sanity tests stay until then.

## CLUT memory reference

A 17-pt grid is what people quote for RGB / CMYK. It is **not** what
n-channel A2B tables use — see
[SyntheticProfiles.md § real grids](./deepdive/SyntheticProfiles.md#what-real-profiles-actually-use).
The 17-pt column is here so nobody proposes up-resing a 7CLR A2B to
match a CMYK bake:

| Dimensions | 17-pt cells | u16 at 17 | what real A2B uses |
|---|---|---|---|
| 3D (RGB) | 4,913 | ~39 KB | 17 or 33 |
| 4D (CMYK) | 83,521 | ~668 KB | 9 (Adobe) or 17 (i1P) |
| 5D (5CLR) | 1.4 M | ~11 MB | **9–11** — we bake this |
| 6D (6CLR) | 24 M | ~192 MB | **7–9** — we bake this |
| 7D (7CLR) | 410 M | 3.3 GB | **~5** (press profile on disk) — we walk it, no bake |

Output (PCS → device) never pays `grid^N`: the table is always 3-D in,
N out. That is why 7–15 are cheap to *support* and why they are not a
kernel project.
