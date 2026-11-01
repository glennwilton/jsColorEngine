# Photo corpus — sources and licence

Five photographs, committed so the comparison in
[`docs/LcmsComparison.md`](../../../docs/LcmsComparison.md) is reproducible by
anyone who clones the repo. A benchmark whose input cannot be obtained is not
a benchmark, and the alternative — "we measured some photos" — is exactly the
kind of unfalsifiable claim this project tries not to make.

All five are from [Unsplash](https://unsplash.com) under the
[Unsplash License](https://unsplash.com/license): free to use, including
commercially, no permission needed. Attribution is not required but is given
here because it costs nothing and the photographers earned it.

| file | photographer | content class |
|---|---|---|
| `annie-spratt-askpr0s66Rg-unsplash-PHOTO_OF_TEXT_ON_PAGE.jpg` | [Annie Spratt](https://unsplash.com/@anniespratt) | photographed print — near-monochrome, few distinct colours |
| `jacek-dylag-559115_STRAWBERRIES-unsplash.jpg` | [Jacek Dylag](https://unsplash.com/@dylu) | saturated close-up |
| `library-of-congress-tqpsi_BPfC_ILLUSTRATIONI-unsplash.jpg` | [Library of Congress](https://unsplash.com/@libraryofcongress) | period illustration — flat art, high adjacency |
| `melanie-kreutz-hMMc7mvb34A-unsplash_SUNFLOWER.jpg` | [Melanie Kreutz](https://unsplash.com/@mellikre) | natural subject, mid colour spread |
| `rod-long-4dcsLxQxSHY-unsplash_BEACH.jpg` | [Rod Long](https://unsplash.com/@rodlong) | landscape — widest colour spread of the set |

## Why these five

They were chosen to span the axis that turned out to matter, which is **how
many distinct colours a frame carries**, not how repetitive it is:

| image | adjacency | distinct colours (1 M px) |
|---|---:|---:|
| printed page | 10.3 % | 6,429 |
| period illustration | 42.0 % | 71,661 |
| sunflower | 14.6 % | 116,552 |
| strawberries | 16.1 % | 152,752 |
| beach | 6.9 % | 229,716 |

That is a 36× range in CLUT working set across images whose adjacency ranges
only 6.9–42 %. The beach frame has the *lowest* adjacency and the *most*
colours, which is why it is the slowest to convert — see
[LcmsComparison § Throughput by content](../../../docs/LcmsComparison.md#throughput-by-content).

They are downscaled to roughly 1 MP each (~1.1 MB total) because the harness
tiles them to whatever buffer size it needs; full-resolution originals would
add tens of megabytes to the repository and change nothing about the result.

## What this corpus is not

Five images from one source is a *sample*, not a statistically representative
corpus of photography, and the page says so. It is enough to show that real
frames cluster tightly (109–132 MPx/s) where synthetic generators sprawl
(96–190), and enough to falsify the claim that throughput tracks adjacency.
Drawing tighter conclusions than that would need a real corpus.

Point `make_corpus.cjs --src <dir>` at your own images to check your content.

## Regenerating

```bash
node bench/release_matrix/make_corpus.cjs
```

Decodes each image once and writes raw interleaved `.rgb.bin` and `.cmyk.bin`
planes into `../corpus/` (gitignored — ~27 MB of derived data). Both the Node
and the native C harness read those planes, so both measure identical bytes.
