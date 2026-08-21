# `bench/lcms_compat/profiles/` — user-supplied ICC profiles

**This directory is gitignored** — ICC profiles are licensed
artefacts and most of what ships in a real prepress workflow cannot
be redistributed on a public GitHub repo. You supply your own
licensed copies here; the harness reads whatever is present.

See the parent [`../README.md`](../README.md) for the rationale.

## What the harness expects

Filenames must match what the reference set uses. The reference
`.it8` files in `../reference/` are named by the profile filename
they were generated against, so drop a profile in with the filename
below and the harness will pair it to the right reference file
automatically.

The canonical 29 profiles (the full set jsColorEngine was originally
developed and stage-compared against):

### RGB working spaces — matrix-shaper

| Filename                        | Canonical source |
|---|---|
| `sRGB_v4_ICC_preference.icc`    | [icc.org / Freely available ICC profiles](https://www.color.org/srgbprofiles.xalter) |
| `sRGB2014.icc`                  | [icc.org](https://www.color.org/srgbprofiles.xalter) |
| `sRGB Color Space Profile.icm`  | Microsoft Windows (in `C:\Windows\System32\spool\drivers\color\`) |
| `AdobeRGB1998.icc`              | Adobe (install via Adobe's Color Profile download page — licensed, not redistributable) |
| `AppleRGB.icc`                  | Apple / Adobe (ships with Adobe Color Suite) |
| `ColorMatchRGB.icc`             | Adobe |
| `ProPhoto.icm`                  | Kodak / Adobe |
| `WideGamutRGB.icc`              | Adobe |

### XYZ working spaces

| Filename          | Canonical source |
|---|---|
| `D50_XYZ.icc`     | Synthetic / ICC reference (D50 identity PCS) |
| `D65_XYZ.icc`     | Synthetic / ICC reference (D65 identity PCS) |

### CMYK press profiles

| Filename                        | Canonical source |
|---|---|
| `USSheetfedCoated.icc`          | Adobe (ships with Adobe Color Suite) |
| `USWebCoatedSWOP.icc`           | Adobe |
| `EuroscaleCoated.icc`           | Adobe |
| `EuroscaleUncoated.icc`         | Adobe |
| `USNewsprintSNAP2007.icc`       | [IDEAlliance](https://www.idealliance.org/resources/tools/) |
| `CoatedGRACoL2006.icc`          | [IDEAlliance](https://www.idealliance.org/resources/tools/) (CC-BY-ND typically) |
| `WebCoatedSWOP2006Grade3.icc`   | IDEAlliance |
| `WebCoatedSWOP2006Grade5.icc`   | IDEAlliance |
| `WebCoatedFOGRA28.icc`          | [ECI (European Color Initiative)](http://www.eci.org) |
| `UncoatedFOGRA29.icc`           | ECI |
| `ISOcoated_v2_bas.ICC`          | ECI |

### Grey profiles

| Filename                          | Canonical source |
|---|---|
| `ISOcoated_v2_grey1c_bas.ICC`     | ECI (1C grey from the ISOcoated v2 family) |

### Spot / N-channel profiles

| Filename                          | Canonical source |
|---|---|
| `RISO_MZ770_Black.icc`            | RISO (proprietary — obtain from RISO if you have the press) |
| `RISO_MZ770_RedGreen.icc`         | RISO (2C spot) |
| `RISO_MZ770_RedYellowBlue.icc`    | RISO (3C spot) |
| `RISO_MZ770_YellowBlueTeal.icc`   | RISO (3C spot) |

### Named-colour profile

| Filename          | Canonical source |
|---|---|
| `NamedColor.icc`  | ICC test / sample data — see `Sample_ICC_Profiles/` subdir |

### ICC sample set

The `Sample_ICC_Profiles/` subfolder contains `NULL.icc` and
`Sample_Profile.icc` from ICC.org's sample pack. These are
intentionally *redistributable* under the ICC's reference-data terms,
but in the interest of keeping one consistent rule ("`profiles/` is
gitignored, period"), they live here too rather than in a separate
`public-profiles/` directory. If you want the originals,
[icc.org](https://www.color.org/iccprofile.xalter) publishes them.

## What if I don't have all 29?

Fine. The harness reports `skipped` for any (profile, direction,
intent, bpc) combination where the profile isn't present, and runs
the rest. A CI run with only the freely-distributable profiles (the
ICC.org sRGBs, your OS's sRGB, D50/D65 XYZ, IDEAlliance press
profiles, FOGRA profiles under CC-BY-ND) will still exercise a
meaningful cross-section of the codebase.

The 2C/3C RISO MZ770 profiles are the *most valuable* entries for
catching N-channel regressions — if you have access to equivalent
spot-colour profiles from another vendor, the harness will happily
substitute them as long as the filename matches what's in
`../reference/`.

## Profile versioning — why filename alone isn't enough

The compat harness treats `filename → reference .it8` as its pairing
rule. But "AdobeRGB1998.icc" ships in several versions over the
years (Adobe has updated it occasionally). A stricter harness would
hash each profile at load time and fail if it doesn't match the hash
recorded when the reference set was generated.

Planned for v1.3 (once we extract the lcms patch and regenerate the
oracle): ship a `profile-hashes.json` alongside `reference/` that
records `{filename: sha256}` for every profile the oracle was built
against. Mismatch → loud warning, not silent wrong data.

## Gitignore

The parent `.gitignore` excludes this directory's contents except
for `README.md`. If you add profile files, they won't be tracked
unless you explicitly force-add (don't — they're licensed).
