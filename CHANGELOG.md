# Changelog

All notable changes to jsColorEngine are documented in this file.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased] — Roadmap

These are planned but unshipped. See `docs/Performance.md` for the
full reasoning, benchmarks, and architectural decisions.

### Planned — v1.2 (16-bit input/output for `lutMode: 'int'`)

The `lutMode` API was deliberately designed as a string enum so the same
constructor option can grow to cover 16-bit and (later) WASM kernels
without breaking the call signature.

> **Note**: there's a real possibility v1.2 skips straight to the WASM
> work below and we backport learnings to the JS path rather than
> fine-tune the JS further. The JS integer path is already ≤ 1 LSB
> accurate with 1.05–1.20× speedup — the remaining headroom in JS is
> modest. WASM SIMD (POC at 67× for non-LUT math) is the bigger lever.
> Keeping the u16-input/output work queued here as the "polish the JS
> path" option in case we want to ship that first.

- u16 input → u8 output (kernel variant — feeds high byte to existing
  Q0.8 path)
- **u16 input → u16 output** (the main prize — Q0.16 accumulator,
  single-step `(acc + 0x8000) >> 16` rounding). Single-step rounding
  with Q0.15 weights gave best accuracy in `bench/int_vs_float.js`
  (FINDING #5).
- u8 input → u16 output (cheap, useful for "convert once, downstream
  tools handle 16-bit" pipelines)
- Decide: keep one u16 LUT for both u8/u16 output paths (likely yes —
  POC showed no overflow problems with u16 LUT + Q0.16 accumulator).
  If not: dual build vs runtime rebuild vs accepting 0.4 % range loss
  (cap at 65280) — leaning toward the last as "cheapest, imperceptible".

#### Experiment — f32 CLUT variant (`dataType: 'f32'`)

Cheap experiment worth running in the v1.2 cycle: clone the existing
float CLUT as `Float32Array` and benchmark the existing float kernel
against it. Tagged as `dataType: 'f32'` on the outer LUT so the
dispatcher / inspection tooling already handles it.

**Hypothesis**: measurable win on 4D CMYK profiles (17⁴×4 = 334 KB
@ f64 drops to 167 KB @ f32, which is the difference between
"borderline L2/L3" and "fully L2-resident" on most desktop chips).
Small-to-no win on 3D profiles that already fit L2 comfortably.

**Risks / things to measure**:
1. JS f32 load = implicit `cvtss2sd` (f32→f64 widen) per CLUT read.
   On tetrahedral loops with 4–8 CLUT reads per output channel, the
   extra uops can eat the cache win. Worth confirming direction per
   kernel shape.
2. V8 will deopt + re-specialise the float kernel the first time it
   sees a `Float32Array` input after running against `Float64Array`.
   Bench must warm separately, not swap mid-run.
3. Accuracy: f32 mantissa is 24 bits, so CLUT cells in `[0, 1]` land
   ~6e-8 off. Far below the `1/255 = 0.004` LSB budget for u8 out —
   expect bit-exact at u8, sub-LSB drift at u16 out.

**Non-goal**: don't ship an f32 kernel variant if the measurement is
flat or mixed — f32 LUT is ONLY worth adding if it cleanly wins on
large 4D profiles, since every new `dataType` is surface area the
WASM and SIMD paths also have to cover later. Measure first, decide
after.

Relevant to the JIT-inspection bench (`bench/jit_inspection.js`): if
that bench confirms the int kernels really are Int32-specialised, the
same bench can be pointed at the f32 experiment to confirm V8 is
emitting f32-load paths (`movss` / `vmovss`) rather than boxing
through HeapNumber.

#### Candidate optimisation — pre-bias u16 CLUT to eliminate `+ 0x80`

Independently rediscovered during the v1.1 cycle: ICC v2 PCS Lab
encodes `L* = 100` at 0xFF00 (= 255 × 256) for exactly the same reason
we scale our u16 CLUT by 255 × 256 — it makes `u16 / 256 = u8` exact
under a cheap `>> 8`. We can push this further by **baking the
round-half-up bias into the stored CLUT value** at build time:

```js
// buildIntLut — store u16 pre-biased by +0x80:
u16[i] = Math.min(65535, Math.round(float * 65280) + 0x80);

// 3D kernel — biases cancel in (a - c0) deltas; only c0's bias
// survives and it IS the round-up bias we wanted. Inner and outer
// +0x80 additions both disappear:
output[i] = (c0 + ((Math.imul(a-c0, rx) + Math.imul(b-a, ry) + Math.imul(d-b, rz)) >> 8)) >> 8;
//         ^                                                                          ^
//         round-up bias carried in c0                                                no extra bias needed
```

Saves 2 additions per output channel in the 3D path. Estimated 2–4 %
speedup on 3D kernels, zero accuracy impact.

**Caveat**: does NOT apply to the 4D u20 kernels — the equivalent
pre-bias for a `>> 20` shift is `0x8000`, which would overflow u16
(32768 + 32640 > 65535). 4D kernels stay as-is. So this is a pure 3D
optimisation and needs a separate `buildIntLut` code path (or a flag
on the LUT indicating "3D-pre-biased" vs "4D-raw").

#### Why we aren't matching lcms2's accuracy precisely

Left as a note for anyone reading the code and wondering: lcms2 carries
values at **Q15.16 (i32) end-to-end**, including the CLUT itself. That
gives them 32-bit precision throughout and sidesteps the scale-factor
question entirely (the CLUT has no "scale") — but the LUT is 4×
bigger than ours and therefore misses L2 cache on 4D profiles. We
carry CLUT at u16 (4× smaller, fits L2) and extend to u20 (Q16.4)
only in the accumulator. u20 is the widest we can go and still do
`Math.imul(diff, rk) + (o0 << 8)` in signed i32 without overflow. For
u8 output our ≤ 1 LSB budget is indistinguishable from lcms2's; the
lcms2 approach only shows an advantage at u16 output or when chained
through many transforms.

This is the trade for JS: cache behaviour over kernel precision. If
we ever port to WASM SIMD, revisiting Q15.16 CLUT is worthwhile —
i32 is the native SIMD lane width and the cache penalty shrinks when
you process 4 corners per instruction.

### Planned — v1.2/v1.3 (`new Function` codegen for the **accuracy path**)

A candidate optimisation aimed squarely at the non-LUT (accuracy)
path, which is currently 11-15× slower than the LUT paths — not
because the math is slow, but because the per-pixel loop goes
through a polymorphic stage dispatcher that allocates intermediate
arrays per stage per pixel.

**Idea**: at `transform.create()` time, emit a specialised JS source
string that inlines every pipeline stage for the specific profile
chain (sRGB → Bradford → GRACoL-Lab2CMYK, etc.) with:

- all matrix constants as literals (V8 folds them as inline immediates)
- all curve coefficients as literals
- intermediate values in scalar locals (no `[x, y, z]` array per stage)
- no `pipeline[s].funct.call()` dispatch
- no per-stage `stageData` heap loads

Then compile via `new Function(src)` once, cache the function on the
Transform instance. V8 specialises it hard (monomorphic, all float64
locals, everything in XMM registers) — we expect **5-8× speedup on
the accuracy path**, landing it in the same ballpark as the LUT path
without LUT quantisation error.

**Architecture** — each pipeline stage adds an `.emit(ctx)` companion
to its existing `.funct`. Stages emit **statement lists, not
expressions** — they assume their input variables are already set
and write into their output variables. No returns, no composition,
no threading — just sequential assignment into well-known names.

```js
pipeline[s] = {
    funct:     existingRuntimeFn,   // unchanged — fallback / CSP-safe path
    stageData: {...},               // unchanged
    inputs:    ['L', 'a', 'b'],     // NEW — names this stage reads
    outputs:   ['X', 'Y', 'Z'],     // NEW — names this stage writes
    emit:      function(ctx) { ... }// NEW — returns a block of JS statements
};
```

**Variable naming** — semantic, not numeric. Lab → `L, a, b`;
XYZ → `X, Y, Z`; PCS Lab → `pcsL, pcsa, pcsb`; device channels →
`d0 .. dN`. A **single top `var` block** declares every possible
channel name up front, so V8 sees full scope at once and dead-stores
unused slots. In-place stages (Bradford adapt, Lab→Lab) emit
stage-internal temps (`tX, tY, tZ`) so assignment order doesn't
corrupt the transform — stage-author concern, not orchestrator.

```js
function transform_srgb_to_gracol(r_in, g_in, b_in) {
    var r, g, b;               // decoded device RGB
    var X, Y, Z;               // PCS XYZ
    var pcsL, pcsa, pcsb;      // PCS Lab
    var d0, d1, d2, d3;        // output CMYK
    var tX, tY, tZ;            // transient temps for in-place ops
    // ... stage blocks ...
    return [d0, d1, d2, d3];   // final stage emits the return shape
}
```

**Pipeline validation** — at codegen time the orchestrator walks the
stages and verifies `pipeline[N].outputs === pipeline[N+1].inputs`
(by name, not just by count). Wiring Lab into an XYZ-consuming
stage throws a useful error at pipeline-build time instead of
producing silent garbage colour at runtime. This is the "cross-
boundary detection" we've been circling — it falls out naturally
once every stage declares its shape.

**`this` binding + runtime data store** — small constants (matrix
coefficients, gamma scalars, D50/D65 whitepoints) bake in as
literals directly in the emitted source. Large data (sampled TRC
curves with 1024 entries, 3D CLUTs, sparse LUT tables) cannot
reasonably be inlined as literals and instead lives on a `store`
object attached to the compiled function. The store is **byRef** —
`store.curve4 = this.profile.lut[3].TRC` is a pointer assignment, no
data duplication. Both the legacy `.funct` runtime path and the
compiled codegen path reference the same bytes.

```js
// At compile time, orchestrator builds the store:
var store = {
    curve0:  pipeline[0].stageData.trc,     // 1024-entry Float32Array
    curve4:  pipeline[4].stageData.trc,
    clut2:   pipeline[2].stageData.CLUT,    // 17^4 CMYK CLUT
    // ...
};

// Generated source references by name:
X = store.curve0[Math.round(r * 1023)];
```

The naming convention is `store.<type><stageIndex>` so the
generated source reads like "stage 4's curve", "stage 2's CLUT" —
self-documenting and easy to step through in DevTools. Orchestrator
uses the pipeline index to generate deterministic names
(`store['curve' + index] = this.profile.lut[i].TRC` etc).

Compiled function is called with `fn.call(store, r, g, b)` — or
bound once at compile time via `fn.bind(store)` — so `this.*` inside
the generated code is the store. Zero lookup overhead per pixel
(V8 resolves `this.curve4` as a single monomorphic property read
on a stable hidden class).

**Data-inlining rule of thumb**: anything ≤ 16 numbers bakes as
literals (3×3 matrix, 4-component clamp vector, parametric curve
coefficients). Anything > 16 numbers goes into the store
(sampled TRCs, CLUTs, adaptation matrices used across many stages).
Big-ness matters because source-level literals past a few KB bloat
the parse tree, hurt code locality, and eventually trigger V8's
large-function deopts.

**Dead-code elimination at emit time** — only possible when you can
see the whole pipeline at once:

- identity curves (`Math.pow(x, 1.0)`): `.emit()` returns `""` and
  maps its output name straight to its input → zero instructions
- adjacent matrix + inverse (constant in RGB→PCS→RGB round-trips):
  detect at codegen time, collapse to identity, emit nothing
- absolute-intent matrix scales that simplify to 1.0 after adaptation
- single-axis clamps adjacent to curves that bottom at 0 anyway

The runtime pipeline can't do any of this — it just runs every
stage. Codegen sees the graph, so it can prune.

This is the same pattern GPU shader-graph compilers use (each node
has a `generateCode()` method, compiler threads them with fresh
names, runs DCE before handing off). Well-proven design — not a
speculative architecture.

**Don't do peephole optimisation on the emitted source.** Tempting
to regex patterns like `X = f; r = X + 3` → `r = f + 3`, but V8's
TurboFan already does copy propagation / forwarding at the IR level
before emitting machine code. Source-level peephole would be doing
work V8 throws away, and regex on JS source is a minefield (string
literals, ASI, re-assignment, nested scopes). **The trust boundary**:
we own "what code gets emitted" (no arrays, no dispatch, literals
baked, DCE across stages). V8 owns "how that code gets compiled"
(register allocation, CSE, copy prop, instruction selection). Each
side does what it's best at.

**Inspection / distribution story** — exposing the generated source
as a first-class API unlocks a genuinely novel shipping mode:

```js
transform.compile();                // new Function() + cache
transform.getSource();              // returns the JS string
transform.toModule({ name: '...' }) // wraps as an ES module
```

Four use-cases fall out:
1. **Runtime JIT** (default): `compile()` + cached `new Function()`.
2. **CSP-locked environments**: `getSource()` → paste into bundler →
   import as a static file. Engine becomes a **build-time tool**,
   zero runtime dependency.
3. **Debugging**: `console.log(transform.getSource())` → read 60 lines
   of self-documenting JS → point at the colour bug. Comments are
   parser-stripped (zero runtime cost), so emit them liberally —
   matrix rows annotated with source/dest whitepoint, curve lines
   annotated with their ICC tag origin. The artefact becomes a
   teaching tool, not a black box.
4. **Self-contained precompiled transform modules** via
   `toModule({name: '...'})` — emit the generated source PLUS the
   store's large data (curves / CLUTs as typed-array constructors)
   inlined at the top of the file, producing a standalone JS module
   that has **zero runtime dependency on jsColorEngine**. A typical
   RGB→CMYK module lands around ~50-80 KB unminified / ~25-40 KB
   gzipped (dominated by the 17⁴×4 u16 CLUT). This is smaller than
   the ~192 KB engine — for one specific transform, bit-exact, no
   ICC parser, no Loader, no dispatcher. Users ship a
   `sRGB_to_SWOP_CMYK.js` file that `require()`s cleanly, runs in
   any JS environment including CSP-locked ones and extensions,
   and has no dependencies at all. That's a genuinely novel
   distribution story for colour management on the web.

**Typed-array serialisation** (for use case 4): `JSON.stringify` on
a `Uint16Array` silently produces `{"0":1,"1":2,...}` not `[1,2,3]`.
Three clean options:

1. **Emit typed-array constructors directly in the module source** —
   `const clut2 = new Uint16Array([12345, 23456, ...]);`. Readable,
   self-contained, slightly larger unminified but compresses well
   under gzip (repeated small ints).
2. **Emit as base64 with a tiny decoder** — smallest file size, less
   inspectable. Opt-in via `toModule({compact: true})`.
3. **Emit as JSON-with-type-tag** — `{type: 'Uint16Array', data: [...]}`.
   Matches the existing `encoding: 'number' | 'base64'` convention
   already used elsewhere in the codebase.

Default: option 1. Keeps the artefact readable, gzip handles the
size. Option 2 is the flag for size-critical deployments.

Add `//# sourceURL=transform_<src>_to_<dst>.js` at the top of the
generated source so Chrome DevTools gives it a stable filename in
the debugger.

**Not** aimed at the image (LUT) path. The JIT inspection in v1.1
proved the existing unrolled kernels are at the JS optimisation
ceiling (all int32-specialised, zero deopts, spill-bound not
compute-bound). Codegen doesn't add any more registers. The whole
LUT path benefit would be marginal — and the LUT path is where WASM
wins, not codegen.

**Real costs to weigh**:

1. `new Function` is blocked by strict CSP (some browser extensions,
   some enterprise sites). Mitigation: expose `transform.getSource()`
   that returns the string, so users in locked-down environments can
   precompile at build time via their bundler.
2. Parse + TurboFan warm-up is ~10-100 ms per first-call per transform.
   Fine for long-running converters, painful for one-shot. Mitigation:
   lazy (codegen only on first `transform()` call, not at `create()`).
3. Stack traces become `eval:anonymous:line N` — ugly to debug.
   Mitigation: use `//# sourceURL=transform_srgb_to_gracol.js` in
   the generated source so DevTools gives it a stable filename.
4. Per-Transform native code blob (~5-10 KB compiled). Negligible
   for most users; slight concern for apps that cache dozens of
   Transforms.

**Bonus shipping outcome**: same infrastructure unlocks
`transform.toModule()` — emit a standalone ES module for the exact
transform, with zero runtime dependency on jsColorEngine. Users can
ship a 2 KB static JS file for their specific sRGB→CMYK conversion
instead of the ~192 KB engine. That's a genuinely novel distribution
story for colour management on the web.

**Prototype path**: start with RGB→RGB accuracy (simplest: decode
curve → matrix → adapt → inverse matrix → encode curve). Measure
Mpx/s delta vs the current pipeline dispatch. If the win is 5× or
more, expand to CMYK. If it's less than 2×, shelve — `lutMode: 'int'`
and `lutMode: 'wasm-*'` cover the speed-sensitive use cases, and the
accuracy path staying at 5 Mpx/s is tolerable for its use cases
(single colours, UI pickers, ΔE reporting).

### Planned — v1.3 (`lutMode: 'wasm-scalar'`)

WASM POC (in `bench/wasm_poc/`) measured **1.84×** over JS for a
1D LERP kernel — bigger than expected, and big enough to justify a
scalar WASM port of the integer kernels on its own. Hand-written
`.wat` or AssemblyScript; payload <5 KB inlined.

Adds new enum value:

```js
new Transform({ ..., lutMode: 'wasm-scalar' })
```

Falls through to `'int'` if WASM isn't available in the host (e.g.
some restricted environments), which falls through to `'float'` if
the LUT shape isn't supported by the integer kernel. The fall-through
chain is the entire point of the enum API.

### Planned — v1.4 (`lutMode: 'wasm-simd'` + `'auto'`)

- **WASM SIMD** for matrix-shaper RGB transforms (no LUT gather, so
  approaches the 67× ceiling — see POC). Different code path from the
  LUT kernels because gather-from-LUT killed SIMD parallelism in the
  POC (1.63× vs WASM scalar 1.84× — gather is the bottleneck).
- `lutMode: 'auto'` — dispatcher picks the best kernel per transform
  shape. Will become the default in **v2.0** (string-enum gives us a
  clean migration path with no API break).

### Planned — browser samples / `samples/` directory

Dev-adoption angle: most colour libraries are judged in 30 seconds by
whether there's a working demo someone can click. jsColorEngine has
none right now, which is a missed win given how visually rewarding
colour-management demos are.

Target samples (all zero-build, reference `browser/jsColorEngineWeb.js`
via `<script>`, work from `file://` so devs can just download + open):

- **`rgb-to-cmyk-separations.html`** — image input (drag-drop or
  file picker) → five side-by-side canvases: composite CMYK→RGB
  preview + individual C, M, Y, K separations rendered as greyscale
  with the channel colour as a tint overlay. Demonstrates the
  image hot path at glance-able speed. Add a FPS counter for the
  "yes this really is 60+ Mpx/s" moment.
- **`colour-calculator.html`** — interactive converter between
  RGB / Lab / XYZ / LCH / CMYK with live round-trip display. Shows
  the accuracy path (`transform()` on single colours), the helper
  functions in `convert.js` (matrix conversions, delta-E), and how
  virtual profiles work without the user needing an ICC file. UI:
  a row of sliders per colour space, ΔE readout between source and
  round-tripped destination.
- **`soft-proof-image.html`** — upload image, pick a press profile
  from a dropdown of virtual profiles (or drop in your own ICC),
  side-by-side "on screen" vs "what it'll print". Classic use case,
  covers the full pipeline, looks impressive.
- **`profile-inspector.html`** — load any ICC file, dump tag table,
  show TRC curves, render the gamut shell in 3D. Genuinely useful
  tool on its own; doubles as a demo of the `Profile` class API
  surface.
- **`gamut-viewer.html`** — repurposed from the existing internal
  `profileViewer.js` (O2 Creative, "All Rights Reserved" currently).
  Three.js-based, vertex-coloured gamut mesh so the surface shows
  actual colours, side-by-side profile comparison with ∆E³ volume
  readout, add/remove profiles, opacity sliders, wire/solid/trans
  view modes, mouse-drag rotation + wheel zoom. Already has
  `addLabPoints` / `addCMYKPoints` / `addRGBPoints` helpers — can
  plug an image → point-cloud demo on top (drop an image, see the
  image's pixel distribution as a coloured cloud inside the gamut
  shell). Before shipping: relicense to match engine (GPL-3.0 or
  permissive), drop jQuery dependency, extract O2-specific bindings,
  swap `require` for UMD / `<script>` usage, Three.js via CDN.
  Maybe 4-6 hours to release-ready. Visually the most impressive
  sample of the set.
- **`speed-test.html`** — user's-machine profiler. Runs the existing
  `bench/mpx_summary.js` logic in-browser across the three working
  modes (no-LUT, float LUT, int LUT) and four standard workflows
  (RGB→RGB, RGB→CMYK, CMYK→RGB, CMYK→CMYK), displays a live
  MPx/s table with the user's actual hardware numbers. Useful both
  for setting expectations ("this engine will run at X MPx/s on your
  users' machines") and for CI-style regression tracking across
  browser versions. Minimal UI — table + "run again" button + browser
  + CPU hint via `navigator.userAgent` / `hardwareConcurrency`.
  Maybe 2-3 hours from the existing bench.

Each ~100-200 lines of vanilla JS, no framework, no build step.
Hosted on GitHub Pages so the README can link to live demos ("Try
it in your browser →"). Adoption impact per hour of effort is
higher than almost any feature work.

**Two-site architecture** (separates OSS distribution from premium
showcases):

- **github.com/glennwilton/jsColorEngine + GitHub Pages**: GPL-3.0
  source, vanilla-JS samples, documentation. All distributed.
- **colorwidget.com / demo domain** (or similar): proprietary
  O2 Creative showcase — full Three.js gamut viewer (not
  relicensed), profile library, advanced demos, "upload your ICC
  and download a compiled module" tool (for v1.2). Hosted only,
  never distributed.

GPL-3.0 copyleft triggers on distribution, not execution — so
proprietary hosted code calling a GPL library is fine. This also
correctly handles commercial ICC profiles: using FOGRA / Japan Color
/ SWOP on a demo server for user soft-proofing is legitimate
(same as Photoshop does), whereas putting them in a git repo would
be redistribution and problematic. The split gets this right
automatically.

**Licensing note for future**: stay on GPL-3.0, not AGPL-3.0. AGPL
closes the network-use loophole and would force the demo site to
open-source too. GPL → fine. AGPL → problem.

Cross-link both surfaces: GitHub repo README points at the demo
site, demo site footer links back to the GitHub repo. Each funnel
feeds the other.

### Explicitly out of scope (for now)

- **GPU shaders (WebGL / WebGPU).** Upload+download latency dominates
  for anything under ~10 MPx; WebGPU isn't universally available; API
  surface is huge. Maybe v2.x.
- **Lab-input integer kernels.** Lab a/b are signed; integer kernels
  assume unsigned. Sidestepped by always going through device color
  when `lutMode: 'int'` is on.
- **Web Workers / parallel transformArray.** Was queued for v1.3 but
  bumped — the WASM POC numbers (1.84× scalar) make WASM the better
  next step, and Web Workers can be added on top of any kernel later.
- **Profile decode optimisation.** One-time cost; not where the
  engine spends its life.

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
