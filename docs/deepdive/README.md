# Deep Dive

**jsColorEngine docs:**
[← Project README](../../README.md) ·
[Bench](../Bench.md) ·
[Performance](../Performance.md) ·
[Roadmap](../Roadmap.md) ·
[Examples](../Examples.md) ·
[API: Profile](../Profile.md) ·
[Transform](../Transform.md) ·
[Loader](../Loader.md)

---

This folder is the "how it works and why it's fast" layer of the docs. The
[project README](../../README.md) tells you *what it does*, the
[Performance page](../Performance.md) tells you *how fast it goes* and what we
learned measuring it. This folder answers the third question: *why*.

If you're here you probably:

- Want to know whether to trust the numbers
- Are considering using (or writing) a JavaScript CMS and want to see what
  "hand-tuned for the JIT" actually means in practice
- Are curious why jsColorEngine's native-JS hot path can keep up with an
  Emscripten wasm32 build of LittleCMS
- Are reviewing a PR against the kernel code and want the rationale for a
  design decision

## Shallow dive — the cheeky TL;DR

Four things we learned writing this that we didn't expect going in. Each one
has a deep-dive page behind it if you want the receipts.

- **Modern JS JITs emit *wicked* good assembly when the loop is well-shaped.**
  TurboFan lowered our hand-unrolled tetrahedral interpolator to inline x64
  SSE/AVX with no spills, no boxing, no allocations, and zero int↔float
  conversions. If you blanked the filenames you couldn't tell the int
  kernel's hot body from C. *The reputation that numeric JS is slow is
  about a decade out of date on monomorphic typed-array loops.* →
  [JIT inspection](./JitInspection.md)

- **Dedicated, unrolled hot loops are still the win.** The "tidy it up
  into a helper function" instinct is wrong here. Our unrolled 6-branch
  kernels fit in 24–34 % of a 32 KB L1i; re-rolling them would save 5 KB
  but cost 5–10 cycles per pixel in branch mispredicts. The
  counter-intuitive code is the fast code, and there's a 200-line comment
  block at the top of `src/Transform.js` to make sure nobody "cleans it
  up". → [LUT modes](./LutModes.md), [Architecture](./Architecture.md)

- **WASM SIMD does 4× the work per cycle and it feels like cheating.**
  Channel-parallel v128 lanes + `v128.load64_zero` instead of a gather
  got us **3.0-3.5× over JS `'int'`** on the 3D tetrahedral kernel,
  bit-exact, in 1.3 KB of `.wasm`. The hardware really does have this
  much headroom — you just have to pick the *right* axis to vectorise
  along. (We got the axis wrong the first time. See the page.) →
  [WASM kernels](./WasmKernels.md)

- **Plain-optimised JS can beat an Emscripten-wasm32 port of a
  battle-hardened C library.** jsColorEngine's `'int'` JS kernel beats
  `lcms-wasm` on every direction we benchmarked. That isn't "JS vs C";
  it's "one specialised kernel per LUT shape tuned for V8" vs "a
  general-purpose C codebase compiled through Emscripten, carrying all
  of lcms2's dispatcher generality, with no SIMD and no Fast Float
  plugin". The comparison is really about *specialisation*, not language
  choice. → [Performance](../Performance.md)

The rest of this folder is the evidence. If any of these claims smell
wrong, the detail pages carry the asm dumps, bench scripts, and repro
recipes.

## Contents

| Page | What it covers |
|---|---|
| [Architecture](./Architecture.md) | Pipeline model: how an ICC profile becomes a kernel. Stages, LUT build, kernel dispatch, accuracy vs image paths |
| [LUT modes](./LutModes.md) | `float` / `int` / `int-wasm-scalar` / `int-wasm-simd` — what each mode is, when it's picked, how it's bit-exact vs the reference |
| [JIT inspection](./JitInspection.md) | V8 emitted x64 assembly walked line-by-line. Working-set size, instruction mix, move classification, the "named temps" micro-test. Why the scalar JS kernel is as fast as it is |
| [WASM kernels](./WasmKernels.md) | Hand-written `.wat` for 3D and 4D tetrahedral interp. SIMD channel-parallel layout, rolling-shutter pack, the V8 inliner lesson. Reproduction recipes |

## Learn more (external)

If jsColorEngine is your first brush with colour management, or you want to
go deeper on the topics we build on:

- **LittleCMS** — [littlecms.com](https://www.littlecms.com/) ·
  [source (mm2/Little-CMS)](https://github.com/mm2/Little-CMS) ·
  [API manual PDF](https://littlecms.com/LittleCMS2.16%20API.pdf).
  LittleCMS is the reference open-source CMS in C. A lot of jsColorEngine's
  core concepts — pipeline stages, tetrahedral interpolation, rendering
  intents — are lifted from LittleCMS. This is not a port, but reading
  `lcms2/src/cmsintrp.c` is time well spent.
- **International Color Consortium (ICC)** —
  [color.org](https://www.color.org/) —
  the standards body. Good starting point for "what even is an ICC profile".
- **ICC specifications** —
  [color.org/specification](https://www.color.org/specification/index.xalter) ·
  direct:
  [ICC.1:2010 (v4.3) PDF](https://www.color.org/specification/ICC1v43_2010-12.pdf) ·
  [ICC.1:2001-04 (v2.4) PDF](https://www.color.org/ICC_Minor_Revision_for_Web.pdf).
  The authoritative specs. v4 is the current standard; v2 is still
  overwhelmingly dominant in the wild. jsColorEngine decodes both.
- **CIE colour science** —
  [CIE publications](https://cie.co.at/publications). Reference for
  the Lab, XYZ, chromatic adaptation and ΔE formulas the engine uses
  internally.
- **WebAssembly SIMD** —
  [WebAssembly SIMD proposal](https://github.com/WebAssembly/simd) ·
  [v128 opcode table](https://github.com/WebAssembly/simd/blob/main/proposals/simd/SIMD.md).
  Relevant if you want to read the `.wat` in `src/wasm/` and understand
  the instruction choices in [WASM kernels](./WasmKernels.md).
