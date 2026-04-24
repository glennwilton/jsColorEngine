# bench/lcms_c/fetch-lcms2.ps1
# =============================
#
# Windows PowerShell equivalent of fetch-lcms2.sh — downloads the
# lcms2 source tree into bench/lcms_c/lcms2-<ver>/ ready for the
# Makefile to pick up.
#
# Usage (from bench/lcms_c/):
#   .\fetch-lcms2.ps1            # default 2.18
#   .\fetch-lcms2.ps1 -Version 2.17
#
# Requires: PowerShell 5+ (Expand-Archive, Invoke-WebRequest built in).

param(
    [string]$Version = "2.18"
)

$ErrorActionPreference = "Stop"

$Dir     = "lcms2-$Version"
$Url     = "https://github.com/mm2/Little-CMS/releases/download/lcms$Version/lcms2-$Version.tar.gz"
$Tarball = "lcms2-$Version.tar.gz"

if (Test-Path $Dir) {
    Write-Host "[fetch-lcms2] $Dir/ already exists — skipping download."
    Write-Host "[fetch-lcms2] Delete it and re-run if you want a clean copy."
    exit 0
}

Write-Host "[fetch-lcms2] Downloading $Url ..."
Invoke-WebRequest -Uri $Url -OutFile $Tarball

Write-Host "[fetch-lcms2] Extracting ..."
# PowerShell 5 doesn't understand .tar.gz natively; shell out to tar
# which ships with modern Windows 10+ and all MSYS2 / WSL2 setups.
tar -xzf $Tarball
Remove-Item $Tarball

if (-Not (Test-Path $Dir)) {
    Write-Error "[fetch-lcms2] expected $Dir/ after extract but didn't find it."
    exit 2
}

Write-Host "[fetch-lcms2] Done. Now run:  mingw32-make   (or WSL2:  make)"
