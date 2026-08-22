# `bench/lcms_c/` — native lcms2 benchmark

> **Two binaries live here.** `bench_lcms` is the original
> four-workflow harness described below. **`bench_content_matrix` is
> the one the release comparison uses** — it adds the axes that turned
> out to move the numbers most: content type, cache on/off, and buffer
> size, across six workflows. If you are reproducing
> [`docs/LcmsComparison.md`](../../docs/LcmsComparison.md), start at
> [`bench/release_matrix/README.md`](../release_matrix/README.md), which
> drives both halves.
>
> ```bash
> bash flag_sweep.sh                    # give lcms its best build first
> gcc -O2 -std=c99 -I lcms2-2.18/include -o /tmp/bm \
>     bench_content_matrix.c lcms2-2.18/src/*.c -lm
> taskset -c 0 /tmp/bm --sizes 1048576
> taskset -c 0 /tmp/bm --sizes 16384,65536,1048576,10485760 --content noise
> ```
>
> `--content noise,gradient,blocks16,solid,photo` selects content;
> `--photo-dir` points at the decoded corpus from
> `bench/release_matrix/make_corpus.cjs` (photo rows are skipped, not
> faked, when it is absent).
>
> **`-march=native` is not the right default.** It measured at or near
> the *bottom* on every workflow on a Ryzen 7700X. Run `flag_sweep.sh`
> on your own machine and quote lcms's best build — the Makefile default
> no longer uses it.

Companion to [`bench/lcms-comparison/`](../lcms-comparison) that
measures **native** lcms2 (C) on the exact
same 4 workflows, exact same pixel count, exact same seeded PRNG
input, and exact same timing loop (warmup + median-of-5 batches of
100 iters). The MPx/s numbers drop straight into the comparison
tables in [`../../docs/deepdive/Performance.md`](../../docs/deepdive/Performance.md).

This is the missing row in the existing comparison story: the JS
bench reports jsColorEngine vs `lcms-wasm` (LittleCMS compiled to
`wasm32` via Emscripten). This tool reports against the real,
native, autotools-built lcms2 as it ships in `libjpeg`, Pillow,
Photoshop's bundled CMS, and every Linux desktop that uses ICC
profiles — the actual comparison people reach for when they ask
"is this really faster than lcms?".

> **Methodology match.** Every knob that matters is identical
> between this tool and `bench/lcms-comparison/bench.js`: same
> `65536` pixels, same 300-iter warmup, same 5 × 100 timed batches,
> same seeded PRNG, same `INTENT_RELATIVE_COLORIMETRIC`, same
> 8-bit everywhere. Two lcms2 flag variants are measured (default
> and `cmsFLAGS_HIGHRESPRECALC`) exactly as the JS bench does.

## What it measures

| # | Workflow | Profiles |
|---|---|---|
| 1 | RGB → RGB   | sRGB (virtual) → AdobeRGB1998.icc (`samples/profiles/`) |
| 2 | RGB → CMYK  | sRGB (virtual) → GRACoL2006_Coated1v2.icc |
| 3 | CMYK → RGB  | GRACoL2006_Coated1v2.icc → sRGB (virtual) |
| 4 | CMYK → CMYK | GRACoL2006_Coated1v2.icc → GRACoL2006_Coated1v2.icc |

Workflow 1 uses **sRGB → AdobeRGB1998** (not sRGB → Lab, and not sRGB →
sRGB). lcms2 detects matrix-shaper same-profile transforms as identity
and short-circuits `cmsDoTransform` to `memcpy`, which would benchmark
memcpy speed rather than CMS work. AdobeRGB is a different matrix-shaper
profile — no bypass, real work. This matches `bench/mpx_summary.js`
exactly.

> **Earlier versions** of this bench tested *RGB → Lab* as workflow 1 —
> a mismatch with the JS bench. The corrected bench (RGB → RGB) shows
> lcms2 native at ~160 MPx/s for this direction (matrix-shaper fast
> path), vs ~50 MPx/s for the original Lab path (LUT-based). Running
> `make fastfloat` adds a direct comparison; see
> [fast_float findings](#fast_float-findings) below.

Same workflow set as the browser bench and the JS comparison — so you
can drop jsColorEngine numbers, `lcms-wasm` numbers, and native-lcms
numbers into a single row-per-workflow table.

## One-time setup — fetch lcms2 source

The repo ships the **bench glue** (`bench_lcms.c`, `Makefile`,
`README.md`, fetch scripts) but **not** the ~11 MB upstream lcms2
source tree. Download it once with the included script:

```bash
cd bench/lcms_c
./fetch-lcms2.sh                  # default: lcms2-2.18
./fetch-lcms2.sh 2.17             # or pin a specific version
```

Windows PowerShell equivalent:

```powershell
cd bench\lcms_c
.\fetch-lcms2.ps1
```

This drops `lcms2-2.18/` next to the Makefile. Re-run when you
want to upgrade the lcms2 baseline.

## Build — WSL2 (recommended on Windows)

```bash
# One-time: install a C toolchain
sudo apt update
sudo apt install -y build-essential

# From the repo root, go into this folder (and fetch lcms2 once,
# if you haven't already):
cd bench/lcms_c
./fetch-lcms2.sh
make

# Run the bench:
./bench_lcms
```

That's it. The `Makefile` compiles all ~27 lcms2 source files
directly into the benchmark binary — no autotools, no system
`liblcms2-dev`, no `configure` step. A clean build takes ~10-15s
on a modern laptop.

## Build — Linux / macOS

Same as WSL2. On macOS, Xcode Command Line Tools (`xcode-select
--install`) gives you `clang` + `make`; the Makefile picks them up
via `CC=cc` or `CC=clang`.

## Build — native Windows (MinGW-w64 / MSYS2)

Yes, there's gcc for Windows — **MinGW-w64** via **MSYS2**. Slightly
more setup than WSL2 but produces a native `.exe` with no Linux
layer:

1. Install [MSYS2](https://www.msys2.org/).
2. Open the MSYS2 MinGW64 shell and install the toolchain:
   ```
   pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-make
   ```
3. `cd` to `bench/lcms_c/` and:
   ```
   ./fetch-lcms2.sh     # or PowerShell: .\fetch-lcms2.ps1
   mingw32-make
   ./bench_lcms.exe
   ```

The compiler + the flags are equivalent to the WSL2 build; numbers
should agree within noise. WSL2 is simpler if you just want the
numbers; MinGW-w64 is the right choice if you want to bundle the
bench into a Windows CI pipeline.

## Example output

```
==============================================================
 jsColorEngine companion — native lcms2 MPx/s
==============================================================
 pixels per iter  : 65536
 batches x iters  : 5 x 100
 warmup           : 300 iters
 profile          : ../../__tests__/GRACoL2006_Coated1v2.icc
 lcms2 version    : 2180
 compiler         : gcc 11.4.0
 arch             : x86_64

--------------------------------------------------------------
 RGB  -> Lab    (sRGB    -> LabD50)
--------------------------------------------------------------
  flags = 0                    :    XX.X MPx/s   (Y.YY ms/iter)
  HIGHRESPRECALC               :    XX.X MPx/s   (Y.YY ms/iter)   (default vs highres max diff: N LSB)

... (3 more workflows) ...

==============================================================
 SUMMARY — Mpx/s (higher is better)
==============================================================
  workflow                          lcms-def  lcms-hi
  --------------------------------  --------  --------
  RGB  -> Lab    (sRGB    -> LabD50)    XX.X M    XX.X M
  RGB  -> CMYK   (sRGB    -> GRACoL)    XX.X M    XX.X M
  CMYK -> RGB    (GRACoL  -> sRGB)      XX.X M    XX.X M
  CMYK -> CMYK   (GRACoL  -> GRACoL)    XX.X M    XX.X M

Markdown:
| Workflow | lcms2 native default | lcms2 native HIGHRESPRECALC |
...
```

Real numbers depend on CPU — run it yourself and drop them into
`docs/deepdive/Performance.md §4 "How does this compare to LittleCMS in C?"`
to replace the current `wasm × 1.5–2.5` estimate with measured
values.

## Targets

| Make target | What it does |
|---|---|
| `make` (default) | Build `./bench_lcms` with `-O3 -DNDEBUG -march=native` |
| `make run` | Build + run with default profile paths |
| `make fastfloat` | Build with fast_float plugin (`-DWITH_FAST_FLOAT`), run — reports vanilla vs fast_float side by side |
| `make steelman` | Rebuild with **`-ffast-math -funroll-loops -flto`** on top of the release flags (see below) |
| `make debug` | Rebuild with `-O0 -g` for `gdb` / `valgrind` |
| `make clean` | Delete binary + all `.o` files |

### `make steelman` — native lcms2 ceiling

The default build already matches lcms2's own release autotools
build (`-O3 -march=native -fno-strict-aliasing`). The `steelman`
target is for answering the honest question *"how fast can native
lcms actually go?"* — it turns on the three aggressive-but-legit
compiler flags on top of release:

| Flag | What it does | Cost |
|---|---|---|
| `-ffast-math` | Relax strict IEEE 754 — allow FMA contraction, reassociation, assume no NaN/Inf, reciprocal-instead-of-div. Enables a lot more auto-vectorization. | Results can shift by ~1 LSB vs strict-IEEE build. ΔE still well under 1 against the reference LUT. |
| `-funroll-loops` | Aggressive unrolling of the tetrahedral / matrix inner loops. | Larger binary (~+5-10%). |
| `-flto` | Link-time optimization — lets the compiler inline across lcms2 translation units (e.g. inline `cmsGetTransform`'s hot leaf fn into the per-pixel dispatcher). | Longer link time (~5-10s extra), nothing at runtime. |

```bash
cd bench/lcms_c
make steelman           # fully rebuilds
./bench_lcms            # or: taskset -c 0 ./bench_lcms
```

To go back to the reference release build:

```bash
make clean && make
```

`-ffast-math` is a free GCC/Clang flag (no license). **PGO**
(`-fprofile-generate` / `-fprofile-use`) is the next step up and
would give another ~5-15%, but requires a two-pass build + sample
workload. Not wired in yet — worth doing if someone wants to push
the ceiling further.

> **On SIMD:** `-O3 -march=native` on any modern x86_64 CPU already
> enables SSE4.2 / AVX / AVX2 / FMA for the compiler's auto-vectorizer.
> lcms2 also has explicit SSE2 intrinsics in `cmsOptimization.c`
> (unless you build with `-DCMS_DONT_USE_SSE2`, which we don't). No
> hand-written AVX paths — those come entirely from the compiler.

## Options at runtime

```bash
# Override the profile path:
./bench_lcms /path/to/some_other.icc

# Pin to a single core for cleaner numbers on hybrid CPUs
# (P-core on Intel 12th-gen+, not strictly required but stabilises
# the median):
taskset -c 0 ./bench_lcms

# Environment overrides (added 2026-08 after upstream review — see
# docs/LcmsComparison.md):
BENCH_PIXELS=1048576 ./bench_lcms     # pixels per iteration (default 65536)
BENCH_ITERS=20       ./bench_lcms     # iterations per timed batch (default 100)
BENCH_WARMUP=50      ./bench_lcms     # warmup iterations (default 300)
BENCH_INPUT=gradient ./bench_lcms     # photo-like input with flat runs
BENCH_INPUT=solid    ./bench_lcms     # whole image one colour (cache best case)
                                      # (default: per-byte random noise)
```

**`BENCH_INPUT` matters a lot for lcms**: lcms2 memoizes the
last-seen input pixel, so pure random noise is its worst case —
measured 2–3× faster on photo-like gradient content, and up to ~5×
on solid fills, where every LUT workflow converges to the same
~160–170 MPx/s cache-hit ceiling (no interpolation at all, just
compare + copy). jsColorEngine's kernels are content-neutral.
Report which generator you used with any numbers; real images sit
between noise and gradient.

## fast_float findings

`make fastfloat` links the `fast_float` plugin from the vendored lcms2
source tree (`lcms2-2.18/plugins/fast_float/`) and runs vanilla vs
fast_float side by side in the same binary. WSL2 exposes the host
CPU's full ISA (SSE2/AVX are available — no SIMD stripping behind
the hypervisor), so the SSE2 paths inside fast_float execute normally.

**The result splits sharply by profile type:**

| Workflow | lcms2 vanilla | lcms2 + fast_float | Speedup |
|---|---|---|---|
| RGB → RGB   (matrix-shaper) | ~160 MPx/s | **~455 MPx/s** | **3.4×** |
| RGB → CMYK  (LUT-based)     | ~50 MPx/s  | ~48 MPx/s      | ~1.0× |
| CMYK → RGB  (LUT-based)     | ~34 MPx/s  | ~34 MPx/s      | ~1.0× |
| CMYK → CMYK (LUT-based)     | ~30 MPx/s  | ~30 MPx/s      | ~1.0× |

The plugin fuses matrix-shaper profiles into a single vectorised 3×3
multiply — bypassing the stage-walker entirely — which is why it gets
3.4× on RGB→RGB. For LUT-based CMYK workflows the bottleneck is
function-pointer dispatch, not arithmetic, so fast_float's SSE2
kernels have nothing to contribute (0–2% noise).

The plugin's own docs claim "approximately 20% faster for CLUT
profiles." We measured ~0%. The dispatch-bound analysis in
[docs/deepdive/Performance.md §2.1](../../docs/deepdive/Performance.md) predicted this;
the measurement confirms it.

**What this means for jsColorEngine:** jsCE WASM SIMD (128–210 MPx/s)
beats fast_float on all LUT/CMYK workflows by 3–4×. On RGB→RGB
matrix-shaper, fast_float wins at 455 MPx/s vs jsCE's ~216 MPx/s.
jsCE routes all transforms through the CLUT pipeline including
matrix-shaper profiles; a dedicated fused-matrix path is a future
optimization. Full analysis:
[docs/deepdive/Performance.md — Steelmanning the steelman](../../docs/deepdive/Performance.md#steelmanning-the-steelman--fast-float-measured-directly).

## What's deliberately **not** configurable (yet)

- **16-bit path.** We pin `TYPE_*_8` on both sides (and in the JS
  bench) for apples-to-apples with the engine's hot path.
- **Rendering intents other than relative colorimetric.** Matches
  the rest of the bench suite. Add a CLI flag if anyone needs it.

## Relationship to the rest of the bench suite

- [`bench/lcms-comparison/`](../lcms-comparison) — jsColorEngine vs
  `lcms-wasm` head-to-head (Node, JS only, no native C toolchain
  needed).
- [`bench/lcms_c/`](./) *(this folder)* — native lcms2 baseline +
  fast_float comparison. `make` for vanilla, `make fastfloat` for
  vanilla-vs-fast_float side by side.
- [`samples/bench/`](../../samples/bench) — every jsColorEngine `lutMode` +
  `lcms-wasm` side-by-side in the browser. Same four workflows.
- [`bench/mpx_summary.js`](../mpx_summary.js) — jsColorEngine alone,
  node, used as the authoritative source for the README speed
  tables.

## Licence

Only the build glue (`Makefile`, `bench_lcms.c`, this `README.md`)
is part of jsColorEngine. The `lcms2-2.18/` subtree is a vendored
copy of upstream LittleCMS 2.18 (MIT), included under its own
`LICENSE` — we redistribute but do not modify.
