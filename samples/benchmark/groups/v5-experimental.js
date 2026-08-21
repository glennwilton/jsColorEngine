// groups/v5-experimental.js
//
// V5 matrix-shaper POC (sRGB -> AdobeRGB, f32x4 SIMD).
//
// TODO future-me:
//   1. Lazy-load the V5 WASM bytecode. Old bench used:
//        <script src="v5_srgb_adobe.wasm.js"></script>
//      which sets a global  wasmV5Bytes. Either keep that mechanism or
//      bundle the bytes via a fetch() of a .wasm file.
//
//   2. Compile + instantiate once in the loader (not per-benchmark) — these
//      are conceptually module-level resources, not per-test setup.
//        const mod = await WebAssembly.compile(wasmV5Bytes);
//        const inst = await WebAssembly.instantiate(mod, {});
//        const { run_simd_v5, memory } = inst.exports;
//
//   3. Pre-fill gamma tables once in the loader.
//      Memory layout (from old bench):
//        offset    0  size 1024  Float32Array(256)  gamma_inv  (x^2.2)
//        offset 1024  size 4096  Uint8Array(4096)   gamma_fwd  (x^(1/2.2))
//        offset 5120  ...        input pixels (Uint8)
//        offset 5120+N ...       output pixels (Uint8)
//      Note: this is a POC. Production should pull TRCs from the actual
//      profile via Profile.applyInverseTRC / applyTRC. Keep the gamma fill
//      in the loader so it isn't counted as transform cost.
//
//   4. In setup(input, output), copy the shared input bytes into the WASM
//      memory PIXEL region. In transform(), call run_simd_v5(srcByteOffset,
//      dstByteOffset, pixelCount), then copy the WASM output back into the
//      output Uint8Array the engine provided.
//
//      The copy in/out is real work the V5 has to do to interop with the
//      shared buffer system. If we want to measure "pure WASM throughput
//      with zero copy", add a second variant that pre-stages input in setup
//      and writes output directly into WASM memory we expose as the engine's
//      output buffer (zero-copy).
//
//   5. Sanity check: result MPx/s here should match (within a few %) what we
//      saw in the original matrix-shaper bench once methodology bugs (Uint8-
//      ClampedArray output, etc.) are eliminated. If it's wildly different,
//      something in the framework is off.

import { BenchmarkGroup, groups } from '../benchmark-groups.js';
import { resources } from '../shared-resources.js';

const v5Group = new BenchmarkGroup({
    id:           'v5-experimental',
    name:         'V5 Matrix-Shaper POC',
    description:  'Experimental V5 SIMD matrix-shaper (sRGB -> AdobeRGB)',
    tags:         ['experimental', 'v5'],
    dependencies: ['baseline'],

    loader: async (group) => {
        // TODO: load v5_srgb_adobe.wasm.js
        // TODO: compile + instantiate WASM
        // TODO: fill gamma tables
        // TODO: register benchmark(s)
        console.warn('[v5 group] stub — no benchmarks registered yet');
    },
});

groups.register(v5Group);
export { v5Group };