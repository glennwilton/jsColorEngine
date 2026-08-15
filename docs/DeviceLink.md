# DeviceLink support — implementation notes

> **Shipped 2026-08-15.** This page describes how DeviceLink profiles are
> supported as built. Tests: `__tests__/transform_devicelink.tests.js`,
> with two families of self-validating fixtures:
>
> - `testbed/profiles/lcms_testbed/` (LittleCMS-testbed generated):
>   `linlcms2.icc` — curves-only linearization link (parametric gamma 3.0,
>   verified as out = in³ exactly); `limitlcms2.icc` — CMYK→CMYK 150%
>   ink-limit link (lcms's algorithm reproduced: K preserved, CMY scaled
>   into the remaining budget).
> - `testbed/profiles/devicelink/` (Serendipity Software samples):
>   null CMYK→CMYK and RGB→RGB identities, plus asymmetric
>   `simple-cmyk-to-rgb` (4→3) and `simple-rgb-to-cmyk` (3→4, K-only
>   grey axis).

A DeviceLink (`pClass: 'link'`) is a complete device→device transform with
no PCS in the middle — the single `A2B` tag carries the whole conversion.

---

## Usage

```js
const dl = new Profile();
dl.load('MyDeviceLink.icc', () => {
    const t = new Transform({ dataFormat: 'int8', buildLut: true });
    t.create(dl);                       // the DeviceLink alone — nothing else
    const out = t.transformArray(pixels, false, false);
});
```

- The rendering intent comes from the **profile header** (the spec says
  the single A2B tag serves whichever intent is declared there); any
  intent argument is ignored.
- Passing further profiles alongside a DeviceLink throws — there is no
  PCS to link through.
- `buildLut: true` works (the baked LUT carries a single-profile chain);
  identity detection never collapses a link.

## How it works

### Profile loading (`src/Profile.js`)

- The `'link'` class passes the profile-class gate.
- **The header PCS field is not a PCS** — for links it carries the
  *output device space* (`'CMYK'`, `'RGB '`, `'5CLR'`, …). The Lab/XYZ
  PCS gate is skipped for links; the output space resolves to
  `profile.outputChannels`, while the header *space* field (the input
  side, as usual) resolves to `profile.deviceLinkInputChannels`.
  Asymmetric links (CMYK→RGB, RGB→CMYK) work.
- Links have no `wtpt` tag — the absolute-adaptation precompute is
  guarded on `mediaWhitePoint` being present (absolute intent doesn't
  apply without a PCS anyway).
- `profile.type` reflects the input space (e.g. `CMYK`); Transform
  branches on `header.pClass === 'link'`, not on type.

### Pipeline (`src/Transform.js`)

`createMultiStage` detects the link, strips the padded intent/output
slots that `create(dl)` produces, sets input/output channels from the two
header fields, and skips identity detection. `createPipeline` then calls
`createPipeline_DeviceLink` for the single-profile chain (the normal
profile-pair linking loop no-ops for a length-1 chain), bracketed by the
standard input/output format conversion stages.

`createPipeline_DeviceLink` walks the **full LUT element structure**,
device→device throughout — a bare CLUT stage is not enough in practice:

```
V2 mft1/mft2:  inputCurve → CLUT → outputCurve
V4 mAB:        aCurves → CLUT → mCurves → matrix → bCurves
```

Any element may be absent. Two spec subtleties handled here:

- A **curves-only mAB** (B-curves, no CLUT) is legal and is exactly what
  an lcms linearization DeviceLink is. The LUT decoder no longer crashes
  on CLUT-less tags (stride precompute is guarded), and the builder just
  emits the curve stage.
- **mft1/mft2 tags always contain a 3×3 matrix field**, but per ICC spec
  it applies only when the input side is PCSXYZ — never true for a link —
  so it is skipped for mft tags. Only mAB's M-matrix is a real stage.

### A curve-evaluation gap this exposed

`stage_curves_v4` could evaluate parametric curves with a `curveFn` and
sampled tables, but not **pure-gamma curves** (`para` function type 0, or
`curv` with count 1) — the decoder stores those as an inline `gamma`
exponent for speed, and no evaluator handled it (NaN). It now applies
`Math.pow(x, gamma)` when there is no table (sampled curves also carry a
midpoint `gamma` *hint*, so the table branch keeps priority).

## What did NOT need changing

| Area | Reason |
|---|---|
| LUT decoders (`mft1`, `mft2`, `mAB`, `mBA`) | A2B decodes normally (plus the CLUT-less guard) |
| Interpolation | Same tuned paths as any other LUT |
| Input/output format conversion | Link `type` reflects its device spaces — existing stages apply |
| `detectBlackpoint` / BPC / chromatic adaptation | Already guarded on `pClass 'link'` / PCS presence |
| Smoke test / validate, LUT bake | Work as-is once the pipeline is built |
