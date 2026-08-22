# Why named colour profiles (`ncl2`) are not supported

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

Named colour profiles contain **only a list of colours**. They store a name-to-Lab/XYZ lookup table — nothing more. There is no conversion pipeline, no LUT, no matrix. Because there is nothing to *execute*, there is nothing for a CMM to do with them. They are outside the scope of colour transform support entirely.

---

## What they actually are

A named colour profile contains a single tag — `namedColor2` (`ncl2`) — which is a flat table. Every entry has:

- A **name** — a 32-byte ASCII string, e.g. `"PANTONE 485 C"`
- A **PCS value** — mandatory, always present — three u16 values in either PCSXYZ or legacy 16-bit PCSLab
- **Device coordinates** — optional; if present, u16 values per channel (e.g. four values for CMYK)

That is the entire format. No curves, no matrix, no LUT. The `ncl2` tag is a pure lookup table: you hand it a string, it hands back a PCS triplet and optionally some device channel values.

The device coordinate count is declared globally for the whole tag — every colour in the list has the same number of device coordinates (or none at all). You cannot have a partial mix.

### What they are not

A named colour profile cannot convert arbitrary colour. It has no AtoB or BtoA pipeline. If you want to convert an image, a gradient, or any continuous-tone data through a named colour profile, there is nothing to run. The spec itself describes them as "sibling profiles to device profiles" — they live alongside a device ICC profile, not in place of one.

The typical workflow for spot colour simulation illustrates the split clearly:

1. Look up `"PANTONE 485 C"` in the `ncl2` profile → get its Lab PCS value
2. Feed that Lab through the press's normal output ICC profile (BtoA LUT) → get CMYK

Step 1 is the named colour profile's job. Step 2 is the device profile's job. A CMM handles step 2; step 1 is just a dictionary lookup that any application can do without a CMM at all.

---

## History and why the format never caught on

The intent was sound: give spot colour names a device-independent colorimetric identity so that any application in the chain could reference the same ground truth rather than passing around device-specific CMYK recipes. A PANTONE 485 C defined as a Lab value is unambiguous; a CMYK recipe for it is only meaningful for one specific press, ink set, and substrate.

In practice the format was overtaken by better-established alternatives before it gained meaningful adoption:

**Proprietary colour libraries.** PANTONE operates a licensing model — every application that ships PANTONE colour data pays a per-application fee. The resulting libraries are embedded directly inside applications in proprietary formats, not distributed as ICC profiles. Adobe ships ACE-format swatch libraries (`.acb`, `.aco`, `.ase`); Quark, CorelDRAW, and others have their own equivalents. None of these are `ncl2` profiles.

**RIP-internal databases.** Where spot colour accuracy actually matters — at the point of output — the RIP handles it. Kodak Prinergy, EFI Fiery, Esko, and similar systems maintain their own licensed PANTONE libraries (often 15,000+ colours) as internal databases. The RIP intercepts the spot colour name from the PostScript or PDF job, looks it up internally, and routes it through the device profile. The ICC named colour profile format is not involved.

**CxF/X-4.** For packaging and brand colour management — where device-independent spot colour exchange between supply chain partners genuinely matters — the industry standardised on CxF/X-4 (Colour Exchange Format), an XML-based spectral format maintained by ISO. It carries full spectral data rather than just tristimulus values, handles metamerism, and is supported by X-Rite, Pantone Connect, and the major packaging prepress tools. `ncl2` never competed seriously here.

The result is that `ncl2` profiles are effectively absent from real workflows. They appear in some colour management utilities and were briefly surfaced as palette pickers in macOS ColorSync, but no major publishing or prepress application treats them as a standard interchange format.

---

## Summary

| Question | Answer |
|----------|--------|
| Do `ncl2` profiles convert colour? | No. They are lookup tables only. |
| Can they be mixed with conversion data? | No. The format has no pipeline elements at all. |
| Do they appear in real workflows? | Rarely. RIPs use internal databases; designers use application-native swatch formats. |
| Who holds the real spot colour data? | PANTONE (licensed per-app), RIP vendors, CxF/X-4 for packaging. |
| Why not support them? | There is nothing to execute — no transform to build or run. |
