# Per-release measurements

```
bench/history/<version>/<machine-id>/
    BenchResults.md     the generated page exactly as it read at release
    conditions.md       machine, compiler and library versions
    json/*.json         the measured rows — any published figure re-derivable
    SNAPSHOT.json       run id, machine detail, date, whether tests passed
```

Written by `npm run release-snapshot`. `npm run publish` refuses to build
without one for the current version (`--allow-missing` to override, visibly).

## Why keep it

`docs/BenchResults.md` always describes the newest run, so it says what the
engine does *now* and nothing about what 1.4 did. The raw JSON behind it lives
in `bench/results/`, which is gitignored and machine-local — lose the folder and
a number published in a release can never be checked again.

~120 KB per release per machine. That buys an answer to "was 1.5.5 actually
faster than 1.5.0, or did the machine change?", which prose cannot answer and
which is the question that gets asked.

## Per machine, and why that matters

Throughput is a property of the box at least as much as of the code. The same
release measured on a Ryzen 7700X and on an M2 mini are both true and neither
supersedes the other, so they sit side by side rather than one overwriting the
other.

```bash
# right: two versions, one machine — this measures the engine
node scripts/bench_compare.js \
  bench/history/1.6.0/darwin-arm64-apple-m2 \
  --vs bench/history/1.5.5/darwin-arm64-apple-m2

# hardware, not code — the tool says so rather than reporting it as regression
node scripts/bench_compare.js \
  bench/history/1.5.5/darwin-arm64-apple-m2 \
  --vs bench/history/1.5.5/win32-x64-amd-ryzen-7-7700x-8-core
```

The one figure that *does* travel across machines is a **ratio measured within a
single run** — `ratioVsLcms`, or a pool speedup — because both halves met the
same CPU on the same day. Absolute MPx/s does not travel, which is the whole
reason these are filed separately.

## Adding a machine

Pull the repo, run the bench, snapshot it. Nothing needs to be configured — the
machine id is derived from platform, arch and CPU model:

```bash
node bench/reproduce.js
node scripts/release_snapshot.js --from bench/results/<run>
```

Then, if that machine is going to gate refactors as well as record releases,
give it a pin too — see `bench/baseline/README.md`.

## Never edit a snapshot

It is the record of what a version measured. If it looks wrong, the answer is a
new measurement in a new folder, not a corrected old one.
