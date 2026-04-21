# Parse bench/jit_asm_dump.txt and count int32 vs float64 ops in each
# hot-path kernel (both `_intLut_loop` integer kernels and the float
# `*Array_*Ch_loop` kernels). For int kernels we EXPECT pure int32;
# for float kernels we EXPECT pure float64. The "verdict" adapts.
#
# Run AFTER generating the dump with:
#   node --allow-natives-syntax --print-opt-code --code-comments bench/jit_inspection.js 2>&1 > bench/jit_asm_dump.txt

$content = Get-Content bench/jit_asm_dump.txt -Raw

# V8 prints each optimised function as a `--- Optimized code ---` block.
# Split the whole dump on that marker so we can isolate one function's
# disassembly at a time — otherwise a non-greedy match bleeds across
# block boundaries and includes adjacent (or nested inlined) code.
$blocks = $content -split '--- Optimized code ---'

$kernels = @(
    'tetrahedralInterp3DArray_3Ch_intLut_loop',
    'tetrahedralInterp3DArray_4Ch_intLut_loop',
    'tetrahedralInterp4DArray_3Ch_intLut_loop',
    'tetrahedralInterp4DArray_4Ch_intLut_loop',
    'tetrahedralInterp3DArray_3Ch_loop',
    'tetrahedralInterp3DArray_4Ch_loop',
    'tetrahedralInterp4DArray_3Ch_loop',
    'tetrahedralInterp4DArray_4Ch_loop'
)

foreach ($k in $kernels) {
    $isIntKernel = $k -match '_intLut_loop$'

    # Find the block that names THIS kernel. Anchor on the exact name
    # followed by a non-word char, so `_3Ch_loop` does not match
    # `_3Ch_intLut_loop`. V8 may emit multiple optimised versions of the
    # same function over a run (re-opts); take the LAST one.
    $body = $null
    for ($i = $blocks.Count - 1; $i -ge 0; $i--) {
        if ($blocks[$i] -match ('(?m)^name = ' + [regex]::Escape($k) + '(?![\w])')) {
            $body = $blocks[$i]
            break
        }
    }
    if (-not $body) {
        Write-Host ('NOT FOUND: ' + $k) -ForegroundColor Yellow
        continue
    }
    $bodySize = $body.Length

    # Int32 instructions
    $imul    = ([regex]::Matches($body, '\bimul[lq]?\b')).Count
    $add32   = ([regex]::Matches($body, '\baddl\b')).Count
    $sub32   = ([regex]::Matches($body, '\bsubl\b')).Count
    $shifts  = ([regex]::Matches($body, '\b(sarl|shrl|shll)\b')).Count

    # Float64 instructions
    $mulsd   = ([regex]::Matches($body, '\bv?mulsd\b')).Count
    $addsd   = ([regex]::Matches($body, '\bv?addsd\b')).Count
    $subsd   = ([regex]::Matches($body, '\bv?subsd\b')).Count

    # Conversions — normal at ABI boundaries; lots inside the loop
    # would be worrying for int kernels (indicates float/int round-trips).
    $cvt     = ([regex]::Matches($body, '\bcvt[a-z0-9]+\b')).Count

    # Runtime calls (very bad — means V8 gave up and called into C++)
    $callrt  = ([regex]::Matches($body, 'CallRuntime|Call.*Builtin.*BinaryOp')).Count

    $int32Total = $imul + $add32 + $sub32 + $shifts
    $floatTotal = $mulsd + $addsd + $subsd

    if ($isIntKernel) {
        # INT kernel — expect pure int32, zero float.
        $verdict = if ($floatTotal -eq 0 -and $callrt -eq 0 -and $int32Total -gt 10) {
            'INT32-SPECIALISED (expected)'
        } elseif ($floatTotal -gt 0) {
            'INT kernel with FLOAT ops - investigate'
        } else {
            'MIXED - investigate'
        }
    } else {
        # FLOAT kernel — expect pure float64, with a handful of int32
        # ops for indexing (base + X*stride, output position++, etc).
        $verdict = if ($floatTotal -gt 10 -and $callrt -eq 0) {
            'FLOAT64-SPECIALISED (expected)'
        } elseif ($floatTotal -eq 0) {
            'FLOAT kernel with NO float ops - investigate'
        } elseif ($callrt -gt 0) {
            'FLOAT kernel with runtime calls - investigate'
        } else {
            'MIXED - investigate'
        }
    }

    $kindTag = if ($isIntKernel) { '[INT  ]' } else { '[FLOAT]' }
    Write-Host ('=' * 74)
    Write-Host ('  ' + $kindTag + ' ' + $k)
    Write-Host ('=' * 74)
    Write-Host ('  disassembly size : {0} bytes' -f $bodySize)
    Write-Host ('  int32 ops        : imul={0}  add={1}  sub={2}  shifts={3}  (total {4})' -f $imul, $add32, $sub32, $shifts, $int32Total)
    Write-Host ('  float64 ops      : mulsd={0}  addsd={1}  subsd={2}  (total {3})' -f $mulsd, $addsd, $subsd, $floatTotal)
    Write-Host ('  conversions      : cvt*={0}' -f $cvt)
    Write-Host ('  runtime calls    : {0}' -f $callrt)
    Write-Host ('  verdict          : {0}' -f $verdict)
    Write-Host ''
}
