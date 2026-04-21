# Classify `mov` instructions in each kernel to distinguish
# register pressure (spills to stack) from real memory traffic
# (CLUT reads, output writes).
#
# V8's x86-64 convention:
#   [rbp-0xNN]   = caller stack frame slot   -> spill territory
#   [rsp+0xNN]   = current stack frame slot  -> spill territory
#   [rXX + rYY*scale + 0xNN]  (with non-rbp base) = heap/TypedArray load
#
# Classification:
#   STACK STORE   : mov [rbp-N], reg   or  mov [rsp+N], reg   <- spill producer
#   STACK RELOAD  : mov reg, [rbp-N]   or  mov reg, [rsp+N]   <- spill consumer
#   HEAP LOAD     : mov reg, [<non-stack>]                    <- real read
#   HEAP STORE    : mov [<non-stack>], reg                    <- real write
#   REG-TO-REG    : mov regA, regB                            <- scheduling shuffle
#
# Only STACK STORE + STACK RELOAD indicate register pressure.
# The rest are either necessary memory traffic or ABI plumbing.
#
# A well-allocated kernel shows < 5% stack moves. A pressured
# kernel shows > 15%. This is the actual diagnostic we want.

$content = Get-Content bench/jit_asm_dump.txt -Raw

# Split on the block delimiter so each kernel is isolated.
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
Write-Host 'Move classification — spills vs real memory traffic'
Write-Host '---------------------------------------------------------------------'

foreach ($k in $kernels) {
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

    # Total mov* count (for baseline). Includes both GPR moves (int
    # kernels) and XMM moves (float kernels). Float kernels use movsd
    # for scalar double, and vmovsd/vmovss for VEX-prefixed variants.
    $mnInt   = 'movl|movq|movzxbl|movzxwl|movsxbl|movsxwl|movabs'
    $mnFlt   = 'vmovsd|vmovss|movsd|movss|movapd|movaps|movupd|movups'
    $mnAll   = $mnInt + '|' + $mnFlt
    $movAll = ([regex]::Matches($body, '\b(' + $mnAll + ')\b')).Count

    # Stack operations — the spill signature.
    # V8 uses [rbp-0xNN] for spill slots on x64.
    # Also check [rsp+0xNN] (used in some frame layouts).
    # Include XMM spills (movsd [rbp-N], xmmX) for float kernels.
    $stackStore  = ([regex]::Matches($body,
        '\b(' + $mnAll + ')\s+\[r(b|s)p[-+]0x[0-9a-f]+\]')).Count
    $stackReload = ([regex]::Matches($body,
        '\b(' + $mnAll + ')\s+[a-z]?[a-z0-9]+\s*,\s*\[r(b|s)p[-+]0x[0-9a-f]+\]')).Count

    # Heap memory (TypedArray reads/writes). Pattern = memory operand
    # with a base register that is NOT rbp/rsp. Typically these look
    # like [rXX + rYY*S + disp] or [rXX + disp] where rXX is not rbp/rsp.
    $heapLoad = ([regex]::Matches($body,
        '\b(' + $mnAll + ')\s+[a-z]?[a-z0-9]+\s*,\s*\[(?![^\]]*r(?:bp|sp))[^\]]+\]')).Count
    $heapStore = ([regex]::Matches($body,
        '\b(' + $mnAll + ')\s+\[(?![^\]]*r(?:bp|sp))[^\]]+\]')).Count

    # Register-to-register (no brackets on either side).
    $regToReg = ([regex]::Matches($body,
        '(?m)^[0-9a-fA-F]{8,16}\s+[0-9a-fA-F]+\s+[0-9a-fA-F]+\s+(' + $mnAll + ')\s+[a-z]?[a-z0-9]+\s*,\s*[a-z]?[a-z0-9]+\s*$')).Count

    $stackTotal = $stackStore + $stackReload
    $stackPct = if ($movAll -gt 0) { [math]::Round(100 * $stackTotal / $movAll, 1) } else { 0 }
    $heapPct  = if ($movAll -gt 0) { [math]::Round(100 * ($heapLoad + $heapStore) / $movAll, 1) } else { 0 }
    $regPct   = if ($movAll -gt 0) { [math]::Round(100 * $regToReg / $movAll, 1) } else { 0 }

    Write-Host ''
    Write-Host ('=== ' + $k + ' ===')
    Write-Host ('  Total mov* instructions : {0,6:N0}' -f $movAll)
    Write-Host ('  Stack stores (spills)   : {0,6:N0}' -f $stackStore)
    Write-Host ('  Stack reloads (unspill) : {0,6:N0}' -f $stackReload)
    Write-Host ('     => spill traffic     : {0,6:N0}   {1,5:N1}% of moves  <- REGISTER PRESSURE signal' -f $stackTotal, $stackPct)
    Write-Host ('  Heap loads (CLUT, etc.) : {0,6:N0}' -f $heapLoad)
    Write-Host ('  Heap stores (output)    : {0,6:N0}' -f $heapStore)
    Write-Host ('     => real mem traffic  : {0,6:N0}   {1,5:N1}% of moves  <- necessary, cannot optimise' -f ($heapLoad + $heapStore), $heapPct)
    Write-Host ('  Reg-to-reg moves        : {0,6:N0}   {1,5:N1}% of moves  <- scheduling / ABI plumbing' -f $regToReg, $regPct)

    $verdict = if ($stackPct -lt 5) { 'WELL-ALLOCATED (no meaningful register pressure)' }
               elseif ($stackPct -lt 15) { 'MILD PRESSURE (some spilling, unlikely to dominate)' }
               else { 'HIGH PRESSURE (reordering could help)' }
    Write-Host ('  VERDICT                 : ' + $verdict) -ForegroundColor Cyan
}

Write-Host ''
Write-Host '---------------------------------------------------------------------'
Write-Host 'Reference: x86-64 has 16 GPRs. V8 reserves ~5 (rsp, rbp, r13=root,'
Write-Host 'r14=context, sometimes rdi for closure), leaving ~11 for allocation.'
Write-Host 'Kernel live-values: 3 weights (rx/ry/rz) + 3 shifts (c0/c1/c2)'
Write-Host '+ 2-3 bases + outputPos + 2 TypedArray pointers + 1-2 temps = ~13.'
Write-Host 'If verdict is "HIGH PRESSURE", try:'
Write-Host '  - Reorder so c0/c1/c2 are loaded just-in-time, not all upfront'
Write-Host '  - Compute one output per iteration, not three'
Write-Host '  - Inline base3 add-and-subtract as immediates where possible'
Write-Host ''
