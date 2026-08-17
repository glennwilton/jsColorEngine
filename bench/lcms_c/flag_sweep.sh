#!/bin/bash
# Find the best CFLAGS for lcms2 ON THIS MACHINE, before any comparison.
#
# A speed comparison is only worth publishing if the other engine got its best
# build. Our Makefile has always used -march=native, but a first pass suggested
# that is actually SLOWER here than plain -O3 on the RGB workflows — which
# would mean we have been handicapping lcms rather than steelmanning it.
#
# Measures `noise` content with the memo cache OFF: no cache hits to confound
# it, so the figure is the transform's real throughput and nothing else.
# Iteration counts inside the harness auto-scale to ~400 ms per batch and
# report a median of 5, so the numbers are stable enough to choose on.
#
# Run from bench/lcms_c/ inside WSL:  bash flag_sweep.sh
# Takes a few minutes. Put the winner in the Makefile and record it in the
# conditions block of docs/LcmsComparison.md.
set -e
cd "$(dirname "$0")"

SIZE=${SIZE:-1048576}
BIN=/tmp/bm_flagsweep

FLAGSETS=(
    "-O2"
    "-O3"
    "-O3 -DNDEBUG -fno-strict-aliasing"
    "-O3 -march=native"
    "-O3 -DNDEBUG -march=native -fno-strict-aliasing"
    "-O3 -DNDEBUG -march=native -fno-strict-aliasing -funroll-loops"
    "-O3 -DNDEBUG -march=native -ffast-math -funroll-loops -flto"
)

echo "======================================================================"
echo " lcms2 CFLAGS sweep — noise content, cache OFF (pure transform speed)"
echo " $SIZE px/iter, median of 5, higher is better"
echo "======================================================================"
lscpu 2>/dev/null | grep -E "^Model name" | sed 's/  */ /g' || true
gcc --version | head -1
echo ""

for F in "${FLAGSETS[@]}"; do
    printf '%-58s' "$F"
    if ! gcc $F -std=c99 -I lcms2-2.18/include -o "$BIN" \
            bench_content_matrix.c lcms2-2.18/src/*.c -lm 2>/dev/null; then
        echo "  BUILD FAILED"
        continue
    fi
    echo ""
    "$BIN" --sizes "$SIZE" --content noise 2>/dev/null \
        | awk '/^ (RGB|CMYK)/     { wf=$0 }
               /^ +off +[0-9]/    { printf "    %-16s %8.1f MPx/s\n", wf, $NF }'
    echo ""
done

echo "Pick the fastest set, update the Makefile CFLAGS, and record it in the"
echo "conditions block of docs/LcmsComparison.md. Give lcms its best build."
