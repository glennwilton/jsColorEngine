#!/usr/bin/env bash
# bench/lcms_c/fetch-lcms2.sh
# ============================
#
# Downloads the lcms2 source tree into bench/lcms_c/lcms2-<ver>/
# ready for `make` to pick up. The repo ships the bench glue
# (bench_lcms.c / Makefile / README) but NOT the ~11 MB upstream
# source tree — fetch it once with this script.
#
# Usage (from bench/lcms_c/):
#   ./fetch-lcms2.sh                   # default version (2.18)
#   ./fetch-lcms2.sh 2.17              # pin to a specific version
#
# Requires: curl + tar (both standard on WSL2 / macOS / most Linuxes).

set -euo pipefail

VERSION="${1:-2.18}"
DIR="lcms2-${VERSION}"
URL="https://github.com/mm2/Little-CMS/releases/download/lcms${VERSION}/lcms2-${VERSION}.tar.gz"
TARBALL="lcms2-${VERSION}.tar.gz"

if [ -d "$DIR" ]; then
    echo "[fetch-lcms2] $DIR/ already exists — skipping download."
    echo "[fetch-lcms2] Delete it and re-run if you want a clean copy."
    exit 0
fi

echo "[fetch-lcms2] Downloading $URL ..."
curl -fL -o "$TARBALL" "$URL"

echo "[fetch-lcms2] Extracting ..."
tar -xzf "$TARBALL"
rm -f "$TARBALL"

if [ ! -d "$DIR" ]; then
    echo "[fetch-lcms2] ERROR: expected $DIR/ after extract but didn't find it." >&2
    exit 2
fi

echo "[fetch-lcms2] Done. Now run:  make"
