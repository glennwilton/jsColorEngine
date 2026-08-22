# Testing

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Transform](./Transform.md) ·
[Synthetic profiles](./deepdive/SyntheticProfiles.md) ·
[LittleCMS comparison](./LcmsComparison.md)

Jest is the engine gate: `npx jest` (currently ~1010 tests, 41 files).
It is **not** a line-coverage map. The holes that have actually bitten
this engine were combinatorial — a missing `default` above 4 channels,
int16 wide output, an optimiser that concatenated `'stage_device' + N`
— and those lines were already “covered” by a 3-channel walk through
the same file. Do not gate on `jest --coverage`.

Accuracy against another CMS is `bench/lcms-comparison/`, not Jest.
Throughput is `node bench/mpx_summary.js`. This page lists **what Jest
asserts**, and **what it does not**.

---

## Run

```bash
npx jest                         # the gate
npx jest channel_matrix          # 225 widths, does it run
npx jest transform_guards        # array / ViaLUT / reformat / lastUsedKernel
```

Oracles (not Jest):

```bash
node scripts/make_test_profiles.js --check
cd bench/lcms-comparison
node accuracy_gray.js            # 1 ch
node accuracy_nchannel.js        # 2–10 ch, device → PCS
node accuracy_b2a.js             # 2–15 ch, PCS → device, both depths
```

---

## Features

One row per capability. The file column is where to look, not an
inventory of every `test()`.

| Feature | Tests | Notes |
|---|---|---|
| `useCurveLut` | `transform_features` | Table stages replace Math.pow; ≤1 LSB at int8 |
| Custom stages | `transform_features` | Inserted at PCS; baked into a LUT |
| BPC on ≠ off | `transform_features` | sRGB→GRACoL relative; matrix→matrix does not apply |
| `array()` of objects | `transform_features`, `transform_identity` 15b/15c | Colour conversion walks (`pipeline`); identity clones via `kernelIdentity` |
| 2D duotone | `transform_features`, `multicore` | `testbed/profiles/duo/RISO_MZ770_RedGreen.icc` |
| `transform()` objects / virtuals | `transform_virtual`, `transform_object_input`, `transform_dataFormat` | All five `dataFormat`s on the accuracy path |
| `array()` / `transformArray()` | `transform_data_as_arrays`, `transform_lut`, `transform_guards` | Native units; `outputFormat` goes through `Transform.reformat` |
| `transformArrayViaLUT` throws | `transform_guards` | Loud cousin of `array()` — no table → `'No LUT loaded'` |
| `lastUsedKernel` | `transform_guards` plus every successful batch test | `kernel1D`…`4D` / `kernelIdentity` / `matrix-shaper` / `pipeline` / `cache`. Channel-matrix asserts the route per cell (diagonal is identity). |
| Channel widths 1–15 | `channel_matrix` | 225 pairs, both depths; “does not throw”, not an lcms match |
| KernelND.array (out of band) | `channel_matrix` | `provideLut` declines; only reached with an attached table |
| Identity | `transform_identity`, `kernel_registry` | Same-file memcpy; `detectIdentity: false` |
| Matrix-shaper | `matrix_shaper_kernel` | Yield, decline, int8/int16, alpha, `compatibility('1.5')` |
| Kernel registry / `floatFor` | `kernel_registry` | Dense 0–15, both surfaces, int16 wide output |
| LUT modes + WASM 3D/4D | `transform_lutMode*` (8 files) | JS int, scalar, SIMD, int16 × 3D/4D |
| WASM memory | `transform_wasm_memory` | compact / release / bytes |
| Dispatch / init resolve | `transform_lutKernelTable` | Kernel picks its own image path |
| Alpha in the transform | `transform_lut`, `transform_lut_3ch_alpha`, WASM/shaper suites | preserve / fill / drop |
| `alpha` helpers | `alpha` | Premultiply/unpremultiply through a real conversion |
| Soft-proof / multi-stage | `transform_multistep` | RGB→CMYK→RGB |
| DeviceLink | `transform_devicelink` | Decode + known lcms links |
| N-channel (real 7CLR) | `transform_nchannel` | Lab↔7CLR, `buildLut` declined |
| Pixel cache | `pixelcache` | Neutrality, hits, n-ch input, safety |
| Worker pool | `multicore` | Sequential fallback, byte-identical, cancel, backpressure |
| Plugins | `plugin_identity`, `plugin_isolation` | Register, isolate, `t.use()` |
| LUT hooks | `transform_lut_hooks` | Input/output, order, composability |
| Gamut bake | `transform_lut_gamut` | `color` / `map` / none |
| `validatePipeline` | `transform_validate_pipeline` | Healthy + corrupt + `setLut` skip |
| `pipelineDebug` | `pipeline_debug` | Exists because nothing else turned it on |
| Invalid create | `invalid_transforms` | Unloaded profiles, bad intent, broken chains |
| Profile load | `profile_load_file`, `loader` | File / buffer / URL / registry |
| ICC decode / write | `decodeICC.smoke`, `encodeICC` | Parametric curves; gray + N-ch writers |
| Lab ↔ int16 | `convert_lab_int16` | v2/v4 encodings |
| Interpolators | `interp_reference` | Optimised vs reference; N-ch surfaces agree |
| LutBuilder + TIFF | `lutbuilder`, `lutbuilder_tiff` | JSON, `setLut`, signatures, CLI samples |
| `Transform.reformat` | `transform_guards` | int8/int16/float/device; does not guess Lab |

---

## Transform combos

Do not markdown the 15×15 grid. It already lives as a test.

| Axis | What Jest covers | What it does not |
|---|---|---|
| inCh × outCh | `channel_matrix`: 1–15 × 1–15, int8 + int16, LUT on, 3 pixels, no alpha | lcms ΔE (that is `accuracy_*.js`) |
| LUT vs walk | `lastUsedKernel` on RGB→RGB LUT, RGB→CMYK no LUT, identity, cache | Per-width ViaLUT vs walk |
| Alpha | 3D/4D LUT + shaper + WASM | n-ch fill/preserve |
| Object batch | `transform()` objects; identity `array()` clones (`kernelIdentity`); colour `array()` walks (`pipeline`) | |
| Same-file 3→3 / 4→4 **colour** | Identity only | Unmeasurable with the same file twice |

`transform.lastUsedKernel` is the cheap route assertion: kernel `name`,
or `'pipeline'` / `'cache'`. ViaLUT throws before `array()`, so a
missing table leaves the field unchanged.

---

## Gaps

Deliberately not Jest, for now:

| Feature | Where it lives | Why |
|---|---|---|
| `compile()` | `docs/deepdive/CompiledPipeline.md` | Bench/POC; future |
| `src/Spectral.js` | exported helper | Side helper, not the gate |
| Samples / ICCImage | `samples/` | MIT demos, not the gate |

Deliberately out of scope: named-colour (`ncl2`) profiles — nothing to
execute; see [namedColorProfiles.md](./deepdive/namedColorProfiles.md).
Line coverage of `Transform.js` — the unrolled loops would paint green
from a 3-channel case.

When you add a feature, add a row to the first table or admit it here.
When you add a combo axis, add it to the second table or to
`channel_matrix` — not a third copy of the 225 cells.

---

## File list

`__tests__/*.js` — 42 files. Names match the feature they own.
`transform_features.tests.js` is the option/gap file (`useCurveLut`, custom
stages, BPC, object `array()`, 2D duotone).
`__tests__/profiles/synthetic_01ch.icc` … `synthetic_15ch.icc` are the
channel-matrix fixtures; regenerate with
`node scripts/make_test_profiles.js`.
