# `bench/lcms_c/` — native lcms2 benchmark

Companion to [`bench/lcms-comparison/`](../lcms-comparison) that
measures **native** lcms2 (C, `-O3 -march=native`) on the exact
same 4 workflows, exact same pixel count, exact same seeded PRNG
input, and exact same timing loop (warmup + median-of-5 batches of
100 iters). The MPx/s numbers drop straight into the comparison
tables in [`../../docs/Performance.md`](../../docs/Performance.md).

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
| 1 | RGB → Lab | sRGB (virtual) → LabD50 (virtual) |
| 2 | RGB → CMYK | sRGB (virtual) → GRACoL2006_Coated1v2.icc |
| 3 | CMYK → RGB | GRACoL2006_Coated1v2.icc → sRGB (virtual) |
| 4 | CMYK → CMYK | GRACoL2006_Coated1v2.icc → GRACoL2006_Coated1v2.icc |

Same workflow set as the browser bench and the JS comparison — so
you can drop jsColorEngine numbers, `lcms-wasm` numbers, and
native-lcms numbers into a single row-per-workflow table.

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
`docs/Performance.md §4 "How does this compare to LittleCMS in C?"`
to replace the current `wasm × 1.5–2.5` estimate with measured
values.

## Targets

| Make target | What it does |
|---|---|
| `make` (default) | Build `./bench_lcms` with `-O3 -DNDEBUG -march=native` |
| `make run` | Build + run with default profile path |
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
```

## What's deliberately **not** configurable (yet)

- **16-bit path.** We pin `TYPE_*_8` on both sides (and in the JS
  bench) for apples-to-apples with the engine's hot path. A 16-bit
  variant would be a second build target, useful but out of scope
  for v1.2 close-out. Add an 8-vs-16 switch when the 16-bit kernels
  land in jsColorEngine v1.3.
- **Fast-float plugin.** lcms2's `fast_float` plugin lives in a
  separate repo (`Little-CMS/Fast-Float-Plugin`) and uses SSE2 +
  8-bit specialisations internally. If we ever want to claim parity
  against "the fastest lcms setup", that's the thing to link. For
  now, plain lcms2 is the honest baseline — it's what ships in the
  distro packages everyone actually installs.
- **Rendering intents other than relative colorimetric.** Matches
  the rest of the bench suite. Add a CLI flag if anyone needs it.

## Relationship to the rest of the bench suite

- [`bench/lcms-comparison/`](../lcms-comparison) — jsColorEngine vs
  `lcms-wasm` head-to-head (Node, JS only, no native C toolchain
  needed).
- [`bench/lcms_c/`](./) *(this folder)* — native lcms2 baseline.
  Requires a C compiler; produces the `wasm × ?×` number that
  Performance.md §4 currently estimates.
- [`bench/browser/`](../browser) — every jsColorEngine `lutMode` +
  `lcms-wasm` side-by-side in the browser. Same four workflows.
- [`bench/mpx_summary.js`](../mpx_summary.js) — jsColorEngine alone,
  node, used as the authoritative source for the README speed
  tables.

## Licence

Only the build glue (`Makefile`, `bench_lcms.c`, this `README.md`)
is part of jsColorEngine. The `lcms2-2.18/` subtree is a vendored
copy of upstream LittleCMS 2.18 (MIT), included under its own
`LICENSE` — we redistribute but do not modify.
