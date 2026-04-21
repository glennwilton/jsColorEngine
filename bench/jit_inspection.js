/**
 * JIT inspection bench — verify V8 is actually compiling the
 * lutMode:'int' hot kernels the way we think it is.
 *
 *   "Measure, don't guess."
 *
 * ---------------------------------------------------------------------
 * DOCUMENTED FINDINGS (Node 20.13 / V8 11.3, Windows x64, 2026-04)
 * ---------------------------------------------------------------------
 *
 * Both families of hot-path kernels (lutMode:'int' and the float
 * fallback used by lutMode:'float') are confirmed:
 *
 *   1. Promoted to TurboFan after warmup (not stuck in Ignition
 *      interpreter or Sparkplug baseline).
 *   2. Int kernels: pure int32 arithmetic — ZERO mulsd/addsd/subsd
 *      (float64 ops), ZERO cvt* (int↔float conversions), ZERO
 *      CallRuntime escapes.
 *   3. Float kernels: predominantly float64 (XMM register math) with
 *      a handful of int32 ops just for base-pointer / index
 *      arithmetic. Zero conversions — confirming V8 keeps the
 *      numerical domain clean and never boxes a float into an int
 *      or vice versa inside the loop.
 *   4. Zero deopts during real transformArray calls on either family.
 *      (Two expected deopts on `tetrahedralInterp4D_3Ch` during LUT
 *      construction are one-time feedback-gathering events and fire
 *      inside create(), not the hot path.)
 *
 * Instruction op counts from --print-opt-code (isolated per block):
 *
 *   Kernel                        imul  add  sub  shifts  float  calls
 *   3D 3Ch INT (RGB→RGB/Lab)        34   58   27    24       0     0
 *   3D 4Ch INT (RGB→CMYK)          181   74   36    30       0     0
 *   4D 3Ch INT (CMYK→RGB/Lab)      251  125   64    65       0     0
 *   4D 4Ch INT (CMYK→CMYK)          92  158   85    84       0     0
 *   3D 3Ch FLT (RGB→RGB/Lab)         3   53    1     0      97     0
 *   3D 4Ch FLT (RGB→CMYK)            3   66    1     0     127     0
 *   4D 3Ch FLT (CMYK→RGB/Lab)        4   98    2     0     210     0
 *   4D 4Ch FLT (CMYK→CMYK)           6  122    2     0     279     1
 *
 *   (The `float` column sums mulsd+addsd+subsd. The single CallRuntime
 *   in 4D 4Ch FLT is a deopt-guard on a rarely-taken edge, not hot.)
 *
 * Full instruction-mix breakdown from bench/jit_asm_boundscheck.ps1:
 *
 *   Kernel            Total   Compute   Moves    Safety   Bounds-check
 *   3D 3Ch INT          668    24.7%    39.7%    21.6%         7.0%
 *   3D 4Ch INT          799    43.7%    38.7%    22.0%         7.5%
 *   4D 3Ch INT        1,155    47.1%    36.4%    20.0%         7.1%
 *   4D 4Ch INT        1,422    33.1%    36.7%    20.2%         7.5%
 *   3D 3Ch FLT          722    21.3%    29.5%    20.6%         6.0%
 *   3D 4Ch FLT          860    22.9%    28.4%    21.2%         6.5%
 *   4D 3Ch FLT        1,299    24.2%    32.3%    19.2%         5.9%
 *   4D 4Ch FLT        1,611    25.4%    32.8%    19.1%         6.3%
 *
 * Key findings:
 *   - Int kernels are 7-12% smaller in instruction count AND
 *     1.5-2× more compute-dense than their float counterparts.
 *     Matches the measured ~10-15% real-world speedup of
 *     lutMode:'int' vs lutMode:'float'.
 *   - Moves (~30-40%) and safety (~20%) dominate both families —
 *     they're memory-move-bound, not ALU-bound. This shapes the
 *     realistic WASM / SIMD ceiling (see docs/Performance.md §1b).
 *   - Bounds-check pairs are ~6-8% of instructions. WASM guard
 *     pages eliminate these.
 *   - Overflow checks (`jo`) are ANOTHER ~8% of instructions,
 *     emitted after speculative int32 arithmetic because JS Number
 *     is float64 and V8 has to deopt if the int32 speculation
 *     overflows. WASM i32 math wraps by spec — no guard needed.
 *   - Combined safety elimination from WASM: ~15% of instructions.
 *     Combined with better register allocation (pin linear-memory
 *     base pointer), expected WASM-scalar-over-'int' speedup is
 *     ~1.4-1.6×.
 *
 * Move classification (bench/jit_asm_spillcheck.ps1):
 *
 *   Kernel            Moves   Spill traffic   Real heap I/O   Reg-reg
 *   3D 3Ch INT          265      47.5%           25.3%          8.3%
 *   3D 4Ch INT          309      50.2%           24.9%          7.1%
 *   4D 3Ch INT          420      49.5%           24.8%          6.0%
 *   4D 4Ch INT          522      52.3%           23.8%          5.7%
 *   3D 3Ch FLT          213      36.6%           34.3%          3.3%
 *   3D 4Ch FLT          244      36.9%           35.2%          2.9%
 *   4D 3Ch FLT          420      50.2%           31.2%          3.1%
 *   4D 4Ch FLT          528      52.7%           30.5%          2.7%
 *
 * **Two striking findings about register pressure:**
 *
 *   1. Both families spill HEAVILY — 36-53% of every mov is a
 *      spill (stack save or stack reload). V8 ran out of GPRs
 *      (x86-64 has 16; V8 reserves ~5; we want ~13 live) and
 *      parked values on the stack. Reloads outnumber stores
 *      ~1.3× — long-lived values (weights, channel shifts)
 *      being materialised once and pulled back many times.
 *
 *   2. FLOAT kernels show MEASURABLY LESS GPR pressure than INT
 *      kernels at 3D (36-37% vs 47-50% spills). Float values live
 *      in XMM0-XMM15 (a separate 16-register file), so the GPRs
 *      are free for pointers, indices, and counters. At 4D both
 *      families converge at ~50% because the 4-axis grid
 *      bookkeeping alone (4 weights + 4 bases + 4 index temps)
 *      saturates the GPRs regardless of whether arithmetic
 *      values are int or float.
 *
 * Implications for future work:
 *   - ARM64 (Apple M-series, modern Cortex-A) has 31 GPRs → V8
 *     keeps ~26 allocatable → 13-value working set fits with
 *     huge headroom → register pressure should largely vanish.
 *     Measuring on M1/M4 would quantify how much of our current
 *     cost is x86-specific and is an obvious next experiment.
 *   - WASM scalar on x86-64 should see a big win too because WASM
 *     compilers can pin linear-memory pointers (no aliasing
 *     worries), freeing 2 GPRs → fewer spills.
 *   - Ideas for JIT reordering (just-in-time c0/c1/c2 loads,
 *     narrower live ranges) are documented in docs/Performance.md.
 *
 * See docs/Performance.md §1b for the full analysis.
 *
 * Machine-code sizes (actual .text bytes emitted by V8):
 *
 *   Kernel            bytes     % of 32 KB L1i
 *   3D 3Ch INT        4,648           14%
 *   3D 4Ch INT        5,568           17%
 *   4D 3Ch INT        7,816           24%
 *   4D 4Ch INT        9,652           30%
 *   3D 3Ch FLT        4,784           15%
 *   3D 4Ch FLT        5,696           17%
 *   4D 3Ch FLT        8,812           27%
 *   4D 4Ch FLT       11,016           34%
 *
 * Every kernel fits comfortably in a single 32 KB L1i — the biggest
 * (4D 4Ch FLT at 10.8 KB) uses just over a third. Unrolling is safe
 * on any CPU shipped since ~2008. Apple M-series has 192 KB L1i so
 * they essentially disappear there.
 *
 * See `docs/Performance.md` section "JIT inspection" for the fuller
 * analysis and the L1i / branch-prediction tradeoff of the unroll.
 *
 * ---------------------------------------------------------------------
 * What this checks
 * ---------------------------------------------------------------------
 *
 * We designed the integer kernels assuming V8 will:
 *   (a) promote them to TurboFan after warm-up (not leave them in the
 *       interpreter or Sparkplug baseline),
 *   (b) specialise the arithmetic as Int32 ops (not box through
 *       HeapNumber / Float64),
 *   (c) NOT deopt during real-world transforms (i.e. the input shape
 *       never surprises V8 once warmed).
 *
 * This bench confirms (a) and (c) directly using V8's
 * `%GetOptimizationStatus` native. (b) needs raw disassembly and is
 * covered by the instructions at the bottom of this file.
 *
 * If any of these assumptions turn out to be wrong, the whole
 * performance story of lutMode:'int' is wrong and we need to fix the
 * kernels, not the benchmarks.
 *
 * ---------------------------------------------------------------------
 * How to run
 * ---------------------------------------------------------------------
 *
 * Minimum (tier + deopt status reported):
 *   node --allow-natives-syntax bench/jit_inspection.js
 *
 * Full JIT trace (tells you WHEN each function got optimized and
 * whether ANY deopts fired):
 *   node --allow-natives-syntax --trace-opt --trace-deopt bench/jit_inspection.js 2>&1 | tee jit_trace.txt
 *
 * Assembly dump (confirms Int32 vs Float64 instruction selection —
 * look for `imul r*d, r*d` = int32 multiply vs `mulsd xmm*, xmm*`
 * = float64 multiply inside the kernel body):
 *   node --allow-natives-syntax --print-opt-code --code-comments bench/jit_inspection.js 2>&1 > jit_asm.txt
 *   # then grep -B2 -A400 "tetrahedralInterp3DArray_3Ch_intLut_loop" jit_asm.txt
 *
 * Turbolizer view (pretty IR graph, all pipeline phases):
 *   node --allow-natives-syntax --trace-turbo bench/jit_inspection.js
 *   # Drag turbo-*.json into https://v8.github.io/tools/head/turbolizer/
 *
 * ---------------------------------------------------------------------
 * Caveats (read before trusting the output)
 * ---------------------------------------------------------------------
 *
 * 1. V8 may INLINE the kernel into its caller (transformArrayViaLUT).
 *    To avoid that making this bench meaningless, we also call each
 *    kernel DIRECTLY (not through the dispatcher) so it has a
 *    standalone optimised version to query.
 *
 * 2. Concurrent optimisation is on a background thread. We sleep a
 *    moment after warm-up so TurboFan / Maglev have time to finish.
 *
 * 3. `%GetOptimizationStatus` is intentionally not part of the public
 *    JS API. Without `--allow-natives-syntax` this file still runs but
 *    can only report "compilation state unknown" — you still get the
 *    deopt check via `--trace-deopt`.
 *
 * 4. Maglev ("mid-tier" JIT, shipping in V8 11+) can be the final tier
 *    for some functions — that's expected, not a regression. The bad
 *    outcomes are Ignition (interpreter), Baseline (Sparkplug), or
 *    repeated deopts.
 */
'use strict';

const path = require('path');
const {spawnSync} = require('child_process');
const {Transform, eIntent} = require('../src/main');
const Profile = require('../src/Profile');

const cmykFilename = path.join(__dirname, '..', '__tests__', 'GRACoL2006_Coated1v2.icc');

// ---------------------------------------------------------------------
// V8 optimisation status bitmask
// ---------------------------------------------------------------------
// Bits as of V8 11.x (matches Node 20/21). Values come from
// v8/src/runtime/runtime-test.cc `OptimizationStatus`. If you're
// running on a different V8 version the bit positions may drift — the
// tier detector below is defensive about that.
// ---------------------------------------------------------------------
const BIT = {
    kIsFunction:                        1 << 0,
    kNeverOptimize:                     1 << 1,
    kAlwaysOptimize:                    1 << 2,
    kMaybeDeopted:                      1 << 3,
    kOptimized:                         1 << 4,  // TurboFan
    kInterpreted:                       1 << 6,
    kMarkedForOptimization:             1 << 7,
    kMarkedForConcurrentOptimization:   1 << 8,
    kOptimizingConcurrently:            1 << 9,
    kIsExecuting:                       1 << 10,
    kTopmostFrameIsTurboFanned:         1 << 11,
    kMarkedForDeoptimization:           1 << 13,
    kBaseline:                          1 << 14, // Sparkplug
    kTopmostFrameIsBaseline:            1 << 15,
    kIsLazy:                            1 << 16,
    kMaglevved:                         1 << 17, // Maglev
    kTopmostFrameIsMaglev:              1 << 18,
};

// Wrap %GetOptimizationStatus safely — `new Function` avoids parse
// errors if --allow-natives-syntax is not set (we just get a null
// getter and fall back gracefully).
let getStatus = null;
const hasNatives = process.execArgv.some(a => a.indexOf('allow-natives-syntax') >= 0);
if(hasNatives){
    try {
        getStatus = new Function('fn', 'return %GetOptimizationStatus(fn);');
    } catch(e){
        // should not happen given hasNatives, but defensive
    }
}

function describeBits(s){
    if(s === null || s === undefined) return '(unknown)';
    const tags = [];
    for(const k of Object.keys(BIT)) if(s & BIT[k]) tags.push(k);
    return tags.length ? tags.join(' | ') : '(no bits set)';
}

// Return a short human-readable tier name. TurboFan > Maglev >
// Sparkplug > Ignition. "Optimised" (TF or Maglev) is the passing
// grade for a hot kernel.
function tier(s){
    if(s === null || s === undefined) return 'UNKNOWN (rerun with --allow-natives-syntax)';
    if(s & BIT.kOptimized)      return 'TURBOFAN       ✅ (best tier)';
    if(s & BIT.kMaglevved)      return 'MAGLEV         ✅ (mid-tier JIT, also good)';
    if(s & BIT.kBaseline)       return 'BASELINE       ⚠  (Sparkplug — warmup insufficient?)';
    if(s & BIT.kInterpreted)    return 'IGNITION       ❌ (interpreter — not optimised)';
    if(s & BIT.kNeverOptimize)  return 'NEVER_OPTIMIZE ❌ (marked unopt — bug)';
    return 'UNCLASSIFIED   ❓  (raw status=' + s + ')';
}

// Red flags. Anything here printing = investigate.
//
// Note on kInterpreted: V8 sets this bit whenever the function has
// interpreter bytecode available, which is true for EVERY JS function
// — it's the deopt fallback. kInterpreted being present alongside
// kOptimized/kMaglevved is normal and expected, NOT a warning. It's
// only a red flag when it appears WITHOUT any optimised tier bit, i.e.
// the function is actually still interpreted after warmup.
function warningBits(s){
    if(s === null || s === undefined) return [];
    const w = [];
    const hasOptimisedTier = (s & BIT.kOptimized) || (s & BIT.kMaglevved);
    if(s & BIT.kMaybeDeopted)           w.push('kMaybeDeopted — this kernel was deopted at least once (check --trace-deopt)');
    if(s & BIT.kMarkedForDeoptimization) w.push('kMarkedForDeoptimization — deopt imminent');
    if((s & BIT.kInterpreted) && !hasOptimisedTier){
        w.push('kInterpreted without any optimised tier — the JIT never promoted this kernel, check warmup');
    }
    return w;
}

// ---------------------------------------------------------------------
// Build test harness
// ---------------------------------------------------------------------

// Number of px per warmup call. 250k × 20 iters = 5M kernel-row
// executions, well beyond V8's ~10k optimisation threshold.
const WARMUP_PX = 250_000;
const WARMUP_ITERS = 20;

function buildInput(pxCount, inputChannels){
    const arr = new Uint8ClampedArray(pxCount * inputChannels);
    // Fill with varied but shape-stable data. We deliberately DON'T
    // randomise per-call — V8's type feedback is driven by value
    // shape, not value content, and we want the same "path" to be
    // exercised on every call.
    for(let i = 0; i < arr.length; i++) arr[i] = (i * 37 + 11) & 0xFF;
    return arr;
}

// Kernel name -> direct method reference on the prototype.
// We inspect BOTH the lutMode:'int' hot kernels AND the lutMode:'float'
// hot kernels so we can compare their optimisation profiles.
const INT_KERNEL_NAMES = [
    'tetrahedralInterp3DArray_3Ch_intLut_loop',  // RGB  -> RGB / Lab
    'tetrahedralInterp3DArray_4Ch_intLut_loop',  // RGB  -> CMYK
    'tetrahedralInterp4DArray_3Ch_intLut_loop',  // CMYK -> RGB / Lab
    'tetrahedralInterp4DArray_4Ch_intLut_loop',  // CMYK -> CMYK
];
const FLOAT_KERNEL_NAMES = [
    'tetrahedralInterp3DArray_3Ch_loop',         // RGB  -> RGB / Lab
    'tetrahedralInterp3DArray_4Ch_loop',         // RGB  -> CMYK
    'tetrahedralInterp4DArray_3Ch_loop',         // CMYK -> RGB / Lab
    'tetrahedralInterp4DArray_4Ch_loop',         // CMYK -> CMYK
];

async function buildTransforms(){
    const cmyk = new Profile();
    await cmyk.loadPromise('file:' + cmykFilename);

    // 'int' mode Transforms — these build both a float LUT AND an intLut,
    // and the dispatcher picks the intLut path.
    function mkInt(a, b){
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'int'});
        t.create(a, b, eIntent.relative);
        if(!t.lut || !t.lut.intLut) throw new Error('intLut not built for ' + String(a) + ' -> ' + String(b));
        return t;
    }
    // 'float' mode Transforms — build float LUT only, dispatcher hits the
    // float kernels. These are the v1.0-era hot kernels and the fallback
    // when 'int' can't handle the input shape.
    function mkFloat(a, b){
        const t = new Transform({dataFormat: 'int8', buildLut: true, lutMode: 'float'});
        t.create(a, b, eIntent.relative);
        if(!t.lut) throw new Error('float lut not built for ' + String(a) + ' -> ' + String(b));
        return t;
    }

    return [
        // ---- int kernels (lutMode: 'int') ---------------------------
        {label: 'RGB  -> RGB   (3D 3Ch, INT)', kernelName: INT_KERNEL_NAMES[0], transform: mkInt('*srgb', '*adobergb'), kind: 'int'},
        {label: 'RGB  -> CMYK  (3D 4Ch, INT)', kernelName: INT_KERNEL_NAMES[1], transform: mkInt('*srgb', cmyk),        kind: 'int'},
        {label: 'CMYK -> RGB   (4D 3Ch, INT)', kernelName: INT_KERNEL_NAMES[2], transform: mkInt(cmyk, '*srgb'),        kind: 'int'},
        {label: 'CMYK -> CMYK  (4D 4Ch, INT)', kernelName: INT_KERNEL_NAMES[3], transform: mkInt(cmyk, cmyk),           kind: 'int'},
        // ---- float kernels (lutMode: 'float') -----------------------
        {label: 'RGB  -> RGB   (3D 3Ch, FLT)', kernelName: FLOAT_KERNEL_NAMES[0], transform: mkFloat('*srgb', '*adobergb'), kind: 'float'},
        {label: 'RGB  -> CMYK  (3D 4Ch, FLT)', kernelName: FLOAT_KERNEL_NAMES[1], transform: mkFloat('*srgb', cmyk),        kind: 'float'},
        {label: 'CMYK -> RGB   (4D 3Ch, FLT)', kernelName: FLOAT_KERNEL_NAMES[2], transform: mkFloat(cmyk, '*srgb'),        kind: 'float'},
        {label: 'CMYK -> CMYK  (4D 4Ch, FLT)', kernelName: FLOAT_KERNEL_NAMES[3], transform: mkFloat(cmyk, cmyk),           kind: 'float'},
    ];
}

// Give concurrent TurboFan/Maglev jobs a chance to finish before we
// query the tier. 50 ms is plenty on any modern machine.
function sleep(ms){
    return new Promise(r => setTimeout(r, ms));
}

async function main(){
    console.log('='.repeat(74));
    console.log('jsColorEngine — lutMode:\'int\' JIT inspection');
    console.log('='.repeat(74));
    console.log('Node       :', process.version);
    console.log('V8         :', process.versions.v8);
    console.log('natives API:', hasNatives ? 'enabled (--allow-natives-syntax)' : 'DISABLED — tier detection unavailable');
    if(!hasNatives){
        console.log();
        console.log('  To get tier information, rerun with:');
        console.log('    node --allow-natives-syntax bench/jit_inspection.js');
        console.log();
    }
    console.log();

    const cases = await buildTransforms();
    let anyBad = false;
    const results = [];

    for(const c of cases){
        const {label, kernelName, transform, kind} = c;
        const inputChannels = transform.lut.inputChannels;
        const input = buildInput(WARMUP_PX, inputChannels);

        // ---- Warm through the production entry point ------------
        // This is what real users hit — transformArrayViaLUT ->
        // kernel. V8 sees consistent shape over many iters.
        for(let i = 0; i < WARMUP_ITERS; i++){
            transform.transformArray(input, false, false, false);
        }

        // ---- Also call the kernel DIRECTLY a handful of times ---
        // This forces V8 to produce a standalone optimised version
        // we can query even if it inlined the kernel into the
        // dispatcher. The arguments mirror the real call signature.
        //   - int kernels take the intLut as their 6th argument
        //   - float kernels take the outer float lut
        const direct = transform[kernelName];
        const out = new Uint8ClampedArray(1024 * transform.lut.outputChannels);
        const lutArg = (kind === 'int') ? transform.lut.intLut : transform.lut;
        for(let i = 0; i < 200; i++){
            direct.call(transform, input, 0, out, 0, 1024, lutArg, false, false, false);
        }

        // ---- Wait for concurrent compilation -------------------
        await sleep(75);

        // ---- Query -------------------------------------------------
        const fn = transform[kernelName];
        const status = getStatus ? getStatus(fn) : null;
        const warnings = warningBits(status);
        if(warnings.length) anyBad = true;

        results.push({label, kernelName, status, warnings});
    }

    // ---------------------------------------------------------------
    // Report
    // ---------------------------------------------------------------
    for(const r of results){
        console.log('-'.repeat(74));
        console.log(r.label);
        console.log('  kernel :', r.kernelName);
        console.log('  tier   :', tier(r.status));
        console.log('  status :', r.status, '(0x' + (r.status >>> 0).toString(16) + ')');
        console.log('  bits   :', describeBits(r.status));
        if(r.warnings.length){
            console.log('  ⚠ WARNINGS:');
            for(const w of r.warnings) console.log('     -', w);
        }
    }
    console.log('-'.repeat(74));

    // ---------------------------------------------------------------
    // Automated deopt check
    //
    // The current process is already running (can't see its own
    // --trace-deopt output). So we spawn ourselves as a child, this
    // time with --trace-deopt, and parse stderr for deopts naming
    // any of the four int-hot-path kernels.
    //
    // Caveat: we exit BEFORE the recursive check fires, so set an
    // env var to skip the recursive spawn inside the child.
    // ---------------------------------------------------------------
    console.log();
    if(process.env.JSCE_JIT_CHILD === '1'){
        // We are the child spawned to produce --trace-deopt output.
        // The parent will parse stderr. Nothing more to do here.
        return;
    }
    console.log('Deopt check (spawning child with --trace-deopt to count deopts');
    console.log('              against the four integer kernel names)...');
    const child = spawnSync(process.execPath, [
        '--allow-natives-syntax',
        '--trace-deopt',
        __filename,
    ], {
        env: {...process.env, JSCE_JIT_CHILD: '1'},
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    const traceLines = (child.stderr + '\n' + child.stdout).split(/\r?\n/);

    // Match hot-path array kernels (both int and float variants).
    //   `*Array_*Ch_intLut_loop` = int kernels
    //   `*Array_*Ch_loop`        = float kernels (no _intLut_ infix)
    // The non-array accuracy-path kernels `tetrahedralInterp4D_3Ch` ARE
    // expected to deopt a couple of times during LUT construction (they
    // run once per grid point and initial type feedback is sparse).
    // Those deopts are one-time and harmless; we explicitly exclude them
    // here by requiring `DArray_` in the name.
    const intHotRe    = /tetrahedralInterp[34]DArray_[34]Ch_intLut_loop/;
    const floatHotRe  = /tetrahedralInterp[34]DArray_[34]Ch_loop\b/;
    const deoptRe     = /^\[(bailout|marking dependent code)/;
    const intHotDeopts   = traceLines.filter(l => deoptRe.test(l) && intHotRe.test(l));
    const floatHotDeopts = traceLines.filter(l => deoptRe.test(l) && floatHotRe.test(l));

    // Accuracy-path kernels — same names without the `Array_` infix.
    const accuracyRe = /tetrahedralInterp[34]D_[34]Ch(?!A)/;
    const accuracyDeopts = traceLines.filter(l => deoptRe.test(l) && accuracyRe.test(l));

    console.log();
    console.log('  Integer hot kernels (*_intLut_loop):', intHotDeopts.length, 'deopts');
    if(intHotDeopts.length){
        console.log('  ❌ UNEXPECTED. First few lines:');
        for(const l of intHotDeopts.slice(0, 5)) console.log('     ' + l.substring(0, 150));
        anyBad = true;
    } else {
        console.log('  ✅ Zero deopts on the integer hot path.');
    }
    console.log();
    console.log('  Float hot kernels (*_loop):        ', floatHotDeopts.length, 'deopts');
    if(floatHotDeopts.length){
        console.log('  ❌ UNEXPECTED. First few lines:');
        for(const l of floatHotDeopts.slice(0, 5)) console.log('     ' + l.substring(0, 150));
        anyBad = true;
    } else {
        console.log('  ✅ Zero deopts on the float hot path.');
    }
    console.log();
    console.log('  Accuracy-path kernels (called during create() only):', accuracyDeopts.length, 'deopts');
    if(accuracyDeopts.length){
        console.log('     ℹ Expected — one-time deopts during LUT construction as V8 gathers');
        console.log('       type feedback. These fire during create(), NOT during transformArray,');
        console.log('       and are not a performance concern in real workloads.');
    }
    console.log();

    // ---------------------------------------------------------------
    // Int32 confirmation (manual — we print the grep command the
    // dev should run on the --print-opt-code output)
    // ---------------------------------------------------------------
    console.log('Int32 confirmation: dump assembly with');
    console.log('    node --allow-natives-syntax --print-opt-code --code-comments \\');
    console.log('         bench/jit_inspection.js 2>&1 > jit_asm.txt');
    console.log('  Then search for each kernel. Good signs:');
    console.log('    imul r*d, r*d       = int32 multiply (Math.imul specialised)');
    console.log('    add/sub r*d, r*d    = int32 add/subtract');
    console.log('    sar/shr r*d         = int32 arithmetic/logical shift');
    console.log('  Bad signs (would indicate boxing to HeapNumber):');
    console.log('    mulsd xmm*, xmm*    = float64 multiply');
    console.log('    addsd xmm*, xmm*    = float64 add');
    console.log('    CallRuntime         = escaping to the runtime for basic math');
    console.log();

    // ---------------------------------------------------------------
    // Exit code — non-zero if any kernel shows a red flag, so this
    // bench can be wired into CI later if we want.
    // ---------------------------------------------------------------
    if(anyBad){
        console.log('❌ At least one kernel reported warnings. See above.');
        process.exitCode = 1;
    } else if(hasNatives){
        const allOpt = results.every(r => r.status & (BIT.kOptimized | BIT.kMaglevved));
        if(!allOpt){
            console.log('⚠  Some kernels are not in TurboFan/Maglev — check tier rows above.');
            process.exitCode = 2;
        } else {
            console.log('✅ All 8 kernels (4 int + 4 float) are in TurboFan or Maglev with no deopt flags.');
        }
    } else {
        console.log('ℹ  Tier verdict skipped (no --allow-natives-syntax). Rerun with the flag.');
    }
}

main().catch(e => {
    console.error(e);
    process.exit(99);
});
