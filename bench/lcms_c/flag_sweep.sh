#!/bin/bash
# Does -march=native help or hurt lcms2 here?
#
# Our published native-lcms figures were produced with the Makefile's
# CFLAGS (-O3 -DNDEBUG -march=native -fno-strict-aliasing). A plain -O3
# build measured noticeably faster on RGB->CMYK, which would mean the
# comparison has been handicapping lcms rather than steelmanning it.
# This isolates each flag.
#
# Run from bench/lcms_c/ inside WSL:  bash flag_sweep.sh
set -e
cd "$(dirname "$0")"
cp ../../__tests__/GRACoL2006_Coated1v2.icc /tmp/ 2>/dev/null || true

run() {
    echo "### CFLAGS: $1"
    gcc $1 -std=c99 -DIMAGE_WIDTH=256 -DIMAGE_HEIGHT=256 \
        -I lcms2-2.18/include -o /tmp/bm_sweep \
        bench_content_matrix.c lcms2-2.18/src/*.c -lm 2>/dev/null
    ( cd /tmp && ./bm_sweep | sed -n '8,12p' )
    echo ""
}

run "-O3"
run "-O2"
run "-O3 -march=native"
run "-O3 -DNDEBUG -march=native -fno-strict-aliasing"

echo "### CPU"
lscpu | grep -E "Model name|Flags" | cut -c1-160
