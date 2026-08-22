# Why multiProcessElementsType (MPE) is not supported

**jsColorEngine docs:**
[← Project README](../../README.md) ·
[Bench](../Bench.md) ·
[Performance](./Performance.md) ·
[Roadmap](../Roadmap.md) ·
[Examples](../Examples.md) ·
[API: Profile](../Profile.md) ·
[Transform](../Transform.md) ·
[Loader](../Loader.md)

---

## Short answer

MPE tags (`DToB0–3`, `BToD0–3`) are **optional** in the ICC spec, vanishingly rare in real-world profiles, and the spec itself mandates a fallback. If a profile contains them, we fall back to the standard `AToB`/`BToA` tags, which every conforming profile must also include. Nothing breaks.

---

## What MPE actually is

`multiProcessElementsType` (`mpet`) is an ICC v4 tag type that encodes colour transforms using IEEE 754 **float32** throughout — curves, matrix, and CLUT — instead of the integer encoding used by `lut8Type`, `lut16Type`, `lutAToBType`, and `lutBToAType`. It was designed for:

- Scene-referred and HDR imagery where device values can go below 0 or above 1
- Higher precision than u8/u16 integers allow
- Arbitrary channel counts in the matrix element

The tags that use it are:

| Tag | Direction | Intent |
|-----|-----------|--------|
| `DToB0` | Device → PCS | Perceptual |
| `DToB1` | Device → PCS | Relative colorimetric |
| `DToB2` | Device → PCS | Saturation |
| `DToB3` | Device → PCS | Absolute colorimetric (direct, no mediaWhitePoint used) |
| `BToD0` | PCS → Device | Perceptual |
| `BToD1` | PCS → Device | Relative colorimetric |
| `BToD2` | PCS → Device | Saturation |
| `BToD3` | PCS → Device | Absolute colorimetric (direct) |

---

## Why you will essentially never encounter these

### ICC was built for print and desktop publishing

The ICC was founded in 1993 by Adobe, Agfa, Apple, Kodak, Microsoft, Silicon Graphics, Sun Microsystems, and Taligent — companies whose shared problem was colour consistency across scanners, monitors, and printers in desktop publishing workflows. The entire architecture reflects this: D50 as the PCS whitepoint, a reflection print as the perceptual reference medium, 8-bit and 16-bit integer encodings. ICC is fundamentally a **print and photography standard**.

### Video and film never adopted ICC

Motion picture, broadcast, and VFX built entirely separate colour management ecosystems:

- **ACES** (Academy Color Encoding System) — the scene-referred archival and exchange standard for film and TV
- **OpenColorIO (OCIO)** — the open-source CMM used across Nuke, Blender, DaVinci Resolve, Maya, and virtually every VFX and animation tool
- **CDLs and show LUTs** — the working tools for on-set and dailies colour

These workflows operate in float, handle HDR natively, and have no need for ICC profiles at any stage. Netflix, for example, routes everything through ACES and OCIO from camera to delivery without ICC touching the pipeline. The OpenColorIO documentation explicitly describes ICC profiles as "a rather print-specific technology."

### MPE was the ICC's attempt to close that gap — and it didn't land

MPE was added to the spec specifically to address float precision and HDR use cases. By the time it was standardised, the film and VFX world had already converged on OCIO and ACES, and had no reason to adopt a new ICC tag type. The print and photography world, meanwhile, had no need for float device values — their pipelines work perfectly with integer LUTs.

The result is that MPE tags exist almost exclusively in:

- The ICC's own diagnostic "probe profile" — a test tool for verifying CMM behaviour, not a production profile
- A handful of research and academic profiles

No major profiling software generates them. ArgyllCMS (the engine behind DisplayCAL and most open-source profiling), X-Rite i1Profiler, Barbieri, and Datacolor all produce standard `AToB`/`BToA` tags. Every real-world printer, display, and scanner profile you will encounter uses integer LUTs.

The ICC itself has since acknowledged the limitation and developed **iccMAX (ICC.2/v5)** for the use cases MPE was meant to address — targeting medical imaging, motion picture, fine art, and packaging. iccMAX is a substantially different format, not an ICC v4 extension.

---

## The fallback is spec-mandated, not a workaround

The ICC spec (§8.10.2) defines a strict tag precedence order:

1. Use `DToB`/`BToD` (MPE) if present **and the CMM supports it**
2. Fall back to `AToB`/`BToA` if MPE is absent or unsupported
3. Fall back to matrix + TRC if LUT tags are also absent

Critically, the spec also states (§10.16): *"If undefined processing element types are present in a multiProcessElementsType tag, the multiProcessElementsType tag shall not be used and fall back behaviour shall be followed."*

This means **any conforming ICC v4 profile that includes MPE tags is required to also include valid `AToB`/`BToA` tags**. The fallback is not a limitation — it is exactly what the spec prescribes for a CMM that does not implement MPE. LittleCMS, the most widely used ICC CMM, supports MPE; but the second most common result in testing is CMMs that correctly detect MPE, skip it, and fall through to AToB/BToA without any loss of correctness.

---

## Summary

| Question | Answer |
|----------|--------|
| Are MPE tags common in real profiles? | No. Essentially absent outside test/diagnostic profiles. |
| Which software generates them? | None of the major profiling tools. |
| Do video/film workflows use ICC profiles at all? | No — they use ACES, OCIO, CDLs, and LUTs. |
| Is the fallback to AToB/BToA correct behaviour? | Yes — explicitly required by ICC §8.10.2. |
| Does a profile with MPE still work? | Yes — the mandatory AToB/BToA tags are used instead. |
| Should we implement MPE in future? | Only if iccMAX (ICC.2) adoption becomes a goal; MPE itself is a dead end. |
