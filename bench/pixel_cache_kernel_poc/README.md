# Pixel cache in a hot kernel — POC

```bash
node bench/pixel_cache_kernel_poc/poc.js
```

Answers whether a pixel cache pays *inside* an unrolled kernel, as opposed
to the accuracy path measured in `bench/pixel_cache/`.

Target: DeviceLink CMYK→CMYK,
`tetrahedralInterp4DArray_4Ch_intLut_loop` — the best case identified in
[docs/deepdive/PixelCache.md](../../docs/deepdive/PixelCache.md): 4D
input (4.3 G distinct inputs, impossible to precompute) and 4-channel
output, so per-pixel work is the heaviest in the engine.

The cached variant is produced by **source-transforming the real kernel
at runtime** (`toString()` → insert → `new Function`), so the
interpolation cascade is guaranteed identical to production instead of
transcribed by hand. That also doubles as a live test of the codegen
idea from the design notes.

## Result

**Yes — and by a much wider margin than the accuracy path.**

| content | plain | cached (64) | change | hit rate |
|---|---:|---:|---:|---:|
| cmyk noise | 26.9 | 24.6 | −8 % | 0 % |
| photo → CMYK | 31.8 | 46.6 | **+47 %** | 57 % |
| photo → CMYK | 27.8 | 41.5 | **+49 %** | 53 % |
| poster → CMYK | 33.0 | 59.6 | **+81 %** | 73 % |
| cmyk gradient | 32.7 | 72.2 | +121 % | 75 % |
| cmyk solid | 32.3 | 151.4 | +368 % | 100 % |

Output verified byte-identical against the plain kernel in every case.

**Break-even is ~10 % hit rate**, against ~38–40 % on the accuracy path.
Three reasons it is so much better:

1. **No stage dispatch.** That was ~6.5 of the ~18 % accuracy-path tax
   and it simply does not exist here — the miss tax is 8 %.
2. **The key is one int32.** 4 channels × 8 bits packs exactly, so the
   check is a single `===` and the hash a single `imul` — against three
   float compares and three chained imuls on the accuracy path.
3. **A hit skips proportionally more.** The tetrahedral cascade is the
   bulk of the work, and all of it is skipped.

**And CMYK data is inherently more repetitive.** The same photographs
that hit only 3–41 % as RGB hit 43–70 % once separated to CMYK, because
the RGB→CMYK LUT quantises many source colours onto the same output.
So CMYK wins twice over — heavier per-pixel work *and* more repetition.

## Table size

Unlike the accuracy path, where 4096 slots cost no more than 32, size
does matter here — the kernel streams a large CLUT and competes for L1:

| slots | table | miss tax |
|---:|---:|---:|
| 16–256 | 0.2–3 KB | −7 to −8 % |
| 1024 | 12 KB | −17 % |

**64–256 is the range to use.**

## Caveats

- 8-bit only. For u16 or float input the key does not pack into 32 bits
  and none of the above applies; a dispatcher would select the plain loop.
- No alpha handling was exercised.
- One DeviceLink, one kernel, one machine. This is a POC, not a
  validated feature — nothing here should reach a published claim until
  it is landed properly with tests.
