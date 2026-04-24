# JIT inspection — measured, not assumed

**jsColorEngine docs:**
[← Project README](../../README.md) ·
[Bench](../Bench.md) ·
[Performance](../Performance.md) ·
[Roadmap](../Roadmap.md) ·
[Examples](../Examples.md) ·
[API: Profile](../Profile.md) ·
[Transform](../Transform.md) ·
[Loader](../Loader.md)

**Deep Dive:**
[← Index](./README.md) ·
[Architecture](./Architecture.md) ·
[LUT modes](./LutModes.md) ·
[WASM kernels](./WasmKernels.md)

---

The performance story of `lutMode: 'int'` rests on three assumptions about V8:

1. The kernels are actually promoted to TurboFan (not stuck in the Ignition
   interpreter or Sparkplug baseline after warmup).
2. V8 emits pure int32 arithmetic — not boxed `HeapNumber` / float64.
3. Real-world inputs don't cause the JIT to deopt, throwing away the
   specialised code.

If any of these is wrong, the whole design is wrong. So we verified them
directly using V8's native APIs, not by inference. Run the bench yourself
any time with:

```
node --allow-natives-syntax bench/jit_inspection.js
```

**Measured result (Node 20.13 / V8 11.3, Windows x64, 2026-04):**

All eight hot kernels (four `_intLut_loop` integer kernels and four
`*Array_*Ch_loop` float kernels) are confirmed:

- **Tier**: TurboFan (best tier) on all eight, after warmup.
- **Deopts during `transformArray`**: zero on both families.
- **Numerical-domain purity** confirmed from `--print-opt-code`
  disassembly — int kernels use zero float ops, float kernels keep their
  math in XMM registers and never convert to int:

| Kernel | `imul` | `add` | `sub` | shifts | `mulsd` | `addsd` | `subsd` | conv. | runtime |
|---|---|---|---|---|---|---|---|---|---|
| 3D 3Ch INT (RGB→RGB) | 34 | 58 | 27 | 24 | **0** | **0** | **0** | 0 | 0 |
| 3D 4Ch INT (RGB→CMYK) | 181 | 74 | 36 | 30 | **0** | **0** | **0** | 0 | 0 |
| 4D 3Ch INT (CMYK→RGB) | 251 | 125 | 64 | 65 | **0** | **0** | **0** | 0 | 0 |
| 4D 4Ch INT (CMYK→CMYK) | 92 | 158 | 85 | 84 | **0** | **0** | **0** | 0 | 0 |
| 3D 3Ch FLT (RGB→RGB) | 3 | 53 | 1 | 0 | 40 | 27 | 30 | 0 | 0 |
| 3D 4Ch FLT (RGB→CMYK) | 3 | 66 | 1 | 0 | 52 | 36 | 39 | 0 | 0 |
| 4D 3Ch FLT (CMYK→RGB) | 4 | 98 | 2 | 0 | 80 | 63 | 67 | 0 | 0 |
| 4D 4Ch FLT (CMYK→CMYK) | 6 | 122 | 2 | 0 | 106 | 85 | 88 | 0 | 1* |

<small>*The single CallRuntime in 4D 4Ch FLT is a deopt-guard on a
rarely-taken edge; it's not in the per-pixel hot path.</small>

Zero conversion ops (`cvtss2sd`, `cvtsd2si`, etc.) in any kernel means V8
never bounces a value between the integer and float domains inside the
loop — the domain choice is committed at compile time. Op counts scale
with kernel complexity, confirming the hand-unrolled tetrahedral branches
in the source survive TurboFan and aren't being collapsed back into a loop.

## Working-set size — does the unroll fit in L1i?

Emitted machine code sizes (from V8's `Instructions (size = ...)` header):

| Kernel | Code size | % of 32 KB L1i |
|---|---|---|
| 3D 3Ch INT | 4.5 KB | 14 % |
| 3D 4Ch INT | 5.4 KB | 17 % |
| 4D 3Ch INT | 7.6 KB | 24 % |
| 4D 4Ch INT | 9.4 KB | 30 % |
| 3D 3Ch FLT | 4.7 KB | 15 % |
| 3D 4Ch FLT | 5.6 KB | 17 % |
| 4D 3Ch FLT | 8.6 KB | 27 % |
| 4D 4Ch FLT | 10.8 KB | **34 %** |

Every kernel sits comfortably in the 32 KB L1 instruction cache that has
been standard since Core 2 Duo (2008). Even the largest — 4D 4Ch
CMYK→CMYK float kernel with all six tetrahedral cases unrolled inline —
uses only 34 % of L1i on a modern chip. Int kernels run 4-13 % smaller
than their float counterparts (integer immediates encode in fewer bytes
than the equivalent float-load sequences). On Apple M-series with 192 KB
L1i the kernels are effectively invisible.

The actual *hot path* through any one pixel is smaller still (one of six
tetrahedral branches is taken, not all six), so the cold-branch bytes
don't compete for L1i during a typical tight row sweep.

**The unroll pays for itself on modern CPUs precisely *because* the
working set fits L1i.** Re-rolling back to a `switch` would save ~5 KB of
code but introduce one or two branch mispredicts per pixel (rx/ry/rz/rk
magnitudes vary between neighbours → ~50 % misprediction rate × ~15–20
cycles per miss). On anything built in the last 15 years the unroll
wins. This is the "counter-intuitive unroll" mentioned in the README
`## How it works` callout — documented here with real numbers so
future-us doesn't tidy the source in a way that trades a 5 KB L1i saving
for 5–10 cycles of branch penalty per pixel.

## Instruction-mix breakdown — what is V8 actually spending time on?

From `bench/jit_asm_boundscheck.ps1` against the same dump, isolated per
optimised-code block:

| Kernel | Total inst | Compute¹ | Data moves² | Safety³ | Tight bounds-check pairs⁴ |
|---|---|---|---|---|---|
| 3D 3Ch INT | 668 | **24.7 %** | 39.7 % | 21.6 % | 7.0 % |
| 3D 4Ch INT | 799 | **43.7 %** | 38.7 % | 22.0 % | 7.5 % |
| 4D 3Ch INT | 1,155 | **47.1 %** | 36.4 % | 20.0 % | 7.1 % |
| 4D 4Ch INT | 1,422 | 33.1 % | 36.7 % | 20.2 % | 7.5 % |
| 3D 3Ch FLT | 722 | 21.3 % | 29.5 % | 20.6 % | 6.0 % |
| 3D 4Ch FLT | 860 | 22.9 % | 28.4 % | 21.2 % | 6.5 % |
| 4D 3Ch FLT | 1,299 | 24.2 % | 32.3 % | 19.2 % | 5.9 % |
| 4D 4Ch FLT | 1,611 | 25.4 % | 32.8 % | 19.1 % | 6.3 % |

<small>¹ `imul`+`add`+`sub`+shifts+LEA (int kernels) or `mulsd`+`addsd`+`subsd`+int32 indexing (float kernels).
² All mov-class instructions: `movl`/`movq`/`movzx` (int) + `movsd`/`movss` (float).
³ `cmp` + `test` + unsigned jumps — upper bound on safety/bounds machinery.
⁴ `cmp` immediately followed by `ja`/`jae`/`jnc` — canonical bounds-check signature.</small>

**Five findings that shape the WASM / ARM roadmap:**

1. **Int kernels are 7-12 % smaller and ~1.5-2× more compute-dense than
   their float counterparts.** Matches the ~10-15 % real-world speedup we
   see for `lutMode: 'int'` — the gain comes from needing fewer
   instructions per pixel, not a shorter critical path.

2. **Bounds checks are ~6-8 % of instructions, not "a big penalty".**
   V8's bounds-check elimination is good — it hoists the proof out of
   tight loops and only keeps checks for computed-index reads (e.g.
   `CLUT[base + X*go0 + Y*go1 + Z*go2]`). The branches that remain are
   near-zero runtime cost because they're always-not-taken and predicted
   perfectly after the first pixel. WASM's guard-page memory model removes
   this overhead entirely, but the ceiling win from that alone is only
   ~3-4 % of runtime.

2b. **Overflow checks (`jo`) are 7.9-8.5 % of every kernel — more than
   the bounds checks.** V8 speculatively compiles `a + b` or `a * b` as
   signed int32 arithmetic and emits `jo bailout` after each op to deopt
   if the speculation overflows (JS `Number` is float64; int32 is only
   ever V8 guessing). `Math.imul` is the one exception — it *contractually*
   wraps, so V8 emits it without the `jo`. Overflow checks appear in BOTH
   int AND float kernels because the base-pointer/index arithmetic uses
   plain `+`/`*`. **WASM eliminates these entirely** — `i32.add`, `i32.mul`,
   etc. are defined to wrap by spec, no guard needed.

   Combined WASM-eliminatable safety (bounds + overflow):

   | Kernel | Bounds % | Overflow % | Combined |
   |---|---|---|---|
   | 3D 3Ch INT | 7.0 % | 7.9 % | 14.9 % |
   | 4D 4Ch INT | 7.5 % | 8.5 % | **16.0 %** |
   | 3D 3Ch FLT | 6.0 % | 8.3 % | 14.3 % |
   | 4D 4Ch FLT | 6.3 % | 8.2 % | 14.5 % |

   That's ~15 % of instructions WASM would delete just from safety
   elimination alone. Combined with reduced spill pressure (WASM's
   linear-memory aliasing rules let the compiler pin pointers in
   registers), the realistic WASM-scalar-over-`'int'` speedup lands
   around **1.4-1.6×**, not the 1.3× we initially estimated.

3. **Data moves dominate both families** — 30-40 % of every kernel — and
   most of those moves are *spills*, not real memory traffic. See the
   spill analysis below; this is the biggest untapped optimisation lever.

4. **Float kernels have measurably LESS GPR pressure than int kernels at
   3D** (see spill table below), because float values live in XMM
   registers which are a separate file from the GPRs. At 4D both families
   saturate the GPRs anyway, so the advantage evaporates.

5. **`subsd` exists in the float kernels** (absent from int, because
   `sub` is used instead). That's expected — float subtraction is a
   distinct x86 instruction, not `addsd` with a negated operand.

## Move classification — spills vs real memory traffic

From `bench/jit_asm_spillcheck.ps1`:

| Kernel | Moves | Spill traffic⁵ | Real heap I/O⁶ | Reg-to-reg |
|---|---|---|---|---|
| 3D 3Ch INT | 265 | **47.5 %** | 25.3 % | 8.3 % |
| 3D 4Ch INT | 309 | **50.2 %** | 24.9 % | 7.1 % |
| 4D 3Ch INT | 420 | **49.5 %** | 24.8 % | 6.0 % |
| 4D 4Ch INT | 522 | **52.3 %** | 23.8 % | 5.7 % |
| 3D 3Ch FLT | 213 | 36.6 % | 34.3 % | 3.3 % |
| 3D 4Ch FLT | 244 | 36.9 % | 35.2 % | 2.9 % |
| 4D 3Ch FLT | 420 | **50.2 %** | 31.2 % | 3.1 % |
| 4D 4Ch FLT | 528 | **52.7 %** | 30.5 % | 2.7 % |

<small>⁵ Moves to/from the `[rbp±N]` / `[rsp±N]` frame slots — register
spills V8 inserted because it ran out of registers.
⁶ Moves to/from a non-stack address — TypedArray loads/stores, the work
we actually want.</small>

**Two striking findings:**

1. **Between 36 % and 53 % of every mov is a stack spill.** V8 ran out of
   GPRs (x86-64 has 16; V8 reserves ~5, leaving ~11 allocatable; the
   kernel wants ~13-15 live simultaneously: `rx/ry/rz`, `c0/c1/c2`, up to
   four `base` pointers, `outputPos/outputEnd`, two TypedArray base
   pointers, 1-2 temps). Reloads outnumber stores ~1.3×, the fingerprint
   of long-lived values (weights, channel shifts) being parked once and
   pulled back multiple times.

2. **Float kernels at 3D show measurably less GPR pressure** (36-37 %
   spill rate) than int kernels at 3D (47-50 %). Float values live in
   XMM0-XMM15 — a separate 16-register file — so arithmetic intermediates
   don't compete for GPRs with pointers, indices, and counters. At 4D
   this advantage evaporates because the 4-axis grid bookkeeping alone
   (4 weights + 4 bases + 4 index temps) is enough to saturate the GPRs
   regardless of the numerical domain.

### Implications for future work

- **ARM64 (Apple M-series, modern Cortex-A) has 31 GPRs.** V8 keeps ~26
  allocatable, vs ~11 on x86-64. Our 13-15 value working set fits with
  huge headroom — register pressure should largely *vanish* on ARM.
  Measuring on an M1/M4 would quantify how much of our current cost is
  x86-specific, and is the obvious next experiment. Expected outcome:
  spill rate drops from ~50 % to single-digits on the 3D kernels, perhaps
  10-20 % on the 4D kernels (still more live values than allocatable
  registers, but far less acute).
- **WASM scalar on x86-64** wins here too, and perhaps more than we
  initially credited. WASM's linear memory is a single base pointer with
  no aliasing constraints, so the WASM compiler can pin the
  CLUT/output/input pointers in registers freeing ~2 GPRs. That alone
  probably accounts for more of the 1.84× POC speedup than the
  bounds-check elimination does.
- **Candidate JS-level experiments** (for a future release, measured in a
  branch with a dedicated bench):
  - Load `c0/c1/c2` just-in-time per channel rather than upfront — +3
    heap loads per pixel, −6 to −9 spill/reload pairs.
  - Re-order the CLUT reads to narrow each value's live range — pull
    loads closer to use *without* introducing named temps (named temps
    *worsen* spills; see PERFORMANCE LESSONS in `src/Transform.js`).
  - Probable ceiling is 10-20 % on top of current `'int'`, or zero if
    V8's allocator is already at the local optimum. Worth testing,
    worth being ready for "no effect" as the answer.

**Compute is only 9-18 %, so the kernel is memory-move-bound, not ALU-bound.**
This refines the SIMD expectation: vectorising the *arithmetic* alone
gives a max ~`0.14 × 4 = 56 %` theoretical speedup on compute, not the
usual "4× SIMD dream". The big SIMD win has to come from vectorising
**moves** — loading 4 CLUT cells with one `v128.load`, doing the
interpolation chain across 4 cells in parallel, storing 4 outputs with
one `v128.store`. Which works great *when the 4 cells are contiguous*,
and degrades to 4 scalar loads when they aren't (SIMD gathers on x64
pre-AVX2 are slow, and the POC showed this directly — WASM SIMD with
gathers ran *slower* than WASM scalar).

## Runtime-safe languages, bounds checks, and the "unsafe" escape hatch

A tangential but useful framing: every runtime-safe language has this
tension. C# has `unsafe` + `fixed`. Rust has `unsafe` + `get_unchecked`.
Swift has `withUnsafeBufferPointer`. WASM has guard pages (safety
implemented by the OS via `mprotect`, not per-access checks).
**JavaScript is unusual in having no opt-out** — every TypedArray access
*must* be bounds-checked (or proved safe by the JIT, which it does for
well-shaped loops).

For our kernels the "well-shaped loop" proof works ~95 % of the time —
we're only paying for the 4-5 % that V8 can't hoist. The remaining
bounds checks are the price of not having an unsafe API, and on modern
CPUs it's a price the branch predictor pays on our behalf.

If we ever find ourselves wanting `CLUT.getUnchecked(i)` semantics in JS,
the practical answer is "ship it as WASM" — same effect, portable, and
already on the v1.2/v1.3 roadmap.

## The core line — side-by-side with V8's emitted x64

**TL;DR** — V8's TurboFan really does lower this JavaScript to tight,
inline x64. The hot body of the float core line is 14 SSE/AVX double ops
with no spills, no boxing, no allocations, no function-call overhead; the
integer core line is 14 GPR ops built from `imull` + `leal` + `sarl` with
one `jo` overflow guard. If you printed the two assemblies with the
filenames blanked you could not reliably tell which one came from C and
which came from JS. Where engines like V8 used to be the reason numeric
JS was slow, on monomorphic typed-array code paths they are now the
reason it is fast. Everything below is the evidence for that claim — the
actual emitted instructions, not a benchmark number asking you to trust us.

The skeptical reading of every section above is *"op-counts and
percentages are suggestive but you're trusting a regex to classify
instructions."* Fair. So here is the actual emitted x64 for the single
most load-bearing line in the whole engine, captured from a focused
microbench (`bench/jit_asm_core_line.js`) that isolates just that
expression in a tight loop so V8 emits a ~1 KB function whose body maps
1:1 back to the source — no kernel-dispatch noise, no tetrahedral branch
selection, just the arithmetic.

The lines chosen are the K-LERP "output channel 0" case from the 4D 3Ch
(CMYK→RGB) kernels (`src/Transform.js` line 9444 float, 10093 int),
because this is the hottest line in the hottest kernel and the int
version is also where the u20 Q16.4 single-rounding design shows up —
the bit the v1.1 release was built around.

### Float kernel — `lutMode: 'float'` — `src/Transform.js:9444`

```javascript
a = CLUT[base2++];
b = CLUT[base3++];
output[outputPos++] = (o0 + ((( d0 + ((CLUT[base1++] - a) * rx)
                     + ((b - d0) * ry) + ((a - b) * rz) ) - o0) * rk)) * outputScale;
```

The pure-math hot body V8 emits inside the main loop (addresses from
`bench/jit_asm_core_dump.txt`, `name = floatCoreLine`, TurboFan, loop
offsets `+0x502`..`+0x537`):

```
+0x502  c5235cd8            vsubsd xmm11,xmm11,xmm0       ; CLUT[base1++] - a
+0x506  c52b5ce4            vsubsd xmm12,xmm10,xmm4       ; b - d0
+0x50a  c4416359db          vmulsd xmm11,xmm3,xmm11       ; * rx
+0x50f  c4c17b5cc2          vsubsd xmm0,xmm0,xmm10        ; a - b
+0x514  c4415359d4          vmulsd xmm10,xmm5,xmm12       ; * ry
+0x519  c52358dc            vaddsd xmm11,xmm11,xmm4       ; + d0
+0x51d  c5cb59c0            vmulsd xmm0,xmm6,xmm0         ; * rz
+0x521  c4412b58d3          vaddsd xmm10,xmm10,xmm11      ; sum term1+term2
+0x526  c4c17b58c2          vaddsd xmm0,xmm0,xmm10        ; + term3 = K1
+0x52b  c5fb5cc7            vsubsd xmm0,xmm0,xmm7         ; K1 - o0
+0x52f  c5bb59c0            vmulsd xmm0,xmm8,xmm0         ; * rk
+0x533  c5fb58c7            vaddsd xmm0,xmm0,xmm7         ; + o0
+0x537  c5b359c0            vmulsd xmm0,xmm9,xmm0         ; * outputScale
```

**13 XMM float64 ops.** Followed by `vroundsd` + `vcvttsd2si` + `movb` to
quantise and store as `u8` through the `Uint8ClampedArray` view. Each
`vmulsd`/`vaddsd`/`vsubsd` has a 3–4 cycle latency on Skylake-class x64,
pipelined, so the dependency chain (not the total op count) is what
limits throughput.

### Integer kernel — `lutMode: 'int'` — `src/Transform.js:10093`

```javascript
a = CLUT[base1++]; b = CLUT[base2++];
output[outputPos++] = ((o0 << 8) + Math.imul(((d0 << 4)
                     + ((Math.imul(a - d0, rx) + Math.imul(b - a, ry)
                     + Math.imul(CLUT[base4++] - b, rz) + 0x08) >> 4)) - o0, rk)
                     + 0x80000) >> 20;
```

The corresponding x64 hot body (`name = intCoreLine`, TurboFan, offsets
`+0x4c5`..`+0x515` — three `movzxwl` `u16` loads happen immediately before
this block):

```
+0x4c5  4c8bc7              movq  r8, rdi                 ; r8 = b
+0x4c8  452bc6              subl  r8, r14                 ; b - a
+0x4cb  442bb570ffffff      subl  r14, [rbp-0x90]         ; a - d0
+0x4d2  2bd7                subl  rdx, rdi                ; CLUT[base4] - b
+0x4d4  8bbd78ffffff        movl  rdi, [rbp-0x88]         ; reload ry
+0x4da  410faff8            imull rdi, r8                 ; (b-a) * ry
+0x4de  448b4580            movl  r8,  [rbp-0x80]         ; reload rx
+0x4e2  450fafc6            imull r8,  r14                ; (a-d0) * rx
+0x4e6  448b7588            movl  r14, [rbp-0x78]         ; reload rz
+0x4ea  440faff2            imull r14, rdx                ; (CLUT[base4]-b) * rz
+0x4ee  418d1438            leal  rdx, [r8+rdi]           ; sum12
+0x4f2  418d541608          leal  rdx, [r14+rdx+0x8]      ; + term3 + rounding bias
+0x4f7  c1fa04              sarl  rdx, 4                  ; >> 4   (Q16.4 collapse)
+0x4fa  03d1                addl  rdx, rcx                ; + (d0<<4)         = K1_u20
+0x4fc  0f8060020000        jo    <deopt>                 ; int32-overflow guard
+0x502  4429e2              subl  rdx, r12                ; - o0
+0x505  448b45a0            movl  r8,  [rbp-0x60]         ; reload rk
+0x509  440fafc2            imull r8,  rdx                ; * rk
+0x50d  418d943000000800    leal  rdx, [r8+rsi+0x80000]   ; + (o0<<8) + round bias
+0x515  c1fa14              sarl  rdx, 20                 ; >> 20   → final u8
```

**3 `subl` + 3 `imull` + 2 `leal` + 1 `sarl` + 1 `addl` + 1 `subl` +
1 `imull` + 1 `leal` + 1 `sarl` = 14 arithmetic ops.** Plus 4 spill-reload
`movl`s for the weights (`rx`/`ry`/`rz`/`rk`) and `r8 = rdi` copy (the
kernel wants ~14 live values, GPRs run out at ~11 — see spill analysis
above). Every arithmetic op is 1-cycle int32 throughput on Skylake-class
x64; the `imull`s are 3 cycles *latency* but 1 cycle *throughput* so
pipelined they're cheap. The critical dependency chain through this block
is shorter than the float chain above, which is most of where the measured
10-15% speedup comes from.

**Note the single `jo` overflow guard at +0x4fc.** This is the "V8 is
speculatively compiling `+`/`-` as signed int32 arithmetic" machinery from
the instruction-mix breakdown above — V8 emits exactly ONE `jo` per plain
`+`/`-` block because the u20 design guarantees everything fits in int32
by construction. `Math.imul` contractually wraps, so the three `imull`s
produce no `jo`. WASM would remove even that last `jo` entirely
(`i32.add` wraps by spec). The lack of `cmp`/`ja` bounds-check pairs on
the three CLUT loads (`movzxwl`) confirms V8's BCE hoisted the index-range
proof out of the loop — the loads are direct.

### What this rules out

- "Math.imul is slow": no, it compiles to a single `imull` register op.
- "`>> 20` is a software divide": no, it's a 1-cycle `sarl`.
- "The u20 encoding needs a 64-bit multiply": no, `imull rdx,r32` gives a
  32-bit×32-bit→low32 result and V8 picks exactly that because the u20
  domain guarantees it fits.
- "The `Uint8ClampedArray` store is implicit `Math.round` + clamp in JS":
  not quite — on the int path V8 emits `cmp $0xff / jle / cmovl` style
  clamp + plain `movb`; no `vroundsd`/`vcvttsd2si` conversion needed
  because the value is already int.
- "V8 deopts back to float midway through the loop": no, this block is
  int32 end-to-end. No `vcvtsi2sd` or `vcvttsd2si` appears in the int
  hot body. Confirmed zero int↔float conversions in the op table above.

The dump file the snippets above were extracted from is ~660 KB and
reproducible in under a second:

```
node --allow-natives-syntax --print-opt-code --code-comments \
     bench/jit_asm_core_line.js 2>&1 > bench/jit_asm_core_dump.txt
```

Search the dump for `name = floatCoreLine` and `name = intCoreLine`.
Each function emits ~1.9–2.0 KB of x64, of which the hot body shown here
is ~50–60 bytes. The surrounding ~300 bytes of prolog / type-guards /
iteration setup are identical to what the real 4D 3Ch kernel emits for
the same line (verified against `bench/jit_asm_dump.txt` with the full
`transformArrayViaLUT` path wired in), just without the 5 other
tetrahedral cases and the 3-channel unroll that fattens the real kernel
to 7.6 / 8.6 KB.

## Does "named temps hurt"? — a micro-test that is *not* the final word

The `PERFORMANCE LESSONS` comment at the top of `src/Transform.js`
(written around the original 2019-era speed-test campaign) claims:

> DO NOT EXTRACT INTERMEDIATE LOCALS in hot expressions. ... Verified
> empirically on these interpolators (~15-25% regression when intermediate
> vars were introduced).

Folklore that has shaped every line of the hot path. We have *not*
re-measured that at full-kernel scale on modern V8 — the 2019 speed
tests that produced that number were against the full unrolled 6-branch
tetrahedral kernel, not a single line. The microbench used above is the
wrong tool for reproducing (or refuting) that historical result, because
it exercises just one expression at ~11 live values, whereas the kernel
it was distilled from operates at ~14+ live values across 6 × 3 × 2
unrolled branches — a different register-pressure regime, different spill
budget, different L1i footprint.

What we *can* do with the existing microbench is check whether V8's
modern register allocator at least *handles* the common-subexpression
form well at low pressure. Same process, same JIT pipeline, same asm
dump — worth a quick measurement as a sanity check on the core-line
finding, NOT as a decision on the full-kernel question.

The microbench includes "readable" variants of both core lines that
break the expression across named `const`s:

```javascript
function intCoreLineTemps(CLUT, output, ...){
    for(let i = 0; i < length; i++){
        const a = CLUT[base1++];
        const b = CLUT[base2++];
        const c = CLUT[base4++];
        const term1 = Math.imul(a - d0, rx);
        const term2 = Math.imul(b - a, ry);
        const term3 = Math.imul(c - b, rz);
        const k1_u20 = (d0 << 4) + ((term1 + term2 + term3 + 0x08) >> 4);
        const lerp = Math.imul(k1_u20 - o0, rk);
        const final = ((o0 << 8) + lerp + 0x80000) >> 20;
        output[outputPos++] = final;
    }
}
```

Measured four-way, same process, median of 5 × 200 iters, after 500-iter
warmup on top of the 2000-iter joint warmup (Node 20.13.1, V8 11.3,
Windows x64):

| Variant | MPx/s (median of 4 runs) | vs "one expression" |
|---|---|---|
| `floatCoreLine`      | 390.0 | 1.00× (baseline) |
| `floatCoreLineTemps` | 397.9 | **+2.0 % faster** |
| `intCoreLine`        | 364.4 | 1.00× (baseline) |
| `intCoreLineTemps`   | 386.8 | **+6.1 % faster** |

At the microbench's ~11-live-value scale, the named-temps version is
**slightly faster**, not slower. Margins are small (2 % on the float path,
6 % on the int path), consistent across four runs, but this is a
low-register-pressure scenario where V8's coloring has headroom that
simply doesn't exist inside the real kernel.

Reading the x64 side-by-side (int path, main loop body, same naming):

```
intCoreLine (in-place expression, hot body)      intCoreLineTemps (named temps, hot body)
-----------------------------------------------  --------------------------------------------
subl  r8,  r14                                   subl  r11, r9
subl  r14, [rbp-0x90]   ; a - d0 (from stack)    subl  r9,  [rbp-0x90]   ; a - d0 (from stack)
subl  rdx, rdi                                   subl  rcx, rdi
imull rdi, r8           ; (b-a)*ry               imull rdi, r11          ; (b-a)*ry
imull r8,  r14          ; (a-d0)*rx              imull r11, r9           ; (a-d0)*rx
imull r14, rdx          ; (CLUT-b)*rz            imull r9,  rcx          ; (CLUT-b)*rz
leal  rdx, [r8+rdi]                              leal  rcx, [r11+rdi]
leal  rdx, [r14+rdx+0x8]                         leal  rcx, [r9+rcx+0x8]
sarl  rdx, 4                                     sarl  rcx, 4
addl  rdx, rcx          ; + (d0<<4)  [REG]       addl  rcx, [rbp-0x70]   ; + (d0<<4) [STACK]
jo    <deopt>                                    jo    <deopt>
subl  rdx, r12          ; - o0       [REG]       subl  rcx, [rbp-0x68]   ; - o0      [STACK]
imull r8,  rdx          ; * rk                   imull r11, rcx          ; * rk
leal  rdx, [r8+rsi+0x80000]                      leal  rcx, [r11+r12+0x80000]
sarl  rdx, 20                                    sarl  rcx, 20
```

**Same 14 arithmetic ops in both.** The temps version has **two extra
stack-load micro-ops** in the hot body (`addl reg,[mem]` and `subl reg,[mem]`
at the "+(d0<<4)" and "-o0" steps, where the original keeps those values
in `rcx`/`r12` across iterations). Naive reading of "memory is slower than
register" predicts temps must be slower. Naive reading is wrong. Why:

1. **The total emitted code is 20 bytes *smaller*** for the temps version
   (1900 B vs 1920 B for the int path). V8's register allocator picks a
   less conflict-heavy coloring when SSA values are explicitly named,
   producing fewer reg-to-reg `mov` copies elsewhere in the loop and
   fewer save/restore spills at loop-back / peeled-iteration boundaries.

2. **`addl reg, [rbp-N]` and `subl reg, [rbp-N]` are load-op fused
   instructions** — a single decoder slot, splitting internally into a
   load µop (4-cycle L1 hit, repeatedly the same hot stack slot so
   effectively always in the store-forwarding buffer = ~1 cycle) and an
   ALU µop. The out-of-order core overlaps both with the surrounding
   arithmetic. Net cost on a hot stack slot is close to zero cycles.

3. **Keeping `d0<<4` and `o0` pinned in GPRs across iterations** (what the
   "one expression" form does) *consumes* two GPRs, which then have to be
   spilled around any sub-expression that wants more scratch registers —
   the net spill count across the whole loop goes up, not down.

**This does not overturn `PERFORMANCE LESSONS #2` in `src/Transform.js`.**
What it tells us is narrower: at ~11-live-value scale, on the TurboFan
allocator, the named-temps form doesn't *intrinsically* regress. That's a
useful floor — but the 2019 measurement was at full-kernel scale, and we
have solid reasons to believe the full kernel still reproduces the old
finding:

1. **Register pressure compounds, non-linearly.** The 4D 3Ch int kernel
   has ~14 simultaneously-live values *before* you add named temps; the
   GPR file has ~11 allocatable slots. Every additional SSA name you
   force the allocator to track is one more value that has to share those
   ~11 slots. Once you're past the knee of the curve, *each* new name
   adds a spill-store AND a spill-reload AND forces a live-range split
   somewhere else — the cost doesn't grow linearly with the number of
   temps, it grows with the number of *simultaneous* live ranges that
   can't be colored. The microbench sits comfortably below that knee;
   the kernel sits on top of it.

2. **The unroll multiplies spill traffic.** The real kernel unrolls the
   tetrahedral case × the 3 output channels × the 2 K-planes. If adding
   temps creates 1 extra spill per expression, the kernel emits that
   spill 6 × 3 × 2 = 36 times per pixel. A 1 % cost at microbench scale
   becomes a 20 %+ cost when that single extra spill fires once per
   unrolled leaf.

3. **L1i pressure shifts.** The temps version of the microbench is 20
   bytes smaller, which is great for a 2 KB function sitting at 0.006 %
   of a 32 KB L1i. The full int kernel is 7.6 KB (24 % of L1i); a 1 %
   growth there is a real fraction of the cache budget, and the 4D 4Ch
   FLT kernel is already at 34 % — there is no slack. Any code-size
   growth tips into the next line.

4. **The 2019 bench measured the right thing.** It compared `const`-ified
   kernel code against the in-place form, on the then-current V8, across
   ~30 MPx of real image data. That's exactly the scale where (1)-(3)
   hit. The 15-25 % number was most likely real, and probably still real
   on modern TurboFan for the same reasons it was real then — the
   architectural constraints haven't changed even if the allocator got
   better.

The honest framing for future-us: **the rule "don't extract locals in hot
expressions" is an *operating-pressure* rule, not a universal one.** In
low-pressure toy loops V8 handles temps fine. In the hot kernel the rule
probably still saves 10-20 %. Until someone runs the experiment at
full-kernel scale — either a branch with one tetrahedral case rewritten
using `const` temps and benched against the current in-place form through
`bench/mpx_summary.js`, or a fuller synthetic that reproduces the
kernel's live-value count — the microbench result above is **a companion
data point**, not a green light to refactor.

For the current release the production source stays in-line-expression.
The comment in `src/Transform.js` stays. If someone wants to open that
question, the right experiment is:

1. Pick ONE tetrahedral branch in `tetrahedralInterp4DArray_3Ch_intLut_loop`
   (the `rx >= ry && ry >= rz` block is the obvious candidate — it's the
   one whose core line is dissected above).
2. Clone it into a second function with all three channels written via
   named `const` intermediaries.
3. Measure both via `bench/mpx_summary.js` through the real dispatcher,
   200+ iter medians, at least 3 runs, on at least two CPUs (x86 + ARM).
4. Re-run the asm analyses (`jit_asm_boundscheck.ps1`,
   `jit_asm_spillcheck.ps1`) on the rewrite and compare spill counts, L1i
   footprint, and op density.

If that experiment comes back neutral-or-faster, the comment updates and
the kernel gets a readability pass. If it reproduces the 2019 regression,
the comment gets pinned with the new measurements next to the old ones
and the lesson survives another release cycle.

## If you want to verify yourself

Every number in this page is reproducible with shipped tooling. The
benches live in [`bench/`](../../bench/) and all of them run in seconds
from a stock Node 20 install:

```bash
# Op-count and instruction-mix tables
node --allow-natives-syntax bench/jit_inspection.js

# Full asm dump (~660 KB text file)
node --allow-natives-syntax --print-opt-code --code-comments \
     bench/jit_asm_core_line.js 2>&1 > bench/jit_asm_core_dump.txt

# Spill / bounds-check classifiers (PowerShell)
pwsh bench/jit_asm_boundscheck.ps1 bench/jit_asm_core_dump.txt
pwsh bench/jit_asm_spillcheck.ps1 bench/jit_asm_core_dump.txt

# Throughput (MPx/s) across all four lutModes
node bench/mpx_summary.js
```

If your numbers differ meaningfully, we want to know — open an issue with
your CPU, OS, Node version, and the `jit_inspection.js` output attached.
The op counts in particular are a repeatable signature; they shouldn't
change release-to-release unless V8 itself changes TurboFan lowering, and
watching them shift is a good early warning that a future V8 rewrite
might affect us.

## Related

- [WASM kernels](./WasmKernels.md) — how the findings on this page drove
  the v1.2 WASM scalar and SIMD design
- [LUT modes](./LutModes.md) — the engineering decisions (u16 scaling,
  Q0.16 weights, u20 single-rounding) that produce the hot lines
  dissected here
- [Architecture](./Architecture.md) — the pipeline / LUT / kernel stack
  these hot lines sit inside
- [Performance](../Performance.md) — measured MPx/s and direction-by-
  direction throughput
