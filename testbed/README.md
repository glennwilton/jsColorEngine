# testbed

Stage-level comparison harness against Little CMS: build a transform from a
pair of ICC profiles, run a reference patch set through both engines, and diff
the results per stage rather than only at the end.

## What is here and what is not

Tracked: the harness itself (`TransformTests.js`, `tests.js`, `lcms.tests.js`,
`GATCS.js`, `ImageWorker.js`, the browser pages).

Not tracked, and deliberately:

- **`profiles/`** — ICC profiles are licensed artefacts and most of what ships
  in a real prepress workflow cannot be redistributed on a public repo. Supply
  your own licensed copies; `profiles/README.md` names what the harness expects
  and where the freely-available ones come from.
- **`testData/`** — the reference `.it8` measurements, which are *derived* from
  those profiles by running lcms against them. Whether derived measurement data
  inherits the restriction is unsettled, so it is treated as if it does.
  Generate them locally from your own profiles.

Same split as [`bench/lcms_compat/`](../bench/lcms_compat/), for the same
reason.

## Where this is going

The current harness expects a fixed set of filenames, which makes it awkward to
point at a library that is not the one it was written against. The intended
shape is a testbed that **reads whatever folder of profiles it is given**,
enumerates the pairs, generates the reference set, and reports the comparison —
so anyone can run it against their own licensed library rather than needing
ours. That also removes the reason to check any profile-derived data in at all.
