# Extract the REAL emitted code size (in bytes of machine code) for each
# integer hot-path kernel from the V8 dump.
#
# V8 prints instruction-size headers like:
#   Instructions (size = 12345)
# at the top of each optimised code block. This is the exact number of
# bytes of machine code in the .text region for that function — ignoring
# the verbose ASCII formatting around it.
#
# Compare against typical L1 instruction cache sizes to reason about
# whether the unrolling has overflowed L1i on target hardware.

$content = Get-Content bench/jit_asm_dump.txt -Raw

# Split on block delimiter to isolate each kernel cleanly.
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
Write-Host 'Machine-code size (actual .text bytes, not ASCII dump bytes)'
Write-Host '-----------------------------------------------------------------------'
Write-Host ('{0,-44} {1,10} {2,12}' -f 'Kernel', 'Bytes', 'KB')
Write-Host '-----------------------------------------------------------------------'

foreach ($k in $kernels) {
    # Find the LAST block naming this kernel (multiple re-opts possible).
    $block = $null
    for ($i = $blocks.Count - 1; $i -ge 0; $i--) {
        if ($blocks[$i] -match ('(?m)^name = ' + [regex]::Escape($k) + '(?![\w])')) {
            $block = $blocks[$i]
            break
        }
    }
    if ($block -and $block -match 'Instructions \(size = (\d+)\)') {
        $bytes = [int]$Matches[1]
        $kb = [math]::Round($bytes / 1024, 1)
        Write-Host ('{0,-44} {1,10:N0} {2,10:N1} KB' -f $k, $bytes, $kb)
    } else {
        Write-Host ('{0,-44} NOT FOUND' -f $k)
    }
}

Write-Host ''
Write-Host 'Reference L1 instruction cache sizes:'
Write-Host '  Pentium 4 trace cache  :     12 KB  (equivalent)'
Write-Host '  Core 2 / Nehalem+      :     32 KB  (standard since ~2008)'
Write-Host '  Intel Skylake..2024    :     32 KB'
Write-Host '  AMD Zen 1..4           :     32 KB'
Write-Host '  AMD Zen 5              :     48 KB'
Write-Host '  Apple M1/M2/M3         :    192 KB'
Write-Host '  Typical ARM Cortex-A   :  32-64 KB'
Write-Host ''
Write-Host 'L2 (unified, falls back to here on L1i miss):'
Write-Host '  Modern desktop         : 256 KB - 2 MB  (feeds L1 in ~10-20 cycles)'
Write-Host ''
