# jsColorEngine vs LittleCMS — accuracy and speed against C

**jsColorEngine docs:**
[← Project README](../README.md) ·
[Bench](./Bench.md) ·
[Performance](./Performance.md) ·
[Roadmap](./Roadmap.md) ·
[Deep dive](./deepdive/) ·
[API: Transform](./Transform.md)

---

[LittleCMS](https://littlecms.com/) is the goalpost. It is the 25-year
reference implementation of ICC colour management, it ships inside
Pillow, GIMP, Krita and most of the Linux desktop, and it is the engine
jsColorEngine learned from. This page measures jsColorEngine against it
on the only two axes that matter — **does it produce the same colours,
and how fast does it get there** — and reports where v1.5 lands.

Three engines appear throughout:

| engine | what it is | why it is here |
|---|---|---|
| **jsColorEngine** | this library: pure-JS `int` kernels plus an inline WASM SIMD tier | the thing being measured |
| **`lcms-wasm`** | LittleCMS 2.16 compiled to wasm32 via Emscripten | what a JavaScript project installs today |
| **lcms native C** | LittleCMS 2.18 built by gcc | the goalpost — compiled C on one core |

Every figure is **one core against one core**: same machine, same
profiles, same input bytes, same session.

## Contents

- [Accuracy](#accuracy--the-question-that-comes-first)
- [Where v1.5 sits](#where-v15-sits)
- [Conditions](#conditions)
- [Notes referenced from the tables](#notes-referenced-from-the-tables)
- [Throughput by content](#throughput-by-content)
- [The control bench](#the-control-bench)
- [Buffer size](#buffer-size)
- [The pixel cache](#the-pixel-cache-beta)
- [Not comparable — the rest of the landscape](#not-comparable--the-rest-of-the-landscape)
- [In progress](#in-progress)
- [Why the numbers come out this way](#why-the-numbers-come-out-this-way)
- [Corrections on the record](#corrections-on-the-record)
- [Reproduce it](#reproduce-it)

---

## Accuracy — the question that comes first

Speed means nothing if the colours differ, so this is the half to read
first. The oracle is LittleCMS itself.

**Image path (8-bit LUT kernels) vs the lcms oracle**, at lcms's default
optimisation:

| workflow | samples | bit-exact | within 1 LSB | max Δ | mean Δ |
|---|---:|---:|---:|---:|---:|
| RGB → Lab | 743 | 98.4 % | **100 %** | 1 LSB | 0.005 |
| RGB → CMYK | 743 | 97.9 % | **100 %** | 1 LSB | 0.005 |
| CMYK → RGB | 6,571 | 99.2 % | **100 %** | 1 LSB | 0.003 |
| CMYK → CMYK | 6,571 | 96.8 % | **100 %** | 1 LSB | 0.008 |

Every sample on every workflow lands within one least-significant bit of
LittleCMS, and the large majority are bit-identical. On named reference
colours — paper white, solid black, rich black, 100 % C/M/Y, 50 % grey,
skin tone, sky — agreement is exact.

**Float pipeline vs an lcms native f64 oracle**: worst case 0.06 ΔE76 in
Lab, 1.24 LSB in 8-bit RGB, 0.04 % ink in CMYK, across 130 reference
files and ~580 k samples.
[Accuracy deep dive](./deepdive/Accuracy.md).

**jsCE is a faithful peer of the C implementation, not an approximation
of it.** Nothing in the speed section below is bought with accuracy.

*(This result improved after upstream review. Our earlier oracle used
`cmsFLAGS_HIGHRESPRECALC` and showed a small out-of-gamut tail — 98.5 %,
max 14 LSB on CMYK→RGB. That flag is a legacy lcms 1.x emulation path,
not a higher-precision mode; against lcms's real default the
disagreement disappears.
[#6](https://github.com/glennwilton/jsColorEngine/issues/6).)*

---

## Where v1.5 sits

Measured on the **photograph corpus** — the realistic case. Synthetic
content is reported further down as *bounds*, not as headlines, for
reasons the [content section](#throughput-by-content) makes plain.

1 M px per iteration, MPx/s, higher is better:

| workflow | jsCE `int` (pure JS) | jsCE WASM SIMD | `lcms-wasm` | lcms native C ⁽¹⁾⁽³⁾ | SIMD ÷ native |
|---|---:|---:|---:|---:|---:|
| RGB → Lab | 53.7 | **119.6** | 35.9 | 65.6 | **1.82×** |
| RGB → CMYK | 48.2 | **121.5** | 35.0 | 61.9 | **1.96×** |
| CMYK → RGB | 43.1 | **82.0** | 25.4 | 40.0 | **2.05×** |
| CMYK → CMYK | 36.8 | **81.3** | 22.9 | 35.6 | **2.28×** |
| RGB → RGB (soft-proof) | 53.8 | **118.9** | 33.7 | 56.9 | **2.09×** |
| RGB → RGB (matrix) ⁽⁴⁾ | 53.5 | 118.8 | 66.3 | **164.5** | 0.72× |

**The four claims this page stands behind:**

1. **Against `lcms-wasm` — the engine a JS project would otherwise
   install — jsColorEngine wins every workflow**, by 1.8× on the matrix
   path and 3.2–3.6× on the LUT workflows. Even the pure-JS `int` tier
   beats it on all five LUT workflows, before any WASM is involved.
2. **Plain JavaScript runs in the same performance class as optimised
   native C.** This is the result worth pausing on, because it involves
   no WASM at all — just V8 executing the `int` kernels against lcms
   given its best build ⁽³⁾, on photographic content:

   | workflow | jsCE `int` (pure JS) | lcms native C | ratio |
   |---|---:|---:|---:|
   | CMYK → RGB | 43.1 | 40.0 | **1.08×** |
   | CMYK → CMYK | 36.8 | 35.6 | **1.03×** |
   | RGB → RGB (soft-proof) | 53.8 | 56.9 | 0.95× |
   | RGB → Lab | 53.7 | 65.6 | 0.82× |
   | RGB → CMYK | 48.2 | 61.9 | 0.78× |

   JavaScript lands between 0.78× and 1.08× of compiled C, and is
   *ahead* on both 4D CMYK workflows. Not "close for a scripting
   language" — the same class, with the gap in either direction under
   what a compiler-flag choice moves ⁽³⁾.
3. **With the WASM SIMD tier, jsCE runs about twice single-threaded
   native C on LUT work** — 1.8–2.3× on the photo corpus. That is width,
   not cleverness: four lanes at a time.
4. **On matrix-shaper RGB→RGB, native C is still 1.4× ahead of us**, and
   we say so. lcms has a fused matrix path; jsCE bakes the transform
   into a CLUT and interpolates ⁽⁴⁾. The remedy is measured and queued —
   see [In progress](#in-progress).

Read every ratio against note ⁽⁶⁾: independent repeats of the same
measurement vary by 1–2 %, so anything under about 1.1× is a tie. These
figures are cross-checked against a minimal
[control bench](#the-control-bench) that shares no measurement code.

## Conditions

| | |
|---|---|
| Date | 2026-08-19 |
| CPU | AMD Ryzen 7700X (8C/16T), single core, `taskset -c 0` for native |
| jsCE / lcms-wasm host | Node v24.16.0, Windows 10 x64 |
| lcms native host ⁽¹⁾ | WSL2 Ubuntu 20.04, gcc 9.3.0 |
| lcms native CFLAGS ⁽³⁾ | `-O2` for RGB-source workflows, `-O3` for CMYK-source and soft-proof — lcms's best build per workflow |
| lcms2 version (native) | 2.18, MIT build, no plugins |
| lcms-wasm version | 1.0.5 (LittleCMS 2.16 → wasm32) |
| jsColorEngine version | 1.5.0 |
| Profiles | GRACoL2006_Coated1v2.icc, AdobeRGB1998.icc, virtual sRGB, virtual LabD50 |
| Intent | relative colorimetric, 8-bit in and out |
| Timing | auto-scaled to ~400 ms per batch, median of 5, one process per cell ⁽⁶⁾ |
| Photo corpus | 5 photographs, 3,939,000 px, mean adjacency 17.3 % RGB / 17.9 % CMYK |

## Notes referenced from the tables

**⁽¹⁾ Host asymmetry.** The JS figures run on Node under Windows; the
native figures run under WSL2 on the same physical CPU. WSL2 is a
virtual machine, so a few per cent of the native/JS gap could be the
environment rather than the engines. Stated rather than corrected for —
the alternative, a native Windows lcms build, swaps one variable for
another.

**⁽²⁾ jsCE has no pixel cache in any figure on this page.** Its image
kernels hold no memo of the previous pixel, so nothing in the jsCE
columns benefits from repeated colours. The `pixelCache` option is
**accuracy-path only, beta, and off by default**; it is measured
separately in [its own section](#the-pixel-cache-beta) and used nowhere
else here. Where an lcms column jumps on repetitive content and a jsCE
column does not, that is the reason.

**⁽³⁾ lcms native gets its best build, per workflow.** Seven CFLAGS sets
were swept before measuring. `-march=native` came at or near the
*bottom* on every workflow, and no single set wins everything: `-O2`
takes the RGB-source workflows, `-O3` the CMYK-source ones and
soft-proof. Each row quotes whichever build was faster for that
workflow.

**⁽⁴⁾ RGB → RGB (matrix) is not like the others.** lcms detects a
matrix-shaper pair and runs a fused matrix path with no interpolation at
all — curves, a 3×3 matrix, curves. Pure arithmetic with no CLUT, which
is why its throughput there is flat across every content type, why its
memo cache never engages, and why it was the one row completely
unmoved by the input-generator correction described in
[corrections](#corrections-on-the-record) — a useful control, since a
path with no interpolation table has no working set to lose. jsCE bakes the same transform
into a 33³ CLUT and interpolates it. This is the one workflow where that
architectural choice costs us, and it is what the matrix-shaper kernel
in [In progress](#in-progress) exists to fix. RGB→RGB here is
sRGB→AdobeRGB1998, never sRGB→sRGB: both engines detect the identity and
collapse it, which measures nothing.

**⁽⁵⁾ `cover` = distinct input colours ÷ CLUT cells.** Below 1× the
input carries fewer colours than the interpolation table has cells, so
most of the table is never read and stays resident in L1 — the
measurement then describes a working set no real image produces. This
column exists because we got it wrong once; see
[corrections](#corrections-on-the-record).

**⁽⁶⁾ Run-to-run variance is 1–2 %, provided the warmup is long enough.**
Every cell is measured in its own process with its own warmup. A
dedicated control bench — one image, one engine, one process, nothing
else loaded — repeated five times per engine gives a spread of
**0.4–2.0 %** across independent processes, and lands within a few per
cent of what the full matrix reports for the same image and workflow.
That agreement is the evidence that the matrix harness is not itself
distorting the figures; see [the control below](#the-control-bench).
Ratios below about 1.1× are still ties.

## Throughput by content

**The content axis is really a coverage axis.** This is the single most
useful thing the release measurement campaign produced, so it goes
before the tables. Here is what the five content generators actually
contain, against a 33³ = 35,937-cell CLUT:

| content | adjacency | distinct colours | cover ⁽⁵⁾ | what it really tests |
|---|---:|---:|---:|---|
| `noise` | 0.0 % | 1,016,892 | 28.3× | full-table worst case — **no real image does this** |
| `photo` | 13.2 % | 41,077 | 1.1× | realistic |
| `blocks16` | 93.8 % | 4,095 | 0.11× | memo-cache best case (Marti Maria's generator) |
| `gradient` | 75.0 % | 256 | 0.01× | degenerate — all three channels ramp together |
| `solid` | 100 % | 1 | 0.00× | the cache ceiling |

Only `noise` exercises the interpolation table, and only `photo` is
representative. **The four synthetic rows are bounds, not results.**
Random noise is the worst case and no photograph resembles it;
`blocks16` is the opposite extreme. A real frame moves through colour
space in regions — sky, then foliage, then skin — so its working set is
both small *and sliding*, which is a property no generator here
reproduces.

That geometry, not adjacency, is what moves jsCE. Holding the pixel
count and the exact 41,077-colour multiset fixed and only **reordering**
the pixels:

| arrangement | jsCE WASM SIMD |
|---|---:|
| sorted by colour (maximum locality) | 175.6 |
| natural photographic order | 111.9 |
| shuffled (locality destroyed) | 96.2 |

Reversing the measurement order reproduced this exactly, ruling out
thermal drift or position in the run.

**Per photograph, throughput tracks distinct-colour count.** Each of the
five corpus images measured on its own, RGB → Lab, 1 M px:

| image | adj % | distinct colours | cover ⁽⁵⁾ | jsCE SIMD |
|---|---:|---:|---:|---:|
| photo of a printed page | 10.3 | 6,429 | 0.18× | **120.9** |
| period illustration | 42.0 | 71,661 | 2.0× | **132.0** |
| sunflower | 14.6 | 116,552 | 3.2× | 111.7 |
| strawberries | 16.1 | 152,752 | 4.3× | 110.9 |
| beach landscape | 6.9 | 229,716 | 6.4× | 109.1 |

Ignoring the illustration — flat art at 42 % adjacency, which is really
a graphic-content row — the ordering is monotonic in distinct colours
and inverted against throughput: 6,429 colours → 120.9 MPx/s,
229,716 → 109.1. Adjacency predicts nothing here; the beach frame has
the *lowest* adjacency and the *most* colours, and it is the slowest.

The mechanism is that a frame walks through colour space in regions —
sky, then sand, then water — so the CLUT working set is small but
*sliding*, and a frame carrying more distinct tones slides it further.
Note also how narrow the real-image spread is: 109–132 MPx/s across five
very different photographs, against 96–190 across the synthetic set.
**Real images cluster; generators do not** — which is the argument for
quoting a corpus rather than a generator.

**Native C shows the same effect**, which is what makes it a property of
CLUT interpolation rather than a jsCE quirk. In lcms's `NOCACHE` column,
where no memo is involved at all, RGB→Lab runs 63.3 MPx/s on noise
against 89.5 on low-coverage gradient — the same ~40 % locality spread.
**Both engines are locality-sensitive; only lcms is additionally
adjacency-sensitive**, through its one-pixel memo cache.

### The tables

1 M px per iteration, MPx/s. `lcms native` is its best build ⁽³⁾;
`NOCACHE` columns run the identical transform with `cmsFLAGS_NOCACHE`,
so where a pair agrees the figure is real throughput and where it
diverges the gap is the memo cache and nothing else. jsCE carries no
memo at all ⁽²⁾.

**RGB → Lab** — CLUT 33³ = 35,937 cells

| content | adj % | cover ⁽⁵⁾ | jsCE `int` | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | lcms native | lcms native NOCACHE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0.0 | 28.3× | 48.5 | 97.6 | 31.2 | 37.4 | 59.7 | 63.3 |
| **photo** | **13.2** | **1.1×** | **53.7** | **119.6** | **35.9** | **41.2** | **65.6** | **72.5** |
| gradient | 75.0 | 0.01× | 61.5 | 185.9 | 64.3 | 48.9 | 129.8 | 89.5 |
| blocks16 | 93.8 | 0.11× | 61.0 | 188.5 | 75.8 | 48.4 | 161.1 | 90.8 |
| solid | 100 | 0.00× | 60.6 | 183.2 | 91.8 | 51.4 | 173.0 | 90.3 |

**RGB → CMYK** — CLUT 33³ = 35,937 cells

| content | adj % | cover ⁽⁵⁾ | jsCE `int` | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | lcms native | lcms native NOCACHE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0.0 | 28.3× | 43.6 | 100.5 | 31.0 | 32.1 | 54.5 | 56.7 |
| **photo** | **13.2** | **1.1×** | **48.2** | **121.5** | **35.0** | **39.0** | **61.9** | **66.5** |
| gradient | 75.0 | 0.01× | 54.2 | 181.8 | 63.6 | 48.5 | 127.5 | 79.4 |
| blocks16 | 93.8 | 0.11× | 53.4 | 184.4 | 76.3 | 46.3 | 159.1 | 79.2 |
| solid | 100 | 0.00× | 55.2 | 181.4 | 83.5 | 48.5 | 173.2 | 79.6 |

**CMYK → RGB** — CLUT 17⁴ = 83,521 cells

| content | adj % | cover ⁽⁵⁾ | jsCE `int` | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | lcms native | lcms native NOCACHE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0.0 | 12.6× | 30.6 | 68.9 | 21.6 | 21.9 | 33.0 | 33.7 |
| **photo** | **13.3** | **0.42×** | **43.1** | **82.0** | **25.4** | **24.3** | **40.0** | **39.9** |
| gradient | 75.0 | 0.00× | 36.9 | 97.0 | 50.3 | 25.4 | 96.5 | 42.4 |
| blocks16 | 93.8 | 0.05× | 38.1 | 96.8 | 69.7 | 25.0 | 139.8 | 43.3 |
| solid | 100 | 0.00× | 39.0 | 104.5 | 87.5 | 26.2 | 169.6 | 44.9 |

**CMYK → CMYK** — CLUT 17⁴ = 83,521 cells

| content | adj % | cover ⁽⁵⁾ | jsCE `int` | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | lcms native | lcms native NOCACHE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0.0 | 12.6× | 27.2 | 68.1 | 19.1 | 20.3 | 28.8 | 29.6 |
| **photo** | **13.3** | **0.42×** | **36.8** | **81.3** | **22.9** | **23.7** | **35.6** | **35.6** |
| gradient | 75.0 | 0.00× | 32.6 | 96.0 | 47.3 | 24.2 | 89.6 | 37.6 |
| blocks16 | 93.8 | 0.05× | 32.0 | 95.0 | 67.7 | 23.9 | 131.2 | 37.6 |
| solid | 100 | 0.00× | 32.1 | 102.8 | 85.0 | 24.9 | 165.1 | 39.5 |

**RGB → RGB, soft-proof (sRGB→GRACoL→sRGB)** — CLUT 33³ = 35,937 cells

| content | adj % | cover ⁽⁵⁾ | jsCE `int` | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | lcms native | lcms native NOCACHE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0.0 | 28.3× | 48.2 | 97.8 | 32.3 | 36.6 | 53.2 | 56.2 |
| **photo** | **13.2** | **1.1×** | **53.8** | **118.9** | **33.7** | **38.6** | **56.9** | **59.8** |
| gradient | 75.0 | 0.01× | 59.5 | 183.4 | 62.3 | 46.8 | 121.9 | 76.0 |
| blocks16 | 93.8 | 0.11× | 60.7 | 186.6 | 75.4 | 48.3 | 157.7 | 78.2 |
| solid | 100 | 0.00× | 61.3 | 182.6 | 91.1 | 47.4 | 174.5 | 78.9 |

**RGB → RGB, matrix (sRGB→AdobeRGB1998)** ⁽⁴⁾ — CLUT 33³ for jsCE; lcms uses a fused matrix path

| content | adj % | cover ⁽⁵⁾ | jsCE `int` | jsCE SIMD | lcms-wasm | lcms-wasm NOCACHE | lcms native | lcms native NOCACHE |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| noise | 0.0 | 28.3× | 48.2 | 88.2 | 64.1 | 64.0 | 155.4 | 156.0 |
| **photo** | **13.2** | **1.1×** | **53.5** | **118.8** | **66.3** | **66.2** | **164.5** | **165.4** |
| gradient | 75.0 | 0.01× | 60.1 | 184.8 | 65.8 | 65.0 | 164.9 | 164.5 |
| blocks16 | 93.8 | 0.11× | 60.5 | 189.0 | 65.8 | 65.9 | 166.4 | 165.8 |
| solid | 100 | 0.00× | 63.4 | 183.2 | 65.7 | 67.4 | 166.1 | 165.4 |

### Reading these tables

- **lcms's memo cache is a bet on repetitive input, and on photographs
  it loses.** At 13 % adjacency it is a net *loss* on four of six
  workflows — RGB→Lab runs 65.6 cached against 72.5 with `NOCACHE` — and
  a tie on the other two. By 75 % adjacency it is winning decisively
  (129.8 against 89.5 on the same workflow), so the break-even sits
  somewhere between the two, which matches the ~40 % we measured
  independently for our own cache. Photographs sit at the wrong end of
  that range; flat graphic content sits at the right end. This is
  independent confirmation, from the reference implementation, of why
  ours ships off by default ⁽²⁾.
- **On flat graphic content lcms wins outright**, and the tables say so:
  at 100 % adjacency native lcms reaches 165–174 MPx/s on every LUT
  workflow against jsCE SIMD's 96–105. If your workload is UI, charts or
  vector art rather than photographs, that is the honest number.
- **The matrix row is flat across every content type in both lcms
  columns** — proof that lcms's fused matrix path bypasses the memo
  cache entirely ⁽⁴⁾.

## The control bench

Correcting the input generator roughly halved our published throughput,
which raises an obvious objection: **how do we know the new harness is
not depressing the numbers the way the old one inflated them?** A
harness that measures six workflows × five content classes × four
engines has plenty of opportunity to disturb what it is measuring, and
this project has been caught by exactly that before.

So the numbers are checked against a deliberately minimal control —
[`bench/solo_photo/`](../bench/solo_photo/solo.js): **one photograph,
one engine, one process, nothing else loaded.** No second engine is ever
constructed, no second content type exists, and `lcms-wasm` is not
imported at all, so no 300 KB WASM heap sits next to the thing being
timed. Each engine is measured in five independent processes, each
warmed for 3 s before a single sample is taken.

Strawberries frame, 1 M px, MPx/s:

| engine | RGB → Lab | RGB → CMYK | spread across processes |
|---|---:|---:|---:|
| jsCE `int` (pure JS) | 53.5 | 48.0 | 0.4–2.0 % |
| jsCE WASM **scalar** | 76.6 | 66.5 | 0.4–0.7 % |
| jsCE WASM SIMD | 115.2 | 113.7 | 0.9–1.1 % |

Two conclusions:

- **The matrix harness is sound.** It reports 52.7 / 110.9 for the same
  image and workflow where the control gives 53.5 / 115.2 — agreement to
  within a few per cent, from two harnesses sharing no measurement code.
  The halving after the generator fix was the *input*, not the harness.
- **The variance is small once warmup is adequate.** 0.4–2.0 % across
  fresh processes. An earlier ~10 % swing traced to a short (800 ms)
  warmup rather than to machine noise, which is why the control uses 3 s.

The control also fills in the tier the main tables skip: **WASM scalar
sits squarely between plain JS and SIMD** (~1.4× over JS, ~0.6× of
SIMD), which is roughly what four-lane vectorisation predicts and a
useful sanity check that the SIMD figure is width rather than an
artifact.

## Buffer size

Buffer size is not really the variable — **CLUT coverage is**, and buffer
size only matters because it controls how many distinct colours the input
can carry. Noise content, so coverage rises with the buffer:

**RGB → Lab**, MPx/s (cover ⁽⁵⁾ in brackets):

| engine | 16 K px (0.46×) | 64 K px (1.8×) | 1 M px (28×) | 10 M px (217×) |
|---|---:|---:|---:|---:|
| jsCE WASM SIMD | **172.0** | 95.2 | 96.7 | 97.8 |
| jsCE `int` | 58.9 | 56.1 | 48.1 | 48.5 |
| lcms-wasm NOCACHE | 49.6 | 37.1 | 37.2 | 36.7 |
| lcms native NOCACHE ⁽³⁾ | 72.6 | 55.9 | 55.5 | 55.7 |

**CMYK → RGB**, 17⁴ CLUT so coverage arrives later:

| engine | 16 K px (0.20×) | 64 K px (0.78×) | 1 M px (12.6×) | 10 M px (126×) |
|---|---:|---:|---:|---:|
| jsCE WASM SIMD | **82.7** | 67.3 | 68.9 | 68.3 |
| jsCE `int` | 31.4 | 30.9 | 31.8 | 31.4 |
| lcms native NOCACHE ⁽³⁾ | 34.5 | 34.4 | 34.1 | 34.3 |

**The cliff is at coverage ≈ 1×, and there is nothing after it.** Below
that the input cannot fill the table, part of it stays L1-resident, and
every engine reads high — jsCE SIMD by **1.8×** on RGB→Lab. Above it you
pay full cold-table interpolation, and then a 160× range of buffer sizes
(64 K → 10 M px) moves nothing at all. Both engines show the same shape,
which is what makes it a property of CLUT interpolation rather than of
either implementation.

Two consequences for anyone reproducing this:

- **1 M px is the right measurement size**, and 64 K px is not: it
  under-samples a 4D CLUT at 0.78× coverage and would have flattered
  every CMYK workflow.
- **A benchmark that quotes only a small buffer is quoting the L1 case.**
  This also corrects an earlier version of this page, which reported
  buffer size as a non-issue — true only because the input then in use
  was degenerate enough that coverage never changed.

## The pixel cache (beta)

`pixelCache` memoises the accuracy path — `buildLut: false`, the
single-colour pipeline, not the image kernels ⁽²⁾. It is measured
against **its own uncached baseline**, because the accuracy path is an
order of magnitude slower than the LUT kernels and a ratio across the
two would be meaningless.

256 K px, 32-slot table, MPx/s against the same transform with the cache
disabled:

| workflow | noise (0 % hits) | photo (~32 % hits) | gradient (75 %) | blocks16 (94 %) | solid (100 %) |
|---|---:|---:|---:|---:|---:|
| RGB → RGB (matrix) | −18 % | +4 % | +75 % | +168 % | +235 % |
| RGB → Lab | −16 % | +8 % | +87 % | +189 % | +244 % |
| RGB → CMYK | −10 % | **+12 %** | +117 % | +274 % | +387 % |
| CMYK → RGB | −17 % | +3 % | +95 % | +201 % | +294 % |
| CMYK → CMYK | −18 % | +2 % | +97 % | +188 % | +274 % |
| RGB → RGB (soft-proof) | −9 % | **+22 %** | +155 % | +441 % | **+820 %** |

**It is a bet on the content, and the tables say exactly what odds you
are getting.** When it never hits it costs 9–18 %. On the photo corpus —
32 % hit rate against only 8.6 % adjacency, so the table is catching
colours that recur later, not just neighbours — it returns between +2 %
and +22 %: real but small, and inside run-to-run noise for three of the
six workflows. On flat graphic content it is transformative.

Two things worth pulling out:

- **The longer the pipeline, the more a hit is worth.** Soft-proof is
  the slowest workflow here (2.7–3.2 MPx/s uncached, two profile
  conversions deep) and it gains the most from caching at every hit
  rate — +22 % on photographs and +820 % on solid colour. The cache
  skips whatever the pipeline would have done, so it pays in proportion
  to what that is.
- **A 32-slot table beats a single slot everywhere it matters.** On the
  photo corpus 1 slot is a net *loss* on five of six workflows (it only
  catches immediate repeats, at 8.6 % adjacency) while 32 slots wins.
  On highly repetitive content 1 slot is marginally faster, having less
  bookkeeping — but that is the case that was already winning.

So: **enable it for flat graphic and packaging work, leave it off for
photography**, and prefer a CMYK destination or a long chain if you are
deciding on the margin. It ships opt-in, off by default, and marked beta
because the kernel port is not done.

Full design, measurements and the three things building it proved wrong:
[deepdive/PixelCache.md](./deepdive/PixelCache.md).

## Not comparable — the rest of the landscape

These configurations exist and jsColorEngine has no equivalent. They are
listed so the whole picture is visible here rather than discovered
elsewhere, and so it is clear exactly which claim this page makes.

| configuration | jsColorEngine equivalent |
|---|---|
| lcms + `fast_float` plugin (GPL3) — ~455 MPx/s on RGB→RGB matrix, unchanged on LUT workflows | none — no SIMD-specialised float path |
| lcms + `threaded` plugin (GPL3) — slices the buffer across worker threads | none shipped — POC only, below |
| Closed-source commercial CMMs, including Marti Maria's own | none, and none possible — see below |
| GPU / other acceleration | none |

**`fast_float` and `threaded` are two separate plugins, not a "plugin
pack".** The distinction matters because they do unrelated things:
`fast_float` contains no threading code whatsoever, and `threaded`
contains no SIMD. Marti Maria's reported 1,200–1,600 MPx/s would need
both, so those figures are not single-core and do not belong against the
tables above.

`fast_float`'s contribution is worth being precise about, because it is
narrower than its reputation: fused format-specific transform paths, a
float32 pipeline, and SSE2 — where the SSE2 applies to **8-bit
matrix-shaper only** (`fast_8_matsh_sse.c`, gated behind
`CMS_DONT_USE_SSE2` in the dispatch chain). That is exactly why
`make fastfloat` moved lcms's RGB→RGB result to ~455 MPx/s and changed
*nothing* on the LUT workflows. Not an anomaly in our harness — the
dispatch order in `fast_float_sup.c`.

### The comparison is against what can actually be run

lcms is measured here in the only configurations anyone can obtain and
verify: the MIT core, plus optionally the two GPL3 plugins. **The
fastest colour engines in existence are closed-source commercial CMMs —
including Marti Maria's own — and they cannot be benchmarked, audited or
reproduced**, by us or by a reader checking our work. They are listed
above with no number attached, because quoting a figure nobody can
verify would be worse than plainly admitting the gap exists.

Two structural limits belong next to that, since they bound what this
project could *ever* claim:

- **WASM SIMD is 128-bit and cannot go wider.** lcms's SSE2 is also
  128-bit, so on matrix-shaper the two are level. But native code can
  reach for AVX2 (256-bit), AVX-512 (512-bit) or a GPU, and WebAssembly
  has no equivalent — "relaxed SIMD" is still 128 bits. For the record,
  lcms2 2.18 itself uses **no AVX at all**, in core or plugins.
- **So "faster than native C" is not a general claim and never will
  be.** It holds against stock open-source lcms2, on LUT workflows, on
  one core. It says nothing about the fastest colour transform that can
  be written in C, and we do not intend it to.

### One honest caveat on the LUT comparison

**Our ~2× on the LUT workflows is SIMD against scalar.** That is not a
rigged baseline — it is the fastest code lcms has for those paths, with
both plugins loaded — but no SIMD-vs-SIMD comparison was possible,
because **no open-source SIMD tetrahedral LUT kernel exists to test
against.**

The two engines turn out to have vectorised exactly complementary paths:

| path | lcms SIMD | jsCE SIMD |
|---|---|---|
| 8-bit matrix-shaper | ✅ SSE2 | ❌ — baked into a CLUT ⁽⁴⁾ |
| 3D / 4D tetrahedral LUT | ❌ scalar, even with `fast_float` | ✅ WASM SIMD |

Each vectorised precisely the path the other left scalar — which is also
why the one workflow lcms wins outright is the one where it has SIMD and
we do not.

## In progress

Measured but **not shipped**. Nothing here is a claim about v1.5 — it is
included so the roadmap is visible alongside the results motivating it.

**Both remaining gaps on this page have a named remedy, already
prototyped, and both are the next two pieces of work:**

| gap measured above | remedy | POC result |
|---|---|---|
| matrix-shaper RGB→RGB at 0.72× native ⁽⁴⁾ — the one workflow lcms wins outright, and the one where it has SIMD and we do not | **a fused matrix-shaper WASM kernel of our own** | 250–257 MPx/s |
| single-threaded only, where lcms has the `threaded` plugin | **our own multicore image path** | 5.46× on 16 threads |

Together those close the gap that this comparison identifies: the first
removes the only workflow where native C leads, and the second removes
the axis where lcms has an option and we have none. Both will be
measured in the next, more detailed comparison rather than asserted
here — the point of this page is that claims arrive with the harness
that produced them.

**Multicore (POC).** A worker-parallel image path using the public API
only, no engine changes: **5.46× peak** on 16 workers, output
byte-identical to single-threaded in every row.

| workers | MPx/s | speedup | efficiency |
|---:|---:|---:|---:|
| 1 | 41.8 | 0.95× | 95 % |
| 4 | 130.5 | 2.96× | 74 % |
| 8 | 189.6 | 4.30× | 54 % |
| 16 | 240.8 | 5.46× | 34 % |

Two findings worth recording. The copies a `SharedArrayBuffer` design
exists to eliminate cost only **4–7 %** of a pass, so the invasive model
is probably never worth building — the experiment meant to choose
between the two models chose the cheap one. And the crossover is **slice
size, not image size**: below roughly 64 K px per worker the split stops
paying. When workers are unavailable the same call falls back to running
images sequentially through `transformArray()`, so multicore stays an
optimisation rather than a capability.
[deepdive/multicore.md](./deepdive/multicore.md).

**Matrix-shaper kernel (POC).** The remedy for the one row where native
C is ahead ⁽⁴⁾. A dedicated WASM kernel reached 250–257 MPx/s but is not
yet packaged as a kernel descriptor or wired into `create()`.
[deepdive/MatrixShaperKernel.md](./deepdive/MatrixShaperKernel.md).

**Pixel cache in the image kernels (POC).** A 4D-kernel experiment
measured break-even at roughly a 10 % hit rate and up to +169 % on
repetitive content, but it is not wired to the dispatcher.
[deepdive/PixelCache.md](./deepdive/PixelCache.md).

## Why the numbers come out this way

The honest explanation, in both directions: **throughput here comes from
specialising the inner loop, not from the implementation language.**

- **jsCE specialises at LUT-build time.** One unrolled kernel per
  (dimension × channels × dataFormat), resolved once at `create()` and
  monomorphic at the call site. V8 compiles that to machine code
  comparable to `gcc -O3` output — the
  [JIT inspection deep dive](./deepdive/JitInspection.md) has the
  disassembly. The WASM SIMD tier then does four lanes at once, which is
  where the multiple over native comes from: not better scalar code,
  wider code.
- **Stock lcms2 stays general.** One stage-walker handling every pixel
  format, profile class and precision. That is exactly what you want
  from a reference implementation, and exactly what a compiler cannot
  specialise away.
- **Where lcms specialises, it wins.** Its fused matrix-shaper path
  beats our general pipeline on RGB→RGB ⁽⁴⁾, and its `fast_float` plugin
  takes that to ~455 MPx/s with SSE2 while changing nothing on the LUT
  workflows. Each engine wins exactly where it has specialised — and the
  two chose opposite paths, which is why the comparison has a clean
  split rather than a winner.

The same lesson explains the memo cache. lcms bets on the *input* being
repetitive; jsCE bets on the *kernel* being fast. On flat graphic content
lcms's bet pays and ours does not; on photographs neither bet pays, which
is why lcms's own cache is a net loss there and why ours ships off.

## Corrections on the record

Four errors have been found in our own measurements. All four are listed,
because a benchmark page that only ever gains numbers is not one to
trust — and because three of them were flattering *our* results.

**1. The accuracy oracle used the wrong flag.**
`cmsFLAGS_HIGHRESPRECALC` is a legacy lcms 1.x emulation path, not a
higher-precision mode. Against lcms's real default, agreement improved to
100 % within 1 LSB. *Effect: our accuracy result got better.*

**2. `-march=native` was handicapping lcms.** Every native figure we
previously published used it. Sweeping seven flag sets puts it at or near
the **bottom** on all six workflows. We now build lcms both ways and
quote its best per workflow ⁽³⁾. *Effect: native lcms is faster than we
said.*

**3. The "random noise" generator was not random.** Two defects stacked
in four lines:

- Transcribing the C generator's `seed * 1103515245` into JavaScript runs
  it in f64, past 2⁵³, silently losing the low bits and collapsing the
  sequence into short cycles. Measured adjacency: **21.6 %** — in the row
  whose whole purpose is to give lcms's memo cache *nothing*.
- Taking the **low** 8 bits of a linear congruential generator is a
  classic error: those bits have period 256. Adjacency still reads
  0.0 %, so the metric the harness printed looked perfect — but the
  buffer held only **256 distinct colours**. Against a 35,937-cell CLUT
  that touches a corner of the table and leaves it in L1. The row
  advertised as "the hardest case" was in fact the easiest.

Both fixed (`Math.imul`, and bits 23–30 — ~1,016,892 distinct colours per
megapixel at the same 0.0 % adjacency). *Effect: noise-row throughput
fell for **both** engines — jsCE's SIMD tier by roughly 45 %, native lcms
by 10–27 %. Every previously published noise figure on this page was
measured on a degenerate input.* This is also why the tables now carry a
`cover` column ⁽⁵⁾: adjacency cannot detect this class of error.

The correction has a built-in control. If the cause really is CLUT
working set, then the **matrix-shaper row — pure arithmetic, no
interpolation table — must not move at all**, and it does not: native
lcms measured 156.3 / 163.5 / 166.8 / 165.7 MPx/s across the content
classes before the fix and 156.0 / 164.5 / 165.8 / 165.4 after, while
RGB→Lab fell 24 % on the same change. That rules out a general slowdown
or a confounded harness, and it means figures for non-CLUT paths taken
on the old generator are still valid.

**4. A shared benchmark harness measured the wrong thing.** Running
several content rows through one long-lived process gave 59.5 MPx/s where
an isolated run of the identical workflow, content and buffer size gave
**75.4** — a 27 % swing caused only by which rows had already passed
through that call site. V8 specialises a call site to what it has seen;
five different buffers means it specialises for none, and warmup inside
that process does not undo it. Every cell is now measured in its own
process ⁽⁶⁾. *Effect: rows are now comparable to each other and to a
standalone run; before, they were not.*

## Reproduce it

**Every number on this page comes from one command:**

```bash
cd bench/release_matrix && npm install && cd ../..
node bench/reproduce.js
```

That runs all seven phases — corpus, accuracy, native lcms at both
builds, the JS content matrix, the size sweep, the per-image rows, the
pixel cache and the control bench — and writes each phase's raw output
to `bench/results/<timestamp>/`, alongside a `conditions.md` capturing
the CPU, compiler, versions and corpus that produced them. Roughly an
hour; `--quick` cuts it to about fifteen minutes at reduced coverage.

**Nothing else should be running.** These are timing measurements on a
pinned core — a background build will quietly corrupt them, which is not
hypothetical: a stray test run corrupted a native block during the first
release run and it had to be re-measured.

Useful subsets:

```bash
node bench/reproduce.js --only accuracy      # the half that matters most, ~2 min
node bench/reproduce.js --only js,solo       # no gcc/WSL needed
node bench/reproduce.js --with-flags         # add the CFLAGS sweep (slow)
node bench/reproduce.js --skip-native        # no Linux toolchain available
```

The individual harnesses can still be driven directly when you are
chasing one figure — see
[`bench/release_matrix/`](../bench/release_matrix/README.md) for the six
methodology rules it enforces, [`bench/solo_photo/`](../bench/solo_photo/README.md)
for the control, and [`bench/lcms_c/`](../bench/lcms_c/README.md) for the
native side.

If your numbers disagree with ours, open an issue with the raw output.
Methodology critiques are as welcome as results — this page is in its
current shape because one of them made the comparison more honest.

## What this page is not

A contest with LittleCMS. lcms is the reference implementation this
engine learned from, its author has been generous with corrections, and
several of the numbers above are worse for us than what we used to
publish. The comparisons exist to answer one question honestly: *how fast
can colour management go in JavaScript, and does it stay correct?*
