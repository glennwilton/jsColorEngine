# Security policy

## What this project is

jsColorEngine is a colour management library: it parses ICC profiles and
transforms pixel data. It runs in Node and in the browser, in-process, on data
the host application hands it.

The repository also contains benchmark harnesses (`bench/`), a comparison
testbed (`testbed/`), and samples (`samples/`). None of these are published to
npm — the package is `src/` only, 64 files — but they are not all the same
kind of thing, and reports are treated differently for each. See below.

## The real attack surface

**Parsing an ICC profile you did not create.** `src/decodeICC.js` and
`src/Profile.js` read a binary format with self-describing tag tables, offsets
and lengths. A profile is data from wherever the host got it: an uploaded
image, a downloaded asset, a document. That is the boundary worth defending,
and reports there are genuinely welcome:

- out-of-bounds reads from malformed tag offsets or lengths
- unbounded allocation driven by header-declared sizes
- infinite loops or pathological runtimes on crafted input
- prototype pollution through parsed profile metadata
- anything that turns a malformed profile into a crash, a hang, or memory
  disclosure in the host process

Transform code reachable from a parsed profile counts too — a crafted CLUT or
curve that drives an out-of-range index, for instance.

## Samples — welcome, but low severity

`samples/` is different from the rest of the tooling. It exists for other
developers to run, read and copy into their own projects — the LUT builder, the
TIFF CLI, the ICCImage wrapper. Code that people paste into their own
applications is worth getting right, so **issues against samples are welcome**.

They are triaged as low severity, because nothing there runs as part of the
engine: a sample is not reachable from `require('jscolorengine')`, is not in
the published package, and only executes when a developer deliberately runs it
on their own machine. Fixes land in ordinary maintenance rather than urgently.

If a sample demonstrates a pattern that would be unsafe when copied — building
a path from unvalidated input, say, or a parser that trusts its input shape —
that is worth reporting even though the sample itself is harmless where it
sits. That is the case where a sample bug can become somebody else's real bug.

## What is out of scope

**`bench/` and `testbed/` are not a security boundary.** They are programs a
developer compiles and invokes with arguments they type, against corpora they
generate on their own machine. Reports that assume an attacker controls a
benchmark's command line, its pixel counts, or its input files describe a
situation where the attacker is already running code as the developer, and will
be closed.

Concretely, and to save anyone the trouble of re-reporting:

- unchecked arithmetic before allocation in `bench/lcms_c/*.c`, where the
  sizes come from a `--sizes` flag the developer types
- `strtok` rather than `strtok_r` in single-threaded argument parsing
- CVEs in transitive devDependencies or in the private, unpublished
  proof-of-concept packages under `bench/`

**Dependency advisories against build and benchmark tooling are not a
priority and will not be treated as urgent.** The published package is `src/`
only; a CVE in a package that exists solely to compile a bundle, run the test
suite, or drive a local benchmark cannot reach anyone who installs
jsColorEngine. Such advisories get picked up during ordinary maintenance,
alongside whatever else is being done — not on the clock a security report
would otherwise imply. Advisories affecting a runtime dependency, or anything
reachable from the published files, are a different matter and are treated as
in scope.

Please also note that changes to benchmark code are held to an unusual
standard: these harnesses produce the published throughput figures, so a change
that alters timing — pre-faulting buffers by swapping `malloc` for `calloc`
inside a measurement loop, for example — is a correctness regression in this
repository even when it would be harmless anywhere else. See
[`bench/baseline/README.md`](bench/baseline/README.md).

## Automated reports

Scanner-generated pull requests are welcome if the finding is in scope, but
please:

- state the threat model in your own words, not just a CWE number and a
  severity label — "an attacker who can supply an ICC profile can …" is a
  report we can act on; "likely exploitable" against a local benchmark is not
- open an issue before a pull request for anything touching `bench/`
- do not bundle unrelated refactors with a fix

Severity assigned by a scanner is treated as a starting point, not a
conclusion. A finding is assessed on whether the described attacker can
actually reach the described code.

## Reporting

Open a [security advisory](https://github.com/glennwilton/jsColorEngine/security/advisories/new)
for anything in the "real attack surface" section above, or an ordinary issue
if you are unsure whether it qualifies. There is no bounty programme.

Please include the profile or input that triggers it where you can — a
malformed profile is small, and it is the difference between a report we can
reproduce in a minute and one we cannot.

## Supported versions

The latest published release. This is a small project; fixes land on `main` and
ship in the next release rather than being backported.
