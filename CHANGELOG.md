# Changelog

All notable changes to jsColorEngine are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.2.0] — 2026-04-24

### Added — `lutMode: 'int-wasm-scalar'` and `'int-wasm-simd'`

Hand-written WebAssembly LUT kernels for the image hot path, both 3D
and 4D (`src/wasm/tetra{3,4}d_{nch,simd}.wat` / `.wasm.js`,
base64-inlined so they load synchronously in any JS environment —
no XHR, no fetch, no bundler config).

- **`'int-wasm-scalar'`** — bit-exact against the JS `'int'` kernel
  across the 12-config matrix. 1.22–1.45× over `'int'` on x64;
  demotes to `'int'` if WebAssembly is unavailable.
- **`'int-wasm-simd'`** — channel-parallel v128 kernel for 3D and 4D
  tetrahedral LUTs. 2.04–3.50× over `'int'` on x64; bit-exact against
  both `'int'` and `'int-wasm-scalar'`. Demotes through
  `'int-wasm-scalar'` → `'int'` on hosts without SIMD / WASM.

Kernel cache (`wasmCache`) compiles each `.wasm` module exactly once
per process, shared across all Transforms.

### Changed — `lutMode: 'auto'` is the new default

Previously `lutMode` defaulted to `'float'`. v1.2 introduces
`'auto'` as the default, which resolves at construction time based
on `(dataFormat, buildLut)`:

- `dataFormat: 'int8'` + `buildLut: true` → `'int-wasm-simd'` (with
  the standard SIMD → scalar WASM → JS `'int'` demotion chain
  running at `create()` time for older hosts)
- anything else → `'float'` (lutMode is ignored for non-int8
  dataFormats anyway — resolving to `'float'` makes
  `xform.lutMode` self-documenting about what actually runs)

**Migration:** existing code that didn't set `lutMode` keeps working
unchanged and transparently gets the SIMD kernel on int8+LUT
transforms. Code that needs bit-stable `'float'` behaviour (colour
measurement, CI benchmarks, regression suites) should pin
`lutMode: 'float'` explicitly. Inspect `xform.lutMode` after
construction to see the resolved kernel, and `xform.lutModeRequested`
to see what the caller asked for (`'auto'` for the default,
otherwise the pinned value).

Unknown / future `lutMode` values (typos, code written against a
later release) now auto-resolve the same way `'auto'` does, giving
forward-written code the best-available kernel for its
`(dataFormat, buildLut)` combination instead of silently falling
through to `'float'`. Verbose mode logs a warning on unknown
values.

### Added — native lcms2 benchmark harness (`bench/lcms_c/`)

Companion to `bench/lcms-comparison/bench.js` that measures **native**
(non-wasm) lcms2 using the same methodology — same profiles, same
65k-pixel seeded PRNG input, same 300-iter warmup + median-of-5
timing loop. A one-shot `make` compiles all ~27 lcms2 source files
directly into the benchmark binary (no autotools, no `liblcms2-dev`,
no `configure`). Tested under WSL2 (gcc 10.5) and MinGW-w64.

**Headline measurement** (WSL2 Ubuntu 20.04 on Windows 11, gcc 10.5
with `-O3 -march=native`, `taskset -c 0`, Intel x86_64):

| Workflow | jsCE `int` (pure JS) | lcms2 native | jsCE / native |
|---|---|---|---|
| RGB → Lab    | 64.5 MPx/s | 62.7 MPx/s | 1.03× (tied) |
| RGB → CMYK   | 54.2 MPx/s | 60.3 MPx/s | 0.90× (native +11 %) |
| CMYK → RGB   | 53.2 MPx/s | 36.1 MPx/s | **1.47× (jsCE +47 %)** |
| CMYK → CMYK  | 43.6 MPx/s | 31.0 MPx/s | **1.41× (jsCE +41 %)** |

`lutMode: 'int'` beats native vanilla lcms2 on 3 of 4 workflows in
pure JavaScript. With the v1.2 default (`'int-wasm-simd'`) added in
the row above: all 4 workflows, 2–5× faster than native lcms2.

The measurement also **replaces the earlier `wasm × 1.5–2.5`
estimate** in `docs/Performance.md § 4` — reality is `native ≈
lcms-wasm × 1.4–1.6` on this profile/CPU. The estimate was
optimistic at the top of the band; modern V8 compiles wasm32 more
tightly than the original Emscripten rule-of-thumb assumed.

Reproduce on any machine with a C toolchain in ~5 minutes from a
fresh WSL2 install; see `bench/lcms_c/README.md` for the full
walkthrough.

### Added — browser benchmark (`bench/browser/`, `docs/Bench.md`)

Zero-dependency in-browser benchmark for every `lutMode`, measured
against `lcms-wasm` (LUT and no-LUT) on RGB→RGB / RGB→CMYK /
CMYK→RGB / CMYK→CMYK and a Lab→device→Lab accuracy-sweep on
jsColorEngine's f64 pipeline. `node bench/browser/serve.js` and
open the printed URL. Summary cards, per-direction charts, ΔE76
statistics, markdown-copyable results. See `docs/Bench.md` for the
full guide.

### Documentation

- New [Deep dive](./docs/deepdive/) section with subpages for
  architecture, JIT inspection, LUT modes, and WASM kernel design.
- `docs/Performance.md` restructured around "where we are / what we
  learned / where we're going".
- `docs/Bench.md` consolidates the browser-bench user guide.
- Top-level nav bar added to every docs page.
- README refocused as an overview + getting-started guide; heavy
  technical content moved to Deep dive / Performance.

---

## [Unreleased] — Roadmap

See [docs/Roadmap.md](./docs/Roadmap.md) — single source of truth
for forward-looking plans (v1.3 16-bit I/O, v1.4 non-LUT pipeline
code generation + smarter `'auto'` via per-Transform microbench,
v1.5 optional S15.16 lcms parity, v2 package split, browser
samples, the "explicitly not doing" list).

This section stays short on purpose. Anything measured, specified,
and scoped lives in Roadmap.md. When a version ships, its entry
lands above this section with a dated heading; the corresponding
roadmap item gets marked shipped and cross-linked here.

---

## [1.1.0] — 2026-04

The headline change in v1.1 is the new **`lutMode` option** — an opt-in
integer-math hot path for image LUT transforms. All four 3-/4-channel
image directions (RGB→RGB, RGB→CMYK, CMYK→RGB, CMYK→CMYK) are
accelerated with u16 mirror LUTs and `Math.imul`-based kernels,
typically 10–25% faster than the float kernels and using 4× less LUT
memory, with **≤ 1 LSB drift** on u8 output (well below JND, and
effectively bit-exact on RGB→RGB at 100 % match).

**Fully backwards-compatible with `1.0.5`** — `lutMode` defaults to
`'float'` (the existing kernels, bit-stable across releases). Existing
code keeps working with no changes; opt in per-Transform when you want
the speedup.

### Added — direct comparison with `lcms-wasm`

v1.1 also adds a full head-to-head benchmark harness against
[`lcms-wasm`](https://www.npmjs.com/package/lcms-wasm) v1.0.5 (a WASM
port of LittleCMS 2.16), living in
[`bench/lcms-comparison/`](./bench/lcms-comparison) as an isolated
side-project with its own `package.json`. It measures both
**throughput** (same-machine Mpx/s) and **8-bit output accuracy**
(systematic 9^N grid + named reference colours) across all four
standard image workflows.

- **Speed.** `lutMode: 'int'` measures **1.48–2.12× faster than
  `lcms-wasm`** (HIGHRESPRECALC, with pinned heap buffers for lcms —
  the fastest fair setup) on Node 20 / V8 / x64. Even `lutMode:
  'float'` beats `lcms-wasm` on every workflow (1.28–1.96×).
- **Accuracy.** ≤ 1 LSB agreement on 98.51 – 100 % of samples across
  all four workflows against `lcms-wasm`. Max outlier is a 14 LSB
  CMYK → RGB gamut-clipping disagreement on 0.93 % of samples (out-
  of-gamut inputs where both CMS engines are "inventing" a legal RGB
  answer from an illegal CMYK request) — documented as a hypothesis
  in `README.md` and `docs/Performance.md`.
- **Why pure-JS can beat a WASM-wasm32 port.** Detailed in
  `docs/Performance.md` under "Why pure-JS can beat an Emscripten-
  wasm32 port": hand-tuned V8 kernels (TurboFan, monomorphic, L1i-
  resident), no JS↔WASM FFI per call, no WASM-sandbox bounds checks,
  and a bundle that's **~2.5× smaller over the wire** (~52 KB gzip
  for one file vs `lcms-wasm`'s ~129 KB gzip across a JS shim + a
  separate `.wasm` payload).
- **Roadmap implication.** The v1.3 WASM-scalar work is now framed as
  "overtake native vanilla lcms2", not "catch up to lcms-wasm".

### Added — `lutMode` option

```js
const t = new Transform({
    dataFormat: 'int8',     // image hot path (Uint8ClampedArray in/out)
    buildLut:   true,       // pre-build the LUT
    lutMode:    'int'       // 'float' (default) | 'int'
});                          // future: 'wasm-scalar' | 'wasm-simd' | 'auto'
t.create('*srgb', cmykProfile, eIntent.relative);
const out = t.transformArray(rgbBuf);
```

The string-enum API was chosen specifically so v1.2+ can add WASM
kernels without changing the constructor signature. Unknown values
(e.g. `lutMode: 'wasm-scalar'` against this version) fall through to
`'float'` rather than crashing — write the code now, get the speedup
when you upgrade.

### Added — `lutMode: 'int'` kernels (all four 3-/4-channel directions)

| Direction        | LUT shape | Kernel        | Speedup    | Max diff vs float |
|------------------|-----------|---------------|------------|-------------------|
| RGB → RGB / Lab  | 3D 3Ch    | integer       | ~1.05-1.15×| **0 LSB** (100 % exact) |
| RGB → CMYK       | 3D 4Ch    | integer       | ~1.04-1.1× | ≤ 1 LSB (u8)      |
| CMYK → RGB / Lab | 4D 3Ch    | integer (u20) | ~1.15-1.25×| ≤ 1 LSB (u8)      |
| CMYK → CMYK      | 4D 4Ch    | integer (u20) | ~1.05-1.15×| ≤ 1 LSB (u8)      |

The residual 1 LSB on the CMYK / non-identity directions is
banker's-rounding-vs-half-up disagreement at exact half-ties
(`Uint8ClampedArray` rounds 0.5 to even; the integer kernel rounds
half up). It is not accumulated interpolation error — the math is
otherwise match-to-u16-CLUT-exact.

4D directions beat 3D on speedup — the float K-LERP does more
redundant rounding work, so the integer kernel wins more there. Real
numbers from `bench/mpx_summary.js` (Node 20 / V8 / x64, GRACoL2006
ICC profile): RGB→RGB **72 MPx/s** (vs 69 float), RGB→CMYK **62
MPx/s** (vs 56 float), CMYK→RGB **59 MPx/s** (vs 51 float),
CMYK→CMYK **49 MPx/s** (vs 45 float). Exact throughput is engine-
and hardware-specific — see the "Speed" section in the README for
why these numbers drift between V8 / SpiderMonkey / JSC releases.

The "off by ≥16" regression indicator is 0 across all four directions
on 65k random pixels.

### Fixed — u16 CLUT scale (systematic +0.4 % high bias, CMYK→RGB)

`buildIntLut` was scaling the mirror CLUT by **65535** (`float × 65535`).
The kernels divide u16 back to u8 via `(u20 + 0x800) >> 12`, which is
effectively `u16 / 256` — but `65535 / 255 = 257`, not 256. So every
path through the integer kernel produced values ~0.4 % higher than
the float reference. On profiles where output lands on fractional u8
boundaries (most real CMYK→RGB conversions via GRACoL→sRGB) this
showed up as up to **75 % of channels off-by-1 with 100 % of errors
going `int > float`**.

**Fix**: scale by `65280 = 255 × 256` instead. Now `u16 / 256` gives
`u8` exactly for any value in the CLUT. No kernel changes, no perf
hit. Intermediate CLUT precision drops from 16.00 bits to 15.994 bits
— a 0.006-bit loss that's invisible at u8 output. See
`bench/diag_cmyk_to_rgb.js` for the diagnostic trail that tracked
this down.

### Fixed — Q0.16 `gridPointsScale_fixed` (remaining CMYK→RGB bias)

`gridPointsScale_fixed` was stored in Q0.8 (e.g. `32` for a 33-point
grid), but the *true* ratio is `32/255 × 256 = 32.125`. The 0.125
truncation meant every per-axis fractional weight (rx / ry / rz / rk)
was slightly *lower* than the float kernel's. On CMYK→RGB LUTs —
which are monotonically **decreasing** along CMY axes — a smaller rx
means less of the negative `(a - c0)` delta gets applied, so the int
output stays systematically higher than float. That accounted for the
*second* 99.9 % directional-bias wave after the 65280 fix.

**Fix**: promote `gridPointsScale_fixed` to **Q0.16** (e.g. `8224` for
a 33-point grid). Kernels extract `X0 = px >>> 16` and
`rx = (px >>> 8) & 0xFF` instead of `>>> 8` / `& 0xFF`. Overflow-safe:
`u8 × ~8224 ≈ 2 M`, well under i32. Combined with the CLUT-scale
fix this took CMYK→RGB from 26 % exact / 3 LSB max to **97.6 % exact
/ 1 LSB max** on real profiles.

### Added — LUT format tags (`dataType`) + `isIntLutCompatible()` helper

Both LUT variants now carry explicit format metadata under a common
field name so `console.log(transform.lut)` reveals exactly what kind
of bytes the CLUT holds:

```js
// Outer float LUT (produced by createLut)
lut = {
    dataType: 'f64',         // Float64Array CLUT, values in [0, 1]
    encoding: 'number',      // serialisation format (pre-existing — 'number' | 'base64')
    version: 1,              // pre-existing — outer LUT format version
    /* ...existing CLUT, chain, grid, precision, outputScale, etc. */
};

// Integer mirror LUT (produced by buildIntLut when lutMode: 'int')
lut.intLut = {
    version: 1,              // bump when ANY field below changes
    dataType: 'u16',         // Uint16Array CLUT (aligns with outer lut.dataType)
    scale: 65280,            // u16 value representing 1.0 (= 255 * 256)
    gpsPrecisionBits: 16,    // Q0.N precision of gridPointsScale_fixed
    accWidth: 16 | 20,       // accumulator width (20 for 4D single-rounding)
    /* ...existing CLUT, maxX/Y/Z/K, channel counts, etc. */
};
```

Note: the outer LUT's `encoding` field is **not** the data type — it's
a pre-existing serialisation-format flag (`'number' | 'base64'`) used
by `setLut()` when rehydrating a JSON-saved LUT. We deliberately did
not overload it. New LUT types (f32, f16, bf16, custom fixed-point)
should add themselves under `dataType`, not `encoding`.

Plus a new `Transform#isIntLutCompatible(intLut)` method that validates
the integer LUT tag against the current release's kernel contract.
The outer float LUT is not checked because the contract ("`Float64Array`
with values in [0, 1]") cannot drift without other code changes
catching it first.

**Why this exists today** (when nothing serialises `intLut` yet):

* `buildIntLut()` is the only producer in v1.1, so the tag is a
  no-op for the in-process path.
* BUT v1.2 will land WASM kernels that expect a **different** CLUT
  encoding (likely pre-biased for `+ 0x80` elimination — see
  "Candidate optimisation" above) and/or Q15.16 for SIMD.
* If any future code — custom cache, persisted pipeline, cross-version
  upgrade path, test fixture, user-supplied precomputed LUT — hands
  a foreign `intLut` to the kernels without checking, a silent wrong-
  pixel failure is both easy to cause and hideous to diagnose.
* Stamping the tag now (and writing tests that assert it) makes the
  contract explicit and means future-us pays ~zero cost to add a
  compatibility check at any deserialization boundary.

The array dispatcher (`transformArrayViaLUT`) calls
`isIntLutCompatible()` **once per array call** (not per pixel) and
**throws** on mismatch. The cost is amortised to zero against the hot
loop. Silent fallback was explicitly rejected: if the integer kernel
runs against a CLUT whose scale or gps-precision disagrees with its
hardcoded shift/bias constants, the output looks plausible but carries
an elevated LSB error rate that is almost impossible to spot without a
pixel-level diff against the float path — the worst possible failure
mode in a colour pipeline. Loud throw beats silent drift.

This guardrail is also the safety net for anyone calling
`transformArrayViaLUT` directly with a hand-built or cached `intLut`.

### Design policy — float OR u16 only (never u15 / u24 / etc)

Going forward, the LUT representation is either **Float64Array**
(full precision, `lutMode: 'float'`) or **Uint16Array** (integer hot
path, `lutMode: 'int'`). We deliberately won't add intermediate
widths like u15 (which was briefly considered to avoid u16 overflow
in interp). Reasons:

* WASM (v1.2+), Web Workers, and any future GPU path can all consume
  float64 or u16 directly — no data rewrite at the backend boundary.
* We always need a JS fallback. If the fallback stores a u15 LUT
  that no other backend understands natively, every transition costs
  a conversion pass.
* u15 buys ~1 bit of kernel headroom but costs API clarity forever.

The u16 scale is `255 × 256 = 65280` (see "Fixed — u16 CLUT scale"
above) specifically so the u8-output round-trip is exact with no
extra math in the kernel. For v1.2's u16 **output** we'll revisit —
either widen the CLUT build to full 65535 for that path or accept
the 0.4 % range loss. Decision deferred to v1.2.

### Added — 4D u20 single-rounding kernels (CMYK input, accuracy refactor)

The original 4D integer kernels had four stacked `>> 8` rounding steps
(K0 plane, K1 plane, K-LERP, final u8) and were drifting up to 3 LSB
vs the float reference on CMYK→CMYK.

The 4D kernels now carry intermediate interpolated values at **u20
(Q16.4) precision** — 4 extra fractional bits above the u16 CLUT —
which collapses the three inner rounding steps into one final `>>20`
operation. The math is inlined (no `sum` temp) to keep the JIT from
spilling intermediates:

```js
// u20 intermediate, inner rounding is negligible (1/4096 LSB of u8):
o0 = (c0 << 4) + ((imul(a - c0, rx) + imul(b - a, ry) + imul(d - b, rz) + 0x08) >> 4);
// Final: K1 plane interp inlined into K-LERP, one meaningful rounding:
output = ((o0 << 8) + imul(((k0 << 4) + ((inner_K1 + 0x08) >> 4)) - o0, rk) + 0x80000) >> 20;
```

Why u20 and not u22/u24: the K-LERP `imul(K1 - o0, rk)` would overflow
signed int32 at those widths. u20 leaves ~2 bits of headroom below
2^31 while still giving 16× the inner-rounding resolution of the old
`>> 8` path.

**Accuracy impact** (measured on GRACoL2006, 65k random pixels;
numbers are after the u20 refactor AND the u16-CLUT-scale / Q0.16 gps
fixes above — the three together are what got us to bit-near-exact):

- CMYK → CMYK: was 55 % exact / 3 LSB max → now **99.74 % exact / 1
  LSB max** (zero channels off by ≥2).
- CMYK → RGB: was 26 % exact / 3 LSB max → now **99.63 % exact / 1
  LSB max** (zero channels off by ≥2).

**Bonus**: also fixed a pre-existing rounding-bias bug in the
degenerate `rx==ry==rz` K-LERP branch (`+0x80` was wrong for `>> 16`;
correct bias is `+0x8000`). Contributed a ≤1 LSB drift on pixels that
landed on the diagonal.

3D kernels are untouched — they already had a single inner rounding
step and ≤2 LSB accuracy budget.

The integer path also uses **4× less LUT memory** (Uint16Array instead
of Float64Array), which matters more for 4D LUTs (a typical CMYK→CMYK
LUT drops from 2.6 MB to 650 KB).

NOT recommended for color-measurement workflows (delta-E vs reference
patches). For that, use `lutMode: 'float'` (the default).

### Added — implementation pieces

- `Transform.buildIntLut(lut)` — builder method called automatically
  from `create()` when `lutMode: 'int'` AND `dataFormat: 'int8'`.
  Mirrors the float CLUT into a `Uint16Array`, computes Q0.8 grid
  scale and per-axis maxima (including `maxK` for the K-axis boundary
  patch). No-ops silently on unsupported shapes (1D / 2D / 5+ output
  channels), so enabling `lutMode: 'int'` globally is always safe.
- `tetrahedralInterp3DArray_3Ch_intLut_loop` — integer sibling of the
  float 3D 3Ch kernel. RGB→RGB / RGB→Lab. Reads from u16 LUT, uses
  `Math.imul` + Q0.8 weights. u8 in, u8 out.
- `tetrahedralInterp3DArray_4Ch_intLut_loop` — same for RGB→CMYK.
- `tetrahedralInterp4DArray_3Ch_intLut_loop` — 4D variant for CMYK→RGB
  and CMYK→Lab. Uses u20 Q16.4 intermediate with single-step final
  rounding (see "4D u20 single-rounding kernels" above). Includes
  K-axis early-out (`rk === 0` or `inputK === 255`) and full C/M/Y/K
  boundary patches.
- `tetrahedralInterp4DArray_4Ch_intLut_loop` — same u20 design for
  CMYK→CMYK.
- `__tests__/transform_lutMode.tests.js` — 8 tests covering all four
  directions, `lutMode` option parsing, and alpha preservation in both
  3D and 4D kernels.
- `bench/fastLUT_real_world.js` — real-world bench asserting the
  integer kernel as active for all four directions with the GRACoL2006
  ICC profile.

### Internal — dispatcher

`transformArrayViaLUT` now has `lutMode === 'int' && lut.intLut`
branches for **both** the 3D (3Ch input) and 4D (4Ch input) switches.
Each branch falls through to the existing float kernel for unsupported
output channel counts (5+) so the API surface is forgiving — adding
new profile types won't crash, they just use the float path.

### Documentation

- `docs/Performance.md` — full performance findings, lcms2/babl
  comparison, WASM POC results, roadmap rationale. Explains JIT-driven
  engine variance (V8 vs SpiderMonkey vs JSC) and why the hot loops
  are deliberately unrolled and inlined despite looking counter-intuitive.
- `bench/wasm_poc/` — runnable proof-of-concept comparing JS vs WASM
  scalar vs WASM SIMD for a 1D linear interpolation kernel. Drives the
  v1.3/v1.4 roadmap.
- README: new "How it works" note on the unrolled-and-inlined
  interpolator design + JIT-variance caveat on the speed numbers.

---

## [1.0.5] — 2026-04

A documentation + correctness pass across the codebase, plus packaging
fixes that resolve every open issue on the GitHub tracker. No public API
changes; all fixes are backwards compatible.

### GitHub issues addressed

- **Closes [#1](https://github.com/glennwilton/jsColorEngine/issues/1)** —
  documented `buildLut` (was silently dropped due to a `builtLut` typo,
  now aliased — see "`{ buildLut: true }` was silently dropped" below)
  and added a runnable canvas round-trip example in the README that
  shows the missing `ctx.createImageData()` + `data.set()` step that
  tripped the original reporter.
- **Closes [#2](https://github.com/glennwilton/jsColorEngine/issues/2)** —
  `ReferenceError: self is not defined` when `require('jscolorengine')`
  in Node. Two fixes layered for safety:
    1. The package's `main` field now points at the raw CommonJS source
       (`src/main.js`) instead of the webpacked UMD bundle, so Node
       consumers skip the bundle entirely.
    2. The webpack UMD wrapper itself is now Node-safe via
       `output.globalObject: "typeof self !== 'undefined' ? self : this"`
       (Webpack 5's default of `'self'` was the original cause).
  Anyone who was previously deep-importing `'jscolorengine/build/jsColorEngine.js'`
  to dodge this can stop doing that — both paths work.
- **Closes [#3](https://github.com/glennwilton/jsColorEngine/issues/3)** —
  "How do I use it in Angular?" Same root cause as #2 (Angular's SSR /
  zone.js builds were hitting the bundle's `self` reference). With #2
  fixed, the package now imports cleanly under Angular, Next.js, Vite,
  Webpack, and any other modern bundler. Added a "Bundlers" section to
  the README confirming this and explaining why the `browser` field's
  `fs`/`path`/`util` stubs are still needed.
- **Closes [#4](https://github.com/glennwilton/jsColorEngine/issues/4)
  and [#5](https://github.com/glennwilton/jsColorEngine/issues/5)** —
  `jsColorEngine.color is undefined`. The `color` alias for the
  `convert` module was added to source on 2024-01-13, but only made it
  into the published `1.0.4` bundle (the day after) — versions
  `1.0.0`–`1.0.3` shipped without it, so any user who installed during
  the first week saw the README example fail. Added a "Compatibility
  note for old installs" section to the README pointing affected users
  at either `npm i jscolorengine@latest` or the original
  `jsColorEngine.convert.Lab(...)` spelling.

### Fixed

#### Packaging

- **`main` repointed from `build/jsColorEngine.js` to `src/main.js`.**
  The bundle existed primarily for browser drop-in via `<script>`; using
  it as the Node entry was the source of issue #2. Tests, docs, and
  internal `require()`s already used `src/`, so this is a no-op for
  every internal call site.
- **Webpack UMD wrapper made Node-safe** with `output.globalObject:
  "typeof self !== 'undefined' ? self : this"`. The bundle in `build/`
  is now usable from Node, web workers, classic browser globals, and
  AMD loaders (the bundle previously crashed in any non-`self` host).
  See [issue #2](https://github.com/glennwilton/jsColorEngine/issues/2).

#### `src/Transform.js`

#### `src/Transform.js`

- **`preserveAlpha` was broken in RGB→RGB / RGB→Lab LUT image transforms.**
  In the inlined `tetrahedralInterp3DArray_3Ch_loop` kernel (3D LUT,
  3-channel input → 3-channel output — used for sRGB→sRGB soft-proof
  chains, abstract Lab transforms, gamut mapping, etc.), the
  `if (preserveAlpha) { ... }` block sat *outside* the per-pixel `for`
  loop instead of inside it. Result: alpha was handled exactly **once**
  at the end of the run. For any input with more than one pixel, alpha
  was never preserved and the output channel writes drifted by one byte
  per pixel. All other inlined kernels (1Ch, 2Ch, 3Ch→4Ch, 4Ch→3Ch,
  4Ch→4Ch, NCh variants) had the block correctly inside the loop and
  were unaffected. Fix: move the block inside the `for`.
- **`{ buildLut: true }` was silently dropped.** The constructor JSDoc
  documents `buildLut` as the option name (with `builtLut` as a "legacy
  spelling"), but the constructor only ever read `options.builtLut`.
  Anyone copy-pasting from the JSDoc got no LUT and silently fell back
  to the slow per-pixel path. The constructor now accepts both spellings
  and normalises to `this.builtLut` internally.

### Changed

#### `src/Transform.js`

- **`precision` is now the canonical Transform constructor option name**,
  with the long-standing typo `precession` kept as a backwards-compatible
  alias. The constructor accepts either spelling (with `precision`
  winning if both are passed), and both `transform.precision` and
  `transform.precession` are populated for read so existing code keeps
  working unchanged. Internal call sites (`getLut(precision)`, the
  `stage_device_to_*_round(device, precision)` helpers, and
  `convert.cmsColor2String(color, precision)`) have all been renamed to
  use `precision` for clarity. The `precession` JSDoc is now marked
  `@deprecated`.

#### `src/Loader.js`

- **`Loader.get(key)` was completely broken on the lazy path.** The
  function called `this.loadProfileIndex(key)` — passing the string
  `key` to a method that expects a numeric **index** into
  `this.profiles`. Result: every `get()` of a profile registered with
  `preload: false` threw `TypeError: Cannot read properties of undefined
  (reading 'profile')`. The `get()` flow now finds the registry index
  by key first, then calls `loadProfileIndex(index)` correctly.
- **`Loader.get(key)` of an unregistered key crashed.** It called
  `findByKey(key)`, which returns `false` on miss, then read `.loaded`
  on `false` — `TypeError: Cannot read properties of false`. Now throws
  an explicit `Loader.get: no profile registered under key 'X'` error.

#### `src/Profile.js`

- **XHR error & timeout handlers were never invoked.** `XHRLoadBinary` was
  assigning to `xhr.timeout` and `xhr.error` instead of `xhr.ontimeout` and
  `xhr.onerror`. Network failures and timeouts were silently swallowed,
  and the `onComplete` callback never fired — callers hung indefinitely.
  As a side effect, assigning a function to `xhr.timeout` (which is the
  numeric timeout duration) coerced it to `NaN` and disabled timeouts
  entirely.
- **`readBinaryFile` threw on success in Adobe CEP.** The CEP branch
  decoded the file successfully but then fell through to the
  "unsupported environment" check at the end of the function and threw.
  CEP file reads now return the decoded `Uint8Array` immediately on
  success.
- **Property name typos** (`unsuportedTags`, `virutalProfileUsesD50AdaptedPrimaries`)
  are now dual-aliased to correctly-spelled siblings (`unsupportedTags`,
  `virtualProfileUsesD50AdaptedPrimaries`). Existing code keeps working;
  new code can use the correct names. The typo'd names are marked
  `@deprecated` in JSDoc so IDEs surface a warning.

#### `src/decodeICC.js`

- **Parametric curve type 3 returned NaN.** The `para` tag handler for
  function type 3 (the IEC 61966-2.1 / sRGB curve, 5 parameters) was
  reading `params[5]` and `params[6]`, which don't exist for this type.
  Output was `NaN`. Logic now follows the ICC spec for type 3 and uses
  only `params[0..4]`. This was the cause of bad sRGB ICC decode in
  certain profile flavours.
- **`curv` midpoint gamma estimate could be NaN.** The midpoint sample
  was indexed as `curve.data[curve.count / 2]`. For odd `count` (most
  in-the-wild curves, e.g. 257 entries) this is a fractional index and
  returned `undefined`, producing `NaN`. Now `Math.floor(curve.count / 2)`.
- **Unsupported LUT types silently produced unusable LUTs.** The `lut`
  function's default branch fell through to stride-multiplier code that
  read from an empty `gridPoints` array, producing `NaN` strides. Now
  returns a structurally valid 2×2×2 zero sentinel LUT with
  `lut.invalid = true` and `lut.errorReason` set, plus a `console.warn`.
  Downstream code no longer crashes on bad input; it sees a black 2×2×2
  CLUT and an explicit "this LUT failed to decode" flag.
- **Diagnostic messages upgraded** from `console.log` to `console.warn`
  for unknown text types, parametric curve types, LUT types, and MPE
  elements — these messages signal degraded behaviour and belong in the
  warn channel.

#### `src/convert.js`

- **`Lab2RGB` returned greyscale.** Copy-paste error: all three output
  channels were sourcing from `RGBDevice[0]` instead of `[0]`, `[1]`, `[2]`.
- **`RGB2Lab` chromatically adapted twice.** The function called
  `RGBf2XYZ` (which already applies chromatic adaptation to the requested
  Lab whitepoint internally) and then ran an extra adaptation step on the
  result. The second adaptation has been removed.

### Changed

#### `src/convert.js`

- **`Y = 1.0` whitepoint convention is now an enforced invariant.** All
  bundled illuminants in `def.illuminant.*` use `Y = 1.0` by design.
  Several functions had `* whitePoint.Y` or `/ whitePoint.Y` operations
  that were no-ops under this invariant. They've been removed (in
  `XYZ2Lab`, `Lab2XYZ`, `RGBDevice2LabD50`, `adaptation`) with inline
  comments explaining why, so future edits don't "fix" the optimisation.
- **`BradfordMtxAdapt` and `BradfordMtxAdaptInv` are now `Object.freeze`-d**
  to prevent accidental mutation of the shared chromatic-adaptation
  matrices. New zero-cost getters `getBradfordMtxAdapt()` and
  `getBradfordMtxAdaptInv()` return references to the same frozen arrays
  for ergonomic call-sites that prefer functions over property access.
- **`Lab2sRGB` documented as display-only.** Its existing behaviour is
  unchanged — it deliberately skips chromatic adaptation and ICC profile
  consultation in favour of speed for screen approximation. JSDoc now
  makes this clear so it doesn't get "fixed" with a slow accurate path.

### Documentation

- **`/docs/*.md` revised** to match the in-source JSDoc and current API.
  `Profile.md` now leads with the virtual-vs-ICC framing, includes a
  runnable example, and flags the deprecated typo'd property names.
  `Transform.md` now leads with the two-tier accuracy/hot mental model,
  documents both `buildLut` / `builtLut` spellings, fixes the missing
  `BPC` per-stage array form, and includes runnable accuracy + hot
  examples. `Loader.md` clarifies that the loader is optional.
- **Misread-prone name cluster.** Several "typo'd vs correct" property
  and option names exist in the codebase, all aliased for backwards
  compatibility — easy to skim and miss. Documented all four in one
  place in `Transform.md` / `Profile.md`:
    - `builtLut` (legacy) ↔ `buildLut` (canonical) — Transform option
    - `precession` (legacy) ↔ `precision` (canonical) — Transform option
    - `unsuportedTags` (legacy) ↔ `unsupportedTags` (canonical) — Profile property
    - `virutalProfileUsesD50AdaptedPrimaries` (legacy) ↔
      `virtualProfileUsesD50AdaptedPrimaries` (canonical) — Profile property
- **File-top primers** added or rewritten for `Transform.js`, `Spectral.js`,
  `convert.js`, `decodeICC.js`, `Loader.js`, `Profile.js`. Each explains
  purpose, scope, conventions, known limitations, and (where relevant)
  the accuracy-vs-speed positioning of the module.
- **Section dividers and per-function JSDoc** filled in across the
  affected files. All public methods now document parameters, returns,
  whitepoint conventions, and any non-obvious behaviour.
- **`Profile.js` virtual-vs-ICC explanation** added in the file primer:
  for matrix-shaper RGB profiles there's no functional difference between
  loading the ICC and using the virtual equivalent; the engine
  auto-promotes matrix RGB ICCs to the same fast path.
- **`decodeICC.js` ICC v4 coverage notes** clarified — most v4 profiles
  in practice use the same v2-compatible tag set, so v4 support is good
  in real-world use even though `mpet` is not implemented.

### Tests

- New regression tests in `__tests__/decodeICC.smoke.js` covering the
  parametric type 3 fix, the `curv` odd-count fix, and the unsupported
  LUT sentinel behaviour.
- New regression tests in `__tests__/transform_lut_3ch_alpha.tests.js`
  covering: per-pixel alpha preservation in multi-pixel sRGB→CMYK→sRGB
  soft-proof chains, sRGB→Lab via LUT, the `outputHasAlpha` (no input
  alpha) write-255 case, and both `buildLut` / `builtLut` constructor
  spellings.
- New regression tests in `__tests__/loader.tests.js` covering the
  Loader L1 (lazy `get()` index/key bug) and L2 (unregistered key
  crash) fixes, plus basic `add` / `findByKey` / `loadAll` behaviour.
- New tests in `__tests__/transform_virtual.tests.js` locking in the
  `precision` / `precession` option-name aliasing — both spellings
  produce identical output, both `transform.precision` and
  `transform.precession` are populated, and `precision` wins if both
  are passed.

---

## [1.0.4] — Previous release

Baseline release on npm. See git history for details.
