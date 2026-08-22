# The Good, The Bad and The Ugly — archived

Hidden from `samples/`. Schrödinger's Bench lesson:
[benchmark.md §20](../benchmark.md#20-schrödingers-bench-bites-back--the-failed-reproduction).

The page is a failed attempt to show a 100 / 175 / 200 MPx/s call-shape
split in isolation. V8 inlined all three. That result still holds.

The **pixels** do not. Input is the old 256-colour LCG (`seed & 0xff`)
— L1-resident, labelled noise. Do not quote these MPx/s against the
photo with 5 % noise added headline bench.

Open [`index.html`](./index.html) via `npm run serve`
(`http://localhost:8080/docs/deepdive/good-bad-ugly/`).
