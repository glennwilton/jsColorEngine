# Approximate bounds-check density in each integer hot-path kernel.
#
# This is an APPROXIMATION. We can't perfectly identify which `cmp`
# instructions are bounds checks because V8 doesn't annotate them in the
# --print-opt-code output. But we CAN count pattern candidates and get a
# reasonable ceiling on how much of the emitted code is safety machinery
# versus actual compute:
#
#   `cmp` + `ja` (or `jae`, `jnc`)  followed by a TypedArray load
#      = classic bounds-check pattern
#
# Some `cmp`s are for genuine program logic (e.g. loop-exit, case
# selection in the tetrahedral switch), so we report two numbers:
#
#   - TOTAL cmp count       (upper bound on safety overhead)
#   - cmp IMMEDIATELY followed by unsigned jump (ja/jae/jnc)
#     (tighter lower bound on bounds-check count)
#
# The delta between the two is mostly the tetrahedral case-selection
# branches, which ARE real program logic we want to keep.
#
# The important ratio is: (cmp + cond_jumps) / total_instructions.
# If it's < 10%, bounds checks aren't the dominant non-compute cost.
# If it's > 25%, WASM scalar has a real headroom play.

$content = Get-Content bench/jit_asm_dump.txt -Raw

# Split on the block delimiter so each kernel's disassembly is isolated.
# A non-greedy regex that spans block boundaries would bleed into
# adjacent functions' code and yield nonsense counts.
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

Write-Host ''
Write-Host 'Bounds-check density analysis (approximate — see script header)'
Write-Host '---------------------------------------------------------------------'

foreach ($k in $kernels) {
    # Find the LAST block that names THIS kernel. V8 may emit multiple
    # optimised versions; the last one is the current live code.
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

    # Total emitted instructions. Each instruction line in V8's dump
    # looks like:
    #   00007FF5E0E47E52   812  2b9d28feffff         subl rbx,[rbp-0x1d8]
    # i.e. <16-hex-addr> <hex-offset> <hex-bytes> <mnemonic>
    # We match any line starting with a 16-char hex address.
    $instLines = [regex]::Matches($body, '(?m)^[0-9a-fA-F]{8,16}\s+[0-9a-fA-F]+\s+[0-9a-fA-F]+\s+[a-z]')
    $totalInst = $instLines.Count

    # Arithmetic heart — the compute we WANT. Count both int32 and
    # float64 forms so int kernels and float kernels are measured on
    # comparable terms.
    $imul    = ([regex]::Matches($body, '\bimul[lq]?\b')).Count
    $add32   = ([regex]::Matches($body, '\baddl\b')).Count
    $sub32   = ([regex]::Matches($body, '\bsubl\b')).Count
    $shifts  = ([regex]::Matches($body, '\b(sarl|shrl|shll)\b')).Count
    $lea     = ([regex]::Matches($body, '\bleal\b')).Count
    $fmul    = ([regex]::Matches($body, '\b(v?mulsd|v?mulss)\b')).Count
    $fadd    = ([regex]::Matches($body, '\b(v?addsd|v?addss|v?subsd|v?subss)\b')).Count
    $fcvt    = ([regex]::Matches($body, '\b(cvt[a-z0-9]+)\b')).Count
    $mov     = ([regex]::Matches($body,
        '\b(movl|movq|movzx|movsx|movzxbl|movzxwl|v?movsd|v?movss|movap[ds]|movup[ds])\b')).Count

    # Safety / control machinery — the "bounds-check surface" candidates.
    $cmp       = ([regex]::Matches($body, '\bcmp[lq]?\b')).Count
    $test      = ([regex]::Matches($body, '\btest[lq]?\b')).Count

    # Conditional jumps. Unsigned (ja/jae/jb/jbe/jnc) are the typical
    # bounds-check exit; signed (jg/jge/jl/jle) and equality (je/jne)
    # are usually real program logic.
    $ja_jae    = ([regex]::Matches($body, '\b(ja|jae|jnc|jc|jb|jbe)\b')).Count
    $je_jne    = ([regex]::Matches($body, '\b(je|jne|jz|jnz)\b')).Count
    $jsigned   = ([regex]::Matches($body, '\b(jg|jge|jl|jle|js|jns)\b')).Count
    $jmp       = ([regex]::Matches($body, '\bjmp\b')).Count

    # Overflow / no-overflow jumps. V8 emits `jo bailout` after
    # speculative signed int32 arithmetic (`imull`/`addl`/`subl`)
    # when it's not sure the operation stays in int32 range. These
    # are near-zero runtime cost (predicted not-taken) but ARE
    # instructions WASM would eliminate entirely — WASM i32 math
    # is defined to wrap on overflow, no guard needed.
    $jo        = ([regex]::Matches($body, '\b(jo|jno)\b')).Count

    # Tighter "cmp immediately followed by unsigned jump" — the canonical
    # bounds-check signature.
    $cmpThenUJmp = ([regex]::Matches($body, '(?m)\bcmp[lq]?\b[^\n]*\n[^\n]*\b(ja|jae|jnc|jc|jb|jbe)\b')).Count

    $safetyTotal = $cmp + $test + $ja_jae
    $intCompute  = $imul + $add32 + $sub32 + $shifts + $lea
    $fltCompute  = $fmul + $fadd + $fcvt
    $computeTotal = $intCompute + $fltCompute

    $safetyPct = if ($totalInst -gt 0) { [math]::Round(100 * $safetyTotal / $totalInst, 1) } else { 0 }
    $computePct = if ($totalInst -gt 0) { [math]::Round(100 * $computeTotal / $totalInst, 1) } else { 0 }
    $boundsPct = if ($totalInst -gt 0) { [math]::Round(100 * $cmpThenUJmp / $totalInst, 1) } else { 0 }

    $kind = if ($k -match '_intLut_loop$') { 'INT  ' } else { 'FLOAT' }

    Write-Host ''
    Write-Host ('=== [' + $kind + '] ' + $k + ' ===')
    Write-Host ('  Total instructions              : {0,6:N0}' -f $totalInst)
    Write-Host ('  Compute TOTAL                   : {0,6:N0}   {1,5:N1}%  <- the arithmetic we want' -f $computeTotal, $computePct)
    Write-Host ('     int32 (imul/add/sub/shift/lea): {0,6:N0}' -f $intCompute)
    Write-Host ('     float (mulsd/addsd/subsd)    : {0,6:N0}' -f ($fmul + $fadd))
    Write-Host ('     int<->float conversions      : {0,6:N0}' -f $fcvt)
    Write-Host ('  Data moves (mov* + movsd)       : {0,6:N0}' -f $mov)
    Write-Host ('  Safety (cmp/test + unsigned jmp): {0,6:N0}   {1,5:N1}%  <- UPPER BOUND on bounds-check overhead' -f $safetyTotal, $safetyPct)
    Write-Host ('    cmp + unsigned-jump pairs     : {0,6:N0}   {1,5:N1}%  <- tighter bounds-check signature' -f $cmpThenUJmp, $boundsPct)
    Write-Host ('  Equality jumps (je/jne)         : {0,6:N0}           <- mostly real program logic' -f $je_jne)
    Write-Host ('  Signed jumps                    : {0,6:N0}           <- loop exits / case selection' -f $jsigned)
    Write-Host ('  Unconditional jmp               : {0,6:N0}' -f $jmp)
    $joPct = if ($totalInst -gt 0) { [math]::Round(100 * $jo / $totalInst, 1) } else { 0 }
    Write-Host ('  Overflow checks (jo/jno)        : {0,6:N0}   {1,5:N1}%  <- WASM eliminates these (i32 math wraps)' -f $jo, $joPct)
}

Write-Host ''
Write-Host '---------------------------------------------------------------------'
Write-Host 'Interpretation:'
Write-Host '  The "cmp + unsigned-jump pairs" number is the tightest'
Write-Host '  approximation of bounds-check instructions. Removing all of'
Write-Host '  these (as WASM does via guard-page-based virtual memory'
Write-Host '  bounds checks) would reduce instruction count by roughly'
Write-Host '  that percentage in the best case.'
Write-Host ''
Write-Host '  But: predicted-taken branches cost ~0 cycles on modern CPUs,'
Write-Host '  so the RUNTIME speedup from eliminating them is typically'
Write-Host '  smaller than the instruction-count reduction (0.5x to 1x'
Write-Host '  of the inst-count ratio, depending on front-end pressure).'
Write-Host ''
