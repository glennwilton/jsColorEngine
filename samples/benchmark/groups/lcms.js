// groups/lcms.js
//
// LCMS WASM reference implementations.
//
// TODO future-me:
//   1. Lazy-load lcms-wasm script (or import the npm package in Node).
//      In the browser this used to be loaded via a <script> tag in the old
//      benches — replicate that here, but only when this group is requested.
//
//   2. Get profile bytes from the shared resource pool:
//        const srgbRes  = resources.getProfile('sRGB');
//        const adobeRes = resources.getProfile('AdobeRGB');
//      If the profile is `builtin` we still need real bytes for LCMS — either
//      fetch the canonical .icc, or have shared-resources.js always store the
//      bytes (even for built-ins) so both engines see the same data.
//
//   3. Register one benchmark per LCMS variant:
//        - lcms-wasm-default     (33^3 LUT, 8-bit I/O)
//        - lcms-wasm-highres     (49^3 LUT, 8-bit I/O)
//        - lcms-wasm-noopt       (pipeline, no LUT)
//        - lcms-wasm-default-16  (16-bit I/O)
//      Each one's setup() should build the transform; transform() calls
//      transformPixels(input, output).
//
//   4. Match the input/output signatures the engine passes in:
//        setup(input, output)  -> ctx
//        transform(ctx, input, output)
//      input is the shared rgbIn.bin Uint8Array; output is a fresh Uint8Array.

import { BenchmarkGroup, groups } from '../benchmark-groups.js';
import { resources } from '../shared-resources.js';

const lcmsGroup = new BenchmarkGroup({
    id:           'lcms',
    name:         'LCMS Reference',
    description:  'Little CMS WASM reference implementations',
    tags:         ['reference', 'lcms'],
    dependencies: ['baseline'],

    loader: async (group) => {
        // TODO: lazy-load lcms-wasm here
        // TODO: register benchmarks here (see file header)
        console.warn('[lcms group] stub — no benchmarks registered yet');
    },
});

groups.register(lcmsGroup);
export { lcmsGroup };