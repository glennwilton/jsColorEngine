# The pinned baseline

`BASELINE.json` names one measured run. `json/` is that run's rows, verbatim.
`conditions.md` is the machine it was measured on.

## Why a pin and not "the last run"

Gating a change against whatever ran most recently is a ratchet that only turns
one way. Seven refactor phases at 1.5% each is 11% slower, with every single
step passing its gate and nothing in the history showing a fault. The pin is
the fixed point that makes accumulated drift visible.

```bash
node scripts/bench_compare.js                    # newest run vs this pin
node scripts/bench_compare.js <run> --vs <other> # any two, for diagnosis
```

Comparing against the previous run is still useful — it tells you *which step*
did it. It is the diagnosis. The pin is the gate.

## How the comparison decides

- **Gated** — jsColorEngine's own throughput columns. These fail the build.
- **Control** — `lcmsWasm`, `lcmsWasmNoCache`, native. Little CMS measured in
  the same process on the same content, which no jsCE refactor can touch. When
  the control columns swing as far as ours did, the machine moved and the run
  is a re-measurement, not a finding. The tool sets its noise floor from them
  rather than making you eyeball it.
- **Accuracy** — `*MaxLsb`, `*MeanLsb`, `*Over1Pct`. **Zero tolerance.** A
  refactor that quietly changes rounding is the failure worth catching, and it
  will never show up as a throughput number.

## Moving the pin

Only deliberately, and only for a reason that is written down in
`BASELINE.json`: a new machine, a new Node major, or a shipped optimisation
that is meant to change the numbers.

**Never to make a failing comparison pass.** If a phase regresses, the answer
is the phase, not the pin.

## When one phase joins later

`BASELINE.json` normally records a single run. It can also carry an
`addedLater` block, and `small-dim.json` is currently in it.

The 1- and 2-channel bench did not exist when the main run was pinned, so it
had no baseline and never gated — it ran, printed, and was ignored. Pinning it
through `pin_baseline.js` would have rewritten `run:` and `why:` to describe a
smalldim-only run, losing the provenance of the eleven files that came from the
full 8-phase measurement. Re-running everything to pin one new phase would have
moved the baseline for eleven files that had no reason to move.

So it was measured on its own, on the same machine with nothing else running,
and recorded separately. **A baseline assembled from more than one run should
say so** — that is the whole point of pinning rather than drifting, and a
manifest that quietly claims one provenance for two measurements is worse than
no manifest.

The next full re-pin folds it back in and the block disappears.

## Related

- `bench/history/<version>/` — per-release snapshots. History, not a control:
  frozen at release so an old figure can still be re-derived. Written by
  `node scripts/release_snapshot.js`.
- `docs/BenchResults.md` — the generated page, always describing the newest run.
- `docs/deepdive/KernelContract.md` — the migration this pin currently gates.
