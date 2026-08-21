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

## Related

- `bench/history/<version>/` — per-release snapshots. History, not a control:
  frozen at release so an old figure can still be re-derived. Written by
  `node scripts/release_snapshot.js`.
- `docs/BenchResults.md` — the generated page, always describing the newest run.
- `docs/deepdive/KernelContract.md` — the migration this pin currently gates.
