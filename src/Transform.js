/*************************************************************************
 *  @license
 *
 *  Copyright © 2019, 2026 Glenn Wilton
 *  O2 Creative Limited
 *  www.o2creative.co.nz
 *  support@o2creative.co.nz
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
*/


    'use strict';

    var Profile = require('./Profile');
    var convert = require('./convert');
    var defs = require('./def');
    var wasmLifecycle = require('./kernels/wasmLifecycle');
    var lutKernelTable = require('./lutKernelTable');
    var _pool = require('./pool.js');

    var eIntent = defs.eIntent;
    var eProfileType = defs.eProfileType;
    var eColourType = defs.eColourType;
    var illuminant = defs.illuminant;
    var encoding = defs.encoding;
    var encodingStr = defs.encodingStr;

    /**
     * ============================================================================
     *  Transform — the colour-conversion engine
     * ============================================================================
     *
     *  A Transform takes 2+ Profiles and an intent, builds a pipeline of stages
     *  between them, and (optionally) bakes that pipeline into a CLUT for very
     *  fast image conversion.
     *
     *  The class deliberately exposes TWO PARALLEL EXECUTION PATHS with
     *  different design priorities. Picking the wrong one will give you 30x
     *  worse throughput or 30x worse accuracy. Read this section first.
     *
     *  ----------------------------------------------------------------------------
     *  USAGE GUIDE — pick the right entry point for your workload
     *  ----------------------------------------------------------------------------
     *
     *   1. SINGLE COLOURS  (colour pickers, ΔE, swatch soft-proof, analysis)
     *      Accuracy-first path. ~µs per call. Allocations & per-stage dispatch
     *      are fine here. Custom stages and pipelineDebug are only meaningful
     *      on this path.
     *
     *          new Transform({ dataFormat: 'object' })
     *              .create(srcProfile, dstProfile, eIntent.relative);
     *          var lab = transform.transform(color.RGB(255, 0, 0));
     *
     *
     *   2. MANY COLOURS  (a few hundred / thousand — still need full accuracy)
     *
     *          transform.transformArray(arr, ...);   // object/objectFloat OK
     *
     *      Walks the full pipeline per pixel. Use for analysis batches; do NOT
     *      use for image data — see (3).
     *
     *
     *   3. IMAGE DATA  (millions of pixels, 8-bit per channel)
     *      Speed-first path. ~45–70 Mpx/s on V8 / x64 (see
     *      bench/mpx_summary.js). Built on the prebuilt LUT and the
     *      unrolled `*_loop` interpolators in src/kernels/.
     *
     *          new Transform({ buildLut: true, dataFormat: 'int8', BPC: true })
     *              .create('*sRGB', cmykProfile, eIntent.perceptual);
     *          var out = transform.transformArrayViaLUT(uint8Pixels, true, true);
     *
     *      Equivalent shortcut:
     *
     *          transform.transformArray(uint8Pixels, true, true);
     *          // routes to transformArrayViaLUT() when dataFormat==='int8' and
     *          // a LUT was prebuilt.
     *
     *      Input MUST be a Uint8ClampedArray (or Uint8Array) of well-formed
     *      pixel data, length === pixelCount * channelsPerPixel. Bounds-checks
     *      are deliberately omitted in the inner loops — passing out-of-range
     *      values is undefined behaviour (garbage out, no exception).
     *
     *
     *   ANTI-PATTERN — do not do this:
     *
     *          for (let i = 0; i < pixelCount; i++) {
     *              out[i] = transform.transform(pixels[i]);   // ← DON'T
     *          }
     *
     *      That bypasses the LUT, allocates ~6 Arrays per pixel, and dispatches
     *      every stage via .call(this, ...). On a 4 MP image you will be ~30x
     *      slower than transformArrayViaLUT and you will GC-thrash the host.
     *
     *  ----------------------------------------------------------------------------
     *  DATAFORMAT OPTIONS  (constructor `dataFormat`)
     *  ----------------------------------------------------------------------------
     *
     *   'object'       Structured input/output, integer ranges. Accuracy path.
     *                  RGB:  {type: eColourType.RGB,  R:0..255, G:0..255, B:0..255}
     *                  Lab:  {type: eColourType.Lab,  L:0..100, a:-128..127, b:-128..127}
     *                  CMYK: {type: eColourType.CMYK, C:0..100, M:0..100, Y:0..100, K:0..100}
     *                  Compatible with the helpers in convert.js. Best for
     *                  analysis and human-readable output.
     *
     *   'objectFloat'  Same shape but float ranges 0.0–1.0.
     *                  RGB:  {type, Rf, Gf, Bf}
     *                  Lab:  {type, L:0..100, a:-128..127, b:-128..127}  (unchanged)
     *                  CMYK: {type, Cf, Mf, Yf, Kf}
     *
     *   'int8'         Flat 8-bit integer array, 0–255 per channel. Image path.
     *                  When combined with `buildLut: true`, transformArray()
     *                  routes to transformArrayViaLUT() — the fast path.
     *
     *   'int16'        Flat 16-bit integer array, 0–65535 per channel.
     *                  (Image-grade _16bit interpolators are TODO — see the
     *                  "HOT PATH" header above the *_loop functions.)
     *
     *   'device'       Flat array of n-channel floats, 0.0–1.0 per channel.
     *                  CMYK 25%,0,100%,50% → [0.25, 0.0, 1.0, 0.5]
     *                  RGB 255,0,25       → [1.0, 0.0, 0.098...]
     *                  Used internally; suitable when caller wants raw device
     *                  values without the input/output conversion stages.
     *
     *  ----------------------------------------------------------------------------
     *  CUSTOM STAGES  (3rd argument of create() / 2nd of createMultiStage())
     *  ----------------------------------------------------------------------------
     *
     *  An array of stage objects to be inserted into the pipeline at named
     *  pipeline locations. When the Transform is built with `buildLut: true`,
     *  custom stages are baked INTO the LUT — so they cost zero per pixel at
     *  runtime. This is the recommended way to apply per-image effects (grey
     *  conversion, saturation tweaks, ink limiting, etc.) without sacrificing
     *  the speed of the LUT path.
     *
     *      {
     *          description: 'name of stage',
     *          stageData:   { ... arbitrary state passed to stageFn ... },
     *          stageFn:     function(input, stageData, stage) { return output; },
     *          location:    one of:
     *                          'beforeInput2Device'
     *                          'beforeDevice2PCS'
     *                          'afterDevice2PCS'
     *                          'PCS'
     *                          'beforePCS2Device'
     *                          'afterPCS2Device'
     *                          'afterDevice2Output'
     *
     *                       For multi-stage profile chains, the same custom
     *                       stage is inserted at EACH boundary by default. To
     *                       target a specific boundary, append (n) where n is
     *                       the 0-based stage index, e.g. 'PCS(0)', 'PCS(1)'.
     *      }
     *
     *  See README "Insert a custom stage to convert to grey" for a worked
     *  example.
     *
     *  ----------------------------------------------------------------------------
     *  PIPELINE NOTES (internal)
     *  ----------------------------------------------------------------------------
     *
     *   - Pipeline construction runs ONCE per create() call — speed of build is
     *     irrelevant. Pipeline EXECUTION is per-pixel — speed is critical.
     *
     *   - The pipeline optimiser (this.optimise === true) collapses adjacent
     *     stages with matching encodings (e.g. PCSv2→PCSv2 conversions become
     *     no-ops) and can drop entire stages.
     *
     *   - Stages are stored as { inputEncoding, funct, outputEncoding,
     *     stageData, stageName, debugFormat } — see _Stage typedef in def.js.
     *
     *   - Idea for future: emit each stage body as a string, then construct one
     *     monolithic Function() that runs the whole pipeline inline per pixel.
     *     Bigger gain than micro-optimising individual stages.
     *
     *  ----------------------------------------------------------------------------
     *  CONSTRUCTOR OPTIONS
     *  ----------------------------------------------------------------------------
     *
     *  @param {object}              options
     *
     *  @param {boolean}            [options.buildLut=false]
     *      Precompute and store the CLUT. Required for the fast image path
     *      (see USAGE GUIDE #3). Slight accuracy loss vs. running the full
     *      pipeline because of LUT quantisation, but typically invisible to
     *      the eye and 20–30x faster on image data.
     *      (Note: legacy spelling `builtLut` is also accepted.)
     *
     *  @param {string}             [options.lutGamutMode='none']
     *      Baked gamut check during LUT build. Zero cost at transform time.
     *        - `'none'`     — no gamut check (default).
     *        - `'color'`    — hard replace above `lutGamutLimit` with
     *                         `lutGamutColor`.
     *        - `'map'`      — write scaled ΔE into every output channel
     *                         (0 = in-gamut, 1.0 = `lutGamutMapScale` ΔE).
     *                         For analysis — output is raw ΔE data.
     *        - `'colorMap'` — blend original colour → `lutGamutColor`
     *                         proportional to ΔE / `lutGamutMapScale`.
     *                         Visual heat-map overlay on the image.
     *
     *  @param {boolean}            [options.bakeLutGamut=false]
     *      Legacy shorthand. `true` is equivalent to `lutGamutMode:'color'`.
     *      `lutGamutMode` takes precedence when both are set.
     *
     *  @param {number}             [options.lutGamutLimit=5]
     *      ΔE76 threshold for `'color'` mode. Grid points whose ΔE76
     *      exceeds this value are replaced with `lutGamutColor`.
     *      Ignored in `'map'` mode (map is continuous, not thresholded).
     *
     *  @param {number}             [options.lutGamutMapScale=25.5]
     *      ΔE that maps to 1.0 in `'map'` mode. In int8 output a channel
     *      value of 255 = this many ΔE units. Default 25.5 gives 0.1 ΔE
     *      resolution per int8 LSB.
     *
     *  @param {object}             [options.lutGamutColor={L:0, a:127, b:127}]
     *      Lab colour used for out-of-gamut replacement cells in `'color'`
     *      mode. Converted to the output device space once at LUT-build
     *      time. Default is a vivid pink/magenta.
     *
     *  @param {function}           [options.gamutDeFn=convert.deltaE1976]
     *      Colour-difference function `(labA, labB) => number` used by the
     *      gamut check. Swap in `convert.deltaE2000`, `convert.deltaCMC`,
     *      or a custom function.
     *
     *  @param {number}             [options.lutGridPoints3D=33]
     *      Grid points per axis for 3D LUTs. 17 / 33 / 65 are typical. Above
     *      65 you hit memory cost without measurable accuracy gain.
     *
     *  @param {number}             [options.lutGridPoints4D=17]
     *      Grid points per axis for 4D (CMYK) LUTs. 11 / 17 / 33 typical.
     *      4D grows as N^4 in memory — be cautious above 33.
     *
     *  @param {string}             [options.interpolation3D='tetrahedral']
     *  @param {string}             [options.interpolation4D='tetrahedral']
     *      'trilinear' or 'tetrahedral' for the live pipeline interpolation.
     *      Tetrahedral is BOTH faster AND more accurate for device→device LUTs;
     *      stay on tetrahedral unless you have a measured reason not to. For
     *      PCS→device 3-channel input, addStageLUT() automatically switches to
     *      trilinear (matches LittleCMS / Photoshop / SampleICC behaviour).
     *
     *  @param {string}             [options.LUTinterpolation3D]
     *  @param {string}             [options.LUTinterpolation4D]
     *      Same as above but applied to the LUT-substituted pipeline (i.e.
     *      after buildLut). Defaults to interpolation3D / interpolation4D.
     *
     *  @param {boolean}            [options.interpolationFast=true]
     *      Use the unrolled per-channel-count interpolators (3Ch / 4Ch / NCh).
     *      Set false to force the generic *_3or4Ch reference variants — only
     *      useful for diagnosing accuracy issues.
     *
     *  @param {string}             [options.dataFormat='object']
     *      'object' | 'objectFloat' | 'int8' | 'int16' | 'device' — see
     *      "DATAFORMAT OPTIONS" above.
     *
     *  @param {boolean}            [options.useFloats]
     *      DEPRECATED. Use dataFormat: 'objectFloat' instead.
     *
     *  @param {boolean}            [options.labAdaptation=false]
     *      If true, object-based Lab inputs are chromatically adapted to D50
     *      before entering the pipeline (e.g. LabD65 input → LabD50 internal).
     *
     *  @param {boolean}            [options.labInputAdaptation=true]
     *      If false, suppresses Lab→Lab whitepoint adaptation on input.
     *
     *  @param {boolean}            [options.displayChromaticAdaptation=false]
     *      Apply chromatic adaptation across the PCS when source/destination
     *      profiles have different whitepoints. For abstract Lab profiles.
     *
     *  @param {boolean}            [options.pipelineDebug=false]
     *      Capture per-stage values into this.pipelineHistory and
     *      this.debugHistory. Adds overhead — only enable for diagnostics.
     *      Only meaningful on the accuracy path (transform()).
     *
     *  @param {boolean}            [options.optimise=true]
     *      Run the pipeline optimiser to remove redundant conversions.
     *
     *  @param {boolean}            [options.roundOutput=true]
     *      Round numeric output to `precision` decimal places. Set false to
     *      keep raw floats (e.g. 243.20100198... for sub-integer accuracy).
     *
     *  @param {number}             [options.precision=0]
     *      Decimal places to round to when roundOutput=true.
     *
     *  @param {number}             [options.precession=0]
     *      @deprecated Long-standing typo of `precision`. Still accepted for
     *      backwards compatibility — `options.precision` and `options.precession`
     *      are interchangeable, and both `this.precision` and `this.precession`
     *      are populated for read. New code should use `precision`.
     *
     *  @param {boolean|boolean[]}  [options.BPC=false]
     *      Black Point Compensation. Pass a boolean to enable for ALL stages,
     *      or an array of booleans to control per-stage independently. The
     *      array indexes by STAGE number (0,1,2,…), NOT by chain index.
     *
     *  @param {boolean}            [options.clipRGBinPipeline=false]
     *      Clip RGB values to 0..1 inside the pipeline (useful when going
     *      through extreme abstract profiles).
     *
     *  @param {('auto'|'float'|'int'|'int16'|'int-wasm-scalar'|'int-wasm-simd'|'int16-wasm-scalar'|'int16-wasm-simd')} [options.lutMode='auto']
     *      LUT-based image hot-path kernel selector. Only meaningful when
     *      `dataFormat: 'int8'` or `'int16'` AND `buildLut: true`. Non-LUT
     *      (accuracy) paths are unaffected — they always run the float
     *      code.
     *
     *      'int16' is the u16 sibling of 'int' — same i32 ALU, same u16
     *      CLUT (built once via buildIntLut), but with Uint16Array I/O
     *      instead of Uint8ClampedArray. Output uses the canonical
     *      [0, 65280] → [0, 65535] bit-trick `v + (v >>> 8)` that is
     *      bit-exact for our cell scale (255 × 257 = 65535). Pairs
     *      naturally with `dataFormat: 'int16'` — see the 'auto'
     *      resolution rules below.
     *
     *      Modes (each one falls through to the previous if its kernel
     *      can't service the LUT shape or the host can't run it):
     *
     *        - 'auto' (default, v1.2+) — the engine picks the fastest
     *                               applicable kernel at construction
     *                               time based on `dataFormat` and
     *                               `buildLut`:
     *                                 • `dataFormat: 'int8'` + `buildLut:
     *                                   true` → resolves to 'int-wasm-simd'
     *                                   (with the SIMD → scalar → int
     *                                   demotion chain running at
     *                                   `create()` time for hosts that
     *                                   lack WASM or SIMD).
     *                                 • any other configuration →
     *                                   resolves to 'float'. (lutMode
     *                                   is ignored for non-int8
     *                                   dataFormats anyway, so the
     *                                   resolved value matches what
     *                                   actually runs.)
     *                               Inspect `xform.lutMode` after
     *                               construction to see the resolved
     *                               value — it reflects what will run.
     *
     *        - 'float'            — the original floating-point kernels.
     *                               Pin this explicitly when you want
     *                               bit-stable f64 LUT interp regardless
     *                               of release.
     *
     *        - 'int'              — integer-math kernels reading a u16
     *                               mirror LUT with Q0.8 fractional weights
     *                               and Math.imul. Typical 1.10–1.15×
     *                               speedup vs float on real ICC profiles,
     *                               with accuracy ≤2 LSB vs float (well
     *                               under perceptual threshold for u8 image
     *                               data). Uses 4× less LUT memory
     *                               (Uint16Array instead of Float64Array).
     *
     *        - 'int-wasm-scalar'  — (v1.2) same integer math as 'int' but
     *                               executed by a hand-written WebAssembly
     *                               kernel. Bit-exact against 'int' across
     *                               millions of verified pixels (6-config
     *                               matrix in `bench/wasm_poc/`). ~1.40×
     *                               over 'int' on x64 for 3D tetrahedral
     *                               workloads; see docs/Performance.md
     *                               "WASM scalar — measured" section.
     *
     *                               If WebAssembly is unavailable in the
     *                               host (very rare today — sandboxed
     *                               environments, ancient runtimes) this
     *                               silently demotes to 'int' at
     *                               `create()` time. 4D kernels are not
     *                               yet ported; 4D workloads through this
     *                               mode run the 'int' JS kernel.
     *
     *        - 'int-wasm-simd'    — (v1.2) channel-parallel WebAssembly
     *                               SIMD kernel for 3D tetrahedral LUTs.
     *                               Bit-exact against both the 'int' and
     *                               'int-wasm-scalar' paths across the
     *                               same 6-config matrix. ~3.0-3.5× over
     *                               'int' (2.0-2.5× over 'int-wasm-scalar')
     *                               on x64 for 3D RGB→RGB / RGB→CMYK; see
     *                               docs/Performance.md "WASM SIMD —
     *                               channel-parallel" section.
     *
     *                               Supports cMax ∈ {3, 4} only — other
     *                               channel counts fall through to the
     *                               scalar WASM kernel, then to 'int'. 4D
     *                               kernels are not ported. On hosts that
     *                               lack WebAssembly SIMD support this
     *                               silently demotes to 'int-wasm-scalar'
     *                               at `create()` time; demotes further
     *                               to 'int' if WebAssembly itself is
     *                               unavailable.
     *
     *        - 'int16-wasm-scalar' — (v1.3, Q0.13) sibling of
     *                               'int-wasm-scalar' for u16 I/O workloads.
     *                               Reads u16 input, writes u16 output (no
     *                               u8/u16 re-quantisation at the I/O
     *                               boundary). Q0.13 fixed-point fractional
     *                               weights (settled on Q0.13 after a brief
     *                               internal Q0.12 iteration during v1.3
     *                               development). Bit-exact against the JS
     *                               'int16' kernel across the 6-config matrix
     *                               (`bench/wasm_poc/tetra3d_int16_run.js`).
     *                               1.07–1.38× over 'int16' on x64 for 3D
     *                               tetrahedral; 1.96–2.53× over lcms-wasm
     *                               u16; see docs/Performance.md
     *                               "WASM int16 — measured" section.
     *
     *                               3D + 4D both ship (4D uses two-rounding
     *                               K-LERP for i32 safety). On hosts that
     *                               lack WebAssembly this demotes to 'int16'
     *                               at `create()` time.
     *
     *        - 'int16-wasm-simd'  — (v1.3, Q0.13) channel-parallel
     *                               WebAssembly SIMD kernel for u16 I/O.
     *                               Bit-exact against both 'int16' and
     *                               'int16-wasm-scalar' across the same
     *                               6-config matrix. Mirrors the
     *                               'int-wasm-simd' u8 design — vectorises
     *                               the four output channels in i32x4
     *                               lanes — but uses Q0.13 weights and
     *                               i16x8.narrow_i32x4_u for the u16
     *                               output store.
     *
     *                               Supports cMax ∈ {3, 4} only — other
     *                               channel counts fall through to the
     *                               scalar u16 WASM kernel, then to JS
     *                               'int16'. The 4D SIMD u16 kernel keeps
     *                               the K0 intermediate in a v128 local
     *                               register and skips the scratch-memory
     *                               round-trip the scalar 4D u16 kernel
     *                               needs. On hosts that lack WebAssembly
     *                               SIMD support this silently demotes to
     *                               'int16-wasm-scalar' at `create()` time;
     *                               demotes further to 'int16' if
     *                               WebAssembly itself is unavailable.
     *
     *      The 'auto' heuristic today is just "int8 + LUT → best WASM
     *      kernel" or "int16 + LUT → best WASM int16 kernel". Future releases may add per-Transform microbenchmarks
     *      (int JS can beat scalar WASM on older / weaker CPUs in some
     *      workloads) or host-capability heuristics. The public API is
     *      stable either way — 'auto' always means "pick the fastest
     *      applicable kernel for this Transform on this host".
     *
     *      The integer kernels are NOT recommended for color-measurement
     *      workflows that compare transformed pixel values to reference
     *      targets — pin `lutMode: 'float'` (or `buildLut: false` for the
     *      f64 pipeline) for that. See `bench/fastLUT_real_world.js` for
     *      accuracy/speed numbers on real profiles.
     *
     *  @param {Object} [options.wasmCache]
     *      Optional shared cache bag for the compiled `WebAssembly.Module`.
     *      Used when `lutMode` is `'int-wasm-scalar'` or `'int-wasm-simd'`.
     *      Each Transform still gets its own `WebAssembly.Instance` (its
     *      own linear memory); sharing the compiled module just avoids
     *      redundant compile work. Scalar and SIMD modules live under
     *      different private keys on the bag, so you can use a single
     *      cache for a mix of Transforms. Example:
     *
     *          const wasmCache = {};
     *          const t1 = new Transform({ lutMode: 'int-wasm-simd',   wasmCache });
     *          const t2 = new Transform({ lutMode: 'int-wasm-scalar', wasmCache });
     *
     *  @param {boolean}            [options.verbose=false]
     *  @param {boolean}            [options.verboseTiming=false]
     *      Log pipeline construction info / build timings to console.
     *
     *  @constructor
     */
     class Transform{

        // Kernel module descriptors, indexed by INPUT CHANNEL COUNT, 1..15 —
        // the full ICC range (FCLR is 15 channels, see Profile.js). Dense, so
        // setKernel() is one array index with no key string to build, and any
        // single dimension can be replaced without disturbing its neighbours.
        //
        // Slots 5..15 hold the SAME KernelND descriptor object today. That is
        // deliberate: eleven independently replaceable slots cost nothing (one
        // object, therefore one hidden class), and they let someone with a real
        // 7-channel workload register a tuned Kernel7D — or a test park a probe
        // at dimension 9 — without forking the generic implementation.
        //
        // Registered once via Transform.registerKernel(); instantiated per
        // Transform in setKernel() via Object.create(descriptor).
        // See docs/deepdive/KernelContract.md.
        static kernels = [];

        // Highest input channel count a kernel can be registered for. ICC tops
        // out at FCLR = 15.
        static MAX_KERNEL_DIMENSIONS = 15;

        // Set by Transform.compatibility(); null means current defaults.
        static _compatDefaults = null;

        /**
         * Pin construction defaults to an earlier release's behaviour.
         *
         *     Transform.compatibility('1.5');      // 1.5.0 output
         *     Transform.compatibility(null);       // back to current
         *     Transform.compatibility();           // returns the active pin
         *
         * WHY A NAMED SNAPSHOT RATHER THAN A SETTINGS BAG. An upgrade should
         * not require finding and setting each changed default by hand — that
         * is a research task with a silent failure mode. A version is one call,
         * it documents itself, and it cannot drift: the list below IS the
         * changelog of defaults that move output.
         *
         * NOT AN ENVIRONMENT VARIABLE, deliberately. This changes PIXELS, and
         * `process.env` does not exist in a browser — a setting that worked in
         * Node and silently did nothing in the browser would be worse than no
         * setting. (Pool sizing is environment-configurable, because that is a
         * Node-only subsystem and cannot change a pixel; see src/pool.js.)
         *
         * CALL IT BEFORE CONSTRUCTING ANYTHING. Defaults are read at
         * construction, so a Transform built earlier keeps what it was built
         * with. That is the one sharp edge, and it is why this is a single call
         * at startup rather than a mutable configuration object.
         *
         * @param {string|null} [version]  '1.5' | null | omitted to read
         * @returns {string|null} the version now pinned
         */
        /**
         * Start the worker pool now, and report whether it worked.
         *
         * STATIC, NOT PER-INSTANCE, because the pool is process-wide: workers
         * are shared across every Transform, which is what makes the
         * per-worker transform cache worth having. `t.enablePool()` would
         * imply two Transforms get two pools.
         *
         *     await Transform.enablePool();                       // Node
         *     await Transform.enablePool({cores: 4});
         *
         * Everything else falls back to sequential silently on failure, which
         * is right — multicore is an optimisation, never a capability. This is
         * for the caller who deliberately wants parallelism and would rather
         * find out at startup than ship something that quietly runs on one
         * thread. It also warms the pool, so the first batch is not the one
         * paying for spawning.
         *
         * Rejects with the reason. In a browser that reason is currently "no
         * worker backend" — the Web Worker pool is 1.6 work; see the Roadmap.
         *
         * @param {object} [options]  pool options, e.g. {cores, maxThreads}
         * @returns {Promise<{workers:number, host:string}>}
         */
        static enablePool(options){
            var o = Transform._normalisePoolOptions(options);
            var restart     = o.restart === true;
            var cancelQueue = o.cancelQueue === true;
            delete o.restart; delete o.cancelQueue;

            // ALREADY ENABLED IS A NO-OP, not an error. Two modules that both
            // want a pool should both be able to say so; making the second
            // caller throw would mean every caller has to know whether it is
            // first, which is the kind of coupling a process-wide resource
            // should absorb rather than export.
            if(Transform._poolDefault && !restart){
                // Different options, though, are worth a word: silently
                // ignoring them means someone believes they reconfigured the
                // pool and did not.
                if(Transform._poolOptionsDiffer(o, Transform._poolDefault)
                   && !Transform._warnedPoolReconfig){
                    Transform._warnedPoolReconfig = true;
                    console.warn('jsColorEngine: enablePool() called again with different ' +
                        'options — ignored, the pool is already running. Use ' +
                        'enablePool({restart: true, ...}) to reconfigure it, or ' +
                        'restartPool(...).');
                }
                return Promise.resolve(Transform._poolInfo
                    ? Object.assign({alreadyEnabled: true}, Transform._poolInfo)
                    : {alreadyEnabled: true});
            }

            var settle = Promise.resolve();
            if(restart && Transform._poolDefault){
                // RECONFIGURING MEANS REPLACING THE WORKERS, and workers hold
                // fragments. Draining first is the safe default: in-flight
                // images finish and their callbacks fire. cancelQueue trades
                // that for immediacy — the work stops and every affected image
                // fires its callback with a cancelled result, so nothing is
                // left waiting either way.
                if(cancelQueue){ try { _pool.cancelAll(); } catch(e){ /* nothing queued */ } }
                settle = _pool.onQueueFree();
            }

            return settle.then(function(){
                // Tear down BEFORE starting: pools are keyed by worker count,
                // so enabling 6 after 2 without this leaves both alive and the
                // process holding 8 workers for a pool of 6.
                Transform.disablePool();
                return _pool.enable(o);
            }).then(function(info){
                // Enabling is also SWITCHING ON. A caller who starts a pool
                // means their batches to use it; making them repeat
                // `multicore: true` at every call site is a papercut that
                // produces exactly one bug — the call that forgot.
                Transform._poolDefault = o;
                Transform._poolInfo    = info;
                return info;
            });
        }

        /**
         * Reconfigure a running pool. Sugar for `enablePool({restart: true})`,
         * and the honest name for what a test wants between cases.
         *
         *     await Transform.restartPool({workers: 4});
         *     await Transform.restartPool({workers: 4, cancelQueue: true});
         *
         * Waits for in-flight work to finish unless `cancelQueue` is set.
         */
        static restartPool(options){
            var o = {};
            for(var k in (options || {})) o[k] = options[k];
            o.restart = true;
            return Transform.enablePool(o);
        }

        /** Do two normalised option sets ask for a different pool? */
        static _poolOptionsDiffer(a, b){
            var keys = {};
            for(var i in a) keys[i] = true;
            for(var j in b) keys[j] = true;
            for(var k in keys){ if(a[k] !== b[k]) return true; }
            return false;
        }

        /**
         * Tear the pool down and stop defaulting batches to it.
         * Anything explicitly asking for `multicore` still gets its own pool.
         */
        static disablePool(){
            Transform._poolDefault = null;
    Transform._poolInfo = null;
    Transform._warnedPoolReconfig = false;
            Transform._poolInfo    = null;
            _pool.destroyAll();
        }

        /**
         * Accept the words people actually reach for.
         *
         * The pool's own vocabulary is `cores` / `maxThreads` / `minThreads`,
         * which is accurate — but they are workers, and callers write
         * `workers` / `maxWorkers`. Same spirit as buildLut/builtLut and
         * matrixShaper/wasmMatrixShaper: one concept, more than one spelling,
         * resolved in one place rather than checked for in several.
         */
        static _normalisePoolOptions(options){
            var o = {};
            for(var k in (options || {})) o[k] = options[k];
            if(o.workers    !== undefined && o.cores      === undefined) o.cores      = o.workers;
            if(o.maxWorkers !== undefined && o.maxThreads === undefined) o.maxThreads = o.maxWorkers;
            if(o.minWorkers !== undefined && o.minThreads === undefined) o.minThreads = o.minWorkers;
            delete o.workers; delete o.maxWorkers; delete o.minWorkers;
            // `url` is where the Web Worker bundle lives. Carried, not used:
            // the browser backend is 1.6 work, and enable() rejects there with
            // that spelled out rather than pretending the URL did something.
            return o;
        }

        static compatibility(version){
            if(version === undefined) return Transform._compatVersion || null;

            if(version === null || version === 'latest' || version === false){
                Transform._compatDefaults = null;
                Transform._compatVersion  = null;
                return null;
            }

            var key = String(version).split('.').slice(0, 2).join('.');
            var known = Transform.COMPAT_DEFAULTS[key];
            if(!known){
                throw new Error('Transform.compatibility: unknown version "' + version +
                    '". Known: ' + Object.keys(Transform.COMPAT_DEFAULTS).join(', ') +
                    ', or null for current defaults.');
            }
            Transform._compatDefaults = known;
            Transform._compatVersion  = key;
            return key;
        }

        constructor(options){

            options = options || {};

            // COMPATIBILITY DEFAULTS, if a version was pinned. Applied UNDER
            // the caller's options, never over them: an explicit setting always
            // wins, so pinning changes what you get by default and nothing you
            // asked for. See Transform.compatibility().
            if(Transform._compatDefaults){
                var _merged = {};
                for(var _c in Transform._compatDefaults) _merged[_c] = Transform._compatDefaults[_c];
                for(var _o in options) if(options[_o] !== undefined) _merged[_o] = options[_o];
                options = _merged;
            }

            this.kernel = null;

            // Cache the raw constructor options so behaviours applied via t.use()
            // can read plugin-specific values (e.g. totalInk) without the caller
            // having to repeat them at use() time.
            this._originalOptions = options;

            // Namespaced plugin store — each plugin/behaviour should write its state
            // here rather than directly onto the Transform instance, preventing
            // collisions between plugins and with future Transform properties.
            //   transform.plugin['ink-limit'].totalInk = 260
            //   transform.plugin['ink-limit'].initialised = true   (author's guard)
            this.plugin = Object.create(null);

            // Accept both spellings: `builtLut` (original) and `buildLut` (the name
            // used throughout the JSDoc and in newer docs). They mean the same thing —
            // "precompute and store a LUT for the fast image path". Internally we
            // normalise to `this.builtLut` to keep all downstream code untouched.
            this.builtLut = (options.builtLut === true) || (options.buildLut === true);

            // `builtLut` doubles as intent ("build one") and state ("have
            // one") — setLut() sets it true on a Transform that never asked.
            // clear() has to restore the INTENT, so the constructor's answer
            // is kept separately rather than inferred from the current value.
            this._buildLutRequested = this.builtLut;

            // THE WASM IMPLEMENTATION of the matrix-shaper maths. Named for
            // the WASM part because the pipeline is ALREADY a matrix shaper —
            // the optimiser folds an RGB->RGB pair into
            // stage_Gamma_Inverse -> stage_matrix_rgb -> stage_Gamma, in JS
            // float, and that is the exact reference everything here is
            // measured against. It is simply slow: ~8 MPx/s against ~229 for
            // the same arithmetic in WASM SIMD. Nothing about the maths
            // changes; only who executes it.
            //
            // Three modes,
            // because there are three genuinely different answers:
            //
            //   'auto'   (default) use it where there is no LUT to displace.
            //                      Nothing the caller asked for changes.
            //   'prefer'           ALSO replace a CLUT that was asked for.
            //                      331 MPx/s against 123 on a photo, and
            //                      within 1 LSB
            //                      of the exact pipeline where the CLUT can be
            //                      25 LSB out. Opt-in because a LUT is also an
            //                      object callers export, clone and inspect.
            //   false              never. The honest reference for comparing
            //                      against, and a way out if a host misbehaves.
            //
            // Note "prefer" rather than "force": the kernel declines for a
            // list of ordinary reasons — identity pairs, LUT-based RGB
            // profiles, per-channel TRCs, a dataFormat other than int8 or
            // int16 — and a mode named force would either have to throw on
            // all of them or quietly not force. A host without WASM SIMD is
            // NOT one of those reasons: it gets the scalar build, which is
            // bit-identical and merely slower.
            // `wasmMatrixShaper` is the name; `matrixShaper` and
            // `preferMatrixShaperOverLUT` are accepted spellings, in the same
            // spirit as buildLut/builtLut above.
            var _ms = options.wasmMatrixShaper;
            if(_ms === undefined) _ms = options.matrixShaper;
            if(options.preferMatrixShaperOverLUT === true) _ms = 'prefer';
            if(_ms === true) _ms = 'prefer';
            if(_ms === false || _ms === 'off' || _ms === 'none') _ms = 'off';
            if(_ms !== 'prefer' && _ms !== 'off') _ms = 'auto';
            this.wasmMatrixShaper = _ms;

            // PER-TRANSFORM MULTICORE DEFAULT. _multicoreHandoff() has always
            // read `this.multicore` as the fallback when a call passes no
            // `multicore` option — but nothing ever set it, so the fallback was
            // permanently undefined and `new Transform({multicore: true})`
            // silently did nothing. Wired here so the option a caller passes to
            // the constructor means what it looks like it means.
            this.multicore = (options.multicore === undefined) ? false : options.multicore;

            // Derived flags so the decisions downstream read plainly.
            this.preferMatrixShaperOverLUT = (_ms === 'prefer');

            // Gamut mode: 'none', 'color', 'map'. bakeLutGamut:true is legacy for 'color'.
            if (options.lutGamutMode && options.lutGamutMode !== 'none') {
                this.lutGamutMode = options.lutGamutMode;
            } else {
                this.lutGamutMode = (options.bakeLutGamut === true) ? 'color' : 'none';
            }
            this.lutGamutLimit = options.lutGamutLimit || 5;
            this.lutGamutMapScale = options.lutGamutMapScale || 25.5;

            // default is cmsLab(0, 127, 127) which is a bright pink that stands out in most gamuts
            this.lutGamutColor = options.lutGamutColor || this.Lab(0, 127, 127);
            this.gamutDeFn = options.gamutDeFn || convert.deltaE1976;

            // TODO: accept options.lutGamutColorMap as an array of device colours
            //       for multi-stop heatmaps (e.g. white → yellow → red → black).
            //       gamutCheck would then pick the stop pair based on the scaled ΔE.

            this.gamutTransforms = {};
            this.gamutColorDevice = [];
            this.gamutWhiteDevice = [];

            this.lutGridPoints3D = (isNaN(Number(options.lutGridPoints3D))) ? 33 : Number(options.lutGridPoints3D);
            this.lutGridPoints4D = (isNaN(Number(options.lutGridPoints4D))) ? 17 : Number(options.lutGridPoints4D);

            // LUT image-hot-path kernel selector. See JSDoc above for full
            // semantics. v1.2+ ships 'auto' (default), 'float', 'int',
            // 'int-wasm-scalar', 'int-wasm-simd'. Unknown values fall back
            // to 'auto' so a typo or forward-written code can never crash a
            // production transform — verbose mode warns when this happens.
            var rawLutMode = (options.lutMode === undefined) ? 'auto' : ('' + options.lutMode);
            switch(rawLutMode){
                case 'float':
                case 'int':
                case 'int16':
                case 'int-wasm-scalar':
                case 'int-wasm-simd':
                case 'int16-wasm-scalar':
                case 'int16-wasm-simd':
                    this.lutMode = rawLutMode;
                    this.lutModeRequested = rawLutMode;
                    break;
                case 'auto':
                    // 'auto' is a heuristic: pick the fastest kernel that's
                    // applicable to this Transform's (dataFormat, buildLut)
                    // combination. int8 + buildLut=true gets the full WASM
                    // SIMD hot path (with SIMD → scalar → int demotion at
                    // create() time for older hosts). int16 + buildLut=true
                    // resolves to the WASM int16 scalar kernel (with int16
                    // JS demotion when WASM is unavailable — see roadmap
                    // v1.3.x for the int16 SIMD ceiling lift). Everything
                    // else runs the float kernel — which is what the engine
                    // would have used anyway, because lutMode is ignored for
                    // non-LUT dataFormats. Resolving the mode here makes
                    // xform.lutMode self-documenting: it always reflects
                    // the kernel that will actually run.
                    if(options.dataFormat === 'int8' && this.builtLut){
                        this.lutMode = 'int-wasm-simd';
                    } else if(options.dataFormat === 'int16' && this.builtLut){
                        this.lutMode = 'int16-wasm-simd';
                    } else {
                        this.lutMode = 'float';
                    }
                    this.lutModeRequested = 'auto';
                    break;
                default:
                    if(Transform._plugins[rawLutMode]){
                        // Plugin-registered mode — accepted as-is. The kernel
                        // resolves the plugin's run in its own init().
                        this.lutMode = rawLutMode;
                        this.lutModeRequested = rawLutMode;
                        // initialise — per-instance, runs here in the constructor.
                        // Gets (transform, rawOpts): validate options, store state on
                        // transform.plugin[name], add hooks — anything per-instance.
                        // Constructor runs once per instance so no double-up possible.
                        var _pEntry = Transform._plugins[rawLutMode];
                        if(_pEntry && _pEntry.initialise){
                            _pEntry.initialise(this, options);
                        }
                    } else {
                        if(options.verbose === true){
                            console.warn('Unknown lutMode "' + rawLutMode + '" — falling back to "auto". Valid values: auto, float, int, int16, int-wasm-scalar, int-wasm-simd, int16-wasm-scalar, int16-wasm-simd.');
                        }
                        // Forward-compat: unknown modes resolve as if user had
                        // said 'auto' — gets them the best-available kernel
                        // without crashing, better than the previous behaviour
                        // (silent demote to slowest) for someone writing against
                        // a future version that adds a new mode.
                        if(options.dataFormat === 'int8' && this.builtLut){
                            this.lutMode = 'int-wasm-simd';
                        } else if(options.dataFormat === 'int16' && this.builtLut){
                            this.lutMode = 'int16-wasm-simd';
                        } else {
                            this.lutMode = 'float';
                        }
                        this.lutModeRequested = 'auto';
                    }
            }

            // WASM kernel state. Populated at create() time when lutMode is
            // 'int-wasm-scalar' or 'int-wasm-simd' and the host supports
            // WebAssembly. Null means "no WASM available or no WASM kernel
            // eligible for this LUT shape"; the dispatcher falls back to the
            // JS 'int' kernel on null.
            //
            // All four u8 states can be present simultaneously when lutMode=
            // 'int-wasm-simd':
            //   - wasmTetra3DSimd : 3D SIMD, cMax ∈ {3, 4}
            //   - wasmTetra3D     : 3D scalar, every cMax (fallthrough)
            //   - wasmTetra4DSimd : 4D SIMD, cMax ∈ {3, 4}
            //   - wasmTetra4D     : 4D scalar, every cMax (fallthrough)
            // If the SIMD module fails to compile (host lacks SIMD), lutMode
            // is demoted to 'int-wasm-scalar' and both wasmTetra*Simd are
            // left null; the two scalar states stay loaded.
            //
            // For lutMode='int16-wasm-scalar' (v1.3) the 3D u16 + 4D u16
            // scalar states are loaded; both share one wasmCache bag and
            // distinct module keys. The int16 SIMD ceiling lift is tracked
            // under roadmap v1.3.x.
            //
            // The optional shared-module cache is taken here so multiple
            // Transforms created from the same bag share compile work. Each
            // Transform still has its own linear-memory instance.
            this.wasmCache             = options.wasmCache || null;

            // Kernel-scoped options, keyed by kernel name, passed through to
            // kernels untouched:
            //
            //     new Transform({ kernelOptions: { kernel3D: { f32: true } } })
            //
            // Transform never validates or interprets these — it does not know
            // what any of them mean, and a typo is the kernel's to catch,
            // because the kernel owns the schema. See _kernelOpts() and
            // docs/deepdive/KernelContract.md.
            this.kernelOptions         = options.kernelOptions || null;
            this._wasmShrinkRatio      = options.wasmShrinkRatio || 0;
            this._wasmMaxMemory        = options.wasmMaxMemory !== undefined
                ? options.wasmMaxMemory : 128 * 1024 * 1024;
            // WASM STATE LIVES ON THE KERNEL (v1.6 phase 4c —
            // docs/deepdive/KernelContract.md). The eight wasmTetra* slots that
            // used to be declared here are initialised by setKernel() on the
            // kernel instance, because the kernel is what uses them. Reading
            // `transform.wasmTetra3D` still works — see the forwarding
            // accessors at the bottom of this file — but the state is the
            // kernel's, which is what lets a kernel eventually load only its
            // own dimension's modules.

            // NO DISPATCH STATE LIVES HERE. It used to: _lutKernelBig,
            // _lutKernelSmall and _lutKernelThreshold were fields on this
            // Transform, and a resolver method kept them current. They belong
            // to the kernel -- which variant runs, and how big a batch has to
            // be to be worth a WASM call, are the kernel's own business and
            // nothing out here needs to know a choice was made.
            //
            // The two booleans below are Transform's, and are only a cache of
            // its own lutMode string so the hot path stops re-comparing it.
            this._expectsU16         = false; // cached: lutMode is int16 family
            this._isIntegerMode      = false; // cached: lutMode is any integer family

            // REMOVED IN v1.6: transformArrayFn / bindTransformArrayFn.
            //
            // A closure bound at create() so transformArray() could skip a
            // layer of routing. The Roadmap recorded the measurement that
            // killed it -- "no faster for images and slower for tiny batches"
            // -- and it shipped defaulted to off. Once the kernels owned
            // dispatch, its LUT branch was a wrapper that called
            // kernel.array(), so it could not be faster than the thing it
            // called. transformArray() now reaches the kernel directly.
            //
            // bindTransformArrayFn is still accepted and ignored, so option
            // objects written against v1.5 keep working.

            // LUT build hooks — run per grid cell during createNDDeviceLUT,
            // zero per-pixel cost. Each array holds functions chained in
            // order; addLutInputHook / addLutOutputHook manage ordering.
            this._lutInputHooks  = [];
            this._lutOutputHooks = [];
            if (typeof options.lutInputHook === 'function') {
                this._lutInputHooks.push(options.lutInputHook);
            }
            if (typeof options.lutOutputHook === 'function') {
                this._lutOutputHooks.push(options.lutOutputHook);
            }

            this.interpolation3D = options.interpolation3D ? options.interpolation3D.toLowerCase() : 'tetrahedral';
            this.interpolation4D = options.interpolation4D ? options.interpolation4D.toLowerCase() : 'tetrahedral';
            this.interpolationFast = options.interpolationFast !== false;

            this.LUTinterpolation3D = options.LUTinterpolation3D ? options.LUTinterpolation3D.toLowerCase() : this.interpolation3D;
            this.LUTinterpolation4D = options.LUTinterpolation4D ? options.LUTinterpolation4D.toLowerCase() : this.interpolation4D;

            this.labAdaptation = options.labAdaptation === true;
            this.displayChromaticAdaptation = options.displayChromaticAdaptation === true;
            this.labInputAdaptation = options.labInputAdaptation !== false;

            this.dataFormat = options.dataFormat || 'object'; // object, objectFloat, int8, int16, device

            if(!options.dataFormat){
                // Obsolete, use dataFormat instead
                if(options.useFloats){
                    console.log('useFloats is obsolete, use dataFormat instead')
                    this.dataFormat = 'objectFloat';
                }
            }

            var convertInputOutput = true;
            switch(this.dataFormat){
                case 'object':
                    convertInputOutput = true
                    break;
                case 'objectFloat':
                    convertInputOutput = true
                    this.useFloats = true; // backwards compatibility
                    break;
                case 'int8':
                case 'int16':
                    convertInputOutput = true;
                    break;
                case 'device':
                    convertInputOutput = false;
                    break;
                default:
                    throw 'Invalid dataFormat "' + this.dataFormat + '". Must be "object", "objectFloat", "int8", "int16" or "device"';
            }

            this.convertInputOutput = convertInputOutput;
            this.validateOnCreate  = options.validateOnCreate  !== false;
            this.detectIdentity    = options.detectIdentity    !== false;
            this.isIdentity        = false;

            // useCurveLut: replaces Math.pow gamma stages with a 4096-entry LUT lookup.
            //   true    — use LUT (faster, error ≤ 0.03 LSB at 8-bit output — imperceptible)
            //   false   — exact Math.pow / piecewise sRGB (default — backward compatible)
            // The accuracy trade-off is safe for image work but is opt-in so existing
            // tests and precision-sensitive workflows are unaffected.
            this.useCurveLut = options.useCurveLut === true;

            // pixelCache: memoise the accuracy path at the device boundary.
            //   0 / false — off (default)
            //   1         — single entry: catches solid fills and runs
            //   16, 32 …  — direct-mapped table (rounded to a power of two):
            //               also catches repeating palettes and dithers
            // One number rather than an enabled+size pair, which would admit
            // the meaningless {enabled: true, size: 0}. See
            // docs/deepdive/PixelCache.md.
            this.pixelCache = (options.pixelCache === true) ? 1 : (Number(options.pixelCache) || 0);
            if(this.pixelCache < 0 || isNaN(this.pixelCache)){ this.pixelCache = 0; }
            this._pixelCacheData = null;

            this.verbose = options.verbose === true;
            this.verboseTiming = options.verboseTiming === true;
            this.pipelineDebug = options.pipelineDebug === true;
            this.optimise = options.optimise !== false;
            this.optimiseDebug = [];
            this.roundOutput = options.roundOutput !== false;
            // `precision` is the canonical option name. `precession` is a
            // long-standing typo kept for backwards compatibility — both spellings
            // are accepted here, and both `this.precision` and `this.precession`
            // are populated so existing read sites keep working unchanged.
            var rawPrecision = (options.precision !== undefined) ? options.precision : options.precession;
            this.precision = (isNaN(Number(rawPrecision))) ? 0 : Number(rawPrecision);
            this.precession = this.precision; // @deprecated alias

            if(Array.isArray(options.BPC)){
                this.useBPC = options.BPC; // can use an array to specify which channels to which stage
            } else {
                this.useBPC = options.BPC === true; // defaults to off
            }

            this._BPCAutoEnable = true;
            this.usesBPC = false;
            this.usesAdaptation = false;
            this._expandRGBStages = true
            this._RGBMatrixWhiteAdadaptation = false
            this.clipRGBinPipeline = options.clipRGBinPipeline === true;


            /** @type {_Stage[]}  */
            this.pipeline = [];

            this.pipelineHistory = [];
            this.pipelineCreated = false;
            this.debugHistory = [];
            this.debugHistoryDecimals = 6;
            this.lut = false;
            this.inputProfile = null;
            this.outputProfile = null;
            this.chain = [];
            this.customStages = false;

            // Multicore bookkeeping. `_workerKey` is this Transform's identity
            // in the worker pool, assigned on first use and dropped by
            // createMultiStage(); `_multicoreSafe` caches whether its LUT
            // survives a worker rebuild. Both are per-Transform and neither
            // means anything until transformImages() runs.
            this._workerKey = null;
            this._multicoreSafe = undefined;

            // Which claiming kernel took the batch path, if any — set by
            // _claimKernel() at the end of create(). See kernelInfo().
            this._kernelClaim = null;

            this.inputChannels = 0;
            this.outputChannels = 0;
        };

        /**
         * Register a kernel module descriptor.
         * Binds all array-kernel variants and lifecycle methods to Transform.prototype.
         * The HOW of binding is entirely inside this method — change it here to
         * experiment with different dispatch claimKernels (prototype, this.kernels[key], etc.).
         *
         * @param {object} descriptor  Kernel module export (see docs/deepdive/KernelModules.md)
         */
        static registerKernel(descriptor){
            var MAX = Transform.MAX_KERNEL_DIMENSIONS;
            var dims = descriptor ? descriptor.dimensions : undefined;

            // `dimensions` is either one channel count, or an inclusive
            // [from, to] range so a generic kernel claims its whole span in one
            // call (KernelND registers 5..15 that way). Legacy 'ND' is accepted
            // and means the same thing.
            var from, to;
            if(typeof dims === 'string' && dims.toLowerCase() === 'nd'){
                from = 5; to = MAX;
            } else if(Array.isArray(dims) && dims.length === 2
                      && typeof dims[0] === 'number' && typeof dims[1] === 'number'){
                from = dims[0]; to = dims[1];
            } else if(typeof dims === 'number'){
                from = to = dims;
            } else {
                // Deliberately NOT Number(dims): a one-element array coerces to
                // its element, so `dimensions: [3]` would silently register at 3
                // instead of being rejected as the malformed range it is.
                from = to = NaN;
            }

            var valid = descriptor
                && isFinite(from) && isFinite(to)
                && from === Math.floor(from) && to === Math.floor(to)
                && from >= 0 && to <= MAX && from <= to;
            if(!valid){
                throw new Error('Transform.registerKernel: descriptor.dimensions must be '
                    + '0-' + MAX + ', or [from, to] within that range');
            }

            // TWO KINDS OF KERNEL, ONE REGISTRATION CALL.
            //
            // A DIMENSIONAL kernel owns a channel count and is chosen before
            // the pipeline exists — 3 channels in means Kernel3D, always.
            //
            // A CLAIMING kernel declares `claims(transform)` and is offered the
            // transform AFTER the pipeline is built, because what it needs to
            // know is not the channel count but the SHAPE the optimiser folded
            // the conversion into. sRGB->AdobeRGB and sRGB->GRACoL are both
            // 3-channel input; only one of them is a matrix shaper.
            //
            // Claiming kernels are held in registration order and asked in that
            // order, so a later registration is a lower priority than an
            // earlier one. They do not displace the dimensional slot: a pair
            // that is not claimed still gets Kernel3D, and so does every LUT.
            // One descriptor object into every slot in the range. Sharing the
            // object is what keeps this free: Object.create(descriptor) in
            // setKernel() produces one hidden class for the whole span.
            for(var d = from; d <= to; d++){
                Transform.kernels[d] = descriptor;
            }
        }

        /**
         * Offer this Transform to the claiming kernels, in registration order.
         *
         * Called once at the end of create(), after `pipelineCreated`. The
         * first kernel to claim replaces `this.kernel` for the batch path; the
         * dimensional kernel it displaces is simply dropped, because a claimed
         * transform has no LUT for that kernel to walk.
         *
         * The reason it cannot happen in setKernel(): the answer depends on the
         * pipeline, and at setKernel() time there is not one yet.
         */
        /** Release and detach the current kernel instance, if any. */
        _releaseKernel(){
            if(this.kernel && typeof this.kernel.release === 'function'){
                try { this.kernel.release(); } catch(e){ /* nothing held */ }
            }
            this.kernel = null;
        }

        /**
         * What a kernel is allowed to know about this Transform.
         *
         * Passed to init() rather than handing over the Transform itself, so a
         * kernel does not have to reach for private fields to answer a
         * question. `transform` is still here because a claiming kernel may need to
         * walk the pipeline, but everything a claiming kernel actually *decides* on
         * should be a named entry rather than a field it went looking for.
         *
         * This is also where kernel-scoped options arrive — see the
         * `kernelOptions` discussion in docs/deepdive/KernelContract.md.
         */
        _kernelOpts(){
            return {
                transform:         this,
                lutMode:           this.lutMode,
                dataFormat:        this.dataFormat,
                verbose:           this.verbose,
                wasmMatrixShaper:  this.wasmMatrixShaper,
                pixelCacheActive:  this._pixelCacheData !== null && this._pixelCacheData !== undefined,
                kernelOptions:     this.kernelOptions || null,
            };
        }

        /**
         * Let the kernel that owns this dimension settle the pipeline and,
         * if it wants to, hand the batch path to something better.
         *
         * v1.6 phase 5. This used to walk Transform.claimKernels — one registry
         * on Transform, asked of every conversion whatever its channel count,
         * even though the only entry in it has nothing to say about CMYK. The
         * list now belongs to the kernel that owns the dimension, and Transform
         * asks one question of one object.
         *
         * IT OWNS BOTH SURFACES OR NEITHER. A kernel returning a rewritten
         * pipeline must also settle the batch path, or transform(colour) and
         * transformArray() can disagree — see the red-kernel note in the
         * contract. Nothing built-in rewrites the pipeline yet; when something
         * does, the re-optimise and re-validate below is what keeps it honest.
         */
        _initKernel(){
            this._kernelClaim = null;

            // ON THE INSTANCE, NOT THE DESCRIPTOR. setKernel() has already made
            // a per-Transform instance; calling init() on the shared descriptor
            // instead would have every Transform of a dimension writing its
            // decision into one object — the next conversion would inherit the
            // last one's. The prototype chain hides that until an instance
            // field shadows it, which is exactly how it was found.
            var kernel = this.kernel;
            if(!kernel || typeof kernel.init !== 'function') return;

            var result;
            try {
                result = kernel.init(this.pipeline, this._kernelOpts());
            } catch(e){
                // A BROKEN init MUST NOT BREAK create(), but it must not be
                // silent either. Declining is always an available answer, so a
                // third-party kernel that throws simply does not get the
                // transform — but a swallowed exception hid a ReferenceError in
                // one of the BUILT-IN kernels through an entire test suite,
                // because falling back to the table path is also the correct
                // outcome. The tests passed on an accident.
                //
                // Warned once per process: a kernel that throws on one create()
                // throws on all of them, and a warning per conversion would be
                // its own problem.
                if(!Transform._warnedKernelInit){
                    Transform._warnedKernelInit = true;
                    console.warn('jsColorEngine: kernel "' + (kernel.name || '?')
                        + '" threw from init() and was ignored — the dimension kept '
                        + 'its default path. This is a bug in that kernel: ' + e);
                }
                return;
            }
            if(!result) return;

            if(result.pipeline && result.pipeline !== this.pipeline){
                this.pipeline = result.pipeline;
                this.optimisePipeline();
                if(this.validateOnCreate && !this.validatePipeline()){
                    throw new Error('jsColorEngine: a kernel rewrote the pipeline and it '
                        + 'no longer validates. See kernel "' + kernel.name + '".');
                }
            }

            // `meta` is what the kernel decided, in its own words. Transform
            // stores it rather than interpreting it — the only thing it knows
            // is that a kernel which settled on something other than its
            // default says so.
            this._kernelClaim = (result.meta && result.meta.claimed) ? result.meta : null;
            if(this.verbose && this._kernelClaim){
                console.log('Kernel "' + this._kernelClaim.name + '" took this transform');
            }

            // A kernel MAY still hand back a different object to run the batch
            // path. Nothing built-in does — the matrix shaper is Kernel3D's own
            // other implementation, not a separate kernel — but the door stays
            // open for one that genuinely is.
            if(result.kernel){
                var instance = result.kernel;
                if(typeof instance.create === 'function'){
                    this.lutMode = instance.create(this.lutMode);
                }
                this.kernel = instance;
            }
        }

        /**
         * Which kernel is actually running the batch path, and how.
         *
         * `claimed` distinguishes a kernel that asked for this transform from
         * the dimensional default. Diagnostic only — nothing dispatches on it.
         *
         * @returns {object|null}
         */
        kernelInfo(){
            if(!this.kernel) return null;

            // THE KERNEL DESCRIBES ITSELF. Transform used to infer this from
            // fields it reached for — name, claimed, then _impl.variant/bits/simd
            // if claimed — which meant it knew the shape of one particular
            // kernel's internals. A kernel that has something to report says so;
            // one that has not gets the default.
            //
            // LIVE, not a snapshot taken at init(). `built` is false between the
            // decision and the first array call, and the WASM variant is not
            // known until the tables are built — both are real states worth
            // being able to see, and a bundle returned from init() could not
            // show either.
            var info = (typeof this.kernel.info === 'function')
                ? this.kernel.info()
                : { name: this.kernel.name || ('kernel' + (Array.isArray(this.kernel.dimensions)
                        ? 'ND' : this.kernel.dimensions + 'D')),
                    dimensions: this.kernel.dimensions,
                    claimed: false };

            info.lutMode = this.lutMode;
            info.hasLut  = this.lut !== false && !!this.lut;
            return info;
        }

        setKernel(inChannels) {
            // One array index. No key string to build, no `> 4` special case —
            // the registry is dense over 1..15 and KernelND occupies 5..15.
            var descriptor = Transform.kernels[inChannels];
            if(!descriptor){
                // No kernel module registered for this dimension (yet) —
                // no kernel module is registered for this dimension.
                this.kernel = null;
                return;
            }
            // Object.create(descriptor) — the descriptor IS the prototype. Each
            // Transform gets its own instance so per-instance state (_variant,
            // run refs, transform ref) is never shared across Transforms.
            // Own-properties are added in a fixed order so every instance of a
            // given dimension shares one hidden class (monomorphic dispatch).
            var instance = Object.create(descriptor);
            instance.transform = this;
            instance._variant = null;
            // The kernel's own image path. Declared here only so every
            // instance of a dimension shares one hidden class - written by the
            // kernel's init(), read by nothing outside it:
            //   arrayFnBig : run for pixelCount >= threshold
            //   arrayFnSml : run for pixelCount <  threshold
            //   threshold  : the kernel's break-even, or 0 when both slots
            //                hold the same implementation and there is
            //                nothing to pick between
            instance.arrayFnBig = null;
            instance.arrayFnSml = null;
            instance.threshold = 0;
            instance.arrayFnBigName = null;
            instance.arrayFnSmlName = null;
            // Set by a kernel that is running an alternative implementation
            // instead of its table — see Kernel3D.init(). Declared here so
            // every instance of a dimension keeps one hidden class.
            instance.claimed = false;
            instance._matrixShaper = null;
            // WASM module states, owned by the kernel that runs them (v1.6
            // phase 4c). Populated by kernel.create() via wasmLifecycle, nulled
            // by kernel.release(). Declared here in a fixed order so every
            // instance of a dimension keeps one hidden class.
            instance.wasmTetra3D          = null;
            instance.wasmTetra3DSimd      = null;
            instance.wasmTetra3DInt16     = null;
            instance.wasmTetra3DInt16Simd = null;
            instance.wasmTetra4D          = null;
            instance.wasmTetra4DSimd      = null;
            instance.wasmTetra4DInt16     = null;
            instance.wasmTetra4DInt16Simd = null;
            this.kernel = instance;
        }

        /**
         * Get the prebuilt LUT — which can be used in future instead of using
         * profiles (e.g. serialise to JSON, ship to a worker).
         *
         * @param {number|false} [precision]  Optional decimal places to round
         *      LUT values to before returning. Reduces JSON size considerably
         *      with negligible accuracy loss for display work. `false` or
         *      `undefined` returns the LUT unrounded.
         * @returns {object} A plain object with the LUT data + metadata.
         */
        getLut(precision){
            var CLUT
            if(precision === undefined || precision === false) {
                CLUT = this.lut.CLUT;
            } else {
                // round, which will make output smaller when saved to JSON
                var p = Math.pow(10, precision)
                CLUT = this.lut.CLUT.map(function (value) {
                    return Math.round(value * p) / p;
                })
            }

            var newLUT = this.cloneLut([]);
            newLUT.CLUT = CLUT;
            newLUT.precision = null;
            newLUT.inputScale = 1;
            newLUT.outputScale = 1;
            return newLUT;
        }

        /**
         * Get the prebuilt lut - which can be used in future instead of using profiles
         * @returns {any}
         */
        getLut16(){
            // Convert to 16bit
            var CLUT16 = new Uint16Array(this.lut.CLUT.length);
            for(var i = 0; i < this.lut.CLUT.length; i++){
                CLUT16[i] = this.lut.CLUT[i] * 65535;
            }

            var newLUT = this.cloneLut(uint16ArrayToBase64(CLUT16), 'base64' );

            // Set the precision to 16bit
            newLUT.precision = 16;
            newLUT.inputScale = 1;
            newLUT.outputScale = 1/65535;
            return newLUT;
        }

        /**
         * Get the prebuilt lut - which can be used in future instead of using profiles, This is going to be low fidelity as we are only using 8bit
         * @returns {any}
         */
        getLut8(){
            // Convert to 16bit
            var CLUT8 = new Uint8Array(this.lut.CLUT.length);
            for(var i = 0; i < this.lut.CLUT.length; i++){
                CLUT8[i] = Math.round(this.lut.CLUT[i] * 255);
            }

            var newLUT = this.cloneLut( uint8ArrayToBase64(CLUT8) , 'base64' );

            // Set the precision to 16bit
            newLUT.precision = 8;
            newLUT.inputScale = 1;
            newLUT.outputScale = 1/255; // Account for precision
            return newLUT;
        }

        /**
         * Set a prebuilt lut — used instead of profile-based LUT generation.
         *
         * Currently validates chain structure only (profile/intent links).
         * TODO: full LUT validation — CLUT dimensions, precision vs lutMode,
         * inputChannels/outputChannels consistency, intLut compatibility.
         * When added, this becomes the single validation gate so that
         * transformArrayViaLUT can trust the LUT unconditionally.
         *
         * @param {Object} lut  Prebuilt LUT object with chain, CLUT, precision, etc.
         * @throws {string} If chain structure is invalid.
         */
        setLut(lut, opts){
            this.lut = lut;

            if(!Array.isArray(lut.chain) || lut.chain.length < 3 || lut.chain.length % 2 === 0){
                throw 'Invalid LUT - chain must be [profile, intent, profile, ...] with odd length >= 3';
            }

            // Normalise chain to canonical format: [profileDescriptor, intentNumber, profileDescriptor, ...]
            // Accepts legacy {profile:...}/{intent:N} objects and converts to profile2Obj shape + raw numbers.
            var chain = [];
            for(var i = 0; i < lut.chain.length; i++){
                var slot = lut.chain[i];
                if(i % 2 === 0){
                    // Profile slot — accept profile2Obj shape (has header) or legacy wrapper (has profile)
                    if(slot && typeof slot === 'object' && slot.hasOwnProperty('header')){
                        chain.push(slot);
                    } else if(slot && typeof slot === 'object' && slot.hasOwnProperty('profile')){
                        chain.push(slot.profile);
                    } else {
                        throw 'Invalid LUT - chain[' + i + '] is not a profile descriptor';
                    }
                } else {
                    // Intent slot — accept raw number or legacy {intent: N}
                    if(typeof slot === 'number'){
                        chain.push(slot);
                    } else if(slot && typeof slot === 'object' && slot.hasOwnProperty('intent')){
                        chain.push(slot.intent);
                    } else {
                        throw 'Invalid LUT - chain[' + i + '] is not an intent';
                    }
                }
            }

            lut.chain = chain;
            this.chain = chain;

            var inputProfile = chain[0];
            var intent = chain[chain.length - 2];
            var outputProfile = chain[chain.length - 1];

            // Decode b64 (if any) and normalise CLUT to Float64Array [0..1].
            // _decodeLutCLUT is the single source of truth for the portable-LUT
            // input format — also called by Transform.jsonToLut (no Transform needed).
            // After this, the engine internals always work with Float64Array CLUT in
            // [0..1]; the kernel-specific intLut is built fresh by buildIntLut().
            _decodeLutCLUT(this.lut);

            // Plugin deserializer — reconstruct runtime-only fields (e.g. custom LUTs)
            // from the portable fields the serializer wrote.
            // Runs after CLUT decode so the deserializer sees a clean Float64Array.
            var _pluginDeser = Transform._plugins[this.lutMode];
            if(_pluginDeser && _pluginDeser.deserializer){
                this.lut = _pluginDeser.deserializer(this.lut);
            }

            // Optional signature verification — opt-in via { verify: true } since
            // recomputing the hash costs a u16-bytes pass. Throws on mismatch so
            // the caller can react before any pixel is transformed.
            if(opts && opts.verify === true && this.lut.originalSignature){
                var computed = _computeSignature(this.lut);
                if(computed !== this.lut.originalSignature){
                    throw 'Transform.setLut: signature mismatch — LUT has been mutated since it was stamped. ' +
                          'Expected ' + this.lut.originalSignature + ', got ' + computed + '. ' +
                          'See `lut.meta.adjustments` for the edit history (if recorded).';
                }
            }

            // The LUT is now the authority. Re-resolve cached state that the
            // constructor set based on the (then-empty) buildLut flag, so that:
            //   1. builtLut reflects reality (we now have a LUT)
            //   2. 'auto' lutMode picks the int8/int16 kernel matching dataFormat
            //      (without this, lutMode stays 'float' and the LUT dispatch
            //       allocates Uint8ClampedArray output even in int16 mode)
            // Downstream caches (_expectsU16, _isIntegerMode) are reset by
            // this.create() below based on the new lutMode.
            this.builtLut = true;
            if(this.lutModeRequested === 'auto'){
                if(this.dataFormat === 'int8'){
                    this.lutMode = 'int-wasm-simd';
                } else if(this.dataFormat === 'int16'){
                    this.lutMode = 'int16-wasm-simd';
                } else {
                    this.lutMode = 'float';
                }
            }

            this.create(inputProfile, outputProfile, intent);
        }

        /**
         * Serialise this Transform's LUT to a portable JSON-compatible object.
         *
         * The result is the JSON handshake format — directly consumable by
         * `Transform.fromJSON()`, `Transform.setLut()`, or `LutBuilder.fromJSON()`.
         * Defaults to u16 base64 (lossless for the canonical f64 ↔ u16 boundary).
         *
         *     const json = transform.toJSON();
         *     fs.writeFileSync('lut.json', JSON.stringify(json));
         *     // ...later, on a server with no ICC profiles:
         *     const t = Transform.fromJSON(fs.readFileSync('lut.json'));
         *
         * Because this method is named `toJSON`, `JSON.stringify(transform)` will
         * call it automatically (JS protocol).
         *
         * @param {object} [opts]
         * @param {'u16'|'u8'} [opts.dataType='u16'] u8 halves CLUT size, lossy.
         * @param {string}     [opts.generator]      override the generator field.
         * @returns {object} JSON-compatible plain object.
         */
        toJSON(opts){
            if(!this.lut || !this.lut.CLUT){
                // The caller may have passed buildLut:true and still be here,
                // because wasmMatrixShaper:'prefer' skipped the CLUT. Telling
                // them to pass buildLut:true would be advice they already took.
                if(this._buildLutRequested && this.preferMatrixShaperOverLUT){
                    throw 'Transform.toJSON: no LUT to serialise — `wasmMatrixShaper: "prefer"` ' +
                          'took this transform, so no CLUT was built even though `buildLut: true` ' +
                          'was requested. The matrix-shaper kernel is not a LUT and has nothing to ' +
                          'export. Drop to `wasmMatrixShaper: "auto"` (the default) if you need the ' +
                          'CLUT for toJSON(); the kernel still runs wherever there is no LUT to displace.';
                }
                throw 'Transform.toJSON: no LUT to serialise. ' +
                      'Construct the Transform with `buildLut: true` so a LUT is built during create(), ' +
                      'or call setLut() to install one. ' +
                      'Auto-building on demand is intentionally not supported — it would silently swap ' +
                      'the f64 pipeline (lossless) for a grid-sampled LUT path (~0.06 ΔE76 grid error).';
            }
            var json = _lutToJSONShape(this.lut, opts);
            var _pluginEntry = Transform._plugins[this.lutMode];
            if(_pluginEntry && _pluginEntry.serializer){
                json = _pluginEntry.serializer(json, this.lut);
            }
            return json;
        }

        /**
         * Verify that this Transform's LUT data matches its stamped
         * `originalSignature`. Returns:
         *   true   — signature matches (LUT unmutated since extraction)
         *   false  — signature differs (LUT has been edited or corrupted)
         *   null   — no signature stamped (nothing to verify)
         *
         * @returns {boolean|null}
         */
        verifyLut(){
            if(!this.lut) return null;
            return Transform.verifyLut(this.lut);
        }

        /**
         * Return metadata for the active plugin (the one whose lutMode matches
         * this Transform's lutMode).
         *
         * If opts.meta was a plain object it is returned as-is.
         * If opts.meta was a function it is called with this Transform as `this`,
         * so it can read dynamic state (e.g. this.totalInk, this.lutMode).
         * Returns null when no plugin is active or when no meta was registered.
         *
         * @returns {object|string|null}
         */
        registeredMeta(){
            var plugin = Transform._plugins[this.lutMode];
            if(!plugin || !plugin.meta) return null;
            return (typeof plugin.meta === 'function')
                ? plugin.meta.call(this)
                : plugin.meta;
        }

        /**
         * Compute and return the current LUT signature (`"FNV1A:<hex>"`).
         * Useful for diagnostics — compare to `lut.originalSignature` to see if
         * the data has changed since stamping.
         *
         * @returns {string|null} signature, or null if no LUT
         */
        signLut(){
            if(!this.lut) return null;
            return _computeSignature(this.lut);
        }

        /**
         * Add a hook that runs on each grid-cell's **input** during LUT build.
         *
         * The function receives a plain `[c0, c1, …]` array in device space
         * [0–1] and must return an array of the same length (may be the same
         * object, mutated in place).
         *
         * @param {Function} fn  `(deviceIn) => deviceIn`
         * @param {'before'|'after'} [where='after']
         *   `'after'`  — append (runs after previously added hooks).
         *   `'before'` — prepend (runs before previously added hooks).
         * @returns {Transform} this (for chaining)
         */
        addLutInputHook(fn, where) {
            if (typeof fn !== 'function') throw 'addLutInputHook: fn must be a function';
            if (where === 'before') {
                this._lutInputHooks.unshift(fn);
            } else {
                this._lutInputHooks.push(fn);
            }
            return this;
        }

        /**
         * Add a hook that runs on each grid-cell's **output** during LUT build.
         *
         * The function receives a plain `[c0, c1, …]` array in device space
         * [0–1] and must return an array of the same length. A second
         * read-only argument carries the original grid-cell input — useful
         * for logging/debugging but must not be mutated.
         *
         * @param {Function} fn  `(deviceOut, deviceIn) => deviceOut`
         * @param {'before'|'after'} [where='after']
         *   `'after'`  — append (runs after previously added hooks).
         *   `'before'` — prepend (runs before previously added hooks).
         * @returns {Transform} this (for chaining)
         */
        addLutOutputHook(fn, where) {
            if (typeof fn !== 'function') throw 'addLutOutputHook: fn must be a function';
            if (where === 'before') {
                this._lutOutputHooks.unshift(fn);
            } else {
                this._lutOutputHooks.push(fn);
            }
            return this;
        }

        /**
         * Remove all LUT build hooks.
         * @returns {Transform} this
         */
        clearLutHooks() {
            this._lutInputHooks.length  = 0;
            this._lutOutputHooks.length = 0;
            return this;
        }

        /**
         * Apply a behaviour to this Transform instance.
         *
         * Behaviours are per-instance modifiers — hooks, flags, per-instance state —
         * applied after construction and before create().  Two forms:
         *
         *   t.use(descriptor)          — descriptor.apply(transform, opts) called directly
         *   t.use('name', opts?)       — looks up a registered behaviour by name
         *
         * @param {object|string} behaviourOrName  Behaviour descriptor or registered name
         * @param {object}        [opts]           Passed as second arg to apply()
         * @returns {Transform} this (fluent)
         */
        use(behaviourOrName, opts){
            // Merge _originalOptions (constructor opts) with any explicit opts passed
            // here — explicit opts win. This way apply() sees totalInk etc. without
            // the caller having to repeat them at use() time.
            var mergedOpts = Object.assign({}, this._originalOptions, opts);
            var b, name;
            if(typeof behaviourOrName === 'string'){
                name = behaviourOrName;
                b    = Transform._behaviours[name];
                if(!b) throw new Error('Transform.use: no behaviour registered as "' + name + '"');
            } else if(behaviourOrName && typeof behaviourOrName.apply === 'function'){
                b    = behaviourOrName;
                name = b.name || null;
            } else {
                throw new Error('Transform.use: argument must be a behaviour descriptor or a registered name');
            }
            if(name && !this.plugin[name]) this.plugin[name] = Object.create(null);
            // initialise — optional setup phase: store state, validate opts
            if(b.initialise) b.initialise(this, mergedOpts);
            // apply — effects: add hooks, configure instance
            b.apply(this, mergedOpts);
            return this;
        }

        /**
         * Apply a chain of hook functions to a colour sample.
         * @param {Function[]} hooks
         * @param {number[]} values  - mutable current sample
         * @param {number[]} [context] - read-only second arg (e.g. original input for output hooks)
         * @private
         */
        _applyLutHooks(hooks, values, context) {
            for (var i = 0; i < hooks.length; i++) {
                values = hooks[i](values, context);
            }
            return values;
        }

        cloneLut(CLUT, encoding){
            // Copy LUT without CLUT
            return JSON.parse(JSON.stringify(this.lut, function(key, value) {
                if(key === 'CLUT') {
                    return CLUT;
                }
                if(key === 'encoding' && encoding !== undefined){
                    return encoding;
                }
                return value;
            }));
        }

        /**
         * Build a transform from a single source profile to a single destination
         * profile. Sugar for `createMultiStage([input, intent, output], customStages)`.
         *
         *      var t = new Transform();
         *      t.create('*sRGB', cmykProfile, eIntent.perceptual);
         *      t.create(labProfile, '*sRGB', eIntent.relative);
         *
         * Profiles may be either:
         *   - a loaded {@link Profile} instance, or
         *   - a virtual-profile name string starting with '*'
         *     ('*sRGB', '*AdobeRGB', '*AppleRGB', '*ColorMatchRGB',
         *      '*ProPhotoRGB', '*Lab', '*LabD50', '*LabD65').
         *
         * Strings without a leading '*' are rejected — load the profile yourself
         * with new Profile(url) / loadPromise() first.
         *
         * After this call returns, the Transform is ready: call transform() for
         * single colours, or transformArray() / transformArrayViaLUT() for arrays.
         *
         * @param {string|Profile} inputProfile   Source profile or '*virtualName'
         * @param {string|Profile} outputProfile  Destination profile or '*virtualName'
         * @param {number}         intent         One of eIntent.perceptual / .relative
         *                                        / .saturation / .absolute
         * @param {object[]}      [customStages]  Custom stages to inject into the
         *                                        pipeline (see class JSDoc
         *                                        "CUSTOM STAGES" section).
         * @returns {void}
         * @throws {string} If a profile is unloaded, the wrong type, or the intent
         *                  is invalid.
         */

        create(inputProfile, outputProfile, intent, customStages) {
            return this.createMultiStage([inputProfile, intent, outputProfile] ,customStages)
        }


        /**
         * Build a transform from a chain of two-or-more profiles. Use this for
         * proofing transforms (RGB → CMYK → RGB), abstract-profile chains, or any
         * conversion where you want to round-trip through one or more intermediate
         * spaces.
         *
         * The chain is laid out as [profile, intent, profile, intent, profile, ...]
         * with profiles at even indices and intents at odd indices.
         *
         *  EXAMPLES
         *
         *   1. Soft-proof RGB through a CMYK printer profile back to RGB:
         *
         *          t.createMultiStage([
         *              '*sRGB',     eIntent.perceptual,
         *              cmykProfile, eIntent.relative,
         *              '*sRGB'
         *          ]);
         *
         *   2. "What Lab value would this Lab value land at after a print/scan
         *      cycle, for a ΔE calculation?"
         *
         *          t.createMultiStage([
         *              '*Lab',      eIntent.relative,
         *              '*sRGB',     eIntent.perceptual,
         *              cmykProfile, eIntent.absolute,
         *              '*Lab'
         *          ]);
         *
         *  MULTI-STAGE OPTIONS
         *
         *  - `BPC: [true, false, true]` — array form of the BPC option lets you
         *    enable Black Point Compensation per chain segment (indexes 0,1,2…
         *    correspond to the intent slots in the chain).
         *
         *  - `customStages` are inserted at named pipeline locations on EVERY
         *    boundary by default. To target a specific stage index, append (n)
         *    to `location`, e.g. 'PCS(1)'. See class JSDoc.
         *
         *  - With `buildLut: true`, the entire chain is collapsed into a single
         *    CLUT — even multi-step proofing chains become one interpolation per
         *    pixel at runtime.
         *
         * @param {Array<Profile|string|number>} profileChain  Alternating
         *      profiles and intents, length 3, 5, 7, ... (always odd). Profiles
         *      may be Profile instances or '*virtualName' strings.
         * @param {object[]}                    [customStages] See class JSDoc.
         * @returns {void}
         * @throws {string} If chain length is invalid, profiles are unloaded or
         *                  the wrong type, or any intent is not in eIntent.
         */
        createMultiStage(profileChain, customStages) {
            customStages = customStages || [];

            // DO NOT RE-CREATE WITH A STALE LUT ATTACHED. Re-creating over an
            // existing pipeline left the OLD LUT in place: outputChannels
            // updated to the new space but `lut.outputChannels` did not, so
            // transformArray kept emitting the previous space's channel count
            // and transform() returned values interpolated through the wrong
            // table — silently, with no error.
            //
            // Rebuilding IS supported, but it has to be asked for: clear()
            // drops the LUT, the pipeline, compiled WASM state and this
            // object's worker-pool registration in one place. Reaching in and
            // setting `lut = false` happened to work — verified byte-identical
            // on int, int-wasm-scalar and int-wasm-simd — but it is not a
            // contract worth having, because it only covers the field the
            // caller happens to know about.
            //
            // Throwing beats silently rebuilding: every documented path
            // already builds one Transform per conversion, so nothing loses a
            // capability, and the guard costs one boolean.
            if(this.pipelineCreated){
                throw 'This Transform already has a pipeline. Build a new ' +
                      'Transform for a new conversion — re-creating would ' +
                      'reuse the existing LUT and silently produce the old ' +
                      'colour space. To deliberately rebuild this one, call ' +
                      'transform.clear() first.';
            }

            // REBUILDING MAKES THIS A DIFFERENT TRANSFORM, so anything cached
            // about the old one has to go. Every route in funnels through
            // here — create() delegates to it and setLut() ends by calling
            // create() — so this is the one place that needs to say it.
            //
            // The worker key matters most. It is ASSIGNED rather than derived
            // from content, so unlike a hash it does not change on its own
            // when the profiles do: a Transform re-created over different
            // profiles would otherwise keep its old key and be handed the old
            // pipeline out of the workers' registry. Drop the key, and tell
            // the workers to drop what it pointed at — fire and forget,
            // because this is a synchronous method and the only cost of a
            // missed forget is memory, not correctness.
            //
            // _multicoreSafe is the probe result for the OLD lut, and was
            // never reset before; same staleness, smaller blast radius.
            if(this._workerKey){
                var staleKey = this._workerKey;
                this._workerKey = null;
                try { _pool.forgetEverywhere(staleKey); } catch(e){ /* no pool, nothing held */ }
            }
            this._multicoreSafe = undefined;
            this._kernelClaim = null;               // re-decided from THIS pipeline

            if(!Array.isArray(profileChain)){
                throw 'Invalid profileChain, must be an array';
            }


            var step, i;
            var chainEnd = profileChain.length - 1;

            // Create Virtual profiles
            // This makes it easier to just create a transform from a profile name
            // and not have to worry about loading the profile
            var profileIndex = 1
            var intentIndex = 1
            for( i = 0; i < profileChain.length; i++) {
                if(i % 2 === 0){
                    // Profiles are only even numbers 0,2,4,6 etc
                    step = profileChain[i];
                    if (typeof step === 'string') {
                        if (step.substring(0, 1) === '*') {
                            // automatically create virtual profile
                            profileChain[i] = new Profile(step);
                        } else {
                            throw 'Profile ' + profileIndex + ' is a string. Virtual profiles must be prefixed with "*"';
                        }
                    }
                    profileIndex++;
                }
            }

            this.inputProfile = null;
            this.outputProfile = null;
            this.usesBPC = false;
            this.usesAdaptation = false;

            // DeviceLink — a 'link'-class profile is a complete device→device
            // transform (single A2B tag, no PCS). It is used alone:
            // t.create(deviceLink) — the create() sugar pads the chain with
            // undefined intent/output slots, so strip those and run the
            // single-profile chain. Linking a DeviceLink to further profiles
            // is impossible (there is no PCS to link through).
            var isDeviceLink = profileChain.length > 0
                && profileChain[0] instanceof Profile
                && profileChain[0].loaded
                && profileChain[0].header.pClass === 'link';
            if(isDeviceLink){
                for(i = 1; i < profileChain.length; i++){
                    if(profileChain[i] !== undefined && profileChain[i] !== null){
                        throw 'DeviceLink profiles are a complete device-to-device transform — pass the DeviceLink profile alone to create()';
                    }
                }
                profileChain.length = 1;
                chainEnd = 0;
            }

            if(this.lut === false){
                // validate input and output profiles
                if(!Array.isArray(profileChain)){
                    throw 'Invalid profileChain, must be an array';
                }

                if(!isDeviceLink && profileChain.length < 3){
                    throw 'Invalid profileChain, must have at least 3 items [profile, intent, profile]';
                }

                profileIndex = 1;
                intentIndex = 1;
                for(i = 0; i < profileChain.length; i++){
                    step = profileChain[i];

                    if(i % 2 === 0){
                        // profile

                        if(!(step instanceof Profile)){
                            throw 'Profile ' + profileIndex + ' in chain is not a Profile';
                        }

                        if(!step.loaded){
                            throw 'Profile ' + profileIndex + ' in chain is not loaded';
                        }

                        profileIndex++;
                    } else {
                        // intent
                        if(typeof step !== 'number'){
                            throw 'Intent ' + intentIndex + ' in chain is not a number';
                        }

                        if(!(step === eIntent.absolute ||
                             step === eIntent.perceptual ||
                             step === eIntent.relative ||
                             step === eIntent.saturation
                        )){
                            throw 'Intent ' + intentIndex + ' in chain is not a valid intent';
                        }
                        intentIndex++;
                    }
                }

                if(!(profileChain[0] instanceof Profile)){
                    throw 'First step in chain is not a Profile';
                }

                if(!(profileChain[chainEnd] instanceof Profile)){
                    throw 'Last step in chain is not a Profile';
                }

            } else {
                if( !this.lut || this.lut.CLUT === undefined || this.lut.CLUT === null){
                    throw 'Invalid LUT';
                }
            }


            //
            // Save the profile chain, so we can see how this pipeline was created
            //
            this.chain = profileChain;

            // Note that even though we might have 3 or 4 profiles, we want to
            // save the initial input and output profiles for quick access as these contain
            // info about the input and output colour spaces, the other profiles are just used for conversion
            this.inputProfile = profileChain[0];
            this.outputProfile = profileChain[chainEnd];

            if(isDeviceLink){
                // Input side = header space field (decoded to
                // deviceLinkInputChannels); output side = header PCS field
                // (decoded to outputChannels). See Profile.decodeFile.
                this.inputChannels  = this.inputProfile.deviceLinkInputChannels;
                this.outputChannels = this.inputProfile.outputChannels;
            } else {
                this.inputChannels  = this.getProfileChannels(this.inputProfile);
                this.outputChannels = this.getProfileChannels(this.outputProfile);
            }

            this.customStages = customStages;

            // Identity detection — collapse adjacent equal-profile pairs out of
            // the chain before the pipeline is built. If the whole chain reduces
            // to nothing, route to a copy path and skip the LUT entirely.
            // Never for DeviceLink — its 1-profile chain IS the transform.
            this.isIdentity = false;
            if(this.detectIdentity && this.lut === false && !isDeviceLink){
                this._collapseIdentityChain(profileChain);
                if(profileChain.length <= 1){
                    this.isIdentity = true;
                }
                // Refresh chainEnd and in/out profile refs after collapse.
                // SHOULD be the same endpoints as before logically
                // but update just to be safe
                var collapsedChainEnd = profileChain.length - 1;
                this.inputProfile   = profileChain[0]                   || this.inputProfile;
                this.outputProfile  = profileChain[collapsedChainEnd]   || this.outputProfile;
                this.inputChannels  = this.getProfileChannels(this.inputProfile);
                this.outputChannels = this.getProfileChannels(this.outputProfile);
                this.chain          = profileChain; // update
            }

            // INPUT DIMENSION IS NOT INPUT CHANNEL COUNT. An identity RGB→RGB
            // conversion still has three input channels; it just needs no
            // interpolation, so it needs no 3-D kernel. Separating the two is
            // what lets identity be a registry entry instead of a branch.
            this.inputDimension = this.isIdentity ? 0 : this.inputChannels;
            this.setKernel(this.inputDimension);

            // Identity — the kernel at index 0 builds the copy pipeline and
            // there is no LUT to build, so the rest of create() has nothing to
            // do. pipelineCreated is derived rather than asserted: _initKernel
            // deliberately swallows a throwing init() so one bad kernel cannot
            // break create(), and for a kernel whose init BUILDS the pipeline
            // that would otherwise leave a silently empty one behind.
            if(this.isIdentity){
                this._initKernel();
                this.pipelineCreated = this.pipeline.length > 0;
                return;
            }


            // The Kernel can take over and build a LUT
            // Built lut or if lut pre-supplied use it
            var _skipLutForMatrixShaper = false;
            if(this.builtLut || this.lut !== false){
                //
                // Prebuilt luts are faster as they only need 1-2 stages, but they are less accurate
                // and take time to compute, but for images they are a much better option
                // where speed is more important than accuracy, especially in 8bit
                //

                if(this.lut === false){
                    // create temporary pipeline for building LUT, we do not convert input or output as we
                    // want the lut to be device encoding 0.0-1.0 end to end, This makes is easier to
                    // use the lut in future with any input or output data
                    // Note profileChain may be shortened via identity reduction
                    this.createPipeline(profileChain,false, false, false);

                    if(this.verbose){
                        if(this.optimise){
                            console.log(this.optimiseInfo());
                        } else {
                            console.log(this.getStageNames(false,false));
                        }
                        console.log('Temp Pipeline Created, Building LUT ....')
                    }

                    this.pipelineCreated = true;

                    if(this.validateOnCreate){
                        if(!this.validatePipeline('device')){
                            throw new Error(
                                'jsColorEngine: pipeline validation failed (validateOnCreate). ' +
                                'A mid-grey test colour produced NaN, undefined, or wrong output type. ' +
                                'Check profile integrity or disable with validateOnCreate:false.'
                            );
                        }
                    }

                    // preferMatrixShaperOverLUT: an RGB->RGB matrix-shaper
                    // conversion is a curve, a 3x3 and another curve, and the
                    // WASM kernel runs it at 331 MPx/s against 123 for a
                    // CLUT while staying within 1 LSB of the exact pipeline
                    // rather than carrying interpolation error. Opt-in,
                    // because a LUT is also an object callers export, clone
                    // and inspect.
                    //
                    // Decided HERE, against the temporary pipeline just built,
                    // rather than predicted from profile types — an identity
                    // pair collapses to three stages, and a LUT-based RGB
                    // profile produces interpolation stages, neither of which
                    // is visible before the pipeline exists.
                    // ONE HOOK, ASKED ONCE. Until v1.6 there were two:
                    // provideLut(lutMode), asked earlier on the instance, and
                    // displacesLut(transform), asked here on the DESCRIPTOR.
                    // They answered the same question with overlapping
                    // vocabularies -- displacesLut could only say "no LUT" or
                    // "carry on", which is a strict subset of what provideLut
                    // already said -- and displacesLut existed only because
                    // the matrix shaper needed to answer LATER, once the
                    // temporary pipeline it inspects exists.
                    //
                    // So provideLut moved here rather than displacesLut being
                    // kept. That is strictly more information for every
                    // kernel, and it fixes a latent bug: displacesLut was
                    // asked of Transform.kernels[inputChannels], the shared
                    // DESCRIPTOR, so any kernel that cached during it would
                    // have written into the object every Transform of that
                    // dimension shares. The same mistake init() was fixed for.
                    //
                    //   null    carry on and build the LUT as normal
                    //   false   build no LUT -- this kernel runs the pipeline
                    //   {lut}   use this one, however the kernel made it
                    //
                    // A kernel is free to build its own with createNDDeviceLUT
                    // and hand it back: a house look, an f32-celled table, a
                    // small 8-bit preview grid. Transform stores what it gets
                    // and asks nothing about it.
                    if(typeof this.kernel.provideLut === 'function'){
                        var _provided = this.kernel.provideLut(this.lutMode);
                        if(_provided === false){
                            _skipLutForMatrixShaper = true;
                            this.builtLut = false;
                            this.lut = false;
                            if(this.verbose){
                                console.log('Kernel "' + this.kernel.name + '" declined the CLUT; none built');
                            }
                        } else if(_provided !== null && _provided !== undefined){
                            _skipLutForMatrixShaper = true;
                            this.builtLut = true;
                            this.lut = _provided;
                            if(this.verbose){
                                console.log('Kernel "' + this.kernel.name + '" provided a custom LUT');
                            }
                        }
                    }

                    var _pluginEntry = Transform._plugins[this.lutMode];

                    // create the prebuilt Lut.  opts.builder replaces createLut() when
                    // provided; null/absent means use the standard CLUT builder
                    // (with any hooks that initialise installed).
                    if(!_skipLutForMatrixShaper){
                        this.lut = (_pluginEntry && _pluginEntry.builder)
                            ? _pluginEntry.builder(this)
                            : this.createLut();
                    }
                    // Signature is NOT stamped here — for speed. The hot path
                    // (create + transformArray) shouldn't pay the hash cost.
                    // toJSON() lazy-computes a signature on demand, and explicit
                    // extraction paths (LutBuilder.fromTransform / createFromLCMS)
                    // stamp at extraction time when audit semantics are wanted.
                }

                if(_skipLutForMatrixShaper){
                    // The ordinary stage pipeline — which is what the kernel
                    // reads its matrix and curves from.
                    this.createPipeline(profileChain, this.convertInputOutput, this.convertInputOutput, false);
                    this.lut = false;
                } else {
                // rebuild pipeline to use LUT and the LUTinterpolation method, seriously just stay with tetrahedral
                var defaultInterpolation3D = this.interpolation3D
                var defaultInterpolation4D = this.interpolation4D
                this.interpolation3D = this.LUTinterpolation3D;
                this.interpolation4D = this.LUTinterpolation4D;

                this.createPipeline(profileChain,  this.convertInputOutput, this.convertInputOutput, true);

                // restore interpolation
                this.interpolation3D = defaultInterpolation3D;
                this.interpolation4D = defaultInterpolation4D;
                }

            } else {
                // standard pipeline without a prebuilt lut
                this.createPipeline(profileChain, this.convertInputOutput, this.convertInputOutput, false);
                this.lut = false;
            }

            this.pipelineCreated = true;

            if(this.validateOnCreate && !this.builtLut){
                if(!this.validatePipeline()){
                    throw new Error(
                        'jsColorEngine: pipeline validation failed (validateOnCreate). ' +
                        'A mid-grey test colour produced NaN, undefined, or wrong output type. ' +
                        'Check profile integrity or disable with validateOnCreate:false.'
                    );
                }
            }

            // INTEGER HOT PATH (lutMode is any of 'int', 'int16',
            // 'int-wasm-scalar', 'int-wasm-simd'): build the u16 mirror LUT
            // once, after the optimiser has folded the device->int stage
            // and `lut.outputScale` has been bumped from 1 to 255 (or 65535
            // for int16). Build is silent — if the LUT shape isn't supported
            // (1D, 2D, or non-{3,4} output channels), intLut stays undefined
            // and the dispatcher falls back to the float kernel automatically.
            //
            // The WASM paths and 'int16' use the same mirror LUT shape as
            // the 'int' path (same u16 CLUT in [0, 65280], same gps stride
            // metadata) — only the gridPointsScale_fixed_u16 sibling field
            // is used by the int16 kernels for the u16 input scale.
            if((this.lutMode === 'int'
                    || this.lutMode === 'int16'
                    || this.lutMode === 'int-wasm-scalar'
                    || this.lutMode === 'int-wasm-simd'
                    || this.lutMode === 'int16-wasm-scalar'
                    || this.lutMode === 'int16-wasm-simd')
                && this.lut && (this.dataFormat === 'int8' || this.dataFormat === 'int16')){
                this.buildIntLut(this.lut);
            }

            // Gamut check transforms are only needed during LUT build.
            // Release them now to free the extra profiles and pipelines.
            if(this.lutGamutMode !== 'none'){
                this.gamutTransforms = {};
                this.gamutColorDevice = [];
            }

            // WASM KERNEL INIT — moved verbatim into
            // src/kernels/wasmLifecycle.js (v1.7 phase B) and reached via the
            // kernel module's create(lutMode). Tries to compile/instantiate
            // the tetrahedral WASM kernels once, at create() time, demoting
            // lutMode on any failure (simd → scalar → JS) so the best
            // available kernel runs. The dispatcher then sees the settled
            // lutMode — zero per-call overhead from the demotion.
            if(this.kernel){
                this.lutMode = this.kernel.create(this.lutMode);
            }

            // CLAIM PASS. The dimensional kernel above was chosen from the
            // channel count before the pipeline existed; a claiming kernel is
            // offered the transform now that its SHAPE is known, and may take
            // over the batch path. See registerKernel().
            this._initKernel();

            this._propagateWasmMemorySettings();

            // v1.3 — resolve LUT dispatcher table refs ONCE per create().
            // Walks the fallback chain in src/lutKernelTable.js for the
            // current (lutMode, inputChannels, outputChannels) triple,
            // caching one ref for big batches (WASM-eligible) and one for
            // small batches (below memcpy break-even). Per-array dispatch
            // is then a single threshold compare + indirect call. Safe
            // no-op when this.lut is false (no LUT path) or inputChannels
            // is gray/duotone (handled by separate kernels, not the table).
            // Cache lutMode classification booleans so the per-call hot path
            // in transformArrayViaLUT avoids repeated string comparisons.
            // Must run AFTER lutMode demotions above have settled.
            var lm = this.lutMode;
            this._expectsU16    = (lm === 'int16' || lm === 'int16-wasm-scalar' || lm === 'int16-wasm-simd');
            this._isIntegerMode = (lm === 'int' || lm === 'int16'
                || lm === 'int-wasm-scalar'  || lm === 'int-wasm-simd'
                || lm === 'int16-wasm-scalar' || lm === 'int16-wasm-simd');

            // Validate intLut compatibility once at create() time. The only way
            // an incompatible intLut can exist is if someone attached a foreign
            // one from a different engine version — buildIntLut() always produces
            // a compatible result. Throwing here (loud, immediate, grep-able)
            // removes the need for a per-call guard in transformArrayViaLUT.
            if(this._isIntegerMode && this.lut && this.lut.intLut
                && !this.isIntLutCompatible(this.lut.intLut)){
                throw new Error(
                    'jsColorEngine: intLut format tag incompatible with this version. ' +
                    'Got {version:' + this.lut.intLut.version +
                    ', dataType:' + JSON.stringify(this.lut.intLut.dataType) +
                    ', scale:' + this.lut.intLut.scale +
                    ', gpsPrecisionBits:' + this.lut.intLut.gpsPrecisionBits +
                    ', accWidth:' + this.lut.intLut.accWidth + '}. ' +
                    'Rebuild the Transform via create() or set lutMode:"float".'
                );
            }

            if(this.verbose){
                if(this.optimise){
                    console.log(this.optimiseInfo());
                } else {
                    console.log(this.getStageNames(false,false));
                }
            }
        };

        /**
         * Propagate memory-management settings to all live WASM states.
         */
        _propagateWasmMemorySettings() {
            var states = [
                this.wasmTetra3D, this.wasmTetra3DSimd,
                this.wasmTetra3DInt16, this.wasmTetra3DInt16Simd,
                this.wasmTetra4D, this.wasmTetra4DSimd,
                this.wasmTetra4DInt16, this.wasmTetra4DInt16Simd
            ];
            var ratio = this._wasmShrinkRatio;
            var max   = this._wasmMaxMemory;
            for (var i = 0; i < states.length; i++) {
                if (states[i]) {
                    states[i].shrinkRatio = ratio;
                    states[i].maxMemory   = max;
                }
            }
        }

        /**
         * @param {number} ratio  When > 0, bind() will automatically re-
         *   instantiate the WASM module whenever existing linear memory is
         *   more than `ratio ×` the size actually needed. For example:
         *
         *     transform.setWasmShrinkRatio(4);
         *
         *   means "if the buffer is more than 4× larger than what the image
         *   just processed needed, compact it". Checked post-run — memory
         *   is reclaimed before transformArrayViaLUT returns. This keeps
         *   memory proportional to the current workload without penalising
         *   fixed-size workflows (the video demo runs same-size frames so
         *   the ratio is never hit).
         *
         *   Set to 0 to disable (default).
         *
         * Cost of a triggered compact: ~0.1 ms (re-instantiation from a
         * cached Module) + one LUT re-copy on next call. Negligible
         * compared to the savings of releasing tens of MB of WASM memory.
         */
        setWasmShrinkRatio(ratio) {
            this._wasmShrinkRatio = ratio || 0;
            this._propagateWasmMemorySettings();
        }

        /**
         * @param {number} bytes  Absolute WASM memory ceiling in bytes.
         *   Checked immediately after each transform — if any state's
         *   memory exceeds this, compact fires before the method returns.
         *   The image still processes normally; cleanup is post-run.
         *
         *   Default: 128 MB (134217728). Set to 0 to disable.
         *
         *   Complements wasmShrinkRatio: shrinkRatio keeps memory
         *   proportional to the workload, maxMemory is a hard ceiling
         *   that protects against runaway growth. Developers can raise
         *   the ceiling to match their workload.
         */
        setWasmMaxMemory(bytes) {
            this._wasmMaxMemory = bytes || 0;
            this._propagateWasmMemorySettings();
        }

        /**
         * Compact all live WASM states NOW — each state re-instantiates
         * its Module, starting with a fresh 1-page (64 KB) linear memory.
         * The old Instance and its (potentially large) memory become
         * eligible for GC.
         *
         * Typical use: after processing a batch that included an unusually
         * large image, call this to release the inflated buffers before
         * switching to a smaller-image workflow.
         *
         * The Transform remains fully functional — next transformArrayViaLUT
         * call will grow the fresh memory to exactly the size needed and
         * re-copy the LUT (~0.1 ms overhead).
         */
        _postRunWasmCheck() {
            // Public surface over what the kernel now does for itself at the
            // end of array(). Kept because it is documented API; the eight
            // slots it used to list are forwarding accessors that bounce
            // straight back to the kernel holding them.
            wasmLifecycle.compactIfNeeded(this, this._wasmMaxMemory, this._wasmShrinkRatio);
        }

        compactWasmMemory() {
            var states = [
                this.wasmTetra3D, this.wasmTetra3DSimd,
                this.wasmTetra3DInt16, this.wasmTetra3DInt16Simd,
                this.wasmTetra4D, this.wasmTetra4DSimd,
                this.wasmTetra4DInt16, this.wasmTetra4DInt16Simd
            ];
            for (var i = 0; i < states.length; i++) {
                if (states[i]) states[i].compact();
            }
        }

        /**
         * Destroy all WASM states, releasing their linear memory to GC.
         * The Transform falls back to pure-JS integer kernels until
         * create() is called again to reload WASM modules.
         *
         * Use when a Transform is being shelved or when you need
         * absolute certainty that WASM memory is freed.
         */
        /**
         * The options this Transform is actually running with.
         *
         * Not the object you passed in — the *resolved* values, so
         * `lutMode: 'auto'` comes back as whatever it resolved to
         * (`'int-wasm-simd'`, say), and anything you omitted comes back as the
         * default that was applied. That makes it useful for three things:
         * reporting what really happened, reconstructing an equivalent
         * Transform, and deciding whether a Transform can cross a worker
         * boundary.
         *
         * `functions` lists any option holding a function —
         * `gamutDeFn`, `lutInputHook`, `lutOutputHook` — which cannot be
         * structured-cloned (`postMessage` throws `DataCloneError`).
         *
         * All three are LUT-BUILD-TIME only: the hooks run inside
         * `buildIntLut()`'s grid walk, and `gamutDeFn` is reached through
         * `gamutCheck()` in the same loop. So once a LUT exists they have
         * already done their work and are irrelevant to conversion — which is
         * why shipping a baked LUT to a worker carries them for free, and why
         * they only matter if something would REBUILD the LUT elsewhere.
         *
         *     const o = t.getOptions();
         *     o.lutMode          // 'int-wasm-simd', not 'auto'
         *     o.functions        // ['lutInputHook'] — cannot be cloned
         *
         * @returns {Object} resolved options, plus `functions: string[]`
         */
        getOptions(){
            var out = {
                dataFormat:                 this.dataFormat,
                buildLut:                   this.builtLut === true,
                lutMode:                    this.lutMode,
                lutModeRequested:           this.lutModeRequested,
                lutGridPoints:              this.lutGridPoints,
                BPC:                        this.BPC,
                interpolation:              this.interpolation,
                interpolationFast:          this.interpolationFast,
                labAdaptation:              this.labAdaptation,
                labInputAdaptation:         this.labInputAdaptation,
                displayChromaticAdaptation: this.displayChromaticAdaptation,
                lutGamutMode:               this.lutGamutMode,
                lutGamutLimit:              this.lutGamutLimit,
                lutGamutMapScale:           this.lutGamutMapScale,
                lutGamutColor:              this.lutGamutColor,
                pixelCache:                 this.pixelCacheSlots !== undefined
                                                ? this.pixelCacheSlots : 0,
                roundOutput:                this.roundOutput,
                precision:                  this.precision,
                optimise:                   this.optimise,
                detectIdentity:             this.detectIdentity,
                clipRGBinPipeline:          this.clipRGBinPipeline,
                useCurveLut:                this.useCurveLut,
                pipelineDebug:              this.pipelineDebug,
                wasmMatrixShaper:           this.wasmMatrixShaper,
                validateOnCreate:           this.validateOnCreate,
                wasmShrinkRatio:            this._wasmShrinkRatio,
                wasmMaxMemory:              this._wasmMaxMemory
            };

            // Anything a structured clone would reject, named rather than
            // silently dropped.
            var fns = [];
            if(typeof this.gamutDeFn === 'function' && this.gamutDeFn !== convert.deltaE1976){
                fns.push('gamutDeFn');
            }
            if(this._lutInputHooks  && this._lutInputHooks.length)  fns.push('lutInputHook');
            if(this._lutOutputHooks && this._lutOutputHooks.length) fns.push('lutOutputHook');
            out.functions = fns;

            return out;
        }

        /**
         * Choose how this Transform crosses a worker boundary, if it can.
         *
         * ONE PLACE, TWO CALLERS. `transformImages()` uses it to dispatch and
         * `getWorkerInfo()` uses it to interrogate — and the second is only
         * evidence about the first if both ask the same question. Leaving the
         * choice inline in the dispatcher was how the two would quietly
         * diverge.
         *
         * MODE 1 ships the baked LUT. Cheapest, and the only mode that carries
         *   custom stages, hooks and a custom deltaE function, because those
         *   are baked in at build time. Not universally valid: N-channel
         *   output stays on the pipeline on purpose — a 6-channel CLUT would
         *   be enormous — and a LUT-only rebuild of one diverged by 27,204
         *   bytes in 35,000, max delta 254. So it is proved on a probe rather
         *   than assumed.
         *
         * MODE 2 ships the profile chain and rebuilds with create() in the
         *   worker. Exact by construction, and the only mode that reaches the
         *   LUT-free accuracy path and N-channel — which is where the speedup
         *   is worth the most, those being the slow paths — but functions
         *   cannot be structured-cloned, so it cannot carry hooks.
         *
         * Neither available means sequential, which is always correct.
         *
         * @param {Object} [opts]   as passed to transformImages
         * @param {Object} [flags]  alpha flags; derived from opts when absent
         * @returns {{payload: Object|null, signature: string|null, multicore: *}}
         */
        _multicoreHandoff(opts, flags){
            opts = opts || {};
            flags = flags || {
                inputHasAlpha:  opts.inputHasAlpha  || false,
                outputHasAlpha: opts.outputHasAlpha || false,
                preserveAlpha:  opts.preserveAlpha  || false
            };

            // PRECEDENCE: the call, then the Transform, then a pool enabled
            // at startup. Explicit always beats ambient, so `multicore: false`
            // on one batch still opts that batch out of an enabled pool.
            var multicore = opts.multicore !== undefined ? opts.multicore
                          : (this.multicore ? this.multicore
                          : (Transform._poolDefault || false));
            var none = {payload: null, signature: null, multicore: multicore};
            if(!multicore) return none;

            var resolved = this.getOptions();

            // ONE ASSIGNED KEY PER TRANSFORM, for both modes. Not derived from
            // the LUT or the chain: a content hash has to cover every input
            // that changes what the worker builds, forever, and getting that
            // list wrong silently serves one Transform another one's pipeline.
            // See pool.nextKey(). createMultiStage() drops the key when the
            // Transform is rebuilt, which is what keeps an assigned key honest.
            var signature = this._workerKey;

            if(this.lut){
                if(this._multicoreSafe === undefined){
                    this._multicoreSafe = _probeLutEquivalence(this, flags);
                }
                if(this._multicoreSafe){
                    if(!signature) signature = this._workerKey = _pool.nextKey();
                    return {
                        payload:   {mode: 'lut', lut: this.lut, lutMode: this.lutMode},
                        signature: signature,
                        multicore: multicore
                    };
                }
            }

            if(Array.isArray(this.chain) && this.chain.length >= 3){
                // `lutInputHook`, `lutOutputHook` and `gamutDeFn` are all
                // LUT-BUILD-TIME only — the hooks run inside buildIntLut()'s
                // grid walk and gamutDeFn is reached through gamutCheck() in
                // the same loop. So:
                //
                //   Mode 1            already baked; workers only read the
                //                     LUT, so none of them matter.
                //   Mode 2, no LUT    no bake happens at all, so they are
                //                     inert and it is safe to proceed.
                //   Mode 2, with LUT  the worker RE-BAKES via create(), and
                //                     the functions cannot cross the wire, so
                //                     it would bake a different LUT.
                //
                // Only that last case is unsafe. It warns and drops to
                // sequential rather than throwing: multicore is an
                // optimisation, never a capability, so the one thing that must
                // not happen is plausible-but-differently-baked output. Losing
                // the speedup is an acceptable price; losing correctness is
                // not, and neither is failing a call that has a correct answer
                // available.
                if(resolved.buildLut && resolved.functions.length){
                    if(typeof console !== 'undefined' && console.warn){
                        console.warn('jsColorEngine: transformImages fell back to ' +
                            'single-threaded. This Transform has no reusable LUT (its ' +
                            'output needs the pipeline), so a worker would have to ' +
                            're-bake it — but ' + resolved.functions.join(', ') +
                            ' cannot cross a worker boundary, so the re-bake would ' +
                            'differ. Drop the hook to parallelise.');
                    }
                    return none;
                }
                if(!signature) signature = this._workerKey = _pool.nextKey();
                return {
                    payload:   {mode: 'chain', chain: this.chain, options: resolved},
                    signature: signature,
                    multicore: multicore
                };
            }

            return none;
        }

        /**
         * Everything about this Transform that a second copy of it would have
         * to match, as plain JSON.
         *
         * This exists to be COMPARED. `transformImages()` hands work to
         * workers that rebuild the Transform at the far end — from a baked LUT
         * (mode 1) or by re-running create() on cloned profiles (mode 2) — and
         * "it produced plausible pixels" is not evidence that the rebuild
         * matched. `getWorkerInfo()` collects this same structure from every
         * worker and diffs it against the master, so a divergence shows up as
         * a named field rather than as slightly-wrong colour.
         *
         * The case that motivates it: a master holding a u16 int LUT while a
         * worker holds an f64 float one. Both convert, both look right, and
         * `lut.intLut.dataType` is where they differ.
         *
         *     const i = t.getInfo();
         *     i.lut                     // false when there is no LUT
         *     i.lut.bytes               // 287496
         *     i.lut.intLut.dataType     // 'u16'
         *     i.options.lutMode         // 'int'
         *
         * `lut` is `false`, not null or absent, when the Transform runs the
         * pipeline instead — N-channel output and the LUT-free accuracy path
         * both do, deliberately (a 6-channel CLUT would be enormous).
         *
         * @returns {Object}
         */
        getInfo(){
            var info = {
                inputChannels:  this.inputChannels,
                outputChannels: this.outputChannels,
                dataFormat:     this.dataFormat,
                chain:          _describeChain(this.chain),
                options:        this.getOptions(),
                lut:            _describeLut(this.lut, this.signLut())
            };
            return info;
        }

        /**
         * Ask every worker what it actually built, and diff it against this
         * Transform.
         *
         * Returns without spawning anything if the pool is unavailable or this
         * Transform has no worker-safe hand-off — `workers` is then empty and
         * `inSync` is true, because nothing disagreed.
         *
         *     const {inSync, differences, workers} = await t.getWorkerInfo();
         *
         * `differences` is a list of `{worker, path, master, worker: value}`,
         * empty when everything matches.
         *
         * @returns {Promise<{master: Object, workers: Object[], inSync: boolean, differences: Object[]}>}
         */
        getWorkerInfo(opts){
            var master = this.getInfo();

            // Asking what the workers built IS a request for workers, so this
            // defaults multicore on rather than inheriting the Transform's own
            // setting — otherwise the diagnostic reports "nothing disagreed"
            // for a Transform that simply never opted in, which is true and
            // useless. Pass {multicore: false} to suppress it deliberately.
            var ask = {};
            for(var k in (opts || {})) ask[k] = opts[k];
            if(ask.multicore === undefined) ask.multicore = true;

            var picked = this._multicoreHandoff(ask, null);

            if(!picked || !picked.payload){
                return Promise.resolve({master: master, workers: [],
                                        inSync: true, differences: []});
            }

            var poolOptions = (picked.multicore === true) ? {} : picked.multicore;
            var pool;
            try { pool = _pool.acquire(poolOptions); } catch(e){ pool = null; }
            if(!pool){
                return Promise.resolve({master: master, workers: [],
                                        inSync: true, differences: []});
            }

            return pool.workerInfo(picked.signature, picked.payload).then(function(infos){
                _pool.release(pool);

                var mode = picked.payload.mode;
                var all = [];
                infos.forEach(function(info, i){
                    _diffInfo(master, info, '', i, all);
                });

                // Some fields cannot match and should not: a mode-1 worker
                // rebuilt from a bare LUT genuinely has no profiles to
                // describe. Reporting those as faults would make every healthy
                // Transform read as out of sync, and a diagnostic that cries
                // wolf is one nobody reads. They are explained, not hidden.
                var differences = [], expected = [];
                all.forEach(function(d){
                    var why = _expectedDivergence(mode, d.path);
                    if(why){ d.reason = why; expected.push(d); }
                    else differences.push(d);
                });

                return {
                    master:      master,
                    workers:     infos,
                    mode:        mode,
                    inSync:      differences.length === 0,
                    differences: differences,
                    expected:    expected
                };
            }, function(e){
                _pool.release(pool);
                throw e;
            });
        }

        /**
         * Convert 1..n images, using a worker pool when it is worth it.
         *
         * ALWAYS CALLABLE. Where workers are unavailable — no `worker_threads`,
         * a restrictive CSP, `cores: 1`, or simply too little work to be worth
         * splitting — this runs the images sequentially through
         * `transformArray()` and returns the identical result. Multicore is an
         * optimisation, never a capability, so a caller never needs to feature
         * detect. The reported `workersUsed` is what was actually used, so a
         * caller measuring throughput is never told a single-threaded run was
         * parallel.
         *
         * The sequential path is also the correctness oracle: parallel output
         * must equal sequential output byte-for-byte, which is what the tests
         * assert.
         *
         *     const res = await t.transformImages([{data: rgba, pixelCount: n}]);
         *     res.images[0]      // converted output
         *     res.workersUsed    // 0 when it ran on the calling thread
         *
         * Design, and why the splitting looks the way it does:
         * docs/deepdive/multicore.md
         *
         * PER-IMAGE RESULTS. Each image may carry an `id`; one is generated
         * from its position if absent. Images finish OUT OF SUBMISSION ORDER —
         * slices are dispatched longest-first and pulled by whichever worker
         * frees up — so the id is the stable handle, not the index.
         *
         *     await t.transformImages(images, {
         *         multicore: true,
         *         onImage: (index, data, info) => {
         *             // fires as each image completes, before the batch does,
         *             // so results can be written out instead of accumulating
         *             fs.writeFileSync(info.id, encode(data));
         *         }
         *     });
         *
         * `info` carries `{id, index, pixelCount, outputChannels, ms,
         * computeMs, source}`. `ms` is wall time from the start of the call —
         * what a progress bar wants; `computeMs` is summed worker time for
         * that image, which is the work actually done and can EXCEED `ms`,
         * because one image's slices run on several workers at once. `source`
         * is the caller's own descriptor, so any metadata hung on it comes
         * back without the engine defining a shape for it.
         *
         * The same records are returned as `imageInfo`, in submission order.
         * `onImage` fires on the sequential path too: multicore is an
         * optimisation, never a capability, so a caller must not have to know
         * which path ran. A callback that throws is warned about and skipped —
         * the conversion has already succeeded by then.
         *
         * @param {Array}  images  [{data, pixelCount, id?, …metadata}, …]
         * @param {Object} [opts]  {inputHasAlpha, outputHasAlpha, preserveAlpha,
         *                          multicore: false|true|{…pool options},
         *                          onImage: (index, data, info) => void}
         * @returns {Promise<{images: Array, imageInfo: Array, workersUsed: number, tasks: number}>}
         */
        transformImages(images, opts){
            var self = this;
            opts = opts || {};

            if(!this.pipelineCreated) throw 'No Pipeline';
            if(!Array.isArray(images) || !images.length){
                return Promise.resolve({images: [], workersUsed: 0, tasks: 0});
            }

            var flags = {
                inputHasAlpha:  opts.inputHasAlpha  || false,
                outputHasAlpha: opts.outputHasAlpha || false,
                preserveAlpha:  opts.preserveAlpha  || false,
                // `|| false` above destroys the difference between "the caller
                // said false" and "the caller said nothing", and the per-image
                // default needs it: unstated means "preserve if both sides
                // have an alpha", the same rule transformArray uses.
                _preserveStated: opts.preserveAlpha !== undefined
            };

            // Per-image completion callback. Fires as each image finishes
            // rather than waiting for the batch, so a long run can report
            // progress — and, more usefully, hand each result off (written to
            // disk, encoded, posted on) instead of holding every output in
            // memory until the end.
            //
            // Fires on the SEQUENTIAL path too. Multicore is an optimisation,
            // never a capability, so a caller must not have to know which path
            // ran to get their callbacks.
            //
            // A throwing callback must not take the batch with it: the
            // conversion has already succeeded by then, and losing it because
            // a progress bar failed would be absurd.
            var onImage = (typeof opts.onImage === 'function') ? opts.onImage : null;

            // IDs are the caller's if they supplied one, and generated if not,
            // so a callback always has something stable to key on. Images
            // finish out of submission order, so the array index alone is a
            // poor handle for anything the caller is tracking — and generating
            // when absent means callers who do not care never have to think
            // about it.
            var ids = images.map(function(img, i){
                return (img && img.id !== undefined && img.id !== null) ? img.id : ('image-' + i);
            });

            // ONE NORMALISED PLAN PER IMAGE, resolved before either path
            // runs. Both the sequential and the pooled route read from this,
            // so they cannot resolve a descriptor differently — the same
            // reason the alpha overrides are resolved here rather than twice.
            var plans;
            try {
                plans = images.map(function(img, i){
                    return _imagePlan(self, img, flags, ids[i]);
                });
            } catch(e){
                // REJECT, DO NOT THROW. This method returns a Promise, so a
                // caller writing `.catch()` rather than `try/await` must still
                // see the error — a validation failure that throws
                // synchronously from an async API is an uncaught exception in
                // half the call styles that are perfectly reasonable.
                return Promise.reject(e);
            }

            // Per-image records, filled as each finishes and returned
            // alongside the buffers. Additive: `res.images` keeps its shape.
            var imageInfo = new Array(images.length);
            var batchStarted = Date.now();

            var announce = function(index, data, stats){
                var info = {
                    id:             ids[index],
                    index:          index,
                    pixelCount:     plans[index].pixelCount,
                    outputChannels: self.outputChannels,
                    // Wall time from the start of the call — what a progress
                    // bar wants. `computeMs` is the work actually done, which
                    // is the honest per-image cost.
                    ms:             Date.now() - batchStarted,
                    computeMs:      (stats && stats.computeMs !== undefined) ? stats.computeMs : null,
                    // A cancelled image still announces — a caller awaiting one
                    // callback per image would otherwise wait forever for work
                    // that will never run. `data` is null in that case: tasks
                    // already with a worker cannot be recalled, so the buffer
                    // may be partly written and is not worth handing back.
                    cancelled:      !!(stats && stats.cancelled),
                    // The caller's own descriptor, so any metadata they hung
                    // on it rides along without the engine having to define a
                    // shape for it.
                    source:         images[index]
                };
                imageInfo[index] = info;

                if(!onImage) return;
                try {
                    onImage(index, data, info);
                } catch(e){
                    if(typeof console !== 'undefined' && console.warn){
                        console.warn('jsColorEngine: transformImages onImage callback threw for ' +
                                     'image ' + index + ' (' + ids[index] + ') — the conversion ' +
                                     'itself succeeded.', e);
                    }
                }
            };

            var runSequential = function(){
                var out = images.map(function(img, i){
                    var t0 = Date.now();
                    // The SAME per-image resolution the pool path uses. If
                    // these two disagreed, a batch would convert differently
                    // depending on whether workers happened to be available —
                    // which is the one thing the sequential fallback exists to
                    // rule out.
                    var pl = plans[i], f = pl.flags;
                    var converted = self.transformArray(pl.data, f.inputHasAlpha,
                        f.outputHasAlpha, f.preserveAlpha, pl.pixelCount);
                    announce(i, converted, {computeMs: Date.now() - t0});
                    return converted;
                });
                return Promise.resolve({images: out, imageInfo: imageInfo,
                                        cancelled: images.map(function(){ return false; }),
                                        workersUsed: 0, tasks: images.length});
            };

            // PRECEDENCE: the call, then the Transform, then a pool enabled
            // at startup. Explicit always beats ambient, so `multicore: false`
            // on one batch still opts that batch out of an enabled pool.
            var multicore = opts.multicore !== undefined ? opts.multicore
                          : (this.multicore ? this.multicore
                          : (Transform._poolDefault || false));
            if(!multicore) return runSequential();

            var picked = this._multicoreHandoff(opts, flags);
            // MULTICORE WAS ASKED FOR BUT THE HANDOFF DECLINED, or it was
            // never asked for at all. Only the first is worth a word.
            if(!picked.payload){
                return (picked.multicore)
                    ? _noWorkers(this, opts, runSequential)
                    : runSequential();
            }

            var payload     = picked.payload;
            var signature   = picked.signature;
            var poolOptions = (multicore === true) ? {} : multicore;
            var pool;
            try {
                pool = _pool.acquire(poolOptions);
            } catch(e){ pool = null; }
            if(!pool) return _noWorkers(this, opts, runSequential);

            // COUNTED FROM HERE — the point this call commits to the pool,
            // and synchronous, so a producer loop sees its own submissions in
            // queueDepth() immediately. Counting inside pool.run() instead
            // read 0 for work already submitted, because run() is only reached
            // after pool.start() resolves a microtask later, and
            // onQueueBelow() then waved a whole loop through unpaced.
            //
            // Released on settle, success or failure alike: a rejected batch
            // that left the depth raised would wedge every later waiter.
            // Bytes as well as batches, so onMemoryBelow() has something to
            // hold. Input plus output: four thumbnails and four 60 MP scans are
            // the same queue depth and three orders of magnitude apart in
            // memory, and the second is the number a caller has a budget for.
            var inBPP  = self.inputChannels  + (flags.inputHasAlpha  ? 1 : 0);
            var outBPP = self.outputChannels + (flags.outputHasAlpha ? 1 : 0);
            var unit   = (self.dataFormat === 'int16') ? 2 : 1;
            var batchBytes = 0;
            for(var bi = 0; bi < images.length; bi++){
                batchBytes += plans[bi].pixelCount * (plans[bi].inChannels + plans[bi].outChannels) * unit;
            }

            _pool.enterQueue(batchBytes);
            var counted = true;
            var release = function(){
                if(counted){ counted = false; _pool.leaveQueue(batchBytes); }
            };
            var settled = function(v){ release(); return v; };
            var settledErr = function(e){ release(); throw e; };

            var totalPx = plans.reduce(function(a, pl){ return a + pl.pixelCount; }, 0);
            if(totalPx < pool.opts.parallelFloorPx){
                // Below the measured floor, splitting costs more than it saves.
                _pool.release(pool);
                release();
                return runSequential();
            }

            // PER-IMAGE ALPHA. The batch flags are the default; an image may
            // override any of them. A folder of mixed PNG and JPEG is the
            // ordinary case for a batch converter, and forcing one answer
            // means either two calls or padding every JPEG with an alpha
            // channel nobody wanted.
            //
            // Alpha is the ONLY thing that may vary: it is a stride and a copy,
            // never colour. The Transform's own channel counts are fixed, so
            // this cannot turn into "different conversions in one batch".
            var meta = plans;


            return pool.start().then(function(){
                var tasks = _pool.planBatch(meta, pool.all.length, pool.opts);

                // Passed as a FUNCTION so the pool can allocate when the batch
                // actually starts. Batches run one at a time; allocating here
                // meant every queued batch sat on a full set of output buffers
                // while it waited, and a caller submitting faster than the
                // pool drains grew memory without bound (measured: 668 MB for
                // 40 queued 4 MPx batches, against 65 MB one at a time).
                var makeOutputs = function(){
                    return meta.map(function(m){
                        return new Uint8ClampedArray(m.pixelCount * m.outChannels);
                    });
                };

                return pool.run(tasks, meta, makeOutputs, signature, payload, flags, announce, ids)
                    .then(function(res){
                        _pool.release(pool);
                        // Cancelled images report null rather than a partially
                        // converted buffer.
                        var out = res.outputs.map(function(buf, i){
                            return (res.cancelled && res.cancelled[i]) ? null : buf;
                        });
                        return {images: out, imageInfo: imageInfo,
                                cancelled: res.cancelled || [],
                                workersUsed: res.workersUsed, tasks: tasks.length};
                    });
            }).catch(function(){
                // Anything at all goes wrong with the pool — no worker_threads,
                // a spawn failure, a worker crash — and we still owe the caller
                // correct pixels.
                _pool.release(pool);
                return runSequential();
            }).then(settled, settledErr);
        }

        /**
         * Drop this Transform's lease on the worker pool.
         *
         * Workers are NOT collected when a Transform is dropped — JavaScript
         * has no destructors, and a live Worker owns an OS thread. They are
         * unref'd so a forgotten pool cannot hang the process, and an idle
         * timer reclaims them, but this is how a caller releases deterministically.
         */
        releaseWorkers() {
            _pool.destroyAll();
        }

        /**
         * Reset this Transform so it can be built again.
         *
         * create()/createMultiStage() refuse to run over an existing pipeline,
         * because re-creating used to leave the OLD LUT attached and silently
         * convert through the previous colour space. This is the supported way
         * to say "I really do want to rebuild this object" — it drops
         * everything the next create() must not inherit:
         *
         *   - the built LUT (and its int mirror), the actual stale-output risk
         *   - the pipeline and its stages
         *   - compiled WASM state and kernel bindings
         *   - this Transform's registration in the worker pool, so workers do
         *     not keep serving the old pipeline under a key this object still
         *     holds — and so the memory comes back now rather than waiting for
         *     LRU to push it out
         *   - the cached multicore probe result, which described the old LUT
         *
         * The POOL ITSELF IS LEFT RUNNING. Other Transforms are using it, and
         * a reset here is not a reason to take their workers away —
         * releaseWorkers() is the blunt instrument for that.
         *
         * Hooks, plugins and constructor options survive, which is the point:
         * a plugin can rebuild its table without re-installing its hooks and
         * double-counting them.
         *
         * PREFER `new Transform()`. This exists for the case where the hooks
         * and options genuinely must be kept, and it carries the risk that
         * goes with any hand-maintained reset: it drops what is listed above,
         * and a field added later without a line here would survive when it
         * should not. A fresh object cannot have that problem.
         *
         * @returns {Transform} this (for chaining)
         */
        clear() {
            this.forgetWorkers();          // fire and forget; see forgetWorkers()
            this._workerKey = null;
            this._multicoreSafe = undefined;

            // DROP THE KERNEL WITH THE PIPELINE. A claimed kernel is bound to
            // the pipeline that earned it the claim and holds a WASM instance
            // — up to 512 KB of tables at int16, plus pixel buffers. Leaving it
            // attached across clear() would keep that memory and, worse, offer
            // the next create() a kernel chosen for a conversion it no longer
            // performs. create() re-runs setKernel() and the claim pass.
            this._releaseKernel();
            this._kernelClaim = null;

            try { this.releaseWasmMemory(); } catch(e){ /* nothing compiled yet */ }

            this.lut = false;
            this.builtLut = this._buildLutRequested;   // intent, not state
            this.pipeline = [];
            this.pipelineCreated = false;
            this.pipelineHistory = [];
            this.debugHistory = [];
            return this;
        }

        /**
         * Drop just THIS Transform from the workers, leaving the pool running
         * for everything else.
         *
         * `releaseWorkers()` is the blunt instrument — it tears the whole pool
         * down, which is wrong when other Transforms are still using it. This
         * is the one to call when a document closes in an app that holds the
         * pool open (`idleTimeoutMs: 0`): a 33-point CMYK LUT is about 1.4 MB
         * in EVERY worker, so a finished Transform is ~11 MB across eight of
         * them, and LRU alone will not reclaim it until eight more transforms
         * come along to push it out.
         *
         * Purely an optimisation, never required for correctness. The worker
         * copy is a cache and this Transform remains its source of truth, so
         * using it again after forgetting simply re-registers it — the same
         * thing that happens after an LRU eviction or an idle-timeout
         * teardown.
         *
         * @returns {Promise<number>} how many workers were asked
         */
        forgetWorkers() {
            var picked = this._multicoreHandoff({multicore: true}, null);
            if(!picked.signature) return Promise.resolve(0);
            return _pool.forgetEverywhere(picked.signature);
        }

        releaseWasmMemory() {
            wasmLifecycle.releaseWasmStates(this);
            // A kernel that resolved onto a WASM run is now pointing at a
            // dropped module. Clearing its image path makes it re-resolve on
            // the next array() - its own decision, taken again with the WASM
            // slots empty, so it lands on the JS variant. Transform used to
            // re-run the whole resolver here to achieve the same thing.
            if(this.kernel) this.kernel.arrayFnBig = null;
        }

        /**
         * Returns the total byte length of WASM linear memory currently
         * held across all live WASM states. Useful for diagnostics,
         * deciding when to compact, or logging memory pressure.
         */
        wasmMemoryBytes() {
            var total = 0;
            var states = [
                this.wasmTetra3D, this.wasmTetra3DSimd,
                this.wasmTetra3DInt16, this.wasmTetra3DInt16Simd,
                this.wasmTetra4D, this.wasmTetra4DSimd,
                this.wasmTetra4DInt16, this.wasmTetra4DInt16Simd
            ];
            for (var i = 0; i < states.length; i++) {
                if (states[i]) total += states[i].memory.buffer.byteLength;
            }
            return total;
        }

        /**
         * Encode float Lab to u16 using this Transform's **input**-side
         * PCS encoding (ICC v2 or v4, determined at create() time).
         * @param {number} L  0–100
         * @param {number} a  -128..+127
         * @param {number} b  -128..+127
         * @returns {number[]} [uL, ua, ub] clamped to 0..65535
         * @throws If the input profile's PCS is not Lab.
         */
        inputLab2Int16(L, a, b) {
            if (!this.lut || !this.lut.inLab) throw 'inputLab2Int16: input PCS is not Lab';
            return convert.lab2Int16(L, a, b, this.lut.inLab);
        }

        /**
         * Encode float Lab to u16 using this Transform's **output**-side
         * PCS encoding.
         * @param {number} L  0–100
         * @param {number} a  -128..+127
         * @param {number} b  -128..+127
         * @returns {number[]} [uL, ua, ub] clamped to 0..65535
         * @throws If the output profile's PCS is not Lab.
         */
        outputLab2Int16(L, a, b) {
            if (!this.lut || !this.lut.outLab) throw 'outputLab2Int16: output PCS is not Lab';
            return convert.lab2Int16(L, a, b, this.lut.outLab);
        }

        /**
         * Decode u16 Lab values to float Lab using this Transform's
         * **input**-side PCS encoding.
         * @param {number} uL  u16 lightness
         * @param {number} ua  u16 a
         * @param {number} ub  u16 b
         * @returns {{type, L, a, b, whitePoint}} Lab colour object (D50)
         * @throws If the input profile's PCS is not Lab.
         */
        inputInt162Lab(uL, ua, ub) {
            if (!this.lut || !this.lut.inLab) throw 'inputInt162Lab: input PCS is not Lab';
            return convert.int162Lab(uL, ua, ub, this.lut.inLab);
        }

        /**
         * Decode u16 Lab values to float Lab using this Transform's
         * **output**-side PCS encoding.
         * @param {number} uL  u16 lightness
         * @param {number} ua  u16 a
         * @param {number} ub  u16 b
         * @returns {{type, L, a, b, whitePoint}} Lab colour object (D50)
         * @throws If the output profile's PCS is not Lab.
         */
        outputInt162Lab(uL, ua, ub) {
            if (!this.lut || !this.lut.outLab) throw 'outputInt162Lab: output PCS is not Lab';
            return convert.int162Lab(uL, ua, ub, this.lut.outLab);
        }

        gamutCheck(inDevice, outDevice, outputChannels){
            let labIn  = this.gamutTransforms.src2Lab.transform(this._gamutDeviceToObj(inDevice, true));
            let labOut = this.gamutTransforms.dest2Lab.transform(this._gamutDeviceToObj(outDevice, false));
            let de = this.gamutDeFn(labIn, labOut);

            if (this.lutGamutMode === 'map') {
                let scaled = Math.min(de / this.lutGamutMapScale, 1.0);
                let result = new Array(outputChannels);
                for (let i = 0; i < outputChannels; i++) result[i] = scaled;
                return result;
            }
            if (this.lutGamutMode === 'colorMap') {
                let t = Math.min(de / this.lutGamutMapScale, 1.0);
                let w  = this.gamutWhiteDevice;
                let gc = this.gamutColorDevice;
                let result = new Array(outputChannels);
                for (let i = 0; i < outputChannels; i++) {
                    result[i] = w[i] * (1 - t) + gc[i] * t;
                }
                return result;
            }
            // 'color' mode
            return (de > this.lutGamutLimit) ? this.gamutColorDevice : outDevice;
        }

        _gamutDeviceToObj(device, isInput) {
            let profile = isInput ? this.inputProfile : this.outputProfile;
            if (profile.type === eProfileType.Lab) {
                return { type: eColourType.Lab, L: device[0] * 100, a: device[1] * 255 - 128, b: device[2] * 255 - 128, whitePoint: illuminant.d50 };
            }
            if (profile.type === eProfileType.CMYK) {
                return { type: eColourType.CMYK, C: device[0] * 100, M: device[1] * 100, Y: device[2] * 100, K: device[3] * 100 };
            }
            if (profile.type === eProfileType.Gray) {
                return { type: eColourType.Gray, G: device[0] * 255 };
            }
            return { type: eColourType.RGB, R: device[0] * 255, G: device[1] * 255, B: device[2] * 255 };
        }

        createGamutTransforms(){

            if(!this.inputProfile || !this.outputProfile){
                return false;
            }

            let srcProfile  = this.inputProfile;
            let destProfile = this.outputProfile;

            if(!srcProfile.loaded || !destProfile.loaded){
                return false;
            }

            let src2Lab = new Transform({ dataFormat: 'object' });
            src2Lab.create(srcProfile, '*lab', eIntent.relative);

            let dest2Lab = new Transform({ dataFormat: 'object' });
            dest2Lab.create(destProfile, '*lab', eIntent.relative);

            this.gamutTransforms = {
                src2Lab,
                dest2Lab,
            };

            // 'color' and 'colorMap' modes need the warning colour in device space
            if (this.lutGamutMode === 'color' || this.lutGamutMode === 'colorMap') {
                let lab2Dest = new Transform({ dataFormat: 'object' });
                lab2Dest.create('*lab', destProfile, eIntent.relative);
                let gcResult = lab2Dest.transform(this.lutGamutColor);

                let outCh = this.getProfileChannels(destProfile);
                if (outCh === 4) {
                    this.gamutColorDevice = [gcResult.C / 100, gcResult.M / 100, gcResult.Y / 100, gcResult.K / 100];
                } else if (outCh === 3) {
                    this.gamutColorDevice = [gcResult.R / 255, gcResult.G / 255, gcResult.B / 255];
                } else {
                    this.gamutColorDevice = [gcResult.G / 255];
                }

                // 'colorMap' also needs paper white in device space
                if (this.lutGamutMode === 'colorMap') {
                    let white = this.Lab(100, 0, 0);
                    let whResult = lab2Dest.transform(white);
                    if (outCh === 4) {
                        this.gamutWhiteDevice = [whResult.C / 100, whResult.M / 100, whResult.Y / 100, whResult.K / 100];
                    } else if (outCh === 3) {
                        this.gamutWhiteDevice = [whResult.R / 255, whResult.G / 255, whResult.B / 255];
                    } else {
                        this.gamutWhiteDevice = [whResult.G / 255];
                    }
                }
            }

            return true;
        }


        /**
         * Creates a prebuilt LUT from the current pipeline. This LUT is compatible with ICCProfile
         * LUT structure, and so can be used in the same trilinear/tetrahedral stages
         *
         */
        createLut(){

            if(this.lutGamutMode !== 'none'){
                if(this.verboseTiming){
                    console.time('create Gamut Check Transforms');
                }
                this.createGamutTransforms();
                if(this.verboseTiming){
                    console.timeEnd('create Gamut Check Transforms');
                }
            }

            if(this.verboseTiming){
                console.time('create Prebuilt Lut');
            }
            var CLUT;
            var gridPoints;
            var inputChannels;
            var outputChannels

            switch(this.outputProfile.type){

                case eProfileType.Gray:
                    outputChannels = 1;
                    break;
                case eProfileType.Duo:
                    outputChannels = 2;
                    break;
                case eProfileType.Lab:
                case eProfileType.RGBMatrix:
                case eProfileType.RGBLut:
                    outputChannels = 3;
                    break;
                case eProfileType.CMYK:
                    outputChannels = 4;
                    break;
                case eProfileType.NChannel:
                    // 5CLR-15CLR output — the device LUT builders are generic
                    // in output channel count, and the 3D→NCh / 4D→NCh array
                    // loops handle the image path.
                    outputChannels = this.outputProfile.outputChannels;
                    break;
                default:
                    throw 'Create Lut Invalid output profile type ' + this.outputProfile.type;
            }

            switch(this.inputProfile.type){
                case eProfileType.Gray:
                    inputChannels = 1;
                    CLUT = this.create1DDeviceLUT(outputChannels, this.lutGridPoints3D);
                    gridPoints = [this.lutGridPoints3D];
                    break;
                case eProfileType.Duo:
                    inputChannels = 2;
                    CLUT = this.create2DDeviceLUT(outputChannels, this.lutGridPoints3D);
                    gridPoints = [this.lutGridPoints3D, this.lutGridPoints3D];
                    break;
                case eProfileType.Lab:
                case eProfileType.RGBMatrix:
                case eProfileType.RGBLut:
                    inputChannels = 3;
                    CLUT = this.create3DDeviceLUT(outputChannels, this.lutGridPoints3D);
                    gridPoints = [this.lutGridPoints3D, this.lutGridPoints3D, this.lutGridPoints3D];
                    break;
                case eProfileType.CMYK:
                    inputChannels = 4;
                    CLUT = this.create4DDeviceLUT(outputChannels, this.lutGridPoints4D);
                    gridPoints = [this.lutGridPoints4D, this.lutGridPoints4D, this.lutGridPoints4D, this.lutGridPoints4D];
                    break;
                default:
                    throw 'Create Lut Invalid input profile type ' + this.inputProfile.type;
            }

            if(this.verboseTiming){
                console.timeEnd('create Prebuilt Lut');
            }

            // convert chain to simplified object for saving
            var chain = [];
            for(var i = 0; i < this.chain.length; i++){
                if(this.chain[i] instanceof Profile){
                    chain.push( profile2Obj(this.chain[i]));
                } else {
                    chain.push(this.chain[i]); //intent
                }
            }

            var g1 =      gridPoints[0];
            var g2 = g1 * (gridPoints[1] || 0);
            var g3 = g2 * (gridPoints[2] || 0);
            return {
                // Useful info if we were to just reuse this LUT
                // we can use this to check how the LUT is built
                // By looking at the profile chain
                chain: chain,

                version: 1, // just in case in future we want to change the format

                // lut data
                inputChannels: inputChannels,
                outputChannels: outputChannels,
                gridPoints: gridPoints,
                g1: g1,
                g2: g2,
                g3: g3,
                go0: outputChannels,
                go1: g1 * outputChannels,
                go2: g2 * outputChannels,
                go3: g3 * outputChannels,
                CLUT: CLUT, // data

                // Numeric type of the CLUT cells. See `Transform#f`
                // for the matching tag on the integer mirror LUT. The outer
                // float LUT is always Float64Array by contract, so we don't
                // check this at dispatch time (kernels read it as `number`
                // regardless) — it's stamped purely so `console.log(lut)`
                // tells you what the bytes actually are, and so any future
                // LUT type (f16 / bf16 / custom fixed-point stored on the
                // outer lut) can flag itself here without overloading
                // `encoding` below.
                //
                // Keep this aligned with `intLut.dataType`: any CLUT type we
                // ever produce should be visible from a single grep for
                // `dataType`.
                dataType: 'f64',

                encoding: 'number', // serialisation format: 'number' or 'base64'
                precision: null, // Only required for PCS converisons;
                outputScale: 1, // output is already pre-scaled
                inputScale: 1, // input is already pre-scaled

                gamutMode:     this.lutGamutMode,
                gamutLimit:    this.lutGamutMode === 'color' ? this.lutGamutLimit : 0,
                gamutMapScale: (this.lutGamutMode === 'map' || this.lutGamutMode === 'colorMap') ? this.lutGamutMapScale : 0,

                inLab:  this.inputProfile  && this.inputProfile.type  === eProfileType.Lab
                    ? convert.labEncoding[this.inputProfile.version  === 2 ? 'v2' : 'v4']
                    : null,
                outLab: this.outputProfile && this.outputProfile.type === eProfileType.Lab
                    ? convert.labEncoding[this.outputProfile.version === 2 ? 'v2' : 'v4']
                    : null,
            }

            /**
             * Convert a profile to a simplified object
             * @param profile
             * @returns {{PCSDecode: (number|*), PCS8BitScale: (number|*), viewingConditions: (string|*), whitePoint, PCSEncode: (number|*), name, header, description, type, intent, version, mediaWhitePoint}}
             */
            function profile2Obj(profile){
                return {
                    header: profile.header,
                    name: profile.name,
                    type: profile.type,
                    intent: profile.intent,
                    whitePoint: profile.whitePoint,
                    description: profile.description,
                    viewingConditions: profile.viewingConditions,
                    mediaWhitePoint: profile.mediaWhitePoint,
                    PCSEncode: profile.PCSEncode,
                    PCSDecode: profile.PCSDecode,
                    PCS8BitScale: profile.PCS8BitScale,
                    version: profile.version
                }
            }
        };

        /**
         * Validate that an integer-mirror LUT matches the encoding this
         * release's kernels expect.
         *
         * Today this is a no-op for the in-process path: buildIntLut() is
         * the only producer and always stamps v1. The method exists to give
         * ANY future code that accepts a foreign intLut (serialised pipeline,
         * cross-version cache, test fixture, user-supplied precomputed LUT)
         * a single source of truth for compatibility. Call it before invoking
         * the integer kernels; on mismatch, either rebuild via buildIntLut()
         * or fall back to the float path.
         *
         * Bump the expected values here in lockstep with the tag in
         * buildIntLut().
         *
         * @param {Object} intLut - tagged object produced by buildIntLut()
         * @returns {boolean} true if safe to feed to this version's integer
         *                    kernels, false if the encoding has drifted
         */
        isIntLutCompatible(intLut){
            if(!intLut){ return false; }
            // Current kernel contracts. When any combo here changes, update
            // buildIntLut() AND the matching kernel(s) AND this check.
            if(intLut.version !== 1){ return false; }
            if(intLut.dataType !== 'u16'){ return false; }
            // Two valid (scale, gpsPrecisionBits) pairs:
            //   u8  modes : scale=65280, gpsPrecisionBits=16  (Q0.16, u8 weight)
            //   u16 modes : scale=65535, gpsPrecisionBits=13  (Q0.13, u13 weight, v1.3+)
            var u8Build  = (intLut.scale === 65280 && intLut.gpsPrecisionBits === 16);
            var u16Build = (intLut.scale === 65535 && intLut.gpsPrecisionBits === 13);
            if(!u8Build && !u16Build){ return false; }
            // accWidth varies by dimension: 16 for 3D (both builds) and 4D u16
            // (two-rounding); 20 for 4D u8 (Q16.4 single-rounding intermediate).
            if(intLut.accWidth !== 16 && intLut.accWidth !== 20){ return false; }
            return true;
        }

        /**
         * Build the integer-friendly mirror LUT used by the lutMode='int'
         * hot path.
         *
         * Called from create() after the optimiser has run, so by the time we
         * get here the float LUT's CLUT is in [0, 1] and outputScale has been
         * folded to 255 (because the device->int stage was merged into the
         * tetra interp stage). All we need to do is:
         *
         *   - rescale the float CLUT to u16 (one shot, at create time)
         *   - precompute gridPointsScale_fixed (Q0.16 of (g1-1)/255 — the
         *     extra 8 bits of precision vs Q0.8 eliminate a systematic
         *     int>float bias on monotonically-decreasing axes)
         *   - precompute maxX, maxY, maxZ[, maxK] for the input===255 boundary
         *     patch (see bench/int_vs_float.js FINDING #2)
         *
         * Then the kernel is pure ALU: Math.imul + bit shifts, no float ops,
         * no per-pixel divisions.
         *
         * SUPPORTED SHAPES (v1.1):
         *   - 3D LUT, 3 output channels  (RGB → RGB, RGB → Lab)
         *   - 3D LUT, 4 output channels  (RGB → CMYK)
         *   - 4D LUT, 3 output channels  (CMYK → RGB, CMYK → Lab)
         *   - 4D LUT, 4 output channels  (CMYK → CMYK)
         *
         * UNSUPPORTED (silently no-op, dispatcher falls back to float):
         *   - 1D / 2D LUTs                  (Gray, Duo input)
         *   - 5+ input channels             (no real-world ICC profiles)
         *   - Output channels not in {3,4}  (5+ ch hexachrome etc.)
         *
         * BUILD VARIANTS (chosen by this.lutMode):
         *
         *   u8 modes (lutMode in {int, int-wasm-scalar, int-wasm-simd}):
         *     - CLUT scale  = 65280   (= 255*256, so u16/256 = u8 exact)
         *     - gps         = Q0.16   (((g1-1) << 16) / 255)
         *     - weight (rx) = u8      (top 8 bits of fractional)
         *     - format tag  : scale=65280, gpsPrecisionBits=16
         *     Designed so the final `(... + 0x80) >> 8` shift produces u8
         *     output with zero bias. See the INT HOT PATH headers in
         *     src/kernels/3d/kernel3D_loops.js / 4d/kernel4D_loops.js.
         *
         *   u16 modes (lutMode in {int16, int16-wasm-scalar, int16-wasm-simd}):
         *     - CLUT scale  = 65535   (full u16 range — c-corner at native LSB)
         *     - gps         = Q0.13   (((g1-1) << 13) / 65535)
         *     - weight (rx) = u13     (32× more weight precision than u8 modes)
         *     - format tag  : scale=65535, gpsPrecisionBits=13
         *     Designed so identity round-trips at ≤1 LSB tolerance for any
         *     u16 input on any g1. See INT16 HOT PATH header for the bit
         *     budget proof. v1.3 settled on Q0.13 after a brief internal
         *     iteration through Q0.16 (≤17 LSB identity error, visible
         *     banding) and Q0.12 (twice the quantization noise of Q0.13).
         *     Q0.13 is the i32 ceiling: delta×rx max 65535×8191 ≈ 2^29.0,
         *     sum-of-3 ≈ 2^30.6, JS Math.imul + WASM i32.mul both defined.
         *     Bit-exact across JS and WASM.
         *
         * The two variants are NEVER mixed in one Transform — lutMode is
         * fixed at create() time and the dispatcher routes to the matching
         * kernels. The format tag (intLut.scale, intLut.gpsPrecisionBits)
         * is the cross-check; consumers verify before reading.
         *
         * For any future LUT source where the [0,1] contract isn't true
         * (e.g. raw Lab16 from ICC v4 mAB tags), this builder needs a
         * separate rescale path — flagged as TODO.
         *
         * The produced `intLut` carries a format tag (`version`, `dataType`,
         * `scale`, `gpsPrecisionBits`, `accWidth`) — see the comment block
         * at the intLut assembly site, and `isIntLutCompatible()` for the
         * check any future deserialization / sharing path should run before
         * handing a foreign intLut to the integer kernels.
         *
         * @param {Object} lut - The float LUT to mirror. Mutated: gets a new
         *                       `intLut` field if shape is supported.
         */
        buildIntLut(lut){
            if(!lut || !lut.CLUT){
                return;
            }
            var inputChannels = lut.inputChannels;
            var outputChannels = lut.outputChannels;
            var g1 = lut.g1;

            // Shape gating — silently skip unsupported shapes. This is the
            // safety net that lets us flip lutMode='int' on globally without
            // worrying about edge profiles.
            var supported3D = (inputChannels === 3 && (outputChannels === 3 || outputChannels === 4));
            var supported4D = (inputChannels === 4 && (outputChannels === 3 || outputChannels === 4));
            if(!supported3D && !supported4D){
                return;
            }

            // ---- Pick the build variant from lutMode --------------------
            //
            // u8 path  : scale 65280, Q0.16 gps, u8 weight  (kernels apply
            //            (... + 0x80) >> 8 to land in u8)
            // u16 path : scale 65535, Q0.13 gps, u13 weight (kernels apply
            //            (... + 0x1000) >> 13 to land in u16, c-corner is
            //            added at full u16 precision, no bit-stretch)
            //
            // The two are intentionally independent CLUT scales — sharing
            // a single scale-65280 CLUT across both paths (an early v1.3
            // u8-style approach) capped u16 output precision at u8-equivalent
            // and produced visible banding. See bench/int16_identity.js for
            // the proof.
            var isU16Mode = (this.lutMode === 'int16'
                          || this.lutMode === 'int16-wasm-scalar'
                          || this.lutMode === 'int16-wasm-simd');

            var scale = isU16Mode ? 65535 : 65280;
            var gpsPrecisionBits = isU16Mode ? 13 : 16;

            // Build u16 mirror of the float CLUT at the appropriate scale.
            // Float CLUT is in [0, 1] device encoding (createLut() contract).
            //
            // u8 modes use scale 65280 (= 255*256): the kernels reach u8 via
            // (u16 + 0x80) >> 8 = exact divide by 256. Scaling by 65535
            // instead would give u8 ≈ float * 255.996, a +0.4 % HIGH bias
            // that produced up to 75 % of channels off-by-1 vs the float
            // kernel on CMYK→RGB profiles (see diag_cmyk_to_rgb.js).
            //
            // u16 modes use scale 65535 (full range): the kernels add the
            // c-corner at full u16 precision and quantize only the
            // within-cell delta×rx contribution by `>> 13`. No bit-stretch
            // is needed because the CLUT already covers [0, 65535]. This
            // is the v1.3 fix for the 17-LSB identity error that showed up
            // on a "scale 65280 + bit-stretch" u16 prototype.
            var src = lut.CLUT;
            var u16 = new Uint16Array(src.length);
            for(var i = 0; i < src.length; i++){
                var v = src[i] * scale;
                if(v < 0){ v = 0; }
                else if(v > scale){ v = scale; }
                u16[i] = (v + 0.5) | 0; // round-to-nearest
            }

            // ---- Grid-points scale: Q-fixed, formula depends on input width ---
            //
            // u8 path:  gridPointsScale_fixed in Q0.16. input(u8) * gps gives
            //           a Q8.16 value whose upper 8 bits are the grid index
            //           and bits 8..15 are the Q0.8 fractional weight. Q0.16
            //           (not Q0.8) is needed because the true ratio
            //           (g1-1)/255 has more than 8 bits of meaning — for
            //           g1=33 the ratio is 32/255 = 0.12549, which rounds
            //           to gps=8224 in Q0.16. Earlier Q0.8 (gps=32) truncated
            //           to 0.125 exactly — ~0.1 % LOW, asymmetric on
            //           monotonically-decreasing CMY axes (see
            //           diag_cmyk_to_rgb.js). Overflow: u8 * gps_Q16 ≤ 2^22.
            //
            // u16 path: gridPointsScale_fixed_u16 in Q0.13. input(u16) * gps
            //           gives a value whose upper bits are the grid index
            //           and bits 0..12 are the Q0.13 fractional weight.
            //           Q0.13 is the i32 ceiling for u13 weight on a u16
            //           CLUT (delta×rx max = 65535×8191 ≈ 2^29.0, sum of 3
            //           axes ≈ 2^30.6, fits i32 with ~1.4 bits headroom).
            //           u14/u15 weight overflows on adversarial CLUTs
            //           (see v1.3 Q0.13 design notes). For g1=33: gps_u13 = 4.
            //           Overflow: u16 * gps_u13 ≤ 2^20.
            //           v1.3 settled at Q0.13 (over a brief Q0.12 iteration)
            //           — halves quantization noise vs Q0.12, still well
            //           under i32, bit-exact JS↔WASM.
            var gps_fixed     = isU16Mode ? 0 : Math.round(((g1 - 1) << 16) / 255);
            var gps_fixed_u16 = isU16Mode ? Math.round(((g1 - 1) << 13) / 65535) : 0;

            // Per-axis maxima for the input===255 boundary patch — see
            // bench/int_vs_float.js FINDING #2 for why this is non-optional.
            // The 4D K-axis (go3) needs the same treatment when present.
            // Same maxX/Y/Z/K serve the u16 kernel (input===65535 boundary)
            // since they are pure grid-index offsets, independent of input
            // bit width.
            var maxX = (g1 - 1) * lut.go2;
            var maxY = (g1 - 1) * lut.go1;
            var maxZ = (g1 - 1) * lut.go0;
            var maxK = supported4D ? ((g1 - 1) * lut.go3) : 0;

            // ------------------------------------------------------------
            // FORMAT TAG — do not remove.
            // ------------------------------------------------------------
            // `intLut` is normally rebuilt at Transform.create() time from
            // the float CLUT, so the tag below is informational today. BUT
            // if anyone ever persists `intLut` (custom cache, test fixture,
            // serialised pipeline, a future LUT-sharing feature) these
            // fields are the safety net that lets the consuming kernel
            // detect an incompatible encoding and rebuild/reject rather
            // than silently misinterpret the bytes.
            //
            // `dataType` mirrors the field of the same name on the outer
            // float LUT (see createLut — 'f64' there). Using the same field
            // name across both LUT types means a single `console.log(lut)`
            // tells you everything about the storage format, and a single
            // grep for `dataType` finds every LUT variant we ever ship.
            //
            // Bump `version` whenever ANY of the following change:
            //   - `dataType`   (storage type — e.g. 'u16' → 'i32-q15.16'
            //                   for a future WASM SIMD path, or 'f32' for
            //                   a half-precision path)
            //   - `scale`      (u16 value representing 1.0 in the CLUT —
            //                   65280 for u8-target builds (=255*256, so
            //                   u16/256 = u8 exactly), 65535 for u16-target
            //                   builds (full range, no bit-stretch needed))
            //   - `gpsPrecisionBits`  (Q0.N weight precision — 16 for u8
            //                          modes, 13 for u16 modes (i32 limit
            //                          on a u16 CLUT — see v1.3 Q0.13
            //                          design; settled at 13 over a brief
            //                          internal Q0.12 iteration during v1.3
            //                          development))
            //   - `accWidth`   (accumulator width for 4D — currently 20
            //                   for u8 mode (Q16.4), raising to 22+ would
            //                   require wider LUT or re-proved overflow
            //                   bounds. u16 mode uses two-rounding 4D
            //                   instead of a single-rounding intermediate)
            //
            // Never reuse a version number for a different encoding.
            //
            // SCALE/PRECISION COMBINATIONS THAT HAVE EVER SHIPPED:
            //   v1.1+ : scale=65280, gpsPrecisionBits=16 — u8 modes
            //   v1.3+ : scale=65535, gpsPrecisionBits=13 — u16 modes
            //           (v1.3 settled at Q0.13 after a brief internal Q0.12
            //           iteration during development — Q0.13 halves
            //           quantization noise. Replaced an unshipped
            //           scale=65280, gpsPrecisionBits=16 u16 build that had
            //           ≤17 LSB identity error and visible banding — see
            //           bench/int16_identity.js)
            lut.intLut = {
                // --- format tag ---
                version: 1,                       // v1.1 integer encoding (field set unchanged across u8/u16)
                dataType: 'u16',                  // Uint16Array CLUT (matches outer lut.dataType field)
                scale: scale,                     // 65280 for u8 modes, 65535 for u16 modes
                gpsPrecisionBits: gpsPrecisionBits, // 16 for u8 modes, 13 for u16 modes (Q0.13)
                accWidth: supported4D ? (isU16Mode ? 16 : 20) : 16,  // u8 4D uses u20 Q16.4; u16 4D uses two-rounding (no intermediate)

                // --- CLUT and indexing ---
                CLUT: u16,
                gridPointsScale_fixed: gps_fixed,         // Q0.16, populated for u8 modes only (0 in u16 modes)
                gridPointsScale_fixed_u16: gps_fixed_u16, // Q0.13, populated for u16 modes only (0 in u8 modes)
                maxX: maxX,
                maxY: maxY,
                maxZ: maxZ,
                maxK: maxK,
                inputChannels: inputChannels,
                outputChannels: outputChannels,
                g1: g1,
                go0: lut.go0,
                go1: lut.go1,
                go2: lut.go2,
                go3: supported4D ? lut.go3 : 0,

                gamutMode:     lut.gamutMode     || 'none',
                gamutLimit:    lut.gamutLimit    || 0,
                gamutMapScale: lut.gamutMapScale || 0,
            };

            if(this.verboseTiming){
                var dim = supported4D ? '4D' : '3D';
                var dimMaxes = supported4D
                    ? ('maxX/Y/Z/K=' + maxX + '/' + maxY + '/' + maxZ + '/' + maxK)
                    : ('maxX/Y/Z=' + maxX + '/' + maxY + '/' + maxZ);
                var gpsLabel = isU16Mode
                    ? ('gps_u13=' + gps_fixed_u16 + ' (Q0.13)')
                    : ('gps_u16=' + gps_fixed     + ' (Q0.16)');
                console.log('  lutMode=' + this.lutMode + ': built u16 mirror (' + dim +
                    ', scale=' + scale + ') — ' +
                    (u16.byteLength / 1024).toFixed(1) + ' KB (' +
                    (src.byteLength / 1024).toFixed(1) + ' KB float source), ' +
                    gpsLabel + ', ' + dimMaxes);
            }
        };

        /**
         *  Create the pipeline of stages to convert from input to output (Monotone)
         * @param outputChannels
         * @param gridPoints
         * @returns {Float64Array}
         */
        create1DDeviceLUT(outputChannels, gridPoints){
            var CLUT = new Float64Array(this.outputProfile.outputChannels * gridPoints);
            var position = 0;
            var step = 1 / (gridPoints - 1);
            var a,o;
            var count = 0;
            var inHooks  = this._lutInputHooks;
            var outHooks = this._lutOutputHooks;
            var hasIn  = inHooks.length  > 0;
            var hasOut = outHooks.length > 0;
            for(a = 0; a < gridPoints; a++){
                var src = [a * step];
                if (hasIn) src = this._applyLutHooks(inHooks, src);
                var device = this.transform(src);
                if (hasOut) device = this._applyLutHooks(outHooks, device, src);
                for(o = 0; o < outputChannels; o++){
                    CLUT[position++] = device[o];
                }
                count++;
            }
            return CLUT;
        }

        /**
         * Generate the CLUT data for a 2D output device LUT (Duotone)
         * @param outputChannels
         * @param gridPoints
         * @returns {Float64Array}
         */
        create2DDeviceLUT(outputChannels, gridPoints){
            var lutsize = gridPoints * gridPoints;
            var CLUT = new Float64Array(this.outputProfile.outputChannels * lutsize);
            var position = 0;
            var step = 1 / (gridPoints - 1);
            var a,b,o
            var av;
            var count = 0;
            var inHooks  = this._lutInputHooks;
            var outHooks = this._lutOutputHooks;
            var hasIn  = inHooks.length  > 0;
            var hasOut = outHooks.length > 0;
            for(a = 0; a < gridPoints; a++){
                av = a * step;
                for(b = 0; b < gridPoints; b++) {
                    var src = [av, b * step];
                    if (hasIn) src = this._applyLutHooks(inHooks, src);
                    var device = this.transform(src);
                    if (hasOut) device = this._applyLutHooks(outHooks, device, src);

                    if(this.lutGamutMode !== 'none'){
                        device = this.gamutCheck(src, device, outputChannels);
                    }

                    for(o = 0; o < outputChannels; o++){
                        CLUT[position++] = device[o];
                    }
                    count++;
                }
            }
            return CLUT;
        }

        /**
         *  Generate the CLUT data for a 3D output device LUT (RGB/LAB)
         *  Since RGB,RGBMatrix and Lab are all device encoding inputs are 0.0 - 1.0 we can create a LUT for them the same way
         * @returns {Float32Array}
         */
        create3DDeviceLUT(outputChannels, gridPoints){

            var lutsize = gridPoints * gridPoints * gridPoints;
            var CLUT = new Float64Array(this.outputProfile.outputChannels * lutsize);

            var position = 0;
            var step = 1 / (gridPoints - 1);
            var r,g,b,o;
            var rv,gv;
            var count = 0;
            var inHooks  = this._lutInputHooks;
            var outHooks = this._lutOutputHooks;
            var hasIn  = inHooks.length  > 0;
            var hasOut = outHooks.length > 0;
            for(r = 0; r < gridPoints; r++){
                rv = r * step;
                for(g = 0; g < gridPoints; g++){
                    gv = g * step;
                    for( b = 0; b < gridPoints; b++){
                        let src = [rv, gv, b * step];
                        if (hasIn) src = this._applyLutHooks(inHooks, src);
                        var device = this.transform(src);
                        if (hasOut) device = this._applyLutHooks(outHooks, device, src);

                        if(this.lutGamutMode !== 'none'){
                            device = this.gamutCheck(src, device, outputChannels);
                        }

                        for(o = 0; o < outputChannels; o++){
                            CLUT[position++] = device[o];
                        }
                        count++;
                    }
                }
            }
            if(this.verbose) {
                console.log('3D LUT size : ' + count + ' points @ ' + gridPoints + ' ' + gridPoints + ' ' + gridPoints);
            }
            return CLUT;
        }

        /**
         * Generate the CLUT data for a 4D output device LUT (CMYK)
         * @param outputChannels
         * @param gridPoints
         * @returns {Float32Array}
         */
        create4DDeviceLUT(outputChannels, gridPoints){
            var lutsize = gridPoints * gridPoints * gridPoints * gridPoints;
            var CLUT = new Float64Array(this.outputProfile.outputChannels * lutsize);

            var position = 0;
            var step = 1 / (gridPoints - 1);
            var c, m, y, k, o;
            var cv, mv, yv;
            var count = 0;
            var device;
            var inHooks  = this._lutInputHooks;
            var outHooks = this._lutOutputHooks;
            var hasIn  = inHooks.length  > 0;
            var hasOut = outHooks.length > 0;

            for(c = 0; c < gridPoints; c++){
                cv = c * step;
                for(m = 0; m < gridPoints; m++){
                    mv = m * step;
                    for(y = 0; y < gridPoints; y++){
                        yv = y * step;
                        for(k = 0; k < gridPoints; k++){
                            let src = [cv, mv, yv, k * step];
                            if (hasIn) src = this._applyLutHooks(inHooks, src);
                            // Chain stages via this.transform() — matches create3DDeviceLUT.
                            // Previous inline loop incorrectly passed `src` to every stage
                            // instead of chaining outputs, producing wrong CLUT data for
                            // any chain longer than one stage.
                            device = this.transform(src);
                            if (hasOut) device = this._applyLutHooks(outHooks, device, src);

                            if(this.lutGamutMode !== 'none'){
                                device = this.gamutCheck(src, device, outputChannels);
                            }

                            for(o = 0; o < outputChannels; o++){
                                CLUT[position++] = device[o];
                            }
                            count++;
                        }
                    }
                }
            }
            return CLUT;
        }


        /**
         * Run a single colour through the full pipeline. ACCURACY-PATH entry point.
         *
         * Walks every stage in this.pipeline, dispatching via funct.call(this, ...)
         * so stages have access to the Transform instance. Allocates intermediate
         * arrays per stage. Designed for one-colour-at-a-time work — colour
         * pickers, ΔE, swatch soft-proof, profile analysis.
         *
         * Cost: ~µs per colour (scales linearly with pipeline length).
         *
         *  ⚠ DO NOT loop this over image data. For 100 colours it's fine; for
         *    100,000 colours use transformArray(); for image-grade pixel buffers
         *    use transformArrayViaLUT() with `buildLut: true, dataFormat: 'int8'`.
         *    See class JSDoc "USAGE GUIDE" and the "anti-pattern" section.
         *
         * When `pipelineDebug` is true, each stage's input/output is recorded into
         * this.pipelineHistory and this.debugHistory for inspection.
         *
         * Naming note: called "forward" because the original design left room for
         * an auto-generated `reverse()` pipeline. That feature was never shipped;
         * `transform()` is correct function name.
         *
         * @param {object|number[]} cmsColor  A colour in the shape implied by
         *      `dataFormat`: an object (`{type, R, G, B}`, `{type, L, a, b}`, …)
         *      for 'object'/'objectFloat', or a flat array for 'device'.
         * @returns {object|number[]}  Output colour in the destination profile's
         *      space, in the shape implied by `dataFormat`.
         * @throws {string} 'No Pipeline' if create()/createMultiStage() hasn't run.
         */
        transform(cmsColor){

            if(!this.pipelineCreated){
                throw 'No Pipeline';
            }

            // THE ONE SILENT HOLE. transform() is polymorphic by contract —
            // {object|number[]} — and arrays work in every format that accepts
            // them. A colour OBJECT into a DEVICE-source Transform in an
            // int/device format is the exception: with a LUT it is absorbed
            // fine, but on the LUT-free pipeline it comes back as
            // [NaN, NaN, NaN, NaN]. Right length, right shape, no error,
            // garbage values. Silence is the bug, not the restriction.
            //
            // LAB AND XYZ SOURCES ARE EXCLUDED at int8/int16, and must be:
            // those pipelines accept an object at those formats, and guarding
            // them would reject valid input and break validateOnCreate for
            // every Lab/XYZ transform.
            //
            // NOT under `device`, though — `_buildValidationInput` gates its
            // Lab/XYZ carve-out on `format !== 'device'`, so a device-format
            // Lab source expects an ARRAY, and an object there returned
            // [null, null, null]. Matching that gate exactly closes the last
            // silent cell rather than inventing a second rule.
            //
            // Ordered for cost: `lut === false` is a boolean compare that
            // short-circuits instantly for every LUT transform, and arrays
            // exit on the third check. The LUT builder drives this method once
            // per grid cell (35,937 for a 33-point RGB table), and only ever
            // passes arrays, so it never reaches the profile-type checks.
            if(this.lut === false &&
               cmsColor !== null && typeof cmsColor === 'object' &&
               typeof cmsColor.length !== 'number' &&
               (this.dataFormat === 'int8' || this.dataFormat === 'int16' ||
                this.dataFormat === 'device') &&
               (this.dataFormat === 'device' ||
                (this.inputProfile &&
                 this.inputProfile.type !== eProfileType.Lab &&
                 this.inputProfile.type !== eProfileType.XYZ))){
                throw 'transform: this Transform has dataFormat "' +
                      this.dataFormat + '" and no LUT, so it cannot take a ' +
                      'colour object — the pipeline would return NaN. Pass a ' +
                      'number array such as [128, 128, 128], or create the ' +
                      'Transform with dataFormat "object", or with ' +
                      'buildLut:true.';
            }

            var pipeline = this.pipeline;
            var len = pipeline.length;
            var newResult;
            var result = cmsColor;
            var i;
            var stage;
            if(this.pipelineDebug){
                this.pipelineHistory = [result];
                this.debugHistory = [];
                for(i = 0; i < len; i++){
                    stage = pipeline[i];
                    newResult = stage.funct.call(this, result,  stage.stageData, stage);
                    if(stage.debugFormat !== ''){
                        this.addDebugHistory(stage.debugFormat, stage.stageName, result, newResult );
                    }
                    this.pipelineHistory.push(newResult);
                    result = newResult;
                }
            } else if(this._pixelCacheData){
                // Pixel-cache walk. Reads stage.step instead of incrementing
                // so the cache check can jump the maths on a hit. Kept in its
                // own arm because `i += stage.step` makes the loop counter
                // depend on a load, where `i++` is a register increment the
                // CPU speculates through — the default walk below must not
                // pay for a feature it isn't using.
                i = 0;
                while(i < len){
                    stage = pipeline[i];
                    result = stage.funct.call(this, result, stage.stageData, stage);
                    i += stage.step;
                }
            } else {
                for(i = 0; i < len; i++){
                    result = pipeline[i].funct.call(this, result, pipeline[i].stageData, pipeline[i]);
                }
            }
            return result;
        };

        /**
         * Public alias of transform().
         *
         * Single-colour, accuracy-first conversion. See {@link Transform#transform}
         * for the full contract and the "DO NOT loop over image data" warning.
         *
         * @param {object|number[]} cmsColor
         * @returns {object|number[]}
         */
        forward(cmsColor){
            console.warn('jsColorEngine: forward is deprecated')
            return this.transform(cmsColor);
        }

        /**
         * IMAGE-GRADE FAST PATH. Converts an array of 8-bit pixel data through
         * the prebuilt CLUT using the unrolled tetrahedral interpolators in this
         * file. This is the entry point you want for canvas data, video frames,
         * and anything pixel-shaped.
         *
         * Throughput (V8 / x64, measured via bench/mpx_summary.js, GRACoL2006):
         * ~70 Mpx/s RGB→RGB and ~60 Mpx/s RGB→CMYK on 3D LUTs; ~50-60 Mpx/s
         * on 4D LUTs (CMYK input). `lutMode: 'int'` adds another 4-16 % on top.
         *
         * Routing inside this method picks the most specialised inner loop:
         *
         *      input → output channels       inner loop
         *      ───────────────────────       ───────────────────────────────────
         *      1     → N                     linearInterp1DArray_NCh_loop
         *      2     → N                     bilinearInterp2DArray_NCh_loop
         *      3     → 3   (RGB→RGB,  Lab)   tetrahedralInterp3DArray_3Ch_loop
         *      3     → 4   (RGB→CMYK)       tetrahedralInterp3DArray_4Ch_loop
         *      3     → N   (RGB→6+ch)       tetrahedralInterp3DArray_NCh_loop
         *      4     → 3   (CMYK→RGB, Lab)  tetrahedralInterp4DArray_3Ch_loop
         *      4     → 4   (CMYK→CMYK)      tetrahedralInterp4DArray_4Ch_loop
         *      4     → N                    tetrahedralInterp4DArray_NCh_loop
         *
         *  INPUT CONTRACT — these are NOT validated in the per-pixel inner loop
         *
         *   - inputArray must be a Uint8ClampedArray or Uint8Array.
         *   - Values must be 0..255. Out-of-range values produce undefined
         *     behaviour (garbage colours, no exception thrown).
         *   - Length must equal pixelCount * inputChannelsPerPixel (where the
         *     "+1 for alpha" is included if `inputHasAlpha` is true).
         *   - The Transform must have been created with `buildLut: true` and
         *     `dataFormat: 'int8'` (otherwise this throws 'No LUT loaded').
         *
         *  ALPHA HANDLING
         *
         *   - inputHasAlpha:  if true, every (channels+1)th byte of the input is
         *                     treated as alpha and skipped (or copied — see
         *                     preserveAlpha).
         *   - outputHasAlpha: if true, the output is written with an alpha slot
         *                     after each pixel.
         *   - preserveAlpha:  if true, copy alpha from input to output (requires
         *                     both the above to be true). If undefined, defaults
         *                     to `outputHasAlpha && inputHasAlpha`.
         *
         *  TODO (future enhancements)
         *   - Pixel-format strings: 'RGB', 'RGBA', 'BGRA', 'CMYK', 'CMYKA'
         *     to make the alpha-handling triple-boolean less error-prone.
         *   - Optional `out` buffer parameter to avoid the per-call
         *     `new Uint8ClampedArray(...)` allocation (matters for
         *     real-time soft-proofing of video / repeated canvas redraws).
         *   - Reactivate the *_loop_16bit variants for 16-bit input (currently
         *     commented out at the routing switch below). Requires fixing the
         *     `(inputN === 255)` boundary check in the loops first — see the
         *     HOT PATH header above tetrahedralInterp3DArray_4Ch_loop.
         *
         * @param {Uint8ClampedArray|Uint8Array} inputArray
         * @param {boolean} inputHasAlpha   Input bytes-per-pixel includes alpha.
         * @param {boolean} outputHasAlpha  Output bytes-per-pixel should include alpha.
         * @param {boolean} [preserveAlpha] Copy alpha through unchanged. Defaults
         *                                  to (outputHasAlpha && inputHasAlpha).
         * @param {number}  [pixelCount]    Pixels to convert. Defaults to
         *                                  Math.floor(inputArray.length / inputBPP).
         * @returns {Uint8ClampedArray}     A new Uint8ClampedArray of length
         *                                  pixelCount * outputBytesPerPixel.
         * @throws {string} 'No LUT loaded' if the Transform was built without
         *                  buildLut: true.
         */
        /**
         * IMAGE FAST PATH. Pre-built LUT → buffered pixel transform.
         * v1.3 table-driven dispatcher.
         *
         * The 3D / 4D dispatch — previously a 200-line if/else cascade with
         * inline WASM bind/run calls — now collapses to:
         *
         *     run = (pixelCount >= threshold) ? big : small;
         *     run(this, in, out, px, lut, ia, oa, pa);
         *
         * because all the gating (WASM state availability, intLut presence,
         * cMax bucketing, fallback degradation) is resolved ONCE at create()
         * time, inside the kernel, and cached on the kernel. Per-array overhead vs
         * the legacy cascade: one less conditional pyramid, one extra
         * indirect call. Net ~zero on hot paths, massively cleaner to
         * read and extend.
         *
         *  ROUTING TABLE (single source of truth — src/lutKernelTable.js)
         *
         *      input → output channels       resolved key (sample for lutMode='float')
         *      ───────────────────────       ──────────────────────────────────────────
         *      1     → N                     (gray bypass — linearInterp1DArray_NCh_loop)
         *      2     → N                     (duotone bypass — bilinearInterp2DArray_NCh_loop)
         *      3     → 3   (RGB→RGB,  Lab)   fl_3_3   → tetrahedralInterp3DArray_3Ch_loop
         *      3     → 4   (RGB→CMYK)        fl_3_4   → tetrahedralInterp3DArray_4Ch_loop
         *      3     → N   (RGB→6+ch)        fl_3_n   → tetrahedralInterp3DArray_NCh_loop
         *      4     → 3   (CMYK→RGB, Lab)   fl_4_3   → tetrahedralInterp4DArray_3Ch_loop
         *      4     → 4   (CMYK→CMYK)       fl_4_4   → tetrahedralInterp4DArray_4Ch_loop
         *      4     → N                     fl_4_n   → tetrahedralInterp4DArray_NCh_loop
         *
         * For other lutModes (int / int16 / int-wasm-* / int16-wasm-*)
         * the resolver walks the same matrix with the appropriate
         * `<modeShort>_<inCh>_<outCh>` start key, falling through the
         * sibling chain on any per-host miss (no WASM, no intLut, batch
         * below threshold).
         *
         *  INPUT CONTRACT — NOT validated in the per-pixel inner loop
         *
         *   - inputArray must be Uint8ClampedArray (int8 modes), Uint16Array
         *     (int16 modes), or numeric Array.
         *   - Length must equal pixelCount * inputBytesPerPixel.
         *   - The Transform must have been created with `buildLut: true`.
         *
         *  ALPHA HANDLING
         *
         *   - inputHasAlpha:  if true, every (channels+1)th byte/word is
         *                     treated as alpha and skipped (or copied — see
         *                     preserveAlpha).
         *   - outputHasAlpha: if true, the output is written with an alpha
         *                     slot after each pixel.
         *   - preserveAlpha:  if true, copy alpha from input to output
         *                     (requires both the above to be true). If
         *                     undefined, defaults to
         *                     `outputHasAlpha && inputHasAlpha`.
         *
         * @param  {Uint8ClampedArray|Uint16Array|Float64Array|Array} inputArray
         * @param  {boolean} inputHasAlpha   Input bytes-per-pixel includes alpha.
         * @param  {boolean} outputHasAlpha  Output bytes-per-pixel should include alpha.
         * @param  {boolean} [preserveAlpha] Copy alpha through unchanged. Defaults
         *                                   to (outputHasAlpha && inputHasAlpha).
         * @param  {number}  [pixelCount]    Pixels to convert. Defaults to
         *                                   Math.floor(inputArray.length / inputBPP).
         * @param  {Uint8ClampedArray|Uint16Array} [outputArray]
         *                                   Optional destination buffer to reuse.
         *                                   Must match expected output type and
         *                                   have at least pixelCount * outputBPP
         *                                   length.
         * @return {Uint8ClampedArray|Uint16Array} Output typed array. If
         *                                   outputArray is provided and valid, the
         *                                   same instance is returned.
         *  WASM MEMORY RETENTION
         *
         *   When lutMode is a WASM variant ('int-wasm-scalar', 'int-wasm-simd',
         *   etc.), each call allocates WASM linear memory sized for the current
         *   image. This memory persists between calls and only grows — WASM
         *   pages cannot be released back to the OS by spec. In practice:
         *
         *   - Fixed-size workflows (video frames, same-size batch): memory
         *     stabilises after the first call. No growth, no waste.
         *   - Mixed-size workflows: memory stays at the high-water mark of
         *     the largest image processed unless automatic guards are active.
         *
         *   Automatic guards (checked immediately after every transform):
         *     wasmMaxMemory  (default 128 MB) — compacts any state whose memory
         *                    exceeds this absolute byte ceiling. Set 0 to disable.
         *     wasmShrinkRatio — compacts when memory exceeds ratio × what was
         *                    needed for the image just processed. Default 0 (off).
         *
         *   Both fire post-run, so even the last image in a batch releases
         *   memory immediately — no need to wait for a subsequent call.
         *
         *   Manual control:
         *     transform.compactWasmMemory()    — re-instantiate, fresh memory
         *     transform.releaseWasmMemory()    — drop WASM entirely, use JS
         *     transform.wasmMemoryBytes()      — check current usage
         *
         *   See docs/deepdive/WasmKernels.md § "WASM memory management" for
         *   benchmarked costs and design rationale.
         *
         * @param  {Uint8ClampedArray|Uint16Array|Float64Array|Array} inputArray
         * @param  {boolean} inputHasAlpha   Input bytes-per-pixel includes alpha.
         * @param  {boolean} outputHasAlpha  Output bytes-per-pixel should include alpha.
         * @param  {boolean} [preserveAlpha] Copy alpha through unchanged. Defaults
         *                                   to (outputHasAlpha && inputHasAlpha).
         * @param  {number}  [pixelCount]    Pixels to convert. Defaults to
         *                                   Math.floor(inputArray.length / inputBPP).
         * @param  {Uint8ClampedArray|Uint16Array} [outputArray]
         *                                   Optional destination buffer to reuse.
         *                                   Must match expected output type and
         *                                   have at least pixelCount * outputBPP
         *                                   length. Eliminates per-call allocation
         *                                   and reduces GC pressure — especially
         *                                   beneficial for real-time loops (video,
         *                                   animation).
         * @return {Uint8ClampedArray|Uint16Array} Output typed array. If
         *                                   outputArray is provided and valid, the
         *                                   same instance is returned.
         * @throws {string} 'No LUT loaded' if the Transform was built without
         *                  buildLut: true.
         */
        transformArrayViaLUT(inputArray, inputHasAlpha, outputHasAlpha, preserveAlpha, pixelCount, outputArray){
            var lut = this.lut;
            if(!lut){
                throw 'No LUT loaded';
            }

            // NO PREAMBLE. pixelCount and preserveAlpha used to be defaulted
            // here, and again by whichever other caller reached the kernel --
            // and NOT AT ALL by a third, which is how
            // transformArray(input, false, false) on a matrix-shaper pair once
            // returned [] : pixelCount arrived undefined and sized the output
            // as undefined * 3. They are the kernel's, defaulted once at the
            // top of its array(), and undefined travels there untouched.

            // v1.7 kernel modules — the kernel instance (set at create() time
            // by setKernel()) owns output allocation/validation and variant
            // dispatch. See src/kernels/ and docs/deepdive/KernelModules.md.
            //
            // Safety net: the only way to get here without a kernel is a LUT
            // attached out-of-band onto a Transform that never ran create()
            // — route by the LUT's own input dimension in that case.
            if(this.kernel === null){
                this.setKernel(lut.inputChannels);
                if(this.kernel === null){
                    throw 'Invalid inputChannels ' + lut.inputChannels;
                }
            }

            return this.kernel.array(inputArray, outputArray, pixelCount, lut, inputHasAlpha, outputHasAlpha, preserveAlpha);
        }

        /**
         * Generic array transform. Routes to the right path based on dataFormat
         * and whether a LUT was prebuilt. This is the recommended entry point for
         * any "I have N colours, convert them all" workload — it'll automatically
         * pick the fastest legitimate path.
         *
         *  ROUTING TABLE
         *
         *   dataFormat === 'int8' AND LUT prebuilt
         *      → transformArrayViaLUT()  — the IMAGE FAST PATH (~45-215 Mpx/s).
         *        outputFormat is ignored (always Uint8ClampedArray out).
         *
         *   dataFormat === 'object' OR 'objectFloat'
         *      → per-pixel ACCURACY PATH walking the full pipeline.
         *        inputArray is an array of colour objects, output is too.
         *        `outputFormat` is ignored.
         *
         *   dataFormat === 'int8' / 'int16' / 'device' AND no LUT
         *      → per-pixel ACCURACY PATH walking the full pipeline over a flat
         *        numeric array. SLOW for image data — if you're processing
         *        pixels, rebuild the Transform with `buildLut: true` so you get
         *        routed to the fast path above.
         *
         *  WASM MEMORY & OUTPUT BUFFER REUSE
         *
         *   When routed to the LUT fast path with a WASM lutMode, WASM linear
         *   memory is retained between calls at the high-water mark of the
         *   largest image processed (WASM pages cannot shrink by spec). Pass
         *   `outputArray` to reuse a pre-allocated buffer and avoid per-call
         *   JS allocation / GC pressure.
         *
         *   Memory is automatically capped at 128 MB by default
         *   (wasmMaxMemory) — anything beyond that is compacted on the next
         *   call. See transformArrayViaLUT() JSDoc for all reclaim methods
         *   (compactWasmMemory, setWasmShrinkRatio, setWasmMaxMemory,
         *   releaseWasmMemory, wasmMemoryBytes) and
         *   docs/deepdive/WasmKernels.md for full details.
         *
         *  OUTPUT FORMAT
         *
         *   `outputFormat` controls the output container type for the flat-array
         *   paths:
         *      'int8'    → Uint8ClampedArray
         *      'int16'   → Uint16Array
         *      'float32' → Float32Array
         *      'float64' → Float64Array
         *      'same'    → match inputArray's typed-array constructor
         *      undefined → plain Array (default)
         *
         *  TODO (future enhancements)
         *   - Pixel-format strings: 'RGB', 'RGBA', 'BGRA', 'CMYK', 'CMYKA'
         *     replacing the current inputHasAlpha/outputHasAlpha/preserveAlpha
         *     triple-boolean.
         *
         * @param {Uint8ClampedArray|Uint8Array|Uint16Array|Float32Array|Float64Array|Array} inputArray
         * @param {boolean} inputHasAlpha
         * @param {boolean} outputHasAlpha
         * @param {boolean} [preserveAlpha]
         * @param {number}  [pixelCount]
         * @param {string}  [outputFormat]  See OUTPUT FORMAT above.
         * @param {Uint8ClampedArray|Uint16Array} [outputArray]
         *                  Optional reusable destination buffer. Only used when
         *                  transformArray() routes to transformArrayViaLUT().
         * @returns {Uint8ClampedArray|Uint16Array|Float32Array|Float64Array|Array}
         * @throws {string} 'No Pipeline' if create()/createMultiStage() hasn't run.
         * @throws {string} 'forwardArray can only be used with int8 or int16
         *                  dataFormat' for invalid combinations.
         */
        transformArray(inputArray, inputHasAlpha, outputHasAlpha, preserveAlpha, pixelCount, outputFormat, outputArray){

            if(!this.pipelineCreated){
                throw 'No Pipeline';
            }

            // outputFormat is deprecated. The output array type is fixed at create() time
            // via dataFormat and is baked into the LUT's outputScale. Passing outputFormat
            // produces incorrect results for integer LUT modes (values are pre-scaled to
            // 0–255 or 0–65535; writing into a mismatched container gives garbage).
            // Pass a pre-allocated outputArray of the correct type instead, or omit it
            // and let transformArray allocate based on the dataFormat set at create().
            if(outputFormat !== undefined && outputFormat !== null){
                console.warn('jsColorEngine: transformArray outputFormat parameter is deprecated ' +
                    'and will be removed in a future release. Output array type is fixed at ' +
                    'create() time via dataFormat. Remove outputFormat from your call.');
            }

            // IDENTITY GOES STRAIGHT TO ITS KERNEL. There is no LUT to route
            // through, and without this it would fall into the generic
            // per-pixel pipeline walk below -- correct, but orders of
            // magnitude slower for what is a memcpy with alpha handling.
            //
            // This is what the bound closure used to be for. It is a direct
            // call now because kernels[0] has an array() like every other
            // kernel; the preamble it needs is its own.
            if(this.isIdentity && this.kernel){
                return this.kernel.array(inputArray, outputArray, pixelCount, this.lut,
                                         inputHasAlpha, outputHasAlpha, preserveAlpha);
            }

            if((this.dataFormat === 'int8' || this.dataFormat === 'int16') && this.lut !== false){
                return this.transformArrayViaLUT(inputArray, inputHasAlpha, outputHasAlpha, preserveAlpha, pixelCount, outputArray);
            }

            if(this.dataFormat === 'object' || this.dataFormat === 'objectFloat'){
                throw 'forwardArray can only be used with int8 or int16 dataFormat';
            }

            if(preserveAlpha && !inputHasAlpha){
                throw 'preserveAlpha is true but inputArray has no alpha channel';
            }

            if(preserveAlpha === undefined){
                preserveAlpha = outputHasAlpha && inputHasAlpha;
            }

            // A CLAIMING KERNEL TOOK THIS TRANSFORM AT create(). It has no LUT
            // to walk — that is why it claimed — so it is dispatched here,
            // ahead of the generic per-pixel loops below, which walk the
            // pipeline stage by stage at ~8 MPx/s.
            //
            // The only claiming kernel today is the matrix shaper, at 331
            // MPx/s and within 1 LSB of those same loops. It builds its tables
            // LAZILY on this first call — 3-8 ms — so a Transform that only
            // ever converts single colours never pays for them.
            //
            // A null return means it declined after all, which claims() should
            // have prevented; falling through is the safe answer rather than
            // stranding the caller.
            if(this.kernel && this.kernel.claimed === true && this._pixelCacheData === null){
                var claimedOut = this.kernel.array(inputArray, outputArray, pixelCount,
                    null, inputHasAlpha, outputHasAlpha, preserveAlpha);
                if(claimedOut) return claimedOut;
            }

            // A pixel cache makes the per-pixel walks below wrong: they
            // increment blindly, so they would re-run the maths on a value a
            // cache hit had already resolved. Handled by a separate generic
            // implementation rather than a branch inside these loops — that
            // branch measured ~2.5% on the uncached accuracy path, and
            // cache-off must pay nothing. Keep the loops below byte-identical.
            if(this._pixelCacheData !== null){
                return this._transformArrayCached(inputArray, inputHasAlpha, outputHasAlpha,
                    preserveAlpha, pixelCount, outputFormat);
            }

            var pipeline = this.pipeline;
            var pipeLen = pipeline.length;
            var result;
            var s, o, i;
            var inputPos = 0;
            var outputPos = 0;
            var inputChannels;
            var outputChannels ;
            var inputItemsPerPixel;
            var outputItemsPerPixel;
            var outputArray;


            if(this.dataFormat === 'object' || this.dataFormat === 'objectFloat'){
                if(pixelCount === undefined){
                    pixelCount = inputArray.length;
                }
                outputArray = new Array(pixelCount);

                // Array of objects, so keep it simple
                for(i = 0; i < pixelCount; i++){
                    result = inputArray[i];
                    for(s = 0; s < pipeLen; s++){
                        result = pipeline[s].funct.call(this, result, pipeline[s].stageData, pipeline[s]);
                    }
                    outputArray[i] = result;
                }
                return outputArray;
            }

            inputChannels = this.inputChannels;
            outputChannels = this.outputChannels;
            inputItemsPerPixel = inputHasAlpha ? this.inputChannels + 1 :  this.inputChannels;
            // AN ALPHA SLOT IS WRITTEN WHEN preserveAlpha OR outputHasAlpha --
            // preserved from the input in the first case, filled with opaque in
            // the second. This used to size on preserveAlpha alone, so a
            // "fill" conversion (outputHasAlpha true, preserveAlpha false)
            // under-allocated by one element per pixel.
            //
            // It went unnoticed because this path handed back an untyped
            // Array, and writing past the end of one silently GROWS it. The
            // moment the allocation became a Uint8ClampedArray the same writes
            // were dropped on the floor and the reads came back undefined --
            // which is how a latent bug in the sizing surfaced as NaN in a
            // matrix-shaper alpha test.
            outputItemsPerPixel = this.outputChannels
                + ((preserveAlpha || outputHasAlpha) ? 1 : 0);

            if(pixelCount === undefined){
                pixelCount = Math.floor(inputArray.length / inputItemsPerPixel);
            }

            switch(outputFormat){
                case 'int8':
                    outputArray = new Uint8ClampedArray(pixelCount * outputItemsPerPixel);
                    break;
                case 'int16':
                    outputArray = new Uint16Array(pixelCount * outputItemsPerPixel);
                    break;
                case 'float32':
                    outputArray = new Float32Array(pixelCount * outputItemsPerPixel);
                    break;
                case 'float64':
                    outputArray = new Float64Array(pixelCount * outputItemsPerPixel);
                    break;
                case 'same':
                    // get input array type
                    var inputArrayType = inputArray.constructor.name;
                    switch(inputArrayType){
                        case 'Uint8Array':
                            outputArray = new Uint8ClampedArray(pixelCount * outputItemsPerPixel);
                            break;
                        case 'Uint16Array':
                            outputArray = new Uint16Array(pixelCount * outputItemsPerPixel);
                            break;
                        case 'Float32Array':
                            outputArray = new Float32Array(pixelCount * outputItemsPerPixel);
                            break;
                        case 'Float64Array':
                            outputArray = new Float64Array(pixelCount * outputItemsPerPixel);
                            break;
                        default:
                            throw 'Unknown inputArray type ' + inputArrayType;
                    }
                    break;
                default:
                    // outputFormat IS DEPRECATED, so undefined is the normal
                    // case -- and it used to land here and hand back an
                    // untyped Array while the LUT path handed back a
                    // Uint8ClampedArray. Which container you got depended on
                    // whether a LUT happened to be built, and the untyped one
                    // has no .subarray() and cannot go straight into ImageData.
                    //
                    // dataFormat is the contract: it is what create() was told
                    // and what the LUT path already allocates from. Several
                    // tests asserted toBeInstanceOf(Array) on this route --
                    // written against the observed behaviour rather than a
                    // decision -- and were updated with it.
                    //
                    // ONLY the integer formats become typed. See below.
                    outputArray =
                          (this.dataFormat === 'int8')  ? new Uint8ClampedArray(pixelCount * outputItemsPerPixel)
                        : (this.dataFormat === 'int16') ? new Uint16Array(pixelCount * outputItemsPerPixel)
                        // 'device' and the float formats carry 0..1 values. A
                        // Uint8ClampedArray would round every one of them to 0
                        // or 1 and destroy the data, so these stay untyped --
                        // and lutbuilder.tests.js asserts exactly that.
                        : new Array(pixelCount * outputItemsPerPixel);
            }



            switch(inputChannels){
                case 1:
                    for(i = 0; i < pixelCount; i++){
                        result = [inputArray[inputPos++]]
                        // loop though stages in the pipeline, result is updated every step
                        // This is NOT looping over pixels in an image, but looping over the stages in the pipeline
                        for(s = 0; s < pipeLen; s++){
                            result = pipeline[s].funct.call(this, result, pipeline[s].stageData, pipeline[s]);
                        }
                        for(o = 0; o < outputChannels; o++){
                            outputArray[outputPos++] = result[o];
                        }
                        if(preserveAlpha) {
                            outputArray[outputPos++] = inputArray[inputPos++];
                        } else {
                            if(inputHasAlpha)  { inputPos++;  }
                            if(outputHasAlpha) {
                                outputArray[outputPos++] = 255;
                            }
                        }
                    }
                    break;
                case 2:
                    for(i = 0; i < pixelCount; i++){
                        result = [
                            inputArray[inputPos++],
                            inputArray[inputPos++],
                        ]
                        for(s = 0; s < pipeLen; s++){
                            result = pipeline[s].funct.call(this, result, pipeline[s].stageData, pipeline[s]);
                        }
                        for(o = 0; o < outputChannels; o++){
                            outputArray[outputPos++] = result[o];
                        }
                        if(preserveAlpha) {
                            outputArray[outputPos++] = inputArray[inputPos++];
                        } else {
                            if(inputHasAlpha)  { inputPos++;  }
                            if(outputHasAlpha) {
                                outputArray[outputPos++] = 255;
                            }
                        }
                    }
                    break;
                case 3:
                    for(i = 0; i < pixelCount; i++){
                        result = [
                            inputArray[inputPos++],
                            inputArray[inputPos++],
                            inputArray[inputPos++],
                        ]
                        for(s = 0; s < pipeLen; s++){
                            result = pipeline[s].funct.call(this, result, pipeline[s].stageData, pipeline[s]);
                        }
                        for(o = 0; o < outputChannels; o++){
                            outputArray[outputPos++] = result[o];
                        }
                        if(preserveAlpha) {
                            outputArray[outputPos++] = inputArray[inputPos++];
                        } else {
                            if(inputHasAlpha)  { inputPos++;  }
                            if(outputHasAlpha) {
                                outputArray[outputPos++] = 255;
                            }
                        }
                    }
                    break;
                case 4:
                    for(i = 0; i < pixelCount; i++){
                        result = [
                            inputArray[inputPos++],
                            inputArray[inputPos++],
                            inputArray[inputPos++],
                            inputArray[inputPos++],
                        ]
                        for(s = 0; s < pipeLen; s++){
                            result = pipeline[s].funct.call(this, result, pipeline[s].stageData, pipeline[s]);
                        }
                        for(o = 0; o < outputChannels; o++){
                            outputArray[outputPos++] = result[o];
                        }
                        if(preserveAlpha) {
                            outputArray[outputPos++] = inputArray[inputPos++];
                        } else {
                            if(inputHasAlpha)  { inputPos++;  }
                            if(outputHasAlpha) {
                                outputArray[outputPos++] = 255;
                            }
                        }
                    }
                    break;

                default:
                    // 5 TO 15 CHANNELS. There was no default here, and no
                    // throw either: an n-channel transformArray() allocated an
                    // output of the right length, filled none of it, and
                    // returned an array of `undefined`. Silently, for every
                    // input width the engine advertises N-channel support for.
                    //
                    // Nothing caught it because nothing could: there were no
                    // 5-to-15-channel profiles to test with until this engine
                    // could write its own. The first n-channel oracle run
                    // found it on the first profile.
                    //
                    // A loop rather than more unrolled cases: this is the
                    // accuracy path, one pixel at a time through the whole
                    // pipeline, and eleven more copies of the same body would
                    // buy nothing measurable against that.
                    for(i = 0; i < pixelCount; i++){
                        result = new Array(inputChannels);
                        for(o = 0; o < inputChannels; o++){
                            result[o] = inputArray[inputPos++];
                        }
                        for(s = 0; s < pipeLen; s++){
                            result = pipeline[s].funct.call(this, result, pipeline[s].stageData, pipeline[s]);
                        }
                        for(o = 0; o < outputChannels; o++){
                            outputArray[outputPos++] = result[o];
                        }
                        if(preserveAlpha) {
                            outputArray[outputPos++] = inputArray[inputPos++];
                        } else {
                            if(inputHasAlpha)  { inputPos++;  }
                            if(outputHasAlpha) {
                                outputArray[outputPos++] = 255;
                            }
                        }
                    }
            }
            return outputArray;
        };

        /**
         *
         * @param {number} intent
         * @returns {*}
         */
        intent2LUTIndex(intent){
            // Absolute maps to relative LUT
            var LUTMap = [ eIntent.perceptual, eIntent.relative , eIntent.saturation , eIntent.relative ];
            return LUTMap[intent];
        };

        intent2String(intent){
            return ['perceptual', 'relative' ,'saturation' ,'relative'][intent] || ('unknown ' + intent);
        };

        chainInfo(){
            var chainStr = '--------- PROFILE CHAIN ---------\n';
            for(var i = 0; i < this.chain.length; i++){
                if(this.chain[i] instanceof Profile){
                    chainStr += 'Profile: ' + this.chain[i].name + '\n';
                } else {
                    chainStr += 'Intent: ' + this.intent2String(this.chain[i]) + '\n';
                }
            }
            return chainStr;
        }

        historyInfo(){
            var tabWidth = 0;
            var history = ['--------- PIPELINE HISTORY ---------'];
            var i;

            // calculate the tab width
            for(i = 0; i < this.debugHistory.length; i++) {
                if(this.debugHistory[i].indexOf('|') > tabWidth){
                    tabWidth = this.debugHistory[i].indexOf('|');
                }
            }

            for(i = 0; i < this.debugHistory.length; i++) {
                var arr = this.debugHistory[i].split('|');
                if(arr.length > 1){
                    arr[0] = (arr[0] + ' . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .').substring(0,tabWidth) + ' ';
                    arr[1] = arr[1].trim();
                }
                history.push(arr.join(''));
            }

            return history.join('\n');
        }

        optimiseInfo = function(){
            return this.optimiseDebug.join('\n');
        }

        debugInfo (){
            return this.chainInfo() + '\n\n' +
                this.optimiseInfo()  + '\n\n' +
                this.getStageNames(true, false) +
                (this.pipelineDebug ? '\n\n' + this.historyInfo() : '');
        };

        /**
         *
         * @param {boolean=} includeInputsAndOutputs - include the input and output encoding in the stage name
         * @param {boolean=} includeDebugFormat - include the debug format with the actual values in the stage name
         * @returns {string}
         */
        getStageNames(includeInputsAndOutputs, includeDebugFormat){
            var stageNames = [];
            var stageName;

            for(var i = 0; i < this.pipeline.length; i++){
                if(includeInputsAndOutputs && this.pipeline[i].inputEncoding !== false ){
                    stageName = encodingStr[this.pipeline[i].inputEncoding] + ' > ' + this.pipeline[i].stageName + ' > ' + encodingStr[this.pipeline[i].outputEncoding];
                } else {
                    stageName = this.pipeline[i].stageName;
                }

                if(includeDebugFormat){
                    stageName += ' ' +  this.pipeline[i].debugFormat
                }

                stageNames.push(i + ': ' + stageName);

            }
            return stageNames.join('\n');
        };

        /**
         *
         *
         * @param {object[]} profileChain
         * @param {boolean} convertInput
         * @param {boolean} convertOutput
         * @param {boolean} useCahcedLut
         * @returns {*}
         */
        createPipeline(profileChain, convertInput , convertOutput, useCahcedLut){

            this.pipeline = [];
            // Drop any cache from a previous create() on this instance — a
            // stale handle would send transform() down the step-based walk
            // over stages that never got a `step`.
            this._pixelCacheData = null;
            var chainEnd = profileChain.length - 1;


            // pcsInfo is used to keep track of the current encoding
            // and PCS space as we move through the pipeline
            //
            var pcsInfo = {
                /** @type {{pcsEncoding: null | stageEncoding}} */
                pcsEncoding: null,
            };

            if(this.pipelineDebug){
                this.addStage(false,'Start', this.stage_debug, '[PipeLine Input]| {data}', false );
            }

            ////////////////////////////////////////////////////////////////////
            //
            //  Step 1 - Convert from lab/rgb/cmyk objects to device encoding 0.0-1.0
            //  This is a unique feature of this library, as most other libraries
            //  will only handle 8bit or 16bit integer data.
            //

            //START!
            if(convertInput && this.dataFormat !== 'device'){
                if(!useCahcedLut){
                    this.insertCustomStage('beforeInput2Device', pcsInfo, false);
                }

                // Convert from the input cmsLab / cmsRGB / cmsCMYK to Device
                this.createPipeline_Input_to_Device(pcsInfo, profileChain[0]);
            } else {
                // When using dataFormat='device' we do not need to convert from input to device
                pcsInfo.pcsEncoding = this.getInput2DevicePCSInfo(profileChain[0]);
            }


            ////////////////////////////////////////////////////////////////////
            //
            //  If using the LUT crt the LUT only pipeline
            //
            if(useCahcedLut){
                // Use prebuilt cached LUT - Faster but less accurate
                if(this.lut === false){
                    throw 'No LUT';
                }

                if(!Array.isArray(this.lut.chain)){
                    throw 'LUT has no profile chain';
                }

                // A DeviceLink bakes a single-profile chain — input and
                // output resolve to the same (link) profile below.
                if(this.lut.chain.length < 1){
                    throw 'LUT chain is too short';
                }

                // Get the input and output profiles from the LUT Chain
                var lutInputProfile = this.lut.chain[0];
                var lutOutputProfile = this.lut.chain[this.lut.chain.length - 1];

                if(!(lutInputProfile.hasOwnProperty('header') && lutInputProfile.hasOwnProperty('name'))){
                    throw 'LUT Chain does not start with a profile';
                }

                if(!(lutOutputProfile.hasOwnProperty('header') && lutOutputProfile.hasOwnProperty('name'))){
                    throw 'LUT Chain does not end with a profile';
                }

                this.createPipeline_Device_to_Device_via_LUT(pcsInfo, lutInputProfile, lutOutputProfile)

            } else {

                ////////////////////////////////////////////////////////////////////////
                //
                //   Link the profile chain, here we are linking the profiles together
                //   into one large pipeline, this is where the color conversion happens
                //   Note: each step in the chain it should start and end with
                //   pcsInfo.pcsEncoding = encoding.device
                //

                var stageIndex = 0;

                // DeviceLink — single-profile chain, device→device via the
                // A2B tag directly, no PCS. The pair-linking loop below
                // naturally no-ops for a length-1 chain.
                if(profileChain.length === 1 && profileChain[0].header.pClass === 'link'){
                    this.createPipeline_DeviceLink(pcsInfo, profileChain[0]);
                }

                // [p1, intent, p2, intent, p3]
                // Calculate DeltaE [lab > perceptual > CMYK > relative > lab]
                // Simulate CMYK  [srgb > perceptual > CMYK > relative > srgb]
                for(var i = 0; i < profileChain.length - 1; i+=2){
                    var step = {
                        inputProfile: profileChain[i],
                        intent: profileChain[i+1],
                        outputProfile: profileChain[i+2],
                    }

                    this.insertCustomStage( 'beforeDevice2PCS', pcsInfo, stageIndex);

                    ///////////////////////////////////////////////////////////////////////////////
                    //
                    // Step 2: Convert from Device[] to PCSv4[]
                    //
                    // Note if the input profile PCS is XYZ, it will be converted to PCSv4
                    // If the output profile is also XYZ, then the optimiser will clean up
                    //
                    this.createPipeline_Device_to_PCS(pcsInfo, step.inputProfile, step.outputProfile, step.intent);

                    this.insertCustomStage( 'afterDevice2PCS', pcsInfo , stageIndex);

                    ///////////////////////////////////////////////////////////////////////////////
                    //
                    // Step 3: Apply Black Point Compensation to the PCS, by scaling in XYZ space
                    //
                    // - BPC does not apply to devicelink profiles (PCS not XYZ or Lab)
                    // - BPC does not apply to absolute colorimetric intent
                    // - BPC applies always on V4 perceptual and saturation intents
                    //
                    if(pcsInfo.pcsEncoding === encoding.PCSXYZ || pcsInfo.pcsEncoding === encoding.PCSv4 || pcsInfo.pcsEncoding === encoding.PCSv2) {
                        var useBPC
                        if(Array.isArray(this.useBPC)){
                            useBPC = this.useBPC[stageIndex];
                        } else {
                            useBPC = this.useBPC;
                        }

                        if (this._BPCAutoEnable) {
                            switch (step.intent) {
                                case eIntent.saturation:
                                case eIntent.perceptual:
                                    //BPC applies always on V4 perceptual and saturation intents
                                    if (step.inputProfile.version === 4 || step.outputProfile.version === 4) {
                                        useBPC = true;
                                    }

                                    //If gray TRC profile force BPC on to replicate LCMS Behavor
                                    if (this.isGreyTRCwithNOLUT(step.inputProfile, step.intent)) {
                                        useBPC = true;
                                    }

                                    break;
                                case eIntent.absolute:
                                    //BPC does not apply to absolute colorimetric intent
                                    useBPC = false;
                            }
                        }

                        if (useBPC) {
                            this.createPipeline_BlackPointCompensation(pcsInfo, step.inputProfile, step.outputProfile, step.intent);
                        }

                        this.insertCustomStage( 'PCS', pcsInfo, stageIndex);

                        //
                        // Add Chromatic Adaptation is required
                        //
                        this.createPipeline_chromaticAdaptation(pcsInfo, step.inputProfile, step.outputProfile, step.intent);
                    }

                    this.insertCustomStage( 'beforePCS2Device', pcsInfo, stageIndex);

                    ///////////////////////////////////////////////////////////////////////////////
                    //
                    // Step 4: Convert from the PCSv4[] to Device[]
                    //
                    // If the output profiles PCS is XYZ, then the PCSv4 will be converted to XYZ
                    //
                    this.createPipeline_PCS_to_Device(pcsInfo, step.inputProfile, step.outputProfile, step.intent);

                    this.insertCustomStage( 'afterPCS2Device', pcsInfo, stageIndex);

                    stageIndex++;
                }
            }

            ///////////////////////////////////////////////////////////////////////////////
            //
            // Step 5: Convert from device encoding 0.0-1.0 to output lab/rgb/cmyk/int8 etc
            //
            var pixelCacheOutputAt = this.pipeline.length;

            if(convertOutput && this.dataFormat !== 'device'){
                // Convert from Output Device to outputFormat i.e cmsRGB / cmsLab
                this.createPipeline_Device_to_Output(pcsInfo, profileChain[chainEnd]);

                if(!useCahcedLut) {
                    this.insertCustomStage( 'afterDevice2Output', pcsInfo, false);
                }
            }

            // Pixel-cache boundary marker: the FIRST stage of the output
            // conversion, held as a stage REFERENCE because optimisePipeline()
            // shifts every index. The first output stage is used rather than
            // the last maths stage because no optimiser pattern matches
            // stage_device_to_*, so this reference always survives — whereas
            // the maths boundary is routinely consumed by a fusion (e.g.
            // LabD50_to_PCSv4 + PCSv4_to_PCSXYZ collapse, and the PCSv4
            // position between them stops existing).
            if(this.pixelCache){
                this._pcOutputFirst = (pixelCacheOutputAt < this.pipeline.length)
                    ? this.pipeline[pixelCacheOutputAt] : null;
            }

            if(this.pipelineDebug){
                this.addStage(false, 'END', this.stage_debug, '[PipeLine Output]| {data}', false);
            }

            if(this.optimise){
                // merge stages that can be merged
                this.optimisePipeline();
            }

            // After the optimiser (so the cache stages cannot be folded into a
            // neighbour, and so the positions it finds are final) and before
            // verifyPipeline (so the injected device->device encodings are
            // still checked rather than silently trusted).
            if(this.pixelCache){
                this.injectPixelCacheStages();
            }

            // Ensure pipeline is valid by checking that the output of one stage matches the input of the next
            this.verifyPipeline();
        };


        verifyPipeline(){
            var len = this.pipeline.length - 1;
            for(var i = 0; i < len; i++){
                // info stages are just false
                if(this.pipeline[i].outputEncoding !== false && this.pipeline[i+1].inputEncoding !== false){

                    if(typeof this.pipeline[i].funct !== 'function'){
                        throw 'No Function on stage @ ' + i + ' ' + this.pipeline[i].stageName;
                    }

                    if(this.pipeline[i].outputEncoding !== this.pipeline[i+1].inputEncoding){
                        console.log(this.getStageNames(true, true));
                        throw ('Incompatible Stages @ Stage ' + i + ' (' + this.pipeline[i].stageName + ' ' + encodingStr[this.pipeline[i].outputEncoding] + ' > ' + encodingStr[this.pipeline[i+1].inputEncoding] + ' ' + this.pipeline[i+1].stageName + ')');
                    }
                }
            }
        };

        optimisePipeline() {
            var _this = this;
            var Opt = true;
            var startLength = this.pipeline.length;
            var beforePipeline = this.getStageNames();

            var interp3DList = [
                'linearInterp1D',
                'bilinearInterp2D',
                'trilinearInterp3D',
                'tetrahedralInterp3D',
                'trilinearInterp4D',
                'tetrahedralInterp4D',
            ]

            while (Opt === true){
                Opt = false;

                // remove un-necessary conversion
                Opt |= this.optimiseFindPattern('stage_null', false, function(stage1, stage2, stage0){

                    // Stage Nulls are used to keep track of the input and output encoding
                    // so we need to update the input and output encoding of the next stage
                    stage0.outputEncoding = stage2.inputEncoding;
                    stage0.stageName += ' >> ALIAS ' + encodingStr[stage2.inputEncoding];
                    stage0.optimised = true;

                    // Still need to keep stage 2
                    return [
                        stage2
                    ];
                });

                // remove un-necessary conversion
                Opt |= this.optimiseFindPattern('stage_LabD50_to_PCSv4', 'stage_PCSv4_to_LabD50', function(){
                    //console.log('FOUND ' + stage1.stageName + ' and '  + stage2.stageName);
                    return [];
                });

                // remove un-necessary conversion
                Opt |= this.optimiseFindPattern('stage_PCSv4_to_LabD50', 'stage_LabD50_to_PCSv4', function(){
                    return [];
                });

                // remove un-necessary conversion
                Opt |= this.optimiseFindPattern('stage_PCSv2_to_PCSv4', 'stage_PCSv4_to_PCSv2', function(){
                    return [];
                });

                // remove un-necessary conversion
                Opt |= this.optimiseFindPattern('stage_PCSv4_to_PCSv2', 'stage_PCSv2_to_PCSv4', function(){
                    return [];
                });

                // remove un-necessary conversion
                Opt |= this.optimiseFindPattern('stage_PCSXYZ_to_PCSv4', 'stage_PCSv4_to_PCSXYZ', function(){
                    return [];
                });





                Opt |= this.optimiseFindPattern('stage_PCSXYZ_to_PCSv4', 'stage_PCSv4_to_PCSv2', function(stage1, stage2){
                    //console.log('FOUND ' + stage1.stageName + ' and '  + stage2.stageName);
                    return [_this.createStage(
                        stage1.inputEncoding,
                        'stage_PCSXYZ_to_PCSv2',
                        _this.stage_PCSXYZ_to_PCSv2,
                        null,
                        stage2.outputEncoding,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )];
                });

                Opt |= this.optimiseFindPattern('stage_LabD50_to_PCSv4', 'stage_PCSv4_to_PCSXYZ', function(stage1, stage2){
                  return [_this.createStage(
                        stage1.inputEncoding,
                        'stage_LabD50_to_PCSXYZ',
                        _this.stage_LabD50_to_PCSXYZ,
                        null,
                        stage2.outputEncoding,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )];
                });




                Opt |= this.optimiseFindPattern('stage_PCSv2_to_PCSv4', 'stage_PCSv4_to_cmsLab', function(stage1, stage2){
                    //console.log('FOUND ' + stage1.stageName + ' and '  + stage2.stageName + ' Replacing with stage_PCSv2_to_cmsLab');
                    return [_this.createStage(
                        stage1.inputEncoding,
                        'stage_PCSv2_to_cmsLab',
                        _this.stage_PCSv2_to_cmsLab,
                        null,
                        stage2.outputEncoding,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )];
                });

                // Simplify conversion to one step
                Opt |= this.optimiseFindPattern('stage_LabD50_to_PCSv2', 'stage_PCSv2_to_PCSv4', function(stage1, stage2){
                    //console.log('FOUND ' + stage1.stageName + ' and '  + stage2.stageName + ' Replacing with stage_LabD50_to_PCSv4');
                    return [_this.createStage(
                        stage1.inputEncoding,
                        'stage_LabD50_to_PCSv4',
                        _this.stage_LabD50_to_PCSv4,
                        null,
                        stage2.outputEncoding,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )];
                });

                // Simplify conversion to one step
                Opt |= this.optimiseFindPattern('stage_LabD50_to_PCSv4', 'stage_PCSv4_to_PCSv2', function(stage1, stage2){
                    //console.log('FOUND ' + stage1.stageName + ' and '  + stage2.stageName + ' Replacing with stage_LabD50_to_PCSv2');
                    return [_this.createStage(
                        stage1.inputEncoding,
                        'stage_LabD50_to_PCSv2',
                        _this.stage_LabD50_to_PCSv2,
                        null,
                        stage2.outputEncoding,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )];
                });

                Opt |= this.optimiseFindPattern('stage_LabD50_to_PCSv4', 'stage_PCSv4_to_cmsLab', function(stage1, stage2){
                    //console.log('FOUND ' + stage1.stageName + ' and '  + stage2.stageName + ' Replacing with stage_LabD50_to_cmsLab');
                    return [_this.createStage(
                        stage1.inputEncoding,
                        'stage_LabD50_to_cmsLab',
                        _this.stage_LabD50_to_cmsLab,
                        null,
                        stage2.outputEncoding,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )];
                });

                // Simplify conversion to one step
                Opt |= this.optimiseFindPattern('stage_LabD50_to_PCSv2', 'stage_PCSv2_to_cmsLab', function(stage1,stage2){
                    //console.log('FOUND ' + stage1.stageName + ' and '  + stage2.stageName + ' Replacing with stage_LabD50_to_cmsLab');
                    return [_this.createStage(
                        stage1.inputEncoding,
                        'stage_LabD50_to_cmsLab',
                        _this.stage_LabD50_to_cmsLab,
                        null,
                        stage2.outputEncoding,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )];
                });


                Opt |= this.optimiseFindPattern('stage_matrix_rgb', 'stage_matrix_rgb', function(stage1,stage2){

                    // We need to scale the input down to PCSXYZ encoding to XYZ
                    var inputMatrix_PCSXYZ = stage1.stageData;

                    // And scale the output back from XYZ to PCSXYZ
                    var outputMatrixInv_PCSXYZ = stage2.stageData;

                    // Combine the matrices
                    var combinedRGB_to_RGB_matrix = convert.multiplyMatrices(outputMatrixInv_PCSXYZ, inputMatrix_PCSXYZ);

                    return [_this.createStage(
                        stage1.inputEncoding,
                        'stage_matrix_rgb',
                        _this.stage_matrix_rgb,
                        combinedRGB_to_RGB_matrix,
                        stage2.outputEncoding,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )];
                });

                for(var i = 0; i < interp3DList.length; i++){
                    var interpND = interp3DList[i];
                    // Simplify Int to LUT, we can use the LUT's inputscale directly instead of converting to device
                    Opt |= this.optimiseFindPattern('stage_Int_to_Device', interpND, function(stage1,stage2){
                        var lut = stage2.stageData;
                        var intValue = stage1.stageData; // 255 or 65535
                        lut.inputScale = 1 / intValue;
                        return [_this.createStage(
                            stage1.inputEncoding,
                            interpND,
                            stage2.funct,
                            lut,
                            stage2.outputEncoding,
                            '  *[optimised : {name}]|({last}) > ({data})',
                            true
                        )];
                    });

                    // We can use the LUT's output directly instead of
                    // This only saves a few multiplications and if statements, so not much of a saving
                    Opt |= this.optimiseFindPattern(interpND, 'stage_device_to_int', function(stage1,stage2){
                        var lut = stage1.stageData;
                        var intValue = stage2.stageData; // 255 or 65535

                        lut.outputScale = lut.outputScale * intValue;
                        if(lut.outputScale > 0.99 && lut.outputScale < 1.01){
                            //rounding errors
                            // 1 / 255 * 65535 / 255 = 1.007843137254902
                            // 1 / 65535 * 255 * 255 = 0.9922178988326849
                            lut.outputScale = 1;
                        }

                        var deviceToIntFunctionName = 'stage_device' + lut.outputChannels + '_to_int';

                        return [
                            _this.createStage(
                                stage1.inputEncoding,
                                interpND,
                                stage1.funct,
                                lut,
                                stage2.outputEncoding,
                                '  *[optimised : {name}]|({last}) > ({data})',
                                true
                            ),
                            _this.createStage(
                                stage2.outputEncoding,
                                deviceToIntFunctionName,
                                _this[deviceToIntFunctionName],
                                1,
                                stage2.outputEncoding,
                                '  *[optimised : {name}]|({last}) > ({data})',
                                true
                            )
                        ];
                    });
                }
            }

            this.optimiseDebug = [
                '==========================================================================================',
                '** OPTIMISED PIPELINE - REMOVED ' + (startLength - this.pipeline.length) + ' STAGES **',
                'BEFORE OPTIMISE\n' + beforePipeline,
                '------------------------------------------------------------------------------------------',
                'AFTER OPTIMISE\n' + this.getStageNames(),
                '==========================================================================================',
            ];
        };

        /**
         *
         * @param {string} stageName1
         * @param {string|false} StageName2
         * @param {function} replaceFunction
         * @returns {boolean}
         */
        optimiseFindPattern(stageName1, StageName2, replaceFunction){
            for(var i = 0; i < this.pipeline.length - 1; i++){
                if(this.pipeline[i].stageName === stageName1 && (this.pipeline[i+1].stageName === StageName2 || StageName2 === false)  ){
                    var previous = (i > 1) ? this.pipeline[i-1] : false;
                    var next = this.pipeline[i+1];

                    var insert = replaceFunction(this.pipeline[i],next, previous);

                    // Remove the section and insert the replacement stages
                    var first = this.pipeline.slice(0,i);
                    var last = this.pipeline.slice(i+2);
                    this.pipeline = first.concat(insert, last);
                    // we have to exit and try again later as we are out of sync
                    return true;
                }
            }
            return false;
        };

        /**
         * Create a simplified pipeline using only the LUT
         * Note that in the optimise path, if we are converting init8 and int16 we can use the LUT directly
         * and optimise out the conversion stages
         * @param pcsInfo
         * @param inputProfile
         * @param outputProfile
         */
        createPipeline_Device_to_Device_via_LUT(pcsInfo, inputProfile, outputProfile){
            if(!this.lut){
                throw 'No LUT';
            }

            switch(this.lut.inputChannels){

                case 1: // Gray
                    this.addStageLUT(
                        false,
                        this.getInput2DevicePCSInfo(inputProfile),
                        this.lut,
                        this.getDevice2OutputPCSInfo(outputProfile),
                        '  [Prebuilt LUT1D : {name}]|({last}) > ({data})'
                    );
                    break;

                case 2: // DuoTone
                    this.addStageLUT(
                        false,
                        this.getInput2DevicePCSInfo(inputProfile),
                        this.lut,
                        this.getDevice2OutputPCSInfo(outputProfile),
                        '  [Prebuilt LUT2D : {name}]|({last}) > ({data})'
                    );
                    break;

                case 3: // RGB or Lab
                    this.addStageLUT(
                        false,
                        this.getInput2DevicePCSInfo(inputProfile),
                        this.lut,
                        this.getDevice2OutputPCSInfo(outputProfile),
                        '  [Prebuilt LUT3D : {name}]|({last}) > ({data})'
                    );
                    break;

                case 4: // CMYK
                    this.addStageLUT(
                        false,
                        this.getInput2DevicePCSInfo(inputProfile),
                        this.lut,
                        this.getDevice2OutputPCSInfo(outputProfile),
                        ' [Prebuilt LUT4D : {name}]|({last}) > ({data})'
                    );
                    break;
                default:
                    throw 'Can not use Prebuilt LUT - Unknown LUT inputChannels ' + this.lut.inputChannels;
            }

            pcsInfo.pcsEncoding = this.getDevice2OutputPCSInfo(outputProfile);
        }


        /**
         * @param pcsInfo
         * @param {Profile} inputProfile
         * @returns {*}
         */
        createPipeline_Input_to_Device(pcsInfo, inputProfile){
            switch(inputProfile.type){

                /////////////////////////////////////////////////////////////////////////////////////////////////

                case eProfileType.XYZ:
                    this.addStage(
                        encoding.cmsXYZ,
                        'stage_XYZ_to_PCSXYZ',
                        this.stage_XYZ_to_PCSXYZ,
                        null,
                        encoding.PCSXYZ,
                        '  [Input2Device : XYZ : {name}]|({last}) > ({data})'
                    );
                    pcsInfo.pcsEncoding = encoding.PCSXYZ;
                    break;
                case eProfileType.Lab:
                    // Convert the input Lab to the inputput Profile whitePoint

                    // ARRAY ENTRY POINT, mirroring what the device branch has
                    // had all along. Without this a Lab source on the LUT-free
                    // pipeline could not take an array at all: the stages below
                    // want objects, so a bare triple threw (labInputAdaptation
                    // on) or fell through to NaN (off). The device branch picks
                    // an entry stage per dataFormat a few cases down; Lab now
                    // does the same.
                    //
                    // An array is taken as ALREADY PCS-ENCODED FOR THIS
                    // PROFILE'S VERSION — see stage_Int_to_cmsLab. Objects pass
                    // straight through it, so nothing that worked before
                    // changes, including validateOnCreate and the LUT builder.
                    if(this.dataFormat === 'int8' || this.dataFormat === 'int16' ||
                       this.dataFormat === 'device'){
                        var labEnc = convert.labEncoding[
                            this.inputProfile.version === 2 ? 'v2' : 'v4'];
                        var labMaxIn = (this.dataFormat === 'int8')  ? 255
                                     : (this.dataFormat === 'int16') ? labEnc.labNumerator
                                     : 1;
                        this.addStage(
                            encoding.cmsLab,
                            'stage_Int_to_cmsLab',
                            this.stage_Int_to_cmsLab,
                            {mul: labEnc.labNumerator / labMaxIn, enc: labEnc},
                            encoding.cmsLab,
                            '  [Input2Device : Lab : {name}]|({last}) > ({data})'
                        );
                    }

                    if(this.labInputAdaptation){
                        //
                        // Make sure that the input Lab is adapted to the PCS white point (D50)
                        // The lab values MUST have a whitepoint included or else will throw an error
                        // This allows you to use a Lab value with a whitepoint other than D50
                        //
                        this.addStage(
                            encoding.cmsLab,
                            'stage_cmsLab_to_LabD50',
                            this.stage_cmsLab_to_LabD50,
                            null,
                            encoding.LabD50,
                            '  [Input2Device : Lab : {name}]| ({last}) > ({data})'
                        );

                        this.addStage(
                            encoding.LabD50,
                            'stage_LabD50_to_PCSv4',
                            this.stage_LabD50_to_PCSv4,
                            null,
                            encoding.PCSv4,
                            '  [Input2Device : Lab : {name}]|({last}) > ({data})'
                        );
                    } else {

                        this.addStage(
                            encoding.cmsLab,
                            'stage_LabD50_to_PCSv4',
                            this.stage_LabD50_to_PCSv4,
                            null,
                            encoding.PCSv4,
                            '  [Input2Device : Lab : {name}]|({last}) > ({data})'
                        );
                    }

                    pcsInfo.pcsEncoding = encoding.PCSv4;

                    break;

                /////////////////////////////////////////////////////////////////////////////////////////////////
                case eProfileType.RGBMatrix:
                    // Convert inputs to device array with range of 0.0 to 1.0
                    pcsInfo.pcsEncoding = encoding.device;

                    switch (this.dataFormat) {
                        case 'object':
                        case 'objectFloat':
                            this.addStage(
                                encoding.cmsLab,
                                'stage_RGB_to_Device',
                                this.stage_RGB_to_Device,
                                null,
                                pcsInfo.pcsEncoding,
                                '  [Input2Device : RGBMatrix : {name}]|({last}) > ({data})'
                            );
                            break;
                        case 'int8':
                            this.addStage(
                                encoding.cmsLab,
                                'stage_Int_to_Device',
                                this.stage_Int_to_Device,
                                255,
                                pcsInfo.pcsEncoding,
                                '  [int8 to Device : RGBMatrix : {name}]|({last}) > ({data})'
                            );
                            break;
                        case 'int16':
                            this.addStage(
                                encoding.cmsLab,
                                'stage_Int_to_Device',
                                this.stage_Int_to_Device,
                                65535,
                                pcsInfo.pcsEncoding,
                                '  [int16 to Device : RGBMatrix : {name}]|({last}) > ({data})'
                            );
                            break;
                    }
                    break;

                /////////////////////////////////////////////////////////////////////////////////////////////////
                case eProfileType.Gray:

                    pcsInfo.pcsEncoding = encoding.device;
                    switch (this.dataFormat) {
                        case 'object':
                        case 'objectFloat':
                            this.addStage(
                                encoding.cmsRGB,
                                'stage_Gray_to_Device',
                                this.stage_Gray_to_Device,
                                null,
                                pcsInfo.pcsEncoding,
                                '  [Input2Device : Gray : {name}]|({last}) > ({data})'
                            );
                            break;
                        case 'int8':
                            this.addStage(
                                encoding.cmsLab,
                                'stage_Int_to_Device',
                                this.stage_Int_to_Device,
                                255,
                                pcsInfo.pcsEncoding,
                                '  [in8 2Device : Gray : {name}]|({last}) > ({data})'
                            );
                            break;
                        case 'int16':
                            this.addStage(
                                encoding.cmsLab,
                                'stage_Int_to_Device',
                                this.stage_Int_to_Device,
                                65535,
                                pcsInfo.pcsEncoding,
                                '  [in16 2Device : Gray : {name}]|({last}) > ({data})'
                            );
                            break;
                    }
                    break;

                /////////////////////////////////////////////////////////////////////////////////////////////////
                case eProfileType.Duo:

                    pcsInfo.pcsEncoding = encoding.device;
                    switch (this.dataFormat) {
                        case 'object':
                        case 'objectFloat':
                            this.addStage(
                                encoding.cmsRGB,
                                'stage_Duo_to_Device',
                                this.stage_Duo_to_Device,
                                null,
                                pcsInfo.pcsEncoding,
                                '  [Input2Device : Duo : {name}]|({last}) > ({data})'
                            );
                            break;
                        case 'int8':
                            this.addStage(
                                encoding.cmsLab,
                                'stage_Int_to_Device',
                                this.stage_Int_to_Device,
                                255,
                                pcsInfo.pcsEncoding,
                                '  [in8 2Device : Duo : {name}]|({last}) > ({data})'
                            );
                            break;
                        case 'int16':
                            this.addStage(
                                encoding.cmsLab,
                                'stage_Int_to_Device',
                                this.stage_Int_to_Device,
                                65535,
                                pcsInfo.pcsEncoding,
                                '  [in16 2Device : Duo : {name}]|({last}) > ({data})'
                            );
                            break;
                    }
                    break;


                /////////////////////////////////////////////////////////////////////////////////////////////////
                case eProfileType.RGBLut:
                    // Convert inputs to device array with range of 0.0 to 1.0
                    pcsInfo.pcsEncoding = encoding.device;

                    switch (this.dataFormat) {
                        case 'object':
                        case 'objectFloat':
                            this.addStage(
                                encoding.cmsRGB,
                                'stage_RGB_to_Device',
                                this.stage_RGB_to_Device,
                                null,
                                pcsInfo.pcsEncoding,
                                '  [Input2Device : RGBLut : {name}]|({last}) > ({data})'
                            );
                            break;
                        case 'int8':
                            this.addStage(
                                encoding.cmsLab,
                                'stage_Int_to_Device',
                                this.stage_Int_to_Device,
                                255,
                                pcsInfo.pcsEncoding,
                                '  [in8 2Device : RGBLut : {name}]|({last}) > ({data})'
                            );
                            break;
                        case 'int16':
                            this.addStage(
                                encoding.cmsLab,
                                'stage_Int_to_Device',
                                this.stage_Int_to_Device,
                                65535,
                                pcsInfo.pcsEncoding,
                                '  [in16 2Device : RGBLut : {name}]|({last}) > ({data})'
                            );
                            break;
                    }
                    break;

                /////////////////////////////////////////////////////////////////////////////////////////////////
                case eProfileType.CMYK:
                    // Convert inputs to device array with range of 0.0 to 1.0
                    pcsInfo.pcsEncoding = encoding.device;
                    switch (this.dataFormat) {
                        case 'object':
                        case 'objectFloat':
                            this.addStage(
                                encoding.cmsCMYK,
                                'stage_CMYK_to_Device',
                                this.stage_CMYK_to_Device,
                                null,
                                pcsInfo.pcsEncoding,
                                '  [Input2Device : CMYK : {name}]|({last}) > ({data})'
                            );
                            break;
                        case 'int8':
                            this.addStage(
                                encoding.cmsCMYK,
                                'stage_Int_to_Device',
                                this.stage_Int_to_Device,
                                255,
                                pcsInfo.pcsEncoding,
                                '  [in8 2Device : CMYK : {name}]|({last}) > ({data})'
                            );
                            break;
                        case 'int16':
                            this.addStage(
                                encoding.cmsCMYK,
                                'stage_Int_to_Device',
                                this.stage_Int_to_Device,
                                65535,
                                pcsInfo.pcsEncoding,
                                '  [in16 2Device : CMYK : {name}]|({last}) > ({data})'
                            );
                            break;
                    }
                    break;

                /////////////////////////////////////////////////////////////////////////////////////////////////
                case eProfileType.NChannel:
                    // 5CLR-15CLR — input is a plain device array. There is no
                    // named colour object for N channels, so object formats
                    // accept an array (0..1) or a {c0..cN} object.
                    pcsInfo.pcsEncoding = encoding.device;
                    switch (this.dataFormat) {
                        case 'object':
                        case 'objectFloat':
                            this.addStage(
                                encoding.device,
                                'stage_NCh_to_Device',
                                this.stage_NCh_to_Device,
                                null,
                                pcsInfo.pcsEncoding,
                                '  [Input2Device : NChannel : {name}]|({last}) > ({data})'
                            );
                            break;
                        case 'int8':
                            this.addStage(
                                encoding.device,
                                'stage_IntN_to_Device',
                                this.stage_IntN_to_Device,
                                255,
                                pcsInfo.pcsEncoding,
                                '  [in8 2Device : NChannel : {name}]|({last}) > ({data})'
                            );
                            break;
                        case 'int16':
                            this.addStage(
                                encoding.device,
                                'stage_IntN_to_Device',
                                this.stage_IntN_to_Device,
                                65535,
                                pcsInfo.pcsEncoding,
                                '  [in16 2Device : NChannel : {name}]|({last}) > ({data})'
                            );
                            break;
                    }
                    break;
            }
        };

        /**
         * Returns true if this Transform has a prebuilt CLUT (from buildLut:true
         * or setLut()). Identity transforms and non-LUT pipelines return false.
         * Check this before calling toJSON() to avoid the 'no LUT to serialise' throw.
         */
        hasLut() {
            return this.lut !== false && this.lut !== null && this.lut !== undefined;
        }

        /**
         * Identity pipeline stage — shallow-copies the device array to prevent
         * downstream mutation aliasing. Used when isIdentity:true and the format
         * has input/output codec stages bracketing it (int8, int16, device).
         */
        stage_device2device(deviceArray) {
            return deviceArray.slice();
        }

        /**
         * Iteratively remove adjacent equal-profile pairs from the chain.
         * Modifies profileChain in place. Also updates this.useBPC array when
         * BPC is per-stage so removed stages don't shift the remaining indices.
         */
        _collapseIdentityChain(profileChain) {
            var changed = true;
            while(changed){
                changed = false;
                for(var pairIndex = 0; pairIndex < profileChain.length - 2; pairIndex += 2){
                    var leftProfile  = profileChain[pairIndex];
                    var rightProfile = profileChain[pairIndex + 2];
                    if(this._areProfilesTheSame(leftProfile, rightProfile)){
                        var intentSlot = pairIndex / 2;
                        profileChain.splice(pairIndex, 2);
                        if(Array.isArray(this.useBPC)){
                            this.useBPC.splice(intentSlot, 1);
                        }
                        changed = true;
                        break;
                    }
                }
            }
        }

        _areProfilesTheSame(profileA, profileB) {
            return this._areSameType(profileA, profileB)
                && (   this._areSameVirtual(profileA, profileB)
                    || this._areSameHash(profileA, profileB)
                    || this._areSameMatrix(profileA, profileB)
                   );
        }

        _areSameType(profileA, profileB) {
            return profileA.type          === profileB.type
                && profileA.outputChannels === profileB.outputChannels
                && profileA.pcs           === profileB.pcs
                && profileA.version       === profileB.version;
        }

        _areSameVirtual(profileA, profileB) {
            return !!(profileA.virtualName && profileB.virtualName
                   && profileA.virtualName === profileB.virtualName);
        }

        _areSameHash(profileA, profileB) {
            return !!(profileA.binaryHash && profileB.binaryHash
                   && profileA.binaryHash === profileB.binaryHash);
        }

        _areSameMatrix(profileA, profileB) {
            if(profileA.type !== eProfileType.RGBMatrix) return false;
            if(profileB.type !== eProfileType.RGBMatrix) return false;
            var matrixA = profileA.RGBMatrix.XYZMatrix;
            var matrixB = profileB.RGBMatrix.XYZMatrix;
            if(!matrixA || !matrixB) return false;
            var epsilon = 1e-10;
            var matrixKeys = ['m00','m01','m02','m10','m11','m12','m20','m21','m22'];
            for(var keyIndex = 0; keyIndex < matrixKeys.length; keyIndex++){
                var matrixKey = matrixKeys[keyIndex];
                if(Math.abs(matrixA[matrixKey] - matrixB[matrixKey]) > epsilon) return false;
            }
            if(profileA.RGBMatrix.issRGB !== profileB.RGBMatrix.issRGB) return false;
            if(!profileA.RGBMatrix.issRGB){
                if(Math.abs((profileA.RGBMatrix.gamma || 0) - (profileB.RGBMatrix.gamma || 0)) > epsilon) return false;
            }
            return true;
        }

        getProfileChannels(profile){
            switch(profile.type){
                case eProfileType.Gray:
                    return 1;
                case eProfileType.Duo:
                    return 2;
                case eProfileType.XYZ:
                case eProfileType.Lab:
                case eProfileType.RGBMatrix:
                case eProfileType.RGBLut:
                    return 3;
                case eProfileType.CMYK:
                    return 4;
                case eProfileType.NChannel:
                    // 5CLR-15CLR — channel count decoded from the header
                    // space signature (see Profile.decodeFile).
                    return profile.outputChannels;
            }
            throw 'Unknown profile type ' + profile.type + 'in getProfileChannels';
        };

        /**
         * Run a single-pixel smoke test through the current pipeline.
         *
         * Builds a mid-tone test colour in the pipeline's input format, runs it
         * through `transform()` inside a try/catch, and checks the output for
         * NaN / undefined / wrong object type. Returns `true` when the pipeline
         * looks healthy.
         *
         * Called automatically from `createMultiStage()` when `validateOnCreate`
         * is true — before a LUT is built (so a broken profile is caught early)
         * when `buildLut:true`, or after the standard pipeline is built otherwise.
         * Not called when the Transform was supplied a pre-built LUT via `setLut()`
         * / `fromJSON()`.
         *
         * Can also be called by user code at any time after `create()`.
         *
         * @param {string} [formatOverride]  Input/output format to use for the
         *   test colour. Defaults to `this.dataFormat`. Pass `'device'` to test
         *   a device-to-device pipeline (used internally before LUT build).
         * @returns {boolean}  `true` = pipeline produced a valid output;
         *   `false` = transform threw, returned NaN, undefined, or wrong type.
         */
        validatePipeline(formatOverride) {
            if (!this.pipelineCreated) return false;

            var format = (formatOverride !== undefined) ? formatOverride : this.dataFormat;
            var testInput = this._buildValidationInput(format);
            if (testInput === null) return false;

            var result;
            try {
                result = this.transform(testInput);
            } catch (error) {
                return false;
            }

            if (result === null || result === undefined) return false;
            return this._isValidPipelineOutput(result, format);
        }

        /** @private */
        _buildValidationInput(format) {
            var inputChannelCount = this.inputChannels;
            if (!this.inputProfile || inputChannelCount === 0) return null;

            // Lab and XYZ input profiles always expect an object regardless of
            // dataFormat — createPipeline_Input_to_Device has no dataFormat switch
            // for them, so the first pipeline stage always receives an object.
            if (format !== 'device') {
                var inputProfileType = this.inputProfile.type;
                if (inputProfileType === eProfileType.Lab) {
                    return { type: eColourType.Lab, L: 50, a: 0, b: 0, whitePoint: illuminant.d50 };
                }
                if (inputProfileType === eProfileType.XYZ) {
                    return { type: eColourType.XYZ, X: 0.5, Y: 0.5, Z: 0.5 };
                }
            }

            switch (format) {
                case 'int8':        return new Array(inputChannelCount).fill(128);
                case 'int16':       return new Array(inputChannelCount).fill(32768);
                case 'object':      return this._buildValidationObject(false);
                case 'objectFloat': return this._buildValidationObject(true);
                default:            return new Array(inputChannelCount).fill(0.5); // 'device' or unknown
            }
        }

        /** @private */
        _buildValidationObject(useFloatFormat) {
            var inputProfile = this.inputProfile;
            if (!inputProfile) return null;
            switch (inputProfile.type) {
                case eProfileType.Lab:
                    return { type: eColourType.Lab, L: 50, a: 0, b: 0, whitePoint: illuminant.d50 };
                case eProfileType.XYZ:
                    return { type: eColourType.XYZ, X: 0.5, Y: 0.5, Z: 0.5 };
                case eProfileType.CMYK:
                    return useFloatFormat
                        ? { type: eColourType.CMYKf, Cf: 0.5, Mf: 0.5, Yf: 0.5, Kf: 0.5 }
                        : { type: eColourType.CMYK,  C:  50,  M:  50,  Y:  50,  K:  50  };
                case eProfileType.Gray:
                    return useFloatFormat
                        ? { type: eColourType.Gray, G: 128 } // objectFloat Gray uses same input as object
                        : { type: eColourType.Gray, G: 128 };
                case eProfileType.Duo:
                    return { type: eColourType.Duo, a: 50, b: 50 };
                case eProfileType.NChannel:
                    // N-channel input is a plain device array (0..1) —
                    // there is no named colour object for 5+ channels.
                    return new Array(this.inputChannels).fill(0.5);
                default: // RGBMatrix, RGBLut
                    return useFloatFormat
                        ? { type: eColourType.RGBf, Rf: 0.5, Gf: 0.5, Bf: 0.5 }
                        : { type: eColourType.RGB,  R:  128, G:  128, B:  128  };
            }
        }

        /** @private */
        _isValidPipelineOutput(result, format) {
            if (result === null || result === undefined) return false;

            if (format === 'object') {
                if (typeof result !== 'object') return false;
                var expectedType = this._getExpectedOutputType(false);
                if (expectedType !== null && result.type !== expectedType) return false;
                var resultKeys = Object.keys(result);
                for (var keyIndex = 0; keyIndex < resultKeys.length; keyIndex++) {
                    var key = resultKeys[keyIndex];
                    if (key === 'type' || key === 'whitePoint') continue;
                    if (typeof result[key] === 'number' && !isFinite(result[key])) return false;
                }
                return true;
            }

            if (format === 'objectFloat') {
                if (typeof result !== 'object') return false;
                var floatResultKeys = Object.keys(result);
                for (var floatKeyIndex = 0; floatKeyIndex < floatResultKeys.length; floatKeyIndex++) {
                    var floatKey = floatResultKeys[floatKeyIndex];
                    if (floatKey === 'type' || floatKey === 'whitePoint') continue;
                    if (typeof result[floatKey] === 'number' && !isFinite(result[floatKey])) return false;
                }
                return true;
            }

            // Array-based: 'device', 'int8', 'int16'
            if (!Array.isArray(result)) return false;
            if (result.length !== this.outputChannels) return false;
            for (var channelIndex = 0; channelIndex < result.length; channelIndex++) {
                if (typeof result[channelIndex] !== 'number' || !isFinite(result[channelIndex])) return false;
            }
            return true;
        }

        /** @private */
        _getExpectedOutputType(useFloatFormat) {
            if (!this.outputProfile) return null;
            switch (this.outputProfile.type) {
                case eProfileType.Lab:  return eColourType.Lab;
                case eProfileType.XYZ:  return eColourType.XYZ;
                case eProfileType.CMYK: return useFloatFormat ? eColourType.CMYKf : eColourType.CMYK;
                case eProfileType.Gray: return eColourType.Gray;
                case eProfileType.Duo:  return eColourType.Duo;
                case eProfileType.NChannel: return null;   // plain device array — no typed object to check
                default:                return useFloatFormat ? eColourType.RGBf  : eColourType.RGB;
            }
        }

        getInput2DevicePCSInfo(inputProfile){
            switch(inputProfile.type){

                case eProfileType.Lab:
                    return encoding.PCSv4;

                case eProfileType.XYZ:
                    return encoding.PCSXYZ;

                case eProfileType.Gray:
                case eProfileType.Duo:
                case eProfileType.RGBMatrix:
                case eProfileType.RGBLut:
                case eProfileType.CMYK:
                case eProfileType.NChannel:
                    return encoding.device;
            }
            throw 'Unknown profile type ' + inputProfile.type + 'in getInput2DevicePCSInfo';
        };

        getDevice2OutputPCSInfo(outputProfile){
            switch(outputProfile.type) {
                case eProfileType.Lab:
                    if(outputProfile.version === 2){
                        return encoding.PCSv2
                    }
                    return encoding.PCSv4;
                case eProfileType.XYZ:
                    return encoding.PCSXYZ;
                case eProfileType.Gray:
                case eProfileType.Duo:
                case eProfileType.RGBMatrix:
                case eProfileType.RGBLut:
                case eProfileType.CMYK:
                case eProfileType.NChannel:
                    return encoding.device;
            }
            throw 'Unknown profile type ' + outputProfile.type + 'in getDevice2OutputPCSInfo';
        };

        isGreyTRCwithNOLUT(profile, intent){
            return (profile.Gray.kTRC && !profile.A2B[this.intent2LUTIndex(intent)])
        }

        /**
         *
         * @param location
         * @param pcsInfo
         * @param stageIndex
         */
        insertCustomStage ( location, pcsInfo, stageIndex){
            if(this.customStages && this.customStages.length > 0){
                for(var i = 0; i < this.customStages.length; i++){
                    var customStage = this.customStages[i];
                    if(customStage.location === location){
                        this.addStage(pcsInfo.pcsEncoding, 'Custom:' + customStage.description , customStage.stageFn, customStage.stageData, pcsInfo.pcsEncoding);
                    }
                    if(stageIndex !== false){
                        if(customStage.location + '(' + stageIndex + ')' === location){
                            this.addStage(pcsInfo.pcsEncoding, 'Custom:' + customStage.description , customStage.stageFn, customStage.stageData, pcsInfo.pcsEncoding);
                        }
                    }
                }
            }
        }

        createPipeline_chromaticAdaptation(pcsInfo,inputProfile, outputProfile){
            //
            // Not recommended per ICC but you can turn this on
            // https://www.color.org/whitepapers/ICC_White_Paper_6_v2_and_v4_display_profile_differences-updated.pdf
            //
            var doChromaticAdaptation = this.displayChromaticAdaptation;

            // Insert special cases here

            if(doChromaticAdaptation){
                if(!convert.compareWhitePoints(inputProfile.mediaWhitePoint, outputProfile.mediaWhitePoint)){

                    this.pipeline_Convert_PCS_to(pcsInfo, encoding.PCSXYZ);

                    this.addStage(
                        encoding.PCSXYZ,
                        'stage_ChromaticAdaptation',
                        this.stage_chromaticAdaptation,
                        {
                            inputWhitePoint: inputProfile.mediaWhitePoint,
                            outputWhitePoint: outputProfile.mediaWhitePoint,
                        },
                        encoding.PCSXYZ,
                        '  [ChromaticAdaptation : {name}]|({last}) > ({data})'
                    )
                }
            }
        };

    /**
         *
         * @param pcsInfo
         * @param {Profile} inputProfile
         * @param {Profile} outputProfile
         * @param {number} intent
         * @returns {*}
         */

        createPipeline_BlackPointCompensation(pcsInfo, inputProfile, outputProfile, intent){

            if(outputProfile.type === eProfileType.Duo ||  inputProfile.type === eProfileType.Duo){
                // No BPC for Duotone
                return;
            }

            if( inputProfile.type === eProfileType.RGBMatrix && outputProfile.type === eProfileType.RGBMatrix){
                // No BPC RGB Matrix > RGB Matrix transforms
                return;
            }

            var inputBlackXYZ = this.detectBlackpoint(inputProfile, intent);
            var outputBlackXYZ = this.detectOutputBlackpoint(outputProfile, intent);

            if(inputBlackXYZ !== false && outputBlackXYZ !== false){
                // Check if we need to do BPC, if blackpoints are the same then no BPC is needed
                var sameXYZ = ( inputBlackXYZ.X === outputBlackXYZ.X &&
                                         inputBlackXYZ.Y === outputBlackXYZ.Y &&
                                         inputBlackXYZ.Z === outputBlackXYZ.Z);

                if(!sameXYZ){
                    // Convert from labPCS to XYZ
                    this.pipeline_Convert_PCS_to(pcsInfo, encoding.PCSXYZ);

                    // Compute BlackPoint Compensation
                    // This is a linear scaling in the form ax+b, where
                    // a =   (bpout - D50) / (bpin - D50)
                    // b = - D50* (bpout - bpin) / (bpin - D50)
                    var ax, ay, az, bx, by, bz, tx, ty, tz;
                    tx = inputBlackXYZ.X - 0.9642; // cms D50 X  0.9642
                    ty = inputBlackXYZ.Y - 1.0000; // cms D50 Y  1.0
                    tz = inputBlackXYZ.Z - 0.8249; // cms D50 Z  0.8249

                    // scales
                    ax = (outputBlackXYZ.X - 0.9642) / tx;
                    ay = (outputBlackXYZ.Y - 1.0000) / ty;
                    az = (outputBlackXYZ.Z - 0.8249) / tz;

                    // offsets
                    bx = - 0.9642 * (outputBlackXYZ.X - inputBlackXYZ.X) / tx;
                    by = - 1.0000 * (outputBlackXYZ.Y - inputBlackXYZ.Y) / ty;
                    bz = - 0.8249 * (outputBlackXYZ.Z - inputBlackXYZ.Z) / tz;

                    var BPC = {
                        scale: {
                            X: ax,
                            Y: ay,
                            Z: az
                        },
                        offset: {
                            X: bx,
                            Y: by,
                            Z: bz
                        }
                    };


                    if(this.pipelineDebug){
                        var d = this.debugHistoryDecimals;
                        this.addStage(
                            encoding.PCSXYZ,
                            'Black Point Info:',
                            this.stage_history,
                            +        '  [Black Point Info]   .................................  ' +
                            ' scale.ax = ' + ax.toFixed(d) + ' scale.ay = ' + ay.toFixed(d) + ' scale.az = ' + az.toFixed(d) +
                            ' offset.bx = ' + bx.toFixed(d) + ' offset.by = ' + by.toFixed(d) + ' offset.bz = ' + bz.toFixed(d),
                            encoding.PCSXYZ,
                            ''
                        )
                    }

                    ///////////////////////////////////////////
                    // Apply BPC Scale
                    this.addStage(
                        encoding.PCSXYZ,
                        'stage_BPC',
                        this.stage_ApplyBPCScale_PCSXYZ_to_PCSXYZ,
                        BPC,
                        encoding.PCSXYZ,
                        '  [BPC : ApplyBPCScale : {name}]| ({last}) > {data}'
                    );

                    pcsInfo.pcsEncoding = encoding.PCSXYZ;

                    this.usesBPC = true;
                }
            }
        };

        /**
         *
         *
         * @param pcsInfo
         * @param {Profile} inputProfile
         * @param {Profile} outputProfile
         * @param {number} intent
         * @returns {*}
         */
        /**
         * DeviceLink pipeline — the A2B tag applied device→device, no PCS.
         * The intent comes from the profile header (the spec says the single
         * A2B tag serves whichever intent is declared there); the caller's
         * intent argument is ignored.
         *
         * Handles the full LUT element structure:
         *   V2 mft1/mft2:  inputCurve → CLUT → outputCurve
         *   V4 mAB:        aCurves → CLUT → mCurves → matrix → bCurves
         * Any element may be absent (e.g. an lcms linearization DeviceLink
         * is a curves-only mAB with no CLUT).
         *
         * @param pcsInfo
         * @param {Profile} profile  'link'-class profile
         */
        createPipeline_DeviceLink(pcsInfo, profile){
            var intentIndex = this.intent2LUTIndex(profile.header.intent);
            var lut = profile.A2B[intentIndex]
                || profile.A2B[eIntent.relative]
                || profile.A2B[0];

            if(!lut){
                throw 'DeviceLink profile has no A2B tag';
            }

            // V2 input curves
            if(lut.inputCurve){
                this.addStage(
                    encoding.device,
                    'stage_curve_v2',
                    this.stage_curve_v2,
                    lut.inputCurve,
                    encoding.device,
                    '  [DeviceLink : inputCurve : {name}]|({last}) > ({data})'
                );
            }

            // V4 A curves (device input side)
            if(lut.aCurves && !this.isPassThrough(lut.aCurves)){
                this.addStage(
                    encoding.device,
                    'stage_curves_v4',
                    this.stage_curves_v4,
                    lut.aCurves,
                    encoding.device,
                    '  [DeviceLink : aCurves : {name}]|({last}) > ({data})'
                );
            }

            // CLUT — device→device interpolation (absent in curves-only links)
            if(lut.CLUT && lut.gridPoints && lut.gridPoints.length > 0){
                this.addStageLUT(
                    false,
                    encoding.device,
                    lut,
                    encoding.device,
                    '  [DeviceLink : {name}]|({last}) > ({data})'
                );
            }

            // V4 M curves + matrix (only present for 3-channel output sides)
            if(lut.mCurves && !this.isPassThrough(lut.mCurves)){
                this.addStage(
                    encoding.device,
                    'stage_curves_v4',
                    this.stage_curves_v4,
                    lut.mCurves,
                    encoding.device,
                    '  [DeviceLink : mCurves : {name}]|({last}) > ({data})'
                );
            }
            // mft1/mft2 tags always carry a 3×3 matrix field, but per ICC
            // spec it only applies when the input side is PCSXYZ — never the
            // case for a DeviceLink. Only mAB's M-matrix is a real stage.
            if(lut.type === 'mAB ' && lut.matrix && !this.isIdentityMatrix(lut.matrix)){
                this.addStage(
                    encoding.device,
                    'stage_Matrix',
                    (this.matrixHasOffsets(lut.matrix)) ? this.stage_matrix_v4 : this.stage_matrix_v4_noOffsets,
                    lut.matrix,
                    encoding.device,
                    '  [DeviceLink : Matrix : {name}]|({last}) > ({data})'
                );
            }

            // V4 B curves (output side)
            if(lut.bCurves && !this.isPassThrough(lut.bCurves)){
                this.addStage(
                    encoding.device,
                    'stage_curves_v4',
                    this.stage_curves_v4,
                    lut.bCurves,
                    encoding.device,
                    '  [DeviceLink : bCurves : {name}]|({last}) > ({data})'
                );
            }

            // V2 output curves
            if(lut.outputCurve){
                this.addStage(
                    encoding.device,
                    'stage_curve_v2',
                    this.stage_curve_v2,
                    lut.outputCurve,
                    encoding.device,
                    '  [DeviceLink : outputCurve : {name}]|({last}) > ({data})'
                );
            }

            pcsInfo.pcsEncoding = encoding.device;
        };

        createPipeline_Device_to_PCS(pcsInfo, inputProfile, outputProfile, intent){
            switch(inputProfile.type){

                case eProfileType.Lab:
                    this.createPipeline_Device_to_PCS_via_Lab(pcsInfo, inputProfile);
                    break;

                case eProfileType.RGBMatrix:
                    this.createPipeline_Device_to_PCS_via_RGBMatrix(pcsInfo, inputProfile, outputProfile);
                    break;

                case eProfileType.Gray:
                    // special case , check for grayTRCTag and if it exists use it
                    // if there is no LUT
                    if(this.isGreyTRCwithNOLUT(inputProfile, intent)){
                    //if(inputProfile.Gray.kTRC && !inputProfile.A2B[this.intent2LUTIndex(intent)]){
                        this.createPipeline_Gray_to_PCS(pcsInfo, inputProfile, outputProfile, intent);
                        return;
                    }
                    // Fall through to LUT

                case eProfileType.Duo:
                case eProfileType.RGBLut:
                case eProfileType.CMYK:
                case eProfileType.NChannel:
                    if(inputProfile.version === 2){
                        this.createPipeline_Device_to_PCS_via_V2Lut(pcsInfo, inputProfile, outputProfile, intent);
                    } else {
                        this.createPipeline_Device_to_PCS_via_V4Lut(pcsInfo, inputProfile, outputProfile, intent);
                    }
                    break;

                default:
                    throw 'Unknown profile type ' + inputProfile.type + 'in createPipeline_Device_to_PCS';
            }

            // Convert to PCSv4
            if(inputProfile.pcs === 'XYZ' && pcsInfo.pcsEncoding === encoding.PCSXYZ){
                // Convert from XYZ to PCSv4
                this.addStage(
                    encoding.PCSXYZ,
                    'stage_PCSXYZ_to_PCSv4',
                    this.stage_PCSXYZ_to_PCSv4,
                    null,
                    encoding.PCSv4,
                    '  [PCSv4_to_Device : XYZ : {name}]|({last}) > ({data})'
                );
                pcsInfo.pcsEncoding = encoding.PCSv4
            }

            return pcsInfo;
        };

        createPipeline_Device_to_PCS_via_Lab(pcsInfo, inputProfile){

            //
            // Convert from a Lab profile to PCS
            //

            switch(inputProfile.pcs){
                case 'XYZ':
                    //
                    // Ok, this is strange, a LAB profile with a
                    // XYZ PCS, lets convert anyway
                    //
                    this.pipeline_Convert_PCS_to(pcsInfo, encoding.PCSXYZ);
                    break;
                case 'LAB':
                    this.pipeline_Convert_PCS_to(pcsInfo, encoding.PCSv4);
                    break;
                default:
                    throw 'Unknown PCS ' + inputProfile.pcs + ' in createPipeline_Device_to_PCS_via_Lab';
            }
        }

        createPipeline_Device_to_PCS_via_RGBMatrix(pcsInfo, inputProfile){

            if(pcsInfo.pcsEncoding !== encoding.device) {
                throw 'Device to PSC RGBMatrix expects device encoding';
            }

            if(this._expandRGBStages){
                var inputMatrix = inputProfile.RGBMatrix.XYZMatrix;

                // We need to scale the input so the resulting conversion is in PCSXYZ scaling
                var inputMatrix_PCSXYZ = convert.matrixScaleValues(inputMatrix, 1/1.999969482421875);

                if(inputProfile.rgb.rTRC && inputProfile.rgb.rTRC.use ){
                    // Use curves provided
                    this.addStage(
                        encoding.device,
                        'stage_curves_v4',
                        this.stage_curves_v4,
                        [inputProfile.rgb.rTRC, inputProfile.rgb.gTRC, inputProfile.rgb.bTRC],
                        encoding.device,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )
                } else if(this.useCurveLut){
                    // LUT-based inverse gamma (non-linear → linear): faster, ~32-bit precision.
                    // Error is below 1 LSB at u8/u16 output — see useCurveLut option.
                    this.addStage(
                        encoding.device,
                        'stage_Gamma_Inverse_Table',
                        this.stage_gammaTable,
                        this._buildGammaInvLut(inputProfile.RGBMatrix),
                        encoding.device,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )
                } else {
                    // Exact Math.pow inverse gamma
                    this.addStage(
                        encoding.device,
                        'stage_Gamma_Inverse',
                        this.stage_Gamma_Inverse,
                        inputProfile.RGBMatrix,
                        encoding.device,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )
                }

                // do the combined conversion
                this.addStage(
                    encoding.device,
                    'stage_matrix_rgb',
                    this.stage_matrix_rgb,
                    inputMatrix_PCSXYZ,
                    encoding.PCSXYZ,
                    '  *[optimised : {name}]|({last}) > ({data})',
                    true
                )
                pcsInfo.pcsEncoding = encoding.PCSXYZ;

            } else {
                this.addStage(
                    encoding.device,
                    'stage_RGBDevice_to_PCSv4',
                    this.stage_RGBDevice_to_PCSv4,
                    inputProfile,
                    encoding.PCSXYZ,
                    '  [DevicetoPCS : RGBMatrix : {name}]|({last}) > ({data})'
                );

                pcsInfo.pcsEncoding = encoding.PCSXYZ;
            }
        }


    /**
     * Converts from device [0.0-1.0, 0.0-1.0,... ] to PCSv4 using the Input Profile
     * If the PCS is XYZ then we convert to PCSv4
     * @param pcsInfo
     * @param inputProfile
     * @param outputProfile
     * @param intent
     */
    createPipeline_Device_to_PCS_via_V2Lut(pcsInfo, inputProfile, outputProfile, intent){
            if( pcsInfo.pcsEncoding !== encoding.device){
                console.log(this.getStageNames(true));
                throw 'createPipeline_Version2_CH4toPCSv4: expects device encoding not ' + encodingStr[pcsInfo.pcsEncoding];
            }

            var lut = inputProfile.A2B[this.intent2LUTIndex(intent)];

            // V2 Profile pipeline

            // Input curve into lut
            this.addStage(
                encoding.device,
                'stage_curve_v2',
                this.stage_curve_v2,
                lut.inputCurve,
                encoding.device,
                '  [V2_Device_to_PCSv4 : {name}]| ({last}) > ({data})'
            );

            //
            // When we transform via the LUT we end up with the profiles PCS
            //
            if(inputProfile.pcs === 'XYZ'){
                pcsInfo.pcsEncoding =  encoding.PCSXYZ;
            } else {
                pcsInfo.pcsEncoding = (inputProfile.PCSDecode === 2) ? encoding.PCSv2 : encoding.PCSv4;
            }

            switch(lut.inputChannels){
                case 1:
                case 2:
                case 3:
                case 4:
                default:
                    // addStageLUT is the authority on supported channel
                    // counts — 1-4 get the unrolled interpolators, 5-15
                    // (NChannel) route to the generic N-D fallback.
                    this.addStageLUT(
                        false,
                        encoding.device,
                        lut,
                        pcsInfo.pcsEncoding, // Converted to PCSXYZ, or PCSv2 or PCSv4
                        '  [V2_Device_to_PCSv4 : {name}]|({last}) > ({data})'
                    );
                    break;
            }

            //
            // Output Curve from LUT to device
            //
            this.addStage(
                pcsInfo.pcsEncoding,
                'stage_curve_v2',
                this.stage_curve_v2,
                lut.outputCurve,
                pcsInfo.pcsEncoding,
                '  [V2_Device_to_PCSv4 : {name}]|({last}) > ({data}) ({data:f>16})'
            );

            //... now in PCSv2 encoding....

            // Convert if absolute intent
            this.createPipeline_Absolute_Adaptation_Input(pcsInfo, inputProfile, intent);

            // Returns any PCS
        };

        createPipeline_Device_to_PCS_via_V4Lut(pcsInfo, inputProfile, outputProfile, intent){
            if( pcsInfo.pcsEncoding !== encoding.device){
                console.log(this.getStageNames(true));
                throw 'V4_CH4_to_PCSv4: expects device encoding not ' + encodingStr[pcsInfo.pcsEncoding];
            }

            var lut = inputProfile.A2B[this.intent2LUTIndex(intent)];

            if(!lut){
                throw 'No LUT in createPipeline_Device_to_PCS_via_V4Lut for the intent ' + intent;
            }

            // A Curve
            if(lut.aCurves !== false && !this.isPassThrough(lut.aCurves)){
                this.addStage(
                    encoding.device,
                    'stage_curves_v4',
                    this.stage_curves_v4,
                    lut.aCurves,
                    encoding.device,
                    '  [V4_Device_to_PCSv4 : aCurves : {name}]|({last}) > ({data}) ({data:f>16})'
                );
            }

            if(inputProfile.pcs === 'XYZ'){
                pcsInfo.pcsEncoding = encoding.PCSXYZ;
            } else {
                pcsInfo.pcsEncoding = encoding.PCSv4;
            }

            // CLUT
            if(lut.CLUT4 !== false) {
                switch (lut.inputChannels) {
                    case 1:
                    case 2:
                    case 3:
                    case 4:
                    default:
                        // addStageLUT is the authority on supported channel
                        // counts — 1-4 get the unrolled interpolators, 5-15
                        // (NChannel) route to the generic N-D fallback.
                        this.addStageLUT(
                            false,
                            encoding.device, // Device in
                            lut,
                            pcsInfo.pcsEncoding, // PCSV4 or XYZ out
                            '  [V4_Device_to_PCSv4 : {name}]|({last}) > ({data})'
                        );
                        break;
                }
            }

            //M Curves
            if(lut.mCurves !== false && !this.isPassThrough(lut.mCurves)){
                this.addStage(
                    pcsInfo.pcsEncoding,
                    'stage_curves_v4',
                    this.stage_curves_v4,
                    lut.mCurves,
                    pcsInfo.pcsEncoding,
                    '  [V4_Device_to_PCSv4 : mCurves : {name}]|({last}) > ({data}) ({data:f>16})'
                );
            }

            //M Matrix
            if(lut.matrix !== false){
                if(!this.isIdentityMatrix(lut.matrix)){
                    this.addStage(
                        pcsInfo.pcsEncoding,
                        'stage_Matrix',
                        (this.matrixHasOffsets(lut.matrix)) ? this.stage_matrix_v4 : this.stage_matrix_v4_noOffsets,
                        lut.matrix,
                        pcsInfo.pcsEncoding,
                        '  [V4_Device_to_PCSv4 : Matrix : {name}]|({last}) > ({data}) ({data:f>16})'
                    );
                }
            }
            if(lut.bCurves !== false && !this.isPassThrough(lut.bCurves)){
                this.addStage(
                    pcsInfo.pcsEncoding,
                    'stage_curves_v4',
                    this.stage_curves_v4,
                    lut.bCurves,
                    pcsInfo.pcsEncoding,
                    '  [V4_Device_to_PCSv4 : bCurves : {name}]|({last}) > ({data}) ({data:f>16})'
                );
            }

            // convert if absolute
            this.createPipeline_Absolute_Adaptation_Input(pcsInfo, inputProfile, intent);

            //Returns PCS any
        };

        createPipeline_Gray_to_PCS(pcsInfo, inputProfile, outputProfile, intent){
            if(pcsInfo.pcsEncoding !== encoding.device){
                console.log(this.getStageNames(true));
                throw 'Gray_to_PCSv4: expects device encoding not ' + encodingStr[pcsInfo.pcsEncoding];
            }

            if(inputProfile.pcs === 'XYZ'){

                // Convert to PCSXYZ
                this.addStage(
                    encoding.device,
                    'stage_grayTRC_to_PCSXYZ_Via_Y',
                    this.stage_grayTRC_to_PCSXYZ_Via_Y,
                    [inputProfile.Gray.kTRC],
                    encoding.PCSXYZ,
                    '  [Gray_to_PCSv4 : {name}]|({last}) > ({data}) ({data:f>16})'
                );

                // Convert if absolute intent
                if(intent === eIntent.absolute  ){
                    this.addStage(
                        encoding.PCSXYZ,
                        'stage_absoluteAdaptationIn_PCSXYZ_to_PCSXYZ',
                        this.stage_absoluteAdaptationIn_PCSXYZ_to_PCSXYZ,
                        inputProfile,
                        encoding.PCSXYZ,
                        '  [Gray_to_PCSv4 : {name}]|({last}) > ({data}) ({data:f>16})'
                    );
                }

                pcsInfo.pcsEncoding = encoding.PCSXYZ;

            } else {
                // PCS LAB
                // Convert from Gray to PCS, Basically Map Gray to Luminance
                this.addStage(
                    encoding.device,
                    'stage_curves_v4',
                    this.stage_grayTRC_to_PCSV4_Via_L,
                    [inputProfile.Gray.kTRC],
                    encoding.PCSv4,
                    '  [Gray_to_PCSv4 : {name}]|({last}) > ({data}) ({data:f>16})'
                );
                pcsInfo.pcsEncoding = encoding.PCSv4;

                // Convert if absolute intent
                this.createPipeline_Absolute_Adaptation_Input(pcsInfo, inputProfile, intent);
            }
        };

        isPassThrough(curves){
            var passThrough = true;
            for(var i = 0; i < curves.length; i++){
                passThrough = passThrough && curves[i].passThrough;
            }
            return passThrough;
        };

        /**
         * Pipeline to convert from the PCS encoded
         * @param pcsInfo
         * @param {Profile} inputProfile
         * @param {Profile} outputProfile
         * @param {number} intent
         */
        createPipeline_PCS_to_Device(pcsInfo, inputProfile, outputProfile, intent){
            if( !(pcsInfo.pcsEncoding !== encoding.PCSv4 || pcsInfo.pcsEncoding !== encoding.PCSXYZ) ){
                console.log(this.getStageNames(true));
                throw 'createPipeline_PCS_to_Device: expects PCSv4 or PCSXYZ not ' + encodingStr[pcsInfo.pcsEncoding];
            }

            switch(outputProfile.type) {
                case eProfileType.Lab:
                    this.createPipeline_PCS_to_Lab(pcsInfo);
                    return

                case eProfileType.RGBMatrix:
                    this.createPipeline_PCS_to_Device_via_RGBMatrix(pcsInfo, inputProfile, outputProfile);
                    return

                case eProfileType.Gray:
                    // special case , check for grayTRCTag
                    // else fall through to using LUT
                    if(this.isGreyTRCwithNOLUT(outputProfile, intent)){
                         this.createPipeline_PCS_to_Gray_via_kTRC(pcsInfo, inputProfile, outputProfile, intent);
                         return;
                    }

                    // Fall through to LUT
                case eProfileType.Duo:
                case eProfileType.RGBLut:
                case eProfileType.CMYK:
                case eProfileType.NChannel:
                    if(outputProfile.version === 2){
                        this.createPipeline_PCS_to_Device_via_V2LUT(pcsInfo, inputProfile, outputProfile, intent);
                        return
                    }

                    this.createPipeline_PCS_to_Device_via_V4LUT(pcsInfo, inputProfile, outputProfile, intent);
                    return

                default:
                    throw 'Unknown profile type ' + outputProfile.type + 'in createPipeline_PCS_to_Device';
            }
        };

        createPipeline_PCS_to_Lab(pcsInfo) {
            this.pipeline_Convert_PCS_to(pcsInfo, encoding.PCSv4);
        }

        createPipeline_PCS_to_Device_via_RGBMatrix(pcsInfo, inputProfile, outputProfile){

            if(this._expandRGBStages){
                var outputMatrixInv = outputProfile.RGBMatrix.XYZMatrixInv;

                // We need to scale the matrix by XYZ>XYZPCS
                var outputMatrixInv_PCSXYZ = convert.matrixScaleValues(outputMatrixInv, 1.999969482421875);

                this.pipeline_Convert_PCS_to(pcsInfo, encoding.PCSXYZ);

                this.addStage(
                    encoding.PCSXYZ,
                    'stage_matrix_rgb',
                    this.stage_matrix_rgb,
                    outputMatrixInv_PCSXYZ,
                    encoding.device,
                    '  *[PCS_to_RGBDevice : {name}]|({last}) > ({data})',
                    true
                )

                if(outputProfile.rgb.rTRCInv && outputProfile.rgb.rTRCInv.use){
                    // Use curves provided might also be parametric fn
                    this.addStage(
                        encoding.device,
                        'stage_curves_v4',
                        this.stage_curves_v4,
                        [outputProfile.rgb.rTRCInv, outputProfile.rgb.gTRCInv, outputProfile.rgb.bTRCInv],
                        encoding.device,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )
                } else if(this.useCurveLut){
                    // LUT-based forward gamma (linear → non-linear): faster, ~32-bit precision.
                    this.addStage(
                        encoding.device,
                        'stage_Gamma_Table',
                        this.stage_gammaTable,
                        this._buildGammaFwdLut(outputProfile.RGBMatrix),
                        encoding.device,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )
                } else {
                    // Exact Math.pow forward gamma
                    this.addStage(
                        encoding.device,
                        'stage_Gamma',
                        this.stage_Gamma,
                        outputProfile.RGBMatrix,
                        encoding.device,
                        '  *[optimised : {name}]|({last}) > ({data})',
                        true
                    )
                }
            } else {

                this.pipeline_Convert_PCS_to(pcsInfo, encoding.PCSv4);

                this.addStage(
                    encoding.PCSv4,
                    'stage_PCSv4_to_RGBDevice',
                    this.stage_PCSv4_to_RGBDevice,
                    outputProfile,
                    encoding.device,
                    '  [PCS_to_RGBDevice : {name}]|({last}) > ({data})'
                );
            }

            pcsInfo.pcsEncoding = encoding.device;

        }

        createPipeline_PCS_to_Device_via_V4LUT(pcsInfo, inputProfile, outputProfile, intent) {

            // if Absolute Colorimetric then apply Adaptation here
            this.createPipeline_Absolute_Adaptation_Output_Any_to_PCSv4(pcsInfo, outputProfile, intent );

            var lut = outputProfile.B2A[this.intent2LUTIndex(intent)];

            // ensure the PCS is the correct Format and correct Version
            this.pipelineConvert_PCSV4_to_OutputProfile_PCS(pcsInfo, lut, outputProfile );

            // PCS is now PCSv2 or PCSXYZ

            // B Curves
            if(lut.bCurves !== false && !this.isPassThrough(lut.bCurves)){
                this.addStage(
                    pcsInfo.pcsEncoding,
                    'stage_curves_v4',
                    this.stage_curves_v4,
                    lut.bCurves,
                    pcsInfo.pcsEncoding,
                    '  [PCSv4_to_Device_via_V4LUT : bCurves : {name}]|({last}) > ({data}) ({data:f>16})'
                );
            }

            //M Matrix
            if(lut.matrix !== false){
                if(!this.isIdentityMatrix(lut.matrix)) {
                    this.addStage(
                        pcsInfo.pcsEncoding,
                        'stage_Matrix',
                        (this.matrixHasOffsets(lut.matrix)) ? this.stage_matrix_v4 : this.stage_matrix_v4_noOffsets,
                        lut.matrix,
                        pcsInfo.pcsEncoding,
                        '  [PCSv4_to_Device_via_V4LUT : Matrix : {name}]|({last}) > ({data}) ({data:f>16})'
                    );
                }
            }

            //M Curves
            if(lut.mCurves !== false && !this.isPassThrough(lut.mCurves)){
                this.addStage(
                    pcsInfo.pcsEncoding,
                    'stage_curves_v4',
                    this.stage_curves_v4,
                    lut.mCurves,
                    pcsInfo.pcsEncoding,
                    '  [PCSv4_to_Device_via_V4LUT : mCurves : {name}]|({last}) > ({data}) ({data:f>16})'
                );
            }

            // CLUT - PCS is always 3 channel input
            if(lut.CLUT4 !== false) {
                this.addStageLUT(
                    true,
                    pcsInfo.pcsEncoding,
                    lut,
                    encoding.device,
                    '  [PCSv4_to_Device_via_V4LUT : LUT : {name}]|({last}) > ({data})'
                );
            } else {
                pcsInfo.pcsEncoding = encoding.device;
            }

            // A Curve
            if(lut.aCurves !== false && !this.isPassThrough(lut.aCurves)){
                this.addStage(
                    encoding.device,
                    'stage_curves_v4',
                    this.stage_curves_v4,
                    lut.aCurves,
                    encoding.device,
                    '  [PCSv4_to_Device_via_V4LUT : aCurves : {name}]|({last}) > ({data}) ({data:f>16})'
                );
            }

            // switch to device encoding
            pcsInfo.pcsEncoding = encoding.device;
        };

        isIdentityMatrix(matrix){
            return (matrix[0] === 1 && matrix[1] === 0 && matrix[2] === 0 &&
                    matrix[3] === 0 && matrix[4] === 1 && matrix[5] === 0 &&
                    matrix[6] === 0 && matrix[7] === 0 && matrix[8] === 1 &&

                    // Offsets
                    matrix[9] === 0 && matrix[10] === 0 && matrix[11] === 0
            );
        }

        matrixHasOffsets(matrix){
            return (matrix[9] !== 0 || matrix[10] !== 0 || matrix[11] !== 0);
        }

        createPipeline_PCS_to_Device_via_V2LUT(pcsInfo, inputProfile, outputProfile, intent) {


            // if Absolute Colorimetric then apply Adaptation
            this.createPipeline_Absolute_Adaptation_Output_Any_to_PCSv4(pcsInfo, outputProfile, intent );

            // ensure the PCS is the correct Format and correct Version
            var lut = outputProfile.B2A[this.intent2LUTIndex(intent)];
            this.pipelineConvert_PCSV4_to_OutputProfile_PCS(pcsInfo, lut, outputProfile);

            // PCS must be PCSXYZ or PCSv2
            if(!(pcsInfo.pcsEncoding === encoding.PCSv2 || pcsInfo.pcsEncoding === encoding.PCSXYZ)){
                console.log(this.getStageNames(true));
                throw 'createPipeline_PCS_to_Device_via_V2LUT: expects PCSv2 or PCSXYZ not ' + encodingStr[pcsInfo.pcsEncoding];
            }

            // V2 Profile pipeline
            this.addStage(
                pcsInfo.pcsEncoding,
                'stage_curve_v2',
                this.stage_curve_v2,
                lut.inputCurve,
                pcsInfo.pcsEncoding,
                '  [PCSv4_to_Device_via_V2LUT : {name}]| ({last})        > ({data})'
            );

            this.addStageLUT(
                true,
                pcsInfo.pcsEncoding,  // Going INTO to LUT its PCS encoding PCSXYZ or PCSv2 or PCSv4
                lut,
                encoding.device, // Now its device encoding
                '  [PCSv4_to_Device_via_V2LUT : {name}]|({last}) > ({data})'
            );

            pcsInfo.pcsEncoding = encoding.device;

            this.addStage(
                encoding.device,
                'stage_curve_v2',
                this.stage_curve_v2,
                lut.outputCurve,
                pcsInfo.pcsEncoding,
                '  [PCSv4_to_Device_via_V2LUT : {name}]|({last}) > ({data}) ({data:f>16})'
            );

        };

        createPipeline_PCS_to_Gray_via_kTRC(pcsInfo, inputProfile, outputProfile, intent){
            if(!(pcsInfo.pcsEncoding === encoding.PCSv2 ||
                pcsInfo.pcsEncoding === encoding.PCSv4||
                pcsInfo.pcsEncoding === encoding.PCSXYZ)){
                console.log(this.getStageNames(true));
                throw 'PCSv4_to_Gray: expects PCSv2,PCSv4,PCSXYZ encoding not ' + encodingStr[pcsInfo.pcsEncoding];
            }

            // XYZ -> Gray or Lab -> Gray.
            // Since we only know the GrayTRC, we need to do some assumptions. Gray component will be
            // given by Y on XYZ PCS and by L* on Lab PCS, Both across inverse TRC curve.
            if(outputProfile.pcs === 'XYZ'){

                // Make sure we are in XYZ
                this.pipeline_Convert_PCS_to(pcsInfo, encoding.PCSXYZ);

                // if Absolute Colorimetric then apply Adaptation
                // Since we are already in XYZ, it keeps this stage simple.
                if (intent === eIntent.absolute) {
                    this.addStage(
                        encoding.PCSXYZ,
                        'stage_absoluteAdaptationOut_PCSXYZ_to_PCSXYZ',
                        this.stage_absoluteAdaptationOut_PCSXYZ_to_PCSXYZ,
                        outputProfile,
                        encoding.PCSXYZ,
                        '  [PCSv4_to_Gray : {name}]|({last}) > ({data})'
                    );
                }

                this.addStage(
                    encoding.PCSXYZ,
                    'stage_PCSXYZ_to_grayTRC_via_Y',
                    this.stage_PCSXYZ_to_grayTRC_via_Y,
                    [outputProfile.Gray.inv_kTRC],
                    encoding.device,
                    '  [PCSv4_to_Gray : {name}]|({last}) > ({data}) ({data:f>16})'
                )

                pcsInfo.pcsEncoding = encoding.device;
            } else {

                // if Absolute Colorimetric then apply Adaptation
                this.createPipeline_Absolute_Adaptation_Output_Any_to_PCSv4(pcsInfo, outputProfile, intent);

                // PCSv2 and PCSv4 L is close enough not to warrant a conversion
                this.addStage(
                    pcsInfo.pcsEncoding,
                    'stage_PCSV4_to_grayTRC_via_L',
                    this.stage_PCSV4_to_grayTRC_via_L,
                    [outputProfile.Gray.inv_kTRC],
                    encoding.device,
                    '  [PCSv4_to_Gray : {name}]|({last}) > ({data}) ({data:f>16})'
                )

                pcsInfo.pcsEncoding = encoding.device;
            }
        };

        /**
         * Scales the PCS to adjust for the Absolute Intent white point
         * If the PCS is XYZ then we convert use the XYZ values to scale
         * If the PCS is Lab then we convert to XYZ and use the XYZ values to scale
         * Returns PCSv2 or PCSv4
         * @param pcsInfo
         * @param inputProfile
         * @param intent
         */
        createPipeline_Absolute_Adaptation_Input(pcsInfo, inputProfile, intent ){
            if(intent === eIntent.absolute){

                // Convert to XYZ
                this.pipeline_Convert_PCS_to(pcsInfo, encoding.PCSXYZ);

                if(this.pipelineDebug){
                    this.addStage(
                        encoding.PCSXYZ,
                        'Input_Absolute_Adaptation:',
                        this.stage_history,
                        '  [Input_Absolute_Adaptation] ..................................  ' +
                        'Xa = ' + inputProfile.absoluteAdaptationIn.Xa +
                        ', Ya = ' + inputProfile.absoluteAdaptationIn.Ya +
                        ', Za = ' + inputProfile.absoluteAdaptationIn.Za,
                        encoding.PCSXYZ,
                        ''
                    )
                }

                this.usesAdaptation = true;


                // adaptation to Absolute Intent, cmsLab > XYZ > scale > XYZ > cmsLab
                this.addStage(
                    encoding.PCSXYZ,
                    'stage_absoluteAdaptationIn_PCSXYZ_to_PCSXYZ',
                    this.stage_absoluteAdaptationIn_PCSXYZ_to_PCSXYZ,
                    inputProfile,
                    encoding.PCSXYZ,
                    '  [InputAdaptation : {name}]| ({last}) > ({data})'
                );

                pcsInfo.pcsEncoding = encoding.PCSXYZ;
            }
        };


        /**
         * Scales the PCS to adjust for the Absolute Intent white point
         * If the PCS is XYZ then we convert use the XYZ values to scale
         * If the PCS is Lab then we convert to XYZ and use the XYZ values to scale
         * Returns PCSv2 or PCSv4
         * @param pcsInfo
         * @param outputProfile
         * @param intent
         */
        createPipeline_Absolute_Adaptation_Output_Any_to_PCSv4(pcsInfo, outputProfile, intent ){
            if (intent === eIntent.absolute) {

                if(!(pcsInfo.pcsEncoding === encoding.PCSv2 ||
                    pcsInfo.pcsEncoding === encoding.PCSv4 ||
                    pcsInfo.pcsEncoding === encoding.PCSXYZ
                )){
                    throw 'createPipeline_Absolute_Adaptation_Output_Any_to_PCSv4, Encoding must be PCSXYZ, PCSv2 or PVCSv4 not ' + encodingStr[pcsInfo.pcsEncoding];
                }

                this.pipeline_Convert_PCS_to(pcsInfo, encoding.PCSXYZ);

                if(this.pipelineDebug){
                    this.addStage(
                        encoding.PCSXYZ,
                        'Output_Absolute_Adaptation:',
                        this.stage_history,
                        +        '  [Output_Absolute_Adaptation] .................................  ' +
                        'Xa = ' + outputProfile.absoluteAdaptationOut.Xa +
                        ', Ya = ' + outputProfile.absoluteAdaptationOut.Ya +
                        ', Za = ' + outputProfile.absoluteAdaptationOut.Za,
                        encoding.PCSXYZ,
                        ''
                    )
                }

                this.usesAdaptation = true;

                this.addStage(
                    encoding.PCSXYZ,
                    'stage_absoluteAdaptationOut_PCSXYZ_to_PCSXYZ',
                    this.stage_absoluteAdaptationOut_PCSXYZ_to_PCSXYZ,
                    outputProfile,
                    encoding.PCSXYZ,
                    '  [OutputAdaptation : {name}]| ({last}) > ({data})'
                );


                this.addStage(
                    encoding.PCSXYZ,
                    'stage_PCSXYZ_to_PCSv4',
                    this.stage_PCSXYZ_to_PCSv4,
                    null,
                    encoding.PCSv4,
                    '  [OutputAdaptation : {name}]| ({last}) > ({data})'
                );
                pcsInfo.pcsEncoding = encoding.PCSv4;


            }
        };


        /**
         * Converts from the PCS encoded to the destination PCS only if requured
         * @param pcsInfo
         * @param destinationPCS
         */
        pipeline_Convert_PCS_to(pcsInfo, destinationPCS) {
            var stage = this.createConvert_PCS_stage(pcsInfo, destinationPCS);
            if(stage){
                this.pushStage(stage);
            }
        }
        createConvert_PCS_stage(pcsInfo, destinationPCS) {

            switch (destinationPCS) {
                case encoding.PCSXYZ:
                    switch (pcsInfo.pcsEncoding) {

                        case encoding.PCSv2:
                            // Convert from V2 to XYZ
                            pcsInfo.pcsEncoding = encoding.PCSXYZ;
                            return this.createStage(
                                encoding.PCSv2,
                                'stage_PCSv2_to_PCSXYZ',
                                this.stage_PCSv2_to_PCSXYZ,
                                null,
                                encoding.PCSXYZ,
                                '  [Convert PCS : stage_PCSv2_to_PCSXYZ]  ({last}) > ({data})'
                            );

                        case encoding.PCSv4:
                            // Convert from V4 to XYZ
                            pcsInfo.pcsEncoding = encoding.PCSXYZ;
                            return this.createStage(
                                encoding.PCSv4,
                                'stage_PCSv4_to_PCSXYZ',
                                this.stage_PCSv4_to_PCSXYZ,
                                null,
                                encoding.PCSXYZ,
                                '  [Convert PCS : stage_PCSv4_to_PCSXYZ]  ({last}) > ({data})'
                            );

                        case encoding.PCSXYZ:
                            // No action required
                            return false;

                        default:
                            throw 'pipelineConvert_PCSV4_to_OutputProfile_PCS, unexpected XYZ encoding ' + encodingStr[pcsInfo.pcsEncoding];
                    }


                case encoding.PCSv2:
                    switch (pcsInfo.pcsEncoding) {
                        case encoding.PCSv2:
                            // No action required
                            return false;

                        case encoding.PCSv4:
                            pcsInfo.pcsEncoding = encoding.PCSv2;
                            return this.createStage(
                                encoding.PCSv4,
                                'stage_PCSv4_to_PCSv2',
                                this.stage_PCSv4_to_PCSv2,
                                null,
                                pcsInfo.pcsEncoding,
                                '  [Convert PCS : {name}]  ({last}) > ({data})'
                            );

                        case encoding.PCSXYZ:
                            pcsInfo.pcsEncoding = encoding.PCSv2;
                            return this.createStage(
                                encoding.PCSXYZ,
                                'stage_PCSXYZ_to_PCSv2',
                                this.stage_PCSXYZ_to_PCSv2,
                                null,
                                encoding.PCSv2,
                                '  [Convert PCS : {name}]  ({last}) > ({data})'
                            )
                        default:
                            throw ('CheckPCSVersion, Unexpected LAB Encoding ' + encodingStr[pcsInfo.pcsEncoding]);
                    }
                case encoding.PCSv4:
                    switch (pcsInfo.pcsEncoding) {

                        case encoding.PCSXYZ:
                            pcsInfo.pcsEncoding = encoding.PCSv4;
                            return this.createStage(
                                encoding.PCSXYZ,
                                'stage_PCSXYZ_to_PCSv4',
                                this.stage_PCSXYZ_to_PCSv4,
                                null,
                                encoding.PCSv4,
                                '  [Convert PCS : {name}]  ({last}) > ({data})'
                            )

                        case encoding.PCSv2:
                            pcsInfo.pcsEncoding = encoding.PCSv4;
                            return this.createStage(
                                encoding.PCSv2,
                                'stage_PCSv2_to_PCSv4',
                                this.stage_PCSv2_to_PCSv4,
                                null,
                                encoding.PCSv4,
                                '  [Convert PCS : {name}]  ({last}) > ({data})'
                            )

                        case encoding.PCSv4:
                            // No action required
                            return false;

                        default:
                            throw ('Convert PCS, Unexpected LAB Encoding ' + encodingStr[pcsInfo.pcsEncoding]);
                    }
                default:
                    throw 'pipelineConvert_PCS, unexpected destination PCS encoding ' + encodingStr[destinationPCS];
            }

        }
        pipelineConvert_PCSV4_to_OutputProfile_PCS(pcsInfo, lut, profile ){
            var stage;
            switch(profile.pcs){
                case 'XYZ':
                    this.pipeline_Convert_PCS_to(pcsInfo, encoding.PCSXYZ);
                    break;
                case 'LAB':
                    switch(profile.version){
                        case 2: // V2 PROFILE
                            if(lut.precision === 8) {
                                // 8Bit LUT with v2 encoding is the same as PCSv4 encoding,
                                // so this is a special case where ...
                                //
                                //  if XYZ - Convert to V4 and say its V2
                                //  if V2 - Convert to V4 and say its V2
                                //  if V4 - Encoding is correct, but need to add null stage to pass validation
                                //

                                stage = this.createConvert_PCS_stage(pcsInfo, encoding.PCSv4);
                                if(stage){
                                    // lie and say its V2
                                    pcsInfo.pcsEncoding = encoding.PCSv2;
                                    stage.outputEncoding = encoding.PCSv2;
                                } else {
                                    // we have a problem, previous stage is PVSv4 and
                                    // we will get a validation error as next stage
                                    // is expecting PCSv2.
                                    //
                                    // So we need to add a stage that does nothing and
                                    // says its PCSv2, the optimiser will delete this stage

                                    // lie and say its V2
                                    pcsInfo.pcsEncoding = encoding.PCSv2;

                                    // Add null stage so validations pass
                                    this.addStage(
                                        encoding.PCSv4,
                                        'stage_null',
                                        this.stage_null,
                                        null,
                                        pcsInfo.pcsEncoding,
                                        '  [CheckPCSVersion : {name}]  ({last}) > ({data})'
                                    );
                                }
                            } else {
                                // 16 encoding LUT with v2 encoding
                                stage = this.createConvert_PCS_stage(pcsInfo, encoding.PCSv2);
                            }

                            if(stage){
                                this.pushStage(stage);
                            }
                            break;
                        case 4: // v4 PROFILE
                            this.pipeline_Convert_PCS_to(pcsInfo, encoding.PCSv4);
                            break;
                        default:
                            throw 'pipelineConvert_PCSV4_to_OutputProfile_PCS, unexpected profile version ' + profile.version;
                    }
            }
        }

        /**
         * Final step in the pipeline to convert from the Device encoded as cmsLab or PCSArray to the output format
         * @param pcsInfo
         * @param {Profile} outputProfile
         */

        createPipeline_Device_to_Output(pcsInfo, outputProfile){

            var intSize;
            var intStageFn;
            var intStageDesc;
            if( this.dataFormat === 'int8' || this.dataFormat === 'int16'){
                switch(outputProfile.outputChannels){
                    case 1:
                        intStageFn = this.stage_device1_to_int;
                        intStageDesc = '[stage_device1_to_int ' +  this.dataFormat  + ' : {name}]| ({last}) > {data}';
                        break;
                    case 2:
                        intStageFn = this.stage_device2_to_int;
                        intStageDesc = '[stage_device2_to_int ' +  this.dataFormat  + ' : {name}]| ({last}) > {data}';
                        break;
                    case 3:
                        intStageFn = this.stage_device3_to_int;
                        intStageDesc = '[stage_device3_to_int ' +  this.dataFormat  + ' : {name}]| ({last}) > {data}';
                        break;
                    case 4:
                        intStageFn = this.stage_device4_to_int;
                        intStageDesc = '[stage_device4_to_int ' +  this.dataFormat  + ' : {name}]| ({last}) > {data}';
                        break;
                    default:
                        // generic
                        intStageFn = this.stage_deviceN_to_int;
                        intStageDesc = '[stage_deviceN_to_int ' +  this.dataFormat  + ' : {name}]| ({last}) > {data}';
                }
                intSize = this.dataFormat === 'int8' ? 255 : 65535;
            }

            switch(outputProfile.type) {
                case eProfileType.Gray:
                    if (pcsInfo.pcsEncoding !== encoding.device) {
                        console.log(this.getStageNames(true));
                        throw '[Device2Output: Gray ] Input must be Device not ' + encodingStr[pcsInfo.pcsEncoding];
                    }

                    switch (this.dataFormat) {
                        case 'object':
                            this.addStage(
                                encoding.device,
                                this.roundOutput ? 'stage_device_to_Gray' : 'stage_device_to_Gray',
                                this.roundOutput ? this.stage_device_to_Gray_round : this.stage_device_to_Gray,
                                this.precision,
                                encoding.cmsRGB,
                                '  [Device2Output : Gray : {name}]| ({last}) > {data}'
                            );
                            break;
                        case 'objectFloat':
                            this.addStage(
                                encoding.device,
                                'stage_device_to_Grayf',
                                 this.stage_device_to_Grayf,
                                this.precision,
                                encoding.cmsRGB,
                                '  [Device2Output : Gray : {name}]| ({last}) > {data}'
                            );
                            break;
                        case 'int8':
                        case 'int16':
                            this.addStage(
                                encoding.device,
                                'stage_device_to_int',
                                intStageFn,
                                intSize,
                                encoding.device,
                                intStageDesc
                            );
                            break;
                    }
                    break;

                case eProfileType.Duo:
                    if (pcsInfo.pcsEncoding !== encoding.device) {
                        console.log(this.getStageNames(true));
                        throw '[Device2Output: Duo ] Input must be Device not ' + encodingStr[pcsInfo.pcsEncoding];
                    }

                    switch (this.dataFormat) {
                        case 'object':
                            this.addStage(
                                encoding.device,
                                this.roundOutput ? 'stage_device_to_Duo' : 'stage_device_to_Duo',
                                this.roundOutput ? this.stage_device_to_Duo_round : this.stage_device_to_Duo,
                                this.precision,
                                encoding.cmsRGB,
                                '  [Device2Output : Duo : {name}]| ({last}) > {data}'
                            );
                            break;
                        case 'objectFloat':
                            this.addStage(
                                encoding.device,
                                 'stage_device_to_Duof',
                                this.stage_device_to_Duof,
                                this.precision,
                                encoding.cmsRGB,
                                '  [Device2Output : Duo : {name}]| ({last}) > {data}'
                            );
                            break;
                        case 'int8':
                        case 'int16':
                            this.addStage(
                                encoding.device,
                                'stage_device_to_int',
                                intStageFn,
                                intSize,
                                encoding.device,
                                intStageDesc
                            );
                            break;
                    }
                    break;

                case eProfileType.Lab:
                    if (!(pcsInfo.pcsEncoding === encoding.PCSv2 || pcsInfo.pcsEncoding === encoding.PCSv4)) {
                        console.log(this.getStageNames(true));
                        throw '[Device2Output: Lab ] Input must be PCS/V2 or PCS/V4 not ' + encodingStr[pcsInfo.pcsEncoding];
                    }
                    switch (this.dataFormat) {
                        case 'object':
                        case 'objectFloat':
                            if (pcsInfo.pcsEncoding === encoding.PCSv2) {
                                this.addStage(
                                    encoding.PCSv2,
                                    'stage_PCSv2_to_cmsLab',
                                    this.stage_PCSv2_to_cmsLab,
                                    null,
                                    encoding.cmsLab,
                                    '  [Device2Output : Lab : {name}]|({last:r}) / ({last}) > {data}'
                                );
                            } else {
                                this.addStage(
                                    encoding.PCSv4,
                                    'stage_PCSv4_to_cmsLab',
                                    this.stage_PCSv4_to_cmsLab,
                                    null,
                                    encoding.cmsLab,
                                    '  [Device2Output : Lab : {name}]| ({last}) > {data}'
                                );
                            }
                            break;
                        case 'int8':
                        case 'int16':
                            //
                            // This will convert Lab/XYZ PCS to 8 or 16 bits
                            // That's a loss of precision, but need this for testing
                            //
                            this.addStage(
                                pcsInfo.pcsEncoding,
                                'stage_device_to_int',
                                intStageFn,
                                intSize,
                                encoding.device,
                                intStageDesc
                            );
                            break;
                    }
                    break;

                case eProfileType.RGBMatrix:
                case eProfileType.RGBLut:
                    if (pcsInfo.pcsEncoding !== encoding.device) {
                        console.log(this.getStageNames(true));
                        throw '[Device2Output: RGB ] Input must be Device not ' + encodingStr[pcsInfo.pcsEncoding];
                    }

                    switch (this.dataFormat) {
                        case 'object':
                            this.addStage(
                                encoding.device,
                                this.roundOutput ? 'stage_device_to_RGB' : 'stage_device_to_RGB',
                                this.roundOutput ? this.stage_device_to_RGB_round : this.stage_device_to_RGB,
                                this.precision,
                                encoding.cmsRGB,
                                '  [Device2Output : RGB : {name}]| ({last}) > {data}'
                            );
                            break;
                        case 'objectFloat':
                            this.addStage(
                                encoding.device,
                                'stage_device_to_RGBf',
                                this.stage_device_to_RGBf,
                                this.precision,
                                encoding.cmsRGB,
                                '  [Device2Output : RGB : {name}]| ({last}) > {data}'
                            );
                            break;
                        case 'int8':
                        case 'int16':
                            this.addStage(
                                encoding.device,
                                'stage_device_to_int',
                                intStageFn,
                                intSize,
                                encoding.device,
                                intStageDesc
                            );
                            break;
                    }
                    break;

                case eProfileType.CMYK:
                    if (pcsInfo.pcsEncoding !== encoding.device) {
                        console.log(this.getStageNames(true));
                        throw '[Device2Output: CMYK ] Input must be Device not ' + encodingStr[pcsInfo.pcsEncoding];
                    }

                    switch (this.dataFormat) {
                        case 'object':
                            this.addStage(
                                encoding.device,
                                this.roundOutput ? 'stage_device_to_CMYK' : 'stage_device_to_CMYK',
                                this.roundOutput ? this.stage_device_to_CMYK_round : this.stage_device_to_CMYK,
                                this.precision,
                                encoding.cmsCMYK,
                                '  [Device2Output : CMYK : {name}]| ({last}) > {data}'
                            );
                            break;
                        case 'objectFloat':
                            this.addStage(
                                encoding.device,
                                'stage_device_to_CMYKf',
                                this.stage_device_to_CMYKf,
                                this.precision,
                                encoding.cmsCMYK,
                                '  [Device2Output : CMYK : {name}]| ({last}) > {data}'
                            );
                            break;
                        case 'int8':
                        case 'int16':
                            this.addStage(
                                encoding.device,
                                'stage_device_to_int',
                                intStageFn,
                                intSize,
                                encoding.device,
                                intStageDesc
                            );
                            break;
                    }
                    break;

                case eProfileType.NChannel:
                    if (pcsInfo.pcsEncoding !== encoding.device) {
                        console.log(this.getStageNames(true));
                        throw '[Device2Output: NChannel ] Input must be Device not ' + encodingStr[pcsInfo.pcsEncoding];
                    }

                    switch (this.dataFormat) {
                        case 'object':
                        case 'objectFloat':
                            // No named colour object for 5+ channels — output
                            // stays a plain device array (0..1). The copy
                            // prevents downstream mutation aliasing.
                            this.addStage(
                                encoding.device,
                                'stage_device_to_NCh',
                                this.stage_device_to_NCh,
                                this.precision,
                                encoding.device,
                                '  [Device2Output : NChannel : {name}]| ({last}) > {data}'
                            );
                            break;
                        case 'int8':
                        case 'int16':
                            // intStageFn defaults to the generic
                            // stage_deviceN_to_int for channel counts > 4.
                            this.addStage(
                                encoding.device,
                                'stage_device_to_int',
                                intStageFn,
                                intSize,
                                encoding.device,
                                intStageDesc
                            );
                            break;
                    }
                    break;
            }
        }

        /**
         * Add an interpolation stage to the pipeline for the given LUT (CLUT
         * tag, A2B/B2A table, etc.). Picks the most-specialised single-colour
         * interpolator based on:
         *
         *   - lut.inputChannels  (1 / 2 / 3 / 4)
         *   - lut.outputChannels (3 / 4 / N)
         *   - this.interpolation3D / interpolation4D
         *   - inputEncoding (PCS-input gets trilinear; see B2A note below)
         *
         *  PCS-INPUT SPECIAL CASE
         *  For 3-channel input where the input encoding is PCSv2 / PCSv4 (Lab /
         *  XYZ), interpolation is forced to TRILINEAR even if the user asked for
         *  tetrahedral. This matches LittleCMS, SampleICC and Photoshop CS4
         *  behaviour: tetrahedral mis-samples Lab-encoded LUTs (luma is on one
         *  axis rather than diagonally) by up to ~4 LSB in some cells. Set
         *  useTrilinearFor3ChInput=false if you want to opt out (don't).
         *
         *  WHY THE 12-WAY DUPLICATION (3D × {3Ch, 4Ch, NCh}; 4D × {3Ch, 4Ch, NCh}
         *  × {single-colour, *_loop array}):
         *
         *  Empirical measurement: a single generic interpolator that handles
         *  all output-channel counts via a loop runs ~10–20x slower than the
         *  per-count unrolled variants. Worse, sharing inner code between the
         *  pipeline (single-colour, called via funct.call()) and the array
         *  loop (called once per image) POISONS the JIT — when both call
         *  sites hit the same function with different ABIs and array shapes,
         *  V8 deoptimises and the array path slows down 2-3x. Hence the two
         *  parallel families of *_NCh / _3Ch / _4Ch (single-colour, called
         *  from this method) and *Array_NCh_loop / _3Ch_loop / _4Ch_loop
         *  (image-grade, called from transformArrayViaLUT). Do not consolidate.
         *
         * @param {boolean} useTrilinearFor3ChInput  Apply the PCS-input override
         *                                           described above (typically true).
         * @param {number}  inputEncoding   One of encoding.* (see def.js).
         * @param {object}  lut             CLUT object with inputChannels,
         *                                  outputChannels, gridPoints, CLUT, ...
         * @param {number}  outputEncoding  One of encoding.* (see def.js).
         * @param {string} [debugFormat]    Per-stage pipelineDebug format string.
         * @throws {string} For unsupported channel counts or unknown
         *                  interpolation methods.
         */

        addStageLUT(useTrilinearFor3ChInput, inputEncoding, lut, outputEncoding, debugFormat){
            // ASK THE KERNEL THAT OWNS THIS DIMENSION. Until v1.6 this was a
            // ~120 line switch that picked the interpolator itself: by
            // lut.inputChannels, then by interpolation3D/4D, then by
            // interpolationFast, then by lut.outputChannels. Every one of those
            // is the kernel's own business, and the switch's top level was a
            // hand-maintained copy of the keys already in Transform.kernels.
            //
            // Keyed by the LUT's OWN input channels, not the Transform's. A
            // CMYK->RGB pipeline holds a 4-D A2B stage and a 3-D B2A stage at
            // once, so this could never have been `this.kernel`.
            //
            // The kernel decides; these are hints. It also returns the STAGE
            // NAME, because that string is a coupling surface -- compile()
            // resolves emitters as emit_js_<stageName> and optimisePipeline()
            // matches fusion patterns against a fixed list of them -- and
            // returning it from the kernel keeps the two from drifting apart.
            //
            // See docs/deepdive/KernelContract.md.
            var descriptor = Transform.kernels[lut.inputChannels];
            if(!descriptor || typeof descriptor.floatFor !== 'function'){
                throw 'Unsupported number of input channels "' + lut.inputChannels + '"';
            }

            var bind = descriptor.floatFor(lut, {
                inputEncoding:           inputEncoding,
                useTrilinearFor3ChInput: useTrilinearFor3ChInput,
                interpolation3D:         this.interpolation3D,
                interpolation4D:         this.interpolation4D,
                fast:                    this.interpolationFast,
                // floatFor runs on the DESCRIPTOR while the pipeline is still
                // being built — before init(), so a kernel cannot have stashed
                // anything yet. Its options have to arrive here or it cannot
                // make an options-dependent choice about the single-colour path
                // at all, which would leave a kernel able to change images but
                // not colours. See docs/deepdive/KernelContract.md.
                kernelOptions:           this.kernelOptions || null
            });

            this.addStage(inputEncoding, bind.stageName, bind.funct, lut, outputEncoding, debugFormat);
        };

        /**
         * Append a pre-built stage object to the pipeline. Bypasses createStage();
         * caller is responsible for the stage's shape (see _Stage typedef in def.js).
         * @param {object} stage
         */
        pushStage(stage){
            this.pipeline.push(stage);
        };

        /**
         * Construct a stage and append it to the pipeline. The pipeline runs each
         * stage's `funct` per colour as `funct.call(this, input, stageData, stage)`
         * — so stages can rely on `this` being the Transform.
         *
         * Used by the createPipeline() builders for built-in stages and by the
         * custom-stage injector (see customStages in the class JSDoc) for caller-
         * supplied stages.
         *
         * @param {number}   inputEncoding   One of encoding.* (def.js).
         * @param {string}   stageName       Human-readable name (debug/optimiser).
         * @param {Function} funct           (input, stageData, stage) => output
         * @param {*}        stageData       Arbitrary state available to funct.
         * @param {number}   outputEncoding  One of encoding.* (def.js).
         * @param {string}  [debugFormat]    pipelineDebug format string for this stage.
         */
        addStage(inputEncoding, stageName, funct, stageData, outputEncoding, debugFormat){
            this.pushStage(this.createStage(inputEncoding, stageName, funct, stageData, outputEncoding, debugFormat, false));
        };

        /**
         * Build a _Stage object — see addStage() for the call contract. Separated
         * out so the optimiser can synthesise replacement stages without pushing
         * them directly. `optimised: true` flags a stage as already-folded so the
         * optimiser does not try to fold it again.
         */
        createStage(inputEncoding,stageName, funct, stageData, outputEncoding, debugFormat, optimised){
            debugFormat = debugFormat || '';

            return {
                inputEncoding: inputEncoding,
                funct: funct,
                stageData: stageData,
                outputEncoding: outputEncoding,
                stageName: stageName,
                debugFormat: debugFormat,
                optimised: optimised
            };
        };


        /**
         *
         * @param profile
         * @param intent
         * @returns {boolean || _cmsXYZ}
         */
        detectOutputBlackpoint(profile, intent){
            var blackLab;
            var _this = this;
            var XYZ0 = this.XYZ(0,0,0);

            if(!profile){
                return XYZ0;
            }

            // note that *lab profiles have no black point and are 'abst'
            if(profile.header.pClass === 'link' || profile.header.pClass === 'abst'  || profile.header.pClass === 'nmcl'){
                return XYZ0;
            }

            // check intent
            if(intent === eIntent.absolute){
                return XYZ0;
            }

            if(profile.type === eProfileType.RGBMatrix){
                return XYZ0;
            }

            // v4 + perceptual & saturation intents have their own defined black point, and it is
            // well specified enough to use it. Black point tag is deprecated in V4.
            if((profile.version === 4) && (intent === eIntent.perceptual || intent === eIntent.saturation)){

                if(profile.type === eProfileType.RGBMatrix){
                    blackLab = this.RGBDevice_to_PCSv4_or_LabD50([0,0,0], profile, true);
                    return this.Lab2XYZ(blackLab);
                }

                // V4 perceptual black is predefined by the spec
                return this.XYZ( 0.00336, 0.0034731, 0.00287 );
            }

            // not a LUT based profile then calc as per input
            var hasLUT = !!profile.B2A[this.intent2LUTIndex(intent)];

            var colorSpaceCanUseBPC = (
                profile.type === eProfileType.Gray ||
                profile.type === eProfileType.RGBLut ||
                profile.type === eProfileType.CMYK
            )

            // Profile must be Gray, RGB or CMYK and be lut based B2A0 tag
            if(!colorSpaceCanUseBPC  || !hasLUT){
                // Else use input case
                return this.detectBlackpoint(profile, intent);
            }

            var initialLab;
            if(intent === eIntent.relative){
                initialLab = this.XYZ2Lab(this.detectBlackpoint(profile, intent), illuminant.d50);
            } else {
                initialLab = this.Lab(0,0,0);
            }

            // Step 2
            // Create a round trip. Define a Transform BT for all x in L*a*b*
            // PCS -> PCS round trip transform, always uses relative intent on the device -> pcs
            var labProfile = new Profile('*Lab');
            var transformLab2Device = new Transform({precision: 3});
            var transformDevice2Lab = new Transform({precision: 3});

            // Disable black point compensation Auto Enable in these temp transforms
            // or else we end up in an infinite loop and run out of stack
            transformLab2Device._BPCAutoEnable = false;
            transformDevice2Lab._BPCAutoEnable = false;

            transformLab2Device.create(labProfile, profile, intent);
            transformDevice2Lab.create(profile, labProfile, eIntent.relative);

            var inRamp = [];
            var outRamp = [];
            var lab = this.Lab(0,0,0);
            lab.a = Math.min(50, Math.max(-50, initialLab.a));
            lab.b = Math.min(50, Math.max(-50, initialLab.b));

            // Create ramp up the flag pole
            for (var l = 0; l < 256; l++) {
                lab.L = (l * 100.0) / 255.0;
                var device = transformLab2Device.transform(lab);
                var destLab = transformDevice2Lab.transform(device);
                inRamp[l]  = lab.L;
                outRamp[l] = destLab.L;
            }

            // Make monotonic, always decreasing,
            // this way we get the lowest black point
            for (l = 254; l > 0; --l) {
                outRamp[l] = Math.min(outRamp[l], outRamp[l+1]);
            }

            // Check
            if (! (outRamp[0] < outRamp[255])) {
                return XYZ0;
            }

            // Test for mid-range straight (only on relative colorimetric)
            var nearlyStraightMidrange = true;
            var minL = outRamp[0];
            var maxL = outRamp[255];
            if (intent === eIntent.relative) {
                for (l=0; l < 256; l++) {
                    if (! ((inRamp[l] <= minL + 0.2 * (maxL - minL) ) ||((inRamp[l] - outRamp[l]) < 4.0 ))){
                        nearlyStraightMidrange = false;
                        break;
                    }
                }
                // If the mid range is straight (as determined above) then the
                // DestinationBlackPoint shall be the same as initialLab.
                // Otherwise, the DestinationBlackPoint shall be determined
                // using curve fitting.
                if (nearlyStraightMidrange) {
                    return this.Lab2XYZ(initialLab);
                }
            }

            // curve fitting: The round-trip curve normally looks like a nearly constant section at the black point,
            // with a corner and a nearly straight line to the white point.
            var yRamp = [];
            var hi, lo;
            for (l = 0; l < 256; l++) {
                yRamp[l] = (outRamp[l] - minL) / (maxL - minL);
            }

            // find the black point using the least squares error quadratic curve fitting
            if (intent === eIntent.relative) {
                lo = 0.1;
                hi = 0.5;
            }
            else {
                // Perceptual and saturation
                lo = 0.03;
                hi = 0.25;
            }

            // Capture shadow points for the fitting.
            var n = 0;
            var x = [], y = [];
            for (l = 0; l < 256; l++) {
                var ff = yRamp[l];
                if (ff >= lo && ff < hi) {
                    x[n] = inRamp[l];
                    y[n] = yRamp[l];
                    n++;
                }
            }

            // No suitable points
            if (n < 3 ) {
                return XYZ0
            }

            // fit and get the vertex of quadratic curve
            lab.L = rootOfLeastSquaresFitQuadraticCurve(n, x, y);

            if (lab.L < 0.0) { // clip to zero L* if the vertex is negative OR
                lab.L = 0;
            }

            lab.a = initialLab.a;
            lab.b = initialLab.b;

            return this.Lab2XYZ(lab);

            // Least Squares Fit of a Quadratic Curve to Data
            // http://www.personal.psu.edu/jhm/f90/lectures/lsq2.html
            function rootOfLeastSquaresFitQuadraticCurve(n, x, y)
            {
                var  sum_x = 0, sum_x2 = 0, sum_x3 = 0, sum_x4 = 0;
                var sum_y = 0, sum_yx = 0, sum_yx2 = 0;
                var d, a, b, c;
                var i;

                if (n < 4) return 0;

                for (i=0; i < n; i++) {
                    var xn = x[i];
                    var yn = y[i];

                    sum_x  += xn;
                    sum_x2 += xn * xn;
                    sum_x3 += xn * xn * xn;
                    sum_x4 += xn * xn * xn * xn;

                    sum_y += yn;
                    sum_yx += yn*xn;
                    sum_yx2 += yn*xn*xn;
                }

                var matrix = [  n,      sum_x,  sum_x2,
                    sum_x,  sum_x2, sum_x3,
                    sum_x2, sum_x3, sum_x4 ];

                var invMatrix = _this.invertMatrix(matrix);

                var res = _this.evalMatrix([ sum_y, sum_yx, sum_yx2], invMatrix);
                a = res[2];
                b = res[1];
                c = res[0];

                if (a < 1.0E-10) {
                    return Math.min(0, Math.max(50, -c/b ));
                } else {
                    d = b * b - 4.0 * a * c;
                    if (d <= 0) {
                        return 0;
                    }
                    else {
                        var rt = (-b + Math.sqrt(d)) / (2.0 * a);
                        return Math.max(0, Math.min(50, rt));
                    }
                }
            }
        };

        /**
         *
         * @param profile
         * @param intent
         * @returns {boolean || _cmsXYZ}
         */
        detectBlackpoint(profile, intent){
            var XYZ0 = this.XYZ(0,0,0);

            if(!profile){
                return XYZ0;
            }

            if(profile.header.pClass === 'link' || profile.header.pClass === 'abst'  || profile.header.pClass === 'nmcl'){
                return XYZ0;
            }

            // check intent
            if(intent === eIntent.absolute){
                return XYZ0;
            }

            if(profile.type === eProfileType.RGBMatrix){
                return XYZ0;
            }

            // v4 + perceptual & saturation intents does have its own black point, and it is
            // well specified enough to use it. Black point tag is deprecated in V4.
            if((profile.version === 4) && (intent === eIntent.perceptual || intent === eIntent.saturation)){

                if(profile.type === eProfileType.RGBMatrix){
                    return this.Lab2XYZ(this.RGBDevice_to_PCSv4_or_LabD50([0,0,0], profile, true));
                }

                // V4 perceptual black is predefined by the spec
                return this.XYZ( 0.00336, 0.0034731, 0.00287 );
            }

            // v2 profile, we need to find the blackpoint
            if((profile.header.pClass === 'prtr' && profile.type === eProfileType.CMYK) && intent === eIntent.relative){
                // calculate blackpoint using perceptual black
                return this.Lab2XYZ( this.findInkLimitedBlackpoint(profile));
            }

            return this.Lab2XYZ(this.findMaxColourantBlackpoint(profile, intent));

        };

        findMaxColourantBlackpoint(profile, intent){
            var deviceWhite,deviceBlack;

            switch(profile.type){
                case eProfileType.Gray:
                    deviceWhite = convert.Gray(100);
                    deviceBlack = convert.Gray(0);
                    break;
                case eProfileType.Duo:
                   // throw new Error('Duo profiles not supported by Black Point Compensation');
                    deviceWhite = convert.Duo(100,100);
                    deviceBlack = convert.Duo(0,0);
                    break;
                case eProfileType.RGBLut:
                    deviceWhite = convert.RGB(255,255,255);
                    deviceBlack = convert.RGB(0,0,0);
                    break;
                case eProfileType.CMYK:
                    deviceWhite = convert.CMYK(0, 0, 0, 0);
                    deviceBlack = convert.CMYK(100, 100, 100, 100);
                    break;
                case eProfileType.Lab:
                    throw new Error('Lab profiles not supported by Black Point Compensation');
                default:
                    throw new Error( profile.type + ' not supported by Black Point Compensation');
            }

            var labD50 = new Profile('*Lab');
            var transformDevice2Lab = new Transform({precision: 3});

            // Disable auto BPC in these temp transforms
            transformDevice2Lab._BPCAutoEnable = false;

            transformDevice2Lab.create(profile, labD50, intent);
            var blackLab = transformDevice2Lab.transform(deviceBlack);
            var whiteLab = transformDevice2Lab.transform(deviceWhite);

            if(whiteLab.L < blackLab.L){
                // Just in case of inversion in number??
                blackLab = whiteLab;
            }

            blackLab.a = 0;
            blackLab.b = 0;
            if(blackLab.L > 50 || blackLab.L < 0){
                blackLab.L = 0;
            }

            return blackLab;
        };

        findInkLimitedBlackpoint(profile){
            /*CMYK devices are  usually ink-limited. For CMYK and multi-ink spaces, a roundtrip
            L*a*b*  Colorant  L*a*b* must be used. The first   conversion L*a*b*  Colorant computes the colorant
            associated to L*a*b* value of (0, 0, 0) by the perceptual intent.
            This returns the darkest ink-limited colorant combination as
            know by the profile. The next step is to get the real L*a*b* of
            this colorant, and this can be obtained by the Colorant L*a*b*
            conversion by using the relative colorimetric intent, which
            corresponds to the BToA1 tag. This effectively takes care of any
            ink-limit embedded in the profile. CMYK profiles used as input
            can use this method.*/

            var labD50 = new Profile('*Lab');

            var transformLab2Device = new Transform({precision: 3});
            var transformDevice2Lab = new Transform({precision: 3});

            // Disable auto BPC in these temp transforms
            transformDevice2Lab._BPCAutoEnable = false;
            transformDevice2Lab._BPCAutoEnable = false;

            //TODO change a multistep transform
            transformLab2Device.create(labD50, profile, eIntent.perceptual);
            transformDevice2Lab.create(profile, labD50, eIntent.relative);

            var device = transformLab2Device.transform(this.Lab(0,0,0));
            var blackLab = transformDevice2Lab.transform(device);

            if(blackLab.L > 50){
                blackLab.L = 50;
            }
            blackLab.a = blackLab.b = 0;

            return blackLab;
        };


        /**
         * POC monolithic-pipeline code generator.
         *
         * Walks the (already-optimised) stage list and asks each stage to emit a
         * straight-line block of JS that operates on a fixed set of semantic
         * scalar locals. There is no input/output variable tracking — by
         * convention each stage knows which names hold its inputs and where it
         * should write its outputs:
         *
         *      r,g,b               device RGB 0..1            (pipeline input)
         *      X,Y,Z               PCS XYZ 0..1
         *      pcsL,pcsa,pcsb      PCSv2 0..1
         *      d0..d7              device output 0..1         (pipeline output)
         *
         * Stage data that is too big to bake as numeric literals (curve tables,
         * CLUTs) is parked on a plain `store` object and read once at the top
         * of each emitted block. Matrix coefficients, scalar scaling factors,
         * D50 components, etc. are baked as numeric literals so V8 can fold
         * them into the emitted machine code.
         *
         * Stages dispatch by name:
         *   - emit_<target>_<stageName>(idx, stage, store)         → string of JS
         *   - attachStore_<target>_<stageName>(store, idx, stage)  → optional
         *
         * Currently only the chain used by RGB-matrix-shaper -> v2-LUT-CMYK
         * (sRGB → GRACoL etc.) is wired end-to-end:
         *      stage_Gamma_Inverse
         *      stage_matrix_rgb
         *      stage_PCSXYZ_to_PCSv2
         *      stage_curve_v2     (3-channel and 4-channel)
         *      trilinearInterp3D
         *
         * Stages without an emitter fall back to a runtime call into the
         * original stage funct via a per-call temp array — correct but slow,
         * useful as a "still-runs" guarantee while the emitter set grows.
         *
         * @param {object}  [options]
         * @param {string}  [options.target='js']      emit target (only 'js' for now)
         * @param {boolean} [options.instrument=false] Wrap each stage in a
         *      hrtime() timer that accumulates per-stage ns into store._instTime[].
         *      Tanks throughput (timer overhead is roughly the same magnitude as
         *      a stage's actual work) — only meaningful for relative comparisons.
         *      Read back via Transform.instrumentReport(compiled).
         * @param {boolean} [options.profilable=false] Lift each stage's body into
         *      its own NAMED function at factory scope (closed over the shared
         *      state vars). The per-pixel function then calls each named stage.
         *      Costs ~function-call overhead per stage but lets V8's CPU profiler
         *      (`node --prof`, Chrome DevTools, vmprof, etc.) attribute samples
         *      per stage instead of lumping them all into one giant compiled fn.
         *      Use this when you want the PROFILER to tell you which stage is
         *      hot, on real workloads, without timer-induced perturbation.
         * @param {boolean} [options.useGammaLUT=true] Replace `Math.pow` calls
         *      in inverse-gamma stages with a precomputed 4096-entry float LUT
         *      built once into `store.sN_gammaLut`. **This is the standard CMS
         *      curve-optimization trick** — Little CMS uses the same approach
         *      as its default fast path:
         *        - `lcms2/src/cmsopt.c` line 418:
         *              `#define PRELINEARIZATION_POINTS 4096`
         *          (identical table size to ours; their u16 path uses 256 / 65536
         *          for u8 / u16 input)
         *        - `lcms2/plugins/fast_float/src/fast_float_curves.c` line 393:
         *              `// Create linearization tables with a reasonable number
         *               // of entries. Precision is about 32 bits.`
         *          (their float-pipeline plugin uses the same Float32 LUT shape
         *           with the same accuracy classification)
         *      We default this on for parity with lcms — anyone who needs
         *      bit-exact `Math.pow` (measurement / oracle work) opts out with
         *      `{ useGammaLUT: false }`. Accuracy is "about 32 bits" per
         *      lcms's own classification — well below 1 code value at u8 / u16
         *      output, well above what 8-bit perceptual workflows can tell
         *      apart. Reclaims most of the ~70 % of body time the profiler
         *      attributes to `Math.pow(x, 2.4)` in the sRGB gamma stage.
         * @param {boolean} [options.strict=true] Throw if any pipeline stage has
         *      no `emit_<target>_*` function. The runtime-fallback path
         *      (`_compile_emit_runtime_fallback`) is best-effort and is known to
         *      produce wrong output across non-trivial encoding boundaries (e.g.
         *      CMYK→CMYK chains with `tetrahedralInterp4D`). Set `strict: false`
         *      to opt back into the fallback for stages you've audited yourself.
         * @param {boolean} [options.hotLoop=false] Emit the per-pixel body
         *      wrapped in a tight outer loop with signature
         *      `fn(inputArray, outputArray, pixelCount)`. Removes the result-array
         *      allocation per pixel and the call overhead of invoking `fn(input)`
         *      per pixel — the two biggest hidden costs above the body itself.
         *      `inputArray` and `outputArray` should be typed arrays
         *      (Float64Array / Float32Array) sized for `pixelCount` × stride.
         * @returns {{source:string, store:object, fn:function, mode:string}}
         */
        compile(options) {
            options = options || {};
            var target       = options.target || 'js';
            var instrument   = options.instrument === true;
            var profilable   = options.profilable === true;
            // useGammaLUT defaults TRUE — the LUT-substitution for Math.pow is
            // the standard CMS curve-optimization trick (lcms's cmsopt.c uses
            // a 4096-entry table as its default fast path; their fast_float
            // plugin classifies the accuracy as "about 32 bits"). Opt out for
            // bit-exact pow (measurement / oracle work) with { useGammaLUT: false }.
            var useGammaLUT  = options.useGammaLUT !== false;
            var strict       = options.strict !== false;     // default true
            var hotLoop      = options.hotLoop === true;

            if (instrument && profilable) {
                // Both modes rewrite the body shape; combining them is messy and
                // the profiler-visible numbers wouldn't be the real ones anyway.
                throw new Error('compile(): instrument and profilable are mutually exclusive');
            }
            if (hotLoop && profilable) {
                // hotLoop wraps a single body in an outer for-loop. profilable
                // splits the body across N named functions. Combining them
                // would put the function-call overhead inside the hot loop,
                // which defeats both modes. Pick one.
                throw new Error('compile(): hotLoop and profilable are mutually exclusive');
            }
            if (hotLoop && instrument) {
                throw new Error('compile(): hotLoop and instrument are mutually exclusive');
            }

            // Bundle the option set so emit/attach helpers can branch on it
            // (e.g. emit_js_stage_Gamma_Inverse switching between Math.pow and
            // a LUT lookup based on options.useGammaLUT).
            var compileOptions = {
                target:      target,
                instrument:  instrument,
                profilable:  profilable,
                useGammaLUT: useGammaLUT,
                strict:      strict,
                hotLoop:     hotLoop
            };

            if (!this.pipelineCreated || this.pipeline.length === 0) {
                throw 'No pipeline to compile';
            }

            var store = { _version: '1.2.0-poc' };
            var stageEntries = [];   // [{ idx, sname, header, body }]
            var coverage = { emitted: [], fallback: [] };

            // Instrumentation scaffolding: per-stage ns counters + call counters
            // + a captured hrtime() reference. We attach Number-typed-arrays so
            // the per-stage `+=` is a fast indexed double store, not a property
            // lookup against a sparse object.
            if (instrument) {
                var hr = (typeof process !== 'undefined' && process.hrtime && process.hrtime.bigint)
                    ? process.hrtime.bigint
                    : function () { return BigInt(Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) * 1e6)); };
                store._instHr     = hr;
                store._instCount  = 0;
                store._instTime   = new Float64Array(this.pipeline.length);
                store._instCalls  = new Uint32Array(this.pipeline.length);
                store._instLabels = new Array(this.pipeline.length);
            }

            for (var i = 0; i < this.pipeline.length; i++) {
                var stage   = this.pipeline[i];
                var sname   = stage.stageName;
                // Diagnostic stages (stage_debug, stage_history) are injected with
                // arbitrary, descriptive stageNames — 'Start', 'END', 'Black Point Info:',
                // etc. — but always with the same funct. Route them by funct identity
                // so a single emitter handles every name they take. Adding a new
                // descriptive marker later (e.g. 'BeforeCLUT') needs no compile-time
                // changes; it just becomes another no-op comment in the source.
                var emitName = sname;
                if      (stage.funct === this.stage_debug)   emitName = 'stage_debug';
                else if (stage.funct === this.stage_history) emitName = 'stage_history';
                var attachM  = 'attachStore_' + target + '_' + emitName;
                var emitM    = 'emit_' + target + '_' + emitName;

                if (typeof this[attachM] === 'function') {
                    this[attachM](store, i, stage, compileOptions);
                }

                if (instrument) store._instLabels[i] = sname;

                // Build the stage body, then optionally wrap in a per-stage timer.
                var header = '// ----- stage ' + i + ' : ' + sname + ' -----';
                var body;
                if (typeof this[emitM] === 'function') {
                    coverage.emitted.push(i + ':' + sname);
                    body = this[emitM](i, stage, store, compileOptions);
                } else {
                    coverage.fallback.push(i + ':' + sname);
                    if (strict) {
                        // Default path. The runtime fallback is best-effort and
                        // known to produce wrong output across non-trivial
                        // encoding boundaries (CMYK→CMYK chains with
                        // tetrahedralInterp4D and PCSv2_to_PCSv4 are the
                        // worked example). Fail fast and tell the caller
                        // exactly which emitter to add — much better than
                        // silently returning garbage colour.
                        throw new Error(
                            "compile(): no JS emitter for stage '" + sname + "' " +
                            "(index " + i + "). Add Transform.prototype.emit_" + target + "_" +
                            emitName + " (and optionally attachStore_" + target + "_" + emitName + ") " +
                            "or pass { strict: false } to use the runtime fallback (best-effort, " +
                            "may produce wrong output across encoding boundaries)."
                        );
                    }
                    store['_fb_' + i + '_funct']     = stage.funct;
                    store['_fb_' + i + '_stageData'] = stage.stageData;
                    store['_fb_' + i + '_self']      = this;
                    header = '// ----- stage ' + i + ' : ' + sname + ' (RUNTIME FALLBACK — best-effort) -----';
                    body   = this._compile_emit_runtime_fallback(i, stage);
                }

                stageEntries.push({ idx: i, sname: sname, header: header, body: body });
            }

            // Final return shape: derive from the last stage's outputEncoding /
            // from how many d-slots the pipeline filled. For the RGB→CMYK POC
            // we only need 4 device output channels.
            var lastStage = this.pipeline[this.pipeline.length - 1];
            var returnExpr = this._compile_emit_return(lastStage);

            var headerBanner =
                '// jsColorEngine compiled transform — target=' + target +
                    (instrument  ? '  [INSTRUMENTED — perf measurements only, do not ship]' : '') +
                    (profilable  ? '  [PROFILABLE — named per-stage fns for CPU profiler attribution]' : '') +
                    (hotLoop     ? '  [HOTLOOP — array-in / array-out tight loop wrapper]'             : '') +
                    (useGammaLUT ? '  [GAMMA-LUT — 4096-entry LUT replacing Math.pow (lcms parity, ~32-bit precision)]' : '') + '\n' +
                '// chain: ' + this.pipeline.map(function (s) { return s.stageName; }).join(' > ') + '\n' +
                '// inputs assumed: device RGB floats in input[0..2], 0..1\n';

            var src;
            var fn;
            var mode = profilable ? 'profilable' : (hotLoop ? 'hotLoop' : (instrument ? 'instrument' : 'plain'));

            if (hotLoop) {
                // -------- hot-loop mode --------
                // Wrap the per-pixel body in a tight outer for-loop and write
                // results straight into the caller's output buffer. Removes the
                // two biggest hidden costs above the body itself:
                //   1. the [d0,d1,d2,d3] array allocation per pixel (GC pressure)
                //   2. the function-call overhead of invoking fn(input) per pixel
                // V8 keeps the entire loop body in one TurboFan-compiled blob,
                // so register pressure for r,g,b,X,Y,Z,d0..d3 stays low.
                //
                // Signature: fn(input, output, n)
                //   input   — flat interleaved typed array, stride = inStride (3 for RGB)
                //   output  — flat interleaved typed array, stride = outStride (basis.length)
                //   n       — pixel count
                //   returns output (for chaining)
                var basis    = this._compile_output_basis();
                var outStride = basis.length;
                var inStride  = 3;   // POC: hardcoded RGB input. Will widen with CMYK-input emitters.

                var loopBodyParts = [];
                for (var hk = 0; hk < stageEntries.length; hk++) {
                    var heK = stageEntries[hk];
                    loopBodyParts.push('        ' + heK.header);
                    loopBodyParts.push(heK.body);
                }
                var writeOuts = [];
                for (var wo = 0; wo < basis.length; wo++) {
                    writeOuts.push('        output[_oi + ' + wo + '] = ' + basis[wo] + ';');
                }

                src =
                    headerBanner +
                    '"use strict";\n' +
                    'return function compiledTransformLoop(input, output, n) {\n' +
                    '    let r = 0, g = 0, b = 0;\n' +
                    '    let X = 0, Y = 0, Z = 0;\n' +
                    '    let pcsL = 0, pcsa = 0, pcsb = 0;\n' +
                    '    let d0 = 0, d1 = 0, d2 = 0, d3 = 0, d4 = 0, d5 = 0, d6 = 0, d7 = 0;\n' +
                    '    for (let _i = 0; _i < n; _i++) {\n' +
                    '        const _ii = _i * ' + inStride  + ';\n' +
                    '        const _oi = _i * ' + outStride + ';\n' +
                    '        r = input[_ii]; g = input[_ii + 1]; b = input[_ii + 2];\n' +
                    loopBodyParts.join('\n') + '\n' +
                    writeOuts.join('\n') + '\n' +
                    '    }\n' +
                    '    return output;\n' +
                    '};\n';

                fn = new Function('store', src)(store);
            } else if (profilable) {
                // -------- profilable mode --------
                // Lift each stage's body into its own named function expression
                // at FACTORY scope, closed over the shared state vars (r, g, b,
                // X, Y, Z, pcsL, pcsa, pcsb, d0..d7). Per-pixel fn is just a
                // straight-line list of named calls, so the V8 CPU profiler
                // attributes samples per stage instead of one giant compiled fn.
                //
                // Naming: each stage becomes  _s{idx}_{stageName_safe}  so the
                // profiler shows e.g. "_s0_stage_Gamma_Inverse" / "_s4_trilinearInterp3D".
                // Diagnostic stages (Start/END/history markers) get their own no-op
                // named functions too, so the profiler reports they were called.
                var safeName = function (s) { return s.replace(/[^A-Za-z0-9_]/g, '_'); };
                var stageDecls = [];
                var stageCalls = [];
                for (var k = 0; k < stageEntries.length; k++) {
                    var e   = stageEntries[k];
                    var fnm = '_s' + e.idx + '_' + safeName(e.sname);
                    stageDecls.push('  ' + e.header);
                    stageDecls.push('  function ' + fnm + '() {');
                    stageDecls.push(e.body);
                    stageDecls.push('  }');
                    stageDecls.push('');
                    stageCalls.push('    ' + fnm + '();');
                }

                var factorySrc =
                    headerBanner +
                    '"use strict";\n' +
                    '// shared state at factory scope — closed over by both stage fns and the per-pixel entry\n' +
                    'var r = 0, g = 0, b = 0;\n' +
                    'var X = 0, Y = 0, Z = 0;\n' +
                    'var pcsL = 0, pcsa = 0, pcsb = 0;\n' +
                    'var d0 = 0, d1 = 0, d2 = 0, d3 = 0, d4 = 0, d5 = 0, d6 = 0, d7 = 0;\n' +
                    '\n' +
                    stageDecls.join('\n') +
                    '\n' +
                    'return function compiledTransform(input) {\n' +
                    '    r = input[0]; g = input[1]; b = input[2];\n' +
                    stageCalls.join('\n') + '\n' +
                    '    ' + returnExpr + '\n' +
                    '};\n';
                src = factorySrc;
                fn  = new Function('store', factorySrc)(store);
            } else {
                // -------- plain or instrument mode --------
                // Both produce a single per-pixel function. Instrument adds
                // hrtime taps around each stage body; plain leaves them inline.
                var instrumentPrelude = instrument
                    ? '// instrumentation aliases (per-stage hrtime taps)\n' +
                      'const _hr        = store._instHr;\n' +
                      'const _instTime  = store._instTime;\n' +
                      'const _instCalls = store._instCalls;\n' +
                      'store._instCount++;\n'
                    : '';

                var bodyParts = [];
                for (var j = 0; j < stageEntries.length; j++) {
                    var ej = stageEntries[j];
                    bodyParts.push(ej.header);
                    if (instrument) {
                        bodyParts.push('{ const _tB = _hr();');
                        bodyParts.push(ej.body);
                        bodyParts.push('  const _tA = _hr(); _instTime[' + ej.idx + '] += Number(_tA - _tB); _instCalls[' + ej.idx + ']++; }');
                    } else {
                        bodyParts.push(ej.body);
                    }
                }

                src =
                    headerBanner +
                    '"use strict";\n' +
                    'var r = input[0], g = input[1], b = input[2];\n' +
                    'var X = 0, Y = 0, Z = 0;\n' +
                    'var pcsL = 0, pcsa = 0, pcsb = 0;\n' +
                    'var d0 = 0, d1 = 0, d2 = 0, d3 = 0, d4 = 0, d5 = 0, d6 = 0, d7 = 0;\n' +
                    '\n' +
                    instrumentPrelude +
                    bodyParts.join('\n') +
                    '\n' +
                    returnExpr + '\n';

                fn = new Function('store', 'input', src).bind(null, store);
            }

            return {
                source:   src,
                store:    store,
                fn:       fn,
                mode:     mode,
                options:  compileOptions,
                coverage: coverage
            };
        }

        /**
         * Format the per-stage instrumentation captured by an instrumented
         * compile()'d function. Pass the object returned by compile() — reads
         * compiled.store._instTime / _instCalls / _instCount / _instLabels.
         *
         * Returns a printable report string (also returned as `lines` array of
         * { stageName, calls, totalNs, perCallNs, percent }).
         *
         * Caveats: hrtime() itself adds ~50-100ns per measurement point, so the
         * absolute "ns per stage" values are inflated. RELATIVE proportions
         * (the percent column) are the trustworthy bit — that's what tells you
         * which stage is hottest. For an absolute number, run an uninstrumented
         * compile() on the same chain in parallel and compare totals.
         */
        static instrumentReport(compiled) {
            var s = compiled && compiled.store;
            if (!s || !s._instTime) {
                return 'instrumentReport: this compiled fn was not built with { instrument: true }';
            }
            var n      = s._instCount | 0;
            var labels = s._instLabels || [];
            var times  = s._instTime;
            var calls  = s._instCalls;

            var totalNs = 0;
            for (var i = 0; i < times.length; i++) totalNs += times[i];

            var lines = [];
            var rows  = [];
            lines.push('===== per-stage instrumentation report =====');
            lines.push('runs:        ' + n + ' calls of compiled fn');
            lines.push('total time:  ' + (totalNs / 1e6).toFixed(2) + ' ms across all stages');
            lines.push('per-call:    ' + (n > 0 ? (totalNs / n).toFixed(1) : '?') + ' ns/pixel (sum of stages, includes timer overhead)');
            lines.push('');
            lines.push('  idx  stage                                       calls         %       ns/call');
            lines.push('  ---  ------------------------------------------  ----------  -------  --------');
            for (var i = 0; i < times.length; i++) {
                var pct       = totalNs > 0 ? (100 * times[i] / totalNs) : 0;
                var perCallNs = calls[i] > 0 ? (times[i] / calls[i])     : 0;
                var label     = labels[i] || '?';
                if (label.length > 42) label = label.slice(0, 39) + '...';
                label = label.padEnd(42, ' ');
                var idxStr    = String(i).padStart(3, ' ');
                var callStr   = String(calls[i]).padStart(10, ' ');
                var pctStr    = pct.toFixed(2).padStart(6, ' ') + '%';
                var perStr    = perCallNs.toFixed(1).padStart(8, ' ');
                lines.push('  ' + idxStr + '  ' + label + '  ' + callStr + '  ' + pctStr + '  ' + perStr);
                rows.push({ stageName: labels[i], calls: calls[i], totalNs: times[i], perCallNs: perCallNs, percent: pct });
            }
            return { text: lines.join('\n'), rows: rows, totalNs: totalNs, runs: n };
        }

        /** Reset the per-stage counters on an instrumented compiled fn (for warmup). */
        static instrumentReset(compiled) {
            var s = compiled && compiled.store;
            if (!s || !s._instTime) return;
            s._instCount = 0;
            s._instTime.fill(0);
            s._instCalls.fill(0);
        }

        /** Runtime fallback for stages without a JS emitter. */
        _compile_emit_runtime_fallback(idx, stage) {
            // Best-effort: feed whichever set of locals the stage's input
            // encoding implies, into a temp array, call the original funct,
            // then unpack into whichever set the output encoding implies.
            // Conservative — just enough to keep the chain runnable until a
            // real emitter lands.
            var inEnc  = stage.inputEncoding;
            var outEnc = stage.outputEncoding;

            var inVars  = this._compile_basis_for(inEnc);
            var outVars = this._compile_basis_for(outEnc);

            var lines = [];
            lines.push('{');
            lines.push('  var _in = [' + inVars.join(', ') + '];');
            lines.push('  var _out = store._fb_' + idx + '_funct.call(store._fb_' + idx + '_self, _in, store._fb_' + idx + '_stageData, null);');
            for (var c = 0; c < outVars.length; c++) {
                lines.push('  ' + outVars[c] + ' = _out[' + c + '];');
            }
            lines.push('}');
            return lines.join('\n');
        }

        /** Map a stage encoding + a default channel count to local names. */
        _compile_basis_for(encoding) {
            // 1 = PCSv2, others (0 device, 2 PCSv4, 3 PCSXYZ) → keep simple defaults.
            // The fallback only fires for stages we haven't emitted yet, so this
            // table is intentionally tiny — extend as new emitters land.
            if (encoding === 3 /* PCSXYZ */) return ['X', 'Y', 'Z'];
            if (encoding === 1 /* PCSv2 */)  return ['pcsL', 'pcsa', 'pcsb'];
            if (encoding === 2 /* PCSv4 */)  return ['pcsL', 'pcsa', 'pcsb'];
            // device (0) or unknown → assume 4-channel device for output stages
            // and 3-channel for input stages. This is rough; the POC chain
            // never exercises the fallback so the rough heuristic is fine.
            return ['d0', 'd1', 'd2', 'd3'];
        }

        /** Resolve the output variable list (e.g. ['d0','d1','d2','d3']) for the
         *  pipeline by walking back from the last stage to the last one that
         *  carries informative outputEncoding (END/debug markers don't). */
        _compile_output_basis() {
            var lastStage = this.pipeline[this.pipeline.length - 1];
            var outEnc = lastStage && lastStage.outputEncoding;
            var basis  = this._compile_basis_for(outEnc);
            if (outEnc === false || outEnc == null) {
                for (var i = this.pipeline.length - 1; i >= 0; i--) {
                    if (this.pipeline[i].outputEncoding !== false && this.pipeline[i].outputEncoding != null) {
                        basis = this._compile_basis_for(this.pipeline[i].outputEncoding);
                        break;
                    }
                }
            }
            return basis;
        }

        /** Emit the final `return [...]` based on the last stage's output. */
        _compile_emit_return(lastStage) {
            var basis = this._compile_output_basis();
            return 'return [' + basis.join(', ') + '];';
        }
    }

    ////////////////////////////////////////////////////////////////////////////////
    //
    //  Helpers
    //



    function uint8ArrayToBase64(uint8Array) {
        var binaryString = '';

        for (var byte of uint8Array) {
            binaryString += String.fromCharCode(byte);
        }

        return btoa(binaryString);
    }
    function uint16ArrayToBase64(uint16Array) {
        var uint8Array = new Uint8Array(uint16Array.buffer);
        var binaryString = '';

        for (var byte of uint8Array) {
            binaryString += String.fromCharCode(byte);
        }

        return btoa(binaryString);
    }
    function base64ToUint16Array(base64String) {
        let binaryString = atob(base64String);
        let len = binaryString.length;
        let bytes = new Uint8Array(len);

        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        return new Uint16Array(bytes.buffer);
    }
    function base64ToUint8Array(base64String) {
        let binaryString = atob(base64String);
        let len = binaryString.length;
        let bytes = new Uint8ClampedArray(len);

        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        return bytes;
    }


    // ─── JSON LUT format helpers ─────────────────────────────────────────────────
    //
    // The portable JSON shape:
    //   { ..., dataType: 'u16'|'u8', precision: 16|8, encoding: 'base64', CLUT: '<b64>' }
    //
    // _decodeLutCLUT mutates `lut.CLUT` in place: base64 → typed array → f64 [0..1].
    // Both Transform.setLut and Transform.jsonToLut call this. Single source of
    // truth for what "decoded LUT" means.

    function _decodeLutCLUT(lut){
        // Decode base64 if needed
        if(lut.encoding === 'base64'){
            if(lut.precision === 16 || lut.dataType === 'u16'){
                lut.CLUT = base64ToUint16Array(lut.CLUT);
            } else {
                lut.CLUT = base64ToUint8Array(lut.CLUT);
            }
            lut.encoding = 'number';
        }
        // Normalise to Float64Array [0..1]
        var clut = lut.CLUT;
        if(clut instanceof Uint16Array){
            var f64 = new Float64Array(clut.length);
            for(var i = 0; i < clut.length; i++) f64[i] = clut[i] / 65535;
            lut.CLUT = f64;
        } else if(clut instanceof Uint8Array || clut instanceof Uint8ClampedArray){
            var f64 = new Float64Array(clut.length);
            for(var i = 0; i < clut.length; i++) f64[i] = clut[i] / 255;
            lut.CLUT = f64;
        }
        lut.dataType = 'f64';

        // Regenerate strides from gridPoints + outputChannels (spec §5.2: strides
        // are derived, not serialised — recomputing avoids stale strides if the
        // JSON was hand-edited or produced by an older format version).
        if(lut.gridPoints && lut.outputChannels !== undefined){
            var gp = lut.gridPoints;
            var oc = lut.outputChannels;
            var g1 = gp[0];
            var g2 = (gp.length >= 2) ? g1 * gp[1] : 0;
            var g3 = (gp.length >= 3) ? g2 * gp[2] : 0;
            lut.g1  = g1;
            lut.g2  = g2;
            lut.g3  = g3;
            lut.go0 = oc;
            lut.go1 = g1 * oc;
            lut.go2 = g2 * oc;
            lut.go3 = g3 * oc;
        }
        return lut;
    }

    // Encode an f64 LUT object to portable JSON shape with u16 (default) or u8
    // base64 CLUT. `intLut` is stripped (kernel-internal artifact, not portable).
    // Output is a plain object — caller stringifies (or hands to JSON.stringify).
    function _lutToJSONShape(lutObj, opts){
        if(!lutObj || !lutObj.CLUT) throw 'lutToJSON: input has no CLUT';
        opts = opts || {};
        var dataType = opts.dataType || 'u16';
        if(dataType !== 'u16' && dataType !== 'u8')
            throw 'lutToJSON: dataType must be "u16" or "u8", got "' + dataType + '"';

        var src = lutObj.CLUT;
        var n   = src.length;
        var encoded, precision;

        if(dataType === 'u16'){
            // Quantise from whatever the source is to u16 [0..65535]
            var u16 = new Uint16Array(n);
            if(src instanceof Uint16Array){
                u16.set(src);
            } else if(src instanceof Uint8Array || src instanceof Uint8ClampedArray){
                for(var i = 0; i < n; i++) u16[i] = src[i] * 257; // lossless 0..255 → 0..65535
            } else {
                // Float64Array / Float32Array / plain Array — assume [0..1]
                for(var i = 0; i < n; i++) u16[i] = Math.round(Math.min(1, Math.max(0, src[i])) * 65535);
            }
            encoded = uint16ArrayToBase64(u16);
            precision = 16;
        } else {
            // u8 — lossy re-quantisation
            var u8 = new Uint8Array(n);
            if(src instanceof Uint8Array || src instanceof Uint8ClampedArray){
                u8.set(src);
            } else if(src instanceof Uint16Array){
                for(var i = 0; i < n; i++) u8[i] = Math.round(src[i] / 65535 * 255);
            } else {
                for(var i = 0; i < n; i++) u8[i] = Math.round(Math.min(1, Math.max(0, src[i])) * 255);
            }
            encoded = uint8ArrayToBase64(u8);
            precision = 8;
        }

        // Output: metadata, then everything from the lut except CLUT/intLut,
        // strides (g1-3, go0-3, derived), and inputScale/outputScale (kernel
        // helpers — see below). Strides are regenerated on decode (spec §5.2).
        //
        // inputScale/outputScale are stripped from `lutObj` and forced to canonical
        // 1/1 in the output: the encoded CLUT is canonical u16 full-scale
        // [0..65535] which represents device [0..1], so the portable format always
        // says 1/1. The engine may set these to non-1 values internally during u8
        // dispatch (e.g. outputScale=255 for u8 output, inputScale=1/255 for u8
        // input), but those are kernel-internal scaling parameters and don't
        // belong in the wire format.
        var SKIP_FIELDS = {
            g1:1, g2:1, g3:1, go0:1, go1:1, go2:1, go3:1,
            inputScale:1, outputScale:1,
        };
        var out = {
            created:   new Date().toISOString(),
            generator: opts.generator || 'jsColorEngine',
        };
        for(var k in lutObj){
            if(k !== 'CLUT' && k !== 'intLut' && !SKIP_FIELDS[k]) out[k] = lutObj[k];
        }
        out.dataType    = dataType;
        out.precision   = precision;
        out.encoding    = 'base64';
        out.inputScale  = 1;   // canonical — the encoded CLUT is canonical full-scale
        out.outputScale = 1;
        out.CLUT        = encoded;

        // Sign on export — lazy. If the lut already has an originalSignature
        // (LutBuilder.fromTransform / createFromLCMS stamp at extraction), preserve
        // it. Otherwise compute from current data so the JSON has a valid integrity
        // marker for transit verification (setLut({ verify: true }) on the consumer).
        out.originalSignature = lutObj.originalSignature || _computeSignature(lutObj);
        return out;
    }


    // ─── LUT signature (FNV-1a 32-bit fingerprint) ────────────────────────────────
    //
    // A lightweight content fingerprint over (inCh, outCh, gridPoints, chain,
    // u16 CLUT bytes). Lets callers detect whether a LUT has been mutated since
    // it was extracted (LutBuilder.fromTransform / createFromLCMS) or in transit
    // from one process to another (toJSON → fromJSON with verify: true).
    //
    // Algorithm-prefixed format ("FNV1A:<8 hex>") so we can swap to a stronger
    // hash later (e.g. "SHA256:...") without breaking the wire format. Not
    // cryptographic — fingerprint only. For adversarial tamper-evidence, sign
    // JSON.stringify(json) externally with crypto.
    //
    // Implementation note: 32-bit Math.imul-based FNV-1a is the fastest pure-JS
    // option (single CPU instruction per byte in V8). 4B collision space is plenty
    // for content hashing — collisions in practice are zero. Avoids BigInt, which
    // is 10×+ slower for byte-stream hashing.

    function _fnv1a32(bytes){
        var h = 0x811c9dc5;          // FNV-1a 32-bit offset basis
        var prime = 0x01000193;      // FNV-1a 32-bit prime
        for(var i = 0; i < bytes.length; i++){
            h = Math.imul(h ^ bytes[i], prime);
        }
        return ((h >>> 0).toString(16)).padStart(8, '0');
    }

    function _stringToBytes(s){
        // ASCII-fast path. Chain entries / shape fields are well within ASCII;
        // any non-ASCII byte gets truncated to the low 8 bits — stable but lossy.
        var bytes = new Uint8Array(s.length);
        for(var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
        return bytes;
    }

    function _signatureBytes(lut){
        // Canonical chain serialisation — only routing-critical fields (name|type|version)
        // and intent numbers. Avoids JSON object-key ordering instability.
        var chainSig = '';
        if(Array.isArray(lut.chain)){
            var parts = [];
            for(var i = 0; i < lut.chain.length; i++){
                var s = lut.chain[i];
                if(typeof s === 'number'){
                    parts.push('I' + s);
                } else if(s && (s.header || s.name)){
                    parts.push((s.name || '') + '|' + (s.type|0) + '|' + (s.version|0));
                }
            }
            chainSig = parts.join('::');
        }

        var prefix = 'IO:' + (lut.inputChannels|0) + ':' + (lut.outputChannels|0)
                   + ';GP:' + (lut.gridPoints ? lut.gridPoints.join(',') : '')
                   + ';CH:' + chainSig
                   + ';CLUT:';
        var prefixBytes = _stringToBytes(prefix);

        // CLUT as u16 full-scale bytes — same canonical form regardless of how
        // the lut was originally stored (f64, u16, u8, base64).
        var clut = lut.CLUT;
        var clutBytes;
        if(clut instanceof Uint16Array){
            clutBytes = new Uint8Array(clut.buffer, clut.byteOffset, clut.byteLength);
        } else if(clut instanceof Uint8Array || clut instanceof Uint8ClampedArray){
            // u8 [0..255] → u16 [0..65535] via lossless bit-stretch
            var u16a = new Uint16Array(clut.length);
            for(var i = 0; i < clut.length; i++) u16a[i] = clut[i] * 257;
            clutBytes = new Uint8Array(u16a.buffer);
        } else {
            // Float64Array [0..1] → u16 [0..65535]
            var u16b = new Uint16Array(clut.length);
            for(var i = 0; i < clut.length; i++){
                u16b[i] = Math.round(Math.min(1, Math.max(0, clut[i])) * 65535);
            }
            clutBytes = new Uint8Array(u16b.buffer);
        }

        var combined = new Uint8Array(prefixBytes.length + clutBytes.length);
        combined.set(prefixBytes, 0);
        combined.set(clutBytes, prefixBytes.length);
        return combined;
    }

    /**
     * Can this Transform be reproduced from its LUT alone?
     *
     * The multicore path ships the LUT to workers and rebuilds there, so it is
     * only correct where a LUT-rebuilt Transform is byte-identical to this one.
     * That holds for the ordinary 1D-4D LUT paths and does NOT hold for
     * N-channel output, which walks the pipeline — a LUT-only rebuild there
     * produced 27,204 wrong bytes in 35,000 (max delta 254).
     *
     * Proving it on a probe beats enumerating the safe cases: it stays correct
     * when new paths are added, and it fails closed.
     */
    /**
     * Describe a profile chain without hashing megabytes of decoded tags.
     * Virtual profiles are strings; real ones are named by what identifies
     * them on disc.
     */
    function _describeChain(chain){
        if(!Array.isArray(chain)) return [];
        return chain.map(function(slot, i){
            if(i % 2) return {intent: slot};
            if(typeof slot === 'string') return {virtual: slot};
            return {
                name:     slot && slot.name,
                type:     slot && slot.type,
                channels: slot && slot.outputChannels,
                bytes:    slot && slot.header && slot.header.profileSize
            };
        });
    }

    /**
     * Describe a built LUT: shape, precision and size, but never its contents.
     * Returns `false` when there is no LUT, so the absence is a value that
     * survives JSON rather than a missing key.
     */
    function _describeLut(lut, signature){
        if(!lut) return false;

        var out = {
            signature:      signature,
            version:        lut.version,
            inputChannels:  lut.inputChannels,
            outputChannels: lut.outputChannels,
            gridPoints:     Array.isArray(lut.gridPoints)
                                ? lut.gridPoints.slice() : lut.gridPoints,
            dataType:       lut.dataType,
            encoding:       lut.encoding,
            precision:      lut.precision,
            inputScale:     lut.inputScale,
            outputScale:    lut.outputScale,
            gamutMode:      lut.gamutMode,
            gamutLimit:     lut.gamutLimit,
            gamutMapScale:  lut.gamutMapScale,
            inLab:          lut.inLab,
            outLab:         lut.outLab,
            cells:          lut.CLUT ? lut.CLUT.length : 0,
            bytes:          lut.CLUT ? lut.CLUT.byteLength : 0,
            intLut:         false
        };

        // The int path keeps a SECOND, quantised table alongside the f64 one,
        // and it is the one the fast kernels actually read. A master/worker
        // pair can agree on every field above and still differ here, which is
        // exactly the mismatch this whole structure exists to catch.
        if(lut.intLut){
            out.intLut = {
                dataType:         lut.intLut.dataType,
                scale:            lut.intLut.scale,
                accWidth:         lut.intLut.accWidth,
                gpsPrecisionBits: lut.intLut.gpsPrecisionBits,
                inputChannels:    lut.intLut.inputChannels,
                outputChannels:   lut.intLut.outputChannels,
                cells:            lut.intLut.CLUT ? lut.intLut.CLUT.length : 0,
                bytes:            lut.intLut.CLUT ? lut.intLut.CLUT.byteLength : 0
            };
        }
        return out;
    }

    /**
     * Is this field allowed to differ between master and worker?
     *
     * Returns why, or null when the difference is a genuine fault. Kept as an
     * explicit short list rather than a loose prefix match, so a new
     * divergence shows up as a fault instead of being quietly absorbed by an
     * over-broad rule.
     *
     * @param {string} mode  'lut' or 'chain'
     * @param {string} path  dotted path into getInfo()
     * @returns {string|null}
     */
    function _expectedDivergence(mode, path){
        // getOptions() reports the RESOLVED lutMode, and that is what the
        // worker is handed — so the worker asked for 'float' explicitly where
        // the master asked for 'auto' and resolved to 'float'. `lutMode`
        // itself must still match, and does; only the request differs.
        if(path === 'options.lutModeRequested'){
            return 'master resolved this from "auto"; the worker was handed the resolved value';
        }

        if(mode === 'lut'){
            // A mode-1 worker is built by setLut() from a bare table. It has
            // no Profile objects at all, so anything describing them is
            // absent by construction — and irrelevant, since conversion only
            // reads the LUT.
            if(path === 'chain' || path.indexOf('chain[') === 0 ||
               path.indexOf('chain.') === 0){
                return 'worker rebuilt from the LUT alone and holds no profiles';
            }
            // setLut() decodes the CLUT in place, which rescales it. Master
            // and worker hold the same table in two encodings.
            if(path === 'lut.outputScale' || path === 'lut.inputScale' ||
               path === 'lut.dataType'    || path === 'lut.encoding'){
                return 'setLut() decodes the table in place, changing its encoding';
            }
            if(path === 'options.buildLut'){
                return 'the worker builds from a supplied LUT rather than baking one';
            }
        }

        return null;
    }

    /**
     * Structural diff of two getInfo() results. Reports the first difference
     * per path rather than a deep dump, because the useful output is "worker 3
     * has a float LUT" and not the two LUTs side by side.
     */
    function _diffInfo(master, worker, path, index, out){
        if(master === worker) return;

        var mType = Object.prototype.toString.call(master);
        var wType = Object.prototype.toString.call(worker);

        if(mType !== wType || mType !== '[object Object]'){
            if(mType === '[object Array]' && wType === '[object Array]'){
                if(master.length !== worker.length){
                    out.push({worker: index, path: path + '.length',
                              master: master.length, value: worker.length});
                    return;
                }
                for(var a = 0; a < master.length; a++){
                    _diffInfo(master[a], worker[a], path + '[' + a + ']', index, out);
                }
                return;
            }
            out.push({worker: index, path: path || '(root)',
                      master: master, value: worker});
            return;
        }

        var keys = Object.keys(master);
        for(var k = 0; k < keys.length; k++){
            var key = keys[k];
            _diffInfo(master[key], worker[key],
                      path ? path + '.' + key : key, index, out);
        }
    }

    function _probeLutEquivalence(transform, flags){
        try {
            var inCh = transform.inputChannels + (flags.inputHasAlpha ? 1 : 0);
            if(!inCh || inCh < 1) return false;

            var px = 256;
            var probe = new Uint8ClampedArray(px * inCh);
            var seed = 0x13579bdf;
            for(var i = 0; i < probe.length; i++){
                seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
                probe[i] = (seed >>> 23) & 0xff;      // spread, not the low-bit trap
            }

            var here = transform.transformArray(probe, flags.inputHasAlpha,
                flags.outputHasAlpha, flags.preserveAlpha, px);

            // setLut() MUTATES the LUT it is given — it decodes the CLUT and
            // normalises the chain in place — so handing it this Transform's
            // own LUT corrupts the Transform being probed, and every later
            // conversion with it. Clone first. (The worker path is unaffected:
            // postMessage structured-clones on the way out.)
            var copy = (typeof structuredClone === 'function')
                ? structuredClone(transform.lut)
                : null;
            if(!copy) return false;                      // no safe way to probe

            var rebuilt = new Transform({
                dataFormat: 'int8',
                lutMode: transform.lutMode,
                buildLut: true
            });
            rebuilt.setLut(copy);
            var there = rebuilt.transformArray(probe, flags.inputHasAlpha,
                flags.outputHasAlpha, flags.preserveAlpha, px);

            if(!here || !there || here.length !== there.length) return false;
            for(var j = 0; j < here.length; j++){
                if(here[j] !== there[j]) return false;   // exact, not "close"
            }
            return true;

        } catch(e){
            return false;                                // fail closed
        }
    }

    function _computeSignature(lut){
        return 'FNV1A:' + _fnv1a32(_signatureBytes(lut));
    }



    // ---------------------------------------------------------------------------
    // Class statics — dispatch thresholds, magic numbers, etc.
    // ---------------------------------------------------------------------------

    // Minimum pixelCount for the WASM 3D tetrahedral dispatcher to kick in.
    // Below this, the per-call memcpy-in / kernel-call / memcpy-out overhead
    // exceeds the arithmetic savings of the WASM kernel, and the JS 'int'
    // kernel is actually faster.
    //
    // Chosen at 256 as an initial conservative value — will be profiled and
    // re-tuned in the v1.2 main work using bench/wasm_dispatch_threshold.js
    // (sweeping 100/200/300/400 pixel-counts, per user plan). Setting this
    // from outside (Transform.WASM_DISPATCH_MIN_PIXELS = 0) is a valid
    // escape hatch for pathological test cases that want to force WASM on
    // single-pixel loops.
    Transform.WASM_DISPATCH_MIN_PIXELS = 256;

    // ---------------------------------------------------------------------------
    // Plugin architecture — register
    // ---------------------------------------------------------------------------
    //
    // The descriptor IS the plugin — a plain object you can export from a package,
    // import, and pass directly to Transform.register().  Both name and lutMode
    // live inside the descriptor; no positional arguments.
    //
    //   export const MyPlugin = { name: 'my-plugin', lutMode: 'my-mode', kernel: ... };
    //   Transform.register(MyPlugin);
    //
    // After registration: new Transform({ lutMode: 'my-mode' }) is accepted.
    //
    // Licensing note: the core engine (MPL-2.0) provides the hooks; the other
    // packages can uses their onw licneses.

    /**
     * Defaults that MOVE OUTPUT, per release. One entry per version whose
     * defaults changed; anything not listed did not change.
     *
     * 1.5  — `wasmMatrixShaper` defaults to 'auto' from 1.5.5, which puts the
     *        WASM matrix-shaper kernel on the no-LUT int8/int16 RGB->RGB path.
     *        That is within 1 LSB of the stage pipeline it replaced, and
     *        measurably CLOSER to the exact maths than the CLUT alternative —
     *        but it is not byte-identical to 1.5.0, so a caller pinned to
     *        byte-for-byte reproducibility needs it off.
     */
    Transform.COMPAT_DEFAULTS = {
        '1.5': { wasmMatrixShaper: false }
    };
    Transform._compatVersion = null;

    /**
     * Normalise one image descriptor: data, alpha, channel counts, pixel count.
     *
     * `pixelCount` IS OPTIONAL. Once the alpha flags are resolved the stride is
     * known, so the count follows from the array length — and a caller who is
     * decoding a file already has the array and would rather not restate what
     * it obviously contains.
     *
     * It is still worth passing when the buffer is BIGGER than the image: a
     * pooled or reused array, or a slab holding several frames. Inference would
     * happily convert the padding. So an explicit count wins, and is checked
     * against the array rather than trusted — a count that overruns is a buffer
     * overrun waiting to happen, and it costs one comparison per image to
     * refuse it.
     */
    function _imagePlan(transform, img, batch, id){
        if(!img || !img.data) throw new Error(
            'transformImages: image "' + id + '" has no `data`.');

        var f = _imageAlpha(img, batch);
        var inCh  = transform.inputChannels  + (f.inputHasAlpha  ? 1 : 0);
        var outCh = transform.outputChannels + (f.outputHasAlpha ? 1 : 0);
        var len = img.data.length;
        var px  = img.pixelCount;

        if(px === undefined || px === null){
            px = len / inCh;
            if(px !== Math.floor(px)) throw new Error(
                'transformImages: image "' + id + '" has ' + len + ' values, which is ' +
                'not a whole number of ' + inCh + '-channel pixels' +
                (f.inputHasAlpha ? ' (including alpha)' : '') +
                '. Pass `pixelCount` explicitly, or check the alpha flags.');
        } else if(px * inCh > len){
            throw new Error(
                'transformImages: image "' + id + '" declares pixelCount ' + px +
                ' x ' + inCh + ' channels = ' + (px * inCh) + ' values, but `data` ' +
                'holds ' + len + '. Reading it would overrun the buffer.');
        }

        return {data: img.data, pixelCount: px, inChannels: inCh,
                outChannels: outCh, flags: f};
    }

    /**
     * One image's alpha flags: its own if it states them, the batch's if not.
     *
     * `preserveAlpha` follows the same rule transformArray uses — undefined
     * means "preserve if both sides have one" — so an image that declares
     * alpha in and out gets it preserved without having to say so a third time.
     */
    function _imageAlpha(img, batch){
        var inA  = (img && img.inputHasAlpha  !== undefined) ? !!img.inputHasAlpha  : !!batch.inputHasAlpha;
        var outA = (img && img.outputHasAlpha !== undefined) ? !!img.outputHasAlpha : !!batch.outputHasAlpha;
        var pre;
        if(img && img.preserveAlpha !== undefined)  pre = !!img.preserveAlpha;
        else if(batch._preserveStated)              pre = !!batch.preserveAlpha;
        else                                        pre = (inA && outA);
        return {inputHasAlpha: inA, outputHasAlpha: outA, preserveAlpha: pre && inA};
    }

    /**
     * Multicore was asked for and cannot be had. Say so ONCE, actionably, and
     * carry on correctly.
     *
     * NOT A THROW, by default. `transformImages()` promises multicore is an
     * optimisation and never a capability — isomorphic code must not pass in
     * Node and fail in a browser, and the same call is also the batch API
     * (per-image callbacks, queue depth, cancellation) which a caller may want
     * regardless of thread count. But silence is the other failure: a
     * developer who asked for parallelism should not discover months later
     * that they never got it. So: warn once, with the fix in the message, the
     * same shape as the hooks-cannot-cross-a-boundary warning.
     *
     * `requireWorkers: true` is for callers who would genuinely rather fail.
     */
    function _noWorkers(transform, opts, runSequential){
        var why = _pool.unavailableReason();
        if(opts && opts.requireWorkers === true){
            return Promise.reject(new Error(
                'jsColorEngine: transformImages was called with requireWorkers:true ' +
                'and no workers are available. ' + why +
                ' Drop requireWorkers to run sequentially instead — the results are ' +
                'identical either way.'));
        }
        if(!Transform._warnedNoWorkers){
            Transform._warnedNoWorkers = true;
            console.warn('jsColorEngine: transformImages is running SEQUENTIALLY. ' +
                why + ' The results are identical and your onImage callbacks still ' +
                'fire — only the speed differs. Pass requireWorkers:true if you would ' +
                'rather this were an error.');
        }
        return runSequential();
    }
    Transform._warnedNoWorkers = false;

    // Set by Transform.enablePool(); null means batches are not defaulted to
    // the pool. Holds the normalised options so every batch gets the worker
    // count the caller asked for at startup.
    Transform._poolDefault = null;
    Transform._poolInfo = null;
    Transform._warnedPoolReconfig = false;

    Transform._plugins = Object.create(null);  // lutMode → plugin descriptor

    /**
     * Register a complete plugin from a plain descriptor object.
     *
     * The descriptor is the distributable unit — export it from a package and
     * callers pass it directly:
     *
     *   Transform.register(CustomPlugin);
     *   Transform.register(TotalInkPlugin);
     *
     * @param {object} descriptor   Plugin descriptor — all fields except name,
     *                              lutMode, and kernel are optional:
     *
     *   descriptor.name    (string, required) — human-readable identifier used in
     *                              error messages and Transform.registered().
     *
     *   descriptor.lutMode (string, required) — the lutMode value users set on the
     *                              Transform constructor: new Transform({ lutMode: 'johnCustom' }).
     *                              Dispatcher key; must not collide with a built-in
     *                              mode (float, int, int16, int-wasm-*, int16-wasm-*).
     *
     *   Kernel (hot-path dispatch — resolved once at create() time):
     *     opts.kernel(transform, inputArray, outputArray, pixelCount, lut,
     *                 inputHasAlpha, outputHasAlpha, preserveAlpha)   — required
     *     opts.wasmKernel(...)    — optional WASM scalar variant
     *     opts.simdKernel(...)    — optional WASM SIMD variant
     *     opts.isSupported(variant) — optional gate; variant is 'kernel'|'wasmKernel'|'simdKernel'.
     *                                Defaults to () => true.  Picks best available:
     *                                simdKernel > wasmKernel > kernel.
     *
     *   Builder (LUT construction — called instead of createLut() when provided):
     *     opts.builder(transform) => lut   — optional; null/absent → standard createLut()
     *                                        is used (with any hooks initialise installed).
     *
     *   Lifecycle hooks:
     *     opts.options(transform, rawOpts)
     *       Called in the Transform constructor after the lutMode is accepted. Read
     *       plugin-specific constructor options, validate, and attach sanitized values
     *       to the transform (e.g. transform.totalInk = 260). Throw for bad input.
     *
     *     opts.initialise(transform)
     *       Called in create() after the pipeline is built, before CLUT sampling.
     *       Use to install addLutInputHook / addLutOutputHook, or any per-create()
     *       setup that needs the profile chain.
     *
     *   JSON round-trip:
     *     opts.serializer(coreJson, lut) => json
     *       Called inside toJSON() after the core serializes CLUT/channels/chain.
     *       Add portable plugin fields and a lutMode marker:
     *         json.lutMode = 'johnCustom'; json.gridDensity = lut.gridDensity; return json;
     *
     *     opts.deserializer(lut) => lut
     *       Called inside setLut()/fromJSON() after CLUT is decoded from base64.
     *       Reconstruct plugin-private runtime data from portable fields:
     *         lut.offsetTables = buildTables(lut.gridDensity); return lut;
     */
    Transform.register = function(descriptor){
        if(!descriptor || typeof descriptor !== 'object')             throw new Error('Transform.register: descriptor must be an object');
        if(!descriptor.name    || typeof descriptor.name    !== 'string') throw new Error('Transform.register: descriptor.name must be a non-empty string');
        if(!descriptor.lutMode || typeof descriptor.lutMode !== 'string') throw new Error('Transform.register: descriptor.lutMode must be a non-empty string');
        if(typeof descriptor.kernel !== 'function')                   throw new Error('Transform.register: descriptor.kernel (run closure) is required');
        if(descriptor.wasmKernel   != null && typeof descriptor.wasmKernel   !== 'function') throw new Error('Transform.register: descriptor.wasmKernel must be a function');
        if(descriptor.simdKernel   != null && typeof descriptor.simdKernel   !== 'function') throw new Error('Transform.register: descriptor.simdKernel must be a function');
        if(descriptor.isSupported  != null && typeof descriptor.isSupported  !== 'function') throw new Error('Transform.register: descriptor.isSupported must be a function');
        if(descriptor.builder      != null && typeof descriptor.builder      !== 'function') throw new Error('Transform.register: descriptor.builder must be a function');
        if(descriptor.initialise   != null && typeof descriptor.initialise   !== 'function') throw new Error('Transform.register: descriptor.initialise must be a function');
        if(descriptor.serializer   != null && typeof descriptor.serializer   !== 'function') throw new Error('Transform.register: descriptor.serializer must be a function');
        if(descriptor.deserializer != null && typeof descriptor.deserializer !== 'function') throw new Error('Transform.register: descriptor.deserializer must be a function');
        if(descriptor.meta != null && typeof descriptor.meta !== 'object' && typeof descriptor.meta !== 'function') throw new Error('Transform.register: descriptor.meta must be a plain object or function');
        if(Transform._plugins[descriptor.lutMode]){
            // Already registered — return false, do nothing. The plugin is immutable
            // once installed; create a new Transform if you need a different plugin.
            return false;
        }
        Transform._plugins[descriptor.lutMode] = {
            name:         descriptor.name,
            lutMode:      descriptor.lutMode,
            kernel:       descriptor.kernel,
            wasmKernel:   descriptor.wasmKernel   || null,
            simdKernel:   descriptor.simdKernel   || null,
            isSupported:  descriptor.isSupported  || null,
            builder:      descriptor.builder      || null,
            initialise:   descriptor.initialise   || null,
            serializer:   descriptor.serializer   || null,
            deserializer: descriptor.deserializer || null,
            meta:         descriptor.meta         || null,
        };
        return true;
    };

    /**
     * Return the list of registered plugins.
     *
     * Each entry contains:
     *   name    — descriptor.name from register()
     *   lutMode — the dispatcher key users set on the Transform constructor
     *   meta    — the raw opts.meta value: a plain object, a function, or null
     *
     * If meta is a function, call it with a Transform instance as `this` to get
     * dynamic values (e.g. transform.registeredMeta() does this automatically).
     *
     * @returns {Array<{name: string, lutMode: string, meta: object|Function|null}>}
     */
    Transform.registered = function(){
        return Object.keys(Transform._plugins).map(function(lutMode){
            var p = Transform._plugins[lutMode];
            return { name: p.name, lutMode: p.lutMode, meta: p.meta };
        });
    };

    // ---------------------------------------------------------------------------
    // Behaviour API — t.use()
    // ---------------------------------------------------------------------------
    //
    // Behaviours are per-instance modifiers — they don't add a new lutMode, they
    // just attach to one specific Transform. Typical use: add hooks, set flags.
    //
    // Two forms:
    //   t.use(descriptor)              — descriptor is an object with attach()
    //   t.use('name', opts?)           — looks up a named behaviour from the registry
    //
    // Behaviours can be registered by name so they can be referenced by string:
    //   Transform.behaviour({ name: 'ink-limit', attach: fn })
    //   t.use('ink-limit', { totalInk: 260 })

    Transform._behaviours = Object.create(null);  // name → behaviour descriptor

    /**
     * Register a named behaviour for use with t.use('name', opts).
     * @param {object} descriptor  { name (required), attach (required), initialise? }
     * @returns {boolean} true on success, false if name already registered.
     */
    Transform.behaviour = function(descriptor){
        if(!descriptor || typeof descriptor !== 'object') throw new Error('Transform.behaviour: descriptor must be an object');
        if(!descriptor.name || typeof descriptor.name !== 'string') throw new Error('Transform.behaviour: descriptor.name must be a non-empty string');
        if(typeof descriptor.apply !== 'function') throw new Error('Transform.behaviour: descriptor.apply must be a function');
        if(Transform._behaviours[descriptor.name]) return false;
        Transform._behaviours[descriptor.name] = descriptor;
        return true;
    };


// ---------------------------------------------------------------------------
// Portable JSON LUT format — static helpers
// ---------------------------------------------------------------------------
//
// `lutToJSON` and `jsonToLut` are the format authority. Both `Transform.toJSON`
// and `LutBuilder.toJSON` call `Transform.lutToJSON` so the wire format has a
// single source of truth; `Transform.setLut` calls the same decode helper as
// `Transform.jsonToLut`. Two APIs, one format.

/**
 * Encode an f64 LUT object (with CLUT in [0..1]) to portable JSON shape.
 *
 * @param {object} lutObj   LUT with CLUT (Float64Array, Uint16Array, or Uint8Array)
 * @param {object} [opts]   { dataType: 'u16'|'u8', generator?: string }
 * @returns {object} JSON-compatible plain object (caller may JSON.stringify)
 */
Transform.lutToJSON = function(lutObj, opts){
    return _lutToJSONShape(lutObj, opts);
};

/**
 * Decode a portable JSON LUT shape to an f64 LUT object.
 *
 * Accepts a JSON string or already-parsed object. Returns a clean LUT object
 * with `CLUT` as Float64Array in [0..1] — directly consumable by `setLut()` or
 * by tools that want the decoded numerical data.
 *
 * @param {string|object} input  JSON string or parsed object
 * @returns {object} LUT object with f64 CLUT
 */
Transform.jsonToLut = function(input){
    if(input == null) throw 'Transform.jsonToLut: input is required';
    var json = (typeof input === 'string') ? JSON.parse(input) : input;
    if(!json.CLUT) throw 'Transform.jsonToLut: input has no CLUT';
    var lut = Object.assign({}, json);
    _decodeLutCLUT(lut);
    return lut;
};

/**
 * Build a ready-to-use Transform from a portable JSON LUT.
 *
 * Equivalent to `new Transform(opts).setLut(JSON.parse(json))` but returns the
 * Transform directly. This is the consumer-side counterpart to `toJSON()`:
 *
 *     // Producer (build-time, with ICC profiles):
 *     const t = new Transform({ dataFormat: 'int8', buildLut: true });
 *     t.create(srgbProfile, cmykProfile, eIntent.perceptual);
 *     fs.writeFileSync('lut.json', JSON.stringify(t));
 *
 *     // Consumer (runtime, no profiles needed):
 *     const t = Transform.fromJSON(fs.readFileSync('lut.json'),
 *                                  { dataFormat: 'int8' });
 *     const out = t.transformArray(pixels);
 *
 * @param {string|object} input  JSON string or parsed object
 * @param {object} [opts]        Transform constructor options (dataFormat, lutMode, ...)
 * @returns {Transform} ready-to-use Transform with the LUT loaded
 */
Transform.fromJSON = function(input, opts){
    if(input == null) throw 'Transform.fromJSON: input is required';
    var json = (typeof input === 'string') ? JSON.parse(input) : input;
    // setLut mutates lut.CLUT in place (decodes base64) and normalises chain.
    // Defensive shallow-clone here so the caller's object survives unchanged
    // and a JSON object can be reused across multiple fromJSON() calls.
    var lut = Object.assign({}, json);
    // Auto-detect plugin mode from json.lutMode written by the serializer.
    // Only applies when: the JSON carries a lutMode, that mode has a registered
    // builder, AND the caller did not explicitly pass a lutMode override.
    var resolvedOpts = opts || {};
    if(!resolvedOpts.lutMode && json.lutMode && Transform._plugins[json.lutMode]){
        resolvedOpts = Object.assign({}, resolvedOpts, { lutMode: json.lutMode });
    }
    var t = new Transform(resolvedOpts);
    t.setLut(lut, resolvedOpts);   // forward verify option if present
    return t;
};

/**
 * Compute the LUT signature ("FNV1A:<hex>") over the canonical content:
 * input/output channel counts, grid points, chain (name|type|version per
 * entry), and the u16 full-scale CLUT bytes. Stable across f64/u16/u8 CLUT
 * forms — the function normalises to u16 internally before hashing.
 *
 * Not cryptographic — for mutation detection and provenance only.
 *
 * @param {object} lut LUT object (any CLUT type)
 * @returns {string} signature, e.g. "FNV1A:1f4e8a3c2b9d7e60"
 */
Transform.signLut = function(lut){
    return _computeSignature(lut);
};

/**
 * Verify a LUT against its stamped `originalSignature`.
 *
 * @param {string|object} lutOrJson  LUT object, JSON object, or JSON string
 * @returns {boolean|null} true if signature matches data, false if mismatch,
 *                         null if no `originalSignature` present (nothing to verify)
 */
Transform.verifyLut = function(lutOrJson){
    if(lutOrJson == null) return null;
    var input = (typeof lutOrJson === 'string') ? JSON.parse(lutOrJson) : lutOrJson;
    if(!input.originalSignature) return null;

    // If the input is still in JSON form (base64), decode to f64 first.
    var lut = (input.encoding === 'base64')
        ? Transform.jsonToLut(Object.assign({}, input))
        : input;

    return _computeSignature(lut) === input.originalSignature;
};


// ─── Tuned array-loop kernels ───────────────────────────────────────────────
// The unrolled LUT array loops were moved verbatim into src/kernels/
// (v1.7 phase B) to shrink this file. They are re-attached here as
// non-enumerable Transform.prototype methods — identical semantics and
// performance to the original class methods; every call site
// (lutKernelTable run closures, kernel modules, tests) is unchanged.
function _attachPrototypeLoops(loops){
    Object.keys(loops).forEach(function(name){
        Object.defineProperty(Transform.prototype, name, {
            value: loops[name],
            writable: true,
            configurable: true,
            enumerable: false,
        });
    });
}

_attachPrototypeLoops(require('./kernels/1d/kernel1D_loops.js'));
_attachPrototypeLoops(require('./kernels/2d/kernel2D_loops.js'));
_attachPrototypeLoops(require('./kernels/3d/kernel3D_loops.js'));
_attachPrototypeLoops(require('./kernels/4d/kernel4D_loops.js'));

// ─── Stage functions + single-colour interpolators ──────────────────────────
// Moved verbatim into src/stages.js (stage_* + their compile emitters and
// colour/matrix helpers) and src/interp.js (the ACCURACY PATH single-colour
// interpolators) — v1.5.5 split, so this file is the pipeline builder + API.
// Same non-enumerable prototype attachment as the kernel loops above:
// `this` semantics, call sites and performance are unchanged.
_attachPrototypeLoops(require('./stages.js'));
_attachPrototypeLoops(require('./interp.js'));

// ─── Pixel cache ────────────────────────────────────────────────────────────
// Accuracy-path memoisation stages + their injection/stats helpers. Attached
// the same way; inert unless the `pixelCache` option is set. See
// docs/deepdive/PixelCache.md.
_attachPrototypeLoops(require('./cache.js'));

// ─── WASM state forwarding (v1.6 phase 4c) ──────────────────────────────────
//
// The eight wasmTetra* slots moved onto the kernel instance, because the kernel
// is what loads, dispatches to and releases them. These accessors keep
// `transform.wasmTetra3D` reading and writing as it always did.
//
// They are a COMPATIBILITY SURFACE, not the design. The public WASM API
// (wasmMemoryBytes, compactWasmMemory, releaseWasmMemory) reads through them,
// and the WASM test suites assert on them in ~210 places — keeping those tests
// working unchanged is what makes them a real check on this move rather than a
// check on a rewrite of themselves.
//
// Null-safe in both directions: before create() there is no kernel, so a read
// gives null and a write is dropped. Nothing writes these before setKernel().
[
    'wasmTetra3D', 'wasmTetra3DSimd', 'wasmTetra3DInt16', 'wasmTetra3DInt16Simd',
    'wasmTetra4D', 'wasmTetra4DSimd', 'wasmTetra4DInt16', 'wasmTetra4DInt16Simd'
].forEach(function(slot){
    Object.defineProperty(Transform.prototype, slot, {
        configurable: true,
        enumerable: false,
        get: function(){ return this.kernel ? this.kernel[slot] : null; },
        set: function(v){ if(this.kernel) this.kernel[slot] = v; }
    });
});

// ─── Built-in kernel modules ────────────────────────────────────────────────
// Registered here (not main.js) so Transforms created via a direct
// require('./Transform.js') get them too. Registration is cheap — the
// descriptors are plain objects; a per-Transform instance is only created at
// create() time via setKernel(). Overridable: a later registerKernel() call
// for the same dimensions replaces those slots for all future create() calls.
// KernelND registers the whole 5..15 span in one call via its [from, to].
// See docs/deepdive/KernelModules.md.
Transform.registerKernel(require('./kernels/identity/KernelIdentity.js'));
Transform.registerKernel(require('./kernels/1d/Kernel1D.js'));
Transform.registerKernel(require('./kernels/2d/Kernel2D.js'));
Transform.registerKernel(require('./kernels/3d/Kernel3D.js'));
Transform.registerKernel(require('./kernels/4d/Kernel4D.js'));
Transform.registerKernel(require('./kernels/nd/KernelND.js'));

// The matrix shaper is NOT registered here any more. It is Kernel3D's other
// array implementation, lives in src/kernels/3d/matrixShaper/, and is chosen by
// Kernel3D.init() looking at its own pipeline. Transform knows nothing about
// it — which is the point. See docs/deepdive/KernelContract.md.

module.exports = Transform;
