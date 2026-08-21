// groups/jsce.js
//
// jsColorEngine transform benchmarks.
//
// Call setEngine(jsce, profiles) from main.js before runGroups() is called.
// Each setup() creates completely fresh Profile + Transform instances so there
// is zero shared state between benchmark runs.
//
// Four directions × three LUT variants = 12 benchmarks.
// Each benchmark declares its own inputType / outputType so the engine selects
// the correct pixel buffer (RGB or CMYK) and allocates the right output size.

import { BenchmarkGroup, groups } from '../benchmark-groups.js';

// ---- Engine injection ---------------------------------------------------

let engine        = null;  // jsColorEngine module (Profile, Transform, eIntent, …)
let profileBytes  = null;  // { AdobeRGB, GRACoL, ISOCoated } as Uint8Array

export function setEngine(jsce, profiles) {
    engine       = jsce;
    profileBytes = profiles;
}

// ---- Direction and variant config ---------------------------------------

// Each direction maps to an (inputType, outputType) pair and the profile
// key or virtual name to use for src and dst.
const DIRECTIONS = [
    { id: 'rgb-rgb',   label: 'sRGB → AdobeRGB',    srcKey: '*srgb',  dstKey: 'AdobeRGB',  inputType: 'rgb',  outputType: 'rgb',  inChannels: 3, outChannels: 3 },
    { id: 'rgb-cmyk',  label: 'sRGB → GRACoL',       srcKey: '*srgb',  dstKey: 'GRACoL',    inputType: 'rgb',  outputType: 'cmyk', inChannels: 3, outChannels: 4 },
    { id: 'cmyk-rgb',  label: 'GRACoL → sRGB',       srcKey: 'GRACoL', dstKey: '*srgb',     inputType: 'cmyk', outputType: 'rgb',  inChannels: 4, outChannels: 3 },
    { id: 'cmyk-cmyk', label: 'GRACoL → ISOCoated',  srcKey: 'GRACoL', dstKey: 'ISOCoated', inputType: 'cmyk', outputType: 'cmyk', inChannels: 4, outChannels: 4 },
];

// int8 LUT variants from fastest to slowest.
const VARIANTS = [
    {
        suffix:           'wasm-simd',
        transformOptions: { buildLut: true, dataFormat: 'int8', lutMode: 'int-wasm-simd'   },
    },
    {
        suffix:           'wasm-scalar',
        transformOptions: { buildLut: true, dataFormat: 'int8', lutMode: 'int-wasm-scalar'  },
    },
    {
        suffix:           'js',
        transformOptions: { buildLut: true, dataFormat: 'int8', lutMode: 'int'              },
    },
];

// ---- Helpers ------------------------------------------------------------

function buildProfile(Profile, key) {
    const profile = new Profile();
    if (key.startsWith('*')) {
        profile.load(key);   // virtual built-in (e.g. '*srgb') — synchronous
    } else {
        const bytes = profileBytes[key];
        if (!bytes) throw new Error(`jsce: no profile bytes for "${key}"`);
        profile.loadBinary(bytes);   // synchronous
    }
    if (!profile.loaded) throw new Error(`jsce: profile "${key}" failed to load`);
    return profile;
}

// callMode controls how the jsce API is invoked:
//
//   'public-output'  — transform.transformArray(input, false, false, false, px, undefined, output)
//                      Public API, pre-wrapped output, deterministic (current default).
//
//   'public-noargs'  — transform.transformArray(input)
//                      EXACTLY like the old bench (samples/bench/main.js line 615).
//                      All other args undefined; output allocated internally by jsce
//                      and discarded. Reference case for the discrepancy investigation.
//
// reuseOutput controls allocation: true = same buffer every call (photoshop-like),
//                                   false = fresh buffer per call (batch images app).
function makeBenchmark(direction, variant, reuseOutput = true, callMode = 'public-output') {
    const modeBits = [];
    if (callMode === 'public-noargs') modeBits.push('oldstyle');
    if (!reuseOutput)                  modeBits.push('alloc');
    const modeTag    = modeBits.length ? '-' + modeBits.join('-') : '';
    const modeSuffix = modeBits.length ? ' (' + modeBits.join(', ') + ')' : '';

    return {
        id:          `jsce-${direction.id}-${variant.suffix}${modeTag}`,
        name:        `jsce ${direction.label} (${variant.suffix}${modeSuffix})`,
        tags:        ['jsce', direction.id, variant.suffix, reuseOutput ? 'reuse' : 'alloc', callMode],
        inputType:   direction.inputType,
        outputType:  direction.outputType,
        metric:      'mpx+mbps',
        reuseOutput,

        setup(input, output) {
            const { Profile, Transform, eIntent } = engine;
            const src = buildProfile(Profile, direction.srcKey);
            const dst = buildProfile(Profile, direction.dstKey);
            const xform = new Transform(variant.transformOptions);
            xform.create(src, dst, eIntent.relative);
            const pixelCount = Math.floor(input.length / direction.inChannels);

            // Return a context with a pre-bound `run` closure that captures EVERYTHING
            // it needs lexically (xform, input, output, pixelCount). The hot path then
            // becomes `context.run()` — same shape as the old bench's `runner.run()`,
            // which V8 can monomorphically inline through to the kernel.
            //
            // No property accesses on ctx, no branch on callMode, no per-call wrapping.
            // The closure is created ONCE in setup() and called many times in the hot loop.
            const clampedOutput = (reuseOutput && callMode === 'public-output')
                ? new Uint8ClampedArray(output.buffer, output.byteOffset, output.length)
                : null;

            let run;
            if (callMode === 'public-noargs') {
                // Exact old-bench pattern: transform.transformArray(input)
                run = function() { xform.transformArray(input); };
            } else if (reuseOutput) {
                // public-output reuse: pre-wrapped output, captured by closure
                run = function() { xform.transformArray(input, false, false, false, pixelCount, undefined, clampedOutput); };
            } else {
                // alloc mode: needs a fresh output each call — the engine passes it in.
                // (This benchmark's `runEachCall` flag tells the engine to use a different code path.)
                run = null;
            }

            return { xform, run, clampedOutput, pixelCount, callMode, reuseOutput };
        },

        // Tight wrapper for alloc mode (called only when ctx.run is null).
        // Keeps the alloc-mode code path off the reuse-mode hot path.
        transform(ctx, input, output) {
            const out = new Uint8ClampedArray(output.buffer, output.byteOffset, output.length);
            ctx.xform.transformArray(input, false, false, false, ctx.pixelCount, undefined, out);
        },
    };
}

// ---- Group registration ------------------------------------------------

const jsceGroup = new BenchmarkGroup({
    id:           'jsce',
    name:         'jsColorEngine',
    description:  'jsColorEngine LUT transform variants — 4 directions × 3 LUT modes',
    tags:         ['jsce'],
    dependencies: ['baseline'],

    loader: async (group) => {
        if (!engine) {
            console.warn('[jsce group] no engine set — call setEngine() before runGroups()');
            return;
        }
        if (!profileBytes) {
            console.warn('[jsce group] no profile bytes — call setEngine(jsce, profiles)');
            return;
        }

        for (const direction of DIRECTIONS) {
            // Reuse mode: same buffers every call — maximum kernel throughput
            // (photoshop-like: output buffer allocated once, reused across calls)
            for (const variant of VARIANTS) {
                group.register(makeBenchmark(direction, variant, true, 'public-output'));
            }
            // Alloc mode: fresh output per call — real-world batch throughput
            // (batch conversion: new buffer allocated per image)
            for (const variant of VARIANTS) {
                group.register(makeBenchmark(direction, variant, false, 'public-output'));
            }
            // Oldstyle reproduction: transform.transformArray(input) — single arg,
            // jsce allocates output internally and the return value is discarded.
            // Matches the old samples/bench/main.js calling convention exactly.
            // Wasm-simd only — this is for diagnostics, not a full matrix.
            const simdVariant = VARIANTS[0];   // wasm-simd
            group.register(makeBenchmark(direction, simdVariant, true, 'public-noargs'));
        }
    },
});

groups.register(jsceGroup);
export { jsceGroup };
